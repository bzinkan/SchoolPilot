import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_SCHOOL_APPEARANCE, type DashboardThemeAsset, type SchoolAppearance } from "../src/services/classpilotThemes.js";
import { kioskMayServeImage, resolveKioskTheme, type KioskTeacherThemeRow } from "../src/services/passpilotKioskThemeRules.js";

const NOW = new Date("2026-10-26T16:00:00Z"); // Oct 26 in New York: inside the ten-day Halloween window
const OCT_16 = new Date("2026-10-16T16:00:00Z"); // five days before the window opens
const DEC_10 = new Date("2026-12-10T16:00:00Z"); // Advent, before the Christmas window
const DEC_20 = new Date("2026-12-20T16:00:00Z"); // the Christmas window
const appearance = (overrides: Partial<SchoolAppearance> = {}): SchoolAppearance => ({ ...DEFAULT_SCHOOL_APPEARANCE, ...overrides });
const readyAsset = (id: string): DashboardThemeAsset => ({
  id, status: "ready", storageKey: `classpilot/themes/school/teacher/${id}`, contentType: "image/webp", byteSize: 1234, sha256: "a".repeat(64),
  width: 1600, height: 900, inputSha256: "b".repeat(64), inputContentType: "image/png", inputByteSize: 4321,
  leaseId: null, leaseUntil: null, createdAt: NOW.toISOString(), readyAt: NOW.toISOString(),
});
const teacher = (row: Partial<KioskTeacherThemeRow>): KioskTeacherThemeRow => ({ dashboardTheme: null, dashboardThemeAssets: [], ...row });
// A library of three: two ready images and one abandoned reservation.
const library = (): DashboardThemeAsset[] => [readyAsset("asset-0"), readyAsset("asset-1"), { ...readyAsset("asset-2"), status: "reserved", readyAt: null }];
const resolve = (inputs: Partial<Parameters<typeof resolveKioskTheme>[0]>) =>
  resolveKioskTheme({ appearance: appearance(), teacher: null, timeZone: "America/New_York", now: NOW, enabled: true, storeConfigured: true, ...inputs });

