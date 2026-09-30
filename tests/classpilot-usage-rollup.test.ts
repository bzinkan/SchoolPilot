import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import pg from "pg";
import { getTableColumns } from "drizzle-orm";

// DB_SERIAL: runs as the database owner, so tenant isolation is asserted in
// tests/classpilot-usage-rollup-rls.test.ts instead. The Digital Usage API is
// gated on the modes AND the table's RLS admission in this process.
process.env.REDIS_URL = "";
process.env.NODE_ENV = "test";
process.env.RLS_GUC_ENABLED = "true";
process.env.RLS_ENABLED_TABLES = "classpilot_usage_rollups";
delete process.env.CLASSPILOT_USAGE_ROLLUP_MODE;
delete process.env.CLASSPILOT_DIGITAL_USAGE_MODE;
// pg serializes Date parameters, and parses timestamp-without-time-zone columns, in the
// process timezone. Run far from UTC so a host-time dependency cannot hide.
const originalTimeZone = process.env.TZ;
process.env.TZ = "America/Los_Angeles";

const TIME_ZONE = "America/New_York";
const TAG = `usage_rollup_${Date.now()}`;
const PURGE_ROLLUPS_SQL = "DELETE FROM classpilot_usage_rollups WHERE school_id = $1 AND usage_date < $2::date";

let system: pg.Pool;
let appPool: typeof import("../src/db.js").pool;
let sessionPool: typeof import("../src/db.js").sessionPool;
let signUserToken: typeof import("../src/services/jwt.js").signUserToken;
let rollup: typeof import("../src/services/classpilotUsageRollup.js");
let schoolTime: typeof import("../src/util/schoolTime.js");
let migration: typeof import("../src/db/classpilotUsageRollupsMigration.js");
let schema: typeof import("../src/schema/classpilot.js");
let server: Server | undefined;
let baseUrl = "";

type Person = { id: string; email: string };
const schoolIds: string[] = [];
const userIds: string[] = [];

const S = {
  schoolId: "", admin: { id: "", email: "" }, teacher: { id: "", email: "" },
  a: "", b: "", c: "", g1: "", g2: "", t1: "", t2: "", day: "", dayStart: 0,
};
const P = { schoolId: "", p1: "", p2: "", session: "" };
const R = { schoolId: "", r1: "" };
const O = { schoolId: "", o1: "" };

function wall(ms: number): string {
  return new Date(ms).toISOString().replace("T", " ").replace("Z", "");
}

async function createSchool(label: string, retentionHours: string, tracking?: { start: string; end: string }) {
  const schoolId = randomUUID();
  schoolIds.push(schoolId);
  await system.query(
    `INSERT INTO schools(id, name, status, is_active, plan_status, school_timezone) VALUES ($1, $2, 'active', true, 'active', $3)`,
    [schoolId, `${TAG} ${label}`, TIME_ZONE],
  );
  await system.query("INSERT INTO product_licenses(school_id, product, status) VALUES ($1, 'CLASSPILOT', 'active')", [schoolId]);
  await system.query(
    `INSERT INTO settings(school_id, school_name, ws_shared_key, retention_hours, enable_tracking_hours, tracking_start_time,
       tracking_end_time, tracking_days, after_hours_mode, grade_levels)
     VALUES ($1, $2, 'fixture', $3, $4, $5, $6, '{Monday,Tuesday,Wednesday,Thursday,Friday}', 'off', '{6,7,8}')`,
    [schoolId, `${TAG} ${label}`, retentionHours, !!tracking, tracking?.start ?? "08:00", tracking?.end ?? "15:00"],
  );
  return schoolId;
}

async function createUser(schoolId: string, role: string, label: string): Promise<Person> {
  const id = randomUUID();
  const email = `${TAG}-${label}-${id.slice(0, 8)}@example.test`;
  userIds.push(id);
  await system.query("INSERT INTO users(id, email, first_name, last_name) VALUES ($1, $2, $3, 'Usage')", [id, email, label]);
  await system.query("INSERT INTO school_memberships(school_id, user_id, role, status) VALUES ($1, $2, $3, 'active')", [schoolId, id, role]);
  return { id, email };
}

async function createStudent(schoolId: string, name: string, gradeLevel: string | null = null): Promise<string> {
  const id = randomUUID();
  await system.query(
    "INSERT INTO students(id, school_id, first_name, last_name, status, grade_level) VALUES ($1, $2, $3, 'Student', 'active', $4)",
    [id, schoolId, name, gradeLevel],
  );
  return id;
}

