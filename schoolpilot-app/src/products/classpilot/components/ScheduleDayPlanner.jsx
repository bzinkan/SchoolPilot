import { useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, ChevronRight, Plus } from 'lucide-react';
import { Button } from '../../../components/ui/button';
import { Badge } from '../../../components/ui/badge';
import { DraftReviewIssues } from './ScheduleProfileDraftReview';
import {
  buildPlannerRows, filterPlannerRows, plannerAxis, plannerGradeKey, plannerGradeName,
  plannerIncluded, plannerMinutes, plannerTime, plannerValidWindow, plannerWindowText,
} from './scheduleDayPlannerModel';

const EMPTY = [];
const inputClass = 'min-w-0 w-full rounded-md border bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2';
const focusClass = 'rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2';
const striped = { backgroundImage: 'repeating-linear-gradient(135deg, transparent, transparent 7px, rgb(255 255 255 / .45) 7px, rgb(255 255 255 / .45) 12px)' };
const targetFor = row => row.type === 'class' ? { classId: row.id } : { blockId: row.id };
const activeRow = (row, target) => row.type === 'class' ? target?.classId === row.id : target?.blockId === row.id;

function rowStatus(row) {
  if (row.proposedStatus === 'incomplete') return 'Not checked yet';
  if (row.type === 'testing') return row.status === 'unavailable' ? 'Testing assignment unavailable' : 'Testing supervision';
  if (row.status === 'unavailable') return 'Schedule unavailable';
  if (row.status === 'schedule_off') return 'Schedule off';
  if (row.status === 'not_scheduled') return 'Not meeting on this date';
  if (row.proposedStatus === 'skipped') return 'Does not meet';
  return row.action === 'time' ? 'Custom time' : 'Keep existing schedule';
}

function proposedText(row) {
  if (row.proposedStatus === 'incomplete') return row.type === 'testing' ? 'Complete this testing block' : 'Custom time incomplete';
  if (row.type === 'class' && row.status === 'unavailable') return 'Schedule unavailable';
  if (row.type === 'class' && row.status === 'schedule_off') return 'Schedule off';
  if (row.type === 'class' && row.status === 'not_scheduled') return 'Does not meet on this preview date';
  return plannerWindowText(row.proposedWindow);
}

function RowDescription({ row, classId }) {
  return <div className="space-y-1 text-xs text-muted-foreground">
    {row.type === 'class' ? <>
      <p>{plannerGradeName(row.grade)} · {row.staff.map(person => person.name).join(', ') || row.teacherName || 'No assigned teacher'}</p>
      <p>{row.included ? row.byGrade ? 'Included by grade' : 'Included in profile' : 'Outside profile selection'}</p>
    </> : <>
      <p>{row.groupName || 'Choose a Supervision group'} · {row.staffName || 'Choose assigned staff'}</p>
      <p>{row.studentCount == null ? 'Student count unavailable' : `${row.studentCount} students`}</p>
      {classId && classId !== 'all' && (row.participationKnown
        ? row.classParticipation.filter(part => part.classId === classId).map(part => <p key={part.classId}>{part.count} of {part.total} class students participate</p>)
        : <p>Class participation is being checked.</p>)}
    </>}
  </div>;
}

