import { useId, useState } from 'react';
import { Bookmark, Plus, Search, Star } from 'lucide-react';
import { Button } from '../../../components/ui/button';
import { Input } from '../../../components/ui/input';
import { useClasspilotApps } from '../hooks/useClasspilotApps';
import { appErrorMessage, appPreferenceChange, appScopeDescription, appSourceLabel, visibleApps } from '../lib/appLibrary';
import { AppIcon, AppWebsiteForm } from './AppButtonShared';

const FILTERS = [['all', 'All apps'], ['my', 'My Apps'], ['school', 'School apps'], ['common', 'Common apps']];

export default function AppPicker({ mode = 'url', selectedUrl, onSelect, onAddDomains, disabled = false }) {
  const library = useClasspilotApps();
  return <PickerContent key={library.scopeId} library={library} mode={mode} selectedUrl={selectedUrl} onSelect={onSelect} onAddDomains={onAddDomains} disabled={disabled} />;
}

function PickerContent({ library, mode, selectedUrl, onSelect, onAddDomains, disabled }) {
  const id = useId();
  const [filter, setFilter] = useState('all'), [search, setSearch] = useState('');
  const [selected, setSelected] = useState([]), [chosen, setChosen] = useState(''), [adding, setAdding] = useState(false);
  const [notice, setNotice] = useState('');
  const multi = mode === 'flight-path';
  const locked = disabled || library.busy;
  const apps = visibleApps(library.apps, { mode, filter, search });
  let selectedKey = chosen;
  if (selectedUrl !== undefined) {
    const url = typeof selectedUrl === 'string' ? selectedUrl.trim() : '';
    const matching = library.apps.filter(app => app.kind !== 'bundle' && app.launchUrl === url);
    selectedKey = matching.find(app => app.key === chosen)?.key || matching[0]?.key || '';
  }
  function choose(app) {
    if (locked) return;
    if (multi) setSelected(values => values.includes(app.key) ? values.filter(key => key !== app.key) : [...values, app.key]);
    else { setChosen(app.key); onSelect?.(app); }
  }
  async function preferences(app, field) {
    try { await library.setPreferences(app.key, appPreferenceChange(app, field)); }
    catch { /* The scoped library renders the refused update without losing selection. */ }
  }
  async function create(values) {
    const app = await library.createApp('personal', values);
    setAdding(false); setFilter('my'); setSearch(''); setNotice(`${app.name} saved to My Apps.`);
    if (multi) setSelected(values => [...new Set([...values, app.key])]);
    else { setChosen(app.key); onSelect?.(app); }
  }
  function addSelected() {
    const domains = [...new Set(library.apps.filter(app => selected.includes(app.key)).flatMap(app => app.allowedDomains))];
    if (domains.length) { onAddDomains?.(domains); setSelected([]); setNotice('Selected app websites added to the Flight Path draft.'); }
  }
  if (library.unavailableReason) return <section className="space-y-2 rounded-lg border p-3" aria-label="App picker" data-testid="app-picker"><h3 className="text-sm font-semibold">Choose apps</h3><p role="status" className="text-sm text-muted-foreground">{library.unavailableReason}</p></section>;
  return <section className="space-y-3 rounded-lg border p-3" aria-label="App picker" data-testid="app-picker">
    <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="text-sm font-semibold">Choose apps</h3><Button type="button" variant="outline" size="sm" disabled={locked || library.isLoading || Boolean(library.loadError)} onClick={() => { library.clearError(); setAdding(true); }}><Plus className="mr-1 h-4 w-4" />Add website</Button></div>
    <p className="text-xs text-muted-foreground">{multi ? 'Select learning tools, then add their websites to your draft.' : 'Choose a destination, then confirm the classroom action below.'}</p>
    {adding && <AppWebsiteForm busy={locked} onSave={create} onCancel={() => setAdding(false)} />}
    <div className="relative"><Search aria-hidden="true" className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" /><Input id={`${id}-search`} aria-label="Search apps" placeholder="Search apps or websites" className="pl-8" value={search} disabled={disabled} onChange={event => setSearch(event.target.value)} /></div>
    <div className="flex flex-wrap gap-1" role="group" aria-label="Filter app library">{FILTERS.map(([value, label]) => <Button type="button" key={value} size="sm" variant={filter === value ? 'secondary' : 'ghost'} aria-pressed={filter === value} disabled={disabled} onClick={() => setFilter(value)}>{label}</Button>)}</div>
    {library.loadError ? <p role="alert" className="text-sm text-destructive">The app library could not be loaded. You can still enter a website manually. <Button type="button" variant="link" size="sm" aria-label="Retry app library" onClick={() => library.retry()}>Retry</Button></p>
      : library.isLoading ? <p role="status" className="text-sm text-muted-foreground">Loading apps…</p>
        : apps.length === 0 ? <p className="text-sm text-muted-foreground">{search ? 'No apps match your search.' : filter === 'my' ? 'Save an app or add a website to start My Apps.' : 'No apps in this collection yet.'}</p>
          : <div className="grid max-h-72 grid-cols-1 gap-2 overflow-y-auto pr-1 sm:grid-cols-2" aria-label="Available apps">{apps.map(app => {
            const pressed = multi ? selected.includes(app.key) : selectedKey === app.key;
            return <div key={app.key} className={`rounded-md border ${pressed ? 'border-primary bg-primary/5' : 'bg-background'}`}>
              <button type="button" data-testid={`app-button-${app.key}`} aria-label={`${multi ? 'Select' : 'Choose'} ${app.name}`} aria-pressed={pressed} disabled={locked} onClick={() => choose(app)} className="flex w-full items-start gap-2 rounded-md p-2.5 text-left outline-none hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50">
                <AppIcon app={app} /><span className="min-w-0 flex-1"><span className="block break-words text-sm font-medium">{app.name}</span><span className="block text-xs text-muted-foreground">{appSourceLabel(app.source)}{app.kind === 'bundle' ? ' · Bundle' : ''}</span><span className="mt-1 block break-words text-xs text-muted-foreground">{appScopeDescription(app)}</span>{app.includedApps?.length > 0 && <span className="mt-1 block text-xs text-muted-foreground">Includes {app.includedApps.join(', ')}</span>}</span>
              </button>
              <div className="flex justify-end gap-1 border-t px-1 py-0.5"><Button type="button" size="sm" variant="ghost" className="h-7 px-2 text-xs" aria-label={`${app.saved ? 'Remove' : 'Add'} ${app.name} ${app.saved ? 'from' : 'to'} My Apps`} disabled={locked} onClick={() => void preferences(app, 'saved')}><Bookmark aria-hidden="true" className={`mr-1 h-3.5 w-3.5 ${app.saved ? 'fill-current' : ''}`} />{app.saved ? 'Saved' : 'My Apps'}</Button><Button type="button" size="sm" variant="ghost" className="h-7 px-2" aria-label={`${app.favorite ? 'Unfavorite' : 'Favorite'} ${app.name}`} aria-pressed={app.favorite} disabled={locked} onClick={() => void preferences(app, 'favorite')}><Star aria-hidden="true" className={`h-3.5 w-3.5 ${app.favorite ? 'fill-current text-amber-600 dark:text-amber-400' : ''}`} /></Button></div>
            </div>;
          })}</div>}
    {multi && <Button type="button" size="sm" disabled={locked || !selected.some(key => library.apps.some(app => app.key === key))} onClick={addSelected}>Add selected apps</Button>}
    {library.error && !adding && <p role="alert" className="text-sm text-destructive">{appErrorMessage(library.error)}</p>}
    {notice && <p role="status" className="text-xs text-muted-foreground">{notice}</p>}
  </section>;
}
