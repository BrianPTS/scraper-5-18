/**
 * The Purchased Inventory export: one row per purchase order, no card digits,
 * a US-ordered timestamp, and a payment state your POS believes.
 *
 * Losing the card last-four is the interesting part — the merchant column has
 * to take over as the thing that stops two same-amount purchases swapping
 * charges, so most of these tests are about that substitution holding.
 */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import { parseCsv } from '../src/csv.js';
import {
  detectFormat,
  formatTimestamp,
  merchantTag,
  normalizeInventoryPurchases,
  normalizeParsed,
  parseTimestamp,
} from '../src/normalize.js';
import { reconcile } from '../src/match.js';
import { parseXlsx, looksLikeXlsx } from '../src/xlsx.js';
import { Store } from '../src/store.js';

const SAMPLES = join(fileURLToPath(new URL('..', import.meta.url)), 'samples');

const loadSample = async (name) => parseCsv(await readFile(join(SAMPLES, name), 'utf8'));

// ---------------------------------------------------------------------------
// Format detection and parsing
// ---------------------------------------------------------------------------

test('tells the three exports apart', async () => {
  assert.equal(detectFormat((await loadSample('sample-inventory.csv')).headers), 'inventory');
  assert.equal(detectFormat((await loadSample('sample-purchases.csv')).headers), 'po-export');
  assert.equal(detectFormat((await loadSample('sample-transactions.csv')).headers), 'charges');
});

test('reads the US-ordered timestamp with its UTC offset', () => {
  // "8/26/2026 3:24:06 AM +00:00" has to land on the same instant the other two
  // feeds would call 03:24:06, or nothing will ever match.
  assert.equal(parseTimestamp('8/26/2026 3:24:06 AM +00:00'), Date.UTC(2026, 7, 26, 3, 24, 6));
  assert.equal(parseTimestamp('8/26/2026 3:24:06 AM +00:00'), parseTimestamp('2026-08-26 03:24:06'));
  assert.equal(parseTimestamp('8/26/2026 4:50:13 PM +00:00'), parseTimestamp('2026-08-26 04:50:16PM') - 3000);
});

test('applies a real UTC offset when one is present', () => {
  assert.equal(parseTimestamp('8/26/2026 3:24:06 AM -05:00'), Date.UTC(2026, 7, 26, 8, 24, 6));
  assert.equal(parseTimestamp('8/26/2026 3:24:06 AM +02:00'), Date.UTC(2026, 7, 26, 1, 24, 6));
});

test('a bare date is not mistaken for an offset', () => {
  assert.equal(parseTimestamp('2026-08-26'), Date.UTC(2026, 7, 26));
  assert.equal(parseTimestamp('8/26/2026'), Date.UTC(2026, 7, 26));
});

test('converts an Excel serial date', () => {
  // Serial 46260 is 2026-08-26 — a spreadsheet hands dates over this way when
  // the cell is formatted as a date rather than stored as text.
  assert.equal(formatTimestamp(parseTimestamp('46260')).slice(0, 10), '2026-08-26');
  assert.equal(formatTimestamp(parseTimestamp('46260.5')).slice(0, 16), '2026-08-26 12:00');
  // Small numbers stay numbers — a quantity is not a date.
  assert.equal(parseTimestamp('142'), null);
});

test('recognises merchants from vendor names and card descriptors', () => {
  assert.equal(merchantTag('TicketMaster'), 'ticketmaster');
  assert.equal(merchantTag('TM *TICKETMASTER'), 'ticketmaster');
  assert.equal(merchantTag('TM RESALE 800-842-7112'), 'ticketmaster');
  assert.equal(merchantTag('SeatGeek'), 'seatgeek');
  assert.equal(merchantTag('SEATGEEK TICKETS'), 'seatgeek');
  assert.equal(merchantTag('Unknown Vendor'), '', 'an unknown vendor must not constrain anything');
  assert.equal(merchantTag(''), '');
});

// ---------------------------------------------------------------------------
// Normalizing
// ---------------------------------------------------------------------------

