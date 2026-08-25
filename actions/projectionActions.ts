'use server';

/**
 * Sold-out projection service.
 *
 * Fits an exponential-decay regression through the last N days of
 * InventorySnapshot rows for one event, projects forward to kickoff.
 *
 * Returns: projected listing count and get-in price at kickoff, plus a
 * confidence band derived from residual standard deviation.
 */

import dbConnect from '../lib/dbConnect';
import { InventorySnapshot, Event as EventModel } from '../models';

interface Snapshot {
  snapshotAt: Date;
  totalListings: number;
  getInPrice?: number;
  medianPrice?: number;
}

interface RegressionFit {
  a: number; // intercept (log scale)
  b: number; // slope (per hour)
  residualStd: number;
  r2: number;
}

/**
 * Simple exponential decay fit: y = exp(a + b*t).
 * We linearize by taking log(y) and running least-squares.
 * `t` is hours since the first snapshot.
 */
function fitExponentialDecay(points: { t: number; y: number }[]): RegressionFit | null {
  const usable = points.filter((p) => p.y > 0);
  if (usable.length < 3) return null;

  const logs = usable.map((p) => ({ t: p.t, y: Math.log(p.y) }));
  const n = logs.length;
  const sumT = logs.reduce((s, p) => s + p.t, 0);
  const sumY = logs.reduce((s, p) => s + p.y, 0);
  const sumTY = logs.reduce((s, p) => s + p.t * p.y, 0);
  const sumTT = logs.reduce((s, p) => s + p.t * p.t, 0);
  const denom = n * sumTT - sumT * sumT;
  if (denom === 0) return null;

  const b = (n * sumTY - sumT * sumY) / denom;
  const a = (sumY - b * sumT) / n;

  const meanY = sumY / n;
  let ssRes = 0, ssTot = 0;
  for (const p of logs) {
    const yHat = a + b * p.t;
    ssRes += (p.y - yHat) ** 2;
    ssTot += (p.y - meanY) ** 2;
  }
  const r2 = ssTot === 0 ? 1 : 1 - ssRes / ssTot;
  const residualStd = Math.sqrt(ssRes / Math.max(n - 2, 1));

  return { a, b, residualStd, r2 };
}

export async function getProjectionForEvent(eventMappingId: string) {
  await dbConnect();

  const event = (await EventModel.findOne({ mapping_id: eventMappingId }).lean()) as
    | { Event_DateTime?: string | Date }
    | null;
  if (!event) return { success: false, error: 'event not found' };

  const now = Date.now();
  const sevenDaysAgo = new Date(now - 7 * 24 * 60 * 60 * 1000);
  const snapshots = (await InventorySnapshot.find(
    { eventId: eventMappingId, snapshotAt: { $gte: sevenDaysAgo } },
    { snapshotAt: 1, totalListings: 1, getInPrice: 1, medianPrice: 1 },
  )
    .sort({ snapshotAt: 1 })
    .lean()) as unknown as Snapshot[];

  if (snapshots.length < 3) {
    return {
      success: true,
      insufficient: true,
      snapshotCount: snapshots.length,
      message: 'Need at least 3 snapshots (roughly 45 min of scrape history) to project.',
    };
  }

  const t0 = new Date(snapshots[0].snapshotAt).getTime();
  const points = snapshots.map((s) => ({
    t: (new Date(s.snapshotAt).getTime() - t0) / (60 * 60 * 1000),
    listings: s.totalListings,
    getIn: s.getInPrice ?? null,
    median: s.medianPrice ?? null,
  }));

  const listingsFit = fitExponentialDecay(
    points.map((p) => ({ t: p.t, y: p.listings })),
  );
  const getInFit = fitExponentialDecay(
    points.filter((p) => p.getIn !== null).map((p) => ({ t: p.t, y: p.getIn as number })),
  );

  const kickoff = event.Event_DateTime ? new Date(event.Event_DateTime).getTime() : now + 7 * 24 * 60 * 60 * 1000;
  const hoursUntilKickoff = (kickoff - t0) / (60 * 60 * 1000);

  const projectListings = listingsFit
    ? Math.max(0, Math.round(Math.exp(listingsFit.a + listingsFit.b * hoursUntilKickoff)))
    : null;
  const projectGetIn = getInFit
    ? Math.round(Math.exp(getInFit.a + getInFit.b * hoursUntilKickoff))
    : null;

  const listingsBand = listingsFit && projectListings !== null
    ? {
        low: Math.round(projectListings * Math.exp(-listingsFit.residualStd * 2)),
        high: Math.round(projectListings * Math.exp(listingsFit.residualStd * 2)),
      }
    : null;
  const getInBand = getInFit && projectGetIn !== null
    ? {
        low: Math.round(projectGetIn * Math.exp(-getInFit.residualStd * 2)),
        high: Math.round(projectGetIn * Math.exp(getInFit.residualStd * 2)),
      }
    : null;

  const currentListings = snapshots[snapshots.length - 1].totalListings;
  const currentGetIn = snapshots[snapshots.length - 1].getInPrice;
  const percentSoldByKickoff =
    projectListings !== null && currentListings > 0
      ? Math.round((1 - projectListings / currentListings) * 100)
      : null;

  return {
    success: true,
    kickoff: new Date(kickoff),
    hoursUntilKickoff: Math.round(hoursUntilKickoff),
    current: { listings: currentListings, getIn: currentGetIn },
    projection: {
      listings: projectListings,
      listingsBand,
      getIn: projectGetIn,
      getInBand,
      percentSoldByKickoff,
    },
    model: {
      listings: listingsFit ? { r2: listingsFit.r2, residualStd: listingsFit.residualStd } : null,
      getIn: getInFit ? { r2: getInFit.r2, residualStd: getInFit.residualStd } : null,
      snapshotCount: snapshots.length,
      windowDays: 7,
    },
  };
}

export { fitExponentialDecay };
