import { createContext, useContext, useLayoutEffect, useRef, useState } from 'react';
import { useAdminNavigationBlocker } from './useAdminNavigation';

export const settingsError = error => error?.response?.data?.error || error?.message || 'Changes could not be saved.';
export const SettingsAccessContext = createContext(null);
export const settingsAccessDenied = error => [401, 403].includes(error?.response?.status);
export const settingsSectionTransition = ({ kind, currentLocation, nextLocation }) => kind === 'action'
  || currentLocation.pathname !== '/classpilot/settings' || nextLocation?.pathname !== '/classpilot/settings';
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);

// The owning workspace is keyed by school, viewer and access. Async work may
// finish after that owner is gone, but must never update another identity.
export function useSettingsDraft({ id, source, fields, version = 'version', save, refresh, onSaved, shouldBlock = settingsSectionTransition }) {
  const accessLost = useContext(SettingsAccessContext);
  const pick = value => Object.fromEntries(fields.map(field => [field, value?.[field]]));
  const [state, setState] = useState(() => ({ baseline: source, draft: pick(source), seen: source, conflict: null }));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const alive = useRef(true);
  const pending = useRef(false);
  useLayoutEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const dirty = !same(state.draft, pick(state.baseline));
  if (source !== state.seen) {
    const changed = !same(pick(source), pick(state.baseline)) || source?.[version] !== state.baseline?.[version];
    setState(previous => ({ ...previous, seen: source,
      ...(!busy && !dirty ? { baseline: source, draft: pick(source), conflict: null }
        : changed ? { conflict: source } : {}),
    }));
  }
  const update = (field, value) => { setNotice(''); setState(previous => ({ ...previous, draft: { ...previous.draft, [field]: value } })); };
  const discard = () => { setError(''); setNotice(''); setState(previous => {
    const baseline = previous.conflict?.[version] !== undefined ? previous.conflict : previous.baseline;
    return { ...previous, baseline, draft: pick(baseline), conflict: null };
  }); };
  useAdminNavigationBlocker({ id, dirty, busy, shouldBlock, onDiscard: discard });
  const submit = async () => {
    if (pending.current || !dirty || state.conflict) return;
    pending.current = true; setBusy(true); setError(''); setNotice('');
    try {
      const saved = await save(state.draft, state.baseline);
      if (!alive.current) return;
      setState(previous => ({ ...previous, baseline: saved, draft: pick(saved), conflict: null }));
      onSaved?.(saved);
      setNotice('Changes saved.');
    } catch (failure) {
      if (!alive.current) return;
      if (settingsAccessDenied(failure) && accessLost) { accessLost(); return; }
      setError(settingsError(failure));
      if (failure?.response?.status === 409) {
        let current = failure.response.data?.current;
        if (!current && refresh) {
          try { current = await refresh(); } catch (refreshError) { if (alive.current && settingsAccessDenied(refreshError)) { accessLost?.(); return; } }
        }
        if (alive.current) setState(previous => ({ ...previous, conflict: current || {} }));
      }
    } finally {
      pending.current = false;
      if (alive.current) setBusy(false);
    }
  };
  const loadConflict = async () => {
    if (!refresh || pending.current) return;
    pending.current = true; setBusy(true);
    try { const current = await refresh(); if (alive.current) { setState(previous => ({ ...previous, conflict: current })); setError(''); } }
    catch (failure) { if (alive.current) { if (settingsAccessDenied(failure)) accessLost?.(); else setError(settingsError(failure)); } }
    finally { pending.current = false; if (alive.current) setBusy(false); }
  };
  const acceptConflict = keepDraft => {
    if (!state.conflict || state.conflict[version] === undefined) return;
    setState(previous => ({ ...previous, baseline: previous.conflict, draft: keepDraft ? previous.draft : pick(previous.conflict), conflict: null }));
    setError(''); setNotice(keepDraft ? 'Your draft is ready to save against the latest values.' : 'Latest saved values loaded.');
  };
  return { ...state, dirty, busy, error, notice, update, submit, discard, loadConflict, acceptConflict };
}
