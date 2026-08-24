import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { sql } from "drizzle-orm";

const TAG = `passpilot_issuers_${Date.now()}`;
const PASSPILOT_CLASS_MODEL = "classpilot-groups-v1";
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
let server: Server | undefined;
let baseUrl = "";
let schemaReady = false;
let schoolA: any;
let schoolB: any;
let admin: any;
let schoolAdmin: any;
let teacher: any;
let officeStaff: any;
let formerStaff: any;
let removedStaff: any;
let foreignAdmin: any;
let assignedGrade: any;
let assignedHistoryPass: any;
let ownHistoryPass: any;
let emailOnlyIssuerPass: any;
let foreignHistoryPass: any;
let missingHistoricalIssuerId = "";
let orphanActiveWithoutHistoryId = "";
let orphanActiveWithHistoryId = "";

const ASSIGNED_ISSUED_AT = "2026-08-19T13:00:00.000Z";
const ASSIGNED_RETURNED_AT = "2026-08-19T13:04:30.000Z";

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
  };
}

async function requestJson(
  path: string,
  user: any,
  schoolId: string,
  extraHeaders: Record<string, string> = {}
): Promise<{ status: number; body: any }> {
  const response = await fetch(`${baseUrl}${path}`, {
    headers: { ...authFor(user, schoolId), ...extraHeaders },
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

  schemaReady = await pool
    .query(`SELECT to_regclass('public.passes') IS NOT NULL AS ready`)
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

  admin = await storage.createUser({
    email: `admin@${TAG}-a.example.edu`,
    firstName: "Ignored",
    lastName: "Name",
    displayName: "Zelda Administrator",
  } as any);
  schoolAdmin = await storage.createUser({
    email: `brian@${TAG}-a.example.edu`,
    firstName: "Brian",
    lastName: "Zinkan",
  } as any);
  teacher = await storage.createUser({
    email: `teacher@${TAG}-a.example.edu`,
    firstName: "Amy",
    lastName: "Teacher",
  } as any);
  officeStaff = await storage.createUser({
    email: `office@${TAG}-a.example.edu`,
    firstName: "",
    lastName: "",
  } as any);
  formerStaff = await storage.createUser({
    email: `former@${TAG}-a.example.edu`,
    firstName: "Cora",
    lastName: "Former",
  } as any);
  removedStaff = await storage.createUser({
    email: `removed@${TAG}-a.example.edu`,
    firstName: "Drew",
    lastName: "Removed",
  } as any);
  foreignAdmin = await storage.createUser({
    email: `admin@${TAG}-b.example.edu`,
    firstName: "Foreign",
    lastName: "Administrator",
  } as any);

  for (const [user, school, role, status] of [
    [admin, schoolA, "admin", "active"],
    [admin, schoolA, "school_admin", "active"],
    [schoolAdmin, schoolA, "school_admin", "active"],
    [teacher, schoolA, "teacher", "active"],
    [officeStaff, schoolA, "office_staff", "active"],
    [formerStaff, schoolA, "teacher", "inactive"],
    [foreignAdmin, schoolB, "admin", "active"],
  ] as const) {
    await storage.createMembership({
      schoolId: school.id,
      userId: user.id,
      role,
      status,
    } as any);
  }

  orphanActiveWithoutHistoryId = randomUUID();
  orphanActiveWithHistoryId = randomUUID();
  await inSchool(schoolA.id, () => db.execute(sql`
      INSERT INTO school_memberships (user_id, school_id, role, status)
      VALUES
        (${orphanActiveWithoutHistoryId}, ${schoolA.id}, 'teacher', 'active'),
        (${orphanActiveWithHistoryId}, ${schoolA.id}, 'office_staff', 'active')
    `));

  for (const school of [schoolA, schoolB]) {
    await storage.createProductLicense({
      schoolId: school.id,
      product: "PASSPILOT",
      status: "active",
    } as any);
    await inSchool(school.id, () => storage.upsertSettings(school.id, {
      schoolName: school.name,
      passpilotClassSource: "legacy_grades",
    }));
  }

  const studentA = await inSchool(schoolA.id, () => storage.createStudent({
    schoolId: schoolA.id,
    firstName: "Student",
    lastName: "A",
    status: "active",
  } as any));
  const studentB = await inSchool(schoolB.id, () => storage.createStudent({
    schoolId: schoolB.id,
    firstName: "Student",
    lastName: "B",
    status: "active",
  } as any));

  assignedGrade = await inSchool(schoolA.id, () => storage.createGrade({
    schoolId: schoolA.id,
    name: "Assigned History Class",
  } as any));
  await inSchool(schoolA.id, () => storage.assignTeacherGrade(teacher.id, assignedGrade.id));

  const historicalPass = (schoolId: string, studentId: string, teacherId: string | null) => ({
    schoolId,
    studentId,
    teacherId,
    destination: "office",
    status: "returned",
    duration: 5,
    expiresAt: new Date(Date.now() - 60_000),
    returnedAt: new Date(),
    issuedVia: teacherId ? "teacher" : "kiosk",
  });

  missingHistoricalIssuerId = randomUUID();
  await inSchool(schoolA.id, async () => {
    assignedHistoryPass = await storage.createPass({
      ...historicalPass(schoolA.id, studentA.id, schoolAdmin.id),
      gradeId: assignedGrade.id,
      issuedAt: new Date(ASSIGNED_ISSUED_AT),
      returnedAt: new Date(ASSIGNED_RETURNED_AT),
      expiresAt: new Date("2026-08-19T13:10:00.000Z"),
    });
    ownHistoryPass = await storage.createPass({
      ...historicalPass(schoolA.id, studentA.id, teacher.id),
      issuedAt: new Date("2026-08-19T12:00:00.000Z"),
      returnedAt: new Date("2026-08-19T12:02:00.000Z"),
      expiresAt: new Date("2026-08-19T12:05:00.000Z"),
    });
    emailOnlyIssuerPass = await storage.createPass({
      ...historicalPass(schoolA.id, studentA.id, officeStaff.id),
      issuedAt: new Date("2026-08-19T11:00:00.000Z"),
      returnedAt: new Date("2026-08-19T11:01:00.000Z"),
      expiresAt: new Date("2026-08-19T11:05:00.000Z"),
    });
    await storage.createPass(historicalPass(schoolA.id, studentA.id, formerStaff.id));
    await storage.createPass(historicalPass(schoolA.id, studentA.id, removedStaff.id));
    await storage.createPass(historicalPass(schoolA.id, studentA.id, missingHistoricalIssuerId));
    await storage.createPass(historicalPass(schoolA.id, studentA.id, orphanActiveWithHistoryId));
    await storage.createPass(historicalPass(schoolA.id, studentA.id, null));
  });
  foreignHistoryPass = await inSchool(schoolB.id, () =>
    storage.createPass(historicalPass(schoolB.id, studentB.id, foreignAdmin.id))
  );

  const { createApp } = await import("../dist/app.js");
  server = createServer(createApp());
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
});

after(async () => {
  try {
    if (server) {
      await new Promise<void>((resolve, reject) =>
        server!.close((error) => error ? reject(error) : resolve())
      );
    }
    if (schemaReady && schoolA?.id && schoolB?.id) {
      await asSystem(async () => {
        const schoolIds = sql.join([schoolA.id, schoolB.id].map((id) => sql`${id}`), sql`, `);
        await db.execute(sql`DELETE FROM audit_logs WHERE school_id IN (${schoolIds})`);
        await db.execute(sql`DELETE FROM passes WHERE school_id IN (${schoolIds})`);
        await db.execute(sql`DELETE FROM students WHERE school_id IN (${schoolIds})`);
        await db.execute(sql`
          DELETE FROM teacher_grades
          WHERE grade_id IN (SELECT id FROM grades WHERE school_id IN (${schoolIds}))
        `);
        await db.execute(sql`DELETE FROM grades WHERE school_id IN (${schoolIds})`);
        await db.execute(sql`DELETE FROM settings WHERE school_id IN (${schoolIds})`);
        await db.execute(sql`DELETE FROM product_licenses WHERE school_id IN (${schoolIds})`);
        await db.execute(sql`DELETE FROM school_memberships WHERE school_id IN (${schoolIds})`);
        await db.execute(sql`
          UPDATE schools
          SET status = 'suspended', is_active = false, deleted_at = now()
          WHERE id IN (${schoolIds})
        `);
      });
    }
  } finally {
    await schedulerLockPool?.end().catch(() => undefined);
    await schedulerPool?.end().catch(() => undefined);
    await sessionPool?.end().catch(() => undefined);
    await pool?.end().catch(() => undefined);
  }
});

describe("PassPilot report issuers", { concurrency: false }, () => {
  it("unions every active staff role with deduplicated historical issuers", async (t) => {
    if (!schemaReady) return t.skip("PassPilot schema not applied");

    const response = await requestJson("/passpilot/passes/issuers", admin, schoolA.id);
    assert.equal(response.status, 200, JSON.stringify(response.body));
    const issuers = response.body.issuers as Array<{
      id: string;
      displayName: string;
      status: "active" | "former";
    }>;

    for (const activeUser of [admin, schoolAdmin, teacher, officeStaff]) {
      assert.equal(
        issuers.filter((issuer) => issuer.id === activeUser.id).length,
        1,
        `${activeUser.id} should appear exactly once`
      );
      assert.equal(issuers.find((issuer) => issuer.id === activeUser.id)?.status, "active");
    }
    assert.equal(issuers.find((issuer) => issuer.id === admin.id)?.displayName, "Zelda Administrator");
    assert.equal(issuers.find((issuer) => issuer.id === schoolAdmin.id)?.displayName, "Brian Zinkan");
    assert.equal(issuers.find((issuer) => issuer.id === officeStaff.id)?.displayName, officeStaff.email);

    assert.equal(issuers.find((issuer) => issuer.id === formerStaff.id)?.status, "former");
    assert.equal(issuers.find((issuer) => issuer.id === removedStaff.id)?.status, "former");
    assert.deepEqual(
      issuers.find((issuer) => issuer.id === missingHistoricalIssuerId),
      {
        id: missingHistoricalIssuerId,
        displayName: "Former staff member",
        status: "former",
      }
    );
    assert.equal(
      issuers.some((issuer) => issuer.id === orphanActiveWithoutHistoryId),
      false,
      "an orphan active membership without pass history must be excluded"
    );
    assert.deepEqual(
      issuers.find((issuer) => issuer.id === orphanActiveWithHistoryId),
      {
        id: orphanActiveWithHistoryId,
        displayName: "Former staff member",
        status: "former",
      },
      "an orphan active membership with pass history must be historical only"
    );
    assert.equal(issuers.some((issuer) => issuer.id === foreignAdmin.id), false);
    assert.equal(issuers.some((issuer) => !issuer.id), false, "null kiosk issuers must be excluded");

    const firstFormer = issuers.findIndex((issuer) => issuer.status === "former");
    assert.ok(firstFormer > 0);
    assert.equal(issuers.slice(0, firstFormer).every((issuer) => issuer.status === "active"), true);
    assert.equal(issuers.slice(firstFormer).every((issuer) => issuer.status === "former"), true);
    for (const group of [issuers.slice(0, firstFormer), issuers.slice(firstFormer)]) {
      assert.deepEqual(
        group.map((issuer) => issuer.displayName),
        group.map((issuer) => issuer.displayName).sort((left, right) =>
          left.localeCompare(right, "en", { sensitivity: "base" })
        )
      );
    }
  });

  it("allows school-wide managers, denies teachers, and never leaks another school", async (t) => {
    if (!schemaReady) return t.skip("PassPilot schema not applied");

    for (const manager of [admin, schoolAdmin, officeStaff]) {
      const allowed = await requestJson("/passpilot/passes/issuers", manager, schoolA.id);
      assert.equal(allowed.status, 200, `${manager.email} should be allowed`);
    }
    const denied = await requestJson("/passpilot/passes/issuers", teacher, schoolA.id);
    assert.equal(denied.status, 403);

    const foreign = await requestJson("/passpilot/passes/issuers", foreignAdmin, schoolB.id);
    assert.equal(foreign.status, 200, JSON.stringify(foreign.body));
    assert.deepEqual(foreign.body.issuers, [{
      id: foreignAdmin.id,
      displayName: "Foreign Administrator",
      status: "active",
    }]);
  });

  it("filters report history by an administrator issuer within the current school", async (t) => {
    if (!schemaReady) return t.skip("PassPilot schema not applied");

    const filtered = await requestJson(
      `/passpilot/passes/history?teacherId=${encodeURIComponent(schoolAdmin.id)}`,
      admin,
      schoolA.id
    );
    assert.equal(filtered.status, 200, JSON.stringify(filtered.body));
    assert.equal(filtered.body.passes.length, 1);
    assert.equal(filtered.body.passes[0].teacherId, schoolAdmin.id);

    const emailOnly = await requestJson(
      `/passpilot/passes/history?teacherId=${encodeURIComponent(officeStaff.id)}`,
      admin,
      schoolA.id
    );
    assert.equal(emailOnly.status, 200, JSON.stringify(emailOnly.body));
    assert.equal(emailOnly.body.passes.length, 1);
    assert.equal(emailOnly.body.passes[0].id, emailOnlyIssuerPass.id);
    assert.equal(emailOnly.body.passes[0].teacher.name, officeStaff.email);

    const crossSchool = await requestJson(
      `/passpilot/passes/history?teacherId=${encodeURIComponent(foreignAdmin.id)}`,
      admin,
      schoolA.id
    );
    assert.equal(crossSchool.status, 200, JSON.stringify(crossSchool.body));
    assert.deepEqual(crossSchool.body.passes, []);
  });

  it("returns the pass-detail history contract with enriched in-school issuers", async (t) => {
    if (!schemaReady) return t.skip("PassPilot schema not applied");

    const response = await requestJson(
      `/passpilot/passes/history?gradeId=${encodeURIComponent(assignedGrade.id)}`,
      teacher,
      schoolA.id
    );
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(response.body.passes.length, 1, JSON.stringify(response.body));
    const [pass] = response.body.passes;
    assert.deepEqual(
      {
        id: pass.id,
        schoolId: pass.schoolId,
        teacherId: pass.teacherId,
        issuedAt: pass.issuedAt,
        returnedAt: pass.returnedAt,
        status: pass.status,
        issuedVia: pass.issuedVia,
        teacher: pass.teacher && {
          id: pass.teacher.id,
          name: pass.teacher.name,
        },
      },
      {
        id: assignedHistoryPass.id,
        schoolId: schoolA.id,
        teacherId: schoolAdmin.id,
        issuedAt: ASSIGNED_ISSUED_AT,
        returnedAt: ASSIGNED_RETURNED_AT,
        status: "returned",
        issuedVia: "teacher",
        teacher: {
          id: schoolAdmin.id,
          name: "Brian Zinkan",
        },
      }
    );
  });

  it("keeps ordinary-teacher own and assigned history within the current school", async (t) => {
    if (!schemaReady) return t.skip("PassPilot schema not applied");

    const response = await requestJson("/passpilot/passes/history", teacher, schoolA.id);
    assert.equal(response.status, 200, JSON.stringify(response.body));
    const passIds = new Set(response.body.passes.map((pass: { id: string }) => pass.id));
    assert.equal(passIds.has(ownHistoryPass.id), true, "teacher-issued history should remain accessible");
    assert.equal(passIds.has(assignedHistoryPass.id), true, "assigned-class history should remain accessible");
    assert.equal(passIds.has(foreignHistoryPass.id), false, "foreign-school history must not leak");
    assert.equal(
      response.body.passes.every((pass: { schoolId: string; teacherId: string | null }) =>
        pass.schoolId === schoolA.id && pass.teacherId !== foreignAdmin.id
      ),
      true,
      "current-school history must not include foreign pass or issuer data"
    );
  });

  it("requires and accepts the canonical class-model capability header", async (t) => {
    if (!schemaReady) return t.skip("PassPilot schema not applied");

    await inSchool(schoolA.id, () => storage.upsertSettings(schoolA.id, {
      passpilotClassSource: "classpilot_groups",
    }));
    try {
      const outdated = await requestJson("/passpilot/passes/issuers", admin, schoolA.id);
      assert.equal(outdated.status, 426, JSON.stringify(outdated.body));
      assert.equal(outdated.body.code, "PASSPILOT_CLASS_MODEL_UPGRADE_REQUIRED");

      const capable = await requestJson(
        "/passpilot/passes/issuers",
        admin,
        schoolA.id,
        { "x-passpilot-class-model": PASSPILOT_CLASS_MODEL }
      );
      assert.equal(capable.status, 200, JSON.stringify(capable.body));
      assert.equal(
        capable.body.issuers.some((issuer: { id: string }) => issuer.id === schoolAdmin.id),
        true
      );
    } finally {
      await inSchool(schoolA.id, () => storage.upsertSettings(schoolA.id, {
        passpilotClassSource: "legacy_grades",
      }));
    }
  });
});
