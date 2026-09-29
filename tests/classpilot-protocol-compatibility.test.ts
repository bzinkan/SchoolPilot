import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  CLASSPILOT_PROTOCOL_V3_CAPABILITIES,
  CLASSPILOT_SERVER_PROTOCOL_VERSION,
  negotiateClasspilotProtocol,
  negotiateClasspilotSurfaceProtocol,
  type ClasspilotProtocolSurface,
} from "../src/services/classpilotProtocol.js";
import { serializeClasspilotStudentControlStateForDelivery } from "../src/services/classpilotClassroomState.js";
import type { ClasspilotStudentControlState } from "../src/schema/classpilot.js";

type ProtocolBody = {
  clientProtocolVersion: number;
  extensionVersion: string;
  capabilities: string[];
};

type ArchivedFixture = {
  fixtureSchemaVersion: number;
  release: {
    version: string;
    sourceCommit: string;
    sourceRepository: string;
    sourceFiles: string[];
  };
  requests: {
    registration: { path: string; body: ProtocolBody };
    heartbeat: { path: string; body: ProtocolBody };
    websocketAuth: { path: string; body: ProtocolBody };
  };
};

const LEGACY_V2_CAPABILITIES = [
  "classroomStateV1",
  "fabStateRevisionV1",
  "exactTabCloseV1",
  "screenOnlyUnlockV1",
  "durableChatAckV1",
  "commandAckReceiptV1",
  "classroomOverlayRestoreV1",
  "liveViewNegotiationV1",
] as const;

const archivedFixtureDefinitions = [
  {
    file: "classpilot-2.6.1.json",
    version: "2.6.1",
    sourceCommit: "6564deb946d9df90f3ce42e6be6f7ea472f7576c",
  },
  {
    file: "classpilot-2.6.9.json",
    version: "2.6.9",
    sourceCommit: "bd2cb1d2cc5ae483318ff92ed91585a63116f5b1",
  },
] as const;

function readArchivedFixture(file: string): ArchivedFixture {
  return JSON.parse(readFileSync(
    new URL(`./fixtures/classpilot-compatibility/${file}`, import.meta.url),
    "utf8"
  )) as ArchivedFixture;
}

function allV3CapabilitiesEnabled(): NodeJS.ProcessEnv {
  return {
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
    CLASSPILOT_CAP_KIOSK_LAUNCH_TICKET_V1: "true",
    CLASSPILOT_CAP_KIOSK_LAUNCH_TICKET_V2: "true",
    CLASSPILOT_CAP_STUDENT_AUTH_GATE_PRESENCE_V1: "true",
  };
}

// ClassPilot 2.9.6 is the published protocol-v3 line (tag v2.9.6). Its
// EXTENSION_CAPABILITIES (service-worker.js:315-348) are pinned verbatim.
const CLASSPILOT_2_9_6 = {
  file: "classpilot-2.9.6.json",
  version: "2.9.6",
  sourceCommit: "55bb531cb5f130cebec9d994daa957e82e87a13b",
} as const;

const CLASSPILOT_2_9_6_CAPABILITIES = [
  "helpRequestsV1",
  "questionParkingV1",
  "timerControlsV1",
  "lessonActivitiesV1",
  "exitTicketsV1",
  "classroomStateV1",
  "fabStateRevisionV1",
  "exactTabCloseV1",
  "scopedAuthorityChecksV1",
  "scheduledClassroomV1",
  "authBoundTelemetryV1",
  "exactBindingAckV2",
  "exactTabCloseV2",
  "studentAuthGatePresenceV1",
  "lateSignInRestrictionSsoV1",
  "restrictionAuthPassThroughV1",
  "restrictionPortalFirstV1",
  "afterHoursSafetyOnlyV1",
  "schoolWebsiteBlockEnforcementV1",
  "studentChatIdempotencyV1",
  "screenshotTrackingWindowLeaseV1",
  "screenshotActiveObservationCadenceV1",
  "screenshotObservationLeaseV1",
  "safetyEvidenceCaptureV1",
  "liveViewIceServersV1",
  "kioskLaunchTicketV1",
  "kioskLaunchTicketV2",
  "managedDeviceContinuityV1",
  "screenOnlyUnlockV1",
  "durableChatAckV1",
  "commandAckReceiptV1",
  "classroomOverlayRestoreV1",
  "liveViewNegotiationV1",
  "domainPreservingRestrictionsV1",
  "chatPauseV1",
  "chatSeenAckV1",
] as const;

