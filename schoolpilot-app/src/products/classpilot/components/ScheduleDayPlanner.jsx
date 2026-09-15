import { useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, ChevronRight, Plus } from 'lucide-react';
import { Button } from '../../../components/ui/button';
import { DraftReviewIssues, DraftReviewStatus } from './ScheduleProfileDraftReview';
import ScheduleClassForTime from './ScheduleClassForTime';
import ScheduleAfterTesting from './ScheduleAfterTesting';
import { classPlacementFingerprint, classPlacementUnavailable } from './scheduleClassPlacement';
import {
  buildPlannerRows, buildPlannerOccurrences, capturePlannerRanks, filterPlannerRows, plannerAxis, plannerGradeKey, plannerGradeName,
  plannerIncluded, plannerClipWindow, plannerOutsideHours, plannerTime, plannerValidWindow, plannerWindowText,
} from './scheduleDayPlannerModel';

const EMPTY = [];
const inputClass = 'min-w-0 w-full rounded-md border bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2';
const focusClass = 'rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2';
const striped = { backgroundImage: 'repeating-linear-gradient(135deg, transparent, transparent 7px, rgb(255 255 255 / .45) 7px, rgb(255 255 255 / .45) 12px)' };
const targetFor = row => row.type === 'class' ? { classId: row.id } : { blockId: row.id };

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
  const regular = plannerClipWindow(row.regularWindow, axis);
  const proposed = plannerClipWindow(row.proposedWindow, axis);
  const outsideProposed = plannerOutsideHours(row.proposedWindow, axis);
  const outsideRegular = plannerOutsideHours(row.regularWindow, axis);
  const outsideLabel = outsideProposed ? `Outside ${axis.source === 'configured' ? 'school' : 'displayed'} hours`
    : outsideRegular ? `Regular time outside ${axis.source === 'configured' ? 'school' : 'displayed'} hours` : '';
  const styleFor = window => ({ left: `${(window.start - axis.start) / (axis.end - axis.start) * 100}%`, width: `${(window.end - window.start) / (axis.end - axis.start) * 100}%` });
  return <div className="relative min-h-[62px]" data-timeline-bars={row.key} data-planner-track>
    {axis.ticks.map(tick => <span key={tick} aria-hidden="true" className="pointer-events-none absolute inset-y-0 border-l border-border/70" style={{ left: `${(tick - axis.start) / (axis.end - axis.start) * 100}%` }} />)}
    {regular && <span aria-hidden="true" data-regular-window={plannerWindowText(row.regularWindow)} className="absolute top-[6px] h-1 rounded-sm bg-slate-500/65 dark:bg-slate-400/65" style={styleFor(regular)} />}
    {proposed ? <button type="button" disabled={disabled} onClick={onEdit} aria-label={`Change proposed time for ${row.name}: ${plannerWindowText(row.proposedWindow)}`}
      data-proposed-window={plannerWindowText(row.proposedWindow)}
      className={`absolute top-4 h-6 rounded border text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 ${row.type === 'testing' ? 'border-amber-600 bg-amber-300 dark:border-amber-300 dark:bg-amber-400' : 'border-blue-700 bg-blue-500 dark:border-blue-300 dark:bg-blue-500'} ${overlap ? 'border-dashed' : ''}`}
      style={styleFor(proposed)}><span className="sr-only">{rowStatus(row)}{conflict ? '. Conflict — review affected duties' : overlap ? '. Allowed overlap — regular class remains scheduled' : ''}</span></button> : null}
    {(row.overlapSpans || EMPTY).filter(span => span.kind === 'conflict').map(span => {
      const clipped = plannerClipWindow(span, axis);
      return clipped && <span key={span.issueId} aria-hidden="true" data-overlap-interval={`${span.startTime}–${span.endTime}`} className="pointer-events-none absolute top-[17px] h-[22px] bg-rose-400 dark:bg-rose-500" style={{ ...striped, ...styleFor(clipped) }} />;
    })}
    <p className="pointer-events-none relative flex flex-wrap gap-x-2 pb-1 pt-[42px] text-[11px] leading-4"><span>{proposedText(row)}</span>{outsideLabel && <span className="font-medium text-amber-900 dark:text-amber-200">{outsideLabel}</span>}<span className={conflict ? 'font-medium text-rose-800 dark:text-rose-200' : 'text-muted-foreground'}>{conflict ? 'Conflict' : overlap ? 'Allowed overlap · class remains scheduled' : row.type === 'testing' ? rowStatus(row) : row.action === 'time' ? 'Custom time' : row.proposedStatus === 'skipped' ? 'Skipped' : ''}</span>{row.type === 'class' && !row.included && <span className="text-muted-foreground">Outside profile</span>}</p>
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
  const [expanded, setExpanded] = useState(false);
  if (!issues.length) return null;
  const counts = ['conflict', 'overlap', 'incomplete'].map(kind => issues.filter(issue => issue.kind === kind).length);
  return <details className="rounded-lg border px-3 py-2" data-planner-issues open={expanded} onToggle={event => setExpanded(event.currentTarget.open)}><summary className={`cursor-pointer text-sm font-semibold ${focusClass}`}>Schedule issues and overlaps<span className="ml-2 font-normal text-muted-foreground">{counts[0]} {counts[0] === 1 ? 'conflict' : 'conflicts'} · {counts[1]} allowed {counts[1] === 1 ? 'overlap' : 'overlaps'} · {issues.length - counts[0] - counts[1]} need review</span></summary><div className="mt-3 space-y-3">
    {issues.map(issue => <div key={issue.id} className="space-y-1 text-sm">
      <p className={issue.kind === 'conflict' || issue.kind === 'incomplete' ? 'text-amber-800 dark:text-amber-300' : 'text-muted-foreground'}><strong>{issue.kind === 'conflict' ? 'Conflict: ' : issue.kind === 'overlap' ? 'Allowed overlap: ' : 'Needs review: '}</strong>{issue.message}</p>
      <div className="flex flex-wrap gap-x-3 gap-y-1">{[...(issue.classIds || EMPTY).map(id => rowsByKey.get(`class:${id}`)), ...(issue.blockIds || EMPTY).map(id => rowsByKey.get(`testing:${id}`))].filter(Boolean).map(row => <button type="button" key={row.key} disabled={disabled} className={`text-left font-medium text-primary underline underline-offset-4 ${focusClass}`} aria-label={row.type === 'class' ? `Resolve issue for class ${row.name}` : `Resolve issue for testing block ${row.name}`} onClick={() => onEditTarget(targetFor(row), issue)}>Edit {row.name}</button>)}</div>
    </div>)}
  </div></details>;
}

