import { z } from "zod";
import { CALENDAR_HOLIDAY_IDS, DEFAULT_CALENDAR_HOLIDAYS, DEFAULT_CALENDAR_LEAD_DAYS, MAX_CALENDAR_LEAD_DAYS, calendarPresetFor,
  daysInMonth, localDateParts, normalizeLeadDays, type CalendarHolidayId } from "./classpilotThemeCalendar.js";

/**
 * Teacher dashboard themes: a presentation-only personal preference. This id
 * list mirrors schoolpilot-app/src/shared/themes/presets.js and a unit test
 * keeps the two in step. Preloaded themes are holidays and seasons only.
 */
export const DASHBOARD_THEME_PRESET_IDS = ["halloween", "thanksgiving", "christmas", "advent", "valentines",
  "st-patricks", "easter", "spring", "summer", "fall", "winter"] as const;
export type DashboardThemePresetId = typeof DASHBOARD_THEME_PRESET_IDS[number];
export const DASHBOARD_THEME_PRESET_LABELS: Readonly<Record<DashboardThemePresetId, string>> = Object.freeze({
  halloween: "Halloween", thanksgiving: "Thanksgiving", christmas: "Christmas", advent: "Advent", valentines: "Valentine's Day",
  "st-patricks": "St. Patrick's Day", easter: "Easter", spring: "Spring", summer: "Summer", fall: "Fall", winter: "Winter" });
/** `kiosk`: "show my theme on the PassPilot kiosk"; absent means true. Stored as-is. */
export type PresetDashboardTheme = { kind: "preset"; preset: DashboardThemePresetId; name?: string; calendar?: boolean; kiosk?: boolean };
export type ImageDashboardTheme = { kind: "image"; imageAssetId: string; name?: string; kiosk?: boolean };
/** The teacher's deliberate "plain dashboard": no theme anywhere, overridden only by the school lock. */
export type NoneDashboardTheme = { kind: "none" };
export type DashboardTheme = PresetDashboardTheme | ImageDashboardTheme | NoneDashboardTheme;

// Optional teacher label ("Who Dey"). Reserved later fields (palette, pattern,
// accent) stay rejected by strict parsing until they are built, and so does the
// response-only `source` marker on a resolved school theme.
const themeName = z.string().trim().min(1).max(40).optional();
const kiosk = z.boolean().optional();
const presetTheme = z.object({ kind: z.literal("preset"), preset: z.enum(DASHBOARD_THEME_PRESET_IDS), name: themeName,
  calendar: z.boolean().optional() }).strict();
/** The preset variant without the personal kiosk switch: a school default, never an uploaded image. */
export const presetThemeSchema: z.ZodType<PresetDashboardTheme> = presetTheme;
export const dashboardThemeSchema: z.ZodType<DashboardTheme> = z.discriminatedUnion("kind", [
  presetTheme.extend({ kiosk }).strict(),
  z.object({ kind: z.literal("image"), imageAssetId: z.string().uuid(), name: themeName, kiosk }).strict(),
  z.object({ kind: z.literal("none") }).strict(),
]);

/** Launch gate. Off: reads report it and theme writes are refused. */
export function dashboardThemesEnabled(): boolean {
  return process.env.CLASSPILOT_DASHBOARD_THEMES_ENABLED === "true";
}

/**
 * School-wide appearance governance stored as `settings.appearance`. Teacher
 * themes default on; uploads and kiosk custom backgrounds default off. The
 * automatic calendar is on with the secular holiday set; faith holidays
 * (Christmas, Easter, Advent) are opt-in per school.
 */
export type CalendarStartDates = Partial<Record<CalendarHolidayId, string>>;
export type SchoolAppearance = {
  teacherThemesEnabled: boolean;
  teacherUploadsEnabled: boolean;
  kioskCustomBackgrounds: boolean;
  lockToSchoolTheme: boolean;
  schoolDefaultTheme: PresetDashboardTheme | null;
  /** With no fixed default, the school theme is today's calendar preset. */
  autoCalendar: boolean;
  /** Holidays the school calendar may pick; anything else falls through to the season. */
  calendarHolidays: CalendarHolidayId[];
  /** Days before a holiday its theme opens (0–30). */
  calendarLeadDays: number;
  /** Per-holiday early starts for the current year, 'YYYY-MM-DD'. */
  calendarStarts: CalendarStartDates;
  /** The student sign-in gate shows the school theme. */
  signInGateTheme: boolean;
};
export const DEFAULT_SCHOOL_APPEARANCE: Readonly<SchoolAppearance> = Object.freeze({ teacherThemesEnabled: true,
  teacherUploadsEnabled: false, kioskCustomBackgrounds: false, lockToSchoolTheme: false, schoolDefaultTheme: null,
  autoCalendar: true, calendarHolidays: [...DEFAULT_CALENDAR_HOLIDAYS], calendarLeadDays: DEFAULT_CALENDAR_LEAD_DAYS,
  calendarStarts: {}, signInGateTheme: true });
