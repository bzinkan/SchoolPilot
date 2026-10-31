import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { writeFile } from "node:fs/promises";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import { and, eq, sql } from "drizzle-orm";
import type { Group, TeachingSession } from "../src/schema/classpilot.js";
import type { School, User } from "../src/schema/core.js";
import type { TodayScheduleInput } from "../src/services/classpilotTodayScheduleModel.js";
import { emptyAutomaticFlightPathState } from "../src/services/classpilotAutomaticFlightPath.js";

process.env.REDIS_URL = "";
process.env.SENDGRID_API_KEY = "";
process.env.CLASSPILOT_TODAY_SCHEDULE_MODE = "on";
process.env.RLS_GUC_ENABLED = "true";
process.env.RLS_ENABLED_TABLES = [...new Set([...(process.env.RLS_ENABLED_TABLES || "").split(",").filter(Boolean),
  "classpilot_today_changes", "classpilot_today_occurrences"])].join(",");

let database: typeof import("../src/db.js").default;
let storage: typeof import("../src/services/storage.js");
let lifecycle: typeof import("../src/services/classpilotSessionLifecycle.js");
let service: typeof import("../src/services/classpilotTodaySchedule.js");
let schema: typeof import("../src/schema/classpilot.js");
let tenant: typeof import("../src/middleware/tenantContext.js").runWithTenantContext;
let schoolTime: typeof import("../src/util/schoolTime.js");
let school: School, administrator: User, firstTeacher: User, counterpart: User;
let first: Group, selected: Group, counterpartFirst: Group, counterpartSelected: Group;
let schoolDate: string, timeZone: string;
let server: Server, baseUrl: string;
const firstStart = "09:45", firstEnd = "11:30", laterStart = "12:00", laterEnd = "12:50";
const inSchool = <T>(operation: () => Promise<T>) => tenant({ schoolId: school.id }, operation);
const system = <T>(operation: () => Promise<T>) => tenant({ isSuper: true }, operation);
const at = (time: string) => schoolTime.localDateTimeUtc(schoolDate, time, timeZone);
const context = (actor = firstTeacher) => ({ schoolId: school.id, actorId: actor.id });
const input = (action: "swap" | "skip" = "swap"): TodayScheduleInput => ({ expectedSchoolDate: schoolDate,
  currentGroupId: first.id, ...(action === "swap" ? { selectedGroupId: selected.id } : {}), action });

