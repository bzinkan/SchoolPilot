import { useEffect, useId, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Button } from '../../../../components/ui/button';
import { Input } from '../../../../components/ui/input';
import { Label } from '../../../../components/ui/label';
import { Card, CardContent, CardHeader, CardTitle } from '../../../../components/ui/card';
import { usePassPilotAuth } from '../../../../hooks/usePassPilotAuth';
import { appointmentErrorText, appointmentRequest, appointmentScope } from '../../appointmentData';

export default function SchoolYearSetup() {
  const { user, school, isAdmin } = usePassPilotAuth();
  const query = useQuery({ queryKey: ['passpilot-school-year', ...appointmentScope(user, school)], enabled: Boolean(isAdmin && school?.id), retry: false,
    queryFn: async ({ signal }) => {
      try { return await appointmentRequest(school.id, 'GET', '/passpilot/school-year', undefined, signal); }
      catch (error) { if (error.response?.status === 404) return null; throw error; }
    } });
  if (!isAdmin || query.data === null) return null;
  if (query.isLoading) return <p role="status">Loading school-year dates…</p>;
  if (query.isError) return <p role="alert">{appointmentErrorText(query.error)} <Button variant="outline" onClick={() => query.refetch()}>Retry school-year settings</Button></p>;
  if (!query.data) return null;
  return <SchoolYearForm key={JSON.stringify(appointmentScope(user, school))} initial={query.data} user={user} school={school} />;
}

function SchoolYearForm({ initial, user, school }) {
  const id = useId(), cache = useQueryClient(), pending = useRef(null);
  const [yearStart, setYearStart] = useState(initial.yearStart || ''), [yearEnd, setYearEnd] = useState(initial.yearEnd || '');
  const [preview, setPreview] = useState(null), [busy, setBusy] = useState(false), [message, setMessage] = useState('');
  useEffect(() => () => { pending.current?.abort(); }, []);
  const request = async save => {
    const controller = new AbortController(); pending.current = controller; setBusy(true); setMessage('');
    try {
      const result = await appointmentRequest(school.id, save ? 'PUT' : 'POST', `/passpilot/school-year${save ? '' : '/preview'}`,
        { yearStart, yearEnd, ...(save ? { expectedRevision: preview.revision, previewToken: preview.previewToken } : {}) }, controller.signal);
      if (controller.signal.aborted) return;
      if (save) {
        setPreview(null); setMessage('School-year dates saved.');
        cache.setQueryData(['passpilot-school-year', ...appointmentScope(user, school)], result);
        await cache.invalidateQueries({ queryKey: ['passpilot-appointment-capabilities', ...appointmentScope(user, school)] });
      } else setPreview(result);
    } catch (error) { if (!controller.signal.aborted) { setPreview(null); setMessage(appointmentErrorText(error)); } }
    finally { if (!controller.signal.aborted) setBusy(false); }
  };
  const change = setter => event => { setter(event.target.value); setPreview(null); setMessage(''); };
  return <Card className="mt-4"><CardHeader><CardTitle className="text-base">School-year dates</CardTitle></CardHeader>
    <CardContent><form className="space-y-4" onSubmit={event => { event.preventDefault(); request(false); }}>
      <p className="text-sm text-muted-foreground">Required before scheduling appointments. These dates also apply to the shared school calendar. Timezone: {initial.schoolTimezone}.</p>
      <div className="grid gap-4 sm:grid-cols-2"><div><Label htmlFor={`${id}-start`}>School-year start</Label><Input id={`${id}-start`} type="date" value={yearStart} onChange={change(setYearStart)} required disabled={busy} /></div>
        <div><Label htmlFor={`${id}-end`}>School-year end</Label><Input id={`${id}-end`} type="date" value={yearEnd} onChange={change(setYearEnd)} required disabled={busy} /></div></div>
      <Button type="submit" variant="outline" disabled={busy}>{busy ? 'Working…' : 'Preview date changes'}</Button>
      {preview ? <div className="space-y-2 rounded-md border p-3" aria-label="School-year change preview">
        <p>{preview.changedOccurrences} scheduled class occurrences will change.</p>
        {preview.blockers?.length ? <ul role="alert">{preview.blockers.map((blocker, index) => <li key={index}>{blocker.message}</li>)}</ul> : <p>The preview found no scheduling blockers.</p>}
        <Button type="button" disabled={busy || Boolean(preview.blockers?.length)} onClick={() => request(true)}>Save reviewed school-year dates</Button>
      </div> : null}
      {message ? <p role="status">{message}</p> : null}
    </form></CardContent></Card>;
}
