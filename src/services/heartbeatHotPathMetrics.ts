import {
  CLASSPILOT_HISTORY_FALLBACK_QUERY_IDENTITY_VERSION,
  type ClasspilotHistoryFallbackSqlShapeIdentity,
} from "./classpilotHistoryFallbackSqlIdentity.js";

const HOT_PATH_METRICS_INTERVAL_MS = 60_000;

export type HeartbeatHotPathCounter =
  | "heartbeatCryptoAuth"
  | "heartbeatRecorded"
  | "heartbeatInactiveSession"
  | "heartbeatReplacedSession"
  | "classificationImmediate"
  | "classificationImmediateRetries"
  | "classificationImmediateFailures"
  | "classificationQueued"
  | "classificationBatchFlushes"
  | "classificationBatchRows"
  | "classificationBatchRetries"
  | "classificationBatchFailures"
  | "tileAuthScopeLoadsLive"
  | "tileAuthScopeLoadsHistory"
  | "tileAuthCoalescedLive"
  | "tileAuthCoalescedHistory"
  | "tileCacheWrites"
  | "tileCacheHits"
  | "tileCacheMisses"
  | "tileCacheFallbacks"
  | "tileCacheErrors"
  | "tileHistoryDatabaseReads"
  | "tileAdmissionScreenshot"
  | "tileAdmissionHistory"
  | "tileAdmissionRejectedScreenshot"
  | "tileAdmissionRejectedHistory"
  | "tileBatchScreenshotRequests"
  | "tileBatchHistoryRequests"
  | "tileBatchScreenshotItems"
  | "tileBatchHistoryItems"
  | "tileBatchAuthorizedItems"
  | "tileBatchScreenshotFallbackItems"
  | "tileBatchHistoryFallbackItems";

export type HeartbeatHotPathTiming =
  | "heartbeatDatabaseMs"
  | "classificationImmediateMs"
  | "classificationBatchMs"
  | "tileAuthLiveMs"
  | "tileAuthHistoryMs"
  | "tileHistoryDatabaseMs"
  | "tileBatchAuthorizationMs"
  | "tileBatchScreenshotRedisMs"
  | "tileBatchHistoryRedisMs"
  | "tileBatchHistoryDatabaseMs";

type TimingSummary = {
  count: number;
  totalMs: number;
  maxMs: number;
};

const counters = new Map<HeartbeatHotPathCounter, number>();
const timings = new Map<HeartbeatHotPathTiming, TimingSummary>();
let metricsIntervalStartedAtMs = Math.floor(
  Date.now() / HOT_PATH_METRICS_INTERVAL_MS
) * HOT_PATH_METRICS_INTERVAL_MS;
let historyFallbackSqlIdentity:
  ClasspilotHistoryFallbackSqlShapeIdentity | undefined;
let apiRuntimeTaskDefinitionSha256: string | undefined;

export function bindHeartbeatHotPathApiRuntimeTaskDefinitionSha256(
  taskDefinitionSha256: string
): void {
  if (!/^[a-f0-9]{64}$/.test(taskDefinitionSha256)) {
    throw new Error("heartbeat_hot_path_api_runtime_identity_invalid");
  }
  if (
    apiRuntimeTaskDefinitionSha256 &&
    apiRuntimeTaskDefinitionSha256 !== taskDefinitionSha256
  ) {
    throw new Error("heartbeat_hot_path_api_runtime_identity_changed");
  }
  apiRuntimeTaskDefinitionSha256 = taskDefinitionSha256;
}

export function bindHeartbeatHotPathHistoryFallbackSqlIdentity(
  identity: ClasspilotHistoryFallbackSqlShapeIdentity
): void {
  if (
    identity.version !== CLASSPILOT_HISTORY_FALLBACK_QUERY_IDENTITY_VERSION ||
    !/^[a-f0-9]{64}$/.test(identity.compiledSqlSha256) ||
    !/^[a-f0-9]{64}$/.test(identity.parameterTypeSignatureSha256)
  ) {
    throw new Error("history_fallback_sql_shape_identity_invalid");
  }
  if (
    historyFallbackSqlIdentity &&
    (historyFallbackSqlIdentity.compiledSqlSha256 !==
      identity.compiledSqlSha256 ||
      historyFallbackSqlIdentity.parameterTypeSignatureSha256 !==
        identity.parameterTypeSignatureSha256)
  ) {
    throw new Error("history_fallback_sql_shape_identity_changed");
  }
  historyFallbackSqlIdentity = { ...identity };
}

export function recordHeartbeatHotPathCounter(
  name: HeartbeatHotPathCounter,
  increment = 1
): void {
  if (!Number.isFinite(increment) || increment <= 0) return;
  flushExpiredHeartbeatHotPathMetricIntervals(Date.now());
  incrementHeartbeatHotPathCounter(name, increment);
}

function incrementHeartbeatHotPathCounter(
  name: HeartbeatHotPathCounter,
  increment: number
): void {
  counters.set(name, (counters.get(name) ?? 0) + increment);
}

