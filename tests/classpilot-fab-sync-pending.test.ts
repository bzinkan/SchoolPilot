import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  CLASSPILOT_FAB_SYNC_PENDING_TTL_SECONDS,
  classpilotFabSyncPendingKey,
  createClasspilotFabSyncPendingStore,
  describeClasspilotFabSyncMiss,
  reportClasspilotFabSyncMiss,
  type ClasspilotFabSyncMissReport,
} from "../src/services/classpilotFabSyncPending.js";
import { snapshotRuntimePerformanceMetrics } from "../src/services/runtimePerformanceMetrics.js";

const binding = {
  schoolId: "school-1",
  studentId: "student-1",
  studentSessionId: "session-1",
  deviceId: "device-1",
};

function counters(): Record<string, number> {
  const snapshot = snapshotRuntimePerformanceMetrics({ reset: true }) as { counters?: Record<string, number> };
  return snapshot.counters ?? {};
}

function fakeRedis(behaviour: (args: string[]) => unknown | undefined | Promise<unknown | undefined>) {
  const calls: string[][] = [];
  const command = async (args: string[]) => {
    calls.push(args);
    return behaviour(args);
  };
  return { calls, command };
}

describe("classpilot fab sync pending", () => {
  it("never puts raw ids in the key and versions the namespace", () => {
    const key = classpilotFabSyncPendingKey(binding);
    assert.match(key, /:classpilot:fab-sync-pending:v1:[A-Za-z0-9_-]+$/);
    for (const value of Object.values(binding)) assert.equal(key.includes(value), false);
    assert.notEqual(key, classpilotFabSyncPendingKey({ ...binding, deviceId: "device-2" }));
  });

  it("marks with a TTL and takes exactly once through Redis", async () => {
    counters();
    const store = new Map<string, string>();
    const redis = fakeRedis((args) => {
      if (args[0] === "SET") { store.set(args[1]!, args[2]!); return "OK"; }
      if (args[0] === "GETDEL") { const value = store.get(args[1]!) ?? null; store.delete(args[1]!); return value; }
      if (args[0] === "DEL") { store.delete(args[1]!); return 1; }
      return undefined;
    });
    const pending = createClasspilotFabSyncPendingStore(redis.command, () => 1_000);
    assert.equal(await pending.mark(binding), "stored");
    assert.deepEqual(redis.calls[0]!.slice(0, 1).concat(redis.calls[0]!.slice(3)), ["SET", "EX", String(CLASSPILOT_FAB_SYNC_PENDING_TTL_SECONDS)]);
    assert.equal(await pending.take(binding), true);
    assert.equal(redis.calls[1]![0], "GETDEL");
    assert.equal(await pending.take(binding), false);
    const seen = counters();
    assert.equal(seen.fabSyncPendingMarked, 1);
    assert.equal(seen.fabSyncPendingMarkFallback ?? 0, 0);
  });

  it("falls back to a bounded local map when Redis is absent or failing", async () => {
    counters();
    const absent = createClasspilotFabSyncPendingStore(async () => undefined, () => 5_000);
    assert.equal(await absent.mark(binding), "local");
    assert.equal(await absent.take(binding), true);
    assert.equal(await absent.take(binding), false);
    const failing = createClasspilotFabSyncPendingStore(async () => { throw new Error("redis down"); }, () => 5_000);
    assert.equal(await failing.mark(binding), "local");
    assert.equal(await failing.take(binding), true);
    await failing.clear(binding); // must not throw
    const seen = counters();
    assert.equal(seen.fabSyncPendingMarkFallback, 2);
    assert.ok((seen.fabSyncPendingTakeUnavailable ?? 0) >= 3);
  });

  it("expires local marks and evicts the oldest beyond the bound", async () => {
    let clock = 10_000;
    const local = createClasspilotFabSyncPendingStore(async () => undefined, () => clock);
    await local.mark(binding);
    clock += CLASSPILOT_FAB_SYNC_PENDING_TTL_SECONDS * 1_000 + 1;
    assert.equal(await local.take(binding), false, "an expired local mark is not served");
    await local.mark(binding);
    for (let index = 0; index < 10_000; index += 1) {
      await local.mark({ ...binding, deviceId: `evict-${index}` });
    }
    assert.equal(await local.take(binding), false, "the oldest mark is evicted once the bound is reached");
    local.resetLocal();
  });

  it("clears a stale flag without throwing and does not serve it afterwards", async () => {
    const store = new Map<string, string>();
    const redis = fakeRedis((args) => {
      if (args[0] === "SET") { store.set(args[1]!, args[2]!); return "OK"; }
      if (args[0] === "GETDEL") { const value = store.get(args[1]!) ?? null; store.delete(args[1]!); return value; }
      if (args[0] === "DEL") { store.delete(args[1]!); return 1; }
      return undefined;
    });
    const pending = createClasspilotFabSyncPendingStore(redis.command, () => 1_000);
    await pending.mark(binding);
    await pending.clear(binding);
    assert.equal(await pending.take(binding), false);
  });

  it("describes a miss with ids only, on one line, in a fixed shape", () => {
    const report: ClasspilotFabSyncMissReport = {
      ...binding,
      teachingSessionId: "teaching-1",
      supervisionContextId: null,
      pending: "stored",
      relay: "unavailable",
    };
    const described = describeClasspilotFabSyncMiss(report);
    assert.equal(described.level, "warn");
    assert.equal(
      described.line,
      "[ClassPilot fab] fab-state-sync missed local socket school=school-1 student=student-1"
        + " studentSession=session-1 device=device-1 teachingSession=teaching-1 supervisionContext=none"
        + " reason=control_ownership_transition pending=stored relay=unavailable"
    );
    assert.equal(described.line.includes("\n"), false);
    assert.doesNotMatch(described.line, /name|email|content/i);
  });

  it("reports through the sink and never throws when the sink is broken", () => {
    counters();
    const lines: string[] = [];
    reportClasspilotFabSyncMiss({
      ...binding, teachingSessionId: null, supervisionContextId: "context-1", pending: "local", relay: "skipped",
    }, { warn: (line: string) => { lines.push(line); } });
    assert.equal(lines.length, 1);
    assert.match(lines[0]!, /supervisionContext=context-1 reason=control_ownership_transition pending=local relay=skipped$/);
    reportClasspilotFabSyncMiss({
      ...binding, teachingSessionId: null, supervisionContextId: null, pending: "local", relay: "accepted",
    }, { warn: () => { throw new Error("sink broken"); } });
    assert.equal(counters().fabSyncLocalDeliveryMissed, 2);
  });
});
