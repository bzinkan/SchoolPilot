import { test } from "node:test";
import assert from "node:assert/strict";
import { CONTENT_CATEGORIES, normalizeContentCategory, reviewedContentCategoryForDomain, allocateOffTaskCategorySeconds } from "../src/services/classpilotContentCategories.js";
import { calculateHeartbeatCoverage } from "../src/services/classpilotHeartbeatCoverage.js";
import { classpilotSessionReportVersionForNewRow } from "../src/config/classpilotSessionReportRollout.js";

test("the finite category vocabulary is exact; ambiguous domains and lookalikes remain unlabeled", () => {
  assert.equal(CONTENT_CATEGORIES.length, 20);
  assert.equal(new Set(CONTENT_CATEGORIES).size, 20);
  assert.equal(normalizeContentCategory("gaming"), null);
  assert.equal(reviewedContentCategoryForDomain("www.roblox.com"), "Gaming");
  assert.equal(reviewedContentCategoryForDomain("roblox.com.evil.example"), null);
  assert.equal(reviewedContentCategoryForDomain("google.com"), null);
  assert.equal(reviewedContentCategoryForDomain("yahoo.com"), null);
  assert.equal(reviewedContentCategoryForDomain("finance.yahoo.com"), "Finance");
});
test("fractional attribution reconciles every second, including the unlabeled bucket", () => {
  const rows = allocateOffTaskCategorySeconds([
    { contentCategory: "Gaming", milliseconds: 700 }, { contentCategory: "Video", milliseconds: 700 },
    { contentCategory: null, milliseconds: 700 },
  ], 2);
  assert.equal(rows.reduce((sum, row) => sum + row.seconds, 0), 2);
  assert.equal(rows.length, 2);
});
test("v3 categories count only observed off-task segments; teacher intent and unknown task status remain excluded", () => {
  const start = new Date("2026-09-05T12:00:00Z");
  const at = (seconds: number) => new Date(start.getTime() + seconds * 1000);
  const result = calculateHeartbeatCoverage({ windowStart: start, windowEnd: at(60), contentCategories: true,
    authenticatedIntervals: [{ start, end: at(60) }], heartbeats: [
      { timestamp: at(0), url: "https://roblox.com", category: "non-educational", contentCategory: "Gaming" },
      { timestamp: at(15), url: "https://youtube.com", category: "non-educational", contentCategory: "Video", teacherIntentExempt: true },
      { timestamp: at(30), url: "https://mixed.example", category: "unknown", contentCategory: null },
      { timestamp: at(45), url: "https://other.example", category: "non-educational", contentCategory: null },
    ] });
  assert.equal(result.offTaskSeconds, 30);
  assert.deepEqual(result.offTaskCategories, [{ contentCategory: "Gaming", seconds: 15 }, { contentCategory: null, seconds: 15 }]);
  assert.equal(result.offTaskCategories.reduce((sum, row) => sum + row.seconds, 0), result.offTaskSeconds);
  assert.equal(result.topDomains.find((row) => row.domain === "youtube.com")?.contentCategory, "Video");
});
test("new report v3 is explicitly gated; existing v1/v2 rollout meanings are unchanged", () => {
  assert.equal(classpilotSessionReportVersionForNewRow("on", "on"), 3);
  assert.equal(classpilotSessionReportVersionForNewRow("on", "off"), 2);
  assert.equal(classpilotSessionReportVersionForNewRow("legacy", "on"), 1);
});
