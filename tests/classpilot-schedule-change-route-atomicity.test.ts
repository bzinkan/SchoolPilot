import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);

async function source(path: string): Promise<string> {
  return readFile(new URL(path, root), "utf8");
}

test("ClassPilot class-create and group-patch routes use atomic assignment primitives", async () => {
  const [groups, dashboard, adminClasses] = await Promise.all([
    source("src/routes/classpilot/groups.ts"),
    source("src/routes/classpilot/dashboard.ts"),
    source("src/routes/classpilot/adminClasses.ts"),
  ]);

  const groupCreate = groups.slice(
    groups.indexOf("// POST /api/classpilot/groups - Create group"),
    groups.indexOf("// PATCH /api/classpilot/groups/:id - Update group")
  );
  assert.match(groupCreate, /upsertClasspilotGroupWithAssignments/);
  assert.doesNotMatch(groupCreate, /\bcreateGroup\b|\baddGroupTeacher\b|\baddGroupStudents\b/);

  const groupPatch = groups.slice(
    groups.indexOf("// PATCH /api/classpilot/groups/:id - Update group"),
    groups.indexOf("// DELETE /api/classpilot/groups/:id - Delete group")
  );
  assert.match(groupPatch, /upsertClasspilotGroupWithAssignments/);
  assert.doesNotMatch(groupPatch, /\bupdateGroup\b|\bsetGroupStudents\b|\bgetGroupTeachers\b/);
  assert.doesNotMatch(
    groupPatch,
    /primaryTeacherId\s*:|coTeacherIds\s*:|existing\.teacherId/,
    "PATCH must let the locked helper preserve assignments it does not own"
  );

  const dashboardCreate = dashboard.slice(
    dashboard.indexOf("// POST /teacher/groups - Create a group"),
    dashboard.indexOf("// Raised hands (ClassPilot frontend)")
  );
  assert.match(dashboardCreate, /upsertClasspilotGroupWithAssignments/);
  assert.doesNotMatch(dashboardCreate, /\bcreateGroup\b|\baddGroupTeacher\b/);

  const adminCreateStart = adminClasses.indexOf('router.post("/", ...auth');
  const adminCreate = adminClasses.slice(
    adminCreateStart,
    adminClasses.indexOf('router.patch("/:id"', adminCreateStart)
  );
  assert.match(adminCreate, /upsertAdminClassroomClass/);
  assert.doesNotMatch(adminCreate, /\bcreateGroup\b|\breplaceGroupTeachers\b/);

  const adminPatchStart = adminClasses.indexOf('router.patch("/:id", ...auth');
  const adminPatch = adminClasses.slice(
    adminPatchStart,
    adminClasses.indexOf('router.post("/:id/students"', adminPatchStart)
  );
  assert.match(adminPatch, /updateAdminClassWithTeachers/);
  assert.doesNotMatch(adminPatch, /getGroupTeacherSummaries/);
  assert.match(adminPatch, /primaryTeacherId:\s*submittedPrimaryTeacherId/);
  assert.match(adminPatch, /coTeacherIds,/);
  assert.doesNotMatch(
    adminPatch,
    /data\.(?:name|description|periodLabel|gradeLevel|schoolYear|term)\s*=\s*group\./,
    "Admin PATCH must not write omitted scalar fields from a pre-lock snapshot"
  );
});

test("schedule-change realtime keeps office staff view-only", async () => {
  const [websocket, broadcast, refreshHook] = await Promise.all([
    source("src/realtime/websocket.ts"),
    source("src/realtime/ws-broadcast.ts"),
    source("schoolpilot-app/src/products/classpilot/hooks/useScheduleChangeRefresh.js"),
  ]);

  assert.match(refreshHook, /currentUser\.role === "office_staff"[\s\S]*?"office_staff"/);
  assert.match(websocket, /message\.role === "office_staff"/);
  assert.match(websocket, /membershipRole === "office_staff"[^\n]*return "office_staff"/);
  assert.match(websocket, /No active ClassPilot access for this school/);
  assert.match(websocket, /export async function activeStaffWebSocketRole/);
  assert.match(websocket, /activeStaffWebSocketRole\(client\)/);
  assert.match(
    websocket,
    /Promise\.all\(\[[\s\S]*activeStaffWebSocketRole\(client\)[\s\S]*getUserById\(client\.userId\)/,
    "Mutating staff frames must revalidate both role and credential version"
  );
  assert.match(websocket, /await validatePassiveAuthorization\(\)/);
  assert.match(websocket, /staffWebSocketMessageRevalidation/);
  assert.match(websocket, /staffPongRevalidation/);
  assert.ok(
    websocket.indexOf("staffWebSocketMessageRevalidation") < websocket.indexOf("// --- Passive heartbeat handling ---"),
    "Staff heartbeat authority must be revalidated before refreshing presence"
  );
  assert.match(broadcast, /WsRole = [^;]*"office_staff"/);

  const controlHandlers = websocket.slice(websocket.indexOf("// --- Remote control:"));
  assert.doesNotMatch(
    controlHandlers,
    /client\.role === "office_staff"/,
    "Office staff may receive staff refresh events but must not gain teacher command authority"
  );
});
