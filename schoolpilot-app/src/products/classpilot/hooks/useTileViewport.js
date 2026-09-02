import { useCallback, useEffect, useRef, useState } from 'react';

// Exit hysteresis: a tile that leaves the (already viewport-sized) enter margin
// keeps polling for this long, so a scroll-direction reversal does not thrash
// viewport-scoped polling on and off.
export const TILE_VIEWPORT_EXIT_GRACE_MS = 2_000;

export function useTileViewport({ exitGraceMs = TILE_VIEWPORT_EXIT_GRACE_MS } = {}) {
  const supported = typeof window !== 'undefined' && typeof window.IntersectionObserver === 'function';
  const observerRef = useRef(null);
  const elementsRef = useRef(new Map());
  const callbacksRef = useRef(new Map());
  const exitTimersRef = useRef(new Map());
  const [nearViewportStudentIds, setNearViewportStudentIds] = useState(() => new Set());
  // Until the observer delivers its first intersection batch, no tile is known
  // to be offscreen. Tracking reports itself inactive so callers poll every
  // cohort instead of gating first-paint polling on an empty set.
  const [settled, setSettled] = useState(false);

  const clearExitTimer = useCallback((studentId) => {
    const timer = exitTimersRef.current.get(studentId);
    if (timer === undefined) return;
    clearTimeout(timer);
    exitTimersRef.current.delete(studentId);
  }, []);

  const removeStudent = useCallback((studentId) => {
    setNearViewportStudentIds((current) => {
      if (!current.has(studentId)) return current;
      const next = new Set(current);
      next.delete(studentId);
      return next;
    });
  }, []);

  useEffect(() => {
    if (!supported) return undefined;
    const exitTimers = exitTimersRef.current;
    const observer = new window.IntersectionObserver((entries) => {
      const entering = [];
      const leaving = [];
      for (const entry of entries) {
        const studentId = entry.target.dataset.studentViewportId;
        if (!studentId) continue;
        if (entry.isIntersecting) {
          clearExitTimer(studentId);
          entering.push(studentId);
        } else {
          leaving.push(studentId);
        }
      }
      if (entering.length > 0) {
        setNearViewportStudentIds((current) => {
          let next = current;
          for (const studentId of entering) {
            if (current.has(studentId)) continue;
            if (next === current) next = new Set(current);
            next.add(studentId);
          }
          return next;
        });
      }
      for (const studentId of leaving) {
        if (exitTimers.has(studentId)) continue;
        if (exitGraceMs <= 0) {
          removeStudent(studentId);
          continue;
        }
        exitTimers.set(studentId, setTimeout(() => {
          exitTimers.delete(studentId);
          removeStudent(studentId);
        }, exitGraceMs));
      }
      setSettled(true);
    }, { rootMargin: '100% 0px', threshold: 0 });
    observerRef.current = observer;
    for (const element of elementsRef.current.values()) observer.observe(element);
    return () => {
      observer.disconnect();
      observerRef.current = null;
      for (const timer of exitTimers.values()) clearTimeout(timer);
      exitTimers.clear();
    };
  }, [clearExitTimer, exitGraceMs, removeStudent, supported]);

  const getTileRef = useCallback((studentId) => {
    if (!callbacksRef.current.has(studentId)) {
      callbacksRef.current.set(studentId, (element) => {
        const previous = elementsRef.current.get(studentId);
        if (previous && previous !== element) observerRef.current?.unobserve(previous);
        if (!element) {
          // An unmounted tile cannot be near the viewport; skip the grace.
          elementsRef.current.delete(studentId);
          clearExitTimer(studentId);
          removeStudent(studentId);
          return;
        }
        element.dataset.studentViewportId = studentId;
        elementsRef.current.set(studentId, element);
        observerRef.current?.observe(element);
      });
    }
    return callbacksRef.current.get(studentId);
  }, [clearExitTimer, removeStudent]);

  return {
    supported,
    // True only once the observer has reported; the polling gate in
    // tileBatchPolling treats `false` as "poll every cohort".
    tracking: supported && settled,
    nearViewportStudentIds,
    getTileRef,
  };
}
