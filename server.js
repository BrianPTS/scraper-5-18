#!/usr/bin/env node
/**
 * Ticket Reconciler — zero-dependency HTTP server.
 *
 *   node server.js            # http://localhost:4173
 *   PORT=8080 node server.js
 *
 * Serves the dashboard, accepts CSV imports (drag-and-drop or the watched
 * ./inbox folder), and pushes live updates over Server-Sent Events.
 */

import { createReadStream, existsSync, mkdirSync, watch } from 'node:fs';
import { readFile, readdir, rename, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseCsv, toCsv } from './src/csv.js';
import { formatTimestamp, normalizeParsed } from './src/normalize.js';
import { buildReport } from './src/report.js';
import { Store, defaultStorePath } from './src/store.js';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const PUBLIC_DIR = join(ROOT, 'public');
const INBOX_DIR = process.env.INBOX_DIR ? resolve(process.env.INBOX_DIR) : join(ROOT, 'inbox');
const PROCESSED_DIR = join(INBOX_DIR, 'processed');
const PORT = Number(process.env.PORT) || 4173;
const HOST = process.env.HOST || '127.0.0.1';
const MAX_BODY_BYTES = 32 * 1024 * 1024; // generous: a year of exports is ~1MB

const store = new Store(process.env.STORE_FILE || defaultStorePath(ROOT));

/** @type {Set<import('node:http').ServerResponse>} */
const sseClients = new Set();

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

// ---------------------------------------------------------------------------
// Import pipeline
// ---------------------------------------------------------------------------

/**
 * Parse one CSV payload and merge it into the store.
 * @param {{filename: string, text: string, kind?: 'purchases'|'charges', source?: string}} input
 */
function importCsv({ filename, text, kind, source = 'upload' }) {
  const parsed = parseCsv(text);
  if (parsed.headers.length === 0) throw new Error(`${filename}: file is empty.`);

  const { kind: detected, records } = normalizeParsed(parsed, kind);
  const result = store.upsert(detected, records);

  const entry = {
    filename,
    kind: detected,
    source,
    rows: records.length,
    added: result.added,
    updated: result.updated,
    at: new Date().toISOString(),
  };
  store.recordImport(entry);
  store.save(`import:${detected}`);
  return entry;
}

// ---------------------------------------------------------------------------
// Watched inbox — drop today's exports in ./inbox and they load themselves
// ---------------------------------------------------------------------------

const inboxSeen = new Map();

async function scanInbox() {
  if (!existsSync(INBOX_DIR)) return;
  let entries;
  try {
    entries = await readdir(INBOX_DIR, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (extname(entry.name).toLowerCase() !== '.csv') continue;

    const full = join(INBOX_DIR, entry.name);
    let info;
    try {
      info = await stat(full);
    } catch {
      continue;
    }

    // Wait for the file to stop growing before reading it — a large export
    // copied into the folder can otherwise be picked up half-written.
    const prev = inboxSeen.get(full);
    if (!prev || prev.size !== info.size || prev.mtimeMs !== info.mtimeMs) {
      inboxSeen.set(full, { size: info.size, mtimeMs: info.mtimeMs });
      continue;
    }

    try {
      const text = await readFile(full, 'utf8');
      const entryLog = importCsv({ filename: entry.name, text, source: 'inbox' });
      mkdirSync(PROCESSED_DIR, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      await rename(full, join(PROCESSED_DIR, `${stamp}__${entry.name}`));
      console.log(
        `[inbox] imported ${entry.name} (${entryLog.kind}: +${entryLog.added} new, ${entryLog.updated} updated)`,
      );
    } catch (err) {
      console.error(`[inbox] ${entry.name}: ${err.message}`);
    } finally {
      inboxSeen.delete(full);
    }
  }
}

function startInboxWatcher() {
  mkdirSync(INBOX_DIR, { recursive: true });
  let timer = null;
  const kick = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => scanInbox().catch(() => {}), 400);
    timer.unref?.();
  };
  try {
    watch(INBOX_DIR, kick).unref?.();
  } catch {
    // Some filesystems (network mounts, containers) do not support watch;
    // the interval below keeps the folder working anyway.
  }
  setInterval(() => scanInbox().catch(() => {}), 5000).unref?.();
  scanInbox().catch(() => {});
}

