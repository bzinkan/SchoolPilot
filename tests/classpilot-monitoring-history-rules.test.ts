import assert from "node:assert/strict";
import test from "node:test";
import { decodeMonitoringHistoryCursor, encodeMonitoringHistoryCursor, monitoringHistoryScope, MONITORING_HISTORY_PAGE_SIZE } from "../src/services/classpilotMonitoringHistoryRules.js";

const now = new Date("2026-09-08T15:00:00.000Z");
const scope = monitoringHistoryScope("school", "teacher", false);
const value = { scope, filter: "recent" as const, asOf: now.toISOString(), detectedAt: "2026-09-08T14:00:00.123Z", id: "event-id" };
test("history cursors preserve the fixed window and ordering without student identifiers", () => {
  const cursor = encodeMonitoringHistoryCursor(value);
  assert.equal(MONITORING_HISTORY_PAGE_SIZE, 50);
  assert.deepEqual(decodeMonitoringHistoryCursor(cursor, scope, "recent", now), { version: 1, ...value });
  assert.equal(decodeMonitoringHistoryCursor(undefined, scope, "recent", now), null);
  assert.doesNotMatch(Buffer.from(cursor, "base64url").toString(), /student|device|teacher|school/);
});
test("history rejects malformed, expired, cross-actor/school/role and cross-filter cursors", () => {
  const cursor = encodeMonitoringHistoryCursor(value);
  for (const otherScope of [monitoringHistoryScope("other", "teacher", false), monitoringHistoryScope("school", "other", false), monitoringHistoryScope("school", "teacher", true)]) {
    assert.throws(() => decodeMonitoringHistoryCursor(cursor, otherScope, "recent", now), /invalid or expired/);
  }
  assert.throws(() => decodeMonitoringHistoryCursor(cursor, scope, "open", now), /invalid or expired/);
  for (const bad of ["!", "a".repeat(1025), encodeMonitoringHistoryCursor({ ...value, detectedAt: "2026-02-30T14:00:00.000Z" }), encodeMonitoringHistoryCursor({ ...value, asOf: "2026-09-08T15:01:00.000Z" })]) {
    assert.throws(() => decodeMonitoringHistoryCursor(bad, scope, "recent", now), /invalid or expired/);
  }
  assert.throws(() => decodeMonitoringHistoryCursor(cursor, scope, "recent", new Date(now.getTime() + 900001)), /invalid or expired/);
});
