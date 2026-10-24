import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { afterEach, describe, it } from "node:test";
import { DASHBOARD_THEME_ASSET_INPUT_TYPES, DASHBOARD_THEME_ASSET_MAX_BYTES, DASHBOARD_THEME_ASSET_MAX_EDGE, DASHBOARD_THEME_IMAGE_FITS,
  DASHBOARD_THEME_LIBRARY_LIMIT, DASHBOARD_THEME_PRESET_IDS, DASHBOARD_THEME_PRESET_LABELS, DEFAULT_SCHOOL_APPEARANCE, appearanceSectionSchema,
  concreteSchoolPreset, dashboardThemeAssetSummary, dashboardThemeSchema, dashboardThemesEnabled, imageThemeFit, mergeSchoolAppearance,
  presetThemeSchema, readSchoolAppearance, schoolThemeFor, signInGateThemeFor, type DashboardThemeAsset,
  type SchoolAppearance } from "../src/services/classpilotThemes.js";
import { DEFAULT_CALENDAR_HOLIDAYS } from "../src/services/classpilotThemeCalendar.js";

const originalEnv = { gate: process.env.CLASSPILOT_DASHBOARD_THEMES_ENABLED, base: process.env.PUBLIC_BASE_URL, client: process.env.CLIENT_URL };
function restore(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
afterEach(() => {
  restore("CLASSPILOT_DASHBOARD_THEMES_ENABLED", originalEnv.gate);
  restore("PUBLIC_BASE_URL", originalEnv.base);
  restore("CLIENT_URL", originalEnv.client);
});

const OCT_26 = new Date("2026-10-26T16:00:00Z"); // inside the ten-day Halloween window in New York
const OCT_16 = new Date("2026-10-16T16:00:00Z"); // five days before it opens
const DEC_20 = new Date("2026-12-20T16:00:00Z"); // the Christmas window
const APR_1 = new Date("2026-04-01T16:00:00Z"); // the Easter 2026 run-up (Apr 5)
const clock = (now: Date) => ({ now, timeZone: "America/New_York" });
const appearance = (overrides: Partial<SchoolAppearance> = {}): SchoolAppearance => ({ ...DEFAULT_SCHOOL_APPEARANCE, ...overrides });

describe("ClassPilot dashboard theme model", () => {
  it("lists unique kebab-case holiday and season presets only, each with a label", () => {
    assert.equal(new Set(DASHBOARD_THEME_PRESET_IDS).size, DASHBOARD_THEME_PRESET_IDS.length);
    for (const id of DASHBOARD_THEME_PRESET_IDS) assert.match(id, /^[a-z]+(-[a-z]+)*$/);
    assert.deepEqual([...DASHBOARD_THEME_PRESET_IDS], ["halloween", "thanksgiving", "christmas", "advent", "valentines",
      "st-patricks", "easter", "spring", "summer", "fall", "winter"]);
    assert.deepEqual(DASHBOARD_THEME_PRESET_LABELS, { halloween: "Halloween", thanksgiving: "Thanksgiving", christmas: "Christmas", advent: "Advent",
      valentines: "Valentine's Day", "st-patricks": "St. Patrick's Day", easter: "Easter", spring: "Spring", summer: "Summer", fall: "Fall", winter: "Winter" });
  });

  it("accepts preset themes, trims the label and drops absent optional keys", () => {
    assert.deepEqual(dashboardThemeSchema.parse({ kind: "preset", preset: "halloween" }), { kind: "preset", preset: "halloween" });
    assert.deepEqual(dashboardThemeSchema.parse({ kind: "preset", preset: "advent", name: "  Who Dey  ", calendar: true }),
      { kind: "preset", preset: "advent", name: "Who Dey", calendar: true });
    assert.equal(dashboardThemeSchema.safeParse({ kind: "preset", preset: "halloween", name: "x".repeat(40) }).success, true);
    for (const preset of DASHBOARD_THEME_PRESET_IDS) assert.equal(dashboardThemeSchema.safeParse({ kind: "preset", preset }).success, true, preset);
  });

  it("accepts a well-formed image theme at the model layer, with an optional fit stored as sent", () => {
    const imageAssetId = randomUUID();
    assert.deepEqual(dashboardThemeSchema.parse({ kind: "image", imageAssetId, name: "Mascot" }), { kind: "image", imageAssetId, name: "Mascot" });
    assert.deepEqual([...DASHBOARD_THEME_IMAGE_FITS], ["cover", "contain", "tile"]);
    for (const fit of DASHBOARD_THEME_IMAGE_FITS) {
      assert.deepEqual(dashboardThemeSchema.parse({ kind: "image", imageAssetId, fit, kiosk: false }), { kind: "image", imageAssetId, fit, kiosk: false }, fit);
    }
    assert.equal("fit" in dashboardThemeSchema.parse({ kind: "image", imageAssetId }), false, "absent stays absent (reads as cover)");
    assert.equal(imageThemeFit({ kind: "image", imageAssetId }), "cover");
    assert.equal(imageThemeFit({ kind: "image", imageAssetId, fit: "contain" }), "contain");
    assert.equal(imageThemeFit({ fit: null }), "cover");
    assert.equal(imageThemeFit(JSON.parse("{\"fit\":\"stretch\"}")), "cover", "an unknown stored fit reads as cover");
  });

  it("accepts the teacher's plain choice as exactly { kind: none }", () => {
    assert.deepEqual(dashboardThemeSchema.parse({ kind: "none" }), { kind: "none" });
    for (const body of [{ kind: "none", kiosk: false }, { kind: "none", name: "Plain" }, { kind: "none", preset: "fall" }, { kind: "none", calendar: true }]) {
      assert.equal(dashboardThemeSchema.safeParse(body).success, false, JSON.stringify(body));
    }
    assert.equal(presetThemeSchema.safeParse({ kind: "none" }).success, false, "a school default is a preset, never plain");
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
      { kind: "image", imageAssetId: randomUUID(), fit: "stretch" }, { kind: "image", imageAssetId: randomUUID(), fit: "Cover" },
      { kind: "image", imageAssetId: randomUUID(), fit: null }, { kind: "image", imageAssetId: randomUUID(), fit: "" },
      { kind: "preset", preset: "halloween", fit: "cover" }, { kind: "none", fit: "cover" },
    ];
    for (const body of rejected) assert.equal(dashboardThemeSchema.safeParse(body).success, false, JSON.stringify(body) ?? "undefined");
  });

  it("never stores the response-only source marker of a resolved school theme", () => {
    const marked: unknown[] = [
      { kind: "preset", preset: "halloween", source: "school" }, { kind: "preset", preset: "halloween", calendar: true, source: "school" },
      { kind: "image", imageAssetId: randomUUID(), source: "school" }, { kind: "none", source: "school" },
    ];
    for (const body of marked) {
      assert.equal(dashboardThemeSchema.safeParse(body).success, false, JSON.stringify(body));
      assert.equal(presetThemeSchema.safeParse(body).success, false, JSON.stringify(body));
    }
    assert.equal(readSchoolAppearance({ schoolDefaultTheme: { kind: "preset", preset: "fall", source: "school" } }).schoolDefaultTheme, null);
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
    // Only the preloaded catalog entries count: the frontend also describes the
    // teacher-uploaded "image" look with an id, which is not a preset.
    const source = readFileSync(catalog, "utf8");
    const block = source.match(/const PRESETS = Object\.freeze\(\[([\s\S]*?)\n\]\);/)?.[1] ?? "";
    assert.ok(block, "the frontend catalog keeps its PRESETS array");
    const entries = [...block.matchAll(/\bid:\s*["']([a-z-]+)["'],\s*label:\s*(?:'([^']*)'|"([^"]*)")/g)]
      .map(match => [match[1], match[2] ?? match[3]]);
    assert.deepEqual(entries.map(([id]) => id), [...DASHBOARD_THEME_PRESET_IDS]);
    assert.deepEqual(Object.fromEntries(entries), { ...DASHBOARD_THEME_PRESET_LABELS }, "the sign-in gate shows the catalog's labels");
    assert.match(source, /id: 'image'/, "the uploaded-image look keeps its own id outside the preset list");
  });
});

describe("ClassPilot school appearance governance", () => {
  const defaults = { teacherThemesEnabled: true, teacherUploadsEnabled: false, kioskCustomBackgrounds: false, lockToSchoolTheme: false, schoolDefaultTheme: null,
    autoCalendar: true, calendarHolidays: ["halloween", "thanksgiving", "valentines", "st-patricks"], calendarLeadDays: 10, calendarStarts: {}, signInGateTheme: true };
  const expectedVersion = "a".repeat(64);
  const section = { expectedVersion, teacherThemesEnabled: true, teacherUploadsEnabled: false, kioskCustomBackgrounds: false, lockToSchoolTheme: false, schoolDefaultTheme: null };

  it("reads defaults from anything that is not a stored object, with no faith holiday on the automatic calendar", () => {
    assert.deepEqual({ ...DEFAULT_SCHOOL_APPEARANCE }, defaults);
    assert.deepEqual([...DEFAULT_CALENDAR_HOLIDAYS], defaults.calendarHolidays);
    for (const stored of [null, undefined, {}, [], "appearance", 7, true]) assert.deepEqual(readSchoolAppearance(stored), defaults, JSON.stringify(stored) ?? "undefined");
    const copy = readSchoolAppearance(null);
    assert.notEqual(copy, DEFAULT_SCHOOL_APPEARANCE, "callers get their own copy");
    assert.notEqual(copy.calendarHolidays, DEFAULT_SCHOOL_APPEARANCE.calendarHolidays, "including the holiday list");
    assert.notEqual(copy.calendarStarts, DEFAULT_SCHOOL_APPEARANCE.calendarStarts);
  });

  it("keeps valid flags and a preset default, and drops anything else field by field", () => {
    assert.deepEqual(readSchoolAppearance({ teacherThemesEnabled: false, teacherUploadsEnabled: true, kioskCustomBackgrounds: true,
      lockToSchoolTheme: true, schoolDefaultTheme: { kind: "preset", preset: "winter", name: "School" }, autoCalendar: false, signInGateTheme: false }),
    { ...defaults, teacherThemesEnabled: false, teacherUploadsEnabled: true, kioskCustomBackgrounds: true, lockToSchoolTheme: true,
      schoolDefaultTheme: { kind: "preset", preset: "winter", name: "School" }, autoCalendar: false, signInGateTheme: false });
    assert.deepEqual(readSchoolAppearance({ teacherThemesEnabled: "false", teacherUploadsEnabled: 1, lockToSchoolTheme: null, extra: true,
      autoCalendar: "no", signInGateTheme: 0, schoolDefaultTheme: { kind: "image", imageAssetId: randomUUID() } }), defaults, "garbage flags and an image default fall back");
    assert.equal(readSchoolAppearance({ schoolDefaultTheme: { kind: "preset", preset: "retired-preset" } }).schoolDefaultTheme, null);
    assert.equal(readSchoolAppearance({ schoolDefaultTheme: { kind: "preset", preset: "fall", kiosk: true } }).schoolDefaultTheme, null, "no personal switch on a school default");
    assert.equal(readSchoolAppearance({ schoolDefaultTheme: { kind: "none" } }).schoolDefaultTheme, null, "a school default is never plain");
  });

  it("normalizes the stored calendar: unknown holidays dropped, duplicates removed, lead clamped, bad starts dropped", () => {
    assert.deepEqual(readSchoolAppearance({ calendarHolidays: ["christmas", "bengals", "halloween", "christmas", 7, null, "advent"] }).calendarHolidays,
      ["christmas", "halloween", "advent"], "order kept");
    assert.deepEqual(readSchoolAppearance({ calendarHolidays: [] }).calendarHolidays, [], "an empty list is seasons only, not the default");
    for (const bad of ["halloween", {}, null, 7]) assert.deepEqual(readSchoolAppearance({ calendarHolidays: bad }).calendarHolidays, defaults.calendarHolidays, JSON.stringify(bad));
    assert.equal(readSchoolAppearance({ calendarLeadDays: 90 }).calendarLeadDays, 30);
    assert.equal(readSchoolAppearance({ calendarLeadDays: -3 }).calendarLeadDays, 0);
    assert.equal(readSchoolAppearance({ calendarLeadDays: 12.6 }).calendarLeadDays, 13);
    for (const bad of ["abc", null, undefined, {}]) assert.equal(readSchoolAppearance({ calendarLeadDays: bad }).calendarLeadDays, 10, JSON.stringify(bad) ?? "undefined");
    assert.deepEqual(readSchoolAppearance({ calendarStarts: { halloween: "2026-10-19", christmas: "2026-12-11", easter: "2026-02-30", valentines: "Monday",
      thanksgiving: 20261120, "st-patricks": null, bengals: "2026-09-01" } }).calendarStarts, { halloween: "2026-10-19", christmas: "2026-12-11" });
    for (const bad of [[], "2026-10-19", null, 7]) assert.deepEqual(readSchoolAppearance({ calendarStarts: bad }).calendarStarts, {}, JSON.stringify(bad));
  });

  it("validates the appearance section strictly: the original switches required, the calendar keys optional", () => {
    const full = { ...section, schoolDefaultTheme: { kind: "preset", preset: "spring" }, autoCalendar: false, signInGateTheme: false,
      calendarHolidays: ["christmas", "halloween"], calendarLeadDays: 0, calendarStarts: { halloween: "2026-10-19", christmas: null } };
    assert.deepEqual(appearanceSectionSchema.parse(full), full);
    assert.deepEqual(appearanceSectionSchema.parse(section), section, "the calendar keys may be omitted");
    assert.equal(appearanceSectionSchema.safeParse({ ...section, calendarHolidays: [] }).success, true);
    assert.equal(appearanceSectionSchema.safeParse({ ...section, calendarHolidays: ["valentines", "st-patricks", "easter", "halloween", "thanksgiving", "advent", "christmas"] }).success, true);
    assert.equal(appearanceSectionSchema.safeParse({ ...section, calendarLeadDays: 30, calendarStarts: {} }).success, true);
    const rejected: unknown[] = [
      { ...section, schoolDefaultTheme: { kind: "image", imageAssetId: randomUUID() } },
      { ...section, schoolDefaultTheme: { kind: "preset", preset: "bengals" } },
      { ...section, schoolDefaultTheme: { kind: "preset", preset: "spring", kiosk: true } },
      { ...section, schoolDefaultTheme: { kind: "none" } },
      { ...section, expectedVersion: "stale" }, { ...section, teacherThemesEnabled: "true" }, { ...section, schoolId: randomUUID() },
      { teacherThemesEnabled: true, teacherUploadsEnabled: false, kioskCustomBackgrounds: false, lockToSchoolTheme: false, schoolDefaultTheme: null },
      { expectedVersion, teacherThemesEnabled: true },
      { ...section, autoCalendar: "yes" }, { ...section, signInGateTheme: null },
      { ...section, calendarHolidays: ["halloween", "halloween"] }, { ...section, calendarHolidays: ["bengals"] }, { ...section, calendarHolidays: "halloween" },
      { ...section, calendarLeadDays: 31 }, { ...section, calendarLeadDays: -1 }, { ...section, calendarLeadDays: 2.5 }, { ...section, calendarLeadDays: "10" },
      { ...section, calendarStarts: { halloween: "2026-02-30" } }, { ...section, calendarStarts: { halloween: "Monday" } },
      { ...section, calendarStarts: { bengals: "2026-10-19" } }, { ...section, calendarStarts: [] }, { ...section, calendarStarts: { halloween: 20261019 } },
    ];
    for (const body of rejected) assert.equal(appearanceSectionSchema.safeParse(body).success, false, JSON.stringify(body));
  });

  it("accepts empty and single-holiday start edits without replacing other stored starts", () => {
    const stored = { ...defaults, calendarStarts: { halloween: "2026-10-19", christmas: "2026-12-11" } };
    const empty = appearanceSectionSchema.parse({ ...section, calendarStarts: {} });
    assert.deepEqual(empty.calendarStarts, {});
    assert.deepEqual(mergeSchoolAppearance(stored, empty).calendarStarts, stored.calendarStarts);
    const clear = appearanceSectionSchema.parse({ ...section, calendarStarts: { halloween: null } });
    assert.deepEqual(clear.calendarStarts, { halloween: null });
    assert.deepEqual(mergeSchoolAppearance(stored, clear).calendarStarts, { christmas: "2026-12-11" });
  });

  it("merges a section save over the live values: omitted keys keep theirs, starts merge per holiday and null clears one", () => {
    const stored = { ...defaults, autoCalendar: false, calendarHolidays: ["christmas"], calendarLeadDays: 20, calendarStarts: { halloween: "2026-10-19", christmas: "2026-12-11" }, signInGateTheme: false };
    const required = { teacherThemesEnabled: true, teacherUploadsEnabled: true, kioskCustomBackgrounds: false, lockToSchoolTheme: false, schoolDefaultTheme: null };
    assert.deepEqual(mergeSchoolAppearance(stored, required), { ...stored, teacherUploadsEnabled: true }, "a client without the calendar keys keeps them");
    assert.deepEqual(mergeSchoolAppearance(stored, { ...required, calendarStarts: { halloween: null, easter: "2026-03-30" } }).calendarStarts,
      { christmas: "2026-12-11", easter: "2026-03-30" });
    assert.deepEqual(mergeSchoolAppearance(stored, { ...required, calendarHolidays: [], calendarLeadDays: 0, autoCalendar: true, signInGateTheme: true }),
      { ...stored, teacherUploadsEnabled: true, calendarHolidays: [], calendarLeadDays: 0, autoCalendar: true, signInGateTheme: true });
    assert.deepEqual(mergeSchoolAppearance(null, required), { ...defaults, teacherUploadsEnabled: true }, "from nothing stored, the defaults");
    assert.deepEqual(mergeSchoolAppearance(stored, { ...required, calendarStarts: { halloween: null, christmas: null } }).calendarStarts, {});
  });

  it("resolves the school theme: a fixed default wins, else today's calendar while automatic, else nothing", () => {
    assert.deepEqual(schoolThemeFor(appearance({ schoolDefaultTheme: { kind: "preset", preset: "winter", name: "School" } }), clock(OCT_26)),
      { kind: "preset", preset: "winter", name: "School", source: "school" });
    assert.deepEqual(schoolThemeFor(appearance(), clock(OCT_26)), { kind: "preset", preset: "halloween", calendar: true, source: "school" });
    assert.deepEqual(schoolThemeFor(appearance(), clock(OCT_16)), { kind: "preset", preset: "fall", calendar: true, source: "school" });
    assert.equal(schoolThemeFor(appearance({ autoCalendar: false }), clock(OCT_26)), null);
    assert.deepEqual(schoolThemeFor(appearance({ autoCalendar: false, schoolDefaultTheme: { kind: "preset", preset: "spring" } }), clock(OCT_26)),
      { kind: "preset", preset: "spring", source: "school" }, "a fixed default does not need the calendar");
    assert.equal(schoolThemeFor(appearance({ calendarStarts: { halloween: "2026-10-16" } }), clock(OCT_16))?.preset, "halloween", "an early start");
    assert.equal(schoolThemeFor(appearance({ calendarStarts: { halloween: "2026-10-17" } }), clock(OCT_16))?.preset, "fall");
    assert.equal(schoolThemeFor(appearance({ calendarLeadDays: 15 }), clock(OCT_16))?.preset, "halloween", "a longer lead");
    assert.equal(schoolThemeFor(appearance(), clock(DEC_20))?.preset, "winter", "no Christmas on the default calendar");
    assert.equal(schoolThemeFor(appearance(), clock(APR_1))?.preset, "spring", "no Easter on the default calendar");
    assert.equal(schoolThemeFor(appearance({ calendarHolidays: ["christmas"] }), clock(DEC_20))?.preset, "christmas");
    assert.equal(schoolThemeFor(appearance({ calendarHolidays: ["easter"] }), clock(APR_1))?.preset, "easter");
    assert.equal(schoolThemeFor(appearance({ calendarHolidays: [] }), clock(OCT_26))?.preset, "fall", "seasons only");
    assert.equal(schoolThemeFor(appearance(), { now: new Date("2026-10-21T03:00:00Z"), timeZone: "America/Los_Angeles" })?.preset, "fall",
      "Oct 20 evening on the west coast: the window has not opened there");
    assert.equal(concreteSchoolPreset(appearance(), { kind: "preset", preset: "advent", calendar: true }, clock(DEC_20)), "winter",
      "a fixed calendar default follows the school's own holiday list");
    assert.equal(concreteSchoolPreset(appearance(), { kind: "preset", preset: "advent" }, clock(DEC_20)), "advent");
  });

  it("describes the school theme for the student sign-in gate only while the gate and the launch flag are on", () => {
    process.env.CLASSPILOT_DASHBOARD_THEMES_ENABLED = "true";
    process.env.PUBLIC_BASE_URL = "https://school-pilot.net/";
    assert.deepEqual(signInGateThemeFor(null, clock(OCT_26)), { preset: "halloween", label: "Halloween", artwork: "https://school-pilot.net/themes/halloween.webp",
      mark: "halloween", brandFace: { family: "Creepster", weight: 400, url: "https://school-pilot.net/fonts/creepster-latin.woff2" } });
    assert.deepEqual(signInGateThemeFor({ schoolDefaultTheme: { kind: "preset", preset: "christmas" } }, clock(OCT_26)), { preset: "christmas", label: "Christmas",
      artwork: "https://school-pilot.net/themes/christmas.webp", mark: "christmas",
      brandFace: { family: "Mountains of Christmas", weight: 700, url: "https://school-pilot.net/fonts/mountains-of-christmas-700-latin.woff2" } });
    assert.deepEqual(signInGateThemeFor({ schoolDefaultTheme: { kind: "preset", preset: "valentines" } }, clock(OCT_26))?.brandFace,
      { family: "Pacifico", weight: 400, url: "https://school-pilot.net/fonts/pacifico-latin.woff2" });
    assert.deepEqual(signInGateThemeFor(null, clock(OCT_16)), { preset: "fall", label: "Fall", artwork: "https://school-pilot.net/themes/fall.webp", mark: "fall", brandFace: null });
    assert.equal(signInGateThemeFor({ schoolDefaultTheme: { kind: "preset", preset: "advent", calendar: true } }, clock(DEC_20))?.preset, "winter",
      "a calendar default is made concrete with the school's holidays");
    assert.equal(signInGateThemeFor({ signInGateTheme: false }, clock(OCT_26)), null);
    assert.equal(signInGateThemeFor({ autoCalendar: false }, clock(OCT_26)), null);
    assert.equal(signInGateThemeFor({ autoCalendar: false, lockToSchoolTheme: true }, clock(OCT_26)), null, "a lock with no school theme paints nothing");
    delete process.env.PUBLIC_BASE_URL;
    process.env.CLIENT_URL = "https://staging.example.test";
    assert.equal(signInGateThemeFor(null, clock(OCT_26))?.artwork, "https://staging.example.test/themes/halloween.webp", "CLIENT_URL is the second choice");
    delete process.env.CLIENT_URL;
    assert.equal(signInGateThemeFor(null, clock(OCT_26))?.artwork, "https://school-pilot.net/themes/halloween.webp", "production is the fallback");
    process.env.CLASSPILOT_DASHBOARD_THEMES_ENABLED = "false";
    assert.equal(signInGateThemeFor(null, clock(OCT_26)), null, "the launch flag");
    assert.equal(signInGateThemeFor({ schoolDefaultTheme: { kind: "preset", preset: "halloween" } }, clock(OCT_26)), null);
  });
});

describe("ClassPilot dashboard theme asset model", () => {
  it("fixes the upload limits, input types and the library size", () => {
    assert.equal(DASHBOARD_THEME_ASSET_MAX_BYTES, 6 * 1024 * 1024);
    assert.equal(DASHBOARD_THEME_ASSET_MAX_EDGE, 2560);
    assert.deepEqual([...DASHBOARD_THEME_ASSET_INPUT_TYPES], ["image/png", "image/jpeg", "image/webp"]);
    assert.equal(DASHBOARD_THEME_LIBRARY_LIMIT, 5);
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
