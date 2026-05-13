'use server';

/**
 * Auto-Stop Service for Upcoming Events (Timezone-Aware)
 *
 * This service automatically stops scraping and clears inventory for events
 * before they take place. Events are kept in the database (not deleted).
 *
 * KEY: Timezone is AUTO-DETECTED from the Venue field. No manual timezone input needed.
 *
 * For each event, the system:
 *   1. Reads the Venue field (e.g., "Hard Rock Stadium", "Miami", "Dallas TX")
 *   2. Auto-detects the timezone from venue/city/state
 *   3. Gets the CURRENT local time in that timezone
 *   4. Compares: if (local_now + stopBeforeMinutes) >= event_time → stop & clear inventory
 *
 * Example: Event in Miami at 7pm, stopBeforeMinutes=120
 *   - Current time in Miami (Eastern): 5:00pm
 *   - Cutoff = 5pm + 120min = 7pm
 *   - Event(7pm) <= Cutoff(7pm) → STOP & CLEAR INVENTORY
 */

import dbConnect from '@/lib/dbConnect';
import { Event } from '@/models/eventModel';
import { ConsecutiveGroup } from '@/models/seatModel';
import { deleteConsecutiveGroupsByEventIds } from './seatActions';
import { createErrorLog } from './errorLogActions';
import { shouldStopEvent, shouldStopEventAsync, detectTimezoneFromVenue, detectTimezoneFromVenueAsync, getTimezoneAbbr, getCurrentTimeInTimezone } from '@/lib/timezone';
import { ensureTimeSynced, getTimeSyncStatus, getAccurateNow } from '@/lib/timeSync';
import { AutoDeleteSettings } from '@/models/autoDeleteModel';

/**
 * Format a Date as Pakistan Standard Time string (PKT = UTC+5)
 */
function formatAsPKT(date: Date): string {
  return date.toLocaleString('en-US', {
    timeZone: 'Asia/Karachi',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: true,
  }) + ' PKT';
}

/**
 * Format a Date in a specific timezone for display
 */
function formatInTimezone(date: Date, timezone: string, abbr: string): string {
  return date.toLocaleString('en-US', {
    timeZone: timezone,
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: true,
  }) + ` ${abbr}`;
}

export interface AutoDeleteStats {
  totalEventsChecked: number;
  eventsDeleted: number;
  eventsStopped: number;
  deletedEventIds: string[];
  lowSeatStopped: number;
  lowSeatEventIds: string[];
  errors: string[];
  lastRunAt: Date;
}

/**
 * Stops scraping and clears inventory based on timezone-aware time comparison.
 * Events are kept in the database. Each event's timezone is auto-detected from its Venue field.
 *
 * @param stopBeforeMinutes - Minutes before event time to stop (e.g., 120 = stop 2h before event)
 * @returns Promise<AutoDeleteStats>
 */
