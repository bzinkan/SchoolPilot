import { useEffect, useMemo, useRef, useState } from 'react';
import { apiRequest } from '../../../lib/queryClient';

const RENEWAL_FALLBACK_MS = 30_000;
const RETRY_MS = 10_000;

function viewerInstanceId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  const random = Math.random().toString(36).slice(2);
  return `viewer_${Date.now().toString(36)}_${random}`.slice(0, 128);
}

export function normalizedObservationScope(scope) {
  if (scope?.kind === 'class') return { kind: 'class' };
  if (scope?.kind !== 'students' || !Array.isArray(scope.studentIds)) return null;
  const studentIds = [...new Set(scope.studentIds.filter(Boolean).map(String))].sort();
  return studentIds.length > 0 && studentIds.length <= 500
    ? { kind: 'students', studentIds }
    : null;
}

export function useObservationLease({ enabled, teachingSessionId, scope }) {
  const instanceIdRef = useRef(null);
  if (!instanceIdRef.current) instanceIdRef.current = viewerInstanceId();
  const normalizedScope = useMemo(() => normalizedObservationScope(scope), [scope]);
  const scopeKey = JSON.stringify(normalizedScope);
  const [status, setStatus] = useState('legacy');

  useEffect(() => {
    const sessionId = String(teachingSessionId || '');
    if (!enabled || !sessionId || !normalizedScope) {
      setStatus('legacy');
      return undefined;
    }

    const path = `/classpilot/teaching-sessions/${encodeURIComponent(sessionId)}/observation-lease`;
    const viewerId = instanceIdRef.current;
    let stopped = false;
    let timer = null;
    let controller = null;
    let leaseWasActive = false;

    const clearWork = () => {
      if (timer) clearTimeout(timer);
      timer = null;
      controller?.abort();
      controller = null;
    };
    const release = () => {
      if (!leaseWasActive) return;
      leaseWasActive = false;
      void apiRequest('DELETE', path, { viewerInstanceId: viewerId }).catch(() => {});
    };
    const schedule = (delayMs) => {
      if (stopped) return;
      timer = setTimeout(renew, delayMs);
    };
    const renew = async () => {
      clearWork();
      if (stopped) return;
      if (document.visibilityState !== 'visible') {
        release();
        setStatus('paused_unobserved');
        return;
      }
      controller = new AbortController();
      try {
        const response = await apiRequest('PUT', path, {
          viewerInstanceId: viewerId,
          scope: normalizedScope,
        }, { signal: controller.signal });
        if (stopped) return;
        leaseWasActive = true;
        setStatus('observed');
        const renewSeconds = Number(response?.renewAfterSeconds);
        schedule(Number.isFinite(renewSeconds) && renewSeconds > 0
          ? Math.min(renewSeconds * 1000, RENEWAL_FALLBACK_MS)
          : RENEWAL_FALLBACK_MS);
      } catch (error) {
        if (stopped || error?.code === 'ERR_CANCELED') return;
        leaseWasActive = false;
        // A server without the additive endpoint remains on the legacy policy.
        if (error?.response?.status === 404) setStatus('legacy');
        else setStatus('error');
        schedule(RETRY_MS);
      } finally {
        controller = null;
      }
    };
    const onVisibilityChange = () => {
      clearWork();
      if (document.visibilityState === 'visible') void renew();
      else {
        release();
        setStatus('paused_unobserved');
      }
    };

    document.addEventListener('visibilitychange', onVisibilityChange);
    if (document.visibilityState === 'visible') void renew();
    else setStatus('paused_unobserved');

    return () => {
      stopped = true;
      document.removeEventListener('visibilitychange', onVisibilityChange);
      clearWork();
      release();
    };
  }, [enabled, normalizedScope, scopeKey, teachingSessionId]);

  return status;
}
