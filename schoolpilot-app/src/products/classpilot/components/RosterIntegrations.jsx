import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiRequest } from '../../../lib/queryClient';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../../../components/ui/card';
import { Button } from '../../../components/ui/button';
import { Badge } from '../../../components/ui/badge';
import { useAuth } from '../../../contexts/AuthContext';
import RosterChangeReview from './RosterChangeReview';

const BASE = '/classpilot/roster-integrations';
const inputClass = 'w-full rounded-md border bg-background px-3 py-2 text-sm';
const errorText = (error) => error?.response?.data?.error || error?.message || 'The roster action failed.';
const label = (key) => key.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/_/g, ' ');

function PersonMapping({ row, connectionId, selected, onChange }) {
  const [search, setSearch] = useState('');
  const { data } = useQuery({ queryKey: ['roster-candidates', connectionId, row.type, search], queryFn: () => apiRequest('GET', `${BASE}/${connectionId}/candidates?type=${encodeURIComponent(row.type)}&q=${encodeURIComponent(search)}`), enabled: ['student', 'teacher', 'class'].includes(row.type) });
  return <div className="space-y-2 rounded-md border p-3">
    <p className="text-sm font-medium">{row.name}</p><p className="text-xs text-muted-foreground">{row.reason}</p>
    {['student', 'teacher', 'class'].includes(row.type) && <>
      <input className={inputClass} aria-label={`Find existing ${row.type} for ${row.name}`} placeholder={`Find existing ${row.type}`} value={search} onChange={event => setSearch(event.target.value)} />
      <select className={inputClass} aria-label={`Map ${row.name}`} value={selected || ''} onChange={event => onChange(event.target.value)}>
        <option value="">Choose an existing {row.type}</option>
        {(data?.candidates || []).map(candidate => <option key={candidate.id} value={candidate.id}>{candidate.label}</option>)}
      </select>
    </>}
  </div>;
}

