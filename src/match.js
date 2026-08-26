/**
 * Reconciliation engine: pairs purchases against card charges.
 *
 * Strategy, in order of trust:
 *   1. Manual links the user made in the dashboard always win and are never
 *      second-guessed.
 *   2. Everything else is scored. A pair is only ever *considered* when the
 *      amounts agree (within tolerance), the timestamps are inside the window,
 *      and the last-four digits do not actively contradict each other.
 *   3. Candidates are assigned best-first, greedily. Because the score is a
 *      total order with deterministic tie-breaks, the result is stable across
 *      runs — the same input always produces the same pairing.
 *
 * The greedy pass is deliberate: with real data the top candidate is nearly
 * always unambiguous (same card, same cent amount, seconds apart), and a greedy
 * assignment is far easier to explain to a human reviewing the output than an
 * optimal-cost assignment that shuffles pairs to minimise a global total.
 * Where it *is* ambiguous we say so, via the `ambiguous` flag, instead of
 * silently picking.
 */

export const DEFAULT_OPTIONS = {
  /** Cents of slack allowed between a purchase and a charge. 0 = exact match. */
  amountTolerance: 0,
  /** How far apart the two timestamps may be before a pair is impossible. */
  timeWindowMinutes: 240,
  /** Added to every charge timestamp; use if your two feeds sit in different zones. */
  chargeTimeOffsetMinutes: 0,
  /** When true, a purchase with no last-four on file can never auto-match. */
  requireLast4: false,
  /** Purchases at or below this amount are expected to have no card charge. */
  zeroAmountThreshold: 0,
};

const MINUTE = 60 * 1000;

/** Score bonuses. Kept as named constants so the ordering is auditable. */
const SCORE = {
  last4Match: 10_000,
  exactAmount: 1_000,
  /** Weaker than the card — a merchant only has a handful of values — but real. */
  merchantMatch: 500,
  settled: 50,
  /** Each minute of separation costs a point; 240-minute window < any bonus. */
  minutePenalty: 1,
};

/**
 * Do a purchase and a charge come from merchants that cannot both be true?
 * Only fires when both sides are identifiable — "Unknown Vendor" vetoes nothing.
 */
function merchantConflict(purchase, charge) {
  return Boolean(purchase.merchant && charge.merchant && purchase.merchant !== charge.merchant);
}

function merchantAgrees(purchase, charge) {
  return Boolean(purchase.merchant && charge.merchant && purchase.merchant === charge.merchant);
}

/**
 * @param {object} args
 * @param {Array<object>} args.purchases
 * @param {Array<object>} args.charges
 * @param {object} [args.options]
 * @param {{links?: Array<{purchaseId: string, chargeId: string, note?: string}>,
 *          ignoredPurchases?: string[], ignoredCharges?: string[]}} [args.overrides]
 * @returns {object} reconciliation report
 */
