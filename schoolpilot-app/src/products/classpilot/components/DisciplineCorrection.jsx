import { useEffect, useRef, useState } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import { Button } from '../../../components/ui/button';
import { Input } from '../../../components/ui/input';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '../../../components/ui/dialog';
import { queryClient } from '../../../lib/queryClient';
import { useMyDeskClasses, useMyDeskStudents } from '../hooks/useMyDesk';
import { useDisciplineLifetime } from '../hooks/useDiscipline';
import { disciplineApi, disciplineCategory, disciplineKeys, invalidateDiscipline } from '../lib/discipline';
import { myDeskApi } from '../lib/myDesk';
import { myDeskError, myDeskKeys } from '../lib/myDeskModel';
import { guardPrivateWorkspaceHistory } from '../lib/privateWorkspaceNavigation';
import DisciplineAttachment from './DisciplineAttachment';
import MyDeskAttachment from './MyDeskAttachment';

export default function DisciplineCorrection({ access, record, onClose }) {
  const { schoolId, viewerId } = access;
  const [version, setVersion] = useState(record.currentVersion);
  const [baseRevision, setBaseRevision] = useState(record.revision);
  const [draft, setDraft] = useState(() => ({ groupId: version.classId, studentId: version.studentId, category: version.category, title: version.title, body: version.body, entryDate: version.entryDate, attachmentIds: version.attachments.map(item => item.id), reason: '' }));
  const [changingTarget, setChangingTarget] = useState(false); const [replaceEvidence, setReplaceEvidence] = useState(false); const [sourceNoteId, setSourceNoteId] = useState('');
  const [reviewed, setReviewed] = useState(false); const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const [confirmClose, setConfirmClose] = useState(false);
  const [pending, setPending] = useState(false); const [dirty, setDirty] = useState(false);
  const [conflict, setConflict] = useState(false); const [latest, setLatest] = useState(null);
  const lifetime = useDisciplineLifetime(schoolId, viewerId); const transaction = useRef(null); const working = useRef(false);
  const classes = useMyDeskClasses(schoolId, viewerId, changingTarget);
  const students = useMyDeskStudents(schoolId, viewerId, changingTarget ? draft.groupId : null);
  const noteQuery = useInfiniteQuery({ queryKey: [...myDeskKeys.root(schoolId, viewerId), 'discipline-correction-notes', draft.studentId, draft.groupId], initialPageParam: '',
    queryFn: ({ signal, pageParam }) => myDeskApi(schoolId, signal).studentHistory(draft.studentId, { classId: draft.groupId, limit: 30, ...(pageParam ? { cursor: pageParam } : {}) }),
    getNextPageParam: page => page.nextCursor || undefined, enabled: Boolean(replaceEvidence && draft.studentId && draft.groupId), retry: false, gcTime: 0 });
  const notes = noteQuery.isError ? [] : noteQuery.data?.pages.flatMap(page => page.notes).filter(note => note.targetKind === 'student' && note.status === 'active') || [];
  const source = notes.find(note => note.id === sourceNoteId);
  const availableAttachments = replaceEvidence ? (source?.attachments || []).filter(item => item.status === 'ready' && item.committedAt) : version.attachments;
  const change = patch => { setDraft(previous => ({ ...previous, ...patch })); setReviewed(false); setDirty(true); };
  useEffect(() => {
    if (!dirty && !pending) return;
    const warn = event => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    const release = guardPrivateWorkspaceHistory(() => setConfirmClose(true));
    return () => { window.removeEventListener('beforeunload', warn); release(); };
  }, [dirty, pending]);
  const close = () => { if (busy) return; if (dirty || pending) setConfirmClose(true); else onClose(); };
  const save = async () => {
    if (working.current || conflict || !reviewed || !draft.reason.trim() || !lifetime.current || lifetime.current.signal.aborted) return;
    const controller = lifetime.current;
    if (!transaction.current) transaction.current = { ...draft, revision: baseRevision, clientRequestId: crypto.randomUUID(), reason: draft.reason.trim(), ...(replaceEvidence && source ? { sourceNoteId: source.id, sourceNoteRevision: source.revision } : {}) };
    working.current = true; setBusy(true); setError('');
    try {
      await disciplineApi(schoolId, controller.signal).correct(record.id, transaction.current); controller.signal.throwIfAborted();
      await invalidateDiscipline(schoolId, viewerId); controller.signal.throwIfAborted(); onClose();
    } catch (failure) {
      if (!controller.signal.aborted) {
        setError(myDeskError(failure));
        if (failure.response?.data?.code === 'DISCIPLINE_REVISION_CONFLICT') { setConflict(true); setReviewed(false); }
        if (failure.response?.status >= 400 && failure.response?.status < 500) { transaction.current = null; setPending(false); }
        else setPending(true);
      }
    } finally { working.current = false; if (!controller.signal.aborted) setBusy(false); }
  };
  const loadLatest = async () => {
    const controller = lifetime.current; if (working.current || !controller || controller.signal.aborted) return;
    working.current = true; setBusy(true);
    try { const result = await disciplineApi(schoolId, controller.signal).record(record.id); controller.signal.throwIfAborted(); setLatest(result.record);
      queryClient.setQueryData(disciplineKeys.record(schoolId, viewerId, record.id), result); }
    catch (failure) { if (!controller.signal.aborted) setError(myDeskError(failure)); }
    finally { working.current = false; if (!controller.signal.aborted) setBusy(false); }
  };
  const keepDraft = () => {
    if (!latest?.canCorrect) return;
    setVersion(latest.currentVersion); setBaseRevision(latest.revision);
    setDraft(previous => ({ ...previous, attachmentIds: [] }));
    setChangingTarget(draft.groupId !== latest.currentVersion.classId || draft.studentId !== latest.currentVersion.studentId);
    setReplaceEvidence(false); setSourceNoteId(''); setReviewed(false); setLatest(null); setConflict(false); setError('');
  };
  const frozen = busy || pending;
  const targetValid = !changingTarget || !students.isFetching && !students.isError && students.data?.students.some(student => student.id === draft.studentId);
  return <Dialog open onOpenChange={open => { if (!open) close(); }}><DialogContent className="discipline-submit-dialog" onInteractOutside={event => { if (busy) event.preventDefault(); }} onEscapeKeyDown={event => { if (busy) event.preventDefault(); }}>
    <DialogHeader><DialogTitle>Correct school submission</DialogTitle><DialogDescription>Visible to designated school administrators. This creates a new version; the previous submission remains labeled in history.</DialogDescription></DialogHeader>
    <p>{version.studentName} · {version.className}</p>
    <label className="discipline-check"><input type="checkbox" checked={changingTarget} disabled={frozen} onChange={event => { setChangingTarget(event.target.checked); setSourceNoteId(''); setReplaceEvidence(false); change({ groupId: version.classId, studentId: version.studentId, attachmentIds: version.attachments.map(item => item.id) }); }} />Correct the student or filing class</label>
    {changingTarget && <div className="discipline-filters"><label>Filing class<select value={draft.groupId || ''} disabled={frozen || classes.isPending} onChange={event => { change({ groupId: event.target.value, studentId: '', attachmentIds: version.attachments.map(item => item.id) }); setSourceNoteId(''); setReplaceEvidence(false); }}><option value="">Select class</option>{(classes.data?.current || []).map(item => <option value={item.id} key={item.id}>{item.name}</option>)}</select></label><label>Student<select value={draft.studentId || ''} disabled={frozen || students.isFetching || students.isError} onChange={event => { change({ studentId: event.target.value }); setSourceNoteId(''); setReplaceEvidence(false); }}><option value="">Select student</option>{(students.data?.students || []).map(student => <option key={student.id} value={student.id}>{student.name || `${student.firstName} ${student.lastName}`}</option>)}</select></label>{classes.isError && <p role="alert">{myDeskError(classes.error)}</p>}{students.isError && <p role="alert">{myDeskError(students.error)}</p>}</div>}
    <div className="discipline-filters"><label>Incident date<Input type="date" value={draft.entryDate} disabled={frozen} onChange={event => change({ entryDate: event.target.value })} /></label><label>Category<select value={draft.category} disabled={frozen} onChange={event => change({ category: event.target.value })}>{['note','detention','referral','uniform','positive','parent_contact','other'].map(key => <option key={key} value={key}>{disciplineCategory(key)}</option>)}</select></label></div>
    <label>Title<Input maxLength={160} value={draft.title} disabled={frozen} onChange={event => change({ title: event.target.value })} /></label>
    <label>Factual summary<textarea rows={5} maxLength={5000} value={draft.body} disabled={frozen} onChange={event => change({ body: event.target.value })} /></label>
    <label className="discipline-check"><input type="checkbox" checked={replaceEvidence} disabled={frozen} onChange={event => { setReplaceEvidence(event.target.checked); setSourceNoteId(''); change({ attachmentIds: event.target.checked ? [] : version.attachments.map(item => item.id) }); }} />Replace forms with attachments from a private note</label>
    {replaceEvidence && <><label>Saved private note<select value={sourceNoteId} disabled={frozen || noteQuery.isFetching} onChange={event => { const note = notes.find(item => item.id === event.target.value); setSourceNoteId(event.target.value); change({ attachmentIds: (note?.attachments || []).filter(item => item.status === 'ready' && item.committedAt).map(item => item.id) }); }}><option value="">Choose a note for this student and class</option>{notes.map(note => <option key={note.id} value={note.id}>{note.entryDate} — {note.title || disciplineCategory(note.category)}</option>)}</select></label>{noteQuery.hasNextPage && <Button variant="outline" disabled={noteQuery.isFetchingNextPage || frozen} onClick={() => noteQuery.fetchNextPage()}>More private notes</Button>}{noteQuery.isError && <p role="alert">{myDeskError(noteQuery.error)}</p>}</>}
    {availableAttachments.map(attachment => <div key={attachment.id}><label className="discipline-check"><input type="checkbox" checked={draft.attachmentIds.includes(attachment.id)} disabled={frozen} onChange={event => change({ attachmentIds: event.target.checked ? [...draft.attachmentIds, attachment.id] : draft.attachmentIds.filter(id => id !== attachment.id) })} />Include {attachment.filename || attachment.originalFilename || 'form'}</label><details><summary>Preview form</summary>{replaceEvidence ? <MyDeskAttachment schoolId={schoolId} viewerId={viewerId} noteId={source.id} attachment={attachment} /> : <DisciplineAttachment access={access} recordId={record.id} versionId={version.id} attachment={attachment} />}</details></div>)}
    <label>Reason for correction<textarea rows={2} maxLength={2000} value={draft.reason} disabled={frozen} onChange={event => change({ reason: event.target.value })} /></label>
    <label className="discipline-check"><input type="checkbox" checked={reviewed} disabled={frozen} onChange={event => setReviewed(event.target.checked)} />I reviewed the corrected entry and selected forms.</label>
    {error && <p role="alert">{error} Your correction draft is preserved.</p>}
    {conflict && <section className="discipline-notice"><p>Review the latest saved version before submitting your draft again.</p><Button variant="outline" disabled={busy} onClick={loadLatest}>Review latest saved version</Button>
      {latest && <><h2>Latest saved submission</h2><p>{latest.currentVersion.studentName} · {latest.currentVersion.className} · {latest.currentVersion.entryDate}</p><h3>{latest.currentVersion.title}</h3><p className="discipline-body">{latest.currentVersion.body}</p><p>Your draft text will be kept. Choose the forms again and confirm your review.</p>{latest.canCorrect ? <Button variant="outline" disabled={busy} onClick={keepDraft}>Keep my draft against this version</Button> : <p>This record can no longer be corrected.</p>}</>}
    </section>}
    <div className="discipline-actions"><Button variant="outline" disabled={busy} onClick={close}>Cancel</Button><Button disabled={busy || conflict || !reviewed || !draft.reason.trim() || !draft.entryDate || !targetValid || replaceEvidence && !source} onClick={save}>{busy ? 'Submitting correction…' : pending ? 'Retry correction' : 'Submit correction'}</Button></div>
    {confirmClose && <section className="discipline-notice" role="alert"><p>{pending ? 'The previous response was interrupted. A correction may already have saved; reopening the record will show its current version.' : 'Discard this unsaved correction?'}</p><Button variant="outline" onClick={() => setConfirmClose(false)}>Keep editing</Button><Button variant="destructive" onClick={onClose}>Close correction</Button></section>}
  </DialogContent></Dialog>;
}
