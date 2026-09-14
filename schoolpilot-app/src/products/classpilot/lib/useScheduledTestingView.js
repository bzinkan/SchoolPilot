import { useCallback, useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { apiRequest } from '../../../lib/queryClient';

const EMPTY_CONTEXTS = [];

// Ownership is supplied by the server independently of the admin's school-wide
// Coverage count. Keep this export name for existing consumers during rollout.
export function useScheduledTestingView({ schoolId, viewerId, enabled }) {
  const scopeKey = JSON.stringify([schoolId, viewerId]);
  const [selection, setSelection] = useState(null);
  const [boundaryTime, setBoundaryTime] = useState(Date.now);
  const summaryQueryKey = useMemo(
    () => ['/api/coverage/summary', schoolId, viewerId],
    [schoolId, viewerId],
  );
  const { data: coverageSummary = {}, dataUpdatedAt, refetch, isError, isFetching } = useQuery({
    queryKey: summaryQueryKey,
    queryFn: ({ signal }) => apiRequest('GET', '/coverage/summary', undefined, {
      signal, headers: { 'X-School-Id': schoolId },
    }),
    enabled: enabled && !!schoolId && !!viewerId,
    // Scheduled boundaries must reconcile even when the socket stays connected.
    refetchInterval: 10000,
    refetchIntervalInBackground: false,
  });
  const ownSupervisionContexts = useMemo(() => {
    // A failed refresh can retain cached data. Its known end must still end the
    // automatic view, rather than stranding staff on yesterday's assignment.
    if (coverageSummary.schoolId !== schoolId || coverageSummary.viewerId !== viewerId) return EMPTY_CONTEXTS;
    const contexts = coverageSummary.ownSupervisionContexts ?? coverageSummary.ownTestingContexts;
    if (!Array.isArray(contexts)) return EMPTY_CONTEXTS;
    const now = Math.max(dataUpdatedAt, boundaryTime);
    return contexts.filter((context) => (
      context?.id && context.activeStudentCount > 0 && Date.parse(context.endsAt) > now
    ));
  }, [coverageSummary, schoolId, viewerId, boundaryTime, dataUpdatedAt]);
  const scopedSelection = selection?.scopeKey === scopeKey ? selection : null;
  const pendingContexts = useMemo(() => (
    // A later successful polling read also settles an earlier failed refresh.
    // A retained error snapshot cannot erase a just-confirmed own claim.
    (isError || dataUpdatedAt <= (scopedSelection?.baselineUpdatedAt ?? -1)
      ? scopedSelection?.pendingContexts || EMPTY_CONTEXTS : EMPTY_CONTEXTS)
      .filter(context => Date.parse(context.endsAt) > boundaryTime)
  ), [scopedSelection, boundaryTime, isError, dataUpdatedAt]);
  const displayContexts = useMemo(() => (
    [...new Map([...pendingContexts, ...ownSupervisionContexts].map(context => [context.id, context])).values()]
  ), [pendingContexts, ownSupervisionContexts]);
  useEffect(() => {
    if (!enabled || displayContexts.length === 0) return;
    const nextEnd = Math.min(...displayContexts.map((context) => Date.parse(context.endsAt)));
    const timer = setTimeout(() => {
      setBoundaryTime(Date.now());
      void refetch();
    }, Math.min(2_147_483_647, Math.max(0, nextEnd - Date.now())));
    return () => clearTimeout(timer);
  }, [enabled, displayContexts, refetch]);
  const manualSelection = scopedSelection?.view || null;
  const automaticallyShowingSupervision = enabled && !manualSelection && displayContexts.length > 0;
  const studentView = manualSelection || (automaticallyShowingSupervision ? 'claimed' : 'class');
  const setStudentView = useCallback((view) => {
    setSelection({ scopeKey, view });
  }, [scopeKey]);

  const showOwnSupervision = useCallback(async (confirmedContexts = []) => {
    const activationId = globalThis.crypto.randomUUID();
    const pending = confirmedContexts.filter(context => (
      context?.id && context.assignedStaffId === viewerId && Date.parse(context.endsAt) > Date.now()
    ));
    setBoundaryTime(Date.now());
    setSelection({ scopeKey, view: null, pendingContexts: pending, activationId, baselineUpdatedAt: dataUpdatedAt });
    try {
      // Cancel reads begun before the committed claim. A failure keeps the
      // confirmed destination visible; Retry repeats only this read.
      await refetch({ cancelRefetch: true, throwOnError: true });
      setSelection(current => current?.scopeKey === scopeKey && current.activationId === activationId
        ? { scopeKey, view: null } : current);
    } catch {
      // The query error is displayed separately from the successful mutation.
    }
  }, [scopeKey, viewerId, refetch, dataUpdatedAt]);
  const retrySupervisionSummary = useCallback(() => showOwnSupervision(pendingContexts), [showOwnSupervision, pendingContexts]);
  return {
    coverageSummary, summaryQueryKey, ownSupervisionContexts, displaySupervisionContexts: displayContexts,
    automaticallyShowingSupervision, studentView, setStudentView, showOwnSupervision,
    supervisionSummaryError: isError, supervisionSummaryRefreshing: isFetching,
    pendingSupervisionConfirmation: pendingContexts.length > 0, retrySupervisionSummary,
    // Retain names used by existing consumers during this additive release.
    ownTestingContexts: ownSupervisionContexts, automaticallyShowingTesting: automaticallyShowingSupervision,
  };
}
