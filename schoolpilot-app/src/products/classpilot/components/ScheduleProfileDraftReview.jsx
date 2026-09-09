import { useMemo } from 'react';
import { Button } from '../../../components/ui/button';
import { Badge } from '../../../components/ui/badge';

const EMPTY = [];
const inputClass = 'min-w-0 w-full rounded-md border bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2';
const issueColor = { conflict: 'text-amber-800 dark:text-amber-300', incomplete: 'text-amber-800 dark:text-amber-300', overlap: 'text-muted-foreground' };
const timeText = window => window ? `${window.startTime}–${window.endTime}` : 'Does not meet';
const gradeKey = value => /^(?:grade\s*)?([1-8])$/i.exec(String(value ?? '').trim())?.[1] || String(value ?? '');
const gradeName = value => /^(grade\s|unassigned)/i.test(value) ? value : `Grade ${value}`;

export function DraftReviewIssues({ issues = EMPTY, review, onEditIssue, compact = false }) {
  return <div className={compact ? 'mt-2 space-y-2 text-xs' : 'space-y-3 text-sm'}>
    {issues.map(issue => <div key={issue.id} className={`space-y-1 ${issueColor[issue.kind] || issueColor.incomplete}`}>
      <p><span className="font-medium">{issue.kind === 'conflict' ? 'Conflict: ' : issue.kind === 'overlap' ? 'Allowed overlap: ' : 'Needs review: '}</span>{issue.message}</p>
      {onEditIssue && <div className="flex flex-wrap gap-x-3 gap-y-1">
        {(issue.classIds || EMPTY).map(id => { const row = review?.classes?.find(item => item.classId === id); return row && <button key={id} type="button" className="rounded text-left font-medium text-primary underline underline-offset-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" aria-label={`Edit affected class ${row.name}`} onClick={() => onEditIssue({ classId: id })}>Edit {row.name}</button>; })}
        {(issue.blockIds || EMPTY).map(id => { const row = review?.testingBlocks?.find(item => item.blockId === id); return row && <button key={id} type="button" className="rounded text-left font-medium text-primary underline underline-offset-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" aria-label={`Edit testing block ${row.name || 'Untitled testing block'}`} onClick={() => onEditIssue({ blockId: id })}>Edit {row.name || 'testing block'}</button>; })}
      </div>}
    </div>)}
  </div>;
}

export function DraftReviewStatus({ review, validDate, saved = false }) {
  const data = review.data;
  return <section aria-label="Draft schedule check" className="space-y-2 rounded-lg border bg-muted/20 p-3 text-sm">
    <p className="font-medium">Reference-day check</p>
    <div role="status" aria-live="polite">
      {!validDate ? <p>Choose a valid instructional reference date to review this draft.</p>
        : review.pending ? <p>Checking draft schedule…</p>
          : review.error ? <p>{saved ? 'Profile saved; schedule review unavailable.' : 'Could not review this draft schedule.'}</p>
            : data ? <>
              {!data.complete && <p className="text-amber-800 dark:text-amber-300">Draft review is incomplete.</p>}
              {data.counts?.conflicts > 0 ? <p className="text-amber-800 dark:text-amber-300">{data.counts.conflicts} {data.counts.conflicts === 1 ? 'conflict needs' : 'conflicts need'} attention</p> : data.complete && <p>No blocking conflicts on this reference date.</p>}
              {data.counts?.overlaps > 0 && <p className="text-muted-foreground">{data.counts.overlaps} allowed {data.counts.overlaps === 1 ? 'overlap' : 'overlaps'}</p>}
            </> : <p>Review this draft after loading a regular day or choosing Start blank.</p>}
    </div>
    {review.error && <><p className="text-xs text-muted-foreground">{review.error?.response?.data?.error || review.error.message}</p><Button size="sm" variant="outline" onClick={review.retry}>Retry draft review</Button></>}
    <p className="text-xs leading-relaxed text-muted-foreground">You can keep editing and save with schedule conflicts. Resolve blocking conflicts when you preview the actual application dates. A reference-day check does not approve an application.</p>
  </section>;
}

