import { useId, useState } from 'react';
import { BookOpen, FileText, FolderOpen, GraduationCap, Layers, ListChecks, Presentation, Sheet } from 'lucide-react';
import { Button } from '../../../components/ui/button';
import { Input } from '../../../components/ui/input';
import { Label } from '../../../components/ui/label';
import { useAdminNavigationBlocker } from '../hooks/useAdminNavigation';
import { settingsSectionTransition } from '../hooks/useSettingsDraft';
import { teachingToolsShouldBlock } from '../lib/teachingTools';
import { appErrorMessage, appInitials } from '../lib/appLibrary';

const ICONS = {
  classroom: [GraduationCap, 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200'],
  docs: [FileText, 'bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-200'],
  slides: [Presentation, 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-200'],
  sheets: [Sheet, 'bg-green-100 text-green-800 dark:bg-green-950 dark:text-green-200'],
  forms: [ListChecks, 'bg-purple-100 text-purple-800 dark:bg-purple-950 dark:text-purple-200'],
  drive: [FolderOpen, 'bg-sky-100 text-sky-800 dark:bg-sky-950 dark:text-sky-200'],
  ixl: [GraduationCap, 'bg-lime-100 text-lime-800 dark:bg-lime-950 dark:text-lime-200'],
  quill: [BookOpen, 'bg-orange-100 text-orange-800 dark:bg-orange-950 dark:text-orange-200'],
};

export function AppIcon({ app }) {
  const icon = ICONS[app.iconKey?.replace(/^google[-_]/, '')];
  const Icon = app.kind === 'bundle' ? Layers : icon?.[0];
  return <span aria-hidden="true" className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-xs font-semibold ${icon?.[1] || 'bg-muted text-muted-foreground'}`}>
    {Icon ? <Icon className="h-5 w-5" /> : appInitials(app.name)}
  </span>;
}

export function AppWebsiteForm({ initialApp, scope = 'personal', busy = false, onSave, onCancel }) {
  const id = useId();
  const [name, setName] = useState(initialApp?.name || '');
  const [launchUrl, setLaunchUrl] = useState(initialApp?.launchUrl || '');
  const [error, setError] = useState('');
  const dirty = name !== (initialApp?.name || '') || launchUrl !== (initialApp?.launchUrl || '');
  const valid = Boolean(name.trim() && launchUrl.trim());
  useAdminNavigationBlocker({ id: `app-website-${id}`, dirty, busy,
    shouldBlock: scope === 'school' ? settingsSectionTransition : teachingToolsShouldBlock,
    onDiscard: onCancel });
  async function save() {
    if (busy || !valid) return;
    setError('');
    try { await onSave({ name: name.trim(), launchUrl: launchUrl.trim() }); }
    catch (failure) { if (failure?.name !== 'AbortError' && failure?.code !== 'ERR_CANCELED') setError(appErrorMessage(failure)); }
  }
  return <div className="space-y-3 rounded-md border bg-muted/30 p-3" role="group" aria-labelledby={`${id}-heading`} onKeyDown={event => {
    if (event.key === 'Enter') { event.stopPropagation(); if (event.target.tagName === 'INPUT') { event.preventDefault(); if (!event.repeat && !event.nativeEvent.isComposing) void save(); } }
  }}>
    <p id={`${id}-heading`} className="text-sm font-medium">{initialApp ? 'Edit website button' : scope === 'school' ? 'Add a school website' : 'Add a personal website'}</p>
    <fieldset disabled={busy} className="grid gap-3 sm:grid-cols-2">
      <div className="space-y-1"><Label htmlFor={`${id}-name`}>Website name</Label><Input id={`${id}-name`} maxLength={120} value={name} onChange={event => setName(event.target.value)} placeholder="Math practice" /></div>
      <div className="space-y-1"><Label htmlFor={`${id}-url`}>Website address</Label><Input id={`${id}-url`} inputMode="url" maxLength={4096} value={launchUrl} onChange={event => setLaunchUrl(event.target.value)} placeholder="https://example.org" /></div>
    </fieldset>
    <p className="text-xs text-muted-foreground">{scope === 'school' ? 'Available to teachers in this school.' : 'Private to you in this school.'} Flight Paths use the website address; existing website rules still apply.</p>
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    <div className="flex flex-wrap gap-2"><Button type="button" size="sm" disabled={busy || !valid || Boolean(initialApp && !dirty)} onClick={() => void save()}>{busy ? 'Saving…' : initialApp ? 'Save changes' : 'Save website'}</Button><Button type="button" size="sm" variant="outline" disabled={busy} onClick={onCancel}>Cancel</Button></div>
  </div>;
}
