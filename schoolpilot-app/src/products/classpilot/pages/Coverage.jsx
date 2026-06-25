import { useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { ArrowLeft, ClipboardCheck, Eye, Plus, RefreshCw, Search, Shield, UserCheck, X } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { apiRequest, queryClient } from "../../../lib/queryClient";
import { Button } from "../../../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../../../components/ui/card";
import { Input } from "../../../components/ui/input";
import { Label } from "../../../components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../../components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../../../components/ui/tabs";
import { Badge } from "../../../components/ui/badge";
import { Checkbox } from "../../../components/ui/checkbox";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "../../../components/ui/dialog";
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

function defaultEndTime() {
  const d = new Date(Date.now() + 60 * 60 * 1000);
  d.setSeconds(0, 0);
  return d.toISOString().slice(0, 16);
}

function displayName(user) {
  return user?.displayName || user?.email || user?.user?.email || "Staff";
}

export default function Coverage() {
  const navigate = useNavigate();
  const { toast } = useToast();
  const { currentUser } = useClassPilotAuth();
  const isAdmin = currentUser?.isSuperAdmin || currentUser?.role === "admin" || currentUser?.role === "school_admin";
  const [selectedIds, setSelectedIds] = useState(new Set());
  const [search, setSearch] = useState("");
  const [contextOpen, setContextOpen] = useState(false);
  const [assignmentOpen, setAssignmentOpen] = useState(false);
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

  const students = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (unassignedQuery.data || []).filter((student) => {
      if (!q) return true;
      return `${student.studentName || ""} ${student.studentEmail || ""} ${student.gradeLevel || ""}`.toLowerCase().includes(q);
    });
  }, [unassignedQuery.data, search]);

  const selectedStudents = Array.from(selectedIds);

  const createContextMutation = useMutation({
    mutationFn: (payload) => apiRequest("POST", "/coverage/contexts", payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/coverage/unassigned"] });
      queryClient.invalidateQueries({ queryKey: ["/api/coverage/contexts"] });
      queryClient.invalidateQueries({ queryKey: ["/api/students-aggregated"] });
      setSelectedIds(new Set());
      setContextOpen(false);
      toast({ title: "Coverage started" });
    },
    onError: (error) => toast({ variant: "destructive", title: "Could not start coverage", description: error.message }),
  });

  const releaseMutation = useMutation({
    mutationFn: (contextId) => apiRequest("POST", `/coverage/contexts/${contextId}/release`, {}),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/coverage/unassigned"] });
      queryClient.invalidateQueries({ queryKey: ["/api/coverage/contexts"] });
      queryClient.invalidateQueries({ queryKey: ["/api/students-aggregated"] });
      toast({ title: "Coverage released" });
    },
    onError: (error) => toast({ variant: "destructive", title: "Could not release coverage", description: error.message }),
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

  const toggleStudent = (id) => {
    setSelectedIds((prev) => {
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
      studentIds: selectedStudents,
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
              <p className="text-sm text-muted-foreground">Online unassigned students and temporary supervision contexts</p>
            </div>
          </div>
          <Button variant="outline" onClick={() => {
            queryClient.invalidateQueries({ queryKey: ["/api/coverage/unassigned"] });
            queryClient.invalidateQueries({ queryKey: ["/api/coverage/contexts"] });
          }}>
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
            <CardContent><p className="text-3xl font-semibold">{contextsQuery.data?.filter((c) => c.status === "active").length || 0}</p></CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm flex items-center gap-2"><Shield className="h-4 w-4" />Coverage Staff</CardTitle>
            </CardHeader>
            <CardContent><p className="text-3xl font-semibold">{assignmentsQuery.data?.filter((a) => a.active).length || 0}</p></CardContent>
          </Card>
        </div>

        <Tabs defaultValue="unassigned">
          <TabsList>
            <TabsTrigger value="unassigned">Online Unassigned</TabsTrigger>
            <TabsTrigger value="contexts">Temporary Coverage</TabsTrigger>
            {isAdmin && <TabsTrigger value="settings">Coverage Settings</TabsTrigger>}
          </TabsList>

          <TabsContent value="unassigned" className="space-y-4 mt-4">
            <div className="flex items-center justify-between gap-3 flex-wrap">
              <div className="relative w-full max-w-sm">
                <Search className="h-4 w-4 absolute left-3 top-3 text-muted-foreground" />
                <Input className="pl-9" placeholder="Search students" value={search} onChange={(e) => setSearch(e.target.value)} />
              </div>
              <Button onClick={() => setContextOpen(true)} disabled={selectedIds.size === 0 && !isAdmin}>
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
              {students.length === 0 ? (
                <div className="px-4 py-10 text-center text-sm text-muted-foreground">No online unassigned students</div>
              ) : students.map((student) => (
                <div key={student.studentId} className="grid grid-cols-[44px_1fr_120px_120px_1.5fr] gap-3 px-4 py-3 border-t items-center text-sm">
                  <Checkbox checked={selectedIds.has(student.studentId)} onCheckedChange={() => toggleStudent(student.studentId)} />
                  <div>
                    <p className="font-medium">{student.studentName}</p>
                    <p className="text-xs text-muted-foreground">{student.studentEmail}</p>
                  </div>
                  <span>{student.gradeLevel || "None"}</span>
                  <Badge variant={student.status === "online" ? "default" : "secondary"}>{student.status}</Badge>
                  <span className="truncate text-muted-foreground">{student.activeTabTitle || student.activeTabUrl || "No active tab"}</span>
                </div>
              ))}
            </div>
          </TabsContent>

          <TabsContent value="contexts" className="space-y-4 mt-4">
            <div className="flex justify-end">
              <Button onClick={() => setContextOpen(true)}>
                <Plus className="h-4 w-4 mr-2" />
                Create Empty Coverage
              </Button>
            </div>
            <div className="grid gap-3">
              {(contextsQuery.data || []).length === 0 ? (
                <div className="rounded-md border px-4 py-10 text-center text-sm text-muted-foreground">No temporary coverage contexts</div>
              ) : contextsQuery.data.map((context) => (
                <Card key={context.id}>
                  <CardHeader className="pb-3">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <CardTitle className="text-base">{context.name}</CardTitle>
                        <CardDescription>{context.assignedStaff?.displayName || "Unassigned"} · Ends {new Date(context.endsAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</CardDescription>
                      </div>
                      <Badge>{context.activeStudentCount} student{context.activeStudentCount === 1 ? "" : "s"}</Badge>
                    </div>
                  </CardHeader>
                  <CardContent className="space-y-3">
                    {context.students?.length ? (
                      <div className="flex flex-wrap gap-2">
                        {context.students.map((student) => <Badge variant="secondary" key={student.studentId}>{student.studentName}</Badge>)}
                      </div>
                    ) : <p className="text-sm text-muted-foreground">No active students assigned</p>}
                    <Button variant="outline" size="sm" onClick={() => releaseMutation.mutate(context.id)} disabled={releaseMutation.isPending || context.activeStudentCount === 0}>
                      <X className="h-4 w-4 mr-2" />
                      Release All
                    </Button>
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
                      <p className="text-xs text-muted-foreground">{assignment.scopeType}{assignment.scopeValue ? ` · ${assignment.scopeValue}` : ""}</p>
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
              <Input value={contextForm.note} onChange={(e) => setContextForm((f) => ({ ...f, note: e.target.value }))} />
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
    </div>
  );
}
