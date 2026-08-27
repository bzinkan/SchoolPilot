import test from "node:test";
import assert from "node:assert/strict";
import {
  resolveClasspilotScreenshotPolicy,
} from "../src/services/classpilotScreenshotPolicy.js";
import {
  beginClasspilotSessionSubscriptionMutation,
  correlateClasspilotSessionMessage,
  isCurrentClasspilotSessionSubscriptionMutation,
  parseClasspilotSessionSubscription,
} from "../src/services/classpilotSessionSubscription.js";
import {
  decodeScreenshotBatchRead,
  getScreenshot,
  recordLocalOrderedDelivery,
  screenshotBindingVersion,
  type ScreenshotBinding,
} from "../src/realtime/ws-redis.js";
import {
  classpilotScreenshotAvailableEvent,
  classpilotScreenshotAvailableOrderingKey,
} from "../src/services/classpilotScreenshotAvailability.js";
import { classpilotRealtimeOrderingKey } from "../src/services/classpilotRealtimeStatus.js";
import {
  classpilotObservationStatus,
  classpilotObservationSessionIsLive,
  CLASSPILOT_OBSERVATION_MAX_VIEWERS_PER_SESSION,
  renewClasspilotObservationLease,
  resetClasspilotObservationLeasesForTests,
} from "../src/services/classpilotObservationLease.js";

test("screenshot policy is shared, lease-aware, and fail-private", async () => {
  let legacyObservationCalls = 0;
  assert.deepEqual(await resolveClasspilotScreenshotPolicy({
    schoolId: "school",
    studentId: "student",
    teachingSessionId: "teaching-session",
    acceptedCapabilities: [],
    now: 1_000,
    observationStatus: async () => {
      legacyObservationCalls += 1;
      return { status: "observed", expiresInSeconds: 90 };
    },
  }), {
    mode: "legacy",
    observed: true,
    expiresInSeconds: 0,
    serverTime: new Date(1_000).toISOString(),
  });
  assert.equal(legacyObservationCalls, 0);

  assert.deepEqual(await resolveClasspilotScreenshotPolicy({
    schoolId: "school",
    studentId: "student",
    teachingSessionId: "teaching-session",
    acceptedCapabilities: ["screenshotObservationLeaseV1"],
    now: 2_000,
    observationStatus: async () => ({ status: "observed", expiresInSeconds: 45 }),
  }), {
    mode: "lease",
    observed: true,
    expiresInSeconds: 45,
    serverTime: new Date(2_000).toISOString(),
  });

  assert.deepEqual(await resolveClasspilotScreenshotPolicy({
    schoolId: "school",
    studentId: "student",
    teachingSessionId: "teaching-session",
    acceptedCapabilities: ["screenshotObservationLeaseV1"],
    now: 3_000,
    observationStatus: async () => {
      throw new Error("store unavailable");
    },
  }), {
    mode: "lease",
    observed: false,
    expiresInSeconds: 0,
    serverTime: new Date(3_000).toISOString(),
    diagnostic: "unavailable",
  });
});

test("screenshot availability uses an independent ordered stream without identifiers", () => {
  const schoolId = "school-screenshot-event";
  const deviceId = "internal-device-screenshot-event";
  const sessionId = "teaching-session-screenshot-event";
  const telemetryKey = `${classpilotRealtimeOrderingKey(schoolId, deviceId)}:session:${sessionId}`;
  const screenshotKey = `${classpilotScreenshotAvailableOrderingKey(schoolId, deviceId)}:session:${sessionId}`;
  const event = classpilotScreenshotAvailableEvent({
    studentId: "student-screenshot-event",
    capturedAt: "2026-08-27T15:00:00.000Z",
    timestamp: 1_777_300_000_000,
  });

  assert.notEqual(telemetryKey, screenshotKey);
  assert.equal(recordLocalOrderedDelivery(telemetryKey, "20"), true);
  assert.equal(recordLocalOrderedDelivery(screenshotKey, "1777300000000"), true);
  assert.deepEqual(event, {
    type: "screenshot-available",
    studentId: "student-screenshot-event",
    capturedAt: "2026-08-27T15:00:00.000Z",
    timestamp: 1_777_300_000_000,
  });
  assert.equal(Object.prototype.hasOwnProperty.call(event, "deviceId"), false);
});

