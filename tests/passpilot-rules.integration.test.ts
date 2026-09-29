import { after, afterEach, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Client } from "pg";
import { getTableColumns } from "drizzle-orm";
import type { KioskSession } from "../src/schema/passpilot.js";

// Rules evaluate only with the mode on AND the bundle RLS-admitted in this
// process. This DB-lane file runs as the database owner, so the admission
// variables change request binding only; tenant assertions live in the RLS lane.
const RULE_TABLES = [
  "passpilot_destination_policies",
  "passpilot_pass_limits",
  "passpilot_encounter_restrictions",
  "passpilot_pass_denials",
];
process.env.REDIS_URL = "";
process.env.NODE_ENV = "test";
process.env.PASSPILOT_RULES_MODE = "on";
process.env.RLS_GUC_ENABLED = "true";
process.env.RLS_ENABLED_TABLES = RULE_TABLES.join(",");

const PIN = "4321";
const TIME_ZONE = "America/Los_Angeles";
const TAG = `pp_rules_${Date.now()}`;

let pool: typeof import("../src/db.js").pool;
let sessionPool: typeof import("../src/db.js").sessionPool;
let runWithTenantContext: typeof import("../src/middleware/tenantContext.js").runWithTenantContext;
let signUserToken: typeof import("../src/services/jwt.js").signUserToken;
let executeTool: typeof import("../src/services/chatToolExecutor.js").executeTool;
let storage: typeof import("../src/services/storage.js");
let kioskService: typeof import("../src/services/passpilotKioskAssignments.js");
let rules: typeof import("../src/services/passpilotRules.js");
let schema: typeof import("../src/schema/passpilot.js");
let migration: typeof import("../src/db/passpilotRulesMigration.js");
let server: Server | undefined;
let baseUrl: string;

type Person = { id: string; email: string };
type ApiResult = { status: number; body: any };

const schoolIds: string[] = [];
const userIds: string[] = [];
const L = {
  schoolId: "", admin: { id: "", email: "" }, teacher: { id: "", email: "" }, office: { id: "", email: "" },
  gradeA: "", gradeB: "", students: [] as string[], session: undefined as KioskSession | undefined,
};
const C = { schoolId: "", admin: { id: "", email: "" }, teacher: { id: "", email: "" }, groupId: "", students: [] as string[] };
const B = { schoolId: "", admin: { id: "", email: "" }, gradeId: "", students: [] as string[] };

function inSchool<T>(schoolId: string, fn: () => Promise<T>): Promise<T> {
  return runWithTenantContext({ schoolId }, fn);
}

function sqlTimestamp(date: Date): string {
  return date.toISOString().replace("T", " ").replace("Z", "");
}

async function createSchool(options: { name: string; source: "legacy_grades" | "classpilot_groups"; pinHash: string; timezone?: string }) {
  const schoolId = randomUUID();
  schoolIds.push(schoolId);
  await pool.query(
    `INSERT INTO schools(id, name, status, is_active, plan_status, school_timezone, kiosk_enabled, kiosk_pin_hash, default_pass_duration)
     VALUES ($1, $2, 'active', true, 'active', $3, true, $4, 5)`,
    [schoolId, `${TAG} ${options.name}`, options.timezone ?? TIME_ZONE, options.pinHash],
  );
  for (const product of ["PASSPILOT", "CLASSPILOT"]) {
    await pool.query("INSERT INTO product_licenses(school_id, product, status) VALUES ($1, $2, 'active')", [schoolId, product]);
  }
  await pool.query(
    `INSERT INTO settings(school_id, school_name, ws_shared_key, passpilot_class_source, enable_tracking_hours, instructional_calendar, school_timezone)
     VALUES ($1, $2, 'fixture', $3, false, '{}', $4)`,
    [schoolId, `${TAG} ${options.name}`, options.source, options.timezone ?? TIME_ZONE],
  );
  return schoolId;
}

async function createUser(schoolId: string, role: string, label: string): Promise<Person> {
  const id = randomUUID();
  const email = `${TAG}-${label}-${id.slice(0, 8)}@example.test`;
  userIds.push(id);
  await pool.query("INSERT INTO users(id, email, first_name, last_name) VALUES ($1, $2, $3, 'Rules')", [id, email, label]);
  await pool.query("INSERT INTO school_memberships(school_id, user_id, role, status) VALUES ($1, $2, $3, 'active')", [schoolId, id, role]);
  return { id, email };
}

async function createStudent(schoolId: string, name: string, gradeId: string | null): Promise<string> {
  const id = randomUUID();
  await pool.query(
    "INSERT INTO students(id, school_id, first_name, last_name, status, student_id_number, grade_id) VALUES ($1, $2, $3, 'Student', 'active', $4, $5)",
    [id, schoolId, name, id.slice(0, 8), gradeId],
  );
  if (gradeId) {
    await pool.query("INSERT INTO passpilot_grade_students(school_id, grade_id, student_id) VALUES ($1, $2, $3)", [schoolId, gradeId, id]);
  }
  return id;
}

async function seedPass(options: {
  schoolId: string; studentId: string; destination?: string; status?: "active" | "returned" | "canceled";
  issuedAt: Date; gradeId?: string | null; classpilotGroupId?: string | null;
}) {
  const status = options.status ?? "returned";
  await pool.query(
    `INSERT INTO passes(school_id, student_id, grade_id, classpilot_group_id, destination, status, issued_at, duration, expires_at, returned_at, issued_via)
     VALUES ($1, $2, $3, $4, $5, $6, $7::timestamp, 5, $8::timestamp, $9::timestamp, 'teacher')`,
    [
      options.schoolId, options.studentId, options.gradeId ?? null, options.classpilotGroupId ?? null,
      options.destination ?? "bathroom", status, sqlTimestamp(options.issuedAt),
      sqlTimestamp(new Date(options.issuedAt.getTime() + 5 * 60_000)),
      status === "returned" ? sqlTimestamp(new Date(options.issuedAt.getTime() + 60_000)) : null,
    ],
  );
}

function staffHeaders(user: Person, schoolId: string): Record<string, string> {
  return {
    authorization: `Bearer ${signUserToken({ userId: user.id, email: user.email, isSuperAdmin: false })}`,
    "x-school-id": schoolId,
    "x-passpilot-class-model": "classpilot-groups-v1",
  };
}

