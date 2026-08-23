import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  consumeAuthCode,
  issueAuthCode,
  resetAuthCodeStoreForTests,
} from "../src/services/authCodeExchange.js";

const originalRedisUrl = process.env.REDIS_URL;
const originalNodeEnv = process.env.NODE_ENV;

afterEach(() => {
  if (originalRedisUrl === undefined) delete process.env.REDIS_URL;
  else process.env.REDIS_URL = originalRedisUrl;
  if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = originalNodeEnv;
  resetAuthCodeStoreForTests();
});

describe("one-time authorization-code exchange", () => {
  it("consumes a local development code exactly once", async () => {
    delete process.env.REDIS_URL;
    process.env.NODE_ENV = "test";
    const code = await issueAuthCode("signed-jwt");

    assert.notEqual(code, "signed-jwt");
    assert.equal(await consumeAuthCode(code), "signed-jwt");
    assert.equal(await consumeAuthCode(code), null);
  });

  it("does not issue process-local codes in production", async () => {
    delete process.env.REDIS_URL;
    process.env.NODE_ENV = "production";

    await assert.rejects(
      issueAuthCode("signed-jwt"),
      /authorization code service unavailable/
    );
  });

  it("treats malformed codes as invalid without creating state", async () => {
    delete process.env.REDIS_URL;
    process.env.NODE_ENV = "test";
    assert.equal(await consumeAuthCode(""), null);
    await assert.rejects(issueAuthCode(""), /non-empty token/);
  });
});
