import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { createClient } from "redis";

const url = process.env.TEST_REDIS_URL;
if (url) {
  const address = new URL(url);
  assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(address.hostname), "Detail Redis probes require an isolated loopback service");
}
process.env.REDIS_URL = url || "";
process.env.CLASSPILOT_OBSERVATION_HMAC_SECRET = "synthetic-detail-preview-redis-test";
const D = await import("../src/services/classpilotDetailPreview.js");
const R = await import("../src/realtime/ws-redis.js");
const client = createClient({ url, socket: { reconnectStrategy: false, connectTimeout: 3000 } });
const errors: unknown[] = [];
client.on("error", error => errors.push(error));
before(async () => { if (!url) return; await client.connect(); await R.subscribeWS(() => {}); assert.equal(R.isRedisPublisherReady(), true); });
after(async () => { await R.disposeWSRedis(); if (client.isOpen) await client.quit(); assert.deepEqual(errors, []); });

test("native detail Lua coalesces viewers, bounds pixel TTL, and atomically preserves other viewers on release", { skip: !url, timeout: 10_000 }, async () => {
  const schoolId = `detail-native-${randomUUID()}`;
  const binding = { schoolId, studentId: "student", deviceId: "private-device", studentSessionId: "login", teachingSessionId: "class", controlRevision: 1 };
  const a = { schoolId, viewerUserId: "teacher", viewerInstanceId: "a" };
  const b = { schoolId, viewerUserId: "observer", viewerInstanceId: "b" };
  const first = await D.renewDetailPreview({ ...a, binding });
  try {
    const second = await D.renewDetailPreview({ ...b, binding }); assert.equal(second.leaseId, first.leaseId);
    const captured = Date.now();
    const image = { screenshot: "data:image/jpeg;base64,/9j/2Q==", timestamp: captured, capturedAt: new Date(captured).toISOString(),
      bindingVersion: D.detailPreviewBindingVersion(binding), resolution: "detail" as const, captureCadenceMode: "active_view" as const };
    assert.equal(await D.writeDetailPreview({ binding, leaseId: first.leaseId, image: { ...image, timestamp: first.startedAt - 1 } }), "stale");
    assert.equal(await D.writeDetailPreview({ binding, leaseId: first.leaseId, image }), "stored");
    const ttl = await client.pTTL(`classpilot:detail-image:v1:${D.detailPreviewBindingVersion(binding)}`);
    assert.ok(ttl > 0 && ttl <= 20_000);
    assert.deepEqual(await D.readDetailPreview({ ...a, binding }), image);
    assert.equal(await D.releaseDetailPreview({ ...a, leaseId: first.leaseId }), true);
    assert.equal(await D.readDetailPreview({ ...a, binding }), null);
    assert.deepEqual(await D.readDetailPreview({ ...b, binding }), image);
    assert.equal(await D.releaseDetailPreview({ ...b, leaseId: first.leaseId }), true);
    const next = await D.renewDetailPreview({ ...a, binding }); assert.notEqual(next.leaseId, first.leaseId);
    assert.equal(await D.releaseDetailPreview({ ...a, leaseId: first.leaseId }), false);
    assert.equal((await D.detailPreviewStatus({ binding }))?.leaseId, next.leaseId);
    assert.equal(await D.readDetailPreview({ ...a, binding }), null);
    assert.equal(await D.writeDetailPreview({ binding, leaseId: first.leaseId, image }), "stale");
  } finally {
    const lease = await D.detailPreviewStatus({ binding });
    if (lease) { await D.releaseDetailPreview({ ...a, leaseId: lease.leaseId }); await D.releaseDetailPreview({ ...b, leaseId: lease.leaseId }); }
  }
});
