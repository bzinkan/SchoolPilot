import assert from "node:assert/strict";
import { test } from "node:test";
import { drainService } from "../src/services/serviceShutdown.js";
import { ClasspilotLifecyclePushExecutor } from "../src/services/classpilotLifecyclePushes.js";

test("shutdown lets the last producer enqueue, drains its push and monitor, then closes pools", async () => {
  const events: string[] = [];
  const executor = new ClasspilotLifecyclePushExecutor();
  const result = await drainService({
    stopIntake() { events.push("stop"); },
    async drainProducers() {
      events.push("producer");
      void executor.enqueue(async () => { await Promise.resolve(); events.push("push"); });
    },
    sealBackground() { events.push("seal"); executor.stopAccepting(); },
    drainBackground: () => executor.flush(),
    cancelBackground() { assert.fail("clean shutdown cancelled work"); },
    async disposeMonitor() { await Promise.resolve(); events.push("monitor"); },
    stopMetrics() { events.push("metrics"); },
    pools: [{ name: "main", pool: { totalCount: 0, idleCount: 0, waitingCount: 0, async end() { events.push("pool"); } } }],
    snapshot: () => executor.snapshot(),
    report() {},
  });
  assert.deepEqual(result, { completed: true, timedOut: false });
  assert.ok(events.indexOf("producer") < events.indexOf("seal"));
  assert.ok(events.indexOf("push") < events.indexOf("monitor"));
  assert.ok(events.indexOf("monitor") < events.indexOf("pool"));
  assert.ok(events.indexOf("metrics") < events.indexOf("pool"));
});

test("deadline cancels pending pushes and identifies the outstanding named pool", async () => {
  const reports: Record<string, unknown>[] = [];
  let cancellations = 0;
  const start = performance.now();
  const result = await drainService({
    stopIntake() {},
    async drainProducers() {},
    sealBackground() {},
    drainBackground: () => new Promise(() => {}),
    cancelBackground() { cancellations++; },
    async disposeMonitor() {},
    stopMetrics() {},
    pools: [{ name: "main", pool: { totalCount: 2, idleCount: 1, waitingCount: 0, end: () => new Promise(() => {}) } }],
    snapshot: () => ({ active: 1 }),
    timeoutMs: 120,
    cleanupReserveMs: 60,
    report(event) { reports.push(event); },
  });
  assert.deepEqual(result, { completed: false, timedOut: true });
  assert.equal(cancellations, 1);
  assert.ok(performance.now() - start < 1_000, "one deadline bounds all phases");
  const poolTimeout = reports.find((event) => event.event === "shutdown_phase_timeout" && event.phase === "database_pools");
  assert.deepEqual(poolTimeout?.pools, [{ name: "main", ended: false, total: 2, idle: 1, waiting: 0 }]);
});

test("a rejected producer still seals/cancels background work and reports incomplete shutdown", async () => {
  const events: string[] = [];
  const result = await drainService({
    stopIntake() {},
    async drainProducers() { throw new Error("producer rejected"); },
    sealBackground() { events.push("seal"); },
    async drainBackground() {},
    cancelBackground() { events.push("cancel"); },
    async disposeMonitor() {},
    stopMetrics() {},
    pools: [], snapshot: () => ({}), report() {},
  });
  assert.deepEqual(result, { completed: false, timedOut: false });
  assert.deepEqual(events, ["seal", "cancel"]);
});
