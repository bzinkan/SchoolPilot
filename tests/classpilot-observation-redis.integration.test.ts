import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test, type TestContext } from "node:test";
import { createClient } from "redis";
import type { ClasspilotObservationScope } from "../src/services/classpilotObservationLease.js";

const redisUrl = process.env.TEST_REDIS_URL;
process.env.NODE_ENV = "test";
process.env.REDIS_URL = redisUrl || "";
process.env.CLASSPILOT_OBSERVATION_HMAC_SECRET = "synthetic-observation-redis-test";
if (redisUrl) {
  const address = new URL(redisUrl);
  assert.equal(address.protocol, "redis:");
  assert.ok(["localhost", "127.0.0.1", "::1", "[::1]"].includes(address.hostname),
    "Observation Lua tests require explicitly isolated loopback Redis");
}
const O = await import("../src/services/classpilotObservationLease.js");
const R = await import("../src/realtime/ws-redis.js");
const client = createClient({ url: redisUrl,
  socket: { reconnectStrategy: false, connectTimeout: 3_000 } });
const errors: unknown[] = [];
client.on("error", error => errors.push(error));
before(async () => {
  if (!redisUrl) return;
  await client.connect();
  await R.subscribeWS(() => {});
  assert.equal(R.isRedisPublisherReady(), true);
});
after(async () => {
  await R.disposeWSRedis();
  if (client.isOpen) await client.quit();
  assert.deepEqual(errors, []);
});

function fixture(t: TestContext) {
  const schoolId = `synthetic-observation-${randomUUID()}`, subjectId = randomUUID();
  const now = Date.now(), keys = new Set<string>();
  const key = (viewer: string, subjectKind: "teaching_session" | "supervision_context" = "teaching_session") => {
    const result = O.classpilotObservationSubjectKeysForTests({ schoolId, subjectKind, subjectId,
      viewerUserId: "synthetic-viewer", viewerInstanceId: viewer });
    keys.add(result.indexKey); keys.add(result.viewerDataKey); return result;
  };
  t.after(async () => { for (const name of keys) await client.del(name); });
  const renew = (viewer: string, scope: ClasspilotObservationScope, at = now) => {
    key(viewer);
    return O.renewClasspilotObservationLease({ schoolId, teachingSessionId: subjectId,
      viewerUserId: "synthetic-viewer", viewerInstanceId: viewer, scope, now: at });
  };
  const status = (studentId = "student-a", at = now) => O.classpilotObservationStatus({
    schoolId, teachingSessionId: subjectId, studentId, now: at });
  const seed = async (viewer: string, value: string | null, score = now + 90_000) => {
    const k = key(viewer); await client.zAdd(k.indexKey, { score, value: k.viewerKey });
    if (value !== null) await client.set(k.viewerDataKey, value, { EX: 90 });
  };
  return { schoolId, subjectId, now, key, renew, status, seed };
}
const native = { skip: !redisUrl, timeout: 10_000 };
async function evalCalls() {
  const info = await client.info("commandstats");
  return Number(info.match(/^cmdstat_eval:calls=(\d+)/m)?.[1] || 0);
}

test("native observation status reads the exact existing lease in one atomic EVAL", native, async t => {
  const f = fixture(t); await f.renew("class-viewer", { kind: "class" });
  const before = await evalCalls();
  assert.deepEqual(await f.status(), { status: "observed", expiresInSeconds: 90 });
  assert.equal(await evalCalls() - before, 1, "A status lookup must be exactly one server-side atomic read");
});

test("native observation preserves exact student scopes, maximum matching expiry and renewal/release", native, async t => {
  const f = fixture(t);
  await f.renew("a", { kind: "students", studentIds: ["student-a"] });
  await f.renew("b", { kind: "students", studentIds: ["student-b"] }, f.now + 1_000);
  assert.deepEqual(await f.status("student-a", f.now + 1), { status: "observed", expiresInSeconds: 90 });
  assert.deepEqual(await f.status("student-c"), { status: "unobserved", expiresInSeconds: 0 });
  await f.renew("a", { kind: "students", studentIds: ["student-b"] }, f.now + 2_000);
  assert.deepEqual(await f.status("student-a", f.now + 2_000), { status: "unobserved", expiresInSeconds: 0 });
  assert.deepEqual(await f.status("student-b", f.now + 2_001), { status: "observed", expiresInSeconds: 90 });
  await O.releaseClasspilotObservationLeaseWithState({ schoolId: f.schoolId, teachingSessionId: f.subjectId,
    viewerUserId: "synthetic-viewer", viewerInstanceId: "a", now: f.now + 3_000 });
  assert.deepEqual(await f.status("student-b", f.now + 3_000), { status: "observed", expiresInSeconds: 88 });
  await O.releaseClasspilotObservationLeaseWithState({ schoolId: f.schoolId, teachingSessionId: f.subjectId,
    viewerUserId: "synthetic-viewer", viewerInstanceId: "b", now: f.now + 3_000 });
  assert.deepEqual(await f.status("student-b", f.now + 3_000), { status: "unobserved", expiresInSeconds: 0 });
});

