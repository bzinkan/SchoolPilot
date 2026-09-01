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
    1,
    "the issued token must fail fast before final response delivery authority is acquired"
  );
  const firstAuthorization = login.indexOf("verifyActiveStudentTokenSession(tokenPayload)");
  const responseAuthority = login.indexOf("withClasspilotStudentLoginResponseAuthority(");
  const stateRead = login.indexOf("getClasspilotStudentControlState(");
  const synchronousSend = login.indexOf("return sendResponse(login)");
  assert.ok(
    firstAuthorization < responseAuthority
      && responseAuthority < stateRead
      && stateRead < synchronousSend,
    "state preparation and response serialization must remain inside exact binding authority"
  );
  const authorityStart = devices.indexOf(
    "export async function withClasspilotStudentLoginResponseAuthority"
  );
  assert.ok(authorityStart >= 0 && authorityStart < start);
  const responseAuthoritySource = devices.slice(authorityStart, start);
  assert.match(responseAuthoritySource, /withClasspilotStudentControlDeliveryAuthority\(/);
  assert.match(responseAuthoritySource, /\(_claimed, prepared\) => sendResponse\(prepared\)/);
  assert.match(login, /getClasspilotStudentControlState\([\s\S]*?transactionDb/);
  assert.match(login, /serializeClasspilotStudentControlStateForDelivery\(\{/);
  assert.match(login, /gateActive: isClasspilotCapabilityActive\([\s\S]*?"lateSignInRestrictionSsoV1"/);
  assert.match(login, /acceptedCapabilities: loginProtocol\.acceptedCapabilities/);
  assert.match(
    login,
    /exactBinding: \{[\s\S]*?schoolId: options\.schoolId,[\s\S]*?studentId: student\.id,[\s\S]*?studentSessionId: session\.id,[\s\S]*?deviceId: effectiveDeviceId/
  );
  assert.match(login, /: \{ classroomState: null, withheld: false \};/);
  assert.match(login, /const classroomState = loginDelivery\.classroomState/);
  assert.match(login, /classroomState,/);
  assert.match(login, /exactBinding: classpilotControlStateExactBinding\(\{/);
  assert.match(login, /withheldReason: loginDelivery\.withheldReason/);
  assert.match(
    login,
    /prepared\.withheldReason === "late_sign_in_capability_required"[\s\S]*recordHeartbeatHotPathCounter\("lateSignInDeliveryWithheld"\)/
  );
  assert.match(login, /withheldReason: _withheldReason/);

  const studentLoginRoute = devices.slice(
    devices.indexOf('router.post("/extension/student-login"'),
    devices.indexOf('router.post("/extension/session-gate-presence"')
  );
  assert.equal(
    studentLoginRoute.match(/\}, \(prepared\) => res\.json\(prepared\)\)/g)?.length,
    2,
    "email/ID and PIN login responses must serialize inside response authority"
  );
  const registrationRoutes = devices.slice(
    devices.indexOf('router.post("/extension/register"'),
    devices.indexOf("// Popup Endpoints")
  );
  assert.match(
    registrationRoutes,
    /completeStudentDeviceLogin\([\s\S]*?\}, \(prepared\) => \{[\s\S]*?return res\.json\(\{[\s\S]*?\.\.\.prepared/
  );
  assert.match(
    registrationRoutes,
    /router\.post\("\/register-student"[\s\S]*?completeStudentDeviceLogin\([\s\S]*?\}, \(prepared\) => res\.json\(\{[\s\S]*?studentToken: prepared\.studentToken/
  );
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
  assert.match(
    heartbeat,
    /const heartbeatDelivery = controlState[\s\S]*?: \{ classroomState: null, withheld: false \};/
  );
  assert.match(heartbeat, /const classroomState = heartbeatDelivery\.classroomState/);
  assert.match(
    heartbeat,
    /classpilotRestrictionAuthCapabilityRequired\([\s\S]*gateActive: restrictionAuthGateActive[\s\S]*effectiveClasspilotControlEnforcementHealth\([\s\S]*restrictionAuthCapabilityRequired/,
    "heartbeat enforcement truth must follow current auth policy capability withholding"
  );
  assert.match(
    heartbeat,
    /planStatus: school\.planStatus \|\| "active",\s*classroomState: prepared\.classroomState,/
  );
  const staleResponseStart = heartbeat.indexOf('realtimeStatusMutation.status === "stale"');
  const staleResponseEnd = heartbeat.indexOf('throw new Error("Realtime heartbeat snapshot was not created")');
  assert.ok(staleResponseStart >= 0 && staleResponseEnd > staleResponseStart);
  assert.doesNotMatch(
    heartbeat.slice(staleResponseStart, staleResponseEnd),
    /classroomState|controlRevision/,
    "a stale heartbeat must not leak a hidden control revision or classroom state"
  );

  assert.match(
    websocket,
    /const authDelivery = classroomStateRow[\s\S]*?serializeClasspilotStudentControlStateForDelivery\(\{[\s\S]*?acceptedCapabilities: protocol\.acceptedCapabilities[\s\S]*?: \{ classroomState: null, withheld: false \}/
  );
  assert.match(websocket, /const classroomState = authDelivery\.classroomState/);
  assert.match(websocket, /type: "auth-success"[\s\S]*?classroomState: prepared\.classroomState,/);
  assert.match(websocket, /type: "auth-success"[\s\S]*?exactBinding: classpilotControlStateExactBinding\(\{/);
  assert.match(websocket, /message\.type === "classroom-state-request"/);
  assert.match(websocket, /withClasspilotStudentControlDeliveryAuthority\(/);
  assert.match(websocket, /studentSessionId: client\.studentSessionId/);
  assert.match(websocket, /deviceId: client\.deviceId/);
  assert.match(
    websocket,
    /classpilotClassroomStatePushFrame\(\{[\s\S]*?type: "classroom-state-sync",[\s\S]*?binding: \{[\s\S]*?schoolId: client\.schoolId!?,[\s\S]*?deviceId: client\.deviceId!?,[\s\S]*?studentId: client\.studentId!?,[\s\S]*?studentSessionId: client\.studentSessionId!?,[\s\S]*?controlRevision: delivered\?\.revision \?\? 0,[\s\S]*?classroomState: delivered/
  );
  assert.equal(
    (devices.match(/exactBinding: classpilotControlStateExactBinding\(\{/g) || []).length,
    4,
    "login, settings, safety close, and heartbeat must share the canonical V2 binding builder"
  );
});
