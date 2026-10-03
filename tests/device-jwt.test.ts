import assert from "node:assert/strict";
import { createSecretKey, generateKeyPairSync, KeyObject } from "node:crypto";
import { describe, it } from "node:test";
import jwt from "jsonwebtoken";

const secret = "synthetic-device-secret-utf8-\u00e9-\ud83d\udd10";
const payload = {
  studentId: "student-a",
  deviceId: "device-a",
  schoolId: "school-a",
  sessionId: "session-a",
  studentEmail: "\u00e9l\u00e8ve@example.test",
};
let moduleSequence = 0;

async function loadDeviceJwt(key: string | null = secret, nodeEnv = "test") {
  const originalSecret = process.env.STUDENT_TOKEN_SECRET;
  const originalNodeEnv = process.env.NODE_ENV;
  if (key === null) delete process.env.STUDENT_TOKEN_SECRET;
  else process.env.STUDENT_TOKEN_SECRET = key;
  process.env.NODE_ENV = nodeEnv;
  try {
    const url = new URL("../src/services/deviceJwt.ts", import.meta.url);
    url.searchParams.set("device-jwt-test", String(++moduleSequence));
    const loaded: typeof import("../src/services/deviceJwt.ts") = await import(url.href);
    return loaded;
  } finally {
    if (originalSecret === undefined) delete process.env.STUDENT_TOKEN_SECRET;
    else process.env.STUDENT_TOKEN_SECRET = originalSecret;
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnv;
  }
}