export function ImportReview({ runId, connectionId, onComplete }) {
  const client = useQueryClient(); const [mapping, setMapping] = useState(null); const [approvedHash, setApprovedHash] = useState(null); const [reviewedHash, setReviewedHash] = useState(null); const [page, setPage] = useState(0);
  const { data, error } = useQuery({ queryKey: ['roster-run', runId], queryFn: () => apiRequest('GET', `${BASE}/runs/${runId}`), refetchInterval: query => ['fetching', 'applying'].includes(query.state.data?.run?.status) ? 4000 : false });
  const run = data?.run; const currentMapping = mapping || run?.mapping || { organizationIds: [] };
  const completed = useRef(false);
  useEffect(() => { if (run?.status === 'completed' && !completed.current) { completed.current = true; onComplete(); } }, [run?.status, onComplete]);
  const { data: detail, error: detailError } = useQuery({ queryKey: ['roster-run-rows', runId, run?.planHash, page], queryFn: ({ signal }) => apiRequest('GET', `${BASE}/runs/${runId}/rows?planHash=${encodeURIComponent(run.planHash)}&page=${page}`, undefined, { signal }), enabled: Boolean(run?.planHash) && run?.status !== 'completed' });
  const { data: classes } = useQuery({ queryKey: ['roster-class-candidates', connectionId], queryFn: () => apiRequest('GET', `${BASE}/${connectionId}/candidates?type=class`), enabled: Boolean(run?.planHash) });
  const action = useMutation({ mutationFn: ({ operation, body }) => apiRequest('POST', `${BASE}/runs/${runId}/${operation}`, body), onSuccess: async result => { client.setQueryData(['roster-run', runId], result); await client.invalidateQueries({ queryKey: ['roster-run-rows', runId] }); if (result.run.status === 'completed') onComplete(); } });
  const editMapping = (change) => { setMapping(previous => ({ ...(previous || run?.mapping || { organizationIds: [] }), ...change })); setApprovedHash(null); };
  if (error) return <p role="alert" className="text-sm text-destructive">{errorText(error)}</p>;
  if (!run) return <p className="text-sm">Loading import…</p>;
  const needsNewPreview = Boolean(mapping);
  const unfinished = !['completed', 'expired', 'fetching', 'applying'].includes(run.status);
  const approveHeld = Boolean(run.planHash && approvedHash === run.planHash && reviewedHash === run.planHash && !detailError);
  return <section className="space-y-4 rounded-lg border p-4" aria-label="Roster import review">
    <div className="flex flex-wrap items-center gap-2"><h4 className="font-semibold">Import review</h4><Badge variant={run.status === 'failed' ? 'destructive' : 'secondary'}>{label(run.status)}</Badge>{run.version && <span className="text-xs text-muted-foreground">{run.version}</span>}</div>
    {run.status === 'fetching' && <p className="text-sm">Fetching every Clever page. The roster will remain unchanged until a complete snapshot is ready.</p>}
    {run.status === 'applying' && <p className="text-sm" role="status">Applied {run.cursor} of {run.totalSteps} steps. Progress is saved and the worker continues if you leave this page.</p>}
    {run.errorCode && <p role="alert" className="text-sm text-destructive">{label(run.errorCode)}. {run.errorCode === 'ROSTER_WORKER_RLS_REQUIRED' ? 'The server needs its roster worker configuration enabled.' : 'Review a new preview or fetch the source again.'}</p>}
    {run.status === 'completed' && <p className="text-sm text-green-700 dark:text-green-400">Import completed. Existing student history and PINs were preserved.</p>}
    {unfinished && run.organizations.length > 0 && <fieldset className="space-y-2"><legend className="mb-2 text-sm font-medium">External organizations belonging to this school</legend>
      {run.organizations.filter(org => org.type === 'school').map(org => <label key={org.id} className="flex items-center gap-2 text-sm"><input type="checkbox" checked={currentMapping.organizationIds.includes(org.id)} onChange={event => editMapping({ organizationIds: event.target.checked ? [...currentMapping.organizationIds, org.id] : currentMapping.organizationIds.filter(id => id !== org.id) })} />{org.name}</label>)}
      <p className="text-xs text-muted-foreground">Records map to the currently active SchoolPilot school. This import does not create schools or grant licenses.</p>
    </fieldset>}
    {run.unresolvedCount > 0 && <div className="space-y-2"><p className="text-sm font-medium">Resolve {run.unresolvedCount} identity issue{run.unresolvedCount === 1 ? '' : 's'}</p>
      {run.unresolved.map(row => <PersonMapping key={`${row.type}:${row.externalId}`} row={row} connectionId={connectionId} selected={(row.type === 'class' ? currentMapping.classes : currentMapping.people)?.[row.externalId]} onChange={value => { const field = row.type === 'class' ? 'classes' : 'people'; const entries = { ...currentMapping[field] }; if (value) entries[row.externalId] = value; else delete entries[row.externalId]; editMapping({ [field]: entries }); }} />)}
      {run.unresolvedCount > run.unresolved.length && <p className="text-xs text-muted-foreground">Showing the first {run.unresolved.length}. Resolve these and preview again to continue.</p>}
    </div>}
    {Object.keys(run.summary || {}).length > 0 && <dl className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-3">{Object.entries(run.summary).map(([key, value]) => <div key={key} className="rounded bg-muted p-2"><dt className="capitalize text-muted-foreground">{label(key)}</dt><dd className="font-semibold">{value}</dd></div>)}</dl>}
    {(run.warnings || []).map(warning => <p key={warning} className="text-xs text-muted-foreground">{warning}</p>)}
    {detail?.rows?.length > 0 && <div className="space-y-2"><p className="text-sm font-medium">Proposed changes</p>
      {detail.rows.map(row => <div key={`${row.kind}:${row.externalId}`} className="rounded border p-3 text-sm"><p className="font-medium">{row.create ? 'Create' : row.kind === 'archive' ? 'Archive' : row.changes.status === 'active' ? 'Restore' : 'Link / update'} {row.kind}: {row.name || row.externalId}</p>
        {row.studentCount !== undefined && <p className="text-xs text-muted-foreground">Final roster: {row.studentCount} students · {row.coTeacherCount} co-teachers</p>}
        {!row.create && <p className="text-xs text-muted-foreground">Source may update: {row.ownedFields.length ? row.ownedFields.map(label).join(', ') : 'no existing fields'}</p>}
        {unfinished && row.kind === 'class' && row.create && <select className={`${inputClass} mt-2`} aria-label={`Link class ${row.externalId}`} value={currentMapping.classes?.[row.externalId] || ''} onChange={event => { const values = { ...currentMapping.classes }; if (event.target.value) values[row.externalId] = event.target.value; else delete values[row.externalId]; editMapping({ classes: values }); }}><option value="">Create a new class</option>{(classes?.candidates || []).map(candidate => <option key={candidate.id} value={candidate.id}>Link existing: {candidate.label}</option>)}</select>}
        {unfinished && !row.create && ['student', 'class'].includes(row.kind) && <label className="mt-2 flex items-start gap-2 text-xs"><input type="checkbox" checked={(row.kind === 'class' ? currentMapping.adoptClasses : currentMapping.adoptPeople)?.includes(row.externalId) || false} onChange={event => { const field = row.kind === 'class' ? 'adoptClasses' : 'adoptPeople'; const values = currentMapping[field] || []; editMapping({ [field]: event.target.checked ? [...values, row.externalId] : values.filter(id => id !== row.externalId) }); }} />Let this source manage the listed name, email/grade or class fields. Preview the changes before applying.</label>}
      </div>)}
      <div className="flex items-center gap-3"><Button size="sm" variant="outline" disabled={page === 0} onClick={() => setPage(value => value - 1)}>Previous</Button><span className="text-xs">{page * 50 + 1}–{Math.min(detail.total, (page + 1) * 50)} of {detail.total}</span><Button size="sm" variant="outline" disabled={(page + 1) * 50 >= detail.total} onClick={() => setPage(value => value + 1)}>Next</Button></div>
    </div>}
    {detailError && <p role="alert" className="text-sm text-destructive">{errorText(detailError)}</p>}
    {unfinished && run.planHash && <RosterChangeReview key={run.planHash} runId={runId} planHash={run.planHash} onReviewed={setReviewedHash} />}
    {unfinished && <div className="space-y-3">
      {run.holds.length > 0 && <div className="rounded border border-amber-500/50 p-3 text-sm"><p>Held for review: {run.holds.map(label).join(', ')}</p>{run.unresolvedCount === 0 && !run.holds.includes('incomplete_snapshot') && <label className="mt-2 flex items-start gap-2"><input type="checkbox" checked={approveHeld} disabled={reviewedHash !== run.planHash || Boolean(detailError) || needsNewPreview} onChange={event => setApprovedHash(event.target.checked ? run.planHash : null)} />I reviewed every page of this complete snapshot, including the named source-owned removals and before → after field changes.</label>}</div>}
      <div className="flex flex-wrap gap-2"><Button variant="outline" disabled={action.isPending || !currentMapping.organizationIds.length} onClick={async () => { await action.mutateAsync({ operation: 'preview', body: { mapping: currentMapping } }).then(() => { setMapping(null); setPage(0); }).catch(() => {}); }}>Preview changes</Button>
        <Button disabled={action.isPending || needsNewPreview || !run.planHash || Boolean(detailError) || reviewedHash !== run.planHash || run.unresolvedCount > 0 || (run.holds.length > 0 && !approveHeld)} onClick={() => action.mutate({ operation: 'apply', body: { planHash: run.planHash, approveHeld } })}>{run.cursor > 0 ? 'Resume reviewed import' : 'Apply reviewed import'}</Button></div>
    </div>}
    {action.error && <p role="alert" className="text-sm text-destructive">{errorText(action.error)}</p>}
  </section>;
}

function ConnectionPanel({ connection, onChanged }) {
  const [runId, setRunId] = useState(null); const [error, setError] = useState(''); const [busy, setBusy] = useState(false); const [history, setHistory] = useState(false);
  const { data: previous, refetch } = useQuery({ queryKey: ['roster-run-history', connection.id], queryFn: () => apiRequest('GET', `${BASE}/${connection.id}/runs`), enabled: history });
  const execute = async (operation) => { setBusy(true); setError(''); try { await operation(); } catch (failure) { setError(errorText(failure)); } finally { setBusy(false); } };
  return <div className="space-y-4 rounded-lg border p-4"><div className="flex flex-wrap items-center justify-between gap-3"><div><h3 className="font-semibold">{connection.name}</h3><p className="text-xs text-muted-foreground">{connection.provider === 'clever' ? 'Clever Secure Sync' : 'OneRoster bulk ZIP'} · {connection.status}</p></div><Button size="sm" variant="outline" onClick={() => setHistory(value => !value)}>Import history</Button></div>
    {connection.lastErrorCode && <p className="text-xs text-destructive">Last sync: {label(connection.lastErrorCode)}</p>}
    {connection.provider === 'oneroster' ? <label className="block space-y-2 text-sm"><span>Upload a complete OneRoster 1.1 or 1.2 ZIP (25 MiB maximum)</span><input type="file" accept=".zip,application/zip" disabled={busy || connection.status !== 'active'} className={inputClass} onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; if (file) execute(async () => { const form = new FormData(); form.append('file', file); const result = await apiRequest('POST', `${BASE}/${connection.id}/upload`, form); setRunId(result.run.id); }); }} /></label> : <div className="space-y-3">
      <div className="flex flex-wrap gap-2"><Button disabled={busy || connection.status !== 'active'} onClick={() => execute(async () => { const result = await apiRequest('POST', `${BASE}/${connection.id}/sync`); setRunId(result.run.id); })}>Sync now</Button><Button variant="outline" disabled={busy} onClick={() => execute(async () => { await apiRequest('POST', `${BASE}/${connection.id}/disconnect`, { expectedRevision: connection.revision }); onChanged(); })}>Disconnect token</Button></div>
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={connection.automaticSync} disabled={busy || !connection.initialReviewedAt || connection.status !== 'active'} onChange={event => execute(async () => { await apiRequest('PATCH', `${BASE}/${connection.id}`, { expectedRevision: connection.revision, automaticSync: event.target.checked }); onChanged(); })} />Sync nightly at 2:00 a.m. in the school timezone</label>
      {!connection.initialReviewedAt && <p className="text-xs text-muted-foreground">Review and apply the first import before enabling nightly sync.</p>}
      <form className="flex gap-2" onSubmit={event => { event.preventDefault(); const form = event.currentTarget; const token = new FormData(form).get('token'); form.reset(); execute(async () => { await apiRequest('PATCH', `${BASE}/${connection.id}`, { expectedRevision: connection.revision, token }); onChanged(); }); }}><input name="token" type="password" autoComplete="new-password" required minLength={16} maxLength={4096} className={inputClass} aria-label="Replacement Clever district token" placeholder="Replacement district token" /><Button type="submit" variant="outline" disabled={busy}>Reconnect</Button></form>
    </div>}
    {history && <div className="space-y-2">{(previous?.runs || []).map(run => <button type="button" key={run.id} className="flex w-full justify-between rounded border px-3 py-2 text-left text-sm hover:bg-muted" onClick={() => setRunId(run.id)}><span>{new Date(run.createdAt).toLocaleString()}</span><span>{label(run.status)}</span></button>)}{previous?.runs?.length === 0 && <p className="text-sm text-muted-foreground">No previous imports.</p>}</div>}
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    {runId && <ImportReview key={runId} runId={runId} connectionId={connection.id} onComplete={() => { onChanged(); refetch(); }} />}
  </div>;
}

