import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Plus, Undo2 } from 'lucide-react';
import { useAuth } from '../../../contexts/AuthContext';
import { apiRequest } from '../../../lib/queryClient';
import { Button } from '../../../components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../../../components/ui/card';
import { AlertDialog, AlertDialogContent, AlertDialogHeader, AlertDialogTitle, AlertDialogDescription, AlertDialogFooter, AlertDialogCancel } from '../../../components/ui/alert-dialog';
import ScheduleTestingGroupPicker from './ScheduleTestingGroupPicker';
import ScheduleDayPlanner from './ScheduleDayPlanner';
import ScheduleAfterTesting from './ScheduleAfterTesting';
import ScheduleProfilesOverview from './ScheduleProfilesOverview';
import { cancellationState, historyRemovalState, scheduleDateText, useScheduleOverviewClock } from './useScheduleOverviewClock';
import { useScheduleProfileDraftReview } from './useScheduleProfileDraftReview';
import { testingGroupDraft } from '../lib/testingSchedulePrefill';

const API = '/classpilot/admin/schedule-profiles';
const KEY = ['classpilot-schedule-profiles'];
const EMPTY = [];
const inputClass = 'min-w-0 w-full rounded-md border bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2';
const weekdays = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const copy = value => structuredClone(value);
// scheduleDateText omits the weekday and is used throughout; this is a sibling,
// because "already set for Friday" is what an administrator actually recognises.
const weekdayDateText = date => (date ? `${weekdays[new Date(`${date}T12:00:00Z`).getUTCDay()]}, ${scheduleDateText(date)}` : 'Date unavailable');
const errorMessage = error => error?.response?.data?.error || error?.message || 'The schedule profile action failed.';
const timeText = value => !value || value.action === 'skip' || value.meets === false ? 'Does not meet' : typeof value === 'string' ? value : `${value.startTime || '—'}–${value.endTime || '—'}`;
const blankDefinition = () => ({ name: '', grades: [], classIds: [], classRules: [], testingBlocks: [] });
const copyName = (name, suffix) => `${name.slice(0, 80 - suffix.length)}${suffix}`;
const testingStatusReasons = {
  COVERAGE_GROUP_UNAVAILABLE: 'The Supervision group is unavailable.',
  STAFF_MEMBERSHIP_UNAVAILABLE: 'The assigned staff member is unavailable.',
  STAFF_GROUP_PAIRING_CHANGED: 'The staff assignment to this group changed.',
  COVERAGE_ROSTER_CHANGED: 'The Supervision group roster changed.',
  STUDENT_SCOPE_CHANGED: 'A student is no longer available in this scope.',
  SUPERVISION_ALREADY_CLAIMED: 'Another session already supervises these students.',
  TESTING_ROSTER_INVALID: 'The testing roster needs review.',
  WINDOW_ELAPSED: 'The testing window elapsed before it could start.',
  CLASSPILOT_NOT_ENTITLED: "ClassPilot access is unavailable for this school. Check the school's license.",
  NON_INSTRUCTIONAL_DATE: 'This is a non-instructional date. Review the school calendar before scheduling testing.',
  MONITORING_NOT_FULL: 'Full classroom monitoring is unavailable. Review Monitoring Hours for this testing time.',
  SCHEDULE_PROFILE_MONITORING_NOT_FULL: 'Full classroom monitoring is not available for the entire testing block. Review Monitoring Hours.',
  SCHEDULE_PROFILE_PROCTOR_CLASS_CONFLICT: 'The assigned staff member has an overlapping class. Review that class or choose another proctor.',
  SCHEDULE_PROFILE_FROZEN_ROSTER_UNAVAILABLE: 'A class session has an incomplete saved roster. Resolve that session before assigning its teacher to testing.',
  SCHEDULE_PROFILE_CLASS_WINDOW_UNAVAILABLE: 'A related class has an unresolved schedule. Review its period, calendar mapping or approved schedule change.',
  SCHEDULE_PROFILE_VALIDATION_LIMIT: 'The testing selection is too large to validate. Narrow the selection before scheduling another application.',
  ACTIVATION_FAILED: 'Testing supervision could not start. Review the schedule and Supervision setup.',
};
function applicationStatus(application, today) {
  if (application.status === 'cancelled') return 'Cancelled';
  if (today && application.dates.every(date => date < today)) return 'Past date';
  return application.dates.includes(today) ? 'Applied today' : 'Scheduled';
}

function dateRange(start, end) {
  const from = new Date(`${start}T00:00:00Z`), to = new Date(`${end}T00:00:00Z`);
  if (!start || !end || !Number.isFinite(from.getTime()) || !Number.isFinite(to.getTime()) || from.toISOString().slice(0, 10) !== start || to.toISOString().slice(0, 10) !== end || to < from) throw new Error('Choose a valid start and end date.');
  const count = (to.getTime() - from.getTime()) / 86_400_000 + 1;
  if (count > 31) throw new Error('Choose no more than 31 dates per application.');
  return Array.from({ length: count }, (_, index) => new Date(from.getTime() + index * 86_400_000).toISOString().slice(0, 10));
}

function validateDefinition(definition) {
  if (!definition.name.trim()) return 'Enter a profile name.';
  if (!definition.grades.length && !definition.classIds.length && !definition.testingBlocks.length) return 'Choose at least one grade, class or testing block.';
  if (definition.classIds.length > 500 || definition.classRules.length > 500) return 'Choose no more than 500 individual classes or class adjustments.';
  for (const rule of definition.classRules) {
    if (rule.action === 'time' && (!rule.startTime || !rule.endTime || rule.startTime >= rule.endTime)) return 'Each custom class time needs an end after its start.';
  }
  for (const block of definition.testingBlocks) {
    if (!block.name.trim() || !block.coverageGroupId || !block.assignedStaffId) return 'Each testing block needs a name, Supervision group and assigned staff member.';
    if (!block.startTime || !block.endTime || block.startTime >= block.endTime) return 'Each testing block needs an end after its start.';
  }
  return null;
}

function isReferenceDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T12:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function RegularScheduleReference({ date, onDateChange, onRefresh, query, schedule, timezone, setup, hideControls = false }) {
  const validDate = isReferenceDate(date);
  return <section aria-label="Regular schedule reference" className="space-y-3 rounded-lg border bg-muted/30 p-4">
    <div className="space-y-1"><h4 className="font-semibold">{setup ? 'Start from regular schedule' : 'Compare with the regular schedule'}</h4><p className="max-w-2xl text-sm text-muted-foreground">Use a preview day to build this profile. Choose application dates separately after saving.</p></div>
    <div className="flex flex-wrap items-end gap-3">{!hideControls && <label className="w-full space-y-1 text-sm font-medium sm:w-56"><span>Preview schedule for</span><input type="date" className={inputClass} value={date} onChange={event => onDateChange(event.target.value)} /></label>}<Button variant="outline" size="sm" disabled={!validDate || query.isFetching} onClick={onRefresh}>{query.isError ? 'Retry regular schedule' : 'Refresh regular schedule'}</Button></div>
    {!validDate && <p className="text-sm text-muted-foreground">Choose a valid preview date to see regular class times.</p>}
    {validDate && query.isFetching && <p role="status" className="text-sm">Loading regular schedule…</p>}
    {validDate && query.isError && !query.isFetching && <p role="alert" className="text-sm text-destructive">Could not load the regular schedule. {errorMessage(query.error)}</p>}
    {schedule && <div className="space-y-2 text-sm">
      <p className="font-medium">{weekdays[new Date(`${date}T12:00:00Z`).getUTCDay()]}{schedule.day.cycleDay ? ` · ${schedule.day.cycleDay} day` : ''} · {schedule.day.bellProfile?.name || 'Class times'} · {schedule.schoolTimezone || timezone}</p>
      {schedule.day.overridden && <p className="text-muted-foreground">This date has a calendar exception{schedule.day.meetingWeekday !== new Date(`${date}T12:00:00Z`).getUTCDay() ? ` and follows ${weekdays[schedule.day.meetingWeekday]}'s classes` : ''}. The comparison includes its meeting rules and bells.</p>}
      {!schedule.day.instructional ? <p role="status">This is a non-instructional day. Choose an instructional preview date to load classes.</p> : !schedule.classes.some(row => row.status === 'meets') && <p role="status">No scheduled classes meet on this preview date. Choose another date or start blank to add testing blocks.</p>}
    </div>}
    <p className="max-w-2xl text-xs leading-relaxed text-muted-foreground">Regular times use the current school calendar and class settings. Applied profiles, swaps and recorded sessions are excluded. Changing this preview date keeps your selections and adjustments.</p>
  </section>;
}

