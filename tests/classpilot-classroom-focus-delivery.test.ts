import assert from "node:assert/strict";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { after, test } from "node:test";
import { WebSocket, WebSocketServer } from "ws";
import { authenticateWsClient, registerWsClient, removeWsClient, sendToStudentBindingLocal,
  classpilotStudentPreciseFrameDeliverable } from "../src/realtime/ws-broadcast.js";
import { emptyClasspilotRestrictions } from "../src/services/classpilotClassroomState.js";
import { classpilotCommandAuthorityEnvelope } from "../src/services/classpilotCommandAuthority.js";

// Imported database modules below are never queried. Pin an inert local URL so
// this pure framing/socket test cannot pick up a developer's remote database.
process.env.DATABASE_URL = "postgres://fixture:fixture@127.0.0.1:1/classroom_focus_no_queries";
process.env.CLASSPILOT_PROTOCOL_V3_ENABLED = "true";
process.env.CLASSPILOT_CAP_SCOPED_AUTHORITY_CHECKS_V1 = "true";
process.env.CLASSPILOT_CAP_PRECISE_RESTRICTION_RESOURCES_V1 = "true";
process.env.CLASSPILOT_CAP_CLASSROOM_FOCUS_SCOPE_V1 = "true";
delete process.env.CLASSPILOT_CAPABILITY_ROLLOUTS_JSON;
const { scope } = JSON.parse(readFileSync(new URL("./fixtures/classroom-focus-scope-cases.json", import.meta.url), "utf8"));
const binding = { schoolId: "focus-school", studentId: "focus-student", studentSessionId: "focus-session", deviceId: "focus-device" };
const caps = ["scopedAuthorityChecksV1", "preciseRestrictionResourcesV1", "classroomFocusScopeV1"] as const;
const state = { schemaVersion: 1 as const, revision: 7, teachingSessionId: "focus-class", supervisionContextId: null,
  receivedAt: "2026-11-16T21:00:00.000Z",
  sourceCommandId: "focus-command", scheduledEndAt: null, hardExpiresAt: "2026-11-17T03:00:00.000Z",
  restrictions: { ...emptyClasspilotRestrictions(), screenLock: { active: true, url: "https://classroom.google.com", classroomScope: scope } } };

after(async () => {
  const { pool, sessionPool } = await import("../src/db.js");
  await Promise.all([pool.end(), sessionPool.end()]);
});

test("Classroom frames require their complete authoritative scope and declared new capability", async () => {
  const { classpilotCommandFrameForTarget } = await import("../src/services/classpilotCommandDispatcher.js");
  const payload = { url: "https://classroom.google.com", classroomScope: scope, commandId: "focus-command" };
  const target = { ...binding, studentName: "Synthetic student", available: true, controlRevision: 7 };
  const requiredScopeCaps = ["preciseRestrictionResourcesV1", "classroomFocusScopeV1"] as const;
  const frame = (snapshot: typeof state | undefined, requiredCapabilities: Array<typeof requiredScopeCaps[number]>) =>
    classpilotCommandFrameForTarget(binding.schoolId, "lock-screen", "lock-screen", payload, target,
      { policy: "persistent_control", expiresAt: null, requiredCapabilities }, snapshot,
      classpilotCommandAuthorityEnvelope({ teachingSessionId: "focus-class" }));
  assert.equal(frame(undefined, [...requiredScopeCaps]), null);
  assert.equal(frame(state, ["preciseRestrictionResourcesV1"]), null);
  const built = frame(state, [...requiredScopeCaps]);
  assert.ok(built);
  assert.ok("classroomState" in built);
  assert.deepEqual(built.classroomState?.restrictions.screenLock.classroomScope, scope);
  assert.ok("exactBinding" in built);
  assert.equal(built.exactBinding?.bindingVersion, 2);
  const preciseOnly = { ...state, restrictions: { ...state.restrictions, screenLock: {
    active: true, url: scope.resources[0].canonicalUrl, resource: scope.resources[0],
  } } };
  assert.equal(classpilotStudentPreciseFrameDeliverable({ command: { type: "lock-screen", data: payload }, classroomState: preciseOnly }), false);
});

test("relay requirements cannot waive Classroom capability or a live school kill switch", async () => {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const sockets: Array<{ client: WebSocket; socket: WebSocket; messages: string[] }> = [];
  try {
    for (const acceptedCapabilities of [["preciseRestrictionResourcesV1", "scopedAuthorityChecksV1"], [...caps]]) {
      const connection = once(server, "connection");
      const client = new WebSocket(`ws://127.0.0.1:${address.port}`);
      await once(client, "open");
      const [socket] = await connection;
      const messages: string[] = [];
      client.on("message", value => messages.push(value.toString()));
      sockets.push({ client, socket, messages });
      registerWsClient(socket);
      authenticateWsClient(socket, { role: "student", ...binding, acceptedCapabilities });
    }
    const message = { type: "classroom-state-sync", _msgId: "scope-relay", classroomState: state };
    const arrived = once(sockets[1]!.client, "message");
    assert.equal(sendToStudentBindingLocal(binding, message, { requiredCapabilities: ["preciseRestrictionResourcesV1"] }), true);
    await arrived;
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.deepEqual(sockets[0]!.messages, []);
    assert.deepEqual(sockets[1]!.messages, [JSON.stringify(message)]);
    process.env.CLASSPILOT_CAP_CLASSROOM_FOCUS_SCOPE_V1 = "false";
    try { assert.equal(sendToStudentBindingLocal(binding, { ...message, _msgId: "disabled-scope" }), false); }
    finally { process.env.CLASSPILOT_CAP_CLASSROOM_FOCUS_SCOPE_V1 = "true"; }
  } finally {
    for (const { client, socket } of sockets) { removeWsClient(socket); client.terminate(); socket.terminate(); }
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test("assigned outside work receives teacher intent only while its reviewed Classroom Focus is active", async () => {
  const { classpilotTeacherIntentForUrl } = await import("../src/services/classpilotTeacherIntent.js");
  const context = { allowedDomains: [], flightPath: { active: true, allowedDomains: ["school.example"] }, screenLock: state.restrictions.screenLock };
  assert.equal(classpilotTeacherIntentForUrl("https://assigned.example/lesson", context), "classroom_focus");
  assert.equal(classpilotTeacherIntentForUrl("https://unassigned.example/lesson", context), null);
  assert.equal(classpilotTeacherIntentForUrl("https://assigned.example/lesson", { ...context, screenLock: { active: false } }), null);
  assert.equal(classpilotTeacherIntentForUrl("https://school.example/lesson", context), "flight_path");
});
