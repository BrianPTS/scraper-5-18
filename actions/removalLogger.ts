/**
 * RemovalLogger — collects per-listing removal-and-keep decisions from
 * every filter in the CSV emit pipeline, then batch-flushes to Mongo at
 * end of run.
 *
 * Contract:
 *   - startRun(runId) at the top of generateInventoryCsv
 *   - log(entry) called by every filter that keeps or removes a row
 *   - finishRun({ inputInventoryIds, keptInventoryIds }) at end of run
 *     enforces the "no drops without a reason" guard: any listing in
 *     the input that isn't in kept AND doesn't have a REMOVED entry
 *     gets a synthetic UNKNOWN entry logged and its inventory_id is
 *     returned so the caller can re-add it to the emit.
 *
 * Enable via env var REMOVAL_LOG=1 to avoid write pressure until
 * ready. When disabled, every call is a cheap no-op.
 */

type Reason =
  | 'CLEAN_SURVIVOR'
  | 'PASSTHROUGH'
  | 'SYNTHETIC_COVER'
  | 'SYNTHETIC_COMBINED'
  | 'RECOVERED_NO_ATTRIBUTION'
  | 'DOMINATED'
  | 'SECTION_ROW_EXCLUSION'
  | 'BLOCKED_VENUE_STATE'
  | 'STANDARD_DROP_HOLD'
  | 'MIN_SEAT_ROW'
  | 'MIN_SEAT_SECTION'
  | 'HOLD_OFFER'
  | 'PACKAGE_OFFER'
  | 'MANUAL_REMOVE'
  | 'UNKNOWN';

export interface RemovalEntry {
  inventoryId: string;
  eventId: string;
  section?: string;
  row?: string;
  quantity?: number;
  customSplit?: string;
  tags?: string;
  tier?: 'broker' | 'fan' | 'standard' | 'other';
  listPrice?: number;
  facePrice?: number;
  outcome: 'KEPT' | 'REMOVED';
  reason: Reason;
  detail?: string;
  dominatorInventoryId?: string;
}

class Run {
  runId: string;
  emittedAt: Date;
  buffer: RemovalEntry[] = [];
  loggedIds = new Set<string>();
  constructor(runId: string) {
    this.runId = runId;
    this.emittedAt = new Date();
  }
  log(e: RemovalEntry) {
    if (!e.inventoryId) return;
    if (this.loggedIds.has(e.inventoryId)) return; // one entry per listing per run
    this.loggedIds.add(e.inventoryId);
    this.buffer.push(e);
  }
}

let currentRun: Run | null = null;

export function isEnabled(): boolean {
  return process.env.REMOVAL_LOG === '1';
}

export function startRun(runId?: string): string | null {
  if (!isEnabled()) { currentRun = null; return null; }
  const id = runId || `run_${new Date().toISOString().replace(/[:.]/g, '-')}_${Math.random().toString(36).slice(2, 8)}`;
  currentRun = new Run(id);
  return id;
}

export function log(entry: RemovalEntry): void {
  if (!currentRun) return;
  currentRun.log(entry);
}

/**
 * Reconciliation guard. For every inventoryId in the raw input that has
 * neither a KEPT nor a REMOVED entry, log UNKNOWN and return the id so
 * the caller can force-include that listing in the CSV emit.
 */
export function reconcile(
  inputInventoryIds: Iterable<string>,
  keptInventoryIds: Iterable<string>,
  hydrate: (invId: string) => Partial<RemovalEntry> | null,
): string[] {
  if (!currentRun) return [];
  const kept = new Set(keptInventoryIds);
  const rescued: string[] = [];
  for (const invId of inputInventoryIds) {
    if (currentRun.loggedIds.has(invId)) continue;
    const base = hydrate(invId) || {};
    if (kept.has(invId)) {
      // Fully unattributed keep — mark as clean fallback so audit sees full coverage.
      currentRun.log({
        inventoryId: invId,
        eventId: base.eventId || '',
        section: base.section, row: base.row, quantity: base.quantity,
        customSplit: base.customSplit, tags: base.tags, tier: base.tier,
        listPrice: base.listPrice, facePrice: base.facePrice,
        outcome: 'KEPT', reason: 'CLEAN_SURVIVOR',
        detail: 'End-of-run reconciliation: kept but no filter claimed the decision',
      });
    } else {
      // Would have been silently dropped. Rescue it.
      currentRun.log({
        inventoryId: invId,
        eventId: base.eventId || '',
        section: base.section, row: base.row, quantity: base.quantity,
        customSplit: base.customSplit, tags: base.tags, tier: base.tier,
        listPrice: base.listPrice, facePrice: base.facePrice,
        outcome: 'KEPT', reason: 'RECOVERED_NO_ATTRIBUTION',
        detail: 'End-of-run rescue: no filter attributed a removal reason, so the listing was re-added to the emit',
      });
      rescued.push(invId);
    }
  }
  return rescued;
}

/**
 * Flush the run's buffer to Mongo via insertMany. Fails silently on
 * error so the emit isn't blocked by log-write issues.
 */
export async function finishRun(): Promise<{ runId: string; written: number } | null> {
  if (!currentRun) return null;
  const run = currentRun;
  currentRun = null;
  const buffer = run.buffer;
  if (buffer.length === 0) return { runId: run.runId, written: 0 };
  try {
    const { RemovalLog } = await import('../models/removalLogModel.js');
    const docs = buffer.map(e => ({
      runId: run.runId,
      emittedAt: run.emittedAt,
      inventoryId: e.inventoryId,
      eventId: e.eventId || '',
      section: e.section || '',
      row: e.row || '',
      quantity: e.quantity || 0,
      customSplit: e.customSplit || '',
      tags: e.tags || '',
      tier: e.tier || 'other',
      listPrice: e.listPrice || 0,
      facePrice: e.facePrice || 0,
      outcome: e.outcome,
      reason: e.reason,
      detail: e.detail || '',
      dominatorInventoryId: e.dominatorInventoryId || '',
    }));
    // Break into 5000-doc chunks so ordered:false insertMany stays safe.
    const CHUNK = 5000;
    let written = 0;
    for (let i = 0; i < docs.length; i += CHUNK) {
      const slice = docs.slice(i, i + CHUNK);
      await (RemovalLog as any).insertMany(slice, { ordered: false, lean: true });
      written += slice.length;
    }
    console.log(`[RemovalLog] runId=${run.runId} wrote ${written} entries`);
    return { runId: run.runId, written };
  } catch (err) {
    console.warn(`[RemovalLog] flush failed: ${(err as Error)?.message || err}`);
    return { runId: run.runId, written: 0 };
  }
}

/**
 * Summary of the run's buffer for logging at end-of-run before flush.
 * Never throws.
 */
export function summary(): { total: number; byReason: Record<string, number> } {
  if (!currentRun) return { total: 0, byReason: {} };
  const byReason: Record<string, number> = {};
  for (const e of currentRun.buffer) {
    byReason[e.reason] = (byReason[e.reason] || 0) + 1;
  }
  return { total: currentRun.buffer.length, byReason };
}