test('normalizes an inventory row', async () => {
  const { records } = normalizeParsed(await loadSample('sample-inventory.csv'));
  const po = records.find((p) => p.id === '500001');

  assert.equal(po.source, 'inventory');
  assert.equal(po.poId, '500001');
  assert.equal(po.amount, 205.89);
  assert.equal(po.qty, 4);
  assert.equal(po.vendor, 'TicketMaster');
  assert.equal(po.merchant, 'ticketmaster');
  assert.equal(po.paymentState, 'Paid');
  assert.equal(po.account, 'buyer01@example.com');
  assert.equal(po.last4, '', 'this export carries no card digits at all');
  assert.equal(po.day, '2026-08-26');
  assert.match(po.label, /PO 500001/);
});

test('skips the trailing totals row', async () => {
  const parsed = await loadSample('sample-inventory.csv');
  const { records } = normalizeParsed(parsed);
  // The file has one more data line than there are purchase orders.
  assert.equal(parsed.rows.length, 11);
  assert.equal(records.length, 10);
  assert.ok(records.every((p) => p.id));
});

test('parses money with a thousands separator', () => {
  const [po] = normalizeInventoryPurchases([
    { 'PO Id': '1', 'PO Date': '8/25/2026 5:18:10 PM +00:00', 'Total Cost': '"$1,352.02"'.replace(/"/g, ''), Vendor: 'SeatGeek' },
  ]);
  assert.equal(po.amount, 1352.02);
});

// ---------------------------------------------------------------------------
// Matching without a card number
// ---------------------------------------------------------------------------

async function reconcileSamples(options) {
  const purchases = normalizeParsed(await loadSample('sample-inventory.csv')).records;
  const charges = normalizeParsed(await loadSample('sample-transactions.csv')).records;
  return reconcile({ purchases, charges, options });
}

test('reconciles the inventory export against the card feed', async () => {
  const report = await reconcileSamples();

  assert.deepEqual(
    report.matches.map((m) => `${m.purchase.id}->${m.charge.id}`).sort(),
    [
      '500001->tx_sample_01',
      '500002->tx_sample_02',
      '500004->tx_sample_04', // Unknown Vendor: no merchant constraint to apply
      '500006->tx_sample_06', // settlement, matched on its authorization time
      '500009->tx_sample_08', // SeatGeek order to the SeatGeek charge
      '500010->tx_sample_09',
    ],
  );
  assert.equal(report.totals.matchedVariance, 0);
});

test('a SeatGeek order never takes the TM charge sitting next to it', async () => {
  // PO 500011 is $121.30 from SeatGeek. tx_sample_10 is $121.30 on TM, one
  // minute away — a perfect amount-and-time match that must still be refused.
  const report = await reconcileSamples();

  assert.ok(!report.matches.some((m) => m.purchase.id === '500011'));
  const po = report.unmatchedPurchases.find((p) => p.id === '500011');
  assert.match(po.reason, /none from SeatGeek/);
  assert.ok(report.unmatchedCharges.some((c) => c.id === 'tx_sample_10'));
});

test('the closest charge still wins among same-merchant candidates', async () => {
  // Two $205.89 TM authorizations, 4 minutes apart. Without a card to compare,
  // proximity decides — and it must pick the one 3 seconds away.
  const report = await reconcileSamples();
  const match = report.matches.find((m) => m.purchase.id === '500001');
  assert.equal(match.charge.id, 'tx_sample_01');
  assert.ok(Math.abs(match.deltaMinutes) < 1);
});

test('matches without a card are likely, never exact', async () => {
  const report = await reconcileSamples();
  assert.ok(report.matches.every((m) => m.confidence === 'likely'));
  assert.ok(report.matches.every((m) => m.last4Agree === false));
});

test('an agreeing merchant lifts a distant pair out of review', () => {
  const purchase = normalizeInventoryPurchases([
    { 'PO Id': '9', 'PO Date': '8/26/2026 1:00:00 PM +00:00', 'Total Cost': '$100.00', Vendor: 'TicketMaster', 'PO Payment State': 'Paid' },
  ]);
  const charge = {
    kind: 'charge', id: 'c', amount: 100, signedAmount: -100, direction: 'debit', capturing: true,
    type: 'card_authorization', status: 'pending', last4: '', merchant: 'ticketmaster',
    description: 'TM *TICKETMASTER', occurredAt: parseTimestamp('2026-08-26 13:40:00'), day: '2026-08-26',
  };

  const withMerchant = reconcile({ purchases: purchase, charges: [charge] });
  assert.equal(withMerchant.matches[0].confidence, 'likely');
  assert.equal(withMerchant.matches[0].merchantAgree, true);

  // Strip the merchant from both sides and the same pair is only a coincidence
  // of amount and time, 40 minutes apart.
  const anonymous = reconcile({
    purchases: normalizeInventoryPurchases([
      { 'PO Id': '9', 'PO Date': '8/26/2026 1:00:00 PM +00:00', 'Total Cost': '$100.00', Vendor: 'Unknown Vendor' },
    ]),
    charges: [{ ...charge, merchant: '', description: 'SOME MERCHANT' }],
  });
  assert.equal(anonymous.matches[0].confidence, 'review');
});

// ---------------------------------------------------------------------------
// POS payment state versus what the cards actually did
// ---------------------------------------------------------------------------

test('flags a charge your POS still thinks is unpaid', async () => {
  const report = await reconcileSamples();
  const match = report.matches.find((m) => m.purchase.id === '500004');

  assert.equal(match.purchase.paymentState, 'NotPaid');
  assert.ok(match.flags.includes('pos-says-unpaid'));
  assert.equal(report.totals.posSaysUnpaidButCharged, 2); // 500004 and 500009
});

test('leads with the discrepancy when a Paid order has no charge', async () => {
  const report = await reconcileSamples();
  const po = report.unmatchedPurchases.find((p) => p.id === '500003');

  assert.equal(po.paymentState, 'Paid');
  assert.match(po.reason, /^Marked Paid in your POS, but no card charge/);
  assert.ok(report.totals.posSaysPaidButNoCharge >= 1);
});

test('a declined charge still explains a Paid order', async () => {
  const report = await reconcileSamples();
  const po = report.unmatchedPurchases.find((p) => p.id === '500005');
  assert.match(po.reason, /DECLINED/);
  assert.match(po.reason, /incorrect CVV/);
});

// ---------------------------------------------------------------------------
// .xlsx
// ---------------------------------------------------------------------------

test('reads the same data out of the .xlsx', async () => {
  const bytes = await readFile(join(SAMPLES, 'sample-inventory.xlsx'));
  assert.equal(looksLikeXlsx(bytes), true);

  const table = await parseXlsx(bytes);
  const fromCsv = await loadSample('sample-inventory.csv');

  assert.deepEqual(table.headers, fromCsv.headers);
  assert.equal(table.rows.length, fromCsv.rows.length);
  assert.deepEqual(table.rows[0], fromCsv.rows[0]);

  const viaXlsx = normalizeParsed(table);
  const viaCsv = normalizeParsed(fromCsv);
  assert.equal(viaXlsx.format, 'inventory');
  assert.deepEqual(
    viaXlsx.records.map((p) => [p.id, p.amount]),
    viaCsv.records.map((p) => [p.id, p.amount]),
  );
});

test('a CSV is not mistaken for a spreadsheet', async () => {
  assert.equal(looksLikeXlsx(await readFile(join(SAMPLES, 'sample-inventory.csv'))), false);
});

test('rejects a file that is not a spreadsheet at all', async () => {
  await assert.rejects(() => parseXlsx(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])), /not a readable \.xlsx/);
});

