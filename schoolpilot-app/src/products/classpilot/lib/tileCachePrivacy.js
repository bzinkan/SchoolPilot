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

export function purgeStudentTileCaches(queryClient, studentIds, options) {
  return Promise.allSettled([
    purgeStudentScreenshotTileCaches(queryClient, studentIds, options),
    purgeStudentHistoryTileCaches(queryClient, studentIds, options),
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

/**
 * Remove denied students from every cached cohort under `queryRoot`.
 *
 * `refetch` defaults to true because a binding reconcile purges in order to
 * repopulate the same active cohort under its replacement authority. A caller
 * that purges *because* the cohort was just denied must pass `refetch: false`:
 * the replayed request is denied again, while the scrub's success dispatch
 * clears the query error so the caller's denied-id dependency oscillates and
 * the purge fires again — an unthrottled request loop with no timer, backoff,
 * or dedupe (a zero-result cohort 404 produced 13,077 requests in 13 minutes
 * from a single dashboard on 2026-09-01, each one taking a global tile
 * admission permit, the full auth chain, and a tenant-scoped query). Denied
 * rows still need repopulating only after a genuine binding change, which is
 * reconcileStudentTileBindingCaches's job.
 */
async function purgeStudentsFromTileCacheRoot(
  queryClient,
  queryRoot,
  studentIds,
  { refetch = true } = {},
) {
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
  // Cancellation still fences an in-flight response that could otherwise
  // reinstate the denied rows after the scrub.
  await Promise.allSettled([queryClient.cancelQueries(query)]);
  scrub();
  if (!refetch) return;
  await Promise.allSettled([
    queryClient.refetchQueries({ ...query, type: 'active' }),
  ]);
  scrub();
}

export function purgeStudentScreenshotTileCaches(queryClient, studentIds, options) {
  return purgeStudentsFromTileCacheRoot(
    queryClient,
    TILE_BATCH_QUERY_ROOTS.screenshots,
    studentIds,
    options,
  );
}

export function purgeStudentHistoryTileCaches(queryClient, studentIds, options) {
  return purgeStudentsFromTileCacheRoot(
    queryClient,
    TILE_BATCH_QUERY_ROOTS.history,
    studentIds,
    options,
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
