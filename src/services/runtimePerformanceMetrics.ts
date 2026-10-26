import { getRuntimeMetadata } from "./runtimeMetadata.js";
import { STUDENT_SIGN_IN_COUNTER_NAMES } from "./classpilotStudentSignInDiagnosticsContract.js";
import { FAB_SYNC_PENDING_COUNTER_NAMES } from "./classpilotFabSyncDiagnosticsContract.js";

const INTERVAL_MS = 60_000;
const COUNTER_NAMES = [
  "tenantCheckouts", "poolAcquisitionSuccess", "poolAcquisitionFailure", "auditWriteFailure",
  "apiPoolReadinessStalled", "apiPoolReadinessRecovered", "apiPoolReadinessProbeDeferred",
  "requestDisconnectedBeforeBodyParser", "requestBodyParserCancelled", "requestBodyParserLiveUnreadable",
  "aiProviderCalls", "aiProviderFailures", "aiProviderTimeouts", "aiProviderSaturated",
  "importStageCompleted", "importStageRetry", "importStageFailed",
  "dailyRollupSchools", "studentWebSocketAuthAttempt", "studentWebSocketAuthSuccess",
  "studentWebSocketAuthDenied", "studentWebSocketAuthServiceFailure", "studentWebSocketAuthSocketClosed",
  "studentWebSocketRevalidationFailure",
  "studentRelayBatchNotAdmitted",
  "safetyAlertsCreated", "safetyObservationsMerged", "safetyExceptionsApplied",
  "safetyEmailsSent", "safetyFollowupsSent", "safetyEmailFailures", "safetyEmailUnknown",
  "studentChatFanOutDelivered", "studentChatFanOutMissed",
  "chatSafetyScanFailed", "chatSafetyAlertsRecorded",
  "fabSyncLocalDeliveryMissed", "fabSyncPendingMarked", "fabSyncPendingMarkFallback",
  "fabSyncPendingServed", "fabSyncPendingTakeUnavailable",
  // Teacher-initiated student sign-out: requested targets, sessions actually
  // ended server-side, and the difference (unavailable, refused, or failed).
  "classpilotStudentSignOutRequested", "classpilotStudentSignOutEnded", "classpilotStudentSignOutNotEnded",
  // Transient (one-shot) command lane: targets expired by the deadline sweep,
  // targets expired early because a later timer command or poll close
  // superseded them, un-received timer/poll frames replayed on student
  // WebSocket auth-success, and replay preparations that failed (degraded to
  // no replay; authentication is unaffected).
  "transientCommandTargetExpired", "transientCommandTargetSuperseded", "transientCommandReplayedOnAuth",
  "transientCommandReplayFailed",
  ...STUDENT_SIGN_IN_COUNTER_NAMES,
  ...FAB_SYNC_PENDING_COUNTER_NAMES,
] as const;

export type RuntimePerformanceCounter = typeof COUNTER_NAMES[number];

export type RuntimePerformanceTiming =
  | "poolAcquisitionMs"
  | "aiProviderMs"
  | "importStageAdmissionMs"
  | "importRenderMs"
  | "importDetectionMs"
  | "importExtractionMs"
  | "importEvidenceMs"
  | "dailyRollupMs"
  | "studentWebSocketAuthMs"
  | "studentRelayBatchQueueMs";

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

  /** One terminal outcome and its reason must land in the same interval. */
  recordCounters(increments: Partial<Record<RuntimePerformanceCounter, number>>): void {
    const entries = Object.entries(increments).filter(([name, increment]) =>
      COUNTER_NAMES.includes(name as RuntimePerformanceCounter)
      && typeof increment === "number" && Number.isFinite(increment) && increment > 0
    ) as Array<[RuntimePerformanceCounter, number]>;
    if (entries.length === 0) return;
    this.flush();
    for (const [name, increment] of entries) {
      this.counters.set(name, (this.counters.get(name) ?? 0) + increment);
    }
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
    // Every minute's log record still carries every counter, zeros included, so quiet
    // health remains observable in CloudWatch Logs. Only counters that moved in the
    // interval are declared as CloudWatch metrics: an all-zero series is billed like an
    // active one, and the alarm on this namespace treats missing data as not breaching.
    const activeMetricNames = Object.keys(metricValues).filter((name) => (metricValues[name] ?? 0) > 0);
    // EMF allows 100 definitions total per log event, across all directives.
    // https://docs.aws.amazon.com/en_en/AmazonCloudWatch/latest/monitoring/CloudWatch_Embedded_Metric_Format_Specification.html
    // An overflowing interval keeps one canonical zero-inclusive summary and
    // uses separately named metric-only records, never duplicate summaries.
    const intervalStartedAt = this.intervalStartedAt;
    const splitMetrics = activeMetricNames.length > 100;
    const metricDirectives = [];
    for (let offset = 0; offset < activeMetricNames.length; offset += 100) {
      metricDirectives.push({
        Namespace: "SchoolPilot/RuntimePerformance",
        Dimensions: [["Environment", "Service"]],
        Metrics: activeMetricNames.slice(offset, offset + 100).map((Name) => ({ Name, Unit: "Count" })),
      });
    }
    this.sink(JSON.stringify({
      ...(activeMetricNames.length > 0 && !splitMetrics ? {
        _aws: {
          Timestamp: intervalStartedAt,
          CloudWatchMetrics: metricDirectives,
        },
      } : {}),
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
    if (splitMetrics) {
      for (const directive of metricDirectives) {
        try {
          this.sink(JSON.stringify({
            _aws: { Timestamp: intervalStartedAt, CloudWatchMetrics: [directive] },
            event: "schoolpilot_runtime_performance_metrics",
            Environment: runtime.environment,
            Service: runtime.service,
            ...Object.fromEntries(directive.Metrics.map(({ Name }) => [Name, metricValues[Name]])),
          }));
        } catch {
          // The canonical interval already succeeded and is committed above.
          // A supplementary metric failure cannot replay its summary or any
          // product effect. Do not recursively log or retry this metric batch.
        }
      }
    }
  }
}

const metrics = new RuntimePerformanceMetrics();
export function recordRuntimePerformanceCounter(name: RuntimePerformanceCounter, increment = 1): void {
  metrics.recordCounter(name, increment);
}
export function recordRuntimePerformanceCounters(increments: Partial<Record<RuntimePerformanceCounter, number>>): void {
  metrics.recordCounters(increments);
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
