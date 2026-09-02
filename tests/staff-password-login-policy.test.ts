import { after, before, describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { sql } from "drizzle-orm";
import type {
  InsertProductLicense,
  InsertSchool,
  InsertSchoolMembership,
  InsertUser,
} from "../src/schema/core.js";

import db, { pool } from "../dist/db.js";
import { SCHOOLS_STAFF_PASSWORD_LOGIN_EXPAND_SQL } from "../dist/db/migrations27.js";
import { runWithTenantContext } from "../dist/middleware/tenantContext.js";
import {
  createMembership,
  createProductLicense,
  createSchool,
  createUser,
  getSchoolById,
} from "../dist/services/storage.js";
import { signUserToken } from "../dist/services/jwt.js";
import { hashPassword } from "../dist/util/password.js";

// Hyphens only: the login schema validates the email, and zod rejects
// underscores in the domain part.
const TAG = `sp-pwpolicy-${Date.now()}`;
const DOMAIN = `${TAG}.example.edu`;
const PASSWORD = "StaffPass123!";

type CreatedSchool = Awaited<ReturnType<typeof createSchool>>;
type CreatedUser = Awaited<ReturnType<typeof createUser>>;

type MembershipPayload = {
  schoolId: string;
  staffPasswordLoginEnabled?: boolean;
};

type LoginResponse = {
  error?: string;
  code?: string;
  token?: string | null;
  activeSchoolId?: string | null;
  schoolSelectionRequired?: boolean;
  memberships?: MembershipPayload[];
};

type SchoolResponse = {
  error?: string;
  code?: string;
  managementUrl?: string;
  school?: { id: string; staffPasswordLoginEnabled?: boolean; kioskPinHash?: string | null };
};

type AuditRow = {
  action: string;
  school_id: string | null;
  metadata: Record<string, unknown> | null;
  changes: Record<string, unknown> | null;
};

let schoolDisabled: CreatedSchool;
let schoolEnabled: CreatedSchool;
let schoolNative: CreatedSchool;
let schoolExpiredNative: CreatedSchool;
let schoolPolicy: CreatedSchool;
let teacherDisabled: CreatedUser;
let teacherNative: CreatedUser;
let teacherExpiredNative: CreatedUser;
let multiTeacher: CreatedUser;
let superUser: CreatedUser;
let schoolAdminPolicy: CreatedUser;
let adminPolicy: CreatedUser;
let teacherPolicy: CreatedUser;
let server: Server;
let baseUrl: string;
let originalRedisUrl: string | undefined;

function inSchool<T>(schoolId: string, fn: () => Promise<T>): Promise<T> {
  return runWithTenantContext({ schoolId }, fn);
}

function asSystem<T>(fn: () => Promise<T>): Promise<T> {
  return runWithTenantContext({ isSuper: true }, fn);
}

function schoolFixture(label: string, overrides: Partial<InsertSchool> = {}): InsertSchool {
  return {
    name: `${TAG} ${label}`,
    domain: DOMAIN,
    slug: `${TAG}-${label}`,
    status: "active",
    ...overrides,
  };
}

function userFixture(label: string, passwordHash: string, isSuperAdmin = false): InsertUser {
  return {
    email: `${label}@${DOMAIN}`,
    password: passwordHash,
    firstName: label,
    lastName: "Staff",
    isSuperAdmin,
  };
}

function membershipFixture(
  userId: string,
  schoolId: string,
  role: "admin" | "school_admin" | "teacher"
): InsertSchoolMembership {
  return { userId, schoolId, role, status: "active" };
}

function licenseFixture(
  schoolId: string,
  product: "CLASSPILOT" | "GOPILOT",
  expiresAt: Date | null = null
): InsertProductLicense {
  return { schoolId, product, status: "active", expiresAt };
}

async function requestJson<T>(
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {}
): Promise<{ status: number; body: T | null; headers: Headers }> {
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

function login(user: CreatedUser, extra: { password?: string; client?: string } = {}) {
  return requestJson<LoginResponse>("POST", "/auth/login", {
    email: user.email,
    password: extra.password ?? PASSWORD,
    ...(extra.client ? { client: extra.client } : {}),
  });
}

function bearerFor(user: CreatedUser, schoolId: string): Record<string, string> {
  const token = signUserToken({
    userId: user.id,
    email: user.email,
    isSuperAdmin: user.isSuperAdmin === true,
    authVersion: user.authVersion,
  });
  return { authorization: `Bearer ${token}`, "x-school-id": schoolId };
}

async function auditRows(userId: string, action: string): Promise<AuditRow[]> {
  return asSystem(async () => {
    const result = await db.execute(sql`
      SELECT action, school_id, metadata, changes
      FROM audit_logs
      WHERE user_id = ${userId} AND action = ${action}
      ORDER BY created_at ASC
    `);
    return result.rows as AuditRow[];
  });
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

  // Apply the ledgered expand migration exactly as production will.
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(SCHOOLS_STAFF_PASSWORD_LOGIN_EXPAND_SQL);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }

  schoolDisabled = await createSchool(schoolFixture("disabled", { staffPasswordLoginEnabled: false }));
  schoolEnabled = await createSchool(schoolFixture("enabled"));
  schoolNative = await createSchool(schoolFixture("native", { staffPasswordLoginEnabled: false }));
  schoolExpiredNative = await createSchool(
    schoolFixture("expired-native", { staffPasswordLoginEnabled: false })
  );
  schoolPolicy = await createSchool(schoolFixture("policy"));

  await createProductLicense(licenseFixture(schoolDisabled.id, "CLASSPILOT"));
  await createProductLicense(licenseFixture(schoolEnabled.id, "CLASSPILOT"));
  await createProductLicense(licenseFixture(schoolNative.id, "GOPILOT"));
  await createProductLicense(
    licenseFixture(schoolExpiredNative.id, "GOPILOT", new Date(Date.now() - 24 * 60 * 60 * 1000))
  );
  await createProductLicense(licenseFixture(schoolPolicy.id, "CLASSPILOT"));

  const passwordHash = await hashPassword(PASSWORD);
  teacherDisabled = await createUser(userFixture("teacher-disabled", passwordHash));
  teacherNative = await createUser(userFixture("teacher-native", passwordHash));
  teacherExpiredNative = await createUser(userFixture("teacher-expired-native", passwordHash));
  multiTeacher = await createUser(userFixture("teacher-multi", passwordHash));
  superUser = await createUser(userFixture("super", passwordHash, true));
  schoolAdminPolicy = await createUser(userFixture("school-admin-policy", passwordHash));
  adminPolicy = await createUser(userFixture("admin-policy", passwordHash));
  teacherPolicy = await createUser(userFixture("teacher-policy", passwordHash));

  await inSchool(schoolDisabled.id, async () => {
    await createMembership(membershipFixture(teacherDisabled.id, schoolDisabled.id, "teacher"));
    await createMembership(membershipFixture(multiTeacher.id, schoolDisabled.id, "teacher"));
  });
  await inSchool(schoolEnabled.id, () =>
    createMembership(membershipFixture(multiTeacher.id, schoolEnabled.id, "teacher"))
  );
  await inSchool(schoolNative.id, () =>
    createMembership(membershipFixture(teacherNative.id, schoolNative.id, "teacher"))
  );
  await inSchool(schoolExpiredNative.id, () =>
    createMembership(membershipFixture(teacherExpiredNative.id, schoolExpiredNative.id, "teacher"))
  );
  await inSchool(schoolPolicy.id, async () => {
    await createMembership(membershipFixture(schoolAdminPolicy.id, schoolPolicy.id, "school_admin"));
    await createMembership(membershipFixture(adminPolicy.id, schoolPolicy.id, "admin"));
    await createMembership(membershipFixture(teacherPolicy.id, schoolPolicy.id, "teacher"));
  });

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
      const schoolIds = [schoolDisabled, schoolEnabled, schoolNative, schoolExpiredNative, schoolPolicy]
        .filter((school) => school?.id)
        .map((school) => school.id);
      if (schoolIds.length > 0) {
        const ids = sql.join(schoolIds.map((id) => sql`${id}`), sql`, `);
        await db.execute(sql`DELETE FROM audit_logs WHERE school_id IN (${ids})`);
        await db.execute(sql`DELETE FROM settings WHERE school_id IN (${ids})`);
        await db.execute(sql`DELETE FROM product_licenses WHERE school_id IN (${ids})`);
        await db.execute(sql`DELETE FROM school_memberships WHERE school_id IN (${ids})`);
        await db.execute(sql`DELETE FROM schools WHERE id IN (${ids})`);
      }
      await db.execute(sql`DELETE FROM audit_logs WHERE user_email LIKE ${`%@${DOMAIN}`}`);
      await db.execute(sql`DELETE FROM users WHERE email LIKE ${`%@${DOMAIN}`}`);
      await db.execute(sql`DELETE FROM "session" WHERE sess::text LIKE ${`%${DOMAIN}%`}`);
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
});

