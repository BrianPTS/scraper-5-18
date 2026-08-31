/**
 * End-to-end tests.
 *
 * The first half runs the committed sample exports through the real pipeline
 * (parse → normalize → reconcile) and pins the expected buckets, so a change in
 * matching behaviour has to be deliberate.
 *
 * The second half boots the actual HTTP server on an ephemeral port and drives
 * it the way the browser does: import, report, link, unlink, export.
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';

import { parseCsv } from '../src/csv.js';
import { normalizeParsed } from '../src/normalize.js';
import { reconcile } from '../src/match.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SAMPLES = join(ROOT, 'samples');

async function loadSamples() {
  const purchases = normalizeParsed(parseCsv(await readFile(join(SAMPLES, 'sample-purchases.csv'), 'utf8')));
  const charges = normalizeParsed(parseCsv(await readFile(join(SAMPLES, 'sample-transactions.csv'), 'utf8')));
  return { purchases, charges };
}

test('sample files are detected without being told what they are', async () => {
  const { purchases, charges } = await loadSamples();
  assert.equal(purchases.kind, 'purchases');
  assert.equal(charges.kind, 'charges');
  assert.equal(purchases.records.length, 10);
  assert.equal(charges.records.length, 12);
});

test('the sample day reconciles into exactly the expected buckets', async () => {
  const { purchases, charges } = await loadSamples();
  const report = reconcile({ purchases: purchases.records, charges: charges.records });

  const matched = report.matches.map((m) => `${m.purchase.id}->${m.charge.id}`).sort();
  assert.deepEqual(matched, [
    '1001->tx_sample_01', // same card, 3 seconds apart
    '1002->tx_sample_02',
    '1004->tx_sample_04', // hard stock: no last-four on the purchase side
    '1006->tx_sample_06', // settlement matched via its authorization time
    '1009->tx_sample_08', // SeatGeek settlement, no last-four on file
    '1010->tx_sample_09',
  ]);

  // 1003 never reached the card; 1005 was declined; 1008 was reversed.
  assert.deepEqual(report.unmatchedPurchases.map((p) => p.id).sort(), ['1003', '1005', '1008']);
  assert.match(report.unmatchedPurchases.find((p) => p.id === '1005').reason, /DECLINED/);
  assert.match(report.unmatchedPurchases.find((p) => p.id === '1008').reason, /reversed/);

  // tx_sample_03 is the same amount as 1001 but on a different card, so it must
  // not be consumed by it.
  assert.deepEqual(report.unmatchedCharges.map((c) => c.id).sort(), [
    'tx_sample_03',
    'tx_sample_10',
    'tx_sample_11',
  ]);

  assert.deepEqual(report.zeroAmountPurchases.map((p) => p.id), ['1007']);
  assert.deepEqual(report.declines.map((c) => c.id), ['tx_sample_05']);
  assert.deepEqual(report.reversals.map((c) => c.id), ['tx_sample_07']);
  assert.deepEqual(report.credits.map((c) => c.id), ['tx_sample_12']);

  assert.equal(report.totals.matchedVariance, 0);
  // 205.89 + 117.00 + 349.87 + 609.90 + 265.28 + 142.80
  assert.equal(report.totals.matchedPurchaseTotal, 1690.74);
  assert.equal(report.totals.needsReviewCount, 0);
});

test('re-importing the same file twice does not double anything', async () => {
  const { purchases, charges } = await loadSamples();
  const doubled = reconcile({
    purchases: [...purchases.records, ...purchases.records],
    charges: charges.records,
  });
  // The store dedupes by id, so the matcher only ever sees one copy; this test
  // documents what happens if it somehow does not: the second copy stays
  // unmatched rather than double-spending a charge.
  assert.equal(doubled.matches.length, 6);
});

// ---------------------------------------------------------------------------
// HTTP surface
// ---------------------------------------------------------------------------

let child;
let baseUrl;
let workDir;

before(async () => {
  workDir = await mkdtemp(join(tmpdir(), 'reconciler-test-'));
  child = spawn(process.execPath, [join(ROOT, 'server.js')], {
    env: {
      ...process.env,
      PORT: '0',
      STORE_FILE: join(workDir, 'store.json'),
      INBOX_DIR: join(workDir, 'inbox'),
      // Say which mode this server is under test in, rather than inheriting
      // whatever the checkout happens to declare — the deploy branch declares
      // password mode, and these tests are about the open local server.
      ACCESS_MODE: '',
      SECRETS_FILE: join(workDir, 'no-secrets.json'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  baseUrl = await new Promise((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => rejectPromise(new Error('server did not start in time')), 10_000);
    let buffer = '';
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      const match = buffer.match(/http:\/\/[\d.]+:(\d+)/);
      if (match) {
        clearTimeout(timer);
        resolvePromise(match[0]);
      }
    });
    child.stderr.on('data', (chunk) => process.stderr.write(chunk));
    child.on('exit', (code) => rejectPromise(new Error(`server exited early with code ${code}`)));
  });
});

after(async () => {
  child?.kill('SIGTERM');
  if (workDir) await rm(workDir, { recursive: true, force: true });
});

const api = async (path, init) => {
  const res = await fetch(`${baseUrl}${path}`, init);
  return { status: res.status, body: await res.json() };
};

const postJson = (path, body) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

test('serves an empty report before anything is imported', async () => {
  const { status, body } = await api('/api/report');
  assert.equal(status, 200);
  assert.equal(body.matches.length, 0);
  assert.equal(body.counts.purchases, 0);
  assert.deepEqual(body.days, []);
});

test('imports both CSVs in one request and reconciles them', async () => {
  const files = [
    { filename: 'sample-purchases.csv', text: await readFile(join(SAMPLES, 'sample-purchases.csv'), 'utf8') },
    { filename: 'sample-transactions.csv', text: await readFile(join(SAMPLES, 'sample-transactions.csv'), 'utf8') },
  ];
  const { status, body } = await api('/api/import', postJson('', { files }));
  assert.equal(status, 200);
  assert.deepEqual(body.errors, []);
  assert.deepEqual(body.imported.map((i) => i.kind).sort(), ['charges', 'purchases']);
  assert.equal(body.imported.find((i) => i.kind === 'purchases').added, 10);

  const report = await api('/api/report');
  assert.equal(report.body.matches.length, 6);
  assert.equal(report.body.counts.charges, 12);
});

test('re-importing updates in place instead of duplicating', async () => {
  const files = [
    { filename: 'sample-purchases.csv', text: await readFile(join(SAMPLES, 'sample-purchases.csv'), 'utf8') },
  ];
  const { body } = await api('/api/import', postJson('', { files }));
  assert.equal(body.imported[0].added, 0);
  assert.equal(body.imported[0].updated, 10);

  const report = await api('/api/report');
  assert.equal(report.body.counts.purchases, 10);
});

test('rejects a file that is neither export', async () => {
  const { status, body } = await api(
    '/api/import',
    postJson('', { files: [{ filename: 'nope.csv', text: 'x,y\n1,2\n' }] }),
  );
  assert.equal(status, 400);
  assert.match(body.errors[0].error, /Could not tell/);
});

test('malformed JSON is a client error, not a server error', async () => {
  const res = await fetch(`${baseUrl}/api/link`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{not json',
  });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /not valid JSON/);
});

test('the day filter scopes the report', async () => {
  const all = await api('/api/report?day=all');
  const day = await api('/api/report?day=2026-08-26');
  assert.equal(day.body.matches.length, all.body.matches.length);

  const empty = await api('/api/report?day=2020-01-01');
  assert.equal(empty.body.matches.length, 0);
  assert.equal(empty.body.totals.purchaseTotal, 0);
});

test('a manual link survives a re-import and can be undone', async () => {
  // 1003 has no charge of its own; link it to the orphan 121.30 charge by hand.
  const linked = await api('/api/link', postJson('', { purchaseId: '1003', chargeId: 'tx_sample_10' }));
  assert.equal(linked.status, 200);

  let report = await api('/api/report');
  const manual = report.body.matches.find((m) => m.purchase.id === '1003');
  assert.ok(manual, 'expected the manual link to appear as a match');
  assert.equal(manual.method, 'manual');
  assert.equal(manual.confidence, 'manual');
  assert.equal(report.body.matches.length, 7);

  await api('/api/import', postJson('', {
    files: [{ filename: 'sample-purchases.csv', text: await readFile(join(SAMPLES, 'sample-purchases.csv'), 'utf8') }],
  }));
  report = await api('/api/report');
  assert.ok(report.body.matches.some((m) => m.purchase.id === '1003'), 'link should survive re-import');

  await api('/api/unlink', postJson('', { purchaseId: '1003' }));
  report = await api('/api/report');
  assert.equal(report.body.matches.length, 6);
  assert.ok(report.body.unmatchedPurchases.some((p) => p.id === '1003'));
});

test('linking an unknown id is refused', async () => {
  const { status, body } = await api('/api/link', postJson('', { purchaseId: 'nope', chargeId: 'tx_sample_10' }));
  assert.equal(status, 404);
  assert.match(body.error, /Unknown purchase/);
});

test('ignoring a row removes it from the report and the totals', async () => {
  await api('/api/ignore', postJson('', { kind: 'charge', id: 'tx_sample_11', ignored: true }));
  let report = await api('/api/report');
  assert.ok(!report.body.unmatchedCharges.some((c) => c.id === 'tx_sample_11'));

  await api('/api/ignore', postJson('', { kind: 'charge', id: 'tx_sample_11', ignored: false }));
  report = await api('/api/report');
  assert.ok(report.body.unmatchedCharges.some((c) => c.id === 'tx_sample_11'));
});

test('settings changes re-run the matching', async () => {
  const tightened = await api('/api/settings', postJson('', { timeWindowMinutes: 1, requireLast4: true }));
  assert.equal(tightened.body.settings.timeWindowMinutes, 1);

  const report = await api('/api/report');
  // Requiring a last-four drops the two hard-stock matches that have none.
  assert.ok(report.body.matches.length < 6);
  assert.ok(report.body.matches.every((m) => m.last4Agree));

  await api('/api/settings', postJson('', { timeWindowMinutes: 240, requireLast4: false }));
  const restored = await api('/api/report');
  assert.equal(restored.body.matches.length, 6);
});

test('exports a CSV covering every bucket', async () => {
  const res = await fetch(`${baseUrl}/api/export?day=2026-08-26`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-disposition'), /reconciliation-2026-08-26\.csv/);

  const csv = await res.text();
  const { headers, rows } = parseCsv(csv);
  assert.ok(headers.includes('purchase_id'));
  assert.ok(headers.includes('charge_id'));

  const statuses = new Set(rows.map((r) => r.status));
  assert.ok(statuses.has('matched'));
  assert.ok(statuses.has('purchase_without_charge'));
  assert.ok(statuses.has('charge_without_purchase'));
  assert.ok(statuses.has('declined'));
  assert.equal(rows.filter((r) => r.status === 'matched').length, 6);
});

test('pushes a live update over SSE when data changes', async () => {
  const controller = new AbortController();
  const res = await fetch(`${baseUrl}/api/stream`, { signal: controller.signal });
  const reader = res.body.getReader();

  // Drain the hello frame, then cause a change.
  await reader.read();
  await api('/api/ignore', postJson('', { kind: 'charge', id: 'tx_sample_11', ignored: true }));

  const { value } = await reader.read();
  const frame = new TextDecoder().decode(value);
  assert.match(frame, /event: update/);
  controller.abort();

  await api('/api/ignore', postJson('', { kind: 'charge', id: 'tx_sample_11', ignored: false }));
});

test('refuses to serve files outside public/', async () => {
  const res = await fetch(`${baseUrl}/../server.js`, { redirect: 'manual' });
  assert.ok(res.status === 403 || res.status === 404, `expected traversal to fail, got ${res.status}`);
});

test('serves the dashboard itself', async () => {
  const res = await fetch(`${baseUrl}/`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/html/);
  assert.match(await res.text(), /Ticket Reconciler/);
});

test('clearing wipes the data but leaves the server healthy', async () => {
  await api('/api/reset', postJson('', {}));
  const { body } = await api('/api/report');
  assert.equal(body.counts.purchases, 0);
  assert.equal(body.counts.charges, 0);
  assert.equal(body.matches.length, 0);
});

test('accepts a spreadsheet over the import API', async () => {
  const bytes = await readFile(join(SAMPLES, 'sample-inventory.xlsx'));
  const { status, body } = await api(
    '/api/import',
    postJson('', { files: [{ filename: 'inventory.xlsx', base64: bytes.toString('base64') }] }),
  );

  assert.equal(status, 200);
  assert.deepEqual(body.errors, []);
  assert.equal(body.imported[0].format, 'inventory');
  assert.equal(body.imported[0].rows, 10);

  const report = await api('/api/report');
  assert.ok(report.body.counts.purchases >= 10);
  assert.ok(report.body.coverage, 'the report should carry a coverage assessment');
});

test('the inventory export replaces the same POs from the other export', async () => {
  // Start clean, load the per-ticket export, then the same POs as inventory.
  await api('/api/reset', postJson('', {}));
  await api('/api/import', postJson('', {
    files: [{ filename: 'sample-purchases.csv', text: await readFile(join(SAMPLES, 'sample-purchases.csv'), 'utf8') }],
  }));
  const first = await api('/api/report');
  assert.equal(first.body.counts.purchases, 10);

  const bytes = await readFile(join(SAMPLES, 'sample-inventory.xlsx'));
  const { body } = await api('/api/import', postJson('', {
    files: [{ filename: 'inventory.xlsx', base64: bytes.toString('base64') }],
  }));
  assert.equal(body.imported[0].replaced, 9);

  const after = await api('/api/report');
  // 9 replaced + 1 row with no PO id that nothing can stand for, + 10 incoming.
  assert.equal(after.body.counts.purchases, 11);
});
