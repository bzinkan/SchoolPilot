import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { test, type TestContext } from "node:test";
import { createClient } from "redis";
import { createScopedScreenshotImageCache, scopedScreenshotImageKey, type ScreenshotImageScope } from "../src/realtime/scopedScreenshotImageCache.js";
import { SCREENSHOT_JPEG_DATA_URI } from "../src/services/classpilotScreenshotDelta.js";

const options = { skip: !process.env.TEST_REDIS_URL, timeout: 10_000 };
const base = Buffer.from(Array.from({ length: 1024 }, (_, index) => index % 251));
base[0] = 255; base[1] = 216; base[1022] = 255; base[1023] = 217;
const target = Buffer.from(base); target[500] = 233;
const u32 = (value: number) => { const bytes = Buffer.alloc(4); bytes.writeUInt32BE(value); return bytes; };
const patch = Buffer.concat([Buffer.from("CPD1"), u32(1024), u32(1024), Buffer.from([1]), u32(0), u32(500),
  Buffer.from([0]), u32(1), Buffer.from([233]), Buffer.from([1]), u32(501 * 8), u32(523)]);
const uri = (bytes: Uint8Array) => `${SCREENSHOT_JPEG_DATA_URI}${Buffer.from(bytes).toString("base64")}`;
function delta(baseImageId: string) { return { codec: "cp-bit-copy-v1" as const, baseImageId, data: patch.toString("base64"), targetBytes: 1024,
  uploadIntegrity: createHash("sha256").update("classpilot:screenshot-delta-upload:v1\0").update(baseImageId).update("\0").update(target).digest("hex") }; }

async function fixture(t: TestContext) {
  const url = new URL(process.env.TEST_REDIS_URL!);
  assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(url.hostname));
  const client = createClient({ url: url.toString(), socket: { reconnectStrategy: false, connectTimeout: 1000 } });
  client.on("error", () => {}); await client.connect();
  const prefix = `schoolpilot:test:delta:${randomUUID()}:`;
  const clock = Date.now(); let now = clock;
  const scope: ScreenshotImageScope = { binding: { schoolId: "synthetic-school", studentId: randomUUID(), studentSessionId: randomUUID(),
    deviceId: randomUUID(), teachingSessionId: randomUUID(), controlRevision: 1 }, bindingVersion: "v2:synthetic-delta", legacyKey: `${prefix}legacy` };
  let hook: (() => Promise<void>) | undefined;
  const commands: string[][] = [];
  const baseReadBytes: number[] = [];
  const cache = createScopedScreenshotImageCache(async args => {
    commands.push(args); const result = await client.sendCommand(args);
    const next = hook; hook = undefined; await next?.(); return result;
  }, { prefix, now: () => now, onDeltaBaseRead: bytes => baseReadBytes.push(bytes) });
  const key = scopedScreenshotImageKey(prefix, scope);
  const keys = new Set([key, scope.legacyKey]);
  const metadata = (offset = 0) => ({ ...scope.binding, bindingVersion: scope.bindingVersion, timestamp: clock + offset,
    capturedAt: new Date(clock + offset).toISOString(), tabTitle: "Synthetic lesson", tabUrl: "https://example.invalid/lesson" });
  t.after(async () => { for (const key of keys) await client.del(key); await client.quit(); });
  return { client, cache, key, prefix, scope, keys, clock, commands, baseReadBytes, metadata,
    advance(milliseconds: number) { now += milliseconds; },
    afterNextCommand(callback: () => Promise<void>) { hook = callback; } };
}

