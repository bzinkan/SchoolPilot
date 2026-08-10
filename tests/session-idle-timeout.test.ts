import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { sessionIdleTimeout } from "../src/middleware/sessionIdleTimeout.js";

function invoke(
  session: Record<string, unknown>,
  requestOverrides: Record<string, unknown> = {}
) {
  let nextCalls = 0;
  let statusCode = 0;
  let body: unknown = null;
  let clearedCookie = "";
  let clearedCookieOptions: Record<string, unknown> | undefined;
  let destroyed = false;
  const request = {
    session,
    method: "GET",
    path: "/protected",
    headers: {},
    ...requestOverrides,
  } as any;
  request.session.destroy = (callback: (error?: Error) => void) => {
    destroyed = true;
    callback();
  };
  const response = {
    clearCookie(name: string, options: Record<string, unknown>) {
      clearedCookie = name;
      clearedCookieOptions = options;
    },
    status(code: number) {
      statusCode = code;
      return this;
    },
    json(value: unknown) {
      body = value;
      return this;
    },
  } as any;

  sessionIdleTimeout(request, response, () => {
    nextCalls += 1;
  });

  return {
    nextCalls,
    statusCode,
    body,
    clearedCookie,
    clearedCookieOptions,
    destroyed,
  };
}

describe("session idle persistence", () => {
  it("does not initialize or save an anonymous bearer-only session", () => {
    const session: Record<string, unknown> = {};
    const result = invoke(session);

    assert.equal(result.nextCalls, 1);
    assert.equal(session.lastActivityAt, undefined);
  });

  it("persists authenticated activity at most once per minute", () => {
    const recent = Date.now() - 30_000;
    const session: Record<string, unknown> = {
      userId: "teacher-1",
      role: "teacher",
      lastActivityAt: recent,
    };

    assert.equal(invoke(session).nextCalls, 1);
    assert.equal(session.lastActivityAt, recent);

    session.lastActivityAt = Date.now() - 61_000;
    const before = Date.now();
    assert.equal(invoke(session).nextCalls, 1);
    assert.ok(Number(session.lastActivityAt) >= before);
  });

  it("destroys an elevated session after one hour of inactivity", () => {
    const session: Record<string, unknown> = {
      userId: "admin-1",
      role: "school_admin",
      lastActivityAt: Date.now() - 60 * 60 * 1000 - 1,
    };
    const result = invoke(session);

    assert.equal(result.nextCalls, 0);
    assert.equal(result.destroyed, true);
    assert.equal(result.statusCode, 401);
    assert.equal(result.clearedCookie, "schoolpilot.sid");
    assert.deepEqual(result.body, {
      error: "Session expired due to inactivity. Please log in again.",
    });
  });

  it("allows authentication bootstrap routes to replace a stale session", () => {
    const staleSession = () => ({
      userId: "admin-1",
      role: "school_admin",
      lastActivityAt: Date.now() - 60 * 60 * 1000 - 1,
    });

    for (const [method, path] of [
      ["POST", "/auth/login"],
      ["POST", "/login"],
      ["POST", "/auth/register"],
      ["POST", "/auth/exchange-code"],
      ["GET", "/auth/google"],
      ["GET", "/auth/google/callback"],
      ["POST", "/auth/logout"],
    ]) {
      const result = invoke(staleSession(), { method, path });
      assert.equal(result.nextCalls, 1, `${method} ${path}`);
      assert.equal(result.destroyed, false, `${method} ${path}`);
    }
  });

  it("still enforces admin idle expiry when a normal web request also has a bearer token", () => {
    const result = invoke(
      {
        userId: "admin-1",
        role: "school_admin",
        lastActivityAt: Date.now() - 60 * 60 * 1000 - 1,
      },
      {
        headers: { authorization: "Bearer fresh-web-token" },
      }
    );

    assert.equal(result.nextCalls, 0);
    assert.equal(result.destroyed, true);
    assert.equal(result.statusCode, 401);
  });

  it("clears an expired session cookie with the configured production scope", () => {
    const previousNodeEnv = process.env.NODE_ENV;
    const previousCookieDomain = process.env.COOKIE_DOMAIN;
    process.env.NODE_ENV = "production";
    process.env.COOKIE_DOMAIN = ".school-pilot.net";

    try {
      const result = invoke({
        userId: "admin-1",
        role: "school_admin",
        lastActivityAt: Date.now() - 60 * 60 * 1000 - 1,
      });

      assert.deepEqual(result.clearedCookieOptions, {
        httpOnly: true,
        secure: true,
        sameSite: "lax",
        domain: ".school-pilot.net",
        path: "/",
      });
    } finally {
      if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previousNodeEnv;
      if (previousCookieDomain === undefined) delete process.env.COOKIE_DOMAIN;
      else process.env.COOKIE_DOMAIN = previousCookieDomain;
    }
  });
});
