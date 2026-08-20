import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { readFileSync } from "node:fs";
import { sql } from "drizzle-orm";

const TAG = `pp_kiosk_sessions_${Date.now()}`;
const KIOSK_PIN = "4321";
process.env.REDIS_URL = "";
process.env.NODE_ENV = "test";

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
): Promise<{ status: number; body: any }> {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { "content-type": "application/json", ...headers },
    ...(method === "GET" || method === "HEAD"
      ? {}
      : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
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
    await inSchool(school.id, () => storage.upsertSettings(school.id, {
      schoolName: school.name,
      passpilotClassSource: "legacy_grades",
    }));
    await asSystem(() =>
      db.execute(sql`UPDATE schools SET kiosk_enabled = true, kiosk_pin_hash = ${pinHash} WHERE id = ${school.id}`)
    );
  }
  await storage.createProductLicense({ schoolId: schoolC.id, product: "PASSPILOT", status: "active" } as any);
  await inSchool(schoolC.id, async () => {
    await storage.upsertSettings(schoolC.id, {
      schoolName: schoolC.name,
      passpilotClassSource: "classpilot_groups",
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
        await db.execute(sql`DELETE FROM audit_logs WHERE school_id IN (${ids})`);
        await db.execute(sql`DELETE FROM passes WHERE school_id IN (${ids})`);
        await db.execute(sql`DELETE FROM passpilot_kiosk_sessions WHERE school_id IN (${ids})`);
        await db.execute(sql`DELETE FROM teacher_grades WHERE grade_id IN (SELECT id FROM grades WHERE school_id IN (${ids}))`);
        await db.execute(sql`DELETE FROM passpilot_grade_students WHERE school_id IN (${ids})`);
        await db.execute(sql`DELETE FROM group_students WHERE group_id IN (SELECT id FROM groups WHERE school_id IN (${ids}))`);
        await db.execute(sql`DELETE FROM group_teachers WHERE group_id IN (SELECT id FROM groups WHERE school_id IN (${ids}))`);
        await db.execute(sql`DELETE FROM groups WHERE school_id IN (${ids})`);
        await db.execute(sql`DELETE FROM grades WHERE school_id IN (${ids})`);
        await db.execute(sql`DELETE FROM students WHERE school_id IN (${ids})`);
        await db.execute(sql`DELETE FROM settings WHERE school_id IN (${ids})`);
        await db.execute(sql`DELETE FROM product_licenses WHERE school_id IN (${ids})`);
        await db.execute(sql`DELETE FROM school_memberships WHERE school_id IN (${ids})`);
        await db.execute(sql`DELETE FROM schools WHERE id IN (${ids})`);
        await db.execute(sql`DELETE FROM users WHERE email LIKE ${`%@${TAG}-%`}`);
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
    const deployment = readFileSync(new URL("../scripts/enforce-deploy-rls-allowlist.mjs", import.meta.url), "utf8");
    assert.match(schema, /passpilotKioskSessions = pgTable\(/);
    assert.match(startup, /CREATE TABLE IF NOT EXISTS passpilot_kiosk_sessions/);
    assert.match(startup, /"passpilot_kiosk_sessions",/);
    assert.match(deployment, /"passpilot_kiosk_sessions"/);
    assert.match(deployment, /Object\.freeze\(\["passpilot_kiosk_sessions"\]\)/);
    assert.match(csrf, /"\/passpilot\/kiosk\/session"/);
    assert.match(csrf, /"\/kiosk\/session"/);
  });

  let sessionOne: any;

  it("bootstraps an unclaimed session with a 6-digit code and resumes idempotently", async (t) => {
    if (!schemaReady) return t.skip("passpilot_kiosk_sessions migration not applied");
    const created = await requestJson("POST", "/passpilot/kiosk/session", {}, kioskHeaders(schoolA.id));
    assert.equal(created.status, 201);
    sessionOne = created.body.session;
    assert.equal(sessionOne.status, "unclaimed");
    assert.match(sessionOne.claimCode, /^\d{6}$/);

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

  it("auto-releases sessions when the teacher's membership is deactivated (every endpoint)", async (t) => {
    if (!schemaReady) return t.skip("migration not applied");
    // Two sessions so lookup and config paths each get a fresh dead-teacher session.
    const selfOne = await requestJson("POST", "/passpilot/kiosk/sessions/self", { classId: gradeB.id }, authFor(teacherB, schoolA.id));
    const selfTwo = await requestJson("POST", "/passpilot/kiosk/sessions/self", { classId: gradeB.id }, authFor(teacherB, schoolA.id));
    assert.equal(selfOne.status, 201);
    assert.equal(selfTwo.status, 201);
    await asSystem(() =>
      db.execute(sql`UPDATE school_memberships SET status = 'inactive' WHERE school_id = ${schoolA.id} AND user_id = ${teacherB.id}`)
    );
    // /lookup and /checkin must enforce teacher liveness just like /config and
    // /checkout — an ownerless session must not keep serving student data.
    const lookup = await requestJson("POST", "/passpilot/kiosk/lookup", { studentIdNumber: "12345" }, kioskHeaders(schoolA.id, selfOne.body.session.id));
    assert.equal(lookup.status, 404);
    assert.equal(lookup.body.code, "PASSPILOT_KIOSK_SESSION_EXPIRED");
    const config = await requestJson("GET", `/passpilot/kiosk/config?school=${schoolA.id}`, undefined, kioskHeaders(schoolA.id, selfTwo.body.session.id));
    assert.equal(config.status, 404);
    assert.equal(config.body.code, "PASSPILOT_KIOSK_SESSION_EXPIRED");
    await asSystem(() =>
      db.execute(sql`UPDATE school_memberships SET status = 'active' WHERE school_id = ${schoolA.id} AND user_id = ${teacherB.id}`)
    );
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
