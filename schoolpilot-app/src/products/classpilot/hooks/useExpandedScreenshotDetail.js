import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { apiRequest } from '../../../lib/queryClient';
import { activityRequestHeaders } from '../lib/dashboardActivity';
import { tileBatchFailureScope } from '../lib/tileCachePrivacy';
import { withClasspilotLeaseDeadline } from '../lib/classpilotRecovery';
import { normalizeObservedAtForDisplay } from '../lib/studentMonitoringDisplay';

const DETAIL_ENDPOINT = '/classpilot/tiles/detail-preview';
const POLL_MS = 5_000;
const PENDING_MS = 20_000;

// Detail pixels belong only to this visible, selected viewer. They never enter
// TanStack Query, the grid's image-reference cache, or a later viewer generation.
export function useExpandedScreenshotDetail({ privacyKey, schoolId, request }) {
  const [state, setState] = useState(null);
  const currentKeyRef = useRef(privacyKey);
  useLayoutEffect(() => { currentKeyRef.current = privacyKey; }, [privacyKey]);
  const requestKey = request ? JSON.stringify({ body: request.body, revision: request.contextAuthorityRevision }) : '';

  useLayoutEffect(() => {
    if (!privacyKey || !requestKey) {
      let cancelled = false;
      queueMicrotask(() => { if (!cancelled) setState(null); });
      return () => { cancelled = true; };
    }
    const { body, revision } = JSON.parse(requestKey);
    const headers = activityRequestHeaders(schoolId, revision);
    let active = null;
    let mounted = true;
    const isCurrent = generation => mounted && active === generation && currentKeyRef.current === privacyKey
      && document.visibilityState === 'visible';
    const release = (generation, leaseId) => {
      if (!leaseId) return;
      void apiRequest('POST', `${DETAIL_ENDPOINT}/release`, {
        viewerInstanceId: generation.viewerInstanceId, leaseId,
      }, { headers }).catch(() => {});
    };
    const stop = () => {
      const generation = active;
      active = null;
      if (!generation) return;
      clearTimeout(generation.timer);
      release(generation, generation.leaseId);
      // Keep every in-flight grant/renewal alive until its returned lease ID
      // is known. A renewal may commit after this release and create a new ID;
      // the raw promise cleans it up using this generation's unique viewer ID.
    };
    const start = () => {
      stop();
      if (!mounted || document.visibilityState !== 'visible') {
        setState({ key: privacyKey, screenshot: null, status: 'paused' });
        return;
      }
      const generation = { viewerInstanceId: crypto.randomUUID(), leaseId: null, timer: null, startedAt: Date.now() };
      active = generation;
      setState({ key: privacyKey, screenshot: null, status: 'pending' });
      const read = async () => {
        if (!isCurrent(generation)) return;
        const requestedAt = Date.now();
        try {
          let responseLeaseId = null;
          const raw = apiRequest('POST', DETAIL_ENDPOINT, { ...body, viewerInstanceId: generation.viewerInstanceId },
            { headers }).then(response => {
            responseLeaseId = response?.detailPreview?.leaseId;
            // Includes grants/renewals arriving after close, sign-out, hide or an
            // A→B→A transition. Their release cannot revoke a new visible viewer.
            if (!isCurrent(generation)) release(generation, response?.detailPreview?.leaseId);
            return response;
          });
          const response = await withClasspilotLeaseDeadline(raw, () => release(generation, responseLeaseId));
          if (!isCurrent(generation)) return;
          if (response?.studentId !== body.studentId) throw new Error('Detail preview student mismatch');
          if (!response.detailPreview) {
            release(generation, generation.leaseId);
            generation.leaseId = null;
            const unsupported = response.detailPreviewStatus === 'unsupported';
            setState({ key: privacyKey, screenshot: null, status: unsupported ? 'unsupported' : 'unavailable' });
            if (!unsupported) generation.timer = setTimeout(read, POLL_MS);
            return;
          }
          generation.leaseId = response.detailPreview.leaseId;
          const candidate = response.screenshot;
          const receivedAt = Date.now();
          const capturedAt = normalizeObservedAtForDisplay(candidate?.timestamp ?? candidate?.capturedAt, receivedAt);
          // Detail has its own binding namespace. Ordinary thumbnail validators
          // deliberately do not recognize it, so compare both stamps here.
          const valid = typeof response.bindingVersion === 'string' && response.bindingVersion.startsWith('detail-v1:')
            && candidate?.bindingVersion === response.bindingVersion && candidate?.resolution === 'detail'
            && typeof candidate?.screenshot === 'string' && capturedAt !== null;
          const expiresAt = Math.min(requestedAt + Math.min(20, Number(response.detailPreview.expiresInSeconds) || 0) * 1000,
            (capturedAt ?? 0) + PENDING_MS);
          const screenshot = valid && expiresAt > receivedAt ? { ...candidate, detailExpiresAtMs: expiresAt } : null;
          setState({ key: privacyKey, screenshot, status: screenshot ? 'active'
            : Date.now() - generation.startedAt < PENDING_MS ? 'pending' : 'unavailable' });
        } catch (error) {
          if (!isCurrent(generation)) return;
          if (Number(error?.response?.status) === 404 && !error?.response?.data?.code
            && /^not found$/i.test(error?.response?.data?.error || '')) {
            stop();
            setState({ key: privacyKey, screenshot: null, status: 'unsupported' });
            return;
          }
          const failureScope = tileBatchFailureScope(error);
          if (failureScope !== 'transient') {
            stop();
            setState({ key: privacyKey, screenshot: null, status: 'denied', failureScope });
            return;
          }
          setState(previous => ({ key: privacyKey,
            screenshot: previous?.key === privacyKey ? previous.screenshot : null, status: 'unavailable' }));
          // A timed-out grant may still be in flight. Do not overlap it with a
          // new grant under the same viewer ID; its late cleanup is exact.
          if (error?.code === 'CLASSPILOT_READ_TIMEOUT') {
            stop();
            return;
          }
        }
        if (isCurrent(generation)) generation.timer = setTimeout(read, POLL_MS);
      };
      void read();
    };
    start();
    const visibility = () => { if (document.visibilityState !== 'visible' || !active) start(); };
    document.addEventListener('visibilitychange', visibility);
    return () => {
      mounted = false;
      document.removeEventListener('visibilitychange', visibility);
      stop();
    };
  }, [privacyKey, requestKey, schoolId]);

  const detailExpiresAtMs = state?.screenshot?.detailExpiresAtMs;
  useEffect(() => {
    if (!Number.isFinite(detailExpiresAtMs)) return undefined;
    const timer = setTimeout(() => setState(previous => previous?.screenshot?.detailExpiresAtMs === detailExpiresAtMs
      ? { ...previous, screenshot: null, status: 'unavailable' } : previous), Math.max(0, detailExpiresAtMs - Date.now()));
    return () => clearTimeout(timer);
  }, [detailExpiresAtMs]);

  return privacyKey && state?.key === privacyKey ? state
    : { screenshot: null, status: requestKey ? 'pending' : 'unavailable' };
}
