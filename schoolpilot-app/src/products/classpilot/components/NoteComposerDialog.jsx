import { useEffect, useRef, useState } from 'react';
import { Camera, Paperclip, X, LockKeyhole } from 'lucide-react';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../../../components/ui/dialog';
import { AlertDialog, AlertDialogContent, AlertDialogHeader, AlertDialogTitle, AlertDialogDescription, AlertDialogFooter, AlertDialogCancel, AlertDialogAction } from '../../../components/ui/alert-dialog';
import { Button } from '../../../components/ui/button';
import { Input } from '../../../components/ui/input';
import { Textarea } from '../../../components/ui/textarea';
import { useMyDeskCategories, useMyDeskClasses, useMyDeskStudents, useMyDeskStudentClasses } from '../hooks/useMyDesk';
import { attachmentDigest, invalidateMyDesk, myDeskApi } from '../lib/myDesk';
import { myDeskError, isMyDeskNoteMissing, schoolDate, targetInput, validateMyDeskAttachment, MY_DESK_MAX_ATTACHMENTS } from '../lib/myDeskModel';
import '../myDesk.css';

// Closing unmounts the form itself, not just Radix's portal. Parents also key by identity.
export default function NoteComposerDialog(props) {
  return props.open ? <ComposerSession key={props.sessionId} {...props} /> : null;
}

