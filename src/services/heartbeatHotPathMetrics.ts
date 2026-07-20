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

export function recordHeartbeatHotPathCounter(
  name: HeartbeatHotPathCounter,
  increment = 1
): void {
  if (!Number.isFinite(increment) || increment <= 0) return;
  counters.set(name, (counters.get(name) ?? 0) + increment);
}

export function recordHeartbeatHotPathTiming(
  name: HeartbeatHotPathTiming,
  durationMs: number
): void {
  if (!Number.isFinite(durationMs) || durationMs < 0) return;
  const current = timings.get(name) ?? { count: 0, totalMs: 0, maxMs: 0 };
  current.count += 1;
  current.totalMs += durationMs;
  current.maxMs = Math.max(current.maxMs, durationMs);
  timings.set(name, current);
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

const metricsTimer = setInterval(() => {
  const snapshot = snapshotHeartbeatHotPathMetrics({ reset: true });
  if (
    Object.keys(snapshot.counters).length === 0 &&
    Object.keys(snapshot.timings).length === 0
  ) {
    return;
  }

  // Deliberately process-wide and label-free: never add school, user, student,
  // device, URL, Redis key, or request identifiers to this event.
  console.log(JSON.stringify({
    event: "classpilot_heartbeat_hot_path_summary",
    intervalSeconds: HOT_PATH_METRICS_INTERVAL_MS / 1_000,
    ...snapshot,
  }));
}, HOT_PATH_METRICS_INTERVAL_MS);
metricsTimer.unref?.();
