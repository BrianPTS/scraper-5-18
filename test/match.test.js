import assert from 'node:assert/strict';
import { test } from 'node:test';

import { normalizeCharges, normalizePurchases, parseTimestamp } from '../src/normalize.js';
import { reconcile } from '../src/match.js';

/** Build a purchase with sensible defaults. */
function purchase(overrides = {}) {
  return normalizePurchases([
    {
      id: 'p1',
      pos_po_id: 'po1',
      username: 'buyer@example.com',
      event_name: 'Test Event',
      purchase_date: '2026-08-26 16:50:13',
      payment_instrument_last_four: '1891',
      payment_amount: '205.89',
      original_amount: '205.89',
      qty: '2',
      ...overrides,
    },
  ])[0];
}

/** Build a charge with sensible defaults. */
function charge(overrides = {}) {
  return normalizeCharges([
    {
      Id: 'c1',
      'Date (UTC)': '2026-08-26 04:50:16PM',
      Description: 'TM *TICKETMASTER',
      Amount: '-205.89',
      Type: 'card_authorization',
      'Last 4': '1891',
      'Card Name': 'Card A',
      Status: 'pending',
      ...overrides,
    },
  ])[0];
}

test('matches the obvious case: same card, same cents, seconds apart', () => {
  const report = reconcile({ purchases: [purchase()], charges: [charge()] });
  assert.equal(report.matches.length, 1);
  assert.equal(report.unmatchedPurchases.length, 0);
  assert.equal(report.unmatchedCharges.length, 0);

  const [m] = report.matches;
  assert.equal(m.confidence, 'exact');
  assert.equal(m.amountDiff, 0);
  assert.ok(Math.abs(m.deltaMinutes) < 1);
});

test('never pairs charges on a different card', () => {
  const report = reconcile({
    purchases: [purchase()],
    charges: [charge({ 'Last 4': '9999' })],
  });
  assert.equal(report.matches.length, 0);
  assert.match(report.unmatchedPurchases[0].reason, /different cards/);
});

test('picks the right charge when two share an amount but not a card', () => {
  // Real data: two $205.89 authorizations minutes apart, on cards 1891 and 8679.
  const report = reconcile({
    purchases: [purchase({ payment_instrument_last_four: '1891' })],
    charges: [
      charge({ Id: 'other', 'Last 4': '8679', 'Date (UTC)': '2026-08-26 04:45:52PM' }),
      charge({ Id: 'right', 'Last 4': '1891' }),
    ],
  });
  assert.equal(report.matches.length, 1);
  assert.equal(report.matches[0].charge.id, 'right');
  assert.equal(report.unmatchedCharges[0].id, 'other');
});

test('prefers the closest charge in time when the card cannot decide', () => {
  const report = reconcile({
    purchases: [purchase({ payment_instrument_last_four: '' })],
    charges: [
      charge({ Id: 'far', 'Date (UTC)': '2026-08-26 02:50:16PM' }),
      charge({ Id: 'near', 'Date (UTC)': '2026-08-26 04:50:16PM' }),
    ],
  });
  assert.equal(report.matches[0].charge.id, 'near');
});

test('matches a purchase with no card on file, at lower confidence', () => {
  // Hard-stock / TradeDesk orders have no last four; amount and time carry it.
  const report = reconcile({
    purchases: [purchase({ payment_instrument_last_four: '', payment_amount: '', original_amount: '349.87' })],
    charges: [charge({ Amount: '-349.87', 'Last 4': '9175', Description: 'TM RESALE 800-842-7112' })],
  });
  assert.equal(report.matches.length, 1);
  assert.equal(report.matches[0].confidence, 'likely');
});

test('requireLast4 refuses to guess when a card is missing', () => {
  const report = reconcile({
    purchases: [purchase({ payment_instrument_last_four: '' })],
    charges: [charge()],
    options: { requireLast4: true },
  });
  assert.equal(report.matches.length, 0);
});

