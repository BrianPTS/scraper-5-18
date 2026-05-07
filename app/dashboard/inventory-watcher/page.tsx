'use client';

import { useEffect, useState, useCallback } from 'react';
import { Bell, Play, Square, RotateCcw, Send, Loader2, CheckCircle2, AlertTriangle } from 'lucide-react';

type AlertType = 'newStandard' | 'priceDrop' | 'undercut';

interface RecentAlert {
  at: string;
  type: AlertType;
  event: string;
  line: string;
}

interface WatcherStatus {
  success: boolean;
  schedulerStatus: 'Running' | 'Stopped';
  intervalMs: number;
  baselineDone: boolean;
  snapshotSize: number;
  sectionsTracked: number;
  lastRunAt: string | null;
  lastQueryAt: string | null;
  lastFullScanAt: string | null;
  runCount: number;
  fullScanEveryMs: number;
  lastRunStats: {
    mode: 'full' | 'incremental';
    rowsInSnapshot: number;
    fetched: number;
    deleted: number;
    dirtySections: number;
    newStandard: number;
    priceDrops: number;
    undercuts: number;
    pending: number;
    isBaseline: boolean;
    fetchMs: number;
    totalMs: number;
  } | null;
  webhookConfigured: boolean;
  undercutPct: number;
  recentAlerts: RecentAlert[];
  totalAlerts: { newStandard: number; priceDrops: number; undercuts: number };
  inFlight: boolean;
  runningStartedAt: number;
  pendingCounts: { drops: number; undercuts: number; newStd: number };
  droppedAlerts: number;
  minDropPct: number;
  minDropAbs: number;
}

const TYPE_META: Record<AlertType, { label: string; emoji: string; color: string }> = {
  newStandard: { label: 'New Standard', emoji: '🟢', color: 'bg-green-100 text-green-800 border-green-200' },
  priceDrop:   { label: 'Price Drop',   emoji: '🔴', color: 'bg-red-100 text-red-800 border-red-200' },
  undercut:    { label: 'Undercut',     emoji: '🟡', color: 'bg-yellow-100 text-yellow-800 border-yellow-200' },
};

