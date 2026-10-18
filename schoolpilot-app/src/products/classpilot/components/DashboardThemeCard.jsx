import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { apiRequest, queryClient } from '../../../lib/queryClient';
import { Button } from '../../../components/ui/button';
import { Input } from '../../../components/ui/input';
import { Label } from '../../../components/ui/label';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../../../components/ui/card';
import { useAdminNavigationBlocker } from '../hooks/useAdminNavigation';
import { teacherPreferencesKey, teachingToolsShouldBlock } from '../lib/teachingTools';
import { DASHBOARD_THEME_IMAGE_FITS, DASHBOARD_THEME_IMAGE_FIT_LABELS, dashboardThemeAssetUrl, describeDashboardTheme, findDashboardThemePreset, isUnavailableDashboardTheme, normalizeImageFit, readyDashboardThemePresets, resolveDashboardTheme, resolveSchoolTheme } from '../../../shared/themes/presets';
import { BACKGROUND_INPUT_TYPES, prepareBackgroundImage, sha256Hex } from '../../../shared/themes/backgroundImage';

const headers = schoolId => ({ headers: { 'X-School-Id': schoolId } });

// Teaching tools › Appearance. Personal to the signed-in teacher; saving a theme
// never sends a student command and never changes anyone else's dashboard.
export default function DashboardThemeCard({ schoolId, viewerId, active = true, timeZone }) {
  const key = teacherPreferencesKey(schoolId, viewerId);
  const query = useQuery({ queryKey: key, queryFn: ({ signal }) => apiRequest('GET', '/classpilot/teacher/preferences', undefined,
    { signal, ...headers(schoolId) }), enabled: Boolean(active && schoolId && viewerId), retry: false });
  const data = query.data;
  return <Card data-testid="card-dashboard-theme"><CardHeader><CardTitle>Dashboard theme</CardTitle>
    <CardDescription>Pick a look for your own ClassPilot dashboard. Student status colors never change, so alerts always look the same. A theme replaces light or dark mode while it is on.</CardDescription></CardHeader>
    <CardContent>{data
      ? (!data.dashboardThemesEnabled
        ? <p role="status" className="text-sm text-muted-foreground" data-testid="dashboard-theme-disabled">Dashboard themes are not turned on for your school yet.</p>
        : data.dashboardThemeLocked
          ? <p role="status" className="text-sm" data-testid="dashboard-theme-locked">Your school has set the dashboard theme for everyone: <strong>{resolveSchoolTheme(data, { timeZone })?.label ?? describeDashboardTheme(data.schoolDashboardTheme)}</strong>. Ask an administrator to change it.</p>
          : <ThemeEditor incoming={data} queryKey={key} schoolId={schoolId} timeZone={timeZone} />)
      : query.isError ? <p role="alert">Your theme could not be loaded. <Button variant="link" onClick={() => query.refetch()}>Retry</Button></p>
        : <p role="status">Loading your theme…</p>}</CardContent></Card>;
}

