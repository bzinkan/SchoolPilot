import { performance } from 'node:perf_hooks';

// Observation/cleanup budget only. It does not extend any request, checkout,
// statement or worker acceptance limit, or cancel/release an owner on expiry.
export const RELEASE_SERVER_DRAIN_MS = 20_000;
export const RELEASE_DRAIN_OPERATIONS = Object.freeze([
  'auth', 'heartbeat_persistence', 'heartbeat_final_delivery', 'heartbeat_background',
  'api_limiter', 'heartbeat_middleware', 'heartbeat_handler', 'usage_report_admission',
  'usage_report', 'usage_worker', 'tenant_request', 'tenant_background', 'unclassified',
]);
const number = value => Number.isSafeInteger(value) && value >= 0;
export function releaseDrainGauges(snapshot) {
  const operations = snapshot?.operations?.operations, pools = snapshot?.database?.pools;
  if (snapshot?.operations?.schemaVersion !== 2 || !operations
    || Object.keys(operations).length !== RELEASE_DRAIN_OPERATIONS.length
    || !RELEASE_DRAIN_OPERATIONS.every(name => operations[name]) || !pools || !Object.keys(pools).length) return null;
  const sum = (rows, key) => rows.every(row => number(row?.[key])) ? rows.reduce((total, row) => total + row[key], 0) : NaN;
  const gauges = {
    activeOperations: sum(Object.values(operations), 'activeOperations'),
    pendingCheckouts: sum(Object.values(operations), 'pendingCheckouts'),
    activeCheckouts: sum(Object.values(operations), 'activeCheckouts'),
    pendingAcquisitions: snapshot.database.pendingAcquisitions,
    activeQueries: snapshot.database.activeQueries,
    poolWaiting: sum(Object.values(pools), 'waiting'),
    poolHeld: sum(Object.values(pools), 'held'),
    httpResponses: snapshot.http?.activeResponses,
    pendingTenantReleases: snapshot.tenantReleases?.pending,
  };
  return Object.values(gauges).every(number) ? gauges : null;
}
export const releaseServerIsIdle = snapshot => {
  const gauges = releaseDrainGauges(snapshot);
  return gauges !== null && Object.values(gauges).every(value => value === 0);
};

/** Wait for actual owners; HTTP finish is only one supplemental gauge. */
export async function drainReleaseServer({ snapshot, drainClassification, drainWebSocket, drainTenantReleases,
  budgetMs = RELEASE_SERVER_DRAIN_MS, now = () => performance.now(),
  yieldTurn = () => new Promise(resolve => setImmediate(resolve)),
  pause = () => new Promise(resolve => setTimeout(resolve, 10)),
}) {
  const started = now(), deadline = started + budgetMs;
  let passes = 0, stage = 'start';
  const receipt = (complete, failure) => ({ complete, budgetMs, elapsedMs: now() - started, passes,
    gauges: releaseDrainGauges(snapshot()), physicallyIdle: releaseServerIsIdle(snapshot()),
    abortedResponses: snapshot().http?.abortedResponses ?? null, ...(failure ? { failure, stage } : {}) });
  const bounded = async action => {
    const remaining = deadline - now();
    if (remaining <= 0) return false;
    let timer;
    try {
      // Timeout observes failure only: the original promise remains owned and
      // keeps its gauges until its work and cleanup actually settle.
      return await Promise.race([
        Promise.resolve().then(action).then(() => true),
        new Promise(resolve => { timer = setTimeout(() => resolve(false), remaining); }),
      ]);
    } finally { clearTimeout(timer); }
  };
  try {
    let emptyPasses = 0;
    while (now() < deadline) {
      for (const [name, action] of [['classification', drainClassification], ['websocket', drainWebSocket], ['tenant_release', drainTenantReleases]]) {
        stage = name;
        if (!await bounded(action)) return receipt(false, 'DRAIN_DEADLINE');
      }
      passes++;
      if (releaseServerIsIdle(snapshot())) emptyPasses++; else emptyPasses = 0;
      if (emptyPasses === 2 && now() < deadline) {
        stage = 'verification';
        // Physical quiescence cannot prove callback-owned pre-handler work
        // ended after a client abort. Never erase that uncertainty at reset.
        if (snapshot().http?.abortedResponses !== 0) return receipt(false, 'DRAIN_UNVERIFIABLE_ABORT');
        return receipt(true);
      }
      stage = 'yield';
      if (!await bounded(emptyPasses ? yieldTurn : pause)) return receipt(false, 'DRAIN_DEADLINE');
    }
    return receipt(false, 'DRAIN_DEADLINE');
  } catch {
    return receipt(false, 'DRAIN_OPERATION_FAILED');
  }
}
