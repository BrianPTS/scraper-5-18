/**
 * Turns the two raw CSV exports into one canonical shape the matcher can work with.
 *
 * Timestamps are treated as *wall clock* values, not absolute instants. Both
 * exports stamp the same event with the same clock reading (a purchase logged at
 * 16:50:13 shows up on the card feed as 04:50:16PM), so we deliberately do not
 * apply any timezone conversion. If your two sources ever drift apart, use the
 * `chargeTimeOffsetMinutes` setting rather than reinterpreting the strings here.
 */

const PURCHASE_SIGNATURE = ['pos_po_id', 'payment_instrument_last_four', 'purchase_date'];
const CHARGE_SIGNATURE = ['Last 4', 'Authorization Date (UTC)', 'Card Name'];

/**
 * Guess which export a file is, from its header row.
 * @param {string[]} headers
 * @returns {'purchases'|'charges'|null}
 */
export function detectKind(headers) {
  const set = new Set(headers.map((h) => h.trim()));
  const purchaseHits = PURCHASE_SIGNATURE.filter((h) => set.has(h)).length;
  const chargeHits = CHARGE_SIGNATURE.filter((h) => set.has(h)).length;

  if (purchaseHits >= 2 && purchaseHits > chargeHits) return 'purchases';
  if (chargeHits >= 2 && chargeHits > purchaseHits) return 'charges';
  // Fall back to single unmistakable columns.
  if (set.has('pos_po_id') || set.has('event_name')) return 'purchases';
  if (set.has('Last 4') || set.has('Decline Reason')) return 'charges';
  return null;
}

/**
 * Parse the timestamp formats found in both exports:
 *   "2026-08-26 16:50:13"     (24h, purchases)
 *   "2026-08-26 05:49:07PM"   (12h, card transactions)
 *   "2026-08-26"              (date only)
 *   "2026-08-26T16:50:13Z"    (ISO, tolerated)
 *
 * @param {string} value
 * @returns {number|null} epoch milliseconds, interpreted as wall-clock UTC
 */
export function parseTimestamp(value) {
  if (!value) return null;
  const raw = String(value).trim();
  if (!raw) return null;

  const m = raw.match(
    /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM|am|pm)?)?/,
  );
  if (!m) {
    const fallback = Date.parse(raw);
    return Number.isNaN(fallback) ? null : fallback;
  }

  const [, y, mo, d, hStr, min, sec, meridiem] = m;
  let hour = hStr ? Number(hStr) : 0;
  if (meridiem) {
    const upper = meridiem.toUpperCase();
    if (upper === 'PM' && hour < 12) hour += 12;
    if (upper === 'AM' && hour === 12) hour = 0;
  }

  return Date.UTC(Number(y), Number(mo) - 1, Number(d), hour, Number(min || 0), Number(sec || 0));
}

/**
 * Format epoch ms back to a wall-clock string (no timezone shifting).
 * @param {number|null} ms
 * @returns {string}
 */
export function formatTimestamp(ms) {
  if (ms === null || ms === undefined || Number.isNaN(ms)) return '';
  return new Date(ms).toISOString().replace('T', ' ').slice(0, 19);
}

/**
 * The business day a record belongs to, as YYYY-MM-DD.
 * @param {number|null} ms
 * @returns {string}
 */