function TimelineBars({ row, axis, disabled, onEdit }) {
  const conflict = row.issues.some(issue => issue.kind === 'conflict');
  const overlap = row.issues.some(issue => issue.kind === 'overlap');
  const styleFor = window => ({ left: `${(plannerMinutes(window.startTime) - axis.start) / (axis.end - axis.start) * 100}%`, width: `${(plannerMinutes(window.endTime) - plannerMinutes(window.startTime)) / (axis.end - axis.start) * 100}%` });
  return <div className="relative min-h-[88px]" data-timeline-bars={row.key}>
    {axis.ticks.map(tick => <span key={tick} aria-hidden="true" className="pointer-events-none absolute inset-y-0 border-l border-border/70" style={{ left: `${(tick - axis.start) / (axis.end - axis.start) * 100}%` }} />)}
    {row.regularWindow && <span aria-hidden="true" data-regular-window={plannerWindowText(row.regularWindow)} className="absolute top-3 h-1.5 rounded-sm bg-slate-500/65 dark:bg-slate-400/65" style={styleFor(row.regularWindow)} />}
    {row.proposedWindow ? <button type="button" disabled={disabled} onClick={onEdit} aria-label={`Change proposed time for ${row.name}: ${plannerWindowText(row.proposedWindow)}`}
      data-proposed-window={plannerWindowText(row.proposedWindow)}
      className={`absolute top-7 h-8 min-w-2 rounded border text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 ${conflict ? 'border-rose-700 bg-rose-300 dark:border-rose-300 dark:bg-rose-500' : row.type === 'testing' ? 'border-amber-600 bg-amber-300 dark:border-amber-300 dark:bg-amber-400' : 'border-blue-700 bg-blue-500 dark:border-blue-300 dark:bg-blue-500'} ${overlap && !conflict ? 'border-dashed border-2' : ''}`}
      style={{ ...styleFor(row.proposedWindow), ...(conflict ? striped : {}) }}><span className="sr-only">{rowStatus(row)}</span></button>
      : <p className="absolute left-2 top-7 max-w-full text-xs text-muted-foreground">{proposedText(row)}</p>}
    <p className="absolute left-2 top-[62px] text-[11px] text-muted-foreground">{conflict ? 'Conflict — review affected duties' : overlap ? 'Allowed overlap — regular class remains scheduled' : row.proposedStatus === 'skipped' ? 'Skipped meeting remains visible' : ''}</p>
  </div>;
}

function ClassEditor({ row, definition, disabled, onChange }) {
  const changeRule = (change, key) => onChange({ ...definition, classRules: [...definition.classRules.filter(rule => rule.classId !== row.id), ...(change ? [{ classId: row.id, ...change }] : [])] }, key);
  const toggleIncluded = checked => {
    if (row.byGrade) return;
    onChange({ ...definition, classIds: checked ? [...definition.classIds, row.id] : definition.classIds.filter(id => id !== row.id),
      classRules: checked ? definition.classRules : definition.classRules.filter(rule => rule.classId !== row.id) });
  };
  const cannotInclude = !row.included && (definition.classIds.length >= 500 || row.detailsUnavailable);
  const ruleLimit = !row.rule && definition.classRules.length >= 500;
  return <fieldset disabled={disabled} className="min-w-0 space-y-3" data-class-editor-id={row.id}>
    <label className="flex items-center gap-2 text-sm font-medium"><input type="checkbox" aria-label={`Include ${row.name}`} checked={row.included} disabled={row.byGrade || cannotInclude} onChange={event => toggleIncluded(event.target.checked)} />Include this class in the profile</label>
    {!row.included && <p className="text-xs text-muted-foreground">This class is visible to show the whole day. Explicitly include it before changing its schedule.{row.detailsUnavailable ? ' Refresh the preview-day check to load its details before including it.' : cannotInclude ? ' The 500 individual-class selection limit has been reached.' : ''}</p>}
    {row.byGrade && <p className="text-xs text-muted-foreground">This class is included by its grade. Manage the grade under Classes included below.</p>}
    <label className="block space-y-1 text-sm"><span>Class schedule</span><select className={inputClass} aria-label={`${row.name} schedule action`} disabled={!row.included} value={row.action} onChange={event => {
      if (event.target.value === 'keep') changeRule(null);
      else if (event.target.value === 'skip') changeRule({ action: 'skip' });
      else if (row.regularWindow) changeRule({ action: 'time', ...row.regularWindow });
    }}><option value="keep">Keep existing schedule</option><option value="time" disabled={ruleLimit || (!row.regularWindow && row.action !== 'time') || row.scheduleEnabled === false}>Custom time</option><option value="skip" disabled={ruleLimit || row.scheduleEnabled === false}>Does not meet</option></select></label>
    {ruleLimit && <p className="text-xs text-muted-foreground">This profile already has 500 class adjustments. Restore another class before adding a new adjustment.</p>}
    {row.action === 'time' && <div className="grid grid-cols-2 gap-3">
      <label className="space-y-1 text-sm"><span>Start</span><input type="time" className={inputClass} aria-label={`${row.name} profile start`} disabled={!row.included} value={row.rule.startTime} onChange={event => changeRule({ ...row.rule, startTime: event.target.value }, `class:${row.id}:start`)} /></label>
      <label className="space-y-1 text-sm"><span>End</span><input type="time" className={inputClass} aria-label={`${row.name} profile end`} disabled={!row.included} value={row.rule.endTime} onChange={event => changeRule({ ...row.rule, endTime: event.target.value }, `class:${row.id}:end`)} /></label>
    </div>}
    {!row.regularWindow && <p className="text-xs text-muted-foreground">{row.message || (row.status === 'not_scheduled' ? 'This class does not meet on this preview date. Existing profile rules still apply only on eligible application dates.' : 'An available regular meeting is required to start a custom time. Check the preview date and Bells & rotation.')}</p>}
    {row.action !== 'keep' && <Button type="button" size="sm" variant="outline" onClick={() => changeRule(null)}>Restore regular schedule<span className="sr-only"> for {row.name}</span></Button>}
  </fieldset>;
}

