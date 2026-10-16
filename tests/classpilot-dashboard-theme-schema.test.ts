import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { afterEach, describe, it } from "node:test";
import { DASHBOARD_THEME_PRESET_IDS, dashboardThemeSchema, dashboardThemesEnabled } from "../src/services/classpilotThemes.js";

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
