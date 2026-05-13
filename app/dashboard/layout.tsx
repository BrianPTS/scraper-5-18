'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useState, useEffect } from 'react';
import {
  LayoutDashboard,
  Calendar,
  Plus,
  Menu,
  Package,
  Download,
  LogOut,
  ShoppingCart,
  X,
  SignalHigh,
  Filter,
  Search,
  Shield,
  Users,
  Bell,
} from 'lucide-react';

interface FeatureFlags {
  events: string;
  inventory: string;
  exclusionRules: string;
  importEvents: string;
  addEvent: string;
  orders: string;
  exportCsv: string;
  purchaseAccounts: string;
  proxies: string;
}

const DEFAULT_FLAGS: FeatureFlags = {
  events: 'enabled', inventory: 'enabled', exclusionRules: 'enabled', importEvents: 'enabled',
  addEvent: 'enabled', orders: 'enabled', exportCsv: 'enabled',
  purchaseAccounts: 'enabled', proxies: 'disabled',
};

/** Normalize legacy booleans from DB */
function normalizeFlag(value: unknown): string {
  if (value === true || value === 'enabled') return 'enabled';
  if (value === 'hidden') return 'hidden';
  if (value === false || value === 'disabled') return 'disabled';
  return 'enabled';
}

const DashboardLayout = ({ children }: { children: React.ReactNode }) => {
  const pathname = usePathname();
  const router = useRouter();
  const [isSidebarOpen, setIsSidebarOpen] = useState(true);
  const [flags, setFlags] = useState<FeatureFlags>(DEFAULT_FLAGS);
  const [isSuperAdmin, setIsSuperAdmin] = useState(false);

  useEffect(() => {
    fetch('/api/feature-flags')
      .then(res => res.json())
      .then(data => {
        if (data.success && data.flags) {
          const merged = { ...DEFAULT_FLAGS };
          for (const key of Object.keys(DEFAULT_FLAGS) as (keyof FeatureFlags)[]) {
            if (data.flags[key] !== undefined) {
              merged[key] = normalizeFlag(data.flags[key]);
            }
          }
          setFlags(merged);
        }
      })
      .catch(() => {});

    fetch('/api/auth/me')
      .then(res => res.json())
      .then(data => {
        if (data.role === 'superadmin') setIsSuperAdmin(true);
      })
      .catch(() => {});
  }, []);

  const handleLogout = async () => {
    try {
      await fetch('/api/auth/logout', { method: 'POST' });
    } catch {
      // Even if the API call fails, redirect to login
    }
    router.push('/login');
    router.refresh();
  };

  const allNavItems = [
    {
      path: '/dashboard',
      label: 'Dashboard',
      icon: <LayoutDashboard className="w-5 h-5" />,
      flagKey: null, // always visible
    },
    {
      path: '/dashboard/events',
      label: 'Events',
      icon: <Calendar className="w-5 h-5" />,
      flagKey: 'events' as keyof FeatureFlags,
    },
    {
      path: '/dashboard/inventory',
      label: 'Inventory',
      icon: <Package className="w-5 h-5" />,
      flagKey: 'inventory' as keyof FeatureFlags,
    },
    {
      path: '/dashboard/exclusions',
      label: 'Exclusion Rules',
      icon: <Filter className="w-5 h-5" />,
      flagKey: 'exclusionRules' as keyof FeatureFlags,
    },
    {
      path: '/dashboard/import-events',
      label: 'Import Events',
      icon: <Search className="w-5 h-5" />,
      flagKey: 'importEvents' as keyof FeatureFlags,
    },
    {
      path: '/dashboard/list-event',
      label: 'Add Event',
      icon: <Plus className="w-5 h-5" />,
      flagKey: 'addEvent' as keyof FeatureFlags,
    },
    {
      path: '/dashboard/orders',
      label: 'Orders',
      icon: <ShoppingCart className="w-5 h-5" />,
      flagKey: 'orders' as keyof FeatureFlags,
    },
    {
      path: '/dashboard/orders/accounts',
      label: 'Accounts',
      icon: <Users className="w-5 h-5" />,
      flagKey: 'purchaseAccounts' as keyof FeatureFlags,
    },
    {
      path: '/dashboard/export-csv',
      label: 'Export CSV',
      icon: <Download className="w-5 h-5" />,
      flagKey: 'exportCsv' as keyof FeatureFlags,
    },
    {
      path: '/dashboard/inventory-watcher',
      label: 'Inventory Alerts',
      icon: <Bell className="w-5 h-5" />,
    },
  ];

  const navItems = allNavItems.filter(item => !item.flagKey || flags[item.flagKey] === 'enabled');

  const comingSoonItems = flags.proxies === 'enabled' ? [] : [
    {
      label: 'Proxies',
      icon: <SignalHigh className="w-5 h-5" />,
      description: 'Manage Proxies'
    },
  ];

  return (
    <div className="flex h-screen bg-gradient-to-br from-slate-50 to-slate-100">
      {/* Sidebar */}
      <aside className={`bg-white w-64 max-w-[90vw] min-h-screen shadow-xl transition-all duration-300 ease-in-out border-r border-slate-200 overflow-hidden ${
        isSidebarOpen ? 'translate-x-0' : '-translate-x-full'
      } fixed lg:relative lg:translate-x-0 z-50 flex flex-col`}>

        {/* Logo */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-100 shrink-0">
          <div className="flex items-center gap-3 min-w-0">
            <div className="w-8 h-8 rounded-xl bg-gradient-to-br from-purple-500 to-indigo-600 flex items-center justify-center shadow-md shadow-purple-200 shrink-0">
              <Package className="w-4 h-4 text-white" />
            </div>
            <span className="text-base font-bold text-slate-800 truncate">TMC Portal</span>
          </div>
          <button onClick={() => setIsSidebarOpen(false)} className="p-1.5 rounded-lg hover:bg-slate-100 text-slate-400 transition-colors lg:hidden">
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Nav */}
        <div className="flex-1 overflow-y-auto px-3 py-4 min-h-0">
          <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest px-2 mb-2">Menu</p>
          <nav className="space-y-0.5">
            {navItems.map((item) => {
              const active = pathname === item.path || (
                item.path !== '/dashboard' &&
                pathname.startsWith(item.path) &&
                // Prevent parent from highlighting when on a child route
                !navItems.some(other => other.path !== item.path && other.path.startsWith(item.path) && pathname.startsWith(other.path))
              );
              return (
                <Link
                  key={item.path}
                  href={item.path}
                  className={`flex items-center gap-3 px-3 py-2.5 rounded-xl transition-all duration-150 group ${
                    active
                      ? 'bg-gradient-to-r from-purple-600 to-indigo-600 text-white shadow-md shadow-purple-200'
                      : 'text-slate-600 hover:text-slate-900 hover:bg-slate-50'
                  }`}
                >
                  <span className={`shrink-0 transition-transform duration-150 ${active ? '' : 'group-hover:scale-105'}`}>
                    {item.icon}
                  </span>
                  <span className="font-medium text-sm truncate flex-1">{item.label}</span>
                </Link>
              );
            })}
          </nav>

          {comingSoonItems.length > 0 && (
            <div className="mt-5 pt-4 border-t border-slate-100">
              <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest px-2 mb-2">Coming Soon</p>
              {comingSoonItems.map((item, index) => (
                <div key={index} className="flex items-center gap-3 px-3 py-2.5 rounded-xl text-slate-300 cursor-not-allowed">
                  <span className="shrink-0">{item.icon}</span>
                  <span className="font-medium text-sm truncate flex-1">{item.label}</span>
                  <span className="text-[10px] font-semibold bg-amber-50 text-amber-500 border border-amber-200 px-2 py-0.5 rounded-full">Soon</span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-3 py-4 border-t border-slate-100 shrink-0">
          {isSuperAdmin && (
            <Link
              href="/dashboard/admin"
              className={`flex items-center gap-3 px-3 py-2.5 rounded-xl w-full transition-colors mb-1 ${
                pathname === '/dashboard/admin'
                  ? 'bg-gradient-to-r from-red-600 to-rose-600 text-white shadow-md'
                  : 'text-slate-400 hover:text-red-600 hover:bg-red-50'
              }`}
            >
              <Shield className="w-5 h-5 shrink-0" />
              <span className="font-medium text-sm">Admin</span>
            </Link>
          )}
          <button
            onClick={handleLogout}
            className="flex items-center gap-3 px-3 py-2.5 rounded-xl w-full text-slate-500 hover:text-red-600 hover:bg-red-50 transition-colors"
          >
            <LogOut className="w-5 h-5 shrink-0" />
            <span className="font-medium text-sm">Logout</span>
          </button>
          <p className="text-[10px] text-slate-300 text-center mt-3">Made in dark mode 🌙</p>
        </div>
      </aside>

      {/* Mobile Overlay */}
      {isSidebarOpen && (
        <div className="fixed inset-0 bg-black/50 z-40 lg:hidden" onClick={() => setIsSidebarOpen(false)} />
      )}

      {/* Mobile Menu Button */}
      <button
        onClick={() => setIsSidebarOpen(true)}
        className={`fixed top-4 left-4 z-30 p-2 bg-white rounded-lg shadow-lg lg:hidden transition-transform duration-300 ${
          isSidebarOpen ? 'scale-0' : 'scale-100'
        }`}
      >
        <Menu className="w-5 h-5" />
      </button>

      {/* Main Content */}
      <main className="flex-1 overflow-x-hidden overflow-y-auto main-content">
        <div className="p-6 lg:p-8 min-w-0">
          {children}
        </div>
      </main>
    </div>
  );
};

export default DashboardLayout;
