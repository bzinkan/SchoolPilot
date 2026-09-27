import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { AdminNavigationContext } from '../../hooks/useAdminNavigation';
import { registerAdminHistoryGuard } from '../../lib/adminNavigationHistory';
import { AlertDialog, AlertDialogContent, AlertDialogHeader, AlertDialogTitle, AlertDialogDescription,
  AlertDialogFooter, AlertDialogCancel, AlertDialogAction } from '../../../../components/ui/alert-dialog';

function targetLocation(to, options, current) {
  if (typeof to === 'number') throw new Error('Use a fixed destination for guarded navigation. Browser history is guarded separately.');
  const path = typeof to === 'string' ? to : to.pathname || current.pathname;
  if ((!path.startsWith('/') && !path.startsWith('?') && !path.startsWith('#')) || path.startsWith('//')) {
    throw new Error('Admin navigation requires an internal destination.');
  }
  const url = new URL(path, `https://navigation.invalid${current.pathname}${current.search}${current.hash}`);
  const prefix = (value, marker) => value ? (value.startsWith(marker) ? value : marker + value) : '';
  const destination = typeof to === 'string' ? { pathname: url.pathname, search: url.search, hash: url.hash }
    : { pathname: url.pathname, search: prefix(to.search, '?'), hash: prefix(to.hash, '#') };
  return { ...destination, state: options?.state ?? (typeof to === 'object' ? to.state : null) ?? null };
}

