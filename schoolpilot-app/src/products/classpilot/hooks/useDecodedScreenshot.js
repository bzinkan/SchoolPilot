import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  SCREENSHOT_RECONNECT_RETAIN_MS,
  normalizeObservedAtForDisplay,
} from '../lib/studentMonitoringDisplay';

const EMPTY_FRAMES = Object.freeze({ current: null, previous: null, withheldKey: null });

function pruneFrames(state, privacyKey) {
  if (state.current?.privacyKey === privacyKey) return state;
  // A refusal recorded under this same key is itself a display decision. Keep it
  // so a re-run of the decode effect cannot quietly reopen an expired frame.
  if (state.current === null && state.withheldKey === privacyKey) return state;
  return EMPTY_FRAMES;
}

// Nothing is displayable for this key: any committed frame is dropped and the
// refusal is recorded, so the caller can fall back instead of painting pixels
// that have outlived their retention window.
function withholdFrames(state, privacyKey) {
  if (state.current === null && state.withheldKey === privacyKey) return state;
  return { current: null, previous: null, withheldKey: privacyKey };
}

// Retention travels with the frame: its pixels may be painted only until
// `observedAt + SCREENSHOT_RECONNECT_RETAIN_MS`. A capture time that cannot be
// read carries no bound at all, so it yields null and those pixels are never
// displayed — an unreadable stamp must not buy unbounded display.
function frameRetentionExpiryMs(screenshotData, nowMs) {
  const observedAtMs = normalizeObservedAtForDisplay(
    screenshotData?.timestamp ?? screenshotData?.capturedAt ?? screenshotData?.observedAt,
    nowMs,
  );
  return observedAtMs === null ? null : observedAtMs + SCREENSHOT_RECONNECT_RETAIN_MS;
}

