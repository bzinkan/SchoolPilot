import type { ClasspilotRealtimeReadResult } from "./classpilotRealtimeStatus.js";
import { localDateInTimeZone, localDateTimeUtc } from "../util/schoolTime.js";
import { datePlusDays } from "./classpilotSchedulingRules.js";
import { isWithinClasspilotInstructionalWindow } from "./classpilotMonitoringPolicy.js";
import type { HeartbeatTrackingSettings } from "./storage.js";

export const MONITORING_INTERRUPTION_TOLERANCE_MS = 60_000;
export function decideMonitoringInterruption(options: {
  now: number; scopeStartedAt: number; previousLastObservedAt?: number;
  reading: ClasspilotRealtimeReadResult; fullMonitoring: boolean;
}): { state: "observed" | "gap" | "unseen" | "uncertain" | "excluded"; lastObservedAt?: number; reason?: string } {
  if (!options.fullMonitoring) return { state: "excluded", reason: "monitoring_off" };
  const { reading } = options;
  if (["unavailable", "mismatch", "rejected"].includes(reading.status)) return { state: "uncertain" };
  let observed = options.previousLastObservedAt;
  if (reading.status === "hit") {
    if (reading.snapshot.state === "signed_out") return { state: "excluded", reason: "binding_ended" };
    if (reading.snapshot.activityState === "off") return { state: "excluded", reason: "privacy_off" };
    if (!reading.snapshot.heartbeatId || !Number.isFinite(reading.snapshot.observedAt) || reading.snapshot.observedAt > options.now + 5_000) return { state: "uncertain" };
    if (reading.snapshot.observedAt >= options.scopeStartedAt) observed = Math.max(observed ?? 0, reading.snapshot.observedAt);
  }
  if (!observed || observed < options.scopeStartedAt) return { state: "unseen" };
  return { state: options.now - observed > MONITORING_INTERRUPTION_TOLERANCE_MS ? "gap" : "observed", lastObservedAt: observed };
}

type DigestPolicy = Pick<HeartbeatTrackingSettings, "schoolTimezone" | "trackingStartTime" | "trackingEndTime" | "trackingDays" | "instructionalCalendar" | "schedulingDateOverrides">;
export function monitoringDigestWindowForDate(date: string, policy: DigestPolicy) {
  const time = /^([01]\d|2[0-3]):[0-5]\d$/;
  if (!policy.trackingEndTime || !time.test(policy.trackingEndTime) || !policy.trackingStartTime || !time.test(policy.trackingStartTime) || policy.trackingStartTime === policy.trackingEndTime) return null;
  const zone = policy.schoolTimezone || "America/New_York";
  // Evaluate the authoritative rule at the start of this window, not at the
  // later digest time. Overnight windows belong to that original local date.
  const trackingStart = localDateTimeUtc(date, policy.trackingStartTime, zone);
  if (!isWithinClasspilotInstructionalWindow({ ...policy, enableTrackingHours: true, afterHoursMode: "off" }, trackingStart)) return null;
  const endDate = policy.trackingEndTime < policy.trackingStartTime ? datePlusDays(date, 1) : date;
  const endAt = localDateTimeUtc(endDate, policy.trackingEndTime, zone);
  return { localDate: date, startAt: localDateTimeUtc(date, "00:00", zone), endAt, dueAt: new Date(endAt.getTime() + 30 * 60_000) };
}
export function monitoringDigestWindow(now: Date, policy: DigestPolicy) {
  const zone = policy.schoolTimezone || "America/New_York";
  const today = localDateInTimeZone(now, zone);
  for (const date of [today, datePlusDays(today, -1)]) {
    const window = monitoringDigestWindowForDate(date, policy);
    if (window && now >= window.dueAt && now.getTime() < window.dueAt.getTime() + 24 * 60 * 60_000) return window;
  }
  return null;
}