describe("staff password login policy", () => {
  it("rejects password sign-in for a school that turned it off without starting a session", async () => {
    const response = await login(teacherDisabled, { client: "web" });
    assert.equal(response.status, 403);
    assert.equal(response.body?.code, "STAFF_PASSWORD_LOGIN_DISABLED");
    assert.equal(
      response.body?.error,
      "Password sign-in is turned off for your school. Use Continue with Google."
    );
    assert.equal(response.body?.token, undefined);
    assert.equal(response.headers.get("set-cookie"), null, "policy rejection must not issue a session");

    const rejected = await auditRows(teacherDisabled.id, "auth.rejected");
    assert.equal(rejected.length, 1);
    assert.equal(rejected[0]?.metadata?.reason, "password_login_disabled");
    assert.equal(rejected[0]?.metadata?.method, "password");
    assert.equal(rejected[0]?.school_id, schoolDisabled.id);
  });

  it("still answers 401 for a wrong password so the policy is not a password oracle", async () => {
    const response = await login(teacherDisabled, { password: "WrongPass123!" });
    assert.equal(response.status, 401);
    assert.equal(response.body?.error, "Invalid email or password");
    assert.equal(response.body?.code, undefined);
  });

  it("lets the GoPilot native client sign in while the school holds an active GoPilot license", async () => {
    const native = await login(teacherNative, { client: "gopilot-native" });
    assert.equal(native.status, 200);
    assert.ok(native.body?.token, "native client receives a JWT");
    assert.equal(native.body?.activeSchoolId, schoolNative.id);
    assert.equal(native.body?.memberships?.[0]?.staffPasswordLoginEnabled, false);

    const exempt = await auditRows(teacherNative.id, "auth.login.password_policy_exempt");
    assert.equal(exempt.length, 1);
    assert.equal(exempt[0]?.metadata?.reason, "gopilot_native_client");

    const web = await login(teacherNative, { client: "web" });
    assert.equal(web.status, 403);
    assert.equal(web.body?.code, "STAFF_PASSWORD_LOGIN_DISABLED");
  });

  it("does not exempt the native client without an active GoPilot license", async () => {
    const unlicensed = await login(teacherDisabled, { client: "gopilot-native" });
    assert.equal(unlicensed.status, 403);
    assert.equal(unlicensed.body?.code, "STAFF_PASSWORD_LOGIN_DISABLED");

    const expired = await login(teacherExpiredNative, { client: "gopilot-native" });
    assert.equal(expired.status, 403);
    assert.equal(expired.body?.code, "STAFF_PASSWORD_LOGIN_DISABLED");
  });

  it("allows a staff member whose other school still permits passwords and exposes the flag on /auth/me", async () => {
    const response = await login(multiTeacher);
    assert.equal(response.status, 200);
    assert.equal(response.body?.schoolSelectionRequired, true);
    const byId = new Map(
      (response.body?.memberships ?? []).map((membership) => [membership.schoolId, membership])
    );
    assert.equal(byId.get(schoolDisabled.id)?.staffPasswordLoginEnabled, false);
    assert.equal(byId.get(schoolEnabled.id)?.staffPasswordLoginEnabled, true);

    const cookie = response.headers.get("set-cookie")?.split(";")[0];
    assert.ok(cookie, "allowed login sets a session cookie");
    const me = await requestJson<LoginResponse>("GET", "/auth/me", undefined, { cookie });
    assert.equal(me.status, 200);
    const meById = new Map(
      (me.body?.memberships ?? []).map((membership) => [membership.schoolId, membership])
    );
    assert.equal(meById.get(schoolDisabled.id)?.staffPasswordLoginEnabled, false);
    assert.equal(meById.get(schoolEnabled.id)?.staffPasswordLoginEnabled, true);
  });

  it("never gates super admins", async () => {
    const response = await login(superUser);
    assert.equal(response.status, 200);
    assert.ok(response.body?.token);
  });

  it("lets a school admin manage the policy through the dedicated audited route", async () => {
    const auth = bearerFor(schoolAdminPolicy, schoolPolicy.id);

    const invalid = await requestJson<SchoolResponse>(
      "PUT",
      `/schools/${schoolPolicy.id}/staff-password-login`,
      { enabled: "no" },
      auth
    );
    assert.equal(invalid.status, 400);
    const extra = await requestJson<SchoolResponse>(
      "PUT",
      `/schools/${schoolPolicy.id}/staff-password-login`,
      { enabled: false, name: "Renamed" },
      auth
    );
    assert.equal(extra.status, 400);

    const disable = await requestJson<SchoolResponse>(
      "PUT",
      `/schools/${schoolPolicy.id}/staff-password-login`,
      { enabled: false },
      auth
    );
    assert.equal(disable.status, 200);
    assert.equal(disable.body?.school?.id, schoolPolicy.id);
    assert.equal(disable.body?.school?.staffPasswordLoginEnabled, false);
    assert.equal("kioskPinHash" in (disable.body?.school ?? {}), false);

    const stored = await getSchoolById(schoolPolicy.id);
    assert.equal(stored?.staffPasswordLoginEnabled, false);

    const audits = await auditRows(schoolAdminPolicy.id, "school.staff_password_login.updated");
    assert.equal(audits.length, 1);
    assert.equal(audits[0]?.school_id, schoolPolicy.id);
    assert.deepEqual(audits[0]?.changes, {
      staffPasswordLoginEnabled: { from: true, to: false },
    });

    const blocked = await login(teacherPolicy);
    assert.equal(blocked.status, 403);
    assert.equal(blocked.body?.code, "STAFF_PASSWORD_LOGIN_DISABLED");

    const enable = await requestJson<SchoolResponse>(
      "PUT",
      `/schools/${schoolPolicy.id}/staff-password-login`,
      { enabled: true },
      auth
    );
    assert.equal(enable.status, 200);
    assert.equal(enable.body?.school?.staffPasswordLoginEnabled, true);

    const restored = await login(teacherPolicy);
    assert.equal(restored.status, 200);
    assert.equal(restored.body?.memberships?.[0]?.staffPasswordLoginEnabled, true);
  });

  it("refuses the policy route to teachers and to admins of other schools", async () => {
    const asTeacher = await requestJson<SchoolResponse>(
      "PUT",
      `/schools/${schoolPolicy.id}/staff-password-login`,
      { enabled: false },
      bearerFor(teacherPolicy, schoolPolicy.id)
    );
    assert.equal(asTeacher.status, 403);

    const crossSchool = await requestJson<SchoolResponse>(
      "PUT",
      `/schools/${schoolDisabled.id}/staff-password-login`,
      { enabled: true },
      bearerFor(schoolAdminPolicy, schoolDisabled.id)
    );
    assert.equal(crossSchool.status, 403);

    const unchanged = await getSchoolById(schoolPolicy.id);
    assert.equal(unchanged?.staffPasswordLoginEnabled, true);
    const otherUnchanged = await getSchoolById(schoolDisabled.id);
    assert.equal(otherUnchanged?.staffPasswordLoginEnabled, false);
  });

  it("rejects the field on the generic school update with a management pointer", async () => {
    const auth = bearerFor(adminPolicy, schoolPolicy.id);
    for (const method of ["PUT", "PATCH"]) {
      const response = await requestJson<SchoolResponse>(
        method,
        `/schools/${schoolPolicy.id}`,
        { name: `${TAG} policy renamed`, staffPasswordLoginEnabled: false },
        auth
      );
      assert.equal(response.status, 409, `${method} must reject the policy field`);
      assert.equal(response.body?.code, "STAFF_PASSWORD_LOGIN_MANAGED_IN_SETTINGS");
      assert.equal(response.body?.managementUrl, "/classpilot/settings");
    }

    const unchanged = await getSchoolById(schoolPolicy.id);
    assert.equal(unchanged?.staffPasswordLoginEnabled, true);
    assert.equal(unchanged?.name, `${TAG} policy`);
  });
});
