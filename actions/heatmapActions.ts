'use server';

/**
 * Time-of-day heatmap aggregation.
 *
 * 7 (day-of-week) x 24 (hour-of-day) grid of price-drop alert counts,
 * aggregated over the last N days. Powers the "when prices drop"
 * heatmap in the Event Room dashboard.
 *
 * All timestamps are bucketed in the venue's local timezone (or UTC
 * fallback) so gameday-morning shows on the right day-of-week.
 */

import dbConnect from '../lib/dbConnect';
import { Alert } from '../models';

interface HeatmapCell { day: number; hour: number; count: number }

interface AlertDoc {
  at: Date;
  type: string;
  eventId: string;
}

export async function getPriceDropHeatmap(opts?: {
  eventId?: string;
  windowDays?: number;
  timezone?: string;
}) {
  await dbConnect();

  const windowDays = opts?.windowDays ?? 30;
  const timezone = opts?.timezone ?? 'UTC';
  const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000);

  const query: Record<string, unknown> = {
    at: { $gte: since },
    type: { $in: ['priceDrop', 'newLow'] },
  };
  if (opts?.eventId) query.eventId = opts.eventId;

  const alerts = (await Alert.find(query, { at: 1 }).lean()) as unknown as AlertDoc[];

  // Initialize 7x24 grid
  const grid: HeatmapCell[] = [];
  for (let d = 0; d < 7; d++) {
    for (let h = 0; h < 24; h++) grid.push({ day: d, hour: h, count: 0 });
  }
  const idx = (d: number, h: number) => d * 24 + h;

  // Bucket alerts into cells (venue-local timezone)
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    weekday: 'short',
    hour: 'numeric',
    hour12: false,
  });
  const dayMap: Record<string, number> = {
    Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
  };
  for (const a of alerts) {
    const parts = dtf.formatToParts(new Date(a.at));
    const weekday = parts.find((p) => p.type === 'weekday')?.value ?? 'Mon';
    const hourStr = parts.find((p) => p.type === 'hour')?.value ?? '0';
    const d = dayMap[weekday] ?? 1;
    const h = Math.min(23, Math.max(0, parseInt(hourStr, 10) || 0));
    grid[idx(d, h)].count++;
  }

  const total = alerts.length;
  const max = Math.max(1, ...grid.map((c) => c.count));

  // Find peak windows: contiguous (day, hourStart..hourEnd) with intensity >= 60%
  const peaks: { day: number; hourStart: number; hourEnd: number; count: number }[] = [];
  for (let d = 0; d < 7; d++) {
    let start: number | null = null;
    let sum = 0;
    for (let h = 0; h < 24; h++) {
      const c = grid[idx(d, h)].count;
      const intense = c / max >= 0.6;
      if (intense) {
        if (start === null) start = h;
        sum += c;
      } else if (start !== null) {
        peaks.push({ day: d, hourStart: start, hourEnd: h - 1, count: sum });
        start = null;
        sum = 0;
      }
    }
    if (start !== null) {
      peaks.push({ day: d, hourStart: start, hourEnd: 23, count: sum });
    }
  }
  peaks.sort((a, b) => b.count - a.count);

  return {
    success: true,
    windowDays,
    timezone,
    total,
    max,
    grid,
    peaks: peaks.slice(0, 5),
  };
}
