const MONITORING_FIELDS = ["enableTrackingHours", "trackingStartTime", "trackingEndTime", "trackingDays", "schoolTimezone", "afterHoursMode"] as const;
const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

export function changesClasspilotMonitoringSettings(patch: Record<string, unknown>): boolean {
  return MONITORING_FIELDS.some(field => patch[field] !== undefined);
}

export function assertClasspilotMonitoringTimezoneUpdate(schoolTimezone: string | null | undefined, patch: Record<string, unknown>): void {
  if (patch.schoolTimezone !== undefined && patch.schoolTimezone !== (schoolTimezone || "America/New_York")) {
    throw Object.assign(new Error("Monitoring uses the school's timezone. Change the school profile timezone instead."), { status: 400, code: "CLASSPILOT_SCHOOL_TIMEZONE_READ_ONLY", expose: true });
  }
}

/** Validate the persisted result, including values omitted by a partial request. */
export function assertClasspilotMonitoringSettingsUpdate(current: Record<string, unknown> | null | undefined, patch: Record<string, unknown>): void {
  if (!changesClasspilotMonitoringSettings(patch)) return;
  const fail = (message: string): never => { throw Object.assign(new Error(message), { status: 400, code: "CLASSPILOT_MONITORING_SETTINGS_INVALID", expose: true }); };
  const state: Record<string, unknown> = { enableTrackingHours: false, trackingStartTime: "08:00", trackingEndTime: "15:00", trackingDays: DAYS.slice(0, 5), schoolTimezone: "America/New_York", afterHoursMode: "off", ...current };
  for (const field of MONITORING_FIELDS) if (patch[field] !== undefined) state[field] = patch[field];
  if (typeof state.enableTrackingHours !== "boolean") fail("Tracking hours must be a boolean.");
  if (!["off", "limited", "full"].includes(String(state.afterHoursMode))) fail("Invalid after-hours mode.");
  if (state.afterHoursMode === "limited" && !state.enableTrackingHours) fail("Safety-only mode requires enabled tracking hours and a valid tracking window.");
  for (const field of ["trackingStartTime", "trackingEndTime"] as const) {
    if ((state.enableTrackingHours || patch[field] !== undefined) && (typeof state[field] !== "string" || !TIME.test(state[field]))) fail("Tracking times must use HH:mm.");
  }
  if (state.enableTrackingHours && state.trackingStartTime === state.trackingEndTime) fail("Tracking start and end times must be different.");
  if (state.enableTrackingHours || patch.trackingDays !== undefined) {
    if (!Array.isArray(state.trackingDays) || !state.trackingDays.length || state.trackingDays.some(day => !DAYS.includes(day))) fail("Select at least one valid tracking day.");
  }
  if (state.enableTrackingHours || patch.schoolTimezone !== undefined) {
    try {
      if (typeof state.schoolTimezone !== "string" || !state.schoolTimezone.trim()) throw new Error();
      new Intl.DateTimeFormat("en", { timeZone: state.schoolTimezone }).format();
    } catch { fail("A valid school timezone is required."); }
  }
}
