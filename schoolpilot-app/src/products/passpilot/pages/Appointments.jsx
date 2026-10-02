import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import { usePassPilotAuth } from '../../../hooks/usePassPilotAuth';
import { Button } from '../../../components/ui/button';
import { Input } from '../../../components/ui/input';
import { Label } from '../../../components/ui/label';
import { appointmentErrorText, appointmentRequest, appointmentScope, useAppointmentCapabilities } from '../appointmentData';
import { schoolDateBoundary, schoolWallTime, shiftSchoolDate } from '../appointmentModel';
import { getPassDestinationLabel } from '../passData';
import AppointmentForm from '../components/AppointmentForm';

const statusLabels = { scheduled: 'Scheduled', activated: 'Pass open', completed: 'Completed', cancelled: 'Cancelled', missed: 'Missed' };

export default function Appointments() {
  const { user, school } = usePassPilotAuth(), capabilities = useAppointmentCapabilities(user, school);
  if (capabilities.isLoading) return <p role="status" className="p-4">Loading appointment access…</p>;
  if (capabilities.isError) return <p role="alert" className="p-4">{appointmentErrorText(capabilities.error)} <Button variant="outline" onClick={() => capabilities.refetch()}>Retry</Button></p>;
  if (!capabilities.data?.enabled || !capabilities.data?.manager) return <div className="p-4"><p>{capabilities.data?.enabled ? 'Scheduling is available to PassPilot managers.' : 'Appointments are not enabled.'}</p><Link to="/passpilot/my-class" className="text-primary underline">Return to My Class</Link></div>;
  return <AppointmentCalendar key={JSON.stringify([...appointmentScope(user, school), capabilities.data.schoolTimezone])} user={user} school={school} capabilities={capabilities.data} />;
}

