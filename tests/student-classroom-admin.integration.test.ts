import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { after, before, describe, test } from "node:test";
import type { School, User } from "../src/schema/core.js";
import { z } from "zod";

const fixtureUrl = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
process.env.NODE_ENV = "test";
process.env.REDIS_URL = "";
process.env.JWT_SECRET = "student-classroom-admin-local-fixture-only";
process.env.SESSION_SECRET = "student-classroom-admin-local-fixture-only";
// This route-authorization fixture never has Google credentials, even if a
// developer environment has configured a real roster connector.
process.env.GOOGLE_ROSTER_SA_KEY_JSON = "";
process.env.GOOGLE_ROSTER_SA_EMAIL = "";
process.env.GOOGLE_ROSTER_SA_CLIENT_ID = "";

describe("student Classroom administrator content setup", { skip: !fixtureUrl }, () => {
  let storage: typeof import("../src/services/storage.js");
  let inTenant: typeof import("../src/middleware/tenantContext.js").runWithTenantContext;
  let signUserToken: typeof import("../src/services/jwt.js").signUserToken;
  let school: School;
  let foreign: School;
  let administrator: User;
  let teacher: User;
  let importedStudentId: string;
  let privateGoogleId: string;
  let server: Server | undefined;
  let origin = "";

  before(async () => {
    const parsed = new URL(fixtureUrl!);
    assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname) && /^(sptest|schoolpilot_test|student_classroom_test)$/.test(parsed.pathname.slice(1)), "Use only a disposable local fixture database");
    process.env.DATABASE_URL = fixtureUrl;
    storage = await import("../src/services/storage.js");
    ({ runWithTenantContext: inTenant } = await import("../src/middleware/tenantContext.js"));
    ({ signUserToken } = await import("../src/services/jwt.js"));
    const suffix = randomUUID().slice(0, 8);
    const domain = `student-access-${suffix}.example.edu`;
    school = await storage.createSchool({ name: "Synthetic Classroom content setup", slug: `student-access-${suffix}`, domain, status: "active", isActive: true, planStatus: "active" });
    foreign = await storage.createSchool({ name: "Synthetic other content school", slug: `student-access-other-${suffix}`, domain, status: "active", isActive: true, planStatus: "active" });
    administrator = await storage.createUser({ email: `admin@${domain}`, firstName: "Synthetic", lastName: "Administrator" });
    teacher = await storage.createUser({ email: `teacher@${domain}`, firstName: "Synthetic", lastName: "Teacher" });
    await storage.createMembership({ schoolId: school.id, userId: administrator.id, role: "admin", status: "active" });
    await storage.createMembership({ schoolId: school.id, userId: teacher.id, role: "teacher", status: "active" });
    privateGoogleId = `private-google-${suffix}`;
    await inTenant({ schoolId: school.id }, async () => {
      importedStudentId = (await storage.createStudent({ schoolId: school.id, firstName: "Imported", lastName: "Student", email: `imported@${domain}`, googleUserId: privateGoogleId, status: "active" })).id;
      await storage.createStudent({ schoolId: school.id, firstName: "Unimported", lastName: "Student", email: `unimported@${domain}`, status: "active" });
      await storage.createStudent({ schoolId: school.id, firstName: "Inactive", lastName: "Student", email: `inactive@${domain}`, googleUserId: `inactive-${suffix}`, status: "inactive" });
    });
    await inTenant({ schoolId: foreign.id }, () => storage.createStudent({ schoolId: foreign.id, firstName: "Foreign", lastName: "Private", email: `foreign@${domain}`, googleUserId: `foreign-${suffix}`, status: "active" }));
    const { createApp } = await import("../src/app.js");
    server = createServer(createApp());
    await new Promise<void>(resolve => server!.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    origin = `http://127.0.0.1:${address.port}`;
  });
  after(async () => {
    server?.closeAllConnections();
    if (server) await new Promise<void>(resolve => server!.close(() => resolve()));
    if (storage) await (await import("../src/db.js")).pool.end();
  });

  async function request(actor: User | null, method: string, endpoint: string, body?: unknown, schoolId = school.id) {
    const response = await fetch(`${origin}/api/google/roster-connector/classroom-access${endpoint}`, {
      method, headers: { "x-school-id": schoolId, "content-type": "application/json",
        ...(actor ? { authorization: `Bearer ${signUserToken({ userId: actor.id, email: actor.email, isSuperAdmin: false })}` } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: z.object({}).passthrough().parse(await response.json()) };
  }
  test("unauthenticated, teacher and foreign-school requests cannot inspect content setup", async () => {
    assert.equal((await request(null, "GET", "/setup-info")).status, 401);
    assert.equal((await request(teacher, "GET", "/setup-info")).status, 403);
    const result = await request(administrator, "GET", "/setup-info", undefined, foreign.id);
    assert.ok([403, 404].includes(result.status));
    assert.equal(JSON.stringify(result.body).includes("Foreign Private"), false);
  });
  test("setup returns only eligible current-school student names and opaque school record IDs", async () => {
    const result = await request(administrator, "GET", "/setup-info");
    assert.equal(result.status, 200);
    assert.equal(result.body.purpose, "student_classroom_access");
    assert.equal(result.body.enabled, false);
    assert.deepEqual(result.body.verificationStudents, [{ id: importedStudentId, name: "Imported Student" }]);
    assert.equal(JSON.stringify(result.body).includes(privateGoogleId), false);
    assert.equal(JSON.stringify(result.body).includes("imported@"), false);
    assert.equal(result.body.approvalKey, undefined);
  });
  test("verification rejects arbitrary subjects, scope arrays and non-administrator writes", async () => {
    assert.equal((await request(teacher, "POST", "/verify", { studentId: importedStudentId })).status, 403);
    for (const body of [{ studentId: importedStudentId, email: "forged@example.edu" }, { studentId: importedStudentId, scopes: ["arbitrary"] }, {}, { studentId: [] }]) {
      const result = await request(administrator, "POST", "/verify", body);
      assert.equal(result.status, 400);
      assert.equal(result.body.code, "STUDENT_CLASSROOM_VERIFY_INVALID");
    }
    const unconfigured = await request(administrator, "POST", "/verify", { studentId: importedStudentId });
    assert.equal(unconfigured.status, 409);
    assert.equal(unconfigured.body.code, "STUDENT_CLASSROOM_CONNECTOR_REQUIRED");
    assert.equal(await inTenant({ schoolId: school.id }, () => storage.getGoogleRosterConnector(school.id)), undefined);
  });
});
