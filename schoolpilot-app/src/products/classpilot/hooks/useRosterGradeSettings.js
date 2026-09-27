import { useLayoutEffect, useRef } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { apiRequest, queryClient } from '../../../lib/queryClient';

export function useRosterGradeSettings({ schoolId, viewerId, enabled, canWrite, onSaved, onError }) {
  const scope = `${schoolId}:${viewerId}`;
  const generation = useRef(null), inFlight = useRef(false);
  useLayoutEffect(() => {
    const token = { scope, canWrite: Boolean(canWrite), enabled: Boolean(enabled) };
    generation.current = token; inFlight.current = false;
    return () => { generation.current = null; };
  }, [scope, canWrite, enabled]);
  const queryKey = ['/api/classpilot/admin/settings', schoolId, viewerId, 'rosterGrades'];
  const query = useQuery({ queryKey, enabled: Boolean(enabled && canWrite && schoolId && viewerId), retry: false,
    queryFn: async ({ signal }) => (await apiRequest('GET', '/classpilot/admin/settings', undefined,
      { signal, headers: { 'X-School-Id': schoolId } })).sections.rosterGrades });
  const save = useMutation({ mutationFn: ({ gradeLevels, version, school, token }) => {
    if (!version || generation.current !== token || !token.canWrite || !token.enabled) throw new Error('Load the current grade list before saving.');
    return apiRequest('PATCH', '/classpilot/admin/settings/rosterGrades', { expectedVersion: version, gradeLevels }, { headers: { 'X-School-Id': school } });
  }, onSuccess: (data, variables) => {
    if (generation.current !== variables.token) return;
    queryClient.setQueryData(queryKey, { version: data.version, gradeLevels: data.gradeLevels });
    queryClient.invalidateQueries({ queryKey: ['/api/settings'] });
    queryClient.invalidateQueries({ queryKey: ['/api/classpilot/admin/settings'], exact: false, predicate: query => query.queryKey.at(-1) !== 'rosterGrades' });
    onSaved?.();
  }, onError: (error, variables) => {
    if (generation.current !== variables.token) return;
    if (error?.response?.status === 409 && error.response.data?.current) {
      queryClient.setQueryData(queryKey, error.response.data.current);
      onError?.('The grade list changed elsewhere. Review the current grades and try again.');
    } else onError?.('The grade list could not be saved. Try again.');
  }, onSettled: (_data, _error, variables) => { if (generation.current === variables.token) inFlight.current = false; } });
  return { query, mutation: { ...save, mutate: gradeLevels => {
    const token = generation.current;
    if (!token?.canWrite || !token.enabled || !query.data?.version || query.isFetching || inFlight.current) return;
    inFlight.current = true;
    save.mutate({ gradeLevels, version: query.data.version, school: schoolId, token });
  } } };

}
