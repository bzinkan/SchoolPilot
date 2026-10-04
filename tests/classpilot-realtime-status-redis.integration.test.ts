import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { it, type TestContext } from "node:test";
import { createClient } from "redis";
import type { ClasspilotClassroomStateSnapshot } from "../src/services/classpilotClassroomState.js";

process.env.NODE_ENV = "test";
process.env.REDIS_URL = "";
process.env.DATABASE_URL ||= "postgresql://test:test@127.0.0.1:5432/test";

const {
  classpilotRealtimeStatusKey,
  createClasspilotRealtimeStatusStore,
} = await import("../src/services/classpilotRealtimeStatus.js");
const redisUrl = process.env.TEST_REDIS_URL;

async function fixture(t: TestContext) {
  assert.ok(redisUrl);
  const address = new URL(redisUrl);
  assert.equal(address.protocol, "redis:");
  assert.ok(["localhost", "127.0.0.1", "::1", "[::1]"].includes(address.hostname),
    "Native regressions require an explicitly isolated loopback Redis fixture");
  const client = createClient({ url: redisUrl,
    socket: { reconnectStrategy: false, connectTimeout: 3_000 } });
  const errors: unknown[] = [];
  client.on("error", (error) => errors.push(error));
  const keys = new Set<string>();
  t.after(async () => {
    if (client.isOpen) {
      for (const key of keys) await client.del(key);
      await client.quit();
    }
    assert.deepEqual(errors, [], "Native transport errors must not be hidden as local fallback");
  });
  await client.connect();
  const clock = Date.now();
  const binding = {
    schoolId: "synthetic-realtime-test",
    studentId: randomUUID(),
    studentSessionId: randomUUID(),
    deviceId: randomUUID(),
  };
  const key = classpilotRealtimeStatusKey(binding.schoolId, binding.deviceId);
  keys.add(key);
  let evalCount = 0;
  const writer = createClasspilotRealtimeStatusStore(async (args) => {
    assert.equal(args[0], "EVAL", "Mutations remain one atomic Redis operation");
    evalCount += 1;
    return client.sendCommand(args);
  }, () => clock);
  const reader = createClasspilotRealtimeStatusStore((args) => client.sendCommand(args), () => clock);
  const heartbeat = { ...binding, heartbeatId: randomUUID(), observedAt: clock, allOpenTabs: [] };
  const read = async () => {
    const result = (await reader.readBatch(binding.schoolId, [binding])).get(binding.studentId);
    assert.equal(result?.status, "hit");
    assert.ok(result && result.status === "hit");
    return result.snapshot;
  };
  const ttl = async () => {
    const remaining = await client.pTTL(key);
    assert.ok(remaining > 0 && remaining <= 360_000);
  };
  return { client, binding, clock, key, heartbeat, writer, reader, read, ttl, evalCount: () => evalCount };
}

function classroomState(clock: number): ClasspilotClassroomStateSnapshot {
  return {
    schemaVersion: 1, revision: 1, teachingSessionId: null,
    receivedAt: new Date(clock).toISOString(), scheduledEndAt: null,
    hardExpiresAt: new Date(clock + 60_000).toISOString(),
    restrictions: {
      screenLock: { active: false },
      flightPath: { active: false, allowedDomains: [], resources: [] },
      blockList: { active: false, blockedDomains: [] },
      attentionMode: { active: false }, tabLimit: null, temporaryAllows: [],
    },
  };
}

it("native Redis preserves empty tabs and nested policy arrays through every mutation", {
  skip: !redisUrl, timeout: 10_000,
}, async (t) => {
  const f = await fixture(t);
  const state = classroomState(f.clock);
  const heartbeat = { ...f.heartbeat, classroomState: state, clientProtocolVersion: 3,
    acceptedCapabilities: ["privateChatLifecycleV1"] };
  const write = await f.writer.write(heartbeat);
  assert.equal(write.status, "stored", "cjson must not turn a legitimate [] into a rejected shared snapshot");
  assert.deepEqual((await f.read()).allOpenTabs, []);
  assert.deepEqual((await f.read()).classroomState, state);
  assert.deepEqual((await f.read()).acceptedCapabilities, ["privateChatLifecycleV1"]);
  await f.ttl();
  const classification = { category: 'quoted "revision":1, [ ] { } \\ café',
    contentCategory: null, teacherIntentSource: null, safetyAlert: null };
  assert.equal((await f.writer.patchClassification({ ...heartbeat, classification })).status, "stored");
  const classified = await f.read();
  assert.deepEqual(classified.aiClassification, classification);
  assert.deepEqual(classified.classroomState, state);
  assert.deepEqual(classified.allOpenTabs, []);
  assert.equal((await f.writer.patchClassification({ ...heartbeat, classification: null })).status, "stored");
  assert.equal((await f.read()).aiClassification, undefined);
  assert.deepEqual((await f.read()).classroomState, state);
  const signedOut = await f.writer.markSignedOut({ ...f.binding, reason: "synthetic", observedAt: f.clock });
  assert.equal(signedOut.status, "stored");
  assert.equal((await f.read()).state, "signed_out");
  assert.deepEqual((await f.read()).allOpenTabs, []);
  assert.equal(f.evalCount(), 4);
  await f.ttl();
});

