import { useEffect, useState } from 'react';
import { apiRequest } from '../../../lib/queryClient';
import {
  DESKTOP_LEASE_PATH, DESKTOP_TILES_PATH, DESKTOP_POLL_MS, DESKTOP_RENEW_MS,
  desktopDeadline, desktopSourceKey, desktopTarget, selectedDesktopRow,
} from '../lib/nativeDesktop';

const EMPTY = Object.freeze({ key: '', status: 'paused', row: null, deadline: 0, viewerInstanceId: '' });

export function useNativeDesktopPreview({ requested, attempt = 0, studentId, source, contextKey, authority, headers }) {
  const sourceKey = desktopSourceKey(source);
  const key = JSON.stringify([contextKey, studentId, sourceKey, attempt]);
  const authorityJson = JSON.stringify(authority);
  const headersJson = JSON.stringify(headers);
  const [state, setState] = useState(EMPTY);

  useEffect(() => {
    if (!requested || !sourceKey) {
      let cancelled = false;
      queueMicrotask(() => { if (!cancelled) setState(EMPTY); });
      return () => { cancelled = true; };
    }
    const [sourceRef, bindingRevision] = JSON.parse(sourceKey);
    const target = desktopTarget(studentId, { sourceRef, bindingRevision });
    const requestAuthority = JSON.parse(authorityJson);
    const requestHeaders = JSON.parse(headersJson);
    let stopped = false;
    let current = null;
    const publish = (status, row = null, deadline = 0, viewerInstanceId = '') => {
      if (!stopped) setState({ key, status, row, deadline, viewerInstanceId });
    };
    const release = cycle => {
      if (!cycle) return;
      cycle.stopped = true;
      clearTimeout(cycle.renewTimer);
      clearTimeout(cycle.pollTimer);
      clearTimeout(cycle.expiryTimer);
      cycle.readController?.abort();
      // The same viewer is also released after an outstanding PUT settles.
      void apiRequest('DELETE', `${DESKTOP_LEASE_PATH}/${cycle.id}`, undefined,
        { headers: requestHeaders, timeout: 10_000 }).catch(() => {});
    };
    const active = cycle => !stopped && !cycle.stopped && current === cycle && document.visibilityState === 'visible';
    const scheduleExpiry = cycle => {
      clearTimeout(cycle.expiryTimer);
      cycle.expiryTimer = setTimeout(() => {
        if (!active(cycle)) return;
        publish('stale');
        release(cycle);
        current = null;
      }, Math.max(0, cycle.grantDeadline - performance.now()));
    };
    const read = async cycle => {
      if (!active(cycle) || cycle.reading || performance.now() >= cycle.grantDeadline) return;
      cycle.reading = true;
      const started = performance.now();
      const controller = new AbortController();
      cycle.readController = controller;
      try {
        const response = await apiRequest('POST', DESKTOP_TILES_PATH, {
          studentIds: [studentId], ...requestAuthority, viewerInstanceId: cycle.id, selectedSources: [target],
        }, { headers: requestHeaders, signal: controller.signal, timeout: 8_000 });
        if (!active(cycle) || performance.now() >= cycle.grantDeadline) return;
        const row = selectedDesktopRow(response, target);
        if (!row) {
          publish('unavailable'); release(cycle); current = null; return;
        }
        const deadline = Math.min(cycle.grantDeadline,
          desktopDeadline(row.expiresAt, response.serverTime, started, performance.now()));
        const sequence = Number(row.sequence);
        const validSequence = Number.isSafeInteger(sequence) && sequence >= 0;
        if (validSequence && sequence < cycle.sequence) return;
        if (validSequence) cycle.sequence = sequence;
        const contentValid = validSequence && deadline > performance.now()
          && row.state === 'available'
          && typeof row.screenshot === 'string' && /^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(row.screenshot)
          && row.screenshot.length <= 700_000;
        if (contentValid) cycle.observedImage = true;
        const noFirstImage = row.state === 'stale' && !cycle.observedImage;
        publish(contentValid ? 'available' : row.state === 'available' || noFirstImage ? 'waiting' : row.state,
          contentValid ? row : null, contentValid ? deadline : 0, cycle.id);
      } catch {
        if (!active(cycle)) return;
        publish('unavailable');
        release(cycle); current = null;
      } finally {
        cycle.reading = false;
        if (active(cycle)) cycle.pollTimer = setTimeout(() => { void read(cycle); }, DESKTOP_POLL_MS);
      }
    };
    const renew = async cycle => {
      if (!active(cycle)) return;
      const started = performance.now();
      try {
        const response = await apiRequest('PUT', `${DESKTOP_LEASE_PATH}/${cycle.id}`,
          { ...requestAuthority, targets: [target] }, { headers: requestHeaders, timeout: 10_000 });
        if (!active(cycle)) { release(cycle); return; }
        cycle.grantDeadline = desktopDeadline(response.expiresAt, response.serverTime, started, performance.now());
        if (cycle.grantDeadline <= performance.now()) {
          publish('stale'); release(cycle); current = null; return;
        }
        scheduleExpiry(cycle);
        if (!cycle.reading && !cycle.pollTimer) void read(cycle);
        cycle.renewTimer = setTimeout(() => { void renew(cycle); }, DESKTOP_RENEW_MS);
      } catch {
        if (!active(cycle)) { release(cycle); return; }
        // A renewal failure removes content and ends this viewer. Only a fresh
        // user action or visibility revalidation can create another grant.
        publish('unavailable'); release(cycle); current = null;
      }
    };
    const onVisibility = () => {
      release(current);
      current = null;
      publish('paused');
      if (document.visibilityState !== 'visible' || navigator.onLine === false || stopped) return;
      const cycle = { id: crypto.randomUUID(), stopped: false, grantDeadline: 0, sequence: -1, reading: false };
      current = cycle;
      publish('pending');
      void renew(cycle);
    };
    const onOffline = () => {
      release(current);
      current = null;
      publish('unavailable');
    };
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('offline', onOffline);
    queueMicrotask(() => { if (!stopped) onVisibility(); });
    return () => {
      stopped = true;
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('offline', onOffline);
      release(current);
      current = null;
    };
  }, [requested, studentId, sourceKey, key, authorityJson, headersJson]);

  return requested && state.key === key ? state : EMPTY;
}