test('a charge outside the time window is not a candidate', () => {
  const report = reconcile({
    purchases: [purchase()],
    charges: [charge({ 'Date (UTC)': '2026-08-26 08:50:16AM' })],
    options: { timeWindowMinutes: 60 },
  });
  assert.equal(report.matches.length, 0);
  assert.match(report.unmatchedPurchases[0].reason, /outside the 60-minute window/);
});

test('amount tolerance allows a near miss', () => {
  const withoutTolerance = reconcile({
    purchases: [purchase()],
    charges: [charge({ Amount: '-205.94' })],
  });
  assert.equal(withoutTolerance.matches.length, 0);

  const withTolerance = reconcile({
    purchases: [purchase()],
    charges: [charge({ Amount: '-205.94' })],
    options: { amountTolerance: 0.05 },
  });
  assert.equal(withTolerance.matches.length, 1);
  assert.equal(withTolerance.matches[0].confidence, 'review');
  assert.equal(withTolerance.matches[0].amountDiff, 0.05);
});

test('declines are quarantined and explain an unmatched purchase', () => {
  const report = reconcile({
    purchases: [purchase()],
    charges: [
      charge({ Type: 'card_decline', Status: 'declined', 'Decline Reason': 'an incorrect CVV was entered' }),
    ],
  });
  assert.equal(report.matches.length, 0);
  assert.equal(report.declines.length, 1);
  assert.match(report.unmatchedPurchases[0].reason, /DECLINED/);
  assert.match(report.unmatchedPurchases[0].reason, /incorrect CVV/);
});

test('reversed authorizations do not satisfy a purchase', () => {
  const report = reconcile({
    purchases: [purchase()],
    charges: [charge({ Status: 'reversed' })],
  });
  assert.equal(report.matches.length, 0);
  assert.equal(report.reversals.length, 1);
  assert.match(report.unmatchedPurchases[0].reason, /reversed/);
});

test('zero-amount purchases are bucketed, not reported as missing charges', () => {
  const report = reconcile({
    purchases: [purchase({ payment_amount: '0.0', original_amount: '0.0' })],
    charges: [],
  });
  assert.equal(report.zeroAmountPurchases.length, 1);
  assert.equal(report.unmatchedPurchases.length, 0);
});

test('credits are separated from debits', () => {
  const report = reconcile({ purchases: [], charges: [charge({ Amount: '205.89' })] });
  assert.equal(report.credits.length, 1);
  assert.equal(report.unmatchedCharges.length, 0);
});

test('a manual link wins over the automatic pairing', () => {
  const p = purchase();
  const wrongButCloser = charge({ Id: 'auto' });
  const manualTarget = charge({ Id: 'manual', 'Date (UTC)': '2026-08-26 04:20:16PM' });

  const report = reconcile({
    purchases: [p],
    charges: [wrongButCloser, manualTarget],
    overrides: { links: [{ purchaseId: 'p1', chargeId: 'manual' }] },
  });

  assert.equal(report.matches.length, 1);
  assert.equal(report.matches[0].charge.id, 'manual');
  assert.equal(report.matches[0].confidence, 'manual');
  assert.equal(report.matches[0].method, 'manual');
  assert.equal(report.unmatchedCharges[0].id, 'auto');
});

test('a stale manual link (data re-imported without that row) is skipped', () => {
  const report = reconcile({
    purchases: [purchase()],
    charges: [charge()],
    overrides: { links: [{ purchaseId: 'p1', chargeId: 'gone-from-the-export' }] },
  });
  assert.equal(report.matches.length, 1);
  assert.equal(report.matches[0].method, 'auto');
});

test('ignored rows drop out of both the tables and the totals', () => {
  const report = reconcile({
    purchases: [purchase()],
    charges: [charge({ 'Last 4': '9999' })],
    overrides: { ignoredPurchases: ['p1'], ignoredCharges: ['c1'] },
  });
  assert.equal(report.unmatchedPurchases.length, 0);
  assert.equal(report.unmatchedCharges.length, 0);
  assert.equal(report.totals.unmatchedPurchaseTotal, 0);
});

