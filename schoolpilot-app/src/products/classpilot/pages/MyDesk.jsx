import { useDeferredValue, useEffect, useRef, useState } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { ArrowLeft, BookOpen, LockKeyhole, NotebookPen, Plus, Search, Download, Pin, Paperclip, Pencil, Trash2 } from 'lucide-react';
import { Button } from '../../../components/ui/button';
import { Input } from '../../../components/ui/input';
import { ThemeToggle } from '../../../components/ThemeToggle';
import { AlertDialog, AlertDialogContent, AlertDialogHeader, AlertDialogTitle, AlertDialogDescription, AlertDialogFooter, AlertDialogCancel, AlertDialogAction } from '../../../components/ui/alert-dialog';
import { useMyDeskAccess, useMyDeskCategories, useMyDeskClasses, useMyDeskNoteStudents } from '../hooks/useMyDesk';
import { myDeskApi, invalidateMyDesk } from '../lib/myDesk';
import { myDeskError, isMyDeskNoteMissing, myDeskKeys, myDeskTarget } from '../lib/myDeskModel';
import NoteComposerDialog from '../components/NoteComposerDialog';
import MyDeskAttachment from '../components/MyDeskAttachment';
import MyDeskTabs from '../components/MyDeskTabs';
import MyDeskClassIndex from '../components/MyDeskClassIndex';
import DisciplineSubmitButton from '../components/DisciplineSubmitButton';
import '../myDesk.css';

export default function MyDesk() {
  const access = useMyDeskAccess();
  const navigate = useNavigate(); const [searchParams] = useSearchParams();
  return <div className="mydesk-page min-h-screen bg-background text-foreground">
    <header className="mydesk-header"><Button variant="ghost" onClick={() => navigate('/classpilot')}><ArrowLeft className="size-4" />ClassPilot</Button><ThemeToggle /></header>
    <MyDeskTabs seatingEnabled={access.seatingEnabled} />
    {access.loading ? <p className="mydesk-access" role="status">Opening your desk…</p> : access.enabled ? <MyDeskNotebook key={`${access.schoolId}:${access.viewerId}`} access={access} schoolId={access.schoolId} viewerId={access.viewerId} today={access.schoolDate} timeZone={access.school?.timezone} initialNoteId={searchParams.get('note')} onImport={access.importsEnabled ? (groupId, source) => navigate('/classpilot/my-desk/imports', { state: { groupId, source } }) : undefined} /> : <section className="mydesk-access"><LockKeyhole className="size-7 mb-4" aria-hidden="true" /><h1>My Desk is unavailable</h1><p>{access.error ? 'Your notebook could not be opened. Please try again.' : 'My Desk is temporarily unavailable.'}</p>{access.error && <Button onClick={() => access.refresh()}>Try again</Button>}</section>}
  </div>;
}

