// Dashboard copy of the precise restriction matcher (roadmap PR 2). The
// normative implementation is src/services/restrictionResources.ts on the
// server and ClassPilot 2.10.0 enforces its own port; this copy only keeps the
// teacher's off-task display honest for a student on an allowed video, page or
// document. It follows the same shared case file
// (tests/fixtures/restriction-resource-matcher-cases.json), except the
// public-suffix check, which only the server applies.

const PROVIDERS = new Set(['youtube', 'google_docs', 'google_slides', 'google_sheets', 'google_forms', 'google_drive']);
const YOUTUBE_ID = /^[A-Za-z0-9_-]{11}$/;
const GOOGLE_FILE_ID = /^[A-Za-z0-9_-]{20,128}$/;
const YOUTUBE_HOSTS = new Set(['youtube.com', 'm.youtube.com', 'youtube-nocookie.com']);
const YOUTUBE_PATH = /^\/(?:shorts|embed|v|live)\/([A-Za-z0-9_-]{11})(?:\/.*)?$/;
const YOUTU_BE_PATH = /^\/([A-Za-z0-9_-]{11})\/?$/;
const DOCS_PATH = /^\/(?:u\/[0-9]{1,2}\/)?(document|presentation|spreadsheets|forms)\/(?:u\/[0-9]{1,2}\/)?d\/(e\/)?([A-Za-z0-9_-]{20,128})(?:\/.*)?$/;
const DRIVE_FILE_PATH = /^\/(?:u\/[0-9]{1,2}\/)?file\/(?:u\/[0-9]{1,2}\/)?d\/([A-Za-z0-9_-]{20,128})(?:\/.*)?$/;
const DRIVE_ID_PATH = /^\/(?:u\/[0-9]{1,2}\/)?(?:open|uc)$/;
const HOSTNAME_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const DOCS_KIND_PROVIDER = { document: 'google_docs', presentation: 'google_slides', spreadsheets: 'google_sheets', forms: 'google_forms' };
const PROVIDER_DOCS_KIND = { google_docs: 'document', google_slides: 'presentation', google_sheets: 'spreadsheets', google_forms: 'forms' };

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(value, keys) {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}

export function restrictionMatchHostname(hostname) {
  let host = String(hostname || '').toLowerCase();
  if (host.endsWith('.')) host = host.slice(0, -1);
  if (host.startsWith('www.')) host = host.slice(4);
  return host;
}

function syntacticallyCanonicalHostname(value) {
  if (typeof value !== 'string' || !value || value.length > 253) return false;
  if (restrictionMatchHostname(value) !== value) return false;
  const labels = value.split('.');
  if (labels.length < 2 || labels.some((label) => !HOSTNAME_LABEL.test(label))) return false;
  return !/^[0-9]+$/.test(labels[labels.length - 1]);
}

function providerHostname(provider) {
  if (provider === 'youtube') return 'youtube.com';
  if (provider === 'google_drive') return 'drive.google.com';
  return 'docs.google.com';
}

function validResourceId(provider, resourceId) {
  if (typeof resourceId !== 'string') return false;
  if (provider === 'youtube') return YOUTUBE_ID.test(resourceId);
  if (provider === 'google_drive') return GOOGLE_FILE_ID.test(resourceId);
  return GOOGLE_FILE_ID.test(resourceId.startsWith('e/') ? resourceId.slice(2) : resourceId);
}

export function canonicalRestrictionResourceUrl(provider, resourceId) {
  if (provider === 'youtube') return `https://www.youtube.com/watch?v=${resourceId}`;
  if (provider === 'google_drive') return `https://drive.google.com/file/d/${resourceId}/view`;
  const kind = PROVIDER_DOCS_KIND[provider];
  if (provider === 'google_forms') return `https://docs.google.com/forms/d/${resourceId}/viewform`;
  if (resourceId.startsWith('e/')) {
    return `https://docs.google.com/${kind}/d/${resourceId}/${provider === 'google_sheets' ? 'pubhtml' : 'pub'}`;
  }
  return `https://docs.google.com/${kind}/d/${resourceId}/edit`;
}

