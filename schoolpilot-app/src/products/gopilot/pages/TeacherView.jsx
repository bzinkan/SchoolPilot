import React, { useState, useEffect } from 'react';
import {
  Car, Bus, PersonStanding, Clock, Users, Bell, Check, X,
  ChevronRight, ChevronDown, AlertTriangle, CheckCircle2, Timer,
  LogOut, Home, RefreshCw, User,
  AlertCircle, Send, Coffee, Hand, MapPin, Smartphone, Filter,
  Loader2, ArrowRight, Megaphone
} from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useGoPilotAuth } from '../../../hooks/useGoPilotAuth';
import { useLicenses } from '../../../contexts/LicenseContext';
import { useNative } from '../../../contexts/NativeContext';
import { useSocket } from '../../../contexts/SocketContext';
import api from '../../../shared/utils/api';
import { useAbsentStudents } from '../../../hooks/useAbsentStudents';
import { Badge, Button, Card } from '../components/ui';

const sessionStatusMeta = {
  not_started: { label: 'Not Started', className: 'bg-gray-100 text-gray-600', dot: 'bg-gray-400' },
  pending: { label: 'Not Started', className: 'bg-gray-100 text-gray-600', dot: 'bg-gray-400' },
  active: { label: 'Active', className: 'bg-green-100 text-green-700', dot: 'bg-green-500' },
  paused: { label: 'Paused', className: 'bg-yellow-100 text-yellow-700', dot: 'bg-yellow-500' },
  completed: { label: 'Completed', className: 'bg-blue-100 text-blue-700', dot: 'bg-blue-500' },
  stale: { label: 'Offline/Stale', className: 'bg-red-100 text-red-700', dot: 'bg-red-500' },
};

const getStudentPermanentType = (student) =>
  student.permanentDismissalType ||
  student.permanent_dismissal_type ||
  student.dismissalType ||
  student.dismissal_type ||
  'car';

const getStudentPermanentBusRoute = (student) =>
  student.permanentBusRoute ||
  student.permanent_bus_route ||
  student.busRoute ||
  student.bus_route ||
  '';

const getQueueEffectiveType = (queueItem, student) =>
  queueItem?.dismissal_type ||
  queueItem?.dismissalType ||
  getStudentPermanentType(student);

const getQueueEffectiveBusRoute = (queueItem, student) =>
  queueItem?.bus_route ||
  queueItem?.busRoute ||
  getStudentPermanentBusRoute(student);

const normalizeOverride = (override) => override
  ? {
      overrideType: override.overrideType,
      reason: override.reason || '',
      busRoute: override.busRoute || '',
    }
  : null;

const applyOverrideToStudent = (student, override) => {
  const permanentDismissalType = getStudentPermanentType(student);
  const permanentBusRoute = getStudentPermanentBusRoute(student);
  if (!override?.overrideType) {
    return {
      ...student,
      permanentDismissalType,
      permanentBusRoute,
      dismissalType: permanentDismissalType,
      dismissal_type: permanentDismissalType,
      busRoute: permanentBusRoute,
      bus_route: permanentBusRoute,
      effectiveDismissalType: permanentDismissalType,
      effectiveBusRoute: permanentBusRoute,
      isOverridden: false,
      overrideReason: '',
    };
  }

  const effectiveBusRoute = override.overrideType === 'bus'
    ? (override.busRoute || permanentBusRoute || '')
    : permanentBusRoute;
  return {
    ...student,
    permanentDismissalType,
    permanentBusRoute,
    dismissalType: permanentDismissalType,
    dismissal_type: permanentDismissalType,
    busRoute: permanentBusRoute,
    bus_route: permanentBusRoute,
    effectiveDismissalType: override.overrideType,
    effectiveBusRoute,
    isOverridden: true,
    overrideReason: override.reason || '',
  };
};

const mergeQueueState = (student, queueItem, override) => {
  const permanentDismissalType = getStudentPermanentType({
    ...student,
    permanentDismissalType: queueItem?.permanent_dismissal_type || queueItem?.permanentDismissalType || student.permanentDismissalType,
  });
  const permanentBusRoute = getStudentPermanentBusRoute(student);
  const queueEffectiveType = getQueueEffectiveType(queueItem, { ...student, permanentDismissalType });
  const queueEffectiveBusRoute = getQueueEffectiveBusRoute(queueItem, { ...student, permanentBusRoute });
  const merged = {
    ...student,
    permanentDismissalType,
    permanentBusRoute,
    dismissalType: permanentDismissalType,
    dismissal_type: permanentDismissalType,
    busRoute: permanentBusRoute,
    bus_route: permanentBusRoute,
    effectiveDismissalType: queueEffectiveType,
    effectiveBusRoute: queueEffectiveBusRoute,
    isOverridden: !!(queueItem?.is_overridden || queueItem?.isOverridden),
    overrideReason: student.overrideReason || '',
    queueId: queueItem?.id || null,
    queueStatus: queueItem?.status || null,
    calledAt: queueItem?.called_at || queueItem?.calledAt ? new Date(queueItem.called_at || queueItem.calledAt) : null,
    dismissedAt: queueItem?.dismissed_at || queueItem?.dismissedAt ? new Date(queueItem.dismissed_at || queueItem.dismissedAt) : null,
    releasedAt: queueItem?.released_at || queueItem?.releasedAt ? new Date(queueItem.released_at || queueItem.releasedAt) : null,
    zone: queueItem?.zone || null,
    pickupGroupLabel: queueItem ? (queueItem.pickupGroupLabel || queueItem.pickup_group_label || null) : null,
    checkInMethod: queueItem?.check_in_method || queueItem?.checkInMethod || null,
    holdReason: queueItem?.hold_reason || queueItem?.holdReason || null,
  };
  return override ? applyOverrideToStudent(merged, override) : merged;
};

