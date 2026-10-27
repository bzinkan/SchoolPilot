import { activityAuthority, activityRequestHeaders } from './dashboardActivity.js';
import { TILE_BATCH_MAX_STUDENTS } from './tileBatchPolling.js';

export const DESKTOP_TILES_PATH = '/classpilot/native/tiles/desktop';
export const DESKTOP_LEASE_PATH = '/classpilot/native/observation-leases';
export const DESKTOP_MAX_LEASE_MS = 45_000;
export const DESKTOP_POLL_MS = 5_000;
export const DESKTOP_RENEW_MS = 15_000;

export function desktopSourceKey(source) {
  return typeof source?.sourceRef === 'string' && source.sourceRef
    && Number.isSafeInteger(source.bindingRevision) && source.bindingRevision > 0
    ? JSON.stringify([source.sourceRef, source.bindingRevision]) : '';
}

export function hasBrowserSource(student) {
  return Boolean(student?.extensionVersion || student?.realtimeBinding || student?.isLoggedIn === true);
}

export function desktopTarget(studentId, source) {
  return desktopSourceKey(source) ? { studentId, sourceRef: source.sourceRef, bindingRevision: source.bindingRevision } : null;
}

// Convert server expiry to a local monotonic deadline, subtracting the whole
// request duration conservatively. A workstation clock change cannot extend it.
export function desktopDeadline(expiresAt, serverTime, startedAt, receivedAt) {
  const remaining = Date.parse(expiresAt) - Date.parse(serverTime);
  if (!Number.isFinite(remaining) || !Number.isFinite(startedAt) || !Number.isFinite(receivedAt)) return receivedAt;
  return receivedAt + Math.max(0, Math.min(DESKTOP_MAX_LEASE_MS, remaining) - Math.max(0, receivedAt - startedAt));
}

export function selectedDesktopRow(response, target) {
  if (response?.enabled !== true || !Array.isArray(response.tiles)) return null;
  return response.tiles.find(row => row.studentId === target.studentId
    && row.sourceRef === target.sourceRef && row.bindingRevision === target.bindingRevision) || null;
}

export function desktopContextKey(schoolId, viewerId, authority, revision) {
  return JSON.stringify([schoolId, viewerId, activityAuthority(authority), revision ?? null]);
}

export function createDesktopMetadataRequests(students, { schoolId, viewerId, authority, contextAuthorityRevision, claimedContexts } = {}) {
  if (!schoolId || !viewerId) return [];
  const groups = new Map();
  for (const student of students || []) {
    if (!student?.studentId) continue;
    const contextId = student.contextId || student.supervisionContext?.id;
    const claimed = claimedContexts?.get(contextId);
    const currentAuthority = claimedContexts ? (claimed ? { supervisionContextId: contextId } : null) : activityAuthority(authority);
    if (!currentAuthority) continue;
    const revision = claimedContexts ? claimed.contextAuthorityRevision : contextAuthorityRevision;
    const contextKey = desktopContextKey(schoolId, viewerId, currentAuthority, revision);
    if (!groups.has(contextKey)) groups.set(contextKey, { contextKey, authority: currentAuthority, revision, studentIds: new Set() });
    groups.get(contextKey).studentIds.add(student.studentId);
  }
  return [...groups.values()].flatMap(group => {
    const ids = [...group.studentIds].sort();
    const requests = [];
    for (let index = 0; index < ids.length; index += TILE_BATCH_MAX_STUDENTS) {
      const studentIds = ids.slice(index, index + TILE_BATCH_MAX_STUDENTS);
      requests.push({
        contextKey: group.contextKey,
        authority: group.authority,
        headers: activityRequestHeaders(schoolId, group.revision),
        body: { studentIds, ...group.authority },
        queryKey: ['classpilot-native-desktop-metadata', group.contextKey, studentIds],
      });
    }
    return requests;
  });
}

export function desktopStateLabel(state) {
  return ({ available: 'Desktop available', waiting: 'Waiting for a desktop thumbnail',
    pending: 'Authorizing desktop preview', stale: 'Desktop observation expired', offline: 'Desktop offline',
    policy_paused: 'Desktop paused by school policy', permission_required: 'Screen permission required',
    session_locked: 'Student session locked', locked: 'Student session locked', unbound: 'Desktop sign-in required',
    paused: 'Desktop preview paused', unavailable: 'Desktop preview unavailable', unsupported: 'Desktop capture unsupported',
  })[state] || 'Desktop preview unavailable';
}
