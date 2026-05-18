import React from 'react';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getEventById, getInventoryCountsByType } from '@/actions/eventActions';
import {
  Calendar, MapPin, ExternalLink,
  Activity, ChevronLeft, Ticket,
  Hash, Clock, Tag, Globe, TrendingUp
} from 'lucide-react';

import EventDetailActions from './EventDetailActions';
import PriceEditor from './PriceEditor';
import CsvExportToggles from './CsvExportToggles';

interface EventDetailsProps {
  params: Promise<{ id: string }>;
}

interface EventType {
  _id: string;
  mapping_id: string;
  Event_ID: string;
  Event_Name: string;
  Event_DateTime: string;
  Venue?: string;
  URL: string;
  Zone?: string;
  Available_Seats?: number;
  Skip_Scraping?: boolean;
  inHandDate?: string;
  priceIncreasePercentage?: number;
  standardMarkupAdjustment?: number;
  resaleMarkupAdjustment?: number;
  brokerMarkupAdjustment?: number;
  includeStandardSeats?: boolean;
  includeResaleSeats?: boolean;
  Last_Updated?: string;
  createdAt?: string;
  updatedAt?: string;
  error?: string;
}

function fmt(date: string, opts: Intl.DateTimeFormatOptions) {
  return new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', ...opts }).format(new Date(date));
}

