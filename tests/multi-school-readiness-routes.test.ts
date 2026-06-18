import { describe, it, before, after, mock } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { sql } from "drizzle-orm";

import db, { pool } from "../dist/db.js";
import { runWithTenantContext } from "../dist/middleware/tenantContext.js";
import {
  createMembership,
  createProductLicense,
  createSchool,
  createStudent,
  createUser,
  getSchoolById,
  getStudentByEmail,
  updateEnrollmentSettings,
} from "../dist/services/storage.js";
import { signUserToken } from "../dist/services/jwt.js";
import { verifyStudentToken } from "../dist/services/deviceJwt.js";
import { hashPassword } from "../dist/util/password.js";

const TAG = `msready${Date.now()}`;

let schoolA: any;
let schoolB: any;
let adminUser: any;
let superUser: any;
let server: Server;
let baseUrl: string;
let originalRedisUrl: string | undefined;

function inSchool<T>(schoolId: string, fn: () => Promise<T>): Promise<T> {
  return runWithTenantContext({ schoolId }, fn);
}

function asSystem<T>(fn: () => Promise<T>): Promise<T> {
  return runWithTenantContext({ isSuper: true }, fn);
}

async function requestJson(
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {}
): Promise<{ status: number; body: any; headers: Headers }> {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return {
    status: response.status,
    body: text ? JSON.parse(text) : null,
    headers: response.headers,
  };
}

