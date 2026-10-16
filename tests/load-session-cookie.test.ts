import assert from "node:assert/strict";
import { test } from "node:test";
import { hasLoadSessionCookie, loadSessionCookieFromHeaders, loadSessionCookieName } from "../scripts/load/session-cookie.mjs";
const { login } = await import(new URL("../scripts/load/prepare-classpilot-load-test.mjs", import.meta.url).href);

test("load cookie selection is explicit and keeps the historical production default", () => {
  assert.equal(loadSessionCookieName({}), "schoolpilot.sid");
  assert.equal(loadSessionCookieName({ COOKIE_NAME: "schoolpilot.staging.sid" }), "schoolpilot.staging.sid");
  assert.equal(loadSessionCookieName({ COOKIE_NAME: "schoolpilot.sid", LOAD_SESSION_COOKIE_NAME: "schoolpilot.staging.sid" }), "schoolpilot.staging.sid");
  assert.throws(() => loadSessionCookieName({ APP_ENV: "staging" }), /distinct/);
  assert.throws(() => loadSessionCookieName({ LOAD_SESSION_COOKIE_NAME: "private-cookie; Domain=example.invalid" }), error =>
    error instanceof Error && !error.message.includes("private-cookie"));
});

test("load artifacts reject wrong names, duplicate names and mixed production/staging sessions", () => {
  const name = "schoolpilot.staging.sid";
  assert.equal(hasLoadSessionCookie(`${name}=synthetic-stage`, name), true);
  for (const value of ["schoolpilot.sid=private-production", "schoolpilotXstagingXsid=private-lookalike",
    `${name}=first; ${name}=second`, `${name}=synthetic-stage; schoolpilot.sid=private-production`, `${name}=`, `${name}=private\r\n`]) {
    assert.equal(hasLoadSessionCookie(value, name), false);
  }
});

test("login header extraction keeps only the configured cookie and rejects missing or ambiguous credentials", () => {
  const headers = new Headers();
  headers.append("set-cookie", "schoolpilot.sid=private-production; Path=/; HttpOnly");
  headers.append("set-cookie", "schoolpilot.staging.sid=synthetic-stage; Path=/; HttpOnly; Secure; SameSite=Lax");
  assert.equal(loadSessionCookieFromHeaders(headers, "schoolpilot.staging.sid"), "schoolpilot.staging.sid=synthetic-stage");
  assert.throws(() => loadSessionCookieFromHeaders(headers, "unissued.sid"), /exactly one expected/);
  headers.append("set-cookie", "schoolpilot.staging.sid=private-duplicate; Path=/");
  assert.throws(() => loadSessionCookieFromHeaders(headers, "schoolpilot.staging.sid"), error =>
    error instanceof Error && !error.message.includes("private-duplicate"));
});

test("the real preparer login verifies staging cookie sessions without forwarding a production parent cookie", async () => {
  const previous = process.env.LOAD_SESSION_COOKIE_NAME;
  process.env.LOAD_SESSION_COOKIE_NAME = "schoolpilot.staging.sid";
  const seen: string[] = [];
  const user = { id: "synthetic-teacher" };
  const memberships = [{ schoolId: "synthetic-school", role: "teacher", status: "active" }];
  try {
    const auth = await login({
      async request(path: string, options: { cookie?: string }) {
        if (path === "/api/auth/login") return { status: 200, data: { token: "synthetic-login-token", user, memberships },
          headers: new Headers({ "set-cookie": "schoolpilot.sid=private-production; Path=/, schoolpilot.staging.sid=synthetic-stage; Path=/; HttpOnly" }) };
        seen.push(options.cookie!);
        return { status: 200, data: { token: "synthetic-verified-token", user, memberships }, headers: new Headers() };
      },
      bindBearerToSchool() {},
    }, "synthetic@example.invalid", "synthetic-password", { schoolId: "synthetic-school", role: "teacher" });
    assert.equal(auth.cookie, "schoolpilot.staging.sid=synthetic-stage");
    assert.deepEqual(seen, ["schoolpilot.staging.sid=synthetic-stage"]);
  } finally {
    if (previous === undefined) delete process.env.LOAD_SESSION_COOKIE_NAME;
    else process.env.LOAD_SESSION_COOKIE_NAME = previous;
  }
});
