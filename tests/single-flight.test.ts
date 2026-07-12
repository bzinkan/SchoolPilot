import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createSingleFlight } from "../src/util/singleFlight.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe("in-flight-only request coalescing", () => {
  it("invokes one loader for overlapping work with the same key", async () => {
    const run = createSingleFlight<string, string>();
    const gate = deferred<string>();
    let calls = 0;
    const work = () => {
      calls += 1;
      return gate.promise;
    };

    const first = run("teacher-1", work);
    const second = run("teacher-1", work);
    assert.equal(calls, 0, "work starts in a microtask so the map is populated first");
    await Promise.resolve();
    assert.equal(calls, 1);
    gate.resolve("allowed");
    assert.deepEqual(await Promise.all([first, second]), ["allowed", "allowed"]);
  });

  it("does not retain successful results after the overlap settles", async () => {
    const run = createSingleFlight<string, number>();
    let calls = 0;
    assert.equal(await run("membership", async () => ++calls), 1);
    assert.equal(await run("membership", async () => ++calls), 2);
    assert.equal(calls, 2);
  });

  it("isolates distinct keys and evicts a rejected overlap", async () => {
    const run = createSingleFlight<string, string>();
    const failure = deferred<string>();
    let failedCalls = 0;
    const first = run("school-a", () => {
      failedCalls += 1;
      return failure.promise;
    });
    const second = run("school-a", () => {
      failedCalls += 1;
      return failure.promise;
    });
    const other = run("school-b", async () => "other");
    await Promise.resolve();
    assert.equal(failedCalls, 1);
    failure.reject(new Error("database unavailable"));
    await assert.rejects(first, /database unavailable/);
    await assert.rejects(second, /database unavailable/);
    assert.equal(await other, "other");

    assert.equal(await run("school-a", async () => "retried"), "retried");
  });

  it("falls back to direct work when the pending-key bound is full", async () => {
    const run = createSingleFlight<string, string>({ maxPendingKeys: 1 });
    const gate = deferred<string>();
    const held = run("held", () => gate.promise);
    let overflowCalls = 0;
    const overflow = await Promise.all([
      run("overflow", async () => `direct-${++overflowCalls}`),
      run("overflow", async () => `direct-${++overflowCalls}`),
    ]);
    assert.deepEqual(overflow.sort(), ["direct-1", "direct-2"]);
    gate.resolve("done");
    assert.equal(await held, "done");
  });
});
