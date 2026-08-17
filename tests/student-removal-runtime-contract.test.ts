import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);

async function source(path: string): Promise<string> {
  return readFile(new URL(path, root), "utf8");
}

test("inactive students cannot authenticate, register, heartbeat, or switch onto a ClassPilot device", async () => {
  const [studentAuth, devices, storage] = await Promise.all([
    source("src/services/classpilotStudentAuth.ts"),
    source("src/routes/classpilot/devices.ts"),
    source("src/services/storage.ts"),
  ]);

  assert.match(
    studentAuth,
    /eq\(students\.status, "active"\)/,
    "signed device tokens must resolve only through active student rows"
  );
  assert.match(
    studentAuth,
    /options\.student\.status !== "active"/,
    "session issuance must reject a stale inactive student object"
  );
  assert.ok(
    (devices.match(/student && student\.status !== "active"/g) || []).length >= 2,
    "both current and legacy extension registration routes must reject inactive exact-email matches"
  );
  assert.match(
    devices,
    /student\.status !== "active"[\s\S]{0,180}STUDENT_INACTIVE/,
    "manual device switching must reject inactive students"
  );
  assert.match(
    storage,
    /student\.school_id = \$\{data\.schoolId\}[\s\S]{0,100}student\.status = 'active'/,
    "the atomic heartbeat path must not record activity for inactive students"
  );
  assert.match(
    storage,
    /startStudentSession\([\s\S]*?takePasspilotClassLock\(tx, schoolId\)[\s\S]*?eq\(students\.status, "active"\)[\s\S]*?\.for\("update"\)/,
    "session issuance must serialize its active-student decision with roster removal"
  );
  assert.match(
    studentAuth,
    /startStudentSession\(\s*options\.schoolId,\s*options\.student\.id,\s*options\.deviceId\s*\)/,
    "the credential issuer must bind atomic session creation to the selected school"
  );
  const deviceSwitch = storage.slice(
    storage.indexOf("export async function setActiveStudentForDevice"),
    storage.indexOf("// ClassPilot - Heartbeat operations")
  );
  assert.match(deviceSwitch, /takePasspilotClassLock\(tx, candidate\.schoolId\)/);
  assert.match(deviceSwitch, /eq\(students\.status, "active"\)[\s\S]*?\.for\("update"\)/);
  assert.match(deviceSwitch, /tx[\s\S]*?\.insert\(studentSessions\)/);
});

test("active PassPilot reads exclude removed students while history keeps their identity", async () => {
  const [storage, passRoutes] = await Promise.all([
    source("src/services/storage.ts"),
    source("src/routes/passpilot/passes.ts"),
  ]);
  const activeReads = storage.slice(
    storage.indexOf("export async function getActivePassesBySchool"),
    storage.indexOf("export async function getPassById")
  );
  assert.ok(
    (activeReads.match(/eq\(students\.status, "active"\)/g) || []).length >= 4,
    "school, grade, class, and per-student active pass reads must join active students"
  );
  const historyRead = storage.slice(
    storage.indexOf("export async function getPassById"),
    storage.indexOf("export async function createPass")
  );
  assert.doesNotMatch(
    historyRead,
    /eq\(students\.status, "active"\)/,
    "retained pass and history reads must remain lifecycle-neutral"
  );
  const enrichment = passRoutes.slice(
    passRoutes.indexOf("async function enrichPasses"),
    passRoutes.indexOf("// Map legacy passType")
  );
  assert.match(enrichment, /getStudentsByIds/);
  assert.doesNotMatch(enrichment, /getStudentsBySchool/);
});

test("inactive students stay out of operational ClassPilot and PassPilot writes", async () => {
  const [groups, adminClasses, passes, kiosk] = await Promise.all([
    source("src/routes/classpilot/groups.ts"),
    source("src/routes/classpilot/adminClasses.ts"),
    source("src/routes/passpilot/passes.ts"),
    source("src/routes/passpilot/kiosk.ts"),
  ]);

  assert.match(groups, /s\.schoolId === schoolId && s\.status === "active"/);
  assert.match(
    adminClasses,
    /student\.schoolId === schoolId && student\.status === "active"/
  );
  assert.match(
    passes,
    /student\.schoolId !== schoolId \|\| student\.status !== "active"/
  );
  assert.match(
    kiosk,
    /student\.schoolId !== schoolId \|\| student\.status !== "active"/
  );
});

test("trusted roster imports restore exact inactive identities and report a restored subset", async () => {
  const [classroom, directory, adminClasses, gopilot] = await Promise.all([
    source("src/routes/google/classroom.ts"),
    source("src/routes/google/directory.ts"),
    source("src/routes/classpilot/adminClasses.ts"),
    source("src/routes/gopilot/students.ts"),
  ]);

  for (const routeSource of [classroom, directory, adminClasses, gopilot]) {
    assert.match(routeSource, /reactivateInactiveStudentForRosterImport/);
    assert.match(routeSource, /restored/);
  }
  assert.match(classroom, /source: "google_classroom_sync"/);
  assert.match(directory, /source: "google_workspace_import"/);
  assert.match(adminClasses, /source: "classpilot_classroom_import"/);
  assert.match(gopilot, /source: "gopilot_roster_(?:add|import)"/);
  assert.match(gopilot, /function mayReactivateStudent/);
  assert.match(gopilot, /code: "STUDENT_REACTIVATION_FORBIDDEN"/);
  assert.ok(
    (gopilot.match(/existing\?\.status === "inactive" && !mayReactivateStudent\(req\)/g) || []).length >= 1,
    "GoPilot import must deny office-staff inactive matches before restoring them"
  );
  assert.match(
    gopilot,
    /if \(!mayReactivateStudent\(req\)\) return reactivationDenied\(res\);/,
    "GoPilot single add must deny office-staff inactive matches"
  );
});

test("inactive students cannot keep or renew MailPilot operational watches", async () => {
  const [pubsub, scheduler, provisioning] = await Promise.all([
    source("src/routes/mailpilot/pubsub.ts"),
    source("src/services/scheduler.ts"),
    source("src/services/mailpilotProvisioning.ts"),
  ]);

  assert.match(pubsub, /activeStudent\.status !== "active"/);
  assert.match(pubsub, /activeStudent\.emailLc !== studentEmail\.toLowerCase\(\)/);
  assert.match(scheduler, /eq\(students\.status, "active"\)/);
  assert.match(scheduler, /activeStudentKeys\.has/);
  assert.match(provisioning, /export async function stopMailpilotMonitoringForStudent/);
  assert.match(provisioning, /await stopWatch\(watch\.studentEmail\)/);
  assert.match(provisioning, /await deleteMailpilotWatch\(watch\.studentEmail\)/);
});

test("already-authenticated student WebSockets revalidate before every student mutation", async () => {
  const [websocket, redis, revocation] = await Promise.all([
    source("src/realtime/websocket.ts"),
    source("src/realtime/ws-redis.ts"),
    source("src/realtime/studentSocketRevocation.ts"),
  ]);

  assert.match(websocket, /export async function hasActiveStudentWebSocketBinding/);
  assert.match(websocket, /resolveActiveStudentTokenSession\(payload\)/);
  assert.match(websocket, /ws\.close\(1008, "Student session is no longer active"\)/);
  assert.match(websocket, /case "student-disconnect"/);
  assert.match(websocket, /studentWebSocketPongRevalidation/);
  assert.match(redis, /kind: "student-disconnect"; schoolId: string; studentIds: string\[\]/);
  assert.match(revocation, /closeStudentSocketsLocal\(schoolId, uniqueStudentIds\)/);
  assert.match(revocation, /publishWS\([\s\S]*kind: "student-disconnect"/);

  const gate = websocket.indexOf("Authentication is not a one-time authorization grant");
  assert.ok(gate > 0, "student socket revalidation gate must exist");
  for (const marker of [
    "Student FAB chat delivery acknowledgements",
    "ClassPilot teacher command acknowledgements",
    "WebRTC signaling: authorized student IDs",
  ]) {
    assert.ok(
      websocket.indexOf(marker) > gate,
      `${marker} must execute only after current-session revalidation`
    );
  }
});

test("local roster revocation removes socket authority before closing", async () => {
  const registry = await import("../src/realtime/ws-broadcast.js");
  registry.resetWsState();
  const events: Array<{ type: string; value?: unknown }> = [];
  const socket = {
    readyState: 1,
    send(value: unknown) {
      events.push({ type: "send", value });
    },
    close(code: number) {
      events.push({ type: "close", value: code });
      this.readyState = 2;
    },
    terminate() {
      events.push({ type: "terminate" });
      this.readyState = 3;
    },
  } as any;

  registry.registerWsClient(socket);
  registry.authenticateWsClient(socket, {
    role: "student",
    schoolId: "school-1",
    studentId: "student-1",
    studentSessionId: "session-1",
    deviceId: "device-1",
  });

  assert.equal(registry.closeStudentSocketsLocal("school-1", ["student-1"]), 1);
  assert.equal(events.find((event) => event.type === "close")?.value, 1008);
  assert.equal(
    registry.sendToDeviceLocal("school-1", "device-1", { type: "should-not-deliver" }),
    false,
    "registry authority must be gone before the close handshake completes"
  );
  registry.resetWsState();
});

test("roster removal revokes student sockets before external MailPilot cleanup", async () => {
  const [students, monitoring, compat] = await Promise.all([
    source("src/routes/students.ts"),
    source("src/routes/classpilot/monitoring.ts"),
    source("src/routes/compat.ts"),
  ]);
  const removalBlocks = [
    students.slice(students.indexOf("// DELETE /api/students/:studentId")),
    monitoring.slice(monitoring.indexOf('router.delete("/students/:studentId"')),
    compat.slice(
      compat.indexOf('router.post("/admin/students/bulk-delete"'),
      compat.indexOf('router.post("/admin/students/bulk-update-grade"')
    ),
  ];

  for (const block of removalBlocks) {
    const revokeIndex = block.indexOf("revokeClasspilotStudentSocketsAfterRosterRemoval");
    const mailpilotIndex = block.indexOf("stopMailpilotMonitoringForStudent");
    assert.ok(revokeIndex >= 0, "roster removal must revoke ClassPilot sockets");
    assert.ok(mailpilotIndex > revokeIndex, "socket revocation must precede external Gmail cleanup");
  }
});

test("GoPilot live queue surfaces deny inactive students while completed history remains retained", async () => {
  const [access, dismissal, scheduler, storage] = await Promise.all([
    source("src/services/gopilotAccess.ts"),
    source("src/routes/gopilot/dismissal.ts"),
    source("src/services/scheduler.ts"),
    source("src/services/storage.ts"),
  ]);

  assert.match(
    access,
    /getQueueEntryForSchool[\s\S]*eq\(students\.status, "active"\)/,
    "every queue mutation preflight must resolve through an active student"
  );
  assert.match(
    dismissal,
    /session\.status !== "completed" && student\.status !== "active"/,
    "live and paused queue DTOs must hide retained inactive rows without erasing completed history"
  );
  assert.ok(
    (dismissal.match(/activeStudentsOnly: session\.status !== "completed"/g) || []).length >= 2,
    "both queue entries and queue stats must use active-only reads outside completed history"
  );
  assert.match(storage, /async function lockActiveDismissalQueueStudents/);
  assert.ok(
    (storage.match(/lockActiveDismissalQueueStudents\(transactionDb/g) || []).length >= 7,
    "call, release, dismiss, batch, hold, and delay mutations must lock active students atomically"
  );
  assert.match(
    storage,
    /callNextBatch[\s\S]{0,1800}eq\(students\.status, "active"\)/,
    "batch calling must never select an inactive student's retained queue row"
  );
  assert.match(
    scheduler,
    /outstanding:[\s\S]{0,300}innerJoin\([\s\S]{0,240}eq\(students\.status, "active"\)/,
    "stale-session reconciliation must not keep a session paused for retained inactive queue rows"
  );
});

test("GoPilot roster removal delegates to the canonical admin-only lifecycle shutdown", async () => {
  const students = await source("src/routes/gopilot/students.ts");

  assert.match(students, /const lifecycleAuth = \[[\s\S]*requireGoPilotRole\("admin", "school_admin"\)/);
  assert.match(students, /router\.delete\("\/:studentId", \.\.\.lifecycleAuth/);
  assert.match(students, /deactivateStudentsForRoster\(schoolId, \[studentId\]/);
  assert.match(students, /source: "gopilot_roster_remove"/);
  assert.match(students, /stopMailpilotMonitoringForStudent/);
  assert.match(students, /revokeClasspilotStudentSocketsAfterRosterRemoval/);
  assert.doesNotMatch(
    students,
    /router\.delete\("\/:studentId"[\s\S]{0,900}updateStudent\(studentId, \{ status: "inactive" \}\)/
  );
});

test("inactive students cannot be assigned to live ClassPilot supervision or controls", async () => {
  const [dashboard, coverage, storage] = await Promise.all([
    source("src/routes/classpilot/dashboard.ts"),
    source("src/routes/classpilot/coverage.ts"),
    source("src/services/storage.ts"),
  ]);

  const assignRoute = dashboard.slice(
    dashboard.indexOf('router.post("/students/:studentId/assign"'),
    dashboard.indexOf('router.delete("/students/:studentId/unassign"')
  );
  assert.match(assignRoute, /student\.status !== "active"/);
  assert.match(coverage, /async function assertActiveStudentsInSchool/);
  assert.match(coverage, /code: "CLASSPILOT_STUDENT_INACTIVE"/);
  assert.ok(
    (coverage.match(/assertActiveStudentsInSchool\(/g) || []).length >= 10,
    "coverage setup, claim, send, context, reroute, and command paths must share the active guard"
  );
  assert.match(
    coverage,
    /resolveCoverageCommandTargets[\s\S]{0,2200}assertActiveStudentsInSchool/,
    "coverage command targets must be revalidated as active"
  );
  assert.match(
    storage,
    /assignTeacherStudent[\s\S]{0,900}eq\(students\.status, "active"\)[\s\S]{0,160}\.for\("update"\)/
  );
  assert.ok(
    (storage.match(/lockActiveSchoolStudentsForOperationalWrite\(/g) || []).length >= 5,
    "storage must atomically defend teacher and coverage assignment writes"
  );
});

test("the administrator AI create tool restores an exact inactive identity", async () => {
  const executor = await source("src/services/chatToolExecutor.ts");
  const createTool = executor.slice(
    executor.indexOf("create_student: async"),
    executor.indexOf("mark_students_absent: async")
  );

  assert.match(createTool, /getStudentByEmail\(ctx\.schoolId, emailLc\)/);
  assert.match(createTool, /existing\?\.status === "inactive"/);
  assert.match(createTool, /reactivateInactiveStudentForRosterImport/);
  assert.match(createTool, /source: "ai_assistant_create_student"/);
  assert.match(createTool, /restored/);
});