export default function RosterIntegrations() {
  const { activeMembership } = useAuth(); const client = useQueryClient(); const [open, setOpen] = useState(false); const [provider, setProvider] = useState('oneroster');
  const queryKey = ['roster-integrations', activeMembership?.schoolId];
  const { data, error } = useQuery({ queryKey, queryFn: () => apiRequest('GET', BASE), enabled: open });
  const refresh = () => { client.invalidateQueries({ queryKey }); client.invalidateQueries({ queryKey: ['/api/classpilot/admin/classes'] }); };
  const create = useMutation({ mutationFn: body => apiRequest('POST', BASE, body), onSuccess: refresh });
  return <Card><CardHeader><CardTitle>Roster integrations</CardTitle><CardDescription>Import OneRoster exports or connect Clever. Preview identities, teachers and source-owned roster changes before applying.</CardDescription></CardHeader><CardContent className="space-y-4"><Button variant="outline" onClick={() => setOpen(value => !value)}>{open ? 'Hide integrations' : 'Manage roster integrations'}</Button>
    {open && <><p className="text-xs text-muted-foreground">Imports preserve manual contributions and student history. They do not assign Chromebooks, deactivate students, send invitations, or grant administrator access.</p>
      {(data?.connections || []).map(connection => <ConnectionPanel key={connection.id} connection={connection} onChanged={refresh} />)}
      <form className="space-y-3 rounded-lg border p-4" onSubmit={event => { event.preventDefault(); const form = event.currentTarget; const values = new FormData(form); const body = { provider, name: values.get('name'), providerIdentity: values.get('providerIdentity'), ...(provider === 'clever' ? { token: values.get('token') } : {}) }; create.mutate(body, { onSuccess: () => { form.reset(); create.reset(); } }); }}>
        <h3 className="font-semibold">Add connection</h3><select className={inputClass} value={provider} aria-label="Roster provider" onChange={event => setProvider(event.target.value)}><option value="oneroster">OneRoster CSV ZIP</option><option value="clever">Clever Secure Sync</option></select>
        <input className={inputClass} name="name" required maxLength={120} aria-label="Connection name" placeholder="Connection name" />
        <input className={inputClass} name="providerIdentity" required maxLength={256} aria-label={provider === 'clever' ? 'Clever district ID' : 'Stable SIS source identifier'} placeholder={provider === 'clever' ? 'Clever district ID' : 'Stable SIS source identifier (for example: main-sis)'} />
        {provider === 'clever' && <><input className={inputClass} name="token" type="password" autoComplete="new-password" required minLength={16} maxLength={4096} aria-label="Clever district data token" placeholder="Clever district data token" /><p className="text-xs text-muted-foreground">Requires district sharing and Clever Secure Sync access. The server encrypts the token and never returns it.</p></>}
        <Button type="submit" disabled={create.isPending}>Add connection</Button>
      </form>
      {(error || create.error) && <p role="alert" className="text-sm text-destructive">{errorText(error || create.error)}</p>}
    </>}
  </CardContent></Card>;
}
