import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (path: string) => readFileSync(
  new URL(`../${path}`, import.meta.url),
  "utf8"
);

describe("ClassPilot student tile batch contract", () => {
  it("uses one reusable set-based authorization statement without correlated predicates", () => {
    const storage = read("src/services/storage.ts");
    const start = storage.indexOf(
      "export function buildClassPilotTileAuthorizationQuery("
    );
    const end = storage.indexOf("function tileDeviceFromRow", start);
    assert.ok(start >= 0 && end > start);
    const query = storage.slice(start, end);

    for (const cte of [
      "requested_students",
      "active_supervision",
      "active_staff_groups",
      "active_roster_students",
      "authorized_students",
      "resolved_students",
    ]) {
      assert.match(query, new RegExp(`${cte}(?:\\([^)]*\\))? AS MATERIALIZED`));
    }
    assert.doesNotMatch(query, /\bNOT\s+EXISTS\b|\bEXISTS\s*\(/i);
    assert.match(query, /row_number\(\) OVER/i);
    assert.match(query, /session\.school_id = \$\{options\.schoolId\}/);
    assert.match(query, /co_teacher\.teacher_id = \$\{options\.staffId\}/);
  });

  it("keeps the batch routes student-addressed, no-store, and bounded", () => {
    const routes = read("src/routes/classpilot/devices.ts");
    assert.match(routes, /router\.post\("\/tiles\/screenshots", \.\.\.tileReadAuth/);
    assert.match(routes, /router\.post\("\/tiles\/history", \.\.\.tileReadAuth/);
    assert.match(routes, /raw\.length < 1 \|\| raw\.length > 50/);
    assert.match(routes, /limit > 10/);
    assert.equal(
      (routes.match(/setClassPilotNoStore\(res\);/g) ?? []).length >= 2,
      true
    );
    assert.match(routes, /getBatchTileAccessForStaff\(scope, parsed\.studentIds, "live"\)/);
    assert.match(routes, /getBatchTileAccessForStaff\(scope, parsed\.studentIds, "history"\)/);
    assert.match(routes, /error: "No accessible tiles"/);
    assert.match(routes, /heartbeats: heartbeats\.map\(safeTileHeartbeat\)/);
  });

  it("uses one Redis batch read and at most one SQL fallback per history cohort", () => {
    const screenshots = read("src/realtime/ws-redis.ts");
    const historyCache = read("src/services/heartbeatTileCache.ts");
    const routes = read("src/routes/classpilot/devices.ts");
    const screenshotStart = routes.indexOf(
      'router.post("/tiles/screenshots"'
    );
    const historyStart = routes.indexOf(
      'router.post("/tiles/history"'
    );
    const screenshotRoute = routes.slice(screenshotStart, historyStart);
    const historyEnd = routes.indexOf(
      "// GET /api/classpilot/device/screenshot/:deviceId",
      historyStart
    );
    const historyRoute = routes.slice(historyStart, historyEnd);

    assert.match(screenshots, /"MGET",[\s\S]*SCREENSHOT_KEY_PREFIX/);
    assert.match(historyCache, /const BATCH_READ_SCRIPT = `[\s\S]*LRANGE/);
    assert.equal(
      (screenshotRoute.match(/getBatchTileAccessForStaff\(/g) ?? []).length,
      1
    );
    assert.equal(
      (screenshotRoute.match(/getScreenshots\(/g) ?? []).length,
      1
    );
    assert.doesNotMatch(screenshotRoute, /getScreenshot\(/);
    assert.equal(
      (historyRoute.match(/getBatchTileAccessForStaff\(/g) ?? []).length,
      1
    );
    assert.equal(
      (historyRoute.match(/readHeartbeatTileCacheBatch\(/g) ?? []).length,
      1
    );
    assert.equal(
      (historyRoute.match(/getHeartbeatTileHistoryBatch\(/g) ?? []).length,
      1
    );
    assert.ok(
      historyRoute.indexOf("getHeartbeatTileHistoryBatch(") <
        historyRoute.indexOf("releaseClassPilotTileAdmission(res)",
          historyRoute.indexOf("getHeartbeatTileHistoryBatch("))
    );
  });

  it("fails startup migration on missing or mismatched teaching-session schools", () => {
    const index = read("src/index.ts");
    assert.doesNotMatch(
      index,
      /UPDATE teaching_sessions ts SET school_id = g\.school_id/
    );
    assert.match(index, /schedulerPool\.query\(`[\s\S]*session\.school_id IS NULL/);
    assert.match(index, /session\.school_id IS DISTINCT FROM class_group\.school_id/);
    assert.match(index, /teaching_sessions\.school_id integrity check failed/);
  });

  it("labels admission 503 responses for certification accounting", () => {
    const admission = read("src/middleware/classpilotTileAdmission.ts");
    assert.match(
      admission,
      /status\(503\)\.json\(\{[\s\S]*code: error\.code/
    );
    assert.match(admission, /"admission_timeout"/);
    assert.match(admission, /"admission_queue_full"/);
  });
});