// What 2.9.6 negotiates when every server flag this image knows is on. Only
// screenshotReadOnlyObservationV1 is missing: 2.9.6 never advertises it.
const CLASSPILOT_2_9_6_ACCEPTED_WITH_EVERY_FLAG = [
  "scopedAuthorityChecksV1",
  "authBoundTelemetryV1",
  "exactBindingAckV2",
  "exactTabCloseV2",
  "studentChatIdempotencyV1",
  "screenshotObservationLeaseV1",
  "screenshotTrackingWindowLeaseV1",
  "screenshotActiveObservationCadenceV1",
  "safetyEvidenceCaptureV1",
  "liveViewIceServersV1",
  "kioskLaunchTicketV1",
  "kioskLaunchTicketV2",
  "studentAuthGatePresenceV1",
  "lateSignInRestrictionSsoV1",
  "restrictionAuthPassThroughV1",
  "restrictionPortalFirstV1",
  "afterHoursSafetyOnlyV1",
  "schoolWebsiteBlockEnforcementV1",
  "scheduledClassroomV1",
  "helpRequestsV1",
  "questionParkingV1",
  "timerControlsV1",
  "lessonActivitiesV1",
  "exitTicketsV1",
];

function everyServerCapabilityEnabled(): NodeJS.ProcessEnv {
  return {
    ...allV3CapabilitiesEnabled(),
    CLASSPILOT_CAP_SCREENSHOT_READ_ONLY_OBSERVATION_V1: "true",
    CLASSPILOT_CAP_LATE_SIGNIN_RESTRICTION_SSO_V1: "true",
    CLASSPILOT_CAP_RESTRICTION_AUTH_PASS_THROUGH_V1: "true",
    CLASSPILOT_CAP_AFTER_HOURS_SAFETY_ONLY_V1: "true",
    CLASSPILOT_CAP_SCHOOL_WEBSITE_BLOCK_ENFORCEMENT_V1: "true",
    CLASSPILOT_CAP_SCHEDULED_CLASSROOM_V1: "true",
    CLASSPILOT_CAP_HELP_REQUESTS_V1: "true",
    CLASSPILOT_CAP_QUESTION_PARKING_V1: "true",
    CLASSPILOT_CAP_TIMER_CONTROLS_V1: "true",
    CLASSPILOT_CAP_LESSON_ACTIVITIES_V1: "true",
    CLASSPILOT_CAP_EXIT_TICKETS_V1: "true",
  };
}

function globalOn271Environment(): NodeJS.ProcessEnv {
  const rollouts = Object.fromEntries(CLASSPILOT_PROTOCOL_V3_CAPABILITIES.filter(
    (capability) => capability !== "restrictionPortalFirstV1"
  ).map(
    (capability) => [
      capability,
      { mode: capability === "kioskLaunchTicketV1" ? "off" : "on" },
    ]
  ));
  return {
    ...allV3CapabilitiesEnabled(),
    CLASSPILOT_CAP_KIOSK_LAUNCH_TICKET_V1: "false",
    CLASSPILOT_CAPABILITY_ROLLOUTS_JSON: JSON.stringify(rollouts),
  };
}

for (const definition of archivedFixtureDefinitions) {
  test(`archived ClassPilot ${definition.version} fixture remains protocol-v2 compatible`, () => {
    const fixture = readArchivedFixture(definition.file);
    assert.equal(fixture.fixtureSchemaVersion, 1);
    assert.equal(fixture.release.version, definition.version);
    assert.equal(fixture.release.sourceCommit, definition.sourceCommit);
    assert.equal(fixture.release.sourceRepository, "ClassPilot");
    assert.deepEqual(fixture.release.sourceFiles, [
      "extension/manifest.json",
      "extension/service-worker.js",
    ]);
    assert.equal(fixture.requests.registration.path, "/api/extension/register");
    assert.equal(fixture.requests.heartbeat.path, "/api/device/heartbeat");
    assert.equal(fixture.requests.websocketAuth.path, "/ws");

    const surfaceRequests: Array<[
      ClasspilotProtocolSurface,
      ArchivedFixture["requests"][keyof ArchivedFixture["requests"]],
    ]> = [
      ["registration", fixture.requests.registration],
      ["heartbeat", fixture.requests.heartbeat],
      ["websocket_auth", fixture.requests.websocketAuth],
    ];
    for (const [surface, request] of surfaceRequests) {
      assert.equal(request.body.clientProtocolVersion, 2);
      assert.equal(request.body.extensionVersion, definition.version);
      assert.deepEqual(request.body.capabilities, LEGACY_V2_CAPABILITIES);

      const negotiated = negotiateClasspilotSurfaceProtocol({
        surface,
        payload: request.body,
        scope: {
          serverOrigin: "https://api.school-pilot.test",
          schoolId: "fixture-school",
          deviceId: "fixture-device",
          studentId: "fixture-student",
          studentSessionId: "fixture-session",
        },
        env: allV3CapabilitiesEnabled(),
      });
      assert.deepEqual(negotiated, {
        serverProtocolVersion: CLASSPILOT_SERVER_PROTOCOL_VERSION,
        acceptedCapabilities: [],
      });
    }
  });
}

