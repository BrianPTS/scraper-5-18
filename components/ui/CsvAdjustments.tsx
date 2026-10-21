'use client';

import React from 'react';
import { Minus, Plus } from 'lucide-react';

/**
 * Per-type CSV adjustments (Standard / Resale (Fan) / Broker) on top of the default
 * markup. One component for the event Price Markup card, the Add Event form and the
 * Import Events cards so all three look and behave the same.
 */

function AdjRow({
  label,
  adj,
  effective,
  onChange,
  disabled,
}: {
  label: string;
  adj: number;
  effective: number;
  onChange: (v: number) => void;
  disabled?: boolean;
}) {
  const adjColor = adj > 0 ? 'text-red-600 font-bold' : adj < 0 ? 'text-blue-600 font-bold' : 'text-slate-400';
  const effColor = effective > 0 ? 'text-red-600' : effective < 0 ? 'text-blue-600' : 'text-slate-500';
  return (
    <div className="flex items-center justify-between gap-3 py-2">
      <div className="min-w-0">
        <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide">{label}</p>
        <p className="text-[11px] text-slate-400">Effective: <span className={effColor}>{effective > 0 ? '+' : ''}{effective}%</span></p>
      </div>
      <div className="flex items-center gap-1.5 shrink-0">
        <button type="button" onClick={() => onChange(adj - 1)} disabled={disabled} aria-label={`Decrease ${label} adjustment`}
          className="w-7 h-7 flex items-center justify-center rounded-md border border-slate-200 bg-slate-50 hover:bg-slate-100 disabled:opacity-40 transition-colors">
          <Minus size={12} />
        </button>
        <input
          type="number"
          value={adj}
          onChange={e => onChange(Number(e.target.value) || 0)}
          disabled={disabled}
          aria-label={`${label} adjustment`}
          className="w-14 text-center border border-slate-200 rounded-md py-1 text-sm font-bold focus:ring-2 focus:ring-blue-500 focus:border-blue-400 outline-none [appearance:textfield]"
        />
        <button type="button" onClick={() => onChange(adj + 1)} disabled={disabled} aria-label={`Increase ${label} adjustment`}
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

export default function CsvAdjustments({
  defaultPct,
  standardAdj,
  resaleAdj,
  brokerAdj,
  onStandardChange,
  onResaleChange,
  onBrokerChange,
  disabled,
  className = '',
}: {
  defaultPct: number;
  standardAdj: number;
  resaleAdj: number;
  brokerAdj: number;
  onStandardChange: (v: number) => void;
  onResaleChange: (v: number) => void;
  onBrokerChange: (v: number) => void;
  disabled?: boolean;
  className?: string;
}) {
  const pct = Number(defaultPct) || 0;
  return (
    <div className={`bg-gray-50 rounded-xl p-3.5 space-y-0.5 ${className}`}>
      <p className="text-[10px] font-bold text-gray-400 uppercase tracking-widest mb-2">
        CSV Adjustments
      </p>
      <AdjRow label="Standard" adj={standardAdj} effective={pct + standardAdj} onChange={onStandardChange} disabled={disabled} />
      <div className="h-px bg-gray-200 my-1" />
      <AdjRow label="Resale (Fan)" adj={resaleAdj} effective={pct + resaleAdj} onChange={onResaleChange} disabled={disabled} />
      <div className="h-px bg-gray-200 my-1" />
      {/* The CSV uses the fan adjustment for brokers while the broker one is 0. */}
      <AdjRow label="Broker" adj={brokerAdj} effective={pct + (brokerAdj !== 0 ? brokerAdj : resaleAdj)} onChange={onBrokerChange} disabled={disabled} />
      <p className="text-[10px] text-gray-400 mt-1 leading-tight">
        Broker = listings tagged &ldquo;resale broker&rdquo; by scraper. If 0, falls back to Resale %.
      </p>
    </div>
  );
}
