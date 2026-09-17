import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  PUBLIC_REGISTRATION_RETIRED,
  retiredRegistrationAuditEmail,
  sendPublicRegistrationRetired,
} from "../src/util/publicRegistrationRetired.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function source(path: string): string {
  return readFileSync(join(root, path), "utf8");
}

function slice(text: string, start: string, end: string): string {
  const startIndex = text.indexOf(start);
  assert.notEqual(startIndex, -1, `missing ${start}`);
  const endIndex = text.indexOf(end, startIndex);
  assert.notEqual(endIndex, -1, `missing ${end}`);
  return text.slice(startIndex, endIndex);
}

function respond(): { res: any; result: () => { status: number; body: unknown } } {
  let status = 200;
  let body: unknown;
  const res = {
    status(code: number) {
      status = code;
      return this;
    },
    json(value: unknown) {
      body = value;
      return this;
    },
  };
  return { res, result: () => ({ status, body }) };
}

describe("retired public registration", () => {
  it("answers 410 with a body that does not depend on the request", () => {
    const expected = { status: 410, body: { code: PUBLIC_REGISTRATION_RETIRED } };
    for (const body of [
      {},
      { schoolSlug: "known-school", email: "parent@example.invalid" },
      { schoolName: "New School", email: "admin@example.invalid", password: "Sup3rSecretPassword" },
      "not an object",
      null,
    ]) {
      const { res, result } = respond();
      sendPublicRegistrationRetired(res);
      assert.deepEqual(result(), expected, JSON.stringify(body));
    }
  });

  it("records only an email-shaped value for the audit log and never throws", () => {
    assert.equal(
      retiredRegistrationAuditEmail({ email: "  Admin@Example.INVALID " }),
      "admin@example.invalid"
    );
    assert.equal(
      retiredRegistrationAuditEmail({ email: "probe@odd_label.example.invalid" }),
      "probe@odd_label.example.invalid",
      "shape, not validity: what a probe sent is what gets recorded"
    );
    for (const body of [
      undefined,
      null,
      "text",
      42,
      {},
      { email: 7 },
      { email: "not-an-email" },
      { email: "two@at@signs.invalid" },
      { email: "spaced out@example.invalid" },
      { email: `${"x".repeat(300)}@example.invalid` },
    ]) {
      assert.equal(retiredRegistrationAuditEmail(body), undefined, JSON.stringify(body));
    }
  });

  it("keeps the route a tombstone that never creates users or schools", () => {
    const auth = source("src/routes/auth.ts");
    const handler = slice(auth, "// POST /api/auth/register", "// GET /api/auth/me");
    assert.match(handler, /authLimiter/);
    assert.match(handler, /auth\.register\.retired/);
    assert.match(handler, /sendPublicRegistrationRetired\(/);
    for (const forbidden of [
      "createSchool(",
      "createUser(",
      "createMembership(",
      "establishWebSession(",
      "signUserToken(",
      "hashPassword(",
      "sendEmail(",
    ]) {
      assert.equal(handler.includes(forbidden), false, `${forbidden} must not survive in the tombstone`);
    }
    assert.equal(source("src/schema/validation.ts").includes("registerSchema"), false);
    assert.equal(source("src/middleware/csrfProtection.ts").includes('"/auth/register"'), false);
    assert.equal(
      source("src/middleware/sessionIdleTimeout.ts").includes('"POST /auth/register"'),
      false
    );
  });
});
