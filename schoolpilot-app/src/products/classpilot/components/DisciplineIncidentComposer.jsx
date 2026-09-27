import { useDeferredValue, useEffect, useRef, useState } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { withDisciplineEntry } from '../lib/disciplineNavigation';
import { Button } from '../../../components/ui/button';
import { Input } from '../../../components/ui/input';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../../../components/ui/dialog';
import { disciplineApi, disciplineKeys, invalidateDiscipline } from '../lib/discipline';
import { attachmentDigest } from '../lib/myDesk';
import { myDeskError } from '../lib/myDeskModel';
import { useDisciplineLifetime } from '../hooks/useDiscipline';
import { guardPrivateWorkspaceHistory } from '../lib/privateWorkspaceNavigation';
import DisciplineAttachment from './DisciplineAttachment';

function todayInSchool(timeZone) {
  try { return new Intl.DateTimeFormat('en-CA', { timeZone: timeZone || 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()); }
  catch { return ''; }
}
const compact = object => Object.fromEntries(Object.entries(object).filter(([, value]) => value !== '' && value != null));

export default function DisciplineIncidentComposer({ access, scope = 'assigned', selectedStudent, onClose, onSaved }) {
  const { schoolId, viewerId } = access; const [params] = useSearchParams();
  const [form, setForm] = useState({ studentId: selectedStudent?.id || '', groupId: '', title: '', body: '', entryDate: todayInSchool(access.school?.schoolTimezone), referralRecorded: true, detentionAssigned: false, detentionDates: '' });
  const [search, setSearch] = useState(''), deferredSearch = useDeferredValue(search);
  const [files, setFiles] = useState([]), [stage, setStage] = useState('edit'), [busy, setBusy] = useState(false), [pending, setPending] = useState(false), [error, setError] = useState('');
  const [candidates, setCandidates] = useState([]), [duplicateAction, setDuplicateAction] = useState(''), [existingId, setExistingId] = useState(''), [reason, setReason] = useState(''), [reviewed, setReviewed] = useState(false);
  const [closeConfirm, setCloseConfirm] = useState(false), [denied, setDenied] = useState(false);
  const [savedDraft, setSavedDraft] = useState(null);
  const [dirty, setDirty] = useState(false);
  const lifetime = useDisciplineLifetime(schoolId, viewerId), transaction = useRef(null), serverDraft = useRef(null), finalRequest = useRef(null), cancelRequest = useRef(null), working = useRef(false), picker = useRef(null), camera = useRef(null);
  const query = useInfiniteQuery({ queryKey: disciplineKeys.students(schoolId, viewerId, { scope, q: deferredSearch, picker: true }), initialPageParam: '',
    queryFn: ({ signal, pageParam }) => disciplineApi(schoolId, signal).students(compact({ scope, q: deferredSearch, period: 'all', limit: 100, cursor: pageParam })),
    getNextPageParam: page => page.nextCursor || undefined, retry: false, gcTime: 0, staleTime: 0 });
  const students = [...new Map([...(selectedStudent ? [selectedStudent] : []), ...(query.isError ? [] : query.data?.pages.flatMap(page => page.students) || [])].map(student => [student.id, student])).values()];
  const selected = students.find(student => student.id === form.studentId);
  const changed = Boolean(dirty || files.length || savedDraft || pending);
  const rememberDraft = value => { serverDraft.current = value; setSavedDraft(value); };
  useEffect(() => {
    if (!changed) return;
    const handler = event => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', handler);
    const stop = guardPrivateWorkspaceHistory(() => setCloseConfirm(true));
    return () => { window.removeEventListener('beforeunload', handler); stop?.(); };
  }, [changed]);
  const edit = patch => { setForm(previous => ({ ...previous, ...patch })); setDirty(true); setReviewed(false); setError(''); };
  const choose = event => {
    const incoming = [...files, ...Array.from(event.target.files || [])]; event.target.value = '';
    if (incoming.length + (savedDraft?.attachments.length || 0) > 5 || incoming.some(file => file.size < 1 || file.size > 10485760 || !['application/pdf', 'image/jpeg', 'image/png', 'image/webp'].includes(file.type))) {
      setError('Choose up to five PDF, JPEG, PNG, or WebP files, each no larger than 10 MiB.'); return;
    }
    setFiles(incoming); setDirty(true); setReviewed(false);
  };
  const fail = (failure, controller) => {
    if (controller.signal.aborted) return;
    setError(myDeskError(failure));
    if ([401, 403, 404].includes(failure.response?.status)) { setDenied(true); controller.abort(); }
  };
  const prepare = async () => {
    const controller = lifetime.current; if (working.current || !controller || controller.signal.aborted) return;
    if (!form.studentId || !form.entryDate || (!form.body.trim() && !form.title.trim() && !files.length && !savedDraft?.attachments.length) || (!form.referralRecorded && !form.detentionAssigned)) { setError('Choose a student, incident date, incident type, and factual information or a form.'); return; }
    working.current = true; setBusy(true); setPending(true); setError('');
    try {
      const api = disciplineApi(schoolId, controller.signal);
      if (!transaction.current) transaction.current = { payload: { ...form, groupId: form.groupId || null, category: form.referralRecorded ? 'referral' : 'detention',
        detentionDates: form.detentionAssigned ? form.detentionDates.split(/[\n,]/).map(value => value.trim()).filter(Boolean) : [], clientRequestId: crypto.randomUUID(), ...(serverDraft.current ? { revision: serverDraft.current.revision } : {}) },
        files: files.map(file => ({ file, clientRequestId: crypto.randomUUID() })) };
      const tx = transaction.current;
      if (!tx.saved) {
        const result = serverDraft.current ? await api.updateDraft(serverDraft.current.id, tx.payload) : await api.createDraft(tx.payload);
        controller.signal.throwIfAborted();
        if (result.receipt?.recordId) { onSaved(result.receipt.recordId); return; }
        rememberDraft(result.draft); tx.saved = true;
      }
      for (const file of tx.files) {
        if (file.uploaded) continue;
        if (!file.digest) file.digest = await attachmentDigest(file.file); controller.signal.throwIfAborted();
        if (!file.reservation) file.reservation = { clientRequestId: file.clientRequestId, revision: serverDraft.current.revision, filename: file.file.name, contentType: file.file.type, size: file.file.size, sha256: file.digest };
        if (!file.asset) { const result = await api.reserveEvidence(serverDraft.current.id, file.reservation); file.asset = result.attachment; rememberDraft((await api.draft(serverDraft.current.id)).draft); }
        await api.uploadEvidence(serverDraft.current.id, file.asset.id, file.file); file.uploaded = true;
        rememberDraft((await api.draft(serverDraft.current.id)).draft);
      }
      const result = await api.duplicates(serverDraft.current.id); controller.signal.throwIfAborted();
      setCandidates(result.candidates); setDuplicateAction(result.candidates.length ? '' : 'separate'); setExistingId(''); setReason(''); setReviewed(false); setStage('review'); setPending(false); transaction.current = null; setFiles([]);
    } catch (failure) { fail(failure, controller); if (!controller.signal.aborted && failure.response?.status >= 400 && failure.response?.status < 500 && !transaction.current?.saved) { transaction.current = null; setPending(false); } }
    finally { working.current = false; if (!controller.signal.aborted) setBusy(false); }
  };
  const save = async () => {
    const controller = lifetime.current; if (working.current || !reviewed || !duplicateAction || !controller || controller.signal.aborted) return;
    const chosen = candidates.find(candidate => candidate.id === existingId);
    if (duplicateAction === 'add_evidence' && (!chosen?.canAddEvidence || !reason.trim())) { setError('Choose an incident you can correct and provide a reason.'); return; }
    working.current = true; setBusy(true); setPending(true); setError('');
    if (!finalRequest.current) finalRequest.current = { clientRequestId: crypto.randomUUID(), revision: serverDraft.current.revision, reviewed: true,
      attachmentIds: serverDraft.current.attachments.filter(file => file.status === 'ready').map(file => file.id), acknowledgedDuplicates: candidates.map(({ id, revision }) => ({ id, revision })), duplicateAction,
      ...(duplicateAction === 'add_evidence' ? { existingRecordId: chosen.id, existingRevision: chosen.revision, reason: reason.trim() } : {}) };
    try { const result = await disciplineApi(schoolId, controller.signal).finalize(serverDraft.current.id, finalRequest.current); controller.signal.throwIfAborted();
      await invalidateDiscipline(schoolId, viewerId); controller.signal.throwIfAborted(); onSaved(result.receipt?.recordId || result.record?.id || serverDraft.current.id);
    } catch (failure) { fail(failure, controller); if (failure.response?.status === 409 && !controller.signal.aborted) { finalRequest.current = null; setPending(false); setReviewed(false); setStage('edit'); } }
    finally { working.current = false; if (!controller.signal.aborted) setBusy(false); }
  };
  const cancel = async () => {
    const controller = lifetime.current; if (working.current || !controller || controller.signal.aborted) return;
    if (!serverDraft.current && !transaction.current) { onClose(); return; }
    working.current = true; setBusy(true);
    try {
      const api = disciplineApi(schoolId, controller.signal);
      if (!serverDraft.current) { const result = await api.createDraft(transaction.current.payload); if (result.receipt) { controller.signal.throwIfAborted(); onSaved(result.receipt.recordId); return; } rememberDraft(result.draft); }
      if (!cancelRequest.current) { const latest = (await api.draft(serverDraft.current.id)).draft; cancelRequest.current = { clientRequestId: crypto.randomUUID(), revision: latest.revision }; }
      await api.cancelDraft(serverDraft.current.id, cancelRequest.current); controller.signal.throwIfAborted(); onClose();
    } catch (failure) { fail(failure, controller); }
    finally { working.current = false; if (!controller.signal.aborted) setBusy(false); }
  };
  return <Dialog open onOpenChange={open => { if (!open && !busy) { if (changed) setCloseConfirm(true); else onClose(); } }}><DialogContent className="discipline-composer"><DialogHeader><DialogTitle>Add incident</DialogTitle><DialogDescription>Drafts stay private until you save the disciplinary record.</DialogDescription></DialogHeader>
    {denied ? <p role="alert">Access to this student or school has changed. Close this draft and refresh.</p> : <>
    {stage === 'edit' ? <fieldset disabled={busy || pending}>
      <label>Find a student<Input value={search} onChange={event => setSearch(event.target.value)} /></label><label>Student<select aria-label="Student" value={form.studentId} onChange={event => edit({ studentId: event.target.value, groupId: '' })}><option value="">Choose a student</option>{students.map(student => <option key={student.id} value={student.id}>{student.name}</option>)}</select></label>
      {query.hasNextPage && <Button variant="outline" onClick={() => query.fetchNextPage()}>More students</Button>}{query.isError && <p role="alert">{myDeskError(query.error)}</p>}
      <label>Class (optional)<select aria-label="Class (optional)" value={form.groupId} onChange={event => edit({ groupId: event.target.value })}><option value="">No class specified</option>{(selected?.classes || []).map(group => <option key={group.id} value={group.id}>{group.name}</option>)}</select></label>
      <label>Incident date<Input type="date" value={form.entryDate} onChange={event => edit({ entryDate: event.target.value })} /></label>
      <div className="discipline-actions"><label className="discipline-check"><input type="checkbox" checked={form.referralRecorded} onChange={event => edit({ referralRecorded: event.target.checked })} />Referral</label><label className="discipline-check"><input type="checkbox" checked={form.detentionAssigned} onChange={event => edit({ detentionAssigned: event.target.checked })} />Detention assigned</label></div>
      {form.detentionAssigned && <label>Detention dates, if specified<textarea placeholder="YYYY-MM-DD, one date per line" value={form.detentionDates} onChange={event => edit({ detentionDates: event.target.value })} /><small>Several dates still count as one assignment.</small></label>}
      <label>Title (optional)<Input maxLength={160} value={form.title} onChange={event => edit({ title: event.target.value })} /></label><label>Factual information<textarea rows={5} maxLength={5000} value={form.body} onChange={event => edit({ body: event.target.value })} /></label>
      <input hidden ref={picker} type="file" accept="application/pdf,image/jpeg,image/png,image/webp" multiple onChange={choose} /><input hidden ref={camera} type="file" accept="image/jpeg,image/png,image/webp" capture="environment" onChange={choose} />
      <div className="discipline-actions"><Button variant="outline" onClick={() => picker.current.click()}>Attach forms</Button><Button variant="outline" onClick={() => camera.current.click()}>Take a photo</Button></div>
      {files.map((file, index) => <div key={index}>{file.name}<Button variant="ghost" onClick={() => setFiles(values => values.filter((_, i) => i !== index))}>Remove</Button></div>)}
      {!!savedDraft?.attachments.length && <p>{savedDraft.attachments.length} uploaded forms retained in this draft.</p>}
    </fieldset> : <section><h2>Review the record</h2><p><strong>{savedDraft?.studentName || selected?.name}</strong> · {form.entryDate}</p>{savedDraft?.className && <p>{savedDraft.className}</p>}<p>{form.referralRecorded ? 'Referral' : ''}{form.referralRecorded && form.detentionAssigned ? ' and ' : ''}{form.detentionAssigned ? 'one detention assignment' : ''}</p>{form.detentionAssigned && form.detentionDates && <p>Assigned dates: {form.detentionDates}</p>}<h3>{form.title}</h3><p className="discipline-body">{form.body}</p><p>{savedDraft?.attachments.length || 0} selected forms</p>
      {savedDraft?.attachments.filter(file => file.status === 'ready').map(file => <DisciplineAttachment key={file.id} access={access} recordId={savedDraft.id} attachment={file} draft />)}
      {!!candidates.length && <div className="discipline-notice"><h3>Possible existing incidents</h3>{candidates.map(candidate => <p key={candidate.id}>{candidate.entryDate} · {candidate.title || 'Incident'} <a href={withDisciplineEntry(`/classpilot/discipline-records/${encodeURIComponent(candidate.id)}`, params)} target="_blank" rel="noreferrer">Review existing record</a></p>)}
        <label>How should this form be saved?<select aria-label="How should this form be saved?" disabled={pending} value={duplicateAction} onChange={event => { setDuplicateAction(event.target.value); setReviewed(false); }}><option value="">Choose after reviewing matches</option><option value="separate">Separate incident</option><option value="add_evidence">Add evidence to existing incident</option></select></label>
        {duplicateAction === 'add_evidence' && <><label>Existing incident<select aria-label="Existing incident" value={existingId} disabled={pending} onChange={event => { setExistingId(event.target.value); setReviewed(false); }}><option value="">Choose an incident</option>{candidates.filter(candidate => candidate.canAddEvidence).map(candidate => <option key={candidate.id} value={candidate.id}>{candidate.entryDate} — {candidate.title || 'Incident'}</option>)}</select></label><label>Reason<textarea disabled={pending} value={reason} maxLength={2000} onChange={event => { setReason(event.target.value); setReviewed(false); }} /></label><p>The existing incident and counts stay unchanged; the selected forms become additional evidence.</p></>}
      </div>}
      <p className="discipline-visibility">Visible to school administrators and teachers currently assigned to this student.</p><label className="discipline-check"><input type="checkbox" disabled={pending} checked={reviewed} onChange={event => setReviewed(event.target.checked)} />I reviewed the student, date, factual information, and selected forms.</label>
    </section>}
    {error && <p role="alert">{error} Your draft is preserved.</p>}
    <div className="discipline-actions"><Button variant="outline" disabled={busy} onClick={() => setCloseConfirm(true)}>Cancel</Button>{stage === 'review' && <Button variant="outline" disabled={busy || pending} onClick={() => { setStage('edit'); setReviewed(false); }}>Edit draft</Button>}<Button disabled={busy || (stage === 'review' && (!reviewed || !duplicateAction))} onClick={stage === 'edit' ? prepare : save}>{busy ? 'Saving…' : pending ? 'Retry save' : stage === 'edit' ? 'Review incident' : 'Save disciplinary record'}</Button></div>
    </>}
    {closeConfirm && <section className="discipline-notice"><p>Discard this unfinished entry? Published records are never removed by cancelling a draft.</p><Button variant="outline" disabled={busy} onClick={() => setCloseConfirm(false)}>Keep editing</Button><Button variant="destructive" disabled={busy} onClick={denied ? onClose : cancel}>Discard draft</Button></section>}
  </DialogContent></Dialog>;
}
