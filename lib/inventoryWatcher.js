import { promises as fs } from 'node:fs';
import path from 'node:path';
import dbConnect from './dbConnect.js';
import { ConsecutiveGroup } from '../models/seatModel.js';
import { Event } from '../models/eventModel.js';

const WEBHOOK = process.env.DISCORD_WEBHOOK_URL;
const UNDERCUT_PCT = Number(process.env.UNDERCUT_PCT ?? 0.30);
const FULL_SCAN_EVERY_MS = Number(process.env.INVENTORY_FULL_SCAN_EVERY_MIN ?? 360) * 60_000;
const SNAPSHOT_PATH = path.join(process.cwd(), '.inventory-snapshot.json');
const MAX_RECENT_ALERTS = 50;

const GLOBAL_KEY = '__inventoryWatcherState_v2__';

const PENDING_CAP = 200;

function getState() {
  if (!globalThis[GLOBAL_KEY]) {
    globalThis[GLOBAL_KEY] = {
      snapshot: new Map(),
      sectionMin: new Map(),
      baselineDone: false,
      lastQueryAt: null,
      lastFullScanAt: null,
      lastRunAt: null,
      lastRunStats: null,
      runCount: 0,
      recentAlerts: [],
      totalAlerts: { newStandard: 0, priceDrops: 0, undercuts: 0 },
      pending: { drops: [], undercuts: [], newStd: [] },
      indexEnsured: false,
      eventCache: new Map(),     // eventId -> { url, name, venue, dateMs }
      sentDedupe: new Map(),     // alertHash -> timestamp; suppresses same-content re-sends
      dropAnchors: new Map(),    // rowKey -> { price, alertedAt }; "last alerted price" anchor
      eventAlertCounts: new Map(), // eventId -> [timestamp, ...]; rolling-window cooldown tally
      cooldownSuppressed: 0,     // lifetime alerts suppressed by per-event cooldown
    };
  }
  return globalThis[GLOBAL_KEY];
}

const DEDUPE_TTL_MS = 5 * 60 * 1000; // 5 min: same row+price+type silenced this long
// Drop anchors anchor the comparison baseline to the LAST ALERTED price for each row.
// While the anchor is fresh (≤30 min), small further drops are silenced; only a real
// move (≥ MIN_DROP_PCT from the anchor) re-fires. After expiry, snapshot price wins again.
const DROP_ANCHOR_TTL_MS = 30 * 60 * 1000;

function alertHash(item, type) {
  const id = `${type}|${item._evt.event_name}|${item.section}|${item.row}|${item.price ?? ''}|${item.oldPrice ?? ''}|${item.newPrice ?? ''}`;
  return id;
}

function isDuplicate(state, item, type) {
  const h = alertHash(item, type);
  const now = Date.now();
  const last = state.sentDedupe.get(h);
  if (last && now - last < DEDUPE_TTL_MS) return true;
  state.sentDedupe.set(h, now);
  // Light cleanup so the map doesn't grow forever.
  if (state.sentDedupe.size > 5000) {
    for (const [k, t] of state.sentDedupe) {
      if (now - t > DEDUPE_TTL_MS) state.sentDedupe.delete(k);
    }
  }
  return false;
}

async function ensureEventMeta(state, eventIds) {
  const missing = [];
  for (const id of eventIds) {
    if (!state.eventCache.has(id)) missing.push(id);
  }
  if (!missing.length) return;
  try {
    const events = await Event.find(
      { Event_ID: { $in: missing } },
      { Event_ID: 1, URL: 1, Event_Name: 1, Venue: 1, Event_DateTime: 1, priceIncreasePercentage: 1 },
    ).lean();
    for (const e of events) {
      state.eventCache.set(e.Event_ID, {
        url: e.URL || '',
        name: e.Event_Name || '',
        venue: e.Venue || '',
        dateMs: e.Event_DateTime ? new Date(e.Event_DateTime).getTime() : null,
        markupPct: typeof e.priceIncreasePercentage === 'number' ? e.priceIncreasePercentage : 25,
      });
    }
    // Mark unfound IDs as empty so we don't re-query them every cycle.
    for (const id of missing) {
      if (!state.eventCache.has(id)) state.eventCache.set(id, { url: '', name: '', venue: '', dateMs: null, markupPct: 25 });
    }
  } catch (e) {
    console.error('[inventoryWatcher] event lookup failed:', e.message);
  }
}

// Strip the play-scraper's default markup so displayed prices match TM's listed prices.
function rawPrice(item, price) {
  const meta = item.eventId ? getState().eventCache.get(item.eventId) : null;
  const pct = meta?.markupPct ?? 25;
  if (!pct) return price;
  return price / (1 + pct / 100);
}

