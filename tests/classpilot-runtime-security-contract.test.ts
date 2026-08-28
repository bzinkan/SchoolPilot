import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

import { pollResponseRateLimitKey } from "../src/routes/classpilot/chat.js";
import {
  classpilotCommandAuthorityEnvelope,
  classpilotSchoolPolicyAuthorityEnvelope,
} from "../src/services/classpilotCommandAuthority.js";
import {
  CLASSPILOT_SIGNALING_CANDIDATE_MAX_LENGTH,
  CLASSPILOT_SIGNALING_SDP_MAX_LENGTH,
  CLASSPILOT_WS_MAX_PAYLOAD_BYTES,
  normalizeClasspilotSignalingIdentifier,
  sanitizeClasspilotSignalingMessage,
} from "../src/services/classpilotSignaling.js";
import {
  CLASSPILOT_WS_FRAME_BUCKET_CAPACITY,
  CLASSPILOT_WS_MAX_PENDING_FRAMES,
  CLASSPILOT_LIVE_VIEW_NEGOTIATION_TTL_MS,
  CLASSPILOT_LIVE_VIEW_SETUP_TTL_MS,
  consumeClasspilotWsFrame,
  createClasspilotLiveViewNegotiationId,
  createClasspilotWsFrameBucket,
  claimClasspilotLiveViewNegotiation,
  classpilotLiveViewNegotiationAuthority,
  isClasspilotLiveViewNegotiationActive,
  listActiveClasspilotLiveViewNegotiations,
  releaseClasspilotLiveViewNegotiation,
  verifyClasspilotLiveViewNegotiation,
} from "../src/services/classpilotLiveViewNegotiation.js";
import { createRequireClasspilotEntitlement } from "../src/middleware/requireClasspilotEntitlement.js";
import { isClasspilotSchoolActive } from "../src/services/classpilotEntitlement.js";
import {
  authenticateWsClient,
  registerWsClient,
  resetWsState,
  sendToStaffUserLocal,
  subscribeWsClientToSession,
} from "../src/realtime/ws-broadcast.js";

async function source(path: string): Promise<string> {
  return readFile(new URL(`../${path}`, import.meta.url), "utf8");
}

