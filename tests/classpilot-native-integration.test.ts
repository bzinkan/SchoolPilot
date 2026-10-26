import assert from "node:assert/strict";
import { after, before, mock, test } from "node:test";
import { randomUUID, createHmac } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import express, { type Response } from "express";
import { Pool } from "pg";
import sharp from "sharp";
import { createClient } from "redis";
import { setTimeout as pause } from "node:timers/promises";
import type { NativeCaptureGrant, NativeStoredImage, NativeViewerLease } from "../src/services/classpilotNativeStore.js";

process.env.NODE_ENV = "test";
process.env.SCHEDULER_ENABLED = "false";
process.env.COOKIE_NAME = "schoolpilot.sid";
assert.ok(process.env.ADMIN_DATABASE_URL && process.env.TEST_REDIS_URL, "Explicit isolated Postgres and Redis fixtures required");
for (const connection of [process.env.ADMIN_DATABASE_URL, process.env.TEST_REDIS_URL]) {
  assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(new URL(connection).hostname), "Native integration refuses remote services");
}
const tag = `native-${Date.now()}-${randomUUID().slice(0, 8)}`;
process.env.REDIS_PREFIX = tag;
process.env.REDIS_URL = "";
const originalSetInterval = globalThis.setInterval;
globalThis.setInterval = ((...args: Parameters<typeof originalSetInterval>) => {
  const timer = originalSetInterval(...args); timer.unref?.(); return timer;
}) as typeof setInterval;
await import("../dist/middleware/rateLimiter.js");
process.env.REDIS_URL = process.env.TEST_REDIS_URL;
const { default: db, pool, sessionPool } = await import("../dist/db.js");
const storage = await import("../dist/services/storage.js");
const schema = await import("../dist/schema/index.js");
const { runWithTenantContext, getOwnedTenantStore } = await import("../dist/middleware/tenantContext.js");
const { createApp } = await import("../dist/app.js");
const { signUserToken } = await import("../dist/services/jwt.js");
const { hashClassPilotPin } = await import("../dist/services/classpilotPins.js");
const { subscribeWS, disposeWSRedis } = await import("../dist/realtime/ws-redis.js");
const { classpilotNativeStore, ClasspilotNativeStore } = await import("../dist/services/classpilotNativeStore.js");
const { ClasspilotNativeError } = await import("../dist/services/classpilotNativeProtocol.js");
const { schedulerPool, schedulerLockPool } = await import("../dist/services/schedulerDb.js");
const { default: errorMonitor } = await import("../dist/services/errorMonitor.js");
const { CLASSPILOT_NATIVE_VISIBILITY_SQL } = await import("../dist/db/classpilotNativeVisibilityMigration.js");
const { CLASSPILOT_DASHBOARD_APPEARANCE_SQL } = await import("../dist/db/classpilotDashboardAppearanceMigration.js");
const { CLASSPILOT_TEACHER_PREFERENCES_SQL } = await import("../dist/db/classpilotTeacherPreferencesMigration.js");
const fixture = new Pool({ connectionString: process.env.ADMIN_DATABASE_URL });
let server: Server | undefined;
let base = "", schoolId = "", otherSchoolId = "", studentId = "", secondStudentId = "", teachingSessionId = "";
let adminToken = "", teacherToken = "", otherTeacherToken = "", adminCookie = "", adminId = "", teacherId = "", teacherEmail = "";
const inSchool = <T>(action: () => Promise<T>) => runWithTenantContext({ schoolId }, action);
type Reply = { status: number; body: any; headers: Headers };
const sessionRevisions = new Map<string, number>();
async function request(path: string, method = "GET", body?: unknown, token?: string, extras: Record<string, string> = {}): Promise<Reply> {
  if (path.startsWith("/policy?") && !path.includes("bindingRevision=")) path += `&bindingRevision=${sessionRevisions.get(token ?? "") ?? 1}`;
  const response = await fetch(`${base}/api/classpilot/native${path}`, { method,
    headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...(token ? { authorization: `Bearer ${token}` } : {}), ...extras },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const text = await response.text();
  const parsed = text ? JSON.parse(text) : {};
  if (response.ok && parsed.sessionCredential) sessionRevisions.set(parsed.sessionCredential, parsed.bindingRevision);
  else if (response.ok && token && parsed.bindingRevision) sessionRevisions.set(token, parsed.bindingRevision);
  return { status: response.status, body: parsed, headers: response.headers };
}
const staffHeaders = () => ({ "X-School-Id": schoolId });
const tiles = (extra = {}) => request("/tiles/desktop", "POST", { teachingSessionId, studentIds: [studentId], ...extra }, teacherToken, staffHeaders());
async function installation() {
  const issued = await request("/enrollment-tokens", "POST", {}, adminToken, staffHeaders());
  assert.equal(issued.status, 201, JSON.stringify(issued.body));
  const enrolled = await request("/enroll", "POST", { enrollmentToken: issued.body.enrollmentToken, clientVersion: "test-1" });
  assert.equal(enrolled.status, 201, JSON.stringify(enrolled.body));
  return { ...enrolled.body, enrollmentToken: issued.body.enrollmentToken };
}
async function bind(credential: string, id = studentId, nonce = randomUUID()) {
  return request("/sessions", "POST", { identifier: id, pin: "1234", osSessionNonce: nonce }, credential);
}
async function upload(token: string, metadata: unknown, jpeg: Buffer) {
  const form = new FormData();
  form.append("metadata", JSON.stringify(metadata));
  form.append("image", new Blob([jpeg], { type: "image/jpeg" }), "observation.jpg");
  const response = await fetch(`${base}/api/classpilot/native/observations`, { method: "POST", headers: { authorization: `Bearer ${token}` }, body: form });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : {} };
}