const QUERY_MAX_MS = Number(process.env.INVENTORY_QUERY_MAX_MS ?? 600_000);
const MIN_DROP_PCT = Number(process.env.MIN_DROP_PCT ?? 0.10);
const MIN_DROP_ABS = Number(process.env.MIN_DROP_ABS ?? 25);

async function loadSnapshotFromDisk(state) {
  if (state.diskLoadAttempted) return;
  state.diskLoadAttempted = true;
  try {
    const raw = await fs.readFile(SNAPSHOT_PATH, 'utf8');
    const data = JSON.parse(raw);
    if (!Array.isArray(data?.entries)) return;

    // Migrate to current key format: `evt|NORM(sec)|NORM(row)` (drop legacy seatRange).
    // String-normalize section and row so future key generation stays consistent.
    // When multiple legacy keys collapse to the same new key, keep the lowest price.
    let migrated = 0;
    for (const [k, v] of data.entries) {
      const parts = k.split('|');
      const evt = parts[0];
      const sec = norm(parts[1]);
      const row = norm(parts[2]);
      const newKey = `${evt}|${sec}|${row}`;
      if (newKey !== k) migrated += 1;
      const normalizedV = { ...v, section: sec };
      const existing = state.snapshot.get(newKey);
      if (!existing || v.price < existing.price) {
        state.snapshot.set(newKey, normalizedV);
      }
    }
    state.baselineDone = true;
    state.lastQueryAt = data.lastQueryAt ? new Date(data.lastQueryAt) : new Date();
    state.lastFullScanAt = data.lastFullScanAt ? new Date(data.lastFullScanAt) : new Date();
    // Rebuild sectionMin from snapshot.
    for (const v of state.snapshot.values()) {
      const k = secKey(v.eventId, v.section);
      const cur = state.sectionMin.get(k) ?? Infinity;
      if (v.price < cur) state.sectionMin.set(k, v.price);
    }
    // Restore restart-survivable in-memory state.
    if (data.pending && Array.isArray(data.pending.drops)) {
      state.pending.drops = data.pending.drops;
      state.pending.undercuts = data.pending.undercuts || [];
      state.pending.newStd = data.pending.newStd || [];
    }
    if (Array.isArray(data.sentDedupe)) {
      const cutoff = Date.now() - DEDUPE_TTL_MS;
      for (const [k, t] of data.sentDedupe) {
        if (t > cutoff) state.sentDedupe.set(k, t);
      }
    }
    if (Array.isArray(data.dropAnchors)) {
      const cutoff = Date.now() - DROP_ANCHOR_TTL_MS;
      for (const [k, v] of data.dropAnchors) {
        if (v && typeof v.alertedAt === 'number' && v.alertedAt > cutoff) {
          state.dropAnchors.set(k, v);
        }
      }
    }
    if (Array.isArray(data.eventAlertCounts)) {
      const cutoff = Date.now() - COOLDOWN_WINDOW_MS;
      for (const [k, arr] of data.eventAlertCounts) {
        if (!Array.isArray(arr)) continue;
        const fresh = arr.filter(t => typeof t === 'number' && t > cutoff);
        if (fresh.length) state.eventAlertCounts.set(k, fresh);
      }
    }
    if (typeof data.cooldownSuppressed === 'number') {
      state.cooldownSuppressed = data.cooldownSuppressed;
    }
    if (data.totalAlerts && typeof data.totalAlerts === 'object') {
      state.totalAlerts = {
        newStandard: data.totalAlerts.newStandard | 0,
        priceDrops:  data.totalAlerts.priceDrops | 0,
        undercuts:   data.totalAlerts.undercuts | 0,
      };
    }
    if (Array.isArray(data.recentAlerts)) {
      state.recentAlerts = data.recentAlerts.slice(0, MAX_RECENT_ALERTS);
    }
    const pendingCount = state.pending.drops.length + state.pending.undercuts.length + state.pending.newStd.length;
    console.log(`[inventoryWatcher] loaded snapshot: ${state.snapshot.size} rows · pending=${pendingCount} · dedupe=${state.sentDedupe.size}${migrated ? ` · ${migrated} migrated from legacy keys` : ''}`);
  } catch (e) {
    if (e.code !== 'ENOENT') console.error('[inventoryWatcher] snapshot load failed:', e.message);
  }
}

