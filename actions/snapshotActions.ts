'use server';

/**
 * Writes one InventorySnapshot row per event per ~15 min bucket by
 * aggregating the current ConsecutiveGroup contents.
 *
 * Called from a scheduler (`app/api/inventory-snapshot/route.ts`) or
 * from the scraper post-cycle hook. Idempotent per (eventId, 15-min
 * bucket): if a snapshot for the current bucket already exists, we
 * update it instead of inserting a new one.
 */

import dbConnect from '../lib/dbConnect';
import { ConsecutiveGroup, InventorySnapshot, Event as EventModel } from '../models';

const BUCKET_MS = 15 * 60 * 1000;

function bucketStart(ts: number): Date {
  return new Date(Math.floor(ts / BUCKET_MS) * BUCKET_MS);
}

interface GroupDoc {
  event_id: unknown;
  seats?: unknown[];
  inventory?: {
    section?: string;
    row?: string;
    quantity?: number;
    listPrice?: number;
    seatType?: string;
    productType?: string;
  };
}

interface EventDoc { _id: unknown; mapping_id: string }

export async function writeInventorySnapshotForEvent(eventMongoId: string) {
  await dbConnect();

  const event = (await EventModel.findById(eventMongoId, { mapping_id: 1 }).lean()) as EventDoc | null;
  if (!event) return { success: false, error: 'event not found' };

  const groups = (await ConsecutiveGroup.find({ event_id: eventMongoId }, {
    'inventory.section': 1, 'inventory.row': 1, 'inventory.quantity': 1,
    'inventory.listPrice': 1, 'inventory.seatType': 1, 'inventory.productType': 1,
  }).lean()) as unknown as GroupDoc[];

  if (groups.length === 0) {
    return { success: true, skipped: true, reason: 'no inventory' };
  }

  const prices: number[] = [];
  const sectionAgg = new Map<string, { count: number; prices: number[] }>();
  let getInPrice = Infinity;
  let getInSection = '', getInRow = '', getInQty = 0;
  let totalSeats = 0;

  for (const g of groups) {
    const inv = g.inventory;
    if (!inv?.section || !inv?.listPrice || !inv?.quantity) continue;
    const p = inv.listPrice;
    prices.push(p);
    totalSeats += inv.quantity;
    if (p < getInPrice) {
      getInPrice = p;
      getInSection = inv.section;
      getInRow = inv.row || '';
      getInQty = inv.quantity;
    }
    if (!sectionAgg.has(inv.section)) sectionAgg.set(inv.section, { count: 0, prices: [] });
    const s = sectionAgg.get(inv.section)!;
    s.count += 1;
    s.prices.push(p);
  }

  const sortedPrices = [...prices].sort((a, b) => a - b);
  const median = sortedPrices.length
    ? sortedPrices[Math.floor(sortedPrices.length / 2)]
    : 0;
  const avg = prices.length ? prices.reduce((s, p) => s + p, 0) / prices.length : 0;

  const bySection = [...sectionAgg.entries()].map(([section, s]) => ({
    section,
    count: s.count,
    minPrice: Math.min(...s.prices),
    avgPrice: s.prices.reduce((sum, p) => sum + p, 0) / s.prices.length,
  }));

  const snapshotAt = bucketStart(Date.now());

  await InventorySnapshot.findOneAndUpdate(
    { eventId: event.mapping_id, snapshotAt },
    {
      $set: {
        totalListings: groups.length,
        totalSeats,
        minPrice: sortedPrices[0] ?? 0,
        maxPrice: sortedPrices[sortedPrices.length - 1] ?? 0,
        medianPrice: median,
        avgPrice: Math.round(avg * 100) / 100,
        getInPrice: getInPrice === Infinity ? 0 : getInPrice,
        getInSection,
        getInRow,
        getInQty,
        bySection,
      },
    },
    { upsert: true, new: true },
  );

  return { success: true, snapshotAt, totalListings: groups.length };
}

/**
 * Batch snapshot writer. Iterates over all active events and writes a
 * snapshot for each. Intended to be called by a 15-min cron.
 */
export async function writeSnapshotsForAllActiveEvents() {
  await dbConnect();
  const events = (await EventModel.find(
    { Skip_Scraping: { $ne: true } },
    { _id: 1 },
  ).lean()) as Array<{ _id: unknown }>;

  let written = 0, skipped = 0, errored = 0;
  for (const e of events) {
    try {
      const r = await writeInventorySnapshotForEvent(String(e._id));
      if (r?.success && !r?.skipped) written++;
      else skipped++;
    } catch {
      errored++;
    }
  }
  return { success: true, total: events.length, written, skipped, errored };
}
