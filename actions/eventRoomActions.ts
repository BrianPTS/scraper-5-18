'use server';

/**
 * Combined data-fetch for the Event Room dashboard. One server action
 * returns everything the client needs on mount + every polling tick.
 */

import dbConnect from '../lib/dbConnect';
import { Alert, InventorySnapshot, ConsecutiveGroup, Event as EventModel } from '../models';
import { getActiveArbitrage } from './arbitrageActions';
import { getProjectionForEvent } from './projectionActions';
import { getPriceDropHeatmap } from './heatmapActions';

interface EventDoc {
  _id: unknown;
  mapping_id: string;
  Event_Name: string;
  Venue?: string;
  Event_DateTime?: Date | string;
  URL?: string;
  eventType?: string;
}

interface RecentGroupDoc {
  inventory?: {
    section?: string;
    row?: string;
    quantity?: number;
    listPrice?: number;
    tags?: string;
    stockType?: string;
    firstSeenAt?: Date | string | null;
  };
  createdAt?: Date;
}

export async function getEventRoomData(mappingId: string) {
  await dbConnect();

  const event = (await EventModel.findOne({ mapping_id: mappingId }).lean()) as EventDoc | null;
  if (!event) return { success: false, error: 'event not found' };

  const now = Date.now();
  const dayAgo = new Date(now - 24 * 60 * 60 * 1000);
  const weekAgo = new Date(now - 7 * 24 * 60 * 60 * 1000);

  // Latest snapshot + prior-24h snapshot for delta calc
  const [latestSnap, dayAgoSnap] = await Promise.all([
    InventorySnapshot.findOne({ eventId: mappingId }).sort({ snapshotAt: -1 }).lean(),
    InventorySnapshot.findOne({
      eventId: mappingId,
      snapshotAt: { $lte: dayAgo },
    }).sort({ snapshotAt: -1 }).lean(),
  ]);

  // Snapshot series for chart (last 7d)
  const series = await InventorySnapshot.find(
    { eventId: mappingId, snapshotAt: { $gte: weekAgo } },
    { snapshotAt: 1, totalListings: 1, medianPrice: 1, getInPrice: 1 },
  ).sort({ snapshotAt: 1 }).lean();

  // Recent alerts
  const recentAlerts = await Alert.find({ eventId: mappingId })
    .sort({ at: -1 })
    .limit(20)
    .lean();

  // Alerts today count by type
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);
  const alertsTodayAgg = await Alert.aggregate([
    { $match: { eventId: mappingId, at: { $gte: startOfDay } } },
    { $group: { _id: '$type', count: { $sum: 1 } } },
  ]);
  const alertsToday: Record<string, number> = {};
  let alertsTotal = 0;
  for (const a of alertsTodayAgg) {
    alertsToday[a._id] = a.count;
    alertsTotal += a.count;
  }

  // Cheapest 5 listings right now (bypasses provisional hold — for internal view)
  const cheapestGroups = (await ConsecutiveGroup.find(
    { mapping_id: mappingId },
    { 'inventory.section': 1, 'inventory.row': 1, 'inventory.quantity': 1,
      'inventory.listPrice': 1, 'inventory.tags': 1, 'inventory.stockType': 1,
      'inventory.firstSeenAt': 1, createdAt: 1 },
  )
    .sort({ 'inventory.listPrice': 1 })
    .limit(5)
    .lean()) as unknown as RecentGroupDoc[];

  const cheapest = cheapestGroups.map((g) => ({
    section: g.inventory?.section ?? '',
    row: g.inventory?.row ?? '',
    quantity: g.inventory?.quantity ?? 0,
    price: g.inventory?.listPrice ?? 0,
    tag: g.inventory?.tags ?? '',
    stockType: g.inventory?.stockType ?? '',
    firstSeenAt: g.inventory?.firstSeenAt || g.createdAt || null,
  }));

  // Arbitrage
  const arb = await getActiveArbitrage(mappingId);

  // Projection (only if we have enough snapshots)
  const projection = await getProjectionForEvent(mappingId);

  // Heatmap (30d)
  const tz = 'America/Los_Angeles';
  const heatmap = await getPriceDropHeatmap({
    eventId: mappingId,
    windowDays: 30,
    timezone: tz,
  });

  const totalListingsDelta =
    latestSnap && dayAgoSnap
      ? (latestSnap.totalListings ?? 0) - (dayAgoSnap.totalListings ?? 0)
      : null;
  const medianDelta =
    latestSnap && dayAgoSnap && dayAgoSnap.medianPrice != null && latestSnap.medianPrice != null
      ? latestSnap.medianPrice - dayAgoSnap.medianPrice
      : null;
  const getInDelta =
    latestSnap && dayAgoSnap && dayAgoSnap.getInPrice != null && latestSnap.getInPrice != null
      ? latestSnap.getInPrice - dayAgoSnap.getInPrice
      : null;

  return {
    success: true,
    event: {
      mappingId: event.mapping_id,
      name: event.Event_Name,
      venue: event.Venue ?? '',
      datetime: event.Event_DateTime ?? null,
      url: event.URL ?? '',
      taxonomy: event.eventType ?? 'Other',
    },
    stats: {
      totalListings: latestSnap?.totalListings ?? 0,
      totalListingsDelta,
      getInPrice: latestSnap?.getInPrice ?? 0,
      getInSection: latestSnap?.getInSection ?? '',
      getInRow: latestSnap?.getInRow ?? '',
      getInDelta,
      medianPrice: latestSnap?.medianPrice ?? 0,
      medianDelta,
      alertsToday,
      alertsTotal,
      lastScrapeAt: latestSnap?.snapshotAt ?? null,
    },
    series,
    recentAlerts,
    cheapest,
    arbitrage: arb.opportunities || [],
    projection,
    heatmap,
    fetchedAt: new Date(),
  };
}