async function call(method: string, path: string, headers: Record<string, string>, body?: unknown): Promise<ApiResult> {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { "content-type": "application/json", ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

const admin = (method: string, path: string, body?: unknown, school: { schoolId: string; admin: Person } = L) =>
  call(method, `/passpilot/admin/rules${path}`, staffHeaders(school.admin, school.schoolId), body);

function issue(user: Person, studentId: string, destination = "bathroom", extra: Record<string, unknown> = {}) {
  return call("POST", "/passpilot/passes", staffHeaders(user, L.schoolId), { studentId, gradeId: L.gradeA, destination, ...extra });
}

function kioskCheckout(studentId: string, destination = "bathroom", extra: Record<string, unknown> = {}) {
  return call("POST", "/passpilot/kiosk/checkout", { "x-school-id": L.schoolId, "x-kiosk-pin": PIN },
    { studentId, classId: L.gradeA, destination, ...extra });
}

function activityHeaders(): Record<string, string> {
  return {
    "x-school-id": L.schoolId,
    "x-kiosk-pin": PIN,
    "x-kiosk-session": L.session!.id,
    "x-passpilot-class-model": "classpilot-groups-v1",
    "x-passpilot-kiosk-activity": "scheduled-activities-v1",
  };
}

async function activityCheckout(studentId: string, destination = "bathroom"): Promise<ApiResult> {
  const snapshot = await call("GET", "/passpilot/kiosk/snapshot", activityHeaders());
  assert.equal(snapshot.status, 200, JSON.stringify(snapshot.body));
  assert.equal(typeof snapshot.body.assignmentRevision, "string");
  return call("POST", "/passpilot/kiosk/checkout", activityHeaders(), {
    studentId, destination, assignmentRevision: snapshot.body.assignmentRevision,
  });
}

function assistantIssue(studentId: string, destination = "bathroom", extra: Record<string, unknown> = {}) {
  return inSchool(L.schoolId, () => executeTool("issue_pass", { studentId, classId: L.gradeA, destination, ...extra }, {
    userId: L.teacher.id,
    schoolId: L.schoolId,
    schoolName: "Rules fixture",
    userName: "Rules teacher",
    userRole: "teacher",
    licensedProducts: ["PASSPILOT"],
    getTranscript: () => "",
  }));
}

async function denials(schoolId: string, studentId?: string): Promise<any[]> {
  const result = await pool.query(
    `SELECT * FROM passpilot_pass_denials WHERE school_id = $1 AND ($2::text IS NULL OR student_id = $2) ORDER BY denied_at, id`,
    [schoolId, studentId ?? null],
  );
  return result.rows;
}

async function activePassCount(schoolId: string, studentId: string): Promise<number> {
  const result = await pool.query("SELECT count(*)::int AS count FROM passes WHERE school_id = $1 AND student_id = $2 AND status = 'active'", [schoolId, studentId]);
  return result.rows[0].count;
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

function localDate(now = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

/** A bell schedule whose two periods cover the whole local day except its final minute. */
async function installBellSchedule(schoolId: string) {
  const today = localDate();
  const config = {
    schemaVersion: 1, yearStart: null, yearEnd: null, cycleAnchorDate: null, cycleAnchorDay: "A",
    periods: [{ id: "morning", name: "Morning block" }, { id: "afternoon", name: "Afternoon block" }],
    profiles: [{ id: "std", name: "Standard", periods: {
      morning: { startTime: "00:00", endTime: "12:00" }, afternoon: { startTime: "12:00", endTime: "23:59" },
    } }],
    defaultProfileId: "std", weekdayProfiles: {}, dateOverrides: { [today]: { instructional: true } },
    scheduleProfiles: [], profileApplications: [],
  };
  await pool.query(
    `INSERT INTO classpilot_school_schedules(school_id, revision, config) VALUES ($1, 1, $2::jsonb)
     ON CONFLICT (school_id) DO UPDATE SET config = EXCLUDED.config, revision = classpilot_school_schedules.revision + 1`,
    [schoolId, JSON.stringify(config)],
  );
  const day = rules.resolvePasspilotRuleDay(new Date(), TIME_ZONE);
  return rules.selectBellPeriod(config, { instructional: true, profileId: "std" }, day.localDate, TIME_ZONE, new Date());
}

async function waitForAdvisoryWaiters(client: Client, expected: number): Promise<void> {
  for (let attempt = 0; attempt < 150; attempt += 1) {
    const result = await client.query(`
      SELECT count(*)::int AS waiting FROM pg_locks
      WHERE locktype = 'advisory' AND NOT granted
        AND database = (SELECT oid FROM pg_database WHERE datname = current_database())`);
    if ((result.rows[0]?.waiting ?? 0) >= expected) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(`Timed out waiting for ${expected} PassPilot issuance lock waiters`);
}

before(async () => {
  assert.ok(["localhost", "127.0.0.1", "::1"].includes(new URL(process.env.DATABASE_URL || "").hostname), "Only a local fixture database is permitted");
  const dbModule = await import("../src/db.js");
  pool = dbModule.pool;
  sessionPool = dbModule.sessionPool;
  ({ runWithTenantContext } = await import("../src/middleware/tenantContext.js"));
  ({ signUserToken } = await import("../src/services/jwt.js"));
  ({ executeTool } = await import("../src/services/chatToolExecutor.js"));
  storage = await import("../src/services/storage.js");
  kioskService = await import("../src/services/passpilotKioskAssignments.js");
  rules = await import("../src/services/passpilotRules.js");
  schema = await import("../src/schema/passpilot.js");
  migration = await import("../src/db/passpilotRulesMigration.js");
  const { hashPassword } = await import("../src/util/password.js");

  // A pushed schema makes CREATE TABLE IF NOT EXISTS a no-op; the SQL still
  // installs forced RLS and the policies exactly as production does.
  await pool.query(migration.PASSPILOT_RULES_SQL);
  const pinHash = await hashPassword(PIN);

  L.schoolId = await createSchool({ name: "Legacy", source: "legacy_grades", pinHash });
  L.admin = await createUser(L.schoolId, "school_admin", "admin");
  L.teacher = await createUser(L.schoolId, "teacher", "teacher");
  L.office = await createUser(L.schoolId, "office_staff", "office");
  L.gradeA = randomUUID();
  L.gradeB = randomUUID();
  await pool.query("INSERT INTO grades(id, school_id, name) VALUES ($1, $2, 'Math A'), ($3, $2, 'Reading B')", [L.gradeA, L.schoolId, L.gradeB]);
  await pool.query("INSERT INTO teacher_grades(teacher_id, grade_id) VALUES ($1, $2), ($1, $3)", [L.teacher.id, L.gradeA, L.gradeB]);
  await pool.query("UPDATE schools SET kiosk_grade_id = $2 WHERE id = $1", [L.schoolId, L.gradeA]);
  for (let index = 0; index < 8; index += 1) L.students.push(await createStudent(L.schoolId, `Legacy${index}`, L.gradeA));
  L.session = await inSchool(L.schoolId, () => storage.createSelfClaimedKioskSession(L.schoolId, null, { actorUserId: L.teacher.id, manager: false }));
  await inSchool(L.schoolId, () => kioskService.saveKioskPreferences({
    schoolId: L.schoolId, teacherId: L.teacher.id, actorId: L.teacher.id, expectedRevision: 0, mode: "passpilot",
    schedule: { blocks: [{ id: "all-day", classId: L.gradeA, weekdays: [0, 1, 2, 3, 4, 5, 6], startTime: "00:00", endTime: "23:59", startsOn: null, endsOn: null }], exceptions: [] },
  }));

  C.schoolId = await createSchool({ name: "Canonical", source: "classpilot_groups", pinHash });
  C.admin = await createUser(C.schoolId, "school_admin", "c-admin");
  C.teacher = await createUser(C.schoolId, "teacher", "c-teacher");
  C.groupId = randomUUID();
  await pool.query(
    "INSERT INTO groups(id, school_id, teacher_id, name, group_type, status) VALUES ($1, $2, $3, 'Biology', 'admin_class', 'active')",
    [C.groupId, C.schoolId, C.teacher.id],
  );
  for (let index = 0; index < 2; index += 1) {
    const studentId = await createStudent(C.schoolId, `Canonical${index}`, null);
    await pool.query("INSERT INTO group_students(group_id, student_id) VALUES ($1, $2)", [C.groupId, studentId]);
    C.students.push(studentId);
  }

  B.schoolId = await createSchool({ name: "Other", source: "legacy_grades", pinHash });
  B.admin = await createUser(B.schoolId, "school_admin", "b-admin");
  B.gradeId = randomUUID();
  await pool.query("INSERT INTO grades(id, school_id, name) VALUES ($1, $2, 'Other class')", [B.gradeId, B.schoolId]);
  B.students.push(await createStudent(B.schoolId, "Other0", B.gradeId));

  const { createApp } = await import("../src/app.js");
  server = createServer(createApp());
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
});

afterEach(async () => {
  for (const table of ["passpilot_pass_denials", "passpilot_encounter_restrictions", "passpilot_pass_limits", "passpilot_destination_policies",
    "student_timeline_events", "passes", "classpilot_school_schedules", "teaching_sessions"]) {
    await pool.query(`DELETE FROM ${table} WHERE school_id = ANY($1::text[])`, [schoolIds]);
  }
  await pool.query("UPDATE students SET status = 'active' WHERE school_id = ANY($1::text[])", [schoolIds]);
});

after(async () => {
  try {
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    // Best effort: a lane that installed the staff-identity contract retains
    // users and schools, which cannot be hard-deleted.
    const bestEffort = (text: string, values: unknown[]) => pool.query(text, values).catch(() => undefined);
    if (schoolIds.length) {
      for (const table of ["passpilot_pass_denials", "passpilot_encounter_restrictions", "passpilot_pass_limits", "passpilot_destination_policies",
        "student_timeline_events", "passes", "classpilot_school_schedules", "teaching_sessions", "passpilot_teacher_kiosk_settings",
        "passpilot_kiosk_sessions", "audit_logs"]) {
        await bestEffort(`DELETE FROM ${table} WHERE school_id = ANY($1::text[])`, [schoolIds]);
      }
      await bestEffort("DELETE FROM group_students WHERE group_id IN (SELECT id FROM groups WHERE school_id = ANY($1::text[]))", [schoolIds]);
      await bestEffort("DELETE FROM teacher_grades WHERE teacher_id = ANY($1::text[])", [userIds]);
      for (const table of ["passpilot_grade_students", "groups", "students", "grades", "settings", "school_memberships", "product_licenses"]) {
        await bestEffort(`DELETE FROM ${table} WHERE school_id = ANY($1::text[])`, [schoolIds]);
      }
      await bestEffort("DELETE FROM users WHERE id = ANY($1::text[])", [userIds]);
      await bestEffort("DELETE FROM schools WHERE id = ANY($1::text[])", [schoolIds]);
    }
  } finally {
    const { schedulerPool, schedulerLockPool } = await import("../src/services/schedulerDb.js");
    await Promise.allSettled([pool?.end(), sessionPool?.end(), schedulerPool.end(), schedulerLockPool.end()]);
  }
});

describe("PassPilot issuance rules (DB lane)", { concurrency: false }, () => {
  it("keeps the schema, migration and session time zone in parity", async () => {
    for (const [table, definition] of [
      ["passpilot_destination_policies", schema.passpilotDestinationPolicies],
      ["passpilot_pass_limits", schema.passpilotPassLimits],
      ["passpilot_encounter_restrictions", schema.passpilotEncounterRestrictions],
      ["passpilot_pass_denials", schema.passpilotPassDenials],
    ] as const) {
      const result = await pool.query("SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1 ORDER BY column_name", [table]);
      assert.deepEqual(result.rows.map((row) => row.column_name), Object.values(getTableColumns(definition)).map((column) => column.name).sort(), table);
    }
    const column = await pool.query("SELECT 1 FROM information_schema.columns WHERE table_name = 'passes' AND column_name = 'rule_override_code'");
    assert.equal(column.rowCount, 1);
    const indexes = await pool.query(`SELECT c.relname FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
      WHERE c.relname IN ('passes_school_student_issued_idx', 'passes_school_destination_active_idx') AND i.indisvalid ORDER BY 1`);
    assert.deepEqual(indexes.rows.map((row) => row.relname), ["passes_school_destination_active_idx", "passes_school_student_issued_idx"]);
    const forced = await pool.query("SELECT relname FROM pg_class WHERE relname = ANY($1::text[]) AND relrowsecurity AND relforcerowsecurity ORDER BY 1", [RULE_TABLES]);
    assert.deepEqual(forced.rows.map((row) => row.relname), [...RULE_TABLES].sort());
    const zone = await pool.query("SELECT current_setting('TimeZone') AS zone");
    assert.match(zone.rows[0].zone, /^(UTC|Etc\/UTC)$/, "issued_at defaults assume a UTC database session");
  });

  it("with the mode off, issuance is unchanged, override input is ignored, and the router does not exist", async () => {
    await pool.query("INSERT INTO passpilot_destination_policies(school_id, destination, max_concurrent) VALUES ($1, 'bathroom', 1)", [L.schoolId]);
    await withEnv({ PASSPILOT_RULES_MODE: "off" }, async () => {
      const first = await issue(L.teacher, L.students[0]!);
      assert.equal(first.status, 201, JSON.stringify(first.body));
      assert.equal("ruleOverrideCode" in first.body.pass, false, "off-mode pass responses carry no new key");
      const second = await issue(L.teacher, L.students[1]!, "bathroom", { overrideRuleCode: "not-a-rule" });
      assert.equal(second.status, 201, "the override field is ignored exactly as the non-strict schema did");
      for (const [method, path] of [["GET", ""], ["PUT", "/destinations/bathroom"], ["POST", "/encounters"]] as const) {
        const response = await admin(method, path, method === "GET" ? undefined : {});
        assert.equal(response.status, 404);
        assert.deepEqual(response.body, { error: "Not found" });
      }
      const unauthenticated = await call("GET", "/passpilot/admin/rules", {});
      assert.deepEqual(unauthenticated, { status: 404, body: { error: "Not found" } });
    });
    await withEnv({ RLS_ENABLED_TABLES: RULE_TABLES.slice(0, 3).join(",") }, async () => {
      assert.equal((await admin("GET", "")).status, 404, "on without full RLS admission stays off");
    });
    assert.equal((await denials(L.schoolId)).length, 0);
    const list = await call("GET", "/passpilot/passes", staffHeaders(L.admin, L.schoolId));
    assert.equal(list.status, 200);
    assert.ok(list.body.passes.length >= 2);
    for (const pass of list.body.passes) assert.equal("ruleOverrideCode" in pass, false);
  });

  it("counts the school-local day for daily limits and ignores canceled and previous-day passes", async () => {
    const [student, other] = [L.students[0]!, L.students[1]!];
    const day = rules.resolvePasspilotRuleDay(new Date(), TIME_ZONE);
    await seedPass({ schoolId: L.schoolId, studentId: student, gradeId: L.gradeA, issuedAt: new Date(day.dayStart.getTime() + 1_000) });
    await seedPass({ schoolId: L.schoolId, studentId: student, gradeId: L.gradeA, issuedAt: new Date(day.dayStart.getTime() + 2_000) });
    await seedPass({ schoolId: L.schoolId, studentId: student, gradeId: L.gradeA, issuedAt: new Date(day.dayStart.getTime() + 3_000), status: "canceled" });
    await seedPass({ schoolId: L.schoolId, studentId: student, gradeId: L.gradeA, issuedAt: new Date(day.dayStart.getTime() - 60_000) });

    const saved = await admin("PUT", "/limits/default", { dailyLimit: 2, periodLimit: null, enabled: true });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    const { dailyLimit, periodLimit, enabled } = saved.body.defaultLimits;
    assert.deepEqual({ dailyLimit, periodLimit, enabled }, { dailyLimit: 2, periodLimit: null, enabled: true });

    const denied = await issue(L.teacher, student);
    assert.equal(denied.status, 409);
    assert.deepEqual(denied.body, {
      error: "2 passes today (limit 2).",
      code: "PASSPILOT_RULE_DAILY_LIMIT",
      rule: { kind: "daily_limit", count: 2, limit: 2 },
      canOverride: false,
    });
    assert.equal(await activePassCount(L.schoolId, student), 0);
    const [row] = await denials(L.schoolId, student);
    assert.equal(row.rule_code, "PASSPILOT_RULE_DAILY_LIMIT");
    assert.equal(row.issued_via, "teacher");
    assert.equal(row.actor_user_id, L.teacher.id);
    assert.equal(row.teacher_id, L.teacher.id);
    assert.equal(row.class_source, "legacy_grades");
    assert.equal(row.grade_id, L.gradeA);
    assert.equal(row.window_kind, "day");
    assert.equal(row.overridden, false);
    assert.equal(row.details.count, 2);
    assert.equal(row.details.limit, 2);
    assert.equal(row.details.windowStartsAt, day.dayStart.toISOString());

    assert.equal((await issue(L.teacher, other)).status, 201, "another student is unaffected");
    const raised = await admin("PUT", `/limits/students/${student}`, { dailyLimit: 3, periodLimit: null, enabled: true });
    assert.equal(raised.status, 200);
    assert.equal(raised.body.studentLimits[0].studentId, student);
    assert.equal((await issue(L.teacher, student)).status, 201, "an enabled student limit overrides the school default");
  });

  it("enforces bell periods, class sessions, and kiosk blocks, and reports when periods are unenforceable", async () => {
    const [student, second] = [L.students[2]!, L.students[3]!];
    // School B: legacy classes, no bell schedule, no automatic kiosk.
    await admin("PUT", "/limits/default", { dailyLimit: null, periodLimit: 1, enabled: true }, B);
    assert.equal((await admin("GET", "", undefined, B)).body.periodEnforcement, "unavailable");

    // School L without a bell schedule: an unlinked legacy class has no period window.
    await admin("PUT", `/limits/students/${student}`, { dailyLimit: null, periodLimit: 0, enabled: true });
    assert.equal((await admin("GET", "")).body.periodEnforcement, "class_window", "an automatic kiosk can supply windows");
    const kioskBlock = await activityCheckout(student);
    assert.equal(kioskBlock.status, 409, JSON.stringify(kioskBlock.body));
    assert.deepEqual(kioskBlock.body, { error: rules.PASSPILOT_RULE_KIOSK_SEE_TEACHER_MESSAGE, code: "PASSPILOT_RULE_NOT_AVAILABLE" });
    const [blockDenial] = await denials(L.schoolId, student);
    assert.equal(blockDenial.rule_code, "PASSPILOT_RULE_PERIOD_LIMIT");
    assert.equal(blockDenial.window_kind, "kiosk_block");
    assert.equal(blockDenial.details.windowLabel, "Math A");
    assert.equal(blockDenial.issued_via, "kiosk");
    assert.equal(blockDenial.actor_user_id, null);
    assert.equal(blockDenial.teacher_id, L.teacher.id);
    assert.equal(blockDenial.issuing_kiosk_session_id, L.session!.id);
    assert.equal((await issue(L.teacher, student)).status, 201, "the teacher route has no period window here, so the limit is not enforced");

    // A bell period applies to every issuance path.
    const bell = await installBellSchedule(L.schoolId);
    if (!bell) return; // The final local minute of the day is outside both fixture periods.
    assert.equal((await admin("GET", "")).body.periodEnforcement, "bell_schedule");
    await admin("PUT", `/limits/students/${second}`, { dailyLimit: null, periodLimit: 1, enabled: true });
    await seedPass({ schoolId: L.schoolId, studentId: second, gradeId: L.gradeB, issuedAt: new Date(Math.max(bell.startsAt.getTime(), Date.now() - 60_000)) });
    const denied = await issue(L.admin, second);
    assert.equal(denied.status, 409);
    assert.equal(denied.body.code, "PASSPILOT_RULE_PERIOD_LIMIT");
    assert.deepEqual(denied.body.rule, { kind: "period_limit", count: 1, limit: 1, window: { kind: "bell_period", label: bell.label } });
    assert.equal(denied.body.error, `1 pass during ${bell.label} (limit 1).`);
    assert.equal(denied.body.canOverride, true);
  });

  it("uses the canonical class session window when no bell period applies", async () => {
    const student = C.students[0]!;
    const now = Date.now();
    await pool.query(
      `INSERT INTO teaching_sessions(group_id, teacher_id, school_id, start_time, scheduled_date, scheduled_timezone, scheduled_start_at, scheduled_end_at, scheduled_state)
       VALUES ($1, $2, $3, $4::timestamp, $5, $6, $7::timestamptz, $8::timestamptz, 'active')`,
      [C.groupId, C.teacher.id, C.schoolId, sqlTimestamp(new Date(now - 20 * 60_000)), localDate(), TIME_ZONE,
        new Date(now - 20 * 60_000).toISOString(), new Date(now + 20 * 60_000).toISOString()],
    );
    await admin("PUT", "/limits/default", { dailyLimit: null, periodLimit: 1, enabled: true }, C);
    assert.equal((await admin("GET", "", undefined, C)).body.periodEnforcement, "class_window");
    await seedPass({ schoolId: C.schoolId, studentId: student, classpilotGroupId: C.groupId, issuedAt: new Date(now - 5 * 60_000) });
    const denied = await call("POST", "/passpilot/passes", staffHeaders(C.teacher, C.schoolId), { studentId: student, classId: C.groupId, destination: "nurse" });
    assert.equal(denied.status, 409, JSON.stringify(denied.body));
    assert.equal(denied.body.code, "PASSPILOT_RULE_PERIOD_LIMIT");
    assert.deepEqual(denied.body.rule.window, { kind: "class_window", label: "Biology" });
    const [row] = await denials(C.schoolId, student);
    assert.equal(row.class_source, "classpilot_groups");
    assert.equal(row.classpilot_group_id, C.groupId);
    assert.equal(row.grade_id, null);
    assert.equal(row.window_kind, "class_window");
    // A pass issued before the session window started is outside the period.
    await pool.query("DELETE FROM passes WHERE school_id = $1", [C.schoolId]);
    await seedPass({ schoolId: C.schoolId, studentId: student, classpilotGroupId: C.groupId, issuedAt: new Date(now - 30 * 60_000) });
    const allowed = await call("POST", "/passpilot/passes", staffHeaders(C.teacher, C.schoolId), { studentId: student, classId: C.groupId, destination: "nurse" });
    assert.equal(allowed.status, 201, JSON.stringify(allowed.body));
  });

  it("caps destinations using today's active passes of active students only", async () => {
    const [first, second, third, stale] = [L.students[0]!, L.students[1]!, L.students[2]!, L.students[3]!];
    const saved = await admin("PUT", "/destinations/bathroom", { maxConcurrent: 1, enabled: true });
    assert.deepEqual(saved.body.destinationPolicies.map((policy: { destination: string; maxConcurrent: number; enabled: boolean }) =>
      [policy.destination, policy.maxConcurrent, policy.enabled]), [["bathroom", 1, true]]);
    const day = rules.resolvePasspilotRuleDay(new Date(), TIME_ZONE);
    await seedPass({ schoolId: L.schoolId, studentId: stale, gradeId: L.gradeA, issuedAt: new Date(day.dayStart.getTime() - 2 * 3_600_000), status: "active" });

    const out = await issue(L.teacher, first);
    assert.equal(out.status, 201, "a stale active pass from an earlier day does not fill today's capacity");
    const denied = await issue(L.teacher, second);
    assert.equal(denied.status, 409);
    assert.deepEqual(denied.body, {
      error: "Bathroom is at capacity (1 of 1 out).",
      code: "PASSPILOT_RULE_DESTINATION_CAPACITY",
      rule: { kind: "destination_capacity", count: 1, limit: 1, destination: "bathroom" },
      canOverride: false,
    });
    assert.equal((await issue(L.teacher, second, "nurse")).status, 201, "other destinations are unaffected");
    const custom = await issue(L.teacher, third, "custom", { customDestination: "Library" });
    assert.equal(custom.status, 201, "a custom destination has no capacity");

    await pool.query("UPDATE students SET status = 'inactive' WHERE id = $1", [first]);
    await pool.query("UPDATE passes SET status = 'returned', returned_at = now() WHERE student_id = $1", [second]);
    assert.equal((await issue(L.teacher, second)).status, 201, "a deactivated student's pass does not count");
    await pool.query("UPDATE students SET status = 'active' WHERE id = $1", [first]);
    await admin("PUT", "/destinations/bathroom", { maxConcurrent: 1, enabled: false });
    await pool.query("UPDATE passes SET status = 'returned', returned_at = now() WHERE student_id = $1", [third]);
    assert.equal((await issue(L.teacher, third)).status, 201, "a disabled policy is not enforced");
  });

  it("serializes the last capacity slot so exactly one racing issuance wins", async () => {
    const [first, second] = [L.students[4]!, L.students[5]!];
    await admin("PUT", "/destinations/bathroom", { maxConcurrent: 1, enabled: true });
    const blocker = new Client({ connectionString: process.env.DATABASE_URL });
    await blocker.connect();
    const lockKey = `passpilot-class-source:${L.schoolId}`;
    await blocker.query("SELECT pg_advisory_lock(hashtext($1))", [lockKey]);
    let attempts: Promise<ApiResult[]> | undefined;
    try {
      attempts = Promise.all([issue(L.teacher, first), issue(L.teacher, second)]);
      await waitForAdvisoryWaiters(blocker, 2);
    } finally {
      await blocker.query("SELECT pg_advisory_unlock(hashtext($1))", [lockKey]);
      await blocker.end();
    }
    const responses = await attempts!;
    assert.deepEqual(responses.map((response) => response.status).sort(), [201, 409]);
    assert.equal(responses.find((response) => response.status === 409)?.body.code, "PASSPILOT_RULE_DESTINATION_CAPACITY");
    const active = await pool.query("SELECT count(*)::int AS count FROM passes WHERE school_id = $1 AND destination = 'bathroom' AND status = 'active'", [L.schoolId]);
    assert.equal(active.rows[0].count, 1);
    assert.equal((await denials(L.schoolId)).length, 1);
  });

  it("keeps encounter restrictions symmetric, private, and limited to active students", async () => {
    const pair = [L.students[0]!, L.students[1]!].sort();
    const x = pair[0]!, y = pair[1]!;
    const created = await admin("POST", "/encounters", { studentIdA: y, studentIdB: x, reasonNote: "Keep apart" });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const [restriction] = created.body.encounterRestrictions;
    assert.equal(restriction.studentAId, x, "the pair is stored canonically");
    assert.equal(restriction.studentBId, y);
    assert.equal((await admin("POST", "/encounters", { studentIdA: x, studentIdB: y })).body.code, "PASSPILOT_RULES_ENCOUNTER_EXISTS");

    assert.equal((await issue(L.teacher, x)).status, 201);
    const teacher = await issue(L.teacher, y);
    assert.equal(teacher.status, 409);
    assert.deepEqual(teacher.body, { error: rules.PASSPILOT_RULE_NOT_AVAILABLE_MESSAGE, code: "PASSPILOT_RULE_NOT_AVAILABLE", canOverride: false });
    const office = await issue(L.office, y);
    assert.deepEqual(office.body, teacher.body, "office staff are not told that a restriction exists");
    const administrator = await issue(L.admin, y, "nurse");
    assert.equal(administrator.status, 409);
    assert.equal(administrator.body.code, "PASSPILOT_RULE_ENCOUNTER");
    assert.deepEqual(administrator.body.rule, { kind: "encounter" });
    assert.equal(administrator.body.canOverride, true);
    for (const row of await denials(L.schoolId, y)) {
      assert.equal(row.rule_code, "PASSPILOT_RULE_ENCOUNTER");
      assert.deepEqual(row.details, { restrictionId: restriction.id });
      assert.doesNotMatch(JSON.stringify(row), new RegExp(x), "a denial never stores the other student");
    }

    // Reverse direction, then disable, then a deactivated partner never blocks.
    await pool.query("UPDATE passes SET status = 'returned', returned_at = now() WHERE student_id = $1", [x]);
    assert.equal((await issue(L.teacher, y)).status, 201);
    assert.equal((await issue(L.teacher, x)).status, 409, "the restriction is symmetric");
    const disabled = await admin("PATCH", `/encounters/${restriction.id}`, { enabled: false });
    assert.equal(disabled.body.encounterRestrictions[0].enabled, false);
    assert.equal((await issue(L.teacher, x)).status, 201);
    await pool.query("UPDATE passes SET status = 'returned', returned_at = now() WHERE student_id = $1", [x]);
    await admin("PATCH", `/encounters/${restriction.id}`, { enabled: true });
    await pool.query("UPDATE students SET status = 'inactive' WHERE id = $1", [y]);
    assert.equal((await issue(L.teacher, x)).status, 201, "a deactivated partner's active pass does not block");
  });

  for (const code of ["PASSPILOT_RULE_DAILY_LIMIT", "PASSPILOT_RULE_PERIOD_LIMIT", "PASSPILOT_RULE_DESTINATION_CAPACITY", "PASSPILOT_RULE_ENCOUNTER"] as const) {
    it(`denies ${code} on the teacher, kiosk, activity kiosk and AI paths and records each denial`, async (t) => {
      const [target, other] = [L.students[6]!, L.students[7]!];
      if (code === "PASSPILOT_RULE_DAILY_LIMIT") {
        await admin("PUT", `/limits/students/${target}`, { dailyLimit: 0, periodLimit: null, enabled: true });
      } else if (code === "PASSPILOT_RULE_PERIOD_LIMIT") {
        if (!(await installBellSchedule(L.schoolId))) return t.skip("the final local minute is outside the fixture bell periods");
        await admin("PUT", `/limits/students/${target}`, { dailyLimit: null, periodLimit: 0, enabled: true });
      } else if (code === "PASSPILOT_RULE_DESTINATION_CAPACITY") {
        await admin("PUT", "/destinations/bathroom", { maxConcurrent: 1, enabled: true });
        await seedPass({ schoolId: L.schoolId, studentId: other, gradeId: L.gradeA, issuedAt: new Date(Date.now() - 60_000), status: "active" });
      } else {
        await admin("POST", "/encounters", { studentIdA: target, studentIdB: other });
        await seedPass({ schoolId: L.schoolId, studentId: other, gradeId: L.gradeA, destination: "office", issuedAt: new Date(Date.now() - 60_000), status: "active" });
      }
      const encounter = code === "PASSPILOT_RULE_ENCOUNTER";
      const capacity = code === "PASSPILOT_RULE_DESTINATION_CAPACITY";

      const teacher = await issue(L.teacher, target);
      assert.equal(teacher.status, 409, JSON.stringify(teacher.body));
      assert.equal(teacher.body.code, encounter ? "PASSPILOT_RULE_NOT_AVAILABLE" : code);
      assert.equal(teacher.body.canOverride, false);

      for (const kiosk of [await kioskCheckout(target), await activityCheckout(target)]) {
        assert.equal(kiosk.status, 409, JSON.stringify(kiosk.body));
        assert.deepEqual(Object.keys(kiosk.body).sort(), ["code", "error"], "answered directly, not through the error handler");
        assert.equal(kiosk.body.code, capacity ? code : "PASSPILOT_RULE_NOT_AVAILABLE");
        assert.equal(kiosk.body.error, capacity
          ? "Bathroom is full right now. Please try again in a few minutes."
          : rules.PASSPILOT_RULE_KIOSK_SEE_TEACHER_MESSAGE);
      }

      const assistant = await assistantIssue(target);
      assert.equal(assistant.success, false);
      assert.doesNotMatch(assistant.error ?? "", /system error/i);
      assert.equal(assistant.error, encounter ? rules.PASSPILOT_RULE_NOT_AVAILABLE_MESSAGE : teacher.body.error);

      const rows = await denials(L.schoolId, target);
      assert.deepEqual(rows.map((row) => [row.rule_code, row.issued_via]), [
        [code, "teacher"], [code, "kiosk"], [code, "kiosk"], [code, "ai"],
      ]);
      assert.equal(rows[3].actor_user_id, L.teacher.id);
      assert.equal(await activePassCount(L.schoolId, target), 0, "a denial never leaves a pass behind");
    });
  }

  it("lets only administrators override exactly one rule, and records the override three ways", async () => {
    const [target, other] = [L.students[4]!, L.students[5]!];
    await admin("PUT", `/limits/students/${target}`, { dailyLimit: 0, periodLimit: null, enabled: true });

    const teacher = await issue(L.teacher, target, "bathroom", { overrideRuleCode: "PASSPILOT_RULE_DAILY_LIMIT" });
    assert.deepEqual(teacher.body, { error: "Only administrators can override a pass rule.", code: "PASSPILOT_RULE_OVERRIDE_FORBIDDEN" });
    assert.equal(teacher.status, 403);
    assert.equal((await issue(L.office, target, "bathroom", { overrideRuleCode: "PASSPILOT_RULE_DAILY_LIMIT" })).status, 403, "office staff cannot override");
    assert.equal((await issue(L.admin, target, "bathroom", { overrideRuleCode: "PASSPILOT_RULE_NOT_AVAILABLE" })).body.code, "PASSPILOT_RULE_OVERRIDE_INVALID");
    assert.equal((await issue(L.admin, target, "bathroom", { overrideRuleCode: "PASSPILOT_RULE_PERIOD_LIMIT" })).body.code, "PASSPILOT_RULE_DAILY_LIMIT",
      "an override of an unviolated rule clears nothing");

    // Capacity is evaluated before the daily limit and is not the overridden code.
    await admin("PUT", "/destinations/bathroom", { maxConcurrent: 1, enabled: true });
    await seedPass({ schoolId: L.schoolId, studentId: other, gradeId: L.gradeA, issuedAt: new Date(Date.now() - 60_000), status: "active" });
    const stillDenied = await issue(L.admin, target, "bathroom", { overrideRuleCode: "PASSPILOT_RULE_DAILY_LIMIT" });
    assert.equal(stillDenied.status, 409);
    assert.equal(stillDenied.body.code, "PASSPILOT_RULE_DESTINATION_CAPACITY", "the remaining rules are still evaluated");

    const kiosk = await kioskCheckout(target, "nurse", { overrideRuleCode: "PASSPILOT_RULE_DAILY_LIMIT" });
    assert.equal(kiosk.status, 409, "kiosks never override");
    const assistant = await assistantIssue(target, "nurse", { overrideRuleCode: "PASSPILOT_RULE_DAILY_LIMIT" });
    assert.equal(assistant.success, false, "the assistant never overrides");

    const overridden = await issue(L.admin, target, "nurse", { overrideRuleCode: "PASSPILOT_RULE_DAILY_LIMIT" });
    assert.equal(overridden.status, 201, JSON.stringify(overridden.body));
    assert.equal(overridden.body.pass.ruleOverrideCode, "PASSPILOT_RULE_DAILY_LIMIT");
    const stored = await pool.query("SELECT rule_override_code FROM passes WHERE id = $1", [overridden.body.pass.id]);
    assert.equal(stored.rows[0].rule_override_code, "PASSPILOT_RULE_DAILY_LIMIT");
    const audit = await pool.query("SELECT user_id, entity_type, entity_id, metadata FROM audit_logs WHERE school_id = $1 AND action = 'passpilot.rule.override'", [L.schoolId]);
    assert.equal(audit.rowCount, 1);
    assert.equal(audit.rows[0].user_id, L.admin.id);
    assert.equal(audit.rows[0].entity_type, "pass");
    assert.equal(audit.rows[0].entity_id, overridden.body.pass.id);
    assert.equal(audit.rows[0].metadata.ruleCode, "PASSPILOT_RULE_DAILY_LIMIT");
    assert.equal(audit.rows[0].metadata.studentId, target);
    const overrideRows = (await denials(L.schoolId, target)).filter((row) => row.overridden);
    assert.equal(overrideRows.length, 1);
    assert.equal(overrideRows[0].rule_code, "PASSPILOT_RULE_DAILY_LIMIT");
    assert.equal(overrideRows[0].actor_user_id, L.admin.id);
    assert.equal(overrideRows[0].destination, "nurse");
  });

  it("validates, scopes, and audits every rules API write", async () => {
    const [x, y] = [L.students[0]!, L.students[1]!];
    const auditEntities = async (): Promise<string[]> => (await pool.query(
      "SELECT entity_id FROM audit_logs WHERE school_id = $1 AND action = 'passpilot.rules.update'", [L.schoolId],
    )).rows.map((row) => row.entity_id);
    const auditedBefore = await auditEntities();
    assert.equal((await call("GET", "/passpilot/admin/rules", staffHeaders(L.teacher, L.schoolId))).status, 403);
    assert.equal((await call("GET", "/passpilot/admin/rules", staffHeaders(L.office, L.schoolId))).status, 403);
    for (const [path, body] of [
      ["/destinations/custom", { maxConcurrent: 1, enabled: true }],
      ["/destinations/bathroom", { maxConcurrent: 0, enabled: true }],
      ["/destinations/bathroom", { maxConcurrent: 501, enabled: true }],
      ["/destinations/bathroom", { maxConcurrent: 1.5, enabled: true }],
      ["/destinations/bathroom", { maxConcurrent: 2, enabled: true, schoolId: B.schoolId }],
      ["/limits/default", { dailyLimit: null, periodLimit: null, enabled: true }],
      ["/limits/default", { dailyLimit: 51, periodLimit: null, enabled: true }],
      ["/limits/default", { dailyLimit: -1, periodLimit: null, enabled: true }],
      ["/limits/default", { dailyLimit: 2, enabled: true }],
    ] as const) {
      const response = await admin("PUT", path, body);
      assert.equal(response.status, 400, `${path} ${JSON.stringify(body)}`);
      assert.equal(response.body.code, "PASSPILOT_RULES_INVALID");
    }
    assert.equal((await admin("PUT", `/limits/students/${B.students[0]}`, { dailyLimit: 1, periodLimit: null, enabled: true })).body.code,
      "PASSPILOT_RULES_STUDENT_NOT_FOUND", "a foreign student is rejected before the foreign key");
    assert.equal((await admin("POST", "/encounters", { studentIdA: x, studentIdB: x })).body.code, "PASSPILOT_RULES_INVALID");
    assert.equal((await admin("POST", "/encounters", { studentIdA: x, studentIdB: B.students[0] })).body.code, "PASSPILOT_RULES_STUDENT_NOT_FOUND");
    assert.equal((await admin("DELETE", "/destinations/nurse")).status, 404);

    const created = await admin("POST", "/encounters", { studentIdA: x, studentIdB: y });
    const restrictionId: string = created.body.encounterRestrictions[0].id;
    await admin("PUT", "/destinations/nurse", { maxConcurrent: 2, enabled: true });
    await admin("PUT", `/limits/students/${x}`, { dailyLimit: 4, periodLimit: 1, enabled: true });

    const other = await admin("GET", "", undefined, B);
    assert.deepEqual([other.body.destinationPolicies, other.body.studentLimits, other.body.encounterRestrictions], [[], [], []]);
    assert.equal((await admin("DELETE", `/encounters/${restrictionId}`, undefined, B)).status, 404);
    assert.equal((await admin("PATCH", `/encounters/${restrictionId}`, { enabled: false }, B)).status, 404);
    assert.equal((await admin("DELETE", `/limits/students/${x}`, undefined, B)).status, 404);
    const own = await admin("GET", "");
    assert.equal(own.body.encounterRestrictions[0].enabled, true);
    assert.deepEqual(own.body.encounterRestrictions[0].students.map((student: { id: string }) => student.id).sort(), [x, y].sort());
    assert.equal(own.body.studentLimits[0].student.id, x);
    assert.equal(own.body.denialRetentionDays, 400);
    assert.deepEqual(own.body.destinations, ["bathroom", "nurse", "office", "counselor", "other_classroom"]);

    assert.equal((await admin("DELETE", `/encounters/${restrictionId}`)).status, 200);
    assert.equal((await admin("DELETE", "/destinations/nurse")).status, 200);
    assert.equal((await admin("DELETE", `/limits/students/${x}`)).status, 200);
    const auditedAfter = await auditEntities();
    const added = (entity: string) =>
      auditedAfter.filter((id) => id === entity).length - auditedBefore.filter((id) => id === entity).length;
    for (const entity of [`encounter:${restrictionId}`, "destination:nurse", `limits:student:${x}`]) {
      assert.equal(added(entity), 2, `${entity} is audited on create and delete`);
    }
    assert.equal(added(`limits:student:${B.students[0]}`), 0, "a rejected write is not audited");
    const audits = await pool.query("SELECT metadata, changes FROM audit_logs WHERE school_id = $1 AND action = 'passpilot.rules.update'", [L.schoolId]);
    assert.doesNotMatch(JSON.stringify(audits.rows), /Keep apart/, "free-text notes stay out of audit metadata");
  });

  it("exports one student's rule records for an access request without disclosing a paired student", async () => {
    const [target, other] = [L.students[6]!, L.students[7]!];
    await admin("PUT", `/limits/students/${target}`, { dailyLimit: 0, periodLimit: null, enabled: true });
    await admin("POST", "/encounters", { studentIdA: target, studentIdB: other });
    await seedPass({ schoolId: L.schoolId, studentId: other, gradeId: L.gradeA, issuedAt: new Date(Date.now() - 60_000), status: "active" });
    assert.equal((await issue(L.teacher, target)).status, 409);
    const records = await admin("GET", `/students/${target}/records`);
    assert.equal(records.status, 200);
    assert.equal(records.body.student.id, target);
    assert.deepEqual({ dailyLimit: records.body.limit.dailyLimit, periodLimit: records.body.limit.periodLimit }, { dailyLimit: 0, periodLimit: null });
    assert.equal(records.body.encounterRestrictionCount, 1);
    assert.equal(records.body.denials.length, 1);
    assert.equal(records.body.denials[0].ruleCode, "PASSPILOT_RULE_ENCOUNTER");
    assert.deepEqual(records.body.denials[0].details, {});
    assert.doesNotMatch(JSON.stringify(records.body), new RegExp(other));
    assert.equal((await admin("GET", `/students/${target}/records`, undefined, B)).status, 404);
    const audit = await pool.query("SELECT 1 FROM audit_logs WHERE school_id = $1 AND action = 'passpilot.rules.records.export' AND entity_id = $2", [L.schoolId, target]);
    assert.equal(audit.rowCount, 1);
  });

  it("purges only denial records older than 400 days", async () => {
    const student = L.students[0]!;
    await pool.query(
      `INSERT INTO passpilot_pass_denials(school_id, student_id, destination, rule_code, issued_via, denied_at)
       VALUES ($1, $2, 'bathroom', 'PASSPILOT_RULE_DAILY_LIMIT', 'teacher', now() - interval '401 days'),
              ($1, $2, 'bathroom', 'PASSPILOT_RULE_DAILY_LIMIT', 'teacher', now() - interval '399 days')`,
      [L.schoolId, student],
    );
    const purged = await rules.purgeExpiredPasspilotPassDenials(pool);
    assert.ok(purged >= 1);
    const remaining = await pool.query("SELECT (now() - denied_at) > interval '400 days' AS expired FROM passpilot_pass_denials WHERE school_id = $1", [L.schoolId]);
    assert.deepEqual(remaining.rows.map((row) => row.expired), [false]);
  });
});
