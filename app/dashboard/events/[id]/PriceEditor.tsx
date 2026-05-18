'use client';

import React, { useState, useTransition, useRef, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { TrendingUp, Check, Minus, Plus } from 'lucide-react';
import { updateEvent } from '@/actions/eventActions';

interface Props {
  eventId: string;
  initialPct: number;
  initialStandardAdj?: number;
  initialResaleAdj?: number;
  initialBrokerAdj?: number;
}

const PRESETS = [0, 5, 10, 15, 20, 25, 30, 40, 50];
type SaveState = 'idle' | 'saving' | 'saved' | 'error';

function AdjRow({
  label,
  adj,
  defaultPct,
  onChange,
  disabled,
}: {
  label: string;
  adj: number;
  defaultPct: number;
  onChange: (v: number) => void;
  disabled?: boolean;
}) {
  const effective = defaultPct + adj;
  const adjColor = adj > 0 ? 'text-red-600 font-bold' : adj < 0 ? 'text-blue-600 font-bold' : 'text-slate-400';
  const effColor = effective > 0 ? 'text-red-600' : effective < 0 ? 'text-blue-600' : 'text-slate-500';
  return (
    <div className="flex items-center justify-between gap-3 py-2">
      <div className="min-w-0">
        <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide">{label}</p>
        <p className="text-[11px] text-slate-400">Effective: <span className={effColor}>{effective > 0 ? '+' : ''}{effective}%</span></p>
      </div>
      <div className="flex items-center gap-1.5 shrink-0">
        <button type="button" onClick={() => onChange(adj - 1)} disabled={disabled}
          className="w-7 h-7 flex items-center justify-center rounded-md border border-slate-200 bg-slate-50 hover:bg-slate-100 disabled:opacity-40 transition-colors">
          <Minus size={12} />
        </button>
        <input
          type="number"
          value={adj}
          onChange={e => onChange(Number(e.target.value))}
          disabled={disabled}
          className="w-14 text-center border border-slate-200 rounded-md py-1 text-sm font-bold focus:ring-2 focus:ring-blue-500 focus:border-blue-400 outline-none [appearance:textfield]"
        />
        <button type="button" onClick={() => onChange(adj + 1)} disabled={disabled}
          className="w-7 h-7 flex items-center justify-center rounded-md border border-slate-200 bg-slate-50 hover:bg-slate-100 disabled:opacity-40 transition-colors">
          <Plus size={12} />
        </button>
        <span className={`text-xs font-semibold w-8 text-right ${adjColor}`}>
          {adj > 0 ? '+' : ''}{adj}%
        </span>
      </div>
    </div>
  );
}

export default function PriceEditor({ eventId, initialPct, initialStandardAdj = 0, initialResaleAdj = 0, initialBrokerAdj = 0 }: Props) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [value, setValue] = useState(initialPct);
  const [inputVal, setInputVal] = useState(String(initialPct));
  const [stdAdj, setStdAdj] = useState(initialStandardAdj);
  const [resaleAdj, setResaleAdj] = useState(initialResaleAdj);
  const [brokerAdj, setBrokerAdj] = useState(initialBrokerAdj);
  const [saveState, setSaveState] = useState<SaveState>('idle');
  const successTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const isDirty = value !== initialPct
    || stdAdj !== initialStandardAdj
    || resaleAdj !== initialResaleAdj
    || brokerAdj !== initialBrokerAdj;

  useEffect(() => { setInputVal(String(value)); }, [value]);

  const clamp = (n: number) => Math.max(-100, Math.min(500, Math.round(n)));
  const step = (delta: number) => { setValue(prev => clamp(prev + delta)); setSaveState('idle'); };

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setInputVal(e.target.value);
    const n = parseFloat(e.target.value);
    if (!isNaN(n)) { setValue(clamp(n)); setSaveState('idle'); }
  };

  const handleSave = () => {
    if (!isDirty) return;
    setSaveState('saving');
    startTransition(async () => {
      try {
        await updateEvent(eventId, {
          priceIncreasePercentage: value,
          standardMarkupAdjustment: stdAdj,
          resaleMarkupAdjustment: resaleAdj,
          brokerMarkupAdjustment: brokerAdj,
        } as Parameters<typeof updateEvent>[1], false);
        setSaveState('saved');
        router.refresh();
        if (successTimer.current) clearTimeout(successTimer.current);
        successTimer.current = setTimeout(() => setSaveState('idle'), 3000);
      } catch {
        setSaveState('error');
      }
    });
  };

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const pctColor = value > 0 ? 'text-rose-600' : value < 0 ? 'text-blue-600' : 'text-gray-700';

  return (
    <section className="bg-white rounded-2xl border border-gray-200 shadow-sm overflow-hidden">
      <div className="px-5 py-4 border-b border-gray-100">
        <h2 className="text-sm font-bold text-gray-800 flex items-center gap-2">
          <span className="w-6 h-6 rounded-md bg-emerald-50 flex items-center justify-center">
            <TrendingUp size={13} className="text-emerald-500" />
          </span>
          Price Markup
        </h2>
        <p className="text-xs text-gray-400 mt-0.5">
          Adjust scraper default and per-type CSV overrides
        </p>
      </div>

      <div className="px-5 py-4 space-y-5">
        {/* --- Default (scraper) markup --- */}
        <div>
          <p className="text-[10px] font-bold text-gray-400 uppercase tracking-widest mb-2">
            Default Markup
          </p>
          <div className="flex items-center gap-2 mb-2">
            <button
              onClick={() => step(-5)}
              aria-label="Decrease by 5%"
              className="flex items-center justify-center w-8 h-8 rounded-lg bg-gray-100 hover:bg-gray-200 text-gray-700 transition-colors shrink-0"
            >
              <Minus size={13} />
            </button>
            <div className="relative flex-1">
              <input
                type="number"
                value={inputVal}
                onChange={handleInputChange}
                onBlur={() => setInputVal(String(value))}
                className="w-full text-center text-xl font-bold rounded-xl border border-gray-200 bg-white px-3 py-2 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 transition-colors [appearance:textfield]"
              />
              <span className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 font-bold pointer-events-none">
                %
              </span>
            </div>
            <button
              onClick={() => step(5)}
              aria-label="Increase by 5%"
              className="flex items-center justify-center w-8 h-8 rounded-lg bg-gray-100 hover:bg-gray-200 text-gray-700 transition-colors shrink-0"
            >
              <Plus size={13} />
            </button>
          </div>
          <div className="flex flex-wrap gap-1" role="group">
            {PRESETS.map((p) => (
              <button
                key={p}
                onClick={() => {
                  setValue(p);
                  setSaveState("idle");
                }}
                className={`px-2.5 py-0.5 rounded-lg text-[11px] font-bold transition-colors ${
                  value === p
                    ? "bg-blue-600 text-white"
                    : "bg-gray-100 text-gray-600 hover:bg-gray-200"
                }`}
              >
                {p > 0 ? "+" : ""}
                {p}%
              </button>
            ))}
          </div>
          <p className="text-[11px] text-gray-400 mt-1.5">
            Applied by scraper to all ticket prices
          </p>
        </div>

        {/* --- CSV Adjustments --- */}
        <div className="bg-gray-50 rounded-xl p-3.5 space-y-0.5">
          <p className="text-[10px] font-bold text-gray-400 uppercase tracking-widest mb-2">
            CSV Adjustments
          </p>
          <AdjRow
            label="Standard"
            adj={stdAdj}
            defaultPct={value}
            onChange={(v) => {
              setStdAdj(v);
              setSaveState("idle");
            }}
            disabled={isPending}
          />
          <div className="h-px bg-gray-200 my-1" />
          <AdjRow
            label="Resale (Fan)"
            adj={resaleAdj}
            defaultPct={value}
            onChange={(v) => {
              setResaleAdj(v);
              setSaveState("idle");
            }}
            disabled={isPending}
          />
          <div className="h-px bg-gray-200 my-1" />
          <AdjRow
            label="Broker"
            adj={brokerAdj}
            defaultPct={value}
            onChange={(v) => {
              setBrokerAdj(v);
              setSaveState("idle");
            }}
            disabled={isPending}
          />
          <p className="text-[10px] text-gray-400 mt-1 leading-tight">
            Broker = listings tagged &ldquo;resale broker&rdquo; by scraper. If 0, falls back to Resale %.
          </p>
        </div>

        {/* Save button */}
        <button
          onClick={handleSave}
          disabled={!isDirty || isPending}
          className={`w-full flex items-center justify-center gap-2 py-2.5 rounded-xl text-sm font-semibold transition-colors ${
            saveState === "saved"
              ? "bg-green-600 text-white"
              : saveState === "error"
                ? "bg-red-600 text-white"
                : isDirty
                  ? "bg-blue-600 hover:bg-blue-700 text-white shadow-sm"
                  : "bg-gray-100 text-gray-400 cursor-not-allowed"
          }`}
        >
          {isPending ? (
            <>
              <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
              Saving…
            </>
          ) : saveState === "saved" ? (
            <>
              <Check size={14} />
              Saved!
            </>
          ) : saveState === "error" ? (
            "Failed — try again"
          ) : (
            "Save changes"
          )}
        </button>
      </div>

      <div aria-live="polite" aria-atomic="true" className="sr-only">
        {saveState === "saved" && "Price markup saved successfully."}
        {saveState === "error" &&
          "Failed to save price markup. Please try again."}
      </div>
    </section>
  );
}
