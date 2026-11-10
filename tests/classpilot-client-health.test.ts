import assert from "node:assert/strict";
import { test } from "node:test";
import { classpilotClientHealthSchema, emitClasspilotClientHealth } from "../src/services/classpilotClientHealth.js";

const valid = {
  version: 1,
  intervalSeconds: 60,
  freshnessBuckets: [200, 40, 3, 1, 0, 2],
  counters: { readTimeouts: 1, reconnects: 2, recoveries: 2, eventGapRecoveries: 3 },
};

test("client health rejects identifiers, free-form fields and unbounded amplification", () => {
  assert.ok(classpilotClientHealthSchema.safeParse(valid).success);
  for (const body of [
    { ...valid, studentId: "private-student" },
    { ...valid, counters: { ...valid.counters, deviceId: "private-device" } },
    { ...valid, url: "https://private.example/" },
    { ...valid, freshnessBuckets: [6_000, 1, 0, 0, 0, 0] },
    { ...valid, freshnessBuckets: [1, 2] },
    { ...valid, counters: { ...valid.counters, readTimeouts: -1 } },
    { ...valid, counters: { ...valid.counters, reconnects: 0.5 } },
    { ...valid, counters: { ...valid.counters, recoveries: 6_001 } },
    { ...valid, intervalSeconds: 1 },
  ]) assert.equal(classpilotClientHealthSchema.safeParse(body).success, false);
});

test("fleet freshness metrics preserve sample counts rather than averaging client percentiles", () => {
  const lines: string[] = [];
  const parsed = classpilotClientHealthSchema.parse(valid);
  emitClasspilotClientHealth(parsed, line => lines.push(line), () => 123);
  emitClasspilotClientHealth({ ...parsed, freshnessBuckets: [1, 0, 0, 0, 100, 0] }, line => lines.push(line), () => 124);
  const summaries = lines.map(line => JSON.parse(line));
  assert.equal(summaries.reduce((sum, item) => sum + item.ClientPreviewAge0To5Seconds, 0), 201);
  assert.equal(summaries.reduce((sum, item) => sum + item.ClientPreviewAgeOver30Seconds, 0), 100);
  assert.deepEqual(summaries[0]._aws.CloudWatchMetrics[0].Dimensions, [["Environment", "Service"]]);
  assert.equal(summaries[0]._aws.Timestamp, 123);
  assert.equal(summaries[0].ClientSnapshotReadTimeouts, 1);
  for (const line of lines) assert.doesNotMatch(line, /studentId|deviceId|schoolId|userId|requestId|https?:|InstanceId|Release/);
});

test("quiet client health remains observable without creating zero-only CloudWatch series", () => {
  const lines: string[] = [];
  emitClasspilotClientHealth(classpilotClientHealthSchema.parse({
    ...valid, freshnessBuckets: [0, 0, 0, 0, 0, 0],
    counters: { readTimeouts: 0, reconnects: 0, recoveries: 0, eventGapRecoveries: 0 },
  }), line => lines.push(line));
  const result = JSON.parse(lines[0]!);
  assert.equal(result.event, "classpilot_client_health_summary");
  assert.equal(result._aws, undefined);
  assert.equal(result.ClientPreviewUnavailable, 0);
});

function qualifiedPreview() {
  return {
    version: 1,
    freshnessBuckets: [120, 20, 2, 1, 3, 4],
    excludedCounts: { readDenied: 2, notObserved: 30, backgroundCadence: 40, monitoringNotCurrent: 24 },
  };
}

test("qualified preview diagnostics preserve every legacy metric and add no metric stream", () => {
  const previewEligibilityV1 = qualifiedPreview();
  const result = classpilotClientHealthSchema.safeParse({ ...valid, previewEligibilityV1 });
  assert.equal(result.success, true, "an optional bounded aggregate must be accepted");
  assert.ok(result.success);
  const lines: string[] = [];
  emitClasspilotClientHealth(classpilotClientHealthSchema.parse(valid), line => lines.push(line), () => 123);
  emitClasspilotClientHealth(result.data, line => lines.push(line), () => 123);
  const original = JSON.parse(lines[0]!);
  const { previewEligibilityV1: logged, ...unchanged } = JSON.parse(lines[1]!);
  assert.deepEqual(logged, previewEligibilityV1);
  assert.deepEqual(unchanged, original, "legacy counts, EMF names/dimensions and clock stay identical");
});

