const CANDIDATE = /(?:https?:\/\/|www\.)[^\s<>"]+/gi;
const OPENING_PUNCTUATION = new Set(['(', '[', '{', '<', '"', "'", '“', '‘']);
const CLOSING_PAIRS = [[')', '('], [']', '['], ['}', '{']];
const QUOTATION_ENDINGS = new Map([["'", "'"], ['“', '”'], ['‘', '’']]);

function withoutTrailingProse(value, before) {
  let end = value.length;
  const pair = CLOSING_PAIRS.find(([, open]) => open === before);
  const closing = QUOTATION_ENDINGS.get(before) || pair?.[0];
  if (closing) {
    const at = value.lastIndexOf(closing);
    const isOutsideUrl = !pair || value.split(closing).length > value.split(before).length;
    if (at >= 0 && isOutsideUrl && /^[.,!?;:)\]}]*$/.test(value.slice(at + 1))) end = at;
  }
  const candidate = value.slice(0, end);
  // A final !, ? or . may be URL data (e.g. a factorial math query).
  // Only an explicit enclosing quote/bracket can disambiguate prose here.
  if (candidate.includes('?') || candidate.includes('#')) return candidate;
  const excess = Object.fromEntries(CLOSING_PAIRS.map(([close, open]) => (
    [close, candidate.split(close).length - candidate.split(open).length]
  )));
  while (end > 0) {
    const last = value[end - 1];
    if (/[.,!?;:]/.test(last)) { end--; continue; }
    if (excess[last] > 0) { excess[last]--; end--; continue; }
    break;
  }
  return value.slice(0, end);
}

function hasControlCharacters(value) {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

// Messages remain plain text. These segments only decorate explicit web links;
// they never grant permissions, fetch destinations or interpret message HTML.
export function splitMessageLinks(value) {
  if (typeof value !== 'string' || !value) return [];
  const parts = [];
  let cursor = 0;
  for (const match of value.matchAll(CANDIDATE)) {
    const before = value[match.index - 1];
    if (before && !/\s/.test(before) && !OPENING_PUNCTUATION.has(before)) continue;
    const text = withoutTrailingProse(match[0], before);
    if (hasControlCharacters(text)) continue;
    let url;
    try { url = new URL(/^www\./i.test(text) ? `https://${text}` : text); }
    catch { continue; }
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password) continue;
    if (match.index > cursor) parts.push({ text: value.slice(cursor, match.index), href: null });
    parts.push({ text, href: url.href });
    cursor = match.index + text.length;
  }
  if (cursor < value.length) parts.push({ text: value.slice(cursor), href: null });
  return parts;
}
