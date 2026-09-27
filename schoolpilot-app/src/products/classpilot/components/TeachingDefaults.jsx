import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { apiRequest, queryClient } from '../../../lib/queryClient';
import { Button } from '../../../components/ui/button';
import { Input } from '../../../components/ui/input';
import { Label } from '../../../components/ui/label';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../../../components/ui/card';
import { useAdminNavigationBlocker } from '../hooks/useAdminNavigation';
import { teacherPreferencesKey, teachingToolsShouldBlock } from '../lib/teachingTools';

export default function TeachingDefaults({ schoolId, viewerId, active = true }) {
  const key = teacherPreferencesKey(schoolId, viewerId);
  const query = useQuery({ queryKey: key, queryFn: ({ signal }) => apiRequest('GET', '/classpilot/teacher/preferences', undefined,
    { signal, headers: { 'X-School-Id': schoolId } }), enabled: Boolean(active && schoolId && viewerId), retry: false });
  return <Card data-testid="card-classroom-controls"><CardHeader><CardTitle>Classroom defaults</CardTitle>
    <CardDescription>Prefills Manage Tabs. Apply changes to students from the Dashboard.</CardDescription></CardHeader>
    <CardContent>{query.data ? <PreferenceEditor incoming={query.data} queryKey={key} schoolId={schoolId} />
      : query.isError ? <p role="alert">Your defaults could not be loaded. <Button variant="link" onClick={() => query.refetch()}>Retry</Button></p>
        : <p role="status">Loading personal defaults…</p>}</CardContent></Card>;
}

function PreferenceEditor({ incoming, queryKey, schoolId }) {
  const [draft, setDraft] = useState(null), [conflict, setConflict] = useState(null), [notice, setNotice] = useState('');
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const baseline = draft?.baseline || incoming;
  const value = draft?.value ?? (incoming.maxTabsPerStudent == null ? '' : String(incoming.maxTabsPerStudent));
  const valid = value === '' || (/^\d+$/.test(value) && Number(value) >= 1 && Number(value) <= 100);
  const dirty = value !== (baseline.maxTabsPerStudent == null ? '' : String(baseline.maxTabsPerStudent));
  const save = useMutation({ mutationFn: () => apiRequest('PATCH', '/classpilot/teacher/preferences', {
    expectedRevision: baseline.revision, maxTabsPerStudent: value === '' ? null : Number(value),
  }, { headers: { 'X-School-Id': schoolId } }), onSuccess: response => {
    if (!alive.current) return;
    queryClient.setQueryData(queryKey, response); setDraft(null); setConflict(null); setNotice('Personal default saved.');
  }, onError: error => {
    if (!alive.current) return;
    if (error?.response?.status === 409 && error.response.data?.current) setConflict(error.response.data.current);
    else setNotice('Your default could not be saved. Your draft is still here.');
  } });
  useAdminNavigationBlocker({ id: 'teaching-defaults', dirty, busy: save.isPending, shouldBlock: teachingToolsShouldBlock,
    onDiscard: () => { setDraft(null); setConflict(null); } });
  const describe = limit => limit == null ? 'Use school default' : `${limit} tabs`;
  return <div className="max-w-xl space-y-4">
    <fieldset className="space-y-2" disabled={save.isPending}><legend className="mb-2 text-sm font-medium">Maximum tabs per student</legend>
      <label className="flex items-center gap-2 text-sm"><input type="radio" name="personal-tab-limit-mode" checked={value === ''} onChange={() => { setDraft({ baseline, value: '' }); setNotice(''); }} />Use school default</label>
      <label className="flex items-center gap-2 text-sm"><input type="radio" name="personal-tab-limit-mode" checked={value !== ''} onChange={() => { setDraft({ baseline, value: String(baseline.maxTabsPerStudent ?? incoming.schoolMaxTabsPerStudent ?? 5) }); setNotice(''); }} />Custom limit</label>
      <Label htmlFor="personal-tab-limit">Your custom tab limit</Label>
      <Input id="personal-tab-limit" data-testid="input-max-tabs" type="number" min="1" max="100" value={value} placeholder="Use school default" disabled={save.isPending || value === ''}
        onChange={event => { setDraft({ baseline, value: event.target.value }); setNotice(''); }} />
      <p className="text-sm text-muted-foreground">Current school default: {incoming.schoolMaxTabsPerStudent == null ? 'unlimited' : `${incoming.schoolMaxTabsPerStudent} tabs`}. Choose a custom limit from 1 to 100.</p>
      {!valid && <p role="alert" className="text-sm text-destructive">Enter a whole number from 1 to 100, or leave blank to inherit.</p>}
    </fieldset>
    {conflict && <div role="alert" className="space-y-2 rounded border p-3 text-sm"><p>This preference changed elsewhere. Your draft has been kept. Choose which value to continue with.</p>
      <p>Your draft: {value === '' ? 'Use school default' : `${value} tabs`}. Latest saved: {describe(conflict.maxTabsPerStudent)}.</p>
      <div className="flex flex-wrap gap-2"><Button variant="outline" onClick={() => { queryClient.setQueryData(queryKey, conflict); setDraft(null); setConflict(null); }}>Load latest saved value</Button>
      <Button variant="outline" onClick={() => { queryClient.setQueryData(queryKey, conflict); setDraft({ baseline: conflict, value }); setConflict(null); }}>Keep my draft with latest version</Button></div></div>}
    {notice && <p role="status" className="text-sm">{notice}</p>}
    {dirty && <p role="status" className="text-sm">Unsaved classroom default</p>}
    <div className="flex flex-wrap gap-2"><Button data-testid="button-save" disabled={!valid || !dirty || save.isPending || Boolean(conflict)} onClick={() => save.mutate()}>{save.isPending ? 'Saving…' : 'Save classroom defaults'}</Button>
      <Button variant="outline" disabled={save.isPending || !dirty} onClick={() => { setDraft(null); setConflict(null); setNotice(''); }}>Cancel</Button></div>
  </div>;
}
