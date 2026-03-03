import { useState, useMemo } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "../../../lib/queryClient";
import { useNavigate } from "react-router-dom";
import { useClassPilotAuth } from "../../../hooks/useClassPilotAuth";
import { useToast } from "../../../hooks/use-toast";
import { ThemeToggle } from "../../../components/ThemeToggle";
import { Button } from "../../../components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "../../../components/ui/card";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "../../../components/ui/alert-dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../../components/ui/select";
import { Input } from "../../../components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../../../components/ui/tabs";
import { Badge } from "../../../components/ui/badge";
import { Checkbox } from "../../../components/ui/checkbox";
import {
  ArrowLeft,
  Loader2,
  Search,
  ClipboardCheck,
  UserX,
  Clock,
  X,
} from "lucide-react";

export default function AdminAttendance() {
  const navigate = useNavigate();
  const { toast } = useToast();
  const { currentUser } = useClassPilotAuth();

  const today = new Date().toISOString().slice(0, 10);
  const [selectedDate, setSelectedDate] = useState(today);
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedStudents, setSelectedStudents] = useState(new Set());
  const [markStatus, setMarkStatus] = useState("absent");
  const [markReason, setMarkReason] = useState("");
  const [markNotes, setMarkNotes] = useState("");
  const [removeTarget, setRemoveTarget] = useState(null);
  const [activeTab, setActiveTab] = useState("mark");

  // History date range
  const [historyStart, setHistoryStart] = useState(() => {
    const d = new Date();
    d.setDate(d.getDate() - 7);
    return d.toISOString().slice(0, 10);
  });
  const [historyEnd, setHistoryEnd] = useState(today);

  // Fetch attendance for selected date
  const { data: attendanceData, isLoading: loadingAttendance } = useQuery({
    queryKey: ["/api/admin/attendance", selectedDate],
    queryFn: () =>
      apiRequest("GET", `/admin/attendance?date=${selectedDate}`),
  });

  // Fetch all active students
  const { data: studentsData, isLoading: loadingStudents } = useQuery({
    queryKey: ["/api/students", "active"],
    queryFn: () => apiRequest("GET", "/students?status=active"),
  });

  // Fetch attendance stats for history
  const { data: statsData } = useQuery({
    queryKey: ["/api/admin/attendance/stats", historyStart, historyEnd],
    queryFn: () =>
      apiRequest(
        "GET",
        `/admin/attendance/stats?start=${historyStart}&end=${historyEnd}`
      ),
    enabled: activeTab === "history",
  });

  const records = attendanceData?.records || [];
  const allStudents = studentsData?.students || [];
  const absentIdSet = new Set(records.map((r) => r.studentId));

  // Filter students by search
  const filteredStudents = useMemo(() => {
    if (!searchQuery) return allStudents;
    const q = searchQuery.toLowerCase();
    return allStudents.filter(
      (s) =>
        s.firstName?.toLowerCase().includes(q) ||
        s.lastName?.toLowerCase().includes(q) ||
        s.email?.toLowerCase().includes(q) ||
        s.gradeLevel?.toLowerCase().includes(q)
    );
  }, [allStudents, searchQuery]);

  // Mark absent mutation
  const markMutation = useMutation({
    mutationFn: (data) => apiRequest("POST", "/admin/attendance", data),
    onSuccess: (data) => {
      queryClient.invalidateQueries({
        queryKey: ["/api/admin/attendance"],
      });
      toast({
        title: "Students marked",
        description: `${data.count} student(s) marked as ${markStatus}.`,
      });
      setSelectedStudents(new Set());
      setMarkReason("");
      setMarkNotes("");
    },
    onError: (error) => {
      toast({
        variant: "destructive",
        title: "Failed to mark attendance",
        description: error?.response?.data?.error || error.message,
      });
    },
  });

  // Remove absence mutation
  const removeMutation = useMutation({
    mutationFn: (id) => apiRequest("DELETE", `/admin/attendance/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ["/api/admin/attendance"],
      });
      toast({
        title: "Absence removed",
        description: "The student is now marked as present.",
      });
      setRemoveTarget(null);
    },
    onError: (error) => {
      toast({
        variant: "destructive",
        title: "Failed to remove absence",
        description: error?.response?.data?.error || error.message,
      });
    },
  });

  function handleMarkSelected() {
    if (selectedStudents.size === 0) return;
    markMutation.mutate({
      studentIds: [...selectedStudents],
      date: selectedDate,
      status: markStatus,
      reason: markReason || undefined,
      notes: markNotes || undefined,
    });
  }

  function toggleStudent(id) {
    setSelectedStudents((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function selectAllFiltered() {
    const presentStudents = filteredStudents.filter(
      (s) => !absentIdSet.has(s.id)
    );
    setSelectedStudents(new Set(presentStudents.map((s) => s.id)));
  }

  function statusBadge(status) {
    const variants = {
      absent: "destructive",
      tardy: "default",
      early_dismissal: "secondary",
    };
    const labels = {
      absent: "Absent",
      tardy: "Tardy",
      early_dismissal: "Early Dismissal",
    };
    return (
      <Badge variant={variants[status] || "secondary"}>
        {labels[status] || status}
      </Badge>
    );
  }

  const absentCount = records.filter((r) => r.status === "absent").length;
  const tardyCount = records.filter((r) => r.status === "tardy").length;

  return (
    <div className="container mx-auto p-6 max-w-6xl space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="h-12 w-12 rounded-lg bg-primary flex items-center justify-center">
            <ClipboardCheck className="h-6 w-6 text-primary-foreground" />
          </div>
          <div>
            <h1 className="text-3xl font-semibold">Attendance</h1>
            <p className="text-muted-foreground">
              Track daily student absences across all products
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <ThemeToggle />
          <Button
            variant="outline"
            onClick={() => navigate("/classpilot/admin")}
          >
            <ArrowLeft className="h-4 w-4 mr-2" />
            Back to Admin
          </Button>
        </div>
      </div>

      {/* Summary bar */}
      <div className="flex items-center gap-4">
        <Input
          type="date"
          value={selectedDate}
          onChange={(e) => setSelectedDate(e.target.value)}
          className="w-44"
        />
        <div className="flex items-center gap-3 text-sm">
          <span className="flex items-center gap-1.5">
            <UserX className="h-4 w-4 text-destructive" />
            <strong>{absentCount}</strong> absent
          </span>
          <span className="flex items-center gap-1.5">
            <Clock className="h-4 w-4 text-yellow-500" />
            <strong>{tardyCount}</strong> tardy
          </span>
          <span className="text-muted-foreground">
            {allStudents.length} total students
          </span>
        </div>
      </div>

      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList>
          <TabsTrigger value="mark">Mark Attendance</TabsTrigger>
          <TabsTrigger value="today">
            Today's Absences ({records.length})
          </TabsTrigger>
          <TabsTrigger value="history">History</TabsTrigger>
        </TabsList>

        {/* Mark Attendance Tab */}
        <TabsContent value="mark">
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between">
                <div>
                  <CardTitle>Mark Students Absent</CardTitle>
                  <CardDescription>
                    Select students and mark them as absent, tardy, or early
                    dismissal.
                  </CardDescription>
                </div>
                <div className="flex items-center gap-2">
                  <Select value={markStatus} onValueChange={setMarkStatus}>
                    <SelectTrigger className="w-40">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="absent">Absent</SelectItem>
                      <SelectItem value="tardy">Tardy</SelectItem>
                      <SelectItem value="early_dismissal">
                        Early Dismissal
                      </SelectItem>
                    </SelectContent>
                  </Select>
                  <Select
                    value={markReason || "_none"}
                    onValueChange={(v) =>
                      setMarkReason(v === "_none" ? "" : v)
                    }
                  >
                    <SelectTrigger className="w-36">
                      <SelectValue placeholder="Reason" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="_none">No reason</SelectItem>
                      <SelectItem value="sick">Sick</SelectItem>
                      <SelectItem value="family">Family</SelectItem>
                      <SelectItem value="appointment">Appointment</SelectItem>
                      <SelectItem value="other">Other</SelectItem>
                    </SelectContent>
                  </Select>
                  <Button
                    onClick={handleMarkSelected}
                    disabled={
                      selectedStudents.size === 0 || markMutation.isPending
                    }
                  >
                    {markMutation.isPending ? (
                      <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    ) : null}
                    Mark {selectedStudents.size} Student
                    {selectedStudents.size !== 1 ? "s" : ""}
                  </Button>
                </div>
              </div>
            </CardHeader>
            <CardContent>
              <div className="space-y-3">
                <div className="flex items-center gap-2">
                  <div className="relative flex-1">
                    <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                    <Input
                      placeholder="Search students..."
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                      className="pl-9"
                    />
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={selectAllFiltered}
                  >
                    Select All Present
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setSelectedStudents(new Set())}
                  >
                    Clear
                  </Button>
                </div>

                {loadingStudents ? (
                  <div className="flex items-center justify-center py-12">
                    <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
                  </div>
                ) : (
                  <div className="border rounded-lg overflow-hidden max-h-[500px] overflow-y-auto">
                    <table className="w-full">
                      <thead className="bg-muted sticky top-0">
                        <tr>
                          <th className="px-4 py-2 text-left w-10"></th>
                          <th className="px-4 py-2 text-left font-medium text-sm">
                            Student
                          </th>
                          <th className="px-4 py-2 text-left font-medium text-sm">
                            Grade
                          </th>
                          <th className="px-4 py-2 text-left font-medium text-sm">
                            Status
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        {filteredStudents.map((s) => {
                          const isAbsent = absentIdSet.has(s.id);
                          const record = records.find(
                            (r) => r.studentId === s.id
                          );
                          return (
                            <tr
                              key={s.id}
                              className={`border-t hover:bg-muted/50 ${isAbsent ? "opacity-60 bg-red-50 dark:bg-red-950/20" : ""}`}
                            >
                              <td className="px-4 py-2">
                                {!isAbsent && (
                                  <Checkbox
                                    checked={selectedStudents.has(s.id)}
                                    onCheckedChange={() => toggleStudent(s.id)}
                                  />
                                )}
                              </td>
                              <td className="px-4 py-2">
                                <span className="font-medium">
                                  {s.lastName}, {s.firstName}
                                </span>
                              </td>
                              <td className="px-4 py-2 text-sm text-muted-foreground">
                                {s.gradeLevel || "—"}
                              </td>
                              <td className="px-4 py-2">
                                {isAbsent ? (
                                  <div className="flex items-center gap-2">
                                    {statusBadge(record?.status)}
                                    <Button
                                      variant="ghost"
                                      size="sm"
                                      onClick={() => setRemoveTarget(record)}
                                    >
                                      <X className="h-3 w-3" />
                                    </Button>
                                  </div>
                                ) : (
                                  <span className="text-sm text-green-600">
                                    Present
                                  </span>
                                )}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        {/* Today's Absences Tab */}
        <TabsContent value="today">
          <Card>
            <CardHeader>
              <CardTitle>
                Absences for{" "}
                {new Date(selectedDate + "T12:00:00").toLocaleDateString(
                  "en-US",
                  {
                    weekday: "long",
                    month: "long",
                    day: "numeric",
                    year: "numeric",
                  }
                )}
              </CardTitle>
            </CardHeader>
            <CardContent>
              {loadingAttendance ? (
                <div className="flex items-center justify-center py-12">
                  <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
                </div>
              ) : records.length === 0 ? (
                <div className="text-center py-12 text-muted-foreground">
                  <ClipboardCheck className="h-12 w-12 mx-auto mb-3 opacity-40" />
                  <p>No absences recorded for this date</p>
                </div>
              ) : (
                <div className="border rounded-lg overflow-hidden">
                  <table className="w-full">
                    <thead className="bg-muted">
                      <tr>
                        <th className="px-4 py-3 text-left font-medium text-sm">
                          Student
                        </th>
                        <th className="px-4 py-3 text-left font-medium text-sm">
                          Grade
                        </th>
                        <th className="px-4 py-3 text-left font-medium text-sm">
                          Status
                        </th>
                        <th className="px-4 py-3 text-left font-medium text-sm">
                          Reason
                        </th>
                        <th className="px-4 py-3 text-left font-medium text-sm">
                          Marked By
                        </th>
                        <th className="px-4 py-3 text-right font-medium text-sm">
                          Actions
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {records.map((r) => (
                        <tr key={r.id} className="border-t hover:bg-muted/50">
                          <td className="px-4 py-3 font-medium">
                            {r.student?.name}
                          </td>
                          <td className="px-4 py-3 text-sm text-muted-foreground">
                            {r.student?.gradeLevel || "—"}
                          </td>
                          <td className="px-4 py-3">{statusBadge(r.status)}</td>
                          <td className="px-4 py-3 text-sm capitalize">
                            {r.reason || "—"}
                          </td>
                          <td className="px-4 py-3 text-sm text-muted-foreground">
                            {r.markedByName}
                          </td>
                          <td className="px-4 py-3">
                            <div className="flex justify-end">
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => setRemoveTarget(r)}
                              >
                                <X className="h-4 w-4 text-destructive" />
                              </Button>
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* History Tab */}
        <TabsContent value="history">
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between">
                <CardTitle>Attendance History</CardTitle>
                <div className="flex items-center gap-2">
                  <Input
                    type="date"
                    value={historyStart}
                    onChange={(e) => setHistoryStart(e.target.value)}
                    className="w-40"
                  />
                  <span className="text-muted-foreground">to</span>
                  <Input
                    type="date"
                    value={historyEnd}
                    onChange={(e) => setHistoryEnd(e.target.value)}
                    className="w-40"
                  />
                </div>
              </div>
            </CardHeader>
            <CardContent>
              {statsData?.stats?.length > 0 ? (
                <div className="border rounded-lg overflow-hidden">
                  <table className="w-full">
                    <thead className="bg-muted">
                      <tr>
                        <th className="px-4 py-3 text-left font-medium text-sm">
                          Date
                        </th>
                        <th className="px-4 py-3 text-left font-medium text-sm">
                          Status
                        </th>
                        <th className="px-4 py-3 text-left font-medium text-sm">
                          Count
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {statsData.stats.map((s, i) => (
                        <tr key={i} className="border-t hover:bg-muted/50">
                          <td className="px-4 py-3 text-sm">{s.date}</td>
                          <td className="px-4 py-3">
                            {statusBadge(s.status)}
                          </td>
                          <td className="px-4 py-3 font-medium">{s.count}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <div className="text-center py-12 text-muted-foreground">
                  <p>No attendance data for this date range</p>
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      {/* Remove Absence Confirmation */}
      <AlertDialog
        open={!!removeTarget}
        onOpenChange={(open) => {
          if (!open) setRemoveTarget(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove Absence Record?</AlertDialogTitle>
            <AlertDialogDescription>
              This will mark{" "}
              <strong>{removeTarget?.student?.name}</strong> as present. They
              will be eligible for passes and dismissal again.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => removeMutation.mutate(removeTarget?.id)}
            >
              {removeMutation.isPending ? "Removing..." : "Mark Present"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
