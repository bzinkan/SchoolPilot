import { useState, useEffect, useMemo, useRef, useCallback } from "react";
import { useQuery, useQueries, useMutation } from "@tanstack/react-query";
import { useNavigate } from 'react-router-dom';
import { Monitor, Users, Activity, Settings as SettingsIcon, LogOut, Calendar, Shield, AlertTriangle, UserCog, Plus, X, GraduationCap, WifiOff, Video, MonitorPlay, TabletSmartphone, Lock, Unlock, Layers, CheckSquare, XSquare, User, UserCheck, List, ShieldBan, Eye, EyeOff, Timer, Clock, BarChart3, Trash2, UsersRound, Filter, Hand, MessageSquareOff, MessageSquare, Send, ClipboardCheck, RefreshCw } from "lucide-react";
import { Button } from '../../../components/ui/button';
import { Input } from '../../../components/ui/input';
import { Badge } from '../../../components/ui/badge';
import StudentTile from '../components/StudentTile';
import StudentDetailDrawer from '../components/StudentDetailDrawer';
import RemoteControlToolbar from '../components/RemoteControlToolbar';
import SessionMonitoringReportDialog from '../components/SessionMonitoringReportDialog';
import TeacherFab from '../components/TeacherFab';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../../../components/ui/dialog';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../../../components/ui/tabs';
import { Label } from '../../../components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../../components/ui/select';
import { Textarea } from '../../../components/ui/textarea';
import { useToast } from '../../../hooks/use-toast';
import { useWebRTC } from '../../../hooks/useWebRTC';
import { apiRequest, queryClient } from '../../../lib/queryClient';
import { useClassPilotAuth } from '../../../hooks/useClassPilotAuth';
import { useLicenses } from '../../../contexts/LicenseContext';
import { ThemeToggle } from '../../../components/ThemeToggle';
import ClassPilotSidebar from '../components/ClassPilotSidebar';
import { useAbsentStudents } from '../../../hooks/useAbsentStudents';
import { AttendancePanel } from '../../../components/AttendancePanel';
import { isUrlAllowed } from '../../../lib/classpilot-utils';
import {
  TILE_BATCH_QUERY_ROOTS,
  buildTileStudentIds,
  createTileBatchRequests,
  fetchTileBatchWithRollbackFallback,
  indexTileHistory,
  indexTileScreenshots,
} from '../lib/tileBatchPolling';
import {
  applyStudentRealtimeEvents,
  coalesceStudentRealtimeEvents,
  makeAggregatedStudentsQueryKey,
  mergeAggregatedStudents,
} from '../lib/studentRealtimeCache';
import {
  deriveStudentMonitoringDisplay,
  findNextStudentFreshnessBoundary,
  formatAbsoluteObservedAt,
  lastObservedDomain,
  removeStoppedLiveStream,
} from '../lib/studentMonitoringDisplay';
import {
  applyTransientCommandUpdate,
  completedStudentIdsFromCommand,
  commandDeliveryFeedback,
  expireTransientCommands,
  findNextTransientExpiry,
  hasPendingTransientAction,
  latestTransientClassroomUiEffect,
  trackTransientCommandResponse,
  transientEntryFeedback,
} from '../lib/commandDeliveryTruth';
import {
  className as scheduleClassName,
  effectiveWindow,
  formatWindow as formatScheduleWindow,
  invalidateScheduleChanges,
  scheduleChangeApi,
  scheduleChangeKeys,
  unwrapToday,
} from '../lib/scheduleChanges';

const EMPTY_LIST = Object.freeze([]);
const EMPTY_TILE_MAP = new Map();
const EMPTY_PICKUP_DATA = Object.freeze({
  students: EMPTY_LIST,
  scheduledCoverageGroups: EMPTY_LIST,
});

function pendingTransientControls(entries) {
  return {
    timer: hasPendingTransientAction(entries, 'timer'),
    poll: hasPendingTransientAction(entries, 'poll'),
  };
}

// Helper to normalize grade levels (strip "th", "rd", "st", "nd" suffixes)
function normalizeGrade(grade) {
  if (!grade) return null;
  const trimmed = grade.trim();
  if (!trimmed) return null;
  return trimmed.replace(/(\d+)(st|nd|rd|th)\b/gi, '$1');
}

function classStartOverlapData(error) {
  const data = error?.response?.data || error?.data || null;
  if (data?.code !== "CLASS_ROSTER_ACTIVE_OVERLAP") return null;
  return data;
}

function classResyncOverlapData(error) {
  const data = error?.response?.data || error?.data || null;
  if (data?.code !== "CLASS_RESYNC_ACTIVE_OVERLAP") return null;
  return data;
}

function resyncSummaryText(data) {
  const parts = [];
  if (data?.addedToSession) parts.push(`${data.addedToSession} added`);
  if (data?.notSignedIn) parts.push(`${data.notSignedIn} not signed in`);
  if (data?.activeElsewhere) parts.push(`${data.activeElsewhere} active elsewhere`);
  return parts.length > 0 ? `Class resynced: ${parts.join(", ")}` : "Class resynced: roster is already up to date";
}

function isScheduledTeachingSession(session) {
  return session?.lifecycle?.kind === "scheduled"
    || session?.lifecycleKind === "scheduled"
    || session?.summaryTrigger === "scheduled_end"
    || session?.lifecycle?.summaryTrigger === "scheduled_end"
    || Boolean(
      (session?.scheduledStartAt || session?.lifecycle?.scheduledStartAt)
      && (session?.scheduledEndAt || session?.lifecycle?.scheduledEndAt),
    );
}

function formatScheduledSessionEnd(session, fallbackTimezone) {
  const scheduledEndAt = session?.scheduledEndAt || session?.lifecycle?.scheduledEndAt;
  if (!scheduledEndAt) return null;

  const endTime = new Date(scheduledEndAt);
  if (Number.isNaN(endTime.getTime())) return null;

  try {
    return new Intl.DateTimeFormat("en-US", {
      hour: "numeric",
      minute: "2-digit",
      timeZone: session.scheduledTimezone
        || session.scheduleTimezone
        || session.timezone
        || session.lifecycle?.scheduledTimezone
        || fallbackTimezone,
    }).format(endTime);
  } catch {
    return new Intl.DateTimeFormat("en-US", {
      hour: "numeric",
      minute: "2-digit",
    }).format(endTime);
  }
}

function sessionEndToastDescription(data, wasScheduled) {
  const result = data?.result ?? data;
  const disposition = result?.summaryDisposition;

  if (disposition === "queued") {
    return wasScheduled
      ? "Scheduled class ended early. The Session Summary is queued for email."
      : "Class ended. The Session Summary is queued for email.";
  }
  if (disposition === "already_queued") {
    return "Class ended. The Session Summary was already queued for email.";
  }
  if (disposition === "not_applicable") {
    return "Class ended. No Session Summary is required for this session.";
  }
  return "Class session has been ended.";
}

function AvailableStudentActivity({ student, nowMs }) {
  const display = deriveStudentMonitoringDisplay(student, nowMs);
  if (display.telemetryCurrent) {
    return (
      <div className="mt-3 rounded-md bg-muted/40 p-3">
        <p className="truncate text-xs font-medium text-muted-foreground">{student.activeTabTitle || "No active tab"}</p>
        <p className="mt-1 truncate text-sm">{student.activeTabUrl || "Signed in to Chrome"}</p>
      </div>
    );
  }

  const domain = lastObservedDomain(student);
  const observedAt = formatAbsoluteObservedAt(display.observedAtMs);
  return (
    <div className="mt-3 rounded-md border border-amber-200 bg-amber-50/70 p-3 dark:border-amber-900 dark:bg-amber-950/20">
      <p className="text-xs font-semibold">Preview unavailable</p>
      <p className="mt-1 text-xs text-muted-foreground">{display.label}</p>
      <p className="mt-2 text-[11px] text-muted-foreground">Last observed at {observedAt}</p>
      {domain && <p className="mt-1 truncate text-[11px] text-muted-foreground">Last observed site: {domain}</p>}
    </div>
  );
}

