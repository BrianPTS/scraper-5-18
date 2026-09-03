/* eslint-disable @typescript-eslint/no-explicit-any */
'use server';

const MLB_TEAMS = [
  "Yankees", "Red Sox", "Blue Jays", "Orioles", "Rays",
  "Guardians", "Twins", "Tigers", "White Sox", "Royals",
  "Astros", "Mariners", "Rangers", "Angels", "Athletics",
  "Braves", "Phillies", "Mets", "Marlins", "Nationals",
  "Brewers", "Cubs", "Cardinals", "Pirates", "Reds",
  "Dodgers", "Padres", "Diamondbacks", "Giants", "Rockies",
];

const NFL_TEAMS = [
  "Bills", "Dolphins", "Patriots", "Jets",
  "Ravens", "Bengals", "Browns", "Steelers",
  "Texans", "Colts", "Jaguars", "Titans",
  "Broncos", "Chiefs", "Raiders", "Chargers",
  "Cowboys", "Giants", "Eagles", "Commanders",
  "Bears", "Lions", "Packers", "Vikings",
  "Falcons", "Panthers", "Saints", "Buccaneers",
  "Cardinals", "Rams", "49ers", "Seahawks",
];

// Pre-computed lowercase team names — avoids recreating + lowercasing on every CSV row
const ALL_TEAMS_LOWER = [...MLB_TEAMS, ...NFL_TEAMS].map(t => t.toLowerCase());

// Blocked state values for venue filtering (RI + ME)
const BLOCKED_STATES = ['ri', 'me', 'rhode island', 'maine'];
import dbConnect from '../lib/dbConnect';
import { ConsecutiveGroup } from '../models/seatModel';
import { Event } from '../models/eventModel';
import { SchedulerSettings } from '../models/schedulerModel';
import { AutoDeleteSettings } from '../models/autoDeleteModel';
import { ExclusionRules } from '../models/exclusionRulesModel';
import SyncService from '../lib/syncService';
import { createErrorLog } from './errorLogActions';
import { deleteExpiredEvents, getExpiredEventsStats, deletePassedEvents } from './autoDeleteActions';
import { deleteConsecutiveGroupsByEventIds } from './seatActions';
import { detectTimezoneFromVenueAsync, resolveVenueTimezonesBulk, getCurrentTimeInTimezone } from '../lib/timezone';
import { PipelineStage } from 'mongoose';

interface CsvRow {
  inventory_id: number;
  event_name: string;
  venue_name: string;
  event_date: string;
  event_id: string;
  quantity: number;
  section: string;
  row: string;
  seats: string;
  barcodes?: string;
  internal_notes?: string;
  public_notes?: string;
  tags?: string;
  list_price: number;
  face_price: number;
  taxed_cost: number;
  cost: number;
  hide_seats: 'Y' | 'N';
  in_hand: 'N';
  in_hand_date: string;
  instant_transfer?: 'Y' | 'N';
  files_available: 'Y' | 'N';
  split_type: 'CUSTOM' | 'DEFAULT' | 'NEVERLEAVEONE' | 'ANY';
  custom_split?: string;
  stock_type: 'ELECTRONIC' | 'HARD' | 'MOBILE_TRANSFER' | 'MOBILE_SCREENCAP' | 'PAPERLESS' | 'PAPERLESS_CARD' | 'FLASH';
  zone: 'Y' | 'N';
  shown_quantity?: number;
  passthrough?: string;
  // Internal-only, not emitted to Automatiq CSV. 0-based front-to-back
  // row index from TM's SECTION.segments; null when unknown or GA.
  // Used by the dominated-listings exclusion filter.
  rowRank?: number | null;
  // Internal-only. If provisionalUntil is in the future, this is a
  // standard drop still inside its 30-min hold and must NOT be emitted
  // to the CSV. Cleared naturally after the hold expires.
  provisionalUntil?: Date | string | null;
}

const csvColumns = [
  { id: 'inventory_id', title: 'inventory_id' },
  { id: 'event_name', title: 'event_name' },
  { id: 'venue_name', title: 'venue_name' },
  { id: 'event_date', title: 'event_date' },
  { id: 'event_id', title: 'event_id' },
  { id: 'quantity', title: 'quantity' },
  { id: 'section', title: 'section' },
  { id: 'row', title: 'row' },
  { id: 'seats', title: 'seats' },
  { id: 'barcodes', title: 'barcodes' },
  { id: 'internal_notes', title: 'internal_notes' },
  { id: 'public_notes', title: 'public_notes' },
  { id: 'tags', title: 'tags' },
  { id: 'list_price', title: 'list_price' },
  { id: 'face_price', title: 'face_price' },
  { id: 'taxed_cost', title: 'taxed_cost' },
  { id: 'cost', title: 'cost' },
  { id: 'hide_seats', title: 'hide_seats' },
  { id: 'in_hand', title: 'in_hand' },
  { id: 'in_hand_date', title: 'in_hand_date' },
  { id: 'instant_transfer', title: 'instant_transfer' },
  { id: 'files_available', title: 'files_available' },
  { id: 'split_type', title: 'split_type' },
  { id: 'custom_split', title: 'custom_split' },
  { id: 'stock_type', title: 'stock_type' },
  { id: 'zone', title: 'zone' },
  { id: 'shown_quantity', title: 'shown_quantity' },
  { id: 'passthrough', title: 'passthrough' },
];

// Retry configuration
interface RetryConfig {
  maxRetries: number;
  baseDelay: number;
  maxDelay: number;
}

const DEFAULT_RETRY_CONFIG: RetryConfig = {
  maxRetries: 3,
  baseDelay: 1000, // 1 second
  maxDelay: 10000  // 10 seconds
};

// Exponential backoff with jitter
function calculateDelay(attempt: number, config: RetryConfig): number {
  const exponentialDelay = Math.min(config.baseDelay * Math.pow(2, attempt), config.maxDelay);
  const jitter = Math.random() * 0.1 * exponentialDelay;
  return exponentialDelay + jitter;
}

// Get price adjustment percentage from environment variables
function getPriceAdjustmentPercentage(): number {
  const priceAdjustmentEnv = process.env.PRICE_INCREASE_PERCENTAGE;
  if (!priceAdjustmentEnv) {
    return 0; // Default: no price adjustment
  }
  const percentage = parseFloat(priceAdjustmentEnv);
  return isNaN(percentage) ? 0 : percentage;
}

// Build a per-record exclusion filter once for a CSV run. Both the streaming
// and non-streaming paths used to call this per chunk, which fired 2 DB
// queries per chunk (Event.find + ExclusionRules.find). Hoisting those reads
// to a single round each removes O(chunks) redundant queries.
type ExclusionFilter = (record: CsvRow) => boolean;
const ALLOW_ALL: ExclusionFilter = () => true;

interface SectionRowExclusion {
  section?: string;
  excludeEntireSection?: boolean;
  excludedRows?: string[];
}

async function buildExclusionFilter(mappingIds: string[]): Promise<ExclusionFilter> {
  if (mappingIds.length === 0) return ALLOW_ALL;

  try {
    const events = await Event.find(
      { mapping_id: { $in: mappingIds } },
      { _id: 1, mapping_id: 1 }
    ).lean();
    if (events.length === 0) return ALLOW_ALL;

    const objectIdToMappingId = new Map<string, string>();
    const eventIds: string[] = [];
    for (const e of events) {
      const oid = String(e._id);
      objectIdToMappingId.set(oid, e.mapping_id);
      eventIds.push(oid);
    }

    const rules = await ExclusionRules.find(
      { eventId: { $in: eventIds }, isActive: true }
    ).lean();
    if (rules.length === 0) return ALLOW_ALL;

    // Key by mapping_id so per-record lookup is one Map.get against the value
    // already stored in CsvRow.event_id.
    const rulesByMappingId = new Map<string, SectionRowExclusion[]>();
    for (const rule of rules) {
      const mid = objectIdToMappingId.get(String(rule.eventId));
      const sectionRules = (rule as { sectionRowExclusions?: SectionRowExclusion[] }).sectionRowExclusions;
      if (mid && sectionRules && sectionRules.length > 0) {
        rulesByMappingId.set(mid, sectionRules);
      }
    }
    if (rulesByMappingId.size === 0) return ALLOW_ALL;

    return (record) => {
      const sectionRules = rulesByMappingId.get(record.event_id);
      if (!sectionRules) return true;
      for (const exclusion of sectionRules) {
        if (exclusion.section !== record.section) continue;
        if (exclusion.excludeEntireSection) return false;
        if (exclusion.excludedRows && exclusion.excludedRows.includes(record.row)) return false;
      }
      return true;
    };
  } catch (error) {
    console.error('Error loading exclusion rules:', error);
    return ALLOW_ALL;
  }
}

// Load the per-event "dominated-listings" enable set. Returns a Set of
// mapping_ids for which the rule should fire. If the ExclusionRules doc
// has dominatedListings.enabled=true, that event's mapping_id lands in
// the set. Empty set = no events opted in = no-op.
async function loadDominatedListingsEnabledSet(mappingIds: string[]): Promise<Set<string>> {
  if (mappingIds.length === 0) return new Set();
  try {
    const events = await Event.find(
      { mapping_id: { $in: mappingIds } },
      { _id: 1, mapping_id: 1 }
    ).lean();
    if (events.length === 0) return new Set();

    const objectIdToMappingId = new Map<string, string>();
    const eventIds: string[] = [];
    for (const e of events as Array<{ _id: unknown; mapping_id: string }>) {
      const oid = String(e._id);
      objectIdToMappingId.set(oid, e.mapping_id);
      eventIds.push(oid);
    }

    const rules = await ExclusionRules.find(
      { eventId: { $in: eventIds }, isActive: true, 'dominatedListings.enabled': true },
      { eventId: 1 }
    ).lean();

    const enabled = new Set<string>();
    for (const rule of rules as Array<{ eventId: string }>) {
      const mid = objectIdToMappingId.get(String(rule.eventId));
      if (mid) enabled.add(mid);
    }
    return enabled;
  } catch (error) {
    console.error('Error loading dominated-listings enable set:', error);
    return new Set();
  }
}

// Load the per-event "cover-listings" enable set. Same shape as
// loadDominatedListingsEnabledSet but keyed on coverListings.enabled.
async function loadCoverListingsEnabledSet(mappingIds: string[]): Promise<Set<string>> {
  if (mappingIds.length === 0) return new Set();
  try {
    const events = await Event.find(
      { mapping_id: { $in: mappingIds } },
      { _id: 1, mapping_id: 1 }
    ).lean();
    if (events.length === 0) return new Set();

    const objectIdToMappingId = new Map<string, string>();
    const eventIds: string[] = [];
    for (const e of events as Array<{ _id: unknown; mapping_id: string }>) {
      const oid = String(e._id);
      objectIdToMappingId.set(oid, e.mapping_id);
      eventIds.push(oid);
    }

    const rules = await ExclusionRules.find(
      { eventId: { $in: eventIds }, isActive: true, 'coverListings.enabled': true },
      { eventId: 1 }
    ).lean();

    const enabled = new Set<string>();
    for (const rule of rules as Array<{ eventId: string }>) {
      const mid = objectIdToMappingId.get(String(rule.eventId));
      if (mid) enabled.add(mid);
    }
    return enabled;
  } catch (error) {
    console.error('Error loading cover-listings enable set:', error);
    return new Set();
  }
}