before(async () => {
  await fixture.query(`BEGIN; ${CLASSPILOT_TEACHER_PREFERENCES_SQL} COMMIT;`);
  await fixture.query(`BEGIN; ${CLASSPILOT_DASHBOARD_APPEARANCE_SQL} COMMIT;`);
  await fixture.query(`BEGIN; ${CLASSPILOT_NATIVE_VISIBILITY_SQL} COMMIT;`);
  const school = await storage.createSchool({ name: tag, slug: tag, domain: `${tag}.example.edu`, status: "active", planStatus: "active", schoolTimezone: "UTC" });
  schoolId = school.id;
  const other = await storage.createSchool({ name: `${tag}-other`, slug: `${tag}-other`, domain: `${tag}-other.example.edu`, status: "active", planStatus: "active" });
  otherSchoolId = other.id;
  process.env.CLASSPILOT_NATIVE_VISIBILITY_MODE = "on";
  process.env.CLASSPILOT_NATIVE_VISIBILITY_SCHOOL_IDS = `${schoolId},${otherSchoolId}`;
  await inSchool(() => storage.upsertSettings(schoolId, { schoolName: tag, schoolTimezone: "UTC", wsSharedKey: tag,
    enableTrackingHours: true, trackingStartTime: "00:00", trackingEndTime: "23:59",
    trackingDays: ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"], afterHoursMode: "off" }));
  await storage.createProductLicense({ schoolId, product: "CLASSPILOT", status: "active" });
  await storage.createProductLicense({ schoolId: otherSchoolId, product: "CLASSPILOT", status: "active" });
  const admin = await storage.createUser({ email: `admin@${tag}.example.edu`, firstName: "Synthetic", lastName: "Admin" });
  adminId = admin.id;
  const teacher = await storage.createUser({ email: `teacher@${tag}.example.edu`, firstName: "Synthetic", lastName: "Teacher" });
  teacherId = teacher.id; teacherEmail = teacher.email;
  const outsider = await storage.createUser({ email: `outsider@${tag}-other.example.edu`, firstName: "Synthetic", lastName: "Outsider" });
  await inSchool(() => storage.createMembership({ userId: admin.id, schoolId, role: "school_admin", status: "active" }));
  await inSchool(() => storage.createMembership({ userId: teacher.id, schoolId, role: "teacher", status: "active" }));
  await runWithTenantContext({ schoolId: otherSchoolId }, () => storage.createMembership({ userId: outsider.id, schoolId: otherSchoolId, role: "teacher", status: "active" }));
  adminToken = signUserToken({ userId: admin.id, email: admin.email, authVersion: admin.authVersion });
  teacherToken = signUserToken({ userId: teacher.id, email: teacher.email, authVersion: teacher.authVersion });
  otherTeacherToken = signUserToken({ userId: outsider.id, email: outsider.email, authVersion: outsider.authVersion });
  const pinHash = await hashClassPilotPin("1234");
  const students = await inSchool(() => db.insert(schema.students).values([1, 2].map(n => ({ schoolId,
    email: `${tag}-${n}@example.edu`, firstName: "Synthetic", lastName: `Student ${n}`, classpilotPinHash: pinHash,
    status: "active", studentIdNumber: `${tag}-${n}` }))).returning());
  studentId = students[0]!.id; secondStudentId = students[1]!.id;
  const session = await inSchool(async () => {
    const group = await storage.createGroup({ schoolId, teacherId: teacher.id, name: tag, groupType: "admin_class", status: "active" });
    await db.insert(schema.groupStudents).values(students.map(s => ({ groupId: group.id, studentId: s.id })));
    return storage.createTeachingSession({ groupId: group.id, teacherId: teacher.id, sessionMode: "live" });
  });
  teachingSessionId = session.id;
  const sid = randomUUID(), expires = new Date(Date.now() + 3_600_000);
  await fixture.query("INSERT INTO session(sid,sess,expire) VALUES($1,$2,(now() AT TIME ZONE 'UTC') + interval '1 hour')", [sid, JSON.stringify({
    userId: admin.id, authVersion: admin.authVersion, role: "school_admin", lastActivityAt: Date.now(), csrfToken: "synthetic-native-csrf",
    cookie: { originalMaxAge: 3_600_000, expires: expires.toISOString(), httpOnly: true, path: "/" } })]);
  adminCookie = `schoolpilot.sid=${encodeURIComponent(`s:${sid}.${createHmac("sha256", process.env.SESSION_SECRET!).update(sid).digest("base64").replace(/=+$/, "")}`)}`;
  await subscribeWS(() => undefined);
  server = createServer(createApp());
  await new Promise<void>(resolve => server!.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  if (server) await new Promise<void>(resolve => { server!.close(() => resolve()); server!.closeAllConnections(); });
  await disposeWSRedis();
  await errorMonitor.disposeAndWait();
  // Retire this fixture's identities; no browser identities or production data exist in this database.
  if (schoolId) await fixture.query("UPDATE classpilot_native_sessions SET ended_at=now(),end_reason='test_cleanup' WHERE school_id=$1 AND ended_at IS NULL", [schoolId]);
  if (schoolId) await fixture.query("UPDATE classpilot_native_installations SET revoked_at=now() WHERE school_id=$1", [schoolId]);
  await fixture.end();
  await Promise.all([pool.end(), sessionPool.end(), schedulerPool.end(), schedulerLockPool.end()]);
  globalThis.setInterval = originalSetInterval;
});

test("real native routes preserve browser isolation and enforce lifecycle, viewer, image and policy fences", async t => {
  const native = await installation();
  const nonce = randomUUID();
  let session = (await bind(native.installationCredential, studentId, nonce)).body;
  assert.ok(session.sessionCredential);
  let generation = randomUUID();
  let target: any, viewer = randomUUID(), grant: any;
  const jpeg = await sharp({ create: { width: 320, height: 180, channels: 3, background: "#1976d2" } }).jpeg().toBuffer();
  await t.test("one-use enrollment, strict credential purpose, cookie bypass only for native clients", async () => {
    assert.equal((await request("/enroll", "POST", { enrollmentToken: native.enrollmentToken, clientVersion: "test-1" })).status, 401);
    assert.equal((await bind(session.sessionCredential)).status, 401);
    assert.equal((await request(`/policy?sourceGeneration=${generation}`, "GET", undefined, teacherToken)).status, 401);
    const cookieRejected = await request("/enrollment-tokens", "POST", {}, undefined, { ...staffHeaders(), cookie: adminCookie });
    assert.equal(cookieRejected.status, 403, JSON.stringify(cookieRejected.body));
    assert.equal((await request("/enrollment-tokens", "POST", {}, undefined, { ...staffHeaders(), cookie: adminCookie, "X-CSRF-Token": "synthetic-native-csrf" })).status, 201);
    assert.equal((await request("/session/renew", "POST", { osSessionNonce: nonce }, session.sessionCredential, { cookie: adminCookie })).status, 200);
    assert.equal((await request("/session/renew", "POST", { osSessionNonce: randomUUID() }, session.sessionCredential)).status, 401);
    assert.equal((await fixture.query("SELECT count(*)::int AS count FROM student_sessions WHERE student_id IN ($1,$2)", [studentId, secondStudentId])).rows[0].count, 0);
  });
  await t.test("native-only roster becomes available without authorizing unattended capture", async () => {
    assert.equal((await tiles()).body.tiles[0].state, "permission_required");
    const initial = await request(`/policy?sourceGeneration=${generation}`, "GET", undefined, session.sessionCredential);
    assert.equal(initial.status, 200, JSON.stringify(initial.body)); assert.equal(initial.body.captureAllowed, false);
    const metadata = await tiles();
    assert.equal(metadata.status, 200, JSON.stringify(metadata.body)); assert.equal(metadata.body.tiles[0].state, "available");
    target = { studentId, sourceRef: metadata.body.tiles[0].sourceRef, bindingRevision: metadata.body.tiles[0].bindingRevision };
    assert.equal(metadata.body.tiles[0].screenshot, undefined);
    assert.equal((await request(`/observation-leases/${viewer}`, "PUT", { teachingSessionId, targets: [] }, teacherToken, staffHeaders())).status, 400);
    assert.equal((await request(`/observation-leases/${viewer}`, "PUT", { supervisionContextId: randomUUID(), targets: [target] }, teacherToken, staffHeaders())).status, 409);
    assert.equal((await request(`/observation-leases/${viewer}`, "PUT", { teachingSessionId, targets: [target] }, otherTeacherToken, { "X-School-Id": otherSchoolId })).status, 403);
    const lease = await request(`/observation-leases/${viewer}`, "PUT", { teachingSessionId, targets: [target] }, teacherToken, staffHeaders());
    assert.equal(lease.status, 200, JSON.stringify(lease.body)); assert.ok(lease.body.serverTime);
    grant = (await request(`/policy?sourceGeneration=${generation}`, "GET", undefined, session.sessionCredential)).body;
    assert.equal(grant.captureAllowed, true); assert.ok(grant.expiresInSeconds <= 45);
  });
  await t.test("binary JPEG needs exact grant, sequence, viewer and binding; metadata is pixel-free", async () => {
    // Match System.Text.Json's DateTimeOffset precision/offset and the native
    // Win32 foreground identity. A null-only fixture hid a client prefix mismatch.
    const capturedAt = new Date().toISOString().replace("Z", "0000+00:00");
    const foregroundApplication = { id: "win32.syntheticcontent", displayName: "SyntheticContent", observedAt: capturedAt };
    const metadata = { grantId: grant.grantId, sourceGeneration: generation, sequence: 1, capturedAt, foregroundApplication };
    const accepted = await upload(session.sessionCredential, metadata, jpeg);
    assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
    assert.equal((await upload(session.sessionCredential, metadata, jpeg)).status, 409);
    const tooWide = await sharp({ create: { width: 1281, height: 100, channels: 3, background: "#fff" } }).jpeg().toBuffer();
    assert.equal((await upload(session.sessionCredential, metadata, tooWide)).status, 400);
    assert.equal((await upload(session.sessionCredential, { ...metadata, windowTitle: "Must never enter storage" }, jpeg)).status, 400);
    assert.equal((await tiles()).body.tiles[0].screenshot, undefined);
    const selected = await tiles({ viewerInstanceId: viewer, selectedSources: [target] });
    assert.equal(selected.body.tiles[0].sequence, 1);
    assert.deepEqual(selected.body.tiles[0].foregroundApplication, foregroundApplication);
    assert.ok(Date.parse(selected.body.tiles[0].expiresAt) <= Date.parse(capturedAt) + 45_000);
    assert.match(selected.body.tiles[0].screenshot, /^data:image\/jpeg;base64,/);
    assert.equal(selected.headers.get("cache-control"), "no-store");
    assert.equal((await tiles({ viewerInstanceId: randomUUID(), selectedSources: [target] })).body.tiles[0].screenshot, undefined);
    assert.equal((await upload(session.sessionCredential, { ...metadata, sequence: 2, capturedAt: new Date(Date.now() - 6000).toISOString() }, jpeg)).status, 409);
  });
  await t.test("release tombstones late renewals and invalidates uploads and reads immediately", async () => {
    const checkedViewer = await classpilotNativeStore.getViewer(schoolId, teacherId, viewer);
    const checkedGrant = await classpilotNativeStore.getGrant(schoolId, session.sessionCredential.split(".")[3], grant.grantId);
    const checkedImage = await classpilotNativeStore.readImage(schoolId, target.sourceRef);
    assert.ok(checkedViewer && checkedGrant && checkedImage);
    assert.equal((await request(`/observation-leases/${viewer}`, "DELETE", undefined, teacherToken, staffHeaders())).status, 204);
    // Simulate release arriving after DB authorization but before Redis publication.
    await assert.rejects(classpilotNativeStore.saveGrant(checkedGrant, [checkedViewer]), { code: "NATIVE_GRANT_STALE" });
    await assert.rejects(classpilotNativeStore.saveImage({ ...checkedImage, sequence: 100 }, Date.now() + 60_000, [checkedViewer]), { code: "NATIVE_GRANT_STALE" });
    assert.equal((await request(`/observation-leases/${viewer}`, "PUT", { teachingSessionId, targets: [target] }, teacherToken, staffHeaders())).status, 409);
    assert.equal((await tiles({ viewerInstanceId: viewer, selectedSources: [target] })).body.tiles[0].screenshot, undefined);
    assert.equal((await request(`/policy?sourceGeneration=${generation}`, "GET", undefined, session.sessionCredential)).body.captureAllowed, false);
    const rejected = await upload(session.sessionCredential, { grantId: grant.grantId, sourceGeneration: generation, sequence: 3,
      capturedAt: new Date().toISOString(), foregroundApplication: null }, jpeg);
    assert.equal(rejected.status, 409);
  });
  await t.test("local Stop advances binding revision and requires a new viewer target", async () => {
    const oldRevision = sessionRevisions.get(session.sessionCredential)!;
    assert.equal((await request("/observations", "DELETE", { bindingRevision: oldRevision }, session.sessionCredential)).status, 204);
    assert.equal((await tiles()).body.tiles[0].state, "permission_required");
    assert.equal((await request(`/policy?sourceGeneration=${generation}&bindingRevision=${oldRevision}`, "GET", undefined, session.sessionCredential)).status, 409);
    assert.equal((await request("/session/renew", "POST", { osSessionNonce: nonce }, session.sessionCredential)).status, 200);
    const policy = await request(`/policy?sourceGeneration=${generation}`, "GET", undefined, session.sessionCredential);
    assert.ok(policy.body.bindingRevision > target.bindingRevision); assert.equal(policy.body.captureAllowed, false);
    assert.equal((await request("/observations", "DELETE", { bindingRevision: oldRevision }, session.sessionCredential)).status, 409);
    assert.equal((await request(`/policy?sourceGeneration=${randomUUID()}&bindingRevision=${oldRevision}`, "GET", undefined, session.sessionCredential)).status, 409);
    assert.equal((await tiles()).body.tiles[0].state, "available", "Delayed source operations must not clear the newly selected source");
    assert.equal((await request(`/observation-leases/${randomUUID()}`, "PUT", { teachingSessionId, targets: [target] }, teacherToken, staffHeaders())).status, 403);
  });
  await t.test("current monitoring hours, staff membership and credential version gate existing grants", async () => {
    const row = (await tiles()).body.tiles[0];
    target = { studentId, sourceRef: row.sourceRef, bindingRevision: row.bindingRevision }; viewer = randomUUID();
    assert.equal((await request(`/observation-leases/${viewer}`, "PUT", { teachingSessionId, targets: [target] }, teacherToken, staffHeaders())).status, 200);
    assert.equal((await request(`/policy?sourceGeneration=${generation}`, "GET", undefined, session.sessionCredential)).body.captureAllowed, true);
    await fixture.query("UPDATE settings SET enable_tracking_hours=false WHERE school_id=$1", [schoolId]);
    assert.equal((await request(`/policy?sourceGeneration=${generation}`, "GET", undefined, session.sessionCredential)).body.captureAllowed, false);
    await fixture.query("UPDATE settings SET enable_tracking_hours=true WHERE school_id=$1", [schoolId]);
    await fixture.query("UPDATE school_memberships SET status='inactive' WHERE school_id=$1 AND user_id=$2", [schoolId, teacherId]);
    assert.equal((await request(`/policy?sourceGeneration=${generation}`, "GET", undefined, session.sessionCredential)).body.captureAllowed, false);
    await fixture.query("UPDATE school_memberships SET status='active' WHERE school_id=$1 AND user_id=$2", [schoolId, teacherId]);
    await fixture.query("UPDATE users SET auth_version=auth_version+1 WHERE id=$1", [teacherId]);
    assert.equal((await request(`/policy?sourceGeneration=${generation}`, "GET", undefined, session.sessionCredential)).body.captureAllowed, false);
    assert.equal((await tiles()).status, 401);
    teacherToken = signUserToken({ userId: teacherId, email: teacherEmail, authVersion: 2 });
    viewer = randomUUID();
    assert.equal((await request(`/observation-leases/${viewer}`, "PUT", { teachingSessionId, targets: [target] }, teacherToken, staffHeaders())).status, 200);
    assert.equal((await request(`/policy?sourceGeneration=${generation}`, "GET", undefined, session.sessionCredential)).body.captureAllowed, true);
  });
  await t.test("same installation reauth retires identity; competing installation needs admin revocation", async () => {
    const second = await installation();
    assert.equal((await bind(second.installationCredential)).status, 409);
    const previous = session.sessionCredential;
    session = (await bind(native.installationCredential, secondStudentId)).body;
    assert.equal((await request(`/policy?sourceGeneration=${generation}`, "GET", undefined, previous)).status, 401);
    const available = await bind(second.installationCredential);
    assert.equal(available.status, 201, JSON.stringify(available.body));
    const installationId = second.installationCredential.split(".")[3];
    assert.equal((await request(`/installations/${installationId}`, "DELETE", undefined, adminToken, staffHeaders())).status, 204);
    assert.equal((await request(`/policy?sourceGeneration=${generation}`, "GET", undefined, available.body.sessionCredential)).status, 401);
    session = (await bind(native.installationCredential)).body;
  });
  await t.test("native session expiry and maximum lifetime require fresh PIN without browser mutations", async () => {
    const id = session.sessionCredential.split(".")[3];
    await fixture.query("UPDATE classpilot_native_sessions SET expires_at=now()+interval '20 seconds',absolute_expires_at=now()+interval '30 seconds' WHERE id=$1", [id]);
    const renewed = await request("/session/renew", "POST", { osSessionNonce: (await fixture.query("SELECT os_session_nonce FROM classpilot_native_sessions WHERE id=$1", [id])).rows[0].os_session_nonce }, session.sessionCredential);
    assert.equal(renewed.status, 200); assert.ok(Date.parse(renewed.body.expiresAt) <= Date.parse(renewed.body.absoluteExpiresAt));
    await fixture.query("UPDATE classpilot_native_sessions SET expires_at=now()-interval '1 second' WHERE id=$1", [id]);
    assert.equal((await request(`/policy?sourceGeneration=${generation}`, "GET", undefined, session.sessionCredential)).status, 401);
    const rebound = await bind(native.installationCredential); assert.equal(rebound.status, 201); session = rebound.body;
  });
  await t.test("PIN attempts are limited per installation/student pair without locking another installation", async () => {
    const limited = await installation();
    for (let attempt = 0; attempt < 5; attempt++) {
      assert.equal((await request("/sessions", "POST", { identifier: secondStudentId, pin: "4321", osSessionNonce: randomUUID() }, limited.installationCredential)).status, 401);
    }
    assert.equal((await bind(limited.installationCredential, secondStudentId)).status, 429);
    assert.equal((await bind(limited.installationCredential, studentId)).status, 409,
      "Another student pair remains PIN-valid and is rejected only by its active-installation conflict");
    assert.equal((await request(`/policy?sourceGeneration=${generation}`, "GET", undefined, session.sessionCredential)).status, 200);
    const independentPair = await bind(native.installationCredential, secondStudentId);
    assert.equal(independentPair.status, 201, "A different enrolled installation must retain its independent student PIN budget");
    const returnToFirstStudent = await bind(native.installationCredential);
    assert.equal(returnToFirstStudent.status, 201); session = returnToFirstStudent.body;
  });
  await t.test("PIN rotation and kill switch immediately invalidate current session or image access", async () => {
    await fixture.query("UPDATE students SET classpilot_pin_hash=$2 WHERE id=$1", [studentId, await hashClassPilotPin("9876")]);
    assert.equal((await request(`/policy?sourceGeneration=${generation}`, "GET", undefined, session.sessionCredential)).status, 401);
    assert.equal((await tiles()).body.tiles[0].state, "unbound");
    process.env.CLASSPILOT_NATIVE_VISIBILITY_MODE = "off";
    assert.equal((await tiles()).body.enabled, false);
    assert.equal((await request("/enrollment-tokens", "POST", {}, adminToken, staffHeaders())).status, 404);
    assert.equal((await fixture.query("SELECT count(*)::int AS count FROM student_sessions WHERE student_id IN ($1,$2)", [studentId, secondStudentId])).rows[0].count, 0);
  });
  await t.test("an unavailable shared store has no process-local authority fallback", async () => {
    const unavailable = new ClasspilotNativeStore(async () => undefined, tag);
    await assert.rejects(unavailable.rateLimit(["test"], 5, 1000), { code: "NATIVE_STORE_UNAVAILABLE", status: 503 });
    await assert.rejects(unavailable.getViewer(schoolId, teacherId, randomUUID()), { code: "NATIVE_STORE_UNAVAILABLE", status: 503 });
  });
});

test("native coexistence, independent observers, returning identity and supervision retain exact authority", async t => {
  process.env.CLASSPILOT_NATIVE_VISIBILITY_MODE = "on";
  const native = await installation();
  const bound = await bind(native.installationCredential, secondStudentId);
  assert.equal(bound.status, 201);
  let session = bound.body;
  const originalSession = session.sessionCredential;
  const generation = randomUUID();
  const deviceId = `${tag}-coexisting-browser`;
  await inSchool(() => storage.createDevice({ schoolId, deviceId, classId: "default" }));
  const browser = await inSchool(() => storage.setActiveStudentForDevice(deviceId, secondStudentId));
  const browserSnapshot = (await fixture.query("SELECT * FROM student_sessions WHERE id=$1", [browser.id])).rows[0];
  const deviceSnapshot = (await fixture.query("SELECT * FROM devices WHERE device_id=$1", [deviceId])).rows[0];
  const readTile = (actor: string, extra = {}, context = { teachingSessionId }) => request("/tiles/desktop", "POST",
    { ...context, studentIds: [secondStudentId], ...extra }, actor, staffHeaders());
  const policy = () => request(`/policy?sourceGeneration=${generation}`, "GET", undefined, session.sessionCredential);
  assert.equal((await policy()).body.captureAllowed, false);
  let row = (await readTile(teacherToken)).body.tiles[0];
  let target = { studentId: secondStudentId, sourceRef: row.sourceRef, bindingRevision: row.bindingRevision };
  const teacherViewer = randomUUID(), adminViewer = randomUUID();
  let grant: any;
  const jpeg = await sharp({ create: { width: 320, height: 180, channels: 3, background: "#125240" } }).jpeg().toBuffer();
  const observe = (actor: string, viewer: string, context: Record<string, string> = { teachingSessionId }, revision?: string) =>
    request(`/observation-leases/${viewer}`, "PUT", { ...context, targets: [target] }, actor,
      { ...staffHeaders(), ...(revision === undefined ? {} : { "X-ClassPilot-Context-Authority-Revision": revision }) });
  const supervisor = await storage.createUser({ email: `supervisor@${tag}.example.edu`, firstName: "Synthetic", lastName: "Supervisor" });
  await inSchool(() => storage.createMembership({ userId: supervisor.id, schoolId, role: "teacher", status: "active" }));
  const supervisorToken = signUserToken({ userId: supervisor.id, email: supervisor.email, authVersion: supervisor.authVersion });

  await t.test("only current classroom staff or administrators Observe; releasing one viewer preserves another", async () => {
    assert.equal((await observe(supervisorToken, randomUUID())).status, 403, "Unassigned same-school teacher cannot observe this class");
    assert.equal((await observe(teacherToken, teacherViewer)).status, 200);
    assert.equal((await observe(adminToken, adminViewer)).status, 200, "Administrator Observe must not acquire or replace control");
    const owner = (await fixture.query("SELECT teaching_session_id,supervision_context_id,revision FROM classpilot_student_control_states WHERE school_id=$1 AND student_id=$2", [schoolId, secondStudentId])).rows[0];
    assert.equal(owner.teaching_session_id, teachingSessionId); assert.equal(owner.supervision_context_id, null);
    grant = (await policy()).body; assert.equal(grant.captureAllowed, true);
    assert.equal((await request(`/observation-leases/${teacherViewer}`, "DELETE", undefined, teacherToken, staffHeaders())).status, 204);
    grant = (await policy()).body; assert.equal(grant.captureAllowed, true, "Other authorized observer still requires capture");
    const accepted = await upload(session.sessionCredential, { grantId: grant.grantId, sourceGeneration: generation,
      sequence: 1, capturedAt: new Date().toISOString(), foregroundApplication: null }, jpeg);
    assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
    assert.equal((await readTile(teacherToken, { viewerInstanceId: teacherViewer, selectedSources: [target] })).body.tiles[0].screenshot, undefined);
    assert.match((await readTile(adminToken, { viewerInstanceId: adminViewer, selectedSources: [target] })).body.tiles[0].screenshot, /^data:image\/jpeg/);
    assert.equal((await request(`/observation-leases/${adminViewer}`, "DELETE", undefined, adminToken, staffHeaders())).status, 204);
    assert.equal((await policy()).body.captureAllowed, false);
    assert.deepEqual((await fixture.query("SELECT teaching_session_id,supervision_context_id,revision FROM classpilot_student_control_states WHERE school_id=$1 AND student_id=$2", [schoolId, secondStudentId])).rows[0], owner);
  });

  await t.test("A to B to A cannot revive old credentials, sources or grants and preserves an active browser binding", async () => {
    const third = await inSchool(() => storage.createStudent({ schoolId, firstName: "Synthetic", lastName: "Alternate", status: "active" }));
    await fixture.query("UPDATE students SET classpilot_pin_hash=$2 WHERE id=$1", [third.id, await hashClassPilotPin("1234")]);
    assert.equal((await bind(native.installationCredential, third.id)).status, 201);
    const returned = await bind(native.installationCredential, secondStudentId); assert.equal(returned.status, 201); session = returned.body;
    assert.notEqual(session.sessionCredential, originalSession);
    assert.equal((await request(`/policy?sourceGeneration=${generation}`, "GET", undefined, originalSession)).status, 401);
    assert.equal((await policy()).body.captureAllowed, false);
    row = (await readTile(teacherToken)).body.tiles[0];
    assert.notEqual(row.sourceRef, target.sourceRef); assert.ok(row.bindingRevision > target.bindingRevision);
    const stale = await upload(session.sessionCredential, { grantId: grant.grantId, sourceGeneration: generation,
      sequence: 2, capturedAt: new Date().toISOString(), foregroundApplication: null }, jpeg);
    assert.equal(stale.status, 409); assert.equal(stale.body.code, "NATIVE_GRANT_STALE");
    target = { studentId: secondStudentId, sourceRef: row.sourceRef, bindingRevision: row.bindingRevision };
    assert.deepEqual((await fixture.query("SELECT * FROM student_sessions WHERE id=$1", [browser.id])).rows[0], browserSnapshot);
    assert.deepEqual((await fixture.query("SELECT * FROM devices WHERE device_id=$1", [deviceId])).rows[0], deviceSnapshot);
  });

  await t.test("viewer grants and image expiry cannot exceed known school or license deadlines", async () => {
    const license = await fixture.query("UPDATE product_licenses SET expires_at=now()+interval '15 seconds' WHERE school_id=$1 AND product='CLASSPILOT' RETURNING (extract(epoch from expires_at AT TIME ZONE 'UTC')*1000)::float8 AS deadline", [schoolId]);
    await fixture.query("UPDATE schools SET active_until=now()+interval '25 seconds' WHERE id=$1", [schoolId]);
    const viewer = randomUUID();
    const lease = await observe(teacherToken, viewer); assert.equal(lease.status, 200);
    assert.ok(Date.parse(lease.body.expiresAt) <= license.rows[0].deadline);
    grant = (await policy()).body; assert.equal(grant.captureAllowed, true);
    assert.ok(Date.parse(grant.expiresAt) <= license.rows[0].deadline);
    const accepted = await upload(session.sessionCredential, { grantId: grant.grantId, sourceGeneration: generation,
      sequence: 3, capturedAt: new Date().toISOString(), foregroundApplication: null }, jpeg);
    assert.equal(accepted.status, 200); assert.ok(Date.parse(accepted.body.expiresAt) <= license.rows[0].deadline);
    const school = await fixture.query("UPDATE schools SET active_until=now()+interval '8 seconds' WHERE id=$1 RETURNING (extract(epoch from active_until AT TIME ZONE 'UTC')*1000)::float8 AS deadline", [schoolId]);
    const shortened = await observe(teacherToken, randomUUID()); assert.equal(shortened.status, 200);
    assert.ok(Date.parse(shortened.body.expiresAt) <= school.rows[0].deadline);
    const narrowed = await policy(); assert.ok(Date.parse(narrowed.body.expiresAt) <= school.rows[0].deadline);
    const image = await readTile(teacherToken, { viewerInstanceId: viewer, selectedSources: [target] });
    assert.ok(Date.parse(image.body.tiles[0].expiresAt) <= school.rows[0].deadline);
    await fixture.query("UPDATE schools SET active_until=NULL WHERE id=$1", [schoolId]);
    await fixture.query("UPDATE product_licenses SET expires_at=NULL WHERE school_id=$1 AND product='CLASSPILOT'", [schoolId]);
  });

  await t.test("supervision ownership and authority revision supersede class teachers while preserving administrator Observe", async () => {
    process.env.CLASSPILOT_SCHEDULED_CLASSROOM_MODE = "on";
    const context = await inSchool(() => storage.createSupervisionContextWithStudents({ context: { schoolId,
      contextType: "testing", name: `${tag}-supervision`, status: "active", assignedStaffId: supervisor.id, createdBy: adminId,
      startsAt: new Date(Date.now() - 60_000), endsAt: new Date(Date.now() + 3_600_000),
      scheduleProfileApplicationId: `${tag}-application`, scheduleProfileDate: "2026-10-26", scheduleProfileBlockId: `${tag}-block` },
      studentIds: [secondStudentId], assignedBy: adminId }));
    const supervised = { supervisionContextId: context.id };
    const revision = String(context.classroomAuthorityRevision);
    assert.equal((await policy()).body.captureAllowed, false, "Old classroom viewer descriptors cannot carry into supervision");
    assert.equal((await observe(teacherToken, randomUUID())).status, 403);
    assert.equal((await observe(teacherToken, randomUUID(), supervised, revision)).status, 403);
    assert.equal((await observe(supervisorToken, randomUUID(), supervised)).status, 409);
    assert.equal((await observe(supervisorToken, randomUUID(), supervised, String(context.classroomAuthorityRevision + 1))).status, 403);
    assert.equal((await observe(supervisorToken, randomUUID(), supervised, revision)).status, 200);
    assert.equal((await observe(adminToken, randomUUID(), supervised, revision)).status, 200);
    assert.equal((await policy()).body.captureAllowed, true);
    const stale = await upload(session.sessionCredential, { grantId: grant.grantId, sourceGeneration: generation,
      sequence: 4, capturedAt: new Date().toISOString(), foregroundApplication: null }, jpeg);
    assert.equal(stale.status, 409, "Prior classroom grant cannot publish under the new supervision control revision");
    assert.deepEqual((await fixture.query("SELECT * FROM student_sessions WHERE id=$1", [browser.id])).rows[0], browserSnapshot);
  });
});

test("staff native requests never wait for a second pool client while holding the authentication lease", async () => {
  let nestedCheckouts = 0;
  const originalConnect = pool.connect;
  const observed = mock.method(pool, "connect", function (this: typeof pool, ...args: unknown[]) {
    if (getOwnedTenantStore()) nestedCheckouts++;
    return Reflect.apply(originalConnect, this, args);
  });
  try {
    const response = await request("/enrollment-tokens", "POST", {}, adminToken, staffHeaders());
    assert.equal(response.status, 201, JSON.stringify(response.body));
    assert.equal(nestedCheckouts, 0, "Native work must hand off the completed staff-authentication lease before its own tenant transaction");
  } finally { observed.mock.restore(); }
});

test("native authority contention returns a fixed bounded denial with content-free phase evidence", async () => {
  const installed = await installation();
  const installationId = installed.installationCredential.split('.')[3];
  const blocker = await fixture.connect();
  const logs: string[] = [];
  const observed = mock.method(console, "info", (value: unknown) => { if (typeof value === "string") logs.push(value); });
  try {
    await blocker.query("BEGIN");
    await blocker.query("SELECT id FROM schools WHERE id=$1 FOR UPDATE", [schoolId]);
    const started = performance.now();
    const denied = await bind(installed.installationCredential, secondStudentId);
    assert.equal(denied.status, 503); assert.equal(denied.body.code, "NATIVE_AUTHORITY_BUSY");
    assert.ok(performance.now() - started < 4_500, "Authority contention must settle before the native client's 5s timeout");
    assert.equal((await blocker.query("SELECT count(*)::int AS count FROM classpilot_native_sessions WHERE installation_id=$1", [installationId])).rows[0].count, 0);
    const event = logs.map(value => JSON.parse(value)).find(value => value.event === "classpilot_native_request");
    assert.equal(event.operation, "student_sign_in"); assert.equal(event.code, "NATIVE_AUTHORITY_BUSY");
    assert.ok(event.phases.school_lock.milliseconds >= 900);
    assert.ok(!JSON.stringify(event).includes(schoolId) && !JSON.stringify(event).includes(installed.installationCredential));
  } finally {
    await blocker.query("ROLLBACK"); blocker.release(); observed.mock.restore();
  }
  assert.equal((await bind(installed.installationCredential, secondStudentId)).status, 409, "The database connection recovers; the actual active identity conflict still applies");
  assert.equal((await request(`/installations/${installationId}`, "DELETE", undefined, adminToken, staffHeaders())).status, 204);
});

test("Redis execution-time fences preserve absolute expiry and reject delayed old image writes", async t => {
  const redis = createClient({ url: process.env.TEST_REDIS_URL, disableOfflineQueue: true });
  redis.on("error", () => {}); await redis.connect();
  const prefix = `${tag}:late-execution`;
  let release: (() => void) | undefined;
  let gate: Promise<void> | undefined;
  const commands: string[][] = [];
  const store = new ClasspilotNativeStore(async args => {
    commands.push(args); if (gate) await gate; return redis.sendCommand(args);
  }, prefix);
  const immediate = new ClasspilotNativeStore(args => redis.sendCommand(args), prefix);
  const hold = () => { gate = new Promise<void>(resolve => { release = resolve; }); };
  const resume = () => { release?.(); gate = undefined; release = undefined; };
  const base = { schoolId: "synthetic-school", studentId: "synthetic-student", nativeSessionId: randomUUID(), sourceRef: randomUUID(),
    teachingSessionId: "synthetic-class", bindingRevision: 1 };
  const viewer = (expiresAt = Date.now() + 10_000): NativeViewerLease => ({ schoolId: base.schoolId, actorId: "synthetic-teacher",
    viewerInstanceId: randomUUID(), authVersion: 1, teachingSessionId: base.teachingSessionId,
    targets: [{ studentId: base.studentId, sourceRef: base.sourceRef, bindingRevision: base.bindingRevision }], expiresAt });
  const grant = (): NativeCaptureGrant => ({ ...base, id: randomUUID(), sourceGeneration: randomUUID(), controlRevision: 1,
    issuedAt: Date.now(), expiresAt: Date.now() + 10_000 });
  const image = (capture: NativeCaptureGrant, imageExpiresAt = Date.now() + 8_000): NativeStoredImage => ({ ...capture,
    sequence: 1, capturedAt: new Date().toISOString(), receivedAt: new Date().toISOString(), foregroundApplication: null,
    screenshot: "synthetic-only-pixels", imageExpiresAt });
  try {
    await t.test("a delayed viewer creation expires at its original absolute deadline", async () => {
      const lease = viewer(Date.now() + 3_000);
      hold(); const pending = store.setViewer(lease); await pause(150); resume(); await pending;
      assert.equal(await redis.sendCommand(["PEXPIRETIME", store.viewerKey(lease.schoolId, lease.actorId, lease.viewerInstanceId)]), lease.expiresAt);
      const stale = viewer(Date.now() + 100);
      hold(); const rejected = assert.rejects(store.setViewer(stale), { code: "NATIVE_GRANT_STALE" });
      await pause(180); resume(); await rejected;
      assert.equal(await immediate.getViewer(stale.schoolId, stale.actorId, stale.viewerInstanceId), null);
    });
    await t.test("grant, image and sequence retention use absolute deadlines after delayed execution", async () => {
      const lease = viewer(), capture = grant(); await immediate.setViewer(lease);
      hold(); const pendingGrant = store.saveGrant(capture, [lease]); await pause(150); resume(); await pendingGrant;
      const grantCommand = commands.at(-1)!;
      assert.equal(await redis.sendCommand(["PEXPIRETIME", grantCommand[3]!]), capture.expiresAt);
      const frame = image(capture), sessionEnd = Date.now() + 20_000;
      hold(); const pendingImage = store.saveImage(frame, sessionEnd, [lease]); await pause(150); resume(); await pendingImage;
      const imageCommand = commands.at(-1)!;
      assert.equal(await redis.sendCommand(["PEXPIRETIME", imageCommand[4]!]), frame.imageExpiresAt);
      assert.equal(await redis.sendCommand(["PEXPIRETIME", imageCommand[5]!]), sessionEnd);
    });
    await t.test("a queued expired grant or image never becomes readable", async () => {
      const lease = viewer(); await immediate.setViewer(lease);
      const expiredGrant = { ...grant(), expiresAt: Date.now() + 100 };
      hold(); const grantDenied = assert.rejects(store.saveGrant(expiredGrant, [lease]), { code: "NATIVE_GRANT_STALE" });
      await pause(180); resume(); await grantDenied;
      assert.equal(await immediate.getGrant(base.schoolId, base.nativeSessionId, expiredGrant.id), null);
      const capture = grant(); await immediate.saveGrant(capture, [lease]);
      const expiredImage = image(capture, Date.now() + 100);
      hold(); const imageDenied = assert.rejects(store.saveImage(expiredImage, Date.now() + 20_000, [lease]), { code: "NATIVE_GRANT_STALE" });
      await pause(180); resume(); await imageDenied;
      const oldCapture = { ...image(capture), capturedAt: new Date(Date.now() - 4_900).toISOString() };
      hold(); const arrivalDenied = assert.rejects(store.saveImage(oldCapture, Date.now() + 20_000, [lease]), { code: "NATIVE_GRANT_STALE" });
      await pause(180); resume(); await arrivalDenied;
    });
    await t.test("late image from an earlier binding cannot replace a newer binding image", async () => {
      const oldViewer = viewer(), oldGrant = grant();
      await immediate.setViewer(oldViewer); await immediate.saveGrant(oldGrant, [oldViewer]);
      const lateImage = { ...image(oldGrant), sequence: 99 };
      hold(); const oldDenied = assert.rejects(store.saveImage(lateImage, Date.now() + 20_000, [oldViewer]), { code: "NATIVE_GRANT_STALE" });
      const newViewer = { ...viewer(), targets: [{ ...oldViewer.targets[0]!, bindingRevision: 2 }] };
      const newGrant = { ...grant(), bindingRevision: 2 };
      await immediate.setViewer(newViewer); await immediate.saveGrant(newGrant, [newViewer]);
      await immediate.saveImage(image(newGrant), Date.now() + 20_000, [newViewer]);
      resume(); await oldDenied;
      assert.equal((await immediate.readImage(base.schoolId, base.sourceRef))?.bindingRevision, 2);
      assert.equal((await immediate.readImage(base.schoolId, base.sourceRef))?.sequence, 1);
      await immediate.clearImage(base.schoolId, base.sourceRef, 1);
      assert.equal((await immediate.readImage(base.schoolId, base.sourceRef))?.bindingRevision, 2,
        "Late cleanup authorized by an older binding must also preserve the replacement image");
    });
    await t.test("a released viewer cannot be recreated by a delayed command", async () => {
      const lease = viewer();
      hold(); const denied = assert.rejects(store.setViewer(lease), { code: "NATIVE_VIEWER_RELEASED" });
      await immediate.releaseViewer(lease.schoolId, lease.actorId, lease.viewerInstanceId);
      resume(); await denied;
      assert.equal(await immediate.getViewer(lease.schoolId, lease.actorId, lease.viewerInstanceId), null);
    });
  } finally {
    resume(); const keys = await redis.keys(`${prefix}:*`); if (keys.length) await redis.del(keys);
    redis.destroy();
  }
});

test("source-qualified Stop handles a lost policy response without clearing a replacement source", async () => {
  const student = await inSchool(() => storage.createStudent({ schoolId, firstName: "Synthetic", lastName: "Lost response", status: "active" }));
  await fixture.query("UPDATE students SET classpilot_pin_hash=$2 WHERE id=$1", [student.id, await hashClassPilotPin("1234")]);
  const installed = await installation(), nonce = randomUUID();
  const bound = await bind(installed.installationCredential, student.id, nonce); assert.equal(bound.status, 201);
  const credential = bound.body.sessionCredential, initialRevision = bound.body.bindingRevision;
  const firstGeneration = randomUUID(), nextGeneration = randomUUID();
  try {
    const lost = await request(`/policy?sourceGeneration=${firstGeneration}&bindingRevision=${initialRevision}`, "GET", undefined, credential);
    assert.equal(lost.status, 200); assert.ok(lost.body.bindingRevision > initialRevision);
    assert.equal((await request("/observations", "DELETE", { bindingRevision: initialRevision }, credential)).status, 409);
    assert.equal((await request("/observations", "DELETE", { bindingRevision: initialRevision, sourceGeneration: firstGeneration }, credential)).status, 204);
    await request("/session/renew", "POST", { osSessionNonce: nonce }, credential);
    const next = await request(`/policy?sourceGeneration=${nextGeneration}`, "GET", undefined, credential);
    assert.equal(next.status, 200);
    assert.equal((await request("/observations", "DELETE", { bindingRevision: initialRevision, sourceGeneration: firstGeneration }, credential)).status, 409);
    assert.equal((await request("/observations", "DELETE", { bindingRevision: next.body.bindingRevision + 1, sourceGeneration: nextGeneration }, credential)).status, 409);
    assert.equal((await fixture.query("SELECT source_generation FROM classpilot_native_sessions WHERE id=$1", [credential.split('.')[3]])).rows[0].source_generation, nextGeneration);
    assert.equal((await request("/observations", "DELETE", { bindingRevision: next.body.bindingRevision, sourceGeneration: nextGeneration }, credential)).status, 204);
  } finally { await request(`/installations/${installed.installationCredential.split('.')[3]}`, "DELETE", undefined, adminToken, staffHeaders()); }
});

test("a tile response crossing the deadline during serialization is not denied after it was sent", async () => {
  let offset = 0, crossed = false;
  const now = performance.now.bind(performance);
  const clock = mock.method(performance, "now", () => now() + offset);
  const originalJson = express.response.json;
  const observed = mock.method(express.response, "json", function (this: Response, body: unknown) {
    const result = originalJson.call(this, body);
    if (this.req.originalUrl.startsWith('/api/classpilot/native/tiles/desktop')) { crossed = true; offset = 5_000; }
    return result;
  });
  const errors = mock.method(errorMonitor, "trackError", () => undefined);
  try {
    const response = await tiles();
    assert.equal(response.status, 200); assert.equal(response.body.enabled, true); assert.equal(crossed, true);
    assert.equal((await tiles()).status, 200, "A subsequent authority transaction settles after the original response releases its school lock");
    assert.equal(errors.mock.calls.length, 0, "No late deadline error, rollback or second response should follow the valid response");
  } finally { observed.mock.restore(); clock.mock.restore(); errors.mock.restore(); }
});

test("a late failure after a native response is delegated without a second write or unhandled rejection", async () => {
  const originalJson = express.response.json;
  let injected = false;
  const observed = mock.method(express.response, "json", function (this: Response, body: unknown) {
    const result = originalJson.call(this, body);
    if (!injected && this.req.originalUrl.startsWith('/api/classpilot/native/tiles/desktop')) {
      injected = true;
      throw new ClasspilotNativeError('NATIVE_REQUEST_EXPIRED', 503);
    }
    return result;
  });
  let errorObserved: (() => void) | undefined;
  const delegated = new Promise<void>(resolve => { errorObserved = resolve; });
  const errors = mock.method(errorMonitor, "trackError", () => { errorObserved?.(); });
  const consoleError = mock.method(console, "error", () => undefined);
  try {
    assert.equal((await tiles()).status, 200); assert.equal(injected, true);
    await Promise.race([delegated, pause(2_000).then(() => { throw new Error("The sent-response failure was not delegated to the error handler"); })]);
    assert.equal(errors.mock.calls.length, 1, "The normal error handler observes the failure exactly once");
  } finally { observed.mock.restore(); errors.mock.restore(); consoleError.mock.restore(); }
  assert.equal((await tiles()).status, 200, "The server and pool remain usable after the already-sent response failure");
});

test("batch read removes an earlier image that expires while a later tile is awaited", async () => {
  const pinHash = await hashClassPilotPin("1234");
  const students = await inSchool(() => db.insert(schema.students).values([1, 2].map(index => ({ schoolId,
    firstName: "Synthetic", lastName: `Batch deadline ${index}`, classpilotPinHash: pinHash, status: "active" }))).returning());
  const activity = await inSchool(async () => {
    const group = await storage.createGroup({ schoolId, teacherId, name: "Batch deadline", groupType: "admin_class", status: "active" });
    await db.insert(schema.groupStudents).values(students.map(student => ({ groupId: group.id, studentId: student.id })));
    return storage.createTeachingSession({ groupId: group.id, teacherId, sessionMode: "live" });
  });
  const installed = [], sessions = [], generations = [randomUUID(), randomUUID()];
  const viewer = randomUUID();
  const jpeg = await sharp({ create: { width: 320, height: 180, channels: 3, background: "#1976d2" } }).jpeg().toBuffer();
  try {
    for (const [index, student] of students.entries()) {
      const enrollment = await installation(); installed.push(enrollment);
      const session = await bind(enrollment.installationCredential, student.id); assert.equal(session.status, 201);
      sessions.push(session.body);
      assert.equal((await request(`/policy?sourceGeneration=${generations[index]}`, "GET", undefined, session.body.sessionCredential)).status, 200);
    }
    const body = { teachingSessionId: activity.id, studentIds: students.map(student => student.id) };
    const metadata = await tiles(body); assert.equal(metadata.status, 200);
    const targets = metadata.body.tiles.map((tile: { studentId: string; sourceRef: string; bindingRevision: number }) =>
      ({ studentId: tile.studentId, sourceRef: tile.sourceRef, bindingRevision: tile.bindingRevision }));
    assert.equal((await request(`/observation-leases/${viewer}`, "PUT", { teachingSessionId: activity.id, targets }, teacherToken, staffHeaders())).status, 200);
    for (const [index, session] of sessions.entries()) {
      const grant = await request(`/policy?sourceGeneration=${generations[index]}`, "GET", undefined, session.sessionCredential);
      assert.equal(grant.body.captureAllowed, true);
      assert.equal((await upload(session.sessionCredential, { grantId: grant.body.grantId, sourceGeneration: generations[index], sequence: 1,
        capturedAt: new Date().toISOString(), foregroundApplication: { id: "win32.syntheticcontent", displayName: "Synthetic content",
          observedAt: new Date().toISOString() } }, jpeg)).status, 200);
    }
    const originalRead = classpilotNativeStore.readImage.bind(classpilotNativeStore);
    let firstDeadline = 0, secondDelayed = false;
    const observed = mock.method(classpilotNativeStore, "readImage", async (school: string, sourceRef: string) => {
      const image = await originalRead(school, sourceRef); assert.ok(image);
      if (sourceRef === targets[0].sourceRef) {
        firstDeadline = Date.now() + 150;
        return { ...image, imageExpiresAt: firstDeadline };
      }
      await pause(250); secondDelayed = true;
      return image;
    });
    try {
      const response = await tiles({ ...body, viewerInstanceId: viewer, selectedSources: targets });
      assert.equal(response.status, 200); assert.equal(secondDelayed, true);
      assert.ok(Date.parse(response.body.serverTime) >= firstDeadline);
      const [expired, current] = response.body.tiles;
      assert.equal(expired.state, "stale");
      assert.deepEqual({ studentId: expired.studentId, sourceRef: expired.sourceRef, bindingRevision: expired.bindingRevision }, targets[0]);
      for (const field of ["screenshot", "foregroundApplication", "observedAt", "sequence", "expiresAt"]) assert.equal(expired[field], undefined, field);
      assert.equal(current.state, "available"); assert.match(current.screenshot, /^data:image\/jpeg;base64,/);
      assert.equal(current.foregroundApplication.id, "win32.syntheticcontent");
    } finally { observed.mock.restore(); }
  } finally {
    await request(`/observation-leases/${viewer}`, "DELETE", undefined, teacherToken, staffHeaders());
    for (const enrollment of installed) await request(`/installations/${enrollment.installationCredential.split('.')[3]}`, "DELETE", undefined, adminToken, staffHeaders());
  }
});