describe("ClassPilot authenticated HTTP recovery and rate limits", () => {
  it("keys poll responses by authenticated school and student session after auth", async () => {
    const req = { ip: "203.0.113.10", socket: { remoteAddress: "203.0.113.10" } };
    const keys = Array.from({ length: 61 }, (_, index) => pollResponseRateLimitKey(req, {
      locals: { schoolId: "school-1", studentSessionId: `student-session-${index}` },
    }));
    assert.equal(new Set(keys).size, 61, "61 devices behind one NAT must have independent buckets");
    assert.equal(
      pollResponseRateLimitKey(req, { locals: { schoolId: "school-1", studentSessionId: "same-session" } }),
      pollResponseRateLimitKey(
        { ip: "198.51.100.9", socket: { remoteAddress: "198.51.100.9" } },
        { locals: { schoolId: "school-1", studentSessionId: "same-session" } }
      )
    );
    assert.match(pollResponseRateLimitKey(req, { locals: {} }), /^ip:/);

    const chat = await source("src/routes/classpilot/chat.ts");
    assert.match(
      chat,
      /router\.post\("\/polls\/:pollId\/respond", requireDeviceAuth, pollResponseLimiter, requireClasspilotEntitlement/
    );
  });

  it("returns FAB state only for an explicit heartbeat recovery request", async () => {
    const devices = await source("src/routes/classpilot/devices.ts");
    const heartbeat = devices.slice(
      devices.indexOf('router.post("/device/heartbeat"'),
      devices.indexOf('router.post("/device/screenshot"')
    );
    assert.match(heartbeat, /req\.body\?\.requestFabState === true/);
    assert.match(
      heartbeat,
      /runWithTenantContext\([\s\S]*?\{ schoolId \}[\s\S]*?buildStudentFabState\(schoolId, studentId, \{ studentSessionId \}\)/
    );
    assert.match(heartbeat, /\.\.\.\(fab \? \{ fab \} : \{\}\)/);
    assert.equal(heartbeat.match(/buildStudentFabState\(/g)?.length, 1);
  });

  it("targets claimed-student realtime updates to only the assigned staff user", async () => {
    const [devices, storage, lifecycle] = await Promise.all([
      source("src/routes/classpilot/devices.ts"),
      source("src/services/storage.ts"),
      source("src/services/classpilotStudentSessionLifecycle.ts"),
    ]);
    const publisher = devices.slice(
      devices.indexOf("async function publishRevisionedRealtimeUpdate"),
      devices.indexOf("async function broadcastStudentSignedOut")
    );
    assert.match(publisher, /authority\?\.supervisionContextId/);
    assert.doesNotMatch(publisher, /snapshot\.classroomState/);
    assert.match(publisher, /withClasspilotTeachingTelemetryAuthority/);
    assert.match(publisher, /withClasspilotSupervisionTelemetryAuthority/);
    assert.match(publisher, /kind: "staff-user"/);
    assert.match(publisher, /sendToStaffUserLocal/);
    assert.doesNotMatch(publisher, /targetDeviceIds|message\.deviceId/);
    const authority = storage.slice(
      storage.indexOf("export async function withClasspilotSupervisionTelemetryAuthority"),
      storage.indexOf("export async function getActiveSupervisionContextForStaffGroup")
    );
    const bindingAuthority = storage.slice(
      storage.indexOf("async function hasExactClasspilotTelemetryBinding"),
      storage.indexOf("/** Linearize ordinary class telemetry")
    );
    assert.match(authority, /controlState\.revision !== options\.controlRevision/);
    assert.match(authority, /hasExactClasspilotTelemetryBinding/);
    assert.match(bindingAuthority, /eq\(studentSessions\.id, options\.studentSessionId\)/);
    assert.match(bindingAuthority, /eq\(studentSessions\.deviceId, options\.deviceId\)/);
    assert.match(authority, /eq\(classpilotSupervisionContexts\.status, "active"\)/);
    assert.match(authority, /isNull\(classpilotSupervisionStudents\.releasedAt\)/);
    assert.match(authority, /assignedStaffId: context\.assignedStaffId/);
    assert.match(bindingAuthority, /options\.allowEndedBinding/);
    assert.match(bindingAuthority, /ne\(studentSessions\.id, options\.studentSessionId\)/);
    assert.match(lifecycle, /allowEndedBinding: true/);
    const heartbeat = devices.slice(
      devices.indexOf('router.post("/device/heartbeat"'),
      devices.indexOf('router.post("/device/screenshot"')
    );
    assert.match(heartbeat, /const telemetryAuthority = realtimeControlAuthority\(controlState\)/);
    assert.match(heartbeat, /publishRevisionedRealtimeUpdate\(realtimeSnapshot, update, telemetryAuthority\)/);
    assert.match(lifecycle, /allowEndedBinding: true/);
    const coverageHydration = await source("src/services/classpilotCoverageHydration.ts");
    assert.match(devices, /liveViewNegotiationV1: extensionCapabilities\.has\("liveViewNegotiationV1"\)/);
    assert.match(coverageHydration, /liveViewNegotiationV1: capabilities\.has\("liveViewNegotiationV1"\)/);
  });
});

describe("ClassPilot tracking-window screenshot authority", () => {
  it("keeps the new capability additive and issues the locked policy schema", async () => {
    const [protocol, policy] = await Promise.all([
      source("src/services/classpilotProtocol.ts"),
      source("src/services/classpilotScreenshotPolicy.ts"),
    ]);
    assert.match(protocol, /"screenshotObservationLeaseV1"/);
    assert.match(protocol, /"screenshotTrackingWindowLeaseV1"/);
    assert.match(protocol, /CLASSPILOT_CAP_SCREENSHOT_TRACKING_WINDOW_LEASE_V1/);
    assert.match(policy, /mode: "tracking_window_lease"/);
    assert.match(policy, /captureAllowed:/);
    const trackingPolicy = policy.slice(
      policy.indexOf("export function resolveClasspilotScreenshotTrackingWindowPolicy"),
      policy.indexOf("export function parseClasspilotScreenshotAuthority")
    );
    assert.doesNotMatch(trackingPolicy, /observed:/);
  });

  it("never short-circuits a tracking-window transition heartbeat before issuing policy", async () => {
    const devices = await source("src/routes/classpilot/devices.ts");
    const heartbeat = devices.slice(
      devices.indexOf('router.post("/device/heartbeat"'),
      devices.indexOf('router.post("/device/screenshot"')
    );
    assert.match(
      heartbeat,
      /const trackingWindowScreenshotLeaseNegotiated = protocol\.acceptedCapabilities\.includes\([\s\S]*?"screenshotTrackingWindowLeaseV1"[\s\S]*?\)/
    );
    assert.match(
      heartbeat,
      /canShortCircuitAcceptedHeartbeat\(\{[\s\S]*?acceptedCapabilities: protocol\.acceptedCapabilities,[\s\S]*?\}\)/
    );
    assert.match(
      heartbeat,
      /const screenshotTrackingAuthority = trackingWindowScreenshotLeaseNegotiated[\s\S]*?getClasspilotScreenshotAuthorityProjection/
    );
  });

  it("linearizes exact authority, uncached settings, and storage in one transaction", async () => {
    const [devices, storage] = await Promise.all([
      source("src/routes/classpilot/devices.ts"),
      source("src/services/storage.ts"),
    ]);
    const upload = devices.slice(
      devices.indexOf('router.post("/device/screenshot"'),
      devices.indexOf('router.post("/tiles/screenshots"')
    );
    assert.match(upload, /parseClasspilotScreenshotAuthority\(screenshotAuthority\)/);
    assert.match(upload, /withClasspilotScreenshotUploadAuthority/);
    assert.match(upload, /validateClasspilotScreenshotCapturedAt/);
    assert.match(upload, /SCREENSHOT_AUTHORITY_SUPERSEDED/);
    assert.match(upload, /SCREENSHOT_CAPTURE_PAUSED/);
    assert.doesNotMatch(upload, /SCREENSHOT_AUTHORITY_UNAVAILABLE|SCREENSHOT_TRACKING_WINDOW_CLOSED/);
    assert.match(upload, /outcome: "discarded"/);
    assert.match(upload, /setClassBoundScreenshot/);
    assert.match(upload, /retained: false/);
    const authority = storage.slice(
      storage.indexOf("export async function withClasspilotScreenshotUploadAuthority"),
      storage.indexOf("/** Linearize ordinary class telemetry")
    );
    assert.match(authority, /assertClasspilotEntitled[\s\S]*lock: true/);
    assert.match(authority, /lockClasspilotStudentControlAuthorities/);
    assert.match(authority, /\.from\(settings\)[\s\S]*\.for\("share"\)/);
    assert.match(authority, /value: await callback/);
  });

  it("keeps V2 class storage isolated and never downgrades without fresh proof", async () => {
    const [devices, redis, storage] = await Promise.all([
      source("src/routes/classpilot/devices.ts"),
      source("src/realtime/ws-redis.ts"),
      source("src/services/storage.ts"),
    ]);
    const tileRoute = devices.slice(
      devices.indexOf('router.post("/tiles/screenshots"'),
      devices.indexOf('router.post("/tiles/history"')
    );
    assert.match(tileRoute, /access\.controlRevision/);
    assert.match(tileRoute, /getClassBoundScreenshots\(classBindings\)/);
    assert.match(tileRoute, /classpilotRealtimeFresh\(realtime\.snapshot\)/);
    assert.match(tileRoute, /freshCapabilities === null[\s\S]*classBindings\.push\(classBinding\)[\s\S]*continue/);
    assert.match(tileRoute, /freshCapabilities\.includes\("screenshotTrackingWindowLeaseV1"\)[\s\S]*classBindings\.push\(classBinding\)[\s\S]*else[\s\S]*legacyBindings\.push\(exactBinding\)/);
    assert.match(tileRoute, /bindingVersion: classBoundScreenshotBindingVersion\(classBinding\)/);
    const tileAuthority = storage.slice(
      storage.indexOf("export function buildClassPilotTileAuthorizationQuery"),
      storage.indexOf("function tileDeviceFromRow")
    );
    assert.ok(
      (tileAuthority.match(/selected_session\.scheduled_end_at > now\(\)/g) || []).length >= 2,
      "both selected-class reader branches must reject an expired teaching session"
    );
    assert.ok(
      (tileAuthority.match(/LEFT JOIN active_supervision AS reassigned/g) || []).length >= 2,
      "selected-class readers must withhold class-bound pixels during any active supervision"
    );
    assert.ok(
      (tileAuthority.match(/AND reassigned\.student_id IS NULL/g) || []).length >= 2,
      "active supervision must fail closed for both admin and teacher selected-class reads"
    );
    assert.match(redis, /class-bound:/);
    const classWriter = redis.slice(
      redis.indexOf("export async function setClassBoundScreenshot"),
      redis.indexOf("export async function getScreenshot")
    );
    const classReader = redis.slice(
      redis.indexOf("export async function getClassBoundScreenshots"),
      redis.indexOf("// Flight path status storage")
    );
    assert.doesNotMatch(classWriter, /legacyKey|allowLegacy/);
    assert.doesNotMatch(classReader, /legacyKey|allowLegacy/);
  });
});

describe("ClassPilot command authority envelopes", () => {
  it("serializes persisted classroom authority with compatibility aliases", async () => {
    assert.deepEqual(classpilotCommandAuthorityEnvelope({ teachingSessionId: "session-1" }), {
      authority: { teachingSessionId: "session-1", supervisionContextId: null },
      teachingSessionId: "session-1",
      supervisionContextId: null,
    });
    assert.deepEqual(classpilotCommandAuthorityEnvelope({ supervisionContextId: "coverage-1" }), {
      authority: { teachingSessionId: null, supervisionContextId: "coverage-1" },
      teachingSessionId: null,
      supervisionContextId: "coverage-1",
    });
    const dispatcher = await source("src/services/classpilotCommandDispatcher.ts");
    assert.match(dispatcher, /const commandAuthority = classpilotCommandAuthorityEnvelope\(created\)/);
    assert.match(dispatcher, /command:\s*\{[\s\S]*?\.\.\.commandAuthority[\s\S]*?data:/);
    assert.doesNotMatch(
      dispatcher.slice(
        dispatcher.indexOf("const commandAuthority = classpilotCommandAuthorityEnvelope(created)"),
        dispatcher.indexOf("const sentTargets")
      ),
      /options\.teachingSessionId|options\.supervisionContextId/
    );
  });

  it("binds every per-target command envelope to the frozen student session", async () => {
    const [dispatcher, chat, devices, dashboard] = await Promise.all([
      source("src/services/classpilotCommandDispatcher.ts"),
      source("src/routes/classpilot/chat.ts"),
      source("src/routes/classpilot/devices.ts"),
      source("src/routes/classpilot/dashboard.ts"),
    ]);
    const envelopes = dispatcher.slice(
      dispatcher.indexOf("export function classpilotCommandFrameForTarget"),
      dispatcher.indexOf("async function endStudentSessionsForSignOut")
    );
    assert.match(envelopes, /const bindingEnvelope = \{[\s\S]*studentId: target\.studentId,[\s\S]*studentSessionId: target\.studentSessionId/);
    assert.equal(envelopes.match(/\.\.\.bindingEnvelope/g)?.length, 5);
    assert.match(chat, /studentSessionId: targetBinding\.id/);
    assert.match(chat, /studentSessionId: binding\.id/);
    assert.match(devices, /classpilotSchoolPolicyAuthorityEnvelope\(schoolId, "ai_safety"\)[\s\S]*studentSessionId/);
    assert.match(dashboard, /getActiveSessions\(sid\)[\s\S]*studentSessionId: binding\.id/);
    assert.doesNotMatch(dashboard, /publishWS\(\{ kind: "students", schoolId: sid \}, limitMsg\)/);
  });

  it("uses explicit school-policy authority only for approved safety and settings senders", async () => {
    assert.deepEqual(classpilotSchoolPolicyAuthorityEnvelope("school-1", "ai_safety"), {
      authority: { kind: "school_policy", schoolId: "school-1", source: "ai_safety" },
    });
    const [devices, dashboard] = await Promise.all([
      source("src/routes/classpilot/devices.ts"),
      source("src/routes/classpilot/dashboard.ts"),
    ]);
    assert.match(devices, /classpilotSchoolPolicyAuthorityEnvelope\(schoolId, "ai_safety"\)/);
    assert.match(dashboard, /classpilotSchoolPolicyAuthorityEnvelope\(sid, "school_settings"\)/);
    assert.ok(
      devices.indexOf('router.use("/remote"') < devices.indexOf('router.post("/remote/open-tab"'),
      "the 410 retirement guard must run before every legacy /remote action"
    );
    assert.match(devices, /LEGACY_DEVICE_TARGETING_RETIRED/);
    const flightPaths = await source("src/routes/classpilot/flightPaths.ts");
    assert.equal(flightPaths.match(/router\.post\("\/block-lists\/:id\/apply"/g)?.length, 1);
    assert.doesNotMatch(flightPaths, /type:\s*"remote-control"/);
  });
});

describe("ClassPilot WebSocket signaling containment", () => {
  it("bounds transport and relayed SDP/candidate payloads", async () => {
    assert.equal(CLASSPILOT_WS_MAX_PAYLOAD_BYTES, 256 * 1024);
    assert.deepEqual(sanitizeClasspilotSignalingMessage("offer", {
      sdp: { type: "offer", sdp: "v=0\r\n", ignored: "not-forwarded" },
    }), { sdp: { type: "offer", sdp: "v=0\r\n" } });
    assert.equal(sanitizeClasspilotSignalingMessage("offer", {
      sdp: { type: "offer", sdp: "x".repeat(CLASSPILOT_SIGNALING_SDP_MAX_LENGTH + 1) },
    }), null);
    assert.equal(sanitizeClasspilotSignalingMessage("ice", {
      candidate: { candidate: "x".repeat(CLASSPILOT_SIGNALING_CANDIDATE_MAX_LENGTH + 1) },
    }), null);
    assert.equal(normalizeClasspilotSignalingIdentifier(" student-1 "), null);
    assert.equal(normalizeClasspilotSignalingIdentifier("student-1"), "student-1");

    const websocket = await source("src/realtime/websocket.ts");
    assert.match(websocket, /maxPayload: CLASSPILOT_WS_MAX_PAYLOAD_BYTES/);
    const relay = websocket.slice(
      websocket.indexOf("// --- WebRTC signaling"),
      websocket.indexOf("// --- Remote control: request-stream")
    );
    assert.match(relay, /sanitizeClasspilotSignalingMessage\(message\.type, message\)/);
    assert.match(relay, /if \(!signaling\) return;/);
    assert.doesNotMatch(relay, /sdp: message\.sdp|candidate: message\.candidate/);
  });

  it("serializes and rate-limits frames while binding signaling to one live-view negotiation", async () => {
    const bucket = createClasspilotWsFrameBucket(1_000);
    for (let index = 0; index < CLASSPILOT_WS_FRAME_BUCKET_CAPACITY; index += 1) {
      assert.equal(consumeClasspilotWsFrame(bucket, 1_000), true);
    }
    assert.equal(consumeClasspilotWsFrame(bucket, 1_000), false);
    assert.equal(consumeClasspilotWsFrame(bucket, 1_100), true);
    assert.equal(CLASSPILOT_WS_MAX_PENDING_FRAMES, 8);

    const binding = {
      schoolId: "school-1",
      studentId: "student-1",
      studentSessionId: "student-session-1",
      deviceId: "device-1",
      teachingSessionId: "teaching-session-1",
      requesterUserId: "teacher-1",
    };
    const issued = createClasspilotLiveViewNegotiationId(binding, 10_000);
    assert.equal(CLASSPILOT_LIVE_VIEW_SETUP_TTL_MS, 90_000);
    assert.equal(CLASSPILOT_LIVE_VIEW_NEGOTIATION_TTL_MS, 15 * 60_000);
    assert.equal(issued.expiresAt, 10_000 + 15 * 60_000);
    assert.equal(verifyClasspilotLiveViewNegotiation(issued.negotiationId, binding, 10_001), true);
    assert.equal(verifyClasspilotLiveViewNegotiation(
      issued.negotiationId,
      { ...binding, requesterUserId: "observer-1" },
      10_001
    ), false);
    assert.deepEqual(classpilotLiveViewNegotiationAuthority(
      issued.negotiationId,
      {
        schoolId: binding.schoolId,
        studentId: binding.studentId,
        studentSessionId: binding.studentSessionId,
        deviceId: binding.deviceId,
      },
      10_001
    ), {
      teachingSessionId: binding.teachingSessionId,
      requesterUserId: binding.requesterUserId,
      expiresAt: issued.expiresAt,
    });
    assert.equal(verifyClasspilotLiveViewNegotiation(
      issued.negotiationId,
      { ...binding, deviceId: "replacement-device" },
      10_001
    ), false);
    assert.equal(verifyClasspilotLiveViewNegotiation(
      issued.negotiationId,
      binding,
      issued.expiresAt
    ), false);

    const websocket = await source("src/realtime/websocket.ts");
    assert.match(websocket, /let frameQueue: Promise<void> = Promise\.resolve\(\)/);
    assert.match(websocket, /pendingFrames >= CLASSPILOT_WS_MAX_PENDING_FRAMES/);
    assert.match(websocket, /frameQueue = frameQueue[\s\S]*\.then\(processFrame, processFrame\)/);
    assert.match(websocket, /"live-view-busy"/);
    assert.match(websocket, /LIVE_VIEW_BUSY/);
    assert.match(websocket, /verifyClasspilotLiveViewNegotiation/);
    assert.match(websocket, /negotiationId: negotiation\.negotiationId/);
    assert.match(websocket, /setupExpiresAt:/);
    assert.doesNotMatch(websocket, /reason: "negotiation-expired"/);
    const studentStop = websocket.slice(
      websocket.indexOf('if (message.type === "stop-share" && client.role === "student")'),
      websocket.indexOf("// --- Remote control: request-stream")
    );
    assert.match(studentStop, /classpilotLiveViewNegotiationAuthority/);
    assert.match(studentStop, /releaseClasspilotLiveViewNegotiation/);
    assert.match(studentStop, /kind: "staff-user"/);

    const claimed = await claimClasspilotLiveViewNegotiation(binding, 20_000);
    assert.equal(claimed.status, "claimed");
    if (claimed.status === "claimed") {
      assert.equal(await isClasspilotLiveViewNegotiationActive(
        {
          schoolId: binding.schoolId,
          studentId: binding.studentId,
          studentSessionId: binding.studentSessionId,
          deviceId: binding.deviceId,
        },
        claimed.negotiationId,
        20_001
      ), true);
      assert.equal(listActiveClasspilotLiveViewNegotiations({
        schoolId: binding.schoolId,
        teachingSessionId: binding.teachingSessionId,
        requesterUserId: binding.requesterUserId,
        now: 20_001,
      }).some((entry) => entry.negotiationId === claimed.negotiationId), true);
      await releaseClasspilotLiveViewNegotiation(
        { schoolId: binding.schoolId, studentId: binding.studentId },
        claimed.negotiationId
      );
      assert.equal(await isClasspilotLiveViewNegotiationActive(
        {
          schoolId: binding.schoolId,
          studentId: binding.studentId,
          studentSessionId: binding.studentSessionId,
          deviceId: binding.deviceId,
        },
        claimed.negotiationId,
        20_001
      ), false);
      assert.equal(listActiveClasspilotLiveViewNegotiations({
        negotiationIds: [claimed.negotiationId],
        now: 20_001,
      }).length, 0);
    }

    const lifecycle = await source("src/services/classpilotSessionLifecycle.ts");
    assert.match(lifecycle, /stopActiveClasspilotLiveViewNegotiations\([\s\S]*reason: "session-ended"/);
    assert.match(websocket, /stopOwnedLiveViews\("requester-disconnected"\)/);
    assert.match(websocket, /stopOwnedLiveViews\("requester-transport-error"\)/);
  });

  it("does not turn an admin Observe subscription into signaling authority", async () => {
    const websocket = await source("src/realtime/websocket.ts");
    const subscription = websocket.slice(
      websocket.indexOf("// --- Staff session subscriptions"),
      websocket.indexOf("// --- Student FAB chat delivery acknowledgements")
    );
    assert.match(subscription, /client\.role === "school_admin" \|\| client\.role === "super_admin"\) return true/);
    const resolver = websocket.slice(
      websocket.indexOf("const resolveLiveTarget = async"),
      websocket.indexOf("// --- WebRTC signaling")
    );
    assert.match(resolver, /isAuthorizedClasspilotSessionStaff\(/);
    assert.doesNotMatch(resolver, /client\.role === "school_admin"|client\.role === "super_admin"/);
  });

  it("routes student signaling only to immutable authorized session staff locally and across Redis", async () => {
    resetWsState();
    const teacherMessages: string[] = [];
    const observerMessages: string[] = [];
    const teacherSocket = {
      readyState: 1,
      send(value: string) { teacherMessages.push(value); },
    } as any;
    const observerSocket = {
      readyState: 1,
      send(value: string) { observerMessages.push(value); },
    } as any;
    try {
      registerWsClient(teacherSocket);
      authenticateWsClient(teacherSocket, {
        role: "teacher",
        schoolId: "school-1",
        userId: "teacher-1",
      });
      subscribeWsClientToSession(teacherSocket, "session-1");
      registerWsClient(observerSocket);
      authenticateWsClient(observerSocket, {
        role: "school_admin",
        schoolId: "school-1",
        userId: "observer-1",
      });
      subscribeWsClientToSession(observerSocket, "session-1");

      assert.equal(sendToStaffUserLocal(
        "school-1",
        "teacher-1",
        { type: "offer", from: "student-1" }
      ), 1);
      assert.equal(teacherMessages.length, 1);
      assert.equal(observerMessages.length, 0);

      const [websocket, redis] = await Promise.all([
        source("src/realtime/websocket.ts"),
        source("src/realtime/ws-redis.ts"),
      ]);
      const signalingStart = websocket.indexOf("// --- WebRTC signaling");
      const studentRelay = websocket.slice(
        websocket.indexOf('if (client.role === "student")', signalingStart),
        websocket.indexOf("const target = await resolveLiveTarget()")
      );
      assert.match(studentRelay, /classpilotLiveViewRequester/);
      assert.match(studentRelay, /isAuthorizedClasspilotSessionStaff/);
      assert.match(studentRelay, /sendToStaffUserLocal/);
      assert.match(studentRelay, /kind: "staff-user"/);
      assert.doesNotMatch(studentRelay, /broadcastToStaffSessionLocal/);
      assert.match(redis, /kind: "staff-user"; schoolId: string; userId: string/);
    } finally {
      resetWsState();
    }
  });
});

describe("ClassPilot canonical entitlement and FAB mutation safety", () => {
  it("denies every inactive-school form and never inspects super-admin status", async () => {
    const active = {
      status: "active",
      isActive: true,
      planStatus: "active",
      activeUntil: new Date("2026-08-20T12:00:00.000Z"),
      disabledAt: null,
      deletedAt: null,
    };
    const now = new Date("2026-08-19T12:00:00.000Z");
    assert.equal(isClasspilotSchoolActive({ ...active, isActive: false }, now), false);
    assert.equal(isClasspilotSchoolActive({ ...active, status: "inactive" }, now), false);
    assert.equal(isClasspilotSchoolActive({ ...active, disabledAt: now }, now), false);

    for (const reason of ["school_inactive", "license_inactive"] as const) {
      let status = 0;
      let body: any;
      let nextCalled = false;
      const middleware = createRequireClasspilotEntitlement(async (schoolId) => ({
        schoolId,
        entitled: false,
        reason,
      }));
      await middleware(
        { authUser: { isSuperAdmin: true } } as any,
        {
          locals: { schoolId: "school-1" },
          status(code: number) { status = code; return this; },
          json(value: unknown) { body = value; return this; },
        } as any,
        () => { nextCalled = true; }
      );
      assert.equal(status, 403);
      assert.equal(body.code, "CLASSPILOT_NOT_ENTITLED");
      assert.equal(body.reason, reason);
      assert.equal(nextCalled, false);
    }
  });

  it("rechecks entitlement inside scheduled occurrence/start locks and login pickup", async () => {
    const [scheduled, websocket, entitlement] = await Promise.all([
      source("src/services/classpilotScheduledStart.ts"),
      source("src/realtime/websocket.ts"),
      source("src/services/classpilotEntitlement.ts"),
    ]);
    const preparation = scheduled.slice(
      scheduled.indexOf("async function prepareScheduledOccurrence"),
      scheduled.indexOf("export function broadcastScheduledClassUpdate")
    );
    const lockedStart = scheduled.slice(
      scheduled.indexOf("async function startScheduledClassLocked"),
      scheduled.indexOf("export async function startScheduledClassFromConflict")
    );
    const pickup = websocket.slice(
      websocket.indexOf("const presenceRecorded = recordStaffPresence"),
      websocket.indexOf("// Every post-authentication message")
    );
    assert.match(preparation, /async \(lockedDb\) => \{[\s\S]*assertClasspilotEntitled\(options\.group\.schoolId, lockedDb, \{ lock: true \}\)/);
    assert.ok(
      lockedStart.indexOf("assertClasspilotEntitled(options.group.schoolId, dbInstance, { lock: true })")
        < lockedStart.indexOf("promoteScheduledReportSessionToLive"),
      "entitlement must be locked before occurrence promotion"
    );
    assert.match(scheduled, /startActiveScheduledClassesForTeacher[\s\S]*await assertClasspilotEntitled\(options\.schoolId\)/);
    assert.match(pickup, /assertClasspilotEntitled\(schoolId\)[\s\S]*startActiveScheduledClassesForTeacher/);
    assert.match(entitlement, /options\.lock[\s\S]*schoolQuery\.for\("share"\)/);
    assert.match(entitlement, /options\.lock[\s\S]*licenseQuery\.for\("share"\)/);
  });

  it("locks canonical entitlement inside command and FAB settings transactions", async () => {
    const storage = await source("src/services/storage.ts");
    const commandCreate = storage.slice(
      storage.indexOf("export async function createClasspilotCommandWithTargets"),
      storage.indexOf("export async function updateClasspilotCommandSummary")
    );
    const settings = storage.slice(
      storage.indexOf("export async function upsertSessionSettings"),
      storage.indexOf("// ============================================================================\n// ClassPilot - Scheduled class block helpers")
    );
    assert.match(commandCreate, /assertClasspilotEntitled\(authority\.schoolId, transactionDb, \{ lock: true \}\)/);
    assert.match(settings, /assertClasspilotEntitled\(schoolId, transactionDb, \{ lock: true \}\)/);
    assert.match(settings, /isAuthorizedClasspilotSessionStaff\([\s\S]*options\.actorId[\s\S]*transactionDb/);
  });

  it("binds student and teacher FAB writes plus poll responses inside authority transactions", async () => {
    const [storage, chat] = await Promise.all([
      source("src/services/storage.ts"),
      source("src/routes/classpilot/chat.ts"),
    ]);
    const studentFab = storage.slice(
      storage.indexOf("async function withAuthorizedStudentFabMutation"),
      storage.indexOf("type AuthorizedClasspilotTeacherStudentAction")
    );
    assert.match(studentFab, /assertClasspilotEntitled\(options\.schoolId, transactionDb, \{ lock: true \}\)/);
    assert.match(studentFab, /lockClasspilotStudentControlAuthorities/);
    assert.match(studentFab, /hasExactClasspilotTelemetryBinding/);
    assert.match(studentFab, /getActiveSupervisionForStudents/);
    assert.match(studentFab, /getActiveClassOwnerForStudent/);
    assert.match(chat, /raiseAuthorizedClasspilotStudentHand\(\{[\s\S]*studentSessionId/);
    assert.match(chat, /lowerAuthorizedClasspilotStudentHand\(\{[\s\S]*studentSessionId/);
    assert.match(chat, /createAuthorizedClasspilotStudentMessage\(\{[\s\S]*studentSessionId[\s\S]*teachingSessionId/);
    const studentMessageWrite = storage.slice(
      storage.indexOf("export async function createAuthorizedClasspilotStudentMessage"),
      storage.indexOf("export async function raiseAuthorizedClasspilotStudentHand")
    );
    assert.match(studentMessageWrite, /isCurrentClasspilotStudentMessageSession/);
    assert.match(studentMessageWrite, /student_message_session_superseded/);
    assert.ok(
      studentMessageWrite.indexOf("student_message_session_superseded")
        < studentMessageWrite.indexOf("transactionDb.insert(chatMessages)")
    );

    const teacherFab = storage.slice(
      storage.indexOf("async function withAuthorizedClasspilotTeacherStudentAction"),
      storage.indexOf("export async function getChatMessages")
    );
    assert.match(teacherFab, /assertClasspilotEntitled\(options\.schoolId, transactionDb, \{ lock: true \}\)/);
    assert.match(teacherFab, /classpilotSessionStaff[\s\S]*\.for\("share"\)/);
    assert.match(teacherFab, /getActiveSupervisionForStudents/);
    assert.match(teacherFab, /classpilotStudentControlStates/);
    assert.match(teacherFab, /studentSessions[\s\S]*\.for\("share"\)/);
    assert.match(chat, /deleteAuthorizedClasspilotChatMessage/);
    assert.match(chat, /dismissAuthorizedClasspilotStudentHand/);
    assert.match(chat, /authorizeClasspilotTeacherCloseChat/);

    const poll = storage.slice(
      storage.indexOf("export async function createPollResponseFirstWrite"),
      storage.indexOf("// ClassPilot - Teacher command operations")
    );
    assert.match(poll, /assertClasspilotEntitled\(options\.schoolId, transactionDb, \{ lock: true \}\)/);
    assert.match(poll, /lockClasspilotStudentControlAuthorities/);
    assert.match(poll, /classpilotCommandTargets[\s\S]*\.for\("share"\)/);
    assert.match(poll, /studentSessions[\s\S]*\.for\("share"\)/);
    assert.match(poll, /code: "POLL_AUTHORITY_STALE"/);
  });

  it("keeps durable heartbeat teacher messages retryable until completed ACK", async () => {
    const [storage, devices] = await Promise.all([
      source("src/services/storage.ts"),
      source("src/routes/classpilot/devices.ts"),
    ]);
    const inbox = storage.slice(
      storage.indexOf("export async function getPendingMessagesForStudent"),
      storage.indexOf("// ClassPilot - Check-ins")
    );
    assert.match(inbox, /inbox_target\.status IN \('unavailable', 'requested', 'sent', 'received'\)/);
    assert.match(inbox, /inbox_command\.expires_at IS NULL OR inbox_command\.expires_at > now\(\)/);
    assert.match(inbox, /durableAuthorityRevision[\s\S]*controlState\?\.revision/);
    assert.match(inbox, /hasCurrentClasspilotStudentControlAuthority/);
    assert.doesNotMatch(inbox, /inbox_target\.status IN \([^)]*'failed'/);
    const heartbeat = devices.slice(
      devices.indexOf("let pendingMessages:"),
      devices.indexOf("const teacherReplyCheckKey")
    );
    assert.match(heartbeat, /deliveryState\.hasUnacknowledgedCommandMessages/);
    assert.match(heartbeat, /recent\.some\([\s\S]*message\.commandId/);
    assert.match(heartbeat, /filter\(\(message\) => !message\.commandId\)/);
    assert.doesNotMatch(heartbeat, /pendingMessages\.map\(\(message\) => message\.id\)/);

    const ack = storage.slice(
      storage.indexOf("export async function persistClasspilotCommandTargetAck"),
      storage.indexOf("export async function updateClasspilotCommandTargetAck")
    );
    assert.match(ack, /binding\.commandType === "teacher-message"/);
    assert.match(ack, /authorityCurrent[\s\S]*options\.ackState === "failed"/);
    assert.match(ack, /Student inbox persistence failed; delivery will retry/);
    assert.match(ack, /ownershipRevision: durableAuthorityRevision/);
  });

  it("clears and filters raised hands at classroom ownership transitions", async () => {
    const [storage, fab] = await Promise.all([
      source("src/services/storage.ts"),
      source("src/services/classpilotFab.ts"),
    ]);
    const teachingTransition = storage.slice(
      storage.indexOf("export async function replaceClasspilotStudentControlSnapshots"),
      storage.indexOf("export async function replaceClasspilotSupervisionControlSnapshots")
    );
    assert.match(teachingTransition, /update\(classpilotActiveHands\)[\s\S]*ne\(classpilotActiveHands\.teachingSessionId, options\.teachingSessionId\)/);
    const supervisionTransition = storage.slice(
      storage.indexOf("export async function replaceClasspilotSupervisionControlSnapshots"),
      storage.indexOf("export async function clearClasspilotStudentControlStatesForSession")
    );
    assert.match(supervisionTransition, /update\(classpilotActiveHands\)[\s\S]*inArray\(classpilotActiveHands\.studentId, studentIds\)/);
    const handReads = storage.slice(
      storage.indexOf("export async function getActiveHandsBySession"),
      storage.indexOf("export async function upsertClasspilotActiveHand")
    );
    assert.match(handReads, /innerJoin\([\s\S]*classpilotStudentControlStates/);
    assert.match(fab, /authoritativeSessionIds[\s\S]*filter\(\(hand\) => authoritativeSessionIds\.has/);
  });

  it("wires the canonical gate across all staff and device mutation routers", async () => {
    const routeFiles = [
      "adminClasses", "chat", "commands", "competitive", "coverage", "dashboard",
      "devices", "flightPaths", "groups", "instructionalCalendar", "monitoring",
      "monitoringEvents", "scheduleChanges", "scheduledConflicts", "sessions",
    ];
    for (const file of routeFiles) {
      assert.match(
        await source(`src/routes/classpilot/${file}.ts`),
        /requireClasspilotEntitlement/,
        `${file} must use the canonical ClassPilot entitlement gate`
      );
    }
    const devices = await source("src/routes/classpilot/devices.ts");
    for (const route of ["command-acks", "heartbeat", "screenshot", "event", "runtime-error"]) {
      const line = devices.split("\n").find((entry) => entry.includes(`/${route}`) && entry.includes("router."));
      assert.match(line || "", /requireClasspilotEntitlement/);
    }
    const monitoringEvents = await source("src/routes/classpilot/monitoringEvents.ts");
    assert.match(
      monitoringEvents,
      /router\.post\("\/device\/events", requireDeviceAuth, requireClasspilotEntitlement, deviceEventLimiter/
    );
  });

  it("revalidates uncached entitlement before every student token/session issuance path", async () => {
    const devices = await source("src/routes/classpilot/devices.ts");
    const login = devices.slice(
      devices.indexOf('router.post("/extension/student-login"'),
      devices.indexOf('router.post("/extension/sign-out"')
    );
    assert.equal(
      login.match(/requireUncachedClasspilotEntitlementForIssuance\(res, [^)]+\)/g)?.length,
      2,
      "email/ID and PIN login branches must both revalidate entitlement"
    );
    assert.equal(
      devices.match(/requireUncachedClasspilotEntitlementForIssuance\(res, resolvedSchoolId\)/g)?.length,
      3,
      "generic, extension, and legacy registration must all revalidate entitlement"
    );
    const issuance = devices.slice(
      devices.indexOf("async function completeStudentDeviceLogin"),
      devices.indexOf("// School Status Endpoints")
    );
    assert.ok(
      issuance.indexOf("resolveClasspilotEntitlement(options.schoolId)")
        < issuance.indexOf("issueStudentDeviceSessionToken({"),
      "the final entitlement check must precede session/token issuance"
    );
    const publicStatus = devices.slice(
      devices.indexOf('router.post("/school/status"'),
      devices.indexOf('router.get("/school/status"')
    );
    assert.match(publicStatus, /resolveClasspilotEntitlement\(result\.school\.id\)/);
    assert.match(publicStatus, /schoolActive: entitlement\.entitled/);
  });

  it("establishes one school-scoped exact public student binding on every auth and recovery response", async () => {
    const [devices, websocket] = await Promise.all([
      source("src/routes/classpilot/devices.ts"),
      source("src/realtime/websocket.ts"),
    ]);
    const login = devices.slice(
      devices.indexOf("async function completeStudentDeviceLogin"),
      devices.indexOf("async function recordRemoteActionTimeline")
    );
    assert.match(login, /schoolId: options\.schoolId/);
    assert.match(login, /const student = options\.student/);
    assert.match(login, /studentId: student\.id/);
    assert.match(login, /studentSessionId: session\.id/);
    assert.match(
      login,
      /exactBinding: classpilotControlStateExactBinding\(\{[\s\S]*?schoolId: options\.schoolId,[\s\S]*?deviceId: options\.deviceId,[\s\S]*?studentId: student\.id,[\s\S]*?studentSessionId: session\.id,[\s\S]*?controlRevision:/
    );
    const legacy = devices.slice(
      devices.indexOf('router.post("/register-student"'),
      devices.indexOf("// Popup Endpoints")
    );
    assert.match(legacy, /schoolId: login\.schoolId/);
    assert.match(legacy, /studentId: login\.studentId/);
    assert.match(legacy, /studentSessionId: login\.studentSessionId/);
    const heartbeat = devices.slice(
      devices.indexOf('router.post("/device/heartbeat"'),
      devices.indexOf('router.post("/device/screenshot"')
    );
    assert.match(heartbeat, /return res\.json\(\{[\s\S]*?ok: true,[\s\S]*?schoolId,/);
    assert.match(
      heartbeat,
      /exactBinding: classpilotControlStateExactBinding\(\{[\s\S]*?schoolId,[\s\S]*?deviceId,[\s\S]*?studentId,[\s\S]*?studentSessionId,[\s\S]*?controlRevision:/
    );
    const settings = devices.slice(
      devices.indexOf('router.get("/extension/settings"'),
      devices.indexOf("// Device & Student Registration")
    );
    assert.match(settings, /return res\.json\(\{[\s\S]*?schoolId,[\s\S]*?exactBinding:/);
    assert.match(settings, /exactBinding:/);
    assert.match(settings, /exactBinding: classpilotControlStateExactBinding\(\{[\s\S]*?schoolId,[\s\S]*?deviceId,[\s\S]*?controlRevision:/);
    const authSuccess = websocket.slice(
      websocket.indexOf('type: "auth-success"'),
      websocket.indexOf("for (const { message: teacherMessage }")
    );
    assert.match(authSuccess, /type: "auth-success",[\s\S]*?role: "student",[\s\S]*?schoolId,/);
    assert.match(authSuccess, /studentId: payload\.studentId/);
    assert.match(authSuccess, /studentSessionId: bootstrap\.studentSessionId/);
    assert.match(authSuccess, /exactBinding:/);
    assert.match(authSuccess, /exactBinding: classpilotControlStateExactBinding\(\{[\s\S]*?schoolId,[\s\S]*?deviceId,[\s\S]*?controlRevision:/);
    const classroomStateRecovery = websocket.slice(
      websocket.indexOf('message.type === "classroom-state-request"'),
      websocket.indexOf('message.type === "command-ack"')
    );
    assert.match(classroomStateRecovery, /type: "classroom-state-sync"/);
    assert.match(classroomStateRecovery, /studentId: client\.studentId/);
    assert.match(classroomStateRecovery, /studentSessionId: client\.studentSessionId/);
    assert.match(
      classroomStateRecovery,
      /classpilotClassroomStatePushFrame\(\{[\s\S]*?binding: \{[\s\S]*?schoolId:[\s\S]*?deviceId:[\s\S]*?controlRevision:/
    );
  });

  it("bounds FAB messages and uses one-statement conflict-safe hand raising", async () => {
    const [chat, storage] = await Promise.all([
      source("src/routes/classpilot/chat.ts"),
      source("src/services/storage.ts"),
    ]);
    assert.equal(chat.match(/code: "MESSAGE_TOO_LONG"/g)?.length, 2);
    const upsert = storage.slice(
      storage.indexOf("export async function upsertClasspilotActiveHand"),
      storage.indexOf("export async function clearClasspilotActiveHand")
    );
    assert.match(upsert, /\.insert\(classpilotActiveHands\)/);
    assert.match(upsert, /\.onConflictDoUpdate\(\{/);
    assert.match(upsert, /targetWhere: sql`\$\{classpilotActiveHands\.clearedAt\} IS NULL`/);
    assert.doesNotMatch(upsert, /\.select\(|if \(existing\)/);
  });

  it("preserves retained FAB and poll history when a device is deleted", async () => {
    const storage = await source("src/services/storage.ts");
    const deletion = storage.slice(
      storage.indexOf("export async function deleteDevice"),
      storage.indexOf("// ============================================================================\n// ClassPilot - Student Device operations")
    );
    assert.match(deletion, /\.update\(classpilotActiveHands\)[\s\S]*clearedAt: now/);
    assert.match(deletion, /\.update\(pollResponses\)[\s\S]*deviceId: null/);
    assert.ok(
      deletion.indexOf(".update(pollResponses)") < deletion.indexOf(".delete(devices)"),
      "retained provenance must be detached before the device parent is deleted"
    );
  });

  it("loads teacher-owned Flight Paths and block lists for command dispatch", async () => {
    const [dispatcher, storage] = await Promise.all([
      source("src/services/classpilotCommandDispatcher.ts"),
      source("src/services/storage.ts"),
    ]);
    assert.match(dispatcher, /getFlightPathById\(flightPathId, schoolId, teacherId\)/);
    assert.match(dispatcher, /getBlockListById\(blockListId, schoolId, teacherId\)/);
    assert.match(storage, /if \(teacherId\) conditions\.push\(eq\(flightPaths\.teacherId, teacherId\)\)/);
    assert.match(storage, /if \(teacherId\) conditions\.push\(eq\(blockLists\.teacherId, teacherId\)\)/);
    assert.match(dispatcher, /code: "FLIGHT_PATH_EMPTY"/);
  });

  it("persists authoritative poll lifecycle expiry into every delivered start payload", async () => {
    const [dispatcher, storage] = await Promise.all([
      source("src/services/classpilotCommandDispatcher.ts"),
      source("src/services/storage.ts"),
    ]);
    assert.match(storage, /pollExpiresAt: pollExpiryIso,[\s\S]*expiresAt: pollExpiryIso/);
    assert.match(dispatcher, /const committedCommandPayload = created\.commandPayload/);
    assert.match(dispatcher, /classpilotCommandFrameForTarget[\s\S]*\.\.\.committedCommandPayload/);
  });
});
