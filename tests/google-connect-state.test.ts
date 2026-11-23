import { afterEach, describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import {
  GOOGLE_CONNECT_STATE_TTL_SECONDS,
  consumeGoogleConnectState,
  issueGoogleConnectState,
  resetGoogleConnectStateForTests,
  type GoogleConnectGrant,
} from "../src/services/googleConnectState.js";

const grant: GoogleConnectGrant = {
  userId: "user-1",
  schoolId: "school-1",
  purpose: "classroom_resources",
  returnTo: "https://app.example.test/classpilot",
};
const originalNodeEnv = process.env.NODE_ENV;

afterEach(() => {
  mock.restoreAll();
  if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = originalNodeEnv;
  resetGoogleConnectStateForTests();
});

describe("Google connect state store", () => {
  it("issues an opaque value and returns the grant exactly once", async () => {
    const state = await issueGoogleConnectState("session-1", grant);

    assert.match(state, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(state.includes(grant.userId), false);
    assert.deepEqual(await consumeGoogleConnectState(state, "session-1"), grant);
    assert.equal(await consumeGoogleConnectState(state, "session-1"), null);
  });

  it("lets only one of two simultaneous attempts succeed", async () => {
    const state = await issueGoogleConnectState("session-1", grant);
    const results = await Promise.all([
      consumeGoogleConnectState(state, "session-1"),
      consumeGoogleConnectState(state, "session-1"),
    ]);
    assert.equal(results.filter(Boolean).length, 1);
  });

  it("rejects another session and burns the state", async () => {
    const state = await issueGoogleConnectState("session-1", grant);
    assert.equal(await consumeGoogleConnectState(state, "session-2"), null);
    assert.equal(await consumeGoogleConnectState(state, "session-1"), null);
  });

  it("rejects a state after its lifetime", async () => {
    const state = await issueGoogleConnectState("session-1", grant);
    const expiresAfter = Date.now() + GOOGLE_CONNECT_STATE_TTL_SECONDS * 1_000 + 1;
    mock.method(Date, "now", () => expiresAfter);
    assert.equal(await consumeGoogleConnectState(state, "session-1"), null);
  });

  it("treats malformed and legacy JSON states as invalid", async () => {
    const legacy = JSON.stringify({ userId: "victim", schoolId: "school-1" });
    for (const value of ["", "short", legacy, "x".repeat(44)]) {
      assert.equal(await consumeGoogleConnectState(value, "session-1"), null);
    }
  });

  it("keeps two tabs in one session independent", async () => {
    const first = await issueGoogleConnectState("session-1", grant);
    const second = await issueGoogleConnectState("session-1", { ...grant, returnTo: null });
    assert.equal((await consumeGoogleConnectState(second, "session-1"))?.returnTo, null);
    assert.equal((await consumeGoogleConnectState(first, "session-1"))?.returnTo, grant.returnTo);
  });

  it("fails closed in production when Redis is not configured", async () => {
    const state = await issueGoogleConnectState("session-1", grant);
    const originalSecret = process.env.AUTH_CODE_HMAC_SECRET;
    process.env.AUTH_CODE_HMAC_SECRET = "google-connect-state-test-secret";
    process.env.NODE_ENV = "production";
    try {
      await assert.rejects(issueGoogleConnectState("session-1", grant), /state service unavailable/);
      await assert.rejects(consumeGoogleConnectState(state, "session-1"), /state service unavailable/);
    } finally {
      if (originalSecret === undefined) delete process.env.AUTH_CODE_HMAC_SECRET;
      else process.env.AUTH_CODE_HMAC_SECRET = originalSecret;
    }
  });
});
