import { NextRequest, NextResponse } from 'next/server';
import { getEventRoomData } from '../../../../actions/eventRoomActions';

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const data = await getEventRoomData(id);
  return NextResponse.json(data);
}
