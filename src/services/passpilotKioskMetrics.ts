const KIOSK_METRICS_INTERVAL_MS = 60_000;

export type PasspilotKioskCounter =
  | "authorizationRequests"
  | "authorizationSqlStatements"
  | "authorizationTokenSuccess"
  | "authorizationTokenFailure"
  | "authorizationPinSuccess"
  | "authorizationPinFailure"
  | "authorizationPinCacheHit"
  | "authorizationBcrypt"
  | "tenantCheckouts"
  | "configSqlStatements"
  | "studentsSqlStatements"
  | "snapshotSqlStatements"
  | "snapshotNotModified"
  | "clientHealthAccepted"
  | "clientHealthSuppressed"
  | "clientHealthRejected";

export type PasspilotKioskTiming =
  | "authorizationMs"
  | "configMs"
  | "studentsMs"
  | "snapshotMs";

type TimingSummary = {
  count: number;
  totalMs: number;
  maxMs: number;
};

const counters = new Map<PasspilotKioskCounter, number>();
const timings = new Map<PasspilotKioskTiming, TimingSummary>();
let intervalStartedAtMs =
  Math.floor(Date.now() / KIOSK_METRICS_INTERVAL_MS) * KIOSK_METRICS_INTERVAL_MS;

function incrementCounter(name: PasspilotKioskCounter, increment: number): void {
  counters.set(name, (counters.get(name) ?? 0) + increment);
}

function incrementTiming(name: PasspilotKioskTiming, durationMs: number): void {
  const current = timings.get(name) ?? { count: 0, totalMs: 0, maxMs: 0 };
  current.count += 1;
  current.totalMs += durationMs;
  current.maxMs = Math.max(current.maxMs, durationMs);
  timings.set(name, current);
}

export function recordPasspilotKioskCounter(
  name: PasspilotKioskCounter,
  increment = 1
): void {
  if (!Number.isFinite(increment) || increment <= 0) return;
  flushExpiredPasspilotKioskMetricIntervals(Date.now());
  incrementCounter(name, increment);
}

export function recordPasspilotKioskTiming(
  name: PasspilotKioskTiming,
  durationMs: number
): void {
  if (!Number.isFinite(durationMs) || durationMs < 0) return;
  flushExpiredPasspilotKioskMetricIntervals(Date.now());
  incrementTiming(name, durationMs);
}

export function snapshotPasspilotKioskMetrics(options: { reset?: boolean } = {}): {
  counters: Partial<Record<PasspilotKioskCounter, number>>;
  timings: Partial<Record<PasspilotKioskTiming, TimingSummary>>;
} {
  const counterSnapshot = Object.fromEntries(counters) as Partial<
    Record<PasspilotKioskCounter, number>
  >;
  const timingSnapshot = Object.fromEntries(
    [...timings].map(([name, value]) => [name, { ...value }])
  ) as Partial<Record<PasspilotKioskTiming, TimingSummary>>;
  if (options.reset) {
    counters.clear();
    timings.clear();
  }
  return { counters: counterSnapshot, timings: timingSnapshot };
}

function flushExpiredPasspilotKioskMetricIntervals(nowMs: number): void {
  if (!Number.isFinite(nowMs)) return;
  while (nowMs >= intervalStartedAtMs + KIOSK_METRICS_INTERVAL_MS) {
    const startedAtMs = intervalStartedAtMs;
    const endedAtMs = startedAtMs + KIOSK_METRICS_INTERVAL_MS;
    intervalStartedAtMs = endedAtMs;
    const snapshot = snapshotPasspilotKioskMetrics({ reset: true });
    if (
      Object.keys(snapshot.counters).length === 0 &&
      Object.keys(snapshot.timings).length === 0
    ) {
      continue;
    }

    // Fixed-name, process-wide summaries only. Never add a school, user,
    // student, session, device, PIN/token, URL, or request identifier here.
    console.log(JSON.stringify({
      event: "passpilot_kiosk_hot_path_summary",
      intervalSeconds: KIOSK_METRICS_INTERVAL_MS / 1_000,
      intervalStartedAtUtc: new Date(startedAtMs).toISOString(),
      intervalEndedAtUtc: new Date(endedAtMs).toISOString(),
      ...snapshot,
    }));
  }
}

const metricsTimer = setInterval(
  () => flushExpiredPasspilotKioskMetricIntervals(Date.now()),
  KIOSK_METRICS_INTERVAL_MS
);
metricsTimer.unref?.();
