import { useEffect, useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { useClassPilotAuth } from "../../../hooks/useClassPilotAuth";
import { apiRequest } from "../../../lib/queryClient";
import { Button } from "../../../components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "../../../components/ui/card";
import { Badge } from "../../../components/ui/badge";
import { Input } from "../../../components/ui/input";
import SupervisionGroupCategories from "./SupervisionGroupCategories";

const selectClass =
  "h-10 w-full min-w-0 rounded-md border bg-background px-3 text-sm";
const staffName = (person) =>
  (person.displayName && person.displayName !== person.id
    ? person.displayName
    : person.email) || "Unavailable staff member";
const uniqueStaff = (staff) => [
  ...new Map((staff || []).map((person) => [person.id, person])).values(),
];
const gradeLabel = (grade) =>
  grade == null || grade === "ungraded"
    ? "No grade"
    : /^(grade|ungraded)/i.test(grade)
      ? grade
      : `Grade ${grade}`;

export default function SupervisionGroupDirectory({
  schoolId,
  active = true,
  isAdmin,
  busy,
  onEdit,
  onDelete,
  notice,
  savedGroupId,
}) {
  const { currentUser } = useClassPilotAuth();
  const actorScope = `${currentUser?.id}:${currentUser?.role}:${!!currentUser?.isSuperAdmin}`;
  const [filters, setFilters] = useState({
    search: "",
    categoryId: "",
    grade: "",
    staffId: "",
    active: "true",
  });
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [categoriesOpen, setCategoriesOpen] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => {
      setFilters((current) => ({ ...current, search }));
      setPage(1);
    }, 300);
    return () => clearTimeout(timer);
  }, [search]);
  const query = useQuery({
    queryKey: [
      "/api/coverage/supervision-groups/browse",
      schoolId,
      actorScope,
      filters,
      page,
    ],
    queryFn: ({ signal }) =>
      apiRequest("GET", "/coverage/supervision-groups/browse", undefined, {
        signal,
        headers: { "X-School-Id": schoolId },
        params: { ...filters, page },
      }),
    enabled: !!schoolId && active,
    placeholderData: keepPreviousData,
    retry: false,
  });
  const current = !query.isPlaceholderData && filters.search === search;
  const groups = current ? query.data?.groups || [] : [];
  const facets = query.data?.facets || {
    categories: [],
    grades: [],
    staff: [],
  };
  const loading = query.isPending || !current;
  const change = (patch) => {
    setFilters((value) => ({ ...value, ...patch }));
    setPage(1);
  };
  const clear = () => {
    setSearch("");
    setFilters({
      search: "",
      categoryId: "",
      grade: "",
      staffId: "",
      active: "true",
    });
    setPage(1);
  };
  const filtered =
    search ||
    filters.categoryId ||
    filters.grade ||
    filters.staffId ||
    filters.active !== "true";
  const savedGroupOffPage =
    savedGroupId &&
    current &&
    query.data &&
    !query.isFetching &&
    !query.isError &&
    !groups.some((group) => group.id === savedGroupId);
  const retainedOption = (value, options) =>
    value && !options.some((option) => option.id === value) ? (
      <option value={value}>Selected filter (unavailable)</option>
    ) : null;
  return (
    <>
      {notice && (
        <p role="status" className="rounded-md border bg-muted/30 p-3 text-sm">
          {notice}
          {savedGroupOffPage &&
            " The saved group is not on this page. Your filters are preserved; use search or change the filters to find it."}
        </p>
      )}
      {query.isError && (
        <p
          role="alert"
          className="rounded-md border p-3 text-sm text-destructive"
        >
          Supervision groups could not load. Use Refresh to retry before
          deleting a group.
        </p>
      )}
      {query.isFetching && !loading && (
        <p role="status" className="text-sm text-muted-foreground">
          Refreshing supervision groups… Deletion is available when the refresh
          finishes.
        </p>
      )}
      <Card className="min-w-0">
        <CardHeader className="flex flex-wrap items-start justify-between gap-3 sm:flex-row">
          <div>
            <CardTitle className="text-base">Supervision Groups</CardTitle>
            <CardDescription>
              Choose students and assign staff for testing and other school
              activities.
            </CardDescription>
          </div>
          <div className="flex flex-wrap gap-2">
            {isAdmin && (
              <Button
                variant="outline"
                disabled={busy}
                onClick={() => setCategoriesOpen(true)}
              >
                Manage categories
              </Button>
            )}
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => onEdit(null)}
            >
              <Plus className="mr-2 h-4 w-4" />
              New Group
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          <Input
            aria-label="Search supervision groups"
            placeholder="Search groups or assigned staff"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
          <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
            <label className="space-y-1 text-sm">
              Category
              <select
                className={selectClass}
                aria-label="Filter group category"
                value={filters.categoryId}
                onChange={(event) => change({ categoryId: event.target.value })}
              >
                <option value="">All categories</option>
                <option value="uncategorized">Uncategorized</option>
                {retainedOption(
                  filters.categoryId === "uncategorized"
                    ? ""
                    : filters.categoryId,
                  facets.categories,
                )}
                {facets.categories.map((category) => (
                  <option key={category.id} value={category.id}>
                    {category.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="space-y-1 text-sm">
              Grade
              <select
                className={selectClass}
                aria-label="Filter group grade"
                value={filters.grade}
                onChange={(event) => change({ grade: event.target.value })}
              >
                <option value="">All grades</option>
                <option value="ungraded">No grade</option>
                {filters.grade &&
                  filters.grade !== "ungraded" &&
                  !facets.grades.some(
                    (grade) => String(grade.gradeLevel) === filters.grade,
                  ) && (
                    <option value={filters.grade}>
                      {gradeLabel(filters.grade)} (unavailable)
                    </option>
                  )}
                {facets.grades
                  .filter((grade) => grade.gradeLevel != null)
                  .map((grade) => (
                    <option key={grade.gradeLevel} value={grade.gradeLevel}>
                      {gradeLabel(grade.gradeLevel)}
                    </option>
                  ))}
              </select>
            </label>
            <label className="space-y-1 text-sm">
              Assigned staff
              <select
                className={selectClass}
                aria-label="Filter assigned staff"
                value={filters.staffId}
                onChange={(event) => change({ staffId: event.target.value })}
              >
                <option value="">All staff</option>
                <option value="unassigned">No staff assigned</option>
                {retainedOption(
                  filters.staffId === "unassigned" ? "" : filters.staffId,
                  facets.staff,
                )}
                {facets.staff.map((person) => (
                  <option key={person.id} value={person.id}>
                    {staffName(person)}
                    {person.email && person.email !== staffName(person)
                      ? ` · ${person.email}`
                      : ""}
                  </option>
                ))}
              </select>
            </label>
            <label className="space-y-1 text-sm">
              Status
              <select
                className={selectClass}
                aria-label="Filter group status"
                value={filters.active}
                onChange={(event) => change({ active: event.target.value })}
              >
                <option value="all">All statuses</option>
                <option value="true">Active</option>
                <option value="false">Disabled</option>
              </select>
            </label>
          </div>
          {filtered && (
            <Button size="sm" variant="ghost" onClick={clear}>
              Clear filters
            </Button>
          )}
          <div className="rounded-md border">
            {groups.length ? (
              groups.map((group) => (
                <div
                  key={group.id}
                  data-testid={`supervision-group-${group.id}`}
                  className="grid min-w-0 gap-2 border-t px-3 py-3 text-sm first:border-t-0 sm:grid-cols-[minmax(0,1fr)_auto]"
                >
                  <div className="min-w-0">
                    <p className="break-words font-medium">{group.name}</p>
                    <p className="text-xs text-muted-foreground">
                      {group.studentCount} student
                      {group.studentCount === 1 ? "" : "s"} ·{" "}
                      {group.category?.name || "Uncategorized"}
                      {group.gradeCounts?.length
                        ? ` · ${group.gradeCounts.map((grade) => gradeLabel(grade.gradeLevel)).join(", ")}`
                        : ""}
                    </p>
                    <p className="break-words">
                      <span className="font-medium">Assigned staff:</span>{" "}
                      {uniqueStaff(group.staff).map(staffName).join(", ") ||
                        "No staff assigned"}
                    </p>
                    {group.description && (
                      <details className="text-xs text-muted-foreground">
                        <summary className="cursor-pointer py-1">
                          Description
                        </summary>
                        <p className="break-words">{group.description}</p>
                      </details>
                    )}
                  </div>
                  <div className="flex flex-wrap items-center gap-2 self-start">
                    <Badge variant={group.active ? "secondary" : "outline"}>
                      {group.active ? "Active" : "Disabled"}
                    </Badge>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy || query.isFetching || !current}
                      onClick={() => onEdit(group)}
                    >
                      Edit
                    </Button>
                    {isAdmin && (
                      <Button
                        size="sm"
                        variant="outline"
                        className="text-destructive"
                        aria-label={`Delete group ${group.name}`}
                        disabled={
                          busy ||
                          !group.updatedAt ||
                          query.isFetching ||
                          query.isError ||
                          !current
                        }
                        onClick={(event) => onDelete(group, event)}
                      >
                        Delete group
                      </Button>
                    )}
                  </div>
                </div>
              ))
            ) : (
              <p
                role={loading ? "status" : undefined}
                className="p-5 text-center text-sm text-muted-foreground"
              >
                {loading
                  ? "Loading supervision groups…"
                  : query.isError
                    ? "Supervision groups are unavailable."
                    : filtered
                      ? "No supervision groups match these filters."
                      : "No active supervision groups. Choose All statuses to include disabled groups, or create a group."}
              </p>
            )}
          </div>
          {current && query.data && (
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p role="status" className="text-xs text-muted-foreground">
                {query.data.total
                  ? `Showing ${(query.data.page - 1) * 25 + 1}–${Math.min(query.data.page * 25, query.data.total)} of ${query.data.total} groups`
                  : "0 groups"}
              </p>
              <div className="flex gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={query.isFetching || query.data.page <= 1}
                  onClick={() => setPage(query.data.page - 1)}
                >
                  Previous groups
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={
                    query.isFetching || query.data.page >= query.data.totalPages
                  }
                  onClick={() => setPage(query.data.page + 1)}
                >
                  Next groups
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>
      {categoriesOpen && (
        <SupervisionGroupCategories
          schoolId={schoolId}
          open
          onOpenChange={setCategoriesOpen}
        />
      )}
    </>
  );
}
