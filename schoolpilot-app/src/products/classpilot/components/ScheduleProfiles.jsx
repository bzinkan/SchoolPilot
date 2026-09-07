import { useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CalendarDays, Copy, Plus } from 'lucide-react';
import { apiRequest } from '../../../lib/queryClient';
import { Button } from '../../../components/ui/button';
import { Badge } from '../../../components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../../../components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../../../components/ui/dialog';

const API = '/classpilot/admin/schedule-profiles';
const KEY = ['classpilot-schedule-profiles'];
const EMPTY = [];
const inputClass = 'min-w-0 w-full rounded-md border bg-background px-3 py-2 text-sm';
const copy = value => structuredClone(value);
const errorMessage = error => error?.response?.data?.error || error?.message || 'The schedule profile action failed.';
const gradeName = grade => /^grade\s/i.test(grade) ? grade : `Grade ${grade}`;
const gradeKey = grade => /^(?:grade\s*)?([1-8])$/i.exec(grade.trim())?.[1] || grade;
const selectedClass = (definition, row) => definition.classIds.includes(row.id) || definition.grades.includes(String(row.gradeLevel));
const timeText = value => !value || value.action === 'skip' || value.meets === false ? 'Does not meet' : typeof value === 'string' ? value : `${value.startTime || '—'}–${value.endTime || '—'}`;
const blankDefinition = () => ({ name: '', grades: [], classIds: [], classRules: [], testingBlocks: [] });
const copyName = (name, suffix) => `${name.slice(0, 80 - suffix.length)}${suffix}`;
const testingStatusLabels = { pending: 'Awaiting start', active: 'Active', ended: 'Finished', failed: 'Could not start', missed: 'Missed', cancelled: 'Cancelled', releasing: 'Ending' };
const testingStatusReasons = {
  COVERAGE_GROUP_UNAVAILABLE: 'The Coverage group is unavailable.',
  STAFF_MEMBERSHIP_UNAVAILABLE: 'The assigned staff member is unavailable.',
  STAFF_GROUP_PAIRING_CHANGED: 'The staff assignment to this group changed.',
  COVERAGE_ROSTER_CHANGED: 'The Coverage group roster changed.',
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
  ACTIVATION_FAILED: 'Testing supervision could not start. Review the schedule and Coverage setup.',
};
function applicationStatus(application, today) {
  if (application.status === 'cancelled') return 'Cancelled';
  if (today && application.dates.every(date => date < today)) return 'Completed';
  return application.dates.includes(today) ? 'Applied · Today' : 'Scheduled';
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
  for (const rule of definition.classRules) {
    if (rule.action === 'time' && (!rule.startTime || !rule.endTime || rule.startTime >= rule.endTime)) return 'Each custom class time needs an end after its start.';
  }
  for (const block of definition.testingBlocks) {
    if (!block.name.trim() || !block.coverageGroupId || !block.assignedStaffId) return 'Each testing block needs a name, Coverage group and assigned staff member.';
    if (!block.startTime || !block.endTime || block.startTime >= block.endTime) return 'Each testing block needs an end after its start.';
  }
  return null;
}

