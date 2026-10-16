const DEFAULT_SESSION_COOKIE_NAME = 'schoolpilot.sid';
const KNOWN_SESSION_COOKIE_NAMES = ['schoolpilot.sid', 'schoolpilot.staging.sid'];

export function loadSessionCookieName(env = process.env) {
  const name = env.LOAD_SESSION_COOKIE_NAME || env.COOKIE_NAME || DEFAULT_SESSION_COOKIE_NAME;
  if (!/^[A-Za-z0-9_.-]{1,128}$/.test(name)) {
    throw new Error('LOAD_SESSION_COOKIE_NAME must be a valid cookie name of at most 128 characters');
  }
  if (env.APP_ENV === 'staging' && name === DEFAULT_SESSION_COOKIE_NAME) {
    throw new Error('Staging load sessions require a distinct session cookie name');
  }
  return name;
}

export function hasLoadSessionCookie(header, name = loadSessionCookieName()) {
  if (typeof header !== 'string' || /[\r\n]/.test(header)) return false;
  const pairs = header.split(';').map(value => value.trim()).filter(Boolean);
  const expected = pairs.filter(pair => pair.startsWith(`${name}=`));
  if (expected.length !== 1 || !new RegExp(`^${escapeRegex(name)}=[^\\s,;]+$`).test(expected[0])) return false;
  return !pairs.some(pair => KNOWN_SESSION_COOKIE_NAMES.some(other => other !== name && pair.startsWith(`${other}=`)));
}

function escapeRegex(name) { return name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

export function loadSessionCookieFromHeaders(headers, name = loadSessionCookieName()) {
  const values = typeof headers.getSetCookie === 'function'
    ? headers.getSetCookie() : [headers.get('set-cookie')].filter(Boolean);
  const matches = values.flatMap(value => [...String(value).matchAll(
    new RegExp(`(?:^|,\\s*)(${escapeRegex(name)}=[^;\\s,]+)(?=;|,|$)`, 'g'),
  )].map(match => match[1]));
  if (matches.length !== 1) throw new Error('Login response did not issue exactly one expected SchoolPilot session cookie');
  return matches[0];
}
