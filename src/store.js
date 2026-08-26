/**
 * Flat-file store. One JSON document on disk, held in memory, written back
 * atomically (write temp file, then rename) so a crash mid-write can never
 * truncate the file you have been reconciling against all day.
 *
 * Records are keyed by their source id, so re-importing the same export — which
 * is exactly what happens when you re-download today's file every hour — updates
 * rows in place instead of duplicating them.
 */

import { existsSync, mkdirSync } from 'node:fs';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { DEFAULT_OPTIONS } from './match.js';

const EMPTY = () => ({
  version: 1,
  purchases: {},
  charges: {},
  overrides: { links: [], ignoredPurchases: [], ignoredCharges: [] },
  settings: { ...DEFAULT_OPTIONS },
  imports: [],
});

export class Store {
  /** @param {string} file path to the JSON document */
  constructor(file) {
    this.file = file;
    this.data = EMPTY();
    this.listeners = new Set();
    this.writeTimer = null;
    this.writing = null;
  }

  async load() {
    mkdirSync(dirname(this.file), { recursive: true });
    if (!existsSync(this.file)) {
      await this.flush();
      return this.data;
    }
    try {
      const parsed = JSON.parse(await readFile(this.file, 'utf8'));
      this.data = { ...EMPTY(), ...parsed };
      this.data.overrides = { ...EMPTY().overrides, ...(parsed.overrides ?? {}) };
      this.data.settings = { ...DEFAULT_OPTIONS, ...(parsed.settings ?? {}) };
    } catch (err) {
      // A corrupt store should not stop the dashboard from starting; keep the
      // bad file around so it can be inspected.
      const backup = `${this.file}.corrupt-${Date.now()}`;
      await rename(this.file, backup).catch(() => {});
      console.error(`[store] could not read ${this.file} (${err.message}); moved to ${backup}`);
      this.data = EMPTY();
      await this.flush();
    }
    return this.data;
  }

  /** Subscribe to change events. Returns an unsubscribe function. */
  onChange(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit(event) {
    for (const fn of this.listeners) {
      try {
        fn(event);
      } catch (err) {
        console.error('[store] listener failed:', err.message);
      }
    }
  }

  /**
   * Insert or update records.
   * @param {'purchases'|'charges'} kind
   * @param {Array<{id: string}>} records
   * @returns {{added: number, updated: number, total: number}}
   */
  upsert(kind, records) {
    const bucket = this.data[kind];
    let added = 0;
    let updated = 0;
    for (const record of records) {
      if (bucket[record.id]) updated += 1;
      else added += 1;
      bucket[record.id] = record;
    }
    return { added, updated, total: Object.keys(bucket).length };
  }

  recordImport(entry) {
    this.data.imports.unshift(entry);
    this.data.imports = this.data.imports.slice(0, 50);
  }

  purchases() {
    return Object.values(this.data.purchases);
  }

  charges() {
    return Object.values(this.data.charges);
  }

  get overrides() {
    return this.data.overrides;
  }

  get settings() {
    return this.data.settings;
  }

  updateSettings(patch) {
    const next = { ...this.data.settings };
    for (const [key, value] of Object.entries(patch)) {
      if (!(key in DEFAULT_OPTIONS)) continue;
      const num = typeof value === 'boolean' ? value : Number(value);
      if (typeof DEFAULT_OPTIONS[key] === 'boolean') next[key] = Boolean(value);
      else if (Number.isFinite(num)) next[key] = num;
    }
    this.data.settings = next;
    return next;
  }

  link(purchaseId, chargeId, note = '') {
    this.unlinkPurchase(purchaseId);
    this.unlinkCharge(chargeId);
    this.data.overrides.links.push({ purchaseId, chargeId, note, linkedAt: new Date().toISOString() });
  }

  unlinkPurchase(purchaseId) {
    this.data.overrides.links = this.data.overrides.links.filter((l) => l.purchaseId !== purchaseId);
  }

  unlinkCharge(chargeId) {
    this.data.overrides.links = this.data.overrides.links.filter((l) => l.chargeId !== chargeId);
  }

  setIgnored(kind, id, ignored) {
    const key = kind === 'purchase' ? 'ignoredPurchases' : 'ignoredCharges';
    const list = new Set(this.data.overrides[key]);
    if (ignored) list.add(id);
    else list.delete(id);
    this.data.overrides[key] = [...list];
  }

  clearData() {
    this.data.purchases = {};
    this.data.charges = {};
    this.data.overrides = EMPTY().overrides;
    this.data.imports = [];
  }

  /** Debounced write — bursts of imports produce one disk write. */
  save(reason = 'update') {
    this.emit({ type: 'changed', reason, at: new Date().toISOString() });
    if (this.writeTimer) clearTimeout(this.writeTimer);
    this.writeTimer = setTimeout(() => {
      this.writeTimer = null;
      this.flush().catch((err) => console.error('[store] write failed:', err.message));
    }, 150);
    this.writeTimer.unref?.();
  }

  async flush() {
    const write = async () => {
      const tmp = `${this.file}.tmp`;
      await writeFile(tmp, JSON.stringify(this.data, null, 2));
      await rename(tmp, this.file);
    };
    // Serialize concurrent flushes so two writers cannot interleave. The
    // swallowed rejection on the stored chain matters: without it, one failed
    // write would poison every write that follows.
    const chained = (this.writing ?? Promise.resolve()).catch(() => {}).then(write);
    this.writing = chained.catch(() => {});
    return chained;
  }
}

export function defaultStorePath(root) {
  return join(root, 'data', 'store.json');
}