export default function AdminNavigationProvider({ scopeKey, children }) {
  const location = useLocation();
  const routeNavigate = useNavigate();
  const owners = useRef(new Map());
  const current = useRef({ location, index: typeof window !== 'undefined' ? window.history.state?.idx : null });
  const alive = useRef(true);
  const pendingRef = useRef(null);
  const replay = useRef(new WeakSet());
  const [pending, setPending] = useState(null);
  const [notice, setNotice] = useState('');
  const [submitting, setSubmitting] = useState(false);
  useLayoutEffect(() => { current.current = { location, index: window.history.state?.idx }; }, [location]);

  const blockers = useCallback((transition, exempt) => [...owners.current.entries()].filter(([owner, read]) => {
    const value = read();
    return owner !== exempt && (value.dirty || value.busy) && (!value.shouldBlock || value.shouldBlock(transition));
  }), []);
  const register = useCallback((owner, read) => {
    owners.current.set(owner, read);
    return () => owners.current.delete(owner);
  }, []);
  const execute = useCallback(async action => {
    if (!alive.current) return false;
    return (await action()) !== false;
  }, []);
  const request = useCallback((transition, action, exempt) => {
    if (!alive.current || (exempt && !owners.current.has(exempt)) || pendingRef.current) return Promise.resolve(false);
    const affected = blockers(transition, exempt);
    if (affected.some(([, read]) => read().busy)) {
      setNotice('Wait for the current operation to finish before leaving.');
      return Promise.resolve(false);
    }
    setNotice('');
    if (!affected.length) return execute(action);
    return new Promise((resolve, reject) => {
      const next = { transition, action, exempt, affected, resolve, reject };
      pendingRef.current = next;
      setPending(next);
    });
  }, [blockers, execute]);
  const navigate = useCallback((to, options, exempt) => {
    const nextLocation = targetLocation(to, options, current.current.location);
    return request({ kind: 'navigate', currentLocation: current.current.location, nextLocation },
      () => routeNavigate(nextLocation, { ...options, state: nextLocation.state }), exempt);
  }, [request, routeNavigate]);
  const requestAction = useCallback((action, options = {}, exempt) => request({ kind: 'action',
    currentLocation: current.current.location,
    nextLocation: options.nextLocation ? targetLocation(options.nextLocation, options, current.current.location) : null,
    actionId: options.id }, action, exempt), [request]);
  const afterCommit = useCallback((owner, kind, value, options) => kind === 'navigate'
    ? navigate(value, options, owner) : requestAction(value, options, owner), [navigate, requestAction]);

  const stay = useCallback(() => {
    const attempt = pendingRef.current;
    pendingRef.current = null;
    setPending(null);
    attempt?.resolve(false);
  }, []);
  const leave = async () => {
    const attempt = pendingRef.current;
    if (!attempt || submitting) return;
    if (attempt.exempt && !owners.current.has(attempt.exempt)) { stay(); return; }
    setSubmitting(true);
    try {
      if (blockers(attempt.transition, attempt.exempt).some(([, read]) => read().busy)) {
        setNotice('Wait for the current operation to finish before leaving.'); stay(); return;
      }
      for (const [owner, read] of attempt.affected) {
        if (!owners.current.has(owner)) continue;
        if (await read().onDiscard?.(attempt.transition) === false) { stay(); return; }
        if (!alive.current || pendingRef.current !== attempt) return;
      }
    } catch {
      setNotice('Your changes are still here. Resolve the unfinished operation before leaving.');
      stay(); return;
    } finally {
      if (alive.current) setSubmitting(false);
    }
    if (!alive.current || pendingRef.current !== attempt) return;
    if (attempt.exempt && !owners.current.has(attempt.exempt)) { stay(); return; }
    pendingRef.current = null;
    setPending(null);
    try { attempt.resolve(await execute(attempt.action)); }
    catch (error) { attempt.reject(error); }
  };

  useLayoutEffect(() => {
    alive.current = true;
    const release = registerAdminHistoryGuard({
      current: () => current.current,
      shouldBlock: transition => Boolean(pendingRef.current || blockers(transition).length),
      attempt: (transition, controls) => {
        void controls.restored.then(async () => {
          if (!alive.current) { await controls.cancel(); return; }
          try {
            const accepted = await request(transition, controls.resume);
            if (!accepted) await controls.cancel();
          } catch { await controls.cancel(); }
        });
      },
    });
    const unload = event => {
      if (![...owners.current.values()].some(read => read().dirty || read().busy)) return;
      event.preventDefault(); event.returnValue = '';
    };
    const click = event => {
      const anchor = event.target.closest?.('a[href]');
      if (!anchor || event.defaultPrevented || event.button !== 0 || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey
        || (anchor.target && anchor.target !== '_self') || anchor.hasAttribute('download')) return;
      if (replay.current.has(anchor)) { replay.current.delete(anchor); return; }
      const url = new URL(anchor.href, window.location.href);
      if (url.origin !== window.location.origin || !['http:', 'https:'].includes(url.protocol) || url.href === window.location.href) return;
      const transition = { kind: 'navigate', currentLocation: current.current.location,
        nextLocation: { pathname: url.pathname, search: url.search, hash: url.hash, state: null } };
      if (!blockers(transition).length) return;
      event.preventDefault(); event.stopPropagation();
      // Replay the original Link so its state and event behavior survive a
      // confirmation. Print, download and new-tab gestures never enter here.
      void request(transition, () => { replay.current.add(anchor); anchor.click(); });
    };
    window.addEventListener('beforeunload', unload);
    document.addEventListener('click', click, true);
    return () => {
      alive.current = false;
      release();
      window.removeEventListener('beforeunload', unload);
      document.removeEventListener('click', click, true);
      pendingRef.current?.resolve(false);
      pendingRef.current = null;
    };
  }, [blockers, request]);

  const value = useMemo(() => ({ shell: { scopeKey }, navigation: { navigate, requestAction }, register, afterCommit }),
    [scopeKey, navigate, requestAction, register, afterCommit]);
  return <AdminNavigationContext.Provider value={value}>
    {notice && <p role="status" className="border-b border-amber-200 bg-amber-50 px-5 py-3 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-100">{notice}</p>}
    {children}
    <AlertDialog open={Boolean(pending)} onOpenChange={open => { if (!open && !submitting) stay(); }}>
      <AlertDialogContent onEscapeKeyDown={event => { if (submitting) event.preventDefault(); }}>
        <AlertDialogHeader><AlertDialogTitle>Leave with unsaved changes?</AlertDialogTitle>
          <AlertDialogDescription>{pending?.affected.map(([, read]) => read().description).filter(Boolean).join(' ') || 'Save your work first to keep these changes. Your previously saved work will remain.'}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter><AlertDialogCancel disabled={submitting}>Keep editing</AlertDialogCancel>
          <AlertDialogAction disabled={submitting} onClick={event => { event.preventDefault(); void leave(); }}>{submitting ? 'Leaving…' : 'Discard changes and leave'}</AlertDialogAction></AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  </AdminNavigationContext.Provider>;
}
