import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import { createClient } from "redis";
import { sql } from "drizzle-orm";

const TAG = `pp_kiosk_sessions_${Date.now()}`;
const KIOSK_PIN = "4321";
const ENROLLMENT_KEY = `${TAG}_enrollment_key`;
process.env.REDIS_URL = "";
process.env.NODE_ENV = "test";
process.env.CLASSPILOT_PROTOCOL_V3_ENABLED = "true";
process.env.CLASSPILOT_CAP_KIOSK_LAUNCH_TICKET_V1 = "true";
process.env.CLASSPILOT_CAP_SCOPED_AUTHORITY_CHECKS_V1 = "true";
process.env.CLASSPILOT_CAP_KIOSK_LAUNCH_TICKET_V2 = "true";

let db: any;
let pool: any;
let sessionPool: any;
let schedulerPool: any;
let schedulerLockPool: any;
let storage: any;
let runWithTenantContext: any;
let signUserToken: any;
let server: Server;
let baseUrl: string;
let schoolA: any;
let schoolB: any;
let schoolC: any;
let teacherC: any;
let canonicalGroup: any;
let studentC: any;
let adminA: any;
let adminB: any;
let teacherA: any;
let teacherB: any;
let unrelatedTeacher: any;
let gradeA: any;
let gradeB: any;
let gradeC: any;
let studentA: any;
let schemaReady = false;
let staffLifecycleGuardInstalled = false;

function inSchool<T>(schoolId: string, fn: () => Promise<T>): Promise<T> {
  return runWithTenantContext({ schoolId }, fn);
}

function asSystem<T>(fn: () => Promise<T>): Promise<T> {
  return runWithTenantContext({ isSuper: true }, fn);
}

function authFor(user: any, schoolId: string): Record<string, string> {
  return {
    authorization: `Bearer ${signUserToken({
      userId: user.id,
      email: user.email,
      isSuperAdmin: false,
    })}`,
    "x-school-id": schoolId,
    "x-passpilot-class-model": "classpilot-groups-v1",
  };
}

function kioskHeaders(schoolId: string, sessionId?: string): Record<string, string> {
  return {
    "x-school-id": schoolId,
    "x-kiosk-pin": KIOSK_PIN,
    "x-passpilot-class-model": "classpilot-groups-v1",
    ...(sessionId ? { "x-kiosk-session": sessionId } : {}),
  };
}

async function requestJson(
  method: string,
  path: string,
  body: unknown,
  headers: Record<string, string>
): Promise<{ status: number; body: any; headers: Headers }> {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { "content-type": "application/json", ...headers },
    ...(method === "GET" || method === "HEAD"
      ? {}
      : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  return {
    status: response.status,
    body: text ? JSON.parse(text) : null,
    headers: response.headers,
  };
}

before(async () => {
  const dbModule = await import("../dist/db.js");
  db = dbModule.default;
  pool = dbModule.pool;
  sessionPool = dbModule.sessionPool;
  storage = await import("../dist/services/storage.js");
  ({ runWithTenantContext } = await import("../dist/middleware/tenantContext.js"));
  ({ signUserToken } = await import("../dist/services/jwt.js"));
  const schedulerDbModule = await import("../dist/services/schedulerDb.js");
  schedulerPool = schedulerDbModule.schedulerPool;
  schedulerLockPool = schedulerDbModule.schedulerLockPool;
  const { hashPassword } = await import("../dist/util/password.js");

  schemaReady = await pool
    .query(`SELECT to_regclass('public.passpilot_kiosk_sessions') IS NOT NULL AS ready`)
    .then((result: any) => result.rows[0]?.ready === true)
    .catch(() => false);
  if (!schemaReady) return;

  const staffLifecycleGuardResult = await pool.query(`
    SELECT EXISTS (
      SELECT 1
      FROM pg_trigger AS trigger
      INNER JOIN pg_class AS relation ON relation.oid = trigger.tgrelid
      INNER JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
      WHERE namespace.nspname = 'public'
        AND relation.relname = 'school_memberships'
        AND trigger.tgname = 'classpilot_staff_assignment_membership_update'
        AND trigger.tgenabled IN ('O', 'A')
    ) AS installed
  `);
  staffLifecycleGuardInstalled = staffLifecycleGuardResult.rows[0]?.installed === true;

  // Self-provision schema the tests need (mirrors the src/index.ts inline
  // migration) so older local DBs run without a server boot. Tolerant of a
  // restricted role: in the RLS-enabled CI job the suite runs as the
  // non-owner tenant user and the schema already exists via drizzle push —
  // DDL failures there are expected and harmless.
  try {
  await pool.query(`
    ALTER TABLE schools
    ADD COLUMN IF NOT EXISTS kiosk_style TEXT NOT NULL DEFAULT 'simple'
  `);
  await pool.query(`
    ALTER TABLE passpilot_kiosk_sessions ADD COLUMN IF NOT EXISTS device_id TEXT
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS pp_kiosk_sessions_school_device_idx
    ON passpilot_kiosk_sessions (school_id, device_id) WHERE device_id IS NOT NULL
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS passpilot_kiosk_devices (
      id VARCHAR NOT NULL,
      school_id TEXT NOT NULL,
      teacher_id TEXT NOT NULL,
      class_source TEXT,
      grade_id TEXT,
      classpilot_group_id TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      last_used_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CONSTRAINT pp_kiosk_devices_pkey PRIMARY KEY (school_id, id),
      CONSTRAINT pp_kiosk_devices_class_source_check
        CHECK (class_source IS NULL OR class_source IN ('legacy_grades', 'classpilot_groups')),
      CONSTRAINT pp_kiosk_devices_class_shape_check
        CHECK (
          (class_source IS NULL AND grade_id IS NULL AND classpilot_group_id IS NULL) OR
          (class_source = 'legacy_grades' AND grade_id IS NOT NULL AND classpilot_group_id IS NULL) OR
          (class_source = 'classpilot_groups' AND classpilot_group_id IS NOT NULL AND grade_id IS NULL)
        )
    )
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS pp_kiosk_devices_school_last_used_idx
    ON passpilot_kiosk_devices (school_id, last_used_at)
  `);
  } catch {
    // Restricted-role run (RLS CI job): schema is already provisioned.
  }

  schoolA = await storage.createSchool({
    name: `${TAG}_A`,
    domain: `${TAG}-a.example.edu`,
    slug: `${TAG}-a`,
  } as any);
  schoolB = await storage.createSchool({
    name: `${TAG}_B`,
    domain: `${TAG}-b.example.edu`,
    slug: `${TAG}-b`,
  } as any);
  adminA = await storage.createUser({ email: `admin@${TAG}-a.example.edu`, firstName: "Admin", lastName: "A" } as any);
  teacherA = await storage.createUser({ email: `teacher-a@${TAG}-a.example.edu`, firstName: "Teacher", lastName: "A" } as any);
  teacherB = await storage.createUser({
    email: `teacher-b@${TAG}-a.example.edu`,
    firstName: "Teacher",
    lastName: "B",
    displayName: "Mr. B",
  } as any);
  unrelatedTeacher = await storage.createUser({ email: `unrelated@${TAG}-a.example.edu`, firstName: "Teacher", lastName: "U" } as any);
  await storage.createMembership({ schoolId: schoolA.id, userId: adminA.id, role: "school_admin", status: "active" } as any);
  // School B admin so cross-tenant claim-code scoping can be exercised past
  // the membership middleware.
  adminB = await storage.createUser({ email: `admin@${TAG}-b.example.edu`, firstName: "Admin", lastName: "B" } as any);
  await storage.createMembership({ schoolId: schoolB.id, userId: adminB.id, role: "school_admin", status: "active" } as any);
  await storage.createMembership({
    schoolId: schoolA.id,
    userId: teacherA.id,
    role: "teacher",
    status: "active",
    kioskName: "Room 204",
  } as any);
  await storage.createMembership({ schoolId: schoolA.id, userId: teacherB.id, role: "teacher", status: "active" } as any);
  await storage.createMembership({ schoolId: schoolA.id, userId: unrelatedTeacher.id, role: "teacher", status: "active" } as any);

  // Canonical (ClassPilot-groups) school for canonical-mode session coverage.
  schoolC = await storage.createSchool({
    name: `${TAG}_C`,
    domain: `${TAG}-c.example.edu`,
    slug: `${TAG}-c`,
  } as any);
  teacherC = await storage.createUser({
    email: `teacher-c@${TAG}-c.example.edu`,
    firstName: "Teacher",
    lastName: "C",
    displayName: "Ms. C",
  } as any);
  await storage.createMembership({ schoolId: schoolC.id, userId: teacherC.id, role: "teacher", status: "active" } as any);

  const pinHash = await hashPassword(KIOSK_PIN);
  for (const school of [schoolA, schoolB]) {
    await storage.createProductLicense({ schoolId: school.id, product: "PASSPILOT", status: "active" } as any);
    await storage.createProductLicense({ schoolId: school.id, product: "CLASSPILOT", status: "active" } as any);
    await inSchool(school.id, () => storage.upsertSettings(school.id, {
      schoolName: school.name,
      passpilotClassSource: "legacy_grades",
      enrollmentKey: ENROLLMENT_KEY,
      enrollmentKeyRequired: true,
    }));
    await asSystem(() =>
      db.execute(sql`UPDATE schools SET kiosk_enabled = true, kiosk_pin_hash = ${pinHash} WHERE id = ${school.id}`)
    );
  }
  await storage.createProductLicense({ schoolId: schoolC.id, product: "PASSPILOT", status: "active" } as any);
  await storage.createProductLicense({ schoolId: schoolC.id, product: "CLASSPILOT", status: "active" } as any);
  await inSchool(schoolC.id, async () => {
    await storage.upsertSettings(schoolC.id, {
      schoolName: schoolC.name,
      passpilotClassSource: "classpilot_groups",
      enrollmentKey: ENROLLMENT_KEY,
      enrollmentKeyRequired: true,
    });
    canonicalGroup = await storage.createGroup({
      schoolId: schoolC.id,
      teacherId: teacherC.id,
      name: "Homeroom 6C",
      groupType: "admin_class",
      status: "active",
    } as any);
    studentC = await storage.createStudent({
      schoolId: schoolC.id,
      firstName: "Canonical",
      lastName: "Student",
      status: "active",
    } as any);
    await storage.addGroupStudents(canonicalGroup.id, [studentC.id]);
  });
  await asSystem(() =>
    db.execute(sql`UPDATE schools SET kiosk_enabled = true, kiosk_pin_hash = ${pinHash} WHERE id = ${schoolC.id}`)
  );

  await inSchool(schoolB.id, async () => {
    gradeC = await storage.createGrade({ schoolId: schoolB.id, name: "Class C" } as any);
  });
  await inSchool(schoolA.id, async () => {
    gradeA = await storage.createGrade({ schoolId: schoolA.id, name: "Class A" } as any);
    gradeB = await storage.createGrade({ schoolId: schoolA.id, name: "Class B" } as any);
    studentA = await storage.createStudent({
      schoolId: schoolA.id,
      firstName: "Kiosk",
      lastName: "Student",
      status: "active",
      gradeId: gradeA.id,
    } as any);
    await storage.assignTeacherGrade(teacherA.id, gradeA.id);
    await storage.assignTeacherGrade(teacherA.id, gradeB.id);
    await storage.assignTeacherGrade(teacherB.id, gradeB.id);
  });

  const { createApp } = await import("../dist/app.js");
  server = createServer(createApp());
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
});

after(async () => {
  try {
    if (server) {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => error ? reject(error) : resolve())
      );
    }
    if (schemaReady && schoolA?.id && schoolB?.id && schoolC?.id) {
      await asSystem(async () => {
        const ids = sql.join([schoolA.id, schoolB.id, schoolC.id].map((id) => sql`${id}`), sql`, `);
        await db.transaction(async (tx: typeof db) => {
          await tx.execute(sql`DELETE FROM audit_logs WHERE school_id IN (${ids})`);
          await tx.execute(sql`DELETE FROM passes WHERE school_id IN (${ids})`);
          await tx.execute(sql`DELETE FROM passpilot_kiosk_sessions WHERE school_id IN (${ids})`);
          await tx.execute(sql`DELETE FROM passpilot_kiosk_devices WHERE school_id IN (${ids})`);
          await tx.execute(sql`DELETE FROM teacher_grades WHERE grade_id IN (SELECT id FROM grades WHERE school_id IN (${ids}))`);
          await tx.execute(sql`DELETE FROM passpilot_grade_students WHERE school_id IN (${ids})`);
          await tx.execute(sql`DELETE FROM group_students WHERE group_id IN (SELECT id FROM groups WHERE school_id IN (${ids}))`);
          await tx.execute(sql`DELETE FROM group_teachers WHERE group_id IN (SELECT id FROM groups WHERE school_id IN (${ids}))`);
          await tx.execute(sql`DELETE FROM groups WHERE school_id IN (${ids})`);
          await tx.execute(sql`DELETE FROM grades WHERE school_id IN (${ids})`);
          await tx.execute(sql`DELETE FROM students WHERE school_id IN (${ids})`);
          await tx.execute(sql`DELETE FROM settings WHERE school_id IN (${ids})`);
          await tx.execute(sql`DELETE FROM product_licenses WHERE school_id IN (${ids})`);
          await tx.execute(sql`DELETE FROM school_memberships WHERE school_id IN (${ids})`);
          await tx.execute(sql`
            UPDATE schools
            SET status = 'suspended', is_active = false, deleted_at = now()
            WHERE id IN (${ids})
          `);
        });
      });
    }
  } finally {
    await schedulerLockPool?.end().catch(() => undefined);
    await schedulerPool?.end().catch(() => undefined);
    await sessionPool?.end().catch(() => undefined);
    await pool?.end().catch(() => undefined);
  }
});

