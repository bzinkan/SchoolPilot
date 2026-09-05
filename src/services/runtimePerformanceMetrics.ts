import { getRuntimeMetadata } from "./runtimeMetadata.js";

const INTERVAL_MS = 60_000;
const COUNTER_NAMES = [
  "tenantCheckouts", "poolAcquisitionSuccess", "poolAcquisitionFailure", "auditWriteFailure",
  "aiProviderCalls", "aiProviderFailures", "aiProviderTimeouts", "aiProviderSaturated",
  "dailyRollupSchools", "studentWebSocketAuthAttempt", "studentWebSocketAuthSuccess",
  "studentWebSocketAuthDenied", "studentWebSocketAuthServiceFailure", "studentWebSocketAuthSocketClosed",
  "studentWebSocketRevalidationFailure",
] as const;

export type RuntimePerformanceCounter = typeof COUNTER_NAMES[number];

export type RuntimePerformanceTiming =
  | "poolAcquisitionMs"
  | "aiProviderMs"
  | "dailyRollupMs"
  | "studentWebSocketAuthMs";

type Timing = { count: number; totalMs: number; maxMs: number };
export class RuntimePerformanceMetrics {
  private readonly counters = new Map<RuntimePerformanceCounter, number>();
  private readonly timings = new Map<RuntimePerformanceTiming, Timing>();
  private intervalStartedAt: number;

  constructor(
    private readonly now: () => number = Date.now,
    private readonly sink: (line: string) => void = (line) => console.log(line),
  ) {
    this.intervalStartedAt = Math.floor(now() / INTERVAL_MS) * INTERVAL_MS;
  }

  recordCounter(name: RuntimePerformanceCounter, increment = 1): void {
    if (!Number.isFinite(increment) || increment <= 0) return;
    this.flush();
    this.counters.set(name, (this.counters.get(name) ?? 0) + increment);
  }

  recordTiming(name: RuntimePerformanceTiming, durationMs: number): void {
    if (!Number.isFinite(durationMs) || durationMs < 0) return;
    this.flush();
    const current = this.timings.get(name) ?? { count: 0, totalMs: 0, maxMs: 0 };
    current.count += 1;
    current.totalMs += durationMs;
    current.maxMs = Math.max(current.maxMs, durationMs);
    this.timings.set(name, current);
  }

  snapshot(options: { reset?: boolean } = {}) {
    const snapshot = {
      counters: Object.fromEntries(this.counters) as Partial<Record<RuntimePerformanceCounter, number>>,
      timings: Object.fromEntries([...this.timings].map(([key, value]) => [key, { ...value }])) as Partial<
        Record<RuntimePerformanceTiming, Timing>
      >,
    };
    if (options.reset) {
      this.counters.clear();
      this.timings.clear();
    }
    return snapshot;
  }

  flush(options: { final?: boolean } = {}): void {
    const now = this.now();
    while (now >= this.intervalStartedAt + INTERVAL_MS) {
      this.emit(this.intervalStartedAt + INTERVAL_MS);
    }
    if (options.final && (this.counters.size > 0 || this.timings.size > 0)) {
      this.emit(Math.max(now, this.intervalStartedAt));
    }
  }

  private emit(endedAt: number): void {
    const snapshot = this.snapshot();
    const runtime = getRuntimeMetadata();
    const intervalCounters = Object.fromEntries(COUNTER_NAMES.map((name) =>
      [name, snapshot.counters[name] ?? 0]
    )) as Record<RuntimePerformanceCounter, number>;
    const metricValues = Object.fromEntries(COUNTER_NAMES.map((name) =>
      [`Runtime${name[0]!.toUpperCase()}${name.slice(1)}`, intervalCounters[name]]
    ));
    // Fixed aggregate fields only: no tenant, person, device, URL, token, or prompt labels.
    // Every minute has zero-valued failure counters, so quiet health remains observable.
    this.sink(JSON.stringify({
      _aws: {
        Timestamp: this.intervalStartedAt,
        CloudWatchMetrics: [{
          Namespace: "SchoolPilot/RuntimePerformance",
          Dimensions: [["Environment", "Service"]],
          Metrics: Object.keys(metricValues).map((Name) => ({ Name, Unit: "Count" })),
        }],
      },
      event: "schoolpilot_runtime_performance_summary",
      intervalSeconds: (endedAt - this.intervalStartedAt) / 1_000,
      intervalStartedAtUtc: new Date(this.intervalStartedAt).toISOString(),
      intervalEndedAtUtc: new Date(endedAt).toISOString(),
      Environment: runtime.environment,
      Service: runtime.service,
      InstanceId: runtime.instanceId,
      Release: runtime.release,
      counters: intervalCounters,
      timings: snapshot.timings,
      ...metricValues,
    }));
    this.snapshot({ reset: true });
    this.intervalStartedAt = endedAt;
  }
}

const metrics = new RuntimePerformanceMetrics();
export function recordRuntimePerformanceCounter(name: RuntimePerformanceCounter, increment = 1): void {
  metrics.recordCounter(name, increment);
}
export function recordRuntimePerformanceTiming(name: RuntimePerformanceTiming, durationMs: number): void {
  metrics.recordTiming(name, durationMs);
}
export function snapshotRuntimePerformanceMetrics(options: { reset?: boolean } = {}) {
  return metrics.snapshot(options);
}
const timer = setInterval(() => metrics.flush(), INTERVAL_MS);
timer.unref?.();

export function stopRuntimePerformanceMetrics(): void {
  clearInterval(timer);
  metrics.flush({ final: true });
}
