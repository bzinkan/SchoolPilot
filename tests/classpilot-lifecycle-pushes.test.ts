import assert from "node:assert/strict";
import { test } from "node:test";
import { ClasspilotLifecyclePushExecutor, runClasspilotLifecyclePushPhases } from "../src/services/classpilotLifecyclePushes.js";
import { getTenantStore, tenantALS, type TenantStore } from "../src/db/tenantContext.js";

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

test("lifecycle pushes admit one active and exactly 256 waiting, then defer without throwing", async () => {
  const executor = new ClasspilotLifecyclePushExecutor();
  const first = gate();
  let active = 0;
  let maximum = 0;
  const order: number[] = [];
  const pending = Array.from({ length: 257 }, (_, index) => executor.enqueue(async () => {
    maximum = Math.max(maximum, ++active);
    if (!index) await first.promise;
    order.push(index);
    active--;
  }));
  assert.equal(executor.snapshot().active, 1);
  assert.equal(executor.snapshot().waiting, 256);
  assert.deepEqual(await executor.enqueue(async () => assert.fail("overflow executed")), { status: "deferred", reason: "queue_full", recovery: "reconciliation_deferred" });
  first.resolve();
  assert.ok((await Promise.all(pending)).every((outcome) => outcome.status === "completed"));
  await executor.flush();
  assert.equal(maximum, 1);
  assert.deepEqual(order, Array.from({ length: 257 }, (_, index) => index));
});

test("queued work leaves the enqueuing tenant context and failure does not poison later jobs", async () => {
  const executor = new ClasspilotLifecyclePushExecutor();
  const first = gate();
  const pending = executor.enqueue(async () => first.promise);
  // Deliberately supply only the sentinel: the executor must never inspect or
  // use the request's client/db, which can be released before this job starts.
  const capturedStore = { schoolId: "request-school" } as TenantStore;
  const queued = tenantALS.run(capturedStore, () => executor.enqueue(async () => {
    assert.equal(getTenantStore(), undefined);
    throw new Error("simulated DB failure");
  }));
  const next = executor.enqueue(async () => assert.equal(getTenantStore(), undefined));
  first.resolve();
  assert.deepEqual(await pending, { status: "completed" });
  assert.deepEqual(await queued, { status: "failed", recovery: "reconciliation_deferred" });
  assert.deepEqual(await next, { status: "completed" });
  assert.equal(executor.snapshot().failed, 1);
});

test("normal sealing drains accepted jobs; deadline cancellation never starts waiting work", async () => {
  const executor = new ClasspilotLifecyclePushExecutor();
  const first = gate();
  let signal: AbortSignal | undefined;
  const active = executor.enqueue(async (current) => { signal = current; await first.promise; });
  const waiting = executor.enqueue(async () => assert.fail("cancelled job started"));
  let flushed = false;
  const flush = executor.flush().then(() => { flushed = true; });
  executor.stopAccepting();
  assert.deepEqual(await executor.enqueue(async () => {}), { status: "deferred", reason: "shutdown", recovery: "reconciliation_deferred" });
  assert.equal(flushed, false);
  executor.cancelPending();
  assert.equal(signal?.aborted, true);
  assert.deepEqual(await waiting, { status: "deferred", reason: "shutdown", recovery: "reconciliation_deferred" });
  assert.equal(flushed, false, "active operation still owns its resources");
  first.resolve();
  assert.deepEqual(await active, { status: "deferred", reason: "shutdown", recovery: "reconciliation_deferred" });
  await flush;
  assert.equal(flushed, true);
});

test("normal stopAccepting preserves pending jobs and flush observes all accepted work", async () => {
  const executor = new ClasspilotLifecyclePushExecutor();
  const first = gate();
  let calls = 0;
  const pending = executor.enqueue(async () => { await first.promise; calls++; });
  const queued = executor.enqueue(async () => { calls++; });
  executor.stopAccepting();
  const flush = executor.flush();
  first.resolve();
  await Promise.all([pending, queued, flush]);
  assert.equal(calls, 2);
});

test("clear failure does not suppress restore or fresh FAB, while abort prevents another phase", async () => {
  const order: string[] = [];
  const controller = new AbortController();
  await assert.rejects(runClasspilotLifecyclePushPhases(controller.signal, [
    { phase: "clear", async run() { order.push("clear"); throw new Error("injected clear failure"); } },
    { phase: "restore", async run() { order.push("restore"); } },
    { phase: "fab", async run() { order.push("fab"); } },
  ]), AggregateError);
  assert.deepEqual(order, ["clear", "restore", "fab"]);
  await runClasspilotLifecyclePushPhases(controller.signal, [
    { phase: "clear", async run() { controller.abort(); } },
    { phase: "fab", async run() { assert.fail("phase started after deadline cancellation"); } },
  ]);
});
