import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);

test("student login returns classroom state only for the exact active token session", async () => {
  const devices = await readFile(new URL("src/routes/classpilot/devices.ts", root), "utf8");
  const start = devices.indexOf("async function completeStudentDeviceLogin");
  const end = devices.indexOf("async function recordRemoteActionTimeline", start);
  assert.ok(start >= 0 && end > start, "completeStudentDeviceLogin source should be present");
  const login = devices.slice(start, end);

  assert.match(login, /const tokenPayload = verifyStudentToken\(studentToken\)/);
  assert.equal(
    (login.match(/verifyActiveStudentTokenSession\(tokenPayload\)/g) || []).length,
    2,
    "the exact student/session/device token binding must be checked before and after reading state"
  );
  const firstAuthorization = login.indexOf("verifyActiveStudentTokenSession(tokenPayload)");
  const stateRead = login.indexOf("getClasspilotStudentControlState(");
  const secondAuthorization = login.lastIndexOf("verifyActiveStudentTokenSession(tokenPayload)");
  assert.ok(firstAuthorization < stateRead && stateRead < secondAuthorization);
  assert.match(login, /serializeClasspilotStudentControlState\(controlState\)/);
  assert.match(login, /: null;/);
  assert.match(login, /classroomState,/);
});

test("heartbeat and WebSocket reconciliation carry authoritative explicit-null state", async () => {
  const [devices, websocket] = await Promise.all([
    readFile(new URL("src/routes/classpilot/devices.ts", root), "utf8"),
    readFile(new URL("src/realtime/websocket.ts", root), "utf8"),
  ]);

  const heartbeatStart = devices.indexOf('router.post("/device/heartbeat"');
  const heartbeatEnd = devices.indexOf('router.post("/device/screenshot"', heartbeatStart);
  assert.ok(heartbeatStart >= 0 && heartbeatEnd > heartbeatStart);
  const heartbeat = devices.slice(heartbeatStart, heartbeatEnd);
  assert.match(heartbeat, /const classroomState = controlState[\s\S]*?: null;/);
  assert.ok(
    (heartbeat.match(/planStatus: school\.planStatus \|\| "active",\s*classroomState,/g) || []).length >= 2,
    "both stale-current and normal heartbeat responses must include explicit null"
  );

  assert.match(websocket, /classroomState: classroomStateRow[\s\S]*?: null,/);
  assert.match(websocket, /classroomState: bootstrap\.classroomState,/);
  assert.match(websocket, /message\.type === "classroom-state-request"/);
  assert.match(websocket, /session\.id === client\.studentSessionId/);
  assert.match(websocket, /session\.deviceId === client\.deviceId/);
  assert.match(websocket, /type: "classroom-state-sync",\s*classroomState: reconciliation\.state/);
});