async function persistSnapshotToDisk(state) {
  try {
    const tmp = SNAPSHOT_PATH + '.tmp';
    const payload = {
      savedAt: new Date().toISOString(),
      lastQueryAt: state.lastQueryAt,
      lastFullScanAt: state.lastFullScanAt,
      entries: Array.from(state.snapshot.entries()),
      // Restart-survival: alerts queued but not sent, dedupe window, dashboard counters,
      // and the recent feed all live in memory and would otherwise reset every deploy.
      pending: state.pending,
      sentDedupe: Array.from(state.sentDedupe.entries()),
      dropAnchors: Array.from(state.dropAnchors.entries()),
      eventAlertCounts: Array.from(state.eventAlertCounts.entries()),
      cooldownSuppressed: state.cooldownSuppressed || 0,
      totalAlerts: state.totalAlerts,
      recentAlerts: state.recentAlerts,
    };
    await fs.writeFile(tmp, JSON.stringify(payload), 'utf8');
    await fs.rename(tmp, SNAPSHOT_PATH);
    console.log(`[inventoryWatcher] persisted snapshot: ${state.snapshot.size} rows · pending=${state.pending.drops.length + state.pending.undercuts.length + state.pending.newStd.length} · dedupe=${state.sentDedupe.size}`);
  } catch (e) {
    console.error('[inventoryWatcher] snapshot persist failed:', e.message);
  }
}

async function ensureIndex(state) {
  if (state.indexEnsured) return;
  try {
    await ConsecutiveGroup.collection.createIndex({ event_date: 1, updatedAt: 1 }, { background: true });
    state.indexEnsured = true;
    console.log('[inventoryWatcher] index ensured: { event_date: 1, updatedAt: 1 }');
  } catch (e) {
    console.error('[inventoryWatcher] index create failed:', e.message);
  }
}

const fmt$ = n => `$${Number(n).toFixed(2)}`;
const pctChange = (from, to) => `${Math.round(((to - from) / from) * 100)}%`;
const classifyTag = splitType => splitType === 'NEVERLEAVEONE' ? 'standard' : 'resale';
const norm = v => String(v ?? '').trim().toUpperCase();
const rowKey = r => `${r.eventId}|${norm(r.section)}|${norm(r.row)}`;
const seatLabel = s => `SEC ${s.section} Row ${s.row} · Seats ${s.seats.join(',')} · ${s.seats.length} seats`;
const secKey = (eventId, section) => `${eventId}|${norm(section)}`;

function eventLine(evt) {
  const date = evt.event_date
    ? new Date(evt.event_date).toLocaleDateString('en-US', {
        weekday: 'short', month: 'short', day: 'numeric', year: 'numeric',
      })
    : '';
  return [evt.event_name, evt.venue_name, date].filter(Boolean).join(' · ');
}

function pushAlert(state, type, evt, line) {
  state.recentAlerts.unshift({ at: new Date().toISOString(), type, event: eventLine(evt), line });
  if (state.recentAlerts.length > MAX_RECENT_ALERTS) state.recentAlerts.length = MAX_RECENT_ALERTS;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function postEmbed(embed, attempt = 0) {
  if (!WEBHOOK) return;
  try {
    const res = await fetch(WEBHOOK, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ embeds: [embed] }),
    });
    if (res.status === 429 && attempt < 3) {
      const body = await res.json().catch(() => ({}));
      const retryMs = Math.ceil((body.retry_after ?? 1) * 1000) + 250;
      console.log(`[inventoryWatcher] discord 429 — backing off ${retryMs}ms`);
      await sleep(retryMs);
      return postEmbed(embed, attempt + 1);
    }
    if (!res.ok) console.error('[inventoryWatcher] discord status', res.status);
  } catch (e) {
    console.error('[inventoryWatcher] webhook failed:', e.message);
  }
}

const MIN_SEND_GAP_MS = Number(process.env.DISCORD_SEND_GAP_MS ?? 6_000);    // 10 msgs/min default
const MAX_LINES_PER_MESSAGE = Number(process.env.DISCORD_LINES_PER_MSG ?? 25); // Discord cap is 25 fields
const COOLDOWN_WINDOW_MS = Number(process.env.EVENT_COOLDOWN_WINDOW_MIN ?? 10) * 60_000;
const COOLDOWN_THRESHOLD = Number(process.env.EVENT_COOLDOWN_THRESHOLD ?? 30); // alerts/event/window

let lastSendAt = 0;

// Helpers that build a richer alert line: section, row, seats, price change, event, date, URL.
const MONTH_ABBR = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

