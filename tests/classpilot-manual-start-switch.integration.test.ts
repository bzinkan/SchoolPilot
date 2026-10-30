import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import { sql } from "drizzle-orm";
import type { Group, TeachingSession } from "../src/schema/classpilot.js";
import type { School, User } from "../src/schema/core.js";
import { emptyAutomaticFlightPathState } from "../src/services/classpilotAutomaticFlightPath.js";
import { classpilotTeachingSessionIsCurrent } from "../src/services/classpilotTeachingSessionWindow.js";

// Exercise the real HTTP/lifecycle transaction without external transports.
process.env.REDIS_URL = "";
process.env.SENDGRID_API_KEY = "";

const tag = `manual_start_switch_${randomUUID()}`;
const timezone = "America/New_York";
const startPath = "/classpilot/teaching-sessions/start";
let database: typeof import("../src/db.js").default;
let storage: typeof import("../src/services/storage.js");
let lifecycle: typeof import("../src/services/classpilotSessionLifecycle.js");
let scheduled: typeof import("../src/services/classpilotScheduledStart.js");
let pushes: typeof import("../src/services/classpilotLifecyclePushes.js");
let schoolTime: typeof import("../src/util/schoolTime.js");
let tenant: typeof import("../src/middleware/tenantContext.js").runWithTenantContext;
let signUserToken: typeof import("../src/services/jwt.js").signUserToken;
let school: School;
let administrator: User;
let server: Server;
let baseUrl: string;

const inSchool = <T>(action: () => Promise<T>) => tenant({ schoolId: school.id }, action);
const system = <T>(action: () => Promise<T>) => tenant({ isSuper: true }, action);

async function staff(role: "teacher" | "admin" = "teacher"): Promise<User> {
  return system(async () => {
    const user = await storage.createUser({ email: `${randomUUID()}@${tag}.example.edu`, firstName: "Synthetic", lastName: role });
    await storage.createMembership({ schoolId: school.id, userId: user.id, role, status: "active" });
    return user;
  });
}

async function classroom(owner: User, options: { scheduled?: boolean; students?: string[] } = {}): Promise<Group> {
  return inSchool(async () => {
    const group = await storage.createGroup({ schoolId: school.id, teacherId: owner.id,
      name: `${tag}_${randomUUID()}`, groupType: "admin_class", status: "active", scheduleEnabled: false });
    if (options.scheduled) {
      // Cases use independent teachers; the direct recurring-window seed keeps
      // schedule editing/overlap validation outside the start transaction test.
      await database.execute(sql`UPDATE groups SET schedule_enabled=true,
        block_start_time='09:00',block_end_time='10:00' WHERE school_id=${school.id} AND id=${group.id}`);
    }
    if (options.students?.length) await storage.addGroupStudentsDetailed(group.id, options.students);
    const current = await storage.getGroupByIdAndSchool(group.id, school.id);
    assert.ok(current);
    return current;
  });
}

async function student(): Promise<string> {
  return inSchool(async () => {
    const record = await storage.createStudent({ schoolId: school.id, firstName: "Synthetic", lastName: "Student",
      email: `${randomUUID()}@${tag}.example.edu`, status: "active" });
    return record.id;
  });
}

