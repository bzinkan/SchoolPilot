import { useEffect, useMemo, useState } from "react";
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
  return coverageTypes.find(([id]) => id === type)?.[1] || "Coverage";
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
  const [contextForm, setContextForm] = useState({
    contextType: "state_testing",
    name: "State Testing",
    assignedStaffId: "",
    endsAt: defaultEndTime(),
    note: "",
  });
  const [assignmentForm, setAssignmentForm] = useState({
    staffId: "",
    scopeType: "school",
    scopeValue: "",
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

  const staffQuery = useQuery({
    queryKey: ["/api/admin/users"],
    queryFn: () => apiRequest("GET", "/admin/users"),
    select: (data) => data?.users || [],
    enabled: isAdmin,
  });

  const groupsQuery = useQuery({
    queryKey: ["/api/teacher/groups"],
    queryFn: () => apiRequest("GET", "/teacher/groups"),
    select: (data) => data?.groups || [],
    enabled: isAdmin,
  });

  const assignmentsQuery = useQuery({
    queryKey: ["/api/coverage/assignments"],
    queryFn: () => apiRequest("GET", "/coverage/assignments"),
    select: (data) => data?.assignments || [],
    enabled: isAdmin,
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

  const contexts = contextsQuery.data || [];
  const manageableContexts = useMemo(
    () => contexts.filter((context) => context.canManage && context.status === "active"),
    [contexts]
  );
  const selectedContext = manageableContexts.find((context) => context.id === selectedContextId) || manageableContexts[0] || null;

  useEffect(() => {
    if (!selectedContext && selectedContextId) {
      setSelectedContextId("");
      return;
    }
    if (!selectedContextId && manageableContexts.length > 0) {
      setSelectedContextId(manageableContexts[0].id);
    }
  }, [manageableContexts, selectedContext, selectedContextId]);

  useEffect(() => {
    setSelectedCoverageIds(new Set());
  }, [selectedContextId]);

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

  const activeCoverageStudents = coverageStudents.filter((student) => !student.releasedAt);
  const selectedCoverageStudentIds = Array.from(selectedCoverageIds);
  const commandTargetCount = selectedCoverageStudentIds.length || activeCoverageStudents.length;

  const invalidateCoverage = () => {
    queryClient.invalidateQueries({ queryKey: ["/api/coverage/unassigned"] });
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
      if (data?.context?.id) setSelectedContextId(data.context.id);
      setActiveTab("console");
      toast({ title: "Coverage started" });
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
      toast({ title: "Coverage released" });
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

  const createAssignmentMutation = useMutation({
    mutationFn: (payload) => apiRequest("POST", "/coverage/assignments", payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/coverage/assignments"] });
      setAssignmentOpen(false);
      toast({ title: "Coverage assignment saved" });
    },
    onError: (error) => toast({ variant: "destructive", title: "Could not save assignment", description: error.message }),
  });

  const deactivateAssignmentMutation = useMutation({
    mutationFn: (id) => apiRequest("PATCH", `/coverage/assignments/${id}`, { active: false }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["/api/coverage/assignments"] }),
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

  const submitContext = () => {
    createContextMutation.mutate({
      ...contextForm,
      assignedStaffId: contextForm.assignedStaffId || currentUser?.id,
      studentIds: Array.from(selectedUnassignedIds),
      endsAt: new Date(contextForm.endsAt).toISOString(),
    });
  };

  const submitAssignment = () => {
    createAssignmentMutation.mutate({
      staffId: assignmentForm.staffId,
      scopeType: assignmentForm.scopeType,
      scopeValue: assignmentForm.scopeValue,
    });
  };

  const sendCoverageCommand = (commandType, commandPayload = {}) => {
    if (!selectedContext?.id) {
      toast({ variant: "destructive", title: "Choose a coverage context" });
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
              <h1 className="text-xl font-semibold">Coverage</h1>
              <p className="text-sm text-muted-foreground">Temporary supervision for students outside active class sessions</p>
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
              <CardTitle className="text-sm flex items-center gap-2"><Eye className="h-4 w-4" />Online Unassigned</CardTitle>
            </CardHeader>
            <CardContent><p className="text-3xl font-semibold">{unassignedQuery.data?.length || 0}</p></CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm flex items-center gap-2"><ClipboardCheck className="h-4 w-4" />Active Coverage</CardTitle>
            </CardHeader>
            <CardContent><p className="text-3xl font-semibold">{contexts.filter((c) => c.status === "active").length}</p></CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm flex items-center gap-2"><Shield className="h-4 w-4" />Coverage Staff</CardTitle>
            </CardHeader>
            <CardContent><p className="text-3xl font-semibold">{assignmentsQuery.data?.filter((a) => a.active).length || 0}</p></CardContent>
          </Card>
        </div>

        <Tabs value={activeTab} onValueChange={setActiveTab}>
          <TabsList>
            <TabsTrigger value="console">My Coverage</TabsTrigger>
            <TabsTrigger value="unassigned">Online Unassigned</TabsTrigger>
            <TabsTrigger value="contexts">Temporary Coverage</TabsTrigger>
            {isAdmin && <TabsTrigger value="settings">Coverage Settings</TabsTrigger>}
          </TabsList>

          <TabsContent value="console" className="space-y-4 mt-4">
            {manageableContexts.length === 0 ? (
              <div className="rounded-md border px-4 py-12 text-center text-sm text-muted-foreground">
                No coverage contexts are assigned to you.
              </div>
            ) : (
              <>
                <div className="flex gap-2 overflow-x-auto pb-1">
                  {manageableContexts.map((context) => (
                    <button
                      key={context.id}
                      type="button"
                      onClick={() => setSelectedContextId(context.id)}
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
                        {contextTypeLabel(selectedContext?.contextType)} - {selectedContext?.assignedStaff?.displayName || "Coverage staff"} - ends {formatTime(selectedContext?.endsAt)}
                      </p>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge variant="secondary">{selectedCoverageIds.size || activeCoverageStudents.length} targeted</Badge>
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
                      disabled={selectedCoverageIds.size === 0}
                      onClick={() => openReleaseDialog({
                        contextId: selectedContext.id,
                        studentIds: selectedCoverageStudentIds,
                        title: `Release ${selectedCoverageIds.size} selected student${selectedCoverageIds.size === 1 ? "" : "s"}`,
                      })}
                    >
                      Release Selected
                    </Button>
                  </div>

                  <div className="flex items-center gap-3 px-4 py-3">
                    <div className="relative w-full max-w-sm">
                      <Search className="h-4 w-4 absolute left-3 top-3 text-muted-foreground" />
                      <Input className="pl-9" placeholder="Search covered students" value={coverageSearch} onChange={(e) => setCoverageSearch(e.target.value)} />
                    </div>
                    <Button variant="outline" size="sm" onClick={() => setSelectedCoverageIds(new Set(activeCoverageStudents.map((student) => student.studentId)))} disabled={activeCoverageStudents.length === 0}>
                      Select All
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => setSelectedCoverageIds(new Set())} disabled={selectedCoverageIds.size === 0}>
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
                      <span>In Coverage</span>
                      <span />
                    </div>
                    {coverageStudents.length === 0 ? (
                      <div className="px-4 py-10 text-center text-sm text-muted-foreground">No students in this coverage context</div>
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
                Start Coverage
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
                  Create Coverage
                </Button>
              )}
            </div>
            <div className="grid gap-3">
              {contexts.length === 0 ? (
                <div className="rounded-md border px-4 py-10 text-center text-sm text-muted-foreground">No temporary coverage contexts</div>
              ) : contexts.map((context) => (
                <Card key={context.id}>
                  <CardHeader className="pb-3">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <CardTitle className="text-base">{context.name}</CardTitle>
                        <CardDescription>
                          {context.assignedStaff?.displayName || "Coverage staff"} - ends {formatTime(context.endsAt)}
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
                          <Button variant="outline" size="sm" onClick={() => { setSelectedContextId(context.id); setActiveTab("console"); }}>
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

          {isAdmin && (
            <TabsContent value="settings" className="space-y-4 mt-4">
              <div className="flex justify-end">
                <Button onClick={() => setAssignmentOpen(true)}>
                  <UserCheck className="h-4 w-4 mr-2" />
                  Add Assignment
                </Button>
              </div>
              <div className="rounded-md border overflow-hidden">
                {(assignmentsQuery.data || []).length === 0 ? (
                  <div className="px-4 py-10 text-center text-sm text-muted-foreground">No coverage assignments</div>
                ) : assignmentsQuery.data.map((assignment) => (
                  <div key={assignment.id} className="flex items-center justify-between gap-3 px-4 py-3 border-t first:border-t-0 text-sm">
                    <div>
                      <p className="font-medium">{staffQuery.data?.find((s) => s.userId === assignment.staffId)?.user?.email || assignment.staffId}</p>
                      <p className="text-xs text-muted-foreground">{assignment.scopeType}{assignment.scopeValue ? ` - ${assignment.scopeValue}` : ""}</p>
                    </div>
                    <Button variant="ghost" size="sm" onClick={() => deactivateAssignmentMutation.mutate(assignment.id)} disabled={!assignment.active}>
                      Disable
                    </Button>
                  </div>
                ))}
              </div>
            </TabsContent>
          )}
        </Tabs>
      </main>

      <Dialog open={contextOpen} onOpenChange={setContextOpen}>
        <DialogContent>
          <DialogHeader><DialogTitle>Start Temporary Coverage</DialogTitle></DialogHeader>
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
        <DialogContent>
          <DialogHeader><DialogTitle>Add Coverage Assignment</DialogTitle></DialogHeader>
          <div className="space-y-4">
            <div className="grid gap-2">
              <Label>Staff</Label>
              <Select value={assignmentForm.staffId} onValueChange={(value) => setAssignmentForm((f) => ({ ...f, staffId: value }))}>
                <SelectTrigger><SelectValue placeholder="Select staff" /></SelectTrigger>
                <SelectContent>{(staffQuery.data || []).map((staff) => <SelectItem key={staff.userId} value={staff.userId}>{displayName(staff)}</SelectItem>)}</SelectContent>
              </Select>
            </div>
            <div className="grid gap-2">
              <Label>Scope</Label>
              <Select value={assignmentForm.scopeType} onValueChange={(value) => setAssignmentForm((f) => ({ ...f, scopeType: value, scopeValue: "" }))}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="school">Schoolwide</SelectItem>
                  <SelectItem value="grade">Grade</SelectItem>
                  <SelectItem value="group">Class/Group</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {assignmentForm.scopeType === "grade" && (
              <div className="grid gap-2">
                <Label>Grade</Label>
                <Input value={assignmentForm.scopeValue} onChange={(e) => setAssignmentForm((f) => ({ ...f, scopeValue: e.target.value }))} />
              </div>
            )}
            {assignmentForm.scopeType === "group" && (
              <div className="grid gap-2">
                <Label>Group</Label>
                <Select value={assignmentForm.scopeValue} onValueChange={(value) => setAssignmentForm((f) => ({ ...f, scopeValue: value }))}>
                  <SelectTrigger><SelectValue placeholder="Select group" /></SelectTrigger>
                  <SelectContent>{(groupsQuery.data || []).map((group) => <SelectItem key={group.id} value={group.id}>{group.name}</SelectItem>)}</SelectContent>
                </Select>
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAssignmentOpen(false)}>Cancel</Button>
            <Button onClick={submitAssignment} disabled={createAssignmentMutation.isPending || !assignmentForm.staffId || (assignmentForm.scopeType !== "school" && !assignmentForm.scopeValue)}>Save</Button>
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
            <DialogDescription>Choose why these students are leaving temporary coverage.</DialogDescription>
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
            <DialogTitle>Coverage History</DialogTitle>
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