describe("PassPilot per-device kiosk sessions", { concurrency: false }, () => {
  it("keeps schema, startup, RLS review, deploy-allowlist, and CSRF contracts aligned", () => {
    const schema = readFileSync(new URL("../src/schema/passpilot.ts", import.meta.url), "utf8");
    const startup = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
    const csrf = readFileSync(new URL("../src/middleware/csrfProtection.ts", import.meta.url), "utf8");
    const rlsRegistry = readFileSync(new URL("../src/config/rlsRegistry.json", import.meta.url), "utf8");
    assert.match(schema, /passpilotKioskSessions = pgTable\(/);
    assert.match(startup, /CREATE TABLE IF NOT EXISTS passpilot_kiosk_sessions/);
    assert.match(startup, /isReviewedRlsEnforcementRequest/);
    assert.match(rlsRegistry, /"passpilotKioskSessions"[\s\S]*?"passpilot_kiosk_sessions"/);
    const deployScript = readFileSync(new URL("../scripts/deploy.sh", import.meta.url), "utf8");
    assert.match(deployScript, /enforce-deploy-rls-allowlist\.mjs" validate-request/);
    assert.match(csrf, /"\/passpilot\/kiosk\/session"/);
    assert.match(csrf, /"\/kiosk\/session"/);
    // Device-memory table rides the same contract set.
    assert.match(schema, /passpilotKioskDevices = pgTable\(/);
    assert.match(startup, /CREATE TABLE IF NOT EXISTS passpilot_kiosk_devices/);
    assert.match(startup, /ADD COLUMN IF NOT EXISTS device_id TEXT/);
    assert.match(rlsRegistry, /"passpilotKioskDevices"[\s\S]*?"passpilot_kiosk_devices"/);
    assert.match(csrf, /"\/passpilot\/kiosk\/session\/resume"/);
    assert.match(csrf, /"\/kiosk\/session\/resume"/);
    assert.match(csrf, /"\/passpilot\/kiosk\/auth"/);
    assert.match(csrf, /"\/classpilot\/kiosk\/launch-ticket"/);
    assert.match(csrf, /"\/passpilot\/kiosk\/launch-ticket\/redeem"/);
    assert.match(csrf, /"\/passpilot\/kiosk\/client-health"/);
    assert.match(csrf, /"\/kiosk\/auth"/);
    assert.match(csrf, /"\/kiosk\/launch-ticket\/redeem"/);
    assert.match(csrf, /"\/kiosk\/client-health"/);
  });

  let sessionOne: any;

  it("bootstraps an unclaimed session with a 6-digit code and resumes idempotently", async (t) => {
    if (!schemaReady) return t.skip("passpilot_kiosk_sessions migration not applied");
    const created = await requestJson("POST", "/passpilot/kiosk/session", {}, kioskHeaders(schoolA.id));
    assert.equal(created.status, 201);
    sessionOne = created.body.session;
    assert.equal(sessionOne.status, "unclaimed");
    assert.match(sessionOne.claimCode, /^\d{6}$/);
    assert.equal(created.body.kioskStyle, "simple");

    const resumed = await requestJson("POST", "/passpilot/kiosk/session", {}, kioskHeaders(schoolA.id, sessionOne.id));
    assert.equal(resumed.status, 200);
    assert.equal(resumed.body.session.id, sessionOne.id);
    assert.equal(resumed.body.session.claimCode, sessionOne.claimCode);

    const badPin = await requestJson("POST", "/passpilot/kiosk/session", {}, {
      "x-school-id": schoolA.id,
      "x-kiosk-pin": "0000",
    });
    assert.equal(badPin.status, 401);
  });

  it("gates roster and checkout behind a claim; config re-serves the code", async (t) => {
    if (!schemaReady) return t.skip("migration not applied");
    const config = await requestJson("GET", `/passpilot/kiosk/config?school=${schoolA.id}`, undefined, kioskHeaders(schoolA.id, sessionOne.id));
    assert.equal(config.status, 200);
    assert.equal(config.body.session.status, "unclaimed");
    assert.equal(config.body.session.claimCode, sessionOne.claimCode);
    assert.equal(config.body.classId, null);
    assert.equal(config.body.kioskStyle, "simple");

    const students = await requestJson("GET", `/passpilot/kiosk/students?school=${schoolA.id}&gradeId=${gradeA.id}`, undefined, kioskHeaders(schoolA.id, sessionOne.id));
    assert.equal(students.status, 409);
    assert.equal(students.body.code, "PASSPILOT_KIOSK_SESSION_UNCLAIMED");

    const checkout = await requestJson("POST", `/passpilot/kiosk/checkout`, { studentId: studentA.id, destination: "bathroom" }, kioskHeaders(schoolA.id, sessionOne.id));
    assert.equal(checkout.status, 409);
    assert.equal(checkout.body.code, "PASSPILOT_KIOSK_SESSION_UNCLAIMED");
  });

  it("rejects bad codes, unauthorized teachers, and cross-school claims", async (t) => {
    if (!schemaReady) return t.skip("migration not applied");
    const wrongCode = await requestJson("POST", "/passpilot/kiosk/sessions/claim", { claimCode: "000000", classId: gradeA.id }, authFor(teacherA, schoolA.id));
    assert.equal(wrongCode.status, 404);

    const denied = await requestJson("POST", "/passpilot/kiosk/sessions/claim", { claimCode: sessionOne.claimCode, classId: gradeA.id }, authFor(unrelatedTeacher, schoolA.id));
    assert.equal(denied.status, 403);

    // A school B manager cannot consume school A's code: the code lookup is
    // tenant-scoped (this is the cross-tenant scoping assertion).
    const crossSchool = await requestJson("POST", "/passpilot/kiosk/sessions/claim", { claimCode: sessionOne.claimCode, classId: gradeC.id }, authFor(adminB, schoolB.id));
    assert.equal(crossSchool.status, 404);
    assert.equal(crossSchool.body.code, "PASSPILOT_KIOSK_SESSION_CODE_NOT_FOUND");
  });

  it("claims a kiosk, serves session config, and locks the roster to the class", async (t) => {
    if (!schemaReady) return t.skip("migration not applied");
    const claimed = await requestJson("POST", "/passpilot/kiosk/sessions/claim", { claimCode: sessionOne.claimCode, classId: gradeA.id }, authFor(teacherA, schoolA.id));
    assert.equal(claimed.status, 200);
    assert.equal(claimed.body.session.status, "active");
    assert.equal(claimed.body.session.classId, gradeA.id);
    assert.equal(claimed.body.session.className, "Class A");

    // Second claim of the same code loses.
    const doubleClaim = await requestJson("POST", "/passpilot/kiosk/sessions/claim", { claimCode: sessionOne.claimCode, classId: gradeB.id }, authFor(teacherB, schoolA.id));
    assert.equal(doubleClaim.status, 404);

    const config = await requestJson("GET", `/passpilot/kiosk/config?school=${schoolA.id}`, undefined, kioskHeaders(schoolA.id, sessionOne.id));
    assert.equal(config.status, 200);
    assert.equal(config.body.session.status, "active");
    assert.equal(config.body.classId, gradeA.id);
    assert.equal(config.body.className, "Class A");
    assert.equal(config.body.kioskName, "Room 204");
    assert.equal(config.body.kioskStyle, "simple");

    // The school-wide kiosk style rides every config and session response so
    // open kiosks self-redirect when an admin flips it. Assert the flipped
    // (non-default) value on each branch a redirected device actually hits:
    // claimed /config, unclaimed /config, POST /session create, and POST
    // /session resume (the exact response a kiosk presenting its carried
    // session id receives after the hop).
    await asSystem(() =>
      db.execute(sql`UPDATE schools SET kiosk_style = 'badge' WHERE id = ${schoolA.id}`)
    );
    try {
      const badgeConfig = await requestJson("GET", `/passpilot/kiosk/config?school=${schoolA.id}`, undefined, kioskHeaders(schoolA.id, sessionOne.id));
      assert.equal(badgeConfig.status, 200);
      assert.equal(badgeConfig.body.kioskStyle, "badge");

      const badgeCreated = await requestJson("POST", "/passpilot/kiosk/session", {}, kioskHeaders(schoolA.id));
      assert.equal(badgeCreated.status, 201);
      assert.equal(badgeCreated.body.kioskStyle, "badge");

      const badgeResumed = await requestJson("POST", "/passpilot/kiosk/session", {}, kioskHeaders(schoolA.id, badgeCreated.body.session.id));
      assert.equal(badgeResumed.status, 200);
      assert.equal(badgeResumed.body.session.id, badgeCreated.body.session.id);
      assert.equal(badgeResumed.body.kioskStyle, "badge");

      const badgeUnclaimed = await requestJson("GET", `/passpilot/kiosk/config?school=${schoolA.id}`, undefined, kioskHeaders(schoolA.id, badgeCreated.body.session.id));
      assert.equal(badgeUnclaimed.status, 200);
      assert.equal(badgeUnclaimed.body.session.status, "unclaimed");
      assert.equal(badgeUnclaimed.body.kioskStyle, "badge");
    } finally {
      await asSystem(() =>
        db.execute(sql`UPDATE schools SET kiosk_style = 'simple' WHERE id = ${schoolA.id}`)
      );
    }

    const roster = await requestJson("GET", `/passpilot/kiosk/students?school=${schoolA.id}&gradeId=${gradeA.id}`, undefined, kioskHeaders(schoolA.id, sessionOne.id));
    assert.equal(roster.status, 200);
    assert.ok(roster.body.students.some((s: any) => s.id === studentA.id));

    const wrongClass = await requestJson("GET", `/passpilot/kiosk/students?school=${schoolA.id}&gradeId=${gradeB.id}`, undefined, kioskHeaders(schoolA.id, sessionOne.id));
    assert.equal(wrongClass.status, 409);
    assert.equal(wrongClass.body.code, "PASSPILOT_KIOSK_CLASS_CHANGED");
  });

  it("attributes kiosk passes to the session teacher with the membership kiosk name", async (t) => {
    if (!schemaReady) return t.skip("migration not applied");
    const checkout = await requestJson("POST", "/passpilot/kiosk/checkout", { studentId: studentA.id, destination: "bathroom", classId: gradeA.id }, kioskHeaders(schoolA.id, sessionOne.id));
    assert.equal(checkout.status, 201);
    assert.equal(checkout.body.pass.teacherId, teacherA.id);
    assert.equal(checkout.body.pass.issuedVia, "kiosk");
    assert.equal(checkout.body.pass.notes, "Class A Room 204");

    const checkin = await requestJson("POST", "/passpilot/kiosk/checkin", { studentId: studentA.id }, kioskHeaders(schoolA.id, sessionOne.id));
    assert.equal(checkin.status, 200);
    assert.equal(checkin.body.pass.status, "returned");
  });

  let sessionTwo: any;

  it("retargets all of a teacher's kiosks at once and rejects stale checkout classes", async (t) => {
    if (!schemaReady) return t.skip("migration not applied");
    const created = await requestJson("POST", "/passpilot/kiosk/session", {}, kioskHeaders(schoolA.id));
    assert.equal(created.status, 201);
    sessionTwo = created.body.session;
    const claimed = await requestJson("POST", "/passpilot/kiosk/sessions/claim", { claimCode: sessionTwo.claimCode, classId: gradeA.id }, authFor(teacherA, schoolA.id));
    assert.equal(claimed.status, 200);

    const mine = await requestJson("GET", "/passpilot/kiosk/sessions/mine", undefined, authFor(teacherA, schoolA.id));
    assert.equal(mine.status, 200);
    assert.equal(mine.body.sessions.length, 2);

    const retarget = await requestJson("POST", "/passpilot/kiosk/sessions/retarget", { classId: gradeB.id }, authFor(teacherA, schoolA.id));
    assert.equal(retarget.status, 200);
    assert.equal(retarget.body.updated, 2);
    assert.ok(retarget.body.sessions.every((s: any) => s.classId === gradeB.id));

    // A kiosk that has not yet seen the retarget still submits the old class.
    const stale = await requestJson("POST", "/passpilot/kiosk/checkout", { studentId: studentA.id, destination: "bathroom", classId: gradeA.id }, kioskHeaders(schoolA.id, sessionOne.id));
    assert.equal(stale.status, 400);
    assert.equal(stale.body.code, "PASSPILOT_KIOSK_CLASS_CHANGED");

    // Unrelated teachers cannot retarget classes they don't teach.
    const denied = await requestJson("POST", "/passpilot/kiosk/sessions/retarget", { classId: gradeA.id }, authFor(unrelatedTeacher, schoolA.id));
    assert.equal(denied.status, 403);
  });

  it("releases kiosks individually; released sessions expire and mint new codes", async (t) => {
    if (!schemaReady) return t.skip("migration not applied");
    // Owner-scoped: another teacher cannot release teacherA's kiosk.
    const foreign = await requestJson("DELETE", `/passpilot/kiosk/sessions/${sessionTwo.id}`, {}, authFor(teacherB, schoolA.id));
    assert.equal(foreign.status, 404);

    const release = await requestJson("DELETE", `/passpilot/kiosk/sessions/${sessionTwo.id}`, {}, authFor(teacherA, schoolA.id));
    assert.equal(release.status, 200);

    const gone = await requestJson("GET", `/passpilot/kiosk/config?school=${schoolA.id}`, undefined, kioskHeaders(schoolA.id, sessionTwo.id));
    assert.equal(gone.status, 404);
    assert.equal(gone.body.code, "PASSPILOT_KIOSK_SESSION_EXPIRED");

    // The surviving kiosk is unaffected.
    const survivor = await requestJson("GET", `/passpilot/kiosk/config?school=${schoolA.id}`, undefined, kioskHeaders(schoolA.id, sessionOne.id));
    assert.equal(survivor.status, 200);
    assert.equal(survivor.body.classId, gradeB.id);

    // A dead presented session mints a fresh one with a different code.
    const fresh = await requestJson("POST", "/passpilot/kiosk/session", {}, kioskHeaders(schoolA.id, sessionTwo.id));
    assert.equal(fresh.status, 201);
    assert.notEqual(fresh.body.session.id, sessionTwo.id);
  });

  it("creates auto-claimed self sessions for teacher-launched kiosks", async (t) => {
    if (!schemaReady) return t.skip("migration not applied");
    const self = await requestJson("POST", "/passpilot/kiosk/sessions/self", { classId: gradeB.id }, authFor(teacherB, schoolA.id));
    assert.equal(self.status, 201);
    assert.equal(self.body.session.status, "active");
    assert.equal(self.body.session.classId, gradeB.id);

    // displayName fallback when the membership has no kiosk name.
    const config = await requestJson("GET", `/passpilot/kiosk/config?school=${schoolA.id}`, undefined, kioskHeaders(schoolA.id, self.body.session.id));
    assert.equal(config.status, 200);
    assert.equal(config.body.kioskName, "Mr. B");

    const classless = await requestJson("POST", "/passpilot/kiosk/sessions/self", {}, authFor(teacherB, schoolA.id));
    assert.equal(classless.status, 201);
    assert.equal(classless.body.session.classId, null);
    const classlessConfig = await requestJson("GET", `/passpilot/kiosk/config?school=${schoolA.id}`, undefined, kioskHeaders(schoolA.id, classless.body.session.id));
    assert.equal(classlessConfig.status, 200);
    assert.equal(classlessConfig.body.classId, null);
    const classlessCheckout = await requestJson("POST", "/passpilot/kiosk/checkout", { studentId: studentA.id, destination: "bathroom" }, kioskHeaders(schoolA.id, classless.body.session.id));
    assert.equal(classlessCheckout.status, 409);
    assert.equal(classlessCheckout.body.code, "PASSPILOT_KIOSK_CLASS_REQUIRED");
  });

  it("keeps the legacy school-global flow for headerless kiosk clients", async (t) => {
    if (!schemaReady) return t.skip("migration not applied");
    await inSchool(schoolA.id, () =>
      storage.updateLegacyKioskClass(schoolA.id, gradeA.id, adminA.id, true)
    );
    const config = await requestJson("GET", `/passpilot/kiosk/config?school=${schoolA.id}`, undefined, kioskHeaders(schoolA.id));
    assert.equal(config.status, 200);
    assert.equal(config.body.gradeId, gradeA.id);
    assert.equal(config.body.session, undefined);

    const roster = await requestJson("GET", `/passpilot/kiosk/students?school=${schoolA.id}&gradeId=${gradeA.id}`, undefined, kioskHeaders(schoolA.id));
    assert.equal(roster.status, 200);
  });

  it("expires unclaimed sessions after their TTL and sweeps them", async (t) => {
    if (!schemaReady) return t.skip("migration not applied");
    const created = await requestJson("POST", "/passpilot/kiosk/session", {}, kioskHeaders(schoolA.id));
    const stale = created.body.session;
    await asSystem(() =>
      db.execute(sql`UPDATE passpilot_kiosk_sessions SET created_at = now() - interval '3 hours' WHERE id = ${stale.id}`)
    );
    const config = await requestJson("GET", `/passpilot/kiosk/config?school=${schoolA.id}`, undefined, kioskHeaders(schoolA.id, stale.id));
    assert.equal(config.status, 404);
    assert.equal(config.body.code, "PASSPILOT_KIOSK_SESSION_EXPIRED");

    const claim = await requestJson("POST", "/passpilot/kiosk/sessions/claim", { claimCode: stale.claimCode, classId: gradeA.id }, authFor(teacherA, schoolA.id));
    assert.equal(claim.status, 404);
  });

  it("guards membership deactivation or auto-releases the teacher's live kiosk sessions", async (t) => {
    if (!schemaReady) return t.skip("migration not applied");
    const selfOne = await requestJson("POST", "/passpilot/kiosk/sessions/self", { classId: gradeB.id }, authFor(teacherB, schoolA.id));
    const selfTwo = await requestJson("POST", "/passpilot/kiosk/sessions/self", { classId: gradeB.id }, authFor(teacherB, schoolA.id));
    assert.equal(selfOne.status, 201);
    assert.equal(selfTwo.status, 201);
    try {
      if (staffLifecycleGuardInstalled) {
        // Stage-five integrity makes an ownerless live session impossible, so
        // lifecycle transitions must resolve these dependencies first.
        await assert.rejects(
          asSystem(() =>
            db.execute(sql`UPDATE school_memberships SET status = 'inactive' WHERE school_id = ${schoolA.id} AND user_id = ${teacherB.id}`)
          ),
          (error) =>
            error instanceof Error &&
            error.cause instanceof Error &&
            error.cause.message.includes("STAFF_ASSIGNMENTS_REQUIRE_REASSIGNMENT")
        );
        const liveSessions = await asSystem<{ rows: Array<{ count: number }> }>(() => db.execute(sql`
          SELECT count(*)::integer AS count
          FROM passpilot_kiosk_sessions
          WHERE id IN (${selfOne.body.session.id}, ${selfTwo.body.session.id})
            AND status <> 'released'
        `));
        assert.equal(liveSessions.rows[0]?.count, 2);
        const firstConfig = await requestJson("GET", `/passpilot/kiosk/config?school=${schoolA.id}`, undefined, kioskHeaders(schoolA.id, selfOne.body.session.id));
        const secondConfig = await requestJson("GET", `/passpilot/kiosk/config?school=${schoolA.id}`, undefined, kioskHeaders(schoolA.id, selfTwo.body.session.id));
        assert.equal(firstConfig.status, 200);
        assert.equal(secondConfig.status, 200);
      } else {
        // Drizzle-push test databases do not install the stage-five constraint
        // triggers. Preserve the endpoint's defense-in-depth behavior there.
        await asSystem(() =>
          db.execute(sql`UPDATE school_memberships SET status = 'inactive' WHERE school_id = ${schoolA.id} AND user_id = ${teacherB.id}`)
        );
        const lookup = await requestJson("POST", "/passpilot/kiosk/lookup", { studentIdNumber: "12345" }, kioskHeaders(schoolA.id, selfOne.body.session.id));
        assert.equal(lookup.status, 404);
        assert.equal(lookup.body.code, "PASSPILOT_KIOSK_SESSION_EXPIRED");
        const config = await requestJson("GET", `/passpilot/kiosk/config?school=${schoolA.id}`, undefined, kioskHeaders(schoolA.id, selfTwo.body.session.id));
        assert.equal(config.status, 404);
        assert.equal(config.body.code, "PASSPILOT_KIOSK_SESSION_EXPIRED");
      }
    } finally {
      await asSystem(async () => {
        await db.transaction(async (tx: typeof db) => {
          await tx.execute(sql`
            UPDATE passpilot_kiosk_sessions
            SET status = 'released', released_at = now()
            WHERE id IN (${selfOne.body.session.id}, ${selfTwo.body.session.id})
          `);
          await tx.execute(sql`
            UPDATE school_memberships
            SET status = 'active'
            WHERE school_id = ${schoolA.id}
              AND user_id = ${teacherB.id}
          `);
        });
      });
    }
  });

  it("supports the full canonical (ClassPilot-groups) session flow", async (t) => {
    if (!schemaReady) return t.skip("migration not applied");
    const created = await requestJson("POST", "/passpilot/kiosk/session", {}, kioskHeaders(schoolC.id));
    assert.equal(created.status, 201);
    const kioskSession = created.body.session;

    const claimed = await requestJson("POST", "/passpilot/kiosk/sessions/claim", { claimCode: kioskSession.claimCode, classId: canonicalGroup.id }, authFor(teacherC, schoolC.id));
    assert.equal(claimed.status, 200);
    assert.equal(claimed.body.session.source, "classpilot_groups");
    assert.equal(claimed.body.session.classId, canonicalGroup.id);

    const config = await requestJson("GET", `/passpilot/kiosk/config?school=${schoolC.id}`, undefined, kioskHeaders(schoolC.id, kioskSession.id));
    assert.equal(config.status, 200);
    assert.equal(config.body.source, "classpilot_groups");
    assert.equal(config.body.classId, canonicalGroup.id);
    assert.equal(config.body.className, "Homeroom 6C");
    assert.equal(config.body.kioskName, "Ms. C");

    const roster = await requestJson("GET", `/passpilot/kiosk/students?school=${schoolC.id}&classId=${canonicalGroup.id}`, undefined, kioskHeaders(schoolC.id, kioskSession.id));
    assert.equal(roster.status, 200);
    assert.ok(roster.body.students.some((s: any) => s.id === studentC.id));

    // Canonical checkout via the session: exercises the in-transaction
    // classpilotGroupId comparison in assertKioskSessionCheckoutTarget.
    const checkout = await requestJson("POST", "/passpilot/kiosk/checkout", { studentId: studentC.id, destination: "bathroom", classId: canonicalGroup.id }, kioskHeaders(schoolC.id, kioskSession.id));
    assert.equal(checkout.status, 201);
    assert.equal(checkout.body.pass.teacherId, teacherC.id);
    assert.equal(checkout.body.pass.classId, canonicalGroup.id);
    assert.equal(checkout.body.pass.notes, "Homeroom 6C Ms. C");

    const checkin = await requestJson("POST", "/passpilot/kiosk/checkin", { studentId: studentC.id }, kioskHeaders(schoolC.id, kioskSession.id));
    assert.equal(checkin.status, 200);
    assert.equal(checkin.body.pass.status, "returned");

    // The class-inactive 409 must still carry the school kiosk style: parked
    // kiosks only ever see this response, and it is their sole signal to hop
    // after an admin flips the style.
    await asSystem(() =>
      db.execute(sql`UPDATE groups SET status = 'archived' WHERE id = ${canonicalGroup.id}`)
    );
    try {
      const inactive = await requestJson("GET", `/passpilot/kiosk/config?school=${schoolC.id}`, undefined, kioskHeaders(schoolC.id, kioskSession.id));
      assert.equal(inactive.status, 409);
      assert.equal(inactive.body.code, "PASSPILOT_KIOSK_CLASS_INACTIVE");
      assert.equal(inactive.body.kioskStyle, "simple");
    } finally {
      await asSystem(() =>
        db.execute(sql`UPDATE groups SET status = 'active' WHERE id = ${canonicalGroup.id}`)
      );
    }
  });

  it("scopes single-session retarget (PUT /sessions/:id) to owner or manager", async (t) => {
    if (!schemaReady) return t.skip("migration not applied");
    const self = await requestJson("POST", "/passpilot/kiosk/sessions/self", { classId: gradeB.id }, authFor(teacherA, schoolA.id));
    assert.equal(self.status, 201);
    const sessionId = self.body.session.id;

    // Non-owner teacher must get 404, never a silent cross-teacher retarget.
    const foreign = await requestJson("PUT", `/passpilot/kiosk/sessions/${sessionId}`, { classId: gradeB.id }, authFor(teacherB, schoolA.id));
    assert.equal(foreign.status, 404);

    // The owner can retarget a single kiosk.
    const own = await requestJson("PUT", `/passpilot/kiosk/sessions/${sessionId}`, { classId: gradeA.id }, authFor(teacherA, schoolA.id));
    assert.equal(own.status, 200);
    assert.equal(own.body.session.classId, gradeA.id);

    // Managers may retarget any teacher's kiosk.
    const manager = await requestJson("PUT", `/passpilot/kiosk/sessions/${sessionId}`, { classId: gradeB.id }, authFor(adminA, schoolA.id));
    assert.equal(manager.status, 200);
    assert.equal(manager.body.session.classId, gradeB.id);

    await requestJson("DELETE", `/passpilot/kiosk/sessions/${sessionId}`, {}, authFor(adminA, schoolA.id));
  });

  it("expires idle active sessions after the last-seen TTL and sweeps them", async (t) => {
    if (!schemaReady) return t.skip("migration not applied");
    const self = await requestJson("POST", "/passpilot/kiosk/sessions/self", { classId: gradeB.id }, authFor(teacherA, schoolA.id));
    assert.equal(self.status, 201);
    const idleId = self.body.session.id;
    await asSystem(() =>
      db.execute(sql`UPDATE passpilot_kiosk_sessions SET last_seen_at = now() - interval '21 hours' WHERE id = ${idleId}`)
    );
    const config = await requestJson("GET", `/passpilot/kiosk/config?school=${schoolA.id}`, undefined, kioskHeaders(schoolA.id, idleId));
    assert.equal(config.status, 404);
    assert.equal(config.body.code, "PASSPILOT_KIOSK_SESSION_EXPIRED");

    // The next bootstrap sweeps the idle corpse entirely.
    await requestJson("POST", "/passpilot/kiosk/session", {}, kioskHeaders(schoolA.id));
    const remaining = await asSystem(() =>
      db.execute(sql`SELECT count(*)::int AS n FROM passpilot_kiosk_sessions WHERE id = ${idleId}`)
    );
    assert.equal(remaining.rows[0].n, 0);
  });

  it("blocks everything when kiosk mode is disabled and resumes after re-enable", async (t) => {
    if (!schemaReady) return t.skip("migration not applied");
    await asSystem(() =>
      db.execute(sql`UPDATE schools SET kiosk_enabled = false WHERE id = ${schoolA.id}`)
    );
    const blocked = await requestJson("POST", "/passpilot/kiosk/session", {}, kioskHeaders(schoolA.id, sessionOne.id));
    assert.equal(blocked.status, 403);
    await asSystem(() =>
      db.execute(sql`UPDATE schools SET kiosk_enabled = true WHERE id = ${schoolA.id}`)
    );
    const resumed = await requestJson("POST", "/passpilot/kiosk/session", {}, kioskHeaders(schoolA.id, sessionOne.id));
    assert.equal(resumed.status, 200);
    assert.equal(resumed.body.session.id, sessionOne.id);
  });

  it("invalidates legacy-bound sessions on class-model cutover instead of remapping", async (t) => {
    if (!schemaReady) return t.skip("migration not applied");
    await asSystem(() =>
      db.execute(sql`UPDATE settings SET passpilot_class_source = 'classpilot_groups' WHERE school_id = ${schoolA.id}`)
    );
    try {
      const config = await requestJson("GET", `/passpilot/kiosk/config?school=${schoolA.id}`, undefined, kioskHeaders(schoolA.id, sessionOne.id));
      assert.equal(config.status, 404);
      assert.equal(config.body.code, "PASSPILOT_KIOSK_SESSION_EXPIRED");
    } finally {
      await asSystem(() =>
        db.execute(sql`UPDATE settings SET passpilot_class_source = 'legacy_grades' WHERE school_id = ${schoolA.id}`)
      );
    }
  });
});

// ============================================================================
// Kiosk device memory: durable device → teacher bindings + one-tap resume
// ============================================================================
const DEV1 = "11111111-1111-4111-8111-111111111111";
const DEV4 = "44444444-4444-4444-8444-444444444444";

function deviceHeaders(
  schoolId: string,
  deviceId: string | null,
  sessionId?: string
): Record<string, string> {
  return {
    ...kioskHeaders(schoolId, sessionId),
    ...(deviceId ? { "x-kiosk-device": deviceId } : {}),
  };
}

async function bindingRow(schoolId: string, deviceId: string): Promise<any | undefined> {
  const result = await asSystem(() =>
    db.execute(sql`SELECT * FROM passpilot_kiosk_devices WHERE school_id = ${schoolId} AND id = ${deviceId}`)
  );
  return (result as any).rows[0];
}

describe("PassPilot kiosk device memory", { concurrency: false }, () => {
  let bootSession: any;
  let handoffSessionId: string;

  it("stamps device_id on bootstrap and offers no resume without a binding", async (t) => {
    if (!schemaReady) return t.skip("migration not applied");
    const created = await requestJson("POST", "/passpilot/kiosk/session", {}, deviceHeaders(schoolA.id, DEV1));
    assert.equal(created.status, 201);
    assert.equal(created.body.resume, null);
    bootSession = created.body.session;
    const stored = await asSystem(() =>
      db.execute(sql`SELECT device_id FROM passpilot_kiosk_sessions WHERE id = ${bootSession.id}`)
    );
    assert.equal((stored as any).rows[0].device_id, DEV1);
  });

  it("writes the binding on claim; a fresh boot offers the remembered teacher", async (t) => {
    if (!schemaReady) return t.skip("migration not applied");
    const claimed = await requestJson(
      "POST",
      "/passpilot/kiosk/sessions/claim",
      { claimCode: bootSession.claimCode, classId: gradeA.id },
      authFor(teacherA, schoolA.id)
    );
    assert.equal(claimed.status, 200);
    const binding = await bindingRow(schoolA.id, DEV1);
    assert.ok(binding, "claim must upsert the device binding");
    assert.equal(binding.teacher_id, teacherA.id);
    assert.equal(binding.class_source, "legacy_grades");
    assert.equal(binding.grade_id, gradeA.id);

    // Next morning: no stored session, same device.
    const fresh = await requestJson("POST", "/passpilot/kiosk/session", {}, deviceHeaders(schoolA.id, DEV1));
    assert.equal(fresh.status, 201);
    assert.equal(fresh.body.session.status, "unclaimed");
    assert.deepEqual(fresh.body.resume, { kioskName: "Room 204", className: "Class A" });

    // Header value is case-normalized before lookup.
    const upper = await requestJson("POST", "/passpilot/kiosk/session", {}, deviceHeaders(schoolA.id, DEV1.toUpperCase(), fresh.body.session.id));
    assert.equal(upper.status, 200);
    assert.deepEqual(upper.body.resume, { kioskName: "Room 204", className: "Class A" });
  });

  it("one-tap resume mints an active session and releases the device's other sessions", async (t) => {
    if (!schemaReady) return t.skip("migration not applied");
    const before = await bindingRow(schoolA.id, DEV1);
    const resumed = await requestJson("POST", "/passpilot/kiosk/session/resume", undefined, deviceHeaders(schoolA.id, DEV1));
    assert.equal(resumed.status, 201, JSON.stringify(resumed.body));
    assert.equal(resumed.body.session.status, "active");
    assert.equal(resumed.body.session.kioskName, "Room 204");
    assert.equal(resumed.body.session.className, "Class A");
    assert.equal(resumed.body.session.classId, gradeA.id);
    assert.equal(resumed.body.kioskStyle, "simple");

    const live = await asSystem(() =>
      db.execute(sql`SELECT count(*)::integer AS count FROM passpilot_kiosk_sessions WHERE school_id = ${schoolA.id} AND device_id = ${DEV1} AND status <> 'released'`)
    );
    assert.equal((live as any).rows[0].count, 1, "exactly one live session per device after resume");
    const after = await bindingRow(schoolA.id, DEV1);
    assert.ok(new Date(after.last_used_at) > new Date(before.last_used_at), "resume refreshes the rolling TTL");

    // The resume is the feature's main abuse surface (a PIN holder minting a
    // teacher-bound session with no teacher present) — it must leave a
    // forensic trail.
    const audit = await asSystem(() =>
      db.execute(sql`SELECT changes FROM audit_logs WHERE school_id = ${schoolA.id} AND action = 'passpilot.kiosk.session_resumed' AND entity_id = ${resumed.body.session.id}`)
    );
    assert.equal((audit as any).rows.length, 1, "resume must write an audit entry");
    assert.equal((audit as any).rows[0].changes.deviceId, DEV1);
    assert.equal((audit as any).rows[0].changes.teacherId, teacherA.id);
  });

  it("requires the PIN for resume and leaks nothing on failure", async (t) => {
    if (!schemaReady) return t.skip("migration not applied");
    const badPin = await requestJson("POST", "/passpilot/kiosk/session/resume", undefined, {
      "x-school-id": schoolA.id,
      "x-kiosk-pin": "0000",
      "x-kiosk-device": DEV1,
      "x-passpilot-class-model": "classpilot-groups-v1",
    });
    assert.equal(badPin.status, 401);
    assert.doesNotMatch(JSON.stringify(badPin.body), /Room 204|Class A/);
  });

  it("returns DEVICE_UNKNOWN for unknown, malformed, or missing device ids", async (t) => {
    if (!schemaReady) return t.skip("migration not applied");
    for (const deviceId of ["99999999-9999-4999-8999-999999999999", "not-a-uuid", null]) {
      const resumed = await requestJson("POST", "/passpilot/kiosk/session/resume", undefined, deviceHeaders(schoolA.id, deviceId));
      assert.equal(resumed.status, 404, String(deviceId));
      assert.equal(resumed.body.code, "PASSPILOT_KIOSK_DEVICE_UNKNOWN");
    }
  });

  it("self-heals the binding when the teacher is no longer active staff", async (t) => {
    if (!schemaReady) return t.skip("migration not applied");
    await asSystem(async () => {
      await db.transaction(async (tx: typeof db) => {
        await tx.execute(sql`
          UPDATE passpilot_kiosk_sessions
          SET status = 'released', released_at = now()
          WHERE school_id = ${schoolA.id}
            AND teacher_id = ${teacherA.id}
            AND status <> 'released'
        `);
        await tx.execute(sql`
          DELETE FROM teacher_grades
          WHERE teacher_id = ${teacherA.id}
            AND grade_id IN (${gradeA.id}, ${gradeB.id})
        `);
        await tx.execute(sql`
          UPDATE school_memberships
          SET status = 'inactive'
          WHERE school_id = ${schoolA.id}
            AND user_id = ${teacherA.id}
        `);
      });
    });
    try {
      const resumed = await requestJson("POST", "/passpilot/kiosk/session/resume", undefined, deviceHeaders(schoolA.id, DEV1));
      assert.equal(resumed.status, 404);
      assert.equal(resumed.body.code, "PASSPILOT_KIOSK_DEVICE_UNKNOWN");
      assert.equal(await bindingRow(schoolA.id, DEV1), undefined, "stale binding must be deleted");
      const boot = await requestJson("POST", "/passpilot/kiosk/session", {}, deviceHeaders(schoolA.id, DEV1));
      assert.equal(boot.body.resume, null);
    } finally {
      await asSystem(async () => {
        await db.transaction(async (tx: typeof db) => {
          await tx.execute(sql`
            UPDATE school_memberships
            SET status = 'active'
            WHERE school_id = ${schoolA.id}
              AND user_id = ${teacherA.id}
          `);
          await tx.execute(sql`
            INSERT INTO teacher_grades (teacher_id, grade_id)
            VALUES (${teacherA.id}, ${gradeA.id}), (${teacherA.id}, ${gradeB.id})
            ON CONFLICT DO NOTHING
          `);
        });
      });
    }
  });

  it("degrades to a classless resume when the remembered class goes stale", async (t) => {
    if (!schemaReady) return t.skip("migration not applied");
    // Rebuild the binding (deleted by the previous self-heal case).
    const boot = await requestJson("POST", "/passpilot/kiosk/session", {}, deviceHeaders(schoolA.id, DEV1));
    const claimed = await requestJson(
      "POST",
      "/passpilot/kiosk/sessions/claim",
      { claimCode: boot.body.session.claimCode, classId: gradeA.id },
      authFor(teacherA, schoolA.id)
    );
    assert.equal(claimed.status, 200);

    // History-only legacy class → classless resume, binding class untouched.
    const priorState = await asSystem(() =>
      db.execute(sql`SELECT migration_state FROM grades WHERE id = ${gradeA.id}`)
    );
    const originalMigrationState = (priorState as any).rows[0].migration_state;
    await asSystem(() =>
      db.execute(sql`UPDATE grades SET migration_state = 'history_only' WHERE id = ${gradeA.id}`)
    );
    try {
      const resumed = await requestJson("POST", "/passpilot/kiosk/session/resume", undefined, deviceHeaders(schoolA.id, DEV1));
      assert.equal(resumed.status, 201, JSON.stringify(resumed.body));
      assert.equal(resumed.body.session.status, "active");
      assert.equal(resumed.body.session.classId, null);
      assert.equal(resumed.body.session.className, null);
    } finally {
      await asSystem(() =>
        db.execute(sql`UPDATE grades SET migration_state = ${originalMigrationState} WHERE id = ${gradeA.id}`)
      );
    }
    const binding = await bindingRow(schoolA.id, DEV1);
    assert.equal(binding.grade_id, gradeA.id, "degraded resume must not erase the remembered class");

    // Class-source cutover → classless resume too.
    await asSystem(() =>
      db.execute(sql`UPDATE settings SET passpilot_class_source = 'classpilot_groups' WHERE school_id = ${schoolA.id}`)
    );
    try {
      const resumed = await requestJson("POST", "/passpilot/kiosk/session/resume", undefined, deviceHeaders(schoolA.id, DEV1));
      assert.equal(resumed.status, 201);
      assert.equal(resumed.body.session.classId, null);
    } finally {
      await asSystem(() =>
        db.execute(sql`UPDATE settings SET passpilot_class_source = 'legacy_grades' WHERE school_id = ${schoolA.id}`)
      );
    }
  });

  it("stops offering after the 60-day rolling TTL and sweeps the binding", async (t) => {
    if (!schemaReady) return t.skip("migration not applied");
    await asSystem(() =>
      db.execute(sql`UPDATE passpilot_kiosk_devices SET last_used_at = now() - interval '61 days' WHERE school_id = ${schoolA.id} AND id = ${DEV1}`)
    );
    const boot = await requestJson("POST", "/passpilot/kiosk/session", {}, deviceHeaders(schoolA.id, DEV1));
    assert.equal(boot.body.resume, null);
    // The bootstrap's lazy sweep must have deleted the idle binding.
    assert.equal(await bindingRow(schoolA.id, DEV1), undefined);
    const resumed = await requestJson("POST", "/passpilot/kiosk/session/resume", undefined, deviceHeaders(schoolA.id, DEV1));
    assert.equal(resumed.status, 404);
  });

  it("scopes bindings per school: another tenant's PIN cannot resume this device", async (t) => {
    if (!schemaReady) return t.skip("migration not applied");
    // Fresh binding at school A.
    const boot = await requestJson("POST", "/passpilot/kiosk/session", {}, deviceHeaders(schoolA.id, DEV1));
    const claimed = await requestJson(
      "POST",
      "/passpilot/kiosk/sessions/claim",
      { claimCode: boot.body.session.claimCode, classId: gradeA.id },
      authFor(teacherA, schoolA.id)
    );
    assert.equal(claimed.status, 200);

    const crossResume = await requestJson("POST", "/passpilot/kiosk/session/resume", undefined, deviceHeaders(schoolB.id, DEV1));
    assert.equal(crossResume.status, 404);
    assert.equal(crossResume.body.code, "PASSPILOT_KIOSK_DEVICE_UNKNOWN");
    const crossBoot = await requestJson("POST", "/passpilot/kiosk/session", {}, deviceHeaders(schoolB.id, DEV1));
    assert.equal(crossBoot.body.resume, null);
  });

  it("adopts the device on the self-launch handoff and binds the session's teacher", async (t) => {
    if (!schemaReady) return t.skip("migration not applied");
    const self = await requestJson("POST", "/passpilot/kiosk/sessions/self", { classId: gradeB.id }, authFor(teacherB, schoolA.id));
    assert.equal(self.status, 201);
    handoffSessionId = self.body.session.id;
    const handoff = await requestJson("POST", "/passpilot/kiosk/session", {}, deviceHeaders(schoolA.id, DEV4, self.body.session.id));
    assert.equal(handoff.status, 200);
    const stored = await asSystem(() =>
      db.execute(sql`SELECT device_id FROM passpilot_kiosk_sessions WHERE id = ${self.body.session.id}`)
    );
    assert.equal((stored as any).rows[0].device_id, DEV4);
    const binding = await bindingRow(schoolA.id, DEV4);
    assert.equal(binding.teacher_id, teacherB.id);
    assert.equal(binding.grade_id, gradeB.id);

    // No membership kiosk name → account display name fallback in the offer.
    const fresh = await requestJson("POST", "/passpilot/kiosk/session", {}, deviceHeaders(schoolA.id, DEV4));
    assert.deepEqual(fresh.body.resume, { kioskName: "Mr. B", className: "Class B" });

    // Idempotent re-adoption must not corrupt the binding.
    const again = await requestJson("POST", "/passpilot/kiosk/session", {}, deviceHeaders(schoolA.id, DEV4, self.body.session.id));
    assert.equal(again.status, 200);
    assert.equal((await bindingRow(schoolA.id, DEV4)).teacher_id, teacherB.id);
  });

  it("refreshes the binding on retargets without rebinding to a manager actor", async (t) => {
    if (!schemaReady) return t.skip("migration not applied");
    // Target the device-adopted handoff session specifically — teacherB also
    // has older device-less self sessions from the sibling suite.
    assert.ok(handoffSessionId, "handoff test must have run first");
    const managerRetarget = await requestJson(
      "PUT",
      `/passpilot/kiosk/sessions/${handoffSessionId}`,
      { classId: gradeA.id },
      authFor(adminA, schoolA.id)
    );
    assert.equal(managerRetarget.status, 200, JSON.stringify(managerRetarget.body));
    const binding = await bindingRow(schoolA.id, DEV4);
    assert.equal(binding.teacher_id, teacherB.id, "manager retarget must keep the session's teacher");
    assert.equal(binding.grade_id, gradeA.id, "manager retarget must refresh the remembered class");

    // Bulk retarget-all refreshes the binding too (the loop over returned
    // sessions with device ids).
    const bulk = await requestJson(
      "POST",
      "/passpilot/kiosk/sessions/retarget",
      { classId: gradeB.id },
      authFor(teacherB, schoolA.id)
    );
    assert.equal(bulk.status, 200, JSON.stringify(bulk.body));
    const afterBulk = await bindingRow(schoolA.id, DEV4);
    assert.equal(afterBulk.teacher_id, teacherB.id);
    assert.equal(afterBulk.grade_id, gradeB.id, "bulk retarget must refresh the remembered class");
  });

  it("degrades to a classless resume when the bound teacher loses class access", async (t) => {
    if (!schemaReady) return t.skip("migration not applied");
    // DEV1 is bound to teacherA/gradeA (re-established by the cross-school
    // test). Remove teacherA's access to gradeA — the class stays alive for
    // everyone else, so this pins the {actorUserId: teacher, manager: false}
    // authorization contract specifically.
    await asSystem(() =>
      db.execute(sql`DELETE FROM teacher_grades WHERE teacher_id = ${teacherA.id} AND grade_id = ${gradeA.id}`)
    );
    try {
      const resumed = await requestJson("POST", "/passpilot/kiosk/session/resume", undefined, deviceHeaders(schoolA.id, DEV1));
      assert.equal(resumed.status, 201, JSON.stringify(resumed.body));
      assert.equal(resumed.body.session.status, "active");
      assert.equal(resumed.body.session.classId, null, "revoked class access must degrade to classless");
    } finally {
      await asSystem(() =>
        db.execute(sql`INSERT INTO teacher_grades (teacher_id, grade_id) VALUES (${teacherA.id}, ${gradeA.id})`)
      );
    }
  });

  it("serializes concurrent resume taps to exactly one live session", async (t) => {
    if (!schemaReady) return t.skip("migration not applied");
    const [first, second] = await Promise.all([
      requestJson("POST", "/passpilot/kiosk/session/resume", undefined, deviceHeaders(schoolA.id, DEV1)),
      requestJson("POST", "/passpilot/kiosk/session/resume", undefined, deviceHeaders(schoolA.id, DEV1)),
    ]);
    assert.equal(first.status, 201, JSON.stringify(first.body));
    assert.equal(second.status, 201, JSON.stringify(second.body));
    const live = await asSystem(() =>
      db.execute(sql`SELECT count(*)::integer AS count FROM passpilot_kiosk_sessions WHERE school_id = ${schoolA.id} AND device_id = ${DEV1} AND status <> 'released'`)
    );
    assert.equal((live as any).rows[0].count, 1, "concurrent resumes must leave exactly one live session");
  });

  it("supports the full canonical (ClassPilot-groups) device-memory flow", async (t) => {
    if (!schemaReady) return t.skip("migration not applied");
    const DEV5 = "55555555-5555-4555-8555-555555555555";
    const boot = await requestJson("POST", "/passpilot/kiosk/session", {}, deviceHeaders(schoolC.id, DEV5));
    assert.equal(boot.status, 201);
    assert.equal(boot.body.resume, null);
    const claimed = await requestJson(
      "POST",
      "/passpilot/kiosk/sessions/claim",
      { claimCode: boot.body.session.claimCode, classId: canonicalGroup.id },
      authFor(teacherC, schoolC.id)
    );
    assert.equal(claimed.status, 200, JSON.stringify(claimed.body));
    const binding = await bindingRow(schoolC.id, DEV5);
    assert.equal(binding.teacher_id, teacherC.id);
    assert.equal(binding.class_source, "classpilot_groups");
    assert.equal(binding.classpilot_group_id, canonicalGroup.id);
    assert.equal(binding.grade_id, null);

    const fresh = await requestJson("POST", "/passpilot/kiosk/session", {}, deviceHeaders(schoolC.id, DEV5));
    assert.deepEqual(fresh.body.resume, { kioskName: "Ms. C", className: "Homeroom 6C" });

    const resumed = await requestJson("POST", "/passpilot/kiosk/session/resume", undefined, deviceHeaders(schoolC.id, DEV5));
    assert.equal(resumed.status, 201, JSON.stringify(resumed.body));
    assert.equal(resumed.body.session.status, "active");
    assert.equal(resumed.body.session.source, "classpilot_groups");
    assert.equal(resumed.body.session.classId, canonicalGroup.id);
    assert.equal(resumed.body.session.className, "Homeroom 6C");
    assert.equal(resumed.body.session.kioskName, "Ms. C");
  });

  it("claims teacher-only (no class): kiosk shows the teacher and waits for Send to Kiosk", async (t) => {
    if (!schemaReady) return t.skip("migration not applied");
    const DEV6 = "66666666-6666-4666-8666-666666666666";
    const boot = await requestJson("POST", "/passpilot/kiosk/session", {}, deviceHeaders(schoolA.id, DEV6));
    assert.equal(boot.status, 201);

    // Claim with ONLY the code — binds the teacher, no class.
    const claimed = await requestJson(
      "POST",
      "/passpilot/kiosk/sessions/claim",
      { claimCode: boot.body.session.claimCode },
      authFor(teacherA, schoolA.id)
    );
    assert.equal(claimed.status, 200, JSON.stringify(claimed.body));
    assert.equal(claimed.body.session.status, "active");
    assert.equal(claimed.body.session.classId, null);

    // The kiosk shows the teacher's name while classless, and data endpoints
    // stay closed until a class arrives.
    const config = await requestJson("GET", `/passpilot/kiosk/config?school=${schoolA.id}`, undefined, deviceHeaders(schoolA.id, DEV6, boot.body.session.id));
    assert.equal(config.status, 200);
    assert.equal(config.body.session.status, "active");
    assert.equal(config.body.classId, null);
    assert.equal(config.body.kioskName, "Room 204");
    const checkout = await requestJson("POST", "/passpilot/kiosk/checkout", { studentId: studentA.id, destination: "bathroom" }, deviceHeaders(schoolA.id, DEV6, boot.body.session.id));
    assert.equal(checkout.status, 409);
    assert.equal(checkout.body.code, "PASSPILOT_KIOSK_CLASS_REQUIRED");

    // The binding remembers the teacher with no class; the resume offer shows
    // the name alone.
    const binding = await bindingRow(schoolA.id, DEV6);
    assert.equal(binding.teacher_id, teacherA.id);
    assert.equal(binding.class_source, null);
    const fresh = await requestJson("POST", "/passpilot/kiosk/session", {}, deviceHeaders(schoolA.id, DEV6));
    assert.deepEqual(fresh.body.resume, { kioskName: "Room 204", className: null });

    // Send to Kiosk (single-session retarget) puts a class on it and
    // refreshes the remembered class.
    const retarget = await requestJson(
      "PUT",
      `/passpilot/kiosk/sessions/${claimed.body.session.id}`,
      { classId: gradeA.id },
      authFor(teacherA, schoolA.id)
    );
    assert.equal(retarget.status, 200, JSON.stringify(retarget.body));
    const afterRetarget = await bindingRow(schoolA.id, DEV6);
    assert.equal(afterRetarget.grade_id, gradeA.id);
    assert.equal(afterRetarget.teacher_id, teacherA.id);
  });

  it("migrates a live session to an upgraded device id only with proof of the old one", async (t) => {
    if (!schemaReady) return t.skip("migration not applied");
    const DEVR = "77777777-7777-4777-8777-777777777777"; // random pre-adoption id
    const DEVM = "88888888-8888-4888-8888-888888888888"; // managed id
    const DEVX = "99999999-9999-4999-8999-999999999998"; // attacker id
    const boot = await requestJson("POST", "/passpilot/kiosk/session", {}, deviceHeaders(schoolA.id, DEVR));
    assert.equal(boot.status, 201);
    const sessionId = boot.body.session.id;

    // No proof → the anti-steal guard keeps the original stamp.
    const steal = await requestJson("POST", "/passpilot/kiosk/session", {}, deviceHeaders(schoolA.id, DEVX, sessionId));
    assert.equal(steal.status, 200);
    let stored = await asSystem(() =>
      db.execute(sql`SELECT device_id FROM passpilot_kiosk_sessions WHERE id = ${sessionId}`)
    );
    assert.equal((stored as any).rows[0].device_id, DEVR, "a foreign device must not re-stamp the session");

    // Wrong proof → still refused.
    const wrongProof = await requestJson("POST", "/passpilot/kiosk/session", {}, {
      ...deviceHeaders(schoolA.id, DEVX, sessionId),
      "x-kiosk-device-prev": DEVM,
    });
    assert.equal(wrongProof.status, 200);
    stored = await asSystem(() =>
      db.execute(sql`SELECT device_id FROM passpilot_kiosk_sessions WHERE id = ${sessionId}`)
    );
    assert.equal((stored as any).rows[0].device_id, DEVR);

    // Correct proof (the session's current id) → migrated to the managed id.
    const migrate = await requestJson("POST", "/passpilot/kiosk/session", {}, {
      ...deviceHeaders(schoolA.id, DEVM, sessionId),
      "x-kiosk-device-prev": DEVR,
    });
    assert.equal(migrate.status, 200);
    stored = await asSystem(() =>
      db.execute(sql`SELECT device_id FROM passpilot_kiosk_sessions WHERE id = ${sessionId}`)
    );
    assert.equal((stored as any).rows[0].device_id, DEVM, "same-device proof must migrate the stamp");

    // A claim after migration keys the binding to the managed id.
    const claimed = await requestJson(
      "POST",
      "/passpilot/kiosk/sessions/claim",
      { claimCode: boot.body.session.claimCode },
      authFor(teacherA, schoolA.id)
    );
    assert.equal(claimed.status, 200, JSON.stringify(claimed.body));
    assert.ok(await bindingRow(schoolA.id, DEVM), "binding must be keyed to the migrated id");
    assert.equal(await bindingRow(schoolA.id, DEVX), undefined);
  });
});

describe("PassPilot kiosk token, snapshot, and health contracts", { concurrency: false }, () => {
  it("bounds the success-only PIN and health limiter primitives", async () => {
    const {
      KioskPinSuccessCache,
      resetPasspilotKioskAuthStateForTests,
      snapshotPasspilotKioskAuthStateForTests,
    } = await import("../dist/services/passpilotKioskAuth.js");
    const {
      BoundedKioskHealthRateLimiter,
      passpilotKioskClientHealthSchema,
      resetPasspilotKioskHealthStateForTests,
      snapshotPasspilotKioskHealthStateForTests,
    } = await import("../dist/services/passpilotKioskHealth.js");

    const pinCache = new KioskPinSuccessCache(4, 100);
    for (let index = 0; index < 5; index += 1) {
      pinCache.remember(`hmac-digest-${index}`, 1_000);
    }
    assert.equal(pinCache.size, 4);
    assert.equal(pinCache.has("hmac-digest-0", 1_001), false);
    assert.equal(pinCache.has("hmac-digest-4", 1_001), true);
    assert.equal(pinCache.has("hmac-digest-4", 1_101), false);

    const healthLimiter = new BoundedKioskHealthRateLimiter(2, 100);
    assert.equal(healthLimiter.accept("scope-a", 1_000), true);
    assert.equal(healthLimiter.accept("scope-a", 1_001), false);
    assert.equal(healthLimiter.accept("scope-b", 1_001), true);
    assert.equal(healthLimiter.accept("scope-c", 1_001), true);
    assert.equal(healthLimiter.size, 2);
    assert.equal(healthLimiter.accept("scope-a", 1_002), true, "oldest key is evicted at the bound");
    assert.equal(healthLimiter.accept("scope-a", 1_103), true, "window expiry permits a new event");

    assert.equal(
      passpilotKioskClientHealthSchema.safeParse({
        event: "snapshot_failure",
        consecutiveFailures: 2,
      }).success,
      false
    );
    assert.equal(
      passpilotKioskClientHealthSchema.safeParse({
        event: "snapshot_recovery",
        consecutiveFailures: 3,
        reason: "network",
      }).success,
      true
    );
    resetPasspilotKioskAuthStateForTests();
    assert.deepEqual(snapshotPasspilotKioskAuthStateForTests(), {
      pinSuccessCacheSize: 0,
      pinSuccessCacheMaxEntries: 4_096,
      pinSuccessCacheTtlMs: 300_000,
    });
    resetPasspilotKioskHealthStateForTests();
    assert.deepEqual(snapshotPasspilotKioskHealthStateForTests(), {
      size: 0,
      maxEntries: 4_096,
      windowMs: 300_000,
    });
  });

  it("exchanges a PIN once, polls with a token, and serves a revisioned snapshot", async (t) => {
    if (!schemaReady) return t.skip("migration not applied");
    const authService = await import("../dist/services/passpilotKioskAuth.js");
    const metricsService = await import("../dist/services/passpilotKioskMetrics.js");
    authService.resetPasspilotKioskAuthStateForTests();
    metricsService.snapshotPasspilotKioskMetrics({ reset: true });

    const auth = await requestJson(
      "POST",
      "/passpilot/kiosk/auth",
      {},
      kioskHeaders(schoolA.id)
    );
    assert.equal(auth.status, 200, JSON.stringify(auth.body));
    assert.equal(auth.body.expiresInSeconds, 900);
    assert.equal(typeof auth.body.token, "string");
    assert.ok(new Date(auth.body.expiresAt).getTime() > Date.now());
    const tokenHeaders = {
      "x-school-id": schoolA.id,
      "x-kiosk-token": auth.body.token,
      "x-passpilot-class-model": "classpilot-groups-v1",
    };

    const config = await requestJson(
      "GET",
      "/passpilot/kiosk/config",
      undefined,
      tokenHeaders
    );
    assert.equal(config.status, 200, JSON.stringify(config.body));
    const students = await requestJson(
      "GET",
      `/passpilot/kiosk/students?classId=${gradeA.id}`,
      undefined,
      tokenHeaders
    );
    assert.equal(students.status, 200, JSON.stringify(students.body));

    const snapshot = await requestJson(
      "GET",
      `/passpilot/kiosk/snapshot?classId=${gradeA.id}`,
      undefined,
      tokenHeaders
    );
    assert.equal(snapshot.status, 200, JSON.stringify(snapshot.body));
    assert.equal(snapshot.body.config.classId, gradeA.id);
    assert.equal(snapshot.body.config.className, "Class A");
    assert.equal(snapshot.body.session, null);
    assert.ok(snapshot.body.roster.some((student: any) => student.id === studentA.id));
    assert.equal(Array.isArray(snapshot.body.passes), true);
    assert.equal(typeof snapshot.body.revisions.config, "number");
    assert.equal(typeof snapshot.body.revisions.snapshot, "string");
    assert.equal(JSON.stringify(snapshot.body).includes("deviceId"), false);
    const etag = snapshot.headers.get("etag");
    assert.ok(etag);

    const unchanged = await requestJson(
      "GET",
      `/passpilot/kiosk/snapshot?classId=${gradeA.id}`,
      undefined,
      { ...tokenHeaders, "if-none-match": etag! }
    );
    assert.equal(unchanged.status, 304);
    assert.equal(unchanged.body, null);

    const metrics = metricsService.snapshotPasspilotKioskMetrics();
    assert.equal(metrics.counters.authorizationBcrypt, 1);
    assert.ok((metrics.counters.authorizationTokenSuccess ?? 0) >= 2);
    assert.equal(metrics.counters.tenantCheckouts, 4);
    assert.ok((metrics.counters.configSqlStatements ?? 0) <= 6);
    assert.ok((metrics.counters.studentsSqlStatements ?? 0) <= 8);
    assert.ok((metrics.counters.snapshotSqlStatements ?? 0) <= 10);
  });

  it("invalidates tokens on the next request after PIN rotation or license revocation", async (t) => {
    if (!schemaReady) return t.skip("migration not applied");
    const { hashPassword } = await import("../dist/util/password.js");
    const oldHashResult = await asSystem(() =>
      db.execute(sql`SELECT kiosk_pin_hash FROM schools WHERE id = ${schoolA.id}`)
    );
    const oldHash = oldHashResult.rows[0].kiosk_pin_hash;
    const auth = await requestJson("POST", "/passpilot/kiosk/auth", {}, kioskHeaders(schoolA.id));
    assert.equal(auth.status, 200);
    const tokenHeaders = {
      "x-school-id": schoolA.id,
      "x-kiosk-token": auth.body.token,
      "x-passpilot-class-model": "classpilot-groups-v1",
    };

    const rotatedPin = "6789";
    const rotatedHash = await hashPassword(rotatedPin);
    try {
      await asSystem(() =>
        db.execute(sql`UPDATE schools SET kiosk_pin_hash = ${rotatedHash} WHERE id = ${schoolA.id}`)
      );
      const revokedByRotation = await requestJson(
        "GET",
        "/passpilot/kiosk/grades",
        undefined,
        tokenHeaders
      );
      assert.equal(revokedByRotation.status, 401);
      assert.equal(revokedByRotation.body.code, "PASSPILOT_KIOSK_TOKEN_INVALID");

      const oldPin = await requestJson("POST", "/passpilot/kiosk/auth", {}, kioskHeaders(schoolA.id));
      assert.equal(oldPin.status, 401);
      const replacement = await requestJson("POST", "/passpilot/kiosk/auth", {}, {
        "x-school-id": schoolA.id,
        "x-kiosk-pin": rotatedPin,
      });
      assert.equal(replacement.status, 200);
    } finally {
      await asSystem(() =>
        db.execute(sql`UPDATE schools SET kiosk_pin_hash = ${oldHash} WHERE id = ${schoolA.id}`)
      );
    }

    try {
      await asSystem(() =>
        db.execute(sql`UPDATE product_licenses SET status = 'suspended' WHERE school_id = ${schoolA.id} AND product = 'PASSPILOT'`)
      );
      const revokedByLicense = await requestJson(
        "GET",
        "/passpilot/kiosk/grades",
        undefined,
        tokenHeaders
      );
      assert.equal(revokedByLicense.status, 403);
      assert.equal(revokedByLicense.body.code, "PASSPILOT_KIOSK_LICENSE_REQUIRED");
    } finally {
      await asSystem(() =>
        db.execute(sql`UPDATE product_licenses SET status = 'active' WHERE school_id = ${schoolA.id} AND product = 'PASSPILOT'`)
      );
    }
  });

  it("accepts only bounded health transitions and suppresses duplicates", async (t) => {
    if (!schemaReady) return t.skip("migration not applied");
    const healthService = await import("../dist/services/passpilotKioskHealth.js");
    healthService.resetPasspilotKioskHealthStateForTests();
    const auth = await requestJson("POST", "/passpilot/kiosk/auth", {}, kioskHeaders(schoolA.id));
    assert.equal(auth.status, 200);
    const headers = {
      "x-school-id": schoolA.id,
      "x-kiosk-token": auth.body.token,
    };

    const premature = await requestJson(
      "POST",
      "/passpilot/kiosk/client-health",
      { event: "snapshot_failure", consecutiveFailures: 2 },
      headers
    );
    assert.equal(premature.status, 400);
    assert.equal(premature.body.code, "PASSPILOT_KIOSK_HEALTH_INVALID");

    const first = await requestJson(
      "POST",
      "/passpilot/kiosk/client-health",
      { event: "snapshot_failure", consecutiveFailures: 3, reason: "timeout" },
      headers
    );
    assert.equal(first.status, 202);
    assert.equal(first.body.accepted, true);

    const duplicate = await requestJson(
      "POST",
      "/passpilot/kiosk/client-health",
      { event: "snapshot_failure", consecutiveFailures: 4, reason: "timeout" },
      headers
    );
    assert.equal(duplicate.status, 202);
    assert.equal(duplicate.body.accepted, false);
    assert.equal(duplicate.headers.get("retry-after"), "300");

    const recovery = await requestJson(
      "POST",
      "/passpilot/kiosk/client-health",
      { event: "snapshot_recovery", consecutiveFailures: 4 },
      headers
    );
    assert.equal(recovery.status, 202);
    assert.equal(recovery.body.accepted, true);
  });
});

describe("ClassPilot managed kiosk launch tickets", { concurrency: false }, () => {
  const directoryDeviceId = "managed-directory-device-do-not-persist";
  const launchBody = {
    directoryDeviceId,
    clientProtocolVersion: 3,
    capabilities: ["kioskLaunchTicketV1"],
  };
  const launchBodyV2 = {
    directoryDeviceId,
    clientProtocolVersion: 3,
    capabilities: ["scopedAuthorityChecksV1", "kioskLaunchTicketV2"],
  };

  function enrollmentHeaders(schoolId: string): Record<string, string> {
    return {
      "x-school-id": schoolId,
      "x-classpilot-enrollment-key": ENROLLMENT_KEY,
    };
  }

  async function issueTicket(schoolId: string, id = directoryDeviceId) {
    return requestJson(
      "POST",
      "/classpilot/kiosk/launch-ticket",
      { ...launchBody, directoryDeviceId: id },
      enrollmentHeaders(schoolId)
    );
  }

  async function issueV2Ticket(schoolId: string, id = directoryDeviceId) {
    return requestJson(
      "POST",
      "/classpilot/kiosk/launch-ticket",
      { ...launchBodyV2, directoryDeviceId: id },
      enrollmentHeaders(schoolId)
    );
  }

  function runTicketProcess(
    values: Record<string, string>,
    overrides: Record<string, string> = {}
  ): Promise<any> {
    return new Promise((resolve, reject) => {
      const child = spawn(
        process.execPath,
        ["tests/fixtures/classpilot-kiosk-ticket-process.mjs"],
        {
          cwd: process.cwd(),
          env: {
            ...process.env,
            NODE_ENV: "test",
            ...values,
            ...overrides,
          },
          stdio: ["ignore", "pipe", "pipe"],
        }
      );
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk) => { stdout += chunk; });
      child.stderr.on("data", (chunk) => { stderr += chunk; });
      child.on("error", reject);
      child.on("close", (code) => {
        if (code !== 0) {
          reject(new Error(`ticket process failed (${code}): ${stderr || stdout}`));
          return;
        }
        const line = stdout.trim().split(/\r?\n/).at(-1);
        try {
          resolve(JSON.parse(line || "null"));
        } catch {
          reject(new Error(`ticket process returned invalid JSON: ${stdout}; ${stderr}`));
        }
      });
    });
  }

  it("keeps the local fallback bounded and derives stable school-scoped UUIDs", async () => {
    const service = await import("../dist/services/classpilotKioskLaunchTicket.js");
    const store = new service.BoundedClasspilotKioskLaunchTicketStore(2, 100);
    store.set("one", "1", 1_000);
    store.set("two", "2", 1_000);
    store.set("three", "3", 1_000);
    assert.equal(store.size, 2);
    assert.equal(store.getdel("one", 1_001), null);
    assert.equal(store.getdel("two", 1_001), "2");
    assert.equal(store.getdel("two", 1_001), null);
    assert.equal(store.getdel("three", 1_101), null);

    const first = service.schoolScopedManagedKioskDeviceId("school-a", directoryDeviceId);
    const repeated = service.schoolScopedManagedKioskDeviceId("school-a", directoryDeviceId);
    const otherSchool = service.schoolScopedManagedKioskDeviceId("school-b", directoryDeviceId);
    assert.equal(first, repeated);
    assert.notEqual(first, otherSchool);
    assert.match(first, /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.equal(
      service.legacyManagedKioskDeviceId(directoryDeviceId),
      "d8c2edc3-f3fd-6465-e9f1-af3fa9079209",
      "the migration id must exactly match the ClassPilot 2.6.9 algorithm"
    );
    assert.deepEqual(service.snapshotClasspilotKioskLaunchTicketStateForTests(), {
      size: 0,
      maxEntries: 4_096,
      ttlMs: 60_000,
    });
  });

  it("authenticates a no-identifier V2 preflight before accepting ticket capability", async (t) => {
    if (!schemaReady) return t.skip("migration not applied");
    const preflightBody = {
      clientProtocolVersion: 3,
      capabilities: ["scopedAuthorityChecksV1", "kioskLaunchTicketV2"],
    };
    const accepted = await requestJson(
      "POST",
      "/classpilot/kiosk/launch-ticket/preflight",
      preflightBody,
      enrollmentHeaders(schoolA.id)
    );
    assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
    assert.deepEqual(
      new Set(accepted.body.acceptedCapabilities),
      new Set(["scopedAuthorityChecksV1", "kioskLaunchTicketV2"])
    );
    assert.equal(accepted.headers.get("cache-control")?.includes("no-store"), true);
    assert.equal(JSON.stringify(accepted.body).includes(directoryDeviceId), false);

    const missingMarker = await requestJson(
      "POST",
      "/classpilot/kiosk/launch-ticket/preflight",
      { clientProtocolVersion: 3, capabilities: ["kioskLaunchTicketV2"] },
      enrollmentHeaders(schoolA.id)
    );
    assert.equal(missingMarker.status, 200);
    assert.deepEqual(missingMarker.body.acceptedCapabilities, []);

    const identifierRejected = await requestJson(
      "POST",
      "/classpilot/kiosk/launch-ticket/preflight",
      { ...preflightBody, directoryDeviceId },
      enrollmentHeaders(schoolA.id)
    );
    assert.equal(identifierRejected.status, 400);
    assert.equal(
      identifierRejected.body.code,
      "CLASSPILOT_KIOSK_LAUNCH_PREFLIGHT_INVALID_REQUEST"
    );

    const wrongKey = await requestJson(
      "POST",
      "/classpilot/kiosk/launch-ticket/preflight",
      preflightBody,
      { "x-school-id": schoolA.id, "x-classpilot-enrollment-key": "wrong" }
    );
    assert.equal(wrongKey.status, 401);
  });

  it("issues V2 for ten minutes and consumes it after the V1 window", async () => {
    const service = await import("../dist/services/classpilotKioskLaunchTicket.js");
    service.resetClasspilotKioskLaunchTicketStateForTests();
    const now = 1_800_000_000_000;
    const issued = await service.issueClasspilotKioskLaunchTicket({
      schoolId: "school-v2",
      directoryDeviceId,
      version: 2,
      now,
    });
    assert.equal(issued.expiresInSeconds, 600);
    assert.equal(issued.expiresAt.getTime(), now + 600_000);
    const consumed = await service.consumeClasspilotKioskLaunchTicket({
      ticket: issued.ticket,
      schoolId: "school-v2",
      now: now + 61_000,
    });
    assert.equal(consumed?.ticketVersion, 2);
    assert.equal(consumed?.legacyDeviceId, service.legacyManagedKioskDeviceId(directoryDeviceId));

    const nearExpiry = await service.issueClasspilotKioskLaunchTicket({
      schoolId: "school-v2",
      directoryDeviceId: `${directoryDeviceId}-near-expiry`,
      version: 2,
      now,
    });
    assert.ok(await service.consumeClasspilotKioskLaunchTicket({
      ticket: nearExpiry.ticket,
      schoolId: "school-v2",
      now: now + 599_999,
    }));

    const expired = await service.issueClasspilotKioskLaunchTicket({
      schoolId: "school-v2",
      directoryDeviceId: `${directoryDeviceId}-expired`,
      version: 2,
      now,
    });
    assert.equal(await service.consumeClasspilotKioskLaunchTicket({
      ticket: expired.ticket,
      schoolId: "school-v2",
      now: now + 600_001,
    }), null);
  });

  it("uses Redis HMAC keys and one atomic cross-process V2 consumer", async (t) => {
    const redisUrl = process.env.TEST_REDIS_URL || "redis://127.0.0.1:6380";
    const redis = createClient({ url: redisUrl });
    try {
      await redis.connect();
      await redis.ping();
    } catch {
      if (redis.isOpen) redis.disconnect();
      return t.skip("Redis 7 integration service is unavailable");
    }
    const prefix = `${TAG}:kiosk-ticket-cross-process`;
    const secret = `${TAG}:ticket-secret`;
    const schoolId = `${TAG}:redis-school`;
    const rawId = `${directoryDeviceId}-redis`;
    try {
      const issued = await runTicketProcess({
        KIOSK_TICKET_PROCESS_MODE: "issue",
        KIOSK_TICKET_SCHOOL_ID: schoolId,
        KIOSK_TICKET_DIRECTORY_ID: rawId,
        REDIS_URL: redisUrl,
        REDIS_PREFIX: prefix,
        CLASSPILOT_KIOSK_TICKET_HMAC_SECRET: secret,
      });
      assert.equal(issued.ok, true, JSON.stringify(issued));
      assert.equal(issued.expiresInSeconds, 600);

      const digest = crypto
        .createHmac("sha256", secret)
        .update(JSON.stringify(["classpilot-kiosk-launch-ticket-key-v1", issued.ticket]))
        .digest("base64url");
      const key = `${prefix}:classpilot:kiosk-launch-ticket:${digest}`;
      const stored = await redis.get(key);
      assert.ok(stored, "issuer process must write the HMAC-derived Redis key");
      assert.equal(stored.includes(rawId), false, "Redis must not contain the raw directory id");
      assert.equal(
        (await redis.keys(`${prefix}:*`)).some((candidate) => candidate.includes(issued.ticket)),
        false,
        "the bearer ticket must never be embedded in its Redis key"
      );
      const ttl = await redis.ttl(key);
      assert.ok(ttl > 0 && ttl <= 600, `expected bounded V2 TTL, got ${ttl}`);

      const consumerEnv = {
        KIOSK_TICKET_PROCESS_MODE: "consume",
        KIOSK_TICKET_SCHOOL_ID: schoolId,
        KIOSK_TICKET: issued.ticket,
        REDIS_URL: redisUrl,
        REDIS_PREFIX: prefix,
        CLASSPILOT_KIOSK_TICKET_HMAC_SECRET: secret,
      };
      const consumers = await Promise.all([
        runTicketProcess(consumerEnv),
        runTicketProcess(consumerEnv),
      ]);
      assert.equal(consumers.filter((result) => result.continuity).length, 1);
      assert.equal(consumers.filter((result) => result.continuity === null).length, 1);
      assert.equal(await redis.exists(key), 0);

      const productionNoRedis = await runTicketProcess(
        {
          KIOSK_TICKET_PROCESS_MODE: "issue",
          KIOSK_TICKET_SCHOOL_ID: schoolId,
          KIOSK_TICKET_DIRECTORY_ID: rawId,
          REDIS_URL: "",
          REDIS_PREFIX: prefix,
          CLASSPILOT_KIOSK_TICKET_HMAC_SECRET: secret,
          JWT_SECRET: `${TAG}:production-ticket-test-jwt-secret`,
        },
        { NODE_ENV: "production" }
      );
      assert.deepEqual(
        { ok: productionNoRedis.ok, code: productionNoRedis.code, status: productionNoRedis.status },
        {
          ok: false,
          code: "CLASSPILOT_KIOSK_LAUNCH_TICKET_UNAVAILABLE",
          status: 503,
        }
      );
    } finally {
      const keys = await redis.keys(`${prefix}:*`);
      if (keys.length > 0) await redis.del(keys);
      await redis.quit();
    }
  });

  it("authenticates issuance, forbids body school identity, and negotiates capability", async (t) => {
    if (!schemaReady) return t.skip("migration not applied");
    const bodySchool = await requestJson(
      "POST",
      "/classpilot/kiosk/launch-ticket",
      { ...launchBody, schoolId: schoolB.id },
      enrollmentHeaders(schoolA.id)
    );
    assert.equal(bodySchool.status, 400);
    assert.equal(bodySchool.body.code, "CLASSPILOT_KIOSK_LAUNCH_TICKET_INVALID_REQUEST");

    const wrongKey = await requestJson(
      "POST",
      "/classpilot/kiosk/launch-ticket",
      launchBody,
      { "x-school-id": schoolA.id, "x-classpilot-enrollment-key": "wrong" }
    );
    assert.equal(wrongKey.status, 401);

    const legacyProtocol = await requestJson(
      "POST",
      "/classpilot/kiosk/launch-ticket",
      { ...launchBody, clientProtocolVersion: 2 },
      enrollmentHeaders(schoolA.id)
    );
    assert.equal(legacyProtocol.status, 426);
    assert.deepEqual(legacyProtocol.body.acceptedCapabilities, []);

    const issued = await issueTicket(schoolA.id);
    assert.equal(issued.status, 201, JSON.stringify(issued.body));
    assert.match(issued.body.ticket, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(issued.body.expiresInSeconds, 60);
    assert.equal(issued.body.serverProtocolVersion, 3);
    assert.deepEqual(issued.body.acceptedCapabilities, ["kioskLaunchTicketV1"]);
    assert.equal(JSON.stringify(issued.body).includes(directoryDeviceId), false);
    assert.equal(issued.headers.get("cache-control")?.includes("no-store"), true);
  });

  it("requires current kiosk auth before one-use redemption and preserves only scoped continuity", async (t) => {
    if (!schemaReady) return t.skip("migration not applied");
    const service = await import("../dist/services/classpilotKioskLaunchTicket.js");
    service.resetClasspilotKioskLaunchTicketStateForTests();

    const issued = await issueTicket(schoolA.id);
    assert.equal(issued.status, 201, JSON.stringify(issued.body));

    // Authentication happens before GETDEL, so an unauthenticated caller
    // cannot burn a valid continuity ticket.
    const unauthenticated = await requestJson(
      "POST",
      "/passpilot/kiosk/launch-ticket/redeem",
      { ticket: issued.body.ticket },
      { "x-school-id": schoolA.id }
    );
    assert.equal(unauthenticated.status, 401);

    const auth = await requestJson("POST", "/passpilot/kiosk/auth", {}, kioskHeaders(schoolA.id));
    assert.equal(auth.status, 200);
    const tokenHeaders = {
      "x-school-id": schoolA.id,
      "x-kiosk-token": auth.body.token,
    };
    const redeemed = await requestJson(
      "POST",
      "/passpilot/kiosk/launch-ticket/redeem",
      { ticket: issued.body.ticket },
      tokenHeaders
    );
    assert.equal(redeemed.status, 200, JSON.stringify(redeemed.body));
    assert.equal(redeemed.body.continuityOnly, true);
    assert.match(
      redeemed.body.deviceId,
      /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    );
    assert.equal(JSON.stringify(redeemed.body).includes(directoryDeviceId), false);
    assert.equal("token" in redeemed.body, false);
    assert.equal("session" in redeemed.body, false);

    const replay = await requestJson(
      "POST",
      "/passpilot/kiosk/launch-ticket/redeem",
      { ticket: issued.body.ticket },
      tokenHeaders
    );
    assert.equal(replay.status, 404);
    assert.equal(replay.body.code, "PASSPILOT_KIOSK_LAUNCH_TICKET_INVALID");

    const repeatedTicket = await issueTicket(schoolA.id);
    const repeated = await requestJson(
      "POST",
      "/passpilot/kiosk/launch-ticket/redeem",
      { ticket: repeatedTicket.body.ticket },
      kioskHeaders(schoolA.id)
    );
    assert.equal(repeated.status, 200);
    assert.equal(repeated.body.deviceId, redeemed.body.deviceId);

    const otherSchoolTicket = await issueTicket(schoolB.id);
    const otherSchool = await requestJson(
      "POST",
      "/passpilot/kiosk/launch-ticket/redeem",
      { ticket: otherSchoolTicket.body.ticket },
      kioskHeaders(schoolB.id)
    );
    assert.equal(otherSchool.status, 200);
    assert.notEqual(otherSchool.body.deviceId, redeemed.body.deviceId);
  });

  it("migrates a valid 2.6.9 durable association without overwriting either identity", async (t) => {
    if (!schemaReady) return t.skip("migration not applied");
    const service = await import("../dist/services/classpilotKioskLaunchTicket.js");
    const rawId = `${directoryDeviceId}-migration`;
    const legacyDeviceId = service.legacyManagedKioskDeviceId(rawId);
    const newDeviceId = service.schoolScopedManagedKioskDeviceId(schoolA.id, rawId);
    await asSystem(() => db.execute(sql`
      INSERT INTO passpilot_kiosk_devices
        (id, school_id, teacher_id, class_source, grade_id, classpilot_group_id)
      VALUES
        (${legacyDeviceId}, ${schoolA.id}, ${teacherA.id}, 'legacy_grades', ${gradeA.id}, NULL)
      ON CONFLICT (school_id, id) DO UPDATE SET
        teacher_id = EXCLUDED.teacher_id,
        class_source = EXCLUDED.class_source,
        grade_id = EXCLUDED.grade_id,
        classpilot_group_id = NULL,
        last_used_at = now()
    `));

    const issued = await issueV2Ticket(schoolA.id, rawId);
    assert.equal(issued.status, 201, JSON.stringify(issued.body));
    assert.equal(issued.body.expiresInSeconds, 600);
    assert.equal(issued.body.acceptedCapabilities.includes("kioskLaunchTicketV2"), true);
    const redeemed = await requestJson(
      "POST",
      "/passpilot/kiosk/launch-ticket/redeem",
      { ticket: issued.body.ticket },
      kioskHeaders(schoolA.id)
    );
    assert.equal(redeemed.status, 200, JSON.stringify(redeemed.body));
    assert.equal(redeemed.body.deviceId, newDeviceId);

    const migrated = await bindingRow(schoolA.id, newDeviceId);
    assert.equal(migrated.teacher_id, teacherA.id);
    assert.equal(migrated.grade_id, gradeA.id);
    assert.ok(await bindingRow(schoolA.id, legacyDeviceId), "the 2.6.9 row must remain");

    const boot = await requestJson(
      "POST",
      "/passpilot/kiosk/session",
      {},
      deviceHeaders(schoolA.id, newDeviceId)
    );
    assert.deepEqual(boot.body.resume, { kioskName: "Room 204", className: "Class A" });
  });

  it("keeps an existing V2 association authoritative during legacy migration", async (t) => {
    if (!schemaReady) return t.skip("migration not applied");
    const service = await import("../dist/services/classpilotKioskLaunchTicket.js");
    const rawId = `${directoryDeviceId}-conflict`;
    const legacyDeviceId = service.legacyManagedKioskDeviceId(rawId);
    const newDeviceId = service.schoolScopedManagedKioskDeviceId(schoolA.id, rawId);
    await asSystem(() => db.execute(sql`
      INSERT INTO passpilot_kiosk_devices
        (id, school_id, teacher_id, class_source, grade_id, classpilot_group_id)
      VALUES
        (${legacyDeviceId}, ${schoolA.id}, ${teacherA.id}, 'legacy_grades', ${gradeA.id}, NULL),
        (${newDeviceId}, ${schoolA.id}, ${teacherB.id}, 'legacy_grades', ${gradeB.id}, NULL)
      ON CONFLICT (school_id, id) DO UPDATE SET last_used_at = now()
    `));
    const issued = await issueV2Ticket(schoolA.id, rawId);
    const redeemed = await requestJson(
      "POST",
      "/passpilot/kiosk/launch-ticket/redeem",
      { ticket: issued.body.ticket },
      kioskHeaders(schoolA.id)
    );
    assert.equal(redeemed.status, 200);
    const authoritative = await bindingRow(schoolA.id, newDeviceId);
    assert.equal(authoritative.teacher_id, teacherB.id);
    assert.equal(authoritative.grade_id, gradeB.id);
  });

  it("does not migrate an expired legacy association", async (t) => {
    if (!schemaReady) return t.skip("migration not applied");
    const service = await import("../dist/services/classpilotKioskLaunchTicket.js");
    const rawId = `${directoryDeviceId}-expired-binding`;
    const legacyDeviceId = service.legacyManagedKioskDeviceId(rawId);
    const newDeviceId = service.schoolScopedManagedKioskDeviceId(schoolA.id, rawId);
    await asSystem(() => db.execute(sql`
      INSERT INTO passpilot_kiosk_devices
        (id, school_id, teacher_id, class_source, grade_id, classpilot_group_id, last_used_at)
      VALUES
        (${legacyDeviceId}, ${schoolA.id}, ${teacherA.id}, 'legacy_grades', ${gradeA.id}, NULL, now() - interval '61 days')
    `));
    const issued = await issueV2Ticket(schoolA.id, rawId);
    const redeemed = await requestJson(
      "POST",
      "/passpilot/kiosk/launch-ticket/redeem",
      { ticket: issued.body.ticket },
      kioskHeaders(schoolA.id)
    );
    assert.equal(redeemed.status, 200);
    assert.equal(await bindingRow(schoolA.id, newDeviceId), undefined);
    assert.ok(await bindingRow(schoolA.id, legacyDeviceId), "migration does not delete history");
  });

  it("serializes concurrent V2 redemption to one migration winner", async (t) => {
    if (!schemaReady) return t.skip("migration not applied");
    const service = await import("../dist/services/classpilotKioskLaunchTicket.js");
    const rawId = `${directoryDeviceId}-concurrent`;
    const legacyDeviceId = service.legacyManagedKioskDeviceId(rawId);
    const newDeviceId = service.schoolScopedManagedKioskDeviceId(schoolA.id, rawId);
    await asSystem(() => db.execute(sql`
      INSERT INTO passpilot_kiosk_devices
        (id, school_id, teacher_id, class_source, grade_id, classpilot_group_id)
      VALUES
        (${legacyDeviceId}, ${schoolA.id}, ${teacherA.id}, 'legacy_grades', ${gradeA.id}, NULL)
    `));
    const issued = await issueV2Ticket(schoolA.id, rawId);
    const attempts = await Promise.all([
      requestJson(
        "POST",
        "/passpilot/kiosk/launch-ticket/redeem",
        { ticket: issued.body.ticket },
        kioskHeaders(schoolA.id)
      ),
      requestJson(
        "POST",
        "/passpilot/kiosk/launch-ticket/redeem",
        { ticket: issued.body.ticket },
        kioskHeaders(schoolA.id)
      ),
    ]);
    assert.deepEqual(attempts.map((attempt) => attempt.status).sort(), [200, 404]);
    assert.ok(await bindingRow(schoolA.id, newDeviceId));
  });

  it("burns a V2 ticket under the wrong school without migrating either tenant", async (t) => {
    if (!schemaReady) return t.skip("migration not applied");
    const service = await import("../dist/services/classpilotKioskLaunchTicket.js");
    const rawId = `${directoryDeviceId}-v2-wrong-school`;
    const legacyDeviceId = service.legacyManagedKioskDeviceId(rawId);
    const schoolANewDeviceId = service.schoolScopedManagedKioskDeviceId(schoolA.id, rawId);
    const schoolBNewDeviceId = service.schoolScopedManagedKioskDeviceId(schoolB.id, rawId);
    await asSystem(() => db.execute(sql`
      INSERT INTO passpilot_kiosk_devices
        (id, school_id, teacher_id, class_source, grade_id, classpilot_group_id)
      VALUES
        (${legacyDeviceId}, ${schoolA.id}, ${teacherA.id}, 'legacy_grades', ${gradeA.id}, NULL)
    `));
    const issued = await issueV2Ticket(schoolA.id, rawId);
    const wrongSchool = await requestJson(
      "POST",
      "/passpilot/kiosk/launch-ticket/redeem",
      { ticket: issued.body.ticket },
      {
        ...kioskHeaders(schoolB.id),
        "x-forwarded-for": "198.51.100.241",
      }
    );
    assert.equal(wrongSchool.status, 404);
    assert.equal(await bindingRow(schoolA.id, schoolANewDeviceId), undefined);
    assert.equal(await bindingRow(schoolB.id, schoolBNewDeviceId), undefined);
    const replay = await requestJson(
      "POST",
      "/passpilot/kiosk/launch-ticket/redeem",
      { ticket: issued.body.ticket },
      {
        ...kioskHeaders(schoolA.id),
        "x-forwarded-for": "198.51.100.241",
      }
    );
    assert.equal(replay.status, 404);
  });

  it("burns a ticket presented under a different authenticated school", async (t) => {
    if (!schemaReady) return t.skip("migration not applied");
    const issued = await issueTicket(schoolA.id, `${directoryDeviceId}-wrong-school`);
    assert.equal(issued.status, 201);

    const wrongSchool = await requestJson(
      "POST",
      "/passpilot/kiosk/launch-ticket/redeem",
      { ticket: issued.body.ticket },
      {
        ...kioskHeaders(schoolB.id),
        "x-forwarded-for": "198.51.100.242",
      }
    );
    assert.equal(wrongSchool.status, 404);

    const retryOriginalSchool = await requestJson(
      "POST",
      "/passpilot/kiosk/launch-ticket/redeem",
      { ticket: issued.body.ticket },
      {
        ...kioskHeaders(schoolA.id),
        "x-forwarded-for": "198.51.100.242",
      }
    );
    assert.equal(retryOriginalSchool.status, 404);
  });
});
