import { useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  ArrowLeft,
  Archive,
  Check,
  ChevronDown,
  ChevronRight,
  ChevronsUpDown,
  Edit,
  GraduationCap,
  Loader2,
  Plus,
  Search,
  Trash2,
  UserPlus,
  Users,
  X,
} from "lucide-react";
import { useNavigate } from "react-router-dom";

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
import { Button } from "../../../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../../../components/ui/card";
import { Checkbox } from "../../../components/ui/checkbox";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "../../../components/ui/collapsible";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "../../../components/ui/command";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../../../components/ui/dialog";
import { Input } from "../../../components/ui/input";
import { Label } from "../../../components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "../../../components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../../components/ui/select";
import { Switch } from "../../../components/ui/switch";
import { Tabs, TabsList, TabsTrigger } from "../../../components/ui/tabs";
import { ThemeToggle } from "../../../components/ThemeToggle";
import { useToast } from "../../../hooks/use-toast";
import { useClassPilotAuth } from "../../../hooks/useClassPilotAuth";
import { apiRequest, queryClient } from "../../../lib/queryClient";
import { EditStudentDialog } from "../components/EditStudentDialog";

const ADMIN_CLASSES_KEY = ["classpilot-admin-classes"];
const TEACHABLE_ROLES = new Set(["teacher", "admin", "school_admin"]);
const GRADE_VALUES = ["PK", "K", "1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11", "12"];
const NONE = "__none__";
const ALL = "__all__";
const UNGRADED = "__ungraded__";
const CLASSROOM_IMPORT_ENABLED = import.meta.env.VITE_CLASSPILOT_CLASSROOM_IMPORT_ENABLED === "true";

function getErrorMessage(error) {
  return error?.response?.data?.error || error?.message || "Something went wrong";
}

function displayName(person) {
  return person?.displayName
    || [person?.firstName, person?.lastName].filter(Boolean).join(" ")
    || person?.email
    || person?.username
    || "Unknown";
}

function lastNameKey(person) {
  const name = displayName(person).trim().toLowerCase();
  const parts = name.split(/\s+/);
  return parts.length > 1 ? parts.at(-1) : parts[0] || "";
}

function normalizeGrade(grade) {
  if (grade === undefined || grade === null || String(grade).trim() === "") return null;
  const raw = String(grade).trim();
  const compact = raw.toLowerCase().replace(/\s+/g, "").replace(/-/g, "");
  if (["pk", "prek", "prekindergarten", "prekindergarden"].includes(compact)) return "PK";
  if (["k", "kg", "kindergarten", "kindergarden"].includes(compact)) return "K";
  const numeric = compact.replace(/(st|nd|rd|th)$/i, "");
  if (/^\d+$/.test(numeric)) {
    const normalized = String(parseInt(numeric, 10));
    return GRADE_VALUES.includes(normalized) ? normalized : raw;
  }
  return raw;
}

function formatGrade(grade) {
  const normalized = normalizeGrade(grade);
  if (!normalized) return "Ungraded";
  if (normalized === "PK" || normalized === "K") return normalized;
  return `Grade ${normalized}`;
}

function formatTime12h(time24) {
  if (!time24) return "";
  const [h, m] = time24.split(":");
  const hour = parseInt(h, 10);
  if (Number.isNaN(hour)) return time24;
  const ampm = hour >= 12 ? "PM" : "AM";
  const hour12 = hour === 0 ? 12 : hour > 12 ? hour - 12 : hour;
  return `${hour12}:${m} ${ampm}`;
}

function classMatchesGrade(group, gradeFilter) {
  if (gradeFilter === ALL) return true;
  if (gradeFilter === UNGRADED) return !normalizeGrade(group.gradeLevel);
  return normalizeGrade(group.gradeLevel) === gradeFilter;
}

function studentMatchesGrade(student, gradeFilter) {
  if (gradeFilter === ALL) return true;
  if (gradeFilter === UNGRADED) return !normalizeGrade(student.gradeLevel);
  return normalizeGrade(student.gradeLevel) === gradeFilter;
}

function buildTeacherLabel(teacher) {
  if (!teacher) return "Select a teacher";
  const roleLabel = teacher.role === "admin" || teacher.role === "school_admin" ? " (Admin)" : "";
  return `${displayName(teacher)}${roleLabel}`;
}

function getClassTeacher(group, teachers) {
  return group.primaryTeacher || teachers.find((teacher) => teacher.id === group.teacherId) || null;
}

