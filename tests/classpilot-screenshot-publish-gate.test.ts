import { after, before, describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { setTimeout as delay } from "node:timers/promises";

// These values must be set before importing any application module: the
// screenshot upload path resolves its cadence only for a school whose
// tracking-window and active-observation capabilities are rolled out.
process.env.NODE_ENV = "test";
process.env.SCHEDULER_ENABLED = "false";
process.env.REDIS_URL = "";
process.env.CLASSPILOT_PROTOCOL_V3_ENABLED = "true";
process.env.CLASSPILOT_CAP_SCOPED_AUTHORITY_CHECKS_V1 = "true";
process.env.CLASSPILOT_CAP_SCREENSHOT_TRACKING_WINDOW_LEASE_V1 = "true";
process.env.CLASSPILOT_CAP_SCREENSHOT_ACTIVE_OBSERVATION_CADENCE_V1 = "true";

// Several application modules own process-lifetime housekeeping intervals.
// Keep only this worker's intervals non-blocking so the test worker can exit.
const originalSetInterval = globalThis.setInterval;
globalThis.setInterval = ((
  ...args: Parameters<typeof originalSetInterval>
): ReturnType<typeof originalSetInterval> => {
  const timer = originalSetInterval(...args);
  timer.unref?.();
  return timer;
}) as typeof setInterval;

const { default: db, pool, sessionPool } = await import("../dist/db.js");
const { runWithTenantContext } = await import("../dist/middleware/tenantContext.js");
const storage = await import("../dist/services/storage.js");
const schema = await import("../dist/schema/index.js");
const drizzle = await import("drizzle-orm");
const { createApp } = await import("../dist/app.js");
const { createStudentToken } = await import("../dist/services/deviceJwt.js");
const {
  setClasspilotRealtimeStatusCommandForTests,
  writeClasspilotRealtimeStatus,
} = await import("../dist/services/classpilotRealtimeStatus.js");
const { serializeClasspilotStudentControlState } = await import(
  "../dist/services/classpilotClassroomState.js"
);
const {
  renewClasspilotObservationLease,
  resetClasspilotObservationLeasesForTests,
} = await import("../dist/services/classpilotObservationLease.js");
const { recordLocalOrderedDelivery } = await import("../dist/realtime/ws-redis.js");
const { classpilotScreenshotAvailableOrderingKey } = await import(
  "../dist/services/classpilotScreenshotAvailability.js"
);
const { snapshotHeartbeatHotPathMetrics } = await import(
  "../dist/services/heartbeatHotPathMetrics.js"
);
const { classpilotScreenshotFallback } = await import(
  "../dist/services/classpilotScreenshotFallback.js"
);
const { resolveClasspilotScreenshotPolicy } = await import(
  "../dist/services/classpilotScreenshotPolicy.js"
);
const { schedulerPool, schedulerLockPool } = await import(
  "../dist/services/schedulerDb.js"
);

const { sql } = drizzle;
const { devices, groupStudents, groups, studentSessions, students } = schema;

const tag = `screenshot-publish-gate-${Date.now()}-${randomUUID().slice(0, 8)}`;
const domain = `${tag}.example.edu`;
const ACCEPTED_CAPABILITIES = [
  "scopedAuthorityChecksV1",
  "screenshotTrackingWindowLeaseV1",
  "screenshotActiveObservationCadenceV1",
];
const PIXELS = `data:image/jpeg;base64,${Buffer.from(tag).toString("base64")}`;

type StudentFixture = {
  studentId: string;
  deviceId: string;
  studentSessionId: string;
  token: string;
  authority: { kind: "teaching_session"; teachingSessionId: string; controlRevision: number };
};

const sharedRealtimeRows = new Map<string, string>();

async function sharedRealtimeCommand(args: string[]): Promise<unknown> {
  if (args[0] === "MGET") {
    return args.slice(1).map((key) => sharedRealtimeRows.get(key) ?? null);
  }
  if (args[0] === "EVAL") {
    const key = args[3];
    const snapshotJson = args[5];
    if (!key || !snapshotJson) throw new Error("Malformed realtime EVAL in test");
    const snapshot = JSON.parse(snapshotJson) as Record<string, unknown>;
    const currentRaw = sharedRealtimeRows.get(key);
    const current = currentRaw
      ? JSON.parse(currentRaw) as Record<string, unknown>
      : undefined;
    snapshot.revision = Math.max(
      Number(args[4]) || 0,
      Number(current?.revision || 0) + 1
    );
    const encoded = JSON.stringify(snapshot);
    sharedRealtimeRows.set(key, encoded);
    return encoded;
  }
  throw new Error(`Unsupported realtime command in test: ${args[0] || ""}`);
}

let server: Server | undefined;
let restoreMetricsClock: (() => void) | undefined;
let baseUrl = "";
let schoolId = "";
let teachingSessionId = "";
let observed: StudentFixture;
let unobserved: StudentFixture;
let limiterProbe: StudentFixture;
let takeover: StudentFixture;
let thrownProbe: StudentFixture;

function inSchool<T>(fn: () => Promise<T>): Promise<T> {
  return runWithTenantContext({ schoolId }, fn);
}

function asSystem<T>(fn: () => Promise<T>): Promise<T> {
  return runWithTenantContext({ isSuper: true }, fn);
}

function screenshotAvailableKey(fixture: StudentFixture): string {
  return `${classpilotScreenshotAvailableOrderingKey(schoolId, fixture.deviceId)}`
    + `:session:${teachingSessionId}`;
}

function skippedPublishCount(): number {
  return snapshotHeartbeatHotPathMetrics()
    .counters.screenshotAvailableBroadcastSkipped ?? 0;
}

function cadenceUnavailableCount(): number {
  return snapshotHeartbeatHotPathMetrics()
    .counters.screenshotCadenceObservationUnavailable ?? 0;
}

/**
 * Replay this device's latest status with the teaching session a takeover has
 * already replaced. The upload route reads the cadence teaching session from
 * that cached snapshot, so the observation read it performs answers for a
 * session this device is no longer bound to: an indeterminate read, not a read
 * that found no viewers.
 */
async function writeSupersededRealtimeSession(fixture: StudentFixture): Promise<void> {
  const controlState = await inSchool(() =>
    storage.getClasspilotStudentControlState(schoolId, fixture.studentId)
  );
  assert.ok(controlState);
  const written = await writeClasspilotRealtimeStatus({
    schoolId,
    studentId: fixture.studentId,
    studentSessionId: fixture.studentSessionId,
    deviceId: fixture.deviceId,
    heartbeatId: randomUUID(),
    activeTabUrl: "https://example.invalid/lesson",
    activeTabTitle: "Synthetic lesson",
    acceptedCapabilities: ACCEPTED_CAPABILITIES,
    classroomState: {
      ...serializeClasspilotStudentControlState(controlState),
      teachingSessionId: randomUUID(),
    },
  });
  assert.equal(written.status, "stored");
}

async function uploadScreenshot(
  fixture: StudentFixture,
  body: Record<string, unknown>
): Promise<{ status: number; body: Record<string, unknown>; limit: string | null }> {
  const response = await fetch(`${baseUrl}/api/classpilot/device/screenshot`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${fixture.token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  return {
    status: response.status,
    body: text ? JSON.parse(text) as Record<string, unknown> : {},
    limit: response.headers.get("ratelimit-limit"),
  };
}

function capture(fixture: StudentFixture, capturedAt: Date): Record<string, unknown> {
  return {
    screenshot: PIXELS,
    tabTitle: "Synthetic cadence capture",
    tabUrl: "https://example.invalid/lesson",
    capturedAt: capturedAt.toISOString(),
    screenshotAuthority: fixture.authority,
  };
}

/**
 * Wait for the fire-and-forget realtime publish of `revision` on `orderedKey`.
 *
 * The probes are strictly increasing and always stay *below* the published
 * revision, so a probe can never claim the high-water mark the real publish
 * needs, and a probe that returns false means delivery was already recorded.
 */
async function waitForOrderedPublish(
  orderedKey: string,
  revision: number,
  attempts = 150
): Promise<boolean> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (!recordLocalOrderedDelivery(orderedKey, String(revision - attempts + attempt))) {
      return true;
    }
    await delay(10);
  }
  return false;
}

async function createStudentFixture(label: string): Promise<StudentFixture> {
  const deviceId = `${tag}-${label}`;
  const email = `${tag}-${label}@${domain}`;
  const fixture = await inSchool(async () => {
    const [student] = await db
      .insert(students)
      .values({
        schoolId,
        firstName: "Synthetic",
        lastName: label,
        email,
        emailLc: email,
        status: "active",
      })
      .returning({ id: students.id });
    assert.ok(student?.id);
    await db.insert(devices).values({
      deviceId,
      deviceName: `Synthetic ${label} device`,
      schoolId,
      classId: "synthetic-class",
    });
    const [session] = await db
      .insert(studentSessions)
      .values({
        studentId: student.id,
        deviceId,
        authKind: "managed_profile",
        isActive: true,
      })
      .returning({ id: studentSessions.id });
    assert.ok(session?.id);
    return { studentId: student.id, studentSessionId: session.id };
  });
  return {
    studentId: fixture.studentId,
    deviceId,
    studentSessionId: fixture.studentSessionId,
    token: createStudentToken({
      schoolId,
      studentId: fixture.studentId,
      deviceId,
      sessionId: fixture.studentSessionId,
      studentEmail: email,
    }),
    authority: { kind: "teaching_session", teachingSessionId: "", controlRevision: 0 },
  };
}

async function bindClassAuthority(fixture: StudentFixture): Promise<void> {
  const projection = await inSchool(() =>
    storage.getClasspilotScreenshotAuthorityProjection({
      schoolId,
      studentId: fixture.studentId,
      studentSessionId: fixture.studentSessionId,
      deviceId: fixture.deviceId,
    })
  );
  assert.ok(projection, `missing screenshot authority for ${fixture.deviceId}`);
  const authority = projection.authority;
  if (authority.kind !== "teaching_session") {
    throw new Error(`${fixture.deviceId} did not receive class-bound screenshot authority`);
  }
  fixture.authority = {
    kind: "teaching_session",
    teachingSessionId: authority.teachingSessionId,
    controlRevision: authority.controlRevision,
  };

  const controlState = await inSchool(() =>
    storage.getClasspilotStudentControlState(schoolId, fixture.studentId)
  );
  assert.ok(controlState);
  const written = await writeClasspilotRealtimeStatus({
    schoolId,
    studentId: fixture.studentId,
    studentSessionId: fixture.studentSessionId,
    deviceId: fixture.deviceId,
    heartbeatId: randomUUID(),
    activeTabUrl: "https://example.invalid/lesson",
    activeTabTitle: "Synthetic lesson",
    acceptedCapabilities: ACCEPTED_CAPABILITIES,
    classroomState: serializeClasspilotStudentControlState(controlState),
  });
  assert.equal(written.status, "stored");
}

before(async () => {
  setClasspilotRealtimeStatusCommandForTests(sharedRealtimeCommand);

  const school = await storage.createSchool({
    name: tag,
    domain,
    slug: tag,
    status: "active",
    planStatus: "active",
  } as Parameters<typeof storage.createSchool>[0]);
  schoolId = school.id;
  await inSchool(() => storage.upsertSettings(schoolId, {
    schoolName: tag,
    wsSharedKey: `${tag}-shared-key`,
    enableTrackingHours: false,
    afterHoursMode: "off",
  }));
  await storage.createProductLicense({
    schoolId,
    product: "CLASSPILOT",
    status: "active",
  } as Parameters<typeof storage.createProductLicense>[0]);
  const teacher = await storage.createUser({
    email: `${tag}-teacher@${domain}`,
    firstName: "Synthetic",
    lastName: "Teacher",
  } as Parameters<typeof storage.createUser>[0]);
  await inSchool(() => storage.createMembership({
    userId: teacher.id,
    schoolId,
    role: "teacher",
    status: "active",
  } as Parameters<typeof storage.createMembership>[0]));

  observed = await createStudentFixture("observed");
  unobserved = await createStudentFixture("unobserved");
  limiterProbe = await createStudentFixture("limiter");
  takeover = await createStudentFixture("takeover");
  thrownProbe = await createStudentFixture("thrown");

  const teachingSession = await inSchool(async () => {
    const [group] = await db
      .insert(groups)
      .values({
        schoolId,
        teacherId: teacher.id,
        name: `${tag} class`,
        groupType: "admin_class",
        status: "active",
      })
      .returning({ id: groups.id });
    assert.ok(group?.id);
    await db.insert(groupStudents).values(
      [observed, unobserved, limiterProbe, takeover, thrownProbe].map((fixture) => ({
        groupId: group.id,
        studentId: fixture.studentId,
      }))
    );
    return storage.createTeachingSession({
      groupId: group.id,
      teacherId: teacher.id,
      sessionMode: "live",
    } as Parameters<typeof storage.createTeachingSession>[0]);
  });
  teachingSessionId = teachingSession.id;
  assert.ok(teachingSession.rosterSnapshotCompletedAt);

  for (const fixture of [observed, unobserved, limiterProbe, takeover, thrownProbe]) {
    await bindClassAuthority(fixture);
  }

  // Exactly one viewer, scoped to the observed student only. Everyone else in
  // the same live class resolves to the background cadence.
  resetClasspilotObservationLeasesForTests();
  await renewClasspilotObservationLease({
    schoolId,
    teachingSessionId,
    viewerUserId: teacher.id,
    viewerInstanceId: `${tag}-viewer`,
    scope: { kind: "students", studentIds: [observed.studentId] },
  });

  server = createServer(createApp());
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  // Counter assertions span async requests, but a UTC-minute rollover resets
  // their baseline on the next metric write. Pin Date.now after the database
  // fixture starts its live class, so authority still sees an active session.
  // HTTP timers and capture Date timestamps continue to use real time.
  const metricsNow = Date.now();
  const clock = mock.method(Date, "now", () => metricsNow);
  restoreMetricsClock = () => clock.mock.restore();
});

after(async () => {
  if (server) {
    const active = server;
    await new Promise<void>((resolve) => {
      active.close(() => resolve());
      active.closeAllConnections();
    });
  }
  setClasspilotRealtimeStatusCommandForTests(undefined);
  resetClasspilotObservationLeasesForTests();
  sharedRealtimeRows.clear();
  classpilotScreenshotFallback.clear();
  try {
    await asSystem(async () => {
      const devicePattern = `${tag}-%`;
      await db.execute(sql`DELETE FROM classpilot_student_control_states WHERE school_id = ${schoolId}`);
      await db.execute(sql`DELETE FROM classpilot_session_students WHERE school_id = ${schoolId}`);
      await db.execute(sql`DELETE FROM classpilot_session_staff WHERE school_id = ${schoolId}`);
      await db.execute(sql`DELETE FROM teaching_sessions WHERE school_id = ${schoolId}`);
      await db.execute(sql`
        DELETE FROM group_students
        WHERE group_id IN (SELECT id FROM groups WHERE school_id = ${schoolId})
      `);
      await db.execute(sql`DELETE FROM groups WHERE school_id = ${schoolId}`);
      await db.execute(sql`DELETE FROM student_sessions WHERE device_id LIKE ${devicePattern}`);
      await db.execute(sql`DELETE FROM student_devices WHERE device_id LIKE ${devicePattern}`);
      await db.execute(sql`DELETE FROM devices WHERE school_id = ${schoolId}`);
      await db.execute(sql`DELETE FROM students WHERE school_id = ${schoolId}`);
      await db.execute(sql`DELETE FROM product_licenses WHERE school_id = ${schoolId}`);
      await db.execute(sql`DELETE FROM school_memberships WHERE school_id = ${schoolId}`);
      await db.execute(sql`DELETE FROM settings WHERE school_id = ${schoolId}`);
      await db.execute(sql`DELETE FROM schools WHERE id = ${schoolId}`);
      await db.execute(sql`DELETE FROM users WHERE email LIKE ${`${tag}-%`}`);
    });
  } finally {
    await Promise.allSettled([
      pool.end(),
      sessionPool.end(),
      schedulerPool.end(),
      schedulerLockPool.end(),
    ]);
    restoreMetricsClock?.();
  }
});

describe("ClassPilot screenshot upload realtime publish gate", () => {
  it("publishes the screenshot-available event while the student is observed", async () => {
    const capturedAt = new Date();
    const before = skippedPublishCount();
    const response = await uploadScreenshot(observed, capture(observed, capturedAt));

    assert.equal(response.status, 200);
    assert.equal(response.body.retained, true);
    const policy = response.body.screenshotPolicy as {
      captureCadence?: { mode: string; intervalSeconds: number };
    };
    assert.equal(policy.captureCadence?.mode, "active_view");
    assert.equal(policy.captureCadence?.intervalSeconds, 5);
    assert.equal(skippedPublishCount(), before);

    const orderedKey = screenshotAvailableKey(observed);
    assert.equal(
      await waitForOrderedPublish(orderedKey, capturedAt.getTime()),
      true,
      "an observed upload must publish the revisioned screenshot-available event"
    );
    assert.equal(
      recordLocalOrderedDelivery(orderedKey, String(capturedAt.getTime())),
      false,
      "the publish must record the exact capture revision as its high-water mark"
    );
  });

  it("skips the publish transaction for a background-cadence upload", async () => {
    const capturedAt = new Date();
    const before = skippedPublishCount();
    const response = await uploadScreenshot(unobserved, capture(unobserved, capturedAt));

    assert.equal(response.status, 200);
    assert.equal(response.body.retained, true);
    const policy = response.body.screenshotPolicy as {
      captureCadence?: { mode: string; intervalSeconds: number };
    };
    assert.equal(policy.captureCadence?.mode, "background");
    assert.equal(policy.captureCadence?.intervalSeconds, 30);
    assert.equal(skippedPublishCount(), before + 1);

    const orderedKey = screenshotAvailableKey(unobserved);
    assert.equal(
      await waitForOrderedPublish(orderedKey, capturedAt.getTime()),
      false,
      "an unobserved upload must not publish a screenshot-available event"
    );
    assert.equal(
      recordLocalOrderedDelivery(orderedKey, String(capturedAt.getTime())),
      true,
      "no delivery may have been recorded for the unobserved capture revision"
    );
  });

  it("publishes a background-cadence upload when the observation read is indeterminate", async () => {
    // A takeover: the device already carries the new authority while the
    // cached snapshot still names the session it replaced, so the cadence
    // observation resolves "unavailable" rather than "unobserved".
    await writeSupersededRealtimeSession(takeover);

    const capturedAt = new Date();
    const before = skippedPublishCount();
    const unavailableBefore = cadenceUnavailableCount();
    const response = await uploadScreenshot(takeover, capture(takeover, capturedAt));

    assert.equal(response.status, 200);
    assert.equal(response.body.retained, true);
    const policy = response.body.screenshotPolicy as {
      captureCadence?: { mode: string; intervalSeconds: number };
    };
    // Load-bearing: the wire is unchanged. An observation we could not read
    // must never hand the device the five-second lane; only the server's
    // publish decision changes.
    assert.equal(policy.captureCadence?.mode, "background");
    assert.equal(policy.captureCadence?.intervalSeconds, 30);
    assert.equal(
      cadenceUnavailableCount(),
      unavailableBefore + 1,
      "the cadence must have resolved through the indeterminate branch"
    );

    assert.equal(
      skippedPublishCount(),
      before,
      "an indeterminate observation read must not suppress the announcement"
    );
    assert.equal(
      await waitForOrderedPublish(screenshotAvailableKey(takeover), capturedAt.getTime()),
      true,
      "the stored frame must still be announced to the class audience"
    );
  });

  it("cannot tell a thrown observation read from an unavailable one, and publishes either way", async () => {
    // The upload route injects a total loader, so the thrown branch lives one
    // layer down in the policy resolver. Pin the equivalence there first: a
    // loader that throws must land on exactly the background policy an
    // "unavailable" read produces, because that policy is all the publish gate
    // was ever able to see.
    const now = Date.now();
    const trackingSettings = await inSchool(() =>
      storage.getHeartbeatTrackingSettingsForSchool(schoolId)
    );
    const trackingAuthority = await inSchool(() =>
      storage.getClasspilotScreenshotAuthorityProjection({
        schoolId,
        studentId: thrownProbe.studentId,
        studentSessionId: thrownProbe.studentSessionId,
        deviceId: thrownProbe.deviceId,
      })
    );
    assert.ok(trackingSettings);
    assert.ok(trackingAuthority);
    const resolveWith = (
      observationStatus: Parameters<typeof resolveClasspilotScreenshotPolicy>[0]["observationStatus"]
    ) => resolveClasspilotScreenshotPolicy({
      schoolId,
      studentId: thrownProbe.studentId,
      teachingSessionId,
      acceptedCapabilities: ACCEPTED_CAPABILITIES,
      trackingSettings,
      trackingAuthority,
      now,
      observationStatus,
    }) as Promise<{
      mode: string;
      captureAllowed?: boolean;
      captureCadence?: { mode: string; intervalSeconds: number };
    }>;

    const thrown = await inSchool(() => resolveWith(async () => {
      throw new Error("synthetic observation store failure");
    }));
    const unreadable = await inSchool(() => resolveWith(
      async () => ({ status: "unavailable", expiresInSeconds: 0 })
    ));
    assert.equal(thrown.captureAllowed, true, "the tracking window must be open for this probe");
    assert.equal(thrown.captureCadence?.mode, "background");
    assert.deepEqual(
      thrown,
      unreadable,
      "a thrown observation read must be indistinguishable from an unavailable one"
    );

    // And the gate must publish for that shared state, not skip it.
    await writeSupersededRealtimeSession(thrownProbe);
    const capturedAt = new Date();
    const before = skippedPublishCount();
    const response = await uploadScreenshot(thrownProbe, capture(thrownProbe, capturedAt));

    assert.equal(response.status, 200);
    assert.equal(response.body.retained, true);
    assert.equal(
      skippedPublishCount(),
      before,
      "a read that failed outright must not suppress the announcement"
    );
    assert.equal(
      await waitForOrderedPublish(screenshotAvailableKey(thrownProbe), capturedAt.getTime()),
      true,
      "the stored frame must still be announced to the class audience"
    );
  });

  it("admits the five-second cadence and names its rate-limit rejection", async () => {
    let last: Awaited<ReturnType<typeof uploadScreenshot>> | undefined;
    for (let attempt = 0; attempt < 60; attempt += 1) {
      // Rejected bodies still consume the window, so this measures the ceiling
      // without paying for sixty retained captures.
      last = await uploadScreenshot(limiterProbe, { tabTitle: "no pixels" });
      assert.equal(last.status, 400, `upload ${attempt + 1} of 60 must not be rate limited`);
    }
    assert.equal(last?.limit, "60");

    const limited = await uploadScreenshot(limiterProbe, { tabTitle: "no pixels" });
    assert.equal(limited.status, 429);
    assert.equal(limited.body.code, "SCREENSHOT_UPLOAD_RATE_LIMITED");
    assert.equal(limited.body.error, "Too many screenshot uploads, please wait");
  });
});