// Cover sizes emitted for a pack of quantity Q. The rule keeps the
// orphan count (Q - cover) even and >= 2 — we never emit a cover that
// would leave a single dangling seat behind, and we never emit the
// parent size itself. Equivalently: cover has the same parity as Q,
// and 2 <= cover <= Q - 2.
//   Q=4  → [2]              (leaves 2)
//   Q=5  → [3]              (leaves 2)
//   Q=6  → [2, 4]           (leaves 4 or 2)
//   Q=7  → [3, 5]           (leaves 4 or 2)
//   Q=8  → [2, 4, 6]        (leaves 6/4/2)
//   Q=13 → [3, 5, 7, 9, 11] (leaves 10/8/6/4/2)
export function coverSizesFor(q: number): number[] {
  if (!Number.isFinite(q) || q < 4) return [];
  const out: number[] = [];
  const startParity = q % 2; // 0 for even Q, 1 for odd Q
  for (let k = 2 + (startParity === 0 ? 0 : 1); k <= q - 2; k += 2) out.push(k);
  return out;
}

// Take a parent CsvRow that is unsplittable (custom_split === String(quantity))
// and has cost data, and expand it into an array of sibling cover
// listings. Each sibling shares the same physical seats, section, row,
// tags, etc.; the diffs are quantity (the cover size), custom_split
// (String(coverSize)), inventory_id (deterministic parent-derived),
// list_price (priced so a single sale of coverSize fully covers the
// pack's total cost). Returns [] if the row isn't eligible.
export function buildCoverSiblings(parent: CsvRow): CsvRow[] {
  const q = Number(parent.quantity);
  if (!Number.isFinite(q) || q < 4) return [];
  // Only expand when the pack is genuinely unsplittable — custom_split
  // exactly equals the full quantity as a single value. Anything else
  // (already-split packs, missing custom_split, other split_type) is
  // left alone so we never override human intent.
  const split = (parent.custom_split ?? '').trim();
  if (split !== String(q)) return [];
  const perSeatCost = Number(parent.cost);
  if (!Number.isFinite(perSeatCost) || perSeatCost <= 0) return [];
  const sizes = coverSizesFor(q);
  if (sizes.length === 0) return [];
  const totalCost = perSeatCost * q;
  const parentIdStr = String(parent.inventory_id);
  const siblings: CsvRow[] = [];
  for (const size of sizes) {
    const listPrice = Math.round((totalCost / size) * 100) / 100;
    const covId = deterministicCoverId(parentIdStr, size);
    siblings.push({
      ...parent,
      inventory_id: covId as unknown as CsvRow['inventory_id'],
      quantity: size,
      custom_split: String(size),
      split_type: 'CUSTOM',
      list_price: listPrice,
    });
  }
  return siblings;
}

// Cover inventory_id derived from the parent id so it stays stable
// across scrapes — Automatiq treats a stable id as an in-place update
// rather than a fresh listing. Format: <parent>9<coverSize padded>.
// Parent inventory_ids are already numeric (10-digit generated); a
// suffix chunk keeps the value integer-typed for downstream systems
// that require it.
export function deterministicCoverId(parentId: string, coverSize: number): string {
  const suffix = String(coverSize).padStart(2, '0');
  return `${parentId}9${suffix}`;
}

// Apply cover-listings expansion to records. For every eligible parent
// in the input, appends its cover siblings (parent stays in the output
// unchanged). Records for events not in enabledMappingIds pass through
// untouched. Returns { records, added } so callers can log/track the
// number of siblings introduced.
export function applyCoverListingsExpansion(
  records: CsvRow[],
  enabledMappingIds: Set<string>,
): { records: CsvRow[]; added: number } {
  if (enabledMappingIds.size === 0) return { records, added: 0 };
  const out: CsvRow[] = [];
  let added = 0;
  for (const r of records) {
    out.push(r);
    if (!enabledMappingIds.has(r.event_id)) continue;
    const siblings = buildCoverSiblings(r);
    if (siblings.length > 0) {
      out.push(...siblings);
      added += siblings.length;
    }
  }
  return { records: out, added };
}

// Load the per-event "combined-listings" enable set.
async function loadCombinedListingsEnabledSet(mappingIds: string[]): Promise<Set<string>> {
  if (mappingIds.length === 0) return new Set();
  try {
    const events = await Event.find(
      { mapping_id: { $in: mappingIds } },
      { _id: 1, mapping_id: 1 }
    ).lean();
    if (events.length === 0) return new Set();

    const objectIdToMappingId = new Map<string, string>();
    const eventIds: string[] = [];
    for (const e of events as Array<{ _id: unknown; mapping_id: string }>) {
      const oid = String(e._id);
      objectIdToMappingId.set(oid, e.mapping_id);
      eventIds.push(oid);
    }

    const rules = await ExclusionRules.find(
      { eventId: { $in: eventIds }, isActive: true, 'combinedListings.enabled': true },
      { eventId: 1 }
    ).lean();

    const enabled = new Set<string>();
    for (const rule of rules as Array<{ eventId: string }>) {
      const mid = objectIdToMappingId.get(String(rule.eventId));
      if (mid) enabled.add(mid);
    }
    return enabled;
  } catch (error) {
    console.error('Error loading combined-listings enable set:', error);
    return new Set();
  }
}

const COMBINED_MAX_SEATS = 8;
const COMBINED_FACE_PREMIUM = 0.15; // 15% over face

// Parse the comma-separated seat string on a CsvRow into a sorted array
// of integer seat numbers. Non-numeric tokens are skipped. Returns []
// if nothing parses — that row is then ineligible for combining.
export function parseSeatNumbers(seats: string | null | undefined): number[] {
  if (!seats) return [];
  const out: number[] = [];
  for (const tok of String(seats).split(',')) {
    const n = parseInt(tok.trim(), 10);
    if (Number.isFinite(n)) out.push(n);
  }
  out.sort((a, b) => a - b);
  return out;
}

// A listing is contiguous in its own seat numbers if seats form an
// unbroken run (seat[i+1] == seat[i]+1 for all i). Non-contiguous
// listings (e.g. "3,5,7") are ineligible — the seats themselves have
// gaps so combining them with neighbors would be meaningless.
function isOwnRunContiguous(seats: number[]): boolean {
  for (let i = 1; i < seats.length; i++) if (seats[i] !== seats[i - 1] + 1) return false;
  return true;
}

