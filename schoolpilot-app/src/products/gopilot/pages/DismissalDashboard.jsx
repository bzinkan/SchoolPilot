import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useGoPilotAuth } from '../../../hooks/useGoPilotAuth';
import { useSocket } from '../../../contexts/SocketContext';
import api from '../../../shared/utils/api';
import {
  ArrowLeft, Car, Bus, PersonStanding, Clock, Users, Search, Bell, AlertTriangle,
  Check, X, ChevronRight, ChevronDown, Phone, MapPin, Play, Pause,
  Volume2, VolumeX, RefreshCw, Filter, MoreVertical, CheckCircle2,
  AlertCircle, Timer, UserCheck, Send, ArrowRight, Shield, Eye,
  Smartphone, QrCode, MessageSquare, Home, Settings, LogOut, Menu,
  Zap, TrendingUp, Calendar, Download, Plus, Edit, Trash2
} from 'lucide-react';
import { ThemeToggle } from '../../../components/ThemeToggle';
import { useLicenses } from '../../../contexts/LicenseContext';
import { useNative } from '../../../contexts/NativeContext';

const Badge = ({ children, variant = 'default', size = 'md', dot = false }) => {
  const variants = {
    default: 'bg-gray-100 text-gray-800 dark:bg-slate-700 dark:text-slate-200',
    blue: 'bg-blue-100 text-blue-800 dark:bg-blue-950/50 dark:text-blue-300',
    green: 'bg-green-100 text-green-800 dark:bg-green-950/50 dark:text-green-300',
    yellow: 'bg-yellow-100 text-yellow-800 dark:bg-yellow-950/50 dark:text-yellow-300',
    red: 'bg-red-100 text-red-800 dark:bg-red-950/50 dark:text-red-300',
    purple: 'bg-purple-100 text-purple-800 dark:bg-purple-950/50 dark:text-purple-300',
    orange: 'bg-orange-100 text-orange-800 dark:bg-orange-950/50 dark:text-orange-300',
  };
  const sizes = { sm: 'px-2 py-0.5 text-xs', md: 'px-2.5 py-1 text-sm' };
  return (
    <span className={`inline-flex items-center gap-1 rounded-full font-medium ${variants[variant]} ${sizes[size]}`}>
      {dot && <span className="w-1.5 h-1.5 rounded-full bg-current" />}
      {children}
    </span>
  );
};

const Button = ({ children, variant = 'primary', size = 'md', onClick, disabled, className = '' }) => {
  const variants = {
    primary: 'bg-indigo-600 dark:bg-indigo-700 text-white hover:bg-indigo-700 disabled:bg-indigo-300',
    secondary: 'bg-white dark:bg-slate-800/50 text-gray-700 dark:text-slate-200 border border-gray-300 dark:border-slate-600 hover:bg-gray-50 dark:hover:bg-slate-800',
    success: 'bg-green-600 dark:bg-green-700 text-white hover:bg-green-700',
    danger: 'bg-red-600 text-white hover:bg-red-700',
    warning: 'bg-yellow-500 text-white hover:bg-yellow-600',
    ghost: 'text-gray-600 dark:text-slate-400 hover:bg-gray-100 dark:hover:bg-slate-800',
  };
  const sizes = { sm: 'px-3 py-1.5 text-sm', md: 'px-4 py-2 text-sm', lg: 'px-6 py-3 text-base' };
  return (
    <button onClick={onClick} disabled={disabled}
      className={`inline-flex items-center justify-center rounded-lg font-medium transition-colors ${variants[variant]} ${sizes[size]} ${className} disabled:cursor-not-allowed`}>
      {children}
    </button>
  );
};

const Card = ({ children, className = '' }) => (
  <div className={`bg-white dark:bg-slate-900 rounded-xl shadow-sm border border-gray-200 dark:border-slate-700 ${className}`}>{children}</div>
);

const EMPTY_STATS = { waiting: 0, called: 0, released: 0, dismissed: 0, held: 0, delayed: 0, total: 0, avgWaitSeconds: null };

const normalizeStats = (stats = {}) => ({
  ...EMPTY_STATS,
  ...stats,
  avgWaitSeconds: stats.avgWaitSeconds ?? stats.avg_wait_seconds ?? null,
});

const apiErrorMessage = (err, fallback) => err?.response?.data?.error || fallback;

const normalizeQueueEntry = (entry) => ({
  ...entry,
  pickupGroupId: entry.pickupGroupId ?? entry.pickup_group_id ?? null,
  pickupGroupLabel: entry.pickupGroupLabel ?? entry.pickup_group_label ?? entry.guardianName ?? entry.guardian_name ?? 'Unknown',
  studentId: entry.studentId ?? entry.student_id,
  firstName: entry.firstName ?? entry.first_name,
  lastName: entry.lastName ?? entry.last_name,
  guardianName: entry.guardianName ?? entry.guardian_name,
  checkInMethod: entry.checkInMethod ?? entry.check_in_method,
  effectiveDismissalType: entry.effectiveDismissalType ?? entry.dismissal_type,
  effectiveBusRoute: entry.effectiveBusRoute ?? entry.busRoute ?? entry.bus_route,
  permanentDismissalType: entry.permanentDismissalType ?? entry.permanent_dismissal_type,
  isOverridden: entry.isOverridden ?? entry.is_overridden ?? false,
});

const normalizeQueue = (data) => (Array.isArray(data) ? data : (data?.queue ?? [])).map(normalizeQueueEntry);

const queueGroups = (entries) => {
  const grouped = new Map();
  entries.forEach((item) => {
    const pickupGroupId = item.pickupGroupId ?? item.pickup_group_id ?? null;
    const key = pickupGroupId || `legacy:${item.id}`;
    if (!grouped.has(key)) {
      grouped.set(key, {
        key,
        pickupGroupId,
        name: item.pickupGroupLabel ?? item.pickup_group_label ?? item.guardianName ?? item.guardian_name ?? 'Unknown',
        students: [],
      });
    }
    grouped.get(key).students.push(item);
  });
  return Array.from(grouped.values());
};

const statusLabel = (sessionStatus) => ({
  not_started: 'Not Started',
  pending: 'Not Started',
  active: 'Active',
  paused: 'Paused',
  completed: 'Completed',
  'offline/stale': 'Offline/Stale',
}[sessionStatus] || sessionStatus);

