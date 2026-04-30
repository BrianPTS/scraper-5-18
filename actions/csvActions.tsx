/* eslint-disable @typescript-eslint/no-explicit-any */
'use server';

const MLB_TEAMS = [
  "Yankees", "Red Sox", "Blue Jays", "Orioles", "Rays",
  "Guardians", "Twins", "Tigers", "White Sox", "Royals",
  "Astros", "Mariners", "Rangers", "Angels", "Athletics",
  "Braves", "Phillies", "Mets", "Marlins", "Nationals",
  "Brewers", "Cubs", "Cardinals", "Pirates", "Reds",
  "Dodgers", "Padres", "Diamondbacks", "Giants", "Rockies",
];

const NFL_TEAMS = [
  "Bills", "Dolphins", "Patriots", "Jets",
  "Ravens", "Bengals", "Browns", "Steelers",
  "Texans", "Colts", "Jaguars", "Titans",
  "Broncos", "Chiefs", "Raiders", "Chargers",
  "Cowboys", "Giants", "Eagles", "Commanders",
  "Bears", "Lions", "Packers", "Vikings",
  "Falcons", "Panthers", "Saints", "Buccaneers",
  "Cardinals", "Rams", "49ers", "Seahawks",
];

// Pre-computed lowercase team names — avoids recreating + lowercasing on every CSV row
const ALL_TEAMS_LOWER = [...MLB_TEAMS, ...NFL_TEAMS].map(t => t.toLowerCase());

// Blocked state values for venue filtering (RI + ME)
const BLOCKED_STATES = ['ri', 'me', 'rhode island', 'maine'];
import dbConnect from '../lib/dbConnect';
import { ConsecutiveGroup } from '../models/seatModel';
import { Event } from '../models/eventModel';
import { SchedulerSettings } from '../models/schedulerModel';
import { AutoDeleteSettings } from '../models/autoDeleteModel';
import { ExclusionRules } from '../models/exclusionRulesModel';
import SyncService from '../lib/syncService';
import { createErrorLog } from './errorLogActions';
import { deleteExpiredEvents, getExpiredEventsStats, deletePassedEvents } from './autoDeleteActions';
import { deleteConsecutiveGroupsByEventIds } from './seatActions';
import { detectTimezoneFromVenueAsync, resolveVenueTimezonesBulk, getCurrentTimeInTimezone } from '../lib/timezone';
import { PipelineStage } from 'mongoose';

interface CsvRow {
  inventory_id: number;
  event_name: string;
  venue_name: string;
  event_date: string;
  event_id: string;
  quantity: number;
  section: string;
  row: string;
  seats: string;
  barcodes?: string;
  internal_notes?: string;
  public_notes?: string;
  tags?: string;
  list_price: number;
  face_price: number;
  taxed_cost: number;
  cost: number;
  hide_seats: 'Y' | 'N';
  in_hand: 'N';
  in_hand_date: string;
  instant_transfer?: 'Y' | 'N';
  files_available: 'Y' | 'N';
  split_type: 'CUSTOM' | 'DEFAULT' | 'NEVERLEAVEONE' | 'ANY';
  custom_split?: string;
  stock_type: 'ELECTRONIC' | 'HARD' | 'MOBILE_TRANSFER' | 'MOBILE_SCREENCAP' | 'PAPERLESS' | 'PAPERLESS_CARD' | 'FLASH';
  zone: 'Y' | 'N';
  shown_quantity?: number;
  passthrough?: string;
}

const csvColumns = [
  { id: 'inventory_id', title: 'inventory_id' },
  { id: 'event_name', title: 'event_name' },
  { id: 'venue_name', title: 'venue_name' },
  { id: 'event_date', title: 'event_date' },
  { id: 'event_id', title: 'event_id' },
  { id: 'quantity', title: 'quantity' },
  { id: 'section', title: 'section' },
  { id: 'row', title: 'row' },
  { id: 'seats', title: 'seats' },
  { id: 'barcodes', title: 'barcodes' },
  { id: 'internal_notes', title: 'internal_notes' },
  { id: 'public_notes', title: 'public_notes' },
  { id: 'tags', title: 'tags' },
  { id: 'list_price', title: 'list_price' },
  { id: 'face_price', title: 'face_price' },
  { id: 'taxed_cost', title: 'taxed_cost' },
  { id: 'cost', title: 'cost' },
  { id: 'hide_seats', title: 'hide_seats' },
  { id: 'in_hand', title: 'in_hand' },
  { id: 'in_hand_date', title: 'in_hand_date' },
  { id: 'instant_transfer', title: 'instant_transfer' },
  { id: 'files_available', title: 'files_available' },
  { id: 'split_type', title: 'split_type' },
  { id: 'custom_split', title: 'custom_split' },
  { id: 'stock_type', title: 'stock_type' },
  { id: 'zone', title: 'zone' },
  { id: 'shown_quantity', title: 'shown_quantity' },
  { id: 'passthrough', title: 'passthrough' },
];

// Retry configuration
interface RetryConfig {
  maxRetries: number;
  baseDelay: number;
  maxDelay: number;
}

const DEFAULT_RETRY_CONFIG: RetryConfig = {
  maxRetries: 3,
  baseDelay: 1000, // 1 second
  maxDelay: 10000  // 10 seconds
};

// Exponential backoff with jitter
function calculateDelay(attempt: number, config: RetryConfig): number {
  const exponentialDelay = Math.min(config.baseDelay * Math.pow(2, attempt), config.maxDelay);
  const jitter = Math.random() * 0.1 * exponentialDelay;
  return exponentialDelay + jitter;
}

// Get price adjustment percentage from environment variables
function getPriceAdjustmentPercentage(): number {
  const priceAdjustmentEnv = process.env.PRICE_INCREASE_PERCENTAGE;
  if (!priceAdjustmentEnv) {
    return 0; // Default: no price adjustment
  }
  const percentage = parseFloat(priceAdjustmentEnv);
  return isNaN(percentage) ? 0 : percentage;
}

// Build a per-record exclusion filter once for a CSV run. Both the streaming
// and non-streaming paths used to call this per chunk, which fired 2 DB
// queries per chunk (Event.find + ExclusionRules.find). Hoisting those reads
// to a single round each removes O(chunks) redundant queries.
type ExclusionFilter = (record: CsvRow) => boolean;
const ALLOW_ALL: ExclusionFilter = () => true;

interface SectionRowExclusion {
  section?: string;
  excludeEntireSection?: boolean;
  excludedRows?: string[];
}

async function buildExclusionFilter(mappingIds: string[]): Promise<ExclusionFilter> {
  if (mappingIds.length === 0) return ALLOW_ALL;

  try {
    const events = await Event.find(
      { mapping_id: { $in: mappingIds } },
      { _id: 1, mapping_id: 1 }
    ).lean();
    if (events.length === 0) return ALLOW_ALL;

    const objectIdToMappingId = new Map<string, string>();
    const eventIds: string[] = [];
    for (const e of events) {
      const oid = String(e._id);
      objectIdToMappingId.set(oid, e.mapping_id);
      eventIds.push(oid);
    }

    const rules = await ExclusionRules.find(
      { eventId: { $in: eventIds }, isActive: true }
    ).lean();
    if (rules.length === 0) return ALLOW_ALL;

    // Key by mapping_id so per-record lookup is one Map.get against the value
    // already stored in CsvRow.event_id.
    const rulesByMappingId = new Map<string, SectionRowExclusion[]>();
    for (const rule of rules) {
      const mid = objectIdToMappingId.get(String(rule.eventId));
      const sectionRules = (rule as { sectionRowExclusions?: SectionRowExclusion[] }).sectionRowExclusions;
      if (mid && sectionRules && sectionRules.length > 0) {
        rulesByMappingId.set(mid, sectionRules);
      }
    }
    if (rulesByMappingId.size === 0) return ALLOW_ALL;

    return (record) => {
      const sectionRules = rulesByMappingId.get(record.event_id);
      if (!sectionRules) return true;
      for (const exclusion of sectionRules) {
        if (exclusion.section !== record.section) continue;
        if (exclusion.excludeEntireSection) return false;
        if (exclusion.excludedRows && exclusion.excludedRows.includes(record.row)) return false;
      }
      return true;
    };
  } catch (error) {
    console.error('Error loading exclusion rules:', error);
    return ALLOW_ALL;
  }
}