test('flags the genuinely ambiguous case instead of quietly choosing', () => {
  // Two identical charges on the same card at the same instant: nothing in the
  // data can tell them apart, so the match must be marked for a human.
  const report = reconcile({
    purchases: [purchase()],
    charges: [charge({ Id: 'a' }), charge({ Id: 'b' })],
  });
  assert.equal(report.matches.length, 1);
  assert.equal(report.matches[0].ambiguous, true);
});

test('one charge is never spent on two purchases', () => {
  const report = reconcile({
    purchases: [purchase({ id: 'p1' }), purchase({ id: 'p2', purchase_date: '2026-08-26 16:51:13' })],
    charges: [charge()],
  });
  assert.equal(report.matches.length, 1);
  assert.equal(report.unmatchedPurchases.length, 1);
  assert.match(report.unmatchedPurchases[0].reason, /claimed by a closer-matching purchase/);
});

test('the result is stable no matter what order the rows arrive in', () => {
  const purchases = [
    purchase({ id: 'p1' }),
    purchase({ id: 'p2', payment_amount: '117.00', payment_instrument_last_four: '1891', purchase_date: '2026-08-26 14:11:06' }),
  ];
  const charges = [
    charge({ Id: 'c1' }),
    charge({ Id: 'c2', Amount: '-117', 'Date (UTC)': '2026-08-26 02:11:10PM' }),
  ];

  const forward = reconcile({ purchases, charges });
  const reversed = reconcile({ purchases: [...purchases].reverse(), charges: [...charges].reverse() });

  const key = (r) => r.matches.map((m) => `${m.purchase.id}->${m.charge.id}`).sort().join(',');
  assert.equal(key(forward), key(reversed));
  assert.equal(key(forward), 'p1->c1,p2->c2');
});

test('totals add up', () => {
  const report = reconcile({
    purchases: [purchase({ id: 'p1' }), purchase({ id: 'p2', payment_amount: '100.00', payment_instrument_last_four: '5555' })],
    charges: [charge(), charge({ Id: 'orphan', Amount: '-42.00', 'Last 4': '7777' })],
  });

  assert.equal(report.totals.matchedCount, 1);
  assert.equal(report.totals.matchedPurchaseTotal, 205.89);
  assert.equal(report.totals.unmatchedPurchaseCount, 1);
  assert.equal(report.totals.unmatchedPurchaseTotal, 100);
  assert.equal(report.totals.unmatchedChargeCount, 1);
  assert.equal(report.totals.unmatchedChargeTotal, 42);
  assert.equal(report.totals.netExposure, -58);
  assert.equal(report.totals.chargeTotal, 247.89);
});

test('a clock offset lets two feeds in different timezones line up', () => {
  const shifted = charge({ 'Date (UTC)': '2026-08-26 09:50:16PM' }); // +5h
  const without = reconcile({ purchases: [purchase()], charges: [shifted], options: { timeWindowMinutes: 60 } });
  assert.equal(without.matches.length, 0);

  const with5h = reconcile({
    purchases: [purchase()],
    charges: [shifted],
    options: { timeWindowMinutes: 60, chargeTimeOffsetMinutes: -300 },
  });
  assert.equal(with5h.matches.length, 1);
});

test('candidate suggestions are offered for an unmatched purchase', () => {
  const report = reconcile({
    purchases: [purchase()],
    charges: [charge({ Amount: '-206.00', 'Last 4': '1891' })],
  });
  assert.equal(report.matches.length, 0);
  const [p] = report.unmatchedPurchases;
  assert.equal(p.candidates.length, 1);
  assert.equal(p.candidates[0].amountDiff, 0.11);
  assert.equal(p.candidates[0].last4Agree, true);
});

test('rows with an unparseable timestamp never match', () => {
  const report = reconcile({
    purchases: [purchase({ purchase_date: '' })],
    charges: [charge()],
  });
  assert.equal(report.matches.length, 0);
  assert.equal(report.unmatchedPurchases.length, 1);
  assert.equal(report.unmatchedCharges.length, 1);
});

test('parseTimestamp underpins the window arithmetic', () => {
  const a = parseTimestamp('2026-08-26 16:50:13');
  const b = parseTimestamp('2026-08-26 04:50:16PM');
  assert.equal((b - a) / 1000, 3);
});
