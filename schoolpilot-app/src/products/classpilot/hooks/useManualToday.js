import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { apiRequest } from '../../../lib/queryClient';

export const MANUAL_TODAY_QUERY = '/api/classpilot/groups/manual-today';

export function useManualToday({ schoolId, viewerId, accessScope, enabled = true }) {
  const [observedTime, setObservedTime] = useState(() => Date.now());
  const manualTodayQueryKey = [MANUAL_TODAY_QUERY, schoolId, viewerId, accessScope];
  const query = useQuery({
    queryKey: manualTodayQueryKey,
    queryFn: ({ signal }) => apiRequest('GET', '/classpilot/groups/manual-today', undefined, {
      signal, headers: { 'X-School-Id': schoolId },
    }),
    enabled: enabled && !!schoolId && !!viewerId,
    staleTime: 15_000,
    // Read the server's school date again across midnight and permission changes.
    refetchInterval: 60_000,
    refetchOnMount: 'always',
    refetchOnWindowFocus: true,
  });
  const expiresAt = Date.parse(query.data?.resumesAt);
  const refetch = query.refetch;
  useEffect(() => {
    if (!enabled || !Number.isFinite(expiresAt)) return;
    const timer = setTimeout(() => {
      setObservedTime(Date.now());
      void refetch();
    }, Math.max(0, expiresAt - Date.now()));
    return () => clearTimeout(timer);
  }, [enabled, expiresAt, refetch]);
  const isDayExpired = Number.isFinite(expiresAt) && expiresAt <= observedTime;
  return {
    ...query,
    manualTodayQueryKey,
    isDayExpired,
    // Never keep yesterday's badge or permit a stale-day review during recovery.
    data: query.data && isDayExpired ? {
      ...query.data, canManageManualToday: false,
      classes: (query.data.classes || []).map(group => ({ ...group, isManualToday: false })),
    } : query.data,
  };
}

export function manualTodayDateLabel(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '')) return '';
  return new Date(`${value}T12:00:00Z`).toLocaleDateString(undefined, {
    month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC',
  });
}
