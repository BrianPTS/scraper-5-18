'use client';
import React, { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import {
  ChevronLeft, Save, Trash2, Plus, Filter,
  Ticket, ExternalLink, MapPin, Calendar,
  TrendingDown, ChevronDown, ChevronUp
} from 'lucide-react';
import {
  getExclusionRules,
  saveExclusionRules,
  getEventSectionsAndRows,
  getOutlierAnalysis,
  SectionRowExclusion,
  ExclusionRulesData,
  OutlierAnalysis,
} from '@/actions/exclusionActions';
import { useNotifications } from '@/components/providers/NotificationProvider';
import { LoadingState, AsyncButton } from '@/components/ui/LoadingStates';

interface ExclusionPageProps {
  eventId: string;
  eventName: string;
  eventUrl?: string;
  eventVenue?: string;
  eventDate?: string;
}

interface SectionData {
  section: string;
  rows: string[];
  totalListings: number;
  avgPrice: number;
}

type PageState = 'loading' | 'ready' | 'saving' | 'error';

function fmt(date: string, opts: Intl.DateTimeFormatOptions) {
  return new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', ...opts }).format(new Date(date));
}

export default function ExclusionManagementPage({
  eventId,
  eventName,
  eventUrl,
  eventVenue,
  eventDate,
}: ExclusionPageProps) {
  const [pageState, setPageState] = useState<PageState>('loading');
  const [sections, setSections] = useState<SectionData[]>([]);
  const [sectionRowExclusions, setSectionRowExclusions] = useState<SectionRowExclusion[]>([]);
  const [outliers, setOutliers] = useState<OutlierAnalysis | null>(null);
  const [dominatedListingsEnabled, setDominatedListingsEnabled] = useState<boolean>(false);
  const { actions: notificationActions } = useNotifications();

  const loadData = useCallback(async () => {
    setPageState('loading');
    try {
      const [rulesResult, sectionsResult, outlierResult] = await Promise.all([
        getExclusionRules(eventId),
        getEventSectionsAndRows(eventId),
        getOutlierAnalysis(eventId),
      ]);

      if (sectionsResult.success && sectionsResult.data) {
        setSections(sectionsResult.data);
      }

      if (rulesResult.success && rulesResult.data) {
        const data = Array.isArray(rulesResult.data) ? rulesResult.data[0] : rulesResult.data;
        setSectionRowExclusions(data?.sectionRowExclusions || []);
        setDominatedListingsEnabled(!!data?.dominatedListings?.enabled);
      }

      if (outlierResult.success && outlierResult.data) {
        setOutliers(outlierResult.data);
      }

      setPageState('ready');
    } catch (error) {
      console.error('Error loading data:', error);
      notificationActions.showNotification('error', 'Failed to load exclusion data');
      setPageState('error');
    }
  }, [eventId, notificationActions]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const handleSave = async () => {
    setPageState('saving');
    try {
      const rulesData: ExclusionRulesData = {
        eventId,
        eventName,
        sectionRowExclusions,
        dominatedListings: { enabled: dominatedListingsEnabled },
        isActive: true
      };
      const result = await saveExclusionRules(rulesData);
      if (result.success) {
        notificationActions.showNotification('success', 'Exclusion rules saved successfully');
      } else {
        notificationActions.showNotification('error', result.error || 'Failed to save exclusion rules');
      }
      setPageState('ready');
    } catch (error) {
      console.error('Error saving rules:', error);
      notificationActions.showNotification('error', 'Failed to save exclusion rules');
      setPageState('ready');
    }
  };

  const addSectionExclusion = () => {
    setSectionRowExclusions([
      ...sectionRowExclusions,
      { section: '', excludeEntireSection: false, excludedRows: [] }
    ]);
  };

  const removeSectionExclusion = (index: number) => {
    setSectionRowExclusions(sectionRowExclusions.filter((_, i) => i !== index));
  };

  const updateSectionExclusion = (index: number, updates: Partial<SectionRowExclusion>) => {
    setSectionRowExclusions(sectionRowExclusions.map((exclusion, i) =>
      i === index ? { ...exclusion, ...updates } : exclusion
    ));
  };

  const toggleRowExclusion = (sectionIndex: number, row: string) => {
    const exclusion = sectionRowExclusions[sectionIndex];
    const isExcluded = exclusion.excludedRows.includes(row);
    const newExcludedRows = isExcluded
      ? exclusion.excludedRows.filter(r => r !== row)
      : [...exclusion.excludedRows, row];
    updateSectionExclusion(sectionIndex, { excludedRows: newExcludedRows });
  };

  if (pageState === 'loading') {
    return <LoadingState.Loading message="Loading exclusion settings..." />;
  }

  const assignedCount = sectionRowExclusions.filter(e => e.section).length;
  const allAssigned = assignedCount >= sections.length && sections.length > 0;

  return (
    <div className="space-y-5">

      {/* ── Breadcrumb + Actions ── */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <Link
          href={`/dashboard/events/${eventId}`}
          className="inline-flex items-center gap-1.5 text-sm font-medium text-slate-500 hover:text-blue-600 transition-colors"
        >
          <ChevronLeft size={15} />
          Back to Event
        </Link>
        <div className="flex items-center gap-2 flex-wrap">
          {eventUrl && (
            <a
              href={eventUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-semibold bg-blue-600 hover:bg-blue-700 text-white transition-colors shadow-sm"
            >
              <Ticket size={13} />
              Ticketmaster
              <ExternalLink size={10} />
            </a>
          )}
          {pageState === 'saving' ? (
            <LoadingState.Saving message="Saving..." />
          ) : (
            <AsyncButton.Root onClick={handleSave} disabled={pageState !== 'ready'}>
              <AsyncButton.Icon><Save size={14} /></AsyncButton.Icon>
              <AsyncButton.Text>Save Rules</AsyncButton.Text>
            </AsyncButton.Root>
          )}
        </div>
      </div>

      {/* ── Header Card ── */}
      <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
        <div className="bg-gradient-to-r from-purple-600 to-indigo-600 px-6 py-5 relative overflow-hidden">
          <div className="absolute inset-0 bg-black/10" />
          <div className="relative">
            <div className="flex items-center gap-2 mb-1.5">
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-bold bg-white/10 text-purple-100 border border-white/20">
                <Filter size={10} />
                Exclusion Rules
              </span>
            </div>
            <h1 className="text-xl font-bold text-white leading-tight">{eventName}</h1>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 mt-1.5 text-sm text-purple-100">
              {eventVenue && (
                <span className="flex items-center gap-1.5">
                  <MapPin size={12} className="text-purple-200" />
                  {eventVenue}
                </span>
              )}
              {eventDate && (
                <span className="flex items-center gap-1.5">
                  <Calendar size={12} className="text-purple-200" />
                  {fmt(eventDate, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })}
                  <span className="text-purple-300">·</span>
                  {fmt(eventDate, { hour: '2-digit', minute: '2-digit' })}
                </span>
              )}
            </div>
          </div>
        </div>

        {/* Stats strip */}
        <div className="grid grid-cols-3 bg-slate-50/80 border-t border-slate-100 divide-x divide-slate-100">
          <div className="px-4 py-3">
            <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1">Sections Available</p>
            <p className="text-xl font-bold tabular-nums text-slate-700">{sections.length}</p>
          </div>
          <div className="px-4 py-3">
            <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1">Rules Configured</p>
            <p className="text-xl font-bold tabular-nums text-purple-600">{assignedCount}</p>
          </div>
          <div className="px-4 py-3">
            <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1">Entire Sections</p>
            <p className="text-xl font-bold tabular-nums text-red-600">
              {sectionRowExclusions.filter(e => e.excludeEntireSection).length}
            </p>
          </div>
        </div>
      </div>

      {/* ── Dominated-Listings Rule (per-event toggle) ── */}
      <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
        <div className="px-5 py-3.5 border-b border-slate-100 flex items-center gap-2">
          <span className="w-6 h-6 rounded-md bg-emerald-50 flex items-center justify-center">
            <TrendingDown size={12} className="text-emerald-600" />
          </span>
          <h2 className="text-sm font-bold text-slate-700">Dominated-Listings Rule</h2>
          <span className="ml-auto text-[11px] text-slate-400 font-medium">
            Drops higher rows priced ≥ a lower row in the same (section, qty, split)
          </span>
        </div>
        <div className="p-5">
          <label className="flex items-start gap-3 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={dominatedListingsEnabled}
              onChange={(e) => setDominatedListingsEnabled(e.target.checked)}
              className="mt-1 w-4 h-4 accent-emerald-600"
            />
            <span className="text-sm text-slate-700">
              <span className="font-semibold">Enable dominated-listings exclusion for this event.</span>
              <br />
              <span className="text-xs text-slate-500 leading-relaxed">
                When on, the CSV emitter groups this event&apos;s inventory by (section, quantity, custom_split),
                sorts by row proximity to field, and drops any listing whose per-seat list_price is
                ≥ a lower row&apos;s per-seat price. GA / parking / lawn rows (no row rank) are never affected.
                Runs on non-streaming CSV generation only.
              </span>
            </span>
          </label>
        </div>
      </div>

      {/* ── Section & Row Exclusions ── */}
      <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
        <div className="px-5 py-3.5 border-b border-slate-100 flex items-center gap-2">
          <span className="w-6 h-6 rounded-md bg-purple-50 flex items-center justify-center">
            <Filter size={12} className="text-purple-500" />
          </span>
          <h2 className="text-sm font-bold text-slate-700">Section &amp; Row Exclusions</h2>
          <span className="ml-auto text-[11px] text-slate-400 font-medium">
            Excludes sections or rows from CSV generation
          </span>
        </div>

        <div className="p-5 space-y-4">
          {sectionRowExclusions.length === 0 && (
            <p className="text-sm text-slate-400 text-center py-6">
              No exclusion rules configured. Add a rule below.
            </p>
          )}

          {sectionRowExclusions.map((exclusion, index) => (
            <div
              key={index}
              className="border border-slate-200 rounded-xl overflow-hidden"
            >
              {/* Rule header */}
              <div className="flex items-center justify-between px-4 py-2.5 bg-slate-50 border-b border-slate-200">
                <span className="text-xs font-bold text-slate-500 uppercase tracking-widest">
                  Rule {index + 1}
                  {exclusion.section && (
                    <span className="ml-2 text-slate-700 normal-case font-semibold">— {exclusion.section}</span>
                  )}
                </span>
                <button
                  onClick={() => removeSectionExclusion(index)}
                  className="p-1.5 text-slate-400 hover:text-red-600 hover:bg-red-50 rounded-lg transition-colors"
                >
                  <Trash2 size={14} />
                </button>
              </div>

              {/* Rule body */}
              <div className="p-4 space-y-4">
                {/* Section select */}
                <div>
                  <label className="block text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1.5">
                    Section
                  </label>
                  <select
                    value={exclusion.section}
                    onChange={(e) => updateSectionExclusion(index, {
                      section: e.target.value,
                      excludedRows: []
                    })}
                    className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg focus:ring-2 focus:ring-purple-500 focus:border-transparent bg-white font-medium text-slate-700"
                  >
                    <option value="">Select a section…</option>
                    {sections
                      .filter(s =>
                        s.section === exclusion.section ||
                        !sectionRowExclusions.some((other, otherIdx) => otherIdx !== index && other.section === s.section)
                      )
                      .map(s => (
                        <option key={s.section} value={s.section}>
                          {s.section} — {s.totalListings} listing{s.totalListings !== 1 ? 's' : ''}
                          {s.avgPrice ? ` · avg $${s.avgPrice}` : ''}
                        </option>
                      ))}
                  </select>
                </div>

                {/* Exclude entire section toggle */}
                <label className="flex items-center gap-3 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={exclusion.excludeEntireSection}
                    onChange={(e) => updateSectionExclusion(index, {
                      excludeEntireSection: e.target.checked,
                      excludedRows: e.target.checked ? [] : exclusion.excludedRows
                    })}
                    className="w-4 h-4 text-purple-600 border-slate-300 rounded focus:ring-purple-500"
                  />
                  <span className="text-sm font-medium text-slate-700">Exclude entire section</span>
                  {exclusion.excludeEntireSection && (
                    <span className="text-[11px] font-bold px-2 py-0.5 rounded-full bg-red-50 text-red-600 border border-red-200">
                      All rows excluded
                    </span>
                  )}
                </label>

                {/* Row picker */}
                {!exclusion.excludeEntireSection && exclusion.section && (() => {
                  const sectionData = sections.find(s => s.section === exclusion.section);
                  return sectionData && sectionData.rows.length > 0 ? (
                    <div>
                      <div className="flex items-center justify-between mb-2">
                        <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">
                          Rows to Exclude
                        </label>
                        <span className="text-[11px] text-slate-500 font-medium">
                          {exclusion.excludedRows.length} / {sectionData.rows.length} selected
                        </span>
                      </div>
                      <div className="grid grid-cols-6 sm:grid-cols-8 gap-1.5 max-h-36 overflow-y-auto bg-slate-50 rounded-lg border border-slate-200 p-3">
                        {sectionData.rows.map(row => (
                          <button
                            key={row}
                            onClick={() => toggleRowExclusion(index, row)}
                            className={`px-2 py-1.5 text-xs rounded-md border font-semibold transition-all ${
                              exclusion.excludedRows.includes(row)
                                ? 'bg-red-100 border-red-300 text-red-700 hover:bg-red-200'
                                : 'bg-white border-slate-200 text-slate-600 hover:border-purple-300 hover:text-purple-700 hover:bg-purple-50'
                            }`}
                          >
                            {row}
                          </button>
                        ))}
                      </div>
                    </div>
                  ) : null;
                })()}
              </div>
            </div>
          ))}

          {/* Add rule button */}
          <button
            onClick={addSectionExclusion}
            disabled={allAssigned}
            className="flex items-center justify-center gap-2 w-full py-3 border-2 border-dashed border-slate-200 rounded-xl text-sm font-semibold text-slate-500 hover:border-purple-400 hover:text-purple-600 hover:bg-purple-50/50 transition-all disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:border-slate-200 disabled:hover:text-slate-500 disabled:hover:bg-transparent"
          >
            <Plus size={16} />
            {allAssigned ? 'All sections assigned' : 'Add Exclusion Rule'}
          </button>
        </div>
      </div>

      {/* ── Outlier Detection ── */}
      {outliers && (outliers.standard.totalListings > 0 || outliers.resale.totalListings > 0) && (
        <OutlierPanel outliers={outliers} />
      )}
    </div>
  );
}

// ── Outlier Panel ─────────────────────────────────────────────────────────────

function OutlierPanel({ outliers }: { outliers: OutlierAnalysis }) {
  const [stdExpanded, setStdExpanded] = useState(true);
  const [resExpanded, setResExpanded] = useState(true);

  return (
    <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
      <div className="px-5 py-3.5 border-b border-slate-100 flex items-center gap-2">
        <span className="w-6 h-6 rounded-md bg-orange-50 flex items-center justify-center">
          <TrendingDown size={12} className="text-orange-500" />
        </span>
        <h2 className="text-sm font-bold text-slate-700">Outlier Detection</h2>
        <span className="ml-auto text-[11px] text-slate-400 font-medium">
          Listings priced below the average — review before excluding
        </span>
      </div>

      <div className="p-5 space-y-4">
        {/* Standard */}
        {outliers.standard.totalListings > 0 && (
          <OutlierSection
            label="Standard"
            badgeClass="bg-blue-50 text-blue-700 border-blue-200"
            avgPrice={outliers.standard.avgPrice}
            totalListings={outliers.standard.totalListings}
            outliers={outliers.standard.outliers}
            expanded={stdExpanded}
            onToggle={() => setStdExpanded(v => !v)}
          />
        )}

        {/* Resale */}
        {outliers.resale.totalListings > 0 && (
          <OutlierSection
            label="Resale"
            badgeClass="bg-red-50 text-red-700 border-red-200"
            avgPrice={outliers.resale.avgPrice}
            totalListings={outliers.resale.totalListings}
            outliers={outliers.resale.outliers}
            expanded={resExpanded}
            onToggle={() => setResExpanded(v => !v)}
          />
        )}
      </div>
    </div>
  );
}

interface OutlierSectionProps {
  label: string;
  badgeClass: string;
  avgPrice: number;
  totalListings: number;
  outliers: OutlierAnalysis['standard']['outliers'];
  expanded: boolean;
  onToggle: () => void;
}

function OutlierSection({ label, badgeClass, avgPrice, totalListings, outliers, expanded, onToggle }: OutlierSectionProps) {
  const highOutliers  = outliers.filter(o => o.deviationPct >= 30);
  const medOutliers   = outliers.filter(o => o.deviationPct >= 15 && o.deviationPct < 30);
  const lowOutliers   = outliers.filter(o => o.deviationPct < 15);

  return (
    <div className="border border-slate-200 rounded-xl overflow-hidden">
      {/* Section header */}
      <button
        onClick={onToggle}
        className="w-full flex items-center gap-3 px-4 py-3 bg-slate-50 hover:bg-slate-100 transition-colors text-left"
      >
        <span className={`text-[11px] font-bold px-2 py-0.5 rounded border ${badgeClass}`}>{label}</span>
        <div className="flex items-center gap-4 flex-1 min-w-0">
          <span className="text-xs font-medium text-slate-600">
            Avg price: <strong className="text-slate-800">${avgPrice.toFixed(2)}</strong>
          </span>
          <span className="text-xs text-slate-500">
            {totalListings} total listings
          </span>
          <span className={`text-xs font-semibold ${outliers.length > 0 ? 'text-orange-600' : 'text-green-600'}`}>
            {outliers.length} below avg
          </span>
        </div>
        {expanded ? <ChevronUp size={14} className="text-slate-400 shrink-0" /> : <ChevronDown size={14} className="text-slate-400 shrink-0" />}
      </button>

      {expanded && outliers.length > 0 && (
        <div className="divide-y divide-slate-100">
          {/* Table header */}
          <div className="grid grid-cols-[1fr_80px_80px_70px_80px] gap-2 px-4 py-2 bg-white border-b border-slate-100">
            <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">Section / Row</p>
            <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest text-right">List Price</p>
            <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest text-right">Sect Avg</p>
            <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest text-right">Below</p>
            <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest text-center">Severity</p>
          </div>

          <div className="max-h-72 overflow-y-auto">
            {outliers.map((o, i) => {
              const isHigh = o.deviationPct >= 30;
              const isMed  = o.deviationPct >= 15 && o.deviationPct < 30;
              return (
                <div
                  key={i}
                  className={`grid grid-cols-[1fr_80px_80px_70px_80px] gap-2 px-4 py-2.5 items-center text-xs transition-colors ${
                    isHigh ? 'bg-red-50/40 hover:bg-red-50' : isMed ? 'bg-orange-50/30 hover:bg-orange-50/60' : 'hover:bg-slate-50'
                  }`}
                >
                  <div className="min-w-0">
                    <span className="font-semibold text-slate-800">{o.section}</span>
                    <span className="text-slate-400 mx-1">·</span>
                    <span className="text-slate-600">Row {o.row}</span>
                  </div>
                  <p className="text-right font-bold tabular-nums text-slate-700">${o.listPrice.toFixed(2)}</p>
                  <p className="text-right tabular-nums text-slate-500">${o.sectionAvgPrice.toFixed(2)}</p>
                  <p className={`text-right font-bold tabular-nums ${isHigh ? 'text-red-600' : isMed ? 'text-orange-600' : 'text-slate-500'}`}>
                    -{o.deviationPct}%
                  </p>
                  <div className="flex justify-center">
                    <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded-full border ${
                      isHigh ? 'bg-red-100 text-red-700 border-red-200' :
                      isMed  ? 'bg-orange-100 text-orange-700 border-orange-200' :
                               'bg-slate-100 text-slate-500 border-slate-200'
                    }`}>
                      {isHigh ? 'High' : isMed ? 'Med' : 'Low'}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>

          {/* Summary bar */}
          <div className="px-4 py-2.5 bg-slate-50 flex items-center gap-4 text-[11px] font-medium text-slate-500">
            {highOutliers.length > 0 && (
              <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-red-500" />{highOutliers.length} high (&gt;30% below)</span>
            )}
            {medOutliers.length > 0 && (
              <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-orange-400" />{medOutliers.length} medium (15–30%)</span>
            )}
            {lowOutliers.length > 0 && (
              <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-slate-300" />{lowOutliers.length} low (&lt;15%)</span>
            )}
          </div>
        </div>
      )}

      {expanded && outliers.length === 0 && (
        <div className="px-4 py-4 text-center text-xs text-slate-400">
          All listings are at or above the average price of ${avgPrice.toFixed(2)}
        </div>
      )}
    </div>
  );
}
