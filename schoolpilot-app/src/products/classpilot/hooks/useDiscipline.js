import { useEffect, useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useClassPilotAuth } from '../../../hooks/useClassPilotAuth';
import { useLicenses } from '../../../contexts/LicenseContext';
import { useAuth } from '../../../contexts/AuthContext';
import { disciplineApi, disciplineKeys } from '../lib/discipline';

export function useDisciplineCapabilities(access) {
  const { schoolId, viewerId } = access;
  const query = useQuery({ queryKey: disciplineKeys.capabilities(schoolId, viewerId),
    queryFn: ({ signal }) => disciplineApi(schoolId, signal).capabilities(),
    enabled: Boolean(schoolId && viewerId && access.eligible !== false), retry: false,
    staleTime: 0, gcTime: 0, refetchOnWindowFocus: true });
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
