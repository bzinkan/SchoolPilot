// Imported by App before BrowserRouter installs its listener, so a private draft
// can pause a history traversal before the route unmounts its editor.
const guards = [];
if (typeof window !== 'undefined') window.addEventListener('popstate', event => guards.at(-1)?.(event), true);

export function guardPrivateWorkspaceHistory(onAttempt) {
  const currentUrl = window.location.href;
  const currentState = window.history.state;
  let restoring = false;
  const guard = event => {
    if (restoring) { restoring = false; event.stopImmediatePropagation(); return; }
    if (window.location.href === currentUrl) return;
    const destination = `${window.location.pathname}${window.location.search}${window.location.hash}`;
    event.stopImmediatePropagation();
    const delta = Number(currentState?.idx) - Number(event.state?.idx);
    if (Number.isFinite(delta) && delta) { restoring = true; window.history.go(delta); }
    else window.history.pushState(currentState, '', currentUrl);
    onAttempt(destination);
  };
  guards.push(guard);
  return () => { const index = guards.indexOf(guard); if (index >= 0) guards.splice(index, 1); };
}