it("native Redis keeps exact increasing revisions for writes and patches in one current millisecond", {
  skip: !redisUrl, timeout: 10_000,
}, async (t) => {
  const f = await fixture(t);
  assert.equal(String(f.clock * 1_000).length, 16);
  const heartbeat = { ...f.heartbeat, allOpenTabs: [{ url: "https://synthetic.invalid/", title: "Synthetic" }] };
  const revisions: number[] = [];
  for (const operation of [
    () => f.writer.write(heartbeat),
    () => f.writer.write(heartbeat),
    () => f.writer.patchClassification({ ...heartbeat, classification: { category: "synthetic", safetyAlert: null } }),
    () => f.writer.patchClassification({ ...heartbeat, classification: null }),
    () => f.writer.markSignedOut({ ...f.binding, reason: "synthetic" }),
  ]) {
    assert.equal((await operation()).status, "stored");
    const raw: { revision: number } = JSON.parse((await f.client.get(f.key))!);
    assert.ok(Number.isSafeInteger(raw.revision));
    assert.equal((await f.read()).revision, raw.revision);
    revisions.push(raw.revision);
  }
  assert.ok(revisions.every((revision, index) => index === 0 || revision > revisions[index - 1]!));
  assert.ok(revisions.every((revision) => revision >= f.clock * 1_000));
  assert.equal(f.evalCount(), 5);
});

it("native Redis preserves escaped and unknown root values and removes duplicate replaced keys", {
  skip: !redisUrl, timeout: 10_000,
}, async (t) => {
  const f = await fixture(t);
  assert.equal((await f.writer.write(f.heartbeat)).status, "stored");
  const snapshot = await f.read();
  const { revision, ...rest } = snapshot;
  // Historical JSON may use whitespace, escaped keys and scientific notation.
  // Only named root fields may change; untouched nested bytes stay verbatim.
  const future = '{"empty":[],"object":{},"text":"} , \\\"revision\\\" : \\\\ café","large":"' + "x".repeat(80_000) + '"}';
  const raw = ' \n{"revision":2,"revi\\u0073ion":' + revision + ',"aiClassification":null,"classificationPending":true,'
    + JSON.stringify(rest).slice(1, -1) + ',"future":' + future + ',"scientific":1.2300e+2} \n';
  assert.doesNotThrow(() => JSON.parse(raw));
  await f.client.set(f.key, raw, { EX: 360 });
  assert.equal((await f.writer.patchClassification({ ...f.heartbeat,
    classification: { category: "synthetic", safetyAlert: null } })).status, "stored");
  const stored = (await f.client.get(f.key))!;
  assert.ok(stored.includes('"future":' + future));
  assert.ok(stored.includes('"scientific":1.2300e+2'));
  const parsed: { revision: number; future: unknown } = JSON.parse(stored);
  assert.ok(parsed.revision > revision);
  assert.deepEqual(parsed.future, JSON.parse(future));
  assert.equal((stored.match(/"revision":/g) ?? []).length, 1);
  assert.ok(!stored.includes('"revi\\u0073ion"'));
  assert.deepEqual((await f.read()).allOpenTabs, []);
  await f.ttl();
});

it("native Redis retains exact binding, stale-write and signout fences without refreshing stale keys", {
  skip: !redisUrl, timeout: 10_000,
}, async (t) => {
  const f = await fixture(t);
  assert.equal((await f.writer.write(f.heartbeat)).status, "stored");
  const before = await f.client.get(f.key);
  const ttlBefore = await f.client.pTTL(f.key);
  for (const operation of [
    () => f.writer.write({ ...f.heartbeat, observedAt: f.clock - 1 }),
    () => f.writer.write({ ...f.heartbeat, heartbeatId: "different-heartbeat" }),
    () => f.writer.patchClassification({ ...f.heartbeat, studentSessionId: "wrong-session", classification: null }),
    () => f.writer.patchClassification({ ...f.heartbeat, heartbeatId: "wrong-heartbeat", classification: null }),
    () => f.writer.markSignedOut({ ...f.binding, studentSessionId: "wrong-session", reason: "synthetic" }),
  ]) {
    assert.equal((await operation()).status, "stale");
    assert.equal(await f.client.get(f.key), before);
  }
  assert.ok(await f.client.pTTL(f.key) <= ttlBefore);
  const wrong = (await f.reader.readBatch(f.binding.schoolId,
    [{ ...f.binding, studentSessionId: "wrong-session" }])).get(f.binding.studentId);
  assert.equal(wrong?.status, "mismatch");
  assert.equal((await f.writer.markSignedOut({ ...f.binding, reason: "synthetic" })).status, "stored");
  const tombstone = await f.client.get(f.key);
  assert.equal((await f.writer.write(f.heartbeat)).status, "stale");
  assert.equal(await f.client.get(f.key), tombstone);
  const replacement = { ...f.heartbeat, studentSessionId: randomUUID(), heartbeatId: randomUUID(), observedAt: f.clock + 1 };
  assert.equal((await f.writer.write(replacement)).status, "stored");
  const replaced = (await f.reader.readBatch(f.binding.schoolId, [replacement])).get(f.binding.studentId);
  assert.equal(replaced?.status, "hit");
  await f.ttl();
});
