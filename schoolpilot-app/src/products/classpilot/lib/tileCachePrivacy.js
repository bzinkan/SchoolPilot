import {
  TILE_BATCH_QUERY_ROOTS,
  removeLegacyScreenshotsFromTileBatchData,
  removeStudentsFromTileBatchData,
} from './tileBatchPolling.js';

export function tileBatchFailureScope(error) {
  const status = Number(error?.response?.status);
  if (status === 401 || status === 403) return 'global';
  if (status === 404) return 'cohort';
  return 'transient';
}

export function purgeStudentTileCaches(queryClient, studentIds) {
  return Promise.allSettled([
    purgeStudentScreenshotTileCaches(queryClient, studentIds),
    purgeStudentHistoryTileCaches(queryClient, studentIds),
  ]);
}

export function scrubStudentTileCaches(queryClient, studentIds) {
  const ids = studentIds instanceof Set ? studentIds : new Set(studentIds || []);
  if (ids.size === 0) return;
  queryClient.setQueriesData(
    { queryKey: [TILE_BATCH_QUERY_ROOTS.screenshots], exact: false },
    (data) => removeStudentsFromTileBatchData(data, ids),
  );
  queryClient.setQueriesData(
    { queryKey: [TILE_BATCH_QUERY_ROOTS.history], exact: false },
    (data) => removeStudentsFromTileBatchData(data, ids),
  );
}

export async function reconcileStudentTileBindingCaches(queryClient, studentIds) {
  const ids = studentIds instanceof Set ? studentIds : new Set(studentIds || []);
  if (ids.size === 0) return;
  const screenshotQuery = {
    queryKey: [TILE_BATCH_QUERY_ROOTS.screenshots],
    exact: false,
  };
  const historyQuery = {
    queryKey: [TILE_BATCH_QUERY_ROOTS.history],
    exact: false,
  };
  await Promise.allSettled([
    queryClient.cancelQueries(screenshotQuery),
    queryClient.cancelQueries(historyQuery),
  ]);
  // Cancellation fences the former request; scrub once more before asking the
  // active, same-key observer to fetch under the replacement binding.
  scrubStudentTileCaches(queryClient, ids);
  await Promise.allSettled([
    queryClient.refetchQueries({ ...screenshotQuery, type: 'active' }),
    queryClient.refetchQueries({ ...historyQuery, type: 'active' }),
  ]);
}

async function purgeStudentsFromTileCacheRoot(queryClient, queryRoot, studentIds) {
  const ids = studentIds instanceof Set ? studentIds : new Set(studentIds || []);
  if (ids.size === 0) return;
  const scrub = () => {
    queryClient.setQueriesData(
      { queryKey: [queryRoot], exact: false },
      (data) => removeStudentsFromTileBatchData(data, ids),
    );
  };
  scrub();
  const query = { queryKey: [queryRoot], exact: false };
  await Promise.allSettled([queryClient.cancelQueries(query)]);
  scrub();
  await Promise.allSettled([
    queryClient.refetchQueries({ ...query, type: 'active' }),
  ]);
  scrub();
}

export function purgeStudentScreenshotTileCaches(queryClient, studentIds) {
  return purgeStudentsFromTileCacheRoot(
    queryClient,
    TILE_BATCH_QUERY_ROOTS.screenshots,
    studentIds,
  );
}

export function purgeStudentHistoryTileCaches(queryClient, studentIds) {
  return purgeStudentsFromTileCacheRoot(
    queryClient,
    TILE_BATCH_QUERY_ROOTS.history,
    studentIds,
  );
}

export async function purgeLegacyScreenshotTileCaches(queryClient) {
  const query = { queryKey: [TILE_BATCH_QUERY_ROOTS.screenshots], exact: false };
  const scrub = () => {
    queryClient.setQueriesData(query, removeLegacyScreenshotsFromTileBatchData);
  };
  scrub();
  await Promise.allSettled([queryClient.cancelQueries(query)]);
  scrub();
  await Promise.allSettled([
    queryClient.refetchQueries({ ...query, type: 'active' }),
  ]);
  scrub();
}

export async function purgeAllStudentTileCaches(queryClient) {
  await Promise.allSettled([
    queryClient.cancelQueries({ queryKey: [TILE_BATCH_QUERY_ROOTS.screenshots], exact: false }),
    queryClient.cancelQueries({ queryKey: [TILE_BATCH_QUERY_ROOTS.history], exact: false }),
  ]);
  queryClient.removeQueries({ queryKey: [TILE_BATCH_QUERY_ROOTS.screenshots], exact: false });
  queryClient.removeQueries({ queryKey: [TILE_BATCH_QUERY_ROOTS.history], exact: false });
}

export async function purgeAllScreenshotTileCaches(queryClient) {
  const query = { queryKey: [TILE_BATCH_QUERY_ROOTS.screenshots], exact: false };
  await Promise.allSettled([queryClient.cancelQueries(query)]);
  queryClient.removeQueries(query);
}
