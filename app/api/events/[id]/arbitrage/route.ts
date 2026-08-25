import { NextRequest, NextResponse } from 'next/server';
import { getActiveArbitrage, detectArbitrageForEvent } from '../../../../../actions/arbitrageActions';

// GET /api/events/[id]/arbitrage — read current opportunities (by mapping_id)
export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const result = await getActiveArbitrage(id);
  return NextResponse.json(result);
}

// POST /api/events/[id]/arbitrage — trigger a fresh detection pass
// (`id` here is the Event Mongo _id since detection needs to fetch groups)
export async function POST(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const result = await detectArbitrageForEvent(id);
  return NextResponse.json(result);
}
