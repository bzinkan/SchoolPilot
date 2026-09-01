import test from "node:test";
import assert from "node:assert/strict";
import {
  CLASSPILOT_SERVER_PROTOCOL_VERSION,
  classpilotCapabilityRolloutMode,
  isClasspilotCapabilityActive,
  negotiateClasspilotProtocol,
} from "../src/services/classpilotProtocol.js";
import {
  classpilotObservationStatus,
  releaseClasspilotObservationLease,
  releaseClasspilotObservationLeaseWithState,
  renewClasspilotObservationLease,
  resetClasspilotObservationLeasesForTests,
} from "../src/services/classpilotObservationLease.js";

const REPAIRED_CLIENT_DEPENDENT_CAPABILITIES = [
  "authBoundTelemetryV1",
  "exactBindingAckV2",
  "exactTabCloseV2",
  "studentChatIdempotencyV1",
  "screenshotObservationLeaseV1",
  "screenshotTrackingWindowLeaseV1",
  "screenshotActiveObservationCadenceV1",
  "safetyEvidenceCaptureV1",
  "liveViewIceServersV1",
  "kioskLaunchTicketV2",
  "studentAuthGatePresenceV1",
  "lateSignInRestrictionSsoV1",
  "restrictionAuthPassThroughV1",
] as const;

test("protocol v3 activates only the advertised and server-enabled intersection", () => {
  const negotiated = negotiateClasspilotProtocol({
    clientProtocolVersion: 3,
    advertisedCapabilities: [
      "scopedAuthorityChecksV1",
      "exactBindingAckV2",
      "screenshotObservationLeaseV1",
      "unknownCapability",
    ],
    env: {
      CLASSPILOT_PROTOCOL_V3_ENABLED: "true",
      CLASSPILOT_CAP_SCOPED_AUTHORITY_CHECKS_V1: "true",
      CLASSPILOT_CAP_EXACT_BINDING_ACK_V2: "true",
      CLASSPILOT_CAP_SCREENSHOT_OBSERVATION_LEASE_V1: "false",
    },
  });
  assert.equal(negotiated.serverProtocolVersion, CLASSPILOT_SERVER_PROTOCOL_VERSION);
  assert.deepEqual(negotiated.acceptedCapabilities, [
    "scopedAuthorityChecksV1",
    "exactBindingAckV2",
  ]);
});

test("all scoped-authority-dependent capabilities require the repaired scoping marker", () => {
  const env: NodeJS.ProcessEnv = {
    CLASSPILOT_PROTOCOL_V3_ENABLED: "true",
    CLASSPILOT_CAP_SCOPED_AUTHORITY_CHECKS_V1: "true",
    CLASSPILOT_CAP_AUTH_BOUND_TELEMETRY_V1: "true",
    CLASSPILOT_CAP_EXACT_BINDING_ACK_V2: "true",
    CLASSPILOT_CAP_EXACT_TAB_CLOSE_V2: "true",
    CLASSPILOT_CAP_STUDENT_CHAT_IDEMPOTENCY_V1: "true",
    CLASSPILOT_CAP_SCREENSHOT_OBSERVATION_LEASE_V1: "true",
    CLASSPILOT_CAP_SCREENSHOT_TRACKING_WINDOW_LEASE_V1: "true",
    CLASSPILOT_CAP_SCREENSHOT_ACTIVE_OBSERVATION_CADENCE_V1: "true",
    CLASSPILOT_CAP_SAFETY_EVIDENCE_CAPTURE_V1: "true",
    CLASSPILOT_CAP_LIVE_VIEW_ICE_SERVERS_V1: "true",
    CLASSPILOT_CAP_KIOSK_LAUNCH_TICKET_V2: "true",
    CLASSPILOT_CAP_STUDENT_AUTH_GATE_PRESENCE_V1: "true",
    CLASSPILOT_CAP_LATE_SIGNIN_RESTRICTION_SSO_V1: "true",
    CLASSPILOT_CAP_RESTRICTION_AUTH_PASS_THROUGH_V1: "true",
  };
  assert.deepEqual(negotiateClasspilotProtocol({
    clientProtocolVersion: 3,
    advertisedCapabilities: [...REPAIRED_CLIENT_DEPENDENT_CAPABILITIES],
    env,
  }).acceptedCapabilities, []);
  assert.deepEqual(negotiateClasspilotProtocol({
    clientProtocolVersion: 3,
    advertisedCapabilities: [
      "scopedAuthorityChecksV1",
      ...REPAIRED_CLIENT_DEPENDENT_CAPABILITIES,
    ],
    env,
  }).acceptedCapabilities, [
    "scopedAuthorityChecksV1",
    ...REPAIRED_CLIENT_DEPENDENT_CAPABILITIES,
  ]);
});

