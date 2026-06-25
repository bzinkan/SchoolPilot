export type AnalyticsPeriodKey = "today" | "7d" | "30d";

export interface SchoolLocalPeriod {
  period: AnalyticsPeriodKey;
  timeZone: string;
  todayLocalDate: string;
  startLocalDate: string;
  currentDayStartUtc: Date;
  rangeStartUtc: Date;
  rangeEndUtc: Date;
  completedStartDate: string | null;
  completedEndDate: string | null;
}

const DEFAULT_TIME_ZONE = "America/New_York";

function safeTimeZone(timeZone?: string | null): string {
  const candidate = timeZone || DEFAULT_TIME_ZONE;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: candidate }).format(new Date());
    return candidate;
  } catch {
    return DEFAULT_TIME_ZONE;
  }
}

export function normalizeAnalyticsPeriod(period?: string | null): AnalyticsPeriodKey {
  if (period === "30d") return "30d";
  if (period === "7d") return "7d";
  return "today";
}

export function addLocalDays(localDate: string, days: number): string {
  const [year = 1970, month = 1, day = 1] = localDate.split("-").map(Number);
  const date = new Date(Date.UTC(year, (month || 1) - 1, day || 1));
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export function localDateInTimeZone(date: Date, timeZone?: string | null): string {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: safeTimeZone(timeZone),
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return formatter.format(date);
}

function zonedParts(date: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return {
    year: Number(values.year),
    month: Number(values.month),
    day: Number(values.day),
    hour: Number(values.hour === "24" ? "0" : values.hour),
    minute: Number(values.minute),
    second: Number(values.second),
  };
}

export function localDateStartUtc(localDate: string, timeZone?: string | null): Date {
  const tz = safeTimeZone(timeZone);
  const [year = 1970, month = 1, day = 1] = localDate.split("-").map(Number);
  const targetUtc = Date.UTC(year, (month || 1) - 1, day || 1, 0, 0, 0, 0);
  let guess = targetUtc;

  for (let i = 0; i < 3; i++) {
    const parts = zonedParts(new Date(guess), tz);
    const renderedAsUtc = Date.UTC(
      parts.year,
      parts.month - 1,
      parts.day,
      parts.hour,
      parts.minute,
      parts.second,
      0
    );
    guess -= renderedAsUtc - targetUtc;
  }

  return new Date(guess);
}

export function resolveSchoolLocalPeriod(
  period: string | null | undefined,
  timeZone: string | null | undefined,
  now = new Date()
): SchoolLocalPeriod {
  const normalized = normalizeAnalyticsPeriod(period);
  const tz = safeTimeZone(timeZone);
  const days = normalized === "30d" ? 30 : normalized === "7d" ? 7 : 1;
  const todayLocalDate = localDateInTimeZone(now, tz);
  const startLocalDate = addLocalDays(todayLocalDate, -(days - 1));
  const currentDayStartUtc = localDateStartUtc(todayLocalDate, tz);

  return {
    period: normalized,
    timeZone: tz,
    todayLocalDate,
    startLocalDate,
    currentDayStartUtc,
    rangeStartUtc: localDateStartUtc(startLocalDate, tz),
    rangeEndUtc: now,
    completedStartDate: days > 1 ? startLocalDate : null,
    completedEndDate: days > 1 ? addLocalDays(todayLocalDate, -1) : null,
  };
}

export function localDateRange(startLocalDate: string, endLocalDate: string): string[] {
  const dates: string[] = [];
  for (let date = startLocalDate; date <= endLocalDate; date = addLocalDays(date, 1)) {
    dates.push(date);
  }
  return dates;
}

export function utcTimestampForSql(date: Date): string {
  return date.toISOString().slice(0, 19).replace("T", " ");
}