function PlannerRow({ occurrence, timeline, axis, active, filters, definition, catalog, disabled, onChange, onEditTarget, onEditGroup, checked, onPlaceClass, afterTestingPending, referenceDate, classes }) {
  const { row, linked, pinned } = occurrence;
  const editorId = useId();
  const open = () => onEditTarget(targetFor(row), undefined, occurrence);
  const close = event => {
    const planner = event.currentTarget.closest('[data-day-planner]');
    const opener = event.currentTarget.closest('[data-schedule-row]')?.querySelector('[data-row-opener]');
    onEditTarget(null);
    requestAnimationFrame(() => {
      const next = opener?.isConnected ? opener : [...(planner?.querySelectorAll('[data-schedule-row]') || EMPTY)].find(element => element.dataset.scheduleRow === row.key)?.querySelector('[data-row-opener]') || planner?.querySelector('[data-add-testing-block]');
      next?.focus({ preventScroll: true });
      if (next && next !== opener) next.scrollIntoView({ block: 'center', inline: 'nearest' });
    });
  };
  const remove = event => {
    const planner = event.currentTarget.closest('[data-day-planner]');
    onChange({ ...definition, testingBlocks: definition.testingBlocks.filter(item => item.id !== row.id) });
    onEditTarget(null);
    requestAnimationFrame(() => planner?.querySelector('[data-add-testing-block]')?.focus({ preventScroll: true }));
  };
  const conflict = row.issues.some(issue => issue.kind === 'conflict');
  const staffText = row.type === 'class' ? row.staff.map(person => person.name).join(', ') || row.teacherName || 'No assigned teacher' : row.staffName || 'Choose assigned staff';
  const participation = filters.classId && filters.classId !== 'all' ? row.classParticipation?.find(part => part.classId === filters.classId) : null;
  return <article data-schedule-row={row.key} data-row-occurrence={occurrence.key} aria-label={`${row.name} schedule row`} className={`min-w-0 border-t ${active ? 'bg-primary/5' : ''}`}>
    <div data-planner-compact-row style={timeline ? { minWidth: 'var(--planner-grid-width)' } : undefined} className={timeline ? 'grid grid-cols-[260px_minmax(480px,1fr)]' : 'grid gap-2 p-3 sm:grid-cols-[minmax(180px,1fr)_minmax(200px,1fr)]'}>
      <div className={timeline ? 'sticky left-0 z-10 min-w-0 border-r bg-background px-3 py-2' : 'min-w-0 space-y-1'}>
        <div className="flex flex-wrap items-baseline gap-x-2"><button type="button" data-row-opener className={`text-left text-sm font-semibold text-primary underline-offset-4 hover:underline ${focusClass}`} disabled={disabled} onClick={open} aria-expanded={active} aria-controls={active ? editorId : undefined} aria-label={row.type === 'class' ? `Edit affected class ${row.name}` : `Edit testing block ${row.name}`}>{row.name}</button>{linked && <span className="text-[11px] text-muted-foreground" aria-label="Linked view of the same testing block">Linked</span>}</div>
        <p className="text-xs text-muted-foreground">{staffText}{row.type === 'testing' && <span> · {row.studentCount == null ? 'Student count unavailable' : `${row.studentCount} students total`}</span>}</p>
        {!timeline && <RowDescription row={row} classId={filters.classId} />}
      </div>
      <div className={timeline ? 'min-w-0 px-3' : 'space-y-1 text-xs'}>
        {timeline ? <TimelineBars row={row} axis={axis} disabled={disabled} onEdit={open} /> : <><p>Proposed: {proposedText(row)}</p><p className="text-muted-foreground">{rowStatus(row)}</p>{conflict && <p className="font-medium text-rose-800 dark:text-rose-200">Conflict — review affected duties</p>}</>}
        {timeline && participation && <p className="pb-1 text-xs text-muted-foreground">{participation.count} of {participation.total} class students participate</p>}
        {row.type === 'class' && !row.included && <span className="sr-only">Outside profile selection</span>}
        {!checked && <span className="sr-only">Checks pending or unavailable</span>}
      </div>
    </div>
    {row.type === 'testing' && !active && <div className={timeline ? 'sticky left-0 max-w-full' : ''} style={timeline ? { width: 'var(--planner-visible-width, 100%)' } : undefined}><ScheduleAfterTesting compact data={row.afterTesting} pending={afterTestingPending} name={row.name} date={referenceDate} classes={classes} testingBlocks={definition.testingBlocks} /></div>}
    {active && <section id={editorId} aria-label={`Edit ${row.name} in Day planner`} className="sticky left-0 max-w-full space-y-3 border-t bg-background p-4" style={timeline ? { width: 'var(--planner-visible-width, 100%)' } : undefined}>
      <div className="flex items-center justify-between gap-3"><h4 className="text-sm font-semibold">Edit {row.name}</h4><Button type="button" size="sm" variant="ghost" onClick={close}>{row.type === 'testing' ? 'Close testing editor' : 'Close class editor'}<span className="sr-only"> for {row.name}</span></Button></div>
      <RowDescription row={row} classId={filters.classId} />
      {linked && <p className="text-xs text-muted-foreground">This is the same testing block shown beside other grades. Changes here update every linked view; the block is counted once.</p>}
      {pinned && <p className="text-xs text-muted-foreground">This editor stays here while you work. Updated class participation is shown in the other linked rows.</p>}
      {row.type === 'testing' && occurrence.participation?.length > 0 && filters.classId === 'all' && <div className="text-xs text-muted-foreground">{occurrence.participation.map(part => <p key={part.classId}>{part.count} of {part.total} students in {catalog.classes.find(item => item.id === part.classId)?.name || 'associated class'} participate</p>)}</div>}
      <p className="text-xs text-muted-foreground">Regular: {row.type === 'testing' ? 'No testing block' : row.regularWindow ? plannerWindowText(row.regularWindow) : row.status === 'unavailable' ? 'Unavailable' : row.status === 'schedule_off' ? 'Schedule off' : 'Does not meet'}</p>
      <DraftReviewIssues compact issues={row.issues} />
      {row.type === 'class' ? <><ClassEditor row={row} definition={definition} disabled={disabled} onChange={onChange} /><div className="space-y-1"><Button type="button" size="sm" variant="outline" disabled={disabled || Boolean(classPlacementUnavailable(row, true))} aria-label={`Class for this time for ${row.name}`} onClick={event => onPlaceClass(row, event.currentTarget)}>Class for this time</Button><p className="text-xs text-muted-foreground">{classPlacementUnavailable(row, true) || 'Use another existing class at this proposed time, then review a swap or skip for this class.'}</p></div></> : <><TestingEditor row={row} definition={definition} catalog={catalog} disabled={disabled} onChange={onChange} onEditGroup={onEditGroup} /><ScheduleAfterTesting data={row.afterTesting} pending={afterTestingPending} name={row.name} date={referenceDate} classes={classes} testingBlocks={definition.testingBlocks} /><Button type="button" size="sm" variant="outline" disabled={disabled} className="text-destructive" aria-label={`Remove testing block ${row.index + 1}`} onClick={remove}>Remove testing block</Button></>}
      <p className="text-xs text-muted-foreground">Changes update this profile draft. Save profile keeps your work; Choose dates & apply schedules it separately.</p>
    </section>}
  </article>;
}

