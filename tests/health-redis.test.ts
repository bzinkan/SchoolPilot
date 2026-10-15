import assert from "node:assert/strict";
import { test } from "node:test";
import { checkHealthRedis, REDIS_HEALTH_TIMEOUT_MS } from "../src/services/healthRedis.js";

test("only an absent Redis configuration reports intentionally disabled", async () => {
  let called = false;
  assert.deepEqual(await checkHealthRedis(false, async () => { called = true; }),
    { ok: true, detail: "disabled (single-instance mode)" });
  assert.equal(called, false);
  const unavailable = await checkHealthRedis(true, async () => undefined);
  assert.equal(unavailable.ok, false);
  assert.equal(unavailable.detail, undefined);
});

test("configured Redis requires a PONG through the 500ms bounded adapter", async () => {
  const result = await checkHealthRedis(true, async (args, options) => {
    assert.deepEqual(args, ["PING"]);
    assert.equal(options.timeoutMs, REDIS_HEALTH_TIMEOUT_MS);
    return "PONG";
  });
  assert.equal(result.ok, true);
  assert.ok(result.latencyMs! >= 0);
  assert.equal((await checkHealthRedis(true, async () => "unexpected")).ok, false);
});

test("Redis health failures never expose transport errors or credential-bearing URLs", async () => {
  const result = await checkHealthRedis(true, async () => { throw new Error("redis://secret-user:secret-password@example.invalid"); });
  assert.equal(result.ok, false);
  assert.equal(result.error, "Configured Redis health probe failed");
});
