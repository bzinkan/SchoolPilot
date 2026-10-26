import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  recordRuntimePerformanceCounter,
  recordRuntimePerformanceTiming,
  RuntimePerformanceMetrics,
  snapshotRuntimePerformanceMetrics,
  type RuntimePerformanceCounter,
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
      // Only intervals where a counter moved declare CloudWatch metrics.
      const moved = Object.values(row.counters as Record<string, number>).some((value) => value > 0);
      if (moved) {
        assert.deepEqual(row._aws.CloudWatchMetrics[0].Dimensions, [["Environment", "Service"]]);
        assert.ok(row._aws.CloudWatchMetrics[0].Metrics.length <= 100);
      } else {
        assert.equal(row._aws, undefined);
      }
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

type EmfDirective = {
  Namespace: string;
  Dimensions: string[][];
  Metrics: Array<{ Name: string; Unit: string }>;
};

type SummaryRecord = {
  _aws?: { Timestamp: number; CloudWatchMetrics: EmfDirective[] };
  event: string;
  counters: Record<string, number>;
  [field: string]: unknown;
};

function declarationHarness() {
  let now = 120_000;
  const records: SummaryRecord[] = [];
  const metrics = new RuntimePerformanceMetrics(
    () => now,
    (line) => { records.push(JSON.parse(line) as SummaryRecord); },
  );
  return { metrics, records, advance(ms: number) { now += ms; } };
}

