import { useCallback, useLayoutEffect, useRef } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { apiRequest, queryClient } from '../../../lib/queryClient';
import { activityAuthorityQuery, activityRequestHeaders } from '../lib/dashboardActivity';

export function useClassTools({ schoolId, viewerId, authority, authorityRevision, scopeKey, enabled, onError }) {
  const currentScope = useRef(scopeKey);
  useLayoutEffect(() => {
    currentScope.current = scopeKey;
    return () => {
      const queryKey = ['/api/class-tools/state', schoolId, viewerId, scopeKey];
      void queryClient.cancelQueries({ queryKey, exact: true });
      queryClient.removeQueries({ queryKey, exact: true });
    };
  }, [schoolId, viewerId, scopeKey]);
  const rollout = useQuery({ queryKey: ['/api/class-tools/rollout', schoolId, viewerId], enabled: Boolean(enabled && schoolId && viewerId),
    queryFn: async ({ signal }) => apiRequest('GET', '/classpilot/class-tools/rollout', undefined, { signal, headers: activityRequestHeaders(schoolId) }), retry: false, staleTime: 60_000, refetchInterval: 60_000 });
  const configuredPhase = rollout.error ? 0 : rollout.data?.phase ?? 0;
  const queryKey = ['/api/class-tools/state', schoolId, viewerId, scopeKey];
  const state = useQuery({ queryKey, enabled: Boolean(enabled && configuredPhase >= 2 && authority), refetchInterval: 15000,
    queryFn: async ({ signal }) => apiRequest('GET', `/classpilot/class-tools/state?${activityAuthorityQuery(authority)}`, undefined,
      { signal, headers: activityRequestHeaders(schoolId, authorityRevision) }), retry: false, gcTime: 0 });
  const phase = Math.min(configuredPhase, state.data?.phase ?? configuredPhase);
  const refresh = useCallback(() => queryClient.invalidateQueries({ queryKey: ['/api/class-tools/state', schoolId, viewerId, scopeKey] }), [schoolId, viewerId, scopeKey]);
  const mutation = useMutation({ mutationFn: async ({ path, data, method = 'POST' }) => {
    const key = scopeKey;
    const response = await apiRequest(method, `/classpilot/class-tools/${path}`, { ...authority, data }, { headers: activityRequestHeaders(schoolId, authorityRevision) });
    if (currentScope.current !== key) throw new Error('Classroom changed. The action remains recorded in its original classroom.');
    return response;
  }, onSuccess: refresh, onError });
  const read = async path => {
    const response = await apiRequest('GET', `/classpilot/class-tools/${path}${path.includes('?') ? '&' : '?'}${activityAuthorityQuery(authority)}`, undefined, { headers: activityRequestHeaders(schoolId, authorityRevision) });
    if (currentScope.current !== scopeKey) throw new Error('Classroom changed. Reopen this tool.');
    return response;
  };
  return { phase, data: enabled && phase >= 2 && !state.error ? state.data : undefined, loading: state.isPending && phase >= 2, error: state.error, refresh, read, pending: mutation.isPending, mutate: mutation.mutateAsync };
}