// ---------------------------------------------------------------------------
// HTTP plumbing
// ---------------------------------------------------------------------------

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolvePromise, rejectPromise) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        rejectPromise(new Error('Request body too large.'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolvePromise(Buffer.concat(chunks).toString('utf8')));
    req.on('error', rejectPromise);
  });
}

/** An error the client caused, so it gets a 4xx instead of a 500. */
class ClientError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

async function readJsonBody(req) {
  const text = await readBody(req);
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new ClientError('Request body was not valid JSON.');
  }
}

async function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const target = normalize(join(PUBLIC_DIR, rel));
  // Path traversal guard: the resolved path must stay inside public/.
  if (target !== PUBLIC_DIR && !target.startsWith(PUBLIC_DIR + sep)) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  if (!existsSync(target)) {
    res.writeHead(404, { 'content-type': 'text/plain' }).end('Not found');
    return;
  }
  res.writeHead(200, {
    'content-type': MIME[extname(target).toLowerCase()] || 'application/octet-stream',
    'cache-control': 'no-cache',
  });
  createReadStream(target).pipe(res);
}

function handleStream(req, res) {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
  res.write(`event: hello\ndata: ${JSON.stringify({ at: new Date().toISOString() })}\n\n`);
  sseClients.add(res);

  // Comment frames keep proxies from closing an idle connection.
  const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
  ping.unref?.();

  req.on('close', () => {
    clearInterval(ping);
    sseClients.delete(res);
  });
}

function broadcast(event) {
  const frame = `event: update\ndata: ${JSON.stringify(event)}\n\n`;
  for (const client of sseClients) {
    try {
      client.write(frame);
    } catch {
      sseClients.delete(client);
    }
  }
}

