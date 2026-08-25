import { after, afterEach, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { readFileSync } from "node:fs";
import { sql } from "drizzle-orm";
import { Client } from "pg";
import type { School, User } from "../src/schema/core.js";
import type { Grade, InsertPass } from "../src/schema/passpilot.js";
import type { Student } from "../src/schema/students.js";

const TAG = `passpilot_overdue_${Date.now()}`;
const KIOSK_PIN = "5964";
const ORIGINAL_REDIS_URL = process.env.REDIS_URL;
const ORIGINAL_NODE_ENV = process.env.NODE_ENV;
process.env.REDIS_URL = "";
process.env.NODE_ENV = "test";

let db: typeof import("../src/db.js").default;
let pool: typeof import("../src/db.js").pool | undefined;
let sessionPool: typeof import("../src/db.js").sessionPool | undefined;
let schedulerPool: typeof import("../src/services/schedulerDb.js").schedulerPool | undefined;
let schedulerLockPool: typeof import("../src/services/schedulerDb.js").schedulerLockPool | undefined;
let storage: typeof import("../src/services/storage.js");
let runWithTenantContext: typeof import("../src/middleware/tenantContext.js").runWithTenantContext;
let signUserToken: typeof import("../src/services/jwt.js").signUserToken;
let executeTool: typeof import("../src/services/chatToolExecutor.js").executeTool;
let server: Server | undefined;
let baseUrl: string;
let school: School;
let teacher: User;
let grade: Grade;
let student: Student;

function inSchool<T>(fn: () => Promise<T>): Promise<T> {
  return runWithTenantContext({ schoolId: school.id }, fn);
}

function asSystem<T>(fn: () => Promise<T>): Promise<T> {
  return runWithTenantContext({ isSuper: true }, fn);
}

function passInput(overrides: Partial<InsertPass> = {}): InsertPass {
  return {
    schoolId: school.id,
    studentId: student.id,
    teacherId: null,
    gradeId: grade.id,
    destination: "bathroom",
    status: "active",
    duration: 5,
    expiresAt: new Date(Date.now() - 60_000),
    issuedVia: "teacher",
    ...overrides,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isUniqueViolation(error: unknown): boolean {
  if (!isRecord(error)) return false;
  if (error.code === "23505") return true;
  return isRecord(error.cause) && error.cause.code === "23505";
}

function errorMessage(body: unknown): string {
  return isRecord(body) && typeof body.error === "string" ? body.error : "";
}

function authHeaders(): Record<string, string> {
  return {
    authorization: `Bearer ${signUserToken({
      userId: teacher.id,
      email: teacher.email,
      isSuperAdmin: false,
    })}`,
    "x-school-id": school.id,
  };
}

function kioskHeaders(): Record<string, string> {
  return {
    "x-school-id": school.id,
    "x-kiosk-pin": KIOSK_PIN,
  };
}

async function requestJson(
  method: "POST",
  path: string,
  body: Record<string, unknown>,
  headers: Record<string, string>
): Promise<{ status: number; body: unknown }> {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  return {
    status: response.status,
    body: text ? JSON.parse(text) as unknown : null,
  };
}

async function resolveActivePasses(): Promise<void> {
  const active = await inSchool(() => storage.getActivePassesByStudentIds(school.id, [student.id]));
  await inSchool(async () => {
    for (const pass of active) {
      await storage.returnPass(pass.id, school.id);
    }
  });
}

async function waitForAdvisoryWaiters(client: Client, expected: number): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const result = await client.query<{ waiting: number }>(`
      SELECT count(*)::int AS waiting
      FROM pg_locks
      WHERE locktype = 'advisory' AND NOT granted
    `);
    if ((result.rows[0]?.waiting ?? 0) >= expected) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(`Timed out waiting for ${expected} PassPilot issuance lock waiters`);
}

before(async () => {
  const dbModule = await import("../dist/db.js");
  db = dbModule.default;
  pool = dbModule.pool;
  sessionPool = dbModule.sessionPool;
  storage = await import("../dist/services/storage.js");
  ({ runWithTenantContext } = await import("../dist/middleware/tenantContext.js"));
  ({ signUserToken } = await import("../dist/services/jwt.js"));
  ({ executeTool } = await import("../dist/services/chatToolExecutor.js"));
  const schedulerDbModule = await import("../dist/services/schedulerDb.js");
  schedulerPool = schedulerDbModule.schedulerPool;
  schedulerLockPool = schedulerDbModule.schedulerLockPool;

  school = await asSystem(() => storage.createSchool({
    name: TAG,
    domain: `${TAG}.example.edu`,
    slug: TAG,
    defaultPassDuration: 5,
    kioskEnabled: true,
    kioskRequiresApproval: false,
  }));
  teacher = await asSystem(() => storage.createUser({
    email: `teacher@${TAG}.example.edu`,
    firstName: "Overdue",
    lastName: "Teacher",
  }));
  await asSystem(() => storage.createMembership({
    schoolId: school.id,
    userId: teacher.id,
    role: "teacher",
    status: "active",
  }));
  await inSchool(() => storage.createProductLicense({
    schoolId: school.id,
    product: "PASSPILOT",
    status: "active",
  }));
  await inSchool(() => storage.upsertSettings(school.id, {
    schoolName: school.name,
    schoolTimezone: school.schoolTimezone,
    wsSharedKey: `${TAG}-private-key`,
    passpilotClassSource: "legacy_grades",
  }));
  grade = await inSchool(() => storage.createGrade({
    schoolId: school.id,
    name: "Overdue Test Class",
  }));
  student = await inSchool(() => storage.createStudent({
    schoolId: school.id,
    firstName: "Overdue",
    lastName: "Student",
    email: `student@${TAG}.example.edu`,
    emailLc: `student@${TAG}.example.edu`,
    gradeId: grade.id,
    status: "active",
  }));
  await inSchool(() => storage.assignTeacherGrade(teacher.id, grade.id));
  const { hashPassword } = await import("../dist/util/password.js");
  const kioskPinHash = await hashPassword(KIOSK_PIN);
  const updatedSchool = await inSchool(() => storage.updateSchool(school.id, {
    kioskPinHash,
    kioskGradeId: grade.id,
  }));
  if (updatedSchool) school = updatedSchool;

  const { createApp } = await import("../dist/app.js");
  server = createServer(createApp());
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
});

after(async () => {
  try {
    if (server) {
      await new Promise<void>((resolve, reject) => {
        server!.close((error) => error ? reject(error) : resolve());
      });
    }
    if (school?.id) {
      await asSystem(async () => {
        await db.execute(sql`DELETE FROM student_timeline_events WHERE school_id = ${school.id}`);
        await db.execute(sql`DELETE FROM passes WHERE school_id = ${school.id}`);
        await db.execute(sql`DELETE FROM teacher_grades WHERE grade_id = ${grade.id}`);
        await db.execute(sql`DELETE FROM passpilot_grade_students WHERE school_id = ${school.id}`);
        await db.execute(sql`DELETE FROM students WHERE school_id = ${school.id}`);
        await db.execute(sql`DELETE FROM grades WHERE school_id = ${school.id}`);
        await db.execute(sql`DELETE FROM audit_logs WHERE school_id = ${school.id}`);
        await db.execute(sql`DELETE FROM settings WHERE school_id = ${school.id}`);
        await db.execute(sql`DELETE FROM product_licenses WHERE school_id = ${school.id}`);
        await db.execute(sql`DELETE FROM school_memberships WHERE school_id = ${school.id}`);
        await db.execute(sql`DELETE FROM schools WHERE id = ${school.id}`);
        await db.execute(sql`DELETE FROM users WHERE id = ${teacher.id}`);
      });
    }
  } finally {
    await schedulerLockPool?.end().catch(() => undefined);
    await schedulerPool?.end().catch(() => undefined);
    await sessionPool?.end().catch(() => undefined);
    await pool?.end().catch(() => undefined);
    if (ORIGINAL_REDIS_URL === undefined) delete process.env.REDIS_URL;
    else process.env.REDIS_URL = ORIGINAL_REDIS_URL;
    if (ORIGINAL_NODE_ENV === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = ORIGINAL_NODE_ENV;
  }
});

afterEach(async () => {
  if (school?.id) await resolveActivePasses();
});

describe("PassPilot overdue lifecycle", { concurrency: false }, () => {
  it("keeps every runtime path status-driven and uses the school default when no override is supplied", () => {
    const storageSource = readFileSync(new URL("../src/services/storage.ts", import.meta.url), "utf8");
    const passesRoute = readFileSync(new URL("../src/routes/passpilot/passes.ts", import.meta.url), "utf8");
    const kioskRoute = readFileSync(new URL("../src/routes/passpilot/kiosk.ts", import.meta.url), "utf8");
    const chatExecutor = readFileSync(new URL("../src/services/chatToolExecutor.ts", import.meta.url), "utf8");
    const dashboardSnapshot = readFileSync(
      new URL("../src/services/classpilotDashboardSnapshot.ts", import.meta.url),
      "utf8"
    );

    for (const source of [storageSource, passesRoute, kioskRoute, chatExecutor]) {
      assert.doesNotMatch(source, /expireOverduePasses/);
    }
    assert.doesNotMatch(storageSource, /passes\.expiresAt\}\s*>\s*now\(\)/);
    assert.match(passesRoute, /duration \?\? school\?\.defaultPassDuration \?\? 5/);
    assert.match(kioskRoute, /school\.defaultPassDuration \?\? 5/);
    assert.match(chatExecutor, /args\.duration \?\? school\?\.defaultPassDuration \?\? 5/);
    assert.match(dashboardSnapshot, /pass\.status = 'active'/);
    assert.doesNotMatch(dashboardSnapshot, /pass\.expires_at\s*>\s*(?:now\(\)|CURRENT_TIMESTAMP)/i);
  });

  it("keeps a past-threshold pass active across reads, blocks a duplicate, and permits explicit resolution", async () => {
    const overdue = await inSchool(() => storage.createPass(passInput()));
    const historicalExpired = await inSchool(() => storage.createPass(passInput({
      status: "expired",
      expiresAt: new Date(Date.now() - 120_000),
    })));

    const [schoolPasses, studentPasses, gradePasses, activePass, kioskState] =
      await inSchool(() => Promise.all([
        storage.getActivePassesBySchool(school.id),
        storage.getActivePassesByStudentIds(school.id, [student.id]),
        storage.getActivePassesByGrade(school.id, grade.id),
        storage.getActivePassForStudent(student.id, school.id),
        storage.getKioskStudentState(school.id, student.id, false),
      ]));

    for (const rows of [schoolPasses, studentPasses, gradePasses]) {
      assert.deepEqual(rows.map((pass) => pass.id), [overdue.id]);
    }
    assert.equal(activePass?.id, overdue.id);
    assert.equal(kioskState.activePass?.id, overdue.id);

    const [persistedOverdue, persistedExpired] = await inSchool(() => Promise.all([
      storage.getPassById(overdue.id, school.id),
      storage.getPassById(historicalExpired.id, school.id),
    ]));
    assert.equal(persistedOverdue?.status, "active");
    assert.equal(persistedOverdue?.returnedAt, null);
    assert.ok(overdue.expiresAt.getTime() <= Date.now());
    assert.equal(persistedExpired?.status, "expired");
    assert.equal(persistedExpired?.returnedAt, null);

    const settingsUpdate = await inSchool(() => storage.updatePasspilotAdminSettings(
      school.id,
      school.passpilotSettingsRevision,
      { defaultPassDuration: 10 },
      { userId: `${TAG}-admin`, userRole: "school_admin" }
    ));
    assert.equal(settingsUpdate?.status, "saved");
    assert.equal(settingsUpdate?.current.defaultPassDuration, 10);
    const unchangedExistingPass = await inSchool(() => storage.getPassById(overdue.id, school.id));
    assert.equal(unchangedExistingPass?.expiresAt.getTime(), overdue.expiresAt.getTime());
    assert.equal(unchangedExistingPass?.duration, overdue.duration);
    assert.equal(unchangedExistingPass?.status, "active");

    await assert.rejects(
      inSchool(() => storage.createPass(passInput({ expiresAt: new Date(Date.now() + 60_000) }))),
      isUniqueViolation
    );

    const returned = await inSchool(() => storage.returnPass(overdue.id, school.id));
    assert.equal(returned?.status, "returned");
    assert.ok(returned?.returnedAt instanceof Date);

    const nextOverdue = await inSchool(() => storage.createPass(passInput()));
    const canceled = await inSchool(() => storage.cancelPass(nextOverdue.id, school.id));
    assert.equal(canceled?.status, "canceled");
    assert.equal(canceled?.returnedAt, null);

    const replacement = await inSchool(() => storage.createPass(passInput({
      expiresAt: new Date(Date.now() + 60_000),
    })));
    assert.equal(replacement.status, "active");
    await inSchool(() => storage.cancelPass(replacement.id, school.id));
  });

  it("blocks an overdue duplicate through teacher, kiosk, and AI issuance surfaces", async () => {
    const overdue = await inSchool(() => storage.createPass(passInput({ teacherId: teacher.id })));
    try {
      const teacherResponse = await requestJson(
        "POST",
        "/passpilot/passes",
        {
          studentId: student.id,
          gradeId: grade.id,
          destination: "office",
        },
        authHeaders()
      );
      assert.equal(teacherResponse.status, 409);
      assert.match(errorMessage(teacherResponse.body), /already has an active pass/i);

      const kioskResponse = await requestJson(
        "POST",
        "/passpilot/kiosk/checkout",
        {
          studentId: student.id,
          classId: grade.id,
          destination: "nurse",
        },
        kioskHeaders()
      );
      assert.equal(kioskResponse.status, 409);
      assert.match(errorMessage(kioskResponse.body), /already has an active pass/i);

      const aiResult = await executeTool(
        "issue_pass",
        {
          studentId: student.id,
          classId: grade.id,
          destination: "counselor",
        },
        {
          userId: teacher.id,
          schoolId: school.id,
          schoolName: "current school",
          userName: "current user",
          userRole: "teacher",
          licensedProducts: ["PASSPILOT"],
          getTranscript: () => "",
        }
      );
      assert.equal(aiResult.success, false);
      assert.match(aiResult.error ?? "", /already has an active pass/i);

      const active = await inSchool(() =>
        storage.getActivePassesByStudentIds(school.id, [student.id])
      );
      assert.deepEqual(active.map((pass) => pass.id), [overdue.id]);
      assert.equal((await inSchool(() => storage.getPassById(overdue.id, school.id)))?.status, "active");
    } finally {
      await resolveActivePasses();
    }
  });

  it("allows exactly one winner when two teacher issuances race after both active-pass checks", async () => {
    assert.ok(process.env.DATABASE_URL, "DATABASE_URL is required for the issuance race fixture");
    const blocker = new Client({ connectionString: process.env.DATABASE_URL });
    await blocker.connect();
    const lockKey = `passpilot-class-source:${school.id}`;
    await blocker.query("SELECT pg_advisory_lock(hashtext($1))", [lockKey]);

    let attempts: Promise<Array<{ status: number; body: unknown }>> | undefined;
    try {
      attempts = Promise.all([
        requestJson(
          "POST",
          "/passpilot/passes",
          { studentId: student.id, gradeId: grade.id, destination: "office" },
          authHeaders()
        ),
        requestJson(
          "POST",
          "/passpilot/passes",
          { studentId: student.id, gradeId: grade.id, destination: "nurse" },
          authHeaders()
        ),
      ]);
      await waitForAdvisoryWaiters(blocker, 2);
    } finally {
      await blocker.query("SELECT pg_advisory_unlock(hashtext($1))", [lockKey]);
      await blocker.end();
    }

    try {
      const responses = await attempts!;
      assert.deepEqual(responses.map((response) => response.status).sort(), [201, 409]);
      const conflict = responses.find((response) => response.status === 409);
      assert.match(errorMessage(conflict?.body), /already has an active pass/i);

      const active = await inSchool(() =>
        storage.getActivePassesByStudentIds(school.id, [student.id])
      );
      assert.equal(active.length, 1);
      assert.equal(active[0]?.status, "active");
    } finally {
      await resolveActivePasses();
    }
  });
});
