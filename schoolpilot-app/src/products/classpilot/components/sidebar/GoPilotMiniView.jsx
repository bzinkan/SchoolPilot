import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { ChevronDown, ChevronRight, ExternalLink, Car } from 'lucide-react';
import api from '../../../../shared/utils/api';

export default function GoPilotMiniView() {
  const [sessionInfo, setSessionInfo] = useState(null);
  const [stats, setStats] = useState(null);
  const [countdown, setCountdown] = useState('');
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState(true);
  const navigate = useNavigate();

  useEffect(() => {
    let mounted = true;
    const fetchSession = async () => {
      try {
        const res = await api.get('/gopilot/dismissal/sessions/active');
        if (mounted && res.data) {
          setSessionInfo(res.data);
          // Try to fetch stats if session exists
          try {
            const statsRes = await api.get(`/gopilot/dismissal/sessions/${res.data.id}/stats`);
            if (mounted && statsRes.data) setStats(statsRes.data);
          } catch {
            // Stats endpoint may not exist - graceful degradation
          }
        } else if (mounted) {
          setSessionInfo(null);
          setStats(null);
        }
      } catch {
        if (mounted) {
          setSessionInfo(null);
          setStats(null);
        }
      } finally {
        if (mounted) setLoading(false);
      }
    };
    fetchSession();
    const interval = setInterval(fetchSession, 30000);
    return () => { mounted = false; clearInterval(interval); };
  }, []);

  // Countdown timer
  useEffect(() => {
    if (!sessionInfo?.scheduledTime) { setCountdown(''); return; }
    const update = () => {
      const diff = new Date(sessionInfo.scheduledTime).getTime() - Date.now();
      if (diff <= 0) { setCountdown('Now'); return; }
      const mins = Math.floor(diff / 60000);
      const hrs = Math.floor(mins / 60);
      const m = mins % 60;
      setCountdown(hrs > 0 ? `${hrs}h ${m}m` : `${m}m`);
    };
    update();
    const timer = setInterval(update, 30000);
    return () => clearInterval(timer);
  }, [sessionInfo]);

  const isActive = !!sessionInfo;

  return (
    <div className="border-b border-slate-200 dark:border-slate-700">
      {/* Branded Header */}
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-2.5 px-4 py-3 bg-gradient-to-r from-indigo-500 to-purple-600 hover:from-indigo-600 hover:to-purple-700 transition-colors"
      >
        <svg width="28" height="28" viewBox="0 0 64 64" fill="none" className="shrink-0">
          <rect width="64" height="64" rx="12" fill="#6366f1" />
          <rect x="16" y="20" width="32" height="24" rx="6" fill="#fff" />
          <path d="M24 32 L26 26 L38 26 L40 32" stroke="#6366f1" strokeWidth="2.5" strokeLinecap="round" fill="none" />
          <path d="M22 32 L42 32 L42 36 L22 36 Z" fill="none" stroke="#6366f1" strokeWidth="2.5" />
          <circle cx="27" cy="36" r="2.5" fill="#6366f1" />
          <circle cx="37" cy="36" r="2.5" fill="#6366f1" />
        </svg>
        <span className="text-sm font-semibold text-white flex-1 text-left">GoPilot</span>
        <div className="flex items-center gap-1.5">
          {isActive ? (
            <>
              <div className="h-2 w-2 rounded-full bg-green-400 animate-pulse" />
              <span className="text-[10px] text-green-300 font-medium">Active</span>
            </>
          ) : (
            <>
              <div className="h-2 w-2 rounded-full bg-slate-400" />
              <span className="text-[10px] text-white/50 font-medium">Inactive</span>
            </>
          )}
        </div>
        {expanded ? (
          <ChevronDown className="h-4 w-4 text-white/70" />
        ) : (
          <ChevronRight className="h-4 w-4 text-white/70" />
        )}
      </button>

      {/* Collapsible Body */}
      {expanded && (
        <div className="px-3 py-3 space-y-2">
          {loading ? (
            <div className="flex items-center justify-center py-4">
              <div className="h-5 w-5 border-2 border-indigo-500 border-t-transparent rounded-full animate-spin" />
            </div>
          ) : isActive ? (
            <>
              {/* Countdown */}
              {countdown && (
                <div className="flex items-center justify-center gap-2 py-1">
                  <span className="text-xs text-slate-500 dark:text-slate-400">Dismissal:</span>
                  <span className={`text-sm font-bold ${countdown === 'Now' ? 'text-green-600 dark:text-green-400' : 'text-indigo-600 dark:text-indigo-400'}`}>
                    {countdown}
                  </span>
                </div>
              )}

              {/* Stats Grid */}
              {stats ? (
                <div className="grid grid-cols-3 gap-2">
                  <div className="text-center py-2 rounded-lg bg-slate-50 dark:bg-slate-800/50">
                    <p className="text-lg font-bold text-green-600 dark:text-green-400">{stats.dismissed ?? 0}</p>
                    <p className="text-[10px] text-slate-500 dark:text-slate-400">Dismissed</p>
                  </div>
                  <div className="text-center py-2 rounded-lg bg-slate-50 dark:bg-slate-800/50">
                    <p className="text-lg font-bold text-red-600 dark:text-red-400">{(stats.waiting ?? 0) + (stats.called ?? 0)}</p>
                    <p className="text-[10px] text-slate-500 dark:text-slate-400">In Queue</p>
                  </div>
                  <div className="text-center py-2 rounded-lg bg-slate-50 dark:bg-slate-800/50">
                    <p className="text-lg font-bold text-green-600 dark:text-green-400">{stats.released ?? stats.inTransit ?? 0}</p>
                    <p className="text-[10px] text-slate-500 dark:text-slate-400">In Transit</p>
                  </div>
                  <div className="text-center py-2 rounded-lg bg-slate-50 dark:bg-slate-800/50">
                    <p className="text-lg font-bold text-red-600 dark:text-red-400">{stats.held ?? 0}</p>
                    <p className="text-[10px] text-slate-500 dark:text-slate-400">Held</p>
                  </div>
                  <div className="col-span-2 text-center py-2 rounded-lg bg-slate-50 dark:bg-slate-800/50">
                    <p className="text-lg font-bold text-indigo-600 dark:text-indigo-400">
                      {stats.avg_wait_seconds != null
                        ? `${Math.floor(stats.avg_wait_seconds / 60)}:${String(Math.floor(stats.avg_wait_seconds % 60)).padStart(2, '0')}`
                        : '--'}
                    </p>
                    <p className="text-[10px] text-slate-500 dark:text-slate-400">Avg Wait</p>
                  </div>
                </div>
              ) : (
                <div className="text-center py-2">
                  <p className="text-xs text-green-600 dark:text-green-400 font-medium">Session Active</p>
                  <p className="text-[10px] text-slate-400 dark:text-slate-500">Open dashboard for details</p>
                </div>
              )}
            </>
          ) : (
            /* No session state - the critical fix */
            <div className="flex flex-col items-center py-4 text-center">
              <Car className="h-8 w-8 text-slate-300 dark:text-slate-600 mb-2" />
              <p className="text-xs font-medium text-slate-600 dark:text-slate-300">No Active Dismissal</p>
              <p className="text-xs text-slate-400 dark:text-slate-500">Session not started</p>
            </div>
          )}

          {/* Footer */}
          <div className="flex items-center gap-1 pt-1 border-t border-slate-100 dark:border-slate-800">
            <button
              onClick={() => navigate('/gopilot')}
              className="flex-1 text-xs font-medium text-indigo-600 dark:text-indigo-400 hover:text-indigo-700 dark:hover:text-indigo-300 py-1.5 rounded hover:bg-indigo-50 dark:hover:bg-indigo-950/30 transition-colors text-center"
            >
              {isActive ? 'View Dashboard' : 'Go to GoPilot'}
            </button>
            <button
              onClick={(e) => { e.stopPropagation(); window.open('/gopilot', '_blank'); }}
              className="p-1.5 rounded text-slate-400 hover:text-slate-600 dark:hover:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
              title="Open GoPilot in new tab"
            >
              <ExternalLink className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
