import { addDays, startOfDay, startOfWeek } from "date-fns";
import { formatInTimeZone, fromZonedTime, toZonedTime } from "date-fns-tz";

const DEFAULT_SCHOOL_TIMEZONE = "America/New_York";

const DESTINATION_LABELS = {
  bathroom: "Bathroom",
  nurse: "Nurse",
  office: "Office",
  counselor: "Counselor",
  other_classroom: "Other Classroom",
};

function resolveTimezone(timezone) {
  const candidate = typeof timezone === "string" && timezone.trim()
    ? timezone.trim()
    : DEFAULT_SCHOOL_TIMEZONE;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: candidate }).format(0);
    return candidate;
  } catch {
    return DEFAULT_SCHOOL_TIMEZONE;
  }
}

function formatWeekLabel(start, end, timezone) {
  const startDay = formatInTimeZone(start, timezone, "yyyy-MM-dd");
  const endDay = formatInTimeZone(end, timezone, "yyyy-MM-dd");
  if (startDay === endDay) return formatInTimeZone(start, timezone, "MMM d, yyyy");

  const startYear = formatInTimeZone(start, timezone, "yyyy");
  const endYear = formatInTimeZone(end, timezone, "yyyy");
  if (startYear !== endYear) {
    return `${formatInTimeZone(start, timezone, "MMM d, yyyy")}–${formatInTimeZone(end, timezone, "MMM d, yyyy")}`;
  }

  const startMonth = formatInTimeZone(start, timezone, "MM");
  const endMonth = formatInTimeZone(end, timezone, "MM");
  if (startMonth === endMonth) {
    return `${formatInTimeZone(start, timezone, "MMM d")}–${formatInTimeZone(end, timezone, "d, yyyy")}`;
  }
  return `${formatInTimeZone(start, timezone, "MMM d")}–${formatInTimeZone(end, timezone, "MMM d, yyyy")}`;
}

/**
 * Return the current Monday-Friday school-week window as absolute instants.
 * Weekdays end at `now`; Saturday and Sunday cap the range at Friday night.
 */
export function getCurrentSchoolWeekRange(timezone, now = new Date()) {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new TypeError("now must be a valid Date");
  }

  const schoolTimezone = resolveTimezone(timezone);
  const schoolNow = toZonedTime(now, schoolTimezone);
  const schoolWeekStart = startOfDay(startOfWeek(schoolNow, { weekStartsOn: 1 }));
  const schoolSaturdayStart = startOfDay(addDays(schoolWeekStart, 5));
  const start = fromZonedTime(schoolWeekStart, schoolTimezone);
  const saturdayStart = fromZonedTime(schoolSaturdayStart, schoolTimezone);
  const end = schoolNow >= schoolSaturdayStart
    ? new Date(saturdayStart.getTime() - 1)
    : new Date(now.getTime());

  return {
    start,
    end,
    anchor: formatInTimeZone(start, schoolTimezone, "yyyy-MM-dd"),
    label: formatWeekLabel(start, end, schoolTimezone),
  };
}

/** Return the exact completed duration, or null for every non-returned pass. */
export function getPassActualDurationMs(pass) {
  if (String(pass?.status || "").toLowerCase() !== "returned") return null;
  if (!pass?.issuedAt || !pass?.returnedAt) return null;

  const issuedAtMs = new Date(pass.issuedAt).getTime();
  const returnedAtMs = new Date(pass.returnedAt).getTime();
  if (!Number.isFinite(issuedAtMs) || !Number.isFinite(returnedAtMs) || returnedAtMs < issuedAtMs) {
    return null;
  }
  return returnedAtMs - issuedAtMs;
}

/** Format a completed duration after callers have summed any raw milliseconds. */
export function formatPassDuration(durationMs) {
  if (typeof durationMs !== "number" || !Number.isFinite(durationMs) || durationMs < 0) return "—";
  if (durationMs === 0) return "0 min";
  if (durationMs < 60_000) return "<1 min";
  return `${Math.max(1, Math.round(durationMs / 60_000))} min`;
}

export function getPassIssuerLabel(pass) {
  const teacher = pass?.teacher;
  const teacherName = [
    teacher?.displayName,
    teacher?.name,
    [teacher?.firstName, teacher?.lastName].filter(Boolean).join(" "),
    teacher?.email,
  ].find((value) => typeof value === "string" && value.trim())?.trim();
  const kioskIssued = String(pass?.issuedVia || "").toLowerCase() === "kiosk";

  if (teacherName) {
    if (!kioskIssued || /\(kiosk\)$/i.test(teacherName)) return teacherName;
    return `${teacherName} (Kiosk)`;
  }
  if (kioskIssued) {
    return pass?.teacherId ? "Former staff member (Kiosk)" : "Unattributed kiosk";
  }
  return pass?.teacherId ? "Former staff member" : "Unknown issuer";
}

/**
 * Return elapsed milliseconds beyond an active pass's deadline.
 * Non-active passes, future deadlines, and malformed timestamps are not
 * overdue and return null so historical `expired` rows remain distinct.
 */
export function getPassOverdueMs(pass, nowMs = Date.now()) {
  if (String(pass?.status || "").toLowerCase() !== "active") return null;
  if (pass?.expiresAt === null || pass?.expiresAt === undefined || pass.expiresAt === "") {
    return null;
  }

  const currentMs = typeof nowMs === "number" ? nowMs : Number.NaN;
  const expiresAtMs = new Date(pass.expiresAt).getTime();
  if (!Number.isFinite(currentMs) || !Number.isFinite(expiresAtMs)) return null;

  const overdueMs = currentMs - expiresAtMs;
  return overdueMs >= 0 ? overdueMs : null;
}

export function isPassOverdue(pass, nowMs = Date.now()) {
  return getPassOverdueMs(pass, nowMs) !== null;
}

/** Format only the elapsed overdue duration; surfaces supply the status copy. */
export function formatPassOverdueDuration(pass, nowMs = Date.now()) {
  const overdueMs = getPassOverdueMs(pass, nowMs);
  if (overdueMs === null) return null;
  if (overdueMs < 60_000) return "<1 min";
  return `${Math.floor(overdueMs / 60_000)} min`;
}

export function getPassStatusLabel(pass, nowMs = Date.now()) {
  switch (String(pass?.status || "").toLowerCase()) {
    case "returned":
      return "Returned";
    case "active":
      return isPassOverdue(pass, nowMs) ? "Overdue" : "Still out";
    case "expired":
      return "Expired";
    case "canceled":
    case "cancelled":
      return "Canceled";
    default:
      return "Not returned";
  }
}

export function getPassDestinationLabel(pass) {
  const customDestination = typeof pass?.customDestination === "string"
    ? pass.customDestination.trim()
    : "";
  if (customDestination) return customDestination;

  const destination = typeof pass?.destination === "string"
    ? pass.destination.trim().toLowerCase()
    : "";
  if (!destination) return "General";
  if (DESTINATION_LABELS[destination]) return DESTINATION_LABELS[destination];
  return destination
    .split(/[_-]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ") || "General";
}