function timeAgo(iso: string): string {
  const diff = (Date.now() - new Date(iso).getTime()) / 1000;
  if (diff < 60) return `${Math.floor(diff)}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return new Date(iso).toLocaleDateString();
}

export default function InventoryWatcherPage() {
  const [status, setStatus] = useState<WatcherStatus | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState<number>(Date.now());

  // Tick once a second so countdowns + "running for Xs" stay live without re-fetching.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch('/api/inventory-watcher', { cache: 'no-store' });
      const data = await res.json();
      setStatus({
        ...data,
        recentAlerts: Array.isArray(data.recentAlerts) ? data.recentAlerts : [],
        totalAlerts: data.totalAlerts ?? { newStandard: 0, priceDrops: 0, undercuts: 0 },
        inFlight: Boolean(data.inFlight),
        runningStartedAt: Number(data.runningStartedAt) || 0,
        pendingCounts: data.pendingCounts ?? { drops: 0, undercuts: 0, newStd: 0 },
        droppedAlerts: Number(data.droppedAlerts) || 0,
        minDropPct: Number(data.minDropPct) || 0,
        minDropAbs: Number(data.minDropAbs) || 0,
      });
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'fetch failed');
    }
  }, []);

  useEffect(() => {
    fetchStatus();
    const iv = setInterval(fetchStatus, 5000);
    return () => clearInterval(iv);
  }, [fetchStatus]);

  async function action(name: string, body?: Record<string, unknown>) {
    setBusy(name);
    try {
      const res = await fetch('/api/inventory-watcher', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: name, ...body }),
      });
      const data = await res.json();
      if (!data.success) setError(data.error || 'action failed');
      await fetchStatus();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'action failed');
    } finally {
      setBusy(null);
    }
  }

  async function sendTest() {
    setBusy('test');
    try {
      await fetch('/api/inventory-watcher/test', { method: 'POST' });
      await fetchStatus();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'test failed');
    } finally {
      setBusy(null);
    }
  }

  if (!status) {
    return (
      <div className="flex items-center justify-center h-64 text-slate-500">
        <Loader2 className="w-5 h-5 animate-spin mr-2" /> Loading…
      </div>
    );
  }

  const running = status.schedulerStatus === 'Running';
  const intervalSec = Math.round(status.intervalMs / 1000);

  return (
    <div className="p-6 max-w-6xl mx-auto space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-800 flex items-center gap-2">
            <Bell className="w-6 h-6 text-purple-600" />
            Inventory Watcher
          </h1>
          <p className="text-sm text-slate-500 mt-1">
            Real-time Discord alerts on new standard seats, price drops, and resale undercuts.
          </p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={sendTest}
            disabled={busy !== null}
            className="px-3 py-2 text-sm rounded-lg bg-slate-100 text-slate-700 hover:bg-slate-200 disabled:opacity-50 flex items-center gap-2"
          >
            <Send className="w-4 h-4" /> Send test
          </button>
          <button
            onClick={() => action('run-now')}
            disabled={busy !== null}
            className="px-3 py-2 text-sm rounded-lg bg-purple-600 text-white hover:bg-purple-700 disabled:opacity-50 flex items-center gap-2"
          >
            {busy === 'run-now' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4" />}
            Run now
          </button>
          <button
            onClick={() => action('reset-baseline')}
            disabled={busy !== null}
            className="px-3 py-2 text-sm rounded-lg bg-amber-100 text-amber-800 hover:bg-amber-200 disabled:opacity-50 flex items-center gap-2"
          >
            <RotateCcw className="w-4 h-4" /> Reset baseline
          </button>
          <button
            onClick={() => action(running ? 'stop' : 'start')}
            disabled={busy !== null}
            className={`px-3 py-2 text-sm rounded-lg flex items-center gap-2 ${
              running ? 'bg-red-100 text-red-800 hover:bg-red-200' : 'bg-green-100 text-green-800 hover:bg-green-200'
            } disabled:opacity-50`}
          >
            {running ? <><Square className="w-4 h-4" /> Stop</> : <><Play className="w-4 h-4" /> Start</>}
          </button>
        </div>
      </div>

      {error && (
        <div className="p-3 rounded-lg bg-red-50 border border-red-200 text-red-800 text-sm flex items-center gap-2">
          <AlertTriangle className="w-4 h-4" /> {error}
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <SchedulerCard status={status} now={now} />
        <StatusCard label="Webhook" value={status.webhookConfigured ? 'Connected' : 'Not set'} ok={status.webhookConfigured} />
        <StatusCard label="Baseline" value={status.baselineDone ? 'Established' : 'Pending'} ok={status.baselineDone} />
        <StatusCard label="Snapshot rows" value={status.snapshotSize.toLocaleString()} ok={status.snapshotSize > 0} />
      </div>

      <LiveActivityRow status={status} now={now} />

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="bg-white rounded-xl border border-slate-200 p-5">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-sm font-semibold text-slate-700">Last run</h2>
            {status.lastRunStats && (
              <span className={`text-[10px] uppercase tracking-wide px-2 py-0.5 rounded-full font-bold ${
                status.lastRunStats.mode === 'full'
                  ? 'bg-blue-100 text-blue-700'
                  : 'bg-emerald-100 text-emerald-700'
              }`}>
                {status.lastRunStats.mode}
              </span>
            )}
          </div>
          {status.lastRunAt && status.lastRunStats ? (
            <div className="space-y-1.5 text-sm">
              <div className="text-slate-500">{timeAgo(status.lastRunAt)} · {new Date(status.lastRunAt).toLocaleTimeString()}</div>
              <div className="text-slate-700">
                Fetched <span className="font-semibold tabular-nums">{status.lastRunStats.fetched}</span> rows
                {status.lastRunStats.mode === 'incremental' && (
                  <span className="text-emerald-700 text-xs ml-2">
                    (vs {status.lastRunStats.rowsInSnapshot} tracked — {status.lastRunStats.rowsInSnapshot > 0
                      ? Math.round((1 - status.lastRunStats.fetched / status.lastRunStats.rowsInSnapshot) * 100)
                      : 0}% saved)
                  </span>
                )}
              </div>
              <div className="text-xs text-slate-500">
                Query {status.lastRunStats.fetchMs}ms · total {status.lastRunStats.totalMs}ms
                {status.lastRunStats.deleted > 0 && <> · {status.lastRunStats.deleted} purged</>}
              </div>
              {status.lastRunStats.isBaseline && (
                <div className="text-amber-700 text-xs">Baseline pass — no alerts sent</div>
              )}
              <div className="flex flex-wrap gap-2 pt-2 text-xs">
                <Pill emoji="🟢" n={status.lastRunStats.newStandard} label="new std" />
                <Pill emoji="🔴" n={status.lastRunStats.priceDrops} label="drops" />
                <Pill emoji="🟡" n={status.lastRunStats.undercuts}  label="undercuts" />
                {status.lastRunStats.pending > 0 && (
                  <Pill emoji="⏳" n={status.lastRunStats.pending} label="queued" />
                )}
              </div>
            </div>
          ) : (
            <div className="text-sm text-slate-400">Not run yet. Polling every {intervalSec}s.</div>
          )}
        </div>

        <div className="bg-white rounded-xl border border-slate-200 p-5">
          <h2 className="text-sm font-semibold text-slate-700 mb-3">Total alerts since start</h2>
          <div className="grid grid-cols-3 gap-3">
            <Total emoji="🟢" label="New Standard" n={status.totalAlerts.newStandard} />
            <Total emoji="🔴" label="Price Drops"  n={status.totalAlerts.priceDrops} />
            <Total emoji="🟡" label="Undercuts"    n={status.totalAlerts.undercuts} />
          </div>
          <div className="text-xs text-slate-400 mt-3">
            Polling every {intervalSec}s · Undercut threshold {Math.round(status.undercutPct * 100)}%
          </div>
        </div>
      </div>

      <div className="bg-white rounded-xl border border-slate-200">
        <div className="px-5 py-4 border-b border-slate-100 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-slate-700">Recent alerts (last {status.recentAlerts.length})</h2>
          <span className="text-xs text-slate-400">Auto-refresh every 5s</span>
        </div>
        {status.recentAlerts.length === 0 ? (
          <div className="px-5 py-10 text-center text-sm text-slate-400">
            No alerts yet. {status.baselineDone
              ? 'The next real change in inventory will appear here and ping Discord.'
              : 'First scan establishes the baseline; alerts begin on the second scan.'}
          </div>
        ) : (
          <ul className="divide-y divide-slate-100">
            {status.recentAlerts.map((a, i) => {
              const meta = TYPE_META[a.type];
              return (
                <li key={`${a.at}-${i}`} className="px-5 py-3 flex items-start gap-3 text-sm">
                  <span className={`shrink-0 px-2 py-0.5 rounded-full border text-xs ${meta.color}`}>
                    {meta.emoji} {meta.label}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="text-slate-800 font-mono text-xs break-words">{a.line}</div>
                    <div className="text-slate-400 text-xs mt-0.5">{a.event}</div>
                  </div>
                  <div className="shrink-0 text-xs text-slate-400 tabular-nums">{timeAgo(a.at)}</div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}

function StatusCard({ label, value, ok }: { label: string; value: string; ok: boolean }) {
  return (
    <div className="bg-white rounded-xl border border-slate-200 p-4">
      <div className="text-xs text-slate-500 uppercase tracking-wide">{label}</div>
      <div className="mt-2 flex items-center gap-2">
        {ok ? <CheckCircle2 className="w-4 h-4 text-green-600" /> : <AlertTriangle className="w-4 h-4 text-amber-500" />}
        <span className="text-slate-800 font-semibold">{value}</span>
      </div>
    </div>
  );
}

// Scheduler card: pulsing dot when a cycle is running, countdown to next when idle.
function SchedulerCard({ status, now }: { status: WatcherStatus; now: number }) {
  const running = status.schedulerStatus === 'Running';
  const inFlight = Boolean(status.inFlight && status.runningStartedAt > 0);
  const runningForS = inFlight ? Math.max(0, Math.floor((now - status.runningStartedAt) / 1000)) : 0;

  let secondary = '';
  if (inFlight) {
    secondary = `Running for ${runningForS}s`;
  } else if (running && status.lastRunAt && status.intervalMs) {
    const nextAt = new Date(status.lastRunAt).getTime() + status.intervalMs;
    const remaining = Math.max(0, Math.floor((nextAt - now) / 1000));
    secondary = `Next in ${remaining}s`;
  } else if (!running) {
    secondary = 'Stopped';
  }

  return (
    <div className="bg-white rounded-xl border border-slate-200 p-4">
      <div className="text-xs text-slate-500 uppercase tracking-wide">Scheduler</div>
      <div className="mt-2 flex items-center gap-2">
        {inFlight ? (
          <span className="relative flex h-3 w-3">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-purple-400 opacity-75" />
            <span className="relative inline-flex rounded-full h-3 w-3 bg-purple-600" />
          </span>
        ) : running ? (
          <CheckCircle2 className="w-4 h-4 text-green-600" />
        ) : (
          <AlertTriangle className="w-4 h-4 text-amber-500" />
        )}
        <span className="text-slate-800 font-semibold">{inFlight ? 'Working…' : status.schedulerStatus}</span>
      </div>
      {secondary && <div className="text-xs text-slate-400 mt-1 tabular-nums">{secondary}</div>}
    </div>
  );
}

// Live snapshot of pending queue + dropped counter — useful when alerts are in flight.
function LiveActivityRow({ status, now: _now }: { status: WatcherStatus; now: number }) {
  const queued = status.pendingCounts.drops + status.pendingCounts.undercuts + status.pendingCounts.newStd;
  return (
    <div className="bg-white rounded-xl border border-slate-200 p-5">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-sm font-semibold text-slate-700">Live activity</h2>
        <span className="text-xs text-slate-400">
          Min drop ≥ {Math.round(status.minDropPct * 100)}% &amp; ≥ ${status.minDropAbs} · Undercut ≥ {Math.round(status.undercutPct * 100)}%
        </span>
      </div>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <QueueCard label="Pending in queue" value={queued} accent="text-purple-700" sub={
          queued
            ? `🔴 ${status.pendingCounts.drops} · 🟡 ${status.pendingCounts.undercuts} · 🟢 ${status.pendingCounts.newStd}`
            : 'queue empty'
        }/>
        <QueueCard label="🔴 Drops queued" value={status.pendingCounts.drops} accent="text-red-700" />
        <QueueCard label="🟡 Undercuts queued" value={status.pendingCounts.undercuts} accent="text-yellow-700" />
        <QueueCard
          label="Dropped (cap)"
          value={status.droppedAlerts}
          accent={status.droppedAlerts > 0 ? 'text-red-600' : 'text-slate-400'}
          sub={status.droppedAlerts > 0 ? 'pending cap reached at some point' : 'no losses'}
        />
      </div>
    </div>
  );
}

function QueueCard({ label, value, accent, sub }: { label: string; value: number; accent: string; sub?: string }) {
  return (
    <div className="rounded-lg bg-slate-50 px-4 py-3">
      <div className="text-[11px] text-slate-500 uppercase tracking-wide">{label}</div>
      <div className={`text-2xl font-bold tabular-nums mt-0.5 ${accent}`}>{value.toLocaleString()}</div>
      {sub && <div className="text-[11px] text-slate-400 mt-0.5">{sub}</div>}
    </div>
  );
}

function Pill({ emoji, n, label }: { emoji: string; n: number; label: string }) {
  return (
    <span className="px-2 py-0.5 rounded-full bg-slate-100 text-slate-700 text-xs">
      {emoji} {n} {label}
    </span>
  );
}

function Total({ emoji, label, n }: { emoji: string; label: string; n: number }) {
  return (
    <div className="rounded-lg bg-slate-50 p-3 text-center">
      <div className="text-2xl">{emoji}</div>
      <div className="text-2xl font-bold text-slate-800 mt-1 tabular-nums">{n}</div>
      <div className="text-xs text-slate-500 mt-0.5">{label}</div>
    </div>
  );
}
