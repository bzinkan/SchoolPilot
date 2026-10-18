// Server port of schoolpilot-app/src/shared/themes/calendar.js, kept line for
// line with the browser copy: tests/classpilot-theme-calendar.test.ts runs both
// over every day of several years and compares.
//
// The dashboard resolves "follow the calendar" in the teacher's browser. The
// PassPilot kiosk and the student sign-in gate cannot: they receive a concrete
// theme from the server, so the server turns calendar mode into today's preset
// in the school's time zone.
//
// Rules (docs/CLASSPILOT_DASHBOARD_THEMES.md §9.3):
// - A holiday opens `leadDays` before its date (default 10) and closes the day
//   after it, when the season returns. An admin may open it earlier for the
//   current year with `starts[holiday] = 'YYYY-MM-DD'`.
// - Only holidays in `allowed` are considered; anything else falls through to
//   the season, so a school that does not list Christmas sees Winter.
// - Advent (when allowed) runs from Advent Sunday until the day before the
//   Christmas window opens, and listing Advent implies Christmas.
// - Overlapping windows go to the nearer holiday (ids are kept in date order).

import type { DashboardThemePresetId } from "./classpilotThemes.js";

export const CALENDAR_HOLIDAY_IDS = Object.freeze(["valentines", "st-patricks", "easter", "halloween", "thanksgiving", "advent", "christmas"] as const);
export type CalendarHolidayId = typeof CALENDAR_HOLIDAY_IDS[number];
// The automatic school calendar every school starts with: faith holidays are opt-in.
export const DEFAULT_CALENDAR_HOLIDAYS: readonly CalendarHolidayId[] = Object.freeze(["halloween", "thanksgiving", "valentines", "st-patricks"] as const);
export const DEFAULT_CALENDAR_LEAD_DAYS = 10;
export const MAX_CALENDAR_LEAD_DAYS = 30;

export type MonthDay = { month: number; day: number };
export type LocalDate = { year: number; month: number; day: number };
export type HolidayWindow = { from: MonthDay; to: MonthDay };
/** Per-holiday early starts, 'YYYY-MM-DD'; anything malformed is ignored. */
export type CalendarStarts = Readonly<Partial<Record<CalendarHolidayId, string | null | undefined>>>;
export type CalendarWindowOptions = { leadDays?: unknown; starts?: CalendarStarts };
export type CalendarOptions = CalendarWindowOptions & { allowed?: readonly string[] };

// Anonymous Gregorian algorithm (Meeus/Jones/Butcher): month is 1-based.
export function easterSunday(year: number): MonthDay {
  const a = year % 19, b = Math.floor(year / 100), c = year % 100;
  const d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return { month, day };
}

// Fourth Thursday of November.
export function thanksgivingDay(year: number): MonthDay {
  const first = new Date(Date.UTC(year, 10, 1)).getUTCDay(); // 0 = Sunday
  const firstThursday = 1 + ((4 - first + 7) % 7);
  return { month: 11, day: firstThursday + 21 };
}

// Fourth Sunday before Christmas (the Sunday on or before Dec 3 that starts Advent).
export function adventStart(year: number): MonthDay {
  const christmas = new Date(Date.UTC(year, 11, 25)).getUTCDay();
  const daysBack = christmas === 0 ? 7 : christmas; // the Sunday before Christmas
  const fourthSundayBefore = 25 - daysBack - 21;
  return { month: fourthSundayBefore >= 1 ? 12 : 11, day: fourthSundayBefore >= 1 ? fourthSundayBefore : 30 + fourthSundayBefore };
}

// The day a holiday falls on in `year`; Advent's "date" is its first day.
export function holidayDate(id: string, year: number): MonthDay | null {
  switch (id) {
    case "valentines": return { month: 2, day: 14 };
    case "st-patricks": return { month: 3, day: 17 };
    case "easter": return easterSunday(year);
    case "halloween": return { month: 10, day: 31 };
    case "thanksgiving": return thanksgivingDay(year);
    case "advent": return adventStart(year);
    case "christmas": return { month: 12, day: 25 };
    default: return null;
  }
}

function ymd(year: number, month: number, day: number): number { return year * 10000 + month * 100 + day; }
function daysInMonth(year: number, month: number): number { return new Date(Date.UTC(year, month, 0)).getUTCDate(); }
function addDays(year: number, month: number, day: number, delta: number): LocalDate {
  const date = new Date(Date.UTC(year, month - 1, day + delta));
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
}
function parseStart(value: unknown): LocalDate | null {
  const match = typeof value === "string" && /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const year = Number(match[1]), month = Number(match[2]), day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) return null;
  return { year, month, day };
}