export function recordHeartbeatHotPathTiming(
  name: HeartbeatHotPathTiming,
  durationMs: number
): void {
  if (!Number.isFinite(durationMs) || durationMs < 0) return;
  flushExpiredHeartbeatHotPathMetricIntervals(Date.now());
  incrementHeartbeatHotPathTiming(name, durationMs);
}

function incrementHeartbeatHotPathTiming(
  name: HeartbeatHotPathTiming,
  durationMs: number
): void {
  const current = timings.get(name) ?? { count: 0, totalMs: 0, maxMs: 0 };
  current.count += 1;
  current.totalMs += durationMs;
  current.maxMs = Math.max(current.maxMs, durationMs);
  timings.set(name, current);
}

export function recordHeartbeatTileHistoryFallbackDatabaseRead(
  fallbackItemCount: number,
  durationMs: number
): void {
  if (
    !Number.isInteger(fallbackItemCount) ||
    fallbackItemCount <= 0 ||
    !Number.isFinite(durationMs) ||
    durationMs < 0
  ) {
    return;
  }
  // Rotate exactly once after the SQL statement settles so its cohort size
  // and successful database-read timing cannot land in different evidence
  // intervals when a fast query crosses a scheduled boundary.
  flushExpiredHeartbeatHotPathMetricIntervals(Date.now());
  incrementHeartbeatHotPathCounter(
    "tileBatchHistoryFallbackItems",
    fallbackItemCount
  );
  incrementHeartbeatHotPathTiming("tileBatchHistoryDatabaseMs", durationMs);
}

export function snapshotHeartbeatHotPathMetrics(options: {
  reset?: boolean;
} = {}): {
  counters: Partial<Record<HeartbeatHotPathCounter, number>>;
  timings: Partial<Record<HeartbeatHotPathTiming, TimingSummary>>;
} {
  const counterSnapshot = Object.fromEntries(counters) as Partial<
    Record<HeartbeatHotPathCounter, number>
  >;
  const timingSnapshot = Object.fromEntries(
    [...timings].map(([name, value]) => [name, { ...value }])
  ) as Partial<Record<HeartbeatHotPathTiming, TimingSummary>>;
  if (options.reset) {
    counters.clear();
    timings.clear();
  }
  return { counters: counterSnapshot, timings: timingSnapshot };
}

export function buildHeartbeatHotPathSummaryEvent(snapshot: ReturnType<
  typeof snapshotHeartbeatHotPathMetrics
>, interval: {
  startedAt: Date;
  endedAt: Date;
}): Record<string, unknown> {
  const startedAtMs = interval.startedAt.getTime();
  const endedAtMs = interval.endedAt.getTime();
  if (
    !Number.isFinite(startedAtMs) ||
    !Number.isFinite(endedAtMs) ||
    startedAtMs % HOT_PATH_METRICS_INTERVAL_MS !== 0 ||
    endedAtMs - startedAtMs !== HOT_PATH_METRICS_INTERVAL_MS
  ) {
    throw new Error("heartbeat_hot_path_interval_invalid");
  }
  return {
    event: "classpilot_heartbeat_hot_path_summary",
    intervalSeconds: HOT_PATH_METRICS_INTERVAL_MS / 1_000,
    intervalStartedAtUtc: interval.startedAt.toISOString(),
    intervalEndedAtUtc: interval.endedAt.toISOString(),
    ...(historyFallbackSqlIdentity
      ? {
          historyFallbackSqlIdentityVersion:
            historyFallbackSqlIdentity.version,
          historyFallbackSqlIdentitySha256:
            historyFallbackSqlIdentity.compiledSqlSha256,
        }
      : {}),
    ...(apiRuntimeTaskDefinitionSha256
      ? { apiRuntimeTaskDefinitionSha256 }
      : {}),
    ...snapshot,
  };
}

function flushExpiredHeartbeatHotPathMetricIntervals(nowMs: number): void {
  if (!Number.isFinite(nowMs)) return;
  while (nowMs >= metricsIntervalStartedAtMs + HOT_PATH_METRICS_INTERVAL_MS) {
    const intervalStartedAtMs = metricsIntervalStartedAtMs;
    const intervalEndedAtMs = intervalStartedAtMs + HOT_PATH_METRICS_INTERVAL_MS;
    metricsIntervalStartedAtMs = intervalEndedAtMs;
    const snapshot = snapshotHeartbeatHotPathMetrics({ reset: true });
    if (
      Object.keys(snapshot.counters).length === 0 &&
      Object.keys(snapshot.timings).length === 0
    ) {
      continue;
    }

    // Deliberately process-wide and label-free: never add school, user,
    // student, device, URL, Redis key, or request identifiers to this event.
    // The bounds use the UTC-minute lattice rather than callback wall times,
    // so event-loop jitter cannot make a nominal PI bucket ambiguous.
    console.log(JSON.stringify(buildHeartbeatHotPathSummaryEvent(snapshot, {
      startedAt: new Date(intervalStartedAtMs),
      endedAt: new Date(intervalEndedAtMs),
    })));
  }
}

const metricsTimer = setInterval(
  () => flushExpiredHeartbeatHotPathMetricIntervals(Date.now()),
  HOT_PATH_METRICS_INTERVAL_MS
);
metricsTimer.unref?.();