export default function ScheduleProfileDraftReview({ review, filters, onFiltersChange, onEditIssue }) {
  const data = review.data;
  const classes = data?.classes || EMPTY, blocks = data?.testingBlocks || EMPTY, issues = data?.issues || EMPTY;
  const options = useMemo(() => {
    const teachers = new Map(), grades = new Set();
    for (const row of classes) {
      if (row.gradeLevel != null && row.gradeLevel !== '') grades.add(gradeKey(row.gradeLevel));
      for (const person of row.staff || EMPTY) teachers.set(person.id, person.name);
    }
    for (const block of blocks) if (block.assignedStaffId) teachers.set(block.assignedStaffId, block.staffName || 'Assigned staff');
    return { grades: [...grades].sort((a, b) => a.localeCompare(b, undefined, { numeric: true })), teachers: [...teachers].sort((a, b) => a[1].localeCompare(b[1])) };
  }, [classes, blocks]);
  const conflictClassIds = new Set(issues.filter(issue => issue.kind === 'conflict').flatMap(issue => issue.classIds || EMPTY));
  const conflictBlockIds = new Set(issues.filter(issue => issue.kind === 'conflict').flatMap(issue => issue.blockIds || EMPTY));
  const classScope = classes.filter(row => (filters.grade === 'all' || gradeKey(row.gradeLevel) === filters.grade)
    && (filters.classId === 'all' || row.classId === filters.classId));
  const classScopeIds = new Set(classScope.map(row => row.classId));
  const matchingClasses = classScope.filter(row => filters.teacher === 'all' || row.staff?.some(person => person.id === filters.teacher));
  const matchingIds = new Set(matchingClasses.map(row => row.classId));
  const visibleClasses = matchingClasses.filter(row => !filters.conflictsOnly || conflictClassIds.has(row.classId));
  const visibleBlocks = blocks.filter(block => (filters.teacher === 'all' || block.assignedStaffId === filters.teacher)
    && ((filters.grade === 'all' && filters.classId === 'all') || block.classParticipation?.some(item => classScopeIds.has(item.classId)))
    && (!filters.conflictsOnly || conflictBlockIds.has(block.blockId)));
  const rows = [...visibleClasses.map(row => ({ type: 'class', id: row.classId, time: row.proposedWindow?.startTime || row.regularWindow?.startTime || '99:99', row })),
    ...visibleBlocks.map(row => ({ type: 'testing', id: row.blockId, time: row.startTime || '99:99', row }))]
    .sort((a, b) => a.time.localeCompare(b.time) || a.row.name.localeCompare(b.row.name));
  const filteredIssues = issues.filter(issue => (issue.kind === 'incomplete' || !filters.conflictsOnly || issue.kind === 'conflict')
    && ((!issue.classIds?.length && !issue.blockIds?.length)
      || issue.classIds?.some(id => matchingIds.has(id)) || issue.blockIds?.some(id => visibleBlocks.some(block => block.blockId === id))));
  const change = patch => onFiltersChange({ ...filters, ...patch });
  return <section aria-label="Draft schedule review" className="min-w-0 space-y-4">
    <div><h3 className="text-lg font-semibold" tabIndex={-1} data-review-heading>Proposed day</h3><p className="mt-1 text-sm text-muted-foreground">Regular classes and testing are shown together. Testing supervision does not cancel, shorten or move ordinary classes. Use Custom time or Does not meet to change them.</p></div>
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      <label className="space-y-1 text-sm"><span>Schedule view</span><select className={inputClass} value={filters.view} onChange={event => change({ view: event.target.value, teacher: 'all' })}><option value="classes">Classes</option><option value="teachers">Teachers</option></select></label>
      <label className="space-y-1 text-sm"><span>Review grade</span><select className={inputClass} value={filters.grade} onChange={event => change({ grade: event.target.value, classId: 'all' })}><option value="all">All grades</option>{filters.grade !== 'all' && !options.grades.includes(filters.grade) && <option value={filters.grade}>{gradeName(filters.grade)} — {review.pending ? 'checking' : 'not in this day'}</option>}{options.grades.map(grade => <option key={grade} value={grade}>{gradeName(grade)}</option>)}</select></label>
      <label className="space-y-1 text-sm"><span>Review class</span><select className={inputClass} value={filters.classId} onChange={event => change({ classId: event.target.value })}><option value="all">All classes</option>{filters.classId !== 'all' && !classes.some(row => row.classId === filters.classId && (filters.grade === 'all' || gradeKey(row.gradeLevel) === filters.grade)) && <option value={filters.classId}>Selected class — {review.pending ? 'checking' : 'not in this day'}</option>}{classes.filter(row => filters.grade === 'all' || gradeKey(row.gradeLevel) === filters.grade).map(row => <option key={row.classId} value={row.classId}>{row.name}</option>)}</select></label>
      {filters.view === 'teachers' && <label className="space-y-1 text-sm"><span>Review teacher</span><select className={inputClass} value={filters.teacher} onChange={event => change({ teacher: event.target.value })}><option value="all">All teachers</option>{filters.teacher !== 'all' && !options.teachers.some(([id]) => id === filters.teacher) && <option value={filters.teacher}>Selected teacher — {review.pending ? 'checking' : 'not in this day'}</option>}{options.teachers.map(([id, name]) => <option key={id} value={id}>{name}</option>)}</select></label>}
    </div>
    <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={filters.conflictsOnly} onChange={event => change({ conflictsOnly: event.target.checked })} />Show conflicts only</label>
    {data && <>
      {filteredIssues.length > 0 && <div className="space-y-3 rounded-lg border p-4"><h4 className="font-semibold">Schedule issues and overlaps</h4><DraftReviewIssues issues={filteredIssues} review={data} onEditIssue={onEditIssue} /></div>}
      {rows.length > 0 && <p className="text-xs text-muted-foreground sm:hidden">Scroll the timetable sideways to see proposed times and status.</p>}
      {rows.length ? <div role="region" aria-label="Proposed day timetable" tabIndex={0} className="overflow-x-auto rounded-lg border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2">
        <table className="w-full min-w-[720px] text-left text-sm"><thead className="sticky top-0 z-10 bg-muted"><tr><th className="p-3">{filters.view === 'teachers' ? 'Teacher / class or testing block' : 'Class / testing block'}</th><th className="p-3">Regular schedule</th><th className="p-3">Proposed schedule</th><th className="p-3">Status</th></tr></thead><tbody>
          {rows.map(({ type, id, row }) => <tr key={`${type}:${id}`} className="border-t" data-schedule-row={`${type}:${id}`}>
            <td className="space-y-1 p-3 align-top"><p className="font-medium">{row.name || 'Untitled testing block'}</p><p className="text-xs text-muted-foreground">{type === 'class' ? `${gradeName(gradeKey(row.gradeLevel) || 'unassigned')} · ${(row.staff || EMPTY).map(person => person.name).join(', ') || 'No assigned teacher'}` : `${row.groupName || 'Choose a group'} · ${row.staffName || 'Choose staff'} · ${row.studentCount || 0} students`}</p>
              {type === 'testing' && filters.classId !== 'all' && row.classParticipation?.filter(item => item.classId === filters.classId).map(item => <p key={item.classId} className="text-xs text-muted-foreground">{item.count} of {item.total} class students participate</p>)}
              {onEditIssue && <Button size="sm" variant="ghost" aria-label={type === 'class' ? `Edit affected class ${row.name}` : `Edit testing block ${row.name || 'Untitled testing block'}`} onClick={() => onEditIssue(type === 'class' ? { classId: id } : { blockId: id })}>Edit</Button>}
            </td>
            <td className="p-3 align-top text-muted-foreground">{type === 'testing' ? 'Additional testing supervision' : row.status === 'unavailable' ? 'Regular time unavailable' : row.status === 'schedule_off' ? 'Schedule off' : row.regularWindow ? timeText(row.regularWindow) : 'Does not meet on this reference date'}</td>
            <td className="p-3 align-top">{type === 'testing' ? row.startTime && row.endTime ? `${row.startTime}–${row.endTime}` : 'Times incomplete' : row.proposedStatus === 'incomplete' || (row.action === 'time' && row.status === 'meets' && !row.proposedWindow) ? 'Custom time incomplete' : row.status === 'unavailable' ? 'Schedule unavailable' : timeText(row.proposedWindow)}</td>
            <td className="space-y-2 p-3 align-top">
              {type === 'testing' ? <><Badge variant="secondary">Testing supervision</Badge>{row.status !== 'ready' && <p className="text-xs text-amber-800 dark:text-amber-300">Testing block needs review</p>}</> : <Badge variant="secondary">{row.proposedStatus === 'incomplete' ? 'Not checked yet' : row.status === 'not_scheduled' || row.status === 'schedule_off' ? 'Not meeting on this date' : row.action === 'skip' ? 'Skipped' : row.action === 'time' ? 'Custom time' : 'Unchanged'}</Badge>}
              <DraftReviewIssues compact issues={issues.filter(issue => type === 'class' ? issue.classIds?.includes(id) : issue.blockIds?.includes(id))} review={data} />
            </td>
          </tr>)}
        </tbody></table>
      </div> : <p className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">{filters.conflictsOnly ? 'No conflicting schedule rows match these filters.' : 'No schedule rows match these filters.'}</p>}
      <p className="text-xs text-muted-foreground">This view uses {data.referenceDate} in {data.schoolTimezone}. It is a proposed day, not a live schedule or an application approval. Ordinary classes retain their rosters.</p>
    </>}
  </section>;
}
