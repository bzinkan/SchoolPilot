import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { CLASSPILOT_SCHEDULING_SQL } from "../src/db/classpilotSchedulingMigration.js";
import { CLASSPILOT_SCHEDULE_PROFILE_SUPERVISION_SQL } from "../src/db/classpilotScheduleProfileSupervisionMigration.js";
import { datePlusDays, dateWeekday, defaultClassScheduleRule, resolveClassBaseWindow } from "../src/services/classpilotSchedulingRules.js";
import type { ScheduleProfileApplication, ScheduleProfileDefinition } from "../src/services/classpilotScheduleProfileModel.js";
import { localDateInTimeZone, localDateTimeUtc } from "../src/util/schoolTime.js";

process.env.REDIS_URL = "";
const { pool, sessionPool, default: database } = await import("../src/db.js");
const { runWithTenantContext } = await import("../src/middleware/tenantContext.js");
const service = await import("../src/services/classpilotScheduleProfiles.js");
const scheduling = await import("../src/services/classpilotScheduling.js");
const schoolIds: string[] = [], userIds: string[] = [];
const scoped = <T>(schoolId: string, fn: () => Promise<T>) => runWithTenantContext({ schoolId }, fn);
let date = datePlusDays(localDateInTimeZone(new Date(), "America/New_York"), 14);
while ([0, 6].includes(dateWeekday(date))) date = datePlusDays(date, 1);
before(async () => {
  assert.ok(["localhost", "127.0.0.1", "::1"].includes(new URL(process.env.DATABASE_URL || "").hostname), "Profile integration tests require a local fixture database.");
  await pool.query(CLASSPILOT_SCHEDULING_SQL);
  await pool.query(CLASSPILOT_SCHEDULE_PROFILE_SUPERVISION_SQL);
});
after(async () => {
  try {
    for (const table of ["classpilot_supervision_students", "classpilot_supervision_contexts", "classpilot_coverage_scope_group_members", "classpilot_coverage_assignments", "classpilot_coverage_scope_groups", "classpilot_school_schedules", "classpilot_schedule_changes", "teaching_sessions", "audit_logs"]) await pool.query("DELETE FROM " + table + " WHERE school_id=ANY($1::text[])", [schoolIds]);
    await pool.query("DELETE FROM group_students WHERE group_id IN (SELECT id FROM groups WHERE school_id=ANY($1::text[]))", [schoolIds]);
    await pool.query("DELETE FROM group_teachers WHERE group_id IN (SELECT id FROM groups WHERE school_id=ANY($1::text[]))", [schoolIds]);
    for (const table of ["groups", "students", "settings", "school_memberships", "product_licenses"]) await pool.query("DELETE FROM " + table + " WHERE school_id=ANY($1::text[])", [schoolIds]);
    await pool.query("DELETE FROM users WHERE id=ANY($1::text[])", [userIds]);
    await pool.query("DELETE FROM schools WHERE id=ANY($1::text[])", [schoolIds]);
  } finally {
    const { schedulerPool, schedulerLockPool } = await import("../src/services/schedulerDb.js");
    await Promise.all([pool.end(), sessionPool.end(), schedulerPool.end(), schedulerLockPool.end()]);
  }
});
async function fixture(role = "admin") {
  const schoolId = randomUUID(), adminId = randomUUID(), teacherId = randomUUID(), specialistId = randomUUID();
  const classId = randomUUID(), nextClassId = randomUUID(), studentId = randomUUID(), scopeId = randomUUID();
  schoolIds.push(schoolId); userIds.push(adminId, teacherId, specialistId);
  await pool.query("INSERT INTO schools(id,name,status,is_active,plan_status,school_timezone) VALUES($1,'Profile fixture','active',true,'active','America/New_York')", [schoolId]);
  await pool.query("INSERT INTO product_licenses(school_id,product,status) VALUES($1,'CLASSPILOT','active')", [schoolId]);
  await pool.query("INSERT INTO settings(school_id,school_name,ws_shared_key,instructional_calendar) VALUES($1,'Profile fixture','fixture-only','{}'::jsonb)", [schoolId]);
  for (const [id, memberRole] of [[adminId, role], [teacherId, "teacher"], [specialistId, "teacher"]]) {
    await pool.query("INSERT INTO users(id,email,first_name,last_name) VALUES($1,$2,'Profile','Fixture')", [id, id + "@example.test"]);
    await pool.query("INSERT INTO school_memberships(school_id,user_id,role,status) VALUES($1,$2,$3,'active')", [schoolId, id, memberRole]);
  }
  await pool.query("INSERT INTO students(id,school_id,first_name,last_name,status,grade_level) VALUES($1,$2,'Profile','Student','active','5')", [studentId, schoolId]);
  for (const [id, name, start, end] of [[classId, "Grade 5 Math", "09:00", "09:50"], [nextClassId, "Grade 5 Reading", "10:00", "10:50"]]) {
    await pool.query("INSERT INTO groups(id,school_id,teacher_id,name,grade_level,group_type,status,schedule_enabled,block_start_time,block_end_time,schedule_rule) VALUES($1,$2,$3,$4,'5','admin_class','active',true,$5,$6,$7::jsonb)", [id, schoolId, teacherId, name, start, end, JSON.stringify(defaultClassScheduleRule())]);
    await pool.query("INSERT INTO group_students(group_id,student_id) VALUES($1,$2)", [id, studentId]);
  }
  await pool.query("INSERT INTO classpilot_coverage_scope_groups(id,school_id,name,created_by) VALUES($1,$2,'MAP Intervention',$3)", [scopeId, schoolId, adminId]);
  await pool.query("INSERT INTO classpilot_coverage_scope_group_members(school_id,coverage_group_id,student_id) VALUES($1,$2,$3)", [schoolId, scopeId, studentId]);
  await pool.query("INSERT INTO classpilot_coverage_assignments(school_id,staff_id,scope_type,scope_value,permissions,created_by) VALUES($1,$2,'coverage_group',$3,'{\"claim\":true}'::jsonb,$4)", [schoolId, specialistId, scopeId, adminId]);
  const definition: ScheduleProfileDefinition = { name: "NWEA", grades: ["5"], classIds: [], classRules: [{ classId, action: "time", startTime: "11:00", endTime: "11:50" }], testingBlocks: [] };
  return { schoolId, adminId, teacherId, specialistId, classId, nextClassId, studentId, scopeId, definition };
}
async function save(data: Awaited<ReturnType<typeof fixture>>, definition = data.definition, rev = 0) {
  return scoped(data.schoolId, () => service.saveScheduleProfile({ schoolId: data.schoolId, actorId: data.adminId, revision: rev, definition }));
}
function request(data: Awaited<ReturnType<typeof fixture>>, saved: Awaited<ReturnType<typeof save>>) {
  return { schoolId: data.schoolId, actorId: data.adminId, revision: saved.revision, profileId: saved.profile.id, profileRevision: saved.profile.revision, dates: [date] };
}
test("saving and renaming a profile never changes live schedules; applying snapshots only selected dates and keeps rosters", async () => {
  const data = await fixture("school_admin"); const saved = await save(data);
  const get = () => scoped(data.schoolId, () => scheduling.getSchoolSchedulingContext(data.schoolId));
  let context = await get();
  const group = { id: data.classId, scheduleEnabled: true, blockStartTime: "09:00", blockEndTime: "09:50", scheduleRule: defaultClassScheduleRule() };
  assert.equal(resolveClassBaseWindow(group, date, context.config, context.calendar)?.startTime, "09:00");
  const input = request(data, saved); const preview = await scoped(data.schoolId, () => service.previewScheduleProfile(input));
  assert.deepEqual(preview.blockers, []); assert.equal(preview.changes.length, 1);
  const applied = await scoped(data.schoolId, () => service.applyScheduleProfile({ ...input, previewToken: preview.previewToken }));
  context = await get(); assert.equal(resolveClassBaseWindow(group, date, context.config, context.calendar)?.startTime, "11:00");
  assert.equal(resolveClassBaseWindow(group, datePlusDays(date, 7), context.config, context.calendar)?.startTime, "09:00");
  await scoped(data.schoolId, () => service.saveScheduleProfile({ schoolId: data.schoolId, actorId: data.adminId, revision: applied.revision, id: saved.profile.id, profileRevision: saved.profile.revision, definition: { ...data.definition, name: "NWEA next round", classRules: [{ classId: data.classId, action: "skip" }] } }));
  context = await get(); assert.equal(context.config.profileApplications?.[0]?.definition.name, "NWEA");
  assert.equal(resolveClassBaseWindow(group, date, context.config, context.calendar)?.startTime, "11:00");
  assert.equal((await pool.query("SELECT count(*)::int n FROM group_students WHERE student_id=$1", [data.studentId])).rows[0].n, 2);
});
test("customize this use leaves its reusable profile unchanged and cancel restores future regular times", async () => {
  const data = await fixture(); const saved = await save(data); const input = { ...request(data, saved), definition: { ...data.definition, classRules: [{ classId: data.classId, action: "skip" as const }] } };
  const preview = await scoped(data.schoolId, () => service.previewScheduleProfile(input));
  assert.deepEqual(preview.blockers, []); assert.equal(preview.changes[0]?.after, null);
  const applied = await scoped(data.schoolId, () => service.applyScheduleProfile({ ...input, previewToken: preview.previewToken }));
  let context = await scoped(data.schoolId, () => scheduling.getSchoolSchedulingContext(data.schoolId));
  assert.equal(context.config.scheduleProfiles?.[0]?.definition.classRules[0]?.action, "time");
  const cancelled = await scoped(data.schoolId, () => service.cancelScheduleProfileApplication({ schoolId: data.schoolId, actorId: data.adminId, revision: applied.revision, applicationId: applied.application.id }));
  context = await scoped(data.schoolId, () => scheduling.getSchoolSchedulingContext(data.schoolId));
  assert.equal(context.config.profileApplications?.[0]?.status, "cancelled"); assert.equal(cancelled.revision, applied.revision + 1);
});
test("preview detects class overlaps and dated applications cannot overlap or edit recorded occurrences", async () => {
  const data = await fixture(); const saved = await save(data);
  const input = request(data, saved);
  const collision = await scoped(data.schoolId, () => service.previewScheduleProfile({ ...input, definition: { ...data.definition, classRules: [{ classId: data.classId, action: "time", startTime: "10:15", endTime: "11:00" }] } }));
  assert.ok(collision.blockers.some((b) => b.code === "CLASS_SCHEDULE_CONFLICT"));
  const preview = await scoped(data.schoolId, () => service.previewScheduleProfile(input));
  await pool.query("INSERT INTO teaching_sessions(group_id,school_id,teacher_id,scheduled_date,scheduled_timezone,scheduled_start_at,scheduled_end_at,scheduled_state) VALUES($1,$2,$3,$4,'America/New_York',$5,$6,'active')", [data.classId, data.schoolId, data.teacherId, date, localDateTimeUtc(date, "09:00", "America/New_York").toISOString(), localDateTimeUtc(date, "09:50", "America/New_York").toISOString()]);
  await assert.rejects(scoped(data.schoolId, () => service.applyScheduleProfile({ ...input, previewToken: preview.previewToken })), { code: "SCHEDULE_PREVIEW_STALE" });
  const recorded = await scoped(data.schoolId, () => service.previewScheduleProfile(input));
  assert.ok(recorded.blockers.some((b) => /recorded occurrence/.test(b.message)));
});
test("a testing preview freezes current students, detects staff or roster changes and overlapping groups", async () => {
  const data = await fixture();
  const testing = { id: "map-small", name: "MAP small group", coverageGroupId: data.scopeId, assignedStaffId: data.specialistId, startTime: "09:00", endTime: "11:00" };
  const saved = await save(data, { ...data.definition, testingBlocks: [testing] }); const input = request(data, saved);
  const preview = await scoped(data.schoolId, () => service.previewScheduleProfile(input));
  assert.deepEqual(preview.blockers, []); assert.deepEqual(preview.testingWindows[0]?.studentIds, [data.studentId]);
  await pool.query("UPDATE classpilot_coverage_assignments SET active=false WHERE school_id=$1", [data.schoolId]);
  await assert.rejects(scoped(data.schoolId, () => service.applyScheduleProfile({ ...input, previewToken: preview.previewToken })), { code: "SCHEDULE_PREVIEW_STALE" });
  await pool.query("UPDATE classpilot_coverage_assignments SET active=true WHERE school_id=$1", [data.schoolId]);
  const duplicate = await scoped(data.schoolId, () => service.previewScheduleProfile({ ...input, definition: { ...saved.profile.definition, testingBlocks: [testing, { ...testing, id: "another" }] } }));
  assert.ok(duplicate.blockers.some((b) => /overlapping testing/.test(b.message)));
});
test("different schools and ordinary teachers cannot mutate another school's profile or inject foreign classes", async () => {
  const data = await fixture(), foreign = await fixture(); const saved = await save(data);
  await assert.rejects(scoped(foreign.schoolId, () => service.previewScheduleProfile({ ...request(data, saved), schoolId: foreign.schoolId, actorId: foreign.adminId, revision: 0 })), { status: 404 });
  await assert.rejects(scoped(data.schoolId, () => service.saveScheduleProfile({ schoolId: data.schoolId, actorId: data.teacherId, revision: saved.revision, definition: data.definition })), { status: 403 });
  await assert.rejects(save(data, { ...data.definition, classIds: [foreign.classId] }, saved.revision), { code: "SCHEDULE_PROFILE_INVALID" });
  await assert.rejects(scoped(data.schoolId, () => service.applyScheduleProfile({ ...request(data, saved), actorId: foreign.adminId, previewToken: "0".repeat(64) })), { status: 403 });
});
test("concurrent applications serialize and a normal calendar save cannot forge or erase profile snapshots", async () => {
  const data = await fixture(); const saved = await save(data); const input = request(data, saved);
  const preview = await scoped(data.schoolId, () => service.previewScheduleProfile(input));
  const attempts = await Promise.allSettled([1, 2].map(() => scoped(data.schoolId, () => service.applyScheduleProfile({ ...input, previewToken: preview.previewToken }))));
  assert.equal(attempts.filter((r) => r.status === "fulfilled").length, 1);
  const context = await scoped(data.schoolId, () => scheduling.getSchoolSchedulingContext(data.schoolId));
  assert.equal(context.config.profileApplications?.length, 1);
  const forged = { ...context.config, profileApplications: [] };
  const fakePreview = await scoped(data.schoolId, () => scheduling.previewSchoolScheduling({ schoolId: data.schoolId, config: forged }));
  await assert.rejects(scoped(data.schoolId, () => scheduling.saveSchoolScheduling({ schoolId: data.schoolId, actorId: data.adminId, config: forged, expectedRevision: context.revision, previewToken: fakePreview.previewToken })), { code: "SCHEDULE_PROFILE_WORKFLOW_REQUIRED" });
  const closedCalendar = { [date.slice(0, 7)]: { revision: 1, nonInstructionalDates: [date], updatedAt: new Date().toISOString(), updatedBy: data.adminId } };
  const closed = await scoped(data.schoolId, () => scheduling.previewSchoolScheduling({ schoolId: data.schoolId, config: context.config, calendar: closedCalendar }));
  assert.ok(closed.blockers.some((blocker) => blocker.code === "SCHEDULE_PROFILE_APPLIED"));
  await assert.rejects(scoped(data.schoolId, () => scheduling.assertAppliedScheduleProfileClassEligibility({ schoolId: data.schoolId, groupId: data.classId,
    group: { scheduleEnabled: false, blockStartTime: "09:00", blockEndTime: "09:50", scheduleRule: defaultClassScheduleRule() }, dbInstance: database })), { code: "SCHEDULE_PROFILE_APPLIED" });
});