// ---------------------------------------------------------------------------
// Keeping the two purchase exports from double-counting each other
// ---------------------------------------------------------------------------

test('the same PO from the other export replaces it instead of doubling it', async (t) => {
  const file = join(
    await import('node:os').then((os) => os.tmpdir()),
    `reconciler-store-${process.pid}.json`,
  );
  const store = new Store(file);
  await store.load();
  t.after(async () => {
    const { rm } = await import('node:fs/promises');
    await rm(file, { force: true });
  });

  const poExport = normalizeParsed(await loadSample('sample-purchases.csv'));
  const inventory = normalizeParsed(await loadSample('sample-inventory.csv'));

  store.upsert('purchases', poExport.records);
  const before = store.purchases().length;
  assert.equal(before, 10);

  // sample-purchases.csv carries pos_po_id 500001…500010; the inventory export
  // is the same POs under their PO Id. Importing it must not add a second copy.
  const result = store.upsert('purchases', inventory.records);
  assert.equal(result.replaced, 9, 'nine POs appear in both exports and must be evicted');

  // Eleven, not ten: sample-purchases.csv has one row with no PO id at all (a
  // zero-cost transfer in). Nothing in the inventory export can stand for it,
  // so it survives rather than being silently dropped.
  assert.equal(store.purchases().length, 11);
  const survivor = store.purchases().filter((p) => p.source === 'po-export');
  assert.equal(survivor.length, 1);
  assert.equal(survivor[0].poId, '');

  // The point of the eviction: no purchase order is counted twice.
  const poIds = store.purchases().map((p) => p.poId).filter(Boolean);
  assert.equal(new Set(poIds).size, poIds.length);
});