function ThemeEditor({ incoming, queryKey, schoolId, timeZone }) {
  const [draft, setDraft] = useState(null), [notice, setNotice] = useState('');
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const baseline = draft?.baseline || incoming;
  const stored = baseline.dashboardTheme ?? null;
  // The library is server state, not part of the revision-checked draft, so it
  // reads from the live cache: an upload finished mid-draft shows at once. An
  // older server sends the single `dashboardThemeAsset` only.
  const assets = Array.isArray(incoming.dashboardThemeAssets) ? incoming.dashboardThemeAssets : incoming.dashboardThemeAsset ? [incoming.dashboardThemeAsset] : [];
  const libraryLimit = Number.isInteger(incoming.dashboardThemeLibraryLimit) ? incoming.dashboardThemeLibraryLimit : 5;
  const storedPreset = stored?.kind === 'preset' ? stored.preset : stored?.kind === 'image' ? 'image' : stored?.kind === 'none' ? 'none' : null;
  const storedAssetId = stored?.kind === 'image' && typeof stored.imageAssetId === 'string' ? stored.imageAssetId : null;
  const storedFit = normalizeImageFit(stored?.fit);
  const storedName = typeof stored?.name === 'string' ? stored.name : '';
  const storedCalendar = stored?.calendar === true;
  const storedKiosk = stored?.kiosk !== false;
  const preset = draft ? draft.preset : storedPreset;
  const name = draft ? draft.name : storedName;
  const calendar = draft ? draft.calendar : storedCalendar;
  const kiosk = draft ? draft.kiosk : storedKiosk;
  const assetId = draft ? draft.assetId : storedAssetId;
  const fit = draft ? draft.fit : storedFit;
  const dirty = preset !== storedPreset || name.trim() !== storedName || calendar !== storedCalendar || kiosk !== storedKiosk || assetId !== storedAssetId || fit !== storedFit;
  // The picked upload, if it is still in the library.
  const asset = assetId ? assets.find(entry => entry.id === assetId) ?? null : null;
  const uploadsEnabled = incoming.dashboardThemeUploadsEnabled === true;
  const schoolCalendar = incoming.schoolCalendar ?? null;
  // In calendar mode the saved preset is only the Advent hint; today's pick is shown for context.
  const today = calendar ? resolveDashboardTheme({ kind: 'preset', preset: preset === 'advent' ? 'advent' : 'fall', calendar: true }, { timeZone, calendar: schoolCalendar }) : null;
  // What following the school shows today: the admin's fixed theme or the school calendar's pick.
  const schoolToday = resolveSchoolTheme(incoming, { timeZone });
  const effectivePreset = preset === 'image' ? 'image' : preset === 'none' ? 'none' : calendar ? (preset === 'advent' ? 'advent' : (today?.id ?? 'fall')) : preset;
  const personal = effectivePreset !== null && effectivePreset !== 'none';
  const nameValid = name.trim().length <= 40;
  const payloadTheme = () => {
    const label = { ...(name.trim() ? { name: name.trim() } : {}), ...(kiosk ? {} : { kiosk: false }) };
    if (effectivePreset === 'none') return { kind: 'none' };
    if (effectivePreset === 'image') return asset ? { kind: 'image', imageAssetId: asset.id, fit, ...label } : null;
    return effectivePreset ? { kind: 'preset', preset: effectivePreset, ...(calendar ? { calendar: true } : {}), ...label } : null;
  };
  const save = useMutation({ mutationFn: () => apiRequest('PATCH', '/classpilot/teacher/preferences', {
    expectedRevision: baseline.revision, dashboardTheme: payloadTheme(),
  }, headers(schoolId)), onSuccess: response => {
    if (!alive.current) return;
    queryClient.setQueryData(queryKey, response); setDraft(null); setNotice('Dashboard theme saved.');
  }, onError: error => {
    if (!alive.current) return;
    if (error?.response?.status === 409 && error.response.data?.current) {
      queryClient.setQueryData(queryKey, error.response.data.current); setDraft(null);
      setNotice('Your theme changed elsewhere. Showing the latest saved theme.');
    } else setNotice('Your theme could not be saved. Your choice is still here.');
  } });
  const remove = useMutation({ mutationFn: id => apiRequest('DELETE', `/classpilot/teacher/theme-asset/${encodeURIComponent(id)}`, undefined, headers(schoolId)), onSuccess: response => {
    if (!alive.current) return;
    if (response?.preferences) queryClient.setQueryData(queryKey, response.preferences);
    setDraft(null); setNotice('Background removed.');
  }, onError: () => { if (alive.current) setNotice('The background could not be removed. Try again.'); } });
  const busy = save.isPending || remove.isPending;
  useAdminNavigationBlocker({ id: 'dashboard-theme', dirty, busy, shouldBlock: teachingToolsShouldBlock, onDiscard: () => setDraft(null) });
  const choose = id => { setDraft({ baseline, preset: id, name, calendar: id === 'image' || id === 'none' || id === null ? false : calendar, kiosk, assetId, fit }); setNotice(''); };
  const chooseImage = id => { setDraft({ baseline, preset: 'image', name, calendar: false, kiosk, assetId: id, fit }); setNotice(''); };
  const setFit = next => { setDraft({ baseline, preset, name, calendar, kiosk, assetId, fit: normalizeImageFit(next) }); setNotice(''); };
  const setCalendar = next => { setDraft({ baseline, preset: next && (preset === null || preset === 'image') ? (today?.id ?? 'fall') : preset, name, calendar: next, kiosk, assetId, fit }); setNotice(''); };
  return <div className="space-y-5">
    {isUnavailableDashboardTheme(stored) && <p role="status" className="text-sm text-muted-foreground" data-testid="dashboard-theme-unavailable">Your saved theme is no longer available, so your dashboard follows the school.</p>}
    <fieldset disabled={busy}><legend className="mb-2 text-sm font-medium">Preloaded themes</legend>
      <div role="radiogroup" aria-label="Preloaded themes" className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
        <ThemeOption id={null} label="Follow the school calendar" artwork={schoolToday?.artwork} hint={schoolToday ? `Today: ${schoolToday.label}` : 'No school theme today'} selected={preset === null && !calendar} onChoose={choose} />
        {readyDashboardThemePresets().map(option => <ThemeOption key={option.id} id={option.id} label={option.label} artwork={option.artwork} selected={preset === option.id} onChoose={choose} />)}
        <ThemeOption id="none" label="Plain, no theme" hint="Light or dark mode, nothing else" selected={preset === 'none'} onChoose={choose} />
      </div>
    </fieldset>
    {(uploadsEnabled || assets.length > 0) && <fieldset disabled={busy}>
      <legend className="mb-2 text-sm font-medium">Your backgrounds <span className="font-normal text-muted-foreground" data-testid="dashboard-theme-library-count">{assets.length} of {libraryLimit}</span></legend>
      {assets.length > 0
        ? <div role="radiogroup" aria-label="Your backgrounds" className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          {assets.map((entry, index) => <LibraryOption key={entry.id} asset={entry} index={index} schoolId={schoolId} selected={preset === 'image' && assetId === entry.id} busy={busy}
            onChoose={chooseImage} onRemove={id => remove.mutate(id)} />)}
        </div>
        : <p className="text-sm text-muted-foreground" data-testid="dashboard-theme-library-empty">No uploads yet.</p>}
    </fieldset>}
    {preset === 'image' && <fieldset disabled={busy} className="space-y-2 rounded-lg border p-3" data-testid="dashboard-theme-fit">
      <legend className="px-1 text-sm font-medium">How the picture is drawn</legend>
      {DASHBOARD_THEME_IMAGE_FITS.map(option => <label key={option} className="flex items-center gap-2 text-sm">
        <input type="radio" name="dashboard-theme-fit" value={option} checked={fit === option} data-testid={`radio-dashboard-theme-fit-${option}`} onChange={() => setFit(option)} />
        {DASHBOARD_THEME_IMAGE_FIT_LABELS[option]}<span className="text-xs text-muted-foreground">{FIT_HINTS[option]}</span></label>)}
    </fieldset>}
    {preset !== 'image' && preset !== 'none' && <div className="space-y-2 rounded-lg border p-3">
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" data-testid="checkbox-dashboard-theme-calendar" checked={calendar} disabled={busy} onChange={event => setCalendar(event.target.checked)} />Follow the calendar: switch themes automatically by holiday and season</label>
      {calendar && <label className="flex items-center gap-2 pl-6 text-sm"><input type="checkbox" data-testid="checkbox-dashboard-theme-advent" checked={preset === 'advent'} disabled={busy} onChange={event => choose(event.target.checked ? 'advent' : (today?.id ?? 'fall'))} />Include Advent (Catholic calendar)</label>}
      {calendar && today && <p className="pl-6 text-sm text-muted-foreground" data-testid="dashboard-theme-today">Today: {findDashboardThemePreset(today.id)?.label}</p>}
    </div>}
    <div className="max-w-sm space-y-2"><Label htmlFor="dashboard-theme-name">Name it (optional)</Label>
      <Input id="dashboard-theme-name" data-testid="input-dashboard-theme-name" value={name} maxLength={40} placeholder="Who Dey" disabled={busy || !personal}
        onChange={event => { setDraft({ baseline, preset, name: event.target.value, calendar, kiosk }); setNotice(''); }} />
      <p className="text-sm text-muted-foreground">Up to 40 characters. Only you see it.</p></div>
    {personal && <label className="flex items-center gap-2 text-sm"><input type="checkbox" data-testid="checkbox-dashboard-theme-kiosk" checked={kiosk} disabled={busy}
      onChange={event => { setDraft({ baseline, preset, name, calendar, kiosk: event.target.checked }); setNotice(''); }} />Show my theme on the PassPilot kiosk while it is bound to my class</label>}
    {uploadsEnabled
      ? <BackgroundUpload schoolId={schoolId} queryKey={queryKey} count={assets.length} limit={libraryLimit} busy={busy} onReady={chooseImage} />
      : <div className="rounded-lg border border-dashed p-3 text-sm text-muted-foreground" data-testid="dashboard-theme-upload-slot">Custom background images are not turned on for your school.</div>}
    {notice && <p role="status" className="text-sm">{notice}</p>}
    {dirty && <p role="status" className="text-sm">Unsaved theme</p>}
    <div className="flex flex-wrap gap-2"><Button data-testid="button-save-dashboard-theme" disabled={!dirty || !nameValid || busy || (effectivePreset === 'image' && !asset)} onClick={() => save.mutate()}>{save.isPending ? 'Saving…' : 'Save theme'}</Button>
      <Button variant="outline" disabled={busy || !dirty} onClick={() => { setDraft(null); setNotice(''); }}>Cancel</Button></div>
  </div>;
}