async function loginAsSchoolAdmin(): Promise<{ cookie: string; csrfToken: string }> {
  const login = await requestJson("POST", "/auth/login", {
    email: adminUser.email,
    password: "AdminPass123!",
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.get("set-cookie")?.split(";")[0];
  assert.ok(cookie, "expected login to set a session cookie");

  const csrf = await requestJson("GET", "/auth/csrf", undefined, { cookie });
  assert.equal(csrf.status, 200);
  assert.ok(csrf.body.csrfToken);
  return { cookie, csrfToken: csrf.body.csrfToken };
}

async function registerStudent(body: Record<string, unknown>) {
  return requestJson("POST", "/classpilot/register-student", body);
}

before(async () => {
  originalRedisUrl = process.env.REDIS_URL;
  process.env.REDIS_URL = "";
  mock.timers.enable({ apis: ["setInterval"] });

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS "session" (
      "sid" varchar NOT NULL PRIMARY KEY,
      "sess" json NOT NULL,
      "expire" timestamp(6) NOT NULL
    )
  `);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS "IDX_session_expire" ON "session" ("expire")`);

  schoolA = await createSchool({
    name: `${TAG}_A`,
    domain: `${TAG}-a.example.edu`,
    slug: `${TAG}-a`,
    status: "active",
  } as any);
  schoolB = await createSchool({
    name: `${TAG}_B`,
    domain: `${TAG}-b.example.edu`,
    slug: `${TAG}-b`,
    status: "active",
  } as any);

  await createProductLicense({ schoolId: schoolA.id, product: "CLASSPILOT", status: "active" } as any);
  await createProductLicense({ schoolId: schoolB.id, product: "CLASSPILOT", status: "active" } as any);
  await inSchool(schoolA.id, () => updateEnrollmentSettings(schoolA.id, { autoEnrollStudents: false }));
  await inSchool(schoolB.id, () => updateEnrollmentSettings(schoolB.id, { autoEnrollStudents: false }));

  await inSchool(schoolA.id, () =>
    createStudent({
      schoolId: schoolA.id,
      firstName: "Exact",
      lastName: "Student",
      email: `exact@${TAG}-a.example.edu`,
      status: "active",
    } as any)
  );
  await inSchool(schoolA.id, () =>
    createStudent({
      schoolId: schoolA.id,
      firstName: "Fuzzy",
      lastName: "Target",
      email: `fuzzy.target@${TAG}-a.example.edu`,
      status: "active",
    } as any)
  );

  adminUser = await createUser({
    email: `${TAG}-admin@${TAG}-a.example.edu`,
    password: await hashPassword("AdminPass123!"),
    firstName: "School",
    lastName: "Admin",
  } as any);
  await inSchool(schoolA.id, () =>
    createMembership({
      userId: adminUser.id,
      schoolId: schoolA.id,
      role: "admin",
      status: "active",
    } as any)
  );

  superUser = await createUser({
    email: `${TAG}-super@example.edu`,
    password: await hashPassword("SuperPass123!"),
    firstName: "Super",
    lastName: "Admin",
    isSuperAdmin: true,
  } as any);

  const { createApp } = await import("../dist/app.js");
  const app = createApp();
  server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}/api`;
});

after(async () => {
  if (server) {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  }

  try {
    await asSystem(async () => {
      await db.execute(sql`DELETE FROM student_sessions WHERE device_id LIKE ${`${TAG}-%`}`);
      await db.execute(sql`DELETE FROM student_devices WHERE device_id LIKE ${`${TAG}-%`}`);
      await db.execute(sql`DELETE FROM devices WHERE device_id LIKE ${`${TAG}-%`}`);
      await db.execute(sql`DELETE FROM audit_logs WHERE user_email LIKE ${`${TAG}%@%`}`);
      await db.execute(sql`DELETE FROM settings WHERE school_id IN (${schoolA.id}, ${schoolB.id})`);
      await db.execute(sql`DELETE FROM product_licenses WHERE school_id IN (${schoolA.id}, ${schoolB.id})`);
      await db.execute(sql`DELETE FROM school_memberships WHERE school_id IN (${schoolA.id}, ${schoolB.id})`);
      await db.execute(sql`DELETE FROM students WHERE school_id IN (${schoolA.id}, ${schoolB.id})`);
      await db.execute(sql`DELETE FROM schools WHERE id IN (${schoolA.id}, ${schoolB.id})`);
      await db.execute(sql`DELETE FROM users WHERE email LIKE ${`${TAG}%@%`}`);
      await db.execute(sql`DELETE FROM "session" WHERE sess::text LIKE ${`%${TAG}%`}`);
    });
  } catch {
    /* ignore cleanup errors */
  }
  await pool.end();
  if (originalRedisUrl === undefined) {
    delete process.env.REDIS_URL;
  } else {
    process.env.REDIS_URL = originalRedisUrl;
  }
  mock.timers.reset();
});

describe("multi-school readiness route hardening", () => {
  it("legacy register-student succeeds for an exact roster email in an active ClassPilot school", async () => {
    const response = await registerStudent({
      deviceId: `${TAG}-exact-device`,
      studentEmail: `exact@${TAG}-a.example.edu`,
      schoolId: schoolA.id,
    });

    assert.equal(response.status, 200);
    assert.equal(response.body.student.emailLc, `exact@${TAG}-a.example.edu`);
    const token = verifyStudentToken(response.body.studentToken);
    assert.equal(token.schoolId, schoolA.id);
    assert.equal(token.studentId, response.body.student.id);
  });

  it("legacy register-student rejects a foreign supplied schoolId even when the email resolves", async () => {
    const response = await registerStudent({
      deviceId: `${TAG}-foreign-school-device`,
      studentEmail: `exact@${TAG}-a.example.edu`,
      schoolId: schoolB.id,
    });

    assert.equal(response.status, 403);
    assert.match(response.body.error, /schoolId does not match/i);
  });

  it("legacy register-student rejects unknown roster emails when auto-enroll is off", async () => {
    await inSchool(schoolA.id, () => updateEnrollmentSettings(schoolA.id, { autoEnrollStudents: false }));

    const response = await registerStudent({
      deviceId: `${TAG}-unknown-device`,
      studentEmail: `unknown@${TAG}-a.example.edu`,
      schoolId: schoolA.id,
    });

    assert.equal(response.status, 403);
    assert.match(response.body.error, /Student not enrolled/i);
  });

  it("legacy register-student uses exact email lookup instead of fuzzy student search", async () => {
    await inSchool(schoolA.id, () => updateEnrollmentSettings(schoolA.id, { autoEnrollStudents: false }));

    const response = await registerStudent({
      deviceId: `${TAG}-fuzzy-device`,
      studentEmail: `fuzzy@${TAG}-a.example.edu`,
      schoolId: schoolA.id,
    });

    assert.equal(response.status, 403);
    assert.match(response.body.error, /Student not enrolled/i);
  });

  it("legacy register-student still auto-enrolls only after domain, license, settings, and rate-limit checks", async () => {
    await inSchool(schoolA.id, () => updateEnrollmentSettings(schoolA.id, { autoEnrollStudents: true }));

    const response = await registerStudent({
      deviceId: `${TAG}-auto-device`,
      studentEmail: `auto@${TAG}-a.example.edu`,
      schoolId: schoolA.id,
      firstName: "Auto",
      lastName: "Enroll",
    });

    assert.equal(response.status, 200);
    assert.equal(response.body.student.emailLc, `auto@${TAG}-a.example.edu`);
    const created = await inSchool(schoolA.id, () => getStudentByEmail(schoolA.id, `auto@${TAG}-a.example.edu`));
    assert.equal(created?.id, response.body.student.id);
  });

  it("session users cannot read or update a different school through a raw URL id", async () => {
    const { cookie, csrfToken } = await loginAsSchoolAdmin();

    const ownSchool = await requestJson("GET", `/schools/${schoolA.id}`, undefined, { cookie });
    assert.equal(ownSchool.status, 200);
    assert.equal(ownSchool.body.school.id, schoolA.id);

    const foreignSchool = await requestJson("GET", `/schools/${schoolB.id}`, undefined, { cookie });
    assert.equal(foreignSchool.status, 404);

    const foreignLicenses = await requestJson("GET", `/schools/${schoolB.id}/licenses`, undefined, { cookie });
    assert.equal(foreignLicenses.status, 404);

    const patch = await requestJson(
      "PATCH",
      `/schools/${schoolB.id}`,
      { name: `${TAG}_B_PWNED` },
      { cookie, "x-csrf-token": csrfToken }
    );
    assert.equal(patch.status, 404);

    const unchanged = await getSchoolById(schoolB.id);
    assert.equal(unchanged?.name, `${TAG}_B`);
  });

  it("super admins can still target another school explicitly", async () => {
    const token = signUserToken({
      userId: superUser.id,
      email: superUser.email,
      isSuperAdmin: true,
    });
    const auth = { authorization: `Bearer ${token}` };

    const read = await requestJson("GET", `/schools/${schoolB.id}`, undefined, auth);
    assert.equal(read.status, 200);
    assert.equal(read.body.school.id, schoolB.id);

    const update = await requestJson("PATCH", `/schools/${schoolB.id}`, { name: `${TAG}_B_super_updated` }, auth);
    assert.equal(update.status, 200);
    assert.equal(update.body.school.id, schoolB.id);

    const changed = await getSchoolById(schoolB.id);
    assert.equal(changed?.name, `${TAG}_B_super_updated`);
  });
});
