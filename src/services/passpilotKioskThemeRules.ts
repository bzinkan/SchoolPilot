// Which dashboard theme a PassPilot kiosk shows: the pure rules, with no
// database or object-store imports so unit tests load them directly.
//
// A kiosk has no theme of its own; it inherits. Resolution order, from
// docs/CLASSPILOT_DASHBOARD_THEMES.md §4.11 and §9.4:
//   1. lockToSchoolTheme on → the school theme, for every kiosk.
//   2. The bound teacher's theme, while teacher themes are allowed: "plain,
//      no theme" means a plain kiosk; a preset or image shows while the
//      teacher's "show my theme on the kiosk" switch is on, an uploaded image
//      additionally needing uploads allowed, kioskCustomBackgrounds on and the
//      bytes ready, because the kiosk is a shared device students look at.
//   3. The school theme: the fixed default, else today's calendar preset while
//      the automatic calendar is on (also covers kiosks bound to no teacher).
//   4. Otherwise null: the kiosk's current look.
// Calendar mode is resolved here, in the school's time zone, so the kiosk only
// ever receives a concrete preset.

import { concreteSchoolPreset, schoolThemeFor, type DashboardTheme, type DashboardThemeAsset, type DashboardThemePresetId,
  type PresetDashboardTheme, type SchoolAppearance } from "./classpilotThemes.js";
import { calendarPresetFor, localDateParts, teacherCalendarHolidays } from "./classpilotThemeCalendar.js";

export type KioskTheme =
  | { kind: "preset"; preset: DashboardThemePresetId }
  | { kind: "image"; imageAssetId: string };

export type KioskTeacherThemeRow = {
  dashboardTheme: DashboardTheme | null;
  dashboardThemeAsset: DashboardThemeAsset | null;
};

export type KioskThemeInputs = {
  /** The launch gate (CLASSPILOT_DASHBOARD_THEMES_ENABLED). */
  enabled: boolean;
  appearance: SchoolAppearance;
  teacher: KioskTeacherThemeRow | null;
  timeZone: string;
  /** Whether the object store that holds uploaded images is configured. */
  storeConfigured: boolean;
  now?: Date;
};

// A teacher's own calendar theme may show every holiday (Advent only when the
// stored preset hints at it) and follows the school's lead time and early
// starts, exactly as the dashboard resolves it in the browser.
function concreteTeacherPreset(theme: PresetDashboardTheme, appearance: SchoolAppearance, timeZone: string, now: Date): KioskTheme {
  if (theme.calendar !== true) return { kind: "preset", preset: theme.preset };
  return { kind: "preset", preset: calendarPresetFor(localDateParts(now, timeZone),
    { allowed: teacherCalendarHolidays(theme.preset), leadDays: appearance.calendarLeadDays, starts: appearance.calendarStarts }) };
}

export function resolveKioskTheme(inputs: KioskThemeInputs): KioskTheme | null {
  if (!inputs.enabled) return null;
  const { appearance, teacher, timeZone } = inputs;
  const now = inputs.now ?? new Date();
  const school = schoolThemeFor(appearance, { now, timeZone });
  const schoolDefault: KioskTheme | null = school ? { kind: "preset", preset: concreteSchoolPreset(appearance, school, { now, timeZone }) } : null;
  if (appearance.lockToSchoolTheme) return schoolDefault;
  const own = teacher?.dashboardTheme ?? null;
  if (own && appearance.teacherThemesEnabled) {
    if (own.kind === "none") return null;
    if (own.kiosk !== false) {
      if (own.kind === "preset") return concreteTeacherPreset(own, appearance, timeZone, now);
      const asset = teacher?.dashboardThemeAsset ?? null;
      if (appearance.teacherUploadsEnabled && appearance.kioskCustomBackgrounds && inputs.storeConfigured
        && asset?.status === "ready" && asset.id === own.imageAssetId) {
        return { kind: "image", imageAssetId: own.imageAssetId };
      }
    }
  }
  return schoolDefault;
}

/** Whether a kiosk bound to this teacher may be served this uploaded image. */
export function kioskMayServeImage(appearance: SchoolAppearance, teacher: KioskTeacherThemeRow | null, assetId: string): boolean {
  if (appearance.lockToSchoolTheme || !appearance.teacherThemesEnabled || !appearance.teacherUploadsEnabled || !appearance.kioskCustomBackgrounds) return false;
  const theme = teacher?.dashboardTheme ?? null;
  if (!theme || theme.kind !== "image" || theme.kiosk === false || theme.imageAssetId !== assetId) return false;
  return teacher?.dashboardThemeAsset?.id === assetId && teacher.dashboardThemeAsset.status === "ready";
}
