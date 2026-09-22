import { useCallback, useEffect, useRef, useState } from 'react';

/** Shared mouse/keyboard resizer, scoped persistence, and viewport clamping. */
export function useResizablePanelWidth({ initial = 700, min = 400, maxFraction = 0.9, storageKey = null, rightOffset = 0 } = {}) {
  const load = () => {
    try { const saved = Number(localStorage.getItem(storageKey)); if (storageKey && Number.isFinite(saved) && saved >= min) return saved; } catch { /* optional */ }
    return initial;
  };
  const [state, setState] = useState(() => ({ key: storageKey, width: load() }));
  if (state.key !== storageKey) setState({ key: storageKey, width: load() });
  const [viewportWidth, setViewportWidth] = useState(() => window.innerWidth);
  const limit = useCallback((value) => Math.max(Math.min(min, window.innerWidth), Math.min(window.innerWidth * maxFraction, value)), [min, maxFraction]);
  const width = Math.max(Math.min(min, viewportWidth), Math.min(viewportWidth * maxFraction, state.width));
  const widthRef = useRef(width);
  widthRef.current = width;
  const resizing = useRef(false);
  const save = useCallback((value) => { if (storageKey) { try { localStorage.setItem(storageKey, String(value)); } catch { /* optional */ } } }, [storageKey]);
  const onResizeStart = useCallback((event) => {
    if (event.button !== 0) return;
    event.preventDefault(); resizing.current = true;
    document.body.style.userSelect = 'none'; document.body.style.cursor = 'col-resize';
  }, []);
  const onResizeKeyDown = useCallback((event) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const next = limit(event.key === 'Home' ? min : event.key === 'End' ? window.innerWidth * maxFraction : widthRef.current + (event.key === 'ArrowLeft' ? 20 : -20));
    setState({ key: storageKey, width: next }); save(next);
  }, [limit, maxFraction, min, save, storageKey]);
  const resetWidth = useCallback(() => { setState({ key: storageKey, width: initial }); save(initial); }, [initial, storageKey, save]);
  useEffect(() => {
    const stop = () => {
      if (!resizing.current) return;
      resizing.current = false; document.body.style.userSelect = ''; document.body.style.cursor = ''; save(widthRef.current);
    };
    const move = (event) => { if (resizing.current) setState({ key: storageKey, width: limit(window.innerWidth - rightOffset - event.clientX) }); };
    const resize = () => setViewportWidth(window.innerWidth);
    document.addEventListener('mousemove', move); document.addEventListener('mouseup', stop); window.addEventListener('blur', stop); window.addEventListener('resize', resize);
    return () => { stop(); document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', stop); window.removeEventListener('blur', stop); window.removeEventListener('resize', resize); };
  }, [limit, rightOffset, save, storageKey]);
  return { width, onResizeStart, onResizeKeyDown, resetWidth };
}
