'use client';

import React, { useState, useEffect, useRef, useCallback } from 'react';
import moment from 'moment';
import { Download, Upload, Settings, BarChart3, Clock, Trash2, AlertTriangle, Play, Square, RefreshCw, Eye, Zap, Shield, ChevronDown, CheckCircle2, XCircle, Timer } from 'lucide-react';
import { deleteStaleInventory } from '../../../actions/seatActions';

// Simple toast notification function
const showMessage = (text: string, type: 'success' | 'error' | 'info' = 'info') => {
  const toast = document.createElement('div');
  toast.className = `fixed top-4 right-4 px-5 py-3 rounded-xl text-sm font-medium z-50 shadow-lg border backdrop-blur-sm transition-all ${
    type === 'success' ? 'bg-green-50 text-green-800 border-green-200' :
    type === 'error' ? 'bg-red-50 text-red-800 border-red-200' : 'bg-blue-50 text-blue-800 border-blue-200'
  }`;
  toast.textContent = text;
  document.body.appendChild(toast);
  setTimeout(() => {
    if (toast.parentNode) document.body.removeChild(toast);
  }, 3000);
};

interface ExportSettings {
  uploadToSync: boolean;
  scheduleRateMinutes: number;
  isScheduled: boolean;
  eventUpdateFilterMinutes: number;
  lowSeatAutoStop: boolean;
  lowSeatThreshold: number;
  minSeatFilter: number;
  minSeatFilterMode: 'row' | 'section';
}

interface CsvStatus {
  lastUpload: string | null;
  lastGenerated: string | null;
  status: string;
}

interface AutoDeleteSettings {
  isEnabled: boolean;
  stopBeforeMinutes: number;
  scheduleIntervalMinutes: number;
  postEventDeleteEnabled: boolean;
  postEventDeleteHoursAfter: number;
  lastRunAt: string | null;
  nextRunAt: string | null;
  totalRuns: number;
  totalEventsDeleted: number;
  lastRunStats: LastRunStats | null;
  schedulerStatus: string;
}

interface EventPreview {
  id: string;
  name: string;
  dateTime: string;
  venue?: string;
  isStopped?: boolean;
  detectedTimezone?: string;
  localTimeNow?: string;
}

interface AutoDeletePreview {
  count: number;
  totalEvents: number;
  skippedCount?: number;
  events: EventPreview[];
  skippedEvents?: EventPreview[];
  stopBeforeMinutes: number;
}

interface LastRunStats {
  eventsChecked: number;
  eventsDeleted: number;
  eventsStopped: number;
  errors?: string[];
}

interface PerformanceMetrics {
  totalRuns?: number;
  lastGenerated?: string;
  lastRunTime?: string;
  nextRunTime?: string;
  lastUploadAt?: string;
  lastUploadStatus?: string;
  lastUploadId?: string;
  lastUploadError?: string;
  lastClearAt?: string;
  lastCsvGenerated?: string;
  lastRunAt?: string;
  nextRunAt?: string;
  lastManualGeneration?: {
    recordCount: number;
    generationTime: number;
    totalTime?: number;
    timestamp: string;
  };
}

