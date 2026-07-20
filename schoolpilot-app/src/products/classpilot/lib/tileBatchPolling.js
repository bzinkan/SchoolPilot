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

export function createTileBatchRequests(studentIds) {
  const normalizedStudentIds = buildTileStudentIds(studentIds);
  const requests = [];

  for (let index = 0; index < normalizedStudentIds.length; index += TILE_BATCH_MAX_STUDENTS) {
    const cohort = normalizedStudentIds.slice(index, index + TILE_BATCH_MAX_STUDENTS);
    const cohortKey = JSON.stringify(cohort);
    requests.push(
      {
        kind: 'screenshots',
        endpoint: TILE_BATCH_ENDPOINTS.screenshots,
        queryKey: [TILE_BATCH_QUERY_ROOTS.screenshots, cohortKey],
        body: { studentIds: cohort },
        refetchInterval: TILE_BATCH_REFETCH_INTERVAL_MS,
      },
      {
        kind: 'history',
        endpoint: TILE_BATCH_ENDPOINTS.history,
        queryKey: [TILE_BATCH_QUERY_ROOTS.history, cohortKey],
        body: { studentIds: cohort, limit: TILE_BATCH_HISTORY_LIMIT },
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

function isMissingBatchEndpoint(error) {
  return error?.response?.status === 404 &&
    error?.response?.data?.error === 'Not found';
}

function isMissingLegacyTile(error) {
  return error?.response?.status === 404;
}

/**
 * The normal path is always one cohort request. The legacy fan-out exists only
 * as a cross-tier rollback bridge: if an automatic backend rollback lands on a
 * release that predates the batch routes, its global JSON 404 is exactly
 * `{ error: "Not found" }`. Authorization 404s from the batch implementation
 * use a different generic response and must remain an empty cohort so settled
 * grants cannot linger in React Query.
 */
export async function fetchTileBatchWithRollbackFallback(
  request,
  legacyDeviceByStudent,
  requestApi
) {
  try {
    return await requestApi('POST', request.endpoint, request.body);
  } catch (error) {
    if (error?.response?.status === 404 && !isMissingBatchEndpoint(error)) {
      return { tiles: [] };
    }
    if (!isMissingBatchEndpoint(error)) throw error;
  }

  const tiles = await Promise.all(request.body.studentIds.map(async (studentId) => {
    const deviceId = legacyDeviceByStudent.get(studentId);
    if (!deviceId) {
      return request.kind === 'screenshots'
        ? { studentId, screenshot: null }
        : { studentId, heartbeats: [] };
    }
    try {
      if (request.kind === 'screenshots') {
        const screenshot = await requestApi(
          'GET',
          `/device/screenshot/${encodeURIComponent(deviceId)}`
        );
        return { studentId, screenshot };
      }
      const response = await requestApi(
        'GET',
        `/heartbeats/${encodeURIComponent(deviceId)}?limit=${TILE_BATCH_HISTORY_LIMIT}`
      );
      return {
        studentId,
        heartbeats: Array.isArray(response) ? response : response?.heartbeats ?? [],
      };
    } catch (error) {
      if (!isMissingLegacyTile(error)) throw error;
      return request.kind === 'screenshots'
        ? { studentId, screenshot: null }
        : { studentId, heartbeats: [] };
    }
  }));

  return { tiles };
}
