'use client';

import React, { useState, useCallback, useTransition } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { createEvent } from '@/actions/eventActions';
import CsvAdjustments from '@/components/ui/CsvAdjustments';
import { DEFAULT_MARKUP } from '@/lib/markupDefaults';
import Image from 'next/image';
import {
  Search, Import, Calendar, MapPin, ChevronLeft, ChevronRight,
  Loader2, Check, X, ExternalLink, DollarSign, Flame,
  Package, RefreshCw, ChevronDown, ChevronUp, Shield, Ticket,
  Users, Music, AlertTriangle, Twitter, Instagram, Globe, Wand2, Minus, Plus,
} from 'lucide-react';

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface TMPresale {
  name: string;
  startDateTime: string;
  endDateTime: string;
}

interface TMAttraction {
  name: string;
  upcomingEvents: number;
  twitter?: string;
  instagram?: string;
  facebook?: string;
  spotify?: string;
  youtube?: string;
}

interface TMEvent {
  id: string;
  name: string;
  url: string;
  dateTime: string;
  localDate: string;
  localTime: string;
  venue: string;
  venueCity: string;
  venueState: string;
  imageUrl: string;
  classification: string;
  segment: string;
  priceMin: number | null;
  priceMax: number | null;
  status: string;
  saleStart: string;
  saleEnd: string;
  pleaseNote: string;
  presaleCount: number;
  presales: TMPresale[];
  ticketLimit: string;
  safeTix: boolean;
  seatmapUrl: string;
  promoter: string;
  attractions: TMAttraction[];
  venueCapacity: number | null;
  accessibility: string;
}

interface ListedInfo {
  portalId: string;
  mappingId: string;
  availableSeats: number;
  inventoryCount: number;
  scrapingActive: boolean;
}

interface ImportState {
  mappingId: string;
  percentage: number;
  standardAdj: number;
  resaleAdj: number;
  brokerAdj: number;
  status: 'idle' | 'importing' | 'success' | 'error';
  error?: string;
  stubhubSearchUrl?: string;
  stubhubCandidate?: { id: string; url: string; name: string | null };
  stubhubNote?: string;
}

interface Props {
  events: TMEvent[];
  listedEvents: Record<string, ListedInfo>;
  total: number;
  totalPages: number;
  currentPage: number;
  isSearch: boolean;
  searchError: string;
  filters: {
    keyword: string;
    city: string;
    stateCode: string;
    startDate: string;
    endDate: string;
    segment: string;
  };
}

const SEGMENT_OPTIONS = [
  { value: '', label: 'All' },
  { value: 'Sports', label: 'Sports' },
  { value: 'Music', label: 'Music' },
  { value: 'Arts & Theatre', label: 'Arts & Theatre' },
  { value: 'Film', label: 'Film' },
  { value: 'Miscellaneous', label: 'Misc' },
];

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function formatDateTime(_dt: string, localDate: string, localTime: string) {
  if (!localDate) return 'TBD';
  const [y, mo, d] = localDate.split('-').map(Number);
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const dateStr = `${months[mo - 1]} ${d}, ${y}`;
  if (localTime) {
    const [h, m] = localTime.split(':').map(Number);
    const ampm = h >= 12 ? 'PM' : 'AM';
    const h12 = h % 12 || 12;
    return `${dateStr}, ${h12}:${String(m).padStart(2, '0')} ${ampm}`;
  }
  return dateStr;
}

function extractUrlEventId(url: string): string {
  try {
    const parts = new URL(url).pathname.split('/');
    const idx = parts.findIndex(p => p === 'event');
    if (idx >= 0 && idx + 1 < parts.length) return parts[idx + 1];
  } catch { /* ignore */ }
  return '';
}

function hotLabel(index: number) {
  if (index < 3) return { label: 'Hot', cls: 'bg-gradient-to-r from-red-500 to-orange-500 text-white' };
  if (index < 8) return { label: 'Popular', cls: 'bg-gradient-to-r from-purple-500 to-indigo-500 text-white' };
  return null;
}

/* ------------------------------------------------------------------ */
/*  Note Expander                                                      */
/* ------------------------------------------------------------------ */