test("archived ClassPilot 2.9.6 fixture replays with an unchanged protocol-v3 capability set", () => {
  const fixture = readArchivedFixture(CLASSPILOT_2_9_6.file);
  assert.equal(fixture.fixtureSchemaVersion, 1);
  assert.equal(fixture.release.version, CLASSPILOT_2_9_6.version);
  assert.equal(fixture.release.sourceCommit, CLASSPILOT_2_9_6.sourceCommit);
  assert.equal(fixture.release.sourceRepository, "ClassPilot");
  assert.deepEqual(fixture.release.sourceFiles, [
    "extension/manifest.json",
    "extension/service-worker.js",
  ]);
  assert.equal(fixture.requests.registration.path, "/api/extension/register");
  assert.equal(fixture.requests.heartbeat.path, "/api/device/heartbeat");
  assert.equal(fixture.requests.websocketAuth.path, "/ws");

  const scope = {
    serverOrigin: "https://api.school-pilot.test",
    schoolId: "fixture-school",
    deviceId: "fixture-device",
    studentId: "fixture-student",
    studentSessionId: "fixture-session",
  };
  const surfaceRequests: Array<[
    ClasspilotProtocolSurface,
    ArchivedFixture["requests"][keyof ArchivedFixture["requests"]],
  ]> = [
    ["registration", fixture.requests.registration],
    ["heartbeat", fixture.requests.heartbeat],
    ["websocket_auth", fixture.requests.websocketAuth],
  ];
  for (const [surface, request] of surfaceRequests) {
    assert.equal(request.body.clientProtocolVersion, 3);
    assert.equal(request.body.extensionVersion, CLASSPILOT_2_9_6.version);
    assert.deepEqual(request.body.capabilities, CLASSPILOT_2_9_6_CAPABILITIES);
    for (const roadmapCapability of ["preciseRestrictionResourcesV1", "focusTabV1"]) {
      assert.ok(!request.body.capabilities.includes(roadmapCapability), `2.9.6 never advertises ${roadmapCapability}`);
    }

    assert.deepEqual(negotiateClasspilotSurfaceProtocol({
      surface,
      payload: request.body,
      scope,
      env: everyServerCapabilityEnabled(),
    }), {
      serverProtocolVersion: CLASSPILOT_SERVER_PROTOCOL_VERSION,
      acceptedCapabilities: CLASSPILOT_2_9_6_ACCEPTED_WITH_EVERY_FLAG,
    });
    assert.deepEqual(negotiateClasspilotSurfaceProtocol({
      surface,
      payload: request.body,
      scope,
      env: {},
    }).acceptedCapabilities, [], "every capability stays dark by default");
    // A 2.9.6-shaped client spoofing the roadmap names gains nothing.
    const spoofed = negotiateClasspilotSurfaceProtocol({
      surface,
      payload: {
        ...request.body,
        capabilities: [...request.body.capabilities, "preciseRestrictionResourcesV1", "focusTabV1"],
      },
      scope,
      env: everyServerCapabilityEnabled(),
    });
    assert.deepEqual(spoofed.acceptedCapabilities, CLASSPILOT_2_9_6_ACCEPTED_WITH_EVERY_FLAG);
    const acceptedNames: readonly string[] = spoofed.acceptedCapabilities;
    assert.ok(!acceptedNames.includes("preciseRestrictionResourcesV1"));
    assert.ok(!acceptedNames.includes("focusTabV1"));
  }
});