async function heartbeat(options: {
  schoolId: string; studentId: string | null; at: number; url: string | null; category?: string | null;
  intent?: string | null; device?: string;
}): Promise<string> {
  const result = await system.query(
    `INSERT INTO heartbeats(device_id, student_id, school_id, active_tab_title, active_tab_url, ai_category, teacher_intent_source, timestamp)
     VALUES ($1, $2, $3, 'fixture', $4, $5, $6, $7::timestamp) RETURNING id`,
    [options.device ?? `${TAG}-device`, options.studentId, options.schoolId, options.url, options.category ?? null,
      options.intent ?? null, wall(options.at)],
  );
  return result.rows[0].id;
}

async function rows(schoolId: string) {
  const result = await system.query(
    `SELECT usage_date::text AS usage_date, student_id, class_id, session_id, domain, classification, seconds, heartbeat_count
     FROM classpilot_usage_rollups WHERE school_id = $1
     ORDER BY usage_date, student_id, COALESCE(class_id, ''), COALESCE(session_id, ''), domain, classification`,
    [schoolId],
  );
  return result.rows;
}

function markers() {
  const complete = new Set<string>();
  return {
    complete,
    async isComplete(schoolId: string, date: string) { return complete.has(`${schoolId}:${date}`); },
    async markComplete(schoolId: string, date: string) { complete.add(`${schoolId}:${date}`); },
  };
}

