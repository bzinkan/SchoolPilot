import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { sql } from "drizzle-orm";

const TAG = `domain-guard-${Date.now()}`;
const DOMAIN = `${TAG}.example.invalid`;
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
let server: Server;
let baseUrl: string;
let superUser: any;
let existing: any;
const createdSchoolIds: string[] = [];

function asSystem<T>(operation: () => Promise<T>): Promise<T> {
  return runWithTenantContext({ isSuper: true }, operation);
}

function superAuth(): Record<string, string> {
  return {
    authorization: `Bearer ${signUserToken({
      userId: superUser.id,
      email: superUser.email,
      isSuperAdmin: true,
    })}`,
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

async function liveSchoolCount(): Promise<number> {
  const result: any = await asSystem(() =>
    db.execute(sql`SELECT count(*)::int AS count FROM schools WHERE domain = ${DOMAIN} AND deleted_at IS NULL`)
  );
  return result.rows[0].count;
}

async function cleanup(): Promise<void> {
  await asSystem(async () => {
    if (createdSchoolIds.length > 0) {
      const list = sql.join(createdSchoolIds.map((id) => sql`${id}`), sql`, `);
      await db.execute(sql`DELETE FROM audit_logs WHERE school_id IN (${list}) OR entity_id IN (${list})`);
      await db.execute(sql`DELETE FROM settings WHERE school_id IN (${list})`);
      await db.execute(sql`DELETE FROM product_licenses WHERE school_id IN (${list})`);
      await db.execute(sql`DELETE FROM school_memberships WHERE school_id IN (${list})`);
      await db.execute(sql`DELETE FROM schools WHERE id IN (${list})`);
    }
    await db.execute(sql`DELETE FROM schools WHERE domain = ${DOMAIN}`);
    await db.execute(sql`DELETE FROM users WHERE email = ${`super-${TAG}@example.invalid`}`);
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
  const schedulerDbModule = await import("../dist/services/schedulerDb.js");
  schedulerPool = schedulerDbModule.schedulerPool;
  schedulerLockPool = schedulerDbModule.schedulerLockPool;

  superUser = await storage.createUser({
    email: `super-${TAG}@example.invalid`,
    firstName: "Super",
    lastName: "Admin",
    isSuperAdmin: true,
  } as any);
  existing = await storage.createSchool({
    name: `${TAG} Existing`,
    domain: DOMAIN,
    slug: `${TAG}-existing`,
  } as any);
  createdSchoolIds.push(existing.id);

  const { createApp } = await import("../dist/app.js");
  server = createServer(createApp());
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
});

after(async () => {
  try {
    if (server) {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      );
    }
    await cleanup();
  } finally {
    await Promise.allSettled([
      pool?.end(),
      sessionPool?.end(),
      schedulerPool?.end(),
      schedulerLockPool?.end(),
    ]);
    process.env.REDIS_URL = ORIGINAL_REDIS_URL;
    process.env.NODE_ENV = ORIGINAL_NODE_ENV;
  }
});

describe("super-admin school creation warns before reusing a live domain", () => {
  it("POST /super-admin/schools lists the live siblings and refuses until acknowledged", async () => {
    const refused = await requestJson(
      "POST", "/super-admin/schools", { name: `${TAG} Second`, domain: DOMAIN }, superAuth()
    );
    assert.equal(refused.status, 409, JSON.stringify(refused.body));
    assert.equal(refused.body.code, "SCHOOL_DOMAIN_ALREADY_IN_USE");
    assert.deepEqual(
      refused.body.existingSchools.map((school: any) => [school.id, school.name, school.status]),
      [[existing.id, existing.name, "active"]]
    );
    assert.equal(await liveSchoolCount(), 1, "a refused create must not insert");

    const malformed = await requestJson(
      "POST", "/super-admin/schools",
      { name: `${TAG} Second`, domain: DOMAIN, acknowledgeExistingDomain: "yes" }, superAuth()
    );
    assert.equal(malformed.status, 400);
    assert.equal(malformed.body.code, "INVALID_ACKNOWLEDGEMENT");

    const created = await requestJson(
      "POST", "/super-admin/schools",
      { name: `${TAG} Second`, domain: DOMAIN, acknowledgeExistingDomain: true }, superAuth()
    );
    assert.equal(created.status, 201, JSON.stringify(created.body));
    createdSchoolIds.push(created.body.school.id);
    assert.equal(created.body.school.domain, DOMAIN);
    assert.equal(await liveSchoolCount(), 2);

    const audit: any = await asSystem(() =>
      db.execute(sql`
        SELECT metadata FROM audit_logs
        WHERE action = 'school.created' AND entity_id = ${created.body.school.id}
      `)
    );
    assert.equal(audit.rows.length, 1);
    assert.equal(audit.rows[0].metadata.domainAcknowledged, true);
    assert.deepEqual(audit.rows[0].metadata.sharedDomainWith, [existing.id]);
  });

  it("POST /schools applies the same guard through its validated schema", async () => {
    const refused = await requestJson("POST", "/schools", { name: `${TAG} Third`, domain: DOMAIN }, superAuth());
    assert.equal(refused.status, 409, JSON.stringify(refused.body));
    assert.equal(refused.body.code, "SCHOOL_DOMAIN_ALREADY_IN_USE");
    assert.equal(refused.body.existingSchools.length, 2, "both live schools are listed");
    assert.equal(refused.body.existingSchools[0].id, existing.id, "oldest first");

    const malformed = await requestJson(
      "POST", "/schools", { name: `${TAG} Third`, domain: DOMAIN, acknowledgeExistingDomain: "yes" }, superAuth()
    );
    assert.equal(malformed.status, 400);

    const created = await requestJson(
      "POST", "/schools", { name: `${TAG} Third`, domain: DOMAIN, acknowledgeExistingDomain: true }, superAuth()
    );
    assert.equal(created.status, 201, JSON.stringify(created.body));
    createdSchoolIds.push(created.body.school.id);
    assert.equal(await liveSchoolCount(), 3);
  });

  it("creates a school on a fresh domain without any acknowledgement", async () => {
    const created = await requestJson(
      "POST", "/super-admin/schools", { name: `${TAG} Fresh`, domain: `fresh.${DOMAIN}` }, superAuth()
    );
    assert.equal(created.status, 201, JSON.stringify(created.body));
    createdSchoolIds.push(created.body.school.id);
    const audit: any = await asSystem(() =>
      db.execute(sql`
        SELECT metadata FROM audit_logs
        WHERE action = 'school.created' AND entity_id = ${created.body.school.id}
      `)
    );
    assert.equal(audit.rows[0].metadata.domainAcknowledged, false);
    assert.deepEqual(audit.rows[0].metadata.sharedDomainWith, []);
  });
});