function AppointmentCalendar({ user, school, capabilities }) {
  const cache = useQueryClient(), pending = useRef(null), [schoolId, userId, roles] = appointmentScope(user, school);
  const [today] = useState(() => schoolWallTime(Date.now(), capabilities.schoolTimezone).slice(0, 10));
  const [fromDate, setFromDate] = useState(() => shiftSchoolDate(today, -1)), [throughDate, setThroughDate] = useState(() => shiftSchoolDate(today, 7));
  const [status, setStatus] = useState(''), [editing, setEditing] = useState(undefined), [busy, setBusy] = useState(false), [message, setMessage] = useState(''), [denied, setDenied] = useState(false);
  const range = useMemo(() => {
    try {
      const from = schoolDateBoundary(fromDate, capabilities.schoolTimezone), through = schoolDateBoundary(shiftSchoolDate(throughDate, 1), capabilities.schoolTimezone);
      if (from >= through) throw new Error('Choose an end date on or after the start date.');
      return { from, through };
    } catch (error) { return { error: error.message }; }
  }, [fromDate, throughDate, capabilities.schoolTimezone]);
  const query = useInfiniteQuery({ queryKey: ['passpilot-appointments', schoolId, userId, roles, 'manager-list', range.from, range.through, status],
    initialPageParam: null, enabled: !range.error && !denied, retry: false,
    queryFn: async ({ pageParam, signal }) => {
      try { return await appointmentRequest(schoolId, 'GET', `/passpilot/appointments?${new URLSearchParams({ from: range.from, through: range.through, limit: 50,
        ...(status ? { status } : {}), ...(pageParam ? { cursor: pageParam } : {}) })}`, undefined, signal); }
      catch (error) {
        if ([401, 403].includes(error.response?.status)) { setDenied(true); setEditing(undefined); setMessage(appointmentErrorText(error)); cache.removeQueries({ queryKey: ['passpilot-appointments', schoolId, userId, roles] }); }
        throw error;
      }
    },
    getNextPageParam: result => result.nextCursor || undefined });
  useEffect(() => () => { pending.current?.abort(); cache.removeQueries({ queryKey: ['passpilot-appointments', schoolId, userId, roles] }); }, [cache, schoolId, userId, roles]);
  const perform = async (method, path, body) => {
    const controller = new AbortController(); pending.current = controller; setBusy(true); setMessage('');
    try {
      await appointmentRequest(schoolId, method, path, body, controller.signal);
      if (controller.signal.aborted) return;
      setEditing(undefined); setMessage(method === 'POST' && path.endsWith('/cancel') ? 'Appointment cancelled.' : 'Appointment saved.');
      await cache.invalidateQueries({ queryKey: ['passpilot-appointments', schoolId, userId, roles] });
    } catch (error) {
      if (controller.signal.aborted) return;
      setMessage(appointmentErrorText(error));
      if ([401, 403].includes(error.response?.status)) { setEditing(undefined); setDenied(true); cache.removeQueries({ queryKey: ['passpilot-appointments', schoolId, userId, roles] }); }
      await cache.invalidateQueries({ queryKey: ['passpilot-appointment-capabilities', schoolId, userId, roles] });
    } finally { if (!controller.signal.aborted) setBusy(false); }
  };
  const rows = query.isError || denied ? [] : query.data?.pages.flatMap(page => page.appointments) || [];
  return <div className="space-y-4 p-4"><header><h2 className="text-xl font-semibold">Appointments</h2><p className="text-sm text-muted-foreground">Schedule one-time windows. Authorized teachers open passes manually.</p></header>
    {!capabilities.schoolYearConfigured ? <p role="alert" className="rounded-md border p-3">A school administrator must configure school-year dates in Set Up → Settings before appointments can be scheduled.</p> : null}
    {message ? <p role="status">{message}</p> : null}
    {editing !== undefined && !denied ? <AppointmentForm key={editing?.id || 'new'} initial={editing} school={school} user={user} timeZone={capabilities.schoolTimezone} busy={busy}
      onCancel={() => setEditing(undefined)} onSave={body => perform(editing ? 'PATCH' : 'POST', `/passpilot/appointments${editing ? `/${encodeURIComponent(editing.id)}` : ''}`, body)} /> : <Button disabled={!capabilities.schoolYearConfigured || denied || busy} onClick={() => { setMessage(''); setEditing(null); }}>Schedule appointment</Button>}
    <div className="flex flex-wrap items-end gap-3"><div><Label htmlFor="appointment-from">From date</Label><Input id="appointment-from" type="date" value={fromDate} onChange={event => setFromDate(event.target.value)} /></div>
      <div><Label htmlFor="appointment-through">Through date</Label><Input id="appointment-through" type="date" value={throughDate} onChange={event => setThroughDate(event.target.value)} /></div>
      <div><Label htmlFor="appointment-status">Status</Label><select id="appointment-status" value={status} onChange={event => setStatus(event.target.value)} className="block rounded-md border bg-background px-3 py-2 text-sm"><option value="">All statuses</option>{Object.entries(statusLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></div>
      <Button variant="outline" disabled={query.isFetching || Boolean(range.error) || denied} onClick={() => query.refetch()}>Refresh appointments</Button></div>
    <p className="text-sm text-muted-foreground">Dates and times use {capabilities.schoolTimezone}.</p>
    {range.error ? <p role="alert">{range.error}</p> : null}
    {query.isLoading && !range.error ? <p role="status">Loading appointments…</p> : null}
    {query.isError ? <p role="alert">{appointmentErrorText(query.error)}</p> : null}
    {query.isSuccess && !rows.length ? <p>No appointments in this date range.</p> : null}
    <ul className="space-y-3">{rows.map(row => <li key={row.id} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border bg-card p-4">
      <div><p className="font-medium">{row.studentName} — {getPassDestinationLabel(row)}</p><p className="text-sm">{new Date(row.startsAt).toLocaleString('en-US', { timeZone: row.schoolTimezone })} to {new Date(row.endsAt).toLocaleString('en-US', { timeZone: row.schoolTimezone })} ({row.schoolTimezone})</p><p className="text-sm text-muted-foreground">{statusLabels[row.status] || row.status}</p></div>
      {row.status === 'scheduled' ? <div className="flex gap-2"><Button variant="outline" size="sm" disabled={busy} onClick={() => { setMessage(''); setEditing(row); }}>Edit appointment</Button>
        <Button variant="outline" size="sm" disabled={busy} onClick={() => { if (window.confirm(`Cancel ${row.studentName}’s appointment?`)) perform('POST', `/passpilot/appointments/${encodeURIComponent(row.id)}/cancel`, { expectedRevision: row.revision }); }}>Cancel appointment</Button></div> : null}
    </li>)}</ul>
    {query.hasNextPage ? <Button variant="outline" disabled={query.isFetchingNextPage} onClick={() => query.fetchNextPage()}>Load more appointments</Button> : null}
  </div>;
}