test("active screenshot cadence requires the negotiated tracking-window lease", () => {
  const base = {
    CLASSPILOT_PROTOCOL_V3_ENABLED: "true",
    CLASSPILOT_CAP_SCOPED_AUTHORITY_CHECKS_V1: "true",
    CLASSPILOT_CAP_SCREENSHOT_TRACKING_WINDOW_LEASE_V1: "true",
    CLASSPILOT_CAP_SCREENSHOT_ACTIVE_OBSERVATION_CADENCE_V1: "true",
  };
  assert.deepEqual(negotiateClasspilotProtocol({
    clientProtocolVersion: 3,
    advertisedCapabilities: [
      "scopedAuthorityChecksV1",
      "screenshotActiveObservationCadenceV1",
    ],
    env: base,
  }).acceptedCapabilities, ["scopedAuthorityChecksV1"]);
  assert.deepEqual(negotiateClasspilotProtocol({
    clientProtocolVersion: 3,
    advertisedCapabilities: [
      "scopedAuthorityChecksV1",
      "screenshotTrackingWindowLeaseV1",
      "screenshotActiveObservationCadenceV1",
    ],
    env: base,
  }).acceptedCapabilities, [
    "scopedAuthorityChecksV1",
    "screenshotTrackingWindowLeaseV1",
    "screenshotActiveObservationCadenceV1",
  ]);
});

test("kiosk launch ticket V1 remains independent of the repaired scoping marker", () => {
  const negotiated = negotiateClasspilotProtocol({
    clientProtocolVersion: 3,
    advertisedCapabilities: ["kioskLaunchTicketV1"],
    env: {
      CLASSPILOT_PROTOCOL_V3_ENABLED: "true",
      CLASSPILOT_CAP_KIOSK_LAUNCH_TICKET_V1: "true",
    },
  });
  assert.deepEqual(negotiated.acceptedCapabilities, ["kioskLaunchTicketV1"]);
});

test("protocol v2 and version-only clients retain legacy behavior", () => {
  const env = {
    CLASSPILOT_PROTOCOL_V3_ENABLED: "true",
    CLASSPILOT_CAP_EXACT_BINDING_ACK_V2: "true",
  };
  assert.deepEqual(negotiateClasspilotProtocol({
    clientProtocolVersion: 2,
    advertisedCapabilities: ["exactBindingAckV2"],
    env,
  }).acceptedCapabilities, []);
  assert.deepEqual(negotiateClasspilotProtocol({
    clientProtocolVersion: 3,
    advertisedCapabilities: [],
    env,
  }).acceptedCapabilities, []);
});

test("capability rollout modes are school-scoped and fail closed", () => {
  const baseEnv: NodeJS.ProcessEnv = {
    CLASSPILOT_PROTOCOL_V3_ENABLED: "true",
    CLASSPILOT_CAP_SCOPED_AUTHORITY_CHECKS_V1: "true",
    CLASSPILOT_CAP_SCREENSHOT_OBSERVATION_LEASE_V1: "true",
  };
  const advertisedCapabilities = [
    "scopedAuthorityChecksV1",
    "screenshotObservationLeaseV1",
  ];
  const negotiate = (schoolId: string, rollout: unknown) => negotiateClasspilotProtocol({
    clientProtocolVersion: 3,
    advertisedCapabilities,
    scope: {
      serverOrigin: "https://api.example.test",
      schoolId,
      deviceId: "device",
      studentId: "student",
      studentSessionId: "student-session",
    },
    env: {
      ...baseEnv,
      CLASSPILOT_CAPABILITY_ROLLOUTS_JSON: typeof rollout === "string"
        ? rollout
        : JSON.stringify(rollout),
    },
  }).acceptedCapabilities;

  assert.deepEqual(negotiate("school-a", {
    scopedAuthorityChecksV1: { mode: "on", schoolIds: ["school-a"] },
    screenshotObservationLeaseV1: { mode: "observe", schoolIds: ["school-a"] },
  }), ["scopedAuthorityChecksV1"]);
  assert.deepEqual(negotiate("school-a", {
    scopedAuthorityChecksV1: { mode: "on", schoolIds: ["school-a"] },
    screenshotObservationLeaseV1: { mode: "on", schoolIds: ["school-a"] },
  }), advertisedCapabilities);
  assert.deepEqual(negotiate("school-b", {
    scopedAuthorityChecksV1: { mode: "on", schoolIds: ["school-a"] },
    screenshotObservationLeaseV1: { mode: "on", schoolIds: ["school-a"] },
  }), []);
  assert.deepEqual(negotiate("school-a", "{not-json"), []);
});

