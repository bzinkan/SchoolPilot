import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { and, eq, sql } from "drizzle-orm";
import { Client } from "pg";

process.env.NODE_ENV = "test";
process.env.SCHEDULER_ENABLED = "true";
process.env.REDIS_URL = "";
process.env.CLASSPILOT_MANUAL_SHARED_SESSION_ISSUANCE_ENABLED = "true";

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
const websocket = await import("../dist/realtime/websocket.js");
const lifecycle = await import(
  "../dist/services/classpilotStudentSessionLifecycle.js"
);
const { schedulerPool } = await import("../dist/services/schedulerDb.js");

const {
  createDevice,
  createSchool,
  createStudent,
  startStudentSessionWithReplacements,
} = storage;
const {
  devices,
  heartbeats,
  productLicenses,
  schools,
  studentDevices,
  studentSessions,
  students,
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
        .set({ manualLeaseExpiresAt: sql`now() - interval '10 seconds'` })
        .where(eq(studentSessions.id, locked.session.id));
      await db.update(studentSessions)
        .set({ manualLeaseExpiresAt: sql`now() - interval '5 seconds'` })
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
