import React from 'react';
import Link from 'next/link';
import { 
  Calendar, MapPin, Users,
  AlertCircle, Clock, TrendingUp,
  ChevronUp, ChevronDown, ChevronsUpDown
} from 'lucide-react';
import { getPaginatedEventsAdvanced, getEventCounts, getInventoryCountsByType } from '@/actions/eventActions';
import EventsTableControls from './EventsTableControls';
import EventTableActions from './EventTableActions';
import PaginationControls from './PaginationControls';
import TimeAgo from './TimeAgo';
import { BulkSelectionProvider, BulkActionBar, BulkSelectAllCheckbox, BulkRowCheckbox } from './BulkSelection';

interface EventData {
  _id: string;
  Event_Name: string;
  Event_DateTime: string;
  Venue?: string;
  Available_Seats?: number;
  mapping_id?: string;
  Skip_Scraping?: boolean;
  Last_Updated?: string;
  updatedAt?: string;
  priceIncreasePercentage?: number;
  standardMarkupAdjustment?: number;
  resaleMarkupAdjustment?: number;
  brokerMarkupAdjustment?: number;
  standardQty?: number;
  resaleQty?: number;
  standardRows?: number;
  resaleRows?: number;
  includeStandardSeats?: boolean;
  includeResaleSeats?: boolean;
  eventType?: 'NFL' | 'MLB' | 'NHL' | 'NBA' | 'MLS' | 'Other' | null;
}

const EVENT_TYPE_BADGE: Record<string, { cls: string; dot: string }> = {
  NFL: { cls: 'bg-amber-100 text-amber-800 border-amber-300/80',    dot: 'bg-amber-500'   },
  MLB: { cls: 'bg-blue-100  text-blue-800  border-blue-300/80',     dot: 'bg-blue-500'    },
  NBA: { cls: 'bg-orange-100 text-orange-800 border-orange-300/80', dot: 'bg-orange-500'  },
  NHL: { cls: 'bg-sky-100   text-sky-800   border-sky-300/80',      dot: 'bg-sky-500'     },
  MLS: { cls: 'bg-emerald-100 text-emerald-800 border-emerald-300/80', dot: 'bg-emerald-500' },
  Other: { cls: 'bg-violet-100 text-violet-800 border-violet-300/80', dot: 'bg-violet-500' },
};

