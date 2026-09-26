import { useDeferredValue, useEffect, useRef, useState } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, Download, LockKeyhole } from 'lucide-react';
import { Button } from '../../../components/ui/button';
import { Input } from '../../../components/ui/input';
import { ThemeToggle } from '../../../components/ThemeToggle';
import { useMyDeskAccess, useMyDeskCategories } from '../hooks/useMyDesk';
import { invalidateMyDesk, myDeskApi } from '../lib/myDesk';
import { myDeskError, myDeskKeys } from '../lib/myDeskModel';
import MyDeskTabs from '../components/MyDeskTabs';
import MyDeskStudentAction from '../components/MyDeskStudentAction';
import NoteComposerDialog from '../components/NoteComposerDialog';
import DisciplineStudentLinks from '../components/DisciplineStudentLinks';
import { NoteCard } from './MyDesk';
import '../myDesk.css';

export default function StudentLogs() {
  const access = useMyDeskAccess(); const { studentId } = useParams(); const navigate = useNavigate();
  return <div className="mydesk-page min-h-screen bg-background text-foreground">
    <header className="mydesk-header"><Button variant="ghost" onClick={() => navigate('/classpilot/my-desk')}><ArrowLeft className="size-4" />My Desk</Button><ThemeToggle /></header>
    <MyDeskTabs seatingEnabled={access.seatingEnabled} />
    {access.loading ? <p role="status" className="mydesk-access">Opening your student logs…</p> : !access.enabled ? <section className="mydesk-access"><h1>Student logs unavailable</h1><p>Your private notebook could not be opened.</p>{access.error && <Button onClick={access.refresh}>Try again</Button>}</section> : studentId ?
      <StudentHistory key={`${access.schoolId}:${access.viewerId}:${studentId}`} access={access} studentId={studentId} /> :
      <StudentDirectory key={`${access.schoolId}:${access.viewerId}`} access={access} />}
  </div>;
}

export function StudentDirectory({ access }) {
  const [search, setSearch] = useState(''); const q = useDeferredValue(search);
  const query = useInfiniteQuery({ queryKey: myDeskKeys.directory(access.schoolId, access.viewerId, q), initialPageParam: '',
    queryFn: ({ signal, pageParam }) => myDeskApi(access.schoolId, signal).students({ q, ...(pageParam ? { cursor: pageParam } : {}), limit: 50 }),
    getNextPageParam: page => page.nextCursor || undefined, retry: false });
  const rows = query.data?.pages.flatMap(page => page.students || []) || [];
  return <main className="mydesk-shell"><div className="mydesk-intro"><div><h1>Student logs</h1><p>Every student in your authorized current class rosters, including students without notes.</p><p className="mydesk-privacy"><LockKeyhole className="size-3.5" />Only your own notes appear here.</p></div></div>
    <label className="mydesk-search">Find a student<Input maxLength={200} value={search} onChange={event => setSearch(event.target.value)} placeholder="Student name" /></label>
    {query.isPending ? <p role="status">Loading students…</p> : query.isError ? <div role="alert"><p>{myDeskError(query.error)}</p><Button onClick={() => query.refetch()}>Try again</Button></div> : !rows.length ? <p className="mydesk-empty">No current roster students match.</p> :
      <div className="mydesk-note-list">{rows.map(student => <article className="mydesk-note" key={student.id}>
        <h2><Link to={`/classpilot/my-desk/students/${encodeURIComponent(student.id)}`}>{student.name}</Link></h2>
        <p>{student.classes.map(group => group.name).join(' · ')}</p><p>{student.noteCount} private {student.noteCount === 1 ? 'note' : 'notes'} across all years</p>
        <div className="mydesk-note-actions"><Button asChild variant="outline"><Link to={`/classpilot/my-desk/students/${encodeURIComponent(student.id)}`}>Open private history</Link></Button><MyDeskStudentAction access={access} student={student} /></div>
      </article>)}</div>}
    {query.hasNextPage && <Button variant="outline" disabled={query.isFetchingNextPage} onClick={() => query.fetchNextPage()}>Load more students</Button>}
  </main>;
}

