import { useMemo } from 'react';
import { useQueries, useQueryClient } from '@tanstack/react-query';
import { apiRequest } from '../../../lib/queryClient';
import { createDesktopMetadataRequests, DESKTOP_TILES_PATH } from '../lib/nativeDesktop';

export function useDesktopMetadata({ enabled, students, schoolId, viewerId, authority, contextAuthorityRevision, claimedContexts }) {
  const queryClient = useQueryClient();
  const requests = useMemo(() => enabled ? createDesktopMetadataRequests(students, {
    schoolId, viewerId, authority, contextAuthorityRevision, claimedContexts,
  }) : [], [enabled, students, schoolId, viewerId, authority, contextAuthorityRevision, claimedContexts]);
  const queries = useQueries({ queries: requests.map(request => ({
    queryKey: request.queryKey,
    queryFn: async ({ signal }) => {
      const response = await apiRequest('POST', DESKTOP_TILES_PATH, request.body, { signal, headers: request.headers });
      const previous = queryClient.getQueryData(request.queryKey);
      if (response?.enabled !== true) return { enabled: false, wasEnabled: previous?.enabled || previous?.wasEnabled || false,
        tiles: (previous?.tiles || []).map(({ studentId }) => ({ studentId, state: 'unavailable' })) };
      // Keep this query cache content-free even if a malformed response sends
      // an unsolicited image or application observation.
      const tiles = (response?.tiles || []).map(row => {
        const { studentId, state, sourceRef, bindingRevision, sourceLabel, platform } = row;
        return { studentId, state, sourceRef, bindingRevision, sourceLabel, platform };
      });
      const returnedIds = new Set(tiles.map(row => row.studentId));
      for (const row of previous?.tiles || []) {
        if (request.body.studentIds.includes(row.studentId) && !returnedIds.has(row.studentId)) {
          tiles.push({ studentId: row.studentId, state: 'unavailable' });
        }
      }
      return { enabled: true, tiles };
    },
    refetchInterval: query => query.state.data?.enabled === false
      || [401, 403, 404, 409].includes(query.state.error?.response?.status) ? false : 15_000,
    refetchIntervalInBackground: false,
    retry: false,
    gcTime: 0,
  })) });
  const result = new Map();
  requests.forEach((request, index) => {
    const query = queries[index];
    if (query.data?.enabled !== true && !query.data?.wasEnabled) return;
    const ids = new Set(request.body.studentIds);
    for (const row of query.data.tiles || []) {
      if (!ids.has(row.studentId)) continue;
      // Metadata never carries pixels or application content into React Query.
      const { studentId, state, sourceRef, bindingRevision, sourceLabel, platform } = row;
      result.set(studentId, { source: { studentId, state: query.isError ? 'unavailable' : state, sourceRef, bindingRevision, sourceLabel, platform },
        contextKey: request.contextKey, authority: request.authority, headers: request.headers });
    }
  });
  return result;
}
