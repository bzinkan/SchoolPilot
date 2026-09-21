import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { after, before, describe, it } from "node:test";
import { sql } from "drizzle-orm";
import { WebSocket, WebSocketServer } from "ws";

process.env.REDIS_URL = "";

type Frame = { type: string; data?: { activeSessionIds?: string[]; messagingEnabled?: boolean } };

const tag = `fab_sync_${randomUUID().replaceAll("-", "")}`;
let db: typeof import("../src/db.js").default;
let pool: import("pg").Pool;
let storage: typeof import("../src/services/storage.js");
let lifecycle: typeof import("../src/services/classpilotSessionLifecycle.js");
let pushes: typeof import("../src/services/classpilotLifecyclePushes.js");
let broadcast: typeof import("../src/realtime/ws-broadcast.js");
let runtime: typeof import("../src/services/runtimePerformanceMetrics.js");
let pending: typeof import("../src/services/classpilotFabSyncPending.js");
let runWithTenantContext: typeof import("../src/middleware/tenantContext.js").runWithTenantContext;
let schoolId = "";
let teacherId = "";
let groupId = "";
const students: Array<{ studentId: string; deviceId: string; studentSessionId: string }> = [];
const sessionIds: string[] = [];

before(async () => {
  ({ default: db, pool } = await import("../src/db.js"));
  storage = await import("../src/services/storage.js");
  lifecycle = await import("../src/services/classpilotSessionLifecycle.js");
  pushes = await import("../src/services/classpilotLifecyclePushes.js");
  broadcast = await import("../src/realtime/ws-broadcast.js");
  runtime = await import("../src/services/runtimePerformanceMetrics.js");
  pending = await import("../src/services/classpilotFabSyncPending.js");
  ({ runWithTenantContext } = await import("../src/middleware/tenantContext.js"));
  const school = await storage.createSchool({ name: tag, slug: tag, domain: `${tag}.example.edu` });
  schoolId = school.id;
  const teacher = await storage.createUser({ email: `teacher@${tag}.example.edu`, firstName: "Fab", lastName: "Teacher" });
  teacherId = teacher.id;
  await storage.createMembership({ schoolId, userId: teacherId, role: "teacher", status: "active" });
  await storage.createProductLicense({ schoolId, product: "CLASSPILOT", status: "active" });
  await runWithTenantContext({ schoolId }, async () => {
    const group = await storage.createGroup({ schoolId, teacherId, name: tag, groupType: "teacher_created" });
    groupId = group.id;
    for (let index = 0; index < 2; index += 1) {
      const student = await storage.createStudent({ schoolId, firstName: "Fab", lastName: `Student${index}`, status: "active" });
      await db.execute(sql`INSERT INTO group_students (group_id, student_id) VALUES (${groupId}, ${student.id})`);
      const deviceId = `${tag}_${index}`;
      await storage.createDevice({ deviceId, schoolId, classId: "default" });
      await storage.linkStudentDevice({ studentId: student.id, deviceId });
      const active = await storage.setActiveStudentForDevice(deviceId, student.id);
      students.push({ studentId: student.id, deviceId, studentSessionId: active.id });
    }
  });
});

after(async () => {
  for (const sessionId of sessionIds) {
    try {
      await lifecycle.finalizeClasspilotSession({ schoolId, sessionId, reason: "manual_end" });
    } catch {
      // Best effort; the school is deleted below.
    }
  }
  await pushes.flushClasspilotLifecyclePushes().catch(() => undefined);
  await pool.query("DELETE FROM schools WHERE id = $1", [schoolId]).catch(() => undefined);
  const { sessionPool } = await import("../src/db.js");
  await Promise.all([pool.end(), sessionPool.end()]);
});

function captureWarnings(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => { lines.push(args.map(String).join(" ")); };
  return { lines, restore: () => { console.warn = original; } };
}

