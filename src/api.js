/**
 * The HTTP API, shared by both ways of running this.
 *
 * `server.js` runs it inside a long-lived Node server on your own machine;
 * `api/index.js` runs the very same routes inside a Vercel function. The only
 * differences are handed in through `ctx`: which store to use, and whether the
 * process is alive long enough to hold a Server-Sent Events stream open.
 */

import { parseCsv, toCsv } from './csv.js';
import { looksLikeXlsx, parseXlsx } from './xlsx.js';
import { formatTimestamp, normalizeParsed } from './normalize.js';
import { buildReport } from './report.js';

const MAX_BODY_BYTES = 32 * 1024 * 1024; // a year of exports is about a megabyte

/** An error the client caused, so it gets a 4xx instead of a 500. */
export class ClientError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

export function sendJson(res, status, body) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(JSON.stringify(body));
}

export function readBody(req) {
  return new Promise((resolvePromise, rejectPromise) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        rejectPromise(new ClientError('Request body too large.', 413));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolvePromise(Buffer.concat(chunks).toString('utf8')));
    req.on('error', rejectPromise);
  });
}

export async function readJsonBody(req) {
  // A Vercel function may have parsed the body already.
  if (req.body !== undefined && req.body !== null) {
    if (typeof req.body === 'object') return req.body;
    if (typeof req.body === 'string') {
      if (!req.body.trim()) return {};
      try {
        return JSON.parse(req.body);
      } catch {
        throw new ClientError('Request body was not valid JSON.');
      }
    }
  }
  const text = await readBody(req);
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new ClientError('Request body was not valid JSON.');
  }
}

/**
 * Parse one uploaded file — CSV text or .xlsx bytes — and merge it into the store.
 * @param {{filename: string, text?: string, bytes?: Uint8Array, format?: string, source?: string}} input
 */
export async function importFile({ filename, text, bytes, format, source = 'upload', store }) {
  let parsed;
  if (bytes && looksLikeXlsx(bytes)) {
    parsed = await parseXlsx(bytes);
  } else {
    const asText = text ?? Buffer.from(bytes ?? []).toString('utf8');
    parsed = parseCsv(asText);
  }
  if (parsed.headers.length === 0) throw new Error(`${filename}: file is empty.`);

  const { kind: detected, format: detectedFormat, records } = normalizeParsed(parsed, format);
  const result = store.upsert(detected, records);

  const entry = {
    filename,
    kind: detected,
    format: detectedFormat,
    source,
    rows: records.length,
    added: result.added,
    updated: result.updated,
    replaced: result.replaced,
    at: new Date().toISOString(),
  };
  store.recordImport(entry);
  await store.save(`import:${detected}`);
  return entry;
}

export function reportToCsv(report) {
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

export async function handleApi(req, res, url, ctx) {
  const { pathname } = url;
  const { store, realtime } = ctx;

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
      const hasText = file && typeof file.text === 'string';
      const hasBytes = file && typeof file.base64 === 'string';
      if (!hasText && !hasBytes) {
        errors.push({ filename: file?.filename ?? '(unnamed)', error: 'No file contents received.' });
        continue;
      }
      try {
        results.push(
          await importFile({
            filename: file.filename || 'upload.csv',
            text: hasText ? file.text : undefined,
            bytes: hasBytes ? new Uint8Array(Buffer.from(file.base64, 'base64')) : undefined,
            format: file.format || undefined,
            store,
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
    await store.save('link');
    return sendJson(res, 200, { ok: true });
  }

  if (pathname === '/api/unlink' && req.method === 'POST') {
    const { purchaseId, chargeId } = await readJsonBody(req);
    if (purchaseId) store.unlinkPurchase(purchaseId);
    if (chargeId) store.unlinkCharge(chargeId);
    await store.save('unlink');
    return sendJson(res, 200, { ok: true });
  }

  if (pathname === '/api/ignore' && req.method === 'POST') {
    const { kind, id, ignored = true } = await readJsonBody(req);
    if (kind !== 'purchase' && kind !== 'charge') {
      return sendJson(res, 400, { error: 'kind must be "purchase" or "charge".' });
    }
    if (!id) return sendJson(res, 400, { error: 'id is required.' });
    store.setIgnored(kind, id, Boolean(ignored));
    await store.save('ignore');
    return sendJson(res, 200, { ok: true });
  }

  if (pathname === '/api/settings' && req.method === 'POST') {
    const patch = await readJsonBody(req);
    const settings = store.updateSettings(patch);
    await store.save('settings');
    return sendJson(res, 200, { settings });
  }

  if (pathname === '/api/reset' && req.method === 'POST') {
    store.clearData();
    await store.save('reset');
    return sendJson(res, 200, { ok: true });
  }

  if (pathname === '/api/stream' && req.method === 'GET') {
    // Only the always-on local server can hold a stream open; a serverless
    // function is billed by the second and would be cut off mid-connection.
    if (!realtime) return sendJson(res, 501, { error: 'Live updates are not available on this deployment.' });
    return ctx.handleStream(req, res);
  }

  return sendJson(res, 404, { error: `No route for ${req.method} ${pathname}` });
}
