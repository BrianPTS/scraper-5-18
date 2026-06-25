'use client';

import React, { createContext, useCallback, useContext, useMemo, useState, useTransition, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { useRouter } from 'next/navigation';
import { Play, Square, Trash2, X, Tag, Loader2 } from 'lucide-react';
import { updateEvent, deleteEvent } from '@/actions/eventActions';

/* ----- Types ----- */
export type EventTypeValue = 'NFL' | 'MLB' | 'NHL' | 'NBA' | 'MLS' | 'Other' | '';

export interface BulkEventMeta {
  id: string;
  name: string;
  active: boolean;
}

interface Ctx {
  pageIds: string[];
  pageMeta: Record<string, BulkEventMeta>;
  selected: Set<string>;
  toggle: (id: string) => void;
  toggleAll: () => void;
  clear: () => void;
  isAllSelected: boolean;
  isSomeSelected: boolean;
}

const BulkSelectionContext = createContext<Ctx | null>(null);

/* ----- Provider ----- */
export function BulkSelectionProvider({
  pageEvents,
  children,
}: {
  pageEvents: BulkEventMeta[];
  children: React.ReactNode;
}) {
  const pageIds = useMemo(() => pageEvents.map(e => e.id), [pageEvents]);
  const pageMeta = useMemo(() => {
    const m: Record<string, BulkEventMeta> = {};
    pageEvents.forEach(e => { m[e.id] = e; });
    return m;
  }, [pageEvents]);

  const [selected, setSelected] = useState<Set<string>>(new Set());

  // Drop selections that left the page (pagination, filter change)
  useEffect(() => {
    setSelected(prev => {
      const next = new Set<string>();
      prev.forEach(id => { if (pageMeta[id]) next.add(id); });
      return next.size === prev.size ? prev : next;
    });
  }, [pageMeta]);

  const toggle = useCallback((id: string) => {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);

  const isAllSelected = pageIds.length > 0 && pageIds.every(id => selected.has(id));
  const isSomeSelected = selected.size > 0 && !isAllSelected;

  const toggleAll = useCallback(() => {
    setSelected(prev => {
      if (pageIds.length > 0 && pageIds.every(id => prev.has(id))) return new Set();
      return new Set(pageIds);
    });
  }, [pageIds]);

  const clear = useCallback(() => setSelected(new Set()), []);

  const value: Ctx = { pageIds, pageMeta, selected, toggle, toggleAll, clear, isAllSelected, isSomeSelected };
  return <BulkSelectionContext.Provider value={value}>{children}</BulkSelectionContext.Provider>;
}

function useBulk(): Ctx {
  const ctx = useContext(BulkSelectionContext);
  if (!ctx) throw new Error('BulkSelection components must be inside <BulkSelectionProvider>');
  return ctx;
}

/* ----- Row checkbox ----- */
export function BulkRowCheckbox({ eventId, eventName }: { eventId: string; eventName: string }) {
  const { selected, toggle } = useBulk();
  const checked = selected.has(eventId);
  return (
    <input
      type="checkbox"
      checked={checked}
      onChange={() => toggle(eventId)}
      aria-label={`Select ${eventName}`}
      className="h-4 w-4 cursor-pointer rounded border-gray-300 text-blue-600 focus:ring-blue-500"
      onClick={e => e.stopPropagation()}
    />
  );
}

/* ----- Select-all header checkbox ----- */
export function BulkSelectAllCheckbox() {
  const { isAllSelected, isSomeSelected, toggleAll, pageIds } = useBulk();
  const ref = React.useRef<HTMLInputElement | null>(null);
  useEffect(() => { if (ref.current) ref.current.indeterminate = isSomeSelected; }, [isSomeSelected]);
  return (
    <input
      ref={ref}
      type="checkbox"
      checked={isAllSelected}
      onChange={toggleAll}
      disabled={pageIds.length === 0}
      aria-label="Select all events on this page"
      className="h-4 w-4 cursor-pointer rounded border-gray-300 text-blue-600 focus:ring-blue-500 disabled:opacity-50"
    />
  );
}

/* ----- Bulk action bar ----- */
export function BulkActionBar() {
  const router = useRouter();
  const { selected, pageMeta, clear } = useBulk();
  const [isPending, startTransition] = useTransition();
  const [busy, setBusy] = useState<null | 'start' | 'stop' | 'delete' | 'type'>(null);
  const [eventType, setEventType] = useState<EventTypeValue>('');
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const count = selected.size;
  if (count === 0) return null;

  const ids = Array.from(selected);

  const runStart = () => {
    setBusy('start');
    startTransition(async () => {
      try {
        for (const id of ids) {
          await updateEvent(id, { Skip_Scraping: false });
        }
        clear();
        router.refresh();
      } catch (err) {
        console.error('Bulk start failed:', err);
      } finally {
        setBusy(null);
      }
    });
  };

  const runStop = () => {
    setBusy('stop');
    startTransition(async () => {
      try {
        for (const id of ids) {
          await updateEvent(id, { Skip_Scraping: true }, true);
        }
        clear();
        router.refresh();
      } catch (err) {
        console.error('Bulk stop failed:', err);
      } finally {
        setBusy(null);
      }
    });
  };

  const runDelete = () => {
    setBusy('delete');
    startTransition(async () => {
      try {
        for (const id of ids) {
          await deleteEvent(id);
        }
        clear();
        setShowDeleteConfirm(false);
        router.refresh();
      } catch (err) {
        console.error('Bulk delete failed:', err);
      } finally {
        setBusy(null);
      }
    });
  };

  const runSetType = () => {
    if (!eventType) return;
    setBusy('type');
    startTransition(async () => {
      try {
        for (const id of ids) {
          await updateEvent(id, { eventType } as Parameters<typeof updateEvent>[1]);
        }
        clear();
        setEventType('');
        router.refresh();
      } catch (err) {
        console.error('Bulk set-type failed:', err);
      } finally {
        setBusy(null);
      }
    });
  };

  const allActive = ids.every(id => pageMeta[id]?.active);
  const allInactive = ids.every(id => !pageMeta[id]?.active);

  return (
    <>
      <div className="sticky top-2 z-20 mb-2">
        <div className="bg-white border border-blue-300 shadow-md rounded-xl px-3 py-2 flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-2 pr-2 border-r border-gray-200">
            <span className="inline-flex items-center justify-center min-w-7 h-7 rounded-full bg-blue-600 text-white text-xs font-bold px-2">{count}</span>
            <span className="text-sm font-semibold text-gray-700">selected</span>
            <button
              onClick={clear}
              className="ml-1 p-1 text-gray-400 hover:text-gray-600 rounded-md hover:bg-gray-100"
              aria-label="Clear selection"
            >
              <X size={14} />
            </button>
          </div>

          <button
            onClick={runStart}
            disabled={isPending || allActive}
            title={allActive ? 'All selected events are already active' : 'Start scraping selected events'}
            className="inline-flex items-center gap-1 px-3 py-1.5 rounded-md text-xs font-semibold bg-gradient-to-r from-blue-500 to-purple-600 text-white hover:from-blue-600 hover:to-purple-700 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {busy === 'start' ? <Loader2 size={12} className="animate-spin" /> : <Play size={12} />}
            Start
          </button>

          <button
            onClick={runStop}
            disabled={isPending || allInactive}
            title={allInactive ? 'All selected events are already inactive' : 'Stop scraping selected events'}
            className="inline-flex items-center gap-1 px-3 py-1.5 rounded-md text-xs font-semibold bg-red-600 text-white hover:bg-red-700 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {busy === 'stop' ? <Loader2 size={12} className="animate-spin" /> : <Square size={12} />}
            Stop
          </button>

          <button
            onClick={() => setShowDeleteConfirm(true)}
            disabled={isPending}
            className="inline-flex items-center gap-1 px-3 py-1.5 rounded-md text-xs font-semibold border border-red-300 text-red-700 bg-white hover:bg-red-50 disabled:opacity-50"
          >
            <Trash2 size={12} />
            Delete
          </button>

          <div className="flex items-center gap-1.5 ml-1 pl-2 border-l border-gray-200">
            <Tag size={12} className="text-gray-400" />
            <select
              value={eventType}
              onChange={e => setEventType(e.target.value as EventTypeValue)}
              disabled={isPending}
              className="px-2 py-1 border border-gray-300 rounded-md text-xs bg-white focus:ring-2 focus:ring-blue-500 focus:border-transparent disabled:opacity-50"
            >
              <option value="">Event type…</option>
              <option value="NFL">NFL</option>
              <option value="MLB">MLB</option>
              <option value="NHL">NHL</option>
              <option value="NBA">NBA</option>
              <option value="MLS">MLS</option>
              <option value="Other">Other</option>
            </select>
            <button
              onClick={runSetType}
              disabled={isPending || !eventType}
              className="inline-flex items-center gap-1 px-3 py-1.5 rounded-md text-xs font-semibold bg-purple-600 text-white hover:bg-purple-700 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {busy === 'type' ? <Loader2 size={12} className="animate-spin" /> : null}
              Apply
            </button>
          </div>
        </div>
      </div>

      {showDeleteConfirm && mounted && createPortal(
        <div className="fixed inset-0 z-[9999] flex items-center justify-center p-4" role="dialog" aria-modal="true">
          <div className="absolute inset-0 bg-black/60 backdrop-blur-[2px]" onClick={() => !isPending && setShowDeleteConfirm(false)} />
          <div className="relative bg-white rounded-2xl shadow-2xl w-full max-w-md ring-1 ring-black/10 p-6">
            <button
              onClick={() => setShowDeleteConfirm(false)}
              disabled={isPending}
              className="absolute top-4 right-4 p-1 text-gray-400 hover:text-gray-600 rounded-lg hover:bg-gray-100 disabled:opacity-40"
              aria-label="Close"
            >
              <X size={16} />
            </button>
            <div className="w-12 h-12 rounded-full bg-red-100 flex items-center justify-center mb-4">
              <Trash2 size={22} className="text-red-600" />
            </div>
            <h3 className="text-lg font-bold text-gray-900 mb-2">Delete {count} event{count === 1 ? '' : 's'}?</h3>
            <p className="text-gray-500 text-sm mb-6 leading-relaxed">
              This will delete the selected event{count === 1 ? '' : 's'} and all associated seat inventory data. This action cannot be undone.
            </p>
            <div className="flex gap-3 justify-end">
              <button
                onClick={() => setShowDeleteConfirm(false)}
                disabled={isPending}
                className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                onClick={runDelete}
                disabled={isPending}
                className="px-4 py-2 text-sm font-medium bg-red-600 text-white rounded-lg hover:bg-red-700 disabled:opacity-50 flex items-center gap-2"
              >
                {isPending ? <Loader2 size={14} className="animate-spin" /> : <Trash2 size={14} />}
                Delete {count}
              </button>
            </div>
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}
