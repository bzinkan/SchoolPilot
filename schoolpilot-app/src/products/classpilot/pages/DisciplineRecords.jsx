import { useDeferredValue, useRef, useState } from 'react';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { ArrowLeft, Download, FileText, Printer } from 'lucide-react';
import { Button } from '../../../components/ui/button';
import { Input } from '../../../components/ui/input';
import { ThemeToggle } from '../../../components/ThemeToggle';
import { queryClient } from '../../../lib/queryClient';
import { useDisciplineAccess, useDisciplineLifetime } from '../hooks/useDiscipline';
import { disciplineApi, disciplineKeys, disciplineCategory, disciplineStatus, downloadDisciplineExport, invalidateDiscipline } from '../lib/discipline';
import { myDeskError } from '../lib/myDeskModel';
import DisciplineAttachment from '../components/DisciplineAttachment';
import DisciplineCorrection from '../components/DisciplineCorrection';
import '../myDesk.css';
import '../discipline.css';

export function DisciplineShell({ children }) {
  const navigate = useNavigate();
  return <div className="mydesk-page discipline-page min-h-screen bg-background text-foreground"><header className="mydesk-header discipline-no-print"><Button variant="ghost" onClick={() => navigate('/classpilot/my-desk')}><ArrowLeft className="size-4" />My Desk</Button><Link to="/classpilot">ClassPilot</Link><ThemeToggle /></header>{children}</div>;
}

export default function DisciplineRecords() {
  const access = useDisciplineAccess(); const { recordId } = useParams();
  if (access.loading) return <DisciplineShell><p className="mydesk-access" role="status">Opening discipline records…</p></DisciplineShell>;
  if (!access.ready) return <DisciplineShell><section className="mydesk-access"><h1>Discipline records unavailable</h1><p>{access.error ? myDeskError(access.error) : 'Sign in with your own eligible school account.'}</p>{access.error && <Button onClick={access.refresh}>Try again</Button>}</section></DisciplineShell>;
  return <DisciplineShell>{recordId ? <RecordLoader key={`${access.schoolId}:${access.viewerId}:${recordId}`} access={access} recordId={recordId} /> : <DisciplineLibrary key={`${access.schoolId}:${access.viewerId}`} access={access} />}</DisciplineShell>;
}

export function DisciplineLibrary({ access }) {
  // Grant changes cancel school exports and discard the previously authorized school view.
  return <DisciplineLibrarySession key={`${access.schoolId}:${access.viewerId}:${access.capabilities.canViewSchool ? 'school' : 'own'}`} access={access} />;
}

