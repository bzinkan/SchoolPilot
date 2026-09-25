import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Check, FileScan, LockKeyhole } from 'lucide-react';
import { Button } from '../../../components/ui/button';
import { myDeskApi, invalidateMyDesk } from '../lib/myDesk';
import { myDeskError } from '../lib/myDeskModel';
import { myDeskKeys } from '../lib/myDeskModel';
import { queryClient } from '../../../lib/queryClient';
import { importProgress, importExpiry } from '../lib/importReviewModel';
import { guardPrivateWorkspaceHistory } from '../lib/privateWorkspaceNavigation';
import { ImportConfirm } from './ImportShared';
import ImportPages from './ImportPages';
import ImportForm from './ImportForm';
import { useMyDeskClasses, useMyDeskStudents } from '../hooks/useMyDesk';

export default function ImportWorkspace({ access, initialImport, Shell }) {
  const navigate = useNavigate(); const [batch, setBatch] = useState(initialImport);
  const [step, setStep] = useState('pages'), [itemId, setItemId] = useState(initialImport.items?.[0]?.id || '');
  const [pageSelection, setPageSelection] = useState({}), [editorSession, setEditorSession] = useState(0);
  const [busy, setBusy] = useState(false), [pending, setPending] = useState(null), [error, setError] = useState(''), [conflict, setConflict] = useState(false), [dirty, setDirty] = useState(false), [denied, setDenied] = useState(false), [confirm, setConfirm] = useState(null);
  const lifetime = useRef(null), working = useRef(false), saveDraftRef = useRef(null);
  const progress = importProgress(batch), locked = busy || Boolean(pending);
  const uploadedSources = (batch.assets || []).filter(asset => asset.kind === 'source' && asset.status === 'ready').length;
  const sourcesReady = batch.expectedSourceCount > 0 && uploadedSources === batch.expectedSourceCount;
  const classes = useMyDeskClasses(access.schoolId, access.viewerId);
  const active = batch.items?.find(item => item.id === itemId) || batch.items?.[0];
  useEffect(() => { const controller = new AbortController(); lifetime.current = controller; return () => controller.abort(); }, []);
  useEffect(() => { if (!dirty && !pending && !busy) return; const warn = event => { event.preventDefault(); event.returnValue = ''; }; window.addEventListener('beforeunload', warn); return () => window.removeEventListener('beforeunload', warn); }, [dirty, pending, busy]);
  useEffect(() => { if (!dirty && !pending && !busy) return; return guardPrivateWorkspaceHistory(path => setConfirm({ title: 'Leave with unsaved changes?', description: 'Your last saved review progress stays private. Changes still on this screen will be discarded.', label: 'Discard changes and leave', action: () => navigate(path) })); }, [dirty, pending, busy, navigate]);
  const go = path => dirty || pending ? setConfirm({ title: 'Leave with unsaved changes?', description: 'Save this form or crop first to keep your latest changes. Your previously saved progress is retained until expiry.', label: 'Discard changes and leave', action: () => navigate(path) }) : navigate(path);
  const switchView = action => dirty ? setConfirm({ title: 'Discard these unsaved changes?', description: 'The last saved version is kept. Save this form or crop before switching to keep your changes.', label: 'Discard changes', action: () => { setDirty(false); action(); } }) : action();
  const refresh = async () => {
    const controller = lifetime.current; if (working.current || !controller || controller.signal.aborted) return;
    working.current = true; setBusy(true);
    try { const result = await myDeskApi(access.schoolId, controller.signal).import(batch.id); controller.signal.throwIfAborted(); setBatch(result.import); queryClient.setQueryData(myDeskKeys.import(access.schoolId, access.viewerId, batch.id), { import: result.import }); setEditorSession(previous => previous + 1); setPending(null); setDirty(false); setConflict(false); setError(''); }
    catch (failure) { if (!controller.signal.aborted) { if ([401, 403, 404].includes(failure.response?.status)) setDenied(true); setError(myDeskError(failure)); } }
    finally { working.current = false; if (!controller.signal.aborted) setBusy(false); }
  };
  const needsPoll = ['queued', 'processing'].includes(batch.status) || batch.items?.some(item => item.extractionStatus === 'pending');
  useEffect(() => {
    if (!needsPoll || dirty || pending || busy) return;
    const controller = new AbortController(), api = myDeskApi(access.schoolId, controller.signal);
    let running = false;
    const timer = setInterval(async () => {
      if (running) return; running = true;
      try { const result = await api.import(batch.id); controller.signal.throwIfAborted(); setBatch(result.import); queryClient.setQueryData(myDeskKeys.import(access.schoolId, access.viewerId, batch.id), { import: result.import }); }
      catch (failure) { if (!controller.signal.aborted && failure.name !== 'AbortError') { if ([401, 403, 404].includes(failure.response?.status)) setDenied(true); setError(myDeskError(failure)); } }
      finally { running = false; }
    }, 2000);
    return () => { controller.abort(); clearInterval(timer); };
  }, [needsPoll, dirty, pending, busy, access.schoolId, access.viewerId, batch.id]);

  const run = async (kind, payload = {}, targetId, after, previous) => {
    const controller = lifetime.current; if (working.current || (!previous && pending) || !controller || controller.signal.aborted) return;
    const tx = previous || { kind, targetId, payload: { requestId: crypto.randomUUID(), revision: batch.revision, ...structuredClone(payload) }, after };
    working.current = true; setBusy(true); setPending(tx); setError(''); setConflict(false);
    try {
      const api = myDeskApi(access.schoolId, controller.signal);
      const methods = { batch: 'updateImport', item: 'updateImportItem', add: 'createImportItem', reread: 'rereadImportItem', join: 'joinImportItem', commit: 'commitImport', cancel: 'cancelImport', process: 'processImport' };
      const result = targetId ? await api[methods[tx.kind]](batch.id, tx.targetId, tx.payload) : await api[methods[tx.kind]](batch.id, tx.payload);
      controller.signal.throwIfAborted(); setBatch(result.import); queryClient.setQueryData(myDeskKeys.import(access.schoolId, access.viewerId, batch.id), { import: result.import }); setPending(null); setDirty(false);
      if (tx.kind === 'commit' || tx.kind === 'cancel') await invalidateMyDesk(access.schoolId, access.viewerId);
      controller.signal.throwIfAborted(); tx.after?.(result.import);
    } catch (failure) { if (!controller.signal.aborted && failure.name !== 'AbortError') {
      const status = failure.response?.status, code = failure.response?.data?.code || '';
      if ([401, 403, 404].includes(status)) setDenied(true);
      setError(myDeskError(failure));
      const stale = code.endsWith('REVISION_CONFLICT') || code.endsWith('REQUEST_CONFLICT');
      setConflict(stale);
      if (status >= 400 && status < 500 && !stale && ![408, 429].includes(status)) setPending(null);
      if (code.endsWith('DAILY_LIMIT')) setPending(null);
      if (code.endsWith('ROSTER_CHANGED') && tx.payload.groupId) void queryClient.invalidateQueries({ queryKey: myDeskKeys.students(access.schoolId, access.viewerId, tx.payload.groupId) });
    } }
    finally { working.current = false; if (!controller.signal.aborted) setBusy(false); }
  };
  const saveLater = () => { if (dirty) saveDraftRef.current?.(() => navigate('/classpilot/my-desk/imports')); else navigate('/classpilot/my-desk/imports'); };
  const next = () => { const items = batch.items || [], index = items.findIndex(item => item.id === active?.id); const remaining = items.slice(index + 1).find(item => !item.reviewed && !item.excluded) || items.find(item => !item.reviewed && !item.excluded && item.id !== active?.id); if (remaining) setItemId(remaining.id); else setStep('save'); };
  if (denied) return <Shell><section className="mydesk-access" role="alert"><h1>Import unavailable</h1><p>{error || 'This private import is no longer available for this account.'}</p></section></Shell>;
  const terminal = ['completed', 'expired', 'cancelled'].includes(batch.status);
  return <Shell onNavigate={go}><main className="mydesk-shell import-workspace"><div className="mydesk-intro"><div><div className="mydesk-title-line"><FileScan /><h1>Review your paperwork</h1></div><p className="mydesk-privacy"><LockKeyhole className="size-3.5" />Private drafts · {terminal ? batch.status : `Review expires ${importExpiry(batch.expiresAt || batch.uploadExpiresAt)}`}</p></div>{!terminal && <Button variant="outline" disabled={locked} onClick={saveLater}>Save for later</Button>}</div>
    {error && <div role="alert" className="import-error"><p>{error}</p>{pending && !conflict && <Button variant="outline" disabled={busy} onClick={() => run(pending.kind, pending.payload, pending.targetId, pending.after, pending)}>Retry last action</Button>}{conflict && <><p>Your changes are still on this screen. Review the saved version before trying again.</p><Button variant="outline" disabled={busy} onClick={() => setConfirm({ title: 'Reload saved review?', description: 'This discards unsaved changes on this screen and opens the latest saved progress.', label: 'Reload saved review', action: refresh })}>Reload saved review</Button></>}</div>}
    {batch.status === 'completed' ? <section className="import-complete"><Check /><h2>Your notes are saved.</h2><p>{batch.commitReceipt?.notes?.length || batch.items?.filter(item => item.noteId).length || 0} forms were added to your private notebook.</p><div className="import-actions">{batch.commitReceipt?.notes?.map((receipt, index) => <Button key={receipt.noteId} variant="outline" onClick={() => navigate(`/classpilot/my-desk?note=${encodeURIComponent(receipt.noteId)}`)}>Open saved note {index + 1}</Button>)}</div><Button onClick={() => navigate('/classpilot/my-desk')}>Open My Desk notes</Button></section> : terminal ? <section className="mydesk-empty"><h2>{batch.status === 'expired' ? 'This review has expired.' : 'This import was cancelled.'}</h2><p>Start a new import to prepare these forms again.</p><Button onClick={() => navigate('/classpilot/my-desk/imports')}>Back to paperwork</Button></section> : ['uploading', 'queued', 'processing', 'failed'].includes(batch.status) ? <section className="import-wait"><h2>{batch.status === 'failed' ? 'Your forms need another try.' : batch.status === 'uploading' ? sourcesReady ? 'Your files are ready.' : 'This upload was not finished.' : 'Preparing pages and draft forms…'}</h2><p>{batch.status === 'uploading' ? sourcesReady ? 'Prepare private drafts from these uploaded files when you are ready.' : 'If an upload was interrupted, cancel this import and select the source files again.' : 'You can leave and resume here. No notes are saved during preparation.'}</p>{(batch.status === 'failed' || (batch.status === 'uploading' && sourcesReady)) && <><p className="import-notice">These documents will be sent to our AI provider to prepare private drafts. Review every form before saving. Existing notes and class rosters are not sent.</p><Button disabled={locked} onClick={() => run('process')}>{batch.status === 'failed' ? 'Retry preparation' : 'Send files and prepare drafts'}</Button></>}<Button variant="ghost" disabled={locked} onClick={() => setConfirm({ title: 'Cancel this import?', description: 'This removes the private review. No notes will be added.', label: 'Cancel import', action: () => run('cancel') })}>Cancel import</Button></section> : <>
      <details className="import-change-classes"><summary>Selected classes ({batch.selectedGroupIds?.length || 0})</summary><p>Changing classes clears all form review confirmations. Your edited fields are kept.</p><div className="import-class-options">{classes.data?.current?.map(group => <label key={group.id}><input type="checkbox" checked={batch.selectedGroupIds.includes(group.id)} disabled={locked || dirty || (batch.selectedGroupIds.length === 1 && batch.selectedGroupIds.includes(group.id)) || (batch.selectedGroupIds.length >= 20 && !batch.selectedGroupIds.includes(group.id))} onChange={event => { const selectedGroupIds = event.target.checked ? [...batch.selectedGroupIds, group.id] : batch.selectedGroupIds.filter(id => id !== group.id); setConfirm({ title: 'Change selected classes?', description: 'Your edited text stays. Check every form again after changing the selected classes.', label: 'Change classes', action: () => run('batch', { selectedGroupIds }) }); }} />{group.name}</label>)}</div></details><nav className="import-steps" aria-label="Import review steps">{[['pages', '1. Check pages', `${progress.accounted}/${progress.pages} accounted for`], ['forms', '2. Review forms', `${progress.reviewed}/${progress.included} reviewed`], ['save', '3. Save together', `${progress.excluded} excluded`]].map(([key, label, hint]) => <button key={key} disabled={locked} aria-current={step === key ? 'step' : undefined} onClick={() => switchView(() => setStep(key))}><strong>{label}</strong><small>{hint}</small></button>)}</nav>
      {step === 'pages' && <ImportPages key={`pages:${batch.id}:${batch.revision}:${editorSession}`} selection={pageSelection} onSelection={setPageSelection} access={access} batch={batch} locked={locked} run={run} onDirty={setDirty} saveDraftRef={saveDraftRef} onForms={() => setStep('forms')} />}
      {step === 'forms' && <><div className="import-form-select"><label>Form<select aria-label="Choose form" disabled={locked} value={active?.id || ''} onChange={event => switchView(() => setItemId(event.target.value))}>{batch.items?.map(item => <option key={item.id} value={item.id}>Form {item.ordinal + 1} · {item.excluded ? 'Excluded' : item.reviewed ? 'Reviewed' : 'Needs review'}</option>)}</select></label></div>{active ? <ImportForm key={`${active.id}:${active.revision}:${editorSession}`} access={access} batch={batch} item={active} locked={locked} run={run} onDirty={setDirty} saveDraftRef={saveDraftRef} onNext={next} /> : <p>No forms were found. Add a form on the Pages step.</p>}</>}
      {step === 'save' && <section className="import-final"><h2>Save {progress.included} {progress.included === 1 ? 'note' : 'notes'} together</h2><p>Only reviewed form images and the fields below become notes. Full original pages are not attached to individual notes.</p><ul className="import-final-list">{batch.items?.map(item => <li key={item.id}><span className="import-number">{item.ordinal + 1}</span><div><strong>{item.excluded ? 'Excluded' : item.title || 'Paperwork note'}</strong><p>{item.excluded ? 'Will not be saved' : `${item.entryDate || 'Date needed'} · ${item.reviewed ? 'Reviewed' : 'Needs review'}`}</p><ImportTargetLabel access={access} item={item} classes={classes.data?.current || []} /><small>{item.body?.slice(0, 130)}</small></div><Button variant="ghost" disabled={locked} onClick={() => { setItemId(item.id); setStep('forms'); }}>Review</Button></li>)}</ul><div className="import-notice"><p>{progress.accounted} of {progress.pages} pages accounted for · {progress.reviewed} of {progress.included} included forms reviewed · {progress.excluded} excluded.</p>{!progress.ready && <p>Check every page and review every included form before saving.</p>}</div><Button disabled={locked || !progress.ready} onClick={() => run('commit', { itemIds: batch.items.filter(item => !item.excluded).map(item => item.id) })}>{busy ? 'Saving together…' : `Save all ${progress.included} notes`}</Button></section>}
      <p className="import-save-state" role="status">{busy ? 'Saving private progress…' : pending ? 'Action awaiting confirmation. Retry or resolve the conflict above.' : dirty ? 'Unsaved changes on this screen' : 'Review progress saved privately'}</p>
      <Button variant="ghost" disabled={locked} onClick={() => setConfirm({ title: 'Cancel this import?', description: 'This removes the private review and its source files. No notes will be added.', label: 'Cancel import', action: () => run('cancel') })}>Cancel import</Button>
    </>}
    <ImportConfirm request={confirm} onClose={() => setConfirm(null)} />
  </main></Shell>;
}




function ImportTargetLabel({ access, item, classes }) {
  const students = useMyDeskStudents(access.schoolId, access.viewerId, item.excluded ? '' : item.groupId);
  if (item.excluded) return null;
  const student = students.data?.students?.find(value => value.id === item.studentId);
  return <p>{classes.find(value => value.id === item.groupId)?.name || 'Class needed'} · {student?.name || [student?.firstName, student?.lastName].filter(Boolean).join(' ') || 'Student needs confirmation'}</p>;
}
