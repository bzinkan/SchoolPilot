import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { readFileSync } from "node:fs";
import { sql } from "drizzle-orm";
import type {
  InsertProductLicense,
  InsertSchool,
  InsertSchoolMembership,
  InsertUser,
} from "../src/schema/core.js";

const TAG = `cp_sso_policy_${Date.now()}`;
const ORIGINAL_REDIS_URL = process.env.REDIS_URL;
const ORIGINAL_NODE_ENV = process.env.NODE_ENV;
const ORIGINAL_PROTOCOL_V3 = process.env.CLASSPILOT_PROTOCOL_V3_ENABLED;
const ORIGINAL_CAPABILITY = process.env.CLASSPILOT_CAP_RESTRICTION_AUTH_PASS_THROUGH_V1;
const ORIGINAL_ROLLOUTS = process.env.CLASSPILOT_CAPABILITY_ROLLOUTS_JSON;
process.env.REDIS_URL = "";
process.env.NODE_ENV = "test";
process.env.CLASSPILOT_PROTOCOL_V3_ENABLED = "false";
process.env.CLASSPILOT_CAP_RESTRICTION_AUTH_PASS_THROUGH_V1 = "false";
delete process.env.CLASSPILOT_CAPABILITY_ROLLOUTS_JSON;

let db: any;
let pool: any;
let sessionPool: any;
let schedulerPool: any;
let schedulerLockPool: any;
let storage: any;
let policyModule: any;
let runWithTenantContext: any;
let signUserToken: any;
let server: Server;
let baseUrl: string;
let schoolA: any;
let schoolB: any;
let adminA: any;
let adminB: any;
let teacherA: any;
let officeA: any;
let superAdmin: any;

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
      isSuperAdmin: !!user.isSuperAdmin,
    })}`,
    "x-school-id": schoolId,
  };
}

async function requestJson(
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {}
): Promise<{ status: number; body: any }> {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

function enabledPolicy(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    enabled: true,
    defaultProfileId: "clever",
    attemptTtlSeconds: 300,
    profiles: policyModule.builtInClasspilotSsoProfiles().map((profile: any) => (
      profile.id === "clever"
        ? { ...profile, startUrl: "https://clever.com/in/district?source=schoolpilot" }
        : profile
    )),
    ...overrides,
  };
}

function schoolFixture(suffix: "A" | "B"): InsertSchool {
  return {
    name: `${TAG}_${suffix}`,
    domain: `${TAG}.example.edu`,
    slug: `${TAG}-${suffix.toLowerCase()}`,
  };
}

function userFixture(
  localPart: string,
  firstName: string,
  lastName: string,
  isSuperAdmin = false
): InsertUser {
  return {
    email: `${localPart}@${TAG}.example.edu`,
    firstName,
    lastName,
    ...(isSuperAdmin ? { isSuperAdmin: true } : {}),
  };
}

function membershipFixture(
  userId: string,
  schoolId: string,
  role: "school_admin" | "admin" | "teacher" | "office_staff"
): InsertSchoolMembership {
  return {
    userId,
    schoolId,
    role,
    status: "active",
  };
}

function classpilotLicenseFixture(schoolId: string): InsertProductLicense {
  return {
    schoolId,
    product: "CLASSPILOT",
    status: "active",
  };
}

async function cleanup(): Promise<void> {
  if (!schoolA?.id || !schoolB?.id) return;
  await asSystem(async () => {
    const ids = sql.join([schoolA.id, schoolB.id].map((id) => sql`${id}`), sql`, `);
    await db.execute(sql`DELETE FROM error_logs WHERE school_id IN (${ids})`);
    await db.execute(sql`DELETE FROM audit_logs WHERE school_id IN (${ids})`);
    await db.execute(sql`DELETE FROM settings WHERE school_id IN (${ids})`);
    await db.execute(sql`DELETE FROM product_licenses WHERE school_id IN (${ids})`);
    await db.execute(sql`DELETE FROM school_memberships WHERE school_id IN (${ids})`);
    await db.execute(sql`DELETE FROM schools WHERE id IN (${ids})`);
    await db.execute(sql`DELETE FROM users WHERE email LIKE ${`%@${TAG}.example.edu`}`);
  });
}

before(async () => {
  const dbModule = await import("../dist/db.js");
  db = dbModule.default;
  pool = dbModule.pool;
  sessionPool = dbModule.sessionPool;
  storage = await import("../dist/services/storage.js");
  policyModule = await import("../dist/services/classpilotSsoPolicy.js");
  const migrations = await import("../dist/db/migrations27.js");
  ({ runWithTenantContext } = await import("../dist/middleware/tenantContext.js"));
  ({ signUserToken } = await import("../dist/services/jwt.js"));
  const schedulerDbModule = await import("../dist/services/schedulerDb.js");
  schedulerPool = schedulerDbModule.schedulerPool;
  schedulerLockPool = schedulerDbModule.schedulerLockPool;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(migrations.CLASSPILOT_SSO_POLICY_EXPAND_SQL);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }

  schoolA = await storage.createSchool(schoolFixture("A"));
  schoolB = await storage.createSchool(schoolFixture("B"));
  adminA = await storage.createUser(userFixture("admin-a", "Admin", "Alpha"));
  adminB = await storage.createUser(userFixture("admin-b", "Admin", "Beta"));
  teacherA = await storage.createUser(userFixture("teacher-a", "Teacher", "Alpha"));
  officeA = await storage.createUser(userFixture("office-a", "Office", "Alpha"));
  superAdmin = await storage.createUser(userFixture("super", "Super", "Admin", true));
  await storage.createMembership(membershipFixture(adminA.id, schoolA.id, "school_admin"));
  await storage.createMembership(membershipFixture(adminB.id, schoolB.id, "admin"));
  await storage.createMembership(membershipFixture(teacherA.id, schoolA.id, "teacher"));
  await storage.createMembership(membershipFixture(officeA.id, schoolA.id, "office_staff"));
  for (const school of [schoolA, schoolB]) {
    await storage.createProductLicense(classpilotLicenseFixture(school.id));
    await inSchool(school.id, () => storage.upsertSettings(school.id, {
      schoolName: school.name,
      wsSharedKey: `${TAG}-private-key`,
      blockedDomains: school.id === schoolA.id ? ["accounts.google.com"] : [],
    }));
  }

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
    await cleanup();
  } finally {
    await schedulerLockPool?.end().catch(() => undefined);
    await schedulerPool?.end().catch(() => undefined);
    await sessionPool?.end().catch(() => undefined);
    await pool?.end().catch(() => undefined);
    if (ORIGINAL_REDIS_URL === undefined) delete process.env.REDIS_URL;
    else process.env.REDIS_URL = ORIGINAL_REDIS_URL;
    if (ORIGINAL_NODE_ENV === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = ORIGINAL_NODE_ENV;
    if (ORIGINAL_PROTOCOL_V3 === undefined) delete process.env.CLASSPILOT_PROTOCOL_V3_ENABLED;
    else process.env.CLASSPILOT_PROTOCOL_V3_ENABLED = ORIGINAL_PROTOCOL_V3;
    if (ORIGINAL_CAPABILITY === undefined) delete process.env.CLASSPILOT_CAP_RESTRICTION_AUTH_PASS_THROUGH_V1;
    else process.env.CLASSPILOT_CAP_RESTRICTION_AUTH_PASS_THROUGH_V1 = ORIGINAL_CAPABILITY;
    if (ORIGINAL_ROLLOUTS === undefined) delete process.env.CLASSPILOT_CAPABILITY_ROLLOUTS_JSON;
    else process.env.CLASSPILOT_CAPABILITY_ROLLOUTS_JSON = ORIGINAL_ROLLOUTS;
  }
});

describe("ClassPilot administrator SSO policy", { concurrency: false }, () => {
  it("keeps schema, immutable migration, and dedicated route aligned", () => {
    const schema = readFileSync(new URL("../src/schema/shared.ts", import.meta.url), "utf8");
    const migrations = readFileSync(new URL("../src/db/migrations27.ts", import.meta.url), "utf8");
    const routes = readFileSync(new URL("../src/routes/index.ts", import.meta.url), "utf8");
    assert.match(schema, /classpilotSsoPolicy:\s*jsonb\("classpilot_sso_policy"\)/);
    assert.match(schema, /classpilotSsoPolicyRevision:\s*integer\("classpilot_sso_policy_revision"\)/);
    assert.match(migrations, /20260901_classpilot_sso_policy_expand/);
    assert.match(migrations, /settings_cp_sso_policy_object_check/);
    assert.match(migrations, /settings_cp_sso_policy_revision_check/);
    assert.match(routes, /router\.use\("\/classpilot\/admin\/sso-policy", classpilotSsoPolicyRoutes\)/);
  });

  it("canonicalizes safe providers and rejects unsafe or ambiguous host policy", () => {
    const canonical = policyModule.canonicalizeClasspilotSsoPolicy(enabledPolicy());
    assert.equal(canonical.enabled, true);
    assert.equal(canonical.attemptTtlSeconds, 300);
    assert.equal(canonical.profiles.find((profile: any) => profile.id === "clever").startUrl,
      "https://clever.com/in/district?source=schoolpilot");

    const invalidPolicies = [
      enabledPolicy({
        profiles: [{
          id: "custom",
          name: "Public suffix",
          startUrl: "https://co.uk/",
          hostRules: [{ hostname: "co.uk", includeSubdomains: true }],
        }],
        defaultProfileId: "custom",
      }),
      enabledPolicy({
        profiles: [{
          id: "custom",
          name: "Local",
          startUrl: "https://127.0.0.1/",
          hostRules: [{ hostname: "127.0.0.1", includeSubdomains: false }],
        }],
        defaultProfileId: "custom",
      }),
      enabledPolicy({
        profiles: [{
          id: "google",
          name: "Google",
          startUrl: "https://accounts.google.com.evil.test/",
          hostRules: [{ hostname: "accounts.google.com.evil.test", includeSubdomains: false }],
        }],
        defaultProfileId: "google",
      }),
      enabledPolicy({
        profiles: [{
          id: "clever",
          name: "Clever",
          startUrl: "https://evilclever.com/",
          hostRules: [
            { hostname: "evilclever.com", includeSubdomains: true },
            { hostname: "accounts.google.com", includeSubdomains: false },
          ],
        }],
        defaultProfileId: "clever",
      }),
      enabledPolicy({
        profiles: [{
          id: "custom",
          name: "Wildcard",
          startUrl: "https://login.example.edu/",
          hostRules: [{ hostname: "*.example.edu", includeSubdomains: true }],
        }],
        defaultProfileId: "custom",
      }),
      enabledPolicy({
        profiles: [{
          id: "custom",
          name: "HTTP",
          startUrl: "http://login.example.edu/",
          hostRules: [{ hostname: "login.example.edu", includeSubdomains: false }],
        }],
        defaultProfileId: "custom",
      }),
      enabledPolicy({
        profiles: [{
          id: "custom",
          name: "Credentials",
          startUrl: "https://student:secret@login.example.edu/",
          hostRules: [{ hostname: "login.example.edu", includeSubdomains: false }],
        }],
        defaultProfileId: "custom",
      }),
      enabledPolicy({
        profiles: [{
          id: "custom",
          name: "Fragment",
          startUrl: "https://login.example.edu/start#token",
          hostRules: [{ hostname: "login.example.edu", includeSubdomains: false }],
        }],
        defaultProfileId: "custom",
      }),
      enabledPolicy({
        profiles: [{
          id: "custom",
          name: "Port",
          startUrl: "https://login.example.edu:444/",
          hostRules: [{ hostname: "login.example.edu", includeSubdomains: false }],
        }],
        defaultProfileId: "custom",
      }),
      enabledPolicy({
        profiles: [{
          id: "custom",
          name: "Trailing dot",
          startUrl: "https://login.example.edu./",
          hostRules: [{ hostname: "login.example.edu.", includeSubdomains: false }],
        }],
        defaultProfileId: "custom",
      }),
      enabledPolicy({
        profiles: [{
          id: "custom",
          name: "Malformed IDN",
          startUrl: "https://login.example.edu/",
          hostRules: [{ hostname: "\ud800.example.edu", includeSubdomains: false }],
        }],
        defaultProfileId: "custom",
      }),
      enabledPolicy({
        profiles: [{
          id: "custom",
          name: "Duplicate rules",
          startUrl: "https://login.example.edu/",
          hostRules: [
            { hostname: "login.example.edu", includeSubdomains: false },
            { hostname: "LOGIN.EXAMPLE.EDU", includeSubdomains: false },
          ],
        }],
        defaultProfileId: "custom",
      }),
      enabledPolicy({
        profiles: [
          {
            id: "custom",
            name: "Duplicate one",
            startUrl: "https://login.example.edu/",
            hostRules: [{ hostname: "login.example.edu", includeSubdomains: false }],
          },
          {
            id: "CUSTOM",
            name: "Duplicate two",
            startUrl: "https://auth.example.edu/",
            hostRules: [{ hostname: "auth.example.edu", includeSubdomains: false }],
          },
        ],
        defaultProfileId: "custom",
      }),
      { ...enabledPolicy(), unexpected: true },
    ];
    for (const policy of invalidPolicies) {
      assert.throws(
        () => policyModule.canonicalizeClasspilotSsoPolicy(policy),
        (error: any) => error.code === "CLASSPILOT_SSO_POLICY_INVALID"
      );
    }
  });

  it("enforces authentication, role, entitlement, and tenant boundaries", async () => {
    const noAuth = await requestJson("GET", "/classpilot/admin/sso-policy");
    assert.equal(noAuth.status, 401);

    const teacher = await requestJson(
      "GET",
      "/classpilot/admin/sso-policy",
      undefined,
      authFor(teacherA, schoolA.id)
    );
    assert.equal(teacher.status, 403);

    const office = await requestJson(
      "GET",
      "/classpilot/admin/sso-policy",
      undefined,
      authFor(officeA, schoolA.id)
    );
    assert.equal(office.status, 403);

    const crossTenant = await requestJson(
      "GET",
      "/classpilot/admin/sso-policy",
      undefined,
      authFor(adminA, schoolB.id)
    );
    assert.equal(crossTenant.status, 403);

    const admin = await requestJson(
      "GET",
      "/classpilot/admin/sso-policy",
      undefined,
      authFor(adminA, schoolA.id)
    );
    assert.equal(admin.status, 200);
    assert.equal(admin.body.policy.enabled, false);
    assert.equal(admin.body.revision, 0);
    assert.equal(admin.body.rolloutActive, false);
    assert.equal(admin.body.operatorGateActive, false);
    assert.equal(admin.body.requiredCapability, "restrictionAuthPassThroughV1");
    assert.deepEqual(admin.body.extensionReadiness, {
      capability: "restrictionAuthPassThroughV1",
      observationWindowSeconds: 300,
      recentlyActiveBindings: 0,
      observedBindings: 0,
      rawCapableBindings: 0,
      acceptedCapableBindings: 0,
      readyBindings: 0,
      unknownBindings: 0,
      status: "rollout_disabled",
    });
    assert.equal("wsSharedKey" in admin.body, false);

    const superResponse = await requestJson(
      "GET",
      "/classpilot/admin/sso-policy",
      undefined,
      authFor(superAdmin, schoolA.id)
    );
    assert.equal(superResponse.status, 200);

    await asSystem(() => db.execute(sql`
      UPDATE product_licenses
      SET status = 'inactive'
      WHERE school_id = ${schoolB.id} AND product = 'CLASSPILOT'
    `));
    const notEntitled = await requestJson(
      "GET",
      "/classpilot/admin/sso-policy",
      undefined,
      authFor(adminB, schoolB.id)
    );
    assert.equal(notEntitled.status, 403);
    assert.equal(notEntitled.body.code, "CLASSPILOT_NOT_ENTITLED");
  });

  it("saves atomically, audits without URLs, reports conflicts, and rejects stale revisions", async () => {
    const saved = await requestJson(
      "PATCH",
      "/classpilot/admin/sso-policy",
      { expectedRevision: 0, policy: enabledPolicy() },
      authFor(adminA, schoolA.id)
    );
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    assert.equal(saved.body.revision, 1);
    assert.equal(saved.body.policy.enabled, true);
    assert.ok(saved.body.conflicts.some((conflict: any) => (
      conflict.hostname === "accounts.google.com"
      && conflict.blockedDomain === "accounts.google.com"
    )));

    const audit: any = await asSystem(() => db.execute(sql`
      SELECT action, changes::text AS changes, metadata::text AS metadata
      FROM audit_logs
      WHERE school_id = ${schoolA.id}
        AND action = 'classpilot.sso_policy.updated'
      ORDER BY created_at DESC
      LIMIT 1
    `));
    assert.equal(audit.rows[0].action, "classpilot.sso_policy.updated");
    const auditText = `${audit.rows[0].changes} ${audit.rows[0].metadata}`;
    assert.doesNotMatch(auditText, /clever\.com|source=schoolpilot|accounts\.google\.com/);

    const stale = await requestJson(
      "PATCH",
      "/classpilot/admin/sso-policy",
      { expectedRevision: 0, policy: policyModule.disabledClasspilotSsoPolicy() },
      authFor(adminA, schoolA.id)
    );
    assert.equal(stale.status, 409);
    assert.equal(stale.body.code, "CLASSPILOT_SSO_POLICY_REVISION_CONFLICT");
    assert.equal(stale.body.current.revision, 1);
    assert.equal(stale.body.current.policy.enabled, true);

    const schoolBPolicy: any = await inSchool(schoolB.id, () =>
      storage.getClasspilotSsoPolicyForSchool(schoolA.id)
    );
    assert.equal(schoolBPolicy.revision, 0);
    assert.equal(schoolBPolicy.policy.enabled, false);
  });

  it("fails closed on malformed persistence and allows an administrator to repair it", async () => {
    await inSchool(schoolA.id, () => db.execute(sql`
      UPDATE settings
      SET classpilot_sso_policy = '{"enabled":true}'::jsonb,
          classpilot_sso_policy_revision = 5
      WHERE school_id = ${schoolA.id}
    `));
    const malformed = await requestJson(
      "GET",
      "/classpilot/admin/sso-policy",
      undefined,
      authFor(adminA, schoolA.id)
    );
    assert.equal(malformed.status, 200);
    assert.equal(malformed.body.policyValid, false);
    assert.equal(malformed.body.policy.enabled, false);
    assert.equal(malformed.body.revision, 5);

    const repaired = await requestJson(
      "PATCH",
      "/classpilot/admin/sso-policy",
      { expectedRevision: 5, policy: policyModule.disabledClasspilotSsoPolicy() },
      authFor(adminA, schoolA.id)
    );
    assert.equal(repaired.status, 200);
    assert.equal(repaired.body.policyValid, true);
    assert.equal(repaired.body.revision, 6);
  });
});
