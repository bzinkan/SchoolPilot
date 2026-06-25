import { useMemo, useState } from "react";
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
} from "lucide-react";
import { useNavigate } from "react-router-dom";
import { apiRequest, queryClient } from "../../../lib/queryClient";
import { Button } from "../../../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../../../components/ui/card";
import { Checkbox } from "../../../components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../../../components/ui/dialog";
import { Input } from "../../../components/ui/input";
import { Label } from "../../../components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../../components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../../../components/ui/tabs";
import { Textarea } from "../../../components/ui/textarea";
import { Badge } from "../../../components/ui/badge";
import { useToast } from "../../../hooks/use-toast";
import { useClassPilotAuth } from "../../../hooks/useClassPilotAuth";

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
const PICKER_PAGE_SIZE = 8;

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

function paginate(items, page, pageSize = PICKER_PAGE_SIZE) {
  const pageCount = Math.max(1, Math.ceil(items.length / pageSize));
  const currentPage = Math.min(Math.max(page, 1), pageCount);
  const start = (currentPage - 1) * pageSize;
  return {
    currentPage,
    pageCount,
    items: items.slice(start, start + pageSize),
  };
}

export default function Coverage() {
  const navigate = useNavigate();
  const { toast } = useToast();
  const { currentUser } = useClassPilotAuth();
  const isAdmin = currentUser?.isSuperAdmin || currentUser?.role === "admin" || currentUser?.role === "school_admin";

  const [selectedUnassignedIds, setSelectedUnassignedIds] = useState(new Set());
  const [selectedCoverageIds, setSelectedCoverageIds] = useState(new Set());
  const [activeTab, setActiveTab] = useState("console");
  const [search, setSearch] = useState("");
  const [coverageSearch, setCoverageSearch] = useState("");
  const [selectedContextId, setSelectedContextId] = useState("");
  const [historyContextId, setHistoryContextId] = useState("");
  const [contextOpen, setContextOpen] = useState(false);
  const [assignmentOpen, setAssignmentOpen] = useState(false);
  const [commandDialog, setCommandDialog] = useState(null);
  const [commandUrl, setCommandUrl] = useState("");
  const [commandMessage, setCommandMessage] = useState("");
  const [selectedFlightPathId, setSelectedFlightPathId] = useState("");
  const [selectedBlockListId, setSelectedBlockListId] = useState("");
  const [releaseDialog, setReleaseDialog] = useState(null);
  const [releaseReason, setReleaseReason] = useState("returned_to_class");
  const [studentPickerSearch, setStudentPickerSearch] = useState("");
  const [assignmentStaffSearch, setAssignmentStaffSearch] = useState("");
  const [scopeGroupOpen, setScopeGroupOpen] = useState(false);
  const [scopeGroupSearch, setScopeGroupSearch] = useState("");
  const [scopeGroupStaffSearch, setScopeGroupStaffSearch] = useState("");
  const [scopeGroupStaffPage, setScopeGroupStaffPage] = useState(1);
  const [scopeGroupStudentSearch, setScopeGroupStudentSearch] = useState("");
  const [scopeGroupStudentPage, setScopeGroupStudentPage] = useState(1);
  const [scopeGroupStudentGradeFilter, setScopeGroupStudentGradeFilter] = useState(ALL_FILTER);
  const [scopeGroupStudentClassFilter, setScopeGroupStudentClassFilter] = useState(ALL_FILTER);
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
  const [scopeGroupForm, setScopeGroupForm] = useState({
    id: "",
    name: "",
    description: "",
    studentIds: [],
    staffIds: [],
    active: true,
  });

  const unassignedQuery = useQuery({
    queryKey: ["/api/coverage/unassigned"],
    queryFn: () => apiRequest("GET", "/coverage/unassigned"),
    select: (data) => data?.students || [],
    refetchInterval: 10000,
  });

  const contextsQuery = useQuery({
    queryKey: ["/api/coverage/contexts"],
    queryFn: () => apiRequest("GET", "/coverage/contexts"),
    select: (data) => data?.contexts || [],
    refetchInterval: 10000,
  });

  const capabilitiesQuery = useQuery({
    queryKey: ["/api/coverage/capabilities"],
    queryFn: () => apiRequest("GET", "/coverage/capabilities"),
    enabled: !!currentUser,
  });
  const canManageSupervisionSetup = isAdmin || !!capabilitiesQuery.data?.canManageSupervisionSetup;
  const canDelegateSetup = isAdmin;
  const canChooseSchoolwide = isAdmin || !!capabilitiesQuery.data?.isSchoolwideSetupManager;

  const staffQuery = useQuery({
    queryKey: [isAdmin ? "/api/admin/users" : "/api/coverage/setup/staff"],
    queryFn: () => apiRequest("GET", isAdmin ? "/admin/users" : "/coverage/setup/staff"),
    select: (data) => data?.users || [],
    enabled: canManageSupervisionSetup,
  });

  const groupsQuery = useQuery({
    queryKey: ["/api/coverage/setup/classes"],
    queryFn: () => apiRequest("GET", "/coverage/setup/classes"),
    select: (data) => data?.groups || [],
    enabled: canManageSupervisionSetup,
  });

  const assignmentsQuery = useQuery({
    queryKey: ["/api/coverage/assignments"],
    queryFn: () => apiRequest("GET", "/coverage/assignments"),
    select: (data) => data?.assignments || [],
    enabled: isAdmin,
  });

  const scopeGroupsQuery = useQuery({
    queryKey: ["/api/coverage/supervision-groups"],
    queryFn: () => apiRequest("GET", "/coverage/supervision-groups"),
    select: (data) => data?.groups || [],
    enabled: canManageSupervisionSetup,
  });

  const adminStudentsQuery = useQuery({
    queryKey: [isAdmin ? "/api/admin/teacher-students" : "/api/coverage/setup/students"],
    queryFn: () => apiRequest("GET", isAdmin ? "/admin/teacher-students" : "/coverage/setup/students"),
    select: (data) => data?.students || [],
    enabled: canManageSupervisionSetup,
  });

  const scopeGroupClassStudentsQuery = useQuery({
    queryKey: ["/api/groups", scopeGroupStudentClassFilter, "students", "scope-group-picker"],
    queryFn: () => apiRequest("GET", `/groups/${scopeGroupStudentClassFilter}/students`),
    select: (data) => Array.isArray(data) ? data : data?.students || [],
    enabled: canManageSupervisionSetup && scopeGroupOpen && scopeGroupStudentClassFilter !== ALL_FILTER,
  });

  const flightPathsQuery = useQuery({
    queryKey: ["/api/flight-paths"],
    queryFn: () => apiRequest("GET", "/flight-paths"),
    select: (data) => Array.isArray(data) ? data : data?.flightPaths || [],
  });

  const blockListsQuery = useQuery({
    queryKey: ["/api/block-lists"],
    queryFn: () => apiRequest("GET", "/block-lists"),
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
  const filteredScopeGroupStaff = useMemo(() => {
    return (staffQuery.data || []).filter((staff) => {
      const searchText = [
        displayName(staff),
        staff.email,
        staff.user?.email,
        staff.role,
      ].filter(Boolean).join(" ");
      return matchesTokens(searchText, scopeGroupStaffSearch);
    });
  }, [scopeGroupStaffSearch, staffQuery.data]);
  const pagedScopeGroupStaff = useMemo(
    () => paginate(filteredScopeGroupStaff, scopeGroupStaffPage),
    [filteredScopeGroupStaff, scopeGroupStaffPage]
  );
  const scopeGroupClassStudentIds = useMemo(() => {
    if (scopeGroupStudentClassFilter === ALL_FILTER) return null;
    return new Set((scopeGroupClassStudentsQuery.data || []).map((student) => student.id));
  }, [scopeGroupClassStudentsQuery.data, scopeGroupStudentClassFilter]);
  const filteredScopeGroupStudents = useMemo(() => {
    return adminStudents.filter((student) => {
      const grade = normalizeScopeValue(student.gradeLevel);
      if (scopeGroupStudentGradeFilter !== ALL_FILTER && grade !== scopeGroupStudentGradeFilter) return false;
      if (scopeGroupClassStudentIds && !scopeGroupClassStudentIds.has(student.id)) return false;
      const searchText = [
        student.studentName,
        student.studentEmail,
        student.email,
        student.gradeLevel ? `grade ${student.gradeLevel}` : "",
      ].filter(Boolean).join(" ");
      return matchesTokens(searchText, scopeGroupStudentSearch);
    });
  }, [adminStudents, scopeGroupClassStudentIds, scopeGroupStudentGradeFilter, scopeGroupStudentSearch]);
  const pagedScopeGroupStudents = useMemo(
    () => paginate(filteredScopeGroupStudents, scopeGroupStudentPage),
    [filteredScopeGroupStudents, scopeGroupStudentPage]
  );
  const filteredPickerStudents = useMemo(() => {
    const q = studentPickerSearch.trim().toLowerCase();
    if (!q) return adminStudents;
    return adminStudents.filter((student) => {
      return `${student.studentName || ""} ${student.studentEmail || ""} ${student.gradeLevel || ""}`.toLowerCase().includes(q);
    });
  }, [adminStudents, studentPickerSearch]);
  const filteredScopeGroups = useMemo(() => {
    const q = scopeGroupSearch.trim().toLowerCase();
    return (scopeGroupsQuery.data || []).filter((group) => {
      if (!q) return true;
      return `${group.name || ""} ${group.description || ""}`.toLowerCase().includes(q);
    });
  }, [scopeGroupsQuery.data, scopeGroupSearch]);
  const manageableContexts = useMemo(
    () => contexts.filter((context) => context.canManage && context.status === "active"),
    [contexts]
  );
  const activeContextId = manageableContexts.some((context) => context.id === selectedContextId)
    ? selectedContextId
    : manageableContexts[0]?.id || "";
  const selectedContext = manageableContexts.find((context) => context.id === activeContextId) || null;

  const contextStudentsQuery = useQuery({
    queryKey: ["/api/coverage/contexts", selectedContext?.id, "students"],
    queryFn: () => apiRequest("GET", `/coverage/contexts/${selectedContext.id}/students`),
    select: (data) => data?.students || [],
    enabled: !!selectedContext?.id,
    refetchInterval: 10000,
  });

  const historyQuery = useQuery({
    queryKey: ["/api/coverage/contexts", historyContextId, "history"],
    queryFn: () => apiRequest("GET", `/coverage/contexts/${historyContextId}/history`),
    select: (data) => data?.events || [],
    enabled: !!historyContextId,
  });

  const unassignedStudents = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (unassignedQuery.data || []).filter((student) => {
      if (!q) return true;
      return `${student.studentName || ""} ${student.studentEmail || ""} ${student.gradeLevel || ""}`.toLowerCase().includes(q);
    });
  }, [unassignedQuery.data, search]);

  const coverageStudents = useMemo(() => {
    const q = coverageSearch.trim().toLowerCase();
    return (contextStudentsQuery.data || []).filter((student) => {
      if (!q) return true;
      return `${student.studentName || ""} ${student.studentEmail || ""} ${student.gradeLevel || ""}`.toLowerCase().includes(q);
    });
  }, [contextStudentsQuery.data, coverageSearch]);

  const activeCoverageStudents = useMemo(
    () => coverageStudents.filter((student) => !student.releasedAt),
    [coverageStudents]
  );
  const activeCoverageStudentIds = useMemo(
    () => new Set(activeCoverageStudents.map((student) => student.studentId)),
    [activeCoverageStudents]
  );
  const selectedCoverageStudentIds = useMemo(
    () => Array.from(selectedCoverageIds).filter((studentId) => activeCoverageStudentIds.has(studentId)),
    [activeCoverageStudentIds, selectedCoverageIds]
  );
  const commandTargetCount = selectedCoverageStudentIds.length || activeCoverageStudents.length;
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

  const createContextMutation = useMutation({
    mutationFn: (payload) => apiRequest("POST", "/coverage/contexts", payload),
    onSuccess: (data) => {
      invalidateCoverage();
      setSelectedUnassignedIds(new Set());
      setContextOpen(false);
      if (data?.context?.id) {
        setSelectedContextId(data.context.id);
        setSelectedCoverageIds(new Set());
      }
      setActiveTab("console");
      toast({ title: "Supervision started" });
    },
    onError: (error) => toast({ variant: "destructive", title: "Could not start coverage", description: error.message }),
  });

  const releaseMutation = useMutation({
    mutationFn: ({ contextId, studentIds, reason }) => apiRequest("POST", `/coverage/contexts/${contextId}/release`, {
      studentIds,
      releaseReason: reason,
    }),
    onSuccess: () => {
      invalidateCoverage();
      setSelectedCoverageIds(new Set());
      setReleaseDialog(null);
      setReleaseReason("returned_to_class");
      toast({ title: "Students released" });
    },
    onError: (error) => toast({ variant: "destructive", title: "Could not release coverage", description: error.message }),
  });

  const commandMutation = useMutation({
    mutationFn: ({ contextId, commandType, commandPayload }) => apiRequest("POST", `/coverage/contexts/${contextId}/commands`, {
      targetScope: selectedCoverageStudentIds.length > 0 ? "students" : "context",
      targetStudentIds: selectedCoverageStudentIds,
      commandType,
      commandPayload,
    }),
    onSuccess: (data) => {
      invalidateCoverage();
      setCommandDialog(null);
      setCommandUrl("");
      setCommandMessage("");
      toast({ title: "Command sent", description: data?.message });
    },
    onError: (error) => toast({ variant: "destructive", title: "Could not send command", description: error.message }),
  });

  const saveAssignmentMutation = useMutation({
    mutationFn: async ({ staffId, payloads }) => {
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
        if (match) updates.push(apiRequest("PATCH", `/coverage/assignments/${match.id}`, payload));
        else creates.push(apiRequest("POST", "/coverage/assignments", payload));
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
        .map((assignment) => apiRequest("PATCH", `/coverage/assignments/${assignment.id}`, { active: false }));

      const [updated, created, disabled] = await Promise.all([
        Promise.all(updates),
        Promise.all(creates),
        Promise.all(disables),
      ]);
      return { updated, created, disabled };
    },
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: ["/api/coverage/assignments"] });
      setAssignmentOpen(false);
      setStudentPickerSearch("");
      setAssignmentStaffSearch("");
      const count = variables?.payloads?.length || 1;
      toast({ title: count === 1 ? "Staff permission saved" : `${count} staff permissions saved` });
    },
    onError: (error) => toast({ variant: "destructive", title: "Could not save assignment", description: error.message }),
  });

  const deactivateAssignmentMutation = useMutation({
    mutationFn: (id) => apiRequest("PATCH", `/coverage/assignments/${id}`, { active: false }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["/api/coverage/assignments"] }),
  });

  const saveScopeGroupMutation = useMutation({
    mutationFn: async ({ id, payload }) => {
      if (!id) {
        return apiRequest("POST", "/coverage/supervision-groups", payload);
      }
      const updated = await apiRequest("PATCH", `/coverage/supervision-groups/${id}`, {
        name: payload.name,
        description: payload.description,
        active: payload.active,
      });
      await apiRequest("PUT", `/coverage/supervision-groups/${id}/students`, { studentIds: payload.studentIds });
      await apiRequest("PUT", `/coverage/supervision-groups/${id}/staff`, { staffIds: payload.staffIds });
      return updated;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/coverage/supervision-groups"] });
      queryClient.invalidateQueries({ queryKey: ["/api/coverage/assignments"] });
      setScopeGroupOpen(false);
      setScopeGroupSearch("");
      setScopeGroupStaffSearch("");
      setScopeGroupStaffPage(1);
      setScopeGroupStudentSearch("");
      setScopeGroupStudentPage(1);
      setScopeGroupStudentGradeFilter(ALL_FILTER);
      setScopeGroupStudentClassFilter(ALL_FILTER);
      toast({ title: "Supervision group saved" });
    },
    onError: (error) => toast({ variant: "destructive", title: "Could not save supervision group", description: error.message }),
  });

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

  const resetScopeGroupForm = () => {
    setScopeGroupForm({ id: "", name: "", description: "", studentIds: [], staffIds: [], active: true });
    setScopeGroupStaffSearch("");
    setScopeGroupStaffPage(1);
    setScopeGroupStudentSearch("");
    setScopeGroupStudentPage(1);
    setScopeGroupStudentGradeFilter(ALL_FILTER);
    setScopeGroupStudentClassFilter(ALL_FILTER);
  };

  const openScopeGroupDialog = (group = null) => {
    if (!group) {
      resetScopeGroupForm();
      setScopeGroupOpen(true);
      return;
    }
    setScopeGroupForm({
      id: group.id,
      name: group.name || "",
      description: group.description || "",
      studentIds: (group.students || []).map((student) => student.studentId),
      staffIds: (group.staff || []).map((staff) => staff.id),
      active: group.active !== false,
    });
    setScopeGroupStaffSearch("");
    setScopeGroupStaffPage(1);
    setScopeGroupStudentSearch("");
    setScopeGroupStudentPage(1);
    setScopeGroupStudentGradeFilter(ALL_FILTER);
    setScopeGroupStudentClassFilter(ALL_FILTER);
    setScopeGroupOpen(true);
  };

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

  const toggleScopeGroupStudent = (studentId) => {
    setScopeGroupForm((prev) => {
      const selected = new Set(prev.studentIds);
      if (selected.has(studentId)) selected.delete(studentId);
      else selected.add(studentId);
      return { ...prev, studentIds: Array.from(selected) };
    });
  };

  const toggleScopeGroupStaff = (staffId) => {
    setScopeGroupForm((prev) => {
      const selected = new Set(prev.staffIds);
      if (selected.has(staffId)) selected.delete(staffId);
      else selected.add(staffId);
      return { ...prev, staffIds: Array.from(selected) };
    });
  };

  const submitContext = () => {
    createContextMutation.mutate({
      ...contextForm,
      assignedStaffId: contextForm.assignedStaffId || currentUser?.id,
      studentIds: Array.from(selectedUnassignedIds),
      endsAt: new Date(contextForm.endsAt).toISOString(),
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
    saveAssignmentMutation.mutate({ staffId: assignmentForm.staffId, payloads });
  };

  const submitScopeGroup = () => {
    saveScopeGroupMutation.mutate({
      id: scopeGroupForm.id,
      payload: {
        name: scopeGroupForm.name.trim(),
        description: scopeGroupForm.description.trim(),
        studentIds: scopeGroupForm.studentIds,
        staffIds: scopeGroupForm.staffIds,
        active: scopeGroupForm.active,
      },
    });
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
    commandMutation.mutate({ contextId: selectedContext.id, commandType, commandPayload });
  };

  const openReleaseDialog = ({ contextId, studentIds, title }) => {
    setReleaseReason("returned_to_class");
    setReleaseDialog({ contextId, studentIds, title });
  };

  const submitRelease = () => {
    if (!releaseDialog?.contextId || !releaseReason) return;
    releaseMutation.mutate({
      contextId: releaseDialog.contextId,
      studentIds: releaseDialog.studentIds,
      reason: releaseReason,
    });
  };

  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="border-b bg-card">
        <div className="max-w-screen-2xl mx-auto px-6 py-4 flex items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <Button variant="ghost" size="icon" onClick={() => navigate("/classpilot")}>
              <ArrowLeft className="h-4 w-4" />
            </Button>
            <div>
              <h1 className="text-xl font-semibold">Supervision</h1>
              <p className="text-sm text-muted-foreground">Pick up online students and manage flexible supervision groups</p>
            </div>
          </div>
          <Button variant="outline" onClick={invalidateCoverage}>
            <RefreshCw className="h-4 w-4 mr-2" />
            Refresh
          </Button>
        </div>
      </header>

      <main className="max-w-screen-2xl mx-auto px-6 py-6">
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
            <CardContent><p className="text-3xl font-semibold">{contexts.filter((c) => c.status === "active").length}</p></CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm flex items-center gap-2"><Shield className="h-4 w-4" />Assigned Staff</CardTitle>
            </CardHeader>
            <CardContent><p className="text-3xl font-semibold">{assignmentsQuery.data?.filter((a) => a.active).length || 0}</p></CardContent>
          </Card>
        </div>

        <Tabs value={activeTab} onValueChange={setActiveTab}>
          <TabsList>
            <TabsTrigger value="console">Claimed</TabsTrigger>
            <TabsTrigger value="unassigned">Available</TabsTrigger>
            <TabsTrigger value="contexts">Active Supervision</TabsTrigger>
            {canManageSupervisionSetup && <TabsTrigger value="settings">Supervision Groups</TabsTrigger>}
          </TabsList>

          <TabsContent value="console" className="space-y-4 mt-4">
            {manageableContexts.length === 0 ? (
              <div className="rounded-md border px-4 py-12 text-center text-sm text-muted-foreground">
                No students are claimed by you yet.
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
                      <Badge variant="secondary">{selectedCoverageStudentIds.length || activeCoverageStudents.length} targeted</Badge>
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
                    <Button size="sm" variant="outline" onClick={() => sendCoverageCommand("lock-screen", { url: "CURRENT_URL" })} disabled={commandTargetCount === 0 || commandMutation.isPending}>
                      <Lock className="h-4 w-4 mr-2" />
                      Lock
                    </Button>
                    <Button size="sm" variant="outline" onClick={() => sendCoverageCommand("unlock-screen", {})} disabled={commandTargetCount === 0 || commandMutation.isPending}>
                      <Unlock className="h-4 w-4 mr-2" />
                      Unlock
                    </Button>
                    <Button size="sm" variant="outline" onClick={() => setCommandDialog("teacher-message")} disabled={commandTargetCount === 0}>
                      <MessageSquare className="h-4 w-4 mr-2" />
                      Message
                    </Button>
                    <Button size="sm" variant="outline" onClick={() => setCommandDialog("apply-flight-path")} disabled={commandTargetCount === 0}>
                      <LinkIcon className="h-4 w-4 mr-2" />
                      Flight Path
                    </Button>
                    <Button size="sm" variant="outline" onClick={() => setCommandDialog("apply-block-list")} disabled={commandTargetCount === 0}>
                      <ShieldBan className="h-4 w-4 mr-2" />
                      Block List
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={selectedCoverageStudentIds.length === 0}
                      onClick={() => openReleaseDialog({
                        contextId: selectedContext.id,
                        studentIds: selectedCoverageStudentIds,
                        title: `Release ${selectedCoverageStudentIds.length} selected student${selectedCoverageStudentIds.length === 1 ? "" : "s"}`,
                      })}
                    >
                      Release Selected
                    </Button>
                  </div>

                  <div className="flex items-center gap-3 px-4 py-3">
                    <div className="relative w-full max-w-sm">
                      <Search className="h-4 w-4 absolute left-3 top-3 text-muted-foreground" />
                      <Input className="pl-9" placeholder="Search claimed students" value={coverageSearch} onChange={(e) => setCoverageSearch(e.target.value)} />
                    </div>
                    <Button variant="outline" size="sm" onClick={() => setSelectedCoverageIds(new Set(activeCoverageStudents.map((student) => student.studentId)))} disabled={activeCoverageStudents.length === 0}>
                      Select All
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => setSelectedCoverageIds(new Set())} disabled={selectedCoverageStudentIds.length === 0}>
                      Clear
                    </Button>
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
                      <div className="px-4 py-10 text-center text-sm text-muted-foreground">No students claimed in this group</div>
                    ) : coverageStudents.map((student) => (
                      <div key={student.studentId} className="grid min-w-[860px] grid-cols-[44px_1.1fr_90px_110px_1.4fr_130px_120px] gap-3 border-t px-4 py-3 text-sm items-center">
                        <Checkbox checked={selectedCoverageIds.has(student.studentId)} onCheckedChange={() => toggleCoverageStudent(student.studentId)} disabled={!!student.releasedAt} />
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
                          disabled={!!student.releasedAt}
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
            <div className="flex items-center justify-between gap-3 flex-wrap">
              <div className="relative w-full max-w-sm">
                <Search className="h-4 w-4 absolute left-3 top-3 text-muted-foreground" />
                <Input className="pl-9" placeholder="Search students" value={search} onChange={(e) => setSearch(e.target.value)} />
              </div>
              <Button onClick={() => setContextOpen(true)} disabled={selectedUnassignedIds.size === 0 && !isAdmin}>
                <Plus className="h-4 w-4 mr-2" />
                Start Supervision
              </Button>
            </div>
            <div className="rounded-md border overflow-hidden">
              <div className="grid grid-cols-[44px_1fr_120px_120px_1.5fr] gap-3 px-4 py-3 text-xs font-medium text-muted-foreground bg-muted/50">
                <span />
                <span>Student</span>
                <span>Grade</span>
                <span>Status</span>
                <span>Active Tab</span>
              </div>
              {unassignedStudents.length === 0 ? (
                <div className="px-4 py-10 text-center text-sm text-muted-foreground">No online unassigned students visible to you</div>
              ) : unassignedStudents.map((student) => (
                <div key={student.studentId} className="grid grid-cols-[44px_1fr_120px_120px_1.5fr] gap-3 px-4 py-3 border-t items-center text-sm">
                  <Checkbox checked={selectedUnassignedIds.has(student.studentId)} onCheckedChange={() => toggleUnassignedStudent(student.studentId)} />
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
                            onClick={() => openReleaseDialog({ contextId: context.id, studentIds: [], title: `Release all students from ${context.name}` })}
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

          {canManageSupervisionSetup && (
            <TabsContent value="settings" className="space-y-4 mt-4">
              <div className={isAdmin ? "grid gap-4 xl:grid-cols-[1.2fr_1fr]" : "grid gap-4"}>
                {isAdmin && (
                  <Card>
                    <CardHeader className="flex flex-row items-start justify-between gap-4">
                      <div>
                        <CardTitle className="text-base">Staff Permissions</CardTitle>
                        <CardDescription>Give staff pickup access or setup access within selected scopes.</CardDescription>
                      </div>
                      <Button onClick={() => openAssignmentDialog()}>
                        <UserCheck className="h-4 w-4 mr-2" />
                        Give Staff Access
                      </Button>
                    </CardHeader>
                    <CardContent>
                      <div className="rounded-md border overflow-hidden">
                        {permissionPackages.length === 0 ? (
                          <div className="px-4 py-10 text-center text-sm text-muted-foreground">No staff permissions yet</div>
                        ) : permissionPackages.map((permissionPackage) => (
                          <div key={permissionPackage.staffId} className="grid gap-3 border-t first:border-t-0 px-4 py-3 text-sm md:grid-cols-[1.1fr_1.5fr_120px_170px] md:items-center">
                            <div>
                              <p className="font-medium">{permissionPackage.staff?.displayName || staffQuery.data?.find((s) => s.userId === permissionPackage.staffId)?.user?.email || permissionPackage.staffId}</p>
                              <p className="text-xs text-muted-foreground">{permissionPackage.staff?.email || `${permissionPackage.assignments.length} permission${permissionPackage.assignments.length === 1 ? "" : "s"}`}</p>
                            </div>
                            <div className="flex flex-wrap gap-2">
                              {permissionPackage.claim && <Badge variant="outline">Claim + Manage</Badge>}
                              {permissionPackage.setup && <Badge variant="outline">Setup</Badge>}
                              {permissionPackage.scopeLabels.slice(0, 5).map((label) => (
                                <Badge variant="secondary" key={label}>{label}</Badge>
                              ))}
                              {permissionPackage.scopeLabels.length > 5 && (
                                <Badge variant="secondary">+{permissionPackage.scopeLabels.length - 5} more</Badge>
                              )}
                            </div>
                            <Badge variant={permissionPackage.active ? "default" : "outline"}>{permissionPackage.active ? "Active" : "Disabled"}</Badge>
                            <div className="flex justify-start gap-2 md:justify-end">
                              <Button variant="outline" size="sm" onClick={() => openAssignmentDialog(permissionPackage)}>
                                Edit
                              </Button>
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => permissionPackage.assignments.forEach((assignment) => {
                                  if (!assignmentHasSetup(assignment) || canDelegateSetup) deactivateAssignmentMutation.mutate(assignment.id);
                                })}
                                disabled={!permissionPackage.active || deactivateAssignmentMutation.isPending}
                              >
                                Disable
                              </Button>
                            </div>
                          </div>
                        ))}
                      </div>
                    </CardContent>
                  </Card>
                )}

                <Card>
                  <CardHeader className="flex flex-row items-start justify-between gap-4">
                    <div>
                      <CardTitle className="text-base">Supervision Groups</CardTitle>
                      <CardDescription>Reusable groups for testing, library, office, makeup work, and events.</CardDescription>
                    </div>
                    <Button variant="outline" onClick={() => openScopeGroupDialog()}>
                      <Plus className="h-4 w-4 mr-2" />
                      New Group
                    </Button>
                  </CardHeader>
                  <CardContent className="space-y-3">
                    <div className="relative">
                      <Search className="h-4 w-4 absolute left-3 top-3 text-muted-foreground" />
                      <Input className="pl-9" placeholder="Search supervision groups" value={scopeGroupSearch} onChange={(e) => setScopeGroupSearch(e.target.value)} />
                    </div>
                    <div className="rounded-md border overflow-hidden">
                      {filteredScopeGroups.length === 0 ? (
                        <div className="px-4 py-10 text-center text-sm text-muted-foreground">No supervision groups</div>
                      ) : filteredScopeGroups.map((group) => (
                        <div key={group.id} className="flex items-center justify-between gap-3 border-t first:border-t-0 px-4 py-3 text-sm">
                          <div>
                            <p className="font-medium">{group.name}</p>
                            <p className="text-xs text-muted-foreground">
                              {group.studentCount} student{group.studentCount === 1 ? "" : "s"} · {(group.staff || []).length} staff{(group.staff || []).length === 1 ? "" : ""}{group.description ? ` - ${group.description}` : ""}
                            </p>
                          </div>
                          <div className="flex items-center gap-2">
                            <Badge variant={group.active ? "secondary" : "outline"}>{group.active ? "Active" : "Disabled"}</Badge>
                            <Button variant="outline" size="sm" onClick={() => openScopeGroupDialog(group)}>Edit</Button>
                          </div>
                        </div>
                      ))}
                    </div>
                  </CardContent>
                </Card>
              </div>
            </TabsContent>
          )}
        </Tabs>
      </main>

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

      <Dialog open={assignmentOpen} onOpenChange={setAssignmentOpen}>
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

      <Dialog open={scopeGroupOpen} onOpenChange={setScopeGroupOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>{scopeGroupForm.id ? "Edit Supervision Group" : "Create Supervision Group"}</DialogTitle>
            <DialogDescription>Supervision Groups do not change class rosters.</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="grid gap-2">
              <Label>Name</Label>
              <Input value={scopeGroupForm.name} onChange={(e) => setScopeGroupForm((f) => ({ ...f, name: e.target.value }))} placeholder="State testing - 8th grade" />
            </div>
            <div className="grid gap-2">
              <Label>Description</Label>
              <Textarea value={scopeGroupForm.description} onChange={(e) => setScopeGroupForm((f) => ({ ...f, description: e.target.value }))} placeholder="Optional note for admins" />
            </div>
            <div className="space-y-2">
              <div className="flex items-center justify-between gap-3">
                <Label>Staff</Label>
                <Badge variant="secondary">{scopeGroupForm.staffIds.length} selected</Badge>
              </div>
              <div className="relative">
                <Search className="h-4 w-4 absolute left-3 top-3 text-muted-foreground" />
                <Input
                  className="pl-9"
                  placeholder="Search staff by name, email, or role"
                  value={scopeGroupStaffSearch}
                  onChange={(e) => {
                    setScopeGroupStaffSearch(e.target.value);
                    setScopeGroupStaffPage(1);
                  }}
                />
              </div>
              <div className="rounded-md border overflow-hidden">
                {filteredScopeGroupStaff.length === 0 ? (
                  <div className="px-4 py-8 text-center text-sm text-muted-foreground">No staff found</div>
                ) : pagedScopeGroupStaff.items.map((staff) => (
                  <label key={staff.userId} className="flex cursor-pointer items-center gap-3 border-t first:border-t-0 px-4 py-2 text-sm">
                    <Checkbox checked={scopeGroupForm.staffIds.includes(staff.userId)} onCheckedChange={() => toggleScopeGroupStaff(staff.userId)} />
                    <span className="flex-1">
                      <span className="block font-medium">{displayName(staff)}</span>
                      <span className="block text-xs text-muted-foreground">{[staff.user?.email || staff.email, staff.role || "Staff"].filter(Boolean).join(" - ")}</span>
                    </span>
                  </label>
                ))}
                {filteredScopeGroupStaff.length > 0 && (
                  <div className="flex items-center justify-between gap-3 border-t px-3 py-2 text-xs text-muted-foreground">
                    <span>
                      Showing {(pagedScopeGroupStaff.currentPage - 1) * PICKER_PAGE_SIZE + 1}-{Math.min(pagedScopeGroupStaff.currentPage * PICKER_PAGE_SIZE, filteredScopeGroupStaff.length)} of {filteredScopeGroupStaff.length}
                    </span>
                    <div className="flex items-center gap-2">
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => setScopeGroupStaffPage((page) => Math.max(1, page - 1))}
                        disabled={pagedScopeGroupStaff.currentPage <= 1}
                      >
                        Previous
                      </Button>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => setScopeGroupStaffPage((page) => Math.min(pagedScopeGroupStaff.pageCount, page + 1))}
                        disabled={pagedScopeGroupStaff.currentPage >= pagedScopeGroupStaff.pageCount}
                      >
                        Next
                      </Button>
                    </div>
                  </div>
                )}
              </div>
            </div>
            <div className="space-y-2">
              <div className="flex items-center justify-between gap-3">
                <Label>Students</Label>
                <Badge variant="secondary">{scopeGroupForm.studentIds.length} selected</Badge>
              </div>
              <div className="grid gap-2 md:grid-cols-2">
                <div className="grid gap-1">
                  <Label className="text-xs text-muted-foreground">Roster grade</Label>
                  <Select
                    value={scopeGroupStudentGradeFilter}
                    onValueChange={(value) => {
                      setScopeGroupStudentGradeFilter(value);
                      setScopeGroupStudentPage(1);
                    }}
                  >
                    <SelectTrigger><SelectValue placeholder="All grades" /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value={ALL_FILTER}>All grades</SelectItem>
                      {rosterGrades.map((grade) => (
                        <SelectItem key={grade.value} value={grade.value}>Grade {grade.value} ({grade.count})</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="grid gap-1">
                  <Label className="text-xs text-muted-foreground">Class Management class</Label>
                  <Select
                    value={scopeGroupStudentClassFilter}
                    onValueChange={(value) => {
                      setScopeGroupStudentClassFilter(value);
                      setScopeGroupStudentPage(1);
                    }}
                  >
                    <SelectTrigger><SelectValue placeholder="All classes" /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value={ALL_FILTER}>All classes</SelectItem>
                      {classManagementGroups.map((group) => (
                        <SelectItem key={group.id} value={group.id}>
                          {[group.name, group.gradeLevel ? `Grade ${group.gradeLevel}` : null].filter(Boolean).join(" - ")}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <div className="relative">
                <Search className="h-4 w-4 absolute left-3 top-3 text-muted-foreground" />
                <Input
                  className="pl-9"
                  placeholder="Search students by name or email"
                  value={scopeGroupStudentSearch}
                  onChange={(e) => {
                    setScopeGroupStudentSearch(e.target.value);
                    setScopeGroupStudentPage(1);
                  }}
                />
              </div>
              <div className="rounded-md border overflow-hidden">
                {scopeGroupClassStudentsQuery.isFetching && scopeGroupStudentClassFilter !== ALL_FILTER ? (
                  <div className="px-4 py-8 text-center text-sm text-muted-foreground">Loading class roster...</div>
                ) : filteredScopeGroupStudents.length === 0 ? (
                  <div className="px-4 py-8 text-center text-sm text-muted-foreground">No students match these filters</div>
                ) : pagedScopeGroupStudents.items.map((student) => (
                  <label key={student.id} className="flex cursor-pointer items-center gap-3 border-t first:border-t-0 px-4 py-2 text-sm">
                    <Checkbox checked={scopeGroupForm.studentIds.includes(student.id)} onCheckedChange={() => toggleScopeGroupStudent(student.id)} />
                    <span className="flex-1">
                      <span className="block font-medium">{student.studentName}</span>
                      <span className="block text-xs text-muted-foreground">{student.studentEmail || "No email"} - Grade {student.gradeLevel || "None"}</span>
                    </span>
                  </label>
                ))}
                {!scopeGroupClassStudentsQuery.isFetching && filteredScopeGroupStudents.length > 0 && (
                  <div className="flex items-center justify-between gap-3 border-t px-3 py-2 text-xs text-muted-foreground">
                    <span>
                      Showing {(pagedScopeGroupStudents.currentPage - 1) * PICKER_PAGE_SIZE + 1}-{Math.min(pagedScopeGroupStudents.currentPage * PICKER_PAGE_SIZE, filteredScopeGroupStudents.length)} of {filteredScopeGroupStudents.length}
                    </span>
                    <div className="flex items-center gap-2">
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => setScopeGroupStudentPage((page) => Math.max(1, page - 1))}
                        disabled={pagedScopeGroupStudents.currentPage <= 1}
                      >
                        Previous
                      </Button>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => setScopeGroupStudentPage((page) => Math.min(pagedScopeGroupStudents.pageCount, page + 1))}
                        disabled={pagedScopeGroupStudents.currentPage >= pagedScopeGroupStudents.pageCount}
                      >
                        Next
                      </Button>
                    </div>
                  </div>
                )}
              </div>
            </div>
            {scopeGroupForm.id && (
              <label className="flex items-center gap-2 text-sm">
                <Checkbox checked={scopeGroupForm.active} onCheckedChange={(checked) => setScopeGroupForm((f) => ({ ...f, active: checked === true }))} />
                Active supervision group
              </label>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setScopeGroupOpen(false)}>Cancel</Button>
            <Button onClick={submitScopeGroup} disabled={saveScopeGroupMutation.isPending || !scopeGroupForm.name.trim()}>
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!commandDialog} onOpenChange={(open) => !open && setCommandDialog(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {commandDialog === "open-tab" && "Open Tab"}
              {commandDialog === "teacher-message" && "Message Students"}
              {commandDialog === "apply-flight-path" && "Apply Flight Path"}
              {commandDialog === "apply-block-list" && "Apply Block List"}
            </DialogTitle>
            <DialogDescription>
              Targets {commandTargetCount} student{commandTargetCount === 1 ? "" : "s"} in {selectedContext?.name || "coverage"}.
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
                      <SelectItem key={flightPath.id} value={flightPath.id}>{flightPath.flightPathName}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
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
              <Button onClick={() => sendCoverageCommand("apply-flight-path", { flightPathId: selectedFlightPathId })} disabled={commandMutation.isPending || !selectedFlightPathId}>
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