function DefinitionEditor({ definition, onChange, catalog, disabled }) {
  const classes = catalog.classes || EMPTY, groups = catalog.supervisionGroups || EMPTY, staff = catalog.staff || EMPTY;
  const [viewGrade, setViewGrade] = useState('all');
  const [search, setSearch] = useState('');
  const grades = useMemo(() => {
    const choices = new Map();
    for (const grade of [...classes.map(row => String(row.gradeLevel ?? '')).filter(Boolean), ...definition.grades]) {
      const key = gradeKey(grade), choice = choices.get(key) || { key, values: [] };
      if (!choice.values.includes(grade)) choice.values.push(grade);
      choices.set(key, choice);
    }
    for (let grade = 1; grade <= 8; grade++) if (!choices.has(String(grade))) choices.set(String(grade), { key: String(grade), values: [String(grade)] });
    return [...choices.values()].sort((a, b) => a.key.localeCompare(b.key, undefined, { numeric: true }));
  }, [classes, definition.grades]);
  const staffNames = useMemo(() => new Map(staff.map(person => [person.id, person.name])), [staff]);
  const rules = useMemo(() => new Map(definition.classRules.map(rule => [rule.classId, rule])), [definition.classRules]);
  const visible = classes.filter(row => (viewGrade === 'all' || gradeKey(String(row.gradeLevel || '')) === viewGrade) && `${row.name} ${row.teacherName || ''}`.toLowerCase().includes(search.trim().toLowerCase()));
  const updateScope = change => {
    const next = { ...definition, ...change };
    next.classRules = next.classRules.filter(rule => classes.some(row => row.id === rule.classId && selectedClass(next, row)));
    onChange(next);
  };
  const changeRule = (classId, change) => onChange({ ...definition, classRules: [...definition.classRules.filter(rule => rule.classId !== classId), ...(change ? [{ classId, ...change }] : [])] });
  const changeBlock = (id, change) => onChange({ ...definition, testingBlocks: definition.testingBlocks.map(block => block.id === id ? { ...block, ...change } : block) });
  return <fieldset disabled={disabled} className="min-w-0 space-y-5">
    <label className="block space-y-1 text-sm font-medium"><span>Profile name</span><input className={inputClass} maxLength={80} value={definition.name} onChange={event => onChange({ ...definition, name: event.target.value })} /></label>
    <fieldset className="space-y-2"><legend className="mb-2 text-sm font-medium">Grades and classes</legend>
      <p className="text-xs text-muted-foreground">Include every class in selected grades, individual classes, or both. Classes left on Keep use their existing schedule on each date.</p>
      <div className="flex flex-wrap items-center gap-3"><Button size="sm" variant="outline" onClick={() => updateScope({ grades: grades.filter(grade => /^[1-8]$/.test(grade.key)).flatMap(grade => grade.values) })}>Select grades 1–8</Button><Button size="sm" variant="ghost" onClick={() => updateScope({ grades: [] })}>Clear grades</Button>
        {grades.map(grade => <label key={grade.key} className="flex items-center gap-2 text-sm"><input type="checkbox" ref={element => { if (element) element.indeterminate = grade.values.some(value => definition.grades.includes(value)) && !grade.values.every(value => definition.grades.includes(value)); }} checked={grade.values.every(value => definition.grades.includes(value))} onChange={event => updateScope({ grades: event.target.checked ? [...new Set([...definition.grades, ...grade.values])] : definition.grades.filter(value => gradeKey(value) !== grade.key) })} />{gradeName(grade.key)}</label>)}
      </div>
      <div className="grid gap-2 pt-2 sm:grid-cols-2"><label className="space-y-1 text-sm"><span>View grade</span><select className={inputClass} value={viewGrade} onChange={event => setViewGrade(event.target.value)}><option value="all">All grades</option>{grades.map(grade => <option key={grade.key} value={grade.key}>{gradeName(grade.key)}</option>)}</select></label><label className="space-y-1 text-sm"><span>Find a class or teacher</span><input className={inputClass} value={search} onChange={event => setSearch(event.target.value)} /></label></div>
      <div className="max-h-80 overflow-auto rounded-md border"><table className="w-full min-w-[580px] text-left text-sm"><thead className="sticky top-0 bg-muted"><tr><th className="p-3">Include class</th><th className="p-3">Current time</th><th className="p-3">This profile</th></tr></thead><tbody>
        {visible.map(row => { const included = selectedClass(definition, row), byGrade = definition.grades.includes(String(row.gradeLevel)), rule = rules.get(row.id); return <tr key={row.id} className="border-t"><td className="p-3 align-top"><label className="flex items-start gap-2"><input type="checkbox" aria-label={`Include ${row.name}`} checked={included} disabled={byGrade} onChange={event => updateScope({ classIds: event.target.checked ? [...definition.classIds, row.id] : definition.classIds.filter(id => id !== row.id) })} /><span><span className="block font-medium">{row.name}</span><span className="text-xs text-muted-foreground">{gradeName(String(row.gradeLevel || 'unassigned'))}{row.teacherName ? ` · ${row.teacherName}` : ''}{byGrade ? ' · included by grade' : ''}</span></span></label></td><td className="p-3 align-top text-muted-foreground">{row.scheduleEnabled ? `${row.blockStartTime || '—'}–${row.blockEndTime || '—'}` : 'Schedule off'}</td><td className="space-y-2 p-3"><select className={inputClass} aria-label={`${row.name} schedule action`} disabled={!included} value={rule?.action || 'keep'} onChange={event => changeRule(row.id, event.target.value === 'keep' ? null : event.target.value === 'skip' ? { action: 'skip' } : { action: 'time', startTime: row.blockStartTime || '08:00', endTime: row.blockEndTime || '08:45' })}><option value="keep">Keep existing schedule</option><option value="time">Custom time</option><option value="skip">Does not meet</option></select>{rule?.action === 'time' && <div className="flex gap-2"><input aria-label={`${row.name} profile start`} className={inputClass} type="time" value={rule.startTime} onChange={event => changeRule(row.id, { ...rule, startTime: event.target.value })} /><input aria-label={`${row.name} profile end`} className={inputClass} type="time" value={rule.endTime} onChange={event => changeRule(row.id, { ...rule, endTime: event.target.value })} /></div>}</td></tr>; })}
      </tbody></table>{visible.length === 0 && <p className="p-4 text-sm text-muted-foreground">No classes match this view.</p>}</div>
    </fieldset>
    <section className="space-y-3" aria-label="Testing blocks"><div><h4 className="text-sm font-semibold">Testing blocks <span className="font-normal text-muted-foreground">· optional</span></h4><p className="text-xs text-muted-foreground">Use an existing Coverage group and its assigned staff for a testing window. Student class rosters stay in place.</p></div>
      {definition.testingBlocks.map((block, index) => { const group = groups.find(row => row.id === block.coverageGroupId); return <div key={block.id} className="space-y-3 rounded-md border p-3"><div className="flex items-center justify-between"><p className="text-sm font-medium">Testing block {index + 1}</p><Button size="sm" variant="ghost" aria-label={`Remove testing block ${index + 1}`} onClick={() => onChange({ ...definition, testingBlocks: definition.testingBlocks.filter(row => row.id !== block.id) })}>Remove</Button></div><div className="grid gap-3 sm:grid-cols-2">
        <label className="space-y-1 text-sm"><span>Block name</span><input aria-label={`Testing block ${index + 1} name`} className={inputClass} maxLength={80} value={block.name} onChange={event => changeBlock(block.id, { name: event.target.value })} /></label>
        <label className="space-y-1 text-sm"><span>Coverage group</span><select aria-label={`Testing block ${index + 1} Coverage group`} className={inputClass} value={block.coverageGroupId} onChange={event => changeBlock(block.id, { coverageGroupId: event.target.value, assignedStaffId: '' })}><option value="">Choose a group</option>{groups.map(row => <option key={row.id} value={row.id}>{row.name} · {row.studentIds?.length || 0} students</option>)}</select></label>
        <label className="space-y-1 text-sm"><span>Assigned staff</span><select aria-label={`Testing block ${index + 1} assigned staff`} className={inputClass} value={block.assignedStaffId} onChange={event => changeBlock(block.id, { assignedStaffId: event.target.value })}><option value="">Choose group staff</option>{(group?.staffIds || EMPTY).filter(id => staffNames.has(id)).map(id => <option key={id} value={id}>{staffNames.get(id)}</option>)}</select></label>
        <div className="grid grid-cols-2 gap-2"><label className="space-y-1 text-sm"><span>Start</span><input aria-label={`Testing block ${index + 1} start`} className={inputClass} type="time" value={block.startTime} onChange={event => changeBlock(block.id, { startTime: event.target.value })} /></label><label className="space-y-1 text-sm"><span>End</span><input aria-label={`Testing block ${index + 1} end`} className={inputClass} type="time" value={block.endTime} onChange={event => changeBlock(block.id, { endTime: event.target.value })} /></label></div>
      </div>{group && !group.staffIds?.length && <p className="text-xs text-destructive">Assign staff to this group in Coverage before using it for testing.</p>}</div>; })}
      <Button variant="outline" size="sm" disabled={!groups.length || definition.testingBlocks.length >= 30} onClick={() => onChange({ ...definition, testingBlocks: [...definition.testingBlocks, { id: crypto.randomUUID(), name: 'Testing', coverageGroupId: '', assignedStaffId: '', startTime: '09:00', endTime: '10:00' }] })}><Plus className="mr-2 h-4 w-4" />Add testing block</Button>{!groups.length && <p className="text-xs text-muted-foreground">Set up a group and its staff in Coverage to add testing blocks.</p>}
    </section>
  </fieldset>;
}