// Decodes each candidate screenshot off-screen and exposes a frame only once
// its pixels are fully decoded, so a tile or viewer never paints a partially
// loaded image and can swap frames atomically.
//
// Privacy: frames are keyed by `privacyKey`. A key change hides every prior
// frame at render time (fail closed) and clears its payload in a microtask; an
// empty candidate clears the frames the same way. A same-context decode
// failure leaves the prior frame intact — its own capture timestamp still
// drives freshness, so a corrupt replacement can neither make old pixels look
// new nor extend their retention window.
//
// Retention is self-enforcing and runs on the real clock, not on a caller's
// `nowMs` prop: every committed frame schedules its own expiry, so a wall whose
// clock stopped ticking (hidden tab, throttled timer, disabled query, a memo
// that suppresses prop-driven renders) still loses the frame on time. Expiry
// lands in this hook's own state, so the consumer rerenders through React.memo
// and falls back to its unavailable card. `expired` reports that the caller's
// candidate pixels exist but are refused.
//
// With `crossfade`, the frame that was on screen is kept as `previousFrame`
// until the caller releases it (after the incoming frame has faded in). Each
// frame carries a monotonic `sequence` so a caller can key the element it
// paints and restart the fade exactly once per new frame.
export function useDecodedScreenshot(screenshotData, privacyKey, { crossfade = false } = {}) {
  const [frames, setFrames] = useState(EMPTY_FRAMES);
  const framesRef = useRef(frames);
  const generationRef = useRef(0);
  const sequenceRef = useRef(0);
  const src = typeof screenshotData?.screenshot === 'string'
    ? screenshotData.screenshot
    : '';

  // Declared first so the committed frames are readable by the decode effect
  // below on the same commit, without touching a ref during render.
  useLayoutEffect(() => {
    framesRef.current = frames;
  });

  useLayoutEffect(() => {
    const generation = generationRef.current + 1;
    generationRef.current = generation;
    let cancelled = false;
    const isCurrent = () => !cancelled && generationRef.current === generation;
    // Render gates prior frames immediately; clear their in-memory payload in
    // a microtask so this effect does not synchronously cascade renders.
    queueMicrotask(() => {
      if (isCurrent()) setFrames((state) => pruneFrames(state, privacyKey));
    });
    if (!src) {
      // No candidate pixels: drop both buffers rather than keeping the last
      // frame alive behind an empty response.
      queueMicrotask(() => {
        if (isCurrent()) setFrames((state) => (state === EMPTY_FRAMES ? state : EMPTY_FRAMES));
      });
      return () => {
        cancelled = true;
      };
    }

    const arrivedAtMs = Date.now();
    const expiresAtMs = frameRetentionExpiryMs(screenshotData, arrivedAtMs);
    if (expiresAtMs === null || expiresAtMs <= arrivedAtMs) {
      // Already past its own bound on arrival (or carrying no readable bound):
      // never decoded, never displayed.
      queueMicrotask(() => {
        if (isCurrent()) setFrames((state) => withholdFrames(state, privacyKey));
      });
      return () => {
        cancelled = true;
      };
    }

    const displayed = framesRef.current.current;
    if (displayed?.privacyKey === privacyKey && displayed.src === src) {
      // Same pixels, possibly newer metadata: no decode, no frame swap. The
      // bound is re-read from that metadata, so a re-capture of an unchanged
      // screen renews retention from its own newer stamp and nothing else can.
      queueMicrotask(() => {
        if (!isCurrent()) return;
        setFrames((state) => (
          state.current?.privacyKey === privacyKey
            && state.current.src === src
            && state.current.screenshotData !== screenshotData
            ? { ...state, current: { ...state.current, screenshotData, expiresAtMs } }
            : state
        ));
      });
      return () => {
        cancelled = true;
      };
    }

    const candidate = new Image();
    const commit = () => {
      if (!isCurrent()) return;
      if (expiresAtMs <= Date.now()) {
        // A decode can resolve long after the candidate arrived (a throttled
        // tab may hold it for minutes). Re-check the bound before painting.
        setFrames((state) => withholdFrames(state, privacyKey));
        return;
      }
      sequenceRef.current += 1;
      const frame = {
        privacyKey,
        src,
        screenshotData,
        sequence: sequenceRef.current,
        expiresAtMs,
      };
      setFrames((state) => ({
        current: frame,
        previous: crossfade && state.current?.privacyKey === privacyKey
          ? state.current
          : null,
        withheldKey: null,
      }));
    };
    const loaded = new Promise((resolve, reject) => {
      candidate.onload = resolve;
      candidate.onerror = reject;
    });
    candidate.src = src;
    const decoded = typeof candidate.decode === 'function'
      ? candidate.decode().catch(() => loaded)
      : loaded;
    void decoded.then(commit).catch(() => {});

    return () => {
      cancelled = true;
      candidate.onload = null;
      candidate.onerror = null;
    };
  }, [crossfade, privacyKey, screenshotData, src]);

  // The committed frame expires itself. The timer is keyed to that frame's own
  // bound, so a newer commit replaces it and unmount clears it; a clock that
  // already jumped past the bound expires on the next tick instead of being
  // scheduled into the past.
  const committedExpiresAtMs = frames.current?.expiresAtMs ?? null;
  useEffect(() => {
    if (committedExpiresAtMs === null) return undefined;
    const timer = setTimeout(() => {
      setFrames((state) => (
        state.current === null || state.current.expiresAtMs !== committedExpiresAtMs
          ? state
          : { current: null, previous: null, withheldKey: state.current.privacyKey }
      ));
    }, Math.max(0, committedExpiresAtMs - Date.now()));
    return () => clearTimeout(timer);
  }, [committedExpiresAtMs]);

  const releasePreviousFrame = useCallback(() => {
    setFrames((state) => (state.previous ? { ...state, previous: null } : state));
  }, []);

  const frame = frames.current?.privacyKey === privacyKey ? frames.current : null;
  const previousFrame = frame && crossfade && frames.previous?.privacyKey === privacyKey
    ? frames.previous
    : null;
  // The caller still holds candidate pixels, but this hook refuses to display
  // them: the frame it committed (or the one that arrived) is past its bound.
  const expired = frames.current === null && frames.withheldKey === privacyKey;
  return { frame, previousFrame, releasePreviousFrame, expired };
}
