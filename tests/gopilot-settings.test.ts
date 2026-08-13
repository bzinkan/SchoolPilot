import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { sql } from "drizzle-orm";

const TAG = `gopilot_settings_${Date.now()}`;
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
let gopilotSettings: any;
let runWithTenantContext: any;
let signUserToken: any;
let server: Server;
let baseUrl: string;
let schoolA: any;
let schoolB: any;
let adminA: any;
let adminB: any;
let teacherA: any;

const DTO_KEYS = [
  "autoStartEnabled",
  "dismissalTime",
  "pickupZones",
  "revision",
  "schoolTimezone",
];

function inSchool<T>(schoolId: string, operation: () => Promise<T>): Promise<T> {
  return runWithTenantContext({ schoolId }, operation);
}

function asSystem<T>(operation: () => Promise<T>): Promise<T> {
  return runWithTenantContext({ isSuper: true }, operation);
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
  assert.equal(typeof value.autoStartEnabled, "boolean");
  assert.equal(value.dismissalTime === null || typeof value.dismissalTime === "string", true);
  assert.equal(Array.isArray(value.pickupZones), true);
  assert.equal(Number.isSafeInteger(value.revision), true);
  assert.equal(typeof value.schoolTimezone, "string");
  assert.equal("checkInMethod" in value, false);
  assert.equal("parentTransparencyEnabled" in value, false);
}

async function cleanup(): Promise<void> {
  if (!schoolA?.id || !schoolB?.id) return;
  await asSystem(async () => {
    const ids = [schoolA.id, schoolB.id];
    const list = sql.join(ids.map((id) => sql`${id}`), sql`, `);
    await db.execute(sql`DELETE FROM error_logs WHERE school_id IN (${list})`);
    await db.execute(sql`DELETE FROM audit_logs WHERE school_id IN (${list})`);
    await db.execute(sql`DELETE FROM settings WHERE school_id IN (${list})`);
    await db.execute(sql`DELETE FROM product_licenses WHERE school_id IN (${list})`);
    await db.execute(sql`DELETE FROM school_memberships WHERE school_id IN (${list})`);
    await db.execute(sql`DELETE FROM schools WHERE id IN (${list})`);
    await db.execute(sql`DELETE FROM users WHERE email LIKE ${`%@${TAG}.example.edu`}`);
  });
}