const appearanceFlags = ["teacherThemesEnabled", "teacherUploadsEnabled", "kioskCustomBackgrounds", "lockToSchoolTheme",
  "autoCalendar", "signInGateTheme"] as const;

const holidayId = z.enum(CALENDAR_HOLIDAY_IDS);
// A real 'YYYY-MM-DD' date: the calendar ignores anything else, so it is never stored.
const calendarDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
  const [year = 0, month = 0, day = 0] = value.split("-").map(Number);
  return month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth(year, month);
}, "Use a real calendar date");
const calendarHolidays = z.array(holidayId).max(CALENDAR_HOLIDAY_IDS.length)
  .refine(ids => new Set(ids).size === ids.length, "List each holiday once");
const calendarLeadDays = z.number().int().min(0).max(MAX_CALENDAR_LEAD_DAYS);
/** A start per holiday; null clears that holiday's start on a merge. */
const calendarStarts = z.record(holidayId, calendarDate.nullable());

function isCalendarHolidayId(value: unknown): value is CalendarHolidayId {
  return typeof value === "string" && (CALENDAR_HOLIDAY_IDS as readonly string[]).includes(value);
}
function readCalendarHolidays(value: unknown): CalendarHolidayId[] {
  if (!Array.isArray(value)) return [...DEFAULT_CALENDAR_HOLIDAYS];
  return [...new Set(value.filter(isCalendarHolidayId))];
}
function readCalendarStarts(value: unknown): CalendarStartDates {
  const source: Record<string, unknown> = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const starts: CalendarStartDates = {};
  for (const id of CALENDAR_HOLIDAY_IDS) {
    const parsed = calendarDate.safeParse(source[id]);
    if (parsed.success) starts[id] = parsed.data;
  }
  return starts;
}

/** Normalizes whatever is stored: missing or malformed values fall back to the defaults. */
export function readSchoolAppearance(value: unknown): SchoolAppearance {
  const source: Record<string, unknown> = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const theme = presetThemeSchema.safeParse(source.schoolDefaultTheme);
  const appearance: SchoolAppearance = { ...DEFAULT_SCHOOL_APPEARANCE, schoolDefaultTheme: theme.success ? theme.data : null,
    calendarHolidays: readCalendarHolidays(source.calendarHolidays), calendarLeadDays: normalizeLeadDays(source.calendarLeadDays ?? undefined),
    calendarStarts: readCalendarStarts(source.calendarStarts) };
  for (const flag of appearanceFlags) if (typeof source[flag] === "boolean") appearance[flag] = source[flag] as boolean;
  return appearance;
}
// The calendar keys are optional so a client that omits one keeps the live
// value (mergeSchoolAppearance); the original switches stay required.
export const appearanceSectionSchema = z.object({ expectedVersion: z.string().regex(/^[a-f0-9]{64}$/),
  teacherThemesEnabled: z.boolean(), teacherUploadsEnabled: z.boolean(), kioskCustomBackgrounds: z.boolean(),
  lockToSchoolTheme: z.boolean(), schoolDefaultTheme: presetThemeSchema.nullable(),
  autoCalendar: z.boolean().optional(), signInGateTheme: z.boolean().optional(), calendarHolidays: calendarHolidays.optional(),
  calendarLeadDays: calendarLeadDays.optional(), calendarStarts: calendarStarts.optional() }).strict();
export type AppearanceSectionInput = Omit<z.infer<typeof appearanceSectionSchema>, "expectedVersion">;

/**
 * The next stored appearance for a section save: the live values with the
 * submitted keys on top. Start dates merge per holiday, null clearing one.
 */
export function mergeSchoolAppearance(stored: unknown, input: AppearanceSectionInput): SchoolAppearance {
  const current = readSchoolAppearance(stored);
  const { calendarStarts: startInput, ...rest } = input;
  const starts: CalendarStartDates = { ...current.calendarStarts };
  for (const id of CALENDAR_HOLIDAY_IDS) {
    const value = startInput?.[id];
    if (value === null) delete starts[id];
    else if (typeof value === "string") starts[id] = value;
  }
  const submitted = Object.fromEntries(Object.entries(rest).filter(([, value]) => value !== undefined)) as Partial<typeof rest>;
  return readSchoolAppearance({ ...current, ...submitted, calendarStarts: starts });
}

/** A school theme as resolved for a response; `source` is never stored. */
export type SchoolTheme = PresetDashboardTheme & { source: "school" };
export type SchoolThemeClock = { now: Date; timeZone: string };
export function schoolCalendarOptions(appearance: SchoolAppearance) {
  return { allowed: appearance.calendarHolidays, leadDays: appearance.calendarLeadDays, starts: appearance.calendarStarts };
}
/**
 * The theme a teacher who follows the school sees: the fixed default when the
 * admin set one, else today's calendar preset while the automatic calendar is
 * on, else nothing. Pure; the caller supplies the clock and the school zone.
 */
