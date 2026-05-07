'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { getAllEvents } from '@/actions/eventActions';
import { getConsecutiveGroupsPaginated } from '@/actions/seatActions';
import { getAutoDeleteSettings, getAutoDeletePreview } from '@/actions/csvActions';
import { getLastDeletedEvents } from '@/actions/autoDeleteActions';
import { getMonthlyStats, getProcessingTimeStats } from '@/actions/orderActions';
import { 
  Calendar,
  Package,
  Activity,
  ArrowUpRight,
  TrendingUp,
  Plus,
  Download,
  Filter,
  Clock,
  ChevronDown,
  ChevronUp,
  AlertTriangle,
  MapPin,
  Shield,
  CheckCircle2,
  Timer,
  ShoppingCart,
  XCircle
} from 'lucide-react';

// Client-side time component to avoid hydration mismatch
function ClientTime() {
  const [time, setTime] = useState('');
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
    const updateTime = () => {
      setTime(new Date().toLocaleTimeString('en-US', {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false
      }));
    };
    
    updateTime();
    const interval = setInterval(updateTime, 1000);
    
    return () => clearInterval(interval);
  }, []);

  if (!mounted) {
    return <span>--:--:--</span>;
  }

  return <span>{time}</span>;
}

interface EventDoc {
  Event_DateTime: string;
  _id: string;
  Event_Name: string;
  Venue?: string;
  createdAt: string;
  Available_Seats?: number;
  Skip_Scraping?: boolean; // Add this field
  // add more fields if needed
}

interface DashboardStats {
  totalEvents: number;
  totalSeats: number;
  activeScrapingCount: number;
  recentEvents: EventDoc[];
  weeklyEventsData: { day: string; count: number; seats: number }[];
  loading: boolean;
}

interface AutoDeleteEvent {
  id: string;
  name: string;
  dateTime: string;
  venue?: string;
  isStopped?: boolean;
  detectedTimezone?: string;
  localTimeDisplay?: string;
  pktTimeDisplay?: string;
}

interface LastDeletedEvent {
  eventId: string;
  eventName: string;
  venue: string;
  eventDateTime: string;
  deletedAt: string;
  detectedTimezone: string;
  timezoneAbbr: string;
  localTimeAtDeletion: string;
  pktTimeAtDeletion: string;
}

interface AutoDeleteInfo {
  isEnabled: boolean;
  stopBeforeMinutes: number;
  scheduleIntervalMinutes: number;
  lastRunAt: string | null;
  totalEventsDeleted: number;
  events: AutoDeleteEvent[];
  count: number;
  totalEvents: number;
  skippedCount?: number;
  loading: boolean;
}