test("production observation leases never fall back to process-local memory", async () => {
  const prior = {
    nodeEnv: process.env.NODE_ENV,
    appEnv: process.env.APP_ENV,
    redisUrl: process.env.REDIS_URL,
    hmacSecret: process.env.CLASSPILOT_OBSERVATION_HMAC_SECRET,
  };
  try {
    delete process.env.REDIS_URL;
    process.env.NODE_ENV = "test";
    delete process.env.APP_ENV;
    process.env.CLASSPILOT_OBSERVATION_HMAC_SECRET = "test-observation-secret";
    resetClasspilotObservationLeasesForTests();
    await renewClasspilotObservationLease({
      schoolId: "school",
      teachingSessionId: "session",
      viewerUserId: "viewer",
      viewerInstanceId: "viewer_instance",
      scope: { kind: "class" },
      now: 1_000,
    });

    process.env.NODE_ENV = "production";
    assert.deepEqual(await classpilotObservationStatus({
      schoolId: "school",
      teachingSessionId: "session",
      studentId: "student",
      now: 2_000,
    }), { status: "unavailable", expiresInSeconds: 0 });
    await assert.rejects(
      renewClasspilotObservationLease({
        schoolId: "school",
        teachingSessionId: "session",
        viewerUserId: "viewer",
        viewerInstanceId: "viewer_instance",
        scope: { kind: "class" },
        now: 2_000,
      }),
      /Observation lease storage unavailable/
    );
  } finally {
    if (prior.nodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = prior.nodeEnv;
    if (prior.appEnv === undefined) delete process.env.APP_ENV;
    else process.env.APP_ENV = prior.appEnv;
    if (prior.redisUrl === undefined) delete process.env.REDIS_URL;
    else process.env.REDIS_URL = prior.redisUrl;
    if (prior.hmacSecret === undefined) delete process.env.CLASSPILOT_OBSERVATION_HMAC_SECRET;
    else process.env.CLASSPILOT_OBSERVATION_HMAC_SECRET = prior.hmacSecret;
    resetClasspilotObservationLeasesForTests();
  }
});

test("observation leases require a live completed frozen roster", () => {
  assert.equal(classpilotObservationSessionIsLive({
    sessionMode: "live",
    endTime: null,
    rosterSnapshotCompletedAt: new Date(),
  }), true);
  assert.equal(classpilotObservationSessionIsLive({
    sessionMode: "historical",
    endTime: null,
    rosterSnapshotCompletedAt: new Date(),
  }), false);
  assert.equal(classpilotObservationSessionIsLive({
    sessionMode: "live",
    endTime: new Date(),
    rosterSnapshotCompletedAt: new Date(),
  }), false);
  assert.equal(classpilotObservationSessionIsLive({
    sessionMode: "live",
    endTime: null,
    rosterSnapshotCompletedAt: null,
  }), false);
  assert.equal(classpilotObservationSessionIsLive(null), false);
});

test("observation viewer cohorts stay bounded under minted viewer IDs", async () => {
  const prior = {
    nodeEnv: process.env.NODE_ENV,
    appEnv: process.env.APP_ENV,
    redisUrl: process.env.REDIS_URL,
    hmacSecret: process.env.CLASSPILOT_OBSERVATION_HMAC_SECRET,
  };
  try {
    delete process.env.REDIS_URL;
    process.env.NODE_ENV = "test";
    delete process.env.APP_ENV;
    process.env.CLASSPILOT_OBSERVATION_HMAC_SECRET = "test-observation-secret";
    resetClasspilotObservationLeasesForTests();
    for (
      let index = 0;
      index <= CLASSPILOT_OBSERVATION_MAX_VIEWERS_PER_SESSION;
      index += 1
    ) {
      await renewClasspilotObservationLease({
        schoolId: "school",
        teachingSessionId: "bounded-session",
        viewerUserId: "viewer",
        viewerInstanceId: `viewer_${String(index).padStart(4, "0")}`,
        scope: { kind: "students", studentIds: [`student-${index}`] },
        now: 1_000 + index,
      });
    }
    assert.deepEqual(await classpilotObservationStatus({
      schoolId: "school",
      teachingSessionId: "bounded-session",
      studentId: "student-0",
      now: 2_000,
    }), { status: "unobserved", expiresInSeconds: 0 });
    assert.equal((await classpilotObservationStatus({
      schoolId: "school",
      teachingSessionId: "bounded-session",
      studentId: `student-${CLASSPILOT_OBSERVATION_MAX_VIEWERS_PER_SESSION}`,
      now: 2_000,
    })).status, "observed");
  } finally {
    if (prior.nodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = prior.nodeEnv;
    if (prior.appEnv === undefined) delete process.env.APP_ENV;
    else process.env.APP_ENV = prior.appEnv;
    if (prior.redisUrl === undefined) delete process.env.REDIS_URL;
    else process.env.REDIS_URL = prior.redisUrl;
    if (prior.hmacSecret === undefined) delete process.env.CLASSPILOT_OBSERVATION_HMAC_SECRET;
    else process.env.CLASSPILOT_OBSERVATION_HMAC_SECRET = prior.hmacSecret;
    resetClasspilotObservationLeasesForTests();
  }
});

test("session subscriptions validate and correlate opaque request IDs", () => {
  assert.deepEqual(parseClasspilotSessionSubscription({
    type: "subscribe-session",
    teachingSessionId: "session-a",
    requestId: "tab_1.retry-2",
  }), {
    ok: true,
    action: "subscribe",
    teachingSessionId: "session-a",
    requestId: "tab_1.retry-2",
  });
  assert.deepEqual(parseClasspilotSessionSubscription({
    type: "unsubscribe-session",
    sessionId: "session-a",
  }), {
    ok: true,
    action: "unsubscribe",
    teachingSessionId: "session-a",
  });
  assert.deepEqual(parseClasspilotSessionSubscription({
    type: "subscribe-session",
    teachingSessionId: "session-a",
    requestId: "unsafe request id",
  }), { ok: false, code: "REQUEST_ID_INVALID" });
  assert.deepEqual(parseClasspilotSessionSubscription({
    type: "subscribe-session",
    requestId: "safe-id",
  }), { ok: false, code: "SESSION_ID_REQUIRED", requestId: "safe-id" });

  assert.deepEqual(correlateClasspilotSessionMessage("authoritative-session", {
    type: "student-update",
    teachingSessionId: "client-supplied-session",
  }), {
    type: "student-update",
    teachingSessionId: "authoritative-session",
  });
});

test("a later unsubscribe tombstones an in-flight subscribe authorization", () => {
  const state = {
    sessionSubscriptionEpochs: new Map<string, number>(),
    sessionSubscriptionIdentityGeneration: 4,
  };
  const delayedSubscribe = beginClasspilotSessionSubscriptionMutation(state, "session-a");
  assert.equal(
    isCurrentClasspilotSessionSubscriptionMutation(state, delayedSubscribe),
    true
  );

  const unsubscribe = beginClasspilotSessionSubscriptionMutation(state, "session-a");
  assert.equal(
    isCurrentClasspilotSessionSubscriptionMutation(state, unsubscribe),
    true
  );
  assert.equal(
    isCurrentClasspilotSessionSubscriptionMutation(state, delayedSubscribe),
    false,
    "the deferred subscribe must not mutate the socket after cleanup wins"
  );

  state.sessionSubscriptionIdentityGeneration += 1;
  assert.equal(
    isCurrentClasspilotSessionSubscriptionMutation(state, unsubscribe),
    false,
    "reauthentication invalidates every mutation from the prior identity"
  );
});

test("screenshot batch reads separate transport failure from per-row misses", () => {
  const now = Date.now();
  const bindingA: ScreenshotBinding = {
    schoolId: "school",
    deviceId: "device-a",
    studentId: "student-a",
    studentSessionId: "student-session-a",
  };
  const bindingB: ScreenshotBinding = {
    schoolId: "school",
    deviceId: "device-b",
    studentId: "student-b",
    studentSessionId: "student-session-b",
  };
  const exactA = JSON.stringify({
    screenshot: "data:image/jpeg;base64,AA==",
    timestamp: now,
    capturedAt: new Date(now).toISOString(),
    ...bindingA,
    bindingVersion: screenshotBindingVersion(bindingA),
  });
  const batch = decodeScreenshotBatchRead(
    [bindingA, bindingB],
    [exactA, "{malformed", null, null]
  );
  assert.equal(batch.status, "ok");
  if (batch.status === "ok") {
    assert.equal(batch.screenshots[0]?.screenshot, "data:image/jpeg;base64,AA==");
    assert.equal(batch.screenshots[1], null);
  }
  assert.deepEqual(
    decodeScreenshotBatchRead([bindingA, bindingB], [exactA]),
    { status: "unavailable" }
  );
  assert.deepEqual(
    decodeScreenshotBatchRead([bindingA, bindingB], undefined),
    { status: "unavailable" }
  );
});

test("production single screenshot reads report store unavailability", async () => {
  const priorNodeEnv = process.env.NODE_ENV;
  const priorAppEnv = process.env.APP_ENV;
  try {
    process.env.NODE_ENV = "production";
    delete process.env.APP_ENV;
    const read = await getScreenshot({
      schoolId: "school",
      deviceId: "device",
      studentId: "student",
      studentSessionId: "session",
    });
    assert.deepEqual(read, { status: "unavailable" });
  } finally {
    if (priorNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = priorNodeEnv;
    if (priorAppEnv === undefined) delete process.env.APP_ENV;
    else process.env.APP_ENV = priorAppEnv;
  }
});
