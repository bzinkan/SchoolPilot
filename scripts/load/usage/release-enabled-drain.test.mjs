import assert from 'node:assert/strict';
import test from 'node:test';
import { drainReleaseServer, releaseDrainGauges, releaseServerIsIdle, RELEASE_DRAIN_OPERATIONS } from './release-enabled-drain.mjs';
export const idleReleaseSnapshot = () => ({ operations: { schemaVersion: 2, operations: Object.fromEntries(
  RELEASE_DRAIN_OPERATIONS.map(name => [name, { activeOperations: 0, pendingCheckouts: 0, activeCheckouts: 0 }])) },
  database: { pendingAcquisitions: 0, activeQueries: 0, pools: { api: { waiting: 0, held: 0 } } },
  http: { activeResponses: 0, abortedResponses: 0 }, tenantReleases: { pending: 0 } });
const empty = async () => {};

test('drain observes the complete handler through zero-lease gaps and re-drains late cleanup', async () => {
  const state = idleReleaseSnapshot(), row = state.operations.operations.heartbeat_handler;
  row.activeOperations = 1;
  let time = 0, classificationDrains = 0, releaseDrains = 0;
  const result = await drainReleaseServer({ snapshot: () => state, now: () => time, budgetMs: 10,
    drainClassification: async () => { classificationDrains++; }, drainWebSocket: empty,
    drainTenantReleases: async () => { releaseDrains++; if (state.tenantReleases.pending) { state.tenantReleases.pending = 0; state.database.pools.api.held = 0; } },
    pause: async () => {
      time++;
      if (time === 1) { state.database.pendingAcquisitions = 1; }
      else { state.database.pendingAcquisitions = 0; row.activeOperations = 0; state.tenantReleases.pending = 1; state.database.pools.api.held = 1; }
    }, yieldTurn: async () => { time++; },
  });
  assert.equal(result.complete, true); assert.equal(result.elapsedMs, 3);
  assert.ok(classificationDrains >= 4 && releaseDrains >= 4);
  assert.ok(Object.values(result.gauges).every(value => value === 0));
});

test('a zero snapshot before one turn cannot miss queued follow-up work', async () => {
  const state = idleReleaseSnapshot(); let turn = 0, time = 0;
  const result = await drainReleaseServer({ snapshot: () => state, now: () => time, budgetMs: 10,
    drainClassification: empty, drainWebSocket: empty, drainTenantReleases: empty,
    yieldTurn: async () => { time++; if (!turn++) state.operations.operations.heartbeat_handler.activeOperations = 1; },
    pause: async () => { time++; state.operations.operations.heartbeat_handler.activeOperations = 0; },
  });
  assert.equal(result.complete, true); assert.ok(result.passes >= 4);
});

test('drain timeout cannot release work, discard a pending promise or invent clean gauges', async () => {
  const state = idleReleaseSnapshot(); state.operations.operations.heartbeat_handler.activeOperations = 1;
  let settle; const pending = new Promise(resolve => { settle = resolve; });
  const result = await drainReleaseServer({ snapshot: () => state, budgetMs: 5,
    drainClassification: () => pending, drainWebSocket: empty, drainTenantReleases: empty });
  assert.equal(result.complete, false); assert.equal(result.failure, 'DRAIN_DEADLINE');
  assert.equal(result.gauges.activeOperations, 1);
  assert.equal(state.operations.operations.heartbeat_handler.activeOperations, 1); settle();
});

test('late cleanup failure stays a failure and diagnostics require complete nonnegative gauges', async () => {
  const state = idleReleaseSnapshot();
  const result = await drainReleaseServer({ snapshot: () => state,
    drainClassification: empty, drainWebSocket: empty, drainTenantReleases: async () => { throw new Error('private detail'); } });
  assert.equal(result.complete, false); assert.equal(result.failure, 'DRAIN_OPERATION_FAILED');
  assert.doesNotMatch(JSON.stringify(result), /private detail/);
  for (const mutate of [s => delete s.operations, s => delete s.operations.operations.heartbeat_handler,
    s => delete s.operations.operations.heartbeat_final_delivery,
    s => delete s.operations.operations.user_identity,
    s => s.operations.operations.user_identity.activeOperations = 1,
    s => s.operations.operations.user_identity.pendingCheckouts = 1,
    s => s.operations.operations.user_identity.activeCheckouts = 1,
    s => delete s.database.pendingAcquisitions, s => s.database.pools.api.held = -1,
    s => s.operations.operations.heartbeat_handler.activeOperations = 1,
    s => s.database.pendingAcquisitions = 1, s => s.database.activeQueries = 1,
    s => s.http.activeResponses = 1, s => s.tenantReleases.pending = 1]) {
    const bad = idleReleaseSnapshot(); mutate(bad); assert.equal(releaseServerIsIdle(bad), false);
  }
  assert.equal(releaseDrainGauges(undefined), null);
});


test('aborted or missing response evidence cannot certify preflight even after actual owners drain', async () => {
  for (const aborts of [1, undefined]) {
    const state = idleReleaseSnapshot(); state.http.abortedResponses = aborts;
    state.operations.operations.heartbeat_handler.activeOperations = 1;
    let pauses = 0;
    const result = await drainReleaseServer({ snapshot: () => state,
      drainClassification: empty, drainWebSocket: empty, drainTenantReleases: empty,
      pause: async () => { pauses++; state.operations.operations.heartbeat_handler.activeOperations = 0; },
    });
    assert.equal(pauses, 1, 'await the real handler rather than releasing ownership on abort');
    assert.equal(result.physicallyIdle, true); assert.equal(result.complete, false);
    assert.equal(result.failure, 'DRAIN_UNVERIFIABLE_ABORT');
    assert.equal(result.abortedResponses, aborts ?? null);
  }
});