export default function DashboardPage() {
  const router = useRouter();
  const [stats, setStats] = useState<DashboardStats>({
    totalEvents: 0,
    totalSeats: 0,
    activeScrapingCount: 0, // Initialize the new field
    recentEvents: [],
    weeklyEventsData: [],
    loading: true,
  });

  const [autoDeleteInfo, setAutoDeleteInfo] = useState<AutoDeleteInfo>({
    isEnabled: false,
    stopBeforeMinutes: 120,
    scheduleIntervalMinutes: 15,
    lastRunAt: null,
    totalEventsDeleted: 0,
    events: [],
    count: 0,
    totalEvents: 0,
    loading: true,
  });
  const [showAllDeleteEvents, setShowAllDeleteEvents] = useState(false);
  const [showAllStoppedEvents, setShowAllStoppedEvents] = useState(false);
  const [lastDeletedEvents, setLastDeletedEvents] = useState<LastDeletedEvent[]>([]);
  const [orderStats, setOrderStats] = useState<{ totalOrders: number; delivered: number; rejected: number; pending: number; fulfillRate: number; loading: boolean }>({
    totalOrders: 0, delivered: 0, rejected: 0, pending: 0, fulfillRate: 0, loading: true,
  });
  const [procTime, setProcTime] = useState<{
    data: Array<{ label: string; avgMinutes: number; medianMinutes: number; count: number; minMinutes: number; maxMinutes: number }>;
    orders?: Array<{ order_id: string; event_name: string; minutes: number; day: number; section: string; row: string; quantity: number }>;
    overallAvgMinutes: number;
    totalOrders: number;
    excludedCount: number;
    loading: boolean;
  }>({ data: [], overallAvgMinutes: 0, totalOrders: 0, excludedCount: 0, loading: true });
  const [procView, setProcView] = useState<'daily' | 'weekly' | 'monthly'>('daily');
  const [procMonth, setProcMonth] = useState(() => new Date().getMonth() + 1);
  const [procYear, setProcYear] = useState(() => new Date().getFullYear());
  const [hoveredProcBar, setHoveredProcBar] = useState<number | null>(null);
  const [hoveredDot, setHoveredDot] = useState<number | null>(null);

  useEffect(() => {
    async function fetchData() {
      try {
        // async-parallel: fetch independent data in parallel
        const [eventsData, seatsData] = await Promise.all([
          getAllEvents(),
          getConsecutiveGroupsPaginated(1000, 1, '', {}),
        ]);

        // Check if any of these returned an error
        if (!Array.isArray(eventsData) || 'error' in seatsData) {
          throw new Error("Error fetching dashboard data");
        }

        // Calculate active scraping count (events where Skip_Scraping is false or undefined)
        const activeScrapingCount = Array.isArray(eventsData) 
          ? eventsData.filter(
              (event): event is EventDoc =>
                typeof event === 'object' &&
                event !== null &&
                'Skip_Scraping' in event
            ).filter(event => !event.Skip_Scraping).length
          : 0;

        // Calculate weekly events data
        const weeklyData = Array.isArray(eventsData) && eventsData.length > 0 && eventsData.every((event): event is EventDoc => 
          typeof event === 'object' &&
          'Event_DateTime' in event &&
          '_id' in event &&
          'Event_Name' in event &&
          'createdAt' in event)
          ? calculateWeeklyEvents(eventsData)
          : [];

        setStats({
          totalEvents: Array.isArray(eventsData) ? eventsData.length : 0,
          totalSeats: seatsData.totalQuantity || 0,
          activeScrapingCount, // Set the calculated value
          weeklyEventsData: weeklyData,
          recentEvents: Array.isArray(eventsData) && eventsData.length > 0 && eventsData.every((event): event is EventDoc => 
            typeof event === 'object' &&
            'Event_DateTime' in event &&
            '_id' in event &&
            'Event_Name' in event &&
            'createdAt' in event)
            ? eventsData
                .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
                .slice(0, 5)
            : [],
          loading: false,
        });
      } catch (err) {
        console.error("Error loading dashboard data:", err);
        setStats(prev => ({ ...prev, loading: false }));
      }
    }

    fetchData();
  }, []);

  // Fetch auto-delete data and ensure scheduler is initialized
  useEffect(() => {
    async function fetchAutoDeleteData() {
      try {
        // Ping the auto-delete API route to ensure the scheduler is initialized
        // (the scheduler starts via module-level init when the route is first loaded)
        fetch('/api/auto-delete').catch(() => {});
        fetch('/api/inventory-watcher').catch(() => {});

        const [settings, preview] = await Promise.all([
          getAutoDeleteSettings(),
          getAutoDeletePreview(),
        ]);

        const previewData = preview as { events?: AutoDeleteEvent[]; count?: number; totalEvents?: number; skippedCount?: number };
        setAutoDeleteInfo({
          isEnabled: settings?.isEnabled || false,
          stopBeforeMinutes: settings?.stopBeforeMinutes || 120,
          scheduleIntervalMinutes: settings?.scheduleIntervalMinutes || 15,
          lastRunAt: settings?.lastRunAt || null,
          totalEventsDeleted: settings?.totalEventsDeleted || 0,
          events: previewData?.events || [],
          count: previewData?.count || 0,
          totalEvents: previewData?.totalEvents || 0,
          skippedCount: previewData?.skippedCount || 0,
          loading: false,
        });
      } catch (err) {
        console.error('Error loading auto-delete data:', err);
        setAutoDeleteInfo(prev => ({ ...prev, loading: false }));
      }
    }
    fetchAutoDeleteData();
  }, []);

  // async-parallel: fetch independent data in parallel
  useEffect(() => {
    async function fetchParallel() {
      const [deletedResult, orderResult] = await Promise.allSettled([
        getLastDeletedEvents(),
        getMonthlyStats(),
      ]);
      if (deletedResult.status === 'fulfilled') setLastDeletedEvents(deletedResult.value || []);
      if (orderResult.status === 'fulfilled') setOrderStats({ ...orderResult.value, loading: false });
      else setOrderStats(prev => ({ ...prev, loading: false }));
    }
    fetchParallel();
  }, []);

  // Fetch processing time stats
  useEffect(() => {
    async function fetchProcTime() {
      try {
        setProcTime(prev => ({ ...prev, loading: true }));
        const result = await getProcessingTimeStats(procYear, procMonth, procView);
        setProcTime({ ...result, loading: false });
      } catch (err) {
        console.error('Error loading processing time stats:', err);
        setProcTime(prev => ({ ...prev, loading: false }));
      }
    }
    fetchProcTime();
  }, [procYear, procMonth, procView]);

  // Calculate events created in the last 7 days
  const calculateWeeklyEvents = (events: EventDoc[]) => {
    const today = new Date();
    const weekData = [];
    
    for (let i = 6; i >= 0; i--) {
      const date = new Date(today);
      date.setDate(date.getDate() - i);
      const dayName = date.toLocaleDateString('en-US', { weekday: 'short' });
      
      const eventsOnDay = events.filter(event => {
        const eventDate = new Date(event.createdAt);
        return eventDate.toDateString() === date.toDateString();
      });
      
      // Calculate total seats for events created on this day
      const totalSeatsOnDay = eventsOnDay.reduce((sum, event) => {
        return sum + (event.Available_Seats || 0);
      }, 0);
      
      weekData.push({ 
        day: dayName, 
        count: eventsOnDay.length,
        seats: totalSeatsOnDay
      });
    }
    
    return weekData;
  };

  // Format date
  const formatDate = (dateString: string) => {
    const options: Intl.DateTimeFormatOptions = {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    };
    return new Date(dateString).toLocaleDateString('en-US', options);
  };

  // Format date with time
  const formatDateTime = (dateString: string) => {
    return new Date(dateString).toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: true,
    });
  };

  // Format relative time until auto-stop
  const getTimeUntilDelete = (eventDateTime: string, stopBeforeMinutes: number) => {
    const eventTime = new Date(eventDateTime).getTime();
    const deleteTime = eventTime - (stopBeforeMinutes * 60 * 1000);
    const now = Date.now();
    const diff = deleteTime - now;
    
    if (diff <= 0) return 'Imminent';
    
    const hours = Math.floor(diff / (1000 * 60 * 60));
    const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
    
    if (hours > 24) {
      const days = Math.floor(hours / 24);
      return `in ${days}d ${hours % 24}h`;
    }
    if (hours > 0) return `in ${hours}h ${minutes}m`;
    return `in ${minutes}m`;
  };

  // Handle quick actions
  const handleQuickAction = (action: string) => {
    switch (action) {
      case 'add-event':
        router.push('/dashboard/list-event');
        break;
      case 'manage-inventory':
        router.push('/dashboard/inventory');
        break;
      case 'export-data':
        router.push('/dashboard/export-csv');
        break;
      case 'manage-exclusions':
        router.push('/dashboard/exclusions');
        break;
      case 'view-all-events':
        router.push('/dashboard/events');
        break;
      default:
        console.log('Unknown action:', action);
    }
  };

  return (
    <div className="space-y-8">
      {/* Header */}
      <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between">
        <div>
          <h1 className="text-3xl font-bold bg-gradient-to-r from-slate-800 to-slate-600 bg-clip-text text-transparent">
            Dashboard
          </h1>
          <p className="text-slate-600 mt-2">
            Welcome back! Here&apos;s what&apos;s happening with your events and inventory.
          </p>
        </div>
        <div className="mt-4 lg:mt-0">
          <div className="text-sm text-slate-500">
            Last updated: <ClientTime />
          </div>
        </div>
      </div>
      
      {/* Stats Overview */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
        {/* Total Events Card */}
        <div className="bg-white rounded-2xl shadow-sm border border-slate-200 p-6 hover:shadow-md transition-shadow duration-200">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium text-slate-500 mb-1">Total Events</p>
              <div className="text-3xl font-bold text-slate-800">
                {stats.loading ? (
                  <div className="w-16 h-8 bg-slate-200 rounded animate-pulse"></div>
                ) : (
                  stats.totalEvents.toLocaleString()
                )}
              </div>
              <div className="flex items-center mt-2 text-sm">
                <TrendingUp className="w-4 h-4 text-green-500 mr-1" />
                <span className="text-green-600 font-medium">
                  {stats.weeklyEventsData.reduce((sum, day) => sum + day.count, 0)}
                </span>
                <span className="text-slate-500 ml-1">this week</span>
              </div>
            </div>
            <div className="w-12 h-12 bg-gradient-to-br from-blue-500 to-blue-600 rounded-xl flex items-center justify-center">
              <Calendar className="w-6 h-6 text-white" />
            </div>
          </div>
        </div>

        {/* Total Seats Card */}
        <div className="bg-white rounded-2xl shadow-sm border border-slate-200 p-6 hover:shadow-md transition-shadow duration-200">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium text-slate-500 mb-1">Total Inventory</p>
              <div className="text-3xl font-bold text-slate-800">
                {stats.loading ? (
                  <div className="w-16 h-8 bg-slate-200 rounded animate-pulse"></div>
                ) : (
                  stats.totalSeats.toLocaleString()
                )}
              </div>
              <div className="flex items-center mt-2 text-sm">
                <Package className="w-4 h-4 text-emerald-500 mr-1" />
                <span className="text-emerald-600 font-medium">Seats</span>
                <span className="text-slate-500 ml-1">available</span>
              </div>
            </div>
            <div className="w-12 h-12 bg-gradient-to-br from-emerald-500 to-emerald-600 rounded-xl flex items-center justify-center">
              <Package className="w-6 h-6 text-white" />
            </div>
          </div>
        </div>

        {/* Active Scraping Card */}
        <div className="bg-white rounded-2xl shadow-sm border border-slate-200 p-6 hover:shadow-md transition-shadow duration-200">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium text-slate-500 mb-1">Active Scraping</p>
              <div className="text-3xl font-bold text-slate-800">
                {stats.loading ? (
                  <div className="w-16 h-8 bg-slate-200 rounded animate-pulse"></div>
                ) : (
                  stats.activeScrapingCount.toLocaleString()
                )}
              </div>
              <div className="flex items-center mt-2 text-sm">
                <div className="w-2 h-2 bg-green-500 rounded-full mr-2 animate-pulse"></div>
                <span className="text-green-600 font-medium">
                  {stats.loading ? 'Loading...' : 'Active'}
                </span>
                <span className="text-slate-500 ml-1">
                  {stats.activeScrapingCount === 1 ? 'event' : 'events'}
                </span>
              </div>
            </div>
            <div className="w-12 h-12 bg-gradient-to-br from-purple-500 to-purple-600 rounded-xl flex items-center justify-center">
              <Activity className="w-6 h-6 text-white" />
            </div>
          </div>
        </div>

        {/* Auto-Stop Status Card */}
        <div className="bg-white rounded-2xl shadow-sm border border-slate-200 p-6 hover:shadow-md transition-shadow duration-200">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium text-slate-500 mb-1">Auto-Stop</p>
              <div className="text-3xl font-bold text-slate-800">
                {autoDeleteInfo.loading ? (
                  <div className="w-16 h-8 bg-slate-200 rounded animate-pulse"></div>
                ) : (
                  autoDeleteInfo.count
                )}
              </div>
              <div className="flex items-center mt-2 text-sm">
                {autoDeleteInfo.isEnabled ? (
                  <>
                    <div className="w-2 h-2 bg-orange-500 rounded-full mr-2 animate-pulse"></div>
                    <span className="text-orange-600 font-medium">Pending</span>
                    <span className="text-slate-500 ml-1">stop</span>
                  </>
                ) : (
                  <>
                    <Shield className="w-4 h-4 text-slate-400 mr-1" />
                    <span className="text-slate-500 font-medium">Disabled</span>
                  </>
                )}
              </div>
            </div>
            <div className={`w-12 h-12 rounded-xl flex items-center justify-center ${
              autoDeleteInfo.isEnabled
                ? 'bg-gradient-to-br from-orange-500 to-orange-600'
                : 'bg-gradient-to-br from-slate-400 to-slate-500'
            }`}>
              <Timer className="w-6 h-6 text-white" />
            </div>
          </div>
        </div>
      </div>

      {/* Monthly Order Stats */}
      <div>
        <h3 className="text-lg font-semibold text-slate-800 mb-4">
          {new Date().toLocaleString('en-US', { month: 'long' })} Orders
        </h3>
        <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
          {/* Total Orders */}
          <div className="bg-white rounded-2xl shadow-sm border border-slate-200 p-5 hover:shadow-md transition-shadow duration-200">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium text-slate-500 mb-1">Total</p>
                <div className="text-3xl font-bold text-slate-800 tabular-nums">
                  {orderStats.loading ? <div className="w-12 h-8 bg-slate-200 rounded animate-pulse" /> : orderStats.totalOrders}
                </div>
              </div>
              <div className="w-11 h-11 bg-gradient-to-br from-slate-600 to-slate-700 rounded-xl flex items-center justify-center">
                <ShoppingCart className="w-5 h-5 text-white" />
              </div>
            </div>
          </div>

          {/* Delivered */}
          <div className="bg-white rounded-2xl shadow-sm border border-slate-200 p-5 hover:shadow-md transition-shadow duration-200">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium text-slate-500 mb-1">Delivered</p>
                <div className="text-3xl font-bold text-slate-800 tabular-nums">
                  {orderStats.loading ? <div className="w-12 h-8 bg-slate-200 rounded animate-pulse" /> : orderStats.delivered}
                </div>
              </div>
              <div className="w-11 h-11 bg-gradient-to-br from-emerald-500 to-emerald-600 rounded-xl flex items-center justify-center">
                <Package className="w-5 h-5 text-white" />
              </div>
            </div>
          </div>

          {/* Pending */}
          <div className="bg-white rounded-2xl shadow-sm border border-slate-200 p-5 hover:shadow-md transition-shadow duration-200">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium text-slate-500 mb-1">Pending</p>
                <div className={`text-3xl font-bold tabular-nums ${!orderStats.loading && orderStats.pending > 0 ? 'text-blue-600' : 'text-slate-800'}`}>
                  {orderStats.loading ? <div className="w-12 h-8 bg-slate-200 rounded animate-pulse" /> : orderStats.pending}
                </div>
              </div>
              <div className="w-11 h-11 bg-gradient-to-br from-blue-500 to-blue-600 rounded-xl flex items-center justify-center">
                <Clock className="w-5 h-5 text-white" />
              </div>
            </div>
          </div>

          {/* Rejected */}
          <div className="bg-white rounded-2xl shadow-sm border border-slate-200 p-5 hover:shadow-md transition-shadow duration-200">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium text-slate-500 mb-1">Rejected</p>
                <div className={`text-3xl font-bold tabular-nums ${!orderStats.loading && orderStats.rejected > 0 ? 'text-red-600' : 'text-slate-800'}`}>
                  {orderStats.loading ? <div className="w-12 h-8 bg-slate-200 rounded animate-pulse" /> : orderStats.rejected}
                </div>
              </div>
              <div className={`w-11 h-11 rounded-xl flex items-center justify-center ${!orderStats.loading && orderStats.rejected > 0 ? 'bg-gradient-to-br from-red-500 to-red-600' : 'bg-gradient-to-br from-slate-400 to-slate-500'}`}>
                <XCircle className="w-5 h-5 text-white" />
              </div>
            </div>
          </div>

          {/* Fill Rate */}
          {(() => {
            const rate = orderStats.fulfillRate;
            const iconGradient = rate >= 80 ? 'from-emerald-500 to-emerald-600' : rate >= 50 ? 'from-amber-500 to-amber-600' : 'from-red-500 to-red-600';
            const valueColor = rate >= 80 ? 'text-emerald-600' : rate >= 50 ? 'text-amber-600' : 'text-red-600';
            return (
              <div className="bg-white rounded-2xl shadow-sm border border-slate-200 p-5 hover:shadow-md transition-shadow duration-200">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-sm font-medium text-slate-500 mb-1">Fill Rate</p>
                    <div className={`text-3xl font-bold tabular-nums ${orderStats.loading ? 'text-slate-800' : valueColor}`}>
                      {orderStats.loading ? <div className="w-12 h-8 bg-slate-200 rounded animate-pulse" /> : `${rate}%`}
                    </div>
                  </div>
                  <div className={`w-11 h-11 bg-gradient-to-br ${orderStats.loading ? 'from-slate-400 to-slate-500' : iconGradient} rounded-xl flex items-center justify-center`}>
                    <CheckCircle2 className="w-5 h-5 text-white" />
                  </div>
                </div>
              </div>
            );
          })()}
        </div>
      </div>

      {/* Processing Time Chart & Quick Actions */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
        {/* Order Processing Time Chart */}
        <div className="lg:col-span-2">
          <div className="bg-white rounded-2xl shadow-sm border border-slate-200 p-6">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between mb-5 gap-3">
              <div>
                <h3 className="text-lg font-semibold text-slate-800">Order Processing Time</h3>
                <p className="text-sm text-slate-500 mt-0.5">Invoiced to confirmed (under 60 min only)</p>
              </div>
              <div className="flex items-center flex-wrap gap-2">
                {/* Daily / Weekly / Monthly toggle */}
                <div className="flex items-center bg-slate-100 rounded-lg p-0.5">
                  {(['daily', 'weekly', 'monthly'] as const).map((v) => (
                    <button
                      key={v}
                      onClick={() => setProcView(v)}
                      className={`px-3 py-1.5 text-xs font-medium rounded-md transition-all ${
                        procView === v
                          ? 'bg-white text-slate-800 shadow-sm'
                          : 'text-slate-500 hover:text-slate-700'
                      }`}
                    >
                      {v.charAt(0).toUpperCase() + v.slice(1)}
                    </button>
                  ))}
                </div>
                {/* Month selector (daily only) */}
                {procView === 'daily' && (
                  <select
                    value={procMonth}
                    onChange={(e) => setProcMonth(Number(e.target.value))}
                    className="text-xs border border-slate-200 rounded-lg px-2 py-1.5 bg-white text-slate-700 focus:outline-none focus:ring-2 focus:ring-indigo-500"
                  >
                    {['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'].map((m, i) => (
                      <option key={i} value={i + 1}>{m}</option>
                    ))}
                  </select>
                )}
                <select
                  value={procYear}
                  onChange={(e) => setProcYear(Number(e.target.value))}
                  className="text-xs border border-slate-200 rounded-lg px-2 py-1.5 bg-white text-slate-700 focus:outline-none focus:ring-2 focus:ring-indigo-500"
                >
                  {[2024, 2025, 2026].map((y) => (
                    <option key={y} value={y}>{y}</option>
                  ))}
                </select>
              </div>
            </div>

            {procTime.loading ? (
              <div className="animate-pulse space-y-4">
                <div className="flex items-end gap-1 h-48 px-2">
                  {Array.from({ length: 12 }).map((_, i) => (
                    <div key={i} className="flex-1 bg-gradient-to-t from-slate-100 to-slate-50 rounded-full" style={{ height: `${50 + Math.sin(i) * 40}px` }} />
                  ))}
                </div>
                <div className="flex gap-3">
                  {[1,2,3].map(i => <div key={i} className="flex-1 h-14 bg-slate-50 rounded-xl" />)}
                </div>
              </div>
            ) : procTime.totalOrders === 0 ? (
              <div className="text-center py-14">
                <div className="w-14 h-14 bg-violet-50 rounded-2xl flex items-center justify-center mx-auto mb-3">
                  <Timer className="w-7 h-7 text-violet-300" />
                </div>
                <p className="text-slate-600 font-medium">No processing data yet</p>
                <p className="text-slate-400 text-sm mt-1">Confirmed orders will show up here</p>
              </div>
            ) : (
              <div className="space-y-4">
                {/* Inline stats row */}
                <div className="flex items-center gap-6 text-sm">
                  <div className="flex items-center gap-2">
                    <div className="w-8 h-8 rounded-lg bg-violet-100 flex items-center justify-center">
                      <Clock className="w-4 h-4 text-violet-600" />
                    </div>
                    <div>
                      <div className="font-bold text-violet-700 tabular-nums leading-tight">
                        {(() => { const m = procTime.overallAvgMinutes; return m >= 60 ? `${(m / 60).toFixed(1)}h` : `${m}m`; })()}
                      </div>
                      <div className="text-[10px] text-slate-400">avg time</div>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <div className="w-8 h-8 rounded-lg bg-blue-50 flex items-center justify-center">
                      <ShoppingCart className="w-4 h-4 text-blue-500" />
                    </div>
                    <div>
                      <div className="font-bold text-blue-600 tabular-nums leading-tight">{procTime.totalOrders}</div>
                      <div className="text-[10px] text-slate-400">orders</div>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <div className="w-8 h-8 rounded-lg bg-emerald-50 flex items-center justify-center">
                      <TrendingUp className="w-4 h-4 text-emerald-500" />
                    </div>
                    <div>
                      <div className="font-bold text-emerald-600 tabular-nums leading-tight">
                        {(() => { const w = procTime.data.filter(d => d.count > 0); if (!w.length) return '-'; const f = Math.min(...w.map(d => d.avgMinutes)); return f >= 60 ? `${(f / 60).toFixed(1)}h` : `${f}m`; })()}
                      </div>
                      <div className="text-[10px] text-slate-400">best avg</div>
                    </div>
                  </div>
                  {procTime.excludedCount > 0 && (
                    <div className="flex items-center gap-1.5 ml-auto text-[10px] text-slate-400">
                      <AlertTriangle className="w-3 h-3" />
                      {procTime.excludedCount} excluded (&gt;60m)
                    </div>
                  )}
                </div>

                {/* Chart area */}
                {(() => {
                  const fmtMin = (m: number) => {
                    if (m >= 60) return `${(m / 60).toFixed(1)}h`;
                    if (m >= 1) return `${m.toFixed(1)}m`;
                    if (m > 0) return `${Math.round(m * 60)}s`;
                    return '0';
                  };
                  const chartH = 220;

                  // Daily view: scatter plot with individual order dots
                  if (procView === 'daily' && procTime.orders && procTime.orders.length > 0) {
                    const orders = procTime.orders;
                    const maxMin = Math.max(...orders.map(o => o.minutes), 1);
                    const daysInMonth = new Date(procYear, procMonth, 0).getDate();
                    // Color based on speed: green (<5m), blue (5-15m), amber (15-30m), rose (30-60m)
                    const dotColor = (m: number) => {
                      if (m <= 5) return { bg: 'rgba(16,185,129,0.7)', border: 'rgba(16,185,129,1)', glow: 'rgba(16,185,129,0.3)' };
                      if (m <= 15) return { bg: 'rgba(99,102,241,0.7)', border: 'rgba(99,102,241,1)', glow: 'rgba(99,102,241,0.3)' };
                      if (m <= 30) return { bg: 'rgba(245,158,11,0.7)', border: 'rgba(245,158,11,1)', glow: 'rgba(245,158,11,0.3)' };
                      return { bg: 'rgba(244,63,94,0.7)', border: 'rgba(244,63,94,1)', glow: 'rgba(244,63,94,0.3)' };
                    };

                    return (
                      <div className="relative rounded-xl bg-gradient-to-b from-slate-50/80 to-white pt-3 pb-1 px-2">
                        {/* Color legend */}
                        <div className="flex items-center gap-3 mb-3 ml-10 text-[10px] text-slate-400">
                          <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-emerald-500 inline-block" /> &lt;5m</span>
                          <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-indigo-500 inline-block" /> 5-15m</span>
                          <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-amber-500 inline-block" /> 15-30m</span>
                          <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-rose-500 inline-block" /> 30-60m</span>
                        </div>
                        {/* Y-axis labels */}
                        <div className="absolute left-2 top-12 w-8 flex flex-col justify-between text-[9px] text-slate-300 tabular-nums text-right pointer-events-none" style={{ height: `${chartH}px` }}>
                          <span>{fmtMin(maxMin)}</span>
                          <span>{fmtMin(maxMin * 0.75)}</span>
                          <span>{fmtMin(maxMin * 0.5)}</span>
                          <span>{fmtMin(maxMin * 0.25)}</span>
                          <span>0</span>
                        </div>

                        {/* Scatter area */}
                        <div className="ml-10 mr-1 relative" style={{ height: `${chartH}px` }}>
                          {/* Grid lines */}
                          {[0, 0.25, 0.5, 0.75, 1].map((pct) => (
                            <div
                              key={pct}
                              className="absolute left-0 right-0 border-t border-dashed border-slate-100"
                              style={{ top: `${pct * chartH}px` }}
                            />
                          ))}

                          {/* Average line */}
                          {procTime.overallAvgMinutes > 0 && procTime.overallAvgMinutes <= maxMin && (
                            <div
                              className="absolute left-0 right-0 z-10 flex items-center pointer-events-none"
                              style={{ bottom: `${(procTime.overallAvgMinutes / maxMin) * chartH}px` }}
                            >
                              <div className="flex-1 border-t-2 border-violet-200" style={{ borderStyle: 'dashed' }} />
                              <span className="text-[9px] font-medium text-violet-500 bg-violet-50/80 px-1.5 py-0.5 rounded ml-1 whitespace-nowrap">
                                avg {fmtMin(procTime.overallAvgMinutes)}
                              </span>
                            </div>
                          )}

                          {/* Day column separators (subtle) */}
                          {Array.from({ length: daysInMonth + 1 }).map((_, i) => (
                            <div
                              key={i}
                              className="absolute top-0 bottom-0 border-l border-slate-50"
                              style={{ left: `${(i / daysInMonth) * 100}%` }}
                            />
                          ))}

                          {/* Order dots */}
                          {orders.map((order, idx) => {
                            const xPct = ((order.day - 0.5) / daysInMonth) * 100;
                            const yPct = (order.minutes / maxMin) * chartH;
                            const colors = dotColor(order.minutes);
                            const isHovered = hoveredDot === idx;
                            // Add slight horizontal jitter for overlapping dots on same day
                            const sameDay = orders.filter(o => o.day === order.day);
                            const posInDay = sameDay.indexOf(order);
                            const jitter = sameDay.length > 1 ? (posInDay - (sameDay.length - 1) / 2) * 1.2 : 0;

                            return (
                              <div
                                key={idx}
                                className="absolute z-20 transition-all duration-150"
                                style={{
                                  left: `calc(${xPct}% + ${jitter}px)`,
                                  bottom: `${yPct}px`,
                                  transform: `translate(-50%, 50%) ${isHovered ? 'scale(1.6)' : 'scale(1)'}`,
                                }}
                                onMouseEnter={() => setHoveredDot(idx)}
                                onMouseLeave={() => setHoveredDot(null)}
                              >
                                <div
                                  className="w-[10px] h-[10px] rounded-full cursor-pointer"
                                  style={{
                                    background: colors.bg,
                                    border: `1.5px solid ${colors.border}`,
                                    boxShadow: isHovered ? `0 0 10px ${colors.glow}, 0 0 20px ${colors.glow}` : `0 1px 3px ${colors.glow}`,
                                  }}
                                />
                                {/* Tooltip */}
                                {isHovered && (
                                  <div className="absolute bottom-6 left-1/2 -translate-x-1/2 z-40 pointer-events-none">
                                    <div className="bg-white/95 backdrop-blur text-slate-700 text-[11px] px-3 py-2.5 rounded-xl shadow-xl border border-slate-200/80 whitespace-nowrap min-w-[160px]">
                                      <div className="font-bold text-sm mb-1" style={{ color: colors.border }}>{fmtMin(order.minutes)}</div>
                                      <div className="text-slate-600 font-medium text-[11px] truncate max-w-[200px]">{order.event_name || 'Unknown event'}</div>
                                      <div className="text-slate-400 text-[10px] mt-0.5 space-y-0.5">
                                        <div>Order: {order.order_id}</div>
                                        {order.section && <div>Sec {order.section}{order.row ? ` / Row ${order.row}` : ''}</div>}
                                        {order.quantity > 0 && <div>Qty: {order.quantity}</div>}
                                      </div>
                                    </div>
                                    <div className="flex justify-center">
                                      <div className="w-2 h-2 bg-white border-b border-r border-slate-200/80 rotate-45 -mt-1" />
                                    </div>
                                  </div>
                                )}
                              </div>
                            );
                          })}
                        </div>

                        {/* X-axis day labels */}
                        <div className="ml-10 mr-1 flex mt-2">
                          {Array.from({ length: daysInMonth }).map((_, i) => {
                            const day = i + 1;
                            const showLabel = daysInMonth > 20 ? day % 5 === 0 || day === 1 : day % 3 === 0 || day === 1;
                            return (
                              <div key={i} className="flex-1 text-center">
                                <span className={`text-[9px] tabular-nums ${showLabel ? 'text-slate-400' : 'text-transparent'}`}>
                                  {day}
                                </span>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    );
                  }

                  // Weekly / Monthly: bar chart
                  const maxMin = Math.max(...procTime.data.map(d => d.avgMinutes), 0.1);
                  return (
                    <div className="relative bg-gradient-to-b from-slate-50/50 to-white rounded-xl pt-3 pb-1 px-2">
                      {/* Y-axis labels */}
                      <div className="absolute left-2 top-3 bottom-6 w-8 flex flex-col justify-between text-[9px] text-slate-300 tabular-nums text-right pointer-events-none">
                        <span>{fmtMin(maxMin)}</span>
                        <span>{fmtMin(maxMin / 2)}</span>
                        <span>0</span>
                      </div>

                      {/* Grid lines */}
                      <div className="ml-10 mr-1 relative" style={{ height: `${chartH}px` }}>
                        {[0, 0.5, 1].map((pct) => (
                          <div
                            key={pct}
                            className="absolute left-0 right-0 border-t border-dashed border-slate-100"
                            style={{ top: `${pct * chartH}px` }}
                          />
                        ))}

                        {/* Average line */}
                        {procTime.overallAvgMinutes > 0 && procTime.overallAvgMinutes <= maxMin && (
                          <div
                            className="absolute left-0 right-0 z-10 flex items-center"
                            style={{ bottom: `${(procTime.overallAvgMinutes / maxMin) * chartH}px` }}
                          >
                            <div className="flex-1 border-t border-violet-300" style={{ borderStyle: 'dashed' }} />
                            <span className="text-[9px] font-medium text-violet-500 bg-violet-50 px-1.5 py-0.5 rounded ml-1 whitespace-nowrap">
                              avg {fmtMin(procTime.overallAvgMinutes)}
                            </span>
                          </div>
                        )}

                        {/* Bars */}
                        <div className="flex items-end h-full gap-3">
                          {procTime.data.map((bar, index) => {
                            const pct = bar.avgMinutes / maxMin;
                            const barH = pct * chartH;
                            const isHovered = hoveredProcBar === index;
                            const hasData = bar.count > 0;
                            const opacity = hasData ? 0.4 + pct * 0.6 : 0;

                            return (
                              <div
                                key={index}
                                className="flex-1 flex flex-col items-center relative"
                                onMouseEnter={() => setHoveredProcBar(index)}
                                onMouseLeave={() => setHoveredProcBar(null)}
                                style={{ cursor: hasData ? 'pointer' : 'default' }}
                              >
                                <div
                                  className={`w-full transition-all duration-200 rounded-t-md ${isHovered && hasData ? 'scale-x-110' : ''}`}
                                  style={{
                                    height: `${hasData ? Math.max(barH, 2) : 0}px`,
                                    background: hasData
                                      ? `linear-gradient(to top, rgba(124,58,237,${opacity}), rgba(139,92,246,${opacity * 0.7}))`
                                      : 'transparent',
                                    boxShadow: isHovered && hasData ? '0 -4px 12px rgba(124,58,237,0.2)' : 'none',
                                  }}
                                >
                                  {isHovered && hasData && (
                                    <div className="absolute -top-[76px] left-1/2 -translate-x-1/2 z-30 pointer-events-none">
                                      <div className="bg-white text-slate-700 text-[11px] px-3 py-2 rounded-lg shadow-lg border border-slate-200 whitespace-nowrap">
                                        <div className="font-semibold text-violet-700 text-xs mb-0.5">{fmtMin(bar.avgMinutes)}</div>
                                        <div className="text-slate-500 space-x-2">
                                          <span>{bar.count} order{bar.count !== 1 ? 's' : ''}</span>
                                          <span className="text-slate-300">|</span>
                                          <span>med {fmtMin(bar.medianMinutes)}</span>
                                        </div>
                                        <div className="text-slate-400 text-[10px]">
                                          {fmtMin(bar.minMinutes)}~{fmtMin(bar.maxMinutes)}
                                        </div>
                                      </div>
                                      <div className="flex justify-center -mt-[1px]">
                                        <div className="w-2 h-2 bg-white border-b border-r border-slate-200 rotate-45 -mt-1" />
                                      </div>
                                    </div>
                                  )}
                                </div>
                                {!hasData && <div className="w-1 h-1 rounded-full bg-slate-200 mb-0" />}
                              </div>
                            );
                          })}
                        </div>
                      </div>

                      {/* X-axis labels */}
                      <div className="ml-10 mr-1 flex mt-1.5 gap-3">
                        {procTime.data.map((bar, index) => {
                          const isHovered = hoveredProcBar === index;
                          return (
                            <div key={index} className="flex-1 text-center overflow-hidden">
                              <span className={`text-[9px] tabular-nums transition-all ${
                                isHovered ? 'text-violet-600 font-semibold' : 'text-slate-300'
                              }`}>
                                {bar.label}
                              </span>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  );
                })()}
              </div>
            )}
          </div>
        </div>

        {/* Quick Actions */}
        <div className="lg:col-span-1">
          <div className="bg-white rounded-2xl shadow-sm border border-slate-200 p-6">
            <h3 className="text-lg font-semibold text-slate-800 mb-4">Quick Actions</h3>
            <div className="space-y-3">
              <button 
                onClick={() => handleQuickAction('add-event')}
                className="w-full flex items-center justify-between p-4 bg-gradient-to-r from-blue-50 to-indigo-50 hover:from-blue-100 hover:to-indigo-100 rounded-xl transition-all duration-200 group hover:shadow-md"
              >
                <div className="flex items-center">
                  <div className="w-10 h-10 bg-blue-500 rounded-lg flex items-center justify-center mr-3 group-hover:bg-blue-600 transition-colors">
                    <Plus className="w-5 h-5 text-white" />
                  </div>
                  <span className="font-medium text-slate-700">Add New Event</span>
                </div>
                <ArrowUpRight className="w-5 h-5 text-blue-500 group-hover:translate-x-1 group-hover:-translate-y-1 transition-transform duration-200" />
              </button>
              
              <button 
                onClick={() => handleQuickAction('manage-inventory')}
                className="w-full flex items-center justify-between p-4 bg-gradient-to-r from-emerald-50 to-green-50 hover:from-emerald-100 hover:to-green-100 rounded-xl transition-all duration-200 group hover:shadow-md"
              >
                <div className="flex items-center">
                  <div className="w-10 h-10 bg-emerald-500 rounded-lg flex items-center justify-center mr-3 group-hover:bg-emerald-600 transition-colors">
                    <Package className="w-5 h-5 text-white" />
                  </div>
                  <span className="font-medium text-slate-700">Manage Inventory</span>
                </div>
                <ArrowUpRight className="w-5 h-5 text-emerald-500 group-hover:translate-x-1 group-hover:-translate-y-1 transition-transform duration-200" />
              </button>
              
              <button 
                onClick={() => handleQuickAction('export-data')}
                className="w-full flex items-center justify-between p-4 bg-gradient-to-r from-purple-50 to-violet-50 hover:from-purple-100 hover:to-violet-100 rounded-xl transition-all duration-200 group hover:shadow-md"
              >
                <div className="flex items-center">
                  <div className="w-10 h-10 bg-purple-500 rounded-lg flex items-center justify-center mr-3 group-hover:bg-purple-600 transition-colors">
                    <Download className="w-5 h-5 text-white" />
                  </div>
                  <span className="font-medium text-slate-700">Export Data</span>
                </div>
                <ArrowUpRight className="w-5 h-5 text-purple-500 group-hover:translate-x-1 group-hover:-translate-y-1 transition-transform duration-200" />
              </button>
              
              <button 
                onClick={() => handleQuickAction('manage-exclusions')}
                className="w-full flex items-center justify-between p-4 bg-gradient-to-r from-orange-50 to-red-50 hover:from-orange-100 hover:to-red-100 rounded-xl transition-all duration-200 group hover:shadow-md"
              >
                <div className="flex items-center">
                  <div className="w-10 h-10 bg-orange-500 rounded-lg flex items-center justify-center mr-3 group-hover:bg-orange-600 transition-colors">
                    <Filter className="w-5 h-5 text-white" />
                  </div>
                  <span className="font-medium text-slate-700">Exclusion Rules</span>
                </div>
                <ArrowUpRight className="w-5 h-5 text-orange-500 group-hover:translate-x-1 group-hover:-translate-y-1 transition-transform duration-200" />
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Upcoming Auto-Delete Events */}
      <div className="bg-white rounded-2xl shadow-sm border border-slate-200 overflow-hidden">
        {/* Header with auto-delete info */}
        <div className="px-6 py-5 border-b border-slate-100 bg-gradient-to-r from-red-50 via-orange-50 to-amber-50">
          <div className="flex items-center justify-between">
            <div className="flex items-center space-x-3">
              <div className={`w-10 h-10 rounded-xl flex items-center justify-center ${
                autoDeleteInfo.isEnabled
                  ? 'bg-gradient-to-br from-red-500 to-orange-500'
                  : 'bg-slate-300'
              }`}>
                <Timer className="w-5 h-5 text-white" />
              </div>
              <div>
                <h3 className="text-lg font-semibold text-slate-800">Upcoming Auto-Stop</h3>
                <p className="text-sm text-slate-500">
                  Events that will be stopped{' '}
                  <span className="font-medium text-orange-600">{autoDeleteInfo.stopBeforeMinutes}min</span>{' '}
                  before event time (inventory cleared, event kept in DB)
                </p>
              </div>
            </div>
            <div className="flex items-center space-x-3">
              {/* Settings summary badges */}
              <div className="hidden sm:flex items-center space-x-2">
                <span className={`inline-flex items-center px-2.5 py-1 rounded-full text-xs font-medium ${
                  autoDeleteInfo.isEnabled 
                    ? 'bg-green-100 text-green-700' 
                    : 'bg-slate-100 text-slate-500'
                }`}>
                  {autoDeleteInfo.isEnabled ? (
                    <><CheckCircle2 className="w-3 h-3 mr-1" /> Enabled</>
                  ) : (
                    <><Shield className="w-3 h-3 mr-1" /> Disabled</>
                  )}
                </span>
                <span className="inline-flex items-center px-2.5 py-1 rounded-full text-xs font-medium bg-blue-100 text-blue-700">
                  <Clock className="w-3 h-3 mr-1" />
                  Every {autoDeleteInfo.scheduleIntervalMinutes}m
                </span>
              </div>
              <button
                onClick={() => handleQuickAction('export-data')}
                className="text-sm text-blue-600 hover:text-blue-700 font-medium flex items-center hover:bg-blue-50 px-3 py-1.5 rounded-lg transition-colors"
              >
                Settings
                <ArrowUpRight className="w-3.5 h-3.5 ml-1" />
              </button>
            </div>
          </div>
        </div>

        {/* Content */}
        <div className="p-6">
          {autoDeleteInfo.loading ? (
            <div className="space-y-3">
              {[1, 2, 3].map((i) => (
                <div key={i} className="animate-pulse flex items-center space-x-4 p-3">
                  <div className="w-10 h-10 bg-slate-200 rounded-lg"></div>
                  <div className="flex-1 space-y-2">
                    <div className="h-4 bg-slate-200 rounded w-2/3"></div>
                    <div className="h-3 bg-slate-200 rounded w-1/3"></div>
                  </div>
                  <div className="w-20 h-6 bg-slate-200 rounded-full"></div>
                </div>
              ))}
            </div>
          ) : !autoDeleteInfo.isEnabled ? (
            <div className="text-center py-10">
              <div className="w-16 h-16 bg-slate-100 rounded-2xl flex items-center justify-center mx-auto mb-4">
                <Shield className="w-8 h-8 text-slate-400" />
              </div>
              <p className="text-slate-600 font-medium mb-1">Auto-Stop is Disabled</p>
              <p className="text-slate-400 text-sm mb-4">
                Enable auto-stop in settings to automatically stop scraping and clear inventory before events take place.
              </p>
              <button
                onClick={() => handleQuickAction('export-data')}
                className="inline-flex items-center px-4 py-2 text-sm font-medium text-blue-600 bg-blue-50 hover:bg-blue-100 rounded-lg transition-colors"
              >
                Go to Settings
                <ArrowUpRight className="w-4 h-4 ml-1" />
              </button>
            </div>
          ) : autoDeleteInfo.count === 0 ? (
            <div className="text-center py-10">
              <div className="w-16 h-16 bg-green-50 rounded-2xl flex items-center justify-center mx-auto mb-4">
                <CheckCircle2 className="w-8 h-8 text-green-500" />
              </div>
              <p className="text-green-700 font-medium mb-1">All Clear!</p>
              <p className="text-slate-400 text-sm">
                No events are within the {autoDeleteInfo.stopBeforeMinutes}-minute stop window right now.
                Checking every {autoDeleteInfo.scheduleIntervalMinutes} minutes.
              </p>
            </div>
          ) : (
            <div>
              {/* Warning banner */}
              <div className="flex items-start space-x-3 p-3 bg-amber-50 border border-amber-200 rounded-xl mb-4">
                <AlertTriangle className="w-5 h-5 text-amber-500 mt-0.5 flex-shrink-0" />
                <div>
                  <p className="text-sm font-medium text-amber-800">
                    {autoDeleteInfo.count} event{autoDeleteInfo.count !== 1 ? 's' : ''} will be stopped on the next run
                  </p>
                  <p className="text-xs text-amber-600 mt-0.5">
                    These events are within {autoDeleteInfo.stopBeforeMinutes} minutes of their event time. Scraping will be stopped and inventory cleared.
                  </p>
                </div>
              </div>

              {/* Events list */}
              <div className="space-y-2">
                {(showAllDeleteEvents ? autoDeleteInfo.events : autoDeleteInfo.events.slice(0, 5)).map((event, index) => (
                  <div
                    key={event.id || index}
                    className="flex items-center space-x-4 p-3 rounded-xl hover:bg-red-50/50 transition-colors duration-150 border border-transparent hover:border-red-100"
                  >
                    {/* Icon */}
                    <div className="w-10 h-10 bg-gradient-to-br from-amber-100 to-orange-100 rounded-lg flex items-center justify-center flex-shrink-0">
                      <Shield className="w-5 h-5 text-amber-500" />
                    </div>

                    {/* Event info */}
                    <div className="flex-1 min-w-0">
                      <h4 className="text-sm font-medium text-slate-800 truncate">{event.name}</h4>
                      <div className="flex items-center space-x-3 mt-0.5">
                        {event.venue && (
                          <span className="text-xs text-slate-500 flex items-center truncate max-w-[180px]">
                            <MapPin className="w-3 h-3 mr-1 flex-shrink-0" />
                            {event.venue}
                          </span>
                        )}
                        <span className="text-xs text-slate-400">
                          {formatDateTime(event.dateTime)}
                        </span>
                      </div>
                    </div>

                    {/* Timezone badge */}
                    {event.detectedTimezone && (
                      <span className="hidden sm:inline-flex px-2 py-0.5 rounded-full text-xs font-medium bg-blue-100 text-blue-700 flex-shrink-0">
                        {event.detectedTimezone}
                      </span>
                    )}

                    {/* Status badges */}
                    <div className="flex items-center space-x-2 flex-shrink-0">
                      <span className={`inline-flex px-2 py-0.5 rounded-full text-xs font-medium ${
                        event.isStopped
                          ? 'bg-red-100 text-red-700'
                          : 'bg-green-100 text-green-700'
                      }`}>
                        {event.isStopped ? 'Stopped' : 'Active'}
                      </span>
                      <span className="inline-flex px-2 py-0.5 rounded-full text-xs font-medium bg-orange-100 text-orange-700">
                        {getTimeUntilDelete(event.dateTime, autoDeleteInfo.stopBeforeMinutes)}
                      </span>
                    </div>
                  </div>
                ))}
              </div>

              {/* Show more / Show less toggle */}
              {autoDeleteInfo.events.length > 5 && (
                <button
                  onClick={() => setShowAllDeleteEvents(!showAllDeleteEvents)}
                  className="w-full mt-3 flex items-center justify-center space-x-2 py-2.5 text-sm font-medium text-slate-600 hover:text-slate-800 bg-slate-50 hover:bg-slate-100 rounded-xl transition-colors duration-150"
                >
                  {showAllDeleteEvents ? (
                    <>
                      <ChevronUp className="w-4 h-4" />
                      <span>Show Less</span>
                    </>
                  ) : (
                    <>
                      <ChevronDown className="w-4 h-4" />
                      <span>Show {autoDeleteInfo.events.length - 5} More Events</span>
                    </>
                  )}
                </button>
              )}

              {/* Skipped events warning */}
              {(autoDeleteInfo.skippedCount ?? 0) > 0 && (
                <div className="mt-3 text-xs text-orange-600 flex items-center">
                  <AlertTriangle className="w-3 h-3 mr-1" />
                  {autoDeleteInfo.skippedCount} event{autoDeleteInfo.skippedCount !== 1 ? 's' : ''} skipped — timezone could not be detected from venue
                </div>
              )}
            </div>
          )}

          {/* Last run info */}
          {autoDeleteInfo.isEnabled && autoDeleteInfo.lastRunAt && (
            <div className="mt-4 pt-4 border-t border-slate-100 flex items-center justify-between text-xs text-slate-400">
              <span>Last checked: {formatDateTime(autoDeleteInfo.lastRunAt)}</span>
              <span>Total stopped: {autoDeleteInfo.totalEventsDeleted} events</span>
            </div>
          )}
        </div>
      </div>

      {/* Recently Auto-Stopped Events */}
      {lastDeletedEvents.length > 0 && (
        <div className="bg-white rounded-2xl shadow-sm border border-slate-200 overflow-hidden">
          <div className="px-6 py-5 border-b border-slate-100 bg-gradient-to-r from-amber-50 via-orange-50 to-rose-50">
            <div className="flex items-center justify-between">
              <div className="flex items-center space-x-3">
                <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-amber-500 to-orange-500 flex items-center justify-center">
                  <Shield className="w-5 h-5 text-white" />
                </div>
                <div>
                  <h3 className="text-lg font-semibold text-slate-800">Recently Auto-Stopped</h3>
                  <p className="text-sm text-slate-500">{lastDeletedEvents.length} event{lastDeletedEvents.length !== 1 ? 's' : ''} stopped &amp; inventory cleared (auto-clears after 24h)</p>
                </div>
              </div>
              {lastDeletedEvents.length > 5 && (
                <button
                  onClick={() => setShowAllStoppedEvents(!showAllStoppedEvents)}
                  className="flex items-center gap-1 px-3 py-1.5 text-xs font-medium text-orange-700 bg-orange-100 hover:bg-orange-200 rounded-lg transition-colors"
                >
                  {showAllStoppedEvents ? (
                    <>Show Less <ChevronUp className="w-3 h-3" /></>
                  ) : (
                    <>Show All ({lastDeletedEvents.length}) <ChevronDown className="w-3 h-3" /></>
                  )}
                </button>
              )}
            </div>
          </div>
          <div className="p-6">
            <div className="space-y-3">
              {(showAllStoppedEvents ? lastDeletedEvents : lastDeletedEvents.slice(0, 5)).map((evt, i) => (
                <div
                  key={`${evt.eventId}-${i}`}
                  className="p-4 rounded-xl bg-gradient-to-r from-slate-50 to-amber-50/30 border border-slate-100 hover:border-amber-200 transition-colors"
                >
                  <div className="flex items-start justify-between">
                    <div className="flex-1 min-w-0">
                      <h4 className="text-sm font-semibold text-slate-800 truncate">{evt.eventName}</h4>
                      {evt.venue && (
                        <div className="flex items-center mt-1">
                          <MapPin className="w-3 h-3 mr-1 text-slate-400 flex-shrink-0" />
                          <span className="text-xs text-slate-500 truncate">{evt.venue}</span>
                        </div>
                      )}
                    </div>
                    <span className="ml-3 inline-flex px-2 py-0.5 rounded-full text-[10px] font-medium bg-amber-100 text-amber-700 flex-shrink-0">
                      Stopped
                    </span>
                  </div>

                  {/* Dual Timezone Display */}
                  <div className="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-2">
                    {/* Pakistan Time */}
                    <div className="flex items-center space-x-2 px-3 py-2 rounded-lg bg-green-50 border border-green-100">
                      <div className="w-6 h-6 rounded-md bg-green-500 flex items-center justify-center flex-shrink-0">
                        <span className="text-[9px] font-bold text-white">PKT</span>
                      </div>
                      <div>
                        <div className="text-[10px] text-green-600 font-medium">Pakistan Time</div>
                        <div className="text-xs font-semibold text-green-800 tabular-nums">{evt.pktTimeAtDeletion}</div>
                      </div>
                    </div>
                    {/* Event Location Time */}
                    <div className="flex items-center space-x-2 px-3 py-2 rounded-lg bg-blue-50 border border-blue-100">
                      <div className="w-6 h-6 rounded-md bg-blue-500 flex items-center justify-center flex-shrink-0">
                        <span className="text-[9px] font-bold text-white">{evt.timezoneAbbr || 'TZ'}</span>
                      </div>
                      <div>
                        <div className="text-[10px] text-blue-600 font-medium">Event Location</div>
                        <div className="text-xs font-semibold text-blue-800 tabular-nums">{evt.localTimeAtDeletion}</div>
                      </div>
                    </div>
                  </div>

                  {/* Event date + stopped time */}
                  <div className="mt-2 flex items-center justify-between text-[10px] text-slate-400">
                    <span>Event: {formatDateTime(evt.eventDateTime)}</span>
                    <span>Stopped: {formatDateTime(evt.deletedAt)}</span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Recent Events */}
      <div className="bg-white rounded-2xl shadow-sm border border-slate-200 p-6">
        <div className="flex items-center justify-between mb-6">
          <h3 className="text-lg font-semibold text-slate-800">Recent Events</h3>
          <button 
            onClick={() => handleQuickAction('view-all-events')}
            className="text-blue-600 hover:text-blue-700 font-medium text-sm flex items-center transition-colors duration-200 hover:bg-blue-50 px-3 py-1 rounded-lg"
          >
            View All
            <ArrowUpRight className="w-4 h-4 ml-1" />
          </button>
        </div>
        
        {stats.loading ? (
          <div className="space-y-4">
            {[1, 2, 3].map((i) => (
              <div key={i} className="animate-pulse">
                <div className="flex items-center space-x-4">
                  <div className="w-12 h-12 bg-slate-200 rounded-lg"></div>
                  <div className="flex-1">
                    <div className="h-4 bg-slate-200 rounded w-3/4 mb-2"></div>
                    <div className="h-3 bg-slate-200 rounded w-1/2"></div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        ) : stats.recentEvents.length === 0 ? (
          <div className="text-center py-12">
            <Calendar className="w-12 h-12 text-slate-300 mx-auto mb-4" />
            <p className="text-slate-500 font-medium">No recent events</p>
            <p className="text-slate-400 text-sm">Events will appear here once you add them</p>
          </div>
        ) : (
          <div className="space-y-4">
            {stats.recentEvents.map((event) => (
              <div key={event._id} className="flex items-center space-x-4 p-4 hover:bg-slate-50 rounded-xl transition-colors duration-200">
                <div className="w-12 h-12 bg-gradient-to-br from-blue-100 to-indigo-100 rounded-lg flex items-center justify-center">
                  <Calendar className="w-6 h-6 text-blue-600" />
                </div>
                <div className="flex-1 min-w-0">
                  <h4 className="font-medium text-slate-800 truncate">{event.Event_Name}</h4>
                  <div className="flex items-center space-x-4 mt-1">
                    <span className="text-sm text-slate-500">{event.Venue || 'N/A'}</span>
                    <span className="text-sm text-slate-400">•</span>
                    <span className="text-sm text-slate-500">
                      {event.Event_DateTime ? formatDate(event.Event_DateTime) : 'N/A'}
                    </span>
                  </div>
                </div>
                <div className="text-right">
                  <div className="text-sm font-medium text-slate-800">{event.Available_Seats || 0} seats</div>
                  <div className="text-xs text-slate-400">available</div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
