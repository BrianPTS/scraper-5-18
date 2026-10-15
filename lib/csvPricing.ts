/**
 * CSV list price and the stale-event markup.
 *
 * The scraper stores `inventory.cost` (Ticketmaster's fee-inclusive price) and
 * `inventory.listPrice` (cost with the event's default markup applied at scrape time).
 * Pricing the CSV from cost and the event's *current* markup means a markup change
 * reaches the next CSV on the same inventory ID, just like the per-type adjustments
 * always have, instead of waiting for the scraper to rewrite (and used to relist) rows.
 *
 * Stale events: an event the scraper has not refreshed for `staleMinutes` stays in the
 * CSV, priced at STALE_MARKUP_PCT so nothing sells at an old price, instead of dropping
 * out of the CSV (which deleted its listings). Once the scraper refreshes it again within
 * STALE_RECOVER_MINUTES, the event's own markup comes back. Nothing about the event's
 * markup settings is changed, so "back to the previous markup" is automatic.
 */

export const STALE_MARKUP_PCT = 1000;
export const STALE_RECOVER_MINUTES = 3;

/** The scraper's markup rule (playwright helpers/rowPrice.js applyMarkup). */
export function scraperMarkup(cost: number, pct: number): number {
  return cost < 35 ? cost + 15 : cost * (1 + pct / 100);
}

/**
 * @param cost      inventory.cost (TM price); falls back to listPrice when missing
 * @param listPrice inventory.listPrice as stored by the scraper
 * @param defaultPct the event's default markup now
 * @param adj       per-type adjustment (standard / resale / broker)
 * @param stale     price the event at STALE_MARKUP_PCT instead
 */
export function csvListPrice({
  cost, listPrice, defaultPct, adj, stale = false,
}: { cost?: number | null; listPrice: number; defaultPct: number; adj: number; stale?: boolean }): number {
  const base = typeof cost === 'number' && cost > 0 ? scraperMarkup(cost, defaultPct) : listPrice;
  const totalPct = stale ? STALE_MARKUP_PCT : defaultPct + adj;
  if (totalPct === defaultPct) return base;
  return base * (1 + totalPct / 100) / (1 + defaultPct / 100);
}

/**
 * Next stale state of an event. Goes stale after `staleMinutes` without a scraper
 * refresh; recovers only once a refresh is within STALE_RECOVER_MINUTES.
 */
export function nextStaleState(
  wasStale: boolean, lastRefresh: Date | null | undefined, staleMinutes: number, now = Date.now(),
): boolean {
  if (!(staleMinutes > 0)) return false;
  const ageMin = lastRefresh ? (now - new Date(lastRefresh).getTime()) / 60000 : Infinity;
  if (ageMin > staleMinutes) return true;
  if (wasStale) return ageMin > STALE_RECOVER_MINUTES;
  return false;
}
