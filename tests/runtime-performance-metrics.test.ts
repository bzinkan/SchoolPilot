import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  recordRuntimePerformanceCounter,
  recordRuntimePerformanceTiming,
  RuntimePerformanceMetrics,
  snapshotRuntimePerformanceMetrics,
} from "../src/services/runtimePerformanceMetrics.js";
import { STUDENT_SIGN_IN_COUNTER_NAMES, STUDENT_SIGN_IN_REASON_COUNTERS } from "../src/services/classpilotStudentSignInDiagnosticsContract.js";

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

  it("keeps a terminal outcome and its reason atomic when the clock crosses intervals", () => {
    let clock = 0;
    const lines: string[] = [];
    // Each clock read advances to another minute: separate counter calls would
    // put the terminal total and reason in different intervals.
    const metrics = new RuntimePerformanceMetrics(() => {
      const value = clock;
      clock += 60_000;
      return value;
    }, line => { lines.push(line); });
    metrics.recordCounters({
      studentSignInCompleted: 1,
      studentSignInFailure: 1,
      studentSignInReasonPinMismatch: 1,
    });
    metrics.flush();
    const rows = lines.map(line => JSON.parse(line));
    assert.deepEqual(rows.map(row => row.counters.studentSignInCompleted), [0, 1]);
    assert.deepEqual(rows.map(row => row.counters.studentSignInFailure), [0, 1]);
    assert.deepEqual(rows.map(row => row.counters.studentSignInReasonPinMismatch), [0, 1]);
    assert.ok(rows.every(row => row.intervalSeconds === 60));
    for (const row of rows) {
      for (const name of STUDENT_SIGN_IN_COUNTER_NAMES) assert.equal(typeof row.counters[name], "number");
      assert.equal(
        Object.values(STUDENT_SIGN_IN_REASON_COUNTERS).reduce((sum, name) => sum + row.counters[name], 0),
        row.counters.studentSignInFailure,
      );
      assert.deepEqual(row._aws.CloudWatchMetrics[0].Dimensions, [["Environment", "Service"]]);
      assert.ok(row._aws.CloudWatchMetrics[0].Metrics.length <= 100);
    }
  });

  it("retains quiet zeros and one final partial without summing repeated lifetime counts", () => {
    let now = 0;
    const lines: string[] = [];
    const metrics = new RuntimePerformanceMetrics(() => now, line => { lines.push(line); });
    now = 60_000;
    metrics.flush();
    metrics.recordCounters({
      studentSignInCompleted: 1,
      studentSignInFailure: 1,
      studentSignInReasonRequestInterrupted: 1,
      studentSignInDiagnosticSinkFailure: 1,
    });
    now = 60_125;
    metrics.flush({ final: true });
    metrics.flush({ final: true });
    const rows = lines.map(line => JSON.parse(line));
    assert.deepEqual(rows.map(row => row.intervalSeconds), [60, 0.125]);
    assert.deepEqual(rows.map(row => row.counters.studentSignInFailure), [0, 1]);
    assert.deepEqual(rows.map(row => row.counters.studentSignInDiagnosticSinkFailure), [0, 1]);
    assert.deepEqual(rows.map(row => row.RuntimeStudentSignInReasonRequestInterrupted), [0, 1]);
  });

  it("rejects arbitrary batch counter names and invalid increments", () => {
    const lines: string[] = [];
    let now = 0;
    const metrics = new RuntimePerformanceMetrics(() => now, line => { lines.push(line); });
    metrics.recordCounters({
      studentSignInCompleted: Number.NaN,
      studentSignInSuccess: -1,
      studentSignInFailure: 0,
      ...{ privateStudentCounter: 99 },
    });
    assert.deepEqual(metrics.snapshot().counters, {});
    now = 60_000;
    metrics.flush();
    assert.doesNotMatch(lines[0]!, /privateStudentCounter/);
  });
});
