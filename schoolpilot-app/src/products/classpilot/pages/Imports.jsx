import { useEffect, useRef, useState } from 'react';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, FileScan, LockKeyhole, Camera, Upload, Plus } from 'lucide-react';
import { Button } from '../../../components/ui/button';
import { ThemeToggle } from '../../../components/ThemeToggle';
import { useMyDeskAccess, useMyDeskClasses } from '../hooks/useMyDesk';
import { myDeskApi, attachmentDigest, invalidateMyDesk } from '../lib/myDesk';
import { myDeskKeys, myDeskError } from '../lib/myDeskModel';
import { validateImportFiles, importExpiry } from '../lib/importReviewModel';
import { guardPrivateWorkspaceHistory } from '../lib/privateWorkspaceNavigation';
import { ImportConfirm } from '../components/ImportShared';
import ImportWorkspace from '../components/ImportWorkspace';
import '../myDesk.css';
import '../imports.css';

export function ImportShell({ children, onNavigate }) {
  const navigate = useNavigate();
  return <div className="mydesk-page import-page min-h-screen"><header className="mydesk-header"><Button variant="ghost" onClick={() => (onNavigate || navigate)('/classpilot/my-desk')}><ArrowLeft className="size-4" />My Desk</Button><ThemeToggle /></header>{children}</div>;
}

export default function Imports() {
  const access = useMyDeskAccess(); const { importId } = useParams();
  if (!access.importsEnabled) return <ImportShell><section className="mydesk-access"><h1>{access.loading ? 'Opening paperwork…' : 'Paperwork import is unavailable'}</h1><p>{access.loading ? 'Loading your private workspace.' : 'Import is not enabled for this account and school.'}</p></section></ImportShell>;
  return importId ? <ImportLoader key={`${access.schoolId}:${access.viewerId}:${importId}`} access={access} importId={importId} /> : <ImportLibrary key={`${access.schoolId}:${access.viewerId}`} access={access} />;
}

function ImportLoader({ access, importId }) {
  const query = useQuery({ queryKey: myDeskKeys.import(access.schoolId, access.viewerId, importId), queryFn: ({ signal }) => myDeskApi(access.schoolId, signal).import(importId), retry: false, gcTime: 0, refetchOnMount: 'always', refetchOnWindowFocus: false });
  if (query.isPending) return <ImportShell><p role="status" className="mydesk-access">Opening your paperwork…</p></ImportShell>;
  if (query.isError && (!query.data || [401, 403, 404].includes(query.error?.response?.status))) return <ImportShell><section className="mydesk-access" role="alert"><h1>Import unavailable</h1><p>{myDeskError(query.error)}</p><Button onClick={() => query.refetch()}>Try again</Button></section></ImportShell>;
  return <ImportWorkspace access={access} initialImport={query.data.import} Shell={ImportShell} />;
}

export function ImportLibrary({ access }) {
  const navigate = useNavigate(); const location = useLocation(); const [creating, setCreating] = useState(false);
  const leaveRef = useRef(null);
  const query = useInfiniteQuery({ queryKey: myDeskKeys.imports(access.schoolId, access.viewerId), initialPageParam: '', queryFn: ({ signal, pageParam }) => myDeskApi(access.schoolId, signal).imports(pageParam), getNextPageParam: page => page.nextCursor || undefined, retry: false });
  const rows = query.data?.pages.flatMap(page => page.imports) || [];
  return <ImportShell onNavigate={path => leaveRef.current ? leaveRef.current(path) : navigate(path)}><main className="mydesk-shell import-library"><div className="mydesk-intro"><div><div className="mydesk-title-line"><FileScan /><h1>Paperwork</h1></div><p>Turn paper forms into notes you have checked.</p><p className="mydesk-privacy"><LockKeyhole className="size-3.5" />Only you can see these imports.</p></div><Button onClick={() => setCreating(true)}><Plus className="size-4" />New import</Button></div>
    {creating ? <ImportUpload key="new" leaveRef={leaveRef} access={access} initialGroupId={location.state?.groupId} onClose={() => setCreating(false)} onStarted={batch => navigate(`/classpilot/my-desk/imports/${batch.id}`)} /> : <>
      <div className="import-explainer"><span>1. Upload your forms</span><span>2. Check pages and students</span><span>3. Save your notes together</span></div>
      {query.isPending ? <p role="status">Loading saved progress…</p> : query.isError ? <div role="alert"><p>{myDeskError(query.error)}</p><Button onClick={() => query.refetch()}>Try again</Button></div> : !rows.length ? <section className="mydesk-empty"><FileScan /><h2>A little less retyping.</h2><p>Import detention or referral forms, including several forms on one page. You decide what becomes a note.</p></section> : <div className="import-list">{rows.map(batch => <article key={batch.id}><div><h2>Paperwork import</h2><p>{batch.pageCount || 0} pages · {batch.status}</p><p className="import-muted">{batch.status === 'completed' ? 'Saved to your private notes' : `Review expires ${importExpiry(batch.expiresAt || batch.uploadExpiresAt)}`}</p></div><Button variant="outline" onClick={() => navigate(`/classpilot/my-desk/imports/${batch.id}`)}>{batch.status === 'completed' ? 'View saved notes' : 'Resume review'}</Button></article>)}</div>}
      {query.hasNextPage && <Button variant="outline" disabled={query.isFetchingNextPage} onClick={() => query.fetchNextPage()}>Load more imports</Button>}
    </>}
  </main></ImportShell>;
}

