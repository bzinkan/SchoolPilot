import { useQuery } from '@tanstack/react-query';
import { automaticFlightPathSessionKey } from '../lib/automaticFlightPath';

export function useAutomaticFlightPathSession({ sessionId, schoolId, viewerId, authorityRevision, enabled, request }) {
  return useQuery({
    queryKey: automaticFlightPathSessionKey(sessionId, schoolId, viewerId, authorityRevision),
    queryFn: ({ signal }) => request('GET', `/classpilot/teaching-sessions/${encodeURIComponent(sessionId)}/automatic-flight-path`, undefined, { signal }),
    enabled: Boolean(enabled && sessionId && schoolId && viewerId),
    retry: false,
    refetchInterval: query => query.state.data?.automaticFlightPath?.status === 'inactive' ? false : 5000,
    refetchOnReconnect: true,
    refetchOnWindowFocus: true,
  });
}
