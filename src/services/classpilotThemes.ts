import { z } from "zod";

/**
 * Teacher dashboard themes: a presentation-only personal preference. This id
 * list mirrors schoolpilot-app/src/shared/themes/presets.js and a unit test
 * keeps the two in step. Preloaded themes are holidays and seasons only.
 */
export const DASHBOARD_THEME_PRESET_IDS = ["halloween", "thanksgiving", "christmas", "advent", "valentines",
  "st-patricks", "easter", "spring", "summer", "fall", "winter"] as const;
export type DashboardThemePresetId = typeof DASHBOARD_THEME_PRESET_IDS[number];
export type DashboardTheme =
  | { kind: "preset"; preset: DashboardThemePresetId; name?: string; calendar?: boolean }
  | { kind: "image"; imageAssetId: string; name?: string };

// Optional teacher label ("Who Dey"). Reserved later fields (palette, pattern,
// accent) stay rejected by strict parsing until they are built.
const themeName = z.string().trim().min(1).max(40).optional();
export const dashboardThemeSchema: z.ZodType<DashboardTheme> = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("preset"), preset: z.enum(DASHBOARD_THEME_PRESET_IDS), name: themeName, calendar: z.boolean().optional() }).strict(),
  z.object({ kind: z.literal("image"), imageAssetId: z.string().uuid(), name: themeName }).strict(),
]);

/** Launch gate. Off: reads report it and theme writes are refused. */
export function dashboardThemesEnabled(): boolean {
  return process.env.CLASSPILOT_DASHBOARD_THEMES_ENABLED === "true";
}
