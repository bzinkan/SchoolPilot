import { useEffect, useRef } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useClassPilotAuth } from '../../../hooks/useClassPilotAuth';
import { useLicenses } from '../../../contexts/LicenseContext';
import { useAuth } from '../../../contexts/AuthContext';
import { disciplineApi, disciplineKeys } from '../lib/discipline';

export function useDisciplineCapabilities(access) {
  const { schoolId, viewerId } = access;
  const cache = useQueryClient(), previousAccess = useRef(null);
  const query = useQuery({ queryKey: disciplineKeys.capabilities(schoolId, viewerId),
    queryFn: ({ signal }) => disciplineApi(schoolId, signal).capabilities(),
    enabled: Boolean(schoolId && viewerId && access.eligible !== false), retry: false,
    staleTime: 0, gcTime: 0, refetchOnWindowFocus: true });
  useEffect(() => {
    if (!query.data || query.isError) return;
    const policy = `${schoolId}:${viewerId}:${Boolean(query.data.canViewSchool)}`;
    if (previousAccess.current && previousAccess.current !== policy) {
      const root = disciplineKeys.root(schoolId, viewerId);
      const affected = { predicate: entry => root.every((part, index) => entry.queryKey[index] === part) && entry.queryKey[root.length] !== 'capabilities' };
      void cache.cancelQueries(affected).then(() => cache.resetQueries(affected));
    }
    previousAccess.current = policy;
  }, [cache, schoolId, viewerId, query.data, query.isError]);
  const status = query.error?.response?.status;
  return { ...query, usable: query.isSuccess || Boolean(query.data && query.isError && (!status || status === 429 || status >= 500)) };
}

export function useDisciplineAccess() {
  const { currentUser, school, isAdmin, isTeacher, isLoading } = useClassPilotAuth();
  const { hasClassPilot } = useLicenses();
  const { privateNotebookAuthReady } = useAuth();
  const access = { schoolId: school?.id, viewerId: currentUser?.id, school,
    eligible: Boolean(privateNotebookAuthReady && !isLoading && school?.id && currentUser?.id && hasClassPilot && (isAdmin || isTeacher) && !currentUser?.impersonating) };
  const capabilities = useDisciplineCapabilities(access);
  return { ...access, capabilities: capabilities.data, loading: isLoading || (access.eligible && capabilities.isPending),
    error: capabilities.error, refresh: capabilities.refetch, ready: access.eligible && capabilities.usable };
}

export function useDisciplineLifetime(schoolId, viewerId) {
  const lifetime = useRef(null);
  useEffect(() => { const controller = new AbortController(); lifetime.current = controller; return () => controller.abort(); }, [schoolId, viewerId]);
  return lifetime;
}
