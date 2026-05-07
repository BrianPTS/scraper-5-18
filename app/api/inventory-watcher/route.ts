import { NextRequest, NextResponse } from 'next/server';
import { runInventoryWatch, getWatcherState, resetWatcherBaseline, persistNow } from '@/lib/inventoryWatcher.js';

const GLOBAL_KEY = '__inventoryWatcherScheduler__';
const DEFAULT_INTERVAL_MIN = Number(process.env.INVENTORY_WATCH_INTERVAL_MIN ?? 1);
const RUNNING_TIMEOUT_MS = 2 * 60 * 1000;
const SKIP_LOG_INTERVAL_MS = 60 * 1000;

interface SchedulerState {
  interval: NodeJS.Timeout | null;
  initialized: boolean;
  runningStartedAt: number;
  lastSkipLog: number;
  intervalMs: number;
}

function getState(): SchedulerState {
  const g = globalThis as Record<string, unknown>;
  if (!g[GLOBAL_KEY]) {
    g[GLOBAL_KEY] = {
      interval: null,
      initialized: false,
      runningStartedAt: 0,
      lastSkipLog: 0,
      intervalMs: 0,
    };
  }
  return g[GLOBAL_KEY] as SchedulerState;
}

function startScheduler(minutes: number) {
  const state = getState();
  if (state.interval) {
    clearInterval(state.interval);
    state.interval = null;
  }

  const intervalMs = Math.max(15_000, Math.round(minutes * 60_000));
  state.intervalMs = intervalMs;

  console.log(`[inventoryWatcher] starting — every ${intervalMs / 1000}s`);

  state.interval = setInterval(async () => {
    const now = Date.now();
    if (state.runningStartedAt > 0) {
      const elapsed = now - state.runningStartedAt;
      if (elapsed < RUNNING_TIMEOUT_MS) {
        if (now - state.lastSkipLog > SKIP_LOG_INTERVAL_MS) {
          console.log(`[inventoryWatcher] previous run still in progress (${Math.round(elapsed / 1000)}s), skipping`);
          state.lastSkipLog = now;
        }
        return;
      }
      console.warn(`[inventoryWatcher] force-resetting stale running flag (stuck ${Math.round(elapsed / 1000)}s)`);
    }

    state.runningStartedAt = now;
    try {
      const stats = await runInventoryWatch();
      if (stats && (stats.newStandard || stats.priceDrops || stats.undercuts)) {
        console.log('[inventoryWatcher] alerts sent:', stats);
      }
    } catch (e) {
      console.error('[inventoryWatcher] run failed:', e);
    } finally {
      state.runningStartedAt = 0;
    }
  }, intervalMs);
}

function stopScheduler() {
  const state = getState();
  if (state.interval) {
    clearInterval(state.interval);
    state.interval = null;
    console.log('[inventoryWatcher] stopped');
  }
}

function initOnLoad() {
  const state = getState();
  if (state.initialized) return;
  state.initialized = true;
  if (!process.env.DISCORD_WEBHOOK_URL) {
    console.log('[inventoryWatcher] DISCORD_WEBHOOK_URL not set — scheduler will run but alerts will no-op');
  }
  startScheduler(DEFAULT_INTERVAL_MIN);
}

initOnLoad();

export async function GET() {
  const state = getState();
  return NextResponse.json({
    success: true,
    schedulerStatus: state.interval ? 'Running' : 'Stopped',
    intervalMs: state.intervalMs,
    ...getWatcherState(),
  });
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { action } = body;

    switch (action) {
      case 'run-now': {
        const stats = await runInventoryWatch();
        return NextResponse.json({ success: true, stats });
      }
      case 'reset-baseline': {
        resetWatcherBaseline();
        return NextResponse.json({ success: true, message: 'Baseline cleared. Next run will rebuild snapshot without alerts.' });
      }
      case 'persist-now': {
        const result = await persistNow();
        return NextResponse.json(result);
      }
      case 'stop': {
        stopScheduler();
        return NextResponse.json({ success: true, message: 'Stopped' });
      }
      case 'start': {
        const minutes = typeof body.intervalMinutes === 'number'
          ? Math.min(Math.max(body.intervalMinutes, 0.25), 60)
          : DEFAULT_INTERVAL_MIN;
        startScheduler(minutes);
        return NextResponse.json({ success: true, message: `Started every ${minutes}m` });
      }
      default:
        return NextResponse.json({ success: false, error: 'Invalid action' }, { status: 400 });
    }
  } catch (e) {
    console.error('[inventoryWatcher] POST error:', e);
    return NextResponse.json({ success: false, error: 'Operation failed' }, { status: 500 });
  }
}
