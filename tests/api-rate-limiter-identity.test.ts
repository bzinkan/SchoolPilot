import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { resolveApiRateLimitIdentity } from "../src/util/apiRateLimitIdentity.ts";

describe("global API rate-limit identity", () => {
  it("uses an opaque bearer-token key for device ingest aliases", () => {
    const canonical = resolveApiRateLimitIdentity({
      request: {
        method: "POST",
        originalUrl: "/api/classpilot/device/heartbeat",
      },
      authorization: "Bearer device-secret",
      normalizedIp: "203.0.113.10",
    });
    const alias = resolveApiRateLimitIdentity({
      request: { method: "POST", originalUrl: "/api/device/heartbeat" },
      authorization: "bEaReR   device-secret",
      normalizedIp: "203.0.113.11",
    });

    assert.equal(canonical.limit, 1_000);
    assert.equal(canonical.key, alias.key);
    assert.match(canonical.key, /^device-token:[a-f0-9]{32}$/);
    assert.doesNotMatch(canonical.key, /device-secret/);
  });

  it("gives a valid web session its own opaque 5,000/minute key", () => {
    const first = resolveApiRateLimitIdentity({
      request: { method: "GET", originalUrl: "/api/classpilot/groups" },
      sessionUserId: "user-123",
      normalizedIp: "203.0.113.10",
    });
    const second = resolveApiRateLimitIdentity({
      request: { method: "GET", originalUrl: "/api/classpilot/groups" },
      sessionUserId: "user-123",
      normalizedIp: "203.0.113.99",
    });

    assert.equal(first.limit, 5_000);
    assert.equal(first.key, second.key);
    assert.match(first.key, /^session-user:[a-f0-9]{32}$/);
    assert.doesNotMatch(first.key, /user-123/);
  });

  it("normalizes string and numeric session ids without exposing them", () => {
    const numeric = resolveApiRateLimitIdentity({
      request: { method: "GET", originalUrl: "/api/classpilot/groups" },
      sessionUserId: 42,
      normalizedIp: "203.0.113.10",
    });
    const paddedString = resolveApiRateLimitIdentity({
      request: { method: "GET", originalUrl: "/api/classpilot/groups" },
      sessionUserId: " 42 ",
      normalizedIp: "203.0.113.99",
    });

    assert.equal(numeric.limit, 5_000);
    assert.equal(numeric.key, paddedString.key);
    assert.match(numeric.key, /^session-user:[a-f0-9]{32}$/);
    assert.notEqual(numeric.key, "session-user:42");
  });

  it("treats numeric zero as a valid session id", () => {
    const numericZero = resolveApiRateLimitIdentity({
      request: { method: "GET", originalUrl: "/api/classpilot/groups" },
      sessionUserId: 0,
      normalizedIp: "203.0.113.10",
    });
    const stringZero = resolveApiRateLimitIdentity({
      request: { method: "GET", originalUrl: "/api/classpilot/groups" },
      sessionUserId: "0",
      normalizedIp: "203.0.113.99",
    });

    assert.equal(numericZero.limit, 5_000);
    assert.equal(numericZero.key, stringZero.key);
    assert.match(numericZero.key, /^session-user:[a-f0-9]{32}$/);
  });

  it("falls back to IP for empty, null, or non-finite session ids", () => {
    for (const sessionUserId of ["", "   ", null, Number.NaN, Infinity]) {
      const identity = resolveApiRateLimitIdentity({
        request: { method: "GET", originalUrl: "/api/public-data" },
        sessionUserId,
        normalizedIp: "203.0.113.10",
      });

      assert.deepEqual(identity, {
        key: "ip:203.0.113.10",
        limit: 1_000,
      });
    }
  });

  it("prioritizes device identity when a device request also has a session", () => {
    const identity = resolveApiRateLimitIdentity({
      request: { method: "POST", originalUrl: "/api/device/screenshot" },
      authorization: "Bearer device-secret",
      sessionUserId: "user-123",
      normalizedIp: "203.0.113.10",
    });

    assert.match(identity.key, /^device-token:/);
    assert.equal(identity.limit, 1_000);
  });

  it("keeps unresolved traffic on the normalized IP at 1,000/minute", () => {
    const identity = resolveApiRateLimitIdentity({
      request: { method: "GET", originalUrl: "/api/public-data" },
      authorization: "Bearer unrelated-jwt",
      normalizedIp: "2001:db8::/64",
    });

    assert.deepEqual(identity, {
      key: "ip:2001:db8::/64",
      limit: 1_000,
    });
  });
});
