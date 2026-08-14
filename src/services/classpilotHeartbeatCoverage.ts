import {
  addLocalDays,
  localDateInTimeZone,
  localDateTimeUtc,
} from "../util/schoolTime.js";

export const HEARTBEAT_COVERAGE_ALGORITHM_VERSION = "heartbeat-coverage-v1";
export const HEARTBEAT_HEALTH_TOLERANCE_SECONDS = 60;

export type CoverageInterval = {
  start: Date;
  end: Date;
  studentSessionId?: string | null;
};

export type CoverageHeartbeat = {
  timestamp: Date;
  url?: string | null;
};

export type MonitoringCoverageStatus =
  | "complete"
  | "partial"
  | "none"
  | "not_expected"
  | "unavailable";

export type MonitoringGap = CoverageInterval & {
  durationSeconds: number;
  cause: "unknown";
};

export type ClasspilotTrackingPolicy = {
  enableTrackingHours: boolean;
  trackingStartTime: string | null;
  trackingEndTime: string | null;
  trackingDays: string[];
  schoolTimezone: string;
  afterHoursMode: "off" | "limited" | "full";
};

function clip(interval: CoverageInterval, start: Date, end: Date): CoverageInterval | null {
  const clippedStart = new Date(Math.max(interval.start.getTime(), start.getTime()));
  const clippedEnd = new Date(Math.min(interval.end.getTime(), end.getTime()));
  return clippedEnd > clippedStart ? { ...interval, start: clippedStart, end: clippedEnd } : null;
}

function mergeIntervals(intervals: CoverageInterval[]): CoverageInterval[] {
  const sorted = intervals
    .filter((interval) => interval.end > interval.start)
    .sort((a, b) => a.start.getTime() - b.start.getTime() || a.end.getTime() - b.end.getTime());
  const merged: CoverageInterval[] = [];
  for (const interval of sorted) {
    const last = merged.at(-1);
    if (!last || interval.start > last.end) {
      merged.push({ ...interval });
      continue;
    }
    if (interval.end > last.end) last.end = interval.end;
    if (!last.studentSessionId) last.studentSessionId = interval.studentSessionId;
  }
  return merged;
}

export function subtractCoverageIntervals(
  source: CoverageInterval[],
  exclusions: CoverageInterval[]
): CoverageInterval[] {
  const excluded = mergeIntervals(exclusions);
  const result: CoverageInterval[] = [];
  for (const sourceInterval of mergeIntervals(source)) {
    let pieces = [{ ...sourceInterval }];
    for (const exclusion of excluded) {
      const next: CoverageInterval[] = [];
      for (const piece of pieces) {
        if (exclusion.end <= piece.start || exclusion.start >= piece.end) {
          next.push(piece);
          continue;
        }
        if (exclusion.start > piece.start) {
          next.push({ ...piece, end: new Date(Math.min(exclusion.start.getTime(), piece.end.getTime())) });
        }
        if (exclusion.end < piece.end) {
          next.push({ ...piece, start: new Date(Math.max(exclusion.end.getTime(), piece.start.getTime())) });
        }
      }
      pieces = next;
      if (pieces.length === 0) break;
    }
    result.push(...pieces);
  }
  return mergeIntervals(result);
}

const TRACKING_DAY_NAMES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
] as const;

function validTrackingTime(value: string | null): value is string {
  if (!value || !/^\d{1,2}:\d{2}(?::\d{2})?$/.test(value)) return false;
  const [hour = -1, minute = -1, second = 0] = value.split(":").map(Number);
  return hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59 && second >= 0 && second <= 59;
}

