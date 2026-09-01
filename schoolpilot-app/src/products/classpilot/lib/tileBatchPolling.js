import {
  deriveScreenshotDisplay,
  isClassBoundScreenshot,
  SCREENSHOT_RECONNECT_RETAIN_MS,
  SCREENSHOT_STALE_MS,
  SCREENSHOT_SUCCESSFUL_NULL_RETAIN_UNTIL_FIELD,
} from './studentMonitoringDisplay.js';

export const TILE_BATCH_MAX_STUDENTS = 50;
export const TILE_BATCH_HISTORY_LIMIT = 10;
export const TILE_BATCH_REFETCH_INTERVAL_MS = 30_000;
export const TILE_SCREENSHOT_CACHE_GC_MS = SCREENSHOT_RECONNECT_RETAIN_MS;
const SCREENSHOT_BINDING_REJECTED = Symbol('classpilotScreenshotBindingRejected');

export const TILE_BATCH_QUERY_ROOTS = Object.freeze({
  screenshots: '/api/classpilot/tiles/screenshots',
  history: '/api/classpilot/tiles/history',
});

export async function runBoundedTileScreenshotJobs(items, maxConcurrency, worker) {
  if (!Array.isArray(items) || items.length === 0) return;
  let nextIndex = 0;
  const workers = Array.from(
    { length: Math.min(Math.max(1, maxConcurrency), items.length) },
    async () => {
      while (nextIndex < items.length) {
        const index = nextIndex;
        nextIndex += 1;
        await worker(items[index]);
      }
    },
  );
  await Promise.all(workers);
}

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

export function normalizedTileControlRevision(student) {
  const revision = Number(
    student?.classroomState?.revision ?? student?.classroomStateRevision,
  );
  return Number.isSafeInteger(revision) && revision >= 0 ? revision : 'unknown';
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
    bindingsByStudent.set(studentId, {
      binding,
      controlRevision: normalizedTileControlRevision(student),
    });
  }
  return [...bindingsByStudent.entries()]
    .map(([studentId, authority]) => [
      studentId,
      authority.binding,
      authority.controlRevision,
    ])
    .sort(([left], [right]) => left.localeCompare(right));
}

export function changedTileBindingStudentIds(previousStudents, nextStudents) {
  const authorityByStudent = (students) => new Map(
    buildTileStudentBindings(students).map(([studentId, binding, controlRevision]) => [
      studentId,
      JSON.stringify([binding, controlRevision]),
    ]),
  );
  const previousBindings = authorityByStudent(previousStudents);
  const nextBindings = authorityByStudent(nextStudents);
  const changedStudentIds = [];

  for (const [studentId, previousBinding] of previousBindings) {
    if (
      !nextBindings.has(studentId)
      || nextBindings.get(studentId) !== previousBinding
    ) {
      changedStudentIds.push(studentId);
    }
  }

  return changedStudentIds.sort((left, right) => left.localeCompare(right));
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
    // Screenshot pixels are authorization-sensitive, so their identity must
    // include every exact realtime binding. History contains no pixels and may
    // keep the stable student-ID cohort key.
    const screenshotCohortKey = JSON.stringify(cohortBindings);
    const historyCohortKey = JSON.stringify(cohort);
    const teachingSessionId = typeof context.teachingSessionId === 'string'
      && context.teachingSessionId.trim()
      ? context.teachingSessionId.trim()
      : null;
    const sessionBody = teachingSessionId ? { teachingSessionId } : {};
    requests.push(
      {
        kind: 'screenshots',
        endpoint: TILE_BATCH_ENDPOINTS.screenshots,
        queryKey: [TILE_BATCH_QUERY_ROOTS.screenshots, contextKey, screenshotCohortKey],
        body: { studentIds: cohort, ...sessionBody },
        refetchInterval: TILE_BATCH_REFETCH_INTERVAL_MS,
      },
      {
        kind: 'history',
        endpoint: TILE_BATCH_ENDPOINTS.history,
        queryKey: [TILE_BATCH_QUERY_ROOTS.history, contextKey, historyCohortKey],
        body: { studentIds: cohort, limit: TILE_BATCH_HISTORY_LIMIT, ...sessionBody },
        refetchInterval: TILE_BATCH_REFETCH_INTERVAL_MS,
      }
    );
  }

  return requests;
}

export function tileBatchRequestShouldPoll(
  request,
  {
    viewportTrackingSupported = false,
    nearViewportStudentIds = new Set(),
    priorityStudentId = null,
    liveViewStudentId = null,
  } = {},
) {
  if (!viewportTrackingSupported) return true;
  const nearby = nearViewportStudentIds instanceof Set
    ? nearViewportStudentIds
    : new Set(nearViewportStudentIds || []);
  return (request?.body?.studentIds || []).some((studentId) => (
    nearby.has(studentId) || studentId === priorityStudentId || studentId === liveViewStudentId
  ));
}

