import { useDeferredValue, useRef, useState } from 'react';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { Download, FileText, Printer, Plus, FileScan } from 'lucide-react';
import { Button } from '../../../components/ui/button';
import { Input } from '../../../components/ui/input';
import { queryClient } from '../../../lib/queryClient';
import { useDisciplineAccess, useDisciplineLifetime } from '../hooks/useDiscipline';
import { disciplineApi, disciplineKeys, disciplineCategory, disciplineStatus, downloadDisciplineExport, invalidateDiscipline } from '../lib/discipline';
import { myDeskError } from '../lib/myDeskModel';
import DisciplineAttachment from '../components/DisciplineAttachment';
import DisciplineCorrection from '../components/DisciplineCorrection';
import DisciplineIncidentComposer from '../components/DisciplineIncidentComposer';
import MyDeskTabs from '../components/MyDeskTabs';
import MyDeskHeader from '../components/MyDeskHeader';
import MyDeskVisibility from '../components/MyDeskVisibility';
import MyDeskScopePicker from '../components/MyDeskScopePicker';
import { useMyDeskAccess, useMyDeskClasses } from '../hooks/useMyDesk';
import { disciplineParent, withDisciplineEntry } from '../lib/disciplineNavigation';
import { formatDeskDate } from '../lib/myDeskDates';
import { useAdminNavigation, useAdminNavigationBlocker, useAdminShell } from '../hooks/useAdminNavigation';
import '../myDesk.css';
import '../discipline.css';

export function DisciplineShell({ children }) {
  const { navigate } = useAdminNavigation(); const shell = useAdminShell(); const [params] = useSearchParams();
  // Discipline logs is a My Desk tab, so teachers leave to ClassPilot like every other tab.
  const adminOrigin = params.get('entry') === 'admin'; const parent = adminOrigin ? disciplineParent(params) : { path: '/classpilot', label: 'ClassPilot' };
  if (shell) return <div className="discipline-page">{children}</div>;
  return <div className="mydesk-page discipline-page min-h-screen bg-background text-foreground"><MyDeskHeader className="discipline-no-print" backLabel={parent.label} onBack={() => navigate(parent.path)} title={adminOrigin ? null : 'My Desk'} />{children}</div>;
}

export default function DisciplineRecords() {
  const sharedAccess = useDisciplineAccess(); const desk = useMyDeskAccess(); const access = { ...sharedAccess, importsEnabled: desk.importsEnabled, seatingEnabled: desk.seatingEnabled }; const { recordId } = useParams();
  if (access.loading) return <DisciplineShell><p className="mydesk-access" role="status">Opening discipline records…</p></DisciplineShell>;
  if (!access.ready) return <DisciplineShell><section className="mydesk-access"><h1>Discipline records unavailable</h1><p>{access.error ? myDeskError(access.error) : 'Sign in with your own eligible school account.'}</p>{access.error && <Button onClick={access.refresh}>Try again</Button>}</section></DisciplineShell>;
  return <DisciplineShell>{recordId ? <RecordLoader key={`${access.schoolId}:${access.viewerId}:${Boolean(access.capabilities.canViewSchool)}:${recordId}`} access={access} recordId={recordId} /> : <DisciplineLibrary key={`${access.schoolId}:${access.viewerId}`} access={access} />}</DisciplineShell>;
}

export function DisciplineLibrary({ access }) {
  return <DisciplineLibrarySession key={`${access.schoolId}:${access.viewerId}:${access.capabilities.canViewSchool ? 'school' : 'assigned'}`} access={access} />;
}
const compact = value => Object.fromEntries(Object.entries(value).filter(([, item]) => item !== '' && item != null));

