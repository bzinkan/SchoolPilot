import assert from "node:assert/strict";
import { it } from "node:test";
import { RuntimePerformanceMetrics } from "../src/services/runtimePerformanceMetrics.js";
import { observeRuntimeCounterWindow } from "./helpers/runtime-counter-window.js";

it("retains an asserted counter across an actual minute flush without counting it twice", () => {
  let now = 59_990;
  const output: unknown[][] = [];
  const logger = { log: (...args: unknown[]) => { output.push(args); } };
  const originalLog = logger.log;
  const metrics = new RuntimePerformanceMetrics(() => now, line => logger.log(line));
  const window = observeRuntimeCounterWindow(options => metrics.snapshot(options), logger);
  try {
    window.reset();
    metrics.recordCounter("transientCommandTargetSuperseded", 2);
    assert.equal(window.counters().transientCommandTargetSuperseded, 2);
    now = 60_010;
    // Another instrumentation call flushes the previous minute before recording.
    metrics.recordCounter("tenantCheckouts");
    assert.equal(metrics.snapshot().counters.transientCommandTargetSuperseded, undefined);
    assert.equal(JSON.parse(output[0]![0] as string).counters.transientCommandTargetSuperseded, 2);
    assert.equal(window.counters().transientCommandTargetSuperseded, 2);
    assert.equal(window.counters().transientCommandTargetSuperseded, 2, "reads do not accumulate again");
    metrics.recordCounter("transientCommandTargetSuperseded", 3);
    assert.equal(window.counters().transientCommandTargetSuperseded, 5);
    now = 120_010;
    metrics.flush();
    assert.equal(window.counters().transientCommandTargetSuperseded, 5);
    window.reset();
    assert.equal(window.counters().transientCommandTargetSuperseded, undefined);
    now = 180_010;
    metrics.flush();
    assert.equal(window.counters().transientCommandTargetSuperseded, undefined, "empty intervals do not add zero keys");
    metrics.recordCounter("transientCommandTargetSuperseded");
    assert.equal(window.counters().transientCommandTargetSuperseded, 1, "prior windows cannot leak after reset");
  } finally { window.restore(); }
  assert.equal(logger.log, originalLog);
});

it("forwards ordinary logs unchanged and ignores unrelated JSON", () => {
  const output: unknown[][] = [];
  const logger = { log: (...args: unknown[]) => { output.push(args); } };
  const window = observeRuntimeCounterWindow(() => ({ counters: {} }), logger);
  try {
    logger.log("ordinary", { value: 1 });
    logger.log("null");
    logger.log('{"event":"other","counters":{"transientCommandTargetSuperseded":9}}');
    assert.deepEqual(window.counters(), {});
    assert.deepEqual(output, [["ordinary", { value: 1 }], ["null"], ['{"event":"other","counters":{"transientCommandTargetSuperseded":9}}']]);
  } finally { window.restore(); }
});