function Preview({ preview, catalog, acknowledged, onAcknowledge }) {
  const [page, setPage] = useState(0);
  const changes = preview.changes || EMPTY;
  const count = typeof preview.affectedClasses === 'number' ? preview.affectedClasses : preview.affectedClasses?.length ?? new Set(changes.map(row => row.classId)).size;
  return <section aria-label="Profile application preview" tabIndex={-1} className="space-y-3 rounded-lg border p-4">
    <h4 className="font-semibold">Review this application</h4><p className="text-sm text-muted-foreground">{count} affected classes · Times use {preview.schoolTimezone || catalog.schoolTimezone}.</p>
    {(preview.blockers || EMPTY).map((blocker, index) => <p key={index} role="alert" className="text-sm text-destructive">{blocker.date ? `${blocker.date}: ` : ''}{blocker.message}</p>)}
    {(preview.warnings || EMPTY).length > 0 && <section aria-label="Custom schedules already applied" className="space-y-2 rounded-md border border-amber-300 bg-amber-50/60 p-3 dark:border-amber-900 dark:bg-amber-950/20">
      <h5 className="text-sm font-semibold">Custom schedules are already applied to these dates</h5>
      <ul className="max-h-40 list-inside list-disc overflow-y-auto text-sm">{preview.warnings.map(warning => <li key={`${warning.applicationId}:${warning.date}`}>
        <strong>{weekdayDateText(warning.date)}</strong> — {warning.profileName}{warning.testingBlockNames?.length ? ` · ${warning.testingBlockNames.join(', ')}` : ''}
      </li>)}</ul>
      <p className="text-xs text-muted-foreground">Applying this profile does not replace them. Both stay scheduled unless they share a staff member or student at overlapping times.</p>
      <label className="flex items-start gap-2 text-sm"><input type="checkbox" className="mt-1" checked={acknowledged} onChange={event => onAcknowledge(event.target.checked)} aria-label="I have reviewed the custom schedules already applied to these dates" /><span>I have reviewed these and still want to apply this profile.</span></label>
    </section>}
    {changes.length > 0 ? <><div className="overflow-x-auto"><table className="w-full text-left text-sm"><thead><tr><th className="p-2">Date / class</th><th className="p-2">Before</th><th className="p-2">After</th></tr></thead><tbody>{changes.slice(page * 50, (page + 1) * 50).map((change, index) => <tr className="border-t" key={`${change.date}-${change.classId}-${index}`}><td className="p-2">{change.date}<span className="block font-medium">{change.className}</span></td><td className="p-2">{timeText(change.before)}</td><td className="p-2">{timeText(change.after)}</td></tr>)}</tbody></table></div>{changes.length > 50 && <div className="flex items-center gap-3"><Button size="sm" variant="outline" disabled={!page} onClick={() => setPage(value => value - 1)}>Previous changes</Button><span className="text-xs">{page * 50 + 1}–{Math.min(changes.length, (page + 1) * 50)} of {changes.length}</span><Button size="sm" variant="outline" disabled={(page + 1) * 50 >= changes.length} onClick={() => setPage(value => value + 1)}>Next changes</Button></div>}</> : <p className="text-sm">No ordinary class times change.</p>}
    {preview.classResults?.length > 0 && <section aria-label="Class rules on each application date" className="max-h-64 space-y-2 overflow-y-auto"><h5 className="text-sm font-semibold">Class rules on each date</h5>{preview.classResults.map(result => <div key={`${result.date}:${result.classId}`} data-application-class-result={`${result.date}:${result.classId}`} className="rounded border p-2 text-sm"><p>{result.date} · {result.className}</p><p>{result.status === 'time' ? `Custom time: ${result.startTime}–${result.endTime}` : result.status === 'skipped' ? 'Does not meet — skipped by this profile' : result.status === 'does_not_meet' ? 'Does not meet on this date — this class rule is not used' : 'Schedule unavailable — review this class before applying'}</p>{result.reason && <p className="text-xs text-muted-foreground">{result.reason}</p>}</div>)}</section>}
    {(preview.testingWindows || EMPTY).length > 0 && <div className="max-h-96 space-y-3 overflow-auto"><h5 className="text-sm font-semibold">Testing windows</h5>{preview.testingWindows.map((window, index) => <div key={`${window.date}-${window.blockId}-${index}`} className="space-y-2 rounded bg-muted p-2 text-sm"><p>{window.date} · {window.name} · {window.startTime}–{window.endTime}<span className="block text-xs text-muted-foreground">{catalog.staff?.find(person => person.id === window.assignedStaffId)?.name || 'Assigned staff'} · {window.studentIds?.length ?? window.afterTesting?.studentCount ?? 'Unknown'} students</span></p><ScheduleAfterTesting data={window.afterTesting} name={window.name} date={window.date} classes={catalog.classes} testingBlocks={preview.testingWindows.filter(block => block.date === window.date)} /></div>)}</div>}
  </section>;
}

export default function ScheduleProfiles(props) {
  const { activeSchoolId, user } = useAuth();
  return <SchoolScheduleProfiles key={`${activeSchoolId}:${user?.id}`} {...props} />;
}

