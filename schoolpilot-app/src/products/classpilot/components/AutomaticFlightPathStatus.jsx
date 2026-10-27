import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Layers } from 'lucide-react';
import { Button } from '../../../components/ui/button';
import { automaticFlightPathReason, automaticFlightPathStopBody } from '../lib/automaticFlightPath';

export default function AutomaticFlightPathStatus({ sessionId, groupId, className, query, request }) {
  const [pending, setPending] = useState(false), [error, setError] = useState('');
  const lifetime = useRef({ alive: true, controller: new AbortController() });
  useEffect(() => { const state = lifetime.current; state.alive = true; if (state.controller.signal.aborted) state.controller = new AbortController(); return () => { state.alive = false; state.controller.abort(); }; }, []);
  const data = query.data, state = data?.automaticFlightPath;
  if (!state || state.status === 'inactive') return query.isError ? <div role="alert" className="mb-4 rounded-lg border bg-card p-3 text-sm">Automatic Flight Path status could not be loaded. <Button variant="link" onClick={() => query.refetch()}>Retry</Button></div> : null;
  const stop = async () => {
    if (pending || query.isError || !data.canStop || state.status === 'off') return;
    setPending(true); setError('');
    try {
      await request('POST', '/classpilot/commands', automaticFlightPathStopBody(sessionId, state.revision), { signal: lifetime.current.controller.signal });
      if (lifetime.current.alive) await query.refetch();
    } catch (cause) {
      if (!lifetime.current.alive) return;
      setError(cause?.response?.data?.error || 'Could not turn off the automatic Flight Path. Refresh its status and retry.');
      void query.refetch();
    } finally { if (lifetime.current.alive) setPending(false); }
  };
  return <section aria-label="Automatic Flight Path for this session" data-testid="automatic-flight-path-status" className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-blue-200 bg-card p-4 dark:border-blue-900">
    <div className="min-w-0 flex-1 space-y-1"><p className="flex items-center gap-2 text-sm font-semibold"><Layers className="h-4 w-4 shrink-0 text-blue-500" />Automatic Flight Path: {state.name || 'Saved class preset'}</p>
      <p className="text-xs text-muted-foreground">{className} · Entire class session, regardless of selected students</p>
      {query.isError ? <p role="alert" className="text-sm text-destructive">Status could not be refreshed. Last known results are shown; refresh before making changes.</p>
        : state.status === 'off' ? <p role="status" className="text-sm">Off for this session — resumes next scheduled class if the preset remains enabled.</p>
          : state.status === 'unavailable' ? <p role="status" className="text-sm">{automaticFlightPathReason(state.reasonCode)}</p> : null}
      <p className="text-xs text-muted-foreground" data-testid="automatic-flight-path-summary">{Object.entries({ applied: 'applied', pending: 'pending', failed: 'failed', unavailable: 'unavailable', overridden: 'manual override', off: 'off' }).map(([key, label]) => `${data.summary?.[key] || 0} ${label}`).join(' · ')}</p>
      {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
    </div>
    <div className="flex flex-wrap items-center gap-2">{state.status !== 'off' && data.canStop ? <Button variant="outline" size="sm" disabled={pending || query.isError} onClick={() => void stop()}>{pending ? 'Turning off…' : 'Turn off for this session'}</Button> : null}
      {query.isError ? <Button variant="outline" size="sm" onClick={() => query.refetch()}>Refresh status</Button> : null}
      {groupId ? <Button variant="ghost" size="sm" asChild><Link to={`/classpilot/my-settings?section=classes&classId=${encodeURIComponent(groupId)}`}>Class setup</Link></Button> : null}</div>
  </section>;
}