export function schoolThemeFor(appearance: SchoolAppearance, { now, timeZone }: SchoolThemeClock): SchoolTheme | null {
  if (appearance.schoolDefaultTheme) return { ...appearance.schoolDefaultTheme, source: "school" };
  if (!appearance.autoCalendar) return null;
  return { kind: "preset", preset: calendarPresetFor(localDateParts(now, timeZone), schoolCalendarOptions(appearance)), calendar: true, source: "school" };
}
/** Today's preset for a school theme: a calendar one resolves with the school's own holiday list, lead time and starts. */
export function concreteSchoolPreset(appearance: SchoolAppearance, theme: PresetDashboardTheme, { now, timeZone }: SchoolThemeClock): DashboardThemePresetId {
  return theme.calendar === true ? calendarPresetFor(localDateParts(now, timeZone), schoolCalendarOptions(appearance)) : theme.preset;
}

/**
 * The school theme as the student sign-in gate paints it: public static
 * artwork and a display face per holiday, never a teacher's theme or image.
 */
export type SignInGateBrandFace = { family: string; weight: number; url: string };
export type SignInGateTheme = { preset: DashboardThemePresetId; label: string; artwork: string; mark: DashboardThemePresetId;
  brandFace: SignInGateBrandFace | null };
const brandFaces: Partial<Record<DashboardThemePresetId, { family: string; weight: number; file: string }>> = {
  halloween: { family: "Creepster", weight: 400, file: "creepster-latin.woff2" },
  christmas: { family: "Mountains of Christmas", weight: 700, file: "mountains-of-christmas-700-latin.woff2" },
  valentines: { family: "Pacifico", weight: 400, file: "pacifico-latin.woff2" },
};
export function publicAssetBase(): string {
  return (process.env.PUBLIC_BASE_URL || process.env.CLIENT_URL || "https://school-pilot.net").replace(/\/$/, "");
}
export function signInGateThemeFor(appearanceValue: unknown, clock: SchoolThemeClock): SignInGateTheme | null {
  if (!dashboardThemesEnabled()) return null;
  const appearance = readSchoolAppearance(appearanceValue);
  if (!appearance.signInGateTheme) return null;
  const theme = schoolThemeFor(appearance, clock);
  if (!theme) return null;
  const preset = concreteSchoolPreset(appearance, theme, clock);
  const base = publicAssetBase();
  const face = brandFaces[preset];
  return { preset, label: DASHBOARD_THEME_PRESET_LABELS[preset], artwork: `${base}/themes/${preset}.webp`, mark: preset,
    brandFace: face ? { family: face.family, weight: face.weight, url: `${base}/fonts/${face.file}` } : null };
}

/**
 * One uploaded background image per teacher, recorded on the preferences row.
 * Bytes live in the private attachments bucket; the input is re-encoded to
 * WebP (<= 2560 px, metadata stripped) before it is marked ready.
 */
export const DASHBOARD_THEME_ASSET_MAX_BYTES = 6 * 1024 * 1024;
export const DASHBOARD_THEME_ASSET_MAX_EDGE = 2560;
export const DASHBOARD_THEME_ASSET_INPUT_TYPES = ["image/png", "image/jpeg", "image/webp"] as const;
export type DashboardThemeAssetContentType = typeof DASHBOARD_THEME_ASSET_INPUT_TYPES[number];
export type DashboardThemeAssetStatus = "reserved" | "uploading" | "ready";
export type DashboardThemeAsset = {
  id: string;
  status: DashboardThemeAssetStatus;
  storageKey: string;
  contentType: DashboardThemeAssetContentType;
  byteSize: number;
  sha256: string;
  width?: number;
  height?: number;
  inputSha256: string;
  inputContentType: string;
  inputByteSize: number;
  leaseId: string | null;
  leaseUntil: string | null;
  createdAt: string;
  readyAt: string | null;
  /** Storage key of the previous ready image, deleted once this one is ready. */
  replaces?: string | null;
};
/** The client-visible summary: never the storage key, lease or input hashes. */
export type DashboardThemeAssetSummary = { id: string; status: DashboardThemeAssetStatus; contentType: DashboardThemeAssetContentType;
  byteSize: number; width: number | null; height: number | null };
export function dashboardThemeAssetSummary(asset: DashboardThemeAsset): DashboardThemeAssetSummary {
  return { id: asset.id, status: asset.status, contentType: asset.contentType, byteSize: asset.byteSize,
    width: asset.width ?? null, height: asset.height ?? null };
}
