import { after, before, describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { sql } from "drizzle-orm";

const TAG = `cp_recent_sessions_${Date.now()}`;
const ORIGINAL_SENDGRID_API_KEY = process.env.SENDGRID_API_KEY;
const ORIGINAL_REDIS_URL = process.env.REDIS_URL;
process.env.SENDGRID_API_KEY = "SG.classpilot-teaching-sessions.recent-test";
// Keep realtime/rate-limit Redis clients in local-only mode so importing the
// full app cannot leave network handles alive after the test server closes.
delete process.env.REDIS_URL;

const RECENT_PATH = "/classpilot/teaching-sessions/recent";

interface RecentSessionDto {
  id: string;
  groupId: string;
  teacherId: string;
  startTime: string;
  endTime: string;
  className: string;
  lifecycle: { kind: string; state: string };
  summaryTrigger: string;
  reportState: string;
}

interface RecentSessionsBody {
  sessions: RecentSessionDto[];
}

// The exact response contract the Past Sessions client relies on. Anything
// else on the raw teaching_sessions row (scheduledTeacherEmail, frozen
// occurrence metadata, snapshots) must stay server-side.
const RECENT_SESSION_FIELDS = [
  "className",
  "endTime",
  "groupId",
  "id",
  "lifecycle",
  "reportState",
  "startTime",
  "summaryTrigger",
  "teacherId",
];

let db: any;
let pool: any;
let storage: any;
let lifecycle: any;
let monitoringReports: any;
let schedulerPool: any;
let schedulerLockPool: any;
let runWithTenantContext: any;
let signUserToken: any;
let sgMail: any;
let sendMock: any;

let server: Server;
let baseUrl: string;
let school: any;
let teacherA: any;
let teacherB: any;
let admin: any;
let student: any;
let groupA: any;
let groupB: any;
// Ended-session fixtures keyed by the report state they exercise (plus the
// active and skipped rows the listing must exclude). Built once in `before`.
const fixture: Record<string, any> = {};

function inSchool(schoolId: string, fn: () => Promise<any>): Promise<any> {
  return runWithTenantContext({ schoolId }, fn);
}

function asSystem(fn: () => Promise<any>): Promise<any> {
  return runWithTenantContext({ isSuper: true }, fn);
}

function authFor(user: any): Record<string, string> {
  const token = signUserToken({ userId: user.id, email: user.email, isSuperAdmin: false });
  return { authorization: `Bearer ${token}`, "x-school-id": school.id };
}

async function getJson(
  path: string,
  headers: Record<string, string>
): Promise<{ status: number; body: RecentSessionsBody; headers: Headers }> {
  const response = await fetch(`${baseUrl}${path}`, { headers });
  const text = await response.text();
  return {
    status: response.status,
    body: (text ? JSON.parse(text) : null) as RecentSessionsBody,
    headers: response.headers,
  };
}

function ids(body: RecentSessionsBody): string[] {
  return body.sessions.map((session) => session.id);
}

function reportStates(body: RecentSessionsBody): string[] {
  return body.sessions.map((session) => session.reportState);
}

async function createClass(name: string, teacherId: string): Promise<any> {
  const group = await inSchool(school.id, () => storage.createGroup({
    schoolId: school.id,
    teacherId,
    name: `${TAG}_${name}`,
    groupType: "admin_class",
    status: "active",
    scheduleEnabled: false,
    blockStartTime: null,
    blockEndTime: null,
  }));
  await inSchool(school.id, () => storage.addGroupStudentsDetailed(group.id, [student.id]));
  return group;
}

async function startSession(group: any, teacherId: string, startTime: Date): Promise<any> {
  return inSchool(school.id, () =>
    storage.createTeachingSession({ groupId: group.id, teacherId, startTime })
  );
}

async function endedSession(group: any, teacherId: string, day: string): Promise<any> {
  const session = await startSession(group, teacherId, new Date(`${day}T13:00:00.000Z`));
  const result = await inSchool(school.id, () => lifecycle.finalizeClasspilotSession({
    schoolId: school.id,
    sessionId: session.id,
    reason: "manual_end",
    finalizedAt: new Date(`${day}T14:00:00.000Z`),
  }));
  assert.ok(result?.finalized, `fixture session for ${day} must finalize`);
  return result.session;
}

async function reportFor(sessionId: string): Promise<any> {
  return inSchool(school.id, () => storage.getClasspilotSessionReportBySession(school.id, sessionId));
}

async function materializeReport(sessionId: string): Promise<void> {
  const pending = await reportFor(sessionId);
  assert.ok(pending, "finalization must create a pending immutable report");
  await inSchool(school.id, () => monitoringReports.materializeDueClasspilotSessionReports({
    now: new Date(pending.settleAt),
    limit: 10,
    schoolId: school.id,
    teachingSessionId: sessionId,
  }));
  assert.equal((await reportFor(sessionId))?.state, "ready", "settled report must materialize");
}

async function cleanup(): Promise<void> {
  if (!school?.id) return;
  await asSystem(async () => {
    await db.execute(sql`DELETE FROM classpilot_session_summary_deliveries WHERE school_id = ${school.id}`);
    await db.execute(sql`DELETE FROM classpilot_monitoring_events WHERE school_id = ${school.id}`);
    await db.execute(sql`DELETE FROM classpilot_session_student_reports WHERE school_id = ${school.id}`);
    await db.execute(sql`DELETE FROM classpilot_session_reports WHERE school_id = ${school.id}`);
    await db.execute(sql`DELETE FROM classpilot_session_staff WHERE school_id = ${school.id}`);
    await db.execute(sql`DELETE FROM classpilot_student_control_states WHERE school_id = ${school.id}`);
    await db.execute(sql`DELETE FROM classpilot_session_usage WHERE school_id = ${school.id}`);
    await db.execute(sql`DELETE FROM session_settings WHERE session_id IN (SELECT id FROM teaching_sessions WHERE school_id = ${school.id})`);
    await db.execute(sql`DELETE FROM classpilot_classroom_states WHERE school_id = ${school.id}`);
    await db.execute(sql`DELETE FROM classpilot_active_hands WHERE school_id = ${school.id}`);
    await db.execute(sql`DELETE FROM classpilot_supervision_students WHERE school_id = ${school.id}`);
    await db.execute(sql`DELETE FROM classpilot_supervision_contexts WHERE school_id = ${school.id}`);
    await db.execute(sql`DELETE FROM classpilot_scheduled_conflicts WHERE school_id = ${school.id}`);
    await db.execute(sql`DELETE FROM classpilot_session_students WHERE school_id = ${school.id}`);
    await db.execute(sql`DELETE FROM heartbeats WHERE school_id = ${school.id}`);
    await db.execute(sql`DELETE FROM teaching_sessions WHERE school_id = ${school.id}`);
    await db.execute(sql`DELETE FROM group_students WHERE group_id IN (SELECT id FROM groups WHERE school_id = ${school.id})`);
    await db.execute(sql`DELETE FROM group_teachers WHERE group_id IN (SELECT id FROM groups WHERE school_id = ${school.id})`);
    await db.execute(sql`DELETE FROM groups WHERE school_id = ${school.id}`);
    await db.execute(sql`DELETE FROM students WHERE school_id = ${school.id}`);
    await db.execute(sql`DELETE FROM audit_logs WHERE school_id = ${school.id}`);
    await db.execute(sql`DELETE FROM settings WHERE school_id = ${school.id}`);
    await db.execute(sql`DELETE FROM product_licenses WHERE school_id = ${school.id}`);
    await db.execute(sql`DELETE FROM school_memberships WHERE school_id = ${school.id}`);
    await db.execute(sql`DELETE FROM schools WHERE id = ${school.id}`);
    await db.execute(sql`DELETE FROM users WHERE email LIKE ${`%@${TAG}.example.edu`}`);
  });
}

before(async () => {
  const dbModule = await import("../dist/db.js");
  db = dbModule.default;
  pool = dbModule.pool;
  storage = await import("../dist/services/storage.js");
  lifecycle = await import("../dist/services/classpilotSessionLifecycle.js");
  monitoringReports = await import("../dist/services/classpilotMonitoringReports.js");
  const schedulerDbModule = await import("../dist/services/schedulerDb.js");
  schedulerPool = schedulerDbModule.schedulerPool;
  schedulerLockPool = schedulerDbModule.schedulerLockPool;
  ({ runWithTenantContext } = await import("../dist/middleware/tenantContext.js"));
  ({ signUserToken } = await import("../dist/services/jwt.js"));
  sgMail = (await import("@sendgrid/mail")).default;
  sendMock = mock.method(sgMail, "send", async () => [{ headers: { "x-message-id": `${TAG}-sent` } }]);

  school = await storage.createSchool({
    name: `${TAG}_School`,
    domain: `${TAG}.example.edu`,
    slug: TAG,
    schoolTimezone: "America/New_York",
  });
  teacherA = await storage.createUser({
    email: `teacher-a@${TAG}.example.edu`,
    firstName: "Avery",
    lastName: "Alpha",
  });
  teacherB = await storage.createUser({
    email: `teacher-b@${TAG}.example.edu`,
    firstName: "Blake",
    lastName: "Bravo",
  });
  admin = await storage.createUser({
    email: `admin@${TAG}.example.edu`,
    firstName: "Adrian",
    lastName: "Admin",
  });
  for (const [user, role] of [[teacherA, "teacher"], [teacherB, "teacher"], [admin, "admin"]] as const) {
    await storage.createMembership({
      userId: user.id,
      schoolId: school.id,
      role,
      status: "active",
    });
  }
  await storage.createProductLicense({ schoolId: school.id, product: "CLASSPILOT", status: "active" });
  student = await inSchool(school.id, () => storage.createStudent({
    schoolId: school.id,
    firstName: "Student",
    lastName: "One",
    email: `student-one@${TAG}.example.edu`,
    emailLc: `student-one@${TAG}.example.edu`,
    gradeLevel: "7",
    status: "active",
  }));

  const { createApp } = await import("../dist/app.js");
  server = createServer(createApp());
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;

  groupA = await createClass("a_class", teacherA.id);
  groupB = await createClass("b_class", teacherB.id);

  // Teacher A: two ended classes plus one still running.
  fixture.expired = await endedSession(groupA, teacherA.id, "2031-03-02");
  fixture.ready = await endedSession(groupA, teacherA.id, "2031-03-03");
  // Teacher B: one class co-taught by A, two that A never staffed.
  fixture.coTaught = await endedSession(groupB, teacherB.id, "2031-03-04");
  fixture.pending = await endedSession(groupB, teacherB.id, "2031-03-05");
  fixture.failed = await endedSession(groupB, teacherB.id, "2031-03-06");
  // A skipped scheduled occurrence is ended history but never a real class.
  const skipped = await inSchool(school.id, () => db.execute(sql`
    INSERT INTO teaching_sessions (
      group_id, teacher_id, school_id, start_time, session_mode,
      scheduled_date, scheduled_timezone, scheduled_start_at, scheduled_end_at,
      scheduled_state, class_name_snapshot, timezone_snapshot, end_time
    ) VALUES (
      ${groupA.id}, ${teacherA.id}, ${school.id}, '2031-03-07 13:00:00', 'live',
      '2031-03-07', 'America/New_York', '2031-03-07T13:00:00Z', '2031-03-07T14:00:00Z',
      'skipped', ${groupA.name}, 'America/New_York', '2031-03-07 14:00:00'
    )
    RETURNING id
  `));
  const [skippedRow] = skipped.rows;
  assert.ok(skippedRow, "skipped occurrence fixture must insert");
  fixture.skipped = { id: String(skippedRow.id) };
  fixture.active = await startSession(groupA, teacherA.id, new Date("2031-03-08T13:00:00.000Z"));

  // Immutable staff snapshot: A co-taught B's first class.
  await inSchool(school.id, () => db.execute(sql`
    INSERT INTO classpilot_session_staff (
      school_id, teaching_session_id, staff_id, role, staff_name_snapshot, staff_email_snapshot
    ) VALUES (
      ${school.id}, ${fixture.coTaught.id}, ${teacherA.id}, 'co_teacher', 'Avery Alpha', ${teacherA.email}
    )
  `));

  // Report states: expired (retention lapsed), ready (materialized), none
  // (no report row), pending (untouched after finalization), failed.
  await inSchool(school.id, () => db.execute(sql`
    UPDATE classpilot_session_reports
    SET expires_at = '2000-01-01T00:00:00Z'
    WHERE school_id = ${school.id} AND teaching_session_id = ${fixture.expired.id}
  `));
  await materializeReport(fixture.ready.id);
  await inSchool(school.id, () => db.execute(sql`
    DELETE FROM classpilot_session_reports
    WHERE school_id = ${school.id} AND teaching_session_id = ${fixture.coTaught.id}
  `));
  assert.ok(["pending", "materializing"].includes((await reportFor(fixture.pending.id))?.state));
  await inSchool(school.id, () => db.execute(sql`
    UPDATE classpilot_session_reports
    SET state = 'failed'
    WHERE school_id = ${school.id} AND teaching_session_id = ${fixture.failed.id}
  `));
});

after(async () => {
  try {
    if (server) {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => error ? reject(error) : resolve())
      );
    }
    await cleanup();
  } finally {
    sendMock?.mock.restore();
    await schedulerLockPool?.end().catch(() => undefined);
    await schedulerPool?.end().catch(() => undefined);
    await pool?.end().catch(() => undefined);
    if (ORIGINAL_SENDGRID_API_KEY === undefined) delete process.env.SENDGRID_API_KEY;
    else process.env.SENDGRID_API_KEY = ORIGINAL_SENDGRID_API_KEY;
    if (ORIGINAL_REDIS_URL === undefined) delete process.env.REDIS_URL;
    else process.env.REDIS_URL = ORIGINAL_REDIS_URL;
  }
});