function DisciplineLibrarySession({ access }) {
  const { schoolId, viewerId } = access; const [params] = useSearchParams();
  const [filters, setFilters] = useState({ scope: access.capabilities.canViewSchool ? 'school' : 'own', status: 'submitted', studentId: params.get('studentId') || '', studentName: '', submitterName: '', category: '', from: '', to: '', q: '' });
  const deferred = useDeferredValue(filters);
  const compact = value => Object.fromEntries(Object.entries(value).filter(([, item]) => item !== '' && item != null));
  const request = compact({ ...deferred, scope: access.capabilities.canViewSchool ? deferred.scope : 'own' });
  const query = useInfiniteQuery({ queryKey: disciplineKeys.records(schoolId, viewerId, request), initialPageParam: '',
    queryFn: ({ signal, pageParam }) => disciplineApi(schoolId, signal).search({ ...request, limit: 30, ...(pageParam ? { cursor: pageParam } : {}) }),
    getNextPageParam: page => page.nextCursor || undefined, retry: false, gcTime: 0 });
  const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const working = useRef(false);
  const lifetime = useDisciplineLifetime(schoolId, viewerId);
  const change = (key, value) => setFilters(previous => ({ ...previous, [key]: value }));
  const rows = query.isError ? [] : query.data?.pages.flatMap(page => page.records) || [];
  const exportRecords = async () => {
    if (working.current || !lifetime.current || lifetime.current.signal.aborted) return;
    const controller = lifetime.current; working.current = true; setBusy(true); setError('');
    try { const blob = await disciplineApi(schoolId, controller.signal).export(compact({ ...filters, scope: access.capabilities.canViewSchool ? filters.scope : 'own' })); controller.signal.throwIfAborted(); downloadDisciplineExport(blob); }
    catch (failure) { if (!controller.signal.aborted) setError(myDeskError(failure)); }
    finally { working.current = false; if (!controller.signal.aborted) setBusy(false); }
  };
  return <main className="mydesk-shell discipline-library"><div className="mydesk-intro"><div><div className="mydesk-title-line"><FileText /><h1>Discipline records</h1></div><p>Entries teachers have explicitly submitted to the school log.</p><p className="mydesk-privacy">Private notes and unsent drafts are never included.</p></div><Button variant="outline" disabled={busy || query.isPending || query.isError} onClick={exportRecords}><Download className="size-4" />{busy ? 'Exporting…' : 'Export filtered CSV'}</Button></div>
    <div className="discipline-filters">
      <label>Records<select aria-label="Records" value={access.capabilities.canViewSchool ? filters.scope : 'own'} onChange={event => change('scope', event.target.value)}><option value="own">My submissions</option>{access.capabilities.canViewSchool && <option value="school">School submissions</option>}</select></label>
      <label>Student name<Input value={filters.studentName} onChange={event => { change('studentName', event.target.value); if (filters.studentId) change('studentId', ''); }} /></label>
      <label>Submitting teacher<Input value={filters.submitterName} onChange={event => change('submitterName', event.target.value)} /></label>
      <label>Category<select aria-label="Category" value={filters.category} onChange={event => change('category', event.target.value)}><option value="">All categories</option>{['note','detention','referral','uniform','positive','parent_contact','other'].map(key => <option key={key} value={key}>{disciplineCategory(key)}</option>)}</select></label>
      <label>From<Input type="date" value={filters.from} onChange={event => change('from', event.target.value)} /></label><label>To<Input type="date" value={filters.to} onChange={event => change('to', event.target.value)} /></label>
      <label>Status<select aria-label="Status" value={filters.status} onChange={event => change('status', event.target.value)}><option value="submitted">Active submissions</option><option value="withdrawn">Withdrawn submissions</option><option value="all">Active and withdrawn</option></select></label>
      <label>Search records<Input value={filters.q} onChange={event => change('q', event.target.value)} placeholder="Search titles and summaries" /></label>
    </div>
    {error && <p role="alert">{error}</p>}{query.isPending ? <p role="status">Loading submissions…</p> : query.isError ? <p role="alert">{myDeskError(query.error)} <Button onClick={() => query.refetch()}>Retry</Button></p> : !rows.length ? <section className="discipline-empty"><h2>No matching submissions</h2><p>Submit a reviewed student note from My Desk, or adjust these filters.</p><Link to="/classpilot/my-desk">Open private notes</Link></section> : <ol className="discipline-record-list">{rows.map(record => <li key={record.id}><Link to={`/classpilot/discipline-records/${record.id}`}><div><strong>{record.currentVersion.studentName}</strong><span>{record.currentVersion.className}</span></div><div><h2>{record.currentVersion.title || disciplineCategory(record.currentVersion.category)}</h2><p>{record.currentVersion.entryDate} · {disciplineCategory(record.currentVersion.category)}</p><p>Submitted by {record.submittedBy.name}</p></div><span className={`discipline-status discipline-status-${record.status}`}>{disciplineStatus(record.status)}</span></Link></li>)}</ol>}
    {query.hasNextPage && <Button variant="outline" disabled={query.isFetchingNextPage} onClick={() => query.fetchNextPage()}>{query.isFetchingNextPage ? 'Loading…' : 'More records'}</Button>}
  </main>;
}

export function RecordLoader({ access, recordId }) {
  const query = useQuery({ queryKey: disciplineKeys.record(access.schoolId, access.viewerId, recordId), queryFn: ({ signal }) => disciplineApi(access.schoolId, signal).record(recordId), retry: false, gcTime: 0, refetchOnMount: 'always' });
  if (query.isPending) return <p className="mydesk-access" role="status">Opening submitted record…</p>;
  if (query.isError && (!query.data || [401, 403, 404].includes(query.error?.response?.status))) return <section className="mydesk-access"><h1>Record unavailable</h1><p role="alert">{myDeskError(query.error)}</p><Button onClick={() => query.refetch()}>Retry</Button><Link to="/classpilot/discipline-records">All records</Link></section>;
  if (!access.capabilities.canViewSchool && query.data.record.submittedBy.id !== access.viewerId) return <section className="mydesk-access"><h1>Record unavailable</h1><p>Your school viewing permission is no longer active.</p><Link to="/classpilot/discipline-records">My submissions</Link></section>;
  return <DisciplineRecord access={access} record={query.data.record} />;
}

