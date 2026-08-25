'use client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';

interface EventListItem {
  mappingId: string;
  name: string;
  venue: string;
  datetime: string | Date | null;
  taxonomy: string;
  totalListings: number;
  alertsToday: number;
}

interface RoomData {
  success: boolean;
  event: {
    mappingId: string;
    name: string;
    venue: string;
    datetime: string | Date | null;
    url: string;
    taxonomy: string;
  };
  stats: {
    totalListings: number;
    totalListingsDelta: number | null;
    getInPrice: number;
    getInSection: string;
    getInRow: string;
    getInDelta: number | null;
    medianPrice: number;
    medianDelta: number | null;
    alertsToday: Record<string, number>;
    alertsTotal: number;
    lastScrapeAt: string | Date | null;
  };
  series: Array<{
    snapshotAt: string | Date;
    totalListings: number;
    medianPrice?: number | null;
    getInPrice?: number | null;
  }>;
  recentAlerts: Array<Record<string, unknown>>;
  cheapest: Array<{
    section: string; row: string; quantity: number; price: number;
    tag: string; stockType: string; firstSeenAt: string | Date | null;
  }>;
  arbitrage: Array<Record<string, unknown>>;
  projection: Record<string, unknown>;
  heatmap: { grid: Array<{ day: number; hour: number; count: number }>; max: number; peaks: Array<{ day: number; hourStart: number; hourEnd: number; count: number }> };
  fetchedAt: string | Date;
}

const POLL_MS = 10_000;
const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function fmtDate(d: string | Date | null) {
  if (!d) return '';
  const dt = typeof d === 'string' ? new Date(d) : d;
  return dt.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
}
function fmtRelative(d: string | Date | null) {
  if (!d) return '';
  const secs = Math.max(0, Math.floor((Date.now() - new Date(d).getTime()) / 1000));
  if (secs < 60) return `${secs}s ago`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
  return `${Math.floor(secs / 86400)}d ago`;
}
function fmtMoney(n: number | null | undefined) {
  if (n == null || isNaN(n)) return '—';
  return `$${Math.round(n).toLocaleString()}`;
}
function fmtDelta(n: number | null | undefined, unit = '') {
  if (n == null) return null;
  const sign = n > 0 ? '▲' : n < 0 ? '▼' : '·';
  return `${sign} ${unit}${Math.abs(Math.round(n)).toLocaleString()}`;
}

