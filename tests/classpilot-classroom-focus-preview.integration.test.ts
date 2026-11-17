import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
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
let secondStudentId: string;
const studentBindings = new Map<string, { studentSessionId: string; deviceId: string }>();
let foreignStudentId: string;
let realtime: typeof import("../src/services/classpilotRealtimeStatus.js");
let server: Server | undefined;
let origin = "";

before(async () => {
  const url = new URL(process.env.DATABASE_URL || "");
  assert.ok(["127.0.0.1", "localhost", "::1"].includes(url.hostname), "Use only a disposable local fixture database");
  storage = await import("../src/services/storage.js");
  const database = await import("../src/db.js");
  if (process.env.ADMIN_DATABASE_URL) {
    const adminUrl = new URL(process.env.ADMIN_DATABASE_URL);
    assert.ok(["127.0.0.1", "localhost", "::1"].includes(adminUrl.hostname) && adminUrl.pathname === url.pathname,
      "Fixture DDL must use the same disposable local database");
    const { Pool } = await import("pg");
    const setupPool = new Pool({ connectionString: process.env.ADMIN_DATABASE_URL });
    try { await setupPool.query(CLASSPILOT_TOOLS_SQL); } finally { await setupPool.end(); }
  } else await database.pool.query(CLASSPILOT_TOOLS_SQL);
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
    secondStudentId = (await storage.createStudent({ schoolId: school.id, firstName: "Synthetic", lastName: "Second", status: "active" })).id;
    const group = await storage.createGroup({ schoolId: school.id, teacherId: owner.id, name: "Synthetic course", googleClassroomCourseId: "synthetic-course" });
    await storage.addGroupStudents(group.id, [student.id, secondStudentId]);
    session = await storage.createTeachingSession({ schoolId: school.id, groupId: group.id, teacherId: owner.id });
    for (const currentStudentId of [student.id, secondStudentId]) {
      const deviceId = randomUUID();
      await storage.createDevice({ schoolId: school.id, deviceId, classId: "default", deviceName: "Synthetic Chromebook" });
      const studentSession = await storage.startStudentSessionWithReplacements(school.id, currentStudentId, deviceId, { authKind: "managed_profile" });
      studentBindings.set(currentStudentId, { studentSessionId: studentSession.session.id, deviceId });
      const capabilities = ["scopedAuthorityChecksV1", "preciseRestrictionResourcesV1", "classroomFocusScopeV1"];
      await realtime.writeClasspilotRealtimeStatus({ schoolId: school.id, studentId: currentStudentId, studentSessionId: studentSession.session.id,
        deviceId, heartbeatId: randomUUID(), observedAt: Date.now(), acceptedCapabilities: capabilities, extensionCapabilities: capabilities });
    }
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

test("Flight Path feature advertisement follows the current school's Classroom runtime gate and keeps its off shape", async () => {
  const keys = ["CLASSPILOT_PROTOCOL_V3_ENABLED", "CLASSPILOT_CAP_SCOPED_AUTHORITY_CHECKS_V1", "CLASSPILOT_CAP_PRECISE_RESTRICTION_RESOURCES_V1",
    "CLASSPILOT_CAP_CLASSROOM_FOCUS_SCOPE_V1", "CLASSPILOT_CAPABILITY_ROLLOUTS_JSON", "CLASSPILOT_SHARED_TEACHING_RESOURCES_MODE",
    "CLASSPILOT_SHARED_TEACHING_RESOURCES_SCHOOL_IDS"];
  const previous = new Map(keys.map(key => [key, process.env[key]]));
  const getPaths = async (schoolId: string, actor = owner) => {
    const response = await fetch(`${origin}/api/flight-paths`, { headers: { "x-school-id": schoolId,
      authorization: `Bearer ${signUserToken({ userId: actor.id, email: actor.email, isSuperAdmin: false })}` } });
    return { status: response.status, body: await response.json() as { flightPaths?: unknown[]; features?: Record<string, boolean> } };
  };
  try {
    process.env.CLASSPILOT_SHARED_TEACHING_RESOURCES_MODE = "off";
    delete process.env.CLASSPILOT_SHARED_TEACHING_RESOURCES_SCHOOL_IDS;
    delete process.env.CLASSPILOT_CAPABILITY_ROLLOUTS_JSON;
    process.env.CLASSPILOT_CAP_CLASSROOM_FOCUS_SCOPE_V1 = "false";
    process.env.CLASSPILOT_CAP_PRECISE_RESTRICTION_RESOURCES_V1 = "false";
    const off = await getPaths(school.id);
    assert.equal(off.status, 200);
    assert.deepEqual(Object.keys(off.body), ["flightPaths"], "all feature gates off preserves the existing response shape");
    process.env.CLASSPILOT_CAP_PRECISE_RESTRICTION_RESOURCES_V1 = "true";
    const preciseOnly = await getPaths(school.id);
    assert.deepEqual(preciseOnly.body.features, { preciseRestrictionResources: true });
    process.env.CLASSPILOT_CAP_CLASSROOM_FOCUS_SCOPE_V1 = "true";
    process.env.CLASSPILOT_CAPABILITY_ROLLOUTS_JSON = JSON.stringify({ scopedAuthorityChecksV1: { mode: "on" },
      preciseRestrictionResourcesV1: { mode: "on" }, classroomFocusScopeV1: { mode: "on", schoolIds: [school.id] } });
    assert.equal((await getPaths(school.id)).body.features?.studentClassroomAccess, true);
    assert.equal((await getPaths(otherSchool.id)).body.features?.studentClassroomAccess, undefined, "an excluded school cannot borrow another school's flag");
    assert.equal((await getPaths(otherSchool.id, otherTeacher)).status, 403, "school membership remains required");
    process.env.CLASSPILOT_SHARED_TEACHING_RESOURCES_MODE = "on";
    assert.deepEqual((await getPaths(school.id)).body.features,
      { sharedTeachingResources: true, preciseRestrictionResources: true, studentClassroomAccess: true });
    process.env.CLASSPILOT_CAP_CLASSROOM_FOCUS_SCOPE_V1 = "false";
    assert.deepEqual((await getPaths(school.id)).body.features, { sharedTeachingResources: true, preciseRestrictionResources: true });
  } finally {
    for (const [key, value] of previous) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
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

test("all-course Classroom access preview keeps exact class ownership and rejects browser-authored scopes", async () => {
  const path = "/api/classpilot/commands/classroom-access/preview";
  const body = { ...request(), mode: "focus" };
  assert.equal((await preview(null, body, school.id, path)).status, 401);
  assert.equal((await preview(otherTeacher, body, school.id, path)).status, 404);
  assert.equal((await preview(observer, body, school.id, path)).status, 404);
  for (const changed of [{ targetStudentIds: [] }, { targetStudentIds: [studentId, studentId] },
    { targetStudentIds: [foreignStudentId] }, { targetScope: "class" }, { courseId: "teacher-selected-course" },
    { classroomAccessV1: { payloadByStudent: { [studentId]: { allowedDomains: ["google.com"] } } } }]) {
    assert.equal((await preview(owner, { ...body, ...changed }, school.id, path)).status, 400);
  }
  const disabled = process.env.CLASSPILOT_CAP_CLASSROOM_FOCUS_SCOPE_V1;
  process.env.CLASSPILOT_CAP_CLASSROOM_FOCUS_SCOPE_V1 = "false";
  try { assert.equal((await preview(owner, body, school.id, path)).body.code, "CLASSROOM_FOCUS_DISABLED"); }
  finally { process.env.CLASSPILOT_CAP_CLASSROOM_FOCUS_SCOPE_V1 = disabled; }
});

test("real command persistence keeps each student's compiled materials separate and freezes reviewed path changes", async () => {
  const { CLASSROOM_FOCUS_BASE_DOMAINS } = await import("../src/services/classroomFocusScope.js");
  const { previewStudentClassroomAccess } = await import("../src/services/classpilotStudentClassroomAccess.js");
  const { executeClasspilotCommand } = await import("../src/services/classpilotCommandDispatcher.js");
  const { publicClasspilotCommand } = await import("../src/services/classpilotCommandPublic.js");
  const { GOOGLE_ROSTER_SCOPES } = await import("../src/services/googleRosterScopes.js");
  const { STUDENT_CLASSROOM_ACCESS_SCOPES, invalidateStudentClassroomAccessApproval, studentClassroomAccessApprovalKeyForSchool } = await import("../src/services/googleClassroomAccess.js");
  const priorAccount = { email: process.env.GOOGLE_ROSTER_SA_EMAIL, clientId: process.env.GOOGLE_ROSTER_SA_CLIENT_ID, key: process.env.GOOGLE_ROSTER_SA_KEY_JSON };
  try {
  delete process.env.GOOGLE_ROSTER_SA_KEY_JSON;
  process.env.GOOGLE_ROSTER_SA_EMAIL = "synthetic-classroom@fixture.invalid";
  process.env.GOOGLE_ROSTER_SA_CLIENT_ID = "synthetic-classroom-client";
  const sources = [studentId, secondStudentId].map((id, index) => ({ studentId: id, courseCount: index + 1, itemCount: 1, linkCount: 1,
    approvalKey: "a".repeat(64), scope: { schemaVersion: 1 as const, sourceRevision: String(index + 1).repeat(64),
      allowedDomains: [...CLASSROOM_FOCUS_BASE_DOMAINS, `student-${index + 1}-work.example`], resources: [] } }));
  await inTenant({ schoolId: school.id }, async () => {
    const approval = { schemaVersion: 1 as const, approvalId: randomUUID(), approvedByUserId: owner.id, approvedAt: new Date().toISOString(),
      schoolId: school.id, domain: school.domain!, serviceAccountClientId: "synthetic-classroom-client", delegatedAdminEmail: `admin@${school.domain}` };
    await storage.upsertGoogleRosterConnector(school.id, { domain: school.domain!, delegatedAdminEmail: approval.delegatedAdminEmail,
      serviceAccountClientId: approval.serviceAccountClientId, status: "verified", approvedScopes: [...new Set<string>([...GOOGLE_ROSTER_SCOPES, ...STUDENT_CLASSROOM_ACCESS_SCOPES])], classroomAccessApproval: approval });
    invalidateStudentClassroomAccessApproval(school.id);
    const approvalKey = await studentClassroomAccessApprovalKeyForSchool(school.id);
    assert.ok(approvalKey);
    sources.forEach(source => { source.approvalKey = approvalKey; });
    const path = await storage.createFlightPath({ schoolId: school.id, teacherId: owner.id, flightPathName: "Synthetic Classroom materials", allowedDomains: ["classroom.google.com"], resources: [] });
    const reviewRequest = { schoolId: school.id, actorId: owner.id, mode: "flight-path" as const, authority: { teachingSessionId: session.id },
      targetStudentIds: [studentId, secondStudentId], flightPathId: path.id, expectedFlightPathUpdatedAt: path.updatedAt.toISOString() };
    const resolver = async () => sources;
    const targets = reviewRequest.targetStudentIds.map(id => ({ studentId: id, studentName: "Synthetic", ...studentBindings.get(id)!, available: true, stateAuthorized: true }));
    const review = await previewStudentClassroomAccess(reviewRequest, { resolveSources: resolver });
    const result = await executeClasspilotCommand({ schoolId: school.id, actorId: owner.id, teachingSessionId: session.id, targetScope: "students",
      commandType: "apply-flight-path", rawCommandPayload: { flightPathId: path.id, expectedFlightPathUpdatedAt: path.updatedAt.toISOString(), classroomAccess: { reviewToken: review.reviewToken } },
      targets, resolveStudentClassroomSources: resolver });
    for (const [index, id] of reviewRequest.targetStudentIds.entries()) {
      const state = await storage.getClasspilotStudentControlState(school.id, id);
      assert.ok(state);
      const raw = state.desiredState as { restrictions: { flightPath: { allowedDomains: string[]; classroomMaterials: { studentId: string } } } };
      assert.equal(raw.restrictions.flightPath.allowedDomains.includes(`student-${index + 1}-work.example`), true);
      assert.equal(raw.restrictions.flightPath.allowedDomains.includes(`student-${index === 0 ? 2 : 1}-work.example`), false);
      assert.equal(raw.restrictions.flightPath.classroomMaterials.studentId, id);
    }
    const history = JSON.stringify(publicClasspilotCommand(result.command));
    assert.equal(history.includes("classroomAccessV1"), false);
    assert.equal(history.includes("classroomMaterials"), false);
    assert.equal(history.includes("student-2-work.example"), false);
    const before = await storage.getRecentClasspilotCommands(school.id, owner.id, session.id, 100);
    const staleReview = await previewStudentClassroomAccess(reviewRequest, { resolveSources: resolver });
    await assert.rejects(executeClasspilotCommand({ schoolId: school.id, actorId: owner.id, teachingSessionId: session.id, targetScope: "students",
      commandType: "apply-flight-path", rawCommandPayload: { flightPathId: path.id, expectedFlightPathUpdatedAt: path.updatedAt.toISOString(), classroomAccess: { reviewToken: staleReview.reviewToken } }, targets,
      resolveStudentClassroomSources: async () => {
        const { db } = await import("../src/db.js");
        const { sql } = await import("drizzle-orm");
        await db.execute(sql`UPDATE flight_paths SET updated_at=updated_at+interval '1 second', allowed_domains=ARRAY['classroom.google.com','changed.example'] WHERE school_id=${school.id} AND id=${path.id}`);
        return sources;
      } }), (error: unknown) => !!error && typeof error === "object" && "code" in error && error.code === "FLIGHT_PATH_REVIEW_STALE");
    assert.equal((await storage.getRecentClasspilotCommands(school.id, owner.id, session.id, 100)).length, before.length, "locked path drift rolls back command creation");
    const { studentClassroomAccessPublicationApproved, studentClassroomAccessPublicationApprovedFromCache,
      studentClassroomAccessApprovalForState } = await import("../src/services/classpilotStudentClassroomAccess.js");
    assert.equal(await studentClassroomAccessPublicationApproved(school.id, approvalKey), true);
    assert.equal(studentClassroomAccessPublicationApprovedFromCache(school.id, approvalKey), true);
    const { WebSocket, WebSocketServer } = await import("ws");
    const { registerWsClient, authenticateWsClient, removeWsClient, sendToStudentBindingLocal } = await import("../src/realtime/ws-broadcast.js");
    const { serializeClasspilotStudentControlState } = await import("../src/services/classpilotClassroomState.js");
    const { classpilotClassroomStatePushFrame } = await import("../src/services/classpilotControlStateFrame.js");
    const wsServer = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await once(wsServer, "listening");
    const address = wsServer.address();
    assert.ok(address && typeof address !== "string");
    const connection = once(wsServer, "connection");
    const wsClient = new WebSocket(`ws://127.0.0.1:${address.port}`);
    await once(wsClient, "open");
    const [socket] = await connection;
    const binding = { schoolId: school.id, studentId, ...studentBindings.get(studentId)! };
    registerWsClient(socket);
    authenticateWsClient(socket, { role: "student", ...binding, acceptedCapabilities: ["scopedAuthorityChecksV1", "preciseRestrictionResourcesV1", "classroomFocusScopeV1"] });
    const storedForWire = await storage.getClasspilotStudentControlState(school.id, studentId);
    assert.ok(storedForWire);
    const wire = classpilotClassroomStatePushFrame({ type: "classroom-state-sync", binding: { ...binding, controlRevision: storedForWire.revision },
      classroomState: serializeClasspilotStudentControlState(storedForWire) });
    const privateTarget = { ...binding, requiredStudentClassroomApprovalKey: approvalKey };
    try {
      const received = once(wsClient, "message");
      assert.equal(sendToStudentBindingLocal(privateTarget, wire), true);
      const [message] = await received;
      assert.equal(message.toString().includes(approvalKey), false, "approval keys are server transport metadata only");
      assert.equal(message.toString().includes("classroomMaterials"), false);
      await storage.updateGoogleRosterConnector(school.id, { classroomAccessApproval: null });
      invalidateStudentClassroomAccessApproval(school.id);
      assert.equal(studentClassroomAccessPublicationApprovedFromCache(school.id, approvalKey), false, "invalidation immediately fences delayed publications");
      assert.equal(sendToStudentBindingLocal(privateTarget, wire), false, "a queued snapshot cannot reach a socket after approval invalidation");
      assert.equal(await studentClassroomAccessPublicationApproved(school.id, approvalKey), false);
      await storage.updateGoogleRosterConnector(school.id, { classroomAccessApproval: { ...approval, approvalId: randomUUID() } });
      invalidateStudentClassroomAccessApproval(school.id);
      const replacementKey = await studentClassroomAccessApprovalKeyForSchool(school.id);
      assert.ok(replacementKey);
      assert.notEqual(replacementKey, approvalKey);
      assert.equal(await studentClassroomAccessPublicationApproved(school.id, approvalKey), false, "reapproval cannot resurrect queued old permissions");
      assert.equal(await studentClassroomAccessPublicationApproved(school.id, replacementKey), true);
      assert.equal(sendToStudentBindingLocal(privateTarget, wire), false, "new approval cannot revive the queued old snapshot");
      const oldState = await storage.getClasspilotStudentControlState(school.id, studentId);
      assert.ok(oldState);
      assert.equal(await studentClassroomAccessApprovalForState(oldState), false, "old stored policy cannot resume after connector reapproval");
    } finally {
      removeWsClient(socket); wsClient.terminate(); socket.terminate();
      await new Promise<void>(resolve => wsServer.close(() => resolve()));
    }
  });
  } finally {
    for (const [key, value] of [["GOOGLE_ROSTER_SA_EMAIL", priorAccount.email], ["GOOGLE_ROSTER_SA_CLIENT_ID", priorAccount.clientId], ["GOOGLE_ROSTER_SA_KEY_JSON", priorAccount.key]] as const) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
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
