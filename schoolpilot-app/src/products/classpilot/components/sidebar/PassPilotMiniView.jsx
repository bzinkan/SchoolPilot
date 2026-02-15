import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { ChevronDown, ChevronRight, ExternalLink, CheckCircle2 } from 'lucide-react';
import api from '../../../../shared/utils/api';

const AVATAR_COLORS = [
  'bg-blue-500', 'bg-pink-500', 'bg-green-500',
  'bg-purple-500', 'bg-yellow-500', 'bg-red-500',
];

function getInitials(firstName, lastName) {
  return `${(firstName || '')[0] || ''}${(lastName || '')[0] || ''}`.toUpperCase();
}

function getAvatarColor(name) {
  let hash = 0;
  for (let i = 0; i < (name || '').length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash);
  }
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];
}

function getDestinationStyle(destination) {
  const d = (destination || '').toLowerCase();
  if (d.includes('nurse')) return { bg: 'bg-red-50 dark:bg-red-950/40', text: 'text-red-600 dark:text-red-400', border: 'border-red-200 dark:border-red-800' };
  if (d.includes('office')) return { bg: 'bg-yellow-50 dark:bg-yellow-950/40', text: 'text-yellow-600 dark:text-yellow-400', border: 'border-yellow-200 dark:border-yellow-800' };
  if (d.includes('restroom') || d.includes('bathroom')) return { bg: 'bg-blue-50 dark:bg-blue-950/40', text: 'text-blue-600 dark:text-blue-400', border: 'border-blue-200 dark:border-blue-800' };
  return { bg: 'bg-purple-50 dark:bg-purple-950/40', text: 'text-purple-600 dark:text-purple-400', border: 'border-purple-200 dark:border-purple-800' };
}

function formatDuration(issuedAt) {
  if (!issuedAt) return '';
  const mins = Math.floor((Date.now() - new Date(issuedAt).getTime()) / 60000);
  if (mins < 1) return '<1 min';
  return `${mins} min`;
}

export default function PassPilotMiniView() {
  const [passes, setPasses] = useState([]);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState(true);
  const navigate = useNavigate();

  useEffect(() => {
    let mounted = true;
    const fetchPasses = async () => {
      try {
        const res = await api.get('/passpilot/passes/active');
        if (mounted) {
          const list = res.data?.passes || (Array.isArray(res.data) ? res.data : []);
          setPasses(list);
        }
      } catch {
        // Silent fail - widget is optional
      } finally {
        if (mounted) setLoading(false);
      }
    };
    fetchPasses();
    const interval = setInterval(fetchPasses, 15000);
    return () => { mounted = false; clearInterval(interval); };
  }, []);

  const displayPasses = passes.slice(0, 5);
  const remaining = passes.length - 5;

  return (
    <div className="border-b border-slate-200 dark:border-slate-700">
      {/* Branded Header */}
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-2.5 px-4 py-3 bg-gradient-to-r from-blue-500 to-blue-600 hover:from-blue-600 hover:to-blue-700 transition-colors"
      >
        <svg width="28" height="28" viewBox="0 0 64 64" fill="none" className="shrink-0">
          <defs>
            <linearGradient id="pp-sidebar-grad" x1="0%" y1="0%" x2="100%" y2="100%">
              <stop offset="0%" stopColor="#60a5fa" />
              <stop offset="100%" stopColor="#3b82f6" />
            </linearGradient>
          </defs>
          <rect width="64" height="64" rx="12" fill="url(#pp-sidebar-grad)" />
          <rect x="20" y="18" width="24" height="32" rx="3" fill="#fff" />
          <rect x="26" y="14" width="12" height="8" rx="2" fill="#fff" />
          <rect x="28" y="16" width="8" height="4" rx="1" fill="#3b82f6" />
          <path d="M26 34 L30 38 L38 28" stroke="#3b82f6" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" fill="none" />
        </svg>
        <span className="text-sm font-semibold text-white flex-1 text-left">PassPilot</span>
        <span className="text-xs font-bold text-white/90 bg-white/20 rounded-full px-2 py-0.5 min-w-[24px] text-center">
          {passes.length}
        </span>
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
              <div className="h-5 w-5 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
            </div>
          ) : passes.length === 0 ? (
            <div className="flex flex-col items-center py-4 text-center">
              <CheckCircle2 className="h-8 w-8 text-green-500 mb-2" />
              <p className="text-xs font-medium text-slate-600 dark:text-slate-300">All students in class</p>
              <p className="text-xs text-slate-400 dark:text-slate-500">No active passes</p>
            </div>
          ) : (
            <>
              {/* Live indicator */}
              <div className="flex items-center gap-1.5 px-1 mb-1">
                <div className="h-1.5 w-1.5 rounded-full bg-green-500 animate-pulse" />
                <span className="text-[10px] text-slate-400 dark:text-slate-500">Live</span>
              </div>

              {/* Pass list */}
              {displayPasses.map((pass) => {
                const student = pass.student || {};
                const name = `${student.firstName || ''} ${student.lastName || ''}`.trim() || 'Unknown';
                const initials = getInitials(student.firstName, student.lastName);
                const dest = pass.customDestination || pass.destination || 'General';
                const destStyle = getDestinationStyle(dest);
                const duration = formatDuration(pass.issuedAt);

                return (
                  <div key={pass.id} className="flex items-center gap-2 px-1 py-1.5 rounded-md hover:bg-slate-50 dark:hover:bg-slate-800/50 transition-colors">
                    <div className={`h-7 w-7 rounded-full ${getAvatarColor(name)} flex items-center justify-center shrink-0`}>
                      <span className="text-[10px] font-bold text-white">{initials}</span>
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-xs font-medium text-slate-800 dark:text-slate-200 truncate">{name}</p>
                      <div className="flex items-center gap-1.5">
                        <span className={`text-[10px] px-1.5 py-0.5 rounded border ${destStyle.bg} ${destStyle.text} ${destStyle.border}`}>
                          {dest}
                        </span>
                        {duration && (
                          <span className="text-[10px] text-slate-400 dark:text-slate-500">{duration}</span>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}

              {remaining > 0 && (
                <p className="text-[10px] text-slate-400 dark:text-slate-500 px-1">+{remaining} more</p>
              )}
            </>
          )}

          {/* Footer */}
          <div className="flex items-center gap-1 pt-1 border-t border-slate-100 dark:border-slate-800">
            <button
              onClick={() => navigate('/passpilot')}
              className="flex-1 text-xs font-medium text-blue-600 dark:text-blue-400 hover:text-blue-700 dark:hover:text-blue-300 py-1.5 rounded hover:bg-blue-50 dark:hover:bg-blue-950/30 transition-colors text-center"
            >
              View All Passes
            </button>
            <button
              onClick={(e) => { e.stopPropagation(); window.open('/passpilot', '_blank'); }}
              className="p-1.5 rounded text-slate-400 hover:text-slate-600 dark:hover:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
              title="Open PassPilot in new tab"
            >
              <ExternalLink className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