function validSectionPathPrefix(value) {
  if (typeof value !== 'string' || value.length < 2 || value.length > 512) return false;
  if (!value.startsWith('/') || value.endsWith('/') || value.includes('//') || /[?#\\\s]/.test(value)) return false;
  try {
    return new URL(`https://example.com${value}`).pathname === value;
  } catch {
    return false;
  }
}

/** Structural validation of a delivered entry (the server also applies the public-suffix list). */
export function isValidRestrictionResource(value) {
  if (!isPlainObject(value) || !syntacticallyCanonicalHostname(value.hostname)) return false;
  if (value.type === 'website') {
    return hasExactKeys(value, ['type', 'hostname', 'includeSubdomains']) && value.includeSubdomains === true;
  }
  if (value.type === 'section') {
    return hasExactKeys(value, ['type', 'hostname', 'includeSubdomains', 'pathPrefix'])
      && value.includeSubdomains === false
      && validSectionPathPrefix(value.pathPrefix);
  }
  if (value.type === 'resource') {
    return hasExactKeys(value, ['type', 'hostname', 'includeSubdomains', 'provider', 'resourceId', 'canonicalUrl'])
      && value.includeSubdomains === false
      && PROVIDERS.has(value.provider)
      && validResourceId(value.provider, value.resourceId)
      && value.hostname === providerHostname(value.provider)
      && value.canonicalUrl === canonicalRestrictionResourceUrl(value.provider, value.resourceId);
  }
  return false;
}

function identityFromParsedUrl(parsed) {
  const host = restrictionMatchHostname(parsed.hostname);
  if (YOUTUBE_HOSTS.has(host)) {
    if (parsed.pathname === '/watch') {
      const ids = parsed.searchParams.getAll('v');
      return ids.length === 1 && YOUTUBE_ID.test(ids[0]) ? { provider: 'youtube', resourceId: ids[0] } : null;
    }
    const match = YOUTUBE_PATH.exec(parsed.pathname);
    return match ? { provider: 'youtube', resourceId: match[1] } : null;
  }
  if (host === 'youtu.be') {
    const match = YOUTU_BE_PATH.exec(parsed.pathname);
    return match ? { provider: 'youtube', resourceId: match[1] } : null;
  }
  if (host === 'docs.google.com') {
    const match = DOCS_PATH.exec(parsed.pathname);
    return match ? { provider: DOCS_KIND_PROVIDER[match[1]], resourceId: `${match[2] || ''}${match[3]}` } : null;
  }
  if (host === 'drive.google.com') {
    const file = DRIVE_FILE_PATH.exec(parsed.pathname);
    if (file) return { provider: 'google_drive', resourceId: file[1] };
    if (DRIVE_ID_PATH.test(parsed.pathname)) {
      const ids = parsed.searchParams.getAll('id');
      return ids.length === 1 && GOOGLE_FILE_ID.test(ids[0]) ? { provider: 'google_drive', resourceId: ids[0] } : null;
    }
  }
  return null;
}

export function extractRestrictionResourceIdentity(url) {
  if (typeof url !== 'string') return null;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.port) return null;
  return identityFromParsedUrl(parsed);
}

export function isUrlAllowedByRestrictionResource(url, resource) {
  if (!isValidRestrictionResource(resource) || typeof url !== 'string') return false;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.username || parsed.password) return false;
  const host = restrictionMatchHostname(parsed.hostname);
  if (resource.type === 'website') {
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return false;
    return host === resource.hostname || host.endsWith(`.${resource.hostname}`);
  }
  if (parsed.protocol !== 'https:' || parsed.port) return false;
  if (resource.type === 'section') {
    return host === resource.hostname
      && (parsed.pathname === resource.pathPrefix || parsed.pathname.startsWith(`${resource.pathPrefix}/`));
  }
  const identity = identityFromParsedUrl(parsed);
  return !!identity && identity.provider === resource.provider && identity.resourceId === resource.resourceId;
}

/**
 * Precise entries of a student's delivered classroom state that make a URL
 * on-task: the active Flight Path's sections and resources, and an active
 * "This resource only" Waypoint.
 */
export function isUrlAllowedByStudentPreciseRestrictions(url, student) {
  const restrictions = student?.classroomState?.restrictions;
  if (!isPlainObject(restrictions)) return false;
  const flightPath = restrictions.flightPath;
  if (flightPath?.active === true && Array.isArray(flightPath.resources)
    && flightPath.resources.some((resource) => isUrlAllowedByRestrictionResource(url, resource))) {
    return true;
  }
  const screenLock = restrictions.screenLock;
  return screenLock?.active === true && isUrlAllowedByRestrictionResource(url, screenLock.resource);
}

const PROVIDER_LABELS = {
  youtube: 'YouTube video',
  google_docs: 'Google Doc',
  google_slides: 'Google Slides',
  google_sheets: 'Google Sheet',
  google_forms: 'Google Form',
  google_drive: 'Drive file',
};

/** The link a teacher edits for an entry: its canonical URL, section URL or site. */
export function restrictionResourceUrl(entry) {
  if (entry?.type === 'resource') return entry.canonicalUrl;
  if (entry?.type === 'section') return `https://${entry.hostname}${entry.pathPrefix}`;
  return entry?.hostname ? `https://${entry.hostname}` : '';
}

/** Short chip label for Teaching tools. */
export function restrictionResourceLabel(entry) {
  if (entry?.type === 'resource') {
    const id = String(entry.resourceId || '');
    return `${PROVIDER_LABELS[entry.provider] || 'Resource'} ${id.length > 14 ? `${id.slice(0, 12)}…` : id}`;
  }
  if (entry?.type === 'section') return `${entry.hostname}${entry.pathPrefix}`;
  return entry?.hostname || '';
}
