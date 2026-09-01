import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { and, eq, sql } from "drizzle-orm";
import { Client } from "pg";
import { WebSocket as WebSocketClient, WebSocketServer } from "ws";

process.env.NODE_ENV = "test";
process.env.SCHEDULER_ENABLED = "true";
process.env.REDIS_URL = "";
process.env.CLASSPILOT_MANUAL_SHARED_SESSION_ISSUANCE_ENABLED = "true";
process.env.CLASSPILOT_PROTOCOL_V3_ENABLED = "true";
process.env.CLASSPILOT_CAP_SCOPED_AUTHORITY_CHECKS_V1 = "true";
process.env.CLASSPILOT_CAP_KIOSK_LAUNCH_TICKET_V2 = "true";
process.env.CLASSPILOT_CAP_STUDENT_AUTH_GATE_PRESENCE_V1 = "true";

const { default: db, pool, sessionPool } = await import("../dist/db.js");
const { runWithTenantContext } = await import(
  "../dist/middleware/tenantContext.js"
);
const storage = await import("../dist/services/storage.js");
const schema = await import("../dist/schema/index.js");
const recoveryAuthority = await import(
  "../dist/services/classpilotStudentSessionAuthority.js"
);
const studentAuth = await import("../dist/services/classpilotStudentAuth.js");
const { createStudentToken, verifyStudentToken } = await import("../dist/services/deviceJwt.js");
const { signUserToken } = await import("../dist/services/jwt.js");
const websocket = await import("../dist/realtime/websocket.js");
const lifecycle = await import(
  "../dist/services/classpilotStudentSessionLifecycle.js"
);
const heartbeatMetrics = await import(
  "../dist/services/heartbeatHotPathMetrics.js"
);
const managedDeviceContinuity = await import(
  "../dist/services/classpilotManagedDeviceContinuity.js"
);
const authGatePresence = await import(
  "../dist/services/classpilotStudentAuthGatePresence.js"
);
const studentSessionTransfer = await import(
  "../dist/services/classpilotStudentSessionTransfer.js"
);
const commandDispatcher = await import(
  "../dist/services/classpilotCommandDispatcher.js"
);
const classpilotDeviceRoutes = await import("../dist/routes/classpilot/devices.js");
const websocketBroadcast = await import("../dist/realtime/ws-broadcast.js");
const { classpilotScreenshotFallback } = await import(
  "../dist/services/classpilotScreenshotFallback.js"
);
const websocketRedis = await import("../dist/realtime/ws-redis.js");
const { classBoundScreenshotBindingVersion } = websocketRedis;
const { validateClasspilotScreenshotCapturedAt } = await import(
  "../dist/services/classpilotScreenshotPolicy.js"
);
const { hashPassword } = await import("../dist/util/password.js");
const { schedulerPool } = await import("../dist/services/schedulerDb.js");

const {
  createDevice,
  createSchool,
  createStudent,
  startStudentSessionWithReplacements,
} = storage;
const {
  devices,
  classpilotSessionStaff,
  classpilotSessionStudents,
  classpilotChatDeliveries,
  classpilotStudentControlStates,
  chatMessages,
  groupStudents,
  groupTeachers,
  groups,
  heartbeats,
  productLicenses,
  schoolMemberships,
  schools,
  studentDevices,
  studentSessions,
  students,
  teachingSessions,
  users,
} = schema;
const {
  createStudentSessionRecovery,
  hashStudentSessionRecoveryToken,
} = recoveryAuthority;

const tag = `student-session-recovery-${Date.now()}-${randomUUID().slice(0, 8)}`;
let schoolId = "";
let studentId = "";
let reaperStudentId = "";
let foreignSchoolId = "";
let foreignStudentId = "";
const originalDeviceId = `${tag}-original`;
const blockedDeviceId = `${tag}-blocked`;

const inSchool = <T>(fn: () => Promise<T>): Promise<T> =>
  runWithTenantContext({ schoolId }, fn);