describe("class-start FAB delivery misses", () => {
  it("flags every device without a socket so its next heartbeat carries the FAB state, and logs ids only", async () => {
    pending.resetClasspilotFabSyncPendingForTests();
    runtime.snapshotRuntimePerformanceMetrics({ reset: true });
    const warnings = captureWarnings();
    let session: { id: string } | undefined;
    try {
      session = await runWithTenantContext({ schoolId }, () => storage.createTeachingSession({
        groupId, teacherId, startTime: new Date(Date.now() - 60_000),
      }));
      sessionIds.push(session.id);
      await lifecycle.publishClasspilotSessionFabStates({ schoolId, teachingSessionId: session.id, event: "started" });
    } finally {
      warnings.restore();
    }
    assert.ok(session);
    for (const student of students) {
      const binding = { schoolId, studentId: student.studentId, studentSessionId: student.studentSessionId, deviceId: student.deviceId };
      assert.equal(await pending.takeClasspilotFabSyncPending(binding), true, "the miss is flagged once");
      assert.equal(await pending.takeClasspilotFabSyncPending(binding), false, "the flag is consumed by the take");
    }
    const missLines = warnings.lines.filter((line) => line.includes("fab-state-sync missed local socket"));
    assert.equal(missLines.length, students.length);
    for (const line of missLines) {
      assert.match(line, new RegExp(`school=${schoolId} student=[0-9a-f-]+ studentSession=[0-9a-f-]+ device=${tag}_[01] teachingSession=${session.id} supervisionContext=none reason=control_ownership_transition pending=local relay=unavailable$`));
      assert.doesNotMatch(line, /Student|Fab Teacher|example\.edu/);
    }
    const counters = runtime.snapshotRuntimePerformanceMetrics({ reset: true }).counters as Record<string, number>;
    assert.equal(counters.fabSyncLocalDeliveryMissed, students.length);
    assert.equal(counters.fabSyncPendingMarkFallback, students.length);
  });

  it("does not flag a device whose socket received the frame, and clears a stale flag for it", async () => {
    pending.resetClasspilotFabSyncPendingForTests();
    const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await once(wss, "listening");
    const address = wss.address();
    assert.ok(address && typeof address !== "string");
    const connected = students[0]!;
    const offline = students[1]!;
    const connectedBinding = { schoolId, studentId: connected.studentId, studentSessionId: connected.studentSessionId, deviceId: connected.deviceId };
    const offlineBinding = { schoolId, studentId: offline.studentId, studentSessionId: offline.studentSessionId, deviceId: offline.deviceId };
    const accepted = once(wss, "connection");
    const client = new WebSocket(`ws://127.0.0.1:${address.port}`);
    const frames: Frame[] = [];
    client.on("message", (data) => frames.push(JSON.parse(data.toString()) as Frame));
    await once(client, "open");
    const [server] = await accepted;
    broadcast.registerWsClient(server);
    broadcast.authenticateWsClient(server, { ...connectedBinding, role: "student", acceptedCapabilities: [] });
    // A flag left over from an earlier miss must not survive a successful send.
    await pending.markClasspilotFabSyncPending(connectedBinding);
    const warnings = captureWarnings();
    try {
      const session = await runWithTenantContext({ schoolId }, () => storage.createTeachingSession({
        groupId, teacherId, startTime: new Date(Date.now() - 60_000),
      }));
      sessionIds.push(session.id);
      await lifecycle.publishClasspilotSessionFabStates({ schoolId, teachingSessionId: session.id, event: "started" });
      await new Promise((resolve) => setTimeout(resolve, 50));
    } finally {
      warnings.restore();
      client.close();
      server.close();
      wss.close();
    }
    assert.ok(frames.some((frame) => frame.type === "fab-state-sync"), "the connected device received the frame");
    assert.equal(await pending.takeClasspilotFabSyncPending(connectedBinding), false, "a delivered device is never flagged");
    assert.equal(await pending.takeClasspilotFabSyncPending(offlineBinding), true, "the device without a socket is flagged");
    const missLines = warnings.lines.filter((line) => line.includes("fab-state-sync missed local socket"));
    assert.equal(missLines.length, 1);
    assert.match(missLines[0]!, new RegExp(`device=${offline.deviceId} `));
  });
});