export function normalizeLeadDays(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return DEFAULT_CALENDAR_LEAD_DAYS;
  return Math.min(MAX_CALENDAR_LEAD_DAYS, Math.max(0, Math.round(n)));
}

// Opening day of a holiday in `year`: the admin's early start for that year
// when it is on or before the holiday, otherwise `leadDays` before it.
function windowStart(id: CalendarHolidayId, year: number, leadDays: number, starts: CalendarStarts | undefined): LocalDate {
  const date = holidayDate(id, year) as MonthDay;
  const start = parseStart(starts?.[id]);
  if (start && start.year === year && ymd(year, start.month, start.day) <= ymd(year, date.month, date.day)) {
    return { year, month: start.month, day: start.day };
  }
  return addDays(year, date.month, date.day, -leadDays);
}

// The inclusive window a holiday is shown for in `year`, or null when it has
// none (Advent entirely covered by an early Christmas).
export function holidayWindow(id: string, year: number, { leadDays = DEFAULT_CALENDAR_LEAD_DAYS, starts = {} }: CalendarWindowOptions = {}): HolidayWindow | null {
  const date = holidayDate(id, year);
  if (!date) return null;
  const lead = normalizeLeadDays(leadDays);
  if (id === "advent") {
    const christmasFrom = windowStart("christmas", year, lead, starts);
    const to = addDays(christmasFrom.year, christmasFrom.month, christmasFrom.day, -1);
    if (ymd(year, to.month, to.day) < ymd(year, date.month, date.day)) return null;
    return { from: { month: date.month, day: date.day }, to: { month: to.month, day: to.day } };
  }
  const from = windowStart(id as CalendarHolidayId, year, lead, starts);
  return { from: { month: from.month, day: from.day }, to: { month: date.month, day: date.day } };
}

// Holidays a teacher's own "follow the calendar" theme may show: every holiday,
// Advent only when the stored preset hints at it.
export function teacherCalendarHolidays(hint: string | null | undefined): CalendarHolidayId[] {
  return hint === "advent" ? [...CALENDAR_HOLIDAY_IDS] : CALENDAR_HOLIDAY_IDS.filter(id => id !== "advent");
}

function isCalendarHolidayId(id: string): id is CalendarHolidayId {
  return (CALENDAR_HOLIDAY_IDS as readonly string[]).includes(id);
}

// `today` is { year, month (1-12), day } in the school's zone; see localDateParts.
export function calendarPresetFor(today: LocalDate, { allowed = DEFAULT_CALENDAR_HOLIDAYS, leadDays = DEFAULT_CALENDAR_LEAD_DAYS, starts = {} }: CalendarOptions = {}): DashboardThemePresetId {
  const { year, month, day } = today;
  const key = ymd(year, month, day);
  const set = new Set<CalendarHolidayId>(Array.isArray(allowed) ? allowed.filter(isCalendarHolidayId) : []);
  if (set.has("advent")) set.add("christmas");
  const options = { leadDays, starts };
  for (const id of CALENDAR_HOLIDAY_IDS) {
    if (!set.has(id)) continue;
    const window = holidayWindow(id, year, options);
    if (window && key >= ymd(year, window.from.month, window.from.day) && key <= ymd(year, window.to.month, window.to.day)) return id;
  }
  if (month === 12 || month === 1 || month === 2) return "winter";
  if (month >= 3 && month <= 5) return "spring";
  if (month >= 6 && month <= 8) return "summer";
  return "fall";
}

// Local date parts in an IANA zone without pulling in a date library; an
// unknown zone falls back to the platform default rather than throwing on a
// shared kiosk path.
export function localDateParts(date: Date, timeZone: string): LocalDate {
  let formatter: Intl.DateTimeFormat;
  try {
    formatter = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
  } catch {
    formatter = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" });
  }
  const parts = formatter.formatToParts(date);
  const read = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find(part => part.type === type)?.value);
  return { year: read("year"), month: read("month"), day: read("day") };
}

// 'YYYY-MM-DD' for today in the school's zone, for an admin's "Start now".
export function localDateString(date: Date, timeZone: string): string {
  const { year, month, day } = localDateParts(date, timeZone);
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

export { daysInMonth };
