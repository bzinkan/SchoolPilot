import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (path: string) => readFileSync(
  new URL(`../${path}`, import.meta.url),
  "utf8"
);

describe("ClassPilot tile screenshot store degrade", () => {
  it("degrades per tile instead of failing the cohort when the screenshot store is unavailable", () => {
    const routes = read("src/routes/classpilot/devices.ts");
    const start = routes.indexOf('router.post("/tiles/screenshots"');
    const end = routes.indexOf('router.post("/tiles/history"');
    assert.ok(start >= 0 && end > start);
    const route = routes.slice(start, end);

    assert.doesNotMatch(route, /status\(503\)/);
    assert.doesNotMatch(route, /SCREENSHOT_STORE_UNAVAILABLE/);
    assert.match(route, /screenshotStore: "unavailable"/);
    assert.match(route, /recordHeartbeatHotPathCounter\("tileBatchScreenshotStoreUnavailable"\)/);
    assert.equal((route.match(/getScreenshots\(/g) ?? []).length, 1);
    assert.equal((route.match(/getClassBoundScreenshots\(/g) ?? []).length, 1);

    // Screenshot maps are built only from successful reads; unavailable reads
    // contribute nothing so affected tiles resolve to a null screenshot.
    assert.match(route, /classScreenshotRead\.status === "ok"\s*\?\s*classBindings\.map\(/);
    assert.match(route, /legacyScreenshotRead\.status === "ok"\s*\?\s*legacyBindings\.map\(/);

    const guard = route.indexOf("if (!screenshotStoreUnavailable)");
    const miss = route.indexOf('"tileBatchScreenshotMissItems"');
    const fallback = route.indexOf('"tileBatchScreenshotFallbackItems"');
    assert.ok(guard >= 0);
    assert.ok(miss > guard);
    assert.ok(fallback > guard);
    assert.ok(route.indexOf('recordHeartbeatHotPathCounter("tileBatchScreenshotStoreUnavailable")') < guard);
    assert.match(route, /res\.json\(\{\s*tiles,\s*\.\.\.\(screenshotStoreUnavailable \? \{ screenshotStore: "unavailable" \} : \{\}\),\s*\}\)/);
  });

  it("the dashboard turns the degrade marker back into the transient error path on both fetch paths", () => {
    const polling = read("schoolpilot-app/src/products/classpilot/lib/tileBatchPolling.js");
    assert.match(polling, /export function assertTileScreenshotStoreAvailable\(response\)/);
    assert.match(polling, /response\?\.screenshotStore !== 'unavailable'/);
    assert.match(polling, /response: \{ status: 503, data: response \}/);
    assert.match(polling, /normalizeTileScreenshotBindings\(assertTileScreenshotStoreAvailable\(response\)\)/);

    const dashboard = read("schoolpilot-app/src/products/classpilot/pages/Dashboard.jsx");
    assert.match(dashboard, /^\s+assertTileScreenshotStoreAvailable,$/m);
    const targeted = dashboard.indexOf("await apiRequest('POST', '/classpilot/tiles/screenshots'");
    assert.ok(targeted >= 0);
    const guard = dashboard.indexOf("assertTileScreenshotStoreAvailable(response);", targeted);
    const merge = dashboard.indexOf("mergeTargetedTileScreenshotResponse(", targeted);
    assert.ok(guard > targeted && merge > guard, "the targeted path must reject the degrade marker before merging into React Query");
  });

  it("keeps the admission-middleware 503 as the only cohort-level rejection", () => {
    const admission = read("src/middleware/classpilotTileAdmission.ts");
    assert.match(admission, /status\(503\)\.json\(\{[\s\S]*code: error\.code/);
  });
});
