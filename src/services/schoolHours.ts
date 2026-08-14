/**
 * Shared school-hours utility.
 * Used by ClassPilot (heartbeat) and PassPilot (pass creation) to enforce
 * the tracking / operating window configured per school.
 */

export function isWithinTrackingWindow(settings: {
  enableTrackingHours: boolean | null;
  trackingStartTime: string | null;
  trackingEndTime: string | null;
  trackingDays: string[] | null;
  schoolTimezone: string | null;
}, at: Date = new Date()): boolean {
  if (!settings.enableTrackingHours) return true; // tracking hours disabled = always track

  const tz = settings.schoolTimezone || "America/New_York";
  let now: Date;
  try {
    const dateStr = at.toLocaleString("en-US", { timeZone: tz });
    now = new Date(dateStr);
  } catch {
    now = at;
  }

  // Check time range
  if (settings.trackingStartTime && settings.trackingEndTime) {
    const [startH, startM] = settings.trackingStartTime.split(":").map(Number);
    const [endH, endM] = settings.trackingEndTime.split(":").map(Number);
    const currentMinutes = now.getHours() * 60 + now.getMinutes();
    const startMinutes = (startH ?? 8) * 60 + (startM ?? 0);
    const endMinutes = (endH ?? 15) * 60 + (endM ?? 0);
    const dayNames = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
    const todayIndex = now.getDay();
    const activeDays = settings.trackingDays && settings.trackingDays.length > 0
      ? new Set(settings.trackingDays)
      : null;
    const dayEnabled = (dayIndex: number) => !activeDays || activeDays.has(dayNames[dayIndex]!);

    if (startMinutes < endMinutes) {
      return dayEnabled(todayIndex)
        && currentMinutes >= startMinutes
        && currentMinutes <= endMinutes;
    }

    // An overnight window belongs to the day on which it starts. For example,
    // Monday 20:00–02:00 remains active through Tuesday 02:00 when Monday is
    // configured, even if Tuesday itself is not selected.
    if (currentMinutes >= startMinutes) return dayEnabled(todayIndex);
    if (currentMinutes <= endMinutes) return dayEnabled((todayIndex + 6) % 7);
    return false;
  }

  // With no valid time range, the configured days still bound monitoring.
  if (settings.trackingDays && settings.trackingDays.length > 0) {
    const dayNames = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
    if (!settings.trackingDays.includes(dayNames[now.getDay()]!)) return false;
  }

  return true;
}
