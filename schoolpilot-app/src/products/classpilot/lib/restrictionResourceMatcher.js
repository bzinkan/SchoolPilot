// Dashboard copy of the precise restriction matcher (roadmap PR 2). The
// normative implementation is src/services/restrictionResources.ts on the
// server and ClassPilot 2.9.7 enforces its own port; this copy only keeps the
// teacher's off-task display honest for a student on an allowed video, page or
// document. It follows the same shared case file
// (tests/fixtures/restriction-resource-matcher-cases.json), except the
// public-suffix check, which only the server applies.

const PROVIDERS = new Set(['youtube', 'google_docs', 'google_slides', 'google_sheets', 'google_forms', 'google_drive']);
const YOUTUBE_ID = /^[A-Za-z0-9_-]{11}$/;
const GOOGLE_FILE_ID = /^[A-Za-z0-9_-]{20,128}$/;
const YOUTUBE_HOSTS = new Set(['youtube.com', 'm.youtube.com', 'youtube-nocookie.com']);
const YOUTUBE_PAGE_PATH = /^\/(?:shorts|live)\/([A-Za-z0-9_-]{11})(\/.*)?$/;
const YOUTUBE_PLAYER_PATH = /^\/(?:embed|v)\/([A-Za-z0-9_-]{11})\/?$/;
const YOUTU_BE_PATH = /^\/([A-Za-z0-9_-]{11})\/?$/;
// An embedded player link identifies one video only with these parameters;
// list, playlist and listType (or anything else) let it play other videos.
const YOUTUBE_PLAYER_PARAMETERS = new Set([
  'autoplay', 'cc_lang_pref', 'cc_load_policy', 'color', 'controls', 'disablekb', 'enablejsapi',
  'end', 'feature', 'fs', 'hl', 'iv_load_policy', 'loop', 'modestbranding', 'mute', 'origin',
  'playsinline', 'rel', 'si', 'start', 't', 'widget_referrer',
]);
// The raw value of an allowlisted player parameter: no separators or escapes.
const YOUTUBE_PLAYER_VALUE = /^[A-Za-z0-9._:/-]*$/;
const YOUTUBE_RESERVED_IDS = new Set(['videoseries', 'live_stream']);
// A path tail below a section prefix or after a provider id (the server's
// RESTRICTION_PATH_TAIL_PATTERN): no ';', encoded separator or dot, overlong
// UTF-8, fullwidth dot or slash, or malformed escape.
const RESTRICTION_PATH_TAIL = new RegExp('^(?:/(?:[^?#%;]|%(?:[013-46-9abdfABDF][0-9a-fA-F]|2[0-46-9a-dA-D]|5[0-9abd-fABD-F]|[Cc][2-9a-fA-F]'
  + '|[Ee][1-9a-eA-E]|[Ee]0%[AaBb][0-9a-fA-F]|[Ee][Ff]%(?:[0-9ac-fAC-F][0-9a-fA-F]|[Bb][0-9abd-fABD-F]'
  + '|[Bb][Cc]%(?:[0-79ac-fAC-F][0-9a-fA-F]|8[0-9a-dA-D]|[Bb][0-9abd-fABD-F]))))*)?$');
const DOCS_PATH = /^\/(?:u\/[0-9]{1,2}\/)?(document|presentation|spreadsheets|forms)\/(?:u\/[0-9]{1,2}\/)?d\/(e\/)?([A-Za-z0-9_-]{20,128})(\/.*)?$/;
const DRIVE_FILE_PATH = /^\/(?:u\/[0-9]{1,2}\/)?file\/(?:u\/[0-9]{1,2}\/)?d\/([A-Za-z0-9_-]{20,128})(\/.*)?$/;
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

function youtubeVideoId(value) {
  return typeof value === 'string' && YOUTUBE_ID.test(value) && !YOUTUBE_RESERVED_IDS.has(value) ? value : null;
}

function validResourceId(provider, resourceId) {
  if (typeof resourceId !== 'string') return false;
  if (provider === 'youtube') return youtubeVideoId(resourceId) !== null;
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

function safePathTail(tail) {
  return RESTRICTION_PATH_TAIL.test(tail ?? '');
}

function validSectionPathPrefix(value) {
  if (typeof value !== 'string' || value.length < 2 || value.length > 512) return false;
  if (!value.startsWith('/') || value.endsWith('/') || value.includes('//') || /[?#\\\s]/.test(value)) return false;
  if (!RESTRICTION_PATH_TAIL.test(value)) return false;
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

function youtubeHostVideoId(parsed) {
  if (parsed.pathname === '/watch') {
    const ids = parsed.searchParams.getAll('v');
    return ids.length === 1 ? youtubeVideoId(ids[0]) : null;
  }
  const player = YOUTUBE_PLAYER_PATH.exec(parsed.pathname);
  if (player) return youtubePlayerQueryHarmless(parsed.search) ? youtubeVideoId(player[1]) : null;
  const page = YOUTUBE_PAGE_PATH.exec(parsed.pathname);
  return page && safePathTail(page[2]) ? youtubeVideoId(page[1]) : null;
}

// Every raw name[=value] segment of a player link's query is allowlisted.
function youtubePlayerQueryHarmless(search) {
  if (search === '') return true;
  return search.slice(1).split('&').every((segment) => {
    if (segment === '') return true;
    const separator = segment.indexOf('=');
    const name = separator === -1 ? segment : segment.slice(0, separator);
    const value = separator === -1 ? '' : segment.slice(separator + 1);
    return YOUTUBE_PLAYER_PARAMETERS.has(name) && YOUTUBE_PLAYER_VALUE.test(value);
  });
}

function identityFromParsedUrl(parsed) {
  const host = restrictionMatchHostname(parsed.hostname);
  if (YOUTUBE_HOSTS.has(host)) {
    const id = youtubeHostVideoId(parsed);
    return id ? { provider: 'youtube', resourceId: id } : null;
  }
  if (host === 'youtu.be') {
    const id = youtubeVideoId(YOUTU_BE_PATH.exec(parsed.pathname)?.[1]);
    return id ? { provider: 'youtube', resourceId: id } : null;
  }
  if (host === 'docs.google.com') {
    const match = DOCS_PATH.exec(parsed.pathname);
    return match && safePathTail(match[4])
      ? { provider: DOCS_KIND_PROVIDER[match[1]], resourceId: `${match[2] || ''}${match[3]}` }
      : null;
  }
  if (host === 'drive.google.com') {
    const file = DRIVE_FILE_PATH.exec(parsed.pathname);
    if (file) return safePathTail(file[2]) ? { provider: 'google_drive', resourceId: file[1] } : null;
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
      && (parsed.pathname === resource.pathPrefix || parsed.pathname.startsWith(`${resource.pathPrefix}/`))
      && safePathTail(parsed.pathname.slice(resource.pathPrefix.length));
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
