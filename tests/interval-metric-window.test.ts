import assert from "node:assert/strict";
import test from "node:test";
import { captureIntervalMetricWindow } from "./helpers/intervalMetricWindow.js";

test("metric assertions retain successes and failures across a real bucket reset", async (t) => {
  let now = Date.parse("2026-09-05T12:39:59.990Z");
  t.mock.method(Date, "now", () => now);
  const hotPath = await import("../src/services/heartbeatHotPathMetrics.js");
  const { RuntimePerformanceMetrics } = await import("../src/services/runtimePerformanceMetrics.js");
  const runtime = new RuntimePerformanceMetrics(() => now);
  hotPath.snapshotHeartbeatHotPathMetrics({ reset: true });
  const metrics = captureIntervalMetricWindow(t, {
    runtime: () => runtime.snapshot().counters,
    hotPath: () => hotPath.snapshotHeartbeatHotPathMetrics().counters,
  });

  hotPath.recordHeartbeatHotPathCounter("screenshotPolicyRefreshSignals");
  hotPath.recordHeartbeatHotPathCounter("screenshotPolicyRefreshFailures");
  runtime.recordCounter("poolAcquisitionSuccess", 4);
  runtime.recordCounter("poolAcquisitionFailure");
  now += 20; // The next write emits and resets the preceding UTC-minute bucket.
  hotPath.recordHeartbeatHotPathCounter("screenshotPolicyRefreshSignals", 8);
  runtime.recordCounter("poolAcquisitionSuccess", 38);

  assert.equal(hotPath.snapshotHeartbeatHotPathMetrics().counters.screenshotPolicyRefreshSignals, 8);
  assert.equal(metrics.hotPathCounter("screenshotPolicyRefreshSignals"), 9, "missing work must still fail the ten-refresh expectation");
  hotPath.recordHeartbeatHotPathCounter("screenshotPolicyRefreshSignals");
  assert.equal(metrics.hotPathCounter("screenshotPolicyRefreshSignals"), 10);
  assert.equal(metrics.runtimeCounter("poolAcquisitionSuccess"), 42);
  assert.equal(hotPath.snapshotHeartbeatHotPathMetrics().counters.screenshotPolicyRefreshFailures ?? 0, 0);
  assert.equal(runtime.snapshot().counters.poolAcquisitionFailure ?? 0, 0);
  assert.equal(metrics.hotPathCounter("screenshotPolicyRefreshFailures"), 1, "a pre-rollover refresh failure must not disappear");
  assert.equal(metrics.runtimeCounter("poolAcquisitionFailure"), 1, "a pre-rollover pool failure must not disappear");
});
