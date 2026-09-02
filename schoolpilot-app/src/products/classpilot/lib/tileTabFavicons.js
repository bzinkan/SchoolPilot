// Pure projection of a student's open-tab snapshot into the small favicon
// strip rendered on the teacher tile. Favicon URLs are untrusted student
// telemetry: only https URLs of a bounded length may ever become an <img>.
export const TILE_FAVICON_MAX = 8;
export const TILE_FAVICON_URL_MAX_LENGTH = 2048;

export function safeFaviconUrl(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > TILE_FAVICON_URL_MAX_LENGTH) return null;
  try {
    return new URL(trimmed).protocol === 'https:' ? trimmed : null;
  } catch {
    return null;
  }
}

function tabHostname(url) {
  if (typeof url !== 'string' || !url) return null;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    const hostname = parsed.hostname.toLowerCase();
    return hostname || null;
  } catch {
    return null;
  }
}

function isActiveTab(tab, student) {
  const tabRef = typeof tab?.tabRef === 'string' ? tab.tabRef : '';
  const activeTabRef = typeof student?.activeTabRef === 'string' ? student.activeTabRef : '';
  if (tabRef && activeTabRef) return tabRef === activeTabRef;
  const activeTabUrl = typeof student?.activeTabUrl === 'string' ? student.activeTabUrl : '';
  return Boolean(activeTabUrl) && tab?.url === activeTabUrl;
}

export function deriveTileTabFavicons(student, { max = TILE_FAVICON_MAX } = {}) {
  const allOpenTabs = Array.isArray(student?.allOpenTabs) ? student.allOpenTabs : [];
  const totalCount = Number.isFinite(student?.openTabCount)
    ? Math.max(0, Math.floor(student.openTabCount))
    : allOpenTabs.length;
  const byHostname = new Map();

  for (const tab of allOpenTabs) {
    const hostname = tabHostname(tab?.url);
    if (!hostname) continue;
    const active = isActiveTab(tab, student);
    const existing = byHostname.get(hostname);
    if (existing) {
      // One chip per hostname; the active tab wins the chip's identity so the
      // ring points at what the student is actually looking at.
      if (active && !existing.active) {
        existing.active = true;
        existing.key = tab.tabRef || tab.url;
        existing.title = typeof tab.title === 'string' && tab.title.trim() ? tab.title.trim() : hostname;
        existing.favicon = safeFaviconUrl(tab.favicon) ?? existing.favicon;
      }
      continue;
    }
    byHostname.set(hostname, {
      key: tab.tabRef || tab.url,
      hostname,
      title: typeof tab.title === 'string' && tab.title.trim() ? tab.title.trim() : hostname,
      favicon: safeFaviconUrl(tab.favicon),
      active,
    });
  }

  const ordered = [...byHostname.values()];
  const activeIndex = ordered.findIndex((tab) => tab.active);
  if (activeIndex > 0) ordered.unshift(...ordered.splice(activeIndex, 1));

  const limit = Number.isFinite(max) && max > 0 ? Math.floor(max) : TILE_FAVICON_MAX;
  const tabs = ordered.slice(0, limit);
  const shownCount = tabs.length;

  return {
    tabs,
    shownCount,
    totalCount,
    overflow: Math.max(0, totalCount - shownCount),
    truncated: student?.tabsTruncated === true,
  };
}