test("a 2.9.6 binding receives legacy restrictions but never a precise-resource snapshot", () => {
  const fixture = readArchivedFixture(CLASSPILOT_2_9_6.file);
  const { acceptedCapabilities } = negotiateClasspilotSurfaceProtocol({
    surface: "heartbeat",
    payload: fixture.requests.heartbeat.body,
    scope: { schoolId: "fixture-school" },
    env: everyServerCapabilityEnabled(),
  });
  const now = new Date("2026-09-29T15:00:00.000Z");
  const exactBinding = {
    schoolId: "fixture-school",
    studentId: "fixture-student",
    studentSessionId: "fixture-session",
    deviceId: "fixture-managed-device",
  };
  const state = (restrictions: unknown): ClasspilotStudentControlState => ({
    id: "fixture-control",
    schoolId: exactBinding.schoolId,
    studentId: exactBinding.studentId,
    teachingSessionId: "fixture-teaching-session",
    supervisionContextId: null,
    revision: 5,
    desiredState: { restrictions },
    sourceCommandId: null,
    scheduledEndAt: new Date("2026-09-29T16:00:00.000Z"),
    hardExpiresAt: new Date("2026-09-30T03:00:00.000Z"),
    enforcementHealth: "pending",
    appliedRevision: null,
    lastOutcome: null,
    lastError: null,
    lastAcknowledgedAt: null,
    createdAt: now,
    updatedAt: now,
  });
  const docsUrl = "https://docs.google.com/document/d/1a2B3c4D5e6F7g8H9i0JkLmNoPqRsTuVwXyZ/edit";
  const legacy = serializeClasspilotStudentControlStateForDelivery({
    state: state({ screenLock: { active: true, url: docsUrl } }),
    gateActive: true,
    acceptedCapabilities,
    exactBinding,
    now,
  });
  assert.equal(legacy.withheld, false, "a website-boundary Waypoint is unchanged for 2.9.6");
  assert.deepEqual(legacy.classroomState?.restrictions.screenLock, { active: true, url: docsUrl });
  assert.deepEqual(serializeClasspilotStudentControlStateForDelivery({
    state: state({
      screenLock: {
        active: true,
        url: docsUrl,
        resource: {
          type: "resource",
          hostname: "docs.google.com",
          includeSubdomains: false,
          provider: "google_docs",
          resourceId: "1a2B3c4D5e6F7g8H9i0JkLmNoPqRsTuVwXyZ",
          canonicalUrl: docsUrl,
        },
      },
    }),
    gateActive: true,
    acceptedCapabilities,
    exactBinding,
    now,
  }), {
    classroomState: null,
    withheld: true,
    withheldReason: "precise_restriction_capability_required",
  }, "2.9.6 would widen the resource Waypoint to all of docs.google.com");
});

