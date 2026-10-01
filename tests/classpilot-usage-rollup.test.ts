import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import pg from "pg";
import { getTableColumns } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";

// DB_SERIAL: runs as the database owner, so tenant isolation is asserted in
// tests/classpilot-usage-rollup-rls.test.ts instead. The Digital Usage API is
// gated on the modes AND the table's RLS admission in this process.
process.env.REDIS_URL = "";
process.env.NODE_ENV = "test";
process.env.RLS_GUC_ENABLED = "true";
process.env.RLS_ENABLED_TABLES = "classpilot_usage_rollups,classpilot_usage_rollup_days";
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

async function createAdminClasses(schoolId: string, teacherId: string, classes: Array<{ id: string; name: string }>) {
  const client = await system.connect();
  try {
    await client.query("BEGIN");
    // The staff identity contract checks the matching primary relationship at
    // commit. Construct both sides atomically, as the canonical class writer does.
    await client.query(`INSERT INTO groups(id,school_id,teacher_id,name,group_type)
      SELECT id,$2,$3,($4::text[])[ordinality::int],'admin_class'
      FROM unnest($1::text[]) WITH ORDINALITY fixture(id,ordinality)`,
    [classes.map(row => row.id), schoolId, teacherId, classes.map(row => row.name)]);
    await client.query("INSERT INTO group_teachers(group_id,teacher_id,role) SELECT id,$2,'primary' FROM unnest($1::text[]) id",
      [classes.map(row => row.id), teacherId]);
    await client.query("COMMIT");
  } catch (error) { await client.query("ROLLBACK"); throw error; }
  finally { client.release(); }
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

const attributionReference = readFileSync(new URL("./fixtures/usage-before-fast-paths/attribution.sql", import.meta.url), "utf8");
const reportReference = readFileSync(new URL("./fixtures/usage-before-fast-paths/report.sql", import.meta.url), "utf8");
for (const query of [attributionReference, reportReference]) assert.doesNotMatch(query, /\b(?:INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|COPY|DO)\b/i);

function readonlyGrains() {
  const query = rollup.CLASSPILOT_USAGE_ROLLUP_INSERT_SQL.split(",\ninserted AS (")[0];
  assert.ok(query, "The attribution diagnostic must have a nonempty read-only prefix");
  assert.ok(!query.includes("INSERT INTO"));
  return query + " SELECT $4::date AS usage_date,grains.* FROM grains ORDER BY student_id,COALESCE(class_id,''),COALESCE(session_id,''),domain,classification";
}

function referenceTotals(row: Record<string, unknown> | undefined) {
  return {
    monitoredBrowserSeconds: Number(row?.monitored ?? 0), instructionalSeconds: Number(row?.instructional ?? 0),
    offTaskSeconds: Number(row?.off_task ?? 0), unknownSeconds: Number(row?.unknown ?? 0),
    activeMonitoredStudents: Number(row?.students ?? 0), heartbeatCount: Number(row?.heartbeats ?? 0),
  };
}

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
  const daysMigration = await import("../src/db/classpilotUsageRollupDaysMigration.js");
  const migrationClient = await system.connect();
  try {
    await migrationClient.query("BEGIN");
    await migrationClient.query(daysMigration.CLASSPILOT_USAGE_ROLLUP_DAYS_SQL);
    await migrationClient.query("COMMIT");
  } catch (error) { await migrationClient.query("ROLLBACK"); throw error; }
  finally { migrationClient.release(); }

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
  await createAdminClasses(S.schoolId, S.teacher.id, [{ id: S.g1, name: "Math" }, { id: S.g2, name: "=cmd|' /C calc'!A0" }]);
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
      for (const table of ["classpilot_usage_rollup_days", "classpilot_usage_rollups", "classpilot_ai_decisions", "classpilot_monitoring_events", "heartbeats",
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
    await createAdminClasses(P.schoolId, teacher.id, [{ id: group, name: "Policy class" }]);
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
    assert.equal(second.retentionSkippedDays, 0, "durable final coverage survives a lost Redis marker");
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

  it("resolves overlapping frozen roster intervals once without duplicate time, honoring capture, tied starts and end bounds", async () => {
    const schoolId = await createSchool("Overlapping intervals", "720");
    const student = await createStudent(schoolId, "Window", "6");
    const teacher = await createUser(schoolId, "teacher", "window-teacher");
    const date = schoolTime.addLocalDays(schoolTime.localDateInTimeZone(new Date(), TIME_ZONE), -2);
    const start = schoolTime.localDateStartUtc(date, TIME_ZONE).getTime() + 9 * 3600_000;
    const group = randomUUID();
    await createAdminClasses(schoolId, teacher.id, [{ id: group, name: "Overlapping" }]);
    const sessions = [
      { id: `a-${randomUUID()}`, start: 0, captured: 0, end: 140, scheduled: null },
      { id: `b-${randomUUID()}`, start: 20, captured: 60, end: 120, scheduled: null },
      { id: `c-${randomUUID()}`, start: 40, captured: 40, end: 110, scheduled: null },
      { id: `z-${randomUUID()}`, start: 40, captured: 80, end: 140, scheduled: 100 },
    ] as const;
    for (const item of sessions) {
      await system.query("INSERT INTO teaching_sessions(id,school_id,group_id,teacher_id,start_time,end_time) VALUES($1,$2,$3,$4,$5::timestamp,$6::timestamp)",
        [item.id, schoolId, group, teacher.id, wall(start + item.start * 1000), wall(start + item.end * 1000)]);
      if (item.scheduled !== null) await system.query("UPDATE teaching_sessions SET scheduled_date=$2::date,scheduled_timezone=$3,scheduled_start_at=$4::timestamptz,scheduled_end_at=$5::timestamptz,scheduled_state='active' WHERE id=$1",
        [item.id, date, TIME_ZONE, new Date(start + item.start * 1000).toISOString(), new Date(start + item.scheduled * 1000).toISOString()]);
      await system.query("INSERT INTO classpilot_session_students(school_id,teaching_session_id,group_id,student_id,captured_at) VALUES($1,$2,$3,$4,$5::timestamptz)",
        [schoolId, item.id, group, student, new Date(start + item.captured * 1000).toISOString()]);
    }
    for (const second of [-20, 0, 20, 40, 60, 80, 100, 110, 120, 140]) {
      await heartbeat({ schoolId, studentId: student, at: start + second * 1000, url: "https://lesson.example.test/", category: "educational" });
    }
    const window = rollup.classpilotUsageRollupDay(date, TIME_ZONE);
    const result = await rollup.rollupClasspilotUsageDay(system, { schoolId, day: window, windowEndUtc: window.dayEndUtc, exclusions: [] });
    assert.deepEqual([result.seconds, result.heartbeatCount], [140, 10]);
    const actual = await rows(schoolId);
    const bySession = Object.fromEntries(actual.map(row => [row.session_id ?? "unattributed", [row.seconds, row.heartbeat_count]]));
    assert.deepEqual(bySession, {
      [sessions[0].id]: [45, 3], [sessions[1].id]: [10, 1],
      [sessions[2].id]: [40, 3], [sessions[3].id]: [15, 1], unattributed: [30, 2],
    });
  });

  it("keeps newest AI ties, school ownership and teacher intent isolated in each student timeline", async () => {
    const schoolId = await createSchool("Student AI lookup", "720");
    const studentA = await createStudent(schoolId, "AI A"), studentB = await createStudent(schoolId, "AI B");
    const date = schoolTime.addLocalDays(schoolTime.localDateInTimeZone(new Date(), TIME_ZONE), -2);
    const window = rollup.classpilotUsageRollupDay(date, TIME_ZONE);
    const start = window.dayStartUtc.getTime() + 9 * 3600_000;
    const tied = await heartbeat({ schoolId, studentId: studentA, at: start, url: "https://lesson.example.test/", category: "educational" });
    const exempt = await heartbeat({ schoolId, studentId: studentA, at: start + 20_000, url: "https://lesson.example.test/", category: "non-educational" });
    const fallback = await heartbeat({ schoolId, studentId: studentB, at: start, url: "https://lesson.example.test/", category: "educational" });
    const decisionAt = wall(start + 60_000);
    await system.query(`INSERT INTO classpilot_ai_decisions(id,school_id,heartbeat_id,category,teacher_intent_source,created_at) VALUES
      ($1,$2,$3,'educational',NULL,$4::timestamp),
      ($5,$2,$3,'non-educational',NULL,$4::timestamp),
      ($6,$7,$3,'educational',NULL,$8::timestamp),
      ($9,$2,$10,'non-educational','flight_path',$4::timestamp),
      ($11,$2,$12,'non-educational',NULL,$13::timestamp)`,
      [`a-${randomUUID()}`, schoolId, tied, decisionAt, `z-${randomUUID()}`, randomUUID(), O.schoolId,
        wall(start + 120_000), randomUUID(), exempt, randomUUID(), fallback, wall(window.dayStartUtc.getTime() - 1000)]);
    const result = await rollup.rollupClasspilotUsageDay(system, { schoolId, day: window, windowEndUtc: window.dayEndUtc, exclusions: [] });
    assert.deepEqual([result.seconds, result.heartbeatCount], [45, 3]);
    const byStudentCategory = Object.fromEntries((await rows(schoolId)).map(row => [`${row.student_id}:${row.classification}`, [row.seconds, row.heartbeat_count]]));
    assert.deepEqual(byStudentCategory, {
      [`${studentA}:non-educational`]: [15, 1], [`${studentA}:educational`]: [15, 1], [`${studentB}:educational`]: [15, 1],
    });
  });

  it("matches the frozen attribution query for empty/nonempty guards, interval clipping and an AI snapshot race", async () => {
    const schoolId = await createSchool("Fast-path reference", "720");
    const a = await createStudent(schoolId, "Guard A"), b = await createStudent(schoolId, "Guard B");
    const date = schoolTime.addLocalDays(schoolTime.localDateInTimeZone(new Date(), TIME_ZONE), -2);
    const day = rollup.classpilotUsageRollupDay(date, TIME_ZONE), start = day.dayStartUtc.getTime() + 9 * 3600_000;
    const beats = [];
    for (const seconds of [0, 10, 25]) beats.push(await heartbeat({ schoolId, studentId: a, at: start + seconds * 1000, url: "https://a.example.test/", category: "educational" }));
    await heartbeat({ schoolId, studentId: b, at: start + 20_000, url: "https://b.example.test/", category: "educational" });
    // Neither a newer foreign-school decision nor a stale own-school decision
    // makes the exact school/window presence probe eligible.
    await system.query(`INSERT INTO classpilot_ai_decisions(id,school_id,heartbeat_id,category,created_at) VALUES
      ($1,$2,$3,'non-educational',$4::timestamp),($5,$6,$3,'non-educational',$7::timestamp)`,
      [randomUUID(), O.schoolId, beats[0], wall(start + 120_000), randomUUID(), schoolId, wall(day.dayStartUtc.getTime() - 1000)]);
    const client = await system.connect();
    const compare = async (cutoff = day.dayEndUtc.getTime(), exclusions: unknown[] = []) => {
      const values = [schoolId, wall(day.dayStartUtc.getTime()), wall(cutoff), date, JSON.stringify(exclusions)];
      const expected = (await client.query(attributionReference, values)).rows;
      const actual = (await client.query(readonlyGrains(), values)).rows;
      assert.deepEqual(actual, expected);
      return { seconds: actual.reduce((sum, row) => sum + row.seconds, 0), heartbeats: actual.reduce((sum, row) => sum + row.heartbeat_count, 0), rows: actual };
    };
    try {
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const empty = await compare();
      assert.deepEqual([empty.seconds, empty.heartbeats], [55, 4]);
      await system.query(`INSERT INTO classpilot_ai_decisions(school_id,heartbeat_id,category,created_at) VALUES($1,$2,'non-educational',$3::timestamp)`, [schoolId, beats[0], wall(start + 60_000)]);
      assert.deepEqual((await compare()).rows, empty.rows, "a concurrent decision cannot change the presence probe or newest lookup inside one snapshot");
      await client.query("COMMIT");
      await system.query(`INSERT INTO classpilot_ai_decisions(id,school_id,heartbeat_id,category,teacher_intent_source,created_at) VALUES
        ($1,$2,$3,'educational',NULL,$4::timestamp),($5,$2,$3,'non-educational',NULL,$4::timestamp),
        ($6,$2,$7,'non-educational','flight_path',$4::timestamp)`,
        [`a-${randomUUID()}`, schoolId, beats[1], wall(start + 60_000), `z-${randomUUID()}`, randomUUID(), beats[2]]);
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const nonempty = await compare();
      assert.equal(nonempty.rows.filter(row => row.classification === "non-educational").reduce((sum, row) => sum + row.seconds, 0), 25);
      assert.deepEqual([nonempty.seconds, nonempty.heartbeats], [55, 4]);
      assert.deepEqual([(await compare(start + 12_000)).seconds, (await compare(start + 12_000)).heartbeats], [12, 2]);
      assert.equal((await compare(start)).heartbeats, 0, "empty observation window still has no grains");
      const ownOff = { studentId: a, start: wall(start + 5000), end: wall(start + 12_000) };
      assert.deepEqual([(await compare(undefined, [ownOff])).seconds, (await compare(undefined, [ownOff])).heartbeats], [35, 3]);
      assert.equal((await compare(undefined, [{ ...ownOff, studentId: O.o1 }])).seconds, 55, "an unrelated student's interval cannot exclude either local student");
      assert.equal((await compare(undefined, [ownOff, { start: wall(start + 30_000), end: wall(start + 40_000) }])).seconds, 20);
      await client.query("COMMIT");
    } finally { await client.query("ROLLBACK"); client.release(); }
  });

  it("matches frozen all-scope report results and retains one snapshot across a concurrent completed rewrite", async () => {
    const schoolId = await createSchool("Report preaggregation", "720");
    const teacher = await createUser(schoolId, "teacher", "report-reference");
    const a = await createStudent(schoolId, "Report A", "6"), b = await createStudent(schoolId, "Report B", "7"), c = await createStudent(schoolId, "Report C", "6"), d = await createStudent(schoolId, "Zero-second D", "6");
    const classes = [randomUUID(), randomUUID()] as const;
    await createAdminClasses(schoolId, teacher.id, classes.map(id => ({ id, name: "Reference" })));
    const from = schoolTime.addLocalDays(schoolTime.localDateInTimeZone(new Date(), TIME_ZONE), -4);
    const dates = [from, schoolTime.addLocalDays(from, 1), schoolTime.addLocalDays(from, 2), schoolTime.addLocalDays(from, 3)] as const;
    for (const date of [dates[0], dates[3]]) {
      for (let domain = 0; domain < 16; domain++) await system.query("INSERT INTO classpilot_usage_rollups(school_id,usage_date,student_id,class_id,domain,classification,seconds,heartbeat_count) VALUES($1,$2,$3,$4,$5,'educational',12,1)", [schoolId, date, a, classes[0], `lesson-${domain}.example.test`]);
      await system.query(`INSERT INTO classpilot_usage_rollups(school_id,usage_date,student_id,class_id,domain,classification,seconds,heartbeat_count) VALUES
        ($1,$2,$3,$4,'games.example.test','non-educational',13,2),($1,$2,$3,$4,'','educational',7,1),
        ($1,$2,$3,$4,'unknown.example.test','unknown',0,1),($1,$2,$5,$6,'lesson-0.example.test','educational',12,1)`, [schoolId, date, b, classes[1], c, classes[0]]);
      await system.query("INSERT INTO classpilot_usage_rollups(school_id,usage_date,student_id,domain,classification,seconds,heartbeat_count) VALUES($1,$2,$3,'','unknown',0,1)", [schoolId, date, d]);
    }
    await system.query("INSERT INTO classpilot_usage_rollups(school_id,usage_date,student_id,domain,classification,seconds,heartbeat_count) VALUES($1,$2,$3,'withheld.example.test','educational',999,1)", [schoolId, dates[2], a]);
    for (const date of [dates[0], dates[1], dates[3]]) {
      const day = rollup.classpilotUsageRollupDay(date, TIME_ZONE);
      const final = date !== dates[0];
      await system.query(rollup.CLASSPILOT_USAGE_ROLLUP_COMPLETE_SQL, [schoolId, date, day.dayStartUtc.toISOString(), day.dayEndUtc.toISOString(), new Date(day.dayEndUtc.getTime() - (final ? 0 : 3600_000)).toISOString(), final]);
    }
    const read = await import("../src/services/classpilotUsageRead.js"), dialect = new PgDialect(), client = await system.connect(), now = new Date();
    const transaction = { execute(statement: SQL) { const query = dialect.sqlToQuery(statement); return client.query(query.sql, query.params); } };
    const compare = async (scope: "school" | "grade" | "class" | "student", id: string | null, studentIds: string[] | null, classId: string | null) => {
      const reference = (await client.query(reportReference, [schoolId, from, dates[3], 10, studentIds, classId])).rows;
      const actual = await read.getClasspilotDigitalUsage({ schoolId, scope, id, from, to: dates[3], now, transaction: transaction as never });
      assert.deepEqual(actual.totals, referenceTotals(reference.find(row => Number(row.total_row) === 1)));
      assert.deepEqual(actual.range.unavailableDates, [dates[2]]);
      for (const day of actual.byDay) {
        const { date, state: _state, ...totals } = day;
        assert.deepEqual(totals, referenceTotals(reference.find(row => row.usage_date === date)));
      }
      for (const [classification, field] of [["educational", "topEducationalDomains"], ["non-educational", "topNonEducationalDomains"]] as const) {
        assert.deepEqual(actual[field], reference.filter(row => row.row_kind === "domain" && row.classification === classification).map(row => ({ domain: row.domain, seconds: Number(row.seconds) })));
      }
      return actual;
    };
    try {
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const before = await compare("school", null, null, null);
      assert.equal(before.totals.activeMonitoredStudents, 4, "zero-second observation grains still count their student");
      await compare("grade", "6", [a, c, d], null); await compare("class", classes[0], null, classes[0]); await compare("student", a, [a], null);
      await heartbeat({ schoolId, studentId: a, at: schoolTime.localDateStartUtc(from, TIME_ZONE).getTime() + 10 * 3600_000, url: "https://changed.example.test/", category: "educational" });
      const day = rollup.classpilotUsageRollupDay(from, TIME_ZONE);
      await rollup.rollupClasspilotUsageDay(system, { schoolId, day, windowEndUtc: day.dayEndUtc, exclusions: [] });
      assert.deepEqual(await compare("school", null, null, null), before, "metadata, summary and domains remain in the already pinned read snapshot");
      await client.query("COMMIT");
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      assert.notEqual((await compare("school", null, null, null)).totals.monitoredBrowserSeconds, before.totals.monitoredBrowserSeconds);
      await client.query("COMMIT");
    } finally { await client.query("ROLLBACK"); client.release(); }
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
    const snapshotDay = rollup.classpilotUsageRollupDay(today, TIME_ZONE);
    await system.query(rollup.CLASSPILOT_USAGE_ROLLUP_COMPLETE_SQL, [S.schoolId, today,
      snapshotDay.dayStartUtc.toISOString(), snapshotDay.dayEndUtc.toISOString(), new Date().toISOString(), false]);
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
    assert.equal((await system.query("SELECT 1 FROM classpilot_usage_rollup_days WHERE school_id = $1", [S.schoolId])).rowCount, 0);
  });
});

describe("computation coverage ledger (DB lane)", { concurrency: false }, () => {
  it("serializes concurrent old and new live cutoffs without losing the newer activity", async () => {
    const schoolId = await createSchool("Concurrent", "720");
    const studentId = await createStudent(schoolId, "Concurrent");
    const day = rollup.classpilotUsageRollupDay("2026-09-14", TIME_ZONE);
    await heartbeat({ schoolId, studentId, at: day.dayStartUtc.getTime() + 2.5 * 3600_000, url: "https://new.example.edu", category: "educational" });
    const older = new Date(day.dayStartUtc.getTime() + 2 * 3600_000);
    const newer = new Date(day.dayStartUtc.getTime() + 3 * 3600_000);
    await Promise.all([newer, older].map((windowEndUtc) => rollup.rollupClasspilotUsageDay(system, { schoolId, day, windowEndUtc, exclusions: [] })));
    const ledger = await system.query("SELECT processed_through FROM classpilot_usage_rollup_days WHERE school_id=$1", [schoolId]);
    assert.equal(ledger.rows[0].processed_through.getTime(), newer.getTime());
    assert.equal((await rows(schoolId))[0]?.seconds, 15);
  });
  it("records empty DST days with their real windows and reports verified zeros", async () => {
    const schoolId = await createSchool("Empty DST", "8760");
    const read = await import("../src/services/classpilotUsageRead.js");
    for (const [date, hours] of [["2026-03-08", 23], ["2026-11-01", 25]] as const) {
      const day = rollup.classpilotUsageRollupDay(date, TIME_ZONE);
      assert.deepEqual(await rollup.rollupClasspilotUsageDay(system, { schoolId, day, windowEndUtc: day.dayEndUtc, exclusions: [] }),
        { rowCount: 0, seconds: 0, heartbeatCount: 0 });
      const ledger = await system.query("SELECT *, EXTRACT(EPOCH FROM (day_end_at-day_start_at))/3600 AS hours FROM classpilot_usage_rollup_days WHERE school_id=$1 AND usage_date=$2::date", [schoolId, date]);
      assert.equal(Number(ledger.rows[0].hours), hours);
      assert.equal(ledger.rows[0].is_final, true);
      assert.equal(ledger.rows[0].processed_through.getTime(), day.dayEndUtc.getTime());
      const result = await read.getClasspilotDigitalUsage({ schoolId, scope: "school", id: null, from: date, to: date, now: new Date(day.dayEndUtc.getTime() + 3600_000) });
      assert.equal(result.dataState, "final");
      assert.equal(result.byDay.length, 1);
      assert.equal(result.byDay[0]?.monitoredBrowserSeconds, 0);
      assert.equal(result.range.computedDays, 1);
    }
  });

  it("rolls back both aggregates and completion if completion fails", async () => {
    const schoolId = await createSchool("Atomic", "720");
    const studentId = await createStudent(schoolId, "Atomic");
    const day = rollup.classpilotUsageRollupDay("2026-09-14", TIME_ZONE);
    await heartbeat({ schoolId, studentId, at: day.dayStartUtc.getTime() + 3600_000, url: "https://a.example.edu", category: "educational" });
    const firstCutoff = new Date(day.dayStartUtc.getTime() + 2 * 3600_000);
    await rollup.rollupClasspilotUsageDay(system, { schoolId, day, windowEndUtc: firstCutoff, exclusions: [] });
    const beforeRows = await rows(schoolId);
    const coverage = async () => (await system.query("SELECT processed_through, computed_at, is_final FROM classpilot_usage_rollup_days WHERE school_id=$1", [schoolId])).rows;
    const beforeCoverage = await coverage();
    const failingPool: Parameters<typeof rollup.rollupClasspilotUsageDay>[0] = {
      query: (text, values) => system.query(text, values),
      async connect() {
        const client = await system.connect();
        return { async query(text, values) {
          if (text === rollup.CLASSPILOT_USAGE_ROLLUP_COMPLETE_SQL) throw new Error("completion failed");
          return client.query(text, values);
        }, release(error) { client.release(error); } };
      },
    };
    await assert.rejects(rollup.rollupClasspilotUsageDay(failingPool, { schoolId, day, windowEndUtc: day.dayEndUtc, exclusions: [] }), /completion failed/);
    assert.deepEqual(await rows(schoolId), beforeRows);
    assert.deepEqual(await coverage(), beforeCoverage);
    await rollup.rollupClasspilotUsageDay(system, { schoolId, day, windowEndUtc: day.dayEndUtc, exclusions: [] });
    const finalCoverage = await coverage();
    await rollup.rollupClasspilotUsageDay(system, { schoolId, day, windowEndUtc: firstCutoff, exclusions: [] });
    assert.deepEqual(await coverage(), finalCoverage, "a stale queue cannot regress the final cutoff");
  });

  it("invalidates only the affected school/day when an incompatible writer changes aggregates", async () => {
    const schoolId = await createSchool("Invalidation", "720");
    const studentId = await createStudent(schoolId, "Invalidation");
    const day = rollup.classpilotUsageRollupDay("2026-09-14", TIME_ZONE);
    const adjacent = rollup.classpilotUsageRollupDay("2026-09-15", TIME_ZONE);
    await heartbeat({ schoolId, studentId, at: day.dayStartUtc.getTime() + 3600_000, url: "https://a.example.edu", category: "educational" });
    const compute = () => rollup.rollupClasspilotUsageDay(system, { schoolId, day, windowEndUtc: day.dayEndUtc, exclusions: [] });
    await compute();
    await rollup.rollupClasspilotUsageDay(system, { schoolId, day: adjacent, windowEndUtc: adjacent.dayEndUtc, exclusions: [] });
    const dates = async () => (await system.query("SELECT usage_date::text AS date FROM classpilot_usage_rollup_days WHERE school_id=$1 ORDER BY usage_date", [schoolId])).rows.map((row) => row.date);
    await system.query("UPDATE classpilot_usage_rollups SET seconds=0 WHERE school_id=$1", [schoolId]);
    assert.deepEqual(await dates(), [adjacent.date]);
    await compute();
    await system.query("INSERT INTO classpilot_usage_rollups(school_id,usage_date,student_id,domain,classification,seconds,heartbeat_count) VALUES($1,$2::date,$3,'legacy.example','unknown',1,1)", [schoolId, day.date, studentId]);
    assert.deepEqual(await dates(), [adjacent.date]);
    await compute();
    await system.query("DELETE FROM classpilot_usage_rollups WHERE school_id=$1 AND usage_date=$2::date", [schoolId, day.date]);
    assert.deepEqual(await dates(), [adjacent.date]);
    // Expired empty days also need explicit ledger retention cleanup.
    await system.query("WITH removed AS (DELETE FROM classpilot_usage_rollups WHERE school_id=$1 AND usage_date<$2::date) DELETE FROM classpilot_usage_rollup_days WHERE school_id=$1 AND usage_date<$2::date", [schoolId, "2026-09-16"]);
    assert.deepEqual(await dates(), []);
  });

  it("preserves coverage of retained rows across student CASCADE and class/session SET NULL", async () => {
    const schoolId = await createSchool("Retained coverage", "720");
    const removedStudent = await createStudent(schoolId, "Removed");
    const remainingStudent = await createStudent(schoolId, "Remaining");
    const teacher = await createUser(schoolId, "teacher", "cascade-teacher");
    const classId = randomUUID(), sessionGroupId = randomUUID(), sessionId = randomUUID();
    await createAdminClasses(schoolId, teacher.id, [classId, sessionGroupId].map(id => ({ id, name: "Retained" })));
    await system.query("INSERT INTO teaching_sessions(id,school_id,group_id,teacher_id,start_time,end_time) VALUES($1,$2,$3,$4,'2026-09-14 12:00:00','2026-09-14 13:00:00')", [sessionId, schoolId, sessionGroupId, teacher.id]);
    const day = rollup.classpilotUsageRollupDay("2026-09-14", TIME_ZONE);
    await system.query("INSERT INTO classpilot_usage_rollups(school_id,usage_date,student_id,class_id,session_id,domain,classification,seconds,heartbeat_count) VALUES($1,$2::date,$3,NULL,NULL,'removed.example','unknown',15,1),($1,$2::date,$4,$5,$6,'retained.example','educational',30,2)", [schoolId, day.date, removedStudent, remainingStudent, classId, sessionId]);
    await system.query(rollup.CLASSPILOT_USAGE_ROLLUP_COMPLETE_SQL, [schoolId, day.date, day.dayStartUtc.toISOString(), day.dayEndUtc.toISOString(), day.dayEndUtc.toISOString(), true]);
    const ledger = async () => (await system.query("SELECT processed_through,computed_at,is_final FROM classpilot_usage_rollup_days WHERE school_id=$1", [schoolId])).rows;
    const completed = await ledger();
    await system.query("DELETE FROM students WHERE school_id=$1 AND id=$2", [schoolId, removedStudent]);
    assert.deepEqual(await ledger(), completed);
    assert.deepEqual((await rows(schoolId)).map((row) => row.student_id), [remainingStudent]);
    await system.query("DELETE FROM groups WHERE school_id=$1 AND id=$2", [schoolId, classId]);
    assert.deepEqual(await ledger(), completed);
    assert.equal((await rows(schoolId))[0]?.class_id, null);
    await system.query("DELETE FROM teaching_sessions WHERE school_id=$1 AND id=$2", [schoolId, sessionId]);
    assert.deepEqual(await ledger(), completed);
    assert.equal((await rows(schoolId))[0]?.session_id, null);
    const read = await import("../src/services/classpilotUsageRead.js");
    const report = await read.getClasspilotDigitalUsage({ schoolId, scope: "school", id: null, from: day.date, to: day.date, now: new Date("2026-09-16T12:00:00Z") });
    assert.equal(report.dataState, "final");
    assert.equal(report.totals.monitoredBrowserSeconds, 30);
    assert.equal(report.totals.activeMonitoredStudents, 1);
  });
});