test("frozen applied occurrences permit future recurrence edits while unfrozen reservations remain protected", async () => {
  const data = await fixture(); const saved = await save(data);
  const laterDate = datePlusDays(date, 7);
  const input = { ...request(data, saved), dates: [date, laterDate] };
  const preview = await scoped(data.schoolId, () => service.previewScheduleProfile(input));
  assert.deepEqual(preview.blockers, []);
  await scoped(data.schoolId, () => service.applyScheduleProfile({ ...input, previewToken: preview.previewToken }));
  const frozenStart = localDateTimeUtc(date, "11:00", "America/New_York").toISOString();
  const frozenEnd = localDateTimeUtc(date, "11:50", "America/New_York").toISOString();
  await pool.query("INSERT INTO teaching_sessions(group_id,school_id,teacher_id,scheduled_date,scheduled_timezone,scheduled_start_at,scheduled_end_at,scheduled_state) VALUES($1,$2,$3,$4,'America/New_York',$5,$6,'active')", [data.classId, data.schoolId, data.teacherId, date, frozenStart, frozenEnd]);
  const { updateGroup } = await import("../src/services/storage.js");
  const futureRule = { ...defaultClassScheduleRule(), startsOn: datePlusDays(date, 1) };
  const updated = await scoped(data.schoolId, () => updateGroup(data.classId, { scheduleRule: futureRule }, data.adminId));
  assert.deepEqual(updated?.scheduleRule, futureRule);
  const context = await scoped(data.schoolId, () => scheduling.getSchoolSchedulingContext(data.schoolId));
  assert.equal(resolveClassBaseWindow(updated!, laterDate, context.config, context.calendar)?.startTime, "11:00");
  assert.equal(resolveClassBaseWindow(updated!, datePlusDays(laterDate, 7), context.config, context.calendar)?.startTime, "09:00");
  const recorded = await pool.query("SELECT scheduled_start_at,scheduled_end_at FROM teaching_sessions WHERE school_id=$1 AND group_id=$2 AND scheduled_date=$3", [data.schoolId, data.classId, date]);
  assert.equal(recorded.rows[0].scheduled_start_at.toISOString(), frozenStart);
  assert.equal(recorded.rows[0].scheduled_end_at.toISOString(), frozenEnd);
  await assert.rejects(scoped(data.schoolId, () => updateGroup(data.classId, { scheduleEnabled: false }, data.adminId)), { code: "SCHEDULE_PROFILE_APPLIED" });
});

