import { Input } from "../../../components/ui/input";
import { Button } from "../../../components/ui/button";
import { emptyCoverageFilters } from "../lib/coverageStudentFilters";

export default function CoverageStudentFilters({ label, students, filters, onChange }) {
  const classes = new Map();
  const grades = new Set();
  let classesAvailable = true;
  for (const student of students) {
    if (!Array.isArray(student.classes)) classesAvailable = false;
    for (const group of student.classes || []) classes.set(group.id, group.name);
    const grade = String(student.gradeLevel ?? "").trim();
    if (grade) grades.add(grade);
  }
  const selectClass = "h-10 rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";
  return <div className="space-y-2">
    <div className="flex flex-wrap items-end gap-3">
      <label className="flex min-w-48 flex-1 flex-col gap-1 text-sm">Search
        <Input aria-label={`Search ${label.toLowerCase()} students`} placeholder={label === "Claimed" ? "Search claimed students" : "Search students"} value={filters.search} onChange={event => onChange({ ...filters, search: event.target.value })} />
      </label>
      <label className="flex max-w-full flex-col gap-1 text-sm">Class
        <select aria-label={`${label} class`} className={selectClass} value={filters.classId} onChange={event => onChange({ ...filters, classId: event.target.value })} disabled={!classesAvailable}>
          <option value="all">All classes</option>
          <option value="none">No class assigned</option>
          {[...classes].sort((a, b) => a[1].localeCompare(b[1]) || a[0].localeCompare(b[0])).map(([id, name]) => <option key={id} value={id}>{name}</option>)}
          {!["all", "none"].includes(filters.classId) && !classes.has(filters.classId) && <option value={filters.classId}>Selected class (no matching students)</option>}
        </select>
      </label>
      <label className="flex flex-col gap-1 text-sm">Grade
        <select aria-label={`${label} grade`} className={selectClass} value={filters.grade} onChange={event => onChange({ ...filters, grade: event.target.value })}>
          <option value="all">All grades</option>
          <option value="none">No grade assigned</option>
          {[...grades].sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).map(grade => <option key={grade} value={grade}>{grade}</option>)}
          {!["all", "none"].includes(filters.grade) && !grades.has(filters.grade) && <option value={filters.grade}>{filters.grade}</option>}
        </select>
      </label>
      <Button variant="ghost" onClick={() => onChange({ ...emptyCoverageFilters })}>Clear filters</Button>
    </div>
    {!classesAvailable && <p role="status" className="text-sm text-muted-foreground">Class membership is unavailable. Refresh to retry class filtering.</p>}
  </div>;
}
