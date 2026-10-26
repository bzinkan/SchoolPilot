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
import { BoundedRedisPublication, type RedisPublicationOutcome } from "../src/realtime/boundedRedisPublication.js";
import { setTimeout as pause } from "node:timers/promises";

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
    return { status: "accepted" as const, value: await behaviour(args) };
  };
  return { calls, command };
}

const unavailable = async (): Promise<RedisPublicationOutcome<unknown>> =>
  ({ status: "not_admitted", reason: "not_configured" });

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
    const absent = createClasspilotFabSyncPendingStore(unavailable, () => 5_000);
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
    assert.equal(seen.fabSyncPendingRedisMarkException, 1);
    assert.equal(seen.fabSyncPendingRedisTakeException, 1);
  });

  it("expires local marks and evicts the oldest beyond the bound", async () => {
    let clock = 10_000;
    const local = createClasspilotFabSyncPendingStore(unavailable, () => clock);
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

  it("preserves accepted empty takes and their local hint without calling them Redis failures", async () => {
    counters();
    let reply: RedisPublicationOutcome<unknown> = { status: "not_admitted", reason: "not_ready" };
    const pending = createClasspilotFabSyncPendingStore(async () => reply, () => 1_000);
    assert.equal(await pending.mark(binding), "local");
    counters();
    reply = { status: "accepted", value: null };
    assert.equal(await pending.take(binding), true, "the existing local hint still supplies the take");
    assert.equal(await pending.take(binding), false);
    const seen = counters();
    assert.equal(seen.fabSyncPendingTakeUnavailable ?? 0, 0);
    assert.equal(seen.fabSyncPendingTakeLocalHit, 1);
    assert.equal(seen.fabSyncPendingTakeLocalMiss, 1);
    assert.equal(seen.fabSyncPendingTakeUnavailableLocalHit ?? 0, 0);
  });

  it("distinguishes unavailable local hit, expired hint, and absent hint without retrying", async () => {
    counters();
    let at = 1_000;
    const calls: string[][] = [];
    const pending = createClasspilotFabSyncPendingStore(async (args, options) => {
      calls.push(args);
      assert.equal(options?.readyTimeoutMs, 200);
      assert.equal(options?.signal?.aborted, false);
      return { status: "unknown", reason: "transport_lost" };
    }, () => at);
    await pending.mark(binding);
    assert.equal(await pending.take(binding), true);
    await pending.mark(binding);
    at += CLASSPILOT_FAB_SYNC_PENDING_TTL_SECONDS * 1_000;
    assert.equal(await pending.take(binding), false);
    assert.equal(await pending.take(binding), false);
    assert.deepEqual(calls.map(args => args[0]), ["SET", "GETDEL", "SET", "GETDEL", "GETDEL"]);
    const seen = counters();
    assert.equal(seen.fabSyncPendingTakeUnavailable, 3);
    assert.equal(seen.fabSyncPendingTakeLocalHit, 1);
    assert.equal(seen.fabSyncPendingTakeLocalExpired, 1);
    assert.equal(seen.fabSyncPendingTakeLocalMiss, 1);
    assert.equal(seen.fabSyncPendingTakeUnavailableLocalHit, 1);
    assert.equal(seen.fabSyncPendingTakeUnavailableLocalExpired, 1);
    assert.equal(seen.fabSyncPendingTakeUnavailableLocalMiss, 1);
  });

  it("retains an unexpected accepted reply's original fallback result", async () => {
    counters();
    let value: unknown = 0;
    let calls = 0;
    const pending = createClasspilotFabSyncPendingStore(async () => {
      calls++;
      return { status: "accepted", value };
    }, () => 1_000);
    assert.equal(await pending.mark(binding), "local");
    assert.equal(await pending.take(binding), true);
    value = undefined;
    assert.equal(await pending.take(binding), false);
    assert.equal(calls, 3);
    assert.equal(counters().fabSyncPendingTakeUnavailable, 1, "accepted undefined retains compatibility semantics");
  });

  it("preserves empty-string shared hits and does not attempt the local fallback", async () => {
    counters();
    let value: unknown = false;
    const pending = createClasspilotFabSyncPendingStore(async () => ({ status: "accepted", value }));
    assert.equal(await pending.mark(binding), "local");
    counters();
    value = "";
    assert.equal(await pending.take(binding), true);
    const seen = counters();
    assert.equal(seen.fabSyncPendingTakeUnavailable ?? 0, 0);
    assert.equal(seen.fabSyncPendingTakeLocalHit ?? 0, 0);
    assert.equal(seen.fabSyncPendingTakeLocalMiss ?? 0, 0);
    assert.equal(seen.fabSyncPendingTakeLocalExpired ?? 0, 0);
    value = null;
    assert.equal(await pending.take(binding), false, "a shared string hit cleared the older local hint");
    counters();
  });

  it("keeps accepted non-string replies on the local path without treating them as unavailable", async () => {
    for (const value of [0, false, {}, [], null]) {
      counters();
      const pending = createClasspilotFabSyncPendingStore(async () => ({ status: "accepted", value }));
      assert.equal(await pending.mark(binding), "local", "only literal OK stores the shared mark");
      assert.equal(await pending.take(binding), true);
      assert.equal(await pending.take(binding), false);
      const seen = counters();
      assert.equal(seen.fabSyncPendingMarked ?? 0, 0);
      assert.equal(seen.fabSyncPendingMarkFallback, 1);
      assert.equal(seen.fabSyncPendingTakeUnavailable ?? 0, 0);
      assert.equal(seen.fabSyncPendingTakeUnavailableLocalHit ?? 0, 0);
      assert.equal(seen.fabSyncPendingTakeLocalHit, 1);
      assert.equal(seen.fabSyncPendingTakeLocalMiss, 1);
    }
  });

  it("counts an uncertain destructive take once even if its raw operation completes later", async () => {
    counters();
    let complete!: (value: string) => void;
    const raw = new Promise<string>(resolve => { complete = resolve; });
    let calls = 0;
    const runtime = new BoundedRedisPublication({
      create: () => ({ isReady: true, connect: async () => {}, destroy() {} }),
      limits: { ordinaryMs: 10 },
    });
    const pending = createClasspilotFabSyncPendingStore(args => {
      assert.equal(args[0], "GETDEL");
      return runtime.publish(() => { calls++; return raw; });
    }, () => 1_000);
    const keepAlive = setTimeout(() => {}, 1_000);
    try {
      assert.equal(await pending.take(binding), false);
      const initial = snapshotRuntimePerformanceMetrics().counters;
      assert.equal(initial.fabSyncPendingTakeUnavailable, 1);
      assert.equal(initial.fabSyncPendingTakeUnavailableLocalMiss, 1);
      complete("late-pending-hint");
      await pause(5);
      assert.deepEqual(snapshotRuntimePerformanceMetrics().counters, initial);
      assert.equal(calls, 1, "neither diagnostics nor late completion repeats GETDEL");
    } finally {
      clearTimeout(keepAlive);
      complete("late-pending-hint");
      await runtime.dispose();
      counters();
    }
  });

  it("keeps the existing caller abort bound and records one unavailable local fallback", async () => {
    counters();
    let calls = 0;
    const pending = createClasspilotFabSyncPendingStore((_args, options) => {
      calls++;
      return new Promise(resolve => {
        options?.signal?.addEventListener("abort", () => resolve({ status: "unknown", reason: "aborted" }), { once: true });
      });
    });
    const keepAlive = setTimeout(() => {}, 1_000);
    try {
      assert.equal(await pending.take(binding), false);
      assert.equal(calls, 1);
      assert.equal(counters().fabSyncPendingTakeUnavailableLocalMiss, 1);
    } finally { clearTimeout(keepAlive); }
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