describe("runtime performance CloudWatch metric declarations", () => {
  it("splits all active fixed counters into bounded metric-only events with one canonical summary", () => {
    const { metrics, records, advance } = declarationHarness();
    advance(60_000);
    metrics.flush();
    const names = Object.keys(records[0]!.counters) as RuntimePerformanceCounter[];
    assert.ok(names.length > 100, "Exercise the real registered schema beyond one EMF directive");
    metrics.recordCounters(Object.fromEntries(names.map(name => [name, 1])));
    advance(60_000);
    metrics.flush();
    const emitted = records.slice(1);
    const summaries = emitted.filter(record => record.event === "schoolpilot_runtime_performance_summary");
    const metricRecords = emitted.filter(record => record.event === "schoolpilot_runtime_performance_metrics");
    assert.equal(summaries.length, 1);
    const record = summaries[0]!;
    assert.equal(record._aws, undefined);
    assert.equal(metricRecords.length, Math.ceil(names.length / 100));
    const directives = metricRecords.flatMap(row => row._aws!.CloudWatchMetrics);
    assert.ok(records.every(row => (row._aws?.CloudWatchMetrics.reduce((sum, directive) => sum + directive.Metrics.length, 0) ?? 0) <= 100));
    for (const directive of directives) {
      assert.equal(directive.Namespace, "SchoolPilot/RuntimePerformance");
      assert.deepEqual(directive.Dimensions, [["Environment", "Service"]]);
    }
    for (const row of metricRecords) {
      assert.equal(row._aws!.Timestamp, 180_000);
      assert.equal(Object.hasOwn(row, "counters"), false);
      assert.equal(Object.hasOwn(row, "timings"), false);
      assert.equal(Object.hasOwn(row, "InstanceId"), false);
      assert.equal(Object.hasOwn(row, "Release"), false);
      const targets = row._aws!.CloudWatchMetrics.flatMap(directive => directive.Metrics.map(metric => metric.Name));
      assert.deepEqual(Object.keys(row).sort(), ["_aws", "event", "Environment", "Service", ...targets].sort());
      assert.ok(targets.every(name => row[name] === 1));
    }
    const declared = directives.flatMap(directive => directive.Metrics.map(metric => metric.Name));
    const expected = names.map(name => `Runtime${name[0]!.toUpperCase()}${name.slice(1)}`);
    assert.equal(new Set(declared).size, names.length);
    assert.deepEqual([...declared].sort(), expected.sort());
    for (const name of names) {
      assert.equal(record.counters[name], 1);
      assert.equal(record[`Runtime${name[0]!.toUpperCase()}${name.slice(1)}`], 1);
    }
    advance(60_000);
    metrics.flush();
    assert.equal(records.at(-1)!._aws, undefined);
    assert.equal(records.at(-1)!.event, "schoolpilot_runtime_performance_summary");
    assert.ok(Object.values(records.at(-1)!.counters).every(value => value === 0));
  });

  it("keeps exactly 100 metrics inline but preserves quiet counters when 101 active metrics require separate events", () => {
    for (const activeCount of [100, 101]) {
      const { metrics, records, advance } = declarationHarness();
      advance(60_000);
      metrics.flush();
      const names = Object.keys(records[0]!.counters) as RuntimePerformanceCounter[];
      const active = names.slice(0, activeCount);
      metrics.recordCounters(Object.fromEntries(active.map(name => [name, 1])));
      advance(60_000);
      metrics.flush();
      const emitted = records.slice(1);
      const summary = emitted.filter(row => row.event === "schoolpilot_runtime_performance_summary");
      assert.equal(summary.length, 1);
      assert.equal(Object.keys(summary[0]!.counters).length, names.length);
      assert.ok(names.slice(activeCount).every(name => summary[0]!.counters[name] === 0));
      if (activeCount === 100) {
        assert.equal(emitted.length, 1);
        assert.equal(summary[0]!._aws!.CloudWatchMetrics[0]!.Metrics.length, 100);
      } else {
        assert.equal(summary[0]!._aws, undefined);
        assert.equal(emitted.length, 3);
        assert.deepEqual(emitted.filter(row => row._aws).map(row => row._aws!.CloudWatchMetrics[0]!.Metrics.length), [100, 1]);
      }
    }
  });

  it("does not replay a committed canonical summary if supplementary metric emission throws", () => {
    let now = 0, metricAttempts = 0;
    const records: SummaryRecord[] = [];
    const metrics = new RuntimePerformanceMetrics(() => now, line => {
      const row = JSON.parse(line) as SummaryRecord;
      if (row.event === "schoolpilot_runtime_performance_metrics") {
        metricAttempts++;
        throw new Error("supplementary sink unavailable");
      }
      records.push(row);
    });
    now = 60_000;
    metrics.flush();
    const names = Object.keys(records[0]!.counters) as RuntimePerformanceCounter[];
    metrics.recordCounters(Object.fromEntries(names.map(name => [name, 1])));
    now = 120_000;
    assert.doesNotThrow(() => metrics.flush());
    metrics.flush();
    assert.equal(metricAttempts, Math.ceil(names.length / 100));
    assert.equal(records.length, 2);
    assert.deepEqual(metrics.snapshot().counters, {});
    now = 180_000;
    metrics.flush();
    assert.equal(records.length, 3);
    assert.equal(records.filter(row => row.counters.fabSyncPendingTakeUnavailable === 1).length, 1);
    assert.equal(records.at(-1)!._aws, undefined);
    assert.ok(Object.values(records.at(-1)!.counters).every(value => value === 0));
  });

  it("declares only counters that moved and keeps every counter in the log record", () => {
    const { metrics, records, advance } = declarationHarness();
    metrics.recordCounter("studentSignInReasonPinMismatch", 2);
    advance(60_000);
    metrics.flush();

    assert.equal(records.length, 1);
    const [record] = records;
    assert.equal(record?.event, "schoolpilot_runtime_performance_summary");
    const directives = record?._aws?.CloudWatchMetrics ?? [];
    assert.equal(directives.length, 1);
    assert.equal(directives[0]?.Namespace, "SchoolPilot/RuntimePerformance");
    assert.deepEqual(directives[0]?.Dimensions, [["Environment", "Service"]]);
    assert.deepEqual(directives[0]?.Metrics, [{ Name: "RuntimeStudentSignInReasonPinMismatch", Unit: "Count" }]);
    assert.equal(record?.RuntimeStudentSignInReasonPinMismatch, 2);
    // Quiet counters stay observable in the log record as explicit zeros.
    assert.equal(record?.counters.studentSignInReasonPinMismatch, 2);
    assert.equal(record?.counters.poolAcquisitionFailure, 0);
    assert.equal(record?.RuntimePoolAcquisitionFailure, 0);
  });

  it("writes a quiet interval as a plain log record with no metric declaration", () => {
    const { metrics, records, advance } = declarationHarness();
    metrics.recordCounter("poolAcquisitionSuccess");
    advance(60_000);
    metrics.flush();
    advance(60_000);
    metrics.flush();

    assert.equal(records.length, 2);
    assert.ok(records[0]?._aws);
    assert.equal(records[1]?._aws, undefined);
    assert.equal(records[1]?.event, "schoolpilot_runtime_performance_summary");
    assert.equal(records[1]?.counters.poolAcquisitionSuccess, 0);
  });
});
