import { NextRequest, NextResponse } from 'next/server';
import dbConnect from '@/lib/dbConnect';
import { FeatureFlags } from '../../../models/featureFlagModel.js';
import { getSessionRole } from '@/lib/auth';

export async function GET() {
  try {
    await dbConnect();
    const flags = await FeatureFlags.findOne({}).lean() || (await FeatureFlags.create({})).toObject();
    return NextResponse.json({ success: true, flags });
  } catch (error) {
    console.error('Error fetching feature flags:', error);
    return NextResponse.json({ success: false, message: 'Failed to fetch feature flags' }, { status: 500 });
  }
}

export async function PUT(req: NextRequest) {
  try {
    // Only superadmin can modify feature flags
    const role = await getSessionRole(req);
    if (role !== 'superadmin') {
      return NextResponse.json({ success: false, message: 'Unauthorized' }, { status: 403 });
    }

    await dbConnect();

    const body = await req.json();
    const { flags } = body;

    if (!flags || typeof flags !== 'object') {
      return NextResponse.json({ success: false, message: 'Invalid flags' }, { status: 400 });
    }

    // Only allow valid state values for known fields
    const allowedFields = [
      'events', 'inventory', 'exclusionRules', 'importEvents', 'addEvent',
      'orders', 'exportCsv', 'purchaseAccounts',
      'csvScheduler', 'csvManualExport', 'csvDownload',
      'minSeatFilter', 'lowSeatAutoStop', 'eventEdit', 'eventExclusions',
      'autoDelete', 'proxies',
    ];
    const validStates = ['enabled', 'hidden', 'disabled'];

    const updates: Record<string, string> = {};
    for (const key of allowedFields) {
      if (validStates.includes(flags[key])) {
        updates[key] = flags[key];
      }
    }

    const updated = await FeatureFlags.findOneAndUpdate(
      {},
      { $set: updates },
      { upsert: true, new: true }
    ).lean();

    return NextResponse.json({ success: true, flags: updated });
  } catch (error) {
    console.error('Error updating feature flags:', error);
    return NextResponse.json({ success: false, message: 'Failed to update feature flags' }, { status: 500 });
  }
}
