import { useCallback, useLayoutEffect, useRef, useState } from 'react';

const EMPTY_FRAMES = Object.freeze({ current: null, previous: null });

function pruneFrames(state, privacyKey) {
  if (state.current?.privacyKey === privacyKey) return state;
  return EMPTY_FRAMES;
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

    const displayed = framesRef.current.current;
    if (displayed?.privacyKey === privacyKey && displayed.src === src) {
      // Same pixels, possibly newer metadata: no decode, no frame swap.
      queueMicrotask(() => {
        if (!isCurrent()) return;
        setFrames((state) => (
          state.current?.privacyKey === privacyKey
            && state.current.src === src
            && state.current.screenshotData !== screenshotData
            ? { ...state, current: { ...state.current, screenshotData } }
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
      sequenceRef.current += 1;
      const frame = { privacyKey, src, screenshotData, sequence: sequenceRef.current };
      setFrames((state) => ({
        current: frame,
        previous: crossfade && state.current?.privacyKey === privacyKey
          ? state.current
          : null,
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

  const releasePreviousFrame = useCallback(() => {
    setFrames((state) => (state.previous ? { ...state, previous: null } : state));
  }, []);

  const frame = frames.current?.privacyKey === privacyKey ? frames.current : null;
  const previousFrame = frame && crossfade && frames.previous?.privacyKey === privacyKey
    ? frames.previous
    : null;
  return { frame, previousFrame, releasePreviousFrame };
}