function NoteExpander({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const isLong = text.length > 120;

  return (
    <>
      <div className="text-[10px] text-amber-600 bg-amber-50 border border-amber-100 rounded px-2 py-1">
        <div className="flex items-start gap-1">
          <AlertTriangle className="w-2.5 h-2.5 shrink-0 mt-0.5" />
          <p className="line-clamp-2">{text}</p>
        </div>
        {isLong && (
          <button
            onClick={(e) => { e.stopPropagation(); setOpen(true); }}
            className="mt-0.5 font-semibold text-amber-700 hover:text-amber-900 underline underline-offset-2"
          >
            Read more
          </button>
        )}
      </div>

      {open && (
        <div className="absolute inset-0 z-10 flex items-center justify-center p-3" onClick={() => setOpen(false)}>
          <div className="absolute inset-0 bg-black/30 rounded-xl" />
          <div
            className="relative bg-white rounded-lg shadow-lg max-h-[80%] w-[90%] flex flex-col border border-amber-200 overflow-hidden"
            onClick={e => e.stopPropagation()}
          >
            <div className="flex items-center justify-between px-3 py-2 border-b border-amber-100 bg-amber-50">
              <div className="flex items-center gap-1.5">
                <AlertTriangle className="w-3.5 h-3.5 text-amber-500" />
                <span className="text-xs font-semibold text-slate-700">Event Notice</span>
              </div>
              <button onClick={() => setOpen(false)} className="p-0.5 rounded hover:bg-amber-100 text-slate-400 hover:text-slate-600 transition-colors">
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
            <div className="px-3 py-2 overflow-y-auto text-xs text-slate-700 leading-relaxed whitespace-pre-wrap">
              {text}
            </div>
          </div>
        </div>
      )}
    </>
  );
}

/* ------------------------------------------------------------------ */
/*  Main Component                                                     */
/* ------------------------------------------------------------------ */

export default function ImportEventsClient({
  events,
  listedEvents,
  total,
  totalPages,
  currentPage,
  isSearch,
  searchError,
  filters,
}: Props) {
  const router = useRouter();
  const urlSearchParams = useSearchParams();
  const [isPending, startTransition] = useTransition();

  const [showFilters, setShowFilters] = useState(!!(filters.city || filters.stateCode));

  // Form state (local, synced from server filters on mount)
  const [keyword, setKeyword] = useState(filters.keyword);
  const [city, setCity] = useState(filters.city);
  const [stateCode, setStateCode] = useState(filters.stateCode);
  const [startDate, setStartDate] = useState(filters.startDate);
  const [endDate, setEndDate] = useState(filters.endDate);
  const [segment, setSegment] = useState(filters.segment);

  // Import state
  const [imports, setImports] = useState<Record<string, ImportState>>({});
  const [fetchingStubhubId, setFetchingStubhubId] = useState<Record<string, boolean>>({});

  /* ---- URL helpers ---- */
  const buildUrl = useCallback((overrides: Record<string, string | undefined>) => {
    const params = new URLSearchParams(urlSearchParams);
    Object.entries(overrides).forEach(([key, value]) => {
      if (value !== undefined && value !== '') {
        params.set(key, value);
      } else {
        params.delete(key);
      }
    });
    return `/dashboard/import-events?${params.toString()}`;
  }, [urlSearchParams]);

  const navigate = useCallback((overrides: Record<string, string | undefined>) => {
    startTransition(() => {
      router.push(buildUrl(overrides));
    });
  }, [buildUrl, router, startTransition]);

  /* ---- Search ---- */
  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    if (!keyword.trim() && !city.trim() && !startDate && !endDate) return;
    navigate({
      keyword: keyword.trim() || undefined,
      city: city.trim() || undefined,
      stateCode: stateCode.trim().toUpperCase() || undefined,
      startDate: startDate || undefined,
      endDate: endDate || undefined,
      segment: segment || undefined,
      page: undefined, // reset page
    });
  };

  const clearSearch = () => {
    setKeyword(''); setCity(''); setStateCode(''); setStartDate(''); setEndDate(''); setSegment('');
    startTransition(() => {
      router.push('/dashboard/import-events');
    });
  };

  const handleRefresh = () => {
    startTransition(() => {
      router.refresh();
    });
  };

  /* ---- Trending segment ---- */
  const handleSegmentChange = (seg: string) => {
    setSegment(seg);
    navigate({
      segment: seg || undefined,
      keyword: undefined,
      city: undefined,
      stateCode: undefined,
      startDate: undefined,
      endDate: undefined,
      page: undefined,
    });
  };

  /* ---- Pagination ---- */
  const handlePageChange = (p: number) => {
    navigate({ page: String(p) });
  };

  /* ---- StubHub ID fetch (server runs a search agent; see app/api/stubhub/lookup) ---- */

  /** StubHub event ID from a pasted StubHub event URL. */
  const extractStubhubIdFromUrl = (url: string): string | null => {
    const m = url.trim().match(/stubhub\.com\/[^?#]*\/event\/(\d{5,})/i);
    return m ? m[1] : null;
  };

  const handleFetchStubhubId = async (event: TMEvent) => {
    const pasted = extractStubhubIdFromUrl(imports[event.id]?.mappingId || '');
    if (pasted) {
      updateImportState(event.id, { mappingId: pasted, status: 'idle', error: undefined });
      return;
    }
    setFetchingStubhubId(prev => ({ ...prev, [event.id]: true }));
    updateImportState(event.id, { status: 'idle', error: undefined, stubhubCandidate: undefined, stubhubNote: undefined, stubhubSearchUrl: undefined });
    try {
      const res = await fetch('/api/stubhub/lookup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: event.name,
          venue: event.venue,
          city: event.venueCity,
          state: event.venueState,
          localDate: event.localDate || event.dateTime.slice(0, 10),
          localTime: event.localTime,
          tmUrl: event.url,
        }),
        signal: AbortSignal.timeout(130000),
      });
      const data = await res.json();
      if (data.found && data.stubhubId) {
        updateImportState(event.id, { mappingId: String(data.stubhubId), status: 'idle', error: undefined, stubhubNote: data.notes || undefined });
      } else {
        updateImportState(event.id, {
          status: 'error',
          error: data.error || data.notes || 'No matching StubHub event found.',
          stubhubCandidate: data.candidate || undefined,
          stubhubSearchUrl: data.searchUrl || `https://www.stubhub.com/search?q=${encodeURIComponent(event.name)}`,
        });
      }
    } catch {
      updateImportState(event.id, {
        status: 'error',
        error: 'StubHub lookup failed. Enter the StubHub ID by hand.',
        stubhubSearchUrl: `https://www.stubhub.com/search?q=${encodeURIComponent(event.name)}`,
      });
    } finally {
      setFetchingStubhubId(prev => ({ ...prev, [event.id]: false }));
    }
  };

  /* ---- Import ---- */
  const updateImportState = (eventId: string, update: Partial<ImportState>) => {
    // New cards start from the default markup so the first edit doesn't drop it.
    setImports(prev => ({ ...prev, [eventId]: { mappingId: '', ...DEFAULT_MARKUP, status: 'idle', ...(prev[eventId] as Partial<ImportState> | undefined), ...update } as ImportState }));
  };

  const handleImport = async (event: TMEvent) => {
    const state = imports[event.id];
    const mappingId = state?.mappingId?.trim();
    if (!mappingId) {
      updateImportState(event.id, { status: 'error', error: 'StubHub ID required' });
      return;
    }
    const blockedStates = ['RI', 'ME'];
    if (blockedStates.includes(event.venueState?.toUpperCase())) {
      updateImportState(event.id, { status: 'error', error: `${event.venueState.toUpperCase()} events are not allowed.` });
      return;
    }
    updateImportState(event.id, { status: 'importing', error: undefined });
    try {
      // Use the venue's local date/time from the TM Discovery API — this is what
      // appears on the ticket and what StubHub also uses.
      const localDate = event.localDate || event.dateTime.slice(0, 10);
      const localTime = event.localTime || event.dateTime.slice(11, 19) || '00:00:00';

      // Build a Date using Date.UTC() with the local time components so that
      // MongoDB/JS never applies a server-timezone offset.  The result is stored
      // as "2024-11-15T19:00:00.000Z" — the display layer reads it back with
      // timeZone:'UTC' so the user always sees the original venue local time.
      const [y, mo, d] = localDate.split('-').map(Number);
      const [h, min, sec] = localTime.split(':').map(Number);
      const eventDateTime = new Date(Date.UTC(y, mo - 1, d, h || 0, min || 0, sec || 0));

      // inHandDate: day before the event (also UTC-safe)
      const eventDt = new Date(Date.UTC(y, mo - 1, d));
      const today = new Date(); today.setUTCHours(0, 0, 0, 0);
      const inHandDt = new Date(eventDt);
      if (eventDt > today) inHandDt.setUTCDate(inHandDt.getUTCDate() - 1);

      let finalUrl = event.url;
      let urlEventId = extractUrlEventId(event.url);
      const isHexId = /^[0-9A-Fa-f]+$/.test(urlEventId);
      if (!urlEventId || !isHexId) {
        const resolveRes = await fetch(`/api/ticketmaster/resolve-url?url=${encodeURIComponent(event.url)}`);
        const resolveData = await resolveRes.json();
        if (resolveData.url) finalUrl = resolveData.url;
        if (resolveData.eventId) urlEventId = resolveData.eventId;
      }
      if (!urlEventId || !/^[0-9A-Fa-f]+$/.test(urlEventId)) {
        throw new Error('Could not resolve Ticketmaster hex Event ID — this event cannot be imported');
      }
      const eventData = {
        URL: finalUrl, Event_ID: urlEventId, Event_Name: event.name,
        Event_DateTime: eventDateTime, Venue: event.venue, Zone: 'none',
        Available_Seats: 0, Skip_Scraping: true, inHandDate: inHandDt.toISOString(),
        mapping_id: mappingId, priceIncreasePercentage: imports[event.id]?.percentage ?? DEFAULT_MARKUP.percentage,
        standardMarkupAdjustment: imports[event.id]?.standardAdj ?? DEFAULT_MARKUP.standardAdj,
        resaleMarkupAdjustment: imports[event.id]?.resaleAdj ?? DEFAULT_MARKUP.resaleAdj,
        brokerMarkupAdjustment: imports[event.id]?.brokerAdj ?? DEFAULT_MARKUP.brokerAdj,
      };
      const result = await createEvent(eventData as Parameters<typeof createEvent>[0]);
      if (result.error) throw new Error(result.error);
      updateImportState(event.id, { status: 'success' });
    } catch (err: unknown) {
      updateImportState(event.id, { status: 'error', error: (err as Error).message || 'Import failed' });
    }
  };

  /* ---- Derived ---- */
  const listedCount = events.filter(e => listedEvents[e.id]).length;

  /* ---- Event Card ---- */
  const renderEventCard = (event: TMEvent, index: number) => {
    const listed = listedEvents[event.id];
    const impState = imports[event.id] || { mappingId: '', ...DEFAULT_MARKUP, status: 'idle' };
    const isImported = impState.status === 'success';
    const isImporting = impState.status === 'importing';
    const isListed = !!listed;
    const hot = !isSearch ? hotLabel(index) : null;

    return (
      <div
        key={event.id}
        className={`group relative rounded-xl border overflow-hidden transition-all duration-200 flex flex-col ${
          isListed
            ? 'border-slate-300 bg-slate-100 grayscale-[40%] opacity-50 hover:opacity-75 hover:grayscale-0'
            : isImported
              ? 'border-emerald-300 bg-emerald-50/50 shadow-md'
              : 'border-slate-200 bg-white hover:shadow-lg hover:border-purple-300'
        }`}
      >
        {/* Image */}
        <div className="relative w-full h-40 bg-gradient-to-br from-slate-100 to-slate-200 overflow-hidden">
          {event.imageUrl ? (
            <Image src={event.imageUrl} alt={event.name} fill className="object-cover group-hover:scale-105 transition-transform duration-300" unoptimized />
          ) : (
            <div className="flex items-center justify-center h-full">
              <Calendar className="w-10 h-10 text-slate-300" />
            </div>
          )}
          {/* Top overlays */}
          <div className="absolute top-0 inset-x-0 p-2.5 flex items-start justify-between">
            <div className="flex items-center gap-1.5 flex-wrap">
              {hot && (
                <span className={`text-[10px] font-bold uppercase tracking-wide px-2 py-0.5 rounded-md shadow-sm ${hot.cls}`}>
                  <Flame className="w-2.5 h-2.5 inline -mt-0.5 mr-0.5" />{hot.label}
                </span>
              )}
              {(event.venueState || event.venueCity) && (
                <span className="text-[10px] font-bold px-2 py-0.5 rounded-md shadow-sm bg-white/90 backdrop-blur-sm text-slate-700">
                  <MapPin className="w-2.5 h-2.5 inline -mt-0.5 mr-0.5" />
                  {event.venueState ? `${event.venueState}, US` : 'US'}
                </span>
              )}
            </div>
            <a href={event.url} target="_blank" rel="noopener noreferrer"
              className="w-7 h-7 flex items-center justify-center rounded-lg bg-white/90 backdrop-blur-sm text-slate-500 hover:text-purple-600 hover:bg-white transition-all shadow-sm">
              <ExternalLink className="w-3.5 h-3.5" />
            </a>
          </div>
          {/* Already Listed overlay */}
          {isListed && (
            <div className="absolute inset-0 bg-gradient-to-b from-slate-900/50 via-slate-900/30 to-slate-900/60 flex flex-col items-center justify-center gap-1.5">
              <span className="text-xs font-bold text-white bg-purple-600 px-4 py-1.5 rounded-full shadow-lg">
                Already Listed
              </span>
              <div className="flex items-center gap-2">
                <span className="text-[10px] font-medium text-white/90 bg-black/40 backdrop-blur-sm px-2 py-0.5 rounded">
                  <Package className="w-2.5 h-2.5 inline -mt-0.5 mr-0.5" />{listed.inventoryCount} in inventory
                </span>
                <span className={`text-[10px] font-medium text-white/90 px-2 py-0.5 rounded backdrop-blur-sm ${listed.scrapingActive ? 'bg-emerald-600/70' : 'bg-red-600/70'}`}>
                  <span className={`inline-block w-1.5 h-1.5 rounded-full mr-1 -mt-0.5 align-middle ${listed.scrapingActive ? 'bg-emerald-300 animate-pulse' : 'bg-red-300'}`} />
                  {listed.scrapingActive ? 'Live' : 'Paused'}
                </span>
              </div>
            </div>
          )}
          {/* Bottom image badges */}
          <div className="absolute bottom-2.5 inset-x-2.5 flex items-end justify-between">
            <div className="flex items-center gap-1.5">
              {event.priceMin != null ? (
                <span className="text-xs font-bold text-white bg-slate-900/70 backdrop-blur-sm px-2.5 py-1 rounded-lg">
                  <DollarSign className="w-3 h-3 inline -mt-0.5" />
                  {event.priceMin}{event.priceMax != null && event.priceMax !== event.priceMin ? ` – $${event.priceMax}` : ''}
                </span>
              ) : null}
              {event.seatmapUrl && (
                <a href={event.seatmapUrl} target="_blank" rel="noopener noreferrer"
                  className="text-[10px] font-bold text-white bg-indigo-600/80 backdrop-blur-sm px-2 py-1 rounded-lg hover:bg-indigo-600 transition-colors" title="View Seatmap">
                  Seatmap
                </a>
              )}
            </div>
            {event.classification && (
              <span className="text-[10px] font-medium text-white bg-purple-600/80 backdrop-blur-sm px-2 py-0.5 rounded-md">
                {event.segment || event.classification}
              </span>
            )}
          </div>
        </div>

        {/* Body */}
        <div className="flex-1 p-4 flex flex-col gap-2.5">
          <h3 className={`font-semibold text-sm leading-snug line-clamp-2 min-h-[2.5rem] ${isListed ? 'text-slate-500' : 'text-slate-800'}`}>{event.name}</h3>

          <div className="space-y-1.5 text-xs text-slate-500">
            <div className="flex items-center gap-1.5">
              <Calendar className="w-3.5 h-3.5 text-purple-400 shrink-0" />
              <span className="truncate">{formatDateTime(event.dateTime, event.localDate, event.localTime)}</span>
            </div>
            <div className="flex items-center gap-1.5">
              <MapPin className="w-3.5 h-3.5 text-purple-400 shrink-0" />
              <span className="truncate">{event.venue}{event.venueCity ? `, ${event.venueCity}` : ''}{event.venueState ? ` ${event.venueState}` : ''}</span>
            </div>
          </div>

          <p className="text-[10px] text-slate-400 font-mono truncate">ID: {event.id}</p>

          {/* Insights row */}
          <div className="flex flex-wrap gap-1.5">
            {event.safeTix && (
              <span className="inline-flex items-center gap-0.5 text-[10px] font-bold px-1.5 py-0.5 rounded bg-red-50 text-red-600 border border-red-200" title="SafeTix enabled - digital-only tickets">
                <Shield className="w-2.5 h-2.5" /> SafeTix
              </span>
            )}
            {event.presaleCount > 0 && (
              <span className="inline-flex items-center gap-0.5 text-[10px] font-bold px-1.5 py-0.5 rounded bg-amber-50 text-amber-700 border border-amber-200" title={event.presales.map(p => p.name).join(', ')}>
                <Ticket className="w-2.5 h-2.5" /> {event.presaleCount} presale{event.presaleCount > 1 ? 's' : ''}
              </span>
            )}
            {event.ticketLimit && (
              <span className="inline-flex items-center gap-0.5 text-[10px] font-medium px-1.5 py-0.5 rounded bg-blue-50 text-blue-600 border border-blue-200" title={event.ticketLimit}>
                <AlertTriangle className="w-2.5 h-2.5" /> Limit
              </span>
            )}
            {event.attractions?.[0]?.upcomingEvents > 0 && (
              <span className="inline-flex items-center gap-0.5 text-[10px] font-medium px-1.5 py-0.5 rounded bg-indigo-50 text-indigo-600 border border-indigo-200" title={`${event.attractions[0].name} has ${event.attractions[0].upcomingEvents} upcoming events`}>
                <Users className="w-2.5 h-2.5" /> {event.attractions[0].upcomingEvents} dates
              </span>
            )}
            {event.promoter && (
              <span className="inline-flex items-center gap-0.5 text-[10px] font-medium px-1.5 py-0.5 rounded bg-slate-100 text-slate-600 border border-slate-200" title={event.promoter}>
                <Music className="w-2.5 h-2.5" /> {event.promoter.length > 15 ? event.promoter.slice(0, 15) + '…' : event.promoter}
              </span>
            )}
          </div>

          {/* Social links */}
          {event.attractions?.[0] && (event.attractions[0].twitter || event.attractions[0].instagram || event.attractions[0].facebook || event.attractions[0].spotify) && (
            <div className="flex items-center gap-1.5 flex-wrap">
              <span className="text-[10px] text-slate-400 font-medium">{event.attractions[0].name}:</span>
              {event.attractions[0].twitter && (
                <a href={event.attractions[0].twitter} target="_blank" rel="noopener noreferrer"
                  className="inline-flex items-center gap-0.5 text-[10px] font-medium px-1.5 py-0.5 rounded bg-sky-50 text-sky-600 border border-sky-200 hover:bg-sky-100 transition-colors">
                  <Twitter className="w-2.5 h-2.5" /> Twitter
                </a>
              )}
              {event.attractions[0].instagram && (
                <a href={event.attractions[0].instagram} target="_blank" rel="noopener noreferrer"
                  className="inline-flex items-center gap-0.5 text-[10px] font-medium px-1.5 py-0.5 rounded bg-pink-50 text-pink-600 border border-pink-200 hover:bg-pink-100 transition-colors">
                  <Instagram className="w-2.5 h-2.5" /> Instagram
                </a>
              )}
              {event.attractions[0].facebook && (
                <a href={event.attractions[0].facebook} target="_blank" rel="noopener noreferrer"
                  className="inline-flex items-center gap-0.5 text-[10px] font-medium px-1.5 py-0.5 rounded bg-blue-50 text-blue-600 border border-blue-200 hover:bg-blue-100 transition-colors">
                  <Globe className="w-2.5 h-2.5" /> Facebook
                </a>
              )}
              {event.attractions[0].spotify && (
                <a href={event.attractions[0].spotify} target="_blank" rel="noopener noreferrer"
                  className="inline-flex items-center gap-0.5 text-[10px] font-medium px-1.5 py-0.5 rounded bg-green-50 text-green-600 border border-green-200 hover:bg-green-100 transition-colors">
                  <Music className="w-2.5 h-2.5" /> Spotify
                </a>
              )}
            </div>
          )}

          {/* Please note - expandable */}
          {event.pleaseNote && (
            <NoteExpander text={event.pleaseNote} />
          )}

          {/* Spacer */}
          <div className="flex-1" />

          {/* Listed info */}
          {isListed && (
            <div className="bg-purple-50 border border-purple-100 rounded-lg p-2.5 space-y-1.5">
              <div className="flex items-center justify-between text-xs">
                <span className="text-purple-700 font-medium">StubHub ID: <span className="font-mono">{listed.mappingId}</span></span>
                <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-bold ${listed.scrapingActive ? 'bg-emerald-100 text-emerald-700' : 'bg-red-50 text-red-500'}`}>
                  <span className={`w-1.5 h-1.5 rounded-full ${listed.scrapingActive ? 'bg-emerald-500 animate-pulse' : 'bg-red-400'}`} />
                  {listed.scrapingActive ? 'Live' : 'Paused'}
                </span>
              </div>
              <div className="flex items-center gap-3 text-xs text-purple-600">
                <span className="inline-flex items-center gap-1"><Package className="w-3 h-3" /> {listed.inventoryCount} in inventory</span>
              </div>
              <a href={`/dashboard/events/${listed.portalId}`}
                className="block text-center text-xs font-medium text-purple-600 hover:text-purple-800 bg-white border border-purple-200 rounded-md py-1 hover:bg-purple-50 transition-colors">
                View in Portal
              </a>
            </div>
          )}

          {/* Import section */}
          {!isListed && (
            <div className="space-y-2">
              {isImported ? (
                <div className="flex items-center justify-center gap-1.5 text-sm font-medium text-emerald-600 bg-emerald-50 rounded-lg py-2 border border-emerald-200">
                  <Check className="w-4 h-4" /> Imported
                </div>
              ) : (
                <>
                  <div className="flex gap-1.5">
                    <input
                      type="text"
                      placeholder="StubHub ID or paste StubHub URL"
                      value={impState.mappingId || ''}
                      onChange={e => {
                        let val = e.target.value;
                        // Pasted StubHub event URL -> its event ID
                        const id = extractStubhubIdFromUrl(val);
                        if (id) val = id;
                        updateImportState(event.id, { mappingId: val, status: 'idle', error: undefined, stubhubCandidate: undefined });
                      }}
                      disabled={isImporting}
                      className="flex-1 min-w-0 px-3 py-2 border border-slate-200 rounded-lg text-sm focus:ring-2 focus:ring-purple-500 focus:border-transparent disabled:bg-slate-50 transition-all"
                    />
                    <button
                      onClick={() => handleFetchStubhubId(event)}
                      disabled={isImporting || fetchingStubhubId[event.id]}
                      title="Search StubHub for this event and fill in its ID"
                      className="inline-flex items-center gap-1.5 px-3 py-2 border border-purple-200 rounded-lg text-purple-600 bg-purple-50 hover:bg-purple-100 hover:border-purple-300 text-xs font-medium disabled:opacity-50 disabled:cursor-not-allowed transition-all whitespace-nowrap"
                    >
                      {fetchingStubhubId[event.id] ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Wand2 className="w-3.5 h-3.5" />}
                      {fetchingStubhubId[event.id] ? 'Searching StubHub…' : 'Fetch StubHub ID'}
                    </button>
                  </div>
                  {fetchingStubhubId[event.id] && (
                    <p className="text-[11px] text-purple-600">Searching StubHub for this date and venue. This can take up to a minute.</p>
                  )}
                  {!fetchingStubhubId[event.id] && impState.stubhubNote && impState.mappingId && (
                    <p className="text-[11px] text-emerald-700 flex items-start gap-1"><Check className="w-3 h-3 shrink-0 mt-0.5" /> {impState.stubhubNote}</p>
                  )}
                  <div>
                    <p className="text-[10px] font-bold text-gray-400 uppercase tracking-widest mb-1.5">Default Markup</p>
                    <div className="flex items-center gap-2">
                      <button type="button" aria-label="Decrease markup by 5%" disabled={isImporting}
                        onClick={() => updateImportState(event.id, { percentage: Math.max(0, (impState.percentage ?? DEFAULT_MARKUP.percentage) - 5), status: 'idle', error: undefined })}
                        className="w-8 h-8 flex items-center justify-center rounded-lg bg-gray-100 hover:bg-gray-200 text-gray-700 disabled:opacity-40 transition-colors shrink-0">
                        <Minus className="w-3.5 h-3.5" />
                      </button>
                      <div className="relative flex-1">
                        <input
                          type="number"
                          min={0}
                          max={999}
                          placeholder="30"
                          value={impState.percentage ?? DEFAULT_MARKUP.percentage}
                          onChange={e => updateImportState(event.id, { percentage: Number(e.target.value) || 0, status: 'idle', error: undefined })}
                          disabled={isImporting}
                          className="w-full px-3 py-2 pr-8 text-center font-bold border border-slate-200 rounded-lg text-sm focus:ring-2 focus:ring-purple-500 focus:border-transparent disabled:bg-slate-50 transition-all [appearance:textfield]"
                        />
                        <span className="absolute right-3 top-1/2 -translate-y-1/2 text-sm text-slate-400 font-medium">%</span>
                      </div>
                      <button type="button" aria-label="Increase markup by 5%" disabled={isImporting}
                        onClick={() => updateImportState(event.id, { percentage: Math.min(999, (impState.percentage ?? DEFAULT_MARKUP.percentage) + 5), status: 'idle', error: undefined })}
                        className="w-8 h-8 flex items-center justify-center rounded-lg bg-gray-100 hover:bg-gray-200 text-gray-700 disabled:opacity-40 transition-colors shrink-0">
                        <Plus className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>
                  <CsvAdjustments
                    defaultPct={impState.percentage ?? DEFAULT_MARKUP.percentage}
                    standardAdj={impState.standardAdj ?? DEFAULT_MARKUP.standardAdj}
                    resaleAdj={impState.resaleAdj ?? DEFAULT_MARKUP.resaleAdj}
                    brokerAdj={impState.brokerAdj ?? DEFAULT_MARKUP.brokerAdj}
                    onStandardChange={v => updateImportState(event.id, { standardAdj: v, status: 'idle', error: undefined })}
                    onResaleChange={v => updateImportState(event.id, { resaleAdj: v, status: 'idle', error: undefined })}
                    onBrokerChange={v => updateImportState(event.id, { brokerAdj: v, status: 'idle', error: undefined })}
                    disabled={isImporting}
                  />
                  <button onClick={() => handleImport(event)} disabled={isImporting}
                    className="w-full inline-flex items-center justify-center gap-1.5 px-4 py-2 bg-gradient-to-r from-purple-600 to-indigo-600 text-white text-sm font-medium rounded-lg hover:from-purple-700 hover:to-indigo-700 disabled:opacity-50 transition-all shadow-sm shadow-purple-200">
                    {isImporting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Import className="w-3.5 h-3.5" />}
                    {isImporting ? 'Importing...' : 'Import Event'}
                  </button>
                  {impState.status === 'error' && impState.error && (
                    <div className="text-xs text-red-600 space-y-1.5">
                      <p className="flex items-start gap-1"><X className="w-3 h-3 shrink-0 mt-0.5" /> {impState.error}</p>
                      {impState.stubhubCandidate && (
                        <div className="flex items-center gap-2 bg-amber-50 border border-amber-200 rounded-md px-2.5 py-2">
                          <div className="flex-1 min-w-0">
                            <p className="text-[11px] font-semibold text-amber-800 truncate">{impState.stubhubCandidate.name || 'Possible match'}</p>
                            <p className="text-[10px] text-amber-700 font-mono">StubHub ID {impState.stubhubCandidate.id}</p>
                          </div>
                          <a href={impState.stubhubCandidate.url} target="_blank" rel="noopener noreferrer"
                            className="p-1 text-blue-500 hover:text-blue-700 shrink-0" title="Open on StubHub">
                            <ExternalLink className="w-3 h-3" />
                          </a>
                          <button
                            onClick={() => updateImportState(event.id, { mappingId: impState.stubhubCandidate!.id, status: 'idle', error: undefined, stubhubCandidate: undefined })}
                            className="text-[11px] font-semibold px-2.5 py-1 bg-purple-600 text-white rounded-md hover:bg-purple-700 transition-colors shrink-0"
                          >
                            Use it
                          </button>
                        </div>
                      )}
                      {impState.stubhubSearchUrl && (
                        <a
                          href={impState.stubhubSearchUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-1 text-[11px] font-medium text-purple-600 hover:text-purple-800 underline underline-offset-2"
                        >
                          <ExternalLink className="w-3 h-3" /> Search StubHub manually
                        </a>
                      )}
                    </div>
                  )}
                </>
              )}
            </div>
          )}
        </div>
      </div>
    );
  };

  return (
    <div className="space-y-5">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-slate-800">Import Events</h1>
        <p className="text-sm text-slate-500 mt-1">Search Ticketmaster &amp; import US events with StubHub mapping</p>
      </div>

      {/* Search Bar */}
      <div className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden">
        <form onSubmit={handleSearch}>
          {/* Main search row */}
          <div className="flex items-center gap-2 p-3">
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
              <input type="text" value={keyword} onChange={e => setKeyword(e.target.value)}
                placeholder="Search events, artists, teams... (or leave empty for date search)"
                className="w-full pl-10 pr-4 py-2.5 border border-slate-200 rounded-lg focus:ring-2 focus:ring-purple-500 focus:border-transparent text-sm bg-slate-50 focus:bg-white transition-colors" />
            </div>
            <button type="submit" disabled={isPending}
              className="inline-flex items-center gap-2 px-5 py-2.5 bg-gradient-to-r from-purple-600 to-indigo-600 text-white font-medium rounded-lg hover:from-purple-700 hover:to-indigo-700 disabled:opacity-50 transition-all text-sm shadow-sm shadow-purple-200 whitespace-nowrap">
              {isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Search className="w-4 h-4" />}
              Search
            </button>
          </div>

          {/* Date + filters row */}
          <div className="border-t border-slate-100 bg-slate-50/50 px-3 pb-3 pt-2.5">
            <div className="flex items-end gap-3 flex-wrap">
              <div className="flex-1 min-w-[140px]">
                <label className="block text-[10px] font-semibold text-slate-400 uppercase tracking-wider mb-1">From Date</label>
                <input type="date" value={startDate} onChange={e => setStartDate(e.target.value)}
                  className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm focus:ring-2 focus:ring-purple-500 focus:border-transparent bg-white" />
              </div>
              <div className="flex-1 min-w-[140px]">
                <label className="block text-[10px] font-semibold text-slate-400 uppercase tracking-wider mb-1">To Date</label>
                <input type="date" value={endDate} onChange={e => setEndDate(e.target.value)}
                  className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm focus:ring-2 focus:ring-purple-500 focus:border-transparent bg-white" />
              </div>
              <div className="flex-1 min-w-[120px]">
                <label className="block text-[10px] font-semibold text-slate-400 uppercase tracking-wider mb-1">Category</label>
                <select value={segment} onChange={e => setSegment(e.target.value)}
                  className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm focus:ring-2 focus:ring-purple-500 focus:border-transparent bg-white">
                  {SEGMENT_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
              </div>
              <button type="button" onClick={() => setShowFilters(!showFilters)}
                className={`inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium rounded-lg border transition-all ${
                  showFilters ? 'bg-purple-50 border-purple-300 text-purple-700' : 'bg-white border-slate-200 text-slate-500 hover:border-purple-300'
                }`}>
                {showFilters ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
                More
              </button>
            </div>

            {/* Extra filters (city, state) */}
            {showFilters && (
              <div className="grid grid-cols-2 gap-3 mt-3 pt-3 border-t border-slate-200/60">
                <div>
                  <label className="block text-[10px] font-semibold text-slate-400 uppercase tracking-wider mb-1">City</label>
                  <input type="text" value={city} onChange={e => setCity(e.target.value)} placeholder="e.g. Los Angeles"
                    className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm focus:ring-2 focus:ring-purple-500 focus:border-transparent bg-white" />
                </div>
                <div>
                  <label className="block text-[10px] font-semibold text-slate-400 uppercase tracking-wider mb-1">State</label>
                  <input type="text" value={stateCode} onChange={e => setStateCode(e.target.value)} placeholder="CA" maxLength={2}
                    className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm focus:ring-2 focus:ring-purple-500 focus:border-transparent bg-white uppercase" />
                </div>
              </div>
            )}
          </div>
        </form>

        {searchError && (
          <div className="px-3 pb-3">
            <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{searchError}</p>
          </div>
        )}
      </div>

      {/* Results header bar */}
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="flex items-center gap-3">
          {isSearch ? (
            <div className="flex items-center gap-2">
              <span className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-purple-100 text-purple-700 text-sm font-semibold">
                <Search className="w-4 h-4" />
                Search Results
                <span className="bg-purple-600 text-white text-xs px-1.5 py-0.5 rounded-full ml-1">{total.toLocaleString()}</span>
              </span>
              <button onClick={clearSearch}
                className="inline-flex items-center gap-1 px-3 py-1.5 text-xs font-medium text-slate-500 hover:text-red-600 bg-white border border-slate-200 hover:border-red-200 rounded-lg transition-all">
                <X className="w-3 h-3" /> Clear Search
              </button>
            </div>
          ) : (
            <div className="flex items-center gap-2 flex-wrap">
              <span className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-orange-100 text-orange-700 text-sm font-semibold">
                <Flame className="w-4 h-4" /> Trending
              </span>
              {SEGMENT_OPTIONS.map(o => (
                <button key={o.value}
                  onClick={() => handleSegmentChange(o.value)}
                  className={`px-3 py-1.5 rounded-full text-xs font-medium border transition-all ${
                    filters.segment === o.value
                      ? 'bg-gradient-to-r from-purple-600 to-indigo-600 text-white border-transparent shadow-sm shadow-purple-200'
                      : 'bg-white text-slate-600 border-slate-200 hover:border-purple-300 hover:text-purple-700'
                  }`}>
                  {o.label}
                </button>
              ))}
            </div>
          )}
        </div>
        <div className="flex items-center gap-2">
          <button onClick={handleRefresh} disabled={isPending}
            className="inline-flex items-center gap-1 px-3 py-1.5 text-xs font-medium text-slate-500 hover:text-purple-600 bg-white border border-slate-200 rounded-lg transition-colors">
            <RefreshCw className={`w-3.5 h-3.5 ${isPending ? 'animate-spin' : ''}`} /> Refresh
          </button>
          {events.length > 0 && (
            <span className="text-xs text-slate-400">
              {events.length} of {total.toLocaleString()}
              {totalPages > 1 && ` · Page ${currentPage + 1}/${totalPages}`}
            </span>
          )}
          {listedCount > 0 && (
            <span className="inline-flex items-center gap-1.5 text-purple-600 text-xs font-medium bg-purple-50 px-2.5 py-1 rounded-full border border-purple-200">
              <Check className="w-3 h-3" /> {listedCount} listed
            </span>
          )}
        </div>
      </div>

      {/* Active search filters summary */}
      {isSearch && (filters.keyword || filters.startDate || filters.endDate || filters.city || filters.stateCode || filters.segment) && (
        <div className="flex items-center gap-1.5 flex-wrap text-xs">
          <span className="text-slate-400 font-medium">Filters:</span>
          {filters.keyword && <span className="px-2 py-0.5 rounded-md bg-blue-50 text-blue-700 border border-blue-200 font-medium">&quot;{filters.keyword}&quot;</span>}
          {filters.startDate && <span className="px-2 py-0.5 rounded-md bg-green-50 text-green-700 border border-green-200 font-medium">From: {filters.startDate}</span>}
          {filters.endDate && <span className="px-2 py-0.5 rounded-md bg-green-50 text-green-700 border border-green-200 font-medium">To: {filters.endDate}</span>}
          {filters.city && <span className="px-2 py-0.5 rounded-md bg-amber-50 text-amber-700 border border-amber-200 font-medium">{filters.city}</span>}
          {filters.stateCode && <span className="px-2 py-0.5 rounded-md bg-amber-50 text-amber-700 border border-amber-200 font-medium">{filters.stateCode}</span>}
          {filters.segment && <span className="px-2 py-0.5 rounded-md bg-purple-50 text-purple-700 border border-purple-200 font-medium">{filters.segment}</span>}
        </div>
      )}

      {/* Card Grid */}
      {events.length > 0 && (
        <>
          <div className="relative">
            {/* Loading overlay - keeps content visible underneath */}
            {isPending && (
              <div className="absolute inset-0 z-10 bg-white/60 backdrop-blur-[1px] rounded-xl flex items-start justify-center pt-24">
                <div className="flex items-center gap-2.5 bg-white px-5 py-3 rounded-xl shadow-lg border border-purple-100">
                  <Loader2 className="w-5 h-5 text-purple-500 animate-spin" />
                  <span className="text-sm font-medium text-slate-600">{isSearch ? 'Searching...' : 'Loading...'}</span>
                </div>
              </div>
            )}

            <div className={`grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4 transition-opacity duration-200 ${isPending ? 'opacity-50 pointer-events-none' : ''}`}>
              {events.map((ev, i) => renderEventCard(ev, i))}
            </div>
          </div>
          {/* Pagination — placed OUTSIDE the relative/overlay container so buttons stay clickable */}
          {totalPages > 1 && (
            <div className="flex items-center justify-center gap-1.5 pt-4">
              <button onClick={() => handlePageChange(currentPage - 1)} disabled={currentPage <= 0 || isPending}
                className="inline-flex items-center gap-1 px-3 py-1.5 text-sm font-medium text-slate-600 bg-white border border-slate-200 rounded-lg hover:bg-slate-50 disabled:opacity-40 disabled:cursor-not-allowed transition-colors">
                <ChevronLeft className="w-4 h-4" />
              </button>
              {(() => {
                const pages: number[] = [];
                const maxPage = Math.min(totalPages, Math.floor(999 / 20)); // TM API deep paging limit
                const start = Math.max(0, Math.min(currentPage - 2, maxPage - 5));
                const end = Math.min(maxPage, start + 5);
                for (let i = start; i < end; i++) pages.push(i);
                return pages.map(p => (
                  <button key={p} onClick={() => handlePageChange(p)} disabled={isPending}
                    className={`w-9 h-9 text-sm font-medium rounded-lg transition-all ${
                      p === currentPage
                        ? 'bg-gradient-to-r from-purple-600 to-indigo-600 text-white shadow-md shadow-purple-200'
                        : 'text-slate-600 bg-white border border-slate-200 hover:bg-purple-50 hover:border-purple-300'
                    }`}>
                    {p + 1}
                  </button>
                ));
              })()}
              <button onClick={() => handlePageChange(currentPage + 1)} disabled={currentPage >= Math.min(totalPages, Math.floor(999 / 20)) - 1 || isPending}
                className="inline-flex items-center gap-1 px-3 py-1.5 text-sm font-medium text-slate-600 bg-white border border-slate-200 rounded-lg hover:bg-slate-50 disabled:opacity-40 disabled:cursor-not-allowed transition-colors">
                <ChevronRight className="w-4 h-4" />
              </button>
            </div>
          )}
        </>
      )}

      {/* No results */}
      {!isPending && events.length === 0 && !searchError && (
        <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-12 text-center">
          <Search className="w-12 h-12 text-slate-300 mx-auto mb-3" />
          <p className="text-slate-600 font-medium">No events found</p>
          <p className="text-sm text-slate-400 mt-1">Try different keywords, dates, or broaden your search</p>
        </div>
      )}
    </div>
  );
}