test("late-sign-in delivery requires the repaired marker and one exact enabled school", () => {
  const negotiate = (schoolId: string, rollout: unknown) => negotiateClasspilotProtocol({
    clientProtocolVersion: 3,
    advertisedCapabilities: [
      "scopedAuthorityChecksV1",
      "lateSignInRestrictionSsoV1",
    ],
    scope: {
      serverOrigin: "https://api.example.test",
      schoolId,
      deviceId: "device",
      studentId: "student",
      studentSessionId: "student-session",
    },
    env: {
      CLASSPILOT_PROTOCOL_V3_ENABLED: "true",
      CLASSPILOT_CAP_SCOPED_AUTHORITY_CHECKS_V1: "true",
      CLASSPILOT_CAP_LATE_SIGNIN_RESTRICTION_SSO_V1: "true",
      CLASSPILOT_CAPABILITY_ROLLOUTS_JSON: JSON.stringify(rollout),
    },
  }).acceptedCapabilities;

  const rollout = {
    scopedAuthorityChecksV1: { mode: "on", schoolIds: ["school-a"] },
    lateSignInRestrictionSsoV1: { mode: "on", schoolIds: ["school-a"] },
  };
  assert.deepEqual(negotiate("school-a", rollout), [
    "scopedAuthorityChecksV1",
    "lateSignInRestrictionSsoV1",
  ]);
  assert.deepEqual(negotiate("school-b", rollout), []);
  assert.deepEqual(negotiate("school-a", {
    ...rollout,
    lateSignInRestrictionSsoV1: { mode: "off" },
  }), ["scopedAuthorityChecksV1"]);

  assert.deepEqual(negotiateClasspilotProtocol({
    clientProtocolVersion: 3,
    advertisedCapabilities: ["lateSignInRestrictionSsoV1"],
    scope: { schoolId: "school-a" },
    env: {
      CLASSPILOT_PROTOCOL_V3_ENABLED: "true",
      CLASSPILOT_CAP_LATE_SIGNIN_RESTRICTION_SSO_V1: "true",
      CLASSPILOT_CAPABILITY_ROLLOUTS_JSON: JSON.stringify({
        lateSignInRestrictionSsoV1: { mode: "on", schoolIds: ["school-a"] },
      }),
    },
  }).acceptedCapabilities, []);
});

test("restriction auth pass-through requires raw advertisement plus exact-school acceptance", () => {
  const negotiate = (schoolId: string, advertised: string[]) =>
    negotiateClasspilotProtocol({
      clientProtocolVersion: 3,
      advertisedCapabilities: advertised,
      scope: {
        schoolId,
        studentId: "student",
        studentSessionId: "session",
        deviceId: "device",
      },
      env: {
        CLASSPILOT_PROTOCOL_V3_ENABLED: "true",
        CLASSPILOT_CAP_SCOPED_AUTHORITY_CHECKS_V1: "true",
        CLASSPILOT_CAP_RESTRICTION_AUTH_PASS_THROUGH_V1: "true",
        CLASSPILOT_CAPABILITY_ROLLOUTS_JSON: JSON.stringify({
          scopedAuthorityChecksV1: { mode: "on", schoolIds: ["school-a"] },
          restrictionAuthPassThroughV1: { mode: "on", schoolIds: ["school-a"] },
        }),
      },
    }).acceptedCapabilities;

  assert.deepEqual(negotiate("school-a", [
    "scopedAuthorityChecksV1",
    "restrictionAuthPassThroughV1",
  ]), [
    "scopedAuthorityChecksV1",
    "restrictionAuthPassThroughV1",
  ]);
  assert.deepEqual(negotiate("school-a", ["scopedAuthorityChecksV1"]), [
    "scopedAuthorityChecksV1",
  ], "server enablement never fabricates a raw client capability");
  assert.deepEqual(negotiate("school-b", [
    "scopedAuthorityChecksV1",
    "restrictionAuthPassThroughV1",
  ]), [], "a raw capability outside the exact rollout remains unaccepted");
});

test("canary activation is deterministic for the whole school", () => {
  const env: NodeJS.ProcessEnv = {
    CLASSPILOT_PROTOCOL_V3_ENABLED: "true",
    CLASSPILOT_CAP_LIVE_VIEW_ICE_SERVERS_V1: "true",
    CLASSPILOT_CAPABILITY_ROLLOUTS_JSON: JSON.stringify({
      liveViewIceServersV1: { mode: "canary", canaryPercent: 100 },
    }),
  };
  assert.equal(classpilotCapabilityRolloutMode("liveViewIceServersV1", env), "canary");
  assert.equal(isClasspilotCapabilityActive(
    "liveViewIceServersV1",
    { schoolId: "school-a", deviceId: "device-a", studentId: "student-a" },
    env
  ), true);
  assert.equal(isClasspilotCapabilityActive(
    "liveViewIceServersV1",
    { schoolId: "school-a", deviceId: "device-b", studentId: "student-b" },
    env
  ), true);
  assert.equal(isClasspilotCapabilityActive("liveViewIceServersV1", {}, env), false);
});

