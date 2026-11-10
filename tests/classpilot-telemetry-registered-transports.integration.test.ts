import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { once } from "node:events";
import { setTimeout as pause } from "node:timers/promises";
import express from "express";
import { WebSocket } from "ws";
import { and, eq, sql } from "drizzle-orm";

process.env.NODE_ENV = "test";
process.env.SCHEDULER_ENABLED = "false";
process.env.REDIS_URL = "";
process.env.RLS_GUC_ENABLED = "true";
process.env.CLASSPILOT_PROTOCOL_V3_ENABLED = "true";
process.env.CLASSPILOT_CAP_SCOPED_AUTHORITY_CHECKS_V1 = "true";
process.env.CLASSPILOT_CAP_DEVICE_TELEMETRY_TRANSPORT_V1 = "true";
process.env.CLASSPILOT_CAPABILITY_ROLLOUTS_JSON = "";

test("registered HTTP and WebSocket heartbeat operations share durable retries and fresh revocation checks", { timeout: 120_000 }, async () => {
  const dbUrl = new URL(process.env.DATABASE_URL || "");
  assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(dbUrl.hostname), "Only the existing local PostgreSQL fixture is allowed");
  const { db, pool, sessionPool } = await import("../src/db.js");
  const { runWithTenantContext, drainTenantContextReleases } = await import("../src/middleware/tenantContext.js");
  const schema = await import("../src/schema/index.js");
  const storage = await import("../src/services/storage.js");
  const { createStudentToken } = await import("../src/services/deviceJwt.js");
  // Import the real router: its module registers the canonical WS operations.
  const { default: router } = await import("../src/routes/classpilot/devices.js");
  const websocket = await import("../src/realtime/websocket.js");
  const { errorHandler } = await import("../src/middleware/errorHandler.js");
  const schoolId = randomUUID(), studentId = randomUUID(), deviceId = randomUUID(), sessionId = randomUUID();
  const scoped = <T>(action: () => Promise<T>) => runWithTenantContext({ schoolId }, action);
  const app = express();
  app.use(express.json());
  app.use("/api/classpilot", router);
  app.use(errorHandler);
  const server = createServer(app);
  const wss = websocket.setupWebSocket(server);
  let socket: WebSocket | undefined;
  try {
    // Commit synthetic rows so HTTP and WS own independent real RLS leases.
    await runWithTenantContext({ isSuper: true }, () => db.transaction(async tx => {
      await tx.insert(schema.schools).values({ id: schoolId, name: "Synthetic registered telemetry", domain: `${schoolId}.invalid` });
      await tx.insert(schema.productLicenses).values({ schoolId, product: "CLASSPILOT", status: "active" });
      await tx.insert(schema.settings).values({ schoolId, schoolName: "Synthetic registered telemetry", wsSharedKey: "synthetic",
        enableTrackingHours: false });
      await tx.insert(schema.students).values({ id: studentId, schoolId, firstName: "Synthetic", lastName: "Transport", status: "active" });
      await tx.insert(schema.devices).values({ deviceId, schoolId, classId: schoolId, deviceName: "Synthetic transport" });
      await tx.insert(schema.studentSessions).values({ id: sessionId, studentId, deviceId, authKind: "managed_profile", isActive: true });
    }));
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const token = createStudentToken({ schoolId, studentId, deviceId, sessionId });
    const capabilities = ["scopedAuthorityChecksV1", "deviceTelemetryTransportV1"];
    socket = new WebSocket(`ws://127.0.0.1:${address.port}/ws`);
    const frames: Array<Record<string, unknown>> = [];
    socket.on("message", raw => frames.push(JSON.parse(raw.toString())));
    const waitFor = async (predicate: (frame: Record<string, unknown>) => boolean) => {
      for (const deadline = Date.now() + 8_000; Date.now() < deadline;) {
        const frame = frames.find(predicate);
        if (frame) return frame;
        await pause(5);
      }
      assert.fail(`Expected registered socket result; observed frame types: ${frames.map(frame => frame.type).join(",")}`);
    };
    await once(socket, "open");
    socket.send(JSON.stringify({ type: "auth", role: "student", deviceId, studentToken: token,
      clientProtocolVersion: 3, extensionCapabilities: capabilities }));
    const auth = await waitFor(frame => frame.type === "auth-success" || frame.type === "auth-error");
    assert.equal(auth.type, "auth-success");
    assert.ok(Array.isArray(auth.acceptedCapabilities) && auth.acceptedCapabilities.includes("deviceTelemetryTransportV1"));
    const payload = { activeTabUrl: "chrome://newtab", activeTabTitle: "Synthetic registered lesson", status: "active",
      clientProtocolVersion: 3, extensionCapabilities: capabilities };
    const http = async (operationId: string, body = payload) => {
      const response = await fetch(`http://127.0.0.1:${address.port}/api/classpilot/device/heartbeat`, {
        method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ ...body, telemetryOperationId: operationId }),
      });
      return { status: response.status, body: await response.json() as Record<string, unknown> };
    };
    const send = async (operationId: string, body = payload) => {
      // Remove a previous receipt; this request must receive its own fresh result.
      for (let index = frames.length - 1; index >= 0; index--) if (frames[index]?.operationId === operationId) frames.splice(index, 1);
      socket!.send(JSON.stringify({ type: "device-telemetry", operationId, kind: "heartbeat", studentToken: token, payload: body }));
      return waitFor(frame => frame.type === "device-telemetry-result" && frame.operationId === operationId);
    };
    const count = async () => (await scoped(() => db.select({ count: sql<number>`count(*)::int` }).from(schema.heartbeats)
      .where(and(eq(schema.heartbeats.schoolId, schoolId), eq(schema.heartbeats.studentId, studentId)))))[0]!.count;
    const firstId = randomUUID();
    const first = await http(firstId);
    assert.equal(first.status, 200);
    assert.equal(first.body.ok, true);
    const replay = await send(firstId);
    assert.equal(replay.status, 200);
    assert.deepEqual(replay.exactBinding, { studentId, studentSessionId: sessionId });
    assert.equal(await count(), 1, "HTTP then WS recovery persists one heartbeat");
    const secondId = randomUUID();
    const second = await send(secondId);
    assert.equal(second.status, 200);
    // Simulate the client losing that application receipt and using HTTP recovery.
    const recovery = await http(secondId);
    assert.equal(recovery.status, 200);
    assert.equal(await count(), 2, "WS then HTTP recovery also persists one heartbeat");
    const conflict = await http(secondId, { ...payload, activeTabTitle: "Different payload" });
    assert.equal(conflict.status, 409);
    assert.equal(await count(), 2);
    await scoped(() => db.update(schema.productLicenses).set({ status: "inactive" }).where(eq(schema.productLicenses.schoolId, schoolId)));
    assert.equal((await send(secondId)).status, 403, "the already-authenticated socket cannot replay across license revocation");
    assert.equal((await http(secondId)).status, 403);
    assert.equal(await count(), 2);
    await scoped(() => db.update(schema.productLicenses).set({ status: "active" }).where(eq(schema.productLicenses.schoolId, schoolId)));
    await scoped(() => db.update(schema.studentSessions).set({ isActive: false, endedAt: new Date() }).where(eq(schema.studentSessions.id, sessionId)));
    assert.equal((await send(secondId)).status, 401, "a persistent socket cannot authorize a retired student binding");
    assert.equal((await http(secondId)).status, 401);
    assert.equal(await count(), 2);
  } finally {
    socket?.terminate();
    websocket.stopWebSocketWork();
    await websocket.drainWebSocketWork();
    for (const client of wss.clients) client.terminate();
    await new Promise<void>(resolve => wss.close(() => resolve()));
    if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()));
    const classifications = await import("../src/services/heartbeatClassificationBatcher.js");
    await classifications.flushHeartbeatClassificationProducers();
    await classifications.flushHeartbeatClassificationBatches();
    await runWithTenantContext({ isSuper: true }, () => db.transaction(async tx => {
      await tx.delete(schema.heartbeats).where(eq(schema.heartbeats.schoolId, schoolId));
      await tx.delete(schema.studentSessions).where(eq(schema.studentSessions.studentId, studentId));
      await tx.delete(schema.devices).where(eq(schema.devices.schoolId, schoolId));
      await tx.delete(schema.students).where(eq(schema.students.schoolId, schoolId));
      await tx.delete(schema.settings).where(eq(schema.settings.schoolId, schoolId));
      await tx.delete(schema.productLicenses).where(eq(schema.productLicenses.schoolId, schoolId));
      await tx.update(schema.schools).set({ status: "suspended", isActive: false, deletedAt: new Date() }).where(eq(schema.schools.id, schoolId));
    }));
    await drainTenantContextReleases();
    await (await import("../src/services/errorMonitor.js")).default.disposeAndWait();
    await (await import("../src/realtime/ws-redis.js")).disposeWSRedis();
    const scheduler = await import("../src/services/schedulerDb.js");
    await Promise.all([pool.end(), sessionPool.end(), scheduler.schedulerPool.end(), scheduler.schedulerLockPool.end()]);
  }
});
