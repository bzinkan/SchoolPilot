import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useAuth } from '../../contexts/AuthContext';
import { apiRequest } from '../../lib/queryClient';

const PRODUCTS = new Set(['classpilot', 'passpilot', 'gopilot']);

function currentSchoolDay(status, now) {
  if (!status || typeof status.calendarClosed !== 'boolean'
    || ![null, true, false].includes(status.classpilotInstructionalOverride)
    || typeof status.schoolTimezone !== 'string' || !status.schoolTimezone
    || !Number.isFinite(Date.parse(status.evaluatedAt))
    || !(Date.parse(status.validUntil) > now)) return false;
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: status.schoolTimezone, year: 'numeric', month: '2-digit', day: '2-digit',
    }).formatToParts(now);
    const date = Object.fromEntries(parts.map(part => [part.type, part.value]));
    return status.schoolLocalDate === `${date.year}-${date.month}-${date.day}`;
  } catch {
    return false;
  }
}

export function useSchoolDayStatus(product) {
  const { activeSchoolId, activeMembership, user, loading } = useAuth();
  const [now, setNow] = useState(Date.now);
  const roles = product === 'gopilot'
    ? activeMembership?.gopilotRoles || [activeMembership?.gopilotRole || activeMembership?.role]
    : activeMembership?.roles || [activeMembership?.role];
  const enabled = !loading && Boolean(user?.id && activeSchoolId)
    && activeMembership?.schoolId === activeSchoolId && PRODUCTS.has(product)
    && roles.some(role => ['admin', 'school_admin', 'teacher', 'office_staff'].includes(role));
  const query = useQuery({
    queryKey: ['school-day-status', activeSchoolId, product, user?.id, user?.authVersion,
      Boolean(user?.impersonating), activeMembership?.id, [...roles].sort().join(',')],
    queryFn: ({ signal }) => apiRequest('GET', `/${product}/school-day-status`, undefined, {
      signal, headers: { 'X-School-Id': activeSchoolId },
    }),
    enabled,
    retry: false,
    gcTime: 0,
    staleTime: 60_000,
    refetchOnMount: 'always',
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    refetchInterval: 300_000,
    refetchIntervalInBackground: false,
  });
  const { refetch } = query;

  useEffect(() => {
    if (!enabled) return undefined;
    const refresh = () => {
      setNow(Date.now());
      if (document.visibilityState !== 'hidden') void refetch();
    };
    window.addEventListener('focus', refresh);
    window.addEventListener('online', refresh);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      window.removeEventListener('focus', refresh);
      window.removeEventListener('online', refresh);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, [enabled, refetch]);

  // A response for yesterday must disappear at school midnight even while the
  // next request is pending or offline. Repeated expired responses cannot loop.
  const validUntil = query.data?.validUntil;
  useEffect(() => {
    const remaining = Date.parse(validUntil) - Date.now();
    if (!enabled || !Number.isFinite(remaining) || remaining <= 0) return undefined;
    const timeout = window.setTimeout(() => {
      setNow(Date.now());
      void refetch();
    }, Math.min(remaining, 2_147_483_647));
    return () => window.clearTimeout(timeout);
  }, [enabled, validUntil, refetch]);

  if (!enabled || query.isError || query.fetchStatus === 'paused'
    || !currentSchoolDay(query.data, Math.max(now, query.dataUpdatedAt))) return null;
  return query.data;
}