export function indexTileScreenshots(response) {
  const screenshotsByStudent = new Map();

  for (const tile of response?.tiles || []) {
    if (typeof tile?.studentId !== 'string') continue;
    screenshotsByStudent.set(tile.studentId, validatedTileScreenshot(tile));
  }

  return screenshotsByStudent;
}

function validatedTileScreenshot(tile) {
  const screenshot = tile?.screenshot ?? null;
  const expectedBindingVersion = typeof tile?.bindingVersion === 'string'
    ? tile.bindingVersion
    : null;
  const screenshotBindingVersion = typeof screenshot?.bindingVersion === 'string'
    ? screenshot.bindingVersion
    : null;
  const expectsV2 = expectedBindingVersion?.startsWith('v2:') === true;
  const screenshotClaimsV2 = screenshotBindingVersion?.startsWith('v2:') === true;
  if (expectsV2 || screenshotClaimsV2) {
    return expectsV2
      && screenshotClaimsV2
      && expectedBindingVersion === screenshotBindingVersion
      ? screenshot
      : null;
  }
  return screenshot;
}

export function normalizeTileScreenshotBindings(response) {
  if (!Array.isArray(response?.tiles)) return response;
  let changed = false;
  const tiles = response.tiles.map((tile) => {
    const screenshot = validatedTileScreenshot(tile);
    if (screenshot === (tile?.screenshot ?? null)) return tile;
    changed = true;
    return {
      ...tile,
      screenshot,
      // Preserve the distinction between a genuine server null and a pixel
      // rejected by the client-side exact-binding fence. The latter must
      // purge prior pixels and can never use the successful-null bridge.
      [SCREENSHOT_BINDING_REJECTED]: tile?.screenshot != null && screenshot == null,
    };
  });
  return changed ? { ...response, tiles } : response;
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
      .map((tile) => [tile.studentId, tile]),
  );
  let changed = false;
  const tiles = incoming.tiles.map((tile) => {
    if (typeof tile?.studentId !== 'string') return tile;
    const priorTile = previousByStudent.get(tile.studentId);
    const priorScreenshot = priorTile?.screenshot;
    const incomingScreenshot = tile.screenshot;
    if (tile[SCREENSHOT_BINDING_REJECTED] === true) return tile;
    if (incomingScreenshot != null) {
      const priorBindingVersion = priorScreenshot?.bindingVersion ?? priorTile?.bindingVersion;
      const incomingBindingVersion = incomingScreenshot?.bindingVersion ?? tile.bindingVersion;
      const priorObservedAt = screenshotObservedAtMs(priorScreenshot);
      const incomingObservedAt = screenshotObservedAtMs(incomingScreenshot);
      if (
        priorScreenshot
        && priorBindingVersion === incomingBindingVersion
        && priorObservedAt !== null
        && incomingObservedAt !== null
        && (
          incomingObservedAt < priorObservedAt
          || (
            incomingObservedAt === priorObservedAt
            && incomingScreenshot.screenshot === priorScreenshot.screenshot
          )
        )
      ) {
        // A slow 30-second reconciliation may resolve after a targeted
        // screenshot event. Never move an exact binding backwards or replace
        // an unchanged frame object.
        changed = true;
        return priorTile;
      }
      return tile;
    }
    const priorBindingVersion = typeof priorTile?.bindingVersion === 'string'
      ? priorTile.bindingVersion
      : priorScreenshot?.bindingVersion;
    const incomingBindingVersion = typeof tile.bindingVersion === 'string'
      ? tile.bindingVersion
      : null;
    const priorWasClassBound = typeof priorBindingVersion === 'string'
      && priorBindingVersion.startsWith('v2:');
    const incomingIsClassBound = typeof incomingBindingVersion === 'string'
      && incomingBindingVersion.startsWith('v2:');
    if (
      (priorWasClassBound || incomingIsClassBound)
      && !(
        priorWasClassBound
        && incomingIsClassBound
        && incomingBindingVersion === priorBindingVersion
      )
    ) return tile;
    // A successful null is authoritative: it may bridge only the normal
    // freshness window. Transport failures never invoke structural sharing,
    // so React Query can still retain the last exact-binding preview through
    // the separate 120-second reconnect window.
    const priorDisplay = deriveScreenshotDisplay(priorScreenshot, nowMs);
    if (!priorDisplay.fresh || priorDisplay.observedAtMs === null) return tile;
    const successfulNullRetainUntilMs = priorDisplay.observedAtMs + SCREENSHOT_STALE_MS;
    const retainedScreenshot = priorScreenshot?.[SCREENSHOT_SUCCESSFUL_NULL_RETAIN_UNTIL_FIELD]
      === successfulNullRetainUntilMs
      ? priorScreenshot
      : {
          ...priorScreenshot,
          [SCREENSHOT_SUCCESSFUL_NULL_RETAIN_UNTIL_FIELD]: successfulNullRetainUntilMs,
        };
    changed = true;
    return { ...tile, screenshot: retainedScreenshot };
  });
  return changed ? { ...incoming, tiles } : incoming;
}

