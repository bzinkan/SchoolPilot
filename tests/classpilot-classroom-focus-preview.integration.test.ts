import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { after, before, test } from "node:test";
import type { School, User } from "../src/schema/core.js";
import type { TeachingSession } from "../src/schema/classpilot.js";
import { CLASSPILOT_TOOLS_SQL } from "../src/db/classpilotToolsMigration.js";

process.env.REDIS_URL = "";
process.env.NODE_ENV = "test";
process.env.JWT_SECRET ||= "classroom-focus-synthetic-local-tests-only";
process.env.SESSION_SECRET ||= "classroom-focus-synthetic-local-tests-only";
process.env.CLASSPILOT_PROTOCOL_V3_ENABLED = "true";
process.env.CLASSPILOT_CAP_SCOPED_AUTHORITY_CHECKS_V1 = "true";
process.env.CLASSPILOT_CAP_PRECISE_RESTRICTION_RESOURCES_V1 = "true";
process.env.CLASSPILOT_CAP_CLASSROOM_FOCUS_SCOPE_V1 = "true";
delete process.env.CLASSPILOT_CAPABILITY_ROLLOUTS_JSON;
let storage: typeof import("../src/services/storage.js");
let inTenant: typeof import("../src/middleware/tenantContext.js").runWithTenantContext;
let signUserToken: typeof import("../src/services/jwt.js").signUserToken;
let school: School;
let otherSchool: School;
let owner: User;
let otherTeacher: User;
let observer: User;
let session: TeachingSession;
let studentId: string;
let foreignStudentId: string;
let realtime: typeof import("../src/services/classpilotRealtimeStatus.js");
let server: Server | undefined;
let origin = "";

