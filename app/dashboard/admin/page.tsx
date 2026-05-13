'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { Shield, Eye, EyeOff, Ban, Lock, Check, AlertTriangle } from 'lucide-react';

type FlagState = 'enabled' | 'hidden' | 'disabled';

interface FeatureFlags {
  // Pages
  events: FlagState;
  inventory: FlagState;
  exclusionRules: FlagState;
  importEvents: FlagState;
  addEvent: FlagState;
  orders: FlagState;
  exportCsv: FlagState;
  purchaseAccounts: FlagState;
  // Sub-features
  csvScheduler: FlagState;
  csvManualExport: FlagState;
  csvDownload: FlagState;
  minSeatFilter: FlagState;
  lowSeatAutoStop: FlagState;
  eventEdit: FlagState;
  eventExclusions: FlagState;
  autoDelete: FlagState;
  proxies: FlagState;
}

const DEFAULT_FLAGS: FeatureFlags = {
  events: 'enabled', inventory: 'enabled', exclusionRules: 'enabled', importEvents: 'enabled',
  addEvent: 'enabled', orders: 'enabled', exportCsv: 'enabled',
  purchaseAccounts: 'enabled',
  csvScheduler: 'enabled', csvManualExport: 'enabled', csvDownload: 'enabled',
  minSeatFilter: 'enabled', lowSeatAutoStop: 'enabled',
  eventEdit: 'enabled', eventExclusions: 'enabled', autoDelete: 'enabled', proxies: 'disabled',
};

/** Normalize legacy booleans from DB to string states */
function normalize(value: unknown): FlagState {
  if (value === true || value === 'enabled') return 'enabled';
  if (value === 'hidden') return 'hidden';
  if (value === false || value === 'disabled') return 'disabled';
  return 'enabled';
}

interface FlagGroup {
  label: string;
  description: string;
  flags: { key: keyof FeatureFlags; label: string; description: string }[];
}

const FLAG_GROUPS: FlagGroup[] = [
  {
    label: 'Pages',
    description: 'Control which pages are visible in the sidebar',
    flags: [
      { key: 'events', label: 'Events', description: 'Event listing and management' },
      { key: 'inventory', label: 'Inventory', description: 'Seat inventory viewer' },
      { key: 'exclusionRules', label: 'Exclusion Rules', description: 'Global exclusion rule management' },
      { key: 'importEvents', label: 'Import Events', description: 'Search and import events from TM' },
      { key: 'addEvent', label: 'Add Event', description: 'Manually add a new event' },
      { key: 'orders', label: 'Orders', description: 'Order management and tracking' },
      { key: 'exportCsv', label: 'Export CSV', description: 'CSV generation and sync settings' },
      { key: 'purchaseAccounts', label: 'Purchase Accounts', description: 'TM account usage tracking per event' },
    ],
  },
  {
    label: 'Export CSV Features',
    description: 'Control sub-features within the Export CSV page',
    flags: [
      { key: 'csvScheduler', label: 'CSV Scheduler', description: 'Automatic scheduled CSV generation' },
      { key: 'csvManualExport', label: 'Manual Export to Sync', description: 'One-click export to sync service' },
      { key: 'csvDownload', label: 'CSV Download', description: 'Download CSV file directly' },
      { key: 'minSeatFilter', label: 'NLA Protection (Min Seat Filter)', description: 'Filter low-quantity listings from CSV' },
      { key: 'lowSeatAutoStop', label: 'Low Seat Auto-Stop', description: 'Auto-stop events with few total seats' },
    ],
  },
  {
    label: 'Event Features',
    description: 'Control sub-features within event pages',
    flags: [
      { key: 'eventEdit', label: 'Event Editing', description: 'Allow editing event settings (markup, filters)' },
      { key: 'eventExclusions', label: 'Per-Event Exclusions', description: 'Per-event exclusion rule management' },
    ],
  },
  {
    label: 'System Features',
    description: 'Background and system-level features',
    flags: [
      { key: 'autoDelete', label: 'Auto-Delete', description: 'Timezone-based auto-stop/delete of past events' },
      { key: 'proxies', label: 'Proxies', description: 'Proxy management (coming soon)' },
    ],
  },
];

const STATE_ORDER: FlagState[] = ['enabled', 'hidden', 'disabled'];