function Preview({ preview, catalog }) {
  const [page, setPage] = useState(0);
  const changes = preview.changes || EMPTY;
  const count = typeof preview.affectedClasses === 'number' ? preview.affectedClasses : preview.affectedClasses?.length ?? new Set(changes.map(row => row.classId)).size;
  return <section aria-label="Profile application preview" className="space-y-3 rounded-lg border p-4">
    <h4 className="font-semibold">Review this application</h4><p className="text-sm text-muted-foreground">{count} affected classes · Times use {preview.schoolTimezone || catalog.schoolTimezone}.</p>
    {(preview.blockers || EMPTY).map((blocker, index) => <p key={index} role="alert" className="text-sm text-destructive">{blocker.date ? `${blocker.date}: ` : ''}{blocker.message}</p>)}
    {changes.length > 0 ? <><div className="overflow-x-auto"><table className="w-full text-left text-sm"><thead><tr><th className="p-2">Date / class</th><th className="p-2">Before</th><th className="p-2">After</th></tr></thead><tbody>{changes.slice(page * 50, (page + 1) * 50).map((change, index) => <tr className="border-t" key={`${change.date}-${change.classId}-${index}`}><td className="p-2">{change.date}<span className="block font-medium">{change.className}</span></td><td className="p-2">{timeText(change.before)}</td><td className="p-2">{timeText(change.after)}</td></tr>)}</tbody></table></div>{changes.length > 50 && <div className="flex items-center gap-3"><Button size="sm" variant="outline" disabled={!page} onClick={() => setPage(value => value - 1)}>Previous changes</Button><span className="text-xs">{page * 50 + 1}–{Math.min(changes.length, (page + 1) * 50)} of {changes.length}</span><Button size="sm" variant="outline" disabled={(page + 1) * 50 >= changes.length} onClick={() => setPage(value => value + 1)}>Next changes</Button></div>}</> : <p className="text-sm">No ordinary class times change.</p>}
    {(preview.testingWindows || EMPTY).length > 0 && <div className="max-h-64 space-y-2 overflow-auto"><h5 className="text-sm font-semibold">Testing windows</h5>{preview.testingWindows.map((window, index) => <p key={`${window.date}-${window.blockId}-${index}`} className="rounded bg-muted p-2 text-sm">{window.date} · {window.name} · {window.startTime}–{window.endTime}<span className="block text-xs text-muted-foreground">{catalog.staff?.find(person => person.id === window.assignedStaffId)?.name || 'Assigned staff'} · {window.studentIds?.length || 0} students</span></p>)}</div>}
  </section>;
}

