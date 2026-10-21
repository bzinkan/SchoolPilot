import { useEffect, useId, useRef, useState } from 'react';
import { Button } from '../../../components/ui/button';
import { Input } from '../../../components/ui/input';
import { queryClient } from '../../../lib/queryClient';
import { passPilotClassRequest } from '../classData';

// Parents key this component by school/authentication identity, never by the
// current class or bell. A return review remains valid across class changes.
export default function ReturnPassLookup({ kioskClient, onAuthorizationError, onReturned, kiosk = false }) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [matches, setMatches] = useState(null);
  const [hasMore, setHasMore] = useState(false);
  const [selected, setSelected] = useState(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const requestEpoch = useRef(0);
  const inFlight = useRef(false);
  const inputId = useId();
  useEffect(() => () => { requestEpoch.current++; }, []);
  useEffect(() => {
    if (!kiosk || !open || busy) return;
    const timer = window.setTimeout(() => {
      requestEpoch.current++;
      setOpen(false); setSearch(''); setMatches(null); setSelected(null); setMessage(''); setError('');
    }, 30_000);
    return () => window.clearTimeout(timer);
  }, [busy, kiosk, matches, open, search, selected]);

  const kioskRequest = async (path, body, epoch) => {
    const response = await kioskClient.request(path, { method: 'POST', body: JSON.stringify(body) });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      if (epoch === requestEpoch.current && (response.status === 401 || data.code === 'PASSPILOT_KIOSK_SESSION_EXPIRED')) {
        onAuthorizationError?.(response, data);
      }
      throw new Error(data.error || 'The return could not be completed. Try again.');
    }
    return data;
  };

  const lookup = async event => {
    event.preventDefault();
    const value = search.trim();
    if (inFlight.current || value.length < 2 || value.length > 100) return;
    inFlight.current = true;
    const epoch = ++requestEpoch.current;
    setBusy(true); setError(''); setMessage(''); setSelected(null); setMatches(null);
    try {
      const result = kioskClient
        ? await kioskRequest('/api/passpilot/kiosk/returns/lookup', { search: value }, epoch)
        : await passPilotClassRequest('POST', '/passes/returns/lookup', { search: value });
      if (epoch !== requestEpoch.current) return;
      if (!Array.isArray(result?.matches)) throw new Error('Pass lookup is unavailable. Try again.');
      setMatches(result.matches);
      setHasMore(result.hasMore === true);
    } catch (failure) {
      if (epoch === requestEpoch.current) setError(failure.response?.data?.error || failure.message || 'Pass lookup failed. Try again.');
    } finally {
      if (epoch === requestEpoch.current) { inFlight.current = false; setBusy(false); }
    }
  };

  const returnPass = async () => {
    if (!selected || inFlight.current) return;
    inFlight.current = true;
    const epoch = ++requestEpoch.current;
    setBusy(true); setError('');
    try {
      if (kioskClient) await kioskRequest('/api/passpilot/kiosk/checkin', { studentId: selected.studentId, passId: selected.passId }, epoch);
      else await passPilotClassRequest('PATCH', `/passes/${encodeURIComponent(selected.passId)}/return`, {});
      if (epoch !== requestEpoch.current) return;
      setMessage(`${selected.firstName} ${selected.lastName} has been marked returned.`);
      setSelected(null); setMatches(null); setSearch('');
      if (!kioskClient) {
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: ['/api/passes/active'] }),
          queryClient.invalidateQueries({ queryKey: ['/api/passes/history'] }),
          queryClient.invalidateQueries({ queryKey: ['passpilot', 'classes'] }),
        ]);
      }
      await onReturned?.();
    } catch (failure) {
      if (epoch === requestEpoch.current) setError(failure.response?.data?.error || failure.message || 'The return failed. Try again.');
    } finally {
      if (epoch === requestEpoch.current) { inFlight.current = false; setBusy(false); }
    }
  };

  const close = () => {
    if (inFlight.current) return;
    requestEpoch.current++;
    setOpen(false); setSearch(''); setMatches(null); setSelected(null); setMessage(''); setError('');
  };

  return <section aria-label="Return a pass" className={`mb-4 w-full rounded-lg border p-4 ${kiosk ? 'max-w-xl border-gray-700 bg-gray-900 text-white' : 'bg-card text-card-foreground'}`}>
    <div className="flex flex-wrap items-center justify-between gap-2">
      <Button type="button" variant={kiosk ? 'default' : 'outline'} aria-expanded={open} onClick={() => setOpen(true)}>
        Return a pass
      </Button>
      {open ? <Button type="button" variant="ghost" disabled={busy} onClick={close}>Close</Button> : null}
    </div>
    {open ? <div className="mt-3 space-y-3">
      <p className={`text-sm ${kiosk ? 'text-gray-300' : 'text-muted-foreground'}`}>Find an open pass from any class in this school.</p>
      <form onSubmit={lookup} className="space-y-2">
        <label className="block text-sm font-medium" htmlFor={inputId}>Name or student ID</label>
        <div className="flex flex-wrap gap-2">
          <Input id={inputId} value={search} autoFocus minLength={2} maxLength={100} required disabled={busy}
            className={`min-w-0 flex-1 ${kiosk ? 'border-gray-600 bg-gray-800 text-white' : ''}`}
            onChange={event => { setSearch(event.target.value); setMatches(null); setSelected(null); setMessage(''); setError(''); }} />
          <Button type="submit" disabled={busy || search.trim().length < 2}>{busy ? 'Working…' : 'Find open pass'}</Button>
        </div>
      </form>
      {error ? <p role="alert" className={kiosk ? 'text-red-300' : 'text-destructive'}>{error}</p> : null}
      {message ? <p role="status" className={kiosk ? 'text-green-300' : 'text-green-700 dark:text-green-300'}>{message}</p> : null}
      {matches?.length === 0 ? <p role="status">No open pass found. Check the name or student ID.</p> : null}
      {hasMore && matches?.length ? <p className="text-sm">More matches exist. Enter more of the name or student ID.</p> : null}
      {!selected && matches?.length ? <ul className="space-y-2">{matches.map(match => <li key={match.passId}>
        <Button type="button" variant="outline" disabled={busy} onClick={() => setSelected(match)}
          className={`h-auto w-full justify-start whitespace-normal text-left ${kiosk ? 'border-gray-600 bg-gray-800 text-white hover:bg-gray-700 hover:text-white' : ''}`}>
          {match.firstName} {match.lastName}{match.studentIdNumber ? ` · ID ${match.studentIdNumber}` : ''}
        </Button>
      </li>)}</ul> : null}
      {selected ? <div className="space-y-3 rounded-md border p-3">
        <p>Mark {selected.firstName} {selected.lastName} returned?</p>
        <div className="flex flex-wrap gap-2">
          <Button type="button" onClick={returnPass} disabled={busy}>{busy ? 'Returning…' : 'Mark Returned'}</Button>
          <Button type="button" variant="outline" disabled={busy} onClick={() => setSelected(null)}
            className={kiosk ? 'border-gray-600 bg-gray-800 text-white hover:bg-gray-700 hover:text-white' : ''}>Choose another student</Button>
        </div>
      </div> : null}
    </div> : null}
  </section>;
}
