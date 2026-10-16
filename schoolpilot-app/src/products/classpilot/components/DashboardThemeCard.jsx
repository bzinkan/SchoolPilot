import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { apiRequest, queryClient } from '../../../lib/queryClient';
import { Button } from '../../../components/ui/button';
import { Input } from '../../../components/ui/input';
import { Label } from '../../../components/ui/label';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../../../components/ui/card';
import { useAdminNavigationBlocker } from '../hooks/useAdminNavigation';
import { teacherPreferencesKey, teachingToolsShouldBlock } from '../lib/teachingTools';
import { findDashboardThemePreset, isUnavailableDashboardTheme, readyDashboardThemePresets, resolveDashboardTheme } from '../../../shared/themes/presets';

// Teaching tools › Appearance. Personal to the signed-in teacher; saving a theme
// never sends a student command and never changes anyone else's dashboard.
export default function DashboardThemeCard({ schoolId, viewerId, active = true, timeZone }) {
  const key = teacherPreferencesKey(schoolId, viewerId);
  const query = useQuery({ queryKey: key, queryFn: ({ signal }) => apiRequest('GET', '/classpilot/teacher/preferences', undefined,
    { signal, headers: { 'X-School-Id': schoolId } }), enabled: Boolean(active && schoolId && viewerId), retry: false });
  return <Card data-testid="card-dashboard-theme"><CardHeader><CardTitle>Dashboard theme</CardTitle>
    <CardDescription>Pick a look for your own ClassPilot dashboard. Student status colors never change, so alerts always look the same. A theme replaces light or dark mode while it is on.</CardDescription></CardHeader>
    <CardContent>{query.data
      ? (query.data.dashboardThemesEnabled
        ? <ThemeEditor incoming={query.data} queryKey={key} schoolId={schoolId} timeZone={timeZone} />
        : <p role="status" className="text-sm text-muted-foreground" data-testid="dashboard-theme-disabled">Dashboard themes are not turned on for your school yet.</p>)
      : query.isError ? <p role="alert">Your theme could not be loaded. <Button variant="link" onClick={() => query.refetch()}>Retry</Button></p>
        : <p role="status">Loading your theme…</p>}</CardContent></Card>;
}

