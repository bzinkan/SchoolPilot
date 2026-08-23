import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { readFileSync } from "node:fs";
import { sql } from "drizzle-orm";

const TAG = `passpilot_settings_${Date.now()}`;
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
let signUserToken: any;
let comparePassword: any;
let server: Server;
let baseUrl: string;
let schoolA: any;
let schoolB: any;
let adminA: any;
let adminB: any;
let teacherA: any;

const DTO_KEYS = [
  "kioskEnabled",
  "kioskPinConfigured",
  "kioskRequiresApproval",
  "kioskStyle",
  "name",
  "revision",
  "schoolTimezone",
];

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

function assertExactDto(value: any): void {
  assert.deepEqual(Object.keys(value).sort(), DTO_KEYS);
  assert.equal(typeof value.name, "string");
  assert.equal(typeof value.schoolTimezone, "string");
  assert.equal(typeof value.kioskEnabled, "boolean");
  assert.equal(typeof value.kioskRequiresApproval, "boolean");
  assert.equal(typeof value.kioskPinConfigured, "boolean");
  assert.equal(Number.isSafeInteger(value.revision), true);
  assert.equal("kioskPin" in value, false);
  assert.equal("kioskPinHash" in value, false);
}

async function cleanup(): Promise<void> {
  if (!schoolA?.id || !schoolB?.id) return;
  await asSystem(async () => {
    const schoolIds = [schoolA.id, schoolB.id];
    const schoolIdList = sql.join(schoolIds.map((id) => sql`${id}`), sql`, `);
    await db.execute(sql`DELETE FROM error_logs WHERE school_id IN (${schoolIdList})`);
    await db.execute(sql`DELETE FROM audit_logs WHERE school_id IN (${schoolIdList})`);
    await db.execute(sql`DELETE FROM settings WHERE school_id IN (${schoolIdList})`);
    await db.execute(sql`DELETE FROM product_licenses WHERE school_id IN (${schoolIdList})`);
    await db.execute(sql`DELETE FROM school_memberships WHERE school_id IN (${schoolIdList})`);
    await db.execute(sql`DELETE FROM schools WHERE id IN (${schoolIdList})`);
    await db.execute(sql`DELETE FROM users WHERE email LIKE ${`%@${TAG}.example.edu`}`);
  });
}