const ExportCsvPage: React.FC = () => {
  const [settings, setSettings] = useState<ExportSettings>({
    uploadToSync: false,
    scheduleRateMinutes: 60,
    isScheduled: false,
    eventUpdateFilterMinutes: 0,
    lowSeatAutoStop: false,
    lowSeatThreshold: 10,
    minSeatFilter: 0,
    minSeatFilterMode: 'section',
  });
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const [schedulerStatus, setSchedulerStatus] = useState<string>('Stopped');
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const [csvStatus, setCsvStatus] = useState<CsvStatus>({
    lastUpload: null,
    lastGenerated: null,
    status: 'Idle',
  });
  const [loading, setLoading] = useState<boolean>(false);
  const [performanceMetrics, setPerformanceMetrics] = useState<PerformanceMetrics | null>(null);
  const [staleCleanupStatus, setStaleCleanupStatus] = useState('');
  const [isCleaningStaleInventory, setIsCleaningStaleInventory] = useState(false);
  const [showStaleCleanupDialog, setShowStaleCleanupDialog] = useState(false);

  // Danger-Zone manual CSV upload (only path allowed to push a blank CSV to Sync)
  const [dangerFile, setDangerFile] = useState<File | null>(null);
  const [dangerStatus, setDangerStatus] = useState('');
  const [isDangerUploading, setIsDangerUploading] = useState(false);
  const dangerUpload = async () => {
    if (!dangerFile) {
      setDangerStatus('❌ Pick a .csv file first.');
      return;
    }
    const confirmed = window.confirm(
      `Upload "${dangerFile.name}" (${dangerFile.size} bytes) directly to Sync?\n\n` +
      `This is the ONLY path that bypasses the no-blank-CSV safety check. ` +
      `Scheduler and manual exports will never send empty CSVs.`
    );
    if (!confirmed) return;

    setIsDangerUploading(true);
    setDangerStatus('Uploading…');
    try {
      const fd = new FormData();
      fd.append('file', dangerFile);
      fd.append('confirm', 'UPLOAD');
      const res = await fetch('/api/danger-upload-csv', { method: 'POST', body: fd });
      const data = await res.json();
      if (res.ok && data.success) {
        setDangerStatus(`✅ ${data.message}${data.uploadId ? ` (uploadId ${data.uploadId})` : ''}`);
        setDangerFile(null);
      } else {
        setDangerStatus(`❌ ${data.message || 'Upload failed'}`);
      }
    } catch (e) {
      setDangerStatus(`❌ ${(e as Error).message}`);
    } finally {
      setIsDangerUploading(false);
    }
  };

  // Feature flags — UI visibility (true when "enabled", false when "hidden" or "disabled")
  const [featureFlags, setFeatureFlags] = useState({
    csvScheduler: true, csvManualExport: true, csvDownload: true,
    minSeatFilter: true, lowSeatAutoStop: true, autoDelete: true,
  });

  useEffect(() => {
    fetch('/api/feature-flags')
      .then(res => res.json())
      .then(data => {
        if (data.success && data.flags) {
          setFeatureFlags(prev => {
            const merged = { ...prev };
            for (const key of Object.keys(prev) as (keyof typeof prev)[]) {
              const val = data.flags[key];
              if (val !== undefined) {
                // "enabled" or legacy true → visible; everything else → hidden
                merged[key] = (val === true || val === 'enabled');
              }
            }
            return merged;
          });
        }
      })
      .catch(() => {});
  }, []);

  // Auto-delete state
  const [autoDeleteSettings, setAutoDeleteSettings] = useState<AutoDeleteSettings>({
    isEnabled: false,
    stopBeforeMinutes: 120,
    scheduleIntervalMinutes: 15,
    postEventDeleteEnabled: false,
    postEventDeleteHoursAfter: 12,
    lastRunAt: null,
    nextRunAt: null,
    totalRuns: 0,
    totalEventsDeleted: 0,
    lastRunStats: null,
    schedulerStatus: 'Stopped'
  });
  const [autoDeletePreview, setAutoDeletePreview] = useState<AutoDeletePreview | null>(null);
  const [showAutoDeletePreview, setShowAutoDeletePreview] = useState(false);
  const [isLoadingAutoDelete, setIsLoadingAutoDelete] = useState(false);

  // Live countdown timer for next scheduled run
  const [countdown, setCountdown] = useState<string>('');
  const countdownRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const formatCountdown = useCallback((ms: number): string => {
    if (ms <= 0) return 'Now';
    const totalSec = Math.floor(ms / 1000);
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const s = totalSec % 60;
    if (h > 0) return `${h}h ${m}m ${s}s`;
    if (m > 0) return `${m}m ${s}s`;
    return `${s}s`;
  }, []);

  useEffect(() => {
    if (countdownRef.current) clearInterval(countdownRef.current);
    if (!settings.isScheduled || !performanceMetrics?.nextRunAt) {
      setCountdown('');
      return;
    }
    const tick = () => {
      const diff = moment(performanceMetrics.nextRunAt).diff(moment());
      setCountdown(diff > 0 ? formatCountdown(diff) : 'Running...');
    };
    tick();
    countdownRef.current = setInterval(tick, 1000);
    return () => { if (countdownRef.current) clearInterval(countdownRef.current); };
  }, [settings.isScheduled, performanceMetrics?.nextRunAt, formatCountdown]);

  // Load settings from database on component mount
  useEffect(() => {
    const loadSettings = async () => {
      try {
        const response = await fetch('/api/csv-scheduler');
        if (response.ok) {
          const data = await response.json();
          const dbSettings = data.settings;
          setSettings({
            scheduleRateMinutes: dbSettings.scheduleRateMinutes,
            uploadToSync: dbSettings.uploadToSync,
            isScheduled: dbSettings.isRunning,
            eventUpdateFilterMinutes: dbSettings.eventUpdateFilterMinutes || 0,
            lowSeatAutoStop: dbSettings.lowSeatAutoStop ?? false,
            lowSeatThreshold: dbSettings.lowSeatThreshold ?? 10,
            minSeatFilter: dbSettings.minSeatFilter ?? 0,
            minSeatFilterMode: dbSettings.minSeatFilterMode ?? 'section',
          });
          setSchedulerStatus(dbSettings.isRunning ? 'Running' : 'Stopped');
          setPerformanceMetrics({
            totalRuns: dbSettings.totalRuns,
            lastRunAt: dbSettings.lastRunAt,
            nextRunAt: dbSettings.nextRunAt,
            lastCsvGenerated: dbSettings.lastCsvGenerated
          });
        }
      } catch (error) {
        console.error('Failed to load settings:', error);
        showMessage('Failed to load scheduler settings', 'error');
      }
    };
    
    loadSettings();
  }, []);

  // Load auto-delete settings
  useEffect(() => {
    const loadAutoDeleteSettings = async () => {
      try {
        const response = await fetch('/api/auto-delete');
        if (response.ok) {
          const data = await response.json();
          setAutoDeleteSettings(data.settings);
        }
      } catch (error) {
        console.error('Failed to load auto-delete settings:', error);
      }
    };
    
    loadAutoDeleteSettings();
  }, []);


  const handleGenerateCsv = async () => {
    setLoading(true);
    setCsvStatus(prev => ({ ...prev, status: 'Generating...' }));
    const startTime = Date.now();

    try {
      // Use API route instead of server action to avoid payload size limits
      // for large CSVs (100+ events). The API route streams the CSV as a file.
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 300000); // 5 minute timeout

      const response = await fetch('/api/generate-csv', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ eventUpdateFilterMinutes: settings.eventUpdateFilterMinutes }),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        const errorData = await response.json().catch(() => null);
        throw new Error(errorData?.message || `Server error: ${response.status}`);
      }

      const contentType = response.headers.get('Content-Type') || '';
      if (contentType.includes('application/json')) {
        const errorData = await response.json();
        setCsvStatus(prev => ({ ...prev, status: 'Generation failed' }));
        showMessage(errorData.message || 'Failed to generate CSV', 'error');
        return;
      }

      // Stream response as blob for download
      const blob = await response.blob();
      const csvText = await blob.text();

      // Check if stream returned an error instead of CSV data
      if (csvText.startsWith('ERROR:')) {
        setCsvStatus(prev => ({ ...prev, status: 'Generation failed' }));
        showMessage(csvText.replace('ERROR: ', ''), 'error');
        return;
      }

      // Count records from CSV content (lines - 1 for header)
      const lineCount = csvText.split('\n').filter(l => l.trim()).length;
      const records = Math.max(0, lineCount - 1);

      const downloadBlob = new Blob([csvText], { type: 'text/csv' });
      const url = window.URL.createObjectURL(downloadBlob);
      const a = document.createElement('a');
      a.style.display = 'none';
      a.href = url;
      a.download = `inventory-${moment().format('YYYY-MM-DD-HH-mm-ss')}.csv`;
      document.body.appendChild(a);
      a.click();
      window.URL.revokeObjectURL(url);
      document.body.removeChild(a);

      const totalTime = Date.now() - startTime;
      setCsvStatus(prev => ({
        ...prev,
        lastGenerated: moment().toISOString(),
        status: `Generated successfully! (${records} records in ${totalTime}ms)`
      }));
      showMessage(`CSV generated and downloaded successfully! ${records} records in ${totalTime}ms`, 'success');

      setPerformanceMetrics((prev: PerformanceMetrics | null) => ({
        ...prev,
        lastManualGeneration: {
          recordCount: records,
          generationTime: totalTime,
          totalTime: totalTime,
          timestamp: new Date().toISOString()
        }
      }));
    } catch (error) {
      console.error('CSV Generation Error:', error);
      setCsvStatus(prev => ({ ...prev, status: 'Generation failed' }));
      if (error instanceof Error && error.name === 'AbortError') {
        showMessage('CSV generation timed out. The dataset may be too large — try using the Event Update Filter to limit results.', 'error');
      } else {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error generating CSV';
        showMessage(`Error generating CSV: ${errorMessage}`, 'error');
      }
    } finally {
      setLoading(false);
    }
  };

  const handleUploadCsv = async () => {
    setLoading(true);
    const startTime = Date.now();
    showMessage('Uploading CSV...', 'info');
    try {
      // Call the API route that handles both generation and upload server-side
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 300000); // 5 minute timeout

      const response = await fetch('/api/export-csv', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          eventUpdateFilterMinutes: settings.eventUpdateFilterMinutes
        }),
        signal: controller.signal
      });

      clearTimeout(timeoutId);
      const totalTime = Date.now() - startTime;

      const result = await response.json();

      if (result.success) {
        showMessage('CSV uploaded to sync service successfully!', 'success');
        setCsvStatus(prev => ({
          ...prev,
          lastUpload: moment().toISOString(),
          status: 'Uploaded'
        }));

        // Update performance metrics with the upload info
        setPerformanceMetrics((prev: PerformanceMetrics | null) => ({
          ...prev,
          lastUploadAt: new Date().toISOString(),
          lastUploadStatus: 'success',
          lastUploadId: result.uploadId,
          lastManualGeneration: {
            recordCount: result.recordCount,
            generationTime: result.generationTime,
            totalTime: totalTime,
            timestamp: new Date().toISOString()
          }
        }));
      } else {
        showMessage(result.message || 'Failed to upload CSV.', 'error');
      }
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        console.error('Request timed out:', error);
        showMessage('Upload request timed out. Please try again.', 'error');
      } else {
        console.error('Error uploading CSV:', error);
        showMessage('Error uploading CSV.', 'error');
      }
    }
    setLoading(false);
  };

  const handleStartScheduler = async () => {
    try {
      const response = await fetch('/api/csv-scheduler', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          action: 'start', 
          intervalMinutes: settings.scheduleRateMinutes,
          uploadToSync: settings.uploadToSync,
          eventUpdateFilterMinutes: settings.eventUpdateFilterMinutes
        })
      });
      
      if (response.ok) {
        setSettings(prev => ({ ...prev, isScheduled: true }));
        setSchedulerStatus('Running');
        showMessage(`Scheduler started - CSV will be generated every ${settings.scheduleRateMinutes} minutes`, 'success');
      } else {
        showMessage('Failed to start scheduler', 'error');
      }
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    } catch (_error) {
      showMessage('Error starting scheduler', 'error');
    }
  };

  const handleStopScheduler = async () => {
    try {
      const response = await fetch('/api/csv-scheduler', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'stop' })
      });
      
      if (response.ok) {
        setSettings(prev => ({ ...prev, isScheduled: false }));
        setSchedulerStatus('Stopped');
        showMessage('Scheduler stopped', 'success');
      } else {
        showMessage('Failed to stop scheduler', 'error');
      }
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    } catch (error) {
      showMessage('Error stopping scheduler', 'error');
    }
  };

  const handleCleanupStaleInventory = () => {
    setShowStaleCleanupDialog(true);
  };

  const confirmStaleCleanup = async () => {
    setShowStaleCleanupDialog(false);

    setIsCleaningStaleInventory(true);
    setStaleCleanupStatus('Cleaning up stale inventory...');

    try {
      const result = await deleteStaleInventory();
      
      if (result.success) {
        setStaleCleanupStatus(`✅ ${result.message || 'Stale inventory cleaned up successfully'}`);
        if (result.details) {
          setStaleCleanupStatus(prev => `${prev}\n📊 Details: ${result.details.join(', ')}`);
        }
        if (result.deletedCount) {
          setStaleCleanupStatus(prev => `${prev}\n🗑️ Total deleted: ${result.deletedCount} groups`);
        }
        showMessage(`Stale inventory cleaned up successfully! Deleted ${result.deletedCount} groups`, 'success');
      } else {
        setStaleCleanupStatus(`❌ Error: ${result.error || 'Failed to cleanup stale inventory'}`);
        showMessage(result.error || 'Failed to cleanup stale inventory', 'error');
      }
    } catch (error) {
      setStaleCleanupStatus('❌ Error cleaning up stale inventory.');
      console.error('Error cleaning up stale inventory:', error);
      showMessage('Error cleaning up stale inventory', 'error');
    } finally {
      setIsCleaningStaleInventory(false);
    }
  };

  const cancelStaleCleanup = () => {
    setShowStaleCleanupDialog(false);
  };

  // Auto-delete functions
  const handleAutoDeleteToggle = async (enabled: boolean) => {
    setIsLoadingAutoDelete(true);
    try {
      const response = await fetch('/api/auto-delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          action: enabled ? 'start' : 'stop',
          stopBeforeMinutes: autoDeleteSettings.stopBeforeMinutes,
          scheduleIntervalMinutes: autoDeleteSettings.scheduleIntervalMinutes
        })
      });

      const result = await response.json();
      if (result.success) {
        setAutoDeleteSettings((prev: AutoDeleteSettings) => ({ 
          ...prev, 
          isEnabled: enabled,
          schedulerStatus: enabled ? 'Running' : 'Stopped'
        }));
        showMessage(result.message, 'success');
      } else {
        showMessage(result.error || 'Failed to update auto-delete', 'error');
      }
    } catch (error) {
      console.error('Error toggling auto-delete:', error);
      showMessage('Error updating auto-delete settings', 'error');
    } finally {
      setIsLoadingAutoDelete(false);
    }
  };

  const handleAutoDeleteSettingsUpdate = async (updates: Partial<AutoDeleteSettings>) => {
    setIsLoadingAutoDelete(true);
    try {
      const response = await fetch('/api/auto-delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          action: 'update-settings',
          ...updates
        })
      });

      const result = await response.json();
      if (result.success) {
        setAutoDeleteSettings((prev: AutoDeleteSettings) => ({ ...prev, ...updates }));
        showMessage('Auto-delete settings updated', 'success');
      } else {
        showMessage(result.error || 'Failed to update settings', 'error');
      }
    } catch (error) {
      console.error('Error updating auto-delete settings:', error);
      showMessage('Error updating settings', 'error');
    } finally {
      setIsLoadingAutoDelete(false);
    }
  };

  const handleAutoDeletePreview = async () => {
    setIsLoadingAutoDelete(true);
    try {
      const response = await fetch('/api/auto-delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          action: 'preview',
          stopBeforeMinutes: autoDeleteSettings.stopBeforeMinutes
        })
      });

      const result = await response.json();
      if (result.success) {
        setAutoDeletePreview(result);
        setShowAutoDeletePreview(true);
      } else {
        showMessage(result.error || 'Failed to get preview', 'error');
      }
    } catch (error) {
      console.error('Error getting auto-delete preview:', error);
      showMessage('Error getting preview', 'error');
    } finally {
      setIsLoadingAutoDelete(false);
    }
  };

  const handleAutoDeleteRunNow = async () => {
    setIsLoadingAutoDelete(true);
    try {
      const response = await fetch('/api/auto-delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'run-now' })
      });

      const result = await response.json();
      if (result.success) {
        showMessage(result.message, 'success');
        // Refresh settings
        const settingsResponse = await fetch('/api/auto-delete');
        if (settingsResponse.ok) {
          const data = await settingsResponse.json();
          setAutoDeleteSettings(data.settings);
        }
      } else {
        showMessage(result.error || 'Failed to run auto-delete', 'error');
      }
    } catch (error) {
      console.error('Error running auto-delete:', error);
      showMessage('Error running auto-delete', 'error');
    } finally {
      setIsLoadingAutoDelete(false);
    }
  };

  const handleSaveSettings = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const response = await fetch('/api/csv-scheduler', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          action: 'update-settings',
          intervalMinutes: settings.scheduleRateMinutes,
          uploadToSync: settings.uploadToSync,
          eventUpdateFilterMinutes: settings.eventUpdateFilterMinutes,
          lowSeatAutoStop: settings.lowSeatAutoStop,
          lowSeatThreshold: settings.lowSeatThreshold,
          minSeatFilter: settings.minSeatFilter,
          minSeatFilterMode: settings.minSeatFilterMode,
        })
      });
      
      if (response.ok) {
        showMessage('Settings saved successfully!', 'success');
      } else {
        showMessage('Failed to save settings', 'error');
      }
    } catch (error) {
      showMessage('Error saving settings', 'error');
      console.error('Error saving settings:', error);
    }
  };

  return (
    <div className="space-y-8">
      {/* Header */}
      <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between">
        <div>
          <h1 className="text-3xl font-bold bg-gradient-to-r from-slate-800 to-slate-600 bg-clip-text text-transparent">
            Export CSV
          </h1>
          <p className="text-slate-600 mt-2">
            Manage scheduler, sync uploads, and inventory operations.
          </p>
        </div>
        <div className="mt-4 lg:mt-0">
          <div className={`flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-medium ${
            settings.isScheduled ? 'bg-emerald-50 text-emerald-700 border border-emerald-200' : 'bg-slate-50 text-slate-500 border border-slate-200'
          }`}>
            <div className={`w-2 h-2 rounded-full ${settings.isScheduled ? 'bg-emerald-500 animate-pulse' : 'bg-slate-400'}`} />
            Scheduler {settings.isScheduled ? 'Running' : 'Stopped'}
          </div>
        </div>
      </div>

      {/* Stats Overview */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
        {/* Countdown Timer Card */}
        <div className="bg-white rounded-2xl shadow-sm border border-slate-200 p-6 hover:shadow-md transition-shadow duration-200">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium text-slate-500 mb-1">Next Run In</p>
              <div className={`text-3xl font-bold font-mono tabular-nums ${settings.isScheduled ? 'text-slate-800' : 'text-slate-300'}`}>
                {!settings.isScheduled ? 'Off' : countdown === 'Running...' ? 'Now' : countdown || 'Loading...'}
              </div>
              <div className="flex items-center mt-2 text-sm">
                {settings.isScheduled && performanceMetrics?.nextRunAt ? (
                  <>
                    <Clock className="w-4 h-4 text-purple-500 mr-1" />
                    <span className="text-slate-500">at {moment(performanceMetrics.nextRunAt).format('HH:mm:ss')}</span>
                  </>
                ) : settings.isScheduled ? (
                  <span className="text-slate-400">Waiting for schedule...</span>
                ) : (
                  <span className="text-slate-400">Scheduler stopped</span>
                )}
              </div>
            </div>
            <div className={`w-12 h-12 rounded-xl flex items-center justify-center ${
              settings.isScheduled ? 'bg-gradient-to-br from-purple-500 to-purple-600' : 'bg-gradient-to-br from-slate-400 to-slate-500'
            }`}>
              <Timer className="w-6 h-6 text-white" />
            </div>
          </div>
        </div>

        {/* Total Runs Card */}
        <div className="bg-white rounded-2xl shadow-sm border border-slate-200 p-6 hover:shadow-md transition-shadow duration-200">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium text-slate-500 mb-1">Total Runs</p>
              <div className="text-3xl font-bold text-slate-800 tabular-nums">
                {performanceMetrics?.totalRuns || 0}
              </div>
              <div className="flex items-center mt-2 text-sm">
                <BarChart3 className="w-4 h-4 text-indigo-500 mr-1" />
                <span className="text-slate-500">Scheduled runs</span>
              </div>
            </div>
            <div className="w-12 h-12 bg-gradient-to-br from-indigo-500 to-indigo-600 rounded-xl flex items-center justify-center">
              <BarChart3 className="w-6 h-6 text-white" />
            </div>
          </div>
        </div>

        {/* Sync Upload Card */}
        <div className="bg-white rounded-2xl shadow-sm border border-slate-200 p-6 hover:shadow-md transition-shadow duration-200">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium text-slate-500 mb-1">Sync Upload</p>
              {performanceMetrics?.lastUploadAt ? (
                <>
                  <div className={`text-3xl font-bold tabular-nums ${
                    performanceMetrics.lastUploadStatus === 'success' ? 'text-emerald-600' : 'text-red-600'
                  }`}>
                    {performanceMetrics.lastUploadStatus === 'success' ? 'Sent' : 'Failed'}
                  </div>
                  <div className="flex items-center mt-2 text-sm">
                    {performanceMetrics.lastUploadStatus === 'success' ? (
                      <CheckCircle2 className="w-4 h-4 text-emerald-500 mr-1" />
                    ) : (
                      <XCircle className="w-4 h-4 text-red-500 mr-1" />
                    )}
                    <span className="text-slate-500">{moment(performanceMetrics.lastUploadAt).fromNow()}</span>
                  </div>
                </>
              ) : (
                <>
                  <div className={`text-3xl font-bold ${settings.uploadToSync ? 'text-blue-600' : 'text-slate-300'}`}>
                    {settings.uploadToSync ? 'On' : 'Off'}
                  </div>
                  <div className="flex items-center mt-2 text-sm">
                    {settings.uploadToSync ? (
                      <>
                        <CheckCircle2 className="w-4 h-4 text-blue-500 mr-1" />
                        <span className="text-blue-600 font-medium">Auto-upload enabled</span>
                      </>
                    ) : (
                      <span className="text-slate-400">Upload disabled</span>
                    )}
                  </div>
                </>
              )}
            </div>
            <div className={`w-12 h-12 rounded-xl flex items-center justify-center ${
              performanceMetrics?.lastUploadStatus === 'success'
                ? 'bg-gradient-to-br from-emerald-500 to-emerald-600'
                : performanceMetrics?.lastUploadError
                  ? 'bg-gradient-to-br from-red-500 to-red-600'
                  : settings.uploadToSync
                    ? 'bg-gradient-to-br from-blue-500 to-blue-600'
                    : 'bg-gradient-to-br from-slate-400 to-slate-500'
            }`}>
              <Upload className="w-6 h-6 text-white" />
            </div>
          </div>
        </div>

        {/* Last Run Card */}
        <div className="bg-white rounded-2xl shadow-sm border border-slate-200 p-6 hover:shadow-md transition-shadow duration-200">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium text-slate-500 mb-1">Last Run</p>
              {performanceMetrics?.lastManualGeneration ? (
                <>
                  <div className="text-3xl font-bold text-slate-800 tabular-nums">
                    {performanceMetrics.lastManualGeneration.recordCount}
                  </div>
                  <div className="flex items-center mt-2 text-sm">
                    <Download className="w-4 h-4 text-blue-500 mr-1" />
                    <span className="text-slate-500">records &middot; {(performanceMetrics.lastManualGeneration.generationTime / 1000).toFixed(1)}s &middot; {moment(performanceMetrics.lastManualGeneration.timestamp).fromNow()}</span>
                  </div>
                </>
              ) : performanceMetrics?.lastRunAt ? (
                <>
                  <div className="text-3xl font-bold text-slate-800 tabular-nums">
                    {moment(performanceMetrics.lastRunAt).format('HH:mm')}
                  </div>
                  <div className="flex items-center mt-2 text-sm">
                    <Clock className="w-4 h-4 text-blue-500 mr-1" />
                    <span className="text-slate-500">{moment(performanceMetrics.lastRunAt).fromNow()}</span>
                  </div>
                </>
              ) : (
                <>
                  <div className="text-3xl font-bold text-slate-300">None</div>
                  <div className="flex items-center mt-2 text-sm">
                    <span className="text-slate-400">No CSV generated yet</span>
                  </div>
                </>
              )}
            </div>
            <div className={`w-12 h-12 rounded-xl flex items-center justify-center ${
              performanceMetrics?.lastRunAt
                ? 'bg-gradient-to-br from-blue-500 to-blue-600'
                : 'bg-gradient-to-br from-slate-400 to-slate-500'
            }`}>
              <Download className="w-6 h-6 text-white" />
            </div>
          </div>
        </div>
      </div>

      {/* Last run info bar */}
      {performanceMetrics?.lastRunAt && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-slate-500 -mt-4">
          <span>Last run: <span className="text-slate-700 font-medium">{moment(performanceMetrics.lastRunAt).format('MMM D, HH:mm')}</span></span>
          {performanceMetrics.lastCsvGenerated && <span>CSV: <span className="text-slate-700 font-medium">{performanceMetrics.lastCsvGenerated}</span></span>}
          {performanceMetrics.lastManualGeneration && (
            <span>Manual: <span className="text-slate-700 font-medium">{performanceMetrics.lastManualGeneration.recordCount} records in {performanceMetrics.lastManualGeneration.generationTime}ms</span></span>
          )}
        </div>
      )}

      {/* Two-column layout for main content */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">

        {/* LEFT COLUMN */}
        <div className="space-y-8">

          {/* Configuration Settings */}
          <div className="bg-white rounded-2xl shadow-sm border border-slate-200 overflow-hidden hover:shadow-md transition-shadow duration-200">
            <div className="px-6 py-4 border-b border-slate-100 flex items-center gap-3">
              <div className="w-8 h-8 bg-gradient-to-br from-slate-600 to-slate-700 rounded-lg flex items-center justify-center">
                <Settings className="w-4 h-4 text-white" />
              </div>
              <h3 className="text-lg font-semibold text-slate-800">Configuration</h3>
            </div>
            <form onSubmit={handleSaveSettings} className="p-5 space-y-4">
              {/* Upload Toggle */}
              <div className="flex items-center justify-between">
                <div>
                  <label htmlFor="uploadToSync" className="text-sm font-medium text-slate-700">Upload to Sync</label>
                  <p className="text-[11px] text-slate-400">Auto-upload CSV to sync service</p>
                </div>
                <button
                  type="button"
                  onClick={() => setSettings(prev => ({ ...prev, uploadToSync: !prev.uploadToSync }))}
                  className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-400 ${
                    settings.uploadToSync ? 'bg-indigo-500' : 'bg-slate-300'
                  }`}
                >
                  <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform shadow-sm ${
                    settings.uploadToSync ? 'translate-x-6' : 'translate-x-1'
                  }`} />
                </button>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label htmlFor="scheduleRateMinutes" className="block text-xs font-medium text-slate-600 mb-1">Schedule (min)</label>
                  <input type="number" id="scheduleRateMinutes" value={settings.scheduleRateMinutes}
                    onChange={(e) => setSettings(prev => ({ ...prev, scheduleRateMinutes: parseInt(e.target.value) || 60 }))}
                    min="1" max="1440"
                    className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400 focus:border-transparent" />
                </div>
                <div>
                  <label htmlFor="eventUpdateFilterMinutes" className="block text-xs font-medium text-slate-600 mb-1">Update Filter (min)</label>
                  <input type="number" id="eventUpdateFilterMinutes" value={settings.eventUpdateFilterMinutes}
                    onChange={(e) => setSettings(prev => ({ ...prev, eventUpdateFilterMinutes: parseInt(e.target.value) || 0 }))}
                    min="0" max="10080"
                    className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400 focus:border-transparent" />
                </div>
              </div>

              {/* NLA Protection */}
              {featureFlags.minSeatFilter && (
                <div className="p-3 bg-indigo-50/50 border border-indigo-100 rounded-lg">
                  <label htmlFor="minSeatFilter" className="flex items-center gap-1.5 text-xs font-semibold text-indigo-700 mb-1.5">
                    <Shield className="w-3.5 h-3.5" /> NLA Protection
                  </label>
                  <div className="flex items-center gap-1.5 mb-1.5">
                    <button type="button"
                      onClick={() => setSettings(prev => ({ ...prev, minSeatFilterMode: 'row' }))}
                      className={`flex-1 px-2 py-1 text-xs font-medium rounded-md border transition-colors ${settings.minSeatFilterMode === 'row' ? 'bg-indigo-600 text-white border-indigo-600' : 'bg-white text-indigo-600 border-indigo-300 hover:bg-indigo-50'}`}>
                      Row Based
                    </button>
                    <button type="button"
                      onClick={() => setSettings(prev => ({ ...prev, minSeatFilterMode: 'section' }))}
                      className={`flex-1 px-2 py-1 text-xs font-medium rounded-md border transition-colors ${settings.minSeatFilterMode === 'section' ? 'bg-indigo-600 text-white border-indigo-600' : 'bg-white text-indigo-600 border-indigo-300 hover:bg-indigo-50'}`}>
                      Section Based
                    </button>
                  </div>
                  <input type="number" id="minSeatFilter" value={settings.minSeatFilter}
                    onChange={(e) => setSettings(prev => ({ ...prev, minSeatFilter: Math.max(0, parseInt(e.target.value) || 0) }))}
                    min="0" max="100"
                    className="w-full px-3 py-2 border border-indigo-200 rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-indigo-400 focus:border-transparent" />
                  <p className="text-[11px] text-indigo-500/70 mt-1">
                    {settings.minSeatFilterMode === 'section'
                      ? <>Skip entire sections with &le; {settings.minSeatFilter || 'X'} total seats. 0 = off.</>
                      : <>Skip individual listings with &le; {settings.minSeatFilter || 'X'} seats. 0 = off.</>}
                  </p>
                </div>
              )}

              {/* Low Seat Auto-Stop */}
              {featureFlags.lowSeatAutoStop && (
                <div className="p-3 bg-amber-50/50 border border-amber-100 rounded-lg space-y-2">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-1.5">
                      <Zap className="w-3.5 h-3.5 text-amber-500" />
                      <span className="text-xs font-semibold text-slate-700">Low Seat Auto-Stop</span>
                    </div>
                    <button type="button" onClick={() => setSettings(prev => ({ ...prev, lowSeatAutoStop: !prev.lowSeatAutoStop }))}
                      className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-amber-400 ${
                        settings.lowSeatAutoStop ? 'bg-amber-500' : 'bg-slate-300'
                      }`}>
                      <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform shadow-sm ${
                        settings.lowSeatAutoStop ? 'translate-x-6' : 'translate-x-1'
                      }`} />
                    </button>
                  </div>
                  {settings.lowSeatAutoStop && (
                    <div>
                      <label htmlFor="lowSeatThreshold" className="block text-xs font-medium text-slate-600 mb-1">Threshold</label>
                      <input type="number" id="lowSeatThreshold" value={settings.lowSeatThreshold}
                        onChange={(e) => setSettings(prev => ({ ...prev, lowSeatThreshold: Math.max(1, parseInt(e.target.value) || 10) }))}
                        min="1" max="1000"
                        className="w-full px-3 py-2 border border-amber-200 rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-amber-400 focus:border-transparent" />
                    </div>
                  )}
                </div>
              )}

              {/* Scheduler Controls */}
              <div className="flex items-center justify-between pt-2">
                <div className="flex items-center gap-2">
                  {!settings.isScheduled ? (
                    <button type="button" onClick={handleStartScheduler}
                      className="flex items-center gap-1.5 bg-emerald-600 hover:bg-emerald-700 text-white text-sm font-medium py-2 px-4 rounded-lg transition-colors">
                      <Play className="w-4 h-4" /> Start Scheduler
                    </button>
                  ) : (
                    <button type="button" onClick={handleStopScheduler}
                      className="flex items-center gap-1.5 bg-red-500 hover:bg-red-600 text-white text-sm font-medium py-2 px-4 rounded-lg transition-colors">
                      <Square className="w-4 h-4" /> Stop Scheduler
                    </button>
                  )}
                </div>
                <button type="submit"
                  className="flex items-center gap-1.5 bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-medium py-2 px-4 rounded-lg transition-colors">
                  Save Settings
                </button>
              </div>
            </form>
          </div>

          {/* CSV Actions */}
          {(featureFlags.csvDownload || featureFlags.csvManualExport) && (
            <div className="bg-white rounded-2xl shadow-sm border border-slate-200 overflow-hidden hover:shadow-md transition-shadow duration-200">
              <div className="px-6 py-4 border-b border-slate-100 flex items-center gap-3">
                <div className="w-8 h-8 bg-gradient-to-br from-indigo-500 to-indigo-600 rounded-lg flex items-center justify-center">
                  <Download className="w-4 h-4 text-white" />
                </div>
                <h3 className="text-lg font-semibold text-slate-800">CSV Actions</h3>
              </div>
              <div className="p-6 space-y-3">
                {featureFlags.csvDownload && (
                  <button onClick={handleGenerateCsv} disabled={loading}
                    className="w-full bg-gradient-to-r from-indigo-600 to-indigo-700 hover:from-indigo-700 hover:to-indigo-800 disabled:from-slate-300 disabled:to-slate-300 text-white font-medium py-2.5 px-4 rounded-xl transition-all flex items-center justify-center gap-2 shadow-sm">
                    <Download className="w-4 h-4" />
                    {loading ? 'Generating...' : 'Generate & Download CSV'}
                  </button>
                )}
                {featureFlags.csvManualExport && settings.uploadToSync && (
                  <button onClick={handleUploadCsv} disabled={loading}
                    className="w-full bg-gradient-to-r from-slate-600 to-slate-700 hover:from-slate-700 hover:to-slate-800 disabled:from-slate-300 disabled:to-slate-300 text-white font-medium py-2.5 px-4 rounded-xl transition-all flex items-center justify-center gap-2 shadow-sm">
                    <Upload className="w-4 h-4" />
                    {loading ? 'Uploading...' : 'Upload CSV to Sync'}
                  </button>
                )}

                {/* Last generation info — shows start time & total time */}
                {performanceMetrics?.lastManualGeneration && (
                  <div className="flex items-center gap-2 px-4 py-3 bg-emerald-50 border border-emerald-100 rounded-xl text-xs text-emerald-700">
                    <CheckCircle2 className="w-4 h-4 shrink-0" />
                    <div>
                      <span className="font-medium">{performanceMetrics.lastManualGeneration.recordCount} records</span>
                      <span className="text-emerald-500 mx-1">&middot;</span>
                      <span>Generated in {(performanceMetrics.lastManualGeneration.generationTime / 1000).toFixed(1)}s</span>
                      {performanceMetrics.lastManualGeneration.totalTime && performanceMetrics.lastManualGeneration.totalTime > performanceMetrics.lastManualGeneration.generationTime && (
                        <>
                          <span className="text-emerald-500 mx-1">&middot;</span>
                          <span>Total to sync: {(performanceMetrics.lastManualGeneration.totalTime / 1000).toFixed(1)}s</span>
                        </>
                      )}
                      <span className="text-emerald-500 mx-1">&middot;</span>
                      <span>Started {moment(performanceMetrics.lastManualGeneration.timestamp).format('MMM D, HH:mm:ss')}</span>
                    </div>
                  </div>
                )}

                {/* Upload status */}
                {performanceMetrics?.lastUploadAt && (
                  <div className={`flex items-center gap-2 px-4 py-3 rounded-xl text-xs border ${
                    performanceMetrics.lastUploadStatus === 'success' ? 'bg-emerald-50 border-emerald-100 text-emerald-700' :
                    'bg-red-50 border-red-100 text-red-700'
                  }`}>
                    {performanceMetrics.lastUploadStatus === 'success' ? <CheckCircle2 className="w-4 h-4 shrink-0" /> : <XCircle className="w-4 h-4 shrink-0" />}
                    <div>
                      <span className="font-medium">Upload {performanceMetrics.lastUploadStatus}</span>
                      <span className="opacity-60 mx-1">&middot;</span>
                      <span>{moment(performanceMetrics.lastUploadAt).format('MMM D, HH:mm:ss')} ({moment(performanceMetrics.lastUploadAt).fromNow()})</span>
                      {performanceMetrics.lastUploadId && <span className="text-slate-400 ml-1">&middot; ID: {performanceMetrics.lastUploadId}</span>}
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>

        {/* RIGHT COLUMN */}
        <div className="space-y-8">

          {/* Auto-Stop Events */}
          {featureFlags.autoDelete && (
            <div className="bg-white rounded-2xl shadow-sm border border-slate-200 overflow-hidden hover:shadow-md transition-shadow duration-200">
              <div className="px-6 py-4 border-b border-slate-100 flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className="w-8 h-8 bg-gradient-to-br from-orange-500 to-orange-600 rounded-lg flex items-center justify-center">
                    <Clock className="w-4 h-4 text-white" />
                  </div>
                  <h3 className="text-lg font-semibold text-slate-800">Auto-Stop Events</h3>
                </div>
                <span className={`text-[11px] font-medium px-2 py-0.5 rounded-full ${
                  autoDeleteSettings.schedulerStatus === 'Running' ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-100 text-slate-500'
                }`}>{autoDeleteSettings.schedulerStatus}</span>
              </div>
              <div className="p-5 space-y-4">
                <p className="text-[11px] text-slate-400 leading-relaxed">
                  Stops scraping and clears inventory before events take place. Events stay in the database.
                </p>

                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs font-medium text-slate-600 mb-1">Stop Before (min)</label>
                    <input type="number" value={autoDeleteSettings.stopBeforeMinutes}
                      onChange={(e) => setAutoDeleteSettings((prev: AutoDeleteSettings) => ({ ...prev, stopBeforeMinutes: parseInt(e.target.value) || 120 }))}
                      min="0" max="10080"
                      className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400 focus:border-transparent" />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-slate-600 mb-1">Interval (min)</label>
                    <input type="number" value={autoDeleteSettings.scheduleIntervalMinutes}
                      onChange={(e) => setAutoDeleteSettings((prev: AutoDeleteSettings) => ({ ...prev, scheduleIntervalMinutes: parseInt(e.target.value) || 15 }))}
                      min="1" max="1440"
                      className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400 focus:border-transparent" />
                  </div>
                </div>

                {/* Post-event hard delete */}
                <div className="border border-red-200 rounded-lg p-3 bg-red-50/50 space-y-2">
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="text-xs font-semibold text-red-800">Auto-Delete Old Events</p>
                      <p className="text-[11px] text-red-600 mt-0.5">Permanently removes events + inventory after event passes</p>
                    </div>
                    <button
                      onClick={() => setAutoDeleteSettings((prev: AutoDeleteSettings) => ({ ...prev, postEventDeleteEnabled: !prev.postEventDeleteEnabled }))}
                      className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors ${autoDeleteSettings.postEventDeleteEnabled ? 'bg-red-500' : 'bg-slate-300'}`}
                    >
                      <span className={`inline-block h-4 w-4 rounded-full bg-white shadow ring-0 transition-transform ${autoDeleteSettings.postEventDeleteEnabled ? 'translate-x-4' : 'translate-x-0'}`} />
                    </button>
                  </div>
                  {autoDeleteSettings.postEventDeleteEnabled && (
                    <div className="flex items-center gap-2">
                      <label className="text-xs text-red-700 whitespace-nowrap">Delete</label>
                      <input
                        type="number"
                        value={autoDeleteSettings.postEventDeleteHoursAfter}
                        onChange={(e) => setAutoDeleteSettings((prev: AutoDeleteSettings) => ({ ...prev, postEventDeleteHoursAfter: parseInt(e.target.value) || 12 }))}
                        min="1" max="168"
                        className="w-20 px-2 py-1 border border-red-300 rounded text-sm focus:outline-none focus:ring-2 focus:ring-red-400 bg-white"
                      />
                      <label className="text-xs text-red-700">hours after event date</label>
                    </div>
                  )}
                </div>

                <div className="flex flex-wrap gap-2">
                  <button onClick={() => handleAutoDeleteSettingsUpdate({ stopBeforeMinutes: autoDeleteSettings.stopBeforeMinutes, scheduleIntervalMinutes: autoDeleteSettings.scheduleIntervalMinutes, postEventDeleteEnabled: autoDeleteSettings.postEventDeleteEnabled, postEventDeleteHoursAfter: autoDeleteSettings.postEventDeleteHoursAfter })}
                    disabled={isLoadingAutoDelete}
                    className="flex items-center gap-1.5 bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-medium py-2 px-4 rounded-lg transition-colors disabled:bg-slate-300">
                    <RefreshCw className="w-4 h-4" /> Save
                  </button>
                  {!autoDeleteSettings.isEnabled ? (
                    <button onClick={() => handleAutoDeleteToggle(true)} disabled={isLoadingAutoDelete}
                      className="flex items-center gap-1.5 bg-emerald-600 hover:bg-emerald-700 text-white text-sm font-medium py-2 px-4 rounded-lg transition-colors disabled:bg-slate-300">
                      <Play className="w-4 h-4" /> Start
                    </button>
                  ) : (
                    <button onClick={() => handleAutoDeleteToggle(false)} disabled={isLoadingAutoDelete}
                      className="flex items-center gap-1.5 bg-red-500 hover:bg-red-600 text-white text-sm font-medium py-2 px-4 rounded-lg transition-colors disabled:bg-slate-300">
                      <Square className="w-4 h-4" /> Stop
                    </button>
                  )}
                  <button onClick={handleAutoDeletePreview} disabled={isLoadingAutoDelete}
                    className="flex items-center gap-1.5 bg-slate-100 hover:bg-slate-200 text-slate-600 text-sm font-medium py-2 px-4 rounded-lg transition-colors">
                    <Eye className="w-4 h-4" /> Preview
                  </button>
                  <button onClick={handleAutoDeleteRunNow} disabled={isLoadingAutoDelete || !autoDeleteSettings.isEnabled}
                    className="flex items-center gap-1.5 bg-amber-500 hover:bg-amber-600 text-white text-sm font-medium py-2 px-4 rounded-lg transition-colors disabled:bg-slate-300">
                    <Zap className="w-4 h-4" /> Run Now
                  </button>
                </div>

                {autoDeleteSettings.lastRunAt && (
                  <div className="grid grid-cols-4 gap-2 bg-slate-50 p-3 rounded-lg">
                    <div className="text-center">
                      <div className="text-sm font-bold text-slate-700">{autoDeleteSettings.totalRuns}</div>
                      <div className="text-[10px] text-slate-400">Runs</div>
                    </div>
                    <div className="text-center">
                      <div className="text-sm font-bold text-slate-700">{autoDeleteSettings.totalEventsDeleted}</div>
                      <div className="text-[10px] text-slate-400">Stopped</div>
                    </div>
                    <div className="text-center">
                      <div className="text-[11px] font-semibold text-slate-600">{moment(autoDeleteSettings.lastRunAt).format('MM/DD HH:mm')}</div>
                      <div className="text-[10px] text-slate-400">Last</div>
                    </div>
                    <div className="text-center">
                      <div className="text-[11px] font-semibold text-slate-600">{autoDeleteSettings.nextRunAt ? moment(autoDeleteSettings.nextRunAt).format('MM/DD HH:mm') : '—'}</div>
                      <div className="text-[10px] text-slate-400">Next</div>
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Inventory Cleanup */}
          <div className="bg-white rounded-2xl shadow-sm border border-slate-200 overflow-hidden hover:shadow-md transition-shadow duration-200">
            <div className="px-6 py-4 border-b border-slate-100 flex items-center gap-3">
              <div className="w-8 h-8 bg-gradient-to-br from-amber-500 to-amber-600 rounded-lg flex items-center justify-center">
                <RefreshCw className="w-4 h-4 text-white" />
              </div>
              <h3 className="text-lg font-semibold text-slate-800">Inventory Cleanup</h3>
            </div>
            <div className="p-5 space-y-3">
              <p className="text-[11px] text-slate-400 leading-relaxed">
                Remove stale inventory for inactive events and orphaned records.
              </p>
              <button onClick={handleCleanupStaleInventory} disabled={isCleaningStaleInventory}
                className="flex items-center gap-2 bg-amber-500 hover:bg-amber-600 text-white text-sm font-medium py-2 px-4 rounded-lg transition-colors disabled:bg-slate-300 disabled:cursor-not-allowed">
                <Trash2 className="w-4 h-4" />
                {isCleaningStaleInventory ? 'Cleaning...' : 'Clean Up Stale Inventory'}
              </button>
              {staleCleanupStatus && (
                <div className={`p-3 rounded-lg text-xs whitespace-pre-line border ${
                  staleCleanupStatus.includes('✅') ? 'bg-emerald-50 text-emerald-800 border-emerald-200' : 'bg-red-50 text-red-800 border-red-200'
                }`}>{staleCleanupStatus}</div>
              )}
            </div>
          </div>

          {/* Danger Zone */}
          <details className="bg-white rounded-2xl shadow-sm border border-slate-200 overflow-hidden group hover:shadow-md transition-shadow duration-200">
            <summary className="px-6 py-4 cursor-pointer select-none flex items-center gap-3 border-b border-slate-100 hover:bg-red-50/30 transition-colors">
              <div className="w-8 h-8 bg-gradient-to-br from-red-500 to-red-600 rounded-lg flex items-center justify-center">
                <AlertTriangle className="w-4 h-4 text-white" />
              </div>
              <h3 className="text-lg font-semibold text-slate-800 group-hover:text-red-600 transition-colors">Danger Zone</h3>
              <ChevronDown className="w-4 h-4 text-slate-400 transition-transform group-open:rotate-180 ml-auto" />
            </summary>
            <div className="p-5 space-y-4">
              <div className="border border-red-200 bg-red-50/30 rounded-lg p-4">
                <h4 className="text-sm font-semibold text-red-800 mb-1">Manual CSV Upload (allows empty)</h4>
                <p className="text-[11px] text-red-600/70 mb-3">
                  Upload a CSV file directly to Sync. This is the <strong>only</strong> path that can push an empty or header-only CSV.
                  Scheduled runs and manual exports always refuse blank CSVs.
                </p>
                <div className="flex flex-col sm:flex-row gap-2 items-stretch sm:items-center">
                  <input
                    type="file"
                    accept=".csv,text/csv"
                    onChange={e => {
                      const f = e.target.files?.[0] ?? null;
                      setDangerFile(f);
                      setDangerStatus('');
                    }}
                    className="flex-1 text-xs text-slate-700 file:mr-3 file:py-2 file:px-3 file:rounded-md file:border-0 file:text-xs file:font-semibold file:bg-slate-100 file:text-slate-700 hover:file:bg-slate-200"
                  />
                  <button
                    onClick={dangerUpload}
                    disabled={!dangerFile || isDangerUploading}
                    className="flex items-center gap-1.5 bg-red-600 hover:bg-red-700 text-white text-sm font-medium py-2 px-4 rounded-lg transition-colors disabled:bg-slate-300 disabled:cursor-not-allowed whitespace-nowrap"
                  >
                    <AlertTriangle className="w-4 h-4" />
                    {isDangerUploading ? 'Uploading…' : 'Upload to Sync'}
                  </button>
                </div>
                {dangerFile && !isDangerUploading && (
                  <p className="mt-2 text-[11px] text-slate-500">
                    Selected: <span className="font-mono">{dangerFile.name}</span> ({dangerFile.size.toLocaleString()} bytes)
                  </p>
                )}
                {dangerStatus && (
                  <div className={`mt-3 p-3 rounded-lg text-xs border ${
                    dangerStatus.startsWith('✅') ? 'bg-emerald-50 text-emerald-800 border-emerald-200' : 'bg-red-50 text-red-800 border-red-200'
                  }`}>{dangerStatus}</div>
                )}
              </div>
            </div>
          </details>

        </div>
      </div>

      {/* Clear Stale Inventory Confirmation Dialog */}
      {showStaleCleanupDialog && (
        <div className="fixed inset-0 bg-slate-900/50 backdrop-blur-sm overflow-y-auto h-full w-full z-50 flex items-center justify-center" onClick={cancelStaleCleanup}>
          <div className="relative bg-white rounded-2xl shadow-2xl max-w-md w-full mx-4 border border-slate-200" onClick={e => e.stopPropagation()}>
            <div className="p-6">
              <div className="flex items-center justify-center w-14 h-14 mx-auto bg-amber-100 rounded-2xl mb-5">
                <Trash2 className="w-7 h-7 text-amber-600" />
              </div>
              <div className="text-center">
                <h3 className="text-lg font-bold text-slate-800 mb-2">
                  Clean Up Stale Inventory?
                </h3>
                <p className="text-sm text-slate-500 mb-6 leading-relaxed">
                  This will remove consecutive groups for inactive events and orphaned inventory where events no longer exist.
                </p>
                <div className="flex justify-center gap-3">
                  <button
                    onClick={cancelStaleCleanup}
                    className="px-5 py-2.5 text-sm font-medium text-slate-700 bg-white border border-slate-200 rounded-xl hover:bg-slate-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-slate-400 transition-colors"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={confirmStaleCleanup}
                    className="px-5 py-2.5 text-sm font-medium text-white bg-amber-500 hover:bg-amber-600 rounded-xl shadow-md focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-amber-500 transition-all"
                  >
                    Clean Up
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Auto-Stop Preview Dialog */}
      {showAutoDeletePreview && autoDeletePreview && (
        <div className="fixed inset-0 bg-slate-900/50 backdrop-blur-sm overflow-y-auto h-full w-full z-50 flex items-center justify-center" onClick={() => setShowAutoDeletePreview(false)}>
          <div className="relative bg-white rounded-2xl shadow-2xl max-w-2xl w-full mx-4 max-h-[80vh] overflow-y-auto border border-slate-200" onClick={e => e.stopPropagation()}>
            <div className="px-6 py-4 border-b border-slate-100 bg-slate-50/50 flex items-center justify-between sticky top-0 rounded-t-2xl">
              <div className="flex items-center gap-2">
                <Eye className="w-4 h-4 text-slate-500" />
                <h3 className="text-sm font-bold text-slate-700 uppercase tracking-wide">Auto-Stop Preview</h3>
              </div>
              <button
                onClick={() => setShowAutoDeletePreview(false)}
                className="w-8 h-8 rounded-lg flex items-center justify-center text-slate-400 hover:text-slate-600 hover:bg-slate-100 transition-colors"
                aria-label="Close preview"
              >
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
            <div className="p-6">
              <div className="p-4 bg-slate-50 rounded-xl mb-5">
                <p className="text-sm text-slate-600 leading-relaxed">
                  Stop before event: <strong className="text-slate-800">{autoDeletePreview.stopBeforeMinutes} minutes</strong>
                  <br />
                  <span className="text-slate-500">Each event is checked against its venue&apos;s local timezone (auto-detected from venue/city/state).</span>
                  <br />
                  <span className="text-slate-500">Total events checked: <strong className="text-slate-700">{autoDeletePreview.totalEvents || '—'}</strong></span>
                  {(autoDeletePreview.skippedCount ?? 0) > 0 && (
                    <>
                      <br />
                      <span className="text-amber-600 font-medium">{autoDeletePreview.skippedCount} events skipped — timezone could not be detected from venue</span>
                    </>
                  )}
                </p>
              </div>

              {autoDeletePreview.count === 0 ? (
                <div className="text-center py-10">
                  <div className="w-14 h-14 mx-auto bg-green-100 rounded-2xl flex items-center justify-center mb-4">
                    <svg className="w-7 h-7 text-green-600" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M5 13l4 4L19 7" /></svg>
                  </div>
                  <div className="text-lg font-bold text-slate-800 mb-1">No events to stop</div>
                  <p className="text-sm text-slate-500">
                    All events are still far enough from their event time.
                  </p>
                </div>
              ) : (
                <div>
                  <div className="mb-4">
                    <span className="inline-flex items-center px-3 py-1.5 rounded-xl text-sm font-semibold bg-red-100 text-red-800 border border-red-200">
                      {autoDeletePreview.count} events will be stopped &amp; inventory cleared
                    </span>
                  </div>

                  <div className="max-h-64 overflow-y-auto border border-slate-200 rounded-xl">
                    <table className="min-w-full divide-y divide-slate-200">
                      <thead className="bg-slate-50 sticky top-0">
                        <tr>
                          <th className="px-4 py-2.5 text-left text-xs font-bold text-slate-500 uppercase tracking-wide">Event ID</th>
                          <th className="px-4 py-2.5 text-left text-xs font-bold text-slate-500 uppercase tracking-wide">Event Name</th>
                          <th className="px-4 py-2.5 text-left text-xs font-bold text-slate-500 uppercase tracking-wide">Event Time</th>
                          <th className="px-4 py-2.5 text-left text-xs font-bold text-slate-500 uppercase tracking-wide">Venue</th>
                          <th className="px-4 py-2.5 text-left text-xs font-bold text-slate-500 uppercase tracking-wide">TZ</th>
                          <th className="px-4 py-2.5 text-left text-xs font-bold text-slate-500 uppercase tracking-wide">Local Now</th>
                          <th className="px-4 py-2.5 text-left text-xs font-bold text-slate-500 uppercase tracking-wide">Scraping</th>
                        </tr>
                      </thead>
                      <tbody className="bg-white divide-y divide-slate-100">
                        {autoDeletePreview.events.map((event: EventPreview, index: number) => (
                          <tr key={index} className="hover:bg-slate-50 transition-colors">
                            <td className="px-4 py-2.5 text-sm font-medium text-slate-800">{event.id}</td>
                            <td className="px-4 py-2.5 text-sm text-slate-700 max-w-[200px] truncate" title={event.name}>{event.name}</td>
                            <td className="px-4 py-2.5 text-sm text-slate-500 whitespace-nowrap">
                              {moment(event.dateTime).format('YYYY-MM-DD HH:mm')}
                            </td>
                            <td className="px-4 py-2.5 text-sm text-slate-500 max-w-[150px] truncate" title={event.venue}>{event.venue || '—'}</td>
                            <td className="px-4 py-2.5 text-sm">
                              <span className={`inline-flex px-2 py-0.5 rounded-lg text-xs font-semibold ${
                                event.detectedTimezone === 'N/A' ? 'bg-amber-100 text-amber-700' : 'bg-blue-100 text-blue-700'
                              }`}>
                                {event.detectedTimezone || 'N/A'}
                              </span>
                            </td>
                            <td className="px-4 py-2.5 text-sm">
                              <span className={`inline-flex px-2 py-0.5 rounded-lg text-xs font-semibold ${
                                event.isStopped ? 'bg-red-100 text-red-700' : 'bg-green-100 text-green-700'
                              }`}>
                                {event.isStopped ? 'Stopped' : 'Active'}
                              </span>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>

                  <div className="mt-4 p-4 bg-amber-50 border border-amber-200 rounded-xl">
                    <p className="text-amber-800 text-sm leading-relaxed">
                      <strong>Note:</strong> These events will have scraping stopped and their seat inventory cleared. Events themselves are kept in the database. Stopped event records auto-clear from the dashboard after 24 hours.
                    </p>
                  </div>

                  {(autoDeletePreview.skippedEvents?.length ?? 0) > 0 && (
                    <div className="mt-4 p-4 bg-amber-50 border border-amber-200 rounded-xl">
                      <p className="text-amber-800 text-sm font-semibold mb-2">
                        Events skipped (timezone not detected from venue):
                      </p>
                      <div className="max-h-32 overflow-y-auto text-sm text-amber-700">
                        {autoDeletePreview.skippedEvents!.map((e, i) => (
                          <div key={i} className="py-1">
                            {e.id} — {e.name} — Venue: &quot;{e.venue || '(empty)'}&quot;
                          </div>
                        ))}
                      </div>
                      <p className="text-amber-600 text-xs mt-2">
                        These events were NOT checked because their venue text does not contain a recognizable state, city, or venue name.
                      </p>
                    </div>
                  )}
                </div>
              )}

              <div className="flex justify-end mt-6">
                <button
                  onClick={() => setShowAutoDeletePreview(false)}
                  className="px-5 py-2.5 text-sm font-medium text-slate-700 bg-white border border-slate-200 rounded-xl hover:bg-slate-50 transition-colors"
                >
                  Close
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default ExportCsvPage;