import { z } from "zod";

/**
 * Teacher dashboard themes: a presentation-only personal preference. This id
 * list mirrors schoolpilot-app/src/shared/themes/presets.js and a unit test
 * keeps the two in step. Preloaded themes are holidays and seasons only.
 */
export const DASHBOARD_THEME_PRESET_IDS = ["halloween", "thanksgiving", "christmas", "advent", "valentines",
  "st-patricks", "easter", "spring", "summer", "fall", "winter"] as const;
export type DashboardThemePresetId = typeof DASHBOARD_THEME_PRESET_IDS[number];
/** `kiosk`: "show my theme on the PassPilot kiosk"; absent means true. Stored as-is. */
export type PresetDashboardTheme = { kind: "preset"; preset: DashboardThemePresetId; name?: string; calendar?: boolean; kiosk?: boolean };
export type ImageDashboardTheme = { kind: "image"; imageAssetId: string; name?: string; kiosk?: boolean };
export type DashboardTheme = PresetDashboardTheme | ImageDashboardTheme;

// Optional teacher label ("Who Dey"). Reserved later fields (palette, pattern,
// accent) stay rejected by strict parsing until they are built.
const themeName = z.string().trim().min(1).max(40).optional();
const kiosk = z.boolean().optional();
const presetTheme = z.object({ kind: z.literal("preset"), preset: z.enum(DASHBOARD_THEME_PRESET_IDS), name: themeName,
  calendar: z.boolean().optional() }).strict();
/** The preset variant without the personal kiosk switch: a school default, never an uploaded image. */
export const presetThemeSchema: z.ZodType<PresetDashboardTheme> = presetTheme;
export const dashboardThemeSchema: z.ZodType<DashboardTheme> = z.discriminatedUnion("kind", [
  presetTheme.extend({ kiosk }).strict(),
  z.object({ kind: z.literal("image"), imageAssetId: z.string().uuid(), name: themeName, kiosk }).strict(),
]);

/** Launch gate. Off: reads report it and theme writes are refused. */
export function dashboardThemesEnabled(): boolean {
  return process.env.CLASSPILOT_DASHBOARD_THEMES_ENABLED === "true";
}

/**
 * School-wide appearance governance stored as `settings.appearance`. Teacher
 * themes default on; uploads and kiosk custom backgrounds default off.
 */
export type SchoolAppearance = {
  teacherThemesEnabled: boolean;
  teacherUploadsEnabled: boolean;
  kioskCustomBackgrounds: boolean;
  lockToSchoolTheme: boolean;
  schoolDefaultTheme: PresetDashboardTheme | null;
};
export const DEFAULT_SCHOOL_APPEARANCE: Readonly<SchoolAppearance> = Object.freeze({ teacherThemesEnabled: true,
  teacherUploadsEnabled: false, kioskCustomBackgrounds: false, lockToSchoolTheme: false, schoolDefaultTheme: null });
const appearanceFlags = ["teacherThemesEnabled", "teacherUploadsEnabled", "kioskCustomBackgrounds", "lockToSchoolTheme"] as const;

/** Normalizes whatever is stored: missing or malformed values fall back to the defaults. */
export function readSchoolAppearance(value: unknown): SchoolAppearance {
  const source: Record<string, unknown> = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const theme = presetThemeSchema.safeParse(source.schoolDefaultTheme);
  const appearance: SchoolAppearance = { ...DEFAULT_SCHOOL_APPEARANCE, schoolDefaultTheme: theme.success ? theme.data : null };
  for (const flag of appearanceFlags) if (typeof source[flag] === "boolean") appearance[flag] = source[flag] as boolean;
  return appearance;
}
export const appearanceSectionSchema = z.object({ expectedVersion: z.string().regex(/^[a-f0-9]{64}$/),
  teacherThemesEnabled: z.boolean(), teacherUploadsEnabled: z.boolean(), kioskCustomBackgrounds: z.boolean(),
  lockToSchoolTheme: z.boolean(), schoolDefaultTheme: presetThemeSchema.nullable() }).strict();

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