test("observation leases keep class and explicit student scopes fail closed", async () => {
  const previousRedis = process.env.REDIS_URL;
  delete process.env.REDIS_URL;
  resetClasspilotObservationLeasesForTests();
  try {
    const firstLease = await renewClasspilotObservationLease({
      schoolId: "school",
      teachingSessionId: "session",
      viewerUserId: "teacher",
      viewerInstanceId: "viewer-a",
      scope: { kind: "students", studentIds: ["student-a"] },
      now: 1_000,
    });
    assert.equal(firstLease.created, true);
    assert.equal(firstLease.changed, true);
    assert.equal(firstLease.activated, true);
    const renewedLease = await renewClasspilotObservationLease({
      schoolId: "school",
      teachingSessionId: "session",
      viewerUserId: "teacher",
      viewerInstanceId: "viewer-a",
      scope: { kind: "students", studentIds: ["student-a"] },
      now: 2_000,
    });
    assert.equal(renewedLease.created, false);
    assert.equal(renewedLease.changed, false);
    assert.equal(renewedLease.activated, false);
    assert.deepEqual(await classpilotObservationStatus({
      schoolId: "school",
      teachingSessionId: "session",
      studentId: "student-a",
      now: 2_000,
    }), { status: "observed", expiresInSeconds: 90 });
    assert.deepEqual(await classpilotObservationStatus({
      schoolId: "school",
      teachingSessionId: "session",
      studentId: "student-b",
      now: 2_000,
    }), { status: "unobserved", expiresInSeconds: 0 });
    const changedLease = await renewClasspilotObservationLease({
      schoolId: "school",
      teachingSessionId: "session",
      viewerUserId: "teacher",
      viewerInstanceId: "viewer-a",
      scope: { kind: "class" },
      now: 3_000,
    });
    assert.equal(changedLease.created, false);
    assert.equal(changedLease.changed, true);
    assert.equal(changedLease.activated, false);

    assert.equal(await releaseClasspilotObservationLease({
      schoolId: "school",
      teachingSessionId: "session",
      viewerUserId: "teacher",
      viewerInstanceId: "viewer-a",
      now: 3_000,
    }), true);
    assert.equal(await releaseClasspilotObservationLease({
      schoolId: "school",
      teachingSessionId: "session",
      viewerUserId: "teacher",
      viewerInstanceId: "viewer-a",
      now: 3_000,
    }), false);
    assert.equal((await classpilotObservationStatus({
      schoolId: "school",
      teachingSessionId: "session",
      studentId: "student-a",
      now: 2_000,
    })).status, "unobserved");

    await renewClasspilotObservationLease({
      schoolId: "school",
      teachingSessionId: "session",
      viewerUserId: "teacher",
      viewerInstanceId: "viewer-expired",
      scope: { kind: "class" },
      now: 10_000,
    });
    const replacedExpiredLease = await renewClasspilotObservationLease({
      schoolId: "school",
      teachingSessionId: "session",
      viewerUserId: "teacher",
      viewerInstanceId: "viewer-expired",
      scope: { kind: "class" },
      now: 100_000,
    });
    assert.equal(replacedExpiredLease.created, true);
    assert.equal(replacedExpiredLease.changed, true);
    assert.equal(replacedExpiredLease.activated, true);

    await renewClasspilotObservationLease({
      schoolId: "school",
      teachingSessionId: "session-multi",
      viewerUserId: "teacher-a",
      viewerInstanceId: "viewer-multi-a",
      scope: { kind: "class" },
      now: 200_000,
    });
    const secondViewer = await renewClasspilotObservationLease({
      schoolId: "school",
      teachingSessionId: "session-multi",
      viewerUserId: "teacher-b",
      viewerInstanceId: "viewer-multi-b",
      scope: { kind: "class" },
      now: 200_000,
    });
    assert.equal(secondViewer.activated, false);
    assert.deepEqual(await releaseClasspilotObservationLeaseWithState({
      schoolId: "school",
      teachingSessionId: "session-multi",
      viewerUserId: "teacher-a",
      viewerInstanceId: "viewer-multi-a",
      now: 200_001,
    }), { released: true, deactivated: false });
    assert.deepEqual(await releaseClasspilotObservationLeaseWithState({
      schoolId: "school",
      teachingSessionId: "session-multi",
      viewerUserId: "teacher-b",
      viewerInstanceId: "viewer-multi-b",
      now: 200_001,
    }), { released: true, deactivated: true });
  } finally {
    if (previousRedis === undefined) delete process.env.REDIS_URL;
    else process.env.REDIS_URL = previousRedis;
    resetClasspilotObservationLeasesForTests();
  }
});
