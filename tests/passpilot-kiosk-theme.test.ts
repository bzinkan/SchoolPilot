import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_SCHOOL_APPEARANCE, type DashboardThemeAsset, type SchoolAppearance } from "../src/services/classpilotThemes.js";
import { kioskMayServeImage, resolveKioskTheme, type KioskTeacherThemeRow } from "../src/services/passpilotKioskThemeRules.js";

const NOW = new Date("2026-10-16T16:00:00Z"); // Oct 16 in New York: Halloween window
const appearance = (overrides: Partial<SchoolAppearance> = {}): SchoolAppearance => ({ ...DEFAULT_SCHOOL_APPEARANCE, ...overrides });
const readyAsset = (id: string): DashboardThemeAsset => ({
  id, status: "ready", storageKey: `classpilot/themes/school/teacher/${id}`, contentType: "image/webp", byteSize: 1234, sha256: "a".repeat(64),
  width: 1600, height: 900, inputSha256: "b".repeat(64), inputContentType: "image/png", inputByteSize: 4321,
  leaseId: null, leaseUntil: null, createdAt: NOW.toISOString(), readyAt: NOW.toISOString(),
});
const teacher = (row: Partial<KioskTeacherThemeRow>): KioskTeacherThemeRow => ({ dashboardTheme: null, dashboardThemeAsset: null, ...row });
const resolve = (inputs: Partial<Parameters<typeof resolveKioskTheme>[0]>) =>
  resolveKioskTheme({ appearance: appearance(), teacher: null, timeZone: "America/New_York", now: NOW, enabled: true, storeConfigured: true, ...inputs });

