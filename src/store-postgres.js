/**
 * Postgres-backed store, for the hosted deployment.
 *
 * Same surface as the local file store (`src/store.js`), so everything above it
 * — the matcher, the report builder, the API — is unchanged. The difference is
 * lifecycle: a serverless function starts cold, so every request loads the
 * workspace, does its work, and writes back. There is no long-lived process to
 * hold state in.
 *
 * Concurrency: imports write row by row with `on conflict do update`, so two
 * people importing at once merge rather than clobber. The small documents
 * (settings, overrides) are last-write-wins, which is the right trade for a
 * handful of people clicking Link — a lost tick is recoverable, a lost import
 * is not.
 */

import pg from 'pg';

import { DEFAULT_OPTIONS } from './match.js';

const { Pool } = pg;

/** One pool per process; serverless reuses it across warm invocations. */
let pool = null;

export function getPool(connectionString = process.env.DATABASE_URL) {
  if (!connectionString) throw new Error('DATABASE_URL is not set.');
  if (!pool) {
    pool = new Pool({
      connectionString,
      // Neon and most hosted Postgres require TLS; a local socket must not.
      ssl: /localhost|127\.0\.0\.1|\/tmp/.test(connectionString) ? false : { rejectUnauthorized: false },
      max: 3,
      idleTimeoutMillis: 10_000,
      connectionTimeoutMillis: 10_000,
    });
  }
  return pool;
}

/** For tests: drop the cached pool so a new connection string takes effect. */
export async function resetPool() {
  if (pool) await pool.end().catch(() => {});
  pool = null;
}

const SCHEMA = `
  create table if not exists purchases (
    workspace text not null default 'default',
    id text not null,
    day text,
    data jsonb not null,
    updated_at timestamptz not null default now(),
    primary key (workspace, id)
  );
  create table if not exists charges (
    workspace text not null default 'default',
    id text not null,
    day text,
    data jsonb not null,
    updated_at timestamptz not null default now(),
    primary key (workspace, id)
  );
  create table if not exists documents (
    workspace text not null default 'default',
    key text not null,
    data jsonb not null,
    updated_at timestamptz not null default now(),
    primary key (workspace, key)
  );
  create index if not exists purchases_day on purchases (workspace, day);
  create index if not exists charges_day on charges (workspace, day);
`;

export class PostgresStore {
  /**
   * @param {{connectionString?: string, workspace?: string}} [options]
   */
  constructor(options = {}) {
    this.connectionString = options.connectionString ?? process.env.DATABASE_URL;
    this.workspace = options.workspace ?? process.env.WORKSPACE ?? 'default';
    this.file = 'postgres';
    this.data = {
      purchases: {},
      charges: {},
      overrides: { links: [], ignoredPurchases: [], ignoredCharges: [] },
      settings: { ...DEFAULT_OPTIONS },
      imports: [],
    };
    this.listeners = new Set();
    this.dirty = { purchases: new Set(), charges: new Set(), documents: new Set() };
    this.deleted = { purchases: new Set(), charges: new Set() };
  }

  query(text, params) {
    return getPool(this.connectionString).query(text, params);
  }

  /** Create the tables if they are not there yet. Safe to call on every boot. */
  async migrate() {
    await this.query(SCHEMA);
  }

  /** Read the whole workspace into memory. */
  async load() {
    await this.migrate();

    const [purchases, charges, documents] = await Promise.all([
      this.query('select id, data from purchases where workspace = $1', [this.workspace]),
      this.query('select id, data from charges where workspace = $1', [this.workspace]),
      this.query('select key, data from documents where workspace = $1', [this.workspace]),
    ]);

    this.data.purchases = Object.fromEntries(purchases.rows.map((r) => [r.id, r.data]));
    this.data.charges = Object.fromEntries(charges.rows.map((r) => [r.id, r.data]));

    const docs = Object.fromEntries(documents.rows.map((r) => [r.key, r.data]));
    this.data.overrides = {
      links: [],
      ignoredPurchases: [],
      ignoredCharges: [],
      ...(docs.overrides ?? {}),
    };
    this.data.settings = { ...DEFAULT_OPTIONS, ...(docs.settings ?? {}) };
    this.data.imports = Array.isArray(docs.imports) ? docs.imports : [];

    this.dirty = { purchases: new Set(), charges: new Set(), documents: new Set() };
    this.deleted = { purchases: new Set(), charges: new Set() };
    return this.data;
  }

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
   * Insert or update records. Mirrors the file store, including the rule that
   * a PO arriving from one purchase export evicts the same PO from the other.
   */
  upsert(kind, records) {
    const bucket = this.data[kind];
    let added = 0;
    let updated = 0;
    let replaced = 0;

    const incomingPoIds = new Map();
    for (const record of records) {
      if (record.poId) incomingPoIds.set(record.poId, record.source);
    }
    if (incomingPoIds.size) {
      for (const [key, existing] of Object.entries(bucket)) {
        const incomingSource = incomingPoIds.get(existing.poId);
        if (incomingSource && existing.source && existing.source !== incomingSource) {
          delete bucket[key];
          this.deleted[kind].add(key);
          this.dirty[kind].delete(key);
          replaced += 1;
        }
      }
    }

    for (const record of records) {
      if (bucket[record.id]) updated += 1;
      else added += 1;
      bucket[record.id] = record;
      this.dirty[kind].add(record.id);
      this.deleted[kind].delete(record.id);
    }

    return { added, updated, replaced, total: Object.keys(bucket).length };
  }