/** Lightweight event list for the sidebar + command palette. */
export async function getEventsList(opts?: { q?: string; taxonomy?: string; watchingOnly?: boolean; limit?: number }) {
  await dbConnect();
  const query: Record<string, unknown> = { Skip_Scraping: { $ne: true } };
  if (opts?.taxonomy) query.eventType = opts.taxonomy;
  if (opts?.q) {
    query.$or = [
      { Event_Name: { $regex: opts.q, $options: 'i' } },
      { Venue: { $regex: opts.q, $options: 'i' } },
    ];
  }
  const events = (await EventModel.find(query, {
    mapping_id: 1, Event_Name: 1, Venue: 1, Event_DateTime: 1, eventType: 1,
  })
    .sort({ Event_DateTime: 1 })
    .limit(opts?.limit ?? 100)
    .lean()) as EventDoc[];

  // Attach latest snapshot per event (batch)
  const mappingIds = events.map((e) => e.mapping_id);
  const latestSnapshotsAgg = await InventorySnapshot.aggregate([
    { $match: { eventId: { $in: mappingIds } } },
    { $sort: { snapshotAt: -1 } },
    { $group: { _id: '$eventId', totalListings: { $first: '$totalListings' }, snapshotAt: { $first: '$snapshotAt' } } },
  ]);
  const snapMap = new Map<string, { totalListings: number; snapshotAt: Date }>();
  for (const s of latestSnapshotsAgg) snapMap.set(s._id, { totalListings: s.totalListings, snapshotAt: s.snapshotAt });

  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);
  const alertsAgg = await Alert.aggregate([
    { $match: { eventId: { $in: mappingIds }, at: { $gte: startOfDay } } },
    { $group: { _id: '$eventId', count: { $sum: 1 } } },
  ]);
  const alertMap = new Map<string, number>();
  for (const a of alertsAgg) alertMap.set(a._id, a.count);

  return events.map((e) => ({
    mappingId: e.mapping_id,
    name: e.Event_Name,
    venue: e.Venue ?? '',
    datetime: e.Event_DateTime ?? null,
    taxonomy: e.eventType ?? 'Other',
    totalListings: snapMap.get(e.mapping_id)?.totalListings ?? 0,
    alertsToday: alertMap.get(e.mapping_id) ?? 0,
  }));
}