async function staff(role: "teacher" | "admin" = "teacher") {
  return system(async () => {
    const user = await storage.createUser({ email: `${randomUUID()}@today-schedule.example.edu`, firstName: "Synthetic", lastName: role });
    await storage.createMembership({ schoolId: school.id, userId: user.id, role, status: "active" });
    return user;
  });
}
async function student() {
  return inSchool(() => storage.createStudent({ schoolId: school.id, firstName: "Synthetic", lastName: "Student",
    email: `${randomUUID()}@today-schedule.example.edu`, status: "active" }));
}
async function classroom(owner: User, name: string, studentIds: string[], start: string, end: string) {
  return inSchool(async () => {
    const group = await storage.createGroup({ schoolId: school.id, teacherId: owner.id, name,
      groupType: "admin_class", status: "active", scheduleEnabled: false });
    await storage.addGroupStudentsDetailed(group.id, studentIds);
    await database.execute(sql`UPDATE groups SET schedule_enabled=true,block_start_time=${start},block_end_time=${end}
      WHERE school_id=${school.id} AND id=${group.id}`);
    const saved = await storage.getGroupByIdAndSchool(group.id, school.id);
    assert.ok(saved);
    return saved;
  });
}
async function review(body = input(), actor = firstTeacher) {
  const result = await inSchool(() => service.previewClasspilotTodaySchedule({ ...context(actor), input: body }));
  assert.equal(result.canApply, true, JSON.stringify(result.blockers));
  assert.ok("reviewToken" in result && typeof result.reviewToken === "string");
  assert.ok("expiresAt" in result && typeof result.expiresAt === "string");
  const token = reviewToken(result);
  return { ...result, reviewToken: token, expiresAt: result.expiresAt };
}
function reviewToken(value: unknown): string {
  assert.ok(value && typeof value === "object" && "reviewToken" in value && typeof value.reviewToken === "string");
  return value.reviewToken;
}
async function apply(body = input(), actor = firstTeacher) {
  const reviewed = await review(body, actor);
  return inSchool(() => service.createClasspilotTodayScheduleChange({ ...context(actor), reviewToken: reviewed.reviewToken,
    idempotencyKey: randomUUID() }));
}
async function occurrence(group: Group, live = true) {
  return inSchool(async () => {
    const owner = await storage.getUserById(group.teacherId);
    assert.ok(owner);
    const report = await storage.createOrReuseScheduledReportSession({ schoolId: school.id, groupId: group.id,
      teacherId: group.teacherId, scheduledDate: schoolDate, scheduledTimezone: timeZone,
      scheduledStartAt: at(group.blockStartTime!), scheduledEndAt: at(group.blockEndTime!),
      scheduledTeacherEmail: owner.email, scheduledTeacherName: "Synthetic teacher" });
    if (!live) return report;
    const promoted = await storage.promoteScheduledReportSessionToLive({ schoolId: school.id, sessionId: report.id });
    assert.ok(promoted);
    return promoted;
  });
}
async function savedSession(session: TeachingSession) {
  const saved = await inSchool(() => storage.getTeachingSessionByIdAndSchool(session.id, school.id));
  assert.ok(saved);
  return saved;
}
async function rows() {
  return inSchool(async () => ({
    changes: await database.select().from(schema.classpilotTodayChanges).where(eq(schema.classpilotTodayChanges.schoolId, school.id)),
    occurrences: await database.select().from(schema.classpilotTodayOccurrences).where(eq(schema.classpilotTodayOccurrences.schoolId, school.id)),
    sessions: await database.select().from(schema.teachingSessions).where(eq(schema.teachingSessions.schoolId, school.id)),
  }));
}