/** Derive intervals where district policy explicitly turns monitoring off. */
export function trackingPolicyDisabledIntervals(
  policy: ClasspilotTrackingPolicy,
  windowStart: Date,
  windowEnd: Date
): CoverageInterval[] {
  if (!policy.enableTrackingHours || policy.afterHoursMode !== "off" || windowEnd <= windowStart) {
    return [];
  }
  const timeZone = policy.schoolTimezone;
  const firstLocalDate = addLocalDays(localDateInTimeZone(windowStart, timeZone), -1);
  const lastLocalDate = addLocalDays(localDateInTimeZone(windowEnd, timeZone), 1);
  const activeDays = new Set(policy.trackingDays);
  const trackingStartTime = policy.trackingStartTime;
  const trackingEndTime = policy.trackingEndTime;
  const activeIntervals: CoverageInterval[] = [];

  for (let localDate = firstLocalDate, guard = 0; localDate <= lastLocalDate && guard < 370; guard += 1) {
    const [year, month, day] = localDate.split("-").map(Number);
    const dayName = TRACKING_DAY_NAMES[new Date(Date.UTC(year!, month! - 1, day!)).getUTCDay()]!;
    if (activeDays.size === 0 || activeDays.has(dayName)) {
      if (validTrackingTime(trackingStartTime) && validTrackingTime(trackingEndTime)) {
        const start = localDateTimeUtc(localDate, trackingStartTime, timeZone);
        const [startHour = 0, startMinute = 0, startSecond = 0] = trackingStartTime.split(":").map(Number);
        const [endHour = 0, endMinute = 0, endSecond = 0] = trackingEndTime.split(":").map(Number);
        const startSeconds = startHour * 3600 + startMinute * 60 + startSecond;
        const endSeconds = endHour * 3600 + endMinute * 60 + endSecond;
        const endLocalDate = endSeconds <= startSeconds ? addLocalDays(localDate, 1) : localDate;
        activeIntervals.push({
          start,
          end: localDateTimeUtc(endLocalDate, trackingEndTime, timeZone),
        });
      } else {
        activeIntervals.push({
          start: localDateTimeUtc(localDate, "00:00:00", timeZone),
          end: localDateTimeUtc(addLocalDays(localDate, 1), "00:00:00", timeZone),
        });
      }
    }
    localDate = addLocalDays(localDate, 1);
  }

  return subtractCoverageIntervals(
    [{ start: windowStart, end: windowEnd }],
    activeIntervals
  );
}

