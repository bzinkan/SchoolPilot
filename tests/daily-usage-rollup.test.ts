import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  DAILY_USAGE_ROLLUP_MARKER_TTL_SECONDS,
  DailyUsageRollupMarkers,
  dailyUsageRollupWindow,
  zonedDayStartUtc,
} from "../src/util/dailyUsageRollup.ts";
import {
  CLASSPILOT_DAILY_USAGE_UPSERT_SQL,
  dailyUsageAggregatesEqual,
} from "../src/services/classpilotDailyUsageRollup.ts";

describe("daily usage rollup scheduling", () => {
  it("waits until 02:00 in the school's local timezone", () => {
    assert.equal(
      dailyUsageRollupWindow(new Date("2026-07-11T05:59:59Z"), "America/New_York"),
      null
    );

    const window = dailyUsageRollupWindow(
      new Date("2026-07-11T06:00:00Z"),
      "America/New_York"
    );
    assert.equal(window?.date, "2026-07-10");
    assert.equal(window?.dayStartUtc.toISOString(), "2026-07-10T04:00:00.000Z");
    assert.equal(window?.dayEndUtc.toISOString(), "2026-07-11T04:00:00.000Z");
  });

  it("returns precise half-open UTC bounds across DST changes", () => {
    const spring = dailyUsageRollupWindow(
      new Date("2026-03-09T06:00:00Z"),
      "America/New_York"
    );
    assert.equal(spring?.date, "2026-03-08");
    assert.equal(spring?.dayStartUtc.toISOString(), "2026-03-08T05:00:00.000Z");
    assert.equal(spring?.dayEndUtc.toISOString(), "2026-03-09T04:00:00.000Z");
    assert.equal(
      spring && spring.dayEndUtc.getTime() - spring.dayStartUtc.getTime(),
      23 * 60 * 60 * 1000
    );

    const fall = dailyUsageRollupWindow(
      new Date("2026-11-02T07:00:00Z"),
      "America/New_York"
    );
    assert.equal(fall?.date, "2026-11-01");
    assert.equal(fall?.dayStartUtc.toISOString(), "2026-11-01T04:00:00.000Z");
    assert.equal(fall?.dayEndUtc.toISOString(), "2026-11-02T05:00:00.000Z");
    assert.equal(
      fall && fall.dayEndUtc.getTime() - fall.dayStartUtc.getTime(),
      25 * 60 * 60 * 1000
    );
  });

  it("does not depend on the host process timezone", () => {
    assert.equal(
      zonedDayStartUtc("2026-07-10", "America/Los_Angeles").toISOString(),
      "2026-07-10T07:00:00.000Z"
    );
    assert.equal(
      zonedDayStartUtc("2026-07-10", "UTC").toISOString(),
      "2026-07-10T00:00:00.000Z"
    );
  });

  it("keeps a 72-hour idempotency marker when Redis is not configured", async () => {
    const markers = new DailyUsageRollupMarkers("", "test-prefix");
    const start = 1_000;

    assert.equal(await markers.isComplete("school/one", "2026-07-10", start), false);
    await markers.markComplete("school/one", "2026-07-10", start);
    assert.equal(await markers.isComplete("school/one", "2026-07-10", start + 1), true);
    assert.equal(
      await markers.isComplete(
        "school/one",
        "2026-07-10",
        start + DAILY_USAGE_ROLLUP_MARKER_TTL_SECONDS * 1000
      ),
      false
    );
    assert.equal(
      markers.key("school/one", "2026-07-10"),
      "test-prefix:scheduler:daily-usage:school_one:2026-07-10"
    );
  });

  it("keeps heartbeat filters as raw half-open timestamp comparisons", () => {
    const source = readFileSync(new URL("../src/services/scheduler.ts", import.meta.url), "utf8");
    const start = source.indexOf("async function rollupSchoolUsage");
    const end = source.indexOf("// ClassPilot - Parent transparency digest", start);
    const rollupSource = source.slice(start, end);

    assert.match(rollupSource, /gte\(heartbeats\.timestamp, window\.dayStartUtc\)/);
    assert.match(rollupSource, /lt\(heartbeats\.timestamp, window\.dayEndUtc\)/);
    assert.doesNotMatch(rollupSource, /heartbeats\.timestamp[^\n]*AT TIME ZONE/);
  });

  it("uses one set-based upsert with ranked top domains", () => {
    assert.match(CLASSPILOT_DAILY_USAGE_UPSERT_SQL, /ROW_NUMBER\(\) OVER/i);
    assert.match(CLASSPILOT_DAILY_USAGE_UPSERT_SQL, /INSERT INTO daily_usage/i);
    assert.match(CLASSPILOT_DAILY_USAGE_UPSERT_SQL, /ON CONFLICT \(student_id, date\) DO UPDATE/i);
    assert.match(CLASSPILOT_DAILY_USAGE_UPSERT_SQL, /timestamp >= \$2/);
    assert.match(CLASSPILOT_DAILY_USAGE_UPSERT_SQL, /timestamp < \$3/);
  });

  it("shadow comparison is stable across row order and timestamp representations", () => {
    const first = [{
      studentId: "student-a",
      totalSeconds: 20,
      heartbeatCount: 2,
      topDomains: [{ domain: "example.test", seconds: 20, visits: 2 }],
      firstSeen: new Date("2026-08-20T12:00:00Z"),
      lastSeen: new Date("2026-08-20T12:00:10Z"),
    }];
    assert.equal(dailyUsageAggregatesEqual(first, [{
      ...first[0]!,
      firstSeen: "2026-08-20T12:00:00.000Z",
      lastSeen: "2026-08-20T12:00:10.000Z",
    }]), true);
  });
});
