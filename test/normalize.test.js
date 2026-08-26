import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  businessDay,
  detectKind,
  normalizeCharges,
  normalizeLast4,
  normalizePurchases,
  parseAmount,
  parseTimestamp,
} from '../src/normalize.js';

test('detects each export from its headers', () => {
  assert.equal(detectKind(['id', 'pos_po_id', 'payment_instrument_last_four', 'purchase_date']), 'purchases');
  assert.equal(detectKind(['Id', 'Date (UTC)', 'Last 4', 'Card Name', 'Authorization Date (UTC)']), 'charges');
  assert.equal(detectKind(['foo', 'bar']), null);
});

test('parses both timestamp formats to the same wall-clock instant', () => {
  // The purchase feed writes 24-hour time, the card feed writes 12-hour time.
  // The same moment must land on the same value or nothing will ever match.
  assert.equal(parseTimestamp('2026-08-26 16:50:13'), Date.UTC(2026, 7, 26, 16, 50, 13));
  assert.equal(parseTimestamp('2026-08-26 04:50:13PM'), Date.UTC(2026, 7, 26, 16, 50, 13));
});

test('handles midnight and noon in 12-hour time', () => {
  assert.equal(parseTimestamp('2026-08-26 12:30:00AM'), Date.UTC(2026, 7, 26, 0, 30, 0));
  assert.equal(parseTimestamp('2026-08-26 12:30:00PM'), Date.UTC(2026, 7, 26, 12, 30, 0));
});

test('tolerates missing and malformed timestamps', () => {
  assert.equal(parseTimestamp(''), null);
  assert.equal(parseTimestamp(undefined), null);
  assert.equal(parseTimestamp('2026-08-26'), Date.UTC(2026, 7, 26, 0, 0, 0));
});

test('parses money in the shapes exports produce', () => {
  assert.equal(parseAmount('205.89'), 205.89);
  assert.equal(parseAmount('-85.68'), -85.68);
  assert.equal(parseAmount('$1,464.71'), 1464.71);
  assert.equal(parseAmount('(12.00)'), -12);
  assert.equal(parseAmount(''), null);
});

test('last four digits are compared with leading zeros intact', () => {
  assert.equal(normalizeLast4('0680'), '0680');
  assert.equal(normalizeLast4('680'), '0680');
  assert.equal(normalizeLast4(''), '');
});

const purchaseRow = {
  id: '38816322',
  pos_po_id: '108023580',
  username: 'buyer@example.com',
  event_name: 'Preseason - Green Bay Packers v Arizona Cardinals',
  event_date: '2026-08-28 19:00:00',
  venue_name: 'Lambeau Field',
  payment_instrument_brand: 'Visa',
  payment_instrument_last_four: '1891',
  purchase_date: '2026-08-26 16:50:13',
  ticket_details: '131 : 4 : 1 - 4',
  original_amount: '205.89',
  payment_amount: '205.89',
  refunded_amount: '0',
  qty: '4',
  stock_type: 'MOBILE TRANSFER',
};

test('normalizes a purchase row', () => {
  const [p] = normalizePurchases([purchaseRow]);
  assert.equal(p.id, '38816322');
  assert.equal(p.amount, 205.89);
  assert.equal(p.last4, '1891');
  assert.equal(p.qty, 4);
  assert.equal(p.day, '2026-08-26');
  assert.equal(businessDay(p.purchasedAt), '2026-08-26');
});

test('falls back to original_amount when payment_amount is blank', () => {
  // Hard-stock and TradeDesk orders only populate original_amount.
  const [p] = normalizePurchases([
    { ...purchaseRow, payment_amount: '', original_amount: '349.87', payment_instrument_last_four: '' },
  ]);
  assert.equal(p.amount, 349.87);
  assert.equal(p.last4, '');
});

const chargeRow = {
  Id: 'agg_tx_i2psprk7hxah',
  'Date (UTC)': '2026-08-26 04:50:16PM',
  Description: 'TM *TICKETMASTER',
  Amount: '-205.89',
  Type: 'card_authorization',
  'Last 4': '1891',
  'Card Name': 'Mirror August 2026 163',
  'Card Group Name': 'Mirror August 2026',
  Status: 'pending',
};

test('normalizes a charge row and flips the sign', () => {
  const [c] = normalizeCharges([chargeRow]);
  assert.equal(c.amount, 205.89);
  assert.equal(c.signedAmount, -205.89);
  assert.equal(c.direction, 'debit');
  assert.equal(c.capturing, true);
  assert.equal(c.last4, '1891');
});

test('a settlement is timestamped by its authorization, not its posting', () => {
  // The posting happens hours later; only the auth time agrees with the purchase feed.
  const [c] = normalizeCharges([
    {
      ...chargeRow,
      'Date (UTC)': '2026-08-26 03:36:14PM',
      'Authorization Date (UTC)': '2026-08-26 02:30:56PM',
      Type: 'card_settlement',
      Status: 'settled',
    },
  ]);
  assert.equal(c.occurredAt, parseTimestamp('2026-08-26 02:30:56PM'));
  assert.notEqual(c.occurredAt, c.postedAt);
});

test('declines and reversals are marked as non-capturing', () => {
  const [declined] = normalizeCharges([
    { ...chargeRow, Type: 'card_decline', Status: 'declined', 'Decline Reason': 'an incorrect CVV was entered' },
  ]);
  const [reversed] = normalizeCharges([{ ...chargeRow, Status: 'reversed' }]);
  assert.equal(declined.capturing, false);
  assert.equal(reversed.capturing, false);
});

test('a positive amount is treated as a credit', () => {
  const [c] = normalizeCharges([{ ...chargeRow, Amount: '129.50' }]);
  assert.equal(c.direction, 'credit');
  assert.equal(c.amount, 129.5);
});