before(async () => {
  const url = new URL(process.env.DATABASE_URL || "");
  assert.ok(["127.0.0.1", "localhost", "::1"].includes(url.hostname), "Use only a disposable local fixture database");
  storage = await import("../src/services/storage.js");
  const database = await import("../src/db.js");
  await database.pool.query(CLASSPILOT_TOOLS_SQL);
  ({ runWithTenantContext: inTenant } = await import("../src/middleware/tenantContext.js"));
  ({ signUserToken } = await import("../src/services/jwt.js"));
  realtime = await import("../src/services/classpilotRealtimeStatus.js");
  const cache = new Map<string, string>();
  realtime.setClasspilotRealtimeStatusCommandForTests(async args => {
    if (args[0] === "MGET") return args.slice(1).map(key => cache.get(key) ?? null);
    if (args[0] === "EVAL" && args[3] && args[5]?.startsWith("{")) { cache.set(args[3], args[5]); return args[5]; }
    return undefined;
  });
  const suffix = randomUUID().slice(0, 8);
  const domain = `classroom-focus-${suffix}.example.edu`;
  school = await storage.createSchool({ name: "Synthetic Classroom Focus", slug: `focus-${suffix}`, domain, status: "active", isActive: true, planStatus: "active" });
  otherSchool = await storage.createSchool({ name: "Synthetic other school", slug: `focus-other-${suffix}`, domain, status: "active", isActive: true, planStatus: "active" });
  owner = await storage.createUser({ email: `owner@${domain}`, firstName: "Synthetic", lastName: "Owner" });
  otherTeacher = await storage.createUser({ email: `other@${domain}`, firstName: "Synthetic", lastName: "Other" });
  observer = await storage.createUser({ email: `observer@${domain}`, firstName: "Synthetic", lastName: "Observer" });
  for (const currentSchool of [school, otherSchool]) {
    await storage.createMembership({ schoolId: currentSchool.id, userId: owner.id, role: "teacher", status: "active" });
    await storage.createProductLicense({ schoolId: currentSchool.id, product: "CLASSPILOT", status: "active" });
    await inTenant({ schoolId: currentSchool.id }, () => storage.upsertSettings(currentSchool.id, {
      schoolName: currentSchool.name, wsSharedKey: "synthetic-only", enableTrackingHours: false, afterHoursMode: "off",
    }));
  }
  await storage.createMembership({ schoolId: school.id, userId: otherTeacher.id, role: "teacher", status: "active" });
  await storage.createMembership({ schoolId: school.id, userId: observer.id, role: "admin", status: "active" });
  await inTenant({ schoolId: school.id }, async () => {
    const student = await storage.createStudent({ schoolId: school.id, firstName: "Synthetic", lastName: "Student", status: "active" });
    studentId = student.id;
    const group = await storage.createGroup({ schoolId: school.id, teacherId: owner.id, name: "Synthetic course", googleClassroomCourseId: "synthetic-course" });
    await storage.addGroupStudents(group.id, [student.id]);
    session = await storage.createTeachingSession({ schoolId: school.id, groupId: group.id, teacherId: owner.id });
    const deviceId = randomUUID();
    await storage.createDevice({ schoolId: school.id, deviceId, classId: "default", deviceName: "Synthetic Chromebook" });
    const studentSession = await storage.startStudentSessionWithReplacements(school.id, student.id, deviceId, { authKind: "managed_profile" });
    const capabilities = ["scopedAuthorityChecksV1", "preciseRestrictionResourcesV1", "classroomFocusScopeV1"];
    await realtime.writeClasspilotRealtimeStatus({ schoolId: school.id, studentId: student.id, studentSessionId: studentSession.session.id,
      deviceId, heartbeatId: randomUUID(), observedAt: Date.now(), acceptedCapabilities: capabilities, extensionCapabilities: capabilities });
  });
  foreignStudentId = (await inTenant({ schoolId: otherSchool.id }, () => storage.createStudent({ schoolId: otherSchool.id,
    firstName: "Synthetic", lastName: "Foreign", status: "active" }))).id;
  // No Google token is installed for any fixture actor. Reaching the source
  // layer would yield NO_TOKENS rather than the expected authorization denial;
  // these requests cannot make a real Google call, even if a guard regresses.
  const { createApp } = await import("../src/app.js");
  server = createServer(createApp());
  await new Promise<void>(resolve => server!.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  origin = `http://127.0.0.1:${address.port}`;
});

async function preview(actor: User | null, body: Record<string, unknown>, schoolId = school.id, path = "/api/classpilot/commands/classroom-focus/preview") {
  const response = await fetch(`${origin}${path}`, {
    method: "POST", headers: { "content-type": "application/json", "x-school-id": schoolId,
      ...(actor ? { authorization: `Bearer ${signUserToken({ userId: actor.id, email: actor.email, isSuperAdmin: false })}` } : {}) },
    body: JSON.stringify(body),
  });
  const result = await response.json() as { code?: string; error?: string };
  assert.notEqual(result.code, "NO_TOKENS", "authorization must reject the request before reading Google source credentials");
  return { status: response.status, body: result };
}
const request = () => ({ teachingSessionId: session.id, targetScope: "students", targetStudentIds: [studentId] });
test("the real teacher aggregate projects negotiated Classroom support", async () => {
  const response = await fetch(`${origin}/api/students-aggregated?teachingSessionId=${session.id}`, {
    headers: { "x-school-id": school.id, authorization: `Bearer ${signUserToken({ userId: owner.id, email: owner.email, isSuperAdmin: false })}` },
  });
  assert.equal(response.status, 200);
  const rows = await response.json() as Array<{ studentId: string; acceptedCapabilities: Record<string, boolean> }>;
  const student = rows.find(row => row.studentId === studentId);
  assert.ok(student);
  assert.equal(student.acceptedCapabilities.classroomFocusScopeV1, true);
});
test("a disabled Classroom rollout refuses preview before Google source credentials", async () => {
  process.env.CLASSPILOT_CAP_CLASSROOM_FOCUS_SCOPE_V1 = "false";
  try {
    const result = await preview(owner, request());
    assert.equal(result.status, 409);
    assert.equal(result.body.code, "CLASSROOM_FOCUS_DISABLED");
  } finally { process.env.CLASSPILOT_CAP_CLASSROOM_FOCUS_SCOPE_V1 = "true"; }
});
test("unauthenticated and foreign-school previews are rejected before Google", async () => {
  assert.equal((await preview(null, request())).status, 401);
  assert.equal((await preview(owner, request(), otherSchool.id)).status, 404);
});
test("invalid or mismatched canonical Classroom Focus references create no command or desired-state write", async () => {
  const { previewClassroomFocusReview } = await import("../src/services/classpilotClassroomFocusReview.js");
  const { buildClassroomFocusSource } = await import("../src/services/classpilotClassroomFocusSource.js");
  const scope = () => inTenant({ schoolId: school.id }, async () => ({
    commands: await storage.getRecentClasspilotCommands(school.id, owner.id, session.id, 100),
    state: await storage.getClasspilotStudentControlState(school.id, studentId),
  }));
  const before = await scope();
  const reviewed = { schoolId: school.id, actorId: owner.id, authority: { teachingSessionId: session.id }, targetStudentIds: [studentId], courseId: "synthetic-course" };
  for (const change of [null, { actorId: otherTeacher.id }, { schoolId: otherSchool.id },
    { authority: { teachingSessionId: randomUUID() } }, { targetStudentIds: [foreignStudentId] }, { courseId: "another-course" }]) {
    const review = change ? await previewClassroomFocusReview({ ...reviewed, ...change }, {
      resolveSource: async request => buildClassroomFocusSource({ id: request.courseId!, name: "Synthetic source" }, []),
    }) : null;
    const result = await preview(owner, { ...request(), commandType: "lock-screen", commandPayload: {
      url: "https://classroom.google.com/", classroomFocus: { courseId: reviewed.courseId, reviewToken: review?.reviewToken || "invalid-review" },
    } }, school.id, "/api/classpilot/commands");
    assert.equal(result.status, 409);
    assert.equal(result.body.code, "CLASSROOM_FOCUS_REVIEW_STALE");
    assert.deepEqual(await scope(), before, "a refused review cannot create a command or mutate the current restriction");
  }
});
test("another teacher and an Observe-only administrator cannot review this class's Focus", async () => {
  assert.equal((await preview(otherTeacher, request())).status, 404);
  assert.equal((await preview(observer, request())).status, 404);
});
test("out-of-roster, empty, duplicate and browser-authored source targets cannot become a broader preview", async () => {
  for (const body of [
    { ...request(), targetStudentIds: [foreignStudentId] },
    { ...request(), targetStudentIds: [] },
    { ...request(), targetStudentIds: [studentId, studentId] },
    { ...request(), targetScope: "class" },
    { ...request(), resources: [{ url: "https://unreviewed.example.org/" }] },
  ]) assert.equal((await preview(owner, body)).status, 400);
});

after(async () => {
  if (server) await new Promise<void>((resolve, reject) => server!.close(error => error ? reject(error) : resolve()));
  if (session && storage && inTenant) await inTenant({ schoolId: school.id }, () => storage.finalizeTeachingSession({
    schoolId: school.id, sessionId: session.id, reason: "manual_end", recipients: [],
  }));
  const monitor = await import("../src/services/errorMonitor.js");
  realtime?.setClasspilotRealtimeStatusCommandForTests(undefined);
  await monitor.default.disposeAndWait();
  const database = await import("../src/db.js");
  const scheduler = await import("../src/services/schedulerDb.js");
  await Promise.all([database.pool.end(), database.sessionPool.end(), scheduler.schedulerPool.end(), scheduler.schedulerLockPool.end()]);
});
