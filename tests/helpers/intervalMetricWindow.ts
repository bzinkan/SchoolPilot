import type { TestContext } from "node:test";
import type { HeartbeatHotPathCounter } from "../../src/services/heartbeatHotPathMetrics.js";
import type { RuntimePerformanceCounter } from "../../src/services/runtimePerformanceMetrics.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Start after resetting snapshots; retain emitted buckets while real time advances. */
export function captureIntervalMetricWindow(t: TestContext, snapshots: {
  runtime: () => Partial<Record<RuntimePerformanceCounter, number>>;
  hotPath: () => Partial<Record<HeartbeatHotPathCounter, number>>;
}) {
  const emitted = {
    runtime: new Map<string, number>(),
    hotPath: new Map<string, number>(),
  };
  const originalLog = console.log;
  t.mock.method(console, "log", (...args: unknown[]) => {
    for (const arg of args) {
      if (typeof arg !== "string" || !arg.startsWith("{")) continue;
      let event: unknown;
      try { event = JSON.parse(arg); } catch { continue; }
      if (!isRecord(event) || !isRecord(event.counters)) continue;
      const counters = event.event === "schoolpilot_runtime_performance_summary" ? emitted.runtime
        : event.event === "classpilot_heartbeat_hot_path_summary" ? emitted.hotPath : undefined;
      if (!counters) continue;
      for (const [name, value] of Object.entries(event.counters)) {
        if (typeof value === "number" && Number.isFinite(value)) {
          counters.set(name, (counters.get(name) ?? 0) + value);
        }
      }
    }
    originalLog(...args);
  });
  return {
    runtimeCounter: (name: RuntimePerformanceCounter) =>
      (emitted.runtime.get(name) ?? 0) + (snapshots.runtime()[name] ?? 0),
    hotPathCounter: (name: HeartbeatHotPathCounter) =>
      (emitted.hotPath.get(name) ?? 0) + (snapshots.hotPath()[name] ?? 0),
  };
}