export default function DismissalDashboard() {
  const { logout, currentSchool, currentRole } = useGoPilotAuth();
  const socket = useSocket();
  const navigate = useNavigate();
  const { hasClassPilot, hasPassPilot } = useLicenses();
  const { isNative } = useNative();
  const canManageSetup = currentRole === 'admin' || currentRole === 'school_admin';

  // Teachers should see their homeroom view, not the admin dashboard
  useEffect(() => {
    if (currentRole === 'teacher') {
      navigate('/gopilot/teacher', { replace: true });
    }
  }, [currentRole, navigate]);

  const [currentTime, setCurrentTime] = useState(new Date());
  const [session, setSession] = useState(null);
  const [realtimeStale, setRealtimeStale] = useState(false);
  const [dashboardError, setDashboardError] = useState(null);
  const [soundEnabled, setSoundEnabled] = useState(true);
  const [selectedView, setSelectedView] = useState('queue');
  const [queueTab, setQueueTab] = useState('active'); // 'active' or 'dismissed'
  const [searchTerm, setSearchTerm] = useState('');
  const [filterType, setFilterType] = useState('all');
  const [queue, setQueue] = useState([]);
  const [stats, setStats] = useState(EMPTY_STATS);
  const [homerooms, setHomerooms] = useState([]);
  const [alerts, setAlerts] = useState([]);
  const [allPickups, setAllPickups] = useState([]);
  const [busRoutes, setBusRoutes] = useState([]);
  const [loading, setLoading] = useState(true);
  const [pickupZones, setPickupZones] = useState([]);
  const [selectedZone, setSelectedZone] = useState(null);
  const [showZoneManager, setShowZoneManager] = useState(false);
  const [zoneSaving, setZoneSaving] = useState(false);
  const [carNumberInput, setCarNumberInput] = useState('');
  const [carNumberLoading, setCarNumberLoading] = useState(false);
  const [carNumberResult, setCarNumberResult] = useState(null); // { type: 'success'|'error', message };
  const [showQrScanner, setShowQrScanner] = useState(false);
  const [busNumberInput, setBusNumberInput] = useState('');
  const [busNumberLoading, setBusNumberLoading] = useState(false);
  const [busNumberResult, setBusNumberResult] = useState(null);
  const [busQueueTab, setBusQueueTab] = useState('active'); // 'active' or 'dismissed'

  // Walker state
  const [walkerViewTab, setWalkerViewTab] = useState('grade'); // 'grade' or 'homeroom'
  const [walkerQueueTab, setWalkerQueueTab] = useState('active'); // 'active' or 'dismissed'
  const [selectedGrades, setSelectedGrades] = useState([]);
  const [selectedWalkerHomerooms, setSelectedWalkerHomerooms] = useState([]);
  // Override state
  const [overrides, setOverrides] = useState({});
  const [afterschoolStudents, setAfterschoolStudents] = useState([]);
  const [showOverrideFor, setShowOverrideFor] = useState(null);
  const [overrideType, setOverrideType] = useState('');
  const [overrideReason, setOverrideReason] = useState('');
  const [overrideBusRoute, setOverrideBusRoute] = useState('');
  // Expandable homeroom state
  const [expandedHomeroom, setExpandedHomeroom] = useState(null);
  const [homeroomStudents, setHomeroomStudents] = useState([]);
  const [loadingStudents, setLoadingStudents] = useState(false);
  const [showEndConfirm, setShowEndConfirm] = useState(false);
  // Change request notifications
  const [changeRequests, setChangeRequests] = useState([]);
  const [showChangeNotifications, setShowChangeNotifications] = useState(false);
  const [unreadChangeCount, setUnreadChangeCount] = useState(0);
  const [showNoteFor, setShowNoteFor] = useState(null);
  const [changeReviewingId, setChangeReviewingId] = useState(null);
  // Student lookup state
  const [showStudentLookup, setShowStudentLookup] = useState(false);
  const [studentSearchTerm, setStudentSearchTerm] = useState('');
  const [studentSearchResults, setStudentSearchResults] = useState([]);
  const [studentSearchLoading, setStudentSearchLoading] = useState(false);
  const [custodyPickup, setCustodyPickup] = useState(null);
  const studentSearchTimeout = useRef(null);
  const snapshotRefreshTimeout = useRef(null);
  const snapshotRefreshInFlight = useRef(false);
  const sessionStatus = realtimeStale ? 'offline/stale' : (session?.status || 'not_started');
  const isSessionActive = session?.status === 'active' && !realtimeStale;

  // Initialize read-only dashboard snapshot
  const loadData = useCallback(async ({ silent = false } = {}) => {
    if (!currentSchool) return;
    try {
      if (!silent) setLoading(true);
      setDashboardError(null);
      const [sessionRes, homeroomRes, alertsRes, settingsRes, pickupsRes, busRoutesRes] = await Promise.all([
        api.get(`/schools/${currentSchool.id}/sessions/today`),
        api.get(`/schools/${currentSchool.id}/homerooms`),
        api.get(`/schools/${currentSchool.id}/custody-alerts`),
        api.get(`/schools/${currentSchool.id}/settings`),
        api.get('/pickups/all').catch(() => ({ data: { pickups: [] } })),
        api.get(`/schools/${currentSchool.id}/bus-routes`).catch(() => ({ data: { routes: [] } })),
      ]);
      const sessionData = sessionRes.data?.session || null;
      setSession(sessionData);
      setHomerooms(Array.isArray(homeroomRes.data) ? homeroomRes.data : (homeroomRes.data?.homerooms ?? []));
      setAlerts(Array.isArray(alertsRes.data) ? alertsRes.data : (alertsRes.data?.alerts ?? []));
      setAllPickups(Array.isArray(pickupsRes.data) ? pickupsRes.data : (pickupsRes.data?.pickups ?? []));
      setBusRoutes(busRoutesRes.data?.routes || []);

      if (sessionData?.id) {
        const [queueRes, statsRes] = await Promise.all([
          api.get(`/sessions/${sessionData.id}/queue`),
          api.get(`/sessions/${sessionData.id}/stats`),
        ]);
        setQueue(normalizeQueue(queueRes.data));
        setStats(normalizeStats(statsRes.data));

        try {
          const overridesRes = await api.get(`/sessions/${sessionData.id}/overrides`);
          const map = {};
          for (const o of overridesRes.data?.overrides || []) {
            map[o.studentId] = {
              overrideType: o.overrideType,
              reason: o.reason,
              busRoute: o.busRoute,
              studentName: o.studentName,
              homeroomId: o.homeroomId,
            };
          }
          setOverrides(map);
        } catch { /* non-critical */ }

        try {
          const changesRes = await api.get(`/sessions/${sessionData.id}/changes`);
          const changes = changesRes.data?.changes || [];
          setChangeRequests(changes.map(c => ({
            id: c.id,
            studentId: c.studentId,
            studentName: c.student ? `${c.student.firstName} ${c.student.lastName}` : '',
            fromType: c.fromType,
            toType: c.toType,
            busRoute: c.busRoute,
            note: c.note,
            status: c.status || 'pending',
            createdAt: c.createdAt,
          })));
        } catch { /* non-critical */ }
      } else {
        setQueue([]);
        setStats(EMPTY_STATS);
        setOverrides({});
        setChangeRequests([]);
      }

      // Fetch permanent afterschool students
      try {
        const afterRes = await api.get(`/schools/${currentSchool.id}/students`, { params: { dismissalType: 'afterschool' } });
        setAfterschoolStudents(afterRes.data?.students || []);
      } catch { /* non-critical */ }

      const zones = settingsRes.data.pickupZones || [
        { id: 'A', name: 'Zone A' }, { id: 'B', name: 'Zone B' }, { id: 'C', name: 'Zone C' }
      ];
      setPickupZones(zones);
      setSelectedZone(prev => prev && zones.find(z => z.id === prev) ? prev : zones[0]?.id || null);
      setRealtimeStale(false);
    } catch (err) {
      console.error('Failed to load dashboard data:', err);
      setDashboardError(apiErrorMessage(err, 'Failed to load dashboard data'));
    } finally {
      if (!silent) setLoading(false);
    }
  }, [currentSchool]);

  useEffect(() => { loadData(); }, [loadData]);

  // Clock
  useEffect(() => {
    const interval = setInterval(() => setCurrentTime(new Date()), 1000);
    return () => clearInterval(interval);
  }, []);

  // Socket listeners
  useEffect(() => {
    if (!socket || !currentSchool) return;

    const joinRoom = () => {
      socket.emit('join:school', { schoolId: currentSchool.id, role: 'admin' });
      setRealtimeStale(false);
    };
    const scheduleSnapshotRefresh = () => {
      if (snapshotRefreshTimeout.current) clearTimeout(snapshotRefreshTimeout.current);
      snapshotRefreshTimeout.current = setTimeout(async () => {
        if (snapshotRefreshInFlight.current) return;
        snapshotRefreshInFlight.current = true;
        try {
          await loadData({ silent: true });
        } finally {
          snapshotRefreshInFlight.current = false;
        }
      }, 250);
    };
    joinRoom();
    const handleConnect = () => {
      joinRoom();
      scheduleSnapshotRefresh();
    };
    const handleDisconnect = () => setRealtimeStale(true);
    socket.on('connect', handleConnect);
    socket.on('disconnect', handleDisconnect);

    const handleQueueUpdate = (data) => {
      if (data?.entry) {
        const entry = normalizeQueueEntry(data.entry);
        setQueue(prev => prev.map(q => q.id === entry.id ? { ...q, ...entry } : q));
      }
      scheduleSnapshotRefresh();
    };

    socket.on('queue:updated', handleQueueUpdate);
    socket.on('student:called', handleQueueUpdate);
    socket.on('student:released', handleQueueUpdate);
    socket.on('student:dismissed', handleQueueUpdate);
    socket.on('dismissal:status', scheduleSnapshotRefresh);
    socket.on('dismissal:started', scheduleSnapshotRefresh);
    socket.on('dismissal:ended', scheduleSnapshotRefresh);
    const handleChangeRequested = ({ change, studentName }) => {
      setChangeRequests(prev => [...prev, {
        id: change.id,
        studentId: change.studentId,
        studentName: studentName || '',
        fromType: change.fromType,
        toType: change.toType,
        busRoute: change.busRoute,
        note: change.note,
        status: change.status || 'pending',
        createdAt: change.createdAt,
      }]);
      setUnreadChangeCount(prev => prev + 1);
    };
    socket.on('change:requested', handleChangeRequested);
    const handleChangeResolved = ({ change }) => {
      if (!change?.id) return;
      setChangeRequests(prev => prev.map(cr => (
        cr.id === change.id
          ? { ...cr, status: change.status || cr.status, reviewedAt: change.reviewedAt || cr.reviewedAt }
          : cr
      )));
      scheduleSnapshotRefresh();
    };
    socket.on('change:resolved', handleChangeResolved);

    const handleTypeUpdated = ({ studentId, dismissalType, busRoute }) => {
      setHomeroomStudents(prev => prev.map(s =>
        s.id === studentId ? { ...s, effectiveDismissalType: dismissalType, effectiveBusRoute: busRoute, isOverridden: true } : s
      ));
      if (dismissalType === 'afterschool') {
        setAfterschoolStudents(prev => {
          if (prev.some(s => s.id === studentId)) return prev;
          return [...prev, { id: studentId, dismissalType }];
        });
      } else {
        setAfterschoolStudents(prev => prev.filter(s => s.id !== studentId));
      }
    };
    socket.on('student:typeUpdated', handleTypeUpdated);

    const handleOverride = (data) => {
      if (data.overrideType) {
        setOverrides(prev => ({ ...prev, [data.studentId]: { overrideType: data.overrideType, reason: data.reason, busRoute: data.busRoute, studentName: data.studentName } }));
      } else {
        setOverrides(prev => { const next = { ...prev }; delete next[data.studentId]; return next; });
      }
      scheduleSnapshotRefresh();
    };
    socket.on('dismissal:override', handleOverride);

    return () => {
      if (snapshotRefreshTimeout.current) clearTimeout(snapshotRefreshTimeout.current);
      socket.off('connect', handleConnect);
      socket.off('disconnect', handleDisconnect);
      socket.off('queue:updated', handleQueueUpdate);
      socket.off('student:called', handleQueueUpdate);
      socket.off('student:released', handleQueueUpdate);
      socket.off('student:dismissed', handleQueueUpdate);
      socket.off('dismissal:status', scheduleSnapshotRefresh);
      socket.off('dismissal:started', scheduleSnapshotRefresh);
      socket.off('dismissal:ended', scheduleSnapshotRefresh);
      socket.off('change:requested', handleChangeRequested);
      socket.off('change:resolved', handleChangeResolved);
      socket.off('student:typeUpdated', handleTypeUpdated);
      socket.off('dismissal:override', handleOverride);
    };
  }, [socket, currentSchool, loadData]);

  const reviewChangeRequest = useCallback(async (changeId, status) => {
    if (!changeId || !['approved', 'rejected'].includes(status)) return;
    const reviewKey = `${changeId}:${status}`;
    setChangeReviewingId(reviewKey);
    setDashboardError(null);
    try {
      const res = await api.put(`/changes/${changeId}`, { status });
      const updated = res.data?.change;
      setChangeRequests(prev => prev.map(cr => (
        cr.id === changeId
          ? { ...cr, ...(updated || {}), status: updated?.status || status }
          : cr
      )));
      await loadData({ silent: true });
    } catch (err) {
      setDashboardError(apiErrorMessage(err, `Could not ${status} change request`));
    } finally {
      setChangeReviewingId(null);
    }
  }, [loadData]);

  // Effective afterschool list: permanent afterschool students + override-to-afterschool
  // Build lookup: studentId → pickups[]
  const pickupsByStudent = useMemo(() => {
    const map = {};
    for (const p of allPickups) {
      if (!map[p.studentId]) map[p.studentId] = [];
      map[p.studentId].push(p);
    }
    return map;
  }, [allPickups]);

  const effectiveAfterschoolList = useMemo(() => {
    const result = new Map();

    // Permanent afterschool students (unless overridden away)
    for (const s of afterschoolStudents) {
      const override = overrides[s.id];
      if (override && override.overrideType !== 'afterschool') continue;
      result.set(s.id, {
        studentId: s.id,
        studentName: `${s.firstName || s.first_name || ''} ${s.lastName || s.last_name || ''}`.trim(),
        reason: override?.reason || s.afterschoolReason || s.afterschool_reason || 'After School Program',
      });
    }

    // Override-to-afterschool students (not already in the map)
    for (const [studentId, o] of Object.entries(overrides)) {
      if (o.overrideType === 'afterschool' && !result.has(studentId)) {
        result.set(studentId, {
          studentId,
          studentName: o.studentName || 'Student',
          reason: o.reason || 'After School Activity',
        });
      }
    }

    return Array.from(result.values());
  }, [afterschoolStudents, overrides]);

  const custodyAlertsByStudent = useMemo(() => {
    const map = {};
    for (const alert of alerts) {
      const studentId = alert.studentId ?? alert.student_id;
      if (!studentId) continue;
      if (!map[studentId]) map[studentId] = [];
      map[studentId].push(alert);
    }
    return map;
  }, [alerts]);

  const requireActiveSession = (action = 'This action') => {
    if (isSessionActive) return true;
    setDashboardError(`${action} requires an active dismissal session.`);
    return false;
  };

  const resetOverrideModal = () => {
    setShowOverrideFor(null);
    setOverrideType('');
    setOverrideReason('');
    setOverrideBusRoute('');
  };

  // Actions
  const handleToggleDismissal = async () => {
    try {
      setDashboardError(null);
      let targetSession = session;
      if (!targetSession) {
        const created = await api.post(`/schools/${currentSchool.id}/sessions`);
        targetSession = created.data?.session || created.data;
      }
      if (targetSession?.status === 'completed') {
        setDashboardError('Today’s dismissal session is completed and cannot be restarted.');
        return;
      }
      const newStatus = targetSession?.status === 'active' ? 'paused' : 'active';
      const res = await api.put(`/sessions/${targetSession.id}`, { status: newStatus });
      setSession(res.data?.session || { ...targetSession, status: newStatus });
      await loadData({ silent: true });
    } catch (err) {
      setDashboardError(apiErrorMessage(err, 'Unable to update dismissal status'));
    }
  };

  const handleEndDismissal = async () => {
    if (!session) return;
    try {
      setDashboardError(null);
      const res = await api.put(`/sessions/${session.id}`, { status: 'completed' });
      setSession(res.data?.session || { ...session, status: 'completed' });
      setShowEndConfirm(false);
      await loadData({ silent: true });
    } catch (err) {
      console.error('Failed to end dismissal:', err);
      const counts = err?.response?.data?.counts;
      const countText = counts ? ` Waiting: ${counts.waiting || 0}, called: ${counts.called || 0}, in transit: ${counts.released || 0}.` : '';
      setDashboardError(`${apiErrorMessage(err, 'Failed to end dismissal')}${countText}`);
    }
  };

  const handleCallStudent = async (queueId) => {
    if (!session || !requireActiveSession('Calling students')) return;
    try {
      await api.post(`/sessions/${session.id}/call`, { queueId, zone: selectedZone || pickupZones[0]?.id });
      await refreshQueue();
    } catch (err) { setDashboardError(apiErrorMessage(err, 'Unable to call student')); }
  };

  const handleMarkPickedUp = async (itemOrQueueId, options = {}) => {
    if (!requireActiveSession('Pickup completion')) return;
    const item = typeof itemOrQueueId === 'object' ? itemOrQueueId : queue.find(q => q.id === itemOrQueueId);
    const queueId = item?.id || itemOrQueueId;
    const studentAlerts = item ? (custodyAlertsByStudent[item.studentId || item.student_id] || []) : [];
    if (studentAlerts.length > 0 && !options.custodyAcknowledged) {
      setCustodyPickup({ item, queueId, alerts: studentAlerts });
      return;
    }
    try {
      await api.post(`/queue/${queueId}/dismiss`, {
        custodyAcknowledged: !!options.custodyAcknowledged,
        pickupPersonName: options.pickupPersonName || undefined,
        pickupNote: options.pickupNote || undefined,
      });
      setCustodyPickup(null);
      await refreshQueue();
    } catch (err) {
      if (err?.response?.status === 409 && err.response?.data?.custodyAlerts) {
        setCustodyPickup({ item, queueId, alerts: err.response.data.custodyAlerts });
        return;
      }
      setDashboardError(apiErrorMessage(err, 'Unable to complete pickup'));
    }
  };

  const handlePickupAll = async (students) => {
    if (!requireActiveSession('Batch pickup')) return;
    const pickupGroupId = students[0]?.pickupGroupId ?? students[0]?.pickup_group_id;
    if (!pickupGroupId) {
      setDashboardError('Batch pickup requires a stable pickup group. Complete these students individually.');
      return;
    }
    const eligible = students.filter(s => {
      const studentId = s.studentId || s.student_id;
      return s.status === 'released' && !(custodyAlertsByStudent[studentId]?.length);
    });
    if (eligible.length === 0) return;
    try {
      const res = await api.post('/queue/dismiss-batch', { queueIds: eligible.map(s => s.id), pickupGroupId });
      if (res.data?.skippedCustody?.length) {
        setDashboardError('Some students were skipped because a custody alert requires individual acknowledgement.');
      }
      await refreshQueue();
    } catch (err) { setDashboardError(apiErrorMessage(err, 'Unable to complete batch pickup')); }
  };

  const [walkerLoading, setWalkerLoading] = useState(false);
  const [walkerResult, setWalkerResult] = useState(null);
  const handleReleaseWalkers = async () => {
    if (!session || !requireActiveSession('Walker dismissal')) return;
    setWalkerLoading(true);
    setWalkerResult(null);
    try {
      const res = await api.post(`/sessions/${session.id}/release-walkers`);
      if (res.data.outcome === 'duplicate') {
        setWalkerResult({ type: 'info', message: 'Walkers already dismissed' });
      } else {
        setWalkerResult({ type: res.data.outcome === 'partial' ? 'info' : 'success', message: `Dismissed ${res.data.entries?.length || 0} walker students` });
        await refreshQueue();
      }
      setTimeout(() => setWalkerResult(null), 5000);
    } catch (err) {
      setWalkerResult({ type: 'error', message: err.response?.data?.error || 'Failed to dismiss walkers' });
    } finally {
      setWalkerLoading(false);
    }
  };

  const handleReleaseSelectedWalkers = async () => {
    if (!session || !requireActiveSession('Walker dismissal')) return;
    const filterType = walkerViewTab; // 'grade' or 'homeroom'
    const filterValues = walkerViewTab === 'grade' ? selectedGrades : selectedWalkerHomerooms;
    if (filterValues.length === 0) {
      setWalkerResult({ type: 'error', message: `Please select at least one ${filterType}` });
      setTimeout(() => setWalkerResult(null), 3000);
      return;
    }
    setWalkerLoading(true);
    setWalkerResult(null);
    try {
      const res = await api.post(`/sessions/${session.id}/release-walkers-by-filter`, { filterType, filterValues });
      if ((res.data.entries?.length || 0) === 0) {
        setWalkerResult({ type: 'info', message: 'No walker students to dismiss for selected ' + filterType + 's' });
      } else {
        setWalkerResult({ type: res.data.outcome === 'partial' ? 'info' : 'success', message: `Dismissed ${res.data.entries.length} walker students` });
        await refreshQueue();
      }
      setSelectedGrades([]);
      setSelectedWalkerHomerooms([]);
      setTimeout(() => setWalkerResult(null), 5000);
    } catch (err) {
      setWalkerResult({ type: 'error', message: err.response?.data?.error || 'Failed to dismiss walkers' });
    } finally {
      setWalkerLoading(false);
    }
  };

  const toggleGradeSelection = (grade) => {
    setSelectedGrades(prev => prev.includes(grade) ? prev.filter(g => g !== grade) : [...prev, grade]);
  };

  const toggleHomeroomSelection = (homeroomId) => {
    setSelectedWalkerHomerooms(prev => prev.includes(homeroomId) ? prev.filter(h => h !== homeroomId) : [...prev, homeroomId]);
  };

  const handleSaveZones = async (zones) => {
    if (!currentSchool) return;
    setZoneSaving(true);
    try {
      const settingsRes = await api.get(`/schools/${currentSchool.id}/settings`);
      const settings = settingsRes.data;
      settings.pickupZones = zones;
      await api.put(`/schools/${currentSchool.id}/settings`, settings);
      setPickupZones(zones);
      if (zones.length > 0 && !zones.find(z => z.id === selectedZone)) {
        setSelectedZone(zones[0].id);
      }
      setShowZoneManager(false);
    } catch (err) {
      console.error('Failed to save zones:', err);
    } finally {
      setZoneSaving(false);
    }
  };

  const formatCheckInResult = (data, fallbackLabel) => {
    const entries = Array.isArray(data?.entries) ? data.entries : [];
    const skippedAbsent = Array.isArray(data?.skippedAbsent) ? data.skippedAbsent : [];
    const groupLabel = data?.groupLabel || fallbackLabel;
    const names = entries
      .map(e => e.studentName || [e.first_name, e.last_name].filter(Boolean).join(' ') || e.studentId)
      .filter(Boolean)
      .join(', ');
    const skippedNames = skippedAbsent
      .map(s => s.studentName || s.studentId)
      .filter(Boolean)
      .join(', ');

    if (data?.outcome === 'duplicate') {
      return { type: 'info', message: `${groupLabel} already in queue`, createdCount: 0 };
    }
    if (entries.length === 0) {
      return {
        type: skippedAbsent.length > 0 ? 'info' : 'error',
        message: skippedAbsent.length > 0
          ? `${groupLabel} — no students checked in; skipped absent: ${skippedNames}`
          : `${groupLabel} — no students checked in`,
        createdCount: 0,
      };
    }

    const skippedText = skippedAbsent.length > 0 ? `; skipped absent: ${skippedNames}` : '';
    return {
      type: data?.outcome === 'partial' ? 'info' : 'success',
      message: `${groupLabel} — checked in: ${names}${skippedText}`,
      createdCount: entries.length,
    };
  };

  const handleCarNumberCheckIn = async () => {
    if (!carNumberInput.trim() || !session) return;
    if (!requireActiveSession('Car check-in')) return;
    setCarNumberLoading(true);
    setCarNumberResult(null);
    try {
      const res = await api.post(`/sessions/${session.id}/check-in-by-number`, { carNumber: carNumberInput.trim() });
      const result = formatCheckInResult(res.data, `Car #${carNumberInput.trim()}`);
      setCarNumberResult({ type: result.type, message: result.message });
      setCarNumberInput('');
      if (result.createdCount > 0) await refreshQueue();
      setTimeout(() => setCarNumberResult(null), 5000);
    } catch (err) {
      setCarNumberResult({ type: 'error', message: err.response?.data?.error || 'Check-in failed' });
    } finally {
      setCarNumberLoading(false);
    }
  };

  const handleBusNumberCheckIn = async () => {
    if (!busNumberInput.trim() || !session) return;
    if (!requireActiveSession('Bus check-in')) return;
    setBusNumberLoading(true);
    setBusNumberResult(null);
    try {
      const res = await api.post(`/sessions/${session.id}/check-in-by-bus`, { busNumber: busNumberInput.trim() });
      const result = formatCheckInResult(res.data, `Bus #${busNumberInput.trim()}`);
      setBusNumberResult({ type: result.type, message: result.message });
      setBusNumberInput('');
      if (result.createdCount > 0) await refreshQueue();
      setTimeout(() => setBusNumberResult(null), 5000);
    } catch (err) {
      setBusNumberResult({ type: 'error', message: err.response?.data?.error || 'Check-in failed' });
    } finally {
      setBusNumberLoading(false);
    }
  };

  const handleQrScanned = (decodedText) => {
    setShowQrScanner(false);
    // Parse gopilot://checkin?car=142&school=demo
    let carNumber = null;
    try {
      const url = new URL(decodedText);
      carNumber = url.searchParams.get('car');
    } catch {
      // Try plain number
      const match = decodedText.match(/\d+/);
      if (match) carNumber = match[0];
    }
    if (carNumber) {
      if (!requireActiveSession('QR check-in')) return;
      setCarNumberInput(carNumber);
      // Auto-submit after a tick so state updates
      setTimeout(async () => {
        setCarNumberLoading(true);
        setCarNumberResult(null);
        try {
          const res = await api.post(`/sessions/${session.id}/check-in-by-number`, { carNumber });
          const result = formatCheckInResult(res.data, `Car #${carNumber}`);
          setCarNumberResult({ type: result.type, message: result.message });
          setCarNumberInput('');
          if (result.createdCount > 0) await refreshQueue();
          setTimeout(() => setCarNumberResult(null), 5000);
        } catch (err) {
          setCarNumberResult({ type: 'error', message: err.response?.data?.error || 'Check-in failed' });
        } finally {
          setCarNumberLoading(false);
        }
      }, 0);
    } else {
      setCarNumberResult({ type: 'error', message: 'Could not read car number from QR code' });
      setTimeout(() => setCarNumberResult(null), 5000);
    }
  };

  const refreshQueue = async () => {
    if (!session) return;
    const [queueRes, statsRes] = await Promise.all([
      api.get(`/sessions/${session.id}/queue`),
      api.get(`/sessions/${session.id}/stats`),
    ]);
    setQueue(normalizeQueue(queueRes.data));
    setStats(normalizeStats(statsRes.data));
  };

  // Toggle homeroom expansion (accordion)
  const toggleHomeroom = async (roomId) => {
    if (expandedHomeroom === roomId) {
      setExpandedHomeroom(null);
      setHomeroomStudents([]);
      return;
    }
    setExpandedHomeroom(roomId);
    setLoadingStudents(true);
    try {
      const res = await api.get(`/schools/${currentSchool.id}/students?homeroomId=${roomId}`);
      const students = Array.isArray(res.data) ? res.data : (res.data?.students ?? []);
      setHomeroomStudents(students.map(student => ({
        ...student,
        permanentDismissalType: student.permanentDismissalType ?? student.dismissalType ?? student.dismissal_type,
        permanentBusRoute: student.permanentBusRoute ?? student.busRoute ?? student.bus_route,
        effectiveDismissalType: overrides[student.id]?.overrideType ?? student.effectiveDismissalType ?? student.dismissalType ?? student.dismissal_type,
        effectiveBusRoute: overrides[student.id]?.busRoute ?? student.effectiveBusRoute ?? student.busRoute ?? student.bus_route,
        isOverridden: !!overrides[student.id],
        overrideReason: overrides[student.id]?.reason,
      })));
    } catch (err) {
      console.error('Failed to load students', err);
      setHomeroomStudents([]);
    }
    setLoadingStudents(false);
  };

  // Override handler
  const handleOverrideSubmit = async () => {
    if (!session?.id || !showOverrideFor || !overrideType) return;
    if (!requireActiveSession('Dismissal overrides')) return;
    if (overrideType === 'bus' && !overrideBusRoute.trim()) {
      setDashboardError('Choose a bus route for bus overrides.');
      return;
    }
    try {
      await api.post(`/sessions/${session.id}/override`, {
        studentId: showOverrideFor,
        overrideType,
        busRoute: overrideType === 'bus' ? overrideBusRoute.trim() : undefined,
        reason: overrideReason || undefined,
      });
      setOverrides(prev => ({ ...prev, [showOverrideFor]: { overrideType, reason: overrideReason, busRoute: overrideType === 'bus' ? overrideBusRoute.trim() : null } }));
      resetOverrideModal();
      await refreshQueue();
    } catch (err) {
      setDashboardError(apiErrorMessage(err, 'Failed to change dismissal type'));
    }
  };

  const handleOverrideRevert = async () => {
    if (!session?.id || !showOverrideFor) return;
    if (!requireActiveSession('Reverting overrides')) return;
    try {
      await api.delete(`/sessions/${session.id}/override/${showOverrideFor}`);
      setOverrides(prev => { const next = { ...prev }; delete next[showOverrideFor]; return next; });
      resetOverrideModal();
      await refreshQueue();
    } catch (err) {
      setDashboardError(apiErrorMessage(err, 'Failed to revert dismissal override'));
    }
  };

  // Student lookup search with debounce
  const handleStudentSearch = (term) => {
    setStudentSearchTerm(term);
    if (studentSearchTimeout.current) clearTimeout(studentSearchTimeout.current);
    if (!term.trim()) {
      setStudentSearchResults([]);
      return;
    }
    studentSearchTimeout.current = setTimeout(async () => {
      setStudentSearchLoading(true);
      try {
        const res = await api.get(`/schools/${currentSchool.id}/students`, { params: { search: term.trim() } });
        setStudentSearchResults(res.data?.students || res.data || []);
      } catch (err) {
        console.error('Student search failed:', err);
        setStudentSearchResults([]);
      } finally {
        setStudentSearchLoading(false);
      }
    }, 300);
  };

  const handleUseCarNumber = (carNumber) => {
    setCarNumberInput(carNumber);
    setShowStudentLookup(false);
    setStudentSearchTerm('');
    setStudentSearchResults([]);
  };

  // Filter queue - exclude bus students from car queue (they show in Buses tab)
  // Split into active (in progress) and dismissed (completed)
  const carQueue = queue.filter(q => (q.checkInMethod ?? q.check_in_method) !== 'bus_number' && (q.checkInMethod ?? q.check_in_method) !== 'walker');
  const activeQueue = carQueue.filter(q => q.status !== 'dismissed');
  const dismissedQueue = carQueue.filter(q => q.status === 'dismissed');

  const filteredQueue = (queueTab === 'dismissed' ? dismissedQueue : activeQueue).filter(q => {
    const name = `${q.firstName ?? q.first_name ?? ''} ${q.lastName ?? q.last_name ?? ''}`.toLowerCase();
    if (searchTerm && !name.includes(searchTerm.toLowerCase())) return false;
    if (queueTab === 'active') {
      if (filterType === 'waiting' && q.status !== 'waiting') return false;
      if (filterType === 'called' && q.status !== 'called') return false;
      if (filterType === 'released' && q.status !== 'released') return false;
    }
    return true;
  });

  const avgWait = stats.avgWaitSeconds ? `${Math.floor(stats.avgWaitSeconds / 60)}:${String(Math.floor(stats.avgWaitSeconds % 60)).padStart(2, '0')}` : '--:--';

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-100">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-indigo-600"></div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-100 dark:bg-slate-950">
      {/* Header */}
      <header className="bg-white dark:bg-slate-900 border-b dark:border-slate-700 sticky top-0 z-50">
        <div className="px-3 sm:px-4 py-2 sm:py-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 sm:gap-4">
              {!isNative && (hasClassPilot || hasPassPilot) && (
                <div className="flex items-center gap-1">
                  {hasClassPilot && (
                    <button
                      onClick={() => navigate('/classpilot')}
                      className="px-3 py-1 rounded-md text-sm font-semibold bg-yellow-400 text-blue-900 hover:bg-yellow-300 transition-colors"
                    >
                      ClassPilot
                    </button>
                  )}
                  {hasPassPilot && (
                    <button
                      onClick={() => navigate('/passpilot')}
                      className="px-3 py-1 rounded-md text-sm font-semibold bg-blue-600 text-white hover:bg-blue-500 transition-colors"
                    >
                      PassPilot
                    </button>
                  )}
                </div>
              )}
              <div className="flex items-center gap-2 sm:gap-3">
                <div className="w-8 h-8 sm:w-10 sm:h-10 bg-indigo-600 rounded-xl flex items-center justify-center">
                  <Car className="w-4 h-4 sm:w-5 sm:h-5 text-white" />
                </div>
                <div>
                  <h1 className="font-bold text-sm sm:text-base text-gray-900 dark:text-white">GoPilot</h1>
                  <p className="text-[10px] sm:text-xs text-gray-500 dark:text-slate-400 dark:text-slate-400 dark:text-slate-400 truncate max-w-[100px] sm:max-w-none">{currentSchool?.name || 'No School Selected'}</p>
                </div>
              </div>
              <div className={`flex ml-2 sm:ml-6 px-3 sm:px-4 py-1.5 sm:py-2 rounded-lg items-center gap-2 ${sessionStatus === 'active' ? 'bg-green-100 dark:bg-green-950/50' : sessionStatus === 'completed' ? 'bg-blue-100 dark:bg-blue-950/50' : sessionStatus === 'offline/stale' ? 'bg-amber-100 dark:bg-amber-950/50' : 'bg-gray-100 dark:bg-slate-800'}`}>
                <span className={`w-2 h-2 rounded-full ${sessionStatus === 'active' ? 'bg-green-500 animate-pulse' : sessionStatus === 'offline/stale' ? 'bg-amber-500' : 'bg-gray-400'}`} />
                <span className={`text-xs sm:text-sm font-medium ${sessionStatus === 'active' ? 'text-green-700 dark:text-green-400' : sessionStatus === 'offline/stale' ? 'text-amber-700 dark:text-amber-300' : 'text-gray-600 dark:text-slate-400'}`}>
                  {statusLabel(sessionStatus)}
                </span>
              </div>
            </div>
            <div className="flex items-center gap-2 sm:gap-4">
              <div className="text-right hidden md:block">
                <p className="text-2xl font-bold text-gray-900 dark:text-white">
                  {currentTime.toLocaleTimeString([], { timeZone: currentSchool?.timezone, hour: '2-digit', minute: '2-digit' })}
                </p>
                <p className="text-xs text-gray-500 dark:text-slate-400 dark:text-slate-400">
                  {currentTime.toLocaleDateString([], { timeZone: currentSchool?.timezone, weekday: 'long', month: 'short', day: 'numeric' })}
                </p>
              </div>
              <p className="text-sm font-bold text-gray-900 dark:text-white md:hidden">
                {currentTime.toLocaleTimeString([], { timeZone: currentSchool?.timezone, hour: '2-digit', minute: '2-digit' })}
              </p>
              <div className="flex items-center gap-1 sm:gap-2">
                <div className="relative">
                  <button
                    onClick={() => {
                      const opening = !showChangeNotifications;
                      setShowChangeNotifications(opening);
                      if (opening) {
                        setUnreadChangeCount(0);
                      }
                    }}
                    className="p-2 rounded-lg hover:bg-gray-100 dark:hover:bg-slate-800 relative"
                  >
                    <Bell className="w-5 h-5 text-gray-600 dark:text-gray-300" />
                    {unreadChangeCount > 0 && (
                      <span className="absolute -top-1 -right-1 w-5 h-5 bg-red-500 text-white text-[10px] font-bold rounded-full flex items-center justify-center">
                        {unreadChangeCount}
                      </span>
                    )}
                  </button>
                  {showChangeNotifications && (
                    <div className="absolute right-0 top-full mt-1 w-80 bg-white dark:bg-slate-800 rounded-xl shadow-xl border dark:border-slate-700 z-[100] max-h-96 overflow-y-auto">
                      <div className="p-3 border-b dark:border-slate-700 font-semibold text-sm flex items-center justify-between">
                        <span>Change Requests</span>
                        <button onClick={() => setShowChangeNotifications(false)} className="p-1 hover:bg-gray-100 dark:hover:bg-slate-700 rounded"><X className="w-4 h-4" /></button>
                      </div>
                      {changeRequests.length === 0 ? (
                        <div className="p-4 text-center text-sm text-gray-400">No change requests</div>
                      ) : (
                        changeRequests.map((cr, i) => (
                          <div key={cr.id || i} className={`p-3 border-b last:border-b-0 dark:border-slate-700 ${cr.status !== 'pending' ? 'opacity-70' : ''} hover:bg-gray-50 dark:hover:bg-slate-700/50`}>
                            <div className="flex items-center justify-between">
                              <p className="text-sm font-medium flex items-center gap-1.5">
                                {cr.studentName}
                                {cr.status === 'approved' && <CheckCircle2 className="w-3.5 h-3.5 text-green-500" />}
                                {cr.status === 'rejected' && <X className="w-3.5 h-3.5 text-red-500" />}
                              </p>
                              <span className="text-xs text-gray-400">{cr.createdAt ? new Date(cr.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : ''}</span>
                            </div>
                            <p className="text-xs text-gray-500 mt-0.5">
                              <span className="capitalize">{cr.fromType}</span> → <span className="capitalize">{cr.toType}</span>
                              {cr.busRoute && <span> ({cr.busRoute})</span>}
                            </p>
                            {cr.note && (
                              <p className="text-xs bg-amber-50 dark:bg-amber-900/30 text-amber-800 dark:text-amber-200 rounded px-2 py-1 mt-1">
                                <MessageSquare className="w-3 h-3 inline mr-1" />{cr.note}
                              </p>
                            )}
                            {cr.status === 'pending' ? (
                              <div className="mt-2 flex gap-2">
                                <Button
                                  variant="success"
                                  size="sm"
                                  className="h-8 flex-1 gap-1"
                                  onClick={() => reviewChangeRequest(cr.id, 'approved')}
                                  disabled={!!changeReviewingId}
                                >
                                  <Check className="w-3.5 h-3.5" />
                                  Approve
                                </Button>
                                <Button
                                  variant="secondary"
                                  size="sm"
                                  className="h-8 flex-1 gap-1"
                                  onClick={() => reviewChangeRequest(cr.id, 'rejected')}
                                  disabled={!!changeReviewingId}
                                >
                                  <X className="w-3.5 h-3.5" />
                                  Reject
                                </Button>
                              </div>
                            ) : (
                              <p className="mt-2 text-xs font-medium capitalize text-gray-500 dark:text-slate-400">
                                {cr.status}
                              </p>
                            )}
                          </div>
                        ))
                      )}
                    </div>
                  )}
                </div>
                <ThemeToggle />
                <Button variant={soundEnabled ? 'secondary' : 'ghost'} size="sm" onClick={() => setSoundEnabled(!soundEnabled)}>
                  {soundEnabled ? <Volume2 className="w-4 h-4" /> : <VolumeX className="w-4 h-4" />}
                </Button>
                {session?.status === 'active' ? (
                  <>
                    <Button variant="secondary" size="sm" onClick={handleToggleDismissal}>
                      <Pause className="w-4 h-4" />
                      <span className="hidden sm:inline ml-1">Pause</span>
                    </Button>
                    <button onClick={() => setShowEndConfirm(true)} className="flex items-center gap-1 px-3 py-1.5 bg-red-600 hover:bg-red-700 text-white text-sm font-medium rounded-lg transition-colors">
                      <X className="w-4 h-4" />
                      <span className="hidden sm:inline">End</span>
                    </button>
                  </>
                ) : (
                  <Button variant="success" size="sm" onClick={handleToggleDismissal} disabled={session?.status === 'completed' || realtimeStale}>
                    {session?.status === 'paused' ? <Play className="w-4 h-4" /> : <Play className="w-4 h-4" />}
                    <span className="hidden sm:inline ml-1">{session?.status === 'paused' ? 'Resume' : 'Start'}</span>
                  </Button>
                )}
                <Button variant="ghost" size="sm" onClick={() => { logout(); navigate('/login'); }}>
                  <LogOut className="w-4 h-4" />
                </Button>
              </div>
            </div>
          </div>
        </div>
        {dashboardError && (
          <div className="bg-amber-50 dark:bg-amber-950/40 border-t border-amber-200 dark:border-amber-800 px-4 py-2">
            <div className="flex items-center gap-3">
              <AlertCircle className="w-5 h-5 text-amber-500" />
              <span className="text-sm text-amber-800 dark:text-amber-200 font-medium">{dashboardError}</span>
              <Button variant="ghost" size="sm" className="ml-auto text-amber-700" onClick={() => setDashboardError(null)}>Dismiss</Button>
            </div>
          </div>
        )}
        {alerts.length > 0 && (
          <div className="bg-red-50 dark:bg-red-950/40 border-t border-red-200 dark:border-red-800 px-4 py-2">
            <div className="flex items-center gap-3">
              <AlertTriangle className="w-5 h-5 text-red-500" />
              <span className="text-sm text-red-700 dark:text-red-400 font-medium">
                Custody alert: {alerts[0].personName || alerts[0].person_name} - {alerts[0].alertType || alerts[0].alert_type} ({alerts[0].studentName || `${alerts[0].studentFirstName || alerts[0].student_first_name || ''} ${alerts[0].studentLastName || alerts[0].student_last_name || ''}`.trim()})
              </span>
              <span className="ml-auto text-xs text-red-600">{alerts.length} active</span>
            </div>
          </div>
        )}
      </header>

      {/* Stats Bar */}
      <div className="bg-white dark:bg-slate-900 border-b dark:border-slate-700 px-3 sm:px-4 py-2 sm:py-3 overflow-x-auto">
        <div className="flex items-center gap-4 sm:gap-6 min-w-max sm:min-w-0">
          <div className="text-center">
            <p className="text-lg sm:text-2xl font-bold text-green-600">{stats.dismissed}</p>
            <p className="text-[10px] sm:text-xs text-gray-500 dark:text-slate-400 dark:text-slate-400">Dismissed</p>
          </div>
          <div className="text-center">
            <p className="text-lg sm:text-2xl font-bold text-red-600">{(stats.waiting || 0) + (stats.called || 0)}</p>
            <p className="text-[10px] sm:text-xs text-gray-500 dark:text-slate-400 dark:text-slate-400">In Queue</p>
          </div>
          <div className="text-center">
            <p className="text-lg sm:text-2xl font-bold text-green-600">{stats.released || 0}</p>
            <p className="text-[10px] sm:text-xs text-gray-500 dark:text-slate-400 dark:text-slate-400">In Transit</p>
          </div>
          <div className="border-l pl-4 sm:pl-6 text-center">
            <p className="text-lg sm:text-2xl font-bold text-indigo-600">{avgWait}</p>
            <p className="text-[10px] sm:text-xs text-gray-500 dark:text-slate-400 dark:text-slate-400">Avg Wait</p>
          </div>
        </div>
      </div>

      {/* Main Content */}
      <div className="flex pb-16 sm:pb-0">
        {/* Desktop sidebar */}
        <aside className="hidden sm:flex w-16 bg-white dark:bg-slate-900 border-r dark:border-slate-700 flex-col items-center py-4 gap-2">
          {[
            { id: 'queue', icon: Users, label: 'Queue' },
            { id: 'homerooms', icon: Home, label: 'Rooms' },
            { id: 'buses', icon: Bus, label: 'Buses' },
            { id: 'walkers', icon: PersonStanding, label: 'Walkers' },
            { id: 'afterschool', icon: Clock, label: 'After' },
          ].map(view => (
            <button key={view.id} onClick={() => setSelectedView(view.id)}
              className={`w-12 h-12 rounded-lg flex flex-col items-center justify-center gap-1 transition-colors ${
                selectedView === view.id ? 'bg-indigo-100 dark:bg-indigo-950/50 text-indigo-600 dark:text-indigo-400' : 'text-gray-400 dark:text-slate-500 hover:bg-gray-100 dark:hover:bg-slate-800'
              }`}>
              <view.icon className="w-5 h-5" />
              <span className="text-[10px]">{view.label}</span>
            </button>
          ))}
          {canManageSetup && (
            <button onClick={() => navigate('/gopilot/setup')}
              className="w-12 h-12 rounded-lg flex flex-col items-center justify-center gap-1 text-gray-400 dark:text-slate-500 hover:bg-gray-100 dark:hover:bg-slate-800">
              <Settings className="w-5 h-5" />
              <span className="text-[10px]">Setup</span>
            </button>
          )}
        </aside>

        {/* Mobile bottom nav */}
        <nav className="sm:hidden fixed bottom-0 left-0 right-0 bg-white dark:bg-slate-900 border-t dark:border-slate-700 z-50 px-2 py-1" style={{ paddingBottom: 'max(4px, env(safe-area-inset-bottom))' }}>
          <div className="flex items-center justify-around">
            {[
              { id: 'queue', icon: Users, label: 'Queue' },
              { id: 'homerooms', icon: Home, label: 'Rooms' },
              { id: 'buses', icon: Bus, label: 'Buses' },
              { id: 'walkers', icon: PersonStanding, label: 'Walk' },
              { id: 'afterschool', icon: Clock, label: 'After' },
            ].map(view => (
              <button key={view.id} onClick={() => setSelectedView(view.id)}
                className={`flex flex-col items-center justify-center py-1.5 px-3 rounded-lg ${
                  selectedView === view.id ? 'text-indigo-600 dark:text-indigo-400' : 'text-gray-400 dark:text-slate-500'
                }`}>
                <view.icon className="w-5 h-5" />
                <span className="text-[10px]">{view.label}</span>
              </button>
            ))}
            {canManageSetup && (
              <button onClick={() => navigate('/gopilot/setup')}
                className="flex flex-col items-center justify-center py-1.5 px-3 rounded-lg text-gray-400 dark:text-slate-500">
                <Settings className="w-5 h-5" />
                <span className="text-[10px]">Setup</span>
              </button>
            )}
          </div>
        </nav>

        <main className="flex-1 p-3 sm:p-4 pb-20 sm:pb-4">
          {selectedView === 'queue' && (
            <div className="flex flex-col lg:grid lg:grid-cols-3 gap-3 sm:gap-4">
              {/* Car Number Input - shows first on mobile */}
              <div className="lg:hidden space-y-3">
                <Card className="p-3 sm:p-4">
                  <div className="flex items-center justify-between mb-2">
                    <h3 className="font-semibold flex items-center gap-2 text-sm">
                      <Car className="w-4 h-4 text-indigo-600" />
                      Enter Car #
                    </h3>
                    <Button variant="secondary" size="sm" onClick={() => setShowQrScanner(true)}>
                      <QrCode className="w-4 h-4 mr-1" /> Scan
                    </Button>
                  </div>
                  <form onSubmit={(e) => { e.preventDefault(); handleCarNumberCheckIn(); }} className="flex gap-2">
                    <input
                      type="text"
                      value={carNumberInput}
                      onChange={(e) => setCarNumberInput(e.target.value)}
                      placeholder="e.g. 142"
                      className="flex-1 px-3 py-2 border dark:border-slate-600 rounded-lg text-lg font-mono text-center tracking-widest bg-white dark:bg-slate-800 dark:text-white"
                    />
                    <Button variant="primary" size="md" onClick={handleCarNumberCheckIn} disabled={carNumberLoading || !carNumberInput.trim() || !isSessionActive}>
                      {carNumberLoading ? <RefreshCw className="w-4 h-4 animate-spin" /> : <ArrowRight className="w-4 h-4" />}
                    </Button>
                  </form>
                  {carNumberResult && (
                    <div className={`mt-2 p-2 rounded-lg text-sm ${carNumberResult.type === 'success' ? 'bg-green-50 dark:bg-green-950/40 text-green-700 dark:text-green-400' : carNumberResult.type === 'info' ? 'bg-yellow-50 dark:bg-yellow-950/40 text-yellow-700 dark:text-yellow-400' : 'bg-red-50 dark:bg-red-950/40 text-red-700 dark:text-red-400'}`}>
                      {carNumberResult.message}
                    </div>
                  )}
                </Card>
                <Card className="p-3 sm:p-4">
                  <h3 className="font-semibold mb-2 text-sm">Car# Look Up</h3>
                  <Button variant="secondary" size="sm" className="w-full justify-start" onClick={() => setShowStudentLookup(true)}>
                    <Search className="w-4 h-4 mr-2" /> Find Student
                  </Button>
                </Card>
                <Card className="p-3 sm:p-4">
                  <h3 className="font-semibold mb-2 text-sm dark:text-white">Pickup Zone</h3>
                  <div className={`grid gap-2 ${pickupZones.length <= 2 ? 'grid-cols-2' : 'grid-cols-3'}`}>
                    {pickupZones.map(zone => {
                      const count = queue.filter(q => q.zone === zone.id && q.status === 'called').length;
                      const isSelected = selectedZone === zone.id;
                      return (
                        <button key={zone.id} onClick={() => setSelectedZone(zone.id)}
                          className={`p-2 rounded-lg text-center transition-colors ${
                            isSelected ? 'ring-2 ring-indigo-500 bg-indigo-50 dark:bg-indigo-950/40' :
                            count > 0 ? 'bg-green-100 dark:bg-green-950/50' : 'bg-gray-100 dark:bg-slate-700 border border-transparent dark:border-slate-600'
                          }`}>
                          <p className="text-sm font-bold truncate dark:text-white">{zone.name}</p>
                          <p className="text-[10px] text-gray-500 dark:text-slate-400">{count} called</p>
                        </button>
                      );
                    })}
                  </div>
                </Card>
              </div>

              <div className="lg:col-span-2">
                <Card>
                  <div className="p-3 sm:p-4 border-b">
                    <div className="flex items-center justify-between mb-3">
                      <h2 className="font-semibold flex items-center gap-2 text-sm sm:text-base">
                        <Users className="w-5 h-5 text-indigo-600" />
                        Car Line
                      </h2>
                      {/* Queue / Dismissed tabs */}
                      <div className="flex bg-gray-100 dark:bg-slate-800 rounded-lg p-0.5">
                        <button
                          onClick={() => setQueueTab('active')}
                          className={`px-3 py-1 text-sm font-medium rounded-md transition-colors ${
                            queueTab === 'active' ? 'bg-white dark:bg-slate-700 shadow text-indigo-600 dark:text-indigo-400' : 'text-gray-600 dark:text-slate-400 hover:text-gray-900 dark:hover:text-white'
                          }`}
                        >
                          Queue {activeQueue.length > 0 && <span className="ml-1 text-xs bg-indigo-100 text-indigo-600 px-1.5 py-0.5 rounded-full">{activeQueue.length}</span>}
                        </button>
                        <button
                          onClick={() => setQueueTab('dismissed')}
                          className={`px-3 py-1 text-sm font-medium rounded-md transition-colors ${
                            queueTab === 'dismissed' ? 'bg-white dark:bg-slate-700 shadow text-green-600 dark:text-green-400' : 'text-gray-600 dark:text-slate-400 hover:text-gray-900 dark:hover:text-white'
                          }`}
                        >
                          Dismissed {dismissedQueue.length > 0 && <span className="ml-1 text-xs bg-green-100 dark:bg-green-950/50 text-green-600 px-1.5 py-0.5 rounded-full">{dismissedQueue.length}</span>}
                        </button>
                      </div>
                    </div>
                    <div className="flex items-center gap-2 flex-wrap">
                      <div className="relative flex-1 min-w-[140px]">
                        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
                        <input type="text" placeholder="Search..." value={searchTerm}
                          onChange={(e) => setSearchTerm(e.target.value)}
                          className="pl-10 pr-4 py-1.5 border dark:border-slate-600 rounded-lg text-sm w-full bg-white dark:bg-slate-800 dark:text-white" />
                      </div>
                      {queueTab === 'active' && (
                        <select value={filterType} onChange={(e) => setFilterType(e.target.value)}
                          className="border dark:border-slate-600 rounded-lg px-2 sm:px-3 py-1.5 text-sm bg-white dark:bg-slate-800 dark:text-white">
                          <option value="all">All</option>
                          <option value="waiting">Waiting</option>
                          <option value="called">Called</option>
                          <option value="released">In Transit</option>
                        </select>
                      )}
                    </div>
                  </div>
                  <div className="max-h-[calc(100vh-320px)] overflow-y-auto">
                    {(() => {
                      const groups = queueGroups(filteredQueue);
                      if (groups.length === 0) {
                        return (
                          <div className="p-8 text-center text-gray-500 dark:text-slate-400">
                            {queueTab === 'dismissed' ? (
                              <>
                                <CheckCircle2 className="w-12 h-12 mx-auto mb-2 text-gray-300 dark:text-slate-600" />
                                <p>No dismissed students yet</p>
                              </>
                            ) : (
                              <>
                                <Users className="w-12 h-12 mx-auto mb-2 text-gray-300 dark:text-slate-600" />
                                <p>No students in queue</p>
                              </>
                            )}
                          </div>
                        );
                      }
                      return groups.map(group => (
                        <QueueGroup key={group.key} name={group.name} students={group.students} pickupGroupId={group.pickupGroupId}
                          onPickupAll={() => handlePickupAll(group.students)}
                          onCall={handleCallStudent}
                          onPickup={handleMarkPickedUp}
                          pickupsByStudent={pickupsByStudent}
                          custodyAlertsByStudent={custodyAlertsByStudent}
                          actionsDisabled={!isSessionActive} />
                      ));
                    })()}
                  </div>
                </Card>
              </div>
              <div className="hidden lg:block space-y-4">
                <Card className="p-4">
                  <div className="flex items-center justify-between mb-3">
                    <h3 className="font-semibold flex items-center gap-2">
                      <Car className="w-5 h-5 text-indigo-600" />
                      Enter Car #
                    </h3>
                    <Button variant="secondary" size="sm" onClick={() => setShowQrScanner(true)}>
                      <QrCode className="w-4 h-4 mr-1" /> Scan QR
                    </Button>
                  </div>
                  <form onSubmit={(e) => { e.preventDefault(); handleCarNumberCheckIn(); }} className="flex gap-2">
                    <input
                      type="text"
                      value={carNumberInput}
                      onChange={(e) => setCarNumberInput(e.target.value)}
                      placeholder="e.g. 142"
                      className="flex-1 px-3 py-2 border dark:border-slate-600 rounded-lg text-lg font-mono text-center tracking-widest bg-white dark:bg-slate-800 dark:text-white"
                      autoFocus
                    />
                    <Button variant="primary" size="md" onClick={handleCarNumberCheckIn} disabled={carNumberLoading || !carNumberInput.trim() || !isSessionActive}>
                      {carNumberLoading ? <RefreshCw className="w-4 h-4 animate-spin" /> : <ArrowRight className="w-4 h-4" />}
                    </Button>
                  </form>
                  {carNumberResult && (
                    <div className={`mt-2 p-2 rounded-lg text-sm ${carNumberResult.type === 'success' ? 'bg-green-50 dark:bg-green-950/40 text-green-700 dark:text-green-400' : carNumberResult.type === 'info' ? 'bg-yellow-50 dark:bg-yellow-950/40 text-yellow-700 dark:text-yellow-400' : 'bg-red-50 dark:bg-red-950/40 text-red-700 dark:text-red-400'}`}>
                      {carNumberResult.message}
                    </div>
                  )}
                </Card>
                <Card className="p-4">
                  <div className="flex items-center justify-between mb-3">
                    <h3 className="font-semibold dark:text-white">Pickup Zones</h3>
                    {canManageSetup && (
                      <Button variant="ghost" size="sm" onClick={() => setShowZoneManager(true)}>
                        <Settings className="w-4 h-4" />
                      </Button>
                    )}
                  </div>
                  <div className={`grid gap-2 ${pickupZones.length <= 2 ? 'grid-cols-2' : pickupZones.length === 3 ? 'grid-cols-3' : 'grid-cols-2'}`}>
                    {pickupZones.map(zone => {
                      const count = queue.filter(q => q.zone === zone.id && q.status === 'called').length;
                      const isSelected = selectedZone === zone.id;
                      return (
                        <button key={zone.id} onClick={() => setSelectedZone(zone.id)}
                          className={`p-3 rounded-lg text-center transition-colors ${
                            isSelected ? 'ring-2 ring-indigo-500 bg-indigo-50 dark:bg-indigo-950/40' :
                            count > 0 ? 'bg-green-100 dark:bg-green-950/50' : 'bg-gray-100 dark:bg-slate-700 border border-transparent dark:border-slate-600'
                          }`}>
                          <p className="text-lg font-bold truncate dark:text-white">{zone.name}</p>
                          <p className="text-xs text-gray-500 dark:text-slate-400">{count} called</p>
                        </button>
                      );
                    })}
                  </div>
                  {pickupZones.length === 0 && (
                    <p className="text-sm text-gray-400 dark:text-slate-500 text-center py-2">No zones configured</p>
                  )}
                </Card>
                <Card className="p-4">
                  <h3 className="font-semibold mb-3">Car# Look Up</h3>
                  <div className="space-y-2">
                    <Button variant="secondary" size="sm" className="w-full justify-start" onClick={() => setShowStudentLookup(true)}>
                      <Search className="w-4 h-4 mr-2" /> Find Student
                    </Button>
                  </div>
                </Card>
              </div>
            </div>
          )}

          {selectedView === 'homerooms' && (
            <Card>
              <div className="p-4 border-b flex items-center justify-between">
                <h2 className="font-semibold flex items-center gap-2">
                  <Home className="w-5 h-5 text-indigo-600" /> Homeroom Status
                </h2>
              </div>
              <div className="divide-y dark:divide-slate-700">
                {homerooms.map(room => {
                  const isExpanded = expandedHomeroom === room.id;
                  return (
                    <div key={room.id}>
                      <div
                        onClick={() => toggleHomeroom(room.id)}
                        className="p-4 flex items-center justify-between hover:bg-gray-50 dark:hover:bg-slate-800 cursor-pointer select-none"
                      >
                        <div className="flex items-center gap-4">
                          {isExpanded ? <ChevronDown className="w-5 h-5 text-gray-400" /> : <ChevronRight className="w-5 h-5 text-gray-400" />}
                          <div className="w-12 h-12 bg-indigo-100 dark:bg-indigo-950/50 rounded-lg flex items-center justify-center">
                            <span className="text-indigo-600 dark:text-indigo-400 font-bold">{room.grade}</span>
                          </div>
                          <div>
                            <p className="font-medium dark:text-white">{room.teacher_first_name} {room.teacher_last_name}</p>
                            <p className="text-sm text-gray-500 dark:text-slate-400">Grade {room.grade} - {room.name}</p>
                          </div>
                        </div>
                        <div className="text-center">
                          <p className="text-lg font-bold text-indigo-600">{room.student_count}</p>
                          <p className="text-xs text-gray-500 dark:text-slate-400">Students</p>
                        </div>
                      </div>
                      {isExpanded && (
                        <div className="bg-gray-50 dark:bg-slate-800/50 border-t dark:border-slate-700 px-4 py-2">
                          {loadingStudents ? (
                            <div className="flex items-center justify-center py-6">
                              <RefreshCw className="w-5 h-5 animate-spin text-indigo-500" />
                              <span className="ml-2 text-sm text-gray-500 dark:text-slate-400">Loading students...</span>
                            </div>
                          ) : homeroomStudents.length === 0 ? (
                            <p className="text-sm text-gray-500 dark:text-slate-400 py-4 text-center">No students found</p>
                          ) : (
                            <div className="divide-y dark:divide-slate-700">
                              {homeroomStudents.map(student => {
                                const override = overrides[student.id];
                                const effectiveType = override ? override.overrideType : (student.effectiveDismissalType || student.dismissalType || student.dismissal_type);
                                const effectiveBusRoute = override?.busRoute || student.effectiveBusRoute || student.busRoute || student.bus_route || '';
                                const isOverridden = !!override;
                                const typeColors = { car: 'blue', bus: 'yellow', walker: 'green', afterschool: 'purple' };
                                const typeLabels = { car: 'Car', bus: 'Bus', walker: 'Walker', afterschool: 'After School' };
                                const TypeIcon = { car: Car, bus: Bus, walker: PersonStanding, afterschool: Clock }[effectiveType] || Car;
                                const fname = student.firstName || student.first_name || '';
                                const lname = student.lastName || student.last_name || '';
                                return (
                                  <div key={student.id} className="py-2.5">
                                    <div className="flex items-center justify-between">
                                      <div className="flex items-center gap-3">
                                        <div className="w-8 h-8 bg-indigo-100 dark:bg-indigo-950/50 rounded-full flex items-center justify-center">
                                          <span className="text-xs font-bold text-indigo-600 dark:text-indigo-400">
                                            {fname[0]}{lname[0]}
                                          </span>
                                        </div>
                                        <span className="text-sm font-medium dark:text-white">{fname} {lname}</span>
                                        {changeRequests.find(cr => cr.studentId === student.id && cr.note) && (
                                          <button onClick={(e) => {
                                            e.stopPropagation();
                                            setShowNoteFor(showNoteFor === student.id ? null : student.id);
                                          }} className="flex-shrink-0">
                                            <MessageSquare className="w-3.5 h-3.5 text-amber-500" />
                                          </button>
                                        )}
                                      </div>
                                      <div className="flex items-center gap-2">
                                      {isOverridden && (
                                        <span className="text-xs text-orange-600 dark:text-orange-400 font-medium">Today</span>
                                      )}
                                      <button
                                        onClick={(e) => {
                                          e.stopPropagation();
                                          setShowOverrideFor(student.id);
                                          setOverrideType(effectiveType || '');
                                          setOverrideReason(override?.reason || '');
                                          setOverrideBusRoute(effectiveType === 'bus' ? effectiveBusRoute : '');
                                        }}
                                        disabled={!isSessionActive}
                                        className="flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium transition-colors hover:ring-2 hover:ring-indigo-300 dark:hover:ring-indigo-600"
                                        style={{ cursor: isSessionActive ? 'pointer' : 'not-allowed' }}
                                      >
                                        <Badge variant={typeColors[effectiveType] || 'default'} size="sm">
                                          <TypeIcon className="w-3 h-3" />
                                          {typeLabels[effectiveType] || effectiveType}
                                        </Badge>
                                      </button>
                                      </div>
                                    </div>
                                    {showNoteFor === student.id && (() => {
                                      const cr = changeRequests.find(c => c.studentId === student.id && c.note);
                                      return cr ? (
                                        <div className="text-xs bg-amber-50 dark:bg-amber-900/30 text-amber-800 dark:text-amber-200 rounded px-2 py-1 mt-1 ml-11">
                                          <span className="font-medium">Parent note:</span> {cr.note}
                                          <div className="text-amber-600 dark:text-amber-400 mt-0.5 capitalize">{cr.fromType} → {cr.toType}</div>
                                        </div>
                                      ) : null;
                                    })()}
                                  </div>
                                );
                              })}
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </Card>
          )}

          {selectedView === 'buses' && (() => {
            const allBusQueue = queue.filter(q => (q.checkInMethod ?? q.check_in_method) === 'bus_number');
            const activeBusCount = allBusQueue.filter(q => q.status !== 'dismissed').length;
            const dismissedBusCount = allBusQueue.filter(q => q.status === 'dismissed').length;

            // Filter by tab
            const busQueue = busQueueTab === 'active'
              ? allBusQueue.filter(q => q.status !== 'dismissed')
              : allBusQueue.filter(q => q.status === 'dismissed');

            const busGroups = queueGroups(busQueue);
            return (
              <div className="space-y-4">
                <Card className="p-4">
                  <div className="flex items-center justify-between mb-3">
                    <h3 className="font-semibold flex items-center gap-2">
                      <Bus className="w-5 h-5 text-yellow-600" />
                      Enter Bus #
                    </h3>
                    <div className="flex rounded-lg border border-gray-200 dark:border-slate-600 overflow-hidden">
                      <button
                        onClick={() => setBusQueueTab('active')}
                        className={`px-3 py-1 text-sm font-medium ${busQueueTab === 'active' ? 'bg-indigo-600 dark:bg-indigo-700 text-white' : 'bg-white text-gray-600 hover:bg-gray-50 dark:bg-slate-800/50 dark:hover:bg-slate-800'}`}
                      >
                        Queue <span className="ml-1 bg-white/20 px-1.5 rounded">{activeBusCount}</span>
                      </button>
                      <button
                        onClick={() => setBusQueueTab('dismissed')}
                        className={`px-3 py-1 text-sm font-medium ${busQueueTab === 'dismissed' ? 'bg-indigo-600 dark:bg-indigo-700 text-white' : 'bg-white text-gray-600 hover:bg-gray-50 dark:bg-slate-800/50 dark:hover:bg-slate-800'}`}
                      >
                        Dismissed <span className="ml-1 bg-white/20 px-1.5 rounded">{dismissedBusCount}</span>
                      </button>
                    </div>
                  </div>
                  <form onSubmit={(e) => { e.preventDefault(); handleBusNumberCheckIn(); }} className="flex gap-2">
                    <input
                      type="text"
                      value={busNumberInput}
                      onChange={(e) => setBusNumberInput(e.target.value)}
                      placeholder="e.g. 42"
                      className="flex-1 px-3 py-2 border dark:border-slate-600 rounded-lg text-lg font-mono text-center tracking-widest bg-white dark:bg-slate-800 dark:text-white"
                    />
                    <Button variant="primary" size="md" onClick={handleBusNumberCheckIn} disabled={busNumberLoading || !busNumberInput.trim() || !isSessionActive}>
                      {busNumberLoading ? <RefreshCw className="w-4 h-4 animate-spin" /> : <ArrowRight className="w-4 h-4" />}
                    </Button>
                  </form>
                  {busNumberResult && (
                    <div className={`mt-2 p-2 rounded-lg text-sm ${busNumberResult.type === 'success' ? 'bg-green-50 dark:bg-green-950/40 text-green-700 dark:text-green-400' : busNumberResult.type === 'info' ? 'bg-yellow-50 dark:bg-yellow-950/40 text-yellow-700 dark:text-yellow-400' : 'bg-red-50 dark:bg-red-950/40 text-red-700 dark:text-red-400'}`}>
                      {busNumberResult.message}
                    </div>
                  )}
                </Card>

                {busGroups.length > 0 ? (
                  busGroups.map(group => (
                    <QueueGroup key={group.key} name={group.name} students={group.students} pickupGroupId={group.pickupGroupId}
                      onPickupAll={() => handlePickupAll(group.students)}
                      onCall={handleCallStudent}
                      onPickup={handleMarkPickedUp}
                      pickupsByStudent={pickupsByStudent}
                      custodyAlertsByStudent={custodyAlertsByStudent}
                      actionsDisabled={!isSessionActive} />
                  ))
                ) : (
                  <Card>
                    <div className="p-8 text-center text-gray-500 dark:text-slate-400">
                      <Bus className="w-12 h-12 mx-auto mb-2 text-gray-300 dark:text-slate-600" />
                      <p>{busQueueTab === 'active' ? 'Enter a bus number above to check in bus students' : 'No dismissed bus students yet'}</p>
                    </div>
                  </Card>
                )}
              </div>
            );
          })()}

          {selectedView === 'walkers' && (() => {
            const allWalkerQueue = queue.filter(q => (q.checkInMethod ?? q.check_in_method) === 'walker');
            const activeWalkerCount = allWalkerQueue.filter(q => q.status !== 'dismissed').length;
            const dismissedWalkerCount = allWalkerQueue.filter(q => q.status === 'dismissed').length;
            const walkerQueue = walkerQueueTab === 'active'
              ? allWalkerQueue.filter(q => q.status !== 'dismissed')
              : allWalkerQueue.filter(q => q.status === 'dismissed');

            // Get unique grades and homerooms from the homerooms list
            const uniqueGrades = [...new Set(homerooms.map(h => h.grade))].sort((a, b) => {
              const aNum = parseInt(a) || 0;
              const bNum = parseInt(b) || 0;
              if (a === 'K' || a === 'PK') return -1;
              if (b === 'K' || b === 'PK') return 1;
              return aNum - bNum;
            });

            return (
              <div className="space-y-3 sm:space-y-4">
                <Card className="p-3 sm:p-4">
                  <div className="flex items-center justify-between mb-2 sm:mb-3">
                    <h2 className="font-semibold flex items-center gap-2 text-sm sm:text-base">
                      <PersonStanding className="w-4 h-4 sm:w-5 sm:h-5 text-green-600" /> Walker Dismissal
                    </h2>
                    <div className="flex items-center gap-2">
                      <div className="flex rounded-lg border border-gray-200 dark:border-slate-600 overflow-hidden">
                        <button
                          onClick={() => setWalkerQueueTab('active')}
                          className={`px-2 sm:px-3 py-1 text-xs sm:text-sm font-medium ${walkerQueueTab === 'active' ? 'bg-indigo-600 dark:bg-indigo-700 text-white' : 'bg-white text-gray-600 hover:bg-gray-50 dark:bg-slate-800/50 dark:hover:bg-slate-800'}`}
                        >
                          Queue <span className="ml-1 bg-white/20 px-1.5 rounded">{activeWalkerCount}</span>
                        </button>
                        <button
                          onClick={() => setWalkerQueueTab('dismissed')}
                          className={`px-2 sm:px-3 py-1 text-xs sm:text-sm font-medium ${walkerQueueTab === 'dismissed' ? 'bg-indigo-600 dark:bg-indigo-700 text-white' : 'bg-white text-gray-600 hover:bg-gray-50 dark:bg-slate-800/50 dark:hover:bg-slate-800'}`}
                        >
                          Done <span className="ml-1 bg-white/20 px-1.5 rounded">{dismissedWalkerCount}</span>
                        </button>
                      </div>
                    </div>
                  </div>
                  {walkerResult && (
                    <div className={`mb-2 p-2 rounded-lg text-sm ${walkerResult.type === 'success' ? 'bg-green-50 dark:bg-green-950/40 text-green-700 dark:text-green-400' : walkerResult.type === 'info' ? 'bg-yellow-50 dark:bg-yellow-950/40 text-yellow-700 dark:text-yellow-400' : 'bg-red-50 dark:bg-red-950/40 text-red-700 dark:text-red-400'}`}>
                      {walkerResult.message}
                    </div>
                  )}

                  {/* Release Options */}
                  <div className="border-t pt-2 sm:pt-3 mt-2 sm:mt-3">
                    <div className="flex flex-wrap items-center gap-2 mb-2 sm:mb-3">
                      <div className="flex items-center gap-2">
                        <span className="text-xs sm:text-sm font-medium text-gray-700 dark:text-slate-300">Release by:</span>
                        <div className="flex rounded-lg border border-gray-200 dark:border-slate-600 overflow-hidden">
                          <button
                            onClick={() => setWalkerViewTab('grade')}
                            className={`px-2 sm:px-3 py-1 text-xs sm:text-sm font-medium ${walkerViewTab === 'grade' ? 'bg-green-600 dark:bg-green-700 text-white' : 'bg-white text-gray-600 hover:bg-gray-50 dark:bg-slate-800/50 dark:hover:bg-slate-800'}`}
                          >
                            Grade
                          </button>
                          <button
                            onClick={() => setWalkerViewTab('homeroom')}
                            className={`px-2 sm:px-3 py-1 text-xs sm:text-sm font-medium ${walkerViewTab === 'homeroom' ? 'bg-green-600 dark:bg-green-700 text-white' : 'bg-white text-gray-600 hover:bg-gray-50 dark:bg-slate-800/50 dark:hover:bg-slate-800'}`}
                          >
                            Homeroom
                          </button>
                        </div>
                      </div>
                      <div className="flex gap-2 ml-auto">
                        <Button
                          variant="success"
                          size="sm"
                          onClick={handleReleaseSelectedWalkers}
                          disabled={walkerLoading || !isSessionActive || (walkerViewTab === 'grade' ? selectedGrades.length === 0 : selectedWalkerHomerooms.length === 0)}
                        >
                          {walkerLoading ? <RefreshCw className="w-4 h-4 animate-spin mr-1" /> : <PersonStanding className="w-4 h-4 mr-1" />}
                          <span className="hidden sm:inline">Dismiss Selected {walkerViewTab === 'grade' ? `(${selectedGrades.length} grades)` : `(${selectedWalkerHomerooms.length} homerooms)`}</span>
                          <span className="sm:hidden">Dismiss ({walkerViewTab === 'grade' ? selectedGrades.length : selectedWalkerHomerooms.length})</span>
                        </Button>
                        <Button variant="danger" size="sm" onClick={handleReleaseWalkers} disabled={walkerLoading || !isSessionActive}>
                          {walkerLoading ? <RefreshCw className="w-4 h-4 animate-spin mr-1" /> : <PersonStanding className="w-4 h-4 mr-1" />}
                          <span className="hidden sm:inline">Dismiss All Walkers</span>
                          <span className="sm:hidden">All</span>
                        </Button>
                      </div>
                    </div>

                    {/* Scrollable selection list */}
                    <div className="max-h-40 sm:max-h-64 overflow-y-auto border dark:border-slate-700 rounded-lg bg-gray-50 dark:bg-slate-800/50 p-2">
                      {walkerViewTab === 'grade' && (
                        <div className="space-y-1">
                          {uniqueGrades.length === 0 ? (
                            <p className="text-sm text-gray-500 dark:text-slate-400  p-2">No grades found</p>
                          ) : uniqueGrades.map(grade => (
                            <label key={grade} className={`flex items-center gap-3 px-3 py-2 rounded-lg cursor-pointer transition-colors ${selectedGrades.includes(grade) ? 'bg-green-100 dark:bg-green-950/50 border border-green-500' : 'bg-white dark:bg-slate-800 border border-gray-200 dark:border-slate-700 hover:bg-gray-100 dark:hover:bg-slate-700'}`}>
                              <input
                                type="checkbox"
                                checked={selectedGrades.includes(grade)}
                                onChange={() => toggleGradeSelection(grade)}
                                className="w-4 h-4 text-green-600 rounded"
                              />
                              <span className="font-medium flex-1">Grade {grade}</span>
                              {selectedGrades.includes(grade) && <Check className="w-4 h-4 text-green-600" />}
                            </label>
                          ))}
                        </div>
                      )}

                      {walkerViewTab === 'homeroom' && (
                        <div className="space-y-1">
                          {homerooms.length === 0 ? (
                            <p className="text-sm text-gray-500 dark:text-slate-400  p-2">No homerooms found</p>
                          ) : homerooms.map(room => (
                            <label key={room.id} className={`flex items-center gap-3 px-3 py-2 rounded-lg cursor-pointer transition-colors ${selectedWalkerHomerooms.includes(room.id) ? 'bg-green-100 dark:bg-green-950/50 border border-green-500' : 'bg-white dark:bg-slate-800 border border-gray-200 dark:border-slate-700 hover:bg-gray-100 dark:hover:bg-slate-700'}`}>
                              <input
                                type="checkbox"
                                checked={selectedWalkerHomerooms.includes(room.id)}
                                onChange={() => toggleHomeroomSelection(room.id)}
                                className="w-4 h-4 text-green-600 rounded"
                              />
                              <span className="font-medium flex-1">{room.name}</span>
                              <span className="text-xs text-gray-500 dark:text-slate-400">Grade {room.grade}</span>
                              {selectedWalkerHomerooms.includes(room.id) && <Check className="w-4 h-4 text-green-600" />}
                            </label>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                </Card>

                {/* Dismissed Walkers List */}
                {walkerQueueTab === 'dismissed' && walkerQueue.length > 0 && (
                  <Card className="p-4">
                    <h3 className="font-medium text-gray-700 mb-3">Dismissed Walkers ({walkerQueue.length})</h3>
                    <div className="max-h-96 overflow-y-auto space-y-2">
                      {walkerQueue.map(student => (
                        <div key={student.id} className="flex items-center gap-3 p-2 bg-gray-50 dark:bg-slate-800/50 dark:bg-slate-800/50 rounded-lg">
                          <div className="w-8 h-8 bg-green-100 dark:bg-green-950/50 rounded-full flex items-center justify-center">
                            <Check className="w-4 h-4 text-green-600" />
                          </div>
                          <div className="flex-1">
                            <p className="font-medium text-sm">{student.firstName || student.first_name} {student.lastName || student.last_name}</p>
                            <p className="text-xs text-gray-500 dark:text-slate-400">{student.guardianName || student.guardian_name}</p>
                          </div>
                          <span className="text-xs text-gray-400 dark:text-slate-500">
                            {(student.dismissedAt || student.dismissed_at) && new Date(student.dismissedAt || student.dismissed_at).toLocaleTimeString([], { timeZone: currentSchool?.timezone, hour: '2-digit', minute: '2-digit' })}
                          </span>
                        </div>
                      ))}
                    </div>
                  </Card>
                )}

                {walkerQueueTab === 'dismissed' && walkerQueue.length === 0 && (
                  <Card>
                    <div className="p-8 text-center text-gray-500 dark:text-slate-400">
                      <PersonStanding className="w-12 h-12 mx-auto mb-2 text-gray-300 dark:text-slate-600" />
                      <p>No dismissed walker students yet</p>
                    </div>
                  </Card>
                )}
              </div>
            );
          })()}

          {/* After School View */}
          {selectedView === 'afterschool' && (
            <div className="p-4">
              <div className="flex items-center justify-between mb-4">
                <div className="flex items-center gap-2">
                  <Clock className="w-5 h-5 text-purple-600" />
                  <h2 className="font-bold text-lg dark:text-white">After School Activities</h2>
                </div>
                <Badge variant="purple">{effectiveAfterschoolList.length} students</Badge>
              </div>

              {effectiveAfterschoolList.length === 0 ? (
                <Card>
                  <div className="p-8 text-center text-gray-500 dark:text-slate-400">
                    <Clock className="w-12 h-12 mx-auto mb-2 text-gray-300 dark:text-slate-600" />
                    <p>No after-school activities for today</p>
                    <p className="text-sm mt-1">Students will appear here when parents, teachers, or office change their dismissal to "After School"</p>
                  </div>
                </Card>
              ) : (
                <div className="space-y-3">
                  {effectiveAfterschoolList.map(item => (
                      <Card key={item.studentId}>
                        <div className="p-4 flex items-center justify-between">
                          <div className="flex items-center gap-3">
                            <div className="w-10 h-10 bg-purple-100 dark:bg-purple-950/50 rounded-full flex items-center justify-center">
                              <Clock className="w-5 h-5 text-purple-600" />
                            </div>
                            <div>
                              <p className="font-medium dark:text-white">{item.studentName}</p>
                              <p className="text-sm text-purple-600">{item.reason}</p>
                            </div>
                          </div>
                          <button
                            onClick={() => { setShowOverrideFor(item.studentId); setOverrideType('car'); setOverrideReason(''); setOverrideBusRoute(''); }}
                            disabled={!isSessionActive}
                            className="text-sm text-indigo-600 hover:text-indigo-700 font-medium disabled:text-gray-400 disabled:cursor-not-allowed"
                          >
                            Change
                          </button>
                        </div>
                      </Card>
                    ))}
                </div>
              )}
            </div>
          )}

        </main>
      </div>

      {/* Dismissal Override Modal */}
      {showOverrideFor && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
          <div className="bg-white dark:bg-slate-900 rounded-xl shadow-xl w-full max-w-sm">
            <div className="p-4 border-b dark:border-slate-700 flex items-center justify-between">
              <h2 className="font-bold dark:text-white">Change Dismissal for Today</h2>
              <button onClick={resetOverrideModal} className="p-1"><X className="w-5 h-5 dark:text-slate-400" /></button>
            </div>
            <div className="p-4 space-y-4">
              <p className="text-xs text-gray-500 dark:text-slate-400">This change only applies to today.</p>
              <div className="grid grid-cols-2 gap-2">
                {[
                  { id: 'car', label: 'Car Rider', icon: Car },
                  { id: 'bus', label: 'Bus', icon: Bus },
                  { id: 'walker', label: 'Walker', icon: PersonStanding },
                  { id: 'afterschool', label: 'After School', icon: Clock },
                ].map(opt => (
                  <button
                    key={opt.id}
                    onClick={() => setOverrideType(opt.id)}
                    className={`p-3 rounded-lg border-2 flex flex-col items-center gap-1 text-sm ${
                      overrideType === opt.id ? 'border-indigo-600 bg-indigo-50 dark:bg-indigo-950/50 text-indigo-600' : 'border-gray-200 dark:border-slate-600 text-gray-500 dark:text-slate-400'
                    }`}
                  >
                    <opt.icon className="w-5 h-5" />
                    {opt.label}
                  </button>
                ))}
              </div>
              {overrideType === 'afterschool' ? (
                <input type="text" value={overrideReason} onChange={(e) => setOverrideReason(e.target.value)}
                  placeholder="Activity name (required)" className="w-full px-3 py-2 border dark:border-slate-600 rounded-lg text-sm dark:bg-slate-800 dark:text-white" />
              ) : (
                <input type="text" value={overrideReason} onChange={(e) => setOverrideReason(e.target.value)}
                  placeholder="Reason (optional)" className="w-full px-3 py-2 border dark:border-slate-600 rounded-lg text-sm dark:bg-slate-800 dark:text-white" />
              )}
              {overrideType === 'bus' && (
                <select
                  value={overrideBusRoute}
                  onChange={(e) => setOverrideBusRoute(e.target.value)}
                  className="w-full px-3 py-2 border dark:border-slate-600 rounded-lg text-sm dark:bg-slate-800 dark:text-white"
                >
                  <option value="">Select bus route</option>
                  {busRoutes.map(route => (
                    <option key={route.id || route.routeNumber} value={route.routeNumber}>{route.routeNumber}</option>
                  ))}
                </select>
              )}
              <div className="flex gap-2">
                <Button variant="secondary" className="flex-1" onClick={resetOverrideModal}>Cancel</Button>
                {overrides[showOverrideFor] && (
                  <Button variant="secondary" className="flex-1" onClick={handleOverrideRevert}>Revert</Button>
                )}
                <Button variant="primary" className="flex-1" onClick={handleOverrideSubmit}
                  disabled={(overrideType === 'afterschool' && !overrideReason.trim()) || (overrideType === 'bus' && !overrideBusRoute.trim()) || !isSessionActive}>
                  Save
                </Button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Custody Acknowledgement Modal */}
      {custodyPickup && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
          <div className="bg-white dark:bg-slate-900 rounded-xl shadow-xl w-full max-w-md">
            <div className="p-4 border-b dark:border-slate-700 flex items-center justify-between">
              <h2 className="font-bold text-red-700 dark:text-red-300 flex items-center gap-2">
                <Shield className="w-5 h-5" />
                Custody Alert
              </h2>
              <button onClick={() => setCustodyPickup(null)} className="p-1"><X className="w-5 h-5 dark:text-slate-400" /></button>
            </div>
            <div className="p-4 space-y-3">
              <p className="text-sm text-gray-700 dark:text-slate-200">
                Acknowledge the active custody alert before completing pickup for {custodyPickup.item?.firstName || custodyPickup.item?.first_name} {custodyPickup.item?.lastName || custodyPickup.item?.last_name}.
              </p>
              <div className="space-y-2">
                {custodyPickup.alerts.map(alert => (
                  <div key={alert.id} className="rounded-lg border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-950/30 p-3 text-sm">
                    <p className="font-semibold text-red-800 dark:text-red-200">{alert.personName || alert.person_name}</p>
                    <p className="text-red-700 dark:text-red-300 capitalize">{(alert.alertType || alert.alert_type || '').replace(/_/g, ' ')}</p>
                    {alert.notes && <p className="text-red-700 dark:text-red-300 mt-1">{alert.notes}</p>}
                  </div>
                ))}
              </div>
              <div className="flex gap-2 pt-2">
                <Button variant="secondary" className="flex-1" onClick={() => setCustodyPickup(null)}>Cancel</Button>
                <Button variant="danger" className="flex-1" onClick={() => handleMarkPickedUp(custodyPickup.item || custodyPickup.queueId, { custodyAcknowledged: true })}>
                  Acknowledge & Complete
                </Button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* End Dismissal Confirmation */}
      {showEndConfirm && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
          <div className="bg-white dark:bg-slate-800 rounded-2xl max-w-sm w-full p-6 shadow-xl">
            <div className="text-center mb-4">
              <div className="w-12 h-12 bg-red-100 dark:bg-red-950/30 rounded-full flex items-center justify-center mx-auto mb-3">
                <AlertTriangle className="w-6 h-6 text-red-600 dark:text-red-400" />
              </div>
              <h2 className="text-lg font-bold dark:text-white">End Today's Dismissal?</h2>
              <p className="text-sm text-gray-500 dark:text-slate-400 mt-2">This will complete today’s dismissal session after every queued student has been picked up. Queue history will remain available for review.</p>
            </div>
            <div className="flex gap-3">
              <Button variant="outline" className="flex-1" onClick={() => setShowEndConfirm(false)}>Cancel</Button>
              <Button variant="danger" className="flex-1" onClick={handleEndDismissal}>End Dismissal</Button>
            </div>
          </div>
        </div>
      )}

      {/* Zone Manager Modal */}
      {showZoneManager && (
        <ZoneManagerModal
          zones={pickupZones}
          onSave={handleSaveZones}
          onClose={() => setShowZoneManager(false)}
          saving={zoneSaving}
        />
      )}

      {/* QR Scanner Modal */}
      {showQrScanner && (
        <QrScannerModal
          onScan={handleQrScanned}
          onClose={() => setShowQrScanner(false)}
        />
      )}

      {/* Student Lookup Modal */}
      {showStudentLookup && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white dark:bg-slate-900 rounded-xl shadow-xl w-full max-w-md max-h-[80vh] flex flex-col">
            <div className="p-4 border-b flex items-center justify-between">
              <h2 className="text-lg font-semibold">Find Student</h2>
              <button onClick={() => { setShowStudentLookup(false); setStudentSearchTerm(''); setStudentSearchResults([]); }}
                className="p-1 hover:bg-gray-100 dark:hover:bg-slate-800 rounded-lg">
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="p-4 border-b">
              <div className="relative">
                <Search className="w-4 h-4 absolute left-3 top-3 text-gray-400" />
                <input
                  type="text"
                  value={studentSearchTerm}
                  onChange={(e) => handleStudentSearch(e.target.value)}
                  placeholder="Search by student name..."
                  className="w-full pl-9 pr-4 py-2 border dark:border-slate-600 rounded-lg bg-white dark:bg-slate-800 dark:text-white"
                  autoFocus
                />
              </div>
            </div>
            <div className="flex-1 overflow-y-auto p-2">
              {studentSearchLoading && (
                <div className="p-4 text-center text-gray-400 dark:text-slate-500">
                  <RefreshCw className="w-5 h-5 animate-spin mx-auto mb-2" />
                  Searching...
                </div>
              )}
              {!studentSearchLoading && studentSearchTerm && studentSearchResults.length === 0 && (
                <div className="p-4 text-center text-gray-400 dark:text-slate-500">No students found</div>
              )}
              {!studentSearchLoading && studentSearchResults.map(student => (
                <div key={student.id} className="p-3 hover:bg-gray-50 dark:bg-slate-800/50 dark:hover:bg-slate-800 rounded-lg flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 bg-indigo-100 dark:bg-indigo-950/60 rounded-full flex items-center justify-center text-indigo-600 dark:text-indigo-400 font-medium">
                      {student.firstName?.[0]}{student.lastName?.[0]}
                    </div>
                    <div>
                      <p className="font-medium dark:text-white">{student.firstName} {student.lastName}</p>
                      <p className="text-sm text-gray-500 dark:text-slate-400">
                        {student.homeroomName ? `${student.homeroomName} • Grade ${student.homeroomGrade || student.gradeLevel}` : `Grade ${student.gradeLevel || '—'}`}
                      </p>
                    </div>
                  </div>
                  {student.carNumber ? (
                    <button
                      onClick={() => handleUseCarNumber(student.carNumber)}
                      className="flex items-center gap-2 px-3 py-1.5 bg-indigo-600 dark:bg-indigo-700 text-white rounded-lg text-sm hover:bg-indigo-700"
                    >
                      <Car className="w-4 h-4" />
                      #{student.carNumber}
                    </button>
                  ) : (
                    <span className="text-sm text-gray-400 dark:text-slate-500 italic">No car #</span>
                  )}
                </div>
              ))}
              {!studentSearchTerm && (
                <div className="p-4 text-center text-gray-400 dark:text-slate-500 text-sm">
                  Start typing to search for a student by name
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function ZoneManagerModal({ zones, onSave, onClose, saving }) {
  const [editZones, setEditZones] = useState(zones.map(z => ({ ...z })));
  const [newZoneName, setNewZoneName] = useState('');

  const handleAdd = () => {
    if (!newZoneName.trim()) return;
    const id = newZoneName.trim().replace(/\s+/g, '_').substring(0, 50);
    if (editZones.find(z => z.id === id)) return;
    setEditZones([...editZones, { id, name: newZoneName.trim() }]);
    setNewZoneName('');
  };

  const handleRemove = (id) => {
    setEditZones(editZones.filter(z => z.id !== id));
  };

  const handleRename = (id, newName) => {
    setEditZones(editZones.map(z => z.id === id ? { ...z, name: newName } : z));
  };

  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center">
      <div className="bg-white dark:bg-slate-900 rounded-xl shadow-xl w-full max-w-md">
        <div className="p-4 border-b flex items-center justify-between">
          <h2 className="font-semibold text-lg">Manage Pickup Zones</h2>
          <button onClick={onClose} className="p-1 hover:bg-gray-100 dark:hover:bg-slate-800 rounded-full">
            <X className="w-5 h-5" />
          </button>
        </div>
        <div className="p-4 space-y-3">
          <p className="text-sm text-gray-500 dark:text-slate-400">
            Add, rename, or remove pickup zones. Students will be released to these zones during dismissal.
          </p>
          <div className="space-y-2">
            {editZones.map((zone) => (
              <div key={zone.id} className="flex items-center gap-2">
                <MapPin className="w-4 h-4 text-gray-400 flex-shrink-0" />
                <input
                  type="text"
                  value={zone.name}
                  onChange={(e) => handleRename(zone.id, e.target.value)}
                  className="flex-1 p-2 border dark:border-slate-600 rounded-lg text-sm bg-white dark:bg-slate-800 dark:text-white"
                />
                <button onClick={() => handleRemove(zone.id)}
                  className="p-1.5 hover:bg-red-50 dark:hover:bg-red-950/40 rounded text-red-500">
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
            ))}
          </div>
          <div className="flex items-center gap-2">
            <input
              type="text"
              placeholder="New zone name (e.g. Side Entrance)"
              value={newZoneName}
              onChange={(e) => setNewZoneName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleAdd()}
              className="flex-1 p-2 border dark:border-slate-600 rounded-lg text-sm bg-white dark:bg-slate-800 dark:text-white"
            />
            <button onClick={handleAdd}
              className="p-2 bg-indigo-100 dark:bg-indigo-950/50 text-indigo-600 dark:text-indigo-400 rounded-lg hover:bg-indigo-200 dark:hover:bg-indigo-900/50">
              <Plus className="w-4 h-4" />
            </button>
          </div>
        </div>
        <div className="p-4 border-t flex gap-3">
          <button onClick={onClose}
            className="flex-1 px-4 py-2 border dark:border-slate-600 rounded-lg text-sm font-medium dark:text-slate-300 hover:bg-gray-50 dark:bg-slate-800/50 dark:hover:bg-slate-800">
            Cancel
          </button>
          <button onClick={() => onSave(editZones)} disabled={saving}
            className="flex-1 px-4 py-2 bg-indigo-600 dark:bg-indigo-700 text-white rounded-lg text-sm font-medium hover:bg-indigo-700 disabled:bg-indigo-300">
            {saving ? 'Saving...' : 'Save Zones'}
          </button>
        </div>
      </div>
    </div>
  );
}

function QrScannerModal({ onScan, onClose }) {
  const scannerRef = useRef(null);
  const html5QrCodeRef = useRef(null);

  useEffect(() => {
    let scanner = null;
    let mounted = true;

    const startScanner = async () => {
      try {
        const { Html5Qrcode } = await import('html5-qrcode');
        if (!mounted) return;
        scanner = new Html5Qrcode('qr-reader');
        html5QrCodeRef.current = scanner;
        await scanner.start(
          { facingMode: 'environment' },
          { fps: 10, qrbox: { width: 250, height: 250 } },
          (decodedText) => {
            scanner.stop().catch(() => {});
            onScan(decodedText);
          },
          () => {} // ignore errors (no QR in frame)
        );
      } catch (err) {
        console.error('QR scanner error:', err);
      }
    };

    startScanner();

    return () => {
      mounted = false;
      if (html5QrCodeRef.current) {
        html5QrCodeRef.current.stop().catch(() => {});
      }
    };
  }, [onScan]);

  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-white dark:bg-slate-900 rounded-xl shadow-xl w-full max-w-sm" onClick={e => e.stopPropagation()}>
        <div className="p-4 border-b flex items-center justify-between">
          <h2 className="font-semibold text-lg flex items-center gap-2">
            <QrCode className="w-5 h-5 text-indigo-600" />
            Scan Parent QR
          </h2>
          <button onClick={onClose} className="p-1 hover:bg-gray-100 dark:hover:bg-slate-800 rounded-full">
            <X className="w-5 h-5" />
          </button>
        </div>
        <div className="p-4">
          <div id="qr-reader" ref={scannerRef} className="w-full rounded-lg overflow-hidden" />
          <p className="text-sm text-gray-500 dark:text-slate-400 text-center mt-3">
            Point camera at parent's QR code
          </p>
        </div>
      </div>
    </div>
  );
}

function QueueGroup({ name, students, pickupGroupId, onPickupAll, onCall, onPickup, pickupsByStudent, custodyAlertsByStudent, actionsDisabled }) {
  const eligible = students.filter(s => {
    const studentId = s.studentId || s.student_id;
    return s.status === 'released' && !(custodyAlertsByStudent?.[studentId]?.length);
  });
  const hasStableBatch = !!pickupGroupId;

  if (students.length === 1) {
    return (
      <div className="border-b border-gray-100 dark:border-slate-800">
        <QueueItem item={students[0]} position={students[0].position || 1} onCall={onCall} onPickup={onPickup} authorizedPickups={pickupsByStudent?.[students[0].studentId || students[0].student_id] || []} custodyAlerts={custodyAlertsByStudent?.[students[0].studentId || students[0].student_id] || []} actionsDisabled={actionsDisabled} />
      </div>
    );
  }

  return (
    <div className="border-b border-gray-200 dark:border-slate-700">
      <div className="flex items-center justify-between px-3 sm:px-4 py-2 bg-gray-50 dark:bg-slate-800/50">
        <div className="flex items-center gap-2">
          <span className="font-semibold text-sm sm:text-base text-gray-800 dark:text-slate-200">{name}</span>
          <span className="text-xs bg-gray-200 dark:bg-slate-700 text-gray-600 dark:text-slate-300 rounded-full px-2 py-0.5">{students.length} students</span>
        </div>
        {hasStableBatch && eligible.length > 0 && (
          <button
            onClick={onPickupAll}
            className="text-xs sm:text-sm px-3 py-1 bg-green-600 dark:bg-green-700 text-white rounded-lg hover:bg-green-700 transition-colors"
          >
            Pickup Complete All ({eligible.length})
          </button>
        )}
      </div>
      <div className="divide-y divide-gray-100 dark:divide-slate-800">
        {students.map((item, idx) => (
          <QueueItem key={item.id} item={item} position={item.position || idx + 1} onCall={onCall} onPickup={onPickup} authorizedPickups={pickupsByStudent?.[item.studentId || item.student_id] || []} custodyAlerts={custodyAlertsByStudent?.[item.studentId || item.student_id] || []} actionsDisabled={actionsDisabled} />
        ))}
      </div>
    </div>
  );
}

function QueueItem({ item, position, onCall, onPickup, authorizedPickups, custodyAlerts, actionsDisabled }) {
  const getStatusColor = (status) => {
    switch (status) {
      case 'waiting': return 'yellow';
      case 'called': return 'red';
      case 'released': return 'green';

      case 'delayed': return 'red';
      default: return 'default';
    }
  };

  const getCheckInIcon = (method) => {
    switch (method) {
      case 'sms': return MessageSquare;
      case 'qr': return QrCode;
      case 'car_number': return Car;
      default: return Smartphone;
    }
  };

  const CheckInIcon = getCheckInIcon(item.checkInMethod || item.check_in_method);
  // Calculate wait time: from check-in to dismissal (or now if not yet dismissed)
  const getWaitTime = () => {
    if (!item.check_in_time) return 0;
    const start = new Date(item.check_in_time).getTime();
    const end = item.status === 'dismissed' && item.dismissed_at
      ? new Date(item.dismissed_at).getTime()
      // eslint-disable-next-line react-hooks/purity
      : Date.now();
    return Math.floor((end - start) / 60000);
  };
  const waitTime = getWaitTime();

  return (
    <div className={`p-3 sm:p-4 ${item.status === 'called' ? 'bg-red-50 dark:bg-red-950/30' : item.status === 'waiting' ? 'bg-yellow-50 dark:bg-yellow-950/30' : item.status === 'released' ? 'bg-green-50 dark:bg-green-950/30' : 'hover:bg-gray-50 dark:hover:bg-slate-800'}`}>
      <div className="flex items-start sm:items-center gap-3 sm:gap-4">
        <div className="w-7 h-7 sm:w-8 sm:h-8 rounded-full bg-gray-100 dark:bg-slate-800 flex items-center justify-center text-xs sm:text-sm font-medium text-gray-500 dark:text-slate-400 flex-shrink-0">
          {position}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <p className="font-medium text-sm sm:text-base truncate">{item.firstName || item.first_name} {item.lastName || item.last_name}</p>
            <Badge variant={getStatusColor(item.status)} size="sm">
              {item.status === 'released' ? 'In Transit' : item.status === 'waiting' ? 'Waiting' : item.status === 'called' ? 'Called' : item.status}
            </Badge>
            {(item.isOverridden || item.is_overridden) && (
              <Badge variant="orange" size="sm">Override</Badge>
            )}
          </div>
          <div className="flex items-center gap-2 sm:gap-3 text-xs sm:text-sm text-gray-500 dark:text-slate-400 flex-wrap">
            <span>Gr {item.grade}</span>
            <span className="hidden sm:inline">•</span>
            <span className="hidden sm:inline">{item.homeroom_name || 'No homeroom'}</span>
            <span>•</span>
            <span className="truncate">{item.guardianName || item.guardian_name}</span>
            {custodyAlerts?.length > 0 && (
              <>
                <span>•</span>
                <span className="flex items-center gap-1 text-red-600 dark:text-red-400 font-medium">
                  <Shield className="w-3 h-3" />
                  Custody
                </span>
              </>
            )}
            {item.zone && (
              <>
                <span>•</span>
                <span className="flex items-center gap-1">
                  <MapPin className="w-3 h-3" />
                  {item.zone}
                </span>
              </>
            )}
            <span className="flex items-center gap-1 ml-auto sm:ml-0">
              <Timer className="w-3 h-3" />
              {waitTime}m
            </span>
          </div>
          {authorizedPickups && authorizedPickups.length > 0 && (
            <div className="flex items-center gap-1 mt-1 flex-wrap">
              <span className="text-xs text-indigo-600 dark:text-indigo-400 font-medium">Authorized:</span>
              {authorizedPickups
                .filter((p, i, arr) => arr.findIndex(x => x.name === p.name) === i)
                .map((p, idx) => (
                <span key={idx} className="text-xs bg-indigo-50 dark:bg-indigo-950/30 text-indigo-700 dark:text-indigo-300 px-1.5 py-0.5 rounded">
                  {p.name} ({p.relationship})
                </span>
              ))}
            </div>
          )}
        </div>
        <div className="flex items-center gap-1 sm:gap-2 flex-shrink-0">
          {item.status === 'waiting' && (
            <Button variant="primary" size="sm" onClick={() => onCall(item.id)} disabled={actionsDisabled}>
              <Send className="w-4 h-4" /><span className="hidden sm:inline ml-1">Call</span>
            </Button>
          )}
          {item.status === 'called' && (
            <Button variant="secondary" size="sm" onClick={() => onCall(item.id)} disabled={actionsDisabled}>
              <Send className="w-4 h-4" /><span className="hidden sm:inline ml-1">Re-call</span>
            </Button>
          )}
          {item.status === 'released' && (
            <Button variant="success" size="sm" onClick={() => onPickup(item)} disabled={actionsDisabled}>
              <Check className="w-4 h-4" /><span className="hidden sm:inline ml-1">Pickup Complete</span>
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
