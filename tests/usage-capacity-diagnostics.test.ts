import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import {
  USAGE_CAPACITY_OPERATIONS, getUsageCapacityDiagnostics, getUsageCapacityOperation,
  recordUsageCapacityCounter, recordUsageCapacityTiming, resetUsageCapacityDiagnostics,
  runWithUsageCapacityOperation, startUsageCapacityCheckout,
} from "../src/services/usageCapacityDiagnostics.js";
import { recordHeartbeatHotPathCounter, snapshotHeartbeatHotPathMetrics } from "../src/services/heartbeatHotPathMetrics.js";

describe("bounded content-free capacity diagnostics", () => {
  beforeEach(resetUsageCapacityDiagnostics);

  it("retains inbox failures until explicit phase reset without message content", () => {
    recordUsageCapacityCounter("heartbeatOptionalInboxFailures", "heartbeat_final_delivery");
    snapshotHeartbeatHotPathMetrics({ reset: true });
    assert.equal(getUsageCapacityDiagnostics().operations.heartbeat_final_delivery!.counters.heartbeatOptionalInboxFailures, 1);
    resetUsageCapacityDiagnostics();
    assert.equal(getUsageCapacityDiagnostics().operations.heartbeat_final_delivery!.counters.heartbeatOptionalInboxFailures, 0);
  });

  it("retains optional telemetry failures across minute summaries until explicit phase reset", () => {
    recordUsageCapacityCounter("heartbeatOptionalTelemetryFailures", "heartbeat_background");
    recordHeartbeatHotPathCounter("heartbeatOptionalTelemetryFailures");
    snapshotHeartbeatHotPathMetrics({ reset: true });
    assert.equal(snapshotHeartbeatHotPathMetrics().counters.heartbeatOptionalTelemetryFailures, undefined);
    assert.equal(getUsageCapacityDiagnostics().operations.heartbeat_background!.counters.heartbeatOptionalTelemetryFailures, 1);
    recordUsageCapacityCounter("heartbeatOptionalTelemetryFailures", "heartbeat_background");
    assert.equal(getUsageCapacityDiagnostics().operations.heartbeat_background!.counters.heartbeatOptionalTelemetryFailures, 2);
    resetUsageCapacityDiagnostics();
    assert.equal(getUsageCapacityDiagnostics().operations.heartbeat_background!.counters.heartbeatOptionalTelemetryFailures, 0);
  });

  it("isolates concurrent async owners and records failure duration without changing errors", async () => {
    const failure = new Error("private detail must not enter diagnostics");
    await Promise.all([
      runWithUsageCapacityOperation("auth", async () => {
        await new Promise<void>(resolve => setImmediate(resolve));
        assert.equal(getUsageCapacityOperation(), "auth");
        recordUsageCapacityTiming("sqlMs", 5);
      }),
      assert.rejects(runWithUsageCapacityOperation("usage_report", async () => {
        await Promise.resolve();
        assert.equal(getUsageCapacityOperation(), "usage_report");
        recordUsageCapacityCounter("sqlFailure");
        throw failure;
      }), error => error === failure),
    ]);
    assert.equal(getUsageCapacityOperation(), "unclassified");
    const snapshot = getUsageCapacityDiagnostics();
    assert.equal(snapshot.operations.auth!.timings.sqlMs!.count, 1);
    assert.equal(snapshot.operations.usage_report!.timings.operationMs!.count, 1);
    assert.equal(snapshot.operations.usage_report!.counters.sqlFailure, 1);
    assert.doesNotMatch(JSON.stringify(snapshot), /private detail/);
  });

  it("holds ownership through phase resets and releases once", () => {
    const release = startUsageCapacityCheckout("heartbeat_final_delivery");
    assert.equal(getUsageCapacityDiagnostics().operations.heartbeat_final_delivery!.activeCheckouts, 1);
    resetUsageCapacityDiagnostics();
    assert.equal(getUsageCapacityDiagnostics().operations.heartbeat_final_delivery!.activeCheckouts, 1);
    release();
    release();
    const value = getUsageCapacityDiagnostics().operations.heartbeat_final_delivery!;
    assert.equal(value.activeCheckouts, 0);
    assert.equal(value.peakActiveCheckouts, 1);
    assert.equal(value.timings.holdMs!.count, 1);
  });

  it("keeps a fixed memory/cardinality bound and returns detached snapshots", () => {
    for (let index = 0; index < 20_000; index += 1) {
      Reflect.apply(recordUsageCapacityTiming, undefined, ["sqlMs", index, `student-${index}`]);
    }
    recordUsageCapacityTiming("sqlMs", NaN);
    recordUsageCapacityTiming("sqlMs", -1);
    Reflect.apply(recordUsageCapacityCounter, undefined, ["untrusted message", "auth"]);
    const snapshot = getUsageCapacityDiagnostics();
    assert.deepEqual(Object.keys(snapshot.operations), [...USAGE_CAPACITY_OPERATIONS]);
    assert.equal(snapshot.operations.unclassified!.timings.sqlMs!.count, 20_000);
    assert.equal(snapshot.operations.unclassified!.timings.sqlMs!.buckets.length, snapshot.durationBoundsMs.length + 1);
    snapshot.operations.unclassified!.timings.sqlMs!.buckets[0] = -1;
    snapshot.operations.auth!.counters.checkoutAttempts = 99;
    assert.notEqual(getUsageCapacityDiagnostics().operations.unclassified!.timings.sqlMs!.buckets[0], -1);
    assert.equal(getUsageCapacityDiagnostics().operations.auth!.counters.checkoutAttempts, 0);
    assert.doesNotMatch(JSON.stringify(snapshot), /student-|untrusted message/);
  });
});
