import { useEffect, useMemo, useRef, useState } from 'react';
import { apiRequest } from '../../../lib/queryClient';
import {
  normalizedObservationScope,
  observationLeaseRenewalFailureDisposition,
  observationLeaseResponseDisposition,
} from '../lib/observationLeaseStatus';

const RENEWAL_FALLBACK_MS = 30_000;
const RETRY_MS = 10_000;

function viewerInstanceId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  const random = Math.random().toString(36).slice(2);
  return `viewer_${Date.now().toString(36)}_${random}`.slice(0, 128);
}

export function useObservationLease({
  enabled, eligible = true, teachingSessionId, scope,
  authorityKey = '', retryEpoch = 0, onDenied,
}) {
  const normalizedScope = useMemo(() => normalizedObservationScope(scope), [scope]);
  const scopeKey = JSON.stringify(normalizedScope);
  const requestedSessionId = String(teachingSessionId || '');
  const leaseContextKey = enabled && requestedSessionId && normalizedScope
    ? `${authorityKey}:${requestedSessionId}:${scopeKey}:${retryEpoch}`
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

    const path = `/classpilot/teaching-sessions/${encodeURIComponent(sessionId)}/observation-lease`;
    let stopped = false;
    let timer = null;
    let requestEpoch = 0;
    let activeViewerId = viewerInstanceId();
    const knownViewerIds = new Set([activeViewerId]);
    let leaseWasActive = false;
    const setStatus = (nextStatus) => {
      setLeaseState({ contextKey: leaseContextKey, status: nextStatus });
    };

    const clearTimer = () => {
      if (timer) clearTimeout(timer);
      timer = null;
    };
    const deleteLease = (viewerId) => (
      apiRequest('DELETE', path, { viewerInstanceId: viewerId }).catch(() => {})
    );
    const release = (viewerId = activeViewerId, force = false) => {
      if (!force && (!leaseWasActive || viewerId !== activeViewerId)) return;
      if (viewerId === activeViewerId) leaseWasActive = false;
      void deleteLease(viewerId);
    };
    const invalidateRequest = () => {
      requestEpoch += 1;
      clearTimer();
    };
    const schedule = (delayMs) => {
      if (stopped) return;
      timer = setTimeout(renew, delayMs);
    };
    const renew = async () => {
      clearTimer();
      if (stopped || deniedContexts.current.has(leaseContextKey)) return;
      if (document.visibilityState !== 'visible') {
        invalidateRequest();
        release(activeViewerId, true);
        setStatus('paused_unobserved');
        return;
      }
      const epoch = requestEpoch + 1;
      requestEpoch = epoch;
      const requestViewerId = activeViewerId;
      try {
        const response = await apiRequest('PUT', path, {
          viewerInstanceId: requestViewerId,
          scope: normalizedScope,
        });
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
      }
    };
    const onVisibilityChange = () => {
      invalidateRequest();
      // A tab becoming visible proves no new authority. A checked retry or a
      // changed session authority is required after a terminal denial.
      if (deniedContexts.current.has(leaseContextKey)) return;
      if (document.visibilityState === 'visible') {
        activeViewerId = viewerInstanceId();
        knownViewerIds.add(activeViewerId);
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
    if (document.visibilityState === 'visible') void renew();
    else setStatus('paused_unobserved');

    return () => {
      stopped = true;
      document.removeEventListener('visibilitychange', onVisibilityChange);
      invalidateRequest();
      for (const viewerId of knownViewerIds) release(viewerId, true);
    };
  }, [eligible, enabled, leaseContextKey, normalizedScope, requestedSessionId]);

  return status;
}