// Extract date parts straight from the stored UTC value — no locale, no machine TZ.
// What you see is exactly what's in MongoDB.
function compactDate(value) {
  if (!value) return '';
  const d = new Date(value);
  if (isNaN(d.getTime())) return '';
  return `${MONTH_ABBR[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
}

// Collapse consecutive seat numbers like [1,2,3,4,7,8] → "1–4, 7–8".
function seatRangeLabel(item) {
  const seats = (item.seats || []).map(s => Number(s)).filter(n => Number.isFinite(n));
  if (!seats.length) return (item.seats || []).join(',');
  const sorted = [...seats].sort((a, b) => a - b);
  const groups = [];
  let start = sorted[0], prev = sorted[0];
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i] === prev + 1) { prev = sorted[i]; continue; }
    groups.push(start === prev ? `${start}` : `${start}–${prev}`);
    start = prev = sorted[i];
  }
  groups.push(start === prev ? `${start}` : `${start}–${prev}`);
  return groups.join(', ');
}

function seatsTag(item) {
  const n = (item.seats || []).length;
  if (!n) return '';
  return `Seats **${seatRangeLabel(item)}** *(${n})*`;
}


function eventName(item) {
  const s = getState();
  const meta = item.eventId ? s.eventCache.get(item.eventId) : null;
  return item._evt?.event_name || meta?.name || 'unknown event';
}

function eventLinkSuffix(item) {
  const s = getState();
  const meta = item.eventId ? s.eventCache.get(item.eventId) : null;
  const date = compactDate(meta?.dateMs ?? item._evt?.event_date);
  const datePart = date ? ` · 📅 ${date}` : '';
  const link = meta?.url ? ` · [View on TM](<${meta.url}>)` : '';
  return `${datePart}${link}`;
}

// Each alert is a Discord embed field — name = bold header, value = structured detail.
function dropField(s) {
  const tag = s.tag === 'standard' ? 'STD' : 'RSL';
  const pct = pctChange(s.oldPrice, s.newPrice);
  return {
    name: `🔴  ${pct} drop  ·  ${tag}  ·  ${eventName(s)}`,
    value: `Section **${s.section}** · Row **${s.row}** · ${seatsTag(s)}\n` +
           `~~${fmt$(rawPrice(s, s.oldPrice))}~~ → **${fmt$(rawPrice(s, s.newPrice))}**${eventLinkSuffix(s)}`,
    inline: false,
  };
}

function newStdField(s) {
  return {
    name: `🟢  NEW STANDARD  ·  ${eventName(s)}`,
    value: `Section **${s.section}** · Row **${s.row}** · ${seatsTag(s)}\n` +
           `**${fmt$(rawPrice(s, s.price))}**${eventLinkSuffix(s)}`,
    inline: false,
  };
}

function undercutField(s) {
  const pct = pctChange(s.sectionLow, s.price);
  return {
    name: `🟡  ${pct} undercut  ·  RSL  ·  ${eventName(s)}`,
    value: `Section **${s.section}** · Row **${s.row}** · ${seatsTag(s)}\n` +
           `**${fmt$(rawPrice(s, s.price))}** *(section low ${fmt$(rawPrice(s, s.sectionLow))})*${eventLinkSuffix(s)}`,
    inline: false,
  };
}

// Pop the top-N items from `arr` by priority score (highest first), removing them
// from the original array. The remaining items keep their relative order so they
// ride a future message.
function takeTopByScore(arr, n) {
  if (n <= 0 || arr.length === 0) return [];
  if (arr.length <= n) return arr.splice(0, arr.length);
  // Annotate with original index so we can splice precisely.
  const indexed = arr.map((item, idx) => ({ item, idx, score: item._score || 0 }));
  indexed.sort((a, b) => b.score - a.score);
  const taken = indexed.slice(0, n);
  // Remove from original array — sort indices DESC so each splice doesn't shift the rest.
  const indicesDesc = taken.map(t => t.idx).sort((a, b) => b - a);
  for (const i of indicesDesc) arr.splice(i, 1);
  return taken.map(t => t.item);
}

async function sendCombined() {
  const s = getState();
  const p = s.pending;
  const total = p.drops.length + p.undercuts.length + p.newStd.length;
  if (!total) return false;

  const now = Date.now();
  if (lastSendAt + MIN_SEND_GAP_MS - now > 0) return false; // rate-limited; queue stays

  // Proportional fair-share: each type gets a slice of MAX_LINES_PER_MESSAGE based on
  // what's pending. Drops aren't allowed to crowd out new-standard or undercut alerts.
  const slots = MAX_LINES_PER_MESSAGE;
  const dropProp = p.drops.length / total;
  const undProp  = p.undercuts.length / total;
  let dropTake = Math.min(p.drops.length, Math.max(p.drops.length ? 1 : 0, Math.round(slots * dropProp)));
  let undTake  = Math.min(p.undercuts.length, Math.max(p.undercuts.length ? 1 : 0, Math.round(slots * undProp)));
  let stdTake  = Math.min(p.newStd.length, slots - dropTake - undTake);
  // Reclaim leftover slots if any bucket can't fill its share.
  let leftover = slots - dropTake - undTake - stdTake;
  while (leftover > 0) {
    let used = false;
    if (dropTake < p.drops.length)     { dropTake += 1; leftover -= 1; used = true; if (!leftover) break; }
    if (undTake < p.undercuts.length)  { undTake  += 1; leftover -= 1; used = true; if (!leftover) break; }
    if (stdTake < p.newStd.length)     { stdTake  += 1; leftover -= 1; used = true; if (!leftover) break; }
    if (!used) break;
  }
  const dropShown = takeTopByScore(p.drops, dropTake);
  const undShown  = takeTopByScore(p.undercuts, undTake);
  const stdShown  = takeTopByScore(p.newStd, stdTake);

  // Each alert is its own embed field so the user always sees section/row/seats.
  // Flood control happens at the queue level instead (priority scoring +
  // per-event cooldown + higher throughput) — not by collapsing display.
  const fields = [
    ...dropShown.map(dropField),
    ...undShown.map(undercutField),
    ...stdShown.map(newStdField),
  ];

  const totalShown = dropShown.length + undShown.length + stdShown.length;
  const summary = [
    dropShown.length ? `🔴 **${dropShown.length}** drops` : '',
    undShown.length  ? `🟡 **${undShown.length}** undercuts` : '',
    stdShown.length  ? `🟢 **${stdShown.length}** new standard` : '',
  ].filter(Boolean).join('  ·  ');

  // Color reflects the dominant trigger type so the embed sidebar communicates intent.
  const color = dropShown.length >= undShown.length && dropShown.length >= stdShown.length
    ? 0xe74c3c
    : undShown.length >= stdShown.length
      ? 0xf1c40f
      : 0x2ecc71;

  await postEmbed({
    color,
    title: `📊 Inventory Update — ${totalShown} alert${totalShown === 1 ? '' : 's'}`,
    description: summary,
    fields,
    footer: { text: 'TM Scraper · prices shown are TM listed (markup stripped)' },
    timestamp: new Date().toISOString(),
  });

  lastSendAt = Date.now();
  s.totalAlerts.priceDrops += dropShown.length;
  s.totalAlerts.undercuts  += undShown.length;
  s.totalAlerts.newStandard += stdShown.length;
  return true;
}

// Priority score for an alert. Higher = more important. Used to:
//   1. Sort pending DESC at send time so big movers ride the next message
//   2. Drop lowest-score (not oldest) when the queue cap is reached
function scoreAlert(item, type) {
  if (type === 'drops') {
    const pct = (item.oldPrice - item.newPrice) / item.oldPrice; // 0..1, positive
    const abs = item.oldPrice - item.newPrice;
    // Drop -50% / $300 → 500 + 200 = 700
    // Drop -10% / $5  → 100 + 5   = 105
    return pct * 1000 + Math.min(abs, 200);
  }
  if (type === 'undercuts') {
    const pct = (item.sectionLow - item.price) / item.sectionLow;
    return pct * 1500; // weight undercuts higher (rarer signal)
  }
  if (type === 'newStd') {
    // Cheaper new listings get a bonus on top of a fixed midweight.
    return 200 + Math.max(0, 200 - (item.price || 0));
  }
  return 0;
}

function pushPending(state, type, item) {
  const arr = state.pending[type];
  if (!arr) return;
  item._score = scoreAlert(item, type);
  arr.push(item);
  if (arr.length > PENDING_CAP) {
    // Drop the LOWEST-priority items, not the oldest. Big movers must stay.
    arr.sort((a, b) => (a._score || 0) - (b._score || 0));
    const dropped = arr.length - PENDING_CAP;
    arr.splice(0, dropped);
    state.droppedAlerts = (state.droppedAlerts || 0) + dropped;
    console.warn(`[inventoryWatcher] pending ${type} cap reached — dropped ${dropped} lowest-priority (lifetime dropped=${state.droppedAlerts})`);
  }
}

// Per-event rolling-window alert tally. When an event exceeds COOLDOWN_THRESHOLD
// alerts within COOLDOWN_WINDOW_MS, further alerts for that event are suppressed
// until the window slides forward. Prevents one busy event from drowning out
// signal from quieter events.
function isEventInCooldown(state, eventId) {
  if (!eventId) return false;
  const now = Date.now();
  const cutoff = now - COOLDOWN_WINDOW_MS;
  const arr = state.eventAlertCounts.get(eventId);
  if (!arr) return false;
  // Prune timestamps outside the window.
  let i = 0;
  while (i < arr.length && arr[i] < cutoff) i += 1;
  if (i > 0) arr.splice(0, i);
  if (!arr.length) {
    state.eventAlertCounts.delete(eventId);
    return false;
  }
  return arr.length >= COOLDOWN_THRESHOLD;
}

function recordEventAlert(state, eventId) {
  if (!eventId) return;
  const arr = state.eventAlertCounts.get(eventId) || [];
  arr.push(Date.now());
  state.eventAlertCounts.set(eventId, arr);
}

function countCooldownEvents(state) {
  const now = Date.now();
  const cutoff = now - COOLDOWN_WINDOW_MS;
  let count = 0;
  for (const [, arr] of state.eventAlertCounts) {
    let i = 0;
    while (i < arr.length && arr[i] < cutoff) i += 1;
    if (arr.length - i >= COOLDOWN_THRESHOLD) count += 1;
  }
  return count;
}

function rebuildSectionMinFor(state, dirtySectionKeys) {
  // Reset just the dirty sections, then re-derive from snapshot.
  for (const k of dirtySectionKeys) state.sectionMin.delete(k);
  for (const v of state.snapshot.values()) {
    const k = secKey(v.eventId, v.section);
    if (!dirtySectionKeys.has(k)) continue;
    const cur = state.sectionMin.get(k) ?? Infinity;
    if (v.price < cur) state.sectionMin.set(k, v.price);
  }
}

export async function runInventoryWatch() {
  const state = getState();
  if (state.inFlight) {
    console.log('[inventoryWatcher] run already in flight, skipping caller');
    return { skipped: true };
  }
  state.inFlight = true;
  state.runningStartedAt = Date.now();
  try {
    return await _runInventoryWatchLocked(state);
  } finally {
    state.inFlight = false;
    state.runningStartedAt = 0;
  }
}

async function _runInventoryWatchLocked(state) {
  const t0 = Date.now();
  await dbConnect();
  await ensureIndex(state);
  await loadSnapshotFromDisk(state);
  state.runCount += 1;

  const now = new Date();
  const isBaseline = !state.baselineDone;
  const dueFullScan = !state.lastFullScanAt || (now.getTime() - state.lastFullScanAt.getTime()) >= FULL_SCAN_EVERY_MS;
  const mode = isBaseline || dueFullScan ? 'full' : 'incremental';

  // Set query checkpoint BEFORE the query so changes mid-query aren't missed next cycle.
  const queryCheckpoint = now;
  const filter = { event_date: { $gte: now } };
  if (mode === 'incremental' && state.lastQueryAt) {
    filter.updatedAt = { $gt: state.lastQueryAt };
  }

  console.log(`[inventoryWatcher] run #${state.runCount} mode=${mode} since=${state.lastQueryAt?.toISOString() ?? 'never'}`);
  const fetchT0 = Date.now();

  const cursor = ConsecutiveGroup.find(filter, {
    eventId: 1, event_name: 1, venue_name: 1, event_date: 1,
    section: 1, row: 1, seatRange: 1, seats: 1,
    'inventory.listPrice': 1, 'inventory.splitType': 1,
    updatedAt: 1,
  })
    .maxTimeMS(QUERY_MAX_MS)
    .lean()
    .cursor({ batchSize: 500 });

  const dirtySections = new Set();
  const seenKeys = mode === 'full' ? new Set() : null;
  let processed = 0;
  let maxUpdatedAtMs = 0;
  let cycleData = null;
  const runCounts = { newStandard: 0, undercuts: 0, priceDrops: 0 };

  // BASELINE FAST PATH: no diff, no alerts, no buffering — just populate snapshot
  // with the cheapest price per (event, section, row).
  if (isBaseline) {
    for await (const r of cursor) {
      processed += 1;
      if (processed % 5000 === 0) {
        console.log(`[inventoryWatcher] streamed ${processed} rows (${Date.now() - fetchT0}ms)`);
      }
      const ua = r.updatedAt ? new Date(r.updatedAt).getTime() : 0;
      if (ua > maxUpdatedAtMs) maxUpdatedAtMs = ua;
      const price = r.inventory?.listPrice;
      if (price == null) continue;
      const key = rowKey(r);
      if (seenKeys) seenKeys.add(key);
      const tag = classifyTag(r.inventory?.splitType);
      const cur = state.snapshot.get(key);
      if (!cur || price < cur.price) {
        state.snapshot.set(key, { price, tag, section: norm(r.section), eventId: r.eventId });
        dirtySections.add(secKey(r.eventId, r.section));
      }
    }
  } else {
    // PASS 1 (diff path): collect the cheapest price per row this cycle.
    // The scraper deletes-and-reinserts on changes, so multiple docs share the same row;
    // we take the lowest as representative.
    cycleData = new Map();
    for await (const r of cursor) {
      processed += 1;
      if (processed % 5000 === 0) {
        console.log(`[inventoryWatcher] streamed ${processed} rows (${Date.now() - fetchT0}ms)`);
      }
      // Track the max updatedAt actually processed so the next incremental
      // filter (updatedAt > X) skips this row and nothing else.
      const ua = r.updatedAt ? new Date(r.updatedAt).getTime() : 0;
      if (ua > maxUpdatedAtMs) maxUpdatedAtMs = ua;
      const price = r.inventory?.listPrice;
      if (price == null) continue;
      const key = rowKey(r);
      if (seenKeys) seenKeys.add(key);
      const tag = classifyTag(r.inventory?.splitType);
      const cur = cycleData.get(key);
      if (!cur || price < cur.price) {
        cycleData.set(key, {
          key, price, tag,
          eventId: r.eventId, section: r.section, row: r.row,
          seats: (r.seats || []).map(s => s.number),
          evt: { event_name: r.event_name, venue_name: r.venue_name, event_date: r.event_date },
        });
      }
    }
  }

  // Pre-fetch event metadata (URL, date) for any new event IDs in this cycle.
  if (cycleData?.size) {
    const ids = new Set();
    for (const d of cycleData.values()) ids.add(d.eventId);
    await ensureEventMeta(state, ids);
  }

  // PASS 2 (diff path only): diff each row's representative price against the prior snapshot.
  for (const data of (cycleData?.values() ?? [])) {
    const prev = state.snapshot.get(data.key);

    if (!prev) {
      if (!isBaseline) {
        if (data.tag === 'standard') {
          const item = { _evt: data.evt, eventId: data.eventId, section: data.section, row: data.row, seats: data.seats, price: data.price };
          if (isEventInCooldown(state, data.eventId)) {
            state.cooldownSuppressed += 1;
          } else if (!isDuplicate(state, item, 'newStd')) {
            pushPending(state, 'newStd', item);
            pushAlert(state, 'newStandard', data.evt, `${seatLabel(item)} · ${fmt$(data.price)}`);
            recordEventAlert(state, data.eventId);
            runCounts.newStandard += 1;
          }
        } else {
          const secLow = state.sectionMin.get(secKey(data.eventId, data.section)) ?? Infinity;
          if (secLow !== Infinity && data.price < secLow && data.price <= secLow * (1 - UNDERCUT_PCT)) {
            const item = { _evt: data.evt, eventId: data.eventId, section: data.section, row: data.row, seats: data.seats, price: data.price, sectionLow: secLow };
            if (isEventInCooldown(state, data.eventId)) {
              state.cooldownSuppressed += 1;
            } else if (!isDuplicate(state, item, 'undercut')) {
              pushPending(state, 'undercuts', item);
              pushAlert(state, 'undercut', data.evt, `${seatLabel(item)} · ${fmt$(data.price)} vs section low ${fmt$(secLow)} (${pctChange(secLow, data.price)})`);
              recordEventAlert(state, data.eventId);
              runCounts.undercuts += 1;
            }
          }
        }
      }
    } else if (data.price < prev.price) {
      // Anchor the comparison baseline to the LAST ALERTED price (if recent).
      // Falls back to snapshot price when no anchor exists or it's expired.
      const anchor = state.dropAnchors.get(data.key);
      const anchorFresh = anchor && (Date.now() - anchor.alertedAt) < DROP_ANCHOR_TTL_MS;
      const baseline = anchorFresh ? anchor.price : prev.price;
      if (data.price < baseline) {
        const drop = baseline - data.price;
        const dropPct = drop / baseline;
        if (drop >= MIN_DROP_ABS && dropPct >= MIN_DROP_PCT) {
          const item = {
            _evt: data.evt, eventId: data.eventId, section: data.section, row: data.row, seats: data.seats, tag: data.tag,
            oldPrice: baseline, newPrice: data.price,
          };
          if (isEventInCooldown(state, data.eventId)) {
            state.cooldownSuppressed += 1;
          } else if (!isDuplicate(state, item, 'drop')) {
            pushPending(state, 'drops', item);
            const t = data.tag === 'standard' ? '🔵 STD' : '🟠 RSL';
            pushAlert(state, 'priceDrop', data.evt, `${t} ${seatLabel(item)} · ${fmt$(baseline)} → ${fmt$(data.price)} (${pctChange(baseline, data.price)})`);
            recordEventAlert(state, data.eventId);
            runCounts.priceDrops += 1;
            // Re-anchor to the price we just alerted on.
            state.dropAnchors.set(data.key, { price: data.price, alertedAt: Date.now() });
          }
        }
      }
    }

    state.snapshot.set(data.key, { price: data.price, tag: data.tag, section: norm(data.section), eventId: data.eventId });
    dirtySections.add(secKey(data.eventId, data.section));
  }

  let deletedCount = 0;
  if (mode === 'full') {
    // Drop snapshot entries that no longer exist in the DB.
    for (const [k, v] of state.snapshot) {
      if (!seenKeys.has(k)) {
        state.snapshot.delete(k);
        dirtySections.add(secKey(v.eventId, v.section));
        deletedCount += 1;
      }
    }
    // Stamp at completion (not start) so a long full scan doesn't immediately re-trigger another.
    state.lastFullScanAt = new Date();
  }

  const fetchMs = Date.now() - fetchT0;
  console.log(`[inventoryWatcher] processed ${processed} rows in ${fetchMs}ms (snapshot=${state.snapshot.size}, deleted=${deletedCount})`);

  if (dirtySections.size) rebuildSectionMinFor(state, dirtySections);

  // Drop expired anchors so the map doesn't grow forever.
  if (state.dropAnchors.size) {
    const cutoff = Date.now() - DROP_ANCHOR_TTL_MS;
    for (const [k, v] of state.dropAnchors) {
      if (!v || v.alertedAt < cutoff) state.dropAnchors.delete(k);
    }
  }

  // Use the latest updatedAt actually processed as the next incremental cursor.
  // Falls back to the start-of-run timestamp if nothing was processed (empty cycle).
  state.lastQueryAt = maxUpdatedAtMs > 0
    ? new Date(Math.max(maxUpdatedAtMs, queryCheckpoint.getTime()))
    : queryCheckpoint;
  state.baselineDone = true;
  state.lastRunAt = now;
  state.lastRunStats = {
    mode,
    rowsInSnapshot: state.snapshot.size,
    fetched: processed,
    deleted: deletedCount,
    dirtySections: dirtySections.size,
    newStandard: runCounts.newStandard,
    priceDrops: runCounts.priceDrops,
    undercuts: runCounts.undercuts,
    pending: state.pending.drops.length + state.pending.undercuts.length + state.pending.newStd.length,
    isBaseline,
    fetchMs,
    totalMs: Date.now() - t0,
  };
  if (!isBaseline) await sendCombined();

  if (mode === 'full') {
    persistSnapshotToDisk(state).catch(() => {});
  }

  return state.lastRunStats;
}

