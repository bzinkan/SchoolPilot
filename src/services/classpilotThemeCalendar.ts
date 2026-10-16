// Server port of schoolpilot-app/src/shared/themes/calendar.js.
//
// The dashboard resolves "follow the calendar" in the teacher's browser. The
// PassPilot kiosk cannot: it receives a concrete theme from the server, so the
// server turns calendar mode into today's preset in the school's time zone.
// A test keeps this file and the browser copy in agreement.

import type { DashboardThemePresetId } from "./classpilotThemes.js";

export type MonthDay = { month: number; day: number };
export type LocalDate = { year: number; month: number; day: number };

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
  const first = new Date(Date.UTC(year, 10, 1)).getUTCDay();
  const firstThursday = 1 + ((4 - first + 7) % 7);
  return { month: 11, day: firstThursday + 21 };
}

// Fourth Sunday before Christmas.
export function adventStart(year: number): MonthDay {
  const christmas = new Date(Date.UTC(year, 11, 25)).getUTCDay();
  const daysBack = christmas === 0 ? 7 : christmas;
  const fourthSundayBefore = 25 - daysBack - 21;
  return { month: fourthSundayBefore >= 1 ? 12 : 11, day: fourthSundayBefore >= 1 ? fourthSundayBefore : 30 + fourthSundayBefore };
}

function ymd(year: number, month: number, day: number): number { return year * 10000 + month * 100 + day; }
function addDays(year: number, month: number, day: number, delta: number): LocalDate {
  const date = new Date(Date.UTC(year, month - 1, day + delta));
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
}

export function calendarPresetFor(today: LocalDate, { liturgical = false }: { liturgical?: boolean } = {}): DashboardThemePresetId {
  const { year, month, day } = today;
  const key = ymd(year, month, day);
  const within = (start: MonthDay, end: MonthDay) => key >= ymd(year, start.month, start.day) && key <= ymd(year, end.month, end.day);

  const easter = easterSunday(year);
  const easterWindowStart = addDays(year, easter.month, easter.day, -14);
  const easterWindowEnd = addDays(year, easter.month, easter.day, 1);
  const thanksgiving = thanksgivingDay(year);
  const thanksgivingStart = addDays(year, thanksgiving.month, thanksgiving.day, -10);
  const advent = adventStart(year);

  if (within({ month: 10, day: 15 }, { month: 10, day: 31 })) return "halloween";
  if (within({ month: 2, day: 7 }, { month: 2, day: 14 })) return "valentines";
  if (within({ month: 3, day: 10 }, { month: 3, day: 17 })) return "st-patricks";
  if (key >= ymd(year, easterWindowStart.month, easterWindowStart.day) && key <= ymd(year, easterWindowEnd.month, easterWindowEnd.day)) return "easter";
  if (key >= ymd(year, thanksgivingStart.month, thanksgivingStart.day) && key <= ymd(year, thanksgiving.month, thanksgiving.day)) return "thanksgiving";
  if (liturgical && key >= ymd(year, advent.month, advent.day) && key <= ymd(year, 12, 24)) return "advent";
  if (within({ month: 12, day: 1 }, { month: 12, day: 31 })) return "christmas";
  if (month === 1 || month === 2) return "winter";
  if (month >= 3 && month <= 5) return "spring";
  if (month >= 6 && month <= 8) return "summer";
  if (month >= 9 && month <= 11) return "fall";
  return "winter";
}

// Local date parts in an IANA zone; an unknown zone falls back to the
// platform default rather than throwing on a shared kiosk path.
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