export async function deleteExpiredEvents(stopBeforeMinutes: number = 120, lowSeatThreshold: number = 20): Promise<AutoDeleteStats> {
  await dbConnect();
  
  // Sync clock with external time API before checking events
  await ensureTimeSynced();
  const syncStatus = getTimeSyncStatus();
  console.log(`Auto-delete: Clock sync status — offset: ${syncStatus.offsetSeconds}s, synced: ${syncStatus.isSynced}`);
  
  const stats: AutoDeleteStats = {
    totalEventsChecked: 0,
    eventsDeleted: 0,
    eventsStopped: 0,
    deletedEventIds: [],
    lowSeatStopped: 0,
    lowSeatEventIds: [],
    errors: [],
    lastRunAt: new Date()
  };

  try {
    // Only fetch events that are still active (not already stopped)
    // Since we no longer delete events, stopped events would be re-processed every cycle
    const allEvents = await Event.find({ Skip_Scraping: { $ne: true } })
      .select('_id Event_ID Event_Name Event_DateTime Venue Skip_Scraping');

    stats.totalEventsChecked = allEvents.length;

    if (allEvents.length === 0) {
      console.log('Auto-delete: No events in database');
      return stats;
    }

    // Check each event against its venue's timezone (async — with live API fallback)
    const eventsToDelete = [];
    const skippedEvents = [];
    for (const event of allEvents) {
      const venue = event.Venue || '';
      // Use async version for live API fallback covering all US cities
      const result = await shouldStopEventAsync(event.Event_DateTime, venue, stopBeforeMinutes);
      
      if (!result) {
        // Timezone could not be detected from venue — skip this event
        skippedEvents.push(event);
        continue;
      }
      
      if (result.shouldStop) {
        eventsToDelete.push({
          event,
          timezone: result.timezone,
          localNow: result.localNow,
          cutoff: result.cutoff,
        });
      }
    }

    if (skippedEvents.length > 0) {
      console.warn(`Auto-delete: Skipped ${skippedEvents.length} events — timezone could not be detected from venue:`);
      for (const e of skippedEvents) {
        console.warn(`  ⚠ ${e.Event_ID} | ${e.Event_Name} | Venue: "${e.Venue || '(empty)'}"`);
      }
    }

    stats.eventsDeleted = eventsToDelete.length;

    if (eventsToDelete.length === 0) {
      console.log('Auto-delete: No events found within the stop window (timezone-aware check)');
      return stats;
    }

    const eventIds = eventsToDelete.map(e => e.event._id.toString());
    const eventMappings = eventsToDelete.map(e => e.event.Event_ID);
    stats.deletedEventIds = eventMappings;

    // Count how many were not already stopped
    const notYetStopped = eventsToDelete.filter(e => !e.event.Skip_Scraping);
    stats.eventsStopped = notYetStopped.length;

    // Log what we're doing with timezone info (including PKT)
    const pktNow = formatAsPKT(getAccurateNow());
    console.log(`Auto-delete (timezone-aware): Found ${eventsToDelete.length} events to stop & delete (Current PKT: ${pktNow}):`);
    for (const e of eventsToDelete) {
      const tz = getTimezoneAbbr(e.timezone);
      const localTimeStr = formatInTimezone(getAccurateNow(), e.timezone, tz);
      console.log(`  → ${e.event.Event_ID} | ${e.event.Event_Name} | Event: ${e.event.Event_DateTime.toISOString()} | Venue: ${e.event.Venue} | TZ: ${tz} | Local now: ${localTimeStr} | PKT now: ${pktNow} | Cutoff: ${e.cutoff.toISOString()}`);
    }

    // Stop scraping for all matching events
    if (notYetStopped.length > 0) {
      try {
        await Event.updateMany(
          { _id: { $in: eventIds } },
          { $set: { Skip_Scraping: true } }
        );
        console.log(`Auto-delete: Stopped scraping for ${notYetStopped.length} events`);
      } catch (error) {
        const errorMsg = `Failed to stop scraping: ${(error as Error).message}`;
        stats.errors.push(errorMsg);
        console.error('Auto-delete stop scraping error:', error);
      }
    }

    // Clear inventory (seat data) from DB and Sync — but keep the events themselves.
    // ConsecutiveGroup.eventId stores the TM Event_ID (hex), not Mongo _id,
    // so pass eventMappings to match the stored field and trigger the sync-delete path.
    try {
      await deleteConsecutiveGroupsByEventIds(eventMappings);
      console.log(`Auto-delete: Cleared inventory for ${eventMappings.length} events`);
    } catch (error) {
      const errorMsg = `Failed to clear inventory: ${(error as Error).message}`;
      stats.errors.push(errorMsg);
      console.error('Auto-delete inventory clear error:', error);

      await createErrorLog({
        errorType: 'AUTO_DELETE_SEATS_ERROR',
        errorMessage: errorMsg,
        stackTrace: (error as Error).stack || '',
        metadata: { eventIds, eventMappings }
      });
    }

    console.log(`Auto-delete: Successfully stopped ${stats.eventsStopped} events and cleared inventory for ${eventIds.length} events (events kept in DB)`);

    // Build last-stopped records with dual timezone info
    const nowAccurate = getAccurateNow();
    const stoppedRecords = eventsToDelete.map(e => {
      const tz = getTimezoneAbbr(e.timezone);
      return {
        eventId: e.event.Event_ID,
        eventName: e.event.Event_Name,
        venue: e.event.Venue || '',
        eventDateTime: e.event.Event_DateTime,
        deletedAt: nowAccurate,
        detectedTimezone: e.timezone,
        timezoneAbbr: tz,
        localTimeAtDeletion: formatInTimezone(nowAccurate, e.timezone, tz),
        pktTimeAtDeletion: formatAsPKT(nowAccurate),
      };
    });

    // Save stopped events to settings (prepend new, auto-clear records older than 24h)
    try {
      const currentSettings = await AutoDeleteSettings.findOne();
      const existing = currentSettings?.lastDeletedEvents || [];
      const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const recentOnly = existing.filter((e: any) => new Date(e.deletedAt) > oneDayAgo);
      const merged = [...stoppedRecords, ...recentOnly];
      await AutoDeleteSettings.findOneAndUpdate(
        {},
        { $set: { lastDeletedEvents: merged } },
        { upsert: true }
      );
    } catch (saveErr) {
      console.error('Auto-delete: Failed to save lastDeletedEvents:', saveErr);
    }

    // Log successful stop & inventory clear with timezone details (including PKT)
    await createErrorLog({
      errorType: 'AUTO_DELETE_SUCCESS',
      errorMessage: `Auto-stopped ${eventIds.length} events and cleared inventory (${stopBeforeMinutes}min before event time, timezone-aware)`,
      stackTrace: '',
      metadata: { 
        deletedEvents: eventsToDelete.map(e => {
          const tz = getTimezoneAbbr(e.timezone);
          return {
            id: e.event.Event_ID,
            name: e.event.Event_Name,
            dateTime: e.event.Event_DateTime,
            venue: e.event.Venue,
            detectedTimezone: e.timezone,
            timezoneAbbr: tz,
            localTimeAtDeletion: formatInTimezone(nowAccurate, e.timezone, tz),
            pktTimeAtDeletion: formatAsPKT(nowAccurate),
          };
        }),
        stopBeforeMinutes,
        clockOffset: getTimeSyncStatus().offsetSeconds,
      }
    });

  } catch (error) {
    const errorMsg = `Auto-delete operation failed: ${(error as Error).message}`;
    stats.errors.push(errorMsg);
    console.error('Auto-delete error:', error);
    
    await createErrorLog({
      errorType: 'AUTO_DELETE_ERROR',
      errorMessage: errorMsg,
      stackTrace: (error as Error).stack || '',
      metadata: { stopBeforeMinutes }
    });
  }

  // ═══════════════════════════════════════════════════════════════════
  // Low-Seat-Count Check: stop events whose total inventory <= threshold
  // Runs AFTER the timezone-based stop to avoid double-processing
  // ═══════════════════════════════════════════════════════════════════
  if (lowSeatThreshold > 0) {
    try {
      // Re-fetch active events (some may have just been stopped above)
      const activeEvents = await Event.find({ Skip_Scraping: { $ne: true } })
        .select('_id Event_ID Event_Name mapping_id Venue')
        .lean() as unknown as Array<{ _id: any; Event_ID: string; Event_Name: string; mapping_id: string; Venue: string }>;

      if (activeEvents.length > 0) {
        const mappingIds = activeEvents
          .map(e => e.mapping_id)
          .filter(Boolean) as string[];

        if (mappingIds.length > 0) {
          // Aggregate total inventory per mapping_id from ConsecutiveGroup
          const inventoryCounts = await ConsecutiveGroup.aggregate([
            { $match: { mapping_id: { $in: mappingIds } } },
            {
              $group: {
                _id: '$mapping_id',
                totalQty: { $sum: '$inventory.quantity' },
              },
            },
          ]);

          const qtyByMapping: Record<string, number> = {};
          for (const row of inventoryCounts) {
            qtyByMapping[row._id] = row.totalQty;
          }

          // Find events with total seats <= threshold (and > 0 — skip events with no inventory at all)
          const lowSeatEvents = activeEvents.filter(e => {
            const qty = e.mapping_id ? (qtyByMapping[e.mapping_id] ?? 0) : 0;
            return qty > 0 && qty <= lowSeatThreshold;
          });

          if (lowSeatEvents.length > 0) {
            const lowSeatIds = lowSeatEvents.map(e => e._id.toString());
            const lowSeatMappings = lowSeatEvents.map(e => e.Event_ID);

            console.log(`Auto-delete (low-seat): Found ${lowSeatEvents.length} events with ≤${lowSeatThreshold} seats — stopping & clearing inventory:`);
            for (const e of lowSeatEvents) {
              const qty = e.mapping_id ? (qtyByMapping[e.mapping_id] ?? 0) : 0;
              console.log(`  → ${e.Event_ID} | ${e.Event_Name} | Seats: ${qty} | Venue: ${e.Venue}`);
            }

            // Stop scraping
            try {
              await Event.updateMany(
                { _id: { $in: lowSeatIds } },
                { $set: { Skip_Scraping: true } }
              );
              console.log(`Auto-delete (low-seat): Stopped scraping for ${lowSeatEvents.length} events`);
            } catch (error) {
              const errorMsg = `Low-seat stop failed: ${(error as Error).message}`;
              stats.errors.push(errorMsg);
              console.error('Auto-delete low-seat stop error:', error);
            }

            // Clear inventory — pass TM Event_IDs (match ConsecutiveGroup.eventId)
            // so the sync-delete path actually runs, same as manual stop.
            try {
              await deleteConsecutiveGroupsByEventIds(lowSeatMappings);
              console.log(`Auto-delete (low-seat): Cleared inventory for ${lowSeatMappings.length} events`);
            } catch (error) {
              const errorMsg = `Low-seat inventory clear failed: ${(error as Error).message}`;
              stats.errors.push(errorMsg);
              console.error('Auto-delete low-seat inventory clear error:', error);
            }

            stats.lowSeatStopped = lowSeatEvents.length;
            stats.lowSeatEventIds = lowSeatMappings;

            // Log success
            await createErrorLog({
              errorType: 'AUTO_DELETE_SUCCESS',
              errorMessage: `Low-seat auto-stop: Stopped ${lowSeatEvents.length} events with ≤${lowSeatThreshold} seats and cleared inventory`,
              stackTrace: '',
              metadata: {
                lowSeatEvents: lowSeatEvents.map(e => ({
                  id: e.Event_ID,
                  name: e.Event_Name,
                  seats: e.mapping_id ? (qtyByMapping[e.mapping_id] ?? 0) : 0,
                  venue: e.Venue,
                })),
                threshold: lowSeatThreshold,
              },
            });
          } else {
            console.log(`Auto-delete (low-seat): No active events with ≤${lowSeatThreshold} seats (checked ${activeEvents.length} events)`);
          }
        }
      }
    } catch (error) {
      const errorMsg = `Low-seat check failed: ${(error as Error).message}`;
      stats.errors.push(errorMsg);
      console.error('Auto-delete low-seat check error:', error);
    }
  }

  return stats;
}

