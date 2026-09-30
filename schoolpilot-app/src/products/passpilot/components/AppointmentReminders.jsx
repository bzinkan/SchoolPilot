import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Button } from '../../../components/ui/button';
import { appointmentErrorText, appointmentRequest, appointmentScope, useAppointmentCapabilities } from '../appointmentData';
import { appointmentReminderRange, currentClassReminders, loadAppointmentPages } from '../appointmentModel';
import { getPassDestinationLabel } from '../passData';
import { usePassNow } from './LivePassDuration';

export default function AppointmentReminders({ user, school, classId, students }) {
  const capabilities = useAppointmentCapabilities(user, school), cache = useQueryClient();
  const [schoolId, userId, roles] = appointmentScope(user, school);
  const key = ['passpilot-appointments', schoolId, userId, roles, 'reminders', classId];
  const [busy, setBusy] = useState(null), [message, setMessage] = useState(''), [denied, setDenied] = useState(false);
  const pending = useRef(null), now = usePassNow();
  const query = useQuery({ queryKey: key, enabled: Boolean(classId && capabilities.data?.teacherReminders && !denied), retry: false,
    refetchInterval: 30000,
    queryFn: ({ signal }) => loadAppointmentPages((params, requestSignal) => appointmentRequest(school.id, 'GET',
      `/passpilot/appointments?${new URLSearchParams(params)}`, undefined, requestSignal), appointmentReminderRange(), signal) });
  useEffect(() => () => {
    pending.current?.abort();
    cache.removeQueries({ queryKey: ['passpilot-appointments', schoolId, userId, roles, 'reminders', classId] });
  }, [cache, schoolId, userId, roles, classId]);
  if (!capabilities.isSuccess || !capabilities.data?.teacherReminders) return null;
  const rows = currentClassReminders(query.isError || denied ? [] : query.data || [], students, now);
  const activate = async row => {
    const controller = new AbortController(); pending.current = controller; setBusy(row.id); setMessage('');
    try {
      const result = await appointmentRequest(school.id, 'POST', `/passpilot/appointments/${encodeURIComponent(row.id)}/activate`,
        { expectedRevision: row.revision, classId }, controller.signal);
      if (controller.signal.aborted) return;
      setMessage(result.pass.status === 'returned' ? 'This appointment’s pass has already returned.' : 'Appointment pass opened.');
      await Promise.all([cache.invalidateQueries({ queryKey: ['passpilot-appointments', ...appointmentScope(user, school)] }),
        cache.invalidateQueries({ queryKey: ['/api/passes/active', school.id] })]);
    } catch (error) {
      if (!controller.signal.aborted) {
        setMessage(appointmentErrorText(error));
        if ([401, 403].includes(error.response?.status)) {
          setDenied(true); cache.removeQueries({ queryKey: key });
          await cache.invalidateQueries({ queryKey: ['passpilot-appointment-capabilities', ...appointmentScope(user, school)] });
        }
      }
    }
    finally { if (!controller.signal.aborted) setBusy(null); }
  };
  return <section className="mb-4 rounded-lg border bg-card p-4" aria-label="Class appointment reminders">
    <h3 className="font-semibold">Appointments for this class</h3>
    <p className="text-sm text-muted-foreground">Open the pass when the student is ready. Scheduling never opens a pass automatically.</p>
    {query.isLoading ? <p role="status">Loading appointments…</p> : null}
    {query.isError ? <p role="alert">{appointmentErrorText(query.error)} <Button variant="outline" size="sm" onClick={() => query.refetch()}>Retry</Button></p> : null}
    {message ? <p role="status" className="mt-2 text-sm">{message}</p> : null}
    {denied ? <p role="alert">Current appointment access changed. Refresh this page before continuing.</p> : null}
    {query.isSuccess && !rows.length ? <p className="mt-2 text-sm text-muted-foreground">No upcoming appointments for current students.</p> : null}
    <ul className="mt-3 space-y-3">{rows.map(row => {
      const startsAt = new Date(row.startsAt), ready = startsAt.getTime() <= now;
      return <li key={row.id} className="flex flex-wrap items-center justify-between gap-2 border-t pt-3">
        <div><p className="font-medium">{row.studentName || students.find(student => student.id === row.studentId)?.name || 'Student'} — {getPassDestinationLabel(row)}</p>
          <p className="text-sm text-muted-foreground">{startsAt.toLocaleString('en-US', { timeZone: row.schoolTimezone })} to {new Date(row.endsAt).toLocaleString('en-US', { timeZone: row.schoolTimezone })} ({row.schoolTimezone})</p></div>
        <Button size="sm" disabled={!ready || Boolean(busy)} onClick={() => activate(row)}>{busy === row.id ? 'Opening…' : ready ? 'Open appointment pass' : 'Window has not opened'}</Button>
      </li>;
    })}</ul>
  </section>;
}
