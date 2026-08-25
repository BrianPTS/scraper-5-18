import { NextRequest, NextResponse } from 'next/server';
import { getEventsList } from '../../../../actions/eventRoomActions';

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const q = url.searchParams.get('q') || undefined;
  const taxonomy = url.searchParams.get('taxonomy') || undefined;
  const limit = Number(url.searchParams.get('limit')) || 100;
  const events = await getEventsList({ q, taxonomy, limit });
  return NextResponse.json({ success: true, events });
}