test("a frozen profile date can close after testing ends while pending testing still protects it", async () => {
  const data = await fixture();
  const testing = { id: "map-small", name: "MAP small group", coverageGroupId: data.scopeId, assignedStaffId: data.specialistId, startTime: "09:00", endTime: "11:00" };
  const saved = await save(data, { ...data.definition, testingBlocks: [testing] });
  const input = request(data, saved);
  const preview = await scoped(data.schoolId, () => service.previewScheduleProfile(input));
  assert.deepEqual(preview.blockers, []);
  await scoped(data.schoolId, () => service.applyScheduleProfile({ ...input, previewToken: preview.previewToken }));
  await pool.query("INSERT INTO teaching_sessions(group_id,school_id,teacher_id,scheduled_date,scheduled_timezone,scheduled_start_at,scheduled_end_at,scheduled_state) VALUES($1,$2,$3,$4,'America/New_York',$5,$6,'active')", [data.classId, data.schoolId, data.teacherId, date, localDateTimeUtc(date, "11:00", "America/New_York").toISOString(), localDateTimeUtc(date, "11:50", "America/New_York").toISOString()]);
  const context = await scoped(data.schoolId, () => scheduling.getSchoolSchedulingContext(data.schoolId));
  const closedConfig = { ...context.config, dateOverrides: { [date]: { instructional: false } } };
  const testingEnd = localDateTimeUtc(date, "11:00", "America/New_York");
  const unfinished = await scoped(data.schoolId, () => scheduling.previewSchoolScheduling({ schoolId: data.schoolId, config: closedConfig, now: new Date(testingEnd.getTime() - 1) }));
  assert.ok(unfinished.blockers.some((blocker) => blocker.code === "SCHEDULE_PROFILE_APPLIED"));
  const completed = await scoped(data.schoolId, () => scheduling.previewSchoolScheduling({ schoolId: data.schoolId, config: closedConfig, now: testingEnd }));
  assert.deepEqual(completed.blockers, []);
  assert.ok(!completed.changes.some((change) => change.classId === data.classId && change.date === date), "recorded profile occurrence must remain frozen when its calendar date closes");
});

