import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  recordFabSyncPendingRedisOutcome, recordFabSyncPendingLocalTake,
  type FabSyncPendingDiagnosticsSink,
} from "../src/services/classpilotFabSyncDiagnostics.js";
import { FAB_SYNC_PENDING_COUNTER_NAMES } from "../src/services/classpilotFabSyncDiagnosticsContract.js";
import { RuntimePerformanceMetrics } from "../src/services/runtimePerformanceMetrics.js";

const notAdmittedReasons = [
  ["not_ready", "NotReady"], ["queue_full", "QueueFull"], ["circuit_open", "CircuitOpen"],
  ["shutdown", "Shutdown"], ["aborted", "Aborted"], ["not_configured", "NotConfigured"],
] as const;
const unknownReasons = [
  ["timeout", "Timeout"], ["transport_lost", "TransportLost"], ["shutdown", "Shutdown"], ["aborted", "Aborted"],
] as const;

describe("bounded identifier-free FAB pending diagnostics", () => {
  it("uses a unique closed 37-counter schema for every operation/reason/reply/local outcome", () => {
    assert.equal(FAB_SYNC_PENDING_COUNTER_NAMES.length, 37);
    assert.equal(new Set(FAB_SYNC_PENDING_COUNTER_NAMES).size, 37);
    assert.ok(FAB_SYNC_PENDING_COUNTER_NAMES.every((name) => /^fabSyncPending[A-Za-z]+$/.test(name)));
  });

  it("atomically records every existing not-admitted and unknown reason for both operations", () => {
    const batches: unknown[] = [];
    const sink: FabSyncPendingDiagnosticsSink = counts => { batches.push(counts); };
    for (const operation of ["mark", "take"] as const) {
      const prefix = `fabSyncPendingRedis${operation === "mark" ? "Mark" : "Take"}`;
      for (const [reason, suffix] of notAdmittedReasons) {
        recordFabSyncPendingRedisOutcome(operation, { status: "not_admitted", reason }, sink);
        assert.deepEqual(batches.pop(), { [`${prefix}NotAdmitted`]: 1, [`${prefix}NotAdmitted${suffix}`]: 1 });
      }
      for (const [reason, suffix] of unknownReasons) {
        recordFabSyncPendingRedisOutcome(operation, { status: "unknown", reason }, sink);
        assert.deepEqual(batches.pop(), { [`${prefix}Unknown`]: 1, [`${prefix}Unknown${suffix}`]: 1 });
      }
      recordFabSyncPendingRedisOutcome(operation, { status: "exception" }, sink);
      assert.deepEqual(batches.pop(), { [`${prefix}Exception`]: 1 });
    }
    assert.equal(batches.length, 0);
  });

  it("distinguishes accepted string hits, null empties and unexpected replies without inspecting content", () => {
    const batches: unknown[] = [];
    const sink: FabSyncPendingDiagnosticsSink = counts => { batches.push(counts); };
    recordFabSyncPendingRedisOutcome("mark", { status: "accepted", value: "OK" }, sink);
    assert.deepEqual(batches.pop(), { fabSyncPendingRedisMarkAccepted: 1 });
    for (const value of ["private-student-payload-and-key", ""]) {
      recordFabSyncPendingRedisOutcome("take", { status: "accepted", value }, sink);
      assert.deepEqual(batches.pop(), { fabSyncPendingRedisTakeAccepted: 1, fabSyncPendingRedisTakeStringHit: 1 });
    }
    recordFabSyncPendingRedisOutcome("take", { status: "accepted", value: null }, sink);
    assert.deepEqual(batches.pop(), { fabSyncPendingRedisTakeAccepted: 1, fabSyncPendingRedisTakeNullEmpty: 1 });
    for (const value of [undefined, 0, false, {}, [], { toString() { throw new Error("must not inspect reply"); } }]) {
      recordFabSyncPendingRedisOutcome("take", { status: "accepted", value }, sink);
      assert.deepEqual(batches.pop(), { fabSyncPendingRedisTakeAccepted: 1, fabSyncPendingRedisTakeUnexpectedReply: 1 });
    }
  });

  it("ignores dynamic labels, reasons and invalid runtime inputs without logging them", () => {
    const batches: unknown[] = [];
    const sink: FabSyncPendingDiagnosticsSink = counts => { batches.push(counts); };
    for (const outcome of [null, undefined, "unknown", {}, { status: "private-dynamic-label" },
      ...["constructor", "__proto__", "private-student-key"].flatMap(reason => [
        { status: "not_admitted", reason }, { status: "unknown", reason },
      ])]) {
      recordFabSyncPendingRedisOutcome("mark", outcome as never, sink);
    }
    recordFabSyncPendingRedisOutcome("delete" as never, { status: "accepted", value: "private-payload" }, sink);
    recordFabSyncPendingLocalTake("private-dynamic-label" as never, true, sink);
    recordFabSyncPendingLocalTake("hit", "true" as never, sink);
    assert.deepEqual(batches, []);
  });

  it("never forwards identifiers, keys, values, error content or extra outcome properties to the sink", () => {
    const batches: unknown[] = [];
    const sink: FabSyncPendingDiagnosticsSink = counts => { batches.push(counts); };
    const secret = "private-identifier-content-never-export";
    recordFabSyncPendingRedisOutcome("take", { status: "accepted", value: secret, schoolId: secret, key: secret, error: secret } as never, sink);
    recordFabSyncPendingRedisOutcome("mark", { status: "unknown", reason: "timeout", error: secret, value: secret } as never, sink);
    assert.doesNotMatch(JSON.stringify(batches), /private-identifier-content-never-export/);
    assert.ok(batches.every(batch => Object.keys(batch as object).every(key => FAB_SYNC_PENDING_COUNTER_NAMES.includes(key as never))));
  });

  it("swallows broken getters and sinks without recursive diagnostics or changing caller behavior", () => {
    let calls = 0;
    const sink: FabSyncPendingDiagnosticsSink = () => { calls++; throw new Error("private sink error"); };
    assert.doesNotThrow(() => recordFabSyncPendingRedisOutcome("mark", { status: "exception" }, sink));
    assert.doesNotThrow(() => recordFabSyncPendingLocalTake("hit", true, sink));
    assert.equal(calls, 2);
    const broken = { get status() { throw new Error("private status error"); } };
    assert.doesNotThrow(() => recordFabSyncPendingRedisOutcome("take", broken as never, sink));
    assert.equal(calls, 2);
  });

  it("reads disposition labels once so changing getters cannot introduce unchecked counter names", () => {
    let statusReads = 0, reasonReads = 0;
    const batches: unknown[] = [];
    recordFabSyncPendingRedisOutcome("take", {
      get status() { statusReads++; return statusReads === 1 ? "not_admitted" : "private-dynamic-status"; },
      get reason() { reasonReads++; return reasonReads === 1 ? "queue_full" : "private-dynamic-reason"; },
    } as never, counts => { batches.push(counts); });
    assert.equal(statusReads, 1);
    assert.equal(reasonReads, 1);
    assert.deepEqual(batches, [{ fabSyncPendingRedisTakeNotAdmitted: 1, fabSyncPendingRedisTakeNotAdmittedQueueFull: 1 }]);
  });

  it("pairs local hit/miss/expired with unavailable context in exactly one batch only when true", () => {
    const batches: unknown[] = [];
    const sink: FabSyncPendingDiagnosticsSink = counts => { batches.push(counts); };
    for (const outcome of ["hit", "miss", "expired"] as const) {
      const suffix = `${outcome[0]!.toUpperCase()}${outcome.slice(1)}`;
      recordFabSyncPendingLocalTake(outcome, false, sink);
      assert.deepEqual(batches.pop(), { [`fabSyncPendingTakeLocal${suffix}`]: 1 });
      recordFabSyncPendingLocalTake(outcome, true, sink);
      assert.deepEqual(batches.pop(), { [`fabSyncPendingTakeLocal${suffix}`]: 1, [`fabSyncPendingTakeUnavailableLocal${suffix}`]: 1 });
    }
  });

  it("preserves quiet zeros and atomic outcome/reason batches across the real metric interval boundary", () => {
    let clock = 0;
    const rows: Array<{ counters: Record<string, number>; _aws?: unknown }> = [];
    const metrics = new RuntimePerformanceMetrics(() => { const at = clock; clock += 60_000; return at; },
      line => rows.push(JSON.parse(line)));
    recordFabSyncPendingRedisOutcome("mark", { status: "not_admitted", reason: "queue_full" }, counts => metrics.recordCounters(counts));
    metrics.flush();
    assert.equal(rows.length, 2);
    assert.equal(rows[0]!._aws, undefined);
    for (const name of FAB_SYNC_PENDING_COUNTER_NAMES) assert.equal(rows[0]!.counters[name], 0);
    assert.equal(rows[1]!.counters.fabSyncPendingRedisMarkNotAdmitted, 1);
    assert.equal(rows[1]!.counters.fabSyncPendingRedisMarkNotAdmittedQueueFull, 1);

    const localRows: Array<{ counters: Record<string, number> }> = [];
    clock = 0;
    const local = new RuntimePerformanceMetrics(() => { const at = clock; clock += 60_000; return at; },
      line => localRows.push(JSON.parse(line)));
    recordFabSyncPendingLocalTake("expired", true, counts => local.recordCounters(counts));
    local.flush();
    assert.equal(localRows[1]!.counters.fabSyncPendingTakeLocalExpired, 1);
    assert.equal(localRows[1]!.counters.fabSyncPendingTakeUnavailableLocalExpired, 1);
  });
});
