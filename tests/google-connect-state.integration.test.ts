import { after, before, beforeEach, describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { sql } from "drizzle-orm";

import db, { pool } from "../dist/db.js";
import { runWithTenantContext } from "../dist/middleware/tenantContext.js";
import {
  createMembership,
  createSchool,
  createUser,
  getGoogleOAuthToken,
  upsertGoogleOAuthToken,
} from "../dist/services/storage.js";
import { signUserToken } from "../dist/services/jwt.js";
import { GOOGLE_CONNECT_STATE_TTL_SECONDS } from "../dist/services/googleConnectState.js";
import { hashPassword } from "../dist/util/password.js";

const TAG = `sp-google-state-${Date.now()}`;
const DOMAIN = `${TAG}.example.edu`;
const APP_ORIGIN = "https://app.example.test";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const USERINFO_URL = "https://www.googleapis.com/oauth2/v2/userinfo";

type CreatedSchool = Awaited<ReturnType<typeof createSchool>>;
type CreatedUser = Awaited<ReturnType<typeof createUser>>;
type Started = { cookie: string; state: string };

let school: CreatedSchool;
let teacher: CreatedUser;
let otherTeacher: CreatedUser;
let server: Server;
let baseUrl: string;
let googleRefreshToken: string | undefined;
let googleEmail: string;
let tokenExchanges = 0;
const sessionIds = new Set<string>();
const realFetch = globalThis.fetch;
const savedEnv = {
  GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET: process.env.GOOGLE_CLIENT_SECRET,
  CORS_ALLOWLIST: process.env.CORS_ALLOWLIST,
};

function asSystem<T>(fn: () => Promise<T>): Promise<T> {
  return runWithTenantContext({ isSuper: true }, fn);
}

function storedToken(user: CreatedUser) {
  return asSystem(() => getGoogleOAuthToken(user.id));
}

function bearer(user: CreatedUser): string {
  return `Bearer ${signUserToken({
    userId: user.id,
    email: user.email,
    isSuperAdmin: false,
    authVersion: user.authVersion,
  })}`;
}

function sessionIdFrom(cookie: string): string {
  const signed = decodeURIComponent(cookie.split("=")[1] ?? "");
  return signed.slice(2, signed.lastIndexOf("."));
}

async function jsonString(response: Response, field: string): Promise<string | undefined> {
  const body: unknown = await response.json();
  if (typeof body !== "object" || body === null) return undefined;
  const value = Object.entries(body).find(([key]) => key === field)?.[1];
  return typeof value === "string" ? value : undefined;
}

async function startConnect(
  user: CreatedUser,
  options: { cookie?: string; returnTo?: string } = {}
): Promise<Started> {
  const url = new URL(`${baseUrl}/google/auth-url`);
  url.searchParams.set("purpose", "classroom_resources");
  url.searchParams.set("returnTo", options.returnTo ?? `${APP_ORIGIN}/classpilot`);
  const response = await realFetch(url, {
    headers: {
      authorization: bearer(user),
      "x-school-id": school.id,
      ...(options.cookie ? { cookie: options.cookie } : {}),
    },
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const authUrl = await jsonString(response, "url");
  assert.ok(authUrl);
  const cookie = response.headers.get("set-cookie")?.split(";")[0] ?? options.cookie;
  assert.ok(cookie, "starting the connection must leave the browser with a session cookie");
  sessionIds.add(sessionIdFrom(cookie));
  const state = new URL(authUrl).searchParams.get("state");
  assert.ok(state);
  return { cookie, state };
}

function callback(state: string, cookie?: string): Promise<Response> {
  const url = new URL(`${baseUrl}/google/callback`);
  url.searchParams.set("code", "authorization-code");
  url.searchParams.set("state", state);
  return realFetch(url, { headers: cookie ? { cookie } : {}, redirect: "manual" });
}

async function assertRejected(response: Response): Promise<void> {
  assert.equal(response.status, 400);
  assert.equal(await jsonString(response, "code"), "GOOGLE_CONNECT_STATE_INVALID");
}

before(async () => {
  process.env.GOOGLE_CLIENT_ID = "google-state-test-client";
  process.env.GOOGLE_CLIENT_SECRET = "google-state-test-secret";
  process.env.CORS_ALLOWLIST = APP_ORIGIN;
  mock.timers.enable({ apis: ["setInterval"] });
  mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url === TOKEN_URL) {
      tokenExchanges += 1;
      return new Response(JSON.stringify({
        access_token: "access-token",
        expires_in: 3600,
        token_type: "Bearer",
        scope: "openid email",
        ...(googleRefreshToken ? { refresh_token: googleRefreshToken } : {}),
      }), { status: 200 });
    }
    if (url === USERINFO_URL) {
      return new Response(JSON.stringify({ email: googleEmail }), { status: 200 });
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
  school = await createSchool({ name: TAG, domain: DOMAIN, slug: TAG, status: "active" });
  const password = await hashPassword("StaffPass123!");
  teacher = await createUser({ email: `teacher@${DOMAIN}`, password, firstName: "Google", lastName: "Teacher" });
  otherTeacher = await createUser({ email: `other@${DOMAIN}`, password, firstName: "Other", lastName: "Teacher" });
  await runWithTenantContext({ schoolId: school.id }, async () => {
    for (const user of [teacher, otherTeacher]) {
      await createMembership({ userId: user.id, schoolId: school.id, role: "teacher", status: "active" });
    }
  });

  const { createApp } = await import("../dist/app.js");
  server = createServer(createApp());
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
});

beforeEach(async () => {
  tokenExchanges = 0;
  googleRefreshToken = "fresh-refresh-token";
  googleEmail = `teacher@${DOMAIN}`;
  await asSystem(() => db.execute(sql`
    DELETE FROM google_oauth_tokens WHERE user_id IN (${teacher.id}, ${otherTeacher.id})
  `));
});

after(async () => {
  if (server) await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  try {
    await asSystem(async () => {
      if (teacher && otherTeacher) {
        await db.execute(sql`DELETE FROM google_oauth_tokens WHERE user_id IN (${teacher.id}, ${otherTeacher.id})`);
      }
      if (school) {
        await db.execute(sql`DELETE FROM audit_logs WHERE school_id = ${school.id}`);
        await db.execute(sql`DELETE FROM school_memberships WHERE school_id = ${school.id}`);
      }
      for (const id of sessionIds) {
        await db.execute(sql`DELETE FROM "session" WHERE sid = ${id}`);
      }
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

describe("Google connect callback", () => {
  it("stores the grant for the signed-in user and returns them to the app", async () => {
    const started = await startConnect(teacher);
    assert.equal(started.state.includes(teacher.id), false, "state must not carry the user id");

    const response = await callback(started.state, started.cookie);

    assert.equal(response.status, 302);
    assert.equal(response.headers.get("location"), `${APP_ORIGIN}/classpilot?connected=true`);
    const token = await storedToken(teacher);
    assert.equal(token?.refreshToken, "fresh-refresh-token");
    assert.equal(token?.connectedEmail, teacher.email);
  });

  it("keeps the stored refresh token when Google omits one on re-consent", async () => {
    await asSystem(() => upsertGoogleOAuthToken(teacher.id, {
      refreshToken: "existing-refresh-token",
      connectedEmail: teacher.email,
      connectedDomain: DOMAIN,
    }));
    googleRefreshToken = undefined;

    const started = await startConnect(teacher);
    const response = await callback(started.state, started.cookie);

    assert.equal(response.status, 302);
    assert.equal((await storedToken(teacher))?.refreshToken, "existing-refresh-token");
  });

  it("still reports a Google account from another domain", async () => {
    googleEmail = "teacher@another-domain.example";
    const started = await startConnect(teacher);
    const response = await callback(started.state, started.cookie);
    const location = new URL(response.headers.get("location") ?? "");
    assert.equal(location.searchParams.get("googleDomainMismatch"), "true");
  });

  it("rejects a forged state naming another user before contacting Google", async () => {
    await asSystem(() => upsertGoogleOAuthToken(otherTeacher.id, {
      refreshToken: "victim-refresh-token",
      connectedEmail: otherTeacher.email,
      connectedDomain: DOMAIN,
    }));
    const attacker = await startConnect(teacher);
    const forged = JSON.stringify({
      userId: otherTeacher.id,
      schoolId: school.id,
      purpose: "classroom_resources",
      returnTo: `${APP_ORIGIN}/classpilot`,
    });

    await assertRejected(await callback(forged, attacker.cookie));
    await assertRejected(await callback(forged));

    assert.equal(tokenExchanges, 0);
    assert.equal((await storedToken(otherTeacher))?.refreshToken, "victim-refresh-token");
  });

  it("rejects a real state presented from a different browser", async () => {
    const started = await startConnect(teacher);
    const otherBrowser = await startConnect(otherTeacher);

    await assertRejected(await callback(started.state));
    const second = await startConnect(teacher);
    await assertRejected(await callback(second.state, otherBrowser.cookie));

    assert.equal(tokenExchanges, 0);
    assert.equal(await storedToken(teacher), undefined);
    assert.equal(await storedToken(otherTeacher), undefined);
  });

  it("rejects a replayed state", async () => {
    const started = await startConnect(teacher);
    assert.equal((await callback(started.state, started.cookie)).status, 302);

    await assertRejected(await callback(started.state, started.cookie));

    assert.equal(tokenExchanges, 1);
  });

  it("lets only one of two simultaneous callbacks through", async () => {
    const started = await startConnect(teacher);
    const responses = await Promise.all([
      callback(started.state, started.cookie),
      callback(started.state, started.cookie),
    ]);
    assert.deepEqual(responses.map((response) => response.status).sort(), [302, 400]);
    assert.equal(tokenExchanges, 1);
  });

  it("rejects an expired state", async () => {
    const started = await startConnect(teacher);
    const expiresAfter = Date.now() + GOOGLE_CONNECT_STATE_TTL_SECONDS * 1_000 + 1_000;
    const clock = mock.method(Date, "now", () => expiresAfter);
    try {
      await assertRejected(await callback(started.state, started.cookie));
    } finally {
      clock.mock.restore();
    }
    assert.equal(tokenExchanges, 0);
    assert.equal(await storedToken(teacher), undefined);
  });

  it("rejects a callback when the session now belongs to someone else", async () => {
    const started = await startConnect(teacher);
    await asSystem(() => db.execute(sql`
      UPDATE "session"
      SET sess = (sess::jsonb || jsonb_build_object('userId', ${otherTeacher.id}::text))::json
      WHERE sid = ${sessionIdFrom(started.cookie)}
    `));

    await assertRejected(await callback(started.state, started.cookie));

    assert.equal(tokenExchanges, 0);
    assert.equal(await storedToken(otherTeacher), undefined);
  });

  it("will not start a connection when the session and bearer token disagree", async () => {
    const started = await startConnect(teacher);
    await asSystem(() => db.execute(sql`
      UPDATE "session"
      SET sess = (sess::jsonb || jsonb_build_object('userId', ${otherTeacher.id}::text))::json
      WHERE sid = ${sessionIdFrom(started.cookie)}
    `));

    const url = new URL(`${baseUrl}/google/auth-url`);
    url.searchParams.set("purpose", "classroom_resources");
    const response = await realFetch(url, {
      headers: { authorization: bearer(teacher), "x-school-id": school.id, cookie: started.cookie },
    });

    assert.equal(response.status, 409);
    assert.equal(await jsonString(response, "code"), "GOOGLE_CONNECT_SESSION_MISMATCH");
  });

  it("sends off-site return addresses to the default page", async () => {
    for (const returnTo of [
      "https://evil.example/phish",
      "//evil.example/phish",
      `${APP_ORIGIN}@evil.example/phish`,
      `${APP_ORIGIN}.evil.example/phish`,
      `https://user:pass@${new URL(APP_ORIGIN).host}/classpilot`,
      "javascript:alert(1)",
    ]) {
      const started = await startConnect(teacher, { returnTo });
      const response = await callback(started.state, started.cookie);
      assert.equal(response.status, 302, returnTo);
      assert.equal(
        response.headers.get("location"),
        `${APP_ORIGIN}/settings/google?connected=true`,
        returnTo
      );
    }
  });

  it("consumes a state atomically in Redis", { skip: !process.env.TEST_REDIS_URL }, () => {
    const script = `
      const service = await import("./dist/services/googleConnectState.js");
      const grant = { userId: "u", schoolId: "s", purpose: "classroom_resources", returnTo: null };
      const state = await service.issueGoogleConnectState("session-1", grant);
      const results = await Promise.all([
        service.consumeGoogleConnectState(state, "session-1"),
        service.consumeGoogleConnectState(state, "session-1"),
      ]);
      const other = await service.issueGoogleConnectState("session-1", grant);
      const wrongSession = await service.consumeGoogleConnectState(other, "session-2");
      const burned = await service.consumeGoogleConnectState(other, "session-1");
      console.log(JSON.stringify({
        winners: results.filter(Boolean).length,
        wrongSession,
        burned,
      }));
      process.exit(0);
    `;
    const child = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
      cwd: new URL("..", import.meta.url),
      env: {
        ...process.env,
        NODE_OPTIONS: "",
        REDIS_URL: process.env.TEST_REDIS_URL,
        REDIS_PREFIX: `${TAG}-test`,
      },
      encoding: "utf8",
      timeout: 30_000,
    });
    assert.equal(child.status, 0, child.stderr);
    const output = child.stdout.trim().split("\n").at(-1) ?? "";
    assert.deepEqual(JSON.parse(output), { winners: 1, wrongSession: null, burned: null });
  });
});
