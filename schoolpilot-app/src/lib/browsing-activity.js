const PAGE_DETAILS_UNAVAILABLE = 'Page details unavailable';
const MAX_SEARCH_TEXT_LENGTH = 120;

// Keep provider recognition explicit; a similar-looking hostname is just a website.
const GOOGLE_SEARCH_HOSTS = new Set([
  'google.com', 'www.google.com',
  'google.ca', 'www.google.ca',
  'google.co.uk', 'www.google.co.uk',
  'google.com.au', 'www.google.com.au',
]);
const YOUTUBE_HOSTS = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com']);

function searchTitle(provider, query) {
  const text = (query || '').replace(/[\p{Cc}\p{Cf}\s]+/gu, ' ').trim();
  if (!text) return `${provider} search results`;

  const characters = Array.from(text);
  const boundedText = characters.length > MAX_SEARCH_TEXT_LENGTH
    ? `${characters.slice(0, MAX_SEARCH_TEXT_LENGTH - 1).join('').trimEnd()}…`
    : text;
  return `${provider} search: ${boundedText}`;
}

function googleDocsTitle(pathname) {
  const product = pathname.match(/^\/(document|spreadsheets|presentation)(?:\/|$)/)?.[1];
  if (!product) return 'Google Docs';
  const labels = {
    document: ['Google Docs', 'Google Docs document'],
    spreadsheets: ['Google Sheets', 'Google Sheets spreadsheet'],
    presentation: ['Google Slides', 'Google Slides presentation'],
  };
  const isFile = /^\/(?:document|spreadsheets|presentation)\/(?:u\/\d+\/)?d\/[^/]+(?:\/|$)/.test(pathname);
  return labels[product][isFile ? 1 : 0];
}

/**
 * Describe the recorded page when a tab title was unavailable. URL-derived labels
 * identify pages only; they do not establish editing, playback, or student intent.
 * This runs at display time so retained rows containing "Unknown" also benefit.
 */
export function getBrowsingActivityTitle(title, url) {
  const reportedTitle = typeof title === 'string' ? title.trim() : '';
  if (reportedTitle && reportedTitle.toLowerCase() !== 'unknown') return reportedTitle;
  if (typeof url !== 'string' || !url.trim()) return PAGE_DETAILS_UNAVAILABLE;

  let parsed;
  try {
    parsed = new URL(url.trim());
  } catch {
    return PAGE_DETAILS_UNAVAILABLE;
  }

  const { hostname, pathname, protocol, searchParams } = parsed;
  if (protocol === 'about:' && pathname === 'blank') return 'Blank page';
  if (protocol === 'chrome:' || protocol === 'chrome-search:') {
    if (hostname === 'newtab' || (protocol === 'chrome-search:' && hostname === 'local-ntp')) {
      return 'New tab';
    }
    if (protocol === 'chrome:') {
      if (hostname === 'history') return 'Chrome history';
      if (hostname === 'downloads') return 'Chrome downloads';
      if (hostname === 'settings') return 'Chrome settings';
      if (hostname === 'extensions') return 'Chrome extensions';
      return 'Chrome internal page';
    }
    return PAGE_DETAILS_UNAVAILABLE;
  }
  if (protocol !== 'http:' && protocol !== 'https:') return PAGE_DETAILS_UNAVAILABLE;

  if (GOOGLE_SEARCH_HOSTS.has(hostname) && /^\/search\/?$/.test(pathname)) {
    return searchTitle('Google', searchParams.get('q'));
  }
  if (hostname === 'docs.google.com') return googleDocsTitle(pathname);
  if (hostname === 'classroom.google.com') return 'Google Classroom';
  if (hostname === 'drive.google.com') return 'Google Drive';

  if (YOUTUBE_HOSTS.has(hostname)) {
    if (/^\/results\/?$/.test(pathname)) return searchTitle('YouTube', searchParams.get('search_query'));
    if ((pathname === '/watch' && searchParams.get('v')?.trim())
      || /^\/(?:shorts|embed|live)\/[^/]+\/?$/.test(pathname)) {
      return 'YouTube video page';
    }
    return 'YouTube';
  }
  if (hostname === 'youtu.be' && /^\/[^/]+\/?$/.test(pathname)) return 'YouTube video page';
  if ((hostname === 'bing.com' || hostname === 'www.bing.com') && /^\/search\/?$/.test(pathname)) {
    return searchTitle('Bing', searchParams.get('q'));
  }
  if ((hostname === 'duckduckgo.com' || hostname === 'www.duckduckgo.com')
    && pathname === '/' && searchParams.has('q')) {
    return searchTitle('DuckDuckGo', searchParams.get('q'));
  }
  return hostname.replace(/^www\./, '') || PAGE_DETAILS_UNAVAILABLE;
}