export function useDecodedDesktopFrame(preview) {
  const [frame, setFrame] = useState(null);
  const [expiredIdentity, setExpiredIdentity] = useState('');
  const identity = JSON.stringify([preview.key, preview.viewerInstanceId]);
  const row = preview.row;
  const deadline = preview.deadline;
  useEffect(() => {
    let cancelled = false;
    let expiry;
    if (!row?.screenshot || deadline <= performance.now()) {
      queueMicrotask(() => { if (!cancelled) setFrame(null); });
      return () => { cancelled = true; };
    }
    const image = new Image();
    const loaded = new Promise((resolve, reject) => { image.onload = resolve; image.onerror = reject; });
    image.src = row.screenshot;
    const decoded = typeof image.decode === 'function' ? image.decode().catch(() => loaded) : loaded;
    void decoded.then(() => {
      if (cancelled || performance.now() >= deadline || document.visibilityState !== 'visible') return;
      setExpiredIdentity('');
      setFrame({ identity, row, deadline });
      expiry = setTimeout(() => { if (!cancelled) { setFrame(null); setExpiredIdentity(identity); } }, Math.max(0, deadline - performance.now()));
    }).catch(() => { if (!cancelled) setFrame(null); });
    return () => { cancelled = true; clearTimeout(expiry); image.onload = null; image.onerror = null; };
  }, [identity, row, deadline]);
  // A new image candidate never extends the previous decoded image's expiry.
  useEffect(() => {
    if (!frame) return undefined;
    const timer = setTimeout(() => {
      setFrame(current => current === frame ? null : current);
      setExpiredIdentity(frame.identity);
    }, Math.max(0, frame.deadline - performance.now()));
    return () => clearTimeout(timer);
  }, [frame]);
  return { frame: preview.row && frame?.identity === identity ? frame : null, expired: expiredIdentity === identity };
}
