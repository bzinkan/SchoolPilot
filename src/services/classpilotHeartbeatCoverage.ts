import {
  addLocalDays,
  localDateInTimeZone,
  localDateTimeUtc,
} from "../util/schoolTime.js";
import {
  classpilotActivityKey,
  classifyClasspilotActivity,
  type ClasspilotTopActivity,
} from "./classpilotActivityAttribution.js";

export const HEARTBEAT_COVERAGE_ALGORITHM_VERSION = "heartbeat-coverage-v2";
export const HEARTBEAT_COVERAGE_ALGORITHM_VERSION_V1 = "heartbeat-coverage-v1";
export const HEARTBEAT_HEALTH_TOLERANCE_SECONDS = 60;
export const HEARTBEAT_ATTRIBUTION_LIMIT_SECONDS = 15;

export type CoverageInterval = {
  start: Date;
  end: Date;
  studentSessionId?: string | null;
};

export type CoverageHeartbeat = {
  timestamp: Date;
  url?: string | null;
  category?: string | null;
  teacherIntentExempt?: boolean;
};

export type OffTaskEvent = {
  domain: string;
  category: "non-educational";
  start: Date;
  end: Date;
  seconds: number;
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

function normalizedHeartbeatDomain(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (!/^https?:$/.test(url.protocol)) return null;
    return url.hostname.toLowerCase().replace(/^www\./, "") || null;
  } catch {
    return null;
  }
}

