import { after, before, describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import type { WebSocket } from "ws";
import { Client } from "pg";

// These values must be set before importing any application module: the
// screenshot upload path resolves its cadence only for a school whose
// tracking-window and active-observation capabilities are rolled out.
process.env.NODE_ENV = "test";
process.env.SCHEDULER_ENABLED = "false";
assert.ok(process.env.TEST_REDIS_URL, "Ordered screenshot publication requires an explicit local Redis fixture");
assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(new URL(process.env.TEST_REDIS_URL).hostname),
  "Screenshot publication fixtures refuse non-loopback Redis");
// Keep unrelated API limiter clients in this fixture's original MemoryStore
// mode; only the realtime adapter under test owns the explicit Redis socket.
process.env.REDIS_URL = "";
process.env.CLASSPILOT_PROTOCOL_V3_ENABLED = "true";
process.env.CLASSPILOT_CAP_SCOPED_AUTHORITY_CHECKS_V1 = "true";
process.env.CLASSPILOT_CAP_SCREENSHOT_TRACKING_WINDOW_LEASE_V1 = "true";
process.env.CLASSPILOT_CAP_SCREENSHOT_ACTIVE_OBSERVATION_CADENCE_V1 = "true";
process.env.CLASSPILOT_CAP_AFTER_HOURS_SAFETY_ONLY_V1 = "true";
process.env.CLASSPILOT_CAP_EXACT_TAB_CLOSE_V2 = "true";

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

await import(new URL("../dist/middleware/rateLimiter.js", import.meta.url).href);
process.env.REDIS_URL = process.env.TEST_REDIS_URL;

