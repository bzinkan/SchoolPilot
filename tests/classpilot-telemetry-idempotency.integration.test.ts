import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { heartbeatTelemetryIdentity } from "../src/services/classpilotDeviceTelemetry.js";

process.env.NODE_ENV = "test";
process.env.SCHEDULER_ENABLED = "false";
process.env.RLS_GUC_ENABLED = "true";
process.env.REDIS_URL = "";

test("lost telemetry receipt reuses one durable heartbeat; mismatches and revoked sessions fail closed", async () => {
  assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(new URL(process.env.DATABASE_URL || "").hostname), "local database required");
  const { db, pool, sessionPool } = await import("../src/db.js");
  const { runWithTenantContext } = await import("../src/middleware/tenantContext.js");
  const schema = await import("../src/schema/index.js");
  const storage = await import("../src/services/storage.js");
  const schoolId = randomUUID(), studentId = randomUUID(), deviceId = randomUUID(), sessionId = randomUUID();
  const binding = { schoolId, studentId, deviceId, studentSessionId: sessionId };
  const data = { schoolId, studentId, deviceId, activeTabTitle: "Synthetic lesson", activeTabUrl: "https://example.invalid/",
    screenshotHealth: { lastSuccessAt: 123 } };
  const identity = heartbeatTelemetryIdentity(binding, randomUUID(), data);
  const rollback = new Error("rollback synthetic telemetry fixture");
  try {
    await assert.rejects(runWithTenantContext({ isSuper: true }, () => db.transaction(async tx => {
      await tx.insert(schema.schools).values({ id: schoolId, name: "Synthetic telemetry", domain: `${schoolId}.invalid` });
      await tx.insert(schema.students).values({ id: studentId, schoolId, firstName: "Synthetic", lastName: "Telemetry", status: "active" });
      await tx.insert(schema.devices).values({ deviceId, schoolId, classId: schoolId, deviceName: "Synthetic telemetry device" });
      await tx.insert(schema.studentSessions).values({ id: sessionId, studentId, deviceId, authKind: "managed_profile", isActive: true });
      const first = await storage.createHeartbeatAndRefreshPresence(data, sessionId, identity);
      assert.equal(first.outcome, "recorded"); if (first.outcome !== "recorded") throw new Error("not recorded");
      assert.equal(first.replayed, false);
      const replay = await storage.createHeartbeatAndRefreshPresence(data, sessionId, identity);
      assert.equal(replay.outcome, "recorded"); if (replay.outcome !== "recorded") throw new Error("not replayed");
      assert.equal(replay.replayed, true); assert.equal(replay.id, first.id);
      assert.equal(replay.timestamp.getTime(), first.timestamp.getTime());
      assert.equal(replay.leaseRenewed, false);
      const rows = await tx.select({ id: schema.heartbeats.id, hash: schema.heartbeats.telemetryPayloadHash,
        health: schema.heartbeats.screenshotHealth }).from(schema.heartbeats).where(eq(schema.heartbeats.studentId, studentId));
      assert.equal(rows.length, 1); assert.equal(rows[0]!.hash, identity.payloadHash);
      assert.deepEqual(rows[0]!.health, data.screenshotHealth, "private identity never enters public screenshot health");
      const publicRows = await storage.getHeartbeatsByStudent(studentId);
      assert.equal("telemetryPayloadHash" in publicRows[0]!, false);
      assert.deepEqual(await storage.createHeartbeatAndRefreshPresence({ ...data, activeTabTitle: "Changed" }, sessionId,
        { ...identity, payloadHash: "a".repeat(64) }), { outcome: "operation_conflict" });
      assert.equal((await tx.select({ count: sql<number>`count(*)::int` }).from(schema.heartbeats)
        .where(and(eq(schema.heartbeats.studentId, studentId), eq(schema.heartbeats.id, identity.id))))[0]!.count, 1);
      await tx.update(schema.studentSessions).set({ isActive: false, endedAt: new Date() }).where(eq(schema.studentSessions.id, sessionId));
      assert.deepEqual(await storage.createHeartbeatAndRefreshPresence(data, sessionId, identity), { outcome: "inactive_session" });
      throw rollback;
    })), error => error === rollback);
  } finally { await Promise.all([pool.end(), sessionPool.end()]); }
});
