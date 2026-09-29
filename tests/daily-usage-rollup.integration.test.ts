import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";

import {
  dailyUsageAggregatesEqual,
  readSetBasedDailyUsageCandidate,
  upsertSetBasedDailyUsage,
  type DailyUsageAggregate,
} from "../dist/services/classpilotDailyUsageRollup.js";
import { dailyUsageRollupWindow } from "../dist/util/dailyUsageRollup.js";

// pg serializes Date parameters, and parses timestamp-without-time-zone columns, in the
// process timezone. Run far from UTC (CI's default) so a host-time dependency cannot hide.
const originalTimeZone = process.env.TZ;
process.env.TZ = "America/Los_Angeles";

const TAG = `daily_usage_rollup_${Date.now()}`;
const SCHOOL_ID = `${TAG}_school`;
const OTHER_SCHOOL_ID = `${TAG}_other_school`;
const STUDENT_A = `${TAG}_student_a`;
const STUDENT_B = `${TAG}_student_b`;
const OTHER_STUDENT = `${TAG}_other_student`;
const FIXTURE_SCHOOLS = [SCHOOL_ID, OTHER_SCHOOL_ID];

// 2026-07-10 in America/New_York is the half-open UTC window [07-10 04:00, 07-11 04:00).
const window = dailyUsageRollupWindow(new Date("2026-07-11T06:00:00Z"), "America/New_York");
if (!window) throw new Error("the 2026-07-10 rollup window must be open at 06:00Z");
const day = {
  schoolId: SCHOOL_ID,
  date: window.date,
  dayStartUtc: window.dayStartUtc,
  dayEndUtc: window.dayEndUtc,
};

// The scheduler pool's session setting (src/services/schedulerDb.ts).
const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  options: "-c app.is_super=on",
  max: 2,
});

// [school, student, UTC wall-clock timestamp, active tab URL]
const HEARTBEATS: Array<[string, string | null, string, string | null]> = [
  [SCHOOL_ID, STUDENT_A, "2026-07-10 03:59:59", "https://docs.example.edu/before-window"],
  [SCHOOL_ID, STUDENT_A, "2026-07-10 04:00:00", "https://docs.example.edu/window-start"],
  [SCHOOL_ID, STUDENT_A, "2026-07-10 12:00:00", "https://docs.example.edu/lesson"],
  [SCHOOL_ID, STUDENT_A, "2026-07-11 03:59:59.5", "https://video.example.com/clip"],
  [SCHOOL_ID, STUDENT_A, "2026-07-11 04:00:00", "https://docs.example.edu/window-end"],
  [SCHOOL_ID, STUDENT_B, "2026-07-10 15:00:00", null],
  [SCHOOL_ID, STUDENT_B, "2026-07-10 15:00:10", "about:blank"],
  // A heartbeat without a student: daily_usage.student_id is NOT NULL.
  [SCHOOL_ID, null, "2026-07-10 13:00:00", "https://unattributed.example.org/"],
  [SCHOOL_ID, null, "2026-07-10 13:00:10", "https://unattributed.example.org/"],
  [OTHER_SCHOOL_ID, OTHER_STUDENT, "2026-07-10 12:00:00", "https://docs.example.edu/other-school"],
];

const EXPECTED = [
  {
    studentId: STUDENT_A,
    totalSeconds: 30,
    heartbeatCount: 3,
    topDomains: [
      { domain: "docs.example.edu", seconds: 20, visits: 2 },
      { domain: "video.example.com", seconds: 10, visits: 1 },
    ],
    firstSeen: "2026-07-10T04:00:00.000Z",
    lastSeen: "2026-07-11T03:59:59.500Z",
  },
  {
    studentId: STUDENT_B,
    totalSeconds: 20,
    heartbeatCount: 2,
    topDomains: [],
    firstSeen: "2026-07-10T15:00:00.000Z",
    lastSeen: "2026-07-10T15:00:10.000Z",
  },
];

function comparable(rows: DailyUsageAggregate[]) {
  return rows.map((row) => ({
    ...row,
    firstSeen: row.firstSeen instanceof Date ? row.firstSeen.toISOString() : row.firstSeen,
    lastSeen: row.lastSeen instanceof Date ? row.lastSeen.toISOString() : row.lastSeen,
  }));
}

before(async () => {
  for (const [schoolId, studentId, timestamp, url] of HEARTBEATS) {
    await pool.query(
      `INSERT INTO heartbeats (device_id, student_id, school_id, active_tab_title, active_tab_url, timestamp)
       VALUES ($1, $2, $3, 'Daily usage fixture', $4, $5)`,
      [`${TAG}_device`, studentId, schoolId, url, timestamp]
    );
  }
});

after(async () => {
  try {
    await pool.query("DELETE FROM daily_usage WHERE school_id = ANY($1::text[])", [FIXTURE_SCHOOLS]);
    await pool.query("DELETE FROM heartbeats WHERE school_id = ANY($1::text[])", [FIXTURE_SCHOOLS]);
  } finally {
    await pool.end();
    if (originalTimeZone === undefined) delete process.env.TZ;
    else process.env.TZ = originalTimeZone;
  }
});

describe("set-based daily usage rollup against Postgres", () => {
  it("aggregates the half-open school day and skips heartbeats without a student", async () => {
    const candidate = await readSetBasedDailyUsageCandidate(pool, day);
    assert.deepEqual(comparable(candidate), EXPECTED);
  });

  it("upserts the same rows idempotently without violating daily_usage.student_id NOT NULL", async () => {
    const candidate = await readSetBasedDailyUsageCandidate(pool, day);
    const first = await upsertSetBasedDailyUsage(pool, day);
    const second = await upsertSetBasedDailyUsage(pool, day);
    assert.equal(dailyUsageAggregatesEqual(candidate, first), true);
    assert.equal(dailyUsageAggregatesEqual(first, second), true);

    const stored = await pool.query<{
      school_id: string;
      student_id: string;
      date: string;
      total_seconds: number;
      heartbeat_count: number;
      first_seen: string | null;
      last_seen: string | null;
    }>(
      `SELECT school_id, student_id, date, total_seconds, heartbeat_count,
              first_seen::text AS first_seen, last_seen::text AS last_seen
         FROM daily_usage
        WHERE school_id = ANY($1::text[])
        ORDER BY student_id`,
      [FIXTURE_SCHOOLS]
    );
    assert.deepEqual(stored.rows, [
      {
        school_id: SCHOOL_ID,
        student_id: STUDENT_A,
        date: "2026-07-10",
        total_seconds: 30,
        heartbeat_count: 3,
        first_seen: "2026-07-10 04:00:00",
        last_seen: "2026-07-11 03:59:59.5",
      },
      {
        school_id: SCHOOL_ID,
        student_id: STUDENT_B,
        date: "2026-07-10",
        total_seconds: 20,
        heartbeat_count: 2,
        first_seen: "2026-07-10 15:00:00",
        last_seen: "2026-07-10 15:00:10",
      },
    ]);
  });
});
