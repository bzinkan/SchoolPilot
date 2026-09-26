import { useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Button } from '../../../components/ui/button';
import { useDisciplineAccess, useDisciplineLifetime } from '../hooks/useDiscipline';
import { disciplineApi, disciplineKeys, invalidateDiscipline } from '../lib/discipline';
import { myDeskError } from '../lib/myDeskModel';
import '../discipline.css';

export default function DisciplineAccessPanel() {
  const access = useDisciplineAccess();
  if (!access.ready || !access.capabilities?.canManageAccess) return null;
  return <DisciplineAccessEditor key={`${access.schoolId}:${access.viewerId}`} access={access} />;
}

export function DisciplineAccessEditor({ access }) {
  const { schoolId, viewerId } = access;
  const lifetime = useDisciplineLifetime(schoolId, viewerId);
  const [pending, setPending] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [announcement, setAnnouncement] = useState('');
  const transaction = useRef(null);
  const working = useRef(false);
  const query = useQuery({ queryKey: disciplineKeys.access(schoolId, viewerId), queryFn: ({ signal }) => disciplineApi(schoolId, signal).access(), retry: false, staleTime: 0, gcTime: 0 });
  const save = async () => {
    if (working.current || !pending || !lifetime.current || lifetime.current.signal.aborted) return;
    const controller = lifetime.current;
    if (!transaction.current) transaction.current = { userId: pending.userId, enabled: !pending.enabled, revision: pending.revision, clientRequestId: crypto.randomUUID() };
    const { userId, ...body } = transaction.current;
    working.current = true; setBusy(true); setError('');
    try {
      await disciplineApi(schoolId, controller.signal).setAccess(userId, body); controller.signal.throwIfAborted();
      await invalidateDiscipline(schoolId, viewerId); controller.signal.throwIfAborted();
      setAnnouncement(body.enabled ? 'Discipline viewing access granted.' : 'Discipline viewing access revoked.'); setPending(null); transaction.current = null;
    } catch (failure) {
      if (!controller.signal.aborted) {
        setError(myDeskError(failure));
        if (failure.response?.status >= 400 && failure.response?.status < 500) { transaction.current = null; setPending(null); void query.refetch(); }
      }
    } finally { working.current = false; if (!controller.signal.aborted) setBusy(false); }
  };
  return <section className="discipline-access-panel" aria-label="School discipline viewing access"><h2>School discipline viewing access</h2>
    <p>Designate administrators who can view and export submitted school discipline records. This never gives access to teachers’ private notebooks.</p>
    <p>School administrators can manage this permission, including their own. Permission changes are recorded in the audit log.</p>
    {query.isError ? <p role="alert">{myDeskError(query.error)} <Button onClick={() => query.refetch()}>Retry</Button></p> : query.isPending ? <p role="status">Loading administrator permissions…</p> : <ul className="discipline-access-list">{query.data.staff.map(staff => <li key={staff.userId}>
      <div><strong>{staff.name || staff.email}</strong><span>{staff.email}</span></div>
      <div><span>{staff.enabled ? 'Can view and export' : 'No viewing access'}</span><Button variant="outline" disabled={busy || Boolean(pending)} onClick={() => { setPending(staff); setError(''); }}>{staff.enabled ? 'Revoke access' : 'Grant access'}</Button></div>
    </li>)}</ul>}
    {pending && <section className="discipline-notice" role="region" aria-label="Confirm discipline permission"><p>{pending.enabled ? 'Revoke' : 'Grant'} <strong>View and export school discipline records</strong> for {pending.name || pending.email}{pending.userId === viewerId ? ' (your account)' : ''}?</p>
      <Button variant="outline" disabled={busy || Boolean(transaction.current)} onClick={() => setPending(null)}>Cancel</Button><Button disabled={busy} onClick={save}>{busy ? 'Saving…' : transaction.current ? 'Retry permission change' : 'Confirm permission change'}</Button></section>}
    {error && <p role="alert">{error}</p>}<p className="sr-only" role="status">{announcement}</p>
  </section>;
}
