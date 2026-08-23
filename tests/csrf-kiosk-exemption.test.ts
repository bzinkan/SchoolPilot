import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { csrfProtection } from "../src/middleware/csrfProtection.js";

interface StubRequest {
  method: string;
  path: string;
  headers?: Record<string, unknown>;
  session?: Record<string, unknown>;
  body?: unknown;
}

function run(req: StubRequest) {
  let statusCode: number | null = null;
  let jsonBody: any = null;
  let nextCalled = false;
  const res = {
    status(code: number) {
      statusCode = code;
      return this;
    },
    json(payload: unknown) {
      jsonBody = payload;
      return this;
    },
  };
  csrfProtection(
    { headers: {}, ...req } as any,
    res as any,
    () => {
      nextCalled = true;
    }
  );
  return { statusCode, jsonBody, nextCalled };
}

const staffSession = { userId: "user-1", csrfToken: "secret-token" };

describe("csrfProtection kiosk exemptions", () => {
  it("lets public kiosk POSTs through even when a staff session cookie is present", () => {
    for (const path of [
      "/classpilot/kiosk/launch-ticket",
      "/classpilot/kiosk/launch-ticket/preflight",
      "/passpilot/kiosk/lookup",
      "/passpilot/kiosk/checkout",
      "/passpilot/kiosk/checkin",
      "/kiosk/lookup",
      "/kiosk/checkout",
      "/kiosk/checkin",
    ]) {
      const result = run({ method: "POST", path, session: { ...staffSession } });
      assert.equal(result.nextCalled, true, `${path} should be CSRF-exempt`);
      assert.equal(result.statusCode, null);
    }
  });

  it("keeps CSRF on the session-authenticated kiosk config routes", () => {
    for (const path of ["/passpilot/kiosk/config", "/kiosk/config", "/kiosk-config"]) {
      const result = run({ method: "PUT", path, session: { ...staffSession } });
      assert.equal(result.nextCalled, false, `${path} must stay CSRF-protected`);
      assert.equal(result.statusCode, 403);
      assert.equal(result.jsonBody?.error, "Invalid or missing CSRF token");
    }
  });

  it("does not exempt sub-paths beneath the exact kiosk exemptions", () => {
    for (const path of ["/passpilot/kiosk/checkout/confirm", "/kiosk/checkout/extra"]) {
      const result = run({ method: "POST", path, session: { ...staffSession } });
      assert.equal(result.nextCalled, false, `${path} must not inherit the exemption`);
      assert.equal(result.statusCode, 403);
    }
  });

  it("rejects a non-exempt cookie-authenticated POST without a token", () => {
    const result = run({ method: "POST", path: "/students", session: { ...staffSession } });
    assert.equal(result.nextCalled, false);
    assert.equal(result.statusCode, 403);
  });

  it("accepts a non-exempt cookie-authenticated POST with a matching token", () => {
    const result = run({
      method: "POST",
      path: "/students",
      session: { ...staffSession },
      headers: { "x-csrf-token": "secret-token" },
    });
    assert.equal(result.nextCalled, true);
  });

  it("ignores non-state-changing kiosk requests entirely", () => {
    const result = run({
      method: "GET",
      path: "/passpilot/kiosk/config",
      session: { ...staffSession },
    });
    assert.equal(result.nextCalled, true);
  });

  it("passes through sessionless kiosk POSTs (dedicated kiosk device)", () => {
    const result = run({ method: "POST", path: "/passpilot/kiosk/checkout" });
    assert.equal(result.nextCalled, true);
  });
});