function SchoolScheduleProfiles({ blockedByAdvancedDraft = false, onBusyChange, onWorkspaceChange, testingPrefill, onDismissTestingPrefill }) {
  const client = useQueryClient();
  const { activeSchoolId, user } = useAuth();
  const query = useQuery({ queryKey: [...KEY, activeSchoolId], queryFn: async ({ signal }) => { const overviewRequestStartedAt = performance.now(); const result = await apiRequest('GET', API, undefined, { signal, headers: { 'X-School-Id': activeSchoolId } }); return { ...result, overviewRequestStartedAt, overviewReceivedAt: performance.now() }; }, refetchInterval: current => current.state.data?.testingStatuses?.some(row => ['pending', 'active', 'releasing'].includes(row.status)) ? 30_000 : false });
  const [session, setSession] = useState(null);
  const hoursQuery = useQuery({
    queryKey: ['/api/settings', 'day-planner-hours', activeSchoolId, user?.id],
    queryFn: async ({ signal }) => {
      const settings = await apiRequest('GET', '/settings', undefined, { signal, headers: { 'X-School-Id': activeSchoolId } });
      return { enableTrackingHours: settings.enableTrackingHours, trackingStartTime: settings.trackingStartTime, trackingEndTime: settings.trackingEndTime };
    },
    enabled: Boolean(session),
    retry: false,
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
  });
  const currentSessionId = useRef(null);
  useEffect(() => { currentSessionId.current = session?.id; }, [session?.id]);
  const [testingPicker, setTestingPicker] = useState(false);
  const [plannerView, setPlannerView] = useState(() => window.matchMedia('(max-width: 639px)').matches ? 'list' : 'timeline');
  const editGroup = useRef(null);
  const listScroll = useRef(0);
  const listHeading = useRef(null);
  const applicationsHeading = useRef(null);
  const historyOpener = useRef(null);
  const [removingHistory, setRemovingHistory] = useState(null);
  const [historyError, setHistoryError] = useState('');
  const [historyStale, setHistoryStale] = useState(false);
  const [deleting, setDeleting] = useState(null);
  const [cancelling, setCancelling] = useState(null);
  const [cancelError, setCancelError] = useState('');
  const [cancelStale, setCancelStale] = useState(false);
  const cancelOpener = useRef(null);
  const [cancellingBlock, setCancellingBlock] = useState(null);
  const [cancelBlockError, setCancelBlockError] = useState('');
  const cancelBlockOpener = useRef(null);
  const [deleteError, setDeleteError] = useState('');
  const [deleteStale, setDeleteStale] = useState(false);
  const [deleteRefreshFailed, setDeleteRefreshFailed] = useState(false);
  const [committedRefreshNotice, setCommittedRefreshNotice] = useState(null);
  const deleteOpener = useRef(null);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [preview, setPreview] = useState(null);
  const [acknowledgedToken, setAcknowledgedToken] = useState('');
  const existingApplicationsAcknowledged = Boolean(preview?.previewToken) && acknowledgedToken === preview.previewToken;
  const existingApplicationsPending = (preview?.warnings || EMPTY).length > 0 && !existingApplicationsAcknowledged;
  const [oneDate, setOneDate] = useState('');
  const [rangeStart, setRangeStart] = useState('');
  const [rangeEnd, setRangeEnd] = useState('');
  const [newName, setNewName] = useState('');
  const bodyRef = useRef(null);
  const workspaceRef = useRef(null);
  const previewDateRef = useRef(null);
  const openerRef = useRef(null);
  const handledFocus = useRef(null);
  const data = query.data;
  const { serverNow, latestServerNow, dateStale } = useScheduleOverviewClock({ data, onRefresh: query.refetch });
  const statusUnavailable = Boolean(query.error || dateStale);
  const cancelAvailability = cancelling ? cancellationState(cancelling.application, data?.applicationSummaries?.[cancelling.application.id], serverNow, statusUnavailable, latestServerNow) : null;
  const cancellationChanged = Boolean(cancelling && (cancelStale || cancelling.revision !== data?.revision));
  const blockCancellationChanged = Boolean(cancellingBlock && cancellingBlock.revision !== data?.revision);
  const historyAvailability = removingHistory ? historyRemovalState(removingHistory.application, data?.applicationSummaries?.[removingHistory.application.id], statusUnavailable) : null;
  const historyChanged = Boolean(removingHistory && (historyStale || removingHistory.revision !== data?.revision || !data?.applications.some(application => application.id === removingHistory.application.id && !application.historyHiddenAt)));
  const showEditor = Boolean(session && (session.mode === 'edit' || session.customize));
  const workspaceOpen = Boolean(session);
  useEffect(() => { onWorkspaceChange?.(workspaceOpen); }, [workspaceOpen, onWorkspaceChange]);
  useEffect(() => () => { onWorkspaceChange?.(false); onBusyChange?.(false); }, [onWorkspaceChange, onBusyChange]);
  const sessionId = session?.id, sessionMode = session?.mode, sessionSetup = session?.setup, focusTarget = session?.focusTarget;
  const referenceDate = session?.referenceDate || '';
  const previewDateDirty = Boolean(session && session.mode !== 'apply' && referenceDate !== session.initialPreviewDate);
  const regularQuery = useQuery({
    queryKey: [...KEY, 'regular-schedule', activeSchoolId, referenceDate],
    queryFn: ({ signal }) => apiRequest('GET', `${API}/regular-schedule`, undefined, { signal, headers: { 'X-School-Id': activeSchoolId }, params: { referenceDate } }),
    enabled: Boolean(session) && isReferenceDate(referenceDate),
    retry: false,
  });
  // A date change or refresh must not seed an adjustment from older comparison data.
  const regularSchedule = !regularQuery.isFetching && !regularQuery.isError && regularQuery.data?.referenceDate === referenceDate ? regularQuery.data : null;
  const draftReview = useScheduleProfileDraftReview({ enabled: Boolean(session && !session.setup && isReferenceDate(referenceDate)), schoolId: activeSchoolId, sessionId: session?.id, referenceDate, definition: session?.definition, revision: data?.revision });
  const refreshReference = () => { void regularQuery.refetch(); draftReview.retry(); };
  const meetingClasses = regularSchedule?.classes.filter(row => row.status === 'meets') || EMPTY;
  const unavailableClasses = regularSchedule?.classes.filter(row => row.status === 'unavailable') || EMPTY;
  const catalogIds = new Set((data?.classes || EMPTY).map(row => row.id));
  const loadProblem = unavailableClasses.length ? 'Some regular times are unavailable. Resolve their class times or period mappings, or choose Start blank to select only classes with available times.'
    : meetingClasses.length > 500 ? 'This day has more than 500 classes. Choose Start blank and select a smaller set of grades or classes.'
      : meetingClasses.some(row => !catalogIds.has(row.classId)) ? 'The class list changed. Close this draft and refresh profiles before loading the whole day.' : '';
  const testingStatuses = useMemo(() => {
    const statuses = new Map();
    for (const row of data?.testingStatuses || EMPTY) { const key = `${row.applicationId}:${row.date}:${row.blockId}`; statuses.set(key, statuses.has(key) ? null : row); }
    return statuses;
  }, [data?.testingStatuses]);
  const definitionDirty = Boolean(session && JSON.stringify(session.definition) !== session.original);
  const reusableDirty = Boolean(session && session.mode !== 'apply' && (definitionDirty || previewDateDirty));
  const dirty = reusableDirty || Boolean(session?.mode === 'apply' && (session.customize || session.dates.join(',') !== session.initialDates || preview));
  useEffect(() => { onBusyChange?.(busy || dirty); }, [busy, dirty, onBusyChange]);
  useEffect(() => {
    if (!sessionId || !bodyRef.current || busy || !focusTarget || handledFocus.current === focusTarget) return;
    if (focusTarget?.previewDate) {
      previewDateRef.current?.focus({ preventScroll: true });
    } else if (focusTarget?.applicationPreview) {
      const element = bodyRef.current.querySelector('[aria-label="Profile application preview"]');
      element?.focus(); element?.scrollIntoView({ block: 'start' });
    } else if (focusTarget.classId || focusTarget.blockId) {
      const selector = focusTarget.classId ? '[data-class-editor-id]' : '[data-block-editor-id]';
      const row = [...bodyRef.current.querySelectorAll(selector)].find(element => element.getAttribute(focusTarget.classId ? 'data-class-editor-id' : 'data-block-editor-id') === (focusTarget.classId || focusTarget.blockId));
      const control = focusTarget.classId ? row?.querySelector('select:not(:disabled)') || row?.querySelector('input:not(:disabled)') : row?.querySelector('input:not(:disabled), select:not(:disabled)');
      (control || row)?.focus();
      (control || row)?.scrollIntoView({ block: 'center', inline: 'nearest' });
    } else if (focusTarget.heading) {
      const workspace = workspaceRef.current;
      (workspace?.querySelector('[data-planner-heading]') || workspace?.querySelector('input:not(:disabled)'))?.focus({ preventScroll: true });
    }
    handledFocus.current = focusTarget;
  }, [sessionId, sessionMode, sessionSetup, focusTarget, busy]);
  useEffect(() => {
    if (!dirty) return undefined;
    const handler = event => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [dirty]);
  const refresh = async (scheduleChanged = false) => {
    await Promise.all([client.invalidateQueries({ queryKey: KEY }, { throwOnError: true }), ...(scheduleChanged ? [client.invalidateQueries({ queryKey: ['classpilot-school-scheduling'] }, { throwOnError: true }), client.invalidateQueries({ queryKey: ['classpilot-admin-classes'] }, { throwOnError: true })] : [])]);
  };
  const open = (mode, profile, duplicate = false, prefill = null) => {
    if (prefill && (session || blockedByAdvancedDraft)) return;
    openerRef.current = document.activeElement;
    listScroll.current = window.scrollY;
    return execute(async () => {
      // Fetch on open so another administrator's saved date and revision are used.
      const { data: catalog } = await query.refetch({ throwOnError: true });
      if (!mounted.current) return;
      const latestProfile = profile ? catalog.profiles.find(row => row.id === profile.id) : null;
      if (profile && !latestProfile) throw new Error('This profile is no longer available. Refresh the profile list.');
      const definition = prefill ? testingGroupDraft(catalog, prefill.groupId) : latestProfile ? copy(latestProfile.definition) : blankDefinition();
      if (duplicate) definition.name = copyName(definition.name, ' (copy)');
      const dates = mode === 'apply' && catalog.schoolLocalToday ? [catalog.schoolLocalToday] : [];
      const previewDate = latestProfile?.previewDate || catalog.schoolLocalToday;
      editGroup.current = null;
      const target = prefill ? { blockId: definition.testingBlocks[0].id } : null;
      setSession({ id: crypto.randomUUID(), mode, profile: duplicate ? null : latestProfile, definition, original: JSON.stringify(prefill ? blankDefinition() : definition), revision: catalog.revision, dates, initialDates: dates.join(','), customize: false, setup: mode === 'edit' && !latestProfile && !prefill, referenceDate: previewDate, initialPreviewDate: previewDate, plannerFilters: { view: 'school', grade: 'all', classId: 'all', teacher: 'all', search: '', conflictsOnly: false }, collapsedGrades: [], activeTarget: target, focusTarget: target || { heading: true }, undo: [] });
      setNewName(copyName(definition.name, ' (custom)')); setOneDate(''); setRangeStart(''); setRangeEnd(''); setPreview(null); setError(''); setNotice('');
      if (prefill) onDismissTestingPrefill?.();
    });
  };
  const close = () => {
    if (busy || (dirty && !window.confirm('Discard these unsaved profile or application changes?'))) return;
    setSession(null); setTestingPicker(false); setPreview(null); setError(''); editGroup.current = null;
    requestAnimationFrame(() => {
      window.scrollTo({ top: listScroll.current });
      // A saved rename can move the opener in the alphabetical profile list.
      (openerRef.current?.isConnected ? openerRef.current : listHeading.current)?.focus();
    });
  };
  const edit = (change, editKey) => {
    const coalesce = Boolean(editKey && editGroup.current === editKey);
    editGroup.current = editKey || null;
    setSession(current => {
      if (!current) return current;
      const next = { ...current, ...change, savedNotice: false };
      if (change.definition && current.mode === 'apply' && !current.customize && change.customize === undefined) {
        next.customize = true;
        next.referenceDate = current.dates[0] || data.schoolLocalToday;
      }
      const changed = JSON.stringify(next.definition) !== JSON.stringify(current.definition) || next.referenceDate !== current.referenceDate || next.customize !== current.customize;
      if (changed) {
        const snapshot = { definition: copy(current.definition), referenceDate: current.referenceDate, setup: current.setup, customize: current.customize, activeTarget: current.activeTarget };
        next.undo = coalesce ? current.undo : [...current.undo, snapshot];
        if (change.definition && current.mode === 'view') next.mode = 'edit';
      }
      if (next.activeTarget?.blockId && !next.definition.testingBlocks.some(block => block.id === next.activeTarget.blockId)) next.activeTarget = null;
      return next;
    });
    if (change.definition || change.dates || change.customize !== undefined) setPreview(null);
    setError(''); setNotice('');
  };
  const undo = () => {
    if (!session?.undo.length || busy) return;
    editGroup.current = null;
    setSession(current => { const previous = current.undo.at(-1); return { ...current, ...previous, undo: current.undo.slice(0, -1), savedNotice: false, focusTarget: null }; });
    setPreview(null); setError(''); setNotice('Last change undone.');
  };
  const changePreviewDate = value => edit({ referenceDate: value }, 'preview-date');
  const discardPreviewDate = () => {
    editGroup.current = null;
    setSession(current => ({ ...current, referenceDate: current.initialPreviewDate, focusTarget: { previewDate: true }, undo: [] }));
    setError(''); setNotice('');
  };
  const editTarget = (target, issue) => {
    if (blockedByAdvancedDraft || busy) return;
    editGroup.current = null;
    setSession(current => {
      if (!target) return { ...current, activeTarget: null, focusTarget: null };
      let filters = current.plannerFilters, collapsedGrades = current.collapsedGrades;
      if (issue) { filters = { ...filters, view: 'school', grade: 'all', classId: 'all', teacher: 'all', search: '', conflictsOnly: false }; collapsedGrades = []; }
      const startingCustomization = current.mode === 'apply' && !current.customize;
      return { ...current, mode: current.mode === 'view' ? 'edit' : current.mode, customize: current.mode === 'apply' ? true : current.customize,
        ...(startingCustomization ? { referenceDate: current.dates[0] || data.schoolLocalToday } : {}),
        plannerFilters: filters, collapsedGrades, activeTarget: target, focusTarget: { ...target }, setup: false };
    });
    if (target && session?.mode === 'apply' && !session.customize) setPreview(null);
  };
  const editSaved = () => setSession(current => ({ ...current, mode: 'edit', savedNotice: false, focusTarget: null }));
  const discardProfileChanges = () => {
    if (!session?.profile || !window.confirm('Discard these unsaved profile changes?')) return;
    setSession(current => ({ ...current, mode: 'view', definition: copy(current.profile.definition), referenceDate: current.initialPreviewDate, undo: [], activeTarget: null, focusTarget: null }));
    setPreview(null); setError(''); editGroup.current = null;
  };
  const chooseDates = () => {
    if (reusableDirty || !session.profile) return;
    const dates = session.dates.length ? session.dates : data.schoolLocalToday ? [data.schoolLocalToday] : [];
    setSession(current => ({ ...current, mode: 'apply', dates, initialDates: dates.join(','), customize: false, focusTarget: null, savedNotice: false, undo: [], activeTarget: null }));
    setOneDate(''); setRangeStart(''); setRangeEnd(''); setPreview(null); setError('');
  };
  const loadRegularSchedule = () => {
    if (!regularSchedule || loadProblem || !meetingClasses.length) return;
    edit({ setup: false, definition: { ...session.definition, grades: [], classIds: meetingClasses.map(row => row.classId), classRules: [] } });
  };
  const execute = async operation => {
    if (busyRef.current) return;
    busyRef.current = true; setBusy(true); setError('');
    try { await operation(); }
    catch (failure) {
      if (mounted.current) {
        setError(errorMessage(failure));
        if (failure?.response?.status === 409) {
          setPreview(null);
          try { await refresh(true); }
          catch { if (mounted.current) setError(`${errorMessage(failure)} The profile list could not refresh. Close the workspace and retry the read before making another change.`); }
        }
      }
    } finally { busyRef.current = false; if (mounted.current) setBusy(false); }
  };
  const saveProfile = (asNew = false, dateOnly = false) => execute(async () => {
    const savingSessionId = session.id;
    const isCurrent = () => mounted.current && currentSessionId.current === savingSessionId;
    if (dateOnly) setSession(current => ({ ...current, focusTarget: { previewDate: true } }));
    if (!isReferenceDate(referenceDate)) throw new Error('Choose a valid preview date before saving.');
    const definition = { ...session.definition, name: (asNew ? newName : session.definition.name).trim() };
    const problem = validateDefinition(definition); if (problem) throw new Error(problem);
    const result = await apiRequest('POST', API, { revision: session.revision, ...(!asNew && session.profile ? { id: session.profile.id, profileRevision: session.profile.revision } : {}), definition, previewDate: referenceDate }, { headers: { 'X-School-Id': activeSchoolId } });
    if (!isCurrent()) return;
    // The save result is the exact normalized version to review, even if catalog refresh fails.
    client.setQueryData([...KEY, activeSchoolId], current => current ? { ...current, revision: result.revision, profiles: [...current.profiles.filter(profile => profile.id !== result.profile.id), result.profile] } : current);
    editGroup.current = null;
    setSession(current => ({ ...current, mode: 'view', profile: copy(result.profile), definition: copy(result.profile.definition), original: JSON.stringify(result.profile.definition), revision: result.revision,
      referenceDate: result.profile.previewDate || data.schoolLocalToday, initialPreviewDate: result.profile.previewDate || data.schoolLocalToday,
      customize: false, setup: false, savedNotice: true, focusTarget: dateOnly ? { previewDate: true } : { heading: true }, undo: [], activeTarget: dateOnly ? current.activeTarget : null }));
    setPreview(null);
    setNotice(dateOnly ? 'Preview date saved for everyone using this profile. Application dates are unchanged.' : 'Profile and preview date saved. Existing applications keep their saved settings.');
    try { await refresh(true); } catch { setNotice('Profile saved. The profile list could not refresh; reopen it before making another change.'); }
  });
  const addDates = values => {
    const dates = [...new Set([...session.dates, ...values])].sort();
    if (dates.length > 31) { setError('Choose no more than 31 dates per application.'); return; }
    edit({ dates }); setOneDate(''); setRangeStart(''); setRangeEnd('');
  };
  const review = () => execute(async () => {
    if (!session.dates.length) throw new Error('Choose at least one date to preview.');
    const problem = validateDefinition(session.definition); if (problem) throw new Error(problem);
    const payload = { revision: session.revision, profileId: session.profile.id, profileRevision: session.profile.revision, dates: session.dates, ...(session.customize ? { definition: session.definition } : {}) };
    const originId = session.id;
    const result = await apiRequest('POST', `${API}/preview`, payload, { headers: { 'X-School-Id': activeSchoolId } });
    if (!mounted.current || currentSessionId.current !== originId) return;
    setPreview({ ...result, payload });
    setSession(current => ({ ...current, focusTarget: { applicationPreview: true } }));
  });
  const apply = () => execute(async () => {
    const result = await apiRequest('POST', `${API}/apply`, { ...preview.payload, previewToken: preview.previewToken,
      ...((preview.warnings || EMPTY).length > 0 ? { acknowledgeExistingApplications: true } : {}) }, { headers: { 'X-School-Id': activeSchoolId } });
    if (!mounted.current) return;
    client.setQueryData([...KEY, activeSchoolId], current => current ? { ...current, revision: result.revision, applications: [...current.applications.filter(application => application.id !== result.application.id), result.application] } : current);
    setSession(null); setPreview(null); setNotice('Schedule profile applied to the reviewed dates.');
    setCommittedRefreshNotice(null);
    requestAnimationFrame(() => listHeading.current?.focus());
    try { await refresh(true); }
    catch { if (mounted.current) { setNotice('Schedule applied; list refresh unavailable.'); setCommittedRefreshNotice('Schedule profile applied to the reviewed dates.'); } }
  });
  const requestCancel = (application, opener) => {
    if (busyRef.current || blockedByAdvancedDraft || !cancellationState(application, data.applicationSummaries?.[application.id], serverNow, statusUnavailable, latestServerNow).canRequest) return;
    cancelOpener.current = opener;
    setCancelError(''); setCancelStale(false);
    setCancelling({ application: copy(application), revision: data.revision, schoolId: activeSchoolId, actorId: user.id });
  };
  const cancelApplication = () => execute(async () => {
    const captured = cancelling;
    if (!captured || captured.schoolId !== activeSchoolId || captured.actorId !== user.id || cancellationChanged || !cancelAvailability?.canRequest || blockedByAdvancedDraft) return;
    let result;
    try {
      result = await apiRequest('POST', `${API}/applications/${encodeURIComponent(captured.application.id)}/cancel`, { revision: captured.revision }, { headers: { 'X-School-Id': captured.schoolId } });
    } catch (failure) {
      if (!mounted.current) return;
      setCancelError(errorMessage(failure));
      if (failure?.response?.status === 409) {
        setCancelStale(true); setPreview(null);
        try { await refresh(true); } catch { if (mounted.current) setCancelError(`${errorMessage(failure)} Status could not refresh. Close this confirmation and retry the read.`); }
      }
      return;
    }
    if (!mounted.current) return;
    client.setQueryData([...KEY, activeSchoolId], current => current ? { ...current, revision: result.revision,
      applications: current.applications.map(row => row.id === captured.application.id ? { ...row, status: 'cancelled' } : row),
      // Cancellation may still be releasing contexts. Discard the old summary until reread.
      applicationSummaries: Object.fromEntries(Object.entries(current.applicationSummaries || {}).filter(([id]) => id !== captured.application.id)),
    } : current);
    setCancelling(null); setPreview(null);
    setNotice('Schedule application cancelled.'); setCommittedRefreshNotice(null);
    try { await refresh(true); }
    catch { if (mounted.current) { setNotice('Schedule application cancelled; list refresh unavailable.'); setCommittedRefreshNotice('Schedule application cancelled.'); } }
  });
  const requestCancelBlock = (application, date, window, opener) => {
    if (busyRef.current || blockedByAdvancedDraft || application.status === 'cancelled') return;
    cancelBlockOpener.current = opener;
    setCancelBlockError('');
    setCancellingBlock({ application: copy(application), date, window: copy(window),
      revision: data.revision, schoolId: activeSchoolId, actorId: user.id });
  };
  const cancelTestingBlock = () => execute(async () => {
    const captured = cancellingBlock;
    if (!captured || captured.schoolId !== activeSchoolId || captured.actorId !== user.id
      || blockCancellationChanged || blockedByAdvancedDraft) return;
    let result;
    try {
      result = await apiRequest('POST', `${API}/applications/${encodeURIComponent(captured.application.id)}`
        + `/dates/${encodeURIComponent(captured.date)}/blocks/${encodeURIComponent(captured.window.blockId)}/cancel`,
        { revision: captured.revision }, { headers: { 'X-School-Id': captured.schoolId } });
    } catch (failure) {
      if (!mounted.current) return;
      setCancelBlockError(errorMessage(failure));
      if (failure?.response?.status === 409) {
        try { await refresh(true); }
        catch { if (mounted.current) setCancelBlockError(`${errorMessage(failure)} Status could not refresh. Close this confirmation and retry the read.`); }
      }
      return;
    }
    if (!mounted.current) return;
    // The release and the hand-back to the regular class settle server-side, so
    // drop this application's summary rather than predicting its new statuses.
    client.setQueryData([...KEY, activeSchoolId], current => current ? { ...current, revision: result.revision,
      applicationSummaries: Object.fromEntries(Object.entries(current.applicationSummaries || {}).filter(([id]) => id !== captured.application.id)),
    } : current);
    setCancellingBlock(null);
    setNotice('Testing block cancelled. Students follow their regular schedule for that time.');
    setCommittedRefreshNotice(null);
    try { await refresh(true); }
    catch { if (mounted.current) { setNotice('Testing block cancelled; list refresh unavailable.'); setCommittedRefreshNotice('Testing block cancelled.'); } }
  });
  const seedGroupMetadata = groups => {
    const byId = new Map(groups.map(group => [group.id, group]));
    const people = new Map(groups.flatMap(group => group.staff || []).map(person => [person.id, person]));
    client.setQueryData([...KEY, activeSchoolId], current => current ? {
      ...current,
      supervisionGroups: [...current.supervisionGroups.filter(row => !byId.has(row.id)), ...groups.map(group => ({
        id: group.id, name: group.name, studentCount: group.studentCount,
        staffIds: (group.staff || []).map(person => person.id), inactiveStudents: group.inactiveStudentCount || 0,
      }))],
      staff: [...current.staff.filter(person => !people.has(person.id)), ...[...people.values()].map(person => ({ id: person.id, name: person.displayName || person.email || 'Unavailable staff member' }))],
    } : current);
  };
  const requestDeleteHistory = (application, opener) => {
    if (busyRef.current || blockedByAdvancedDraft || !historyRemovalState(application, data.applicationSummaries?.[application.id], statusUnavailable).canRequest) return;
    historyOpener.current = opener;
    setHistoryError(''); setHistoryStale(false);
    setRemovingHistory({ application: copy(application), revision: data.revision, schoolId: activeSchoolId, actorId: user.id });
  };
  const deleteHistory = () => execute(async () => {
    const origin = removingHistory;
    if (!origin || origin.schoolId !== activeSchoolId || origin.actorId !== user.id || historyChanged || !historyAvailability?.canRequest || blockedByAdvancedDraft) return;
    let result;
    try {
      result = await apiRequest('DELETE', `${API}/applications/${encodeURIComponent(origin.application.id)}/history`, { revision: origin.revision }, { headers: { 'X-School-Id': origin.schoolId } });
    } catch (failure) {
      if (!mounted.current) return;
      const stale = [404, 409].includes(failure?.response?.status);
      setHistoryStale(stale);
      setHistoryError(`${errorMessage(failure)}${stale ? ' Close this confirmation, refresh status, and reopen it before trying again.' : ''}`);
      if (stale) { setPreview(null); await query.refetch().catch(() => undefined); }
      return;
    }
    if (!mounted.current || origin.schoolId !== activeSchoolId || origin.actorId !== user.id) return;
    client.setQueryData([...KEY, origin.schoolId], current => current ? { ...current, revision: result.revision,
      applications: current.applications.map(application => application.id === origin.application.id ? { ...application, historyHiddenAt: result.historyHiddenAt } : application),
    } : current);
    historyOpener.current = null;
    setRemovingHistory(null); setPreview(null);
    setNotice('History entry deleted. Saved profiles, activity reports, and audit records were preserved.'); setCommittedRefreshNotice(null);
    requestAnimationFrame(() => applicationsHeading.current?.focus());
    try { await refresh(true); }
    catch { if (mounted.current) { setNotice('History entry deleted; list refresh unavailable.'); setCommittedRefreshNotice('History entry deleted. Saved profiles, activity reports, and audit records were preserved.'); } }
  });
  const refreshCreatedGroup = async group => {
    const originSessionId = session?.id;
    const isCurrent = () => mounted.current && currentSessionId.current === originSessionId;
    if (!isCurrent()) return false;
    setPreview(null);
    // A successful group save can precede a slow or failed catalog refresh.
    // Seed only its display/pairing metadata; never replace the draft or revisions.
    seedGroupMetadata([group]);
    draftReview.retry();
    try { await query.refetch({ throwOnError: true }); return isCurrent(); }
    catch { return false; }
    finally { if (isCurrent()) draftReview.retry(); }
  };
  const addTestingGroups = () => {
    if (busy || blockedByAdvancedDraft) return;
    setSession(current => ({ ...current, mode: current.mode === 'view' ? 'edit' : current.mode,
      customize: current.mode === 'apply' ? true : current.customize,
      ...(current.mode === 'apply' && !current.customize ? { referenceDate: current.dates[0] || data.schoolLocalToday } : {}) }));
    if (session.mode === 'apply' && !session.customize) setPreview(null);
    setTestingPicker(true);
  };
  const requestDelete = profile => {
    if (busy || blockedByAdvancedDraft) return;
    deleteOpener.current = [...document.querySelectorAll('button[aria-label]')].find(button => button.getAttribute('aria-label') === `More actions for ${profile.definition.name}`);
    setDeleteError(''); setDeleteStale(false);
    setDeleting({ profile: copy(profile), revision: data.revision, schoolId: activeSchoolId, actorId: user.id,
      applications: copy((data.applications || EMPTY).filter(application => application.profileId === profile.id)) });
  };
  const deleteProfile = () => execute(async () => {
    const origin = deleting;
    if (!origin || deleteStale || blockedByAdvancedDraft) return;
    let result;
    try {
      result = await apiRequest('DELETE', `${API}/${encodeURIComponent(origin.profile.id)}`, { revision: origin.revision, profileRevision: origin.profile.revision }, { headers: { 'X-School-Id': origin.schoolId } });
    } catch (failure) {
      if (!mounted.current) return;
      const stale = [404, 409].includes(failure?.response?.status);
      setDeleteStale(stale);
      setDeleteError(`${errorMessage(failure)}${stale ? ' Close this confirmation and refresh profiles before trying again.' : ''}`);
      if (stale) { setPreview(null); await query.refetch().catch(() => undefined); }
      return;
    }
    if (!mounted.current || origin.schoolId !== activeSchoolId || origin.actorId !== user.id) return;
    client.setQueryData([...KEY, origin.schoolId], current => current ? { ...current, revision: result.revision, profiles: current.profiles.filter(profile => profile.id !== origin.profile.id) } : current);
    deleteOpener.current = null;
    setDeleting(null); setPreview(null); setDeleteRefreshFailed(false);
    setNotice('Profile deleted. Applied schedules and history were preserved.');
    requestAnimationFrame(() => listHeading.current?.focus());
    try { await refresh(true); }
    catch { if (mounted.current) { setNotice('Profile deleted; list refresh unavailable.'); setDeleteRefreshFailed(true); } }
  });
  const retryDeletedList = () => execute(async () => {
    try { await refresh(true); if (mounted.current) { setDeleteRefreshFailed(false); setNotice('Profile deleted. Applied schedules and history were preserved.'); } }
    catch { if (mounted.current) setNotice('Profile deleted; list refresh unavailable.'); }
  });
  const retryCommittedList = () => execute(async () => {
    await refresh(true);
    if (mounted.current) { setNotice(committedRefreshNotice); setCommittedRefreshNotice(null); }
  });
  const actions = session && <fieldset disabled={busy} className="flex min-w-0 flex-wrap items-center gap-2">
    <Button variant="outline" onClick={close}><ArrowLeft className="mr-2 h-4 w-4" aria-hidden="true" />Back to scheduling</Button>
    {!session.setup && <Button variant="outline" disabled={blockedByAdvancedDraft || session.definition.testingBlocks.length >= 30} onClick={addTestingGroups}>Add testing groups</Button>}
    <Button variant="outline" disabled={!session.undo.length || blockedByAdvancedDraft} onClick={undo}><Undo2 className="mr-2 h-4 w-4" aria-hidden="true" />Undo last change</Button>
    {session.mode === 'view' && <Button variant="outline" disabled={blockedByAdvancedDraft} onClick={editSaved}>Edit profile</Button>}
    {session.mode === 'edit' && <Button disabled={session.setup || blockedByAdvancedDraft || !isReferenceDate(referenceDate)} onClick={() => saveProfile()}>{busy ? 'Saving…' : 'Save profile'}</Button>}
    {session.mode !== 'apply' && session.profile && <Button disabled={blockedByAdvancedDraft || reusableDirty} onClick={chooseDates}>Choose dates & apply</Button>}
    {session.mode === 'apply' && <><Button variant="outline" disabled={blockedByAdvancedDraft} onClick={review}>{busy ? 'Working…' : 'Preview application'}</Button>{preview && <Button disabled={!preview.previewToken || (preview.blockers || EMPTY).length > 0 || blockedByAdvancedDraft || existingApplicationsPending} onClick={apply}>Apply reviewed dates</Button>}</>}
  </fieldset>;
  return <div data-testid="schedule-profiles">{testingPrefill && <section aria-label="Schedule testing from supervision" className="mb-4 space-y-3 rounded-lg border bg-primary/5 p-4"><p className="text-sm">Create a testing draft for the selected supervision group. Review its staff, times and dates before applying it.</p>{(session || blockedByAdvancedDraft) && <p role="status" className="text-sm">Finish or close your current draft before opening another. Your work is preserved.</p>}<div className="flex gap-2"><Button disabled={!data || busy || blockedByAdvancedDraft || Boolean(session)} onClick={() => open('edit', undefined, false, testingPrefill)}>Open testing draft</Button><Button variant="ghost" disabled={busy} onClick={onDismissTestingPrefill}>Dismiss shortcut</Button></div></section>}<Card hidden={Boolean(session)} inert={Boolean(session) || undefined}><CardHeader><div className="flex flex-wrap items-start justify-between gap-3"><div className="min-w-60 flex-1 space-y-1.5"><CardTitle ref={listHeading} tabIndex={-1} className="text-xl">Schedule profiles</CardTitle><CardDescription>Build a plan for an early release, testing day or delay. Apply it to selected dates while keeping regular class rosters in place.</CardDescription></div><Button disabled={!data || busy || blockedByAdvancedDraft} onClick={() => open('edit')}><Plus className="mr-2 h-4 w-4" />Create Schedule Profile</Button></div></CardHeader><CardContent className="space-y-5">
    <details open={!data?.profiles?.length}><summary className="cursor-pointer text-sm font-medium">How profiles work</summary><ol aria-label="Schedule profile workflow" className="grid gap-4 rounded-md bg-muted/40 p-4 text-sm sm:grid-cols-3">
      <li><p className="font-medium">1. Build, review & save</p><p className="mt-1 text-xs leading-relaxed text-muted-foreground">Edit classes and testing directly in Day planner, then save work in progress.</p></li>
      <li><p className="font-medium">2. Choose dates</p><p className="mt-1 text-xs leading-relaxed text-muted-foreground">Choose dates & apply opens date selection. Customize that use if needed.</p></li>
      <li><p className="font-medium">3. Preview & apply</p><p className="mt-1 text-xs leading-relaxed text-muted-foreground">Review affected classes and resolve conflicts before applying.</p></li>
    </ol></details>
    {query.isLoading && <p role="status" className="text-sm">Loading schedule profiles…</p>}
    {query.error && <div className="space-y-2"><p role="alert" className="text-sm text-destructive">{errorMessage(query.error)}</p><Button variant="outline" size="sm" onClick={() => query.refetch()}>Retry profiles</Button></div>}
    {blockedByAdvancedDraft && <p className="text-sm text-amber-700 dark:text-amber-300">Save or discard the bell, rotation, date-override or calendar draft before changing profiles or their applications.</p>}
    {notice && <p role="status" className="text-sm text-green-700 dark:text-green-400">{notice}</p>}{deleteRefreshFailed && <Button size="sm" variant="outline" disabled={busy} onClick={retryDeletedList}>Retry profile list refresh</Button>}{committedRefreshNotice && <Button size="sm" variant="outline" disabled={busy} onClick={retryCommittedList}>Retry schedule list refresh</Button>}
    {!session && error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    {data && <><p className="text-xs text-muted-foreground">School timezone: {data.schoolTimezone}. Saving a profile does not schedule it.</p>
      <ScheduleProfilesOverview data={data} busy={busy} blocked={blockedByAdvancedDraft} refreshing={query.isFetching} statusUnavailable={statusUnavailable} serverNow={serverNow} latestServerNow={latestServerNow} testingStatuses={testingStatuses} statusReasons={testingStatusReasons} onOpen={open} onDelete={requestDelete} onCancel={requestCancel} onCancelBlock={requestCancelBlock} onDeleteHistory={requestDeleteHistory} onRefresh={query.refetch} applicationsHeadingRef={applicationsHeading} />
    </>}
  </CardContent></Card>
    {session && data && <section ref={workspaceRef} aria-label="Schedule profile workspace" className="min-w-0 space-y-5" data-testid="schedule-profile-workspace" onBlurCapture={() => { editGroup.current = null; }}>
      <header className="sticky top-0 z-20 space-y-3 rounded-lg border bg-background p-4 shadow-sm">
        <div className="space-y-3"><div><h2 data-planner-heading tabIndex={-1} className="text-xl font-semibold">Day planner</h2><p className="text-sm text-muted-foreground">{session.mode === 'apply' ? `Application preview · ${session.definition.name}` : `Profile preview · ${session.definition.name || 'New profile'}`}</p></div>{actions}</div>
        <div className="grid items-end gap-3 lg:grid-cols-[minmax(0,1fr)_220px_minmax(200px,1fr)]">
          {showEditor ? <label className="space-y-1 text-sm font-medium"><span>Profile name</span><input className={inputClass} maxLength={80} disabled={busy} value={session.definition.name} onChange={event => edit({ definition: { ...session.definition, name: event.target.value } }, 'profile-name')} /></label> : <p className="font-medium">{session.definition.name}</p>}
          <label className="space-y-1 text-sm font-medium"><span>Preview schedule for</span><input ref={previewDateRef} type="date" className={inputClass} aria-describedby={`${session.id}-preview-date-help`} disabled={busy} value={referenceDate} onChange={event => changePreviewDate(event.target.value)} /></label>
          <div className="space-y-2 text-xs text-muted-foreground">
            <p>{data.schoolTimezone}<span id={`${session.id}-preview-date-help`} className="block">{session.mode === 'apply' ? 'Preview for this application only. The saved profile date stays unchanged unless you save a new profile.' : 'Saved with this profile for everyone. Choose dates & apply separately to schedule it.'}</span></p>
            {session.mode === 'view' && previewDateDirty && <div className="flex flex-wrap gap-2">
              <Button size="sm" disabled={busy || blockedByAdvancedDraft || !isReferenceDate(referenceDate)} onClick={() => saveProfile(false, true)}>{busy ? 'Saving…' : 'Save preview date'}</Button>
              <Button size="sm" variant="outline" disabled={busy} onClick={discardPreviewDate}>Discard date change</Button>
            </div>}
            {previewDateDirty && <p role="status">Save or discard the changed preview date before choosing application dates.</p>}
          </div>
        </div>
        {reusableDirty && <div className="flex flex-wrap items-center gap-2 text-sm"><p role="status">Unsaved changes. Save or discard profile changes before choosing application dates.</p>{session.profile && definitionDirty && <Button size="sm" variant="outline" disabled={busy} onClick={discardProfileChanges}>Discard profile changes</Button>}</div>}
      </header>
      {session && data && <><div ref={bodyRef} data-testid="schedule-profile-workspace-body" className="min-w-0 space-y-5"><fieldset disabled={busy} className="min-w-0 space-y-5">
        {session.mode === 'view' && <div className="rounded-lg border bg-primary/5 p-3 text-sm"><p role="status" className="font-semibold">{session.savedNotice ? 'Profile saved — not applied' : 'Saved profile — preview-day view'}</p><p className="mt-1 text-muted-foreground">Saving does not activate these changes. Existing applications keep their saved settings.</p>{blockedByAdvancedDraft && <p className="mt-2 text-amber-800 dark:text-amber-300">Save or discard the bell, rotation, date-override or calendar draft before editing or applying this profile. This review uses saved school settings.</p>}</div>}
        {session.mode === 'apply' && <div className="space-y-5"><div className="grid gap-4 sm:grid-cols-2"><div className="space-y-2"><label className="block space-y-1 text-sm"><span>Add an individual date</span><input type="date" className={inputClass} min={data.schoolLocalToday} value={oneDate} onChange={event => setOneDate(event.target.value)} /></label><Button variant="outline" size="sm" disabled={!oneDate} onClick={() => addDates([oneDate])}>Add selected date</Button></div><div className="space-y-2"><div className="grid grid-cols-2 gap-2"><label className="space-y-1 text-sm"><span>Range starts</span><input type="date" className={inputClass} min={data.schoolLocalToday} value={rangeStart} onChange={event => setRangeStart(event.target.value)} /></label><label className="space-y-1 text-sm"><span>Range ends</span><input type="date" className={inputClass} min={rangeStart || data.schoolLocalToday} value={rangeEnd} onChange={event => setRangeEnd(event.target.value)} /></label></div><Button variant="outline" size="sm" disabled={!rangeStart || !rangeEnd} onClick={() => { try { addDates(dateRange(rangeStart, rangeEnd)); } catch (failure) { setError(failure.message); } }}>Add date range</Button></div></div>
          <div className="space-y-2"><p className="text-sm font-medium">Selected dates ({session.dates.length}/31)</p><div className="flex flex-wrap gap-2">{session.dates.map(date => <button key={date} type="button" className="rounded-full border bg-muted px-3 py-1 text-xs" aria-label={`Remove application date ${date}`} onClick={() => edit({ dates: session.dates.filter(value => value !== date) })}>{date} ×</button>)}</div><p className="text-xs text-muted-foreground">Date ranges include weekends. The preview identifies dates that cannot be applied.</p></div>
          <label className="flex items-center gap-2 text-sm font-medium"><input type="checkbox" checked={session.customize} onChange={event => { if (!event.target.checked && JSON.stringify(session.definition) !== session.original && !window.confirm('Discard the changes made for this use?')) return; edit({ customize: event.target.checked, definition: copy(session.profile.definition), referenceDate: session.dates[0] || data.schoolLocalToday }); }} />Customize this use</label><p className="text-xs text-muted-foreground">Changes here belong to this application. The saved profile stays unchanged.</p>
        </div>}

        {<RegularScheduleReference date={referenceDate} onDateChange={changePreviewDate} onRefresh={refreshReference} query={regularQuery} schedule={regularSchedule} timezone={data.schoolTimezone} setup={session.setup} hideControls />}
        {session.setup ? <div className="space-y-3">
          <p className="text-sm text-muted-foreground">{regularSchedule && meetingClasses.length > 0 ? `${meetingClasses.length} classes meet on this day. ` : ''}Load the whole day, then adjust or remove classes. Unchanged classes keep following their regular schedule.</p>
          {loadProblem && <p role="alert" className="text-sm text-destructive">{loadProblem}</p>}
          <div className="flex flex-wrap gap-2"><Button disabled={!regularSchedule || !meetingClasses.length || Boolean(loadProblem) || blockedByAdvancedDraft} onClick={loadRegularSchedule}>Load regular schedule</Button><Button variant="outline" disabled={blockedByAdvancedDraft} onClick={() => edit({ setup: false })}>Start blank</Button></div>
        </div> : <ScheduleDayPlanner key={session.id} definition={session.definition} catalog={data} regularSchedule={regularSchedule} referenceDate={referenceDate} hoursQuery={hoursQuery} review={draftReview} reviewRetry={refreshReference} validReviewDate={isReferenceDate(referenceDate)} savedReview={session.mode === 'view' && session.savedNotice}
          filters={session.plannerFilters} onFiltersChange={plannerFilters => setSession(current => ({ ...current, plannerFilters }))}
          plannerView={plannerView} onPlannerViewChange={setPlannerView}
          collapsedGrades={session.collapsedGrades} onCollapsedGradesChange={collapsedGrades => setSession(current => ({ ...current, collapsedGrades }))}
          activeTarget={session.activeTarget} onEditTarget={editTarget} onChange={(definition, editKey, target) => edit({ definition, ...(target ? { activeTarget: target, focusTarget: { ...target } } : {}) }, editKey)}
          onAddGroups={addTestingGroups} disabled={busy || blockedByAdvancedDraft} />}
        {session.mode === 'apply' && session.customize && <div className="flex flex-wrap items-end gap-2 rounded-md bg-muted p-3"><label className="min-w-48 flex-1 space-y-1 text-sm"><span>Name for new profile</span><input className={inputClass} maxLength={80} value={newName} onChange={event => setNewName(event.target.value)} /></label><Button variant="outline" disabled={!isReferenceDate(referenceDate) || blockedByAdvancedDraft} onClick={() => saveProfile(true)}>Save as new profile</Button><p className="w-full text-xs text-muted-foreground">Saves these settings and the preview date as a separate draft. Select its application dates separately afterward.</p></div>}
        {notice && <p role="status" className="text-sm">{notice}</p>}
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        {preview && <Preview key={preview.previewToken} preview={preview} catalog={data}
          acknowledged={existingApplicationsAcknowledged}
          onAcknowledge={checked => setAcknowledgedToken(checked ? preview.previewToken : '')} />}
      </fieldset></div></>}
    </section>}
    {testingPicker && session && <ScheduleTestingGroupPicker key={session.id} open schoolId={activeSchoolId} actorId={user?.id} remaining={30 - session.definition.testingBlocks.length} onOpenChange={setTestingPicker} onAdd={(blocks, groups) => {
      if (blocks.length + session.definition.testingBlocks.length > 30) { setError('A profile can contain no more than 30 testing blocks.'); return; }
      seedGroupMetadata(groups);
      edit({ definition: { ...session.definition, testingBlocks: [...session.definition.testingBlocks, ...blocks] }, activeTarget: blocks[0] ? { blockId: blocks[0].id } : null, focusTarget: blocks[0] ? { blockId: blocks[0].id } : null });
    }} onGroupSaved={refreshCreatedGroup} />}

    <AlertDialog open={Boolean(removingHistory)} onOpenChange={open => { if (!open && !busyRef.current) setRemovingHistory(null); }}>
      <AlertDialogContent onEscapeKeyDown={event => { if (busyRef.current) event.preventDefault(); }} onCloseAutoFocus={event => { event.preventDefault(); requestAnimationFrame(() => (historyOpener.current?.isConnected ? historyOpener.current : applicationsHeading.current)?.focus()); }}>
        <AlertDialogHeader><AlertDialogTitle>Delete from history?</AlertDialogTitle><AlertDialogDescription asChild><div className="space-y-2"><p>Remove <strong>{removingHistory?.application.profileName}</strong> and all its dates below from the history list?</p><p>The reusable profile, applied schedule records, student activity reports, and audit records will be preserved. This does not cancel or change any schedule.</p></div></AlertDialogDescription></AlertDialogHeader>
        <ul className="max-h-48 list-inside list-disc overflow-y-auto text-sm">{removingHistory?.application.dates.map(date => <li key={date}>{scheduleDateText(date)}</li>)}</ul>
        {historyChanged && <p role="alert" className="text-sm text-destructive">Scheduling changed. Close this confirmation, refresh status, and reopen it before deleting from history.</p>}
        {!historyChanged && removingHistory && !historyAvailability?.canRequest && <p role="alert" className="text-sm text-destructive">History removal is unavailable. All application dates must be past and supervision must have ended. Close this confirmation and refresh status.</p>}
        {historyError && <p role="alert" className="text-sm text-destructive">{historyError}</p>}
        <AlertDialogFooter><AlertDialogCancel disabled={busy}>Keep history entry</AlertDialogCancel><Button variant="destructive" disabled={busy || blockedByAdvancedDraft || historyChanged || !historyAvailability?.canRequest} onClick={deleteHistory}>{busy ? 'Deleting…' : 'Delete from history'}</Button></AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>

    <AlertDialog open={Boolean(cancelling)} onOpenChange={open => { if (!open && !busyRef.current) setCancelling(null); }}>
      <AlertDialogContent onEscapeKeyDown={event => { if (busyRef.current) event.preventDefault(); }} onCloseAutoFocus={event => { event.preventDefault(); requestAnimationFrame(() => (cancelOpener.current?.isConnected ? cancelOpener.current : listHeading.current)?.focus()); }}>
        <AlertDialogHeader><AlertDialogTitle>Cancel application?</AlertDialogTitle><AlertDialogDescription asChild><div className="space-y-2"><p>Cancel <strong>{cancelling?.application.profileName}</strong> on all the dates below?</p><p>This cancels the entire application, including every testing block and class adjustment on these dates. The previous schedule will be restored if validation succeeds.</p></div></AlertDialogDescription></AlertDialogHeader>
        <ul className="max-h-48 list-inside list-disc overflow-y-auto text-sm">{cancelling?.application.dates.map(date => <li key={date}>{scheduleDateText(date)}</li>)}</ul>
        {cancellationChanged && <p role="alert" className="text-sm text-destructive">Scheduling changed. Close this confirmation, refresh status, and reopen it before cancelling.</p>}
        {!cancellationChanged && cancelling && !cancelAvailability?.canRequest && <p role="alert" className="text-sm text-destructive">{cancelAvailability?.reason === 'started' ? 'The first affected window has started. Cancellation is no longer available.' : 'Cancellation availability could not be confirmed. Close this confirmation and refresh status.'}</p>}
        {cancelError && <p role="alert" className="text-sm text-destructive">{cancelError}</p>}
        <AlertDialogFooter><AlertDialogCancel disabled={busy}>Keep application</AlertDialogCancel><Button variant="destructive" disabled={busy || blockedByAdvancedDraft || cancellationChanged || !cancelAvailability?.canRequest} onClick={cancelApplication}>{busy ? 'Cancelling…' : 'Cancel all applied dates'}</Button></AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>

    <AlertDialog open={Boolean(cancellingBlock)} onOpenChange={open => { if (!open && !busyRef.current) setCancellingBlock(null); }}>
      <AlertDialogContent onEscapeKeyDown={event => { if (busyRef.current) event.preventDefault(); }} onCloseAutoFocus={event => { event.preventDefault(); requestAnimationFrame(() => (cancelBlockOpener.current?.isConnected ? cancelBlockOpener.current : listHeading.current)?.focus()); }}>
        <AlertDialogHeader><AlertDialogTitle>Cancel this testing block?</AlertDialogTitle><AlertDialogDescription asChild><div className="space-y-2"><p>Cancel <strong>{cancellingBlock?.window.name}</strong> on {cancellingBlock ? scheduleDateText(cancellingBlock.date) : ''}?</p><p>Any students currently in this block are released now and follow their regular scheduled class for that time. Other testing blocks, other dates and all class changes in this application are unaffected.</p><p>This cannot be undone. Reapply the profile if the block is needed again.</p></div></AlertDialogDescription></AlertDialogHeader>
        {cancellingBlock && <p className="text-sm">{cancellingBlock.window.studentIds?.length || 0} student{(cancellingBlock.window.studentIds?.length || 0) === 1 ? '' : 's'} assigned</p>}
        {blockCancellationChanged && <p role="alert" className="text-sm text-destructive">Scheduling changed. Close this confirmation, refresh status, and reopen it before cancelling.</p>}
        {cancelBlockError && <p role="alert" className="text-sm text-destructive">{cancelBlockError}</p>}
        <AlertDialogFooter><AlertDialogCancel disabled={busy}>Keep testing block</AlertDialogCancel><Button variant="destructive" disabled={busy || blockedByAdvancedDraft || blockCancellationChanged} onClick={cancelTestingBlock}>{busy ? 'Cancelling…' : 'Cancel this block'}</Button></AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>

    <AlertDialog open={Boolean(deleting)} onOpenChange={open => { if (!open && !busyRef.current) setDeleting(null); }}>
      <AlertDialogContent onEscapeKeyDown={event => { if (busyRef.current) event.preventDefault(); }} onCloseAutoFocus={event => { event.preventDefault(); requestAnimationFrame(() => (deleteOpener.current?.isConnected ? deleteOpener.current : listHeading.current)?.focus()); }}>
        <AlertDialogHeader><AlertDialogTitle>Delete profile?</AlertDialogTitle><AlertDialogDescription asChild><div className="space-y-2"><p>Delete <strong>{deleting?.profile.definition.name}</strong> from your reusable profiles?</p><p>Applied schedules will remain scheduled. Deleting this profile does not cancel testing.</p><p>Applied schedule history and supervision records will be preserved. This cannot be undone.</p></div></AlertDialogDescription></AlertDialogHeader>
        {deleting?.applications.length > 0 && <div className="max-h-48 overflow-y-auto text-sm"><p className="font-medium">Applied dates kept</p><ul className="list-inside list-disc">{deleting.applications.map(application => <li key={application.id}>{application.dates.join(', ')} · {applicationStatus(application, data.schoolLocalToday)}</li>)}</ul></div>}
        {deleteError && <p role="alert" className="text-sm text-destructive">{deleteError}</p>}
        <AlertDialogFooter><AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel><Button variant="destructive" disabled={busy || deleteStale || blockedByAdvancedDraft} onClick={deleteProfile}>{busy ? 'Deleting…' : 'Delete profile'}</Button></AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  </div>;
}