function ThemeEditor({ incoming, queryKey, schoolId, timeZone }) {
  const [draft, setDraft] = useState(null), [notice, setNotice] = useState('');
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const baseline = draft?.baseline || incoming;
  const stored = baseline.dashboardTheme ?? null;
  const storedPreset = stored?.kind === 'preset' ? stored.preset : null;
  const storedName = typeof stored?.name === 'string' ? stored.name : '';
  const storedCalendar = stored?.calendar === true;
  const preset = draft ? draft.preset : storedPreset;
  const name = draft ? draft.name : storedName;
  const calendar = draft ? draft.calendar : storedCalendar;
  const dirty = preset !== storedPreset || name.trim() !== storedName || calendar !== storedCalendar;
  // In calendar mode the saved preset is only the Advent hint; today's pick is shown for context.
  const today = calendar ? resolveDashboardTheme({ kind: 'preset', preset: preset === 'advent' ? 'advent' : 'fall', calendar: true }, { timeZone }) : null;
  const effectivePreset = calendar ? (preset === 'advent' ? 'advent' : (today?.id ?? 'fall')) : preset;
  const nameValid = name.trim().length <= 40;
  const save = useMutation({ mutationFn: () => apiRequest('PATCH', '/classpilot/teacher/preferences', {
    expectedRevision: baseline.revision,
    dashboardTheme: effectivePreset ? { kind: 'preset', preset: effectivePreset, ...(calendar ? { calendar: true } : {}), ...(name.trim() ? { name: name.trim() } : {}) } : null,
  }, { headers: { 'X-School-Id': schoolId } }), onSuccess: response => {
    if (!alive.current) return;
    queryClient.setQueryData(queryKey, response); setDraft(null); setNotice('Dashboard theme saved.');
  }, onError: error => {
    if (!alive.current) return;
    if (error?.response?.status === 409 && error.response.data?.current) {
      queryClient.setQueryData(queryKey, error.response.data.current); setDraft(null);
      setNotice('Your theme changed elsewhere. Showing the latest saved theme.');
    } else setNotice('Your theme could not be saved. Your choice is still here.');
  } });
  useAdminNavigationBlocker({ id: 'dashboard-theme', dirty, busy: save.isPending, shouldBlock: teachingToolsShouldBlock, onDiscard: () => setDraft(null) });
  const choose = id => { setDraft({ baseline, preset: id, name, calendar }); setNotice(''); };
  const setCalendar = next => { setDraft({ baseline, preset: next && preset === null ? (today?.id ?? 'fall') : preset, name, calendar: next }); setNotice(''); };
  return <div className="space-y-5">
    {isUnavailableDashboardTheme(stored) && <p role="status" className="text-sm text-muted-foreground" data-testid="dashboard-theme-unavailable">Your saved theme is no longer available, so your dashboard shows Default.</p>}
    <fieldset disabled={save.isPending}><legend className="mb-2 text-sm font-medium">Preloaded themes</legend>
      <div role="radiogroup" aria-label="Preloaded themes" className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
        <ThemeOption id={null} label="Default" selected={preset === null && !calendar} onChoose={choose} />
        {readyDashboardThemePresets().map(option => <ThemeOption key={option.id} id={option.id} label={option.label} artwork={option.artwork} selected={preset === option.id} onChoose={choose} />)}
      </div>
    </fieldset>
    <div className="space-y-2 rounded-lg border p-3">
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" data-testid="checkbox-dashboard-theme-calendar" checked={calendar} disabled={save.isPending} onChange={event => setCalendar(event.target.checked)} />Follow the calendar: switch themes automatically by holiday and season</label>
      {calendar && <label className="flex items-center gap-2 pl-6 text-sm"><input type="checkbox" data-testid="checkbox-dashboard-theme-advent" checked={preset === 'advent'} disabled={save.isPending} onChange={event => choose(event.target.checked ? 'advent' : (today?.id ?? 'fall'))} />Include Advent (Catholic calendar)</label>}
      {calendar && today && <p className="pl-6 text-sm text-muted-foreground" data-testid="dashboard-theme-today">Today: {findDashboardThemePreset(today.id)?.label}</p>}
    </div>
    <div className="max-w-sm space-y-2"><Label htmlFor="dashboard-theme-name">Name it (optional)</Label>
      <Input id="dashboard-theme-name" data-testid="input-dashboard-theme-name" value={name} maxLength={40} placeholder="Who Dey" disabled={save.isPending || effectivePreset === null}
        onChange={event => { setDraft({ baseline, preset, name: event.target.value, calendar }); setNotice(''); }} />
      <p className="text-sm text-muted-foreground">Up to 40 characters. Only you see it.</p></div>
    <div className="rounded-lg border border-dashed p-3 text-sm text-muted-foreground" data-testid="dashboard-theme-upload-slot">Your own background image is coming in a later release.</div>
    {notice && <p role="status" className="text-sm">{notice}</p>}
    {dirty && <p role="status" className="text-sm">Unsaved theme</p>}
    <div className="flex flex-wrap gap-2"><Button data-testid="button-save-dashboard-theme" disabled={!dirty || !nameValid || save.isPending} onClick={() => save.mutate()}>{save.isPending ? 'Saving…' : 'Save theme'}</Button>
      <Button variant="outline" disabled={save.isPending || !dirty} onClick={() => { setDraft(null); setNotice(''); }}>Cancel</Button></div>
  </div>;
}

function ThemeOption({ id, label, artwork, selected, onChoose }) {
  return <button type="button" role="radio" aria-checked={selected} data-testid={`dashboard-theme-choice-${id ?? 'default'}`} onClick={() => onChoose(id)}
    className={`flex flex-col overflow-hidden rounded-lg border text-left transition-colors ${selected ? 'border-primary ring-1 ring-primary' : 'border-border hover:border-muted-foreground/50'}`}>
    <span aria-hidden="true" className="h-16 w-full bg-muted bg-cover bg-center" style={artwork ? { backgroundImage: `url("${artwork}")` } : undefined} />
    <span className="px-3 py-2 text-sm font-medium">{label}</span>
  </button>;
}