function normalizedHeartbeatCategory(
  value: string | null | undefined
): "educational" | "non-educational" | "unknown" {
  if (value === "educational" || value === "non-educational") return value;
  return "unknown";
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
      topActivities: [] as ClasspilotTopActivity[],
      unclassifiedSeconds: 0,
      offTaskSeconds: 0,
      offTaskEventCount: 0,
      offTaskEvents: [] as OffTaskEvent[],
    };
  }

  // One observed instant can only describe one page. A stable, timestamp-first
  // selection prevents duplicate/navigation-burst samples from manufacturing
  // additional time while keeping repeated materialization deterministic.
  const uniqueHeartbeats = Array.from(new Map(
    options.heartbeats
      .filter((heartbeat) => heartbeat.timestamp >= options.windowStart && heartbeat.timestamp < options.windowEnd)
      .sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime()
        || String(a.url || "").localeCompare(String(b.url || ""))
        || String(a.category || "").localeCompare(String(b.category || "")))
      .map((heartbeat) => [heartbeat.timestamp.getTime(), heartbeat])
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
  const attributionLimitMs = HEARTBEAT_ATTRIBUTION_LIMIT_SECONDS * 1000;
  const domains = new Map<string, { milliseconds: number; visits: number }>();
  const activities = new Map<string, {
    kind: ClasspilotTopActivity["kind"];
    domain: string;
    milliseconds: number;
    visits: number;
  }>();
  const offTaskSegments: Array<{
    domain: string;
    category: "non-educational";
    start: Date;
    end: Date;
  }> = [];
  let classifiedMilliseconds = 0;

  for (const interval of eligibleIntervals) {
    const within = eligibleHeartbeats.filter(
      (heartbeat) => heartbeat.timestamp >= interval.start && heartbeat.timestamp < interval.end
    );
    let previousDomain: string | null = null;
    let previousActivityKey: string | null = null;
    for (let index = 0; index < within.length; index += 1) {
      const heartbeat = within[index]!;
      const nextTimestamp = within[index + 1]?.timestamp.getTime() ?? interval.end.getTime();
      const startMs = Math.max(interval.start.getTime(), heartbeat.timestamp.getTime());
      const endMs = Math.min(interval.end.getTime(), startMs + attributionLimitMs, nextTimestamp);
      if (endMs <= startMs) continue;

      const domain = normalizedHeartbeatDomain(heartbeat.url);
      const activity = classifyClasspilotActivity(heartbeat.url);
      const category = normalizedHeartbeatCategory(heartbeat.category);
      if (domain) {
        const value = domains.get(domain) || { milliseconds: 0, visits: 0 };
        value.milliseconds += endMs - startMs;
        if (domain !== previousDomain) value.visits += 1;
        domains.set(domain, value);
      }
      previousDomain = domain;
      if (activity) {
        const activityKey = classpilotActivityKey(activity);
        const value = activities.get(activityKey) || {
          ...activity,
          milliseconds: 0,
          visits: 0,
        };
        value.milliseconds += endMs - startMs;
        if (activityKey !== previousActivityKey) value.visits += 1;
        activities.set(activityKey, value);
        previousActivityKey = activityKey;
      } else {
        previousActivityKey = null;
      }

      // Only a known category is removed from the uncertainty bucket. An
      // unknown/missing classification can still contribute a known domain to
      // the top-domain dimension, but can never become off-task time.
      if (category !== "unknown") classifiedMilliseconds += endMs - startMs;
      if (domain && category === "non-educational" && heartbeat.teacherIntentExempt !== true) {
        offTaskSegments.push({
          domain,
          category,
          start: new Date(startMs),
          end: new Date(endMs),
        });
      }
    }
  }

  const offTaskEvents: OffTaskEvent[] = [];
  for (const segment of offTaskSegments) {
    const previous = offTaskEvents.at(-1);
    if (previous
      && previous.domain === segment.domain
      && previous.category === segment.category
      && segment.start.getTime() - previous.end.getTime() <= 30_000) {
      previous.end = new Date(Math.max(previous.end.getTime(), segment.end.getTime()));
      previous.seconds = Math.round((previous.end.getTime() - previous.start.getTime()) / 1000);
      continue;
    }
    offTaskEvents.push({
      ...segment,
      seconds: Math.round((segment.end.getTime() - segment.start.getTime()) / 1000),
    });
  }
  const offTaskSeconds = Math.min(
    observedSeconds,
    Math.round(offTaskSegments.reduce(
      (total, segment) => total + segment.end.getTime() - segment.start.getTime(),
      0
    ) / 1000)
  );
  const unclassifiedSeconds = Math.max(
    0,
    observedSeconds - Math.min(observedSeconds, Math.round(classifiedMilliseconds / 1000))
  );

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
      .sort((a, b) => b[1].milliseconds - a[1].milliseconds || a[0].localeCompare(b[0]))
      .slice(0, 10)
      .map(([domain, value]) => ({
        domain,
        seconds: Math.round(value.milliseconds / 1000),
        visits: value.visits,
      })),
    topActivities: Array.from(activities.values())
      .sort((a, b) => b.milliseconds - a.milliseconds
        || a.kind.localeCompare(b.kind)
        || a.domain.localeCompare(b.domain))
      .slice(0, 10)
      .map(({ kind, domain, milliseconds, visits }) => ({
        kind,
        domain,
        seconds: Math.round(milliseconds / 1000),
        visits,
      })),
    unclassifiedSeconds,
    offTaskSeconds,
    offTaskEventCount: offTaskEvents.length,
    offTaskEvents,
  };
}

/**
 * Frozen v1 arithmetic. Do not change this implementation: report rows whose
 * stored reportVersion is 1 must continue to materialize exactly as they did
 * before report-v2 existed, regardless of the current rollout mode.
 */
export function calculateHeartbeatCoverageV1(options: {
  windowStart: Date;
  windowEnd: Date;
  authenticatedIntervals: CoverageInterval[];
  excludedIntervals?: CoverageInterval[];
  heartbeats: Array<{ timestamp: Date; url?: string | null }>;
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
      topActivities: [] as ClasspilotTopActivity[],
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
  const activities = new Map<string, ClasspilotTopActivity>();
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

      const activity = classifyClasspilotActivity(heartbeat.url);
      if (activity) {
        const activityKey = classpilotActivityKey(activity);
        const activityValue = activities.get(activityKey) || {
          ...activity,
          seconds: 0,
          visits: 0,
        };
        activityValue.seconds += 10;
        activityValue.visits += 1;
        activities.set(activityKey, activityValue);
      }
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
    topActivities: Array.from(activities.values())
      .sort((a, b) => b.seconds - a.seconds
        || a.kind.localeCompare(b.kind)
        || a.domain.localeCompare(b.domain))
      .slice(0, 10),
  };
}
