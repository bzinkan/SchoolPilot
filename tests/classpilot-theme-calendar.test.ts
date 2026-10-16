import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { DASHBOARD_THEME_PRESET_IDS } from "../src/services/classpilotThemes.js";
import { adventStart, calendarPresetFor, easterSunday, localDateParts, thanksgivingDay } from "../src/services/classpilotThemeCalendar.js";

// The kiosk receives a concrete preset, so the server resolves calendar mode
// exactly as the teacher's browser does. These cases mirror
// schoolpilot-app/scripts/dashboard-theme-calendar.test.mjs.
describe("ClassPilot theme calendar (server port)", () => {
  it("lands Easter, Thanksgiving and Advent on known dates", () => {
    assert.deepEqual(easterSunday(2024), { month: 3, day: 31 });
    assert.deepEqual(easterSunday(2025), { month: 4, day: 20 });
    assert.deepEqual(easterSunday(2026), { month: 4, day: 5 });
    assert.deepEqual(easterSunday(2027), { month: 3, day: 28 });
    assert.deepEqual(thanksgivingDay(2024), { month: 11, day: 28 });
    assert.deepEqual(thanksgivingDay(2025), { month: 11, day: 27 });
    assert.deepEqual(thanksgivingDay(2026), { month: 11, day: 26 });
    assert.deepEqual(adventStart(2024), { month: 12, day: 1 });
    assert.deepEqual(adventStart(2025), { month: 11, day: 30 });
    assert.deepEqual(adventStart(2026), { month: 11, day: 29 });
  });

  it("resolves every day of a leap year to exactly one shipped preset", () => {
    const ids = new Set<string>(DASHBOARD_THEME_PRESET_IDS);
    for (const liturgical of [false, true]) {
      for (let day = 0; day < 366; day += 1) {
        const date = new Date(Date.UTC(2024, 0, 1 + day));
        const today = { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
        const preset = calendarPresetFor(today, { liturgical });
        assert.ok(ids.has(preset), `${JSON.stringify(today)} -> ${preset}`);
        if (!liturgical) assert.notEqual(preset, "advent");
      }
    }
  });

  it("agrees with the browser copy on holidays and seasons", () => {
    assert.equal(calendarPresetFor({ year: 2026, month: 10, day: 16 }), "halloween");
    assert.equal(calendarPresetFor({ year: 2026, month: 10, day: 2 }), "fall");
    assert.equal(calendarPresetFor({ year: 2026, month: 11, day: 20 }), "thanksgiving");
    assert.equal(calendarPresetFor({ year: 2026, month: 11, day: 27 }), "fall");
    assert.equal(calendarPresetFor({ year: 2026, month: 12, day: 10 }), "christmas");
    assert.equal(calendarPresetFor({ year: 2026, month: 12, day: 10 }, { liturgical: true }), "advent");
    assert.equal(calendarPresetFor({ year: 2026, month: 12, day: 25 }, { liturgical: true }), "christmas");
    assert.equal(calendarPresetFor({ year: 2026, month: 2, day: 14 }), "valentines");
    assert.equal(calendarPresetFor({ year: 2026, month: 3, day: 17 }), "st-patricks");
    assert.equal(calendarPresetFor({ year: 2026, month: 4, day: 5 }), "easter");
    assert.equal(calendarPresetFor({ year: 2026, month: 3, day: 24 }), "easter");
    assert.equal(calendarPresetFor({ year: 2026, month: 5, day: 10 }), "spring");
    assert.equal(calendarPresetFor({ year: 2026, month: 7, day: 4 }), "summer");
    assert.equal(calendarPresetFor({ year: 2026, month: 1, day: 20 }), "winter");
  });

  it("reads local date parts in the school time zone and survives an unknown zone", () => {
    const lateEvening = new Date("2026-10-17T02:30:00Z");
    assert.deepEqual(localDateParts(lateEvening, "America/New_York"), { year: 2026, month: 10, day: 16 });
    assert.deepEqual(localDateParts(lateEvening, "UTC"), { year: 2026, month: 10, day: 17 });
    assert.deepEqual(localDateParts(lateEvening, "Not/AZone"), { year: 2026, month: 10, day: 16 });
  });

  it("keeps the holiday windows identical to the browser source", () => {
    // Both files carry the same window table; a drift in either shows up here.
    const browser = readFileSync(new URL("../schoolpilot-app/src/shared/themes/calendar.js", import.meta.url), "utf8");
    const server = readFileSync(new URL("../src/services/classpilotThemeCalendar.ts", import.meta.url), "utf8");
    const windows = (source: string) => [...source.matchAll(/within\(\{ month: (\d+), day: (\d+) \}, \{ month: (\d+), day: (\d+) \}\)\) return ['"]([a-z-]+)['"]/g)]
      .map(match => match.slice(1).join(":"));
    assert.deepEqual(windows(server), windows(browser));
    assert.ok(windows(server).length >= 4);
  });
});