export default function ScheduleProfiles({ blockedByAdvancedDraft = false, onBusyChange }) {
  const client = useQueryClient();
  const query = useQuery({ queryKey: KEY, queryFn: ({ signal }) => apiRequest('GET', API, undefined, { signal }), refetchInterval: current => current.state.data?.testingStatuses?.some(row => ['pending', 'active', 'releasing'].includes(row.status)) ? 30_000 : false });
  const [session, setSession] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [preview, setPreview] = useState(null);
  const [oneDate, setOneDate] = useState('');
  const [rangeStart, setRangeStart] = useState('');
  const [rangeEnd, setRangeEnd] = useState('');
  const [newName, setNewName] = useState('');
  const data = query.data;
  const testingStatuses = useMemo(() => new Map((data?.testingStatuses || EMPTY).map(row => [`${row.applicationId}:${row.date}:${row.blockId}`, row])), [data?.testingStatuses]);
  const dirty = Boolean(session && (JSON.stringify(session.definition) !== session.original || session.customize || session.dates.join(',') !== session.initialDates || preview));
  useEffect(() => { onBusyChange?.(busy); }, [busy, onBusyChange]);
  useEffect(() => {
    if (!dirty) return undefined;
    const handler = event => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [dirty]);
  const refresh = async (scheduleChanged = false) => {
    await Promise.all([client.invalidateQueries({ queryKey: KEY }), ...(scheduleChanged ? [client.invalidateQueries({ queryKey: ['classpilot-school-scheduling'] }), client.invalidateQueries({ queryKey: ['classpilot-admin-classes'] })] : [])]);
  };
  const open = (mode, profile, duplicate = false) => {
    const definition = profile ? copy(profile.definition) : blankDefinition();
    if (duplicate) definition.name = copyName(definition.name, ' (copy)');
    const dates = mode === 'apply' && data.schoolLocalToday ? [data.schoolLocalToday] : [];
    setSession({ mode, profile: duplicate ? null : profile, definition, original: JSON.stringify(definition), revision: data.revision, dates, initialDates: dates.join(','), customize: false });
    setNewName(copyName(definition.name, ' (custom)')); setOneDate(''); setRangeStart(''); setRangeEnd(''); setPreview(null); setError(''); setNotice('');
  };
  const close = () => { if (!busy && (!dirty || window.confirm('Discard these unsaved profile or application changes?'))) { setSession(null); setPreview(null); setError(''); } };
  const edit = change => { setSession(current => ({ ...current, ...change })); setPreview(null); setError(''); };
  const execute = async operation => { setBusy(true); setError(''); try { await operation(); } catch (failure) { setError(errorMessage(failure)); if (failure?.response?.status === 409) { setPreview(null); await refresh(true); } } finally { setBusy(false); } };
  const saveProfile = (asNew = false) => execute(async () => {
    const definition = { ...session.definition, name: (asNew ? newName : session.definition.name).trim() };
    const problem = validateDefinition(definition); if (problem) throw new Error(problem);
    await apiRequest('POST', API, { revision: session.revision, ...(!asNew && session.profile ? { id: session.profile.id, profileRevision: session.profile.revision } : {}), definition });
    await refresh(true); setSession(null); setPreview(null); setNotice(asNew ? 'Saved a new profile. Choose Apply when you are ready to select its dates.' : 'Profile saved. Apply it to dates when you are ready. Existing applications keep their saved settings.');
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
    const result = await apiRequest('POST', `${API}/preview`, payload); setPreview({ ...result, payload });
  });
  const apply = () => execute(async () => {
    await apiRequest('POST', `${API}/apply`, { ...preview.payload, previewToken: preview.previewToken });
    await refresh(true); setSession(null); setPreview(null); setNotice('Schedule profile applied to the reviewed dates.');
  });
  const cancel = application => {
    if (!window.confirm(`Cancel ${application.profileName} on ${application.dates.join(', ')}? Before its first class or testing window starts, cancellation restores the previous schedule.`)) return;
    execute(async () => { await apiRequest('POST', `${API}/applications/${encodeURIComponent(application.id)}/cancel`, { revision: data.revision }); await refresh(true); setNotice('Schedule application cancelled.'); });
  };
  return <Card data-testid="schedule-profiles"><CardHeader><div className="flex flex-wrap items-start justify-between gap-3"><div className="max-w-xl space-y-1.5"><CardTitle className="text-xl">Schedule profiles</CardTitle><CardDescription>Build a plan for an early release, testing day or delay. Apply it to selected dates while keeping regular class rosters in place.</CardDescription></div><Button disabled={!data || busy || blockedByAdvancedDraft} onClick={() => open('edit')}><Plus className="mr-2 h-4 w-4" />Create Schedule Profile</Button></div></CardHeader><CardContent className="space-y-5">
    <ol aria-label="Schedule profile workflow" className="grid gap-4 rounded-md bg-muted/40 p-4 text-sm sm:grid-cols-3">
      <li><p className="font-medium">1. Save a profile</p><p className="mt-1 text-xs leading-relaxed text-muted-foreground">Choose grades or classes, adjust times and add optional testing blocks.</p></li>
      <li><p className="font-medium">2. Choose dates</p><p className="mt-1 text-xs leading-relaxed text-muted-foreground">Use Apply on a saved profile. Customize that use if needed.</p></li>
      <li><p className="font-medium">3. Preview & apply</p><p className="mt-1 text-xs leading-relaxed text-muted-foreground">Review affected classes and resolve conflicts before applying.</p></li>
    </ol>
    {query.isLoading && <p role="status" className="text-sm">Loading schedule profiles…</p>}
    {query.error && <div className="space-y-2"><p role="alert" className="text-sm text-destructive">{errorMessage(query.error)}</p><Button variant="outline" size="sm" onClick={() => query.refetch()}>Retry profiles</Button></div>}
    {blockedByAdvancedDraft && <p className="text-sm text-amber-700 dark:text-amber-300">Save or discard the bell, rotation, date-override or calendar draft before changing profiles or their applications.</p>}
    {notice && <p role="status" className="text-sm text-green-700 dark:text-green-400">{notice}</p>}
    {!session && error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    {data && <><p className="text-xs text-muted-foreground">School timezone: {data.schoolTimezone}. Saving a profile does not activate it or change an existing application.</p>{data.profiles?.length > 0 && <div className="grid gap-3 lg:grid-cols-2">{(data.profiles || EMPTY).map(profile => <article key={profile.id} className="space-y-3 rounded-lg border p-4"><h3 className="font-semibold">{profile.definition.name}</h3><p className="text-xs text-muted-foreground">{profile.definition.grades.length ? profile.definition.grades.map(gradeName).join(', ') : 'Individual selection'} · {profile.definition.classIds.length} individual classes · {profile.definition.testingBlocks.length} testing blocks</p><div className="flex flex-wrap gap-2"><Button size="sm" variant="outline" aria-label={`Edit ${profile.definition.name}`} disabled={busy || blockedByAdvancedDraft} onClick={() => open('edit', profile)}>Edit</Button><Button size="sm" variant="outline" aria-label={`Duplicate ${profile.definition.name}`} disabled={busy || blockedByAdvancedDraft} onClick={() => open('edit', profile, true)}><Copy className="mr-2 h-3.5 w-3.5" />Duplicate</Button><Button size="sm" aria-label={`Apply ${profile.definition.name}`} disabled={busy || blockedByAdvancedDraft} onClick={() => open('apply', profile)}><CalendarDays className="mr-2 h-3.5 w-3.5" />Apply</Button></div></article>)}</div>}{!data.profiles?.length && <p className="rounded-lg border border-dashed p-5 text-sm text-muted-foreground">No profiles yet. Create your first special-day plan, then apply it to the dates you need.</p>}
      {(data.applications || EMPTY).length > 0 && <section className="space-y-3" aria-label="Schedule profile applications"><div className="flex items-center justify-between gap-2"><h3 className="text-sm font-semibold">Applied schedules</h3><Button size="sm" variant="ghost" disabled={busy || query.isFetching} onClick={() => query.refetch()}>Refresh status</Button></div><p className="text-xs text-muted-foreground">Cancel before the first affected class or testing window starts. After it starts, use Release or Extend in Coverage to manage testing supervision.</p>{data.applications.map(application => <div key={application.id} className="space-y-2 rounded-md border p-3"><div className="flex flex-wrap items-center justify-between gap-2"><div className="flex flex-wrap items-center gap-2"><span className="text-sm font-medium">{application.profileName}</span><Badge variant="secondary">{applicationStatus(application, data.schoolLocalToday)}</Badge></div>{['active', 'applied', 'scheduled'].includes(application.status) && applicationStatus(application, data.schoolLocalToday) !== 'Completed' && <Button size="sm" variant="outline" disabled={busy || blockedByAdvancedDraft} onClick={() => cancel(application)}>Cancel application<span className="sr-only"> {application.profileName}</span></Button>}</div><p className="text-xs text-muted-foreground">{application.dates.join(' · ')}</p>{(application.testingWindows || EMPTY).map((window, index) => {
        const status = testingStatuses.get(`${application.id}:${window.date}:${window.blockId}`);
        return <div key={`${window.date}-${window.blockId}-${index}`} className="rounded bg-muted p-2 text-xs"><p>{window.date} · {window.name} · {window.startTime}–{window.endTime} · <span className="font-medium">{testingStatusLabels[status?.status] || 'Status unavailable'}</span></p>{['failed', 'missed'].includes(status?.status) && <><p className="mt-1 text-destructive">{testingStatusReasons[status.code] || testingStatusReasons.ACTIVATION_FAILED}</p><p className="mt-1 text-muted-foreground">Use Coverage to manage any testing still needed today. Failed or missed windows do not restart automatically.</p></>}</div>;
      })}</div>)}</section>}
    </>}
    <Dialog open={Boolean(session)} onOpenChange={value => { if (!value) close(); }}><DialogContent className="flex max-h-[92dvh] w-[calc(100%-1.5rem)] max-w-5xl flex-col overflow-hidden"><DialogHeader className="shrink-0 pr-5"><DialogTitle>{session?.mode === 'apply' ? `Apply ${session.definition.name}` : session?.profile ? 'Edit Schedule Profile' : 'Create Schedule Profile'}</DialogTitle><DialogDescription>{session?.mode === 'apply' ? `Choose up to 31 dates. Preview checks class and testing conflicts in ${data?.schoolTimezone || 'the school timezone'}.` : 'Save a reusable draft. Its dates are chosen separately when you apply it.'}</DialogDescription></DialogHeader>
      {session && data && <><div className="min-h-0 overflow-y-auto pr-1"><fieldset disabled={busy} className="min-w-0 space-y-5">
        {session.mode === 'apply' && <><div className="grid gap-4 sm:grid-cols-2"><div className="space-y-2"><label className="block space-y-1 text-sm"><span>Add an individual date</span><input type="date" className={inputClass} min={data.schoolLocalToday} value={oneDate} onChange={event => setOneDate(event.target.value)} /></label><Button variant="outline" size="sm" disabled={!oneDate} onClick={() => addDates([oneDate])}>Add selected date</Button></div><div className="space-y-2"><div className="grid grid-cols-2 gap-2"><label className="space-y-1 text-sm"><span>Range starts</span><input type="date" className={inputClass} min={data.schoolLocalToday} value={rangeStart} onChange={event => setRangeStart(event.target.value)} /></label><label className="space-y-1 text-sm"><span>Range ends</span><input type="date" className={inputClass} min={rangeStart || data.schoolLocalToday} value={rangeEnd} onChange={event => setRangeEnd(event.target.value)} /></label></div><Button variant="outline" size="sm" disabled={!rangeStart || !rangeEnd} onClick={() => { try { addDates(dateRange(rangeStart, rangeEnd)); } catch (failure) { setError(failure.message); } }}>Add date range</Button></div></div>
          <div className="space-y-2"><p className="text-sm font-medium">Selected dates ({session.dates.length}/31)</p><div className="flex flex-wrap gap-2">{session.dates.map(date => <button key={date} type="button" className="rounded-full border bg-muted px-3 py-1 text-xs" aria-label={`Remove application date ${date}`} onClick={() => edit({ dates: session.dates.filter(value => value !== date) })}>{date} ×</button>)}</div><p className="text-xs text-muted-foreground">Date ranges include weekends. The preview identifies dates that cannot be applied.</p></div>
          <label className="flex items-center gap-2 text-sm font-medium"><input type="checkbox" checked={session.customize} onChange={event => { if (!event.target.checked && JSON.stringify(session.definition) !== session.original && !window.confirm('Discard the changes made for this use?')) return; edit({ customize: event.target.checked, definition: copy(session.profile.definition) }); }} />Customize this use</label><p className="text-xs text-muted-foreground">Changes here belong to this application. The saved profile stays unchanged.</p>
        </>}
        {(session.mode === 'edit' || session.customize) && <DefinitionEditor definition={session.definition} onChange={definition => edit({ definition })} catalog={data} disabled={busy} />}
        {session.mode === 'apply' && session.customize && <div className="flex flex-wrap items-end gap-2 rounded-md bg-muted p-3"><label className="min-w-48 flex-1 space-y-1 text-sm"><span>Name for new profile</span><input className={inputClass} maxLength={80} value={newName} onChange={event => setNewName(event.target.value)} /></label><Button variant="outline" onClick={() => saveProfile(true)}>Save as new profile</Button><p className="w-full text-xs text-muted-foreground">Saves these settings as a separate draft. Select its dates from the profile list afterward.</p></div>}
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        {preview && <Preview key={preview.previewToken} preview={preview} catalog={data} />}
      </fieldset></div><fieldset disabled={busy} className="flex shrink-0 flex-wrap justify-end gap-2 border-t bg-background pt-3"><Button variant="outline" onClick={close}>Cancel</Button>{session.mode === 'edit' ? <Button onClick={() => saveProfile()}>{busy ? 'Saving…' : 'Save profile'}</Button> : <><Button variant="outline" onClick={review}>{busy ? 'Working…' : 'Preview application'}</Button>{preview && <Button disabled={!preview.previewToken || (preview.blockers || EMPTY).length > 0 || blockedByAdvancedDraft} onClick={apply}>Apply reviewed dates</Button>}</>}</fieldset></>}
    </DialogContent></Dialog>
  </CardContent></Card>;
}
