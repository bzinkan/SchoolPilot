import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { RuntimePerformanceMetrics } from "../src/services/runtimePerformanceMetrics.js";

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

function harness() {
  let now = 120_000;
  const records: SummaryRecord[] = [];
  const metrics = new RuntimePerformanceMetrics(
    () => now,
    (line) => records.push(JSON.parse(line) as SummaryRecord),
  );
  return { metrics, records, advance(ms: number) { now += ms; } };
}

describe("runtime performance metrics", () => {
  it("declares only counters that moved as CloudWatch metrics and keeps every counter in the log record", () => {
    const { metrics, records, advance } = harness();
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
    assert.ok(Object.keys(record?.counters ?? {}).length > 1);
  });

  it("writes a quiet interval as a plain log record with no metric declaration", () => {
    const { metrics, records, advance } = harness();
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
