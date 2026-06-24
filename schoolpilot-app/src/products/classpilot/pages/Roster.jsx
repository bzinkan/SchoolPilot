import { useMemo, useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { ArrowLeft, Clock, Edit, GraduationCap, Laptop, Plus, Search, Trash2, UserPlus, Users, Wifi, WifiOff, X } from "lucide-react";
import { Button } from "../../../components/ui/button";
import { Badge } from "../../../components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "../../../components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../../../components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../../../components/ui/tabs";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../../../components/ui/dialog";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "../../../components/ui/alert-dialog";
import { Input } from "../../../components/ui/input";
import { Label } from "../../../components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../../components/ui/select";
import { ThemeToggle } from "../../../components/ThemeToggle";
import { useToast } from "../../../hooks/use-toast";
import { useClassPilotAuth } from "../../../hooks/useClassPilotAuth";
import { queryClient, apiRequest } from "../../../lib/queryClient";

const NO_GRADE_VALUE = "__no_grade__";
const STANDARD_GRADES = ["PK", "K", "1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11", "12"];

function normalizeGrade(grade) {
  if (!grade) return null;
  const trimmed = String(grade).trim();
  if (!trimmed) return null;
  const lower = trimmed.toLowerCase();
  if (["pk", "pre-k", "prek", "pre k", "prekindergarten"].includes(lower)) return "PK";
  if (["k", "kg", "kindergarten"].includes(lower)) return "K";
  const numeric = lower.match(/^(\d{1,2})(st|nd|rd|th)?(?:\s*grade)?$/);
  if (numeric) return String(Number(numeric[1]));
  return trimmed.replace(/(\d+)(st|nd|rd|th)\b/gi, "$1");
}

function gradeLabel(grade) {
  const normalized = normalizeGrade(grade);
  if (!normalized) return "Ungraded";
  if (normalized === "PK") return "Pre-K";
  if (normalized === "K") return "Kindergarten";
  return `Grade ${normalized}`;
}

function gradeSortValue(grade) {
  const normalized = normalizeGrade(grade);
  if (normalized === "PK") return -1;
  if (normalized === "K") return 0;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : 99;
}

function fullName(student) {
  return [student?.firstName, student?.lastName].filter(Boolean).join(" ").trim() || "Unnamed student";
}

function formatDateTime(value) {
  if (!value) return "Never";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Unknown";
  return date.toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function minutesSince(value) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return Math.max(0, Math.round((Date.now() - date.getTime()) / 60000));
}

function extensionStatus(device) {
  const ageMinutes = minutesSince(device.lastSeenAt);
  if (ageMinutes === null) {
    return {
      label: "Never checked in",
      tone: "bg-muted text-muted-foreground border-border",
      icon: WifiOff,
      sort: 3,
    };
  }
  if (ageMinutes <= 2) {
    return {
      label: "Connected",
      tone: "bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-950 dark:text-emerald-300 dark:border-emerald-900",
      icon: Wifi,
      sort: 0,
    };
  }
  if (ageMinutes <= 60) {
    return {
      label: "Recently seen",
      tone: "bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-950 dark:text-amber-300 dark:border-amber-900",
      icon: Clock,
      sort: 1,
    };
  }
  return {
    label: "Offline",
    tone: "bg-slate-100 text-slate-700 border-slate-200 dark:bg-slate-900 dark:text-slate-300 dark:border-slate-800",
    icon: WifiOff,
    sort: 2,
  };
}

function blankStudentForm() {
  return {
    firstName: "",
    lastName: "",
    email: "",
    gradeLevel: "",
  };
}

function blankDeviceForm() {
  return {
    deviceName: "",
    classId: "",
  };
}

export default function RosterPage() {
  const navigate = useNavigate();
  const { toast } = useToast();
  const { isAdmin } = useClassPilotAuth();
  const [activeTab, setActiveTab] = useState("students");
  const [selectedGrade, setSelectedGrade] = useState("All");
  const [searchQuery, setSearchQuery] = useState("");
  const [dialog, setDialog] = useState(null);
  const [deleteDialog, setDeleteDialog] = useState(null);
  const [showGradeDialog, setShowGradeDialog] = useState(false);
  const [studentForm, setStudentForm] = useState(blankStudentForm());
  const [deviceForm, setDeviceForm] = useState(blankDeviceForm());
  const [newGrade, setNewGrade] = useState("");

  const { data: students = [], isLoading: studentsLoading } = useQuery({
    queryKey: ["/api/students"],
    queryFn: () => apiRequest("GET", "/students"),
    select: (data) => Array.isArray(data) ? data : data?.students ?? [],
  });

  const { data: devices = [], isLoading: devicesLoading } = useQuery({
    queryKey: ["/api/devices"],
    queryFn: () => apiRequest("GET", "/devices"),
    select: (data) => Array.isArray(data) ? data : data?.devices ?? [],
  });

  const { data: settings } = useQuery({
    queryKey: ["/api/settings"],
    queryFn: () => apiRequest("GET", "/settings"),
  });

  const manualGrades = useMemo(
    () => (settings?.gradeLevels || []).map(normalizeGrade).filter(Boolean),
    [settings]
  );

  const activeGrades = useMemo(() => {
    const grades = new Set(manualGrades);
    students.forEach((student) => {
      const grade = normalizeGrade(student.gradeLevel);
      if (grade) grades.add(grade);
    });
    return Array.from(grades).sort((a, b) => gradeSortValue(a) - gradeSortValue(b));
  }, [manualGrades, students]);

  const gradeCounts = useMemo(() => {
    return students.reduce((counts, student) => {
      const grade = normalizeGrade(student.gradeLevel) || NO_GRADE_VALUE;
      counts[grade] = (counts[grade] || 0) + 1;
      return counts;
    }, {});
  }, [students]);

  const filteredStudents = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    return students
      .filter((student) => {
        const grade = normalizeGrade(student.gradeLevel);
        if (selectedGrade === NO_GRADE_VALUE && grade) return false;
        if (selectedGrade !== "All" && selectedGrade !== NO_GRADE_VALUE && grade !== selectedGrade) return false;
        if (!query) return true;
        return [
          fullName(student),
          student.email,
          student.gradeLevel,
          student.studentIdNumber,
        ].filter(Boolean).some((value) => String(value).toLowerCase().includes(query));
      })
      .sort((a, b) => {
        const byGrade = gradeSortValue(a.gradeLevel) - gradeSortValue(b.gradeLevel);
        if (byGrade !== 0) return byGrade;
        return fullName(a).localeCompare(fullName(b));
      });
  }, [searchQuery, selectedGrade, students]);

  const sortedDevices = useMemo(() => {
    return [...devices].sort((a, b) => {
      const aStatus = extensionStatus(a);
      const bStatus = extensionStatus(b);
      if (aStatus.sort !== bStatus.sort) return aStatus.sort - bStatus.sort;
      return String(a.classId || "").localeCompare(String(b.classId || ""));
    });
  }, [devices]);

  const connectedCount = useMemo(
    () => devices.filter((device) => extensionStatus(device).label === "Connected").length,
    [devices]
  );
  const staleCount = Math.max(0, devices.length - connectedCount);
  const isLoading = studentsLoading || devicesLoading;
  const ungradedCount = gradeCounts[NO_GRADE_VALUE] || 0;

  const createStudentMutation = useMutation({
    mutationFn: async (data) => apiRequest("POST", "/students", {
      firstName: data.firstName,
      lastName: data.lastName,
      email: data.email || "",
      gradeLevel: data.gradeLevel || null,
    }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/students"] });
      queryClient.invalidateQueries({ queryKey: ["/api/roster/students"] });
      toast({
        title: "Student added",
        description: "The student record has been added.",
      });
      setDialog(null);
      setStudentForm(blankStudentForm());
    },
    onError: (error) => {
      toast({
        variant: "destructive",
        title: "Failed to add student",
        description: error.message,
      });
    },
  });

  const updateStudentMutation = useMutation({
    mutationFn: async (data) => apiRequest("PATCH", `/students/${data.studentId}`, {
      firstName: data.firstName,
      lastName: data.lastName,
      email: data.email || null,
      gradeLevel: data.gradeLevel || null,
    }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/students"] });
      queryClient.invalidateQueries({ queryKey: ["/api/roster/students"] });
      toast({
        title: "Student updated",
        description: "The student record has been updated.",
      });
      setDialog(null);
      setStudentForm(blankStudentForm());
    },
    onError: (error) => {
      toast({
        variant: "destructive",
        title: "Update failed",
        description: error.message,
      });
    },
  });

  const deleteStudentMutation = useMutation({
    mutationFn: async (studentId) => apiRequest("DELETE", `/students/${studentId}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/students"] });
      queryClient.invalidateQueries({ queryKey: ["/api/roster/students"] });
      toast({
        title: "Student deleted",
        description: "The student record has been deleted.",
      });
      setDeleteDialog(null);
    },
    onError: (error) => {
      toast({
        variant: "destructive",
        title: "Delete failed",
        description: error.message,
      });
    },
  });

  const updateDeviceMutation = useMutation({
    mutationFn: async (data) => apiRequest("PATCH", `/devices/${data.deviceId}`, {
      deviceName: data.deviceName || null,
      classId: data.classId || "Unassigned",
    }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/devices"] });
      queryClient.invalidateQueries({ queryKey: ["/api/roster/devices"] });
      toast({
        title: "Chromebook updated",
        description: "The extension record has been updated.",
      });
      setDialog(null);
      setDeviceForm(blankDeviceForm());
    },
    onError: (error) => {
      toast({
        variant: "destructive",
        title: "Update failed",
        description: error.message,
      });
    },
  });

  const updateGradesMutation = useMutation({
    mutationFn: async (gradeLevels) => {
      if (!settings) throw new Error("Settings not loaded");
      return apiRequest("POST", "/settings", {
        schoolId: settings.schoolId,
        schoolName: settings.schoolName,
        wsSharedKey: settings.wsSharedKey,
        retentionHours: settings.retentionHours,
        blockedDomains: settings.blockedDomains || [],
        allowedDomains: settings.allowedDomains || [],
        ipAllowlist: settings.ipAllowlist || [],
        gradeLevels,
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/settings"] });
      toast({
        title: "Grades updated",
        description: "Roster grade filters have been updated.",
      });
    },
    onError: (error) => {
      toast({
        variant: "destructive",
        title: "Grade update failed",
        description: error.message,
      });
    },
  });

  const validateStudentForm = () => {
    if (!studentForm.firstName.trim() || !studentForm.lastName.trim()) {
      toast({
        variant: "destructive",
        title: "Student name required",
        description: "Enter both first and last name.",
      });
      return false;
    }
    return true;
  };

  const handleSave = () => {
    if (!dialog) return;

    if (dialog.type === "add-student") {
      if (!validateStudentForm()) return;
      createStudentMutation.mutate({
        firstName: studentForm.firstName.trim(),
        lastName: studentForm.lastName.trim(),
        email: studentForm.email.trim(),
        gradeLevel: studentForm.gradeLevel,
      });
      return;
    }

    if (dialog.type === "edit-student") {
      if (!validateStudentForm()) return;
      updateStudentMutation.mutate({
        studentId: dialog.student.id,
        firstName: studentForm.firstName.trim(),
        lastName: studentForm.lastName.trim(),
        email: studentForm.email.trim(),
        gradeLevel: studentForm.gradeLevel,
      });
      return;
    }

    if (dialog.type === "edit-device") {
      updateDeviceMutation.mutate({
        deviceId: dialog.device.deviceId,
        deviceName: deviceForm.deviceName.trim(),
        classId: deviceForm.classId.trim(),
      });
    }
  };

  const handleDelete = () => {
    if (deleteDialog?.type === "delete-student") {
      deleteStudentMutation.mutate(deleteDialog.studentId);
    }
  };

  const handleAddGrade = () => {
    const grade = normalizeGrade(newGrade);
    if (!grade) {
      toast({
        variant: "destructive",
        title: "Invalid grade",
        description: "Enter a grade such as PK, K, or 8.",
      });
      return;
    }
    if (manualGrades.includes(grade)) {
      toast({
        variant: "destructive",
        title: "Duplicate grade",
        description: "That grade is already listed.",
      });
      return;
    }
    updateGradesMutation.mutate([...manualGrades, grade].sort((a, b) => gradeSortValue(a) - gradeSortValue(b)));
    setNewGrade("");
  };

  const handleDeleteGrade = (grade) => {
    const normalized = normalizeGrade(grade);
    const nextGrades = manualGrades.filter((existing) => existing !== normalized);
    updateGradesMutation.mutate(nextGrades);
    if (selectedGrade === normalized) {
      setSelectedGrade("All");
    }
  };

  const openAddStudentDialog = () => {
    setStudentForm(blankStudentForm());
    setDialog({ type: "add-student" });
  };

  const openEditStudentDialog = (student) => {
    setStudentForm({
      firstName: student.firstName || "",
      lastName: student.lastName || "",
      email: student.email || "",
      gradeLevel: normalizeGrade(student.gradeLevel) || "",
    });
    setDialog({ type: "edit-student", student });
  };

  const openEditDeviceDialog = (device) => {
    setDeviceForm({
      deviceName: device.deviceName || "",
      classId: device.classId || "",
    });
    setDialog({ type: "edit-device", device });
  };

  const isPending = createStudentMutation.isPending ||
    updateStudentMutation.isPending ||
    deleteStudentMutation.isPending ||
    updateDeviceMutation.isPending ||
    updateGradesMutation.isPending;

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b border-border bg-background">
        <div className="max-w-7xl mx-auto px-6 py-4">
          <div className="flex items-center justify-between gap-4">
            <div className="flex items-center gap-3">
              <Button
                variant="ghost"
                size="icon"
                onClick={() => navigate("/classpilot")}
                aria-label="Back to ClassPilot"
                data-testid="button-back"
              >
                <ArrowLeft className="h-5 w-5" />
              </Button>
              <div>
                <h1 className="text-2xl font-bold">Rosters</h1>
                <p className="text-sm text-muted-foreground">
                  Manage student records and check ClassPilot extension health
                </p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <ThemeToggle />
              {isAdmin && (
                <>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setShowGradeDialog(true)}
                    data-testid="button-manage-grades-roster"
                  >
                    <GraduationCap className="h-4 w-4 mr-2" />
                    Manage Grades
                  </Button>
                  <Button
                    size="sm"
                    onClick={openAddStudentDialog}
                    data-testid="button-add-student"
                  >
                    <UserPlus className="h-4 w-4 mr-2" />
                    Add Student
                  </Button>
                </>
              )}
            </div>
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-6 py-8">
        <div className="grid gap-4 md:grid-cols-4 mb-6">
          <Card>
            <CardContent className="p-5 flex items-center gap-4">
              <div className="h-11 w-11 rounded-md bg-blue-50 text-blue-700 dark:bg-blue-950 dark:text-blue-300 flex items-center justify-center">
                <Users className="h-5 w-5" />
              </div>
              <div>
                <p className="text-sm text-muted-foreground">Students</p>
                <p className="text-2xl font-bold">{students.length}</p>
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-5 flex items-center gap-4">
              <div className="h-11 w-11 rounded-md bg-amber-50 text-amber-700 dark:bg-amber-950 dark:text-amber-300 flex items-center justify-center">
                <GraduationCap className="h-5 w-5" />
              </div>
              <div>
                <p className="text-sm text-muted-foreground">Grades</p>
                <p className="text-2xl font-bold">{activeGrades.length}</p>
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-5 flex items-center gap-4">
              <div className="h-11 w-11 rounded-md bg-emerald-50 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300 flex items-center justify-center">
                <Wifi className="h-5 w-5" />
              </div>
              <div>
                <p className="text-sm text-muted-foreground">Connected</p>
                <p className="text-2xl font-bold">{connectedCount}</p>
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-5 flex items-center gap-4">
              <div className="h-11 w-11 rounded-md bg-slate-100 text-slate-700 dark:bg-slate-900 dark:text-slate-300 flex items-center justify-center">
                <Laptop className="h-5 w-5" />
              </div>
              <div>
                <p className="text-sm text-muted-foreground">Needs check</p>
                <p className="text-2xl font-bold">{staleCount}</p>
              </div>
            </CardContent>
          </Card>
        </div>

        <Tabs value={activeTab} onValueChange={setActiveTab}>
          <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between mb-6">
            <TabsList>
              <TabsTrigger value="students" data-testid="tab-students">
                Student Roster
              </TabsTrigger>
              <TabsTrigger value="extensions" data-testid="tab-extensions">
                Chromebook Status
              </TabsTrigger>
            </TabsList>
            {activeTab === "students" && (
              <div className="relative w-full md:w-80">
                <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Search students..."
                  className="pl-9"
                  data-testid="input-search-students"
                />
              </div>
            )}
          </div>

          <TabsContent value="students" className="space-y-6">
            <Tabs value={selectedGrade} onValueChange={setSelectedGrade}>
              <TabsList className="flex-wrap h-auto">
                <TabsTrigger value="All" data-testid="tab-grade-all">
                  All Grades
                  <Badge variant="secondary" className="ml-2">{students.length}</Badge>
                </TabsTrigger>
                {activeGrades.map((grade) => (
                  <TabsTrigger key={grade} value={grade} data-testid={`tab-grade-${grade}`}>
                    {gradeLabel(grade)}
                    <Badge variant="secondary" className="ml-2">{gradeCounts[grade] || 0}</Badge>
                  </TabsTrigger>
                ))}
                {ungradedCount > 0 && (
                  <TabsTrigger value={NO_GRADE_VALUE} data-testid="tab-grade-ungraded">
                    Ungraded
                    <Badge variant="secondary" className="ml-2">{ungradedCount}</Badge>
                  </TabsTrigger>
                )}
              </TabsList>
            </Tabs>

            <Card>
              <CardHeader>
                <CardTitle className="flex items-center justify-between gap-3">
                  <span>Students</span>
                  <span className="text-sm font-normal text-muted-foreground">
                    {filteredStudents.length} shown
                  </span>
                </CardTitle>
              </CardHeader>
              <CardContent>
                {isLoading ? (
                  <div className="py-12 text-center text-muted-foreground">Loading students...</div>
                ) : filteredStudents.length === 0 ? (
                  <div className="py-12 text-center">
                    <Users className="h-12 w-12 mx-auto mb-4 text-muted-foreground/50" />
                    <h3 className="font-semibold">No students found</h3>
                    <p className="text-sm text-muted-foreground mt-1">
                      Adjust the search or grade filter.
                    </p>
                  </div>
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Name</TableHead>
                        <TableHead>Email</TableHead>
                        <TableHead>Grade</TableHead>
                        {isAdmin && <TableHead className="text-right">Actions</TableHead>}
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {filteredStudents.map((student) => (
                        <TableRow key={student.id} data-testid={`row-student-${student.id}`}>
                          <TableCell className="font-medium" data-testid={`text-student-name-${student.id}`}>
                            {fullName(student)}
                          </TableCell>
                          <TableCell data-testid={`text-student-email-${student.id}`}>
                            {student.email || <span className="text-muted-foreground">No email</span>}
                          </TableCell>
                          <TableCell data-testid={`text-student-grade-${student.id}`}>
                            {gradeLabel(student.gradeLevel)}
                          </TableCell>
                          {isAdmin && (
                            <TableCell className="text-right">
                              <div className="flex items-center justify-end gap-2">
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  onClick={() => openEditStudentDialog(student)}
                                  data-testid={`button-edit-student-${student.id}`}
                                >
                                  <Edit className="h-4 w-4 mr-1" />
                                  Edit
                                </Button>
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  onClick={() => setDeleteDialog({
                                    type: "delete-student",
                                    studentId: student.id,
                                    studentName: fullName(student),
                                  })}
                                  data-testid={`button-delete-student-${student.id}`}
                                >
                                  <Trash2 className="h-4 w-4 mr-1" />
                                  Delete
                                </Button>
                              </div>
                            </TableCell>
                          )}
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="extensions">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center justify-between gap-3">
                  <span>Chromebook Status</span>
                  <span className="text-sm font-normal text-muted-foreground">
                    {devices.length} registered
                  </span>
                </CardTitle>
              </CardHeader>
              <CardContent>
                {isLoading ? (
                  <div className="py-12 text-center text-muted-foreground">Loading Chromebooks...</div>
                ) : sortedDevices.length === 0 ? (
                  <div className="py-12 text-center">
                    <Laptop className="h-12 w-12 mx-auto mb-4 text-muted-foreground/50" />
                    <h3 className="font-semibold">No Chromebooks registered</h3>
                    <p className="text-sm text-muted-foreground mt-1">
                      Chromebooks appear after the extension checks in.
                    </p>
                  </div>
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Status</TableHead>
                        <TableHead>Extension ID</TableHead>
                        <TableHead>Name</TableHead>
                        <TableHead>Location</TableHead>
                        <TableHead>Version</TableHead>
                        <TableHead>Last check-in</TableHead>
                        {isAdmin && <TableHead className="text-right">Actions</TableHead>}
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {sortedDevices.map((device) => {
                        const status = extensionStatus(device);
                        const StatusIcon = status.icon;
                        return (
                          <TableRow key={device.deviceId} data-testid={`row-extension-${device.deviceId}`}>
                            <TableCell>
                              <Badge variant="outline" className={status.tone}>
                                <StatusIcon className="h-3 w-3 mr-1" />
                                {status.label}
                              </Badge>
                            </TableCell>
                            <TableCell className="font-mono text-xs" data-testid={`text-extension-id-${device.deviceId}`}>
                              {device.deviceId}
                            </TableCell>
                            <TableCell data-testid={`text-extension-name-${device.deviceId}`}>
                              {device.deviceName || <span className="text-muted-foreground">Unnamed</span>}
                            </TableCell>
                            <TableCell data-testid={`text-extension-location-${device.deviceId}`}>
                              {device.classId || <span className="text-muted-foreground">Unassigned</span>}
                            </TableCell>
                            <TableCell data-testid={`text-extension-version-${device.deviceId}`}>
                              {device.extensionVersion || <span className="text-muted-foreground">Unknown</span>}
                            </TableCell>
                            <TableCell data-testid={`text-extension-last-seen-${device.deviceId}`}>
                              {formatDateTime(device.lastSeenAt)}
                            </TableCell>
                            {isAdmin && (
                              <TableCell className="text-right">
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  onClick={() => openEditDeviceDialog(device)}
                                  data-testid={`button-edit-extension-${device.deviceId}`}
                                >
                                  <Edit className="h-4 w-4 mr-1" />
                                  Edit
                                </Button>
                              </TableCell>
                            )}
                          </TableRow>
                        );
                      })}
                    </TableBody>
                  </Table>
                )}
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>
      </main>

      <Dialog open={dialog !== null} onOpenChange={() => setDialog(null)}>
        <DialogContent data-testid={`dialog-${dialog?.type || "closed"}`}>
          <DialogHeader>
            <DialogTitle>
              {dialog?.type === "add-student" && "Add Student"}
              {dialog?.type === "edit-student" && "Edit Student"}
              {dialog?.type === "edit-device" && "Edit Chromebook"}
            </DialogTitle>
            <DialogDescription>
              {dialog?.type === "edit-device"
                ? "Update the extension display name and location."
                : "Edit the school student record used by ClassPilot sign-in."}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            {(dialog?.type === "add-student" || dialog?.type === "edit-student") && (
              <>
                <div className="grid gap-4 md:grid-cols-2">
                  <div className="space-y-2">
                    <Label htmlFor="student-first-name">First Name *</Label>
                    <Input
                      id="student-first-name"
                      name="given-name"
                      autoComplete="given-name"
                      placeholder="First name..."
                      value={studentForm.firstName}
                      onChange={(e) => setStudentForm({ ...studentForm, firstName: e.target.value })}
                      data-testid="input-student-first-name"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="student-last-name">Last Name *</Label>
                    <Input
                      id="student-last-name"
                      name="family-name"
                      autoComplete="family-name"
                      placeholder="Last name..."
                      value={studentForm.lastName}
                      onChange={(e) => setStudentForm({ ...studentForm, lastName: e.target.value })}
                      data-testid="input-student-last-name"
                    />
                  </div>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="student-email">Email</Label>
                  <Input
                    id="student-email"
                    name="email"
                    type="email"
                    autoComplete="email"
                    placeholder="student@example.org..."
                    value={studentForm.email}
                    onChange={(e) => setStudentForm({ ...studentForm, email: e.target.value })}
                    data-testid="input-student-email"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="student-grade">Grade</Label>
                  <Select
                    value={studentForm.gradeLevel || NO_GRADE_VALUE}
                    onValueChange={(value) => setStudentForm({ ...studentForm, gradeLevel: value === NO_GRADE_VALUE ? "" : value })}
                  >
                    <SelectTrigger id="student-grade" data-testid="select-student-grade">
                      <SelectValue placeholder="No grade" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={NO_GRADE_VALUE}>No grade</SelectItem>
                      {STANDARD_GRADES.map((grade) => (
                        <SelectItem key={grade} value={grade}>
                          {gradeLabel(grade)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </>
            )}

            {dialog?.type === "edit-device" && (
              <>
                <div className="space-y-2">
                  <Label htmlFor="extension-id-display">Extension ID</Label>
                  <Input
                    id="extension-id-display"
                    value={dialog.device.deviceId}
                    disabled
                    className="font-mono text-sm"
                    data-testid="input-extension-id-display"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="extension-name">Name</Label>
                  <Input
                    id="extension-name"
                    placeholder="Chromebook cart 1..."
                    value={deviceForm.deviceName}
                    onChange={(e) => setDeviceForm({ ...deviceForm, deviceName: e.target.value })}
                    data-testid="input-extension-name"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="extension-location">Location</Label>
                  <Input
                    id="extension-location"
                    placeholder="Room 101..."
                    value={deviceForm.classId}
                    onChange={(e) => setDeviceForm({ ...deviceForm, classId: e.target.value })}
                    data-testid="input-extension-location"
                  />
                </div>
              </>
            )}
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setDialog(null)}
              disabled={isPending}
              data-testid="button-cancel"
            >
              Cancel
            </Button>
            <Button
              onClick={handleSave}
              disabled={isPending}
              data-testid="button-save"
            >
              {isPending ? "Saving..." : "Save"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={deleteDialog !== null} onOpenChange={() => setDeleteDialog(null)}>
        <AlertDialogContent data-testid="dialog-delete-confirm">
          <AlertDialogHeader>
            <AlertDialogTitle>Delete student record?</AlertDialogTitle>
            <AlertDialogDescription>
              This deletes <strong>{deleteDialog?.studentName}</strong> from the school roster. This is not a Chromebook assignment.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isPending} data-testid="button-cancel-delete">
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDelete}
              disabled={isPending}
              data-testid="button-confirm-delete"
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {isPending ? "Deleting..." : "Delete Student"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <Dialog open={showGradeDialog} onOpenChange={setShowGradeDialog}>
        <DialogContent data-testid="dialog-manage-grades-roster">
          <DialogHeader>
            <DialogTitle>Manage Grades</DialogTitle>
            <DialogDescription>
              These grades appear as roster filters.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label>Current Grades</Label>
              <div className="flex flex-wrap gap-2">
                {manualGrades.length === 0 ? (
                  <span className="text-sm text-muted-foreground">No manual grade filters</span>
                ) : (
                  manualGrades.map((grade) => (
                    <Badge key={grade} variant="secondary" className="text-sm px-3 py-1" data-testid={`badge-grade-${grade}`}>
                      {gradeLabel(grade)}
                      <button
                        type="button"
                        onClick={() => handleDeleteGrade(grade)}
                        className="ml-2 hover:text-destructive"
                        aria-label={`Remove ${gradeLabel(grade)}`}
                        data-testid={`button-delete-grade-${grade}`}
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </Badge>
                  ))
                )}
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="new-grade">Add Grade</Label>
              <div className="flex gap-2">
                <Input
                  id="new-grade"
                  placeholder="PK, K, or 8..."
                  value={newGrade}
                  onChange={(e) => setNewGrade(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      handleAddGrade();
                    }
                  }}
                  data-testid="input-new-grade-roster"
                />
                <Button
                  onClick={handleAddGrade}
                  disabled={updateGradesMutation.isPending}
                  data-testid="button-add-grade-roster"
                >
                  <Plus className="h-4 w-4 mr-2" />
                  Add
                </Button>
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setShowGradeDialog(false);
                setNewGrade("");
              }}
              data-testid="button-close-grade-dialog-roster"
            >
              Done
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