const { default: db, pool, sessionPool } = await import("../dist/db.js");
const { runWithTenantContext } = await import("../dist/middleware/tenantContext.js");
const { tenantALS } = await import("../dist/db/tenantContext.js");
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
const { recordLocalOrderedDelivery, disposeWSRedis } = await import("../dist/realtime/ws-redis.js");
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
const { flushHeartbeatClassificationBatches } = await import("../dist/services/heartbeatClassificationBatcher.js");
const safety = await import("../dist/services/safetyCenter.js");
const { SAFETY_CENTER_SQL } = await import("../dist/db/safetyCenterMigration.js");
const { registerWsClient, authenticateWsClient, removeWsClient } = await import("../dist/realtime/ws-broadcast.js");

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
    // Dispatch by the stable command ABI, not the Lua implementation's text.
    if (args.length === 12 && args[2] === '1') {
      const encoded = key ? sharedRealtimeRows.get(key) : undefined;
      if (!key || !encoded) return '';
      const current = JSON.parse(encoded) as Record<string, unknown>;
      if (current.state !== 'active' || current.schoolId !== args[4] || current.studentId !== args[5]
        || current.studentSessionId !== args[6] || current.deviceId !== args[7] || current.heartbeatId !== args[8]) return '';
      const classification = JSON.parse(args[10] || 'null');
      if (classification === null) delete current.aiClassification;
      else current.aiClassification = classification;
      current.classificationPending = false;
      current.revision = Math.max(Number(args[9]) || 0, Number(current.revision || 0) + 1);
      const next = JSON.stringify(current); sharedRealtimeRows.set(key, next); return next;
    }
    assert.equal(args.length, 7, 'Only the declared write/classification ABI is supported in this fixture');
    assert.equal(args[2], '1');
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
let safetyAdminId = "";
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
  await pool.query(SAFETY_CENTER_SQL);
  setClasspilotRealtimeStatusCommandForTests(sharedRealtimeCommand);

  const school = await storage.createSchool({
    name: tag,
    domain,
    slug: tag,
    schoolTimezone: "UTC",
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
  const safetyAdmin = await storage.createUser({ email: `${tag}-admin@${domain}`, firstName: "Synthetic", lastName: "Administrator" });
  safetyAdminId = safetyAdmin.id;
  await storage.createMembership({ userId: safetyAdmin.id, schoolId, role: "school_admin", status: "active" });

  observed = await createStudentFixture("observed");
  unobserved = await createStudentFixture("unobserved");
  limiterProbe = await createStudentFixture("limiter");
  takeover = await createStudentFixture("takeover");
  thrownProbe = await createStudentFixture("thrown");

  const teachingSession = await inSchool(async () => {
    const group = await storage.createGroup({
        schoolId,
        teacherId: teacher.id,
        name: `${tag} class`,
        groupType: "admin_class",
        status: "active",
      });
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
      await db.execute(sql`DELETE FROM safety_url_exceptions WHERE school_id = ${schoolId}`);
      await db.execute(sql`DELETE FROM student_safety_cases WHERE school_id = ${schoolId}`);
      await db.execute(sql`DELETE FROM classpilot_student_control_states WHERE school_id = ${schoolId}`);
      await db.execute(sql`DELETE FROM classpilot_session_students WHERE school_id = ${schoolId}`);
      await db.execute(sql`DELETE FROM classpilot_session_staff WHERE school_id = ${schoolId}`);
      await db.execute(sql`DELETE FROM teaching_sessions WHERE school_id = ${schoolId}`);
      await db.execute(sql`
        DELETE FROM group_students
        WHERE group_id IN (SELECT id FROM groups WHERE school_id = ${schoolId})
      `);
      await db.transaction(async tx => {
        await tx.execute(sql`DELETE FROM group_teachers WHERE group_id IN (SELECT id FROM groups WHERE school_id=${schoolId})`);
        await tx.execute(sql`DELETE FROM groups WHERE school_id = ${schoolId}`);
      });
      await db.execute(sql`DELETE FROM student_sessions WHERE device_id LIKE ${devicePattern}`);
      await db.execute(sql`DELETE FROM student_devices WHERE device_id LIKE ${devicePattern}`);
      await db.execute(sql`DELETE FROM devices WHERE school_id = ${schoolId}`);
      await db.execute(sql`DELETE FROM students WHERE school_id = ${schoolId}`);
      await db.execute(sql`DELETE FROM product_licenses WHERE school_id = ${schoolId}`);
      await db.execute(sql`DELETE FROM school_memberships WHERE school_id = ${schoolId}`);
      await db.execute(sql`DELETE FROM settings WHERE school_id = ${schoolId}`);
      await db.execute(sql`DELETE FROM classpilot_school_schedules WHERE school_id = ${schoolId}`);
      await db.execute(sql`UPDATE schools SET status='suspended',is_active=false,deleted_at=now() WHERE id = ${schoolId}`);
    });
  } finally {
    await disposeWSRedis();
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
    const authorityBefore = snapshotHeartbeatHotPathMetrics().counters.screenshotAuthorityTransactions ?? 0;
    const publicationBefore = snapshotHeartbeatHotPathMetrics().timings.screenshotPublicationMs?.count ?? 0;
    const response = await uploadScreenshot(observed, capture(observed, capturedAt));

    assert.equal(response.status, 200);
    assert.equal(response.body.retained, true);
    const policy = response.body.screenshotPolicy as {
      captureCadence?: { mode: string; intervalSeconds: number };
    };
    assert.equal(policy.captureCadence?.mode, "active_view");
    assert.equal(policy.captureCadence?.intervalSeconds, 5);
    assert.equal(skippedPublishCount(), before);
    assert.equal(snapshotHeartbeatHotPathMetrics().counters.screenshotAuthorityTransactions, authorityBefore + 1);
    assert.equal(snapshotHeartbeatHotPathMetrics().timings.screenshotPublicationMs?.count, publicationBefore + 1);

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

  it("revalidates safety delivery against the current session, device, revision and manual lease", async () => {
    const controlState = await inSchool(() => storage.getClasspilotStudentControlState(schoolId, observed.studentId));
    assert.ok(controlState);
    const binding = { schoolId, studentId: observed.studentId, studentSessionId: observed.studentSessionId,
      deviceId: observed.deviceId, expectedControlRevision: controlState.revision,
      deliveredControlRevision: controlState.revision + 100, classifiedUrl: "https://www.google.com/search?q=xxx" };
    let calls = 0;
    const send = () => { calls += 1; };
    assert.equal(await inSchool(() => storage.revalidateClasspilotSafetyExactBinding(
      { ...binding, studentSessionId: randomUUID() }, send)), undefined);
    assert.equal(await inSchool(() => storage.revalidateClasspilotSafetyExactBinding(
      { ...binding, deviceId: `${observed.deviceId}-retired` }, send)), undefined);
    assert.equal(await inSchool(() => storage.revalidateClasspilotSafetyExactBinding(
      { ...binding, expectedControlRevision: controlState.revision + 1 }, send)), undefined);
    assert.equal(calls, 0, "retired bindings and stale control revisions must never reach synchronous delivery");

    try {
      await inSchool(() => db.update(studentSessions).set({ authKind: "manual_shared",
        manualLeaseExpiresAt: sql`clock_timestamp() - interval '1 second'`,
        sessionRecoveryTokenHash: randomUUID().replaceAll("-", "").padEnd(64, "a"),
      }).where(drizzle.eq(studentSessions.id, observed.studentSessionId)));
      assert.equal(await inSchool(() => storage.revalidateClasspilotSafetyExactBinding(binding, send)), undefined);
      assert.equal(calls, 0, "an expired manual lease must never authorize safety delivery");
    } finally {
      await inSchool(() => db.update(studentSessions).set({ authKind: "managed_profile",
        manualLeaseExpiresAt: null, sessionRecoveryTokenHash: null,
      }).where(drizzle.eq(studentSessions.id, observed.studentSessionId)));
    }
  });

  it("retains the control lock through the safety callback and preserves a deferred delivered revision", async () => {
    const priorRls = process.env.RLS_GUC_ENABLED;
    process.env.RLS_GUC_ENABLED = "true";
    const contender = new Client({ connectionString: process.env.DATABASE_URL });
    let callbackRan = false;
    let checkedLock = false;
    try {
      await contender.connect();
      await contender.query("BEGIN");
      const lockKey = `classpilot:student-control:${schoolId}:${observed.studentId}`;
      const binding = await inSchool(async () => {
        const store = tenantALS.getStore();
        assert.ok(store, "the lock probe requires one owned tenant checkout");
        const controlState = await storage.getClasspilotStudentControlState(schoolId, observed.studentId);
        assert.ok(controlState);
        const deferredRevision = controlState.revision + 100;
        const traced = new Proxy(store.db, {
          get(target, property) {
            if (property === "transaction") {
              return (action: Parameters<typeof target.transaction>[0]) => target.transaction(async tx => {
                const result = await action(tx);
                assert.equal(callbackRan, true, "the authorized callback must run inside the transaction");
                const probe = await contender.query("SELECT pg_try_advisory_xact_lock(hashtextextended($1,0::bigint)) AS acquired", [lockKey]);
                assert.equal(probe.rows[0]?.acquired, false, "the control lock must remain held after synchronous delivery");
                checkedLock = true;
                return result;
              });
            }
            const value = Reflect.get(target, property);
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
        return tenantALS.run({ ...store, db: traced }, () => storage.revalidateClasspilotSafetyExactBinding({
          schoolId, studentId: observed.studentId, studentSessionId: observed.studentSessionId, deviceId: observed.deviceId,
          expectedControlRevision: controlState.revision, deliveredControlRevision: deferredRevision,
          classifiedUrl: "https://www.google.com/search?q=xxx",
        }, current => {
          assert.equal(current.controlRevision, deferredRevision, "deferred foreground delivery must retain its delivered revision");
          callbackRan = true;
        }));
      });
      assert.ok(binding);
      assert.equal(checkedLock, true);
      const released = await contender.query("SELECT pg_try_advisory_xact_lock(hashtextextended($1,0::bigint)) AS acquired", [lockKey]);
      assert.equal(released.rows[0]?.acquired, true, "the lock must release only after the delivery transaction commits");
    } finally {
      await contender.query("ROLLBACK").catch(() => {});
      await contender.end();
      if (priorRls === undefined) delete process.env.RLS_GUC_ENABLED;
      else process.env.RLS_GUC_ENABLED = priorRls;
    }
  });

  it("closes each harmful search's exact tab despite merged alerts and legacy flags, while retaining administrator review", async () => {
    await inSchool(() => storage.upsertSettings(schoolId, { autoBlockUnsafeUrls: false, aiSafetyEmailsEnabled: false,
      allowedDomains: ["google.com"] }));
    const safetyCapabilities = [...ACCEPTED_CAPABILITIES, "exactTabCloseV2"];
    const delivered: Array<Record<string, unknown>> = [];
    const socket = {
      readyState: 1 as const,
      send: (raw: Parameters<WebSocket["send"]>[0]) => { delivered.push(JSON.parse(String(raw))); },
    } as WebSocket;
    registerWsClient(socket);
    authenticateWsClient(socket, { role: "student", schoolId, studentId: observed.studentId,
      studentSessionId: observed.studentSessionId, deviceId: observed.deviceId, acceptedCapabilities: safetyCapabilities });
    const unsafeUrl = "https://www.google.com/search?q=xxx";
    const unsafeTabRef = "synthetic-harmful-search-tab";
    const snapshotRevision = 7;
    const safetyCloses = () => delivered.filter(frame => frame.type === "remote-control")
      .map(frame => ({ frame, command: frame.command as Record<string, unknown> }))
      .filter(({ command }) => command.type === "close-tab");
    const heartbeat = async () => {
      const response = await fetch(`${baseUrl}/api/classpilot/device/heartbeat`, {
        method: "POST", headers: { authorization: `Bearer ${observed.token}`, "content-type": "application/json" },
        body: JSON.stringify({ clientProtocolVersion: 3, capabilities: safetyCapabilities,
          activeTabUrl: unsafeUrl, activeTabTitle: "Synthetic search safety fixture", activeTabRef: unsafeTabRef,
          tabSnapshotRevision: snapshotRevision,
          allOpenTabs: [
            { tabRef: unsafeTabRef, url: unsafeUrl, title: "Synthetic search safety fixture" },
            { tabRef: "synthetic-school-lesson-tab", url: `https://${domain}/lesson`, title: "School lesson" },
          ] }),
      });
      assert.equal(response.status, 200);
      await response.json();
      await flushHeartbeatClassificationBatches();
    };
    try {
      await heartbeat();
      assert.equal(safetyCloses().length, 1, "the first harmful search must issue an exact tab-close command");
      await heartbeat();
      const closes = safetyCloses();
      assert.equal(closes.length, 2, "merging an alert must not suppress closure of a repeated harmful search");
      const controlState = await inSchool(() => storage.getClasspilotStudentControlState(schoolId, observed.studentId));
      assert.ok(controlState);
      const exactBinding = { bindingVersion: 2, schoolId, deviceId: observed.deviceId,
        studentId: observed.studentId, studentSessionId: observed.studentSessionId, controlRevision: controlState.revision };
      for (const { frame, command } of closes) {
        assert.equal(frame.studentId, observed.studentId);
        assert.equal(frame.studentSessionId, observed.studentSessionId);
        assert.deepEqual(frame.exactBinding, exactBinding);
        assert.deepEqual(command.exactBinding, exactBinding);
        assert.deepEqual(command.authority, { kind: "school_policy", schoolId, source: "ai_safety" });
        assert.deepEqual(command.data, { tabRefs: [unsafeTabRef], snapshotRevision,
          studentId: observed.studentId, studentSessionId: observed.studentSessionId });
        assert.equal(frame.deliveryPolicy, "transient_action");
        assert.equal(command.deliveryPolicy, "transient_action");
        assert.equal(command.expiresAt, frame.expiresAt);
        const remaining = Date.parse(String(frame.expiresAt)) - new Date().getTime();
        assert.ok(remaining > 0 && remaining <= 15_000, "safety closure must retain its short delivery deadline");
      }
      const alerts = await inSchool(() => db.execute(sql`SELECT a.id,a.case_id,a.observation_count,a.reviewed_at,a.concern,a.classification_source,a.matched_term FROM student_safety_alerts a
        WHERE a.school_id=${schoolId} AND a.student_id=${observed.studentId}`));
      assert.equal(alerts.rows.length, 1);
      const alert = alerts.rows[0]!;
      assert.equal(alert.observation_count, 2);
      assert.equal(alert.reviewed_at, null);
      assert.equal(alert.concern, "sexual");
      assert.equal(alert.classification_source, "search");
      assert.equal(alert.matched_term, "xxx");
      const decisions = await inSchool(() => db.execute(sql`SELECT action_taken FROM classpilot_ai_decisions
        WHERE school_id=${schoolId} AND student_id=${observed.studentId} AND safety_alert='sexual'`));
      assert.deepEqual(decisions.rows, [{ action_taken: "close-tab" }], "the decision must describe the requested closure");
      const timeline = await inSchool(() => db.execute(sql`SELECT metadata->>'actionTaken' AS action_taken FROM student_timeline_events
        WHERE school_id=${schoolId} AND student_id=${observed.studentId} AND event_type='browser_safety_alert'`));
      assert.deepEqual(timeline.rows, [{ action_taken: "close-tab" }], "the timeline must preserve the requested action without claiming client confirmation");
      const outbox = await inSchool(() => db.execute(sql`SELECT id,recipient,status FROM safety_notification_outbox
        WHERE school_id=${schoolId} AND alert_id=${alert.id} AND kind='initial'`));
      assert.deepEqual(outbox.rows.map(row => ({ recipient: row.recipient, status: row.status })),
        [{ recipient: `${tag}-admin@${domain}`, status: 'pending' }]);
      const commands = await inSchool(() => db.execute(sql`SELECT command_type FROM classpilot_commands WHERE school_id=${schoolId}`));
      assert.equal(commands.rows.length, 0, "automatic safety closure must not invent teacher command authority");
      const settings = await inSchool(() => storage.getSettingsForSchool(schoolId));
      assert.deepEqual(settings?.blockedDomains ?? [], [], "closing a harmful query must not block Google or another whole website");
      await inSchool(() => safety.reviewSafetyAlert({ schoolId, alertId: String(alert.id), actorId: safetyAdminId, revision: 0, action: 'suppress' }));
      let approvedUrlDelivered = false;
      const approvedBinding = await inSchool(() => storage.revalidateClasspilotSafetyExactBinding({
        schoolId, studentId: observed.studentId, studentSessionId: observed.studentSessionId, deviceId: observed.deviceId,
        expectedControlRevision: controlState.revision, deliveredControlRevision: controlState.revision, classifiedUrl: unsafeUrl,
      }, () => { approvedUrlDelivered = true; }));
      assert.equal(approvedBinding, undefined, "a late exact-URL approval must invalidate an already classified safety action");
      assert.equal(approvedUrlDelivered, false, "the locked approval recheck must prevent stale approved-URL closure");
      await heartbeat();
      assert.equal(safetyCloses().length, 2, "an exact approved URL must not be automatically closed again");
      const current = [...sharedRealtimeRows.values()].map(raw => JSON.parse(raw)).find(row => row.studentId === observed.studentId);
      assert.equal(current.aiClassification.safetyAlert, null);
      const after = await inSchool(() => db.execute(sql`SELECT observation_count FROM student_safety_alerts WHERE school_id=${schoolId} AND id=${alert.id}`));
      assert.equal(after.rows[0]?.observation_count, 2);
      const afterOutbox = await inSchool(() => db.execute(sql`SELECT id,recipient,status FROM safety_notification_outbox
        WHERE school_id=${schoolId} AND alert_id=${alert.id} AND kind='initial'`));
      assert.deepEqual(afterOutbox.rows, outbox.rows.map(row => ({ ...row, status: "cancelled" })),
        "approval may cancel the existing unsent notification but must not recreate it");
    } finally { removeWsClient(socket); }
  });

  it("withholds pixels, classroom state and ordinary history outside hours, including old clients", async () => {
    await inSchool(() => storage.upsertSettings(schoolId, {
      enableTrackingHours: true, schoolTimezone: "UTC", trackingStartTime: "00:00", trackingEndTime: "00:01",
      trackingDays: new Date().getUTCDay() === 1 ? ["Tuesday"] : ["Monday"], afterHoursMode: "limited",
    }));
    const before = snapshotHeartbeatHotPathMetrics().counters.heartbeatRecorded ?? 0;
    const realtimeBefore = [...sharedRealtimeRows.entries()];
    for (const capable of [false, true]) {
      const response = await fetch(`${baseUrl}/api/classpilot/device/heartbeat`, {
        method: "POST", headers: { authorization: `Bearer ${observed.token}`, "content-type": "application/json" },
        body: JSON.stringify({ clientProtocolVersion: 3,
          capabilities: [...ACCEPTED_CAPABILITIES, ...(capable ? ["afterHoursSafetyOnlyV1"] : [])],
          activeTabUrl: `https://${domain}/lesson`, activeTabTitle: "School lesson",
          allOpenTabs: [{ url: "https://private.example/never-retain" }], screenLocked: true,
        }),
      });
      assert.equal(response.status, 200);
      const body = await response.json() as {
        monitoringPolicy: { mode: string }; classroomState?: unknown;
        screenshotPolicy: { observed: boolean }; pendingMessages: unknown[];
      };
      assert.equal(body.monitoringPolicy.mode, capable ? "safety_only" : "off");
      assert.equal(body.classroomState, undefined);
      assert.equal(body.screenshotPolicy.observed, false);
      assert.deepEqual(body.pendingMessages, []);
    }
    assert.equal(snapshotHeartbeatHotPathMetrics().counters.heartbeatRecorded ?? 0, before);
    assert.deepEqual([...sharedRealtimeRows.entries()], realtimeBefore);
    const upload = await uploadScreenshot(observed, capture(observed, new Date()));
    assert.equal(upload.status, 403);
    assert.equal(upload.body.code, "MONITORING_OUTSIDE_SCHOOL_HOURS");
  });

  it("an instructional closure keeps capable safety alerts but forbids ordinary telemetry and pixels", async () => {
    const today = new Date().toISOString().slice(0, 10);
    await inSchool(() => storage.upsertSettings(schoolId, {
      enableTrackingHours: true, schoolTimezone: "UTC", trackingStartTime: "00:00", trackingEndTime: "23:59",
      trackingDays: ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"], afterHoursMode: "limited",
    }));
    const { emptySchoolSchedulingConfig } = await import("../dist/services/classpilotSchedulingRules.js");
    const { resolveClasspilotMonitoringPolicy } = await import("../dist/services/classpilotMonitoringPolicy.js");
    const changeDate = async (instructional: boolean) => inSchool(() => storage.withClasspilotSchedulePostCommitTransaction(async tx => {
      const config = { ...emptySchoolSchedulingConfig(), dateOverrides: { [today]: { instructional } } };
      await tx.execute(sql`INSERT INTO classpilot_school_schedules(school_id,config) VALUES(${schoolId},${JSON.stringify(config)}::jsonb)
        ON CONFLICT(school_id) DO UPDATE SET config=EXCLUDED.config,revision=classpilot_school_schedules.revision+1`);
      storage.recordClasspilotMonitoringPolicyChange(tx, schoolId);
    }));
    await changeDate(true);
    assert.equal(resolveClasspilotMonitoringPolicy(await inSchool(() => storage.getHeartbeatTrackingSettingsForSchool(schoolId))).mode, "full");
    await changeDate(false);
    const before = snapshotHeartbeatHotPathMetrics().counters.heartbeatRecorded ?? 0;
    const realtimeBefore = [...sharedRealtimeRows.entries()];
    const response = await fetch(`${baseUrl}/api/classpilot/device/heartbeat`, {
      method: "POST", headers: { authorization: `Bearer ${unobserved.token}`, "content-type": "application/json" },
      body: JSON.stringify({ clientProtocolVersion: 3, capabilities: [...ACCEPTED_CAPABILITIES, "afterHoursSafetyOnlyV1"],
        activeTabUrl: "https://xvideos.com/synthetic-closure", activeTabTitle: "Synthetic closure safety fixture",
        allOpenTabs: [{ url: "https://private.example/never-retain" }], screenLocked: true }),
    });
    assert.equal(response.status, 200);
    const body = await response.json() as {
      monitoringPolicy: { mode: string };
      classroomState?: unknown;
      screenshotPolicy: { observed: boolean };
    };
    assert.equal(body.monitoringPolicy.mode, "safety_only");
    assert.equal(body.classroomState, undefined);
    assert.equal(body.screenshotPolicy.observed, false);
    await flushHeartbeatClassificationBatches();
    assert.equal(snapshotHeartbeatHotPathMetrics().counters.heartbeatRecorded ?? 0, before);
    assert.deepEqual([...sharedRealtimeRows.entries()], realtimeBefore);
    const alerts = await inSchool(() => db.execute(sql`SELECT severity,heartbeat_id FROM student_safety_alerts WHERE school_id=${schoolId} AND student_id=${unobserved.studentId}`));
    assert.deepEqual(alerts.rows, [{ severity: "medium", heartbeat_id: null }]);
    const commands = await inSchool(() => db.execute(sql`SELECT id FROM classpilot_commands WHERE school_id=${schoolId}`));
    assert.equal(commands.rows.length, 0);
    assert.equal((await uploadScreenshot(unobserved, capture(unobserved, new Date()))).status, 403);
  });
});