/**
 * Gets statistics about active events that would be stopped on the next run (dry run / preview).
 * Uses timezone-aware comparison per event.
 *
 * @param stopBeforeMinutes - Minutes before event time to stop
 * @returns Preview data with timezone info per event
 */
export async function getExpiredEventsStats(stopBeforeMinutes: number = 120) {
  await dbConnect();
  
  // Sync clock for accurate preview
  await ensureTimeSynced();
  
  try {
    // Only fetch active events — stopped events are already handled
    const allEvents = await Event.find({ Skip_Scraping: { $ne: true } })
      .select('Event_ID Event_Name Event_DateTime Venue Skip_Scraping').lean();

    const eventsToDelete = [];
    const eventsSafe = [];
    const eventsSkipped = [];

    for (const event of allEvents) {
      const venue = event.Venue || '';
      // Use async version for live API fallback covering all US cities
      const tz = await detectTimezoneFromVenueAsync(venue);
      const result = tz ? await shouldStopEventAsync(event.Event_DateTime, venue, stopBeforeMinutes) : null;
      
      if (!result || !tz) {
        // Timezone undetectable — show in preview as skipped
        eventsSkipped.push({
          id: event.Event_ID,
          name: event.Event_Name,
          dateTime: event.Event_DateTime,
          venue: event.Venue,
          isStopped: event.Skip_Scraping,
          detectedTimezone: 'N/A',
          localTimeNow: null,
        });
        continue;
      }

      const localNow = getCurrentTimeInTimezone(tz);
      const tzAbbr = getTimezoneAbbr(tz);
      const accurateNow = getAccurateNow();
      
      const eventInfo = {
        id: event.Event_ID,
        name: event.Event_Name,
        dateTime: event.Event_DateTime,
        venue: event.Venue,
        isStopped: event.Skip_Scraping,
        detectedTimezone: tzAbbr,
        detectedTimezoneIana: tz,
        localTimeNow: localNow.toISOString(),
        localTimeDisplay: formatInTimezone(accurateNow, tz, tzAbbr),
        pktTimeDisplay: formatAsPKT(accurateNow),
      };

      if (result.shouldStop) {
        eventsToDelete.push(eventInfo);
      } else {
        eventsSafe.push(eventInfo);
      }
    }

    return {
      success: true,
      count: eventsToDelete.length,
      totalEvents: allEvents.length,
      skippedCount: eventsSkipped.length,
      stopBeforeMinutes,
      events: eventsToDelete,
      safeEvents: eventsSafe,
      skippedEvents: eventsSkipped,
    };
  } catch (error) {
    console.error('Error getting events stats for auto-delete:', error);
    return {
      success: false,
      error: (error as Error).message,
      count: 0,
      events: []
    };
  }
}

