import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  createCachedBearerUserIdVerifier,
  resolveApiRateLimitIdentity,
  verifyBearerUserId,
} from "../src/util/apiRateLimitIdentity.ts";
import { signUserToken, verifyUserToken } from "../src/services/jwt.ts";

describe("global API rate-limit identity", () => {
  it("caches valid compact JWT verification by digest for only the configured TTL", () => {
    let nowMs = 1_000_000;
    let verificationCalls = 0;
    const verify = createCachedBearerUserIdVerifier(
      (token) => {
        verificationCalls += 1;
        assert.equal(token, "header.payload.signature");
        return { userId: "teacher-cache", exp: 2_000 };
      },
      { ttlMs: 1_000, now: () => nowMs }
    );

    assert.equal(verify("Bearer header.payload.signature"), "teacher-cache");
    assert.equal(verify("bEaReR   header.payload.signature"), "teacher-cache");
    assert.equal(verificationCalls, 1);

    nowMs += 1_001;
    assert.equal(verify("Bearer header.payload.signature"), "teacher-cache");
    assert.equal(verificationCalls, 2);
  });

  it("short-caches repeated invalid JWTs and rejects malformed input before verification", () => {
    let nowMs = 1_000_000;
    let verificationCalls = 0;
    const verify = createCachedBearerUserIdVerifier(
      () => {
        verificationCalls += 1;
        throw new Error("invalid signature");
      },
      { invalidTtlMs: 1_000, maxTokenLength: 128, now: () => nowMs }
    );

    assert.equal(verify("Bearer bad.payload.signature"), null);
    assert.equal(verify("Bearer bad.payload.signature"), null);
    assert.equal(verify("Bearer not-a-compact-jwt"), null);
    assert.equal(
      verify(`Bearer a.${"b".repeat(130)}.c`),
      null
    );
    assert.equal(verificationCalls, 1);

    nowMs += 1_001;
    assert.equal(verify("Bearer bad.payload.signature"), null);
    assert.equal(verificationCalls, 2);
  });

  it("keeps the bearer verification cache strictly bounded with LRU eviction", () => {
    let verificationCalls = 0;
    const verify = createCachedBearerUserIdVerifier(
      (token) => {
        verificationCalls += 1;
        return { userId: token };
      },
      { maxEntries: 2, ttlMs: 60_000, now: () => 1_000_000 }
    );

    assert.equal(verify("Bearer a.a.a"), "a.a.a");
    assert.equal(verify("Bearer b.b.b"), "b.b.b");
    assert.equal(verify("Bearer a.a.a"), "a.a.a");
    assert.equal(verify("Bearer c.c.c"), "c.c.c");
    assert.equal(verify("Bearer b.b.b"), "b.b.b");
    assert.equal(verificationCalls, 4);
  });

  it("never caches a valid bearer beyond its signed expiration", () => {
    let nowMs = 1_000_000;
    const signedExpiryMs = nowMs + 1_000;
    let verificationCalls = 0;
    const verify = createCachedBearerUserIdVerifier(
      () => {
        verificationCalls += 1;
        if (nowMs >= signedExpiryMs) throw new Error("jwt expired");
        return {
          userId: "teacher-expiring",
          exp: signedExpiryMs / 1_000,
        };
      },
      { ttlMs: 60_000, now: () => nowMs }
    );

    assert.equal(verify("Bearer expiring.payload.signature"), "teacher-expiring");
    assert.equal(verificationCalls, 1);

    nowMs = signedExpiryMs + 1;
    assert.equal(verify("Bearer expiring.payload.signature"), null);
    assert.equal(verificationCalls, 2);
  });

  it("accepts only a verifier-approved user bearer identity", () => {
    let verificationCalls = 0;
    const verified = verifyBearerUserId("Bearer signed-user-jwt", (token) => {
      verificationCalls += 1;
      assert.equal(token, "signed-user-jwt");
      return { userId: "teacher-1" };
    });
    const invalid = verifyBearerUserId("Bearer invalid-user-jwt", () => {
      throw new Error("invalid signature");
    });
    const malformed = verifyBearerUserId("Basic credentials", () => {
      verificationCalls += 1;
      return { userId: "must-not-run" };
    });

    assert.equal(verified, "teacher-1");
    assert.equal(invalid, null);
    assert.equal(malformed, null);
    assert.equal(verificationCalls, 1);
  });

  it("derives the staff key identity only from a cryptographically valid user JWT", () => {
    const token = signUserToken({
      userId: "teacher-signed",
      email: "synthetic-teacher@example.invalid",
    });
    const [header, payload, signature] = token.split(".");
    const tamperedSignature =
      `${signature.startsWith("a") ? "b" : "a"}${signature.slice(1)}`;
    const verified = verifyBearerUserId(`Bearer ${token}`, verifyUserToken);
    const tampered = verifyBearerUserId(
      `Bearer ${header}.${payload}.${tamperedSignature}`,
      verifyUserToken
    );

    assert.equal(verified, "teacher-signed");
    assert.equal(tampered, null);
  });

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
    assert.match(first.key, /^staff-user:[a-f0-9]{32}$/);
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
    assert.match(numeric.key, /^staff-user:[a-f0-9]{32}$/);
    assert.notEqual(numeric.key, "staff-user:42");
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
    assert.match(numericZero.key, /^staff-user:[a-f0-9]{32}$/);
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

  it("gives a signature-verified staff bearer its own shared 5,000/minute user key", () => {
    const bearer = resolveApiRateLimitIdentity({
      request: {
        method: "GET",
        originalUrl: "/api/classpilot/device/screenshot/device-1",
      },
      authorization: "Bearer signed-user-jwt",
      verifiedBearerUserId: "teacher-1",
      normalizedIp: "203.0.113.10",
    });
    const session = resolveApiRateLimitIdentity({
      request: { method: "GET", originalUrl: "/api/classpilot/groups" },
      sessionUserId: "teacher-1",
      normalizedIp: "203.0.113.99",
    });

    assert.equal(bearer.limit, 5_000);
    assert.equal(bearer.key, session.key);
    assert.match(bearer.key, /^staff-user:[a-f0-9]{32}$/);
    assert.doesNotMatch(bearer.key, /teacher-1|signed-user-jwt/);
  });

  it("matches bearer-first authentication when an ordinary session belongs to another user", () => {
    const identity = resolveApiRateLimitIdentity({
      request: { method: "GET", originalUrl: "/api/classpilot/groups" },
      sessionUserId: "session-user",
      verifiedBearerUserId: "bearer-user",
      normalizedIp: "203.0.113.10",
    });
    const bearerOnly = resolveApiRateLimitIdentity({
      request: { method: "GET", originalUrl: "/api/classpilot/groups" },
      verifiedBearerUserId: "bearer-user",
      normalizedIp: "203.0.113.99",
    });
    const sessionOnly = resolveApiRateLimitIdentity({
      request: { method: "GET", originalUrl: "/api/classpilot/groups" },
      sessionUserId: "session-user",
      normalizedIp: "203.0.113.99",
    });

    assert.equal(identity.key, bearerOnly.key);
    assert.notEqual(identity.key, sessionOnly.key);
    assert.equal(identity.limit, 5_000);
  });

  it("matches impersonation authentication by preferring the active session", () => {
    const identity = resolveApiRateLimitIdentity({
      request: { method: "GET", originalUrl: "/api/classpilot/groups" },
      sessionUserId: "impersonated-user",
      sessionImpersonating: true,
      verifiedBearerUserId: "stale-super-admin-bearer",
      normalizedIp: "203.0.113.10",
    });
    const sessionOnly = resolveApiRateLimitIdentity({
      request: { method: "GET", originalUrl: "/api/classpilot/groups" },
      sessionUserId: "impersonated-user",
      normalizedIp: "203.0.113.99",
    });
    const bearerOnly = resolveApiRateLimitIdentity({
      request: { method: "GET", originalUrl: "/api/classpilot/groups" },
      verifiedBearerUserId: "stale-super-admin-bearer",
      normalizedIp: "203.0.113.99",
    });

    assert.equal(identity.key, sessionOnly.key);
    assert.notEqual(identity.key, bearerOnly.key);
    assert.equal(identity.limit, 5_000);
  });

  it("keeps invalid staff bearers IP-keyed and device routes token-keyed", () => {
    const invalidStaff = resolveApiRateLimitIdentity({
      request: {
        method: "GET",
        originalUrl: "/api/classpilot/device/screenshot/device-1",
      },
      authorization: "Bearer invalid-user-jwt",
      normalizedIp: "203.0.113.10",
    });
    const device = resolveApiRateLimitIdentity({
      request: { method: "POST", originalUrl: "/api/device/heartbeat" },
      authorization: "Bearer device-secret",
      verifiedBearerUserId: "must-not-win",
      normalizedIp: "203.0.113.10",
    });

    assert.deepEqual(invalidStaff, {
      key: "ip:203.0.113.10",
      limit: 1_000,
    });
    assert.equal(device.limit, 1_000);
    assert.match(device.key, /^device-token:/);
  });

  it("separates twenty synthetic teachers sharing one public IP", () => {
    const identities = Array.from({ length: 20 }, (_, index) =>
      resolveApiRateLimitIdentity({
        request: {
          method: "GET",
          originalUrl: "/api/classpilot/device/screenshot/device-1",
        },
        authorization: `Bearer signed-user-jwt-${index}`,
        verifiedBearerUserId: `teacher-${index}`,
        normalizedIp: "203.0.113.10",
      })
    );

    assert.equal(new Set(identities.map(({ key }) => key)).size, 20);
    assert.ok(identities.every(({ limit }) => limit === 5_000));
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
