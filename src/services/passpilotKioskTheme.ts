// Database side of the kiosk theme: loads the school's appearance governance
// and the bound teacher's theme row, then applies passpilotKioskThemeRules.
// Callers run inside the kiosk tenant context. Presentation only: nothing in
// the kiosk ticket, checkout or check-in flows reads any of this.

import { and, eq } from "drizzle-orm";
import db from "../db.js";
import { settings } from "../schema/shared.js";
import { classpilotTeacherPreferences } from "../schema/classpilotTeacherPreferences.js";
import { dashboardThemesEnabled, readSchoolAppearance, type SchoolAppearance } from "./classpilotThemes.js";
import { readDashboardThemeAssetContent, themeAssetStoreConfigured, type DashboardThemeAssetContent } from "./classpilotThemeAssetStore.js";
import { kioskMayServeImage, resolveKioskTheme, type KioskTeacherThemeRow, type KioskTheme } from "./passpilotKioskThemeRules.js";

export type { KioskTeacherThemeRow, KioskTheme } from "./passpilotKioskThemeRules.js";
export { resolveKioskTheme } from "./passpilotKioskThemeRules.js";

async function loadAppearance(schoolId: string): Promise<SchoolAppearance> {
  const [school] = await db.select({ appearance: settings.appearance }).from(settings).where(eq(settings.schoolId, schoolId));
  return readSchoolAppearance(school?.appearance);
}

async function loadTeacher(schoolId: string, teacherId: string): Promise<KioskTeacherThemeRow | null> {
  const [own] = await db
    .select({ dashboardTheme: classpilotTeacherPreferences.dashboardTheme, dashboardThemeAsset: classpilotTeacherPreferences.dashboardThemeAsset })
    .from(classpilotTeacherPreferences)
    .where(and(eq(classpilotTeacherPreferences.schoolId, schoolId), eq(classpilotTeacherPreferences.teacherId, teacherId)));
  return own ?? null;
}

/**
 * The theme for a kiosk bound to `teacherId` (null for an unclaimed kiosk).
 * Cheap when the gate is off: no query is made, so kiosks at schools without
 * themes pay nothing on their polls.
 */
export async function kioskThemeFor(schoolId: string, teacherId: string | null, timeZone: string): Promise<KioskTheme | null> {
  if (!dashboardThemesEnabled()) return null;
  const appearance = await loadAppearance(schoolId);
  const teacher = teacherId && !appearance.lockToSchoolTheme && appearance.teacherThemesEnabled ? await loadTeacher(schoolId, teacherId) : null;
  return resolveKioskTheme({ enabled: true, appearance, teacher, timeZone, storeConfigured: themeAssetStoreConfigured() });
}

/**
 * Bytes of an uploaded background for a kiosk bound to `teacherId`: only that
 * teacher's current, ready image, and only while the school allows custom
 * backgrounds on kiosks. Anything else is null, never another teacher's image.
 */
export async function readKioskThemeAssetContent(schoolId: string, teacherId: string, assetId: string): Promise<DashboardThemeAssetContent | null> {
  if (!dashboardThemesEnabled()) return null;
  const appearance = await loadAppearance(schoolId);
  if (!appearance.kioskCustomBackgrounds) return null;
  const teacher = await loadTeacher(schoolId, teacherId);
  if (!kioskMayServeImage(appearance, teacher, assetId)) return null;
  const content = await readDashboardThemeAssetContent(schoolId, assetId);
  return content && content.teacherId === teacherId ? content : null;
}