test("a profitable delta stores one complete current image and one target-ID-scoped patch, with legacy readers intact", options, async t => {
  const f = await fixture(t);
  assert.equal(typeof f.cache.storeDelta, "function");
  const first = await f.cache.storeFull(f.scope, { ...f.metadata(), screenshot: uri(base) });
  assert.ok(first.status === "stored");
  const uploaded = delta(first.imageId);
  const stored = await f.cache.storeDelta(f.scope, f.metadata(10), uploaded, 1024);
  assert.ok(stored.status === "stored");
  assert.notEqual(stored.imageId, first.imageId);
  const fields = await f.client.hGetAll(f.key);
  assert.equal(fields.pixels, uri(target));
  assert.equal(fields.contentHash, createHash("sha256").update(uri(target)).digest("hex"));
  assert.equal(fields.deltaBaseId, first.imageId);
  assert.equal(fields.deltaTargetId, stored.imageId);
  assert.ok(Object.entries(fields).every(([field, value]) => field === "pixels" || !value.includes(uri(target))), "do not retain a duplicate full image");
  assert.ok(!fields.deltaPatch!.includes(uploaded.uploadIntegrity), "upload integrity is private input, not a public digest");
  const older = await f.cache.read([f.scope], [first.imageId]);
  assert.ok(older.status === "ok"); assert.equal(older.screenshots[0]?.screenshot, uri(target));
  const newer = await f.cache.read([f.scope], [first.imageId], [true]);
  assert.ok(newer.status === "ok");
  assert.equal(newer.screenshots[0]?.screenshot, undefined);
  assert.equal(newer.screenshots[0]?.imageId, stored.imageId);
  assert.equal(newer.screenshots[0]?.delta?.baseImageId, first.imageId);
  assert.equal(newer.screenshots[0]?.delta?.data, uploaded.data);
  const expectedTag = createHash("sha256").update("classpilot:screenshot-delta-display:v1\0").update(stored.imageId).update("\0").update(target).digest("hex");
  assert.equal(newer.screenshots[0]?.delta?.integrityTag, expectedTag);
  assert.ok(!JSON.stringify(newer).includes(fields.contentHash!));
  assert.deepEqual(f.baseReadBytes, [Buffer.byteLength(uri(base))]);
  const same = await f.cache.read([f.scope], [stored.imageId], [true]);
  assert.ok(same.status === "ok"); assert.equal(same.screenshots[0]?.unchanged, true); assert.equal(same.screenshots[0]?.delta, undefined);
});

test("full writes clear the delta slot while fresh exact references retain a consistent target", options, async t => {
  const f = await fixture(t);
  const first = await f.cache.storeFull(f.scope, { ...f.metadata(), screenshot: uri(base) }); assert.ok(first.status === "stored");
  const stored = await f.cache.storeDelta(f.scope, f.metadata(10), delta(first.imageId), 1024); assert.ok(stored.status === "stored");
  assert.deepEqual(await f.cache.refresh(f.scope, { ...f.metadata(20), imageId: stored.imageId }), stored);
  const refreshed = await f.cache.read([f.scope], [first.imageId], [true]);
  assert.ok(refreshed.status === "ok"); assert.ok(refreshed.screenshots[0]?.delta); assert.equal(refreshed.screenshots[0]?.timestamp, f.clock + 20);
  const full = await f.cache.storeFull(f.scope, { ...f.metadata(30), screenshot: uri(target) });
  assert.deepEqual(full, stored);
  assert.equal(await f.client.hExists(f.key, "deltaPatch"), 0);
  const read = await f.cache.read([f.scope], [first.imageId], [true]);
  assert.ok(read.status === "ok"); assert.equal(read.screenshots[0]?.screenshot, uri(target)); assert.equal(read.screenshots[0]?.delta, undefined);
});

test("forged integrity, logical oversize, unknown bases and corrupt JPEGs never renew metadata or retention", options, async t => {
  const f = await fixture(t);
  const first = await f.cache.storeFull(f.scope, { ...f.metadata(), screenshot: uri(base) }); assert.ok(first.status === "stored");
  const before = await f.client.hGetAll(f.key); await f.client.pExpire(f.key, 2000); const ttl = await f.client.pTTL(f.key);
  for (const [uploaded, limit] of [[{ ...delta(first.imageId), uploadIntegrity: "0".repeat(64) }, 1024], [delta(first.imageId), 1023], [delta(randomUUID()), 1024]] as const) {
    assert.deepEqual(await f.cache.storeDelta(f.scope, f.metadata(10), uploaded, limit), { status: "need_full_frame" });
    assert.deepEqual(await f.client.hGetAll(f.key), before); assert.ok(await f.client.pTTL(f.key) <= ttl);
  }
  await f.client.hSet(f.key, "pixels", "not-a-canonical-jpeg"); const bad = await f.client.hGetAll(f.key);
  assert.deepEqual(await f.cache.storeDelta(f.scope, f.metadata(10), delta(first.imageId), 1024), { status: "need_full_frame" });
  assert.deepEqual(await f.client.hGetAll(f.key), bad); assert.ok(await f.client.pTTL(f.key) <= ttl);
});

