export const appLibraryKey = (schoolId, viewerId) => ['/api/classpilot/apps', schoolId, viewerId];

export function visibleApps(apps, { mode = 'url', filter = 'all', search = '' } = {}) {
  const query = search.trim().toLocaleLowerCase();
  return apps.filter(app => (mode === 'flight-path' || app.kind !== 'bundle')
    && (filter === 'all' || (filter === 'my' ? app.saved : app.source === filter))
    && (!query || [app.name, app.launchUrl, ...(app.allowedDomains || []), ...(app.includedApps || [])].join(' ').toLocaleLowerCase().includes(query)))
    .sort((a, b) => Number(Boolean(b.favorite)) - Number(Boolean(a.favorite)) || a.name.localeCompare(b.name) || a.key.localeCompare(b.key));
}

function domainKey(value) {
  const trimmed = value.trim();
  try { return new URL(/^[a-z][a-z\d+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`).hostname.toLowerCase().replace(/^www\./, '').replace(/\.$/, ''); }
  catch { return trimmed.toLowerCase(); }
}

// Keep the existing draft's text (including incomplete manual edits). App
// selections only add domains; deselecting a tile never erases the draft.
export function appendAppDomains(existing, added) {
  const entries = existing.split(',').map(value => value.trim()).filter(Boolean);
  const seen = new Set(entries.map(domainKey));
  for (const domain of added) {
    const key = domainKey(domain);
    if (key && !seen.has(key)) { entries.push(domain); seen.add(key); }
  }
  return entries.join(', ');
}

export function appScopeDescription(app) {
  const domains = app.effectiveAllowedDomains || app.allowedDomains || [];
  const projected = app.effectiveAllowedDomains?.some(domain => !app.allowedDomains?.includes(domain));
  return `${domains.join(', ')}${projected ? ' · Additional websites are applied by the existing Classroom policy.' : ''}${domains.includes('docs.google.com') ? ' · Google Docs website includes Docs, Slides, Sheets, and Forms.' : ''}`;
}

export function appPreferenceChange(app, field) {
  if (field === 'favorite') return { saved: app.saved || !app.favorite, favorite: !app.favorite };
  return { saved: !app.saved, favorite: app.saved ? false : app.favorite };
}

export const appSourceLabel = source => ({ common: 'Common app', school: 'School app', personal: 'Personal app' }[source] || 'App');
export const appInitials = name => name.trim().split(/\s+/).slice(0, 2).map(word => word[0] || '').join('').toLocaleUpperCase();
export const appErrorMessage = error => error?.response?.data?.code === 'CLASSPILOT_APP_CONFLICT'
  ? 'This website button changed elsewhere. Your changes have not been applied. Cancel and reopen the editor or delete confirmation to review the latest saved version. Any open draft is kept.'
  : error?.response?.data?.error || error?.message || 'The app library could not be updated. Try again.';