export function getWatcherState() {
  const s = getState();
  return {
    baselineDone: s.baselineDone,
    snapshotSize: s.snapshot.size,
    sectionsTracked: s.sectionMin.size,
    lastRunAt: s.lastRunAt,
    lastQueryAt: s.lastQueryAt,
    lastFullScanAt: s.lastFullScanAt,
    lastRunStats: s.lastRunStats,
    runCount: s.runCount,
    webhookConfigured: Boolean(WEBHOOK),
    undercutPct: UNDERCUT_PCT,
    fullScanEveryMs: FULL_SCAN_EVERY_MS,
    recentAlerts: s.recentAlerts,
    totalAlerts: s.totalAlerts,
    inFlight: Boolean(s.inFlight),
    runningStartedAt: s.runningStartedAt || 0,
    pendingCounts: {
      drops: s.pending.drops.length,
      undercuts: s.pending.undercuts.length,
      newStd: s.pending.newStd.length,
    },
    droppedAlerts: s.droppedAlerts || 0,
    minDropPct: MIN_DROP_PCT,
    minDropAbs: MIN_DROP_ABS,
    cooldownEvents: countCooldownEvents(s),
    cooldownSuppressed: s.cooldownSuppressed || 0,
    cooldownThreshold: COOLDOWN_THRESHOLD,
    cooldownWindowMs: COOLDOWN_WINDOW_MS,
    sendGapMs: MIN_SEND_GAP_MS,
    linesPerMessage: MAX_LINES_PER_MESSAGE,
  };
}

export async function persistNow() {
  const s = getState();
  if (s.snapshot.size === 0) {
    return { success: false, error: 'snapshot is empty — nothing to persist' };
  }
  await persistSnapshotToDisk(s);
  return { success: true, rows: s.snapshot.size };
}

export function resetWatcherBaseline() {
  const s = getState();
  s.snapshot.clear();
  s.sectionMin.clear();
  s.baselineDone = false;
  s.lastQueryAt = null;
  s.lastFullScanAt = null;
  s.lastRunStats = null;
  s.runCount = 0;
  s.diskLoadAttempted = false;
  s.recentAlerts = [];
  s.totalAlerts = { newStandard: 0, priceDrops: 0, undercuts: 0 };
  s.pending = { drops: [], undercuts: [], newStd: [] };
  s.sentDedupe = new Map();
  s.dropAnchors = new Map();
  s.eventAlertCounts = new Map();
  s.cooldownSuppressed = 0;
  fs.unlink(SNAPSHOT_PATH).catch(() => {});
}