const isBlockedVenueState = (record: CsvRow): boolean => {
  const v = (record.venue_name || '').trim().toLowerCase();
  return BLOCKED_STATES.some(s => v === s || v.endsWith(', ' + s) || v.endsWith(',' + s));
};

// Apply price adjustment (increase or decrease) to a price value
function applyPriceAdjustment(originalPrice: number): number {
  const adjustmentPercentage = getPriceAdjustmentPercentage();
  if (adjustmentPercentage === 0) {
    return originalPrice;
  }
  // Positive percentage = increase, Negative percentage = decrease
  return originalPrice * (1 + adjustmentPercentage / 100);
}

// Generic retry wrapper
async function withRetry<T>(
  operation: () => Promise<T>,
  operationName: string,
  config: RetryConfig = DEFAULT_RETRY_CONFIG
): Promise<T> {
  let lastError: Error;
  
  for (let attempt = 0; attempt <= config.maxRetries; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error as Error;
      
      if (attempt === config.maxRetries) {
        await createErrorLog({
          eventUrl: `RETRY_${operationName.toUpperCase().replace(/\s+/g, '_')}`,
          errorType: 'DATABASE_ERROR',
          message: lastError.message,
          stack: lastError.stack,
          metadata: {
            operation: operationName,
            attempt: attempt + 1,
            timestamp: new Date()
          }
        });
        throw lastError;
      }
      
      const delay = calculateDelay(attempt, config);
      console.warn(`[CSV] ${operationName} failed (attempt ${attempt + 1}/${config.maxRetries + 1}): ${lastError.message}. Retrying in ${Math.round(delay)}ms...`);
      
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
  
  throw lastError!;
}

// Cache for resolved venue timezones within a CSV generation run
const _venueTzCache = new Map<string, string | null>();

// Shared Mongo projection for CSV chunk fetches. Only includes fields the row
// mapper actually reads — six previously-projected fields were unused
// (inventory.notes, inventory.in_hand, inventory.files_available,
// inventory.stubhubAtFloor, inventory.stubhubPricedAt,
// inventory.stubhubSectionLowest). Pruning them shrinks every chunk's BSON
// payload and parse cost.
const CSV_PROJECTION = {
  'inventory.inventoryId': 1,
  'event_name': 1,
  'venue_name': 1,
  'event_date': 1,
  'eventId': 1,
  'mapping_id': 1,
  'inventory.quantity': 1,
  'inventory.section': 1,
  'inventory.row': 1,
  'seats.number': 1,
  'inventory.barcodes': 1,
  'inventory.tags': 1,
  'inventory.publicNotes': 1,
  'inventory.listPrice': 1,
  'inventory.face_price': 1,
  'inventory.taxed_cost': 1,
  'inventory.cost': 1,
  'inventory.hideSeatNumbers': 1,
  'inventory.inHandDate': 1,
  'inventory.instant_transfer': 1,
  'inventory.splitType': 1,
  'inventory.customSplit': 1,
  'inventory.stockType': 1,
  'inventory.zone': 1,
  'inventory.shown_quantity': 1,
  'inventory.passthrough': 1,
  'inventory.stubhubSuggestedPrice': 1,
} as const;

// ── Global: stop events with seats <= threshold & clear their inventory ──
export async function stopLowSeatEvents(): Promise<{ stopped: number; eventIds: string[] }> {
  await dbConnect();
  try {
    // Read settings from DB
    const schedulerSettings = await SchedulerSettings.findOne({}).lean() as any;
    const enabled = schedulerSettings?.lowSeatAutoStop ?? false;
    const threshold = schedulerSettings?.lowSeatThreshold ?? 10;

    if (!enabled) {
      return { stopped: 0, eventIds: [] };
    }

    // Get all active events
    const activeEvents = await Event.find(
      { Skip_Scraping: false },
      { mapping_id: 1, Event_ID: 1, Event_Name: 1, Venue: 1 }
    ).lean();

    if (activeEvents.length === 0) return { stopped: 0, eventIds: [] };

    const mappingIds = activeEvents
      .map((e: any) => e.mapping_id)
      .filter(Boolean);

    // Aggregate total inventory quantity per mapping_id
    const seatCounts: { _id: string; totalQty: number }[] =
      await ConsecutiveGroup.aggregate([
        { $match: { mapping_id: { $in: mappingIds } } },
        { $group: { _id: '$mapping_id', totalQty: { $sum: '$inventory.quantity' } } },
      ]);

    const qtyMap = new Map(seatCounts.map((s) => [s._id, s.totalQty]));

    // Find events whose total seats > 0 but <= threshold
    const lowSeatEvents = activeEvents.filter((ev: any) => {
      const qty = qtyMap.get(ev.mapping_id) ?? 0;
      return qty > 0 && qty <= threshold;
    });

    if (lowSeatEvents.length === 0) return { stopped: 0, eventIds: [] };

    const eventIds = lowSeatEvents.map((ev: any) => String(ev._id));
    const mappingIdsToStop = lowSeatEvents.map((ev: any) => ev.mapping_id).filter(Boolean);

    // Stop scraping
    await Event.updateMany(
      { _id: { $in: eventIds } },
      { $set: { Skip_Scraping: true } }
    );

    // Clear inventory
    await deleteConsecutiveGroupsByEventIds(eventIds);

    console.log(
      `[LowSeat] Stopped ${lowSeatEvents.length} events with <= ${threshold} seats: ${mappingIdsToStop.join(', ')}`
    );

    await createErrorLog({
      eventUrl: 'LOW_SEAT_AUTO_STOP',
      errorType: 'AUTO_STOP',
      message: `Stopped ${lowSeatEvents.length} event(s) with ${threshold} or fewer seats and cleared inventory`,
      metadata: {
        threshold,
        stoppedEvents: lowSeatEvents.map((ev: any) => ({
          id: ev._id,
          mapping_id: ev.mapping_id,
          name: ev.Event_Name,
          venue: ev.Venue,
          seats: qtyMap.get(ev.mapping_id) ?? 0,
        })),
      },
    });

    return { stopped: lowSeatEvents.length, eventIds };
  } catch (error) {
    console.error('[LowSeat] Error during low-seat check:', error);
    return { stopped: 0, eventIds: [] };
  }
}

export async function generateInventoryCsv(eventUpdateFilterMinutes: number = 0) {
  return withRetry(async () => {
    await dbConnect();

    const mongoose = await import('mongoose');

    const startTime = Date.now();

    // Clear venue timezone cache at the start of each CSV generation run
    _venueTzCache.clear();

    // ── Stop low-seat events before generating CSV ──
    const lowSeatResult = await stopLowSeatEvents();
    if (lowSeatResult.stopped > 0) {
      console.log(`[CSV] Pre-export: stopped ${lowSeatResult.stopped} low-seat event(s)`);
    }

    try {
      let eventFilter = {};
      
      // Only include active events (Skip_Scraping: false)
      const activeEventQuery: Record<string, any> = { Skip_Scraping: false };

      // If eventUpdateFilterMinutes is provided, also filter by recently updated events
      if (eventUpdateFilterMinutes > 0) {
        const cutoffTime = new Date(Date.now() - eventUpdateFilterMinutes * 60 * 1000);
        activeEventQuery.updatedAt = { $gte: cutoffTime };
        console.log(`Filter: Active events updated within last ${eventUpdateFilterMinutes} minutes since ${cutoffTime.toISOString()}`);
      } else {
        console.log('Including all active events (Skip_Scraping: false)');
      }

      const activeEvents = await Event.find(
        activeEventQuery,
        { mapping_id: 1 }
      )
      .read('primary')
      .maxTimeMS(30000);

      console.log(`Found ${activeEvents.length} active events matching filter criteria`);

      if (activeEvents.length === 0) {
        return { success: false, message: eventUpdateFilterMinutes > 0
          ? `No active events updated within the last ${eventUpdateFilterMinutes} minutes.`
          : 'No active events found (all events have Skip_Scraping enabled).' };
      }

      const eventMappingIds = activeEvents.map(event => event.mapping_id);
      eventFilter = { mapping_id: { $in: eventMappingIds } };

      // Pre-fetch ALL event details once (small — only active events) instead of
      // running $lookup per chunk. This is the single biggest speed-up.
      const eventDetailsMap = new Map<string, {
        url: string; stdAdj: number; resaleAdj: number; defaultPct: number;
        includeStandard: boolean; includeResale: boolean; useStubHubPricing: boolean;
      }>();
      const eventDocs = await Event.find(
        { mapping_id: { $in: eventMappingIds } },
        { mapping_id: 1, URL: 1, standardMarkupAdjustment: 1, resaleMarkupAdjustment: 1,
          priceIncreasePercentage: 1, includeStandardSeats: 1, includeResaleSeats: 1,
          useStubHubPricing: 1 }
      ).lean();
      for (const ev of eventDocs) {
        eventDetailsMap.set(ev.mapping_id, {
          url: ev.URL || '',
          stdAdj: ev.standardMarkupAdjustment ?? 0,
          resaleAdj: ev.resaleMarkupAdjustment ?? 0,
          defaultPct: ev.priceIncreasePercentage ?? 0,
          includeStandard: ev.includeStandardSeats !== false,
          includeResale: ev.includeResaleSeats !== false,
          useStubHubPricing: ev.useStubHubPricing === true,
        });
      }
      console.log(`[CSV] Pre-fetched details for ${eventDetailsMap.size} events`);

    // Projection — only fields actually read by the row mapper. Six fields
    // (inventory.notes, inventory.in_hand, inventory.files_available, and the
    // three secondary stubhub.* fields) used to be projected but were never
    // referenced; pruning them shrinks every chunk's BSON payload.
    const projection = CSV_PROJECTION;

      // Chunked processing: first get all _ids (fast, no $lookup), then process
      // in batches. Event data is joined in JS from the pre-fetched map.
      const CHUNK_SIZE = 10000;

      // Hoist exclusion-rule + scheduler reads out of the chunk loop. The
      // exclusion-rules DB query used to run inside every chunk; doing it
      // once removes O(chunks) redundant round-trips. Section-mode min-seat
      // is still computed in JS after the loop over post-exclusion records,
      // matching the original behaviour exactly.
      const exclusionFilter = await buildExclusionFilter(eventMappingIds);

      const schedulerSettings = await SchedulerSettings.findOne({}).lean() as any;
      const minSeatFilter: number = schedulerSettings?.minSeatFilter ?? 0;
      const minSeatFilterMode: 'section' | 'row' = schedulerSettings?.minSeatFilterMode ?? 'section';

      // Step 1: Get all matching _ids quickly (no $lookup, very fast)
      const idPipeline: PipelineStage[] = [
        { $match: eventFilter },
        { $sort: { _id: 1 as const } },
        { $project: { _id: 1 } },
      ];
      const allIds = await ConsecutiveGroup.aggregate(idPipeline, {
        allowDiskUse: true,
        maxTimeMS: 60000,
      });
      const totalDocs = allIds.length;
      console.log(`[CSV] Total documents to process: ${totalDocs} (chunk size: ${CHUNK_SIZE})`);

      if (totalDocs === 0) {
        console.log('[CSV] No matching ConsecutiveGroup documents found');
        return { success: false, message: 'No inventory data found. Check if events exist and have inventory data.' };
      }

      // Per-chunk we apply blocked-states + exclusion rules + (if row mode)
      // min-seat. Section-mode min-seat needs the full post-exclusion record
      // set to compute totals, so it runs after the loop — same as before.
      let filteredRecords: CsvRow[] = [];
      let processedCount = 0;
      let producedCount = 0;
      let excludedCount = 0;
      let chunkNum = 0;

      const rowModeMinSeat = minSeatFilter > 0 && minSeatFilterMode === 'row'
        ? (r: CsvRow) => r.quantity > minSeatFilter
        : null;

      // Step 2: Process in chunks — simple find by _ids, no $lookup needed
      for (let i = 0; i < totalDocs; i += CHUNK_SIZE) {
        chunkNum++;
        const chunkStart = Date.now();
        const chunkIds = allIds.slice(i, i + CHUNK_SIZE).map((d: { _id: string }) => d._id);

        const chunkDocs: ConsecutiveGroupDocument[] = await ConsecutiveGroup.aggregate(
          [
            { $match: { _id: { $in: chunkIds } } },
            { $project: projection },
          ] as PipelineStage[],
          { allowDiskUse: true, maxTimeMS: 120000 }
        );

        if (chunkDocs.length > 0) {
          // Enrich docs with event data from the pre-fetched map + apply include/exclude filter
          const enrichedDocs: ConsecutiveGroupDocument[] = [];
          for (const doc of chunkDocs) {
            const evData = doc.mapping_id ? eventDetailsMap.get(doc.mapping_id) : undefined;
            const isStandard = doc.inventory?.splitType === 'NEVERLEAVEONE';
            // Apply per-event standard/resale inclusion toggles
            if (isStandard && evData && !evData.includeStandard) continue;
            if (!isStandard && evData && !evData.includeResale) continue;

            doc.event_url = evData?.url || '';
            doc.event_std_adj = evData?.stdAdj ?? 0;
            doc.event_resale_adj = evData?.resaleAdj ?? 0;
            doc.event_default_pct = evData?.defaultPct ?? 0;
            doc.event_use_stubhub_pricing = evData?.useStubHubPricing ?? false;
            enrichedDocs.push(doc);
          }
          if (enrichedDocs.length > 0) {
            const processedBatch = await processBatch(enrichedDocs);
            producedCount += processedBatch.length;
            for (const r of processedBatch) {
              if (isBlockedVenueState(r)) { excludedCount++; continue; }
              if (!exclusionFilter(r)) { excludedCount++; continue; }
              if (rowModeMinSeat && !rowModeMinSeat(r)) { excludedCount++; continue; }
              filteredRecords.push(r);
            }
          }
        }
        processedCount += chunkIds.length;

        const chunkMs = Date.now() - chunkStart;
        console.log(`[CSV] Chunk ${chunkNum}: ${chunkDocs.length} docs -> ${filteredRecords.length} kept in ${chunkMs}ms (${processedCount}/${totalDocs}, ${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)}MB heap)`);

        // Yield control between chunks
        await new Promise(resolve => {
          if (typeof setImmediate !== 'undefined') {
            setImmediate(resolve);
          } else {
            setTimeout(resolve, 0);
          }
        });
      }

      // Section-mode min-seat: totals are summed across the post-exclusion
      // records (matches the original behaviour exactly — sections whose
      // surviving rows total <= threshold are dropped).
      if (minSeatFilter > 0 && minSeatFilterMode === 'section') {
        const beforeMinSeat = filteredRecords.length;
        const sectionTotals = new Map<string, number>();
        for (const r of filteredRecords) {
          const key = `${r.event_id}|${r.section}`;
          sectionTotals.set(key, (sectionTotals.get(key) ?? 0) + r.quantity);
        }
        filteredRecords = filteredRecords.filter(r => {
          const key = `${r.event_id}|${r.section}`;
          return (sectionTotals.get(key) ?? 0) > minSeatFilter;
        });
        const removed = beforeMinSeat - filteredRecords.length;
        excludedCount += removed;
        console.log(`[CSV] Min seat filter [section] (<= ${minSeatFilter}): removed ${removed} listings`);
      }

      console.log(`[CSV] Done: ${filteredRecords.length} kept / ${producedCount} produced / ${excludedCount} excluded (processed ${processedCount} docs in ${Date.now() - startTime}ms)`);

      if (filteredRecords.length === 0) {
        return { success: false, message: 'No inventory data found after applying exclusion rules. All records were filtered out.' };
      }

      // Optimized CSV generation using streaming approach
      const csvString = await generateCsvString(filteredRecords);
    
      const endTime = Date.now();
      const duration = endTime - startTime;
      const memoryUsage = Math.round(process.memoryUsage().heapUsed / 1024 / 1024);
      
      console.log(`[CSV] ✅ Generation completed in ${duration}ms for ${filteredRecords.length} records (Peak memory: ${memoryUsage}MB)`);

      return { 
        success: true, 
        csv: csvString,
        recordCount: filteredRecords.length,
        excludedCount,
        generationTime: duration,
        memoryUsage
      };
    } catch (error) {
      console.error('Error generating CSV:', error);
      await createErrorLog({
        eventUrl: 'CSV_GENERATION',
        errorType: 'DATABASE_ERROR',
        message: error instanceof Error ? error.message : 'Unknown error',
        stack: error instanceof Error ? error.stack : undefined,
        metadata: {
          operation: 'generateInventoryCsv',
          timestamp: new Date()
        }
      });
      return { success: false, message: 'Failed to generate CSV.' };
    }
  }, 'CSV Generation');
}

// Interface for the document structure from MongoDB aggregation
interface ConsecutiveGroupDocument {
  _id?: string;
  inventory?: {
    inventoryId?: number;
    quantity?: number;
    section?: string;
    row?: string;
    barcodes?: string;
    tags?: string;
    notes?: string;
    publicNotes?: string;
    listPrice?: number;
    face_price?: number;
    taxed_cost?: number;
    cost?: number;
    hideSeatNumbers?: boolean;
    in_hand?: boolean;
    inHandDate?: Date | string;
    instant_transfer?: boolean;
    files_available?: boolean;
    splitType?: string;
    customSplit?: string;
    stockType?: string;
    zone?: boolean;
    shown_quantity?: number;
    passthrough?: string;
    stubhubSuggestedPrice?: number | null;
    stubhubSectionLowest?: number | null;
    stubhubAtFloor?: boolean;
    stubhubPricedAt?: Date | string | null;
  };
  event_name?: string;
  venue_name?: string;
  event_date?: Date | string;
  eventId?: string;
  mapping_id?: string;
  event_url?: string;
  event_std_adj?: number;
  event_resale_adj?: number;
  event_default_pct?: number;
  event_use_stubhub_pricing?: boolean;
  seats?: Array<{ number: string | number }>;
}

// Function to determine split configuration based on ticket type and quantity.
// For resale, prefers the DB `customSplit` value (written by the scraper from TM's
// sellableQuantities, clipped to the actual seat-group size). Falls back to the
// legacy hardcoded table only when the DB value is missing. Standard tickets use
// the DB `customSplit` when present, otherwise NEVERLEAVEONE — no legacy fallback.
function calculateSplitConfiguration(
  quantity: number,
  splitType?: string,
  dbCustomSplit?: string,
): {
  finalSplitType: CsvRow['split_type'];
  customSplit: string;
} {
  const isResale = splitType !== 'NEVERLEAVEONE';

  if (isResale) {
    if (dbCustomSplit && dbCustomSplit.trim().length > 0) {
      return { finalSplitType: 'CUSTOM', customSplit: dbCustomSplit.trim() };
    }

    // Legacy resale fallback — used only when the scraper didn't provide a split.
    if ((quantity % 2 === 0 && quantity >= 10) || (quantity % 2 === 1 && quantity >= 11)) {
      return { finalSplitType: 'NEVERLEAVEONE', customSplit: '' };
    }
    if (quantity === 2) return { finalSplitType: 'CUSTOM', customSplit: '2' };
    if (quantity === 3) return { finalSplitType: 'CUSTOM', customSplit: '3' };
    if (quantity === 4) return { finalSplitType: 'CUSTOM', customSplit: '4' };
    if (quantity === 5) return { finalSplitType: 'CUSTOM', customSplit: '3,5' };
    if (quantity === 6) return { finalSplitType: 'CUSTOM', customSplit: '2,4,6' };
    if (quantity === 7) return { finalSplitType: 'CUSTOM', customSplit: '2,3,4,5,7' };
    if (quantity === 8) return { finalSplitType: 'CUSTOM', customSplit: '2,4,6,8' };
    if (quantity === 9) return { finalSplitType: 'CUSTOM', customSplit: '2,3,4,5,6,7,9' };
    if (quantity === 10) return { finalSplitType: 'CUSTOM', customSplit: '2,4,6,8,10' };
    if (quantity === 11) return { finalSplitType: 'CUSTOM', customSplit: '2,3,4,5,6,7,8,9,11' };
    return { finalSplitType: 'NEVERLEAVEONE', customSplit: '' };
  }

  // Standard (primary) — only apply TM's customSplit when the minimum sellable
  // quantity is >= 4 (i.e. TM is forcing 4-packs or larger). Anything smaller
  // falls through to NEVERLEAVEONE. No synthetic splits are generated.
  if (dbCustomSplit && dbCustomSplit.trim().length > 0) {
    const parsed = dbCustomSplit
      .split(',')
      .map(s => parseInt(s.trim(), 10))
      .filter(n => Number.isFinite(n) && n > 0);
    if (parsed.length > 0 && Math.min(...parsed) >= 4) {
      return { finalSplitType: 'CUSTOM', customSplit: dbCustomSplit.trim() };
    }
  }
  return { finalSplitType: 'NEVERLEAVEONE', customSplit: '' };
}

// Helper function to process batches
async function processBatch(batch: ConsecutiveGroupDocument[]): Promise<CsvRow[]> {
  // Resolve timezones for all unique venues in this batch (bulk, with DB cache + geocoding fallback)
  const uniqueVenues = [...new Set(batch.map(d => d.venue_name).filter(Boolean))] as string[];
  const unresolvedVenues = uniqueVenues.filter(v => !_venueTzCache.has(v));
  if (unresolvedVenues.length > 0) {
    const resolved = await resolveVenueTimezonesBulk(unresolvedVenues);
    for (const [venue, tz] of resolved) {
      _venueTzCache.set(venue, tz);
    }
  }

  return batch.map(doc => {
    const inventory = doc.inventory;
    const isResale = inventory?.splitType !== 'NEVERLEAVEONE';

    // Detect GA/Lawn rows — scraper stores synthetic row names like "GA1", "GA2", etc.
    const row = inventory?.row || '';
    const isGALawn = /^GA\d+$/i.test(row);

    // StubHub auto-pricing: if enabled for this event and scraper has written a price, use it.
    // Otherwise fall back to the standard markup formula.
    const useStubHub = doc.event_use_stubhub_pricing && inventory?.stubhubSuggestedPrice != null;

    // Apply per-ticket-type markup adjustment on top of already-marked-up listPrice.
    // Formula: adjustedPrice = listPrice * (1 + (defaultPct + adj) / 100) / (1 + defaultPct / 100)
    const rawListPrice = inventory?.listPrice || 0;
    const defaultPct = doc.event_default_pct ?? 0;
    const adj = isResale ? (doc.event_resale_adj ?? 0) : (doc.event_std_adj ?? 0);
    const markupPrice = defaultPct !== 0 || adj !== 0
      ? rawListPrice * (1 + (defaultPct + adj) / 100) / (1 + defaultPct / 100)
      : rawListPrice;

    const adjustedListPrice = useStubHub ? inventory!.stubhubSuggestedPrice! : markupPrice;

    // Pre-compute expensive operations with null safety
    // GA/Lawn seats have synthetic seat numbers — clear them so Sync doesn't see fake numbers
    const seatsString = isGALawn ? '' :
      (doc.seats && doc.seats.length > 0 ?
        doc.seats.map((seat: { number: string | number }) => String(seat.number)).join(',') : '');
    const eventDateString = doc.event_date ?
      new Date(doc.event_date).toISOString() : '';

    // In-hand date logic: if event is today or in the past (in venue's timezone),
    // use the event date as in-hand date so Sync doesn't reject it.
    // Otherwise use the stored inHandDate (typically event date - 1 day).
    let inHandDateString = inventory?.inHandDate
      ? new Date(inventory.inHandDate).toISOString().slice(0, 10) : '';
    if (doc.event_date) {
      const eventDateOnly = new Date(doc.event_date).toISOString().slice(0, 10);
      const venueTz = doc.venue_name ? _venueTzCache.get(doc.venue_name) ?? null : null;
      if (venueTz) {
        const nowInVenueTz = getCurrentTimeInTimezone(venueTz);
        const todayInVenueTz = nowInVenueTz.toISOString().slice(0, 10);
        if (eventDateOnly <= todayInVenueTz) {
          inHandDateString = eventDateOnly;
        }
      }
      // No fallback — if timezone can't be detected even with live API, keep the stored inHandDate
    }

    // Calculate split configuration. Passes the DB `customSplit` (written by the
    // scraper from TM's sellableQuantities) as the preferred source for resale.
    const { finalSplitType, customSplit } = calculateSplitConfiguration(
      inventory?.quantity || 0,
      inventory?.splitType,
      inventory?.customSplit,
    );

    // Check if row is SRO and handle public notes accordingly
    const isSRO = row.toUpperCase() === 'SRO';
    const existingPublicNotes = inventory?.publicNotes || '';
    const publicNotes = isSRO
      ? (existingPublicNotes ? `${existingPublicNotes} - STANDING ROOM ONLY` : 'STANDING ROOM ONLY')
      : existingPublicNotes;

    // Tags: GA tickets get GA_STANDARD / GA_RESALE, regular tickets get STANDARD / RESALE.
    // Any extra tags stored on the inventory (anything other than the reserved
    // STANDARD/RESALE/GA_* values) are appended so they survive the export.
    const isStandard = inventory?.splitType === 'NEVERLEAVEONE';
    const baseTag = isGALawn
      ? (isStandard ? 'GA_STANDARD' : 'GA_RESALE')
      : (isStandard ? 'STANDARD' : 'RESALE');
    const RESERVED_TAGS = new Set(['STANDARD', 'RESALE', 'GA_STANDARD', 'GA_RESALE']);
    // Prefer specific inventory tags (e.g. "RESALE BROKER") over the generic base.
    // Tags are emitted uppercased; fall back to the base tag when none are present.
    const extraTags = (inventory?.tags || '')
      .split(',')
      .map(t => t.trim().toUpperCase())
      .filter(t => t.length > 0 && !RESERVED_TAGS.has(t));
    const tags = extraTags.length > 0 ? extraTags.join(',') : baseTag;

    return {
      inventory_id: inventory?.inventoryId || 0,
      event_name: doc.event_name || "",
      venue_name: doc.venue_name || "",
      event_date: eventDateString,
      event_id: doc.mapping_id || "",
      quantity: inventory?.quantity || 0,
      section: inventory?.section || "",
      row: inventory?.row || "",
      seats: seatsString,
      barcodes: inventory?.barcodes || "",
      internal_notes: ALL_TEAMS_LOWER.some(team => (doc.event_name || "").toLowerCase().includes(team))
        ? "-tnow -tmplus -geek"
        : "-tnow -tmplus",
      public_notes: publicNotes,
      tags,
      list_price: Number(adjustedListPrice.toFixed(2)),
      face_price: Number((inventory?.face_price || inventory?.cost || 0).toFixed(2)),
      taxed_cost: Number((inventory?.taxed_cost || inventory?.cost || 0).toFixed(2)),
      cost: Number((inventory?.cost || 0).toFixed(2)),
      hide_seats: inventory?.hideSeatNumbers ? "Y" : "N",
      in_hand: "N", // Always set to "N" as per original code
      in_hand_date: inHandDateString,
      instant_transfer: inventory?.instant_transfer ? "Y" : "N",
      files_available: "N",
      split_type: finalSplitType,
      custom_split: customSplit,
      stock_type:
        (inventory?.stockType as CsvRow["stock_type"]) || "ELECTRONIC",
      zone: isGALawn ? "Y" : "N",
      shown_quantity: inventory?.shown_quantity || undefined,
      passthrough: inventory?.passthrough || "",
    } as CsvRow;
  });
}

// CSV cell encoders — one regex pass instead of four .includes() calls per
// cell, and known-safe columns (numbers, Y/N enums, ISO dates) skip the
// escape check entirely. With ~28 columns × N rows the old encoder did
// ~112×N substring scans; this brings it to ~10×N regex tests on the
// columns that can actually contain commas/quotes/newlines.
const CSV_NEEDS_ESCAPE_RE = /[",\r\n]/;

function escapeMaybe(value: unknown): string {
  if (value === null || value === undefined) return '';
  const s = typeof value === 'string' ? value : String(value);
  if (CSV_NEEDS_ESCAPE_RE.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function asNumberOrEmpty(value: unknown): string {
  if (value === null || value === undefined) return '';
  return typeof value === 'number' ? (value as number).toString() : String(value);
}

function asSafeString(value: unknown): string {
  if (value === null || value === undefined) return '';
  return value as string;
}

type ColEncoder = (value: unknown) => string;
const COLUMN_ENCODERS: Array<{ id: keyof CsvRow; encode: ColEncoder }> = [
  { id: 'inventory_id', encode: asNumberOrEmpty },
  { id: 'event_name', encode: escapeMaybe },
  { id: 'venue_name', encode: escapeMaybe },
  { id: 'event_date', encode: asSafeString },
  { id: 'event_id', encode: escapeMaybe },
  { id: 'quantity', encode: asNumberOrEmpty },
  { id: 'section', encode: escapeMaybe },
  { id: 'row', encode: escapeMaybe },
  { id: 'seats', encode: escapeMaybe },
  { id: 'barcodes', encode: escapeMaybe },
  { id: 'internal_notes', encode: escapeMaybe },
  { id: 'public_notes', encode: escapeMaybe },
  { id: 'tags', encode: escapeMaybe },
  { id: 'list_price', encode: asNumberOrEmpty },
  { id: 'face_price', encode: asNumberOrEmpty },
  { id: 'taxed_cost', encode: asNumberOrEmpty },
  { id: 'cost', encode: asNumberOrEmpty },
  { id: 'hide_seats', encode: asSafeString },
  { id: 'in_hand', encode: asSafeString },
  { id: 'in_hand_date', encode: asSafeString },
  { id: 'instant_transfer', encode: asSafeString },
  { id: 'files_available', encode: asSafeString },
  { id: 'split_type', encode: asSafeString },
  { id: 'custom_split', encode: escapeMaybe },
  { id: 'stock_type', encode: asSafeString },
  { id: 'zone', encode: asSafeString },
  { id: 'shown_quantity', encode: asNumberOrEmpty },
  { id: 'passthrough', encode: escapeMaybe },
];
const CSV_HEADER_LINE = csvColumns.map(c => c.title).join(',');

function encodeRow(record: CsvRow): string {
  const cells = new Array<string>(COLUMN_ENCODERS.length);
  for (let i = 0; i < COLUMN_ENCODERS.length; i++) {
    const col = COLUMN_ENCODERS[i];
    cells[i] = col.encode(record[col.id]);
  }
  return cells.join(',');
}

// Build the full CSV in memory for the non-stream path. Single header push,
// per-chunk row encoding, periodic event-loop yields.
async function generateCsvString(records: CsvRow[]): Promise<string> {
  const out: string[] = [CSV_HEADER_LINE];
  const CHUNK_SIZE = 1000;
  for (let i = 0; i < records.length; i += CHUNK_SIZE) {
    const end = Math.min(i + CHUNK_SIZE, records.length);
    const lines = new Array<string>(end - i);
    for (let j = i; j < end; j++) {
      lines[j - i] = encodeRow(records[j]);
    }
    out.push(lines.join('\n'));

    if (i > 0 && (i / CHUNK_SIZE) % 5 === 0) {
      await new Promise(resolve => {
        if (typeof setImmediate !== 'undefined') setImmediate(resolve);
        else setTimeout(resolve, 0);
      });
    }
  }
  return out.join('\n');
}

function recordsToCsvChunk(records: CsvRow[]): string {
  const lines = new Array<string>(records.length);
  for (let i = 0; i < records.length; i++) {
    lines[i] = encodeRow(records[i]);
  }
  return lines.join('\n');
}

// Streaming CSV generator — yields CSV text chunks as they're produced.
// This keeps the HTTP connection alive so reverse proxies don't 504.
export async function* generateInventoryCsvStream(
  eventUpdateFilterMinutes: number = 0
): AsyncGenerator<{ type: 'header' | 'data' | 'done'; text?: string; recordCount?: number; excludedCount?: number; generationTime?: number; error?: string }> {
  await dbConnect();

  const startTime = Date.now();
  _venueTzCache.clear();

  // ── Stop low-seat events before streaming CSV ──
  const lowSeatResult = await stopLowSeatEvents();
  if (lowSeatResult.stopped > 0) {
    console.log(`[CSV-Stream] Pre-export: stopped ${lowSeatResult.stopped} low-seat event(s)`);
  }

  // Load min seat filter setting
  const schedulerSettings = await SchedulerSettings.findOne({}).lean() as any;
  const minSeatFilter = schedulerSettings?.minSeatFilter ?? 0;
  const minSeatFilterMode = schedulerSettings?.minSeatFilterMode ?? 'section';

  try {
    const activeEventQuery: Record<string, any> = { Skip_Scraping: false };
    if (eventUpdateFilterMinutes > 0) {
      const cutoffTime = new Date(Date.now() - eventUpdateFilterMinutes * 60 * 1000);
      activeEventQuery.updatedAt = { $gte: cutoffTime };
    }

    const activeEvents = await Event.find(activeEventQuery, { mapping_id: 1 })
      .read('primary')
      .maxTimeMS(30000);

    if (activeEvents.length === 0) {
      yield { type: 'done', error: eventUpdateFilterMinutes > 0
        ? `No active events updated within the last ${eventUpdateFilterMinutes} minutes.`
        : 'No active events found (all events have Skip_Scraping enabled).' };
      return;
    }

    const eventMappingIds = activeEvents.map(event => event.mapping_id);
    const eventFilter = { mapping_id: { $in: eventMappingIds } };

    const eventDetailsMap = new Map<string, {
      url: string; stdAdj: number; resaleAdj: number; defaultPct: number;
      includeStandard: boolean; includeResale: boolean; useStubHubPricing: boolean;
    }>();
    const eventDocs = await Event.find(
      { mapping_id: { $in: eventMappingIds } },
      { mapping_id: 1, URL: 1, standardMarkupAdjustment: 1, resaleMarkupAdjustment: 1,
        priceIncreasePercentage: 1, includeStandardSeats: 1, includeResaleSeats: 1,
        useStubHubPricing: 1 }
    ).lean();
    for (const ev of eventDocs) {
      eventDetailsMap.set(ev.mapping_id, {
        url: ev.URL || '',
        stdAdj: ev.standardMarkupAdjustment ?? 0,
        resaleAdj: ev.resaleMarkupAdjustment ?? 0,
        defaultPct: ev.priceIncreasePercentage ?? 0,
        includeStandard: ev.includeStandardSeats !== false,
        includeResale: ev.includeResaleSeats !== false,
        useStubHubPricing: ev.useStubHubPricing === true,
      });
    }

    const projection = CSV_PROJECTION;

    // Build the per-record exclusion filter once. This used to be re-fetched
    // (Event.find + ExclusionRules.find) inside every chunk iteration; for an
    // export with N chunks that was 2N redundant DB round-trips.
    const exclusionFilter = await buildExclusionFilter(eventMappingIds);

    const CHUNK_SIZE = 10000;
    const idPipeline: PipelineStage[] = [
      { $match: eventFilter },
      { $sort: { _id: 1 as const } },
      { $project: { _id: 1 } },
    ];
    const allIds = await ConsecutiveGroup.aggregate(idPipeline, {
      allowDiskUse: true, maxTimeMS: 60000,
    });
    const totalDocs = allIds.length;

    if (totalDocs === 0) {
      yield { type: 'done', error: 'No inventory data found.' };
      return;
    }

    // Pre-aggregate global section totals in one Mongo pass so the per-chunk
    // min-seat filter sees the whole section instead of just the current chunk.
    // This gives parity with generateInventoryCsv while keeping streaming alive.
    const sectionTotalsMap = new Map<string, number>();
    if (minSeatFilter > 0 && minSeatFilterMode === 'section') {
      const aggStart = Date.now();
      // CsvRow.event_id is populated from doc.mapping_id (see processBatch),
      // so lookups are keyed `${mapping_id}|${section}`. Aggregate by the same
      // field to keep parity with the non-stream path.
      const totals = await ConsecutiveGroup.aggregate(
        [
          { $match: eventFilter },
          {
            $group: {
              _id: { mappingId: '$mapping_id', section: '$inventory.section' },
              total: { $sum: '$inventory.quantity' },
            },
          },
        ] as PipelineStage[],
        { allowDiskUse: true, maxTimeMS: 60000 }
      );
      for (const row of totals) {
        const key = `${row._id.mappingId}|${row._id.section}`;
        sectionTotalsMap.set(key, row.total);
      }
      console.log(`[CSV Stream] Pre-aggregated ${sectionTotalsMap.size} section totals in ${Date.now() - aggStart}ms`);
    }

    // Yield CSV header immediately to keep connection alive
    yield { type: 'header', text: CSV_HEADER_LINE + '\n' };

    let totalRecords = 0;
    let totalExcluded = 0;

    for (let i = 0; i < totalDocs; i += CHUNK_SIZE) {
      const chunkIds = allIds.slice(i, i + CHUNK_SIZE).map((d: { _id: string }) => d._id);

      const chunkDocs: ConsecutiveGroupDocument[] = await ConsecutiveGroup.aggregate(
        [
          { $match: { _id: { $in: chunkIds } } },
          { $project: projection },
        ] as PipelineStage[],
        { allowDiskUse: true, maxTimeMS: 120000 }
      );

      if (chunkDocs.length > 0) {
        const enrichedDocs: ConsecutiveGroupDocument[] = [];
        for (const doc of chunkDocs) {
          const evData = doc.mapping_id ? eventDetailsMap.get(doc.mapping_id) : undefined;
          const isStandard = doc.inventory?.splitType === 'NEVERLEAVEONE';
          if (isStandard && evData && !evData.includeStandard) continue;
          if (!isStandard && evData && !evData.includeResale) continue;
          doc.event_url = evData?.url || '';
          doc.event_std_adj = evData?.stdAdj ?? 0;
          doc.event_resale_adj = evData?.resaleAdj ?? 0;
          doc.event_default_pct = evData?.defaultPct ?? 0;
          doc.event_use_stubhub_pricing = evData?.useStubHubPricing ?? false;
          enrichedDocs.push(doc);
        }

        if (enrichedDocs.length > 0) {
          const processedBatch = await processBatch(enrichedDocs);
          const beforeBatchFilters = processedBatch.length;
          // Single-pass filter: blocked states + exclusion rules + min-seat.
          // Avoids walking the batch three times and the per-chunk DB query
          // that the old applyExclusionRules() was doing.
          const filtered: CsvRow[] = [];
          for (const r of processedBatch) {
            if (isBlockedVenueState(r)) continue;
            if (!exclusionFilter(r)) continue;
            if (minSeatFilter > 0) {
              if (minSeatFilterMode === 'section') {
                if ((sectionTotalsMap.get(`${r.event_id}|${r.section}`) ?? 0) <= minSeatFilter) continue;
              } else if (r.quantity <= minSeatFilter) {
                continue;
              }
            }
            filtered.push(r);
          }
          totalExcluded += beforeBatchFilters - filtered.length;

          if (filtered.length > 0) {
            totalRecords += filtered.length;
            yield { type: 'data', text: recordsToCsvChunk(filtered) + '\n' };
          }
        }
      }

      // Yield control between chunks
      await new Promise(resolve => (typeof setImmediate !== 'undefined' ? setImmediate : setTimeout)(resolve, 0));
    }

    const duration = Date.now() - startTime;
    console.log(`[CSV Stream] Completed in ${duration}ms: ${totalRecords} records, ${totalExcluded} excluded`);

    if (totalRecords === 0) {
      yield { type: 'done', error: 'No inventory data found after applying exclusion rules.' };
      return;
    }

    yield { type: 'done', recordCount: totalRecords, excludedCount: totalExcluded, generationTime: duration };
  } catch (error) {
    console.error('[CSV Stream] Error:', error);
    await createErrorLog({
      eventUrl: 'CSV_GENERATION_STREAM',
      errorType: 'DATABASE_ERROR',
      message: error instanceof Error ? error.message : 'Unknown error',
      stack: error instanceof Error ? error.stack : undefined,
      metadata: { operation: 'generateInventoryCsvStream', timestamp: new Date() }
    });
    yield { type: 'done', error: 'Failed to generate CSV.' };
  }
}

export async function uploadCsvToSyncService(csvContent: string): Promise<{ success: boolean; message: string; uploadId?: string }> {
  return withRetry(async () => {
    try {
      // Get sync service credentials from environment variables
      const companyId = process.env.SYNC_COMPANY_ID;
      const apiToken = process.env.SYNC_API_TOKEN;
      
      if (!companyId || !apiToken) {
        throw new Error('Sync service credentials not configured. Please set SYNC_COMPANY_ID and SYNC_API_TOKEN environment variables.');
      }
      
      // Validate CSV content — reject anything with zero data rows (including
      // header-only uploads). A CSV with just the header is "blank" from the
      // receiver's perspective and must never be pushed to sync.
      if (!csvContent || csvContent.trim().length === 0) {
        throw new Error('CSV content is empty or invalid');
      }
      const nonEmptyLines = csvContent.split('\n').filter(l => l.trim().length > 0);
      if (nonEmptyLines.length <= 1) {
        throw new Error(`Refusing to upload blank CSV (${nonEmptyLines.length} line${nonEmptyLines.length === 1 ? '' : 's'} — header only, no data rows).`);
      }
      
      // Initialize sync service
      const syncService = new SyncService(companyId, apiToken);
      
      // Upload CSV content to sync service with timeout
      const uploadPromise = syncService.uploadCsvContentToSync(csvContent);
      const timeoutPromise = new Promise((_, reject) => {
        setTimeout(() => reject(new Error('Upload timeout after 180 seconds')), 180000);
      });
      // eslint-disable-next-line @typescript-eslint/ban-ts-comment
      const result = await Promise.race([uploadPromise, timeoutPromise]) as any;
      
      // Log detailed server response for debugging
      console.log('=== SERVER UPLOAD RESPONSE ===');
      console.log('Full server response:', JSON.stringify(result, null, 2));
      console.log('Response type:', typeof result);
      console.log('Response keys:', Object.keys(result || {}));
      console.log('==============================');
      
      if ('success' in result && result.success) {
        // Update database with upload status
        await updateSchedulerSettings({
          lastUploadAt: new Date(),
          lastUploadStatus: 'success',
          lastUploadId: (result as { uploadId?: string })?.uploadId
        });
        
        console.log('✅ CSV content uploaded to sync service successfully');
        console.log('Upload ID:', (result as { uploadId?: string })?.uploadId);
        
        return {
          success: true,
          message: 'CSV uploaded to sync service successfully',
          uploadId: (result as { uploadId?: string }).uploadId
        };
      } else {
        console.log('❌ Upload failed - Server response indicates failure');
        console.log('Error message from server:', (result as { message?: string })?.message);
        throw new Error((result as { message?: string }).message || 'Upload failed');
      }
    } catch (error) {
      console.error('Error uploading to sync service:', error);
      
      // Update database with error status
      try {
        await updateSchedulerSettings({
          lastUploadAt: new Date(),
          lastUploadStatus: 'failed',
          lastUploadError: error instanceof Error ? error.message : 'Unknown error occurred'
        });
      } catch (dbError) {
        console.error('Error updating database with upload status:', dbError);
      }
      
      throw error; // Re-throw for retry mechanism
    }
  }, 'CSV Upload', {
    maxRetries: 5, // More retries for upload
    baseDelay: 2000, // Longer delay for network operations
    maxDelay: 30000
  }).catch(error => {
    return {
      success: false,
      message: `Failed to upload CSV to sync service after retries: ${error instanceof Error ? error.message : 'Unknown error'}`
    };
  });
}

export async function deleteInventoryBatchFromSync(inventoryIds: string[]): Promise<{ success: boolean; message: string; successful: string[]; failed: string[] }> {
  try {
    // Get sync service credentials from environment variables
    const companyId = process.env.SYNC_COMPANY_ID;
    const apiToken = process.env.SYNC_API_TOKEN;
    
    if (!companyId || !apiToken) {
      throw new Error('Sync service credentials not configured. Please set SYNC_COMPANY_ID and SYNC_API_TOKEN environment variables.');
    }
    
    if (!inventoryIds || inventoryIds.length === 0) {
      return {
        success: true,
        message: 'No inventory IDs provided for deletion',
        successful: [],
        failed: []
      };
    }
    
    // Initialize sync service
    const syncService = new SyncService(companyId, apiToken);
    
    // Delete specific inventory items
    const result = await syncService.deleteInventoryBatch(inventoryIds);
    
    console.log('Raw sync service response:', JSON.stringify(result, null, 2));
    
    // Check the actual deletion count from the response
    const deletedCount = (result as { deleted?: number })?.deleted ?? 0;
    const totalRequested = inventoryIds.length;
    
    console.log(`Sync service deletion summary: ${deletedCount}/${totalRequested} items deleted`);
    
    if (deletedCount === 0) {
      console.warn('⚠️  No items were deleted from sync service. This could mean:');
      console.warn('   - Inventory IDs do not exist in sync service');
      console.warn('   - Items were already deleted');
      console.warn('   - API endpoint format issue');
    }
    
    // If we get here without an error, sync service reported success
    // Check common success indicators or assume success if no error was thrown
    const isSuccess = ('success' in result && result.success) || 
                      ('status' in result && result.status === 'success') ||
                      ('error' in result && !result.error) ||
                      !('error' in result); // If no explicit error field, assume success
    
    if (isSuccess) {
      const actuallyDeleted = (result as { deleted?: number })?.deleted ?? 0;
      console.log(`Successfully processed deletion request: ${actuallyDeleted}/${inventoryIds.length} inventory items deleted from sync service`);
      
      return {
        success: true,
        message: `Successfully processed deletion request: ${actuallyDeleted}/${inventoryIds.length} inventory items deleted from sync service`,
        successful: actuallyDeleted > 0 ? inventoryIds.slice(0, actuallyDeleted) : [],
        failed: actuallyDeleted < inventoryIds.length ? inventoryIds.slice(actuallyDeleted) : []
      };
    } else {
      throw new Error((result as { message?: string })?.message || 'Batch inventory deletion failed');
    }
  } catch (error) {
    console.error('Error deleting inventory batch from sync service:', error);
    
    return {
      success: false,
      message: `Failed to delete inventory batch from sync service: ${error instanceof Error ? error.message : 'Unknown error'}`,
      successful: [],
      failed: inventoryIds
    };
  }
}

// Database settings functions
export async function getSchedulerSettings() {
  await dbConnect();
  try {
    return await SchedulerSettings.findOne({}) || await SchedulerSettings.create({});
  } catch (error) {
    console.error('Error getting scheduler settings:', error);
    throw error;
  }
}

export async function updateSchedulerSettings(updates: {
  lastUploadAt?: Date;
  lastUploadStatus?: 'success' | 'failed' | 'cleared' | 'clear_failed';
  lastUploadId?: string;
  lastUploadError?: string;
  lastClearAt?: Date;
  scheduleRateMinutes?: number;
  uploadToSync?: boolean;
  isScheduled?: boolean;
  eventUpdateFilterMinutes?: number;
  nextRunAt?: Date;
  totalRuns?: number;
  lowSeatAutoStop?: boolean;
  lowSeatThreshold?: number;
}) {
  await dbConnect();
  try {
    return await SchedulerSettings.findOneAndUpdate({}, updates, { new: true, upsert: true });
  } catch (error) {
    console.error('Error updating scheduler settings:', error);
    throw error;
  }
}

// Auto-Delete Settings functions
export async function getAutoDeleteSettings() {
  await dbConnect();
  try {
    const settings = await AutoDeleteSettings.findOne().lean();
    if (!settings) {
      const created = await AutoDeleteSettings.create({
        isEnabled: false,
        stopBeforeMinutes: 120,
        scheduleIntervalMinutes: 15
      });
      return JSON.parse(JSON.stringify(created));
    }
    return JSON.parse(JSON.stringify(settings));
  } catch (error) {
    console.error('Error getting auto-delete settings:', error);
    throw error;
  }
}

export async function updateAutoDeleteSettings(updates: {
  isEnabled?: boolean;
  stopBeforeMinutes?: number;
  scheduleIntervalMinutes?: number;
  postEventDeleteEnabled?: boolean;
  postEventDeleteHoursAfter?: number;
  lastRunAt?: Date;
  nextRunAt?: Date;
  totalRuns?: number;
  totalEventsDeleted?: number;
  lastRunStats?: {
    eventsChecked: number;
    eventsDeleted: number;
    eventsStopped: number;
    deletedEventIds: string[];
    errors: string[];
  };
}) {
  await dbConnect();
  try {
    const result = await AutoDeleteSettings.findOneAndUpdate(
      {},
      { ...updates, updatedAt: new Date() },
      { new: true, upsert: true }
    ).lean();
    return JSON.parse(JSON.stringify(result));
  } catch (error) {
    console.error('Error updating auto-delete settings:', error);
    throw error;
  }
}

// Auto-Delete Functions
export async function runAutoDelete() {
  try {
    const settings = await getAutoDeleteSettings();
    if (!settings.isEnabled) {
      return {
        success: false,
        message: 'Auto-delete is disabled'
      };
    }

    const stats = await deleteExpiredEvents(settings.stopBeforeMinutes ?? 120, settings.lowSeatThreshold ?? 20);

    // Post-event hard-delete: permanently remove events N hours after they pass
    let postDeleteMsg = '';
    if (settings.postEventDeleteEnabled) {
      const hours = settings.postEventDeleteHoursAfter ?? 12;
      const postStats = await deletePassedEvents(hours);
      if (postStats.deleted > 0) {
        postDeleteMsg = ` Permanently deleted ${postStats.deleted} past event${postStats.deleted > 1 ? 's' : ''} (${hours}h after event date).`;
      }
    }

    // Update settings with run statistics
    const intervalMinutes = settings.scheduleIntervalMinutes || 15;
    const nextRunDate = new Date(Date.now() + intervalMinutes * 60 * 1000);
    await updateAutoDeleteSettings({
      lastRunAt: new Date(),
      ...(isNaN(nextRunDate.getTime()) ? {} : { nextRunAt: nextRunDate }),
      totalRuns: (settings.totalRuns || 0) + 1,
      totalEventsDeleted: settings.totalEventsDeleted + stats.eventsDeleted + stats.lowSeatStopped,
      lastRunStats: {
        eventsChecked: stats.totalEventsChecked,
        eventsDeleted: stats.eventsDeleted,
        eventsStopped: stats.eventsStopped,
        deletedEventIds: stats.deletedEventIds,
        errors: stats.errors
      }
    });

    const lowMsg = stats.lowSeatStopped > 0 ? ` Low-seat stopped: ${stats.lowSeatStopped}.` : '';
    return {
      success: true,
      message: `Auto-delete completed. Stopped ${stats.eventsStopped} events and cleared inventory for ${stats.eventsDeleted} events.${lowMsg}${postDeleteMsg}`,
      stats
    };
  } catch (error) {
    console.error('Error running auto-delete:', error);
    return {
      success: false,
      message: `Auto-delete failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
      error: error instanceof Error ? error.message : 'Unknown error'
    };
  }
}

export async function getAutoDeletePreview(stopBeforeMinutes?: number) {
  try {
    const settings = await getAutoDeleteSettings();
    const minutes = stopBeforeMinutes ?? settings.stopBeforeMinutes ?? 120;
    const preview = await getExpiredEventsStats(minutes);

    return {
      ...preview,
      stopBeforeMinutes: minutes
    };
  } catch (error) {
    console.error('Error getting auto-delete preview:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
      count: 0,
      events: []
    };
  }
}
