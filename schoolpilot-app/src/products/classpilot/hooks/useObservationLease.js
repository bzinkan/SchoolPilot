import { useEffect, useMemo, useRef, useState } from 'react';
import { apiRequest } from '../../../lib/queryClient';
import { withClasspilotLeaseDeadline, withClasspilotReadDeadline } from '../lib/classpilotRecovery';
import { activityAuthority, activityAuthorityKey, activityParentPath, activityRequestHeaders } from '../lib/dashboardActivity';
import {
  normalizedObservationScope,
  observationLeaseRenewalFailureDisposition,
  observationLeaseResponseDisposition,
} from '../lib/observationLeaseStatus';

const RENEWAL_FALLBACK_MS = 30_000;
const RETRY_MS = 10_000;
const RECOVERY_RESET_MS = 20_000;
const MAX_RAW_PUTS = 12;
export const CLASSPILOT_TRANSPORT_RECOVERED_EVENT = 'classpilot-transport-recovered';

function viewerInstanceId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  const random = Math.random().toString(36).slice(2);
  return `viewer_${Date.now().toString(36)}_${random}`.slice(0, 128);
}

export function useObservationLease({
  enabled, eligible = true, schoolId, teachingSessionId, supervisionContextId, contextAuthorityRevision, scope,
  authorityKey = '', retryEpoch = 0, onDenied,
}) {
  const normalizedScope = useMemo(() => normalizedObservationScope(scope), [scope]);
  const scopeKey = JSON.stringify(normalizedScope);
  const requestedAuthorityKey = activityAuthorityKey({ teachingSessionId, supervisionContextId });
  const requestedAuthority = useMemo(() => requestedAuthorityKey ? JSON.parse(requestedAuthorityKey) : null, [requestedAuthorityKey]);
  const requestedSessionId = teachingSessionId || supervisionContextId || '';
  const leaseContextKey = enabled && requestedSessionId && normalizedScope
    ? `${authorityKey}:${requestedAuthorityKey}:${scopeKey}:${retryEpoch}`
    : null;
  const deniedContexts = useRef(new Set());
  const [deniedContextKeys, setDeniedContextKeys] = useState(() => new Set());
  const onDeniedRef = useRef(onDenied);
  useEffect(() => { onDeniedRef.current = onDenied; }, [onDenied]);
  const [leaseState, setLeaseState] = useState({ contextKey: null, status: 'legacy' });
  const leaseConfigurationInvalid = enabled && (!requestedSessionId || !normalizedScope);
  let status = 'pending';
  if (!enabled) status = 'legacy';
  else if (!eligible) status = 'ineligible';
  else if (leaseConfigurationInvalid) status = 'denied';
  else if (deniedContextKeys.has(leaseContextKey)) status = 'denied';
  else if (leaseState.contextKey === leaseContextKey) status = leaseState.status;

  useEffect(() => {
    const sessionId = requestedSessionId;
    if (!enabled) {
      // Resetting the external lease state prevents A→disabled→A from
      // reviving an observed result before the new PUT succeeds.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setLeaseState((current) => (
        current.contextKey === null && current.status === 'legacy'
          ? current
          : { contextKey: null, status: 'legacy' }
      ));
      return undefined;
    }
    if (!eligible || deniedContexts.current.has(leaseContextKey)) return undefined;
    if (!sessionId || !normalizedScope) {
      // Invalid enabled scopes fail private without issuing a lease request.
      setLeaseState({ contextKey: null, status: 'denied' });
      return undefined;
    }

    if (!activityAuthority(requestedAuthority)) return undefined;
    const path = activityParentPath(requestedAuthority, 'observation-lease');
    let stopped = false;
    let timer = null;
    let recoveryTimer = null;
    let requestEpoch = 0;
    let logicalRequestEpoch = null;
    let activeViewerId = viewerInstanceId();
    let leaseWasActive = false;
    let renewBlocked = false;
    let lastRecoveryReset = -Infinity;
    let currentPuts = new Set();
    const pendingPuts = new Map();
    const setStatus = (nextStatus) => {
      setLeaseState({ contextKey: leaseContextKey, status: nextStatus });
    };

    const clearTimer = () => {
      if (timer) clearTimeout(timer);
      timer = null;
    };
    const deleteLease = (viewerId) => (
      withClasspilotReadDeadline(signal => apiRequest('DELETE', path, { viewerInstanceId: viewerId }, {
        signal, headers: activityRequestHeaders(schoolId, contextAuthorityRevision),
      }), undefined, 3_000).catch(() => {})
    );
    const release = (viewerId = activeViewerId, force = false) => {
      if (!force && (!leaseWasActive || viewerId !== activeViewerId)) return;
      if (viewerId === activeViewerId) leaseWasActive = false;
      void deleteLease(viewerId);
    };
    const invalidateRequest = () => {
      requestEpoch += 1;
      logicalRequestEpoch = null;
      clearTimer();
    };
    const schedule = (delayMs) => {
      if (stopped) return;
      clearTimer();
      timer = setTimeout(renew, delayMs);
    };
    const renew = async () => {
      clearTimer();
      if (stopped || deniedContexts.current.has(leaseContextKey)) return;
      if (logicalRequestEpoch !== null) return;
      if (document.visibilityState !== 'visible') {
        invalidateRequest();
        release(activeViewerId, true);
        setStatus('paused_unobserved');
        return;
      }
      if (currentPuts.size >= 2 || pendingPuts.size >= MAX_RAW_PUTS) {
        renewBlocked = true; setStatus('error'); schedule(RETRY_MS); return;
      }
      renewBlocked = false;
      const epoch = requestEpoch + 1;
      requestEpoch = epoch;
      logicalRequestEpoch = epoch;
      const requestViewerId = activeViewerId;
      try {
        const rawPut = apiRequest('PUT', path, {
          viewerInstanceId: requestViewerId,
          scope: normalizedScope,
        }, { timeout: 90_000, headers: activityRequestHeaders(schoolId, contextAuthorityRevision) });
        const admittedPuts = currentPuts;
        admittedPuts.add(rawPut);
        pendingPuts.set(rawPut, requestViewerId);
        void rawPut.finally(() => {
          pendingPuts.delete(rawPut); admittedPuts.delete(rawPut);
          // A raw settlement frees a permit even when its logical caller has
          // expired. Wake a blocked current generation without waiting 10s.
          if (renewBlocked && !stopped && document.visibilityState === 'visible') schedule(0);
        }).catch(() => {});
        const response = await withClasspilotLeaseDeadline(rawPut, () => deleteLease(requestViewerId));
        const disposition = observationLeaseResponseDisposition({
          stopped,
          requestEpoch: epoch,
          currentEpoch: requestEpoch,
          visibilityState: document.visibilityState,
          requestViewerId,
          activeViewerId,
        });
        if (disposition === 'release') {
          await deleteLease(requestViewerId);
          return;
        }
        leaseWasActive = true;
        setStatus('observed');
        const renewSeconds = Number(response?.renewAfterSeconds);
        schedule(Number.isFinite(renewSeconds) && renewSeconds > 0
          ? Math.min(renewSeconds * 1000, RENEWAL_FALLBACK_MS)
          : RENEWAL_FALLBACK_MS);
      } catch (error) {
        if (stopped || epoch !== requestEpoch) {
          // The revoke path already sent an immediate DELETE. Send another
          // after the PUT settles because the server mutation may have
          // committed after that first DELETE reached Redis.
          await deleteLease(requestViewerId);
          return;
        }
        if (error?.code === 'CLASSPILOT_READ_TIMEOUT') {
          invalidateRequest();
          release(requestViewerId, true);
          activeViewerId = viewerInstanceId();
          setStatus('error'); schedule(RETRY_MS);
          return;
        }
        const failure = observationLeaseRenewalFailureDisposition(error);
        if (!failure.releaseLease) {
          // A transport outage does not revoke an otherwise unexpired exact-
          // context lease. Keep it bounded by the server TTL and retry timer.
          setStatus('error');
          schedule(RETRY_MS);
        } else {
          deniedContexts.current.add(leaseContextKey);
          setDeniedContextKeys(new Set(deniedContexts.current));
          leaseWasActive = false;
          setStatus(failure.status);
          onDeniedRef.current?.();
          // A terminal renewal denial revokes any lease previously created
          // under this exact viewer id instead of waiting for its TTL.
          await deleteLease(requestViewerId);
        }
      } finally {
        if (logicalRequestEpoch === epoch) logicalRequestEpoch = null;
      }
    };
    const onTransportRecovered = () => {
      if (stopped || document.visibilityState !== 'visible' || deniedContexts.current.has(leaseContextKey)) return;
      if (recoveryTimer) return;
      const delay = Math.max(0, lastRecoveryReset + RECOVERY_RESET_MS - performance.now());
      recoveryTimer = setTimeout(() => {
        recoveryTimer = null;
        if (stopped || document.visibilityState !== 'visible' || deniedContexts.current.has(leaseContextKey)) return;
        lastRecoveryReset = performance.now();
        invalidateRequest();
        release(activeViewerId, true);
        activeViewerId = viewerInstanceId();
        leaseWasActive = false;
        // Old raw PUTs retain their settlement/revoke handlers. They cannot
        // exhaust the two current-generation permits after connectivity returns.
        // Twenty-second reset spacing and the 90s raw ceiling bound draining
        // work; the total cap is a final guard against a broken HTTP adapter.
        currentPuts = new Set();
        setStatus('pending');
        void renew();
      }, delay);
    };
    const onVisibilityChange = () => {
      invalidateRequest();
      // A tab becoming visible proves no new authority. A checked retry or a
      // changed session authority is required after a terminal denial.
      if (deniedContexts.current.has(leaseContextKey)) return;
      if (document.visibilityState === 'visible') {
        release(activeViewerId, true);
        activeViewerId = viewerInstanceId();
        leaseWasActive = false;
        setStatus('pending');
        void renew();
      }
      else {
        release(activeViewerId, true);
        setStatus('paused_unobserved');
      }
    };

    document.addEventListener('visibilitychange', onVisibilityChange);
    window.addEventListener('online', onTransportRecovered);
    window.addEventListener(CLASSPILOT_TRANSPORT_RECOVERED_EVENT, onTransportRecovered);
    if (document.visibilityState === 'visible') void renew();
    else setStatus('paused_unobserved');

    return () => {
      stopped = true;
      document.removeEventListener('visibilitychange', onVisibilityChange);
      window.removeEventListener('online', onTransportRecovered);
      window.removeEventListener(CLASSPILOT_TRANSPORT_RECOVERED_EVENT, onTransportRecovered);
      clearTimeout(recoveryTimer);
      invalidateRequest();
      // Settled historical viewers were already released; retain only the
      // current viewer and the bounded raw PUTs that can still commit.
      for (const viewerId of new Set([activeViewerId, ...pendingPuts.values()])) release(viewerId, true);
    };
  }, [eligible, enabled, leaseContextKey, normalizedScope, requestedSessionId, requestedAuthority, schoolId, contextAuthorityRevision]);

  return status;
}
