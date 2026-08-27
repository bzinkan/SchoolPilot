import { deriveScreenshotDisplay } from './studentMonitoringDisplay.js';

export const TILE_BATCH_MAX_STUDENTS = 50;
export const TILE_BATCH_HISTORY_LIMIT = 10;
export const TILE_BATCH_REFETCH_INTERVAL_MS = 30_000;

export const TILE_BATCH_QUERY_ROOTS = Object.freeze({
  screenshots: '/api/classpilot/tiles/screenshots',
  history: '/api/classpilot/tiles/history',
});

const TILE_BATCH_ENDPOINTS = Object.freeze({
  screenshots: '/classpilot/tiles/screenshots',
  history: '/classpilot/tiles/history',
});

export function buildTileStudentIds(students) {
  const studentIds = new Set();

  for (const student of students || []) {
    const studentId = typeof student === 'string' ? student : student?.studentId;
    if (typeof studentId === 'string' && studentId.length > 0) {
      studentIds.add(studentId);
    }
  }

  return Array.from(studentIds)
    .sort((left, right) => left.localeCompare(right));
}

function normalizedContextValue(value, fallback) {
  const normalized = typeof value === 'string' ? value.trim() : '';
  return normalized || fallback;
}

export function buildTileStudentBindings(students) {
  const bindingsByStudent = new Map();
  for (const student of students || []) {
    const studentId = typeof student === 'string' ? student : student?.studentId;
    if (typeof studentId !== 'string' || studentId.length === 0) continue;
    const binding = typeof student === 'object' && typeof student?.realtimeBinding === 'string'
      ? student.realtimeBinding.trim()
      : '';
    bindingsByStudent.set(studentId, binding);
  }
  return [...bindingsByStudent.entries()]
    .sort(([left], [right]) => left.localeCompare(right));
}

export function createTileBatchRequests(students, context = {}) {
  const normalizedStudentBindings = buildTileStudentBindings(students);
  const contextKey = JSON.stringify({
    schoolId: normalizedContextValue(context.schoolId, 'no-school'),
    viewerId: normalizedContextValue(context.viewerId, 'no-viewer'),
    authority: normalizedContextValue(context.authority, 'no-authority'),
    teachingSessionId: normalizedContextValue(context.teachingSessionId, 'no-session'),
  });
  const requests = [];

  for (let index = 0; index < normalizedStudentBindings.length; index += TILE_BATCH_MAX_STUDENTS) {
    const cohortBindings = normalizedStudentBindings.slice(index, index + TILE_BATCH_MAX_STUDENTS);
    const cohort = cohortBindings.map(([studentId]) => studentId);
    const cohortKey = JSON.stringify(cohortBindings);
    const teachingSessionId = typeof context.teachingSessionId === 'string'
      && context.teachingSessionId.trim()
      ? context.teachingSessionId.trim()
      : null;
    const sessionBody = teachingSessionId ? { teachingSessionId } : {};
    requests.push(
      {
        kind: 'screenshots',
        endpoint: TILE_BATCH_ENDPOINTS.screenshots,
        queryKey: [TILE_BATCH_QUERY_ROOTS.screenshots, contextKey, cohortKey],
        body: { studentIds: cohort, ...sessionBody },
        refetchInterval: TILE_BATCH_REFETCH_INTERVAL_MS,
      },
      {
        kind: 'history',
        endpoint: TILE_BATCH_ENDPOINTS.history,
        queryKey: [TILE_BATCH_QUERY_ROOTS.history, contextKey, cohortKey],
        body: { studentIds: cohort, limit: TILE_BATCH_HISTORY_LIMIT, ...sessionBody },
        refetchInterval: TILE_BATCH_REFETCH_INTERVAL_MS,
      }
    );
  }

  return requests;
}

export function indexTileScreenshots(response) {
  const screenshotsByStudent = new Map();

  for (const tile of response?.tiles || []) {
    if (typeof tile?.studentId !== 'string') continue;
    screenshotsByStudent.set(tile.studentId, tile.screenshot ?? null);
  }

  return screenshotsByStudent;
}

export function indexTileHistory(response) {
  const historyByStudent = new Map();

  for (const tile of response?.tiles || []) {
    if (typeof tile?.studentId !== 'string') continue;
    historyByStudent.set(tile.studentId, Array.isArray(tile.heartbeats) ? tile.heartbeats : []);
  }

  return historyByStudent;
}

export function retainFreshTileScreenshotsOnNull(previous, incoming, nowMs = Date.now()) {
  if (!Array.isArray(previous?.tiles) || !Array.isArray(incoming?.tiles)) return incoming;
  const previousByStudent = new Map(
    previous.tiles
      .filter((tile) => typeof tile?.studentId === 'string')
      .map((tile) => [tile.studentId, tile.screenshot]),
  );
  let changed = false;
  const tiles = incoming.tiles.map((tile) => {
    if (typeof tile?.studentId !== 'string' || tile.screenshot != null) return tile;
    const priorScreenshot = previousByStudent.get(tile.studentId);
    if (!deriveScreenshotDisplay(priorScreenshot, nowMs).fresh) return tile;
    changed = true;
    return { ...tile, screenshot: priorScreenshot };
  });
  return changed ? { ...incoming, tiles } : incoming;
}

export function removeStudentsFromTileBatchData(data, studentIds) {
  const deniedIds = studentIds instanceof Set ? studentIds : new Set(studentIds || []);
  if (deniedIds.size === 0 || data == null) return data;

  if (data instanceof Map) {
    let changed = false;
    const next = new Map(data);
    for (const studentId of deniedIds) {
      if (next.delete(studentId)) changed = true;
    }
    return changed ? next : data;
  }

  if (!Array.isArray(data?.tiles)) return data;
  const tiles = data.tiles.filter((tile) => !deniedIds.has(tile?.studentId));
  return tiles.length === data.tiles.length ? data : { ...data, tiles };
}

export function fetchTileBatch(request, requestApi, signal) {
  return requestApi('POST', request.endpoint, request.body, { signal });
}