function ClassFormDialog({
  mode,
  open,
  onOpenChange,
  initialClass,
  teachers,
  onSubmit,
  isSaving,
}) {
  const [name, setName] = useState(() => initialClass?.name || "");
  const [teacherId, setTeacherId] = useState(() => initialClass?.teacherId || initialClass?.primaryTeacher?.id || "");
  const [gradeLevel, setGradeLevel] = useState(() => initialClass?.gradeLevel ? normalizeGrade(initialClass.gradeLevel) : NONE);
  const [periodLabel, setPeriodLabel] = useState(() => initialClass?.periodLabel || "");
  const [description, setDescription] = useState(() => initialClass?.description || "");
  const [schoolYear, setSchoolYear] = useState(() => initialClass?.schoolYear || "");
  const [term, setTerm] = useState(() => initialClass?.term || "");
  const [scheduleEnabled, setScheduleEnabled] = useState(() => initialClass?.scheduleEnabled === true);
  const [blockStartTime, setBlockStartTime] = useState(() => initialClass?.blockStartTime || "");
  const [blockEndTime, setBlockEndTime] = useState(() => initialClass?.blockEndTime || "");
  const [coTeacherIds, setCoTeacherIds] = useState(() => new Set((initialClass?.coTeachers || []).map((teacher) => teacher.id).filter(Boolean)));
  const [teacherPickerOpen, setTeacherPickerOpen] = useState(false);
  const [coTeacherPickerOpen, setCoTeacherPickerOpen] = useState(false);

  const sortedTeachers = useMemo(
    () => [...teachers].sort((a, b) => {
      const byLast = lastNameKey(a).localeCompare(lastNameKey(b));
      return byLast || displayName(a).localeCompare(displayName(b));
    }),
    [teachers]
  );

  const selectedTeacher = sortedTeachers.find((teacher) => teacher.id === teacherId);
  const availableCoTeachers = sortedTeachers.filter((teacher) => teacher.id !== teacherId);
  const selectedCoTeachers = availableCoTeachers.filter((teacher) => coTeacherIds.has(teacher.id));

  const toggleCoTeacher = (id) => {
    setCoTeacherIds((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const submit = () => {
    onSubmit({
      name: name.trim(),
      primaryTeacherId: teacherId,
      gradeLevel: gradeLevel === NONE ? null : gradeLevel,
      periodLabel: periodLabel.trim() || null,
      description: description.trim() || null,
      schoolYear: schoolYear.trim() || null,
      term: term.trim() || null,
      scheduleEnabled,
      blockStartTime: scheduleEnabled ? blockStartTime : null,
      blockEndTime: scheduleEnabled ? blockEndTime : null,
      coTeacherIds: Array.from(coTeacherIds).filter((id) => id !== teacherId),
    });
  };

  const title = mode === "edit" ? "Edit Class" : "Create Class";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            Official ClassPilot classes can be owned by teachers, admins, or school admins.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4 max-h-[70vh] overflow-y-auto pr-1">
          <div className="grid gap-2">
            <Label htmlFor="class-name">Class Name</Label>
            <Input
              id="class-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Example: Grade 8 Science"
              data-testid="input-class-name"
            />
          </div>

          <div className="grid gap-2">
            <Label>Primary Teacher</Label>
            <Popover open={teacherPickerOpen} onOpenChange={setTeacherPickerOpen}>
              <PopoverTrigger asChild>
                <Button
                  variant="outline"
                  role="combobox"
                  aria-expanded={teacherPickerOpen}
                  className="justify-between font-normal"
                  data-testid="select-primary-teacher"
                >
                  {buildTeacherLabel(selectedTeacher)}
                  <ChevronsUpDown className="h-4 w-4 opacity-50" />
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-[--radix-popover-trigger-width] p-0" align="start">
                <Command>
                  <CommandInput placeholder="Search staff..." />
                  <CommandList>
                    <CommandEmpty>No teachable staff found.</CommandEmpty>
                    <CommandGroup>
                      {sortedTeachers.map((teacher) => (
                        <CommandItem
                          key={teacher.id}
                          value={`${displayName(teacher)} ${teacher.email || ""}`}
                          onSelect={() => {
                            setTeacherId(teacher.id);
                            setCoTeacherIds((previous) => {
                              const next = new Set(previous);
                              next.delete(teacher.id);
                              return next;
                            });
                            setTeacherPickerOpen(false);
                          }}
                        >
                          <Check className={`mr-2 h-4 w-4 ${teacherId === teacher.id ? "opacity-100" : "opacity-0"}`} />
                          {buildTeacherLabel(teacher)}
                        </CommandItem>
                      ))}
                    </CommandGroup>
                  </CommandList>
                </Command>
              </PopoverContent>
            </Popover>
          </div>

          <div className="grid gap-2">
            <Label>Co-Teachers</Label>
            <div className="flex flex-wrap gap-2">
              {selectedCoTeachers.length === 0 ? (
                <span className="text-sm text-muted-foreground">No co-teachers selected</span>
              ) : selectedCoTeachers.map((teacher) => (
                <Button
                  key={teacher.id}
                  type="button"
                  variant="secondary"
                  size="sm"
                  onClick={() => toggleCoTeacher(teacher.id)}
                  aria-label={`Remove co-teacher ${displayName(teacher)}`}
                  title={`Remove ${displayName(teacher)}`}
                >
                  {displayName(teacher)}
                  <X className="ml-2 h-3.5 w-3.5" />
                </Button>
              ))}
            </div>
            <Popover open={coTeacherPickerOpen} onOpenChange={setCoTeacherPickerOpen}>
              <PopoverTrigger asChild>
                <Button type="button" variant="outline" className="justify-start" data-testid="button-add-co-teacher">
                  <UserPlus className="mr-2 h-4 w-4" />
                  Stage Co-Teacher
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-[--radix-popover-trigger-width] p-0" align="start">
                <Command>
                  <CommandInput placeholder="Search co-teachers..." />
                  <CommandList>
                    <CommandEmpty>No available co-teachers.</CommandEmpty>
                    <CommandGroup>
                      {availableCoTeachers.map((teacher) => (
                        <CommandItem
                          key={teacher.id}
                          value={`${displayName(teacher)} ${teacher.email || ""}`}
                          onSelect={() => toggleCoTeacher(teacher.id)}
                        >
                          <Check className={`mr-2 h-4 w-4 ${coTeacherIds.has(teacher.id) ? "opacity-100" : "opacity-0"}`} />
                          {buildTeacherLabel(teacher)}
                        </CommandItem>
                      ))}
                    </CommandGroup>
                  </CommandList>
                </Command>
              </PopoverContent>
            </Popover>
            <p className="text-xs text-muted-foreground">Co-teacher changes are saved only when you click Save Changes.</p>
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            <div className="grid gap-2">
              <Label>Grade</Label>
              <Select value={gradeLevel} onValueChange={setGradeLevel}>
                <SelectTrigger data-testid="select-grade-level">
                  <SelectValue placeholder="Select grade" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE}>No grade</SelectItem>
                  {GRADE_VALUES.map((grade) => (
                    <SelectItem key={grade} value={grade}>{formatGrade(grade)}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="period-label">Class Block</Label>
              <Input
                id="period-label"
                value={periodLabel}
                onChange={(event) => setPeriodLabel(event.target.value)}
                placeholder="Example: Period 3"
              />
            </div>
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            <div className="grid gap-2">
              <Label htmlFor="school-year">School Year</Label>
              <Input
                id="school-year"
                value={schoolYear}
                onChange={(event) => setSchoolYear(event.target.value)}
                placeholder="2026-2027"
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="term">Term</Label>
              <Input
                id="term"
                value={term}
                onChange={(event) => setTerm(event.target.value)}
                placeholder="Fall"
              />
            </div>
          </div>

          <div className="grid gap-2">
            <Label htmlFor="class-description">Description</Label>
            <Input
              id="class-description"
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              placeholder="Optional notes"
            />
          </div>

          <div className="grid gap-3 rounded-md border p-3">
            <div className="flex items-center justify-between gap-3">
              <Label htmlFor="schedule-enabled">Automatic Scheduling</Label>
              <Switch id="schedule-enabled" checked={scheduleEnabled} onCheckedChange={setScheduleEnabled} />
            </div>
            <div className={`grid gap-3 md:grid-cols-2 ${scheduleEnabled ? "" : "opacity-50"}`}>
              <div className="grid gap-2">
                <Label htmlFor="block-start">Start Time</Label>
                <Input
                  id="block-start"
                  type="time"
                  value={blockStartTime}
                  disabled={!scheduleEnabled}
                  onChange={(event) => setBlockStartTime(event.target.value)}
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="block-end">End Time</Label>
                <Input
                  id="block-end"
                  type="time"
                  value={blockEndTime}
                  disabled={!scheduleEnabled}
                  onChange={(event) => setBlockEndTime(event.target.value)}
                />
              </div>
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button
            type="button"
            onClick={submit}
            disabled={isSaving || !name.trim() || !teacherId || (scheduleEnabled && (!blockStartTime || !blockEndTime))}
            data-testid="button-save-class"
          >
            {isSaving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
            {mode === "edit" ? "Save Changes" : "Create Class"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ClassCard({
  group,
  teacher,
  expanded,
  onToggleExpanded,
  onEdit,
  onArchive,
  onDelete,
}) {
  const { toast } = useToast();
  const [editingStudent, setEditingStudent] = useState(null);

  const rosterQuery = useQuery({
    queryKey: ["admin-class-students", group.id],
    queryFn: () => apiRequest("GET", `/classpilot/admin/classes/${group.id}/students`),
    enabled: expanded,
    select: (data) => data?.students || [],
  });

  const removeStudentMutation = useMutation({
    mutationFn: (studentId) => apiRequest("DELETE", `/classpilot/admin/classes/${group.id}/students/${studentId}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ADMIN_CLASSES_KEY });
      queryClient.invalidateQueries({ queryKey: ["admin-class-students", group.id] });
      toast({ title: "Student removed", description: "The student was removed from this class roster." });
    },
    onError: (error) => {
      toast({ variant: "destructive", title: "Failed to remove student", description: getErrorMessage(error) });
    },
  });

  const classStudents = rosterQuery.data || [];
  const coTeacherNames = (group.coTeachers || []).map(displayName).join(", ");
  const scheduleLabel = group.scheduleEnabled && group.blockStartTime && group.blockEndTime
    ? `${formatTime12h(group.blockStartTime)} - ${formatTime12h(group.blockEndTime)}`
    : null;

  const removeStudent = (student) => {
    const name = student.studentName || displayName(student);
    if (window.confirm(`Remove ${name} from ${group.name}?`)) {
      removeStudentMutation.mutate(student.id);
    }
  };

  return (
    <Collapsible open={expanded} onOpenChange={onToggleExpanded} className="rounded-lg border bg-background">
      <div className="flex items-center justify-between gap-3 p-3">
        <div className="flex min-w-0 flex-1 items-start gap-2">
          <CollapsibleTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7 shrink-0"
              aria-label={expanded ? "Collapse class roster" : "Expand class roster"}
              title={expanded ? "Collapse roster" : "Expand roster"}
              data-testid={`button-toggle-${group.id}`}
            >
              {expanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
            </Button>
          </CollapsibleTrigger>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <p className="font-medium leading-tight">{group.name}</p>
              {group.status === "archived" ? (
                <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">Archived</span>
              ) : null}
            </div>
            <p className="text-sm text-muted-foreground">
              {displayName(teacher)}
              {group.gradeLevel ? ` - ${formatGrade(group.gradeLevel)}` : ""}
              {group.periodLabel ? ` - ${group.periodLabel}` : ""}
              {scheduleLabel ? ` - ${scheduleLabel}` : ""}
            </p>
            {coTeacherNames ? (
              <p className="text-xs text-muted-foreground">Co-teachers: {coTeacherNames}</p>
            ) : null}
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          <span className="text-sm text-muted-foreground" data-testid={`student-count-${group.id}`}>
            {group.studentCount || 0} {(group.studentCount || 0) === 1 ? "student" : "students"}
          </span>
          <Button
            variant="ghost"
            size="icon"
            onClick={onEdit}
            aria-label={`Edit ${group.name}`}
            title="Edit class"
            data-testid={`button-edit-${group.id}`}
          >
            <Edit className="h-4 w-4" />
          </Button>
          {group.status === "archived" ? (
            <Button
              variant="ghost"
              size="icon"
              onClick={onDelete}
              aria-label={`Permanently delete ${group.name}`}
              title="Delete permanently"
              data-testid={`button-delete-${group.id}`}
            >
              <Trash2 className="h-4 w-4 text-destructive" />
            </Button>
          ) : (
            <Button
              variant="ghost"
              size="icon"
              onClick={onArchive}
              aria-label={`Archive ${group.name}`}
              title="Archive class"
              data-testid={`button-archive-${group.id}`}
            >
              <Archive className="h-4 w-4 text-destructive" />
            </Button>
          )}
        </div>
      </div>

      <CollapsibleContent>
        <div className="border-t px-3 py-3">
          {rosterQuery.isLoading ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              Loading roster...
            </div>
          ) : rosterQuery.error ? (
            <p className="text-sm text-destructive">{getErrorMessage(rosterQuery.error)}</p>
          ) : classStudents.length === 0 ? (
            <p className="text-sm text-muted-foreground">No students assigned yet.</p>
          ) : (
            <div className="space-y-2">
              {classStudents.map((student) => (
                <div key={student.id} className="flex items-center justify-between gap-3 rounded-md px-2 py-1.5 hover:bg-muted/60">
                  <div className="min-w-0">
                    <p className="truncate text-sm">{student.studentName || displayName(student)}</p>
                    <p className="text-xs text-muted-foreground">
                      {student.studentEmail || student.email || "No email"} - {formatGrade(student.gradeLevel)}
                    </p>
                  </div>
                  <div className="flex items-center gap-1">
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7"
                      onClick={() => setEditingStudent(student)}
                      aria-label={`Edit school student record for ${student.studentName || displayName(student)}`}
                      title="Edit school student record"
                    >
                      <Edit className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7"
                      onClick={() => removeStudent(student)}
                      disabled={removeStudentMutation.isPending}
                      aria-label={`Remove ${student.studentName || displayName(student)} from this class`}
                      title="Remove from class"
                    >
                      <X className="h-3.5 w-3.5 text-destructive" />
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </CollapsibleContent>

      {editingStudent ? (
        <EditStudentDialog
          student={editingStudent}
          open={!!editingStudent}
          onOpenChange={(nextOpen) => {
            if (!nextOpen) setEditingStudent(null);
          }}
          onSuccess={() => {
            queryClient.invalidateQueries({ queryKey: ["admin-class-students", group.id] });
            queryClient.invalidateQueries({ queryKey: ["/api/admin/teacher-students"] });
          }}
        />
      ) : null}
    </Collapsible>
  );
}

export default function AdminClasses() {
  const navigate = useNavigate();
  const { toast } = useToast();
  const { currentUser, isLoading: authLoading } = useClassPilotAuth();

  const [statusFilter, setStatusFilter] = useState("active");
  const [search, setSearch] = useState("");
  const [schoolYearFilter, setSchoolYearFilter] = useState("");
  const [termFilter, setTermFilter] = useState("");
  const [sortBy, setSortBy] = useState("name");
  const [classGradeFilter, setClassGradeFilter] = useState(ALL);
  const [assignGradeFilter, setAssignGradeFilter] = useState(ALL);
  const [selectedClassId, setSelectedClassId] = useState("");
  const [selectedStudents, setSelectedStudents] = useState(new Set());
  const [expandedClasses, setExpandedClasses] = useState(new Set());
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [editingClass, setEditingClass] = useState(null);
  const [archiveTarget, setArchiveTarget] = useState(null);
  const [deleteTarget, setDeleteTarget] = useState(null);

  const isAdmin = currentUser?.isSuperAdmin || currentUser?.role === "admin" || currentUser?.role === "school_admin";

  const queryFilters = useMemo(() => {
    const params = new URLSearchParams();
    params.set("status", statusFilter);
    if (search.trim()) params.set("search", search.trim());
    if (schoolYearFilter.trim()) params.set("schoolYear", schoolYearFilter.trim());
    if (termFilter.trim()) params.set("term", termFilter.trim());
    return params.toString();
  }, [schoolYearFilter, search, statusFilter, termFilter]);

  const classesQuery = useQuery({
    queryKey: [...ADMIN_CLASSES_KEY, queryFilters],
    queryFn: () => apiRequest("GET", `/classpilot/admin/classes?${queryFilters}`),
    enabled: isAdmin,
    select: (data) => data?.classes || [],
  });

  const teachersQuery = useQuery({
    queryKey: ["/api/admin/teachers"],
    queryFn: () => apiRequest("GET", "/admin/teachers"),
    enabled: isAdmin,
    select: (data) => (data?.teachers || []).filter((teacher) => TEACHABLE_ROLES.has(teacher.role)),
  });

  const studentsQuery = useQuery({
    queryKey: ["/api/admin/teacher-students"],
    queryFn: () => apiRequest("GET", "/admin/teacher-students"),
    enabled: isAdmin,
    select: (data) => data?.students || [],
  });

  const createClassMutation = useMutation({
    mutationFn: (payload) => apiRequest("POST", "/classpilot/admin/classes", payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ADMIN_CLASSES_KEY });
      setCreateDialogOpen(false);
      toast({ title: "Class created", description: "The official class is ready for roster assignment." });
    },
    onError: (error) => {
      toast({ variant: "destructive", title: "Failed to create class", description: getErrorMessage(error) });
    },
  });

  const updateClassMutation = useMutation({
    mutationFn: ({ id, payload }) => apiRequest("PATCH", `/classpilot/admin/classes/${id}`, payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ADMIN_CLASSES_KEY });
      setEditingClass(null);
      toast({ title: "Class updated", description: "Class details and teachers were saved together." });
    },
    onError: (error) => {
      toast({ variant: "destructive", title: "Failed to update class", description: getErrorMessage(error) });
    },
  });

  const assignStudentsMutation = useMutation({
    mutationFn: ({ classId, studentIds }) => apiRequest("POST", `/classpilot/admin/classes/${classId}/students`, { studentIds }),
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ADMIN_CLASSES_KEY });
      queryClient.invalidateQueries({ queryKey: ["admin-class-students", selectedClassId] });
      setSelectedStudents(new Set());
      toast({
        title: "Roster updated",
        description: `${result.added || 0} added, ${result.alreadyPresent || 0} already assigned, ${(result.failed || []).length} failed.`,
      });
    },
    onError: (error) => {
      toast({ variant: "destructive", title: "Failed to assign students", description: getErrorMessage(error) });
    },
  });

  const archiveClassMutation = useMutation({
    mutationFn: (id) => apiRequest("POST", `/classpilot/admin/classes/${id}/archive`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ADMIN_CLASSES_KEY });
      setArchiveTarget(null);
      setSelectedClassId("");
      toast({ title: "Class archived", description: "The class is hidden from active class management." });
    },
    onError: (error) => {
      toast({ variant: "destructive", title: "Failed to archive class", description: getErrorMessage(error) });
    },
  });

  const deleteClassMutation = useMutation({
    mutationFn: (id) => apiRequest("DELETE", `/classpilot/admin/classes/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ADMIN_CLASSES_KEY });
      setDeleteTarget(null);
      toast({ title: "Class deleted", description: "The empty archived class was permanently deleted." });
    },
    onError: (error) => {
      toast({ variant: "destructive", title: "Delete blocked", description: getErrorMessage(error) });
    },
  });

  const classes = useMemo(() => classesQuery.data || [], [classesQuery.data]);
  const teachers = useMemo(() => teachersQuery.data || [], [teachersQuery.data]);
  const students = useMemo(() => studentsQuery.data || [], [studentsQuery.data]);

  const sortedClasses = useMemo(() => {
    const copy = [...classes];
    copy.sort((a, b) => {
      if (sortBy === "teacher") {
        const teacherA = displayName(getClassTeacher(a, teachers));
        const teacherB = displayName(getClassTeacher(b, teachers));
        return teacherA.localeCompare(teacherB) || a.name.localeCompare(b.name);
      }
      if (sortBy === "grade") {
        return formatGrade(a.gradeLevel).localeCompare(formatGrade(b.gradeLevel)) || a.name.localeCompare(b.name);
      }
      return a.name.localeCompare(b.name);
    });
    return copy;
  }, [classes, sortBy, teachers]);

  const classGrades = useMemo(() => {
    const grades = new Set();
    let hasUngraded = false;
    for (const group of classes) {
      const grade = normalizeGrade(group.gradeLevel);
      if (grade) grades.add(grade);
      else hasUngraded = true;
    }
    const ordered = GRADE_VALUES.filter((grade) => grades.has(grade));
    if (hasUngraded) ordered.push(UNGRADED);
    return ordered;
  }, [classes]);

  const studentGrades = useMemo(() => {
    const grades = new Set();
    let hasUngraded = false;
    for (const student of students) {
      const grade = normalizeGrade(student.gradeLevel);
      if (grade) grades.add(grade);
      else hasUngraded = true;
    }
    const ordered = GRADE_VALUES.filter((grade) => grades.has(grade));
    if (hasUngraded) ordered.push(UNGRADED);
    return ordered;
  }, [students]);

  const filteredClasses = useMemo(
    () => sortedClasses.filter((group) => classMatchesGrade(group, classGradeFilter)),
    [classGradeFilter, sortedClasses]
  );

  const assignFilteredStudents = useMemo(
    () => students.filter((student) => studentMatchesGrade(student, assignGradeFilter)),
    [assignGradeFilter, students]
  );

  const selectedClass = classes.find((group) => group.id === selectedClassId);

  const setClassGradeAndResetHiddenClass = (grade) => {
    setClassGradeFilter(grade);
    if (selectedClassId && !sortedClasses.some((group) => group.id === selectedClassId && classMatchesGrade(group, grade))) {
      setSelectedClassId("");
    }
  };

  const toggleExpanded = (id) => {
    setExpandedClasses((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleStudentSelection = (studentId) => {
    setSelectedStudents((previous) => {
      const next = new Set(previous);
      if (next.has(studentId)) next.delete(studentId);
      else next.add(studentId);
      return next;
    });
  };

  const selectAllFilteredStudents = () => {
    setSelectedStudents((previous) => {
      const next = new Set(previous);
      for (const student of assignFilteredStudents) next.add(student.id);
      return next;
    });
  };

  const submitCreate = (payload) => {
    createClassMutation.mutate(payload);
  };

  const submitEdit = (payload) => {
    if (!editingClass) return;
    updateClassMutation.mutate({ id: editingClass.id, payload });
  };

  const assignStudents = () => {
    if (!selectedClassId || selectedStudents.size === 0) return;
    assignStudentsMutation.mutate({
      classId: selectedClassId,
      studentIds: Array.from(selectedStudents),
    });
  };

  if (authLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin" />
      </div>
    );
  }

  if (!isAdmin) {
    return (
      <div className="container mx-auto max-w-3xl p-6">
        <Card>
          <CardHeader>
            <CardTitle>Access denied</CardTitle>
            <CardDescription>Class Management is available to school admins only.</CardDescription>
          </CardHeader>
          <CardContent>
            <Button variant="outline" onClick={() => navigate("/classpilot")}>
              <ArrowLeft className="mr-2 h-4 w-4" />
              Dashboard
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  const isLoading = classesQuery.isLoading || teachersQuery.isLoading || studentsQuery.isLoading;
  const queryError = classesQuery.error || teachersQuery.error || studentsQuery.error;

  return (
    <div className="min-h-screen bg-muted/30">
      <div className="container mx-auto max-w-7xl space-y-6 p-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-3xl font-semibold">Class Management</h1>
            <p className="text-muted-foreground">
              Create official class rosters, assign teachers, and manage student membership.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <ThemeToggle />
            <Button variant="outline" onClick={() => navigate("/classpilot/admin")} data-testid="button-back-admin">
              <ArrowLeft className="mr-2 h-4 w-4" />
              Admin Panel
            </Button>
          </div>
        </div>

        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(360px,0.7fr)]">
          <div className="space-y-6">
            <Card>
              <CardHeader>
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <CardTitle className="flex items-center gap-2">
                      <Users className="h-5 w-5" />
                      Classes
                    </CardTitle>
                    <CardDescription>
                      {filteredClasses.length} visible of {classes.length} loaded classes
                    </CardDescription>
                  </div>
                  <Button onClick={() => setCreateDialogOpen(true)} data-testid="button-create-class">
                    <Plus className="mr-2 h-4 w-4" />
                    Create Class
                  </Button>
                </div>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_160px_150px]">
                  <div className="relative">
                    <Search className="absolute left-3 top-3 h-4 w-4 text-muted-foreground" />
                    <Input
                      value={search}
                      onChange={(event) => setSearch(event.target.value)}
                      className="pl-9"
                      placeholder="Search classes or teachers"
                      data-testid="input-search-classes"
                    />
                  </div>
                  <Select value={sortBy} onValueChange={setSortBy}>
                    <SelectTrigger aria-label="Sort classes">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="name">Sort by name</SelectItem>
                      <SelectItem value="teacher">Sort by teacher</SelectItem>
                      <SelectItem value="grade">Sort by grade</SelectItem>
                    </SelectContent>
                  </Select>
                  <Select value={statusFilter} onValueChange={setStatusFilter}>
                    <SelectTrigger aria-label="Filter class status">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="active">Active</SelectItem>
                      <SelectItem value="archived">Archived</SelectItem>
                      <SelectItem value="all">All statuses</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                <div className="grid gap-3 md:grid-cols-2">
                  <Input
                    value={schoolYearFilter}
                    onChange={(event) => setSchoolYearFilter(event.target.value)}
                    placeholder="School year filter"
                  />
                  <Input
                    value={termFilter}
                    onChange={(event) => setTermFilter(event.target.value)}
                    placeholder="Term filter"
                  />
                </div>

                <Tabs value={classGradeFilter} onValueChange={setClassGradeAndResetHiddenClass}>
                  <TabsList className="h-auto flex-wrap justify-start">
                    <TabsTrigger value={ALL}>All Grades</TabsTrigger>
                    {classGrades.map((grade) => (
                      <TabsTrigger key={grade} value={grade}>
                        {grade === UNGRADED ? "Ungraded" : formatGrade(grade)}
                      </TabsTrigger>
                    ))}
                  </TabsList>
                </Tabs>

                {CLASSROOM_IMPORT_ENABLED ? (
                  <div className="rounded-md border border-dashed p-3 text-sm text-muted-foreground">
                    Google Classroom import is behind a feature flag while the normalized preview/import workflow is rebuilt.
                  </div>
                ) : null}

                {queryError ? (
                  <div className="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
                    {getErrorMessage(queryError)}
                  </div>
                ) : isLoading ? (
                  <div className="flex items-center justify-center gap-2 py-10 text-muted-foreground">
                    <Loader2 className="h-5 w-5 animate-spin" />
                    Loading class management data...
                  </div>
                ) : filteredClasses.length === 0 ? (
                  <div className="py-10 text-center text-muted-foreground">
                    <GraduationCap className="mx-auto mb-3 h-12 w-12 opacity-30" />
                    <p>No classes match these filters.</p>
                  </div>
                ) : (
                  <div className="space-y-3">
                    {filteredClasses.map((group) => (
                      <ClassCard
                        key={group.id}
                        group={group}
                        teacher={getClassTeacher(group, teachers)}
                        expanded={expandedClasses.has(group.id)}
                        onToggleExpanded={() => toggleExpanded(group.id)}
                        onEdit={() => setEditingClass(group)}
                        onArchive={() => setArchiveTarget(group)}
                        onDelete={() => setDeleteTarget(group)}
                      />
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          </div>

          <Card>
            <CardHeader>
              <CardTitle>Assign Students to Class</CardTitle>
              <CardDescription>Select a class and add roster members in one batch.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid gap-2">
                <Label>Select Class</Label>
                <Select value={selectedClassId || NONE} onValueChange={(value) => setSelectedClassId(value === NONE ? "" : value)}>
                  <SelectTrigger data-testid="select-class">
                    <SelectValue placeholder="Choose a class" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NONE}>Choose a class</SelectItem>
                    {filteredClasses
                      .filter((group) => group.status !== "archived")
                      .map((group) => (
                        <SelectItem key={group.id} value={group.id}>
                          {group.name} ({displayName(getClassTeacher(group, teachers))})
                        </SelectItem>
                      ))}
                  </SelectContent>
                </Select>
                {selectedClass ? (
                  <p className="text-xs text-muted-foreground">Selected: {selectedClass.name}</p>
                ) : null}
              </div>

              <div className="grid gap-2">
                <Label>Select Students ({selectedStudents.size} selected)</Label>
                <Tabs value={assignGradeFilter} onValueChange={setAssignGradeFilter}>
                  <TabsList className="h-auto flex-wrap justify-start">
                    <TabsTrigger value={ALL}>All students</TabsTrigger>
                    {studentGrades.map((grade) => (
                      <TabsTrigger key={grade} value={grade}>
                        {grade === UNGRADED ? "Ungraded" : formatGrade(grade)}
                      </TabsTrigger>
                    ))}
                  </TabsList>
                </Tabs>

                <div className="flex flex-wrap gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={selectAllFilteredStudents}
                    disabled={assignFilteredStudents.length === 0}
                    data-testid="button-select-all-students"
                  >
                    Select All ({assignFilteredStudents.length})
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setSelectedStudents(new Set())}
                    disabled={selectedStudents.size === 0}
                  >
                    Clear Selection
                  </Button>
                </div>

                <div className="max-h-96 space-y-2 overflow-y-auto rounded-lg border p-3">
                  {assignFilteredStudents.length === 0 ? (
                    <p className="py-6 text-center text-sm text-muted-foreground">No students match this grade filter.</p>
                  ) : assignFilteredStudents.map((student) => (
                    <div key={student.id} className="flex items-center gap-2 rounded-md p-2 hover:bg-muted/60">
                      <Checkbox
                        id={`student-${student.id}`}
                        checked={selectedStudents.has(student.id)}
                        onCheckedChange={() => toggleStudentSelection(student.id)}
                        data-testid={`checkbox-student-${student.id}`}
                      />
                      <Label htmlFor={`student-${student.id}`} className="min-w-0 flex-1 cursor-pointer text-sm font-normal">
                        <span className="block truncate">{student.studentName || displayName(student)}</span>
                        <span className="text-xs text-muted-foreground">{formatGrade(student.gradeLevel)}</span>
                      </Label>
                    </div>
                  ))}
                </div>
              </div>

              <Button
                className="w-full"
                onClick={assignStudents}
                disabled={!selectedClassId || selectedStudents.size === 0 || assignStudentsMutation.isPending}
                data-testid="button-assign-students"
              >
                {assignStudentsMutation.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                Assign {selectedStudents.size} {selectedStudents.size === 1 ? "Student" : "Students"}
              </Button>
            </CardContent>
          </Card>
        </div>
      </div>

      <ClassFormDialog
        mode="create"
        key={createDialogOpen ? "create-open" : "create-closed"}
        open={createDialogOpen}
        onOpenChange={setCreateDialogOpen}
        teachers={teachers}
        onSubmit={submitCreate}
        isSaving={createClassMutation.isPending}
      />

      <ClassFormDialog
        mode="edit"
        key={editingClass?.id || "edit-closed"}
        open={!!editingClass}
        onOpenChange={(open) => {
          if (!open) setEditingClass(null);
        }}
        initialClass={editingClass}
        teachers={teachers}
        onSubmit={submitEdit}
        isSaving={updateClassMutation.isPending}
      />

      <AlertDialog open={!!archiveTarget} onOpenChange={(open) => !open && setArchiveTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Archive Class</AlertDialogTitle>
            <AlertDialogDescription>
              Archive {archiveTarget?.name}? The roster and history will be preserved, but the class will leave the active list.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => archiveTarget && archiveClassMutation.mutate(archiveTarget.id)}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Archive
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={!!deleteTarget} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Class Permanently</AlertDialogTitle>
            <AlertDialogDescription>
              Delete {deleteTarget?.name}? This only succeeds for archived classes with no teaching history.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => deleteTarget && deleteClassMutation.mutate(deleteTarget.id)}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
