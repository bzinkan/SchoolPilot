import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Drag-to-resize for a right-anchored panel. Width is measured from the right
 * edge of the viewport, clamped to [min, viewport * maxFraction], and optionally
 * remembered per browser under `storageKey`.
 */
export function useResizablePanelWidth({ initial = 700, min = 400, maxFraction = 0.9, storageKey = null } = {}) {
  const [width, setWidth] = useState(() => {
    if (storageKey) {
      try {
        const saved = Number(window.localStorage.getItem(storageKey));
        if (Number.isFinite(saved) && saved >= min) return saved;
      } catch {
        // Storage can be unavailable; the default width still works.
      }
    }
    return initial;
  });
  const widthRef = useRef(width);
  widthRef.current = width;
  const resizing = useRef(false);

  const onResizeStart = useCallback((event) => {
    event.preventDefault();
    resizing.current = true;
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'col-resize';
  }, []);

  useEffect(() => {
    const handleMouseMove = (event) => {
      if (!resizing.current) return;
      const maxWidth = window.innerWidth * maxFraction;
      setWidth(Math.max(min, Math.min(maxWidth, window.innerWidth - event.clientX)));
    };
    const handleMouseUp = () => {
      if (!resizing.current) return;
      resizing.current = false;
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
      if (storageKey) {
        try { window.localStorage.setItem(storageKey, String(widthRef.current)); } catch { /* best effort */ }
      }
    };
    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, [maxFraction, min, storageKey]);

  return { width, onResizeStart };
}