export function DisciplineRecord({ access, record }) {
  const { schoolId, viewerId } = access;
  const [history, setHistory] = useState(false); const [correction, setCorrection] = useState(null);
  const [withdraw, setWithdraw] = useState(false); const [reason, setReason] = useState(''); const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const [withdrawPending, setWithdrawPending] = useState(false); const [withdrawConflict, setWithdrawConflict] = useState(false);
  const transaction = useRef(null); const working = useRef(false); const lifetime = useDisciplineLifetime(schoolId, viewerId);
  const submitWithdrawal = async () => {
    if (working.current || withdrawConflict || !record.canWithdraw || !reason.trim() || !lifetime.current || lifetime.current.signal.aborted) return;
    const controller = lifetime.current;
    if (!transaction.current) transaction.current = { revision: record.revision, clientRequestId: crypto.randomUUID(), reason: reason.trim() };
    working.current = true; setBusy(true); setWithdrawPending(true); setError('');
    try { await disciplineApi(schoolId, controller.signal).withdraw(record.id, transaction.current); controller.signal.throwIfAborted(); await invalidateDiscipline(schoolId, viewerId); controller.signal.throwIfAborted(); setWithdraw(false); setReason(''); transaction.current = null; setWithdrawPending(false); }
    catch (failure) { if (!controller.signal.aborted) { setError(myDeskError(failure)); if (failure.response?.status >= 400 && failure.response?.status < 500) { transaction.current = null; setWithdrawPending(false); }
      if (failure.response?.data?.code === 'DISCIPLINE_REVISION_CONFLICT') setWithdrawConflict(true); } }
    finally { working.current = false; if (!controller.signal.aborted) setBusy(false); }
  };
  const refreshWithdrawal = async () => {
    const controller = lifetime.current; if (working.current || !controller || controller.signal.aborted) return;
    working.current = true; setBusy(true);
    try { const result = await disciplineApi(schoolId, controller.signal).record(record.id); controller.signal.throwIfAborted();
      queryClient.setQueryData(disciplineKeys.record(schoolId, viewerId, record.id), result);
      setWithdrawConflict(false); setError('Review the latest saved entry above before confirming withdrawal. Your reason is preserved.'); }
    catch (failure) { if (!controller.signal.aborted) setError(myDeskError(failure)); }
    finally { working.current = false; if (!controller.signal.aborted) setBusy(false); }
  };
  const historyQuery = useInfiniteQuery({ queryKey: [...disciplineKeys.record(schoolId, viewerId, record.id), 'versions', record.revision],
    initialPageParam: null, initialData: { pages: [{ record }], pageParams: [null] }, staleTime: Infinity,
    queryFn: ({ signal, pageParam }) => disciplineApi(schoolId, signal).record(record.id, pageParam),
    getNextPageParam: page => page.record.nextVersionsCursor || undefined, enabled: history, retry: false, gcTime: 0 });
  const historyVersions = [...new Map((historyQuery.data?.pages || [{ record }]).flatMap(page => page.record.versions).map(version => [version.id, version])).values()];
  const versions = history ? historyVersions.sort((a, b) => b.number - a.number) : [record.currentVersion];
  if (historyQuery.isError && [401, 403, 404].includes(historyQuery.error?.response?.status)) return <section role="alert"><h1>Record unavailable</h1><p>{myDeskError(historyQuery.error)}</p></section>;
  return <main className="mydesk-shell discipline-record"><div className="discipline-no-print"><Link to="/classpilot/discipline-records">All discipline records</Link></div>
    <div className="discipline-record-heading"><div><p>School discipline record</p><h1>{record.currentVersion.studentName}</h1><span className={`discipline-status discipline-status-${record.status}`}>{disciplineStatus(record.status)}</span><p>Submitted by {record.submittedBy.name}</p></div><Button className="discipline-no-print" variant="outline" onClick={() => window.print()}><Printer className="size-4" />Print record</Button></div>
    <p className="discipline-visibility">Visible to the submitting teacher and designated school administrators.</p>
    {record.status === 'withdrawn' && <p className="discipline-notice">This submission was withdrawn and is retained as history. It is not an active incident record.</p>}
    <div className="discipline-actions discipline-no-print">{record.canCorrect && <Button variant="outline" disabled={busy} onClick={() => setCorrection(crypto.randomUUID())}>Correct submission</Button>}{record.canWithdraw && <Button variant="outline" disabled={busy} onClick={() => setWithdraw(true)}>Withdraw submission</Button>}
      {(record.versions.length > 1 || record.nextVersionsCursor) && <Button variant="ghost" onClick={() => setHistory(value => !value)}>{history ? 'Show current version' : 'Show version history'}</Button>}</div>
    {versions.map(version => <RecordVersion key={version.id} access={access} record={record} version={version} />)}
    {history && historyQuery.isError && <p role="alert">{myDeskError(historyQuery.error)} <Button onClick={() => historyQuery.fetchNextPage()}>Retry history</Button></p>}
    {history && historyQuery.hasNextPage && <Button className="discipline-no-print" variant="outline" disabled={historyQuery.isFetchingNextPage} onClick={() => historyQuery.fetchNextPage()}>{historyQuery.isFetchingNextPage ? 'Loading history...' : 'Older versions'}</Button>}
    {withdraw && <section className="discipline-notice discipline-no-print" aria-label="Withdraw submission"><h2>Withdraw this submission?</h2><p>The school retains the original with your withdrawal reason. It will leave active results and exports.</p><label>Reason<textarea aria-label="Withdrawal reason" maxLength={2000} value={reason} disabled={busy || withdrawPending} onChange={event => setReason(event.target.value)} /></label>{withdrawConflict && <Button variant="outline" disabled={busy} onClick={refreshWithdrawal}>Review latest before withdrawal</Button>}<div className="discipline-actions"><Button variant="outline" disabled={busy || withdrawPending} onClick={() => { setWithdraw(false); setReason(''); setError(''); setWithdrawConflict(false); }}>Keep submission</Button><Button variant="destructive" disabled={busy || withdrawConflict || !record.canWithdraw || !reason.trim()} onClick={submitWithdrawal}>{busy ? 'Withdrawing…' : withdrawPending ? 'Retry withdrawal' : 'Confirm withdrawal'}</Button></div></section>}
    {error && <p role="alert">{error}</p>}
    {correction && <DisciplineCorrection key={`${schoolId}:${viewerId}:${record.id}:${correction}`} access={access} record={record} onClose={() => setCorrection(null)} />}
  </main>;
}