export function calculateHeartbeatCoverage(options: {
  windowStart: Date;
  windowEnd: Date;
  authenticatedIntervals: CoverageInterval[];
  excludedIntervals?: CoverageInterval[];
  heartbeats: CoverageHeartbeat[];
}) {
  const auth = options.authenticatedIntervals
    .map((interval) => clip(interval, options.windowStart, options.windowEnd))
    .filter((interval): interval is CoverageInterval => !!interval);
  const exclusions = (options.excludedIntervals || [])
    .map((interval) => clip(interval, options.windowStart, options.windowEnd))
    .filter((interval): interval is CoverageInterval => !!interval);
  const eligibleIntervals = subtractCoverageIntervals(auth, exclusions);
  const eligibleSeconds = Math.round(eligibleIntervals.reduce(
    (total, interval) => total + (interval.end.getTime() - interval.start.getTime()) / 1000,
    0
  ));
  if (eligibleSeconds === 0) {
    return {
      status: "not_expected" as MonitoringCoverageStatus,
      eligibleIntervals,
      eligibleSeconds: 0,
      observedSeconds: 0,
      gapSeconds: 0,
      coveragePercent: null as number | null,
      heartbeatCount: 0,
      firstObservedAt: null as Date | null,
      lastObservedAt: null as Date | null,
      gaps: [] as MonitoringGap[],
      topDomains: [] as Array<{ domain: string; seconds: number; visits: number }>,
    };
  }

  const uniqueHeartbeats = Array.from(new Map(
    options.heartbeats
      .filter((heartbeat) => heartbeat.timestamp >= options.windowStart && heartbeat.timestamp < options.windowEnd)
      .map((heartbeat) => [`${heartbeat.timestamp.getTime()}|${heartbeat.url || ""}`, heartbeat])
  ).values()).sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
  const eligibleHeartbeats = uniqueHeartbeats.filter((heartbeat) =>
    eligibleIntervals.some((interval) => heartbeat.timestamp >= interval.start && heartbeat.timestamp < interval.end)
  );
  const toleranceMs = HEARTBEAT_HEALTH_TOLERANCE_SECONDS * 1000;
  const gaps: MonitoringGap[] = [];

  for (const interval of eligibleIntervals) {
    const within = eligibleHeartbeats.filter(
      (heartbeat) => heartbeat.timestamp >= interval.start && heartbeat.timestamp < interval.end
    );
    if (within.length === 0) {
      gaps.push({
        ...interval,
        durationSeconds: Math.round((interval.end.getTime() - interval.start.getTime()) / 1000),
        cause: "unknown",
      });
      continue;
    }
    const first = within[0]!.timestamp;
    if (first.getTime() - interval.start.getTime() > toleranceMs) {
      const end = new Date(first.getTime() - toleranceMs);
      gaps.push({
        ...interval,
        end,
        durationSeconds: Math.round((end.getTime() - interval.start.getTime()) / 1000),
        cause: "unknown",
      });
    }
    for (let index = 1; index < within.length; index += 1) {
      const previous = within[index - 1]!.timestamp;
      const current = within[index]!.timestamp;
      if (current.getTime() - previous.getTime() > toleranceMs) {
        const start = new Date(previous.getTime() + toleranceMs);
        gaps.push({
          ...interval,
          start,
          end: current,
          durationSeconds: Math.round((current.getTime() - start.getTime()) / 1000),
          cause: "unknown",
        });
      }
    }
    const last = within.at(-1)!.timestamp;
    if (interval.end.getTime() - last.getTime() > toleranceMs) {
      const start = new Date(last.getTime() + toleranceMs);
      gaps.push({
        ...interval,
        start,
        durationSeconds: Math.round((interval.end.getTime() - start.getTime()) / 1000),
        cause: "unknown",
      });
    }
  }

  const gapSeconds = Math.min(eligibleSeconds, gaps.reduce((total, gap) => total + gap.durationSeconds, 0));
  const observedSeconds = Math.max(0, eligibleSeconds - gapSeconds);
  const coveragePercent = Math.max(0, Math.min(100, Math.round((observedSeconds / eligibleSeconds) * 100)));
  const domains = new Map<string, { seconds: number; visits: number }>();
  for (const heartbeat of eligibleHeartbeats) {
    if (!heartbeat.url) continue;
    try {
      const url = new URL(heartbeat.url);
      if (!/^https?:$/.test(url.protocol)) continue;
      const domain = url.hostname.toLowerCase().replace(/^www\./, "");
      if (!domain) continue;
      const value = domains.get(domain) || { seconds: 0, visits: 0 };
      value.seconds += 10;
      value.visits += 1;
      domains.set(domain, value);
    } catch {
      // Invalid URLs are excluded from domain rollups, never from coverage.
    }
  }

  const status: MonitoringCoverageStatus = eligibleHeartbeats.length === 0
    ? "none"
    : gapSeconds === 0
      ? "complete"
      : "partial";
  return {
    status,
    eligibleIntervals,
    eligibleSeconds,
    observedSeconds,
    gapSeconds,
    coveragePercent,
    heartbeatCount: eligibleHeartbeats.length,
    firstObservedAt: eligibleHeartbeats[0]?.timestamp || null,
    lastObservedAt: eligibleHeartbeats.at(-1)?.timestamp || null,
    gaps,
    topDomains: Array.from(domains.entries())
      .sort((a, b) => b[1].seconds - a[1].seconds || a[0].localeCompare(b[0]))
      .slice(0, 10)
      .map(([domain, value]) => ({ domain, ...value })),
  };
}