function DisciplineLibrarySession({ access }) {
  const { schoolId, viewerId } = access; const [params, setParams] = useSearchParams(); const { navigate } = useAdminNavigation(); const shell = useAdminShell();
  const Heading = shell ? 'h2' : 'h1';
  const Content = shell ? 'section' : 'main';
  const adminEntry = access.capabilities.canViewSchool && params.get('entry') === 'admin';
  const scope = adminEntry ? 'school' : 'assigned';
  const studentId = params.get('studentId') || '';
  const classes = useMyDeskClasses(schoolId, viewerId);
  const [filters, setFilters] = useState({ gradeLevel: params.get('gradeLevel') || '', groupId: params.get('classId') || '', q: '', period: 'school_year', from: '', to: '', includeInactive: false, incidentType: '', submitterName: '' });
  const [composer, setComposer] = useState(null), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const working = useRef(false), lifetime = useDisciplineLifetime(schoolId, viewerId);
  const deferred = useDeferredValue(filters);
  const request = compact({ ...deferred, scope, ...(deferred.period !== 'custom' ? { from: '', to: '' } : {}) });
  const readyRange = deferred.period !== 'custom' || Boolean(deferred.from && deferred.to);
  const query = useInfiniteQuery({ queryKey: disciplineKeys.students(schoolId, viewerId, { ...request, studentId }), initialPageParam: '',
    queryFn: ({ signal, pageParam }) => studentId ? disciplineApi(schoolId, signal).studentHistory(studentId, compact({ ...request, cursor: pageParam })) : disciplineApi(schoolId, signal).students(compact({ ...request, cursor: pageParam })),
    getNextPageParam: page => page.nextCursor || undefined, enabled: readyRange, retry: false, staleTime: 0, gcTime: 0, refetchOnMount: 'always', refetchOnWindowFocus: 'always' });
  const rows = query.isError ? [] : query.data?.pages.flatMap(page => page.students || []) || [];
  const records = query.isError ? [] : query.data?.pages.flatMap(page => page.records || []) || [];
  const student = query.isError ? null : query.data?.pages[0]?.student;
  const range = query.isError ? null : query.data?.pages[0]?.range;
  const effectivePeriod = range && filters.period === deferred.period ? range.period : filters.period;
  const schoolYearIssue = range?.noticeCode === 'SCHOOL_YEAR_NOT_CONFIGURED' || range?.noticeCode === 'SCHOOL_YEAR_OUTSIDE_RANGE';
  const change = (key, value) => setFilters(previous => ({ ...previous, [key]: value }));
  const changeScope = value => { setFilters(previous => ({ ...previous, gradeLevel: value.gradeLevel, groupId: value.classId })); const next = new URLSearchParams(params); for (const key of ['gradeLevel', 'classId', 'studentId']) next.delete(key); if (value.gradeLevel) next.set('gradeLevel', value.gradeLevel); if (value.classId) next.set('classId', value.classId); setParams(next, { replace: true }); };
  const chooseStudent = id => { const next = new URLSearchParams(params); if (id) next.set('studentId', id); else next.delete('studentId'); setParams(next); };
  const exportRows = async () => {
    const controller = lifetime.current; if (working.current || !controller || controller.signal.aborted) return;
    working.current = true; setBusy(true); setError('');
    try {
      const api = disciplineApi(schoolId, controller.signal);
      const exportRange = range?.period === 'all' ? { period: 'all', from: '', to: '' } : range?.from && range?.to ? { period: 'custom', from: range.from, to: range.to } : {};
      const blob = studentId ? await api.export(compact({ scope, studentId, from: range?.from, to: range?.to, status: 'submitted', incidentType: request.incidentType, submitterName: request.submitterName })) : await api.exportStudents(compact({ ...request, ...exportRange }));
      controller.signal.throwIfAborted(); downloadDisciplineExport(blob);
    } catch (failure) { if (!controller.signal.aborted) setError(myDeskError(failure)); }
    finally { working.current = false; if (!controller.signal.aborted) setBusy(false); }
  };
  const gradeOptions = adminEntry ? [...new Set((classes.data?.current || []).map(group => group.gradeLevel || 'unrecorded'))].sort((a,b) => String(a).localeCompare(String(b), undefined, { numeric: true })) : [];
  return <>{!shell && !adminEntry && <MyDeskTabs seatingEnabled={access.seatingEnabled} />}<Content className="mydesk-shell discipline-library">
    {!shell && adminEntry && <Link to="/classpilot/admin">Admin Panel</Link>}
    <div className="mydesk-intro"><div><div className="mydesk-title-line"><FileText /><Heading>{student?.name || 'Discipline logs'}</Heading></div><p>{adminEntry ? 'School records, organized by student.' : 'School-recorded incidents for students you currently teach.'}</p><MyDeskVisibility kind="school">Visible to school administrators and teachers currently assigned to each student. Private notes and unfinished drafts are never included.</MyDeskVisibility></div><div className="discipline-actions"><Button variant="outline" disabled={!access.importsEnabled} title={!access.importsEnabled ? 'Paperwork processing is not enabled yet.' : undefined} onClick={() => navigate(withDisciplineEntry('/classpilot/my-desk/imports?destination=discipline', params), { state: { destination: 'discipline', groupId: filters.groupId, gradeLevel: filters.gradeLevel } })}><FileScan className="size-4" />Add from paperwork</Button><Button onClick={() => setComposer(crypto.randomUUID())}><Plus className="size-4" />Add incident</Button></div></div>
    {studentId && <Button variant="ghost" onClick={() => chooseStudent('')}>All students</Button>}
    {!studentId && (adminEntry ? <label>Grade<select aria-label="Grade filter" value={filters.gradeLevel} onChange={event => changeScope({ gradeLevel: event.target.value, classId: '' })}><option value="">All grades</option>{gradeOptions.map(grade => <option key={grade} value={grade}>{grade === 'unrecorded' ? 'Grade not recorded' : `Grade ${grade}`}</option>)}</select></label> : <MyDeskScopePicker classes={classes} schoolId={schoolId} viewerId={viewerId} value={{ gradeLevel: filters.gradeLevel, classId: filters.groupId }} onChange={changeScope} />)}
    <div className="discipline-filters">{!studentId && <label>Student search<Input value={filters.q} onChange={event => change('q', event.target.value)} placeholder="Find a student" /></label>}<label>Period<select aria-label="Period" value={effectivePeriod} onChange={event => change('period', event.target.value)}><option value="school_year">This school year</option><option value="all">All dates</option><option value="custom">Custom range</option></select></label>
      {filters.period === 'custom' && <><label>From<Input type="date" value={filters.from} onChange={event => change('from', event.target.value)} /></label><label>To<Input type="date" value={filters.to} onChange={event => change('to', event.target.value)} /></label></>}
      <label>Incident type<select aria-label="Incident type" value={filters.incidentType} onChange={event => change('incidentType', event.target.value)}><option value="">All incidents</option><option value="referral">Referrals</option><option value="detention">Detentions assigned</option></select></label>
      <label>Recording teacher<Input value={filters.submitterName} onChange={event => change('submitterName', event.target.value)} /></label>
    </div>
    {adminEntry && <details className="discipline-additional-filters"><summary>Additional filters</summary><label>Class<select value={filters.groupId} onChange={event => changeScope({ gradeLevel: filters.gradeLevel, classId: event.target.value })}><option value="">All classes</option>{(classes.data?.current || []).map(group => <option key={group.id} value={group.id}>{group.name}</option>)}</select></label><label className="discipline-check"><input type="checkbox" checked={filters.includeInactive} onChange={event => change('includeInactive', event.target.checked)} />Include former students with retained records</label></details>}
    {range?.notice && <div role="status" className="discipline-notice"><p>{range.notice}</p>{schoolYearIssue && <>
      {range.configuredSchoolYear && <p>Configured school year: {range.configuredSchoolYear.from} to {range.configuredSchoolYear.to}.</p>}
      {access.capabilities.canViewSchool ? <Link to="/classpilot/admin/classes/scheduling?section=bells">{range.noticeCode === 'SCHOOL_YEAR_NOT_CONFIGURED' ? 'Set school year dates' : 'Review school year dates'}</Link> : <p>Ask a school administrator to {range.noticeCode === 'SCHOOL_YEAR_NOT_CONFIGURED' ? 'set' : 'review'} the school year dates.</p>}
    </>}</div>}
    <div className="discipline-actions"><Button variant="outline" disabled={busy || query.isPending || query.isError || !readyRange} onClick={exportRows}><Download className="size-4" />{busy ? 'Exporting…' : studentId ? 'Export incidents CSV' : 'Export student summary CSV'}</Button></div>
    {error && <p role="alert">{error}</p>}
    {!readyRange ? <p>Choose both dates to view this period.</p> : query.isPending ? <p role="status">Loading students and incident totals…</p> : query.isError ? <p role="alert">{myDeskError(query.error)} <Button onClick={() => query.refetch()}>Retry</Button></p> : studentId ? <>
      {!records.length ? <section className="discipline-empty"><h2>No incidents in this period</h2><p>Use Add incident to record reviewed information.</p></section> : <ol className="discipline-record-list">{records.map(record => <li key={record.id}><Link to={withDisciplineEntry(`/classpilot/discipline-records/${encodeURIComponent(record.id)}`, params)}><div><h2>{record.currentVersion.title || disciplineCategory(record.currentVersion.category)}</h2><p>{formatDeskDate(record.currentVersion.entryDate)} · {record.currentVersion.className || (record.currentVersion.gradeLevel ? `Grade ${record.currentVersion.gradeLevel}` : 'Grade not recorded')}</p><p>Recorded by {record.submittedBy.name}</p></div><span>View information and forms</span></Link></li>)}</ol>}
    </> : !rows.length ? <section className="discipline-empty"><h2>No students match</h2><p>Adjust the filters or check your school-managed teaching assignments.</p></section> : <div className="discipline-summary-scroll"><table className="discipline-summary"><thead><tr><th>Student</th><th>Referrals</th><th>Detentions assigned</th><th>Latest incident</th></tr></thead><tbody>{rows.map(row => <tr key={row.id}><td><button onClick={() => chooseStudent(row.id)}>{row.name}</button><small>{row.gradeLevel ? `Grade ${row.gradeLevel}` : 'Grade not recorded'}{row.status !== 'active' ? ' · Former student' : ''}</small></td><td>{row.referralCount}</td><td>{row.detentionCount}</td><td>{row.latestIncident ? formatDeskDate(row.latestIncident) : 'No incidents'}</td></tr>)}</tbody></table></div>}
    {query.hasNextPage && <Button variant="outline" disabled={query.isFetchingNextPage} onClick={() => query.fetchNextPage()}>{query.isFetchingNextPage ? 'Loading…' : studentId ? 'More incidents' : 'More students'}</Button>}
    {composer && <DisciplineIncidentComposer key={`${schoolId}:${viewerId}:${scope}:${composer}`} access={access} scope={scope} selectedStudent={student} onClose={() => setComposer(null)} onSaved={async (id, committedNavigate) => { const accepted = await (committedNavigate || navigate)(withDisciplineEntry(`/classpilot/discipline-records/${encodeURIComponent(id)}`, params)); if (accepted !== false) setComposer(null); }} />}
  </Content></>;
}

