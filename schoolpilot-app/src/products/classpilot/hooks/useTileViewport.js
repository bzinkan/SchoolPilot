import { useCallback, useEffect, useRef, useState } from 'react';

export function useTileViewport() {
  const supported = typeof window !== 'undefined' && typeof window.IntersectionObserver === 'function';
  const observerRef = useRef(null);
  const elementsRef = useRef(new Map());
  const callbacksRef = useRef(new Map());
  const [nearViewportStudentIds, setNearViewportStudentIds] = useState(() => new Set());

  useEffect(() => {
    if (!supported) return undefined;
    const observer = new window.IntersectionObserver((entries) => {
      setNearViewportStudentIds((current) => {
        let next = current;
        for (const entry of entries) {
          const studentId = entry.target.dataset.studentViewportId;
          if (!studentId) continue;
          const shouldInclude = entry.isIntersecting;
          if (current.has(studentId) === shouldInclude) continue;
          if (next === current) next = new Set(current);
          if (shouldInclude) next.add(studentId);
          else next.delete(studentId);
        }
        return next;
      });
    }, { rootMargin: '100% 0px', threshold: 0 });
    observerRef.current = observer;
    for (const element of elementsRef.current.values()) observer.observe(element);
    return () => {
      observer.disconnect();
      observerRef.current = null;
    };
  }, [supported]);

  const getTileRef = useCallback((studentId) => {
    if (!callbacksRef.current.has(studentId)) {
      callbacksRef.current.set(studentId, (element) => {
        const previous = elementsRef.current.get(studentId);
        if (previous && previous !== element) observerRef.current?.unobserve(previous);
        if (!element) {
          elementsRef.current.delete(studentId);
          setNearViewportStudentIds((current) => {
            if (!current.has(studentId)) return current;
            const next = new Set(current);
            next.delete(studentId);
            return next;
          });
          return;
        }
        element.dataset.studentViewportId = studentId;
        elementsRef.current.set(studentId, element);
        observerRef.current?.observe(element);
      });
    }
    return callbacksRef.current.get(studentId);
  }, []);

  return { supported, nearViewportStudentIds, getTileRef };
}