function TestingEditor({ row, definition, catalog, disabled, onChange, onEditGroup }) {
  const block = definition.testingBlocks.find(item => item.id === row.id);
  const groups = catalog.supervisionGroups || EMPTY;
  const group = groups.find(item => item.id === block.coverageGroupId);
  const people = new Map((catalog.staff || EMPTY).map(person => [person.id, person.name]));
  const change = (patch, field) => onChange({ ...definition, testingBlocks: definition.testingBlocks.map(item => item.id === row.id ? { ...item, ...patch } : item) }, field ? `testing:${row.id}:${field}` : undefined);
  const prefix = `Testing block ${row.index + 1}`;
  return <fieldset disabled={disabled} className="min-w-0 space-y-3" data-block-editor-id={row.id}>
    <div className="grid gap-3 sm:grid-cols-2">
      <label className="space-y-1 text-sm"><span>Block name</span><input className={inputClass} aria-label={`${prefix} name`} maxLength={80} value={block.name} onChange={event => change({ name: event.target.value }, 'name')} /></label>
      <label className="space-y-1 text-sm"><span>Supervision group</span><select className={inputClass} aria-label={`${prefix} Supervision group`} value={block.coverageGroupId} onChange={event => {
        const next = groups.find(item => item.id === event.target.value);
        const eligible = (next?.staffIds || EMPTY).filter(id => people.has(id));
        change({ coverageGroupId: event.target.value, assignedStaffId: eligible.length === 1 ? eligible[0] : '' });
      }}><option value="">Choose a group</option>{block.coverageGroupId && !group && <option value={block.coverageGroupId}>Unavailable supervision group</option>}{groups.map(item => <option key={item.id} value={item.id}>{item.name} · {item.studentCount ?? item.studentIds?.length ?? 'Unknown'} students</option>)}</select></label>
      <label className="space-y-1 text-sm"><span>Assigned staff</span><select className={inputClass} aria-label={`${prefix} assigned staff`} value={block.assignedStaffId} onChange={event => change({ assignedStaffId: event.target.value })}><option value="">Choose group staff</option>{block.assignedStaffId && (!group?.staffIds?.includes(block.assignedStaffId) || !people.has(block.assignedStaffId)) && <option value={block.assignedStaffId}>Unavailable staff assignment</option>}{(group?.staffIds || EMPTY).filter(id => people.has(id)).map(id => <option key={id} value={id}>{people.get(id)}</option>)}</select></label>
      <div className="grid grid-cols-2 gap-2">
        <label className="space-y-1 text-sm"><span>Start</span><input className={inputClass} type="time" aria-label={`${prefix} start`} value={block.startTime} onChange={event => change({ startTime: event.target.value }, 'start')} /></label>
        <label className="space-y-1 text-sm"><span>End</span><input className={inputClass} type="time" aria-label={`${prefix} end`} value={block.endTime} onChange={event => change({ endTime: event.target.value }, 'end')} /></label>
      </div>
    </div>
    {group && !group.staffIds?.some(id => people.has(id)) && <p className="text-xs text-destructive">Assign an active staff member to this Supervision group before using it for testing.</p>}
    {!plannerValidWindow(block) && <p className="text-xs text-amber-800 dark:text-amber-300">Enter valid times with the end after the start. This block is not checked yet.</p>}
    <p className="text-xs text-muted-foreground">Assigned staff must be paired with this group. The preview-day check separately checks their teaching and testing duties.</p>
    {onEditGroup && block.coverageGroupId && <Button size="sm" variant="outline" onClick={() => onEditGroup(block.coverageGroupId)}>Edit Supervision group</Button>}
  </fieldset>;
}

