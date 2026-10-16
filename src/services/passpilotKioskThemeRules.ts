// Which dashboard theme a PassPilot kiosk shows: the pure rules, with no
// database or object-store imports so unit tests load them directly.
//
// A kiosk has no theme of its own; it inherits. Resolution order, from
// docs/CLASSPILOT_DASHBOARD_THEMES.md §4.11:
//   1. lockToSchoolTheme on → the school theme, for every kiosk.
//   2. The bound teacher's theme, while teacher themes are allowed and the
//      teacher's "show my theme on the kiosk" switch is on; an uploaded image
//      additionally needs uploads allowed, kioskCustomBackgrounds on and the
//      bytes ready, because the kiosk is a shared device students look at.
//   3. The school default, if set (also covers kiosks bound to no teacher).
//   4. Otherwise null: the kiosk's current look.
// Calendar mode is resolved here, in the school's time zone, so the kiosk only
// ever receives a concrete preset.

import type { DashboardTheme, DashboardThemeAsset, DashboardThemePresetId, SchoolAppearance } from "./classpilotThemes.js";
import { calendarPresetFor, localDateParts } from "./classpilotThemeCalendar.js";

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

function concretePreset(theme: Extract<DashboardTheme, { kind: "preset" }>, timeZone: string, now: Date): KioskTheme {
  if (theme.calendar !== true) return { kind: "preset", preset: theme.preset };
  return { kind: "preset", preset: calendarPresetFor(localDateParts(now, timeZone), { liturgical: theme.preset === "advent" }) };
}

export function resolveKioskTheme(inputs: KioskThemeInputs): KioskTheme | null {
  if (!inputs.enabled) return null;
  const { appearance, teacher, timeZone } = inputs;
  const now = inputs.now ?? new Date();
  const schoolDefault = appearance.schoolDefaultTheme ? concretePreset(appearance.schoolDefaultTheme, timeZone, now) : null;
  if (appearance.lockToSchoolTheme) return schoolDefault;
  const own = teacher?.dashboardTheme ?? null;
  if (own && appearance.teacherThemesEnabled && own.kiosk !== false) {
    if (own.kind === "preset") return concretePreset(own, timeZone, now);
    const asset = teacher?.dashboardThemeAsset ?? null;
    if (appearance.teacherUploadsEnabled && appearance.kioskCustomBackgrounds && inputs.storeConfigured
      && asset?.status === "ready" && asset.id === own.imageAssetId) {
      return { kind: "image", imageAssetId: own.imageAssetId };
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