// Main Teacher View Component
export default function TeacherView() {
  const { currentSchool, user, logout } = useGoPilotAuth();
  const { hasClassPilot, hasPassPilot } = useLicenses();
  const { isNative } = useNative();
  const navigate = useNavigate();
  const socket = useSocket();

  const { unavailableIds, attendanceStatusByStudent } = useAbsentStudents('gopilot');
  const [currentTime, setCurrentTime] = useState(new Date());

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [homeroom, setHomeroom] = useState(null);
  const [session, setSession] = useState(null);
  const [students, setStudents] = useState([]);
  const [overrides, setOverrides] = useState({});
  const [retryCount, setRetryCount] = useState(0);
  const teacher = {
    name: user ? `${user.firstName || ''} ${user.lastName || ''}`.trim() : '',
    homeroom: homeroom ? homeroom.name : 'Loading...',
  };
  const rawSessionStatus = session?.status || 'not_started';
  const sessionStatus = rawSessionStatus === 'active' && socket?.connected === false ? 'stale' : rawSessionStatus;
  const sessionMeta = sessionStatusMeta[sessionStatus] || sessionStatusMeta.stale;
  const isSessionActive = rawSessionStatus === 'active';

  // Fetch initial data
  useEffect(() => {
    if (!currentSchool?.id) return;
    let cancelled = false;

    const init = async () => {
      try {
        if (retryCount === 0) setLoading(true);
        setError(null);

        const homeroomsRes = await api.get('/gopilot/homerooms/mine');
        const homerooms = Array.isArray(homeroomsRes.data) ? homeroomsRes.data : homeroomsRes.data?.homerooms || [];
        const myHomeroom = homerooms[0];

        if (!myHomeroom) {
          if (!cancelled) setError('No GoPilot homeroom found for your account.');
          if (!cancelled) setLoading(false);
          return;
        }

        if (!cancelled) setHomeroom(myHomeroom);

        const studentsRes = await api.get('/gopilot/students', { params: { homeroomId: myHomeroom.id } });
        const sessionRes = await api.get('/sessions/today');
        const sessionData = sessionRes.data?.session || null;
        if (!cancelled) setSession(sessionData);

        const studentList = Array.isArray(studentsRes.data) ? studentsRes.data : studentsRes.data?.students || [];
        let queueItems = [];
        const overrideMap = {};
        if (sessionData?.id) {
          const queueRes = await api.get(`/sessions/${sessionData.id}/queue`, { params: { homeroomId: myHomeroom.id } });
          queueItems = Array.isArray(queueRes.data) ? queueRes.data : queueRes.data?.items || [];

          try {
            const overridesRes = await api.get(`/sessions/${sessionData.id}/overrides`);
            for (const o of overridesRes.data?.overrides || []) {
              overrideMap[o.studentId] = normalizeOverride(o);
            }
          } catch { /* non-critical */ }

        }

        const queueByStudentId = {};
        queueItems.forEach((q) => {
          queueByStudentId[q.student_id || q.studentId] = q;
        });

        const merged = studentList.map((s) =>
          mergeQueueState(s, queueByStudentId[s.id], overrideMap[s.id])
        );

        if (!cancelled) {
          setOverrides(overrideMap);
          setStudents(merged);
          setLoading(false);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err?.response?.data?.message || err.message || 'Failed to load data.');
          setLoading(false);
        }
      }
    };

    init();
    return () => { cancelled = true; };
  }, [currentSchool?.id, user?.id, retryCount]);

  // Join socket room (and re-join on reconnect)
  useEffect(() => {
    if (!socket || !currentSchool?.id || !homeroom?.id) return;

    const joinRoom = () => {
      socket.emit('join:school', { schoolId: currentSchool.id, role: 'teacher', homeroomId: homeroom.id });
    };
    const joinAndRefresh = () => {
      joinRoom();
      setRetryCount(c => c + 1);
    };

    // Always join when this effect runs (socket may already be connected)
    joinRoom();

    // Also re-join on reconnect
    socket.on('connect', joinAndRefresh);

    return () => {
      socket.off('connect', joinAndRefresh);
    };
  }, [socket, currentSchool?.id, homeroom?.id]);

  // Socket events are the fast path; periodic snapshots keep the classroom
  // correct after reconnects or a degraded Redis relay.
  useEffect(() => {
    if (!currentSchool?.id || !homeroom?.id) return undefined;
    const refresh = () => setRetryCount((count) => count + 1);
    const interval = window.setInterval(
      refresh,
      socket?.connected === false ? 5_000 : (session?.status === 'active' ? 15_000 : 60_000),
    );
    const refreshVisible = () => {
      if (document.visibilityState === 'visible') refresh();
    };
    document.addEventListener('visibilitychange', refreshVisible);
    window.addEventListener('focus', refresh);
    return () => {
      window.clearInterval(interval);
      document.removeEventListener('visibilitychange', refreshVisible);
      window.removeEventListener('focus', refresh);
    };
  }, [currentSchool?.id, homeroom?.id, session?.status, socket?.connected]);

  // Socket event listeners
  useEffect(() => {
    if (!socket) return;

    // A staff-entered arrival moves the student into the waiting queue.
    const handleStudentCheckedIn = (data) => {
      const entry = data.entry || data;
      const studentId = entry.student_id || entry.studentId;
      const pickupGroupLabel = entry.pickupGroupLabel || entry.pickup_group_label || null;
      const queueId = entry.id || entry.queueId;
      const checkInMethod = entry.check_in_method || entry.checkInMethod || null;
      setStudents((prev) =>
        prev.map((s) =>
          s.id === studentId
            ? { ...s, queueStatus: 'waiting', queueId: queueId || s.queueId, pickupGroupLabel: pickupGroupLabel || s.pickupGroupLabel, checkInMethod: checkInMethod || s.checkInMethod }
            : s
        )
      );
    };

    const handleStudentCalled = (data) => {
      const entry = data.entry || data;
      const studentId = entry.student_id || entry.studentId;
      const pickupGroupLabel = entry.pickupGroupLabel || entry.pickup_group_label || null;
      const queueId = entry.id || entry.queueId;
      setStudents((prev) =>
        prev.map((s) =>
          s.id === studentId
            ? { ...s, queueStatus: entry.status || 'called', calledAt: new Date(), pickupGroupLabel: pickupGroupLabel || s.pickupGroupLabel, queueId: queueId || s.queueId, zone: data.zone || entry.zone || s.zone }
            : s
        )
      );
    };

    const handleStudentReleased = (data) => {
      const entry = data.entry || data;
      const studentId = entry.student_id || entry.studentId;
      setStudents((prev) =>
        prev.map((s) =>
          s.id === studentId
            ? { ...s, queueStatus: 'released', releasedAt: new Date() }
            : s
        )
      );
    };

    // A completed pickup moves the student back to the roster as dismissed.
    const handleStudentDismissed = (data) => {
      const entry = data.entry || data;
      const studentId = entry.student_id || entry.studentId;
      setStudents((prev) =>
        prev.map((s) =>
          s.id === studentId
            ? { ...s, queueStatus: 'dismissed', dismissedAt: new Date() }
            : s
        )
      );
    };

    const handleQueueUpdated = async () => {
      if (!session?.id || !homeroom?.id) return;
      try {
        const queueRes = await api.get(`/sessions/${session.id}/queue`, { params: { homeroomId: homeroom.id } });
        const queueItems = Array.isArray(queueRes.data) ? queueRes.data : queueRes.data?.items || [];
        const queueByStudentId = {};
        queueItems.forEach((q) => {
          queueByStudentId[q.student_id || q.studentId] = q;
        });
        setStudents((prev) =>
          prev.map((s) => {
            const q = queueByStudentId[s.id];
            return mergeQueueState(s, q, overrides[s.id]);
          })
        );
      } catch { /* silent */ }
    };

    const handleOverride = (data) => {
      if (data.overrideType) {
        const override = normalizeOverride(data);
        setOverrides(prev => ({ ...prev, [data.studentId]: override }));
        setStudents(prev => prev.map(s => s.id === data.studentId ? applyOverrideToStudent(s, override) : s));
      } else {
        setOverrides(prev => { const next = { ...prev }; delete next[data.studentId]; return next; });
        setStudents(prev => prev.map(s => s.id === data.studentId ? applyOverrideToStudent(s, null) : s));
      }
    };

    const handleTypeUpdated = ({ studentId, dismissalType, busRoute, isOverride }) => {
      setStudents(prev => prev.map(s =>
        s.id === studentId
          ? isOverride
            ? {
                ...s,
                effectiveDismissalType: dismissalType,
                effectiveBusRoute: busRoute || '',
                isOverridden: true,
              }
            : {
                ...s,
                permanentDismissalType: dismissalType,
                permanentBusRoute: busRoute || '',
                dismissalType,
                dismissal_type: dismissalType,
                busRoute: busRoute || '',
                bus_route: busRoute || '',
                effectiveDismissalType: s.isOverridden ? s.effectiveDismissalType : dismissalType,
                effectiveBusRoute: s.isOverridden ? s.effectiveBusRoute : (busRoute || ''),
              }
          : s
      ));
    };

    const refreshSnapshot = () => setRetryCount(c => c + 1);

    socket.on('student:checked-in', handleStudentCheckedIn);
    socket.on('student:called', handleStudentCalled);
    socket.on('student:released', handleStudentReleased);
    socket.on('student:dismissed', handleStudentDismissed);
    socket.on('queue:updated', handleQueueUpdated);
    socket.on('dismissal:override', handleOverride);
    socket.on('student:typeUpdated', handleTypeUpdated);
    socket.on('dismissal:status', refreshSnapshot);
    socket.on('dismissal:started', refreshSnapshot);
    socket.on('dismissal:ended', refreshSnapshot);
    socket.on('walkers:released', handleQueueUpdated);

    return () => {
      socket.off('student:checked-in', handleStudentCheckedIn);
      socket.off('student:called', handleStudentCalled);
      socket.off('student:released', handleStudentReleased);
      socket.off('student:dismissed', handleStudentDismissed);
      socket.off('queue:updated', handleQueueUpdated);
      socket.off('dismissal:override', handleOverride);
      socket.off('student:typeUpdated', handleTypeUpdated);
      socket.off('dismissal:status', refreshSnapshot);
      socket.off('dismissal:started', refreshSnapshot);
      socket.off('dismissal:ended', refreshSnapshot);
      socket.off('walkers:released', handleQueueUpdated);
    };
  }, [socket, session?.id, homeroom?.id, overrides]);

  useEffect(() => {
    const interval = setInterval(() => setCurrentTime(new Date()), 30000);
    return () => clearInterval(interval);
  }, []);

  // Teacher releases a called student from class.
  const handleDismissFromClass = async (student) => {
    if (!isSessionActive) {
      setError('Dismissal must be active before students can be released.');
      return;
    }
    if (!student.queueId || student.queueStatus !== 'called') return;
    try {
      await api.post(`/queue/${student.queueId}/release`);
      setStudents((prev) =>
        prev.map((s) =>
          s.id === student.id ? { ...s, queueStatus: 'released', releasedAt: new Date() } : s
        )
      );
    } catch (err) {
      setError(err?.response?.data?.error || err?.response?.data?.message || 'Failed to release student.');
    }
  };

  // TODO: restore group release only after queue items carry stable pickupGroupId/checkInBatchId values.

  // Categorize students
  const waitingStudents = students.filter(s => s.queueStatus === 'waiting');
  const calledStudents = students.filter(s => s.queueStatus === 'called');
  const inTransitStudents = students.filter(s => s.queueStatus === 'released');
  // LEFT panel: roster (not in queue = grey, dismissed = blue "picked up")
  const rosterStudents = students.filter(s => !s.queueStatus || s.queueStatus === 'dismissed');
  // Group students by the server-provided pickup batch label.
  const calledByReason = {};
  calledStudents.forEach(s => {
    const key = s.pickupGroupLabel || 'Unknown';
    if (!calledByReason[key]) calledByReason[key] = [];
    calledByReason[key].push(s);
  });
  const waitingByReason = {};
  waitingStudents.forEach(s => {
    const key = s.pickupGroupLabel || 'Unknown';
    if (!waitingByReason[key]) waitingByReason[key] = [];
    waitingByReason[key].push(s);
  });

  const getEffectiveType = (student) => {
    const override = overrides[student.id];
    return override ? override.overrideType : (student.effectiveDismissalType || student.dismissal_type || student.dismissalType || 'car');
  };

  const getEffectiveBusRoute = (student) => {
    const override = overrides[student.id];
    return override?.busRoute || student.effectiveBusRoute || student.bus_route || student.busRoute || '';
  };

  const dismissalTypes = [
    { id: 'car', label: 'Car', icon: Car, color: 'blue' },
    { id: 'bus', label: 'Bus', icon: Bus, color: 'yellow' },
    { id: 'walker', label: 'Walker', icon: PersonStanding, color: 'green' },
    { id: 'afterschool', label: 'After School', icon: Clock, color: 'purple' },
  ];

  const getTypeIcon = (type) => {
    const found = dismissalTypes.find(t => t.id === type);
    return found ? found.icon : Car;
  };

  // Loading state
  if (loading) {
    return (
      <div className="min-h-screen bg-gray-100 flex items-center justify-center">
        <div className="text-center">
          <Loader2 className="w-10 h-10 text-indigo-600 animate-spin mx-auto mb-4" />
          <p className="text-gray-600 font-medium">Loading your classroom...</p>
        </div>
      </div>
    );
  }

  // Error state
  if (error && students.length === 0) {
    const isNoGoPilotHomeroom = error === 'No GoPilot homeroom found for your account.';
    const canOpenClassPilot = isNoGoPilotHomeroom && hasClassPilot && !isNative;
    return (
      <div className="min-h-screen bg-gray-100 flex items-center justify-center">
        <Card className="max-w-md mx-auto">
          <div className="p-6 text-center">
            <AlertCircle className={`w-12 h-12 mx-auto mb-4 ${isNoGoPilotHomeroom ? 'text-amber-500' : 'text-red-500'}`} />
            <h2 className="text-lg font-semibold text-gray-900 mb-2">
              {isNoGoPilotHomeroom ? 'No GoPilot Homeroom Assigned' : 'Unable to Load'}
            </h2>
            <p className="text-gray-600 mb-4">
              {isNoGoPilotHomeroom
                ? canOpenClassPilot
                  ? 'GoPilot dismissal teacher view needs an assigned homeroom. You can still open ClassPilot.'
                  : 'GoPilot dismissal teacher view needs an assigned homeroom. Ask an admin to assign your GoPilot homeroom.'
                : error}
            </p>
            <div className="flex flex-col sm:flex-row justify-center gap-2">
              <Button onClick={() => { setError(null); setLoading(true); setRetryCount(c => c + 1); }}>
                <RefreshCw className="w-4 h-4 mr-2" />
                Retry
              </Button>
              {canOpenClassPilot && (
                <Button onClick={() => navigate('/classpilot')}>
                  Open ClassPilot
                  <ArrowRight className="w-4 h-4 ml-2" />
                </Button>
              )}
            </div>
          </div>
        </Card>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-100">
      {/* Inline error banner */}
      {error && students.length > 0 && (
        <div className="bg-red-50 border-b border-red-200 px-4 py-2 flex items-center justify-between">
          <div className="flex items-center gap-2 text-red-700 text-sm">
            <AlertCircle className="w-4 h-4" />
            {error}
          </div>
          <button onClick={() => setError(null)} className="text-red-500 hover:text-red-700">
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* Header */}
      <header className="bg-white border-b sticky top-0 z-50">
        <div className="px-3 sm:px-4 py-2 sm:py-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 sm:gap-4 min-w-0">
              <div className="flex items-center gap-2 sm:gap-3 min-w-0">
                <div className="w-8 h-8 sm:w-10 sm:h-10 bg-indigo-600 rounded-xl flex items-center justify-center flex-shrink-0">
                  <Home className="w-4 h-4 sm:w-5 sm:h-5 text-white" />
                </div>
                <div className="min-w-0">
                  <h1 className="font-bold text-gray-900 text-sm sm:text-base truncate">{teacher.homeroom}</h1>
                  <p className="text-[10px] sm:text-xs text-gray-500 truncate">{teacher.name} • {currentSchool?.name}</p>
                </div>
              </div>

              {/* Product switcher */}
              {!isNative && (hasClassPilot || hasPassPilot) && (
                <div className="hidden sm:flex items-center gap-1 ml-2 border-l pl-3">
                  {hasClassPilot && (
                    <button onClick={() => navigate('/classpilot')}
                      className="px-3 py-1 rounded-md text-sm font-semibold bg-yellow-400 text-blue-900 hover:bg-yellow-300 transition-colors">
                      ClassPilot
                    </button>
                  )}
                  {hasPassPilot && (
                    <button onClick={() => navigate('/passpilot')}
                      className="px-3 py-1 rounded-md text-sm font-semibold bg-blue-600 text-white hover:bg-blue-500 transition-colors">
                      PassPilot
                    </button>
                  )}
                </div>
              )}
            </div>

            <div className="flex items-center gap-2 sm:gap-4 flex-shrink-0">
              <div className="hidden sm:flex items-center gap-4 text-sm">
                <div className={`flex items-center gap-1.5 px-2 py-1 rounded-full ${sessionMeta.className}`}>
                  <div className={`w-2 h-2 rounded-full ${sessionMeta.dot} ${isSessionActive ? 'animate-pulse' : ''}`} />
                  <span className="font-medium">{sessionMeta.label}</span>
                </div>
                <div className="flex items-center gap-1.5">
                  <div className="w-2.5 h-2.5 rounded-full bg-red-500 animate-pulse" />
                  <span className="font-medium text-red-600">{calledStudents.length} Called</span>
                </div>
                <div className="flex items-center gap-1.5">
                  <div className="w-2.5 h-2.5 rounded-full bg-yellow-500" />
                  <span className="font-medium text-yellow-700">{waitingStudents.length} Waiting</span>
                </div>
                <div className="flex items-center gap-1.5">
                  <div className="w-2.5 h-2.5 rounded-full bg-green-500" />
                  <span className="font-medium text-green-600">{inTransitStudents.length} In Transit</span>
                </div>
                <div className="flex items-center gap-1.5">
                  <div className="w-2.5 h-2.5 rounded-full bg-blue-500" />
                  <span className="font-medium text-blue-600">{rosterStudents.filter(s => s.queueStatus === 'dismissed').length} Picked Up</span>
                </div>
              </div>

              <div className="text-right">
                <p className="text-base sm:text-xl font-bold text-gray-900">
                  {currentTime.toLocaleTimeString([], { timeZone: currentSchool?.timezone, hour: '2-digit', minute: '2-digit' })}
                </p>
              </div>

              <Button
                variant="ghost"
                size="sm"
                onClick={() => { logout(); navigate('/login'); }}
              >
                <LogOut className="w-4 h-4" />
              </Button>
            </div>
          </div>
        </div>
        {/* Mobile stats bar */}
        <div className="sm:hidden border-t px-3 py-1.5 flex items-center justify-around text-xs">
          <div className={`flex items-center gap-1 px-1.5 py-0.5 rounded-full ${sessionMeta.className}`}>
            <div className={`w-2 h-2 rounded-full ${sessionMeta.dot}`} />
            <span className="font-medium">{sessionMeta.label}</span>
          </div>
          <div className="flex items-center gap-1">
            <div className="w-2 h-2 rounded-full bg-red-500 animate-pulse" />
            <span className="font-medium text-red-600">{calledStudents.length} Called</span>
          </div>
          <div className="flex items-center gap-1">
            <div className="w-2 h-2 rounded-full bg-yellow-500" />
            <span className="font-medium text-yellow-700">{waitingStudents.length} Waiting</span>
          </div>
          <div className="flex items-center gap-1">
            <div className="w-2 h-2 rounded-full bg-green-500" />
            <span className="font-medium text-green-600">{inTransitStudents.length} In Transit</span>
          </div>
          <div className="flex items-center gap-1">
            <div className="w-2 h-2 rounded-full bg-blue-500" />
            <span className="font-medium text-blue-600">{rosterStudents.filter(s => s.queueStatus === 'dismissed').length} Picked Up</span>
          </div>
        </div>
      </header>

      {/* 3-Panel Layout */}
      <div className="flex flex-col sm:flex-row h-[calc(100vh-105px)] sm:h-[calc(100vh-73px)]">

        {/* LEFT PANEL - Class Roster */}
        <aside className="w-64 xl:w-72 bg-white border-r overflow-y-auto flex-shrink-0 hidden lg:block">
          <div className="p-3 border-b bg-gray-50">
            <h2 className="font-semibold text-sm text-gray-700 flex items-center gap-2">
              <Users className="w-4 h-4" />
              Class Roster
              <span className="text-xs text-gray-400">{students.length}</span>
            </h2>
          </div>
          <div className="divide-y">
            {rosterStudents.map(student => {
              const effectiveType = getEffectiveType(student);
              const isOverridden = overrides[student.id] != null;
              const TypeIcon = getTypeIcon(effectiveType);
              const isPickedUp = student.queueStatus === 'dismissed';
              const isAbsent = unavailableIds.has(student.id);
              const attendanceStatus = attendanceStatusByStudent[student.id];
              return (
                <div key={student.id} className={`p-3 flex items-center gap-3 ${isAbsent ? 'bg-gray-50 opacity-60' : isPickedUp ? 'bg-blue-50' : 'hover:bg-gray-50'}`}>
                  <div className={`w-9 h-9 rounded-full flex items-center justify-center text-sm font-medium ${
                    isAbsent ? 'bg-gray-200 text-gray-500' : isPickedUp ? 'bg-blue-100 text-blue-600' : 'bg-gray-100 text-gray-600'
                  }`}>
                    {(student.first_name || student.firstName || '?')[0]}{(student.last_name || student.lastName || '?')[0]}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className={`text-sm font-medium truncate flex items-center gap-1 ${isAbsent ? 'text-gray-500' : isPickedUp ? 'text-blue-700' : 'text-gray-900'}`}>
                      {student.first_name || student.firstName} {student.last_name || student.lastName}
                    </p>
                    <div className="flex items-center gap-1 text-xs text-gray-500">
                      <TypeIcon className="w-3 h-3" />
                      <span className="capitalize">{effectiveType === 'afterschool' ? 'After School' : effectiveType}</span>
                      {getEffectiveBusRoute(student) && effectiveType === 'bus' && <span>#{getEffectiveBusRoute(student)}</span>}
                      {isOverridden && <span className="text-orange-500 font-medium ml-1">Today</span>}
                    </div>
                  </div>
                  {isAbsent && (
                    <Badge variant="default" size="sm">{attendanceStatus === 'early_dismissal' ? 'Early Dismissal' : 'Absent'}</Badge>
                  )}
                  {!isAbsent && isPickedUp && (
                    <Badge variant="blue" size="sm">Picked Up</Badge>
                  )}
                </div>
              );
            })}
            {rosterStudents.length === 0 && (
              <div className="p-6 text-center text-gray-400 text-sm">
                All students are in the dismissal queue
              </div>
            )}
          </div>
        </aside>

        {/* CENTER PANEL - Dismissal queue */}
        <main className="flex-1 overflow-y-auto p-4">
          {/* Checked-in Students - waiting for office call */}
          {Object.keys(waitingByReason).length > 0 && (
            <div className="mb-6">
              <div className="flex items-center gap-2 mb-3">
                <Clock className="w-5 h-5 text-yellow-500" />
                <h2 className="font-semibold text-yellow-700">Checked In - Awaiting Call</h2>
              </div>
              <div className="space-y-3">
                {Object.entries(waitingByReason).map(([reason, groupStudents]) => (
                  <Card key={reason} className="border-2 border-yellow-200 bg-yellow-50">
                    <div className="p-3 border-b border-yellow-200 flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <span className="font-semibold text-yellow-800">{reason}</span>
                        <Badge variant="yellow" size="sm">{groupStudents.length} waiting</Badge>
                      </div>
                    </div>
                    <div className="divide-y divide-yellow-100">
                      {groupStudents.map(student => (
                        <div key={student.id} className="p-3 flex items-center justify-between">
                          <div className="flex items-center gap-3">
                            <div className="w-10 h-10 bg-yellow-100 rounded-full flex items-center justify-center">
                              <Clock className="w-5 h-5 text-yellow-600" />
                            </div>
                            <div>
                              <p className="font-medium text-gray-900">{student.first_name || student.firstName} {student.last_name || student.lastName}</p>
                              <p className="text-xs text-yellow-700">Office has not called this student yet</p>
                            </div>
                          </div>
                          <Badge variant="yellow" size="sm">Waiting</Badge>
                        </div>
                      ))}
                    </div>
                  </Card>
                ))}
              </div>
            </div>
          )}

          {/* Called Students - RED */}
          {Object.keys(calledByReason).length > 0 && (
            <div className="mb-6">
              <div className="flex items-center gap-2 mb-3">
                <Bell className="w-5 h-5 text-red-500" />
                <h2 className="font-semibold text-red-600">Called - Release from Class</h2>
              </div>
              <div className="space-y-4">
                {Object.entries(calledByReason).map(([reason, groupStudents]) => (
                  <Card key={reason} className="border-2 border-red-200 bg-red-50">
                    <div className="p-3 border-b border-red-200 flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <span className="font-semibold text-red-800">{reason}</span>
                        <Badge variant="red" size="sm">{groupStudents.length} students</Badge>
                      </div>
                    </div>
                    <div className="divide-y divide-red-100">
                      {groupStudents.map(student => (
                        <div key={student.id} className="p-3 flex items-center justify-between">
                          <div className="flex items-center gap-3">
                            <div className="w-10 h-10 bg-red-100 rounded-full flex items-center justify-center animate-pulse">
                              <Bell className="w-5 h-5 text-red-500" />
                            </div>
                            <div>
                              <p className="font-medium text-gray-900">{student.first_name || student.firstName} {student.last_name || student.lastName}</p>
                              <p className="text-xs text-gray-500">
                                Grade {student.grade} • {getEffectiveType(student)}
                                {getEffectiveBusRoute(student) && getEffectiveType(student) === 'bus' && ` #${getEffectiveBusRoute(student)}`}
                              </p>
                            </div>
                          </div>
                          <Button variant="success" size="sm" onClick={() => handleDismissFromClass(student)} disabled={!isSessionActive}>
                            <Check className="w-4 h-4 mr-1" /> Release from Class
                          </Button>
                        </div>
                      ))}
                    </div>
                  </Card>
                ))}
              </div>
            </div>
          )}

          {/* In Transit Students - GREEN */}
          {inTransitStudents.length > 0 && (
            <div className="mb-6">
              <div className="flex items-center gap-2 mb-3">
                <ArrowRight className="w-5 h-5 text-green-500" />
                <h2 className="font-semibold text-green-600">In Transit</h2>
              </div>
              <div className="space-y-2">
                {inTransitStudents.map(student => (
                  <Card key={student.id} className="border-2 border-green-200 bg-green-50">
                    <div className="p-3 flex items-center justify-between">
                      <div className="flex items-center gap-3">
                        <div className="w-10 h-10 bg-green-100 rounded-full flex items-center justify-center">
                          <CheckCircle2 className="w-5 h-5 text-green-500" />
                        </div>
                        <div>
                          <p className="font-medium text-gray-900">{student.first_name || student.firstName} {student.last_name || student.lastName}</p>
                          <p className="text-xs text-green-600">Dismissed from class • {student.pickupGroupLabel}</p>
                        </div>
                      </div>
                      <Badge variant="green" size="sm">
                        <ArrowRight className="w-3 h-3" /> In Transit
                      </Badge>
                    </div>
                  </Card>
                ))}
              </div>
            </div>
          )}

          {/* Empty state */}
          {waitingStudents.length === 0 && calledStudents.length === 0 && inTransitStudents.length === 0 && (
            <div className="flex items-center justify-center h-64">
              <div className="text-center text-gray-400">
                <Bell className="w-16 h-16 mx-auto mb-4 opacity-30" />
                <p className="text-lg font-medium">No students called yet</p>
                <p className="text-sm">Students will appear here when the office queues and calls them.</p>
              </div>
            </div>
          )}

          {/* Mobile roster (shown below center content on small screens) */}
          <div className="lg:hidden mt-6">
            <Card>
              <div className="p-3 border-b bg-gray-50">
                <h2 className="font-semibold text-sm text-gray-700 flex items-center gap-2">
                  <Users className="w-4 h-4" />
                  Class Roster
                  <span className="text-xs text-gray-400">{students.length}</span>
                </h2>
              </div>
              <div className="divide-y">
                {rosterStudents.map(student => {
                  const effectiveType = getEffectiveType(student);
                  const TypeIcon = getTypeIcon(effectiveType);
                  const isPickedUp = student.queueStatus === 'dismissed';
                  const isAbsent = unavailableIds.has(student.id);
                  const attendanceStatus = attendanceStatusByStudent[student.id];
                  return (
                    <div key={student.id} className={`p-3 flex items-center gap-3 ${isAbsent ? 'bg-gray-50 opacity-60' : isPickedUp ? 'bg-blue-50' : ''}`}>
                      <div className={`w-8 h-8 rounded-full flex items-center justify-center text-xs font-medium ${
                        isAbsent ? 'bg-gray-200 text-gray-500' : isPickedUp ? 'bg-blue-100 text-blue-600' : 'bg-gray-100 text-gray-600'
                      }`}>
                        {(student.first_name || student.firstName || '?')[0]}{(student.last_name || student.lastName || '?')[0]}
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className={`text-sm font-medium truncate ${isAbsent ? 'text-gray-500' : isPickedUp ? 'text-blue-700' : 'text-gray-900'}`}>
                          {student.first_name || student.firstName} {student.last_name || student.lastName}
                        </p>
                        <div className="flex items-center gap-1 text-xs text-gray-500">
                          <TypeIcon className="w-3 h-3" />
                          <span className="capitalize">{effectiveType}</span>
                        </div>
                      </div>
                      {isAbsent && <Badge variant="default" size="sm">{attendanceStatus === 'early_dismissal' ? 'Early Dismissal' : 'Absent'}</Badge>}
                      {!isAbsent && isPickedUp && <Badge variant="blue" size="sm">Picked Up</Badge>}
                    </div>
                  );
                })}
              </div>
            </Card>
          </div>
        </main>

        {/* RIGHT PANEL - Announcements */}
        <aside className="w-64 xl:w-72 bg-white border-l overflow-y-auto flex-shrink-0 hidden xl:block">
          <div className="p-3 border-b bg-gray-50">
            <h2 className="font-semibold text-sm text-gray-700 flex items-center gap-2">
              <Megaphone className="w-4 h-4" />
              Announcements
            </h2>
          </div>
          <div className="p-3 space-y-3">
            {/* Dynamic announcements based on queue state */}
            {(() => {
              const busGroups = {};
              const walkerCount = calledStudents.filter(s => getEffectiveType(s) === 'walker').length;
              calledStudents.forEach(s => {
                if (getEffectiveType(s) === 'bus' && getEffectiveBusRoute(s)) {
                  const route = getEffectiveBusRoute(s);
                  if (!busGroups[route]) busGroups[route] = 0;
                  busGroups[route]++;
                }
              });

              const items = [];

              Object.entries(busGroups).forEach(([route, count]) => {
                items.push(
                  <div key={`bus-${route}`} className="flex items-center gap-3 p-3 bg-yellow-50 rounded-lg">
                    <Bus className="w-5 h-5 text-yellow-600 flex-shrink-0" />
                    <div>
                      <p className="text-sm font-medium text-yellow-800">Bus #{route} called</p>
                      <p className="text-xs text-yellow-600">{count} student{count > 1 ? 's' : ''} from your class</p>
                    </div>
                  </div>
                );
              });

              if (walkerCount > 0) {
                items.push(
                  <div key="walkers" className="flex items-center gap-3 p-3 bg-green-50 rounded-lg">
                    <PersonStanding className="w-5 h-5 text-green-600 flex-shrink-0" />
                    <div>
                      <p className="text-sm font-medium text-green-800">Walkers released</p>
                      <p className="text-xs text-green-600">{walkerCount} student{walkerCount > 1 ? 's' : ''} from your class</p>
                    </div>
                  </div>
                );
              }

              const carCount = calledStudents.filter(s => getEffectiveType(s) === 'car' || s.checkInMethod === 'car_number').length;
              if (carCount > 0) {
                items.push(
                  <div key="cars" className="flex items-center gap-3 p-3 bg-blue-50 rounded-lg">
                    <Car className="w-5 h-5 text-blue-600 flex-shrink-0" />
                    <div>
                      <p className="text-sm font-medium text-blue-800">Car pickups active</p>
                      <p className="text-xs text-blue-600">{carCount} student{carCount > 1 ? 's' : ''} waiting</p>
                    </div>
                  </div>
                );
              }

              if (items.length === 0) {
                items.push(
                  <div key="empty" className="text-center text-gray-400 py-8 text-sm">
                    <Megaphone className="w-8 h-8 mx-auto mb-2 opacity-30" />
                    <p>No announcements yet</p>
                    <p className="text-xs mt-1">Announcements will appear when dismissal begins</p>
                  </div>
                );
              }

              return items;
            })()}

            {/* Summary stats */}
            <div className="mt-4 pt-4 border-t">
              <h3 className="text-xs font-semibold text-gray-500 uppercase mb-2">Today's Summary</h3>
              <div className="space-y-2 text-sm">
                <div className="flex justify-between">
                  <span className="text-gray-500">Total Students</span>
                  <span className="font-medium">{students.length}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-500">Picked Up</span>
                  <span className="font-medium text-blue-600">{rosterStudents.filter(s => s.queueStatus === 'dismissed').length}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-500">In Transit</span>
                  <span className="font-medium text-green-600">{inTransitStudents.length}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-500">Checked In</span>
                  <span className="font-medium text-yellow-700">{waitingStudents.length}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-500">Called to Dismiss</span>
                  <span className="font-medium text-red-600">{calledStudents.length}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-500">Still in Class</span>
                  <span className="font-medium">{rosterStudents.filter(s => !s.queueStatus).length}</span>
                </div>
              </div>
            </div>
          </div>
        </aside>
      </div>

    </div>
  );
}
