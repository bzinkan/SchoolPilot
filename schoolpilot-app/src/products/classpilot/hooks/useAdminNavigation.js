import { createContext, useCallback, useContext, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';

export const AdminNavigationContext = createContext(null);

export function useAdminShell() {
  const context = useContext(AdminNavigationContext);
  return context?.shell ?? null;
}

export function useAdminNavigation() {
  const context = useContext(AdminNavigationContext);
  const routeNavigate = useNavigate();
  const navigate = useCallback(async (to, options) => { routeNavigate(to, options); return true; }, [routeNavigate]);
  const requestAction = useCallback(async action => (await action()) !== false, []);
  const fallback = useMemo(() => ({ navigate, requestAction }), [navigate, requestAction]);
  return context?.navigation ?? fallback;
}

export function useAdminNavigationBlocker(descriptor) {
  const context = useContext(AdminNavigationContext);
  const fallback = useAdminNavigation();
  const [owner] = useState(() => Symbol(descriptor.id));
  const latest = useRef(descriptor);
  useLayoutEffect(() => { latest.current = descriptor; });
  const register = context?.register;
  useLayoutEffect(() => register?.(owner, () => latest.current), [register, owner]);
  return useMemo(() => ({
    navigateAfterCommit: (to, options) => context
      ? context.afterCommit(owner, 'navigate', to, options)
      : fallback.navigate(to, options),
    requestActionAfterCommit: (action, options) => context
      ? context.afterCommit(owner, 'action', action, options)
      : fallback.requestAction(action, options),
  }), [context, owner, fallback]);
}
