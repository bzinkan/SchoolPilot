import { after, before, describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { sql } from "drizzle-orm";
import jwt from "jsonwebtoken";
import type { InsertSchool, InsertUser } from "../src/schema/core.js";

import db, { pool } from "../dist/db.js";
import { MICROSOFT_SIGN_IN_EXPAND_SQL } from "../dist/db/microsoftSignInMigration.js";
import { runWithTenantContext } from "../dist/middleware/tenantContext.js";
import { createMembership, createSchool, createUser } from "../dist/services/storage.js";
import { signUserToken } from "../dist/services/jwt.js";
import { hashPassword } from "../dist/util/password.js";

const TAG = `sp-msft-${Date.now()}`;
const DOMAIN = `${TAG}.example.edu`;
const PASSWORD = "StaffPass123!";
const CLIENT_ID = "0c1f7a55-7b39-4c52-8a3b-0d5b7f2e9a10";
const TENANT = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const OTHER_TENANT = "ffffffff-0000-4111-8222-333333333333";
const KID = "flow-test-kid";
const TOKEN_URL = "https://login.microsoftonline.com/organizations/oauth2/v2.0/token";
const KEYS_URL = "https://login.microsoftonline.com/common/discovery/v2.0/keys";
const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });

type CreatedSchool = Awaited<ReturnType<typeof createSchool>>;
type CreatedUser = Awaited<ReturnType<typeof createUser>>;
type Started = { cookie: string; state: string; nonce: string; challenge: string };

let microsoftSchool: CreatedSchool;
let googleSchool: CreatedSchool;
let msTeacher: CreatedUser;
let msTeacherTwo: CreatedUser;
let googleTeacher: CreatedUser;
let schoolAdmin: CreatedUser;
let superUser: CreatedUser;
let server: Server;
let baseUrl: string;
let nextIdToken = "";
const tokenRequests: URLSearchParams[] = [];
const sessionIds: string[] = [];
const realFetch = globalThis.fetch;
const savedEnv = {
  MICROSOFT_CLIENT_ID: process.env.MICROSOFT_CLIENT_ID,
  MICROSOFT_CLIENT_SECRET: process.env.MICROSOFT_CLIENT_SECRET,
  CORS_ALLOWLIST: process.env.CORS_ALLOWLIST,
};

function objectId(): string {
  return crypto.randomUUID();
}

function signIdToken(claims: Record<string, unknown>): string {
  const tid = (claims.tid as string | undefined) ?? TENANT;
  return jwt.sign(
    { tid, exp: Math.floor(Date.now() / 1000) + 300, ...claims },
    privateKey,
    {
      algorithm: "RS256",
      keyid: KID,
      audience: CLIENT_ID,
      issuer: `https://login.microsoftonline.com/${tid}/v2.0`,
    }
  );
}

async function startSignIn(): Promise<Started> {
  const response = await realFetch(`${baseUrl}/auth/microsoft`, { redirect: "manual" });
  assert.equal(response.status, 302);
  const location = new URL(response.headers.get("location")!);
  const cookie = response.headers.get("set-cookie")?.split(";")[0];
  assert.ok(cookie, "starting Microsoft sign-in must set a session cookie");
  const signedId = decodeURIComponent(cookie.split("=")[1] ?? "");
  sessionIds.push(signedId.slice(2, signedId.lastIndexOf(".")));
  return {
    cookie,
    state: location.searchParams.get("state")!,
    nonce: location.searchParams.get("nonce")!,
    challenge: location.searchParams.get("code_challenge")!,
  };
}

async function callback(started: Started, query: Record<string, string>): Promise<URL> {
  const url = new URL(`${baseUrl}/auth/microsoft/callback`);
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
  const response = await realFetch(url, { headers: { cookie: started.cookie }, redirect: "manual" });
  assert.equal(response.status, 302);
  return new URL(response.headers.get("location")!);
}

async function signInAs(claims: Record<string, unknown>): Promise<{ started: Started; location: URL }> {
  const started = await startSignIn();
  nextIdToken = signIdToken({ nonce: started.nonce, ...claims });
  const location = await callback(started, { code: "authorization-code", state: started.state });
  return { started, location };
}