export function businessDay(ms) {
  if (ms === null || ms === undefined || Number.isNaN(ms)) return '';
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * Money parsing that tolerates "$1,234.56", "(12.00)" and empty strings.
 * @param {string|number} value
 * @returns {number|null}
 */
export function parseAmount(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  let s = String(value).trim();
  if (!s) return null;
  let negative = false;
  if (/^\(.*\)$/.test(s)) {
    negative = true;
    s = s.slice(1, -1);
  }
  s = s.replace(/[$,\s]/g, '');
  if (s.startsWith('-')) {
    negative = true;
    s = s.slice(1);
  }
  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  return negative ? -n : n;
}

/** Normalize a card's last four so "680" and "0680" compare equal. */
export function normalizeLast4(value) {
  const digits = String(value ?? '').replace(/\D/g, '');
  if (!digits) return '';
  return digits.slice(-4).padStart(4, '0');
}

const clean = (value) => String(value ?? '').trim();

/**
 * Normalize the purchase-order export.
 * @param {Record<string,string>[]} rows
 * @returns {import('./types.js').Purchase[]}
 */
export function normalizePurchases(rows) {
  const out = [];
  for (const row of rows) {
    const id = clean(row.id) || clean(row.pos_po_id) || clean(row.remote_id);
    if (!id) continue;

    // payment_amount is what actually hit the card; original_amount is the
    // pre-adjustment figure and is the only number present for some sources.
    const paymentAmount = parseAmount(row.payment_amount);
    const originalOverride = parseAmount(row.original_amount_override);
    const originalAmount = parseAmount(row.original_amount);
    const amount = paymentAmount ?? originalOverride ?? originalAmount ?? 0;

    const purchasedAt = parseTimestamp(row.purchase_date);

    out.push({
      kind: 'purchase',
      id,
      poId: clean(row.pos_po_id),
      remoteId: clean(row.remote_id),
      legacyRemoteId: clean(row.legacy_remote_id),
      webId: clean(row.web_id),
      account: clean(row.username),
      accountId: clean(row.account_id),
      event: clean(row.event_name),
      eventDate: parseTimestamp(row.event_date),
      venue: clean(row.venue_name),
      seats: clean(row.ticket_details),
      qty: Number(clean(row.qty)) || 0,
      stockType: clean(row.stock_type),
      tags: clean(row.internal_tags),
      brand: clean(row.payment_instrument_brand) || clean(row.payment_type),
      last4: normalizeLast4(row.payment_instrument_last_four),
      amount,
      originalAmount: originalAmount ?? amount,
      refundedAmount: parseAmount(row.refunded_amount) ?? 0,
      refundStatus: clean(row.refund_status),
      status: clean(row.status),
      eventStatus: clean(row.event_status),
      purchasedAt,
      day: businessDay(purchasedAt),
      raw: row,
    });
  }
  return out;
}

/** Card feed statuses that mean "no money moved". */
const NON_CAPTURING_STATUSES = new Set(['declined', 'reversed', 'expired', 'canceled', 'cancelled']);

/**
 * Normalize the card transaction export.
 * @param {Record<string,string>[]} rows
 * @returns {import('./types.js').Charge[]}
 */
export function normalizeCharges(rows) {
  const out = [];
  for (const row of rows) {
    const id = clean(row.Id) || clean(row['Reference Number']);
    if (!id) continue;

    const signedAmount = parseAmount(row.Amount) ?? 0;
    const postedAt = parseTimestamp(row['Date (UTC)']);
    const authorizedAt = parseTimestamp(row['Authorization Date (UTC)']);
    // A settlement row is posted hours after the fact but carries the original
    // authorization time — that is the timestamp the purchase feed will agree with.
    const occurredAt = authorizedAt ?? postedAt;
    const type = clean(row.Type).toLowerCase();
    const status = clean(row.Status).toLowerCase();

    out.push({
      kind: 'charge',
      id,
      description: clean(row.Description),
      externalDescription: clean(row['External Description']),
      signedAmount,
      amount: Math.abs(signedAmount),
      direction: signedAmount > 0 ? 'credit' : 'debit',
      currency: clean(row['Foreign Currency']) || 'USD',
      type,
      status,
      declineReason: clean(row['Decline Reason']),
      cardId: clean(row['Card ID']),
      last4: normalizeLast4(row['Last 4']),
      cardName: clean(row['Card Name']),
      cardGroup: clean(row['Card Group Name']),
      account: clean(row['Virtual Account Name']),
      orderId: clean(row['Order Id']),
      referenceNumber: clean(row['Reference Number']),
      memo: clean(row.Memo),
      postedAt,
      authorizedAt,
      occurredAt,
      day: businessDay(occurredAt),
      capturing: !(type === 'card_decline' || NON_CAPTURING_STATUSES.has(status)),
      raw: row,
    });
  }
  return out;
}

/**
 * Parse + normalize a file in one step.
 * @param {{headers: string[], rows: Record<string,string>[]}} parsed
 * @param {'purchases'|'charges'|null} [forcedKind]
 * @returns {{kind: 'purchases'|'charges', records: Array<object>}}
 */
export function normalizeParsed(parsed, forcedKind) {
  const kind = forcedKind || detectKind(parsed.headers);
  if (kind === 'purchases') return { kind, records: normalizePurchases(parsed.rows) };
  if (kind === 'charges') return { kind, records: normalizeCharges(parsed.rows) };
  throw new Error(
    'Could not tell whether this file is a purchase export or a card transaction export. ' +
      'Expected either a "pos_po_id" column or a "Last 4" column.',
  );
}
