import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { Layers } from 'lucide-react';
import { apiRequest } from '../../../lib/queryClient';
import { Button } from '../../../components/ui/button';
import { Label } from '../../../components/ui/label';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../../../components/ui/card';
import { useAdminNavigationBlocker } from '../hooks/useAdminNavigation';
import { teachingToolsShouldBlock } from '../lib/teachingTools';
import { teachingResourceBadge } from '../lib/teachingResourceLibrary';
import { restrictionResourceLabel, restrictionResourceUrl } from '../lib/restrictionResourceMatcher';
import { automaticFlightPathChoices, automaticFlightPathPolicyKey, automaticFlightPathReason } from '../lib/automaticFlightPath';

export default function AutomaticFlightPathSetup({ groupId, schoolId, viewerId, primaryTeacherId, sharedPathsEnabled, flightPaths, flightPathsError, active }) {
  const queryKey = automaticFlightPathPolicyKey(groupId, schoolId, viewerId);
  const choices = automaticFlightPathChoices(flightPaths, { viewerId, primaryTeacherId, sharedPathsEnabled });
  const query = useQuery({ queryKey,
    queryFn: ({ signal }) => apiRequest('GET', `/groups/${encodeURIComponent(groupId)}/automatic-flight-path`, undefined, { signal, headers: { 'X-School-Id': schoolId } }),
    enabled: Boolean(active && groupId && schoolId && viewerId), retry: false });
  return <Card data-testid="card-automatic-flight-path">
    <CardHeader><CardTitle className="flex items-center gap-2"><Layers className="h-5 w-5 text-blue-500" />Automatic Flight Path</CardTitle>
      <CardDescription>Limit students to a saved set of allowed websites and resources during this scheduled class. Off by default.</CardDescription></CardHeader>
    <CardContent>{!groupId ? <p className="text-sm text-muted-foreground">Choose a class above to set its automatic Flight Path.</p>
      : query.data?.policy ? <><PresetEditor key={`${schoolId}:${viewerId}:${groupId}:${query.data.canManage}`} incoming={query.data} queryKey={queryKey} groupId={groupId} schoolId={schoolId} flightPaths={choices} flightPathsError={flightPathsError} readError={query.isError} anotherTeacherClass={viewerId !== primaryTeacherId} />
          {query.isError ? <p role="alert" className="mt-3 text-sm">The saved preset could not be refreshed. Your draft is kept. <Button variant="link" onClick={() => query.refetch()}>Retry</Button></p> : null}</>
        : query.isError ? <p role="alert" className="text-sm">The class preset could not be loaded. <Button variant="link" onClick={() => query.refetch()}>Retry</Button></p>
          : <p role="status" className="text-sm text-muted-foreground">Loading class preset…</p>}</CardContent>
  </Card>;
}