test("native observation separates schools and teaching/supervision namespaces", native, async t => {
  const f = fixture(t); f.key("supervisor", "supervision_context");
  await O.renewClasspilotSupervisionObservationLease({ schoolId: f.schoolId, supervisionContextId: f.subjectId,
    viewerUserId: "synthetic-viewer", viewerInstanceId: "supervisor", scope: { kind: "class" }, now: f.now });
  assert.deepEqual(await f.status(), { status: "unobserved", expiresInSeconds: 0 });
  assert.deepEqual(await O.classpilotSupervisionObservationStatus({ schoolId: f.schoolId,
    supervisionContextId: f.subjectId, studentId: "student-a", now: f.now }), { status: "observed", expiresInSeconds: 90 });
  assert.deepEqual(await O.classpilotSupervisionObservationStatus({ schoolId: f.schoolId + "-other",
    supervisionContextId: f.subjectId, studentId: "student-a", now: f.now }), { status: "unobserved", expiresInSeconds: 0 });
  await O.releaseClasspilotSupervisionObservationLeaseWithState({ schoolId: f.schoolId,
    supervisionContextId: f.subjectId, viewerUserId: "synthetic-viewer", viewerInstanceId: "supervisor", now: f.now });
  assert.deepEqual(await O.classpilotSupervisionObservationStatus({ schoolId: f.schoolId,
    supervisionContextId: f.subjectId, studentId: "student-a", now: f.now }), { status: "unobserved", expiresInSeconds: 0 });
});

test("native observation rejects overflow while admitting exactly128 viewers and renewal keeps its cap", native, async t => {
  const f = fixture(t);
  for (let i = 0; i < 128; i++) await f.seed(`viewer-${i}`, JSON.stringify({
    scope: { kind: i === 127 ? "class" : "students", studentIds: ["other"] }, expiresAt: f.now + 90_000 }));
  assert.equal((await f.status()).status, "observed");
  await f.seed("overflow", JSON.stringify({ scope: { kind: "class" }, expiresAt: f.now + 90_000 }));
  assert.deepEqual(await f.status(), { status: "unavailable", expiresInSeconds: 0 });
  await f.renew("renewed", { kind: "class" });
  assert.equal(await client.zCard(f.key("renewed").indexKey), 128);
  assert.equal((await f.status()).status, "observed");
});

test("native observation skips missing, malformed, wrong-scope and exactly expired lease data", native, async t => {
  const f = fixture(t);
  for (const [viewer, value, score] of [
    ["missing", null, f.now + 90_000], ["json", "not-json", f.now + 90_000],
    ["null", "null", f.now + 90_000], ["scope", JSON.stringify({ scope: { kind: "unknown" }, expiresAt: f.now + 90_000 }), f.now + 90_000],
    ["nan", '{"scope":{"kind":"class"},"expiresAt":NaN}', f.now + 90_000],
    ["infinity", '{"scope":{"kind":"class"},"expiresAt":Infinity}', f.now + 90_000],
    ["unsafe", JSON.stringify({ scope: { kind: "class" }, expiresAt: Number.MAX_SAFE_INTEGER + 1 }), f.now + 90_000],
    ["fraction", JSON.stringify({ scope: { kind: "class" }, expiresAt: f.now + 0.5 }), f.now + 90_000],
    ["numeric-string", JSON.stringify({ scope: { kind: "class" }, expiresAt: String(f.now + 90_000) }), f.now + 90_000],
    ["string-list", JSON.stringify({ scope: { kind: "students", studentIds: "student-a" }, expiresAt: f.now + 90_000 }), f.now + 90_000],
    ["object-list", JSON.stringify({ scope: { kind: "students", studentIds: { "1": "student-a" } }, expiresAt: f.now + 90_000 }), f.now + 90_000],
    ["null-list", JSON.stringify({ scope: { kind: "students", studentIds: [null, "student-a"] }, expiresAt: f.now + 90_000 }), f.now + 90_000],
    ["oversize-list", JSON.stringify({ scope: { kind: "students", studentIds: Array(501).fill("student-a") }, expiresAt: f.now + 90_000 }), f.now + 90_000],
    ["expired-data", JSON.stringify({ scope: { kind: "class" }, expiresAt: f.now }), f.now + 90_000],
    ["expired-index", JSON.stringify({ scope: { kind: "class" }, expiresAt: f.now + 90_000 }), f.now],
  ] as const) await f.seed(viewer, value, score);
  assert.deepEqual(await f.status(), { status: "unobserved", expiresInSeconds: 0 });
  await f.seed("valid", JSON.stringify({ scope: { kind: "class" }, expiresAt: f.now + 1 }));
  assert.deepEqual(await f.status(), { status: "observed", expiresInSeconds: 1 });
  assert.deepEqual(await f.status("student-a", f.now + 1), { status: "unobserved", expiresInSeconds: 0 });
});

test("native observation read failure remains unavailable with configured Redis and never uses local fallback", native, async t => {
  const f = fixture(t); const k = f.key("wrong-type");
  await client.set(k.indexKey, "wrong-type", { EX: 90 });
  assert.deepEqual(await f.status(), { status: "unavailable", expiresInSeconds: 0 });
});