function RecordVersion({ access, record, version }) {
  const [showForms, setShowForms] = useState(false);
  const current = record.currentVersion.id === version.id;
  return <article className="discipline-version"><div className="discipline-version-title"><h2>{version.title || disciplineCategory(version.category)}</h2><span>{current ? disciplineStatus(record.status) : 'Superseded'} · Version {version.number}</span></div>
    <dl className="discipline-facts"><div><dt>Student</dt><dd>{version.studentName}</dd></div><div><dt>Class</dt><dd>{version.className}</dd></div><div><dt>Incident date</dt><dd>{version.entryDate}</dd></div><div><dt>Category</dt><dd>{disciplineCategory(version.category)}</dd></div><div><dt>Recorded</dt><dd>{new Date(version.createdAt).toLocaleString()}</dd></div></dl>
    {version.reason && <p className="discipline-notice"><strong>{version.kind === 'withdrawal' ? 'Withdrawal reason' : 'Correction reason'}:</strong> {version.reason}</p>}
    <p className="discipline-body">{version.body}</p>
    {version.attachments?.length > 0 && <><Button className="discipline-no-print" variant="outline" onClick={() => setShowForms(value => !value)}>{showForms ? 'Hide submitted forms' : `View submitted forms (${version.attachments.length})`}</Button>{showForms && <div className="discipline-evidence">{version.attachments.map(attachment => <DisciplineAttachment key={attachment.id} access={access} recordId={record.id} versionId={version.id} attachment={attachment} />)}</div>}<p className="discipline-print-only">{version.attachments.length} submitted forms retained with this version. Open the record to view or download them.</p></>}
  </article>;
}