async function withEnv<T>(values: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const previous = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

const MODES_ON = { CLASSPILOT_USAGE_ROLLUP_MODE: "on", CLASSPILOT_DIGITAL_USAGE_MODE: "on" };

function headers(user: Person, schoolId: string): Record<string, string> {
  return {
    authorization: `Bearer ${signUserToken({ userId: user.id, email: user.email, isSuperAdmin: false })}`,
    "x-school-id": schoolId,
  };
}

async function usage(query: string, user: Person = S.admin, schoolId = S.schoolId) {
  const response = await fetch(`${baseUrl}/classpilot/admin/usage${query}`, { headers: headers(user, schoolId) });
  // Decode without dropping a byte-order mark (Response.text() strips it).
  const bytes = Buffer.from(await response.arrayBuffer());
  const text = bytes.toString("utf8");
  const type = response.headers.get("content-type") || "";
  return { status: response.status, headers: response.headers, bytes, text, body: type.includes("json") && text ? JSON.parse(text) : null };
}

before(async () => {
  assert.ok(["localhost", "127.0.0.1", "::1"].includes(new URL(process.env.DATABASE_URL || "").hostname), "Only a local fixture database is permitted");
  system = new pg.Pool({ connectionString: process.env.DATABASE_URL, options: "-c app.is_super=on", max: 3 });
  const dbModule = await import("../src/db.js");
  appPool = dbModule.pool;
  sessionPool = dbModule.sessionPool;
  ({ signUserToken } = await import("../src/services/jwt.js"));
  rollup = await import("../src/services/classpilotUsageRollup.js");
  schoolTime = await import("../src/util/schoolTime.js");
  migration = await import("../src/db/classpilotUsageRollupsMigration.js");
  schema = await import("../src/schema/classpilot.js");
  // A pushed schema makes CREATE TABLE IF NOT EXISTS a no-op; the SQL still
  // reconciles the SET NULL keys and installs forced RLS exactly as production.
  await system.query(migration.CLASSPILOT_USAGE_ROLLUPS_SQL);

  // School S: attribution, API, CSV and Student Data. Its day is three local
  // days ago so the default 30-day retention always keeps it.
  S.schoolId = await createSchool("Main", "720");
  S.admin = await createUser(S.schoolId, "admin", "admin");
  S.teacher = await createUser(S.schoolId, "teacher", "teacher");
  S.a = await createStudent(S.schoolId, "Ada", "6");
  S.b = await createStudent(S.schoolId, "Ben", "6");
  S.c = await createStudent(S.schoolId, "Cy", "7");
  S.g1 = randomUUID();
  S.g2 = randomUUID();
  await system.query(
    `INSERT INTO groups(id, school_id, teacher_id, name, group_type) VALUES ($1, $3, $4, 'Math', 'admin_class'), ($2, $3, $4, $5, 'admin_class')`,
    [S.g1, S.g2, S.schoolId, S.teacher.id, "=cmd|' /C calc'!A0"],
  );
  S.day = schoolTime.addLocalDays(schoolTime.localDateInTimeZone(new Date(), TIME_ZONE), -3);
  S.dayStart = schoolTime.localDateStartUtc(S.day, TIME_ZONE).getTime();
  const at = (hours: number, minutes = 0, seconds = 0, ms = 0) => S.dayStart + ((hours * 60 + minutes) * 60 + seconds) * 1000 + ms;
  S.t1 = randomUUID();
  S.t2 = randomUUID();
  await system.query(
    `INSERT INTO teaching_sessions(id, group_id, teacher_id, school_id, start_time, end_time)
     VALUES ($1, $2, $5, $6, $7::timestamp, $8::timestamp), ($3, $4, $5, $6, $8::timestamp, $9::timestamp)`,
    [S.t1, S.g1, S.t2, S.g2, S.teacher.id, S.schoolId, wall(at(9)), wall(at(9, 30)), wall(at(10))],
  );
  for (const [session, group, start] of [[S.t1, S.g1, at(9)], [S.t2, S.g2, at(9, 30)]] as const) {
    for (const student of [S.a, S.b]) {
      await system.query(
        `INSERT INTO classpilot_session_students(school_id, teaching_session_id, group_id, student_id, captured_at)
         VALUES ($1, $2, $3, $4, $5::timestamptz)`,
        [S.schoolId, session, group, student, new Date(start).toISOString()],
      );
    }
  }
  // A: one device every 10 s across the 09:30 class switch, then once much later.
  for (let index = 0; index < 120; index += 1) {
    await heartbeat({ schoolId: S.schoolId, studentId: S.a, at: at(9, 20, index * 10), url: "https://docs.example.edu/unit", category: "educational" });
  }
  await heartbeat({ schoolId: S.schoolId, studentId: S.a, at: at(13), url: "https://docs.example.edu/unit", category: "educational" });
  // B: two devices in the same second buckets showing different pages.
  for (let index = 0; index < 6; index += 1) {
    await heartbeat({ schoolId: S.schoolId, studentId: S.b, at: at(11, 0, index * 10, 100), url: "https://docs.example.edu/b", category: "educational", device: `${TAG}-b1` });
    await heartbeat({ schoolId: S.schoolId, studentId: S.b, at: at(11, 0, index * 10, 600), url: "https://games.example.net/", category: "non-educational", device: `${TAG}-b2` });
  }
  // C: AI decision precedence, teacher intent, non-http URL, unclassified page.
  const reclassified = await heartbeat({ schoolId: S.schoolId, studentId: S.c, at: at(12), url: "https://Arcade.Example.com/play", category: "educational" });
  await system.query(
    `INSERT INTO classpilot_ai_decisions(school_id, student_id, heartbeat_id, category, created_at) VALUES ($1, $2, $3, 'educational', now() - interval '1 minute'), ($1, $2, $3, 'non-educational', now())`,
    [S.schoolId, S.c, reclassified],
  );
  await heartbeat({ schoolId: S.schoolId, studentId: S.c, at: at(12, 0, 10), url: "https://www.video.example.org/watch", category: "non-educational", intent: "flight_path" });
  await heartbeat({ schoolId: S.schoolId, studentId: S.c, at: at(12, 0, 20), url: "chrome://settings", category: null });
  await heartbeat({ schoolId: S.schoolId, studentId: S.c, at: at(12, 0, 30), url: "https://news.example.com/", category: null });
  // Never attributable: no student, and another school's student id.
  O.schoolId = await createSchool("Other", "720");
  O.o1 = await createStudent(O.schoolId, "Otto", "6");
  await heartbeat({ schoolId: S.schoolId, studentId: null, at: at(12, 30), url: "https://docs.example.edu/x", category: "educational" });
  await heartbeat({ schoolId: S.schoolId, studentId: O.o1, at: at(12, 31), url: "https://docs.example.edu/x", category: "educational" });
  await heartbeat({ schoolId: O.schoolId, studentId: O.o1, at: at(12, 32), url: "https://other.example.org/", category: "educational" });

  const { createApp } = await import("../src/app.js");
  server = createServer(createApp());
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
});

after(async () => {
  try {
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    // Best effort: once the staff-identity contract is installed, users and
    // schools are retained records that cannot be hard-deleted.
    const bestEffort = (text: string, values: unknown[]) => system.query(text, values).catch(() => undefined);
    if (schoolIds.length) {
      for (const table of ["classpilot_usage_rollups", "classpilot_ai_decisions", "classpilot_monitoring_events", "heartbeats",
        "classpilot_session_students", "teaching_sessions", "audit_logs"]) {
        await bestEffort(`DELETE FROM ${table} WHERE school_id = ANY($1::text[])`, [schoolIds]);
      }
      for (const table of ["groups", "students", "settings", "school_memberships", "product_licenses"]) {
        await bestEffort(`DELETE FROM ${table} WHERE school_id = ANY($1::text[])`, [schoolIds]);
      }
      await bestEffort("DELETE FROM users WHERE id = ANY($1::text[])", [userIds]);
      await bestEffort("DELETE FROM schools WHERE id = ANY($1::text[])", [schoolIds]);
    }
  } finally {
    await system?.end().catch(() => undefined);
    const { schedulerPool, schedulerLockPool } = await import("../src/services/schedulerDb.js");
    await Promise.allSettled([appPool?.end(), sessionPool?.end(), schedulerPool.end(), schedulerLockPool.end()]);
    if (originalTimeZone === undefined) delete process.env.TZ;
    else process.env.TZ = originalTimeZone;
  }
});

describe("Monitored Browser Time rollups (DB lane)", { concurrency: false }, () => {
  it("keeps the pushed table, the migration and the Drizzle schema in parity", async () => {
    const columns = await system.query(
      "SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'classpilot_usage_rollups' ORDER BY column_name",
    );
    assert.deepEqual(
      columns.rows.map((row) => row.column_name),
      Object.values(getTableColumns(schema.classpilotUsageRollups)).map((column) => column.name).sort(),
    );
    const keys = await system.query(
      `SELECT conname, confdeltype FROM pg_constraint WHERE conrelid = 'classpilot_usage_rollups'::regclass AND contype = 'f' ORDER BY conname`,
    );
    assert.deepEqual(keys.rows.map((row) => [row.conname, row.confdeltype]), [
      ["cp_usage_rollups_class_school_fk", "n"],
      ["cp_usage_rollups_school_fk", "a"],
      ["cp_usage_rollups_session_school_fk", "n"],
      ["cp_usage_rollups_student_school_fk", "c"],
    ]);
    const table = await system.query("SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = 'classpilot_usage_rollups'");
    assert.deepEqual(table.rows[0], { relrowsecurity: true, relforcerowsecurity: true });
  });

  it("splits a class switch by session, counts duplicate cross-device heartbeats once, and classifies like session reports", async () => {
    const day = rollup.classpilotUsageRollupDay(S.day, TIME_ZONE);
    const result = await rollup.rollupClasspilotUsageDay(system, { schoolId: S.schoolId, day, windowEndUtc: day.dayEndUtc, exclusions: [] });
    assert.deepEqual(result, { rowCount: 8, seconds: 1330, heartbeatCount: 131 });
    const expected = [
      { student_id: S.a, class_id: S.g1, session_id: S.t1, domain: "docs.example.edu", classification: "educational", seconds: 600, heartbeat_count: 60 },
      { student_id: S.a, class_id: S.g2, session_id: S.t2, domain: "docs.example.edu", classification: "educational", seconds: 605, heartbeat_count: 60 },
      { student_id: S.a, class_id: null, session_id: null, domain: "docs.example.edu", classification: "educational", seconds: 15, heartbeat_count: 1 },
      // Six second buckets from two devices: one observation each, and the
      // second device's page never earns time.
      { student_id: S.b, class_id: null, session_id: null, domain: "docs.example.edu", classification: "educational", seconds: 65, heartbeat_count: 6 },
      { student_id: S.c, class_id: null, session_id: null, domain: "", classification: "unknown", seconds: 10, heartbeat_count: 1 },
      { student_id: S.c, class_id: null, session_id: null, domain: "arcade.example.com", classification: "non-educational", seconds: 10, heartbeat_count: 1 },
      { student_id: S.c, class_id: null, session_id: null, domain: "news.example.com", classification: "unknown", seconds: 15, heartbeat_count: 1 },
      { student_id: S.c, class_id: null, session_id: null, domain: "video.example.org", classification: "educational", seconds: 10, heartbeat_count: 1 },
    ].map((row) => ({ usage_date: S.day, ...row }));
    const sort = (list: Array<Record<string, unknown>>) => [...list].sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
    assert.deepEqual(sort(await rows(S.schoolId)), sort(expected));
    assert.deepEqual(await rows(O.schoolId), [], "another school's heartbeats never produce rows here or there");
  });

  it("re-runs idempotently to the identical row set", async () => {
    const before = await rows(S.schoolId);
    const day = rollup.classpilotUsageRollupDay(S.day, TIME_ZONE);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await rollup.rollupClasspilotUsageDay(system, { schoolId: S.schoolId, day, windowEndUtc: day.dayEndUtc, exclusions: [] });
    }
    assert.deepEqual(await rows(S.schoolId), before);
    const grain = await system.query(
      `SELECT count(*)::int AS rows, count(DISTINCT (student_id, COALESCE(class_id, ''), COALESCE(session_id, ''), domain, classification))::int AS grains
       FROM classpilot_usage_rollups WHERE school_id = $1`,
      [S.schoolId],
    );
    assert.equal(grain.rows[0].rows, grain.rows[0].grains);
  });

  it("gives tracking-policy-disabled and server-disabled intervals zero seconds", async () => {
    P.schoolId = await createSchool("Policy", "720", { start: "08:00", end: "15:00" });
    P.p1 = await createStudent(P.schoolId, "Pia", "6");
    P.p2 = await createStudent(P.schoolId, "Pat", "6");
    const date = "2026-09-14"; // a Monday
    const start = schoolTime.localDateStartUtc(date, TIME_ZONE).getTime();
    const local = (hours: number, minutes = 0, seconds = 0) => start + ((hours * 60 + minutes) * 60 + seconds) * 1000;
    for (const [hours, minutes, seconds] of [[7, 59, 50], [10, 0, 0], [14, 59, 55], [15, 0, 5], [16, 0, 0]] as const) {
      await heartbeat({ schoolId: P.schoolId, studentId: P.p1, at: local(hours, minutes, seconds), url: "https://docs.example.edu/p", category: "educational" });
    }
    for (const [hours, minutes, seconds] of [[10, 59, 50], [11, 0, 30], [11, 5, 10], [12, 0, 30]] as const) {
      await heartbeat({ schoolId: P.schoolId, studentId: P.p2, at: local(hours, minutes, seconds), url: "https://docs.example.edu/p", category: "educational" });
    }
    P.session = randomUUID();
    const teacher = await createUser(P.schoolId, "teacher", "p-teacher");
    const group = randomUUID();
    await system.query("INSERT INTO groups(id, school_id, teacher_id, name, group_type) VALUES ($1, $2, $3, 'Policy class', 'admin_class')", [group, P.schoolId, teacher.id]);
    await system.query(
      "INSERT INTO teaching_sessions(id, group_id, teacher_id, school_id, start_time, end_time) VALUES ($1, $2, $3, $4, $5::timestamp, $6::timestamp)",
      [P.session, group, teacher.id, P.schoolId, wall(local(8)), wall(local(9))],
    );
    const event = (origin: string, state: string, hours: number, minutes: number) => system.query(
      `INSERT INTO classpilot_monitoring_events(school_id, student_id, student_session_id, teaching_session_id, source_event_id, origin,
         event_type, occurred_at, metadata, retention_expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'monitoring_state_changed', $7::timestamptz, $8::jsonb, now() + interval '30 days')`,
      [P.schoolId, P.p2, `${TAG}-student-session`, P.session, randomUUID(), origin, new Date(local(hours, minutes)).toISOString(), JSON.stringify({ state })],
    );
    await event("server", "off", 11, 0);
    await event("server", "active", 11, 5);
    await event("extension", "off", 12, 0); // telemetry never excludes time

    const outcome = await rollup.runClasspilotUsageRollup({
      pool: system,
      schools: [{ id: P.schoolId, timeZone: TIME_ZONE }],
      now: new Date("2026-09-15T04:00:05Z"),
      deadline: new Date("2026-09-15T04:25:00Z"),
      markers: markers(),
      clock: () => new Date("2026-09-15T04:00:06Z"),
    });
    assert.equal(outcome.finalizedDays, 1);
    assert.equal(outcome.failedSchools, 0);
    const totals = await system.query(
      `SELECT student_id, SUM(seconds)::int AS seconds, SUM(heartbeat_count)::int AS heartbeats FROM classpilot_usage_rollups
       WHERE school_id = $1 AND usage_date = $2::date GROUP BY student_id`,
      [P.schoolId, date],
    );
    const byStudent = Object.fromEntries(totals.rows.map((row) => [row.student_id, [row.seconds, row.heartbeats]]));
    // P1: 10:00 earns 15 s and 14:59:55 stops at the 15:00 policy boundary
    // (5 s); 07:59:50, 15:00:05 and 16:00 are outside tracking hours.
    assert.deepEqual(byStudent[P.p1], [20, 2]);
    // P2: 10:59:50 stops at the server "off" (10 s); 11:00:30 is excluded;
    // 11:05:10 and 12:00:30 earn 15 s each.
    assert.deepEqual(byStudent[P.p2], [40, 3]);
  });

  it("never lets the purge reduce a one-day-retention school's finished day, and purges even when the rollup overruns", async () => {
    R.schoolId = await createSchool("Retention", "24");
    R.r1 = await createStudent(R.schoolId, "Rae", "6");
    const date = "2026-09-14";
    const start = schoolTime.localDateStartUtc(date, TIME_ZONE).getTime();
    const local = (hours: number, minutes = 0, seconds = 0) => start + ((hours * 60 + minutes) * 60 + seconds) * 1000;
    for (const [hours, minutes, seconds] of [[0, 5, 0], [0, 5, 10], [0, 5, 20], [20, 0, 0], [20, 0, 10]] as const) {
      await heartbeat({ schoolId: R.schoolId, studentId: R.r1, at: local(hours, minutes, seconds), url: "https://docs.example.edu/r", category: "educational" });
    }
    const total = async () => (await system.query(
      "SELECT COALESCE(SUM(seconds), 0)::int AS seconds, MAX(computed_at) AS computed_at FROM classpilot_usage_rollups WHERE school_id = $1 AND usage_date = $2::date",
      [R.schoolId, date],
    )).rows[0];

    // 00:00:05 local: the first top-of-hour tick after midnight finalizes the
    // whole day before the 00:30 purge.
    const first = await rollup.runClasspilotUsageRollup({
      pool: system, schools: [{ id: R.schoolId, timeZone: TIME_ZONE }],
      now: new Date("2026-09-15T04:00:05Z"), deadline: new Date("2026-09-15T04:25:00Z"), markers: markers(),
      clock: () => new Date("2026-09-15T04:00:06Z"),
    });
    assert.equal(first.finalizedDays, 1);
    const finalized = await total();
    assert.equal(finalized.seconds, 60);

    // The 00:30 purge with the scheduler's own statements (UTC wall clock, as
    // on the production host).
    const scheduler = readFileSync(new URL("../src/services/scheduler.ts", import.meta.url), "utf8");
    assert.ok(scheduler.includes(PURGE_ROLLUPS_SQL));
    const purgeAt = new Date("2026-09-15T04:30:00Z");
    const cutoff = new Date(purgeAt.getTime() - 24 * 60 * 60 * 1000);
    const purged = await system.query(
      "DELETE FROM heartbeats WHERE id IN (SELECT id FROM heartbeats WHERE school_id = $1 AND timestamp < $2 LIMIT 5000)",
      [R.schoolId, schoolTime.utcTimestampForSql(cutoff)],
    );
    assert.equal(purged.rowCount, 3, "the day's first heartbeats are gone");
    await system.query(PURGE_ROLLUPS_SQL, [R.schoolId, schoolTime.localDateInTimeZone(cutoff, TIME_ZONE)]);
    assert.deepEqual(await total(), finalized, "the finished day's rollup outlives its purged heartbeats");

    // 01:00 local with the marker lost (worker restart): the partly purged
    // day is never rewritten, so it cannot shrink to the 25 s still on disk.
    const second = await rollup.runClasspilotUsageRollup({
      pool: system, schools: [{ id: R.schoolId, timeZone: TIME_ZONE }],
      now: new Date("2026-09-15T05:00:05Z"), deadline: new Date("2026-09-15T05:25:00Z"), markers: markers(),
      clock: () => new Date("2026-09-15T05:00:06Z"),
    });
    assert.equal(second.retentionSkippedDays, 1);
    assert.equal(second.finalizedDays, 0);
    assert.deepEqual(await total(), finalized);

    // Overrun: the first school exhausts the hour's budget, the rest is
    // deferred, and the :30 retention step still runs and removes old days.
    let ticks = 0;
    const overrun = await rollup.runClasspilotUsageRollup({
      pool: system,
      schools: [{ id: R.schoolId, timeZone: TIME_ZONE }, { id: P.schoolId, timeZone: TIME_ZONE }],
      now: new Date("2026-09-16T04:00:05Z"),
      deadline: new Date("2026-09-16T04:25:00Z"),
      markers: markers(),
      clock: () => new Date(ticks++ === 0 ? "2026-09-16T04:00:06Z" : "2026-09-16T04:26:00Z"),
      concurrency: 1,
    });
    assert.equal(overrun.budgetExhausted, true);
    assert.equal(overrun.deferredDays, 3);
    const nextCutoff = new Date(new Date("2026-09-16T04:30:00Z").getTime() - 24 * 60 * 60 * 1000);
    const removed = await system.query(PURGE_ROLLUPS_SQL, [R.schoolId, schoolTime.localDateInTimeZone(nextCutoff, TIME_ZONE)]);
    assert.equal(removed.rowCount, 1);
    assert.deepEqual(await rows(R.schoolId), []);
  });

  it("serves no Digital Usage route unless both modes are on and the table is admitted", async () => {
    const off = await usage("");
    assert.equal(off.status, 404);
    assert.deepEqual(off.body, { error: "Not found" });
    await withEnv({ CLASSPILOT_DIGITAL_USAGE_MODE: "on" }, async () => {
      assert.equal((await usage("")).status, 404, "digital usage alone stays off");
    });
    await withEnv({ ...MODES_ON, RLS_ENABLED_TABLES: "students" }, async () => {
      assert.equal((await usage("")).status, 404, "not RLS-admitted");
    });
  });

  it("reports Monitored Browser Time by school, grade, class and student, bounded by retention and computation", async () => {
    await withEnv(MODES_ON, async () => {
      const school = await usage(`?from=${S.day}&to=${S.day}`);
      assert.equal(school.status, 200, school.text);
      assert.equal(school.headers.get("cache-control"), "no-store, private");
      assert.equal(school.body.measure, "Monitored Browser Time");
      assert.deepEqual(school.body.totals, {
        monitoredBrowserSeconds: 1330, instructionalSeconds: 1295, offTaskSeconds: 10, unknownSeconds: 25,
        activeMonitoredStudents: 3, heartbeatCount: 131,
      });
      assert.equal(school.body.dataState, "final");
      assert.deepEqual(school.body.byDay.map((day: { date: string; state: string }) => [day.date, day.state]), [[S.day, "final"]]);
      assert.deepEqual(school.body.topEducationalDomains, [{ domain: "docs.example.edu", seconds: 1285 }, { domain: "video.example.org", seconds: 10 }]);
      assert.deepEqual(school.body.topNonEducationalDomains, [{ domain: "arcade.example.com", seconds: 10 }]);
      assert.doesNotMatch(school.text, /device/i, "no device identifiers");

      const grade6 = await usage(`?scope=grade&id=6&from=${S.day}&to=${S.day}`);
      assert.equal(grade6.body.totals.monitoredBrowserSeconds, 1285);
      assert.equal(grade6.body.totals.activeMonitoredStudents, 2);
      assert.equal(grade6.body.scope.label, "Grade 6");
      assert.equal((await usage(`?scope=grade&id=8&from=${S.day}&to=${S.day}`)).body.totals.monitoredBrowserSeconds, 0, "a configured grade with no students");
      assert.equal((await usage(`?scope=grade&id=11&from=${S.day}&to=${S.day}`)).status, 404);
      const math = await usage(`?scope=class&id=${S.g1}&from=${S.day}&to=${S.day}`);
      assert.equal(math.body.totals.monitoredBrowserSeconds, 600);
      assert.equal(math.body.scope.label, "Math");
      const student = await usage(`?scope=student&id=${S.a}&from=${S.day}&to=${S.day}`);
      assert.equal(student.body.totals.monitoredBrowserSeconds, 1220);
      assert.equal(student.body.scope.label, "Ada Student");
      assert.equal((await usage(`?scope=student&id=${O.o1}`)).status, 404, "another school's student");
      assert.equal((await usage(`?scope=class&id=${randomUUID()}`)).status, 404);

      const wide = await usage(`?from=${schoolTime.addLocalDays(S.day, -40)}&to=${S.day}`);
      assert.equal(wide.status, 200);
      assert.equal(wide.body.range.partiallyExpired, true);
      assert.equal(wide.body.range.partiallyComputed, true);
      assert.equal(wide.body.range.computedFrom, S.day);
      assert.equal(wide.body.range.presentedFrom, S.day);
      assert.equal(wide.body.totals.monitoredBrowserSeconds, 1330);

      for (const query of ["?scope=district", "?format=xml", "?scope=school&id=x", "?scope=class", `?from=${S.day}&to=${schoolTime.addLocalDays(S.day, -1)}`,
        `?from=${schoolTime.addLocalDays(S.day, -366)}&to=${S.day}`, "?from=2026-02-30"]) {
        const invalid = await usage(query);
        assert.equal(invalid.status, 400, query);
        assert.match(invalid.body.code, /^CLASSPILOT_USAGE_/);
      }
      assert.equal((await usage("", S.teacher)).status, 403, "administrators only");

      // A one-day-retention school keeps rows on disk that the API withholds.
      const expired = await usage("?from=2026-09-14&to=2026-09-14", S.admin, S.schoolId);
      assert.equal(expired.body.dataState, "unavailable", "S has no rows for that date");
    });
  });

  it("exports formula-safe CSV with a BOM, CRLF rows and an audit record", async () => {
    await withEnv(MODES_ON, async () => {
      const csv = await usage(`?scope=class&id=${S.g2}&from=${S.day}&to=${S.day}&format=csv`);
      assert.equal(csv.status, 200, csv.text);
      assert.equal(csv.headers.get("content-type"), "text/csv; charset=utf-8");
      assert.equal(csv.headers.get("cache-control"), "no-store, private");
      assert.equal(csv.headers.get("x-content-type-options"), "nosniff");
      assert.match(csv.headers.get("content-disposition") || "", /^attachment; filename="classpilot-monitored-browser-time-class-/);
      assert.deepEqual([...csv.bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf], "UTF-8 byte-order mark");
      assert.ok(csv.text.startsWith("\uFEFF\"Report\",\"Monitored Browser Time\"\r\n"));
      assert.match(csv.text, /"Label","'=cmd\|' \/C calc'!A0"/);
      assert.match(csv.text, /"Date","Day state","Monitored Browser Time \(minutes\)","Instructional \(minutes\)","Off-task \(minutes\)","Unclassified \(minutes\)","Active monitored students","Heartbeats"\r\n/);
      assert.match(csv.text, new RegExp(`"${S.day}","final","10\\.1","10\\.1","0\\.0","0\\.0","1","60"`));
      assert.doesNotMatch(csv.text, /Screen Time/i);
      const audit = await system.query(
        "SELECT user_id, entity_type, entity_id, metadata FROM audit_logs WHERE school_id = $1 AND action = 'classpilot.usage.export'",
        [S.schoolId],
      );
      assert.equal(audit.rowCount, 1);
      assert.equal(audit.rows[0].user_id, S.admin.id);
      assert.equal(audit.rows[0].entity_type, "classpilot_usage_class");
      assert.equal(audit.rows[0].entity_id, S.g2);
    });
  });

  it("includes one student's rollups in the administrator's Student Data export only while Digital Usage is on", async () => {
    const today = schoolTime.localDateInTimeZone(new Date(), TIME_ZONE);
    await system.query(
      `INSERT INTO classpilot_usage_rollups(school_id, usage_date, student_id, domain, classification, seconds, heartbeat_count)
       VALUES ($1, $3::date, $2, 'docs.example.edu', 'educational', 120, 10), ($1, $3::date, $2, 'games.example.net', 'non-educational', 30, 3)`,
      [S.schoolId, S.b, today],
    );
    const studentData = async () => {
      const response = await fetch(`${baseUrl}/classpilot/student-data?period=today&studentId=${S.b}`, { headers: headers(S.admin, S.schoolId) });
      assert.equal(response.status, 200, await response.clone().text());
      return (await response.json()) as { revision: string; student: Record<string, any> };
    };
    const off = await studentData();
    assert.equal("monitoredBrowserTime" in off.student, false);
    await withEnv(MODES_ON, async () => {
      const on = await studentData();
      const block = on.student.monitoredBrowserTime;
      assert.equal(block.measure, "Monitored Browser Time");
      assert.deepEqual(block.totals, { monitoredBrowserSeconds: 150, instructionalSeconds: 120, offTaskSeconds: 30, unknownSeconds: 0, heartbeatCount: 13 });
      assert.deepEqual(block.byDay.map((day: { date: string; state: string }) => [day.date, day.state]), [[today, "live"]]);
      assert.equal(on.student.monitoredSeconds, off.student.monitoredSeconds, "class-session seconds are unchanged");
      assert.notEqual(on.revision, off.revision, "the revision covers the exported block");
    });
  });

  it("clears the rollups with the school's activity cleanup", async () => {
    const response = await fetch(`${baseUrl}/admin/cleanup-students`, { method: "POST", headers: { ...headers(S.admin, S.schoolId), "content-type": "application/json" } });
    assert.equal(response.status, 200, await response.clone().text());
    assert.deepEqual(await rows(S.schoolId), []);
  });
});