function EventTypeBadge({ type }: { type?: string | null }) {
  if (!type) {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold border border-dashed border-slate-300 text-slate-400 bg-white">
        <span className="w-1.5 h-1.5 rounded-full bg-slate-300" aria-hidden="true" />
        Unset
      </span>
    );
  }
  const cfg = EVENT_TYPE_BADGE[type] || EVENT_TYPE_BADGE.Other;
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold border shadow-[inset_0_0_0_1px_rgba(255,255,255,0.5)] ${cfg.cls}`}>
      <span className={`w-1.5 h-1.5 rounded-full ${cfg.dot}`} aria-hidden="true" />
      {type}
    </span>
  );
}

interface ResolvedSearchParams {
  page?: string;
  search?: string;
  limit?: string;
  dateFrom?: string;
  dateTo?: string;
  venue?: string;
  scrapingStatus?: string;
  sortBy?: string;
  sortOrder?: string;
  seatMin?: string;
  seatMax?: string;
  eventType?: string;
}

// Sortable column header (server-renderable link)
function SortableHeader({
  children,
  sortKey,
  currentSortBy,
  currentSortOrder,
  sp,
  className,
}: {
  children: React.ReactNode;
  sortKey: string;
  currentSortBy: string;
  currentSortOrder: string;
  sp: ResolvedSearchParams;
  className?: string;
}) {
  const isActive = currentSortBy === sortKey;
  const nextOrder = isActive && currentSortOrder === 'asc' ? 'desc' : 'asc';

  const params = new URLSearchParams();
  params.set('page', '1');
  if (sp.search) params.set('search', sp.search);
  if (sp.limit) params.set('limit', sp.limit);
  if (sp.dateFrom) params.set('dateFrom', sp.dateFrom);
  if (sp.dateTo) params.set('dateTo', sp.dateTo);
  if (sp.venue) params.set('venue', sp.venue);
  if (sp.scrapingStatus) params.set('scrapingStatus', sp.scrapingStatus);
  if (sp.seatMin) params.set('seatMin', sp.seatMin);
  if (sp.seatMax) params.set('seatMax', sp.seatMax);
  if (sp.eventType) params.set('eventType', sp.eventType);
  params.set('sortBy', sortKey);
  params.set('sortOrder', nextOrder);

  return (
    <Link
      href={`?${params.toString()}`}
      className={`inline-flex items-center gap-1 group hover:text-blue-600 transition-colors ${className ?? ''}`}
    >
      {children}
      {isActive && currentSortOrder === 'asc' ? (
        <ChevronUp size={12} className="text-blue-500 shrink-0" />
      ) : isActive && currentSortOrder === 'desc' ? (
        <ChevronDown size={12} className="text-blue-500 shrink-0" />
      ) : (
        <ChevronsUpDown size={12} className="text-gray-300 group-hover:text-gray-400 shrink-0" />
      )}
    </Link>
  );
}

interface PageProps {
  searchParams: Promise<ResolvedSearchParams>;
}

// Server component utilities
function formatDate(dateString?: string) {
  if (!dateString) return '—';
  return new Date(dateString).toLocaleDateString('en-US', { 
    year: 'numeric', 
    month: 'short', 
    day: 'numeric',
    timeZone: 'UTC',
  });
}

function formatTime(dateString?: string) {
  if (!dateString) return '—';
  return new Date(dateString).toLocaleTimeString('en-US', { 
    hour: '2-digit', 
    minute: '2-digit',
    timeZone: 'UTC',
  });
}

// Status Badge Component
function StatusBadge({ isActive }: { isActive: boolean }) {
  if (isActive) {
    return (
      <div className="flex items-center">
        <div className="w-2 h-2 rounded-full mr-2 bg-blue-500"></div>
        <span className="px-3 py-1 rounded-full text-xs font-semibold bg-blue-50 text-blue-700 border border-blue-200">
          Active
        </span>
      </div>
    );
  }
  
  return (
    <div className="flex items-center">
      <div className="w-2 h-2 rounded-full mr-2 bg-slate-400"></div>
      <span className="px-3 py-1 rounded-full text-xs font-semibold bg-slate-50 text-slate-700 border border-slate-200">
        Inactive
      </span>
    </div>
  );
}

// Main Events Table Component (Server Component)
export default async function EventsTableServerSide({ searchParams }: PageProps) {
  const sp = await searchParams;

  const page = parseInt(sp.page || '1');
  const limit = parseInt(sp.limit || '100');
  const search = sp.search || '';
  
  // Build filters from search params
  const sortBy = sp.sortBy || 'updated';
  const sortOrder = sp.sortOrder || 'asc';

  const filters = {
    dateFrom: sp.dateFrom,
    dateTo: sp.dateTo,
    venue: sp.venue,
    scrapingStatus: sp.scrapingStatus || 'all',
    eventType: sp.eventType,
    sortBy,
    sortOrder,
    seatRange: {
      min: sp.seatMin,
      max: sp.seatMax,
    },
  };

  // Fetch data on server-side
  const [eventsResult, counts] = await Promise.all([
    getPaginatedEventsAdvanced(page, limit, search, filters),
    getEventCounts(),
  ]);
  
  const rawEvents: EventData[] = eventsResult.events || [];

  // Fetch standard/resale quantity counts for all fetched events
  const mappingIds = rawEvents.map((e) => e.mapping_id).filter(Boolean) as string[];
  const inventoryCounts = await getInventoryCountsByType(mappingIds);

  // Merge counts into event data
  const events: EventData[] = rawEvents.map((e) => ({
    ...e,
    standardQty: e.mapping_id ? (inventoryCounts[e.mapping_id]?.standard ?? 0) : 0,
    resaleQty: e.mapping_id ? (inventoryCounts[e.mapping_id]?.resale ?? 0) : 0,
    standardRows: e.mapping_id ? (inventoryCounts[e.mapping_id]?.standardRows ?? 0) : 0,
    resaleRows: e.mapping_id ? (inventoryCounts[e.mapping_id]?.resaleRows ?? 0) : 0,
  }));
  const total = eventsResult.total || 0;
  const totalPages = eventsResult.totalPages || 1;

  const pageEventMeta = events.map(e => ({
    id: e._id,
    name: e.Event_Name,
    active: !e.Skip_Scraping,
  }));

  return (
    <BulkSelectionProvider pageEvents={pageEventMeta}>
    <div className="space-y-3">
      {/* Bulk action bar — appears only when rows are selected */}
      <BulkActionBar />

      {/* Search and Filter Controls */}
      <EventsTableControls
        currentPage={page}
        totalPages={totalPages}
        totalEvents={total}
        eventsPerPage={limit}
        searchTerm={search}
        filters={filters}
        activeCount={counts.active}
        grandTotal={counts.total}
      />

      {/* Error state */}
      {eventsResult.error && (
        <div className="bg-red-50 border border-red-200 text-red-800 p-4 rounded-lg">
          <div className="flex items-center gap-2">
            <AlertCircle className="h-5 w-5" />
            <span>Error loading data: {eventsResult.error}</span>
          </div>
        </div>
      )}

      {/* Events Table */}
      {events.length === 0 ? (
        <div className="bg-white rounded-xl border border-gray-200 p-16 text-center">
          <div className="w-20 h-20 bg-gray-100 rounded-full flex items-center justify-center mx-auto mb-4">
            <AlertCircle className="w-10 h-10 text-gray-400" />
          </div>
          <h3 className="text-lg font-semibold text-gray-700 mb-2">No events found</h3>
          <p className="text-gray-500 max-w-md mx-auto">
            No events match your current filters. Try adjusting your search criteria or create a new event.
          </p>
        </div>
      ) : (
        <div className="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden">
          {/* Desktop Table */}
          <div className="hidden md:block overflow-x-auto">
            <table className="w-full divide-y divide-gray-200 table-fixed">
              <colgroup>
                <col className="w-[36px]" />
                <col className="w-[90px]" />
                <col />
                <col className="w-[130px]" />
                <col className="w-[72px]" />
                <col className="w-[72px]" />
                <col className="w-[72px]" />
                <col className="w-[130px]" />
                <col className="w-[160px]" />
              </colgroup>
              <thead className="bg-gradient-to-r from-gray-50 to-gray-100">
                <tr>
                  <th className="px-3 py-2.5 text-center text-xs font-bold text-gray-600 uppercase tracking-wider">
                    <BulkSelectAllCheckbox />
                  </th>
                  <th className="px-3 py-2.5 text-left text-xs font-bold text-gray-600 uppercase tracking-wider">
                    Status
                  </th>
                  <th className="px-3 py-2.5 text-left text-xs font-bold text-gray-600 uppercase tracking-wider">
                    <SortableHeader sortKey="name" currentSortBy={sortBy} currentSortOrder={sortOrder} sp={sp}>
                      Event Details
                    </SortableHeader>
                  </th>
                  <th className="px-3 py-2.5 text-left text-xs font-bold text-gray-600 uppercase tracking-wider">
                    <SortableHeader sortKey="date" currentSortBy={sortBy} currentSortOrder={sortOrder} sp={sp}>
                      Date
                    </SortableHeader>
                  </th>
                  <th className="px-3 py-2.5 text-right text-xs font-bold text-gray-600 uppercase tracking-wider">
                    <SortableHeader sortKey="seats" currentSortBy={sortBy} currentSortOrder={sortOrder} sp={sp} className="justify-end">
                      Qty
                    </SortableHeader>
                  </th>
                  <th className="px-3 py-2.5 text-right text-xs font-bold text-gray-600 uppercase tracking-wider">
                    Rows
                  </th>
                  <th className="px-3 py-2.5 text-right text-xs font-bold text-gray-600 uppercase tracking-wider">
                    <SortableHeader sortKey="markup" currentSortBy={sortBy} currentSortOrder={sortOrder} sp={sp} className="justify-end">
                      Markup
                    </SortableHeader>
                  </th>
                  <th className="px-3 py-2.5 text-center text-xs font-bold text-gray-600 uppercase tracking-wider">
                    <SortableHeader sortKey="updated" currentSortBy={sortBy} currentSortOrder={sortOrder} sp={sp} className="justify-center">
                      Updated
                    </SortableHeader>
                  </th>
                  <th className="px-3 py-2.5 text-right text-xs font-bold text-gray-600 uppercase tracking-wider">
                    Actions
                  </th>
                </tr>
              </thead>
              <tbody className="bg-white divide-y divide-gray-100">
                {events.map((event) => {
                  const lastUpdated = event.Last_Updated || event.updatedAt;
                  const fresh = lastUpdated
                    ? Date.now() - new Date(lastUpdated).getTime() < 4 * 60 * 1000
                    : false;
                  const isActive = !event.Skip_Scraping;
                  const stdIncluded = event.includeStandardSeats !== false;
                  const resIncluded = event.includeResaleSeats !== false;

                  return (
                    <tr
                      key={event._id}
                      className={`hover:bg-gray-50 transition-[background-color] duration-150 ${
                        isActive && fresh ? 'bg-blue-50 border-l-2 border-blue-400' :
                        isActive && !fresh ? 'bg-amber-50 border-l-2 border-amber-400' :
                        'bg-gray-50/60 border-l-2 border-gray-300 opacity-75'
                      }`}
                    >
                      <td className="px-3 py-2 whitespace-nowrap text-center">
                        <BulkRowCheckbox eventId={event._id} eventName={event.Event_Name} />
                      </td>
                      <td className="px-3 py-2 whitespace-nowrap">
                        <StatusBadge isActive={isActive} />
                      </td>
                      
                      <td className="px-3 py-2">
                        <div className="min-w-0">
                          <div className="flex items-center gap-1.5 min-w-0">
                            <Link
                              href={`/dashboard/events/${event._id}`}
                              className="text-gray-900 hover:text-blue-600 font-semibold text-sm transition-[color] duration-150 truncate"
                            >
                              {event.Event_Name}
                            </Link>
                            <EventTypeBadge type={event.eventType} />
                          </div>
                          <div className="flex items-center gap-2 text-xs text-gray-500 mt-0.5 min-w-0">
                            {event.Venue && (
                              <div className="flex items-center gap-0.5 min-w-0">
                                <MapPin size={11} aria-hidden="true" />
                                <span className="truncate max-w-[140px]">{event.Venue}</span>
                              </div>
                            )}
                            <span className="font-mono shrink-0 text-gray-400">{event.mapping_id || '—'}</span>
                          </div>
                        </div>
                      </td>
                      
                      <td className="px-3 py-2 whitespace-nowrap">
                        <div className="font-medium text-gray-900 text-xs tabular-nums">
                          {formatDate(event.Event_DateTime)}
                        </div>
                        <div className="text-[11px] text-gray-500 tabular-nums">
                          {formatTime(event.Event_DateTime)}
                        </div>
                      </td>
                      
                      <td className="px-3 py-2 whitespace-nowrap text-right">
                        <div className="flex flex-col items-end gap-0.5">
                          <span className={`inline-flex items-center text-[11px] font-semibold px-1.5 py-0.5 rounded border tabular-nums ${
                            stdIncluded ? 'border-blue-200 bg-blue-50 text-blue-700' : 'border-slate-200 bg-slate-50 text-slate-400 line-through opacity-50'
                          }`}>
                            <span className="mr-0.5 opacity-50 text-[9px]">S</span>{(event.standardQty ?? 0).toLocaleString()}
                          </span>
                          <span className={`inline-flex items-center text-[11px] font-semibold px-1.5 py-0.5 rounded border tabular-nums ${
                            resIncluded ? 'border-red-200 bg-red-50 text-red-700' : 'border-slate-200 bg-slate-50 text-slate-400 line-through opacity-50'
                          }`}>
                            <span className="mr-0.5 opacity-50 text-[9px]">R</span>{(event.resaleQty ?? 0).toLocaleString()}
                          </span>
                        </div>
                      </td>

                      <td className="px-3 py-2 whitespace-nowrap text-right">
                        <div className="flex flex-col items-end gap-0.5">
                          <span className={`inline-flex items-center text-[11px] font-semibold px-1.5 py-0.5 rounded border tabular-nums ${
                            stdIncluded ? 'border-blue-200 bg-blue-50 text-blue-700' : 'border-slate-200 bg-slate-50 text-slate-400 line-through opacity-50'
                          }`}>
                            <span className="mr-0.5 opacity-50 text-[9px]">S</span>{(event.standardRows ?? 0).toLocaleString()}
                          </span>
                          <span className={`inline-flex items-center text-[11px] font-semibold px-1.5 py-0.5 rounded border tabular-nums ${
                            resIncluded ? 'border-red-200 bg-red-50 text-red-700' : 'border-slate-200 bg-slate-50 text-slate-400 line-through opacity-50'
                          }`}>
                            <span className="mr-0.5 opacity-50 text-[9px]">R</span>{(event.resaleRows ?? 0).toLocaleString()}
                          </span>
                        </div>
                      </td>
                      
                      <td className="px-3 py-2 whitespace-nowrap text-right">
                        <div className="inline-flex flex-col items-end gap-1.5">
                          {/* Base markup */}
                          <span className={`font-bold text-xs px-2 py-0.5 rounded-full tabular-nums ${
                            (event.priceIncreasePercentage || 0) > 0
                              ? 'bg-rose-100 text-rose-700'
                              : (event.priceIncreasePercentage || 0) < 0
                                ? 'bg-blue-100 text-blue-700'
                                : 'bg-gray-100 text-gray-500'
                          }`}>
                            {(event.priceIncreasePercentage || 0) > 0 ? '+' : ''}{event.priceIncreasePercentage || 0}%
                          </span>
                          {/* S / R adjustments */}
                          {(() => {
                            const stdAdj = event.standardMarkupAdjustment ?? 0;
                            const resAdj = event.resaleMarkupAdjustment ?? 0;
                            const brkAdj = event.brokerMarkupAdjustment ?? 0;
                            return (
                              <div className="flex items-center gap-1">
                                <span className={`inline-flex items-center text-[10px] font-semibold px-1.5 py-0.5 rounded border tabular-nums ${
                                  stdAdj > 0 ? 'border-orange-200 bg-orange-50 text-orange-600'
                                  : stdAdj < 0 ? 'border-sky-200 bg-sky-50 text-sky-700'
                                  : 'border-gray-200 bg-white text-gray-400'
                                }`}>
                                  <span className="mr-0.5 opacity-50 text-[9px]">S</span>{stdAdj > 0 ? '+' : ''}{stdAdj}%
                                </span>
                                <span className={`inline-flex items-center text-[10px] font-semibold px-1.5 py-0.5 rounded border tabular-nums ${
                                  resAdj > 0 ? 'border-orange-200 bg-orange-50 text-orange-600'
                                  : resAdj < 0 ? 'border-sky-200 bg-sky-50 text-sky-700'
                                  : 'border-gray-200 bg-white text-gray-400'
                                }`}>
                                  <span className="mr-0.5 opacity-50 text-[9px]">R</span>{resAdj > 0 ? '+' : ''}{resAdj}%
                                </span>
                                <span className={`inline-flex items-center text-[10px] font-semibold px-1.5 py-0.5 rounded border tabular-nums ${
                                  brkAdj > 0 ? 'border-orange-200 bg-orange-50 text-orange-600'
                                  : brkAdj < 0 ? 'border-sky-200 bg-sky-50 text-sky-700'
                                  : 'border-gray-200 bg-white text-gray-400'
                                }`}>
                                  <span className="mr-0.5 opacity-50 text-[9px]">B</span>{brkAdj > 0 ? '+' : ''}{brkAdj}%
                                </span>
                              </div>
                            );
                          })()}
                        </div>
                      </td>

                      <td className="px-3 py-2 whitespace-nowrap text-center">
                        {lastUpdated ? (
                          <TimeAgo iso={lastUpdated} dateLabel={formatDate(lastUpdated)} />
                        ) : (
                          <span className="text-xs text-gray-400">Never</span>
                        )}
                      </td>
                      
                      <td className="px-3 py-2 whitespace-nowrap text-right">
                        <EventTableActions
                          eventId={event._id}
                          eventName={event.Event_Name}
                          isScrapingActive={isActive}
                        />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* Mobile/Tablet Card Layout */}
          <div className="md:hidden divide-y divide-gray-200">
            {events.map((event) => {
              const lastUpdated = event.Last_Updated || event.updatedAt;
              const fresh = lastUpdated
                ? Date.now() - new Date(lastUpdated).getTime() < 4 * 60 * 1000
                : false;
              const isActive = !event.Skip_Scraping;
              const stdIncluded = event.includeStandardSeats !== false;
              const resIncluded = event.includeResaleSeats !== false;

              return (
                <div
                  key={event._id}
                  className={`p-4 ${isActive && fresh ? 'bg-blue-50 border-l-4 border-blue-500' : 
                    isActive && !fresh ? 'bg-yellow-50 border-l-4 border-yellow-500' :
                    'bg-gray-50 border-l-4 border-gray-300 opacity-70'
                  }`}
                >
                  <div className="space-y-3">
                    {/* Header Row */}
                    <div className="flex items-start justify-between gap-2">
                      <div className="pt-1">
                        <BulkRowCheckbox eventId={event._id} eventName={event.Event_Name} />
                      </div>
                      <div className="flex-1 min-w-0">
                        <Link
                          href={`/dashboard/events/${event._id}`}
                          className="text-gray-900 hover:text-blue-600 font-semibold text-base transition-colors duration-200 block truncate"
                        >
                          {event.Event_Name}
                        </Link>
                        <div className="flex items-center gap-2 mt-1">
                          <StatusBadge isActive={isActive} />
                          <EventTypeBadge type={event.eventType} />
                        </div>
                      </div>
                      <EventTableActions
                        eventId={event._id}
                        eventName={event.Event_Name}
                        isScrapingActive={isActive}
                        compact
                      />
                    </div>

                    {/* Details Grid */}
                    <div className="grid grid-cols-2 gap-3 text-sm">
                      <div className="space-y-2">
                        <div className="flex items-center gap-2">
                          <Calendar size={14} className="text-gray-400" />
                          <div>
                            <div className="font-medium text-gray-900">{formatDate(event.Event_DateTime)}</div>
                            <div className="text-xs text-gray-500">{formatTime(event.Event_DateTime)}</div>
                          </div>
                        </div>
                        
                        {event.Venue && (
                          <div className="flex items-center gap-2">
                            <MapPin size={14} className="text-gray-400" />
                            <span className="text-gray-700 truncate">{event.Venue}</span>
                          </div>
                        )}
                      </div>
                      
                      <div className="space-y-2 text-right">
                        <div className="flex items-center justify-end gap-1">
                          <Users size={14} className="text-gray-400" />
                          <span className={`inline-flex items-center text-[11px] font-semibold px-1.5 py-0.5 rounded border tabular-nums ${
                            stdIncluded ? 'border-blue-200 bg-blue-50 text-blue-700' : 'border-slate-200 bg-slate-50 text-slate-400 line-through opacity-50'
                          }`}>
                            <span className="mr-0.5 opacity-50 text-[9px]">S</span>{(event.standardQty ?? 0).toLocaleString()}
                          </span>
                          <span className={`inline-flex items-center text-[11px] font-semibold px-1.5 py-0.5 rounded border tabular-nums ${
                            resIncluded ? 'border-red-200 bg-red-50 text-red-700' : 'border-slate-200 bg-slate-50 text-slate-400 line-through opacity-50'
                          }`}>
                            <span className="mr-0.5 opacity-50 text-[9px]">R</span>{(event.resaleQty ?? 0).toLocaleString()}
                          </span>
                        </div>
                        <div className="flex items-center justify-end gap-1">
                          <span className="text-[10px] text-gray-400 mr-0.5">rows</span>
                          <span className={`inline-flex items-center text-[11px] font-semibold px-1.5 py-0.5 rounded border tabular-nums ${
                            stdIncluded ? 'border-blue-200 bg-blue-50 text-blue-700' : 'border-slate-200 bg-slate-50 text-slate-400 line-through opacity-50'
                          }`}>
                            <span className="mr-0.5 opacity-50 text-[9px]">S</span>{(event.standardRows ?? 0).toLocaleString()}
                          </span>
                          <span className={`inline-flex items-center text-[11px] font-semibold px-1.5 py-0.5 rounded border tabular-nums ${
                            resIncluded ? 'border-red-200 bg-red-50 text-red-700' : 'border-slate-200 bg-slate-50 text-slate-400 line-through opacity-50'
                          }`}>
                            <span className="mr-0.5 opacity-50 text-[9px]">R</span>{(event.resaleRows ?? 0).toLocaleString()}
                          </span>
                        </div>
                        
                        <div className="flex flex-col items-end gap-1.5">
                          <div className="flex items-center justify-end gap-2">
                            <TrendingUp size={14} className="text-gray-400" />
                            <span className={`font-bold text-xs px-2 py-0.5 rounded-full tabular-nums ${
                              (event.priceIncreasePercentage || 0) > 0
                                ? 'bg-rose-100 text-rose-700'
                                : (event.priceIncreasePercentage || 0) < 0
                                  ? 'bg-blue-100 text-blue-700'
                                  : 'bg-gray-100 text-gray-500'
                            }`}>
                              {(event.priceIncreasePercentage || 0) > 0 ? '+' : ''}{event.priceIncreasePercentage || 0}%
                            </span>
                          </div>
                          {(() => {
                            const stdAdj = event.standardMarkupAdjustment ?? 0;
                            const resAdj = event.resaleMarkupAdjustment ?? 0;
                            const brkAdj = event.brokerMarkupAdjustment ?? 0;
                            return (
                              <div className="flex items-center gap-1">
                                <span className={`inline-flex items-center text-[10px] font-semibold px-1.5 py-0.5 rounded border tabular-nums ${
                                  stdAdj > 0 ? 'border-orange-200 bg-orange-50 text-orange-600'
                                  : stdAdj < 0 ? 'border-sky-200 bg-sky-50 text-sky-700'
                                  : 'border-gray-200 bg-white text-gray-400'
                                }`}>
                                  <span className="mr-0.5 opacity-50 text-[9px]">S</span>{stdAdj > 0 ? '+' : ''}{stdAdj}%
                                </span>
                                <span className={`inline-flex items-center text-[10px] font-semibold px-1.5 py-0.5 rounded border tabular-nums ${
                                  resAdj > 0 ? 'border-orange-200 bg-orange-50 text-orange-600'
                                  : resAdj < 0 ? 'border-sky-200 bg-sky-50 text-sky-700'
                                  : 'border-gray-200 bg-white text-gray-400'
                                }`}>
                                  <span className="mr-0.5 opacity-50 text-[9px]">R</span>{resAdj > 0 ? '+' : ''}{resAdj}%
                                </span>
                                <span className={`inline-flex items-center text-[10px] font-semibold px-1.5 py-0.5 rounded border tabular-nums ${
                                  brkAdj > 0 ? 'border-orange-200 bg-orange-50 text-orange-600'
                                  : brkAdj < 0 ? 'border-sky-200 bg-sky-50 text-sky-700'
                                  : 'border-gray-200 bg-white text-gray-400'
                                }`}>
                                  <span className="mr-0.5 opacity-50 text-[9px]">B</span>{brkAdj > 0 ? '+' : ''}{brkAdj}%
                                </span>
                              </div>
                            );
                          })()}
                        </div>
                      </div>
                    </div>

                    {/* Footer */}
                    <div className="flex items-center justify-between text-xs text-gray-500 pt-2 border-t border-gray-200">
                      <div className="flex items-center gap-1">
                        <Clock size={12} />
                        <span>ID: {event.mapping_id || '—'}</span>
                      </div>
                      <div className={`font-medium ${
                        fresh ? 'text-blue-700' : 'text-yellow-700'
                      }`}>
                        {lastUpdated ? (
                          <TimeAgo iso={lastUpdated} dateLabel={formatDate(lastUpdated)} />
                        ) : 'Never'}
                      </div>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Pagination - Bottom of table */}
      {totalPages > 1 && (
        <div className="bg-white rounded-xl shadow-sm border border-gray-200 px-4 py-3">
          <div className="flex flex-col sm:flex-row items-center justify-between gap-3">
            <div className="text-xs text-gray-500">
              Page <span className="font-semibold text-gray-700">{page}</span> of{' '}
              <span className="font-semibold text-gray-700">{totalPages}</span>
              {' '}·{' '}
              <span className="font-semibold text-gray-700">{total}</span> total events
            </div>
            <PaginationControls currentPage={page} totalPages={totalPages} />
          </div>
        </div>
      )}
    </div>
    </BulkSelectionProvider>
  );
}