before(async () => {
  const dbModule = await import("../dist/db.js");
  db = dbModule.default;
  pool = dbModule.pool;
  sessionPool = dbModule.sessionPool;
  storage = await import("../dist/services/storage.js");
  ({ runWithTenantContext } = await import("../dist/middleware/tenantContext.js"));
  ({ signUserToken } = await import("../dist/services/jwt.js"));
  ({ comparePassword } = await import("../dist/util/password.js"));
  const schedulerDbModule = await import("../dist/services/schedulerDb.js");
  schedulerPool = schedulerDbModule.schedulerPool;
  schedulerLockPool = schedulerDbModule.schedulerLockPool;

  await pool.query(`
    ALTER TABLE schools
    ADD COLUMN IF NOT EXISTS passpilot_settings_revision INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS kiosk_style TEXT NOT NULL DEFAULT 'simple'
  `);

  schoolA = await storage.createSchool({
    name: `${TAG}_A`,
    domain: `${TAG}.example.edu`,
    slug: `${TAG}-a`,
    schoolTimezone: "America/New_York",
    kioskEnabled: false,
    kioskRequiresApproval: false,
  } as any);
  schoolB = await storage.createSchool({
    name: `${TAG}_B`,
    domain: `${TAG}.example.edu`,
    slug: `${TAG}-b`,
    schoolTimezone: "America/Los_Angeles",
    kioskEnabled: false,
    kioskRequiresApproval: false,
  } as any);
  adminA = await storage.createUser({
    email: `admin-a@${TAG}.example.edu`,
    firstName: "Admin",
    lastName: "Alpha",
  } as any);
  adminB = await storage.createUser({
    email: `admin-b@${TAG}.example.edu`,
    firstName: "Admin",
    lastName: "Beta",
  } as any);
  teacherA = await storage.createUser({
    email: `teacher-a@${TAG}.example.edu`,
    firstName: "Teacher",
    lastName: "Alpha",
  } as any);

  await storage.createMembership({
    userId: adminA.id,
    schoolId: schoolA.id,
    role: "school_admin",
    status: "active",
  } as any);
  await storage.createMembership({
    userId: adminB.id,
    schoolId: schoolB.id,
    role: "admin",
    status: "active",
  } as any);
  await storage.createMembership({
    userId: teacherA.id,
    schoolId: schoolA.id,
    role: "teacher",
    status: "active",
  } as any);

  for (const school of [schoolA, schoolB]) {
    await storage.createProductLicense({
      schoolId: school.id,
      product: "PASSPILOT",
      status: "active",
    } as any);
    await inSchool(school.id, () => storage.upsertSettings(school.id, {
      schoolName: school.name,
      schoolTimezone: school.schoolTimezone,
      wsSharedKey: `${TAG}-private-key`,
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
  }
});

describe("PassPilot admin settings backend", { concurrency: false }, () => {
  it("keeps the schema, fail-closed startup migration, and strict route aliases aligned", () => {
    const schemaSource = readFileSync(new URL("../src/schema/core.ts", import.meta.url), "utf8");
    const migrationSource = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
    const routeIndexSource = readFileSync(new URL("../src/routes/index.ts", import.meta.url), "utf8");
    const compatSource = readFileSync(new URL("../src/routes/compat.ts", import.meta.url), "utf8");
    const authSource = readFileSync(new URL("../src/routes/auth.ts", import.meta.url), "utf8");
    const usersSource = readFileSync(new URL("../src/routes/users.ts", import.meta.url), "utf8");
    assert.match(schemaSource, /passpilotSettingsRevision:\s*integer\("passpilot_settings_revision"\)/);
    assert.match(migrationSource, /ADD COLUMN IF NOT EXISTS passpilot_settings_revision INTEGER NOT NULL DEFAULT 0/);
    assert.match(migrationSource, /schools_passpilot_settings_revision_check/);
    assert.match(schemaSource, /kioskStyle:\s*text\("kiosk_style"\)/);
    assert.match(migrationSource, /ADD COLUMN IF NOT EXISTS kiosk_style TEXT NOT NULL DEFAULT 'simple'/);
    assert.match(migrationSource, /schools_kiosk_style_check/);
    assert.match(migrationSource, /CHECK \(kiosk_style IN \('simple', 'badge'\)\) NOT VALID/);
    assert.match(routeIndexSource, /router\.use\("\/passpilot\/admin\/settings", passpilotSettingsRoutes\)/);
    assert.match(routeIndexSource, /router\.use\("\/admin\/settings", passpilotActiveGradeLevelsCompatibilityRouter\)/);
    assert.match(routeIndexSource, /router\.use\("\/admin\/settings", passpilotLegacySettingsCompatibilityRouter\)/);
    assert.match(routeIndexSource, /router\.use\("\/admin\/settings", passpilotSettingsRoutes\)/);
    assert.doesNotMatch(compatSource, /router\.patch\("\/admin\/settings"/);
    for (const field of [
      "kioskEnabled",
      "kioskRequiresApproval",
      "defaultPassDuration",
      "activeGradeLevels",
    ]) {
      assert.equal(
        authSource.match(new RegExp(`${field}: identity\\.school\\.${field}`, "g"))?.length,
        1,
        `${field} must be serialized by the canonical school identity helper`
      );
      assert.match(usersSource, new RegExp(`${field}: m\\.school\\.${field}`));
    }
    assert.equal(
      authSource.match(/schoolIdentities\.map\(serializeSchoolIdentity\)/g)?.length,
      2,
      "password login and /auth/me must both use the canonical school identity helper"
    );
    assert.doesNotMatch(authSource, /kioskPin(?:Hash)?: m\.school/);
    assert.doesNotMatch(usersSource, /kioskPin(?:Hash)?: m\.school/);
  });

  it("returns only the exact DTO and enforces administrator and tenant scope", async () => {
    const canonical = await requestJson(
      "GET",
      "/passpilot/admin/settings",
      undefined,
      authFor(adminA, schoolA.id)
    );
    assert.equal(canonical.status, 200);
    assertExactDto(canonical.body);
    assert.equal(canonical.body.name, schoolA.name);
    assert.equal(canonical.body.revision, 0);

    const alias = await requestJson(
      "GET",
      "/admin/settings",
      undefined,
      authFor(adminA, schoolA.id)
    );
    assert.equal(alias.status, 200);
    assert.deepEqual(alias.body, canonical.body);

    const teacher = await requestJson(
      "GET",
      "/passpilot/admin/settings",
      undefined,
      authFor(teacherA, schoolA.id)
    );
    assert.equal(teacher.status, 403);
    const crossSchool = await requestJson(
      "GET",
      "/passpilot/admin/settings",
      undefined,
      authFor(adminA, schoolB.id)
    );
    assert.equal(crossSchool.status, 403);
    const unauthenticated = await requestJson("GET", "/passpilot/admin/settings");
    assert.equal(unauthenticated.status, 401);
  });

  it("does not allow the legacy kiosk-config endpoint to bypass admin settings", async () => {
    const teacherAttempt = await requestJson(
      "PUT",
      "/kiosk-config",
      { kioskEnabled: true },
      authFor(teacherA, schoolA.id)
    );
    assert.equal(teacherAttempt.status, 403);

    const adminAttempt = await requestJson(
      "PUT",
      "/kiosk-config",
      { kioskEnabled: true },
      authFor(adminA, schoolA.id)
    );
    assert.equal(adminAttempt.status, 409);
    assert.equal(adminAttempt.body.code, "PASSPILOT_KIOSK_SETTINGS_MANAGED_IN_SETUP");
    assert.equal(adminAttempt.body.managementUrl, "/passpilot/setup?section=settings");

    const persisted = await requestJson(
      "GET",
      "/passpilot/admin/settings",
      undefined,
      authFor(adminA, schoolA.id)
    );
    assert.equal(persisted.status, 200);
    assert.equal(persisted.body.kioskEnabled, false);
    assert.equal(persisted.body.revision, 0);

    for (const [method, body] of [
      ["PUT", { kioskEnabled: true }],
      ["PATCH", { kioskPin: "2468" }],
      ["PATCH", { kioskRequiresApproval: true }],
      ["PATCH", { kioskStyle: "badge" }],
    ] as const) {
      const genericSchoolAttempt = await requestJson(
        method,
        `/schools/${schoolB.id}`,
        body,
        authFor(adminB, schoolB.id)
      );
      assert.equal(genericSchoolAttempt.status, 409);
      assert.equal(
        genericSchoolAttempt.body.code,
        "PASSPILOT_KIOSK_SETTINGS_MANAGED_IN_SETUP"
      );
    }
    const genericPersisted = await requestJson(
      "GET",
      "/passpilot/admin/settings",
      undefined,
      authFor(adminB, schoolB.id)
    );
    assert.equal(genericPersisted.status, 200);
    assert.equal(genericPersisted.body.kioskEnabled, false);
    assert.equal(genericPersisted.body.kioskPinConfigured, false);
    assert.equal(genericPersisted.body.kioskRequiresApproval, false);
    assert.equal(genericPersisted.body.revision, 0);
  });

  it("rejects broad fields, invalid values, and kiosk enablement without a PIN", async () => {
    const headers = authFor(adminB, schoolB.id);
    const invalidBodies = [
      { expectedRevision: 0, planTier: "enterprise" },
      { expectedRevision: 0, schoolTimezone: "Etc/Not_A_Zone" },
      { expectedRevision: 0, name: "   " },
      { expectedRevision: 0, kioskPin: "123" },
      { expectedRevision: 0, activeGradeLevels: "[\"K\"]" },
      { expectedRevision: 0, kioskStyle: "kiosk" },
      { kioskEnabled: false },
    ];
    for (const body of invalidBodies) {
      const response = await requestJson(
        "PATCH",
        "/passpilot/admin/settings",
        body,
        headers
      );
      assert.equal(response.status, 400, JSON.stringify(response.body));
      assert.equal(response.body.code, "PASSPILOT_SETTINGS_INVALID");
    }

    const enableWithoutPin = await requestJson(
      "PATCH",
      "/passpilot/admin/settings",
      { expectedRevision: 0, kioskEnabled: true },
      headers
    );
    assert.equal(enableWithoutPin.status, 400);
    assert.equal(enableWithoutPin.body.code, "PASSPILOT_KIOSK_PIN_REQUIRED");
    assert.equal(enableWithoutPin.body.current.revision, 0);

    const clearWhileEnabling = await requestJson(
      "PATCH",
      "/passpilot/admin/settings",
      { expectedRevision: 0, kioskEnabled: true, kioskPin: null },
      headers
    );
    assert.equal(clearWhileEnabling.status, 400);
    assert.equal(clearWhileEnabling.body.code, "PASSPILOT_KIOSK_PIN_REQUIRED");

    const unchanged = await requestJson("GET", "/admin/settings", undefined, headers);
    assert.equal(unchanged.status, 200);
    assert.equal(unchanged.body.revision, 0);
    assert.equal(unchanged.body.kioskEnabled, false);
    assert.equal(unchanged.body.kioskPinConfigured, false);
  });

  it("preserves the narrow active-grade-level compatibility save without weakening the canonical contract", async () => {
    const headers = authFor(adminB, schoolB.id);
    const saved = await requestJson(
      "PATCH",
      "/admin/settings",
      { activeGradeLevels: "[\"K\",\"1\",\"12\"]" },
      headers
    );
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    assert.deepEqual(saved.body, { activeGradeLevels: "[\"K\",\"1\",\"12\"]" });

    const stored = await asSystem(() => db.execute(sql`
      SELECT active_grade_levels, passpilot_settings_revision
      FROM schools
      WHERE id = ${schoolB.id}
    `));
    assert.equal(stored.rows[0].active_grade_levels, "[\"K\",\"1\",\"12\"]");
    assert.equal(stored.rows[0].passpilot_settings_revision, 0);

    for (const activeGradeLevels of [
      "not-json",
      "[\"K\",\"K\"]",
      "[\"13\"]",
    ]) {
      const invalid = await requestJson(
        "PATCH",
        "/admin/settings",
        { activeGradeLevels },
        headers
      );
      assert.equal(invalid.status, 400);
      assert.equal(invalid.body.code, "PASSPILOT_ACTIVE_GRADE_LEVELS_INVALID");
    }

    const canonicalRejectsCompatibilityField = await requestJson(
      "PATCH",
      "/passpilot/admin/settings",
      { activeGradeLevels: "[\"K\"]" },
      headers
    );
    assert.equal(canonicalRejectsCompatibilityField.status, 400);
    assert.equal(canonicalRejectsCompatibilityField.body.code, "PASSPILOT_SETTINGS_INVALID");

    const audit = await asSystem(() => db.execute(sql`
      SELECT changes, metadata
      FROM audit_logs
      WHERE school_id = ${schoolB.id}
        AND action = 'passpilot.active_grade_levels.update'
      ORDER BY created_at DESC
      LIMIT 1
    `));
    assert.deepEqual(audit.rows[0].changes, { fields: ["activeGradeLevels"] });
    assert.equal(audit.rows[0].metadata.gradeLevelCount, 3);
  });

  it("keeps the deployed no-revision settings payload safe and serializes partial legacy saves", async () => {
    const headers = authFor(adminB, schoolB.id);
    const oldBundlePayload = {
      name: "  Legacy Bundle School  ",
      kioskEnabled: true,
      kioskRequiresApproval: true,
      schoolTimezone: "America/Denver",
      kioskPin: "1357",
    };
    const saved = await requestJson(
      "PATCH",
      "/admin/settings",
      oldBundlePayload,
      headers
    );
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    assertExactDto(saved.body);
    assert.deepEqual(saved.body, {
      name: "Legacy Bundle School",
      schoolTimezone: "America/Denver",
      kioskEnabled: true,
      kioskRequiresApproval: true,
      kioskPinConfigured: true,
      kioskStyle: "simple",
      revision: 1,
    });

    const persisted = await asSystem(() => db.execute(sql`
      SELECT kiosk_pin_hash FROM schools WHERE id = ${schoolB.id}
    `));
    assert.notEqual(persisted.rows[0].kiosk_pin_hash, "1357");
    assert.equal(await comparePassword("1357", persisted.rows[0].kiosk_pin_hash), true);

    const [nameSave, approvalSave] = await Promise.all([
      requestJson(
        "PATCH",
        "/admin/settings",
        { name: "Legacy Serialized Name" },
        headers
      ),
      requestJson(
        "PATCH",
        "/admin/settings",
        { kioskRequiresApproval: false },
        headers
      ),
    ]);
    assert.equal(nameSave.status, 200, JSON.stringify(nameSave.body));
    assert.equal(approvalSave.status, 200, JSON.stringify(approvalSave.body));
    assert.deepEqual(
      [nameSave.body.revision, approvalSave.body.revision].sort((left, right) => left - right),
      [2, 3]
    );

    const refreshed = await requestJson(
      "GET",
      "/passpilot/admin/settings",
      undefined,
      headers
    );
    assert.equal(refreshed.status, 200);
    assert.equal(refreshed.body.name, "Legacy Serialized Name");
    assert.equal(refreshed.body.kioskRequiresApproval, false);
    assert.equal(refreshed.body.kioskEnabled, true);
    assert.equal(refreshed.body.kioskPinConfigured, true);
    assert.equal(refreshed.body.revision, 3);

    const mixedBroadPayload = await requestJson(
      "PATCH",
      "/admin/settings",
      { name: "Forbidden", planTier: "enterprise" },
      headers
    );
    assert.equal(mixedBroadPayload.status, 400);
    assert.equal(mixedBroadPayload.body.code, "PASSPILOT_LEGACY_SETTINGS_INVALID");
    const broadOnlyPayload = await requestJson(
      "PATCH",
      "/admin/settings",
      { planTier: "enterprise" },
      headers
    );
    assert.equal(broadOnlyPayload.status, 400);
    assert.equal(broadOnlyPayload.body.code, "PASSPILOT_SETTINGS_INVALID");
    const canonicalRejectsOldPayload = await requestJson(
      "PATCH",
      "/passpilot/admin/settings",
      oldBundlePayload,
      headers
    );
    assert.equal(canonicalRejectsOldPayload.status, 400);
    assert.equal(canonicalRejectsOldPayload.body.code, "PASSPILOT_SETTINGS_INVALID");

    const audits = await asSystem(() => db.execute(sql`
      SELECT changes, metadata
      FROM audit_logs
      WHERE school_id = ${schoolB.id}
        AND action = 'passpilot.settings.update'
      ORDER BY created_at DESC
      LIMIT 3
    `));
    assert.equal(audits.rows.length, 3);
    for (const audit of audits.rows) {
      assert.equal(audit.metadata.contract, "legacy_alias");
      assert.doesNotMatch(JSON.stringify(audit), /1357|\$2[aby]\$/);
    }
  });

  it("hydrates legacy setup from safe auth membership fields and preserves an enabled kiosk on an unrelated save", async () => {
    const headers = authFor(adminB, schoolB.id);
    const updated = await asSystem(() => storage.updateSchool(schoolB.id, {
      kioskRequiresApproval: true,
      defaultPassDuration: 9,
    }));
    assert.ok(updated);

    const auth = await requestJson("GET", "/auth/me", undefined, headers);
    assert.equal(auth.status, 200, JSON.stringify(auth.body));
    const membership = auth.body.memberships.find(
      (candidate: any) => candidate.schoolId === schoolB.id
    );
    assert.ok(membership);
    assert.equal(membership.kioskEnabled, true);
    assert.equal(membership.kioskRequiresApproval, true);
    assert.equal(membership.defaultPassDuration, 9);
    assert.equal(membership.activeGradeLevels, "[\"K\",\"1\",\"12\"]");
    assert.equal("kioskPin" in membership, false);
    assert.equal("kioskPinHash" in membership, false);

    // The deployed form sends all hydrated settings even when the administrator
    // changes only the school name. Persisted true flags must survive that save.
    const saved = await requestJson(
      "PATCH",
      "/admin/settings",
      {
        name: `${membership.schoolName} Hydrated`,
        schoolTimezone: membership.schoolTimezone,
        kioskEnabled: membership.kioskEnabled,
        kioskRequiresApproval: membership.kioskRequiresApproval,
      },
      headers
    );
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    assert.equal(saved.body.kioskEnabled, true);
    assert.equal(saved.body.kioskRequiresApproval, true);
    assert.equal(saved.body.kioskPinConfigured, true);

    const persisted = await asSystem(() => db.execute(sql`
      SELECT kiosk_enabled, kiosk_requires_approval, default_pass_duration,
             active_grade_levels, kiosk_pin_hash
      FROM schools
      WHERE id = ${schoolB.id}
    `));
    assert.equal(persisted.rows[0].kiosk_enabled, true);
    assert.equal(persisted.rows[0].kiosk_requires_approval, true);
    assert.equal(persisted.rows[0].default_pass_duration, 9);
    assert.equal(persisted.rows[0].active_grade_levels, "[\"K\",\"1\",\"12\"]");
    assert.equal(await comparePassword("1357", persisted.rows[0].kiosk_pin_hash), true);
  });

  it("round-trips settings, mirrors name/timezone, hashes and preserves the PIN, and audits safely", async () => {
    const headers = authFor(adminA, schoolA.id);
    const saved = await requestJson(
      "PATCH",
      "/passpilot/admin/settings",
      {
        expectedRevision: 0,
        name: "  PassPilot Academy  ",
        schoolTimezone: "America/Chicago",
        kioskEnabled: true,
        kioskRequiresApproval: true,
        kioskPin: "2468",
      },
      headers
    );
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    assertExactDto(saved.body);
    assert.deepEqual(saved.body, {
      name: "PassPilot Academy",
      schoolTimezone: "America/Chicago",
      kioskEnabled: true,
      kioskRequiresApproval: true,
      kioskPinConfigured: true,
      kioskStyle: "simple",
      revision: 1,
    });

    const persisted = await asSystem(() => db.execute(sql`
      SELECT name, school_timezone, kiosk_enabled, kiosk_requires_approval,
             kiosk_pin_hash, passpilot_settings_revision
      FROM schools
      WHERE id = ${schoolA.id}
    `));
    const firstHash = persisted.rows[0].kiosk_pin_hash;
    assert.notEqual(firstHash, "2468");
    assert.equal(await comparePassword("2468", firstHash), true);
    assert.equal(persisted.rows[0].passpilot_settings_revision, 1);

    const mirror = await inSchool(schoolA.id, () => db.execute(sql`
      SELECT school_name, school_timezone, ws_shared_key
      FROM settings
      WHERE school_id = ${schoolA.id}
    `));
    assert.equal(mirror.rows[0].school_name, "PassPilot Academy");
    assert.equal(mirror.rows[0].school_timezone, "America/Chicago");
    assert.equal(mirror.rows[0].ws_shared_key, `${TAG}-private-key`);

    const audit = await asSystem(() => db.execute(sql`
      SELECT changes, metadata
      FROM audit_logs
      WHERE school_id = ${schoolA.id}
        AND action = 'passpilot.settings.update'
      ORDER BY created_at DESC
      LIMIT 1
    `));
    const serializedAudit = JSON.stringify(audit.rows[0]);
    assert.doesNotMatch(serializedAudit, /2468/);
    assert.doesNotMatch(serializedAudit, /\$2[aby]\$/);
    assert.equal(audit.rows[0].changes.kioskPin, "configured");
    assert.equal(audit.rows[0].metadata.revision, 1);
    assert.equal(audit.rows[0].metadata.contract, "revisioned");

    const preserved = await requestJson(
      "PATCH",
      "/admin/settings",
      { expectedRevision: 1, kioskRequiresApproval: false },
      headers
    );
    assert.equal(preserved.status, 200);
    assert.equal(preserved.body.revision, 2);
    assert.equal(preserved.body.kioskPinConfigured, true);
    const afterPreserve = await asSystem(() => db.execute(sql`
      SELECT kiosk_pin_hash FROM schools WHERE id = ${schoolA.id}
    `));
    assert.equal(afterPreserve.rows[0].kiosk_pin_hash, firstHash);

    const rejectedClear = await requestJson(
      "PATCH",
      "/passpilot/admin/settings",
      { expectedRevision: 2, kioskPin: null },
      headers
    );
    assert.equal(rejectedClear.status, 400);
    assert.equal(rejectedClear.body.code, "PASSPILOT_KIOSK_PIN_REQUIRED");

    const cleared = await requestJson(
      "PATCH",
      "/passpilot/admin/settings",
      { expectedRevision: 2, kioskEnabled: false, kioskPin: null },
      headers
    );
    assert.equal(cleared.status, 200);
    assert.equal(cleared.body.revision, 3);
    assert.equal(cleared.body.kioskEnabled, false);
    assert.equal(cleared.body.kioskPinConfigured, false);
    const afterClear = await asSystem(() => db.execute(sql`
      SELECT kiosk_pin_hash FROM schools WHERE id = ${schoolA.id}
    `));
    assert.equal(afterClear.rows[0].kiosk_pin_hash, null);
  });

  it("saves the school-wide kiosk style through the revisioned contract and audits it", async () => {
    const headers = authFor(adminA, schoolA.id);
    const current = await requestJson(
      "GET",
      "/passpilot/admin/settings",
      undefined,
      headers
    );
    assert.equal(current.status, 200);
    assert.equal(current.body.kioskStyle, "simple");

    const saved = await requestJson(
      "PATCH",
      "/passpilot/admin/settings",
      { expectedRevision: current.body.revision, kioskStyle: "badge" },
      headers
    );
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    assertExactDto(saved.body);
    assert.equal(saved.body.kioskStyle, "badge");
    assert.equal(saved.body.revision, current.body.revision + 1);

    const persisted = await asSystem(() => db.execute(sql`
      SELECT kiosk_style FROM schools WHERE id = ${schoolA.id}
    `));
    assert.equal(persisted.rows[0].kiosk_style, "badge");

    const audit = await asSystem(() => db.execute(sql`
      SELECT changes
      FROM audit_logs
      WHERE school_id = ${schoolA.id}
        AND action = 'passpilot.settings.update'
      ORDER BY created_at DESC
      LIMIT 1
    `));
    assert.deepEqual(audit.rows[0].changes, { fields: ["kioskStyle"], kioskPin: null });

    const restored = await requestJson(
      "PATCH",
      "/passpilot/admin/settings",
      { expectedRevision: saved.body.revision, kioskStyle: "simple" },
      headers
    );
    assert.equal(restored.status, 200, JSON.stringify(restored.body));
    assert.equal(restored.body.kioskStyle, "simple");
  });

  it("forces a stale settings draft to conflict after an alternate school writer", async () => {
    const headers = authFor(adminA, schoolA.id);
    const draft = await requestJson(
      "GET",
      "/passpilot/admin/settings",
      undefined,
      headers
    );
    assert.equal(draft.status, 200);

    const alternateWrite = await asSystem(() => storage.updateSchool(schoolA.id, {
      kioskRequiresApproval: true,
    }));
    assert.ok(alternateWrite);
    assert.equal(
      alternateWrite.passpilotSettingsRevision,
      draft.body.revision + 1
    );

    const stale = await requestJson(
      "PATCH",
      "/passpilot/admin/settings",
      { expectedRevision: draft.body.revision, name: "Stale Draft Must Not Win" },
      headers
    );
    assert.equal(stale.status, 409);
    assert.equal(stale.body.code, "PASSPILOT_SETTINGS_REVISION_CONFLICT");
    assert.equal(stale.body.current.revision, draft.body.revision + 1);
    assert.equal(stale.body.current.kioskRequiresApproval, true);
    assert.notEqual(stale.body.current.name, "Stale Draft Must Not Win");
  });

  it("fails closed and rolls back the school update and audit when the settings mirror is missing", async () => {
    const headers = authFor(adminB, schoolB.id);
    const current = await requestJson("GET", "/admin/settings", undefined, headers);
    assert.equal(current.status, 200);
    const auditBefore = await asSystem(() => db.execute(sql`
      SELECT count(*)::integer AS count
      FROM audit_logs
      WHERE school_id = ${schoolB.id}
        AND action = 'passpilot.settings.update'
    `));
    await inSchool(schoolB.id, () => db.execute(sql`
      DELETE FROM settings WHERE school_id = ${schoolB.id}
    `));

    const beforeSchool = await asSystem(() => db.execute(sql`
      SELECT name, school_timezone, passpilot_settings_revision
      FROM schools
      WHERE id = ${schoolB.id}
    `));
    const failed = await requestJson(
      "PATCH",
      "/passpilot/admin/settings",
      { expectedRevision: current.body.revision, name: "Must Roll Back" },
      headers
    );
    assert.equal(failed.status, 500);
    assert.equal(failed.body.code, "PASSPILOT_SETTINGS_MIRROR_MISSING");

    const afterSchool = await asSystem(() => db.execute(sql`
      SELECT name, school_timezone, passpilot_settings_revision
      FROM schools
      WHERE id = ${schoolB.id}
    `));
    assert.deepEqual(afterSchool.rows[0], beforeSchool.rows[0]);
    const audit = await asSystem(() => db.execute(sql`
      SELECT count(*)::integer AS count
      FROM audit_logs
      WHERE school_id = ${schoolB.id}
        AND action = 'passpilot.settings.update'
    `));
    assert.equal(audit.rows[0].count, auditBefore.rows[0].count);

    await inSchool(schoolB.id, () => storage.upsertSettings(schoolB.id, {
      schoolName: beforeSchool.rows[0].name,
      schoolTimezone: beforeSchool.rows[0].school_timezone,
      wsSharedKey: `${TAG}-restored-private-key`,
    }));
  });

  it("allows exactly one concurrent save and returns authoritative state on conflict", async () => {
    const headers = authFor(adminB, schoolB.id);
    const current = await requestJson("GET", "/admin/settings", undefined, headers);
    assert.equal(current.status, 200);
    const [left, right] = await Promise.all([
      requestJson(
        "PATCH",
        "/passpilot/admin/settings",
        { expectedRevision: current.body.revision, name: "Concurrent Alpha" },
        headers
      ),
      requestJson(
        "PATCH",
        "/passpilot/admin/settings",
        { expectedRevision: current.body.revision, name: "Concurrent Beta" },
        headers
      ),
    ]);
    const winner = [left, right].find((response) => response.status === 200);
    const conflict = [left, right].find((response) => response.status === 409);
    assert.ok(winner, JSON.stringify([left, right]));
    assert.ok(conflict, JSON.stringify([left, right]));
    assertExactDto(winner.body);
    assert.equal(winner.body.revision, current.body.revision + 1);
    assert.equal(conflict.body.code, "PASSPILOT_SETTINGS_REVISION_CONFLICT");
    assert.deepEqual(conflict.body.current, winner.body);

    const refreshed = await requestJson("GET", "/admin/settings", undefined, headers);
    assert.equal(refreshed.status, 200);
    assert.deepEqual(refreshed.body, winner.body);
    const mirror = await inSchool(schoolB.id, () => db.execute(sql`
      SELECT school_name, school_timezone
      FROM settings
      WHERE school_id = ${schoolB.id}
    `));
    assert.equal(mirror.rows[0].school_name, winner.body.name);
    assert.equal(mirror.rows[0].school_timezone, winner.body.schoolTimezone);
  });
});
