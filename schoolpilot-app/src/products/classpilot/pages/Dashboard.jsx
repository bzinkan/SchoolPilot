import { useState, useEffect, useLayoutEffect, useMemo, useRef, useCallback, useDeferredValue } from "react";
import { useQuery, useQueries, useMutation } from "@tanstack/react-query";
import { useNavigate } from 'react-router-dom';
import { Monitor, Users, Activity, Settings as SettingsIcon, LogOut, Calendar, Shield, AlertTriangle, UserCog, Plus, X, GraduationCap, WifiOff, Video, MonitorPlay, TabletSmartphone, Lock, Unlock, Layers, CheckSquare, XSquare, User, UserCheck, List, ShieldBan, Eye, EyeOff, Timer, Clock, BarChart3, Trash2, UsersRound, Filter, Hand, MessageSquareOff, MessageSquare, Send, ClipboardCheck, RefreshCw } from "lucide-react";
import { Button } from '../../../components/ui/button';
import { Input } from '../../../components/ui/input';
import { Badge } from '../../../components/ui/badge';
import StudentTile from '../components/StudentTile';
import VideoPortal from '../components/VideoPortal';
import ScreenshotPreviewDialog from '../components/ScreenshotPreviewDialog';
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
import {
  TILE_BATCH_QUERY_ROOTS,
  TILE_SCREENSHOT_CACHE_GC_MS,
  changedTileBindingStudentIds,
  createTileBatchRequests,
  fetchTileBatch,
  indexTileHistory,
  indexTileScreenshots,
  mergeTargetedTileScreenshotResponse,
  normalizedTileControlRevision,
  removeLegacyScreenshotsFromTileBatchData,
  removeStudentsFromTileBatchData,
  retainFreshTileScreenshotsOnNull,
  tileBatchRequestShouldPoll,
} from '../lib/tileBatchPolling';
import {
  purgeAllStudentTileCaches,
  purgeLegacyScreenshotTileCaches,
  reconcileStudentTileBindingCaches,
  scrubStudentTileCaches,
  purgeStudentHistoryTileCaches,
  purgeStudentScreenshotTileCaches,
  purgeStudentTileCaches,
  tileBatchFailureScope,
} from '../lib/tileCachePrivacy';
import { createSubgroupMembersQuery } from '../lib/subgroupMembersQuery';
import {
  applyStudentRealtimeEvents,
  aggregateSnapshotHasStudent,
  coalesceStudentRealtimeEvents,
  deriveAggregatedStudentsPresentation,
  makeAggregatedStudentsQueryKey,
  mergeAggregatedStudents,
} from '../lib/studentRealtimeCache';
import {
  deriveScreenshotDisplay,
  deriveStudentMonitoringDisplay,
  findNextStudentFreshnessBoundary,
  formatAbsoluteObservedAt,
  lastObservedDomain,
  projectStudentMonitoringDisplays,
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
  assertClassroomCommandSelectionIsolation,
  buildStudentSignOutCommandRequest,
  combineCommandSettlements,
  DOMAIN_RESTRICTION_URL_HELP,
  commandSupportsLateSignInRestriction,
  deriveDashboardCapabilities,
  domainRestrictionMessageForStudents,
  effectiveStudentRestrictions,
  exactTabCloseCapability,
  flightPathApplyCapability,
  isLateSignInRestrictionTarget,
  isStudentUrlOffTask,
  lateSignInRestrictionGateEnabled,
  normalizeSessionFabState,
  parseTabSelectionKey,
  partitionCurrentPageWaypointTargets,
  resolveCommandTargets,
  resolveStudentSignOutTargets,
  studentSignOutSelectionBinding,
  studentSupportsCapability,
  studentSignOutCommandPayload,
  sessionFabSettingsPayload,
  tabSelectionKey,
  toolbarScreenCommand,
  uniqueStudentsById,
} from '../lib/dashboardCommandContext';
import {
  className as scheduleClassName,
  effectiveWindow,
  formatWindow as formatScheduleWindow,
  invalidateScheduleChanges,
  scheduleChangeApi,
  scheduleChangeKeys,
  unwrapToday,
} from '../lib/scheduleChanges';
import { useObservationLease } from '../hooks/useObservationLease';
import { useTileViewport } from '../hooks/useTileViewport';
import { classpilotReconciliationIntervalMs } from '../lib/monitoringReconciliation';
import { reconcileGraceCohort } from '../lib/graceReconciliation';

const EMPTY_LIST = Object.freeze([]);
const EMPTY_TILE_MAP = new Map();
const EMPTY_PICKUP_DATA = Object.freeze({
  students: EMPTY_LIST,
  scheduledCoverageGroups: EMPTY_LIST,
});
const EMPTY_LIVE_VIEW = Object.freeze({
  studentId: null,
  studentName: '',
  stream: null,
  pending: false,
  expanded: false,
});
const REQUEST_ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;
const SESSION_SUBSCRIPTION_ACK_TIMEOUT_MS = 5_000;
const SESSION_SUBSCRIPTION_RETRY_MS = Object.freeze([1_000, 2_000, 5_000, 10_000, 30_000]);
const SCREENSHOT_EVENT_COALESCE_MS = 1_000;
const SCREENSHOT_EVENT_RATE_LIMIT_MS = 1_000;
// The WebRTC implementation remains dormant for a future managed-Chromebook
// validation, but screenshots are the only student-tile viewing surface.
const LIVE_VIEW_UI_ENABLED = false;
const CLASSROOM_SELECTION_STORAGE_PREFIX = "classpilot:classroom-selection:v1";
const classroomSelectionCache = new Map();

function normalizeAggregatedStudentsResponse(data) {
  if (Array.isArray(data)) return data;
  if (data && typeof data === 'object' && Array.isArray(data.students)) return data.students;
  throw new Error('Student data response did not match the expected contract.');
}

function normalizedRequestId(value) {
  if (typeof value !== 'string') return null;
  return REQUEST_ID_PATTERN.test(value) ? value : null;
}