const FIT_HINTS = Object.freeze({ cover: 'Crops the edges on wide screens', contain: 'Shows everything over a blurred copy', tile: 'Repeats a small image or pattern' });

// One tile per uploaded background. The remove button sits beside the radio,
// never inside it, so the tile stays one button for the keyboard.
function LibraryOption({ asset, index, schoolId, selected, busy, onChoose, onRemove }) {
  const label = `Background ${index + 1}`;
  const hint = asset.width && asset.height ? `${asset.width} × ${asset.height}` : undefined;
  return <div className="relative">
    <ThemeOption id={`image-${asset.id}`} label={label} hint={hint} artwork={dashboardThemeAssetUrl(asset.id, schoolId)} selected={selected} onChoose={() => onChoose(asset.id)} />
    <Button type="button" variant="secondary" size="sm" className="absolute right-2 top-2 h-7 px-2 text-xs" disabled={busy} aria-label={`Remove ${label}`}
      data-testid={`button-remove-dashboard-background-${asset.id}`} onClick={() => onRemove(asset.id)}>Remove</Button>
  </div>;
}

// Reserve → upload the downsized bytes → the server re-encodes and strips
// metadata → the asset becomes a "Your backgrounds" tile. Only this teacher
// can ever load it.
function BackgroundUpload({ schoolId, queryKey, count, limit, busy, onReady }) {
  const [status, setStatus] = useState(''), [error, setError] = useState('');
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const upload = useMutation({ mutationFn: async file => {
    const prepared = await prepareBackgroundImage(file);
    const bytes = await prepared.blob.arrayBuffer();
    const reserved = await apiRequest('POST', '/classpilot/teacher/theme-asset', { contentType: prepared.contentType, size: bytes.byteLength, sha256: await sha256Hex(bytes) }, headers(schoolId));
    const result = await apiRequest('PUT', `/classpilot/teacher/theme-asset/${encodeURIComponent(reserved.asset.id)}/content`, prepared.blob,
      { headers: { 'X-School-Id': schoolId, 'Content-Type': prepared.contentType } });
    return result;
  }, onMutate: () => { setError(''); setStatus('Uploading your background…'); }, onSuccess: result => {
    if (!alive.current) return;
    // The server returns the refreshed preferences beside the asset (reserving
    // may have created the row); an older server returns the asset alone.
    const saved = result.asset;
    const summary = { id: saved.id, status: saved.status, contentType: saved.contentType, byteSize: saved.byteSize, width: saved.width, height: saved.height };
    queryClient.setQueryData(queryKey, current => result.preferences ?? (current && ({ ...current, dashboardThemeAsset: summary,
      dashboardThemeAssets: [...(current.dashboardThemeAssets ?? []).filter(entry => entry.id !== saved.id), summary] })));
    setStatus('Background ready. Save to use it.'); onReady(saved.id);
  }, onError: failure => {
    if (!alive.current) return;
    setStatus('');
    const code = failure?.response?.data?.code || failure?.message;
    // The server's own sentence names the reason (storage unavailable, image
    // unreadable, upload replaced); keep the generic line for network failures.
    const serverMessage = typeof failure?.response?.data?.error === 'string' ? failure.response.data.error.trim() : '';
    setError(code === 'unsupported_type' ? 'Choose a PNG, JPG or WebP image.' : code === 'too_large' ? 'That image is too large even after resizing. Choose a smaller one.'
      : serverMessage || 'The background could not be uploaded. Try again.');
  } });
  const pending = busy || upload.isPending;
  const full = count >= limit;
  return <div className="space-y-2 rounded-lg border p-3" data-testid="dashboard-theme-upload-slot">
    <p className="text-sm font-medium">Add a background</p>
    <p className="text-sm text-muted-foreground">Your team, your college, your mascot, anything you have the right to use. PNG, JPG or WebP, up to {limit} images; only you see them.</p>
    <div className="flex flex-wrap items-center gap-3">
      <label className={`inline-flex items-center rounded-md border px-3 py-2 text-sm font-medium ${pending || full ? 'cursor-not-allowed opacity-60' : 'cursor-pointer hover:bg-muted'}`}>
        <input type="file" accept={BACKGROUND_INPUT_TYPES.join(',')} className="sr-only" data-testid="input-dashboard-theme-file" disabled={pending || full}
          onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; if (file) upload.mutate(file); }} />
        Upload image
      </label>
      {full && <span className="text-sm text-muted-foreground" data-testid="dashboard-theme-library-full">You have {limit} of {limit} backgrounds. Remove one to add another.</span>}
    </div>
    {status && <p role="status" className="text-sm" data-testid="dashboard-theme-upload-status">{status}</p>}
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
  </div>;
}

function ThemeOption({ id, label, hint, artwork, selected, onChoose }) {
  return <button type="button" role="radio" aria-checked={selected} data-testid={`dashboard-theme-choice-${id ?? 'default'}`} onClick={() => onChoose(id)}
    className={`flex flex-col overflow-hidden rounded-lg border text-left transition-colors ${selected ? 'border-primary ring-1 ring-primary' : 'border-border hover:border-muted-foreground/50'}`}>
    <span aria-hidden="true" className="h-16 w-full bg-muted bg-cover bg-center" style={artwork ? { backgroundImage: `url("${artwork}")` } : undefined} />
    <span className="px-3 py-2 text-sm font-medium">{label}{hint && <span className="block text-xs font-normal text-muted-foreground" data-testid={`dashboard-theme-hint-${id ?? 'default'}`}>{hint}</span>}</span>
  </button>;
}
