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
}): boolean {
  if (!settings.enableTrackingHours) return true; // tracking hours disabled = always track

  const tz = settings.schoolTimezone || "America/New_York";
  let now: Date;
  try {
    const dateStr = new Date().toLocaleString("en-US", { timeZone: tz });
    now = new Date(dateStr);
  } catch {
    now = new Date();
  }

  // Check day of week
  if (settings.trackingDays && settings.trackingDays.length > 0) {
    const dayNames = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
    const today = dayNames[now.getDay()]!;
    if (!settings.trackingDays.includes(today)) return false;
  }

  // Check time range
  if (settings.trackingStartTime && settings.trackingEndTime) {
    const [startH, startM] = settings.trackingStartTime.split(":").map(Number);
    const [endH, endM] = settings.trackingEndTime.split(":").map(Number);
    const currentMinutes = now.getHours() * 60 + now.getMinutes();
    const startMinutes = (startH ?? 8) * 60 + (startM ?? 0);
    const endMinutes = (endH ?? 15) * 60 + (endM ?? 0);
    if (currentMinutes < startMinutes || currentMinutes > endMinutes) return false;
  }

  return true;
}
