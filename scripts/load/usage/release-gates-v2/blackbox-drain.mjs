const count = value => Number.isSafeInteger(value) && value >= 0;

export function blackboxPhysicallyIdle(state) {
  return count(state?.aborted) && count(state?.responses) && state.responses === 0
    && count(state?.tenantReleases?.pending) && state.tenantReleases.pending === 0
    && Array.isArray(state?.pools) && state.pools.length === 2
    && state.pools.every(pool => count(pool?.waiting) && pool.waiting === 0 && count(pool?.held) && pool.held === 0);
}

// Teardown can settle after a failed workload. Historical response aborts
// remain a failed capacity/drain observation and cannot be erased at reset.
export async function drainBlackboxServer({ snapshot, drainBackground, pause, now = () => Date.now(), budgetMs = 20_000 }) {
  const deadline = now() + budgetMs; let idle = 0, state;
  const receipt = (physicallySettled, failure) => ({ physicallySettled,
    complete: physicallySettled && count(state?.aborted) && state.aborted === 0,
    snapshot: state ?? null, abortedResponses: count(state?.aborted) ? state.aborted : null,
    ownershipCoverage: 'common runtime producers, WebSocket work when exported, tenant releases, pool and response gauges',
    preHandlerCallbackCompletionClaimed: false, ...(failure ? { failure } : {}) });
  try {
    while (now() < deadline) {
      await drainBackground();
      state = snapshot();
      if (now() >= deadline) return receipt(false, 'DRAIN_DEADLINE');
      if (blackboxPhysicallyIdle(state)) idle++; else idle = 0;
      if (idle >= 2) return receipt(true, state.aborted === 0 ? undefined : 'DRAIN_UNVERIFIABLE_ABORT');
      await pause(25);
    }
    return receipt(false, 'DRAIN_DEADLINE');
  } catch {
    return receipt(false, 'DRAIN_OPERATION_FAILED');
  }
}
