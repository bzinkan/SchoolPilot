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
    CLASSPILOT_CAP_AUTH_BOUND_TELEMETRY_V1: "true",
    CLASSPILOT_CAP_EXACT_BINDING_ACK_V2: "true",
    CLASSPILOT_CAP_EXACT_TAB_CLOSE_V2: "true",
    CLASSPILOT_CAP_STUDENT_CHAT_IDEMPOTENCY_V1: "true",
    CLASSPILOT_CAP_SCREENSHOT_OBSERVATION_LEASE_V1: "true",
    CLASSPILOT_CAP_SAFETY_EVIDENCE_CAPTURE_V1: "true",
    CLASSPILOT_CAP_LIVE_VIEW_ICE_SERVERS_V1: "true",
    CLASSPILOT_CAP_KIOSK_LAUNCH_TICKET_V1: "true",
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

test("protocol v3 accepts only the client-advertised and server-enabled capability intersection", () => {
  const advertisedCapabilities = [
    ...LEGACY_V2_CAPABILITIES,
    "authBoundTelemetryV1",
    "exactBindingAckV2",
    "studentChatIdempotencyV1",
    "screenshotObservationLeaseV1",
    "safetyEvidenceCaptureV1",
    "kioskLaunchTicketV1",
    "unknownFutureCapability",
    "authBoundTelemetryV1",
  ];
  const env: NodeJS.ProcessEnv = {
    CLASSPILOT_PROTOCOL_V3_ENABLED: "true",
    CLASSPILOT_CAP_AUTH_BOUND_TELEMETRY_V1: "true",
    CLASSPILOT_CAP_EXACT_BINDING_ACK_V2: "false",
    CLASSPILOT_CAP_EXACT_TAB_CLOSE_V2: "true",
    CLASSPILOT_CAP_STUDENT_CHAT_IDEMPOTENCY_V1: "true",
    CLASSPILOT_CAP_SCREENSHOT_OBSERVATION_LEASE_V1: "false",
    CLASSPILOT_CAP_SAFETY_EVIDENCE_CAPTURE_V1: "true",
    CLASSPILOT_CAP_LIVE_VIEW_ICE_SERVERS_V1: "true",
    CLASSPILOT_CAP_KIOSK_LAUNCH_TICKET_V1: "false",
  };

  assert.deepEqual(negotiateClasspilotProtocol({
    clientProtocolVersion: 3,
    advertisedCapabilities,
    env,
  }), {
    serverProtocolVersion: 3,
    acceptedCapabilities: [
      "authBoundTelemetryV1",
      "studentChatIdempotencyV1",
      "safetyEvidenceCaptureV1",
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