function PlannerIssues({ issues, rowsByKey, onEditTarget, disabled }) {
  if (!issues.length) return null;
  return <details className="rounded-lg border p-3" open><summary className={`cursor-pointer text-sm font-semibold ${focusClass}`}>Schedule issues and overlaps ({issues.length})</summary><div className="mt-3 space-y-3">
    {issues.map(issue => <div key={issue.id} className="space-y-1 text-sm">
      <p className={issue.kind === 'conflict' || issue.kind === 'incomplete' ? 'text-amber-800 dark:text-amber-300' : 'text-muted-foreground'}><strong>{issue.kind === 'conflict' ? 'Conflict: ' : issue.kind === 'overlap' ? 'Allowed overlap: ' : 'Needs review: '}</strong>{issue.message}</p>
      <div className="flex flex-wrap gap-x-3 gap-y-1">{[...(issue.classIds || EMPTY).map(id => rowsByKey.get(`class:${id}`)), ...(issue.blockIds || EMPTY).map(id => rowsByKey.get(`testing:${id}`))].filter(Boolean).map(row => <button type="button" key={row.key} disabled={disabled} className={`text-left font-medium text-primary underline underline-offset-4 ${focusClass}`} aria-label={row.type === 'class' ? `Resolve issue for class ${row.name}` : `Resolve issue for testing block ${row.name}`} onClick={() => onEditTarget(targetFor(row), issue)}>Edit {row.name}</button>)}</div>
    </div>)}
  </div></details>;
}

