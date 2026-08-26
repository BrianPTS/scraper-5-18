/**
 * Turns the two raw CSV exports into one canonical shape the matcher can work with.
 *
 * Timestamps are treated as *wall clock* values, not absolute instants. Both
 * exports stamp the same event with the same clock reading (a purchase logged at
 * 16:50:13 shows up on the card feed as 04:50:16PM), so we deliberately do not
 * apply any timezone conversion. If your two sources ever drift apart, use the
 * `chargeTimeOffsetMinutes` setting rather than reinterpreting the strings here.
 */

const PO_EXPORT_SIGNATURE = ['pos_po_id', 'payment_instrument_last_four', 'purchase_date'];
const INVENTORY_SIGNATURE = ['PO Id', 'PO Date', 'Total Cost', 'PO Payment State'];
const CHARGE_SIGNATURE = ['Last 4', 'Authorization Date (UTC)', 'Card Name'];

/**
 * Which export is this, from its header row?
 *
 *   po-export  — the per-ticket purchase order export (carries card last-four)
 *   inventory  — the Purchased Inventory export, one row per PO (no card)
 *   charges    — the card transaction export
 *
 * @param {string[]} headers
 * @returns {'po-export'|'inventory'|'charges'|null}
 */
export function detectFormat(headers) {
  const set = new Set(headers.map((h) => h.trim()));
  const hits = (signature) => signature.filter((h) => set.has(h)).length;

  const poHits = hits(PO_EXPORT_SIGNATURE);
  const invHits = hits(INVENTORY_SIGNATURE);
  const chargeHits = hits(CHARGE_SIGNATURE);
  const best = Math.max(poHits, invHits, chargeHits);

  if (best >= 2) {
    if (invHits === best) return 'inventory';
    if (poHits === best) return 'po-export';
    return 'charges';
  }
  // Fall back to single unmistakable columns.
  if (set.has('pos_po_id') || set.has('event_name')) return 'po-export';
  if (set.has('PO Id') || set.has('PO Payment State')) return 'inventory';
  if (set.has('Last 4') || set.has('Decline Reason')) return 'charges';
  return null;
}

/** Back-compat wrapper: the two purchase formats both produce purchases. */
export function detectKind(headers) {
  const format = detectFormat(headers);
  if (!format) return null;
  return format === 'charges' ? 'charges' : 'purchases';
}

/**
 * Parse every timestamp shape the three exports produce:
 *   "2026-08-26 16:50:13"              (24h — purchase order export)
 *   "2026-08-26 05:49:07PM"            (12h — card transactions)
 *   "8/26/2026 3:24:06 AM +00:00"      (US order with offset — Purchased Inventory)
 *   "2026-08-26"                       (date only)
 *   "2026-08-26T16:50:13Z"             (ISO, tolerated)
 *
 * A trailing UTC offset is applied when present, so a feed that stamps a real
 * offset lands on the same UTC reading as the card export. Everything without
 * an offset is taken at face value as wall clock — the three feeds agree on it.
 *
 * @param {string|number} value
 * @returns {number|null} epoch milliseconds
 */
