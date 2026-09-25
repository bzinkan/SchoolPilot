import { useEffect, useRef, useState } from 'react';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, Armchair, Copy, Plus, Trash2, LockKeyhole } from 'lucide-react';
import { Button } from '../../../components/ui/button';
import { Input } from '../../../components/ui/input';
import { ThemeToggle } from '../../../components/ThemeToggle';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../../../components/ui/dialog';
import { AlertDialog, AlertDialogContent, AlertDialogDescription, AlertDialogHeader, AlertDialogTitle, AlertDialogFooter, AlertDialogCancel, AlertDialogAction } from '../../../components/ui/alert-dialog';
import { useMyDeskAccess, useMyDeskClasses, useMyDeskStudents } from '../hooks/useMyDesk';
import { myDeskApi, invalidateMyDesk } from '../lib/myDesk';
import { myDeskKeys, myDeskError } from '../lib/myDeskModel';
import { createLayout, MAX_SEATS } from '../lib/seatingModel';
import { guardPrivateWorkspaceHistory } from '../lib/privateWorkspaceNavigation';
import MyDeskTabs from '../components/MyDeskTabs';
import SeatingEditor from '../components/SeatingEditor';
import '../myDesk.css';
import '../seating.css';

export function SeatingShell({ children, onNavigate }) {
  const navigate = useNavigate(); const go = onNavigate || navigate;
  return <div className="mydesk-page seating-page min-h-screen"><header className="mydesk-header"><Button variant="ghost" onClick={() => go('/classpilot')}><ArrowLeft className="size-4" />ClassPilot</Button><ThemeToggle /></header><MyDeskTabs seatingEnabled onNavigate={go} />{children}</div>;
}

export default function Seating() {
  const access = useMyDeskAccess(); const { chartId } = useParams();
  if (!access.seatingEnabled) return <div className="mydesk-page min-h-screen"><section className="mydesk-access"><h1>{access.loading ? 'Opening seating charts…' : 'Seating charts are unavailable'}</h1><p>{access.loading ? 'Loading your private workspace.' : 'Seating charts are not enabled for this account and school.'}</p></section></div>;
  return chartId ? <ChartLoader key={`${access.schoolId}:${access.viewerId}:${chartId}`} access={access} chartId={chartId} /> : <SeatingLibrary key={`${access.schoolId}:${access.viewerId}`} access={access} />;
}

function ChartLoader({ access, chartId }) {
  const query = useQuery({ queryKey: myDeskKeys.seatingChart(access.schoolId, access.viewerId, chartId), queryFn: ({ signal }) => myDeskApi(access.schoolId, signal).seatingChart(chartId), retry: false });
  if (query.isPending) return <SeatingShell><p className="mydesk-access" role="status">Opening your chart…</p></SeatingShell>;
  if (query.isError && (!query.data || [401, 403, 404].includes(query.error?.response?.status))) return <SeatingShell><section className="mydesk-access" role="alert"><h1>Chart unavailable</h1><p>{myDeskError(query.error)}</p><Button onClick={() => query.refetch()}>Try again</Button></section></SeatingShell>;
  return <SeatingEditor key={chartId} access={access} initialChart={query.data.chart} Shell={SeatingShell} ChartForm={SeatingChartForm} />;
}

