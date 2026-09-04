import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import test from "node:test";
import { sql } from "drizzle-orm";
import { WebSocket, WebSocketServer } from "ws";

// Import the built runtime only after selecting the actual worker pool profile.
process.env.SCHEDULER_ENABLED = "true";
process.env.DB_POOL_MAX = "20";
process.env.RLS_GUC_ENABLED = "true";
process.env.REDIS_URL = "";
process.env.CLASSPILOT_PROTOCOL_V3_ENABLED = "true";
process.env.CLASSPILOT_CAP_SCREENSHOT_ACTIVE_OBSERVATION_CADENCE_V1 = "true";
delete process.env.CLASSPILOT_CAPABILITY_ROLLOUTS_JSON;

type Frame = {
  type: string;
  exactBinding?: { schoolId: string; studentId: string; studentSessionId: string; deviceId: string };
  data?: { activeSessionIds?: string[] };
};

test("ten bell-time ends drain with two worker clients, scoped frames, and refresh outside leases", { timeout: 90_000 }, async (t) => {
  const { default: db, pool, sessionPool } = await import("../dist/db.js");
  const storage = await import("../dist/services/storage.js");
  const lifecycle = await import("../dist/services/classpilotSessionLifecycle.js");
  const pushes = await import("../dist/services/classpilotLifecyclePushes.js");
  const { schedulerDb, schedulerPool, schedulerLockPool } = await import("../dist/services/schedulerDb.js");
  const { runWithTenantContext } = await import("../dist/middleware/tenantContext.js");
  const broadcast = await import("../dist/realtime/ws-broadcast.js");
  const runtime = await import("../dist/services/runtimePerformanceMetrics.js");
  const hotPath = await import("../dist/services/heartbeatHotPathMetrics.js");
  const monitor = (await import("../dist/services/errorMonitor.js")).default;
  const tag = `lifecycle_pool_${randomUUID().replaceAll("-", "")}`;
  const schoolIds: string[] = [];
  const sessions: Array<{ schoolId: string; id: string }> = [];
  const connections: Array<{ client: WebSocket; server: WebSocket; frames: Frame[]; binding: NonNullable<Frame["exactBinding"]> }> = [];
  const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(wss, "listening");
  const address = wss.address();
  assert.ok(address && typeof address !== "string");

  try {
    assert.equal(pool.options.max, 2, "the environment must not bypass the worker role cap");
    const identity = await pool.query<{ bypass: boolean }>("SELECT rolsuper OR rolbypassrls AS bypass FROM pg_roles WHERE rolname = current_user");
    if (process.env.RLS_TEST_ROLE) assert.equal(identity.rows[0]!.bypass, false, "the RLS lane must use its restricted application role");
    if (!identity.rows[0]!.bypass) {
      const enforced = await pool.query<{ relname: string; enabled: boolean; forced: boolean }>(`
        SELECT relname, relrowsecurity AS enabled, relforcerowsecurity AS forced
        FROM pg_class WHERE oid = ANY(ARRAY[
          'classpilot_session_students'::regclass, 'classpilot_student_control_states'::regclass,
          'classpilot_classroom_states'::regclass, 'teaching_sessions'::regclass
        ]) ORDER BY relname
      `);
      assert.equal(enforced.rows.length, 4);
      for (const table of enforced.rows) assert.ok(table.enabled && table.forced, `${table.relname} must enforce forced RLS`);
    }
    for (let schoolIndex = 0; schoolIndex < 2; schoolIndex++) {
      const school = await storage.createSchool({ name: `${tag}_${schoolIndex}`, slug: `${tag}_${schoolIndex}`, domain: `${tag}.example.edu` });
      schoolIds.push(school.id);
      const teacher = await storage.createUser({ email: `teacher${schoolIndex}@${tag}.example.edu`, firstName: "Pool", lastName: "Teacher" });
      await storage.createMembership({ schoolId: school.id, userId: teacher.id, role: "teacher", status: "active" });
      await storage.createProductLicense({ schoolId: school.id, product: "CLASSPILOT", status: "active" });
      for (let classIndex = 0; classIndex < 5; classIndex++) {
        const session = await runWithTenantContext({ schoolId: school.id }, async () => {
          const group = await storage.createGroup({ schoolId: school.id, teacherId: teacher.id, name: `${tag}_${schoolIndex}_${classIndex}`, groupType: "teacher_created" });
          for (let studentIndex = 0; studentIndex < 2; studentIndex++) {
            const student = await storage.createStudent({ schoolId: school.id, firstName: `Student${classIndex}`, lastName: `${studentIndex}`, status: "active" });
            await db.execute(sql`INSERT INTO group_students (group_id, student_id) VALUES (${group.id}, ${student.id})`);
            const deviceId = `${tag}_${schoolIndex}_${classIndex}_${studentIndex}`;
            await storage.createDevice({ deviceId, schoolId: school.id, classId: "default" });
            await storage.linkStudentDevice({ studentId: student.id, deviceId });
            const active = await storage.setActiveStudentForDevice(deviceId, student.id);
            const accepted = once(wss, "connection");
            const client = new WebSocket(`ws://127.0.0.1:${address.port}`);
            const frames: Frame[] = [];
            client.on("message", (data) => frames.push(JSON.parse(data.toString()) as Frame));
            await once(client, "open");
            const [server] = await accepted;
            const binding = { schoolId: school.id, studentId: student.id, studentSessionId: active.id, deviceId };
            broadcast.registerWsClient(server);
            broadcast.authenticateWsClient(server, { ...binding, role: "student", acceptedCapabilities: ["screenshotActiveObservationCadenceV1"] });
            connections.push({ client, server, frames, binding });
          }
          return storage.createTeachingSession({ groupId: group.id, teacherId: teacher.id, startTime: new Date(Date.now() - 60_000) });
        });
        sessions.push({ schoolId: school.id, id: session.id });
      }
    }
    runtime.snapshotRuntimePerformanceMetrics({ reset: true });
    hotPath.snapshotHeartbeatHotPathMetrics({ reset: true });
    const before = pushes.snapshotClasspilotLifecyclePushes();
    // Scheduler DB finalization releases its own transaction before queue work;
    // this mirrors the ten-session production batch rather than holding ten
    // artificial request leases around the finalizer.
    const results = await Promise.all(sessions.map((session) => lifecycle.finalizeClasspilotSession({
      schoolId: session.schoolId, sessionId: session.id, reason: "scheduled_end", dbInstance: schedulerDb,
    })));
    assert.ok(results.every((result) => result?.finalized && result.clearedControlStates.length === 2));
    await pushes.flushClasspilotLifecyclePushes();
    // Deliver the final local WebSocket writes before asserting their frames.
    await new Promise((resolve) => setTimeout(resolve, 50));
    const after = pushes.snapshotClasspilotLifecyclePushes();
    assert.equal(after.completed - before.completed, 10);
    assert.equal(after.failed - before.failed, 0);
    assert.equal(after.deferred - before.deferred, 0);
    assert.equal(after.active + after.waiting, 0);
    assert.equal(runtime.snapshotRuntimePerformanceMetrics().counters.poolAcquisitionFailure ?? 0, 0);
    const refresh = hotPath.snapshotHeartbeatHotPathMetrics().counters;
    assert.ok((refresh.screenshotPolicyRefreshSignals ?? 0) >= 10, "enabled refresh must execute its real tenant read");
    assert.equal(refresh.screenshotPolicyRefreshFailures ?? 0, 0);
    for (const connection of connections) {
      assert.ok(connection.frames.some((frame) => frame.type === "classroom-state"));
      const fab = connection.frames.filter((frame) => frame.type === "fab-state-sync");
      assert.ok(fab.length > 0);
      assert.deepEqual(fab.at(-1)?.data?.activeSessionIds, []);
      for (const frame of connection.frames) {
        if (frame.exactBinding) {
          const { schoolId, studentId, studentSessionId, deviceId } = frame.exactBinding;
          assert.deepEqual({ schoolId, studentId, studentSessionId, deviceId }, connection.binding);
        }
      }
    }
    assert.equal(pool.waitingCount, 0);
    assert.equal(pool.totalCount, pool.idleCount, "every worker tenant lease was released");

    // Delay an old end notification until its originating request is gone,
    // another class owns the students, and one student has moved devices.
    const oldResult = results[0];
    assert.ok(oldResult?.finalized);
    const replacement = await runWithTenantContext({ schoolId: oldResult.session.schoolId! }, () =>
      storage.createTeachingSession({ groupId: oldResult.session.groupId, teacherId: oldResult.session.teacherId })
    );
    const transferred = connections.find((connection) => connection.binding.studentId === oldResult.clearedControlStates[0]!.studentId);
    assert.ok(transferred);
    const newDeviceId = `${tag}_replacement_device`;
    const newSession = await runWithTenantContext({ schoolId: transferred.binding.schoolId }, async () => {
      await storage.createDevice({ deviceId: newDeviceId, schoolId: transferred.binding.schoolId, classId: "default" });
      await storage.linkStudentDevice({ studentId: transferred.binding.studentId, deviceId: newDeviceId });
      return storage.setActiveStudentForDevice(newDeviceId, transferred.binding.studentId);
    });
    const accepted = once(wss, "connection");
    const movedClient = new WebSocket(`ws://127.0.0.1:${address.port}`);
    const movedFrames: Frame[] = [];
    movedClient.on("message", (data) => movedFrames.push(JSON.parse(data.toString()) as Frame));
    await once(movedClient, "open");
    const [movedServer] = await accepted;
    const movedBinding = { ...transferred.binding, studentSessionId: newSession.id, deviceId: newDeviceId };
    broadcast.registerWsClient(movedServer);
    broadcast.authenticateWsClient(movedServer, { ...movedBinding, role: "student", acceptedCapabilities: ["screenshotActiveObservationCadenceV1"] });
    connections.push({ client: movedClient, server: movedServer, frames: movedFrames, binding: movedBinding });
    let releaseBlocker!: () => void;
    const blocker = new Promise<void>((resolve) => { releaseBlocker = resolve; });
    const blockedPush = pushes.classpilotLifecyclePushes.enqueue(async () => blocker);
    const oldFrameCount = transferred.frames.length;
    try {
      await runWithTenantContext({ schoolId: schoolIds[1] }, async () => {
        lifecycle.runClasspilotFinalizationSideEffects(oldResult, { schoolId: oldResult.session.schoolId!, reason: "scheduled_end" });
      });
      assert.equal(pool.totalCount, pool.idleCount, "originating request lease is released while delivery is queued");
    } finally { releaseBlocker(); }
    await blockedPush;
    await pushes.flushClasspilotLifecyclePushes();
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(transferred.frames.length, oldFrameCount, "the displaced device must receive no delayed authority frame");
    assert.equal(movedFrames.some((frame) => frame.type === "classroom-state"), false, "stale clear revision must be skipped");
    const freshFab = movedFrames.filter((frame) => frame.type === "fab-state-sync").at(-1);
    assert.ok(freshFab);
    assert.deepEqual(freshFab.data?.activeSessionIds, [replacement.id], "recomputed FAB retains the replacement class");
    assert.equal(freshFab.exactBinding?.studentSessionId, newSession.id);
    assert.equal(freshFab.exactBinding?.schoolId, oldResult.session.schoolId);

    if (!identity.rows[0]!.bypass) {
      await runWithTenantContext({ schoolId: schoolIds[0] }, async () => {
        assert.deepEqual(await storage.getClasspilotSessionStudents(sessions[5]!.id), [], "foreign frozen roster is deny-hidden by RLS");
      });
    } else {
      t.diagnostic("Worker pool and frame assertions passed; the restricted RLS lane additionally checks deny-hidden foreign rosters.");
    }
  } finally {
    await pushes.flushClasspilotLifecyclePushes();
    for (const connection of connections) {
      broadcast.removeWsClient(connection.server);
      connection.client.terminate();
      connection.server.terminate();
    }
    await new Promise<void>((resolve) => wss.close(() => resolve()));
    try {
      for (const schoolId of schoolIds) {
        // Staff-integrity constraints validate at commit, after both the
        // relationships and their groups have been removed. Retain school
        // and user lifecycle roots, as required by the migrated DB guards.
        await runWithTenantContext({ isSuper: true }, () => db.transaction(async (tx) => {
          for (const table of [
            "classpilot_session_summary_deliveries", "classpilot_monitoring_events", "classpilot_session_student_reports",
            "classpilot_session_reports", "classpilot_session_staff", "classpilot_student_control_states",
            "classpilot_classroom_states", "classpilot_active_hands", "classpilot_session_students",
          ]) await tx.execute(sql`DELETE FROM ${sql.identifier(table)} WHERE school_id = ${schoolId}`);
          await tx.execute(sql`DELETE FROM session_settings WHERE session_id IN (SELECT id FROM teaching_sessions WHERE school_id = ${schoolId})`);
          await tx.execute(sql`DELETE FROM teaching_sessions WHERE school_id = ${schoolId}`);
          await tx.execute(sql`DELETE FROM student_sessions WHERE student_id IN (SELECT id FROM students WHERE school_id = ${schoolId})`);
          await tx.execute(sql`DELETE FROM student_devices WHERE student_id IN (SELECT id FROM students WHERE school_id = ${schoolId})`);
          await tx.execute(sql`DELETE FROM group_students WHERE group_id IN (SELECT id FROM groups WHERE school_id = ${schoolId})`);
          await tx.execute(sql`DELETE FROM group_teachers WHERE group_id IN (SELECT id FROM groups WHERE school_id = ${schoolId})`);
          for (const table of ["devices", "groups", "students", "audit_logs", "settings", "product_licenses", "school_memberships"]) {
            await tx.execute(sql`DELETE FROM ${sql.identifier(table)} WHERE school_id = ${schoolId}`);
          }
          await tx.execute(sql`UPDATE schools SET status = 'suspended', is_active = false, deleted_at = now() WHERE id = ${schoolId}`);
        }));
      }
    } finally {
      await monitor.disposeAndWait();
      runtime.stopRuntimePerformanceMetrics();
      await Promise.all([pool.end(), sessionPool.end(), schedulerPool.end(), schedulerLockPool.end()]);
    }
  }
});