// Deterministic combined inventory_id derived from the sorted component
// ids joined + hashed to a compact numeric-ish string. Stable across
// scrapes: same components → same id, so Automatiq updates in place.
// Format: "<hash>8<combinedQty:02d>" — the "8" separator marks these
// as combined-listing ids (covers use "9" separator).
export function deterministicCombinedId(componentIds: string[], combinedQty: number): string {
  const sorted = [...componentIds].sort();
  // FNV-1a 32-bit, plenty of range for our id count and no crypto import.
  let h = 2166136261 >>> 0;
  const joined = sorted.join('|');
  for (let i = 0; i < joined.length; i++) {
    h ^= joined.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  const hashStr = (h >>> 0).toString(10).padStart(10, '0');
  return `${hashStr}8${String(combinedQty).padStart(2, '0')}`;
}

// Build the synthetic combined listing for a run of contiguous components.
// Priced at (Σ qty_i × face_price_i) × 1.15 / combined_qty so a single
// sale of the bundle recoups every component's face + 15% premium.
// custom_split is set to combinedQty (unsplittable), which then makes
// the synthetic itself eligible for cover-listings if that's enabled.
function buildCombinedFromComponents(components: CsvRow[]): CsvRow | null {
  if (components.length < 2) return null;
  const combinedQty = components.reduce((s, c) => s + Number(c.quantity || 0), 0);
  if (combinedQty < 2 || combinedQty > COMBINED_MAX_SEATS) return null;
  let totalFace = 0;
  const seatNums: number[] = [];
  const ids: string[] = [];
  for (const c of components) {
    const q = Number(c.quantity || 0);
    const fp = Number(c.face_price || 0);
    if (!Number.isFinite(fp) || fp <= 0) return null;
    totalFace += q * fp;
    for (const s of parseSeatNumbers(c.seats)) seatNums.push(s);
    ids.push(String(c.inventory_id));
  }
  seatNums.sort((a, b) => a - b);
  const listPrice = Math.round((totalFace * (1 + COMBINED_FACE_PREMIUM) / combinedQty) * 100) / 100;
  const base = components[0];
  return {
    ...base,
    inventory_id: deterministicCombinedId(ids, combinedQty) as unknown as CsvRow['inventory_id'],
    quantity: combinedQty,
    seats: seatNums.join(','),
    custom_split: String(combinedQty),
    split_type: 'CUSTOM',
    list_price: listPrice,
    face_price: Math.round((totalFace / combinedQty) * 100) / 100,
  };
}

// Enumerate every contiguous k-way sub-run (k >= 2) of the given
// listings, capped so combinedQty <= COMBINED_MAX_SEATS. Input must be
// pre-sorted by min seat number. A pair (i, i+1) is adjacent when the
// max seat of i is exactly one less than the min seat of i+1. From
// there we grow the run rightward while it stays adjacent AND under
// the seat cap.
function enumerateContiguousRuns(sorted: { row: CsvRow; seats: number[] }[]): CsvRow[][] {
  const runs: CsvRow[][] = [];
  for (let i = 0; i < sorted.length; i++) {
    let combinedQty = sorted[i].seats.length;
    let lastMax = sorted[i].seats[sorted[i].seats.length - 1];
    for (let j = i + 1; j < sorted.length; j++) {
      const cand = sorted[j];
      if (cand.seats[0] !== lastMax + 1) break; // gap → run ends here
      combinedQty += cand.seats.length;
      if (combinedQty > COMBINED_MAX_SEATS) break; // over cap → stop
      lastMax = cand.seats[cand.seats.length - 1];
      const componentRows = sorted.slice(i, j + 1).map((s) => s.row);
      runs.push(componentRows);
    }
  }
  return runs;
}

// Apply combined-listings expansion to records. Groups eligible records
// by (event_id, section, row), sorts each group by min seat number,
// enumerates contiguous sub-runs of 2+, and appends a synthetic
// combined listing per run. Originals stay in place unchanged.
export function applyCombinedListingsExpansion(
  records: CsvRow[],
  enabledMappingIds: Set<string>,
): { records: CsvRow[]; added: number } {
  if (enabledMappingIds.size === 0) return { records, added: 0 };
  type Item = { row: CsvRow; seats: number[] };
  const groups = new Map<string, Item[]>();
  for (const r of records) {
    if (!enabledMappingIds.has(r.event_id)) continue;
    const seats = parseSeatNumbers(r.seats);
    if (seats.length === 0 || !isOwnRunContiguous(seats)) continue;
    const key = `${r.event_id}|${r.section}|${r.row}`;
    let arr = groups.get(key);
    if (!arr) { arr = []; groups.set(key, arr); }
    arr.push({ row: r, seats });
  }

  const out: CsvRow[] = [...records];
  let added = 0;
  const emitted = new Set<string>();
  for (const items of groups.values()) {
    items.sort((a, b) => a.seats[0] - b.seats[0]);
    for (const run of enumerateContiguousRuns(items)) {
      const synth = buildCombinedFromComponents(run);
      if (!synth) continue;
      const idKey = String(synth.inventory_id);
      if (emitted.has(idKey)) continue;
      emitted.add(idKey);
      out.push(synth);
      added++;
    }
  }
  return { records: out, added };
}

// Rank a row label from front to back based on the label itself.
//   Numeric ("1" .. "10000")           -> { kind: 'num', rank: N }
//   Single letter A-Z (case-insensitive) -> { kind: 'alpha', rank: 1..26 }
//   Anything else (multi-letter "AA", mixed "12A", empty, etc.) -> null
// Groups whose row cannot be ranked are NOT considered for domination.
// Kinds are independent universes: letters never compete with numbers.
// A third kind 'venue' is produced when the VenueRowMap cache resolves
// this row's true index — that ranking is authoritative for the section
// and shares no universe with the label-derived kinds.
export type RowRank = { kind: 'num' | 'alpha' | 'venue'; rank: number };

// event map: eventId -> section -> rowLabel -> index (front-to-back).
export type VenueRowIndex = Map<string, Map<string, Map<string, number>>>;

function normEvent(v: string | null | undefined): string {
  return (v || '').trim();
}

function normSection(s: string | null | undefined): string {
  return (s || '').trim().toUpperCase();
}

function normRow(r: string | null | undefined): string {
  return (r || '').trim().toUpperCase();
}

export function lookupVenueRank(
  index: VenueRowIndex | null | undefined,
  eventId: string | null | undefined,
  section: string | null | undefined,
  row: string | null | undefined,
): number | null {
  if (!index) return null;
  const s = index.get(normEvent(eventId))?.get(normSection(section))?.get(normRow(row));
  return typeof s === 'number' ? s : null;
}

// Bulk-load EventRowMap docs for the events referenced in the records.
// One indexed query keyed on eventId keeps this cheap even for full-
// catalog CSV runs. Returns an empty index if none are cached yet;
// the ranker then falls back to label parsing for every row.
export async function loadVenueRowIndex(records: CsvRow[]): Promise<VenueRowIndex> {
  const { EventRowMap } = await import('../models/venueRowMapModel.js');
  const eventIds = new Set<string>();
  for (const r of records) {
    const e = normEvent(r.event_id);
    if (e) eventIds.add(e);
  }
  const index: VenueRowIndex = new Map();
  if (eventIds.size === 0) return index;
  const docs = await (EventRowMap as any)
    .find({ eventId: { $in: [...eventIds] } })
    .lean();
  for (const doc of docs || []) {
    const eKey = normEvent(doc.eventId);
    const sKey = normSection(doc.section);
    let byEvent = index.get(eKey);
    if (!byEvent) { byEvent = new Map(); index.set(eKey, byEvent); }
    let byRow = byEvent.get(sKey);
    if (!byRow) { byRow = new Map(); byEvent.set(sKey, byRow); }
    const rows: string[] = Array.isArray(doc.rows) ? doc.rows : [];
    rows.forEach((rowName, idx) => {
      byRow!.set(normRow(rowName), idx);
    });
  }
  return index;
}

export function rankRowLabel(row: string | null | undefined): RowRank | null {
  if (row == null) return null;
  const s = String(row).trim();
  if (!s) return null;
  if (/^\d+$/.test(s)) {
    const n = parseInt(s, 10);
    return Number.isFinite(n) ? { kind: 'num', rank: n } : null;
  }
  if (/^[A-Za-z]$/.test(s)) {
    return { kind: 'alpha', rank: s.toUpperCase().charCodeAt(0) - 64 }; // A=1..Z=26
  }
  return null;
}

// Apply the dominated-listings rule to records for events opted in.
// Rank priority per record:
//   1. VenueRowMap cache lookup (kind='venue') — authoritative TM order.
//   2. Numeric row label (kind='num') — 1 = best, 10000 = worst.
//   3. Single-letter row label (kind='alpha') — A = best, Z = worst.
//   Otherwise (AA / AAA / mixed / blank): the listing passes through.
// Within (event_id, section, quantity, custom_split), items split into
// independent universes by rank kind — 'venue' rows never dominate
// 'num' or 'alpha' rows and vice versa. Each universe is then sorted
// by rank asc, tie-broken by per-seat face_price asc, and any record
// whose front-sibling in the same universe is already at <= per-seat
// price is dropped.
// Records for events NOT in enabledMappingIds pass through untouched.
// GA/parking/lawn (no rankable row) also pass through.
export function applyDominatedListingsFilter(
  records: CsvRow[],
  enabledMappingIds: Set<string>,
  venueIndex: VenueRowIndex | null = null,
): { kept: CsvRow[]; dropped: number } {
  if (enabledMappingIds.size === 0) return { kept: records, dropped: 0 };

  type Bucket = { items: { row: CsvRow; rank: RowRank }[] };
  const buckets = new Map<string, Bucket>();
  const passthrough: CsvRow[] = [];

  for (const r of records) {
    if (!enabledMappingIds.has(r.event_id)) {
      passthrough.push(r);
      continue;
    }
    const venueRank = lookupVenueRank(venueIndex, r.event_id, r.section, r.row);
    const rank: RowRank | null =
      venueRank != null
        ? { kind: 'venue', rank: venueRank }
        : rankRowLabel(r.row);
    if (rank == null) {
      passthrough.push(r);
      continue;
    }
    const bkey = `${r.event_id}|${r.section}|${r.quantity}|${r.custom_split || ''}`;
    let b = buckets.get(bkey);
    if (!b) { b = { items: [] }; buckets.set(bkey, b); }
    b.items.push({ row: r, rank });
  }

  const kept: CsvRow[] = [...passthrough];
  let dropped = 0;
  for (const bucket of buckets.values()) {
    for (const kind of ['venue', 'num', 'alpha'] as const) {
      const universe = bucket.items.filter(it => it.rank.kind === kind);
      if (universe.length === 0) continue;
      universe.sort((a, b) => {
        if (a.rank.rank !== b.rank.rank) return a.rank.rank - b.rank.rank;
        return (a.row.face_price ?? 0) - (b.row.face_price ?? 0);
      });
      const survivors: { row: CsvRow }[] = [];
      for (const item of universe) {
        const perSeat = item.row.face_price ?? 0;
        const dominated = survivors.some(s => (s.row.face_price ?? 0) <= perSeat);
        if (dominated) {
          dropped++;
        } else {
          survivors.push(item);
        }
      }
      kept.push(...survivors.map(s => s.row));
    }
  }
  return { kept, dropped };
}

// Standard-drop hold filter. Hot events see newly-listed STANDARD
// (primary) tickets sell out within minutes of appearing; if we push
// those to Automatiq before they've proven staying power, we get
// unfulfillable orders. The scraper stamps every new standard listing
// with provisionalUntil = firstSeenAt + 30 min. This filter drops
// rows whose provisionalUntil is still in the future.
export function isStandardHoldActive(record: CsvRow, now: number = Date.now()): boolean {
  const pu = record.provisionalUntil;
  if (!pu) return false;
  const t = typeof pu === 'string' || pu instanceof Date ? new Date(pu).getTime() : NaN;
  if (!Number.isFinite(t)) return false;
  return t > now;
}

const isBlockedVenueState = (record: CsvRow): boolean => {
  const v = (record.venue_name || '').trim().toLowerCase();
  return BLOCKED_STATES.some(s => v === s || v.endsWith(', ' + s) || v.endsWith(',' + s));
};

// Apply price adjustment (increase or decrease) to a price value
function applyPriceAdjustment(originalPrice: number): number {
  const adjustmentPercentage = getPriceAdjustmentPercentage();
  if (adjustmentPercentage === 0) {
    return originalPrice;
  }
  // Positive percentage = increase, Negative percentage = decrease
  return originalPrice * (1 + adjustmentPercentage / 100);
}

// Generic retry wrapper
async function withRetry<T>(
  operation: () => Promise<T>,
  operationName: string,
  config: RetryConfig = DEFAULT_RETRY_CONFIG
): Promise<T> {
  let lastError: Error;
  
  for (let attempt = 0; attempt <= config.maxRetries; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error as Error;
      
      if (attempt === config.maxRetries) {
        await createErrorLog({
          eventUrl: `RETRY_${operationName.toUpperCase().replace(/\s+/g, '_')}`,
          errorType: 'DATABASE_ERROR',
          message: lastError.message,
          stack: lastError.stack,
          metadata: {
            operation: operationName,
            attempt: attempt + 1,
            timestamp: new Date()
          }
        });
        throw lastError;
      }
      
      const delay = calculateDelay(attempt, config);
      console.warn(`[CSV] ${operationName} failed (attempt ${attempt + 1}/${config.maxRetries + 1}): ${lastError.message}. Retrying in ${Math.round(delay)}ms...`);
      
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
  
  throw lastError!;
}

// Cache for resolved venue timezones within a CSV generation run
const _venueTzCache = new Map<string, string | null>();

// Shared Mongo projection for CSV chunk fetches. Only includes fields the row
// mapper actually reads.
const CSV_PROJECTION = {
  'inventory.inventoryId': 1,
  'event_name': 1,
  'venue_name': 1,
  'event_date': 1,
  'eventId': 1,
  'mapping_id': 1,
  'inventory.quantity': 1,
  'inventory.section': 1,
  'inventory.row': 1,
  'seats.number': 1,
  'inventory.barcodes': 1,
  'inventory.tags': 1,
  'inventory.publicNotes': 1,
  'inventory.listPrice': 1,
  'inventory.face_price': 1,
  'inventory.taxed_cost': 1,
  'inventory.cost': 1,
  'inventory.hideSeatNumbers': 1,
  'inventory.inHandDate': 1,
  'inventory.instant_transfer': 1,
  'inventory.splitType': 1,
  'inventory.customSplit': 1,
  'inventory.stockType': 1,
  'inventory.zone': 1,
  'inventory.shown_quantity': 1,
  'inventory.passthrough': 1,
  'inventory.seatType': 1,
  'inventory.productType': 1,
  'inventory.rowRank': 1,
  'inventory.firstSeenAt': 1,
  'inventory.provisionalUntil': 1,
} as const;

// ── Global: stop events with seats <= threshold & clear their inventory ──
export async function stopLowSeatEvents(): Promise<{ stopped: number; eventIds: string[] }> {
  await dbConnect();
  try {
    // Read settings from DB
    const schedulerSettings = await SchedulerSettings.findOne({}).lean() as any;
    const enabled = schedulerSettings?.lowSeatAutoStop ?? false;
    const threshold = schedulerSettings?.lowSeatThreshold ?? 10;

    if (!enabled) {
      return { stopped: 0, eventIds: [] };
    }

    // Get all active events
    const activeEvents = await Event.find(
      { Skip_Scraping: false },
      { mapping_id: 1, Event_ID: 1, Event_Name: 1, Venue: 1 }
    ).lean();

    if (activeEvents.length === 0) return { stopped: 0, eventIds: [] };

    const mappingIds = activeEvents
      .map((e: any) => e.mapping_id)
      .filter(Boolean);

    // Aggregate total inventory quantity per mapping_id
    const seatCounts: { _id: string; totalQty: number }[] =
      await ConsecutiveGroup.aggregate([
        { $match: { mapping_id: { $in: mappingIds } } },
        { $group: { _id: '$mapping_id', totalQty: { $sum: '$inventory.quantity' } } },
      ]);

    const qtyMap = new Map(seatCounts.map((s) => [s._id, s.totalQty]));

    // Find events whose total seats > 0 but <= threshold
    const lowSeatEvents = activeEvents.filter((ev: any) => {
      const qty = qtyMap.get(ev.mapping_id) ?? 0;
      return qty > 0 && qty <= threshold;
    });

    if (lowSeatEvents.length === 0) return { stopped: 0, eventIds: [] };

    const eventIds = lowSeatEvents.map((ev: any) => String(ev._id));
    const mappingIdsToStop = lowSeatEvents.map((ev: any) => ev.mapping_id).filter(Boolean);

    // Stop scraping
    await Event.updateMany(
      { _id: { $in: eventIds } },
      { $set: { Skip_Scraping: true } }
    );

    // Clear inventory
    await deleteConsecutiveGroupsByEventIds(eventIds);

    console.log(
      `[LowSeat] Stopped ${lowSeatEvents.length} events with <= ${threshold} seats: ${mappingIdsToStop.join(', ')}`
    );

    await createErrorLog({
      eventUrl: 'LOW_SEAT_AUTO_STOP',
      errorType: 'AUTO_STOP',
      message: `Stopped ${lowSeatEvents.length} event(s) with ${threshold} or fewer seats and cleared inventory`,
      metadata: {
        threshold,
        stoppedEvents: lowSeatEvents.map((ev: any) => ({
          id: ev._id,
          mapping_id: ev.mapping_id,
          name: ev.Event_Name,
          venue: ev.Venue,
          seats: qtyMap.get(ev.mapping_id) ?? 0,
        })),
      },
    });

    return { stopped: lowSeatEvents.length, eventIds };
  } catch (error) {
    console.error('[LowSeat] Error during low-seat check:', error);
    return { stopped: 0, eventIds: [] };
  }
}

export async function generateInventoryCsv(eventUpdateFilterMinutes: number = 0) {
  return withRetry(async () => {
    await dbConnect();

    const mongoose = await import('mongoose');

    const startTime = Date.now();

    // Clear venue timezone cache at the start of each CSV generation run
    _venueTzCache.clear();

    // ── Stop low-seat events before generating CSV ──
    const lowSeatResult = await stopLowSeatEvents();
    if (lowSeatResult.stopped > 0) {
      console.log(`[CSV] Pre-export: stopped ${lowSeatResult.stopped} low-seat event(s)`);
    }

    try {
      let eventFilter = {};
      
      // Only include active events (Skip_Scraping: false)
      const activeEventQuery: Record<string, any> = { Skip_Scraping: false };

      // If eventUpdateFilterMinutes is provided, also filter by recently updated events
      if (eventUpdateFilterMinutes > 0) {
        const cutoffTime = new Date(Date.now() - eventUpdateFilterMinutes * 60 * 1000);
        activeEventQuery.updatedAt = { $gte: cutoffTime };
        console.log(`Filter: Active events updated within last ${eventUpdateFilterMinutes} minutes since ${cutoffTime.toISOString()}`);
      } else {
        console.log('Including all active events (Skip_Scraping: false)');
      }

      const activeEvents = await Event.find(
        activeEventQuery,
        { mapping_id: 1 }
      )
      .read('primary')
      .maxTimeMS(30000);

      console.log(`Found ${activeEvents.length} active events matching filter criteria`);

      if (activeEvents.length === 0) {
        return { success: false, message: eventUpdateFilterMinutes > 0
          ? `No active events updated within the last ${eventUpdateFilterMinutes} minutes.`
          : 'No active events found (all events have Skip_Scraping enabled).' };
      }

      const eventMappingIds = activeEvents.map(event => event.mapping_id);
      eventFilter = { mapping_id: { $in: eventMappingIds } };

      // Pre-fetch ALL event details once (small — only active events) instead of
      // running $lookup per chunk. This is the single biggest speed-up.
      const eventDetailsMap = new Map<string, {
        url: string; stdAdj: number; resaleAdj: number; brokerAdj: number; defaultPct: number;
        includeStandard: boolean; includeResale: boolean;
      }>();
      const eventDocs = await Event.find(
        { mapping_id: { $in: eventMappingIds } },
        { mapping_id: 1, URL: 1, standardMarkupAdjustment: 1, resaleMarkupAdjustment: 1,
          brokerMarkupAdjustment: 1, priceIncreasePercentage: 1,
          includeStandardSeats: 1, includeResaleSeats: 1 }
      ).lean();
      for (const ev of eventDocs) {
        eventDetailsMap.set(ev.mapping_id, {
          url: ev.URL || '',
          stdAdj: ev.standardMarkupAdjustment ?? 0,
          resaleAdj: ev.resaleMarkupAdjustment ?? 0,
          brokerAdj: ev.brokerMarkupAdjustment ?? 0,
          defaultPct: ev.priceIncreasePercentage ?? 0,
          includeStandard: ev.includeStandardSeats !== false,
          includeResale: ev.includeResaleSeats !== false,
        });
      }
      console.log(`[CSV] Pre-fetched details for ${eventDetailsMap.size} events`);

    // Projection — only fields actually read by the row mapper. Six fields
    // (inventory.notes, inventory.in_hand, inventory.files_available, and the
    // unused fields used to be projected but were never
    // referenced; pruning them shrinks every chunk's BSON payload.
    const projection = CSV_PROJECTION;

      // Chunked processing: first get all _ids (fast, no $lookup), then process
      // in batches. Event data is joined in JS from the pre-fetched map.
      const CHUNK_SIZE = 10000;

      // Hoist exclusion-rule + scheduler reads out of the chunk loop. The
      // exclusion-rules DB query used to run inside every chunk; doing it
      // once removes O(chunks) redundant round-trips. Section-mode min-seat
      // is still computed in JS after the loop over post-exclusion records,
      // matching the original behaviour exactly.
      const exclusionFilter = await buildExclusionFilter(eventMappingIds);

      const schedulerSettings = await SchedulerSettings.findOne({}).lean() as any;
      const minSeatFilter: number = schedulerSettings?.minSeatFilter ?? 0;
      const minSeatFilterMode: 'section' | 'row' = schedulerSettings?.minSeatFilterMode ?? 'section';

      // Step 1: Get all matching _ids quickly (no $lookup, very fast)
      const idPipeline: PipelineStage[] = [
        { $match: eventFilter },
        { $sort: { _id: 1 as const } },
        { $project: { _id: 1 } },
      ];
      const allIds = await ConsecutiveGroup.aggregate(idPipeline, {
        allowDiskUse: true,
        maxTimeMS: 60000,
      });
      const totalDocs = allIds.length;
      console.log(`[CSV] Total documents to process: ${totalDocs} (chunk size: ${CHUNK_SIZE})`);

      if (totalDocs === 0) {
        console.log('[CSV] No matching ConsecutiveGroup documents found');
        return { success: false, message: 'No inventory data found. Check if events exist and have inventory data.' };
      }

      // Per-chunk we apply blocked-states + exclusion rules + (if row mode)
      // min-seat. Section-mode min-seat needs the full post-exclusion record
      // set to compute totals, so it runs after the loop — same as before.
      let filteredRecords: CsvRow[] = [];
      let processedCount = 0;
      let producedCount = 0;
      let excludedCount = 0;
      let chunkNum = 0;

      const rowModeMinSeat = minSeatFilter > 0 && minSeatFilterMode === 'row'
        ? (r: CsvRow) => r.quantity > minSeatFilter
        : null;

      // Step 2: Process in chunks — simple find by _ids, no $lookup needed
      for (let i = 0; i < totalDocs; i += CHUNK_SIZE) {
        chunkNum++;
        const chunkStart = Date.now();
        const chunkIds = allIds.slice(i, i + CHUNK_SIZE).map((d: { _id: string }) => d._id);

        const chunkDocs: ConsecutiveGroupDocument[] = await ConsecutiveGroup.aggregate(
          [
            { $match: { _id: { $in: chunkIds } } },
            { $project: projection },
          ] as PipelineStage[],
          { allowDiskUse: true, maxTimeMS: 120000 }
        );

        if (chunkDocs.length > 0) {
          // Enrich docs with event data from the pre-fetched map + apply include/exclude filter
          const enrichedDocs: ConsecutiveGroupDocument[] = [];
          for (const doc of chunkDocs) {
            const evData = doc.mapping_id ? eventDetailsMap.get(doc.mapping_id) : undefined;
            const isStandard = doc.inventory?.splitType === 'NEVERLEAVEONE';
            // Apply per-event standard/resale inclusion toggles
            if (isStandard && evData && !evData.includeStandard) continue;
            if (!isStandard && evData && !evData.includeResale) continue;

            doc.event_url = evData?.url || '';
            doc.event_std_adj = evData?.stdAdj ?? 0;
            doc.event_resale_adj = evData?.resaleAdj ?? 0;
            doc.event_broker_adj = evData?.brokerAdj ?? 0;
            doc.event_default_pct = evData?.defaultPct ?? 0;
            enrichedDocs.push(doc);
          }
          if (enrichedDocs.length > 0) {
            const processedBatch = await processBatch(enrichedDocs);
            producedCount += processedBatch.length;
            for (const r of processedBatch) {
              if (isBlockedVenueState(r)) { excludedCount++; continue; }
              if (isStandardHoldActive(r)) { excludedCount++; continue; }
              if (!exclusionFilter(r)) { excludedCount++; continue; }
              if (rowModeMinSeat && !rowModeMinSeat(r)) { excludedCount++; continue; }
              filteredRecords.push(r);
            }
          }
        }
        processedCount += chunkIds.length;

        const chunkMs = Date.now() - chunkStart;
        console.log(`[CSV] Chunk ${chunkNum}: ${chunkDocs.length} docs -> ${filteredRecords.length} kept in ${chunkMs}ms (${processedCount}/${totalDocs}, ${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)}MB heap)`);

        // Yield control between chunks
        await new Promise(resolve => {
          if (typeof setImmediate !== 'undefined') {
            setImmediate(resolve);
          } else {
            setTimeout(resolve, 0);
          }
        });
      }

      // Section-mode min-seat: totals are summed across the post-exclusion
      // records (matches the original behaviour exactly — sections whose
      // surviving rows total <= threshold are dropped).
      if (minSeatFilter > 0 && minSeatFilterMode === 'section') {
        const beforeMinSeat = filteredRecords.length;
        const sectionTotals = new Map<string, number>();
        for (const r of filteredRecords) {
          const key = `${r.event_id}|${r.section}`;
          sectionTotals.set(key, (sectionTotals.get(key) ?? 0) + r.quantity);
        }
        filteredRecords = filteredRecords.filter(r => {
          const key = `${r.event_id}|${r.section}`;
          return (sectionTotals.get(key) ?? 0) > minSeatFilter;
        });
        const removed = beforeMinSeat - filteredRecords.length;
        excludedCount += removed;
        console.log(`[CSV] Min seat filter [section] (<= ${minSeatFilter}): removed ${removed} listings`);
      }

      // Dominated-listings rule: fires only for events opted in via
      // ExclusionRules.dominatedListings.enabled=true. Runs after the
      // batch loop so we can compare across the full event.
      const dominatedEnabled = await loadDominatedListingsEnabledSet(eventMappingIds);
      if (dominatedEnabled.size > 0) {
        const beforeDom = filteredRecords.length;
        const venueIndex = await loadVenueRowIndex(filteredRecords);
        const { kept, dropped } = applyDominatedListingsFilter(filteredRecords, dominatedEnabled, venueIndex);
        filteredRecords = kept;
        excludedCount += dropped;
        console.log(`[CSV] Dominated-listings filter: ${dominatedEnabled.size} events opted in, removed ${dropped} of ${beforeDom} listings (venue-map: ${venueIndex.size} venues cached)`);
      }

      // Combined-listings expansion: fires for events opted in via
      // ExclusionRules.combinedListings.enabled=true. Within (event,
      // section, row), for every contiguous seat run of 2+ listings,
      // appends a synthetic bundle listing priced at face × 1.15 /
      // combined_qty. Synthetic ids are derived from the sorted
      // component ids, so any component change on the next scrape drops
      // the synthetic. Runs before cover-listings so a synthetic bundle
      // can then be cover-expanded.
      const combinedEnabled = await loadCombinedListingsEnabledSet(eventMappingIds);
      if (combinedEnabled.size > 0) {
        const beforeCmb = filteredRecords.length;
        const { records: withCombined, added } = applyCombinedListingsExpansion(filteredRecords, combinedEnabled);
        filteredRecords = withCombined;
        console.log(`[CSV] Combined-listings expansion: ${combinedEnabled.size} events opted in, added ${added} synthetic bundles to ${beforeCmb} originals`);
      }

      // Cover-listings expansion: fires for events opted in via
      // ExclusionRules.coverListings.enabled=true. For every unsplittable
      // pack with cost data, appends sibling listings at each cover size
      // priced to cover the pack's total cost from a single partial sale.
      // Cover ids are derived from the parent id, so any change to the
      // parent seat set drops both from the next scrape → Automatiq
      // treats the missing rows as sold and delists them together.
      const coverEnabled = await loadCoverListingsEnabledSet(eventMappingIds);
      if (coverEnabled.size > 0) {
        const beforeCov = filteredRecords.length;
        const { records: expanded, added } = applyCoverListingsExpansion(filteredRecords, coverEnabled);
        filteredRecords = expanded;
        console.log(`[CSV] Cover-listings expansion: ${coverEnabled.size} events opted in, added ${added} sibling listings to ${beforeCov} parents`);
      }

      console.log(`[CSV] Done: ${filteredRecords.length} kept / ${producedCount} produced / ${excludedCount} excluded (processed ${processedCount} docs in ${Date.now() - startTime}ms)`);

      if (filteredRecords.length === 0) {
        return { success: false, message: 'No inventory data found after applying exclusion rules. All records were filtered out.' };
      }

      // Optimized CSV generation using streaming approach
      const csvString = await generateCsvString(filteredRecords);
    
      const endTime = Date.now();
      const duration = endTime - startTime;
      const memoryUsage = Math.round(process.memoryUsage().heapUsed / 1024 / 1024);
      
      console.log(`[CSV] ✅ Generation completed in ${duration}ms for ${filteredRecords.length} records (Peak memory: ${memoryUsage}MB)`);

      return { 
        success: true, 
        csv: csvString,
        recordCount: filteredRecords.length,
        excludedCount,
        generationTime: duration,
        memoryUsage
      };
    } catch (error) {
      console.error('Error generating CSV:', error);
      await createErrorLog({
        eventUrl: 'CSV_GENERATION',
        errorType: 'DATABASE_ERROR',
        message: error instanceof Error ? error.message : 'Unknown error',
        stack: error instanceof Error ? error.stack : undefined,
        metadata: {
          operation: 'generateInventoryCsv',
          timestamp: new Date()
        }
      });
      return { success: false, message: 'Failed to generate CSV.' };
    }
  }, 'CSV Generation');
}

// Interface for the document structure from MongoDB aggregation
interface ConsecutiveGroupDocument {
  _id?: string;
  inventory?: {
    inventoryId?: number;
    quantity?: number;
    section?: string;
    row?: string;
    barcodes?: string;
    tags?: string;
    notes?: string;
    publicNotes?: string;
    listPrice?: number;
    face_price?: number;
    taxed_cost?: number;
    cost?: number;
    hideSeatNumbers?: boolean;
    in_hand?: boolean;
    inHandDate?: Date | string;
    instant_transfer?: boolean;
    files_available?: boolean;
    splitType?: string;
    customSplit?: string;
    stockType?: string;
    zone?: boolean;
    shown_quantity?: number;
    passthrough?: string;
  };
  event_name?: string;
  venue_name?: string;
  event_date?: Date | string;
  eventId?: string;
  mapping_id?: string;
  event_url?: string;
  event_std_adj?: number;
  event_resale_adj?: number;
  event_broker_adj?: number;
  event_default_pct?: number;
  seats?: Array<{ number: string | number }>;
}

// Function to determine split configuration based on ticket type and quantity.
// For resale, prefers the DB `customSplit` value (written by the scraper from TM's
// sellableQuantities, clipped to the actual seat-group size). Falls back to the
// legacy hardcoded table only when the DB value is missing. Standard tickets use
// the DB `customSplit` when present, otherwise NEVERLEAVEONE — no legacy fallback.
function calculateSplitConfiguration(
  quantity: number,
  splitType?: string,
  dbCustomSplit?: string,
): {
  finalSplitType: CsvRow['split_type'];
  customSplit: string;
} {
  const isResale = splitType !== 'NEVERLEAVEONE';

  if (isResale) {
    if (dbCustomSplit && dbCustomSplit.trim().length > 0) {
      return { finalSplitType: 'CUSTOM', customSplit: dbCustomSplit.trim() };
    }

    // Legacy resale fallback — used only when the scraper didn't provide a split.
    if ((quantity % 2 === 0 && quantity >= 10) || (quantity % 2 === 1 && quantity >= 11)) {
      return { finalSplitType: 'NEVERLEAVEONE', customSplit: '' };
    }
    if (quantity === 2) return { finalSplitType: 'CUSTOM', customSplit: '2' };
    if (quantity === 3) return { finalSplitType: 'CUSTOM', customSplit: '3' };
    if (quantity === 4) return { finalSplitType: 'CUSTOM', customSplit: '4' };
    if (quantity === 5) return { finalSplitType: 'CUSTOM', customSplit: '3,5' };
    if (quantity === 6) return { finalSplitType: 'CUSTOM', customSplit: '2,4,6' };
    if (quantity === 7) return { finalSplitType: 'CUSTOM', customSplit: '2,3,4,5,7' };
    if (quantity === 8) return { finalSplitType: 'CUSTOM', customSplit: '2,4,6,8' };
    if (quantity === 9) return { finalSplitType: 'CUSTOM', customSplit: '2,3,4,5,6,7,9' };
    if (quantity === 10) return { finalSplitType: 'CUSTOM', customSplit: '2,4,6,8,10' };
    if (quantity === 11) return { finalSplitType: 'CUSTOM', customSplit: '2,3,4,5,6,7,8,9,11' };
    return { finalSplitType: 'NEVERLEAVEONE', customSplit: '' };
  }

  // Standard (primary) — only apply TM's customSplit when the minimum sellable
  // quantity is >= 4 (i.e. TM is forcing 4-packs or larger). Anything smaller
  // falls through to NEVERLEAVEONE. No synthetic splits are generated.
  if (dbCustomSplit && dbCustomSplit.trim().length > 0) {
    const parsed = dbCustomSplit
      .split(',')
      .map(s => parseInt(s.trim(), 10))
      .filter(n => Number.isFinite(n) && n > 0);
    if (parsed.length > 0 && Math.min(...parsed) >= 4) {
      return { finalSplitType: 'CUSTOM', customSplit: dbCustomSplit.trim() };
    }
  }
  return { finalSplitType: 'NEVERLEAVEONE', customSplit: '' };
}

// Helper function to process batches
async function processBatch(batch: ConsecutiveGroupDocument[]): Promise<CsvRow[]> {
  // Resolve timezones for all unique venues in this batch (bulk, with DB cache + geocoding fallback)
  const uniqueVenues = [...new Set(batch.map(d => d.venue_name).filter(Boolean))] as string[];
  const unresolvedVenues = uniqueVenues.filter(v => !_venueTzCache.has(v));
  if (unresolvedVenues.length > 0) {
    const resolved = await resolveVenueTimezonesBulk(unresolvedVenues);
    for (const [venue, tz] of resolved) {
      _venueTzCache.set(venue, tz);
    }
  }

  return batch.map(doc => {
    const inventory = doc.inventory;
    const isResale = inventory?.splitType !== 'NEVERLEAVEONE';

    // Detect GA/Lawn rows — scraper stores synthetic row names like "GA1", "GA2", etc.
    const row = inventory?.row || '';
    const isGALawn = /^GA\d+$/i.test(row);
    // Detect parking-pass rows emitted by the scraper (row === "GA",
    // seatType === "PARKING", productType === "parking"). Treat like GA/Lawn
    // for seatsString clearing so Automatiq doesn't see empty seat data.
    const inventoryAny = inventory as unknown as { seatType?: string; productType?: string };
    const isParking = inventoryAny?.seatType === 'PARKING' || inventoryAny?.productType === 'parking';

    // Apply per-ticket-type markup adjustment on top of already-marked-up listPrice.
    // Formula: adjustedPrice = listPrice * (1 + (defaultPct + adj) / 100) / (1 + defaultPct / 100)
    // Broker resale (tag contains "broker") uses brokerAdj; falls back to resaleAdj if brokerAdj is 0.
    const rawListPrice = inventory?.listPrice || 0;
    const defaultPct = doc.event_default_pct ?? 0;
    const isBroker = isResale && /broker/i.test(inventory?.tags || '');
    const brokerAdj = doc.event_broker_adj ?? 0;
    const resaleAdjVal = doc.event_resale_adj ?? 0;
    const adj = isBroker
      ? (brokerAdj !== 0 ? brokerAdj : resaleAdjVal)
      : isResale ? resaleAdjVal : (doc.event_std_adj ?? 0);
    const adjustedListPrice = defaultPct !== 0 || adj !== 0
      ? rawListPrice * (1 + (defaultPct + adj) / 100) / (1 + defaultPct / 100)
      : rawListPrice;

    // Pre-compute expensive operations with null safety
    // GA/Lawn seats have synthetic seat numbers — clear them so Sync doesn't see fake numbers
    const seatsString = (isGALawn || isParking) ? '' :
      (doc.seats && doc.seats.length > 0 ?
        doc.seats.map((seat: { number: string | number }) => String(seat.number)).join(',') : '');
    const eventDateString = doc.event_date ?
      new Date(doc.event_date).toISOString() : '';

    // In-hand date logic: if event is today or in the past (in venue's timezone),
    // use the event date as in-hand date so Sync doesn't reject it.
    // Otherwise use the stored inHandDate (typically event date - 1 day).
    let inHandDateString = inventory?.inHandDate
      ? new Date(inventory.inHandDate).toISOString().slice(0, 10) : '';
    if (doc.event_date) {
      const eventDateOnly = new Date(doc.event_date).toISOString().slice(0, 10);
      const venueTz = doc.venue_name ? _venueTzCache.get(doc.venue_name) ?? null : null;
      if (venueTz) {
        const nowInVenueTz = getCurrentTimeInTimezone(venueTz);
        const todayInVenueTz = nowInVenueTz.toISOString().slice(0, 10);
        if (eventDateOnly <= todayInVenueTz) {
          inHandDateString = eventDateOnly;
        }
      }
      // No fallback — if timezone can't be detected even with live API, keep the stored inHandDate
    }

    // Calculate split configuration. Passes the DB `customSplit` (written by the
    // scraper from TM's sellableQuantities) as the preferred source for resale.
    const { finalSplitType, customSplit } = calculateSplitConfiguration(
      inventory?.quantity || 0,
      inventory?.splitType,
      inventory?.customSplit,
    );

    // Check if row is SRO and handle public notes accordingly
    const isSRO = row.toUpperCase() === 'SRO';
    const existingPublicNotes = inventory?.publicNotes || '';
    const publicNotes = isSRO
      ? (existingPublicNotes ? `${existingPublicNotes} - STANDING ROOM ONLY` : 'STANDING ROOM ONLY')
      : existingPublicNotes;

    // Tags: GA tickets get GA_STANDARD / GA_RESALE, regular tickets get STANDARD / RESALE.
    // Any extra tags stored on the inventory (anything other than the reserved
    // STANDARD/RESALE/GA_* values) are appended so they survive the export.
    const isStandard = inventory?.splitType === 'NEVERLEAVEONE';
    const baseTag = isParking
      ? ((inventory?.tags || '').toLowerCase().includes('vip') ? 'PARKING_VIP' : 'PARKING')
      : isGALawn
      ? (isStandard ? 'GA_STANDARD' : 'GA_RESALE')
      : (isStandard ? 'STANDARD' : 'RESALE');
    const RESERVED_TAGS = new Set(['STANDARD', 'RESALE', 'GA_STANDARD', 'GA_RESALE', 'PARKING', 'PARKING_VIP', 'PARKING VIP']);
    // Prefer specific inventory tags (e.g. "RESALE BROKER") over the generic base.
    // Tags are emitted uppercased; fall back to the base tag when none are present.
    const extraTags = (inventory?.tags || '')
      .split(',')
      .map(t => t.trim().toUpperCase())
      .filter(t => t.length > 0 && !RESERVED_TAGS.has(t));
    const tags = extraTags.length > 0 ? extraTags.join(',') : baseTag;

    return {
      inventory_id: inventory?.inventoryId || 0,
      event_name: doc.event_name || "",
      venue_name: doc.venue_name || "",
      event_date: eventDateString,
      event_id: doc.mapping_id || "",
      quantity: inventory?.quantity || 0,
      section: inventory?.section || "",
      row: inventory?.row || "",
      seats: seatsString,
      barcodes: inventory?.barcodes || "",
      internal_notes: ALL_TEAMS_LOWER.some(team => (doc.event_name || "").toLowerCase().includes(team))
        ? "-tnow -tmplus -geek"
        : "-tnow -tmplus",
      public_notes: publicNotes,
      tags,
      list_price: Number(adjustedListPrice.toFixed(2)),
      face_price: Number((inventory?.face_price || inventory?.cost || 0).toFixed(2)),
      taxed_cost: Number((inventory?.taxed_cost || inventory?.cost || 0).toFixed(2)),
      cost: Number((inventory?.cost || 0).toFixed(2)),
      hide_seats: inventory?.hideSeatNumbers ? "Y" : "N",
      in_hand: "N", // Always set to "N" as per original code
      in_hand_date: inHandDateString,
      instant_transfer: inventory?.instant_transfer ? "Y" : "N",
      files_available: "N",
      split_type: finalSplitType,
      custom_split: customSplit,
      stock_type:
        (inventory?.stockType as CsvRow["stock_type"]) || "ELECTRONIC",
      zone: "Y",
      shown_quantity: inventory?.shown_quantity || undefined,
      passthrough: inventory?.passthrough || "",
      rowRank: (inventory as unknown as { rowRank?: number | null })?.rowRank ?? null,
      provisionalUntil: (inventory as unknown as { provisionalUntil?: Date | string | null })?.provisionalUntil ?? null,
    } as CsvRow;
  });
}

// CSV cell encoders — one regex pass instead of four .includes() calls per
// cell, and known-safe columns (numbers, Y/N enums, ISO dates) skip the
// escape check entirely. With ~28 columns × N rows the old encoder did
// ~112×N substring scans; this brings it to ~10×N regex tests on the
// columns that can actually contain commas/quotes/newlines.
const CSV_NEEDS_ESCAPE_RE = /[",\r\n]/;

function escapeMaybe(value: unknown): string {
  if (value === null || value === undefined) return '';
  const s = typeof value === 'string' ? value : String(value);
  if (CSV_NEEDS_ESCAPE_RE.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function asNumberOrEmpty(value: unknown): string {
  if (value === null || value === undefined) return '';
  return typeof value === 'number' ? (value as number).toString() : String(value);
}

function asSafeString(value: unknown): string {
  if (value === null || value === undefined) return '';
  return value as string;
}

type ColEncoder = (value: unknown) => string;
const COLUMN_ENCODERS: Array<{ id: keyof CsvRow; encode: ColEncoder }> = [
  { id: 'inventory_id', encode: asNumberOrEmpty },
  { id: 'event_name', encode: escapeMaybe },
  { id: 'venue_name', encode: escapeMaybe },
  { id: 'event_date', encode: asSafeString },
  { id: 'event_id', encode: escapeMaybe },
  { id: 'quantity', encode: asNumberOrEmpty },
  { id: 'section', encode: escapeMaybe },
  { id: 'row', encode: escapeMaybe },
  { id: 'seats', encode: escapeMaybe },
  { id: 'barcodes', encode: escapeMaybe },
  { id: 'internal_notes', encode: escapeMaybe },
  { id: 'public_notes', encode: escapeMaybe },
  { id: 'tags', encode: escapeMaybe },
  { id: 'list_price', encode: asNumberOrEmpty },
  { id: 'face_price', encode: asNumberOrEmpty },
  { id: 'taxed_cost', encode: asNumberOrEmpty },
  { id: 'cost', encode: asNumberOrEmpty },
  { id: 'hide_seats', encode: asSafeString },
  { id: 'in_hand', encode: asSafeString },
  { id: 'in_hand_date', encode: asSafeString },
  { id: 'instant_transfer', encode: asSafeString },
  { id: 'files_available', encode: asSafeString },
  { id: 'split_type', encode: asSafeString },
  { id: 'custom_split', encode: escapeMaybe },
  { id: 'stock_type', encode: asSafeString },
  { id: 'zone', encode: asSafeString },
  { id: 'shown_quantity', encode: asNumberOrEmpty },
  { id: 'passthrough', encode: escapeMaybe },
];
const CSV_HEADER_LINE = csvColumns.map(c => c.title).join(',');

function encodeRow(record: CsvRow): string {
  const cells = new Array<string>(COLUMN_ENCODERS.length);
  for (let i = 0; i < COLUMN_ENCODERS.length; i++) {
    const col = COLUMN_ENCODERS[i];
    cells[i] = col.encode(record[col.id]);
  }
  return cells.join(',');
}

// Build the full CSV in memory for the non-stream path. Single header push,
// per-chunk row encoding, periodic event-loop yields.
async function generateCsvString(records: CsvRow[]): Promise<string> {
  const out: string[] = [CSV_HEADER_LINE];
  const CHUNK_SIZE = 1000;
  for (let i = 0; i < records.length; i += CHUNK_SIZE) {
    const end = Math.min(i + CHUNK_SIZE, records.length);
    const lines = new Array<string>(end - i);
    for (let j = i; j < end; j++) {
      lines[j - i] = encodeRow(records[j]);
    }
    out.push(lines.join('\n'));

    if (i > 0 && (i / CHUNK_SIZE) % 5 === 0) {
      await new Promise(resolve => {
        if (typeof setImmediate !== 'undefined') setImmediate(resolve);
        else setTimeout(resolve, 0);
      });
    }
  }
  return out.join('\n');
}

function recordsToCsvChunk(records: CsvRow[]): string {
  const lines = new Array<string>(records.length);
  for (let i = 0; i < records.length; i++) {
    lines[i] = encodeRow(records[i]);
  }
  return lines.join('\n');
}

// Streaming CSV generator — yields CSV text chunks as they're produced.
// This keeps the HTTP connection alive so reverse proxies don't 504.
export async function* generateInventoryCsvStream(
  eventUpdateFilterMinutes: number = 0
): AsyncGenerator<{ type: 'header' | 'data' | 'done'; text?: string; recordCount?: number; excludedCount?: number; generationTime?: number; error?: string }> {
  await dbConnect();

  const startTime = Date.now();
  _venueTzCache.clear();

  // ── Stop low-seat events before streaming CSV ──
  const lowSeatResult = await stopLowSeatEvents();
  if (lowSeatResult.stopped > 0) {
    console.log(`[CSV-Stream] Pre-export: stopped ${lowSeatResult.stopped} low-seat event(s)`);
  }

  // Load min seat filter setting
  const schedulerSettings = await SchedulerSettings.findOne({}).lean() as any;
  const minSeatFilter = schedulerSettings?.minSeatFilter ?? 0;
  const minSeatFilterMode = schedulerSettings?.minSeatFilterMode ?? 'section';

  try {
    const activeEventQuery: Record<string, any> = { Skip_Scraping: false };
    if (eventUpdateFilterMinutes > 0) {
      const cutoffTime = new Date(Date.now() - eventUpdateFilterMinutes * 60 * 1000);
      activeEventQuery.updatedAt = { $gte: cutoffTime };
    }

    const activeEvents = await Event.find(activeEventQuery, { mapping_id: 1 })
      .read('primary')
      .maxTimeMS(30000);

    if (activeEvents.length === 0) {
      yield { type: 'done', error: eventUpdateFilterMinutes > 0
        ? `No active events updated within the last ${eventUpdateFilterMinutes} minutes.`
        : 'No active events found (all events have Skip_Scraping enabled).' };
      return;
    }

    const eventMappingIds = activeEvents.map(event => event.mapping_id);
    const eventFilter = { mapping_id: { $in: eventMappingIds } };

    const eventDetailsMap = new Map<string, {
      url: string; stdAdj: number; resaleAdj: number; brokerAdj: number; defaultPct: number;
      includeStandard: boolean; includeResale: boolean;
    }>();
    const eventDocs = await Event.find(
      { mapping_id: { $in: eventMappingIds } },
      { mapping_id: 1, URL: 1, standardMarkupAdjustment: 1, resaleMarkupAdjustment: 1,
        brokerMarkupAdjustment: 1, priceIncreasePercentage: 1,
        includeStandardSeats: 1, includeResaleSeats: 1 }
    ).lean();
    for (const ev of eventDocs) {
      eventDetailsMap.set(ev.mapping_id, {
        url: ev.URL || '',
        stdAdj: ev.standardMarkupAdjustment ?? 0,
        resaleAdj: ev.resaleMarkupAdjustment ?? 0,
        brokerAdj: ev.brokerMarkupAdjustment ?? 0,
        defaultPct: ev.priceIncreasePercentage ?? 0,
        includeStandard: ev.includeStandardSeats !== false,
        includeResale: ev.includeResaleSeats !== false,
      });
    }

    const projection = CSV_PROJECTION;

    // Build the per-record exclusion filter once. This used to be re-fetched
    // (Event.find + ExclusionRules.find) inside every chunk iteration; for an
    // export with N chunks that was 2N redundant DB round-trips.
    const exclusionFilter = await buildExclusionFilter(eventMappingIds);
    // Note: the dominated-listings rule needs to compare all rows in an
    // event at once and does NOT apply on the streaming path. It runs on
    // the non-streaming generateInventoryCsv() only. Warn if any events
    // opted in while streaming so operators aren't surprised.
    const dominatedEnabledStreaming = await loadDominatedListingsEnabledSet(eventMappingIds);
    if (dominatedEnabledStreaming.size > 0) {
      console.warn(`[CSV stream] dominated-listings enabled on ${dominatedEnabledStreaming.size} event(s) but streaming path bypasses this rule. Use non-streaming CSV to apply it.`);
    }
    const coverEnabledStreaming = await loadCoverListingsEnabledSet(eventMappingIds);
    if (coverEnabledStreaming.size > 0) {
      console.warn(`[CSV stream] cover-listings enabled on ${coverEnabledStreaming.size} event(s) but streaming path bypasses this rule. Use non-streaming CSV to apply it.`);
    }
    const combinedEnabledStreaming = await loadCombinedListingsEnabledSet(eventMappingIds);
    if (combinedEnabledStreaming.size > 0) {
      console.warn(`[CSV stream] combined-listings enabled on ${combinedEnabledStreaming.size} event(s) but streaming path bypasses this rule. Use non-streaming CSV to apply it.`);
    }

    const CHUNK_SIZE = 10000;
    const idPipeline: PipelineStage[] = [
      { $match: eventFilter },
      { $sort: { _id: 1 as const } },
      { $project: { _id: 1 } },
    ];
    const allIds = await ConsecutiveGroup.aggregate(idPipeline, {
      allowDiskUse: true, maxTimeMS: 60000,
    });
    const totalDocs = allIds.length;

    if (totalDocs === 0) {
      yield { type: 'done', error: 'No inventory data found.' };
      return;
    }

    // Pre-aggregate global section totals in one Mongo pass so the per-chunk
    // min-seat filter sees the whole section instead of just the current chunk.
    // This gives parity with generateInventoryCsv while keeping streaming alive.
    const sectionTotalsMap = new Map<string, number>();
    if (minSeatFilter > 0 && minSeatFilterMode === 'section') {
      const aggStart = Date.now();
      // CsvRow.event_id is populated from doc.mapping_id (see processBatch),
      // so lookups are keyed `${mapping_id}|${section}`. Aggregate by the same
      // field to keep parity with the non-stream path.
      const totals = await ConsecutiveGroup.aggregate(
        [
          { $match: eventFilter },
          {
            $group: {
              _id: { mappingId: '$mapping_id', section: '$inventory.section' },
              total: { $sum: '$inventory.quantity' },
            },
          },
        ] as PipelineStage[],
        { allowDiskUse: true, maxTimeMS: 60000 }
      );
      for (const row of totals) {
        const key = `${row._id.mappingId}|${row._id.section}`;
        sectionTotalsMap.set(key, row.total);
      }
      console.log(`[CSV Stream] Pre-aggregated ${sectionTotalsMap.size} section totals in ${Date.now() - aggStart}ms`);
    }

    // Yield CSV header immediately to keep connection alive
    yield { type: 'header', text: CSV_HEADER_LINE + '\n' };

    let totalRecords = 0;
    let totalExcluded = 0;

    for (let i = 0; i < totalDocs; i += CHUNK_SIZE) {
      const chunkIds = allIds.slice(i, i + CHUNK_SIZE).map((d: { _id: string }) => d._id);

      const chunkDocs: ConsecutiveGroupDocument[] = await ConsecutiveGroup.aggregate(
        [
          { $match: { _id: { $in: chunkIds } } },
          { $project: projection },
        ] as PipelineStage[],
        { allowDiskUse: true, maxTimeMS: 120000 }
      );

      if (chunkDocs.length > 0) {
        const enrichedDocs: ConsecutiveGroupDocument[] = [];
        for (const doc of chunkDocs) {
          const evData = doc.mapping_id ? eventDetailsMap.get(doc.mapping_id) : undefined;
          const isStandard = doc.inventory?.splitType === 'NEVERLEAVEONE';
          if (isStandard && evData && !evData.includeStandard) continue;
          if (!isStandard && evData && !evData.includeResale) continue;
          doc.event_url = evData?.url || '';
          doc.event_std_adj = evData?.stdAdj ?? 0;
          doc.event_resale_adj = evData?.resaleAdj ?? 0;
          doc.event_broker_adj = evData?.brokerAdj ?? 0;
          doc.event_default_pct = evData?.defaultPct ?? 0;
          enrichedDocs.push(doc);
        }

        if (enrichedDocs.length > 0) {
          const processedBatch = await processBatch(enrichedDocs);
          const beforeBatchFilters = processedBatch.length;
          // Single-pass filter: blocked states + exclusion rules + min-seat.
          // Avoids walking the batch three times and the per-chunk DB query
          // that the old applyExclusionRules() was doing.
          const filtered: CsvRow[] = [];
          for (const r of processedBatch) {
            if (isBlockedVenueState(r)) continue;
            if (isStandardHoldActive(r)) continue;
            if (!exclusionFilter(r)) continue;
            if (minSeatFilter > 0) {
              if (minSeatFilterMode === 'section') {
                if ((sectionTotalsMap.get(`${r.event_id}|${r.section}`) ?? 0) <= minSeatFilter) continue;
              } else if (r.quantity <= minSeatFilter) {
                continue;
              }
            }
            filtered.push(r);
          }
          totalExcluded += beforeBatchFilters - filtered.length;

          if (filtered.length > 0) {
            totalRecords += filtered.length;
            yield { type: 'data', text: recordsToCsvChunk(filtered) + '\n' };
          }
        }
      }

      // Yield control between chunks
      await new Promise(resolve => (typeof setImmediate !== 'undefined' ? setImmediate : setTimeout)(resolve, 0));
    }

    const duration = Date.now() - startTime;
    console.log(`[CSV Stream] Completed in ${duration}ms: ${totalRecords} records, ${totalExcluded} excluded`);

    if (totalRecords === 0) {
      yield { type: 'done', error: 'No inventory data found after applying exclusion rules.' };
      return;
    }

    yield { type: 'done', recordCount: totalRecords, excludedCount: totalExcluded, generationTime: duration };
  } catch (error) {
    console.error('[CSV Stream] Error:', error);
    await createErrorLog({
      eventUrl: 'CSV_GENERATION_STREAM',
      errorType: 'DATABASE_ERROR',
      message: error instanceof Error ? error.message : 'Unknown error',
      stack: error instanceof Error ? error.stack : undefined,
      metadata: { operation: 'generateInventoryCsvStream', timestamp: new Date() }
    });
    yield { type: 'done', error: 'Failed to generate CSV.' };
  }
}

export async function uploadCsvToSyncService(csvContent: string): Promise<{ success: boolean; message: string; uploadId?: string }> {
  return withRetry(async () => {
    try {
      // Get sync service credentials from environment variables
      const companyId = process.env.SYNC_COMPANY_ID;
      const apiToken = process.env.SYNC_API_TOKEN;
      
      if (!companyId || !apiToken) {
        throw new Error('Sync service credentials not configured. Please set SYNC_COMPANY_ID and SYNC_API_TOKEN environment variables.');
      }
      
      // Validate CSV content — reject anything with zero data rows (including
      // header-only uploads). A CSV with just the header is "blank" from the
      // receiver's perspective and must never be pushed to sync.
      if (!csvContent || csvContent.trim().length === 0) {
        throw new Error('CSV content is empty or invalid');
      }
      const nonEmptyLines = csvContent.split('\n').filter(l => l.trim().length > 0);
      if (nonEmptyLines.length <= 1) {
        throw new Error(`Refusing to upload blank CSV (${nonEmptyLines.length} line${nonEmptyLines.length === 1 ? '' : 's'} — header only, no data rows).`);
      }
      
      // Initialize sync service
      const syncService = new SyncService(companyId, apiToken);
      
      // Upload CSV content to sync service with timeout
      const uploadPromise = syncService.uploadCsvContentToSync(csvContent);
      const timeoutPromise = new Promise((_, reject) => {
        setTimeout(() => reject(new Error('Upload timeout after 180 seconds')), 180000);
      });
      // eslint-disable-next-line @typescript-eslint/ban-ts-comment
      const result = await Promise.race([uploadPromise, timeoutPromise]) as any;
      
      // Log detailed server response for debugging
      console.log('=== SERVER UPLOAD RESPONSE ===');
      console.log('Full server response:', JSON.stringify(result, null, 2));
      console.log('Response type:', typeof result);
      console.log('Response keys:', Object.keys(result || {}));
      console.log('==============================');
      
      if ('success' in result && result.success) {
        // Update database with upload status
        await updateSchedulerSettings({
          lastUploadAt: new Date(),
          lastUploadStatus: 'success',
          lastUploadId: (result as { uploadId?: string })?.uploadId
        });
        
        console.log('✅ CSV content uploaded to sync service successfully');
        console.log('Upload ID:', (result as { uploadId?: string })?.uploadId);
        
        return {
          success: true,
          message: 'CSV uploaded to sync service successfully',
          uploadId: (result as { uploadId?: string }).uploadId
        };
      } else {
        console.log('❌ Upload failed - Server response indicates failure');
        console.log('Error message from server:', (result as { message?: string })?.message);
        throw new Error((result as { message?: string }).message || 'Upload failed');
      }
    } catch (error) {
      console.error('Error uploading to sync service:', error);
      
      // Update database with error status
      try {
        await updateSchedulerSettings({
          lastUploadAt: new Date(),
          lastUploadStatus: 'failed',
          lastUploadError: error instanceof Error ? error.message : 'Unknown error occurred'
        });
      } catch (dbError) {
        console.error('Error updating database with upload status:', dbError);
      }
      
      throw error; // Re-throw for retry mechanism
    }
  }, 'CSV Upload', {
    maxRetries: 5, // More retries for upload
    baseDelay: 2000, // Longer delay for network operations
    maxDelay: 30000
  }).catch(error => {
    return {
      success: false,
      message: `Failed to upload CSV to sync service after retries: ${error instanceof Error ? error.message : 'Unknown error'}`
    };
  });
}

export async function deleteInventoryBatchFromSync(inventoryIds: string[]): Promise<{ success: boolean; message: string; successful: string[]; failed: string[] }> {
  try {
    // Get sync service credentials from environment variables
    const companyId = process.env.SYNC_COMPANY_ID;
    const apiToken = process.env.SYNC_API_TOKEN;
    
    if (!companyId || !apiToken) {
      throw new Error('Sync service credentials not configured. Please set SYNC_COMPANY_ID and SYNC_API_TOKEN environment variables.');
    }
    
    if (!inventoryIds || inventoryIds.length === 0) {
      return {
        success: true,
        message: 'No inventory IDs provided for deletion',
        successful: [],
        failed: []
      };
    }
    
    // Initialize sync service
    const syncService = new SyncService(companyId, apiToken);
    
    // Delete specific inventory items
    const result = await syncService.deleteInventoryBatch(inventoryIds);
    
    console.log('Raw sync service response:', JSON.stringify(result, null, 2));
    
    // Check the actual deletion count from the response
    const deletedCount = (result as { deleted?: number })?.deleted ?? 0;
    const totalRequested = inventoryIds.length;
    
    console.log(`Sync service deletion summary: ${deletedCount}/${totalRequested} items deleted`);
    
    if (deletedCount === 0) {
      console.warn('⚠️  No items were deleted from sync service. This could mean:');
      console.warn('   - Inventory IDs do not exist in sync service');
      console.warn('   - Items were already deleted');
      console.warn('   - API endpoint format issue');
    }
    
    // If we get here without an error, sync service reported success
    // Check common success indicators or assume success if no error was thrown
    const isSuccess = ('success' in result && result.success) || 
                      ('status' in result && result.status === 'success') ||
                      ('error' in result && !result.error) ||
                      !('error' in result); // If no explicit error field, assume success
    
    if (isSuccess) {
      const actuallyDeleted = (result as { deleted?: number })?.deleted ?? 0;
      console.log(`Successfully processed deletion request: ${actuallyDeleted}/${inventoryIds.length} inventory items deleted from sync service`);
      
      return {
        success: true,
        message: `Successfully processed deletion request: ${actuallyDeleted}/${inventoryIds.length} inventory items deleted from sync service`,
        successful: actuallyDeleted > 0 ? inventoryIds.slice(0, actuallyDeleted) : [],
        failed: actuallyDeleted < inventoryIds.length ? inventoryIds.slice(actuallyDeleted) : []
      };
    } else {
      throw new Error((result as { message?: string })?.message || 'Batch inventory deletion failed');
    }
  } catch (error) {
    console.error('Error deleting inventory batch from sync service:', error);
    
    return {
      success: false,
      message: `Failed to delete inventory batch from sync service: ${error instanceof Error ? error.message : 'Unknown error'}`,
      successful: [],
      failed: inventoryIds
    };
  }
}

// Database settings functions
export async function getSchedulerSettings() {
  await dbConnect();
  try {
    return await SchedulerSettings.findOne({}) || await SchedulerSettings.create({});
  } catch (error) {
    console.error('Error getting scheduler settings:', error);
    throw error;
  }
}

export async function updateSchedulerSettings(updates: {
  lastUploadAt?: Date;
  lastUploadStatus?: 'success' | 'failed' | 'cleared' | 'clear_failed';
  lastUploadId?: string;
  lastUploadError?: string;
  lastClearAt?: Date;
  scheduleRateMinutes?: number;
  uploadToSync?: boolean;
  isScheduled?: boolean;
  eventUpdateFilterMinutes?: number;
  nextRunAt?: Date;
  totalRuns?: number;
  lowSeatAutoStop?: boolean;
  lowSeatThreshold?: number;
}) {
  await dbConnect();
  try {
    return await SchedulerSettings.findOneAndUpdate({}, updates, { new: true, upsert: true });
  } catch (error) {
    console.error('Error updating scheduler settings:', error);
    throw error;
  }
}

// Auto-Delete Settings functions
export async function getAutoDeleteSettings() {
  await dbConnect();
  try {
    const settings = await AutoDeleteSettings.findOne().lean();
    if (!settings) {
      const created = await AutoDeleteSettings.create({
        isEnabled: false,
        stopBeforeMinutes: 120,
        scheduleIntervalMinutes: 15
      });
      return JSON.parse(JSON.stringify(created));
    }
    return JSON.parse(JSON.stringify(settings));
  } catch (error) {
    console.error('Error getting auto-delete settings:', error);
    throw error;
  }
}

export async function updateAutoDeleteSettings(updates: {
  isEnabled?: boolean;
  stopBeforeMinutes?: number;
  scheduleIntervalMinutes?: number;
  postEventDeleteEnabled?: boolean;
  postEventDeleteHoursAfter?: number;
  lastRunAt?: Date;
  nextRunAt?: Date;
  totalRuns?: number;
  totalEventsDeleted?: number;
  lastRunStats?: {
    eventsChecked: number;
    eventsDeleted: number;
    eventsStopped: number;
    deletedEventIds: string[];
    errors: string[];
  };
}) {
  await dbConnect();
  try {
    const result = await AutoDeleteSettings.findOneAndUpdate(
      {},
      { ...updates, updatedAt: new Date() },
      { new: true, upsert: true }
    ).lean();
    return JSON.parse(JSON.stringify(result));
  } catch (error) {
    console.error('Error updating auto-delete settings:', error);
    throw error;
  }
}

// Auto-Delete Functions
export async function runAutoDelete() {
  try {
    const settings = await getAutoDeleteSettings();
    if (!settings.isEnabled) {
      return {
        success: false,
        message: 'Auto-delete is disabled'
      };
    }

    const stats = await deleteExpiredEvents(settings.stopBeforeMinutes ?? 120, settings.lowSeatThreshold ?? 20);

    // Post-event hard-delete: permanently remove events N hours after they pass
    let postDeleteMsg = '';
    if (settings.postEventDeleteEnabled) {
      const hours = settings.postEventDeleteHoursAfter ?? 12;
      const postStats = await deletePassedEvents(hours);
      if (postStats.deleted > 0) {
        postDeleteMsg = ` Permanently deleted ${postStats.deleted} past event${postStats.deleted > 1 ? 's' : ''} (${hours}h after event date).`;
      }
    }

    // Update settings with run statistics
    const intervalMinutes = settings.scheduleIntervalMinutes || 15;
    const nextRunDate = new Date(Date.now() + intervalMinutes * 60 * 1000);
    await updateAutoDeleteSettings({
      lastRunAt: new Date(),
      ...(isNaN(nextRunDate.getTime()) ? {} : { nextRunAt: nextRunDate }),
      totalRuns: (settings.totalRuns || 0) + 1,
      totalEventsDeleted: settings.totalEventsDeleted + stats.eventsDeleted + stats.lowSeatStopped,
      lastRunStats: {
        eventsChecked: stats.totalEventsChecked,
        eventsDeleted: stats.eventsDeleted,
        eventsStopped: stats.eventsStopped,
        deletedEventIds: stats.deletedEventIds,
        errors: stats.errors
      }
    });

    const lowMsg = stats.lowSeatStopped > 0 ? ` Low-seat stopped: ${stats.lowSeatStopped}.` : '';
    return {
      success: true,
      message: `Auto-delete completed. Stopped ${stats.eventsStopped} events and cleared inventory for ${stats.eventsDeleted} events.${lowMsg}${postDeleteMsg}`,
      stats
    };
  } catch (error) {
    console.error('Error running auto-delete:', error);
    return {
      success: false,
      message: `Auto-delete failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
      error: error instanceof Error ? error.message : 'Unknown error'
    };
  }
}

export async function getAutoDeletePreview(stopBeforeMinutes?: number) {
  try {
    const settings = await getAutoDeleteSettings();
    const minutes = stopBeforeMinutes ?? settings.stopBeforeMinutes ?? 120;
    const preview = await getExpiredEventsStats(minutes);

    return {
      ...preview,
      stopBeforeMinutes: minutes
    };
  } catch (error) {
    console.error('Error getting auto-delete preview:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
      count: 0,
      events: []
    };
  }
}
