import assert from "node:assert/strict";
import { it } from "node:test";
import { PasspilotIndicatorStore } from "../src/services/passpilotIndicatorsStore.js";

const scope = { schoolId: "school-1", userId: "teacher-1", classId: "class-1", classSource: "legacy_grades" as const };

it("issues opaque, expiring, revocable credentials bound to an independent pairing ID", async () => {
  let now = 1000;
  const store = new PasspilotIndicatorStore({ now: () => now, redisConfigured: () => false, production: () => false });
  const result = await store.issue(scope);
  assert.match(result.token, /^ppi_[A-Za-z0-9_-]{43}$/);
  assert.match(result.record.pairingId, /^[0-9a-f-]{36}$/);
  assert.equal(result.record.expiresAt, 1000 + 30 * 86400 * 1000);
  assert.equal((await store.findByToken(result.token))?.classId, "class-1");
  assert.equal(await store.findByToken(result.token + "x"), null);
  assert.equal(await store.revoke(result.record.pairingId, "school-2", "teacher-1"), false);
  assert.equal(await store.revoke(result.record.pairingId, "school-1", "teacher-2"), false);
  assert.ok(await store.findByToken(result.token));
  assert.equal(await store.revoke(result.record.pairingId, "school-1", "teacher-1"), true);
  assert.equal(await store.findByToken(result.token), null);
  const expiring = await store.issue(scope);
  now = expiring.record.expiresAt;
  assert.equal(await store.findByToken(expiring.token), null);
});

it("bounds local pairings and evicts their token indexes together", async () => {
  const store = new PasspilotIndicatorStore({ redisConfigured: () => false, production: () => false, maxLocalEntries: 1 });
  const first = await store.issue(scope);
  const second = await store.issue(scope);
  assert.equal(await store.findByToken(first.token), null);
  assert.ok(await store.findByToken(second.token));
});

it("never substitutes local pairings for unavailable configured Redis or production Redis", async () => {
  const unavailable = () => assert.rejects(
    new PasspilotIndicatorStore({ redisConfigured: () => true, production: () => false, redis: async () => undefined }).issue(scope),
    { status: 503 }
  );
  await unavailable();
  await assert.rejects(new PasspilotIndicatorStore({ redisConfigured: () => false, production: () => true }).issue(scope), { status: 503 });
  const store = new PasspilotIndicatorStore({ redisConfigured: () => true, production: () => false, redis: async () => { throw new Error("offline"); } });
  await assert.rejects(store.findByToken("ppi_" + "a".repeat(43)), { status: 503 });
});

it("persists only a digest, bounded configuration, and independent UUID in Redis", async () => {
  const commands: string[][] = [];
  const store = new PasspilotIndicatorStore({ redisConfigured: () => true, production: () => true, redis: async (args) => { commands.push(args); return 1; } });
  const issued = await store.issue(scope);
  assert.equal(JSON.stringify(commands).includes(issued.token), false);
  assert.match(JSON.stringify(commands), /2592000/);
  assert.equal(commands[0]?.[0], "EVAL");
});