test("unfrozen skipped-class reservations retain their underlying recurrence and instructional date", async () => {
  const data = await fixture();
  const saved = await save(data, { ...data.definition, classRules: [{ classId: data.classId, action: "skip" }] });
  const input = request(data, saved);
  const preview = await scoped(data.schoolId, () => service.previewScheduleProfile(input));
  assert.deepEqual(preview.blockers, []);
  await scoped(data.schoolId, () => service.applyScheduleProfile({ ...input, previewToken: preview.previewToken }));
  const group = { scheduleEnabled: true, blockStartTime: "09:00", blockEndTime: "09:50", scheduleRule: defaultClassScheduleRule() };
  await scoped(data.schoolId, () => scheduling.assertAppliedScheduleProfileClassEligibility({ schoolId: data.schoolId, groupId: data.classId, group, dbInstance: database }));
  await assert.rejects(scoped(data.schoolId, () => scheduling.assertAppliedScheduleProfileClassEligibility({ schoolId: data.schoolId, groupId: data.classId, group: { ...group, scheduleEnabled: false }, dbInstance: database })), { code: "SCHEDULE_PROFILE_APPLIED" });
  const context = await scoped(data.schoolId, () => scheduling.getSchoolSchedulingContext(data.schoolId));
  const closed = await scoped(data.schoolId, () => scheduling.previewSchoolScheduling({ schoolId: data.schoolId, config: { ...context.config, dateOverrides: { [date]: { instructional: false } } } }));
  assert.ok(closed.blockers.some((blocker) => blocker.code === "SCHEDULE_PROFILE_APPLIED"));
});