describe("PassPilot kiosk theme resolution", () => {
  it("shows nothing while the launch gate is off, whatever is stored", () => {
    assert.equal(resolve({ enabled: false, teacher: teacher({ dashboardTheme: { kind: "preset", preset: "halloween" } }),
      appearance: appearance({ schoolDefaultTheme: { kind: "preset", preset: "fall" } }) }), null);
  });

  it("follows the bound teacher's preset and resolves calendar mode in the school zone", () => {
    assert.deepEqual(resolve({ teacher: teacher({ dashboardTheme: { kind: "preset", preset: "christmas" } }) }), { kind: "preset", preset: "christmas" });
    assert.deepEqual(resolve({ teacher: teacher({ dashboardTheme: { kind: "preset", preset: "fall", calendar: true } }) }), { kind: "preset", preset: "halloween" });
    assert.deepEqual(resolve({ teacher: teacher({ dashboardTheme: { kind: "preset", preset: "advent", calendar: true } }), now: new Date("2026-12-10T16:00:00Z") }),
      { kind: "preset", preset: "advent" });
    assert.deepEqual(resolve({ teacher: teacher({ dashboardTheme: { kind: "preset", preset: "fall", calendar: true } }), now: new Date("2026-12-10T16:00:00Z") }),
      { kind: "preset", preset: "christmas" }, "Advent is only offered when the teacher asked for it");
  });

  it("lets the teacher keep a theme off the kiosk and falls back to the school default", () => {
    const own = teacher({ dashboardTheme: { kind: "preset", preset: "halloween", kiosk: false } });
    assert.equal(resolve({ teacher: own }), null);
    assert.deepEqual(resolve({ teacher: own, appearance: appearance({ schoolDefaultTheme: { kind: "preset", preset: "fall" } }) }), { kind: "preset", preset: "fall" });
  });

  it("applies the school lock and the school default to kiosks with and without a teacher", () => {
    const locked = appearance({ lockToSchoolTheme: true, schoolDefaultTheme: { kind: "preset", preset: "winter" } });
    assert.deepEqual(resolve({ appearance: locked, teacher: teacher({ dashboardTheme: { kind: "preset", preset: "halloween" } }) }), { kind: "preset", preset: "winter" });
    assert.deepEqual(resolve({ appearance: appearance({ schoolDefaultTheme: { kind: "preset", preset: "spring" } }) }), { kind: "preset", preset: "spring" });
    assert.equal(resolve({ appearance: appearance({ lockToSchoolTheme: true }) }), null, "a lock with no school theme means the plain kiosk");
    assert.equal(resolve({ appearance: appearance({ teacherThemesEnabled: false }), teacher: teacher({ dashboardTheme: { kind: "preset", preset: "halloween" } }) }), null);
  });

  it("serves image bytes to a kiosk only for the bound teacher's current, ready, kiosk-enabled image", () => {
    const allowed = appearance({ teacherUploadsEnabled: true, kioskCustomBackgrounds: true });
    const image = teacher({ dashboardTheme: { kind: "image", imageAssetId: "asset-1" }, dashboardThemeAsset: readyAsset("asset-1") });
    assert.equal(kioskMayServeImage(allowed, image, "asset-1"), true);
    assert.equal(kioskMayServeImage(allowed, image, "asset-9"), false, "another id, even for the same teacher");
    assert.equal(kioskMayServeImage(appearance({ teacherUploadsEnabled: true }), image, "asset-1"), false, "kiosk custom backgrounds off");
    assert.equal(kioskMayServeImage(appearance({ kioskCustomBackgrounds: true }), image, "asset-1"), false, "uploads off");
    assert.equal(kioskMayServeImage({ ...allowed, lockToSchoolTheme: true }, image, "asset-1"), false, "locked school");
    assert.equal(kioskMayServeImage(allowed, teacher({ dashboardTheme: { kind: "image", imageAssetId: "asset-1", kiosk: false }, dashboardThemeAsset: readyAsset("asset-1") }), "asset-1"), false, "teacher keeps it off the kiosk");
    assert.equal(kioskMayServeImage(allowed, teacher({ dashboardTheme: { kind: "preset", preset: "fall" }, dashboardThemeAsset: readyAsset("asset-1") }), "asset-1"), false, "an image that is not the active theme");
    assert.equal(kioskMayServeImage(allowed, null, "asset-1"), false);
  });

  it("shows an uploaded image only when the school allows it on kiosks and the bytes are ready", () => {
    const image = teacher({ dashboardTheme: { kind: "image", imageAssetId: "asset-1" }, dashboardThemeAsset: readyAsset("asset-1") });
    const allowed = appearance({ teacherUploadsEnabled: true, kioskCustomBackgrounds: true, schoolDefaultTheme: { kind: "preset", preset: "fall" } });
    assert.deepEqual(resolve({ teacher: image, appearance: allowed }), { kind: "image", imageAssetId: "asset-1" });
    assert.deepEqual(resolve({ teacher: image, appearance: appearance({ teacherUploadsEnabled: true, schoolDefaultTheme: { kind: "preset", preset: "fall" } }) }),
      { kind: "preset", preset: "fall" }, "kioskCustomBackgrounds off: the school default, not the picture");
    assert.deepEqual(resolve({ teacher: image, appearance: appearance({ kioskCustomBackgrounds: true, schoolDefaultTheme: { kind: "preset", preset: "fall" } }) }),
      { kind: "preset", preset: "fall" }, "uploads off: the school default");
    assert.equal(resolve({ teacher: image, appearance: allowed, storeConfigured: false })?.kind, "preset", "no object store: never promise bytes");
    assert.deepEqual(resolve({ teacher: teacher({ dashboardTheme: { kind: "image", imageAssetId: "asset-1" }, dashboardThemeAsset: readyAsset("asset-2") }), appearance: allowed }),
      { kind: "preset", preset: "fall" }, "a stale asset id is not served");
    assert.deepEqual(resolve({ teacher: teacher({ dashboardTheme: { kind: "image", imageAssetId: "asset-1" } }), appearance: allowed }), { kind: "preset", preset: "fall" });
  });
});
