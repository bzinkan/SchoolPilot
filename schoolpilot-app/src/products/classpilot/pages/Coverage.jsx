import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import MonitoringInterruptionsPanel from "../components/MonitoringInterruptionsPanel";
import SupervisionGroupEditor from "../components/SupervisionGroupEditor";
import { refreshSupervisionSetup } from "../components/supervisionGroupQueries";
import SupervisionGroupDirectory from "../components/SupervisionGroupDirectory";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  ArrowLeft,
  ClipboardCheck,
  Eye,
  History,
  Link as LinkIcon,
  Lock,
  MessageSquare,
  MonitorPlay,
  Plus,
  RefreshCw,
  Search,
  Shield,
  ShieldBan,
  UserCheck,
  Users,
  X,
  Unlock,
  Trash2,
} from "lucide-react";
import { useNavigate } from "react-router-dom";
import { apiRequest, queryClient } from "../../../lib/queryClient";
import { Button } from "../../../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../../../components/ui/card";
import { Checkbox } from "../../../components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../../../components/ui/dialog";
import { AlertDialog, AlertDialogContent, AlertDialogHeader, AlertDialogTitle, AlertDialogDescription, AlertDialogFooter, AlertDialogCancel, AlertDialogAction } from "../../../components/ui/alert-dialog";
import { Input } from "../../../components/ui/input";
import { Label } from "../../../components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../../components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../../../components/ui/tabs";
import { Textarea } from "../../../components/ui/textarea";
import { Badge } from "../../../components/ui/badge";
import { useToast } from "../../../hooks/use-toast";
import { useClassPilotAuth } from "../../../hooks/useClassPilotAuth";
import {
  coverageStudentCommandSelectionEligible,
  domainRestrictionMessageForStudents,
  flightPathApplyCapability,
  partitionCoverageCurrentPageWaypointTargets,
} from "../lib/dashboardCommandContext";
import { commandDeliveryFeedback } from "../lib/commandDeliveryTruth";
import { deriveStudentMonitoringDisplay } from "../lib/studentMonitoringDisplay";
import CoverageStudentFilters from "../components/CoverageStudentFilters";
import { emptyCoverageFilters, filterCoverageStudents } from "../lib/coverageStudentFilters";
import { createSupervisionDashboardIntent } from "../lib/supervisionDashboardNavigation";

const coverageTypes = [
  ["state_testing", "State Testing"],
  ["indoor_recess", "Indoor Recess"],
  ["intervention", "Intervention"],
  ["office", "Office"],
  ["assembly", "Assembly"],
  ["other", "Other"],
];

const releaseReasons = [
  ["returned_to_class", "Returned to class"],
  ["released", "Released"],
  ["expired", "Expired"],
  ["reassigned", "Reassigned"],
];

const ALL_FILTER = "all";

function defaultEndTime() {
  const d = new Date(Date.now() + 60 * 60 * 1000);
  d.setSeconds(0, 0);
  return d.toISOString().slice(0, 16);
}

function displayName(user) {
  return user?.displayName || user?.email || user?.user?.displayName || user?.user?.email || "Staff";
}