describe("PassPilot kiosk theme resolution", () => {
  it("shows nothing while the launch gate is off, whatever is stored", () => {
    assert.equal(resolve({ enabled: false, teacher: teacher({ dashboardTheme: { kind: "preset", preset: "halloween" } }),
      appearance: appearance({ schoolDefaultTheme: { kind: "preset", preset: "fall" } }) }), null);
  });

  it("follows the bound teacher's preset and resolves the teacher's own calendar in the school zone", () => {
    assert.deepEqual(resolve({ teacher: teacher({ dashboardTheme: { kind: "preset", preset: "christmas" } }) }), { kind: "preset", preset: "christmas" });
    assert.deepEqual(resolve({ teacher: teacher({ dashboardTheme: { kind: "preset", preset: "fall", calendar: true } }) }), { kind: "preset", preset: "halloween" });
    assert.deepEqual(resolve({ teacher: teacher({ dashboardTheme: { kind: "preset", preset: "fall", calendar: true } }), now: DEC_20 }),
      { kind: "preset", preset: "christmas" }, "a teacher's own calendar may show every holiday, whatever the school lists");
    assert.deepEqual(resolve({ teacher: teacher({ dashboardTheme: { kind: "preset", preset: "advent", calendar: true } }), now: DEC_10 }),
      { kind: "preset", preset: "advent" });
    assert.deepEqual(resolve({ teacher: teacher({ dashboardTheme: { kind: "preset", preset: "fall", calendar: true } }), now: DEC_10 }),
      { kind: "preset", preset: "winter" }, "Advent is only offered when the teacher asked for it");
    assert.deepEqual(resolve({ teacher: teacher({ dashboardTheme: { kind: "preset", preset: "fall", calendar: true } }), now: OCT_16,
      appearance: appearance({ calendarStarts: { halloween: "2026-10-16" } }) }), { kind: "preset", preset: "halloween" },
    "the school's early start applies to a teacher's own calendar too");
  });

  it("resolves the school calendar for kiosks with no teacher theme, with the school's holidays, lead time and starts", () => {
    assert.deepEqual(resolve({}), { kind: "preset", preset: "halloween" }, "the default calendar on Oct 26");
    assert.deepEqual(resolve({ now: OCT_16 }), { kind: "preset", preset: "fall" }, "five days before the window opens");
    assert.deepEqual(resolve({ now: OCT_16, appearance: appearance({ calendarLeadDays: 20 }) }), { kind: "preset", preset: "halloween" });
    assert.deepEqual(resolve({ now: OCT_16, appearance: appearance({ calendarStarts: { halloween: "2026-10-16" } }) }), { kind: "preset", preset: "halloween" }, "an early start");
    assert.deepEqual(resolve({ now: OCT_16, appearance: appearance({ calendarStarts: { halloween: "2026-10-17" } }) }), { kind: "preset", preset: "fall" }, "the day before an early start");
    assert.deepEqual(resolve({ now: DEC_20 }), { kind: "preset", preset: "winter" }, "no Christmas unless the school lists it");
    assert.deepEqual(resolve({ now: DEC_20, appearance: appearance({ calendarHolidays: ["christmas"] }) }), { kind: "preset", preset: "christmas" });
    assert.deepEqual(resolve({ now: DEC_10, appearance: appearance({ calendarHolidays: ["advent"] }) }), { kind: "preset", preset: "advent" });
    assert.deepEqual(resolve({ appearance: appearance({ calendarHolidays: [] }) }), { kind: "preset", preset: "fall" }, "seasons only");
    assert.equal(resolve({ appearance: appearance({ autoCalendar: false }) }), null, "no calendar and no default: the plain kiosk");
    assert.deepEqual(resolve({ appearance: appearance({ autoCalendar: false, schoolDefaultTheme: { kind: "preset", preset: "spring" } }) }), { kind: "preset", preset: "spring" });
    assert.deepEqual(resolve({ appearance: appearance({ schoolDefaultTheme: { kind: "preset", preset: "winter" } }) }), { kind: "preset", preset: "winter" },
      "a fixed default beats the calendar");
    assert.deepEqual(resolve({ now: DEC_20, appearance: appearance({ schoolDefaultTheme: { kind: "preset", preset: "advent", calendar: true } }) }),
      { kind: "preset", preset: "winter" }, "a fixed calendar default follows the school's own holiday list");
  });

  it("gives a teacher who chose plain a plain kiosk, unless the school lock is on", () => {
    const plain = teacher({ dashboardTheme: { kind: "none" } });
    assert.equal(resolve({ teacher: plain }), null, "not the school calendar");
    assert.equal(resolve({ teacher: plain, appearance: appearance({ schoolDefaultTheme: { kind: "preset", preset: "fall" } }) }), null, "not the school default");
    assert.deepEqual(resolve({ teacher: plain, appearance: appearance({ lockToSchoolTheme: true, schoolDefaultTheme: { kind: "preset", preset: "winter" } }) }),
      { kind: "preset", preset: "winter" });
    assert.deepEqual(resolve({ teacher: plain, appearance: appearance({ lockToSchoolTheme: true }) }), { kind: "preset", preset: "halloween" }, "a lock with the calendar");
    assert.deepEqual(resolve({ teacher: plain, appearance: appearance({ teacherThemesEnabled: false }) }), { kind: "preset", preset: "halloween" },
      "with teacher themes off the choice does not count");
    assert.equal(kioskMayServeImage(appearance({ teacherUploadsEnabled: true, kioskCustomBackgrounds: true }), plain, "asset-1"), false);
  });

  it("lets the teacher keep a theme off the kiosk and falls back to the school theme", () => {
    const own = teacher({ dashboardTheme: { kind: "preset", preset: "christmas", kiosk: false } });
    assert.deepEqual(resolve({ teacher: own }), { kind: "preset", preset: "halloween" }, "the school calendar");
    assert.equal(resolve({ teacher: own, appearance: appearance({ autoCalendar: false }) }), null);
    assert.deepEqual(resolve({ teacher: own, appearance: appearance({ schoolDefaultTheme: { kind: "preset", preset: "fall" } }) }), { kind: "preset", preset: "fall" });
  });

  it("applies the school lock and the school default to kiosks with and without a teacher", () => {
    const locked = appearance({ lockToSchoolTheme: true, schoolDefaultTheme: { kind: "preset", preset: "winter" } });
    assert.deepEqual(resolve({ appearance: locked, teacher: teacher({ dashboardTheme: { kind: "preset", preset: "halloween" } }) }), { kind: "preset", preset: "winter" });
    assert.deepEqual(resolve({ appearance: appearance({ schoolDefaultTheme: { kind: "preset", preset: "spring" } }) }), { kind: "preset", preset: "spring" });
    assert.equal(resolve({ appearance: appearance({ lockToSchoolTheme: true, autoCalendar: false }) }), null, "a lock with no school theme means the plain kiosk");
    assert.deepEqual(resolve({ appearance: appearance({ teacherThemesEnabled: false, autoCalendar: false }), teacher: teacher({ dashboardTheme: { kind: "preset", preset: "halloween" } }) }), null);
  });

  it("serves image bytes to a kiosk only for the bound teacher's chosen, ready, kiosk-enabled image, from anywhere in the library", () => {
    const allowed = appearance({ teacherUploadsEnabled: true, kioskCustomBackgrounds: true });
    const image = teacher({ dashboardTheme: { kind: "image", imageAssetId: "asset-1" }, dashboardThemeAssets: library() });
    assert.equal(kioskMayServeImage(allowed, image, "asset-1"), true);
    assert.equal(kioskMayServeImage(allowed, teacher({ dashboardTheme: { kind: "image", imageAssetId: "asset-0" }, dashboardThemeAssets: library() }), "asset-0"), true, "any ready library entry can be the chosen one");
    assert.equal(kioskMayServeImage(allowed, image, "asset-0"), false, "a ready library image that is not the chosen theme");
    assert.equal(kioskMayServeImage(allowed, teacher({ dashboardTheme: { kind: "image", imageAssetId: "asset-2" }, dashboardThemeAssets: library() }), "asset-2"), false, "chosen but not ready");
    assert.equal(kioskMayServeImage(allowed, image, "asset-9"), false, "another id, even for the same teacher");
    assert.equal(kioskMayServeImage(appearance({ teacherUploadsEnabled: true }), image, "asset-1"), false, "kiosk custom backgrounds off");
    assert.equal(kioskMayServeImage(appearance({ kioskCustomBackgrounds: true }), image, "asset-1"), false, "uploads off");
    assert.equal(kioskMayServeImage({ ...allowed, lockToSchoolTheme: true }, image, "asset-1"), false, "locked school");
    assert.equal(kioskMayServeImage(allowed, teacher({ dashboardTheme: { kind: "image", imageAssetId: "asset-1", kiosk: false }, dashboardThemeAssets: library() }), "asset-1"), false, "teacher keeps it off the kiosk");
    assert.equal(kioskMayServeImage(allowed, teacher({ dashboardTheme: { kind: "preset", preset: "fall" }, dashboardThemeAssets: library() }), "asset-1"), false, "an image that is not the active theme");
    assert.equal(kioskMayServeImage(allowed, teacher({ dashboardTheme: { kind: "image", imageAssetId: "asset-1" } }), "asset-1"), false, "an empty library");
    assert.equal(kioskMayServeImage(allowed, null, "asset-1"), false);
  });

  it("shows an uploaded image, with its fit, only when the school allows it on kiosks and the bytes are ready", () => {
    const image = teacher({ dashboardTheme: { kind: "image", imageAssetId: "asset-1" }, dashboardThemeAssets: library() });
    const allowed = appearance({ teacherUploadsEnabled: true, kioskCustomBackgrounds: true, schoolDefaultTheme: { kind: "preset", preset: "fall" } });
    assert.deepEqual(resolve({ teacher: image, appearance: allowed }), { kind: "image", imageAssetId: "asset-1", fit: "cover" }, "an absent fit reads as cover");
    for (const fit of ["cover", "contain", "tile"] as const) {
      assert.deepEqual(resolve({ teacher: teacher({ dashboardTheme: { kind: "image", imageAssetId: "asset-0", fit, name: "Who Dey" }, dashboardThemeAssets: library() }), appearance: allowed }),
        { kind: "image", imageAssetId: "asset-0", fit }, fit);
    }
    assert.deepEqual(resolve({ teacher: image, appearance: appearance({ teacherUploadsEnabled: true, schoolDefaultTheme: { kind: "preset", preset: "fall" } }) }),
      { kind: "preset", preset: "fall" }, "kioskCustomBackgrounds off: the school default, not the picture");
    assert.deepEqual(resolve({ teacher: image, appearance: appearance({ kioskCustomBackgrounds: true, schoolDefaultTheme: { kind: "preset", preset: "fall" } }) }),
      { kind: "preset", preset: "fall" }, "uploads off: the school default");
    assert.equal(resolve({ teacher: image, appearance: allowed, storeConfigured: false })?.kind, "preset", "no object store: never promise bytes");
    assert.deepEqual(resolve({ teacher: teacher({ dashboardTheme: { kind: "image", imageAssetId: "asset-9" }, dashboardThemeAssets: library() }), appearance: allowed }),
      { kind: "preset", preset: "fall" }, "an id that is not in the library is not served");
    assert.deepEqual(resolve({ teacher: teacher({ dashboardTheme: { kind: "image", imageAssetId: "asset-2", fit: "tile" }, dashboardThemeAssets: library() }), appearance: allowed }),
      { kind: "preset", preset: "fall" }, "a reservation has no bytes");
    assert.deepEqual(resolve({ teacher: teacher({ dashboardTheme: { kind: "image", imageAssetId: "asset-1" } }), appearance: allowed }), { kind: "preset", preset: "fall" }, "an empty library");
  });
});