test("inactive classes without a profile reservation can be edited without calendar settings", async () => {
  const data = await fixture();
  await pool.query("UPDATE groups SET schedule_enabled=false,status='archived' WHERE id=$1", [data.classId]);
  await pool.query("DELETE FROM settings WHERE school_id=$1", [data.schoolId]);
  const { updateGroup } = await import("../src/services/storage.js");
  const withoutDocument = await scoped(data.schoolId, () => updateGroup(data.classId, { blockStartTime: "08:30", blockEndTime: "09:20" }, data.adminId));
  assert.equal(withoutDocument?.blockStartTime, "08:30");
  const { emptySchoolSchedulingConfig } = await import("../src/services/classpilotSchedulingRules.js");
  await pool.query("INSERT INTO classpilot_school_schedules(school_id,config) VALUES($1,$2::jsonb)", [data.schoolId, JSON.stringify(emptySchoolSchedulingConfig())]);
  const withoutApplications = await scoped(data.schoolId, () => updateGroup(data.classId, { blockStartTime: "08:40", blockEndTime: "09:30" }, data.adminId));
  assert.equal(withoutApplications?.blockStartTime, "08:40");
  const unrelatedDefinition = { ...data.definition, classRules: [{ classId: data.nextClassId, action: "time" as const, startTime: "13:00", endTime: "13:50" }] };
  const unrelated: ScheduleProfileApplication = { id: randomUUID(), profileId: randomUUID(), profileRevision: 1, profileName: unrelatedDefinition.name,
    definition: unrelatedDefinition, dates: [date], classWindows: { [date]: { [data.nextClassId]: { startTime: "13:00", endTime: "13:50" } } },
    testingWindows: [], status: "scheduled", createdBy: data.adminId, createdAt: new Date().toISOString() };
  await pool.query("UPDATE classpilot_school_schedules SET config=$2::jsonb WHERE school_id=$1", [data.schoolId, JSON.stringify({ ...emptySchoolSchedulingConfig(), profileApplications: [unrelated] })]);
  const unrelatedApplication = await scoped(data.schoolId, () => updateGroup(data.classId, { blockStartTime: "08:50", blockEndTime: "09:40" }, data.adminId));
  assert.equal(unrelatedApplication?.blockStartTime, "08:50");
  await assert.rejects(scoped(data.schoolId, () => scheduling.assertAppliedScheduleProfileClassEligibility({ schoolId: data.schoolId, groupId: data.nextClassId,
    group: { scheduleEnabled: false, blockStartTime: "10:00", blockEndTime: "10:50" }, dbInstance: database })), { code: "INSTRUCTIONAL_CALENDAR_SETTINGS_UNAVAILABLE" });
});
