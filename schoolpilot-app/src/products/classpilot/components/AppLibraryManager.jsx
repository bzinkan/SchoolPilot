import { useState } from 'react';
import { Bookmark, Edit, Plus, Star, Trash2 } from 'lucide-react';
import { Button } from '../../../components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../../../components/ui/card';
import { useClasspilotApps } from '../hooks/useClasspilotApps';
import { useAdminNavigationBlocker } from '../hooks/useAdminNavigation';
import { settingsSectionTransition } from '../hooks/useSettingsDraft';
import { teachingToolsShouldBlock } from '../lib/teachingTools';
import { appErrorMessage, appPreferenceChange, appScopeDescription, appSourceLabel, visibleApps } from '../lib/appLibrary';
import { AppIcon, AppWebsiteForm } from './AppButtonShared';

export default function AppLibraryManager({ scope = 'personal', active = true }) {
  const library = useClasspilotApps({ enabled: active });
  return <LibraryContent key={`${library.scopeId}:${scope}`} library={library} scope={scope} />;
}

function LibraryContent({ library, scope }) {
  const school = scope === 'school';
  const [editing, setEditing] = useState(undefined), [deleting, setDeleting] = useState(null), [notice, setNotice] = useState('');
  useAdminNavigationBlocker({ id: `app-library-${scope}`, busy: library.busy, shouldBlock: school ? settingsSectionTransition : teachingToolsShouldBlock });
  const permitted = !library.unavailableReason && (!school || library.canManageSchoolApps);
  const all = visibleApps(library.apps, { mode: 'flight-path' });
  const listed = all.filter(app => school ? app.source === 'school' : app.saved);
  const available = all.filter(app => !app.saved);
  async function save(values) {
    const app = editing ? await library.updateApp(editing.key, values, editing.revision) : await library.createApp(scope, values);
    setEditing(undefined); setNotice(`${app.name} saved.`);
  }
  async function remove(app) {
    try { await library.deleteApp(app.key, app.revision); setDeleting(null); setNotice(`${app.name} deleted. Existing Flight Paths keep their saved websites.`); }
    catch { /* Keep the confirmation available; the library renders the error. */ }
  }
  async function preference(app, field) {
    try { await library.setPreferences(app.key, appPreferenceChange(app, field)); }
    catch { /* The library renders the error and preserves the previous state. */ }
  }
  const row = app => <li key={app.key} className="space-y-2 rounded-md border p-3">
    <div className="flex flex-wrap items-start gap-3"><AppIcon app={app} /><div className="min-w-0 flex-1"><p className="break-words text-sm font-medium">{app.name}</p><p className="text-xs text-muted-foreground">{appSourceLabel(app.source)}{app.kind === 'bundle' ? ' · Flight Path bundle' : ''}</p><p className="mt-1 break-all text-xs text-muted-foreground">{app.launchUrl || appScopeDescription(app)}</p></div>
      <div className="flex flex-wrap gap-1">{!school && <><Button type="button" size="sm" variant="ghost" aria-label={`${app.saved ? 'Remove' : 'Add'} ${app.name} ${app.saved ? 'from' : 'to'} My Apps`} disabled={library.busy} onClick={() => void preference(app, 'saved')}><Bookmark aria-hidden="true" className={`mr-1 h-4 w-4 ${app.saved ? 'fill-current' : ''}`} />{app.saved ? 'Saved' : 'Add'}</Button><Button type="button" size="sm" variant="ghost" aria-label={`${app.favorite ? 'Unfavorite' : 'Favorite'} ${app.name}`} aria-pressed={app.favorite} disabled={library.busy} onClick={() => void preference(app, 'favorite')}><Star aria-hidden="true" className={`h-4 w-4 ${app.favorite ? 'fill-current text-amber-600 dark:text-amber-400' : ''}`} /></Button></>}
        {app.canEdit && app.source === scope && <><Button type="button" size="sm" variant="outline" aria-label={`Edit ${app.name}`} disabled={library.busy || editing !== undefined} onClick={() => { library.clearError(); setEditing(app); setDeleting(null); }}><Edit aria-hidden="true" className="h-4 w-4" /></Button><Button type="button" size="sm" variant="outline" aria-label={`Delete ${app.name}`} disabled={library.busy || editing !== undefined} onClick={() => { library.clearError(); setDeleting(app); }}><Trash2 aria-hidden="true" className="h-4 w-4" /></Button></>}
      </div>
    </div>
    {deleting?.key === app.key && <div className="space-y-2 rounded border p-3 text-sm" role="group" aria-label={`Delete ${deleting.name}?`}><p>Delete {deleting.name}? Existing Flight Paths keep their saved websites.</p><p className="break-all text-xs text-muted-foreground">{deleting.launchUrl}</p><div className="flex flex-wrap gap-2"><Button type="button" size="sm" variant="destructive" aria-label={`Confirm delete ${deleting.name}`} disabled={library.busy} onClick={() => void remove(deleting)}>Delete website</Button><Button type="button" size="sm" variant="outline" disabled={library.busy} onClick={() => setDeleting(null)}>Cancel</Button></div></div>}
  </li>;
  return <Card data-testid={school ? 'card-school-apps' : 'card-my-apps'}><CardHeader><div className="flex flex-wrap items-center justify-between gap-3"><CardTitle>{school ? 'School Apps' : 'My Apps'}</CardTitle>{permitted && <Button type="button" size="sm" variant="outline" disabled={library.busy || library.isLoading || Boolean(library.loadError) || editing !== undefined} onClick={() => { library.clearError(); setEditing(null); setDeleting(null); }}><Plus className="mr-1 h-4 w-4" />{school ? 'Add school website' : 'Add website'}</Button>}</div><CardDescription>{school ? 'Manage website buttons teachers can choose in this school.' : 'Save your learning tools once, then choose them in Open URL, Focus, and Flight Paths.'}</CardDescription></CardHeader>
    <CardContent className="space-y-4">{library.unavailableReason ? <p role="status" className="text-sm text-muted-foreground">{library.unavailableReason}</p>
      : library.loadError ? <p role="alert" className="text-sm text-destructive">The app library could not be loaded. <Button type="button" variant="link" aria-label="Retry app library" onClick={() => library.retry()}>Retry</Button></p>
      : library.isLoading ? <p role="status" className="text-sm text-muted-foreground">Loading apps…</p>
        : !permitted ? <p className="text-sm text-muted-foreground">Only school administrators can manage school apps.</p>
          : <>{editing !== undefined && <AppWebsiteForm key={editing?.key || 'create'} initialApp={editing} scope={scope} busy={library.busy} onSave={save} onCancel={() => setEditing(undefined)} />}
            {listed.length ? <ul className="space-y-2" aria-label={school ? 'School Apps' : 'My Apps'}>{listed.map(row)}</ul> : <p className="text-sm text-muted-foreground">{school ? 'No school apps yet. Add a website to share a button with teachers.' : 'No saved apps yet. Add your own website or browse other available apps below.'}</p>}
            {!school && available.length > 0 && <details className="rounded-md border p-3"><summary className="cursor-pointer text-sm font-medium">Browse and manage other apps</summary><ul className="mt-3 space-y-2" aria-label="Other available apps">{available.map(row)}</ul></details>}
          </>}
      {library.error && editing === undefined && <p role="alert" className="text-sm text-destructive">{appErrorMessage(library.error)}</p>}{notice && <p role="status" className="text-sm text-muted-foreground">{notice}</p>}
    </CardContent></Card>;
}
