import { NextRequest, NextResponse } from 'next/server';
import { getPriceDropHeatmap } from '../../../../../actions/heatmapActions';

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const url = new URL(req.url);
  const windowDays = Number(url.searchParams.get('days') || 30);
  const timezone = url.searchParams.get('tz') || 'UTC';
  const result = await getPriceDropHeatmap({ eventId: id, windowDays, timezone });
  return NextResponse.json(result);
}
