import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  recordRuntimePerformanceCounter,
  recordRuntimePerformanceTiming,
  snapshotRuntimePerformanceMetrics,
} from "../src/services/runtimePerformanceMetrics.js";

describe("identifier-free runtime performance instrumentation", () => {
  it("records fixed counters and timings without accepting dimensions", () => {
    snapshotRuntimePerformanceMetrics({ reset: true });
    recordRuntimePerformanceCounter("tenantCheckouts", 2);
    recordRuntimePerformanceTiming("poolAcquisitionMs", 12);
    assert.deepEqual(snapshotRuntimePerformanceMetrics({ reset: true }), {
      counters: { tenantCheckouts: 2 },
      timings: { poolAcquisitionMs: { count: 1, totalMs: 12, maxMs: 12 } },
    });
  });
});