test("malformed base metadata and another exact authority require full bytes without modifying either scope", options, async t => {
  const f = await fixture(t);
  const first = await f.cache.storeFull(f.scope, { ...f.metadata(), screenshot: uri(base) }); assert.ok(first.status === "stored");
  const original = await f.client.hGet(f.key, "metadata");
  for (const metadata of ["{invalid-json", "{}", JSON.stringify({ ...f.metadata(), schoolId: "foreign-school", imageId: first.imageId })]) {
    await f.client.hSet(f.key, "metadata", metadata); const ttl = await f.client.pTTL(f.key);
    assert.deepEqual(await f.cache.storeDelta(f.scope, f.metadata(10), delta(first.imageId), 1024), { status: "need_full_frame" });
    assert.equal(await f.client.hGet(f.key, "metadata"), metadata); assert.ok(await f.client.pTTL(f.key) <= ttl);
  }
  assert.ok(original); await f.client.hSet(f.key, "metadata", original);
  const other: ScreenshotImageScope = { ...f.scope, legacyKey: `${f.scope.legacyKey}:other`,
    binding: { ...f.scope.binding, studentSessionId: randomUUID(), controlRevision: 2 } };
  f.keys.add(other.legacyKey); f.keys.add(scopedScreenshotImageKey(f.prefix, other));
  assert.deepEqual(await f.cache.storeDelta(other, { ...f.metadata(10), ...other.binding }, delta(first.imageId), 1024), { status: "need_full_frame" });
  assert.equal(await f.client.hGet(f.key, "metadata"), original);
});

test("a raced base replacement cannot commit an old patch or renew the newer image TTL", options, async t => {
  const f = await fixture(t);
  const first = await f.cache.storeFull(f.scope, { ...f.metadata(), screenshot: uri(base) }); assert.ok(first.status === "stored");
  const other = Buffer.from(target); other[700] = 13;
  let newer: Record<string, string> = {}; let ttl = 0;
  f.afterNextCommand(async () => {
    assert.equal((await f.cache.storeFull(f.scope, { ...f.metadata(20), screenshot: uri(other) })).status, "stored");
    await f.client.pExpire(f.key, 2000); newer = await f.client.hGetAll(f.key); ttl = await f.client.pTTL(f.key);
  });
  assert.deepEqual(await f.cache.storeDelta(f.scope, f.metadata(10), delta(first.imageId), 1024), { status: "need_full_frame" });
  assert.deepEqual(await f.client.hGetAll(f.key), newer); assert.ok(await f.client.pTTL(f.key) <= ttl);
});

test("semantic expiry or deletion after base lookup cannot be revived by the atomic delta write", options, async t => {
  for (const expired of [true, false]) {
    const f = await fixture(t);
    const first = await f.cache.storeFull(f.scope, { ...f.metadata(), screenshot: uri(base) }); assert.ok(first.status === "stored");
    const before = await f.client.hGetAll(f.key); const ttl = await f.client.pTTL(f.key);
    f.afterNextCommand(async () => { if (expired) f.advance(121000); else await f.client.del(f.key); });
    assert.deepEqual(await f.cache.storeDelta(f.scope, f.metadata(10), delta(first.imageId), 1024), { status: "need_full_frame" });
    if (expired) { assert.deepEqual(await f.client.hGetAll(f.key), before); assert.ok(await f.client.pTTL(f.key) <= ttl); }
    else assert.equal(await f.client.exists(f.key), 0);
  }
});

test("a mixed older full writer cannot make a retained patch describe the wrong current image", options, async t => {
  const f = await fixture(t);
  const first = await f.cache.storeFull(f.scope, { ...f.metadata(), screenshot: uri(base) }); assert.ok(first.status === "stored");
  const changed = await f.cache.storeDelta(f.scope, f.metadata(10), delta(first.imageId), 1024); assert.ok(changed.status === "stored");
  const imageId = randomUUID(); const other = Buffer.from(target); other[700] = 13;
  // The previous writer knows only the original fields and leaves unknown fields intact.
  await f.client.hSet(f.key, { metadata: JSON.stringify({ ...f.metadata(20), imageId }), timestamp: String(f.clock + 20),
    imageId, pixels: uri(other), contentHash: createHash("sha256").update(uri(other)).digest("hex") });
  const read = await f.cache.read([f.scope], [first.imageId], [true]);
  assert.ok(read.status === "ok"); assert.equal(read.screenshots[0]?.screenshot, uri(other)); assert.equal(read.screenshots[0]?.delta, undefined);
});

test("malformed retained patches recover one full read without disabling ordinary pixels", options, async t => {
  const f = await fixture(t);
  const first = await f.cache.storeFull(f.scope, { ...f.metadata(), screenshot: uri(base) }); assert.ok(first.status === "stored");
  const changed = await f.cache.storeDelta(f.scope, f.metadata(10), delta(first.imageId), 1024); assert.ok(changed.status === "stored");
  await f.client.hSet(f.key, "deltaPatch", "{bad-json"); const count = f.commands.length;
  const read = await f.cache.read([f.scope], [first.imageId], [true]);
  assert.ok(read.status === "ok"); assert.equal(read.screenshots[0]?.screenshot, uri(target)); assert.equal(read.screenshots[0]?.delta, undefined);
  assert.ok(f.commands.length - count <= 2, "invalid patch fallback is bounded to one full cohort recovery");
});
