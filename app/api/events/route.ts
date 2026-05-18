import { NextResponse } from 'next/server';
import dbConnect from '@/lib/dbConnect';
import { Event } from '@/models/eventModel';
import { isValidEventType } from '@/lib/venueToSport';

// Escape special regex characters to prevent ReDoS and injection
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export async function GET(request: Request) {
  try {
    await dbConnect();

    const { searchParams } = new URL(request.url);
    const page = Math.max(1, parseInt(searchParams.get('page') || '1') || 1);
    const limit = Math.min(Math.max(1, parseInt(searchParams.get('limit') || '1000') || 1000), 5000);
    const search = searchParams.get('search') || '';
    const eventType = searchParams.get('eventType') || '';

    const andConditions: Record<string, unknown>[] = [];
    if (search) {
      const escapedSearch = escapeRegex(search);
      andConditions.push({
        $or: [
          { Event_Name: { $regex: escapedSearch, $options: 'i' } },
          { Venue: { $regex: escapedSearch, $options: 'i' } },
        ],
      });
    }
    if (eventType === 'unset') {
      andConditions.push({ $or: [{ eventType: null }, { eventType: { $exists: false } }] });
    } else if (isValidEventType(eventType)) {
      andConditions.push({ eventType });
    }
    const filter = andConditions.length ? { $and: andConditions } : {};

    // Calculate skip value
    const skip = (page - 1) * limit;

    // Get total count for pagination
    const total = await Event.countDocuments(filter);

    // Get events with pagination
    const events = await Event.find(filter, {
      mapping_id: 1,
      Event_Name: 1,
      Event_DateTime: 1,
      Venue: 1,
      URL: 1,
      Available_Seats: 1,
      Skip_Scraping: 1,
      Last_Updated: 1,
      priceIncreasePercentage: 1,
      standardMarkupAdjustment: 1,
      resaleMarkupAdjustment: 1,
      brokerMarkupAdjustment: 1,
      includeStandardSeats: 1,
      includeResaleSeats: 1,
      eventType: 1,
    })
    .sort({ Event_DateTime: -1 })
    .skip(skip)
    .limit(limit)
    .lean();

    // Return paginated response
    if (limit >= 1000) {
      // For backwards compatibility - return all events if limit is high
      return NextResponse.json(events);
    } else {
      // Return paginated response
      return NextResponse.json({
        events,
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit)
      });
    }
  } catch (error) {
    console.error('Error fetching events:', error);
    return NextResponse.json(
      { error: 'Failed to fetch events' },
      { status: 500 }
    );
  }
}
