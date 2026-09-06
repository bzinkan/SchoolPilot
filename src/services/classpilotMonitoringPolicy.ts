import type { HeartbeatTrackingSettings } from "./storage.js";
import type { RequestHandler } from "express";
import { datePlusDays, dateWeekday, isSchedulingInstructionalDate } from "./classpilotSchedulingRules.js";

export const CLASSPILOT_SAFETY_ONLY_CAPABILITY = "afterHoursSafetyOnlyV1";
export type ClasspilotMonitoringMode = "full" | "safety_only" | "off";

/** An overnight window uses its starting instructional date, including makeup weekdays. */
export function isWithinClasspilotInstructionalWindow(settings: HeartbeatTrackingSettings, now = new Date()): boolean {
  if (!settings.enableTrackingHours) return true;
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: settings.schoolTimezone || "America/New_York",
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(now);
  const local = Object.fromEntries(parts.map(part => [part.type, part.value]));
  const minute = Number(local.hour) * 60 + Number(local.minute);
  const minutes = (value: string) => Number(value.slice(0, 2)) * 60 + Number(value.slice(3));
  const start = minutes(settings.trackingStartTime!), end = minutes(settings.trackingEndTime!);
  let date = `${local.year}-${local.month}-${local.day}`;
  if (start > end && minute <= end) date = datePlusDays(date, -1);
  const override = settings.schedulingDateOverrides?.[date];
  if (!isSchedulingInstructionalDate(date, settings.instructionalCalendar ?? {}, settings.schedulingDateOverrides ?? {})) return false;
  const weekday = override?.instructional === true ? override.meetingWeekday ?? dateWeekday(date) : dateWeekday(date);
  const day = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][weekday]!;
  if (settings.trackingDays?.length && !settings.trackingDays.includes(day)) return false;
  return start < end ? minute >= start && minute <= end : minute >= start || minute <= end;
}

/** The school policy is authoritative; client capabilities can only reduce access. */
export function resolveClasspilotMonitoringPolicy(
  settings: HeartbeatTrackingSettings | null | undefined,
  options: { acceptedCapabilities?: readonly string[]; now?: Date } = {},
) {
  const now = options.now ?? new Date();
  let valid = Boolean(settings);
  if (settings?.enableTrackingHours) {
    try {
      new Intl.DateTimeFormat("en", { timeZone: settings.schoolTimezone || "America/New_York" }).format(now);
      const time = /^([01]\d|2[0-3]):[0-5]\d$/;
      valid = time.test(settings.trackingStartTime ?? "") && time.test(settings.trackingEndTime ?? "")
        && settings.trackingStartTime !== settings.trackingEndTime;
    } catch { valid = false; }
  }
  const policyMode: ClasspilotMonitoringMode = !settings || !valid
    ? "off"
    : isWithinClasspilotInstructionalWindow(settings, now) || settings.afterHoursMode === "full"
      ? "full"
      : settings.afterHoursMode === "limited" ? "safety_only" : "off";
  const unsupported = policyMode === "safety_only"
    && !options.acceptedCapabilities?.includes(CLASSPILOT_SAFETY_ONLY_CAPABILITY);
  return {
    mode: unsupported ? "off" as const : policyMode,
    policyMode,
    reason: !settings || !valid ? "settings_unavailable" : unsupported
      ? "extension_update_required" : policyMode === "full" ? "monitoring_allowed" : "outside_school_hours",
    serverTime: now.toISOString(),
  };
}

export async function getClasspilotMonitoringPolicy(
  schoolId: string,
  options: { acceptedCapabilities?: readonly string[]; now?: Date } = {},
) {
  // Dynamic import keeps the pure policy usable by storage and protocol code.
  const { getHeartbeatTrackingSettingsForSchool } = await import("./storage.js");
  const { runWithTenantContext } = await import("../middleware/tenantContext.js");
  return runWithTenantContext({ schoolId }, async () =>
    resolveClasspilotMonitoringPolicy(await getHeartbeatTrackingSettingsForSchool(schoolId, undefined, { bypassCache: true }), options));
}

/** Bound a short-lived stream lease by the same timezone predicate as collection. */
export function classpilotFullMonitoringDeadline(
  settings: HeartbeatTrackingSettings | undefined, now: number, maximumEnd: number,
): number {
  const full = (at: number) => resolveClasspilotMonitoringPolicy(settings, { now: new Date(at) }).policyMode === "full";
  if (!full(now)) return now;
  let allowed = now;
  for (let probe = Math.min(now + 60_000, maximumEnd); probe <= maximumEnd; probe = Math.min(probe + 60_000, maximumEnd)) {
    if (!full(probe)) {
      let denied = probe;
      while (denied - allowed > 1) { const middle = Math.floor((allowed + denied) / 2); if (full(middle)) allowed = middle; else denied = middle; }
      return denied;
    }
    if (probe === maximumEnd) return maximumEnd;
    allowed = probe;
  }
  return maximumEnd;
}

export const requireClasspilotFullMonitoring: RequestHandler = async (_req, res, next) => {
  try {
    if (!res.locals.schoolId) throw Object.assign(new Error("School context required"), { status: 403 });
    const policy = await getClasspilotMonitoringPolicy(res.locals.schoolId);
    if (policy.mode !== "full") {
      res.status(403).json({ code: "MONITORING_OUTSIDE_SCHOOL_HOURS", monitoringPolicy: policy });
      return;
    }
    next();
  } catch (error) { next(error); }
};

/** Only the active HTTP(S) page is eligible for transient safety classification. */
export function classpilotSafetyObservation(body: Record<string, unknown>) {
  if (typeof body.activeTabUrl !== "string" || body.activeTabUrl.length > 8_192) return null;
  try {
    const url = new URL(body.activeTabUrl);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return null;
    return {
      url: url.href,
      title: typeof body.activeTabTitle === "string"
        ? body.activeTabTitle.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 500) : "",
    };
  } catch { return null; }
}