/**
 * Get all events stopped by the auto-delete timer.
 * Each record includes both PKT and event-local timezone info.
 */
export async function getLastDeletedEvents() {
  await dbConnect();
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const settings: any = await AutoDeleteSettings.findOne().lean();
    const lastDeleted = settings?.lastDeletedEvents || [];
    // Only return records from the last 24 hours
    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const recent = lastDeleted.filter((e: any) => new Date(e.deletedAt) > oneDayAgo);
    return JSON.parse(JSON.stringify(recent));
  } catch (error) {
    console.error('Error getting last deleted events:', error);
    return [];
  }
}

// ═══════════════════════════════════════════════════════════════════
// POST-EVENT CLEANUP: Permanently delete events + all related data
// once they are N hours past their event date.
//
// Logic: Event_DateTime + hoursAfter < now  →  delete
// Example: event 16 Aug 8pm, hoursAfter=12  →  deleted 17 Aug 8am
// ═══════════════════════════════════════════════════════════════════

export interface PostEventDeleteStats {
  checked: number;
  deleted: number;
  eventIds: string[];
  errors: string[];
}

export async function deletePassedEvents(hoursAfter: number = 12): Promise<PostEventDeleteStats> {
  await dbConnect();

  const stats: PostEventDeleteStats = { checked: 0, deleted: 0, eventIds: [], errors: [] };

  try {
    const cutoff = new Date(Date.now() - hoursAfter * 60 * 60 * 1000);

    const expiredEvents = await Event.find({ Event_DateTime: { $lt: cutoff } })
      .select('_id Event_ID Event_Name Event_DateTime Venue')
      .lean();

    stats.checked = expiredEvents.length;

    if (expiredEvents.length === 0) {
      console.log(`Post-event cleanup: No events older than ${hoursAfter}h found`);
      return stats;
    }

    const mongoIds = expiredEvents.map(e => String(e._id));
    const eventIds = expiredEvents.map(e => e.Event_ID as string);

    console.log(`Post-event cleanup: Deleting ${expiredEvents.length} events older than ${hoursAfter}h:`);
    for (const e of expiredEvents) {
      console.log(`  → ${e.Event_ID} | ${e.Event_Name} | ${new Date(e.Event_DateTime as Date).toISOString()}`);
    }

    // 1. Delete ConsecutiveGroups (inventory)
    try {
      const cgResult = await ConsecutiveGroup.deleteMany({ eventId: { $in: eventIds } });
      console.log(`Post-event cleanup: Deleted ${cgResult.deletedCount} consecutive groups`);
    } catch (err) {
      const msg = `Failed to delete consecutive groups: ${(err as Error).message}`;
      stats.errors.push(msg);
      console.error('Post-event cleanup:', msg);
    }

    // 2. Delete Event documents (last — so retries are safe if above fail)
    try {
      const evResult = await Event.deleteMany({ _id: { $in: mongoIds } });
      stats.deleted = evResult.deletedCount;
      stats.eventIds = eventIds;
      console.log(`Post-event cleanup: Deleted ${evResult.deletedCount} event documents`);
    } catch (err) {
      const msg = `Failed to delete events: ${(err as Error).message}`;
      stats.errors.push(msg);
      console.error('Post-event cleanup:', msg);
    }

    await createErrorLog({
      errorType: 'POST_EVENT_DELETE_SUCCESS',
      errorMessage: `Post-event cleanup: Permanently deleted ${stats.deleted} events (${hoursAfter}h after event date)`,
      stackTrace: '',
      metadata: {
        deletedEvents: expiredEvents.map(e => ({
          id: e.Event_ID, name: e.Event_Name, dateTime: e.Event_DateTime, venue: e.Venue
        })),
        hoursAfter,
        cutoff: cutoff.toISOString(),
      },
    });

  } catch (error) {
    const msg = `Post-event cleanup failed: ${(error as Error).message}`;
    stats.errors.push(msg);
    console.error('Post-event cleanup error:', error);
    await createErrorLog({
      errorType: 'POST_EVENT_DELETE_ERROR',
      errorMessage: msg,
      stackTrace: (error as Error).stack || '',
      metadata: { hoursAfter },
    });
  }

  return stats;
}