export default function EventRoomClient({
  initial, initialEvents, eventId,
}: { initial: RoomData; initialEvents: EventListItem[]; eventId: string }) {
  const router = useRouter();
  const [data, setData] = useState<RoomData>(initial);
  const [events, setEvents] = useState<EventListItem[]>(initialEvents);
  const [eventFilter, setEventFilter] = useState('');
  const [taxonomyFilter, setTaxonomyFilter] = useState<string>('');
  const [alertFilter, setAlertFilter] = useState<string>('all');
  const [cmdOpen, setCmdOpen] = useState(false);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Poll dashboard data every 10s
  useEffect(() => {
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = setInterval(async () => {
      try {
        const res = await fetch(`/api/event-room/${eventId}`, { cache: 'no-store' });
        const json = await res.json();
        if (json?.success) setData(json);
      } catch { /* transient */ }
    }, POLL_MS);
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, [eventId]);

  // ⌘K to open palette
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setCmdOpen((v) => !v);
      } else if (e.key === 'Escape') {
        setCmdOpen(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const filteredEvents = useMemo(() => {
    const q = eventFilter.trim().toLowerCase();
    return events.filter((e) => {
      if (taxonomyFilter && e.taxonomy !== taxonomyFilter) return false;
      if (q && !(`${e.name} ${e.venue}`.toLowerCase().includes(q))) return false;
      return true;
    });
  }, [events, eventFilter, taxonomyFilter]);

  const filteredAlerts = useMemo(() => {
    if (alertFilter === 'all') return data.recentAlerts;
    return data.recentAlerts.filter((a) => a.type === alertFilter);
  }, [data.recentAlerts, alertFilter]);

  const alertsToday = data.stats.alertsToday;
  const alertsSummary = useMemo(() => {
    const parts: string[] = [];
    if (alertsToday.priceDrop) parts.push(`${alertsToday.priceDrop} drop`);
    if (alertsToday.undercut) parts.push(`${alertsToday.undercut} under`);
    if (alertsToday.arbitrage) parts.push(`${alertsToday.arbitrage} arb`);
    if (alertsToday.newLow) parts.push(`${alertsToday.newLow} low`);
    if (alertsToday.newStandard) parts.push(`${alertsToday.newStandard} new`);
    return parts.join(' · ') || 'none yet';
  }, [alertsToday]);

  // Chart calc
  const chart = useMemo(() => {
    if (!data.series.length) return null;
    const prices = data.series
      .map((s) => s.getInPrice ?? 0)
      .filter((p) => p > 0);
    if (!prices.length) return null;
    const minP = Math.min(...prices);
    const maxP = Math.max(...prices);
    const range = Math.max(1, maxP - minP);
    const startT = new Date(data.series[0].snapshotAt).getTime();
    const endT = new Date(data.series[data.series.length - 1].snapshotAt).getTime();
    const tRange = Math.max(1, endT - startT);
    const points = data.series.map((s) => {
      const t = new Date(s.snapshotAt).getTime();
      const x = 40 + ((t - startT) / tRange) * 740;
      const y = 30 + (1 - (((s.getInPrice ?? minP) - minP) / range)) * 180;
      return { x, y };
    });
    return { points, minP, maxP };
  }, [data.series]);

  const chartPath = useMemo(() => {
    if (!chart) return '';
    return chart.points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x},${p.y}`).join(' ');
  }, [chart]);

  const projection = data.projection as {
    success?: boolean; insufficient?: boolean;
    current?: { listings: number; getIn: number };
    projection?: { listings: number; getIn: number; percentSoldByKickoff: number };
    model?: { listings?: { r2: number } };
  };

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 dark:bg-[#0B1220] dark:text-slate-100">

      {/* Topbar */}
      <div className="sticky top-0 z-10 flex items-center gap-3 border-b border-slate-200 dark:border-slate-800 bg-white dark:bg-[#131C2E] px-6 py-3">
        <div className="flex items-center gap-2 pr-4 border-r border-slate-200 dark:border-slate-800">
          <div className="w-7 h-7 rounded-md grid place-items-center text-[13px] font-bold text-[#0B1220]" style={{ background: 'linear-gradient(135deg, #C89828, #E6B547)' }}>PT</div>
          <div className="text-sm font-semibold">PrimeTime</div>
          <div className="text-xs text-slate-500 dark:text-slate-400">Event Room</div>
        </div>
        <nav className="flex gap-1">
          <Link href="/dashboard/events" className="text-sm text-slate-500 dark:text-slate-400 px-3 py-1.5 rounded-md hover:bg-slate-100 dark:hover:bg-slate-800">Events</Link>
          <span className="text-sm text-slate-900 dark:text-slate-100 px-3 py-1.5 rounded-md bg-slate-100 dark:bg-slate-800 font-medium">Event Room</span>
          <Link href="/dashboard/exclusions" className="text-sm text-slate-500 dark:text-slate-400 px-3 py-1.5 rounded-md hover:bg-slate-100 dark:hover:bg-slate-800">Exclusions</Link>
        </nav>
        <div className="ml-auto flex items-center gap-2">
          <button onClick={() => setCmdOpen(true)} className="flex items-center gap-2 rounded-md border border-slate-200 dark:border-slate-700 bg-slate-100 dark:bg-slate-800 text-slate-500 dark:text-slate-400 px-3 py-1.5 text-xs font-medium">⌕ Search or run… <kbd className="text-[10px] font-mono border border-slate-300 dark:border-slate-600 rounded px-1">⌘K</kbd></button>
          <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-100 dark:bg-emerald-900/40 text-emerald-700 dark:text-emerald-400 px-3 py-1 text-[11px] font-semibold uppercase tracking-wider">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />Live · 10s
          </span>
        </div>
      </div>

      {/* App layout */}
      <div className="grid grid-cols-[280px_1fr] max-lg:grid-cols-1 min-h-[calc(100vh-53px)]">

        {/* Sidebar */}
        <aside className="sticky top-[53px] self-start h-[calc(100vh-53px)] flex flex-col bg-white dark:bg-[#131C2E] border-r border-slate-200 dark:border-slate-800 max-lg:hidden">
          <div className="p-3.5 pb-2.5 border-b border-slate-100 dark:border-slate-800">
            <h2 className="text-[11px] font-semibold uppercase tracking-wider text-slate-500 mb-2">Events being scraped</h2>
            <div className="relative">
              <span className="absolute left-2 top-1/2 -translate-y-1/2 text-slate-400 text-xs pointer-events-none">⌕</span>
              <input value={eventFilter} onChange={(e) => setEventFilter(e.target.value)} placeholder="Search team, venue, date…" className="w-full rounded-lg bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-xs px-3 py-1.5 pl-7 outline-none focus:ring-2 focus:ring-amber-500" />
            </div>
            <div className="flex gap-1 mt-2 text-[11px]">
              {['', 'NFL', 'NBA', 'NHL', 'MLB'].map((t) => (
                <button key={t || 'all'} onClick={() => setTaxonomyFilter(t)} className={`px-2 py-0.5 rounded-md font-medium ${taxonomyFilter === t ? 'bg-slate-200 dark:bg-slate-700 text-slate-900 dark:text-slate-100' : 'text-slate-500'}`}>
                  {t || 'All'} <span className="text-slate-400 tabular-nums ml-1">{t ? events.filter(e => e.taxonomy === t).length : events.length}</span>
                </button>
              ))}
            </div>
          </div>
          <div className="overflow-y-auto flex-1 py-2">
            {filteredEvents.map((e) => (
              <button key={e.mappingId} onClick={() => router.push(`/dashboard/event-room/${e.mappingId}`)} className={`w-full grid grid-cols-[4px_1fr_auto] gap-2.5 px-4 py-2.5 border-b border-slate-100 dark:border-slate-800 text-left hover:bg-slate-50 dark:hover:bg-slate-800 ${e.mappingId === eventId ? 'bg-slate-100 dark:bg-slate-800' : ''}`}>
                <div className={`rounded-sm ${
                  e.taxonomy === 'NFL' ? 'bg-amber-500' : e.taxonomy === 'MLB' ? 'bg-blue-500' :
                  e.taxonomy === 'NHL' ? 'bg-emerald-500' : e.taxonomy === 'NBA' ? 'bg-orange-500' : 'bg-slate-400'
                }`} />
                <div className="min-w-0">
                  <div className="text-[12.5px] font-medium truncate">{e.name}</div>
                  <div className="text-[10.5px] text-slate-500 tabular-nums mt-0.5">
                    {fmtDate(e.datetime)} · {e.venue || '—'} · {e.totalListings.toLocaleString()}
                  </div>
                </div>
                {e.alertsToday > 0 && (
                  <span className={`text-[10px] font-semibold tabular-nums px-1.5 py-0.5 rounded-full ${e.alertsToday >= 15 ? 'bg-red-100 text-red-600 dark:bg-red-900/40 dark:text-red-400' : 'text-slate-500'}`}>{e.alertsToday}</span>
                )}
              </button>
            ))}
            {filteredEvents.length === 0 && (
              <div className="text-center text-xs text-slate-400 py-8">No events match.</div>
            )}
          </div>
        </aside>

        {/* Main frame */}
        <div className="grid grid-cols-[1fr_360px] max-xl:grid-cols-1 gap-4 p-5 min-w-0">

          {/* Event header */}
          <div className="col-span-2 max-xl:col-span-1 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#131C2E] p-5 flex items-center gap-4 shadow-sm">
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2.5 flex-wrap">
                <h1 className="text-xl font-semibold leading-tight m-0">{data.event.name}</h1>
                <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-400 text-[11px] font-semibold uppercase tracking-wider">★ Watching</span>
              </div>
              <div className="flex gap-3.5 text-[12.5px] text-slate-500 mt-1">
                <span><strong className="text-slate-600 dark:text-slate-300 font-medium">{fmtDate(data.event.datetime)}</strong></span>
                <span>· {data.event.venue || '—'}</span>
                <span>· Last scrape {fmtRelative(data.stats.lastScrapeAt)}</span>
              </div>
            </div>
            <div className="flex gap-2 items-center">
              <Link href={`/dashboard/events/${data.event.mappingId}/exclusions`} className="rounded-lg bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300 border border-slate-200 dark:border-slate-700 px-3.5 py-2 text-[12.5px] font-medium">Exclusions</Link>
              <button className="rounded-lg bg-amber-500 text-[#0B1220] border border-amber-500 px-3.5 py-2 text-[12.5px] font-semibold">★ Add rule</button>
            </div>
          </div>

          {/* Stats */}
          <div className="col-span-2 max-xl:col-span-1 grid grid-cols-[1.4fr_1fr_1fr_1fr_1fr] max-xl:grid-cols-3 gap-3">
            <FeatureStat label="Get-in price · cheapest right now" value={fmtMoney(data.stats.getInPrice)} delta={data.stats.getInDelta != null ? `${fmtDelta(data.stats.getInDelta, '$')} · ${data.stats.getInSection || '—'} row ${data.stats.getInRow || '—'}` : 'no comparison yet'} deltaClass={data.stats.getInDelta != null && data.stats.getInDelta < 0 ? 'text-red-600 dark:text-red-400' : 'text-slate-500'} />
            <Stat stripe="bg-amber-500" label="Live listings" value={data.stats.totalListings.toLocaleString()} delta={data.stats.totalListingsDelta != null ? `${fmtDelta(data.stats.totalListingsDelta)} · 24h` : ''} deltaClass={data.stats.totalListingsDelta != null && data.stats.totalListingsDelta < 0 ? 'text-red-600 dark:text-red-400' : 'text-emerald-600 dark:text-emerald-400'} />
            <Stat stripe="bg-emerald-500" label="Sold (24h)" value={data.stats.totalListingsDelta != null ? Math.abs(Math.min(0, data.stats.totalListingsDelta)).toLocaleString() : '—'} delta={data.stats.totalListingsDelta != null && data.stats.totalListingsDelta < 0 ? 'selling' : 'gaining'} deltaClass="text-emerald-600 dark:text-emerald-400" />
            <Stat stripe="bg-blue-500" label="Median $/seat" value={fmtMoney(data.stats.medianPrice)} delta={data.stats.medianDelta != null ? `${fmtDelta(data.stats.medianDelta, '$')} · 24h` : ''} deltaClass={data.stats.medianDelta != null && data.stats.medianDelta < 0 ? 'text-red-600 dark:text-red-400' : 'text-slate-500'} />
            <Stat stripe="bg-orange-500" label="Alerts today" value={String(data.stats.alertsTotal)} delta={alertsSummary} deltaClass="text-slate-500" />
          </div>

          {/* Main column: chart + arbitrage + heatmap */}
          <div className="flex flex-col gap-4 min-w-0">

            {/* Chart */}
            <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#131C2E] p-4 shadow-sm">
              <div className="flex items-center justify-between mb-2">
                <div>
                  <h2 className="text-sm font-semibold">Inventory + price floor over time</h2>
                  <div className="text-xs text-slate-500">Snapshot every 15 min · get-in line highlighted</div>
                </div>
              </div>
              <div className="w-full h-[220px]">
                {chart ? (
                  <svg viewBox="0 0 800 240" preserveAspectRatio="none" className="w-full h-full">
                    <g stroke="rgb(226 232 240 / 0.4)" strokeWidth="1">
                      <line x1="40" y1="30" x2="780" y2="30" />
                      <line x1="40" y1="90" x2="780" y2="90" />
                      <line x1="40" y1="150" x2="780" y2="150" />
                      <line x1="40" y1="210" x2="780" y2="210" />
                    </g>
                    <path d={chartPath} fill="none" stroke="#C89828" strokeWidth="2.5" strokeLinejoin="round" strokeLinecap="round" />
                    <text x="34" y="34" fill="#94a3b8" fontSize="10" fontFamily="monospace" textAnchor="end">{fmtMoney(chart.maxP)}</text>
                    <text x="34" y="214" fill="#94a3b8" fontSize="10" fontFamily="monospace" textAnchor="end">{fmtMoney(chart.minP)}</text>
                  </svg>
                ) : (
                  <div className="h-full flex items-center justify-center text-xs text-slate-400">Not enough snapshots yet. Waiting for the 15-min cron to populate.</div>
                )}
              </div>

              {/* Projection callout */}
              {projection?.success && !projection?.insufficient && projection.projection && (
                <div className="mt-3 grid grid-cols-[auto_1fr] gap-3 items-center p-3 rounded-lg border border-violet-300 dark:border-violet-700 bg-violet-50 dark:bg-violet-950/30">
                  <div className="w-8 h-8 rounded-md bg-violet-600 text-white grid place-items-center font-bold">◪</div>
                  <div className="text-[12.5px] leading-relaxed">
                    <strong className="text-violet-700 dark:text-violet-400">Sold-out projection · fitted on 7d</strong><br />
                    At current pace: <strong>{projection.projection.listings.toLocaleString()} listings remain</strong> at kickoff · <strong>get-in projected {fmtMoney(projection.projection.getIn)}</strong> · event <strong>{projection.projection.percentSoldByKickoff}% sold</strong> by gameday morning.
                    {projection.model?.listings && (
                      <div className="text-slate-500 text-[10.5px] mt-1">R² {projection.model.listings.r2.toFixed(2)} · exponential decay</div>
                    )}
                  </div>
                </div>
              )}
              {projection?.insufficient && (
                <div className="mt-3 p-3 rounded-lg bg-slate-50 dark:bg-slate-800 text-slate-500 text-xs">Not enough snapshot history for a projection yet. Needs ~45 min of scrapes.</div>
              )}
            </div>

            {/* Arbitrage */}
            <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#131C2E] p-4 shadow-sm">
              <div className="flex items-center justify-between mb-2">
                <div>
                  <h2 className="text-sm font-semibold">Arbitrage opportunities</h2>
                  <div className="text-xs text-slate-500">Larger pack priced cheaper per seat than smaller pack. Buy and split.</div>
                </div>
                <span className="text-xs font-semibold text-violet-600">{data.arbitrage.length} active</span>
              </div>
              {data.arbitrage.length === 0 && (
                <div className="text-center text-xs text-slate-400 py-6">No opportunities right now.</div>
              )}
              <div className="flex flex-col gap-2 mt-1">
                {data.arbitrage.slice(0, 8).map((a, i) => {
                  const p = (a.payload as { bigQty: number; bigPerSeat: number; smallQty: number; smallPerSeat: number; spreadPct: number; estProfitTotal: number }) || null;
                  if (!p) return null;
                  return (
                    <div key={i} className="grid grid-cols-[auto_1fr_auto] gap-3 items-center p-2.5 rounded-lg border border-violet-300 dark:border-violet-800 bg-gradient-to-r from-violet-50 to-transparent dark:from-violet-950/40">
                      <span className="rounded-md bg-violet-600 text-white px-2 py-1 text-[10px] font-bold uppercase tracking-wider font-mono">SEC {String(a.section)}</span>
                      <div className="min-w-0">
                        <div className="text-[13px] font-semibold">{p.bigQty}-pack at {fmtMoney(p.bigPerSeat)}/seat vs {p.smallQty}-pack at {fmtMoney(p.smallPerSeat)}/seat</div>
                        <div className="text-[11.5px] text-slate-500">{p.spreadPct}% spread · buy and split</div>
                      </div>
                      <div className="text-right tabular-nums">
                        <div className="text-base font-bold text-violet-700 dark:text-violet-400">+${p.estProfitTotal}</div>
                        <div className="text-[9.5px] uppercase tracking-wider text-slate-500 font-semibold">Est. profit</div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Heatmap */}
            <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#131C2E] p-4 shadow-sm">
              <div className="mb-2">
                <h2 className="text-sm font-semibold">When prices drop · time-of-day heatmap</h2>
                <div className="text-xs text-slate-500">Last 30 days · price-drop alerts by day-of-week × hour</div>
              </div>
              <div className="grid grid-cols-[40px_repeat(24,minmax(0,1fr))] gap-[3px] items-center">
                <div />
                {Array.from({ length: 24 }, (_, h) => (
                  <div key={h} className="text-[9.5px] text-slate-400 text-center font-mono">{h}</div>
                ))}
                {[1, 2, 3, 4, 5, 6, 0].map((d) => (
                  <>
                    <div key={`l-${d}`} className="text-[10.5px] text-slate-500 font-semibold text-right pr-1.5">{DAY_NAMES[d]}</div>
                    {Array.from({ length: 24 }, (_, h) => {
                      const c = data.heatmap.grid.find((x) => x.day === d && x.hour === h)?.count ?? 0;
                      const intensity = c / (data.heatmap.max || 1);
                      const bg = intensity === 0 ? 'transparent' : `rgba(200, 152, 40, ${0.15 + intensity * 0.85})`;
                      return <div key={`c-${d}-${h}`} className="aspect-square rounded-sm border border-slate-100 dark:border-slate-800" style={{ background: bg }} title={`${DAY_NAMES[d]} ${h}:00 · ${c} drops`} />;
                    })}
                  </>
                ))}
              </div>
              {data.heatmap.peaks?.length > 0 && (
                <div className="mt-3 text-[11px] text-slate-500">
                  <span className="font-semibold">Peak windows:</span>{' '}
                  {data.heatmap.peaks.slice(0, 3).map((p) => `${DAY_NAMES[p.day]} ${p.hourStart}–${p.hourEnd}h`).join(' · ')}
                </div>
              )}
            </div>
          </div>

          {/* Right rail */}
          <aside className="flex flex-col gap-4 min-w-0">

            {/* Cheapest */}
            <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#131C2E] shadow-sm overflow-hidden">
              <div className="flex items-center justify-between px-4 py-3 border-b border-slate-200 dark:border-slate-800">
                <div>
                  <h2 className="text-[13px] font-semibold">Cheapest right now</h2>
                  <div className="text-[11px] text-slate-500">Top 5 · {fmtRelative(data.fetchedAt)}</div>
                </div>
                <div className="text-2xl font-bold text-amber-600 tabular-nums">{fmtMoney(data.stats.getInPrice)}</div>
              </div>
              <div className="py-1">
                {data.cheapest.map((c, i) => (
                  <div key={i} className="grid grid-cols-[auto_1fr_auto] gap-2.5 px-4 py-2 items-center">
                    <div className={`w-5 h-5 rounded-full grid place-items-center text-[10.5px] font-bold font-mono ${i === 0 ? 'bg-amber-500 text-[#0B1220]' : 'bg-slate-200 dark:bg-slate-700 text-slate-500'}`}>{i + 1}</div>
                    <div className="min-w-0">
                      <div className="text-[12.5px] font-medium truncate">Sec {c.section} · Row {c.row} · {c.quantity} seats</div>
                      <div className="text-[10.5px] text-slate-500 truncate">{c.tag || 'STANDARD'} · {fmtRelative(c.firstSeenAt)}</div>
                    </div>
                    <div className="text-right">
                      <div className="text-[13px] font-semibold font-mono tabular-nums">{fmtMoney(c.price)}</div>
                    </div>
                  </div>
                ))}
                {data.cheapest.length === 0 && <div className="text-center text-xs text-slate-400 py-6">No inventory yet.</div>}
              </div>
            </div>

            {/* Live alerts */}
            <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#131C2E] shadow-sm overflow-hidden">
              <div className="flex items-center justify-between px-4 py-3 border-b border-slate-200 dark:border-slate-800">
                <h2 className="text-[13px] font-semibold">Live alerts</h2>
                <div className="flex gap-1 flex-wrap">
                  {['all', 'arbitrage', 'priceDrop', 'newLow', 'undercut'].map((t) => (
                    <button key={t} onClick={() => setAlertFilter(t)} className={`px-2 py-0.5 rounded-full text-[10.5px] font-semibold uppercase tracking-wider ${alertFilter === t ? 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-400' : 'border border-slate-200 dark:border-slate-700 text-slate-500'}`}>{t === 'all' ? 'All' : t}</button>
                  ))}
                </div>
              </div>
              <div className="overflow-y-auto max-h-[400px]">
                {filteredAlerts.length === 0 && <div className="text-center text-xs text-slate-400 py-6">No alerts.</div>}
                {filteredAlerts.map((a, i) => {
                  const type = a.type as string;
                  const stripe = type === 'priceDrop' ? 'bg-red-500' : type === 'undercut' ? 'bg-emerald-500' : type === 'newLow' ? 'bg-amber-500' : type === 'arbitrage' ? 'bg-violet-500' : 'bg-blue-500';
                  const typeColor = type === 'priceDrop' ? 'text-red-600' : type === 'undercut' ? 'text-emerald-600' : type === 'newLow' ? 'text-amber-600' : type === 'arbitrage' ? 'text-violet-600' : 'text-blue-600';
                  return (
                    <div key={i} className="grid grid-cols-[4px_1fr] gap-3 px-3.5 py-3 border-b border-slate-100 dark:border-slate-800">
                      <div className={`rounded-sm ${stripe}`} />
                      <div className="min-w-0">
                        <div className="flex items-baseline gap-2 mb-1">
                          <span className={`text-[10px] uppercase tracking-wider font-bold ${typeColor}`}>{type}</span>
                          <span className="ml-auto text-[10.5px] text-slate-400">{fmtRelative(a.at as string | Date)}</span>
                        </div>
                        <div className="text-[12.5px] font-medium truncate">Sec {String(a.section || '—')} · Row {String(a.row || '—')}</div>
                        <div className="flex gap-2.5 text-[11.5px] text-slate-500 mt-1 flex-wrap">
                          {a.oldPrice != null && a.newPrice != null && <span><span className="line-through text-slate-400">{fmtMoney(a.oldPrice as number)}</span> → <span className="font-semibold text-slate-800 dark:text-slate-200">{fmtMoney(a.newPrice as number)}</span></span>}
                          {a.dropPct != null && <span className="text-red-600 font-semibold">{Number(a.dropPct).toFixed(1)}%</span>}
                          {a.undercutPct != null && <span className="text-emerald-600 font-semibold">−{Number(a.undercutPct).toFixed(1)}%</span>}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </aside>

        </div>
      </div>

      {/* Command Palette */}
      {cmdOpen && (
        <div className="fixed inset-0 z-30 bg-slate-900/60 backdrop-blur-[3px] flex items-start justify-center pt-24" onClick={() => setCmdOpen(false)}>
          <div className="w-[640px] max-w-[calc(100vw-40px)] bg-white dark:bg-[#131C2E] border border-slate-200 dark:border-slate-800 rounded-xl shadow-2xl overflow-hidden" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center gap-2.5 px-4 py-3 border-b border-slate-200 dark:border-slate-800">
              <span className="text-slate-400">⌕</span>
              <input autoFocus value={eventFilter} onChange={(e) => setEventFilter(e.target.value)} placeholder="Search events, run commands…" className="flex-1 bg-transparent outline-none text-[15px] font-medium" />
              <span className="text-[11px] text-slate-400"><kbd className="px-1 py-0.5 border border-slate-300 dark:border-slate-600 rounded font-mono">esc</kbd></span>
            </div>
            <div className="max-h-[380px] overflow-y-auto py-1.5">
              <div className="px-4 py-1.5 text-[10px] uppercase tracking-wider text-slate-500 font-semibold">Events</div>
              {filteredEvents.slice(0, 8).map((e, i) => (
                <button key={e.mappingId} onClick={() => { setCmdOpen(false); router.push(`/dashboard/event-room/${e.mappingId}`); }} className={`w-full grid grid-cols-[auto_1fr_auto] gap-3 px-4 py-2 items-center text-left ${i === 0 ? 'bg-slate-100 dark:bg-slate-800' : 'hover:bg-slate-50 dark:hover:bg-slate-800'}`}>
                  <div className="w-6 h-6 rounded-md bg-amber-500 text-[#0B1220] grid place-items-center text-[10px] font-bold font-mono">{e.name.split(' ').slice(0, 2).map((s) => s[0]).join('')}</div>
                  <div className="min-w-0">
                    <div className="text-[13px] font-medium truncate">{e.name}</div>
                    <div className="text-[11px] text-slate-500 truncate">{fmtDate(e.datetime)} · {e.venue}</div>
                  </div>
                  <span className="text-[11px] text-slate-400">Jump →</span>
                </button>
              ))}
              {filteredEvents.length === 0 && <div className="text-center text-xs text-slate-400 py-6">No matches.</div>}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/* ---------- Small stat components ---------- */

function Stat({ stripe, label, value, delta, deltaClass = 'text-slate-500' }: { stripe: string; label: string; value: string; delta?: string | null; deltaClass?: string }) {
  return (
    <div className="relative rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#131C2E] p-4 shadow-sm overflow-hidden min-h-[92px] flex flex-col gap-1.5">
      <div className={`absolute left-0 top-0 bottom-0 w-[3px] ${stripe}`} />
      <span className="text-[10.5px] uppercase tracking-wider text-slate-500 font-semibold">{label}</span>
      <span className="text-2xl font-semibold tabular-nums leading-tight">{value}</span>
      {delta && <span className={`text-xs font-medium ${deltaClass}`}>{delta}</span>}
    </div>
  );
}

function FeatureStat({ label, value, delta, deltaClass }: { label: string; value: string; delta?: string | null; deltaClass?: string }) {
  return (
    <div className="relative rounded-xl border border-amber-500 bg-gradient-to-br from-white to-slate-50 dark:from-[#131C2E] dark:to-[#1A2438] p-4 shadow-sm overflow-hidden min-h-[92px] flex flex-col gap-1.5">
      <div className="absolute left-0 top-0 bottom-0 w-[3px] bg-amber-500" />
      <span className="text-[10.5px] uppercase tracking-wider text-amber-600 font-semibold">{label}</span>
      <span className="text-3xl font-semibold tabular-nums leading-tight text-amber-600">{value}</span>
      {delta && <span className={`text-xs font-medium ${deltaClass}`}>{delta}</span>}
    </div>
  );
}
