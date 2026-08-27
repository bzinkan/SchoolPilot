import { TILE_BATCH_QUERY_ROOTS, removeStudentsFromTileBatchData } from './tileBatchPolling.js';

export function tileBatchFailureScope(error) {
  const status = Number(error?.response?.status);
  if (status === 401 || status === 403) return 'global';
  if (status === 404) return 'cohort';
  return 'transient';
}

export function purgeStudentTileCaches(queryClient, studentIds) {
  const ids = studentIds instanceof Set ? studentIds : new Set(studentIds || []);
  if (ids.size === 0) return Promise.resolve();
  const scrub = () => {
    queryClient.setQueriesData(
      { queryKey: [TILE_BATCH_QUERY_ROOTS.screenshots], exact: false },
      (data) => removeStudentsFromTileBatchData(data, ids),
    );
    queryClient.setQueriesData(
      { queryKey: [TILE_BATCH_QUERY_ROOTS.history], exact: false },
      (data) => removeStudentsFromTileBatchData(data, ids),
    );
  };
  const cancellations = [
    queryClient.cancelQueries({ queryKey: [TILE_BATCH_QUERY_ROOTS.screenshots], exact: false }),
    queryClient.cancelQueries({ queryKey: [TILE_BATCH_QUERY_ROOTS.history], exact: false }),
  ];
  scrub();
  return Promise.allSettled(cancellations).then(scrub);
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
  await queryClient.cancelQueries(query);
  queryClient.removeQueries(query);
}
