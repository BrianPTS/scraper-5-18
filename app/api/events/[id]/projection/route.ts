import { NextRequest, NextResponse } from 'next/server';
import { getProjectionForEvent } from '../../../../../actions/projectionActions';

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const result = await getProjectionForEvent(id);
  return NextResponse.json(result);
}