test("registration, heartbeat, and WebSocket auth invoke the shared executable compatibility adapter", () => {
  const devices = readFileSync(
    new URL("../src/routes/classpilot/devices.ts", import.meta.url),
    "utf8"
  );
  const websocket = readFileSync(
    new URL("../src/realtime/websocket.ts", import.meta.url),
    "utf8"
  );
  const registration = devices.slice(
    devices.indexOf('router.post("/extension/register"'),
    devices.indexOf('// POST /api/classpilot/register-student')
  );
  const heartbeat = devices.slice(
    devices.indexOf('router.post("/device/heartbeat"'),
    devices.indexOf('// Screenshots')
  );
  assert.match(
    registration,
    /negotiateClasspilotSurfaceProtocol\(\{[\s\S]*surface: "registration"[\s\S]*payload: req\.body/
  );
  assert.match(
    heartbeat,
    /negotiateClasspilotSurfaceProtocol\(\{[\s\S]*surface: "heartbeat"[\s\S]*payload: req\.body/
  );
  assert.match(
    websocket,
    /negotiateClasspilotSurfaceProtocol\(\{[\s\S]*surface: "websocket_auth"[\s\S]*payload: message/
  );
  assert.match(registration, /\.\.\.protocol/);
  assert.match(heartbeat, /\.\.\.protocol/);
  assert.match(websocket, /\.\.\.protocol/);
});

test("protocol v2 never activates v3 behavior even when a legacy payload spoofs v3 capability names", () => {
  const fixture = readArchivedFixture("classpilot-2.6.9.json");
  const negotiated = negotiateClasspilotProtocol({
    clientProtocolVersion: fixture.requests.heartbeat.body.clientProtocolVersion,
    advertisedCapabilities: [
      ...fixture.requests.heartbeat.body.capabilities,
      ...CLASSPILOT_PROTOCOL_V3_CAPABILITIES,
    ],
    env: allV3CapabilitiesEnabled(),
  });
  assert.deepEqual(negotiated.acceptedCapabilities, []);
});

test("a markerless 2.7.0-shaped client receives no 2.7.1 capability under global-on", () => {
  const advertisedCapabilities = CLASSPILOT_PROTOCOL_V3_CAPABILITIES.filter(
    (capability) => capability !== "scopedAuthorityChecksV1"
  );
  const negotiated = negotiateClasspilotProtocol({
    clientProtocolVersion: 3,
    advertisedCapabilities,
    env: globalOn271Environment(),
  });
  assert.deepEqual(negotiated.acceptedCapabilities, []);
});

test("a 2.7.2-shaped client keeps the observation lease when the additive tracking lease is enabled", () => {
  const advertisedCapabilities = CLASSPILOT_PROTOCOL_V3_CAPABILITIES.filter(
    (capability) => capability !== "screenshotTrackingWindowLeaseV1"
      && capability !== "screenshotActiveObservationCadenceV1"
      && capability !== "kioskLaunchTicketV1"
  );
  const negotiated = negotiateClasspilotProtocol({
    clientProtocolVersion: 3,
    advertisedCapabilities,
    env: allV3CapabilitiesEnabled(),
  });
  assert.ok(negotiated.acceptedCapabilities.includes("screenshotObservationLeaseV1"));
  assert.ok(!negotiated.acceptedCapabilities.includes("screenshotTrackingWindowLeaseV1"));
});

test("protocol v3 accepts only the client-advertised and server-enabled capability intersection", () => {
  const advertisedCapabilities = [
    ...LEGACY_V2_CAPABILITIES,
    "scopedAuthorityChecksV1",
    "authBoundTelemetryV1",
    "exactBindingAckV2",
    "studentChatIdempotencyV1",
    "screenshotObservationLeaseV1",
    "safetyEvidenceCaptureV1",
    "kioskLaunchTicketV1",
    "kioskLaunchTicketV2",
    "unknownFutureCapability",
    "authBoundTelemetryV1",
  ];
  const env: NodeJS.ProcessEnv = {
    CLASSPILOT_PROTOCOL_V3_ENABLED: "true",
    CLASSPILOT_CAP_SCOPED_AUTHORITY_CHECKS_V1: "true",
    CLASSPILOT_CAP_AUTH_BOUND_TELEMETRY_V1: "true",
    CLASSPILOT_CAP_EXACT_BINDING_ACK_V2: "false",
    CLASSPILOT_CAP_EXACT_TAB_CLOSE_V2: "true",
    CLASSPILOT_CAP_STUDENT_CHAT_IDEMPOTENCY_V1: "true",
    CLASSPILOT_CAP_SCREENSHOT_OBSERVATION_LEASE_V1: "false",
    CLASSPILOT_CAP_SCREENSHOT_TRACKING_WINDOW_LEASE_V1: "false",
    CLASSPILOT_CAP_SCREENSHOT_ACTIVE_OBSERVATION_CADENCE_V1: "false",
    CLASSPILOT_CAP_SAFETY_EVIDENCE_CAPTURE_V1: "true",
    CLASSPILOT_CAP_LIVE_VIEW_ICE_SERVERS_V1: "true",
    CLASSPILOT_CAP_KIOSK_LAUNCH_TICKET_V1: "false",
    CLASSPILOT_CAP_KIOSK_LAUNCH_TICKET_V2: "true",
    CLASSPILOT_CAP_STUDENT_AUTH_GATE_PRESENCE_V1: "true",
  };

  assert.deepEqual(negotiateClasspilotProtocol({
    clientProtocolVersion: 3,
    advertisedCapabilities,
    env,
  }), {
    serverProtocolVersion: 3,
    acceptedCapabilities: [
      "scopedAuthorityChecksV1",
      "authBoundTelemetryV1",
      "studentChatIdempotencyV1",
      "safetyEvidenceCaptureV1",
      "kioskLaunchTicketV2",
    ],
  });
});

test("protocol-v3 master switch keeps every new behavior dark", () => {
  assert.deepEqual(negotiateClasspilotProtocol({
    clientProtocolVersion: 3,
    advertisedCapabilities: [...CLASSPILOT_PROTOCOL_V3_CAPABILITIES],
    env: {
      ...allV3CapabilitiesEnabled(),
      CLASSPILOT_PROTOCOL_V3_ENABLED: "false",
    },
  }).acceptedCapabilities, []);
});