export function parseTimestamp(value) {
  if (value === null || value === undefined || value === '') return null;
  const raw = String(value).trim();
  if (!raw) return null;

  // Spreadsheets sometimes hand back a date as an Excel serial number.
  if (/^\d{4,5}(\.\d+)?$/.test(raw)) {
    const serial = Number(raw);
    if (serial > 20000 && serial < 90000) {
      return Math.round((serial - 25569) * 86400000);
    }
  }

  const offsetMatch = raw.match(/([+-])(\d{2}):?(\d{2})$/);
  const offsetMs = offsetMatch
    ? (offsetMatch[1] === '-' ? 1 : -1) * (Number(offsetMatch[2]) * 60 + Number(offsetMatch[3])) * 60000
    : 0;

  // US order: 8/26/2026 3:24:06 AM
  const us = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:[T ,]+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM|am|pm)?)?/);
  if (us) {
    let hour = us[4] ? Number(us[4]) : 0;
    if (us[7]) {
      const upper = us[7].toUpperCase();
      if (upper === 'PM' && hour < 12) hour += 12;
      if (upper === 'AM' && hour === 12) hour = 0;
    }
    return (
      Date.UTC(Number(us[3]), Number(us[1]) - 1, Number(us[2]), hour, Number(us[5] || 0), Number(us[6] || 0)) + offsetMs
    );
  }

  const m = raw.match(
    /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM|am|pm)?)?/,
  );
  if (!m) {
    // Only fall back to the engine's own parser for something that at least
    // looks like a date. Without this guard a bare "142" becomes the year 142.
    if (!/[-/:a-zA-Z]/.test(raw)) return null;
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

  return (
    Date.UTC(Number(y), Number(mo) - 1, Number(d), hour, Number(min || 0), Number(sec || 0)) + offsetMs
  );
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
 * Reduce a vendor name or a card descriptor to a merchant tag.
 *
 * With the Purchased Inventory export there is no card last-four to tell two
 * same-amount purchases apart, so the merchant becomes the disambiguator:
 * a SeatGeek order can never be the TM charge sitting next to it.
 *
 * @param {string} text
 * @returns {'ticketmaster'|'seatgeek'|'stubhub'|'vividseats'|'axs'|''} '' means "cannot tell"
 */
export function merchantTag(text) {
  const s = clean(text).toLowerCase();
  if (!s) return '';
  if (s.includes('ticketmaster') || /\btm\b/.test(s) || s.startsWith('tm ') || s.includes('tm*')) return 'ticketmaster';
  if (s.includes('seatgeek')) return 'seatgeek';
  if (s.includes('stubhub')) return 'stubhub';
  if (s.includes('vivid')) return 'vividseats';
  if (s.includes('axs')) return 'axs';
  return ''; // "Unknown Vendor", a bank's generic descriptor, anything else
}

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
      source: 'po-export',
      id,
      label: clean(row.event_name) || (clean(row.pos_po_id) ? `PO ${clean(row.pos_po_id)}` : `Purchase ${id}`),
      vendor: '',
      merchant: '',
      paymentState: '',
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

/**
 * Normalize the Purchased Inventory export — one row per purchase order.
 *
 * This export trades detail for coverage: no event name, no card digits, but a
 * `PO Payment State` your POS believes and a `Vendor` the card descriptor can
 * be checked against. The trailing totals row (blank PO Id) is skipped.
 *
 * @param {Record<string,string>[]} rows
 * @returns {object[]}
 */
export function normalizeInventoryPurchases(rows) {
  const out = [];
  for (const row of rows) {
    const poId = clean(row['PO Id']);
    if (!poId || !/\d/.test(poId)) continue; // totals row, or a blank line

    const purchasedAt = parseTimestamp(row['PO Date']);
    const amount = parseAmount(row['Total Cost']) ?? 0;
    const vendor = clean(row.Vendor);

    out.push({
      kind: 'purchase',
      source: 'inventory',
      id: poId,
      label: `${vendor || 'Purchase'} · PO ${poId}`,
      poId,
      remoteId: '',
      legacyRemoteId: '',
      webId: '',
      account: clean(row['Vendor Account']),
      accountId: '',
      purchasedBy: clean(row['Purchased By']),
      vendor,
      merchant: merchantTag(vendor),
      paymentState: clean(row['PO Payment State']),
      event: '',
      eventDate: null,
      venue: '',
      seats: '',
      qty: Number(clean(row['Total Quantity'])) || 0,
      stockType: '',
      tags: '',
      brand: '',
      last4: '',
      amount,
      originalAmount: amount,
      websitePrice: parseAmount(row['Total Website Price']) ?? 0,
      refundedAmount: 0,
      refundStatus: '',
      status: clean(row['PO Payment State']),
      eventStatus: '',
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
      merchant: merchantTag(clean(row.Description) || clean(row['External Description'])),
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
export function normalizeParsed(parsed, forcedFormat) {
  const format = forcedFormat || detectFormat(parsed.headers);

  if (format === 'po-export') return { kind: 'purchases', format, records: normalizePurchases(parsed.rows) };
  if (format === 'inventory') return { kind: 'purchases', format, records: normalizeInventoryPurchases(parsed.rows) };
  if (format === 'charges') return { kind: 'charges', format, records: normalizeCharges(parsed.rows) };
  if (format === 'purchases') return { kind: 'purchases', format: 'po-export', records: normalizePurchases(parsed.rows) };

  throw new Error(
    'Could not tell what this file is. A purchase export needs a "pos_po_id" or "PO Id" column; ' +
      'a card transaction export needs a "Last 4" column.',
  );
}
