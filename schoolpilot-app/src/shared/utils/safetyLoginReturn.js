const SAFETY_PATH = '/classpilot/admin/safety';
export const SAFETY_LOGIN_RETURN_KEY = 'sp_safety_login_return_v1';
export const SAFETY_LOGIN_RETURN_TTL_MS = 30 * 60 * 1000;

/** Only Safety Center destinations are resumable; this is never a general redirect URL. */
export function normalizeSafetyLoginReturn(value) {
  if (typeof value !== 'string' || value.length > 1024 || value.includes('\\') || [...value].some(character => character.charCodeAt(0) <= 32 || character.charCodeAt(0) === 127)) return null;
  if (value !== SAFETY_PATH && !value.startsWith(`${SAFETY_PATH}?`)) return null;
  try {
    const url = new URL(value, 'https://school-pilot.net');
    if (url.pathname !== SAFETY_PATH || url.hash) return null;
    if ([...url.searchParams.keys()].some(key => key !== 'case') || url.searchParams.getAll('case').length > 1) return null;
    const caseId = url.searchParams.get('case');
    if (caseId === null) return SAFETY_PATH;
    // New case IDs are UUIDs; safe legacy text IDs remain supported too.
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(caseId)) return null;
    return `${SAFETY_PATH}?case=${encodeURIComponent(caseId)}`;
  } catch { return null; }
}

function storageFor(options) {
  return options.storage ?? window.sessionStorage;
}

export function rememberSafetyLoginReturn(value, options = {}) {
  const path = normalizeSafetyLoginReturn(value);
  try {
    if (!path) {
      storageFor(options).removeItem(SAFETY_LOGIN_RETURN_KEY);
      return false;
    }
    storageFor(options).setItem(SAFETY_LOGIN_RETURN_KEY, JSON.stringify({ version: 1, path, createdAt: options.now ?? Date.now() }));
    return true;
  } catch { return false; }
}

export function consumeSafetyLoginReturn(options = {}) {
  try {
    const storage = storageFor(options);
    const raw = storage.getItem(SAFETY_LOGIN_RETURN_KEY);
    storage.removeItem(SAFETY_LOGIN_RETURN_KEY);
    if (!raw) return null;
    const value = JSON.parse(raw);
    const now = options.now ?? Date.now();
    if (value?.version !== 1 || !Number.isFinite(value.createdAt) || value.createdAt > now || now - value.createdAt >= SAFETY_LOGIN_RETURN_TTL_MS) return null;
    return normalizeSafetyLoginReturn(value.path);
  } catch { return null; }
}
