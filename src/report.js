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
    counts: {
      purchases: purchases.length,
      charges: charges.length,
    },
    settings: store.settings,
    imports: store.data.imports.slice(0, 10),
    ...scoped,
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
    needsReviewCount: matches.filter((m) => m.confidence === 'review' || m.ambiguous).length,
    matchRate: denominator === 0 ? 0 : Number(((matches.length / denominator) * 100).toFixed(1)),
  };
}