function PresetEditor({ incoming, queryKey, groupId, schoolId, flightPaths, flightPathsError, readError, anotherTeacherClass }) {
  const client = useQueryClient();
  const [draft, setDraft] = useState(null), [notice, setNotice] = useState(''), [conflict, setConflict] = useState(false);
  const lifetime = useRef({ alive: true, controller: new AbortController() });
  useEffect(() => { const state = lifetime.current; state.alive = true; if (state.controller.signal.aborted) state.controller = new AbortController(); return () => { state.alive = false; state.controller.abort(); }; }, []);
  const baseline = draft?.baseline || incoming.policy;
  const enabled = draft?.enabled ?? incoming.policy.enabled;
  const flightPathId = draft ? draft.flightPathId : incoming.policy.flightPathId || '';
  const selected = flightPaths.find(path => path.id === flightPathId);
  const savedName = incoming.flightPath?.flightPathName || 'Saved Flight Path unavailable';
  const dirty = Boolean(enabled) !== Boolean(baseline.enabled) || (enabled && flightPathId !== baseline.flightPathId);
  const canManage = incoming.canManage === true;
  const valid = !enabled || Boolean(incoming.eligible && selected && !flightPathsError);
  const update = values => { setDraft({ baseline, enabled, flightPathId, ...values }); setNotice(''); setConflict(false); };
  const save = useMutation({ mutationFn: () => apiRequest('PATCH', `/groups/${encodeURIComponent(groupId)}/automatic-flight-path`, {
    expectedRevision: baseline.revision, enabled: Boolean(enabled), flightPathId: enabled ? flightPathId : null,
  }, { signal: lifetime.current.controller.signal, headers: { 'X-School-Id': schoolId } }),
  onSuccess: response => { if (!lifetime.current.alive) return; client.setQueryData(queryKey, response); setDraft(null); setConflict(false); setNotice('Class preset saved. It takes effect at the next scheduled session.'); },
  onError: error => { if (!lifetime.current.alive) return; setConflict(error?.response?.status === 409); setNotice(error?.response?.status === 409
    ? 'This class preset changed elsewhere. Your draft is kept. Reload the saved preset before saving again.'
    : error?.response?.data?.error || 'The class preset could not be saved. Your draft is still here.'); } });
  useAdminNavigationBlocker({ id: `automatic-flight-path:${groupId}`, dirty, busy: save.isPending,
    shouldBlock: transition => transition.actionId === 'teaching-class-switch' || teachingToolsShouldBlock(transition),
    onDiscard: () => { setDraft(null); setNotice(''); setConflict(false); } });

  return <div className="max-w-2xl space-y-4">
    {incoming.eligible !== true ? <p className="text-sm text-muted-foreground">{automaticFlightPathReason(incoming.reasonCode)}</p> : null}
    {!canManage ? <div className="space-y-2 text-sm"><p>{incoming.policy.enabled ? `On · ${savedName}` : 'Off'}</p>
        <p className="text-muted-foreground">The primary teacher or a school administrator manages this class preset. You can turn it off for a session you teach from the Dashboard.</p></div>
        : incoming.eligible === true || baseline.enabled === true ? <>
          <fieldset className="space-y-2" disabled={save.isPending}><legend className="mb-2 text-sm font-medium">At the start of each scheduled session</legend>
            {anotherTeacherClass && incoming.eligible ? <p className="text-sm text-muted-foreground">For another teacher’s class, choose a shared school Flight Path.</p> : null}
            <label className="flex items-center gap-2 text-sm"><input type="radio" name={`automatic-flight-path-${groupId}`} checked={!enabled} onChange={() => update({ enabled: false })} />Off</label>
            <label className="flex items-center gap-2 text-sm"><input type="radio" name={`automatic-flight-path-${groupId}`} disabled={!incoming.eligible} checked={Boolean(enabled)} onChange={() => update({ enabled: true })} />Use a saved Flight Path</label>
            {enabled ? <div className="space-y-2 pt-2"><Label htmlFor={`automatic-flight-path-choice-${groupId}`}>Saved Flight Path</Label>
              <select id={`automatic-flight-path-choice-${groupId}`} disabled={!incoming.eligible} className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm" value={flightPathId} onChange={event => update({ flightPathId: event.target.value })}>
                <option value="">Choose a Flight Path</option>
                {flightPathId && !selected ? <option value={flightPathId} disabled>{savedName}</option> : null}
                {flightPaths.map(path => <option key={path.id} value={path.id}>{path.flightPathName}{teachingResourceBadge(path) ? ` · ${teachingResourceBadge(path)}` : ''}</option>)}
              </select>
              {flightPathsError ? <p role="alert" className="text-sm text-destructive">Saved Flight Paths could not be loaded. Refresh before choosing a preset.</p> : null}
              {selected ? <section aria-label="Automatic Flight Path allowed scope" className="space-y-2 rounded-md border bg-muted/30 p-3 text-sm">
                <p className="font-medium">Allowed websites and resources</p>
                <ul className="space-y-1 break-all">{(selected.allowedDomains || []).map(domain => <li key={domain}>{domain} — entire website and subdomains</li>)}
                  {(selected.resources || []).map((resource, index) => <li key={`${restrictionResourceUrl(resource)}:${index}`}>{restrictionResourceLabel(resource)} — {restrictionResourceUrl(resource)}</li>)}</ul>
              </section> : null}
            </div> : null}
          </fieldset>
          <p className="text-sm text-muted-foreground">One preset is shared by all teachers of this class. Saving changes only the next session. The current session keeps its existing controls.</p>
          <div className="flex flex-wrap gap-2"><Button disabled={!dirty || !valid || save.isPending || conflict || readError} onClick={() => save.mutate()}>{save.isPending ? 'Saving…' : 'Save class preset'}</Button>
            <Button variant="outline" disabled={!dirty || save.isPending} onClick={() => { setDraft(null); setNotice(''); setConflict(false); }}>Cancel</Button>
            {conflict ? <Button variant="outline" onClick={async () => {
              try { await client.refetchQueries({ queryKey, exact: true }, { throwOnError: true }); if (lifetime.current.alive) { setDraft(null); setNotice(''); setConflict(false); } }
              catch { if (lifetime.current.alive) setNotice('The saved preset could not be reloaded. Your draft is still here.'); }
            }}>Reload saved preset</Button> : null}</div>
          {dirty ? <p role="status" className="text-sm">Unsaved class preset</p> : null}
        </> : null}
    {notice ? <p role="status" className="text-sm">{notice}</p> : null}
    <Link className="text-sm text-primary underline underline-offset-4" to={`?section=websites&classId=${encodeURIComponent(groupId)}`}>Create or edit Flight Paths in Website tools</Link>
  </div>;
}