describe("GET /api/classpilot/teaching-sessions/recent", { concurrency: false }, () => {
  it("is routed ahead of /:id and is never cached", async () => {
    const response = await getJson(RECENT_PATH, authFor(teacherA));
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.ok(Array.isArray(response.body.sessions));
    assert.equal(response.headers.get("cache-control"), "no-store, private");
  });

  it("lists a teacher's own and co-taught ended classes newest first and excludes the running class", async () => {
    const response = await getJson(RECENT_PATH, authFor(teacherA));
    assert.equal(response.status, 200);
    assert.deepEqual(ids(response.body), [fixture.coTaught.id, fixture.ready.id, fixture.expired.id]);
    assert.deepEqual(reportStates(response.body), ["none", "ready", "expired"]);
    const endTimes = response.body.sessions.map((session) => Date.parse(session.endTime));
    for (let index = 1; index < endTimes.length; index += 1) {
      const previous = endTimes[index - 1];
      const current = endTimes[index];
      assert.ok(previous !== undefined && current !== undefined);
      assert.ok(previous > current, "sessions must be ordered by endTime desc");
    }
    for (const excluded of [fixture.active, fixture.pending, fixture.failed, fixture.skipped]) {
      assert.ok(!ids(response.body).includes(excluded.id), `session ${excluded.id} must not be listed`);
    }
  });

  it("hides classes where the caller is not immutable session staff", async () => {
    const response = await getJson(RECENT_PATH, authFor(teacherB));
    assert.equal(response.status, 200);
    assert.deepEqual(ids(response.body), [fixture.failed.id, fixture.pending.id, fixture.coTaught.id]);
    assert.deepEqual(reportStates(response.body), ["failed", "pending", "none"]);
  });

  it("shows admins every ended live class in the school", async () => {
    const response = await getJson(RECENT_PATH, authFor(admin));
    assert.equal(response.status, 200);
    assert.deepEqual(ids(response.body), [
      fixture.failed.id,
      fixture.pending.id,
      fixture.coTaught.id,
      fixture.ready.id,
      fixture.expired.id,
    ]);
    assert.deepEqual(reportStates(response.body), ["failed", "pending", "none", "ready", "expired"]);
    assert.ok(!ids(response.body).includes(fixture.active.id), "running class must not be listed");
    assert.ok(!ids(response.body).includes(fixture.skipped.id), "skipped occurrence must not be listed");
  });

  it("honors and clamps the limit query parameter", async () => {
    const limited = await getJson(`${RECENT_PATH}?limit=2`, authFor(teacherA));
    assert.equal(limited.status, 200);
    assert.deepEqual(ids(limited.body), [fixture.coTaught.id, fixture.ready.id]);

    const floor = await getJson(`${RECENT_PATH}?limit=0`, authFor(teacherA));
    assert.equal(floor.status, 200);
    assert.deepEqual(ids(floor.body), [fixture.coTaught.id]);

    const invalid = await getJson(`${RECENT_PATH}?limit=abc`, authFor(teacherA));
    assert.equal(invalid.status, 200);
    assert.equal(invalid.body.sessions.length, 3);

    const ceiling = await getJson(`${RECENT_PATH}?limit=999`, authFor(admin));
    assert.equal(ceiling.status, 200);
    assert.equal(ceiling.body.sessions.length, 5);
  });

  it("projects only the documented fields and never the frozen occurrence email", async () => {
    const response = await getJson(RECENT_PATH, authFor(admin));
    assert.equal(response.status, 200);
    for (const session of response.body.sessions) {
      assert.deepEqual(Object.keys(session).sort(), RECENT_SESSION_FIELDS);
      assert.equal("scheduledTeacherEmail" in session, false);
    }
    const raw = JSON.stringify(response.body);
    assert.ok(!raw.includes("scheduledTeacherEmail"));
    assert.ok(!raw.includes("@"), "no email address may appear in the listing");

    const ready = response.body.sessions.find((session) => session.id === fixture.ready.id);
    assert.ok(ready, "materialized session must be listed");
    assert.equal(ready.groupId, groupA.id);
    assert.equal(ready.teacherId, teacherA.id);
    assert.equal(ready.className, groupA.name);
    assert.equal(ready.reportState, "ready");
    assert.deepEqual(ready.lifecycle, { kind: "manual", state: "finalized" });
    assert.equal(ready.summaryTrigger, "manual_end");
    assert.equal(ready.startTime, new Date(fixture.ready.startTime).toISOString());
    assert.equal(ready.endTime, new Date(fixture.ready.endTime).toISOString());
  });
});
