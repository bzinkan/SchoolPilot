import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import SupervisionSessionDialog from "../components/SupervisionSessionDialog";
import SupervisionGroupEditor from "../components/SupervisionGroupEditor";
import { refreshSupervisionSetup } from "../components/supervisionGroupQueries";
import SupervisionGroupDirectory from "../components/SupervisionGroupDirectory";
import { useMutation, useQuery } from "@tanstack/react-query";
import { ArrowLeft, Eye, History, Plus, RefreshCw, Search, UserCheck, Trash2 } from "lucide-react";
import { useNavigate, useSearchParams } from "react-router-dom";
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
import { Badge } from "../../../components/ui/badge";
import { useToast } from "../../../hooks/use-toast";
import { useClassPilotAuth } from "../../../hooks/useClassPilotAuth";
import { createSupervisionDashboardIntent, createObservedActivityDashboardIntent, createDashboardWorkspaceIntent } from "../lib/supervisionDashboardNavigation";
import { testingScheduleNavigation } from "../lib/testingSchedulePrefill";

const releaseReasons = [
  ["returned_to_class", "Returned to class"],
  ["released", "Released"],
  ["expired", "Expired"],
  ["reassigned", "Reassigned"],
];

function displayName(user) {
  return user?.displayName || user?.email || user?.user?.displayName || user?.user?.email || "Staff";
}

function formatTime(value, timeZone) {
  if (!value) return "Unknown";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Unknown";
  return date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit", ...(timeZone ? { timeZone } : {}) });
}

