import React, { useState, useEffect, useMemo } from 'react';
import {
  Car, Bus, PersonStanding, Clock, Users, Bell, Check, X,
  ChevronRight, ChevronDown, AlertTriangle, CheckCircle2, Timer,
  Volume2, VolumeX, LogOut, Home, RefreshCw, User,
  AlertCircle, Send, Coffee, Hand, MapPin, Smartphone, Filter,
  Loader2, ArrowRight, Megaphone, ClipboardCheck, MessageSquare
} from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useGoPilotAuth } from '../../../hooks/useGoPilotAuth';
import { useLicenses } from '../../../contexts/LicenseContext';
import { useNative } from '../../../contexts/NativeContext';
import { useSocket } from '../../../contexts/SocketContext';
import api from '../../../shared/utils/api';
import { useAbsentStudents } from '../../../hooks/useAbsentStudents';
import { AttendancePanel } from '../../../components/AttendancePanel';
import { Badge, Button, Card } from '../components/ui';

const normalizeChangeRequest = (change, fallbackStudentName = '') => ({
  id: change.id,
  studentId: change.studentId,
  studentName: change.student
    ? `${change.student.firstName} ${change.student.lastName}`.trim()
    : fallbackStudentName,
  fromType: change.fromType,
  toType: change.toType,
  busRoute: change.busRoute,
  note: change.note,
  status: change.status || 'pending',
  acknowledgedAt: change.acknowledgedAt,
  acknowledgedBy: change.acknowledgedBy,
  reviewedAt: change.reviewedAt,
  reviewedBy: change.reviewedBy,
  createdAt: change.createdAt,
});

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
    guardian: queueItem ? (queueItem.guardian_name || queueItem.guardianName || student.guardian || null) : null,
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
  const [soundEnabled, setSoundEnabled] = useState(true);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [showAttendance, setShowAttendance] = useState(false);
  const [homeroom, setHomeroom] = useState(null);
  const [session, setSession] = useState(null);
  const [students, setStudents] = useState([]);
  const [overrides, setOverrides] = useState({});
  const [busRoutes, setBusRoutes] = useState([]);
  const [changeRequests, setChangeRequests] = useState([]);
  const [showNotifications, setShowNotifications] = useState(false);
  const [showNoteFor, setShowNoteFor] = useState(null);
  const [unreadChangeCount, setUnreadChangeCount] = useState(0);
  const [changeActionId, setChangeActionId] = useState(null);
  const [showOverrideFor, setShowOverrideFor] = useState(null);
  const [overrideType, setOverrideType] = useState('');
  const [overrideBusRoute, setOverrideBusRoute] = useState('');
  const [overrideReason, setOverrideReason] = useState('');
  const [retryCount, setRetryCount] = useState(0);
  const teacher = {
    name: user ? `${user.firstName || ''} ${user.lastName || ''}`.trim() : '',
    homeroom: homeroom ? homeroom.name : 'Loading...',
  };
  const rawSessionStatus = session?.status || 'not_started';
  const sessionStatus = rawSessionStatus === 'active' && socket?.connected === false ? 'stale' : rawSessionStatus;
  const sessionMeta = sessionStatusMeta[sessionStatus] || sessionStatusMeta.stale;
  const isSessionActive = sessionStatus === 'active';
  const selectedOverrideStudent = useMemo(
    () => students.find((student) => student.id === showOverrideFor) || null,
    [students, showOverrideFor]
  );
  const busRouteOptions = useMemo(() => {
    const values = new Set(
      busRoutes
        .map((route) => route.routeNumber || route.busRoute || route.name || route.id)
        .filter(Boolean)
    );
    if (selectedOverrideStudent?.permanentBusRoute) values.add(selectedOverrideStudent.permanentBusRoute);
    if (selectedOverrideStudent?.effectiveBusRoute) values.add(selectedOverrideStudent.effectiveBusRoute);
    if (overrideBusRoute) values.add(overrideBusRoute);
    return [...values].sort((a, b) => String(a).localeCompare(String(b), undefined, { numeric: true }));
  }, [busRoutes, selectedOverrideStudent, overrideBusRoute]);

  // Fetch initial data
  useEffect(() => {
    if (!currentSchool?.id) return;
    let cancelled = false;

    const init = async () => {
      try {
        setLoading(true);
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

        const studentsRes = await api.get(`/schools/${currentSchool.id}/students`, { params: { homeroomId: myHomeroom.id } });
        const sessionRes = await api.get('/sessions/today');
        const sessionData = sessionRes.data?.session || null;
        if (!cancelled) setSession(sessionData);

        try {
          const busRoutesRes = await api.get('/gopilot/bus-routes');
          const routes = Array.isArray(busRoutesRes.data) ? busRoutesRes.data : busRoutesRes.data?.routes || [];
          if (!cancelled) setBusRoutes(routes);
        } catch {
          if (!cancelled) setBusRoutes([]);
        }

        const studentList = Array.isArray(studentsRes.data) ? studentsRes.data : studentsRes.data?.students || [];
        let queueItems = [];
        const overrideMap = {};
        let changes = [];
        if (sessionData?.id) {
          const queueRes = await api.get(`/sessions/${sessionData.id}/queue`, { params: { homeroomId: myHomeroom.id } });
          queueItems = Array.isArray(queueRes.data) ? queueRes.data : queueRes.data?.items || [];

          try {
            const overridesRes = await api.get(`/sessions/${sessionData.id}/overrides`);
            for (const o of overridesRes.data?.overrides || []) {
              overrideMap[o.studentId] = normalizeOverride(o);
            }
          } catch { /* non-critical */ }

          try {
            const changesRes = await api.get(`/sessions/${sessionData.id}/changes`);
            changes = changesRes.data?.changes || [];
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
          setChangeRequests(changes.map(c => normalizeChangeRequest(c)));
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

  // Socket event listeners
  useEffect(() => {
    if (!socket) return;

    // student:checked-in — office entered car/bus/walker, student goes to center as RED
    const handleStudentCheckedIn = (data) => {
      const entry = data.entry || data;
      const studentId = entry.student_id || entry.studentId;
      const guardianName = entry.guardian_name || entry.guardianName || null;
      const queueId = entry.id || entry.queueId;
      const checkInMethod = entry.check_in_method || entry.checkInMethod || null;
      setStudents((prev) =>
        prev.map((s) =>
          s.id === studentId
            ? { ...s, queueStatus: 'waiting', queueId: queueId || s.queueId, guardian: guardianName || s.guardian, checkInMethod: checkInMethod || s.checkInMethod }
            : s
        )
      );
    };

    const handleStudentCalled = (data) => {
      const entry = data.entry || data;
      const studentId = entry.student_id || entry.studentId;
      const guardianName = entry.guardian_name || entry.guardianName || null;
      const queueId = entry.id || entry.queueId;
      setStudents((prev) =>
        prev.map((s) =>
          s.id === studentId
            ? { ...s, queueStatus: entry.status || 'called', calledAt: new Date(), guardian: guardianName || s.guardian, queueId: queueId || s.queueId, zone: data.zone || entry.zone || s.zone }
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

    // student:dismissed — picked up by office/parent, move to roster as blue
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

    const upsertChangeRequest = ({ change, studentName }) => {
      const normalized = normalizeChangeRequest(change, studentName || '');
      setChangeRequests(prev => {
        const idx = prev.findIndex(cr => cr.id === normalized.id);
        if (idx === -1) return [normalized, ...prev];
        const next = [...prev];
        next[idx] = { ...next[idx], ...normalized, studentName: normalized.studentName || next[idx].studentName };
        return next;
      });
    };

    const handleChangeRequested = ({ change, studentName }) => {
      upsertChangeRequest({ change, studentName });
      setUnreadChangeCount(prev => prev + 1);
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
    socket.on('change:requested', handleChangeRequested);
    socket.on('change:acknowledged', upsertChangeRequest);
    socket.on('change:resolved', upsertChangeRequest);
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
      socket.off('change:requested', handleChangeRequested);
      socket.off('change:acknowledged', upsertChangeRequest);
      socket.off('change:resolved', upsertChangeRequest);
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
  // Group called students by reason (guardian name)
  const calledByReason = {};
  calledStudents.forEach(s => {
    const key = s.guardian || 'Unknown';
    if (!calledByReason[key]) calledByReason[key] = [];
    calledByReason[key].push(s);
  });
  const waitingByReason = {};
  waitingStudents.forEach(s => {
    const key = s.guardian || 'Unknown';
    if (!waitingByReason[key]) waitingByReason[key] = [];
    waitingByReason[key].push(s);
  });

  // Override handler
  const handleOverrideSubmit = async () => {
    if (!session?.id || !showOverrideFor || !overrideType) return;
    if (!isSessionActive) {
      setError('Dismissal must be active before changing today\'s dismissal type.');
      return;
    }
    const effectiveBusRoute = overrideType === 'bus'
      ? (overrideBusRoute.trim() || selectedOverrideStudent?.permanentBusRoute || '').trim()
      : '';
    if (overrideType === 'bus' && !effectiveBusRoute) {
      setError('Choose a bus route before saving this override.');
      return;
    }
    try {
      await api.post(`/sessions/${session.id}/override`, {
        studentId: showOverrideFor,
        overrideType,
        ...(overrideType === 'bus' ? { busRoute: effectiveBusRoute } : {}),
        reason: overrideReason || undefined,
      });
      const override = { overrideType, reason: overrideReason, busRoute: effectiveBusRoute };
      setOverrides(prev => ({ ...prev, [showOverrideFor]: override }));
      setStudents(prev => prev.map(s => s.id === showOverrideFor ? applyOverrideToStudent(s, override) : s));
      setShowOverrideFor(null);
      setOverrideType('');
      setOverrideBusRoute('');
      setOverrideReason('');
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to change dismissal type');
    }
  };

  const handleRevertOverride = async () => {
    if (!session?.id || !showOverrideFor) return;
    if (!isSessionActive) {
      setError('Dismissal must be active before reverting today\'s dismissal type.');
      return;
    }
    try {
      await api.delete(`/sessions/${session.id}/override/${showOverrideFor}`);
      setOverrides(prev => { const next = { ...prev }; delete next[showOverrideFor]; return next; });
      setStudents(prev => prev.map(s => s.id === showOverrideFor ? applyOverrideToStudent(s, null) : s));
      setShowOverrideFor(null);
      setOverrideType('');
      setOverrideBusRoute('');
      setOverrideReason('');
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to revert dismissal override');
    }
  };

  const handleAcknowledgeChangeRequest = async (changeId) => {
    setChangeActionId(changeId);
    try {
      const res = await api.post(`/changes/${changeId}/acknowledge`);
      const updated = normalizeChangeRequest(res.data?.change || {}, '');
      setChangeRequests(prev => prev.map(cr => cr.id === changeId ? { ...cr, ...updated, studentName: updated.studentName || cr.studentName } : cr));
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to acknowledge request');
    } finally {
      setChangeActionId(null);
    }
  };

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

              <div className="relative">
                <button
                  onClick={() => {
                    const opening = !showNotifications;
                    setShowNotifications(opening);
                    if (opening) {
                      setUnreadChangeCount(0);
                    }
                  }}
                  className="p-1.5 sm:p-2 rounded-lg hover:bg-gray-100 relative"
                >
                  <Bell className="w-5 h-5 text-gray-600" />
                  {unreadChangeCount > 0 && (
                    <span className="absolute -top-1 -right-1 w-5 h-5 bg-red-500 text-white text-[10px] font-bold rounded-full flex items-center justify-center">
                      {unreadChangeCount}
                    </span>
                  )}
                </button>
                {showNotifications && (
                  <div className="absolute right-0 top-full mt-1 w-80 bg-white rounded-xl shadow-xl border z-[100] max-h-96 overflow-y-auto">
                    <div className="p-3 border-b font-semibold text-sm flex items-center justify-between">
                      <span>Change Requests</span>
                      <button onClick={() => setShowNotifications(false)} className="p-1 hover:bg-gray-100 rounded"><X className="w-4 h-4" /></button>
                    </div>
                    {changeRequests.length === 0 ? (
                      <div className="p-4 text-center text-sm text-gray-400">No change requests</div>
                    ) : (
                      changeRequests.map((cr, i) => (
                        <div key={cr.id || i} className={`p-3 border-b last:border-b-0 ${cr.status !== 'pending' ? 'opacity-70' : ''} hover:bg-gray-50`}>
                          <div className="flex items-center justify-between">
                            <p className="text-sm font-medium flex items-center gap-1.5">
                              {cr.studentName}
                              {cr.status === 'approved' && <CheckCircle2 className="w-3.5 h-3.5 text-green-500" />}
                              {cr.status === 'rejected' && <X className="w-3.5 h-3.5 text-red-500" />}
                            </p>
                            <span className="text-xs text-gray-400">{cr.createdAt ? new Date(cr.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : ''}</span>
                          </div>
                          <div className="flex items-center gap-2 mt-0.5">
                            <p className="text-xs text-gray-500">
                              <span className="capitalize">{cr.fromType}</span> → <span className="capitalize">{cr.toType}</span>
                              {cr.busRoute && <span> #{cr.busRoute}</span>}
                            </p>
                            <span className={`text-[10px] uppercase px-1.5 py-0.5 rounded ${cr.status === 'approved' ? 'bg-green-100 text-green-700' : cr.status === 'rejected' ? 'bg-red-100 text-red-700' : cr.acknowledgedAt ? 'bg-blue-100 text-blue-700' : 'bg-amber-100 text-amber-700'}`}>
                              {cr.status === 'pending' && cr.acknowledgedAt ? 'Acknowledged' : cr.status}
                            </span>
                          </div>
                          {cr.note && (
                            <p className="text-xs bg-amber-50 text-amber-800 rounded px-2 py-1 mt-1">
                              <MessageSquare className="w-3 h-3 inline mr-1" />{cr.note}
                            </p>
                          )}
                          {cr.status === 'pending' && !cr.acknowledgedAt && (
                            <button
                              type="button"
                              disabled={changeActionId === cr.id}
                              onClick={() => handleAcknowledgeChangeRequest(cr.id)}
                              className="mt-2 px-2 py-1 text-xs rounded bg-blue-50 text-blue-700 hover:bg-blue-100 disabled:opacity-60"
                            >
                              Acknowledge
                            </button>
                          )}
                        </div>
                      ))
                    )}
                  </div>
                )}
              </div>

              <Button
                variant={soundEnabled ? 'secondary' : 'ghost'}
                size="sm"
                onClick={() => setSoundEnabled(!soundEnabled)}
              >
                {soundEnabled ? <Volume2 className="w-4 h-4" /> : <VolumeX className="w-4 h-4" />}
              </Button>

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
            <div className="flex items-center justify-between">
              <h2 className="font-semibold text-sm text-gray-700 flex items-center gap-2">
                <Users className="w-4 h-4" />
                Class Roster
                <span className="text-xs text-gray-400">{students.length}</span>
              </h2>
              <button
                onClick={() => setShowAttendance(!showAttendance)}
                className={`flex items-center gap-1 px-2 py-1 rounded text-xs font-medium transition-colors ${showAttendance ? 'bg-blue-600 text-white' : 'bg-white border border-gray-300 text-gray-600 hover:bg-gray-100'}`}
              >
                <ClipboardCheck className="w-3.5 h-3.5" />
                Attendance
              </button>
            </div>
          </div>
          {showAttendance && (
            <div className="p-2 border-b">
              <AttendancePanel
                students={students.map((s) => ({
                  id: s.id,
                  firstName: s.first_name || s.firstName || '',
                  lastName: s.last_name || s.lastName || '',
                }))}
                productContext="gopilot"
                onClose={() => setShowAttendance(false)}
              />
            </div>
          )}
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
                      {changeRequests.find(cr => cr.studentId === student.id && cr.note) && (
                        <button onClick={(e) => {
                          e.stopPropagation();
                          setShowNoteFor(showNoteFor === student.id ? null : student.id);
                        }} className="flex-shrink-0">
                          <MessageSquare className="w-3.5 h-3.5 text-amber-500" />
                        </button>
                      )}
                    </p>
                    {showNoteFor === student.id && (() => {
                      const cr = changeRequests.find(c => c.studentId === student.id && c.note);
                      return cr ? (
                        <div className="text-xs bg-amber-50 text-amber-800 rounded px-2 py-1 mt-1">
                          <span className="font-medium">Parent note:</span> {cr.note}
                          <div className="text-amber-600 mt-0.5 capitalize">{cr.fromType} → {cr.toType}</div>
                        </div>
                      ) : null;
                    })()}
                    <button
                      className={`flex items-center gap-1 text-xs ${isSessionActive ? 'text-gray-500 hover:text-indigo-600' : 'text-gray-400 cursor-not-allowed'}`}
                      disabled={!isSessionActive}
                      onClick={() => {
                        setShowOverrideFor(student.id);
                        setOverrideType(effectiveType);
                        setOverrideBusRoute(overrides[student.id]?.busRoute || getEffectiveBusRoute(student));
                        setOverrideReason(overrides[student.id]?.reason || '');
                      }}
                    >
                      <TypeIcon className="w-3 h-3" />
                      <span className="capitalize">{effectiveType === 'afterschool' ? 'After School' : effectiveType}</span>
                      {getEffectiveBusRoute(student) && effectiveType === 'bus' && <span>#{getEffectiveBusRoute(student)}</span>}
                      {isOverridden && <span className="text-orange-500 font-medium ml-1">Today</span>}
                    </button>
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
                          <p className="text-xs text-green-600">Dismissed from class • {student.guardian}</p>
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
                <p className="text-sm">Students will appear here when the office checks them in and calls them</p>
              </div>
            </div>
          )}

          {/* Mobile roster (shown below center content on small screens) */}
          <div className="lg:hidden mt-6">
            <Card>
              <div className="p-3 border-b bg-gray-50">
                <div className="flex items-center justify-between">
                  <h2 className="font-semibold text-sm text-gray-700 flex items-center gap-2">
                    <Users className="w-4 h-4" />
                    Class Roster
                    <span className="text-xs text-gray-400">{students.length}</span>
                  </h2>
                  <button
                    onClick={() => setShowAttendance(!showAttendance)}
                    className={`flex items-center gap-1 px-2 py-1 rounded text-xs font-medium transition-colors ${showAttendance ? 'bg-blue-600 text-white' : 'bg-white border border-gray-300 text-gray-600 hover:bg-gray-100'}`}
                  >
                    <ClipboardCheck className="w-3.5 h-3.5" />
                    Attendance
                  </button>
                </div>
              </div>
              {showAttendance && (
                <div className="p-2 border-b">
                  <AttendancePanel
                    students={students.map((s) => ({
                      id: s.id,
                      firstName: s.first_name || s.firstName || '',
                      lastName: s.last_name || s.lastName || '',
                    }))}
                    productContext="gopilot"
                    onClose={() => setShowAttendance(false)}
                  />
                </div>
              )}
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

      {/* Dismissal Override Modal */}
      {showOverrideFor && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-xl shadow-xl w-full max-w-sm">
            <div className="p-4 border-b flex items-center justify-between">
              <h2 className="font-bold">Change Dismissal for Today</h2>
              <button onClick={() => setShowOverrideFor(null)} className="p-1"><X className="w-5 h-5" /></button>
            </div>
            <div className="p-4 space-y-4">
              <p className="text-xs text-gray-500">This change only applies to today.</p>
              <div className="grid grid-cols-2 gap-2">
                {dismissalTypes.map(opt => (
                  <button
                    key={opt.id}
                    onClick={() => {
                      setOverrideType(opt.id);
                      if (opt.id === 'bus' && !overrideBusRoute) {
                        setOverrideBusRoute(selectedOverrideStudent?.permanentBusRoute || selectedOverrideStudent?.effectiveBusRoute || '');
                      }
                    }}
                    className={`p-3 rounded-lg border-2 flex flex-col items-center gap-1 text-sm ${
                      overrideType === opt.id ? 'border-indigo-600 bg-indigo-50 text-indigo-600' : 'border-gray-200 text-gray-500'
                    }`}
                  >
                    <opt.icon className="w-5 h-5" />
                    {opt.label}
                  </button>
                ))}
              </div>
              {overrideType === 'bus' && (
                <div className="space-y-2">
                  {busRouteOptions.length > 0 && (
                    <select
                      value={overrideBusRoute}
                      onChange={(e) => setOverrideBusRoute(e.target.value)}
                      className="w-full px-3 py-2 border rounded-lg text-sm bg-white"
                    >
                      <option value="">Select bus route</option>
                      {busRouteOptions.map((route) => (
                        <option key={route} value={route}>Bus #{route}</option>
                      ))}
                    </select>
                  )}
                  <input
                    type="text"
                    value={overrideBusRoute}
                    onChange={(e) => setOverrideBusRoute(e.target.value)}
                    placeholder="Bus route"
                    className="w-full px-3 py-2 border rounded-lg text-sm"
                  />
                </div>
              )}
              {overrideType === 'afterschool' && (
                <input
                  type="text" value={overrideReason} onChange={(e) => setOverrideReason(e.target.value)}
                  placeholder="Activity name (required)" className="w-full px-3 py-2 border rounded-lg text-sm"
                />
              )}
              {overrideType !== 'afterschool' && (
                <input
                  type="text" value={overrideReason} onChange={(e) => setOverrideReason(e.target.value)}
                  placeholder="Reason (optional)" className="w-full px-3 py-2 border rounded-lg text-sm"
                />
              )}
              <div className="flex gap-2">
                {overrides[showOverrideFor] && (
                  <Button variant="secondary" className="flex-1" onClick={handleRevertOverride} disabled={!isSessionActive}>
                    Revert to default
                  </Button>
                )}
                <Button variant="secondary" className="flex-1" onClick={() => {
                  setShowOverrideFor(null);
                  setOverrideType('');
                  setOverrideBusRoute('');
                  setOverrideReason('');
                }}>Cancel</Button>
                <Button variant="primary" className="flex-1" onClick={handleOverrideSubmit}
                  disabled={!isSessionActive || (overrideType === 'afterschool' && !overrideReason.trim()) || (overrideType === 'bus' && !(overrideBusRoute.trim() || selectedOverrideStudent?.permanentBusRoute))}>
                  Save
                </Button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
