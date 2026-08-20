'use server';
import dbConnect from '../lib/dbConnect';
import { ExclusionRules } from '../models/exclusionRulesModel';
import { ConsecutiveGroup } from '../models/seatModel';
import { createErrorLog } from './errorLogActions';

export interface SectionRowExclusion {
  section: string;
  excludeEntireSection: boolean;
  excludedRows: string[];
}

export interface DominatedListingsRule {
  enabled: boolean;
}

export interface ExclusionRulesData {
  eventId: string;
  eventName: string;
  sectionRowExclusions: SectionRowExclusion[];
  dominatedListings?: DominatedListingsRule;
  isActive: boolean;
}

export interface OutlierListing {
  section: string;
  row: string;
  listPrice: number;
  quantity: number;
  sectionAvgPrice: number; // average price within this section
  deviationPct: number;    // % below section average (positive = below)
}

export interface OutlierAnalysis {
  standard: { avgPrice: number; totalListings: number; outliers: OutlierListing[] };
  resale:   { avgPrice: number; totalListings: number; outliers: OutlierListing[] };
}

// Get exclusion rules for an event
export async function getExclusionRules(eventId: string) {
  try {
    await dbConnect();
    const rules = await ExclusionRules.findOne({ eventId, isActive: true }).lean();
    
    // Convert MongoDB document to plain object
    const plainRules = rules ? JSON.parse(JSON.stringify(rules)) : null;
    
    return { success: true, data: plainRules };
  } catch (error) {
    console.error('Error fetching exclusion rules:', error);
    await createErrorLog({
      errorType: 'EXCLUSION_RULES_FETCH_ERROR',
      errorMessage: `Failed to fetch exclusion rules for event ${eventId}`,
      stackTrace: error instanceof Error ? error.message : 'Unknown error',
      metadata: { eventId }
    });
    return { success: false, error: 'Failed to fetch exclusion rules' };
  }
}

// Save or update exclusion rules for an event
export async function saveExclusionRules(rulesData: ExclusionRulesData) {
  try {
    await dbConnect();
    
    const updatedRules = await ExclusionRules.findOneAndUpdate(
      { eventId: rulesData.eventId },
      rulesData,
      { 
        upsert: true, 
        new: true,
        runValidators: true,
        lean: true
      }
    );

    // Convert MongoDB document to plain object
    const plainRules = updatedRules ? JSON.parse(JSON.stringify(updatedRules)) : null;

    return { success: true, data: plainRules };
  } catch (error) {
    console.error('Error saving exclusion rules:', error);
    await createErrorLog({
      errorType: 'EXCLUSION_RULES_SAVE_ERROR',
      errorMessage: `Failed to save exclusion rules for event ${rulesData.eventId}`,
      stackTrace: error instanceof Error ? error.message : 'Unknown error',
      metadata: { eventId: rulesData.eventId, rulesData }
    });
    return { success: false, error: 'Failed to save exclusion rules' };
  }
}

// Delete exclusion rules for an event
export async function deleteExclusionRules(eventId: string) {
  try {
    await dbConnect();
    await ExclusionRules.findOneAndUpdate(
      { eventId },
      { isActive: false },
      { new: true }
    );
    return { success: true };
  } catch (error) {
    console.error('Error deleting exclusion rules:', error);
    await createErrorLog({
      errorType: 'EXCLUSION_RULES_DELETE_ERROR',
      errorMessage: `Failed to delete exclusion rules for event ${eventId}`,
      stackTrace: error instanceof Error ? error.message : 'Unknown error',
      metadata: { eventId }
    });
    return { success: false, error: 'Failed to delete exclusion rules' };
  }
}

