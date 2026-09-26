import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { Button } from '../../../components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '../../../components/ui/dialog';
import { useDisciplineCapabilities, useDisciplineLifetime } from '../hooks/useDiscipline';
import { disciplineApi, disciplineCategory, invalidateDiscipline } from '../lib/discipline';
import { myDeskApi } from '../lib/myDesk';
import { myDeskError, myDeskKeys } from '../lib/myDeskModel';
import MyDeskAttachment from './MyDeskAttachment';
import '../discipline.css';

export default function DisciplineSubmitButton({ access, noteIds, label = 'Submit to school log', onSubmitted }) {
  const capabilities = useDisciplineCapabilities(access);
  const [sessionId, setSessionId] = useState(null);
  if (!capabilities.usable || !capabilities.data.canSubmit || !noteIds?.length) return null;
  return <><Button variant="outline" onClick={() => setSessionId(crypto.randomUUID())}>{label}</Button>
    {sessionId && <SubmissionReview key={`${access.schoolId}:${access.viewerId}:${sessionId}`} access={access} noteIds={noteIds}
      onClose={() => setSessionId(null)} onSubmitted={onSubmitted} />}</>;
}

export function SubmissionReview({ access, noteIds, onClose, onSubmitted }) {
  const { schoolId, viewerId } = access;
  const [ids] = useState(() => [...new Set(noteIds)]);
  const tooMany = ids.length > 50;
  const [selection, setSelection] = useState({});
  const [reviewed, setReviewed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [receipt, setReceipt] = useState({});
  const [confirmClose, setConfirmClose] = useState(false);
  const [started, setStarted] = useState(false);
  const lifetime = useDisciplineLifetime(schoolId, viewerId);
  const transaction = useRef(null);
  const working = useRef(false);
  const query = useQuery({ queryKey: [...myDeskKeys.root(schoolId, viewerId), 'discipline-submission-preview', ...ids],
    queryFn: async ({ signal }) => {
      const api = myDeskApi(schoolId, signal), notes = [];
      for (let offset = 0; offset < ids.length; offset += 5) notes.push(...await Promise.all(ids.slice(offset, offset + 5).map(async id => (await api.get(`/notes/${encodeURIComponent(id)}`)).note)));
      return notes;
    }, enabled: !tooMany, retry: false, gcTime: 0, refetchOnWindowFocus: false });
  const notes = query.data || [];
  const valid = note => note.targetKind === 'student' && note.status === 'active';
  const selected = note => selection[note.id]?.included ?? valid(note);
  const attachments = note => selection[note.id]?.attachmentIds ?? (note.attachments || []).filter(item => item.status === 'ready' && item.committedAt).map(item => item.id);
  const chosen = notes.filter(note => valid(note) && selected(note));
  const remaining = chosen.filter(note => !receipt[note.id]);
  const complete = chosen.length > 0 && chosen.every(note => receipt[note.id]);
  useEffect(() => {
    if (!busy) return;
    const warn = event => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', warn); return () => window.removeEventListener('beforeunload', warn);
  }, [busy]);
  const change = (note, patch) => {
    setSelection(previous => ({ ...previous, [note.id]: { included: selected(note), attachmentIds: attachments(note), ...patch } }));
    setReviewed(false);
  };
  const close = () => { if (busy) return; if (!complete && (reviewed || Object.keys(selection).length || started)) setConfirmClose(true); else onClose(); };
  const submit = async () => {
    if (working.current || !reviewed || !remaining.length || !lifetime.current || lifetime.current.signal.aborted) return;
    const controller = lifetime.current;
    if (!transaction.current) transaction.current = chosen.map(note => ({ clientRequestId: crypto.randomUUID(), noteId: note.id, noteRevision: note.revision, attachmentIds: attachments(note) }));
    working.current = true; setBusy(true); setStarted(true); setError('');
    const results = { ...receipt };
    try {
      const api = disciplineApi(schoolId, controller.signal);
      for (const payload of transaction.current) {
        if (results[payload.noteId]) continue;
        const result = await api.submit(payload); controller.signal.throwIfAborted();
        results[payload.noteId] = result.record; setReceipt({ ...results });
      }
      await invalidateDiscipline(schoolId, viewerId); controller.signal.throwIfAborted();
      onSubmitted?.(Object.values(results));
    } catch (failure) { if (!controller.signal.aborted) setError(myDeskError(failure)); }
    finally { working.current = false; if (!controller.signal.aborted) setBusy(false); }
  };
  return <Dialog open onOpenChange={open => { if (!open) close(); }}><DialogContent className="discipline-submit-dialog" onInteractOutside={event => { if (busy) event.preventDefault(); }} onEscapeKeyDown={event => { if (busy) event.preventDefault(); }}>
    <DialogHeader><DialogTitle>Review school log submission</DialogTitle><DialogDescription>Visible to designated school administrators. Only the entries and forms selected below will be submitted. Your other notes remain private.</DialogDescription></DialogHeader>
    {tooMany ? <section role="alert"><p>Choose up to 50 notes per school submission review. None of these {ids.length} notes were submitted.</p><Button variant="outline" onClick={onClose}>Close review</Button></section> : query.isPending ? <p role="status">Loading the exact saved entries…</p> : query.isError ? <p role="alert">{myDeskError(query.error)} <Button onClick={() => query.refetch()}>Retry preview</Button></p> : <>
      <div className="discipline-submission-list">{notes.map(note => <article key={note.id} className="discipline-submission-entry">
        <label className="discipline-check"><input type="checkbox" checked={selected(note)} disabled={!valid(note) || busy || started} onChange={event => change(note, { included: event.target.checked })} /><strong>{note.studentName || 'Student required'}</strong></label>
        {!valid(note) ? <p>File this saved note under one student before submitting it.</p> : <><p>{note.groupName} · {note.entryDate} · {disciplineCategory(note.category)}</p><h3>{note.title || 'Student note'}</h3><p className="discipline-body">{note.body}</p>
          {(note.attachments || []).filter(item => item.status === 'ready' && item.committedAt).map(item => <div key={item.id}>
            <label className="discipline-check"><input type="checkbox" disabled={!selected(note) || busy || started} checked={attachments(note).includes(item.id)} onChange={event => change(note, { attachmentIds: event.target.checked ? [...attachments(note), item.id] : attachments(note).filter(id => id !== item.id) })} />Include {item.originalFilename || 'form'}</label>
            <details><summary>Preview form</summary><MyDeskAttachment schoolId={schoolId} viewerId={viewerId} noteId={note.id} attachment={item} /></details>
          </div>)}</>}
        {receipt[note.id] && <p role="status">Submitted. <Link to={`/classpilot/discipline-records/${receipt[note.id].id}`}>Open school record</Link></p>}
      </article>)}</div>
      {!complete && <label className="discipline-check"><input type="checkbox" checked={reviewed} disabled={busy || started} onChange={event => setReviewed(event.target.checked)} />I reviewed the selected entries and forms for submission.</label>}
      {error && <p role="alert">{error} {Object.keys(receipt).length > 0 && `${Object.keys(receipt).length} entries were submitted. Retry continues with the remaining entries.`}</p>}
      {complete ? <p role="status">{Object.keys(receipt).length} school records submitted. Your private notes are unchanged.</p> : <p>The school retains submitted copies independently of your private notes.</p>}
      <div className="discipline-actions"><Button variant="outline" disabled={busy} onClick={close}>{complete ? 'Done' : 'Cancel'}</Button>{!complete && <Button disabled={busy || !reviewed || !remaining.length} onClick={submit}>{busy ? 'Submitting…' : started ? `Retry ${remaining.length} remaining` : `Submit ${chosen.length} ${chosen.length === 1 ? 'entry' : 'entries'} to school log`}</Button>}</div>
    </>}
    {confirmClose && <section className="discipline-notice" role="alert"><p>Close this review? Entries already submitted will remain in the school log. Unsubmitted entries stay private.</p><Button variant="outline" onClick={() => setConfirmClose(false)}>Keep reviewing</Button><Button variant="destructive" onClick={onClose}>Close review</Button></section>}
  </DialogContent></Dialog>;
}