function formatTime(value) {
  if (!value) return "Unknown";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Unknown";
  return date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function minutesSince(value) {
  if (!value) return "Just now";
  const then = new Date(value).getTime();
  if (!Number.isFinite(then)) return "Just now";
  const minutes = Math.max(0, Math.round((Date.now() - then) / 60000));
  if (minutes < 1) return "Just now";
  if (minutes === 1) return "1 min";
  return `${minutes} min`;
}

function statusBadgeVariant(status) {
  if (status === "online") return "default";
  if (status === "idle") return "secondary";
  return "outline";
}

function contextTypeLabel(type) {
  if (type === "supervision_group") return "Supervision Group";
  return coverageTypes.find(([id]) => id === type)?.[1] || "Supervision";
}

function normalizeScopeValue(value) {
  return String(value || "").trim();
}

function gradeSortValue(grade) {
  const normalized = normalizeScopeValue(grade);
  const numeric = Number.parseInt(normalized, 10);
  return Number.isFinite(numeric) ? numeric : 999;
}

function assignmentScopeKey(scopeType, scopeValue, studentIds = []) {
  if (scopeType === "students") {
    return `${scopeType}:${[...studentIds].sort().join(",")}`;
  }
  return `${scopeType}:${scopeValue || ""}`;
}

function assignmentHasClaim(assignment) {
  const permissions = assignment?.permissions || {};
  return assignment?.abilities?.claim === true || permissions.claim === true || permissions.observe === true;
}

function assignmentHasSetup(assignment) {
  const permissions = assignment?.permissions || {};
  return assignment?.abilities?.setup === true || permissions.setup === true || assignment?.scopeType === "setup";
}

function assignmentScopeSelection(assignment) {
  if (assignment.scopeType === "setup") return { type: "school", value: "school" };
  if (assignment.scopeType === "school") return { type: "school", value: "school" };
  if (assignment.scopeType === "students") {
    return { type: "students", value: assignment.scopeDetail?.studentIds || [] };
  }
  return { type: assignment.scopeType, value: assignment.scopeValue || "" };
}

function assignmentPayloadKey(payload) {
  return assignmentScopeKey(payload.scopeType, payload.scopeValue || "", payload.studentIds || []);
}

function matchesTokens(value, query) {
  const tokens = String(query || "").trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return true;
  const haystack = String(value || "").toLowerCase();
  return tokens.every((token) => haystack.includes(token));
}

function supervisionAssignmentKey(student) {
  return student.assignmentId || student.assignedAt || student.studentId;
}

export default function Coverage() {
  const { currentUser } = useClassPilotAuth();
  return <CoverageWorkspace key={`${currentUser?.schoolId}:${currentUser?.id}`} currentUser={currentUser} />;
}

function CoverageWorkspace({ currentUser }) {
  const navigate = useNavigate();
  const { toast } = useToast();
  const isAdmin = currentUser?.isSuperAdmin || currentUser?.role === "admin" || currentUser?.role === "school_admin";
  const schoolId = currentUser?.schoolId;
  const setupScope = useMemo(() => ({ schoolId, actorId: currentUser?.id, isAdmin }), [schoolId, currentUser?.id, isAdmin]);
  const committedSetupScope = useRef(setupScope);
  const deletionOpener = useRef(null);
  const setupHeading = useRef(null);
  const staffAccessHeading = useRef(null);
  const [setupDeletion, setSetupDeletion] = useState(null);
  const [setupDeletionNotice, setSetupDeletionNotice] = useState(null);
  useLayoutEffect(() => {
    committedSetupScope.current = setupScope;
    return () => { committedSetupScope.current = null; };
  }, [setupScope]);

  const [unassignedSelection, setUnassignedSelection] = useState(new Set());
  const [coverageSelection, setCoverageSelection] = useState({ contextId: "", ids: new Set(), bindings: new Map(), explicit: false });
  const [activeTab, setActiveTab] = useState("console");
  const [availableFilters, setAvailableFilters] = useState(emptyCoverageFilters);
  const [claimedFilters, setClaimedFilters] = useState(emptyCoverageFilters);
  const [selectedContextId, setSelectedContextId] = useState("");
  const [historyContextId, setHistoryContextId] = useState("");
  const [contextOpen, setContextOpen] = useState(false);
  const [assignmentOpen, setAssignmentOpen] = useState(false);
  const [commandDialogState, setCommandDialogState] = useState(null);
  const [commandUrl, setCommandUrl] = useState("");
  const [commandMessage, setCommandMessage] = useState("");
  const [selectedFlightPathId, setSelectedFlightPathId] = useState("");
  const [selectedBlockListId, setSelectedBlockListId] = useState("");
  const [releaseDialog, setReleaseDialog] = useState(null);
  const [releaseReason, setReleaseReason] = useState("returned_to_class");
  const [studentPickerSearch, setStudentPickerSearch] = useState("");
  const [assignmentStaffSearch, setAssignmentStaffSearch] = useState("");
  const [scopeGroupOpen, setScopeGroupOpen] = useState(false);
  const [scopeGroupId, setScopeGroupId] = useState(null);
  const operationalBusy = useRef(false);
  const [contextForm, setContextForm] = useState({
    contextType: "state_testing",
    name: "State Testing",
    assignedStaffId: "",
    coverageGroupId: "",
    endsAt: defaultEndTime(),
    note: "",
  });
  const [assignmentForm, setAssignmentForm] = useState({
    existingIds: [],
    staffId: "",
    claim: true,
    setup: false,
    schoolwide: false,
    gradeValues: [],
    groupValues: [],
    coverageGroupValues: [],
    studentIds: [],
    active: true,
  });
  const unassignedQuery = useQuery({
    queryKey: ["/api/coverage/unassigned", schoolId, currentUser?.id],
    queryFn: ({ signal }) => apiRequest("GET", "/coverage/unassigned", undefined, { signal, headers: { "X-School-Id": schoolId } }),
    select: (data) => data?.students || [],
    refetchInterval: 10000,
  });

  const contextsQuery = useQuery({
    queryKey: ["/api/coverage/contexts", schoolId, currentUser?.id],
    queryFn: ({ signal }) => apiRequest("GET", "/coverage/contexts", undefined, { signal, headers: { "X-School-Id": schoolId } }),
    select: (data) => data?.contexts || [],
    refetchInterval: 10000,
  });

  // The card below is a count of STUDENTS, so it must not be derived from the
  // number of supervision contexts: two students claimed into one group are one
  // context. The server already publishes the distinct-student figure under the
  // same visibility rule as /coverage/contexts, and the dashboard reads the same
  // cache entry, so the two surfaces cannot disagree.
  const summaryQuery = useQuery({
    queryKey: ["/api/coverage/summary", schoolId, currentUser?.id],
    queryFn: ({ signal }) => apiRequest("GET", "/coverage/summary", undefined, { signal, headers: { "X-School-Id": schoolId } }),
    refetchInterval: 10000,
  });

  const capabilitiesQuery = useQuery({
    queryKey: ["/api/coverage/capabilities", schoolId, currentUser?.id],
    queryFn: ({ signal }) => apiRequest("GET", "/coverage/capabilities", undefined, { signal, headers: { "X-School-Id": schoolId } }),
    enabled: !!currentUser && !!schoolId,
  });
  const canManageSupervisionSetup = isAdmin || !!capabilitiesQuery.data?.canManageSupervisionSetup;
  const visibleTab = activeTab === "staff-access" && !isAdmin
    ? (canManageSupervisionSetup ? "settings" : "console")
    : activeTab === "settings" && !canManageSupervisionSetup ? "console" : activeTab;
  const canDelegateSetup = isAdmin;
  const canChooseSchoolwide = isAdmin || !!capabilitiesQuery.data?.isSchoolwideSetupManager;

  const staffQuery = useQuery({
    queryKey: [isAdmin ? "/api/admin/users" : "/api/coverage/setup/staff", schoolId, currentUser?.id],
    queryFn: ({ signal }) => apiRequest("GET", isAdmin ? "/admin/users" : "/coverage/setup/staff", undefined, { signal, headers: { "X-School-Id": schoolId } }),
    select: (data) => data?.users || [],
    enabled: canManageSupervisionSetup && (assignmentOpen || contextOpen),
  });

  const groupsQuery = useQuery({
    queryKey: ["/api/coverage/setup/classes", schoolId, currentUser?.id],
    queryFn: ({ signal }) => apiRequest("GET", "/coverage/setup/classes", undefined, { signal, headers: { "X-School-Id": schoolId } }),
    select: (data) => data?.groups || [],
    enabled: canManageSupervisionSetup && (assignmentOpen || contextOpen),
  });

  const assignmentsQuery = useQuery({
    queryKey: ["/api/coverage/assignments", schoolId, currentUser?.id],
    queryFn: ({ signal }) => apiRequest("GET", "/coverage/assignments", undefined, { signal, headers: { "X-School-Id": schoolId } }),
    select: (data) => data?.assignments || [],
    enabled: isAdmin && !!schoolId,
  });

  const scopeGroupsQuery = useQuery({
    queryKey: ["/api/coverage/supervision-groups", schoolId, currentUser?.id],
    queryFn: ({ signal }) => apiRequest("GET", "/coverage/supervision-groups", undefined, { signal, headers: { "X-School-Id": schoolId } }),
    select: (data) => data?.groups || [],
    enabled: canManageSupervisionSetup && !!schoolId && (assignmentOpen || contextOpen),
  });

  const adminStudentsQuery = useQuery({
    queryKey: [isAdmin ? "/api/admin/teacher-students" : "/api/coverage/setup/students", schoolId, currentUser?.id],
    queryFn: ({ signal }) => apiRequest("GET", isAdmin ? "/admin/teacher-students" : "/coverage/setup/students", undefined, { signal, headers: { "X-School-Id": schoolId } }),
    select: (data) => data?.students || [],
    enabled: canManageSupervisionSetup && (assignmentOpen || contextOpen),
  });

  const flightPathsQuery = useQuery({
    queryKey: ["/api/flight-paths", schoolId, currentUser?.id],
    queryFn: ({ signal }) => apiRequest("GET", "/flight-paths", undefined, { signal, headers: { "X-School-Id": schoolId } }),
    select: (data) => Array.isArray(data) ? data : data?.flightPaths || [],
  });

  const blockListsQuery = useQuery({
    queryKey: ["/api/block-lists", schoolId, currentUser?.id],
    queryFn: ({ signal }) => apiRequest("GET", "/block-lists", undefined, { signal, headers: { "X-School-Id": schoolId } }),
    select: (data) => Array.isArray(data) ? data : data?.blockLists || [],
  });

  const contexts = useMemo(() => contextsQuery.data || [], [contextsQuery.data]);
  const activeScopeGroups = useMemo(
    () => (scopeGroupsQuery.data || []).filter((group) => group.active),
    [scopeGroupsQuery.data]
  );
  const assignableStaff = useMemo(() => {
    return (staffQuery.data || []).filter((staff) => {
      const searchText = [
        displayName(staff),
        staff.email,
        staff.user?.email,
        staff.role,
      ].filter(Boolean).join(" ");
      return matchesTokens(searchText, assignmentStaffSearch);
    });
  }, [assignmentStaffSearch, staffQuery.data]);
  const permissionPackages = useMemo(() => {
    const byStaff = new Map();
    (assignmentsQuery.data || []).forEach((assignment) => {
      const entry = byStaff.get(assignment.staffId) || {
        staffId: assignment.staffId,
        staff: assignment.staff || null,
        assignments: [],
        active: false,
        claim: false,
        setup: false,
        scopeLabels: [],
      };
      entry.assignments.push(assignment);
      entry.active = entry.active || assignment.active !== false;
      entry.claim = entry.claim || assignmentHasClaim(assignment);
      entry.setup = entry.setup || assignmentHasSetup(assignment);
      if (assignment.scopeLabel) entry.scopeLabels.push(assignment.scopeLabel);
      byStaff.set(assignment.staffId, entry);
    });
    return Array.from(byStaff.values()).map((entry) => ({
      ...entry,
      scopeLabels: Array.from(new Set(entry.scopeLabels)),
    }));
  }, [assignmentsQuery.data]);
  const adminStudents = useMemo(() => adminStudentsQuery.data || [], [adminStudentsQuery.data]);
  const rosterGrades = useMemo(() => {
    const counts = new Map();
    adminStudents.forEach((student) => {
      const grade = normalizeScopeValue(student.gradeLevel);
      if (!grade) return;
      counts.set(grade, (counts.get(grade) || 0) + 1);
    });
    return Array.from(counts.entries())
      .sort(([a], [b]) => gradeSortValue(a) - gradeSortValue(b) || a.localeCompare(b))
      .map(([grade, count]) => ({ value: grade, count }));
  }, [adminStudents]);
  const classManagementGroups = useMemo(
    () => [...(groupsQuery.data || [])].sort((a, b) => {
      const gradeCompare = gradeSortValue(a.gradeLevel) - gradeSortValue(b.gradeLevel);
      return gradeCompare || (a.name || "").localeCompare(b.name || "");
    }),
    [groupsQuery.data]
  );
  const filteredPickerStudents = useMemo(() => {
    const q = studentPickerSearch.trim().toLowerCase();
    if (!q) return adminStudents;
    return adminStudents.filter((student) => {
      return `${student.studentName || ""} ${student.studentEmail || ""} ${student.gradeLevel || ""}`.toLowerCase().includes(q);
    });
  }, [adminStudents, studentPickerSearch]);
  const manageableContexts = useMemo(
    () => contexts.filter((context) => context.canManage && context.status === "active"),
    [contexts]
  );
  const activeContextId = manageableContexts.some((context) => context.id === selectedContextId)
    ? selectedContextId
    : manageableContexts[0]?.id || "";
  const selectedContext = manageableContexts.find((context) => context.id === activeContextId) || null;
  const commandDialog = commandDialogState?.contextId === activeContextId ? commandDialogState.type : null;
  const setCommandDialog = type => setCommandDialogState(type ? { type, contextId: activeContextId } : null);

  const contextStudentsQuery = useQuery({
    queryKey: ["/api/coverage/contexts", schoolId, currentUser?.id, selectedContext?.id, "students"],
    queryFn: ({ signal }) => apiRequest("GET", `/coverage/contexts/${selectedContext.id}/students`, undefined, { signal, headers: { "X-School-Id": schoolId } }),
    select: (data) => data?.students || [],
    enabled: !!selectedContext?.id,
    refetchInterval: 10000,
  });

  const historyQuery = useQuery({
    queryKey: ["/api/coverage/contexts", schoolId, currentUser?.id, historyContextId, "history"],
    queryFn: ({ signal }) => apiRequest("GET", `/coverage/contexts/${historyContextId}/history`, undefined, { signal, headers: { "X-School-Id": schoolId } }),
    select: (data) => data?.events || [],
    enabled: !!historyContextId,
  });

  const unassignedStudents = useMemo(() => filterCoverageStudents(unassignedQuery.data || [], availableFilters), [unassignedQuery.data, availableFilters]);
  const coverageStudents = useMemo(() => filterCoverageStudents(contextStudentsQuery.data || [], claimedFilters), [contextStudentsQuery.data, claimedFilters]);

  const activeCoverageStudents = useMemo(
    () => coverageStudents.filter((student) => !student.releasedAt),
    [coverageStudents]
  );
  const selectedUnassignedIds = new Set(unassignedStudents.filter(student => unassignedSelection.has(student.studentId)).map(student => student.studentId));
  const selectedCoverageIds = new Set(activeCoverageStudents.filter(student => coverageSelection.contextId === activeContextId && coverageSelection.ids.has(student.studentId) && coverageSelection.bindings.get(student.studentId) === supervisionAssignmentKey(student)).map(student => student.studentId));
  const setSelectedUnassignedIds = value => setUnassignedSelection(typeof value === "function" ? value(selectedUnassignedIds) : value);
  const setSelectedCoverageIds = value => {
    const ids = typeof value === "function" ? value(selectedCoverageIds) : value;
    const bindings = new Map(activeCoverageStudents.filter(student => ids.has(student.studentId)).map(student => [student.studentId, supervisionAssignmentKey(student)]));
    setCoverageSelection({ contextId: activeContextId, ids, bindings, explicit: ids.size > 0 });
  };
  const changeAvailableFilters = filters => { setAvailableFilters(filters); setUnassignedSelection(new Set()); };
  const changeClaimedFilters = filters => { setClaimedFilters(filters); setSelectedCoverageIds(new Set()); };
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      setCommandDialogState(previous => previous?.contextId && previous.contextId !== activeContextId ? null : previous);
      if (contextStudentsQuery.isSuccess) setCoverageSelection(previous => {
        if (previous.contextId !== activeContextId) return { contextId: activeContextId, ids: new Set(), bindings: new Map(), explicit: false };
        const activeIds = new Set((contextStudentsQuery.data || []).filter(student => !student.releasedAt && previous.bindings.get(student.studentId) === supervisionAssignmentKey(student)).map(student => student.studentId));
        const ids = new Set([...previous.ids].filter(id => activeIds.has(id)));
        return ids.size === previous.ids.size ? previous : { ...previous, ids };
      });
      if (unassignedQuery.isSuccess) setUnassignedSelection(previous => {
        const availableIds = new Set((unassignedQuery.data || []).map(student => student.studentId));
        const ids = new Set([...previous].filter(id => availableIds.has(id)));
        return ids.size === previous.size ? previous : ids;
      });
    });
    return () => cancelAnimationFrame(frame);
  }, [activeContextId, contextStudentsQuery.data, contextStudentsQuery.isSuccess, unassignedQuery.data, unassignedQuery.isSuccess]);
  const commandSelectableCoverageStudents = useMemo(
    () => activeCoverageStudents.filter((student) => coverageStudentCommandSelectionEligible({
      student,
      monitoringDisplay: deriveStudentMonitoringDisplay(student),
      structurallyCommandable: !student.releasedAt,
    })),
    [activeCoverageStudents]
  );
  const selectedCoverageStudentIds = Array.from(selectedCoverageIds);
  // A stale or offline explicit selection must never become a context-wide command.
  const hasExplicitCoverageSelection = coverageSelection.contextId === activeContextId && coverageSelection.explicit;
  const commandTargetStudents = commandSelectableCoverageStudents.filter(student => !hasExplicitCoverageSelection || selectedCoverageIds.has(student.studentId));
  const commandTargetCount = commandTargetStudents.length;
  const commandTargetsSupportScreenOnlyUnlock = commandTargetStudents.length > 0
    && commandTargetStudents.every((student) => (
      student.capabilities?.screenOnlyUnlockV1 === true
      || (
        student.lateSignInRestrictionSsoV1Enabled === true
        && student.isLoggedIn !== true
      )
    ));
  const commandTargetDomainRestrictionMessage = domainRestrictionMessageForStudents(
    commandTargetStudents,
    (student) => deriveStudentMonitoringDisplay(student).telemetryCurrent,
  );
  const assignmentScopeCount =
    (assignmentForm.schoolwide ? 1 : 0) +
    assignmentForm.gradeValues.length +
    assignmentForm.groupValues.length +
    assignmentForm.coverageGroupValues.length +
    (assignmentForm.studentIds.length > 0 ? 1 : 0);
  const assignmentCanSave =
    !!assignmentForm.staffId &&
    (assignmentForm.claim || assignmentForm.setup) &&
    assignmentScopeCount > 0 &&
    (!assignmentForm.setup || canDelegateSetup);

  const invalidateCoverage = () => {
    queryClient.invalidateQueries({ queryKey: ["/api/coverage/summary"] });
    queryClient.invalidateQueries({ queryKey: ["/api/coverage/unassigned"] });
    queryClient.invalidateQueries({ queryKey: ["/api/coverage/available-students"] });
    queryClient.invalidateQueries({ queryKey: ["/api/coverage/claimed-students"] });
    queryClient.invalidateQueries({ queryKey: ["/api/coverage/supervision-groups"] });
    queryClient.invalidateQueries({ queryKey: ["/api/coverage/contexts"] });
    queryClient.invalidateQueries({ queryKey: ["/api/students-aggregated"] });
    if (selectedContext?.id) {
      queryClient.invalidateQueries({ queryKey: ["/api/coverage/contexts", selectedContext.id] });
    }
    if (historyContextId) {
      queryClient.invalidateQueries({ queryKey: ["/api/coverage/contexts", historyContextId, "history"] });
    }
  };
  const refreshCoverage = () => {
    invalidateCoverage();
    void refreshSupervisionSetup(queryClient, schoolId);
    for (const queryKey of [["/api/coverage/assignments"], ["/api/coverage/capabilities"], ["/api/coverage/summary"], ["classpilot-schedule-profiles"], ["classpilot-school-scheduling"]]) {
      void queryClient.invalidateQueries({ queryKey });
    }
  };

  const createContextMutation = useMutation({
    retry: false,
    mutationFn: ({ payload, scope }) => apiRequest("POST", "/coverage/contexts", payload, { headers: { "X-School-Id": scope.schoolId } }),
    onSuccess: (data, { scope, payload }) => {
      if (committedSetupScope.current !== scope) return;
      invalidateCoverage();
      setSelectedUnassignedIds(new Set());
      setContextOpen(false);
      if (data?.context?.id) {
        setSelectedContextId(data.context.id);
        setSelectedCoverageIds(new Set());
      }
      setActiveTab("console");
      toast({ title: "Supervision started" });
      if (data?.context?.assignedStaffId === scope.actorId && Number(data.context.activeStudentCount ?? payload.studentIds.length) > 0) {
        navigate("/classpilot", { state: createSupervisionDashboardIntent({ schoolId: scope.schoolId, viewerId: scope.actorId, contexts: [data.context] }) });
      }
    },
    onError: (error, { scope }) => { if (committedSetupScope.current === scope) toast({ variant: "destructive", title: "Could not start coverage", description: error.message }); },
    onSettled: () => { operationalBusy.current = false; },
  });

  const releaseMutation = useMutation({
    retry: false,
    mutationFn: ({ contextId, studentIds, reason, mode, scope }) => {
      if (mode !== "all" && studentIds.length === 0) throw new Error("Select students before releasing them.");
      return apiRequest("POST", `/coverage/contexts/${contextId}/release`, { studentIds, releaseReason: reason }, { headers: { "X-School-Id": scope.schoolId } });
    },
    onSuccess: (_data, { scope }) => {
      if (committedSetupScope.current !== scope) return;
      invalidateCoverage();
      setSelectedCoverageIds(new Set());
      setReleaseDialog(null);
      setReleaseReason("returned_to_class");
      toast({ title: "Students released" });
    },
    onError: (error, { scope }) => { if (committedSetupScope.current === scope) toast({ variant: "destructive", title: "Could not release coverage", description: error.message }); },
    onSettled: () => { operationalBusy.current = false; },
  });

  const commandMutation = useMutation({
    mutationFn: ({ contextId, commandType, commandPayload, targetScope, targetStudentIds, scope }) => apiRequest("POST", `/coverage/contexts/${contextId}/commands`, {
      targetScope,
      targetStudentIds,
      commandType,
      commandPayload,
    }, { headers: { "X-School-Id": scope.schoolId } }),
    onSuccess: (data, variables) => {
      if (committedSetupScope.current !== variables.scope) return;
      invalidateCoverage();
      setCommandDialog(null);
      setCommandUrl("");
      setCommandMessage("");
      toast(commandDeliveryFeedback({
        ...(data || {}),
        skippedCurrentPageCount: Number(variables?.skippedCurrentPageCount || 0),
      }, variables?.commandType));
    },
    onError: (error, { scope }) => { if (committedSetupScope.current === scope) toast({ variant: "destructive", title: "Could not send command", description: error.message }); },
  });

  const refreshSetupLists = () => refreshSupervisionSetup(queryClient, schoolId);

  const saveAssignmentMutation = useMutation({
    mutationFn: async ({ staffId, payloads, scope }) => {
      const config = { headers: { "X-School-Id": scope.schoolId } };
      const existing = (assignmentsQuery.data || []).filter((assignment) => assignment.staffId === staffId);
      const payloadByKey = new Map(payloads.map((payload) => [assignmentPayloadKey(payload), payload]));
      const existingByKey = new Map(existing.map((assignment) => [
        assignmentScopeKey(
          assignment.scopeType,
          assignment.scopeValue || "",
          assignment.scopeType === "students" ? (assignment.scopeDetail?.studentIds || []) : []
        ),
        assignment,
      ]));

      const updates = [];
      const creates = [];
      for (const [key, payload] of payloadByKey.entries()) {
        const match = existingByKey.get(key);
        if (match) updates.push(apiRequest("PATCH", `/coverage/assignments/${match.id}`, payload, config));
        else creates.push(apiRequest("POST", "/coverage/assignments", payload, config));
      }

      const disables = existing
        .filter((assignment) => assignment.active !== false)
        .filter((assignment) => !assignmentHasSetup(assignment) || canDelegateSetup)
        .filter((assignment) => {
          const key = assignmentScopeKey(
            assignment.scopeType,
            assignment.scopeValue || "",
            assignment.scopeType === "students" ? (assignment.scopeDetail?.studentIds || []) : []
          );
          return !payloadByKey.has(key);
        })
        .map((assignment) => apiRequest("PATCH", `/coverage/assignments/${assignment.id}`, { active: false }, config));

      // A partial failure still changes setup. Let every write settle before
      // refreshing either view so a late successful write cannot leave it stale.
      const results = await Promise.allSettled([...updates, ...creates, ...disables]);
      const failed = results.find((result) => result.status === "rejected");
      if (failed) throw failed.reason;
    },
    onSuccess: (_, variables) => {
      if (committedSetupScope.current !== variables.scope) return;
      setAssignmentOpen(false);
      setStudentPickerSearch("");
      setAssignmentStaffSearch("");
      const count = variables?.payloads?.length || 1;
      toast({ title: count === 1 ? "Staff permission saved" : `${count} staff permissions saved` });
    },
    onError: (error, { scope }) => { if (committedSetupScope.current === scope) toast({ variant: "destructive", title: "Could not save assignment", description: error.message }); },
    onSettled: (_data, _error, { scope }) => { if (committedSetupScope.current === scope) refreshSetupLists(); },
  });

  const deactivateAssignmentMutation = useMutation({
    mutationFn: ({ id, scope }) => apiRequest("PATCH", `/coverage/assignments/${id}`, { active: false }, { headers: { "X-School-Id": scope.schoolId } }),
    onError: (error, { scope }) => { if (committedSetupScope.current === scope) toast({ variant: "destructive", title: "Could not disable access", description: error.message }); },
    onSettled: (_data, _error, { scope }) => { if (committedSetupScope.current === scope) refreshSetupLists(); },
  });

  const deleteSetupMutation = useMutation({
    retry: false,
    mutationFn: (target) => {
      if (committedSetupScope.current !== target.scope || !target.scope.isAdmin || !target.scope.schoolId) {
        throw new Error("The active school changed. Reopen this item before removing it.");
      }
      const path = target.kind === "group"
        ? `/coverage/supervision-groups/${encodeURIComponent(target.id)}`
        : `/coverage/assignments/staff/${encodeURIComponent(target.id)}`;
      return apiRequest("DELETE", path, target.kind === "permissions" ? { assignmentIds: target.assignmentIds } : { updatedAt: target.updatedAt }, {
        headers: { "X-School-Id": target.scope.schoolId },
      });
    },
    onSuccess: async (_result, target) => {
      // School-keyed caches may safely refresh after a switch; old confirmations may not.
      if (target.kind === "group") {
        queryClient.setQueryData(["/api/coverage/supervision-groups", target.scope.schoolId], (current) => current ? { ...current, groups: (current.groups || []).filter((group) => group.id !== target.id) } : current);
      } else {
        const removedIds = new Set(target.assignmentIds);
        queryClient.setQueryData(["/api/coverage/assignments", target.scope.schoolId], (current) => current ? { ...current, assignments: (current.assignments || []).filter((assignment) => !removedIds.has(assignment.id)) } : current);
      }
      const originalSchoolRefreshes = await Promise.allSettled([
        ["/api/coverage/supervision-groups/browse", target.scope.schoolId], ["/api/coverage/supervision-groups/detail", target.scope.schoolId],
        ["/api/coverage/assignments", target.scope.schoolId], ["/api/coverage/supervision-groups", target.scope.schoolId],
        ["/api/coverage/capabilities", target.scope.schoolId], ["classpilot-schedule-profiles", target.scope.schoolId],
      ].map((queryKey) => queryClient.invalidateQueries({ queryKey }, { throwOnError: true })));
      // Ignore UI/global-cache side effects after switching away, even when returning to A.
      if (committedSetupScope.current !== target.scope) return;
      const refreshes = await Promise.allSettled([
        ["/api/coverage/assignments"], ["/api/coverage/supervision-groups"], ["/api/coverage/capabilities"],
        ["/api/coverage/summary"], ["/api/coverage/contexts"], ["/api/coverage/unassigned"],
        ["/api/coverage/available-students"], ["/api/coverage/claimed-students"],
        ["classpilot-schedule-profiles"], ["classpilot-school-scheduling"],
      ].map((queryKey) => queryClient.invalidateQueries({ queryKey }, { throwOnError: true })));
      if (committedSetupScope.current !== target.scope) return;
      const message = target.kind === "group" ? `Supervision group “${target.name}” deleted.` : `Supervision permissions for ${target.name} removed.`;
      setSetupDeletionNotice({ scope: target.scope, kind: target.kind, message: `${message}${[...originalSchoolRefreshes, ...refreshes].some((result) => result.status === "rejected") ? " Some lists could not refresh. Use Refresh to reload them." : ""}` });
      setSetupDeletion(null);
    },
    onError: (error, target) => {
      if (committedSetupScope.current !== target.scope) return;
      setSetupDeletion((current) => current?.scope === target.scope && current.id === target.id && current.kind === target.kind
        ? { ...current, error: error.response?.data?.error || error.message || "This item could not be removed. Try again.", errorCode: error.response?.data?.code, dependencies: error.response?.data?.dependencies || [] } : current);
      if (error.response?.status === 409) {
        void refreshSupervisionSetup(queryClient, target.scope.schoolId);
        void queryClient.invalidateQueries({ queryKey: ["/api/coverage/assignments", target.scope.schoolId] });
        void queryClient.invalidateQueries({ queryKey: ["/api/coverage/supervision-groups", target.scope.schoolId] });
      }
    },
  });
  const setupDeletionBusy = deleteSetupMutation.isPending && deleteSetupMutation.variables?.scope === setupScope;
  const setupWriteBusy = setupDeletionBusy || saveAssignmentMutation.isPending || deactivateAssignmentMutation.isPending;
  const visibleSetupDeletion = isAdmin && setupDeletion?.scope === setupScope ? setupDeletion : null;
  const permissionPackageName = (permissionPackage) => {
    const staff = permissionPackage.staff || staffQuery.data?.find((person) => person.userId === permissionPackage.staffId);
    return staff?.displayName || staff?.email || staff?.user?.displayName || staff?.user?.email || "Unavailable staff member";
  };
  const openSetupDeletion = (target, event) => {
    if (!isAdmin || !schoolId || setupWriteBusy) return;
    deletionOpener.current = { element: event.currentTarget, scope: setupScope, kind: target.kind };
    deleteSetupMutation.reset();
    setSetupDeletionNotice(null);
    setSetupDeletion({ ...target, scope: setupScope, error: "" });
  };
  const closeSetupDeletion = () => { if (!setupDeletionBusy) setSetupDeletion(null); };
  const confirmSetupDeletion = () => {
    if (!visibleSetupDeletion || setupWriteBusy) return;
    setSetupDeletion((current) => ({ ...current, error: "" }));
    deleteSetupMutation.mutate(visibleSetupDeletion);
  };

  const toggleUnassignedStudent = (id) => {
    setSelectedUnassignedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleCoverageStudent = (id) => {
    setSelectedCoverageIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const chooseContext = (contextId) => {
    setSelectedContextId(contextId);
    setSelectedCoverageIds(new Set());
  };

  const resetAssignmentForm = () => {
    setAssignmentForm({
      existingIds: [],
      staffId: "",
      claim: true,
      setup: false,
      schoolwide: false,
      gradeValues: [],
      groupValues: [],
      coverageGroupValues: [],
      studentIds: [],
      active: true,
    });
    setStudentPickerSearch("");
    setAssignmentStaffSearch("");
  };

  const openAssignmentDialog = (permissionPackage = null) => {
    if (!permissionPackage) {
      resetAssignmentForm();
      setAssignmentOpen(true);
      return;
    }
    const assignments = permissionPackage.assignments || [permissionPackage];
    const gradeValues = [];
    const groupValues = [];
    const coverageGroupValues = [];
    const studentIds = new Set();
    let schoolwide = false;
    let claim = false;
    let setup = false;
    assignments.forEach((assignment) => {
      claim = claim || assignmentHasClaim(assignment);
      setup = setup || assignmentHasSetup(assignment);
      const scope = assignmentScopeSelection(assignment);
      if (scope.type === "school") schoolwide = true;
      if (scope.type === "grade" && scope.value) gradeValues.push(scope.value);
      if (scope.type === "group" && scope.value) groupValues.push(scope.value);
      if (scope.type === "coverage_group" && scope.value) coverageGroupValues.push(scope.value);
      if (scope.type === "students") {
        (scope.value || []).forEach((studentId) => studentIds.add(studentId));
      }
    });
    setAssignmentForm({
      existingIds: assignments.map((assignment) => assignment.id),
      staffId: permissionPackage.staffId || assignments[0]?.staffId || "",
      claim,
      setup,
      schoolwide,
      gradeValues: Array.from(new Set(gradeValues)),
      groupValues: Array.from(new Set(groupValues)),
      coverageGroupValues: Array.from(new Set(coverageGroupValues)),
      studentIds: Array.from(studentIds),
      active: assignments.some((assignment) => assignment.active !== false),
    });
    setStudentPickerSearch("");
    setAssignmentStaffSearch("");
    setAssignmentOpen(true);
  };

  const openScopeGroupDialog = group => { setScopeGroupId(group?.id || null); setScopeGroupOpen(true); };

  const toggleAssignmentStudent = (studentId) => {
    setAssignmentForm((prev) => {
      const selected = new Set(prev.studentIds);
      if (selected.has(studentId)) selected.delete(studentId);
      else selected.add(studentId);
      return { ...prev, studentIds: Array.from(selected) };
    });
  };

  const toggleAssignmentArrayValue = (field, scopeValue) => {
    setAssignmentForm((prev) => {
      const selected = new Set(prev[field] || []);
      if (selected.has(scopeValue)) selected.delete(scopeValue);
      else selected.add(scopeValue);
      return { ...prev, [field]: Array.from(selected) };
    });
  };

  const submitContext = () => {
    if (operationalBusy.current || !schoolId) return;
    const endsAt = new Date(contextForm.endsAt);
    if (!Number.isFinite(endsAt.getTime()) || endsAt <= new Date()) {
      toast({ variant: "destructive", title: "Choose a future end time" });
      return;
    }
    operationalBusy.current = true;
    createContextMutation.mutate({ scope: setupScope, payload: {
      ...contextForm,
      assignedStaffId: contextForm.assignedStaffId || currentUser?.id,
      studentIds: Array.from(selectedUnassignedIds),
      endsAt: endsAt.toISOString(),
    } });
  };

  const buildAssignmentPayloads = () => {
    const permissions = {
      observe: assignmentForm.claim || undefined,
      claim: assignmentForm.claim || undefined,
      setup: assignmentForm.setup || undefined,
    };
    const payloads = [];
    if (assignmentForm.schoolwide) {
      payloads.push({
        staffId: assignmentForm.staffId,
        scopeType: "school",
        permissions,
        active: assignmentForm.active,
      });
    }
    assignmentForm.gradeValues.forEach((scopeValue) => payloads.push({
      staffId: assignmentForm.staffId,
      scopeType: "grade",
      scopeValue,
      permissions,
      active: assignmentForm.active,
    }));
    assignmentForm.groupValues.forEach((scopeValue) => payloads.push({
      staffId: assignmentForm.staffId,
      scopeType: "group",
      scopeValue,
      permissions,
      active: assignmentForm.active,
    }));
    assignmentForm.coverageGroupValues.forEach((scopeValue) => payloads.push({
      staffId: assignmentForm.staffId,
      scopeType: "coverage_group",
      scopeValue,
      permissions,
      active: assignmentForm.active,
    }));
    if (assignmentForm.studentIds.length > 0) {
      payloads.push({
        staffId: assignmentForm.staffId,
        scopeType: "students",
        studentIds: assignmentForm.studentIds,
        permissions,
        active: assignmentForm.active,
      });
    }
    if (assignmentForm.setup && !assignmentForm.claim && payloads.length === 0 && canDelegateSetup) {
      payloads.push({
        staffId: assignmentForm.staffId,
        scopeType: "setup",
        permissions: { setup: true },
        active: assignmentForm.active,
      });
    }
    return payloads;
  };

  const submitAssignment = () => {
    const payloads = buildAssignmentPayloads();
    if (!assignmentForm.claim && !assignmentForm.setup) {
      toast({ variant: "destructive", title: "Choose access", description: "Select Claim + Manage students, Manage Supervision Setup, or both." });
      return;
    }
    if (assignmentForm.setup && !canDelegateSetup) {
      toast({ variant: "destructive", title: "Admin required", description: "Only admins can grant setup access." });
      return;
    }
    if (payloads.length === 0) {
      toast({ variant: "destructive", title: "Choose a scope", description: "Select schoolwide, at least one grade, class, group, or student." });
      return;
    }
    saveAssignmentMutation.mutate({ staffId: assignmentForm.staffId, payloads, scope: setupScope });
  };

  const sendCoverageCommand = (commandType, commandPayload = {}) => {
    if (!selectedContext?.id) {
      toast({ variant: "destructive", title: "Choose claimed students" });
      return;
    }
    if (commandTargetCount === 0) {
      toast({ variant: "destructive", title: "No active students in coverage" });
      return;
    }
    let targetStudentIds = commandTargetStudents.map(student => student.studentId);
    const targetScope = "students";
    let skippedCurrentPageCount = 0;
    if (
      commandType === "lock-screen"
      && commandPayload?.url === "CURRENT_URL"
    ) {
      const partition = partitionCoverageCurrentPageWaypointTargets(commandTargetStudents);
      targetStudentIds = partition.targetStudentIds;
      skippedCurrentPageCount = partition.skippedStudentIds.length;
      if (targetStudentIds.length === 0) {
        toast({
          variant: "destructive",
          title: "No current pages available",
          description: `${skippedCurrentPageCount} signed-out student${skippedCurrentPageCount === 1 ? " was" : "s were"} skipped. Choose a specific URL to save a Waypoint before sign-in.`,
        });
        return;
      }
    }
    commandMutation.mutate({
      scope: setupScope,
      contextId: selectedContext.id,
      commandType,
      commandPayload,
      targetScope,
      targetStudentIds,
      skippedCurrentPageCount,
    });
  };

  const openReleaseDialog = ({ contextId, studentIds, title, mode = "selected" }) => {
    if (operationalBusy.current || (mode !== "all" && studentIds.length === 0)) return;
    setReleaseReason("returned_to_class");
    const bindings = new Map((contextStudentsQuery.data || []).filter(student => studentIds.includes(student.studentId)).map(student => [student.studentId, supervisionAssignmentKey(student)]));
    setReleaseDialog({ contextId, studentIds: [...studentIds], bindings, title, mode, scope: setupScope });
  };

  const submitRelease = () => {
    if (operationalBusy.current || !releaseDialog?.contextId || !releaseReason || releaseDialog.scope !== committedSetupScope.current) return;
    if (releaseDialog.mode !== "all" && releaseDialog.studentIds.length === 0) return;
    if (releaseDialog.mode !== "all" && releaseDialog.contextId === activeContextId && releaseDialog.studentIds.some(id => !(contextStudentsQuery.data || []).some(student => student.studentId === id && !student.releasedAt && releaseDialog.bindings.get(id) === supervisionAssignmentKey(student)))) {
      toast({ variant: "destructive", title: "Supervision changed", description: "Close this confirmation and select the currently assigned students again." });
      return;
    }
    operationalBusy.current = true;
    releaseMutation.mutate({
      scope: releaseDialog.scope,
      mode: releaseDialog.mode,
      contextId: releaseDialog.contextId,
      studentIds: releaseDialog.studentIds,
      reason: releaseReason,
    });
  };

  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="border-b bg-card">
        <div className="max-w-screen-2xl mx-auto px-6 py-4 flex flex-wrap items-center justify-between gap-4">
          <div className="flex min-w-0 flex-1 items-center gap-3">
            <Button variant="ghost" size="icon" onClick={() => navigate("/classpilot")}>
              <ArrowLeft className="h-4 w-4" />
            </Button>
            <div className="min-w-0">
              <h1 className="text-xl font-semibold">Supervision</h1>
              <p className="text-sm text-muted-foreground">Pick up online students and manage flexible supervision groups</p>
            </div>
          </div>
          <Button variant="outline" onClick={refreshCoverage}>
            <RefreshCw className="h-4 w-4 mr-2" />
            Refresh
          </Button>
        </div>
      </header>

      <main className="max-w-screen-2xl mx-auto px-6 py-6">
        <MonitoringInterruptionsPanel />
        <div className="grid gap-4 md:grid-cols-3 mb-6">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm flex items-center gap-2"><Eye className="h-4 w-4" />Available Students</CardTitle>
            </CardHeader>
            <CardContent><p className="text-3xl font-semibold">{unassignedQuery.data?.length || 0}</p></CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm flex items-center gap-2"><ClipboardCheck className="h-4 w-4" />Claimed Students</CardTitle>
            </CardHeader>
            <CardContent><p className="text-3xl font-semibold">{summaryQuery.data?.claimedStudentCount ?? 0}</p></CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm flex items-center gap-2"><Shield className="h-4 w-4" />Assigned Staff</CardTitle>
            </CardHeader>
            <CardContent><p className="text-3xl font-semibold">{assignmentsQuery.data?.filter((a) => a.active).length || 0}</p></CardContent>
          </Card>
        </div>

        <Tabs value={visibleTab} onValueChange={setActiveTab}>
          <TabsList className="h-auto max-w-full flex-wrap justify-start gap-1">
            <TabsTrigger value="console">Claimed</TabsTrigger>
            <TabsTrigger value="unassigned">Available</TabsTrigger>
            <TabsTrigger value="contexts">Active Supervision</TabsTrigger>
            {canManageSupervisionSetup && <TabsTrigger ref={setupHeading} value="settings">Supervision Groups</TabsTrigger>}
            {isAdmin && <TabsTrigger ref={staffAccessHeading} value="staff-access">Staff access</TabsTrigger>}
          </TabsList>

          <TabsContent value="console" className="space-y-4 mt-4">
            {manageableContexts.length === 0 ? (
              <div className="rounded-md border px-4 py-12 text-center text-sm text-muted-foreground">
                {contextsQuery.isPending ? "Loading supervision…" : contextsQuery.isError ? "Supervision could not load. Use Refresh to retry." : "No students are claimed by you yet."}
              </div>
            ) : (
              <>
                <div className="flex gap-2 overflow-x-auto pb-1">
                  {manageableContexts.map((context) => (
                    <button
                      key={context.id}
                      type="button"
                      onClick={() => chooseContext(context.id)}
                      className={`min-w-[220px] rounded-md border px-3 py-2 text-left text-sm transition-colors ${selectedContext?.id === context.id ? "border-primary bg-primary/10" : "border-border bg-card hover:bg-muted/60"}`}
                    >
                      <span className="block font-medium truncate">{context.name}</span>
                      <span className="block text-xs text-muted-foreground">
                        {context.activeStudentCount} active - ends {formatTime(context.endsAt)}
                      </span>
                    </button>
                  ))}
                </div>

                <div className="rounded-md border bg-card">
                  <div className="flex flex-wrap items-center justify-between gap-3 border-b px-4 py-3">
                    <div>
                      <h2 className="text-base font-semibold">{selectedContext?.name}</h2>
                      <p className="text-xs text-muted-foreground">
                        {contextTypeLabel(selectedContext?.contextType)} - {selectedContext?.assignedStaff?.displayName || "Assigned staff"} - ends {formatTime(selectedContext?.endsAt)}
                      </p>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge variant="secondary">{commandTargetCount} command targets</Badge>
                      <Button variant="outline" size="sm" onClick={() => setHistoryContextId(selectedContext.id)}>
                        <History className="h-4 w-4 mr-2" />
                        History
                      </Button>
                    </div>
                  </div>

                  <div className="flex flex-wrap items-center gap-2 border-b px-4 py-3">
                    <Button size="sm" variant="outline" onClick={() => setCommandDialog("open-tab")} disabled={commandTargetCount === 0}>
                      <MonitorPlay className="h-4 w-4 mr-2" />
                      Open Tab
                    </Button>
                    <Button size="sm" variant="outline" onClick={() => sendCoverageCommand("close-tabs", { closeAll: true })} disabled={commandTargetCount === 0 || commandMutation.isPending}>
                      <X className="h-4 w-4 mr-2" />
                      Close Tabs
                    </Button>
                    <Button size="sm" variant="outline" onClick={() => sendCoverageCommand("lock-screen", { url: "CURRENT_URL" })} disabled={commandTargetCount === 0 || commandMutation.isPending} title={commandTargetDomainRestrictionMessage}>
                      <Lock className="h-4 w-4 mr-2" />
                      Set Waypoint
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => sendCoverageCommand("unlock-screen", { screenOnly: true })}
                      disabled={commandTargetCount === 0 || commandMutation.isPending || !commandTargetsSupportScreenOnlyUnlock}
                      title={commandTargetsSupportScreenOnlyUnlock ? "Clear the waypoint (screen only)" : "Extension update required for screen-only unlock"}
                    >
                      <Unlock className="h-4 w-4 mr-2" />
                      {commandTargetsSupportScreenOnlyUnlock ? "Clear Waypoint" : "Extension update required"}
                    </Button>
                    <Button size="sm" variant="outline" onClick={() => setCommandDialog("teacher-message")} disabled={commandTargetCount === 0}>
                      <MessageSquare className="h-4 w-4 mr-2" />
                      Message
                    </Button>
                    <Button size="sm" variant="outline" onClick={() => setCommandDialog("apply-flight-path")} disabled={commandTargetCount === 0} title={commandTargetDomainRestrictionMessage}>
                      <LinkIcon className="h-4 w-4 mr-2" />
                      Flight Path
                    </Button>
                    <Button size="sm" variant="outline" onClick={() => sendCoverageCommand("remove-flight-path")} disabled={commandTargetCount === 0 || commandMutation.isPending}>
                      <X className="h-4 w-4 mr-2" />
                      Remove Flight Path
                    </Button>
                    <Button size="sm" variant="outline" onClick={() => setCommandDialog("apply-block-list")} disabled={commandTargetCount === 0}>
                      <ShieldBan className="h-4 w-4 mr-2" />
                      Block List
                    </Button>
                    <Button size="sm" variant="outline" onClick={() => sendCoverageCommand("remove-block-list")} disabled={commandTargetCount === 0 || commandMutation.isPending}>
                      <X className="h-4 w-4 mr-2" />
                      Remove Block List
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={selectedCoverageStudentIds.length === 0 || releaseMutation.isPending}
                      onClick={() => openReleaseDialog({
                        contextId: selectedContext.id,
                        studentIds: selectedCoverageStudentIds,
                        title: `Release ${selectedCoverageStudentIds.length} selected student${selectedCoverageStudentIds.length === 1 ? "" : "s"}`,
                      })}
                    >
                      Release selected ({selectedCoverageStudentIds.length})
                    </Button>
                  </div>

                  <p
                    className="border-b px-4 py-2 text-xs text-muted-foreground"
                    data-testid="coverage-domain-preservation-message"
                  >
                    {commandTargetDomainRestrictionMessage}
                  </p>

                  <div className="space-y-3 px-4 py-3">
                    <CoverageStudentFilters label="Claimed" students={contextStudentsQuery.data || []} filters={claimedFilters} onChange={changeClaimedFilters} />
                    <div className="flex flex-wrap items-center gap-3">
                      <Button variant="outline" size="sm" onClick={() => setSelectedCoverageIds(new Set(activeCoverageStudents.map(student => student.studentId)))} disabled={activeCoverageStudents.length === 0}>
                        Select all matching students
                      </Button>
                      <Button variant="ghost" size="sm" onClick={() => setSelectedCoverageIds(new Set())} disabled={!hasExplicitCoverageSelection}>Clear selection</Button>
                      <p role="status" className="text-sm text-muted-foreground">{activeCoverageStudents.length} matching · {selectedCoverageIds.size} selected</p>
                    </div>
                    {hasExplicitCoverageSelection && selectedCoverageIds.size === 0 && <p role="status" className="text-sm text-muted-foreground">Selected students are no longer assigned here. Clear the selection or choose students again.</p>}
                    <p className="text-xs text-muted-foreground">Offline students can be released. Chromebook commands apply only to eligible matching students.</p>
                    {contextStudentsQuery.isPending && <p role="status">Loading supervised students…</p>}
                    {contextStudentsQuery.isError && <p role="alert">Supervised students could not load. <Button variant="link" onClick={() => contextStudentsQuery.refetch()}>Retry</Button></p>}
                  </div>

                  <div className="overflow-x-auto">
                    <div className="grid min-w-[860px] grid-cols-[44px_1.1fr_90px_110px_1.4fr_130px_120px] gap-3 px-4 py-3 text-xs font-medium text-muted-foreground bg-muted/50">
                      <span />
                      <span>Student</span>
                      <span>Grade</span>
                      <span>Status</span>
                      <span>Active Tab</span>
                      <span>Claimed</span>
                      <span />
                    </div>
                    {coverageStudents.length === 0 ? (
                      <div className="px-4 py-10 text-center text-sm text-muted-foreground">{contextStudentsQuery.isPending ? "Loading supervised students…" : contextStudentsQuery.isError ? "Supervised students are unavailable." : "No students match these filters."}</div>
                    ) : coverageStudents.map((student) => (
                      <div key={student.studentId} className="grid min-w-[860px] grid-cols-[44px_1.1fr_90px_110px_1.4fr_130px_120px] gap-3 border-t px-4 py-3 text-sm items-center">
                        <Checkbox aria-label={`Select ${student.studentName}`} checked={selectedCoverageIds.has(student.studentId)} onCheckedChange={() => toggleCoverageStudent(student.studentId)} disabled={!!student.releasedAt} />
                        <div>
                          <p className="font-medium">{student.studentName}</p>
                          <p className="text-xs text-muted-foreground">{student.studentEmail}</p>
                        </div>
                        <span>{student.gradeLevel || "None"}</span>
                        <Badge variant={statusBadgeVariant(student.status)}>{student.status}</Badge>
                        <span className="truncate text-muted-foreground">{student.activeTabTitle || student.activeTabUrl || "No active tab"}</span>
                        <span className="text-muted-foreground">{minutesSince(student.assignedAt)}</span>
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={!!student.releasedAt || releaseMutation.isPending}
                          onClick={() => openReleaseDialog({
                            contextId: selectedContext.id,
                            studentIds: [student.studentId],
                            title: `Release ${student.studentName}`,
                          })}
                        >
                          Release
                        </Button>
                      </div>
                    ))}
                  </div>
                </div>
              </>
            )}
          </TabsContent>

          <TabsContent value="unassigned" className="space-y-4 mt-4">
            <CoverageStudentFilters label="Available" students={unassignedQuery.data || []} filters={availableFilters} onChange={changeAvailableFilters} />
            <div className="flex items-center justify-between gap-3 flex-wrap">
              <div className="flex flex-wrap items-center gap-3">
                <Button variant="outline" size="sm" onClick={() => setSelectedUnassignedIds(new Set(unassignedStudents.map(student => student.studentId)))} disabled={unassignedStudents.length === 0}>Select all matching students</Button>
                <Button variant="ghost" size="sm" onClick={() => setSelectedUnassignedIds(new Set())} disabled={selectedUnassignedIds.size === 0}>Clear selection</Button>
                <p role="status" className="text-sm text-muted-foreground">{unassignedStudents.length} matching · {selectedUnassignedIds.size} selected</p>
              </div>
              <Button onClick={() => setContextOpen(true)} disabled={selectedUnassignedIds.size === 0 && !isAdmin}>
                <Plus className="h-4 w-4 mr-2" />
                Start Supervision
              </Button>
            </div>
            {unassignedQuery.isPending && <p role="status">Loading available students…</p>}
            {unassignedQuery.isError && <p role="alert">Available students could not load. <Button variant="link" onClick={() => unassignedQuery.refetch()}>Retry</Button></p>}
            <div className="rounded-md border overflow-x-auto">
              <div className="grid min-w-[700px] grid-cols-[44px_1fr_120px_120px_1.5fr] gap-3 px-4 py-3 text-xs font-medium text-muted-foreground bg-muted/50">
                <span />
                <span>Student</span>
                <span>Grade</span>
                <span>Status</span>
                <span>Active Tab</span>
              </div>
              {unassignedStudents.length === 0 ? (
                <div className="px-4 py-10 text-center text-sm text-muted-foreground">{unassignedQuery.isPending ? "Loading available students…" : unassignedQuery.isError ? "Available students are unavailable." : "No online available students match these filters."}</div>
              ) : unassignedStudents.map((student) => (
                <div key={student.studentId} className="grid min-w-[700px] grid-cols-[44px_1fr_120px_120px_1.5fr] gap-3 px-4 py-3 border-t items-center text-sm">
                  <Checkbox aria-label={`Select ${student.studentName}`} checked={selectedUnassignedIds.has(student.studentId)} onCheckedChange={() => toggleUnassignedStudent(student.studentId)} />
                  <div>
                    <p className="font-medium">{student.studentName}</p>
                    <p className="text-xs text-muted-foreground">{student.studentEmail}</p>
                  </div>
                  <span>{student.gradeLevel || "None"}</span>
                  <Badge variant={statusBadgeVariant(student.status)}>{student.status}</Badge>
                  <span className="truncate text-muted-foreground">{student.activeTabTitle || student.activeTabUrl || "No active tab"}</span>
                </div>
              ))}
            </div>
          </TabsContent>

          <TabsContent value="contexts" className="space-y-4 mt-4">
            <div className="flex justify-end">
              {isAdmin && (
                <Button onClick={() => setContextOpen(true)}>
                  <Plus className="h-4 w-4 mr-2" />
                  Start Supervision
                </Button>
              )}
            </div>
            <div className="grid gap-3">
              {contexts.length === 0 ? (
                <div className="rounded-md border px-4 py-10 text-center text-sm text-muted-foreground">No active supervision</div>
              ) : contexts.map((context) => (
                <Card key={context.id}>
                  <CardHeader className="pb-3">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <CardTitle className="text-base">{context.name}</CardTitle>
                        <CardDescription>
                          {context.assignedStaff?.displayName || "Assigned staff"} - ends {formatTime(context.endsAt)}
                        </CardDescription>
                      </div>
                      <Badge>{context.activeStudentCount} active</Badge>
                    </div>
                  </CardHeader>
                  <CardContent className="space-y-3">
                    {context.students?.length ? (
                      <div className="flex flex-wrap gap-2">
                        {context.students.map((student) => <Badge variant="secondary" key={student.studentId}>{student.studentName}</Badge>)}
                      </div>
                    ) : <p className="text-sm text-muted-foreground">{context.canViewStudents ? "No active students assigned" : "Student list is visible to assigned coverage staff"}</p>}
                    <div className="flex flex-wrap gap-2">
                      {context.canManage && (
                        <>
                          <Button variant="outline" size="sm" onClick={() => { chooseContext(context.id); setActiveTab("console"); }}>
                            <Users className="h-4 w-4 mr-2" />
                            Open Console
                          </Button>
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => openReleaseDialog({ contextId: context.id, studentIds: [], mode: "all", title: `Release all students from ${context.name}` })}
                            disabled={context.activeStudentCount === 0}
                          >
                            <X className="h-4 w-4 mr-2" />
                            Release All
                          </Button>
                        </>
                      )}
                      {context.canManage && (
                        <Button variant="ghost" size="sm" onClick={() => setHistoryContextId(context.id)}>
                          <History className="h-4 w-4 mr-2" />
                          History
                        </Button>
                      )}
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          </TabsContent>

          {canManageSupervisionSetup && <TabsContent value="settings" forceMount hidden={visibleTab !== "settings"} inert={visibleTab !== "settings" || undefined} className={`space-y-4 mt-4 ${visibleTab !== "settings" ? "hidden" : ""}`}><SupervisionGroupDirectory key={`${schoolId}:${currentUser?.id}:${currentUser?.role}:${isAdmin}`} schoolId={schoolId} active={visibleTab === "settings"} isAdmin={isAdmin} busy={setupWriteBusy} onEdit={openScopeGroupDialog} savedGroupId={setupDeletionNotice?.scope === setupScope ? setupDeletionNotice.savedGroupId : null} notice={setupDeletionNotice?.scope === setupScope && setupDeletionNotice.kind === "group" ? setupDeletionNotice.message : ""} onDelete={(group, event) => openSetupDeletion({ kind: "group", id: group.id, name: group.name, updatedAt: group.updatedAt, studentCount: group.studentCount, staffCount: group.staff?.length || 0 }, event)} /></TabsContent>}

          {isAdmin && (
            <TabsContent value="staff-access" className="space-y-4 mt-4">
              {setupDeletionNotice?.scope === setupScope && setupDeletionNotice.kind === "permissions" && <p role="status" className="rounded-md border bg-muted/30 p-3 text-sm">{setupDeletionNotice.message}</p>}
              {assignmentsQuery.isError && <p role="alert" className="rounded-md border p-3 text-sm text-destructive">Staff access could not load. Use Refresh to retry before removing permissions.</p>}
              {assignmentsQuery.isFetching && !assignmentsQuery.isPending && <p role="status" className="text-sm text-muted-foreground">Refreshing staff access… Permission removal is available when the refresh finishes.</p>}
              <Card className="min-w-0">
                <CardHeader className="flex flex-col items-start justify-between gap-4 sm:flex-row sm:flex-wrap">
                  <div className="min-w-0 flex-1">
                    <CardTitle className="text-base">Staff access</CardTitle>
                    <CardDescription>Review access across supervision groups, classes, grades, selected students, and the school. Grant supervision or setup-management access here.</CardDescription>
                  </div>
                  <Button disabled={setupWriteBusy} onClick={() => openAssignmentDialog()}>
                    <UserCheck className="h-4 w-4 mr-2" />
                    Give Staff Access
                  </Button>
                </CardHeader>
                <CardContent>
                  <div className="rounded-md border overflow-hidden">
                    {permissionPackages.length === 0 ? (
                      <div className="px-4 py-10 text-center text-sm text-muted-foreground">{assignmentsQuery.isPending ? "Loading staff access…" : assignmentsQuery.isError ? "Staff permissions are unavailable." : "No staff permissions yet"}</div>
                    ) : permissionPackages.map((permissionPackage) => (
                      <div key={permissionPackage.staffId} data-testid={`staff-permissions-${permissionPackage.staffId}`} className="grid min-w-0 gap-3 border-t first:border-t-0 px-4 py-3 text-sm sm:grid-cols-[minmax(0,1fr)_auto]">
                        <div className="min-w-0">
                          <p className="break-words font-medium">{permissionPackageName(permissionPackage)}</p>
                          <p className="break-all text-xs text-muted-foreground">{permissionPackage.staff?.email || (permissionPackageName(permissionPackage) === "Unavailable staff member" ? permissionPackage.staffId : `${permissionPackage.assignments.length} permission${permissionPackage.assignments.length === 1 ? "" : "s"}`)}</p>
                        </div>
                        <Badge className="w-fit self-start" variant={permissionPackage.active ? "default" : "outline"}>{permissionPackage.active ? "Active" : "Disabled"}</Badge>
                        <div className="flex min-w-0 flex-wrap gap-2 sm:col-span-2">
                          {permissionPackage.claim && <Badge variant="outline">Claim + Manage</Badge>}
                          {permissionPackage.setup && <Badge variant="outline">Setup</Badge>}
                          {permissionPackage.scopeLabels.slice(0, 5).map((label) => (
                            <Badge className="max-w-full whitespace-normal break-words text-left" variant="secondary" key={label}>{label}</Badge>
                          ))}
                          {permissionPackage.scopeLabels.length > 5 && (
                            <Badge variant="secondary">+{permissionPackage.scopeLabels.length - 5} more</Badge>
                          )}
                        </div>
                        <div className="flex flex-wrap justify-start gap-2 sm:col-span-2">
                          <Button variant="outline" size="sm" disabled={setupWriteBusy} onClick={() => openAssignmentDialog(permissionPackage)}>
                            Edit
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => permissionPackage.assignments.forEach((assignment) => {
                              if (!assignmentHasSetup(assignment) || canDelegateSetup) deactivateAssignmentMutation.mutate({ id: assignment.id, scope: setupScope });
                            })}
                            disabled={!permissionPackage.active || setupWriteBusy}
                          >
                            Disable
                          </Button>
                          <Button variant="outline" size="sm" className="text-destructive hover:text-destructive" disabled={setupWriteBusy || !schoolId || assignmentsQuery.isFetching || assignmentsQuery.isError} aria-label={`Remove permissions for ${permissionPackageName(permissionPackage)}${permissionPackageName(permissionPackage) === "Unavailable staff member" ? ` (${permissionPackage.staffId})` : ""}`} onClick={(event) => openSetupDeletion({ kind: "permissions", id: permissionPackage.staffId, name: permissionPackageName(permissionPackage), assignmentIds: [...new Set(permissionPackage.assignments.map((assignment) => assignment.id))].sort(), scopeLabels: [...permissionPackage.scopeLabels] }, event)}>
                            <Trash2 className="mr-2 h-3.5 w-3.5 shrink-0" />Remove permissions
                          </Button>
                        </div>
                      </div>
                    ))}
                  </div>
                </CardContent>
              </Card>
            </TabsContent>
          )}
        </Tabs>
      </main>

      <AlertDialog open={!!visibleSetupDeletion} onOpenChange={(open) => { if (!open) closeSetupDeletion(); }}>
        <AlertDialogContent className="max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] max-w-lg overflow-y-auto" onEscapeKeyDown={(event) => { if (setupDeletionBusy) event.preventDefault(); }} onCloseAutoFocus={(event) => {
          event.preventDefault();
          if (deletionOpener.current?.scope !== setupScope || committedSetupScope.current !== setupScope) return;
          const target = deletionOpener.current.element;
          const fallback = deletionOpener.current.kind === "permissions" ? staffAccessHeading.current : setupHeading.current;
          (target?.isConnected ? target : fallback)?.focus();
        }}>
          <AlertDialogHeader>
            <AlertDialogTitle>{visibleSetupDeletion?.kind === "group" ? "Delete supervision group?" : "Remove staff permissions?"}</AlertDialogTitle>
            <AlertDialogDescription className="break-words">
              {visibleSetupDeletion?.kind === "group"
                ? `Delete “${visibleSetupDeletion.name}” and its student/staff links and permissions that apply only to this group. Student and staff accounts, regular class rosters, unrelated permissions and supervision history remain.`
                : `Remove all ${visibleSetupDeletion?.assignmentIds.length || 0} displayed supervision permission${visibleSetupDeletion?.assignmentIds.length === 1 ? "" : "s"} for ${visibleSetupDeletion?.name || "this staff member"}, including disabled permissions. Their staff account, regular class assignments and supervision history remain.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {visibleSetupDeletion?.kind === "permissions" && <div className="space-y-2 text-sm">
            {visibleSetupDeletion.name === "Unavailable staff member" && <p className="break-all text-xs text-muted-foreground">Staff record: {visibleSetupDeletion.id}</p>}
            {visibleSetupDeletion.scopeLabels.length > 0 && <><p className="font-medium">Permission scopes being removed</p><ul tabIndex={0} aria-label="Permission scopes being removed" className="max-h-40 list-disc space-y-1 overflow-y-auto rounded pl-5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">{visibleSetupDeletion.scopeLabels.map((label) => <li className="break-words" key={label}>{label}</li>)}</ul></>}
          </div>}
          <p className="text-sm text-muted-foreground">Resolve active supervision and saved or scheduled testing dependencies before removing this setup. The server checks for changes again when you confirm.</p>
          {visibleSetupDeletion?.error && <div className="space-y-2 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm">
            <p role="alert" className="break-words text-destructive">{visibleSetupDeletion.error}</p>
            {visibleSetupDeletion.errorCode === "COVERAGE_DELETE_STALE" && <p>Cancel and reopen this item to review the updated setup before trying again.</p>}
            {visibleSetupDeletion.dependencies?.length > 0 && <ul tabIndex={0} aria-label="Dependencies preventing removal" className="max-h-40 list-disc space-y-1 overflow-y-auto rounded pl-5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">{visibleSetupDeletion.dependencies.map((item, index) => <li key={`${item.kind}:${item.id}:${index}`} className="break-words">{item.kind === "profile" ? "Profile" : item.kind === "application" ? "Scheduled application" : "Active supervision"}: {item.name}{item.date ? ` · ${item.date}` : ""}</li>)}</ul>}
          </div>}
          <AlertDialogFooter className="gap-2">
            <AlertDialogCancel disabled={setupDeletionBusy}>Cancel</AlertDialogCancel>
            <AlertDialogAction className="bg-destructive text-destructive-foreground hover:bg-destructive/90" disabled={setupDeletionBusy} onClick={(event) => { event.preventDefault(); confirmSetupDeletion(); }}>
              {setupDeletionBusy ? "Removing…" : visibleSetupDeletion?.kind === "group" ? visibleSetupDeletion.error ? "Retry deletion" : "Delete group" : visibleSetupDeletion?.error ? "Retry removal" : "Remove permissions"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <Dialog open={contextOpen} onOpenChange={setContextOpen}>
        <DialogContent>
          <DialogHeader><DialogTitle>Start Supervision</DialogTitle></DialogHeader>
          <div className="space-y-4">
            <div className="grid gap-2">
              <Label>Type</Label>
              <Select value={contextForm.contextType} onValueChange={(value) => setContextForm((f) => ({ ...f, contextType: value, name: coverageTypes.find(([id]) => id === value)?.[1] || f.name }))}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>{coverageTypes.map(([id, label]) => <SelectItem key={id} value={id}>{label}</SelectItem>)}</SelectContent>
              </Select>
            </div>
            <div className="grid gap-2">
              <Label>Name</Label>
              <Input value={contextForm.name} onChange={(e) => setContextForm((f) => ({ ...f, name: e.target.value }))} />
            </div>
            {isAdmin && (
              <div className="grid gap-2">
                <Label>Assigned Staff</Label>
                <Select value={contextForm.assignedStaffId || currentUser?.id || ""} onValueChange={(value) => setContextForm((f) => ({ ...f, assignedStaffId: value }))}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>{(staffQuery.data || []).map((staff) => <SelectItem key={staff.userId} value={staff.userId}>{displayName(staff)}</SelectItem>)}</SelectContent>
                </Select>
              </div>
            )}
            {isAdmin && (
              <div className="grid gap-2">
                <Label>Supervision Group</Label>
                <Select value={contextForm.coverageGroupId || "none"} onValueChange={(value) => setContextForm((f) => ({ ...f, coverageGroupId: value === "none" ? "" : value }))}>
                  <SelectTrigger><SelectValue placeholder="Optional supervision group" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">No supervision group</SelectItem>
                    {activeScopeGroups.map((group) => (
                      <SelectItem key={group.id} value={group.id}>{group.name} ({group.studentCount})</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
            <div className="grid gap-2">
              <Label>End Time</Label>
              <Input type="datetime-local" value={contextForm.endsAt} onChange={(e) => setContextForm((f) => ({ ...f, endsAt: e.target.value }))} />
            </div>
            <div className="grid gap-2">
              <Label>Note</Label>
              <Textarea value={contextForm.note} onChange={(e) => setContextForm((f) => ({ ...f, note: e.target.value }))} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setContextOpen(false)}>Cancel</Button>
            <Button onClick={submitContext} disabled={createContextMutation.isPending || !contextForm.name || !contextForm.endsAt}>Start</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={isAdmin && assignmentOpen} onOpenChange={setAssignmentOpen}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>{assignmentForm.existingIds.length ? "Edit Staff Access" : "Give Staff Access"}</DialogTitle>
            <DialogDescription>Choose what this staff member can do, then choose the grades, classes, groups, or students where it applies.</DialogDescription>
          </DialogHeader>
          <div className="max-h-[70vh] space-y-5 overflow-y-auto pr-1">
            <div className="grid gap-2">
              <Label>Staff</Label>
              <div className="relative">
                <Search className="h-4 w-4 absolute left-3 top-3 text-muted-foreground" />
                <Input
                  className="pl-9"
                  placeholder="Search staff by name, email, or role"
                  value={assignmentStaffSearch}
                  onChange={(event) => setAssignmentStaffSearch(event.target.value)}
                />
              </div>
              <Select value={assignmentForm.staffId} onValueChange={(value) => setAssignmentForm((f) => ({ ...f, staffId: value }))}>
                <SelectTrigger><SelectValue placeholder="Select staff" /></SelectTrigger>
                <SelectContent>
                  {assignableStaff.length === 0 ? (
                    <SelectItem value="none" disabled>No staff found</SelectItem>
                  ) : assignableStaff.map((staff) => (
                    <SelectItem key={staff.userId} value={staff.userId}>{displayName(staff)}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="rounded-md border p-3">
              <div className="mb-3">
                <Label>Access abilities</Label>
                <p className="text-xs text-muted-foreground">Claim + Manage lets staff pick up available students. Setup lets admins delegate group setup inside the chosen scopes.</p>
              </div>
              <div className="grid gap-3 md:grid-cols-2">
                <label className="flex cursor-pointer items-start gap-3 rounded-md border p-3">
                  <Checkbox
                    checked={assignmentForm.claim}
                    onCheckedChange={(checked) => setAssignmentForm((f) => ({ ...f, claim: checked === true }))}
                  />
                  <span>
                    <span className="block text-sm font-medium">Claim + Manage students</span>
                    <span className="block text-xs text-muted-foreground">Staff can see eligible Available students and claim them.</span>
                  </span>
                </label>
                {canDelegateSetup ? (
                  <label className="flex cursor-pointer items-start gap-3 rounded-md border p-3">
                    <Checkbox
                      checked={assignmentForm.setup}
                      onCheckedChange={(checked) => setAssignmentForm((f) => ({ ...f, setup: checked === true }))}
                    />
                    <span>
                      <span className="block text-sm font-medium">Manage Supervision Setup</span>
                      <span className="block text-xs text-muted-foreground">Staff can create groups and assign staff only inside these scopes.</span>
                    </span>
                  </label>
                ) : (
                  <div className="rounded-md border border-dashed p-3 text-sm text-muted-foreground">
                    Only admins can grant setup access to another staff member.
                  </div>
                )}
              </div>
            </div>

            <div className="rounded-md border p-3">
              <div className="mb-3 flex items-center justify-between gap-3">
                <div>
                  <Label>Scopes</Label>
                  <p className="text-xs text-muted-foreground">Choose one or more areas this access applies to.</p>
                </div>
                <Badge variant="secondary">{assignmentScopeCount} selected</Badge>
              </div>
              {canChooseSchoolwide && (
                <label className="mb-3 flex cursor-pointer items-center gap-3 rounded-md border px-4 py-2 text-sm">
                  <Checkbox
                    checked={assignmentForm.schoolwide}
                    onCheckedChange={(checked) => setAssignmentForm((f) => ({ ...f, schoolwide: checked === true }))}
                  />
                  <span className="font-medium">Schoolwide</span>
                </label>
              )}

              <div className="grid gap-4 lg:grid-cols-2">
                <div className="space-y-2">
                  <div>
                    <Label>Roster grades</Label>
                    <p className="text-xs text-muted-foreground">Grades come from student records in Class Roster.</p>
                  </div>
                  <div className="max-h-48 overflow-y-auto rounded-md border">
                    {rosterGrades.length === 0 ? (
                      <div className="px-4 py-8 text-center text-sm text-muted-foreground">No roster grades found</div>
                    ) : rosterGrades.map((grade) => (
                      <label key={grade.value} className="flex cursor-pointer items-center gap-3 border-t first:border-t-0 px-4 py-2 text-sm">
                        <Checkbox checked={assignmentForm.gradeValues.includes(grade.value)} onCheckedChange={() => toggleAssignmentArrayValue("gradeValues", grade.value)} />
                        <span className="flex-1">
                          <span className="block font-medium">Grade {grade.value}</span>
                          <span className="block text-xs text-muted-foreground">{grade.count} roster student{grade.count === 1 ? "" : "s"}</span>
                        </span>
                      </label>
                    ))}
                  </div>
                </div>

                <div className="space-y-2">
                  <div>
                    <Label>Classes</Label>
                    <p className="text-xs text-muted-foreground">Classes come from Class Management rosters.</p>
                  </div>
                  <div className="max-h-48 overflow-y-auto rounded-md border">
                    {classManagementGroups.length === 0 ? (
                      <div className="px-4 py-8 text-center text-sm text-muted-foreground">No classes found</div>
                    ) : classManagementGroups.map((group) => (
                      <label key={group.id} className="flex cursor-pointer items-center gap-3 border-t first:border-t-0 px-4 py-2 text-sm">
                        <Checkbox checked={assignmentForm.groupValues.includes(group.id)} onCheckedChange={() => toggleAssignmentArrayValue("groupValues", group.id)} />
                        <span className="flex-1">
                          <span className="block font-medium">{group.name}</span>
                          <span className="block text-xs text-muted-foreground">
                            {[group.periodLabel, group.gradeLevel ? `Grade ${group.gradeLevel}` : null].filter(Boolean).join(" - ") || "Class Management"}
                          </span>
                        </span>
                      </label>
                    ))}
                  </div>
                </div>

                <div className="space-y-2">
                  <Label>Supervision Groups</Label>
                  <div className="max-h-48 overflow-y-auto rounded-md border">
                    {activeScopeGroups.length === 0 ? (
                      <div className="px-4 py-8 text-center text-sm text-muted-foreground">No supervision groups found</div>
                    ) : activeScopeGroups.map((group) => (
                      <label key={group.id} className="flex cursor-pointer items-center gap-3 border-t first:border-t-0 px-4 py-2 text-sm">
                        <Checkbox checked={assignmentForm.coverageGroupValues.includes(group.id)} onCheckedChange={() => toggleAssignmentArrayValue("coverageGroupValues", group.id)} />
                        <span className="flex-1">
                          <span className="block font-medium">{group.name}</span>
                          <span className="block text-xs text-muted-foreground">{group.studentCount} student{group.studentCount === 1 ? "" : "s"}</span>
                        </span>
                      </label>
                    ))}
                  </div>
                </div>

                <div className="space-y-2">
                  <div className="flex items-center justify-between gap-3">
                    <Label>Selected Students</Label>
                    <Badge variant="secondary">{assignmentForm.studentIds.length} selected</Badge>
                  </div>
                  <div className="relative">
                    <Search className="h-4 w-4 absolute left-3 top-3 text-muted-foreground" />
                    <Input className="pl-9" placeholder="Search students" value={studentPickerSearch} onChange={(e) => setStudentPickerSearch(e.target.value)} />
                  </div>
                  <div className="max-h-48 overflow-y-auto rounded-md border">
                    {filteredPickerStudents.length === 0 ? (
                      <div className="px-4 py-8 text-center text-sm text-muted-foreground">No students found</div>
                    ) : filteredPickerStudents.map((student) => (
                      <label key={student.id} className="flex cursor-pointer items-center gap-3 border-t first:border-t-0 px-4 py-2 text-sm">
                        <Checkbox checked={assignmentForm.studentIds.includes(student.id)} onCheckedChange={() => toggleAssignmentStudent(student.id)} />
                        <span className="flex-1">
                          <span className="block font-medium">{student.studentName}</span>
                          <span className="block text-xs text-muted-foreground">{student.studentEmail || "No email"} - Grade {student.gradeLevel || "None"}</span>
                        </span>
                      </label>
                    ))}
                  </div>
                </div>
              </div>
            </div>
            {assignmentForm.existingIds.length > 0 && (
              <label className="flex items-center gap-2 text-sm">
                <Checkbox checked={assignmentForm.active} onCheckedChange={(checked) => setAssignmentForm((f) => ({ ...f, active: checked === true }))} />
                Active permission
              </label>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAssignmentOpen(false)}>Cancel</Button>
            <Button
              onClick={submitAssignment}
              disabled={
                saveAssignmentMutation.isPending ||
                !assignmentCanSave
              }
            >
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <SupervisionGroupEditor open={canManageSupervisionSetup && scopeGroupOpen} schoolId={schoolId} groupId={scopeGroupId} onOpenChange={setScopeGroupOpen} onSaved={({ group, refreshWarning }) => setSetupDeletionNotice({ scope: setupScope, kind: "group", savedGroupId: group.id, message: `Supervision group “${group.name}” saved.${refreshWarning ? " Some lists could not refresh. Use Refresh to reload them." : ""}` })} />

      <Dialog open={!!commandDialog} onOpenChange={(open) => !open && setCommandDialog(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {commandDialog === "open-tab" && "Open Tab"}
              {commandDialog === "teacher-message" && "Message Students"}
              {commandDialog === "apply-flight-path" && "Apply Flight Path"}
              {commandDialog === "apply-block-list" && "Apply Block List"}
            </DialogTitle>
            <DialogDescription className="space-y-1">
              <span className="block">
                Targets {commandTargetCount} student{commandTargetCount === 1 ? "" : "s"} in {selectedContext?.name || "coverage"}.
              </span>
              {commandDialog === "apply-flight-path" ? (
                <span className="block" data-testid="coverage-flight-path-domain-preservation-message">
                  {commandTargetDomainRestrictionMessage}
                </span>
              ) : null}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            {commandDialog === "open-tab" && (
              <div className="grid gap-2">
                <Label>URL</Label>
                <Input placeholder="https://example.com" value={commandUrl} onChange={(e) => setCommandUrl(e.target.value)} />
              </div>
            )}
            {commandDialog === "teacher-message" && (
              <div className="grid gap-2">
                <Label>Message</Label>
                <Textarea value={commandMessage} onChange={(e) => setCommandMessage(e.target.value)} />
              </div>
            )}
            {commandDialog === "apply-flight-path" && (
              <div className="grid gap-2">
                <Label>Flight Path</Label>
                <Select value={selectedFlightPathId} onValueChange={setSelectedFlightPathId}>
                  <SelectTrigger><SelectValue placeholder="Select flight path" /></SelectTrigger>
                  <SelectContent>
                    {(flightPathsQuery.data || []).map((flightPath) => (
                      <SelectItem
                        key={flightPath.id}
                        value={flightPath.id}
                        disabled={!flightPathApplyCapability(flightPath).enabled}
                      >
                        {flightPath.flightPathName}
                        {flightPathApplyCapability(flightPath).enabled ? "" : " (add an allowed domain)"}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {selectedFlightPathId
                  && !flightPathApplyCapability(
                    (flightPathsQuery.data || []).find((flightPath) => flightPath.id === selectedFlightPathId),
                  ).enabled
                  && (
                    <p className="text-sm text-destructive">
                      Add at least one allowed domain before applying this Flight Path.
                    </p>
                  )}
              </div>
            )}
            {commandDialog === "apply-block-list" && (
              <div className="grid gap-2">
                <Label>Block List</Label>
                <Select value={selectedBlockListId} onValueChange={setSelectedBlockListId}>
                  <SelectTrigger><SelectValue placeholder="Select block list" /></SelectTrigger>
                  <SelectContent>
                    {(blockListsQuery.data || []).map((blockList) => (
                      <SelectItem key={blockList.id} value={blockList.id}>{blockList.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCommandDialog(null)}>Cancel</Button>
            {commandDialog === "open-tab" && (
              <Button onClick={() => sendCoverageCommand("open-tab", { url: commandUrl })} disabled={commandMutation.isPending || !commandUrl.trim()}>
                <MonitorPlay className="h-4 w-4 mr-2" />
                Open
              </Button>
            )}
            {commandDialog === "teacher-message" && (
              <Button onClick={() => sendCoverageCommand("teacher-message", { message: commandMessage })} disabled={commandMutation.isPending || !commandMessage.trim()}>
                <MessageSquare className="h-4 w-4 mr-2" />
                Send
              </Button>
            )}
            {commandDialog === "apply-flight-path" && (
              <Button
                onClick={() => sendCoverageCommand("apply-flight-path", { flightPathId: selectedFlightPathId })}
                disabled={
                  commandMutation.isPending
                  || !selectedFlightPathId
                  || !flightPathApplyCapability(
                    (flightPathsQuery.data || []).find((flightPath) => flightPath.id === selectedFlightPathId),
                  ).enabled
                }
              >
                Apply
              </Button>
            )}
            {commandDialog === "apply-block-list" && (
              <Button onClick={() => sendCoverageCommand("apply-block-list", { blockListId: selectedBlockListId })} disabled={commandMutation.isPending || !selectedBlockListId}>
                Apply
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!releaseDialog} onOpenChange={(open) => !open && setReleaseDialog(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{releaseDialog?.title || "Release Students"}</DialogTitle>
            <DialogDescription>Choose why these students are leaving supervision.</DialogDescription>
          </DialogHeader>
          <div className="grid gap-2">
            <Label>Release Reason</Label>
            <Select value={releaseReason} onValueChange={setReleaseReason}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {releaseReasons.map(([id, label]) => <SelectItem key={id} value={id}>{label}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setReleaseDialog(null)}>Cancel</Button>
            <Button onClick={submitRelease} disabled={releaseMutation.isPending || !releaseReason}>Release</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!historyContextId} onOpenChange={(open) => !open && setHistoryContextId("")}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Supervision History</DialogTitle>
          </DialogHeader>
          <div className="max-h-[60vh] overflow-y-auto rounded-md border">
            {(historyQuery.data || []).length === 0 ? (
              <div className="px-4 py-10 text-center text-sm text-muted-foreground">No history yet</div>
            ) : historyQuery.data.map((event) => (
              <div key={event.id} className="border-t first:border-t-0 px-4 py-3 text-sm">
                <div className="flex items-center justify-between gap-3">
                  <p className="font-medium">{event.studentName || event.action}</p>
                  <span className="text-xs text-muted-foreground">{formatTime(event.createdAt)}</span>
                </div>
                <p className="text-xs text-muted-foreground">
                  {event.actorEmail || event.actorId || "System"} - {event.type}
                </p>
                {event.details && (
                  <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{JSON.stringify(event.details)}</p>
                )}
              </div>
            ))}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setHistoryContextId("")}>Close</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