// Get available sections and rows for an event
export async function getEventSectionsAndRows(eventId: string) {
  try {
    await dbConnect();
    
    // First get the event to find its mapping_id
    const { Event } = await import('../models/eventModel');
    const event = await Event.findById(eventId).lean();
    if (!event || Array.isArray(event) || !('mapping_id' in event)) {
      return { success: false, error: 'Event not found' };
    }
    
    const pipeline = [
      { $match: { mapping_id: (event as any).mapping_id } },
      {
        $group: {
          _id: '$inventory.section',
          rows: { $addToSet: '$inventory.row' },
          totalListings: { $sum: 1 },
          avgPrice: { $avg: '$inventory.listPrice' }
        }
      },
      {
        $project: {
          section: '$_id',
          rows: { $sortArray: { input: '$rows', sortBy: 1 } },
          totalListings: 1,
          avgPrice: { $round: ['$avgPrice', 2] }
        }
      },
      { $sort: { section: 1 as const } }
    ];

    const result = await ConsecutiveGroup.aggregate(pipeline);
    
    // Convert MongoDB documents to plain objects
    const plainResult = result ? JSON.parse(JSON.stringify(result)) : [];
    
    return { success: true, data: plainResult };
  } catch (error) {
    console.error('Error fetching sections and rows:', error);
    await createErrorLog({
      errorType: 'SECTIONS_ROWS_FETCH_ERROR',
      errorMessage: `Failed to fetch sections and rows for event ${eventId}`,
      stackTrace: error instanceof Error ? error.message : 'Unknown error',
      metadata: { eventId }
    });
    return { success: false, error: 'Failed to fetch sections and rows' };
  }
}

// Get outlier listings (prices below average) for an event, split by standard vs resale
export async function getOutlierAnalysis(eventId: string): Promise<{ success: boolean; data?: OutlierAnalysis; error?: string }> {
  try {
    await dbConnect();
    const { Event } = await import('../models/eventModel');
    const event = await Event.findById(eventId).lean();
    if (!event || Array.isArray(event) || !('mapping_id' in event)) {
      return { success: false, error: 'Event not found' };
    }

    const mappingId = (event as any).mapping_id;

    // Aggregate all listings grouped by section+row+splitType with their listPrice
    const rows = await ConsecutiveGroup.aggregate([
      { $match: { mapping_id: mappingId } },
      {
        $project: {
          section: '$inventory.section',
          row: '$inventory.row',
          listPrice: '$inventory.listPrice',
          quantity: '$inventory.quantity',
          isStandard: { $eq: ['$inventory.splitType', 'NEVERLEAVEONE'] },
        }
      }
    ]);

    const plain: Array<{ section: string; row: string; listPrice: number; quantity: number; isStandard: boolean }> =
      JSON.parse(JSON.stringify(rows));

    const standard = plain.filter(r => r.isStandard);
    const resale   = plain.filter(r => !r.isStandard);

    function analyze(listings: typeof standard): OutlierAnalysis['standard'] {
      if (!listings.length) return { avgPrice: 0, totalListings: 0, outliers: [] };

      // Global avg (for display only)
      const globalAvg = Math.round((listings.reduce((s, r) => s + r.listPrice, 0) / listings.length) * 100) / 100;

      // Group by section and compute per-section average
      const bySection = new Map<string, typeof standard>();
      for (const r of listings) {
        if (!bySection.has(r.section)) bySection.set(r.section, []);
        bySection.get(r.section)!.push(r);
      }

      const outliers: OutlierListing[] = [];
      for (const sectionListings of bySection.values()) {
        const sectionAvg = Math.round(
          (sectionListings.reduce((s, r) => s + r.listPrice, 0) / sectionListings.length) * 100
        ) / 100;
        for (const r of sectionListings) {
          if (r.listPrice < sectionAvg) {
            outliers.push({
              section: r.section,
              row: r.row,
              listPrice: r.listPrice,
              quantity: r.quantity,
              sectionAvgPrice: sectionAvg,
              deviationPct: Math.round(((sectionAvg - r.listPrice) / sectionAvg) * 100),
            });
          }
        }
      }
      outliers.sort((a, b) => b.deviationPct - a.deviationPct);
      return { avgPrice: globalAvg, totalListings: listings.length, outliers };
    }

    return {
      success: true,
      data: { standard: analyze(standard), resale: analyze(resale) },
    };
  } catch (error) {
    console.error('Error computing outlier analysis:', error);
    return { success: false, error: 'Failed to compute outlier analysis' };
  }
}

