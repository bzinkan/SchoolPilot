import { useCallback, useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { apiRequest } from '../../../lib/queryClient';
import { normalizeDashboardActivity, resolveActivityView } from './dashboardActivity';

const EMPTY_CONTEXTS = [];
const UNAVAILABLE_ACTIVITY = Object.freeze({ current: null, next: null, transitionKey: 'unavailable', pending: false });
const validContext = context => typeof context?.id === 'string' && context.id.length > 0
  && Number.isSafeInteger(context.activeStudentCount) && context.activeStudentCount >= 0
  && Number.isFinite(Date.parse(context.endsAt));

// Ownership is supplied by the server independently of the admin's school-wide
// Coverage count. Keep this export name for existing consumers during rollout.
export function useScheduledTestingView({ schoolId, viewerId, enabled }) {
  const scopeKey = JSON.stringify([schoolId, viewerId]);
  const [selection, setSelection] = useState(null);
  const [boundaryTime, setBoundaryTime] = useState(Date.now);
  const activityQueryKey = useMemo(() => ['/api/classpilot/dashboard-activity', schoolId, viewerId], [schoolId, viewerId]);
  const activityQuery = useQuery({
    queryKey: activityQueryKey,
    queryFn: async ({ signal }) => {
      const data = await apiRequest('GET', '/classpilot/dashboard-activity', undefined, {
        signal, headers: { 'X-School-Id': schoolId },
      });
      if (data.enabled === true && (data.schoolId !== schoolId || data.viewerId !== viewerId)) {
        throw new Error('The classroom assignment response belongs to another school or user.');
      }
      normalizeDashboardActivity(data, schoolId, viewerId);
      return data;
    },
    enabled: enabled && !!schoolId && !!viewerId,
    refetchInterval: query => {
      const boundary = Date.parse(query.state.data?.nextBoundaryAt);
      return Number.isFinite(boundary) && Math.abs(Date.now() - boundary) < 15000 ? 1000 : 10000;
    },
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: 'always', refetchOnReconnect: 'always', retry: false,
  });
  const serverOffset = Number.isFinite(Date.parse(activityQuery.data?.serverTime))
    ? Date.parse(activityQuery.data.serverTime) - activityQuery.dataUpdatedAt : 0;
  const confirmedActivity = useMemo(() => normalizeDashboardActivity(
    activityQuery.data, schoolId, viewerId, Math.max(boundaryTime, activityQuery.dataUpdatedAt) + serverOffset,
  ), [activityQuery.data, activityQuery.dataUpdatedAt, boundaryTime, schoolId, viewerId, serverOffset]);
  const scheduledActivity = confirmedActivity || (activityQuery.isError && activityQuery.data?.enabled !== false
    ? UNAVAILABLE_ACTIVITY : null);
  const scheduledClassEnabled = Boolean(scheduledActivity);
  const scheduledTransitionKey = scheduledActivity?.transitionKey || '';
  // Forget the old choice at the boundary, including when the same regular
  // session resumes after testing. A previous choice must not reappear then.
  if (scheduledClassEnabled && selection?.scopeKey === scopeKey
    && selection.transitionKey !== scheduledTransitionKey) setSelection(null);
  const refreshDashboardActivity = activityQuery.refetch;
  useEffect(() => {
    if (!scheduledClassEnabled) return;
    const deadlines = [scheduledActivity?.nextBoundaryAt, scheduledActivity?.current?.endsAt]
      .map(value => Date.parse(value) - serverOffset).filter(value => Number.isFinite(value) && value > boundaryTime);
    if (!deadlines.length) return;
    const timer = setTimeout(() => {
      setBoundaryTime(Date.now());
      void refreshDashboardActivity({ cancelRefetch: true });
    }, Math.min(2147483647, Math.max(0, Math.min(...deadlines) - Date.now())));
    return () => clearTimeout(timer);
  }, [scheduledClassEnabled, scheduledActivity, boundaryTime, refreshDashboardActivity, serverOffset]);
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
  const summaryScopeMatches = coverageSummary.schoolId === schoolId && coverageSummary.viewerId === viewerId;
  const hasOwnSupervisionRoster = summaryScopeMatches && Array.isArray(coverageSummary.ownSupervisionContexts)
    && coverageSummary.ownSupervisionContexts.every(validContext);
  const summaryTime = Math.max(dataUpdatedAt, boundaryTime);
  const ownSupervisionContexts = useMemo(() => {
    // A failed refresh can retain cached data. Its known end must still end the
    // automatic view, rather than stranding staff on yesterday's assignment.
    if (coverageSummary.schoolId !== schoolId || coverageSummary.viewerId !== viewerId) return EMPTY_CONTEXTS;
    const contexts = scheduledClassEnabled ? coverageSummary.ownAdHocContexts
      : coverageSummary.ownSupervisionContexts ?? coverageSummary.ownTestingContexts;
    if (!Array.isArray(contexts)) return EMPTY_CONTEXTS;
    const now = Math.max(dataUpdatedAt, boundaryTime);
    return [...new Map(contexts.filter((context) => (
      validContext(context) && context.activeStudentCount > 0 && Date.parse(context.endsAt) > now
    )).map(context => [context.id, context])).values()];
  }, [coverageSummary, schoolId, viewerId, boundaryTime, dataUpdatedAt, scheduledClassEnabled]);
  const summaryContextEntries = coverageSummary.ownSupervisionContexts ?? coverageSummary.ownTestingContexts;
  const summaryHasExpiredContext = summaryScopeMatches && Array.isArray(summaryContextEntries)
    && summaryContextEntries.some(context => validContext(context) && Date.parse(context.endsAt) <= summaryTime);
  const supervisionRosterRevision = summaryScopeMatches && typeof coverageSummary.revision === 'string'
    ? JSON.stringify([coverageSummary.revision, ownSupervisionContexts.map(context => [context.id, context.endsAt, context.activeStudentCount])]) : null;
  const scopedSelection = selection?.scopeKey === scopeKey ? selection : null;
  const pendingContexts = useMemo(() => (
    // A later successful polling read also settles an earlier failed refresh.
    // A retained error snapshot cannot erase a just-confirmed own claim.
    (isError || dataUpdatedAt <= (scopedSelection?.baselineUpdatedAt ?? -1)
      ? scopedSelection?.pendingContexts || EMPTY_CONTEXTS : EMPTY_CONTEXTS)
      .filter(context => Date.parse(context.endsAt) > boundaryTime)
  ), [scopedSelection, boundaryTime, isError, dataUpdatedAt]);
  // Counts come from the lightweight summary in every view, never a cached
  // roster whose query is paused while Class or Available is selected. A
  // committed claim awaiting refresh also makes the previous counts obsolete.
  const summaryCountsReady = !isError && pendingContexts.length === 0;
  const ownSupervisionStudentCount = hasOwnSupervisionRoster && summaryCountsReady
    ? ownSupervisionContexts.reduce((total, context) => total + context.activeStudentCount, 0) : null;
  const activeCoverageCount = summaryScopeMatches && summaryCountsReady && !summaryHasExpiredContext
    && Number.isSafeInteger(coverageSummary.activeContextCount) && coverageSummary.activeContextCount >= 0
    ? coverageSummary.activeContextCount : null;
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
  const automaticallyShowingSupervision = !scheduledClassEnabled && enabled && !manualSelection && displayContexts.length > 0;
  const studentView = resolveActivityView({ selection: scopedSelection, scopeKey,
    transitionKey: scheduledTransitionKey, scheduledEnabled: scheduledClassEnabled,
    defaultView: automaticallyShowingSupervision ? 'claimed' : 'class' });
  const setStudentView = useCallback((view) => {
    setSelection({ scopeKey, view, transitionKey: scheduledTransitionKey });
  }, [scopeKey, scheduledTransitionKey, setSelection]);

  const showOwnSupervision = useCallback(async (confirmedContexts = []) => {
    const activationId = globalThis.crypto.randomUUID();
    const pending = confirmedContexts.filter(context => (
      context?.id && context.assignedStaffId === viewerId && Date.parse(context.endsAt) > Date.now()
    ));
    setBoundaryTime(Date.now());
    const view = scheduledClassEnabled ? 'claimed' : null;
    setSelection({ scopeKey, view, transitionKey: scheduledTransitionKey, pendingContexts: pending, activationId, baselineUpdatedAt: dataUpdatedAt });
    try {
      // Cancel reads begun before the committed claim. A failure keeps the
      // confirmed destination visible; Retry repeats only this read.
      await refetch({ cancelRefetch: true, throwOnError: true });
      setSelection(current => current?.scopeKey === scopeKey && current.activationId === activationId
        ? { scopeKey, view, transitionKey: scheduledTransitionKey } : current);
    } catch {
      // The query error is displayed separately from the successful mutation.
    }
  }, [scopeKey, viewerId, refetch, dataUpdatedAt, scheduledClassEnabled, scheduledTransitionKey, setSelection, setBoundaryTime]);
  const retrySupervisionSummary = useCallback(() => showOwnSupervision(pendingContexts), [showOwnSupervision, pendingContexts]);
  return {
    scheduledClassEnabled, scheduledActivity, scheduledTransitionKey, activityQueryKey,
    refreshDashboardActivity, dashboardActivityError: activityQuery.isError,
    dashboardActivityLoading: activityQuery.isLoading, dashboardActivityRefreshing: activityQuery.isFetching,
    coverageSummary, summaryQueryKey, ownSupervisionContexts, displaySupervisionContexts: displayContexts,
    ownSupervisionStudentCount, activeCoverageCount, hasOwnSupervisionRoster, supervisionRosterRevision,
    automaticallyShowingSupervision, studentView, setStudentView, showOwnSupervision,
    supervisionSummaryError: isError, supervisionSummaryRefreshing: isFetching,
    pendingSupervisionConfirmation: pendingContexts.length > 0, retrySupervisionSummary,
    refreshSupervisionSummary: refetch,
    // Retain names used by existing consumers during this additive release.
    ownTestingContexts: ownSupervisionContexts, automaticallyShowingTesting: automaticallyShowingSupervision,
  };
}