function PlannerRow({ row, timeline, axis, active, filters, definition, catalog, disabled, onChange, onEditTarget, onEditGroup, checked }) {
  const editorId = useId();
  const open = () => onEditTarget(targetFor(row));
  const close = event => {
    const opener = event.currentTarget.closest('[data-schedule-row]')?.querySelector('[data-row-opener]');
    onEditTarget(null);
    requestAnimationFrame(() => opener?.isConnected && opener.focus({ preventScroll: true }));
  };
  const remove = event => {
    const planner = event.currentTarget.closest('[data-day-planner]');
    onChange({ ...definition, testingBlocks: definition.testingBlocks.filter(item => item.id !== row.id) });
    onEditTarget(null);
    requestAnimationFrame(() => planner?.querySelector('[data-add-testing-block]')?.focus({ preventScroll: true }));
  };
  return <article data-schedule-row={row.key} aria-label={`${row.name} schedule row`} className={`min-w-0 border-t ${active ? 'bg-primary/5' : ''}`}>
    <div className={timeline ? 'grid min-w-[760px] grid-cols-[260px_minmax(480px,1fr)]' : 'grid gap-3 p-3 sm:grid-cols-[minmax(180px,1fr)_minmax(200px,1fr)]'}>
      <div className={timeline ? 'sticky left-0 z-10 space-y-2 border-r bg-background p-3' : 'space-y-2'}>
        <button type="button" data-row-opener className={`text-left text-sm font-semibold text-primary underline-offset-4 hover:underline ${focusClass}`} disabled={disabled} onClick={open} aria-expanded={active} aria-controls={active ? editorId : undefined} aria-label={row.type === 'class' ? `Edit affected class ${row.name}` : `Edit testing block ${row.name}`}>{row.name}</button>
        <RowDescription row={row} classId={filters.classId} />
      </div>
      <div className={timeline ? 'min-w-0 p-3' : 'space-y-2'}>
        {timeline && <TimelineBars row={row} axis={axis} disabled={disabled} onEdit={open} />}
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs"><p className="text-muted-foreground">Regular: {row.type === 'testing' ? 'No testing block' : row.regularWindow ? plannerWindowText(row.regularWindow) : row.status === 'unavailable' ? 'Unavailable' : row.status === 'schedule_off' ? 'Schedule off' : 'Does not meet'}</p><p>Proposed: {proposedText(row)}</p></div>
        <div className="mt-2 flex flex-wrap items-center gap-2"><Badge variant="secondary">{rowStatus(row)}</Badge>{!checked && <span className="text-xs text-muted-foreground">Checks pending or unavailable</span>}</div>
        <DraftReviewIssues compact issues={row.issues} />
      </div>
    </div>
    {active && <section id={editorId} aria-label={`Edit ${row.name} in Day planner`} className="max-w-full space-y-3 border-t p-4">
      <div className="flex items-center justify-between gap-3"><h4 className="text-sm font-semibold">Edit {row.name}</h4><Button type="button" size="sm" variant="ghost" onClick={close}>{row.type === 'testing' ? 'Close testing editor' : 'Close class editor'}<span className="sr-only"> for {row.name}</span></Button></div>
      {row.type === 'class' ? <ClassEditor row={row} definition={definition} disabled={disabled} onChange={onChange} /> : <><TestingEditor row={row} definition={definition} catalog={catalog} disabled={disabled} onChange={onChange} onEditGroup={onEditGroup} /><Button type="button" size="sm" variant="outline" disabled={disabled} className="text-destructive" aria-label={`Remove testing block ${row.index + 1}`} onClick={remove}>Remove testing block</Button></>}
      <p className="text-xs text-muted-foreground">Changes update this profile draft. Save profile keeps your work; Choose dates & apply schedules it separately.</p>
    </section>}
  </article>;
}