export function reconcile({ purchases = [], charges = [], options = {}, overrides = {} }) {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const links = overrides.links ?? [];
  const ignoredPurchases = new Set(overrides.ignoredPurchases ?? []);
  const ignoredCharges = new Set(overrides.ignoredCharges ?? []);

  const purchaseById = new Map(purchases.map((p) => [p.id, p]));
  const chargeById = new Map(charges.map((c) => [c.id, c]));

  const matches = [];
  const takenPurchases = new Set();
  const takenCharges = new Set();

  // --- 1. Manual links -------------------------------------------------------
  for (const link of links) {
    const purchase = purchaseById.get(link.purchaseId);
    const charge = chargeById.get(link.chargeId);
    if (!purchase || !charge) continue; // stale link, e.g. data was re-imported
    if (takenPurchases.has(purchase.id) || takenCharges.has(charge.id)) continue;
    takenPurchases.add(purchase.id);
    takenCharges.add(charge.id);
    matches.push(buildMatch(purchase, charge, opts, { method: 'manual', note: link.note }));
  }

  // --- 2. Bucket everything that is not eligible for auto-matching -----------
  const zeroAmountPurchases = [];
  const ignoredPurchaseRows = [];
  const eligiblePurchases = [];

  for (const p of purchases) {
    if (takenPurchases.has(p.id)) continue;
    if (ignoredPurchases.has(p.id)) {
      ignoredPurchaseRows.push(p);
      continue;
    }
    if (p.amount <= opts.zeroAmountThreshold) {
      zeroAmountPurchases.push(p);
      continue;
    }
    eligiblePurchases.push(p);
  }

  const declines = [];
  const reversals = [];
  const credits = [];
  const ignoredChargeRows = [];
  const eligibleCharges = [];

  for (const c of charges) {
    if (takenCharges.has(c.id)) continue;
    if (ignoredCharges.has(c.id)) {
      ignoredChargeRows.push(c);
      continue;
    }
    if (c.type === 'card_decline' || c.status === 'declined') {
      declines.push(c);
      continue;
    }
    if (!c.capturing) {
      reversals.push(c);
      continue;
    }
    if (c.direction === 'credit') {
      credits.push(c);
      continue;
    }
    eligibleCharges.push(c);
  }

  // --- 3. Candidate generation ----------------------------------------------
  const windowMs = opts.timeWindowMinutes * MINUTE;
  const candidates = [];
  const candidateCountByPurchase = new Map();

  // Bucket charges by cent-amount so we do not compare every pair when the
  // tolerance is zero (the common case).
  const chargesByCents = new Map();
  for (const c of eligibleCharges) {
    const cents = toCents(c.amount);
    if (!chargesByCents.has(cents)) chargesByCents.set(cents, []);
    chargesByCents.get(cents).push(c);
  }
  const toleranceCents = Math.round(opts.amountTolerance * 100);

  for (const p of eligiblePurchases) {
    const pCents = toCents(p.amount);
    const pool =
      toleranceCents === 0
        ? chargesByCents.get(pCents) ?? []
        : eligibleCharges.filter((c) => Math.abs(toCents(c.amount) - pCents) <= toleranceCents);

    for (const c of pool) {
      if (p.purchasedAt === null || c.occurredAt === null) continue;
      const delta = chargeTime(c, opts) - p.purchasedAt;
      if (Math.abs(delta) > windowMs) continue;

      const last4Agree = p.last4 && c.last4 && p.last4 === c.last4;
      const last4Conflict = p.last4 && c.last4 && p.last4 !== c.last4;
      if (last4Conflict) continue; // different card: never the same transaction
      if (merchantConflict(p, c)) continue; // a SeatGeek order is not a TM charge
      if (opts.requireLast4 && !last4Agree) continue;

      const amountCents = Math.abs(toCents(c.amount) - pCents);
      let score = -Math.abs(delta / MINUTE) * SCORE.minutePenalty;
      if (last4Agree) score += SCORE.last4Match;
      if (amountCents === 0) score += SCORE.exactAmount;
      if (merchantAgrees(p, c)) score += SCORE.merchantMatch;
      if (c.status === 'settled') score += SCORE.settled;

      candidates.push({ purchase: p, charge: c, score, delta, last4Agree, amountCents });
      candidateCountByPurchase.set(p.id, (candidateCountByPurchase.get(p.id) ?? 0) + 1);
    }
  }

  // Best first; ties broken deterministically so runs are reproducible.
  candidates.sort(
    (a, b) =>
      b.score - a.score ||
      Math.abs(a.delta) - Math.abs(b.delta) ||
      a.purchase.id.localeCompare(b.purchase.id) ||
      a.charge.id.localeCompare(b.charge.id),
  );

  // --- 4. Greedy assignment --------------------------------------------------
  // A purchase is flagged ambiguous when a *rival* candidate scored identically:
  // same card, same amount, same distance. That is the case a human should see.
  const bestScoreByPurchase = new Map();
  for (const cand of candidates) {
    const prev = bestScoreByPurchase.get(cand.purchase.id);
    if (prev === undefined || cand.score > prev.score) {
      bestScoreByPurchase.set(cand.purchase.id, { score: cand.score, count: 1 });
    } else if (cand.score === prev.score) {
      prev.count += 1;
    }
  }

  for (const cand of candidates) {
    if (takenPurchases.has(cand.purchase.id) || takenCharges.has(cand.charge.id)) continue;
    takenPurchases.add(cand.purchase.id);
    takenCharges.add(cand.charge.id);
    const ambiguous = (bestScoreByPurchase.get(cand.purchase.id)?.count ?? 1) > 1;
    matches.push(
      buildMatch(cand.purchase, cand.charge, opts, {
        method: 'auto',
        ambiguous,
        candidateCount: candidateCountByPurchase.get(cand.purchase.id) ?? 1,
      }),
    );
  }

  // --- 5. Leftovers ----------------------------------------------------------
  const unmatchedPurchases = eligiblePurchases
    .filter((p) => !takenPurchases.has(p.id))
    .map((p) => ({
      ...p,
      reason: explainUnmatchedPurchase(p, eligibleCharges, declines, reversals, opts),
      candidates: rankCandidates(p, eligibleCharges, takenCharges, opts),
    }));

  const unmatchedCharges = eligibleCharges
    .filter((c) => !takenCharges.has(c.id))
    .map((c) => ({
      ...c,
      reason: explainUnmatchedCharge(c, eligiblePurchases, opts),
      candidates: rankCandidatesForCharge(c, eligiblePurchases, takenPurchases, opts),
    }));

  matches.sort((a, b) => (b.purchase.purchasedAt ?? 0) - (a.purchase.purchasedAt ?? 0));
  unmatchedPurchases.sort((a, b) => (b.purchasedAt ?? 0) - (a.purchasedAt ?? 0));
  unmatchedCharges.sort((a, b) => (b.occurredAt ?? 0) - (a.occurredAt ?? 0));

  return {
    options: opts,
    matches,
    unmatchedPurchases,
    unmatchedCharges,
    declines: declines.slice().sort((a, b) => (b.occurredAt ?? 0) - (a.occurredAt ?? 0)),
    reversals: reversals.slice().sort((a, b) => (b.occurredAt ?? 0) - (a.occurredAt ?? 0)),
    credits: credits.slice().sort((a, b) => (b.occurredAt ?? 0) - (a.occurredAt ?? 0)),
    zeroAmountPurchases: zeroAmountPurchases
      .slice()
      .sort((a, b) => (b.purchasedAt ?? 0) - (a.purchasedAt ?? 0)),
    ignored: { purchases: ignoredPurchaseRows, charges: ignoredChargeRows },
    totals: buildTotals({
      purchases,
      charges,
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

function toCents(amount) {
  return Math.round((Number(amount) || 0) * 100);
}

function chargeTime(charge, opts) {
  if (charge.occurredAt === null || charge.occurredAt === undefined) return null;
  return charge.occurredAt + opts.chargeTimeOffsetMinutes * MINUTE;
}

function buildMatch(purchase, charge, opts, extra = {}) {
  const delta =
    purchase.purchasedAt !== null && charge.occurredAt !== null
      ? chargeTime(charge, opts) - purchase.purchasedAt
      : null;
  const deltaMinutes = delta === null ? null : delta / MINUTE;
  const amountDiff = Number((charge.amount - purchase.amount).toFixed(2));
  const last4Agree = Boolean(purchase.last4 && charge.last4 && purchase.last4 === charge.last4);
  const merchantAgree = merchantAgrees(purchase, charge);

  // Your POS's opinion of whether the PO was paid, against what the card did.
  // A charge exists here by definition, so "NotPaid" is the discrepancy.
  const flags = [];
  const state = (purchase.paymentState || '').toLowerCase();
  if (state === 'notpaid' || state === 'not paid') flags.push('pos-says-unpaid');
  if (state === 'refund needed') flags.push('pos-says-refund-needed');

  return {
    id: `${purchase.id}::${charge.id}`,
    purchase,
    charge,
    delta,
    deltaMinutes,
    amountDiff,
    last4Agree,
    merchantAgree,
    flags,
    confidence:
      extra.method === 'manual'
        ? 'manual'
        : gradeConfidence({ last4Agree, merchantAgree, amountDiff, deltaMinutes }),
    method: extra.method ?? 'auto',
    ambiguous: Boolean(extra.ambiguous),
    candidateCount: extra.candidateCount ?? 1,
    note: extra.note ?? '',
  };
}

/**
 * How much should a human trust this pair?
 *   exact   – same card, same cent amount, within a few minutes. Nothing to check.
 *   likely  – one strong signal missing (usually no last-four on the purchase side),
 *             but something else corroborates: a very close time, or the merchant.
 *   review  – amounts differ, or the only evidence is a coincidental amount+time.
 *
 * The card stays the only route to "exact". A merchant is a much weaker identity
 * — there are only a handful of them — so it lifts a pair out of "review" but
 * never all the way to certainty.
 */
function gradeConfidence({ last4Agree, merchantAgree, amountDiff, deltaMinutes }) {
  const minutes = deltaMinutes === null ? Infinity : Math.abs(deltaMinutes);
  if (amountDiff !== 0) return 'review';
  if (last4Agree && minutes <= 30) return 'exact';
  if (last4Agree || minutes <= 10) return 'likely';
  if (merchantAgree && minutes <= 60) return 'likely';
  return 'review';
}

function explainUnmatchedPurchase(purchase, charges, declines, reversals, opts) {
  const cents = toCents(purchase.amount);
  const sameAmount = charges.filter((c) => Math.abs(toCents(c.amount) - cents) <= Math.round(opts.amountTolerance * 100));

  // When the POS says this PO is paid and no charge backs it up, lead with that
  // — it is the discrepancy worth chasing, not a detail of the search.
  const claimsPaid = (purchase.paymentState || '').toLowerCase() === 'paid';
  const prefix = claimsPaid ? 'Marked Paid in your POS, but ' : '';
  const open = (sentence) => (prefix ? prefix + sentence.charAt(0).toLowerCase() + sentence.slice(1) : sentence);

  if (sameAmount.length === 0) {
    const declined = [...declines, ...reversals].find((c) => toCents(c.amount) === cents);
    if (declined) {
      return declined.type === 'card_decline'
        ? `A ${money(purchase.amount)} charge on card ${declined.last4} was DECLINED (${declined.declineReason || 'no reason given'}) — this purchase may not be paid for.`
        : `A matching ${money(purchase.amount)} authorization on card ${declined.last4} was reversed.`;
    }
    return open('No card charge for this amount has been imported yet.');
  }

  const sameCard = sameAmount.filter((c) => !purchase.last4 || !c.last4 || c.last4 === purchase.last4);
  if (sameCard.length === 0) {
    return open(`Charges exist for ${money(purchase.amount)} but all are on different cards (purchase used ${purchase.last4}).`);
  }

  const sameMerchant = sameCard.filter((c) => !purchase.merchant || !c.merchant || c.merchant === purchase.merchant);
  if (sameMerchant.length === 0) {
    return open(
      `Charges exist for ${money(purchase.amount)} but none from ${purchase.vendor || purchase.merchant} — this order was bought there.`,
    );
  }

  const withinWindow = sameMerchant.filter(
    (c) =>
      purchase.purchasedAt !== null &&
      c.occurredAt !== null &&
      Math.abs(chargeTime(c, opts) - purchase.purchasedAt) <= opts.timeWindowMinutes * MINUTE,
  );
  if (withinWindow.length === 0) {
    return open(`A ${money(purchase.amount)} charge exists but outside the ${opts.timeWindowMinutes}-minute window.`);
  }
  return open('A candidate charge exists but was claimed by a closer-matching purchase.');
}

function explainUnmatchedCharge(charge, purchases, opts) {
  const cents = toCents(charge.amount);
  const sameAmount = purchases.filter(
    (p) => Math.abs(toCents(p.amount) - cents) <= Math.round(opts.amountTolerance * 100),
  );
  if (sameAmount.length === 0) {
    return 'No purchase for this amount has been imported — either the purchase feed is behind, or this charge is not a ticket buy.';
  }
  const sameCard = sameAmount.filter((p) => !p.last4 || !charge.last4 || p.last4 === charge.last4);
  if (sameCard.length === 0) {
    return `Purchases exist for ${money(charge.amount)} but none on card ${charge.last4}.`;
  }
  const sameMerchant = sameCard.filter((p) => !p.merchant || !charge.merchant || p.merchant === charge.merchant);
  if (sameMerchant.length === 0) {
    return `Purchases exist for ${money(charge.amount)} but none of them were bought from this merchant.`;
  }
  return 'A candidate purchase exists but was claimed by a closer-matching charge.';
}

/** Best few charges a human could plausibly link this purchase to. */
function rankCandidates(purchase, charges, takenCharges, opts, limit = 5) {
  return charges
    .filter((c) => !takenCharges.has(c.id))
    .map((c) => ({
      id: c.id,
      description: c.description,
      cardName: c.cardName,
      last4: c.last4,
      amount: c.amount,
      occurredAt: c.occurredAt,
      status: c.status,
      amountDiff: Number((c.amount - purchase.amount).toFixed(2)),
      deltaMinutes:
        purchase.purchasedAt !== null && c.occurredAt !== null
          ? (chargeTime(c, opts) - purchase.purchasedAt) / MINUTE
          : null,
      last4Agree: Boolean(purchase.last4 && c.last4 && purchase.last4 === c.last4),
      merchantAgree: merchantAgrees(purchase, c),
      merchantConflict: merchantConflict(purchase, c),
    }))
    .sort(
      (a, b) =>
        Math.abs(a.amountDiff) - Math.abs(b.amountDiff) ||
        Number(b.last4Agree) - Number(a.last4Agree) ||
        Number(b.merchantAgree) - Number(a.merchantAgree) ||
        Math.abs(a.deltaMinutes ?? Infinity) - Math.abs(b.deltaMinutes ?? Infinity),
    )
    .slice(0, limit);
}

/** Best few purchases a human could plausibly link this charge to. */
function rankCandidatesForCharge(charge, purchases, takenPurchases, opts, limit = 5) {
  return purchases
    .filter((p) => !takenPurchases.has(p.id))
    .map((p) => ({
      id: p.id,
      event: p.event,
      account: p.account,
      last4: p.last4,
      amount: p.amount,
      purchasedAt: p.purchasedAt,
      poId: p.poId,
      label: p.label,
      vendor: p.vendor,
      paymentState: p.paymentState,
      amountDiff: Number((charge.amount - p.amount).toFixed(2)),
      deltaMinutes:
        p.purchasedAt !== null && charge.occurredAt !== null
          ? (chargeTime(charge, opts) - p.purchasedAt) / MINUTE
          : null,
      last4Agree: Boolean(p.last4 && charge.last4 && p.last4 === charge.last4),
      merchantAgree: merchantAgrees(p, charge),
      merchantConflict: merchantConflict(p, charge),
    }))
    .sort(
      (a, b) =>
        Math.abs(a.amountDiff) - Math.abs(b.amountDiff) ||
        Number(b.last4Agree) - Number(a.last4Agree) ||
        Number(b.merchantAgree) - Number(a.merchantAgree) ||
        Math.abs(a.deltaMinutes ?? Infinity) - Math.abs(b.deltaMinutes ?? Infinity),
    )
    .slice(0, limit);
}

function sum(rows, pick) {
  return Number(rows.reduce((acc, row) => acc + (pick(row) || 0), 0).toFixed(2));
}

function buildTotals({
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

  const reviewCount = matches.filter((m) => m.confidence === 'review' || m.ambiguous).length;
  const denominator = matches.length + unmatchedPurchases.length + unmatchedCharges.length;

  return {
    purchaseCount: purchases.length,
    purchaseTotal: sum(purchases, (p) => p.amount),
    chargeCount: charges.length,
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
    // Where your POS's payment state disagrees with what the cards actually did.
    posSaysUnpaidButCharged: matches.filter((m) => m.flags?.includes('pos-says-unpaid')).length,
    posSaysPaidButNoCharge: unmatchedPurchases.filter(
      (p) => (p.paymentState || '').toLowerCase() === 'paid',
    ).length,
    needsReviewCount: reviewCount,
    matchRate: denominator === 0 ? 0 : Number(((matches.length / denominator) * 100).toFixed(1)),
  };
}

function money(amount) {
  return `$${(Number(amount) || 0).toFixed(2)}`;
}
