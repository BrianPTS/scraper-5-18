/**
 * Builds the dashboard payload.
 *
 * Note the ordering: reconciliation always runs over the *whole* dataset and the
 * day filter is applied to the results afterwards. Doing it the other way round
 * would break every pair that straddles midnight — a purchase at 23:58 whose
 * authorization posts at 00:02 is one transaction, not two orphans.
 */

import { businessDay } from './normalize.js';
import { reconcile } from './match.js';

/**
 * @param {import('./store.js').Store} store
 * @param {{day?: string}} [query]
 */
export function buildReport(store, query = {}) {
  const purchases = store.purchases();
  const charges = store.charges();

  const full = reconcile({
    purchases,
    charges,
    options: store.settings,
    overrides: store.overrides,
  });

  const days = collectDays(purchases, charges);
  const day = query.day && query.day !== 'all' ? query.day : null;
  const scoped = day ? filterReportToDay(full, day) : full;

  return {
    generatedAt: new Date().toISOString(),
    day: day ?? 'all',
    days,
    coverage: assessCoverage(days, day, purchases, charges),
    counts: {
      purchases: purchases.length,
      charges: charges.length,
    },
    settings: store.settings,
    imports: store.data.imports.slice(0, 10),
    ...scoped,
  };
}

/**
 * Are the two feeds actually covering the same days?
 *
 * This matters more than it sounds. Export a week of purchases against one day
 * of card activity and the dashboard will report six days of "unpaid" orders
 * that are nothing of the sort. Naming the gap keeps a reporting artefact from
 * being read as missing money.
 *
 * @param {Array<{day: string, purchases: number, charges: number}>} days
 * @param {string|null} scopedDay
 */
export function assessCoverage(days, scopedDay, purchases = [], charges = []) {
  const relevant = scopedDay ? days.filter((d) => d.day === scopedDay) : days;

  // A day only counts as "missing" when the side that *is* there amounts to
  // something. A lone settlement that authorized the previous evening will
  // otherwise report the whole of yesterday as uncovered.
  const material = (count, total) => count >= 3 || (total > 0 && count / total > 0.1);
  const totalPurchases = purchases.length || days.reduce((n, d) => n + d.purchases, 0);
  const totalCharges = charges.length || days.reduce((n, d) => n + d.charges, 0);

  const missingCharges = relevant
    .filter((d) => d.charges === 0 && material(d.purchases, totalPurchases))
    .map((d) => d.day);
  const missingPurchases = relevant
    .filter((d) => d.purchases === 0 && material(d.charges, totalCharges))
    .map((d) => d.day);
  const both = relevant.filter((d) => d.purchases > 0 && d.charges > 0).map((d) => d.day);

  // Whole missing days are the obvious case. The subtler one — and the one that
  // actually bites — is two exports that share a day but stop at different
  // times: pull purchases up to 03:24 against card activity running to 17:49
  // and the afternoon's orders look unpaid when they are simply not in the file.
  const range = (rows, key) => {
    const stamps = rows.map((r) => r[key]).filter((t) => typeof t === 'number' && !Number.isNaN(t));
    return stamps.length ? { from: Math.min(...stamps), to: Math.max(...stamps) } : null;
  };

  const purchaseRange = range(purchases, 'purchasedAt');
  const chargeRange = range(charges, 'occurredAt');
  let overlap = null;
  let trimmed = null;

  if (purchaseRange && chargeRange) {
    const from = Math.max(purchaseRange.from, chargeRange.from);
    const to = Math.min(purchaseRange.to, chargeRange.to);
    overlap = to >= from ? { from, to } : null;

    // Judge the mismatch by how many rows actually fall outside, not by the
    // extremes: one stray refund from last night is not a coverage problem,
    // while forty orders the card export never reached certainly is.
    // An hour of slack at each end absorbs the lag between the two feeds.
    const SLACK = 60 * 60 * 1000;
    const outside = (rows, key, range) =>
      rows.filter((r) => typeof r[key] === 'number' && (r[key] < range.from - SLACK || r[key] > range.to + SLACK))
        .length;

    const purchasesOutside = outside(purchases, 'purchasedAt', chargeRange);
    const chargesOutside = outside(charges, 'occurredAt', purchaseRange);
    const material = (count, total) => count >= 2 && count / total > 0.1;

    if (material(purchasesOutside, purchases.length) || material(chargesOutside, charges.length)) {
      trimmed = {
        purchasesOutside,
        chargesOutside,
        purchaseCount: purchases.length,
        chargeCount: charges.length,
      };
    }
  }

  return {
    daysMissingCharges: missingCharges,
    daysMissingPurchases: missingPurchases,
    daysWithBoth: both,
    purchaseRange,
    chargeRange,
    overlap,
    misalignedWindows: trimmed,
    complete: missingCharges.length === 0 && missingPurchases.length === 0 && !trimmed,
  };
}