export function ImportUpload({ access, initialGroupId, onClose, onStarted, leaveRef }) {
  const { schoolId, viewerId } = access; const navigate = useNavigate();
  const classes = useMyDeskClasses(schoolId, viewerId); const [groups, setGroups] = useState(initialGroupId ? [initialGroupId] : []); const [files, setFiles] = useState([]);
  const selectedGroups = groups.filter(id => classes.data?.current?.some(group => group.id === id));
  const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const [progress, setProgress] = useState(''); const [pending, setPending] = useState(false); const [confirm, setConfirm] = useState(null);
  const [cancelling, setCancelling] = useState(false);
  const transaction = useRef(null), lifetime = useRef(null), working = useRef(false), picker = useRef(null), camera = useRef(null);
  const dirty = files.length > 0 || groups.length > 0 || pending;
  useEffect(() => { const controller = new AbortController(); lifetime.current = controller; return () => controller.abort(); }, []);
  useEffect(() => { if (!dirty) return; const warn = event => { event.preventDefault(); event.returnValue = ''; }; window.addEventListener('beforeunload', warn); return () => window.removeEventListener('beforeunload', warn); }, [dirty]);
  useEffect(() => { if (!dirty) return; return guardPrivateWorkspaceHistory(path => setConfirm({ title: 'Leave this upload?', description: 'Files that have not finished uploading will need to be selected again. Uploaded private sources expire automatically.', label: 'Leave upload', action: () => navigate(path) })); }, [dirty, navigate]);
  useEffect(() => { if (!leaveRef) return; leaveRef.current = path => dirty ? setConfirm({ title: 'Leave this upload?', description: 'Files that have not finished uploading will need to be selected again. Uploaded private sources expire automatically.', label: 'Leave upload', action: () => navigate(path) }) : navigate(path); return () => { leaveRef.current = null; }; }, [dirty, leaveRef, navigate]);
  const cancel = async () => {
    const controller = lifetime.current; if (working.current || !controller || controller.signal.aborted) return;
    if (!transaction.current) { onClose(); return; }
    working.current = true; setBusy(true); setCancelling(true); setError('');
    try {
      const tx = transaction.current, api = myDeskApi(schoolId, controller.signal);
      // A lost create response still resolves through the same idempotent key.
      if (!tx.batch) tx.batch = (await api.createImport(tx.create)).import;
      if (!tx.cancel) { const fresh = (await api.import(tx.batch.id)).import; tx.cancel = { requestId: crypto.randomUUID(), revision: fresh.revision }; }
      await api.cancelImport(tx.batch.id, tx.cancel); controller.signal.throwIfAborted(); await invalidateMyDesk(schoolId, viewerId); controller.signal.throwIfAborted(); onClose();
    } catch (failure) { if (!controller.signal.aborted) setError(myDeskError(failure)); }
    finally { working.current = false; if (!controller.signal.aborted) setBusy(false); }
  };
  const close = () => dirty ? setConfirm({ title: 'Cancel this upload?', description: 'This clears selected files and removes any reserved private import. No notes will be added.', label: 'Cancel upload', action: cancel }) : onClose();
  const choose = event => { const selected = [...files, ...Array.from(event.target.files || [])]; event.target.value = ''; const problem = validateImportFiles(selected); if (problem) setError(problem); else { setFiles(selected); setError(''); } };
  const start = async () => {
    const controller = lifetime.current; if (working.current || !controller || controller.signal.aborted) return;
    const api = myDeskApi(schoolId, controller.signal); working.current = true; setBusy(true); setError('');
    try {
      if (!transaction.current) {
        const problem = validateImportFiles(files); if (problem) throw new Error(problem); if (!selectedGroups.length) throw new Error('Select the current classes whose students are on these forms.');
        transaction.current = { create: { clientRequestId: crypto.randomUUID(), selectedGroupIds: [...selectedGroups], expectedSourceCount: files.length }, files: files.map(file => ({ file, clientRequestId: crypto.randomUUID() })) }; setPending(true);
      }
      const tx = transaction.current;
      if (!tx.batch) { setProgress('Opening your private import…'); tx.batch = (await api.createImport(tx.create)).import; }
      for (const [index, entry] of tx.files.entries()) {
        if (entry.uploaded) continue; setProgress(`Uploading ${index + 1} of ${tx.files.length}…`);
        if (!entry.digest) entry.digest = await attachmentDigest(entry.file); controller.signal.throwIfAborted();
        if (!entry.asset) entry.asset = (await api.reserveImportAsset(tx.batch.id, { clientRequestId: entry.clientRequestId, filename: entry.file.name, contentType: entry.file.type, size: entry.file.size, sha256: entry.digest })).asset;
        await api.uploadImportAsset(tx.batch.id, entry.asset.id, entry.file); entry.uploaded = true;
      }
      if (!tx.process) { const fresh = (await api.import(tx.batch.id)).import; tx.process = { requestId: crypto.randomUUID(), revision: fresh.revision }; }
      setProgress('Preparing your private drafts…'); const result = await api.processImport(tx.batch.id, tx.process); controller.signal.throwIfAborted(); await invalidateMyDesk(schoolId, viewerId); controller.signal.throwIfAborted(); onStarted(result.import);
    } catch (failure) { if (!controller.signal.aborted) setError(myDeskError(failure)); }
    finally { working.current = false; if (!controller.signal.aborted) setBusy(false); }
  };
  return <section className="import-upload"><div><p className="import-eyebrow">New import</p><h2>Gather your paperwork</h2><p>Up to 5 PDFs or JPEG, PNG, WebP photos · 10 MiB each · 20 pages · 50 forms.</p></div>
    <fieldset disabled={busy || pending}><legend>Which current classes are on these forms?</legend><p className="import-muted">Choose every relevant class. You will match each subject student during review.</p><div className="import-class-options">{classes.data?.current?.map(group => <label key={group.id}><input type="checkbox" checked={groups.includes(group.id)} onChange={event => setGroups(previous => event.target.checked ? [...previous, group.id].slice(0, 20) : previous.filter(id => id !== group.id))} />{group.name}</label>)}</div>{classes.isError && <p role="alert">Classes could not be loaded. <button type="button" onClick={() => classes.refetch()}>Try again</button></p>}</fieldset>
    <input ref={picker} type="file" accept="image/jpeg,image/png,image/webp,application/pdf" multiple hidden onChange={choose} /><input ref={camera} type="file" accept="image/jpeg,image/png,image/webp" capture="environment" hidden onChange={choose} />
    <div className="import-file-zone"><FileScan className="size-8" /><p>Several forms on one page are welcome.</p><div className="import-actions"><Button variant="outline" disabled={busy || pending} onClick={() => picker.current.click()}><Upload className="size-4" />Choose files</Button><Button variant="outline" disabled={busy || pending} onClick={() => camera.current.click()}><Camera className="size-4" />Take a photo</Button></div></div>
    {files.length > 0 && <ul className="import-files">{files.map((file, index) => <li key={`${file.name}:${index}`}><span>{file.name} <small>{(file.size / 1048576).toFixed(1)} MiB</small></span><Button variant="ghost" disabled={busy || pending} onClick={() => setFiles(previous => previous.filter((_, i) => i !== index))}>Remove</Button></li>)}</ul>}
    <div className="import-notice"><strong>Prepare drafts with {access.importProvider || 'Anthropic'}</strong><p>These documents will be sent to our AI provider to prepare private drafts. Review every form before saving. Existing notes and class rosters are not sent.</p><p>Private review progress expires after 7 days. Nothing is added to your notes until you save.</p>{access.importLimits && <p>Daily allowance: <strong>{Number(access.importLimits.teacherDailyPages).toLocaleString()} pages per teacher</strong> · <strong>{Number(access.importLimits.schoolDailyPages).toLocaleString()} pages per school</strong>. Preparing drafts, re-reading forms, and reading newly added forms count toward these allowances.</p>}</div>
    {error && <p className="import-error" role="alert">{error}</p>}{busy && <p role="status">{progress}</p>}
    <div className="import-actions"><Button disabled={busy || (!pending && (!files.length || !selectedGroups.length))} onClick={cancelling ? cancel : start}>{busy ? 'Working…' : cancelling ? 'Retry cancellation' : pending ? 'Retry import' : 'Send files and prepare drafts'}</Button><Button variant="ghost" disabled={busy} onClick={close}>Cancel</Button></div><ImportConfirm request={confirm} onClose={() => setConfirm(null)} />
  </section>;
}