export function SeatingLibrary({ access }) {
  const { schoolId, viewerId } = access; const navigate = useNavigate();
  const [scope, setScope] = useState('current'); const [classId, setClassId] = useState('');
  const [form, setForm] = useState(null); const [deleting, setDeleting] = useState(null);
  const [pending, setPending] = useState(null); const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const actionLocked = busy || Boolean(pending);
  const lifetime = useRef(null); const working = useRef(false);
  useEffect(() => { const controller = new AbortController(); lifetime.current = controller; return () => controller.abort(); }, []);
  const classes = useMyDeskClasses(schoolId, viewerId);
  const filters = { scope, classId };
  const charts = useInfiniteQuery({ queryKey: myDeskKeys.seatingCharts(schoolId, viewerId, filters), initialPageParam: '', queryFn: ({ signal, pageParam }) => myDeskApi(schoolId, signal).seatingCharts({ ...filters, cursor: pageParam, limit: 30 }), getNextPageParam: page => page.nextCursor || undefined, retry: false });
  const rows = charts.data?.pages.flatMap(page => page.charts) || [];
  const mutate = async (chart, action, previous) => {
    const controller = lifetime.current; if (working.current || (pending && !previous) || !controller || controller.signal.aborted) return;
    const operation = previous || { chart, action, payload: { requestId: crypto.randomUUID(), revision: chart.revision } };
    working.current = true; setBusy(true); setError(''); setPending(operation);
    try {
      const api = myDeskApi(schoolId, controller.signal);
      if (action === 'delete') await api.deleteSeatingChart(chart.id, operation.payload); else await api.currentSeatingChart(chart.id, operation.payload);
      controller.signal.throwIfAborted(); await invalidateMyDesk(schoolId, viewerId); controller.signal.throwIfAborted(); setPending(null); setDeleting(null);
    } catch (failure) { if (!controller.signal.aborted) setError(myDeskError(failure)); }
    finally { working.current = false; if (!controller.signal.aborted) setBusy(false); }
  };
  return <SeatingShell><main className="mydesk-shell seating-library">
    <div className="mydesk-intro"><div><div className="mydesk-title-line"><Armchair /><h1>Seating charts</h1></div><p>A place for everyone.</p><p className="mydesk-privacy"><LockKeyhole className="size-3.5" />Only you can see your charts.</p></div><Button disabled={actionLocked} onClick={() => setForm({ mode: 'new', sessionId: crypto.randomUUID() })}><Plus className="size-4" />New chart</Button></div>
    <div className="seating-library-filters"><div className="seating-scope"><Button variant={scope === 'current' ? 'default' : 'outline'} aria-pressed={scope === 'current'} onClick={() => { setScope('current'); setClassId(''); }}>Current classes</Button><Button variant={scope === 'past' ? 'default' : 'outline'} aria-pressed={scope === 'past'} onClick={() => { setScope('past'); setClassId(''); }}>Past classes</Button></div><label>Class<select aria-label="Filter class" value={classId} onChange={event => setClassId(event.target.value)}><option value="">All classes</option>{(classes.data?.[scope] || []).map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label></div>
    {error && <div role="alert" className="seating-error"><p>{error}</p>{pending && <Button variant="outline" disabled={busy} onClick={() => mutate(pending.chart, pending.action, pending)}>Retry {pending.action === 'delete' ? 'delete' : 'make current'}</Button>}<Button variant="ghost" disabled={busy} onClick={() => { setPending(null); setError(''); charts.refetch(); }}>Refresh charts</Button></div>}
    {charts.isPending ? <p role="status">Loading charts…</p> : charts.isError ? <div role="alert"><p>{myDeskError(charts.error)}</p><Button onClick={() => charts.refetch()}>Try again</Button></div> : !rows.length ? <section className="mydesk-empty"><Armchair className="size-8" /><h2>{scope === 'past' ? 'No past charts here yet.' : 'Set up your classroom.'}</h2><p>{scope === 'past' ? 'Your saved charts stay available after a class changes.' : 'Start with rows, pairs, groups, or a blank room. Arrange names when you are ready.'}</p></section> : <div className="seating-chart-list">{rows.map(chart => <article key={chart.id} className="seating-chart-card" aria-label={chart.name}><div className="seating-card-heading"><div><p>{chart.className}</p><h2><button disabled={actionLocked} onClick={() => navigate(`/classpilot/my-desk/seating/${chart.id}`)}>{chart.name}</button></h2></div>{chart.isCurrent && <span className="seating-current">Current</span>}</div><p className="seating-card-meta">Updated <time dateTime={chart.updatedAt}>{new Date(chart.updatedAt).toLocaleDateString('en-US', { timeZone: access.school?.timezone || 'America/New_York', month: 'short', day: 'numeric', year: 'numeric' })}</time></p><div className="seating-card-actions"><Button variant="outline" disabled={actionLocked} onClick={() => navigate(`/classpilot/my-desk/seating/${chart.id}`)}>{chart.canEdit ? 'Open chart' : 'View chart'}</Button>{chart.canEdit && !chart.isCurrent && <Button variant="ghost" disabled={actionLocked} onClick={() => mutate(chart, 'current')}>Make current</Button>}{chart.canEdit && <Button variant="ghost" disabled={actionLocked} onClick={() => setForm({ mode: 'chart', source: chart, sessionId: crypto.randomUUID() })}><Copy className="size-4" />Duplicate</Button>}<Button variant="ghost" disabled={actionLocked} onClick={() => setForm({ mode: 'layout', source: chart, sessionId: crypto.randomUUID() })}>Reuse layout</Button><Button variant="ghost" disabled={actionLocked} onClick={() => setDeleting(chart)}><Trash2 className="size-4" />Delete</Button></div></article>)}</div>}
    {charts.hasNextPage && <Button className="mydesk-load-more" disabled={charts.isFetchingNextPage} onClick={() => charts.fetchNextPage()}>Load more charts</Button>}
    {form && <SeatingChartForm key={form.sessionId} access={access} {...form} onClose={() => setForm(null)} onSaved={chart => navigate(`/classpilot/my-desk/seating/${chart.id}`)} />}
    <AlertDialog open={Boolean(deleting)} onOpenChange={open => { if (!open && !busy) setDeleting(null); }}><AlertDialogContent><AlertDialogHeader><AlertDialogTitle>Delete this seating chart?</AlertDialogTitle><AlertDialogDescription>{deleting?.isCurrent ? 'This is your current chart. Deleting it leaves this class without a current chart.' : 'This chart will be removed from your private workspace.'}</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel disabled={busy}>Keep chart</AlertDialogCancel><AlertDialogAction disabled={busy} onClick={event => { event.preventDefault(); mutate(deleting, 'delete', pending?.action === 'delete' && pending.chart.id === deleting.id ? pending : undefined); }}>{busy ? 'Deleting…' : 'Delete chart'}</AlertDialogAction></AlertDialogFooter></AlertDialogContent></AlertDialog>
  </main></SeatingShell>;
}

export function SeatingChartForm({ access, mode, source, onClose, onSaved, initialDraft, onLeave }) {
  const navigate = useNavigate();
  const { schoolId, viewerId } = access;
  const [classId, setClassId] = useState(mode === 'chart' ? source?.classId || '' : '');
  const [name, setName] = useState(source ? `${source.name} copy`.slice(0, 120) : '');
  const [sourceRevision, setSourceRevision] = useState(source?.revision);
  const [dirty, setDirty] = useState(false); const [discard, setDiscard] = useState(false); const [conflict, setConflict] = useState(false);
  const [leaveTo, setLeaveTo] = useState(null);
  const [preset, setPreset] = useState('rows'); const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const [retrying, setRetrying] = useState(false);
  const transaction = useRef(null); const lifetime = useRef(null); const working = useRef(false);
  useEffect(() => { const controller = new AbortController(); lifetime.current = controller; return () => controller.abort(); }, []);
  useEffect(() => { if (!dirty && !busy && !retrying) return; const warn = event => { event.preventDefault(); event.returnValue = ''; }; window.addEventListener('beforeunload', warn); return () => window.removeEventListener('beforeunload', warn); }, [dirty, busy, retrying]);
  useEffect(() => { if (!dirty && !busy && !retrying) return; return guardPrivateWorkspaceHistory(path => { setLeaveTo(path); setDiscard(true); }); }, [dirty, busy, retrying]);
  const classes = useMyDeskClasses(schoolId, viewerId); const students = useMyDeskStudents(schoolId, viewerId, classId, { refetchOnMount: 'always' });
  const requestClose = () => { if (!busy) { if (dirty || retrying) setDiscard(true); else onClose(); } };
  const refresh = async () => {
    const controller = lifetime.current; if (!controller || controller.signal.aborted) return;
    setBusy(true);
    try { if (source) { const result = await myDeskApi(schoolId, controller.signal).seatingChart(source.id); controller.signal.throwIfAborted(); setSourceRevision(result.chart.revision); } await students.refetch(); controller.signal.throwIfAborted(); setConflict(false); setError(''); }
    catch (failure) { if (!controller.signal.aborted) setError(myDeskError(failure)); }
    finally { if (!controller.signal.aborted) setBusy(false); }
  };
  const save = async event => {
    event.preventDefault(); const controller = lifetime.current; if (working.current || !controller || controller.signal.aborted) return;
    working.current = true; setBusy(true); setError('');
    try {
      if (!transaction.current) {
        if (!name.trim() || !classId || !students.data?.rosterRevision) throw new Error('Choose a class and enter a chart name.');
        const rosterRevision = initialDraft?.rosterRevision || students.data.rosterRevision;
        transaction.current = mode === 'new' || initialDraft ? { kind: 'create', payload: { clientRequestId: crypto.randomUUID(), classId, name: name.trim(), layout: initialDraft?.layout || createLayout(preset, students.data.students.length), rosterRevision } } : { kind: 'duplicate', payload: { clientRequestId: crypto.randomUUID(), sourceRevision, targetClassId: classId, mode, name: name.trim(), rosterRevision } };
      }
      const tx = transaction.current; const api = myDeskApi(schoolId, controller.signal);
      const result = tx.kind === 'create' ? await api.createSeatingChart(tx.payload) : await api.duplicateSeatingChart(source.id, tx.payload);
      controller.signal.throwIfAborted(); await invalidateMyDesk(schoolId, viewerId); controller.signal.throwIfAborted(); onSaved(result.chart);
    } catch (failure) { if (!controller.signal.aborted) { setError(myDeskError(failure)); if (failure.response?.status >= 400 && failure.response?.status < 500) { transaction.current = null; setRetrying(false); setConflict(failure.response.status === 409); } else setRetrying(Boolean(transaction.current)); } }
    finally { working.current = false; if (!controller.signal.aborted) setBusy(false); }
  };
  return <><Dialog open onOpenChange={open => { if (!open) requestClose(); }}><DialogContent className="seating-form"><DialogHeader><DialogTitle>{initialDraft ? 'Save draft as a new chart' : mode === 'new' ? 'New seating chart' : mode === 'chart' ? 'Duplicate chart' : 'Reuse an empty layout'}</DialogTitle><DialogDescription>{mode === 'layout' ? 'Desk positions are copied. Student assignments and locks are cleared.' : 'This chart is private to you.'}</DialogDescription></DialogHeader><form onSubmit={save} onChange={() => setDirty(true)}><fieldset disabled={busy || retrying}><label>Class<select aria-label="Class" value={classId} disabled={mode === 'chart' || Boolean(initialDraft)} onChange={event => setClassId(event.target.value)}><option value="">Choose a class</option>{(classes.data?.current || []).map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label><label>Chart name<Input aria-label="Chart name" value={name} maxLength={120} onChange={event => setName(event.target.value)} required /></label>{mode === 'new' && !initialDraft && <label>Starting layout<select aria-label="Starting layout" value={preset} onChange={event => setPreset(event.target.value)}><option value="rows">Rows</option><option value="pairs">Pairs</option><option value="groups">Groups</option><option value="blank">Blank room</option></select></label>}{classId && students.isPending && <p role="status">Loading class roster…</p>}{students.data?.students.length > MAX_SEATS && <p>A chart can have {MAX_SEATS} seats. Choose a blank room and add the desks you need.</p>}</fieldset>{(error || students.isError || classes.isError) && <p role="alert" className="mydesk-error">{error || 'Class options could not be loaded. Close and try again.'}</p>}{conflict && (initialDraft ? <Button type="button" variant="outline" onClick={onClose}>Return to draft</Button> : <Button type="button" variant="outline" disabled={busy} onClick={refresh}>Refresh source and roster</Button>)}<div className="seating-dialog-actions"><Button type="button" variant="ghost" disabled={busy} onClick={requestClose}>Cancel</Button><Button type="submit" disabled={busy || conflict || students.isPending || students.isError}>{busy ? 'Saving…' : retrying ? 'Retry save' : 'Create chart'}</Button></div></form></DialogContent></Dialog><AlertDialog open={discard} onOpenChange={setDiscard}><AlertDialogContent><AlertDialogHeader><AlertDialogTitle>Discard this chart setup?</AlertDialogTitle><AlertDialogDescription>Your unsaved setup will be cleared. If a save response was interrupted, any chart already saved will remain in your library.</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel>Keep editing</AlertDialogCancel><AlertDialogAction onClick={() => { void invalidateMyDesk(schoolId, viewerId); onClose(); if (leaveTo) (onLeave || navigate)(leaveTo); }}>Discard setup</AlertDialogAction></AlertDialogFooter></AlertDialogContent></AlertDialog></>;
}