export function MyDeskNotebook({ schoolId, viewerId, today, timeZone, onImport, initialNoteId, access }) {
  const [filters, setFilters] = useState({ scope: 'all', classId: '', studentId: '', category: '', from: '', to: '', q: '' });
  const [composer, setComposer] = useState(null);
  const [deleteNote, setDeleteNote] = useState(null);
  const [busyId, setBusyId] = useState(null);
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState('');
  const [announcement, setAnnouncement] = useState('');
  const lifetime = useRef(null);
  const operations = useRef(new Set());
  useEffect(() => {
    const controller = new AbortController(); lifetime.current = controller;
    return () => controller.abort();
  }, []);
  useEffect(() => {
    if (!initialNoteId) return;
    const controller = new AbortController();
    myDeskApi(schoolId, controller.signal).get(`/notes/${encodeURIComponent(initialNoteId)}`).then(result => { controller.signal.throwIfAborted(); setComposer({ sessionId: crypto.randomUUID(), note: result.note }); }).catch(failure => { if (!controller.signal.aborted && failure.name !== 'AbortError') setError(myDeskError(failure)); });
    return () => controller.abort();
  }, [initialNoteId, schoolId]);
  const deferredQuery = useDeferredValue(filters.q);
  const requestFilters = { ...filters, q: deferredQuery };
  const classes = useMyDeskClasses(schoolId, viewerId);
  const categories = useMyDeskCategories(schoolId, viewerId);
  const students = useMyDeskNoteStudents(schoolId, viewerId, filters.classId);
  const notes = useInfiniteQuery({
    queryKey: myDeskKeys.notes(schoolId, viewerId, requestFilters),
    initialPageParam: '',
    queryFn: ({ signal, pageParam }) => myDeskApi(schoolId, signal).search({ ...requestFilters, cursor: pageParam, limit: 30 }),
    getNextPageParam: page => page.nextCursor || undefined,
    retry: false,
  });
  const rows = notes.data?.pages.flatMap(page => page.notes || []) || [];
  const current = classes.data?.current || [];
  const past = classes.data?.past || [];
  const categoryList = categories.data?.categories || [];
  const scopeLabel = filters.scope === 'general' ? 'General notes' : filters.scope === 'past' ? 'Past classes' : filters.scope === 'class' ? [...current, ...past].find(item => item.id === filters.classId)?.name || 'Class notes' : 'All notes';
  const chooseScope = (scope, classId = '') => setFilters(previous => ({ ...previous, scope, classId, studentId: '' }));
  const openComposer = note => setComposer({ sessionId: crypto.randomUUID(), note: note || undefined, groupId: !note && filters.scope === 'class' && current.some(item => item.id === filters.classId) ? filters.classId : undefined });

  const mutate = async (note, action) => {
    if (operations.current.has(note.id)) return;
    const controller = lifetime.current;
    if (!controller || controller.signal.aborted) return;
    operations.current.add(note.id); setBusyId(note.id); setError('');
    try {
      const api = myDeskApi(schoolId, controller.signal);
      if (action === 'delete') await api.remove(note.id, note.revision);
      else await api.update(note.id, { revision: note.revision, pinned: !note.pinned });
      controller.signal.throwIfAborted(); await invalidateMyDesk(schoolId, viewerId);
      controller.signal.throwIfAborted(); setDeleteNote(null); setAnnouncement(action === 'delete' ? 'Note deleted.' : note.pinned ? 'Note unpinned.' : 'Note pinned.');
    } catch (failure) {
      if (!controller.signal.aborted) {
        if (action === 'delete' && isMyDeskNoteMissing(failure)) { await invalidateMyDesk(schoolId, viewerId); controller.signal.throwIfAborted(); setDeleteNote(null); setAnnouncement('Note deleted.'); }
        else setError(myDeskError(failure));
      }
    }
    finally { operations.current.delete(note.id); if (!controller.signal.aborted) setBusyId(null); }
  };

  const exportNotes = async () => {
    if (operations.current.has('export')) return;
    const controller = lifetime.current;
    if (!controller || controller.signal.aborted) return;
    operations.current.add('export'); setExporting(true); setError('');
    try {
      const blob = await myDeskApi(schoolId, controller.signal).export({ ...filters });
      controller.signal.throwIfAborted();
      const url = URL.createObjectURL(blob); const anchor = document.createElement('a');
      try { anchor.href = url; anchor.download = 'My-Desk-notes.csv'; document.body.appendChild(anchor); anchor.click(); }
      finally { anchor.remove(); URL.revokeObjectURL(url); }
      setAnnouncement('Your private notes were exported.');
    } catch (failure) { if (!controller.signal.aborted) setError(myDeskError(failure)); }
    finally { operations.current.delete('export'); if (!controller.signal.aborted) setExporting(false); }
  };

  return <main className="mydesk-shell">
    <div className="mydesk-intro"><div><div className="mydesk-title-line"><NotebookPen aria-hidden="true" /><h1>My Desk</h1></div><p>Your notes, right where you left them.</p><p className="mydesk-privacy"><LockKeyhole className="size-3.5" aria-hidden="true" />Only you can see these notes.</p></div><div className="import-entry-actions"><Button variant="outline" disabled={!onImport} title={!onImport ? 'AI paperwork import is temporarily unavailable. Your saved files remain available.' : undefined} onClick={() => onImport?.(filters.scope === 'class' ? filters.classId : undefined)}>{onImport ? 'Import paperwork with AI' : 'AI import unavailable'}</Button><Button className="mydesk-new" onClick={() => openComposer()}><Plus className="size-4" />New note</Button></div></div>
    <div className="mydesk-layout">
      <nav className="mydesk-index" aria-label="Notebook sections">
        <button aria-current={filters.scope === 'all' ? 'page' : undefined} onClick={() => chooseScope('all')}><BookOpen className="size-4" />All notes</button>
        <button aria-current={filters.scope === 'general' ? 'page' : undefined} onClick={() => chooseScope('general')}>General</button>
        <MyDeskClassIndex classes={classes} schoolId={schoolId} viewerId={viewerId} selectedId={filters.classId} onSelect={id => chooseScope('class', id)} />
        <button className="mydesk-past-link" aria-current={filters.scope === 'past' ? 'page' : undefined} onClick={() => chooseScope('past')}>Past classes</button>
        {filters.scope === 'past' && <p className="text-xs text-muted-foreground px-3">Your notes stay here after a class or roster changes.</p>}
      </nav>
      <section className="mydesk-notes" aria-label={scopeLabel}>
        <div className="mydesk-section-heading"><h2>{scopeLabel}</h2><Button variant="ghost" disabled={exporting} onClick={exportNotes}><Download className="size-4" />{exporting ? 'Exporting…' : 'Export CSV'}</Button></div>
        <div className="mydesk-filters"><label className="mydesk-search"><span className="sr-only">Search notes</span><Search className="size-4" aria-hidden="true" /><Input maxLength={200} placeholder="Search your notes" value={filters.q} onChange={event => setFilters(previous => ({ ...previous, q: event.target.value }))} /></label>
          <label>Category<select aria-label="Category" value={filters.category} onChange={event => setFilters(previous => ({ ...previous, category: event.target.value }))}><option value="">All categories</option>{categoryList.map(item => <option key={item.key} value={item.key}>{item.label}</option>)}</select></label>
          {filters.scope === 'past' && <label>Past class<select aria-label="Past class" value={filters.classId} onChange={event => chooseScope('past', event.target.value)}><option value="">All past classes</option>{past.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>}
          {filters.classId && <label>Student<select aria-label="Student" value={filters.studentId} onChange={event => setFilters(previous => ({ ...previous, studentId: event.target.value }))}><option value="">All students</option>{(students.data?.students || []).map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>}
          <label>From<Input type="date" value={filters.from} onChange={event => setFilters(previous => ({ ...previous, from: event.target.value }))} /></label><label>To<Input type="date" value={filters.to} onChange={event => setFilters(previous => ({ ...previous, to: event.target.value }))} /></label>
        </div>
        {error && <p className="mydesk-error" role="alert">{error}</p>}<p className="sr-only" role="status">{announcement}</p>
        {students.isError && <p className="mydesk-error" role="alert">Student filters unavailable. <button onClick={() => students.refetch()}>Retry</button></p>}
        {notes.isPending ? <p className="mydesk-empty" role="status">Loading your notes…</p> : notes.isError ? <div className="mydesk-empty" role="alert"><p>{myDeskError(notes.error)}</p><Button variant="outline" onClick={() => notes.refetch()}>Try again</Button></div> : rows.length === 0 ? <div className="mydesk-empty"><NotebookPen className="size-9" aria-hidden="true" /><h3>A little space to remember.</h3><p>{filters.q || filters.category || filters.from || filters.to ? 'No notes match these filters.' : 'Save a reminder, a classroom moment, or a photo of the paper you want to keep.'}</p><Button variant="outline" onClick={() => openComposer()}>Write a note</Button></div> : <div className="mydesk-note-list">{rows.map(note => <NoteCard key={`${schoolId}:${viewerId}:${note.id}`} note={note} access={access} onImport={onImport} schoolId={schoolId} viewerId={viewerId} categories={categoryList} timeZone={timeZone} busy={busyId === note.id} onEdit={() => openComposer(note)} onPin={() => mutate(note, 'pin')} onDelete={() => setDeleteNote(note)} />)}</div>}
        {notes.hasNextPage && <Button className="mydesk-load-more" variant="outline" disabled={notes.isFetchingNextPage} onClick={() => notes.fetchNextPage()}>{notes.isFetchingNextPage ? 'Loading…' : 'Load more notes'}</Button>}
      </section>
    </div>
    {composer && <NoteComposerDialog key={`${schoolId}:${viewerId}:${composer.sessionId}`} {...composer} open schoolId={schoolId} viewerId={viewerId} today={today} timeZone={timeZone} onOpenChange={open => { if (!open) setComposer(null); }} onSaved={() => setAnnouncement('Private note saved.')} />}
    <AlertDialog open={Boolean(deleteNote)} onOpenChange={open => { if (!open && !busyId) setDeleteNote(null); }}><AlertDialogContent><AlertDialogHeader><AlertDialogTitle>Delete this private note?</AlertDialogTitle><AlertDialogDescription>The note and its attachments will be removed from your notebook.</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel disabled={Boolean(busyId)}>Keep note</AlertDialogCancel><AlertDialogAction disabled={Boolean(busyId)} onClick={event => { event.preventDefault(); void mutate(deleteNote, 'delete'); }}>{busyId ? 'Deleting…' : 'Delete note'}</AlertDialogAction></AlertDialogFooter></AlertDialogContent></AlertDialog>
  </main>;
}

export function NoteCard({ note, access, onImport, schoolId, viewerId, categories, timeZone = 'America/New_York', busy, onEdit, onPin, onDelete }) {
  const [expanded, setExpanded] = useState(false);
  const attachments = (note.attachments || []).filter(item => item.status === 'ready');
  return <article className={`mydesk-note ${note.pinned ? 'mydesk-note-pinned' : ''}`} aria-label={note.title || `Note for ${myDeskTarget(note)}`}>
    <header className="mydesk-note-meta"><div><span className="mydesk-target">{note.targetKind === 'student' && note.filingStudentId ? <a href={`/classpilot/my-desk/students/${encodeURIComponent(note.filingStudentId)}`}>{myDeskTarget(note)}</a> : myDeskTarget(note)}</span>{note.targetKind === 'student' && note.groupName && <span>{note.groupName}</span>}<span>{categories.find(item => item.key === note.category)?.label || note.category}</span></div><time dateTime={note.entryDate}>{note.entryDate}</time></header>
    {(note.title || note.displayTitle) && <h3>{note.title || note.displayTitle}</h3>}{note.body && <p className="mydesk-note-body">{note.body}</p>}
    {note.revision > 2 && note.updatedAt && <p className="mt-3 text-xs text-muted-foreground">Updated <time dateTime={note.updatedAt}>{new Intl.DateTimeFormat('en-US', { timeZone, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(note.updatedAt))}</time></p>}
    <footer className="mydesk-note-actions"><Button size="sm" variant="ghost" disabled={busy} aria-pressed={note.pinned} onClick={onPin}><Pin className="size-4" />{note.pinned ? 'Unpin' : 'Pin'}</Button><Button size="sm" variant="ghost" disabled={busy} onClick={onEdit}><Pencil className="size-4" />Edit / refile</Button><Button size="sm" variant="ghost" disabled={busy} onClick={onDelete}><Trash2 className="size-4" />Delete</Button>{attachments.length > 0 && <Button size="sm" variant="ghost" aria-expanded={expanded} aria-controls={`note-files-${note.id}`} onClick={() => setExpanded(value => !value)}><Paperclip className="size-4" />{expanded ? 'Hide' : 'View'} attachments ({attachments.length})</Button>}{access && note.targetKind === 'student' && note.status === 'active' && <DisciplineSubmitButton access={access} noteIds={[note.id]} />}</footer>
    {expanded && <div id={`note-files-${note.id}`} className="mydesk-attachments">{attachments.map(attachment => <div key={attachment.id}><MyDeskAttachment schoolId={schoolId} viewerId={viewerId} noteId={note.id} attachment={attachment} />{['application/pdf', 'image/jpeg', 'image/png', 'image/webp'].includes(attachment.contentType) && <Button variant="outline" disabled={!onImport} onClick={() => onImport?.(note.groupId || undefined, { noteId: note.id, attachmentId: attachment.id })}>{onImport ? 'Extract student notes with AI' : 'AI import unavailable'}</Button>}</div>)}</div>}
  </article>;
}