function createRealtimeRequestId(prefix = 'session') {
  const random = globalThis.crypto?.randomUUID?.()
    || `${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
  return `${prefix}_${String(random).replace(/[^A-Za-z0-9._-]/g, '_')}`.slice(0, 128);
}

function realtimeMessageSessionId(message) {
  return message?.teachingSessionId
    || message?.sessionId
    || message?.data?.teachingSessionId
    || message?.data?.sessionId
    || null;
}

function requestIdFromError(error) {
  const bodyRequestId = normalizedRequestId(error?.response?.data?.requestId);
  if (bodyRequestId) return bodyRequestId;

  const headers = error?.response?.headers;
  const headerValue = typeof headers?.get === 'function'
    ? headers.get('x-request-id')
    : headers?.['x-request-id'];
  return normalizedRequestId(headerValue);
}

function classroomSelectionStorageKey(scope, userId, schoolId) {
  if (!scope || !userId || !schoolId) return null;
  return `${CLASSROOM_SELECTION_STORAGE_PREFIX}:${scope}:${encodeURIComponent(userId)}:${encodeURIComponent(schoolId)}`;
}

function readClassroomSelection(storageKey) {
  if (!storageKey) return "";
  if (classroomSelectionCache.has(storageKey)) {
    return classroomSelectionCache.get(storageKey);
  }

  try {
    const groupId = globalThis.window?.sessionStorage?.getItem(storageKey) || "";
    classroomSelectionCache.set(storageKey, groupId);
    return groupId;
  } catch {
    return "";
  }
}

function writeClassroomSelection(storageKey, groupId) {
  if (!storageKey) return;

  if (groupId) classroomSelectionCache.set(storageKey, groupId);
  else classroomSelectionCache.delete(storageKey);

  try {
    const storage = globalThis.window?.sessionStorage;
    if (!storage) return;
    if (groupId) storage.setItem(storageKey, groupId);
    else storage.removeItem(storageKey);
  } catch {
    // Keep the in-memory selection for this SPA lifetime when storage is denied.
  }
}

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

function isStudentInTemporarySupervision(student) {
  return student?.supervisionState === "temporary_coverage";
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
  const teacherClassroomSelectionKey = classroomSelectionStorageKey("teacher", currentUser?.id, school?.id);
  const adminClassroomSelectionKey = classroomSelectionStorageKey("admin", currentUser?.id, school?.id);
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
  const [expandedScreenshot, setExpandedScreenshot] = useState(null);
  const [selectedStudentIds, setSelectedStudentIds] = useState(new Set());
  const [selectedServerSignOutStudentIds, setSelectedServerSignOutStudentIds] = useState(new Set());
  const [selectedStudentBindingSnapshots, setSelectedStudentBindingSnapshots] = useState(new Map());
  const [searchQuery, setSearchQuery] = useState("");
  const deferredSearchQuery = useDeferredValue(searchQuery);
  const [selectedGrade, setSelectedGrade] = useState(() => {
    try {
      const saved = localStorage.getItem('classpilot-selected-grade');
      return saved || "";
    } catch {
      return "";
    }
  });
  const [wsConnected, setWsConnected] = useState(false);
  const [liveViewState, setLiveViewState] = useState(EMPTY_LIVE_VIEW);
  const [teacherAllowedDomains, setTeacherAllowedDomains] = useState(new Set());
  const teacherAllowedDomainPatterns = useMemo(
    () => Array.from(teacherAllowedDomains),
    [teacherAllowedDomains],
  );
  const [showGradeDialog, setShowGradeDialog] = useState(false);
  const [newGrade, setNewGrade] = useState("");
  const [showOpenTabDialog, setShowOpenTabDialog] = useState(false);
  const [openTabUrl, setOpenTabUrl] = useState("");
  const [showLockScreenDialog, setShowLockScreenDialog] = useState(false);
  const [lockScreenMode, setLockScreenMode] = useState("current");
  const [lockScreenUrl, setLockScreenUrl] = useState("");
  const [showCloseTabsDialog, setShowCloseTabsDialog] = useState(false);
  const [selectedTabsToClose, setSelectedTabsToClose] = useState(new Set());
  const [manageTabsStudentIds, setManageTabsStudentIds] = useState(null);
  const [manageTabsTargetSnapshot, setManageTabsTargetSnapshot] = useState("");
  const [showApplyFlightPathDialog, setShowApplyFlightPathDialog] = useState(false);
  const [selectedFlightPathId, setSelectedFlightPathId] = useState("");
  const [showFlightPathViewerDialog, setShowFlightPathViewerDialog] = useState(false);
  const [showApplyBlockListDialog, setShowApplyBlockListDialog] = useState(false);
  const [selectedBlockListId, setSelectedBlockListId] = useState("");
  const [showSendMessageDialog, setShowSendMessageDialog] = useState(false);
  const [sendMessageText, setSendMessageText] = useState("");
  const [showSignOutDialog, setShowSignOutDialog] = useState(false);
  const [signOutTargetSnapshot, setSignOutTargetSnapshot] = useState("");
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
  const [raisedHands, setRaisedHands] = useState(new Map());
  const [studentMessages, setStudentMessages] = useState([]);
  const [chatReplies, setChatReplies] = useState({});
  const [sessionFabState, setSessionFabState] = useState(null);
  const [startGroupId, setStartGroupId] = useState(() => readClassroomSelection(teacherClassroomSelectionKey));
  const [adminStartGroupId, setAdminStartGroupId] = useState(() => readClassroomSelection(adminClassroomSelectionKey));
  const [classStartOverlap, setClassStartOverlap] = useState(null);
  const [classResyncOverlap, setClassResyncOverlap] = useState(null);
  const [endClassTarget, setEndClassTarget] = useState(null);
  const [sessionReportTarget, setSessionReportTarget] = useState(null);
  const [showLogoutDialog, setShowLogoutDialog] = useState(false);
  const [skipTodayGroup, setSkipTodayGroup] = useState(null);
  const [logoutPending, setLogoutPending] = useState(false);
  const [quickClaimStudentId, setQuickClaimStudentId] = useState(null);
  const [tileCommandState, setTileCommandState] = useState({});
  const dismissedMessageIds = useRef(new Set());
  const dismissedMessagesInitialized = useRef(false);
  if (!dismissedMessagesInitialized.current) {
    dismissedMessagesInitialized.current = true;
    try {
      const saved = localStorage.getItem('classpilot-dismissed-messages');
      if (saved) {
        const ids = JSON.parse(saved);
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
  const websocketGenerationRef = useRef(0);
  const invalidateTimeoutRef = useRef(null);
  const realtimeFlushTimeoutRef = useRef(null);
  const pendingRealtimeEventsRef = useRef([]);
  const screenshotRefetchTimeoutRef = useRef(null);
  const lastScreenshotRefetchAtRef = useRef(0);
  const pendingScreenshotStudentIdsRef = useRef(new Set());
  const targetedScreenshotFlushRef = useRef(() => Promise.resolve());
  const targetedScreenshotContextRef = useRef(null);
  const targetedScreenshotFenceGenerationRef = useRef({ key: null, generation: 0 });
  const targetedScreenshotAbortControllersRef = useRef(new Set());
  const expandedScreenshotOpenerRef = useRef(null);
  const restoreExpandedScreenshotFocusRef = useRef(false);
  const expandedScreenshotContextGenerationRef = useRef({ key: null, generation: 0 });
  const freshnessTimeoutRef = useRef(null);
  const graceReconciliationLatchRef = useRef({ scopeKey: null, cohortActive: false });
  const commandExpiryTimeoutRef = useRef(null);
  const transientCommandOutcomesRef = useRef(new Map());
  const aggregatedStudentsQueryKeyRef = useRef(null);
  const activeSchoolIdRef = useRef(null);
  const authenticatedSchoolIdRef = useRef(null);
  const sessionSubscriptionAckTimeoutRef = useRef(null);
  const sessionSubscriptionRetryTimeoutRef = useRef(null);
  const sessionSubscriptionAttemptRef = useRef(0);
  const sessionSubscriptionGenerationRef = useRef(0);
  const sessionSubscriptionPendingRef = useRef(null);
  const sessionSubscriptionStateRef = useRef({ status: 'not_applicable', sessionId: null });
  const reconciliationSeedRef = useRef(null);
  if (!reconciliationSeedRef.current) {
    reconciliationSeedRef.current = createRealtimeRequestId('reconcile');
  }
  const studentViewRef = useRef(studentView);
  studentViewRef.current = studentView;
  const maxReconnectDelay = 30000;
  const [wsAuthenticated, setWsAuthenticated] = useState(false);
  const [sessionSubscriptionState, setSessionSubscriptionState] = useState({
    status: 'not_applicable',
    sessionId: null,
    errorCode: null,
  });
  const [tileGlobalAuthorizationDenied, setTileGlobalAuthorizationDenied] = useState(false);
  const [targetedScreenshotFailureByStudent, setTargetedScreenshotFailureByStudent] = useState(() => new Map());
  sessionSubscriptionStateRef.current = sessionSubscriptionState;
  const [freshnessVersion, setFreshnessVersion] = useState(0);
  const freshnessNowMs = Date.now();
  const [aggregateReconciliation, setAggregateReconciliation] = useState({
    key: null,
    succeededAtMs: null,
  });
  const [transientCommandVersion, setTransientCommandVersion] = useState(0);
  const [transientPendingControls, setTransientPendingControls] = useState({
    timer: false,
    poll: false,
  });
  const effectiveSessionIdRef = useRef(null);
  const LIVE_VIEW_TIMEOUT_MS = 15 * 60 * 1000;
  const LIVE_VIEW_CONNECT_TIMEOUT_MS = 12000;
  const activeLiveViewStudentIdRef = useRef(null);
  const liveViewGenerationRef = useRef(0);
  const liveViewTimerRef = useRef(null);
  const liveViewConnectTimerRef = useRef(null);

  const queueTargetedScreenshotRefresh = useCallback((studentIds, { immediate = false } = {}) => {
    const ids = Array.isArray(studentIds) ? studentIds : [studentIds];
    for (const studentId of ids) {
      if (typeof studentId === 'string' && studentId) {
        pendingScreenshotStudentIdsRef.current.add(studentId);
      }
    }
    if (pendingScreenshotStudentIdsRef.current.size === 0) return;
    if (immediate && screenshotRefetchTimeoutRef.current) {
      clearTimeout(screenshotRefetchTimeoutRef.current);
      screenshotRefetchTimeoutRef.current = null;
    } else if (screenshotRefetchTimeoutRef.current) {
      return;
    }

    const elapsedMs = Date.now() - lastScreenshotRefetchAtRef.current;
    const delayMs = immediate
      ? Math.max(0, SCREENSHOT_EVENT_RATE_LIMIT_MS - elapsedMs)
      : Math.max(
          SCREENSHOT_EVENT_COALESCE_MS,
          SCREENSHOT_EVENT_RATE_LIMIT_MS - elapsedMs,
        );
    screenshotRefetchTimeoutRef.current = setTimeout(() => {
      screenshotRefetchTimeoutRef.current = null;
      const pendingIds = [...pendingScreenshotStudentIdsRef.current];
      pendingScreenshotStudentIdsRef.current.clear();
      if (pendingIds.length === 0) return;
      lastScreenshotRefetchAtRef.current = Date.now();
      void targetedScreenshotFlushRef.current(pendingIds);
    }, delayMs);
  }, []);

  const handleLiveStreamStopped = useCallback((studentId) => {
    if (activeLiveViewStudentIdRef.current !== studentId) return;
    activeLiveViewStudentIdRef.current = null;
    liveViewGenerationRef.current += 1;
    if (liveViewConnectTimerRef.current) clearTimeout(liveViewConnectTimerRef.current);
    liveViewConnectTimerRef.current = null;
    if (liveViewTimerRef.current) clearTimeout(liveViewTimerRef.current);
    liveViewTimerRef.current = null;
    setLiveViewState(EMPTY_LIVE_VIEW);
  }, []);

  // WebRTC hook for live video streaming
  const webrtc = useWebRTC(wsRef, handleLiveStreamStopped);
  const cleanupLiveViews = webrtc.cleanup;
  const stopLiveView = webrtc.stopLiveView;

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
    refetchInterval: wsAuthenticated ? false : 10000,
  });

  const { data: groups = EMPTY_LIST, isSuccess: groupsLoaded } = useQuery({
    queryKey: ['/api/teacher/groups'],
    queryFn: () => apiRequest('GET', '/teacher/groups'),
    select: (data) => Array.isArray(data) ? data : data?.groups ?? [],
  });

  useEffect(() => {
    if (!groupsLoaded || !teacherClassroomSelectionKey) return;
    if (groups.length === 0) {
      writeClassroomSelection(teacherClassroomSelectionKey, "");
      setStartGroupId("");
      return;
    }
    if (groups.some((group) => group.id === startGroupId)) {
      writeClassroomSelection(teacherClassroomSelectionKey, startGroupId);
      return;
    }

    const storedGroupId = readClassroomSelection(teacherClassroomSelectionKey);
    const nextGroupId = groups.some((group) => group.id === storedGroupId)
      ? storedGroupId
      : groups[0].id;
    writeClassroomSelection(teacherClassroomSelectionKey, nextGroupId);
    setStartGroupId(nextGroupId);
  }, [groups, groupsLoaded, startGroupId, teacherClassroomSelectionKey]);

  const {
    data: adminTeachingGroups = EMPTY_LIST,
    isLoading: adminTeachingGroupsLoading,
    isSuccess: adminTeachingGroupsLoaded,
  } = useQuery({
    queryKey: ['/api/teacher/groups', 'mine'],
    queryFn: () => apiRequest('GET', '/teacher/groups?scope=mine'),
    select: (data) => Array.isArray(data) ? data : data?.groups ?? [],
    enabled: isAdmin,
  });

  useEffect(() => {
    if (!isAdmin || !adminTeachingGroupsLoaded || !adminClassroomSelectionKey) return;
    if (adminTeachingGroups.length === 0) {
      writeClassroomSelection(adminClassroomSelectionKey, "");
      setAdminStartGroupId("");
      return;
    }
    if (adminTeachingGroups.some((group) => group.id === adminStartGroupId)) {
      writeClassroomSelection(adminClassroomSelectionKey, adminStartGroupId);
      return;
    }

    const storedGroupId = readClassroomSelection(adminClassroomSelectionKey);
    const nextGroupId = adminTeachingGroups.some((group) => group.id === storedGroupId)
      ? storedGroupId
      : adminTeachingGroups[0].id;
    writeClassroomSelection(adminClassroomSelectionKey, nextGroupId);
    setAdminStartGroupId(nextGroupId);
  }, [adminClassroomSelectionKey, adminStartGroupId, adminTeachingGroups, adminTeachingGroupsLoaded, isAdmin]);

  const { data: allActiveSessions = EMPTY_LIST } = useQuery({
    queryKey: ['/api/sessions/all'],
    queryFn: () => apiRequest('GET', '/sessions/all'),
    select: (data) => Array.isArray(data) ? data : data?.sessions ?? [],
    enabled: isAdmin,
    refetchInterval: wsAuthenticated ? false : 10000,
  });

  const staffCoverageEnabled = isAdmin || isTeacher;
  const coverageFallbackInterval = wsAuthenticated ? false : 10000;
  const { data: coverageSummary = {} } = useQuery({
    queryKey: ['/api/coverage/summary'],
    queryFn: () => apiRequest('GET', '/coverage/summary'),
    enabled: staffCoverageEnabled,
    refetchInterval: coverageFallbackInterval,
  });
  const manageableCoverageCount = Number(coverageSummary.activeContextCount || 0);

  const { data: coverageCapabilities = {} } = useQuery({
    queryKey: ['/api/coverage/capabilities'],
    queryFn: () => apiRequest('GET', '/coverage/capabilities'),
    enabled: staffCoverageEnabled,
  });
  const canManageSupervisionSetup = isAdmin || !!coverageCapabilities.canManageSupervisionSetup;

  const { data: availablePickupData = EMPTY_PICKUP_DATA } = useQuery({
    queryKey: ['/api/coverage/available-students'],
    queryFn: () => apiRequest('GET', '/coverage/available-students'),
    select: (data) => ({
      students: data?.students || [],
      scheduledCoverageGroups: data?.scheduledCoverageGroups || [],
    }),
    enabled: staffCoverageEnabled && studentView === 'available',
    refetchInterval: coverageFallbackInterval,
  });
  const availablePickupStudents = availablePickupData.students;
  const scheduledCoverageGroups = availablePickupData.scheduledCoverageGroups;

  const {
    data: claimedPickupStudents = EMPTY_LIST,
    isLoading: claimedStudentsLoading,
    isError: claimedStudentsQueryError,
  } = useQuery({
    queryKey: ['/api/coverage/claimed-students'],
    queryFn: () => apiRequest('GET', '/coverage/claimed-students'),
    select: (data) => data?.students || [],
    enabled: staffCoverageEnabled && studentView === 'claimed',
    refetchInterval: coverageFallbackInterval,
  });

  const { data: rerouteCoverageTargets = EMPTY_LIST } = useQuery({
    queryKey: ['/api/coverage/reroute-targets'],
    queryFn: () => apiRequest('GET', '/coverage/reroute-targets'),
    select: (data) => data?.targets || data?.contexts || [],
    enabled: staffCoverageEnabled && showRerouteDialog,
    refetchInterval: false,
  });

  // Admin observe mode logic
  const observedSession = isAdmin && adminObservedSessionId
    ? allActiveSessions.find(s => s.id === adminObservedSessionId)
    : null;
  const effectiveSession = isAdmin ? (observedSession || activeSession) : activeSession;
  const dashboardCapabilities = deriveDashboardCapabilities({
    studentView,
    isTeacher,
    isAdmin,
    currentUserId: currentUser?.id,
    activeSession,
    observedSession,
    coverageCommandTypes: coverageCapabilities.commandTypes || coverageCapabilities.allowedCommandTypes,
  });
  const classDashboardCapabilities = deriveDashboardCapabilities({
    studentView: 'class',
    isTeacher,
    isAdmin,
    currentUserId: currentUser?.id,
    activeSession,
    observedSession,
    coverageCommandTypes: coverageCapabilities.commandTypes || coverageCapabilities.allowedCommandTypes,
  });
  const signOutOnlySelectionActive = selectedServerSignOutStudentIds.size > 0;
  useEffect(() => {
    // `/settings` carries the authoritative per-session FAB revision. Its
    // query key is intentionally stable for legacy consumers, so refresh it
    // whenever class ownership moves from none→A, A→B, or A→none.
    // Teacher-granted off-task exceptions are session-local and must not
    // carry into an observed or subsequently owned class.
    setTeacherAllowedDomains(new Set());
    void queryClient.invalidateQueries({ queryKey: ['/api/settings'] });
  }, [effectiveSession?.id]);
  useEffect(() => {
    setSelectedStudentIds(new Set());
    setSelectedServerSignOutStudentIds(new Set());
    setSelectedStudentBindingSnapshots(new Map());
  }, [currentUser?.id, dashboardCapabilities.mode, effectiveSession?.id, school?.id]);
  useEffect(() => {
    if (!signOutOnlySelectionActive) return;
    setShowOpenTabDialog(false);
    setShowCloseTabsDialog(false);
    setSelectedTabsToClose(new Set());
    setManageTabsStudentIds(null);
    setManageTabsTargetSnapshot("");
    setShowApplyFlightPathDialog(false);
    setShowFlightPathViewerDialog(false);
    setShowApplyBlockListDialog(false);
    setShowBlockListViewerDialog(false);
    setShowSendMessageDialog(false);
    setShowAttentionDialog(false);
    setShowTimerDialog(false);
    setShowPollDialog(false);
    setShowPollResultsDialog(false);
    setShowRerouteDialog(false);
  }, [signOutOnlySelectionActive]);
  useEffect(() => {
    const sessionId = effectiveSession?.id || null;
    if (!dashboardCapabilities.canChangeFabSettings || !sessionId || settings?.activeSessionId !== sessionId) {
      setSessionFabState(null);
      return;
    }
    setSessionFabState(normalizeSessionFabState({
      teachingSessionId: settings?.activeSessionId,
      handRaisingEnabled: settings?.handRaisingEnabled,
      studentMessagingEnabled: settings?.studentMessagingEnabled,
      revision: settings?.sessionFabRevision,
    }, sessionId));
  }, [
    dashboardCapabilities.canChangeFabSettings,
    effectiveSession?.id,
    settings?.activeSessionId,
    settings?.handRaisingEnabled,
    settings?.sessionFabRevision,
    settings?.studentMessagingEnabled,
  ]);
  const activeSchoolId = school?.id || currentUser?.schoolId || null;
  const { data: todayScheduleChanges = EMPTY_LIST } = useQuery({
    queryKey: scheduleChangeKeys.today(activeSchoolId),
    queryFn: scheduleChangeApi.getToday,
    select: unwrapToday,
    enabled: Boolean(isTeacher && activeSchoolId),
    refetchInterval: 60_000,
  });
  const effectiveSessionId = effectiveSession?.id || null;
  const isStudentOwnedByAnotherClass = useCallback((student) => (
    !!effectiveSessionId
    && student?.supervisionContext?.type === "class"
    && student.supervisionContext.id
    && student.supervisionContext.id !== effectiveSessionId
  ), [effectiveSessionId]);
  const isStudentMonitoringSuppressed = useCallback((student) => (
    studentView === 'class'
    && (
      isStudentInTemporarySupervision(student)
      || isStudentOwnedByAnotherClass(student)
    )
  ), [isStudentOwnedByAnotherClass, studentView]);
  const adminSchoolMode = isAdmin && !effectiveSessionId;
  useEffect(() => () => {
    // A peer-to-peer stream can outlive signaling. Tear it down whenever the
    // authoritative class context or Live View capability changes, including
    // A→B replacement, A→none session end, and owned-class→Observe.
    cleanupLiveViews();
  }, [cleanupLiveViews, dashboardCapabilities.canUseLiveView, effectiveSessionId]);
  const aggregatedStudentsQueryKey = useMemo(
    () => makeAggregatedStudentsQueryKey(activeSchoolId, effectiveSessionId, adminSchoolMode),
    [activeSchoolId, adminSchoolMode, effectiveSessionId],
  );
  const aggregatedStudentsScopeKey = JSON.stringify(aggregatedStudentsQueryKey);
  const aggregateReconciliationIntervalMs = useMemo(
    () => classpilotReconciliationIntervalMs(
      `${reconciliationSeedRef.current}:${aggregatedStudentsScopeKey}`,
    ),
    [aggregatedStudentsScopeKey],
  );
  const {
    data: studentsSnapshot,
    isLoading: studentsLoading,
    isError: studentsQueryError,
    error: studentsError,
    isFetching: studentsRefreshing,
    refetch: refetchStudents,
  } = useQuery({
    queryKey: aggregatedStudentsQueryKey,
    // Validate before the value enters the cache. A selector error can retain
    // selected data from the prior session key and make unknown targets look known.
    queryFn: async () => {
      const rows = normalizeAggregatedStudentsResponse(await apiRequest(
        'GET',
        effectiveSessionId
          ? `/students-aggregated?teachingSessionId=${encodeURIComponent(effectiveSessionId)}`
          : '/students-aggregated',
      ));
      setAggregateReconciliation({
        key: aggregatedStudentsScopeKey,
        succeededAtMs: Date.now(),
      });
      return rows;
    },
    // WebSocket delivery is the fast path, never the only path. Keeping a
    // stable per-view jitter avoids a school-wide bell-time polling herd.
    refetchInterval: aggregateReconciliationIntervalMs,
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
    staleTime: 10000,
    structuralSharing: mergeAggregatedStudents,
  });
  const lastSuccessfulReconciliationAtMs = aggregateReconciliation.key === aggregatedStudentsScopeKey
    ? aggregateReconciliation.succeededAtMs
    : null;
  const {
    classStudentTargetsUnavailable,
    classStudentDataUnavailable,
    classStudentRefreshFailed,
    classStudentCountsKnown,
  } = deriveAggregatedStudentsPresentation({
    studentsSnapshot,
    isError: studentsQueryError,
    studentView,
  });
  const students = studentsSnapshot ?? EMPTY_LIST;
  const studentsRequestId = requestIdFromError(studentsError);
  const selectedStudentRoster = studentView === 'class'
    ? students
    : studentView === 'claimed'
      ? claimedPickupStudents
      : [
          ...scheduledCoverageGroups.flatMap((group) => group.students || EMPTY_LIST),
          ...availablePickupStudents,
        ];
  const selectedStudentRow = selectedStudent
    ? selectedStudentRoster.find((student) => student.studentId === selectedStudent.studentId) || null
    : null;
  const selectedStudentMonitoringSuppressed = isStudentMonitoringSuppressed(selectedStudentRow);
  const activeLiveViewStudent = liveViewState.studentId
    ? students.find((student) => student.studentId === liveViewState.studentId) || null
    : null;
  const activeLiveViewMonitoringSuppressed = isStudentMonitoringSuppressed(activeLiveViewStudent);
  const monitoringSuppressedStudentIdsKey = JSON.stringify(
    students
      .filter(isStudentMonitoringSuppressed)
      .map((student) => student.studentId)
      .filter(Boolean)
      .sort(),
  );
  const sessionRealtimeHealthy = Boolean(
    effectiveSessionId
    && sessionSubscriptionState.status === 'active'
    && sessionSubscriptionState.sessionId === effectiveSessionId,
  );
  const monitoringProjectionRef = useRef({ scopeKey: null, displays: null });
  const monitoringDisplaysByStudent = useMemo(() => {
    const previousDisplays = monitoringProjectionRef.current.scopeKey === aggregatedStudentsScopeKey
      ? monitoringProjectionRef.current.displays
      : null;
    const displays = projectStudentMonitoringDisplays(
      students,
      freshnessNowMs,
      {
        lastSuccessfulReconciliationAtMs,
        realtimeHealthy: sessionRealtimeHealthy,
      },
      previousDisplays,
    );
    monitoringProjectionRef.current = {
      scopeKey: aggregatedStudentsScopeKey,
      displays,
    };
    return displays;
  // freshnessVersion is the single dashboard clock tick. Date.now() itself is
  // intentionally not a dependency because it would defeat stable tile props.
  }, [aggregatedStudentsScopeKey, freshnessVersion, lastSuccessfulReconciliationAtMs, sessionRealtimeHealthy, students]); // eslint-disable-line react-hooks/exhaustive-deps
  const monitoringDisplayFor = useCallback((student) => (
    monitoringDisplaysByStudent.get(student?.studentId)
      || deriveStudentMonitoringDisplay(student, Date.now(), {
        lastSuccessfulReconciliationAtMs,
        realtimeHealthy: sessionRealtimeHealthy,
      })
  ), [lastSuccessfulReconciliationAtMs, monitoringDisplaysByStudent, sessionRealtimeHealthy]);

  useEffect(() => {
    if (studentView !== 'class') {
      graceReconciliationLatchRef.current = {
        scopeKey: aggregatedStudentsScopeKey,
        cohortActive: false,
      };
      return;
    }
    const reconnectingStudentIds = [];
    for (const [studentId, display] of monitoringDisplaysByStudent) {
      if (display.kind === 'reconnecting') reconnectingStudentIds.push(studentId);
    }
    graceReconciliationLatchRef.current = reconcileGraceCohort({
      current: graceReconciliationLatchRef.current,
      scopeKey: aggregatedStudentsScopeKey,
      reconnectingStudentIds,
      reconciliationInFlight: studentsRefreshing,
      refetch: () => { void refetchStudents(); },
    });
  }, [
    aggregatedStudentsScopeKey,
    monitoringDisplaysByStudent,
    refetchStudents,
    studentView,
    studentsRefreshing,
  ]);

  useEffect(() => {
    if (studentView !== 'class') return;
    setSelectedStudentIds((current) => {
      let changed = false;
      const next = new Set();
      for (const studentId of current) {
        if (monitoringDisplaysByStudent.get(studentId)?.telemetryCurrent) next.add(studentId);
        else changed = true;
      }
      return changed ? next : current;
    });
  }, [monitoringDisplaysByStudent, studentView]);

  useEffect(() => {
    const activeStudentId = activeLiveViewStudentIdRef.current;
    if (!activeStudentId || studentView !== 'class') return;
    if (monitoringDisplaysByStudent.get(activeStudentId)?.telemetryCurrent) return;
    stopLiveView(activeStudentId, wsRef.current);
  }, [monitoringDisplaysByStudent, stopLiveView, studentView]);

  useEffect(() => {
    const reconcileVisibleDashboard = () => {
      if (document.visibilityState === 'hidden') return;
      setFreshnessVersion((version) => version + 1);
      void refetchStudents();
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') reconcileVisibleDashboard();
    };
    window.addEventListener('online', reconcileVisibleDashboard);
    window.addEventListener('pageshow', reconcileVisibleDashboard);
    window.addEventListener('focus', reconcileVisibleDashboard);
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      window.removeEventListener('online', reconcileVisibleDashboard);
      window.removeEventListener('pageshow', reconcileVisibleDashboard);
      window.removeEventListener('focus', reconcileVisibleDashboard);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [aggregatedStudentsScopeKey, refetchStudents]);

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

  useLayoutEffect(() => {
    // Replace every piece of event-routing context in one pre-paint step. A
    // socket callback cannot observe session B paired with session A's cache
    // key (or school) while an Observe/teacher context is switching.
    effectiveSessionIdRef.current = effectiveSessionId;
    aggregatedStudentsQueryKeyRef.current = aggregatedStudentsQueryKey;
    activeSchoolIdRef.current = activeSchoolId;
    pendingRealtimeEventsRef.current = [];
    if (realtimeFlushTimeoutRef.current) {
      clearTimeout(realtimeFlushTimeoutRef.current);
      realtimeFlushTimeoutRef.current = null;
    }
  }, [activeSchoolId, aggregatedStudentsQueryKey, effectiveSessionId]);

  useLayoutEffect(() => {
    // A detail drawer is an authority-bound view. Never let a selected row or
    // its history survive a class, school, viewer mode, view, or subgroup
    // transition and later bind to a coincidentally matching student ID.
    setSelectedStudent(null);
  }, [
    activeSchoolId,
    currentUser?.id,
    dashboardCapabilities.mode,
    effectiveSessionId,
    selectedSubgroupId,
    studentView,
  ]);

  const { data: activeClassroomStates = EMPTY_LIST } = useQuery({
    queryKey: ['/api/commands/active-state', effectiveSession?.id],
    queryFn: () => apiRequest('GET', `/commands/active-state?teachingSessionId=${encodeURIComponent(effectiveSession.id)}`),
    select: (data) => data?.states ?? [],
    enabled: !!effectiveSession?.id,
    refetchInterval: wsAuthenticated ? false : 30000,
  });

  useEffect(() => {
    if (!selectedStudentMonitoringSuppressed) return undefined;
    const frame = requestAnimationFrame(() => setSelectedStudent(null));
    return () => cancelAnimationFrame(frame);
  }, [selectedStudentMonitoringSuppressed]);

  useEffect(() => {
    if (!activeLiveViewMonitoringSuppressed) return;
    cleanupLiveViews();
  }, [activeLiveViewMonitoringSuppressed, cleanupLiveViews]);

  const { data: subgroups = EMPTY_LIST } = useQuery({
    queryKey: ['/api/groups', effectiveSession?.groupId, 'subgroups'],
    queryFn: async () => {
      if (!effectiveSession?.groupId) return [];
      const data = await apiRequest('GET', `/groups/${effectiveSession.groupId}/subgroups`);
      return data.subgroups || [];
    },
    enabled: !!effectiveSession?.groupId,
  });

  useEffect(() => {
    if (
      selectedSubgroupId
      && !subgroups.some((subgroup) => subgroup.id === selectedSubgroupId)
    ) {
      setSelectedSubgroupId("");
      setSelectedStudentIds(new Set());
      setSelectedServerSignOutStudentIds(new Set());
      setSelectedStudentBindingSnapshots(new Map());
    }
  }, [selectedSubgroupId, subgroups]);

  const {
    data: subgroupMemberIds = EMPTY_LIST,
    isFetching: subgroupMembersFetching,
    isError: subgroupMembersError,
    error: subgroupMembersLoadError,
    refetch: refetchSubgroupMembers,
  } = useQuery(createSubgroupMembersQuery({
    groupId: effectiveSession?.groupId,
    subgroupId: selectedSubgroupId,
    requestApi: apiRequest,
  }));
  const subgroupMembers = useMemo(
    () => new Set(subgroupMemberIds),
    [subgroupMemberIds],
  );
  const subgroupSelectionReady = !selectedSubgroupId
    || (!subgroupMembersFetching && !subgroupMembersError);

  const { data: initialRaisedHands } = useQuery({
    queryKey: ['/api/teacher/raised-hands', effectiveSession?.id],
    queryFn: () => apiRequest('GET', `/teacher/raised-hands?sessionId=${encodeURIComponent(effectiveSession.id)}`),
    enabled: !!effectiveSession?.id,
    refetchInterval: wsAuthenticated ? false : 30000,
  });

  const { data: initialChatMessages } = useQuery({
    queryKey: ['/api/teacher/messages', effectiveSession?.id],
    queryFn: () => apiRequest('GET', `/teacher/messages?sessionId=${encodeURIComponent(effectiveSession.id)}`),
    select: (data) => data?.messages ?? [],
    enabled: !!effectiveSession?.id,
    refetchInterval: wsAuthenticated ? false : 30000,
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
    const generation = websocketGenerationRef.current + 1;
    websocketGenerationRef.current = generation;
    const pendingScreenshotStudentIds = pendingScreenshotStudentIdsRef.current;
    const targetedScreenshotAbortControllers = targetedScreenshotAbortControllersRef.current;
    let disposed = false;
    const isCurrentGeneration = () => !disposed && websocketGenerationRef.current === generation;
    const isCurrentSocket = (socket) => isCurrentGeneration() && wsRef.current === socket;
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    }
    reconnectAttemptsRef.current = 0;

    const classRealtimeMessageEligibility = (message) => {
      const messageSchoolId = message?.schoolId || message?.data?.schoolId;
      if (
        messageSchoolId
        && String(messageSchoolId) !== String(activeSchoolIdRef.current)
      ) return false;
      const currentSessionId = effectiveSessionIdRef.current;
      const messageSessionId = realtimeMessageSessionId(message);
      // Admin school-wide has no teaching-session subscription. A delayed
      // event from a previously observed class must not mutate that view;
      // only genuinely school-wide/sessionless messages are eligible.
      if (!currentSessionId) return !messageSessionId;
      if (messageSessionId) return String(messageSessionId) === String(currentSessionId);
      const subscription = sessionSubscriptionStateRef.current;
      return subscription.status === 'active'
        && String(subscription.sessionId) === String(currentSessionId)
        && subscription.socketGeneration === generation;
    };

    const coverageRealtimeMessageEligibility = (message) => {
      if (realtimeMessageSessionId(message)) return false;
      const messageSchoolId = message?.schoolId || message?.data?.schoolId;
      if (
        messageSchoolId
        && String(messageSchoolId) !== String(activeSchoolIdRef.current)
      ) return false;
      return aggregateSnapshotHasStudent(
        queryClient.getQueryData(['/api/coverage/claimed-students']),
        message?.studentId || message?.data?.studentId,
      );
    };

    const flushRealtimeEvents = () => {
      realtimeFlushTimeoutRef.current = null;
      if (!isCurrentGeneration()) return;
      const queued = pendingRealtimeEventsRef.current;
      pendingRealtimeEventsRef.current = [];
      const queryKey = aggregatedStudentsQueryKeyRef.current;
      if (queued.length === 0) return;
      const currentSessionId = effectiveSessionIdRef.current;
      const classEvents = coalesceStudentRealtimeEvents(queued
        .filter((entry) => (
          entry.socketGeneration === generation
          && String(entry.sessionContextId || '') === String(currentSessionId || '')
          && entry.classEligible
        ))
        .map((entry) => entry.message));
      const coverageEvents = coalesceStudentRealtimeEvents(queued
        .filter((entry) => (
          entry.socketGeneration === generation
          && entry.coverageEligible
        ))
        .map((entry) => entry.message));
      const scope = {
        schoolId: activeSchoolIdRef.current,
        teachingSessionId: currentSessionId,
        allowSessionlessEvents: true,
      };
      if (queryKey) {
        queryClient.setQueryData(queryKey, (old) => applyStudentRealtimeEvents(old, classEvents, scope));
      }
      // Coverage telemetry is delivered to the assigned staff member, not to a
      // teaching-session subscription. Update only rows already granted by the
      // claimed-students response; socket messages can never add visibility.
      queryClient.setQueryData(['/api/coverage/claimed-students'], (old) => (
        applyStudentRealtimeEvents(old, coverageEvents, { schoolId: scope.schoolId })
      ));
    };

    const queueRealtimeEvent = (message) => {
      if (!isCurrentGeneration()) return;
      pendingRealtimeEventsRef.current.push({
        message,
        socketGeneration: generation,
        sessionContextId: effectiveSessionIdRef.current,
        classEligible: classRealtimeMessageEligibility(message),
        coverageEligible: coverageRealtimeMessageEligibility(message),
      });
      if (realtimeFlushTimeoutRef.current) return;
      realtimeFlushTimeoutRef.current = setTimeout(flushRealtimeEvents, 100);
    };

    const reconcileLegacyRealtime = () => {
      if (invalidateTimeoutRef.current) clearTimeout(invalidateTimeoutRef.current);
      invalidateTimeoutRef.current = setTimeout(() => {
        if (!isCurrentGeneration()) return;
        const queryKey = aggregatedStudentsQueryKeyRef.current;
        if (queryKey) queryClient.invalidateQueries({ queryKey, exact: true });
        queryClient.invalidateQueries({ queryKey: ['/api/coverage/claimed-students'], exact: true });
        invalidateTimeoutRef.current = null;
      }, 300);
    };

    const connectWebSocket = () => {
      if (!isCurrentGeneration()) return;
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
          if (!isCurrentSocket(socket)) return;
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
          if (!isCurrentSocket(socket)) return;
          try {
            const message = JSON.parse(event.data);
            if (
              message.type === 'session-subscription-success'
              || message.type === 'session-subscription-error'
            ) {
              sessionSubscriptionPendingRef.current?.handleMessage?.(message, generation);
            }
            if (message.type === 'auth-success') {
              setWsAuthenticated(true);
              authenticatedSchoolIdRef.current = activeSchoolIdRef.current;
              const queryKey = aggregatedStudentsQueryKeyRef.current;
              if (queryKey) queryClient.refetchQueries({ queryKey, exact: true });
            }
            if (message.type === 'auth-error') {
              setWsAuthenticated(false);
              authenticatedSchoolIdRef.current = null;
              webrtc.cleanup();
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
            if (message.type === 'live-view-requested') {
              if (!classRealtimeMessageEligibility(message)) return;
              void webrtc.handleLiveViewRequested(
                message.studentId,
                message.teachingSessionId,
                message.negotiationId,
              ).then((offerSent) => {
                if (!offerSent) webrtc.stopLiveView(message.studentId);
              });
            }
            if (message.type === 'live-view-busy' || message.type === 'live-view-unavailable') {
              if (!classRealtimeMessageEligibility(message)) return;
              if (activeLiveViewStudentIdRef.current !== message.studentId) return;
              webrtc.stopLiveView(message.studentId);
              toast({
                title: message.type === 'live-view-busy' ? "Live View In Use" : "Live View Unavailable",
                description: message.type === 'live-view-busy'
                  ? "Another authorized teacher is already viewing this student. Try again after they stop."
                  : "The student device could not accept the live-view request. Try again in a moment.",
                variant: "destructive",
              });
            }
            if (message.type === 'answer') {
              if (!classRealtimeMessageEligibility(message)) return;
              webrtc.handleAnswer(message.from, message.sdp, message.negotiationId);
            }
            if (message.type === 'ice') {
              if (!classRealtimeMessageEligibility(message)) return;
              webrtc.handleIceCandidate(message.from, message.candidate, message.negotiationId);
            }
            if (message.type === 'hand-raised') {
              if (!classRealtimeMessageEligibility(message)) return;
              const eventSessionId = realtimeMessageSessionId(message);
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
              if (!classRealtimeMessageEligibility(message)) return;
              setRaisedHands(prev => {
                const newMap = new Map(prev);
                newMap.delete(message.data.studentId);
                return newMap;
              });
            }
            if (message.type === 'hand-dismissed') {
              if (!classRealtimeMessageEligibility(message)) return;
              setRaisedHands(prev => {
                const newMap = new Map(prev);
                newMap.delete(message.studentId || message.data?.studentId);
                return newMap;
              });
            }
            if (message.type === 'student-message') {
              if (!classRealtimeMessageEligibility(message)) return;
              const eventSessionId = realtimeMessageSessionId(message);
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
              if (!classRealtimeMessageEligibility(message)) return;
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
              const classEligible = classRealtimeMessageEligibility(message);
              const coverageEligible = coverageRealtimeMessageEligibility(message);
              if (!classEligible && !coverageEligible) return;
              const scope = {
                schoolId: activeSchoolIdRef.current,
                teachingSessionId: effectiveSessionIdRef.current,
                allowSessionlessEvents: classEligible,
              };
              const queryKey = aggregatedStudentsQueryKeyRef.current;
              const currentClassSnapshot = classEligible && queryKey
                ? queryClient.getQueryData(queryKey)
                : undefined;
              const nextClassSnapshot = classEligible && queryKey
                ? applyStudentRealtimeEvents(currentClassSnapshot, [message], scope)
                : currentClassSnapshot;
              const classMutationAccepted = Boolean(
                classEligible
                && queryKey
                && nextClassSnapshot !== currentClassSnapshot,
              );
              const coverageQueryKey = ['/api/coverage/claimed-students'];
              const currentCoverageSnapshot = coverageEligible
                ? queryClient.getQueryData(coverageQueryKey)
                : undefined;
              const nextCoverageSnapshot = coverageEligible
                ? applyStudentRealtimeEvents(currentCoverageSnapshot, [message], {
                    schoolId: scope.schoolId,
                  })
                : currentCoverageSnapshot;
              const coverageMutationAccepted = coverageEligible
                && nextCoverageSnapshot !== currentCoverageSnapshot;
              if (!classMutationAccepted && !coverageMutationAccepted) return;
              if (classMutationAccepted) webrtc.stopLiveView(message.studentId);
              void purgeStudentTileCaches(queryClient, [message.studentId]);
              // A sign-out tombstone is terminal for the current binding. Drop
              // any older queued telemetry for the student, then apply the
              // tombstone immediately only to the independently authorized
              // classroom and/or coverage cache.
              pendingRealtimeEventsRef.current = pendingRealtimeEventsRef.current.filter((queued) => (
                queued.message?.studentId !== message.studentId
              ));
              if (classMutationAccepted) {
                queryClient.setQueryData(queryKey, nextClassSnapshot);
                queryClient.invalidateQueries({ queryKey, exact: true });
              }
              if (coverageMutationAccepted) {
                queryClient.setQueryData(coverageQueryKey, nextCoverageSnapshot);
                queryClient.invalidateQueries({ queryKey: coverageQueryKey, exact: true });
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
                webrtc.cleanup();
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
              queryClient.invalidateQueries({ queryKey: ['/api/coverage/summary'], exact: true });
              queryClient.invalidateQueries({ queryKey: ['/api/coverage/available-students'] });
              queryClient.invalidateQueries({ queryKey: ['/api/coverage/claimed-students'] });
              queryClient.invalidateQueries({ queryKey: ['/api/sessions/active'], exact: false });
              queryClient.invalidateQueries({ queryKey: ['/api/students-aggregated'] });
            }
            if (message.type === 'coverage-summary-updated') {
              queryClient.invalidateQueries({ queryKey: ['/api/coverage/summary'], exact: true });
              if (studentViewRef.current === 'available') {
                queryClient.invalidateQueries({ queryKey: ['/api/coverage/available-students'], exact: true });
              }
              if (studentViewRef.current === 'claimed') {
                queryClient.invalidateQueries({ queryKey: ['/api/coverage/claimed-students'], exact: true });
              }
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
              if (!classRealtimeMessageEligibility(message)) return;
              toast({
                title: "Safety Alert",
                description: `${message.studentName || 'A student'} may need attention — ${message.classification?.reason || 'flagged content detected'}`,
                variant: "destructive",
              });
              queryClient.invalidateQueries({ queryKey: ['/api/students-aggregated'] });
            }
            if (message.type === 'screenshot-available') {
              if (!classRealtimeMessageEligibility(message)) return;
              queueTargetedScreenshotRefresh(message.studentId);
            }
            if (message.type === 'student-event') {
              if (!classRealtimeMessageEligibility(message)) return;
              if (message.eventType === 'blocked_domain') {
                toast({
                  title: "Blocked Site",
                  description: `${message.studentName || 'A student'} attempted to visit a blocked domain`,
                });
              }
            }
          } catch (error) {
            console.error("[Dashboard] WebSocket message error:", error);
          }
        };

        socket.onclose = () => {
          if (socket._heartbeatInterval) clearInterval(socket._heartbeatInterval);
          socket._heartbeatInterval = null;
          if (!isCurrentSocket(socket)) return;
          webrtc.cleanup();
          setWsConnected(false);
          setWsAuthenticated(false);
          authenticatedSchoolIdRef.current = null;
          wsRef.current = null;
          reconnectAttemptsRef.current++;
          const delay = Math.min(1000 * Math.pow(2, reconnectAttemptsRef.current - 1), maxReconnectDelay);
          reconnectTimeoutRef.current = setTimeout(connectWebSocket, delay);
        };

        socket.onerror = (error) => {
          if (!isCurrentSocket(socket)) return;
          console.error("[Dashboard] WebSocket error:", error);
          setWsConnected(false);
        };
      } catch (error) {
        if (!isCurrentGeneration()) return;
        console.error("[Dashboard] Failed to create WebSocket:", error);
        setWsConnected(false);
        reconnectAttemptsRef.current++;
        const delay = Math.min(1000 * Math.pow(2, reconnectAttemptsRef.current - 1), maxReconnectDelay);
        reconnectTimeoutRef.current = setTimeout(connectWebSocket, delay);
      }
    };

    connectWebSocket();

    return () => {
      disposed = true;
      if (websocketGenerationRef.current === generation) {
        websocketGenerationRef.current = generation + 1;
      }
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
      if (screenshotRefetchTimeoutRef.current) {
        clearTimeout(screenshotRefetchTimeoutRef.current);
        screenshotRefetchTimeoutRef.current = null;
      }
      pendingScreenshotStudentIds.clear();
      for (const controller of targetedScreenshotAbortControllers) {
        controller.abort();
      }
      targetedScreenshotAbortControllers.clear();
      pendingRealtimeEventsRef.current = [];
      const socket = wsRef.current;
      if (socket && wsRef.current === socket) {
        if (socket._heartbeatInterval) clearInterval(socket._heartbeatInterval);
        socket._heartbeatInterval = null;
        socket.onopen = null;
        socket.onmessage = null;
        socket.onerror = null;
        socket.onclose = null;
        socket.close();
        wsRef.current = null;
      }
      if (liveViewTimerRef.current) clearTimeout(liveViewTimerRef.current);
      liveViewTimerRef.current = null;
      if (liveViewConnectTimerRef.current) clearTimeout(liveViewConnectTimerRef.current);
      liveViewConnectTimerRef.current = null;
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
    const subscriptionGeneration = sessionSubscriptionGenerationRef.current + 1;
    sessionSubscriptionGenerationRef.current = subscriptionGeneration;
    const sessionId = effectiveSessionId;
    const socket = wsRef.current;
    const socketGeneration = websocketGenerationRef.current;
    let stopped = false;

    const clearTimers = () => {
      if (sessionSubscriptionAckTimeoutRef.current) {
        clearTimeout(sessionSubscriptionAckTimeoutRef.current);
        sessionSubscriptionAckTimeoutRef.current = null;
      }
      if (sessionSubscriptionRetryTimeoutRef.current) {
        clearTimeout(sessionSubscriptionRetryTimeoutRef.current);
        sessionSubscriptionRetryTimeoutRef.current = null;
      }
    };
    const publishState = (status, errorCode = null) => {
      if (stopped || sessionSubscriptionGenerationRef.current !== subscriptionGeneration) return;
      const next = { status, sessionId: sessionId || null, errorCode, socketGeneration };
      sessionSubscriptionStateRef.current = next;
      setSessionSubscriptionState(next);
    };

    clearTimers();
    sessionSubscriptionPendingRef.current = null;
    sessionSubscriptionAttemptRef.current = 0;

    if (!sessionId) {
      publishState('not_applicable');
      return () => {
        stopped = true;
        clearTimers();
      };
    }
    if (!wsAuthenticated || !wsConnected || !socket || socket.readyState !== WebSocket.OPEN) {
      publishState('retrying');
      return () => {
        stopped = true;
        clearTimers();
      };
    }

    const isCurrentAttempt = () => (
      !stopped
      && sessionSubscriptionGenerationRef.current === subscriptionGeneration
      && websocketGenerationRef.current === socketGeneration
      && wsRef.current === socket
      && effectiveSessionIdRef.current === sessionId
    );
    const scheduleRetry = () => {
      if (!isCurrentAttempt()) return;
      clearTimers();
      sessionSubscriptionPendingRef.current = null;
      const retryIndex = Math.min(
        sessionSubscriptionAttemptRef.current,
        SESSION_SUBSCRIPTION_RETRY_MS.length - 1,
      );
      const delayMs = SESSION_SUBSCRIPTION_RETRY_MS[retryIndex];
      sessionSubscriptionAttemptRef.current += 1;
      publishState('retrying');
      sessionSubscriptionRetryTimeoutRef.current = setTimeout(sendSubscription, delayMs);
    };
    const sendSubscription = () => {
      if (!isCurrentAttempt() || socket.readyState !== WebSocket.OPEN) return;
      clearTimers();
      const requestId = createRealtimeRequestId('subscribe');
      publishState(sessionSubscriptionAttemptRef.current === 0 ? 'pending' : 'retrying');
      const pending = {
        subscriptionGeneration,
        socketGeneration,
        sessionId,
        requestId,
        handleMessage(message, messageSocketGeneration) {
          if (!isCurrentAttempt() || messageSocketGeneration !== socketGeneration) return;
          const acknowledgedSessionId = realtimeMessageSessionId(message);
          if (!acknowledgedSessionId || String(acknowledgedSessionId) !== String(sessionId)) return;
          const acknowledgedRequestId = message.requestId == null
            ? null
            : normalizedRequestId(message.requestId);
          if (message.requestId != null && !acknowledgedRequestId) return;
          // Old servers ACK by session only. New servers echo the opaque ID so
          // a delayed A→B→A acknowledgement cannot activate the wrong request.
          if (acknowledgedRequestId && acknowledgedRequestId !== requestId) return;
          clearTimers();
          sessionSubscriptionPendingRef.current = null;
          if (message.type === 'session-subscription-success') {
            publishState('active');
            return;
          }
          const errorCode = typeof message.code === 'string'
            ? message.code
            : typeof message.errorCode === 'string'
              ? message.errorCode
              : 'SUBSCRIPTION_SERVICE_UNAVAILABLE';
          if (
            errorCode === 'SESSION_UNAVAILABLE'
            || errorCode === 'SESSION_ID_REQUIRED'
            || errorCode === 'REQUEST_ID_INVALID'
          ) {
            publishState('terminal_error', errorCode);
            void queryClient.invalidateQueries({ queryKey: ['/api/sessions/active'], exact: false });
            void queryClient.invalidateQueries({ queryKey: ['/api/sessions/all'], exact: false });
            return;
          }
          scheduleRetry();
        },
      };
      sessionSubscriptionPendingRef.current = pending;
      socket.send(JSON.stringify({ type: 'subscribe-session', sessionId, requestId }));
      sessionSubscriptionAckTimeoutRef.current = setTimeout(() => {
        if (sessionSubscriptionPendingRef.current !== pending) return;
        scheduleRetry();
      }, SESSION_SUBSCRIPTION_ACK_TIMEOUT_MS);
    };

    sendSubscription();
    return () => {
      stopped = true;
      clearTimers();
      if (sessionSubscriptionPendingRef.current?.subscriptionGeneration === subscriptionGeneration) {
        sessionSubscriptionPendingRef.current = null;
      }
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({
          type: 'unsubscribe-session',
          sessionId,
          requestId: createRealtimeRequestId('unsubscribe'),
        }));
      }
    };
  }, [effectiveSessionId, wsAuthenticated, wsConnected]);

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
    const monitoring = studentView === 'class'
      ? monitoringDisplayFor(student)
      : deriveStudentMonitoringDisplay(student, freshnessNowMs);
    if (!monitoring.telemetryCurrent) return false;
    if (student.cameraActive) return true;
    if (!student.activeTabUrl) return false;
    if (student.status !== 'online') return false;

    return isStudentUrlOffTask({
      student,
      teacherAllowedDomains: teacherAllowedDomainPatterns,
      schoolAllowedDomains: settings?.allowedDomains || EMPTY_LIST,
      flightPaths,
    });
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

  const isStudentStructurallyCommandable = (student) => (
    !isStudentInTemporarySupervision(student) && !isStudentOwnedByAnotherClass(student)
  );
  const isStudentCommandable = (student, { allowSafetyUnlock = false } = {}) => {
    if (!isStudentStructurallyCommandable(student)) return false;
    const display = studentView === 'class'
      ? monitoringDisplayFor(student)
      : deriveStudentMonitoringDisplay(student, freshnessNowMs);
    return display.telemetryCurrent || (
      allowSafetyUnlock
      && student?.screenLocked === true
      && studentSupportsCapability(student, 'screenOnlyUnlockV1')
    );
  };
  const isStudentServerSignOutEligible = (student) => (
    dashboardCapabilities.ownedClassSession
    && isStudentStructurallyCommandable(student)
    && student?.isLoggedIn === true
    && student?.loginState !== 'not_logged_in'
  );
  const signOutSelectionBindingFor = (student) => studentSignOutSelectionBinding({
    schoolId: activeSchoolId,
    viewerId: currentUser?.id,
    mode: dashboardCapabilities.mode,
    teachingSessionId: effectiveSession?.id,
    student,
  });

  // Selection handlers
  const toggleStudentSelection = (studentId) => {
    const student = filteredStudents.find((row) => row.studentId === studentId);
    if (studentView === "class" && !isStudentCommandable(student)) {
      if (isStudentLateSignInRestrictionEligible(student)) {
        const wasSelected = selectedStudentIds.has(studentId);
        setSelectedStudentIds((current) => {
          const next = new Set(current);
          if (next.has(studentId)) next.delete(studentId);
          else next.add(studentId);
          return next;
        });
        setSelectedServerSignOutStudentIds((current) => {
          if (!current.has(studentId)) return current;
          const next = new Set(current);
          next.delete(studentId);
          return next;
        });
        setSelectedStudentBindingSnapshots((current) => {
          if (!wasSelected && !current.has(studentId)) return current;
          const next = new Map(current);
          next.delete(studentId);
          return next;
        });
        return;
      }
      if (isStudentServerSignOutEligible(student)) {
        const bindingSnapshot = signOutSelectionBindingFor(student);
        if (!bindingSnapshot) {
          toast({
            variant: "destructive",
            title: "Student session changed",
            description: "Refresh the dashboard and select the student again before signing out.",
          });
          return;
        }
        const wasSelectedForSignOutOnly = selectedServerSignOutStudentIds.has(studentId);
        setSelectedStudentIds((current) => {
          if (!current.has(studentId)) return current;
          const next = new Set(current);
          next.delete(studentId);
          return next;
        });
        setSelectedServerSignOutStudentIds((current) => {
          const next = new Set(current);
          if (next.has(studentId)) next.delete(studentId);
          else next.add(studentId);
          return next;
        });
        setSelectedStudentBindingSnapshots((current) => {
          const next = new Map(current);
          if (wasSelectedForSignOutOnly) next.delete(studentId);
          else next.set(studentId, bindingSnapshot);
          return next;
        });
        return;
      }
      const structurallyCommandable = isStudentStructurallyCommandable(student);
      toast({
        variant: "destructive",
        title: structurallyCommandable
          ? 'Monitoring is updating'
          : isStudentInTemporarySupervision(student)
            ? "Student is in supervision"
            : "Student moved to another class",
        description: structurallyCommandable
          ? 'Wait for current monitoring to recover before targeting this student.'
          : isStudentInTemporarySupervision(student)
            ? "Return the student to class before using ClassPilot controls."
            : "The most recent active class session controls this student.",
      });
      return;
    }
    if (selectedServerSignOutStudentIds.has(studentId)) {
      setSelectedServerSignOutStudentIds((current) => {
        if (!current.has(studentId)) return current;
        const next = new Set(current);
        next.delete(studentId);
        return next;
      });
      setSelectedStudentBindingSnapshots((current) => {
        if (!current.has(studentId)) return current;
        const next = new Map(current);
        next.delete(studentId);
        return next;
      });
      return;
    }
    const wasSelected = selectedStudentIds.has(studentId);
    const bindingSnapshot = studentView === 'class'
      ? signOutSelectionBindingFor(student)
      : null;
    setSelectedStudentIds((prev) => {
      const newSet = new Set(prev);
      if (newSet.has(studentId)) { newSet.delete(studentId); } else { newSet.add(studentId); }
      return newSet;
    });
    setSelectedStudentBindingSnapshots((current) => {
      const next = new Map(current);
      if (wasSelected || !bindingSnapshot) next.delete(studentId);
      else next.set(studentId, bindingSnapshot);
      return next;
    });
  };
  const selectAll = () => {
    const allStudentIds = selectableStudents.map((s) => s.studentId);
    setSelectedStudentIds(new Set(allStudentIds));
    setSelectedServerSignOutStudentIds(new Set());
    setSelectedStudentBindingSnapshots(new Map(
      studentView === 'class'
        ? selectableStudents
          .map((student) => [student.studentId, signOutSelectionBindingFor(student)])
          .filter(([, bindingSnapshot]) => bindingSnapshot)
        : EMPTY_LIST,
    ));
  };
  const clearSelection = () => {
    setSelectedStudentIds(new Set());
    setSelectedServerSignOutStudentIds(new Set());
    setSelectedStudentBindingSnapshots(new Map());
  };
  const handleStudentViewChange = (view) => {
    if (dashboardCapabilities.observedOtherClass && view !== 'class') return;
    setStudentView(view);
    setSelectedStudentIds(new Set());
    setSelectedServerSignOutStudentIds(new Set());
    setSelectedStudentBindingSnapshots(new Map());
    setSearchQuery("");
  };
  const handleAdminObservedSessionChange = (event) => {
    const sessionId = event.target.value || null;
    setAdminObservedSessionId(sessionId);
    setSelectedStudentIds(new Set());
    setSelectedServerSignOutStudentIds(new Set());
    setSelectedStudentBindingSnapshots(new Map());
    setSearchQuery("");
    setSelectedSubgroupId("");
    setSelectedStudent(null);
    if (sessionId) {
      setStudentView('class');
      setShowOpenTabDialog(false);
      setShowCloseTabsDialog(false);
      setSelectedTabsToClose(new Set());
      setManageTabsStudentIds(null);
      setManageTabsTargetSnapshot("");
      setShowApplyFlightPathDialog(false);
      setShowFlightPathViewerDialog(false);
      setShowApplyBlockListDialog(false);
      setShowBlockListViewerDialog(false);
      setShowSendMessageDialog(false);
      setShowSignOutDialog(false);
      setShowAttentionDialog(false);
      setShowTimerDialog(false);
      setShowPollDialog(false);
      setShowPollResultsDialog(false);
      setShowRerouteDialog(false);
      setClassStartOverlap(null);
      setClassResyncOverlap(null);
      setEndClassTarget(null);
      setSkipTodayGroup(null);
    }
  };

  // The dashboard owns one live-view negotiation and one enlarged portal.
  // Switching students tears down the previous exact-bound connection first.
  const handleStopLiveView = (studentId = activeLiveViewStudentIdRef.current) => {
    if (!studentId) return;
    webrtc.stopLiveView(studentId, wsRef.current);
    queryClient.invalidateQueries({
      queryKey: [TILE_BATCH_QUERY_ROOTS.screenshots],
      refetchType: 'all',
    });
  };

  const handleStartLiveView = async (studentId, studentName) => {
    if (!wsAuthenticated) {
      toast({ title: "Not Ready", description: "Please wait for connection to be established", variant: "destructive" });
      return;
    }

    const previousStudentId = activeLiveViewStudentIdRef.current;
    if (previousStudentId === studentId) return;
    if (previousStudentId) {
      webrtc.stopLiveView(previousStudentId, wsRef.current);
    }

    const generation = liveViewGenerationRef.current + 1;
    liveViewGenerationRef.current = generation;
    activeLiveViewStudentIdRef.current = studentId;
    setLiveViewState({
      studentId,
      studentName: studentName || 'Unknown student',
      stream: null,
      pending: true,
      expanded: false,
    });
    let streamReceived = false;
    if (liveViewConnectTimerRef.current) clearTimeout(liveViewConnectTimerRef.current);
    liveViewConnectTimerRef.current = null;

    try {
      const connection = await webrtc.startLiveView(studentId, effectiveSession?.id, (stream) => {
        if (
          liveViewGenerationRef.current !== generation
          || activeLiveViewStudentIdRef.current !== studentId
        ) {
          stream.getTracks().forEach((track) => track.stop());
          webrtc.stopLiveView(studentId, wsRef.current);
          return;
        }
        streamReceived = true;
        if (liveViewConnectTimerRef.current) clearTimeout(liveViewConnectTimerRef.current);
        liveViewConnectTimerRef.current = null;
        setLiveViewState((current) => current.studentId === studentId
          ? { ...current, stream, pending: false, expanded: true }
          : current);
      });
      if (!connection) {
        handleLiveStreamStopped(studentId);
        toast({ title: "Live View Not Ready", description: "The teacher connection is not ready yet. Try again in a moment.", variant: "destructive" });
        return;
      }
      liveViewConnectTimerRef.current = setTimeout(() => {
        if (
          streamReceived
          || liveViewGenerationRef.current !== generation
          || activeLiveViewStudentIdRef.current !== studentId
        ) return;
        handleStopLiveView(studentId);
        toast({
          title: "Live View Timed Out",
          description: "The request was sent, but no stream arrived. The managed session, extension policy, or network may be blocking live capture; showing the latest screenshot instead.",
          variant: "destructive",
        });
      }, LIVE_VIEW_CONNECT_TIMEOUT_MS);
    } catch (error) {
      webrtc.stopLiveView(studentId, wsRef.current);
      toast({ title: "Live View Failed", description: error?.message || "Could not start live view.", variant: "destructive" });
      return;
    }

    if (liveViewTimerRef.current) clearTimeout(liveViewTimerRef.current);
    liveViewTimerRef.current = setTimeout(() => {
      if (
        liveViewGenerationRef.current !== generation
        || activeLiveViewStudentIdRef.current !== studentId
      ) return;
      handleStopLiveView(studentId);
      toast({ title: "Live View Ended", description: "Auto-stopped after 15 minutes to protect student device" });
    }, LIVE_VIEW_TIMEOUT_MS);
  };

  // A session-scoped aggregate already represents the frozen teaching-session
  // roster. Do not intersect it with mutable current group membership: doing so
  // can hide students added to or removed from the group after class started.
  const sessionFilteredStudents = students.filter((student) => {
    if (effectiveSession && isStudentOwnedByAnotherClass(student)) return false;
    if (isAdmin && !effectiveSession) {
      return normalizeGrade(student.gradeLevel) === normalizeGrade(selectedGrade);
    }
    return true;
  });
  const lateSignInRestrictionsEnabled = dashboardCapabilities.ownedClassSession
    && lateSignInRestrictionGateEnabled(sessionFilteredStudents);
  const isStudentLateSignInRestrictionEligible = (student) => (
    isLateSignInRestrictionTarget({
      student,
      operatorEnabled: lateSignInRestrictionsEnabled,
      structurallyCommandable: isStudentStructurallyCommandable(student),
    })
  );
  const isStudentCommandableForCommand = (
    student,
    commandType,
    commandPayload = {},
    { allowSafetyUnlock = false } = {},
  ) => (
    isStudentCommandable(student, { allowSafetyUnlock })
    || (
      commandSupportsLateSignInRestriction(commandType, commandPayload)
      && isStudentLateSignInRestrictionEligible(student)
    )
  );

  const normalizedSearchQuery = deferredSearchQuery.trim().toLowerCase();
  const matchesStudentSearch = (student) => {
    const query = normalizedSearchQuery;
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
          (group.label || '').toLowerCase().includes(normalizedSearchQuery) ||
          (group.className || '').toLowerCase().includes(normalizedSearchQuery) ||
          (group.teacherName || '').toLowerCase().includes(normalizedSearchQuery)
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
  const signOutEligibleBindingsKey = JSON.stringify(
    sessionFilteredStudents
      .filter(isStudentServerSignOutEligible)
      .map((student) => ({
        studentId: student.studentId,
        bindingSnapshot: signOutSelectionBindingFor(student),
      }))
      .filter((entry) => entry.bindingSnapshot)
      .sort((left, right) => left.studentId.localeCompare(right.studentId)),
  );
  const signOutEligibleBindingsByStudent = useMemo(
    () => new Map(JSON.parse(signOutEligibleBindingsKey).map((entry) => [
      entry.studentId,
      entry.bindingSnapshot,
    ])),
    [signOutEligibleBindingsKey],
  );
  const lateSignInRestrictionEligibleStudentIdsKey = JSON.stringify(
    sessionFilteredStudents
      .filter(isStudentLateSignInRestrictionEligible)
      .map((student) => student.studentId)
      .sort(),
  );
  const lateSignInRestrictionEligibleStudentIds = useMemo(
    () => new Set(JSON.parse(lateSignInRestrictionEligibleStudentIdsKey)),
    [lateSignInRestrictionEligibleStudentIdsKey],
  );
  useEffect(() => {
    if (!dashboardCapabilities.ownedClassSession || studentView !== 'class') return;
    const selectedIds = new Set([
      ...selectedStudentIds,
      ...selectedServerSignOutStudentIds,
    ]);
    const invalidStudentIds = new Set([...selectedIds].filter((studentId) => (
      lateSignInRestrictionEligibleStudentIds.has(studentId)
        ? selectedStudentBindingSnapshots.has(studentId)
        : !selectedStudentBindingSnapshots.has(studentId)
          || signOutEligibleBindingsByStudent.get(studentId) !== selectedStudentBindingSnapshots.get(studentId)
    )));
    const hasOrphanedBindingSnapshot = [...selectedStudentBindingSnapshots.keys()]
      .some((studentId) => !selectedIds.has(studentId));
    if (invalidStudentIds.size === 0 && !hasOrphanedBindingSnapshot) return;
    setSelectedStudentIds((current) => {
      const next = new Set([...current].filter((studentId) => !invalidStudentIds.has(studentId)));
      return next.size === current.size ? current : next;
    });
    setSelectedServerSignOutStudentIds((current) => {
      const next = new Set([...current].filter((studentId) => !invalidStudentIds.has(studentId)));
      return next.size === current.size ? current : next;
    });
    setSelectedStudentBindingSnapshots((current) => {
      const next = new Map(
        [...current].filter(([studentId]) => (
          selectedIds.has(studentId) && !invalidStudentIds.has(studentId)
        )),
      );
      return next.size === current.size ? current : next;
    });
  }, [
    dashboardCapabilities.ownedClassSession,
    lateSignInRestrictionEligibleStudentIds,
    selectedServerSignOutStudentIds,
    selectedStudentBindingSnapshots,
    selectedStudentIds,
    signOutEligibleBindingsByStudent,
    studentView,
  ]);
  const observationStudentIdsKey = JSON.stringify([...new Set(
    studentView === 'claimed'
      ? claimedPickupStudents.map((student) => student.studentId)
      : selectedSubgroupId
        ? sessionFilteredStudents
          .filter((student) => subgroupMembers.has(student.studentId))
          .map((student) => student.studentId)
        : EMPTY_LIST
  )].sort());
  const observationScope = useMemo(() => {
    if (studentView === 'class' && !selectedSubgroupId) return { kind: 'class' };
    const studentIds = JSON.parse(observationStudentIdsKey);
    return studentIds.length > 0 ? { kind: 'students', studentIds } : null;
  }, [observationStudentIdsKey, selectedSubgroupId, studentView]);
  const observationLeaseStatus = useObservationLease({
    // The only deployed observation lease is frozen-teaching-session scoped.
    // Claimed coverage may be authorized by a separate supervision context,
    // so it stays telemetry-only until a supervision observation lease exists.
    enabled: studentView === 'class' && Boolean(effectiveSession?.id),
    teachingSessionId: effectiveSession?.id,
    scope: observationScope,
  });
  const tileScreenshotObservationStatus = studentView === 'claimed'
    ? 'denied'
    : observationLeaseStatus;
  useEffect(() => {
    if (
      tileScreenshotObservationStatus !== 'pending'
      && tileScreenshotObservationStatus !== 'denied'
      && tileScreenshotObservationStatus !== 'paused_unobserved'
    ) return;
    cleanupLiveViews();
  }, [cleanupLiveViews, tileScreenshotObservationStatus]);
  const detailHistoryTeachingSessionId = studentView === 'class'
    ? effectiveSessionId
    : null;
  const selectedStudentDisplay = selectedStudentRow
    ? monitoringDisplayFor(selectedStudentRow)
    : null;
  const selectedStudentHardPrivacyRevoked = Boolean(
    selectedStudentMonitoringSuppressed
    || tileGlobalAuthorizationDenied
    || ['signed_out', 'delegated'].includes(selectedStudentDisplay?.kind),
  );
  const selectedStudentHistoryRevoked = Boolean(
    selectedStudentHardPrivacyRevoked
    || observationLeaseStatus === 'denied'
    || observationLeaseStatus === 'paused_unobserved'
  );
  const detailHistoryQueryKey = [
    TILE_BATCH_QUERY_ROOTS.history,
    'detail',
    activeSchoolId || 'no-school',
    currentUser?.id || 'no-viewer',
    dashboardCapabilities.mode,
    studentView,
    detailHistoryTeachingSessionId || 'no-session',
    selectedStudentRow?.studentId || 'no-student',
    selectedStudentRow?.realtimeBinding || 'no-binding',
  ];
  const {
    data: urlHistorySnapshot = EMPTY_LIST,
    isError: detailHistoryError,
    error: detailHistoryErrorValue,
  } = useQuery({
    queryKey: detailHistoryQueryKey,
    queryFn: () => apiRequest('POST', '/classpilot/tiles/history', {
      studentIds: [selectedStudentRow.studentId],
      limit: 10,
      ...(detailHistoryTeachingSessionId
        ? { teachingSessionId: detailHistoryTeachingSessionId }
        : {}),
    }),
    select: (data) => data?.tiles?.[0]?.heartbeats || [],
    enabled: Boolean(
      selectedStudentRow?.studentId
      && !selectedStudentHistoryRevoked
      && !tileGlobalAuthorizationDenied
      && studentView !== 'available'
      && (studentView !== 'class' || detailHistoryTeachingSessionId || adminSchoolMode)
    ),
    retry: false,
    gcTime: 0,
    refetchOnWindowFocus: 'always',
    refetchOnReconnect: 'always',
  });
  const detailHistoryFailureScope = detailHistoryError
    ? tileBatchFailureScope(detailHistoryErrorValue)
    : 'transient';
  const detailHistoryHardDenied = detailHistoryFailureScope !== 'transient';
  const urlHistory = selectedStudentHistoryRevoked || detailHistoryHardDenied
    ? EMPTY_LIST
    : urlHistorySnapshot;
  useEffect(() => {
    if (!selectedStudentRow?.studentId) return;
    if (!selectedStudentHistoryRevoked && !detailHistoryHardDenied) return;
    if (detailHistoryFailureScope === 'global') {
      setTileGlobalAuthorizationDenied(true);
      void purgeAllStudentTileCaches(queryClient);
    } else if (selectedStudentHardPrivacyRevoked) {
      void purgeStudentTileCaches(queryClient, [selectedStudentRow.studentId]);
    } else {
      void purgeStudentHistoryTileCaches(queryClient, [selectedStudentRow.studentId]);
    }
  }, [
    detailHistoryFailureScope,
    detailHistoryHardDenied,
    selectedStudentHardPrivacyRevoked,
    selectedStudentHistoryRevoked,
    selectedStudentRow?.studentId,
  ]);
  useEffect(() => {
    if (studentView === 'class') return;
    // Class-bound V2 pixels may bridge a temporary dashboard-view change.
    // Legacy pixels still depend on the active observation lease and must be
    // removed as soon as the class view is no longer being observed.
    void purgeLegacyScreenshotTileCaches(queryClient);
  }, [studentView]);
  useEffect(() => {
    if (!['denied', 'paused_unobserved'].includes(observationLeaseStatus)) return;
    // Lease revocation invalidates only legacy V1 pixels. V2 rows carry their
    // own class-bound authority and remain available through focus churn.
    void purgeLegacyScreenshotTileCaches(queryClient);
  }, [observationLeaseStatus]);
  const {
    supported: viewportTrackingSupported,
    nearViewportStudentIds,
    getTileRef,
  } = useTileViewport();
  const screenshotTileQueryStudents = effectiveSessionId
    ? students
    : EMPTY_LIST;
  const historyTileQueryStudents = studentView === 'available'
    ? EMPTY_LIST
    : studentView === 'class' && effectiveSessionId
      // A session-scoped aggregate is the immutable frozen roster. Keep every
      // row in deterministic cohorts; per-student authorization gates and the
      // server decide whether a row may currently return pixels.
      ? students
      : filteredStudents;
  const screenshotTileStudentBindingsKey = JSON.stringify(
    screenshotTileQueryStudents
      .map((student) => ({
        studentId: student.studentId,
        realtimeBinding: student.realtimeBinding || '',
        classroomStateRevision: normalizedTileControlRevision(student),
      }))
      .sort((left, right) => left.studentId.localeCompare(right.studentId)),
  );
  const historyTileStudentBindingsKey = JSON.stringify(
    historyTileQueryStudents
      .map((student) => ({
        studentId: student.studentId,
        realtimeBinding: student.realtimeBinding || '',
        classroomStateRevision: normalizedTileControlRevision(student),
      }))
      .sort((left, right) => left.studentId.localeCompare(right.studentId)),
  );
  const locallyRevokedTileStudentIdsKey = JSON.stringify([...new Set([
    ...JSON.parse(monitoringSuppressedStudentIdsKey),
    ...[...screenshotTileQueryStudents, ...historyTileQueryStudents]
      .filter((student) => ['signed_out', 'delegated'].includes(
        monitoringDisplayFor(student).kind,
      ))
      .map((student) => student.studentId),
  ])].sort());
  const locallyRevokedTileStudentIds = useMemo(
    () => new Set(JSON.parse(locallyRevokedTileStudentIdsKey)),
    [locallyRevokedTileStudentIdsKey],
  );
  const dashboardViewerRole = isAdmin ? 'admin' : isTeacher ? 'teacher' : 'staff';
  const screenshotTileBatchContext = useMemo(() => ({
    schoolId: activeSchoolId || '',
    viewerId: currentUser?.id || '',
    authority: `${dashboardViewerRole}:${classDashboardCapabilities.mode}:class`,
    teachingSessionId: effectiveSessionId || '',
  }), [
    activeSchoolId,
    classDashboardCapabilities.mode,
    currentUser?.id,
    dashboardViewerRole,
    effectiveSessionId,
  ]);
  const historyTileBatchContext = useMemo(() => ({
    schoolId: activeSchoolId || '',
    viewerId: currentUser?.id || '',
    authority: `${dashboardViewerRole}:${dashboardCapabilities.mode}:${studentView}`,
    teachingSessionId: studentView === 'class' ? effectiveSessionId || '' : '',
  }), [
    activeSchoolId,
    currentUser?.id,
    dashboardCapabilities.mode,
    dashboardViewerRole,
    effectiveSessionId,
    studentView,
  ]);
  const screenshotTileBatchContextKey = JSON.stringify(screenshotTileBatchContext);
  const historyTileBatchContextKey = JSON.stringify(historyTileBatchContext);
  useLayoutEffect(() => {
    setTileGlobalAuthorizationDenied(false);
  }, [screenshotTileBatchContextKey]);
  const previousScreenshotTileBindingsRef = useRef({
    contextKey: null,
    students: EMPTY_LIST,
  });
  const pendingScreenshotTileBindingChangeRef = useRef(null);
  const screenshotTileBindingTransitionKey = `${screenshotTileBatchContextKey}\n${screenshotTileStudentBindingsKey}`;
  useLayoutEffect(() => {
    const nextStudents = JSON.parse(screenshotTileStudentBindingsKey);
    const previous = previousScreenshotTileBindingsRef.current;
    previousScreenshotTileBindingsRef.current = {
      contextKey: screenshotTileBatchContextKey,
      students: nextStudents,
    };
    pendingScreenshotTileBindingChangeRef.current = null;
    if (previous.contextKey !== screenshotTileBatchContextKey) return;
    const changedStudentIds = changedTileBindingStudentIds(previous.students, nextStudents);
    if (changedStudentIds.length === 0) return;
    pendingScreenshotTileBindingChangeRef.current = {
      key: screenshotTileBindingTransitionKey,
      studentIds: changedStudentIds,
    };
    // Fail closed before paint. The passive reconciliation below waits until
    // useQueries owns the replacement queryFn, then refetches the same cohort.
    scrubStudentTileCaches(queryClient, changedStudentIds);
  }, [
    screenshotTileBatchContextKey,
    screenshotTileBindingTransitionKey,
    screenshotTileStudentBindingsKey,
  ]);
  const previousHistoryTileBindingsRef = useRef({
    contextKey: null,
    students: EMPTY_LIST,
  });
  const pendingHistoryTileBindingChangeRef = useRef(null);
  const historyTileBindingTransitionKey = `${historyTileBatchContextKey}\n${historyTileStudentBindingsKey}`;
  useLayoutEffect(() => {
    const nextStudents = JSON.parse(historyTileStudentBindingsKey);
    const previous = previousHistoryTileBindingsRef.current;
    previousHistoryTileBindingsRef.current = {
      contextKey: historyTileBatchContextKey,
      students: nextStudents,
    };
    pendingHistoryTileBindingChangeRef.current = null;
    if (previous.contextKey !== historyTileBatchContextKey) return;
    const changedStudentIds = changedTileBindingStudentIds(previous.students, nextStudents);
    if (changedStudentIds.length === 0) return;
    pendingHistoryTileBindingChangeRef.current = {
      key: historyTileBindingTransitionKey,
      studentIds: changedStudentIds,
    };
    scrubStudentTileCaches(queryClient, changedStudentIds);
  }, [
    historyTileBatchContextKey,
    historyTileBindingTransitionKey,
    historyTileStudentBindingsKey,
  ]);
  const classScreenshotTileRequests = useMemo(
    () => createTileBatchRequests(
      JSON.parse(screenshotTileStudentBindingsKey),
      screenshotTileBatchContext,
    ).filter((request) => request.kind === 'screenshots'),
    [screenshotTileBatchContext, screenshotTileStudentBindingsKey],
  );
  const screenshotTileRequests = studentView === 'class'
    && observationLeaseStatus !== 'paused_unobserved'
    ? classScreenshotTileRequests
    : EMPTY_LIST;
  const historyTileRequests = useMemo(
    () => createTileBatchRequests(
      JSON.parse(historyTileStudentBindingsKey),
      historyTileBatchContext,
    ).filter((request) => request.kind === 'history'),
    [historyTileBatchContext, historyTileStudentBindingsKey],
  );
  const observationReadsAllowed = observationLeaseStatus === 'observed'
    || observationLeaseStatus === 'legacy'
    || observationLeaseStatus === 'error';
  const screenshotTileReadsEnabled = studentView === 'class'
    && Boolean(effectiveSessionId)
    && !tileGlobalAuthorizationDenied;
  const legacyScreenshotReadsRevoked = ['denied', 'paused_unobserved'].includes(
    observationLeaseStatus,
  );
  const historyTileReadsEnabled = studentView !== 'available'
    && observationReadsAllowed
    && !tileGlobalAuthorizationDenied;
  const targetedScreenshotFenceKey = `${screenshotTileBindingTransitionKey}\n${studentView}\n${observationLeaseStatus}\n${tileGlobalAuthorizationDenied}`;
  if (targetedScreenshotFenceGenerationRef.current.key !== targetedScreenshotFenceKey) {
    targetedScreenshotFenceGenerationRef.current = {
      key: targetedScreenshotFenceKey,
      generation: targetedScreenshotFenceGenerationRef.current.generation + 1,
    };
  }
  targetedScreenshotContextRef.current = {
    fenceKey: targetedScreenshotFenceKey,
    fenceGeneration: targetedScreenshotFenceGenerationRef.current.generation,
    enabled: screenshotTileReadsEnabled
      && observationLeaseStatus !== 'paused_unobserved',
    teachingSessionId: effectiveSessionId,
    requests: classScreenshotTileRequests,
    locallyRevokedStudentIds: locallyRevokedTileStudentIds,
    removeLegacy: legacyScreenshotReadsRevoked,
  };
  targetedScreenshotFlushRef.current = async (studentIds) => {
    const snapshot = targetedScreenshotContextRef.current;
    if (
      !snapshot?.enabled
      || !snapshot.teachingSessionId
      || (typeof document !== 'undefined' && document.visibilityState !== 'visible')
    ) return;
    const pendingIds = new Set(studentIds);
    const jobs = snapshot.requests.flatMap((request) => {
      const requestedIds = request.body.studentIds.filter((studentId) => (
        pendingIds.has(studentId) && !snapshot.locallyRevokedStudentIds.has(studentId)
      ));
      if (requestedIds.length === 0) return EMPTY_LIST;
      return [{ request, requestedIds }];
    });

    await Promise.allSettled(jobs.map(async ({ request, requestedIds }) => {
      const controller = new AbortController();
      targetedScreenshotAbortControllersRef.current.add(controller);
      try {
        let response = await apiRequest('POST', '/classpilot/tiles/screenshots', {
          studentIds: requestedIds,
          teachingSessionId: snapshot.teachingSessionId,
        }, { signal: controller.signal });
        if (
          targetedScreenshotContextRef.current?.fenceKey !== snapshot.fenceKey
          || targetedScreenshotContextRef.current?.fenceGeneration !== snapshot.fenceGeneration
        ) return;
        response = removeStudentsFromTileBatchData(
          response,
          snapshot.locallyRevokedStudentIds,
        );
        if (snapshot.removeLegacy) {
          response = removeLegacyScreenshotsFromTileBatchData(response);
        }
        queryClient.setQueryData(request.queryKey, (previous) => (
          mergeTargetedTileScreenshotResponse(
            previous,
            response,
            requestedIds,
            Date.now(),
          )
        ));
        setTargetedScreenshotFailureByStudent((current) => {
          if (!requestedIds.some((studentId) => current.has(studentId))) return current;
          const next = new Map(current);
          for (const studentId of requestedIds) next.delete(studentId);
          return next;
        });
      } catch (error) {
        if (controller.signal.aborted) return;
        if (
          targetedScreenshotContextRef.current?.fenceKey !== snapshot.fenceKey
          || targetedScreenshotContextRef.current?.fenceGeneration !== snapshot.fenceGeneration
        ) return;
        const failureScope = tileBatchFailureScope(error);
        if (failureScope === 'global') {
          setTileGlobalAuthorizationDenied(true);
          await purgeAllStudentTileCaches(queryClient);
        } else if (failureScope === 'cohort') {
          await purgeStudentScreenshotTileCaches(queryClient, requestedIds);
          const failedAt = Date.now();
          setTargetedScreenshotFailureByStudent((current) => {
            const next = new Map(current);
            for (const studentId of requestedIds) {
              next.set(studentId, { failedAt, hardDenied: true });
            }
            return next;
          });
        } else {
          const failedAt = Date.now();
          setTargetedScreenshotFailureByStudent((current) => {
            const next = new Map(current);
            for (const studentId of requestedIds) {
              next.set(studentId, { failedAt, hardDenied: false });
            }
            return next;
          });
        }
      } finally {
        targetedScreenshotAbortControllersRef.current.delete(controller);
      }
    }));
  };
  useEffect(() => {
    if (screenshotRefetchTimeoutRef.current) {
      clearTimeout(screenshotRefetchTimeoutRef.current);
      screenshotRefetchTimeoutRef.current = null;
    }
    pendingScreenshotStudentIdsRef.current.clear();
    for (const controller of targetedScreenshotAbortControllersRef.current) {
      controller.abort();
    }
    targetedScreenshotAbortControllersRef.current.clear();
    const frame = requestAnimationFrame(() => {
      setTargetedScreenshotFailureByStudent((current) => (
        current.size === 0 ? current : new Map()
      ));
    });
    return () => cancelAnimationFrame(frame);
  }, [targetedScreenshotFenceKey]);
  const screenshotTileQueries = useQueries({
    queries: screenshotTileRequests.map((request) => ({
      queryKey: request.queryKey,
      queryFn: async ({ signal }) => {
        const response = removeStudentsFromTileBatchData(
          await fetchTileBatch(request, apiRequest, signal),
          locallyRevokedTileStudentIds,
        );
        return legacyScreenshotReadsRevoked
          ? removeLegacyScreenshotsFromTileBatchData(response)
          : response;
      },
      select: indexTileScreenshots,
      refetchInterval: request.refetchInterval,
      refetchIntervalInBackground: false,
      refetchOnWindowFocus: 'always',
      refetchOnReconnect: 'always',
      retry: false,
      staleTime: 15000,
      gcTime: TILE_SCREENSHOT_CACHE_GC_MS,
      enabled: screenshotTileReadsEnabled && tileBatchRequestShouldPoll(request, {
        viewportTrackingSupported,
        nearViewportStudentIds,
        // Keep an enlarged screenshot's cohort active even when its tile is
        // outside the virtualized viewport.
        priorityStudentId: expandedScreenshot?.studentId || null,
      }),
      structuralSharing: (previous, incoming) => retainFreshTileScreenshotsOnNull(
        previous,
        incoming,
        Date.now(),
      ),
    })),
  });
  const historyTileQueries = useQueries({
    queries: historyTileRequests.map((request) => ({
      queryKey: request.queryKey,
      queryFn: async ({ signal }) => removeStudentsFromTileBatchData(
        await fetchTileBatch(request, apiRequest, signal),
        locallyRevokedTileStudentIds,
      ),
      select: indexTileHistory,
      refetchInterval: request.refetchInterval,
      refetchIntervalInBackground: false,
      refetchOnWindowFocus: 'always',
      refetchOnReconnect: 'always',
      retry: false,
      staleTime: 15000,
      gcTime: 60000,
      enabled: historyTileReadsEnabled && tileBatchRequestShouldPoll(request, {
        viewportTrackingSupported,
        nearViewportStudentIds,
        liveViewStudentId: liveViewState.studentId,
      }),
    })),
  });
  useEffect(() => {
    const pending = pendingScreenshotTileBindingChangeRef.current;
    if (!pending || pending.key !== screenshotTileBindingTransitionKey) return;
    pendingScreenshotTileBindingChangeRef.current = null;
    void reconcileStudentTileBindingCaches(queryClient, pending.studentIds);
  }, [screenshotTileBindingTransitionKey]);
  useEffect(() => {
    const pending = pendingHistoryTileBindingChangeRef.current;
    if (!pending || pending.key !== historyTileBindingTransitionKey) return;
    pendingHistoryTileBindingChangeRef.current = null;
    void reconcileStudentTileBindingCaches(queryClient, pending.studentIds);
  }, [historyTileBindingTransitionKey]);
  const previousStudentViewRef = useRef(studentView);
  useEffect(() => {
    const previousStudentView = previousStudentViewRef.current;
    previousStudentViewRef.current = studentView;
    if (studentView !== 'class' || previousStudentView === 'class') return;
    // Reuse the exact cached V2 image for the first paint, then force a
    // background reconciliation even when the cached query is still fresh.
    void queryClient.refetchQueries({
      queryKey: [TILE_BATCH_QUERY_ROOTS.screenshots, screenshotTileBatchContextKey],
      exact: false,
      type: 'active',
    });
  }, [screenshotTileBatchContextKey, studentView]);
  useEffect(() => {
    if (observationLeaseStatus !== 'observed') return;
    // V2 reads do not wait for this lease, but a newly acknowledged lease
    // should reconcile any V1 compatibility rows immediately as well.
    void queryClient.refetchQueries({
      queryKey: [TILE_BATCH_QUERY_ROOTS.screenshots],
      exact: false,
      type: 'active',
    });
  }, [observationLeaseStatus, screenshotTileBatchContextKey]);
  const screenshotsByStudent = useMemo(() => {
    if (screenshotTileQueries.length === 0) return EMPTY_TILE_MAP;
    return new Map(screenshotTileQueries.flatMap((query) => [...(query.data || EMPTY_TILE_MAP)]));
  }, [screenshotTileQueries]);
  const screenshotRefreshStateByStudent = useMemo(() => {
    const refreshState = new Map();
    for (const [studentId, failure] of targetedScreenshotFailureByStudent) {
      const recoveredByCohort = screenshotTileRequests.some((request, index) => (
        request.body.studentIds.includes(studentId)
        && !screenshotTileQueries[index]?.isError
        && Number(screenshotTileQueries[index]?.dataUpdatedAt) > failure.failedAt
      ));
      if (!recoveredByCohort) {
        refreshState.set(studentId, {
          hardDenied: failure.hardDenied,
          transientUnavailable: !failure.hardDenied,
        });
      }
    }
    screenshotTileRequests.forEach((request, index) => {
      const query = screenshotTileQueries[index];
      if (!query?.isError) return;
      const failureScope = tileBatchFailureScope(query.error);
      const hardDenied = failureScope !== 'transient';
      for (const studentId of request.body.studentIds) {
        refreshState.set(studentId, {
          hardDenied,
          transientUnavailable: !hardDenied,
        });
      }
    });
    return refreshState;
  }, [screenshotTileQueries, screenshotTileRequests, targetedScreenshotFailureByStudent]);
  const historyByStudent = useMemo(() => {
    if (historyTileQueries.length === 0) return EMPTY_TILE_MAP;
    return new Map(historyTileQueries.flatMap((query) => [...(query.data || EMPTY_TILE_MAP)]));
  }, [historyTileQueries]);
  const hardDeniedScreenshotStudentIds = useMemo(() => {
    const deniedIds = new Set();
    for (const [studentId, refreshState] of screenshotRefreshStateByStudent) {
      if (refreshState.hardDenied) deniedIds.add(studentId);
    }
    screenshotTileRequests.forEach((request, index) => {
      if (tileBatchFailureScope(screenshotTileQueries[index]?.error) === 'transient') return;
      for (const studentId of request.body.studentIds) deniedIds.add(studentId);
    });
    return deniedIds;
  }, [screenshotRefreshStateByStudent, screenshotTileQueries, screenshotTileRequests]);
  const hardDeniedHistoryStudentIds = useMemo(() => {
    const deniedIds = new Set();
    historyTileRequests.forEach((request, index) => {
      if (tileBatchFailureScope(historyTileQueries[index]?.error) === 'transient') return;
      for (const studentId of request.body.studentIds) deniedIds.add(studentId);
    });
    return deniedIds;
  }, [historyTileQueries, historyTileRequests]);
  const tileGlobalAuthorizationFailure = useMemo(() => (
    [...screenshotTileQueries, ...historyTileQueries].some((query) => (
      query?.isError && tileBatchFailureScope(query.error) === 'global'
    ))
  ), [historyTileQueries, screenshotTileQueries]);
  useEffect(() => {
    if (!tileGlobalAuthorizationFailure) return;
    setTileGlobalAuthorizationDenied(true);
    void purgeAllStudentTileCaches(queryClient);
  }, [tileGlobalAuthorizationFailure]);
  const expandedScreenshotContextBaseKey = `${screenshotTileBindingTransitionKey}\n${studentView}`;
  if (expandedScreenshotContextGenerationRef.current.key !== expandedScreenshotContextBaseKey) {
    expandedScreenshotContextGenerationRef.current = {
      key: expandedScreenshotContextBaseKey,
      generation: expandedScreenshotContextGenerationRef.current.generation + 1,
    };
  }
  const expandedScreenshotContextKey = `${expandedScreenshotContextBaseKey}\n${expandedScreenshotContextGenerationRef.current.generation}`;
  const expandedScreenshotStudent = expandedScreenshot?.studentId
    ? screenshotTileQueryStudents.find((student) => student.studentId === expandedScreenshot.studentId) || null
    : null;
  const expandedScreenshotMonitoringDisplay = expandedScreenshotStudent
    ? monitoringDisplayFor(expandedScreenshotStudent)
    : null;
  const expandedScreenshotRefreshState = expandedScreenshotStudent
    ? screenshotRefreshStateByStudent.get(expandedScreenshotStudent.studentId)
    : null;
  const expandedScreenshotData = expandedScreenshotStudent
    ? screenshotsByStudent.get(expandedScreenshotStudent.studentId) || null
    : null;
  const expandedScreenshotHardRevoked = Boolean(
    !expandedScreenshotStudent
    || expandedScreenshot?.contextKey !== expandedScreenshotContextKey
    || studentView !== 'class'
    || tileGlobalAuthorizationDenied
    || tileGlobalAuthorizationFailure
    || hardDeniedScreenshotStudentIds.has(expandedScreenshotStudent?.studentId)
    || observationLeaseStatus === 'denied'
    || isStudentMonitoringSuppressed(expandedScreenshotStudent)
    || ['signed_out', 'delegated'].includes(expandedScreenshotMonitoringDisplay?.kind),
  );
  const expandedScreenshotDisplay = deriveScreenshotDisplay(
    expandedScreenshotHardRevoked ? null : expandedScreenshotData,
    freshnessNowMs,
  );
  const expandedScreenshotPixelsAvailable = expandedScreenshotDisplay.available
    && expandedScreenshotMonitoringDisplay?.kind !== 'signal_lost';
  const expandedScreenshotSelection = expandedScreenshot && !expandedScreenshotHardRevoked
    ? {
        student: expandedScreenshotStudent,
        screenshotData: expandedScreenshotPixelsAvailable ? expandedScreenshotData : null,
        refreshUnavailable: expandedScreenshotRefreshState?.transientUnavailable === true,
        privacyKey: `${expandedScreenshotContextKey}:${expandedScreenshotStudent.realtimeBinding || ''}:${normalizedTileControlRevision(expandedScreenshotStudent)}:${expandedScreenshotData?.bindingVersion || ''}`,
        unavailableMessage: expandedScreenshotMonitoringDisplay?.kind === 'signal_lost'
          ? 'Monitoring signal lost. A current screen preview is unavailable.'
          : expandedScreenshotMonitoringDisplay?.kind === 'updates_unavailable'
            ? 'Monitoring updates are unavailable. Waiting for a current screenshot.'
            : 'Current screenshot unavailable. Waiting for the next authorized capture.',
      }
    : null;
  useEffect(() => {
    if (!expandedScreenshot || !expandedScreenshotHardRevoked) return undefined;
    expandedScreenshotOpenerRef.current = null;
    restoreExpandedScreenshotFocusRef.current = false;
    const frame = requestAnimationFrame(() => setExpandedScreenshot(null));
    return () => cancelAnimationFrame(frame);
  }, [expandedScreenshot, expandedScreenshotHardRevoked]);
  const openExpandedScreenshot = (studentId, opener) => {
    expandedScreenshotOpenerRef.current = opener || null;
    restoreExpandedScreenshotFocusRef.current = false;
    setExpandedScreenshot({
      studentId,
      contextKey: expandedScreenshotContextKey,
    });
    queueTargetedScreenshotRefresh(studentId, { immediate: true });
  };
  const tilePrivacyStudents = (() => {
    const studentsById = new Map();
    for (const student of [
      ...(effectiveSessionId ? students : EMPTY_LIST),
      ...filteredStudents,
    ]) {
      if (student?.studentId) studentsById.set(student.studentId, student);
    }
    return [...studentsById.values()];
  })();
  const tileCachePurgeStudentIdsKey = JSON.stringify([...new Set([
    ...((tileGlobalAuthorizationDenied || tileGlobalAuthorizationFailure)
      ? tilePrivacyStudents.map((student) => student.studentId)
      : EMPTY_LIST),
    ...tilePrivacyStudents
      .filter((student) => (
        isStudentMonitoringSuppressed(student)
        || ['signed_out', 'delegated'].includes(monitoringDisplayFor(student).kind)
      ))
      .map((student) => student.studentId),
  ])].sort());
  useEffect(() => {
    // Context and binding changes must evict inactive pixel caches instead of
    // letting an A→B→A navigation resurrect an old authorized preview.
    queryClient.removeQueries({
      queryKey: [TILE_BATCH_QUERY_ROOTS.screenshots],
      exact: false,
      type: 'inactive',
    });
  }, [screenshotTileBatchContextKey]);
  useEffect(() => {
    queryClient.removeQueries({
      queryKey: [TILE_BATCH_QUERY_ROOTS.history],
      exact: false,
      type: 'inactive',
    });
  }, [historyTileBatchContextKey]);
  useEffect(() => {
    void purgeStudentTileCaches(queryClient, JSON.parse(tileCachePurgeStudentIdsKey));
  }, [tileCachePurgeStudentIdsKey]);
  const hardDeniedScreenshotStudentIdsKey = JSON.stringify([...hardDeniedScreenshotStudentIds].sort());
  const hardDeniedHistoryStudentIdsKey = JSON.stringify([...hardDeniedHistoryStudentIds].sort());
  useEffect(() => {
    void purgeStudentScreenshotTileCaches(
      queryClient,
      JSON.parse(hardDeniedScreenshotStudentIdsKey),
    );
  }, [hardDeniedScreenshotStudentIdsKey]);
  useEffect(() => {
    void purgeStudentHistoryTileCaches(
      queryClient,
      JSON.parse(hardDeniedHistoryStudentIdsKey),
    );
  }, [hardDeniedHistoryStudentIdsKey]);
  useEffect(() => {
    if (freshnessTimeoutRef.current) {
      clearTimeout(freshnessTimeoutRef.current);
      freshnessTimeoutRef.current = null;
    }
    const now = Date.now();
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
      now,
      studentView === 'class' ? monitoringDisplaysByStudent : null,
    );
    if (boundary === null) return undefined;

    freshnessTimeoutRef.current = setTimeout(() => {
      freshnessTimeoutRef.current = null;
      setFreshnessVersion((version) => version + 1);
    }, Math.max(1, boundary - now + 5));

    return () => {
      if (freshnessTimeoutRef.current) {
        clearTimeout(freshnessTimeoutRef.current);
        freshnessTimeoutRef.current = null;
      }
    };
  }, [
    availablePickupStudents,
    claimedPickupStudents,
    freshnessVersion,
    monitoringDisplaysByStudent,
    scheduledCoverageGroups,
    screenshotsByStudent,
    studentView,
    students,
  ]);

  const controllableStudents = filteredStudents.filter(isStudentCommandable);
  const lateSignInRestrictionStudents = studentView === 'class'
    ? filteredStudents.filter(isStudentLateSignInRestrictionEligible)
    : EMPTY_LIST;
  const subgroupCommandsDisabled = studentView === 'class'
    && Boolean(selectedSubgroupId)
    && !subgroupSelectionReady;
  const selectableStudents = dashboardCapabilities.canSelectStudents && !subgroupCommandsDisabled
    ? (studentView === "class"
        ? uniqueStudentsById([...controllableStudents, ...lateSignInRestrictionStudents])
        : filteredStudents)
    : EMPTY_LIST;

  const statsStudents = (studentView === "class" ? sessionFilteredStudents : filteredStudents)
    .filter((student) => !isStudentMonitoringSuppressed(student));
  const statsMonitoringDisplays = statsStudents.map((student) => (
    studentView === 'class'
      ? monitoringDisplayFor(student)
      : deriveStudentMonitoringDisplay(student, freshnessNowMs)
  ));
  const onlineCount = statsMonitoringDisplays.filter((display) => display.kind === 'online').length;
  const idleCount = statsMonitoringDisplays.filter((display) => display.kind === 'idle').length;
  const offlineCount = statsMonitoringDisplays.filter((display) => display.kind === 'signed_out').length;
  const offTaskCount = statsStudents.filter(isStudentOffTask).length;

  const resolveActiveCommandTarget = (
    overrideStudentIds = null,
    {
      allowSafetyUnlock = false,
      commandType = null,
      commandPayload = {},
    } = {},
  ) => {
    if (classStudentTargetsUnavailable) {
      throw new Error('Student targets are unavailable until the class roster finishes loading.');
    }
    if (subgroupCommandsDisabled) {
      throw new Error('Wait for the selected subgroup roster to finish loading before sending commands.');
    }
    const target = resolveCommandTargets({
      mode: dashboardCapabilities.mode,
      sessionStudents: sessionFilteredStudents.map((student) => ({
        ...student,
        commandable: commandType
          ? isStudentCommandableForCommand(
              student,
              commandType,
              commandPayload,
              { allowSafetyUnlock },
            )
          : isStudentCommandable(student, { allowSafetyUnlock }),
      })),
      claimedStudents: claimedPickupStudents.filter((student) => (
        isStudentCommandable(student, { allowSafetyUnlock })
      )),
      selectedStudentIds: Array.from(selectedStudentIds),
      selectedSubgroupId: selectedSubgroupId || null,
      subgroupStudentIds: Array.from(subgroupMembers),
      overrideStudentIds,
    });
    const selectedIds = overrideStudentIds === null
      ? Array.from(selectedStudentIds)
      : overrideStudentIds;
    if (
      Array.isArray(selectedIds)
      && selectedIds.length > 0
      && target.targetStudentIds.length !== new Set(selectedIds).size
    ) {
      throw new Error('One or more selected students are unavailable for this command. Clear the selection and try again.');
    }
    return target;
  };

  const getActiveCommandStudents = (overrideStudentIds = null, options = {}) => {
    try {
      return resolveActiveCommandTarget(overrideStudentIds, options).targetStudents;
    } catch {
      return EMPTY_LIST;
    }
  };
  const resolveActiveStudentSignOutTarget = (studentIds) => {
    if (classStudentTargetsUnavailable) {
      throw new Error('Student targets are unavailable until the class roster finishes loading.');
    }
    if (subgroupCommandsDisabled) {
      throw new Error('Wait for the selected subgroup roster to finish loading before signing students out.');
    }
    return resolveStudentSignOutTargets({
      mode: dashboardCapabilities.mode,
      sessionStudents: sessionFilteredStudents.map((student) => ({
        ...student,
        signOutEligible: isStudentServerSignOutEligible(student),
        signOutBindingSnapshot: signOutSelectionBindingFor(student),
      })),
      selectedStudentIds: studentIds,
      selectedStudentBindings: studentIds.map((studentId) => ({
        studentId,
        bindingSnapshot: selectedStudentBindingSnapshots.get(studentId),
      })),
    });
  };

  const targetStudents = studentView === "available"
    ? filteredStudents
    : getActiveCommandStudents(null, {
        commandType: 'apply-flight-path',
      });
  const selectedLateSignInRestrictionStudentIds = [...selectedStudentIds].filter((studentId) => (
    lateSignInRestrictionEligibleStudentIds.has(studentId)
  ));
  const lateSignInRestrictionSelectionActive = selectedLateSignInRestrictionStudentIds.length > 0;
  const nonRestrictionSelectionActive = signOutOnlySelectionActive
    || lateSignInRestrictionSelectionActive;
  useEffect(() => {
    if (!lateSignInRestrictionSelectionActive) return;
    setShowOpenTabDialog(false);
    setShowCloseTabsDialog(false);
    setSelectedTabsToClose(new Set());
    setManageTabsStudentIds(null);
    setManageTabsTargetSnapshot("");
    setShowSendMessageDialog(false);
    setShowAttentionDialog(false);
    setShowTimerDialog(false);
    setShowPollDialog(false);
    setShowPollResultsDialog(false);
    setShowRerouteDialog(false);
  }, [lateSignInRestrictionSelectionActive]);
  const screenToolbarRosterUnavailable = studentView === 'class'
    ? studentsLoading || studentsQueryError
    : studentView === 'claimed'
      ? claimedStudentsLoading || claimedStudentsQueryError
      : true;
  const lockToolbarCommand = toolbarScreenCommand('lock-screen', selectedStudentIds);
  const explicitlySelectedStudentIds = lockToolbarCommand?.studentIds || EMPTY_LIST;
  const explicitlySelectedStudents = explicitlySelectedStudentIds.length > 0
    ? getActiveCommandStudents(explicitlySelectedStudentIds, {
        commandType: 'lock-screen',
        commandPayload: { url: 'https://late-sign-in-target.invalid/' },
      })
    : EMPTY_LIST;
  const explicitlySelectedUnlockStudents = explicitlySelectedStudentIds.length > 0
    ? getActiveCommandStudents(explicitlySelectedStudentIds, {
        allowSafetyUnlock: true,
        commandType: 'unlock-screen',
      })
    : EMPTY_LIST;
  const exactSelectedTargetsResolved = !screenToolbarRosterUnavailable
    && explicitlySelectedStudentIds.length > 0
    && explicitlySelectedStudents.length === explicitlySelectedStudentIds.length;
  const exactSelectedUnlockTargetsResolved = !screenToolbarRosterUnavailable
    && explicitlySelectedStudentIds.length > 0
    && explicitlySelectedUnlockStudents.length === explicitlySelectedStudentIds.length;
  const selectedTargetsSupportScreenOnlyUnlock = exactSelectedUnlockTargetsResolved
    && explicitlySelectedUnlockStudents.every((student) => (
      isStudentLateSignInRestrictionEligible(student)
      || studentSupportsCapability(student, 'screenOnlyUnlockV1')
    ));
  const restrictionMessageForStudents = (targetStudentRows) => domainRestrictionMessageForStudents(
    targetStudentRows,
    (student) => (
      studentView === 'class'
        ? monitoringDisplayFor(student).telemetryCurrent
        : deriveStudentMonitoringDisplay(student, freshnessNowMs).telemetryCurrent
    ),
  );
  const waypointDomainRestrictionMessage = restrictionMessageForStudents(explicitlySelectedStudents);
  const flightPathDomainRestrictionMessage = restrictionMessageForStudents(targetStudents);
  const activeClassName = studentView === "available"
    ? "Available"
    : studentView === "claimed"
      ? "Claimed"
      : groups.find(g => g.id === effectiveSession?.groupId)?.name || (effectiveSession ? "Active Class" : "Class");
  const subgroupName = selectedSubgroupId ? subgroups.find(s => s.id === selectedSubgroupId)?.name : null;
  const observedViewStudents = dashboardCapabilities.observedOtherClass
    ? sessionFilteredStudents.filter((student) => (
        !selectedSubgroupId || subgroupMembers.has(student.studentId)
      ))
    : EMPTY_LIST;
  const ownedClassBannerStudents = dashboardCapabilities.ownedClassSession
    ? sessionFilteredStudents.filter((student) => (
        !selectedSubgroupId || subgroupMembers.has(student.studentId)
      ))
    : EMPTY_LIST;
  const bannerStudents = dashboardCapabilities.observedOtherClass
    ? observedViewStudents
    : dashboardCapabilities.ownedClassSession
      ? ownedClassBannerStudents
      : targetStudents;
  const bannerCounts = {
    connected: 0,
    updating: 0,
    signalLost: 0,
    updatesUnavailable: 0,
    signedOut: 0,
    inSupervision: 0,
  };
  for (const student of bannerStudents) {
    if (
      dashboardCapabilities.observedOtherClass
      && isStudentInTemporarySupervision(student)
    ) {
      bannerCounts.inSupervision += 1;
      continue;
    }

    const display = studentView === 'class'
      ? monitoringDisplayFor(student)
      : deriveStudentMonitoringDisplay(student, freshnessNowMs);
    switch (display.kind) {
      case 'online':
      case 'idle':
        bannerCounts.connected += 1;
        break;
      case 'signal_lost':
        bannerCounts.signalLost += 1;
        break;
      case 'reconnecting':
        bannerCounts.updating += 1;
        break;
      case 'updates_unavailable':
        bannerCounts.updatesUnavailable += 1;
        break;
      case 'signed_out':
        bannerCounts.signedOut += 1;
        break;
      default:
        break;
    }
  }
  const claimedContextCount = new Set(claimedPickupStudents.map((student) => student.contextId).filter(Boolean)).size;
  const claimedTargetContextCount = new Set(targetStudents.map((student) => student.contextId).filter(Boolean)).size;
  const claimedSearchDisclosure = studentView === 'claimed' && filteredClaimedStudents.length !== claimedPickupStudents.length
    ? ` · ${filteredClaimedStudents.length} currently shown by search`
    : '';
  const targetBannerLabel = subgroupCommandsDisabled
    ? `${subgroupName || 'Subgroup'} roster unavailable`
    : studentView === 'claimed' && selectedStudentIds.size === 0
    ? `${targetStudents.length} claimed student${targetStudents.length === 1 ? '' : 's'} in ${claimedTargetContextCount} supervision group${claimedTargetContextCount === 1 ? '' : 's'}${claimedSearchDisclosure}`
    : selectedStudentIds.size > 0
    ? `${targetStudents.length} selected ${studentView === "class" ? selectedLateSignInRestrictionStudentIds.length > 0 ? "restriction-eligible " : "controllable " : "claimed "}student${targetStudents.length === 1 ? "" : "s"}${selectedLateSignInRestrictionStudentIds.length > 0 ? ` · ${selectedLateSignInRestrictionStudentIds.length} signed out` : ''}${selectedServerSignOutStudentIds.size > 0 ? ` · ${selectedServerSignOutStudentIds.size} selected for sign-out only` : ''}${studentView === 'claimed' ? ` in ${claimedTargetContextCount} supervision group${claimedTargetContextCount === 1 ? '' : 's'}` : ''}`
    : selectedServerSignOutStudentIds.size > 0
      ? `${selectedServerSignOutStudentIds.size} selected for sign-out only`
    : selectedSubgroupId && studentView === "class"
      ? `${subgroupName || "Subgroup"} - ${ownedClassBannerStudents.length} student${ownedClassBannerStudents.length === 1 ? "" : "s"}`
      : `All ${dashboardCapabilities.ownedClassSession ? ownedClassBannerStudents.length : targetStudents.length} student${(dashboardCapabilities.ownedClassSession ? ownedClassBannerStudents.length : targetStudents.length) === 1 ? "" : "s"}`;
  const observedViewLabel = subgroupCommandsDisabled
    ? `${subgroupName || 'Subgroup'} roster unavailable`
    : selectedSubgroupId
      ? `${subgroupName || "Subgroup"} - ${observedViewStudents.length} student${observedViewStudents.length === 1 ? "" : "s"}`
      : `All ${observedViewStudents.length} student${observedViewStudents.length === 1 ? "" : "s"}`;
  const targetConnectionLabel = [
    `${bannerCounts.connected} connected`,
    `${bannerCounts.updating} updating`,
    `${bannerCounts.signalLost} signal lost`,
    `${bannerCounts.updatesUnavailable} updates unavailable`,
    `${bannerCounts.signedOut} signed out`,
  ].join(' · ');
  const observedConnectionLabel = `${targetConnectionLabel}${bannerCounts.inSupervision > 0 ? ` · ${bannerCounts.inSupervision} in supervision` : ''}`;
  const bannerCountsKnown = classStudentCountsKnown
    && (!dashboardCapabilities.observedOtherClass || !subgroupCommandsDisabled);
  const displayedTargetBannerLabel = bannerCountsKnown
    ? dashboardCapabilities.observedOtherClass ? observedViewLabel : targetBannerLabel
    : 'Student data unavailable';
  const displayedTargetConnectionLabel = bannerCountsKnown
    ? dashboardCapabilities.observedOtherClass ? observedConnectionLabel : targetConnectionLabel
    : 'Counts unavailable';
  const selectedSignOutStudentIds = [
    ...new Set([
      ...selectedStudentIds,
      ...selectedServerSignOutStudentIds,
    ]),
  ];
  let selectedSignOutTarget = null;
  if (studentView === "class" && selectedSignOutStudentIds.length > 0) {
    try {
      selectedSignOutTarget = resolveActiveStudentSignOutTarget(selectedSignOutStudentIds);
    } catch {
      selectedSignOutTarget = null;
    }
  }
  const selectedSignOutStudents = selectedSignOutTarget?.targetStudents || EMPTY_LIST;
  const signOutSelectedCount = selectedSignOutStudents.length;
  const signOutSelectionLabel = `${signOutSelectedCount} explicitly selected student${signOutSelectedCount === 1 ? '' : 's'}`;
  const canSignOutSelectedStudents = studentView === "class" && !!effectiveSession?.id && signOutSelectedCount > 0;
  const canShowStudentWorkspace = isAdmin || (isTeacher && (activeSession || studentView !== "class"));
  const canUseRemoteControls = dashboardCapabilities.canUseRemoteControls
    && !classStudentTargetsUnavailable
    && !(
      sessionSubscriptionState.status === 'terminal_error'
      && sessionSubscriptionState.errorCode === 'SESSION_UNAVAILABLE'
    );
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

  const buildCommandRequest = (commandType, commandPayload = {}, options = {}) => {
    assertClassroomCommandSelectionIsolation(
      commandType,
      selectedServerSignOutStudentIds.size,
    );
    if (!dashboardCapabilities.allows(commandType)) {
      throw new Error(dashboardCapabilities.reason || 'This classroom command is not available in the current view.');
    }
    if (!dashboardCapabilities.effectiveSession?.id) {
      throw new Error("Start or select an active class session before sending classroom commands.");
    }
    if (commandType === 'student-sign-out') {
      const target = resolveActiveStudentSignOutTarget(options.studentIds ?? EMPTY_LIST);
      return {
        request: buildStudentSignOutCommandRequest(
          dashboardCapabilities.effectiveSession.id,
          target,
        ),
        target,
      };
    }
    const allowSafetyUnlock = commandType === 'unlock-screen'
      && Array.isArray(options.studentIds)
      && options.studentIds.length > 0;
    const target = resolveActiveCommandTarget(
      options.studentIds ?? null,
      { allowSafetyUnlock, commandType, commandPayload },
    );
    const subgroupTargetIds = new Set(selectedSubgroupId ? subgroupMembers : EMPTY_LIST);
    const intendedRows = target.targetScope === 'subgroup'
      ? sessionFilteredStudents.filter((student) => subgroupTargetIds.has(student.studentId))
      : target.targetScope === 'class'
        ? sessionFilteredStudents
        : target.targetStudents;
    const hasUnavailableCommandTarget = intendedRows.some((student) => (
      isStudentStructurallyCommandable(student)
      && !isStudentCommandableForCommand(
        student,
        commandType,
        commandPayload,
        { allowSafetyUnlock },
      )
    ));
    const requestTargetScope = hasUnavailableCommandTarget
      && (target.targetScope === 'class' || target.targetScope === 'subgroup')
      ? 'students'
      : target.targetScope;
    const request = {
      teachingSessionId: dashboardCapabilities.effectiveSession.id,
      targetScope: requestTargetScope,
      commandType,
      commandPayload,
    };
    if (requestTargetScope === 'students') request.targetStudentIds = target.targetStudentIds;
    if (requestTargetScope === 'subgroup') request.subgroupId = target.subgroupId;
    return { request, target };
  };

  const manageTabsStudents = getActiveCommandStudents(manageTabsStudentIds);
  const openTabs = manageTabsStudents
    .flatMap(s => {
      if (!monitoringDisplayFor(s).telemetryCurrent) return [];
      if (s.allOpenTabs && s.allOpenTabs.length > 0) {
        return s.allOpenTabs
          .filter((tab) => tab.url && !tab.url.startsWith('chrome://'))
          .map((tab) => ({
            ...tab,
            title: tab.title || 'Untitled',
            studentName: s.studentName,
            studentId: s.studentId,
            observedRevision: tab.observedRevision ?? s.tabSnapshotRevision ?? s.tabSnapshot?.revision,
            clientProtocolVersion: s.clientProtocolVersion,
            capabilities: s.capabilities,
            extensionCapabilities: s.extensionCapabilities,
            active: tab.tabRef === s.activeTabRef || tab.url === s.activeTabUrl,
          }));
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
  const manageTabsTargetLabel = manageTabsTargetSnapshot || (manageTabsStudentIds?.length === 1
    ? (students.find((student) => student.studentId === manageTabsStudentIds[0])?.studentName || "Selected student")
    : targetBannerLabel);

  // Check for blocked domain violations
  useEffect(() => {
    if (!settings?.blockedDomains || settings.blockedDomains.length === 0) return;
    students.forEach((student) => {
      const studentId = student.studentId;
      if (
        isStudentMonitoringSuppressed(student)
        || !monitoringDisplayFor(student).telemetryCurrent
        || !student.activeTabUrl
      ) {
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
  }, [freshnessNowMs, isStudentMonitoringSuppressed, monitoringDisplayFor, settings, students, toast]);

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
      queryClient.invalidateQueries({ queryKey: ['/api/coverage/available-students'] });
      queryClient.invalidateQueries({ queryKey: ['/api/coverage/claimed-students'] });
      queryClient.invalidateQueries({ queryKey: ['/api/coverage/contexts'] });
      queryClient.invalidateQueries({ queryKey: ['/api/sessions/active'], exact: false });
      queryClient.invalidateQueries({ queryKey: ['/api/students-aggregated'] });
      queryClient.invalidateQueries({ queryKey: ['/api/groups'], exact: false });
      queryClient.invalidateQueries({ queryKey: ['/api/teacher/groups'], exact: false });
      toast({ title: "Class Started", description: "Scheduled class started. Temporary scheduled coverage was released." });
    },
    onError: (error) => {
      if (error.response?.data?.code === "SCHEDULED_CONFLICT_EXPIRED") {
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

  const skipScheduledClassMutation = useMutation({
    mutationFn: async (groupId) => (
      apiRequest('POST', `/classpilot/scheduled-classes/${encodeURIComponent(groupId)}/skip-today`, {})
    ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/groups'], exact: false });
      queryClient.invalidateQueries({ queryKey: ['/api/teacher/groups'], exact: false });
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
      if (!dashboardCapabilities.observedOtherClass) setStudentView("claimed");
      const isQuickClaim = variables?.quickClaimStudentId && variables?.students?.length === 1;
      toast({
        title: isQuickClaim ? "Student claimed" : "Students claimed",
        description: isQuickClaim ? "The student is now in your claimed view." : "They are now in your claimed view.",
      });
    },
    onError: (error) => {
      if (error.response?.data?.code === "SCHEDULED_CONFLICT_EXPIRED") {
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
      setSelectedServerSignOutStudentIds((prev) => {
        const next = new Set(prev);
        (variables?.studentIds || []).forEach((studentId) => next.delete(studentId));
        return next;
      });
      setSelectedStudentBindingSnapshots((prev) => {
        const next = new Map(prev);
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
    if (dashboardCapabilities.observedOtherClass) return;
    if (!studentsToClaim.length) {
      toast({ variant: "destructive", title: "Select students first" });
      return;
    }
    setQuickClaimStudentId(options.quickClaimStudentId || null);
    claimPickupMutation.mutate({ students: studentsToClaim, quickClaimStudentId: options.quickClaimStudentId || null });
  };

  const handleStartScheduledConflict = (conflictId) => {
    if (dashboardCapabilities.observedOtherClass) return;
    startScheduledConflictMutation.mutate(conflictId);
  };

  const handleRerouteSelected = () => {
    if (dashboardCapabilities.observedOtherClass) return;
    try {
      assertClassroomCommandSelectionIsolation(
        'coverage-reroute',
        selectedServerSignOutStudentIds.size,
      );
    } catch (error) {
      toast({ variant: "destructive", title: "Clear sign-out selection", description: error.message });
      return;
    }
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
    if (dashboardCapabilities.observedOtherClass) return;
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
    const commandId = data?.command?.id;
    const targets = (data?.command?.targets || data?.targets || []).map((target) => ({
      ...target,
      ...(commandId && !target.commandId ? { commandId } : {}),
    }));
    const enrichedData = {
      ...data,
      command: data?.command ? { ...data.command, targets } : data?.command,
    };
    const tracked = trackTransientCommandResponse(
      transientCommandOutcomesRef.current,
      enrichedData,
      commandType,
    );
    if (tracked !== transientCommandOutcomesRef.current) {
      transientCommandOutcomesRef.current = tracked;
      setTransientPendingControls(pendingTransientControls(tracked));
      setTransientCommandVersion((version) => version + 1);
    }
    const deliveryFeedback = commandDeliveryFeedback(enrichedData, commandType);
    const studentNames = [...students, ...claimedPickupStudents].reduce((names, student) => {
      if (student?.studentId) names[student.studentId] = student.studentName || student.studentEmail || 'Student';
      return names;
    }, {});
    const decorated = {
      ...enrichedData,
      deliveryFeedback,
      message: deliveryFeedback.description,
      studentNames,
      targetLabel: targetBannerLabel,
      createdAt: new Date().toISOString(),
    };
    return decorated;
  };

  const postClassroomCommand = async (commandType, commandPayload, options = {}) => {
    const { request, target } = buildCommandRequest(commandType, commandPayload, options);
    const data = await apiRequest('POST', '/commands', request);
    return decorateCommandResponse({
      ...data,
      request,
      targetStudentIds: target.targetStudentIds,
    }, commandType);
  };

  const postClaimedCommand = async (commandType, commandPayload, options = {}) => {
    const target = resolveActiveCommandTarget(options.studentIds ?? null);
    const settlements = await Promise.allSettled(target.groups.map((group) =>
      apiRequest('POST', `/coverage/contexts/${group.id}/commands`, {
        targetScope: "students",
        targetStudentIds: group.targetStudentIds,
        commandType,
        commandPayload,
      })
    ));
    const combined = combineCommandSettlements(settlements, target.groups, commandType);
    return decorateCommandResponse({
      ...combined,
      targetStudentIds: target.targetStudentIds,
    }, commandType);
  };

  const postActiveCommand = (commandType, commandPayload, options = {}) => {
    assertClassroomCommandSelectionIsolation(
      commandType,
      selectedServerSignOutStudentIds.size,
    );
    if (!dashboardCapabilities.allows(commandType)) {
      throw new Error(dashboardCapabilities.reason || 'This classroom command is not available in the current view.');
    }
    return studentView === "claimed"
      ? postClaimedCommand(commandType, commandPayload, options)
      : postClassroomCommand(commandType, commandPayload, options);
  };

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
    mutationFn: async ({ closeAll, tabsToClose, studentIds }) => {
      const payload = closeAll ? { closeAll: true } : { tabsToClose };
      return postActiveCommand('close-tabs', payload, { studentIds });
    },
    onSuccess: (data) => {
      toast(data.deliveryFeedback);
      setShowCloseTabsDialog(false);
      setSelectedTabsToClose(new Set());
      setManageTabsStudentIds(null);
      setManageTabsTargetSnapshot("");
      refreshScreenshotsForDevices();
    },
    onError: (error) => { toast({ variant: "destructive", title: "Error", description: error.message }); },
  });

  const lockScreenMutation = useMutation({
    mutationFn: async ({ url, studentIds }) => postActiveCommand('lock-screen', { url }, { studentIds }),
    onSuccess: (data, variables) => {
      const skippedCount = Number(variables.skippedSignedOutCount || 0);
      toast(skippedCount > 0
        ? {
            ...data.deliveryFeedback,
            description: `${data.deliveryFeedback.description} ${skippedCount} signed-out student${skippedCount === 1 ? ' was' : 's were'} skipped because a current page is not available before sign-in.`,
          }
        : data.deliveryFeedback);
      setShowLockScreenDialog(false);
      // Auto-allow an explicit lock domain so on-task students aren't flagged
      if (variables.url !== 'CURRENT_URL') {
        try { const d = new URL(variables.url).hostname.toLowerCase().replace(/^www\./, ''); handleAllowDomain(d); } catch { /* ignore invalid URL */ }
      }
      setLockScreenUrl("");
      setLockScreenMode("current");
      refreshScreenshotsForDevices();
    },
    onError: (error) => {
      toast({ variant: "destructive", title: "Error", description: error.message });
    },
  });

  const unlockScreenMutation = useMutation({
    mutationFn: async ({ studentIds } = {}) => postActiveCommand('unlock-screen', { screenOnly: true }, { studentIds }),
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
      const parsed = parseTabSelectionKey(compositeKey);
      if (parsed) tabsToClose.push(parsed);
    });
    if (tabsToClose.length !== selectedTabsToClose.size) {
      toast({ variant: "destructive", title: "Tabs changed", description: "Refresh the tab list and select the tabs again." });
      setSelectedTabsToClose(new Set());
      return;
    }
    closeTabsMutation.mutate({
      tabsToClose,
      studentIds: [...new Set(tabsToClose.map((tab) => tab.studentId))],
    });
    setSelectedTabsToClose(new Set());
  };

  const handleCloseSingleTab = (tab) => {
    const tabKey = tabSelectionKey(tab);
    if (!tabKey || !exactTabCloseCapability(tab).enabled) {
      toast({ variant: "destructive", title: "Extension update required", description: exactTabCloseCapability(tab).reason });
      return;
    }
    closeTabsMutation.mutate({
      tabsToClose: [parseTabSelectionKey(tabKey)],
      studentIds: [tab.studentId],
    });
  };

  const handleLockScreen = () => {
    const command = toolbarScreenCommand('lock-screen', selectedStudentIds);
    if (!command || !exactSelectedTargetsResolved) {
      toast({ variant: "destructive", title: "Select students first", description: "Choose one or more students first." });
      return;
    }
    setLockScreenMode("current");
    setLockScreenUrl("");
    setShowLockScreenDialog(true);
  };

  const handleConfirmLockScreen = () => {
    const command = toolbarScreenCommand('lock-screen', selectedStudentIds);
    if (!command || !exactSelectedTargetsResolved) {
      toast({ variant: "destructive", title: "Select students first", description: "Choose one or more students first." });
      return;
    }
    let url = command.commandPayload.url;
    let studentIds = command.studentIds;
    let skippedSignedOutCount = 0;
    if (lockScreenMode === "url") {
      if (!lockScreenUrl.trim()) { toast({ variant: "destructive", title: "Invalid URL", description: "Enter a domain or URL to set as the waypoint" }); return; }
      url = lockScreenUrl.trim();
      if (!url.match(/^https?:\/\//i)) url = 'https://' + url;
    } else {
      const partition = partitionCurrentPageWaypointTargets(
        explicitlySelectedStudents,
        (student) => monitoringDisplayFor(student).telemetryCurrent,
      );
      studentIds = partition.targetStudentIds;
      skippedSignedOutCount = partition.skippedStudentIds.length;
      if (studentIds.length === 0) {
        toast({
          title: 'No current pages available',
          description: `${skippedSignedOutCount} signed-out student${skippedSignedOutCount === 1 ? ' was' : 's were'} skipped. Choose a specific domain or URL to save a Waypoint before sign-in.`,
        });
        return;
      }
    }
    lockScreenMutation.mutate({ url, studentIds, skippedSignedOutCount });
  };

  const handleUnlockScreen = () => {
    const command = toolbarScreenCommand('unlock-screen', selectedStudentIds);
    if (!command || !exactSelectedUnlockTargetsResolved) {
      toast({ variant: "destructive", title: "Select students first", description: "Choose one or more students first." });
      return;
    }
    if (!selectedTargetsSupportScreenOnlyUnlock) {
      toast({ variant: "destructive", title: "Extension update required", description: "Every selected student must use a ClassPilot version that supports screen-only unlock." });
      return;
    }
    unlockScreenMutation.mutate({ studentIds: command.studentIds });
  };

  const openManageTabs = (studentIds = null) => {
    const namedStudent = studentIds?.length === 1
      ? [...students, ...claimedPickupStudents].find((student) => student.studentId === studentIds[0])
      : null;
    setManageTabsTargetSnapshot(namedStudent?.studentName || targetBannerLabel);
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
    mutationFn: async ({ studentIds } = {}) => postActiveCommand('remove-flight-path', {}, { studentIds }),
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
    const applicability = flightPathApplyCapability(flightPath);
    if (!applicability.enabled) {
      toast({ variant: "destructive", title: "Flight Path Cannot Be Applied", description: applicability.reason });
      return;
    }
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
    mutationFn: async ({ studentIds } = {}) => postActiveCommand('remove-block-list', {}, { studentIds }),
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

  const handleTileCommand = async ({ commandType, commandPayload = {}, studentIds = [] }) => {
    const studentId = studentIds[0];
    if (!studentId) return;
    if (nonRestrictionSelectionActive) {
      toast({
        variant: 'destructive',
        title: 'Clear the current selection',
        description: 'Clear signed-out or sign-out-only selections before using an individual student action.',
      });
      return;
    }
    setTileCommandState((current) => ({ ...current, [studentId]: { pending: true, error: '' } }));
    try {
      const data = await postActiveCommand(commandType, commandPayload, { studentIds });
      toast(data.deliveryFeedback);
      refreshScreenshotsForDevices();
      setTileCommandState((current) => ({ ...current, [studentId]: { pending: false, error: '' } }));
    } catch (error) {
      const message = error?.message || 'The classroom command could not be sent.';
      setTileCommandState((current) => ({ ...current, [studentId]: { pending: false, error: message } }));
      toast({ variant: 'destructive', title: 'Command failed', description: message });
    }
  };

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
      return postClassroomCommand('student-sign-out', studentSignOutCommandPayload(), { studentIds });
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
    mutationFn: async (enabled) => {
      if (!dashboardCapabilities.canChangeFabSettings || !effectiveSession?.id) throw new Error('Session settings are available only for your active class.');
      return apiRequest('PUT', `/classpilot/teaching-sessions/${encodeURIComponent(effectiveSession.id)}/settings`, sessionFabSettingsPayload(
        sessionFabState,
        { raiseHandEnabled: enabled },
      ));
    },
    onSuccess: (data) => {
      const nextState = normalizeSessionFabState(data?.state, effectiveSessionIdRef.current);
      if (nextState) setSessionFabState(nextState);
      queryClient.invalidateQueries({ queryKey: ['/api/settings'] });
      const enabled = data?.state?.handRaisingEnabled === true;
      toast({ title: enabled ? "Hand Raising Enabled" : "Hand Raising Disabled", description: enabled ? "Students can now raise their hands" : "Students cannot raise their hands" });
    },
    onError: (error) => {
      const current = error?.response?.data?.current || error?.data?.current;
      const nextState = normalizeSessionFabState(current, effectiveSessionIdRef.current);
      if (nextState) setSessionFabState(nextState);
      queryClient.invalidateQueries({ queryKey: ['/api/settings'] });
      toast({ variant: "destructive", title: "Error", description: error.message });
    },
  });

  const toggleStudentMessagingMutation = useMutation({
    mutationFn: async (enabled) => {
      if (!dashboardCapabilities.canChangeFabSettings || !effectiveSession?.id) throw new Error('Session settings are available only for your active class.');
      return apiRequest('PUT', `/classpilot/teaching-sessions/${encodeURIComponent(effectiveSession.id)}/settings`, sessionFabSettingsPayload(
        sessionFabState,
        { chatEnabled: enabled },
      ));
    },
    onSuccess: (data) => {
      const nextState = normalizeSessionFabState(data?.state, effectiveSessionIdRef.current);
      if (nextState) setSessionFabState(nextState);
      queryClient.invalidateQueries({ queryKey: ['/api/settings'] });
      const enabled = data?.state?.messagingEnabled === true;
      toast({ title: enabled ? "Student Messaging Enabled" : "Student Messaging Disabled", description: enabled ? "Students can now send messages" : "Students cannot send messages" });
    },
    onError: (error) => {
      const current = error?.response?.data?.current || error?.data?.current;
      const nextState = normalizeSessionFabState(current, effectiveSessionIdRef.current);
      if (nextState) setSessionFabState(nextState);
      queryClient.invalidateQueries({ queryKey: ['/api/settings'] });
      toast({ variant: "destructive", title: "Error", description: error.message });
    },
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

  const monitoringTransportUnavailable = studentsQueryError && !sessionRealtimeHealthy;
  const connectionPresentation = !effectiveSessionId
    ? monitoringTransportUnavailable
      ? { label: 'Monitoring updates unavailable', tone: 'unavailable' }
      : { label: 'Refreshing', tone: 'neutral' }
    : sessionRealtimeHealthy
      ? { label: 'Live updates', tone: 'live' }
      : monitoringTransportUnavailable
        ? { label: 'Monitoring updates unavailable', tone: 'unavailable' }
        : sessionSubscriptionState.status === 'pending'
          ? { label: 'Syncing', tone: 'syncing' }
          : { label: 'Using server refresh', tone: 'syncing' };
  const connectionToneClasses = connectionPresentation.tone === 'live'
    ? 'bg-green-500/15 border border-green-500/30 text-green-400'
    : connectionPresentation.tone === 'unavailable'
      ? 'bg-amber-500/15 border border-amber-500/30 text-amber-300'
      : connectionPresentation.tone === 'syncing'
        ? 'bg-amber-400/15 border border-amber-400/30 text-amber-300'
        : 'bg-slate-600/30 border border-slate-500/30 text-slate-300';
  const connectionDotClasses = connectionPresentation.tone === 'live'
    ? 'bg-green-400 animate-pulse'
    : connectionPresentation.tone === 'unavailable' || connectionPresentation.tone === 'syncing'
      ? 'bg-amber-400'
      : 'bg-slate-400';

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
              <div className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium ${connectionToneClasses}`} data-testid="badge-connection-status">
                <div className={`h-2 w-2 rounded-full ${connectionDotClasses}`} />
                {connectionPresentation.label}
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
                          disabled={dashboardCapabilities.observedOtherClass || resyncSessionMutation.isPending}
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
                          disabled={dashboardCapabilities.observedOtherClass || resyncSessionMutation.isPending}
                          className="flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-semibold border border-slate-600 bg-slate-900 text-slate-100 hover:bg-slate-800 transition-colors disabled:opacity-50"
                          data-testid="button-admin-resync-session"
                        >
                          <RefreshCw className={`h-3.5 w-3.5 ${resyncSessionMutation.isPending ? "animate-spin" : ""}`} /> Resync Class
                        </button>
                      )}
                      <button onClick={() => setEndClassTarget(activeSession)} disabled={dashboardCapabilities.observedOtherClass || endSessionMutation.isPending} className="flex items-center gap-1.5 px-4 py-1.5 rounded-full text-xs font-semibold bg-red-500 text-white hover:bg-red-600 transition-colors disabled:opacity-50" data-testid="button-admin-end-session">
                        <X className="h-3.5 w-3.5" /> End Class
                      </button>
                    </>
                  )}
                  {!activeSession && (
                    <div className="flex items-center gap-2">
                      <select
                        value={adminStartGroupId}
                        onChange={(event) => setAdminStartGroupId(event.target.value)}
                        disabled={dashboardCapabilities.observedOtherClass || adminTeachingGroupsLoading || adminTeachingGroups.length === 0 || startSessionMutation.isPending}
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
                        disabled={dashboardCapabilities.observedOtherClass || !adminStartGroupId || adminTeachingGroupsLoading || adminTeachingGroups.length === 0 || startSessionMutation.isPending}
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
                          disabled={dashboardCapabilities.observedOtherClass || skipScheduledClassMutation.isPending}
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
                      onChange={handleAdminObservedSessionChange}
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

      {/* Sidebar + Main Content */}
      <ClassPilotSidebar isOpen={sidebarOpen} onToggle={handleSidebarToggle} />
      <main className={`transition-all duration-300 ${showSidebar ? 'lg:ml-80' : ''}`}>
        <div className="max-w-screen-2xl mx-auto px-6 py-8">
        {/* Remote Control Toolbar */}
        {(isAdmin || isTeacher) && (
          <RemoteControlToolbar
            selectedStudentIds={selectedStudentIds}
            onToggleStudent={toggleStudentSelection}
            onClearSelection={clearSelection}
            selectedGrade={selectedGrade}
            onGradeChange={setSelectedGrade}
            userRole={isAdmin ? 'admin' : 'teacher'}
            schoolId={activeSchoolId}
            viewerId={currentUser?.id}
            coverageCount={manageableCoverageCount || claimedContextCount}
            availableCount={availablePickupStudents.length + scheduledCoverageGroups.reduce((total, group) => total + (group.students?.length || group.claimableCount || 0), 0)}
            claimedCount={claimedPickupStudents.length}
            pickupView={studentView}
            showCoverageRail={!dashboardCapabilities.observedOtherClass}
            onPickupViewChange={dashboardCapabilities.observedOtherClass ? undefined : handleStudentViewChange}
            onOpenCoverage={!dashboardCapabilities.observedOtherClass && canManageSupervisionSetup ? () => navigate("/classpilot/coverage") : undefined}
            canReroute={dashboardCapabilities.ownedClassSession && !nonRestrictionSelectionActive}
            onReroute={dashboardCapabilities.ownedClassSession && !nonRestrictionSelectionActive ? () => setShowRerouteDialog(true) : undefined}
            canViewHistoricalTelemetry={isAdmin || isTeacher}
          />
        )}

        {dashboardCapabilities.observedOtherClass ? (
          <div className="mb-6 flex items-start gap-3 rounded-lg border border-blue-200 bg-blue-50 px-4 py-3 text-sm text-blue-950 dark:border-blue-900 dark:bg-blue-950/30 dark:text-blue-100" role="status" data-testid="observe-read-only-banner">
            <Eye className="mt-0.5 h-4 w-4 shrink-0" />
            <div><p className="font-semibold">Observe mode is read-only</p><p className="mt-1 text-xs opacity-80">Screen previews and activity can be reviewed, but selections, device commands, and Teacher FAB tools are disabled for another teacher&apos;s class.</p></div>
          </div>
        ) : null}

        {studentView === 'class' && effectiveSessionId ? (
          <p className="mb-4 text-xs text-muted-foreground" data-testid="screenshot-refresh-disclosure">
            Screen previews update automatically while this class is open. They are recent screenshots, not live video.
          </p>
        ) : null}

        {/* Stats Cards */}
        {canShowStudentWorkspace && (
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
            <div className="p-5 rounded-xl bg-green-500/10 border border-green-500/20 dark:bg-green-500/10 dark:border-green-500/20 transition-all duration-300">
              <div className="flex items-center gap-4">
                <div className="h-12 w-12 rounded-xl bg-green-500 flex items-center justify-center"><Users className="h-6 w-6 text-white" /></div>
                <div><p className="text-[28px] font-bold text-foreground" data-testid="text-online-count">{classStudentCountsKnown ? onlineCount : '—'}</p><p className="text-[13px] text-green-500 font-medium">Online Now</p></div>
              </div>
            </div>
            <div className="p-5 rounded-xl bg-amber-500/10 border border-amber-500/20 dark:bg-amber-500/10 dark:border-amber-500/20 transition-all duration-300">
              <div className="flex items-center gap-4">
                <div className="h-12 w-12 rounded-xl bg-amber-500 flex items-center justify-center"><Activity className="h-6 w-6 text-slate-900" /></div>
                <div><p className="text-[28px] font-bold text-foreground" data-testid="text-idle-count">{classStudentCountsKnown ? idleCount : '—'}</p><p className="text-[13px] text-amber-500 font-medium">Idle</p></div>
              </div>
            </div>
            <div className="p-5 rounded-xl bg-slate-500/10 border border-slate-500/20 dark:bg-slate-500/10 dark:border-slate-500/20 transition-all duration-300">
              <div className="flex items-center gap-4">
                <div className="h-12 w-12 rounded-xl bg-slate-500 flex items-center justify-center"><WifiOff className="h-6 w-6 text-white" /></div>
                <div><p className="text-[28px] font-bold text-foreground" data-testid="text-offline-count">{classStudentCountsKnown ? offlineCount : '—'}</p><p className="text-[13px] text-muted-foreground font-medium">Not logged in</p></div>
              </div>
            </div>
            <div className="p-5 rounded-xl bg-red-500/10 border border-red-500/20 dark:bg-red-500/10 dark:border-red-500/20 transition-all duration-300">
              <div className="flex items-center gap-4">
                <div className="h-12 w-12 rounded-xl bg-red-500 flex items-center justify-center"><AlertTriangle className="h-6 w-6 text-white" /></div>
                <div><p className="text-[28px] font-bold text-foreground" data-testid="text-offtask-count">{classStudentCountsKnown ? offTaskCount : '—'}</p><p className="text-[13px] text-red-500 font-medium">Off-Task Alert</p></div>
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
                <div className="text-[13px] font-semibold">{dashboardCapabilities.observedOtherClass ? 'Viewing' : 'Target'}: {activeClassName} - {displayedTargetBannerLabel}</div>
                <div className="text-[11px] font-medium opacity-80">{displayedTargetConnectionLabel}</div>
              </div>
              {!dashboardCapabilities.observedOtherClass ? (
                <>
                  <button
                    onClick={selectAll}
                    disabled={signOutOnlySelectionActive || selectableStudents.length === 0 || selectedStudentIds.size === selectableStudents.length}
                    className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-[13px] font-medium bg-transparent border border-border text-muted-foreground hover:bg-card transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                    data-testid="button-select-all-students"
                  >
                    <Users className="h-4 w-4" /> Select All ({selectableStudents.length})
                  </button>
                  <button onClick={clearSelection} disabled={selectedStudentIds.size === 0 && selectedServerSignOutStudentIds.size === 0} className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-[13px] font-medium bg-transparent border border-border text-muted-foreground hover:bg-card transition-colors disabled:opacity-50 disabled:cursor-not-allowed" data-testid="button-clear-selection">
                    Clear Selection
                  </button>
                </>
              ) : null}
            </div>
          </div>
        )}

        {/* Control Buttons */}
        {canUseRemoteControls && studentView !== "available" && (
          <div className="flex items-center gap-2 flex-wrap mb-4">
            {dashboardCapabilities.allows('open-tab') && <Button size="sm" variant="outline" onClick={() => setShowOpenTabDialog(true)} disabled={subgroupCommandsDisabled || nonRestrictionSelectionActive} data-testid="button-open-tab" className="text-blue-600 dark:text-blue-400"><MonitorPlay className="h-4 w-4 mr-2" />Open URL</Button>}
            {dashboardCapabilities.allows('close-tabs') && <Button size="sm" variant="outline" onClick={() => openManageTabs(null)} disabled={subgroupCommandsDisabled || nonRestrictionSelectionActive} data-testid="button-tabs" className="text-blue-600 dark:text-blue-400"><List className="h-4 w-4 mr-2" />Manage Tabs</Button>}
            {dashboardCapabilities.allows('lock-screen') && <Button size="sm" variant="outline" onClick={handleLockScreen} disabled={subgroupCommandsDisabled || signOutOnlySelectionActive || !exactSelectedTargetsResolved || lockScreenMutation.isPending || unlockScreenMutation.isPending} title={exactSelectedTargetsResolved ? 'Set a waypoint: hold selected students at their current page or a specific domain' : 'Select one or more students first'} data-testid="button-lock-screen" className="text-amber-600 dark:text-amber-400"><Lock className="h-4 w-4 mr-2" />Set Waypoint</Button>}
            {dashboardCapabilities.allows('unlock-screen') && <Button size="sm" variant="outline" onClick={handleUnlockScreen} disabled={subgroupCommandsDisabled || signOutOnlySelectionActive || !selectedTargetsSupportScreenOnlyUnlock || lockScreenMutation.isPending || unlockScreenMutation.isPending} title={!exactSelectedUnlockTargetsResolved ? 'Select one or more students first' : selectedTargetsSupportScreenOnlyUnlock ? 'Clear the waypoint while preserving Flight Paths and other restrictions' : 'ClassPilot extension update required for every selected student'} data-testid="button-unlock-screen" className="text-amber-600 dark:text-amber-400"><Unlock className="h-4 w-4 mr-2" />Clear Waypoint</Button>}
            {dashboardCapabilities.allows('apply-flight-path') && <Button size="sm" variant="outline" onClick={() => setShowApplyFlightPathDialog(true)} disabled={subgroupCommandsDisabled || signOutOnlySelectionActive} data-testid="button-apply-flight-path" className="text-purple-600 dark:text-purple-400"><Layers className="h-4 w-4 mr-2" />Apply Flight Path</Button>}
            {dashboardCapabilities.allows('remove-flight-path') && <Button size="sm" variant="outline" onClick={() => removeFlightPathMutation.mutate({})} disabled={subgroupCommandsDisabled || signOutOnlySelectionActive || removeFlightPathMutation.isPending} data-testid="button-remove-flight-path" className="text-purple-600 dark:text-purple-400"><X className="h-4 w-4 mr-2" />Remove Flight Path</Button>}
            {studentView === "class" && <Button size="sm" variant="outline" onClick={() => setShowFlightPathViewerDialog(true)} disabled={signOutOnlySelectionActive} data-testid="button-flight-path-status" className="text-purple-600 dark:text-purple-400"><Eye className="h-4 w-4 mr-2" />Flight Path Status</Button>}
            {dashboardCapabilities.allows('apply-block-list') && <Button size="sm" variant="outline" onClick={() => setShowApplyBlockListDialog(true)} disabled={subgroupCommandsDisabled || signOutOnlySelectionActive} data-testid="button-apply-block-list" className="text-red-600 dark:text-red-400"><ShieldBan className="h-4 w-4 mr-2" />Apply Block List</Button>}
            {dashboardCapabilities.allows('remove-block-list') && <Button size="sm" variant="outline" onClick={() => removeBlockListMutation.mutate({})} disabled={subgroupCommandsDisabled || signOutOnlySelectionActive || removeBlockListMutation.isPending} data-testid="button-remove-block-list" className="text-red-600 dark:text-red-400"><X className="h-4 w-4 mr-2" />Remove Block List</Button>}
            {studentView === "class" && <Button size="sm" variant="outline" onClick={() => setShowBlockListViewerDialog(true)} disabled={signOutOnlySelectionActive} data-testid="button-block-list-status" className="text-red-600 dark:text-red-400"><Shield className="h-4 w-4 mr-2" />Block List Status</Button>}
            {studentView === "class" && (
              <Button
                size="sm"
                variant="outline"
                onClick={() => { setSignOutTargetSnapshot(signOutSelectionLabel); setShowSignOutDialog(true); }}
                disabled={subgroupCommandsDisabled || !canSignOutSelectedStudents || signOutStudentsMutation.isPending}
                data-testid="button-sign-out-students"
                className="border-gray-300 bg-gray-200 text-black hover:bg-gray-300 hover:text-black disabled:cursor-not-allowed disabled:border-gray-200 disabled:bg-gray-200 disabled:text-black/60 disabled:opacity-40"
              >
                <LogOut className="h-4 w-4 mr-2" />
                Student Sign Out
              </Button>
            )}
          </div>
        )}

        {studentView === "class" && subgroups.length > 0 && (
          <div className="mb-4 flex items-center gap-2">
            <label className={`inline-flex h-8 items-center gap-2 rounded-md border bg-background px-3 text-xs font-medium shadow-sm ${selectedSubgroupId ? "border-pink-300 text-pink-600 dark:text-pink-400" : "border-input text-pink-600 dark:text-pink-400"}`}>
              <UsersRound className="h-4 w-4" />
              <span className="sr-only">Filter by subgroup</span>
              <select
                value={selectedSubgroupId}
                onChange={(event) => {
                  setSelectedSubgroupId(event.target.value);
                  setSelectedStudentIds(new Set());
                  setSelectedServerSignOutStudentIds(new Set());
                  setSelectedStudentBindingSnapshots(new Map());
                }}
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
          </div>
        )}

        {classStudentRefreshFailed ? (
          <div className="mb-4 flex items-center justify-between gap-3 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-950 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-100" role="status" data-testid="students-refresh-error">
            <span>
              Showing the last student data because the dashboard refresh failed.
              {studentsRequestId ? <span className="ml-1 font-mono" data-testid="students-refresh-request-id">Request ID: {studentsRequestId}</span> : null}
            </span>
            <Button type="button" size="sm" variant="outline" onClick={() => refetchStudents()} disabled={studentsRefreshing}><RefreshCw className="mr-2 h-3.5 w-3.5" />Retry</Button>
          </div>
        ) : null}

        {effectiveSessionId && sessionSubscriptionState.status === 'terminal_error' ? (
          <div className="mb-4 flex items-center justify-between gap-3 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-950 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-100" role="status" data-testid="session-subscription-error">
            <span>
              {sessionSubscriptionState.errorCode === 'SESSION_UNAVAILABLE'
                ? 'This class session ended or is no longer available. Student controls remain disabled.'
                : 'Live class updates are unavailable. The dashboard will continue using server refreshes.'}
            </span>
            <Button type="button" size="sm" variant="outline" onClick={() => refetchStudents()} disabled={studentsRefreshing}>
              <RefreshCw className="mr-2 h-3.5 w-3.5" />Refresh
            </Button>
          </div>
        ) : null}

        {studentView === 'class' && selectedSubgroupId && !subgroupSelectionReady ? (
          <div
            className={`mb-4 flex items-center justify-between gap-3 rounded-lg border px-4 py-3 text-sm ${subgroupMembersError ? 'border-red-200 bg-red-50 text-red-950 dark:border-red-900 dark:bg-red-950/30 dark:text-red-100' : 'border-blue-200 bg-blue-50 text-blue-950 dark:border-blue-900 dark:bg-blue-950/30 dark:text-blue-100'}`}
            role={subgroupMembersError ? 'alert' : 'status'}
            data-testid="subgroup-members-status"
          >
            <span>
              {subgroupMembersError
                ? subgroupMembersLoadError?.message || 'The selected subgroup roster could not be loaded. Commands remain disabled.'
                : 'Loading the selected subgroup roster. Commands are disabled until it is ready.'}
            </span>
            {subgroupMembersError ? (
              <Button type="button" size="sm" variant="outline" onClick={() => refetchSubgroupMembers()}>
                <RefreshCw className="mr-2 h-3.5 w-3.5" />Retry
              </Button>
            ) : null}
          </div>
        ) : null}

        {observationLeaseStatus === 'denied' ? (
          <div className="mb-4 rounded-lg border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-700 dark:border-slate-800 dark:bg-slate-950/40 dark:text-slate-200" role="status" data-testid="screenshot-observation-denied">
            Screen-preview authorization is no longer available for this class view. Cached previews and history were cleared.
          </div>
        ) : observationLeaseStatus === 'paused_unobserved' ? (
          <div className="mb-4 rounded-lg border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-700 dark:border-slate-800 dark:bg-slate-950/40 dark:text-slate-200" role="status" data-testid="screenshot-observation-paused">
            Screen previews are paused because this class view is not actively observed. Activity reporting continues from heartbeats.
          </div>
        ) : observationLeaseStatus === 'error' ? (
          <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-950 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-100" role="status" data-testid="screenshot-observation-error">
            Screen-preview observation could not be renewed. Activity reporting continues, but new ambient screenshots are paused.
          </div>
        ) : null}

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
                      <div className="flex flex-wrap items-center gap-2">
                        {section.canStartClass && (
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => handleStartScheduledConflict(section.id)}
                            disabled={startScheduledConflictMutation.isPending}
                            data-testid={`button-start-scheduled-coverage-${section.id}`}
                          >
                            Start Class
                          </Button>
                        )}
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
        ) : classStudentDataUnavailable ? (
          <div className="py-20 text-center" role="alert" data-testid="students-query-error">
            <div className="h-20 w-20 mx-auto mb-6 rounded-2xl bg-red-500/10 flex items-center justify-center"><AlertTriangle className="h-10 w-10 text-red-500" /></div>
            <h3 className="text-xl font-semibold mb-2">Student dashboard could not load</h3>
            <p className="text-sm text-muted-foreground max-w-md mx-auto">Student data could not be loaded from the server.</p>
            {studentsRequestId ? <p className="mt-2 font-mono text-xs text-muted-foreground" data-testid="students-error-request-id">Request ID: {studentsRequestId}</p> : null}
            <Button type="button" variant="outline" className="mt-6" onClick={() => refetchStudents()} disabled={studentsRefreshing}><RefreshCw className="mr-2 h-4 w-4" />Try again</Button>
          </div>
        ) : studentView === "class" && studentsLoading ? (
          <div className="py-20 text-center">
            <div className="h-10 w-10 mx-auto mb-4 animate-spin rounded-full border-4 border-muted border-t-primary" />
            <p className="text-sm text-muted-foreground">Loading students...</p>
          </div>
        ) : subgroupCommandsDisabled ? (
          <div className="py-12 text-center text-sm text-muted-foreground">
            The student grid will appear after the selected subgroup roster is ready.
          </div>
        ) : filteredStudents.length === 0 ? (
          <div className="py-20 text-center">
            <div className="h-20 w-20 mx-auto mb-6 rounded-2xl bg-muted/30 flex items-center justify-center"><Monitor className="h-10 w-10 text-muted-foreground/50" /></div>
            <h3 className="text-xl font-semibold mb-2">No students found</h3>
            <p className="text-sm text-muted-foreground max-w-md mx-auto">
              {searchQuery ? "Try adjusting your search query to find students" : "No students are available in this view."}
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5 2xl:grid-cols-6 gap-6">
            {filteredStudents.map((student) => {
              const studentRealtimeKey = student.studentId;
              const supervisedElsewhere = isStudentMonitoringSuppressed(student);
              const monitoringDisplay = supervisedElsewhere
                ? null
                : studentView === 'class'
                  ? monitoringDisplayFor(student)
                  : deriveStudentMonitoringDisplay(student, freshnessNowMs);
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
              const supervisionReason = supervisedElsewhere
                ? `${student.studentName || "This student"} is currently claimed by ${supervisionStaffName || student.supervisionContext?.name || "another supervision session"}.`
                : "";
              const returnToClassPending = returnToClassMutation.isPending &&
                returnToClassMutation.variables?.studentIds?.includes(student.studentId);
              const screenshotRefreshState = screenshotRefreshStateByStudent.get(student.studentId);
              const dashboardReadOnly = !canUseRemoteControls;
              const tileActionsDisabled = supervisedElsewhere || dashboardReadOnly;
              const tileActionsDisabledReason = supervisedElsewhere
                ? supervisionReason
                : signOutOnlySelectionActive
                  ? 'Clear the sign-out-only selection before using other ClassPilot controls.'
                  : dashboardCapabilities.reason;
              const signOutOnlySelectionAvailable = isStudentServerSignOutEligible(student)
                && !isStudentCommandable(student);
              const persistentRestrictionSelectionAvailable = isStudentLateSignInRestrictionEligible(student);
              const tileStudent = supervisedElsewhere
                ? {
                    studentId: student.studentId,
                    studentName: student.studentName,
                    supervisionState: student.supervisionState,
                    supervisionContext: student.supervisionContext,
                  }
                : student;
              const supportsNegotiatedLiveView = studentSupportsCapability(
                student,
                'liveViewNegotiationV1',
              );
              const tileSharedPrivacyRevoked = supervisedElsewhere
                || tileGlobalAuthorizationDenied
                || tileGlobalAuthorizationFailure
                || ['signed_out', 'delegated'].includes(monitoringDisplay?.kind);
              const tileHistoryRevoked = tileSharedPrivacyRevoked
                || hardDeniedHistoryStudentIds.has(student.studentId)
                || observationLeaseStatus === 'pending'
                || observationLeaseStatus === 'denied'
                || observationLeaseStatus === 'paused_unobserved';
              const tileScreenshotRevoked = tileSharedPrivacyRevoked
                || hardDeniedScreenshotStudentIds.has(student.studentId)
                || studentView !== 'class';
              return (
                <div
                  key={student.studentId}
                  ref={getTileRef(student.studentId)}
                  className={`relative min-h-[420px] [content-visibility:auto] [contain-intrinsic-size:420px] ${supervisedElsewhere ? "rounded-lg ring-2 ring-slate-300/70 dark:ring-slate-700/70" : ""}`}
                >
                  {coverageLabel && (
                    <div className={`absolute left-3 top-3 z-10 max-w-[calc(100%-1.5rem)] rounded-md px-2 py-1 text-[11px] font-semibold shadow-sm ${student.supervisionState === "temporary_coverage" || student.supervisionState === "claimed" ? "bg-slate-800 text-white" : "bg-amber-400 text-slate-900"}`}>
                      {coverageLabel}
                    </div>
                  )}
                  {(!viewportTrackingSupported || nearViewportStudentIds.has(student.studentId)) ? <StudentTile
                    student={tileStudent}
                    onClick={supervisedElsewhere ? undefined : () => setSelectedStudent(student)}
                    blockedDomains={supervisedElsewhere ? EMPTY_LIST : settings?.blockedDomains || []}
                    isOffTask={!supervisedElsewhere && isStudentOffTask(student)}
                    isAbsent={!supervisedElsewhere && absentIds.has(student.studentId)}
                    isSelected={!supervisedElsewhere && (
                      selectedStudentIds.has(student.studentId)
                      || selectedServerSignOutStudentIds.has(student.studentId)
                    )}
                    onToggleSelect={!dashboardCapabilities.canSelectStudents || supervisedElsewhere ? undefined : () => toggleStudentSelection(student.studentId)}
                    signOutOnlySelectionAvailable={signOutOnlySelectionAvailable}
                    persistentRestrictionSelectionAvailable={persistentRestrictionSelectionAvailable}
                    liveStream={LIVE_VIEW_UI_ENABLED && !supervisedElsewhere && liveViewState.studentId === studentRealtimeKey ? liveViewState.stream : null}
                    liveViewPending={LIVE_VIEW_UI_ENABLED && !supervisedElsewhere && liveViewState.studentId === studentRealtimeKey && liveViewState.pending}
                    onStartLiveView={LIVE_VIEW_UI_ENABLED && dashboardCapabilities.canUseLiveView && supportsNegotiatedLiveView && !supervisedElsewhere && student.isLoggedIn && effectiveSession?.id ? () => handleStartLiveView(studentRealtimeKey, student.studentName) : undefined}
                    onStopLiveView={LIVE_VIEW_UI_ENABLED && dashboardCapabilities.canUseLiveView && !supervisedElsewhere ? () => handleStopLiveView(studentRealtimeKey) : undefined}
                    onExpandLiveView={LIVE_VIEW_UI_ENABLED ? () => setLiveViewState((current) => (
                      current.studentId === studentRealtimeKey && current.stream
                        ? { ...current, expanded: true }
                        : current
                    )) : undefined}
                    onAllowDomain={tileActionsDisabled ? undefined : handleAllowDomain}
                    onManageTabs={!tileActionsDisabled && dashboardCapabilities.allows('close-tabs') ? () => openManageTabs([student.studentId]) : undefined}
                    onCommand={tileActionsDisabled ? undefined : handleTileCommand}
                    commandPending={tileCommandState[student.studentId]?.pending === true}
                    commandError={supervisedElsewhere ? '' : tileCommandState[student.studentId]?.error || ''}
                    canLockScreen={dashboardCapabilities.allows('lock-screen') && dashboardCapabilities.allows('unlock-screen')}
                    canRemoveFlightPath={dashboardCapabilities.allows('remove-flight-path')}
                    actionsDisabled={tileActionsDisabled}
                    actionsDisabledReason={tileActionsDisabledReason}
                    nonSignOutCommandsBlocked={signOutOnlySelectionActive}
                    restrictionSelectionActive={lateSignInRestrictionSelectionActive}
                    monitoringSuppressed={supervisedElsewhere}
                    monitoringSuppressedReason={supervisionReason}
                    supervisionLabel={coverageLabel || ""}
                    onReturnToClass={supervisedElsewhere && dashboardCapabilities.ownedClassSession && activeSession ? () => handleReturnToClass(student) : undefined}
                    returnToClassPending={returnToClassPending}
                    recentHeartbeats={tileHistoryRevoked
                      ? EMPTY_LIST
                      : historyByStudent.get(student.studentId) || EMPTY_LIST}
                    screenshotData={tileScreenshotRevoked || screenshotRefreshState?.hardDenied
                      ? null
                      : screenshotsByStudent.get(student.studentId) || null}
                    onOpenScreenshot={tileScreenshotRevoked || screenshotRefreshState?.hardDenied
                      ? undefined
                      : (opener) => openExpandedScreenshot(student.studentId, opener)}
                    screenshotRefreshUnavailable={screenshotRefreshState?.transientUnavailable === true}
                    flightPaths={supervisedElsewhere ? EMPTY_LIST : flightPaths}
                    monitoringDisplay={monitoringDisplay || undefined}
                    freshnessNowMs={freshnessNowMs}
                    screenshotObservationStatus={tileScreenshotObservationStatus}
                    screenshotAuthorizationDenied={tileScreenshotRevoked}
                    actionContextKey={`${activeSchoolId || ''}:${effectiveSession?.id || ''}:${studentView}:${selectedSubgroupId}:${canUseRemoteControls}:${dashboardCapabilities.canUseLiveView}`}
                  /> : (
                    <div className="h-[420px] rounded-lg border border-border/30 bg-muted/10" aria-hidden="true" />
                  )}
                </div>
              );
            })}
          </div>
        )}
        </div>
      </main>

      {LIVE_VIEW_UI_ENABLED && dashboardCapabilities.canUseLiveView && liveViewState.expanded && liveViewState.stream && !activeLiveViewMonitoringSuppressed ? (
        <VideoPortal
          stream={liveViewState.stream}
          studentName={liveViewState.studentName}
          onClose={() => setLiveViewState((current) => ({ ...current, expanded: false }))}
          onStopLiveView={() => handleStopLiveView(liveViewState.studentId)}
        />
      ) : null}

      {expandedScreenshotSelection ? (
        <ScreenshotPreviewDialog
          key={expandedScreenshotSelection.privacyKey}
          studentName={expandedScreenshotSelection.student.studentName || 'Student'}
          screenshotData={expandedScreenshotSelection.screenshotData}
          freshnessNowMs={freshnessNowMs}
          privacyKey={expandedScreenshotSelection.privacyKey}
          refreshUnavailable={expandedScreenshotSelection.refreshUnavailable}
          unavailableMessage={expandedScreenshotSelection.unavailableMessage}
          onOpenChange={(open) => {
            if (!open) {
              restoreExpandedScreenshotFocusRef.current = true;
              setExpandedScreenshot(null);
            }
          }}
          onReturnFocus={() => {
            if (!restoreExpandedScreenshotFocusRef.current) return;
            restoreExpandedScreenshotFocusRef.current = false;
            const opener = expandedScreenshotOpenerRef.current;
            expandedScreenshotOpenerRef.current = null;
            if (opener?.isConnected) opener.focus();
          }}
        />
      ) : null}

      {/* Student Detail Drawer */}
      {selectedStudentRow && !selectedStudentMonitoringSuppressed && (
        <StudentDetailDrawer
          student={selectedStudentRow}
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
              Target: {signOutTargetSnapshot || signOutSelectionLabel}. This will sign {signOutSelectedCount} selected student{signOutSelectedCount === 1 ? "" : "s"} out of ClassPilot on their current Chromebook{signOutSelectedCount === 1 ? "" : "s"}. They will need to sign back in before monitoring, messaging, and hand raising resume.
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
          <DialogHeader><DialogTitle>Open Tab on Student Devices</DialogTitle><DialogDescription>Target: {targetBannerLabel}</DialogDescription></DialogHeader>
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

      {/* Waypoint (lock-screen) Dialog */}
      <Dialog open={showLockScreenDialog} onOpenChange={setShowLockScreenDialog}>
        <DialogContent data-testid="dialog-lock-screen">
          <DialogHeader>
            <DialogTitle>Set Waypoint</DialogTitle>
            <DialogDescription className="space-y-1">
              <span className="block">Target: {targetBannerLabel}.</span>
              <span className="block" data-testid="waypoint-domain-preservation-message">
                {waypointDomainRestrictionMessage}
              </span>
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <label className="flex items-center gap-2 text-sm">
                <input type="radio" name="lock-screen-mode" value="current" checked={lockScreenMode === "current"} onChange={() => setLockScreenMode("current")} data-testid="radio-lock-screen-current" />
                Each student's current page
              </label>
              <label className="flex items-center gap-2 text-sm">
                <input type="radio" name="lock-screen-mode" value="url" checked={lockScreenMode === "url"} onChange={() => setLockScreenMode("url")} data-testid="radio-lock-screen-specific" />
                A specific domain or URL for everyone
              </label>
            </div>
            {lockScreenMode === "current" && selectedLateSignInRestrictionStudentIds.length > 0 && (
              <p className="text-xs text-amber-700 dark:text-amber-300" data-testid="waypoint-current-page-skipped-count">
                {selectedLateSignInRestrictionStudentIds.length} signed-out student{selectedLateSignInRestrictionStudentIds.length === 1 ? '' : 's'} will be skipped because no current page exists before sign-in. Choose a specific URL to save their Waypoint.
              </p>
            )}
            {lockScreenMode === "url" && (
              <div className="space-y-2">
                <Label htmlFor="lock-screen-url">Domain or URL</Label>
                <Input id="lock-screen-url" type="url" placeholder="ixl.com" value={lockScreenUrl} onChange={(e) => setLockScreenUrl(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && !lockScreenMutation.isPending) handleConfirmLockScreen(); }} data-testid="input-lock-screen-url" />
                <p className="text-xs text-muted-foreground">{DOMAIN_RESTRICTION_URL_HELP}</p>
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowLockScreenDialog(false)} data-testid="button-cancel-lock-screen">Cancel</Button>
            <Button onClick={handleConfirmLockScreen} disabled={lockScreenMutation.isPending} data-testid="button-confirm-lock-screen"><Lock className="h-4 w-4 mr-2" />Set Waypoint</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Tabs Dialog */}
      <Dialog open={showCloseTabsDialog} onOpenChange={(open) => {
        setShowCloseTabsDialog(open);
        if (!open) {
          setManageTabsStudentIds(null);
          setManageTabsTargetSnapshot("");
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
                  <Button type="button" variant="outline" size="sm" onClick={() => setSelectedTabsToClose(new Set(openTabs.filter((tab) => exactTabCloseCapability(tab).enabled).map(tabSelectionKey)))} data-testid="button-select-all-tabs" className="h-8"><CheckSquare className="h-3 w-3 mr-1" />Select Exact-Close Tabs</Button>
                  <Button type="button" variant="outline" size="sm" onClick={() => setSelectedTabsToClose(new Set())} data-testid="button-clear-tabs" className="h-8"><XSquare className="h-3 w-3 mr-1" />Clear</Button>
                  <span className="text-xs text-muted-foreground ml-auto">{selectedTabsToClose.size} selected</span>
                </div>
                <div className="border rounded-md max-h-80 overflow-y-auto divide-y">
                  {Object.values(openTabsByStudent).map((group) => (
                    <div key={group.studentId} className="bg-background">
                      <div className="flex items-center justify-between gap-2 px-3 py-2 bg-muted/40">
                        <div className="text-sm font-semibold">{group.studentName || "Unnamed Student"}</div>
                        <Button type="button" variant="ghost" size="sm" className="h-7 text-xs text-destructive hover:text-destructive" onClick={() => closeTabsMutation.mutate({ closeAll: true, studentIds: [group.studentId] })} disabled={closeTabsMutation.isPending}>
                          Close all (bulk)
                        </Button>
                      </div>
                      {group.tabs.map((tab, tabIndex) => {
                        const exactCapability = exactTabCloseCapability(tab);
                        const compositeKey = tabSelectionKey(tab);
                        const hostname = (() => { try { return new URL(tab.url).hostname; } catch { return tab.url; } })();
                        return (
                          <div key={compositeKey || `${tab.studentId}-legacy-${tabIndex}`} className="flex items-center gap-3 p-3 hover:bg-muted/50 group" data-testid={`tab-row-${tab.studentId}-${tab.tabRef || tabIndex}`}>
                            <input type="checkbox" className="h-4 w-4 shrink-0" disabled={!exactCapability.enabled} checked={Boolean(compositeKey && selectedTabsToClose.has(compositeKey))} onChange={(e) => { if (!compositeKey) return; const newSet = new Set(selectedTabsToClose); if (e.target.checked) newSet.add(compositeKey); else newSet.delete(compositeKey); setSelectedTabsToClose(newSet); }} title={exactCapability.reason || 'Select this exact tab'} data-testid={`checkbox-tab-${tab.tabRef || tabIndex}`} />
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center gap-2"><span className="text-sm font-medium truncate">{tab.title}</span>{tab.active && <Badge variant="secondary" className="text-[10px] px-1.5 py-0">Active</Badge>}</div>
                              <div className="text-xs text-muted-foreground truncate">{hostname}</div>
                              {!exactCapability.enabled ? <div className="mt-1 text-[11px] text-amber-700 dark:text-amber-300">{exactCapability.reason}</div> : null}
                            </div>
                            <Button type="button" variant="ghost" size="icon" className="h-7 w-7 shrink-0 opacity-50 group-hover:opacity-100 hover:bg-destructive/10 hover:text-destructive" onClick={() => handleCloseSingleTab(tab)} disabled={closeTabsMutation.isPending || !exactCapability.enabled} title={exactCapability.reason || 'Close this exact tab'} data-testid={`button-close-tab-${tab.tabRef || tabIndex}`}>
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
            {openTabs.length > 0 && <Button variant="destructive" onClick={() => { closeTabsMutation.mutate({ closeAll: true, studentIds: manageTabsStudents.map((student) => student.studentId) }); }} disabled={closeTabsMutation.isPending} title="Bulk close remains available for older extension versions" data-testid="button-close-all-tabs"><TabletSmartphone className="h-4 w-4 mr-2" />Close All Tabs (bulk)</Button>}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Apply Flight Path Dialog */}
      <Dialog open={showApplyFlightPathDialog} onOpenChange={setShowApplyFlightPathDialog}>
        <DialogContent data-testid="dialog-apply-flight-path">
          <DialogHeader>
            <DialogTitle>Apply Flight Path to Students</DialogTitle>
            <DialogDescription className="space-y-1">
              <span className="block">Target: {targetBannerLabel}.</span>
              <span className="block" data-testid="flight-path-domain-preservation-message">
                {flightPathDomainRestrictionMessage}
              </span>
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="flight-path-select">Select Flight Path</Label>
              <Select value={selectedFlightPathId} onValueChange={setSelectedFlightPathId}>
                <SelectTrigger id="flight-path-select" data-testid="select-flight-path"><SelectValue placeholder="Choose a flight path" /></SelectTrigger>
                <SelectContent>
                  {flightPaths.map((fp) => {
                    const applicability = flightPathApplyCapability(fp);
                    return (
                      <SelectItem
                        key={fp.id}
                        value={fp.id}
                        disabled={!applicability.enabled}
                        data-testid={`option-flight-path-${fp.id}`}
                      >
                        {fp.flightPathName}{applicability.enabled ? '' : ' (add an allowed domain)'}
                      </SelectItem>
                    );
                  })}
                  {flightPaths.length === 0 && <div className="p-2 text-sm text-muted-foreground">No flight paths available</div>}
                </SelectContent>
              </Select>
              {selectedFlightPathId && (() => {
                const fp = flightPaths.find(f => f.id === selectedFlightPathId);
                return fp ? (
                  <div className="mt-2 p-3 bg-muted/30 rounded-md">
                    <p className="text-xs font-medium mb-1">Description:</p><p className="text-xs text-muted-foreground mb-2">{fp.description || "No description provided"}</p>
                    <p className="text-xs font-medium mb-1">Allowed Domains ({fp.allowedDomains?.length || 0}):</p>
                    <div className="flex flex-wrap gap-1">{fp.allowedDomains && fp.allowedDomains.length > 0 ? fp.allowedDomains.map((domain, idx) => (<Badge key={idx} variant="secondary" className="text-xs">{domain}</Badge>)) : <p className="text-xs text-destructive">Add an allowed domain before applying this Flight Path.</p>}</div>
                  </div>
                ) : null;
              })()}
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowApplyFlightPathDialog(false)} data-testid="button-cancel-apply-flight-path">Cancel</Button>
            <Button
              onClick={handleApplyFlightPath}
              disabled={
                applyFlightPathMutation.isPending
                || !flightPathApplyCapability(flightPaths.find((fp) => fp.id === selectedFlightPathId)).enabled
              }
              data-testid="button-confirm-apply-flight-path"
            ><Layers className="h-4 w-4 mr-2" />Apply Flight Path</Button>
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
                  const lateSignInTarget = isStudentLateSignInRestrictionEligible(student);
                  const effectiveRestrictions = effectiveStudentRestrictions(student);
                  const canClearWaypoint = lateSignInTarget
                    || studentSupportsCapability(student, 'screenOnlyUnlockV1');
                  return (
                    <tr key={student.studentId} className="border-b" data-testid={`row-student-${student.studentId}`}>
                      <td className="p-2 text-sm">{student.studentName}</td>
                      <td className="p-2">{effectiveRestrictions.flightPathActive ? <Badge variant="secondary" className="text-xs" data-testid={`badge-flight-path-${student.studentId}`}>{effectiveRestrictions.flightPathName || 'Active Flight Path'}</Badge> : <span className="text-xs text-muted-foreground">No flight path</span>}</td>
                      <td className="p-2"><Badge variant={student.status === 'online' ? 'default' : student.status === 'idle' ? 'secondary' : 'outline'} className="text-xs" data-testid={`badge-status-${student.studentId}`}>{student.status}</Badge></td>
                      <td className="p-2">
                        {effectiveRestrictions.flightPathActive && (student.isLoggedIn || lateSignInTarget) ? (
                          <Button size="sm" variant="ghost" onClick={() => handleRemoveFlightPath(student.studentId)} disabled={removeFlightPathMutation.isPending} data-testid={`button-remove-flight-path-${student.studentId}`} className="h-7 px-2 text-xs text-destructive hover:text-destructive hover:bg-destructive/10"><X className="h-3 w-3 mr-1" />Remove</Button>
                        ) : effectiveRestrictions.screenLockActive && (student.isLoggedIn || lateSignInTarget) ? (
                          <Button size="sm" variant="outline" onClick={() => unlockScreenMutation.mutate({ studentIds: [student.studentId] })} disabled={unlockScreenMutation.isPending || !canClearWaypoint} title={canClearWaypoint ? 'Clear the waypoint (screen only)' : 'ClassPilot extension 2.6.0 or newer is required'} data-testid={`button-unlock-screen-${student.studentId}`} className="h-7 px-2 text-xs"><Unlock className="h-3 w-3 mr-1" />{canClearWaypoint ? 'Clear Waypoint' : 'Update Required'}</Button>
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
          <DialogHeader><DialogTitle>Apply Block List to Students</DialogTitle><DialogDescription>Target: {targetBannerLabel}</DialogDescription></DialogHeader>
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
          <DialogHeader><DialogTitle>Block List Status</DialogTitle><DialogDescription>{lateSignInRestrictionsEnabled ? 'Manage teacher-applied block lists. Saved restrictions may remain pending until a signed-out student returns.' : 'Manage active block lists for your online students.'}</DialogDescription></DialogHeader>
          <div className="space-y-4">
            <div className="flex items-center justify-between p-3 bg-muted/30 rounded-md">
              <div><p className="text-sm font-medium">Remove Block List from All Students</p><p className="text-xs text-muted-foreground">{lateSignInRestrictionsEnabled ? 'This removes the teacher-applied block list from eligible online and signed-out students.' : 'This removes the teacher-applied block list from eligible online students.'}</p></div>
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
      {dashboardCapabilities.canUseTeacherFab && !classStudentTargetsUnavailable && !nonRestrictionSelectionActive && (
        <TeacherFab
          attentionActive={attentionActive}
          onAttentionClick={() => setShowAttentionDialog(true)}
          attentionPending={subgroupCommandsDisabled || attentionModeMutation.isPending}
          timerActive={timerActive}
          onTimerClick={() => timerActive ? handleStopTimer() : setShowTimerDialog(true)}
          timerPending={subgroupCommandsDisabled || timerMutation.isPending || timerDeliveryPending}
          activePoll={activePoll}
          pollTotalResponses={pollTotalResponses}
          onPollClick={() => activePoll ? setShowPollResultsDialog(true) : setShowPollDialog(true)}
          pollPending={subgroupCommandsDisabled || pollMutation.isPending || closePollMutation.isPending || pollDeliveryPending}
          raisedHands={raisedHands}
          onDismissHand={(studentId) => dismissHandMutation.mutate(studentId)}
          handRaisingEnabled={sessionFabState?.handRaisingEnabled !== false}
          onToggleHandRaising={(enabled) => toggleHandRaisingMutation.mutate(enabled)}
          studentMessages={studentMessages}
          onMarkMessageRead={markMessageRead}
          onDismissMessage={dismissMessage}
          onReplyToMessage={(studentId, message) => {
            return replyToMessageMutation.mutateAsync({ sessionId: effectiveSession?.id, studentId, message });
          }}
          replyPending={replyToMessageMutation.isPending}
          studentMessagingEnabled={sessionFabState?.messagingEnabled !== false}
          onToggleStudentMessaging={(enabled) => toggleStudentMessagingMutation.mutate(enabled)}
          fabSettingsPending={!sessionFabState || toggleHandRaisingMutation.isPending || toggleStudentMessagingMutation.isPending}
          chatReplies={chatReplies}
          onCloseChat={closeChat}
          onSendMessage={subgroupCommandsDisabled ? undefined : () => setShowSendMessageDialog(true)}
        />
      )}
    </div>
  );
}