test("qualified diagnostics reject identities, unknown cohorts and combined amplification", () => {
  const q = qualifiedPreview();
  const invalid: unknown[] = [
    { ...q, version: 2 },
    { ...q, studentId: "private-student" },
    { ...q, url: "https://private.example/" },
    { ...q, freshnessBuckets: [1, 2] },
    { ...q, freshnessBuckets: [6_000, 1, 0, 0, 0, 0] },
    { ...q, freshnessBuckets: [6_000, 0, 0, 0, 0, 0] },
    { ...q, freshnessBuckets: [0, 0, 0, 0, -1, 0] },
    { ...q, freshnessBuckets: [0, 0, 0, 0, 0, 0.5] },
    { ...q, excludedCounts: { ...q.excludedCounts, deviceId: "private-device" } },
    { ...q, excludedCounts: { ...q.excludedCounts, futureCohort: 1 } },
    { ...q, excludedCounts: { notObserved: 1, backgroundCadence: 1, monitoringNotCurrent: 1 } },
    { ...q, excludedCounts: { ...q.excludedCounts, readDenied: -1 } },
    { ...q, excludedCounts: { ...q.excludedCounts, readDenied: "1" } },
    { ...q, excludedCounts: { ...q.excludedCounts, readDenied: 6_000 } },
  ];
  for (const previewEligibilityV1 of invalid) {
    assert.equal(classpilotClientHealthSchema.safeParse({ ...valid, previewEligibilityV1 }).success, false);
  }
  assert.equal(classpilotClientHealthSchema.safeParse({
    ...valid, previewEligibilityV1: { ...q, freshnessBuckets: [6_000, 0, 0, 0, 0, 0],
      excludedCounts: { readDenied: 0, notObserved: 0, backgroundCadence: 0, monitoringNotCurrent: 0 } },
  }).success, true, "the exact combined observation ceiling is allowed");
});

test("qualified exclusion diagnostics remain log-only when legacy metrics are quiet", () => {
  const lines: string[] = [];
  emitClasspilotClientHealth(classpilotClientHealthSchema.parse({
    ...valid, freshnessBuckets: [0, 0, 0, 0, 0, 0],
    counters: { readTimeouts: 0, reconnects: 0, recoveries: 0, eventGapRecoveries: 0 },
    previewEligibilityV1: { version: 1, freshnessBuckets: [0, 0, 0, 0, 0, 0],
      excludedCounts: { readDenied: 2, notObserved: 0, backgroundCadence: 0, monitoringNotCurrent: 0 } },
  }), line => lines.push(line));
  const result = JSON.parse(lines[0]!);
  assert.equal(result._aws, undefined);
  assert.equal(result.previewEligibilityV1.excludedCounts.readDenied, 2);
});

test("the health emitter allowlists qualified fields even for an internal enriched object", () => {
  const parsed = classpilotClientHealthSchema.parse({ ...valid, previewEligibilityV1: qualifiedPreview() });
  assert.ok(parsed.previewEligibilityV1);
  Object.assign(parsed.previewEligibilityV1, { studentId: "private-student", url: "https://private.example/" });
  Object.assign(parsed.previewEligibilityV1.excludedCounts, { schoolId: "private-school" });
  const lines: string[] = [];
  emitClasspilotClientHealth(parsed, line => lines.push(line));
  assert.doesNotMatch(lines[0]!, /studentId|schoolId|private-|https?:/);
  assert.deepEqual(JSON.parse(lines[0]!).previewEligibilityV1, qualifiedPreview());
});