async function request(user: User, body: unknown, path = startPath, method = "POST") {
  const response = await fetch(`${baseUrl}${path}`, { method, headers: {
    authorization: `Bearer ${signUserToken({ userId: user.id, email: user.email, isSuperAdmin: user.isSuperAdmin })}`,
    "x-school-id": school.id,
    ...(body === undefined ? {} : { "content-type": "application/json" }),
  }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

function schoolDate() {
  return schoolTime.localDateInTimeZone(new Date(), timezone);
}

function review(group: Group, expectedActiveSessionId: string | null = null) {
  return { groupId: group.id, expectedActiveSessionId, manualToday: { expectedSchoolDate: schoolDate() } };
}

async function currentGroup(group: Group) {
  const current = await inSchool(() => storage.getGroupByIdAndSchool(group.id, school.id));
  assert.ok(current);
  return current;
}

async function currentSession(session: TeachingSession) {
  const current = await inSchool(() => storage.getTeachingSessionByIdAndSchool(session.id, school.id));
  assert.ok(current);
  return current;
}

async function occurrence(group: Group, mode: "live" | "scheduled_report" = "live"): Promise<TeachingSession> {
  const now = Date.now();
  return inSchool(async () => {
    const owner = await storage.getUserById(group.teacherId);
    assert.ok(owner);
    const frozen = await storage.createOrReuseScheduledReportSession({ schoolId: school.id,
      groupId: group.id, teacherId: group.teacherId, scheduledDate: schoolDate(), scheduledTimezone: timezone,
      scheduledStartAt: new Date(now - 300_000), scheduledEndAt: new Date(now + 3_600_000),
      scheduledTeacherEmail: owner.email, scheduledTeacherName: `${owner.firstName} ${owner.lastName}` });
    if (mode === "scheduled_report") return frozen;
    const promoted = await storage.promoteScheduledReportSessionToLive({ schoolId: school.id, sessionId: frozen.id });
    assert.ok(promoted);
    return promoted;
  });
}

async function ordinarySession(group: Group): Promise<TeachingSession> {
  return inSchool(() => storage.createTeachingSession({ groupId: group.id, teacherId: group.teacherId,
    startTime: new Date(Date.now() - 60_000) }));
}

async function inSchoolEvening(action: (data: { schoolDate: string; midnight: Date }) => Promise<void>) {
  // Choose a real IANA zone whose current local hour is 18. This makes an
  // ordinary twelve-hour session cross midnight at every CI execution time.
  let offset = 18 - new Date().getUTCHours();
  if (offset > 14) offset -= 24;
  const eveningZone = offset === 0 ? "Etc/GMT" : `Etc/GMT${offset > 0 ? "-" : "+"}${Math.abs(offset)}`;
  const date = schoolTime.localDateInTimeZone(new Date(), eveningZone);
  const midnight = schoolTime.localDateTimeUtc(schoolTime.addLocalDays(date, 1), "00:00", eveningZone);
  await inSchool(() => database.execute(sql`UPDATE schools SET school_timezone=${eveningZone} WHERE id=${school.id}`));
  try {
    await action({ schoolDate: date, midnight });
  } finally {
    await inSchool(() => database.execute(sql`UPDATE schools SET school_timezone=${timezone} WHERE id=${school.id}`));
  }
}

async function enableRecurringSchedule(group: Group): Promise<Group> {
  const updated = await inSchool(() => storage.updateAdminClassWithTeachers({ groupId: group.id,
    data: { scheduleEnabled: true, blockStartTime: "09:00", blockEndTime: "10:00" }, scheduleChangeActorId: administrator.id }));
  assert.ok(updated);
  return updated;
}

async function studentControl(studentId: string) {
  const control = await inSchool(() => storage.getClasspilotStudentControlState(school.id, studentId));
  assert.ok(control);
  return control;
}

async function manualChoice(session: TeachingSession, studentId: string, hardExpiresAt?: Date) {
  await inSchool(() => storage.replaceClasspilotStudentControlSnapshots({ schoolId: school.id,
    teachingSessionId: session.id, studentIds: [studentId], sourceCommandId: randomUUID(), hardExpiresAt,
    desiredState: { restrictions: { screenLock: { active: true }, flightPath: { active: true, allowedDomains: ["manual.example.org"] },
      blockList: { active: true, blockedDomains: ["blocked.example.org"] }, attentionMode: { active: false }, tabLimit: 3, temporaryAllows: [] } },
  }));
  return studentControl(studentId);
}

async function deliveries(session: TeachingSession) {
  const result = await inSchool(() => database.execute(sql`SELECT id,recipient_kind,recipient_email
    FROM classpilot_session_summary_deliveries WHERE school_id=${school.id} AND teaching_session_id=${session.id}
    ORDER BY recipient_kind,id`));
  return result.rows;
}

async function enabledAuditCount(group: Group) {
  const result = await inSchool(() => database.execute(sql`SELECT count(*)::int AS count FROM audit_logs
    WHERE school_id=${school.id} AND entity_id=${group.id} AND action='class.manual_today_enabled'`));
  return Number(result.rows[0]?.count);
}

async function liveSessionCount(group: Group) {
  const result = await inSchool(() => database.execute(sql`SELECT count(*)::int AS count FROM teaching_sessions
    WHERE school_id=${school.id} AND group_id=${group.id} AND session_mode='live' AND end_time IS NULL`));
  return Number(result.rows[0]?.count);
}

async function endFixtureSessions() {
  if (!school?.id) return;
  const result = await inSchool(() => database.execute(sql`SELECT id FROM teaching_sessions
    WHERE school_id=${school.id} AND end_time IS NULL ORDER BY id`));
  for (const row of result.rows) {
    await inSchool(() => lifecycle.finalizeClasspilotSession({ schoolId: school.id,
      sessionId: String(row.id), reason: "admin_end" }));
  }
  await pushes.flushClasspilotLifecyclePushes();
}

describe("Atomic ClassPilot manual Start/Switch", { concurrency: false }, () => {
  before(async () => {
    ({ default: database } = await import("../src/db.js"));
    storage = await import("../src/services/storage.js");
    lifecycle = await import("../src/services/classpilotSessionLifecycle.js");
    scheduled = await import("../src/services/classpilotScheduledStart.js");
    pushes = await import("../src/services/classpilotLifecyclePushes.js");
    schoolTime = await import("../src/util/schoolTime.js");
    ({ runWithTenantContext: tenant } = await import("../src/middleware/tenantContext.js"));
    ({ signUserToken } = await import("../src/services/jwt.js"));
    school = await system(() => storage.createSchool({ name: tag, domain: `${tag}.example.edu`, slug: tag, schoolTimezone: timezone }));
    administrator = await staff("admin");
    await system(() => storage.createProductLicense({ schoolId: school.id, product: "CLASSPILOT", status: "active" }));
    await inSchool(() => database.execute(sql`INSERT INTO settings(school_id,school_name,ws_shared_key,
      enable_tracking_hours,allow_teacher_manual_today,central_email_recipient_user_id)
      VALUES(${school.id},${tag},'synthetic-only',false,true,${administrator.id})`));
    const { createApp } = await import("../src/app.js");
    server = createServer(createApp());
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  });

  beforeEach(async () => {
    await inSchool(() => database.execute(sql`UPDATE settings SET allow_teacher_manual_today=true WHERE school_id=${school.id}`));
  });

  afterEach(async () => {
    await endFixtureSessions();
    await inSchool(() => database.execute(sql`UPDATE groups SET schedule_enabled=false WHERE school_id=${school.id}`));
  });

  after(async () => {
    try {
      if (server) {
        server.closeIdleConnections();
        await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      }
      await endFixtureSessions();
      if (school?.id) await inSchool(() => database.execute(sql`UPDATE groups SET schedule_enabled=false,status='archived' WHERE school_id=${school.id}`));
      // Real lifecycle guards retain synthetic school/staff roots. All live
      // work is ended and all schedules retired in this disposable fixture DB.
    } finally {
      await (await import("../src/services/errorMonitor.js")).default.disposeAndWait();
      const pools = await import("../src/db.js");
      const schedulerPools = await import("../src/services/schedulerDb.js");
      await Promise.all([pools.pool.end(), pools.sessionPool.end(), schedulerPools.schedulerPool.end(), schedulerPools.schedulerLockPool.end()]);
    }
  });

  it("requires an explicit manual review for a finished scheduled occurrence without mutating it", async () => {
    const actor = await staff();
    const selected = await classroom(actor, { scheduled: true });
    const scheduled = await occurrence(selected);
    await inSchool(() => lifecycle.finalizeClasspilotSession({ schoolId: school.id, sessionId: scheduled.id, reason: "teacher_end" }));
    const before = await currentSession(scheduled);
    const response = await request(actor, { groupId: selected.id });
    assert.equal(response.status, 409);
    assert.equal(response.body.code, "MANUAL_TODAY_REQUIRED");
    assert.equal(response.body.schoolDate, schoolDate());
    assert.equal(response.body.canManageManualToday, true);
    assert.equal((await currentGroup(selected)).scheduleManualDate, null);
    assert.deepEqual(await currentSession(scheduled), before);
    assert.equal(await liveSessionCount(selected), 0);
  });

  it("enables only the selected class and starts it in the same request while preserving its recurring schedule", async () => {
    const actor = await staff();
    const selected = await classroom(actor, { scheduled: true });
    const untouched = await classroom(actor, { scheduled: true });
    const response = await request(actor, review(selected));
    assert.equal(response.status, 201);
    assert.equal(response.body.reused, false);
    assert.equal(response.body.session.groupId, selected.id);
    assert.equal(response.body.session.teacherId, actor.id);
    assert.equal(response.body.session.scheduledDate, null);
    const selectedNow = await currentGroup(selected);
    assert.equal(selectedNow.scheduleManualDate, schoolDate());
    assert.equal(selectedNow.scheduleEnabled, true);
    assert.equal(selectedNow.blockStartTime, selected.blockStartTime);
    assert.equal(selectedNow.blockEndTime, selected.blockEndTime);
    assert.equal((await currentGroup(untouched)).scheduleManualDate, null);
    assert.equal(await enabledAuditCount(selected), 1);
    const expectedMidnight = schoolTime.localDateTimeUtc(schoolTime.addLocalDays(schoolDate(), 1), "00:00", timezone);
    assert.equal(response.body.session.manualExpiresAt, expectedMidnight.toISOString());
    const frozen = await inSchool(() => storage.getScheduledTeachingSessionOccurrence(school.id, selected.id, schoolDate()));
    assert.ok(frozen);
    assert.equal(frozen.scheduledState, "skipped");
    assert.equal(frozen.scheduledFinalizationReason, "manual_override");
  });

  it("switches and finalizes both the old owned class and selected automatic occurrence exactly once", async () => {
    const actor = await staff();
    const previousGroup = await classroom(actor);
    const selected = await classroom(actor, { scheduled: true });
    const automatic = await occurrence(selected);
    const previous = await ordinarySession(previousGroup);
    const response = await request(actor, review(selected, previous.id));
    assert.equal(response.status, 201);
    assert.equal(response.body.reused, false);
    assert.equal(response.body.session.groupId, selected.id);
    assert.notEqual(response.body.session.id, automatic.id);
    assert.ok((await currentSession(previous)).endTime);
    const history = await currentSession(automatic);
    assert.equal(history.id, automatic.id);
    assert.equal(history.scheduledState, "finalized");
    assert.ok(history.endTime);
    const before = await deliveries(automatic);
    assert.deepEqual(before.map(row => row.recipient_kind), ["central", "teacher"]);
    assert.deepEqual(before.map(row => String(row.recipient_email).toLowerCase()).sort(),
      [administrator.email.toLowerCase(), actor.email.toLowerCase()].sort());
    const duplicate = await request(actor, review(selected, previous.id));
    assert.equal(duplicate.status, 200);
    assert.equal(duplicate.body.reused, true);
    assert.equal(duplicate.body.session.id, response.body.session.id);
    assert.deepEqual(await deliveries(automatic), before);
    assert.equal(await enabledAuditCount(selected), 1);
    assert.equal(await liveSessionCount(selected), 1);
  });

  it("rolls back override, scheduled finalization, owned-class finalization and outbox together on start failure", async () => {
    const actor = await staff();
    const previousGroup = await classroom(actor);
    const selected = await classroom(actor, { scheduled: true });
    const automatic = await occurrence(selected);
    const previous = await ordinarySession(previousGroup);
    const automaticBefore = await currentSession(automatic);
    const previousBefore = await currentSession(previous);
    await assert.rejects(inSchool(() => lifecycle.startManualClasspilotSession({ schoolId: school.id,
      teacherId: actor.id, groupId: selected.id, manualToday: { expectedSchoolDate: schoolDate() },
      expectedActiveSessionId: previous.id,
      afterReplacement: async () => { throw new Error("injected combined-start failure"); },
    })), /injected combined-start failure/);
    assert.equal((await currentGroup(selected)).scheduleManualDate, null);
    assert.deepEqual(await currentSession(automatic), automaticBefore);
    assert.deepEqual(await currentSession(previous), previousBefore);
    assert.deepEqual(await deliveries(automatic), []);
    assert.deepEqual(await deliveries(previous), []);
    assert.equal(await enabledAuditCount(selected), 0);
    assert.equal(await liveSessionCount(selected), 1, "only the unchanged automatic class remains live");
  });

  it("rejects a stale reviewed active session before ending or overriding any class", async () => {
    const actor = await staff();
    const previousGroup = await classroom(actor);
    const previous = await ordinarySession(previousGroup);
    const selected = await classroom(actor, { scheduled: true });
    const automatic = await occurrence(selected, "scheduled_report");
    const before = await currentSession(automatic);
    const response = await request(actor, review(selected, null));
    assert.equal(response.status, 409);
    assert.equal(response.body.code, "CLASS_START_REVIEW_STALE");
    assert.equal((await currentSession(previous)).endTime, null);
    assert.deepEqual(await currentSession(automatic), before);
    assert.equal((await currentGroup(selected)).scheduleManualDate, null);
    assert.deepEqual(await deliveries(automatic), []);
    assert.equal(await enabledAuditCount(selected), 0);
  });

  it("rejects a stale school date and extra manual-date authority fields without mutation", async () => {
    const actor = await staff();
    const selected = await classroom(actor, { scheduled: true });
    const stale = await request(actor, { ...review(selected), manualToday: { expectedSchoolDate: "2001-01-01" } });
    assert.equal(stale.status, 409);
    assert.equal(stale.body.code, "MANUAL_TODAY_DATE_CHANGED");
    const extra = await request(actor, { ...review(selected), manualToday: { expectedSchoolDate: schoolDate(), schoolId: "other-school" } });
    assert.equal(extra.status, 400);
    assert.equal((await currentGroup(selected)).scheduleManualDate, null);
    assert.equal(await liveSessionCount(selected), 0);
    assert.equal(await enabledAuditCount(selected), 0);
  });

  it("requires the explicit reviewed active-session field for the new manual action", async () => {
    const actor = await staff();
    const selected = await classroom(actor, { scheduled: true });
    const response = await request(actor, { groupId: selected.id, manualToday: { expectedSchoolDate: schoolDate() } });
    assert.equal(response.status, 400);
    assert.equal(response.body.code, "CLASS_START_REVIEW_INVALID");
    assert.equal((await currentGroup(selected)).scheduleManualDate, null);
    assert.equal(await liveSessionCount(selected), 0);
    assert.equal(await enabledAuditCount(selected), 0);
  });

  it("requires policy and assignment for new overrides while administrators may start an explicit selected class", async () => {
    const actor = await staff();
    const outsider = await staff();
    const selected = await classroom(actor, { scheduled: true });
    await inSchool(() => database.execute(sql`UPDATE settings SET allow_teacher_manual_today=false WHERE school_id=${school.id}`));
    const disabled = await request(actor, review(selected));
    assert.equal(disabled.status, 403);
    assert.equal(disabled.body.code, "MANUAL_TODAY_TEACHER_DISABLED");
    assert.equal((await currentGroup(selected)).scheduleManualDate, null);
    await inSchool(() => database.execute(sql`UPDATE settings SET allow_teacher_manual_today=true WHERE school_id=${school.id}`));
    const unassigned = await request(outsider, review(selected));
    assert.equal(unassigned.status, 403);
    assert.equal((await currentGroup(selected)).scheduleManualDate, null);
    await inSchool(() => database.execute(sql`UPDATE settings SET allow_teacher_manual_today=false WHERE school_id=${school.id}`));
    const admin = await request(administrator, review(selected));
    assert.equal(admin.status, 201);
    assert.equal(admin.body.session.teacherId, administrator.id);
    assert.equal((await currentGroup(selected)).scheduleManualDate, schoolDate());
  });

  it("allows assigned teachers to start an already-enabled override after self-service permission is revoked", async () => {
    const actor = await staff();
    const selected = await classroom(actor, { scheduled: true });
    await inSchool(() => storage.enableClasspilotManualToday({ schoolId: school.id, actorId: administrator.id,
      groupId: selected.id, expectedSchoolDate: schoolDate() }));
    await inSchool(() => database.execute(sql`UPDATE settings SET allow_teacher_manual_today=false WHERE school_id=${school.id}`));
    const first = await request(actor, review(selected));
    assert.equal(first.status, 201);
    assert.equal(first.body.session.teacherId, actor.id);
    const repeat = await request(actor, review(selected));
    assert.equal(repeat.status, 200);
    assert.equal(repeat.body.reused, true);
    assert.equal(repeat.body.session.id, first.body.session.id);
    assert.equal(await enabledAuditCount(selected), 1);
  });

  it("reuses one shared manual class for concurrent primary/co-teacher reviews without duplicate sessions", async () => {
    const actor = await staff();
    const coTeacher = await staff();
    const selected = await classroom(actor, { scheduled: true });
    await inSchool(() => storage.addGroupTeacher(selected.id, coTeacher.id, "co-teacher"));
    const responses = await Promise.all([request(actor, review(selected)), request(coTeacher, review(selected))]);
    assert.deepEqual(responses.map(response => response.status).sort(), [200, 201]);
    assert.equal(responses[0]!.body.session.id, responses[1]!.body.session.id);
    assert.equal(responses.filter(response => response.body.reused === false).length, 1);
    assert.equal(responses.filter(response => response.body.reused === true).length, 1);
    assert.equal(await liveSessionCount(selected), 1);
    assert.equal(await enabledAuditCount(selected), 1);
    const staffRows = await inSchool(() => database.execute(sql`SELECT staff_id FROM classpilot_session_staff
      WHERE school_id=${school.id} AND teaching_session_id=${responses[0]!.body.session.id} ORDER BY staff_id`));
    assert.deepEqual(staffRows.rows.map(row => row.staff_id).sort(), [actor.id, coTeacher.id].sort());
  });

  it("does not reuse a shared target over a newer owned class until that replacement is freshly reviewed", async () => {
    const actor = await staff();
    const coTeacher = await staff();
    const selected = await classroom(actor, { scheduled: true });
    await inSchool(() => storage.addGroupTeacher(selected.id, coTeacher.id, "co-teacher"));
    const target = await request(actor, review(selected));
    assert.equal(target.status, 201);
    const other = await classroom(coTeacher);
    const owned = await ordinarySession(other);
    const stale = await request(coTeacher, review(selected, null));
    assert.equal(stale.status, 409);
    assert.equal(stale.body.code, "CLASS_START_REVIEW_STALE");
    assert.equal((await currentSession(owned)).endTime, null);
    const fresh = await request(coTeacher, review(selected, owned.id));
    assert.equal(fresh.status, 200);
    assert.equal(fresh.body.reused, true);
    assert.equal(fresh.body.session.id, target.body.session.id);
    assert.ok((await currentSession(owned)).endTime);
    assert.equal(await liveSessionCount(selected), 1);
  });

  it("keeps the override and current owner unchanged until the combined review acknowledges roster overlap", async () => {
    const actor = await staff();
    const otherTeacher = await staff();
    const studentId = await student();
    const other = await classroom(otherTeacher, { students: [studentId] });
    const ownedElsewhere = await ordinarySession(other);
    const selected = await classroom(actor, { scheduled: true, students: [studentId] });
    const blocked = await request(actor, review(selected));
    assert.equal(blocked.status, 409);
    assert.equal(blocked.body.code, "CLASS_ROSTER_ACTIVE_OVERLAP");
    assert.equal(blocked.body.totalOverlapCount, 1);
    assert.equal(blocked.body.groups[0]?.sessionId, ownedElsewhere.id);
    assert.equal((await currentGroup(selected)).scheduleManualDate, null);
    assert.equal((await currentSession(ownedElsewhere)).endTime, null);
    assert.equal(await enabledAuditCount(selected), 0);
    const accepted = await request(actor, { ...review(selected), acknowledgeOverlap: true });
    assert.equal(accepted.status, 201);
    assert.equal((await currentGroup(selected)).scheduleManualDate, schoolDate());
    assert.equal((await currentSession(ownedElsewhere)).endTime, null,
      "acknowledging student handoff never ends another teacher's whole class");
    const control = await inSchool(() => storage.getClasspilotStudentControlState(school.id, studentId));
    assert.equal(control?.teachingSessionId, accepted.body.session.id);
  });

  it("rejects a stale ordinary scheduled switch without promoting its reporting occurrence", async () => {
    const actor = await staff();
    const previousGroup = await classroom(actor);
    const previous = await ordinarySession(previousGroup);
    const selected = await classroom(actor, { scheduled: true });
    const reporting = await occurrence(selected, "scheduled_report");
    const response = await request(actor, { groupId: selected.id, expectedActiveSessionId: null });
    assert.equal(response.status, 409);
    assert.equal(response.body.code, "CLASS_START_REVIEW_STALE");
    assert.equal((await currentSession(previous)).endTime, null);
    assert.equal((await currentSession(reporting)).sessionMode, "scheduled_report");
    assert.equal((await currentGroup(selected)).scheduleManualDate, null);
  });

  it("a co-teacher's reviewed switch to an already-live scheduled class ends only that actor's owned class", async () => {
    const primary = await staff();
    const coTeacher = await staff();
    const selected = await classroom(primary, { scheduled: true });
    await inSchool(() => storage.addGroupTeacher(selected.id, coTeacher.id, "co-teacher"));
    const automatic = await occurrence(selected);
    const primaryOther = await classroom(primary);
    const primaryOwned = await ordinarySession(primaryOther);
    const coOther = await classroom(coTeacher);
    const coOwned = await ordinarySession(coOther);
    const response = await request(coTeacher, { groupId: selected.id, expectedActiveSessionId: coOwned.id });
    assert.equal(response.status, 200);
    assert.equal(response.body.session.id, automatic.id);
    assert.ok((await currentSession(coOwned)).endTime);
    assert.equal((await currentSession(primaryOwned)).endTime, null);
    assert.equal((await currentSession(automatic)).endTime, null);
    assert.equal(await liveSessionCount(selected), 1);
    assert.equal((await currentGroup(selected)).scheduleManualDate, null);
  });

  it("an unaffected class's automatic bell still replaces the teacher's selected manual class", async () => {
    const actor = await staff();
    const selected = await classroom(actor, { scheduled: true });
    const manual = await request(actor, review(selected));
    assert.equal(manual.status, 201);
    const other = await classroom(actor, { scheduled: true });
    const reporting = await occurrence(other, "scheduled_report");
    const started = await inSchool(() => scheduled.processScheduledClassAutoStart({ group: other,
      scheduledDate: schoolDate(), now: new Date(), scheduledTeacherConnectedOverride: true }));
    assert.equal(started.status, "started");
    if (started.status !== "started") assert.fail("the unaffected automatic class must start");
    assert.equal(started.session.id, reporting.id);
    const previous = await inSchool(() => storage.getTeachingSessionByIdAndSchool(manual.body.session.id, school.id));
    assert.ok(previous?.endTime);
    assert.equal((await currentGroup(selected)).scheduleManualDate, schoolDate());
    assert.equal((await currentGroup(other)).scheduleManualDate, null);
  });

  it("rechecks the frozen scheduled roster under the start transaction after the current class roster changes", async () => {
    const actor = await staff();
    const otherTeacher = await staff();
    const studentId = await student();
    const previousGroup = await classroom(actor);
    const previous = await ordinarySession(previousGroup);
    const selected = await classroom(actor, { scheduled: true, students: [studentId] });
    const reporting = await occurrence(selected, "scheduled_report");
    await inSchool(() => storage.removeGroupStudent(selected.id, studentId));
    assert.deepEqual(await inSchool(() => storage.getGroupStudents(selected.id)), []);
    const frozenRoster = await inSchool(() => storage.getClasspilotSessionStudentRoster(school.id, reporting.id));
    assert.deepEqual(frozenRoster.map(row => row.studentId), [studentId]);
    const other = await classroom(otherTeacher, { students: [studentId] });
    const heldElsewhere = await ordinarySession(other);
    // Call the canonical scheduled transition directly: an HTTP precheck is
    // deliberately absent, reproducing ownership that changed after a review.
    // The empty current roster must not conceal the frozen student's handoff.
    await assert.rejects(inSchool(() => scheduled.processScheduledClassAutoStart({ group: selected,
      scheduledDate: schoolDate(), now: new Date(), scheduledTeacherConnectedOverride: true,
      reviewedStart: { actorId: actor.id, expectedActiveSessionId: previous.id },
    })), (error: unknown) => {
      assert.equal((error as { code?: string }).code, "CLASS_ROSTER_ACTIVE_OVERLAP");
      return true;
    });
    assert.equal((await currentSession(reporting)).sessionMode, "scheduled_report");
    assert.equal((await currentSession(previous)).endTime, null);
    assert.equal((await currentSession(heldElsewhere)).endTime, null);
    assert.equal((await inSchool(() => storage.getClasspilotStudentControlState(school.id, studentId)))?.teachingSessionId, heldElsewhere.id);
    const accepted = await inSchool(() => scheduled.processScheduledClassAutoStart({ group: selected,
      scheduledDate: schoolDate(), now: new Date(), scheduledTeacherConnectedOverride: true,
      reviewedStart: { actorId: actor.id, expectedActiveSessionId: previous.id, acknowledgeOverlap: true },
    }));
    assert.equal(accepted.status, "started");
    assert.ok((await currentSession(previous)).endTime);
    assert.equal((await currentSession(heldElsewhere)).endTime, null);
    assert.equal((await currentSession(reporting)).sessionMode, "live");
  });

  it("caps a reused ordinary manual session at midnight after a real recurring-schedule change and combined review", async () => {
    await inSchoolEvening(async ({ schoolDate: date, midnight }) => {
      const actor = await staff();
      const studentId = await student();
      const selected = await classroom(actor, { students: [studentId] });
      const legacy = await ordinarySession(selected);
      assert.equal(legacy.manualExpiresAt, null);
      assert.ok(legacy.startTime.getTime() + 12 * 3_600_000 > midnight.getTime());
      const before = await manualChoice(legacy, studentId);
      await enableRecurringSchedule(selected);
      assert.equal((await currentSession(legacy)).endTime, null, "the supported schedule writer retains an ordinary active session");
      const response = await request(actor, { groupId: selected.id, expectedActiveSessionId: legacy.id,
        manualToday: { expectedSchoolDate: date } });
      assert.equal(response.status, 200);
      assert.equal(response.body.reused, true);
      assert.equal(response.body.session.id, legacy.id);
      assert.equal(response.body.session.manualExpiresAt, midnight.toISOString());
      const bounded = await currentSession(legacy);
      assert.equal(bounded.startTime.toISOString(), legacy.startTime.toISOString());
      assert.equal(bounded.automaticFlightPathState, null, "reusing old manual work never initializes a future class preset");
      assert.equal(bounded.manualExpiresAt?.toISOString(), midnight.toISOString());
      const control = await studentControl(studentId);
      assert.equal(control.hardExpiresAt?.toISOString(), midnight.toISOString());
      assert.deepEqual(control.desiredState, before.desiredState);
      assert.equal(control.sourceCommandId, before.sourceCommandId);
      assert.equal(control.revision, before.revision + 1, "the shorter deadline is a new delivery revision");
      assert.equal(classpilotTeachingSessionIsCurrent(bounded, new Date(midnight.getTime() - 1)), true);
      assert.equal(classpilotTeachingSessionIsCurrent(bounded, midnight), false);
      const owners = await inSchool(() => storage.getActiveClassOwnersForStudents(school.id, [studentId], undefined, midnight));
      assert.equal(owners.some(owner => owner.session.id === legacy.id), false, "row cleanup is not required to revoke midnight authority");
      const retry = await request(actor, { groupId: selected.id, expectedActiveSessionId: legacy.id,
        manualToday: { expectedSchoolDate: date } });
      assert.equal(retry.status, 200);
      assert.equal(retry.body.session.id, legacy.id);
      assert.deepEqual(await studentControl(studentId), control, "a retry does not manufacture another control revision");
    });
  });

  it("standalone Manual today caps existing work before a normal Start reuses its identity and choices", async () => {
    await inSchoolEvening(async ({ schoolDate: date, midnight }) => {
      const actor = await staff();
      const studentId = await student();
      const selected = await classroom(actor, { students: [studentId] });
      const legacy = await ordinarySession(selected);
      const before = await manualChoice(legacy, studentId);
      await enableRecurringSchedule(selected);
      const enabled = await request(actor, { expectedSchoolDate: date }, `/classpilot/groups/${selected.id}/manual-today`);
      assert.equal(enabled.status, 200);
      assert.equal((await currentSession(legacy)).manualExpiresAt?.toISOString(), midnight.toISOString(),
        "enabling alone must bound the existing session even if the browser never starts again");
      const control = await studentControl(studentId);
      assert.equal(control.hardExpiresAt?.toISOString(), midnight.toISOString());
      assert.deepEqual(control.desiredState, before.desiredState);
      assert.equal(control.sourceCommandId, before.sourceCommandId);
      assert.equal(enabled.body.deadlineUpdatedSessionIds, undefined, "internal publication metadata stays server-only");
      const response = await request(actor, { groupId: selected.id, expectedActiveSessionId: legacy.id });
      assert.equal(response.status, 200);
      assert.equal(response.body.reused, true);
      assert.equal(response.body.session.id, legacy.id);
      assert.equal(response.body.session.manualExpiresAt, midnight.toISOString());
      assert.deepEqual(await studentControl(studentId), control);
    });
  });

  it("co-teacher deadline reuse preserves an off preset and never acquires students held by another class or supervision", async () => {
    await inSchoolEvening(async ({ schoolDate: date, midnight }) => {
      const primary = await staff();
      const coTeacher = await staff();
      const thirdTeacher = await staff();
      const [ownStudent, thirdClassStudent, supervisedStudent] = await Promise.all([student(), student(), student()]);
      const selected = await classroom(primary, { students: [ownStudent, thirdClassStudent, supervisedStudent] });
      await inSchool(() => storage.addGroupTeacher(selected.id, coTeacher.id, "co-teacher"));
      const legacy = await ordinarySession(selected);
      const ownBefore = await manualChoice(legacy, ownStudent);
      const off = { ...emptyAutomaticFlightPathState(), status: "off" as const, revision: 7 };
      // Existing off metadata is immutable teacher intent across this
      // compatibility transition, just like existing manual restrictions.
      await inSchool(() => database.execute(sql`UPDATE teaching_sessions SET automatic_flight_path_state=${JSON.stringify(off)}::jsonb
        WHERE school_id=${school.id} AND id=${legacy.id}`));
      const other = await classroom(thirdTeacher, { students: [thirdClassStudent] });
      const thirdSession = await ordinarySession(other);
      const supervision = await inSchool(() => storage.createSupervisionContextWithStudents({ context: {
        schoolId: school.id, name: "Deadline reuse supervision", contextType: "coverage_group", assignedStaffId: thirdTeacher.id,
        createdBy: thirdTeacher.id, startsAt: new Date(Date.now() - 1_000), endsAt: new Date(Date.now() + 3_600_000),
      }, studentIds: [supervisedStudent], assignedBy: thirdTeacher.id }));
      try {
        const thirdBefore = await studentControl(thirdClassStudent);
        const supervisionBefore = await studentControl(supervisedStudent);
        assert.equal(thirdBefore.teachingSessionId, thirdSession.id);
        assert.equal(supervisionBefore.supervisionContextId, supervision.id);
        await enableRecurringSchedule(selected);
        const response = await request(coTeacher, { groupId: selected.id, expectedActiveSessionId: legacy.id,
          manualToday: { expectedSchoolDate: date } });
        assert.equal(response.status, 200);
        assert.equal(response.body.reused, true);
        assert.equal(response.body.session.id, legacy.id);
        assert.equal(response.body.session.teacherId, primary.id);
        const bounded = await currentSession(legacy);
        assert.equal(bounded.manualExpiresAt?.toISOString(), midnight.toISOString());
        assert.deepEqual(bounded.automaticFlightPathState, off);
        const ownAfter = await studentControl(ownStudent);
        assert.equal(ownAfter.hardExpiresAt?.toISOString(), midnight.toISOString());
        assert.deepEqual(ownAfter.desiredState, ownBefore.desiredState);
        assert.equal(ownAfter.sourceCommandId, ownBefore.sourceCommandId);
        assert.deepEqual(await studentControl(thirdClassStudent), thirdBefore);
        assert.deepEqual(await studentControl(supervisedStudent), supervisionBefore);
        assert.equal((await currentSession(thirdSession)).endTime, null);
      } finally {
        await inSchool(() => storage.releaseSupervisionStudents({ schoolId: school.id, contextId: supervision.id,
          studentIds: [supervisedStudent], releaseReason: "returned" }));
      }
    });
  });

  it("retains earlier existing session and per-student deadlines instead of extending them to midnight", async () => {
    await inSchoolEvening(async ({ schoolDate: date, midnight }) => {
      for (const existingManualLimit of [false, true]) {
        const actor = await staff();
        const studentId = await student();
        const selected = await classroom(actor, { students: [studentId] });
        const startTime = new Date(Date.now() - (existingManualLimit ? 60_000 : 11 * 3_600_000));
        const expectedSessionLimit = existingManualLimit
          ? new Date(Date.now() + 2 * 3_600_000)
          : new Date(startTime.getTime() + 12 * 3_600_000);
        assert.ok(expectedSessionLimit < midnight);
        const legacy = await inSchool(() => storage.createTeachingSession({ groupId: selected.id, teacherId: actor.id,
          startTime, ...(existingManualLimit ? { manualExpiresAt: expectedSessionLimit } : {}) }));
        const earlierControlLimit = new Date(Date.now() + 30 * 60_000);
        const before = await manualChoice(legacy, studentId, earlierControlLimit);
        await enableRecurringSchedule(selected);
        const response = await request(actor, { groupId: selected.id, expectedActiveSessionId: legacy.id,
          manualToday: { expectedSchoolDate: date } });
        assert.equal(response.status, 200);
        assert.equal(response.body.session.id, legacy.id);
        assert.equal(response.body.session.manualExpiresAt, expectedSessionLimit.toISOString());
        assert.deepEqual(await studentControl(studentId), before, "an already earlier student cap is unchanged, including its revision");
        const retry = await request(actor, { groupId: selected.id, expectedActiveSessionId: legacy.id,
          manualToday: { expectedSchoolDate: date } });
        assert.equal(retry.status, 200);
        assert.equal(retry.body.session.manualExpiresAt, expectedSessionLimit.toISOString());
        assert.deepEqual(await studentControl(studentId), before);
      }
    });
  });
});