describe("student device JWT immutable key material", () => {
  it("interoperates with existing HS256 tokens and preserves exact claims and seven-day expiry", async () => {
    const device = await loadDeviceJwt();
    const encoded = device.createStudentToken(payload);
    const decoded = jwt.verify(encoded, secret, { algorithms: ["HS256"] });
    assert.equal(typeof decoded, "object");
    assert.ok(typeof decoded === "object");
    assert.equal(decoded.exp! - decoded.iat!, 7 * 24 * 60 * 60);
    assert.deepEqual(device.verifyStudentToken(encoded), decoded);
    for (const [key, value] of Object.entries(payload)) assert.equal(decoded[key], value);
    assert.equal(jwt.decode(encoded, { complete: true })?.header.alg, "HS256");
    const existing = jwt.sign({ ...payload, sessionId: "session-b" }, secret, { algorithm: "HS256" });
    assert.equal(device.verifyStudentToken(existing).sessionId, "session-b");
  });

  it("reuses only immutable key objects while verifying every token afresh", async (t) => {
    const device = await loadDeviceJwt();
    const sign = t.mock.method(jwt, "sign");
    const verify = t.mock.method(jwt, "verify");
    const first = device.createStudentToken(payload);
    const second = device.createStudentToken({ ...payload, studentId: "student-b" });
    assert.equal(device.verifyStudentToken(first).studentId, "student-a");
    assert.equal(device.verifyStudentToken(second).studentId, "student-b");
    const [firstSign, secondSign] = sign.mock.calls;
    const [firstVerify, secondVerify] = verify.mock.calls;
    assert.ok(firstSign && secondSign && firstVerify && secondVerify);
    // The library's last overloaded sign signature has a null key; these
    // recorded synchronous calls instead use the real production overload.
    const signingKey: unknown = firstSign.arguments[1];
    const verificationKey: unknown = firstVerify.arguments[1];
    assert.ok(signingKey instanceof KeyObject);
    assert.ok(verificationKey instanceof KeyObject);
    assert.equal(signingKey.type, "secret");
    assert.equal(verificationKey.type, "secret");
    assert.equal(secondSign.arguments[1], signingKey);
    assert.equal(secondVerify.arguments[1], verificationKey);
    assert.equal(signingKey, verificationKey);
  });

  it("rejects wrong keys, modified signatures, unsigned tokens and unapproved algorithms", async () => {
    const device = await loadDeviceJwt();
    const token = device.createStudentToken(payload);
    const parts = token.split(".");
    assert.ok(parts[2]);
    parts[2] = (parts[2][0] === "A" ? "B" : "A") + parts[2].slice(1);
    const invalid = [
      parts.join("."),
      jwt.sign(payload, "a-different-synthetic-secret", { algorithm: "HS256" }),
      jwt.sign(payload, secret, { algorithm: "HS384" }),
      jwt.sign(payload, secret, { algorithm: "HS512" }),
      jwt.sign(payload, "", { algorithm: "none" }),
      "not-a-jwt",
    ];
    for (const candidate of invalid) {
      assert.throws(() => device.verifyStudentToken(candidate), device.InvalidTokenError);
    }
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const asymmetric = jwt.sign(payload, privateKey, { algorithm: "RS256" });
    assert.throws(() => device.verifyStudentToken(asymmetric), device.InvalidTokenError);
  });

  it("rechecks expiry and not-before for repeated tokens with the existing error mapping", async (t) => {
    const device = await loadDeviceJwt();
    let seconds = 2_000_000_000;
    t.mock.method(Date, "now", () => seconds * 1000);
    const token = jwt.sign({ ...payload, exp: seconds + 1 }, secret, { algorithm: "HS256" });
    assert.equal(device.verifyStudentToken(token).studentId, payload.studentId);
    seconds += 1;
    assert.throws(() => device.verifyStudentToken(token), {
      name: "TokenExpiredError", message: "Student token has expired",
    });
    const future = jwt.sign({ ...payload, nbf: seconds + 1 }, secret, { algorithm: "HS256" });
    assert.throws(() => device.verifyStudentToken(future), device.InvalidTokenError);
    seconds += 1;
    assert.equal(device.verifyStudentToken(future).sessionId, payload.sessionId);
  });

  it("keeps process-start rotation semantics without caching decoded authority", async (t) => {
    const oldModule = await loadDeviceJwt();
    const oldToken = oldModule.createStudentToken(payload);
    const originalSecret = process.env.STUDENT_TOKEN_SECRET;
    t.after(() => {
      if (originalSecret === undefined) delete process.env.STUDENT_TOKEN_SECRET;
      else process.env.STUDENT_TOKEN_SECRET = originalSecret;
    });
    const nextSecret = "replacement-synthetic-device-key";
    process.env.STUDENT_TOKEN_SECRET = nextSecret;
    assert.equal(oldModule.verifyStudentToken(oldToken).sessionId, payload.sessionId);
    const nextModule = await loadDeviceJwt(nextSecret);
    assert.throws(() => nextModule.verifyStudentToken(oldToken), nextModule.InvalidTokenError);
    const nextToken = nextModule.createStudentToken({ ...payload, sessionId: "replacement-session" });
    assert.equal(nextModule.verifyStudentToken(nextToken).sessionId, "replacement-session");
    assert.throws(() => oldModule.verifyStudentToken(nextToken), oldModule.InvalidTokenError);
  });

  it("preserves public/private PEM misconfiguration rejection instead of accepting a key-confusion forgery", async () => {
    const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const publicPem = publicKey.export({ type: "spki", format: "pem" }).toString();
    const privatePem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    for (const pem of [publicPem, privatePem]) {
      const device = await loadDeviceJwt(pem);
      const forgery = jwt.sign(payload, createSecretKey(Buffer.from(pem)), { algorithm: "HS256" });
      assert.throws(() => jwt.verify(forgery, pem, { algorithms: ["HS256"] }), jwt.JsonWebTokenError);
      assert.throws(() => device.verifyStudentToken(forgery), device.InvalidTokenError);
      if (pem === privatePem) {
        assert.throws(() => jwt.sign(payload, pem, { algorithm: "HS256" }), /symmetric key/);
        assert.throws(() => device.createStudentToken(payload), /symmetric key/);
      } else {
        // jsonwebtoken signing treats a public PEM as a secret, but verification rejects it.
        assert.throws(() => device.verifyStudentToken(device.createStudentToken(payload)), device.InvalidTokenError);
      }
    }
  });

  it("still refuses a missing production secret and keeps the development fallback", async () => {
    await assert.rejects(loadDeviceJwt(null, "production"), /STUDENT_TOKEN_SECRET must be set/);
    await assert.rejects(loadDeviceJwt("", "production"), /STUDENT_TOKEN_SECRET must be set/);
    const device = await loadDeviceJwt("");
    const token = device.createStudentToken(payload);
    assert.ok(jwt.verify(token, "schoolpilot-dev-student-token-secret-32", { algorithms: ["HS256"] }));
  });
});