export default function Dashboard() {
  const navigate = useNavigate();
  const { currentUser, school, isAdmin, isTeacher, token, logout } = useClassPilotAuth();
  const { hasPassPilot, hasGoPilot } = useLicenses();
  const { absentIds } = useAbsentStudents();
  const [sidebarOpen, setSidebarOpen] = useState(() => {
    try {
      return localStorage.getItem('classpilot-sidebar-open') !== 'false';
    } catch {
      return true;
    }
  });
  const handleSidebarToggle = () => {
    const next = !sidebarOpen;
    setSidebarOpen(next);
    try { localStorage.setItem('classpilot-sidebar-open', String(next)); } catch { /* ignore */ }
  };
  const showSidebar = (hasPassPilot || hasGoPilot) && sidebarOpen;
  const [selectedStudent, setSelectedStudent] = useState(null);
  const [selectedStudentIds, setSelectedStudentIds] = useState(new Set());
  const [showAttendance, setShowAttendance] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedGrade, setSelectedGrade] = useState(() => {
    try {
      const saved = localStorage.getItem('classpilot-selected-grade');
      return saved || "";
    } catch {
      return "";
    }
  });
  const [wsConnected, setWsConnected] = useState(false);
  const [liveStreams, setLiveStreams] = useState(new Map());
  const [liveViewPendingIds, setLiveViewPendingIds] = useState(new Set());
  const [tileRevisions, setTileRevisions] = useState({});
  const [teacherAllowedDomains, setTeacherAllowedDomains] = useState(new Set());
  const [showGradeDialog, setShowGradeDialog] = useState(false);
  const [newGrade, setNewGrade] = useState("");
  const [showOpenTabDialog, setShowOpenTabDialog] = useState(false);
  const [openTabUrl, setOpenTabUrl] = useState("");
  const [showLockUrlDialog, setShowLockUrlDialog] = useState(false);
  const [lockUrl, setLockUrl] = useState("");
  const [showCloseTabsDialog, setShowCloseTabsDialog] = useState(false);
  const [selectedTabsToClose, setSelectedTabsToClose] = useState(new Set());
  const [manageTabsStudentIds, setManageTabsStudentIds] = useState(null);
  const [showApplyFlightPathDialog, setShowApplyFlightPathDialog] = useState(false);
  const [selectedFlightPathId, setSelectedFlightPathId] = useState("");
  const [showFlightPathViewerDialog, setShowFlightPathViewerDialog] = useState(false);
  const [showApplyBlockListDialog, setShowApplyBlockListDialog] = useState(false);
  const [selectedBlockListId, setSelectedBlockListId] = useState("");
  const [showSendMessageDialog, setShowSendMessageDialog] = useState(false);
  const [sendMessageText, setSendMessageText] = useState("");
  const [showSignOutDialog, setShowSignOutDialog] = useState(false);
  const [showBlockListViewerDialog, setShowBlockListViewerDialog] = useState(false);
  const [showAttentionDialog, setShowAttentionDialog] = useState(false);
  const [attentionMessage, setAttentionMessage] = useState("Please look up!");
  const [attentionActive, setAttentionActive] = useState(false);
  const [showTimerDialog, setShowTimerDialog] = useState(false);
  const [timerMinutes, setTimerMinutes] = useState(5);
  const [timerSeconds, setTimerSeconds] = useState(0);
  const [timerMessage, setTimerMessage] = useState("");
  const [timerActive, setTimerActive] = useState(false);
  const [showPollDialog, setShowPollDialog] = useState(false);
  const [showPollResultsDialog, setShowPollResultsDialog] = useState(false);
  const [pollQuestion, setPollQuestion] = useState("");
  const [pollOptions, setPollOptions] = useState(["", ""]);
  const [activePoll, setActivePoll] = useState(null);
  const [pollResults, setPollResults] = useState([]);
  const [pollTotalResponses, setPollTotalResponses] = useState(0);
  const [studentView, setStudentView] = useState("class");
  const [showRerouteDialog, setShowRerouteDialog] = useState(false);
  const [selectedCoverageContextId, setSelectedCoverageContextId] = useState("");
  const [rerouteNote, setRerouteNote] = useState("");
  const [selectedSubgroupId, setSelectedSubgroupId] = useState("");
  const [subgroupMembers, setSubgroupMembers] = useState(new Set());
  const [raisedHands, setRaisedHands] = useState(new Map());
  const [studentMessages, setStudentMessages] = useState([]);
  const [chatReplies, setChatReplies] = useState({});
  const [startGroupId, setStartGroupId] = useState("");
  const [adminStartGroupId, setAdminStartGroupId] = useState("");
  const [classStartOverlap, setClassStartOverlap] = useState(null);
  const [classResyncOverlap, setClassResyncOverlap] = useState(null);
  const [endClassTarget, setEndClassTarget] = useState(null);
  const [sessionReportTarget, setSessionReportTarget] = useState(null);
  const [showLogoutDialog, setShowLogoutDialog] = useState(false);
  const [skipTodayGroup, setSkipTodayGroup] = useState(null);
  const [logoutPending, setLogoutPending] = useState(false);
  const [quickClaimStudentId, setQuickClaimStudentId] = useState(null);
  const dismissedMessageIds = useRef(new Set());
  const dismissedMessagesInitialized = useRef(false);
  // eslint-disable-next-line react-hooks/refs
  if (!dismissedMessagesInitialized.current) {
    dismissedMessagesInitialized.current = true;
    try {
      const saved = localStorage.getItem('classpilot-dismissed-messages');
      if (saved) {
        const ids = JSON.parse(saved);
        // eslint-disable-next-line react-hooks/refs
        ids.forEach(id => dismissedMessageIds.current.add(id));
      }
    } catch {
      // Ignore localStorage errors
    }
  }
  const [, _setReplyingToMessage] = useState(null);
  const [, _setReplyText] = useState("");
  const [adminObservedSessionId, setAdminObservedSessionId] = useState(null);
  const { toast } = useToast();
  const notifiedViolations = useRef(new Set());
  const wsRef = useRef(null);
  const websocketAuthRef = useRef(null);
  const reconnectTimeoutRef = useRef(null);
  const reconnectAttemptsRef = useRef(0);
  const isMountedRef = useRef(true);
  const invalidateTimeoutRef = useRef(null);
  const realtimeFlushTimeoutRef = useRef(null);
  const pendingRealtimeEventsRef = useRef([]);
  const freshnessTimeoutRef = useRef(null);
  const commandExpiryTimeoutRef = useRef(null);
  const transientCommandOutcomesRef = useRef(new Map());
  const aggregatedStudentsQueryKeyRef = useRef(null);
  const activeSchoolIdRef = useRef(null);
  const authenticatedSchoolIdRef = useRef(null);
  const maxReconnectDelay = 30000;
  const [wsAuthenticated, setWsAuthenticated] = useState(false);
  const [freshnessNowMs, setFreshnessNowMs] = useState(() => Date.now());
  const [transientCommandVersion, setTransientCommandVersion] = useState(0);
  const [transientPendingControls, setTransientPendingControls] = useState({
    timer: false,
    poll: false,
  });
  const effectiveSessionIdRef = useRef(null);
  const LIVE_VIEW_TIMEOUT_MS = 15 * 60 * 1000;
  const LIVE_VIEW_CONNECT_TIMEOUT_MS = 12000;
  const liveViewTimers = useRef(new Map());
  const liveViewConnectTimers = useRef(new Map());

  const handleLiveStreamStopped = useCallback((studentId) => {
    setLiveStreams((current) => removeStoppedLiveStream(current, studentId));
    setLiveViewPendingIds((current) => {
      if (!current.has(studentId)) return current;
      const next = new Set(current);
      next.delete(studentId);
      return next;
    });
    const connectTimer = liveViewConnectTimers.current.get(studentId);
    if (connectTimer) clearTimeout(connectTimer);
    liveViewConnectTimers.current.delete(studentId);
    const liveTimer = liveViewTimers.current.get(studentId);
    if (liveTimer) clearTimeout(liveTimer);
    liveViewTimers.current.delete(studentId);
  }, []);

  // WebRTC hook for live video streaming
  // eslint-disable-next-line react-hooks/refs
  const webrtc = useWebRTC(wsRef.current, handleLiveStreamStopped);

  const { data: settings } = useQuery({
    queryKey: ['/api/settings'],
    queryFn: () => apiRequest('GET', '/settings'),
    select: (data) => data?.settings ?? data ?? null,
  });

  const { data: flightPaths = EMPTY_LIST } = useQuery({
    queryKey: ['/api/flight-paths'],
    queryFn: () => apiRequest('GET', '/flight-paths'),
    select: (data) => Array.isArray(data) ? data : data?.flightPaths ?? [],
  });

  const { data: blockLists = EMPTY_LIST } = useQuery({
    queryKey: ['/api/block-lists'],
    queryFn: () => apiRequest('GET', '/block-lists'),
    select: (data) => Array.isArray(data) ? data : data?.blockLists ?? [],
  });

  const { data: activeSession } = useQuery({
    queryKey: ['/api/sessions/active'],
    queryFn: () => apiRequest('GET', '/sessions/active'),
    select: (data) => data?.session !== undefined ? data.session : data ?? null,
    refetchInterval: 10000,
  });

  const { data: groups = EMPTY_LIST } = useQuery({
    queryKey: ['/api/teacher/groups'],
    queryFn: () => apiRequest('GET', '/teacher/groups'),
    select: (data) => Array.isArray(data) ? data : data?.groups ?? [],
  });

  useEffect(() => {
    if (groups.length === 0) {
      setStartGroupId("");
      return;
    }
    if (!groups.some((group) => group.id === startGroupId)) {
      setStartGroupId(groups[0].id);
    }
  }, [groups, startGroupId]);

  const { data: adminTeachingGroups = EMPTY_LIST, isLoading: adminTeachingGroupsLoading } = useQuery({
    queryKey: ['/api/teacher/groups', 'mine'],
    queryFn: () => apiRequest('GET', '/teacher/groups?scope=mine'),
    select: (data) => Array.isArray(data) ? data : data?.groups ?? [],
    enabled: isAdmin,
  });

  useEffect(() => {
    if (!isAdmin || adminTeachingGroups.length === 0) {
      setAdminStartGroupId("");
      return;
    }
    if (!adminTeachingGroups.some((group) => group.id === adminStartGroupId)) {
      setAdminStartGroupId(adminTeachingGroups[0].id);
    }
  }, [adminTeachingGroups, adminStartGroupId, isAdmin]);

  const { data: allActiveSessions = EMPTY_LIST } = useQuery({
    queryKey: ['/api/sessions/all'],
    queryFn: () => apiRequest('GET', '/sessions/all'),
    select: (data) => Array.isArray(data) ? data : data?.sessions ?? [],
    enabled: isAdmin,
    refetchInterval: 10000,
  });

  const { data: activeCoverageContexts = EMPTY_LIST } = useQuery({
    queryKey: ['/api/coverage/contexts'],
    queryFn: () => apiRequest('GET', '/coverage/contexts'),
    select: (data) => (data?.contexts || []).filter((context) => context.status === 'active'),
    enabled: isAdmin || isTeacher,
    refetchInterval: 10000,
  });
  const manageableCoverageCount = activeCoverageContexts.filter((context) => context.canManage).length;

  const { data: coverageCapabilities = {} } = useQuery({
    queryKey: ['/api/coverage/capabilities'],
    queryFn: () => apiRequest('GET', '/coverage/capabilities'),
    enabled: isAdmin || isTeacher,
  });
  const canManageSupervisionSetup = isAdmin || !!coverageCapabilities.canManageSupervisionSetup;

  const { data: availablePickupData = EMPTY_PICKUP_DATA } = useQuery({
    queryKey: ['/api/coverage/available-students'],
    queryFn: () => apiRequest('GET', '/coverage/available-students'),
    select: (data) => ({
      students: data?.students || [],
      scheduledCoverageGroups: data?.scheduledCoverageGroups || [],
    }),
    enabled: isAdmin || isTeacher,
    refetchInterval: 10000,
  });
  const availablePickupStudents = availablePickupData.students;
  const scheduledCoverageGroups = availablePickupData.scheduledCoverageGroups;

  const { data: claimedPickupStudents = EMPTY_LIST } = useQuery({
    queryKey: ['/api/coverage/claimed-students'],
    queryFn: () => apiRequest('GET', '/coverage/claimed-students'),
    select: (data) => data?.students || [],
    enabled: isAdmin || isTeacher,
    refetchInterval: 10000,
  });

  const { data: rerouteCoverageTargets = EMPTY_LIST } = useQuery({
    queryKey: ['/api/coverage/reroute-targets'],
    queryFn: () => apiRequest('GET', '/coverage/reroute-targets'),
    select: (data) => data?.targets || data?.contexts || [],
    enabled: isAdmin || isTeacher,
    refetchInterval: 10000,
  });

  const { data: scheduledClassConflicts = EMPTY_LIST } = useQuery({
    queryKey: ['/api/classpilot/scheduled-conflicts'],
    queryFn: () => apiRequest('GET', '/classpilot/scheduled-conflicts'),
    select: (data) => data?.conflicts || [],
    enabled: isAdmin || isTeacher,
    refetchInterval: 15000,
  });

  // Admin observe mode logic
  const observedSession = isAdmin && adminObservedSessionId
    ? allActiveSessions.find(s => s.id === adminObservedSessionId)
    : null;
  const isAdminTeaching = isAdmin && (
    !!activeSession ||
    (observedSession && observedSession.teacherId === currentUser?.id)
  );
  const effectiveSession = isAdmin ? (observedSession || activeSession) : activeSession;
  const activeSchoolId = school?.id || currentUser?.schoolId || null;
  const { data: todayScheduleChanges = EMPTY_LIST } = useQuery({
    queryKey: scheduleChangeKeys.today(activeSchoolId),
    queryFn: scheduleChangeApi.getToday,
    select: unwrapToday,
    enabled: Boolean(isTeacher && activeSchoolId),
    refetchInterval: 60_000,
  });
  const effectiveSessionId = effectiveSession?.id || null;
  const adminSchoolMode = isAdmin && !effectiveSessionId;
  const aggregatedStudentsQueryKey = useMemo(
    () => makeAggregatedStudentsQueryKey(activeSchoolId, effectiveSessionId, adminSchoolMode),
    [activeSchoolId, adminSchoolMode, effectiveSessionId],
  );
  const { data: students = EMPTY_LIST, isLoading: studentsLoading } = useQuery({
    queryKey: aggregatedStudentsQueryKey,
    queryFn: () => apiRequest(
      'GET',
      effectiveSessionId
        ? `/students-aggregated?teachingSessionId=${encodeURIComponent(effectiveSessionId)}`
        : '/students-aggregated',
    ),
    select: (data) => Array.isArray(data) ? data : data?.students ?? [],
    refetchInterval: 30000,
    staleTime: 10000,
    structuralSharing: mergeAggregatedStudents,
  });

  useEffect(() => {
    websocketAuthRef.current = currentUser?.id && token ? {
      role: currentUser.role === 'admin' || currentUser.role === 'school_admin' ? 'school_admin' : 'teacher',
      userId: currentUser.id,
      userToken: token,
      schoolId: currentUser.schoolId,
    } : null;
  }, [currentUser?.id, currentUser?.role, currentUser?.schoolId, token]);
  const activeSessionIsScheduled = isScheduledTeachingSession(activeSession);
  const activeSessionScheduledEnd = formatScheduledSessionEnd(
    activeSession,
    school?.schoolTimezone || school?.timezone,
  );
  const selectedTeacherStartGroup = groups.find((group) => group.id === startGroupId);
  const selectedAdminStartGroup = adminTeachingGroups.find((group) => group.id === adminStartGroupId);

  useEffect(() => {
    effectiveSessionIdRef.current = effectiveSession?.id || null;
  }, [effectiveSession?.id]);

  useEffect(() => {
    aggregatedStudentsQueryKeyRef.current = aggregatedStudentsQueryKey;
    activeSchoolIdRef.current = activeSchoolId;
  }, [activeSchoolId, aggregatedStudentsQueryKey]);

  const { data: activeClassroomStates = EMPTY_LIST } = useQuery({
    queryKey: ['/api/commands/active-state', effectiveSession?.id],
    queryFn: () => apiRequest('GET', `/commands/active-state?teachingSessionId=${encodeURIComponent(effectiveSession.id)}`),
    select: (data) => data?.states ?? [],
    enabled: !!effectiveSession?.id,
    refetchInterval: 30000,
  });

  const { data: urlHistory = EMPTY_LIST } = useQuery({
    queryKey: ['/api/classpilot/tiles/history', selectedStudent?.studentId, effectiveSession?.startTime],
    queryFn: () => {
      return apiRequest('POST', '/classpilot/tiles/history', {
        studentIds: [selectedStudent.studentId],
        limit: 10,
      });
    },
    select: (data) => data?.tiles?.[0]?.heartbeats || [],
    enabled: !!selectedStudent?.studentId,
  });

  const { data: subgroups = EMPTY_LIST } = useQuery({
    queryKey: ['/api/groups', effectiveSession?.groupId, 'subgroups'],
    queryFn: async () => {
      if (!effectiveSession?.groupId) return [];
      const data = await apiRequest('GET', `/groups/${effectiveSession.groupId}/subgroups`);
      return data.subgroups || [];
    },
    enabled: !!effectiveSession?.groupId,
  });

  const { data: sessionStudentIds = EMPTY_LIST } = useQuery({
    queryKey: ['/api/groups', effectiveSession?.groupId, 'students'],
    queryFn: () => apiRequest('GET', `/groups/${effectiveSession?.groupId}/students`),
    enabled: !!effectiveSession?.groupId,
    select: (data) => {
      const students = Array.isArray(data) ? data : data?.students ?? [];
      return students.map((s) => s.id);
    },
  });

  const { data: initialRaisedHands } = useQuery({
    queryKey: ['/api/teacher/raised-hands', effectiveSession?.id],
    queryFn: () => apiRequest('GET', `/teacher/raised-hands?sessionId=${encodeURIComponent(effectiveSession.id)}`),
    enabled: !!effectiveSession?.id,
    refetchInterval: 30000,
  });

  const { data: initialChatMessages } = useQuery({
    queryKey: ['/api/teacher/messages', effectiveSession?.id],
    queryFn: () => apiRequest('GET', `/teacher/messages?sessionId=${encodeURIComponent(effectiveSession.id)}`),
    select: (data) => data?.messages ?? [],
    enabled: !!effectiveSession?.id,
    refetchInterval: 30000,
  });

  // Sync initial raised hands to state
  useEffect(() => {
    if (!effectiveSession?.id) {
      setRaisedHands(new Map());
      return;
    }
    if (initialRaisedHands?.raisedHands) {
      const handsMap = new Map();
      initialRaisedHands.raisedHands.forEach(hand => {
        handsMap.set(hand.studentId, {
          sessionId: hand.sessionId,
          studentId: hand.studentId,
          studentName: hand.studentName,
          studentEmail: hand.studentEmail,
          timestamp: hand.timestamp,
        });
      });
      setRaisedHands(handsMap);
    }
  }, [initialRaisedHands, effectiveSession?.id]);

  // Hydrate FAB chat from the canonical session chat store after refresh/reconnect.
  useEffect(() => {
    if (!effectiveSession?.id) {
      setStudentMessages([]);
      setChatReplies({});
      return;
    }
    if (!Array.isArray(initialChatMessages)) return;

    const studentLookup = new Map();
    students.forEach((student) => {
      const key = student.studentId || student.id;
      if (!key) return;
      studentLookup.set(key, student);
    });
    const nameFor = (studentId) => {
      const student = studentLookup.get(studentId);
      return student?.studentName || student?.name || [student?.firstName, student?.lastName].filter(Boolean).join(" ").trim() || student?.email || studentId;
    };
    const emailFor = (studentId) => studentLookup.get(studentId)?.studentEmail || studentLookup.get(studentId)?.email || "";
    const sorted = [...initialChatMessages].sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
    const hydratedStudentMessages = sorted
      .filter((msg) => msg.senderType === 'student' && !dismissedMessageIds.current.has(msg.id))
      .map((msg) => ({
        id: msg.id,
        sessionId: msg.sessionId,
        studentId: msg.studentId,
        studentName: nameFor(msg.studentId),
        studentEmail: emailFor(msg.studentId),
        message: msg.content,
        messageType: msg.messageType || 'message',
        timestamp: msg.createdAt,
        read: true,
      }));
    const hydratedReplies = {};
    sorted
      .filter((msg) => msg.senderType === 'teacher' && msg.studentId)
      .forEach((msg) => {
        hydratedReplies[msg.studentId] = [
          ...(hydratedReplies[msg.studentId] || []),
          {
            id: msg.id,
            message: msg.content,
            timestamp: msg.createdAt,
            status: msg.deliveryStatus || 'sent',
            errorMessage: msg.errorMessage,
          },
        ];
      });

    setStudentMessages(hydratedStudentMessages);
    setChatReplies(hydratedReplies);
  }, [initialChatMessages, effectiveSession?.id, students]);

  // WebSocket connection with automatic reconnection
  useEffect(() => {
    isMountedRef.current = true;
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    }
    reconnectAttemptsRef.current = 0;

    const flushRealtimeEvents = () => {
      realtimeFlushTimeoutRef.current = null;
      const queued = pendingRealtimeEventsRef.current;
      pendingRealtimeEventsRef.current = [];
      const queryKey = aggregatedStudentsQueryKeyRef.current;
      if (!queryKey || queued.length === 0) return;
      const events = coalesceStudentRealtimeEvents(queued);
      queryClient.setQueryData(queryKey, (old) => applyStudentRealtimeEvents(old, events, {
        schoolId: activeSchoolIdRef.current,
      }));
    };

    const queueRealtimeEvent = (message) => {
      pendingRealtimeEventsRef.current.push(message);
      if (realtimeFlushTimeoutRef.current) return;
      realtimeFlushTimeoutRef.current = setTimeout(flushRealtimeEvents, 100);
    };

    const reconcileLegacyRealtime = () => {
      if (invalidateTimeoutRef.current) clearTimeout(invalidateTimeoutRef.current);
      invalidateTimeoutRef.current = setTimeout(() => {
        const queryKey = aggregatedStudentsQueryKeyRef.current;
        if (queryKey) queryClient.invalidateQueries({ queryKey, exact: true });
        invalidateTimeoutRef.current = null;
      }, 300);
    };

    const connectWebSocket = () => {
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
        reconnectTimeoutRef.current = null;
      }
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }

      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      const wsUrl = `${protocol}//${window.location.host}/ws`;
      console.log('[Dashboard] Connecting to WebSocket (attempt', reconnectAttemptsRef.current + 1, '):', wsUrl);

      try {
        const socket = new WebSocket(wsUrl);
        wsRef.current = socket;

        socket.onopen = () => {
          if (!isMountedRef.current) return;
          console.log("[Dashboard] WebSocket connected successfully");
          setWsConnected(true);
          reconnectAttemptsRef.current = 0;
          const auth = websocketAuthRef.current;
          if (auth) {
            socket.send(JSON.stringify({
              type: 'auth',
              ...auth,
            }));
          }

          // Heartbeat to keep CloudFront/ALB connection alive
          const heartbeatInterval = setInterval(() => {
            if (socket.readyState === WebSocket.OPEN) {
              socket.send(JSON.stringify({ type: 'ping' }));
            }
          }, 20000);
          socket._heartbeatInterval = heartbeatInterval;
        };

        socket.onmessage = (event) => {
          if (!isMountedRef.current) return;
          try {
            const message = JSON.parse(event.data);
            if (message.type === 'auth-success') {
              setWsAuthenticated(true);
              authenticatedSchoolIdRef.current = activeSchoolIdRef.current;
              const queryKey = aggregatedStudentsQueryKeyRef.current;
              if (queryKey) queryClient.refetchQueries({ queryKey, exact: true });
            }
            if (message.type === 'auth-error') {
              setWsAuthenticated(false);
              authenticatedSchoolIdRef.current = null;
            }
            if (message.type === 'classpilot-command-update') {
              const publicCommand = message.command || {};
              const messageSchoolId = publicCommand.schoolId || message.schoolId;
              const messageSessionId = publicCommand.teachingSessionId || message.teachingSessionId;
              if (messageSchoolId && String(messageSchoolId) !== String(activeSchoolIdRef.current)) return;
              if (
                messageSessionId
                && String(messageSessionId) !== String(effectiveSessionIdRef.current)
              ) return;

              const before = transientCommandOutcomesRef.current;
              const tracked = trackTransientCommandResponse(
                before,
                message,
                publicCommand.commandType,
              );
              const after = applyTransientCommandUpdate(tracked, message);
              if (after !== before) {
                transientCommandOutcomesRef.current = after;
                setTransientPendingControls(pendingTransientControls(after));
                setTransientCommandVersion((version) => version + 1);
                const id = message.commandId || publicCommand.id;
                const previousEntry = id ? before.get(id) : null;
                const currentEntry = id ? after.get(id) : null;
                const previousTimerEffect = latestTransientClassroomUiEffect(before, 'timer');
                const currentTimerEffect = latestTransientClassroomUiEffect(after, 'timer');
                if (
                  previousTimerEffect?.commandId !== currentTimerEffect?.commandId
                  || previousTimerEffect?.active !== currentTimerEffect?.active
                ) {
                  setTimerActive(currentTimerEffect?.active === true);
                }

                const previousPollEffect = latestTransientClassroomUiEffect(before, 'poll');
                const currentPollEffect = latestTransientClassroomUiEffect(after, 'poll');
                if (
                  previousPollEffect?.commandId !== currentPollEffect?.commandId
                  || previousPollEffect?.active !== currentPollEffect?.active
                ) {
                  if (currentPollEffect?.active) {
                    setActivePoll(currentPollEffect.poll);
                    if (previousPollEffect?.poll?.id !== currentPollEffect.poll.id) {
                      setPollResults([]);
                      setPollTotalResponses(0);
                    }
                  } else {
                    setActivePoll(null);
                    setShowPollResultsDialog(false);
                  }
                }
                if (
                  currentEntry
                  && (
                    (!previousEntry && currentEntry.summary.acknowledged > 0)
                    || currentEntry.summary.acknowledged > (previousEntry?.summary.acknowledged || 0)
                    || currentEntry.summary.expired > (previousEntry?.summary.expired || 0)
                    || currentEntry.summary.failed > (previousEntry?.summary.failed || 0)
                  )
                ) {
                  const feedback = transientEntryFeedback(currentEntry);
                  toast(feedback);
                }
              }
            }
            if (message.type === 'student-update') {
              queueRealtimeEvent(message);
              if (!Number.isSafeInteger(Number(message.revision ?? message.realtimeRevision))) {
                reconcileLegacyRealtime();
              }
            }
            if (message.type === 'answer') {
              webrtc.handleAnswer(message.from, message.sdp);
            }
            if (message.type === 'ice') {
              webrtc.handleIceCandidate(message.from, message.candidate);
            }
            if (message.type === 'hand-raised') {
              const eventSessionId = message.sessionId || message.data?.sessionId;
              if (eventSessionId && effectiveSessionIdRef.current && eventSessionId !== effectiveSessionIdRef.current) return;
              setRaisedHands(prev => {
                const newMap = new Map(prev);
                newMap.set(message.data.studentId, {
                  sessionId: eventSessionId,
                  studentId: message.data.studentId,
                  studentName: message.data.studentName,
                  studentEmail: message.data.studentEmail,
                  timestamp: message.data.timestamp,
                });
                return newMap;
              });
              toast({ title: "Hand Raised", description: `${message.data.studentName} is asking for help` });
            }
            if (message.type === 'hand-lowered') {
              const eventSessionId = message.sessionId || message.data?.sessionId;
              if (eventSessionId && effectiveSessionIdRef.current && eventSessionId !== effectiveSessionIdRef.current) return;
              setRaisedHands(prev => {
                const newMap = new Map(prev);
                newMap.delete(message.data.studentId);
                return newMap;
              });
            }
            if (message.type === 'hand-dismissed') {
              const eventSessionId = message.sessionId || message.data?.sessionId;
              if (eventSessionId && effectiveSessionIdRef.current && eventSessionId !== effectiveSessionIdRef.current) return;
              setRaisedHands(prev => {
                const newMap = new Map(prev);
                newMap.delete(message.studentId || message.data?.studentId);
                return newMap;
              });
            }
            if (message.type === 'student-message') {
              const eventSessionId = message.sessionId || message.data?.sessionId;
              if (eventSessionId && effectiveSessionIdRef.current && eventSessionId !== effectiveSessionIdRef.current) return;
              const msgId = message.data.id;
              if (dismissedMessageIds.current.has(msgId)) return;
              const newMsg = {
                id: msgId,
                sessionId: eventSessionId,
                studentId: message.data.studentId,
                studentName: message.data.studentName,
                studentEmail: message.data.studentEmail,
                message: message.data.message,
                messageType: message.data.messageType,
                timestamp: message.data.timestamp,
                read: false,
              };
              setStudentMessages(prev => {
                if (prev.some(m => m.id === msgId)) return prev;
                return [newMsg, ...prev];
              });
              toast({
                title: message.data.messageType === 'question' ? "Question" : "Message",
                description: `${message.data.studentName}: ${message.data.message.slice(0, 50)}${message.data.message.length > 50 ? '...' : ''}`,
              });
            }
            if (message.type === 'chat-message-delivery') {
              const eventSessionId = message.sessionId || message.data?.sessionId;
              if (eventSessionId && effectiveSessionIdRef.current && eventSessionId !== effectiveSessionIdRef.current) return;
              const messageId = message.messageId || message.data?.messageId;
              if (!messageId) return;
              setChatReplies(prev => {
                const next = {};
                Object.entries(prev).forEach(([studentId, replies]) => {
                  next[studentId] = replies.map((reply) => (
                    reply.id === messageId
                      ? { ...reply, status: message.deliveryStatus || message.data?.deliveryStatus, errorMessage: message.errorMessage || message.data?.errorMessage }
                      : reply
                  ));
                });
                return next;
              });
            }
            if (message.type === 'student-registered') {
              queryClient.invalidateQueries({ queryKey: ['/api/students-aggregated'] });
            }
            if (message.type === 'student-signed-out') {
              webrtc.stopLiveView(message.studentId);
              pendingRealtimeEventsRef.current = pendingRealtimeEventsRef.current.filter((queued) => (
                queued.studentId !== message.studentId
              ));
              const queryKey = aggregatedStudentsQueryKeyRef.current;
              if (queryKey) {
                queryClient.setQueryData(queryKey, (old) => applyStudentRealtimeEvents(old, [message], {
                  schoolId: activeSchoolIdRef.current,
                }));
                queryClient.invalidateQueries({ queryKey, exact: true });
              }
            }
            if (message.type === 'session-ended') {
              const endedOwnSession = Boolean(
                message.sessionId
                && effectiveSessionIdRef.current
                && message.sessionId === effectiveSessionIdRef.current,
              );
              queryClient.invalidateQueries({ queryKey: ['/api/sessions/active'], exact: false });
              queryClient.invalidateQueries({ queryKey: ['/api/sessions/all'], exact: false });
              queryClient.invalidateQueries({ queryKey: ['/api/students-aggregated'] });
              queryClient.invalidateQueries({ queryKey: ['/api/groups'], exact: false });
              queryClient.invalidateQueries({ queryKey: ['/api/teacher/groups'], exact: false });
              if (endedOwnSession) {
                const description = message.summaryDisposition === 'already_queued'
                  ? "The class ended. Its Session Summary was already queued for email."
                  : message.summaryDisposition === 'not_applicable'
                    ? "The class ended. No Session Summary was required."
                    : message.reason === 'scheduled_end'
                      ? "The scheduled class ended. Its Session Summary is queued for email."
                      : "The class ended. Its Session Summary is queued for email.";
                toast({ title: "Class Ended", description });
              }
            }
            if (message.type === 'scheduled-class-conflict-updated') {
              queryClient.invalidateQueries({ queryKey: ['/api/classpilot/scheduled-conflicts'] });
              queryClient.invalidateQueries({ queryKey: ['/api/coverage/available-students'] });
              queryClient.invalidateQueries({ queryKey: ['/api/coverage/claimed-students'] });
              queryClient.invalidateQueries({ queryKey: ['/api/sessions/active'], exact: false });
              queryClient.invalidateQueries({ queryKey: ['/api/students-aggregated'] });
            }
            if (message.type === 'schedule-change-updated' || message.type === 'classpilot-schedule-change-updated') {
              void invalidateScheduleChanges(activeSchoolIdRef.current);
              queryClient.invalidateQueries({ queryKey: ['/api/teacher/groups'], exact: false });
              queryClient.invalidateQueries({ queryKey: ['/api/sessions/active'], exact: false });
            }
            if (message.type === 'ai-classification') {
              queueRealtimeEvent(message);
              if (!Number.isSafeInteger(Number(message.revision ?? message.realtimeRevision))) {
                reconcileLegacyRealtime();
              }
            }
            if (message.type === 'safety-alert') {
              toast({
                title: "Safety Alert",
                description: `${message.studentName || 'A student'} may need attention — ${message.classification?.reason || 'flagged content detected'}`,
                variant: "destructive",
              });
              queryClient.invalidateQueries({ queryKey: ['/api/students-aggregated'] });
            }
            if (message.type === 'screenshot-available') {
              // Intentionally passive. Every Chromebook emits this event, and
              // the parent tile query already polls the complete cohort every
              // 30 seconds; invalidation would recreate a forty-event burst.
            }
            if (message.type === 'student-event') {
              if (message.eventType === 'blocked_domain') {
                toast({
                  title: "Blocked Site",
                  description: `${message.studentId} attempted to visit a blocked domain`,
                });
              }
            }
          } catch (error) {
            console.error("[Dashboard] WebSocket message error:", error);
          }
        };

        socket.onclose = () => {
          if (!isMountedRef.current) return;
          if (socket._heartbeatInterval) clearInterval(socket._heartbeatInterval);
          setWsConnected(false);
          setWsAuthenticated(false);
          authenticatedSchoolIdRef.current = null;
          wsRef.current = null;
          reconnectAttemptsRef.current++;
          const delay = Math.min(1000 * Math.pow(2, reconnectAttemptsRef.current - 1), maxReconnectDelay);
          reconnectTimeoutRef.current = setTimeout(connectWebSocket, delay);
        };

        socket.onerror = (error) => {
          if (!isMountedRef.current) return;
          console.error("[Dashboard] WebSocket error:", error);
          setWsConnected(false);
        };
      } catch (error) {
        console.error("[Dashboard] Failed to create WebSocket:", error);
        setWsConnected(false);
        reconnectAttemptsRef.current++;
        const delay = Math.min(1000 * Math.pow(2, reconnectAttemptsRef.current - 1), maxReconnectDelay);
        reconnectTimeoutRef.current = setTimeout(connectWebSocket, delay);
      }
    };

    const activeLiveViewTimers = liveViewTimers.current;
    const activeLiveViewConnectTimers = liveViewConnectTimers.current;

    connectWebSocket();

    return () => {
      isMountedRef.current = false;
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
        reconnectTimeoutRef.current = null;
      }
      if (invalidateTimeoutRef.current) {
        clearTimeout(invalidateTimeoutRef.current);
        invalidateTimeoutRef.current = null;
      }
      if (realtimeFlushTimeoutRef.current) {
        clearTimeout(realtimeFlushTimeoutRef.current);
        realtimeFlushTimeoutRef.current = null;
      }
      pendingRealtimeEventsRef.current = [];
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
      activeLiveViewTimers.forEach((timer) => clearTimeout(timer));
      activeLiveViewTimers.clear();
      activeLiveViewConnectTimers.forEach((timer) => clearTimeout(timer));
      activeLiveViewConnectTimers.clear();
      webrtc.cleanup();
    };
  // Reconnect when an administrator switches schools. Other live values are carried through refs.
  }, [currentUser?.schoolId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Re-authenticate when currentUser becomes available (e.g. token loaded after WS connected)
  useEffect(() => {
    const alreadyAuthenticatedForSchool = wsAuthenticated
      && authenticatedSchoolIdRef.current === currentUser?.schoolId;
    if (!currentUser?.id || !token || !wsRef.current || wsRef.current.readyState !== WebSocket.OPEN || alreadyAuthenticatedForSchool) return;
    setWsAuthenticated(false);
    wsRef.current.send(JSON.stringify({
      type: 'auth',
      role: currentUser.role === 'admin' || currentUser.role === 'school_admin' ? 'school_admin' : 'teacher',
      userId: currentUser.id,
      userToken: token,
      schoolId: currentUser.schoolId,
    }));
  }, [currentUser?.id, currentUser?.role, currentUser?.schoolId, token, wsConnected, wsAuthenticated]);

  useEffect(() => {
    const sessionId = effectiveSession?.id;
    const socket = wsRef.current;
    if (!sessionId || !wsAuthenticated || !socket || socket.readyState !== WebSocket.OPEN) return undefined;
    socket.send(JSON.stringify({ type: 'subscribe-session', sessionId }));
    return () => {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: 'unsubscribe-session', sessionId }));
      }
    };
  }, [effectiveSession?.id, wsAuthenticated, wsConnected]);

  useEffect(() => {
    transientCommandOutcomesRef.current = new Map();
    setTransientPendingControls({ timer: false, poll: false });
    setTimerActive(false);
    setActivePoll(null);
    setShowPollResultsDialog(false);
    if (commandExpiryTimeoutRef.current) {
      clearTimeout(commandExpiryTimeoutRef.current);
      commandExpiryTimeoutRef.current = null;
    }
  }, [activeSchoolId, effectiveSessionId]);

  useEffect(() => {
    if (commandExpiryTimeoutRef.current) {
      clearTimeout(commandExpiryTimeoutRef.current);
      commandExpiryTimeoutRef.current = null;
    }
    const expiresAt = findNextTransientExpiry(transientCommandOutcomesRef.current, Date.now());
    if (expiresAt === null) return undefined;

    commandExpiryTimeoutRef.current = setTimeout(() => {
      commandExpiryTimeoutRef.current = null;
      const before = transientCommandOutcomesRef.current;
      const after = expireTransientCommands(before, Date.now());
      if (after !== before) {
        transientCommandOutcomesRef.current = after;
        setTransientPendingControls(pendingTransientControls(after));
        for (const [id, entry] of after) {
          const previousEntry = before.get(id);
          if (entry.summary.expired > (previousEntry?.summary.expired || 0)) {
            toast(transientEntryFeedback(entry));
          }
        }
      }
      setTransientCommandVersion((version) => version + 1);
    }, Math.max(0, expiresAt - Date.now()));

    return () => {
      if (commandExpiryTimeoutRef.current) {
        clearTimeout(commandExpiryTimeoutRef.current);
        commandExpiryTimeoutRef.current = null;
      }
    };
  }, [transientCommandVersion, toast]);

  // Set initial grade when settings load
  useEffect(() => {
    if (settings?.gradeLevels && settings.gradeLevels.length > 0) {
      if (!selectedGrade || !settings.gradeLevels.includes(selectedGrade)) {
        setSelectedGrade(settings.gradeLevels[0]);
      }
    }
  }, [settings, selectedGrade]);

  // Save selected grade to localStorage
  useEffect(() => {
    if (selectedGrade) {
      try { localStorage.setItem('classpilot-selected-grade', selectedGrade); } catch { /* intentionally empty */ }
    }
  }, [selectedGrade]);

  // Check if student is off-task
  const isStudentOffTask = (student) => {
    if (!deriveStudentMonitoringDisplay(student, freshnessNowMs).telemetryCurrent) return false;
    if (student.cameraActive) return true;
    if (!student.activeTabUrl) return false;
    if (student.status !== 'online') return false;

    // AI classification check — respect teacher overrides
    if (student.aiClassification?.category === 'non-educational') {
      try {
        const domain = new URL(student.activeTabUrl).hostname.toLowerCase().replace(/^www\./, '');
        // Skip if teacher explicitly allowed this domain (Open Tab, dismiss, etc.)
        if (teacherAllowedDomains.has(domain)) return false;
        // Skip if domain is in active flight path's allowed list
        if (student.flightPathActive && student.activeFlightPathName) {
          const fp = flightPaths.find(f => f.flightPathName === student.activeFlightPathName);
          if (isUrlAllowed(student.activeTabUrl, fp?.allowedDomains || [])) return false;
        }
        return true;
      } catch { return false; }
    }

    // Allowed domains list check (school settings)
    if (!settings?.allowedDomains || settings.allowedDomains.length === 0) return false;
    return !isUrlAllowed(student.activeTabUrl, settings.allowedDomains);
  };

  const handleAllowDomain = (domain) => {
    setTeacherAllowedDomains(prev => new Set(prev).add(domain));
  };

  const getLastName = (fullName) => {
    if (!fullName) return '';
    const nameParts = fullName.trim().split(/\s+/);
    if (nameParts.length === 1) return nameParts[0].toLowerCase();
    return nameParts[nameParts.length - 1].toLowerCase();
  };

  const isStudentInTemporarySupervision = (student) => student?.supervisionState === "temporary_coverage";
  const isStudentOwnedByAnotherClass = (student) => (
    !!effectiveSession?.id &&
    student?.supervisionContext?.type === "class" &&
    student.supervisionContext.id &&
    student.supervisionContext.id !== effectiveSession.id
  );
  const isStudentCommandable = (student) => !isStudentInTemporarySupervision(student) && !isStudentOwnedByAnotherClass(student);

  // Selection handlers
  const toggleStudentSelection = (studentId) => {
    const student = filteredStudents.find((row) => row.studentId === studentId);
    if (studentView === "class" && !isStudentCommandable(student)) {
      toast({
        variant: "destructive",
        title: isStudentInTemporarySupervision(student) ? "Student is in supervision" : "Student moved to another class",
        description: isStudentInTemporarySupervision(student)
          ? "Return the student to class before using ClassPilot controls."
          : "The most recent active class session controls this student.",
      });
      return;
    }
    setSelectedStudentIds((prev) => {
      const newSet = new Set(prev);
      if (newSet.has(studentId)) { newSet.delete(studentId); } else { newSet.add(studentId); }
      return newSet;
    });
  };
  const selectAll = () => {
    const allStudentIds = selectableStudents.map((s) => s.studentId);
    setSelectedStudentIds(new Set(allStudentIds));
  };
  const clearSelection = () => { setSelectedStudentIds(new Set()); };
  const handleStudentViewChange = (view) => {
    setStudentView(view);
    setSelectedStudentIds(new Set());
    setSearchQuery("");
  };

  // Live view handlers — auto-timeout after 15 minutes to protect student device CPU/battery
  const markLiveViewPending = (studentId, pending) => {
    setLiveViewPendingIds((prev) => {
      const next = new Set(prev);
      if (pending) next.add(studentId);
      else next.delete(studentId);
      return next;
    });
  };

  const refreshTile = (studentId) => {
    setTileRevisions((prev) => ({ ...prev, [studentId]: (prev[studentId] ?? 0) + 1 }));
  };

  const handleStartLiveView = async (studentId) => {
    if (!wsAuthenticated) {
      toast({ title: "Not Ready", description: "Please wait for connection to be established", variant: "destructive" });
      return;
    }
    markLiveViewPending(studentId, true);
    let streamReceived = false;
    if (liveViewConnectTimers.current.has(studentId)) clearTimeout(liveViewConnectTimers.current.get(studentId));

    try {
      const connection = await webrtc.startLiveView(studentId, effectiveSession?.id, (stream) => {
        streamReceived = true;
        markLiveViewPending(studentId, false);
        if (liveViewConnectTimers.current.has(studentId)) {
          clearTimeout(liveViewConnectTimers.current.get(studentId));
          liveViewConnectTimers.current.delete(studentId);
        }
        setLiveStreams((prev) => { const newMap = new Map(prev); newMap.set(studentId, stream); return newMap; });
      });
      if (!connection) {
        markLiveViewPending(studentId, false);
        toast({ title: "Live View Not Ready", description: "The teacher connection is not ready yet. Try again in a moment.", variant: "destructive" });
        return;
      }
      liveViewConnectTimers.current.set(studentId, setTimeout(() => {
        if (streamReceived) return;
        markLiveViewPending(studentId, false);
        handleStopLiveView(studentId);
        refreshTile(studentId);
        toast({
          title: "Live View Timed Out",
          description: "The request was sent, but no stream arrived. The managed session, extension policy, or network may be blocking live capture; showing the latest screenshot instead.",
          variant: "destructive",
        });
      }, LIVE_VIEW_CONNECT_TIMEOUT_MS));
    } catch (error) {
      markLiveViewPending(studentId, false);
      toast({ title: "Live View Failed", description: error?.message || "Could not start live view.", variant: "destructive" });
      return;
    }
    // Clear any existing timer for this device and start a new one
    if (liveViewTimers.current.has(studentId)) clearTimeout(liveViewTimers.current.get(studentId));
    liveViewTimers.current.set(studentId, setTimeout(() => {
      handleStopLiveView(studentId);
      toast({ title: "Live View Ended", description: "Auto-stopped after 15 minutes to protect student device" });
    }, LIVE_VIEW_TIMEOUT_MS));
  };

  const handleStopLiveView = (studentId) => {
    webrtc.stopLiveView(studentId, wsRef.current);
    refreshTile(studentId);
    queryClient.invalidateQueries({
      queryKey: [TILE_BATCH_QUERY_ROOTS.screenshots],
      refetchType: 'all',
    });
  };

  // Session-only filtered students (no search filter) - used for class commands
  const sessionFilteredStudents = students.filter((student) => {
    if (effectiveSession && sessionStudentIds.length > 0) {
      if (!sessionStudentIds.includes(student.studentId)) return false;
      if (isStudentOwnedByAnotherClass(student)) return false;
    }
    if (isAdmin && !effectiveSession) {
      return normalizeGrade(student.gradeLevel) === normalizeGrade(selectedGrade);
    }
    return true;
  });

  const matchesStudentSearch = (student) => {
    const query = searchQuery.toLowerCase();
    return (
      (student.studentName || '').toLowerCase().includes(query) ||
      String(student.studentId || '').toLowerCase().includes(query) ||
      (student.studentEmail || '').toLowerCase().includes(query) ||
      (student.gradeLevel || '').toLowerCase().includes(query) ||
      (student.classId ?? '').toLowerCase().includes(query)
    );
  };

  const filteredClassStudents = sessionFilteredStudents
    .filter((student) => {
      const matchesSubgroup = !selectedSubgroupId || subgroupMembers.has(student.studentId);
      return matchesStudentSearch(student) && matchesSubgroup;
    })
    .sort((a, b) => getLastName(a.studentName).localeCompare(getLastName(b.studentName)));
  const filteredAvailableStudents = availablePickupStudents
    .filter(matchesStudentSearch)
    .sort((a, b) => getLastName(a.studentName).localeCompare(getLastName(b.studentName)));
  const filteredScheduledCoverageGroups = scheduledCoverageGroups
    .map((group) => ({
      ...group,
      students: (group.students || [])
        .filter((student) => (
          matchesStudentSearch(student) ||
          (group.label || '').toLowerCase().includes(searchQuery.toLowerCase()) ||
          (group.className || '').toLowerCase().includes(searchQuery.toLowerCase()) ||
          (group.teacherName || '').toLowerCase().includes(searchQuery.toLowerCase())
        ))
        .sort((a, b) => getLastName(a.studentName).localeCompare(getLastName(b.studentName))),
    }))
    .filter((group) => group.students.length > 0)
    .sort((a, b) => (a.className || a.label || "").localeCompare(b.className || b.label || ""));
  const filteredClaimedStudents = claimedPickupStudents
    .filter(matchesStudentSearch)
    .sort((a, b) => getLastName(a.studentName).localeCompare(getLastName(b.studentName)));
  const filteredStudents = studentView === "available"
    ? [...filteredScheduledCoverageGroups.flatMap((group) => group.students), ...filteredAvailableStudents]
    : studentView === "claimed"
      ? filteredClaimedStudents
      : filteredClassStudents;
  const tileStudentIdsKey = JSON.stringify(buildTileStudentIds(
    studentView === "available" ? EMPTY_LIST : filteredStudents
  ));
  const tileBatchRequests = useMemo(
    () => createTileBatchRequests(JSON.parse(tileStudentIdsKey)),
    [tileStudentIdsKey]
  );
  const legacyTileDeviceByStudent = new Map(
    (studentView === "available" ? EMPTY_LIST : filteredStudents)
      .filter((student) => student?.studentId)
      .map((student) => [student.studentId, student.studentId])
  );
  const [screenshotTileRequests, historyTileRequests] = useMemo(() => [
    tileBatchRequests.filter((request) => request.kind === 'screenshots'),
    tileBatchRequests.filter((request) => request.kind === 'history'),
  ], [tileBatchRequests]);
  const screenshotTileQueries = useQueries({
    queries: screenshotTileRequests.map((request) => ({
      queryKey: request.queryKey,
      queryFn: () => fetchTileBatchWithRollbackFallback(
        request,
        legacyTileDeviceByStudent,
        apiRequest
      ),
      select: indexTileScreenshots,
      refetchInterval: request.refetchInterval,
      refetchIntervalInBackground: false,
      retry: false,
      staleTime: 15000,
      gcTime: 60000,
    })),
  });
  const historyTileQueries = useQueries({
    queries: historyTileRequests.map((request) => ({
      queryKey: request.queryKey,
      queryFn: () => fetchTileBatchWithRollbackFallback(
        request,
        legacyTileDeviceByStudent,
        apiRequest
      ),
      select: indexTileHistory,
      refetchInterval: request.refetchInterval,
      refetchIntervalInBackground: false,
      retry: false,
      staleTime: 15000,
      gcTime: 60000,
    })),
  });
  const screenshotsByStudent = useMemo(() => {
    if (screenshotTileQueries.length === 0) return EMPTY_TILE_MAP;
    return new Map(screenshotTileQueries.flatMap((query) => [...(query.data || EMPTY_TILE_MAP)]));
  }, [screenshotTileQueries]);
  const historyByStudent = useMemo(() => {
    if (historyTileQueries.length === 0) return EMPTY_TILE_MAP;
    return new Map(historyTileQueries.flatMap((query) => [...(query.data || EMPTY_TILE_MAP)]));
  }, [historyTileQueries]);
  const failedScreenshotStudentIds = useMemo(() => new Set(
    screenshotTileQueries.flatMap((query, index) => query.isError
      ? screenshotTileRequests[index]?.body.studentIds || EMPTY_LIST
      : EMPTY_LIST)
  ), [screenshotTileQueries, screenshotTileRequests]);
  const failedHistoryStudentIds = useMemo(() => new Set(
    historyTileQueries.flatMap((query, index) => query.isError
      ? historyTileRequests[index]?.body.studentIds || EMPTY_LIST
      : EMPTY_LIST)
  ), [historyTileQueries, historyTileRequests]);

  useEffect(() => {
    if (freshnessTimeoutRef.current) {
      clearTimeout(freshnessTimeoutRef.current);
      freshnessTimeoutRef.current = null;
    }
    const now = new Date().getTime();
    const freshnessStudents = studentView === 'claimed'
      ? claimedPickupStudents
      : studentView === 'available'
        ? [
            ...scheduledCoverageGroups.flatMap((group) => group.students || EMPTY_LIST),
            ...availablePickupStudents,
          ]
        : students;
    const boundary = findNextStudentFreshnessBoundary(
      freshnessStudents,
      screenshotsByStudent,
      freshnessNowMs,
    );
    if (boundary === null) return undefined;

    freshnessTimeoutRef.current = setTimeout(() => {
      freshnessTimeoutRef.current = null;
      setFreshnessNowMs(Date.now());
    }, Math.max(0, boundary - now));

    return () => {
      if (freshnessTimeoutRef.current) {
        clearTimeout(freshnessTimeoutRef.current);
        freshnessTimeoutRef.current = null;
      }
    };
  }, [availablePickupStudents, claimedPickupStudents, freshnessNowMs, scheduledCoverageGroups, screenshotsByStudent, studentView, students]);

  const controllableStudents = filteredStudents.filter(isStudentCommandable);
  const selectableStudents = studentView === "class" ? controllableStudents : filteredStudents;

  const statsStudents = studentView === "class" ? sessionFilteredStudents : filteredStudents;
  const statsMonitoringDisplays = statsStudents.map((student) => (
    deriveStudentMonitoringDisplay(student, freshnessNowMs)
  ));
  const onlineCount = statsMonitoringDisplays.filter((display) => display.kind === 'online').length;
  const idleCount = statsMonitoringDisplays.filter((display) => display.kind === 'idle').length;
  const offlineCount = statsMonitoringDisplays.filter((display) => display.kind === 'signed_out').length;
  const offTaskCount = statsStudents.filter(isStudentOffTask).length;

  const isConnectedStudent = (student) => {
    const display = deriveStudentMonitoringDisplay(student, freshnessNowMs);
    return display.kind === 'online' || display.kind === 'idle';
  };

  const getStudentsForCommandTarget = (overrideStudentIds = null) => {
    const overrideSet = overrideStudentIds ? new Set(overrideStudentIds) : null;
    const commandableSessionStudents = sessionFilteredStudents.filter(isStudentCommandable);
    if (overrideSet) return commandableSessionStudents.filter((student) => overrideSet.has(student.studentId));
    if (selectedStudentIds.size > 0) return commandableSessionStudents.filter((student) => selectedStudentIds.has(student.studentId));
    if (selectedSubgroupId) return commandableSessionStudents.filter((student) => subgroupMembers.has(student.studentId));
    return commandableSessionStudents;
  };

  const getClaimedStudentsForCommandTarget = (overrideStudentIds = null) => {
    const overrideSet = overrideStudentIds ? new Set(overrideStudentIds) : null;
    if (overrideSet) return claimedPickupStudents.filter((student) => overrideSet.has(student.studentId));
    if (selectedStudentIds.size > 0) return claimedPickupStudents.filter((student) => selectedStudentIds.has(student.studentId));
    return filteredClaimedStudents.length > 0 ? filteredClaimedStudents : claimedPickupStudents;
  };

  const getActiveCommandStudents = (overrideStudentIds = null) => (
    studentView === "claimed"
      ? getClaimedStudentsForCommandTarget(overrideStudentIds)
      : getStudentsForCommandTarget(overrideStudentIds)
  );

  const targetStudents = studentView === "available" ? filteredStudents : getActiveCommandStudents();
  const connectedTargetCount = targetStudents.filter(isConnectedStudent).length;
  const unavailableTargetCount = Math.max(0, targetStudents.length - connectedTargetCount);
  const activeClassName = studentView === "available"
    ? "Available"
    : studentView === "claimed"
      ? "Claimed"
      : groups.find(g => g.id === effectiveSession?.groupId)?.name || (effectiveSession ? "Active Class" : "Class");
  const subgroupName = selectedSubgroupId ? subgroups.find(s => s.id === selectedSubgroupId)?.name : null;
  const targetBannerLabel = selectedStudentIds.size > 0
    ? `${targetStudents.length} selected ${studentView === "class" ? "controllable " : ""}student${targetStudents.length === 1 ? "" : "s"}`
    : selectedSubgroupId && studentView === "class"
      ? `${subgroupName || "Subgroup"} - ${targetStudents.length} student${targetStudents.length === 1 ? "" : "s"}`
      : `All ${targetStudents.length} student${targetStudents.length === 1 ? "" : "s"}`;
  const targetConnectionLabel = `${connectedTargetCount} connected · ${unavailableTargetCount} not signed in`;
  const selectedSignOutStudents = studentView === "class"
    ? getStudentsForCommandTarget(Array.from(selectedStudentIds))
    : [];
  const signOutSelectedCount = selectedSignOutStudents.length;
  const canSignOutSelectedStudents = studentView === "class" && !!effectiveSession?.id && signOutSelectedCount > 0;
  const canShowStudentWorkspace = isAdmin || (isTeacher && (activeSession || studentView !== "class"));
  const canUseRemoteControls = studentView === "claimed" || ((isTeacher && activeSession) || (isAdmin && isAdminTeaching));
  const claimedContextCount = new Set(claimedPickupStudents.map((student) => student.contextId).filter(Boolean)).size;
  const selectedAvailableStudents = filteredStudents.filter((student) => selectedStudentIds.has(student.studentId));
  const availableGroupSections = (() => {
    const sections = new Map();
    filteredAvailableStudents.forEach((student) => {
      const group = student.matchingGroups?.[0] || null;
      const scope = group ? null : student.matchingScopes?.[0] || null;
      const key = group ? `group:${group.id}` : scope ? `scope:${scope.id}` : "scope:available";
      if (!sections.has(key)) {
        sections.set(key, {
          id: key,
          kind: group ? "group" : "scope",
          label: group?.name || scope?.name || "Available students",
          description: group?.description || (scope?.scopeType ? "Direct supervision permission" : "Eligible online students"),
          students: [],
        });
      }
      sections.get(key).students.push(student);
    });
    return Array.from(sections.values())
      .map((section) => ({
        ...section,
        students: section.students.sort((a, b) => getLastName(a.studentName).localeCompare(getLastName(b.studentName))),
      }))
      .sort((a, b) => a.label.localeCompare(b.label));
  })();

  const commandStudentIdsFromRequest = (request) => {
    if (request.targetScope === "students") return request.targetStudentIds || [];
    if (request.targetScope === "subgroup") return getStudentsForCommandTarget().map((student) => student.studentId);
    return getStudentsForCommandTarget().map((student) => student.studentId);
  };

  const buildCommandRequest = (commandType, commandPayload = {}, options = {}) => {
    if (!effectiveSession?.id) {
      throw new Error("Start or select an active class session before sending classroom commands.");
    }
    const overrideStudentIds = options.studentIds
      ? [...new Set(options.studentIds.map(String).filter(Boolean))]
      : null;
    const request = {
      teachingSessionId: effectiveSession.id,
      targetScope: "class",
      commandType,
      commandPayload,
    };
    if (overrideStudentIds) {
      if (overrideStudentIds.length === 0) throw new Error("Select at least one student.");
      request.targetScope = "students";
      request.targetStudentIds = overrideStudentIds;
    } else if (selectedStudentIds.size > 0) {
      const selectedCommandStudentIds = getStudentsForCommandTarget().map((student) => student.studentId);
      if (selectedCommandStudentIds.length === 0) {
        throw new Error("No controllable students are selected.");
      }
      request.targetScope = "students";
      request.targetStudentIds = selectedCommandStudentIds;
    } else if (selectedSubgroupId) {
      request.targetScope = "subgroup";
      request.subgroupId = selectedSubgroupId;
    }
    return request;
  };

  const makeTabKey = (tab) => JSON.stringify({
    studentId: tab.studentId,
    url: tab.url,
  });

  const parseTabKey = (key) => {
    try {
      const parsed = JSON.parse(key);
      if (!parsed.studentId || !parsed.url) return null;
      return parsed;
    } catch {
      return null;
    }
  };

  const manageTabsStudents = getActiveCommandStudents(manageTabsStudentIds);
  const openTabs = manageTabsStudents
    .flatMap(s => {
      if (!deriveStudentMonitoringDisplay(s, freshnessNowMs).telemetryCurrent) return [];
      if (s.allOpenTabs && s.allOpenTabs.length > 0) {
        return s.allOpenTabs
          .filter((tab) => tab.url && !tab.url.startsWith('chrome://'))
          .map((tab) => ({ url: tab.url, title: tab.title || 'Untitled', studentName: s.studentName, studentId: s.studentId, active: tab.url === s.activeTabUrl }));
      } else if (s.activeTabUrl && s.activeTabUrl.trim() && !s.activeTabUrl.startsWith('chrome://')) {
        return [{ url: s.activeTabUrl, title: s.activeTabTitle || 'Untitled', studentName: s.studentName, studentId: s.studentId, active: true }];
      }
      return [];
    })
    .sort((a, b) => a.studentName.localeCompare(b.studentName) || a.title.localeCompare(b.title));

  const openTabsByStudent = openTabs.reduce((groups, tab) => {
    const key = tab.studentId;
    if (!groups[key]) groups[key] = { studentId: tab.studentId, studentName: tab.studentName, tabs: [] };
    groups[key].tabs.push(tab);
    return groups;
  }, {});
  const manageTabsTargetLabel = manageTabsStudentIds?.length === 1
    ? (students.find((student) => student.studentId === manageTabsStudentIds[0])?.studentName || "Selected student")
    : targetBannerLabel;

  // Check for blocked domain violations
  useEffect(() => {
    if (!settings?.blockedDomains || settings.blockedDomains.length === 0) return;
    students.forEach((student) => {
      const studentId = student.studentId;
      if (!deriveStudentMonitoringDisplay(student, freshnessNowMs).telemetryCurrent || !student.activeTabUrl) {
        const keysToDelete = Array.from(notifiedViolations.current).filter(key => key.startsWith(studentId + '-'));
        keysToDelete.forEach(key => notifiedViolations.current.delete(key));
        return;
      }
      const violationKey = `${studentId}-${student.activeTabUrl}`;
      const isBlocked = settings.blockedDomains.some(blocked => {
        try {
          const hostname = new URL(student.activeTabUrl).hostname.toLowerCase();
          const blockedLower = blocked.toLowerCase().trim();
          return hostname === blockedLower || hostname.endsWith('.' + blockedLower);
        } catch { return false; }
      });
      if (isBlocked) {
        if (!notifiedViolations.current.has(violationKey)) {
          toast({ variant: "destructive", title: "Blocked Domain Accessed", description: `${student.studentName} is accessing a blocked domain: ${student.activeTabUrl}` });
          notifiedViolations.current.add(violationKey);
        }
      } else {
        const keysToDelete = Array.from(notifiedViolations.current).filter(key => key.startsWith(studentId + '-'));
        keysToDelete.forEach(key => notifiedViolations.current.delete(key));
      }
    });
  }, [freshnessNowMs, students, settings, toast]);

  useEffect(() => {
    const hasAttention = activeClassroomStates.some((state) => state.stateType === 'attention');
    setAttentionActive(hasAttention);
  }, [activeClassroomStates]);

  const performLogout = async () => {
    setLogoutPending(true);
    await logout();
    window.location.replace("/login");
  };

  const requestLogout = () => {
    if (activeSession) {
      setShowLogoutDialog(true);
      return;
    }
    void performLogout();
  };

  const updateGradesMutation = useMutation({
    mutationFn: async (gradeLevels) => {
      if (!settings) throw new Error("Settings not loaded");
      const payload = {
        schoolId: settings.schoolId, schoolName: settings.schoolName, wsSharedKey: settings.wsSharedKey,
        retentionHours: settings.retentionHours, blockedDomains: settings.blockedDomains || [],
        allowedDomains: settings.allowedDomains || [], ipAllowlist: settings.ipAllowlist || [], gradeLevels,
      };
      return apiRequest('POST', '/settings', payload);
    },
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ['/api/settings'] }); toast({ title: "Success", description: "Grade levels updated successfully" }); },
    onError: (error) => { toast({ variant: "destructive", title: "Error", description: error.message }); },
  });

  const handleAddGrade = () => {
    if (!newGrade.trim()) { toast({ variant: "destructive", title: "Invalid Grade", description: "Please enter a grade level" }); return; }
    const currentGrades = settings?.gradeLevels || [];
    if (currentGrades.includes(newGrade.trim())) { toast({ variant: "destructive", title: "Duplicate Grade", description: "This grade level already exists" }); return; }
    updateGradesMutation.mutate([...currentGrades, newGrade.trim()]);
    setNewGrade("");
  };

  const handleDeleteGrade = (grade) => {
    const currentGrades = settings?.gradeLevels || [];
    if (currentGrades.length <= 1) { toast({ variant: "destructive", title: "Cannot Delete", description: "You must have at least one grade level" }); return; }
    updateGradesMutation.mutate(currentGrades.filter(g => g !== grade));
  };

  const startSessionMutation = useMutation({
    mutationFn: async (request) => {
      const payload = typeof request === "string" ? { groupId: request } : request;
      return apiRequest('POST', '/sessions/start', payload);
    },
    onSuccess: (data, variables) => {
      queryClient.invalidateQueries({ queryKey: ['/api/sessions/active'], exact: false });
      queryClient.invalidateQueries({ queryKey: ['/api/students-aggregated'] });
      queryClient.invalidateQueries({ queryKey: ['/api/groups'], exact: false });
      queryClient.invalidateQueries({ queryKey: ['/api/teacher/groups'], exact: false });
      setClassStartOverlap(null);
      const request = typeof variables === "string" ? { groupId: variables } : variables;
      const group = groups.find(g => g.id === (data.session?.groupId || data.groupId));
      toast({
        title: "Class Started",
        description: request?.acknowledgeOverlap
          ? "Class started. Control moved for students who were active elsewhere."
          : `Now teaching: ${group?.name || 'Unknown Class'}`,
      });
    },
    onError: (error, variables) => {
      const data = classStartOverlapData(error);
      if (data) {
        const request = typeof variables === "string" ? { groupId: variables } : variables;
        setClassStartOverlap({ ...data, request });
        return;
      }
      toast({ variant: "destructive", title: "Cannot Start Class", description: error.response?.data?.error || error.message });
    },
  });

  const endSessionMutation = useMutation({
    mutationFn: async ({ session }) => {
      if (!session?.id) throw new Error("No active class session was found.");
      return apiRequest(
        'POST',
        `/classpilot/teaching-sessions/${encodeURIComponent(session.id)}/end`,
        {},
      );
    },
    onSuccess: (data, variables) => {
      queryClient.invalidateQueries({ queryKey: ['/api/sessions/active'], exact: false });
      queryClient.invalidateQueries({ queryKey: ['/api/students-aggregated'] });
      queryClient.invalidateQueries({ queryKey: ['/api/groups'], exact: false });
      queryClient.invalidateQueries({ queryKey: ['/api/teacher/groups'], exact: false });
      setEndClassTarget(null);
      if (variables?.session?.id) {
        setSessionReportTarget({
          id: variables.session.id,
          name: variables.session.classNameSnapshot
            || groups.find((group) => group.id === variables.session.groupId)?.name
            || 'Class',
        });
      }
      toast({
        title: "Class Ended",
        description: sessionEndToastDescription(data, isScheduledTeachingSession(variables?.session)),
      });
    },
    onError: (error) => {
      toast({
        variant: "destructive",
        title: "Could not end class",
        description: error.response?.data?.error || error.message,
      });
    },
  });

  const resyncSessionMutation = useMutation({
    mutationFn: async ({ sessionId, acknowledgeOverlap = false }) => (
      apiRequest('POST', `/sessions/${encodeURIComponent(sessionId)}/resync`, { acknowledgeOverlap })
    ),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['/api/sessions/active'], exact: false });
      queryClient.invalidateQueries({ queryKey: ['/api/sessions/all'] });
      queryClient.invalidateQueries({ queryKey: ['/api/students-aggregated'] });
      queryClient.invalidateQueries({ queryKey: ['/api/groups'], exact: false });
      queryClient.invalidateQueries({ queryKey: ['/api/teacher/groups'], exact: false });
      queryClient.invalidateQueries({ queryKey: ['/api/coverage/available-students'] });
      queryClient.invalidateQueries({ queryKey: ['/api/coverage/claimed-students'] });
      queryClient.invalidateQueries({ queryKey: ['/api/coverage/reroute-targets'] });
      setClassResyncOverlap(null);
      toast({ title: "Class resynced", description: resyncSummaryText(data) });
    },
    onError: (error, variables) => {
      const data = classResyncOverlapData(error);
      if (data) {
        setClassResyncOverlap({ ...data, request: variables });
        return;
      }
      toast({ variant: "destructive", title: "Could not resync class", description: error.response?.data?.error || error.message });
    },
  });

  const startScheduledConflictMutation = useMutation({
    mutationFn: async (conflictId) => apiRequest('POST', `/classpilot/scheduled-conflicts/${encodeURIComponent(conflictId)}/start-anyway`, {}),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/classpilot/scheduled-conflicts'] });
      queryClient.invalidateQueries({ queryKey: ['/api/sessions/active'], exact: false });
      queryClient.invalidateQueries({ queryKey: ['/api/students-aggregated'] });
      queryClient.invalidateQueries({ queryKey: ['/api/groups'], exact: false });
      queryClient.invalidateQueries({ queryKey: ['/api/teacher/groups'], exact: false });
      toast({ title: "Class Started", description: "Scheduled class started. Temporary scheduled coverage was released." });
    },
    onError: (error) => {
      if (error.response?.data?.code === "SCHEDULED_CONFLICT_EXPIRED") {
        queryClient.invalidateQueries({ queryKey: ['/api/classpilot/scheduled-conflicts'] });
        queryClient.invalidateQueries({ queryKey: ['/api/coverage/available-students'] });
        queryClient.invalidateQueries({ queryKey: ['/api/coverage/claimed-students'] });
        queryClient.invalidateQueries({ queryKey: ['/api/coverage/contexts'] });
        toast({
          title: "Scheduled block ended",
          description: "This scheduled block has ended. Students will move with the next class or become available again.",
        });
        return;
      }
      toast({ variant: "destructive", title: "Could not start scheduled class", description: error.response?.data?.error || error.message });
    },
  });

  const skipScheduledConflictMutation = useMutation({
    mutationFn: async (conflictId) => apiRequest('POST', `/classpilot/scheduled-conflicts/${encodeURIComponent(conflictId)}/skip`, {}),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/classpilot/scheduled-conflicts'] });
      toast({ title: "Scheduled Class Skipped", description: "This scheduled class will not auto-start again today." });
    },
    onError: (error) => {
      toast({ variant: "destructive", title: "Could not skip scheduled class", description: error.response?.data?.error || error.message });
    },
  });

  const skipScheduledClassMutation = useMutation({
    mutationFn: async (groupId) => (
      apiRequest('POST', `/classpilot/scheduled-classes/${encodeURIComponent(groupId)}/skip-today`, {})
    ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/groups'], exact: false });
      queryClient.invalidateQueries({ queryKey: ['/api/teacher/groups'], exact: false });
      queryClient.invalidateQueries({ queryKey: ['/api/classpilot/scheduled-conflicts'] });
      setSkipTodayGroup(null);
      toast({
        title: "Scheduled Class Skipped",
        description: "Today’s automatic class was canceled. No Session Summary will be sent.",
      });
    },
    onError: (error) => {
      setSkipTodayGroup(null);
      toast({
        variant: "destructive",
        title: "Could not skip scheduled class",
        description: error.response?.data?.error || error.message,
      });
    },
  });

  const claimPickupMutation = useMutation({
    mutationFn: async ({ students: studentsToClaim }) => {
      const byScheduled = studentsToClaim.reduce((map, student) => {
        const scheduled = student.matchingScheduledCoverage;
        if (!scheduled?.id) return map;
        const rows = map.get(scheduled.id) || [];
        rows.push(student);
        map.set(scheduled.id, rows);
        return map;
      }, new Map());
      const byGroup = studentsToClaim.reduce((map, student) => {
        if (student.matchingScheduledCoverage?.id) return map;
        const group = student.matchingGroups?.[0];
        if (!group?.id) return map;
        const rows = map.get(group.id) || [];
        rows.push(student);
        map.set(group.id, rows);
        return map;
      }, new Map());
      const directScopeStudents = studentsToClaim.filter((student) => !student.matchingScheduledCoverage?.id && !(student.matchingGroups || []).length);
      if (byScheduled.size === 0 && byGroup.size === 0 && directScopeStudents.length === 0) {
        throw new Error("No supervision permission is available for the selected students.");
      }
      const requests = Array.from(byScheduled.entries()).map(([scheduledConflictId, rows]) =>
        apiRequest('POST', '/coverage/claim', {
          scheduledConflictId,
          studentIds: rows.map((student) => student.studentId),
        })
      );
      requests.push(...Array.from(byGroup.entries()).map(([supervisionGroupId, rows]) =>
        apiRequest('POST', '/coverage/claim', {
          supervisionGroupId,
          studentIds: rows.map((student) => student.studentId),
        })
      ));
      if (directScopeStudents.length > 0) {
        requests.push(apiRequest('POST', '/coverage/claim', {
          studentIds: directScopeStudents.map((student) => student.studentId),
        }));
      }
      return Promise.all(requests);
    },
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: ['/api/coverage/available-students'] });
      queryClient.invalidateQueries({ queryKey: ['/api/coverage/claimed-students'] });
      queryClient.invalidateQueries({ queryKey: ['/api/coverage/contexts'] });
      queryClient.invalidateQueries({ queryKey: ['/api/students-aggregated'] });
      clearSelection();
      setStudentView("claimed");
      const isQuickClaim = variables?.quickClaimStudentId && variables?.students?.length === 1;
      toast({
        title: isQuickClaim ? "Student claimed" : "Students claimed",
        description: isQuickClaim ? "The student is now in your claimed view." : "They are now in your claimed view.",
      });
    },
    onError: (error) => {
      if (error.response?.data?.code === "SCHEDULED_CONFLICT_EXPIRED") {
        queryClient.invalidateQueries({ queryKey: ['/api/classpilot/scheduled-conflicts'] });
        queryClient.invalidateQueries({ queryKey: ['/api/coverage/available-students'] });
        queryClient.invalidateQueries({ queryKey: ['/api/coverage/claimed-students'] });
        queryClient.invalidateQueries({ queryKey: ['/api/coverage/contexts'] });
        toast({
          title: "Scheduled block ended",
          description: "This scheduled block has ended. Students will move with the next class or become available again.",
        });
        return;
      }
      toast({ variant: "destructive", title: "Could not claim students", description: error.response?.data?.error || error.message });
    },
    onSettled: () => {
      setQuickClaimStudentId(null);
    },
  });

  const rerouteMutation = useMutation({
    mutationFn: async ({ targetId, studentIds, note }) => {
      const target = rerouteCoverageTargets.find((entry) => entry.id === targetId);
      if (!target) throw new Error("Choose where to send these students.");
      return apiRequest('POST', '/coverage/send', {
        supervisionGroupId: target.supervisionGroupId,
        assignedStaffId: target.assignedStaffId,
        studentIds,
        note,
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/students-aggregated'] });
      queryClient.invalidateQueries({ queryKey: ['/api/coverage/contexts'] });
      queryClient.invalidateQueries({ queryKey: ['/api/coverage/reroute-targets'] });
      queryClient.invalidateQueries({ queryKey: ['/api/coverage/available-students'] });
      queryClient.invalidateQueries({ queryKey: ['/api/coverage/claimed-students'] });
      setShowRerouteDialog(false);
      setSelectedCoverageContextId("");
      setRerouteNote("");
      clearSelection();
      toast({ title: "Students sent", description: "Selected students were assigned to supervision." });
    },
    onError: (error) => {
      toast({ variant: "destructive", title: "Could not send students", description: error.response?.data?.error || error.message });
    },
  });

  const returnToClassMutation = useMutation({
    mutationFn: async ({ studentIds }) => apiRequest('POST', '/coverage/return-to-class', { studentIds }),
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: ['/api/students-aggregated'] });
      queryClient.invalidateQueries({ queryKey: ['/api/coverage/available-students'] });
      queryClient.invalidateQueries({ queryKey: ['/api/coverage/claimed-students'] });
      queryClient.invalidateQueries({ queryKey: ['/api/coverage/contexts'] });
      setSelectedStudentIds((prev) => {
        const next = new Set(prev);
        (variables?.studentIds || []).forEach((studentId) => next.delete(studentId));
        return next;
      });
      toast({ title: "Returned to class", description: "The student can now be monitored in this class session." });
    },
    onError: (error) => {
      toast({ variant: "destructive", title: "Could not return student", description: error.response?.data?.error || error.message });
    },
  });

  const handleClaimStudents = (studentsToClaim, options = {}) => {
    if (!studentsToClaim.length) {
      toast({ variant: "destructive", title: "Select students first" });
      return;
    }
    setQuickClaimStudentId(options.quickClaimStudentId || null);
    claimPickupMutation.mutate({ students: studentsToClaim, quickClaimStudentId: options.quickClaimStudentId || null });
  };

  const handleRerouteSelected = () => {
    const studentIds = Array.from(selectedStudentIds);
    if (studentIds.length === 0) {
      toast({ variant: "destructive", title: "Select students first" });
      return;
    }
    if (!selectedCoverageContextId) {
      toast({ variant: "destructive", title: "Choose where to send them" });
      return;
    }
    rerouteMutation.mutate({ targetId: selectedCoverageContextId, studentIds, note: rerouteNote.trim() });
  };

  const handleReturnToClass = (student) => {
    if (!activeSession) {
      toast({ variant: "destructive", title: "Start a class first", description: "Only an active class teacher can return a student from supervision." });
      return;
    }
    returnToClassMutation.mutate({ studentIds: [student.studentId] });
  };

  const stopImpersonateMutation = useMutation({
    mutationFn: async () => apiRequest('POST', '/super-admin/stop-impersonate', {}),
    onSuccess: () => {
      toast({ title: "Stopped Impersonating", description: "Returned to your super admin account" });
      setTimeout(() => { window.location.href = "/super-admin/schools"; }, 500);
    },
    onError: (error) => { toast({ variant: "destructive", title: "Error", description: error.message }); },
  });

  const refreshScreenshotsForDevices = () => {
    // Keep action feedback responsive without restoring per-device fan-out.
    // Each refresh is a single cohort request regardless of class size.
    for (const delay of [1000, 2000, 3000, 5000, 8000]) {
      setTimeout(() => {
        queryClient.invalidateQueries({
          queryKey: [TILE_BATCH_QUERY_ROOTS.screenshots],
          refetchType: 'all',
        });
      }, delay);
    }
  };

  const decorateCommandResponse = (data, commandType) => {
    const tracked = trackTransientCommandResponse(
      transientCommandOutcomesRef.current,
      data,
      commandType,
    );
    if (tracked !== transientCommandOutcomesRef.current) {
      transientCommandOutcomesRef.current = tracked;
      setTransientPendingControls(pendingTransientControls(tracked));
      setTransientCommandVersion((version) => version + 1);
    }
    const deliveryFeedback = commandDeliveryFeedback(data, commandType);
    return {
      ...data,
      deliveryFeedback,
      message: deliveryFeedback.description,
    };
  };

  const postClassroomCommand = async (commandType, commandPayload, options = {}) => {
    const request = buildCommandRequest(commandType, commandPayload, options);
    const data = await apiRequest('POST', '/commands', request);
    const targetStudentIds = commandStudentIdsFromRequest(request);
    return decorateCommandResponse({
      ...data,
      request,
      targetStudentIds,
    }, commandType);
  };

  const postClaimedCommand = async (commandType, commandPayload, options = {}) => {
    const targetStudents = getClaimedStudentsForCommandTarget(options.studentIds);
    if (targetStudents.length === 0) throw new Error("Select at least one claimed student.");
    const byContext = targetStudents.reduce((map, student) => {
      if (!student.contextId) return map;
      const rows = map.get(student.contextId) || [];
      rows.push(student);
      map.set(student.contextId, rows);
      return map;
    }, new Map());
    if (byContext.size === 0) throw new Error("Selected students are missing a claimed group.");
    const rawResults = await Promise.all(Array.from(byContext.entries()).map(([contextId, rows]) =>
      apiRequest('POST', `/coverage/contexts/${contextId}/commands`, {
        targetScope: "students",
        targetStudentIds: rows.map((student) => student.studentId),
        commandType,
        commandPayload,
      })
    ));
    const results = rawResults.map((result) => decorateCommandResponse(result, commandType));
    const targets = results.flatMap((result) => result?.command?.targets || []);
    const targetStudentIds = targetStudents.map((student) => student.studentId);
    const aggregateKeys = ['requested', 'attempted', 'acknowledged', 'completed', 'pending', 'expired', 'failed', 'unavailable', 'sent', 'received', 'awaitingAck'];
    const summary = Object.fromEntries(aggregateKeys.map((key) => [
      key,
      results.reduce((total, result) => total + Number(result?.summary?.[key] || 0), 0),
    ]));
    return decorateCommandResponse({
      command: {
        commandType,
        deliveryPolicy: results[0]?.command?.deliveryPolicy || results[0]?.deliveryPolicy,
        expiresAt: results.map((result) => result?.command?.expiresAt || result?.expiresAt).filter(Boolean).sort()[0],
        targets,
      },
      summary: {
        ...summary,
        requested: summary.requested || targets.length,
      },
      targetStudentIds,
    }, commandType);
  };

  const postActiveCommand = (commandType, commandPayload, options = {}) => (
    studentView === "claimed"
      ? postClaimedCommand(commandType, commandPayload, options)
      : postClassroomCommand(commandType, commandPayload, options)
  );

  const openTabMutation = useMutation({
    mutationFn: async ({ url }) => postActiveCommand('open-tab', { url }),
    onSuccess: (data, variables) => {
      toast(data.deliveryFeedback); setShowOpenTabDialog(false);
      // Auto-allow the opened domain so it's not flagged as off-task
      try { const d = new URL(variables.url).hostname.toLowerCase().replace(/^www\./, ''); handleAllowDomain(d); } catch { /* ignore invalid URL */ }
      setOpenTabUrl(""); refreshScreenshotsForDevices();
    },
    onError: (error) => { toast({ variant: "destructive", title: "Error", description: error.message }); },
  });

  const closeTabsMutation = useMutation({
    mutationFn: async ({ closeAll, pattern, specificUrls, tabsToClose, studentIds }) => {
      const payload = { closeAll, pattern, specificUrls, tabsToClose };
      return postActiveCommand('close-tabs', payload, { studentIds });
    },
    onSuccess: (data) => {
      toast(data.deliveryFeedback);
      setShowCloseTabsDialog(false);
      setSelectedTabsToClose(new Set());
      setManageTabsStudentIds(null);
      refreshScreenshotsForDevices();
    },
    onError: (error) => { toast({ variant: "destructive", title: "Error", description: error.message }); },
  });

  const lockScreenMutation = useMutation({
    mutationFn: async ({ url }) => postActiveCommand('lock-screen', { url }),
    onSuccess: (data) => {
      toast(data.deliveryFeedback);
      refreshScreenshotsForDevices();
    },
    onError: (error) => {
      toast({ variant: "destructive", title: "Error", description: error.message });
    },
  });

  const unlockScreenMutation = useMutation({
    mutationFn: async ({ studentIds } = {}) => postActiveCommand('unlock-screen', {}, { studentIds }),
    onSuccess: (data) => {
      toast(data.deliveryFeedback);
      refreshScreenshotsForDevices();
    },
    onError: (error) => {
      toast({ variant: "destructive", title: "Error", description: error.message });
    },
  });

  const handleOpenTab = () => {
    if (!openTabUrl.trim()) { toast({ variant: "destructive", title: "Invalid URL", description: "Please enter a valid URL" }); return; }
    let normalizedUrl = openTabUrl.trim();
    if (!normalizedUrl.match(/^https?:\/\//i)) normalizedUrl = 'https://' + normalizedUrl;
    openTabMutation.mutate({ url: normalizedUrl });
  };

  const handleCloseTabs = () => {
    if (selectedTabsToClose.size === 0) { toast({ variant: "destructive", title: "No Tabs Selected", description: "Please select at least one tab to close" }); return; }
    const tabsToClose = [];
    selectedTabsToClose.forEach(compositeKey => {
      const parsed = parseTabKey(compositeKey);
      if (parsed) tabsToClose.push(parsed);
    });
    closeTabsMutation.mutate({
      tabsToClose,
      studentIds: [...new Set(tabsToClose.map((tab) => tab.studentId))],
    });
    setSelectedTabsToClose(new Set());
  };

  const handleCloseSingleTab = (tab) => {
    closeTabsMutation.mutate({
      tabsToClose: [tab],
      studentIds: [tab.studentId],
    });
  };

  const handleLockScreen = () => {
    lockScreenMutation.mutate({ url: "CURRENT_URL" });
  };

  const handleLockToUrl = () => {
    if (!lockUrl.trim()) { toast({ variant: "destructive", title: "Invalid URL", description: "Please enter a valid URL" }); return; }
    let normalizedUrl = lockUrl.trim();
    if (!normalizedUrl.match(/^https?:\/\//i)) normalizedUrl = 'https://' + normalizedUrl;
    lockScreenMutation.mutate({ url: normalizedUrl });
    setShowLockUrlDialog(false);
    setLockUrl("");
  };

  const handleUnlockScreen = () => {
    unlockScreenMutation.mutate({});
  };

  const openManageTabs = (studentIds = null) => {
    setManageTabsStudentIds(studentIds);
    setSelectedTabsToClose(new Set());
    setShowCloseTabsDialog(true);
  };

  const applyFlightPathMutation = useMutation({
    mutationFn: async ({ flightPathId, allowedDomains, flightPathName }) => {
      const data = await postActiveCommand('apply-flight-path', { flightPathId });
      return { ...data, flightPathName, allowedDomains };
    },
    onSuccess: (data, variables) => {
      toast(data.deliveryFeedback);
      setShowApplyFlightPathDialog(false); setSelectedFlightPathId("");
      // Auto-allow all domains in the flight path so they're not flagged as off-task
      (variables.allowedDomains || []).forEach(d => { try { handleAllowDomain(d.toLowerCase().replace(/^www\./, '')); } catch { /* ignore */ } });
      refreshScreenshotsForDevices();
    },
    onError: (error) => {
      toast({ variant: "destructive", title: "Error", description: error.message });
    },
  });

  const removeFlightPathMutation = useMutation({
    mutationFn: async ({ studentIds } = {}) => postClassroomCommand('remove-flight-path', {}, { studentIds }),
    onSuccess: (data) => {
      toast(data.deliveryFeedback);
      refreshScreenshotsForDevices();
    },
    onError: (error) => {
      toast({ variant: "destructive", title: "Error", description: error.message });
    },
  });

  const handleApplyFlightPath = () => {
    if (!selectedFlightPathId) { toast({ variant: "destructive", title: "No Flight Path Selected", description: "Please select a flight path to apply" }); return; }
    const flightPath = flightPaths.find(fp => fp.id === selectedFlightPathId);
    if (!flightPath) { toast({ variant: "destructive", title: "Error", description: "Selected flight path not found" }); return; }
    applyFlightPathMutation.mutate({ flightPathId: flightPath.id, allowedDomains: flightPath.allowedDomains || [], flightPathName: flightPath.flightPathName });
  };

  const handleRemoveFlightPath = (studentId) => { removeFlightPathMutation.mutate({ studentIds: [studentId] }); };

  const applyBlockListMutation = useMutation({
    mutationFn: async ({ blockListId }) => postActiveCommand('apply-block-list', { blockListId }),
    onSuccess: (data) => {
      toast(data.deliveryFeedback);
      setShowApplyBlockListDialog(false); setSelectedBlockListId("");
      refreshScreenshotsForDevices();
    },
    onError: (error) => { toast({ variant: "destructive", title: "Error", description: error.message }); },
  });

  const removeBlockListMutation = useMutation({
    mutationFn: async ({ studentIds } = {}) => postClassroomCommand('remove-block-list', {}, { studentIds }),
    onSuccess: (data) => {
      toast(data.deliveryFeedback);
      refreshScreenshotsForDevices();
    },
    onError: (error) => { toast({ variant: "destructive", title: "Error", description: error.message }); },
  });

  const handleApplyBlockList = () => {
    if (!selectedBlockListId) { toast({ variant: "destructive", title: "No Block List Selected", description: "Please select a block list to apply" }); return; }
    applyBlockListMutation.mutate({ blockListId: selectedBlockListId });
  };

  const handleRemoveBlockList = () => { removeBlockListMutation.mutate({}); };

  const attentionModeMutation = useMutation({
    mutationFn: async ({ active, message }) => postClassroomCommand('attention-mode', { active, message }),
    onSuccess: (data, variables) => {
      toast(data.deliveryFeedback);
      queryClient.invalidateQueries({ queryKey: ['/api/commands/active-state', effectiveSession?.id] });
      if (!variables.active) setShowAttentionDialog(false);
      refreshScreenshotsForDevices();
    },
    onError: (error) => { toast({ variant: "destructive", title: "Error", description: error.message }); },
  });

  const timerMutation = useMutation({
    mutationFn: async ({ action, seconds, message }) => postClassroomCommand('timer', { action, seconds, message }),
    onSuccess: (data, variables) => {
      toast(data.deliveryFeedback);
      if (variables.action === 'start') setShowTimerDialog(false);
    },
    onError: (error) => { toast({ variant: "destructive", title: "Error", description: error.message }); },
  });

  const handleAttentionMode = (active) => { attentionModeMutation.mutate({ active, message: attentionMessage }); };

  const handleStartTimer = () => {
    const totalSeconds = (timerMinutes * 60) + timerSeconds;
    if (totalSeconds <= 0) { toast({ variant: "destructive", title: "Invalid Timer", description: "Please set a time greater than 0" }); return; }
    timerMutation.mutate({ action: 'start', seconds: totalSeconds, message: timerMessage });
  };

  const handleStopTimer = () => { timerMutation.mutate({ action: 'stop' }); };

  const pollMutation = useMutation({
    mutationFn: async ({ question, options }) => postClassroomCommand('poll', { action: 'start', question, options }),
    onSuccess: (data) => {
      toast(data.deliveryFeedback);
      setShowPollDialog(false); setPollQuestion(""); setPollOptions(["", ""]);
    },
    onError: (error) => { toast({ variant: "destructive", title: "Error", description: error.message }); },
  });

  const closePollMutation = useMutation({
    mutationFn: async ({ pollId }) => postClassroomCommand('poll', { action: 'close', pollId }),
    onSuccess: (data) => { toast(data.deliveryFeedback); },
    onError: (error) => { toast({ variant: "destructive", title: "Error", description: error.message }); },
  });

  const dismissHandMutation = useMutation({
    mutationFn: async (studentId) => apiRequest('POST', `/teacher/dismiss-hand/${studentId}`, { sessionId: effectiveSession?.id }),
    onSuccess: (_, studentId) => { setRaisedHands(prev => { const newMap = new Map(prev); newMap.delete(studentId); return newMap; }); },
    onError: (error) => { toast({ variant: "destructive", title: "Error", description: error.message }); },
  });

  const replyToMessageMutation = useMutation({
    mutationFn: async ({ sessionId, studentId, message }) => apiRequest('POST', '/teacher/reply', { sessionId, studentId, message }),
    onSuccess: (data, variables) => {
      const reply = data?.message || {};
      setChatReplies(prev => ({
        ...prev,
        [variables.studentId]: [
          ...(prev[variables.studentId] || []),
          {
            id: reply.id,
            message: reply.content || variables.message,
            timestamp: reply.createdAt || new Date().toISOString(),
            status: reply.deliveryStatus || 'sent',
            errorMessage: reply.errorMessage,
          },
        ],
      }));
      toast({
        title: reply.deliveryStatus === 'failed' ? "Reply Not Delivered" : "Reply Queued",
        description: reply.deliveryStatus === 'failed' ? (reply.errorMessage || "No student device was available") : "Waiting for device confirmation",
        variant: reply.deliveryStatus === 'failed' ? "destructive" : undefined,
      });
    },
    onError: (error) => { toast({ variant: "destructive", title: "Error", description: error.message }); },
  });

  const sendMessageMutation = useMutation({
    mutationFn: async ({ message }) => postClassroomCommand('teacher-message', { message }),
    onSuccess: (data) => {
      toast(data.deliveryFeedback);
      setShowSendMessageDialog(false); setSendMessageText("");
    },
    onError: (error) => { toast({ variant: "destructive", title: "Error", description: error.message }); },
  });

  const signOutStudentsMutation = useMutation({
    mutationFn: async () => {
      const studentIds = selectedSignOutStudents.map((student) => student.studentId);
      if (studentIds.length === 0) {
        throw new Error("Select at least one student to sign out.");
      }
      return postClassroomCommand('student-sign-out', { reason: 'teacher_sign_out' }, { studentIds });
    },
    onSuccess: (data) => {
      const signedOutStudentIds = completedStudentIdsFromCommand(data);
      for (const studentId of signedOutStudentIds) {
        webrtc.stopLiveView(studentId);
      }
      queryClient.setQueryData(aggregatedStudentsQueryKey, (old) =>
        Array.isArray(old)
          ? old.map((student) => (
            signedOutStudentIds.has(student.studentId)
              ? {
                ...student,
                status: 'offline',
                loginState: 'not_logged_in',
                isLoggedIn: false,
                activeTabTitle: '',
                activeTabUrl: '',
                allOpenTabs: [],
                isSharing: false,
                cameraActive: false,
              }
              : student
          ))
          : old
      );
      queryClient.invalidateQueries({ queryKey: ['/api/students-aggregated'] });
      setShowSignOutDialog(false);
      clearSelection();
      toast(data.deliveryFeedback);
    },
    onError: (error) => {
      toast({ variant: "destructive", title: "Could Not Sign Out Students", description: error.message });
    },
  });

  const handleSendMessage = () => {
    if (!sendMessageText.trim()) { toast({ variant: "destructive", title: "Empty Message", description: "Please enter a message" }); return; }
    sendMessageMutation.mutate({ message: sendMessageText.trim() });
  };

  const markMessageRead = (messageId) => { setStudentMessages(prev => prev.map(msg => msg.id === messageId ? { ...msg, read: true } : msg)); };

  const dismissMessage = async (messageId) => {
    setStudentMessages(prev => prev.filter(msg => msg.id !== messageId));
    try { await apiRequest('DELETE', `/teacher/messages/${messageId}`); } catch (error) {
      console.error('Failed to delete message from server:', error);
      dismissedMessageIds.current.add(messageId);
      try { const ids = Array.from(dismissedMessageIds.current).slice(-100); localStorage.setItem('classpilot-dismissed-messages', JSON.stringify(ids)); } catch { /* intentionally empty */ }
    }
  };

  const closeChat = async (studentId) => {
    const msg = studentMessages.find(m => m.studentId === studentId);
    setStudentMessages(prev => prev.filter(m => m.studentId !== studentId));
    setChatReplies(prev => { const next = { ...prev }; delete next[studentId]; return next; });
    if (msg) {
      try { await apiRequest('POST', '/teacher/close-chat', { sessionId: effectiveSession?.id, studentId }); } catch (error) {
        console.error('Failed to send close-chat:', error);
      }
    }
  };

  const toggleHandRaisingMutation = useMutation({
    mutationFn: async (enabled) => apiRequest('POST', '/settings/hand-raising', { enabled }),
    onSuccess: (data) => { queryClient.invalidateQueries({ queryKey: ['/api/settings'] }); toast({ title: data.enabled ? "Hand Raising Enabled" : "Hand Raising Disabled", description: data.enabled ? "Students can now raise their hands" : "Students cannot raise their hands" }); },
    onError: (error) => { toast({ variant: "destructive", title: "Error", description: error.message }); },
  });

  const toggleStudentMessagingMutation = useMutation({
    mutationFn: async (enabled) => apiRequest('POST', '/settings/student-messaging', { enabled }),
    onSuccess: (data) => { queryClient.invalidateQueries({ queryKey: ['/api/settings'] }); toast({ title: data.enabled ? "Student Messaging Enabled" : "Student Messaging Disabled", description: data.enabled ? "Students can now send messages" : "Students cannot send messages" }); },
    onError: (error) => { toast({ variant: "destructive", title: "Error", description: error.message }); },
  });

  // Poll result reads start only after the device-reported ACK activates the
  // poll. Clearing activePoll on an acknowledged close tears the interval down.
  useEffect(() => {
    const pollId = activePoll?.id;
    if (!pollId) return undefined;
    let cancelled = false;

    const fetchPollResults = async () => {
      try {
        const data = await apiRequest('GET', `/polls/${pollId}/results`);
        if (cancelled) return;
        setPollResults(data.results || []);
        setPollTotalResponses(data.totalResponses || 0);
      } catch (err) {
        if (!cancelled) console.error('Error fetching poll results:', err);
      }
    };

    void fetchPollResults();
    const interval = setInterval(fetchPollResults, 2000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [activePoll?.id]);

  // Fetch subgroup members when subgroup is selected
  useEffect(() => {
    if (selectedSubgroupId) {
      apiRequest('GET', `/subgroups/${selectedSubgroupId}/members`)
        .then(data => { setSubgroupMembers(new Set((data.members || []).map(m => m.studentId || m))); })
        .catch(err => { console.error('Error fetching subgroup members:', err); setSubgroupMembers(new Set()); });
    } else { setSubgroupMembers(new Set()); }
  }, [selectedSubgroupId]);

  const handleCreatePoll = () => {
    const validOptions = pollOptions.filter(opt => opt.trim() !== '');
    if (!pollQuestion.trim()) { toast({ variant: "destructive", title: "Invalid Poll", description: "Please enter a question" }); return; }
    if (validOptions.length < 2) { toast({ variant: "destructive", title: "Invalid Poll", description: "Please enter at least 2 options" }); return; }
    pollMutation.mutate({ question: pollQuestion.trim(), options: validOptions });
  };

  const handleClosePoll = () => {
    if (!activePoll) return;
    closePollMutation.mutate({ pollId: activePoll.id });
  };

  const timerDeliveryPending = transientPendingControls.timer;
  const pollDeliveryPending = transientPendingControls.poll;

  const addPollOption = () => { if (pollOptions.length < 5) setPollOptions([...pollOptions, ""]); };
  const removePollOption = (index) => { if (pollOptions.length > 2) setPollOptions(pollOptions.filter((_, i) => i !== index)); };
  const updatePollOption = (index, value) => { const newOptions = [...pollOptions]; newOptions[index] = value; setPollOptions(newOptions); };

  return (
    <div className="min-h-screen">
      {/* Header */}
      <header className="sticky top-0 z-40 bg-slate-900 border-b border-slate-700 relative">
        <div className="absolute top-0 left-0 right-0 h-0.5 bg-gradient-to-r from-amber-400 to-amber-500" />
        <div className="max-w-screen-2xl mx-auto px-6 py-3">
          <div className="flex items-center justify-between gap-4">
            {/* Left: Logo & School */}
            <div className="flex items-center gap-3">
              <svg width="40" height="40" viewBox="0 0 48 48" fill="none" className="rounded-xl shadow-lg">
                <rect width="48" height="48" rx="12" fill="#fbbf24"/>
                <path d="M12 24L36 14L30 36L24 28L36 14" stroke="#0f172a" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"/>
                <path d="M24 28L26 34" stroke="#0f172a" strokeWidth="2.5" strokeLinecap="round"/>
              </svg>
              <div>
                <h1 className="text-lg font-bold text-slate-100 tracking-tight">ClassPilot</h1>
                <p className="text-xs text-slate-400">
                  {currentUser?.schoolName && <span className="font-medium">{currentUser.schoolName}</span>}
                  {currentUser?.schoolName && ' \u2022 '}
                  {isAdmin ? 'Admin Dashboard' : 'Teacher Dashboard'}
                </p>
              </div>
            </div>
            {/* Center: Status badges */}
            <div className="flex items-center gap-3">
              <div className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium ${wsAuthenticated ? 'bg-green-500/15 border border-green-500/30 text-green-400' : 'bg-slate-600/30 border border-slate-500/30 text-slate-400'}`} data-testid="badge-connection-status">
                <div className={`h-2 w-2 rounded-full ${wsAuthenticated ? 'bg-green-400 animate-pulse' : 'bg-slate-500'}`} />
                {wsAuthenticated ? 'Connected' : wsConnected ? 'Authenticating...' : 'Disconnected'}
              </div>
              {isTeacher && activeSession && (
                <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-semibold bg-amber-400/15 border border-amber-400/30 text-amber-400" data-testid="badge-active-session">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="shrink-0"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>
                  {groups.find(g => g.id === activeSession.groupId)?.name || 'Active Class'}
                </div>
              )}
              {isTeacher && activeSessionIsScheduled && (
                <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-semibold bg-sky-400/15 border border-sky-400/30 text-sky-300" data-testid="badge-automatic-session">
                  <Clock className="h-3.5 w-3.5" />
                  Automatic{activeSessionScheduledEnd ? ` · Ends ${activeSessionScheduledEnd}` : ""}
                </div>
              )}
              {isTeacher && (
                <>
                  {activeSession ? (
                    <div className="flex items-center gap-2">
                      {!activeSessionIsScheduled && (
                        <button
                          type="button"
                          onClick={() => resyncSessionMutation.mutate({ sessionId: activeSession.id })}
                          disabled={resyncSessionMutation.isPending}
                          className="flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-semibold border border-slate-600 bg-slate-900 text-slate-100 hover:bg-slate-800 transition-colors disabled:opacity-50"
                          data-testid="button-resync-session"
                        >
                          <RefreshCw className={`h-3.5 w-3.5 ${resyncSessionMutation.isPending ? "animate-spin" : ""}`} /> Resync Class
                        </button>
                      )}
                      <button onClick={() => setEndClassTarget(activeSession)} disabled={endSessionMutation.isPending} className="flex items-center gap-1.5 px-4 py-1.5 rounded-full text-xs font-semibold bg-red-500 text-white hover:bg-red-600 transition-colors disabled:opacity-50" data-testid="button-end-session">
                        <X className="h-3.5 w-3.5" /> End Class
                      </button>
                    </div>
                  ) : (
                    <div className="flex items-center gap-2">
                      <select
                        value={startGroupId}
                        onChange={(event) => setStartGroupId(event.target.value)}
                        disabled={groups.length === 0 || startSessionMutation.isPending}
                        className="h-8 max-w-[180px] rounded-md border border-slate-600 bg-slate-900 px-2 text-xs font-medium text-slate-100 shadow-sm focus:outline-none focus:ring-1 focus:ring-amber-400 disabled:cursor-not-allowed disabled:opacity-50"
                        aria-label="Select ClassPilot class"
                        data-testid="select-start-session-group"
                      >
                        {groups.length === 0 ? (
                          <option value="">No classes configured</option>
                        ) : (
                          groups.map((group) => (
                            <option key={group.id} value={group.id}>
                              {group.name}
                            </option>
                          ))
                        )}
                      </select>
                      <button
                        type="button"
                        disabled={!startGroupId || startSessionMutation.isPending}
                        onClick={() => startSessionMutation.mutate({ groupId: startGroupId })}
                        data-testid="button-start-session"
                        className="inline-flex h-8 items-center justify-center gap-2 whitespace-nowrap rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground shadow transition-colors hover:bg-primary/90 disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0"
                      >
                        <Plus className="h-4 w-4 mr-2" />Start Class
                      </button>
                      {selectedTeacherStartGroup?.scheduleEnabled
                        && selectedTeacherStartGroup.teacherId === currentUser?.id && (
                        <button
                          type="button"
                          onClick={() => setSkipTodayGroup(selectedTeacherStartGroup)}
                          disabled={skipScheduledClassMutation.isPending}
                          data-testid="button-skip-scheduled-class-today"
                          className="inline-flex h-8 items-center justify-center whitespace-nowrap rounded-md border border-slate-600 bg-slate-900 px-3 text-xs font-medium text-slate-200 transition-colors hover:bg-slate-800 disabled:pointer-events-none disabled:opacity-50"
                        >
                          Skip Today
                        </button>
                      )}
                    </div>
                  )}
                </>
              )}
              {/* Admin Class Selection */}
              {isAdmin && (
                <>
                  {activeSession && (
                    <>
                      <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-semibold bg-amber-400/15 border border-amber-400/30 text-amber-400" data-testid="badge-admin-teaching">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="shrink-0"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>
                        Teaching: {groups.find(g => g.id === activeSession.groupId)?.name || 'Active Class'}
                      </div>
                      {activeSessionIsScheduled && (
                        <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-semibold bg-sky-400/15 border border-sky-400/30 text-sky-300" data-testid="badge-admin-automatic-session">
                          <Clock className="h-3.5 w-3.5" />
                          Automatic{activeSessionScheduledEnd ? ` · Ends ${activeSessionScheduledEnd}` : ""}
                        </div>
                      )}
                      {!activeSessionIsScheduled && (
                        <button
                          type="button"
                          onClick={() => resyncSessionMutation.mutate({ sessionId: activeSession.id })}
                          disabled={resyncSessionMutation.isPending}
                          className="flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-semibold border border-slate-600 bg-slate-900 text-slate-100 hover:bg-slate-800 transition-colors disabled:opacity-50"
                          data-testid="button-admin-resync-session"
                        >
                          <RefreshCw className={`h-3.5 w-3.5 ${resyncSessionMutation.isPending ? "animate-spin" : ""}`} /> Resync Class
                        </button>
                      )}
                      <button onClick={() => setEndClassTarget(activeSession)} disabled={endSessionMutation.isPending} className="flex items-center gap-1.5 px-4 py-1.5 rounded-full text-xs font-semibold bg-red-500 text-white hover:bg-red-600 transition-colors disabled:opacity-50" data-testid="button-admin-end-session">
                        <X className="h-3.5 w-3.5" /> End Class
                      </button>
                    </>
                  )}
                  {!activeSession && (
                    <div className="flex items-center gap-2">
                      <select
                        value={adminStartGroupId}
                        onChange={(event) => setAdminStartGroupId(event.target.value)}
                        disabled={adminTeachingGroupsLoading || adminTeachingGroups.length === 0 || startSessionMutation.isPending}
                        title={adminTeachingGroupsLoading ? "Loading your classes" : adminTeachingGroups.length === 0 ? "No classes assigned to you" : "Choose a class to teach"}
                        aria-label="Select ClassPilot class to teach"
                        data-testid="select-admin-start-session-group"
                        className="h-8 max-w-[180px] rounded-md border border-slate-600 bg-slate-900 px-2 text-xs font-medium text-slate-100 shadow-sm focus:outline-none focus:ring-1 focus:ring-amber-400 disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        {adminTeachingGroupsLoading ? (
                          <option value="">Loading classes...</option>
                        ) : adminTeachingGroups.length === 0 ? (
                          <option value="">No classes assigned</option>
                        ) : (
                          adminTeachingGroups.map((group) => (
                            <option key={group.id} value={group.id}>
                              {[group.name, group.periodLabel, group.gradeLevel ? `Grade ${group.gradeLevel}` : null].filter(Boolean).join(" - ")}
                            </option>
                          ))
                        )}
                      </select>
                      <button
                        type="button"
                        disabled={!adminStartGroupId || adminTeachingGroupsLoading || adminTeachingGroups.length === 0 || startSessionMutation.isPending}
                        onClick={() => startSessionMutation.mutate({ groupId: adminStartGroupId })}
                        title={adminTeachingGroupsLoading ? "Loading your classes" : adminTeachingGroups.length === 0 ? "No classes assigned to you" : "Teach selected class"}
                        data-testid="button-admin-start-session"
                        className="inline-flex h-8 items-center justify-center gap-2 whitespace-nowrap rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground shadow transition-colors hover:bg-primary/90 disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0"
                      >
                        <Plus className="h-4 w-4 mr-2" />
                        Teach Class
                      </button>
                      {selectedAdminStartGroup?.scheduleEnabled && (
                        <button
                          type="button"
                          onClick={() => setSkipTodayGroup(selectedAdminStartGroup)}
                          disabled={skipScheduledClassMutation.isPending}
                          data-testid="button-admin-skip-scheduled-class-today"
                          className="inline-flex h-8 items-center justify-center whitespace-nowrap rounded-md border border-slate-600 bg-slate-900 px-3 text-xs font-medium text-slate-200 transition-colors hover:bg-slate-800 disabled:pointer-events-none disabled:opacity-50"
                        >
                          Skip Today
                        </button>
                      )}
                    </div>
                  )}
                  <div className={`flex items-center gap-1.5 rounded-lg border px-2 py-1 transition-colors ${observedSession ? 'bg-slate-700 border-slate-600 text-slate-200' : 'bg-transparent border-slate-600 text-slate-400'}`}>
                    <Eye className="h-4 w-4" />
                    <select
                      value={adminObservedSessionId || ""}
                      onChange={(event) => setAdminObservedSessionId(event.target.value || null)}
                      disabled={allActiveSessions.length === 0}
                      aria-label="Observe active ClassPilot class"
                      data-testid="select-admin-observe"
                      className="h-7 max-w-[220px] bg-transparent text-xs font-medium outline-none disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      <option value="">{allActiveSessions.length === 0 ? "No active classes" : observedSession ? "Stop observing" : "Observe Class"}</option>
                      {allActiveSessions.map((session) => {
                        const sessionGroup = groups.find(g => g.id === session.groupId);
                        const isOwnSession = session.teacherId === currentUser?.id;
                        return (
                          <option key={session.id} value={session.id}>
                            {sessionGroup?.name || 'Unknown Class'}{isOwnSession ? " (yours)" : ""}
                          </option>
                        );
                      })}
                    </select>
                  </div>
                </>
              )}
              {currentUser?.impersonating && (
                <Button variant="destructive" size="sm" onClick={() => stopImpersonateMutation.mutate()} disabled={stopImpersonateMutation.isPending} data-testid="button-stop-impersonating">
                  <UserCog className="h-4 w-4 mr-2" />Stop Impersonating
                </Button>
              )}
            </div>
            {/* Right: Actions */}
            <div className="flex items-center gap-2">
              <ThemeToggle />
              <button onClick={() => setShowAttendance(!showAttendance)} className={`flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-medium border transition-colors ${showAttendance ? 'bg-primary text-primary-foreground border-primary' : 'bg-transparent border-slate-600 text-slate-400 hover:bg-slate-800'}`} data-testid="button-attendance">
                <ClipboardCheck className="h-4 w-4" /> Attendance
              </button>
              {isTeacher && (
                <button onClick={() => navigate("/classpilot/my-settings")} className="w-9 h-9 flex items-center justify-center rounded-lg bg-transparent border border-slate-600 text-slate-400 hover:bg-slate-800 transition-colors" data-testid="button-my-settings" title="My Settings">
                  <User className="h-[18px] w-[18px]" />
                </button>
              )}
              {isAdmin && (
                <>
                  <button onClick={() => navigate("/classpilot/admin")} className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-medium bg-transparent border border-slate-600 text-slate-400 hover:bg-slate-800 transition-colors" data-testid="button-admin">
                    <Shield className="h-4 w-4" /> Admin Panel
                  </button>
                  <button onClick={() => navigate("/classpilot/settings")} className="w-9 h-9 flex items-center justify-center rounded-lg bg-transparent border border-slate-600 text-slate-400 hover:bg-slate-800 transition-colors" data-testid="button-settings">
                    <SettingsIcon className="h-[18px] w-[18px]" />
                  </button>
                </>
              )}
              <button onClick={requestLogout} disabled={logoutPending} className="w-9 h-9 flex items-center justify-center rounded-lg bg-slate-700 text-slate-400 hover:bg-slate-600 transition-colors disabled:opacity-50" data-testid="button-logout" title="Log out">
                <LogOut className="h-[18px] w-[18px]" />
              </button>
            </div>
          </div>
        </div>
      </header>

      {isTeacher && todayScheduleChanges.length > 0 ? (
        <button
          type="button"
          onClick={() => navigate("/classpilot/my-settings/schedule-changes")}
          className="flex w-full items-center justify-center gap-2 border-b border-amber-300 bg-amber-50 px-4 py-2 text-left text-xs font-semibold text-amber-950 transition-colors hover:bg-amber-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-amber-500 dark:border-amber-900 dark:bg-amber-950/35 dark:text-amber-100 dark:hover:bg-amber-950/55"
          data-testid="today-schedule-change-indicator"
        >
          <Calendar className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <span>
            Schedule changed today · {scheduleClassName(todayScheduleChanges[0])} {formatScheduleWindow(effectiveWindow(todayScheduleChanges[0]))}
            {todayScheduleChanges.length > 1 ? ` · +${todayScheduleChanges.length - 1} more` : ""}
          </span>
          <span className="underline underline-offset-2">View</span>
        </button>
      ) : null}

      {/* Attendance Panel */}
      {showAttendance && (
        <div className="px-6 py-3 border-b border-border bg-background">
          <AttendancePanel
            students={sessionFilteredStudents.map((s) => {
              const parts = (s.studentName || '').split(' ');
              return { id: s.studentId, firstName: parts[0] || '', lastName: parts.slice(1).join(' ') || '' };
            })}
            onClose={() => setShowAttendance(false)}
          />
        </div>
      )}

      {/* Sidebar + Main Content */}
      <ClassPilotSidebar isOpen={sidebarOpen} onToggle={handleSidebarToggle} />
      <main className={`transition-all duration-300 ${showSidebar ? 'lg:ml-80' : ''}`}>
        <div className="max-w-screen-2xl mx-auto px-6 py-8">
        {/* Remote Control Toolbar */}
        {(isAdmin || isTeacher) && (
          <RemoteControlToolbar
            selectedStudentIds={selectedStudentIds}
            students={controllableStudents}
            onToggleStudent={toggleStudentSelection}
            onClearSelection={clearSelection}
            selectedGrade={selectedGrade}
            onGradeChange={setSelectedGrade}
            userRole={currentUser?.role}
            coverageCount={claimedContextCount || manageableCoverageCount}
            availableCount={availablePickupStudents.length + scheduledCoverageGroups.reduce((total, group) => total + (group.students?.length || group.claimableCount || 0), 0)}
            claimedCount={claimedPickupStudents.length}
            pickupView={studentView}
            onPickupViewChange={handleStudentViewChange}
            onOpenCoverage={canManageSupervisionSetup ? () => navigate("/classpilot/coverage") : undefined}
            canReroute={studentView === "class" && rerouteCoverageTargets.length > 0}
            onReroute={studentView === "class" ? () => setShowRerouteDialog(true) : undefined}
            onClassroomCommand={canUseRemoteControls ? postActiveCommand : null}
            canViewHistoricalTelemetry={isAdmin}
          />
        )}

        {scheduledClassConflicts.length > 0 && (
          <div className="mb-6 space-y-3" data-testid="scheduled-class-conflicts">
            {scheduledClassConflicts.map((conflict) => (
              <div
                key={conflict.id}
                className="rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-slate-950 shadow-sm dark:border-amber-800 dark:bg-amber-950/30 dark:text-slate-100"
                data-testid={`scheduled-class-conflict-${conflict.id}`}
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 text-sm font-semibold">
                      <Calendar className="h-4 w-4 text-amber-600 dark:text-amber-400" />
                      Scheduled supervision needed
                    </div>
                    <p className="mt-1 text-sm text-slate-700 dark:text-slate-300">{conflict.message}</p>
                    <div className="mt-2 flex flex-wrap gap-2">
                      <Badge variant="secondary" className="bg-white/80 text-slate-800 dark:bg-slate-900/60 dark:text-slate-200">
                        Reporting active
                      </Badge>
                      {!conflict.scheduledTeacherConnected && (
                        <Badge variant="secondary" className="bg-white/80 text-slate-800 dark:bg-slate-900/60 dark:text-slate-200">
                          Teacher offline
                        </Badge>
                      )}
                    </div>
                    {(conflict.overlap?.monitoredGroups || conflict.overlap?.groups || []).length > 0 && (
                      <div className="mt-2 flex flex-wrap gap-2">
                        {(conflict.overlap?.monitoredGroups || conflict.overlap?.groups || []).map((group) => (
                          <Badge key={group.sessionId} variant="secondary" className="bg-white/80 text-slate-800 dark:bg-slate-900/60 dark:text-slate-200">
                            {group.teacherName} - {group.className} - {group.affectedCount} student{group.affectedCount === 1 ? "" : "s"}
                          </Badge>
                        ))}
                      </div>
                    )}
                  </div>
                  {conflict.status === "expired" ? (
                    <p className="shrink-0 rounded-md bg-white/80 px-3 py-2 text-sm font-medium text-slate-700 dark:bg-slate-900/60 dark:text-slate-200">
                      This scheduled block has ended.
                    </p>
                  ) : conflict.canStartAnyway && (
                    <div className="flex shrink-0 items-center gap-2">
                      {conflict.canSkip && (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => skipScheduledConflictMutation.mutate(conflict.id)}
                          disabled={skipScheduledConflictMutation.isPending || startScheduledConflictMutation.isPending}
                          data-testid={`button-skip-scheduled-conflict-${conflict.id}`}
                        >
                          Skip Today
                        </Button>
                      )}
                      <Button
                        size="sm"
                        onClick={() => startScheduledConflictMutation.mutate(conflict.id)}
                        disabled={startScheduledConflictMutation.isPending || skipScheduledConflictMutation.isPending}
                        data-testid={`button-start-scheduled-conflict-${conflict.id}`}
                        className="bg-amber-400 text-slate-950 hover:bg-amber-300"
                      >
                        Start Class
                      </Button>
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Stats Cards */}
        {canShowStudentWorkspace && (
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
            <div className="p-5 rounded-xl bg-green-500/10 border border-green-500/20 dark:bg-green-500/10 dark:border-green-500/20 transition-all duration-300">
              <div className="flex items-center gap-4">
                <div className="h-12 w-12 rounded-xl bg-green-500 flex items-center justify-center"><Users className="h-6 w-6 text-white" /></div>
                <div><p className="text-[28px] font-bold text-foreground" data-testid="text-online-count">{onlineCount}</p><p className="text-[13px] text-green-500 font-medium">Online Now</p></div>
              </div>
            </div>
            <div className="p-5 rounded-xl bg-amber-500/10 border border-amber-500/20 dark:bg-amber-500/10 dark:border-amber-500/20 transition-all duration-300">
              <div className="flex items-center gap-4">
                <div className="h-12 w-12 rounded-xl bg-amber-500 flex items-center justify-center"><Activity className="h-6 w-6 text-slate-900" /></div>
                <div><p className="text-[28px] font-bold text-foreground" data-testid="text-idle-count">{idleCount}</p><p className="text-[13px] text-amber-500 font-medium">Idle</p></div>
              </div>
            </div>
            <div className="p-5 rounded-xl bg-slate-500/10 border border-slate-500/20 dark:bg-slate-500/10 dark:border-slate-500/20 transition-all duration-300">
              <div className="flex items-center gap-4">
                <div className="h-12 w-12 rounded-xl bg-slate-500 flex items-center justify-center"><WifiOff className="h-6 w-6 text-white" /></div>
                <div><p className="text-[28px] font-bold text-foreground" data-testid="text-offline-count">{offlineCount}</p><p className="text-[13px] text-muted-foreground font-medium">Not logged in</p></div>
              </div>
            </div>
            <div className="p-5 rounded-xl bg-red-500/10 border border-red-500/20 dark:bg-red-500/10 dark:border-red-500/20 transition-all duration-300">
              <div className="flex items-center gap-4">
                <div className="h-12 w-12 rounded-xl bg-red-500 flex items-center justify-center"><AlertTriangle className="h-6 w-6 text-white" /></div>
                <div><p className="text-[28px] font-bold text-foreground" data-testid="text-offtask-count">{offTaskCount}</p><p className="text-[13px] text-red-500 font-medium">Off-Task Alert</p></div>
              </div>
            </div>
          </div>
        )}

        {/* Search Bar + Selection Controls */}
        {canShowStudentWorkspace && (
          <div className="flex items-center justify-between gap-4 flex-wrap mb-5">
            <input type="text" placeholder="Search student" value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)} data-testid="input-search-students" className="w-[300px] px-4 py-3 text-sm rounded-lg border border-border bg-card text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-amber-400 transition-colors" />
            <div className="flex items-center gap-3">
              <div className="px-4 py-2 rounded-lg bg-amber-400 text-slate-900" data-testid="badge-selection-count">
                <div className="text-[13px] font-semibold">Target: {activeClassName} - {targetBannerLabel}</div>
                <div className="text-[11px] font-medium opacity-80">{targetConnectionLabel}</div>
              </div>
              <button
                onClick={selectAll}
                disabled={selectableStudents.length === 0 || selectedStudentIds.size === selectableStudents.length}
                className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-[13px] font-medium bg-transparent border border-border text-muted-foreground hover:bg-card transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                data-testid="button-select-all-students"
              >
                <Users className="h-4 w-4" /> Select All ({selectableStudents.length})
              </button>
              <button onClick={clearSelection} disabled={selectedStudentIds.size === 0} className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-[13px] font-medium bg-transparent border border-border text-muted-foreground hover:bg-card transition-colors disabled:opacity-50 disabled:cursor-not-allowed" data-testid="button-clear-selection">
                Clear Selection
              </button>
            </div>
          </div>
        )}

        {/* Control Buttons */}
        {canUseRemoteControls && studentView !== "available" && (
          <div className="flex items-center gap-2 flex-wrap mb-4">
            <Button size="sm" variant="outline" onClick={() => setShowOpenTabDialog(true)} data-testid="button-open-tab" className="text-blue-600 dark:text-blue-400"><MonitorPlay className="h-4 w-4 mr-2" />Open URL</Button>
            <Button size="sm" variant="outline" onClick={() => openManageTabs(null)} data-testid="button-tabs" className="text-blue-600 dark:text-blue-400"><List className="h-4 w-4 mr-2" />Tabs</Button>
            <Button size="sm" variant="outline" onClick={handleLockScreen} disabled={lockScreenMutation.isPending} data-testid="button-lock-screen" className="text-amber-600 dark:text-amber-400"><Lock className="h-4 w-4 mr-2" />Lock Screen</Button>
            <Button size="sm" variant="outline" onClick={handleUnlockScreen} disabled={unlockScreenMutation.isPending} data-testid="button-unlock-screen" className="text-amber-600 dark:text-amber-400"><Unlock className="h-4 w-4 mr-2" />Unlock Screen</Button>
            <Button size="sm" variant="outline" onClick={() => setShowApplyFlightPathDialog(true)} data-testid="button-apply-flight-path" className="text-purple-600 dark:text-purple-400"><Layers className="h-4 w-4 mr-2" />Apply Flight Path</Button>
            {studentView === "class" && <Button size="sm" variant="outline" onClick={() => setShowFlightPathViewerDialog(true)} data-testid="button-flight-path-status" className="text-purple-600 dark:text-purple-400"><Eye className="h-4 w-4 mr-2" />Flight Path Status</Button>}
            <Button size="sm" variant="outline" onClick={() => setShowApplyBlockListDialog(true)} data-testid="button-apply-block-list" className="text-red-600 dark:text-red-400"><ShieldBan className="h-4 w-4 mr-2" />Apply Block List</Button>
            {studentView === "class" && <Button size="sm" variant="outline" onClick={() => setShowBlockListViewerDialog(true)} data-testid="button-block-list-status" className="text-red-600 dark:text-red-400"><Shield className="h-4 w-4 mr-2" />Block List Status</Button>}
            {studentView === "class" && (
              <Button
                size="sm"
                variant="outline"
                onClick={() => setShowSignOutDialog(true)}
                disabled={!canSignOutSelectedStudents || signOutStudentsMutation.isPending}
                data-testid="button-sign-out-students"
                className="border-gray-300 bg-gray-200 text-black hover:bg-gray-300 hover:text-black disabled:cursor-not-allowed disabled:border-gray-200 disabled:bg-gray-200 disabled:text-black/60 disabled:opacity-40"
              >
                <LogOut className="h-4 w-4 mr-2" />
                Student Sign Out
              </Button>
            )}
            {studentView === "class" && subgroups.length > 0 && (
              <label className={`inline-flex h-8 items-center gap-2 rounded-md border bg-background px-3 text-xs font-medium shadow-sm ${selectedSubgroupId ? "border-pink-300 text-pink-600 dark:text-pink-400" : "border-input text-pink-600 dark:text-pink-400"}`}>
                <UsersRound className="h-4 w-4" />
                <span className="sr-only">Filter by subgroup</span>
                <select
                  value={selectedSubgroupId}
                  onChange={(event) => setSelectedSubgroupId(event.target.value)}
                  data-testid="select-subgroup-filter"
                  aria-label="Filter by subgroup"
                  className="max-w-[170px] bg-transparent outline-none"
                >
                  <option value="">All Students</option>
                  {subgroups.map((subgroup) => (
                    <option key={subgroup.id} value={subgroup.id}>{subgroup.name}</option>
                  ))}
                </select>
              </label>
            )}
          </div>
        )}

        {/* Student Tiles */}
        {studentView === "available" ? (
          <div className="space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h2 className="text-lg font-semibold">Available students</h2>
                <p className="text-sm text-muted-foreground">Online students from your supervision permissions who are not in an active class.</p>
              </div>
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  onClick={() => handleClaimStudents(selectedAvailableStudents)}
                  disabled={selectedAvailableStudents.length === 0 || claimPickupMutation.isPending}
                  data-testid="button-claim-selected-students"
                >
                  <UserCheck className="h-4 w-4 mr-2" />
                  Claim selected
                </Button>
                <Button
                  onClick={() => handleClaimStudents(filteredStudents)}
                  disabled={filteredStudents.length === 0 || claimPickupMutation.isPending}
                  data-testid="button-claim-all-students"
                >
                  <Users className="h-4 w-4 mr-2" />
                  Claim all
                </Button>
              </div>
            </div>
            {filteredScheduledCoverageGroups.length === 0 && filteredAvailableStudents.length === 0 ? (
              <div className="rounded-lg border bg-card px-4 py-14 text-center">
                <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-xl bg-muted/40">
                  <UserCheck className="h-7 w-7 text-muted-foreground" />
                </div>
                <h3 className="text-lg font-semibold">No students available</h3>
                <p className="mx-auto mt-2 max-w-md text-sm text-muted-foreground">
                  Students will appear here when they log in outside a class and match one of your supervision permissions.
                </p>
              </div>
            ) : (
              <div className="space-y-4">
                {filteredScheduledCoverageGroups.map((section) => (
                  <section key={`scheduled-${section.id}`} className="rounded-lg border border-amber-300 bg-amber-50/80 shadow-sm dark:border-amber-800 dark:bg-amber-950/20" data-testid={`section-scheduled-coverage-${section.id}`}>
                    <div className="flex flex-wrap items-center justify-between gap-3 border-b border-amber-200 px-4 py-3 dark:border-amber-900">
                      <div>
                        <h3 className="text-base font-semibold text-foreground">
                          {section.className || section.label} - {section.students.length} available
                        </h3>
                        <p className="text-xs text-muted-foreground">
                          Scheduled Supervision Needed for {section.teacherName || "scheduled teacher"} - reporting active
                          {section.blockStartTime && section.blockEndTime ? ` (${section.blockStartTime}-${section.blockEndTime})` : ""}
                        </p>
                      </div>
                      <Button
                        size="sm"
                        onClick={() => handleClaimStudents(section.students)}
                        disabled={claimPickupMutation.isPending || section.students.length === 0}
                        data-testid={`button-claim-scheduled-coverage-${section.id}`}
                        className="bg-amber-400 text-slate-950 hover:bg-amber-300"
                      >
                        <Users className="h-4 w-4 mr-2" />
                        Claim Group
                      </Button>
                    </div>
                    <div className="grid grid-cols-1 gap-4 p-4 md:grid-cols-2 xl:grid-cols-3">
                      {section.students.map((student) => (
                        <div key={`${section.id}-${student.studentId}`} className="rounded-lg border bg-background p-4 shadow-sm" data-testid={`card-scheduled-coverage-student-${student.studentId}`}>
                          <div className="flex items-start gap-3">
                            <input
                              type="checkbox"
                              checked={selectedStudentIds.has(student.studentId)}
                              onChange={() => toggleStudentSelection(student.studentId)}
                              className="mt-1 h-4 w-4 rounded border-border"
                              aria-label={`Select ${student.studentName}`}
                            />
                            <div className="flex h-10 w-10 items-center justify-center rounded-full bg-amber-100 text-sm font-semibold text-amber-800">
                              {(student.studentName || "?").split(" ").map((part) => part[0]).join("").slice(0, 2).toUpperCase()}
                            </div>
                            <div className="min-w-0 flex-1">
                              <div className="flex flex-wrap items-center gap-2">
                                <p className="font-semibold text-foreground">{student.studentName}</p>
                                <Badge variant="secondary">{deriveStudentMonitoringDisplay(student, freshnessNowMs).label}</Badge>
                              </div>
                              <p className="text-sm text-muted-foreground">{student.gradeLevel ? `Grade ${student.gradeLevel}` : "No grade"}</p>
                              <AvailableStudentActivity student={student} nowMs={freshnessNowMs} />
                              <div className="mt-3 flex flex-wrap gap-2">
                                <Badge variant="outline">Scheduled Supervision</Badge>
                                <Badge variant="outline">Reporting active</Badge>
                                <Badge variant="outline">{section.className || section.label}</Badge>
                              </div>
                            </div>
                          </div>
                          <div className="mt-4 flex justify-end">
                            <Button
                              size="sm"
                              onClick={() => handleClaimStudents([student], { quickClaimStudentId: student.studentId })}
                              disabled={claimPickupMutation.isPending}
                              data-testid={`button-claim-scheduled-student-${student.studentId}`}
                              className="bg-amber-400 text-slate-950 hover:bg-amber-300 focus-visible:ring-amber-300 disabled:bg-amber-200 disabled:text-slate-700"
                            >
                              <UserCheck className="h-4 w-4 mr-2" />
                              {claimPickupMutation.isPending && quickClaimStudentId === student.studentId ? "Claiming..." : "Claim"}
                            </Button>
                          </div>
                        </div>
                      ))}
                    </div>
                  </section>
                ))}
                {availableGroupSections.map((section) => (
                  <section key={section.id} className="rounded-lg border bg-card shadow-sm" data-testid={`section-available-${section.id}`}>
                    <div className="flex flex-wrap items-center justify-between gap-3 border-b px-4 py-3">
                      <div>
                        <h3 className="text-base font-semibold text-foreground">
                          {section.label} - {section.students.length} available
                        </h3>
                        {section.description && (
                          <p className="text-xs text-muted-foreground">{section.description}</p>
                        )}
                      </div>
                      <Button
                        size="sm"
                        onClick={() => handleClaimStudents(section.students)}
                        disabled={claimPickupMutation.isPending || section.students.length === 0}
                        data-testid={`button-claim-section-${section.id}`}
                        className="bg-amber-400 text-slate-950 hover:bg-amber-300"
                      >
                        <Users className="h-4 w-4 mr-2" />
                        {section.kind === "group" ? "Claim Group" : "Claim Scope"}
                      </Button>
                    </div>
                    <div className="grid grid-cols-1 gap-4 p-4 md:grid-cols-2 xl:grid-cols-3">
                      {section.students.map((student) => (
                        <div key={`${section.id}-${student.studentId}`} className="rounded-lg border bg-background p-4 shadow-sm" data-testid={`card-available-student-${student.studentId}`}>
                          <div className="flex items-start gap-3">
                            <input
                              type="checkbox"
                              checked={selectedStudentIds.has(student.studentId)}
                              onChange={() => toggleStudentSelection(student.studentId)}
                              className="mt-1 h-4 w-4 rounded border-border"
                              aria-label={`Select ${student.studentName}`}
                            />
                            <div className="flex h-10 w-10 items-center justify-center rounded-full bg-amber-100 text-sm font-semibold text-amber-800">
                              {(student.studentName || "?").split(" ").map((part) => part[0]).join("").slice(0, 2).toUpperCase()}
                            </div>
                            <div className="min-w-0 flex-1">
                              <div className="flex flex-wrap items-center gap-2">
                                <p className="font-semibold text-foreground">{student.studentName}</p>
                                <Badge variant="secondary">{deriveStudentMonitoringDisplay(student, freshnessNowMs).label}</Badge>
                              </div>
                              <p className="text-sm text-muted-foreground">{student.gradeLevel ? `Grade ${student.gradeLevel}` : "No grade"}</p>
                              <AvailableStudentActivity student={student} nowMs={freshnessNowMs} />
                              <div className="mt-3 flex flex-wrap gap-2">
                                {(student.matchingGroups || []).map((group) => (
                                  <Badge key={group.id} variant="outline">{group.name}</Badge>
                                ))}
                                {(student.matchingScopes || []).map((scope) => (
                                  <Badge key={scope.id} variant="outline">{scope.name}</Badge>
                                ))}
                              </div>
                            </div>
                          </div>
                          <div className="mt-4 flex justify-end">
                            <Button
                              size="sm"
                              onClick={() => handleClaimStudents([student], { quickClaimStudentId: student.studentId })}
                              disabled={claimPickupMutation.isPending}
                              data-testid={`button-claim-student-${student.studentId}`}
                              className="bg-amber-400 text-slate-950 hover:bg-amber-300 focus-visible:ring-amber-300 disabled:bg-amber-200 disabled:text-slate-700"
                            >
                              <UserCheck className="h-4 w-4 mr-2" />
                              {claimPickupMutation.isPending && quickClaimStudentId === student.studentId ? "Claiming..." : "Claim"}
                            </Button>
                          </div>
                        </div>
                      ))}
                    </div>
                  </section>
                ))}
              </div>
            )}
          </div>
        ) : isTeacher && !activeSession && studentView === "class" ? (
          <div className="py-20 text-center">
            <div className="h-20 w-20 mx-auto mb-6 rounded-2xl bg-muted/30 flex items-center justify-center"><Calendar className="h-10 w-10 text-muted-foreground/50" /></div>
            <h3 className="text-xl font-semibold mb-2">No Active Class Session</h3>
            <p className="text-sm text-muted-foreground max-w-md mx-auto mb-6">Start a class session to view and monitor your students. Click "Start Class" in the top right to select a class period.</p>
            <Button variant="outline" className="mb-4" onClick={() => setStudentView("available")} data-testid="button-open-available-empty">
              <ClipboardCheck className="h-4 w-4 mr-2" />
              View Available
            </Button>
            {groups.length === 0 && <p className="text-xs text-muted-foreground max-w-md mx-auto">You don't have any class groups yet. Contact your administrator to have students assigned to your classes.</p>}
          </div>
        ) : studentView === "class" && studentsLoading ? (
          <div className="py-20 text-center">
            <div className="h-10 w-10 mx-auto mb-4 animate-spin rounded-full border-4 border-muted border-t-primary" />
            <p className="text-sm text-muted-foreground">Loading students...</p>
          </div>
        ) : filteredStudents.length === 0 ? (
          <div className="py-20 text-center">
            <div className="h-20 w-20 mx-auto mb-6 rounded-2xl bg-muted/30 flex items-center justify-center"><Monitor className="h-10 w-10 text-muted-foreground/50" /></div>
            <h3 className="text-xl font-semibold mb-2">No students found</h3>
            <p className="text-sm text-muted-foreground max-w-md mx-auto">
              {searchQuery ? "Try adjusting your search query to find students" : "No student devices are currently registered. Students will appear here when they connect with the Chrome extension."}
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5 2xl:grid-cols-6 gap-6">
            {filteredStudents.map((student) => {
              const studentRealtimeKey = student.studentId;
              const monitoringDisplay = deriveStudentMonitoringDisplay(student, freshnessNowMs);
              const tileRevision = tileRevisions[studentRealtimeKey] ?? 0;
              const supervisedElsewhere = studentView === "class" && isStudentInTemporarySupervision(student);
              const supervisionStaffName = student.supervisionContext?.assignedStaff?.displayName || "";
              const coverageLabel = student.supervisionState === "temporary_coverage"
                ? `In supervision: ${[
                    student.supervisionContext?.name || "Supervision",
                    supervisionStaffName,
                  ].filter(Boolean).join(" - ")}`
                : student.supervisionState === "claimed"
                  ? student.supervisionGroup?.name || student.contextName || "Claimed"
                  : student.supervisionState === "online_unassigned"
                    ? "Online Unassigned"
                    : null;
              const disabledReason = supervisedElsewhere
                ? `${student.studentName || "This student"} is currently claimed by ${supervisionStaffName || student.supervisionContext?.name || "another supervision session"}.`
                : "";
              const returnToClassPending = returnToClassMutation.isPending &&
                returnToClassMutation.variables?.studentIds?.includes(student.studentId);
              return (
                <div key={`${student.studentId}-${tileRevision}`} className={`relative ${supervisedElsewhere ? "rounded-lg ring-2 ring-slate-300/70 dark:ring-slate-700/70" : ""}`}>
                  {coverageLabel && (
                    <div className={`absolute left-3 top-3 z-10 max-w-[calc(100%-1.5rem)] rounded-md px-2 py-1 text-[11px] font-semibold shadow-sm ${student.supervisionState === "temporary_coverage" || student.supervisionState === "claimed" ? "bg-slate-800 text-white" : "bg-amber-400 text-slate-900"}`}>
                      {coverageLabel}
                    </div>
                  )}
                  <StudentTile
                    student={student}
                    onClick={() => setSelectedStudent(student)}
                    blockedDomains={settings?.blockedDomains || []}
                    isOffTask={isStudentOffTask(student)}
                    isAbsent={absentIds.has(student.studentId)}
                    isSelected={selectedStudentIds.has(student.studentId)}
                    onToggleSelect={supervisedElsewhere ? undefined : () => toggleStudentSelection(student.studentId)}
                    liveStream={liveStreams.get(studentRealtimeKey) || null}
                    liveViewPending={liveViewPendingIds.has(studentRealtimeKey)}
                    onStartLiveView={!supervisedElsewhere && student.isLoggedIn && effectiveSession?.id ? () => handleStartLiveView(studentRealtimeKey) : undefined}
                    onStopLiveView={!supervisedElsewhere ? () => handleStopLiveView(studentRealtimeKey) : undefined}
                    onEndLiveRefresh={() => refreshTile(studentRealtimeKey)}
                    onAllowDomain={supervisedElsewhere ? undefined : handleAllowDomain}
                    teachingSessionId={effectiveSession?.id}
                    onManageTabs={supervisedElsewhere ? undefined : () => openManageTabs([student.studentId])}
                    controlDisabled={supervisedElsewhere}
                    disabledReason={disabledReason}
                    supervisionLabel={coverageLabel || "In supervision"}
                    onReturnToClass={supervisedElsewhere && activeSession ? () => handleReturnToClass(student) : undefined}
                    returnToClassPending={returnToClassPending}
                    recentHeartbeats={supervisedElsewhere || failedHistoryStudentIds.has(student.studentId) ? EMPTY_LIST : historyByStudent.get(student.studentId) || EMPTY_LIST}
                    screenshotData={supervisedElsewhere || failedScreenshotStudentIds.has(student.studentId) ? null : screenshotsByStudent.get(student.studentId) || null}
                    flightPaths={flightPaths}
                    monitoringDisplay={monitoringDisplay}
                    freshnessNowMs={freshnessNowMs}
                    onCommandResult={decorateCommandResponse}
                  />
                </div>
              );
            })}
          </div>
        )}
        </div>
      </main>

      {/* Student Detail Drawer */}
      {selectedStudent && (
        <StudentDetailDrawer
          student={students.find((student) => student.studentId === selectedStudent.studentId) || selectedStudent}
          urlHistory={urlHistory}
          allowedDomains={settings?.allowedDomains || []}
          flightPaths={flightPaths}
          onClose={() => setSelectedStudent(null)}
          activeClassName={effectiveSession ? groups.find(g => g.id === effectiveSession.groupId)?.name : null}
          teachingSessionId={effectiveSession?.id}
          canViewHistoricalUsage={isAdmin}
          freshnessNowMs={freshnessNowMs}
        />
      )}

      <Dialog
        open={!!endClassTarget}
        onOpenChange={(open) => {
          if (!open && !endSessionMutation.isPending) setEndClassTarget(null);
        }}
      >
        <DialogContent className="max-w-md" data-testid="dialog-end-class">
          <DialogHeader>
            <DialogTitle>
              {isScheduledTeachingSession(endClassTarget) ? "End scheduled class early?" : "End class?"}
            </DialogTitle>
            <DialogDescription data-testid="text-end-class-consequence">
              {isScheduledTeachingSession(endClassTarget)
                ? "Monitoring and classroom controls will stop now. After a short telemetry-settlement window, the Session Summary will cover the scheduled start through now and be emailed; today’s block will not restart."
                : "Monitoring and classroom controls will stop now. The Session Summary will be generated after a short telemetry-settlement window, then emailed."}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setEndClassTarget(null)}
              disabled={endSessionMutation.isPending}
              data-testid="button-cancel-end-class"
            >
              Keep Class Running
            </Button>
            <Button
              variant="destructive"
              onClick={() => endSessionMutation.mutate({ session: endClassTarget })}
              disabled={!endClassTarget?.id || endSessionMutation.isPending}
              data-testid="button-confirm-end-class"
            >
              {endSessionMutation.isPending ? "Ending Class..." : isScheduledTeachingSession(endClassTarget) ? "End Early & Email Summary" : "End Class & Email Summary"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {sessionReportTarget && (
        <SessionMonitoringReportDialog
          target={sessionReportTarget}
          onClose={() => setSessionReportTarget(null)}
        />
      )}

      <Dialog
        open={showLogoutDialog}
        onOpenChange={(open) => {
          if (!logoutPending) setShowLogoutDialog(open);
        }}
      >
        <DialogContent className="max-w-md" data-testid="dialog-logout-active-session">
          <DialogHeader>
            <DialogTitle>Log out with an active class?</DialogTitle>
            <DialogDescription data-testid="text-logout-consequence">
              {activeSessionIsScheduled
                ? `Logging out will not end this scheduled class. The class and active controls will continue until ${activeSessionScheduledEnd || "the scheduled end"}, and the Session Summary will then be emailed automatically.`
                : "Logging out will not end this class or send its Session Summary. Choose End Class first if the class is finished."}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setShowLogoutDialog(false)}
              disabled={logoutPending}
              data-testid="button-cancel-logout"
            >
              Stay Signed In
            </Button>
            <Button
              onClick={() => {
                setShowLogoutDialog(false);
                void performLogout();
              }}
              disabled={logoutPending}
              data-testid="button-confirm-logout"
            >
              {logoutPending ? "Logging Out..." : "Log Out Anyway"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={!!skipTodayGroup}
        onOpenChange={(open) => {
          if (!open && !skipScheduledClassMutation.isPending) setSkipTodayGroup(null);
        }}
      >
        <DialogContent className="max-w-md" data-testid="dialog-skip-scheduled-class-today">
          <DialogHeader>
            <DialogTitle>Skip {skipTodayGroup?.name || "this scheduled class"} today?</DialogTitle>
            <DialogDescription data-testid="text-skip-scheduled-class-consequence">
              This prevents today’s automatic class from starting. No Session Summary will be sent, and the regular weekday schedule resumes on the next school day.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setSkipTodayGroup(null)}
              disabled={skipScheduledClassMutation.isPending}
              data-testid="button-cancel-skip-scheduled-class-today"
            >
              Keep Scheduled Class
            </Button>
            <Button
              variant="destructive"
              onClick={() => skipTodayGroup?.id && skipScheduledClassMutation.mutate(skipTodayGroup.id)}
              disabled={!skipTodayGroup?.id || skipScheduledClassMutation.isPending}
              data-testid="button-confirm-skip-scheduled-class-today"
            >
              {skipScheduledClassMutation.isPending ? "Skipping..." : "Skip Today"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!classStartOverlap} onOpenChange={(open) => { if (!open) setClassStartOverlap(null); }}>
        <DialogContent className="max-w-lg" data-testid="dialog-class-start-overlap">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AlertTriangle className="h-5 w-5 text-amber-500" />
              Some students are already active in another class
            </DialogTitle>
            <DialogDescription>
              {classStartOverlap?.totalOverlapCount || 0} student{classStartOverlap?.totalOverlapCount === 1 ? "" : "s"} from {classStartOverlap?.selectedClass?.name || "this class"} are currently active in another ClassPilot session. Starting anyway will move control for those students to you.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 py-2">
            {(classStartOverlap?.groups || []).map((group) => (
              <div key={group.sessionId} className="rounded-lg border border-amber-200 bg-amber-50/60 p-3 text-sm dark:border-amber-900/60 dark:bg-amber-950/20">
                <div className="font-semibold text-slate-900 dark:text-slate-100">
                  {group.teacherName} - {group.className} - {group.affectedCount} student{group.affectedCount === 1 ? "" : "s"}
                </div>
                {group.affectedStudents?.length > 0 && (
                  <div className="mt-1 text-xs text-slate-600 dark:text-slate-400">
                    {group.affectedStudents.map((student) => student.studentName).join(", ")}
                    {group.affectedCount > group.affectedStudents.length ? `, +${group.affectedCount - group.affectedStudents.length} more` : ""}
                  </div>
                )}
              </div>
            ))}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setClassStartOverlap(null)} data-testid="button-cancel-overlap-start">
              Cancel
            </Button>
            <Button
              onClick={() => {
                const groupId = classStartOverlap?.request?.groupId || classStartOverlap?.selectedClass?.id;
                if (!groupId) return;
                startSessionMutation.mutate({ groupId, acknowledgeOverlap: true });
              }}
              disabled={startSessionMutation.isPending}
              data-testid="button-confirm-overlap-start"
            >
              Start Anyway
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!classResyncOverlap} onOpenChange={(open) => { if (!open) setClassResyncOverlap(null); }}>
        <DialogContent className="max-w-lg" data-testid="dialog-class-resync-overlap">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AlertTriangle className="h-5 w-5 text-amber-500" />
              Some students are active in another class
            </DialogTitle>
            <DialogDescription>
              {classResyncOverlap?.activeElsewhere || 0} student{classResyncOverlap?.activeElsewhere === 1 ? "" : "s"} from this roster are currently active in another ClassPilot session. Resyncing anyway will move ClassPilot control for those students back to this class.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 py-2">
            {(classResyncOverlap?.conflicts || []).map((group) => (
              <div key={group.sessionId} className="rounded-lg border border-amber-200 bg-amber-50/60 p-3 text-sm dark:border-amber-900/60 dark:bg-amber-950/20">
                <div className="font-semibold text-slate-900 dark:text-slate-100">
                  {group.teacherName} - {group.className} - {group.affectedCount} student{group.affectedCount === 1 ? "" : "s"}
                </div>
                {group.affectedStudents?.length > 0 && (
                  <div className="mt-1 text-xs text-slate-600 dark:text-slate-400">
                    {group.affectedStudents.map((student) => student.studentName).join(", ")}
                    {group.affectedCount > group.affectedStudents.length ? `, +${group.affectedCount - group.affectedStudents.length} more` : ""}
                  </div>
                )}
              </div>
            ))}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setClassResyncOverlap(null)} data-testid="button-cancel-resync-overlap">
              Cancel
            </Button>
            <Button
              onClick={() => {
                const sessionId = classResyncOverlap?.request?.sessionId || activeSession?.id;
                if (!sessionId) return;
                resyncSessionMutation.mutate({ sessionId, acknowledgeOverlap: true });
              }}
              disabled={resyncSessionMutation.isPending}
              data-testid="button-confirm-resync-overlap"
            >
              Resync Anyway
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Grade Management Dialog */}
      <Dialog open={showGradeDialog} onOpenChange={setShowGradeDialog}>
        <DialogContent data-testid="dialog-manage-grades">
          <DialogHeader><DialogTitle>Manage Grade Levels</DialogTitle><DialogDescription>Add or remove grade levels that appear as filter tabs on the dashboard</DialogDescription></DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label>Current Grade Levels</Label>
              <div className="flex flex-wrap gap-2">
                {settings?.gradeLevels?.map((grade) => (
                  <Badge key={grade} variant="secondary" className="text-sm px-3 py-1" data-testid={`badge-grade-${grade}`}>
                    {grade}<button onClick={() => handleDeleteGrade(grade)} className="ml-2 hover:text-destructive" data-testid={`button-delete-grade-${grade}`}><X className="h-3 w-3" /></button>
                  </Badge>
                ))}
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="new-grade">Add New Grade Level</Label>
              <div className="flex gap-2">
                <Input id="new-grade" placeholder="e.g., 5th, K, Pre-K" value={newGrade} onChange={(e) => setNewGrade(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') handleAddGrade(); }} data-testid="input-new-grade" />
                <Button onClick={handleAddGrade} disabled={updateGradesMutation.isPending} data-testid="button-add-grade"><Plus className="h-4 w-4 mr-2" />Add</Button>
              </div>
            </div>
          </div>
          <DialogFooter><Button variant="outline" onClick={() => { setShowGradeDialog(false); setNewGrade(""); }} data-testid="button-close-grade-dialog">Done</Button></DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={showRerouteDialog} onOpenChange={setShowRerouteDialog}>
        <DialogContent data-testid="dialog-reroute-students">
          <DialogHeader>
            <DialogTitle>Send Students</DialogTitle>
            <DialogDescription>Assign {selectedStudentIds.size} selected student{selectedStudentIds.size === 1 ? "" : "s"} to a Supervision Group and staff member.</DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label>Send to</Label>
              <Select value={selectedCoverageContextId} onValueChange={setSelectedCoverageContextId}>
                <SelectTrigger data-testid="select-coverage-context"><SelectValue placeholder="Select destination" /></SelectTrigger>
                <SelectContent>
                  {rerouteCoverageTargets.length === 0 ? (
                    <SelectItem value="none" disabled>No Supervision Groups with assigned staff</SelectItem>
                  ) : rerouteCoverageTargets.map((target) => (
                    <SelectItem key={target.id} value={target.id}>
                      {target.name} · {target.assignedStaff?.displayName || "Staff"}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Note</Label>
              <Textarea
                value={rerouteNote}
                onChange={(e) => setRerouteNote(e.target.value)}
                placeholder="State testing, office check-in, support block"
                data-testid="textarea-reroute-note"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => { setShowRerouteDialog(false); setRerouteNote(""); }}>Cancel</Button>
            <Button onClick={handleRerouteSelected} disabled={rerouteMutation.isPending || !selectedCoverageContextId || selectedCoverageContextId === "none"} data-testid="button-confirm-reroute">
              <ClipboardCheck className="h-4 w-4 mr-2" />
              Send
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={showSignOutDialog} onOpenChange={setShowSignOutDialog}>
        <DialogContent data-testid="dialog-sign-out-students">
          <DialogHeader>
            <DialogTitle>Sign out selected students?</DialogTitle>
            <DialogDescription>
              This will sign {signOutSelectedCount} selected student{signOutSelectedCount === 1 ? "" : "s"} out of ClassPilot on their current Chromebook{signOutSelectedCount === 1 ? "" : "s"}. They will need to sign back in before monitoring, messaging, and hand raising resume.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowSignOutDialog(false)} disabled={signOutStudentsMutation.isPending}>
              Cancel
            </Button>
            <Button
              onClick={() => signOutStudentsMutation.mutate()}
              disabled={!canSignOutSelectedStudents || signOutStudentsMutation.isPending}
              data-testid="button-confirm-sign-out-students"
              className="border border-gray-300 bg-gray-200 text-black hover:bg-gray-300 hover:text-black disabled:opacity-40"
            >
              <LogOut className="h-4 w-4 mr-2" />
              Student Sign Out
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Open Tab Dialog */}
      <Dialog open={showOpenTabDialog} onOpenChange={setShowOpenTabDialog}>
        <DialogContent data-testid="dialog-open-tab">
          <DialogHeader><DialogTitle>Open Tab on Student Devices</DialogTitle><DialogDescription>{selectedStudentIds.size > 0 ? `Open a URL on ${selectedStudentIds.size} selected student(s)` : "Open a URL on all student devices"}</DialogDescription></DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="open-tab-url">URL to Open</Label>
              <Input id="open-tab-url" type="url" placeholder="https://example.com" value={openTabUrl} onChange={(e) => setOpenTabUrl(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && !openTabMutation.isPending) handleOpenTab(); }} data-testid="input-open-tab-url" />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowOpenTabDialog(false)} data-testid="button-cancel-open-tab">Cancel</Button>
            <Button onClick={handleOpenTab} disabled={openTabMutation.isPending} data-testid="button-confirm-open-tab"><MonitorPlay className="h-4 w-4 mr-2" />Open Tab</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Lock URL Dialog */}
      <Dialog open={showLockUrlDialog} onOpenChange={setShowLockUrlDialog}>
        <DialogContent data-testid="dialog-lock-url">
          <DialogHeader><DialogTitle>Lock Students to URL</DialogTitle><DialogDescription>{targetBannerLabel}</DialogDescription></DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="lock-url">URL to Lock</Label>
              <Input id="lock-url" type="url" placeholder="https://example.com" value={lockUrl} onChange={(e) => setLockUrl(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && !lockScreenMutation.isPending) handleLockToUrl(); }} data-testid="input-lock-url" />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowLockUrlDialog(false)} data-testid="button-cancel-lock-url">Cancel</Button>
            <Button onClick={handleLockToUrl} disabled={lockScreenMutation.isPending} data-testid="button-confirm-lock-url"><Lock className="h-4 w-4 mr-2" />Lock to URL</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Tabs Dialog */}
      <Dialog open={showCloseTabsDialog} onOpenChange={(open) => {
        setShowCloseTabsDialog(open);
        if (!open) {
          setManageTabsStudentIds(null);
          setSelectedTabsToClose(new Set());
        }
      }}>
        <DialogContent className="max-w-2xl" data-testid="dialog-tabs">
          <DialogHeader><DialogTitle>Manage Tabs ({openTabs.length})</DialogTitle><DialogDescription>{manageTabsTargetLabel}</DialogDescription></DialogHeader>
          <div className="space-y-4 py-4">
            {openTabs.length === 0 ? (
              <p className="text-sm text-muted-foreground py-8 text-center">No tabs are currently open for this target</p>
            ) : (
              <>
                <div className="flex items-center gap-2 mb-2">
                  <Button type="button" variant="outline" size="sm" onClick={() => setSelectedTabsToClose(new Set(openTabs.map(makeTabKey)))} data-testid="button-select-all-tabs" className="h-8"><CheckSquare className="h-3 w-3 mr-1" />Select All</Button>
                  <Button type="button" variant="outline" size="sm" onClick={() => setSelectedTabsToClose(new Set())} data-testid="button-clear-tabs" className="h-8"><XSquare className="h-3 w-3 mr-1" />Clear</Button>
                  <span className="text-xs text-muted-foreground ml-auto">{selectedTabsToClose.size} selected</span>
                </div>
                <div className="border rounded-md max-h-80 overflow-y-auto divide-y">
                  {Object.values(openTabsByStudent).map((group) => (
                    <div key={group.studentId} className="bg-background">
                      <div className="flex items-center justify-between gap-2 px-3 py-2 bg-muted/40">
                        <div className="text-sm font-semibold">{group.studentName || "Unnamed Student"}</div>
                        <Button type="button" variant="ghost" size="sm" className="h-7 text-xs text-destructive hover:text-destructive" onClick={() => closeTabsMutation.mutate({ closeAll: true, studentIds: [group.studentId] })} disabled={closeTabsMutation.isPending}>
                          Close all
                        </Button>
                      </div>
                      {group.tabs.map((tab) => {
                        const compositeKey = makeTabKey(tab);
                        const hostname = (() => { try { return new URL(tab.url).hostname; } catch { return tab.url; } })();
                        return (
                          <div key={compositeKey} className="flex items-center gap-3 p-3 hover:bg-muted/50 group" data-testid={`tab-row-${tab.studentId}-${encodeURIComponent(tab.url)}`}>
                            <input type="checkbox" className="h-4 w-4 shrink-0" checked={selectedTabsToClose.has(compositeKey)} onChange={(e) => { const newSet = new Set(selectedTabsToClose); if (e.target.checked) newSet.add(compositeKey); else newSet.delete(compositeKey); setSelectedTabsToClose(newSet); }} data-testid={`checkbox-tab-${encodeURIComponent(tab.url)}`} />
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center gap-2"><span className="text-sm font-medium truncate">{tab.title}</span>{tab.active && <Badge variant="secondary" className="text-[10px] px-1.5 py-0">Active</Badge>}</div>
                              <div className="text-xs text-muted-foreground truncate">{hostname}</div>
                            </div>
                            <Button type="button" variant="ghost" size="icon" className="h-7 w-7 shrink-0 opacity-50 group-hover:opacity-100 hover:bg-destructive/10 hover:text-destructive" onClick={() => handleCloseSingleTab(tab)} disabled={closeTabsMutation.isPending} title="Close this tab" data-testid={`button-close-tab-${encodeURIComponent(tab.url)}`}>
                              <X className="h-4 w-4" />
                            </Button>
                          </div>
                        );
                      })}
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>
          <DialogFooter className="flex-col sm:flex-row gap-2">
            <Button variant="outline" onClick={() => setShowCloseTabsDialog(false)} data-testid="button-close-tabs-dialog">Done</Button>
            {selectedTabsToClose.size > 0 && <Button variant="destructive" onClick={handleCloseTabs} disabled={closeTabsMutation.isPending} data-testid="button-close-selected-tabs"><X className="h-4 w-4 mr-2" />Close Selected ({selectedTabsToClose.size})</Button>}
            {openTabs.length > 0 && <Button variant="destructive" onClick={() => { closeTabsMutation.mutate({ closeAll: true, studentIds: manageTabsStudents.map((student) => student.studentId) }); }} disabled={closeTabsMutation.isPending} data-testid="button-close-all-tabs"><TabletSmartphone className="h-4 w-4 mr-2" />Close All Tabs</Button>}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Apply Flight Path Dialog */}
      <Dialog open={showApplyFlightPathDialog} onOpenChange={setShowApplyFlightPathDialog}>
        <DialogContent data-testid="dialog-apply-flight-path">
          <DialogHeader><DialogTitle>Apply Flight Path to Students</DialogTitle><DialogDescription>{selectedStudentIds.size > 0 ? `Apply a flight path to ${selectedStudentIds.size} selected student(s)` : "Apply a flight path to all students"}</DialogDescription></DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="flight-path-select">Select Flight Path</Label>
              <Select value={selectedFlightPathId} onValueChange={setSelectedFlightPathId}>
                <SelectTrigger id="flight-path-select" data-testid="select-flight-path"><SelectValue placeholder="Choose a flight path" /></SelectTrigger>
                <SelectContent>
                  {flightPaths.map((fp) => (<SelectItem key={fp.id} value={fp.id} data-testid={`option-flight-path-${fp.id}`}>{fp.flightPathName}</SelectItem>))}
                  {flightPaths.length === 0 && <div className="p-2 text-sm text-muted-foreground">No flight paths available</div>}
                </SelectContent>
              </Select>
              {selectedFlightPathId && (() => {
                const fp = flightPaths.find(f => f.id === selectedFlightPathId);
                return fp ? (
                  <div className="mt-2 p-3 bg-muted/30 rounded-md">
                    <p className="text-xs font-medium mb-1">Description:</p><p className="text-xs text-muted-foreground mb-2">{fp.description || "No description provided"}</p>
                    <p className="text-xs font-medium mb-1">Allowed Domains ({fp.allowedDomains?.length || 0}):</p>
                    <div className="flex flex-wrap gap-1">{fp.allowedDomains && fp.allowedDomains.length > 0 ? fp.allowedDomains.map((domain, idx) => (<Badge key={idx} variant="secondary" className="text-xs">{domain}</Badge>)) : <p className="text-xs text-muted-foreground">No restrictions</p>}</div>
                  </div>
                ) : null;
              })()}
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowApplyFlightPathDialog(false)} data-testid="button-cancel-apply-flight-path">Cancel</Button>
            <Button onClick={handleApplyFlightPath} disabled={applyFlightPathMutation.isPending} data-testid="button-confirm-apply-flight-path"><Layers className="h-4 w-4 mr-2" />Apply Flight Path</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Flight Path Viewer Dialog */}
      <Dialog open={showFlightPathViewerDialog} onOpenChange={setShowFlightPathViewerDialog}>
        <DialogContent className="max-w-2xl" data-testid="dialog-flight-path-viewer">
          <DialogHeader><DialogTitle>Flight Path Status</DialogTitle><DialogDescription>View which flight paths students are currently on</DialogDescription></DialogHeader>
          <div className="max-h-[400px] overflow-y-auto">
            <table className="w-full">
              <thead className="border-b sticky top-0 bg-background"><tr><th className="text-left p-2 text-sm font-medium">Student</th><th className="text-left p-2 text-sm font-medium">Flight Path</th><th className="text-left p-2 text-sm font-medium">Status</th><th className="text-left p-2 text-sm font-medium">Actions</th></tr></thead>
              <tbody>
                {students.map((student) => {
                  return (
                    <tr key={student.studentId} className="border-b" data-testid={`row-student-${student.studentId}`}>
                      <td className="p-2 text-sm">{student.studentName}</td>
                      <td className="p-2">{student.flightPathActive && student.activeFlightPathName ? <Badge variant="secondary" className="text-xs" data-testid={`badge-flight-path-${student.studentId}`}>{student.activeFlightPathName}</Badge> : <span className="text-xs text-muted-foreground">No flight path</span>}</td>
                      <td className="p-2"><Badge variant={student.status === 'online' ? 'default' : student.status === 'idle' ? 'secondary' : 'outline'} className="text-xs" data-testid={`badge-status-${student.studentId}`}>{student.status}</Badge></td>
                      <td className="p-2">
                        {student.flightPathActive && student.isLoggedIn ? (
                          <Button size="sm" variant="ghost" onClick={() => handleRemoveFlightPath(student.studentId)} disabled={removeFlightPathMutation.isPending} data-testid={`button-remove-flight-path-${student.studentId}`} className="h-7 px-2 text-xs text-destructive hover:text-destructive hover:bg-destructive/10"><X className="h-3 w-3 mr-1" />Remove</Button>
                        ) : student.screenLocked && student.isLoggedIn ? (
                          <Button size="sm" variant="outline" onClick={() => unlockScreenMutation.mutate({ studentIds: [student.studentId] })} disabled={unlockScreenMutation.isPending} data-testid={`button-unlock-screen-${student.studentId}`} className="h-7 px-2 text-xs"><Unlock className="h-3 w-3 mr-1" />Unlock</Button>
                        ) : <span className="text-xs text-muted-foreground">&mdash;</span>}
                      </td>
                    </tr>
                  );
                })}
                {students.length === 0 && <tr><td colSpan={4} className="p-4 text-center text-sm text-muted-foreground">No students found</td></tr>}
              </tbody>
            </table>
          </div>
          <DialogFooter><Button onClick={() => setShowFlightPathViewerDialog(false)} data-testid="button-close-flight-path-viewer">Close</Button></DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Apply Block List Dialog */}
      <Dialog open={showApplyBlockListDialog} onOpenChange={setShowApplyBlockListDialog}>
        <DialogContent data-testid="dialog-apply-block-list">
          <DialogHeader><DialogTitle>Apply Block List to Students</DialogTitle><DialogDescription>{selectedStudentIds.size > 0 ? `Apply a block list to ${selectedStudentIds.size} selected student(s)` : "Apply a block list to all online students"}</DialogDescription></DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="block-list-select">Select Block List</Label>
              <Select value={selectedBlockListId} onValueChange={setSelectedBlockListId}>
                <SelectTrigger id="block-list-select" data-testid="select-block-list"><SelectValue placeholder="Choose a block list" /></SelectTrigger>
                <SelectContent>
                  {blockLists.map((bl) => (<SelectItem key={bl.id} value={bl.id} data-testid={`option-block-list-${bl.id}`}>{bl.name}</SelectItem>))}
                  {blockLists.length === 0 && <div className="p-2 text-sm text-muted-foreground">No block lists available. Create one in My Settings.</div>}
                </SelectContent>
              </Select>
              {selectedBlockListId && (() => {
                const bl = blockLists.find(b => b.id === selectedBlockListId);
                return bl ? (
                  <div className="mt-2 p-3 bg-muted/30 rounded-md">
                    <p className="text-xs font-medium mb-1">Description:</p><p className="text-xs text-muted-foreground mb-2">{bl.description || "No description provided"}</p>
                    <p className="text-xs font-medium mb-1">Blocked Domains ({bl.blockedDomains?.length || 0}):</p>
                    <div className="flex flex-wrap gap-1">{bl.blockedDomains && bl.blockedDomains.length > 0 ? bl.blockedDomains.map((domain, idx) => (<Badge key={idx} variant="destructive" className="text-xs">{domain}</Badge>)) : <p className="text-xs text-muted-foreground">No domains</p>}</div>
                  </div>
                ) : null;
              })()}
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowApplyBlockListDialog(false)} data-testid="button-cancel-apply-block-list">Cancel</Button>
            <Button onClick={handleApplyBlockList} disabled={applyBlockListMutation.isPending || !selectedBlockListId} data-testid="button-confirm-apply-block-list"><ShieldBan className="h-4 w-4 mr-2" />Apply Block List</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Block List Viewer Dialog */}
      <Dialog open={showBlockListViewerDialog} onOpenChange={setShowBlockListViewerDialog}>
        <DialogContent className="max-w-2xl" data-testid="dialog-block-list-viewer">
          <DialogHeader><DialogTitle>Block List Status</DialogTitle><DialogDescription>Manage active block lists for your students. Block lists are session-based and will be removed when students disconnect.</DialogDescription></DialogHeader>
          <div className="space-y-4">
            <div className="flex items-center justify-between p-3 bg-muted/30 rounded-md">
              <div><p className="text-sm font-medium">Remove Block List from All Students</p><p className="text-xs text-muted-foreground">This will remove any teacher-applied block list from all online students</p></div>
              <Button variant="outline" size="sm" onClick={handleRemoveBlockList} disabled={removeBlockListMutation.isPending} className="text-destructive hover:text-destructive" data-testid="button-remove-all-block-lists"><X className="h-4 w-4 mr-2" />Remove All</Button>
            </div>
            <div className="border-t pt-4">
              <p className="text-sm font-medium mb-2">Your Block Lists</p>
              {blockLists.length === 0 ? <p className="text-sm text-muted-foreground">No block lists created yet. Create one in My Settings.</p> : (
                <div className="space-y-2 max-h-[250px] overflow-y-auto">
                  {blockLists.map((bl) => (
                    <div key={bl.id} className="flex items-center justify-between p-3 border rounded-md" data-testid={`block-list-item-${bl.id}`}>
                      <div className="flex-1">
                        <p className="text-sm font-medium">{bl.name}</p>
                        <div className="flex flex-wrap gap-1 mt-1">
                          {bl.blockedDomains?.slice(0, 3).map((domain, idx) => (<Badge key={idx} variant="secondary" className="text-xs">{domain}</Badge>))}
                          {(bl.blockedDomains?.length || 0) > 3 && <Badge variant="secondary" className="text-xs">+{(bl.blockedDomains?.length || 0) - 3} more</Badge>}
                        </div>
                      </div>
                      <Button variant="outline" size="sm" onClick={() => { setSelectedBlockListId(bl.id); setShowBlockListViewerDialog(false); setShowApplyBlockListDialog(true); }} data-testid={`button-quick-apply-${bl.id}`}><ShieldBan className="h-4 w-4 mr-2" />Apply</Button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
          <DialogFooter><Button onClick={() => setShowBlockListViewerDialog(false)} data-testid="button-close-block-list-viewer">Close</Button></DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Send Message Dialog */}
      <Dialog open={showSendMessageDialog} onOpenChange={setShowSendMessageDialog}>
        <DialogContent data-testid="dialog-send-message">
          <DialogHeader>
            <DialogTitle>Send Message</DialogTitle>
            <DialogDescription>{selectedStudentIds.size > 0 ? `Send a message to ${selectedStudentIds.size} selected student(s)` : "Send a message to all online students"}</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <textarea
              className="w-full min-h-[100px] p-3 border rounded-md text-sm resize-none focus:outline-none focus:ring-2 focus:ring-ring"
              placeholder="Type your message..."
              value={sendMessageText}
              onChange={(e) => setSendMessageText(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSendMessage(); } }}
              data-testid="input-send-message"
            />
            <p className="text-xs text-muted-foreground">Press Enter to send, Shift+Enter for new line</p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowSendMessageDialog(false)}>Cancel</Button>
            <Button onClick={handleSendMessage} disabled={sendMessageMutation.isPending || !sendMessageText.trim()} data-testid="button-confirm-send-message">
              <Send className="h-4 w-4 mr-2" />Send Message
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Attention Mode Dialog */}
      <Dialog open={showAttentionDialog} onOpenChange={setShowAttentionDialog}>
        <DialogContent data-testid="dialog-attention-mode">
          <DialogHeader><DialogTitle>{attentionActive ? "Attention Restriction Saved" : "Attention Mode"}</DialogTitle><DialogDescription>{attentionActive ? "The attention restriction is saved. Delivery may still be pending for some students." : selectedStudentIds.size > 0 ? `Get the attention of ${selectedStudentIds.size} selected student(s)` : "Get the attention of all students"}</DialogDescription></DialogHeader>
          {attentionActive ? (
            <div className="space-y-4 py-4">
              <div className="flex items-center justify-center p-6 bg-indigo-50 rounded-lg">
                <div className="text-center">
                  <Eye className="h-12 w-12 mx-auto mb-3 text-indigo-600" />
                  <p className="text-lg font-medium text-indigo-900">"{attentionMessage}"</p>
                  <p className="text-sm text-indigo-600 mt-2">Saved for student screens; device acknowledgements are shown in control health</p>
                </div>
              </div>
            </div>
          ) : (
            <div className="space-y-4 py-4">
              <div className="space-y-2">
                <Label htmlFor="attention-message">Message to Display</Label>
                <Input id="attention-message" value={attentionMessage} onChange={(e) => setAttentionMessage(e.target.value)} placeholder="Please look up!" data-testid="input-attention-message" />
                <p className="text-xs text-muted-foreground">This message will be shown full-screen on student devices until you release them.</p>
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowAttentionDialog(false)} data-testid="button-cancel-attention">{attentionActive ? "Close" : "Cancel"}</Button>
            {attentionActive ? (
              <Button onClick={() => { handleAttentionMode(false); setShowAttentionDialog(false); }} disabled={attentionModeMutation.isPending} variant="destructive" data-testid="button-release-attention"><EyeOff className="h-4 w-4 mr-2" />Release Students</Button>
            ) : (
              <Button onClick={() => handleAttentionMode(true)} disabled={attentionModeMutation.isPending} className="bg-indigo-600 hover:bg-indigo-700" data-testid="button-activate-attention"><Eye className="h-4 w-4 mr-2" />Activate Attention Mode</Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Timer Dialog */}
      <Dialog open={showTimerDialog} onOpenChange={setShowTimerDialog}>
        <DialogContent data-testid="dialog-timer">
          <DialogHeader><DialogTitle>Start Timer</DialogTitle><DialogDescription>{selectedStudentIds.size > 0 ? `Display a countdown timer for ${selectedStudentIds.size} selected student(s)` : "Display a countdown timer for all students"}</DialogDescription></DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label>Quick Presets</Label>
              <div className="flex gap-2 flex-wrap">
                <Button variant="outline" size="sm" onClick={() => { setTimerMinutes(1); setTimerSeconds(0); }} data-testid="button-timer-1min">1 min</Button>
                <Button variant="outline" size="sm" onClick={() => { setTimerMinutes(3); setTimerSeconds(0); }} data-testid="button-timer-3min">3 min</Button>
                <Button variant="outline" size="sm" onClick={() => { setTimerMinutes(5); setTimerSeconds(0); }} data-testid="button-timer-5min">5 min</Button>
                <Button variant="outline" size="sm" onClick={() => { setTimerMinutes(10); setTimerSeconds(0); }} data-testid="button-timer-10min">10 min</Button>
                <Button variant="outline" size="sm" onClick={() => { setTimerMinutes(15); setTimerSeconds(0); }} data-testid="button-timer-15min">15 min</Button>
              </div>
            </div>
            <div className="space-y-2">
              <Label>Custom Time</Label>
              <div className="flex items-center gap-2">
                <Input type="number" min="0" max="60" value={timerMinutes} onChange={(e) => setTimerMinutes(Math.max(0, Math.min(60, parseInt(e.target.value) || 0)))} className="w-20" data-testid="input-timer-minutes" />
                <span className="text-sm text-muted-foreground">min</span>
                <Input type="number" min="0" max="59" value={timerSeconds} onChange={(e) => setTimerSeconds(Math.max(0, Math.min(59, parseInt(e.target.value) || 0)))} className="w-20" data-testid="input-timer-seconds" />
                <span className="text-sm text-muted-foreground">sec</span>
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="timer-message">Optional Message</Label>
              <Input id="timer-message" value={timerMessage} onChange={(e) => setTimerMessage(e.target.value)} placeholder="e.g., Complete the assignment" data-testid="input-timer-message" />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowTimerDialog(false)} data-testid="button-cancel-timer">Cancel</Button>
            <Button onClick={handleStartTimer} disabled={timerMutation.isPending || timerDeliveryPending} className="bg-teal-600 hover:bg-teal-700" data-testid="button-start-timer"><Timer className="h-4 w-4 mr-2" />Start Timer</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Create Poll Dialog */}
      <Dialog open={showPollDialog} onOpenChange={setShowPollDialog}>
        <DialogContent className="max-w-lg" data-testid="dialog-poll">
          <DialogHeader><DialogTitle>Create Poll</DialogTitle><DialogDescription>{selectedStudentIds.size > 0 ? `Send a poll to ${selectedStudentIds.size} selected student(s)` : "Send a poll to all students"}</DialogDescription></DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="poll-question">Question</Label>
              <Input id="poll-question" value={pollQuestion} onChange={(e) => setPollQuestion(e.target.value)} placeholder="What do you think about...?" data-testid="input-poll-question" />
            </div>
            <div className="space-y-2">
              <Label>Options (2-5)</Label>
              <div className="space-y-2">
                {pollOptions.map((option, index) => (
                  <div key={index} className="flex items-center gap-2">
                    <span className="w-6 h-6 rounded-full bg-violet-100 dark:bg-violet-900 text-violet-600 dark:text-violet-400 flex items-center justify-center text-sm font-medium flex-shrink-0">{String.fromCharCode(65 + index)}</span>
                    <Input value={option} onChange={(e) => updatePollOption(index, e.target.value)} placeholder={`Option ${String.fromCharCode(65 + index)}`} data-testid={`input-poll-option-${index}`} />
                    {pollOptions.length > 2 && <Button variant="ghost" size="sm" onClick={() => removePollOption(index)} className="text-destructive hover:text-destructive" data-testid={`button-remove-option-${index}`}><Trash2 className="h-4 w-4" /></Button>}
                  </div>
                ))}
              </div>
              {pollOptions.length < 5 && <Button variant="outline" size="sm" onClick={addPollOption} className="w-full mt-2" data-testid="button-add-option"><Plus className="h-4 w-4 mr-2" />Add Option</Button>}
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowPollDialog(false)} data-testid="button-cancel-poll">Cancel</Button>
            <Button onClick={handleCreatePoll} disabled={pollMutation.isPending || pollDeliveryPending} className="bg-violet-600 hover:bg-violet-700" data-testid="button-create-poll"><BarChart3 className="h-4 w-4 mr-2" />Create Poll</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Poll Results Dialog */}
      <Dialog open={showPollResultsDialog} onOpenChange={setShowPollResultsDialog}>
        <DialogContent className="max-w-lg" data-testid="dialog-poll-results">
          <DialogHeader><DialogTitle>Poll Results</DialogTitle><DialogDescription>{activePoll?.question}</DialogDescription></DialogHeader>
          <div className="space-y-4 py-4">
            <div className="text-center text-2xl font-bold text-violet-600 dark:text-violet-400">{pollTotalResponses} response{pollTotalResponses !== 1 ? 's' : ''}</div>
            <div className="space-y-3">
              {activePoll?.options.map((option, index) => {
                const result = pollResults.find(r => r.option === index);
                const count = result?.count || 0;
                const percentage = pollTotalResponses > 0 ? Math.round((count / pollTotalResponses) * 100) : 0;
                return (
                  <div key={index} className="space-y-1">
                    <div className="flex items-center justify-between text-sm">
                      <div className="flex items-center gap-2">
                        <span className="w-6 h-6 rounded-full bg-violet-100 dark:bg-violet-900 text-violet-600 dark:text-violet-400 flex items-center justify-center text-xs font-medium">{String.fromCharCode(65 + index)}</span>
                        <span>{option}</span>
                      </div>
                      <span className="font-medium">{count} ({percentage}%)</span>
                    </div>
                    <div className="h-4 bg-muted rounded-full overflow-hidden"><div className="h-full bg-gradient-to-r from-violet-500 to-purple-500 rounded-full transition-all duration-500" style={{ width: `${percentage}%` }} /></div>
                  </div>
                );
              })}
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowPollResultsDialog(false)} data-testid="button-close-results">Close</Button>
            <Button variant="destructive" onClick={handleClosePoll} disabled={closePollMutation.isPending || pollDeliveryPending} data-testid="button-end-poll"><X className="h-4 w-4 mr-2" />End Poll</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* TeacherFab */}
      {((isTeacher && activeSession) || (isAdmin && isAdminTeaching)) && (
        <TeacherFab
          attentionActive={attentionActive}
          onAttentionClick={() => setShowAttentionDialog(true)}
          attentionPending={attentionModeMutation.isPending}
          timerActive={timerActive}
          onTimerClick={() => timerActive ? handleStopTimer() : setShowTimerDialog(true)}
          timerPending={timerMutation.isPending || timerDeliveryPending}
          activePoll={activePoll}
          pollTotalResponses={pollTotalResponses}
          onPollClick={() => activePoll ? setShowPollResultsDialog(true) : setShowPollDialog(true)}
          pollPending={pollMutation.isPending || closePollMutation.isPending || pollDeliveryPending}
          raisedHands={raisedHands}
          onDismissHand={(studentId) => dismissHandMutation.mutate(studentId)}
          handRaisingEnabled={settings?.handRaisingEnabled !== false}
          onToggleHandRaising={(enabled) => toggleHandRaisingMutation.mutate(enabled)}
          studentMessages={studentMessages}
          onMarkMessageRead={markMessageRead}
          onDismissMessage={dismissMessage}
          onReplyToMessage={(studentId, message) => {
            return replyToMessageMutation.mutateAsync({ sessionId: effectiveSession?.id, studentId, message });
          }}
          replyPending={replyToMessageMutation.isPending}
          studentMessagingEnabled={settings?.studentMessagingEnabled !== false}
          onToggleStudentMessaging={(enabled) => toggleStudentMessagingMutation.mutate(enabled)}
          chatReplies={chatReplies}
          onCloseChat={closeChat}
          onSendMessage={() => setShowSendMessageDialog(true)}
        />
      )}
    </div>
  );
}