export function RecordLoader({ access, recordId }) {
  const [params] = useSearchParams();
  const query = useQuery({ queryKey: disciplineKeys.record(access.schoolId, access.viewerId, recordId), queryFn: ({ signal }) => disciplineApi(access.schoolId, signal).record(recordId), retry: false, gcTime: 0, refetchOnMount: 'always' });
  if (query.isPending) return <p className="mydesk-access" role="status">Opening submitted record…</p>;
  if (query.isError && (!query.data || [401, 403, 404].includes(query.error?.response?.status))) return <section className="mydesk-access"><h1>Record unavailable</h1><p role="alert">{myDeskError(query.error)}</p><Button onClick={() => query.refetch()}>Retry</Button><Link to={withDisciplineEntry('/classpilot/discipline-records', params)}>All records</Link></section>;
  return <DisciplineRecord access={access} record={query.data.record} />;
}

export function DisciplineRecord({ access, record }) {
  const shell = useAdminShell();
  const Heading = shell ? 'h2' : 'h1';
  const Content = shell ? 'section' : 'main';
  const [params] = useSearchParams();
  const { schoolId, viewerId } = access;
  const [history, setHistory] = useState(false); const [correction, setCorrection] = useState(null);
  const [withdraw, setWithdraw] = useState(false); const [reason, setReason] = useState(''); const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const [withdrawPending, setWithdrawPending] = useState(false); const [withdrawConflict, setWithdrawConflict] = useState(false);
  const [denied, setDenied] = useState(false);
  const transaction = useRef(null); const working = useRef(false); const lifetime = useDisciplineLifetime(schoolId, viewerId);
  const { requestAction } = useAdminNavigation();
  useAdminNavigationBlocker({ id: `discipline-withdrawal:${record.id}`, dirty: withdraw && Boolean(reason || withdrawPending), busy,
    onDiscard: () => { setWithdraw(false); setReason(''); setWithdrawPending(false); transaction.current = null; } });
  const submitWithdrawal = async () => {
    if (working.current || withdrawConflict || !record.canWithdraw || !reason.trim() || !lifetime.current || lifetime.current.signal.aborted) return;
    const controller = lifetime.current;
    if (!transaction.current) transaction.current = { revision: record.revision, clientRequestId: crypto.randomUUID(), reason: reason.trim() };
    working.current = true; setBusy(true); setWithdrawPending(true); setError('');
    try { await disciplineApi(schoolId, controller.signal).withdraw(record.id, transaction.current); controller.signal.throwIfAborted(); await invalidateDiscipline(schoolId, viewerId); controller.signal.throwIfAborted(); setWithdraw(false); setReason(''); transaction.current = null; setWithdrawPending(false); }
    catch (failure) { if (!controller.signal.aborted) { setError(myDeskError(failure)); if (failure.response?.status >= 400 && failure.response?.status < 500) { transaction.current = null; setWithdrawPending(false); }
      if ([401, 403, 404].includes(failure.response?.status)) { setDenied(true); controller.abort(); void invalidateDiscipline(schoolId, viewerId); }
      if (failure.response?.data?.code === 'DISCIPLINE_REVISION_CONFLICT') setWithdrawConflict(true); } }
    finally { working.current = false; if (!controller.signal.aborted) setBusy(false); }
  };
  const refreshWithdrawal = async () => {
    const controller = lifetime.current; if (working.current || !controller || controller.signal.aborted) return;
    working.current = true; setBusy(true);
    try { const result = await disciplineApi(schoolId, controller.signal).record(record.id); controller.signal.throwIfAborted();
      queryClient.setQueryData(disciplineKeys.record(schoolId, viewerId, record.id), result);
      setWithdrawConflict(false); setError('Review the latest saved entry above before confirming withdrawal. Your reason is preserved.'); }
    catch (failure) { if (!controller.signal.aborted) { setError(myDeskError(failure)); if ([401, 403, 404].includes(failure.response?.status)) { setDenied(true); controller.abort(); } } }
    finally { working.current = false; if (!controller.signal.aborted) setBusy(false); }
  };
  const historyQuery = useInfiniteQuery({ queryKey: [...disciplineKeys.record(schoolId, viewerId, record.id), 'versions', record.revision],
    initialPageParam: null, initialData: { pages: [{ record }], pageParams: [null] }, staleTime: Infinity,
    queryFn: ({ signal, pageParam }) => disciplineApi(schoolId, signal).record(record.id, pageParam),
    getNextPageParam: page => page.record.nextVersionsCursor || undefined, enabled: history, retry: false, gcTime: 0 });
  const historyVersions = [...new Map((historyQuery.data?.pages || [{ record }]).flatMap(page => page.record.versions).map(version => [version.id, version])).values()];
  const versions = history ? historyVersions.sort((a, b) => b.number - a.number) : [record.currentVersion];
  if (denied || historyQuery.isError && [401, 403, 404].includes(historyQuery.error?.response?.status)) return <section role="alert"><h1>Record unavailable</h1><p>{myDeskError(historyQuery.error)}</p></section>;
  return <Content className="mydesk-shell discipline-record"><div className="discipline-no-print"><Link to={withDisciplineEntry('/classpilot/discipline-records', params)}>All discipline records</Link></div>
    <div className="discipline-record-heading"><div><p>School discipline record</p><Heading>{record.currentVersion.studentName}</Heading><span className={`discipline-status discipline-status-${record.status}`}>{disciplineStatus(record.status)}</span><p>Submitted by {record.submittedBy.name}</p></div><Button className="discipline-no-print" variant="outline" onClick={() => window.print()}><Printer className="size-4" />Print record</Button></div>
    <p className="discipline-visibility">Visible to school administrators and teachers currently assigned to this student.</p>
    {record.status === 'withdrawn' && <p className="discipline-notice">This submission was withdrawn and is retained as history. It is not an active incident record.</p>}
    <div className="discipline-actions discipline-no-print">{record.canCorrect && <Button variant="outline" disabled={busy} onClick={() => setCorrection(crypto.randomUUID())}>Correct submission</Button>}{record.canWithdraw && <Button variant="outline" disabled={busy} onClick={() => setWithdraw(true)}>Withdraw submission</Button>}
      {(record.versions.length > 1 || record.nextVersionsCursor) && <Button variant="ghost" onClick={() => setHistory(value => !value)}>{history ? 'Show current version' : 'Show version history'}</Button>}</div>
    {versions.map(version => <RecordVersion key={version.id} access={access} record={record} version={version} />)}
    {history && historyQuery.isError && <p role="alert">{myDeskError(historyQuery.error)} <Button onClick={() => historyQuery.fetchNextPage()}>Retry history</Button></p>}
    {history && historyQuery.hasNextPage && <Button className="discipline-no-print" variant="outline" disabled={historyQuery.isFetchingNextPage} onClick={() => historyQuery.fetchNextPage()}>{historyQuery.isFetchingNextPage ? 'Loading history...' : 'Older versions'}</Button>}
    {withdraw && <section className="discipline-notice discipline-no-print" aria-label="Withdraw submission"><h2>Withdraw this submission?</h2><p>The school retains the original with your withdrawal reason. It will leave active results and exports.</p><label>Reason<textarea aria-label="Withdrawal reason" maxLength={2000} value={reason} disabled={busy || withdrawPending} onChange={event => setReason(event.target.value)} /></label>{withdrawConflict && <Button variant="outline" disabled={busy} onClick={refreshWithdrawal}>Review latest before withdrawal</Button>}<div className="discipline-actions"><Button variant="outline" disabled={busy || withdrawPending} onClick={() => requestAction(() => { setWithdraw(false); setReason(''); setError(''); setWithdrawConflict(false); }, { id: 'discipline-withdrawal-close' })}>Keep submission</Button><Button variant="destructive" disabled={busy || withdrawConflict || !record.canWithdraw || !reason.trim()} onClick={submitWithdrawal}>{busy ? 'Withdrawing…' : withdrawPending ? 'Retry withdrawal' : 'Confirm withdrawal'}</Button></div></section>}
    {error && <p role="alert">{error}</p>}
    {correction && <DisciplineCorrection key={`${schoolId}:${viewerId}:${record.id}:${correction}`} access={access} record={record} onClose={() => setCorrection(null)} />}
  </Content>;
}

