import { NextResponse } from 'next/server';
import { writeSnapshotsForAllActiveEvents } from '../../../actions/snapshotActions';

// POST /api/inventory-snapshot — run one snapshot pass across all active events.
// Meant to be hit by a 15-min cron/scheduler.
export async function POST() {
  const result = await writeSnapshotsForAllActiveEvents();
  return NextResponse.json(result);
}