function reportToCsv(report) {
  const headers = [
    'status',
    'confidence',
    'purchase_id',
    'po_id',
    'purchased_at',
    'account',
    'event',
    'venue',
    'seats',
    'qty',
    'purchase_amount',
    'purchase_last4',
    'charge_id',
    'charge_at',
    'charge_description',
    'charge_card_name',
    'charge_last4',
    'charge_amount',
    'charge_status',
    'amount_diff',
    'delta_minutes',
    'note',
  ];

  const rows = [];
  for (const m of report.matches) {
    rows.push([
      'matched',
      m.confidence + (m.ambiguous ? ' (ambiguous)' : ''),
      m.purchase.id,
      m.purchase.poId,
      formatTimestamp(m.purchase.purchasedAt),
      m.purchase.account,
      m.purchase.event,
      m.purchase.venue,
      m.purchase.seats,
      m.purchase.qty,
      m.purchase.amount.toFixed(2),
      m.purchase.last4,
      m.charge.id,
      formatTimestamp(m.charge.occurredAt),
      m.charge.description,
      m.charge.cardName,
      m.charge.last4,
      m.charge.amount.toFixed(2),
      m.charge.status,
      m.amountDiff.toFixed(2),
      m.deltaMinutes === null ? '' : m.deltaMinutes.toFixed(1),
      m.note,
    ]);
  }
  for (const p of report.unmatchedPurchases) {
    rows.push([
      'purchase_without_charge',
      '',
      p.id,
      p.poId,
      formatTimestamp(p.purchasedAt),
      p.account,
      p.event,
      p.venue,
      p.seats,
      p.qty,
      p.amount.toFixed(2),
      p.last4,
      '', '', '', '', '', '', '', '', '',
      p.reason,
    ]);
  }
  for (const c of report.unmatchedCharges) {
    rows.push([
      'charge_without_purchase',
      '',
      '', '', '', '', '', '', '', '', '', '',
      c.id,
      formatTimestamp(c.occurredAt),
      c.description,
      c.cardName,
      c.last4,
      c.amount.toFixed(2),
      c.status,
      '',
      '',
      c.reason,
    ]);
  }
  for (const c of [...report.declines, ...report.reversals]) {
    rows.push([
      c.type === 'card_decline' ? 'declined' : 'reversed',
      '',
      '', '', '', '', '', '', '', '', '', '',
      c.id,
      formatTimestamp(c.occurredAt),
      c.description,
      c.cardName,
      c.last4,
      c.amount.toFixed(2),
      c.status,
      '',
      '',
      c.declineReason,
    ]);
  }

  return toCsv(headers, rows);
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

async function handleApi(req, res, url) {
  const { pathname } = url;

  if (pathname === '/api/report' && req.method === 'GET') {
    return sendJson(res, 200, buildReport(store, { day: url.searchParams.get('day') }));
  }

  if (pathname === '/api/export' && req.method === 'GET') {
    const report = buildReport(store, { day: url.searchParams.get('day') });
    const csv = reportToCsv(report);
    res.writeHead(200, {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="reconciliation-${report.day}.csv"`,
    });
    return res.end(csv);
  }

  if (pathname === '/api/import' && req.method === 'POST') {
    const body = await readJsonBody(req);
    const files = Array.isArray(body.files) ? body.files : [body];
    const results = [];
    const errors = [];
    for (const file of files) {
      if (!file || typeof file.text !== 'string') {
        errors.push({ filename: file?.filename ?? '(unnamed)', error: 'No file contents received.' });
        continue;
      }
      try {
        results.push(
          importCsv({
            filename: file.filename || 'upload.csv',
            text: file.text,
            kind: file.kind || undefined,
          }),
        );
      } catch (err) {
        errors.push({ filename: file.filename ?? '(unnamed)', error: err.message });
      }
    }
    return sendJson(res, errors.length && !results.length ? 400 : 200, { imported: results, errors });
  }

  if (pathname === '/api/link' && req.method === 'POST') {
    const { purchaseId, chargeId, note } = await readJsonBody(req);
    if (!purchaseId || !chargeId) return sendJson(res, 400, { error: 'purchaseId and chargeId are required.' });
    if (!store.data.purchases[purchaseId]) return sendJson(res, 404, { error: 'Unknown purchase.' });
    if (!store.data.charges[chargeId]) return sendJson(res, 404, { error: 'Unknown charge.' });
    store.link(purchaseId, chargeId, note ?? '');
    store.save('link');
    return sendJson(res, 200, { ok: true });
  }

  if (pathname === '/api/unlink' && req.method === 'POST') {
    const { purchaseId, chargeId } = await readJsonBody(req);
    if (purchaseId) store.unlinkPurchase(purchaseId);
    if (chargeId) store.unlinkCharge(chargeId);
    store.save('unlink');
    return sendJson(res, 200, { ok: true });
  }

  if (pathname === '/api/ignore' && req.method === 'POST') {
    const { kind, id, ignored = true } = await readJsonBody(req);
    if (kind !== 'purchase' && kind !== 'charge') {
      return sendJson(res, 400, { error: 'kind must be "purchase" or "charge".' });
    }
    if (!id) return sendJson(res, 400, { error: 'id is required.' });
    store.setIgnored(kind, id, Boolean(ignored));
    store.save('ignore');
    return sendJson(res, 200, { ok: true });
  }

  if (pathname === '/api/settings' && req.method === 'POST') {
    const patch = await readJsonBody(req);
    const settings = store.updateSettings(patch);
    store.save('settings');
    return sendJson(res, 200, { settings });
  }

  if (pathname === '/api/reset' && req.method === 'POST') {
    store.clearData();
    store.save('reset');
    return sendJson(res, 200, { ok: true });
  }

  if (pathname === '/api/stream' && req.method === 'GET') {
    return handleStream(req, res);
  }

  return sendJson(res, 404, { error: `No route for ${req.method} ${pathname}` });
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    if (url.pathname.startsWith('/api/')) {
      await handleApi(req, res, url);
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405).end('Method not allowed');
      return;
    }
    await serveStatic(req, res, url.pathname);
  } catch (err) {
    const status = err instanceof ClientError ? err.status : 500;
    if (status === 500) console.error('[http]', err);
    if (!res.headersSent) sendJson(res, status, { error: err.message });
    else res.end();
  }
});

async function main() {
  await store.load();
  store.onChange((event) => broadcast(event));
  startInboxWatcher();

  server.listen(PORT, HOST, () => {
    const counts = `${store.purchases().length} purchases, ${store.charges().length} charges`;
    const bound = server.address();
    console.log(`\n  Ticket Reconciler  →  http://${HOST}:${bound.port}`);
    console.log(`  Store: ${store.file} (${counts})`);
    console.log(`  Inbox: drop CSV exports in ${INBOX_DIR} and they import automatically\n`);
  });
}

const shutdown = async () => {
  await store.flush().catch(() => {});
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref?.();
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
