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
  CLASSPILOT_DAILY_USAGE_CANDIDATE_SQL,
  CLASSPILOT_DAILY_USAGE_UPSERT_SQL,
  dailyUsageAggregatesEqual,
  dailyUsageRollupMetricRecord,
  parseDailyUsageRollupMode,
  readSetBasedDailyUsageCandidate,
  upsertSetBasedDailyUsage,
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

function heartbeatWindowCte(statement: string): string {
  const start = statement.indexOf("heartbeat_window AS MATERIALIZED (");
  const end = statement.indexOf("student_totals AS MATERIALIZED", start);
  assert.ok(start >= 0 && end > start, "heartbeat_window must precede student_totals");
  return statement.slice(start, end);
}

// Answers like pg does for the set-based SQL: timestamps arrive as the ::text of a
// timestamp-without-time-zone column.
function recordingQueryable() {
  const calls: Array<{ text: string; values: unknown[] }> = [];
  return {
    calls,
    async query(text: string, values: unknown[]) {
      calls.push({ text, values });
      return {
        rows: [{
          student_id: "student-a",
          total_seconds: 20,
          heartbeat_count: 2,
          top_domains: [{ domain: "example.test", seconds: 20, visits: 2 }],
          first_seen: "2026-07-10 12:00:00",
          last_seen: "2026-07-10 12:00:10.25",
        }],
      };
    },
  };
}

function isoTimestamp(value: Date | string | null | undefined): string | null {
  return value instanceof Date ? value.toISOString() : null;
}

describe("set-based daily usage rollup hardening", () => {
  it("drops heartbeats without a student before either set-based statement aggregates", () => {
    for (const statement of [CLASSPILOT_DAILY_USAGE_CANDIDATE_SQL, CLASSPILOT_DAILY_USAGE_UPSERT_SQL]) {
      assert.match(
        heartbeatWindowCte(statement),
        /WHERE school_id = \$1\s+AND student_id IS NOT NULL\s+AND timestamp >= \$2\s+AND timestamp < \$3\s*\)/
      );
    }
  });

  it("binds the day bounds as UTC wall-clock strings and reads timestamps as UTC on any host", async () => {
    const window = dailyUsageRollupWindow(new Date("2026-07-11T06:00:00Z"), "America/New_York");
    assert.ok(window);
    const originalTimeZone = process.env.TZ;
    // pg would serialize a Date parameter, and parse a timestamp column, in this zone.
    process.env.TZ = "America/Los_Angeles";
    try {
      const queryable = recordingQueryable();
      const bounds = { schoolId: "school-1", dayStartUtc: window.dayStartUtc, dayEndUtc: window.dayEndUtc };
      const [candidate] = await readSetBasedDailyUsageCandidate(queryable, bounds);
      const [upserted] = await upsertSetBasedDailyUsage(queryable, { ...bounds, date: window.date });

      assert.deepEqual(queryable.calls.map((call) => call.text), [
        CLASSPILOT_DAILY_USAGE_CANDIDATE_SQL,
        CLASSPILOT_DAILY_USAGE_UPSERT_SQL,
      ]);
      assert.deepEqual(queryable.calls.map((call) => call.values), [
        ["school-1", "2026-07-10 04:00:00", "2026-07-11 04:00:00"],
        ["school-1", "2026-07-10 04:00:00", "2026-07-11 04:00:00", "2026-07-10"],
      ]);
      for (const row of [candidate, upserted]) {
        assert.equal(isoTimestamp(row?.firstSeen), "2026-07-10T12:00:00.000Z");
        assert.equal(isoTimestamp(row?.lastSeen), "2026-07-10T12:00:10.250Z");
      }
    } finally {
      if (originalTimeZone === undefined) delete process.env.TZ;
      else process.env.TZ = originalTimeZone;
    }
  });

  it("reads the rollup mode with on as an alias of set_based and shadow as the default", () => {
    assert.equal(parseDailyUsageRollupMode(undefined), "shadow");
    assert.equal(parseDailyUsageRollupMode(""), "shadow");
    assert.equal(parseDailyUsageRollupMode("shadow"), "shadow");
    assert.equal(parseDailyUsageRollupMode("legacy"), "legacy");
    assert.equal(parseDailyUsageRollupMode("set_based"), "set_based");
    assert.equal(parseDailyUsageRollupMode("SET_BASED"), "set_based");
    assert.equal(parseDailyUsageRollupMode("on"), "set_based");
    assert.equal(parseDailyUsageRollupMode(" On "), "set_based");
    // Unknown values keep today's behavior, including off: legacy writes plus the comparison.
    for (const value of ["off", "true", "1", "enabled", "set-based"]) {
      assert.equal(parseDailyUsageRollupMode(value), "shadow", value);
    }
  });

  it("feeds the scheduler's mode, log line and metrics from one run", () => {
    const source = readFileSync(new URL("../src/services/scheduler.ts", import.meta.url), "utf8");
    assert.match(
      source,
      /function dailyUsageRollupMode\(\): DailyUsageRollupMode \{\s+return parseDailyUsageRollupMode\(process\.env\.CLASSPILOT_DAILY_USAGE_ROLLUP_MODE\);\s+\}/
    );
    const run = source.slice(
      source.indexOf("async function rollupDailyUsage"),
      source.indexOf("function dailyUsageRollupMode")
    );
    assert.match(run, /const mode = dailyUsageRollupMode\(\);/);
    assert.match(run, /rollupSchoolUsage\(school\.id, window, mode\)/);
    assert.match(run, /event: "classpilot_daily_usage_rollup",\s+mode,\s+processedSchools,\s+failedSchools,\s+shadowMismatches,/);
    assert.match(run, /dailyUsageRollupMetricRecord\(\s+\{ shadowMismatches, failedSchools \}/);
  });

  it("publishes only nonzero rollup counters as CloudWatch EMF metrics", () => {
    const options = { environment: "production", timestamp: Date.UTC(2026, 6, 11, 6) };
    assert.equal(dailyUsageRollupMetricRecord({ shadowMismatches: 0, failedSchools: 0 }, options), null);
    assert.equal(dailyUsageRollupMetricRecord({ shadowMismatches: Number.NaN, failedSchools: -1 }, options), null);

    assert.deepEqual(dailyUsageRollupMetricRecord({ shadowMismatches: 2, failedSchools: 0 }, options), {
      _aws: {
        Timestamp: options.timestamp,
        CloudWatchMetrics: [{
          Namespace: "SchoolPilot/ClassPilot",
          Dimensions: [["Environment"]],
          Metrics: [{ Name: "DailyUsageRollupShadowMismatch", Unit: "Count" }],
        }],
      },
      Environment: "production",
      DailyUsageRollupShadowMismatch: 2,
    });

    const both = dailyUsageRollupMetricRecord({ shadowMismatches: 1, failedSchools: 3 }, options);
    assert.ok(both);
    const directive = both._aws.CloudWatchMetrics[0];
    assert.deepEqual(
      directive?.Metrics.map((metric) => metric.Name),
      ["DailyUsageRollupShadowMismatch", "DailyUsageRollupFailedSchools"]
    );
    // EMF drops a directive whose dimensions or metrics lack a top-level member.
    const members: Record<string, unknown> = both;
    for (const dimension of directive?.Dimensions.flat() ?? []) assert.equal(typeof members[dimension], "string");
    for (const metric of directive?.Metrics ?? []) assert.equal(typeof members[metric.Name], "number");
    assert.equal(both.DailyUsageRollupFailedSchools, 3);
  });
});
