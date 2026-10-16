import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { afterEach, describe, it } from "node:test";
import { DASHBOARD_THEME_ASSET_INPUT_TYPES, DASHBOARD_THEME_ASSET_MAX_BYTES, DASHBOARD_THEME_ASSET_MAX_EDGE,
  DASHBOARD_THEME_PRESET_IDS, DEFAULT_SCHOOL_APPEARANCE, appearanceSectionSchema, dashboardThemeAssetSummary, dashboardThemeSchema,
  dashboardThemesEnabled, presetThemeSchema, readSchoolAppearance, type DashboardThemeAsset } from "../src/services/classpilotThemes.js";

const originalGate = process.env.CLASSPILOT_DASHBOARD_THEMES_ENABLED;
afterEach(() => {
  if (originalGate === undefined) delete process.env.CLASSPILOT_DASHBOARD_THEMES_ENABLED;
  else process.env.CLASSPILOT_DASHBOARD_THEMES_ENABLED = originalGate;
});

describe("ClassPilot dashboard theme model", () => {
  it("lists unique kebab-case holiday and season presets only", () => {
    assert.equal(new Set(DASHBOARD_THEME_PRESET_IDS).size, DASHBOARD_THEME_PRESET_IDS.length);
    for (const id of DASHBOARD_THEME_PRESET_IDS) assert.match(id, /^[a-z]+(-[a-z]+)*$/);
    assert.deepEqual([...DASHBOARD_THEME_PRESET_IDS], ["halloween", "thanksgiving", "christmas", "advent", "valentines",
      "st-patricks", "easter", "spring", "summer", "fall", "winter"]);
  });

  it("accepts preset themes, trims the label and drops absent optional keys", () => {
    assert.deepEqual(dashboardThemeSchema.parse({ kind: "preset", preset: "halloween" }), { kind: "preset", preset: "halloween" });
    assert.deepEqual(dashboardThemeSchema.parse({ kind: "preset", preset: "advent", name: "  Who Dey  ", calendar: true }),
      { kind: "preset", preset: "advent", name: "Who Dey", calendar: true });
    assert.equal(dashboardThemeSchema.safeParse({ kind: "preset", preset: "halloween", name: "x".repeat(40) }).success, true);
    for (const preset of DASHBOARD_THEME_PRESET_IDS) assert.equal(dashboardThemeSchema.safeParse({ kind: "preset", preset }).success, true, preset);
  });

  it("accepts a well-formed image theme at the model layer", () => {
    const imageAssetId = randomUUID();
    assert.deepEqual(dashboardThemeSchema.parse({ kind: "image", imageAssetId, name: "Mascot" }), { kind: "image", imageAssetId, name: "Mascot" });
  });

  it("stores the personal kiosk switch as-is on both variants and nowhere else", () => {
    const imageAssetId = randomUUID();
    assert.deepEqual(dashboardThemeSchema.parse({ kind: "preset", preset: "fall", kiosk: false }), { kind: "preset", preset: "fall", kiosk: false });
    assert.deepEqual(dashboardThemeSchema.parse({ kind: "image", imageAssetId, kiosk: true }), { kind: "image", imageAssetId, kiosk: true });
    assert.equal("kiosk" in dashboardThemeSchema.parse({ kind: "preset", preset: "fall" }), false, "absent stays absent (means true)");
    assert.equal(dashboardThemeSchema.safeParse({ kind: "preset", preset: "fall", kiosk: "yes" }).success, false);
    // A school default has no personal kiosk switch.
    assert.equal(presetThemeSchema.safeParse({ kind: "preset", preset: "fall", kiosk: true }).success, false);
  });

  it("rejects unknown presets, bad labels, extra or reserved fields and malformed images", () => {
    const rejected: unknown[] = [
      null, undefined, "halloween", 7, [], {}, { preset: "halloween" }, { kind: "palette", palette: "team" },
      { kind: "preset" }, { kind: "preset", preset: "bengals" }, { kind: "preset", preset: "Halloween" }, { kind: "preset", preset: "" },
      { kind: "preset", preset: "halloween", name: "" }, { kind: "preset", preset: "halloween", name: "   " },
      { kind: "preset", preset: "halloween", name: "x".repeat(41) }, { kind: "preset", preset: "halloween", name: 7 },
      { kind: "preset", preset: "halloween", calendar: "yes" }, { kind: "preset", preset: "halloween", imageAssetId: randomUUID() },
      { kind: "preset", preset: "halloween", palette: "team" }, { kind: "preset", preset: "halloween", accent: "#fb4f14" },
      { kind: "preset", preset: "halloween", pattern: "stripes" },
      { kind: "image" }, { kind: "image", imageAssetId: "not-a-uuid" }, { kind: "image", imageAssetId: randomUUID(), calendar: true },
      { kind: "image", imageAssetId: randomUUID(), preset: "halloween" },
    ];
    for (const body of rejected) assert.equal(dashboardThemeSchema.safeParse(body).success, false, JSON.stringify(body) ?? "undefined");
  });

  it("gates on the exact string true", () => {
    for (const value of [undefined, "", "1", "TRUE", "yes", "false", " true"]) {
      if (value === undefined) delete process.env.CLASSPILOT_DASHBOARD_THEMES_ENABLED;
      else process.env.CLASSPILOT_DASHBOARD_THEMES_ENABLED = value;
      assert.equal(dashboardThemesEnabled(), false, String(value));
    }
    process.env.CLASSPILOT_DASHBOARD_THEMES_ENABLED = "true";
    assert.equal(dashboardThemesEnabled(), true);
  });

  // The frontend catalog lands with the Phase 2 UI half; until it is in this
  // checkout there is nothing to compare, so the case records a skip.
  it("matches the frontend preset catalog when it is present", t => {
    const catalog = new URL("../schoolpilot-app/src/shared/themes/presets.js", import.meta.url);
    if (!existsSync(catalog)) return t.skip("frontend catalog not in this checkout");
    const ids = [...readFileSync(catalog, "utf8").matchAll(/\bid:\s*["']([a-z-]+)["']/g)].map(match => match[1]);
    assert.deepEqual(ids, [...DASHBOARD_THEME_PRESET_IDS]);
  });
});

describe("ClassPilot school appearance governance", () => {
  const defaults = { teacherThemesEnabled: true, teacherUploadsEnabled: false, kioskCustomBackgrounds: false, lockToSchoolTheme: false, schoolDefaultTheme: null };

  it("reads defaults from anything that is not a stored object", () => {
    assert.deepEqual({ ...DEFAULT_SCHOOL_APPEARANCE }, defaults);
    for (const stored of [null, undefined, {}, [], "appearance", 7, true]) assert.deepEqual(readSchoolAppearance(stored), defaults, JSON.stringify(stored) ?? "undefined");
    assert.notEqual(readSchoolAppearance(null), DEFAULT_SCHOOL_APPEARANCE, "callers get their own copy");
  });

  it("keeps valid flags and a preset default, and drops anything else field by field", () => {
    assert.deepEqual(readSchoolAppearance({ teacherThemesEnabled: false, teacherUploadsEnabled: true, kioskCustomBackgrounds: true,
      lockToSchoolTheme: true, schoolDefaultTheme: { kind: "preset", preset: "winter", name: "School" } }),
    { teacherThemesEnabled: false, teacherUploadsEnabled: true, kioskCustomBackgrounds: true, lockToSchoolTheme: true,
      schoolDefaultTheme: { kind: "preset", preset: "winter", name: "School" } });
    assert.deepEqual(readSchoolAppearance({ teacherThemesEnabled: "false", teacherUploadsEnabled: 1, lockToSchoolTheme: null, extra: true,
      schoolDefaultTheme: { kind: "image", imageAssetId: randomUUID() } }), defaults, "garbage flags and an image default fall back");
    assert.equal(readSchoolAppearance({ schoolDefaultTheme: { kind: "preset", preset: "retired-preset" } }).schoolDefaultTheme, null);
    assert.equal(readSchoolAppearance({ schoolDefaultTheme: { kind: "preset", preset: "fall", kiosk: true } }).schoolDefaultTheme, null, "no personal switch on a school default");
  });

  it("validates the appearance section strictly with a preset-only default", () => {
    const expectedVersion = "a".repeat(64);
    const section = { expectedVersion, ...defaults, schoolDefaultTheme: { kind: "preset", preset: "spring" } };
    assert.deepEqual(appearanceSectionSchema.parse(section), section);
    assert.equal(appearanceSectionSchema.safeParse({ expectedVersion, ...defaults }).success, true);
    const rejected: unknown[] = [
      { ...section, schoolDefaultTheme: { kind: "image", imageAssetId: randomUUID() } },
      { ...section, schoolDefaultTheme: { kind: "preset", preset: "bengals" } },
      { ...section, schoolDefaultTheme: { kind: "preset", preset: "spring", kiosk: true } },
      { ...section, expectedVersion: "stale" }, { ...section, teacherThemesEnabled: "true" }, { ...section, schoolId: randomUUID() },
      { ...defaults }, { expectedVersion, teacherThemesEnabled: true },
    ];
    for (const body of rejected) assert.equal(appearanceSectionSchema.safeParse(body).success, false, JSON.stringify(body));
  });
});

describe("ClassPilot dashboard theme asset model", () => {
  it("fixes the upload limits and input types", () => {
    assert.equal(DASHBOARD_THEME_ASSET_MAX_BYTES, 6 * 1024 * 1024);
    assert.equal(DASHBOARD_THEME_ASSET_MAX_EDGE, 2560);
    assert.deepEqual([...DASHBOARD_THEME_ASSET_INPUT_TYPES], ["image/png", "image/jpeg", "image/webp"]);
  });

  it("summarizes an asset without its storage key, lease or input hashes", () => {
    const asset: DashboardThemeAsset = { id: randomUUID(), status: "ready", storageKey: "classpilot/themes/s/t/a", contentType: "image/webp",
      byteSize: 1234, sha256: "b".repeat(64), width: 2560, height: 1440, inputSha256: "c".repeat(64), inputContentType: "image/png",
      inputByteSize: 99999, leaseId: null, leaseUntil: null, createdAt: "2026-10-16T00:00:00.000Z", readyAt: "2026-10-16T00:00:01.000Z", replaces: null };
    assert.deepEqual(dashboardThemeAssetSummary(asset), { id: asset.id, status: "ready", contentType: "image/webp", byteSize: 1234, width: 2560, height: 1440 });
    assert.deepEqual(dashboardThemeAssetSummary({ ...asset, status: "reserved", width: undefined, height: undefined }),
      { id: asset.id, status: "reserved", contentType: "image/webp", byteSize: 1234, width: null, height: null });
    for (const secret of ["storageKey", "leaseId", "inputSha256", "sha256", "replaces"]) assert.equal(secret in dashboardThemeAssetSummary(asset), false, secret);
  });
});