async function requestJson(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const response = await realFetch(`${baseUrl}${path}`, {
    method,
    headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

function bearer(user: CreatedUser): Record<string, string> {
  const token = signUserToken({
    userId: user.id,
    email: user.email,
    isSuperAdmin: user.isSuperAdmin === true,
    authVersion: user.authVersion,
  });
  return { authorization: `Bearer ${token}` };
}

function asSystem<T>(fn: () => Promise<T>): Promise<T> {
  return runWithTenantContext({ isSuper: true }, fn);
}

async function microsoftIdOf(user: CreatedUser): Promise<string | null> {
  const result = await db.execute(sql`SELECT microsoft_id FROM users WHERE id = ${user.id}`);
  return (result.rows[0] as { microsoft_id: string | null }).microsoft_id;
}

async function lastAudit(action: string, userId?: string): Promise<Record<string, any> | undefined> {
  return asSystem(async () => {
    const result = await db.execute(sql`
      SELECT action, school_id, user_id, metadata, changes
      FROM audit_logs
      WHERE action = ${action} ${userId ? sql`AND user_id = ${userId}` : sql``}
      ORDER BY created_at DESC
      LIMIT 1
    `);
    return result.rows[0] as Record<string, any> | undefined;
  });
}

function schoolFixture(label: string, overrides: Partial<InsertSchool> = {}): InsertSchool {
  return { name: `${TAG} ${label}`, domain: DOMAIN, slug: `${TAG}-${label}`, status: "active", ...overrides };
}

function userFixture(label: string, passwordHash: string, isSuperAdmin = false): InsertUser {
  return { email: `${label}@${DOMAIN}`, password: passwordHash, firstName: label, lastName: "Staff", isSuperAdmin };
}

before(async () => {
  process.env.MICROSOFT_CLIENT_ID = CLIENT_ID;
  process.env.MICROSOFT_CLIENT_SECRET = "flow-test-client-secret";
  process.env.CORS_ALLOWLIST = "https://app.example.test";
  mock.timers.enable({ apis: ["setInterval"] });
  mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url === TOKEN_URL) {
      tokenRequests.push(new URLSearchParams(String(init?.body)));
      return new Response(JSON.stringify({ id_token: nextIdToken }), { status: 200 });
    }
    if (url === KEYS_URL) {
      const jwk = { ...publicKey.export({ format: "jwk" }), kid: KID, use: "sig" };
      return new Response(JSON.stringify({ keys: [jwk] }), { status: 200 });
    }
    return realFetch(input, init);
  });

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS "session" (
      "sid" varchar NOT NULL PRIMARY KEY,
      "sess" json NOT NULL,
      "expire" timestamp(6) NOT NULL
    )
  `);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(MICROSOFT_SIGN_IN_EXPAND_SQL);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }

  microsoftSchool = await createSchool(schoolFixture("microsoft", {
    microsoftSignInEnabled: true,
    microsoftTenantId: TENANT,
    staffPasswordLoginEnabled: false,
  }));
  googleSchool = await createSchool(schoolFixture("google"));

  const passwordHash = await hashPassword(PASSWORD);
  msTeacher = await createUser(userFixture("ms-teacher", passwordHash));
  msTeacherTwo = await createUser(userFixture("ms-teacher-two", passwordHash));
  googleTeacher = await createUser(userFixture("google-teacher", passwordHash));
  schoolAdmin = await createUser(userFixture("school-admin", passwordHash));
  superUser = await createUser(userFixture("super", passwordHash, true));

  await runWithTenantContext({ schoolId: microsoftSchool.id }, async () => {
    for (const user of [msTeacher, msTeacherTwo]) {
      await createMembership({ userId: user.id, schoolId: microsoftSchool.id, role: "teacher", status: "active" });
    }
    await createMembership({ userId: schoolAdmin.id, schoolId: microsoftSchool.id, role: "admin", status: "active" });
  });
  await runWithTenantContext({ schoolId: googleSchool.id }, () =>
    createMembership({ userId: googleTeacher.id, schoolId: googleSchool.id, role: "teacher", status: "active" })
  );

  const { createApp } = await import("../dist/app.js");
  server = createServer(createApp());
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
});

after(async () => {
  if (server) await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  try {
    await asSystem(async () => {
      const ids = sql.join([microsoftSchool, googleSchool].filter(Boolean).map((school) => sql`${school.id}`), sql`, `);
      await db.execute(sql`DELETE FROM audit_logs WHERE school_id IN (${ids})`);
      await db.execute(sql`DELETE FROM school_memberships WHERE school_id IN (${ids})`);
      await db.execute(sql`DELETE FROM schools WHERE id IN (${ids})`);
      await db.execute(sql`DELETE FROM audit_logs WHERE user_email LIKE ${`%@${DOMAIN}`}`);
      await db.execute(sql`DELETE FROM audit_logs WHERE user_id IN (SELECT id FROM users WHERE email LIKE ${`%@${DOMAIN}`})`);
      await db.execute(sql`DELETE FROM users WHERE email LIKE ${`%@${DOMAIN}`}`);
      if (sessionIds.length > 0) {
        await db.execute(sql`DELETE FROM "session" WHERE sid IN (${sql.join(sessionIds.map((id) => sql`${id}`), sql`, `)})`);
      }
      await db.execute(sql`DELETE FROM "session" WHERE sess::text LIKE ${`%${DOMAIN}%`}`);
    });
  } finally {
    mock.restoreAll();
    mock.timers.reset();
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await pool.end();
  }
});

describe("Microsoft sign-in", () => {
  it("advertises Microsoft only while the app registration is configured", async () => {
    assert.deepEqual((await requestJson("GET", "/auth/providers")).body?.microsoft, true);
    delete process.env.MICROSOFT_CLIENT_SECRET;
    try {
      assert.deepEqual((await requestJson("GET", "/auth/providers")).body?.microsoft, false);
      assert.equal((await realFetch(`${baseUrl}/auth/microsoft`, { redirect: "manual" })).status, 503);
    } finally {
      process.env.MICROSOFT_CLIENT_SECRET = "flow-test-client-secret";
    }
  });

  it("signs in staff of a school that trusts the tenant and binds the Microsoft identity", async () => {
    const oid = objectId();
    const { started, location } = await signInAs({ oid, email: msTeacher.email.toUpperCase() });

    assert.equal(location.origin + location.pathname, "https://app.example.test/login");
    const code = location.searchParams.get("code");
    assert.ok(code, `expected a one-time code, got ${location.search}`);
    const exchanged = await requestJson("POST", "/auth/exchange-code", { code });
    assert.equal(exchanged.status, 200);
    const me = await requestJson("GET", "/auth/me", undefined, { authorization: `Bearer ${exchanged.body.token}` });
    assert.equal(me.status, 200);
    assert.equal(me.body.user.id, msTeacher.id);
    assert.equal(me.body.memberships[0].microsoftSignInEnabled, true);

    assert.equal(await microsoftIdOf(msTeacher), `${TENANT}:${oid}`);
    const tokenRequest = tokenRequests.at(-1)!;
    assert.equal(tokenRequest.get("grant_type"), "authorization_code");
    assert.equal(tokenRequest.get("client_id"), CLIENT_ID);
    assert.equal(
      crypto.createHash("sha256").update(tokenRequest.get("code_verifier") ?? "").digest("base64url"),
      started.challenge,
      "the token exchange must prove the PKCE verifier behind the authorize challenge"
    );
    const success = await lastAudit("auth.login.success", msTeacher.id);
    assert.equal(success?.metadata?.method, "microsoft");
    assert.equal(success?.metadata?.tenantId, TENANT);

    const replay = await callback(started, { code: "authorization-code", state: started.state });
    assert.equal(replay.searchParams.get("error"), "microsoft_failed", "a used state must not sign in twice");

    const again = await signInAs({ oid, email: "renamed@elsewhere.example" });
    assert.ok(again.location.searchParams.get("code"), "the bound identity keeps working after an email change");
  });

  it("refuses a tenant that none of the staff member's schools trusts and binds nothing", async () => {
    const { location } = await signInAs({ oid: objectId(), email: googleTeacher.email });
    assert.equal(location.searchParams.get("error"), "microsoft_not_enabled");
    assert.equal(await microsoftIdOf(googleTeacher), null);
    const rejected = await lastAudit("auth.rejected", googleTeacher.id);
    assert.equal(rejected?.metadata?.reason, "microsoft_tenant_not_allowed");
  });

  it("refuses a different tenant claiming a trusted staff member's email", async () => {
    const { location } = await signInAs({ tid: OTHER_TENANT, oid: objectId(), email: msTeacherTwo.email });
    assert.equal(location.searchParams.get("error"), "microsoft_not_enabled");
    assert.equal(await microsoftIdOf(msTeacherTwo), null);
  });

  it("refuses an email with no account, and a bound identity presenting another account's email", async () => {
    const unknown = await signInAs({ oid: objectId(), email: `nobody@${DOMAIN}` });
    assert.equal(unknown.location.searchParams.get("error"), "microsoft_no_account");

    const boundId = (await microsoftIdOf(msTeacher))!.split(":")[1];
    const conflict = await signInAs({ oid: boundId, email: msTeacherTwo.email });
    assert.equal(conflict.location.searchParams.get("error"), "identity_conflict");
    assert.equal(await microsoftIdOf(msTeacherTwo), null);
  });

  it("refuses a forged state and a token minted for another sign-in", async () => {
    const forged = await startSignIn();
    const forgedState = await callback(forged, { code: "authorization-code", state: "not-the-state" });
    assert.equal(forgedState.searchParams.get("error"), "microsoft_failed");

    const started = await startSignIn();
    nextIdToken = signIdToken({ nonce: "another-sign-in", oid: objectId(), email: msTeacherTwo.email });
    const wrongNonce = await callback(started, { code: "authorization-code", state: started.state });
    assert.equal(wrongNonce.searchParams.get("error"), "microsoft_failed");
    assert.equal(await microsoftIdOf(msTeacherTwo), null);
  });

  it("tells staff when their school's Microsoft administrator has not approved the app", async () => {
    const started = await startSignIn();
    const location = await callback(started, {
      state: started.state,
      error: "invalid_client",
      error_description: "AADSTS65001: The user or administrator has not consented to use the application.",
    });
    assert.equal(location.searchParams.get("error"), "microsoft_consent_required");
  });

  it("points password sign-in at Microsoft when the school turned passwords off", async () => {
    const response = await requestJson("POST", "/auth/login", { email: msTeacherTwo.email, password: PASSWORD, client: "web" });
    assert.equal(response.status, 403);
    assert.equal(response.body.code, "STAFF_PASSWORD_LOGIN_DISABLED");
    assert.equal(
      response.body.error,
      "Password sign-in is turned off for your school. Use Continue with Microsoft or Continue with Google."
    );
  });

  it("lets only a super admin set a school's Microsoft tenant, and the setting takes effect", async () => {
    const path = `/super-admin/schools/${googleSchool.id}/sign-in-methods`;
    assert.equal((await requestJson("PUT", path, { microsoftSignInEnabled: true, microsoftTenantId: OTHER_TENANT }, bearer(schoolAdmin))).status, 403);

    const missing = await requestJson("PUT", path, { microsoftSignInEnabled: true, microsoftTenantId: null }, bearer(superUser));
    assert.equal(missing.body.code, "MICROSOFT_TENANT_ID_REQUIRED");
    const invalid = await requestJson("PUT", path, { microsoftSignInEnabled: true, microsoftTenantId: "district.onmicrosoft.com" }, bearer(superUser));
    assert.equal(invalid.body.code, "INVALID_MICROSOFT_TENANT_ID");
    const extra = await requestJson("PUT", path, { microsoftSignInEnabled: true, microsoftTenantId: OTHER_TENANT, enforceSso: true }, bearer(superUser));
    assert.equal(extra.body.code, "INVALID_SIGN_IN_METHODS");

    const enabled = await requestJson("PUT", path, { microsoftSignInEnabled: true, microsoftTenantId: OTHER_TENANT.toUpperCase() }, bearer(superUser));
    assert.equal(enabled.status, 200);
    assert.equal(enabled.body.school.microsoftSignInEnabled, true);
    assert.equal(enabled.body.school.microsoftTenantId, OTHER_TENANT);
    const audit = await lastAudit("school.sign_in_methods_updated", superUser.id);
    assert.equal(audit?.school_id, googleSchool.id);
    assert.deepEqual(audit?.changes?.microsoftSignInEnabled, { from: false, to: true });

    const oid = objectId();
    const allowed = await signInAs({ tid: OTHER_TENANT, oid, email: googleTeacher.email });
    assert.ok(allowed.location.searchParams.get("code"), `expected sign-in, got ${allowed.location.search}`);
    assert.equal(await microsoftIdOf(googleTeacher), `${OTHER_TENANT}:${oid}`);

    const disabled = await requestJson("PUT", path, { microsoftSignInEnabled: false, microsoftTenantId: OTHER_TENANT }, bearer(superUser));
    assert.equal(disabled.status, 200);
    const refused = await signInAs({ tid: OTHER_TENANT, oid, email: googleTeacher.email });
    assert.equal(refused.location.searchParams.get("error"), "microsoft_not_enabled", "turning Microsoft off stops bound staff too");
  });
});
