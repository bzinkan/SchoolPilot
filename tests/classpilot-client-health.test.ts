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