function purposeLabel(purpose) {
  return ({ claim: "Claim", testing: "Testing", coverage: "Coverage", class: "Class", supervision: "Supervision" })[purpose] || "Supervision";
}
function endLabel(context) {
  return ({ claim: "Release all", testing: "End testing", coverage: "End coverage" })[context?.purpose] || "End supervision";
}
function scheduledStateLabel(state) {
  return ({ scheduled: "Scheduled", active: "Running", ended: "Ended", cancelled: "Cancelled", unassigned: "Needs a supervisor", failed: "Failed to start", missed: "Missed", releasing: "Ending" })[state] || "Unavailable";
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

export default function Coverage() {
  const { currentUser, school } = useClassPilotAuth();
  return <CoverageWorkspace key={`${currentUser?.schoolId}:${currentUser?.id}`} currentUser={currentUser} timeZone={school?.timezone} />;
}

function CoverageWorkspace({ currentUser, timeZone }) {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
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

  const activeTab = searchParams.get("tab") || "live";
  const [historyContextId, setHistoryContextId] = useState("");
  const [boundaryTime, setBoundaryTime] = useState(() => Date.now());
  const [sessionDialog, setSessionDialog] = useState(null);
  const [assignmentOpen, setAssignmentOpen] = useState(false);
  const [releaseDialog, setReleaseDialog] = useState(null);
  const [releaseReason, setReleaseReason] = useState("returned_to_class");
  const [studentPickerSearch, setStudentPickerSearch] = useState("");
  const [assignmentStaffSearch, setAssignmentStaffSearch] = useState("");
  const [scopeGroupOpen, setScopeGroupOpen] = useState(false);
  const [scopeGroupId, setScopeGroupId] = useState(null);
  const operationalBusy = useRef(false);
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
  const contextsQuery = useQuery({
    queryKey: ["/api/coverage/contexts", schoolId, currentUser?.id],
    queryFn: ({ signal }) => apiRequest("GET", "/coverage/contexts", undefined, { signal, headers: { "X-School-Id": schoolId } }),
    select: (data) => data?.contexts || [],
    enabled: !!schoolId && !!currentUser?.id,
    refetchInterval: 10000,
  });

  const capabilitiesQuery = useQuery({
    queryKey: ["/api/coverage/capabilities", schoolId, currentUser?.id],
    queryFn: ({ signal }) => apiRequest("GET", "/coverage/capabilities", undefined, { signal, headers: { "X-School-Id": schoolId } }),
    enabled: !!currentUser && !!schoolId,
  });
  const canManageSupervisionSetup = isAdmin || !!capabilitiesQuery.data?.canManageSupervisionSetup;
  const requestedTab = ({ contexts: "live", settings: "groups", "staff-access": "access" })[activeTab] || activeTab;
  const visibleTab = requestedTab === "access" && !isAdmin ? (canManageSupervisionSetup ? "groups" : "live")
    : requestedTab === "groups" && !canManageSupervisionSetup ? "live"
    : ["live", "scheduled", "groups", "access"].includes(requestedTab) ? requestedTab : "live";
  const setActiveTab = tab => setSearchParams(params => { params.set("tab", tab); return params; });
  useEffect(() => {
    if (!schoolId || !currentUser?.id) return;
    if (["console", "claimed", "unassigned", "available"].includes(activeTab)) navigate("/classpilot", { replace: true, state: createDashboardWorkspaceIntent({ schoolId, viewerId: currentUser?.id, view: ["unassigned", "available"].includes(activeTab) ? "available" : "claimed" }) });
  }, [activeTab, currentUser?.id, schoolId, navigate]);
  const observedQuery = useQuery({
    queryKey: ["/api/classpilot/observable-activities", schoolId, currentUser?.id],
    queryFn: ({ signal }) => apiRequest("GET", "/classpilot/observable-activities", undefined, { signal, headers: { "X-School-Id": schoolId } }),
    enabled: !!schoolId && !!isAdmin, refetchInterval: 10000,
  });
  const selectedDate = searchParams.get("date") || "";
  const scheduledQuery = useQuery({
    queryKey: ["/api/coverage/scheduled", schoolId, currentUser?.id, selectedDate],
    queryFn: ({ signal }) => apiRequest("GET", "/coverage/scheduled", undefined, { signal, headers: { "X-School-Id": schoolId }, params: selectedDate ? { date: selectedDate } : undefined }),
    enabled: !!schoolId && visibleTab === "scheduled", refetchInterval: 30000,
  });
  const canDelegateSetup = isAdmin;
  const canChooseSchoolwide = isAdmin || !!capabilitiesQuery.data?.isSchoolwideSetupManager;

  const staffQuery = useQuery({
    queryKey: [isAdmin ? "/api/admin/users" : "/api/coverage/setup/staff", schoolId, currentUser?.id],
    queryFn: ({ signal }) => apiRequest("GET", isAdmin ? "/admin/users" : "/coverage/setup/staff", undefined, { signal, headers: { "X-School-Id": schoolId } }),
    select: (data) => data?.users || [],
    enabled: canManageSupervisionSetup && assignmentOpen,
  });

  const groupsQuery = useQuery({
    queryKey: ["/api/coverage/setup/classes", schoolId, currentUser?.id],
    queryFn: ({ signal }) => apiRequest("GET", "/coverage/setup/classes", undefined, { signal, headers: { "X-School-Id": schoolId } }),
    select: (data) => data?.groups || [],
    enabled: canManageSupervisionSetup && assignmentOpen,
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
    enabled: canManageSupervisionSetup && !!schoolId && assignmentOpen,
  });

  const adminStudentsQuery = useQuery({
    queryKey: [isAdmin ? "/api/admin/teacher-students" : "/api/coverage/setup/students", schoolId, currentUser?.id],
    queryFn: ({ signal }) => apiRequest("GET", isAdmin ? "/admin/teacher-students" : "/coverage/setup/students", undefined, { signal, headers: { "X-School-Id": schoolId } }),
    select: (data) => data?.students || [],
    enabled: canManageSupervisionSetup && assignmentOpen,
  });

  const contexts = useMemo(() => (contextsQuery.data || []).filter(context => context.status === "active"
    && Number(context.activeStudentCount) > 0 && Date.parse(context.startsAt) <= contextsQuery.dataUpdatedAt
    && Date.parse(context.endsAt) > Math.max(contextsQuery.dataUpdatedAt, boundaryTime)), [contextsQuery.data, contextsQuery.dataUpdatedAt, boundaryTime]);
  const refreshContexts = contextsQuery.refetch;
  useEffect(() => {
    if (!contexts.length) return;
    const deadline = Math.min(...contexts.map(context => Date.parse(context.endsAt)));
    const timer = setTimeout(() => {
      // Known expiry removes the session even when a later network read fails.
      // A future session still needs a fresh server read before it can appear.
      setBoundaryTime(Date.now());
      void refreshContexts();
    }, Math.min(2_147_483_647, Math.max(0, deadline - Date.now())));
    return () => clearTimeout(timer);
  }, [contexts, refreshContexts]);
  const observableActivities = useMemo(() => new Map((observedQuery.data?.activities || []).map(activity => [activity.id, activity])), [observedQuery.data]);
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
  const historyQuery = useQuery({
    queryKey: ["/api/coverage/contexts", schoolId, currentUser?.id, historyContextId, "history"],
    queryFn: ({ signal }) => apiRequest("GET", `/coverage/contexts/${historyContextId}/history`, undefined, { signal, headers: { "X-School-Id": schoolId } }),
    select: (data) => data?.events || [],
    enabled: !!historyContextId,
  });

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
    queryClient.invalidateQueries({ queryKey: ["/api/coverage/scheduled"] });
    queryClient.invalidateQueries({ queryKey: ["/api/classpilot/observable-activities"] });
    queryClient.invalidateQueries({ queryKey: ["/api/coverage/unassigned"] });
    queryClient.invalidateQueries({ queryKey: ["/api/coverage/available-students"] });
    queryClient.invalidateQueries({ queryKey: ["/api/coverage/claimed-students"] });
    queryClient.invalidateQueries({ queryKey: ["/api/coverage/supervision-groups"] });
    queryClient.invalidateQueries({ queryKey: ["/api/coverage/contexts"] });
    queryClient.invalidateQueries({ queryKey: ["/api/students-aggregated"] });
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

  const releaseMutation = useMutation({
    retry: false,
    mutationFn: ({ contextId, studentIds, reason, mode, scope, contextAuthorityRevision, expectedStudentIds }) => {
      if (mode !== "all" && studentIds.length === 0) throw new Error("Select students before releasing them.");
      if (contextAuthorityRevision == null) throw new Error("Refresh this session before ending supervision.");
      return apiRequest("POST", `/coverage/contexts/${contextId}/release`, { studentIds, releaseReason: reason, expectedStudentIds }, {
        headers: { "X-School-Id": scope.schoolId, "X-ClassPilot-Context-Authority-Revision": String(contextAuthorityRevision) },
      });
    },
    onSuccess: (_data, { scope }) => {
      if (committedSetupScope.current !== scope) return;
      invalidateCoverage();
      setReleaseDialog(null);
      setReleaseReason("returned_to_class");
      toast({ title: "Students released" });
    },
    onError: (error, { scope }) => { if (committedSetupScope.current === scope) toast({ variant: "destructive", title: "Could not release coverage", description: error.message }); },
    onSettled: () => { operationalBusy.current = false; },
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

  const openReleaseDialog = context => {
    if (operationalBusy.current || context.assignedStaffId !== currentUser?.id) return;
    const expectedStudentIds = [...new Set((context.students || []).map(student => student.studentId).filter(Boolean))].sort();
    if (!expectedStudentIds.length || expectedStudentIds.length !== context.activeStudentCount) {
      toast({ variant: "destructive", title: "Student list unavailable", description: "Refresh this session before ending supervision." });
      return;
    }
    setReleaseReason("returned_to_class");
    setReleaseDialog({ contextId: context.id, title: `${endLabel(context)}: ${context.name}`, context, expectedStudentIds, scope: setupScope });
  };
  const submitRelease = () => {
    if (operationalBusy.current || !releaseDialog?.contextId || releaseDialog.scope !== committedSetupScope.current) return;
    const current = contexts.find(context => context.id === releaseDialog.contextId);
    const revision = releaseDialog.context.classroomAuthorityRevision ?? releaseDialog.context.contextAuthorityRevision;
    const currentIds = [...new Set((current?.students || []).map(student => student.studentId).filter(Boolean))].sort();
    if (!current || revision == null || current.assignedStaffId !== currentUser?.id || String(current.classroomAuthorityRevision ?? current.contextAuthorityRevision) !== String(revision)
      || JSON.stringify(currentIds) !== JSON.stringify(releaseDialog.expectedStudentIds)) {
      toast({ variant: "destructive", title: "Supervision changed", description: "Close this confirmation and review the current session again." }); return;
    }
    operationalBusy.current = true;
    releaseMutation.mutate({ scope: releaseDialog.scope, mode: "all", contextId: current.id, studentIds: [], reason: releaseReason, contextAuthorityRevision: revision, expectedStudentIds: releaseDialog.expectedStudentIds });
  };
  const openDashboard = (context, observe = false) => navigate("/classpilot", {
    state: observe ? createObservedActivityDashboardIntent({ schoolId, viewerId: currentUser.id, activity: observableActivities.get(context.id) })
      : createSupervisionDashboardIntent({ schoolId, viewerId: currentUser.id, contexts: [context] }),
  });
  const scheduleTesting = group => {
    const target = testingScheduleNavigation({ schoolId, actorId: currentUser.id, groupId: group.id });
    if (target) navigate(target.pathname, { state: target.state });
  };
  const sessionComplete = result => {
    const action = sessionDialog?.action;
    setSessionDialog(null);
    invalidateCoverage();
    if (action === "start" && result?.context?.assignedStaffId === currentUser.id) openDashboard(result.context);
  };

  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="border-b bg-card">
        <div className="max-w-screen-2xl mx-auto px-6 py-4 flex flex-wrap items-center justify-between gap-4">
          <div className="flex min-w-0 flex-1 items-center gap-3">
            <Button variant="ghost" size="icon" aria-label="Back to dashboard" onClick={() => navigate("/classpilot")}>
              <ArrowLeft className="h-4 w-4" />
            </Button>
            <div className="min-w-0">
              <h1 className="text-xl font-semibold">Supervision</h1>
              <p className="text-sm text-muted-foreground">Saved rosters, staff access, and supervision happening now</p>
            </div>
          </div>
          <Button variant="outline" onClick={refreshCoverage}>
            <RefreshCw className="h-4 w-4 mr-2" />
            Refresh
          </Button>
        </div>
      </header>

      <main className="max-w-screen-2xl mx-auto px-6 py-6">
        <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
          <p className="max-w-2xl text-sm text-muted-foreground">Saved groups keep a roster for later. Students are supervised only during a started session or scheduled activity.</p>
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" onClick={() => navigate("/classpilot", { state: createDashboardWorkspaceIntent({ schoolId, viewerId: currentUser.id, view: "available" }) })}>Available students</Button>
            <Button variant="outline" onClick={() => navigate("/classpilot", { state: createDashboardWorkspaceIntent({ schoolId, viewerId: currentUser.id, view: "claimed" }) })}>Claimed students</Button>
          </div>
        </div>
        <Tabs value={visibleTab} onValueChange={setActiveTab}>
          <TabsList className="h-auto max-w-full flex-wrap justify-start gap-1">
            <TabsTrigger value="live">Live now</TabsTrigger>
            <TabsTrigger value="scheduled">Scheduled</TabsTrigger>
            {canManageSupervisionSetup && <TabsTrigger ref={setupHeading} value="groups">Saved groups</TabsTrigger>}
            {isAdmin && <TabsTrigger ref={staffAccessHeading} value="access">Staff access</TabsTrigger>}
          </TabsList>

          <TabsContent value="live" className="space-y-4 mt-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="text-sm text-muted-foreground">{isAdmin ? "Current supervision across the school. Observe keeps the current supervisor in control." : "Your current supervision sessions. Open a session to see its student previews and controls."}</p>
              <Button onClick={() => setSessionDialog({ action: "start" })}><Plus className="h-4 w-4 mr-2" />Start session</Button>
            </div>
            {contextsQuery.isError && <p role="alert" className="rounded-md border p-3 text-sm text-destructive">Live supervision could not load. Use Refresh to try again.</p>}
            {observedQuery.isError && <p role="alert" className="text-sm text-destructive">Observe is unavailable. Refresh to load current viewing permissions.</p>}
            <div className="divide-y rounded-md border">
              {contexts.length === 0 ? <p role="status" className="px-4 py-10 text-center text-sm text-muted-foreground">{contextsQuery.isPending ? "Loading live supervision…" : contextsQuery.isError ? "Live supervision is unavailable." : "No supervision is running. Claim available students from the dashboard or start a session."}</p> : contexts.map(context => {
                const owns = context.assignedStaffId === currentUser.id;
                const canObserve = isAdmin && observableActivities.has(context.id) && !observedQuery.isError;
                const scheduled = context.scheduleProfileApplicationId || context.scheduleProfileDate || context.scheduleProfileBlockId || context.scheduledConflictId;
                return <div key={context.id} data-testid={`live-session-${context.id}`} className="flex flex-col justify-between gap-3 p-4 sm:flex-row sm:items-center">
                  <div className="min-w-0 space-y-1">
                    <div className="flex flex-wrap items-center gap-2"><h2 className="break-words font-medium">{context.name}</h2><Badge variant="secondary">{purposeLabel(context.purpose)}</Badge></div>
                    <p className="text-sm text-muted-foreground">Supervisor: {context.assignedStaff?.displayName || "Staff"}</p>
                    <p className="text-sm text-muted-foreground">{context.activeStudentCount} student{context.activeStudentCount === 1 ? "" : "s"} · Ends {formatTime(context.endsAt, timeZone)}</p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {owns && <Button size="sm" onClick={() => openDashboard(context)}>Open</Button>}
                    {!owns && canObserve && <Button size="sm" variant="outline" onClick={() => openDashboard(context, true)}><Eye className="mr-2 h-4 w-4" />Observe</Button>}
                    {owns && <Button size="sm" variant="outline" disabled={releaseMutation.isPending} onClick={() => openReleaseDialog(context)}>{endLabel(context)}</Button>}
                    {owns && !scheduled && <Button size="sm" variant="outline" onClick={() => setSessionDialog({ action: "end_time", context })}>Change end time</Button>}
                    {owns && <Button size="sm" variant="ghost" onClick={() => setHistoryContextId(context.id)}><History className="h-4 w-4 mr-2" />History</Button>}
                  </div>
                </div>;
              })}
            </div>
          </TabsContent>
          <TabsContent value="scheduled" className="space-y-4 mt-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="text-sm text-muted-foreground">Applied testing and scheduled coverage. Times use {scheduledQuery.data?.timeZone || "the school timezone"}.</p>
              <label className="flex items-center gap-2 text-sm">Date<Input aria-label="Scheduled date" className="w-auto" type="date" value={selectedDate || scheduledQuery.data?.date || ""} onChange={event => setSearchParams(params => { event.target.value ? params.set("date", event.target.value) : params.delete("date"); return params; })} /></label>
            </div>
            {scheduledQuery.isError ? <p role="alert" className="rounded-md border p-4 text-sm text-destructive">Scheduled activities could not load. Use Refresh to try again.</p> : <div className="divide-y rounded-md border">
              {(scheduledQuery.data?.items || []).length === 0 ? <p role="status" className="px-4 py-10 text-center text-sm text-muted-foreground">{scheduledQuery.isPending ? "Loading scheduled activities…" : "No applied testing or scheduled coverage for this date. Saved groups do not create scheduled activities."}</p> : scheduledQuery.data.items.map(item => <div key={item.id} className="flex flex-wrap items-center justify-between gap-3 p-4">
                <div className="space-y-1"><h2 className="font-medium">{item.name}</h2><p className="text-sm text-muted-foreground">{purposeLabel(item.purpose)} · {formatTime(item.startsAt, scheduledQuery.data.timeZone)}–{formatTime(item.endsAt, scheduledQuery.data.timeZone)}</p><p className="text-sm text-muted-foreground">Supervisor: {item.assignedStaff?.name || "Not assigned"}</p></div>
                <Badge variant="outline">{scheduledStateLabel(item.state)}</Badge>
              </div>)}
            </div>}
          </TabsContent>

          {canManageSupervisionSetup && <TabsContent value="groups" forceMount hidden={visibleTab !== "groups"} inert={visibleTab !== "groups" || undefined} className={`space-y-4 mt-4 ${visibleTab !== "groups" ? "hidden" : ""}`}><SupervisionGroupDirectory key={`${schoolId}:${currentUser?.id}:${currentUser?.role}:${isAdmin}`} schoolId={schoolId} active={visibleTab === "groups"} isAdmin={isAdmin} busy={setupWriteBusy} liveContexts={contexts} liveStatusKnown={contextsQuery.isSuccess && !contextsQuery.isError} onStart={group => setSessionDialog({ action: "start", group })} onSchedule={isAdmin ? scheduleTesting : undefined} onEdit={openScopeGroupDialog} savedGroupId={setupDeletionNotice?.scope === setupScope ? setupDeletionNotice.savedGroupId : null} notice={setupDeletionNotice?.scope === setupScope && setupDeletionNotice.kind === "group" ? setupDeletionNotice.message : ""} onDelete={(group, event) => openSetupDeletion({ kind: "group", id: group.id, name: group.name, updatedAt: group.updatedAt, studentCount: group.studentCount, staffCount: group.staff?.length || 0 }, event)} /></TabsContent>}

          {isAdmin && (
            <TabsContent value="access" className="space-y-4 mt-4">
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
                        <Badge className="w-fit self-start" variant={permissionPackage.active ? "default" : "outline"}>{permissionPackage.active ? "Enabled" : "Disabled"}</Badge>
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

      {sessionDialog && <SupervisionSessionDialog key={`${schoolId}:${currentUser.id}:${sessionDialog.group?.id || sessionDialog.context?.id || ""}`} open onOpenChange={open => { if (!open) setSessionDialog(null); }} {...sessionDialog} onSuccess={sessionComplete} />}

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

      <Dialog open={!!releaseDialog} onOpenChange={(open) => !open && !releaseMutation.isPending && setReleaseDialog(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{releaseDialog?.title || "Release Students"}</DialogTitle>
            <DialogDescription>This ends live supervision for all {releaseDialog?.context?.activeStudentCount || 0} students in this session. Students return to their current class when eligible, or Available. The saved roster and history remain.</DialogDescription>
          </DialogHeader>
          <ul aria-label="Students leaving supervision" className="max-h-48 list-disc overflow-y-auto pl-5 text-sm">
            {(releaseDialog?.context?.students || []).map(student => <li key={student.studentId}>{student.studentName || "Student"}</li>)}
          </ul>
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
            <Button variant="outline" disabled={releaseMutation.isPending} onClick={() => setReleaseDialog(null)}>Cancel</Button>
            <Button onClick={submitRelease} disabled={releaseMutation.isPending || !releaseReason}>{releaseMutation.isPending ? "Ending..." : endLabel(releaseDialog?.context)}</Button>
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
                  <span className="text-xs text-muted-foreground">{formatTime(event.createdAt, timeZone)}</span>
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