function screenshotObservedAtMs(screenshot) {
  const value = screenshot?.capturedAt ?? screenshot?.timestamp;
  const parsed = typeof value === 'number' ? value : Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Merge a small, event-driven screenshot response into an existing fixed
 * cohort without replacing unchanged tile objects. The server remains the
 * authority: an omitted requested row is removed, a successful null follows
 * the normal 75-second bridge, and an older response cannot overwrite a newer
 * exact-binding screenshot.
 */
export function mergeTargetedTileScreenshotResponse(
  previous,
  incoming,
  requestedStudentIds,
  nowMs = Date.now(),
) {
  if (!Array.isArray(incoming?.tiles)) return previous;
  const requestedIds = requestedStudentIds instanceof Set
    ? requestedStudentIds
    : new Set(requestedStudentIds || []);
  if (requestedIds.size === 0) return previous;

  // A screenshot-available event may arrive before an offscreen cohort has
  // completed its first 30-second reconciliation. Seed that cohort only with
  // validated requested rows so the event is useful without manufacturing
  // null rows or weakening the exact-binding checks below.
  if (!Array.isArray(previous?.tiles)) {
    const normalizedIncoming = normalizeTileScreenshotBindings(incoming);
    return {
      ...normalizedIncoming,
      tiles: normalizedIncoming.tiles.filter((tile) => requestedIds.has(tile?.studentId)),
    };
  }

  const rawIncomingByStudent = new Map(
    incoming.tiles
      .filter((tile) => requestedIds.has(tile?.studentId))
      .map((tile) => [tile.studentId, tile]),
  );
  const normalizedIncoming = normalizeTileScreenshotBindings(incoming);
  const incomingByStudent = new Map(
    normalizedIncoming.tiles
      .filter((tile) => requestedIds.has(tile?.studentId))
      .map((tile) => [tile.studentId, tile]),
  );
  const previousByStudent = new Map(
    previous.tiles
      .filter((tile) => typeof tile?.studentId === 'string')
      .map((tile) => [tile.studentId, tile]),
  );
  const mergedTiles = [];
  let changed = false;

  for (const previousTile of previous.tiles) {
    const studentId = previousTile?.studentId;
    if (!requestedIds.has(studentId)) {
      mergedTiles.push(previousTile);
      continue;
    }

    const incomingTile = incomingByStudent.get(studentId);
    if (!incomingTile) {
      changed = true;
      continue;
    }

    const rawIncomingTile = rawIncomingByStudent.get(studentId);
    if (rawIncomingTile?.screenshot != null && incomingTile.screenshot == null) {
      // A V2 row whose pixel binding does not match its row binding is not a
      // successful null and must never receive the 75-second bridge.
      mergedTiles.push(incomingTile);
      changed = true;
      continue;
    }

    const previousScreenshot = previousTile?.screenshot;
    const incomingScreenshot = incomingTile?.screenshot;
    const previousBinding = previousScreenshot?.bindingVersion ?? previousTile?.bindingVersion;
    const incomingBinding = incomingScreenshot?.bindingVersion ?? incomingTile?.bindingVersion;
    const previousObservedAt = screenshotObservedAtMs(previousScreenshot);
    const incomingObservedAt = screenshotObservedAtMs(incomingScreenshot);
    if (
      previousScreenshot
      && incomingScreenshot
      && previousBinding === incomingBinding
      && previousObservedAt !== null
      && incomingObservedAt !== null
      && incomingObservedAt < previousObservedAt
    ) {
      mergedTiles.push(previousTile);
      continue;
    }

    const bridged = retainFreshTileScreenshotsOnNull(
      { tiles: [previousTile] },
      { tiles: [incomingTile] },
      nowMs,
    ).tiles[0];
    mergedTiles.push(bridged);
    if (bridged !== previousTile) changed = true;
  }

  for (const studentId of requestedIds) {
    if (previousByStudent.has(studentId)) continue;
    const incomingTile = incomingByStudent.get(studentId);
    if (!incomingTile) continue;
    mergedTiles.push(incomingTile);
    changed = true;
  }

  return changed ? { ...previous, tiles: mergedTiles } : previous;
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

export function removeLegacyScreenshotsFromTileBatchData(data) {
  if (data instanceof Map) {
    let changed = false;
    const next = new Map(data);
    for (const [studentId, screenshot] of next) {
      if (!isClassBoundScreenshot(screenshot)) {
        next.delete(studentId);
        changed = true;
      }
    }
    return changed ? next : data;
  }

  if (!Array.isArray(data?.tiles)) return data;
  const tiles = data.tiles.filter((tile) => (
    isClassBoundScreenshot(tile?.screenshot)
    || (typeof tile?.bindingVersion === 'string' && tile.bindingVersion.startsWith('v2:'))
  ));
  return tiles.length === data.tiles.length ? data : { ...data, tiles };
}

export async function fetchTileBatch(request, requestApi, signal) {
  const response = await requestApi('POST', request.endpoint, request.body, { signal });
  return request.kind === 'screenshots'
    ? normalizeTileScreenshotBindings(response)
    : response;
}