function ComposerSession({ onOpenChange, schoolId, viewerId, note, student, groupId: initialGroupId, today, timeZone, onSaved }) {
  const lifetime = useRef(null);
  const [requestId] = useState(() => crypto.randomUUID());
  const [targetKind, setTargetKind] = useState(note?.targetKind || (student ? 'student' : initialGroupId ? 'class' : 'general'));
  const [groupId, setGroupId] = useState(note?.groupId || note?.filingGroupId || initialGroupId || '');
  const [studentId, setStudentId] = useState(note?.studentId || note?.filingStudentId || student?.id || '');
  const [category, setCategory] = useState(note?.category || 'note');
  const [title, setTitle] = useState(note?.title || '');
  const [body, setBody] = useState(note?.body || '');
  const [entryDate, setEntryDate] = useState(() => note?.entryDate || today || schoolDate(timeZone));
  const [pinned, setPinned] = useState(note?.pinned || false);
  const [existingIds, setExistingIds] = useState(() => (note?.attachments || []).filter(item => item.status === 'ready').map(item => item.id));
  const [files, setFiles] = useState([]);
  const [busy, setBusy] = useState(false);
  const [partial, setPartial] = useState(false);
  const [canFinishPartial, setCanFinishPartial] = useState(false);
  const [error, setError] = useState('');
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [dirty, setDirty] = useState(false);
  const transaction = useRef(null);
  const inFlight = useRef(false);
  const fileInput = useRef(null);
  const cameraInput = useRef(null);
  const categories = useMyDeskCategories(schoolId, viewerId);
  const classes = useMyDeskClasses(schoolId, viewerId);
  const allCurrentClasses = classes.data?.current || [];
  const fixedStudent = targetKind === 'student' && student && !note;
  const studentClasses = useMyDeskStudentClasses(schoolId, viewerId, fixedStudent ? student.id : null, allCurrentClasses);
  const currentClasses = fixedStudent ? studentClasses.data || [] : allCurrentClasses;
  const effectiveGroupId = fixedStudent && !groupId && currentClasses.length === 1 ? currentClasses[0].id : groupId;
  const isCurrentClass = currentClasses.some(item => item.id === effectiveGroupId);
  const students = useMyDeskStudents(schoolId, viewerId, targetKind === 'student' && isCurrentClass ? effectiveGroupId : null);
  useEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;
    return () => controller.abort();
  }, []);
  useEffect(() => {
    if (!dirty && !busy && !partial) return;
    const warn = event => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty, busy, partial]);

  const close = () => onOpenChange(false);
  const requestClose = () => {
    if (inFlight.current) return;
    if (dirty || transaction.current) setConfirmCancel(true); else close();
  };
  const addFiles = event => {
    const incoming = Array.from(event.target.files || []);
    event.target.value = '';
    const invalid = incoming.map(validateMyDeskAttachment).find(Boolean);
    if (invalid) { setError(invalid); return; }
    if (existingIds.length + files.length + incoming.length > MY_DESK_MAX_ATTACHMENTS) { setError('A note can have up to five attachments.'); return; }
    setFiles(rows => [...rows, ...incoming.map(file => ({ file, clientRequestId: crypto.randomUUID(), status: 'waiting' }))]);
    setDirty(true); setError('');
  };

  const makePayload = () => {
    const targetChanged = !note || targetKind !== note.targetKind || effectiveGroupId !== (note.groupId || note.filingGroupId || '') || studentId !== (note.studentId || note.filingStudentId || '');
    if (targetChanged && targetKind !== 'general' && (!effectiveGroupId || !isCurrentClass)) throw new Error('Choose one of your current classes.');
    if (targetChanged && targetKind === 'student' && !studentId) throw new Error('Choose a student.');
    if (!body.trim() && !title.trim() && !files.length && !existingIds.length) throw new Error('Add a title, note, photo or PDF before saving.');
    if (!entryDate) throw new Error('Choose an entry date.');
    return { ...(targetChanged ? targetInput(targetKind, effectiveGroupId, studentId) : {}), category, title: title.trim(), body: body.trim(), entryDate, pinned };
  };

  const save = async (finishUploaded = false) => {
    if (inFlight.current) return;
    const controller = lifetime.current;
    if (!controller || controller.signal.aborted) return;
    const api = myDeskApi(schoolId, controller.signal);
    inFlight.current = true; setBusy(true); setError('');
    try {
      if (!transaction.current) transaction.current = { payload: makePayload(), note: note || null, files: files.map(item => ({ ...item })), existingIds: [...existingIds] };
      const tx = transaction.current;
      if (!tx.note) {
        const response = await api.create({ ...tx.payload, clientRequestId: requestId });
        controller.signal.throwIfAborted(); tx.note = response.note;
      }
      if (!finishUploaded) for (const item of tx.files) {
        if (item.status === 'ready') continue;
        try {
          item.status = 'uploading'; setFiles([...tx.files]);
          if (!item.digest) item.digest = await attachmentDigest(item.file);
          controller.signal.throwIfAborted();
          if (!item.attachment) {
            const response = await api.reserveAttachment(tx.note.id, { clientRequestId: item.clientRequestId, filename: item.file.name, contentType: item.file.type, size: item.file.size, sha256: item.digest });
            controller.signal.throwIfAborted(); item.attachment = response.attachment;
          }
          const response = await api.upload(tx.note.id, item.attachment.id, item.file);
          controller.signal.throwIfAborted(); item.attachment = response.attachment; item.status = 'ready'; item.error = '';
        } catch (failure) {
          if (controller.signal.aborted) throw failure;
          item.status = 'failed'; item.error = myDeskError(failure); setFiles([...tx.files]); throw failure;
        }
        setFiles([...tx.files]);
      }
      const attachmentIds = [...tx.existingIds, ...tx.files.filter(item => item.status === 'ready').map(item => item.attachment.id)];
      if (!tx.payload.body && !tx.payload.title && attachmentIds.length === 0) throw new Error('Upload at least one attachment before finishing this note.');
      tx.completion = { ...tx.payload, revision: tx.note.revision, attachmentIds };
      const result = await api.complete(tx.note.id, tx.completion);
      controller.signal.throwIfAborted();
      await invalidateMyDesk(schoolId, viewerId);
      controller.signal.throwIfAborted(); onSaved?.(result.note); close();
    } catch (failure) {
      if (!controller.signal.aborted) {
        const tx = transaction.current;
        setError(myDeskError(failure)); setPartial(Boolean(tx));
        setCanFinishPartial(Boolean(tx && (tx.payload.title || tx.payload.body || tx.existingIds.length || tx.files.some(item => item.status === 'ready'))));
      }
    } finally {
      inFlight.current = false;
      if (!controller.signal.aborted) setBusy(false);
    }
  };

  const cancelSave = async () => {
    if (inFlight.current) return;
    const controller = lifetime.current;
    if (!controller || controller.signal.aborted) return;
    const api = myDeskApi(schoolId, controller.signal);
    inFlight.current = true; setBusy(true); setConfirmCancel(false); setError('');
    try {
      const tx = transaction.current;
      if (tx && !note) {
        // Replay recovers the same reservation after an uncertain POST response.
        if (!tx.note) tx.note = (await api.create({ ...tx.payload, clientRequestId: requestId })).note;
        const latest = (await api.get(`/notes/${encodeURIComponent(tx.note.id)}`)).note;
        if (latest.status === 'active') {
          await invalidateMyDesk(schoolId, viewerId); controller.signal.throwIfAborted(); onSaved?.(latest); close(); return;
        }
        await api.remove(tx.note.id, latest.revision);
      } else if (tx && note) {
        // Remove only uploads staged by this editor; original attachments remain until complete.
        const latest = (await api.get(`/notes/${encodeURIComponent(note.id)}`)).note;
        const committedIds = new Set((latest.attachments || []).filter(item => item.committedAt).map(item => item.id));
        if (tx.completion && latest.revision > tx.note.revision && Object.entries(tx.payload).every(([key, value]) => (latest[key] ?? null) === value)) {
          await invalidateMyDesk(schoolId, viewerId); controller.signal.throwIfAborted(); onSaved?.(latest); close(); return;
        }
        let revision = latest.revision;
        for (const item of tx.files) {
          if (!item.attachment && item.digest) item.attachment = (await api.reserveAttachment(note.id, { clientRequestId: item.clientRequestId, filename: item.file.name, contentType: item.file.type, size: item.file.size, sha256: item.digest })).attachment;
          if (item.attachment && !committedIds.has(item.attachment.id)) {
            try { await api.removeAttachment(note.id, item.attachment.id, revision); }
            catch (failure) {
              if (!(failure.response?.status === 404 && failure.response?.data?.code === 'not_found')) throw failure;
            }
            revision = (await api.get(`/notes/${encodeURIComponent(note.id)}`)).note.revision;
          }
        }
      }
      controller.signal.throwIfAborted(); await invalidateMyDesk(schoolId, viewerId);
      controller.signal.throwIfAborted(); close();
    } catch (failure) {
      if (!controller.signal.aborted) {
        if (isMyDeskNoteMissing(failure)) { await invalidateMyDesk(schoolId, viewerId); controller.signal.throwIfAborted(); close(); }
        else setError(`Could not cancel the saved draft. ${myDeskError(failure)} Retry Cancel to finish.`);
      }
    } finally { inFlight.current = false; if (!controller.signal.aborted) setBusy(false); }
  };

  return <>
    <Dialog open onOpenChange={open => { if (!open) requestClose(); }}>
      <DialogContent className="mydesk-composer" onEscapeKeyDown={event => { if (busy) event.preventDefault(); }} onInteractOutside={event => { event.preventDefault(); requestClose(); }}>
        <DialogHeader><DialogTitle>{note ? 'Edit private note' : 'New private note'}</DialogTitle><DialogDescription className="flex items-center gap-2"><LockKeyhole className="size-3.5" aria-hidden="true" />Only you can see this note.</DialogDescription></DialogHeader>
        <form className="mydesk-composer-form" onSubmit={event => { event.preventDefault(); void save(); }} onChange={() => setDirty(true)}>
          <fieldset disabled={busy || partial} className="space-y-4 min-w-0">
            <div className="mydesk-form-grid"><label>File under<select aria-label="File under" value={targetKind} onChange={event => { setTargetKind(event.target.value); setGroupId(''); setStudentId(student?.id || ''); }}><option value="general">General</option><option value="class">Class</option><option value="student">Student</option></select></label>
              <label>Category<select aria-label="Category" value={category} onChange={event => setCategory(event.target.value)}>{(categories.data?.categories || [{ key: 'note', label: 'Note' }]).map(item => <option key={item.key} value={item.key}>{item.label}</option>)}</select></label></div>
            {targetKind !== 'general' && <div className="mydesk-form-grid"><label>Class<select aria-label="Class" value={effectiveGroupId} onChange={event => { setGroupId(event.target.value); if (!fixedStudent) setStudentId(''); }}><option value="">Choose a class</option>{effectiveGroupId && !isCurrentClass && note && <option value={effectiveGroupId}>{note.groupName || 'Saved class'}</option>}{currentClasses.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
              {targetKind === 'student' && <label>Student<select aria-label="Student" value={studentId} disabled={Boolean(fixedStudent)} onChange={event => setStudentId(event.target.value)}><option value="">Choose a student</option>{studentId && !(students.data?.students || []).some(item => item.id === studentId) && <option value={studentId}>{note?.studentName || student?.name || 'Saved student'}</option>}{(students.data?.students || []).map(item => <option key={item.id} value={item.id}>{item.name || `${item.firstName} ${item.lastName}`}</option>)}</select></label>}</div>}
            {fixedStudent && !studentClasses.isPending && currentClasses.length === 0 && <p role="alert" className="mydesk-error">This student is not in one of your current classes. You can write a general note instead.</p>}
            {(classes.isError || students.isError || categories.isError) && <p role="alert" className="mydesk-error">Could not load note options. Close and try again.</p>}
            <label>Title <span className="mydesk-optional">optional</span><Input maxLength={160} value={title} onChange={event => setTitle(event.target.value)} placeholder="A quick reminder, a moment to remember…" autoFocus /></label>
            <label>Note <span className="mydesk-optional">optional with a title or attachment</span><Textarea maxLength={5000} rows={6} value={body} onChange={event => setBody(event.target.value)} placeholder="Keep the details here." /></label>
            <div className="mydesk-form-grid"><label>Entry date<Input type="date" value={entryDate} onChange={event => setEntryDate(event.target.value)} required /></label><label className="mydesk-pin-option"><input type="checkbox" checked={pinned} onChange={event => setPinned(event.target.checked)} />Pin to the top</label></div>
            <div className="flex flex-wrap gap-2"><Button type="button" variant="outline" onClick={() => fileInput.current?.click()}><Paperclip className="size-4" />Add photos or PDF</Button><Button type="button" variant="outline" onClick={() => cameraInput.current?.click()}><Camera className="size-4" />Take photo</Button></div>
            <input ref={fileInput} className="sr-only" tabIndex={-1} type="file" multiple accept="image/jpeg,image/png,image/webp,application/pdf" aria-label="Choose photos or PDF" onChange={addFiles} />
            <input ref={cameraInput} className="sr-only" tabIndex={-1} type="file" accept="image/jpeg,image/png,image/webp" capture="environment" aria-label="Take a photo" onChange={addFiles} />
            <p className="text-xs text-muted-foreground">Up to 5 attachments, 10 MiB each. JPEG, PNG, WebP or PDF.</p>
            {(note?.attachments || []).filter(item => existingIds.includes(item.id)).map(item => <div key={item.id} className="mydesk-file-row"><span>{item.originalFilename}</span><Button type="button" size="icon" variant="ghost" aria-label={`Remove ${item.originalFilename}`} onClick={() => { setExistingIds(ids => ids.filter(id => id !== item.id)); setDirty(true); }}><X className="size-4" /></Button></div>)}
          </fieldset>
          {files.length > 0 && <ul className="space-y-2" aria-label="Attachments">{files.map((item, index) => <li key={item.clientRequestId} className="mydesk-file-row"><div className="min-w-0"><p className="truncate text-sm">{item.file.name}</p><p className={`text-xs ${item.status === 'failed' ? 'mydesk-error' : 'text-muted-foreground'}`} role="status">{item.status === 'ready' ? 'Uploaded' : item.status === 'failed' ? `Failed: ${item.error}` : item.status === 'uploading' ? 'Uploading…' : 'Ready to upload'}</p></div>{!busy && !partial && <Button type="button" size="icon" variant="ghost" aria-label={`Remove ${item.file.name}`} onClick={() => setFiles(rows => rows.filter((_, at) => at !== index))}><X className="size-4" /></Button>}</li>)}</ul>}
          {error && <p role="alert" className="mydesk-error">{error}</p>}
          <div className="mydesk-composer-actions"><Button type="button" variant="ghost" disabled={busy} onClick={requestClose}>Cancel</Button>{partial && canFinishPartial && <Button type="button" variant="outline" disabled={busy} onClick={() => save(true)}>Finish with uploaded files</Button>}<Button type="submit" disabled={busy || classes.isError || categories.isError}>{busy ? 'Saving…' : partial ? 'Retry save' : note ? 'Save changes' : 'Save note'}</Button></div>
        </form>
      </DialogContent>
    </Dialog>
    <AlertDialog open={confirmCancel} onOpenChange={setConfirmCancel}><AlertDialogContent><AlertDialogHeader><AlertDialogTitle>Discard this draft?</AlertDialogTitle><AlertDialogDescription>{note ? 'Your saved note stays unchanged. New uploads from this draft will be removed.' : 'This draft and its attachments will be removed.'}</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel>Keep editing</AlertDialogCancel><AlertDialogAction onClick={() => void cancelSave()}>Discard draft</AlertDialogAction></AlertDialogFooter></AlertDialogContent></AlertDialog>
  </>;
}
