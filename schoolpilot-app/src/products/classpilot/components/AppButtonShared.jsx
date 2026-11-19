import { useId, useState } from 'react';
import { Button } from '../../../components/ui/button';
import { Input } from '../../../components/ui/input';
import { Label } from '../../../components/ui/label';
import { useAdminNavigationBlocker } from '../hooks/useAdminNavigation';
import { settingsSectionTransition } from '../hooks/useSettingsDraft';
import { teachingToolsShouldBlock } from '../lib/teachingTools';
import { appErrorMessage, appInitials } from '../lib/appLibrary';

const ICONS = {
  classroom: '/app-icons/classroom.png',
  docs: '/app-icons/docs.png',
  slides: '/app-icons/slides.png',
  sheets: '/app-icons/sheets.png',
  forms: '/app-icons/forms.png',
  drive: '/app-icons/drive.png',
  ixl: '/app-icons/ixl.png',
  quill: '/app-icons/quill.png',
};

export function AppIcon({ app }) {
  const [failedIcon, setFailedIcon] = useState(null);
  const icon = ICONS[app.iconKey?.replace(/^google[-_]/, '')];
  const showIcon = icon && failedIcon !== icon;
  return <span aria-hidden="true" className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-xs font-semibold ${showIcon ? 'bg-white' : 'bg-muted text-muted-foreground'}`}>
    {showIcon ? <img src={icon} alt="" width={24} height={24} className="h-6 w-6 object-contain" decoding="async" onError={() => setFailedIcon(icon)} /> : appInitials(app.name)}
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
