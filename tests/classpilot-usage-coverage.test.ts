import { after, it } from "node:test";
import assert from "node:assert/strict";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";

// Controlled query results exercise the real report service without a database.
process.env.DATABASE_URL ||= "postgresql://schoolpilot:schoolpilot_dev@localhost:5435/schoolpilot";
process.env.REDIS_URL = "";
const { getClasspilotDigitalUsage, classpilotDigitalUsageCsv } = await import("../src/services/classpilotUsageRead.js");
const { pool, sessionPool } = await import("../src/db.js");
const rollup = await import("../src/services/classpilotUsageRollup.js");
after(async () => { await pool.end(); await sessionPool.end(); });

const dialect = new PgDialect();
const now = new Date("2026-09-16T16:00:00Z");
const total = { total_row: 1, monitored: 30, instructional: 30, students: 1, heartbeats: 2 };
const aggregate = [
  { ...total, total_row: 0, usage_date: "2026-09-13", monitored: 15 },
  { ...total, total_row: 0, usage_date: "2026-09-15", monitored: 15 },
  total,
];
async function report(dates: string[], rows = aggregate) {
  const transaction = {
    async execute(statement: SQL) {
      const query = dialect.sqlToQuery(statement).sql;
      if (query.includes("school.school_timezone")) return { rows: [{ time_zone: "America/New_York", retention_hours: "720" }] };
      if (query.includes("SELECT name FROM schools")) return { rows: [{ name: "School" }] };
      // The legacy reader sees the same aggregate dates, reproducing its hole.
      if (query.includes("MIN(rollup.usage_date)")) return { rows: [{ computed_from: "2026-09-13" }] };
      if (query.includes("FROM classpilot_usage_rollup_days")) return { rows: dates.map((usage_date) => ({ usage_date, computed_at: "2026-09-16T12:00:00Z", is_final: true })) };
      if (query.includes("GROUPING SETS")) return { rows };
      if (query.includes("GROUP BY rollup.domain")) {
        return { rows: [] };
      }
      throw new Error(`Unexpected report query: ${query}`);
    },
  };
  return getClasspilotDigitalUsage({ schoolId: "school", scope: "school", id: null, from: "2026-09-13", to: "2026-09-15", now, transaction: transaction as never });
}

it("does not invent a final zero for a missed middle day", async () => {
  const result = await report(["2026-09-13", "2026-09-15"]);
  assert.deepEqual(result.byDay.map((day) => day.date), ["2026-09-13", "2026-09-15"]);
  assert.equal(result.range.partiallyComputed, true);
  assert.deepEqual(result.range.unavailableDates, ["2026-09-14"]);
  assert.deepEqual([result.range.computedDays, result.range.requestedDays], [2, 3]);
  assert.match(classpilotDigitalUsageCsv(result), /"Unavailable dates","2026-09-14"/);
});

it("presents a successfully processed empty day as zero", async () => {
  const result = await report(["2026-09-13", "2026-09-14", "2026-09-15"]);
  assert.equal(result.range.partiallyComputed, false);
  const day = result.byDay.find((entry) => entry.date === "2026-09-14");
  assert.equal(day?.monitoredBrowserSeconds, 0);
  assert.equal(day?.state, "final");
  assert.equal(result.computedAt, "2026-09-16T12:00:00.000Z");
});

it("withholds pre-ledger aggregates until a compatible computation succeeds", async () => {
  const result = await report([]);
  assert.equal(result.dataState, "unavailable");
  assert.deepEqual(result.byDay, []);
  assert.equal(result.computedAt, null);
  assert.equal(result.range.computedDays, 0);
  assert.deepEqual(result.range.unavailableDates, ["2026-09-13", "2026-09-14", "2026-09-15"]);
});

it("separates combined day/total rows from both ranked domain lists", async () => {
  const result = await report(["2026-09-13", "2026-09-15"], [
    { row_kind: "domain", classification: "educational", domain: "lesson.example.test", seconds: 25 },
    { row_kind: "domain", classification: "non-educational", domain: "games.example.test", seconds: 5 },
    ...aggregate.map(row => ({ ...row, row_kind: "summary" })),
  ]);
  assert.equal(result.totals.monitoredBrowserSeconds, 30);
  assert.equal(result.totals.activeMonitoredStudents, 1);
  assert.equal(result.byDay.length, 2);
  assert.deepEqual(result.topEducationalDomains, [{ domain: "lesson.example.test", seconds: 25 }]);
  assert.deepEqual(result.topNonEducationalDomains, [{ domain: "games.example.test", seconds: 5 }]);
});

it("finds activity after a queued job's cutoff even when computed_at is twenty minutes later", async () => {
  const query = async (text: string, values?: unknown[]) => {
    if (text === rollup.CLASSPILOT_USAGE_ROLLUP_SETTINGS_SQL) return { rows: [{ retention_hours: "720" }] };
    if (text === rollup.CLASSPILOT_USAGE_ROLLUP_LAST_COMPUTED_SQL) return { rows: [{ processed_through: new Date("2026-09-15T14:00:00Z"),
      computed_at: new Date("2026-09-15T14:20:00Z"), is_final: values?.[1] === "2026-09-14" }] };
    if (text === rollup.CLASSPILOT_USAGE_ROLLUP_CHANGED_SQL) return { rows: [{ changed: String(values?.[1]) <= "2026-09-15 14:10:00" }] };
    if (text === rollup.CLASSPILOT_USAGE_ROLLUP_INSERT_SQL) return { rows: [{ row_count: 1, seconds: 15, heartbeat_count: 1 }] };
    return { rows: [] };
  };
  const result = await rollup.runClasspilotUsageRollup({ pool: { query, async connect() { return { query, release() {} }; } },
    schools: [{ id: "school", timeZone: "America/New_York" }], now: new Date("2026-09-15T15:00:00Z"),
    deadline: new Date("2026-09-15T15:25:00Z"), markers: { async isComplete() { return true; }, async markComplete() {} },
    clock: () => new Date("2026-09-15T15:00:01Z") });
  assert.equal(result.recomputedDays, 1, "14:10 activity after the 14:00 snapshot must refresh on the next tick");
});