export function StudentHistory({ access, studentId }) {
  const navigate = useNavigate(); const { schoolId, viewerId } = access;
  const [filters, setFilters] = useState({ q: '', category: '', classId: '', from: '', to: '' }); const deferred = useDeferredValue(filters.q);
  const requestFilters = { ...filters, q: deferred }; const categories = useMyDeskCategories(schoolId, viewerId);
  const [composer, setComposer] = useState(null), [error, setError] = useState(''), [busyId, setBusyId] = useState(null);
  const lifetime = useRef(null), working = useRef(false);
  useEffect(() => { const controller = new AbortController(); lifetime.current = controller; return () => controller.abort(); }, []);
  const query = useInfiniteQuery({ queryKey: myDeskKeys.history(schoolId, viewerId, studentId, requestFilters), initialPageParam: '',
    queryFn: ({ signal, pageParam }) => myDeskApi(schoolId, signal).studentHistory(studentId, { ...requestFilters, cursor: pageParam, limit: 30 }),
    getNextPageParam: page => page.nextCursor || undefined, retry: false });
  const rows = query.data?.pages.flatMap(page => page.notes || []) || [];
  const student = query.isError && [401, 403, 404].includes(query.error?.response?.status) ? undefined : query.data?.pages[0]?.student; const categoryList = categories.data?.categories || [];
  const mutate = async (note, remove = false) => {
    const controller = lifetime.current; if (working.current || !controller || controller.signal.aborted) return;
    if (remove && !window.confirm('Delete this private note and its attachments?')) return;
    working.current = true; setBusyId(note.id); setError('');
    try { const api = myDeskApi(schoolId, controller.signal); if (remove) await api.remove(note.id, note.revision); else await api.update(note.id, { revision: note.revision, pinned: !note.pinned });
      controller.signal.throwIfAborted(); await invalidateMyDesk(schoolId, viewerId); }
    catch (failure) { if (!controller.signal.aborted) setError(myDeskError(failure)); }
    finally { working.current = false; if (!controller.signal.aborted) setBusyId(null); }
  };
  const exportHistory = async () => {
    const controller = lifetime.current; if (working.current || !controller || controller.signal.aborted) return;
    working.current = true; setBusyId('export'); setError('');
    try { const blob = await myDeskApi(schoolId, controller.signal).exportStudentHistory(studentId, filters); controller.signal.throwIfAborted();
      const url = URL.createObjectURL(blob), anchor = document.createElement('a');
      try { anchor.href = url; anchor.download = 'private-student-history.csv'; document.body.appendChild(anchor); anchor.click(); }
      finally { anchor.remove(); URL.revokeObjectURL(url); }
    } catch (failure) { if (!controller.signal.aborted) setError(myDeskError(failure)); }
    finally { working.current = false; if (!controller.signal.aborted) setBusyId(null); }
  };
  return <main className="mydesk-shell"><Button asChild variant="ghost"><Link to="/classpilot/my-desk/students"><ArrowLeft className="size-4" />Student directory</Link></Button>
    <div className="mydesk-intro"><div><h1>{student?.name || 'Student history'}</h1><p>Your private notes across current and past classes and school years. Each note keeps its saved class and student labels.</p><p className="mydesk-privacy"><LockKeyhole className="size-3.5" />Only your own notes.</p></div><div className="mydesk-note-actions">{student?.current && <MyDeskStudentAction access={access} student={{ id: student.id, name: student.name }} />}<Button variant="outline" disabled={!!busyId || !student} onClick={exportHistory}><Download className="size-4" />Export CSV</Button></div></div>
    <div className="mydesk-filters"><label>Search notes<Input maxLength={200} value={filters.q} onChange={event => setFilters(value => ({ ...value, q: event.target.value }))} /></label>
      <label>Category<select aria-label="Category" value={filters.category} onChange={event => setFilters(value => ({ ...value, category: event.target.value }))}><option value="">All categories</option>{categoryList.map(item => <option key={item.key} value={item.key}>{item.label}</option>)}</select></label>
      <label>Class<select aria-label="History class" value={filters.classId} onChange={event => setFilters(value => ({ ...value, classId: event.target.value }))}><option value="">All current and past classes</option>{(student?.classes || []).map(group => <option key={group.id} value={group.id}>{group.name}</option>)}</select></label>
      <label>From<Input type="date" value={filters.from} onChange={event => setFilters(value => ({ ...value, from: event.target.value }))} /></label>
      <label>To<Input type="date" value={filters.to} onChange={event => setFilters(value => ({ ...value, to: event.target.value }))} /></label>
    </div>
    {error && <p role="alert" className="mydesk-error">{error}</p>}
    {query.isPending ? <p role="status">Loading private history…</p> : query.isError ? <div role="alert"><p>{myDeskError(query.error)}</p><Button onClick={() => query.refetch()}>Try again</Button></div> : !rows.length ? <p className="mydesk-empty">No private notes match these filters.</p> : <div className="mydesk-note-list">{rows.map(note => <NoteCard key={note.id} note={note} access={access} schoolId={schoolId} viewerId={viewerId} categories={categoryList} timeZone={access.school?.timezone} busy={busyId === note.id}
      onEdit={() => setComposer({ sessionId: crypto.randomUUID(), note })} onPin={() => mutate(note)} onDelete={() => mutate(note, true)}
      onImport={access.importsEnabled ? (groupId, source) => navigate('/classpilot/my-desk/imports', { state: { groupId, source } }) : undefined} />)}</div>}
    {query.hasNextPage && <Button variant="outline" disabled={query.isFetchingNextPage} onClick={() => query.fetchNextPage()}>Load more notes</Button>}
    {student && <DisciplineStudentLinks access={access} studentId={studentId} />}
    {student && composer && <NoteComposerDialog key={composer.sessionId} {...composer} open schoolId={schoolId} viewerId={viewerId} today={access.schoolDate} timeZone={access.school?.timezone} onOpenChange={open => { if (!open) setComposer(null); }} />}
  </main>;
}
