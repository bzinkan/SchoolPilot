import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Search } from "lucide-react";
import { apiRequest } from "../../../lib/queryClient";
import { useClassPilotAuth } from "../../../hooks/useClassPilotAuth";
import { Button } from "../../../components/ui/button";
import { Checkbox } from "../../../components/ui/checkbox";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../../components/ui/select";
import { Textarea } from "../../../components/ui/textarea";
import { refreshSupervisionSetup } from "./supervisionGroupQueries";
import { Badge } from "../../../components/ui/badge";

const ALL_FILTER = "all",
  PICKER_PAGE_SIZE = 8;
const EMPTY = [];
function displayName(user) {
  return (
    user?.displayName ||
    user?.email ||
    user?.user?.displayName ||
    user?.user?.email ||
    "Staff"
  );
}

export default function SupervisionGroupEditor(props) {
  return props.open && props.schoolId ? <EditorSession {...props} /> : null;
}

function EditorSession({ schoolId, groupId, onOpenChange, onSaved }) {
  const { currentUser } = useClassPilotAuth();
  const [owner] = useState(() => ({
    schoolId,
    actorId: currentUser?.id,
    token: crypto.randomUUID(),
  }));
  const opener = useRef(document.activeElement);
  const live =
    owner.schoolId === schoolId &&
    owner.schoolId === currentUser?.schoolId &&
    owner.actorId === currentUser?.id;
  useLayoutEffect(() => {
    if (!live) onOpenChange(false);
  }, [live, onOpenChange]);
  const restoreFocus = (event) => {
    event.preventDefault();
    if (live && opener.current?.isConnected) opener.current.focus();
  };
  const detail = useQuery({
    queryKey: [
      "/api/coverage/supervision-groups/detail",
      owner.schoolId,
      groupId,
      owner.token,
    ],
    queryFn: ({ signal }) =>
      apiRequest(
        "GET",
        `/coverage/supervision-groups/${encodeURIComponent(groupId)}`,
        undefined,
        { signal, headers: { "X-School-Id": owner.schoolId } },
      ),
    enabled: live && !!groupId,
    retry: false,
    refetchOnWindowFocus: false,
    gcTime: 0,
  });
  if (!live) return null;
  if (groupId && !detail.data)
    return (
      <Dialog open onOpenChange={onOpenChange}>
        <DialogContent onCloseAutoFocus={restoreFocus}>
          <DialogHeader>
            <DialogTitle>Edit Supervision Group</DialogTitle>
            <DialogDescription>
              Load the current group before editing.
            </DialogDescription>
          </DialogHeader>
          {detail.isError ? (
            <div role="alert">
              <p>
                {detail.error.response?.data?.error ||
                  "Could not load this group."}
              </p>
              <Button onClick={() => detail.refetch()}>Retry group</Button>
            </div>
          ) : (
            <p role="status">Loading supervision group…</p>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    );
  return (
    <GroupForm
      opener={opener}
      schoolId={owner.schoolId}
      initialGroup={detail.data?.group}
      onOpenChange={onOpenChange}
      onSaved={onSaved}
    />
  );
}

function useSetupQuery(path, schoolId, enabled, select) {
  const { currentUser } = useClassPilotAuth();
  return useQuery({
    queryKey: [`/api${path}`, schoolId, currentUser?.id, currentUser?.role],
    queryFn: ({ signal }) =>
      apiRequest("GET", path, undefined, {
        signal,
        headers: { "X-School-Id": schoolId },
      }),
    enabled,
    retry: false,
    refetchOnWindowFocus: false,
    select,
  });
}

function GroupForm({ opener, schoolId, initialGroup, onOpenChange, onSaved }) {
  const client = useQueryClient();
  const { currentUser } = useClassPilotAuth();
  const isAdmin =
    currentUser?.isSuperAdmin ||
    ["admin", "school_admin"].includes(currentUser?.role);
  const [owner] = useState(() => ({ schoolId, actorId: currentUser?.id }));
  const live =
    owner.schoolId === currentUser?.schoolId &&
    owner.actorId === currentUser?.id;
  const committed = useRef(false);
  useLayoutEffect(() => {
    committed.current = live;
    return () => {
      committed.current = false;
    };
  }, [live]);
  const staffQuery = useSetupQuery(
    isAdmin ? "/admin/users" : "/coverage/setup/staff",
    schoolId,
    live,
    (data) => data?.users || EMPTY,
  );
  const groupsQuery = useSetupQuery(
    "/coverage/setup/classes",
    schoolId,
    live,
    (data) => data?.groups || EMPTY,
  );
  const adminStudentsQuery = useSetupQuery(
    isAdmin ? "/admin/teacher-students" : "/coverage/setup/students",
    schoolId,
    live,
    (data) => data?.students || EMPTY,
  );
  const categoriesQuery = useSetupQuery(
    "/coverage/supervision-group-categories",
    schoolId,
    live,
  );
  const categories = categoriesQuery.data?.categories || EMPTY;
  const dependenciesLoading = [
    staffQuery,
    groupsQuery,
    adminStudentsQuery,
    categoriesQuery,
  ].some((query) => query.isPending);
  const dependenciesUnavailable =
    dependenciesLoading ||
    [staffQuery, groupsQuery, adminStudentsQuery, categoriesQuery].some(
      (query) => query.isError,
    );
  const retryDependencies = () =>
    [staffQuery, groupsQuery, adminStudentsQuery, categoriesQuery].forEach(
      (query) => {
        if (query.isError) void query.refetch();
      },
    );
  const [scopeGroupForm, setScopeGroupForm] = useState(() => ({
    id: initialGroup?.id || "",
    name: initialGroup?.name || "",
    description: initialGroup?.description || "",
    categoryId: initialGroup?.categoryId || null,
    updatedAt: initialGroup?.updatedAt,
    studentIds: (initialGroup?.students || EMPTY).map(
      (student) => student.studentId,
    ),
    staffIds: [
      ...new Set((initialGroup?.staff || EMPTY).map((staff) => staff.id)),
    ],
    active: initialGroup?.active !== false,
  }));
  const [scopeGroupStaffSearch, setScopeGroupStaffSearch] = useState("");
  const [scopeGroupStaffPage, setScopeGroupStaffPage] = useState(1);
  const [scopeGroupStudentSearch, setScopeGroupStudentSearch] = useState("");
  const [scopeGroupStudentPage, setScopeGroupStudentPage] = useState(1);
  const [scopeGroupStudentGradeFilter, setScopeGroupStudentGradeFilter] =
    useState(ALL_FILTER);
  const [scopeGroupStudentClassFilter, setScopeGroupStudentClassFilter] =
    useState(ALL_FILTER);
  const scopeGroupClassStudentsQuery = useSetupQuery(
    `/groups/${scopeGroupStudentClassFilter}/students`,
    schoolId,
    live && scopeGroupStudentClassFilter !== ALL_FILTER,
    (data) => (Array.isArray(data) ? data : data?.students || EMPTY),
  );
  const adminStudents = adminStudentsQuery.data || EMPTY;
  const rosterGrades = useMemo(() => {
    const counts = new Map();
    adminStudents.forEach((student) => {
      const grade = normalizeScopeValue(student.gradeLevel);
      if (!grade) return;
      counts.set(grade, (counts.get(grade) || 0) + 1);
    });
    return Array.from(counts.entries())
      .sort(
        ([a], [b]) =>
          gradeSortValue(a) - gradeSortValue(b) || a.localeCompare(b),
      )
      .map(([grade, count]) => ({ value: grade, count }));
  }, [adminStudents]);
  const classManagementGroups = useMemo(
    () =>
      [...(groupsQuery.data || [])].sort((a, b) => {
        const gradeCompare =
          gradeSortValue(a.gradeLevel) - gradeSortValue(b.gradeLevel);
        return gradeCompare || (a.name || "").localeCompare(b.name || "");
      }),
    [groupsQuery.data],
  );
  const scopeGroupClassChoices = useMemo(
    () =>
      classManagementGroups.filter(
        (group) =>
          scopeGroupStudentGradeFilter === ALL_FILTER ||
          rosterGradeKey(group.gradeLevel) ===
            rosterGradeKey(scopeGroupStudentGradeFilter),
      ),
    [classManagementGroups, scopeGroupStudentGradeFilter],
  );
  const filteredScopeGroupStaff = useMemo(() => {
    return (staffQuery.data || []).filter((staff) => {
      const searchText = [
        displayName(staff),
        staff.email,
        staff.user?.email,
        staff.role,
      ]
        .filter(Boolean)
        .join(" ");
      return matchesTokens(searchText, scopeGroupStaffSearch);
    });
  }, [scopeGroupStaffSearch, staffQuery.data]);
  const pagedScopeGroupStaff = useMemo(
    () => paginate(filteredScopeGroupStaff, scopeGroupStaffPage),
    [filteredScopeGroupStaff, scopeGroupStaffPage],
  );
  const scopeGroupClassStudentIds = useMemo(() => {
    if (scopeGroupStudentClassFilter === ALL_FILTER) return null;
    return new Set(
      (scopeGroupClassStudentsQuery.data || []).map((student) => student.id),
    );
  }, [scopeGroupClassStudentsQuery.data, scopeGroupStudentClassFilter]);
  const filteredScopeGroupStudents = useMemo(() => {
    return adminStudents.filter((student) => {
      const grade = normalizeScopeValue(student.gradeLevel);
      if (
        scopeGroupStudentGradeFilter !== ALL_FILTER &&
        grade !== scopeGroupStudentGradeFilter
      )
        return false;
      if (
        scopeGroupClassStudentIds &&
        !scopeGroupClassStudentIds.has(student.id)
      )
        return false;
      const searchText = [
        student.studentName,
        student.studentEmail,
        student.email,
        student.gradeLevel ? `grade ${student.gradeLevel}` : "",
      ]
        .filter(Boolean)
        .join(" ");
      return matchesTokens(searchText, scopeGroupStudentSearch);
    });
  }, [
    adminStudents,
    scopeGroupClassStudentIds,
    scopeGroupStudentGradeFilter,
    scopeGroupStudentSearch,
  ]);
  const pagedScopeGroupStudents = useMemo(
    () => paginate(filteredScopeGroupStudents, scopeGroupStudentPage),
    [filteredScopeGroupStudents, scopeGroupStudentPage],
  );
  const scopeGroupStudentsLoading =
    adminStudentsQuery.isPending ||
    adminStudentsQuery.isFetching ||
    (scopeGroupStudentClassFilter !== ALL_FILTER &&
      (scopeGroupClassStudentsQuery.isPending ||
        scopeGroupClassStudentsQuery.isFetching));
  const scopeGroupStudentsError =
    adminStudentsQuery.isError ||
    (scopeGroupStudentClassFilter !== ALL_FILTER &&
      scopeGroupClassStudentsQuery.isError);
  const scopeGroupStudentsUnavailable =
    scopeGroupStudentsLoading || scopeGroupStudentsError;
  const selectedScopeGroupStudentIds = useMemo(
    () => new Set(scopeGroupForm.studentIds),
    [scopeGroupForm.studentIds],
  );
  const selectedMatchingStudentCount = filteredScopeGroupStudents.filter(
    (student) => selectedScopeGroupStudentIds.has(student.id),
  ).length;
  const toggleScopeGroupStudent = (studentId) => {
    setScopeGroupForm((prev) => {
      const selected = new Set(prev.studentIds);
      if (selected.has(studentId)) selected.delete(studentId);
      else selected.add(studentId);
      return { ...prev, studentIds: Array.from(selected) };
    });
  };

  const selectMatchingScopeGroupStudents = (include) => {
    if (scopeGroupStudentsUnavailable) return;
    setScopeGroupForm((prev) => {
      const selected = new Set(prev.studentIds);
      for (const student of filteredScopeGroupStudents) {
        if (include) selected.add(student.id);
        else selected.delete(student.id);
      }
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

  const saveScopeGroupMutation = useMutation({
    mutationFn: async () => {
      if (!committed.current)
        throw new Error(
          "The school changed. Reopen this group in the current school.",
        );
      const { id, updatedAt, ...fields } = scopeGroupForm;
      return apiRequest(
        id ? "PATCH" : "POST",
        id
          ? `/coverage/supervision-groups/${encodeURIComponent(id)}`
          : "/coverage/supervision-groups",
        {
          ...fields,
          name: fields.name.trim(),
          description: fields.description.trim(),
          ...(id ? { updatedAt } : {}),
        },
        { headers: { "X-School-Id": schoolId } },
      );
    },
    onSuccess: async (result) => {
      const refreshWarning = await refreshSupervisionSetup(client, schoolId);
      if (!committed.current) return;
      onSaved?.({ group: result.group, refreshWarning });
      onOpenChange(false);
    },
    onError: () => {
      void refreshSupervisionSetup(client, schoolId);
    },
  });
  const submitScopeGroup = () => {
    if (!dependenciesUnavailable && !saveScopeGroupMutation.isPending)
      saveScopeGroupMutation.mutate();
  };
  return (
    <Dialog
      open={live}
      onOpenChange={(value) => {
        if (!value && !saveScopeGroupMutation.isPending) onOpenChange(false);
      }}
    >
      <DialogContent
        onEscapeKeyDown={(event) => {
          if (saveScopeGroupMutation.isPending) event.preventDefault();
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          if (live && opener.current?.isConnected) opener.current.focus();
        }}
        className="flex max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] max-w-2xl flex-col overflow-hidden"
      >
        <DialogHeader className="shrink-0 pr-6">
          <DialogTitle>
            {scopeGroupForm.id
              ? "Edit Supervision Group"
              : "Create Supervision Group"}
          </DialogTitle>
          <DialogDescription>
            Supervision Groups do not change class rosters.
          </DialogDescription>
        </DialogHeader>
        <div
          data-testid="supervision-group-editor-body"
          className="min-h-0 min-w-0 overflow-y-auto overscroll-contain p-1"
        >
          <fieldset
            disabled={saveScopeGroupMutation.isPending}
            className="min-w-0 space-y-4"
          >
            <div className="grid gap-2">
              <Label htmlFor="supervision-group-name">Name</Label>
              <Input
                id="supervision-group-name"
                value={scopeGroupForm.name}
                onChange={(e) =>
                  setScopeGroupForm((f) => ({ ...f, name: e.target.value }))
                }
                placeholder="State testing - 8th grade"
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="supervision-group-description">Description</Label>
              <Textarea
                id="supervision-group-description"
                value={scopeGroupForm.description}
                onChange={(e) =>
                  setScopeGroupForm((f) => ({
                    ...f,
                    description: e.target.value,
                  }))
                }
                placeholder="Optional note for admins"
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="supervision-group-category">Category</Label>
              <select
                id="supervision-group-category"
                className="h-10 w-full rounded-md border bg-background px-3 text-sm"
                value={scopeGroupForm.categoryId || ""}
                onChange={(event) =>
                  setScopeGroupForm((current) => ({
                    ...current,
                    categoryId: event.target.value || null,
                  }))
                }
              >
                <option value="">Uncategorized</option>
                {scopeGroupForm.categoryId &&
                  !categories.some(
                    (category) => category.id === scopeGroupForm.categoryId,
                  ) && (
                    <option value={scopeGroupForm.categoryId}>
                      Unavailable category — choose another
                    </option>
                  )}
                {categories.map((category) => (
                  <option key={category.id} value={category.id}>
                    {category.name}
                  </option>
                ))}
              </select>
            </div>
            {dependenciesUnavailable && (
              <div role="alert" className="space-y-2 text-sm">
                <p>
                  {dependenciesLoading
                    ? "Loading group setup…"
                    : "Some group setup could not load. Your selections are preserved."}
                </p>
                {!dependenciesLoading && (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={retryDependencies}
                  >
                    Retry group setup
                  </Button>
                )}
              </div>
            )}
            {saveScopeGroupMutation.error && (
              <p role="alert" className="text-sm text-destructive">
                {saveScopeGroupMutation.error.response?.data?.error ||
                  saveScopeGroupMutation.error.message}
              </p>
            )}
            <div role="group" aria-label="Group staff" className="space-y-2">
              <div className="flex items-center justify-between gap-3">
                <Label>Staff</Label>
                <Badge variant="secondary">
                  {scopeGroupForm.staffIds.length} selected
                </Badge>
              </div>
              <p className="text-xs text-muted-foreground">
                Selected staff can claim and manage this group. No separate
                access grant is needed.
              </p>
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
                  <div className="px-4 py-8 text-center text-sm text-muted-foreground">
                    No staff found
                  </div>
                ) : (
                  pagedScopeGroupStaff.items.map((staff) => (
                    <label
                      key={staff.userId}
                      className="flex cursor-pointer items-center gap-3 border-t first:border-t-0 px-4 py-2 text-sm"
                    >
                      <Checkbox
                        checked={scopeGroupForm.staffIds.includes(staff.userId)}
                        onCheckedChange={() =>
                          toggleScopeGroupStaff(staff.userId)
                        }
                      />
                      <span className="min-w-0 flex-1 break-words">
                        <span className="block font-medium">
                          {displayName(staff)}
                        </span>
                        <span className="block text-xs text-muted-foreground">
                          {[
                            staff.user?.email || staff.email,
                            staff.role || "Staff",
                          ]
                            .filter(Boolean)
                            .join(" - ")}
                        </span>
                      </span>
                    </label>
                  ))
                )}
                {filteredScopeGroupStaff.length > 0 && (
                  <div className="flex flex-wrap items-center justify-between gap-3 border-t px-3 py-2 text-xs text-muted-foreground">
                    <span>
                      Showing{" "}
                      {(pagedScopeGroupStaff.currentPage - 1) *
                        PICKER_PAGE_SIZE +
                        1}
                      -
                      {Math.min(
                        pagedScopeGroupStaff.currentPage * PICKER_PAGE_SIZE,
                        filteredScopeGroupStaff.length,
                      )}{" "}
                      of {filteredScopeGroupStaff.length}
                    </span>
                    <div className="flex items-center gap-2">
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() =>
                          setScopeGroupStaffPage((page) =>
                            Math.max(1, page - 1),
                          )
                        }
                        disabled={pagedScopeGroupStaff.currentPage <= 1}
                      >
                        Previous
                      </Button>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() =>
                          setScopeGroupStaffPage((page) =>
                            Math.min(pagedScopeGroupStaff.pageCount, page + 1),
                          )
                        }
                        disabled={
                          pagedScopeGroupStaff.currentPage >=
                          pagedScopeGroupStaff.pageCount
                        }
                      >
                        Next
                      </Button>
                    </div>
                  </div>
                )}
              </div>
            </div>
            <div role="group" aria-label="Group students" className="space-y-2">
              <div className="flex items-center justify-between gap-3">
                <Label>Students</Label>
                <Badge variant="secondary">
                  {scopeGroupForm.studentIds.length} selected
                </Badge>
              </div>
              <div className="grid gap-2 md:grid-cols-2">
                <div className="grid gap-1">
                  <Label
                    htmlFor="supervision-group-grade"
                    className="text-xs text-muted-foreground"
                  >
                    Roster grade
                  </Label>
                  <Select
                    value={scopeGroupStudentGradeFilter}
                    onValueChange={(value) => {
                      setScopeGroupStudentGradeFilter(value);
                      const selectedClass = classManagementGroups.find(
                        (group) => group.id === scopeGroupStudentClassFilter,
                      );
                      if (
                        value !== ALL_FILTER &&
                        selectedClass &&
                        rosterGradeKey(selectedClass.gradeLevel) !==
                          rosterGradeKey(value)
                      ) {
                        setScopeGroupStudentClassFilter(ALL_FILTER);
                      }
                      setScopeGroupStudentPage(1);
                    }}
                  >
                    <SelectTrigger id="supervision-group-grade">
                      <SelectValue placeholder="All grades" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={ALL_FILTER}>All grades</SelectItem>
                      {rosterGrades.map((grade) => (
                        <SelectItem key={grade.value} value={grade.value}>
                          Grade {grade.value} ({grade.count})
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="grid gap-1">
                  <Label
                    htmlFor="supervision-group-class"
                    className="text-xs text-muted-foreground"
                  >
                    Class Management class
                  </Label>
                  <Select
                    value={scopeGroupStudentClassFilter}
                    onValueChange={(value) => {
                      setScopeGroupStudentClassFilter(value);
                      setScopeGroupStudentPage(1);
                    }}
                  >
                    <SelectTrigger
                      id="supervision-group-class"
                      className="min-w-0 [&>span]:truncate"
                    >
                      <SelectValue placeholder="All classes" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={ALL_FILTER}>All classes</SelectItem>
                      {scopeGroupClassChoices.map((group) => (
                        <SelectItem key={group.id} value={group.id}>
                          {[
                            group.name,
                            group.gradeLevel
                              ? `Grade ${group.gradeLevel}`
                              : null,
                          ]
                            .filter(Boolean)
                            .join(" - ")}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <p className="text-xs text-muted-foreground">
                The class list follows the selected roster grade. Changing
                filters keeps your student selections.
              </p>
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
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={
                    scopeGroupStudentsUnavailable ||
                    filteredScopeGroupStudents.length === 0 ||
                    selectedMatchingStudentCount ===
                      filteredScopeGroupStudents.length
                  }
                  onClick={() => selectMatchingScopeGroupStudents(true)}
                >
                  {scopeGroupStudentsUnavailable
                    ? "Select all matching students"
                    : `Select all ${filteredScopeGroupStudents.length} matching students`}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={
                    scopeGroupStudentsUnavailable ||
                    selectedMatchingStudentCount === 0
                  }
                  onClick={() => selectMatchingScopeGroupStudents(false)}
                >
                  Clear matching students
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                Selection applies to all matching students across every page.
                Students selected outside these filters stay selected.
              </p>
              {!scopeGroupStudentsUnavailable && (
                <p role="status" className="text-xs text-muted-foreground">
                  {selectedMatchingStudentCount} of{" "}
                  {filteredScopeGroupStudents.length} matching students selected
                  · {scopeGroupForm.studentIds.length} total selected
                </p>
              )}
              <div className="rounded-md border overflow-hidden">
                {scopeGroupStudentsLoading ? (
                  <div
                    role="status"
                    className="px-4 py-8 text-center text-sm text-muted-foreground"
                  >
                    Loading student roster...
                  </div>
                ) : scopeGroupStudentsError ? (
                  <div
                    role="alert"
                    className="space-y-2 px-4 py-6 text-center text-sm"
                  >
                    <p>
                      Could not load the student roster. Your selections are
                      preserved.
                    </p>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        if (adminStudentsQuery.isError)
                          adminStudentsQuery.refetch();
                        if (
                          scopeGroupStudentClassFilter !== ALL_FILTER &&
                          scopeGroupClassStudentsQuery.isError
                        )
                          scopeGroupClassStudentsQuery.refetch();
                      }}
                    >
                      Retry student roster
                    </Button>
                  </div>
                ) : filteredScopeGroupStudents.length === 0 ? (
                  <div className="px-4 py-8 text-center text-sm text-muted-foreground">
                    No students match these filters
                  </div>
                ) : (
                  pagedScopeGroupStudents.items.map((student) => (
                    <label
                      key={student.id}
                      className="flex cursor-pointer items-center gap-3 border-t first:border-t-0 px-4 py-2 text-sm"
                    >
                      <Checkbox
                        checked={selectedScopeGroupStudentIds.has(student.id)}
                        onCheckedChange={() =>
                          toggleScopeGroupStudent(student.id)
                        }
                      />
                      <span className="min-w-0 flex-1 break-words">
                        <span className="block font-medium">
                          {student.studentName}
                        </span>
                        <span className="block text-xs text-muted-foreground">
                          {student.studentEmail || "No email"} - Grade{" "}
                          {student.gradeLevel || "None"}
                        </span>
                      </span>
                    </label>
                  ))
                )}
                {!scopeGroupStudentsUnavailable &&
                  filteredScopeGroupStudents.length > 0 && (
                    <div className="flex flex-wrap items-center justify-between gap-3 border-t px-3 py-2 text-xs text-muted-foreground">
                      <span>
                        Showing{" "}
                        {(pagedScopeGroupStudents.currentPage - 1) *
                          PICKER_PAGE_SIZE +
                          1}
                        -
                        {Math.min(
                          pagedScopeGroupStudents.currentPage *
                            PICKER_PAGE_SIZE,
                          filteredScopeGroupStudents.length,
                        )}{" "}
                        of {filteredScopeGroupStudents.length}
                      </span>
                      <div className="flex items-center gap-2">
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={() =>
                            setScopeGroupStudentPage((page) =>
                              Math.max(1, page - 1),
                            )
                          }
                          disabled={pagedScopeGroupStudents.currentPage <= 1}
                        >
                          Previous
                        </Button>
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={() =>
                            setScopeGroupStudentPage((page) =>
                              Math.min(
                                pagedScopeGroupStudents.pageCount,
                                page + 1,
                              ),
                            )
                          }
                          disabled={
                            pagedScopeGroupStudents.currentPage >=
                            pagedScopeGroupStudents.pageCount
                          }
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
                <Checkbox
                  checked={scopeGroupForm.active}
                  onCheckedChange={(checked) =>
                    setScopeGroupForm((f) => ({
                      ...f,
                      active: checked === true,
                    }))
                  }
                />
                Active supervision group
              </label>
            )}
          </fieldset>
        </div>
        <DialogFooter className="shrink-0 gap-2 border-t pt-4">
          <Button
            variant="outline"
            disabled={saveScopeGroupMutation.isPending}
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button
            onClick={submitScopeGroup}
            disabled={
              saveScopeGroupMutation.isPending ||
              !scopeGroupForm.name.trim() ||
              dependenciesUnavailable
            }
          >
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
function normalizeScopeValue(value) {
  return String(value || "").trim();
}

function rosterGradeKey(value) {
  const compact = normalizeScopeValue(value)
    .toLowerCase()
    .replace(/^grade\s*/, "")
    .replace(/[\s-]+/g, "");
  if (["pk", "prek", "prekindergarten", "prekindergarden"].includes(compact))
    return "pk";
  if (["k", "kg", "kindergarten", "kindergarden"].includes(compact)) return "k";
  const numeric = compact.replace(/(st|nd|rd|th)$/, "");
  return /^\d+$/.test(numeric) ? String(Number(numeric)) : compact;
}

function gradeSortValue(grade) {
  const normalized = normalizeScopeValue(grade);
  const numeric = Number.parseInt(normalized, 10);
  return Number.isFinite(numeric) ? numeric : 999;
}

function matchesTokens(value, query) {
  const tokens = String(query || "")
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
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
