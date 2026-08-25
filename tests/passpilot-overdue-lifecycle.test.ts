import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { sql } from "drizzle-orm";

const TAG = `passpilot_overdue_${Date.now()}`;
const ORIGINAL_REDIS_URL = process.env.REDIS_URL;
const ORIGINAL_NODE_ENV = process.env.NODE_ENV;
process.env.REDIS_URL = "";
process.env.NODE_ENV = "test";

let db: any;
let pool: any;
let sessionPool: any;
let schedulerPool: any;
let schedulerLockPool: any;
let storage: any;
let runWithTenantContext: any;
let school: any;
let grade: any;
let student: any;

function inSchool(fn: () => Promise<any>): Promise<any> {
  return runWithTenantContext({ schoolId: school.id }, fn);
}

function asSystem(fn: () => Promise<any>): Promise<any> {
  return runWithTenantContext({ isSuper: true }, fn);
}

function passInput(overrides: Record<string, unknown> = {}) {
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

before(async () => {
  const dbModule = await import("../dist/db.js");
  db = dbModule.default;
  pool = dbModule.pool;
  sessionPool = dbModule.sessionPool;
  storage = await import("../dist/services/storage.js");
  ({ runWithTenantContext } = await import("../dist/middleware/tenantContext.js"));
  const schedulerDbModule = await import("../dist/services/schedulerDb.js");
  schedulerPool = schedulerDbModule.schedulerPool;
  schedulerLockPool = schedulerDbModule.schedulerLockPool;

  school = await asSystem(() => storage.createSchool({
    name: TAG,
    domain: `${TAG}.example.edu`,
    slug: TAG,
    defaultPassDuration: 5,
    kioskEnabled: false,
    kioskRequiresApproval: false,
  }));
  await inSchool(() => storage.upsertSettings(school.id, {
    schoolName: school.name,
    schoolTimezone: school.schoolTimezone,
    wsSharedKey: `${TAG}-private-key`,
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
});

after(async () => {
  try {
    if (school?.id) {
      await asSystem(async () => {
        await db.execute(sql`DELETE FROM passes WHERE school_id = ${school.id}`);
        await db.execute(sql`DELETE FROM students WHERE school_id = ${school.id}`);
        await db.execute(sql`DELETE FROM grades WHERE school_id = ${school.id}`);
        await db.execute(sql`DELETE FROM audit_logs WHERE school_id = ${school.id}`);
        await db.execute(sql`DELETE FROM settings WHERE school_id = ${school.id}`);
        await db.execute(sql`DELETE FROM schools WHERE id = ${school.id}`);
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
      assert.deepEqual(rows.map((pass: any) => pass.id), [overdue.id]);
    }
    assert.equal(activePass?.id, overdue.id);
    assert.equal(kioskState.activePass?.id, overdue.id);

    const persistedAfterReads = await inSchool(() => db.execute(sql`
      SELECT id, status, returned_at, expires_at
      FROM passes
      WHERE id IN (${overdue.id}, ${historicalExpired.id})
      ORDER BY id
    `));
    const overdueRow = persistedAfterReads.rows.find((row: any) => row.id === overdue.id);
    const expiredRow = persistedAfterReads.rows.find((row: any) => row.id === historicalExpired.id);
    assert.equal(overdueRow.status, "active");
    assert.equal(overdueRow.returned_at ?? overdueRow.returnedAt ?? null, null);
    assert.ok(overdue.expiresAt.getTime() <= Date.now());
    assert.equal(expiredRow.status, "expired");
    assert.equal(expiredRow.returned_at ?? expiredRow.returnedAt ?? null, null);

    const settingsUpdate = await inSchool(() => storage.updatePasspilotAdminSettings(
      school.id,
      0,
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
      (error: any) => error?.code === "23505" || error?.cause?.code === "23505"
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
  });
});