function RecordVersion({ access, record, version }) {
  const [showForms, setShowForms] = useState(false);
  const current = record.currentVersion.id === version.id;
  return <article className="discipline-version"><div className="discipline-version-title"><h2>{version.title || disciplineCategory(version.category)}</h2><span>{current ? disciplineStatus(record.status) : 'Superseded'} · Version {version.number}</span></div>
    <dl className="discipline-facts"><div><dt>Student</dt><dd>{version.studentName}</dd></div><div><dt>Class</dt><dd>{version.className || (version.gradeLevel ? `Grade ${version.gradeLevel}` : 'Grade not recorded')}</dd></div><div><dt>Incident date</dt><dd>{formatDeskDate(version.entryDate, { withYear: true })}</dd></div><div><dt>Category</dt><dd>{disciplineCategory(version.category)}</dd></div><div><dt>Recorded</dt><dd>{new Date(version.createdAt).toLocaleString()}</dd></div></dl>
    {version.reason && <p className="discipline-notice"><strong>{version.kind === 'withdrawal' ? 'Withdrawal reason' : 'Correction reason'}:</strong> {version.reason}</p>}
    <p className="discipline-body">{version.body}</p>{version.schemaVersion === 2 && <p>{version.referralRecorded ? 'One referral recorded. ' : ''}{version.detentionAssigned ? `One detention assignment${version.detentionDates?.length ? `: ${version.detentionDates.join(', ')}` : ''}.` : ''}</p>}
    {version.attachments?.length > 0 && <><Button className="discipline-no-print" variant="outline" onClick={() => setShowForms(value => !value)}>{showForms ? 'Hide submitted forms' : `View submitted forms (${version.attachments.length})`}</Button>{showForms && <div className="discipline-evidence">{version.attachments.map(attachment => <DisciplineAttachment key={attachment.id} access={access} recordId={record.id} versionId={version.id} attachment={attachment} />)}</div>}<p className="discipline-print-only">{version.attachments.length} submitted forms retained with this version. Open the record to view or download them.</p></>}
  </article>;
}