describe("Reviewed reciprocal Today schedule changes", { concurrency: false }, () => {
  before(async () => {
    ({ default: database } = await import("../src/db.js"));
    storage = await import("../src/services/storage.js");
    lifecycle = await import("../src/services/classpilotSessionLifecycle.js");
    service = await import("../src/services/classpilotTodaySchedule.js");
    schema = await import("../src/schema/classpilot.js");
    schoolTime = await import("../src/util/schoolTime.js");
    ({ runWithTenantContext: tenant } = await import("../src/middleware/tenantContext.js"));
    const { createApp } = await import("../src/app.js");
    server = createServer(createApp());
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address(); assert.ok(address && typeof address !== "string");
    baseUrl = `http://127.0.0.1:${address.port}/api/classpilot/today-schedule`;
  });
  async function seedFixture() {
    // The real school clock is always between 10:00 and 10:59, independent of
    // UTC execution time; no global Date or database-clock mocking is needed.
    let offset = 10 - new Date().getUTCHours();
    if (offset < -12) offset += 24;
    if (offset > 14) offset -= 24;
    timeZone = offset === 0 ? "Etc/GMT" : `Etc/GMT${offset > 0 ? "-" : "+"}${Math.abs(offset)}`;
    schoolDate = schoolTime.localDateInTimeZone(new Date(), timeZone);
    const tag = `today_schedule_${randomUUID()}`;
    school = await system(() => storage.createSchool({ name: tag, slug: tag, domain: "today-schedule.example.edu", schoolTimezone: timeZone }));
    administrator = await staff("admin"); firstTeacher = await staff(); counterpart = await staff();
    await system(() => storage.createProductLicense({ schoolId: school.id, product: "CLASSPILOT", status: "active" }));
    await inSchool(() => database.execute(sql`INSERT INTO settings(school_id,school_name,ws_shared_key,allow_teacher_manual_today,
      enable_tracking_hours,tracking_start_time,tracking_end_time,tracking_days,after_hours_mode,central_email_recipient_user_id)
      VALUES(${school.id},${tag},'synthetic-only',true,true,'00:00','23:59',
      ARRAY['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday'],'off',${administrator.id})`));
    const { classpilotSchoolSchedules } = await import("../src/schema/classpilotScheduling.js");
    const { emptySchoolSchedulingConfig } = await import("../src/services/classpilotSchedulingRules.js");
    await inSchool(() => database.insert(classpilotSchoolSchedules).values({ schoolId: school.id,
      config: { ...emptySchoolSchedulingConfig(), dateOverrides: { [schoolDate]: { instructional: true, meetingWeekday: 1 } } } }));
    const [x, y] = await Promise.all([student(), student()]);
    first = await classroom(firstTeacher, "Vatter8", [x.id], firstStart, firstEnd);
    selected = await classroom(firstTeacher, "Vatter7", [y.id], laterStart, laterEnd);
    counterpartFirst = await classroom(counterpart, "Wendell7", [y.id], firstStart, firstEnd);
    counterpartSelected = await classroom(counterpart, "Wendell8", [x.id], laterStart, laterEnd);
  }
  beforeEach(seedFixture);
  afterEach(async () => {
    if (!school) return;
    const current = await rows();
    for (const session of current.sessions.filter(row => !row.endTime)) await inSchool(() => lifecycle.finalizeClasspilotSession({
      schoolId: school.id, sessionId: session.id, reason: "admin_end" }));
    await inSchool(() => database.execute(sql`UPDATE groups SET schedule_enabled=false,status='archived' WHERE school_id=${school.id}`));
    await (await import("../src/services/classpilotLifecyclePushes.js")).flushClasspilotLifecyclePushes();
  });
  after(async () => {
    if (server) {
      server.closeIdleConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
    if (process.env.TODAY_SCHEDULE_BROWSER_FIXTURE_FILE) {
      await seedFixture();
      const start = new Date(Date.now() + 5 * 60_000), end = new Date(Date.now() + 15 * 60_000);
      const later = new Date(Date.now() + 20 * 60_000), laterFinish = new Date(Date.now() + 35 * 60_000);
      const localTime = (date: Date) => date.toLocaleString("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", hour12: false }).replace(/^24:/, "00:");
      await inSchool(() => database.execute(sql`UPDATE groups SET
        block_start_time=CASE WHEN id IN (${first.id},${counterpartFirst.id}) THEN ${localTime(start)} ELSE ${localTime(later)} END,
        block_end_time=CASE WHEN id IN (${first.id},${counterpartFirst.id}) THEN ${localTime(end)} ELSE ${localTime(laterFinish)} END
        WHERE school_id=${school.id}`));
      const { signUserToken } = await import("../src/services/jwt.js");
      const credential = (user: User) => ({ userId: user.id, email: user.email,
        token: signUserToken({ userId: user.id, email: user.email, isSuperAdmin: user.isSuperAdmin }) });
      await writeFile(process.env.TODAY_SCHEDULE_BROWSER_FIXTURE_FILE, JSON.stringify({ schoolId: school.id, schoolDate, timeZone,
        initiator: credential(firstTeacher), counterpart: credential(counterpart), administrator: credential(administrator),
        currentGroupId: first.id, selectedGroupId: selected.id, counterpartCurrentGroupId: counterpartFirst.id,
        counterpartSelectedGroupId: counterpartSelected.id, firstStartsAt: start.toISOString(), firstEndsAt: end.toISOString(),
        laterStartsAt: later.toISOString(), laterEndsAt: laterFinish.toISOString(), apiPort: 4017, vitePort: 5189 }, null, 2));
    }
    await (await import("../src/services/errorMonitor.js")).default.disposeAndWait();
    const pools = await import("../src/db.js"), scheduler = await import("../src/services/schedulerDb.js");
    await Promise.all([pools.pool.end(), pools.sessionPool.end(), scheduler.schedulerPool.end(), scheduler.schedulerLockPool.end()]);
  });

  it("scopes the real route to assigned classes and rejects authority fields in request bodies", async () => {
    const { signUserToken } = await import("../src/services/jwt.js");
    const headers = { authorization: `Bearer ${signUserToken({ userId: firstTeacher.id, email: firstTeacher.email, isSuperAdmin: false })}`,
      "x-school-id": school.id, "content-type": "application/json" };
    const response = await fetch(baseUrl, { headers }); assert.equal(response.status, 200);
    const result: unknown = await response.json();
    assert.ok(result && typeof result === "object" && "classes" in result && Array.isArray(result.classes));
    assert.equal(result.classes.length, 2);
    const ids = result.classes.map((row: unknown) => {
      assert.ok(row && typeof row === "object" && "groupId" in row && typeof row.groupId === "string");
      return row.groupId;
    });
    assert.deepEqual(ids.sort(), [first.id, selected.id].sort());
    const malicious = await fetch(`${baseUrl}/preview`, { method: "POST", headers, body: JSON.stringify({ ...input(), schoolId: randomUUID() }) });
    assert.equal(malicious.status, 400);
    const unassigned = await fetch(`${baseUrl}/preview`, { method: "POST", headers,
      body: JSON.stringify({ ...input(), currentGroupId: counterpartFirst.id }) });
    assert.equal(unassigned.status, 403); assert.equal((await rows()).changes.length, 0);
  });

  it("applies four future entries atomically with unequal periods, keeps recurring times, and retries idempotently", async () => {
    await inSchool(() => database.execute(sql`UPDATE groups SET block_start_time=CASE WHEN id IN (${first.id},${counterpartFirst.id}) THEN '11:45' ELSE '13:00' END,
      block_end_time=CASE WHEN id IN (${first.id},${counterpartFirst.id}) THEN '12:35' ELSE '14:30' END WHERE school_id=${school.id}`));
    const reviewed = await review();
    assert.equal("mode" in reviewed && reviewed.mode, "before_bell");
    const options = { ...context(), reviewToken: reviewed.reviewToken, idempotencyKey: randomUUID() };
    const result = await inSchool(() => service.createClasspilotTodayScheduleChange(options));
    assert.equal(result.change.status, "applied");
    assert.equal((await inSchool(() => service.createClasspilotTodayScheduleChange(options))).change.id, result.change.id);
    const current = await rows();
    assert.equal(current.changes.length, 1); assert.equal(current.occurrences.length, 4); assert.equal(current.sessions.length, 0);
    assert.equal(current.occurrences.find(row => row.groupId === first.id)!.scheduledStartAt!.getTime(), at("13:00").getTime());
    assert.equal((await inSchool(() => storage.getGroupByIdAndSchool(first.id, school.id)))!.blockStartTime, "11:45");
  });

  it("replaces only the remainder, preserves earlier history/outbox, and leaves the inactive counterpart reporting-only", async () => {
    const old = await occurrence(first);
    await occurrence(counterpartFirst, false);
    const reviewed = await review(); assert.equal(reviewed.requiresAcceptance, false);
    const startedAt = Date.now();
    await inSchool(() => service.createClasspilotTodayScheduleChange({ ...context(), reviewToken: reviewed.reviewToken, idempotencyKey: randomUUID() }));
    const current = await rows();
    const ended = await savedSession(old);
    assert.ok(ended.endTime); assert.equal(ended.startTime.getTime(), at(firstStart).getTime());
    const incoming = current.sessions.find(row => row.groupId === selected.id && row.scheduledOccurrenceId);
    assert.ok(incoming); assert.equal(incoming.sessionMode, "live"); assert.ok(incoming.startTime.getTime() >= startedAt);
    assert.equal(incoming.scheduledEndAt!.getTime(), at(firstEnd).getTime());
    assert.equal(current.sessions.find(row => row.groupId === counterpartSelected.id && row.scheduledOccurrenceId)!.sessionMode, "scheduled_report");
    const delivery = await inSchool(() => database.execute(sql`SELECT recipient_kind FROM classpilot_session_summary_deliveries
      WHERE school_id=${school.id} AND teaching_session_id=${old.id} ORDER BY recipient_kind`));
    assert.deepEqual(delivery.rows.map(row => row.recipient_kind), ["central", "teacher"]);
  });

  it("requires exact live counterpart consent, with no effective changes while pending", async () => {
    const old = await occurrence(first), other = await occurrence(counterpartFirst);
    const reviewed = await review(); assert.equal(reviewed.requiresAcceptance, true);
    const requested = await inSchool(() => service.createClasspilotTodayScheduleChange({ ...context(), reviewToken: reviewed.reviewToken, idempotencyKey: randomUUID() }));
    assert.equal(requested.change.status, "pending"); assert.equal((await rows()).occurrences.length, 0);
    assert.equal((await savedSession(old)).endTime, null); assert.equal((await savedSession(other)).endTime, null);
    const detail = await inSchool(() => service.getClasspilotTodayScheduleChange({ ...context(counterpart), changeId: requested.change.id }));
    const acceptanceToken = reviewToken(detail.preview);
    const accepted = await inSchool(() => service.actOnClasspilotTodayScheduleChange({ ...context(counterpart), changeId: requested.change.id,
      expectedRevision: requested.change.revision, action: "accept", reviewToken: acceptanceToken }));
    assert.equal(accepted.change.status, "applied");
    const live = (await rows()).sessions.filter(row => row.scheduledOccurrenceId && row.sessionMode === "live" && !row.endTime);
    assert.deepEqual(live.map(row => row.groupId).sort(), [selected.id, counterpartSelected.id].sort());
  });

  it("allows immutable live co-teacher staff to accept while denying a newly assigned nonfrozen co-teacher", async () => {
    const frozenCoTeacher = await staff(), newlyAssigned = await staff();
    await inSchool(() => storage.addGroupTeacher(counterpartFirst.id, frozenCoTeacher.id, "co-teacher"));
    await inSchool(() => storage.addGroupTeacher(counterpartSelected.id, frozenCoTeacher.id, "co-teacher"));
    const other = await occurrence(counterpartFirst);
    await inSchool(() => storage.addGroupTeacher(counterpartFirst.id, newlyAssigned.id, "co-teacher"));
    await inSchool(() => storage.addGroupTeacher(counterpartSelected.id, newlyAssigned.id, "co-teacher"));
    const requested = await apply(); assert.equal(requested.change.status, "pending");
    const denied = await inSchool(() => service.getClasspilotTodayScheduleChange({ ...context(newlyAssigned), changeId: requested.change.id }));
    assert.equal(denied.change.canAccept, false); assert.equal(denied.change.canDecline, false);
    await assert.rejects(inSchool(() => service.actOnClasspilotTodayScheduleChange({ ...context(newlyAssigned), changeId: requested.change.id,
      expectedRevision: requested.change.revision, action: "accept" })), { code: "TODAY_SCHEDULE_FORBIDDEN" });
    assert.equal((await savedSession(other)).endTime, null);
    const authorized = await inSchool(() => service.getClasspilotTodayScheduleChange({ ...context(frozenCoTeacher), changeId: requested.change.id }));
    assert.equal(authorized.change.canAccept, true); assert.equal(authorized.change.canDecline, true);
    const token = reviewToken(authorized.preview);
    const accepted = await inSchool(() => service.actOnClasspilotTodayScheduleChange({ ...context(frozenCoTeacher), changeId: requested.change.id,
      expectedRevision: requested.change.revision, action: "accept", reviewToken: token }));
    assert.equal(accepted.change.status, "applied"); assert.ok((await savedSession(other)).endTime);
  });

  it("rechecks the initiator's membership before another teacher can accept its pending request", async () => {
    const requestingCoTeacher = await staff();
    await inSchool(() => storage.addGroupTeacher(first.id, requestingCoTeacher.id, "co-teacher"));
    await inSchool(() => storage.addGroupTeacher(selected.id, requestingCoTeacher.id, "co-teacher"));
    const other = await occurrence(counterpartFirst);
    const requested = await apply(input(), requestingCoTeacher); assert.equal(requested.change.status, "pending");
    const detail = await inSchool(() => service.getClasspilotTodayScheduleChange({ ...context(counterpart), changeId: requested.change.id }));
    const token = reviewToken(detail.preview);
    // A primary teacher cannot become inactive while still assigned. Detach
    // this non-live co-teacher first, then revoke the now-unassigned membership.
    await inSchool(() => database.execute(sql`DELETE FROM group_teachers WHERE teacher_id=${requestingCoTeacher.id}
      AND group_id IN (SELECT id FROM groups WHERE school_id=${school.id} AND id IN (${first.id},${selected.id}))`));
    await inSchool(() => database.execute(sql`UPDATE school_memberships SET status='inactive'
      WHERE school_id=${school.id} AND user_id=${requestingCoTeacher.id} AND role='teacher'`));
    await assert.rejects(inSchool(() => service.actOnClasspilotTodayScheduleChange({ ...context(counterpart), changeId: requested.change.id,
      expectedRevision: requested.change.revision, action: "accept", reviewToken: token })), { code: "TODAY_SCHEDULE_REVIEW_STALE" });
    const current = await rows(); assert.equal(current.changes[0]!.status, "superseded"); assert.equal(current.occurrences.length, 0);
    assert.equal((await savedSession(other)).endTime, null);
  });

  it("invalidates pending acceptance after its frozen live session changes", async () => {
    const other = await occurrence(counterpartFirst);
    const requested = await apply(); assert.equal(requested.change.status, "pending");
    const detail = await inSchool(() => service.getClasspilotTodayScheduleChange({ ...context(counterpart), changeId: requested.change.id }));
    const acceptanceToken = reviewToken(detail.preview);
    await inSchool(() => lifecycle.finalizeClasspilotSession({ schoolId: school.id, sessionId: other.id, reason: "teacher_end" }));
    await assert.rejects(inSchool(() => service.actOnClasspilotTodayScheduleChange({ ...context(counterpart), changeId: requested.change.id,
      expectedRevision: requested.change.revision, action: "accept", reviewToken: acceptanceToken })), { code: "TODAY_SCHEDULE_REVIEW_STALE" });
    const current = await rows(); assert.equal(current.changes[0]!.status, "superseded"); assert.equal(current.occurrences.length, 0);
  });

  it("rolls back real replacements, reports and control revisions when the outer transaction fails", async () => {
    const old = await occurrence(first);
    const studentId = (await inSchool(() => storage.getGroupStudents(first.id)))[0]!.id;
    const beforeControl = await inSchool(() => storage.getClasspilotStudentControlState(school.id, studentId));
    const reviewed = await review(); let operationCompleted = false;
    const failingDatabase = new Proxy(database, { get(target, key, receiver) {
      if (key !== "transaction") return Reflect.get(target, key, receiver);
      return async (operation: Parameters<typeof database.transaction>[0]) => target.transaction(async tx => {
        await operation(tx); operationCompleted = true; throw new Error("synthetic_failure_after_real_writes");
      });
    } });
    await assert.rejects(inSchool(() => service.createClasspilotTodayScheduleChange({ ...context(), reviewToken: reviewed.reviewToken,
      idempotencyKey: randomUUID(), dbInstance: failingDatabase })), /synthetic_failure_after_real_writes/);
    assert.equal(operationCompleted, true);
    const current = await rows(); assert.equal(current.changes.length, 0); assert.equal(current.occurrences.length, 0);
    assert.equal((await savedSession(old)).endTime, null);
    assert.deepEqual(await inSchool(() => storage.getClasspilotStudentControlState(school.id, studentId)), beforeControl);
    const deliveries = await inSchool(() => database.execute(sql`SELECT id FROM classpilot_session_summary_deliveries
      WHERE school_id=${school.id} AND teaching_session_id=${old.id}`));
    assert.equal(deliveries.rows.length, 0);
  });

  it("rechecks the reused permission and refuses stale school dates without creating state", async () => {
    const reviewed = await review();
    await inSchool(() => database.execute(sql`UPDATE settings SET allow_teacher_manual_today=false WHERE school_id=${school.id}`));
    await assert.rejects(inSchool(() => service.createClasspilotTodayScheduleChange({ ...context(), reviewToken: reviewed.reviewToken,
      idempotencyKey: randomUUID() })), { code: "TODAY_SCHEDULE_TEACHER_DISABLED" });
    await assert.rejects(inSchool(() => service.previewClasspilotTodaySchedule({ ...context(), input: { ...input(), expectedSchoolDate: "2000-01-01" } })),
      { code: "TODAY_SCHEDULE_DATE_CHANGED" });
    assert.equal((await rows()).changes.length, 0);
  });

  it("lets a signed remainder review replace an early-end/skip tombstone without reopening it", async () => {
    const old = await occurrence(first);
    await inSchool(() => lifecycle.finalizeClasspilotSession({ schoolId: school.id, sessionId: old.id, reason: "teacher_end" }));
    const ended = await savedSession(old);
    const result = await apply(); assert.equal(result.change.status, "applied");
    assert.deepEqual(await savedSession(old), ended);
    assert.equal((await rows()).occurrences.filter(row => row.groupId === first.id).length, 1);
    assert.equal((await inSchool(() => storage.getGroupByIdAndSchool(first.id, school.id)))!.scheduleSkippedDate, schoolDate);
  });

  it("requires exact opaque meeting selection when a class has multiple remaining segments", async () => {
    const initial = await apply();
    const current = await rows();
    const firstOccurrence = current.occurrences.find(row => row.groupId === selected.id)!;
    await inSchool(async () => {
      // Additional valid future segment in the same immutable applied generation.
      await database.insert(schema.classpilotTodayOccurrences).values({ schoolId: school.id, changeId: initial.change.id,
        scheduledDate: schoolDate, groupId: selected.id, generation: firstOccurrence.generation, kind: "meeting",
        scheduledStartAt: at("14:00"), scheduledEndAt: at("14:30"), source: { schemaVersion: 1, action: "fixture_extra" },
        primaryTeacherIdSnapshot: firstTeacher.id, classNameSnapshot: selected.name, timezoneSnapshot: timeZone });
    });
    await assert.rejects(inSchool(() => service.previewClasspilotTodaySchedule({ ...context(), input: {
      expectedSchoolDate: schoolDate, currentGroupId: selected.id, action: "skip" } })), { code: "TODAY_SCHEDULE_MEETING_AMBIGUOUS" });
    const schedule = await inSchool(() => service.getClasspilotTodaySchedule(context()));
    const meeting = schedule.classes.find(row => row.groupId === selected.id)!.meetings.find(row => row.startsAt === at("14:00").toISOString())!;
    const running = (await rows()).sessions.find(row => row.groupId === selected.id && !row.endTime)!;
    const frozenOff = { ...emptyAutomaticFlightPathState(), status: "off" as const, revision: 17, assignmentId: randomUUID() };
    await inSchool(() => database.update(schema.teachingSessions).set({ automaticFlightPathState: frozenOff })
      .where(and(eq(schema.teachingSessions.schoolId, school.id), eq(schema.teachingSessions.id, running.id))));
    const activeStudent = (await inSchool(() => storage.getGroupStudents(selected.id)))[0]!.id;
    const controlBefore = await inSchool(() => storage.getClasspilotStudentControlState(school.id, activeStudent));
    const skipped = await apply({ expectedSchoolDate: schoolDate, currentGroupId: selected.id, currentMeetingRef: meeting.meetingRef, action: "skip" });
    assert.equal(skipped.change.status, "applied");
    assert.equal((await savedSession(running)).endTime, null);
    assert.deepEqual((await savedSession(running)).automaticFlightPathState, frozenOff);
    assert.deepEqual(await inSchool(() => storage.getClasspilotStudentControlState(school.id, activeStudent)), controlBefore);
    const refreshed = await inSchool(() => service.getClasspilotTodaySchedule(context()));
    assert.ok(refreshed.classes.find(row => row.groupId === selected.id)!.meetings.some(row => row.state === "current"));
  });

  it("expires pending requests with the containment flag off without changing live classes", async () => {
    const live = await occurrence(counterpartFirst);
    const requested = await apply(); assert.equal(requested.change.status, "pending");
    process.env.CLASSPILOT_TODAY_SCHEDULE_MODE = "off";
    try {
      assert.equal(await inSchool(() => service.expireClasspilotTodayScheduleChanges({ schoolId: school.id, now: new Date(at(firstEnd).getTime() + 1) })), 1);
      assert.equal(await inSchool(() => service.expireClasspilotTodayScheduleChanges({ schoolId: school.id, now: new Date(at(firstEnd).getTime() + 2) })), 0);
      const current = await rows();
      assert.equal(current.changes[0]!.status, "expired"); assert.equal(current.occurrences.length, 0);
      assert.equal((await savedSession(live)).endTime, null);
      assert.equal((await inSchool(() => service.getClasspilotTodaySchedule(context()))).enabled, false);
    } finally { process.env.CLASSPILOT_TODAY_SCHEDULE_MODE = "on"; }
  });

  it("blocks pending acceptance while contained but still permits decline", async () => {
    await occurrence(counterpartFirst);
    const requested = await apply();
    process.env.CLASSPILOT_TODAY_SCHEDULE_MODE = "off";
    try {
      await assert.rejects(inSchool(() => service.actOnClasspilotTodayScheduleChange({ ...context(counterpart),
        changeId: requested.change.id, action: "accept", expectedRevision: requested.change.revision })), { code: "TODAY_SCHEDULE_TEACHER_DISABLED" });
      const declined = await inSchool(() => service.actOnClasspilotTodayScheduleChange({ ...context(counterpart),
        changeId: requested.change.id, action: "decline", expectedRevision: requested.change.revision }));
      assert.equal(declined.change.status, "declined"); assert.equal((await rows()).occurrences.length, 0);
    } finally { process.env.CLASSPILOT_TODAY_SCHEDULE_MODE = "on"; }
  });

  it("invalidates a prebell pending request at the bell instead of silently converting it to a remainder swap", async () => {
    await inSchool(() => database.execute(sql`UPDATE groups SET schedule_enabled=false WHERE school_id=${school.id} AND id=${counterpartFirst.id}`));
    const live = await inSchool(() => storage.createTeachingSession({ groupId: counterpartFirst.id, teacherId: counterpart.id, startTime: at("09:00") }));
    await inSchool(() => database.execute(sql`UPDATE groups SET schedule_enabled=true WHERE school_id=${school.id} AND id=${counterpartFirst.id}`));
    const beforeBell = at("09:30");
    const reviewed = await inSchool(() => service.previewClasspilotTodaySchedule({ ...context(), input: input(), now: beforeBell }));
    const beforeBellToken = reviewToken(reviewed);
    const requested = await inSchool(() => service.createClasspilotTodayScheduleChange({ ...context(), now: beforeBell,
      reviewToken: beforeBellToken, idempotencyKey: randomUUID() }));
    assert.equal(requested.change.status, "pending");
    const changed = await inSchool(() => service.getClasspilotTodayScheduleChange({ ...context(counterpart),
      changeId: requested.change.id, now: at("10:00") }));
    assert.equal(changed.preview?.canApply, false);
    assert.ok(changed.preview?.blockers.some(row => row.code === "TODAY_SCHEDULE_REVIEW_STALE"));
    await inSchool(() => service.expireClasspilotTodayScheduleChanges({ schoolId: school.id, now: at("10:00") }));
    assert.equal((await rows()).occurrences.length, 0); assert.equal((await savedSession(live)).endTime, null);
  });
});