const STATE_CONFIG: Record<FlagState, { label: string; color: string; bg: string; border: string; icon: typeof Eye }> = {
  enabled: { label: 'Enabled', color: 'text-green-700', bg: 'bg-green-50', border: 'border-green-200', icon: Eye },
  hidden: { label: 'Hidden', color: 'text-amber-700', bg: 'bg-amber-50', border: 'border-amber-200', icon: EyeOff },
  disabled: { label: 'Disabled', color: 'text-red-700', bg: 'bg-red-50', border: 'border-red-200', icon: Ban },
};

export default function AdminPage() {
  const [authenticated, setAuthenticated] = useState(false);
  const [roleChecked, setRoleChecked] = useState(false);
  const [password, setPassword] = useState('');
  const [authError, setAuthError] = useState('');
  const [flags, setFlags] = useState<FeatureFlags>(DEFAULT_FLAGS);
  const [savedFlags, setSavedFlags] = useState<FeatureFlags>(DEFAULT_FLAGS);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ text: string; type: 'success' | 'error' } | null>(null);

  const router = useRouter();
  const hasChanges = JSON.stringify(flags) !== JSON.stringify(savedFlags);

  // async-parallel: fetch auth + flags in parallel instead of sequentially
  useEffect(() => {
    async function init() {
      try {
        const [authRes, flagsRes] = await Promise.all([
          fetch('/api/auth/me'),
          fetch('/api/feature-flags'),
        ]);
        const [authData, flagsData] = await Promise.all([
          authRes.json(),
          flagsRes.json(),
        ]);

        // Auth check
        if (authData.role !== 'superadmin') {
          router.replace('/dashboard');
          return;
        }
        setRoleChecked(true);

        // Flags
        if (flagsData.success && flagsData.flags) {
          const merged = { ...DEFAULT_FLAGS };
          for (const key of Object.keys(DEFAULT_FLAGS) as (keyof FeatureFlags)[]) {
            merged[key] = normalize(flagsData.flags[key]);
          }
          setFlags(merged);
          setSavedFlags(merged);
        }
      } catch {
        router.replace('/dashboard');
      } finally {
        setLoading(false);
      }
    }
    init();
  }, [router]);

  const handleAuth = (e: React.FormEvent) => {
    e.preventDefault();
    if (password.length >= 4) {
      setAuthenticated(true);
      setAuthError('');
    } else {
      setAuthError('Password too short');
    }
  };

  const handleSave = async () => {
    setSaving(true);
    setMessage(null);
    try {
      const res = await fetch('/api/feature-flags', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ flags }),
      });
      const data = await res.json();
      if (data.success) {
        setSavedFlags({ ...flags });
        setMessage({ text: 'Feature flags saved successfully', type: 'success' });
      } else {
        setMessage({ text: data.message || 'Failed to save', type: 'error' });
      }
    } catch {
      setMessage({ text: 'Network error', type: 'error' });
    } finally {
      setSaving(false);
      setTimeout(() => setMessage(null), 3000);
    }
  };

  const cycleFlag = (key: keyof FeatureFlags) => {
    setFlags(prev => {
      const current = prev[key];
      const idx = STATE_ORDER.indexOf(current);
      const next = STATE_ORDER[(idx + 1) % STATE_ORDER.length];
      return { ...prev, [key]: next };
    });
  };

  const enabledCount = Object.values(flags).filter(v => v === 'enabled').length;
  const hiddenCount = Object.values(flags).filter(v => v === 'hidden').length;
  const disabledCount = Object.values(flags).filter(v => v === 'disabled').length;

  if (!roleChecked) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-red-600"></div>
      </div>
    );
  }

  if (!authenticated) {
    return (
      <div className="max-w-md mx-auto mt-20">
        <div className="bg-white rounded-2xl shadow-lg border border-slate-200 p-8">
          <div className="flex items-center gap-3 mb-6">
            <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-red-500 to-rose-600 flex items-center justify-center shadow-md">
              <Shield className="w-5 h-5 text-white" />
            </div>
            <div>
              <h1 className="text-lg font-bold text-slate-800">Super Admin</h1>
              <p className="text-xs text-slate-500">Enter admin password to continue</p>
            </div>
          </div>
          <form onSubmit={handleAuth}>
            <div className="relative">
              <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
              <input
                type="password"
                value={password}
                onChange={(e) => { setPassword(e.target.value); setAuthError(''); }}
                placeholder="Admin password"
                className="w-full pl-10 pr-4 py-3 border border-slate-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-red-500 focus:border-transparent"
                autoFocus
              />
            </div>
            {authError && <p className="text-xs text-red-500 mt-2">{authError}</p>}
            <button
              type="submit"
              className="w-full mt-4 py-3 bg-gradient-to-r from-red-600 to-rose-600 text-white font-medium rounded-xl hover:from-red-700 hover:to-rose-700 transition-all shadow-md"
            >
              Unlock
            </button>
          </form>
        </div>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-red-600"></div>
      </div>
    );
  }

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-red-500 to-rose-600 flex items-center justify-center shadow-md shadow-red-200">
            <Shield className="w-5 h-5 text-white" />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-slate-800">Super Admin</h1>
            <p className="text-sm text-slate-500">
              <span className="text-green-600">{enabledCount} on</span>
              {hiddenCount > 0 && <span className="text-amber-600"> · {hiddenCount} hidden</span>}
              {disabledCount > 0 && <span className="text-red-600"> · {disabledCount} off</span>}
            </p>
          </div>
        </div>
        <button
          onClick={handleSave}
          disabled={!hasChanges || saving}
          className={`px-5 py-2.5 rounded-xl font-medium text-sm transition-all shadow-md flex items-center gap-2 ${
            hasChanges
              ? 'bg-gradient-to-r from-red-600 to-rose-600 text-white hover:from-red-700 hover:to-rose-700'
              : 'bg-slate-100 text-slate-400 cursor-not-allowed shadow-none'
          }`}
        >
          {saving ? (
            <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white" />
          ) : (
            <Check className="w-4 h-4" />
          )}
          {saving ? 'Saving...' : hasChanges ? 'Save Changes' : 'No Changes'}
        </button>
      </div>

      {/* Legend */}
      <div className="flex items-center gap-4 text-xs">
        {STATE_ORDER.map(state => {
          const cfg = STATE_CONFIG[state];
          const Icon = cfg.icon;
          return (
            <div key={state} className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg ${cfg.bg} ${cfg.color} border ${cfg.border}`}>
              <Icon className="w-3.5 h-3.5" />
              <span className="font-medium">{cfg.label}</span>
              <span className="opacity-70">
                {state === 'enabled' && '— Visible + working'}
                {state === 'hidden' && '— Hidden UI, API works'}
                {state === 'disabled' && '— Hidden + API blocked'}
              </span>
            </div>
          );
        })}
      </div>

      {/* Message */}
      {message && (
        <div className={`px-4 py-3 rounded-xl text-sm font-medium flex items-center gap-2 ${
          message.type === 'success'
            ? 'bg-green-50 text-green-700 border border-green-200'
            : 'bg-red-50 text-red-700 border border-red-200'
        }`}>
          {message.type === 'success' ? <Check className="w-4 h-4" /> : <AlertTriangle className="w-4 h-4" />}
          {message.text}
        </div>
      )}

      {/* Warning */}
      {hasChanges && (
        <div className="px-4 py-3 rounded-xl text-sm bg-amber-50 text-amber-700 border border-amber-200 flex items-center gap-2">
          <AlertTriangle className="w-4 h-4 shrink-0" />
          You have unsaved changes. Click &quot;Save Changes&quot; to apply.
        </div>
      )}

      {/* Feature Groups */}
      {FLAG_GROUPS.map((group) => (
        <div key={group.label} className="bg-white rounded-2xl shadow-sm border border-slate-200 overflow-hidden">
          <div className="px-6 py-4 border-b border-slate-100 bg-slate-50/50">
            <h2 className="text-sm font-bold text-slate-700 uppercase tracking-wide">{group.label}</h2>
            <p className="text-xs text-slate-500 mt-0.5">{group.description}</p>
          </div>
          <div className="divide-y divide-slate-100">
            {group.flags.map(({ key, label, description }) => {
              const state = flags[key];
              const cfg = STATE_CONFIG[state];
              const Icon = cfg.icon;
              return (
                <div key={key} className="flex items-center justify-between px-6 py-4 hover:bg-slate-50/50 transition-colors">
                  <div className="flex items-center gap-3 min-w-0">
                    <Icon className={`w-4 h-4 shrink-0 ${
                      state === 'enabled' ? 'text-green-500' : state === 'hidden' ? 'text-amber-500' : 'text-red-400'
                    }`} />
                    <div className="min-w-0">
                      <p className={`text-sm font-medium ${state === 'enabled' ? 'text-slate-800' : state === 'hidden' ? 'text-slate-600' : 'text-slate-400'}`}>
                        {label}
                      </p>
                      <p className="text-xs text-slate-400 truncate">{description}</p>
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => cycleFlag(key)}
                    className={`px-3 py-1.5 rounded-lg text-xs font-semibold border transition-all shrink-0 ${cfg.bg} ${cfg.color} ${cfg.border} hover:opacity-80`}
                  >
                    {cfg.label}
                  </button>
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}