async function assertExactDeliverySerializedWithTransfer(
  surface: "state-request" | "heartbeat-response" | "login-response"
): Promise<void> {
  const suffix = `${surface}-${randomUUID().slice(0, 8)}`;
  const transferDeviceId = `${tag}-${suffix}`;
  await inSchool(() => createDevice({
    deviceId: transferDeviceId,
    deviceName: `${surface} transfer device`,
    schoolId,
    classId: schoolId,
  } as Parameters<typeof createDevice>[0]));
  const sourceStudent = await inSchool(() => createStudent({
    schoolId,
    firstName: "Delivery",
    lastName: "Source",
    email: `${suffix}-source@${tag}.example.edu`,
    emailLc: `${suffix}-source@${tag}.example.edu`,
    status: "active",
  } as Parameters<typeof createStudent>[0]));
  const destinationStudent = await inSchool(() => createStudent({
    schoolId,
    firstName: "Delivery",
    lastName: "Destination",
    email: `${suffix}-destination@${tag}.example.edu`,
    emailLc: `${suffix}-destination@${tag}.example.edu`,
    status: "active",
  } as Parameters<typeof createStudent>[0]));
  const sourceRecovery = createStudentSessionRecovery();
  const sourceSession = await inSchool(() => startStudentSessionWithReplacements(
    schoolId,
    sourceStudent.id,
    transferDeviceId,
    {
      authKind: "manual_shared",
      sessionRecoveryTokenHash: sourceRecovery.tokenHash,
    }
  ));

  let releasePreparation!: () => void;
  const preparationMayFinish = new Promise<void>((resolve) => {
    releasePreparation = resolve;
  });
  let authorityLocked!: () => void;
  const deliveryHasAuthority = new Promise<void>((resolve) => {
    authorityLocked = resolve;
  });
  const ordering: string[] = [];
  const exactBinding = {
    schoolId,
    studentId: sourceStudent.id,
    studentSessionId: sourceSession.session.id,
    deviceId: transferDeviceId,
  };
  const prepareDelivery = async () => {
    ordering.push(`${surface}-prepared`);
    authorityLocked();
    await preparationMayFinish;
    return { revision: 7 };
  };
  const sendDelivery = (prepared: { revision: number }) => {
    assert.equal(prepared.revision, 7);
    ordering.push(`${surface}-delivered`);
    return prepared.revision;
  };
  const delivery = surface === "login-response"
    ? inSchool(() => classpilotDeviceRoutes.withClasspilotStudentLoginResponseAuthority(
        exactBinding,
        prepareDelivery,
        sendDelivery
      ))
    : inSchool(() => storage.withClasspilotStudentControlDeliveryAuthority(
        exactBinding,
        prepareDelivery,
        (_claimed, prepared) => sendDelivery(prepared)
      ));
  await deliveryHasAuthority;

  const lockProbe = new Client({ connectionString: process.env.DATABASE_URL });
  await lockProbe.connect();
  let transfer:
    | ReturnType<typeof startStudentSessionWithReplacements>
    | undefined;
  let transferSettled = false;
  try {
    transfer = inSchool(() => startStudentSessionWithReplacements(
      schoolId,
      destinationStudent.id,
      transferDeviceId,
      {
        authKind: "manual_shared",
        sessionRecoveryTokenHash: createStudentSessionRecovery().tokenHash,
        reclaimRecoveryTokenHash: sourceRecovery.tokenHash,
      }
    ));
    void transfer.then(() => {
      transferSettled = true;
      ordering.push("transfer-completed");
    }, () => {
      transferSettled = true;
    });

    const authorityLockKey =
      `classpilot:student-control:${schoolId}:${sourceStudent.id}`;
    let waitingTransferCount = 0;
    const waitDeadline = Date.now() + 5_000;
    while (waitingTransferCount === 0 && Date.now() < waitDeadline) {
      const lockSnapshot = await lockProbe.query(`
        WITH requested_lock AS (
          SELECT hashtextextended($1, 0::bigint) AS value
        )
        SELECT count(*) FILTER (WHERE lock_row.granted = false)::integer AS "waitingCount"
        FROM pg_locks AS lock_row
        CROSS JOIN requested_lock
        WHERE lock_row.locktype = 'advisory'
          AND lock_row.objsubid = 1
          AND lock_row.classid::bigint =
            ((requested_lock.value >> 32) & 4294967295::bigint)
          AND lock_row.objid::bigint =
            (requested_lock.value & 4294967295::bigint)
      `, [authorityLockKey]);
      waitingTransferCount = Number(lockSnapshot.rows[0]?.waitingCount ?? 0);
      if (waitingTransferCount === 0) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
    assert.equal(
      waitingTransferCount,
      1,
      `${surface} transfer must wait on the response delivery authority lock`
    );
    assert.equal(
      transferSettled,
      false,
      `${surface} transfer must not commit before synchronous response delivery`
    );

    releasePreparation();
    const [deliveryResult, transferResult] = await Promise.all([delivery, transfer]);
    if (surface === "login-response") {
      assert.equal(deliveryResult, 7);
    } else {
      assert.deepEqual(deliveryResult, { authorized: true, value: 7 });
    }
    assert.equal(transferResult.crossStudentHandoff, true);
    assert.deepEqual(ordering, [
      `${surface}-prepared`,
      `${surface}-delivered`,
      "transfer-completed",
    ]);
    assert.equal(
      await inSchool(() => storage.getActiveSessionById(sourceSession.session.id)),
      undefined
    );
    assert.equal(
      (await inSchool(() => storage.getActiveSessionById(transferResult.session.id)))
        ?.studentId,
      destinationStudent.id
    );
  } finally {
    releasePreparation();
    await Promise.allSettled([
      delivery,
      ...(transfer ? [transfer] : []),
    ]);
    await lockProbe.end();
    const activeSessions = await inSchool(() => storage.getActiveSessionsForStudents(
      schoolId,
      [sourceStudent.id, destinationStudent.id]
    ));
    for (const active of activeSessions) {
      await inSchool(() => storage.endStudentSessionExact({
        schoolId,
        studentId: active.studentId,
        deviceId: active.deviceId,
        studentSessionId: active.id,
      }));
    }
    await inSchool(() => storage.deleteDeviceWithEndedSessions(
      schoolId,
      transferDeviceId
    ));
  }
}

before(async () => {
  const school = await createSchool({
    name: tag,
    domain: `${tag}.example.edu`,
    slug: tag,
    status: "active",
    planStatus: "active",
  } as Parameters<typeof createSchool>[0]);
  schoolId = school.id;
  await storage.createProductLicense({
    schoolId,
    product: "CLASSPILOT",
    status: "active",
  } as Parameters<typeof storage.createProductLicense>[0]);

  await inSchool(async () => {
    const student = await createStudent({
      schoolId,
      firstName: "Recovery",
      lastName: "Student",
      email: `${tag}@${tag}.example.edu`,
      emailLc: `${tag}@${tag}.example.edu`,
      status: "active",
    } as Parameters<typeof createStudent>[0]);
    studentId = student.id;
    await createDevice({
      deviceId: originalDeviceId,
      deviceName: "Original device",
      schoolId,
      classId: schoolId,
    } as Parameters<typeof createDevice>[0]);
    await createDevice({
      deviceId: blockedDeviceId,
      deviceName: "Blocked device",
      schoolId,
      classId: schoolId,
    } as Parameters<typeof createDevice>[0]);
  });
});

after(async () => {
  try {
    await runWithTenantContext({ isSuper: true }, async () => {
      await db.delete(heartbeats).where(eq(heartbeats.schoolId, schoolId));
      await db.execute(sql`
        DELETE FROM student_sessions
        WHERE student_id IN (SELECT id FROM students WHERE school_id = ${schoolId})
      `);
      await db.execute(sql`
        DELETE FROM student_devices
        WHERE student_id IN (SELECT id FROM students WHERE school_id = ${schoolId})
      `);
      await db.delete(devices).where(eq(devices.schoolId, schoolId));
      await db.delete(students).where(eq(students.schoolId, schoolId));
      await db.delete(productLicenses).where(eq(productLicenses.schoolId, schoolId));
      await db.delete(schools).where(eq(schools.id, schoolId));
      if (foreignStudentId) {
        await db.delete(studentSessions).where(eq(studentSessions.studentId, foreignStudentId));
        await db.delete(students).where(eq(students.id, foreignStudentId));
      }
      if (foreignSchoolId) {
        await db.delete(schools).where(eq(schools.id, foreignSchoolId));
      }
    });
  } finally {
    await Promise.allSettled([pool.end(), sessionPool.end(), schedulerPool.end()]);
  }
});

describe("ClassPilot manual-session recovery authority", () => {
  it("serializes a login response send before correct-PIN transfer", async () => {
    await assertExactDeliverySerializedWithTransfer("login-response");
  });

  it("serializes a WebSocket classroom-state request send before correct-PIN transfer", async () => {
    await assertExactDeliverySerializedWithTransfer("state-request");
  });

  it("serializes a heartbeat classroom-state response before correct-PIN transfer", async () => {
    await assertExactDeliverySerializedWithTransfer("heartbeat-response");
  });

  it("lets transfer win between persistent command state and exact local or Redis delivery", async () => {
    const suffix = `persistent-command-transfer-${randomUUID().slice(0, 8)}`;
    const transferDeviceId = `${tag}-${suffix}`;
    const teacher = await storage.createUser({
      email: `${suffix}-teacher@${tag}.example.edu`,
      firstName: "Command",
      lastName: "Teacher",
    } as Parameters<typeof storage.createUser>[0]);
    await inSchool(() => storage.createMembership({
      userId: teacher.id,
      schoolId,
      role: "teacher",
      status: "active",
    } as Parameters<typeof storage.createMembership>[0]));
    const sourceStudent = await inSchool(() => createStudent({
      schoolId,
      firstName: "Command",
      lastName: "Source",
      email: `${suffix}-source@${tag}.example.edu`,
      emailLc: `${suffix}-source@${tag}.example.edu`,
      status: "active",
    } as Parameters<typeof createStudent>[0]));
    const destinationStudent = await inSchool(() => createStudent({
      schoolId,
      firstName: "Command",
      lastName: "Destination",
      email: `${suffix}-destination@${tag}.example.edu`,
      emailLc: `${suffix}-destination@${tag}.example.edu`,
      status: "active",
    } as Parameters<typeof createStudent>[0]));
    await inSchool(() => createDevice({
      deviceId: transferDeviceId,
      deviceName: "Persistent command transfer fixture",
      schoolId,
      classId: schoolId,
    } as Parameters<typeof createDevice>[0]));
    const group = await inSchool(() => storage.createGroup({
      schoolId,
      teacherId: teacher.id,
      name: `${suffix} class`,
      groupType: "admin_class",
      status: "active",
    } as Parameters<typeof storage.createGroup>[0]));
    await inSchool(() => db.insert(groupStudents).values({
      groupId: group.id,
      studentId: sourceStudent.id,
    }));
    const teachingSession = await inSchool(() => storage.createTeachingSession({
      groupId: group.id,
      teacherId: teacher.id,
      sessionMode: "live",
    } as Parameters<typeof storage.createTeachingSession>[0]));
    const sourceControl = await inSchool(() =>
      storage.getClasspilotStudentControlState(schoolId, sourceStudent.id)
    );
    assert.equal(sourceControl?.teachingSessionId, teachingSession.id);
    const sourceRecovery = createStudentSessionRecovery();
    const sourceSession = await inSchool(() => startStudentSessionWithReplacements(
      schoolId,
      sourceStudent.id,
      transferDeviceId,
      {
        authKind: "manual_shared",
        sessionRecoveryTokenHash: sourceRecovery.tokenHash,
      }
    ));

    const socketServer = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await once(socketServer, "listening");
    const socketAddress = socketServer.address();
    assert.ok(socketAddress && typeof socketAddress !== "string");
    const serverSocketConnected = once(socketServer, "connection");
    const clientSocket = new WebSocketClient(`ws://127.0.0.1:${socketAddress.port}`);
    const clientMessages: string[] = [];
    clientSocket.on("message", (data) => clientMessages.push(data.toString()));
    await once(clientSocket, "open");
    const [serverSocket] = await serverSocketConnected;
    websocketBroadcast.registerWsClient(serverSocket);
    websocketBroadcast.authenticateWsClient(serverSocket, {
      role: "student",
      schoolId,
      studentId: sourceStudent.id,
      studentSessionId: sourceSession.session.id,
      deviceId: transferDeviceId,
    });

    const blocker = new Client({ connectionString: process.env.DATABASE_URL });
    await blocker.connect();
    let blockerOpen = false;
    let command:
      | ReturnType<typeof commandDispatcher.executeClasspilotCommand>
      | undefined;
    let transfer:
      | ReturnType<typeof startStudentSessionWithReplacements>
      | undefined;
    try {
      await blocker.query("BEGIN");
      blockerOpen = true;
      const locked = await blocker.query(`
        SELECT id
        FROM classpilot_student_control_states
        WHERE school_id = $1 AND student_id = $2
        FOR UPDATE
      `, [schoolId, sourceStudent.id]);
      assert.equal(locked.rowCount, 1);
      const blockerPid = Number(
        (await blocker.query("SELECT pg_backend_pid() AS pid")).rows[0]?.pid
      );
      assert.equal(Number.isSafeInteger(blockerPid), true);

      let commandSettled = false;
      command = inSchool(() => commandDispatcher.executeClasspilotCommand({
        schoolId,
        actorId: teacher.id,
        teachingSessionId: teachingSession.id,
        targetScope: "students",
        commandType: "lock-screen",
        rawCommandPayload: { url: "https://example.edu/persistence-transfer-race" },
        targets: [{
          studentId: sourceStudent.id,
          studentName: "Command Source",
          studentSessionId: sourceSession.session.id,
          deviceId: transferDeviceId,
          available: true,
          stateAuthorized: true,
        }],
      }));
      void command.then(
        () => { commandSettled = true; },
        () => { commandSettled = true; }
      );

      let persistenceWaitingCount = 0;
      const persistenceDeadline = Date.now() + 5_000;
      while (persistenceWaitingCount === 0 && Date.now() < persistenceDeadline) {
        const snapshot = await blocker.query(`
          SELECT count(*)::integer AS "waitingCount"
          FROM pg_stat_activity AS waiter
          WHERE $1::integer = ANY(pg_blocking_pids(waiter.pid))
        `, [blockerPid]);
        persistenceWaitingCount = Number(snapshot.rows[0]?.waitingCount ?? 0);
        if (persistenceWaitingCount === 0) {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      }
      assert.equal(
        persistenceWaitingCount,
        1,
        "persistent command state must reach the blocked control-state row"
      );
      assert.equal(commandSettled, false);

      let transferSettled = false;
      transfer = inSchool(() => startStudentSessionWithReplacements(
        schoolId,
        destinationStudent.id,
        transferDeviceId,
        {
          authKind: "manual_shared",
          sessionRecoveryTokenHash: createStudentSessionRecovery().tokenHash,
          reclaimRecoveryTokenHash: sourceRecovery.tokenHash,
        }
      ));
      void transfer.then(
        () => { transferSettled = true; },
        () => { transferSettled = true; }
      );

      const studentLockKey =
        `classpilot:student-control:${schoolId}:${sourceStudent.id}`;
      let waitingTransferCount = 0;
      const transferDeadline = Date.now() + 5_000;
      while (waitingTransferCount === 0 && Date.now() < transferDeadline) {
        const snapshot = await blocker.query(`
          WITH requested_lock AS (
            SELECT hashtextextended($1, 0::bigint) AS value
          )
          SELECT count(*) FILTER (WHERE lock_row.granted = false)::integer AS "waitingCount"
          FROM pg_locks AS lock_row
          CROSS JOIN requested_lock
          WHERE lock_row.locktype = 'advisory'
            AND lock_row.objsubid = 1
            AND lock_row.classid::bigint =
              ((requested_lock.value >> 32) & 4294967295::bigint)
            AND lock_row.objid::bigint =
              (requested_lock.value & 4294967295::bigint)
        `, [studentLockKey]);
        waitingTransferCount = Number(snapshot.rows[0]?.waitingCount ?? 0);
        if (waitingTransferCount === 0) {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      }
      assert.equal(
        waitingTransferCount,
        1,
        "transfer must be queued before persistent command delivery requests authority"
      );
      assert.equal(commandSettled, false);
      assert.equal(transferSettled, false);

      await blocker.query("COMMIT");
      blockerOpen = false;
      const [commandResult, transferResult] = await Promise.all([command, transfer]);
      assert.equal(transferResult.crossStudentHandoff, true);
      assert.deepEqual(
        transferResult.replacedSessions.map((session) => session.id),
        [sourceSession.session.id]
      );
      assert.equal(
        await inSchool(() => storage.getActiveSessionById(sourceSession.session.id)),
        undefined
      );
      assert.equal(
        (await inSchool(() => storage.getActiveSessionById(transferResult.session.id)))
          ?.studentId,
        destinationStudent.id
      );

      const commandTarget = commandResult.command.targets[0];
      assert.ok(commandTarget);
      assert.notEqual(commandTarget.status, "sent");
      assert.equal(commandTarget.sentAt, null);
      assert.equal(commandResult.summary.attempted, 0);
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(
        clientMessages.some((message) => message.includes(commandResult.command.id)),
        false,
        "the retired local binding must not receive the command"
      );

      const messagesBeforeDelayedRedis = clientMessages.length;
      assert.equal(
        await websocket.deliverClasspilotStudentBindingRedisMessage(
          {
            kind: "student-binding",
            schoolId,
            studentId: sourceStudent.id,
            studentSessionId: sourceSession.session.id,
            deviceId: transferDeviceId,
          },
          {
            type: "LOCK_SCREEN",
            commandId: commandResult.command.id,
            _msgId: `${commandResult.command.id}-delayed-redis`,
          }
        ),
        false,
        "a delayed Redis copy must reject the retired exact binding"
      );
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(clientMessages.length, messagesBeforeDelayedRedis);
    } finally {
      if (blockerOpen) await blocker.query("ROLLBACK").catch(() => {});
      await Promise.allSettled([
        ...(command ? [command] : []),
        ...(transfer ? [transfer] : []),
      ]);
      await blocker.end();
      websocketBroadcast.resetWsState();
      clientSocket.terminate();
      for (const socket of socketServer.clients) socket.terminate();
      await new Promise<void>((resolve) => socketServer.close(() => resolve()));

      await runWithTenantContext({ isSuper: true }, async () => {
        await db.execute(sql`
          DELETE FROM classpilot_command_targets
          WHERE teaching_session_id = ${teachingSession.id}
        `);
        await db.execute(sql`
          DELETE FROM classpilot_commands
          WHERE teaching_session_id = ${teachingSession.id}
        `);
        await db.execute(sql`
          DELETE FROM classpilot_classroom_states
          WHERE teaching_session_id = ${teachingSession.id}
        `);
        await db.delete(classpilotStudentControlStates).where(
          eq(classpilotStudentControlStates.teachingSessionId, teachingSession.id)
        );
        await db.delete(classpilotSessionStudents).where(
          eq(classpilotSessionStudents.teachingSessionId, teachingSession.id)
        );
        await db.delete(classpilotSessionStaff).where(
          eq(classpilotSessionStaff.teachingSessionId, teachingSession.id)
        );
        await db.delete(teachingSessions).where(eq(teachingSessions.id, teachingSession.id));
        await db.delete(groupStudents).where(eq(groupStudents.groupId, group.id));
        await db.delete(groupTeachers).where(eq(groupTeachers.groupId, group.id));
        await db.delete(groups).where(eq(groups.id, group.id));
        await db.delete(studentSessions).where(eq(studentSessions.deviceId, transferDeviceId));
        await db.delete(studentDevices).where(eq(studentDevices.deviceId, transferDeviceId));
        await db.delete(devices).where(eq(devices.deviceId, transferDeviceId));
        await db.delete(students).where(eq(students.id, sourceStudent.id));
        await db.delete(students).where(eq(students.id, destinationStudent.id));
        await db.delete(schoolMemberships).where(eq(schoolMemberships.userId, teacher.id));
        await db.delete(users).where(eq(users.id, teacher.id));
      });
    }
  });

  it("fences heartbeat teacher-reply recovery and rejects delayed cross-process delivery after transfer", async () => {
    const suffix = `heartbeat-teacher-reply-${randomUUID().slice(0, 8)}`;
    const transferDeviceId = `${tag}-${suffix}`;
    const teacher = await storage.createUser({
      email: `${suffix}-teacher@${tag}.example.edu`,
      firstName: "Reply",
      lastName: "Teacher",
    } as Parameters<typeof storage.createUser>[0]);
    await inSchool(() => storage.createMembership({
      userId: teacher.id,
      schoolId,
      role: "teacher",
      status: "active",
    } as Parameters<typeof storage.createMembership>[0]));
    const sourceStudent = await inSchool(() => createStudent({
      schoolId,
      firstName: "Reply",
      lastName: "Source",
      email: `${suffix}-source@${tag}.example.edu`,
      emailLc: `${suffix}-source@${tag}.example.edu`,
      status: "active",
    } as Parameters<typeof createStudent>[0]));
    const destinationStudent = await inSchool(() => createStudent({
      schoolId,
      firstName: "Reply",
      lastName: "Destination",
      email: `${suffix}-destination@${tag}.example.edu`,
      emailLc: `${suffix}-destination@${tag}.example.edu`,
      status: "active",
    } as Parameters<typeof createStudent>[0]));
    await inSchool(() => createDevice({
      deviceId: transferDeviceId,
      deviceName: "Heartbeat teacher reply transfer device",
      schoolId,
      classId: schoolId,
    } as Parameters<typeof createDevice>[0]));
    const group = await inSchool(() => storage.createGroup({
      schoolId,
      teacherId: teacher.id,
      name: `${suffix} class`,
      groupType: "admin_class",
      status: "active",
    } as Parameters<typeof storage.createGroup>[0]));
    await inSchool(() => db.insert(groupStudents).values({
      groupId: group.id,
      studentId: sourceStudent.id,
    }));
    const teachingSession = await inSchool(() => storage.createTeachingSession({
      groupId: group.id,
      teacherId: teacher.id,
      sessionMode: "live",
    } as Parameters<typeof storage.createTeachingSession>[0]));
    const sourceRecovery = createStudentSessionRecovery();
    const sourceSession = await inSchool(() => startStudentSessionWithReplacements(
      schoolId,
      sourceStudent.id,
      transferDeviceId,
      {
        authKind: "manual_shared",
        sessionRecoveryTokenHash: sourceRecovery.tokenHash,
      }
    ));
    const queuedReply = await inSchool(() => storage.createTeacherChatReplyWithDelivery({
      schoolId,
      teachingSessionId: teachingSession.id,
      studentId: sourceStudent.id,
      teacherId: teacher.id,
      content: `Exact heartbeat reply ${suffix}`,
    }));

    const socketServer = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await once(socketServer, "listening");
    const socketAddress = socketServer.address();
    assert.ok(socketAddress && typeof socketAddress !== "string");
    const serverSocketConnected = once(socketServer, "connection");
    const clientSocket = new WebSocketClient(`ws://127.0.0.1:${socketAddress.port}`);
    const clientMessages: string[] = [];
    clientSocket.on("message", (data) => clientMessages.push(data.toString()));
    await once(clientSocket, "open");
    const [serverSocket] = await serverSocketConnected;
    websocketBroadcast.registerWsClient(serverSocket);
    websocketBroadcast.authenticateWsClient(serverSocket, {
      role: "student",
      schoolId,
      studentId: sourceStudent.id,
      studentSessionId: sourceSession.session.id,
      deviceId: transferDeviceId,
    });

    let releaseRecovery!: () => void;
    const recoveryMayDeliver = new Promise<void>((resolve) => {
      releaseRecovery = resolve;
    });
    let recoveryLocked!: () => void;
    const recoveryHasAuthority = new Promise<void>((resolve) => {
      recoveryLocked = resolve;
    });
    const ordering: string[] = [];
    const recovery = inSchool(() =>
      storage.withClasspilotStudentWebSocketBootstrapAuthority(
        {
          schoolId,
          studentId: sourceStudent.id,
          studentSessionId: sourceSession.session.id,
          deviceId: transferDeviceId,
        },
        async () => {
          ordering.push("reply-claimed");
          recoveryLocked();
          await recoveryMayDeliver;
        },
        (claimed) => {
          assert.deepEqual(
            claimed.map(({ message }) => message.id),
            [queuedReply.message.id]
          );
          const payload = {
            type: "teacher-message",
            _msgId: queuedReply.message.id,
            chatMessageId: queuedReply.message.id,
            messageId: queuedReply.message.id,
            sessionId: teachingSession.id,
            studentId: sourceStudent.id,
            studentSessionId: sourceSession.session.id,
            message: queuedReply.message.content,
            fromName: "Teacher",
          };
          const target = {
            kind: "student-binding" as const,
            schoolId,
            studentId: sourceStudent.id,
            studentSessionId: sourceSession.session.id,
            deviceId: transferDeviceId,
          };
          assert.equal(websocketBroadcast.sendToStudentBindingLocal(target, payload), true);
          ordering.push("local-delivered");
          const publication = websocketRedis.publishWS(target, payload);
          ordering.push("publish-invoked");
          return { payload, publication, target };
        }
      )
    );
    await recoveryHasAuthority;

    const lockProbe = new Client({ connectionString: process.env.DATABASE_URL });
    await lockProbe.connect();
    let transfer:
      | ReturnType<typeof startStudentSessionWithReplacements>
      | undefined;
    let transferSettled = false;
    try {
      transfer = inSchool(() => startStudentSessionWithReplacements(
        schoolId,
        destinationStudent.id,
        transferDeviceId,
        {
          authKind: "manual_shared",
          sessionRecoveryTokenHash: createStudentSessionRecovery().tokenHash,
          reclaimRecoveryTokenHash: sourceRecovery.tokenHash,
        }
      ));
      void transfer.then(() => {
        transferSettled = true;
        ordering.push("transfer-completed");
      }, () => {
        transferSettled = true;
      });

      const authorityLockKey =
        `classpilot:student-control:${schoolId}:${sourceStudent.id}`;
      let waitingTransferCount = 0;
      const waitDeadline = Date.now() + 5_000;
      while (waitingTransferCount === 0 && Date.now() < waitDeadline) {
        const lockSnapshot = await lockProbe.query(`
          WITH requested_lock AS (
            SELECT hashtextextended($1, 0::bigint) AS value
          )
          SELECT count(*) FILTER (WHERE lock_row.granted = false)::integer AS "waitingCount"
          FROM pg_locks AS lock_row
          CROSS JOIN requested_lock
          WHERE lock_row.locktype = 'advisory'
            AND lock_row.objsubid = 1
            AND lock_row.classid::bigint =
              ((requested_lock.value >> 32) & 4294967295::bigint)
            AND lock_row.objid::bigint =
              (requested_lock.value & 4294967295::bigint)
        `, [authorityLockKey]);
        waitingTransferCount = Number(lockSnapshot.rows[0]?.waitingCount ?? 0);
        if (waitingTransferCount === 0) {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      }
      assert.equal(waitingTransferCount, 1);
      assert.equal(transferSettled, false);

      const localMessageReceived = once(clientSocket, "message");
      releaseRecovery();
      const [recoveryResult, transferResult] = await Promise.all([recovery, transfer]);
      assert.equal(recoveryResult.authorized, true);
      if (!recoveryResult.authorized) assert.fail("teacher-reply recovery lost authority");
      assert.equal(await recoveryResult.value.publication, false);
      const [localMessage] = await localMessageReceived;
      assert.deepEqual(JSON.parse(localMessage.toString()), recoveryResult.value.payload);
      assert.equal(transferResult.crossStudentHandoff, true);
      assert.deepEqual(ordering, [
        "reply-claimed",
        "local-delivered",
        "publish-invoked",
        "transfer-completed",
      ]);

      const deliveredBeforeDelayedRedis = clientMessages.length;
      assert.equal(
        await websocket.deliverClasspilotStudentBindingRedisMessage(
          recoveryResult.value.target,
          { ...recoveryResult.value.payload, _msgId: `${queuedReply.message.id}-delayed` }
        ),
        false,
        "a delayed cross-process delivery must reject a retired binding even when the remote socket still advertises it"
      );
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(clientMessages.length, deliveredBeforeDelayedRedis);
    } finally {
      releaseRecovery();
      await Promise.allSettled([recovery, ...(transfer ? [transfer] : [])]);
      await lockProbe.end();
      websocketBroadcast.resetWsState();
      clientSocket.terminate();
      for (const socket of socketServer.clients) socket.terminate();
      await new Promise<void>((resolve) => socketServer.close(() => resolve()));

      const activeSessions = await inSchool(() => storage.getActiveSessionsForStudents(
        schoolId,
        [sourceStudent.id, destinationStudent.id]
      ));
      for (const active of activeSessions) {
        await inSchool(() => storage.endStudentSessionExact({
          schoolId,
          studentId: active.studentId,
          deviceId: active.deviceId,
          studentSessionId: active.id,
        }));
      }
      await runWithTenantContext({ isSuper: true }, async () => {
        await db.delete(classpilotChatDeliveries).where(
          eq(classpilotChatDeliveries.chatMessageId, queuedReply.message.id)
        );
        await db.delete(chatMessages).where(eq(chatMessages.id, queuedReply.message.id));
        await db.delete(classpilotStudentControlStates).where(
          eq(classpilotStudentControlStates.teachingSessionId, teachingSession.id)
        );
        await db.delete(classpilotSessionStudents).where(
          eq(classpilotSessionStudents.teachingSessionId, teachingSession.id)
        );
        await db.delete(classpilotSessionStaff).where(
          eq(classpilotSessionStaff.teachingSessionId, teachingSession.id)
        );
        await db.delete(teachingSessions).where(eq(teachingSessions.id, teachingSession.id));
        await db.delete(groupStudents).where(eq(groupStudents.groupId, group.id));
        await db.delete(groupTeachers).where(eq(groupTeachers.groupId, group.id));
        await db.delete(groups).where(eq(groups.id, group.id));
        await db.delete(studentSessions).where(eq(studentSessions.deviceId, transferDeviceId));
        await db.delete(studentDevices).where(eq(studentDevices.deviceId, transferDeviceId));
        await db.delete(devices).where(eq(devices.deviceId, transferDeviceId));
        await db.delete(students).where(eq(students.id, sourceStudent.id));
        await db.delete(students).where(eq(students.id, destinationStudent.id));
        await db.delete(schoolMemberships).where(eq(schoolMemberships.userId, teacher.id));
        await db.delete(users).where(eq(users.id, teacher.id));
      });
    }
  });

  it("keeps Phase-A manual issuance dark with a retryable 503 and no durable side effects", async () => {
    const darkDeviceId = `${tag}-phase-a-dark`;
    const darkStudent = await inSchool(() => storage.getStudentById(studentId));
    assert.ok(darkStudent);
    const previous = process.env.CLASSPILOT_MANUAL_SHARED_SESSION_ISSUANCE_ENABLED;
    process.env.CLASSPILOT_MANUAL_SHARED_SESSION_ISSUANCE_ENABLED = "false";
    try {
      await assert.rejects(
        () => inSchool(() => studentAuth.issueStudentDeviceSessionToken({
          schoolId,
          deviceId: darkDeviceId,
          deviceName: "Must not be created while dark",
          classId: schoolId,
          student: darkStudent,
          authKind: "manual_shared",
        })),
        (error: any) =>
          error?.status === 503
          && error?.code === "CLASSPILOT_MANUAL_SESSION_ISSUANCE_UNAVAILABLE"
          && error?.retryable === true
      );
      await assert.rejects(
        () => inSchool(() => startStudentSessionWithReplacements(
          schoolId,
          studentId,
          darkDeviceId,
          {
            authKind: "manual_shared",
            sessionRecoveryTokenHash: createStudentSessionRecovery().tokenHash,
          }
        )),
        (error: any) =>
          error?.status === 503
          && error?.code === "CLASSPILOT_MANUAL_SESSION_ISSUANCE_UNAVAILABLE"
      );

      const { createApp } = await import("../dist/app.js");
      const server = createServer(createApp());
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const { port } = server.address() as AddressInfo;
      try {
        const response = await fetch(
          `http://127.0.0.1:${port}/api/classpilot/extension/student-login`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: "{}",
          }
        );
        assert.equal(response.status, 503);
        assert.deepEqual(await response.json(), {
          error: "Manual student sign-in is temporarily unavailable",
          code: "CLASSPILOT_MANUAL_SESSION_ISSUANCE_UNAVAILABLE",
          retryable: true,
        });
      } finally {
        await new Promise<void>((resolve, reject) =>
          server.close((error) => error ? reject(error) : resolve())
        );
      }
    } finally {
      if (previous === undefined) {
        delete process.env.CLASSPILOT_MANUAL_SHARED_SESSION_ISSUANCE_ENABLED;
      } else {
        process.env.CLASSPILOT_MANUAL_SHARED_SESSION_ISSUANCE_ENABLED = previous;
      }
    }

    assert.equal(await inSchool(() => storage.getDeviceById(darkDeviceId)), undefined);
    assert.deepEqual(
      await inSchool(() => db.select({ id: studentSessions.id })
        .from(studentSessions)
        .where(eq(studentSessions.deviceId, darkDeviceId))),
      []
    );
    assert.deepEqual(
      await inSchool(() => db.select({ studentId: studentDevices.studentId })
        .from(studentDevices)
        .where(eq(studentDevices.deviceId, darkDeviceId))),
      []
    );
  });

  it("denies TURN credentials for ended and lease-expired exact sessions", async () => {
    const turnDeviceId = `${tag}-turn-authority`;
    const turnStudent = await inSchool(() => createStudent({
      schoolId,
      firstName: "Turn",
      lastName: "Authority",
      email: `turn-authority@${tag}.example.edu`,
      emailLc: `turn-authority@${tag}.example.edu`,
      status: "active",
    } as Parameters<typeof createStudent>[0]));
    await inSchool(() => createDevice({
      deviceId: turnDeviceId,
      deviceName: "TURN exact authority fixture",
      schoolId,
      classId: schoolId,
    } as Parameters<typeof createDevice>[0]));

    const ended = await inSchool(() => startStudentSessionWithReplacements(
      schoolId,
      turnStudent.id,
      turnDeviceId,
      {
        authKind: "manual_shared",
        sessionRecoveryTokenHash: createStudentSessionRecovery().tokenHash,
      }
    ));
    const endedToken = createStudentToken({
      schoolId,
      studentId: turnStudent.id,
      deviceId: turnDeviceId,
      sessionId: ended.session.id,
    });
    const endedBinding = {
      role: "student" as const,
      schoolId,
      studentId: turnStudent.id,
      deviceId: turnDeviceId,
      studentSessionId: ended.session.id,
    };
    assert.equal(
      await websocket.hasActiveStudentWebSocketBinding(endedBinding),
      true
    );
    await inSchool(() => storage.endStudentSessionExact({
      schoolId,
      studentId: turnStudent.id,
      deviceId: turnDeviceId,
      studentSessionId: ended.session.id,
    }));
    assert.equal(
      await websocket.hasActiveStudentWebSocketBinding(endedBinding),
      false,
      "the next passive WebSocket validation must observe an exact end/replacement"
    );

    const expired = await inSchool(() => startStudentSessionWithReplacements(
      schoolId,
      turnStudent.id,
      turnDeviceId,
      {
        authKind: "manual_shared",
        sessionRecoveryTokenHash: createStudentSessionRecovery().tokenHash,
      }
    ));
    const expiredToken = createStudentToken({
      schoolId,
      studentId: turnStudent.id,
      deviceId: turnDeviceId,
      sessionId: expired.session.id,
    });
    const expiredBinding = {
      role: "student" as const,
      schoolId,
      studentId: turnStudent.id,
      deviceId: turnDeviceId,
      studentSessionId: expired.session.id,
    };
    assert.equal(
      await websocket.hasActiveStudentWebSocketBinding(expiredBinding),
      true
    );
    await inSchool(() => db.update(studentSessions)
      .set({ manualLeaseExpiresAt: sql`now()` })
      .where(eq(studentSessions.id, expired.session.id)));
    assert.equal(
      await websocket.hasActiveStudentWebSocketBinding(expiredBinding),
      false,
      "the exact DB-time manual lease boundary must deny the next passive frame"
    );

    const { createApp } = await import("../dist/app.js");
    const server = createServer(createApp());
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    try {
      for (const studentToken of [endedToken, expiredToken]) {
        const response = await fetch(
          `http://127.0.0.1:${port}/api/classpilot/device/live-view/ice-servers`,
          {
            method: "POST",
            headers: {
              authorization: `Bearer ${studentToken}`,
              "content-type": "application/json",
            },
            body: JSON.stringify({ negotiationId: "must-not-reach-turn-issuance" }),
          }
        );
        assert.equal(response.status, 401);
        assert.deepEqual(await response.json(), {
          error: "Student session is no longer active",
        });
      }
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => error ? reject(error) : resolve())
      );
    }
  });

  it("rejects wrong-device or wrong-token reclaim without creating a mapping or session", async () => {
    const originalRecovery = createStudentSessionRecovery();
    const wrongRecovery = createStudentSessionRecovery();

    const original = await inSchool(() =>
      startStudentSessionWithReplacements(schoolId, studentId, originalDeviceId, {
        authKind: "manual_shared",
        sessionRecoveryTokenHash: originalRecovery.tokenHash,
      })
    );
    assert.equal(original.session.deviceId, originalDeviceId);

    await assert.rejects(
      () => inSchool(() =>
        startStudentSessionWithReplacements(schoolId, studentId, blockedDeviceId, {
          authKind: "manual_shared",
          sessionRecoveryTokenHash: createStudentSessionRecovery().tokenHash,
          reclaimRecoveryTokenHash: originalRecovery.tokenHash,
        })
      ),
      (error: any) => error?.code === "STUDENT_SESSION_ACTIVE"
    );
    await assert.rejects(
      () => inSchool(() =>
        startStudentSessionWithReplacements(schoolId, studentId, originalDeviceId, {
          authKind: "manual_shared",
          sessionRecoveryTokenHash: createStudentSessionRecovery().tokenHash,
          reclaimRecoveryTokenHash: wrongRecovery.tokenHash,
        })
      ),
      (error: any) => error?.code === "STUDENT_SESSION_ACTIVE"
    );

    const blockedLinks = await inSchool(() =>
      db.select({ studentId: studentDevices.studentId })
        .from(studentDevices)
        .where(and(
          eq(studentDevices.studentId, studentId),
          eq(studentDevices.deviceId, blockedDeviceId)
        ))
    );
    const blockedSessions = await inSchool(() =>
      db.select({ id: studentSessions.id })
        .from(studentSessions)
        .where(eq(studentSessions.deviceId, blockedDeviceId))
    );
    assert.deepEqual(blockedLinks, []);
    assert.deepEqual(blockedSessions, []);

    const replacementRecovery = createStudentSessionRecovery();
    const resumed = await inSchool(() =>
      startStudentSessionWithReplacements(schoolId, studentId, originalDeviceId, {
        authKind: "manual_shared",
        sessionRecoveryTokenHash: replacementRecovery.tokenHash,
        reclaimRecoveryTokenHash: hashStudentSessionRecoveryToken(
          originalRecovery.token
        ),
      })
    );
    assert.notEqual(resumed.session.id, original.session.id);
    assert.deepEqual(resumed.replacedSessions.map((row) => row.id), [original.session.id]);
    assert.equal(
      await inSchool(() => storage.endStudentSessionByRecoveryTokenHash({
        schoolId,
        tokenHash: originalRecovery.tokenHash,
      })),
      undefined,
      "a delayed old recovery capability must not end its replacement"
    );
    assert.equal(
      await inSchool(() => storage.endStudentSessionExact({
        schoolId,
        studentId,
        deviceId: originalDeviceId,
        studentSessionId: original.session.id,
      })),
      undefined,
      "delayed exact cleanup of the old session must be idempotent"
    );
    assert.equal(
      (await inSchool(() => storage.getActiveSessionById(resumed.session.id)))?.id,
      resumed.session.id
    );

    // Inline expiry must be able to replace an orphaned session even if its
    // former device inventory row has already been removed.
    await inSchool(async () => {
      await db.update(studentSessions)
        .set({ manualLeaseExpiresAt: sql`now() - interval '1 millisecond'` })
        .where(eq(studentSessions.id, resumed.session.id));
      await db.delete(devices).where(eq(devices.deviceId, originalDeviceId));
    });
    const afterOrphanExpiry = await inSchool(() =>
      startStudentSessionWithReplacements(schoolId, studentId, blockedDeviceId, {
        authKind: "manual_shared",
        sessionRecoveryTokenHash: createStudentSessionRecovery().tokenHash,
      })
    );
    assert.deepEqual(
      afterOrphanExpiry.replacedSessions.map((row) => row.id),
      [resumed.session.id]
    );
    assert.equal(afterOrphanExpiry.session.deviceId, blockedDeviceId);

    const boundary = await inSchool(() => db.execute(sql`
      SELECT
        ((now() - interval '299.999 seconds') + interval '300 seconds') > now()
          AS at_4_59_999,
        ((now() - interval '300 seconds') + interval '300 seconds') > now()
          AS at_5_00_000,
        ((now() - interval '300.001 seconds') + interval '300 seconds') > now()
          AS at_5_00_001
    `));
    assert.deepEqual(boundary.rows[0], {
      at_4_59_999: true,
      at_5_00_000: false,
      at_5_00_001: false,
    });

    // A heartbeat before expiry renews using database time. The exact boundary
    // is closed: a heartbeat at/after expiry cannot revive the represented row.
    await inSchool(() => db.update(studentSessions).set({
      manualLeaseExpiresAt: sql`now() + interval '10 seconds'`,
      lastSeenAt: sql`now() - interval '61 seconds'`,
    }).where(eq(studentSessions.id, afterOrphanExpiry.session.id)));
    const renewed = await inSchool(() =>
      storage.createHeartbeatAndRefreshPresence({
        deviceId: blockedDeviceId,
        schoolId,
        studentId,
        activeTabTitle: "Renew before expiry",
      }, afterOrphanExpiry.session.id)
    );
    assert.equal(renewed.outcome, "recorded");
    const renewalRemaining = await inSchool(() => db.execute(sql`
      SELECT extract(epoch FROM (manual_lease_expires_at - now()))::double precision AS seconds
      FROM student_sessions
      WHERE id = ${afterOrphanExpiry.session.id}
    `));
    assert.ok(Number(renewalRemaining.rows[0]?.seconds) > 299);

    await inSchool(() => db.delete(heartbeats).where(eq(heartbeats.studentId, studentId)));
    await inSchool(() =>
      db.update(studentSessions)
        .set({ manualLeaseExpiresAt: sql`now()` })
        .where(eq(studentSessions.id, afterOrphanExpiry.session.id))
    );
    const heartbeat = await inSchool(() =>
      storage.createHeartbeatAndRefreshPresence({
        deviceId: blockedDeviceId,
        schoolId,
        studentId,
        activeTabTitle: "Expired session must not revive",
      }, afterOrphanExpiry.session.id)
    );
    assert.equal(heartbeat.outcome, "inactive_session");
    const writtenHeartbeats = await inSchool(() =>
      db.select({ id: heartbeats.id })
        .from(heartbeats)
        .where(eq(heartbeats.studentId, studentId))
    );
    assert.deepEqual(writtenHeartbeats, []);

    const offHours = await inSchool(() =>
      startStudentSessionWithReplacements(schoolId, studentId, blockedDeviceId, {
        authKind: "manual_shared",
        sessionRecoveryTokenHash: createStudentSessionRecovery().tokenHash,
      })
    );
    await inSchool(() => db.update(studentSessions).set({
      manualLeaseExpiresAt: sql`now() + interval '10 seconds'`,
      lastSeenAt: sql`now() - interval '61 seconds'`,
    }).where(eq(studentSessions.id, offHours.session.id)));
    const offHoursAccepted = await inSchool(() =>
      storage.refreshStudentSessionAuthorityWithoutTelemetry({
        schoolId,
        studentId,
        deviceId: blockedDeviceId,
        studentSessionId: offHours.session.id,
      })
    );
    assert.equal(offHoursAccepted.outcome, "accepted");
    assert.ok(
      offHoursAccepted.outcome === "accepted"
      && Number(offHoursAccepted.authorityExpiresAt?.getTime()) > Date.now() + 299_000
    );
    assert.deepEqual(
      await inSchool(() => db.select({ id: heartbeats.id })
        .from(heartbeats)
        .where(eq(heartbeats.studentId, studentId))),
      [],
      "an off-hours authority renewal must not insert monitoring telemetry"
    );
    await inSchool(() => db.update(studentSessions)
      .set({ manualLeaseExpiresAt: sql`now()` })
      .where(eq(studentSessions.id, offHours.session.id)));
    assert.deepEqual(
      await inSchool(() => storage.refreshStudentSessionAuthorityWithoutTelemetry({
        schoolId,
        studentId,
        deviceId: blockedDeviceId,
        studentSessionId: offHours.session.id,
      })),
      { outcome: "inactive_session" },
      "an off-hours rapid retry at expiry must fail closed"
    );

    const releaseRecovery = createStudentSessionRecovery();
    const releasable = await inSchool(() =>
      startStudentSessionWithReplacements(schoolId, studentId, blockedDeviceId, {
        authKind: "manual_shared",
        sessionRecoveryTokenHash: releaseRecovery.tokenHash,
      })
    );
    const otherSchoolId = randomUUID();
    assert.equal(
      await runWithTenantContext({ schoolId: otherSchoolId }, () =>
        storage.getReclaimableStudentSessionByRecoveryTokenHash({
          schoolId: otherSchoolId,
          tokenHash: releaseRecovery.tokenHash,
        })
      ),
      undefined,
      "a recovery capability cannot cross school scope"
    );

    const { createApp } = await import("../dist/app.js");
    const server = createServer(createApp());
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    const release = () => fetch(
      `http://127.0.0.1:${port}/api/classpilot/extension/session-release`,
      {
        method: "POST",
        headers: {
          authorization: `ClassPilot-Recovery ${releaseRecovery.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ schoolId, reason: "browser_restart" }),
      }
    );
    try {
      assert.equal((await release()).status, 204);
      assert.equal((await release()).status, 204);
      assert.equal(
        await inSchool(() => storage.getActiveSessionById(releasable.session.id)),
        undefined
      );
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => error ? reject(error) : resolve())
      );
    }
  });

  it("atomically hands one recovered Chromebook session to a different student", async () => {
    const handoffDeviceId = `${tag}-cross-student-handoff`;
    await inSchool(() => createDevice({
      deviceId: handoffDeviceId,
      deviceName: "Cross-student handoff device",
      schoolId,
      classId: schoolId,
    } as Parameters<typeof createDevice>[0]));
    const alex = await inSchool(() => createStudent({
      schoolId,
      firstName: "Alex",
      lastName: "Recovered",
      email: `alex-recovered@${tag}.example.edu`,
      emailLc: `alex-recovered@${tag}.example.edu`,
      status: "active",
    } as Parameters<typeof createStudent>[0]));
    const bob = await inSchool(() => createStudent({
      schoolId,
      firstName: "Bob",
      lastName: "Replacement",
      email: `bob-replacement@${tag}.example.edu`,
      emailLc: `bob-replacement@${tag}.example.edu`,
      status: "active",
    } as Parameters<typeof createStudent>[0]));
    const alexRecovery = createStudentSessionRecovery();
    const alexSession = await inSchool(() =>
      startStudentSessionWithReplacements(schoolId, alex.id, handoffDeviceId, {
        authKind: "manual_shared",
        sessionRecoveryTokenHash: alexRecovery.tokenHash,
      })
    );

    const bobRecovery = createStudentSessionRecovery();
    const handoff = await inSchool(() =>
      startStudentSessionWithReplacements(schoolId, bob.id, handoffDeviceId, {
        authKind: "manual_shared",
        sessionRecoveryTokenHash: bobRecovery.tokenHash,
        reclaimRecoveryTokenHash: alexRecovery.tokenHash,
      })
    );
    assert.equal(handoff.crossStudentHandoff, true);
    assert.deepEqual(
      handoff.replacedSessions.map((row) => row.id),
      [alexSession.session.id],
      "the transaction must return exactly the recovered row for one tombstone"
    );
    const [endedAlex] = await inSchool(() => db.select({
      isActive: studentSessions.isActive,
      endedAt: studentSessions.endedAt,
      recoveryHash: studentSessions.sessionRecoveryTokenHash,
    }).from(studentSessions).where(eq(studentSessions.id, alexSession.session.id)));
    assert.equal(endedAlex?.isActive, false);
    assert.ok(endedAlex?.endedAt instanceof Date);
    assert.equal(endedAlex?.recoveryHash, null);
    assert.equal(
      (await inSchool(() => storage.getActiveSessionById(handoff.session.id)))?.studentId,
      bob.id
    );

    assert.equal(
      await inSchool(() => storage.endStudentSessionByRecoveryTokenHash({
        schoolId,
        tokenHash: alexRecovery.tokenHash,
      })),
      undefined,
      "delayed recovery cleanup for Alex must not end Bob"
    );
    assert.equal(
      await inSchool(() => storage.endStudentSessionExact({
        schoolId,
        studentId: alex.id,
        deviceId: handoffDeviceId,
        studentSessionId: alexSession.session.id,
      })),
      undefined,
      "delayed exact cleanup for Alex must remain a no-op"
    );
    assert.equal(
      (await inSchool(() => storage.getActiveSessionById(handoff.session.id)))?.id,
      handoff.session.id
    );

    const resumedRecovery = createStudentSessionRecovery();
    const sameStudentResume = await inSchool(() =>
      startStudentSessionWithReplacements(schoolId, bob.id, handoffDeviceId, {
        authKind: "manual_shared",
        sessionRecoveryTokenHash: resumedRecovery.tokenHash,
        reclaimRecoveryTokenHash: bobRecovery.tokenHash,
      })
    );
    assert.equal(sameStudentResume.crossStudentHandoff, false);
    assert.deepEqual(
      sameStudentResume.replacedSessions.map((row) => row.id),
      [handoff.session.id]
    );

    const releasedBeforeLogin = await inSchool(() =>
      storage.endStudentSessionByRecoveryTokenHash({
        schoolId,
        tokenHash: resumedRecovery.tokenHash,
      })
    );
    assert.equal(releasedBeforeLogin?.id, sameStudentResume.session.id);
    const loginAfterReleaseRecovery = createStudentSessionRecovery();
    const loginAfterRelease = await inSchool(() =>
      startStudentSessionWithReplacements(schoolId, alex.id, handoffDeviceId, {
        authKind: "manual_shared",
        sessionRecoveryTokenHash: loginAfterReleaseRecovery.tokenHash,
        reclaimRecoveryTokenHash: resumedRecovery.tokenHash,
      })
    );
    assert.equal(loginAfterRelease.crossStudentHandoff, false);
    assert.deepEqual(loginAfterRelease.replacedSessions, []);
    assert.equal(
      await inSchool(() => storage.endStudentSessionByRecoveryTokenHash({
        schoolId,
        tokenHash: resumedRecovery.tokenHash,
      })),
      undefined
    );
    assert.equal(
      (await inSchool(() => storage.getActiveSessionById(loginAfterRelease.session.id)))?.studentId,
      alex.id
    );
    await inSchool(() => storage.endStudentSessionExact({
      schoolId,
      studentId: alex.id,
      deviceId: handoffDeviceId,
      studentSessionId: loginAfterRelease.session.id,
    }));
  });

  it("serializes a cross-student handoff behind the source student's control ACK", async () => {
    const handoffDeviceId = `${tag}-cross-student-ack-race`;
    await inSchool(() => createDevice({
      deviceId: handoffDeviceId,
      deviceName: "Cross-student ACK race device",
      schoolId,
      classId: schoolId,
    } as Parameters<typeof createDevice>[0]));
    const sourceStudent = await inSchool(() => createStudent({
      schoolId,
      firstName: "Source",
      lastName: "Acknowledgement",
      email: `source-ack@${tag}.example.edu`,
      emailLc: `source-ack@${tag}.example.edu`,
      status: "active",
    } as Parameters<typeof createStudent>[0]));
    const destinationStudent = await inSchool(() => createStudent({
      schoolId,
      firstName: "Destination",
      lastName: "Handoff",
      email: `destination-handoff@${tag}.example.edu`,
      emailLc: `destination-handoff@${tag}.example.edu`,
      status: "active",
    } as Parameters<typeof createStudent>[0]));
    const sourceRecovery = createStudentSessionRecovery();
    const sourceSession = await inSchool(() => startStudentSessionWithReplacements(
      schoolId,
      sourceStudent.id,
      handoffDeviceId,
      {
        authKind: "manual_shared",
        sessionRecoveryTokenHash: sourceRecovery.tokenHash,
      }
    ));
    await inSchool(() => db.insert(classpilotStudentControlStates).values({
      schoolId,
      studentId: sourceStudent.id,
      revision: 7,
      desiredState: { restrictions: { locked: true } },
      enforcementHealth: "pending",
    }));

    let releaseAck!: () => void;
    const ackMayProceed = new Promise<void>((resolve) => {
      releaseAck = resolve;
    });
    let ackAuthorityLocked!: () => void;
    const ackHasAuthority = new Promise<void>((resolve) => {
      ackAuthorityLocked = resolve;
    });
    const acknowledgement = inSchool(() => db.transaction(async (tx) => {
      const transactionDb = Object.assign(tx, { $client: db.$client });
      await storage.lockClasspilotStudentControlAuthorities(
        schoolId,
        [sourceStudent.id],
        transactionDb
      );
      ackAuthorityLocked();
      await ackMayProceed;
      return storage.acknowledgeClasspilotStudentControlState({
        schoolId,
        studentId: sourceStudent.id,
        studentSessionId: sourceSession.session.id,
        deviceId: handoffDeviceId,
        appliedRevision: 7,
        outcome: "applied",
      }, transactionDb);
    }));
    await ackHasAuthority;

    const lockProbe = new Client({ connectionString: process.env.DATABASE_URL });
    await lockProbe.connect();
    let handoff: ReturnType<typeof startStudentSessionWithReplacements> | undefined;
    let completedHandoff: Awaited<ReturnType<typeof startStudentSessionWithReplacements>>
      | undefined;
    try {
      handoff = inSchool(() => startStudentSessionWithReplacements(
        schoolId,
        destinationStudent.id,
        handoffDeviceId,
        {
          authKind: "manual_shared",
          sessionRecoveryTokenHash: createStudentSessionRecovery().tokenHash,
          reclaimRecoveryTokenHash: sourceRecovery.tokenHash,
        }
      ));

      const authorityLockKey =
        `classpilot:student-control:${schoolId}:${sourceStudent.id}`;
      let waitingHandoffCount = 0;
      const waitDeadline = Date.now() + 5_000;
      while (waitingHandoffCount === 0 && Date.now() < waitDeadline) {
        const lockSnapshot = await lockProbe.query(`
          WITH requested_lock AS (
            SELECT hashtextextended($1, 0::bigint) AS value
          )
          SELECT count(*) FILTER (WHERE lock_row.granted = false)::integer AS "waitingCount"
          FROM pg_locks AS lock_row
          CROSS JOIN requested_lock
          WHERE lock_row.locktype = 'advisory'
            AND lock_row.objsubid = 1
            AND lock_row.classid::bigint =
              ((requested_lock.value >> 32) & 4294967295::bigint)
            AND lock_row.objid::bigint =
              (requested_lock.value & 4294967295::bigint)
        `, [authorityLockKey]);
        waitingHandoffCount = Number(lockSnapshot.rows[0]?.waitingCount ?? 0);
        if (waitingHandoffCount === 0) {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      }
      assert.equal(
        waitingHandoffCount,
        1,
        "the handoff must wait on the source ACK authority before retiring its session"
      );

      releaseAck();
      const [acknowledged, resolvedHandoff] = await Promise.all([
        acknowledgement,
        handoff,
      ]);
      completedHandoff = resolvedHandoff;
      assert.equal(acknowledged?.appliedRevision, 7);
      assert.equal(completedHandoff.crossStudentHandoff, true);
      assert.deepEqual(
        completedHandoff.replacedSessions.map((row) => row.id),
        [sourceSession.session.id]
      );
      assert.equal(
        (await inSchool(() => storage.getActiveSessionById(completedHandoff!.session.id)))
          ?.studentId,
        destinationStudent.id
      );
    } finally {
      releaseAck();
      await Promise.allSettled([
        acknowledgement,
        ...(handoff ? [handoff] : []),
      ]);
      await lockProbe.end();
      const activeSessions = await inSchool(() => storage.getActiveSessionsForStudents(
        schoolId,
        [sourceStudent.id, destinationStudent.id]
      ));
      for (const active of activeSessions) {
        await inSchool(() => storage.endStudentSessionExact({
          schoolId,
          studentId: active.studentId,
          deviceId: active.deviceId,
          studentSessionId: active.id,
        }));
      }
      await inSchool(() => db.delete(classpilotStudentControlStates).where(and(
        eq(classpilotStudentControlStates.schoolId, schoolId),
        eq(classpilotStudentControlStates.studentId, sourceStudent.id)
      )));
      await inSchool(() => storage.deleteDeviceWithEndedSessions(
        schoolId,
        handoffDeviceId
      ));
    }
  });

  it("serializes WebSocket bootstrap delivery before a same-device student transfer", async () => {
    const transferDeviceId = `${tag}-websocket-bootstrap-transfer`;
    await inSchool(() => createDevice({
      deviceId: transferDeviceId,
      deviceName: "WebSocket bootstrap transfer device",
      schoolId,
      classId: schoolId,
    } as Parameters<typeof createDevice>[0]));
    const sourceStudent = await inSchool(() => createStudent({
      schoolId,
      firstName: "WebSocket",
      lastName: "Bootstrap",
      email: `websocket-bootstrap@${tag}.example.edu`,
      emailLc: `websocket-bootstrap@${tag}.example.edu`,
      status: "active",
    } as Parameters<typeof createStudent>[0]));
    const destinationStudent = await inSchool(() => createStudent({
      schoolId,
      firstName: "WebSocket",
      lastName: "Transfer",
      email: `websocket-transfer@${tag}.example.edu`,
      emailLc: `websocket-transfer@${tag}.example.edu`,
      status: "active",
    } as Parameters<typeof createStudent>[0]));
    const sourceRecovery = createStudentSessionRecovery();
    const sourceSession = await inSchool(() => startStudentSessionWithReplacements(
      schoolId,
      sourceStudent.id,
      transferDeviceId,
      {
        authKind: "manual_shared",
        sessionRecoveryTokenHash: sourceRecovery.tokenHash,
      }
    ));

    let releaseBootstrap!: () => void;
    const bootstrapMayDeliver = new Promise<void>((resolve) => {
      releaseBootstrap = resolve;
    });
    let bootstrapAuthorityLocked!: () => void;
    const bootstrapHasAuthority = new Promise<void>((resolve) => {
      bootstrapAuthorityLocked = resolve;
    });
    const ordering: string[] = [];
    const bootstrap = inSchool(() =>
      storage.withClasspilotStudentWebSocketBootstrapAuthority(
        {
          schoolId,
          studentId: sourceStudent.id,
          studentSessionId: sourceSession.session.id,
          deviceId: transferDeviceId,
        },
        async () => {
          ordering.push("bootstrap-prepared");
          bootstrapAuthorityLocked();
          await bootstrapMayDeliver;
          return { studentSessionId: sourceSession.session.id };
        },
        (_claimed, prepared) => {
          assert.equal(prepared.studentSessionId, sourceSession.session.id);
          ordering.push("bootstrap-delivered");
          return prepared.studentSessionId;
        }
      )
    );
    await bootstrapHasAuthority;

    const lockProbe = new Client({ connectionString: process.env.DATABASE_URL });
    await lockProbe.connect();
    let transfer:
      | ReturnType<typeof startStudentSessionWithReplacements>
      | undefined;
    let transferSettled = false;
    let completedTransfer:
      | Awaited<ReturnType<typeof startStudentSessionWithReplacements>>
      | undefined;
    try {
      transfer = inSchool(() => startStudentSessionWithReplacements(
        schoolId,
        destinationStudent.id,
        transferDeviceId,
        {
          authKind: "manual_shared",
          sessionRecoveryTokenHash: createStudentSessionRecovery().tokenHash,
          reclaimRecoveryTokenHash: sourceRecovery.tokenHash,
        }
      ));
      void transfer.then(() => {
        transferSettled = true;
        ordering.push("transfer-completed");
      }, () => {
        transferSettled = true;
      });

      const authorityLockKey =
        `classpilot:student-control:${schoolId}:${sourceStudent.id}`;
      let waitingTransferCount = 0;
      const waitDeadline = Date.now() + 5_000;
      while (waitingTransferCount === 0 && Date.now() < waitDeadline) {
        const lockSnapshot = await lockProbe.query(`
          WITH requested_lock AS (
            SELECT hashtextextended($1, 0::bigint) AS value
          )
          SELECT count(*) FILTER (WHERE lock_row.granted = false)::integer AS "waitingCount"
          FROM pg_locks AS lock_row
          CROSS JOIN requested_lock
          WHERE lock_row.locktype = 'advisory'
            AND lock_row.objsubid = 1
            AND lock_row.classid::bigint =
              ((requested_lock.value >> 32) & 4294967295::bigint)
            AND lock_row.objid::bigint =
              (requested_lock.value & 4294967295::bigint)
        `, [authorityLockKey]);
        waitingTransferCount = Number(lockSnapshot.rows[0]?.waitingCount ?? 0);
        if (waitingTransferCount === 0) {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      }
      assert.equal(
        waitingTransferCount,
        1,
        "the transfer must wait on WebSocket bootstrap's student-control authority"
      );
      assert.equal(
        transferSettled,
        false,
        "the replacement binding must not commit before bootstrap delivery releases"
      );

      releaseBootstrap();
      const [bootstrapResult, transferResult] = await Promise.all([
        bootstrap,
        transfer,
      ]);
      completedTransfer = transferResult;
      assert.deepEqual(bootstrapResult, {
        authorized: true,
        value: sourceSession.session.id,
      });
      assert.equal(completedTransfer.crossStudentHandoff, true);
      assert.deepEqual(
        completedTransfer.replacedSessions.map((row) => row.id),
        [sourceSession.session.id]
      );
      assert.deepEqual(ordering, [
        "bootstrap-prepared",
        "bootstrap-delivered",
        "transfer-completed",
      ]);
      assert.equal(
        await inSchool(() => storage.getActiveSessionById(sourceSession.session.id)),
        undefined
      );
      assert.equal(
        (await inSchool(() => storage.getActiveSessionById(completedTransfer!.session.id)))
          ?.studentId,
        destinationStudent.id
      );
    } finally {
      releaseBootstrap();
      await Promise.allSettled([
        bootstrap,
        ...(transfer ? [transfer] : []),
      ]);
      await lockProbe.end();
      const activeSessions = await inSchool(() => storage.getActiveSessionsForStudents(
        schoolId,
        [sourceStudent.id, destinationStudent.id]
      ));
      for (const active of activeSessions) {
        await inSchool(() => storage.endStudentSessionExact({
          schoolId,
          studentId: active.studentId,
          deviceId: active.deviceId,
          studentSessionId: active.id,
        }));
      }
      await inSchool(() => storage.deleteDeviceWithEndedSessions(
        schoolId,
        transferDeviceId
      ));
    }
  });

  it("keeps class-bound pixels private across an atomic same-device handoff", async () => {
    type ScreenshotAuthority =
      | { kind: "student_session"; controlRevision: number }
      | {
          kind: "teaching_session";
          teachingSessionId: string;
          controlRevision: number;
        };
    type DeviceResponse = {
      ok?: boolean;
      code?: string;
    };
    type TileResponse = {
      tiles: Array<{
        studentId: string;
        bindingVersion?: string;
        screenshot: null | {
          screenshot: string;
          timestamp: number;
          bindingVersion?: string;
        };
      }>;
    };

    const handoffDeviceId = `${tag}-screenshot-privacy-handoff`;
    const alexPixels = `data:image/jpeg;base64,${Buffer.from("alex-class-pixels").toString("base64")}`;
    const bobPixels = `data:image/jpeg;base64,${Buffer.from("bob-class-pixels").toString("base64")}`;
    let teacherId = "";
    let alexId = "";
    let bobId = "";
    let groupId = "";
    let teachingSessionId = "";
    let server: ReturnType<typeof createServer> | undefined;

    const parseResponse = async <T>(response: Response): Promise<{
      status: number;
      body: T;
    }> => {
      const body = JSON.parse(await response.text()) as T;
      return { status: response.status, body };
    };

    try {
      const teacher = await storage.createUser({
        email: `${tag}-screenshot-teacher@${tag}.example.edu`,
        firstName: "Screenshot",
        lastName: "Teacher",
      } as Parameters<typeof storage.createUser>[0]);
      teacherId = teacher.id;
      await inSchool(() => storage.createMembership({
        userId: teacher.id,
        schoolId,
        role: "teacher",
        status: "active",
      } as Parameters<typeof storage.createMembership>[0]));

      const alex = await inSchool(() => createStudent({
        schoolId,
        firstName: "Alex",
        lastName: "Screenshot",
        email: `alex-screenshot@${tag}.example.edu`,
        emailLc: `alex-screenshot@${tag}.example.edu`,
        status: "active",
      } as Parameters<typeof createStudent>[0]));
      alexId = alex.id;
      const bob = await inSchool(() => createStudent({
        schoolId,
        firstName: "Bob",
        lastName: "Screenshot",
        email: `bob-screenshot@${tag}.example.edu`,
        emailLc: `bob-screenshot@${tag}.example.edu`,
        status: "active",
      } as Parameters<typeof createStudent>[0]));
      bobId = bob.id;
      await inSchool(() => createDevice({
        deviceId: handoffDeviceId,
        deviceName: "Screenshot privacy handoff device",
        schoolId,
        classId: schoolId,
      } as Parameters<typeof createDevice>[0]));
      await inSchool(() => storage.upsertSettings(schoolId, {
        enableTrackingHours: false,
        afterHoursMode: "off",
      }));

      const group = await inSchool(() => storage.createGroup({
        schoolId,
        teacherId: teacher.id,
        name: `${tag} screenshot handoff class`,
        groupType: "admin_class",
        status: "active",
      } as Parameters<typeof storage.createGroup>[0]));
      groupId = group.id;
      await inSchool(() => db.insert(groupStudents).values([
        { groupId: group.id, studentId: alex.id },
        { groupId: group.id, studentId: bob.id },
      ]));
      const teachingSession = await inSchool(() => storage.createTeachingSession({
        groupId: group.id,
        teacherId: teacher.id,
        sessionMode: "live",
      } as Parameters<typeof storage.createTeachingSession>[0]));
      teachingSessionId = teachingSession.id;
      assert.ok(teachingSession.rosterSnapshotCompletedAt);

      const alexRecovery = createStudentSessionRecovery();
      const alexSession = await inSchool(() => startStudentSessionWithReplacements(
        schoolId,
        alex.id,
        handoffDeviceId,
        {
          authKind: "manual_shared",
          sessionRecoveryTokenHash: alexRecovery.tokenHash,
        }
      ));
      const alexToken = createStudentToken({
        schoolId,
        studentId: alex.id,
        deviceId: handoffDeviceId,
        sessionId: alexSession.session.id,
        studentEmail: alex.email || undefined,
      });

      const { createApp } = await import("../dist/app.js");
      server = createServer(createApp());
      await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
      const { port } = server.address() as AddressInfo;
      const baseUrl = `http://127.0.0.1:${port}`;
      const postDevice = async <T>(
        path: string,
        token: string,
        body: Record<string, unknown>
      ) => parseResponse<T>(await fetch(`${baseUrl}${path}`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      }));
      const teacherToken = signUserToken({
        userId: teacher.id,
        email: teacher.email,
        isSuperAdmin: false,
      });
      const readTiles = async (studentIds: string[]) => parseResponse<TileResponse>(
        await fetch(`${baseUrl}/api/classpilot/tiles/screenshots`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${teacherToken}`,
            "content-type": "application/json",
            "x-school-id": schoolId,
          },
          body: JSON.stringify({ studentIds, teachingSessionId }),
        })
      );
      const retainExactClassScreenshot = async (options: {
        studentId: string;
        studentSessionId: string;
        authority: ScreenshotAuthority;
        screenshot: string;
      }) => inSchool(() => storage.withClasspilotScreenshotUploadAuthority({
        schoolId,
        studentId: options.studentId,
        studentSessionId: options.studentSessionId,
        deviceId: handoffDeviceId,
        expectedAuthority: options.authority,
      }, ({ current, trackingSettings }) => {
        if (current.authority.kind !== "teaching_session") {
          throw new Error("Screenshot authority was not class-bound at retention time");
        }
        const capturedAt = new Date();
        assert.equal(validateClasspilotScreenshotCapturedAt({
          capturedAt,
          trackingSettings,
          trackingAuthority: current,
        }), "ok");
        const classBinding = {
          schoolId,
          deviceId: handoffDeviceId,
          studentId: options.studentId,
          studentSessionId: options.studentSessionId,
          teachingSessionId: current.authority.teachingSessionId,
          controlRevision: current.authority.controlRevision,
        };
        assert.equal(classpilotScreenshotFallback.setClassBound(classBinding, {
          screenshot: options.screenshot,
          timestamp: capturedAt.getTime(),
          capturedAt: capturedAt.toISOString(),
          tabTitle: "Synthetic handoff capture",
          ...classBinding,
          bindingVersion: classBoundScreenshotBindingVersion(classBinding),
        }), true);
        return classBinding;
      }));

      const alexProjection = await inSchool(() =>
        storage.getClasspilotScreenshotAuthorityProjection({
          schoolId,
          studentId: alex.id,
          studentSessionId: alexSession.session.id,
          deviceId: handoffDeviceId,
        })
      );
      assert.ok(alexProjection);
      const alexAuthority = alexProjection.authority;
      if (alexAuthority.kind !== "teaching_session") {
        throw new Error("Alex did not receive exact teaching-session screenshot authority");
      }
      assert.equal(alexAuthority.teachingSessionId, teachingSession.id);

      const alexCapture = await retainExactClassScreenshot({
        studentId: alex.id,
        studentSessionId: alexSession.session.id,
        authority: alexAuthority,
        screenshot: alexPixels,
      });
      assert.equal(alexCapture.status, "accepted");
      if (alexCapture.status !== "accepted") {
        throw new Error("Alex's exact screenshot authority was not accepted");
      }
      const alexClassBinding = alexCapture.value;
      assert.equal(
        classpilotScreenshotFallback.getClassBound(alexClassBinding)?.screenshot,
        alexPixels,
        "the old class-bound pixels must physically exist before the handoff"
      );
      const alexBeforeHandoff = await readTiles([alex.id]);
      assert.equal(alexBeforeHandoff.status, 200);
      assert.equal(alexBeforeHandoff.body.tiles[0]?.screenshot?.screenshot, alexPixels);

      const bobRecovery = createStudentSessionRecovery();
      const handoff = await inSchool(() => startStudentSessionWithReplacements(
        schoolId,
        bob.id,
        handoffDeviceId,
        {
          authKind: "manual_shared",
          sessionRecoveryTokenHash: bobRecovery.tokenHash,
          reclaimRecoveryTokenHash: alexRecovery.tokenHash,
        }
      ));
      assert.equal(handoff.crossStudentHandoff, true);
      assert.deepEqual(
        handoff.replacedSessions.map((row) => row.id),
        [alexSession.session.id]
      );
      assert.equal(
        await inSchool(() => storage.getActiveSessionById(alexSession.session.id)),
        undefined,
        "the atomic handoff must retire Alex before Bob becomes authoritative"
      );
      assert.equal(
        (await inSchool(() => storage.getActiveSessionById(handoff.session.id)))?.studentId,
        bob.id
      );

      const staffFacingTombstones: Array<{
        schoolId: string;
        studentId: string;
        studentSessionId: string;
        deviceId: string;
        reason: string;
      }> = [];
      let sameDeviceLocalMessages = 0;
      let sameDeviceRemoteMessages = 0;
      await classpilotDeviceRoutes.publishCommittedStudentSessionReplacements({
        schoolId,
        replacementDeviceId: handoffDeviceId,
        replacedSessions: handoff.replacedSessions,
      }, {
        broadcastEnded: async (options) => {
          staffFacingTombstones.push(options);
        },
        sendLocal: () => {
          sameDeviceLocalMessages += 1;
          return true;
        },
        publishRemote: async () => {
          sameDeviceRemoteMessages += 1;
          return true;
        },
      });
      assert.deepEqual(staffFacingTombstones, [{
        schoolId,
        studentId: alex.id,
        studentSessionId: alexSession.session.id,
        deviceId: handoffDeviceId,
        reason: "session_replaced",
      }]);
      assert.equal(sameDeviceLocalMessages, 0);
      assert.equal(sameDeviceRemoteMessages, 0);

      let staleAuthorityCallbackRan = false;
      const staleAuthority = await inSchool(() =>
        storage.withClasspilotScreenshotUploadAuthority({
          schoolId,
          studentId: alex.id,
          studentSessionId: alexSession.session.id,
          deviceId: handoffDeviceId,
          expectedAuthority: alexAuthority,
        }, () => {
          staleAuthorityCallbackRan = true;
        })
      );
      assert.equal(staleAuthority.status, "superseded");
      assert.equal(staleAuthorityCallbackRan, false);
      const alexLateUpload = await postDevice<DeviceResponse>(
        "/api/classpilot/device/screenshot",
        alexToken,
        {
          screenshot: alexPixels,
          tabTitle: "Late Alex capture",
          capturedAt: new Date().toISOString(),
          screenshotAuthority: alexAuthority,
        }
      );
      assert.equal(alexLateUpload.status, 401);

      const alexAfterHandoff = await readTiles([alex.id]);
      const bobBeforeCapture = await readTiles([bob.id]);
      assert.equal(alexAfterHandoff.status, 404);
      assert.equal(bobBeforeCapture.status, 200);
      assert.equal(bobBeforeCapture.body.tiles[0]?.screenshot, null);
      assert.equal(JSON.stringify(alexAfterHandoff.body).includes(alexPixels), false);
      assert.equal(JSON.stringify(bobBeforeCapture.body).includes(alexPixels), false);
      assert.equal(
        classpilotScreenshotFallback.getClassBound(alexClassBinding)?.screenshot,
        alexPixels,
        "privacy must come from exact authority, not eager deletion of the old cache entry"
      );

      const bobProjection = await inSchool(() =>
        storage.getClasspilotScreenshotAuthorityProjection({
          schoolId,
          studentId: bob.id,
          studentSessionId: handoff.session.id,
          deviceId: handoffDeviceId,
        })
      );
      assert.ok(bobProjection);
      const bobAuthority = bobProjection.authority;
      if (bobAuthority.kind !== "teaching_session") {
        throw new Error("Bob did not receive new exact teaching-session screenshot authority");
      }
      assert.equal(bobAuthority.teachingSessionId, teachingSession.id);
      const bobCapture = await retainExactClassScreenshot({
        studentId: bob.id,
        studentSessionId: handoff.session.id,
        authority: bobAuthority,
        screenshot: bobPixels,
      });
      assert.equal(bobCapture.status, "accepted");

      const finalTiles = await readTiles([alex.id, bob.id]);
      assert.equal(finalTiles.status, 200);
      const finalAlex = finalTiles.body.tiles.find((tile) => tile.studentId === alex.id);
      const finalBob = finalTiles.body.tiles.find((tile) => tile.studentId === bob.id);
      assert.equal(finalAlex, undefined);
      assert.equal(finalBob?.screenshot?.screenshot, bobPixels);
      assert.equal(JSON.stringify(finalTiles.body).includes(alexPixels), false);
    } finally {
      if (server) {
        await new Promise<void>((resolve) => {
          server!.close(() => resolve());
          server!.closeAllConnections();
        });
      }
      classpilotScreenshotFallback.clear();
      await runWithTenantContext({ isSuper: true }, async () => {
        if (teachingSessionId) {
          await db.delete(classpilotStudentControlStates).where(
            eq(classpilotStudentControlStates.teachingSessionId, teachingSessionId)
          );
          await db.delete(classpilotSessionStudents).where(
            eq(classpilotSessionStudents.teachingSessionId, teachingSessionId)
          );
          await db.delete(classpilotSessionStaff).where(
            eq(classpilotSessionStaff.teachingSessionId, teachingSessionId)
          );
          await db.delete(teachingSessions).where(eq(teachingSessions.id, teachingSessionId));
        }
        if (groupId) {
          await db.delete(groupStudents).where(eq(groupStudents.groupId, groupId));
          await db.delete(groupTeachers).where(eq(groupTeachers.groupId, groupId));
          await db.delete(groups).where(eq(groups.id, groupId));
        }
        await db.delete(heartbeats).where(eq(heartbeats.deviceId, handoffDeviceId));
        await db.delete(studentSessions).where(eq(studentSessions.deviceId, handoffDeviceId));
        await db.delete(studentDevices).where(eq(studentDevices.deviceId, handoffDeviceId));
        await db.delete(devices).where(eq(devices.deviceId, handoffDeviceId));
        for (const id of [alexId, bobId].filter(Boolean)) {
          await db.delete(students).where(eq(students.id, id));
        }
        if (teacherId) {
          await db.delete(schoolMemberships).where(eq(schoolMemberships.userId, teacherId));
          await db.delete(users).where(eq(users.id, teacherId));
        }
      });
    }
  });

  it("publishes exactly one session_replaced tombstone for one committed handoff row", async () => {
    const tombstones: Array<{
      schoolId: string;
      studentId: string;
      studentSessionId: string;
      deviceId: string;
      reason: string;
    }> = [];
    let localReplacementNotices = 0;
    let remoteReplacementNotices = 0;
    await classpilotDeviceRoutes.publishCommittedStudentSessionReplacements({
      schoolId: "school-publication-test",
      replacementDeviceId: "device-same",
      replacedSessions: [{
        id: "session-old",
        studentId: "student-old",
        deviceId: "device-same",
      }],
    }, {
      broadcastEnded: async (options) => {
        tombstones.push(options);
      },
      sendLocal: () => {
        localReplacementNotices += 1;
        return true;
      },
      publishRemote: async () => {
        remoteReplacementNotices += 1;
        return true;
      },
    });
    assert.deepEqual(tombstones, [{
      schoolId: "school-publication-test",
      studentId: "student-old",
      studentSessionId: "session-old",
      deviceId: "device-same",
      reason: "session_replaced",
    }]);
    assert.equal(localReplacementNotices, 0);
    assert.equal(remoteReplacementNotices, 0);
  });

  it("keeps cross-device and unmatched same-device authority as hard blockers", async () => {
    const requestedDeviceId = `${tag}-handoff-blocked-requested`;
    const otherDeviceId = `${tag}-handoff-blocked-other`;
    const tokenDeviceId = `${tag}-handoff-token-other-device`;
    await inSchool(() => createDevice({
      deviceId: requestedDeviceId,
      deviceName: "Requested handoff device",
      schoolId,
      classId: schoolId,
    } as Parameters<typeof createDevice>[0]));
    await inSchool(() => createDevice({
      deviceId: otherDeviceId,
      deviceName: "Other active device",
      schoolId,
      classId: schoolId,
    } as Parameters<typeof createDevice>[0]));
    await inSchool(() => createDevice({
      deviceId: tokenDeviceId,
      deviceName: "Recovery token's other device",
      schoolId,
      classId: schoolId,
    } as Parameters<typeof createDevice>[0]));
    const owner = await inSchool(() => createStudent({
      schoolId,
      firstName: "Recovery",
      lastName: "Owner",
      email: `recovery-owner@${tag}.example.edu`,
      emailLc: `recovery-owner@${tag}.example.edu`,
      status: "active",
    } as Parameters<typeof createStudent>[0]));
    const selected = await inSchool(() => createStudent({
      schoolId,
      firstName: "Selected",
      lastName: "Student",
      email: `selected-student@${tag}.example.edu`,
      emailLc: `selected-student@${tag}.example.edu`,
      status: "active",
    } as Parameters<typeof createStudent>[0]));
    const unmatched = await inSchool(() => createStudent({
      schoolId,
      firstName: "Unmatched",
      lastName: "Authority",
      email: `unmatched-authority@${tag}.example.edu`,
      emailLc: `unmatched-authority@${tag}.example.edu`,
      status: "active",
    } as Parameters<typeof createStudent>[0]));
    const tokenOwner = await inSchool(() => createStudent({
      schoolId,
      firstName: "Other Device",
      lastName: "Token Owner",
      email: `other-device-token@${tag}.example.edu`,
      emailLc: `other-device-token@${tag}.example.edu`,
      status: "active",
    } as Parameters<typeof createStudent>[0]));
    const ownerRecovery = createStudentSessionRecovery();
    const ownerSession = await inSchool(() =>
      startStudentSessionWithReplacements(schoolId, owner.id, requestedDeviceId, {
        authKind: "manual_shared",
        sessionRecoveryTokenHash: ownerRecovery.tokenHash,
      })
    );
    const selectedOtherDevice = await inSchool(() =>
      startStudentSessionWithReplacements(schoolId, selected.id, otherDeviceId, {
        authKind: "manual_shared",
        sessionRecoveryTokenHash: createStudentSessionRecovery().tokenHash,
      })
    );
    const otherDeviceRecovery = createStudentSessionRecovery();
    const otherDeviceTokenSession = await inSchool(() =>
      startStudentSessionWithReplacements(schoolId, tokenOwner.id, tokenDeviceId, {
        authKind: "manual_shared",
        sessionRecoveryTokenHash: otherDeviceRecovery.tokenHash,
      })
    );

    await assert.rejects(
      () => inSchool(() => startStudentSessionWithReplacements(
        schoolId,
        selected.id,
        requestedDeviceId,
        {
          authKind: "manual_shared",
          sessionRecoveryTokenHash: createStudentSessionRecovery().tokenHash,
          reclaimRecoveryTokenHash: ownerRecovery.tokenHash,
        }
      )),
      (error: any) => error?.code === "STUDENT_SESSION_ACTIVE"
    );
    assert.equal(
      (await inSchool(() => storage.getActiveSessionById(ownerSession.session.id)))?.id,
      ownerSession.session.id
    );
    assert.equal(
      (await inSchool(() => storage.getActiveSessionById(selectedOtherDevice.session.id)))?.id,
      selectedOtherDevice.session.id
    );

    await inSchool(() => storage.endStudentSessionExact({
      schoolId,
      studentId: selected.id,
      deviceId: otherDeviceId,
      studentSessionId: selectedOtherDevice.session.id,
    }));
    await assert.rejects(
      () => inSchool(() => startStudentSessionWithReplacements(
        schoolId,
        selected.id,
        requestedDeviceId,
        {
          authKind: "manual_shared",
          sessionRecoveryTokenHash: createStudentSessionRecovery().tokenHash,
          reclaimRecoveryTokenHash: otherDeviceRecovery.tokenHash,
        }
      )),
      (error: any) => error?.code === "STUDENT_SESSION_ACTIVE",
      "a real recovery token from another device must not authorize this device"
    );
    await assert.rejects(
      () => inSchool(() => startStudentSessionWithReplacements(
        schoolId,
        selected.id,
        requestedDeviceId,
        {
          authKind: "manual_shared",
          sessionRecoveryTokenHash: createStudentSessionRecovery().tokenHash,
          reclaimRecoveryTokenHash: createStudentSessionRecovery().tokenHash,
        }
      )),
      (error: any) => error?.code === "STUDENT_SESSION_ACTIVE",
      "a wrong, stale, or cross-school recovery digest must not authorize the device conflict"
    );

    const foreignSchool = await createSchool({
      name: `${tag} foreign recovery token`,
      domain: `${tag}-foreign-recovery.example.edu`,
      slug: `${tag}-foreign-recovery`,
      status: "active",
      planStatus: "active",
    } as Parameters<typeof createSchool>[0]);
    await storage.createProductLicense({
      schoolId: foreignSchool.id,
      product: "CLASSPILOT",
      status: "active",
    } as Parameters<typeof storage.createProductLicense>[0]);
    const foreignDeviceId = `${tag}-foreign-recovery-device`;
    const foreignRecovery = createStudentSessionRecovery();
    let foreignTokenSessionId = "";
    let foreignTokenStudentId = "";
    try {
      const foreignTokenStudent = await runWithTenantContext(
        { schoolId: foreignSchool.id },
        () => createStudent({
          schoolId: foreignSchool.id,
          firstName: "Foreign",
          lastName: "Token Owner",
          email: `foreign-token@${tag}.example.edu`,
          emailLc: `foreign-token@${tag}.example.edu`,
          status: "active",
        } as Parameters<typeof createStudent>[0])
      );
      foreignTokenStudentId = foreignTokenStudent.id;
      await runWithTenantContext({ schoolId: foreignSchool.id }, () => createDevice({
        deviceId: foreignDeviceId,
        deviceName: "Foreign recovery device",
        schoolId: foreignSchool.id,
        classId: foreignSchool.id,
      } as Parameters<typeof createDevice>[0]));
      const foreignTokenSession = await runWithTenantContext(
        { schoolId: foreignSchool.id },
        () => startStudentSessionWithReplacements(
          foreignSchool.id,
          foreignTokenStudent.id,
          foreignDeviceId,
          {
            authKind: "manual_shared",
            sessionRecoveryTokenHash: foreignRecovery.tokenHash,
          }
        )
      );
      foreignTokenSessionId = foreignTokenSession.session.id;

      await assert.rejects(
        () => inSchool(() => startStudentSessionWithReplacements(
          schoolId,
          selected.id,
          requestedDeviceId,
          {
            authKind: "manual_shared",
            sessionRecoveryTokenHash: createStudentSessionRecovery().tokenHash,
            reclaimRecoveryTokenHash: foreignRecovery.tokenHash,
          }
        )),
        (error: any) => error?.code === "STUDENT_SESSION_ACTIVE",
        "a recovery token backed by another school must not authorize this school's device"
      );
    } finally {
      await runWithTenantContext({ isSuper: true }, async () => {
        if (foreignTokenSessionId) {
          await db.delete(studentSessions).where(eq(studentSessions.id, foreignTokenSessionId));
        }
        if (foreignTokenStudentId) {
          await db.delete(studentDevices).where(eq(studentDevices.studentId, foreignTokenStudentId));
        }
        await db.delete(devices).where(eq(devices.schoolId, foreignSchool.id));
        await db.delete(students).where(eq(students.schoolId, foreignSchool.id));
        await db.delete(productLicenses).where(eq(productLicenses.schoolId, foreignSchool.id));
        await db.delete(schools).where(eq(schools.id, foreignSchool.id));
      });
    }

    await assert.rejects(
      () => inSchool(() => db.insert(studentSessions).values({
        studentId: unmatched.id,
        deviceId: requestedDeviceId,
        authKind: "managed_profile",
      })),
      (error: any) =>
        error?.constraint === "student_sessions_active_device_unique"
        || error?.cause?.constraint === "student_sessions_active_device_unique",
      "the database must prevent two active rows from existing on one device"
    );
    await inSchool(() => storage.endStudentSessionExact({
      schoolId,
      studentId: owner.id,
      deviceId: requestedDeviceId,
      studentSessionId: ownerSession.session.id,
    }));

    const unmatchedManaged = await inSchool(() =>
      startStudentSessionWithReplacements(
        schoolId,
        unmatched.id,
        requestedDeviceId,
        { authKind: "managed_profile" }
      )
    );
    await assert.rejects(
      () => inSchool(() => startStudentSessionWithReplacements(
        schoolId,
        selected.id,
        requestedDeviceId,
        {
          authKind: "manual_shared",
          sessionRecoveryTokenHash: createStudentSessionRecovery().tokenHash,
          reclaimRecoveryTokenHash: ownerRecovery.tokenHash,
        }
      )),
      (error: any) => error?.code === "STUDENT_SESSION_ACTIVE",
      "a stale manual recovery capability must not replace managed authority"
    );
    assert.equal(
      (await inSchool(() => storage.getActiveSessionById(unmatchedManaged.session.id)))?.id,
      unmatchedManaged.session.id
    );
    await inSchool(() => storage.endStudentSessionExact({
      schoolId,
      studentId: unmatched.id,
      deviceId: requestedDeviceId,
      studentSessionId: unmatchedManaged.session.id,
    }));

    const [unmatchedLegacy] = await inSchool(() => db.insert(studentSessions).values({
      studentId: unmatched.id,
      deviceId: requestedDeviceId,
      authKind: "legacy",
    }).returning());
    await assert.rejects(
      () => inSchool(() => startStudentSessionWithReplacements(
        schoolId,
        selected.id,
        requestedDeviceId,
        {
          authKind: "manual_shared",
          sessionRecoveryTokenHash: createStudentSessionRecovery().tokenHash,
          reclaimRecoveryTokenHash: ownerRecovery.tokenHash,
        }
      )),
      (error: any) => error?.code === "STUDENT_SESSION_ACTIVE",
      "a stale manual recovery capability must not replace legacy authority"
    );
    await inSchool(() => storage.endStudentSessionExact({
      schoolId,
      studentId: unmatched.id,
      deviceId: requestedDeviceId,
      studentSessionId: unmatchedLegacy!.id,
    }));
    await inSchool(() => storage.endStudentSessionExact({
      schoolId,
      studentId: tokenOwner.id,
      deviceId: tokenDeviceId,
      studentSessionId: otherDeviceTokenSession.session.id,
    }));
  });

  it("treats an expired recovered row as non-authoritative rather than token authority", async () => {
    const expiredDeviceId = `${tag}-expired-handoff-device`;
    await inSchool(() => createDevice({
      deviceId: expiredDeviceId,
      deviceName: "Expired handoff device",
      schoolId,
      classId: schoolId,
    } as Parameters<typeof createDevice>[0]));
    const expiredOwner = await inSchool(() => createStudent({
      schoolId,
      firstName: "Expired",
      lastName: "Owner",
      email: `expired-owner@${tag}.example.edu`,
      emailLc: `expired-owner@${tag}.example.edu`,
      status: "active",
    } as Parameters<typeof createStudent>[0]));
    const nextStudent = await inSchool(() => createStudent({
      schoolId,
      firstName: "Expired",
      lastName: "Replacement",
      email: `expired-replacement@${tag}.example.edu`,
      emailLc: `expired-replacement@${tag}.example.edu`,
      status: "active",
    } as Parameters<typeof createStudent>[0]));
    const expiredRecovery = createStudentSessionRecovery();
    const expired = await inSchool(() => startStudentSessionWithReplacements(
      schoolId,
      expiredOwner.id,
      expiredDeviceId,
      {
        authKind: "manual_shared",
        sessionRecoveryTokenHash: expiredRecovery.tokenHash,
      }
    ));
    await inSchool(() => db.update(studentSessions)
      .set({ manualLeaseExpiresAt: sql`now()` })
      .where(eq(studentSessions.id, expired.session.id)));

    const replacement = await inSchool(() => startStudentSessionWithReplacements(
      schoolId,
      nextStudent.id,
      expiredDeviceId,
      {
        authKind: "manual_shared",
        sessionRecoveryTokenHash: createStudentSessionRecovery().tokenHash,
        reclaimRecoveryTokenHash: expiredRecovery.tokenHash,
      }
    ));
    assert.equal(replacement.crossStudentHandoff, false);
    assert.deepEqual(replacement.replacedSessions.map((row) => row.id), [expired.session.id]);
    await inSchool(() => storage.endStudentSessionExact({
      schoolId,
      studentId: nextStudent.id,
      deviceId: expiredDeviceId,
      studentSessionId: replacement.session.id,
    }));
  });

  it("serializes a recovery release racing a cross-student login", async () => {
    const raceDeviceId = `${tag}-handoff-release-race`;
    await inSchool(() => createDevice({
      deviceId: raceDeviceId,
      deviceName: "Release race device",
      schoolId,
      classId: schoolId,
    } as Parameters<typeof createDevice>[0]));
    const raceOwner = await inSchool(() => createStudent({
      schoolId,
      firstName: "Race",
      lastName: "Owner",
      email: `race-owner@${tag}.example.edu`,
      emailLc: `race-owner@${tag}.example.edu`,
      status: "active",
    } as Parameters<typeof createStudent>[0]));
    const raceSelected = await inSchool(() => createStudent({
      schoolId,
      firstName: "Race",
      lastName: "Selected",
      email: `race-selected@${tag}.example.edu`,
      emailLc: `race-selected@${tag}.example.edu`,
      status: "active",
    } as Parameters<typeof createStudent>[0]));
    const raceRecovery = createStudentSessionRecovery();
    const old = await inSchool(() => startStudentSessionWithReplacements(
      schoolId,
      raceOwner.id,
      raceDeviceId,
      {
        authKind: "manual_shared",
        sessionRecoveryTokenHash: raceRecovery.tokenHash,
      }
    ));

    const [releaseResult, loginResult] = await Promise.allSettled([
      inSchool(() => storage.endStudentSessionByRecoveryTokenHash({
        schoolId,
        tokenHash: raceRecovery.tokenHash,
      })),
      inSchool(() => startStudentSessionWithReplacements(
        schoolId,
        raceSelected.id,
        raceDeviceId,
        {
          authKind: "manual_shared",
          sessionRecoveryTokenHash: createStudentSessionRecovery().tokenHash,
          reclaimRecoveryTokenHash: raceRecovery.tokenHash,
        }
      )),
    ]);
    assert.equal(releaseResult.status, "fulfilled");
    assert.equal(loginResult.status, "fulfilled");
    assert.ok(loginResult.status === "fulfilled");
    const replacement = loginResult.value;
    assert.equal(
      (await inSchool(() => storage.getActiveSessionById(replacement.session.id)))?.studentId,
      raceSelected.id
    );
    assert.equal(await inSchool(() => storage.getActiveSessionById(old.session.id)), undefined);
    assert.equal(
      await inSchool(() => storage.endStudentSessionByRecoveryTokenHash({
        schoolId,
        tokenHash: raceRecovery.tokenHash,
      })),
      undefined,
      "a late completion of the old release cannot end the replacement"
    );
    const activeRows = await inSchool(() => db.select({
      id: studentSessions.id,
      studentId: studentSessions.studentId,
    }).from(studentSessions).where(and(
      eq(studentSessions.deviceId, raceDeviceId),
      eq(studentSessions.isActive, true),
      sql`${studentSessions.endedAt} IS NULL`
    )));
    assert.deepEqual(activeRows, [{ id: replacement.session.id, studentId: raceSelected.id }]);
    await inSchool(() => storage.endStudentSessionExact({
      schoolId,
      studentId: raceSelected.id,
      deviceId: raceDeviceId,
      studentSessionId: replacement.session.id,
    }));
  });

  it("validates PIN and email/ID credentials before cross-student replacement", async () => {
    const enrollmentKey = `${tag}-handoff-enrollment-key`;
    const pinDeviceId = `${tag}-handoff-pin-device`;
    const emailDeviceId = `${tag}-handoff-email-device`;
    await inSchool(() => createDevice({
      deviceId: pinDeviceId,
      deviceName: "PIN handoff device",
      schoolId,
      classId: schoolId,
    } as Parameters<typeof createDevice>[0]));
    await inSchool(() => createDevice({
      deviceId: emailDeviceId,
      deviceName: "Email handoff device",
      schoolId,
      classId: schoolId,
    } as Parameters<typeof createDevice>[0]));
    const pinOwner = await inSchool(() => createStudent({
      schoolId,
      firstName: "Pin",
      lastName: "Owner",
      email: `pin-owner@${tag}.example.edu`,
      emailLc: `pin-owner@${tag}.example.edu`,
      status: "active",
    } as Parameters<typeof createStudent>[0]));
    const pinHash = await hashPassword("2468");
    const pinSelected = await inSchool(() => createStudent({
      schoolId,
      firstName: "Pin",
      lastName: "Selected",
      email: `pin-selected@${tag}.example.edu`,
      emailLc: `pin-selected@${tag}.example.edu`,
      classpilotPinHash: pinHash,
      status: "active",
    } as Parameters<typeof createStudent>[0]));
    const emailOwner = await inSchool(() => createStudent({
      schoolId,
      firstName: "Email",
      lastName: "Owner",
      email: `email-owner@${tag}.example.edu`,
      emailLc: `email-owner@${tag}.example.edu`,
      status: "active",
    } as Parameters<typeof createStudent>[0]));
    const emailSelected = await inSchool(() => createStudent({
      schoolId,
      firstName: "Email",
      lastName: "Selected",
      email: `email-selected@${tag}.example.edu`,
      emailLc: `email-selected@${tag}.example.edu`,
      studentIdNumber: `${tag}-student-number`,
      status: "active",
    } as Parameters<typeof createStudent>[0]));
    const pinOwnerRecovery = createStudentSessionRecovery();
    const pinOwnerSession = await inSchool(() =>
      startStudentSessionWithReplacements(schoolId, pinOwner.id, pinDeviceId, {
        authKind: "manual_shared",
        sessionRecoveryTokenHash: pinOwnerRecovery.tokenHash,
      })
    );
    const emailOwnerRecovery = createStudentSessionRecovery();
    const emailOwnerSession = await inSchool(() =>
      startStudentSessionWithReplacements(schoolId, emailOwner.id, emailDeviceId, {
        authKind: "manual_shared",
        sessionRecoveryTokenHash: emailOwnerRecovery.tokenHash,
      })
    );

    await inSchool(() => storage.upsertSettings(schoolId, {
      enrollmentKey,
      enrollmentKeyRequired: true,
      sharedChromebookSignInEnabled: true,
      sharedChromebookLoginMethod: "name_pin",
      sharedChromebookPinLoginEnabled: true,
    }));
    heartbeatMetrics.snapshotHeartbeatHotPathMetrics({ reset: true });
    const { createApp } = await import("../dist/app.js");
    const server = createServer(createApp());
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    const login = (body: Record<string, unknown>, recoveryToken: string) => fetch(
      `http://127.0.0.1:${port}/api/classpilot/extension/student-login`,
      {
        method: "POST",
        headers: {
          authorization: `ClassPilot-Recovery ${recoveryToken}`,
          "content-type": "application/json",
          "x-classpilot-enrollment-key": enrollmentKey,
        },
        body: JSON.stringify({ schoolId, ...body }),
      }
    );
    type StudentLoginResponse = {
      student?: { id?: string };
      studentSessionId: string;
      sessionRecovery?: { token?: string };
      managedDeviceContinuityAccepted?: boolean;
    };
    try {
      const wrongPin = await login({
        deviceId: pinDeviceId,
        studentId: pinSelected.id,
        pin: "1357",
      }, pinOwnerRecovery.token);
      assert.equal(wrongPin.status, 401);
      assert.equal(
        (await inSchool(() => storage.getActiveSessionById(pinOwnerSession.session.id)))?.id,
        pinOwnerSession.session.id,
        "an incorrect selected-student PIN must not consume the recovery session"
      );

      const correctPin = await login({
        deviceId: pinDeviceId,
        studentId: pinSelected.id,
        pin: "2468",
      }, pinOwnerRecovery.token);
      assert.equal(correctPin.status, 200);
      const pinBody = await correctPin.json() as StudentLoginResponse;
      assert.equal("managedDeviceContinuityAccepted" in pinBody, false);
      assert.equal(pinBody.student?.id, pinSelected.id);
      assert.match(pinBody.sessionRecovery?.token || "", /^[A-Za-z0-9_-]{43}$/);
      assert.equal(
        await inSchool(() => storage.getActiveSessionById(pinOwnerSession.session.id)),
        undefined
      );

      await inSchool(() => storage.endStudentSessionExact({
        schoolId,
        studentId: pinSelected.id,
        deviceId: pinDeviceId,
        studentSessionId: pinBody.studentSessionId,
      }));
      await inSchool(() => storage.upsertSettings(schoolId, {
        enrollmentKey,
        enrollmentKeyRequired: true,
        sharedChromebookSignInEnabled: true,
        sharedChromebookLoginMethod: "email_id",
        sharedChromebookPinLoginEnabled: false,
      }));

      const wrongId = await login({
        deviceId: emailDeviceId,
        studentEmail: emailSelected.email,
        studentIdNumber: "wrong-id",
      }, emailOwnerRecovery.token);
      assert.equal(wrongId.status, 401);
      assert.equal(
        (await inSchool(() => storage.getActiveSessionById(emailOwnerSession.session.id)))?.id,
        emailOwnerSession.session.id,
        "incorrect email/ID credentials must not consume the recovery session"
      );

      const correctEmailId = await login({
        deviceId: emailDeviceId,
        studentEmail: emailSelected.email,
        studentIdNumber: emailSelected.studentIdNumber,
      }, emailOwnerRecovery.token);
      assert.equal(correctEmailId.status, 200);
      const emailBody = await correctEmailId.json() as StudentLoginResponse;
      assert.equal("managedDeviceContinuityAccepted" in emailBody, false);
      assert.equal(emailBody.student?.id, emailSelected.id);
      assert.match(emailBody.sessionRecovery?.token || "", /^[A-Za-z0-9_-]{43}$/);
      assert.equal(
        await inSchool(() => storage.getActiveSessionById(emailOwnerSession.session.id)),
        undefined
      );

      const metricSnapshot = heartbeatMetrics.snapshotHeartbeatHotPathMetrics({ reset: true });
      assert.equal(metricSnapshot.counters.manualSessionCrossStudentHandoff, 2);
      assert.deepEqual(
        Object.keys(metricSnapshot.counters).filter((key) =>
          key === "manualSessionCrossStudentHandoff"
        ),
        ["manualSessionCrossStudentHandoff"],
        "the handoff metric is a process-wide counter with no identifier dimensions"
      );
      await inSchool(() => storage.endStudentSessionExact({
        schoolId,
        studentId: emailSelected.id,
        deviceId: emailDeviceId,
        studentSessionId: emailBody.studentSessionId,
      }));
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => error ? reject(error) : resolve())
      );
    }
  });

  it("atomically transitions an exact recovered random binding to stable managed-device authority", async (t) => {
    const enrollmentKey = `${tag}-managed-continuity-key`;
    const rawDirectoryDeviceId = `${tag}-directory-device`;
    const untrustedBodyDeviceId = `${tag}-untrusted-body-device`;
    const oldRandomDeviceId = `${tag}-old-random-device`;
    const oldStudent = await inSchool(() => createStudent({
      schoolId,
      firstName: "Old",
      lastName: "Managed Owner",
      email: `managed-old@${tag}.example.edu`,
      emailLc: `managed-old@${tag}.example.edu`,
      gradeLevel: "5",
      status: "active",
    } as Parameters<typeof createStudent>[0]));
    const selectedPinHash = await hashPassword("8642");
    const selectedStudent = await inSchool(() => createStudent({
      schoolId,
      firstName: "New",
      lastName: "Managed Student",
      email: `managed-new@${tag}.example.edu`,
      emailLc: `managed-new@${tag}.example.edu`,
      gradeLevel: "5",
      studentIdNumber: "managed-8642",
      classpilotPinHash: selectedPinHash,
      status: "active",
    } as Parameters<typeof createStudent>[0]));
    await inSchool(() => createDevice({
      deviceId: oldRandomDeviceId,
      deviceName: "Pre-continuity random binding",
      schoolId,
      classId: schoolId,
    } as Parameters<typeof createDevice>[0]));
    const oldRecovery = createStudentSessionRecovery();
    const oldSession = await inSchool(() => startStudentSessionWithReplacements(
      schoolId,
      oldStudent.id,
      oldRandomDeviceId,
      {
        authKind: "manual_shared",
        sessionRecoveryTokenHash: oldRecovery.tokenHash,
      }
    ));
    await inSchool(() => storage.upsertSettings(schoolId, {
      enrollmentKey,
      enrollmentKeyRequired: true,
      sharedChromebookSignInEnabled: true,
      sharedChromebookLoginMethod: "name_pin",
      sharedChromebookPinLoginEnabled: true,
    }));

    heartbeatMetrics.snapshotHeartbeatHotPathMetrics({ reset: true });
    const expectedMetricNames = [
      "managedDeviceContinuityPreflightAccepted",
      "managedDeviceContinuityProofIssued",
      "managedDeviceContinuityReclaimOffered",
      "managedDeviceContinuityLoginIssued",
      "managedDeviceContinuityRecoveryTransitioned",
      "manualSessionCrossStudentHandoff",
    ] as const;
    const emittedMetricCounters: Partial<Record<(typeof expectedMetricNames)[number], number>> = {};
    const originalConsoleLog = console.log;
    t.mock.method(console, "log", (...args: unknown[]) => {
      originalConsoleLog(...args);
      if (typeof args[0] !== "string") return;
      try {
        const event = JSON.parse(args[0]) as {
          event?: unknown;
          counters?: Record<string, unknown>;
        };
        if (event.event !== "classpilot_heartbeat_hot_path_summary") return;
        for (const name of expectedMetricNames) {
          const value = event.counters?.[name];
          if (typeof value === "number") {
            emittedMetricCounters[name] = (emittedMetricCounters[name] ?? 0) + value;
          }
        }
      } catch {
        // Non-JSON application logging is unrelated to this aggregate metric.
      }
    });
    const { createApp } = await import("../dist/app.js");
    const server = createServer(createApp());
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${port}/api`;
    try {
      const preflight = await fetch(
        `${baseUrl}/extension/device-continuity/preflight`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-school-id": schoolId,
            "x-classpilot-enrollment-key": enrollmentKey,
          },
          body: JSON.stringify({
            clientProtocolVersion: 3,
            capabilities: [
              "scopedAuthorityChecksV1",
              "kioskLaunchTicketV2",
              "managedDeviceContinuityV1",
            ],
          }),
        }
      );
      assert.equal(preflight.status, 200);
      const preflightBody = await preflight.json() as {
        preflightToken?: string;
        acceptedCapabilities?: string[];
      };
      assert.match(preflightBody.preflightToken || "", /^cpmp1\./);
      assert.deepEqual(preflightBody.acceptedCapabilities, [
        "scopedAuthorityChecksV1",
        "kioskLaunchTicketV2",
        "managedDeviceContinuityV1",
      ]);

      const issuance = await fetch(
        `${baseUrl}/classpilot/extension/device-continuity`,
        {
          method: "POST",
          headers: {
            authorization: `ClassPilot-Preflight ${preflightBody.preflightToken}`,
            "content-type": "application/json",
            "x-school-id": schoolId,
            "x-classpilot-enrollment-key": enrollmentKey,
          },
          body: JSON.stringify({
            directoryDeviceId: rawDirectoryDeviceId,
            recoveryToken: oldRecovery.token,
          }),
        }
      );
      assert.equal(issuance.status, 201);
      const issuanceText = await issuance.text();
      assert.equal(issuanceText.includes(rawDirectoryDeviceId), false);
      assert.equal(issuanceText.includes(oldRecovery.token), false);
      const issuanceBody = JSON.parse(issuanceText) as { continuityProof?: string };
      assert.match(issuanceBody.continuityProof || "", /^cpmd1\./);

      const roster = await fetch(
        `${baseUrl}/classpilot/extension/login-roster?schoolId=${encodeURIComponent(schoolId)}&gradeLevel=5`,
        {
          headers: {
            authorization: `ClassPilot-Device ${issuanceBody.continuityProof}`,
            "x-classpilot-enrollment-key": enrollmentKey,
          },
        }
      );
      assert.equal(roster.status, 200);
      const rosterBody = await roster.json() as {
        students?: Array<{ id?: string; reclaimable?: boolean }>;
        managedDeviceContinuityAccepted?: boolean;
      };
      assert.equal(rosterBody.managedDeviceContinuityAccepted, true);
      assert.equal(
        rosterBody.students?.some((row) =>
          row.id === oldStudent.id && row.reclaimable === true
        ),
        true,
        "the proof must carry the old exact recovery authority across the random-to-stable transition"
      );
      assert.equal(
        rosterBody.students?.some((row) => row.id === selectedStudent.id),
        true
      );

      const legacyRoster = await fetch(
        `${baseUrl}/classpilot/extension/login-roster?schoolId=${encodeURIComponent(schoolId)}&gradeLevel=5`,
        { headers: { "x-classpilot-enrollment-key": enrollmentKey } }
      );
      assert.equal(legacyRoster.status, 200);
      const legacyRosterBody = await legacyRoster.json() as Record<string, unknown>;
      assert.equal(
        "managedDeviceContinuityAccepted" in legacyRosterBody,
        false,
        "legacy roster requests retain their existing response shape"
      );

      const wrongPin = await fetch(
        `${baseUrl}/classpilot/extension/student-login`,
        {
          method: "POST",
          headers: {
            authorization: `ClassPilot-Device ${issuanceBody.continuityProof}`,
            "content-type": "application/json",
            "x-classpilot-enrollment-key": enrollmentKey,
          },
          body: JSON.stringify({
            schoolId,
            deviceId: untrustedBodyDeviceId,
            studentId: selectedStudent.id,
            pin: "0000",
          }),
        }
      );
      assert.equal(wrongPin.status, 401);
      assert.equal(
        (await wrongPin.json() as { managedDeviceContinuityAccepted?: boolean })
          .managedDeviceContinuityAccepted,
        true
      );
      assert.equal(
        (await inSchool(() => storage.getActiveSessionById(oldSession.session.id)))?.id,
        oldSession.session.id,
        "invalid selected-student credentials cannot consume transition authority"
      );

      const login = await fetch(
        `${baseUrl}/classpilot/extension/student-login`,
        {
          method: "POST",
          headers: {
            authorization: `ClassPilot-Device ${issuanceBody.continuityProof}`,
            "content-type": "application/json",
            "x-classpilot-enrollment-key": enrollmentKey,
          },
          body: JSON.stringify({
            schoolId,
            deviceId: untrustedBodyDeviceId,
            studentId: selectedStudent.id,
            pin: "8642",
          }),
        }
      );
      assert.equal(login.status, 200);
      const loginBody = await login.json() as {
        studentSessionId?: string;
        studentToken?: string;
        effectiveDeviceId?: string;
        managedDeviceContinuityAccepted?: boolean;
      };
      assert.equal(loginBody.managedDeviceContinuityAccepted, true);
      const expectedStableDeviceId =
        managedDeviceContinuity.issueClasspilotManagedDeviceContinuityProof({
          schoolId,
          directoryDeviceId: rawDirectoryDeviceId,
        });
      const expectedProof = managedDeviceContinuity.verifyClasspilotManagedDeviceContinuityProof({
        token: expectedStableDeviceId.continuityProof,
        schoolId,
      });
      assert.ok(expectedProof);
      assert.equal(loginBody.effectiveDeviceId, expectedProof.deviceId);
      assert.notEqual(loginBody.effectiveDeviceId, untrustedBodyDeviceId);
      assert.equal(await inSchool(() => storage.getActiveSessionById(oldSession.session.id)), undefined);
      const active = await inSchool(() => storage.getActiveSessionById(loginBody.studentSessionId!));
      assert.equal(active?.studentId, selectedStudent.id);
      assert.equal(active?.deviceId, expectedProof.deviceId);
      assert.equal(verifyStudentToken(loginBody.studentToken!).deviceId, expectedProof.deviceId);

      const delayedRelease = await fetch(
        `${baseUrl}/classpilot/extension/session-release`,
        {
          method: "POST",
          headers: {
            authorization: `ClassPilot-Recovery ${oldRecovery.token}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ schoolId }),
        }
      );
      assert.equal(delayedRelease.status, 204);
      assert.equal(
        (await inSchool(() => storage.getActiveSessionById(loginBody.studentSessionId!)))?.id,
        loginBody.studentSessionId,
        "delayed cleanup for the old random binding cannot end the stable replacement"
      );

      const otherManagedProof = managedDeviceContinuity.issueClasspilotManagedDeviceContinuityProof({
        schoolId,
        directoryDeviceId: `${rawDirectoryDeviceId}-other`,
      });
      const crossDevice = await fetch(
        `${baseUrl}/classpilot/extension/student-login`,
        {
          method: "POST",
          headers: {
            authorization: `ClassPilot-Device ${otherManagedProof.continuityProof}`,
            "content-type": "application/json",
            "x-classpilot-enrollment-key": enrollmentKey,
          },
          body: JSON.stringify({
            schoolId,
            deviceId: "ignored",
            studentId: selectedStudent.id,
            pin: "8642",
          }),
        }
      );
      assert.equal(crossDevice.status, 409);
      const crossDeviceBody = await crossDevice.json() as {
        code?: string;
        managedDeviceContinuityAccepted?: boolean;
      };
      assert.equal(crossDeviceBody.code, "STUDENT_SESSION_ACTIVE");
      assert.equal(crossDeviceBody.managedDeviceContinuityAccepted, true);

      await inSchool(() => storage.upsertSettings(schoolId, {
        enrollmentKey,
        enrollmentKeyRequired: true,
        sharedChromebookSignInEnabled: true,
        sharedChromebookLoginMethod: "email_id",
        sharedChromebookPinLoginEnabled: false,
      }));
      const emailConflict = await fetch(
        `${baseUrl}/classpilot/extension/student-login`,
        {
          method: "POST",
          headers: {
            authorization: `ClassPilot-Device ${otherManagedProof.continuityProof}`,
            "content-type": "application/json",
            "x-classpilot-enrollment-key": enrollmentKey,
          },
          body: JSON.stringify({
            schoolId,
            deviceId: "ignored",
            studentEmail: selectedStudent.email,
            studentIdNumber: selectedStudent.studentIdNumber,
          }),
        }
      );
      assert.equal(emailConflict.status, 409);
      const emailConflictBody = await emailConflict.json() as {
        code?: string;
        managedDeviceContinuityAccepted?: boolean;
      };
      assert.equal(emailConflictBody.code, "STUDENT_SESSION_ACTIVE");
      assert.equal(emailConflictBody.managedDeviceContinuityAccepted, true);

      const metrics = heartbeatMetrics.snapshotHeartbeatHotPathMetrics({ reset: true });
      for (const name of expectedMetricNames) {
        assert.equal(
          (emittedMetricCounters[name] ?? 0) + (metrics.counters[name] ?? 0),
          1,
          `${name} must be emitted exactly once across rotated and live aggregate metrics`
        );
      }

      await inSchool(() => storage.endStudentSessionExact({
        schoolId,
        studentId: selectedStudent.id,
        deviceId: expectedProof.deviceId,
        studentSessionId: loginBody.studentSessionId!,
      }));
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => error ? reject(error) : resolve())
      );
    }
  });

  it("serializes concurrent proof reuse and permits bounded credentialed sequential handoff", async () => {
    const enrollmentKey = `${tag}-managed-continuity-race-key`;
    const oldRandomDeviceId = `${tag}-managed-race-old-random`;
    const rawDirectoryDeviceId = `${tag}-managed-race-directory`;
    const pinHash = await hashPassword("9753");
    const oldStudent = await inSchool(() => createStudent({
      schoolId,
      firstName: "Race",
      lastName: "Old Owner",
      email: `managed-race-old@${tag}.example.edu`,
      emailLc: `managed-race-old@${tag}.example.edu`,
      status: "active",
    } as Parameters<typeof createStudent>[0]));
    const candidates = await Promise.all(["One", "Two"].map((suffix) =>
      inSchool(() => createStudent({
        schoolId,
        firstName: "Race",
        lastName: suffix,
        email: `managed-race-${suffix.toLowerCase()}@${tag}.example.edu`,
        emailLc: `managed-race-${suffix.toLowerCase()}@${tag}.example.edu`,
        classpilotPinHash: pinHash,
        status: "active",
      } as Parameters<typeof createStudent>[0]))
    ));
    await inSchool(() => createDevice({
      deviceId: oldRandomDeviceId,
      deviceName: "Managed continuity race old device",
      schoolId,
      classId: schoolId,
    } as Parameters<typeof createDevice>[0]));
    const recovery = createStudentSessionRecovery();
    const old = await inSchool(() => startStudentSessionWithReplacements(
      schoolId,
      oldStudent.id,
      oldRandomDeviceId,
      {
        authKind: "manual_shared",
        sessionRecoveryTokenHash: recovery.tokenHash,
      }
    ));
    await inSchool(() => storage.upsertSettings(schoolId, {
      enrollmentKey,
      enrollmentKeyRequired: true,
      sharedChromebookSignInEnabled: true,
      sharedChromebookLoginMethod: "name_pin",
      sharedChromebookPinLoginEnabled: true,
    }));
    const issuedProof = managedDeviceContinuity.issueClasspilotManagedDeviceContinuityProof({
      schoolId,
      directoryDeviceId: rawDirectoryDeviceId,
      recoveryToken: recovery.token,
    });
    const verifiedProof = managedDeviceContinuity.verifyClasspilotManagedDeviceContinuityProof({
      token: issuedProof.continuityProof,
      schoolId,
    });
    assert.ok(verifiedProof);

    const { createApp } = await import("../dist/app.js");
    const server = createServer(createApp());
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    try {
      const responses = await Promise.all(candidates.map((candidate) => fetch(
        `http://127.0.0.1:${port}/api/classpilot/extension/student-login`,
        {
          method: "POST",
          headers: {
            authorization: `ClassPilot-Device ${issuedProof.continuityProof}`,
            "content-type": "application/json",
            "x-classpilot-enrollment-key": enrollmentKey,
          },
          body: JSON.stringify({
            schoolId,
            deviceId: `${tag}-ignored-${candidate.id}`,
            studentId: candidate.id,
            pin: "9753",
          }),
        }
      )));
      assert.deepEqual(
        responses.map((response) => response.status).sort(),
        [200, 409],
        "one transition wins and the stale proof cannot replace that winner"
      );
      const successfulIndex = responses.findIndex((response) => response.status === 200);
      const winnerBody = await responses[successfulIndex]!.json() as {
        studentSessionId: string;
        effectiveDeviceId: string;
      };
      assert.equal(winnerBody.effectiveDeviceId, verifiedProof.deviceId);
      assert.equal(await inSchool(() => storage.getActiveSessionById(old.session.id)), undefined);
      const active = await inSchool(() => storage.getActiveSessionById(winnerBody.studentSessionId));
      assert.equal(active?.studentId, candidates[successfulIndex]!.id);
      assert.equal(active?.deviceId, verifiedProof.deviceId);
      const loser = responses.find((response) => response.status === 409)!;
      assert.ok(
        ["STUDENT_SESSION_ACTIVE", "STUDENT_SESSION_REPLACED"].includes(
          (await loser.json() as { code?: string }).code || ""
        ),
        "the losing request is rejected whether it observes the winner before or after issuance"
      );

      // The stateless proof is deliberately reusable for its bounded lifetime:
      // roster fetch and subsequent same-Chromebook handoffs still require the
      // newly selected student's credentials. The extension discards it after
      // success, but a credentialed sequential replay remains safe authority
      // for this one derived device rather than a cross-device takeover.
      const nextIndex = successfulIndex === 0 ? 1 : 0;
      const sequential = await fetch(
        `http://127.0.0.1:${port}/api/classpilot/extension/student-login`,
        {
          method: "POST",
          headers: {
            authorization: `ClassPilot-Device ${issuedProof.continuityProof}`,
            "content-type": "application/json",
            "x-classpilot-enrollment-key": enrollmentKey,
          },
          body: JSON.stringify({
            schoolId,
            deviceId: `${tag}-ignored-sequential-replay`,
            studentId: candidates[nextIndex]!.id,
            pin: "9753",
          }),
        }
      );
      assert.equal(sequential.status, 200);
      const sequentialBody = await sequential.json() as {
        studentSessionId: string;
        effectiveDeviceId: string;
      };
      assert.equal(sequentialBody.effectiveDeviceId, verifiedProof.deviceId);
      assert.equal(
        await inSchool(() => storage.getActiveSessionById(winnerBody.studentSessionId)),
        undefined
      );
      const sequentialActive = await inSchool(() =>
        storage.getActiveSessionById(sequentialBody.studentSessionId)
      );
      assert.equal(sequentialActive?.studentId, candidates[nextIndex]!.id);
      assert.equal(sequentialActive?.deviceId, verifiedProof.deviceId);

      await inSchool(() => storage.endStudentSessionExact({
        schoolId,
        studentId: candidates[nextIndex]!.id,
        deviceId: verifiedProof.deviceId,
        studentSessionId: sequentialBody.studentSessionId,
      }));
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => error ? reject(error) : resolve())
      );
    }
  });

  it("offers a gate-visible manual student and atomically transfers a correct-PIN login", async () => {
    const gateSchoolEnrollmentKey = `${tag}-gate-presence-key`;
    const sourceRecovery = createStudentSessionRecovery();
    const sourceContinuity = managedDeviceContinuity.issueClasspilotManagedDeviceContinuityProof({
      schoolId,
      directoryDeviceId: `${tag}-gate-source-directory`,
      recoveryToken: sourceRecovery.token,
    });
    const verifiedSourceContinuity =
      managedDeviceContinuity.verifyClasspilotManagedDeviceContinuityProof({
        token: sourceContinuity.continuityProof,
        schoolId,
      });
    assert.ok(verifiedSourceContinuity);
    const gateSourceDeviceId = verifiedSourceContinuity.deviceId;
    const gateTargetDeviceId = `${tag}-gate-target-device`;
    const gatePin = "7913";
    const gatePinHash = await hashPassword(gatePin);
    const gateStudent = await inSchool(() => createStudent({
      schoolId,
      firstName: "Gate",
      lastName: "Transfer",
      email: `gate-transfer@${tag}.example.edu`,
      emailLc: `gate-transfer@${tag}.example.edu`,
      gradeLevel: "7",
      classpilotPinHash: gatePinHash,
      status: "active",
    } as Parameters<typeof createStudent>[0]));
    await inSchool(() => createDevice({
      deviceId: gateSourceDeviceId,
      deviceName: "Gate transfer source",
      schoolId,
      classId: schoolId,
    } as Parameters<typeof createDevice>[0]));
    const source = await inSchool(() => startStudentSessionWithReplacements(
      schoolId,
      gateStudent.id,
      gateSourceDeviceId,
      {
        authKind: "manual_shared",
        sessionRecoveryTokenHash: sourceRecovery.tokenHash,
      }
    ));
    await inSchool(() => storage.upsertSettings(schoolId, {
      enrollmentKey: gateSchoolEnrollmentKey,
      enrollmentKeyRequired: true,
      sharedChromebookSignInEnabled: true,
      sharedChromebookLoginMethod: "name_pin",
      sharedChromebookPinLoginEnabled: true,
    }));

    const { createApp } = await import("../dist/app.js");
    const server = createServer(createApp());
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${port}/api/extension`;
    try {
      const rosterHeaders = {
        "x-classpilot-enrollment-key": gateSchoolEnrollmentKey,
      };
      const beforePresence = await fetch(
        `${baseUrl}/login-roster?schoolId=${encodeURIComponent(schoolId)}&gradeLevel=7`,
        { headers: rosterHeaders }
      );
      assert.equal(beforePresence.status, 200);
      assert.equal(
        ((await beforePresence.json()) as { students: Array<{ id: string }> })
          .students.some((row) => row.id === gateStudent.id),
        false,
        "a fresh active student must remain hidden before the gate signal"
      );

      const protocolUpgrade = await fetch(`${baseUrl}/session-gate-presence`, {
        method: "POST",
        headers: {
          authorization: `ClassPilot-Recovery ${sourceRecovery.token}`,
          "content-type": "application/json",
          ...rosterHeaders,
        },
        body: JSON.stringify({
          schoolId,
          clientProtocolVersion: 3,
          capabilities: ["scopedAuthorityChecksV1"],
        }),
      });
      assert.equal(protocolUpgrade.status, 426);
      assert.equal(
        (await protocolUpgrade.json() as { code?: string }).code,
        "CLASSPILOT_PROTOCOL_UPGRADE_REQUIRED"
      );

      const unsupportedProtocol = await fetch(`${baseUrl}/session-gate-presence`, {
        method: "POST",
        headers: {
          authorization: `ClassPilot-Recovery ${sourceRecovery.token}`,
          "content-type": "application/json",
          ...rosterHeaders,
        },
        body: JSON.stringify({
          schoolId,
          clientProtocolVersion: 2,
          capabilities: ["scopedAuthorityChecksV1", "studentAuthGatePresenceV1"],
        }),
      });
      assert.equal(unsupportedProtocol.status, 426);

      const managedPresence = await fetch(`${baseUrl}/session-gate-presence`, {
        method: "POST",
        headers: {
          authorization: `ClassPilot-Device ${sourceContinuity.continuityProof}`,
          "content-type": "application/json",
          ...rosterHeaders,
        },
        body: JSON.stringify({
          schoolId,
          clientProtocolVersion: 3,
          capabilities: ["scopedAuthorityChecksV1", "studentAuthGatePresenceV1"],
        }),
      });
      assert.equal(managedPresence.status, 204);

      process.env.REDIS_URL = "redis://configured-but-unavailable.test";
      try {
        const unavailableTransfer = await fetch(`${baseUrl}/student-login`, {
          method: "POST",
          headers: { "content-type": "application/json", ...rosterHeaders },
          body: JSON.stringify({
            schoolId,
            deviceId: gateTargetDeviceId,
            studentId: gateStudent.id,
            pin: gatePin,
          }),
        });
        assert.equal(unavailableTransfer.status, 503);
        assert.equal(
          (await unavailableTransfer.json() as { code?: string }).code,
          "STUDENT_SESSION_TRANSFER_UNAVAILABLE"
        );
        assert.equal(
          (await inSchool(() => storage.getActiveSessionById(source.session.id)))?.id,
          source.session.id
        );
      } finally {
        process.env.REDIS_URL = "";
      }

      await new Promise((resolve) => setTimeout(resolve, 5));
      const unnegotiated = await fetch(`${baseUrl}/session-gate-presence`, {
        method: "POST",
        headers: {
          authorization: `ClassPilot-Recovery ${sourceRecovery.token}`,
          "content-type": "application/json",
          ...rosterHeaders,
        },
        body: JSON.stringify({
          schoolId,
          clientProtocolVersion: 3,
          capabilities: ["scopedAuthorityChecksV1", "studentAuthGatePresenceV1"],
        }),
      });
      assert.equal(unnegotiated.status, 204);
      const exactPresence = await authGatePresence.readClasspilotStudentAuthGatePresence({
        schoolId,
        studentId: gateStudent.id,
        studentSessionId: source.session.id,
        deviceId: gateSourceDeviceId,
      });
      assert.equal(exactPresence.status, "present");
      const [gateAuthority] = await inSchool(() =>
        storage.getClasspilotLoginSessionAuthorities(schoolId, {
          studentId: gateStudent.id,
        })
      );
      assert.ok(gateAuthority);
      assert.ok(
        exactPresence.status === "present"
          && exactPresence.presence.observedAt
            > (gateAuthority.latestHeartbeatAt ?? gateAuthority.startedAt).getTime(),
        `presence must be newer than the exact heartbeat: ${JSON.stringify({
          presence: exactPresence,
          startedAt: gateAuthority.startedAt,
          latestHeartbeatAt: gateAuthority.latestHeartbeatAt,
        })}`
      );
      assert.deepEqual(studentSessionTransfer.classpilotStudentSessionTransferDecision({
        authKind: gateAuthority.authKind,
        sessionStartedAt: gateAuthority.startedAt,
        latestHeartbeatAt: gateAuthority.latestHeartbeatAt,
        gatePresence: exactPresence,
      }), { status: "allowed", source: "gate_presence" });

      const afterPresence = await fetch(
        `${baseUrl}/login-roster?schoolId=${encodeURIComponent(schoolId)}&gradeLevel=7`,
        { headers: rosterHeaders }
      );
      assert.equal(afterPresence.status, 200);
      const afterPresenceBody = (await afterPresence.json()) as {
        students: Array<{ id: string; reclaimable?: boolean }>;
      };
      const offered = afterPresenceBody.students.find((row) => row.id === gateStudent.id);
      assert.ok(
        offered,
        `the other Chromebook must receive the plain student row: ${JSON.stringify(afterPresenceBody)}`
      );
      assert.equal(offered.reclaimable, undefined);

      const resumedHeartbeat = await inSchool(() =>
        storage.createHeartbeatAndRefreshPresence({
          deviceId: gateSourceDeviceId,
          schoolId,
          studentId: gateStudent.id,
          activeTabTitle: "Student resumed after gate pulse",
        }, source.session.id)
      );
      assert.equal(resumedHeartbeat.outcome, "recorded");
      const hiddenAfterResume = await fetch(
        `${baseUrl}/login-roster?schoolId=${encodeURIComponent(schoolId)}&gradeLevel=7`,
        { headers: rosterHeaders }
      );
      assert.equal(hiddenAfterResume.status, 200);
      assert.equal(
        ((await hiddenAfterResume.json()) as { students: Array<{ id: string }> })
          .students.some((row) => row.id === gateStudent.id),
        false,
        "a newer exact heartbeat must supersede the remaining gate-presence TTL"
      );
      const blockedWhileFresh = await fetch(`${baseUrl}/student-login`, {
        method: "POST",
        headers: { "content-type": "application/json", ...rosterHeaders },
        body: JSON.stringify({
          schoolId,
          deviceId: gateTargetDeviceId,
          studentId: gateStudent.id,
          pin: gatePin,
        }),
      });
      assert.equal(blockedWhileFresh.status, 409);
      assert.equal(
        (await blockedWhileFresh.json() as { code?: string }).code,
        "STUDENT_SESSION_ACTIVE"
      );

      await new Promise((resolve) => setTimeout(resolve, 5));
      const renewedPresence = await fetch(`${baseUrl}/session-gate-presence`, {
        method: "POST",
        headers: {
          authorization: `ClassPilot-Recovery ${sourceRecovery.token}`,
          "content-type": "application/json",
          ...rosterHeaders,
        },
        body: JSON.stringify({
          schoolId,
          clientProtocolVersion: 3,
          capabilities: ["scopedAuthorityChecksV1", "studentAuthGatePresenceV1"],
        }),
      });
      assert.equal(renewedPresence.status, 204);

      const wrongPin = await fetch(`${baseUrl}/student-login`, {
        method: "POST",
        headers: { "content-type": "application/json", ...rosterHeaders },
        body: JSON.stringify({
          schoolId,
          deviceId: gateTargetDeviceId,
          studentId: gateStudent.id,
          pin: "0000",
        }),
      });
      assert.equal(wrongPin.status, 401);
      assert.equal(
        (await inSchool(() => storage.getActiveSessionById(source.session.id)))?.id,
        source.session.id,
        "incorrect credentials cannot consume transfer authority"
      );

      const login = await fetch(`${baseUrl}/student-login`, {
        method: "POST",
        headers: { "content-type": "application/json", ...rosterHeaders },
        body: JSON.stringify({
          schoolId,
          deviceId: gateTargetDeviceId,
          studentId: gateStudent.id,
          pin: gatePin,
        }),
      });
      assert.equal(login.status, 200);
      const loginBody = await login.json() as { studentSessionId: string };
      assert.equal(await inSchool(() => storage.getActiveSessionById(source.session.id)), undefined);
      const replacement = await inSchool(() =>
        storage.getActiveSessionById(loginBody.studentSessionId)
      );
      assert.equal(replacement?.studentId, gateStudent.id);
      assert.equal(replacement?.deviceId, gateTargetDeviceId);

      const delayedRelease = await fetch(`${baseUrl}/session-release`, {
        method: "POST",
        headers: {
          authorization: `ClassPilot-Recovery ${sourceRecovery.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ schoolId }),
      });
      assert.equal(delayedRelease.status, 204);
      assert.equal(
        (await inSchool(() => storage.getActiveSessionById(loginBody.studentSessionId)))?.id,
        loginBody.studentSessionId
      );
      await inSchool(() => storage.endStudentSessionExact({
        schoolId,
        studentId: gateStudent.id,
        deviceId: gateTargetDeviceId,
        studentSessionId: loginBody.studentSessionId,
      }));

      const emailSourceDeviceId = `${tag}-gate-email-source`;
      const emailTargetDeviceId = `${tag}-gate-email-target`;
      const emailStudentIdNumber = "gate-email-3141";
      const emailStudent = await inSchool(() => createStudent({
        schoolId,
        firstName: "Gate",
        lastName: "Email Transfer",
        email: `gate-email@${tag}.example.edu`,
        emailLc: `gate-email@${tag}.example.edu`,
        gradeLevel: "8",
        studentIdNumber: emailStudentIdNumber,
        status: "active",
      } as Parameters<typeof createStudent>[0]));
      await inSchool(() => createDevice({
        deviceId: emailSourceDeviceId,
        deviceName: "Gate email transfer source",
        schoolId,
        classId: schoolId,
      } as Parameters<typeof createDevice>[0]));
      const emailRecovery = createStudentSessionRecovery();
      const emailSource = await inSchool(() => startStudentSessionWithReplacements(
        schoolId,
        emailStudent.id,
        emailSourceDeviceId,
        {
          authKind: "manual_shared",
          sessionRecoveryTokenHash: emailRecovery.tokenHash,
        }
      ));
      await inSchool(() => storage.upsertSettings(schoolId, {
        enrollmentKey: gateSchoolEnrollmentKey,
        enrollmentKeyRequired: true,
        sharedChromebookSignInEnabled: true,
        sharedChromebookLoginMethod: "email_id",
      }));
      await new Promise((resolve) => setTimeout(resolve, 5));
      const emailPresence = await fetch(`${baseUrl}/session-gate-presence`, {
        method: "POST",
        headers: {
          authorization: `ClassPilot-Recovery ${emailRecovery.token}`,
          "content-type": "application/json",
          ...rosterHeaders,
        },
        body: JSON.stringify({
          schoolId,
          clientProtocolVersion: 3,
          capabilities: ["scopedAuthorityChecksV1", "studentAuthGatePresenceV1"],
        }),
      });
      assert.equal(emailPresence.status, 204);
      const emailLogin = await fetch(`${baseUrl}/student-login`, {
        method: "POST",
        headers: { "content-type": "application/json", ...rosterHeaders },
        body: JSON.stringify({
          schoolId,
          deviceId: emailTargetDeviceId,
          studentEmail: emailStudent.email,
          studentIdNumber: emailStudentIdNumber,
        }),
      });
      assert.equal(emailLogin.status, 200);
      const emailLoginBody = await emailLogin.json() as { studentSessionId: string };
      assert.equal(
        await inSchool(() => storage.getActiveSessionById(emailSource.session.id)),
        undefined
      );
      assert.equal(
        (await inSchool(() => storage.getActiveSessionById(emailLoginBody.studentSessionId)))
          ?.deviceId,
        emailTargetDeviceId
      );
      await inSchool(() => storage.endStudentSessionExact({
        schoolId,
        studentId: emailStudent.id,
        deviceId: emailTargetDeviceId,
        studentSessionId: emailLoginBody.studentSessionId,
      }));
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => error ? reject(error) : resolve())
      );
    }
  });

  it("falls back from a stale transition hash to the authoritative stable-device session", async () => {
    const enrollmentKey = `${tag}-managed-continuity-stale-hash-key`;
    const rawDirectoryDeviceId = `${tag}-managed-stale-hash-directory`;
    const staleRecovery = createStudentSessionRecovery();
    const issuedProof = managedDeviceContinuity.issueClasspilotManagedDeviceContinuityProof({
      schoolId,
      directoryDeviceId: rawDirectoryDeviceId,
      recoveryToken: staleRecovery.token,
    });
    const verifiedProof = managedDeviceContinuity.verifyClasspilotManagedDeviceContinuityProof({
      token: issuedProof.continuityProof,
      schoolId,
    });
    assert.ok(verifiedProof);

    const pinHash = await hashPassword("6420");
    const oldStudent = await inSchool(() => createStudent({
      schoolId,
      firstName: "Stable",
      lastName: "Old Owner",
      email: `managed-stale-owner@${tag}.example.edu`,
      emailLc: `managed-stale-owner@${tag}.example.edu`,
      gradeLevel: "6",
      status: "active",
    } as Parameters<typeof createStudent>[0]));
    const selectedStudent = await inSchool(() => createStudent({
      schoolId,
      firstName: "Stable",
      lastName: "New Student",
      email: `managed-stale-selected@${tag}.example.edu`,
      emailLc: `managed-stale-selected@${tag}.example.edu`,
      gradeLevel: "6",
      classpilotPinHash: pinHash,
      status: "active",
    } as Parameters<typeof createStudent>[0]));
    await inSchool(() => createDevice({
      deviceId: verifiedProof.deviceId,
      deviceName: "Managed continuity stable binding",
      schoolId,
      classId: schoolId,
    } as Parameters<typeof createDevice>[0]));
    const currentRecovery = createStudentSessionRecovery();
    const old = await inSchool(() => startStudentSessionWithReplacements(
      schoolId,
      oldStudent.id,
      verifiedProof.deviceId,
      {
        authKind: "manual_shared",
        sessionRecoveryTokenHash: currentRecovery.tokenHash,
      }
    ));
    await inSchool(() => storage.upsertSettings(schoolId, {
      enrollmentKey,
      enrollmentKeyRequired: true,
      sharedChromebookSignInEnabled: true,
      sharedChromebookLoginMethod: "name_pin",
      sharedChromebookPinLoginEnabled: true,
    }));

    const { createApp } = await import("../dist/app.js");
    const server = createServer(createApp());
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    try {
      const baseUrl = `http://127.0.0.1:${port}/api/classpilot/extension`;
      const roster = await fetch(
        `${baseUrl}/login-roster?schoolId=${encodeURIComponent(schoolId)}&gradeLevel=6`,
        {
          headers: {
            authorization: `ClassPilot-Device ${issuedProof.continuityProof}`,
            "x-classpilot-enrollment-key": enrollmentKey,
          },
        }
      );
      assert.equal(roster.status, 200);
      const rosterBody = await roster.json() as {
        students?: Array<{ id?: string; reclaimable?: boolean }>;
        managedDeviceContinuityAccepted?: boolean;
      };
      assert.equal(rosterBody.managedDeviceContinuityAccepted, true);
      assert.equal(
        rosterBody.students?.some((row) =>
          row.id === oldStudent.id && row.reclaimable === true
        ),
        true,
        "a stale transition hash must not hide the exact stable-device session"
      );

      const login = await fetch(`${baseUrl}/student-login`, {
        method: "POST",
        headers: {
          authorization: `ClassPilot-Device ${issuedProof.continuityProof}`,
          "content-type": "application/json",
          "x-classpilot-enrollment-key": enrollmentKey,
        },
        body: JSON.stringify({
          schoolId,
          deviceId: `${tag}-ignored-stale-hash-binding`,
          studentId: selectedStudent.id,
          pin: "6420",
        }),
      });
      assert.equal(login.status, 200);
      const loginBody = await login.json() as {
        studentSessionId: string;
        effectiveDeviceId: string;
      };
      assert.equal(loginBody.effectiveDeviceId, verifiedProof.deviceId);
      assert.equal(await inSchool(() => storage.getActiveSessionById(old.session.id)), undefined);
      const active = await inSchool(() => storage.getActiveSessionById(loginBody.studentSessionId));
      assert.equal(active?.studentId, selectedStudent.id);
      assert.equal(active?.deviceId, verifiedProof.deviceId);

      await inSchool(() => storage.endStudentSessionExact({
        schoolId,
        studentId: selectedStudent.id,
        deviceId: verifiedProof.deviceId,
        studentSessionId: loginBody.studentSessionId,
      }));
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => error ? reject(error) : resolve())
      );
    }
  });

  it("keeps legacy and managed sessions authoritative until explicitly ended", async () => {
    const legacyOtherDeviceId = `${tag}-legacy-other`;
    await inSchool(() => createDevice({
      deviceId: legacyOtherDeviceId,
      deviceName: "Legacy compatibility device",
      schoolId,
      classId: schoolId,
    } as Parameters<typeof createDevice>[0]));

    const legacy = await inSchool(async () => {
      const [session] = await db.insert(studentSessions).values({
        studentId,
        deviceId: blockedDeviceId,
        // Phase A deliberately keeps old writers compatible; represent a
        // retained legacy row at insert time because auth_kind is immutable.
        authKind: "legacy",
      }).returning();
      return session!;
    });
    await inSchool(() => db.update(studentSessions)
      .set({ lastSeenAt: sql`now() - interval '1 day'` })
      .where(eq(studentSessions.id, legacy.id)));
    assert.ok(
      (await inSchool(() => storage.getStudentIdsHiddenFromClasspilotLoginRoster(schoolId)))
        .includes(studentId)
    );
    for (const attemptedDeviceId of [blockedDeviceId, legacyOtherDeviceId]) {
      await assert.rejects(
        () => inSchool(() => startStudentSessionWithReplacements(
          schoolId,
          studentId,
          attemptedDeviceId,
          {
            authKind: "manual_shared",
            sessionRecoveryTokenHash: createStudentSessionRecovery().tokenHash,
          }
        )),
        (error: any) => error?.code === "STUDENT_SESSION_ACTIVE"
      );
    }

    await inSchool(() => storage.endStudentSessionExact({
      schoolId,
      studentId,
      deviceId: blockedDeviceId,
      studentSessionId: legacy.id,
    }));
    const issuedAfterExplicitLegacyEnd = await inSchool(() =>
      startStudentSessionWithReplacements(
        schoolId,
        studentId,
        legacyOtherDeviceId,
        {
          authKind: "manual_shared",
          sessionRecoveryTokenHash: createStudentSessionRecovery().tokenHash,
        }
      )
    );
    assert.deepEqual(issuedAfterExplicitLegacyEnd.replacedSessions, []);

    await inSchool(() => storage.endStudentSessionExact({
      schoolId,
      studentId,
      deviceId: legacyOtherDeviceId,
      studentSessionId: issuedAfterExplicitLegacyEnd.session.id,
    }));
    const managed = await inSchool(() =>
      startStudentSessionWithReplacements(
        schoolId,
        studentId,
        blockedDeviceId,
        { authKind: "managed_profile" }
      )
    );
    await inSchool(() => db.update(studentSessions)
      .set({ lastSeenAt: sql`now() - interval '1 day'` })
      .where(eq(studentSessions.id, managed.session.id)));
    assert.ok(
      (await inSchool(() => storage.getStudentIdsHiddenFromClasspilotLoginRoster(schoolId)))
        .includes(studentId),
      "managed-profile sessions remain authoritative regardless of age"
    );
    await assert.rejects(
      () => inSchool(() => startStudentSessionWithReplacements(
        schoolId,
        studentId,
        legacyOtherDeviceId,
        {
          authKind: "manual_shared",
          sessionRecoveryTokenHash: createStudentSessionRecovery().tokenHash,
        }
      )),
      (error: any) => error?.code === "STUDENT_SESSION_ACTIVE"
    );
    await inSchool(() => storage.endStudentSessionExact({
      schoolId,
      studentId,
      deviceId: blockedDeviceId,
      studentSessionId: managed.session.id,
    }));
  });

  it("compensates an exact issued session when post-commit login shaping fails", async () => {
    const compensationDeviceId = `${tag}-postcommit-compensation`;
    const compensationStudent = await inSchool(() => createStudent({
      schoolId,
      firstName: "Postcommit",
      lastName: "Failure",
      email: `postcommit@${tag}.example.edu`,
      emailLc: `postcommit@${tag}.example.edu`,
      status: "active",
    } as Parameters<typeof createStudent>[0]));
    const issued = await inSchool(() => studentAuth.issueStudentDeviceSessionToken({
      schoolId,
      deviceId: compensationDeviceId,
      deviceName: "Postcommit compensation fixture",
      classId: schoolId,
      student: compensationStudent,
      authKind: "manual_shared",
    }));
    assert.ok(issued.sessionRecoveryToken);
    assert.equal(verifyStudentToken(issued.studentToken).sessionId, issued.session.id);
    const postcommitFailure = new Error("forced postcommit response-shaping failure");
    let compensatedSessionId: string | undefined;
    await assert.rejects(
      () => inSchool(() => studentAuth.finalizeStudentDeviceSessionIssuance({
        schoolId,
        issuedSession: issued.session,
        finalize: async () => {
          throw postcommitFailure;
        },
        onCompensated: async (endedSession) => {
          compensatedSessionId = endedSession.id;
        },
      })),
      (error) => error === postcommitFailure,
      "compensation must rethrow the original post-commit error"
    );
    assert.equal(compensatedSessionId, issued.session.id);
    assert.equal(
      await inSchool(() => storage.getActiveSessionById(issued.session.id)),
      undefined
    );
    const [ended] = await inSchool(() => db.select({
      isActive: studentSessions.isActive,
      endedAt: studentSessions.endedAt,
      recoveryHash: studentSessions.sessionRecoveryTokenHash,
    }).from(studentSessions).where(eq(studentSessions.id, issued.session.id)));
    assert.equal(ended?.isActive, false);
    assert.ok(ended?.endedAt instanceof Date);
    assert.equal(ended?.recoveryHash, null);
    await inSchool(() => storage.deleteDeviceWithEndedSessions(
      schoolId,
      compensationDeviceId
    ));
  });

  it("performs no device, replacement, or session writes when JWT signing fails", async () => {
    const signingStudent = await inSchool(() => createStudent({
      schoolId,
      firstName: "Signing",
      lastName: "Failure",
      email: `signing-failure@${tag}.example.edu`,
      emailLc: `signing-failure@${tag}.example.edu`,
      status: "active",
    } as Parameters<typeof createStudent>[0]));
    const existingDeviceId = `${tag}-signing-existing`;
    const unwrittenDeviceId = `${tag}-signing-unwritten`;
    await inSchool(() => createDevice({
      deviceId: existingDeviceId,
      deviceName: "Signing failure existing authority",
      schoolId,
      classId: schoolId,
    } as Parameters<typeof createDevice>[0]));
    const existing = await inSchool(() => startStudentSessionWithReplacements(
      schoolId,
      signingStudent.id,
      existingDeviceId,
      { authKind: "managed_profile" }
    ));
    const signingFailure = new Error("synthetic JWT signing failure");

    await assert.rejects(
      () => inSchool(() => studentAuth.issueStudentDeviceSessionToken({
        schoolId,
        deviceId: unwrittenDeviceId,
        deviceName: "Must not be created after signing failure",
        classId: schoolId,
        student: signingStudent,
        authKind: "manual_shared",
      }, {
        signStudentToken: () => {
          throw signingFailure;
        },
      })),
      (error) => error === signingFailure
    );

    assert.equal(
      (await inSchool(() => storage.getActiveSessionById(existing.session.id)))?.id,
      existing.session.id,
      "the existing authority must not be replaced before signing succeeds"
    );
    assert.equal(
      await inSchool(() => storage.getDeviceById(unwrittenDeviceId)),
      undefined
    );
    assert.deepEqual(
      await inSchool(() => db.select({ id: studentSessions.id })
        .from(studentSessions)
        .where(eq(studentSessions.deviceId, unwrittenDeviceId))),
      []
    );
    assert.deepEqual(
      await inSchool(() => db.select({ studentId: studentDevices.studentId })
        .from(studentDevices)
        .where(eq(studentDevices.deviceId, unwrittenDeviceId))),
      []
    );

    await assert.rejects(
      () => inSchool(() => startStudentSessionWithReplacements(
        schoolId,
        signingStudent.id,
        existingDeviceId,
        { authKind: "managed_profile", sessionId: "not-a-uuid" }
      )),
      /Invalid preallocated student session id/
    );
    await inSchool(() => storage.endStudentSessionExact({
      schoolId,
      studentId: signingStudent.id,
      deviceId: existingDeviceId,
      studentSessionId: existing.session.id,
    }));
  });

  it("takes school, class, license, and sorted student locks in one canonical order", async () => {
    const suffix = `canonical-lock-order-${randomUUID().slice(0, 8)}`;
    const lockOrderDeviceId = `${tag}-${suffix}`;
    await inSchool(() => createDevice({
      deviceId: lockOrderDeviceId,
      deviceName: "Canonical lock order fixture",
      schoolId,
      classId: schoolId,
    } as Parameters<typeof createDevice>[0]));
    const sourceStudent = await inSchool(() => createStudent({
      schoolId,
      firstName: "Canonical",
      lastName: "Source",
      email: `${suffix}-source@${tag}.example.edu`,
      emailLc: `${suffix}-source@${tag}.example.edu`,
      status: "active",
    } as Parameters<typeof createStudent>[0]));
    const destinationStudent = await inSchool(() => createStudent({
      schoolId,
      firstName: "Canonical",
      lastName: "Destination",
      email: `${suffix}-destination@${tag}.example.edu`,
      emailLc: `${suffix}-destination@${tag}.example.edu`,
      status: "active",
    } as Parameters<typeof createStudent>[0]));
    const sourceRecovery = createStudentSessionRecovery();
    const source = await inSchool(() => startStudentSessionWithReplacements(
      schoolId,
      sourceStudent.id,
      lockOrderDeviceId,
      {
        authKind: "manual_shared",
        sessionRecoveryTokenHash: sourceRecovery.tokenHash,
      }
    ));

    const schoolBlocker = new Client({ connectionString: process.env.DATABASE_URL });
    const classBlocker = new Client({ connectionString: process.env.DATABASE_URL });
    const licenseBlocker = new Client({ connectionString: process.env.DATABASE_URL });
    const studentBlocker = new Client({ connectionString: process.env.DATABASE_URL });
    const lockProbe = new Client({ connectionString: process.env.DATABASE_URL });
    await Promise.all([
      schoolBlocker.connect(),
      classBlocker.connect(),
      licenseBlocker.connect(),
      studentBlocker.connect(),
      lockProbe.connect(),
    ]);
    const blockerClients = [schoolBlocker, classBlocker, licenseBlocker, studentBlocker];
    const blockerOpen = [false, false, false, false];
    let transfer:
      | ReturnType<typeof startStudentSessionWithReplacements>
      | undefined;
    let transferSettled = false;
    try {
      for (let index = 0; index < blockerClients.length; index += 1) {
        await blockerClients[index]!.query("BEGIN");
        blockerOpen[index] = true;
      }
      await schoolBlocker.query(
        "SELECT id FROM schools WHERE id = $1 FOR UPDATE",
        [schoolId]
      );
      const classLockKey = `passpilot-class-source:${schoolId}`;
      await classBlocker.query(
        "SELECT pg_advisory_xact_lock(hashtext($1))",
        [classLockKey]
      );
      await licenseBlocker.query(`
        SELECT id
        FROM product_licenses
        WHERE school_id = $1 AND product = 'CLASSPILOT'
        FOR UPDATE
      `, [schoolId]);
      const firstStudentId = [sourceStudent.id, destinationStudent.id]
        .sort((left, right) => left.localeCompare(right))[0]!;
      const studentLockKey =
        `classpilot:student-control:${schoolId}:${firstStudentId}`;
      await studentBlocker.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1, 0::bigint))",
        [studentLockKey]
      );

      const blockerPids = await Promise.all(blockerClients.map(async (client) =>
        Number((await client.query("SELECT pg_backend_pid() AS pid")).rows[0]?.pid)
      ));
      assert.equal(blockerPids.every(Number.isSafeInteger), true);
      const blockerNames = ["school", "class", "license", "student"] as const;
      const blockingSnapshot = async (): Promise<number[]> => {
        const result = await lockProbe.query(`
          SELECT blocker.pid AS "blockerPid",
                 count(waiter.pid)::integer AS "waitingCount"
          FROM unnest($1::integer[]) AS blocker(pid)
          LEFT JOIN pg_stat_activity AS waiter
            ON blocker.pid = ANY(pg_blocking_pids(waiter.pid))
          GROUP BY blocker.pid
        `, [blockerPids]);
        const byPid = new Map(
          result.rows.map((row) => [Number(row.blockerPid), Number(row.waitingCount)])
        );
        return blockerPids.map((pid) => byPid.get(pid) ?? 0);
      };
      const waitForBarrier = async (expectedIndex: number): Promise<void> => {
        const deadline = Date.now() + 5_000;
        let snapshot = [0, 0, 0, 0];
        while (Date.now() < deadline) {
          snapshot = await blockingSnapshot();
          for (let index = expectedIndex + 1; index < snapshot.length; index += 1) {
            assert.equal(
              snapshot[index],
              0,
              `${blockerNames[index]} lock gained a waiter before ${blockerNames[expectedIndex]}`
            );
          }
          assert.ok(
            snapshot[expectedIndex]! <= 1,
            `${blockerNames[expectedIndex]} lock unexpectedly blocked multiple backends`
          );
          if (snapshot[expectedIndex] === 1) return;
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        assert.fail(
          `transfer did not reach ${blockerNames[expectedIndex]} barrier: ${JSON.stringify(snapshot)}`
        );
      };

      transfer = inSchool(() => startStudentSessionWithReplacements(
        schoolId,
        destinationStudent.id,
        lockOrderDeviceId,
        {
          authKind: "manual_shared",
          sessionRecoveryTokenHash: createStudentSessionRecovery().tokenHash,
          reclaimRecoveryTokenHash: sourceRecovery.tokenHash,
        }
      ));
      void transfer.then(
        () => { transferSettled = true; },
        () => { transferSettled = true; }
      );

      for (let expectedIndex = 0; expectedIndex < blockerClients.length; expectedIndex += 1) {
        await waitForBarrier(expectedIndex);
        assert.equal(
          transferSettled,
          false,
          `transfer settled before ${blockerNames[expectedIndex]} barrier was released`
        );
        await blockerClients[expectedIndex]!.query("COMMIT");
        blockerOpen[expectedIndex] = false;
      }

      const transferResult = await Promise.race([
        transfer,
        new Promise<never>((_resolve, reject) => {
          const timer = setTimeout(
            () => reject(new Error("canonical lock-order transfer timed out")),
            5_000
          );
          timer.unref();
        }),
      ]);
      assert.equal(transferResult.crossStudentHandoff, true);
      assert.deepEqual(
        transferResult.replacedSessions.map((session) => session.id),
        [source.session.id]
      );
      assert.equal(
        await inSchool(() => storage.getActiveSessionById(source.session.id)),
        undefined
      );
      const activeReplacement = await inSchool(() =>
        storage.getActiveSessionById(transferResult.session.id)
      );
      assert.equal(activeReplacement?.studentId, destinationStudent.id);
      assert.equal(activeReplacement?.deviceId, lockOrderDeviceId);
    } finally {
      for (let index = 0; index < blockerClients.length; index += 1) {
        if (blockerOpen[index]) {
          await blockerClients[index]!.query("ROLLBACK").catch(() => {});
        }
      }
      await transfer?.catch(() => {});
      await Promise.all([
        ...blockerClients.map((client) => client.end()),
        lockProbe.end(),
      ]);
      const activeSessions = await inSchool(() => storage.getActiveSessionsForStudents(
        schoolId,
        [sourceStudent.id, destinationStudent.id]
      ));
      for (const active of activeSessions) {
        await inSchool(() => storage.endStudentSessionExact({
          schoolId,
          studentId: active.studentId,
          deviceId: active.deviceId,
          studentSessionId: active.id,
        }));
      }
      await inSchool(() => storage.deleteDeviceWithEndedSessions(
        schoolId,
        lockOrderDeviceId
      ));
    }
  });

  it("lets a committed ClassPilot revocation win before session issuance", async () => {
    const entitlementRaceDeviceId = `${tag}-entitlement-race`;
    const entitlementRaceStudent = await inSchool(() => createStudent({
      schoolId,
      firstName: "Entitlement",
      lastName: "Race",
      email: `entitlement-race@${tag}.example.edu`,
      emailLc: `entitlement-race@${tag}.example.edu`,
      status: "active",
    } as Parameters<typeof createStudent>[0]));
    await inSchool(() => createDevice({
      deviceId: entitlementRaceDeviceId,
      deviceName: "Entitlement race fixture",
      schoolId,
      classId: schoolId,
    } as Parameters<typeof createDevice>[0]));

    const revocation = new Client({ connectionString: process.env.DATABASE_URL });
    await revocation.connect();
    let revocationOpen = false;
    let issuanceAttempt: Promise<unknown> | null = null;
    try {
      await revocation.query("BEGIN");
      revocationOpen = true;
      const revoked = await revocation.query(`
        UPDATE product_licenses
        SET status = 'inactive'
        WHERE school_id = $1 AND product = 'CLASSPILOT'
        RETURNING id
      `, [schoolId]);
      assert.equal(revoked.rowCount, 1);

      let issuanceSettled = false;
      issuanceAttempt = inSchool(() => startStudentSessionWithReplacements(
        schoolId,
        entitlementRaceStudent.id,
        entitlementRaceDeviceId,
        {
          authKind: "manual_shared",
          sessionRecoveryTokenHash: createStudentSessionRecovery().tokenHash,
        }
      ));
      void issuanceAttempt.then(
        () => { issuanceSettled = true; },
        () => { issuanceSettled = true; }
      );

      // The issuance transaction must be queued behind the revocation's
      // product-license row lock. Without the in-transaction entitlement check
      // it would commit a token-bearing session while revocation is uncommitted.
      await new Promise((resolve) => setTimeout(resolve, 75));
      assert.equal(issuanceSettled, false);

      await revocation.query("COMMIT");
      revocationOpen = false;
      await assert.rejects(
        issuanceAttempt,
        (error: any) => error?.code === "CLASSPILOT_NOT_ENTITLED"
      );

      const [sessionsAfterRace, mappingsAfterRace] = await Promise.all([
        inSchool(() => db.select({ id: studentSessions.id })
          .from(studentSessions)
          .where(eq(studentSessions.studentId, entitlementRaceStudent.id))),
        inSchool(() => db.select({ studentId: studentDevices.studentId })
          .from(studentDevices)
          .where(and(
            eq(studentDevices.studentId, entitlementRaceStudent.id),
            eq(studentDevices.deviceId, entitlementRaceDeviceId)
          ))),
      ]);
      assert.deepEqual(sessionsAfterRace, []);
      assert.deepEqual(mappingsAfterRace, []);
    } finally {
      if (revocationOpen) await revocation.query("ROLLBACK").catch(() => {});
      await revocation.end();
      await issuanceAttempt?.catch(() => {});
      await runWithTenantContext({ isSuper: true }, () => db
        .update(productLicenses)
        .set({ status: "active" })
        .where(and(
          eq(productLicenses.schoolId, schoolId),
          eq(productLicenses.product, "CLASSPILOT")
        ))
        .then(() => undefined));
      await inSchool(() => storage.deleteDeviceWithEndedSessions(
        schoolId,
        entitlementRaceDeviceId
      ));
    }
  });

  it("uses device-before-session locking for concurrent heartbeat and device removal", async () => {
    const raceDeviceId = `${tag}-lock-order`;
    const raceStudent = await inSchool(() => createStudent({
      schoolId,
      firstName: "Lock",
      lastName: "Order",
      email: `lock-order@${tag}.example.edu`,
      emailLc: `lock-order@${tag}.example.edu`,
      status: "active",
    } as Parameters<typeof createStudent>[0]));
    await inSchool(() => createDevice({
      deviceId: raceDeviceId,
      deviceName: "Lock order fixture",
      schoolId,
      classId: schoolId,
    } as Parameters<typeof createDevice>[0]));
    const raceSession = await inSchool(() => startStudentSessionWithReplacements(
      schoolId,
      raceStudent.id,
      raceDeviceId,
      {
        authKind: "manual_shared",
        sessionRecoveryTokenHash: createStudentSessionRecovery().tokenHash,
      }
    ));
    await inSchool(() => db.update(studentSessions).set({
      lastSeenAt: sql`now() - interval '61 seconds'`,
    }).where(eq(studentSessions.id, raceSession.session.id)));

    const lockClient = new Client({ connectionString: process.env.DATABASE_URL });
    await lockClient.connect();
    await lockClient.query("BEGIN");
    try {
      await lockClient.query(
        "SELECT device_id FROM devices WHERE device_id = $1 FOR UPDATE",
        [raceDeviceId]
      );
      const waitingHeartbeat = inSchool(() => storage.createHeartbeatAndRefreshPresence({
        deviceId: raceDeviceId,
        schoolId,
        studentId: raceStudent.id,
        activeTabTitle: "Device lock ordering",
      }, raceSession.session.id));
      await new Promise((resolve) => setTimeout(resolve, 100));
      await lockClient.query("SET LOCAL lock_timeout = '750ms'");
      await lockClient.query(
        "SELECT id FROM student_sessions WHERE id = $1 FOR UPDATE",
        [raceSession.session.id]
      );
      await lockClient.query("ROLLBACK");
      const heartbeat = await Promise.race([
        waitingHeartbeat,
        new Promise<never>((_resolve, reject) => {
          const timer = setTimeout(
            () => reject(new Error("heartbeat lock-order timeout")),
            5_000
          );
          timer.unref();
        }),
      ]);
      assert.equal(heartbeat.outcome, "recorded");
    } finally {
      await lockClient.query("ROLLBACK").catch(() => undefined);
      await lockClient.end();
    }

    await inSchool(() => db.update(studentSessions).set({
      lastSeenAt: sql`now() - interval '61 seconds'`,
    }).where(eq(studentSessions.id, raceSession.session.id)));
    const race = await Promise.race([
      Promise.allSettled([
        inSchool(() => storage.createHeartbeatAndRefreshPresence({
          deviceId: raceDeviceId,
          schoolId,
          studentId: raceStudent.id,
          activeTabTitle: "Concurrent device removal",
        }, raceSession.session.id)),
        inSchool(() => storage.deleteDeviceWithEndedSessions(schoolId, raceDeviceId)),
      ]),
      new Promise<never>((_resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error("heartbeat/device-delete deadlock")),
          5_000
        );
        timer.unref();
      }),
    ]);
    assert.equal(race[0]?.status, "fulfilled");
    assert.equal(race[1]?.status, "fulfilled");
    if (race[0]?.status === "fulfilled") {
      assert.ok(["recorded", "inactive_session"].includes(race[0].value.outcome));
    }
    if (race[1]?.status === "fulfilled") {
      assert.equal(race[1].value.deleted, true);
      assert.deepEqual(
        race[1].value.endedSessions.map((row: any) => row.id),
        [raceSession.session.id]
      );
    }
  });

  it("serializes concurrent heartbeat resume and stale transfer to one authority winner", async () => {
    const sourceDeviceId = `${tag}-heartbeat-transfer-source`;
    const destinationDeviceId = `${tag}-heartbeat-transfer-destination`;
    const raceStudent = await inSchool(() => createStudent({
      schoolId,
      firstName: "Heartbeat",
      lastName: "Transfer",
      email: `heartbeat-transfer@${tag}.example.edu`,
      emailLc: `heartbeat-transfer@${tag}.example.edu`,
      status: "active",
    } as Parameters<typeof createStudent>[0]));
    await inSchool(async () => {
      await createDevice({
        deviceId: sourceDeviceId,
        deviceName: "Heartbeat transfer source",
        schoolId,
        classId: schoolId,
      } as Parameters<typeof createDevice>[0]);
      await createDevice({
        deviceId: destinationDeviceId,
        deviceName: "Heartbeat transfer destination",
        schoolId,
        classId: schoolId,
      } as Parameters<typeof createDevice>[0]);
    });
    const source = await inSchool(() => startStudentSessionWithReplacements(
      schoolId,
      raceStudent.id,
      sourceDeviceId,
      {
        authKind: "manual_shared",
        sessionRecoveryTokenHash: createStudentSessionRecovery().tokenHash,
      }
    ));
    // With no heartbeat row, stale-transfer authority falls back to the
    // represented session start. Make that source stale before releasing the
    // two contenders together.
    await inSchool(() => db.update(studentSessions).set({
      startedAt: sql`now() - interval '61 seconds'`,
      lastSeenAt: sql`now() - interval '61 seconds'`,
    }).where(eq(studentSessions.id, source.session.id)));

    const [heartbeatResult, transferResult] = await Promise.race([
      Promise.allSettled([
        inSchool(() => storage.createHeartbeatAndRefreshPresence({
          deviceId: sourceDeviceId,
          schoolId,
          studentId: raceStudent.id,
          activeTabTitle: "Concurrent resume",
        }, source.session.id)),
        inSchool(() => startStudentSessionWithReplacements(
          schoolId,
          raceStudent.id,
          destinationDeviceId,
          {
            authKind: "manual_shared",
            sessionRecoveryTokenHash: createStudentSessionRecovery().tokenHash,
            studentTransferAuthority: {
              studentSessionId: source.session.id,
              source: "stale_heartbeat",
            },
          }
        )),
      ]),
      new Promise<never>((_resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error("heartbeat/transfer authority timeout")),
          5_000
        );
        timer.unref();
      }),
    ]);

    assert.equal(heartbeatResult.status, "fulfilled");
    const heartbeatRecorded = heartbeatResult.status === "fulfilled"
      && heartbeatResult.value.outcome === "recorded";
    const transferSucceeded = transferResult.status === "fulfilled";
    assert.notEqual(
      heartbeatRecorded,
      transferSucceeded,
      "exactly one contender may retain or transfer student authority"
    );
    if (transferResult.status === "rejected") {
      assert.equal((transferResult.reason as any)?.code, "STUDENT_SESSION_ACTIVE");
      assert.equal(heartbeatResult.value.outcome, "recorded");
    } else {
      assert.ok(
        ["replaced_session", "inactive_session"].includes(heartbeatResult.value.outcome),
        "a transfer winner must make the retired heartbeat non-authoritative"
      );
    }

    const active = await inSchool(() => storage.getActiveSessionsForStudents(
      schoolId,
      [raceStudent.id]
    ));
    assert.equal(active.length, 1);
    assert.equal(
      active[0]?.deviceId,
      transferSucceeded ? destinationDeviceId : sourceDeviceId
    );

    await inSchool(() => storage.deleteDeviceWithEndedSessions(schoolId, sourceDeviceId));
    await inSchool(() => storage.deleteDeviceWithEndedSessions(schoolId, destinationDeviceId));
  });

  it("fails closed without mutating a corrupt cross-school device conflict", async () => {
    const corruptDeviceId = `${tag}-cross-school-delete`;
    await inSchool(() => createDevice({
      deviceId: corruptDeviceId,
      deviceName: "Cross-school corruption fixture",
      schoolId,
      classId: schoolId,
    } as Parameters<typeof createDevice>[0]));
    const foreignSchool = await createSchool({
      name: `${tag} foreign`,
      domain: `${tag}-foreign.example.edu`,
      slug: `${tag}-foreign`,
      status: "active",
      planStatus: "active",
    } as Parameters<typeof createSchool>[0]);
    foreignSchoolId = foreignSchool.id;
    const foreignStudent = await runWithTenantContext(
      { schoolId: foreignSchoolId },
      () => createStudent({
        schoolId: foreignSchoolId,
        firstName: "Foreign",
        lastName: "Corrupt",
        email: `foreign@${tag}.example.edu`,
        emailLc: `foreign@${tag}.example.edu`,
        status: "active",
      } as Parameters<typeof createStudent>[0])
    );
    foreignStudentId = foreignStudent.id;
    const corrupt = await runWithTenantContext({ isSuper: true }, async () => {
      const [row] = await db.insert(studentSessions).values({
        studentId: foreignStudentId,
        deviceId: corruptDeviceId,
        // Insert the retained-legacy fixture directly; production auth kinds
        // are immutable after insertion.
        authKind: "legacy",
      }).returning();
      return row!;
    });

    await assert.rejects(() => inSchool(() =>
      startStudentSessionWithReplacements(
        schoolId,
        studentId,
        corruptDeviceId,
        {
          authKind: "manual_shared",
          sessionRecoveryTokenHash: createStudentSessionRecovery().tokenHash,
        }
      )
    ));
    const [unchanged] = await runWithTenantContext({ isSuper: true }, () =>
      db.select({
        studentId: studentSessions.studentId,
        isActive: studentSessions.isActive,
        endedAt: studentSessions.endedAt,
      }).from(studentSessions).where(eq(studentSessions.id, corrupt.id))
    );
    assert.deepEqual(unchanged, {
      studentId: foreignStudentId,
      isActive: true,
      endedAt: null,
    });

    const deleted = await inSchool(() =>
      storage.deleteDeviceWithEndedSessions(schoolId, corruptDeviceId)
    );
    assert.equal(deleted.deleted, true);
    assert.deepEqual(deleted.endedSessions, []);
    const [stillUnchanged] = await runWithTenantContext({ isSuper: true }, () =>
      db.select({
        isActive: studentSessions.isActive,
        endedAt: studentSessions.endedAt,
      }).from(studentSessions).where(eq(studentSessions.id, corrupt.id))
    );
    assert.deepEqual(stillUnchanged, { isActive: true, endedAt: null });

    await runWithTenantContext({ isSuper: true }, () =>
      db.delete(studentSessions).where(eq(studentSessions.id, corrupt.id))
    );
  });

  it("reaper skips locked work, reports backlog, and continues after publication failure", async () => {
    const lockedRecovery = createStudentSessionRecovery();
    const locked = await inSchool(() =>
      startStudentSessionWithReplacements(schoolId, studentId, blockedDeviceId, {
        authKind: "manual_shared",
        sessionRecoveryTokenHash: lockedRecovery.tokenHash,
      })
    );
    const dueDeviceId = `${tag}-reaper-due`;
    await inSchool(async () => {
      const student = await createStudent({
        schoolId,
        firstName: "Reaper",
        lastName: "Due",
        email: `reaper@${tag}.example.edu`,
        emailLc: `reaper@${tag}.example.edu`,
        status: "active",
      } as Parameters<typeof createStudent>[0]);
      reaperStudentId = student.id;
      await createDevice({
        deviceId: dueDeviceId,
        deviceName: "Reaper due device",
        schoolId,
        classId: schoolId,
      } as Parameters<typeof createDevice>[0]);
    });
    const due = await inSchool(() =>
      startStudentSessionWithReplacements(schoolId, reaperStudentId, dueDeviceId, {
        authKind: "manual_shared",
        sessionRecoveryTokenHash: createStudentSessionRecovery().tokenHash,
      })
    );
    await inSchool(async () => {
      await db.update(studentSessions)
        // Use the earliest PostgreSQL timestamp so unrelated expired fixtures
        // in a shared test database cannot take this bounded reaper slot. The
        // locked row is skipped and the exact due row below is deterministically
        // selected next.
        .set({ manualLeaseExpiresAt: sql`'-infinity'::timestamptz` })
        .where(eq(studentSessions.id, locked.session.id));
      await db.update(studentSessions)
        .set({ manualLeaseExpiresAt: sql`'-infinity'::timestamptz` })
        .where(eq(studentSessions.id, due.session.id));
    });

    const lockClient = new Client({ connectionString: process.env.DATABASE_URL });
    await lockClient.connect();
    await lockClient.query("BEGIN");
    await lockClient.query(
      "SELECT id FROM student_sessions WHERE id = $1 FOR UPDATE",
      [locked.session.id]
    );
    try {
      const reaped = await lifecycle.reapExpiredManualStudentSessions({
        batchSize: 1,
        maxBatches: 1,
        publicationConcurrency: 1,
        publishEndedSession: async () => {
          throw new Error("synthetic publication failure");
        },
      });
      assert.deepEqual(reaped, {
        ended: 1,
        publicationFailures: 1,
        backlog: true,
      });
      const rows = await inSchool(() => db.select({
        id: studentSessions.id,
        isActive: studentSessions.isActive,
        recoveryHash: studentSessions.sessionRecoveryTokenHash,
      }).from(studentSessions).where(and(
        eq(studentSessions.id, due.session.id),
        eq(studentSessions.studentId, reaperStudentId)
      )));
      assert.deepEqual(rows, [{
        id: due.session.id,
        isActive: false,
        recoveryHash: null,
      }]);
    } finally {
      await lockClient.query("ROLLBACK");
      await lockClient.end();
    }

    const managed = await inSchool(() =>
      startStudentSessionWithReplacements(
        schoolId,
        reaperStudentId,
        dueDeviceId,
        { authKind: "managed_profile" }
      )
    );
    let postDeletePublicationCalls = 0;
    const deletedManaged = await inSchool(() =>
      lifecycle.removeClasspilotDeviceAndPublishSessionEnds({
        schoolId,
        deviceId: dueDeviceId,
        publishEndedSession: async (row: any) => {
          assert.equal(await storage.getDeviceById(dueDeviceId), undefined);
          assert.equal(row.studentSessionId, managed.session.id);
          postDeletePublicationCalls += 1;
        },
      })
    );
    assert.equal(deletedManaged.deleted, true);
    assert.deepEqual(
      deletedManaged.endedSessions.map((row: any) => row.studentSessionId),
      [managed.session.id]
    );
    assert.equal(deletedManaged.publicationFailures, 0);
    assert.equal(postDeletePublicationCalls, 1);

    const deletedManual = await inSchool(() =>
      storage.deleteDeviceWithEndedSessions(schoolId, blockedDeviceId)
    );
    assert.equal(deletedManual.deleted, true);
    assert.deepEqual(
      deletedManual.endedSessions.map((row) => row.id),
      [locked.session.id]
    );
    const endedManual = await inSchool(() => db.select({
      isActive: studentSessions.isActive,
      recoveryHash: studentSessions.sessionRecoveryTokenHash,
    }).from(studentSessions).where(eq(studentSessions.id, locked.session.id)));
    assert.deepEqual(endedManual, [{ isActive: false, recoveryHash: null }]);
  });

  it("publishes a committed reaper batch before a later batch fails", async () => {
    const firstDeviceId = `${tag}-reaper-first-batch`;
    const secondDeviceId = `${tag}-reaper-second-batch`;
    const [firstStudent, secondStudent] = await inSchool(async () => {
      const first = await createStudent({
        schoolId,
        firstName: "First",
        lastName: "Batch",
        email: `first-batch@${tag}.example.edu`,
        emailLc: `first-batch@${tag}.example.edu`,
        status: "active",
      } as Parameters<typeof createStudent>[0]);
      const second = await createStudent({
        schoolId,
        firstName: "Second",
        lastName: "Batch",
        email: `second-batch@${tag}.example.edu`,
        emailLc: `second-batch@${tag}.example.edu`,
        status: "active",
      } as Parameters<typeof createStudent>[0]);
      await createDevice({
        deviceId: firstDeviceId,
        deviceName: "First reaper batch",
        schoolId,
        classId: schoolId,
      } as Parameters<typeof createDevice>[0]);
      await createDevice({
        deviceId: secondDeviceId,
        deviceName: "Second reaper batch",
        schoolId,
        classId: schoolId,
      } as Parameters<typeof createDevice>[0]);
      return [first, second] as const;
    });
    const first = await inSchool(() => startStudentSessionWithReplacements(
      schoolId,
      firstStudent.id,
      firstDeviceId,
      {
        authKind: "manual_shared",
        sessionRecoveryTokenHash: createStudentSessionRecovery().tokenHash,
      }
    ));
    const second = await inSchool(() => startStudentSessionWithReplacements(
      schoolId,
      secondStudent.id,
      secondDeviceId,
      {
        authKind: "manual_shared",
        sessionRecoveryTokenHash: createStudentSessionRecovery().tokenHash,
      }
    ));
    await inSchool(async () => {
      await db.update(studentSessions)
        .set({ manualLeaseExpiresAt: sql`now() - interval '20 seconds'` })
        .where(eq(studentSessions.id, first.session.id));
      await db.update(studentSessions)
        .set({ manualLeaseExpiresAt: sql`now() - interval '10 seconds'` })
        .where(eq(studentSessions.id, second.session.id));
    });

    const published: string[] = [];
    const laterBatchFailure = new Error("synthetic later-batch failure");
    await assert.rejects(
      () => lifecycle.reapExpiredManualStudentSessions({
        batchSize: 1,
        maxBatches: 3,
        publicationConcurrency: 1,
        beforeBatch: (batchIndex) => {
          if (batchIndex === 1) throw laterBatchFailure;
        },
        publishEndedSession: async (row) => {
          published.push(row.studentSessionId);
        },
      }),
      (error) => error === laterBatchFailure
    );
    assert.deepEqual(published, [first.session.id]);
    const rows = await inSchool(() => db.select({
      id: studentSessions.id,
      isActive: studentSessions.isActive,
      recoveryHash: studentSessions.sessionRecoveryTokenHash,
    }).from(studentSessions).where(and(
      eq(studentSessions.studentId, firstStudent.id),
      eq(studentSessions.id, first.session.id)
    )));
    assert.deepEqual(rows, [{
      id: first.session.id,
      isActive: false,
      recoveryHash: null,
    }]);
    const [unqueriedLaterBatch] = await inSchool(() => db.select({
      isActive: studentSessions.isActive,
      endedAt: studentSessions.endedAt,
      recoveryHash: studentSessions.sessionRecoveryTokenHash,
    }).from(studentSessions).where(eq(studentSessions.id, second.session.id)));
    assert.deepEqual(unqueriedLaterBatch, {
      isActive: true,
      endedAt: null,
      recoveryHash: second.session.sessionRecoveryTokenHash,
    }, "the unqueried later batch remains durably queued for the next scheduler run");
    await inSchool(() => storage.deleteDeviceWithEndedSessions(schoolId, firstDeviceId));
    await inSchool(() => storage.deleteDeviceWithEndedSessions(schoolId, secondDeviceId));
  });
});