/** Every day present in either feed, newest first. */
export function collectDays(purchases, charges) {
  const seen = new Map();
  const bump = (day, key) => {
    if (!day) return;
    if (!seen.has(day)) seen.set(day, { day, purchases: 0, charges: 0 });
    seen.get(day)[key] += 1;
  };
  for (const p of purchases) bump(p.day || businessDay(p.purchasedAt), 'purchases');
  for (const c of charges) bump(c.day || businessDay(c.occurredAt), 'charges');
  return [...seen.values()].sort((a, b) => b.day.localeCompare(a.day));
}

/**
 * Keep only the rows belonging to `day`. A match belongs to a day if *either*
 * side of it does, so a cross-midnight pair shows up on both days rather than
 * vanishing from both.
 */
export function filterReportToDay(report, day) {
  const onDay = (ms) => businessDay(ms) === day;

  const matches = report.matches.filter(
    (m) => onDay(m.purchase.purchasedAt) || onDay(m.charge.occurredAt),
  );
  const unmatchedPurchases = report.unmatchedPurchases.filter((p) => onDay(p.purchasedAt));
  const unmatchedCharges = report.unmatchedCharges.filter((c) => onDay(c.occurredAt));
  const declines = report.declines.filter((c) => onDay(c.occurredAt));
  const reversals = report.reversals.filter((c) => onDay(c.occurredAt));
  const credits = report.credits.filter((c) => onDay(c.occurredAt));
  const zeroAmountPurchases = report.zeroAmountPurchases.filter((p) => onDay(p.purchasedAt));

  const dayPurchases = [
    ...matches.filter((m) => onDay(m.purchase.purchasedAt)).map((m) => m.purchase),
    ...unmatchedPurchases,
    ...zeroAmountPurchases,
  ];
  const dayCharges = [
    ...matches.filter((m) => onDay(m.charge.occurredAt)).map((m) => m.charge),
    ...unmatchedCharges,
    ...declines,
    ...reversals,
    ...credits,
  ];

  return {
    ...report,
    matches,
    unmatchedPurchases,
    unmatchedCharges,
    declines,
    reversals,
    credits,
    zeroAmountPurchases,
    totals: recomputeTotals({
      purchases: dayPurchases,
      charges: dayCharges,
      matches,
      unmatchedPurchases,
      unmatchedCharges,
      declines,
      reversals,
      credits,
      zeroAmountPurchases,
    }),
  };
}

function sum(rows, pick) {
  return Number(rows.reduce((acc, row) => acc + (pick(row) || 0), 0).toFixed(2));
}

function recomputeTotals({
  purchases,
  charges,
  matches,
  unmatchedPurchases,
  unmatchedCharges,
  declines,
  reversals,
  credits,
  zeroAmountPurchases,
}) {
  const matchedPurchaseTotal = sum(matches, (m) => m.purchase.amount);
  const matchedChargeTotal = sum(matches, (m) => m.charge.amount);
  const unmatchedPurchaseTotal = sum(unmatchedPurchases, (p) => p.amount);
  const unmatchedChargeTotal = sum(unmatchedCharges, (c) => c.amount);
  const denominator = matches.length + unmatchedPurchases.length + unmatchedCharges.length;

  return {
    purchaseCount: purchases.length,
    purchaseTotal: sum(purchases, (p) => p.amount),
    chargeCount: charges.filter((c) => c.capturing && c.direction === 'debit').length,
    chargeTotal: sum(
      charges.filter((c) => c.capturing && c.direction === 'debit'),
      (c) => c.amount,
    ),
    matchedCount: matches.length,
    matchedPurchaseTotal,
    matchedChargeTotal,
    matchedVariance: Number((matchedChargeTotal - matchedPurchaseTotal).toFixed(2)),
    unmatchedPurchaseCount: unmatchedPurchases.length,
    unmatchedPurchaseTotal,
    unmatchedChargeCount: unmatchedCharges.length,
    unmatchedChargeTotal,
    netExposure: Number((unmatchedChargeTotal - unmatchedPurchaseTotal).toFixed(2)),
    declineCount: declines.length,
    declineTotal: sum(declines, (c) => c.amount),
    reversalCount: reversals.length,
    reversalTotal: sum(reversals, (c) => c.amount),
    creditCount: credits.length,
    creditTotal: sum(credits, (c) => c.amount),
    zeroAmountCount: zeroAmountPurchases.length,
    posSaysUnpaidButCharged: matches.filter((m) => m.flags?.includes('pos-says-unpaid')).length,
    posSaysPaidButNoCharge: unmatchedPurchases.filter((p) => (p.paymentState || '').toLowerCase() === 'paid').length,
    needsReviewCount: matches.filter((m) => m.confidence === 'review' || m.ambiguous).length,
    matchRate: denominator === 0 ? 0 : Number(((matches.length / denominator) * 100).toFixed(1)),
  };
}
