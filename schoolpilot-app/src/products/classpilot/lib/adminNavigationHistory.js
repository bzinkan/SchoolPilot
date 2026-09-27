// Imported before BrowserRouter mounts. The route must remain mounted until an
// indexed POP has been restored and the user decides what to do with its draft.
let owner = null;
let traversal = null;

function onPop(event) {
  const index = event.state?.idx;
  if (traversal) {
    const pending = traversal;
    if (pending.resuming && index === pending.targetIndex) {
      traversal = null;
      pending.finished?.(true);
      return;
    }
    if (!pending.resuming && Number.isInteger(index)) {
      event.stopImmediatePropagation();
      if (index === pending.currentIndex) { pending.restored = true; pending.ready(); }
      else window.history.go(pending.currentIndex - index);
      return;
    }
  }
  if (!owner) return;
  const current = owner.current();
  // Never invent or push entries for history not owned by React Router.
  if (!Number.isInteger(index) || !Number.isInteger(current.index) || index === current.index) return;
  const nextLocation = { pathname: window.location.pathname, search: window.location.search,
    hash: window.location.hash, state: event.state?.usr ?? null, key: event.state?.key };
  const transition = { kind: 'history', currentLocation: current.location, nextLocation };
  if (!owner.shouldBlock(transition)) return;
  event.stopImmediatePropagation();
  let ready;
  const restored = new Promise(resolve => { ready = resolve; });
  const pending = { currentIndex: current.index, targetIndex: index, ready, restored: false, resuming: false };
  traversal = pending;
  const controls = {
    restored,
    resume: async () => {
      await restored;
      if (traversal !== pending) return false;
      pending.resuming = true;
      return new Promise(resolve => { pending.finished = resolve; window.history.go(index - current.index); });
    },
    cancel: async () => { await restored; if (traversal === pending) traversal = null; },
  };
  window.history.go(current.index - index);
  owner.attempt(transition, controls);
}

if (typeof window !== 'undefined') window.addEventListener('popstate', onPop, true);

export function registerAdminHistoryGuard(guard) {
  owner = guard;
  return () => {
    if (owner !== guard) return;
    owner = null;
    if (traversal) { traversal.ready(); traversal.finished?.(false); traversal = null; }
  };
}