  recordImport(entry) {
    this.data.imports.unshift(entry);
    this.data.imports = this.data.imports.slice(0, 50);
    this.dirty.documents.add('imports');
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
    this.dirty.documents.add('settings');
    return next;
  }

  link(purchaseId, chargeId, note = '') {
    this.unlinkPurchase(purchaseId);
    this.unlinkCharge(chargeId);
    this.data.overrides.links.push({ purchaseId, chargeId, note, linkedAt: new Date().toISOString() });
    this.dirty.documents.add('overrides');
  }

  unlinkPurchase(purchaseId) {
    this.data.overrides.links = this.data.overrides.links.filter((l) => l.purchaseId !== purchaseId);
    this.dirty.documents.add('overrides');
  }

  unlinkCharge(chargeId) {
    this.data.overrides.links = this.data.overrides.links.filter((l) => l.chargeId !== chargeId);
    this.dirty.documents.add('overrides');
  }

  setIgnored(kind, id, ignored) {
    const key = kind === 'purchase' ? 'ignoredPurchases' : 'ignoredCharges';
    const list = new Set(this.data.overrides[key]);
    if (ignored) list.add(id);
    else list.delete(id);
    this.data.overrides[key] = [...list];
    this.dirty.documents.add('overrides');
  }

  clearData() {
    for (const id of Object.keys(this.data.purchases)) this.deleted.purchases.add(id);
    for (const id of Object.keys(this.data.charges)) this.deleted.charges.add(id);
    this.data.purchases = {};
    this.data.charges = {};
    this.data.overrides = { links: [], ignoredPurchases: [], ignoredCharges: [] };
    this.data.imports = [];
    this.dirty.purchases.clear();
    this.dirty.charges.clear();
    this.dirty.documents.add('overrides').add('imports');
  }

  /**
   * Persist everything touched since the last write. Unlike the file store this
   * is not debounced — a serverless invocation ends the moment it responds, so
   * anything not written now is lost.
   */
  async save(reason = 'update') {
    this.emit({ type: 'changed', reason, at: new Date().toISOString() });
    await this.flush();
  }

  async flush() {
    const client = await getPool(this.connectionString).connect();
    try {
      await client.query('begin');

      for (const kind of ['purchases', 'charges']) {
        const ids = [...this.deleted[kind]];
        if (ids.length) {
          await client.query(`delete from ${kind} where workspace = $1 and id = any($2::text[])`, [
            this.workspace,
            ids,
          ]);
        }

        const dirty = [...this.dirty[kind]];
        // Write in batches so one import is a handful of round trips, not
        // hundreds — round trips are what cost time on a hosted database.
        const BATCH = 200;
        for (let i = 0; i < dirty.length; i += BATCH) {
          const slice = dirty.slice(i, i + BATCH);
          const values = [];
          const params = [this.workspace];
          slice.forEach((id, n) => {
            const record = this.data[kind][id];
            if (!record) return;
            const base = params.length;
            values.push(`($1, $${base + 1}, $${base + 2}, $${base + 3}::jsonb, now())`);
            params.push(id, record.day ?? null, JSON.stringify(record));
          });
          if (!values.length) continue;
          await client.query(
            `insert into ${kind} (workspace, id, day, data, updated_at)
             values ${values.join(', ')}
             on conflict (workspace, id) do update
               set data = excluded.data, day = excluded.day, updated_at = now()`,
            params,
          );
        }
      }

      for (const key of this.dirty.documents) {
        const value =
          key === 'overrides' ? this.data.overrides : key === 'settings' ? this.data.settings : this.data.imports;
        await client.query(
          `insert into documents (workspace, key, data, updated_at)
           values ($1, $2, $3::jsonb, now())
           on conflict (workspace, key) do update set data = excluded.data, updated_at = now()`,
          [this.workspace, key, JSON.stringify(value)],
        );
      }

      await client.query('commit');
      this.dirty = { purchases: new Set(), charges: new Set(), documents: new Set() };
      this.deleted = { purchases: new Set(), charges: new Set() };
    } catch (err) {
      await client.query('rollback').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }
}
