import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test, type TestContext } from "node:test";
import { createClient } from "redis";
import { createScopedScreenshotImageCache, scopedScreenshotImageKey, type ScreenshotImageScope } from "../src/realtime/scopedScreenshotImageCache.ts";

const redisUrl = process.env.TEST_REDIS_URL;
const options = { skip: !redisUrl, timeout: 10_000 };

async function fixture(t: TestContext) {
  const url = new URL(redisUrl!);
  assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(url.hostname), "Synthetic cache tests stay on existing loopback Redis");
  const client = createClient({ url: redisUrl, socket: { reconnectStrategy: false, connectTimeout: 1_000 } });
  client.on("error", () => {});
  await client.connect();
  const prefix = `schoolpilot:test:image:${randomUUID()}:`;
  const clock = Date.now();
  let serverNow = clock;
  const scope: ScreenshotImageScope = { binding: { schoolId: "school-a", studentId: randomUUID(),
    studentSessionId: randomUUID(), deviceId: randomUUID(), teachingSessionId: randomUUID(), controlRevision: 1 },
    bindingVersion: "v2:synthetic-exact-authority", legacyKey: `${prefix}legacy` };
  const commands: string[][] = [];
  const cache = createScopedScreenshotImageCache(async args => {
    commands.push(args);
    return client.sendCommand(args);
  }, { prefix, now: () => serverNow });
  const keys = new Set([scope.legacyKey, scopedScreenshotImageKey(prefix, scope)]);
  t.after(async () => { for (const key of keys) await client.del(key); await client.quit(); });
  const data = { ...scope.binding, bindingVersion: scope.bindingVersion, capturedAt: new Date(clock).toISOString(),
    timestamp: clock, tabTitle: "First title", tabUrl: "https://example.invalid/one", screenshot: "data:image/jpeg;base64,cGl4ZWxz" };
  const later = (delta: number) => ({ ...data, capturedAt: new Date(clock + delta).toISOString(), timestamp: clock + delta });
  return { client, prefix, scope, clock, data, later, cache, keys, commands,
    advanceClock(delta: number) { serverNow += delta; } };
}

