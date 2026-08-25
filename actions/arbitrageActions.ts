'use server';

/**
 * Ticket-count arbitrage detection.
 *
 * Within (event, section), scan every listing. Group by quantity.
 * If a listing at qty=N has a per-seat price meaningfully lower than
 * a listing at qty=M (M<N) in the same section, that's an arbitrage
 * opportunity: buy the larger pack, split into smaller packs, resell
 * at the smaller-pack floor.
 *
 * We emit one Alert per opportunity (deduped by section + qty pair
 * within a 15-minute window) with an estimated profit that accounts
 * for a configurable per-ticket fee.
 */

import dbConnect from '../lib/dbConnect';
import { ConsecutiveGroup, Alert, Event as EventModel } from '../models';

const MIN_SPREAD_PCT = 8;      // require at least 8% per-seat spread to fire
const FEE_PER_SEAT = 25;       // rough Automatiq/exchange sell fee per seat
const DEDUP_WINDOW_MS = 15 * 60 * 1000;

interface Listing {
  section: string;
  row: string;
  quantity: number;
  perSeatPrice: number;
  cost: number;      // total cost to buy the whole pack
  customSplit: string;
  listingId?: string;
}

export interface ArbitrageOpportunity {
  eventId: string;
  section: string;
  row: string;
  bigPack: { qty: number; perSeat: number; total: number; customSplit: string };
  smallPack: { qty: number; perSeat: number; total: number };
  spreadPct: number;
  estProfitTotal: number;
  detectedAt: Date;
}

function computeArbitrageForEvent(listings: Listing[]): ArbitrageOpportunity[] {
  const bySection = new Map<string, Listing[]>();
  for (const l of listings) {
    if (!l.section || !l.quantity || !l.perSeatPrice) continue;
    if (!bySection.has(l.section)) bySection.set(l.section, []);
    bySection.get(l.section)!.push(l);
  }

  const opps: Omit<ArbitrageOpportunity, 'eventId' | 'detectedAt'>[] = [];

  for (const [section, items] of bySection.entries()) {
    // Cheapest per-seat listing for each qty bucket
    const bestByQty = new Map<number, Listing>();
    for (const l of items) {
      const cur = bestByQty.get(l.quantity);
      if (!cur || l.perSeatPrice < cur.perSeatPrice) bestByQty.set(l.quantity, l);
    }
    const qtys = [...bestByQty.keys()].sort((a, b) => a - b);
    if (qtys.length < 2) continue;

    // For each smaller-pack qty, see if any larger-pack qty is cheaper per seat
    for (let i = 0; i < qtys.length; i++) {
      const smallQty = qtys[i];
      const small = bestByQty.get(smallQty)!;
      for (let j = i + 1; j < qtys.length; j++) {
        const bigQty = qtys[j];
        const big = bestByQty.get(bigQty)!;
        if (big.perSeatPrice >= small.perSeatPrice) continue;
        const spreadPct = ((small.perSeatPrice - big.perSeatPrice) / small.perSeatPrice) * 100;
        if (spreadPct < MIN_SPREAD_PCT) continue;

        // Estimated profit: buy bigQty at bigPack price, resell each split at smallPack floor
        // net = smallPerSeat * bigQty (revenue) - bigPack.cost (buy cost) - fees
        const revenue = small.perSeatPrice * bigQty;
        const fees = FEE_PER_SEAT * bigQty;
        const estProfit = revenue - big.cost - fees;
        if (estProfit <= 0) continue;

        opps.push({
          section,
          row: big.row,
          bigPack: {
            qty: bigQty,
            perSeat: big.perSeatPrice,
            total: big.cost,
            customSplit: big.customSplit,
          },
          smallPack: {
            qty: smallQty,
            perSeat: small.perSeatPrice,
            total: small.perSeatPrice * smallQty,
          },
          spreadPct: Math.round(spreadPct * 10) / 10,
          estProfitTotal: Math.round(estProfit),
        });
      }
    }
  }

  return opps.map((o) => ({
    ...o,
    eventId: '',
    detectedAt: new Date(),
  }));
}

interface EventDoc {
  _id: unknown;
  mapping_id: string;
  Event_Name?: string;
  event_name?: string;
  venue_name?: string;
  Event_DateTime?: string | Date;
  URL?: string;
}

