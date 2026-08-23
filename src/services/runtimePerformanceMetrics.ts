const INTERVAL_MS = 60_000;

export type RuntimePerformanceCounter =
  | "tenantCheckouts"
  | "poolAcquisitionSuccess"
  | "poolAcquisitionFailure"
  | "aiProviderCalls"
  | "aiProviderFailures"
  | "aiProviderTimeouts"
  | "aiProviderSaturated"
  | "dailyRollupSchools";

export type RuntimePerformanceTiming =
  | "poolAcquisitionMs"
  | "aiProviderMs"
  | "dailyRollupMs";

type Timing = { count: number; totalMs: number; maxMs: number };
const counters = new Map<RuntimePerformanceCounter, number>();
const timings = new Map<RuntimePerformanceTiming, Timing>();
let intervalStartedAt = Math.floor(Date.now() / INTERVAL_MS) * INTERVAL_MS;

export function recordRuntimePerformanceCounter(
  name: RuntimePerformanceCounter,
  increment = 1
): void {
  if (!Number.isFinite(increment) || increment <= 0) return;
  flushRuntimePerformanceMetrics(Date.now());
  counters.set(name, (counters.get(name) ?? 0) + increment);
}

export function recordRuntimePerformanceTiming(
  name: RuntimePerformanceTiming,
  durationMs: number
): void {
  if (!Number.isFinite(durationMs) || durationMs < 0) return;
  flushRuntimePerformanceMetrics(Date.now());
  const current = timings.get(name) ?? { count: 0, totalMs: 0, maxMs: 0 };
  current.count += 1;
  current.totalMs += durationMs;
  current.maxMs = Math.max(current.maxMs, durationMs);
  timings.set(name, current);
}

export function snapshotRuntimePerformanceMetrics(options: { reset?: boolean } = {}) {
  const snapshot = {
    counters: Object.fromEntries(counters) as Partial<Record<RuntimePerformanceCounter, number>>,
    timings: Object.fromEntries([...timings].map(([key, value]) => [key, { ...value }])) as Partial<
      Record<RuntimePerformanceTiming, Timing>
    >,
  };
  if (options.reset) {
    counters.clear();
    timings.clear();
  }
  return snapshot;
}

function flushRuntimePerformanceMetrics(now: number): void {
  while (now >= intervalStartedAt + INTERVAL_MS) {
    const startedAt = intervalStartedAt;
    intervalStartedAt += INTERVAL_MS;
    const snapshot = snapshotRuntimePerformanceMetrics({ reset: true });
    if (!Object.keys(snapshot.counters).length && !Object.keys(snapshot.timings).length) continue;
    // Fixed aggregate fields only: no tenant, person, device, URL, token, or prompt labels.
    console.log(JSON.stringify({
      event: "schoolpilot_runtime_performance_summary",
      intervalSeconds: INTERVAL_MS / 1_000,
      intervalStartedAtUtc: new Date(startedAt).toISOString(),
      intervalEndedAtUtc: new Date(intervalStartedAt).toISOString(),
      ...snapshot,
    }));
  }
}

const timer = setInterval(() => flushRuntimePerformanceMetrics(Date.now()), INTERVAL_MS);
timer.unref?.();
