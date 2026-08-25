const CLASSPILOT_TIMESTAMP_TEXT = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(?:Z|([+-])(\d{2})(?::?(\d{2}))?)?$/i;

export const CLASSPILOT_MIN_VALID_TIMESTAMP_MS = Date.UTC(2000, 0, 1);

function parseClasspilotTimestampTextMsOrNull(value: string): number | null {
  const match = CLASSPILOT_TIMESTAMP_TEXT.exec(value);
  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const millisecond = Number((match[7] ?? "").padEnd(3, "0").slice(0, 3));
  const offsetSign = match[8];
  const offsetHour = match[9] === undefined ? 0 : Number(match[9]);
  const offsetMinute = match[10] === undefined ? 0 : Number(match[10]);
  if (
    year < 2000 ||
    month < 1 || month > 12 ||
    hour > 23 ||
    minute > 59 ||
    second > 59 ||
    offsetHour > 23 ||
    offsetMinute > 59
  ) {
    return null;
  }

  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (day < 1 || day > daysInMonth) return null;

  // Drizzle interprets PostgreSQL `timestamp without time zone` values as UTC
  // by appending +0000. Raw db.execute() skips that column mapper, so preserve
  // the same semantics here instead of letting Date.parse use the host timezone.
  const wallClockMs = Date.UTC(
    year,
    month - 1,
    day,
    hour,
    minute,
    second,
    millisecond
  );
  if (!offsetSign) return wallClockMs;
  const offsetMs = (offsetHour * 60 + offsetMinute) * 60_000;
  return offsetSign === "+" ? wallClockMs - offsetMs : wallClockMs + offsetMs;
}

/**
 * Strict timestamp boundary for raw SQL and cache values used by ClassPilot's
 * dashboard. Numeric strings and JavaScript's normalized invalid dates are
 * deliberately rejected; numeric inputs are milliseconds only.
 */
export function classpilotTimestampMsOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  let timestamp: number;
  if (value instanceof Date) {
    timestamp = value.getTime();
  } else if (typeof value === "number") {
    timestamp = value;
  } else if (typeof value === "string") {
    const parsed = parseClasspilotTimestampTextMsOrNull(value);
    if (parsed === null) return null;
    timestamp = parsed;
  } else {
    return null;
  }
  return Number.isFinite(timestamp) && timestamp >= CLASSPILOT_MIN_VALID_TIMESTAMP_MS
    ? timestamp
    : null;
}

export function classpilotTimestampDateOrNull(value: unknown): Date | null {
  const timestamp = classpilotTimestampMsOrNull(value);
  return timestamp === null ? null : new Date(timestamp);
}