before(async () => {
  const dbModule = await import("../dist/db.js");
  db = dbModule.default;
  pool = dbModule.pool;
  sessionPool = dbModule.sessionPool;
  storage = await import("../dist/services/storage.js");
  gopilotSettings = await import("../dist/services/gopilotSettings.js");
  ({ runWithTenantContext } = await import("../dist/middleware/tenantContext.js"));
  ({ signUserToken } = await import("../dist/services/jwt.js"));
  const schedulerDbModule = await import("../dist/services/schedulerDb.js");
  schedulerPool = schedulerDbModule.schedulerPool;
  schedulerLockPool = schedulerDbModule.schedulerLockPool;

  await pool.query(`
    ALTER TABLE schools
      ADD COLUMN IF NOT EXISTS gopilot_auto_start_enabled BOOLEAN NOT NULL DEFAULT false,
      ADD COLUMN IF NOT EXISTS gopilot_pickup_zones JSONB NOT NULL DEFAULT '[{"id":"A","name":"Zone A"},{"id":"B","name":"Zone B"},{"id":"C","name":"Zone C"}]'::jsonb,
      ADD COLUMN IF NOT EXISTS gopilot_settings_revision INTEGER NOT NULL DEFAULT 0
  `);

  schoolA = await storage.createSchool({
    name: `${TAG}_A`,
    domain: `${TAG}.example.edu`,
    slug: `${TAG}-a`,
    schoolTimezone: "America/New_York",
    dismissalMode: "no_app",
  } as any);
  schoolB = await storage.createSchool({
    name: `${TAG}_B`,
    domain: `${TAG}.example.edu`,
    slug: `${TAG}-b`,
    schoolTimezone: "America/Chicago",
    dismissalMode: "no_app",
  } as any);
  adminA = await storage.createUser({
    email: `admin-a@${TAG}.example.edu`, firstName: "Admin", lastName: "Alpha",
  } as any);
  adminB = await storage.createUser({
    email: `admin-b@${TAG}.example.edu`, firstName: "Admin", lastName: "Beta",
  } as any);
  teacherA = await storage.createUser({
    email: `teacher-a@${TAG}.example.edu`, firstName: "Teacher", lastName: "Alpha",
  } as any);

  for (const [user, school, role] of [
    [adminA, schoolA, "school_admin"],
    [adminB, schoolB, "admin"],
    [teacherA, schoolA, "teacher"],
  ] as const) {
    await storage.createMembership({
      userId: user.id,
      schoolId: school.id,
      role,
      gopilotRole: role,
      status: "active",
    } as any);
  }
  for (const school of [schoolA, schoolB]) {
    await storage.createProductLicense({
      schoolId: school.id,
      product: "GOPILOT",
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

describe("GoPilot staff settings", { concurrency: false }, () => {
  it("fails malformed legacy pickup-zone arrays closed to canonical defaults", () => {
    for (const malformed of [
      [null],
      ["Zone A"],
      [{ id: "bad id!", name: "Bad" }],
      [{ id: "this_identifier_is_far_too_long", name: "Bad" }],
      [{ id: "A", name: "One" }, { id: "a", name: "Duplicate" }],
    ]) {
      assert.deepEqual(
        gopilotSettings.normalizeGoPilotPickupZones(malformed).map((zone: any) => zone.id),
        ["A", "B", "C"]
      );
    }
    assert.deepEqual(
      gopilotSettings.normalizeGoPilotPickupZones([{ id: " north ", name: " North lot " }]),
      [{ id: "north", name: "North lot" }]
    );
  });

  it("returns the exact staff DTO with safe defaults and role scope", async () => {
    const admin = await requestJson("GET", "/gopilot/settings", undefined, authFor(adminA, schoolA.id));
    assert.equal(admin.status, 200);
    assertExactDto(admin.body);
    assert.equal(admin.body.autoStartEnabled, false);
    assert.equal(admin.body.revision, 0);
    assert.deepEqual(admin.body.pickupZones.map((zone: any) => zone.id), ["A", "B", "C"]);

    const teacher = await requestJson("GET", "/gopilot/settings", undefined, authFor(teacherA, schoolA.id));
    assert.equal(teacher.status, 200);
    assertExactDto(teacher.body);
    const teacherPatch = await requestJson(
      "PATCH", "/gopilot/settings", { expectedRevision: 0, dismissalTime: "15:00" }, authFor(teacherA, schoolA.id)
    );
    assert.equal(teacherPatch.status, 403);
    const crossSchool = await requestJson("GET", "/gopilot/settings", undefined, authFor(adminA, schoolB.id));
    assert.equal(crossSchool.status, 403);
  });

  it("rejects unknown, parent-era, and invalid settings", async () => {
    const headers = authFor(adminA, schoolA.id);
    for (const body of [
      { expectedRevision: 0, checkInMethod: "app" },
      { expectedRevision: 0, schoolTimezone: "Etc/Unknown" },
      { expectedRevision: 0, dismissalTime: "3:00 PM" },
      { expectedRevision: 0, pickupZones: [] },
      { expectedRevision: 0, pickupZones: [{ id: "A", name: "One" }, { id: "a", name: "Two" }] },
      { expectedRevision: 0 },
    ]) {
      const response = await requestJson("PATCH", "/gopilot/settings", body, headers);
      assert.equal(response.status, 400, JSON.stringify(response.body));
      assert.equal(response.body.code, "GOPILOT_SETTINGS_INVALID");
    }
    const noTime = await requestJson(
      "PATCH", "/gopilot/settings", { expectedRevision: 0, autoStartEnabled: true }, headers
    );
    assert.equal(noTime.status, 400);
    assert.equal(noTime.body.code, "GOPILOT_DISMISSAL_TIME_REQUIRED");
  });

  it("saves atomically, mirrors timezone, audits only field names, and detects stale revisions", async () => {
    const headers = authFor(adminA, schoolA.id);
    const saved = await requestJson("PATCH", "/gopilot/settings", {
      expectedRevision: 0,
      dismissalTime: "15:10",
      schoolTimezone: "America/Denver",
      autoStartEnabled: true,
      pickupZones: [{ id: "north", name: "North lot" }, { id: "south", name: "South lot" }],
    }, headers);
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    assertExactDto(saved.body);
    assert.equal(saved.body.revision, 1);
    assert.equal(saved.body.autoStartEnabled, true);

    const persisted = await requestJson("GET", "/gopilot/settings", undefined, headers);
    assert.deepEqual(persisted.body, saved.body);
    const mirrorResult = await inSchool(schoolA.id, () => db.execute(sql`
      SELECT school_timezone FROM settings WHERE school_id = ${schoolA.id}
    `));
    const mirror = mirrorResult.rows[0];
    assert.equal(mirror.school_timezone, "America/Denver");
    const auditResult = await inSchool(schoolA.id, () => db.execute(sql`
      SELECT action, changes, metadata FROM audit_logs
      WHERE school_id = ${schoolA.id} AND action = 'gopilot.settings.update'
      ORDER BY created_at DESC LIMIT 1
    `));
    const audit = auditResult.rows[0];
    assert.deepEqual(audit.changes.fields.sort(), [
      "autoStartEnabled", "dismissalTime", "pickupZones", "schoolTimezone",
    ]);
    assert.equal(JSON.stringify(audit).includes("North lot"), false);

    const stale = await requestJson(
      "PATCH", "/gopilot/settings", { expectedRevision: 0, autoStartEnabled: false }, headers
    );
    assert.equal(stale.status, 409);
    assert.equal(stale.body.code, "GOPILOT_SETTINGS_REVISION_CONFLICT");
    assert.equal(stale.body.current.revision, 1);
  });

  it("tombstones parent digest APIs and never changes their historical settings", async () => {
    const headers = authFor(adminB, schoolB.id);
    for (const [method, body] of [
      ["GET", undefined],
      ["PATCH", { parentTransparencyEnabled: true }],
    ] as const) {
      const response = await requestJson(method, "/gopilot/settings/parent-digests", body, headers);
      assert.equal(response.status, 410);
      assert.equal(response.body.code, "GOPILOT_PARENT_PORTAL_DISABLED");
    }
    const result = await inSchool(schoolB.id, () => db.execute(sql`
      SELECT parent_transparency_enabled FROM settings WHERE school_id = ${schoolB.id}
    `));
    const row = result.rows[0];
    assert.equal(row.parent_transparency_enabled, false);
  });

  it("treats a shared timezone change in another product as a revision conflict", async () => {
    const changed = await inSchool(schoolA.id, () =>
      storage.updateSchool(schoolA.id, { schoolTimezone: "America/Chicago" })
    );
    assert.equal(changed.schoolTimezone, "America/Chicago");

    const current = await requestJson(
      "GET", "/gopilot/settings", undefined, authFor(adminA, schoolA.id)
    );
    assert.equal(current.body.schoolTimezone, "America/Chicago");
    assert.equal(current.body.revision, 2);
    const stale = await requestJson(
      "PATCH",
      "/gopilot/settings",
      { expectedRevision: 1, autoStartEnabled: false },
      authFor(adminA, schoolA.id)
    );
    assert.equal(stale.status, 409);
    assert.equal(stale.body.current.revision, 2);
  });

  it("keeps the previous settings alias read-only so stale clients cannot overwrite revisions", async () => {
    const headers = authFor(adminB, schoolB.id);
    const response = await requestJson("PUT", "/compat/school-settings", {
      autoDismissalEnabled: false,
      pickupZones: [{ id: "office", name: "Office" }],
      checkInMethod: "app",
      enableQrCodes: true,
      changeRequestWarning: "retired",
    }, headers);
    assert.equal(response.status, 426, JSON.stringify(response.body));
    assert.equal(response.body.code, "GOPILOT_SETTINGS_CLIENT_UPDATE_REQUIRED");
    const result = await inSchool(schoolB.id, () => db.execute(sql`
      SELECT settings, dismissal_mode, gopilot_settings_revision
      FROM schools WHERE id = ${schoolB.id}
    `));
    const school = result.rows[0];
    assert.equal(school.dismissal_mode, "no_app");
    assert.equal(school.settings, null);
    assert.equal(Number(school.gopilot_settings_revision), 0);
  });

  it("treats an expired GoPilot license as inactive in HTTP access and auth state", async () => {
    const headers = authFor(adminB, schoolB.id);
    await asSystem(() => db.execute(sql`
      UPDATE product_licenses
      SET expires_at = NOW() - INTERVAL '1 minute'
      WHERE school_id = ${schoolB.id} AND product = 'GOPILOT'
    `));
    try {
      const settings = await requestJson("GET", "/gopilot/settings", undefined, headers);
      assert.equal(settings.status, 403);
      assert.equal(settings.body.error, "Product license required");

      const auth = await requestJson("GET", "/auth/me", undefined, headers);
      assert.equal(auth.status, 200, JSON.stringify(auth.body));
      assert.equal(auth.body.licenses.goPilot, false);
    } finally {
      await asSystem(() => db.execute(sql`
        UPDATE product_licenses
        SET expires_at = NULL
        WHERE school_id = ${schoolB.id} AND product = 'GOPILOT'
      `));
    }
  });
});