function timeAgo(date: string) {
  const diff = Date.now() - new Date(date).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

export default async function EventDetailsPage({ params }: EventDetailsProps) {
  const { id } = await params;
  const event: EventType = await getEventById(id) as EventType;

  if (!event || event.error) {
    notFound();
  }

  /* async-defer-await: start inventory fetch immediately, await late */
  const inventoryPromise = event.mapping_id
    ? getInventoryCountsByType([event.mapping_id])
    : Promise.resolve({} as Record<string, { standard: number; resale: number; standardRows: number; resaleRows: number; standardAvgCost: number | null; resaleAvgCost: number | null }>);

  const isActive = !event.Skip_Scraping;
  const lastUpdated = event.Last_Updated || event.updatedAt;
  const isStale = lastUpdated
    ? Date.now() - new Date(lastUpdated).getTime() > 4 * 60 * 1000
    : true;

  const pct = event.priceIncreasePercentage ?? 25;
  const stdAdj = event.standardMarkupAdjustment ?? 0;
  const resAdj = event.resaleMarkupAdjustment ?? 0;
  const brkAdj = event.brokerMarkupAdjustment ?? 0;

  const inventoryCounts = await inventoryPromise;
  const mid = event.mapping_id;
  const standardQty = mid ? (inventoryCounts[mid]?.standard ?? 0) : 0;
  const resaleQty = mid ? (inventoryCounts[mid]?.resale ?? 0) : 0;
  const standardRows = mid ? (inventoryCounts[mid]?.standardRows ?? 0) : 0;
  const resaleRows = mid ? (inventoryCounts[mid]?.resaleRows ?? 0) : 0;
  const standardAvgCost = mid ? (inventoryCounts[mid]?.standardAvgCost ?? null) : null;
  const resaleAvgCost = mid ? (inventoryCounts[mid]?.resaleAvgCost ?? null) : null;

  const includeStandard = event.includeStandardSeats !== false;
  const includeResale = event.includeResaleSeats !== false;

  return (
    <div className="space-y-5">

      {/* ── Breadcrumb + Actions ── */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <Link
          href="/dashboard/events"
          className="inline-flex items-center gap-1.5 text-sm font-medium text-slate-500 hover:text-blue-600 transition-colors"
        >
          <ChevronLeft size={15} />
          Events
        </Link>
        <div className="flex items-center gap-2 flex-wrap">
          {event.URL && (
            <a href={event.URL} target="_blank" rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-semibold bg-blue-600 hover:bg-blue-700 text-white transition-colors shadow-sm">
              <Ticket size={13} />
              Ticketmaster
              <ExternalLink size={10} />
            </a>
          )}
          <EventDetailActions eventId={id} eventName={event.Event_Name} isScrapingActive={isActive} />
        </div>
      </div>

      {/* ── Header Card ── */}
      <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
        <div className="bg-gradient-to-r from-purple-600 to-indigo-600 px-6 py-5 relative overflow-hidden">
          <div className="absolute inset-0 bg-black/10" />
          <div className="relative flex items-start justify-between gap-4">
            <div className="min-w-0">
              <div className="flex items-center gap-2 mb-1.5">
                <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-bold border ${
                  isActive ? 'bg-green-500/20 text-green-100 border-green-400/30' : 'bg-white/10 text-white/60 border-white/20'
                }`}>
                  <Activity size={10} />
                  {isActive ? 'Active' : 'Paused'}
                </span>
                {isStale && isActive && (
                  <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-bold bg-amber-400/20 text-amber-200 border border-amber-300/30">
                    Stale
                  </span>
                )}
                {event.Zone && event.Zone !== 'none' && (
                  <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-bold bg-white/10 text-purple-100 border border-white/15">
                    {event.Zone}
                  </span>
                )}
              </div>
              <h1 className="text-xl font-bold text-white leading-tight">{event.Event_Name}</h1>
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1 mt-1.5 text-sm text-purple-100">
                {event.Venue && (
                  <span className="flex items-center gap-1.5"><MapPin size={12} className="text-purple-200" />{event.Venue}</span>
                )}
                {event.Event_DateTime && (
                  <span className="flex items-center gap-1.5">
                    <Calendar size={12} className="text-purple-200" />
                    {fmt(event.Event_DateTime, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })}
                    <span className="text-purple-300">·</span>
                    {fmt(event.Event_DateTime, { hour: '2-digit', minute: '2-digit' })}
                  </span>
                )}
              </div>
            </div>
          </div>
        </div>

        {/* ── Inventory & Markup strip ── */}
        <div className="grid grid-cols-2 sm:grid-cols-4 bg-slate-50/80 border-t border-slate-100 divide-x divide-slate-100">
          {/* Standard */}
          <div className={`px-4 py-3 relative group transition-opacity duration-200 ${includeStandard ? '' : 'opacity-35'}`}>
            <div className="flex items-center gap-1.5 mb-1">
              <span className={`inline-flex items-center justify-center w-5 h-5 rounded text-[10px] font-bold ${
                includeStandard ? 'bg-blue-100 text-blue-700' : 'bg-slate-100 text-slate-400'
              }`}>S</span>
              <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">Standard</p>
            </div>
            <div className="flex items-baseline gap-2">
              <p className={`text-xl font-bold tabular-nums ${includeStandard ? 'text-blue-700' : 'text-slate-400'}`}>
                {standardQty.toLocaleString()}
              </p>
              <span className="text-[10px] text-slate-400 font-medium">{standardRows} rows</span>
            </div>
            {standardAvgCost != null && (
              <p className="text-[10px] text-slate-500 mt-0.5">
                avg cost <span className="font-bold text-slate-700">${standardAvgCost.toFixed(2)}</span>
              </p>
            )}
            {!includeStandard && (
              <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 px-2.5 py-1.5 bg-slate-800 text-white text-[11px] font-medium rounded-lg whitespace-nowrap opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none z-10 shadow-lg">
                Excluded from CSV
                <div className="absolute top-full left-1/2 -translate-x-1/2 -mt-px border-4 border-transparent border-t-slate-800" />
              </div>
            )}
          </div>

          {/* Resale */}
          <div className={`px-4 py-3 relative group transition-opacity duration-200 ${includeResale ? '' : 'opacity-35'}`}>
            <div className="flex items-center gap-1.5 mb-1">
              <span className={`inline-flex items-center justify-center w-5 h-5 rounded text-[10px] font-bold ${
                includeResale ? 'bg-red-100 text-red-700' : 'bg-slate-100 text-slate-400'
              }`}>R</span>
              <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">Resale</p>
            </div>
            <div className="flex items-baseline gap-2">
              <p className={`text-xl font-bold tabular-nums ${includeResale ? 'text-red-700' : 'text-slate-400'}`}>
                {resaleQty.toLocaleString()}
              </p>
              <span className="text-[10px] text-slate-400 font-medium">{resaleRows} rows</span>
            </div>
            {resaleAvgCost != null && (
              <p className="text-[10px] text-slate-500 mt-0.5">
                avg cost <span className="font-bold text-slate-700">${resaleAvgCost.toFixed(2)}</span>
              </p>
            )}
            {!includeResale && (
              <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 px-2.5 py-1.5 bg-slate-800 text-white text-[11px] font-medium rounded-lg whitespace-nowrap opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none z-10 shadow-lg">
                Excluded from CSV
                <div className="absolute top-full left-1/2 -translate-x-1/2 -mt-px border-4 border-transparent border-t-slate-800" />
              </div>
            )}
          </div>

          {/* Markup */}
          <div className="px-4 py-3">
            <div className="flex items-center gap-1.5 mb-1">
              <TrendingUp size={11} className="text-slate-400" />
              <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">Markup</p>
            </div>
            <div className="flex items-baseline gap-1.5">
              <p className={`text-xl font-bold tabular-nums ${
                pct > 0 ? 'text-rose-600' : pct < 0 ? 'text-blue-600' : 'text-slate-700'
              }`}>{pct > 0 ? '+' : ''}{pct}%</p>
            </div>
            <div className="flex gap-1 mt-1">
              <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded tabular-nums ${
                stdAdj !== 0 ? (stdAdj > 0 ? 'bg-orange-50 text-orange-600' : 'bg-sky-50 text-sky-600') : 'bg-slate-100 text-slate-400'
              }`}>S {pct + stdAdj}%</span>
              <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded tabular-nums ${
                resAdj !== 0 ? (resAdj > 0 ? 'bg-orange-50 text-orange-600' : 'bg-sky-50 text-sky-600') : 'bg-slate-100 text-slate-400'
              }`}>R {pct + resAdj}%</span>
              <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded tabular-nums ${
                brkAdj !== 0 ? (brkAdj > 0 ? 'bg-orange-50 text-orange-600' : 'bg-sky-50 text-sky-600') : 'bg-slate-100 text-slate-400'
              }`}>B {pct + (brkAdj !== 0 ? brkAdj : resAdj)}%</span>
            </div>
          </div>

          {/* Last Updated */}
          <div className="px-4 py-3">
            <div className="flex items-center gap-1.5 mb-1">
              <Clock size={11} className="text-slate-400" />
              <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">Updated</p>
            </div>
            <p className="text-xl font-bold tabular-nums text-slate-700">
              {lastUpdated ? timeAgo(lastUpdated) : '—'}
            </p>
            {lastUpdated && (
              <p className="text-[10px] text-slate-400 mt-0.5">
                {fmt(lastUpdated, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
              </p>
            )}
          </div>
        </div>
      </div>

      {/* ── Body ── */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">

        {/* Left: Metadata + IDs */}
        <section className="lg:col-span-2 space-y-5">
          {/* Key Info */}
          <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
            <div className="px-5 py-3.5 border-b border-slate-100 flex items-center gap-2">
              <span className="w-6 h-6 rounded-md bg-purple-50 flex items-center justify-center">
                <Tag size={12} className="text-purple-500" />
              </span>
              <h2 className="text-sm font-bold text-slate-700">Event Info</h2>
            </div>
            <div className="p-5">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-8 gap-y-4">
                <MetaItem label="In-Hand Date">
                  {event.inHandDate
                    ? fmt(event.inHandDate, { month: 'short', day: 'numeric', year: 'numeric' })
                    : <span className="text-slate-300">—</span>}
                </MetaItem>
                <MetaItem label="Zone">
                  <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-semibold ${
                    event.Zone && event.Zone !== 'none' ? 'bg-indigo-50 text-indigo-700' : 'bg-slate-100 text-slate-400'
                  }`}>{event.Zone || 'none'}</span>
                </MetaItem>
                <MetaItem label="Listed">
                  {event.createdAt
                    ? fmt(event.createdAt, { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' })
                    : <span className="text-slate-300">—</span>}
                </MetaItem>
                <MetaItem label="Source">
                  {event.URL ? (
                    <a href={event.URL} target="_blank" rel="noopener noreferrer"
                      className="inline-flex items-center gap-1.5 text-purple-600 hover:text-purple-700 transition-colors text-sm font-medium">
                      <Globe size={11} />
                      Ticketmaster
                      <ExternalLink size={10} />
                    </a>
                  ) : <span className="text-slate-300">—</span>}
                </MetaItem>
              </div>
            </div>
          </div>

          {/* IDs */}
          <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
            <div className="px-5 py-3.5 border-b border-slate-100 flex items-center gap-2">
              <span className="w-6 h-6 rounded-md bg-slate-100 flex items-center justify-center">
                <Hash size={12} className="text-slate-500" />
              </span>
              <h2 className="text-sm font-bold text-slate-700">Identifiers</h2>
            </div>
            <div className="p-5">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-8 gap-y-3">
                <IdItem label="Event ID" value={event.Event_ID} />
                <IdItem label="Mapping ID" value={event.mapping_id} />
              </div>
            </div>
          </div>
        </section>

        {/* Right sidebar */}
        <div className="lg:col-span-1 space-y-5">
          <CsvExportToggles
            eventId={id}
            includeStandard={includeStandard}
            includeResale={includeResale}
            standardQty={standardQty}
            resaleQty={resaleQty}
            standardRows={standardRows}
            resaleRows={resaleRows}
          />
          <PriceEditor
            eventId={id}
            initialPct={pct}
            initialStandardAdj={stdAdj}
            initialResaleAdj={resAdj}
            initialBrokerAdj={brkAdj}
          />
        </div>
      </div>
    </div>
  );
}

function MetaItem({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1">{label}</p>
      <div className="text-sm font-medium text-slate-700">{children}</div>
    </div>
  );
}

function IdItem({ label, value }: { label: string; value?: string }) {
  return (
    <div>
      <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1">{label}</p>
      <code className="text-xs bg-slate-50 border border-slate-100 px-2 py-1 rounded-md font-mono text-slate-600 select-all">
        {value || '—'}
      </code>
    </div>
  );
}