export default function ScheduleDayPlanner({ definition, catalog, regularSchedule, referenceDate, hoursQuery, review, reviewRetry, validReviewDate = true, savedReview = false, filters, onFiltersChange, plannerView = 'timeline', onPlannerViewChange, collapsedGrades = EMPTY, onCollapsedGradesChange, activeTarget, onEditTarget, onChange, onAddGroups, disabled, onEditGroup }) {
  const [metadata, setMetadata] = useState(null);
  const [layout, setLayout] = useState({ date: null, ranks: undefined });
  const [anchor, setAnchor] = useState(null);
  const [placement, setPlacement] = useState(null);
  const placementOpener = useRef(null);
  const planner = useRef(null);
  const scroller = useRef(null);
  const timeHeader = useRef(null);
  const axis = useMemo(() => plannerAxis(hoursQuery.data), [hoursQuery.data]);
  const hoursReady = Boolean(hoursQuery.data) && !hoursQuery.isError;
  const timelineAvailable = hoursReady && axis.source !== 'unavailable';
  const timeline = plannerView !== 'list' && timelineAvailable;
  const horizontalPositions = useRef({ timeline: 0, list: 0 });
  const changeDisplay = next => {
    horizontalPositions.current[plannerView] = scroller.current?.scrollLeft || 0;
    onPlannerViewChange(next);
  };
  useLayoutEffect(() => {
    const position = horizontalPositions.current[plannerView] || 0;
    if (scroller.current) scroller.current.scrollLeft = position;
    if (timeHeader.current) timeHeader.current.scrollLeft = position;
    const root = planner.current, viewport = scroller.current;
    const toolbar = root?.closest('[data-testid="schedule-profile-workspace"]')?.querySelector(':scope > header');
    if (!root || !viewport) return undefined;
    const measure = () => {
      root.style.setProperty('--planner-visible-width', `${viewport.clientWidth}px`);
      root.style.setProperty('--planner-toolbar-offset', `${toolbar?.getBoundingClientRect().height || 0}px`);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(viewport);
    if (toolbar) observer.observe(toolbar);
    return () => observer.disconnect();
  }, [plannerView, timeline]);
  // Retain labels/associations only, scoped to this mounted profile session and
  // date. Pending/failed checks never retain a previous conflict verdict.
  if (review.data?.referenceDate === referenceDate && metadata !== review.data) setMetadata(review.data);
  const model = useMemo(() => buildPlannerRows({ definition, catalog, regularSchedule, referenceDate, reviewData: review.data, metadata }), [definition, catalog, regularSchedule, referenceDate, review.data, metadata]);
  const placementFingerprint = useMemo(() => classPlacementFingerprint({ definition, classes: model.classes, referenceDate, revision: catalog.revision }), [definition, model.classes, referenceDate, catalog.revision]);
  const openPlacement = (row, opener) => {
    if (disabled || classPlacementUnavailable(row, true)) return;
    placementOpener.current = opener;
    setPlacement({ originalId: row.id, definition: structuredClone(definition), classes: structuredClone(model.classes), referenceDate, fingerprint: placementFingerprint });
  };
  const returnPlacementFocus = classId => requestAnimationFrame(() => {
    const root = planner.current;
    if (!root) return;
    const editor = classId ? [...root.querySelectorAll('[data-class-editor-id]')].find(element => element.dataset.classEditorId === classId) : null;
    const preferred = classId ? editor?.querySelector('select:not(:disabled), input:not(:disabled), button:not(:disabled)') : placementOpener.current;
    const control = preferred?.isConnected && !preferred.matches(':disabled') ? preferred : root.querySelector('[data-review-heading]');
    if (control) { control.focus({ preventScroll: true }); control.scrollIntoView({ block: 'center', inline: 'nearest' }); }
  });
  const visible = useMemo(() => filterPlannerRows(model.rows, filters, activeTarget), [model, filters, activeTarget]);
  const rowsByKey = useMemo(() => new Map(model.rows.map(row => [row.key, row])), [model]);
  const ranks = useMemo(() => capturePlannerRanks(model.rows, layout.date === referenceDate ? layout.ranks : undefined), [model.rows, layout.date, layout.ranks, referenceDate]);
  if (layout.date !== referenceDate || layout.ranks !== ranks) setLayout({ date: referenceDate, ranks });
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
  const issues = model.issues || EMPTY;
  const schoolView = !filters.view || filters.view === 'school';
  const targetKey = activeTarget?.classId ? `class:${activeTarget.classId}` : activeTarget?.blockId ? `testing:${activeTarget.blockId}` : null;
  const activeAnchor = anchor?.rowKey === targetKey && anchor?.date === referenceDate && anchor.schoolView === schoolView ? anchor : null;
  const occurrences = useMemo(() => buildPlannerOccurrences({ rows: visible, allRows: model.rows, schoolView, ranks, filters, activeOccurrence: activeAnchor }), [visible, model.rows, schoolView, ranks, filters, activeAnchor]);
  const editorOccurrence = occurrences.find(occurrence => occurrence.key === activeAnchor?.key) || occurrences.find(occurrence => occurrence.rowKey === targetKey);
  // Capture the clicked occurrence, not just its block ID. New review metadata
  // may move linked appearances, but must not unmount a focused inline editor.
  if (editorOccurrence && !activeAnchor) setAnchor({ ...editorOccurrence, date: referenceDate, schoolView });
  if (!targetKey && anchor) setAnchor(null);
  const editOccurrence = (target, issue, occurrence) => {
    setAnchor(occurrence ? { ...occurrence, date: referenceDate, schoolView } : null);
    onEditTarget(target, issue);
  };
  const groups = useMemo(() => {
    const result = new Map();
    for (const occurrence of occurrences) result.set(occurrence.groupKey, [...(result.get(occurrence.groupKey) || EMPTY), occurrence]);
    return [...result].map(([key, rows]) => ({ key, label: key === 'all' ? null : key === 'testing' ? 'Other testing / participation unavailable' : plannerGradeName(key), rows }));
  }, [occurrences]);
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
  const revealFocusedControl = event => {
    const control = event.target;
    if (!control.closest('[data-class-editor-id], [data-block-editor-id]')) return;
    // Native focus scrolling does not account for the profile toolbar. On a
    // narrow screen it can occupy more than half the viewport.
    requestAnimationFrame(() => {
      if (!control.isConnected || document.activeElement !== control) return;
      const toolbar = planner.current?.closest('[data-testid="schedule-profile-workspace"]')?.querySelector(':scope > header');
      const bounds = control.getBoundingClientRect();
      const header = timeHeader.current?.getBoundingClientRect();
      const covered = Math.max(toolbar?.getBoundingClientRect().bottom || 0, header && header.top < window.innerHeight ? header.bottom : 0);
      const top = Math.min(covered + 12, window.innerHeight - bounds.height - 12);
      if (bounds.top < top) window.scrollBy({ top: bounds.top - top });
      else if (bounds.bottom > window.innerHeight - 12) window.scrollBy({ top: bounds.bottom - window.innerHeight + 12 });
    });
  };
  const gradesOneToEight = Array.from({ length: 8 }, (_, index) => {
    const key = String(index + 1), values = options.grades.find(([grade]) => grade === key)?.[1];
    return values?.size ? [...values] : [key];
  }).flat();
  return <section ref={planner} aria-label="Day planner" data-day-planner onFocusCapture={revealFocusedControl} style={{ '--planner-grid-width': `${Math.max(760, 284 + (axis.ticks.length - 1) * 72)}px` }} className="min-w-0 space-y-4"><section aria-label="Draft schedule review" className="min-w-0 space-y-4">
    <DraftReviewStatus review={{ ...review, data: model.reviewCurrent ? review.data : null, error: review.error || (review.data && !model.reviewCurrent ? { message: 'The schedule comparison changed. Refresh the preview-day check before relying on conflict results.' } : null), retry: reviewRetry || review.retry }} validDate={validReviewDate} saved={savedReview} />
    <div className="flex flex-wrap items-start justify-between gap-3"><div><h3 className="text-lg font-semibold" tabIndex={-1} data-review-heading>Day planner</h3><p className="mt-1 max-w-3xl text-sm text-muted-foreground">Click a class or testing bar to adjust the proposed day here. Regular classes stay scheduled until you explicitly change them.</p></div><div role="group" aria-label="Day planner display" className="flex gap-2"><Button size="sm" variant={timeline ? 'default' : 'outline'} aria-pressed={timeline} disabled={!timelineAvailable} onClick={() => changeDisplay('timeline')}>Timeline</Button><Button size="sm" variant={!timeline ? 'default' : 'outline'} aria-pressed={!timeline} onClick={() => changeDisplay('list')}>List</Button></div></div>
    <div data-school-hours-notice role="status" className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
      {hoursQuery.isError ? <><span>School hours could not load. Use List while they are unavailable.</span><Button size="sm" variant="outline" disabled={hoursQuery.isFetching} onClick={() => hoursQuery.refetch()}>Retry school hours</Button></>
        : !hoursReady ? <span>Loading school hours. List remains available.</span>
          : axis.source === 'unavailable' ? <span>School hours need a valid start and end within the same day. Use List, or correct the times in Monitoring Hours.</span>
            : <span>{axis.source === 'configured' ? 'School hours' : 'Default display hours'}: {plannerTime(axis.start)}–{plannerTime(axis.end)} · {catalog.schoolTimezone}.{axis.source === 'default' ? ' Monitoring Hours is not enabled; the timeline uses 8:00 AM–4:00 PM.' : ' From Monitoring Hours.'} Out-of-range entries stay editable; their bars are limited to these hours.</span>}
    </div>
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      <label className="space-y-1 text-sm"><span>Schedule view</span><select className={inputClass} value={filters.view || 'school'} onChange={event => changeFilters({ view: event.target.value, grade: 'all', classId: 'all', teacher: 'all' })}><option value="school">School</option><option value="classes">Class</option><option value="teachers">Teacher</option></select></label>
      <label className="space-y-1 text-sm"><span>Review grade</span><select className={inputClass} value={filters.grade || 'all'} onChange={event => changeFilters({ grade: event.target.value, classId: 'all' })}><option value="all">All grades</option>{options.grades.map(([grade]) => <option key={grade} value={grade}>{plannerGradeName(grade)}</option>)}</select></label>
      {filters.view === 'teachers' ? <label className="space-y-1 text-sm"><span>Review teacher</span><select className={inputClass} value={filters.teacher || 'all'} onChange={event => changeFilters({ teacher: event.target.value })}><option value="all">All teachers</option>{filters.teacher && filters.teacher !== 'all' && !options.staff.some(([id]) => id === filters.teacher) && <option value={filters.teacher}>Selected teacher — checking availability</option>}{options.staff.map(([id, name]) => <option key={id} value={id}>{name}</option>)}</select></label>
        : <label className="space-y-1 text-sm"><span>Review class</span><select className={inputClass} value={filters.classId || 'all'} onChange={event => changeFilters({ classId: event.target.value })}><option value="all">All classes</option>{model.classes.filter(row => !filters.grade || filters.grade === 'all' || row.grade === filters.grade).map(row => <option key={row.id} value={row.id}>{row.name}</option>)}</select></label>}
      <label className="space-y-1 text-sm"><span>Find a class or teacher</span><input className={inputClass} type="search" value={filters.search || ''} onChange={event => changeFilters({ search: event.target.value })} /></label>
    </div>
    <div className="flex flex-wrap items-center gap-3"><label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={Boolean(filters.conflictsOnly)} onChange={event => changeFilters({ conflictsOnly: event.target.checked })} />Show conflicts only</label><Button variant="ghost" size="sm" onClick={() => changeFilters({ grade: 'all', classId: 'all', teacher: 'all', search: '', conflictsOnly: false })}>Clear display filters</Button><p className="text-xs text-muted-foreground">Display filters do not change the {activeCount} classes included in this profile.</p></div>
    <p aria-label="Whole profile summary" className="text-sm">{activeCount} classes included · {definition.classRules.filter(rule => rule.action === 'time').length} custom-time rules · {definition.classRules.filter(rule => rule.action === 'skip').length} skipped-class rules · {definition.testingBlocks.length} testing blocks</p>
    <PlannerIssues issues={issues} rowsByKey={rowsByKey} onEditTarget={editOccurrence} disabled={disabled} />
    <div className="flex flex-wrap items-center gap-2"><Button variant="outline" size="sm" disabled={disabled || definition.testingBlocks.length >= 30} onClick={onAddGroups}>Add testing groups</Button><Button data-add-testing-block variant="outline" size="sm" disabled={disabled || definition.testingBlocks.length >= 30} onClick={addBlock}><Plus className="mr-2 h-4 w-4" />Add testing block</Button><span className="text-xs text-muted-foreground">{definition.testingBlocks.length}/30 testing blocks</span></div>
    {timeline && <><div aria-label="Timeline legend" className="flex flex-wrap gap-x-5 gap-y-2 text-xs"><span className="flex items-center gap-2"><span aria-hidden="true" className="h-1 w-6 bg-slate-500" />Regular time</span><span className="flex items-center gap-2"><span aria-hidden="true" className="h-3 w-6 rounded bg-blue-500" />Proposed class</span><span className="flex items-center gap-2"><span aria-hidden="true" className="h-3 w-6 rounded bg-amber-400" />Testing</span><span className="flex items-center gap-2"><span aria-hidden="true" className="h-3 w-6 rounded bg-rose-400" style={striped} />Conflict</span><span>Dashed border: allowed overlap</span></div><p className="text-xs text-muted-foreground sm:hidden">Scroll the timeline sideways, or use List for a stacked view.</p></>}
    {filters.conflictsOnly && !model.reviewCurrent && <p role="status" className="rounded border p-3 text-sm">Conflict results are pending or unavailable. Clear display filters to keep editing the day.</p>}
    <div className="min-w-0 rounded-lg border">
      {timeline && <div ref={timeHeader} data-planner-time-header data-school-hours-source={axis.source} data-axis-start={axis.start} data-axis-end={axis.end} className="sticky z-[15] overflow-hidden rounded-t-lg border-b bg-muted text-xs" style={{ top: 'var(--planner-toolbar-offset, 0px)' }}><div className="grid grid-cols-[260px_minmax(480px,1fr)]" style={{ minWidth: 'var(--planner-grid-width)' }}><div className="sticky left-0 z-10 border-r bg-muted px-3 py-2 font-medium">Class / supervision</div><div className="px-3"><div className="relative h-9">{axis.ticks.map(tick => <span key={tick} data-planner-tick={tick} className="absolute top-2 whitespace-nowrap" style={{ left: `${(tick - axis.start) / (axis.end - axis.start) * 100}%`, transform: tick === axis.end ? 'translateX(-100%)' : tick === axis.start ? 'none' : 'translateX(-50%)' }}>{plannerTime(tick)}</span>)}</div></div></div></div>}
      <div ref={scroller} role="region" aria-label={timeline ? 'Proposed day timeline' : 'Proposed day timetable'} tabIndex={0} onScroll={event => { if (timeHeader.current) timeHeader.current.scrollLeft = event.currentTarget.scrollLeft; }} className={`min-w-0 ${timeline ? 'overflow-x-auto' : ''} ${focusClass}`}>
        <div style={timeline ? { minWidth: 'var(--planner-grid-width)' } : undefined}>
        {groups.flatMap(group => {
          const containsEditor = group.rows.some(occurrence => occurrence.key === editorOccurrence?.key);
          const collapsed = collapsedGrades.includes(group.key) && !containsEditor;
          return [group.label && <button key={`heading:${group.key}`} type="button" data-planner-grade={group.key} className={`sticky left-0 flex max-w-full items-center gap-2 bg-muted px-3 py-1.5 text-left text-sm font-semibold ${focusClass}`} style={timeline ? { width: 'var(--planner-visible-width, 100%)' } : { width: '100%' }} aria-expanded={!collapsed} onClick={() => {
            if (!collapsed && containsEditor) editOccurrence(null);
            onCollapsedGradesChange(collapsed ? collapsedGrades.filter(key => key !== group.key) : [...new Set([...collapsedGrades, group.key])]);
          }}>{collapsed ? <ChevronRight aria-hidden="true" className="h-4 w-4" /> : <ChevronDown aria-hidden="true" className="h-4 w-4" />}{group.label}<span className="font-normal text-muted-foreground">({group.rows.length})</span></button>,
          ...(!collapsed ? group.rows.map(occurrence => <PlannerRow key={occurrence.key} occurrence={occurrence} timeline={timeline} axis={axis} active={occurrence.key === editorOccurrence?.key} filters={filters} definition={definition} catalog={catalog} disabled={disabled} onChange={onChange} onEditTarget={editOccurrence} onEditGroup={onEditGroup} checked={occurrence.row.checked} onPlaceClass={openPlacement} afterTestingPending={review.pending} referenceDate={referenceDate} classes={model.classes} />) : EMPTY)];
        })}
        {!visible.length && <p className="p-4 text-sm text-muted-foreground">{filters.conflictsOnly && !model.reviewCurrent ? 'Current conflict results are not available.' : filters.conflictsOnly ? 'No conflicting schedule rows match these display filters.' : 'No schedule rows match these display filters.'}</p>}
        </div>
      </div>
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
  </section>{placement && <ScheduleClassForTime snapshot={placement} stale={placement.fingerprint !== placementFingerprint} disabled={disabled} onClose={() => setPlacement(null)} onReturnFocus={returnPlacementFocus} onApply={plan => {
    if (disabled || placement.fingerprint !== placementFingerprint) return;
    onChange(plan.definition, undefined, { classId: plan.selectedId });
    setPlacement(null);
  }} />}</section>;
}
