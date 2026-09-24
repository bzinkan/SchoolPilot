import { useEffect } from 'react';

export function useKioskBoundary(activity, refresh) {
  const boundary = activity?.nextBoundaryAt;
  const serverTime = activity?.serverTime;
  useEffect(() => {
    const onFocus = () => { if (document.visibilityState !== 'hidden') refresh(); };
    window.addEventListener('online', refresh);
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onFocus);
    const delay = Date.parse(boundary) - Date.parse(serverTime);
    const timer = Number.isFinite(delay) ? setTimeout(refresh, Math.max(50, Math.min(delay + 50, 86_400_000))) : null;
    return () => {
      if (timer != null) clearTimeout(timer);
      window.removeEventListener('online', refresh);
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onFocus);
    };
  }, [boundary, serverTime, refresh]);
}
