import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { sql } from "drizzle-orm";

const TAG = `retired_register_${Date.now()}`;
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
let server: Server;
let baseUrl: string;
let existingUser: any;
let startedAt: Date;

function asSystem<T>(operation: () => Promise<T>): Promise<T> {
  return runWithTenantContext({ isSuper: true }, operation);
}

async function post(path: string, body: unknown) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  return {
    status: response.status,
    body: text ? JSON.parse(text) : null,
    setCookie: response.headers.get("set-cookie"),
  };
}

async function cleanup(): Promise<void> {
  await asSystem(async () => {
    await db.execute(sql`
      DELETE FROM audit_logs
      WHERE action = 'auth.register.retired'
        AND (user_email LIKE ${`%@${DOMAIN}`} OR (user_email IS NULL AND created_at >= ${startedAt}))
    `);
    await db.execute(sql`DELETE FROM school_memberships WHERE user_id IN (SELECT id FROM users WHERE email LIKE ${`%@${DOMAIN}`})`);
    await db.execute(sql`DELETE FROM users WHERE email LIKE ${`%@${DOMAIN}`}`);
    await db.execute(sql`DELETE FROM schools WHERE domain = ${DOMAIN}`);
  });
}

before(async () => {
  startedAt = new Date(Date.now() - 1000);
  const dbModule = await import("../dist/db.js");
  db = dbModule.default;
  pool = dbModule.pool;
  sessionPool = dbModule.sessionPool;
  storage = await import("../dist/services/storage.js");
  ({ runWithTenantContext } = await import("../dist/middleware/tenantContext.js"));
  const schedulerDbModule = await import("../dist/services/schedulerDb.js");
  schedulerPool = schedulerDbModule.schedulerPool;
  schedulerLockPool = schedulerDbModule.schedulerLockPool;

  existingUser = await storage.createUser({
    email: `existing@${DOMAIN}`,
    firstName: "Existing",
    lastName: "User",
  } as any);

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

describe("POST /api/auth/register is retired", () => {
  const bodies: Array<[string, unknown]> = [
    ["a valid-looking new registration", {
      email: `founder@${DOMAIN}`,
      password: "Sup3rSecretPassword",
      firstName: "Rogue",
      lastName: "Admin",
      schoolName: `${TAG} Academy`,
    }],
    ["a retired parent registration", { schoolSlug: "some-school", email: `parent@${DOMAIN}` }],
    ["an empty body", {}],
    ["an existing user's email", {
      email: `existing@${DOMAIN}`,
      password: "Sup3rSecretPassword",
      firstName: "Existing",
      lastName: "User",
      schoolName: `${TAG} Duplicate`,
    }],
  ];

  it("answers every body with the same 410 tombstone and no session", async () => {
    for (const [label, body] of bodies) {
      const response = await post("/auth/register", body);
      assert.equal(response.status, 410, label);
      assert.deepEqual(response.body, { code: "PUBLIC_REGISTRATION_RETIRED" }, label);
      assert.equal(response.setCookie, null, `${label} must not establish a session`);
    }
  });

  it("creates no user, school, or membership", async () => {
    const users: any = await asSystem(() =>
      db.execute(sql`SELECT email FROM users WHERE email LIKE ${`%@${DOMAIN}`} ORDER BY email`)
    );
    assert.deepEqual(users.rows.map((row: any) => row.email), [`existing@${DOMAIN}`]);
    const schools: any = await asSystem(() =>
      db.execute(sql`SELECT count(*)::int AS count FROM schools WHERE domain = ${DOMAIN}`)
    );
    assert.equal(schools.rows[0].count, 0);
    const memberships: any = await asSystem(() =>
      db.execute(sql`SELECT count(*)::int AS count FROM school_memberships WHERE user_id = ${existingUser.id}`)
    );
    assert.equal(memberships.rows[0].count, 0);
  });

  it("records each hit as a school-less system audit event with the caller ip", async () => {
    const tagged: any = await asSystem(() =>
      db.execute(sql`
        SELECT user_email, school_id, metadata
        FROM audit_logs
        WHERE action = 'auth.register.retired' AND user_email LIKE ${`%@${DOMAIN}`}
        ORDER BY user_email
      `)
    );
    assert.deepEqual(
      tagged.rows.map((row: any) => row.user_email),
      [`existing@${DOMAIN}`, `founder@${DOMAIN}`, `parent@${DOMAIN}`]
    );
    for (const row of tagged.rows as any[]) {
      assert.equal(row.school_id, null);
      assert.equal(typeof row.metadata?.ip, "string");
      assert.notEqual(row.metadata.ip, "");
    }
    const anonymous: any = await asSystem(() =>
      db.execute(sql`
        SELECT count(*)::int AS count FROM audit_logs
        WHERE action = 'auth.register.retired' AND user_email IS NULL AND created_at >= ${startedAt}
      `)
    );
    assert.ok(anonymous.rows[0].count >= 1, "the empty body is still recorded, without an email");
  });
});