test('rows from the same export are left alone', async () => {
  const store = new Store('/dev/null');
  const inventory = normalizeParsed(await loadSample('sample-inventory.csv'));

  store.upsert('purchases', inventory.records);
  const again = store.upsert('purchases', inventory.records);

  assert.equal(again.replaced, 0);
  assert.equal(again.updated, 10);
  assert.equal(store.purchases().length, 10);
});

// ---------------------------------------------------------------------------
// Coverage: telling a reporting gap apart from missing money
// ---------------------------------------------------------------------------

test('names the days one feed is missing entirely', async () => {
  const { assessCoverage, collectDays } = await import('../src/report.js');
  const purchases = normalizeParsed(await loadSample('sample-inventory.csv')).records;

  const days = collectDays(purchases, []);
  const coverage = assessCoverage(days, null, purchases, []);

  assert.deepEqual(coverage.daysMissingCharges, ['2026-08-26']);
  assert.deepEqual(coverage.daysMissingPurchases, []);
  assert.equal(coverage.complete, false);
});

test('spots two exports that share a day but stop at different times', async () => {
  const { assessCoverage, collectDays } = await import('../src/report.js');
  const purchases = normalizeParsed(await loadSample('sample-inventory.csv')).records;
  const charges = normalizeParsed(await loadSample('sample-transactions.csv')).records;

  // Purchases that stop at 03:24 against card activity running to 17:49 is the
  // case that makes an afternoon of orders look unpaid.
  const truncated = purchases.filter((p) => p.purchasedAt <= parseTimestamp('2026-08-26 03:30:00'));
  const coverage = assessCoverage(collectDays(truncated, charges), null, truncated, charges);

  assert.ok(coverage.misalignedWindows, 'expected the window mismatch to be reported');
  assert.equal(coverage.complete, false);
  assert.equal(formatTimestamp(coverage.purchaseRange.to).slice(0, 10), '2026-08-26');
  assert.ok(coverage.overlap, 'the windows still overlap, just not fully');
});

test('stays quiet when both feeds cover the same window', async () => {
  const { assessCoverage, collectDays } = await import('../src/report.js');
  const purchases = normalizeParsed(await loadSample('sample-inventory.csv')).records;
  const charges = normalizeParsed(await loadSample('sample-transactions.csv')).records;

  const coverage = assessCoverage(collectDays(purchases, charges), null, purchases, charges);
  assert.equal(coverage.complete, true);
  assert.deepEqual(coverage.daysMissingCharges, []);
});