test("a full frame stores one pixel field, acknowledges an opaque ID and removes the same-scope legacy blob", options, async t => {
  const f = await fixture(t);
  await f.client.set(f.scope.legacyKey, JSON.stringify({ ...f.data, timestamp: f.clock - 1, capturedAt: new Date(f.clock - 1).toISOString() }));
  const stored = await f.cache.storeFull(f.scope, f.data);
  assert.equal(stored.status, "stored");
  assert.ok(stored.status === "stored");
  assert.match(stored.imageId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  const key = scopedScreenshotImageKey(f.prefix, f.scope);
  const fields = await f.client.hGetAll(key);
  assert.deepEqual(Object.keys(fields).sort(), ["contentHash", "imageId", "metadata", "pixels", "timestamp"]);
  assert.equal(fields.pixels, f.data.screenshot);
  assert.ok(!fields.metadata!.includes(f.data.screenshot));
  assert.equal(await f.client.exists(f.scope.legacyKey), 0);
  assert.ok(await f.client.pTTL(key) > 0 && await f.client.pTTL(key) <= 120_000);
  const read = await f.cache.read([f.scope]);
  assert.equal(read.status, "ok");
  assert.ok(read.status === "ok");
  assert.equal(read.screenshots[0]?.screenshot, f.data.screenshot);
  assert.equal(read.screenshots[0]?.imageId, stored.imageId);
  assert.ok(!JSON.stringify(read).includes(fields.contentHash!));
});

test("a fresh recapture reference changes only metadata and TTL; known teacher IDs omit pixels", options, async t => {
  const f = await fixture(t);
  const stored = await f.cache.storeFull(f.scope, f.data);
  assert.ok(stored.status === "stored");
  const key = scopedScreenshotImageKey(f.prefix, f.scope);
  const pixels = await f.client.hGet(key, "pixels");
  const contentHash = await f.client.hGet(key, "contentHash");
  await f.client.pExpire(key, 2_000);
  const { screenshot: _, ...metadata } = f.later(10);
  assert.deepEqual(await f.cache.refresh(f.scope, { ...metadata, imageId: stored.imageId, tabTitle: "New title", tabUrl: "https://example.invalid/two" }), stored);
  assert.equal(await f.client.hGet(key, "pixels"), pixels);
  assert.equal(await f.client.hGet(key, "contentHash"), contentHash);
  assert.ok(await f.client.pTTL(key) > 100_000);
  const latestCommand = f.commands.at(-1)!;
  assert.ok(!latestCommand.slice(2).some(argument => argument.includes(f.data.screenshot)), "Reference mutations never resend pixels");
  const result = await f.cache.read([f.scope], [stored.imageId]);
  assert.ok(result.status === "ok");
  assert.deepEqual(result.screenshots[0], { ...metadata, imageId: stored.imageId, tabTitle: "New title", tabUrl: "https://example.invalid/two", unchanged: true });
  const full = await f.cache.read([f.scope], [randomUUID()]);
  assert.ok(full.status === "ok");
  assert.equal(full.screenshots[0]?.screenshot, pixels);
});

test("references cannot create, cross an authority, refresh a missing image or replace newer captures", options, async t => {
  const f = await fixture(t);
  const { screenshot: _, ...metadata } = f.data;
  assert.deepEqual(await f.cache.refresh(f.scope, { ...metadata, imageId: randomUUID() }), { status: "need_full_frame" });
  const stored = await f.cache.storeFull(f.scope, f.later(20));
  assert.ok(stored.status === "stored");
  assert.deepEqual(await f.cache.refresh(f.scope, { ...metadata, imageId: randomUUID() }), { status: "need_full_frame" });
  assert.deepEqual(await f.cache.refresh(f.scope, { ...metadata, imageId: stored.imageId }), { status: "superseded" });
  assert.deepEqual(await f.cache.storeFull(f.scope, f.data), { status: "superseded" });
  const other: ScreenshotImageScope = { ...f.scope, legacyKey: `${f.prefix}other-legacy`,
    binding: { ...f.scope.binding, studentSessionId: randomUUID(), controlRevision: 2 } };
  f.keys.add(other.legacyKey); f.keys.add(scopedScreenshotImageKey(f.prefix, other));
  assert.deepEqual(await f.cache.refresh(other, { ...metadata, ...other.binding, imageId: stored.imageId }), { status: "need_full_frame" });
  assert.equal(await f.client.exists(scopedScreenshotImageKey(f.prefix, other)), 0);
  await f.client.del(scopedScreenshotImageKey(f.prefix, f.scope));
  assert.deepEqual(await f.cache.refresh(f.scope, { ...metadata, imageId: stored.imageId }), { status: "need_full_frame" });
});

test("a retained Redis key cannot refresh pixels whose previous capture has reached semantic expiry", options, async t => {
  for (const age of [120_000, 121_000]) {
    const f = await fixture(t);
    const stored = await f.cache.storeFull(f.scope, f.later(-89_000));
    assert.ok(stored.status === "stored");
    const key = scopedScreenshotImageKey(f.prefix, f.scope);
    const originalMetadata = await f.client.hGet(key, "metadata");
    const ttlBefore = await f.client.pTTL(key);
    assert.ok(ttlBefore > 0);
    const advance = age - 89_000;
    f.advanceClock(advance);
    if (age > 120_000) assert.deepEqual(await f.cache.read([f.scope]), { status: "ok", screenshots: [null] });
    const { screenshot: _, ...metadata } = f.later(advance);
    assert.deepEqual(await f.cache.refresh(f.scope, { ...metadata, imageId: stored.imageId }), { status: "need_full_frame" });
    assert.equal(await f.client.hGet(key, "metadata"), originalMetadata, "failed references cannot renew capture freshness");
    assert.ok(await f.client.pTTL(key) <= ttlBefore, "failed references cannot renew retention");
    assert.equal((await f.cache.storeFull(f.scope, f.later(advance))).status, "stored", "the genuine new capture can recover using full bytes");
  }
});

test("same bytes retain their scope's ID while changed bytes and supervision scopes get independent IDs", options, async t => {
  const f = await fixture(t);
  const first = await f.cache.storeFull(f.scope, f.data);
  assert.ok(first.status === "stored");
  assert.deepEqual(await f.cache.storeFull(f.scope, f.later(10)), first);
  const changed = await f.cache.storeFull(f.scope, { ...f.later(20), screenshot: "different-pixels" });
  assert.ok(changed.status === "stored");
  assert.notEqual(changed.imageId, first.imageId);
  const { teachingSessionId: _, ...shared } = f.scope.binding;
  const supervision: ScreenshotImageScope = { ...f.scope, legacyKey: `${f.prefix}supervision-legacy`,
    bindingVersion: "v3:synthetic-context", binding: { ...shared, supervisionContextId: randomUUID() } };
  f.keys.add(supervision.legacyKey); f.keys.add(scopedScreenshotImageKey(f.prefix, supervision));
  const claimed = await f.cache.storeFull(supervision, { ...f.later(10), ...supervision.binding,
    teachingSessionId: undefined, bindingVersion: supervision.bindingVersion });
  assert.ok(claimed.status === "stored");
  assert.notEqual(claimed.imageId, first.imageId);
  assert.notEqual(scopedScreenshotImageKey(f.prefix, supervision), scopedScreenshotImageKey(f.prefix, f.scope));
});

test("legacy writes invalidate reference storage only when a newer frame wins and remain full-readable", options, async t => {
  const f = await fixture(t);
  const stored = await f.cache.storeFull(f.scope, f.later(20));
  assert.ok(stored.status === "stored");
  assert.equal(await f.cache.storeLegacy(f.scope, f.data), true);
  assert.equal(await f.client.exists(scopedScreenshotImageKey(f.prefix, f.scope)), 1);
  assert.equal(await f.cache.storeLegacy(f.scope, f.later(30)), true);
  assert.equal(await f.client.exists(scopedScreenshotImageKey(f.prefix, f.scope)), 0);
  const result = await f.cache.read([f.scope], [stored.imageId]);
  assert.ok(result.status === "ok");
  assert.equal(result.screenshots[0]?.screenshot, f.data.screenshot);
  assert.equal(result.screenshots[0]?.timestamp, f.clock + 30);
  assert.equal(result.screenshots[0]?.unchanged, undefined);
  assert.deepEqual(await f.cache.storeFull(f.scope, f.later(10)), { status: "superseded" });
});

test("cohort known IDs stay aligned and corrupted authority or missing pixels cannot authorize refresh", options, async t => {
  const f = await fixture(t);
  const first = await f.cache.storeFull(f.scope, f.data);
  assert.ok(first.status === "stored");
  const other: ScreenshotImageScope = { ...f.scope, legacyKey: `${f.prefix}other-legacy`, binding: { ...f.scope.binding, studentId: randomUUID() } };
  f.keys.add(other.legacyKey); f.keys.add(scopedScreenshotImageKey(f.prefix, other));
  const second = await f.cache.storeFull(other, { ...f.data, ...other.binding });
  assert.ok(second.status === "stored");
  const batch = await f.cache.read([f.scope, other], [first.imageId, first.imageId, randomUUID()]);
  assert.ok(batch.status === "ok");
  assert.equal(batch.screenshots[0]?.unchanged, true);
  assert.equal(batch.screenshots[1]?.screenshot, f.data.screenshot);
  const key = scopedScreenshotImageKey(f.prefix, f.scope);
  const { screenshot: _, ...metadata } = f.later(10);
  await f.client.hSet(key, "metadata", JSON.stringify({ ...metadata, studentId: "foreign", imageId: first.imageId }));
  assert.deepEqual(await f.cache.refresh(f.scope, { ...metadata, imageId: first.imageId }), { status: "need_full_frame" });
  assert.deepEqual(await f.cache.read([f.scope]), { status: "ok", screenshots: [null] });
  await f.cache.storeFull(f.scope, f.data);
  await f.client.hSet(key, "pixels", "");
  assert.deepEqual(await f.cache.refresh(f.scope, { ...metadata, imageId: first.imageId }), { status: "need_full_frame" });
});

test("atomic races retain the newest capture and preserve large control revisions exactly", options, async t => {
  const f = await fixture(t);
  const scope: ScreenshotImageScope = { ...f.scope, bindingVersion: "v2:large-revision",
    binding: { ...f.scope.binding, controlRevision: 9_007_199_254_740_991 } };
  f.keys.add(scopedScreenshotImageKey(f.prefix, scope));
  const data = { ...f.data, ...scope.binding, bindingVersion: scope.bindingVersion };
  const full = await f.cache.storeFull(scope, data);
  assert.ok(full.status === "stored");
  const { screenshot: _, ...metadata } = data;
  await Promise.all([30, 10, 20].map(delta => f.cache.refresh(scope, { ...metadata,
    capturedAt: new Date(f.clock + delta).toISOString(), timestamp: f.clock + delta, imageId: full.imageId })));
  const result = await f.cache.read([scope], [full.imageId]);
  assert.ok(result.status === "ok");
  assert.equal(result.screenshots[0]?.timestamp, f.clock + 30);
  assert.equal(result.screenshots[0]?.controlRevision, 9_007_199_254_740_991);
});

test("invalid binding, version, capture time and image IDs fail before Redis; transport failures remain unavailable", async () => {
  let calls = 0;
  const now = Date.now();
  const scope: ScreenshotImageScope = { binding: { schoolId: "school-a", studentId: "student", studentSessionId: "session", deviceId: "device", teachingSessionId: "class", controlRevision: 1 },
    bindingVersion: "v2:exact", legacyKey: "legacy" };
  const cache = createScopedScreenshotImageCache(async () => { calls++; return undefined; }, { prefix: "test:", now: () => now });
  const data = { ...scope.binding, bindingVersion: scope.bindingVersion, timestamp: now, capturedAt: new Date(now).toISOString(), screenshot: "pixels" };
  for (const changed of [{ schoolId: "foreign" }, { controlRevision: 2 }, { supervisionContextId: "foreign" }, { bindingVersion: "wrong" }, { timestamp: now - 121_000 }, { capturedAt: "bad" }]) {
    assert.deepEqual(await cache.storeFull(scope, { ...data, ...changed }), { status: "invalid" });
  }
  assert.deepEqual(await cache.refresh(scope, { ...data, imageId: "not-a-uuid" }), { status: "invalid" });
  assert.equal(calls, 0);
  assert.deepEqual(await cache.storeFull(scope, data), { status: "unavailable" });
  assert.deepEqual(await cache.read([scope]), { status: "unavailable" });
  assert.equal(calls, 2);
});