export default function ScheduleDayPlanner({ definition, catalog, regularSchedule, referenceDate, review, filters, onFiltersChange, plannerView = 'timeline', onPlannerViewChange, collapsedGrades = EMPTY, onCollapsedGradesChange, activeTarget, onEditTarget, onChange, onAddGroups, disabled, onEditGroup }) {
  const [metadata, setMetadata] = useState(null);
  const scroller = useRef(null);
  const horizontalPositions = useRef({ timeline: 0, list: 0 });
  const changeDisplay = next => {
    horizontalPositions.current[plannerView] = scroller.current?.scrollLeft || 0;
    onPlannerViewChange(next);
  };
  useLayoutEffect(() => { if (scroller.current) scroller.current.scrollLeft = horizontalPositions.current[plannerView] || 0; }, [plannerView]);
  // Retain labels/associations only, scoped to this mounted profile session and
  // date. Pending/failed checks never retain a previous conflict verdict.
  if (review.data?.referenceDate === referenceDate && metadata !== review.data) setMetadata(review.data);
  const model = useMemo(() => buildPlannerRows({ definition, catalog, regularSchedule, referenceDate, reviewData: review.data, metadata }), [definition, catalog, regularSchedule, referenceDate, review.data, metadata]);
  const visible = useMemo(() => filterPlannerRows(model.rows, filters, activeTarget), [model, filters, activeTarget]);
  const rowsByKey = useMemo(() => new Map(model.rows.map(row => [row.key, row])), [model]);
  const axis = useMemo(() => plannerAxis(model.rows), [model]);
  const options = useMemo(() => {
    const grades = new Map(), staff = new Map();
    for (const row of model.classes) {
      const values = grades.get(row.grade) || new Set();
      if (row.gradeLevel != null && row.gradeLevel !== '') values.add(String(row.gradeLevel));
      grades.set(row.grade, values);
      for (const person of row.staff) staff.set(person.id, person.name);
    }
    for (const grade of definition.grades) { const key = plannerGradeKey(grade); grades.set(key, new Set([...(grades.get(key) || EMPTY), grade])); }
    for (const row of model.testing) if (row.assignedStaffId) staff.set(row.assignedStaffId, row.staffName || 'Unavailable staff member');
    return { grades: [...grades].sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true })), staff: [...staff].sort(([, a], [, b]) => a.localeCompare(b)) };
  }, [model, definition.grades]);
  const issues = review.data?.referenceDate === referenceDate ? review.data.issues || EMPTY : EMPTY;
  const timeline = plannerView !== 'list';
  const schoolView = !filters.view || filters.view === 'school';
  const groups = useMemo(() => {
    if (!schoolView) return [{ key: 'all', label: null, rows: visible }];
    const result = new Map();
    for (const row of visible) { const key = row.type === 'testing' ? 'testing' : row.grade; result.set(key, [...(result.get(key) || EMPTY), row]); }
    return [...result].map(([key, rows]) => ({ key, label: key === 'testing' ? 'Testing blocks' : plannerGradeName(key), rows }));
  }, [visible, schoolView]);
  const changeFilters = patch => { onEditTarget(null); onFiltersChange({ ...filters, ...patch }); };
  const updateScope = patch => {
    const next = { ...definition, ...patch };
    const selected = new Set(model.classes.filter(row => plannerIncluded(next, row)).map(row => row.id));
    next.classRules = definition.classRules.filter(rule => selected.has(rule.classId));
    onChange(next);
  };
  const addBlock = () => {
    if (definition.testingBlocks.length >= 30) return;
    const block = { id: crypto.randomUUID(), name: 'Testing', coverageGroupId: '', assignedStaffId: '', startTime: '09:00', endTime: '10:45' };
    onChange({ ...definition, testingBlocks: [...definition.testingBlocks, block] });
    onEditTarget({ blockId: block.id });
  };
  const activeCount = model.classes.filter(row => row.included).length;
  const gradesOneToEight = Array.from({ length: 8 }, (_, index) => {
    const key = String(index + 1), values = options.grades.find(([grade]) => grade === key)?.[1];
    return values?.size ? [...values] : [key];
  }).flat();
  return <section aria-label="Day planner" data-day-planner className="min-w-0 space-y-4"><section aria-label="Draft schedule review" className="min-w-0 space-y-4">
    <div className="flex flex-wrap items-start justify-between gap-3"><div><h3 className="text-lg font-semibold" tabIndex={-1} data-review-heading>Day planner</h3><p className="mt-1 max-w-3xl text-sm text-muted-foreground">Click a class or testing bar to adjust the proposed day here. Regular classes stay scheduled until you explicitly change them.</p></div><div role="group" aria-label="Day planner display" className="flex gap-2"><Button size="sm" variant={timeline ? 'default' : 'outline'} aria-pressed={timeline} onClick={() => changeDisplay('timeline')}>Timeline</Button><Button size="sm" variant={!timeline ? 'default' : 'outline'} aria-pressed={!timeline} onClick={() => changeDisplay('list')}>List</Button></div></div>
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      <label className="space-y-1 text-sm"><span>Schedule view</span><select className={inputClass} value={filters.view || 'school'} onChange={event => changeFilters({ view: event.target.value, grade: 'all', classId: 'all', teacher: 'all' })}><option value="school">School</option><option value="classes">Class</option><option value="teachers">Teacher</option></select></label>
      <label className="space-y-1 text-sm"><span>Review grade</span><select className={inputClass} value={filters.grade || 'all'} onChange={event => changeFilters({ grade: event.target.value, classId: 'all' })}><option value="all">All grades</option>{options.grades.map(([grade]) => <option key={grade} value={grade}>{plannerGradeName(grade)}</option>)}</select></label>
      {filters.view === 'teachers' ? <label className="space-y-1 text-sm"><span>Review teacher</span><select className={inputClass} value={filters.teacher || 'all'} onChange={event => changeFilters({ teacher: event.target.value })}><option value="all">All teachers</option>{filters.teacher && filters.teacher !== 'all' && !options.staff.some(([id]) => id === filters.teacher) && <option value={filters.teacher}>Selected teacher — checking availability</option>}{options.staff.map(([id, name]) => <option key={id} value={id}>{name}</option>)}</select></label>
        : <label className="space-y-1 text-sm"><span>Review class</span><select className={inputClass} value={filters.classId || 'all'} onChange={event => changeFilters({ classId: event.target.value })}><option value="all">All classes</option>{model.classes.filter(row => !filters.grade || filters.grade === 'all' || row.grade === filters.grade).map(row => <option key={row.id} value={row.id}>{row.name}</option>)}</select></label>}
      <label className="space-y-1 text-sm"><span>Find a class or teacher</span><input className={inputClass} type="search" value={filters.search || ''} onChange={event => changeFilters({ search: event.target.value })} /></label>
    </div>
    <div className="flex flex-wrap items-center gap-3"><label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={Boolean(filters.conflictsOnly)} onChange={event => changeFilters({ conflictsOnly: event.target.checked })} />Show conflicts only</label><Button variant="ghost" size="sm" onClick={() => changeFilters({ grade: 'all', classId: 'all', teacher: 'all', search: '', conflictsOnly: false })}>Clear display filters</Button><p className="text-xs text-muted-foreground">Display filters do not change the {activeCount} classes included in this profile.</p></div>
    <p aria-label="Whole profile summary" className="text-sm">{activeCount} classes included · {definition.classRules.filter(rule => rule.action === 'time').length} custom-time rules · {definition.classRules.filter(rule => rule.action === 'skip').length} skipped-class rules · {definition.testingBlocks.length} testing blocks</p>
    <PlannerIssues issues={issues} rowsByKey={rowsByKey} onEditTarget={onEditTarget} disabled={disabled} />
    <div className="flex flex-wrap items-center gap-2"><Button variant="outline" size="sm" disabled={disabled || definition.testingBlocks.length >= 30} onClick={onAddGroups}>Add testing groups</Button><Button data-add-testing-block variant="outline" size="sm" disabled={disabled || definition.testingBlocks.length >= 30} onClick={addBlock}><Plus className="mr-2 h-4 w-4" />Add testing block</Button><span className="text-xs text-muted-foreground">{definition.testingBlocks.length}/30 testing blocks</span></div>
    {timeline && <><div aria-label="Timeline legend" className="flex flex-wrap gap-x-5 gap-y-2 text-xs"><span className="flex items-center gap-2"><span aria-hidden="true" className="h-1 w-6 bg-slate-500" />Regular time</span><span className="flex items-center gap-2"><span aria-hidden="true" className="h-3 w-6 rounded bg-blue-500" />Proposed class</span><span className="flex items-center gap-2"><span aria-hidden="true" className="h-3 w-6 rounded bg-amber-400" />Testing</span><span className="flex items-center gap-2"><span aria-hidden="true" className="h-3 w-6 rounded bg-rose-400" style={striped} />Conflict</span><span>Dashed border: allowed overlap</span></div><p className="text-xs text-muted-foreground sm:hidden">Scroll the timeline sideways, or use List for a stacked view.</p></>}
    {filters.conflictsOnly && !review.data && <p role="status" className="rounded border p-3 text-sm">Conflict results are pending or unavailable. Clear display filters to keep editing the day.</p>}
    <div ref={scroller} role="region" aria-label={timeline ? 'Proposed day timeline' : 'Proposed day timetable'} tabIndex={0} className={`min-w-0 rounded-lg border ${timeline ? 'overflow-x-auto' : ''} ${focusClass}`}>
      {timeline && <div className="grid min-w-[760px] grid-cols-[260px_minmax(480px,1fr)] border-b bg-muted text-xs"><div className="sticky left-0 z-10 border-r bg-muted p-3 font-medium">Class / supervision</div><div className="px-3"><div className="relative h-12">{axis.ticks.map(tick => <span key={tick} className="absolute top-3 whitespace-nowrap" style={{ left: `${(tick - axis.start) / (axis.end - axis.start) * 100}%`, transform: tick === axis.end ? 'translateX(-100%)' : 'none' }}>{plannerTime(tick)}</span>)}</div></div></div>}
      {groups.map(group => {
        const collapsed = collapsedGrades.includes(group.key) && !group.rows.some(row => activeRow(row, activeTarget));
        return <div key={group.key}>
          {group.label && <button type="button" className={`flex w-full items-center gap-2 bg-muted/60 p-3 text-left text-sm font-semibold ${focusClass}`} aria-expanded={!collapsed} onClick={() => {
            if (!collapsed && group.rows.some(row => activeRow(row, activeTarget))) onEditTarget(null);
            onCollapsedGradesChange(collapsed ? collapsedGrades.filter(key => key !== group.key) : [...new Set([...collapsedGrades, group.key])]);
          }}>{collapsed ? <ChevronRight aria-hidden="true" className="h-4 w-4" /> : <ChevronDown aria-hidden="true" className="h-4 w-4" />}{group.label}<span className="font-normal text-muted-foreground">({group.rows.length})</span></button>}
          {!collapsed && group.rows.map(row => <PlannerRow key={row.key} row={row} timeline={timeline} axis={axis} active={activeRow(row, activeTarget)} filters={filters} definition={definition} catalog={catalog} disabled={disabled} onChange={onChange} onEditTarget={onEditTarget} onEditGroup={onEditGroup} checked={Boolean(review.data)} />)}
        </div>;
      })}
      {!visible.length && <p className="p-4 text-sm text-muted-foreground">{filters.conflictsOnly && !review.data ? 'Current conflict results are not available.' : filters.conflictsOnly ? 'No conflicting schedule rows match these display filters.' : 'No schedule rows match these display filters.'}</p>}
    </div>
    <details className="rounded-lg border p-3"><summary className={`cursor-pointer text-sm font-semibold ${focusClass}`}>Classes included ({activeCount})</summary><fieldset disabled={disabled} className="mt-3 space-y-3">
      <p className="text-xs text-muted-foreground">Select grades here, or open a class row to include it individually. Removing a class from the profile also removes its custom-time or skipped-class rule.</p>
      <Button size="sm" variant="outline" disabled={gradesOneToEight.length > 30} onClick={() => updateScope({ grades: gradesOneToEight })}>Select grades 1–8</Button>
      <div className="flex flex-wrap gap-3">{options.grades.filter(([grade]) => grade !== 'unassigned').map(([grade, values]) => {
        const gradeValues = [...values];
        const nextGrades = [...new Set([...definition.grades, ...gradeValues])];
        return <label key={grade} className="flex items-center gap-2 text-sm"><input type="checkbox" aria-label={`Include ${plannerGradeName(grade)}`} disabled={nextGrades.length > 30 && !gradeValues.some(value => definition.grades.includes(value))} checked={gradeValues.length > 0 && gradeValues.every(value => definition.grades.includes(value))} ref={element => { if (element) element.indeterminate = gradeValues.some(value => definition.grades.includes(value)) && !gradeValues.every(value => definition.grades.includes(value)); }} onChange={event => updateScope({ grades: event.target.checked ? nextGrades : definition.grades.filter(value => plannerGradeKey(value) !== grade) })} />{plannerGradeName(grade)}</label>;
      })}</div><Button size="sm" variant="ghost" onClick={() => updateScope({ grades: [], classIds: [] })}>Clear class selection</Button>
    </fieldset></details>
    <p className="text-xs text-muted-foreground">Profile preview for {referenceDate} · {review.data?.schoolTimezone || catalog.schoolTimezone}. It uses current regular settings and this draft; actual application dates are checked separately. Ordinary class rosters stay in place.</p>
  </section></section>;
}
