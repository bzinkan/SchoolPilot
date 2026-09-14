import { useCallback, useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { apiRequest } from '../../../lib/queryClient';

const EMPTY_CONTEXTS = [];

// Testing ownership is supplied by the server independently of the admin's
// school-wide Coverage count. Manual view choices always take precedence.
export function useScheduledTestingView({ schoolId, viewerId, enabled }) {
  const scopeKey = JSON.stringify([schoolId, viewerId]);
  const [selection, setSelection] = useState(null);
  const [boundaryTime, setBoundaryTime] = useState(Date.now);
  const summaryQueryKey = useMemo(
    () => ['/api/coverage/summary', schoolId, viewerId],
    [schoolId, viewerId],
  );
  const { data: coverageSummary = {}, dataUpdatedAt, refetch } = useQuery({
    queryKey: summaryQueryKey,
    queryFn: ({ signal }) => apiRequest('GET', '/coverage/summary', undefined, {
      signal, headers: { 'X-School-Id': schoolId },
    }),
    enabled: enabled && !!schoolId && !!viewerId,
    // Scheduled boundaries must reconcile even when the socket stays connected.
    refetchInterval: 10000,
    refetchIntervalInBackground: false,
  });
  const ownTestingContexts = useMemo(() => {
    // A failed refresh can retain cached data. Its known end must still end the
    // automatic view, rather than stranding staff on yesterday's assignment.
    if (coverageSummary.schoolId !== schoolId || coverageSummary.viewerId !== viewerId
      || !Array.isArray(coverageSummary.ownTestingContexts)) return EMPTY_CONTEXTS;
    const now = Math.max(dataUpdatedAt, boundaryTime);
    return coverageSummary.ownTestingContexts.filter((context) => (
      context.id && context.activeStudentCount > 0 && Date.parse(context.endsAt) > now
    ));
  }, [coverageSummary, schoolId, viewerId, boundaryTime, dataUpdatedAt]);
  useEffect(() => {
    if (!enabled || ownTestingContexts.length === 0) return;
    const nextEnd = Math.min(...ownTestingContexts.map((context) => Date.parse(context.endsAt)));
    const timer = setTimeout(() => {
      setBoundaryTime(Date.now());
      void refetch();
    }, Math.min(2_147_483_647, Math.max(0, nextEnd - Date.now())));
    return () => clearTimeout(timer);
  }, [enabled, ownTestingContexts, refetch]);
  const manualSelection = selection?.scopeKey === scopeKey ? selection.view : null;
  const automaticallyShowingTesting = enabled && !manualSelection && ownTestingContexts.length > 0;
  const studentView = manualSelection || (automaticallyShowingTesting ? 'claimed' : 'class');
  const setStudentView = useCallback((view) => {
    setSelection({ scopeKey, view });
  }, [scopeKey]);

  return { coverageSummary, summaryQueryKey, ownTestingContexts, automaticallyShowingTesting, studentView, setStudentView };
}