interface ConsecutiveGroupDoc {
  event_id: unknown;
  inventory?: {
    section?: string;
    row?: string;
    quantity?: number;
    listPrice?: number;
    cost?: number;
    customSplit?: string;
  };
}

/**
 * Detect + persist arbitrage opportunities for a single event. Called
 * after each scrape cycle for that event.
 */
export async function detectArbitrageForEvent(eventMongoId: string) {
  await dbConnect();

  const event = (await EventModel.findById(eventMongoId).lean()) as EventDoc | null;
  if (!event) return { success: false, error: 'event not found' };

  const groups = (await ConsecutiveGroup.find(
    { event_id: eventMongoId },
    { 'inventory.section': 1, 'inventory.row': 1, 'inventory.quantity': 1,
      'inventory.listPrice': 1, 'inventory.cost': 1, 'inventory.customSplit': 1 },
  ).lean()) as unknown as ConsecutiveGroupDoc[];

  const listings: Listing[] = groups
    .filter((g) => g.inventory?.section && g.inventory?.quantity && g.inventory?.listPrice)
    .map((g) => ({
      section: g.inventory!.section!,
      row: g.inventory!.row || '',
      quantity: g.inventory!.quantity!,
      perSeatPrice: g.inventory!.listPrice!,
      cost: (g.inventory!.cost || g.inventory!.listPrice!) * g.inventory!.quantity!,
      customSplit: g.inventory!.customSplit || '',
    }));

  const opps = computeArbitrageForEvent(listings).map((o) => ({
    ...o,
    eventId: event.mapping_id,
  }));

  // Persist as Alerts. Dedup: skip if the same (eventId, section, bigQty, smallQty)
  // fired in the last DEDUP_WINDOW_MS.
  const since = new Date(Date.now() - DEDUP_WINDOW_MS);
  let inserted = 0;
  for (const o of opps) {
    const existing = await Alert.findOne({
      eventId: event.mapping_id,
      type: 'arbitrage',
      section: o.section,
      'payload.bigQty': o.bigPack.qty,
      'payload.smallQty': o.smallPack.qty,
      at: { $gte: since },
    }).lean();
    if (existing) continue;

    await Alert.create({
      eventId: event.mapping_id,
      eventName: event.Event_Name || event.event_name || '',
      venue: event.venue_name || '',
      eventDate: event.Event_DateTime ? new Date(event.Event_DateTime) : undefined,
      eventUrl: event.URL || '',
      type: 'arbitrage',
      section: o.section,
      row: o.row,
      price: o.bigPack.perSeat,
      sectionLow: o.smallPack.perSeat,
      undercutPct: o.spreadPct,
      payload: {
        bigQty: o.bigPack.qty,
        bigPerSeat: o.bigPack.perSeat,
        bigTotal: o.bigPack.total,
        smallQty: o.smallPack.qty,
        smallPerSeat: o.smallPack.perSeat,
        smallTotal: o.smallPack.total,
        spreadPct: o.spreadPct,
        estProfitTotal: o.estProfitTotal,
      },
      at: o.detectedAt,
    });
    inserted++;
  }

  return { success: true, opportunities: opps, inserted };
}

/**
 * Read currently-active arbitrage opportunities for an event.
 * Returns the latest opportunity per (section, bigQty, smallQty) tuple.
 */
export async function getActiveArbitrage(eventMappingId: string) {
  await dbConnect();
  const since = new Date(Date.now() - 60 * 60 * 1000); // last hour
  const alerts = (await Alert.find({
    eventId: eventMappingId,
    type: 'arbitrage',
    at: { $gte: since },
  })
    .sort({ at: -1 })
    .lean()) as Array<Record<string, unknown>>;

  const seen = new Set<string>();
  const opps: unknown[] = [];
  for (const a of alerts) {
    const payload = a.payload as { bigQty?: number; smallQty?: number } | undefined;
    const key = `${a.section}|${payload?.bigQty}|${payload?.smallQty}`;
    if (seen.has(key)) continue;
    seen.add(key);
    opps.push(a);
  }
  return { success: true, opportunities: opps };
}

export { computeArbitrageForEvent };
