import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { PoolClient } from "pg";
import express from "express";
import { CLASSPILOT_SCHEDULING_SQL } from "../src/db/classpilotSchedulingMigration.js";
import { CLASSPILOT_SCHEDULE_PROFILE_SUPERVISION_SQL } from "../src/db/classpilotScheduleProfileSupervisionMigration.js";
import { datePlusDays, dateWeekday, defaultClassScheduleRule, emptySchoolSchedulingConfig, resolveClassBaseWindow } from "../src/services/classpilotSchedulingRules.js";
import type { ScheduleProfileApplication, ScheduleProfileDefinition } from "../src/services/classpilotScheduleProfileModel.js";
import { localDateInTimeZone, localDateTimeUtc } from "../src/util/schoolTime.js";

process.env.REDIS_URL = "";
const { pool, sessionPool, default: database } = await import("../src/db.js");
const { runWithTenantContext } = await import("../src/middleware/tenantContext.js");
const service = await import("../src/services/classpilotScheduleProfiles.js");
const scheduling = await import("../src/services/classpilotScheduling.js");
const regularSchedule = await import("../src/services/classpilotRegularSchedule.js");
const draftReview = await import("../src/services/classpilotScheduleDraftReview.js");
const { getEffectiveClasspilotScheduleWindow } = await import("../src/services/classpilotScheduleChanges.js");
const { getClasspilotGroupsReadyAtEffectiveWindow, processScheduledClassAutoStart } = await import("../src/services/classpilotScheduledStart.js");
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
    // Child deletion and parent deletion must commit together for the deferred
    // exactly-two-legs constraint, just like swap creation below.
    await fixtureTransaction(async (client) => {
      for (const table of ["classpilot_student_control_states", "classpilot_supervision_students", "classpilot_supervision_contexts", "classpilot_coverage_scope_group_members", "classpilot_coverage_assignments", "classpilot_coverage_scope_groups", "classpilot_school_schedules", "classpilot_schedule_change_legs", "classpilot_schedule_changes", "classpilot_schedule_change_pairs", "classpilot_session_students", "classpilot_session_staff", "teaching_sessions", "audit_logs"]) await client.query("DELETE FROM " + table + " WHERE school_id=ANY($1::text[])", [schoolIds]);
      await client.query("DELETE FROM group_students WHERE group_id IN (SELECT id FROM groups WHERE school_id=ANY($1::text[]))", [schoolIds]);
      await client.query("DELETE FROM group_teachers WHERE group_id IN (SELECT id FROM groups WHERE school_id=ANY($1::text[]))", [schoolIds]);
      for (const table of ["groups", "students", "settings", "school_memberships", "product_licenses"]) await client.query("DELETE FROM " + table + " WHERE school_id=ANY($1::text[])", [schoolIds]);
      await client.query("DELETE FROM users WHERE id=ANY($1::text[])", [userIds]);
      await client.query("DELETE FROM schools WHERE id=ANY($1::text[])", [schoolIds]);
    });
  } finally {
    const { schedulerPool, schedulerLockPool } = await import("../src/services/schedulerDb.js");
    await Promise.all([pool.end(), sessionPool.end(), schedulerPool.end(), schedulerLockPool.end()]);
  }
});
async function fixtureTransaction(operation: (client: PoolClient) => Promise<void>) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await operation(client);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
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

test("class-only profiles block new shared-student intervals outside their selection and keep student IDs out of summaries", async () => {
  const data = await fixture();
  await pool.query("UPDATE groups SET teacher_id=$2 WHERE id=$1", [data.nextClassId, data.specialistId]);
  const saved = await save(data, { ...data.definition, grades: [], classIds: [data.classId], classRules: [{ classId: data.classId, action: "time", startTime: "10:20", endTime: "11:10" }] });
  const preview = await scoped(data.schoolId, () => service.previewScheduleProfile(request(data, saved)));
  assert.equal(preview.studentReviewComplete, true);
  assert.ok(preview.blockers.some(b => b.code === "SCHEDULE_PROFILE_STUDENT_CONFLICT"));
  assert.deepEqual(preview.studentConflicts.map(c => [c.startTime, c.endTime, c.studentCount, c.newStudentCount]), [["10:20", "10:50", 1, 1]]);
  assert.equal(JSON.stringify(preview.studentConflicts).includes(data.studentId), false);
  await assert.rejects(scoped(data.schoolId, () => service.applyScheduleProfile({ ...request(data, saved), previewToken: preview.previewToken })), /competing class time/);
});

test("inactive picker references never enter the active class catalog or default profile selection", async () => {
  const data = await fixture(), archivedId = randomUUID();
  await pool.query("INSERT INTO groups(id,school_id,teacher_id,name,group_type,status,schedule_enabled,block_start_time,block_end_time) VALUES($1,$2,$3,'Archived class','admin_class','inactive',true,'08:00','08:30')", [archivedId, data.schoolId, data.teacherId]);
  const catalog = await scoped(data.schoolId, () => service.getScheduleProfiles(data.schoolId));
  assert.deepEqual(catalog.classes.map(c => c.id).sort(), [data.classId, data.nextClassId].sort());
  assert.equal(catalog.inactiveClasses[0]?.id, archivedId);
  assert.equal(catalog.inactiveClasses[0]?.active, false);
  assert.equal(catalog.inactiveClasses[0]?.studentCount, null);
  const saved = await save(data, { ...data.definition, grades: [], classIds: catalog.classes.map(c => c.id) });
  assert.equal(saved.profile.definition.classIds.includes(archivedId), false);
});

test("application review permits reduced inherited student overlap but detects the same duration moved elsewhere", async () => {
  const data = await fixture();
  await pool.query("UPDATE groups SET teacher_id=$2,block_start_time='09:30',block_end_time='10:30' WHERE id=$1", [data.nextClassId, data.specialistId]);
  const saved = await save(data, { ...data.definition, classRules: [{ classId: data.classId, action: "time", startTime: "09:00", endTime: "09:40" }] });
  const reduced = await scoped(data.schoolId, () => service.previewScheduleProfile(request(data, saved)));
  assert.deepEqual(reduced.blockers, []);
  assert.equal(reduced.studentConflicts[0]?.change, "reduced");
  assert.equal(reduced.studentConflicts[0]?.newStudentCount, 0);
  const moved = await scoped(data.schoolId, () => service.previewScheduleProfile({ ...request(data, saved), definition: { ...saved.profile.definition,
    classRules: [{ classId: data.classId, action: "time", startTime: "10:00", endTime: "10:20" }] } }));
  assert.ok(moved.blockers.some(b => b.code === "SCHEDULE_PROFILE_STUDENT_CONFLICT"));
  assert.equal(moved.studentConflicts[0]?.newStudentCount, 1);
});

test("21-student testing handoff uses adjacent class windows and independent eligibility on each applied date", async () => {
  const data = await fixture();
  let secondDate = datePlusDays(date, 1);
  while ([0, 6].includes(dateWeekday(secondDate))) secondDate = datePlusDays(secondDate, 1);
  await pool.query("UPDATE groups SET name='Grade 8 Math',grade_level='8',schedule_rule=$2::jsonb WHERE id=$1", [data.classId, JSON.stringify({ ...defaultClassScheduleRule(), weekdays: [dateWeekday(date)] })]);
  await pool.query("UPDATE groups SET name='Grade 8 ELA',grade_level='8',teacher_id=$2 WHERE id=$1", [data.nextClassId, data.specialistId]);
  for (let i = 1; i < 21; i++) {
    const id = randomUUID();
    await pool.query("INSERT INTO students(id,school_id,first_name,last_name,status,grade_level) VALUES($1,$2,'Grade8','Fixture','active','8')", [id, data.schoolId]);
    await pool.query("INSERT INTO group_students(group_id,student_id) VALUES($1,$3),($2,$3)", [data.classId, data.nextClassId, id]);
    await pool.query("INSERT INTO classpilot_coverage_scope_group_members(school_id,coverage_group_id,student_id) VALUES($1,$2,$3)", [data.schoolId, data.scopeId, id]);
  }
  const saved = await save(data, { ...data.definition, grades: [], classIds: [data.classId, data.nextClassId], classRules: [
    { classId: data.classId, action: "time", startTime: "10:55", endTime: "11:40" }, { classId: data.nextClassId, action: "skip" },
  ], testingBlocks: [{ id: "grade8testing", name: "Wendell MAP", coverageGroupId: data.scopeId, assignedStaffId: data.specialistId, startTime: "09:10", endTime: "10:55" }] });
  const input = { ...request(data, saved), dates: [date, secondDate] };
  const preview = await scoped(data.schoolId, () => service.previewScheduleProfile(input));
  assert.deepEqual(preview.blockers, []);
  const first = preview.testingWindows.find(w => w.date === date)!.afterTesting!;
  assert.equal(first.status, "ready"); assert.equal(first.studentCount, 21);
  assert.deepEqual(first.allocations.map(a => [a.kind, a.classIds, a.studentCount, a.at]), [["class", [data.classId], 21, "10:55"]]);
  assert.equal(JSON.stringify(first).includes(data.studentId), false);
  assert.equal(preview.classResults.find(r => r.classId === data.classId && r.date === secondDate)?.status, "does_not_meet");
  assert.equal(preview.testingWindows.find(w => w.date === secondDate)?.afterTesting?.allocations[0]?.kind, "none");
  const applied = await scoped(data.schoolId, () => service.applyScheduleProfile({ ...input, previewToken: preview.previewToken }));
  assert.deepEqual(applied.application.classWindows[date]?.[data.classId], { startTime: "10:55", endTime: "11:40" });
  assert.equal(Object.hasOwn(applied.application.classWindows[secondDate] ?? {}, data.classId), false);
  const context = await scoped(data.schoolId, () => scheduling.getSchoolSchedulingContext(data.schoolId));
  assert.deepEqual(resolveClassBaseWindow({ id: data.classId, scheduleEnabled: true, blockStartTime: "09:00", blockEndTime: "09:50", scheduleRule: { ...defaultClassScheduleRule(), weekdays: [dateWeekday(date)] } }, date, context.config, {}), { startTime: "10:55", endTime: "11:40" });
});

test("student review uses frozen session rosters and fingerprints their changes", async () => {
  const data = await fixture(), sessionId = randomUUID();
  await pool.query("UPDATE groups SET teacher_id=$2 WHERE id=$1", [data.nextClassId, data.specialistId]);
  await pool.query("DELETE FROM group_students WHERE group_id=$1", [data.classId]);
  await pool.query("INSERT INTO teaching_sessions(id,school_id,group_id,teacher_id,start_time,scheduled_date,scheduled_timezone,scheduled_start_at,scheduled_end_at,scheduled_state,roster_snapshot_completed_at) VALUES($1,$2,$3,$4,$5::timestamptz,$6,'America/New_York',$5::timestamptz,$7,'active',now())",
    [sessionId, data.schoolId, data.classId, data.teacherId, localDateTimeUtc(date, "09:00", "America/New_York"), date, localDateTimeUtc(date, "09:50", "America/New_York")]);
  await pool.query("INSERT INTO classpilot_session_students(school_id,teaching_session_id,group_id,student_id) VALUES($1,$2,$3,$4)", [data.schoolId, sessionId, data.classId, data.studentId]);
  const saved = await save(data, { ...data.definition, classRules: [{ classId: data.nextClassId, action: "time", startTime: "09:20", endTime: "10:10" }] });
  const preview = await scoped(data.schoolId, () => service.previewScheduleProfile(request(data, saved)));
  assert.ok(preview.blockers.some(b => b.code === "SCHEDULE_PROFILE_STUDENT_CONFLICT"));
  assert.equal(preview.studentConflicts[0]?.studentCount, 1);
  await pool.query("DELETE FROM classpilot_session_students WHERE teaching_session_id=$1", [sessionId]);
  const refreshed = await scoped(data.schoolId, () => service.previewScheduleProfile(request(data, saved)));
  assert.deepEqual(refreshed.blockers, []); assert.notEqual(refreshed.previewToken, preview.previewToken);
  await assert.rejects(scoped(data.schoolId, () => service.applyScheduleProfile({ ...request(data, saved), previewToken: preview.previewToken })), /schedule, roster, or staff changed/);
  await pool.query("UPDATE teaching_sessions SET roster_snapshot_completed_at=NULL WHERE id=$1", [sessionId]);
  const incomplete = await scoped(data.schoolId, () => service.previewScheduleProfile(request(data, saved)));
  assert.equal(incomplete.studentReviewComplete, false);
  assert.ok(incomplete.blockers.some(b => b.code === "SCHEDULE_PROFILE_STUDENT_REVIEW_INCOMPLETE"));
});

test("a previous testing application cannot mask new class conflicts after its group roster changes", async () => {
  const data = await fixture();
  await pool.query("UPDATE groups SET teacher_id=$2 WHERE id=$1", [data.nextClassId, data.specialistId]);
  const testing = await save(data, { name: "Earlier testing", grades: [], classIds: [], classRules: [], testingBlocks: [
    { id: "existing-testing", name: "Existing MAP", coverageGroupId: data.scopeId, assignedStaffId: data.specialistId, startTime: "10:00", endTime: "10:30" },
  ] });
  const first = await scoped(data.schoolId, () => service.previewScheduleProfile(request(data, testing)));
  assert.deepEqual(first.blockers, []);
  const applied = await scoped(data.schoolId, () => service.applyScheduleProfile({ ...request(data, testing), previewToken: first.previewToken }));
  const placement = await save(data, { ...data.definition, classRules: [{ classId: data.classId, action: "time", startTime: "10:00", endTime: "10:30" }] }, applied.revision);
  const before = await scoped(data.schoolId, () => service.previewScheduleProfile(request(data, placement)));
  assert.deepEqual(before.blockers, []);
  const added = randomUUID();
  await pool.query("INSERT INTO students(id,school_id,first_name,last_name,status) VALUES($1,$2,'Added','Student','active')", [added, data.schoolId]);
  await pool.query("INSERT INTO classpilot_coverage_scope_group_members(school_id,coverage_group_id,student_id) VALUES($1,$2,$3)", [data.schoolId, data.scopeId, added]);
  const after = await scoped(data.schoolId, () => service.previewScheduleProfile(request(data, placement)));
  assert.ok(after.blockers.some(b => b.code === "SCHEDULE_PROFILE_STUDENT_CONFLICT"));
  assert.notEqual(after.previewToken, before.previewToken);
  await assert.rejects(scoped(data.schoolId, () => service.applyScheduleProfile({ ...request(data, placement), previewToken: before.previewToken })), /schedule, roster, or staff changed/);
});

test("after-testing comparison does not return students to an early-finalized scheduled class", async () => {
  const data = await fixture(), sessionId = randomUUID();
  await pool.query("INSERT INTO teaching_sessions(id,school_id,group_id,teacher_id,start_time,end_time,scheduled_date,scheduled_timezone,scheduled_start_at,scheduled_end_at,scheduled_state,roster_snapshot_completed_at) VALUES($1,$2,$3,$4,$5::timestamptz,$6::timestamptz,$7,'America/New_York',$5::timestamptz,$8,'finalized',now())",
    [sessionId, data.schoolId, data.classId, data.teacherId, localDateTimeUtc(date, "09:00", "America/New_York"), localDateTimeUtc(date, "09:50", "America/New_York"), date, localDateTimeUtc(date, "11:00", "America/New_York")]);
  await pool.query("INSERT INTO classpilot_session_students(school_id,teaching_session_id,group_id,student_id) VALUES($1,$2,$3,$4)", [data.schoolId, sessionId, data.classId, data.studentId]);
  const saved = await save(data, { ...data.definition, classRules: [{ classId: data.nextClassId, action: "time", startTime: "11:30", endTime: "12:00" }], testingBlocks: [
    { id: "after-ended-class", name: "Later testing", coverageGroupId: data.scopeId, assignedStaffId: data.specialistId, startTime: "10:00", endTime: "10:30" },
  ] });
  const preview = await scoped(data.schoolId, () => service.previewScheduleProfile(request(data, saved)));
  assert.deepEqual(preview.blockers, []);
  const handoff = preview.testingWindows[0]?.afterTesting;
  assert.equal(handoff?.status, "ready");
  assert.deepEqual(handoff?.allocations.map(a => [a.kind, a.classIds, a.at]), [["gap", [data.nextClassId], "11:30"]]);
});

async function historyFixture(options: { dates?: string[]; testing?: boolean; cancelled?: boolean; role?: string } = {}) {
  const data = await fixture(options.role), dates = options.dates ?? ["2000-01-03"];
  const testingBlocks = options.testing ? [{ id: "history-testing", name: "Testing history", coverageGroupId: data.scopeId,
    assignedStaffId: data.specialistId, startTime: "09:00", endTime: "09:45" }] : [];
  const saved = await save(data, { ...data.definition, testingBlocks });
  const context = await scoped(data.schoolId, () => scheduling.getSchoolSchedulingContext(data.schoolId));
  const application: ScheduleProfileApplication = { id: randomUUID(), profileId: saved.profile.id, profileRevision: saved.profile.revision,
    profileName: saved.profile.definition.name, definition: saved.profile.definition, dates,
    classWindows: Object.fromEntries(dates.map(day => [day, { [data.classId]: { startTime: "11:00", endTime: "11:50" } }])),
    testingWindows: dates.flatMap(day => testingBlocks.map(({ id, ...block }) => ({ ...block, blockId: id, date: day, studentIds: [data.studentId] }))),
    status: options.cancelled ? "cancelled" : "scheduled", createdBy: data.adminId, createdAt: "1999-12-01T12:00:00.000Z" };
  await pool.query("UPDATE classpilot_school_schedules SET config=$2::jsonb WHERE school_id=$1", [data.schoolId, JSON.stringify({ ...context.config, profileApplications: [application] })]);
  const input = { schoolId: data.schoolId, actorId: data.adminId, applicationId: application.id, revision: saved.revision };
  return { ...data, saved, application, input };
}
async function historyContext(data: Awaited<ReturnType<typeof historyFixture>>, status = "ended", released = true) {
  const id = randomUUID(), window = data.application.testingWindows[0]!;
  await pool.query("INSERT INTO classpilot_supervision_contexts(id,school_id,context_type,name,status,assigned_staff_id,coverage_group_id,created_by,starts_at,ends_at,ended_at,schedule_profile_application_id,schedule_profile_date,schedule_profile_block_id) VALUES($1,$2,'supervision_group','Historical supervision',$3,$4,$5,$6,'2000-01-03T14:00:00Z','2000-01-03T14:45:00Z',$7,$8,$9,$10)",
    [id, data.schoolId, status, data.specialistId, data.scopeId, data.adminId, status === "ended" ? "2000-01-03T14:45:00Z" : null, data.application.id, window.date, window.blockId]);
  await pool.query("INSERT INTO classpilot_supervision_students(school_id,context_id,student_id,assigned_by,released_at) VALUES($1,$2,$3,$4,$5)", [data.schoolId, id, data.studentId, data.adminId, released ? "2000-01-03T14:45:00Z" : null]);
  return id;
}
async function historyOutcome(data: Awaited<ReturnType<typeof historyFixture>>, status: string, contextId?: string) {
  const window = data.application.testingWindows[0]!;
  const outcome = { applicationId: data.application.id, date: window.date, blockId: window.blockId, status, code: "FIXTURE", updatedAt: "2000-01-03T15:00:00Z", ...(contextId ? { contextId } : {}) };
  await pool.query("UPDATE classpilot_school_schedules SET profile_activation_outcomes=$2::jsonb WHERE school_id=$1", [data.schoolId, JSON.stringify({ [`${outcome.applicationId}:${outcome.date}:${outcome.blockId}`]: outcome })]);
}

test("history hiding retains profiles, dated snapshots, actual supervision and receipts and is idempotently audited", async () => {
  const data = await historyFixture({ testing: true }), contextId = await historyContext(data);
  await historyOutcome(data, "started", contextId);
  await pool.query("INSERT INTO audit_logs(school_id,user_id,action,entity_type,entity_id) VALUES($1,$2,'fixture.retained','schedule_profile_application',$3)", [data.schoolId, data.adminId, data.application.id]);
  const before = (await pool.query("SELECT config,profile_activation_outcomes FROM classpilot_school_schedules WHERE school_id=$1", [data.schoolId])).rows[0];
  const contextBefore = (await pool.query("SELECT * FROM classpilot_supervision_contexts WHERE id=$1", [contextId])).rows;
  const studentsBefore = (await pool.query("SELECT * FROM classpilot_supervision_students WHERE context_id=$1", [contextId])).rows;
  const overview = await scoped(data.schoolId, () => service.getScheduleProfiles(data.schoolId));
  assert.equal(overview.applicationSummaries[data.application.id]?.historyRemoval.canRequest, true);
  const outcomes = await Promise.all([0, 1].map(() => scoped(data.schoolId, () => service.hideScheduleProfileApplicationHistory(data.input))));
  const result = outcomes[0]!;
  assert.deepEqual(outcomes[1], result);
  assert.equal(result.revision, data.saved.revision + 1);
  const after = (await pool.query("SELECT config,profile_activation_outcomes FROM classpilot_school_schedules WHERE school_id=$1", [data.schoolId])).rows[0];
  assert.deepEqual(after.config, { ...before.config, profileApplications: [{ ...data.application, historyHiddenAt: result.historyHiddenAt, historyHiddenBy: data.adminId }] });
  assert.deepEqual(after.profile_activation_outcomes, before.profile_activation_outcomes);
  assert.deepEqual((await pool.query("SELECT * FROM classpilot_supervision_contexts WHERE id=$1", [contextId])).rows, contextBefore);
  assert.deepEqual((await pool.query("SELECT * FROM classpilot_supervision_students WHERE context_id=$1", [contextId])).rows, studentsBefore);
  const loaded = await scoped(data.schoolId, () => service.getScheduleProfiles(data.schoolId));
  assert.equal(loaded.applications[0]?.historyHiddenAt, result.historyHiddenAt);
  assert.equal(loaded.applicationSummaries[data.application.id]?.historyRemoval.reason, "hidden");
  assert.equal(loaded.testingStatuses[0]?.status, "ended");
  const audit = (await pool.query("SELECT user_id,metadata FROM audit_logs WHERE school_id=$1 AND action='classpilot.schedule_profile.history_hidden'", [data.schoolId])).rows;
  assert.equal(audit.length, 1); assert.equal(audit[0].user_id, data.adminId); assert.equal(audit[0].metadata.revision, result.revision);
  assert.equal((await pool.query("SELECT count(*)::int n FROM audit_logs WHERE school_id=$1 AND action='fixture.retained'", [data.schoolId])).rows[0].n, 1);
  const effective = await scoped(data.schoolId, () => scheduling.getSchoolSchedulingContext(data.schoolId));
  assert.deepEqual(resolveClassBaseWindow({ id: data.classId, scheduleEnabled: true, blockStartTime: "09:00", blockEndTime: "09:50", scheduleRule: defaultClassScheduleRule() }, "2000-01-03", effective.config, {}), { startTime: "11:00", endTime: "11:50" });
  await scoped(data.schoolId, () => service.saveScheduleProfile({ schoolId: data.schoolId, actorId: data.adminId, id: data.saved.profile.id,
    profileRevision: data.saved.profile.revision, revision: result.revision, definition: { ...data.saved.profile.definition, name: "Reusable after history hide" } }));
  const afterEdit = await scoped(data.schoolId, () => scheduling.getSchoolSchedulingContext(data.schoolId));
  assert.deepEqual(afterEdit.config.profileApplications, effective.config.profileApplications);
  assert.deepEqual((await pool.query("SELECT profile_activation_outcomes FROM classpilot_school_schedules WHERE school_id=$1", [data.schoolId])).rows[0].profile_activation_outcomes, before.profile_activation_outcomes);
});

test("history removal is school-local, rejects today or any later selected date, and permits finished non-start outcomes", async () => {
  for (const dates of [["2026-09-14"], ["2000-01-03", "2026-09-15"]]) {
    const data = await historyFixture({ dates, cancelled: true });
    await assert.rejects(scoped(data.schoolId, () => service.hideScheduleProfileApplicationHistory({ ...data.input, now: new Date("2026-09-15T03:59:59Z") })), { status: 409, code: "SCHEDULE_APPLICATION_HISTORY_UNAVAILABLE" });
  }
  const midnight = await historyFixture({ dates: ["2026-09-14"] });
  assert.equal((await scoped(midnight.schoolId, () => service.hideScheduleProfileApplicationHistory({ ...midnight.input, now: new Date("2026-09-15T04:00:00Z") }))).hidden, true);
  for (const status of ["failed", "missed", "cancelled"]) {
    const data = await historyFixture({ testing: true });
    await historyOutcome(data, status);
    assert.equal((await scoped(data.schoolId, () => service.getScheduleProfiles(data.schoolId))).applicationSummaries[data.application.id]?.historyRemoval.reason, "available");
    assert.equal((await scoped(data.schoolId, () => service.hideScheduleProfileApplicationHistory(data.input))).hidden, true);
  }
  const cancelled = await historyFixture({ testing: true, cancelled: true });
  assert.equal((await scoped(cancelled.schoolId, () => service.hideScheduleProfileApplicationHistory(cancelled.input))).hidden, true, "cancelled without a start needs no actual context");
});

test("history removal refuses pending, live, releasing, unclosed student rows and missing or mismatched actual supervision", async () => {
  for (const state of ["pending", "active", "releasing", "unreleased", "missing", "cancelled-missing", "unknown", "mismatch"] as const) {
    const data = await historyFixture({ testing: true, cancelled: state === "releasing" || state === "cancelled-missing" });
    if (["active", "releasing", "unreleased"].includes(state)) await historyContext(data, state === "unreleased" ? "ended" : "active", false);
    if (state === "missing" || state === "cancelled-missing") await historyOutcome(data, "started", randomUUID());
    if (state === "unknown") await historyOutcome(data, "unknown");
    if (state === "mismatch") { const contextId = await historyContext(data); await pool.query("UPDATE classpilot_supervision_contexts SET schedule_profile_block_id='different' WHERE id=$1", [contextId]); await historyOutcome(data, "started", contextId); }
    const overview = await scoped(data.schoolId, () => service.getScheduleProfiles(data.schoolId));
    assert.equal(overview.applicationSummaries[data.application.id]?.historyRemoval.canRequest, false, state);
    await assert.rejects(scoped(data.schoolId, () => service.hideScheduleProfileApplicationHistory(data.input)), { status: 409, code: "SCHEDULE_APPLICATION_HISTORY_UNAVAILABLE" });
    assert.equal((await scoped(data.schoolId, () => scheduling.getSchoolSchedulingContext(data.schoolId))).revision, data.saved.revision);
  }
});

test("history removal rechecks scope, membership, entitlement and revision and serializes a changed supervision state", async () => {
  const data = await historyFixture({ testing: true }), other = await fixture();
  const contextId = await historyContext(data);
  await assert.rejects(scoped(data.schoolId, () => service.hideScheduleProfileApplicationHistory({ ...data.input, revision: 0 })), { code: "SCHEDULE_PREVIEW_STALE", status: 409 });
  await assert.rejects(scoped(data.schoolId, () => service.hideScheduleProfileApplicationHistory({ ...data.input, actorId: data.teacherId })), { code: "FORBIDDEN", status: 403 });
  await assert.rejects(scoped(other.schoolId, () => service.hideScheduleProfileApplicationHistory({ ...data.input, schoolId: other.schoolId, actorId: other.adminId })), { code: "NOT_FOUND", status: 404 });
  await pool.query("UPDATE product_licenses SET status='cancelled' WHERE school_id=$1", [data.schoolId]);
  await assert.rejects(scoped(data.schoolId, () => service.hideScheduleProfileApplicationHistory(data.input)), { code: "CLASSPILOT_NOT_ENTITLED" });
  await pool.query("UPDATE product_licenses SET status='active' WHERE school_id=$1", [data.schoolId]);
  const client = await pool.connect();
  let pending: Promise<unknown> | undefined;
  try {
    await client.query("BEGIN");
    await client.query("SELECT id FROM schools WHERE id=$1 FOR UPDATE", [data.schoolId]);
    pending = scoped(data.schoolId, () => service.hideScheduleProfileApplicationHistory(data.input));
    await client.query("UPDATE classpilot_supervision_contexts SET status='active',ended_at=NULL WHERE id=$1", [contextId]);
    await client.query("COMMIT");
    await assert.rejects(pending, { code: "SCHEDULE_APPLICATION_HISTORY_UNAVAILABLE", status: 409 });
  } finally { await client.query("ROLLBACK"); client.release(); await pending?.catch(() => undefined); }
  await pool.query("UPDATE school_memberships SET status='disabled' WHERE school_id=$1 AND user_id=$2", [data.schoolId, data.adminId]);
  await assert.rejects(scoped(data.schoolId, () => service.hideScheduleProfileApplicationHistory(data.input)), { code: "FORBIDDEN", status: 403 });
  assert.equal((await pool.query("SELECT count(*)::int n FROM audit_logs WHERE school_id=$1 AND action='classpilot.schedule_profile.history_hidden'", [data.schoolId])).rows[0].n, 0);
});

test("a failed history audit rolls back its visibility metadata and scheduling revision", async () => {
  const data = await historyFixture(), suffix = randomUUID().replaceAll("-", ""), name = `history_hide_fail_${suffix}`;
  await pool.query(`CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture audit failure'; END $$`);
  await pool.query(`CREATE TRIGGER ${name} BEFORE INSERT ON audit_logs FOR EACH ROW WHEN (NEW.school_id = '${data.schoolId}') EXECUTE FUNCTION ${name}()`);
  try {
    await assert.rejects(scoped(data.schoolId, () => service.hideScheduleProfileApplicationHistory(data.input)), /Failed query|fixture audit failure/);
    const current = await scoped(data.schoolId, () => scheduling.getSchoolSchedulingContext(data.schoolId));
    assert.deepEqual(current.config.profileApplications, [data.application]); assert.equal(current.revision, data.saved.revision);
  } finally { await pool.query(`DROP TRIGGER ${name} ON audit_logs`); await pool.query(`DROP FUNCTION ${name}()`); }
});

test("the history route requires admin scope and a strict revision body and returns retained hide metadata", async () => {
  const data = await historyFixture({ role: "school_admin" }), other = await fixture();
  const { default: router } = await import("../src/routes/classpilot/scheduleProfiles.js");
  const { signUserToken } = await import("../src/services/jwt.js");
  const app = express(); app.use(express.json()); app.use("/api/classpilot/admin/schedule-profiles", router);
  app.use(((error, _req, res, _next) => { const known = error as Error & { status?: number; code?: string }; res.status(known.status ?? 500).json({ error: known.message, code: known.code }); }) satisfies express.ErrorRequestHandler);
  const server = createServer(app);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/classpilot/admin/schedule-profiles/applications/${data.application.id}/history`;
  const call = (body: unknown, userId?: string, schoolId = data.schoolId) => fetch(url, { method: "DELETE", headers: { "content-type": "application/json", ...(userId ? { authorization: `Bearer ${signUserToken({ userId, email: `${userId}@example.test`, isSuperAdmin: false })}`, "x-school-id": schoolId } : {}) }, body: JSON.stringify(body) });
  try {
    assert.equal((await call({ revision: 1 })).status, 401);
    assert.equal((await call({ revision: 1 }, data.teacherId)).status, 403);
    assert.equal((await call({ revision: 1 }, data.adminId, other.schoolId)).status, 403);
    assert.equal((await call({ revision: 1 }, other.adminId, other.schoolId)).status, 404);
    for (const body of [{}, [], { revision: "1" }, { revision: -1 }, { revision: 1, schoolId: other.schoolId }, { revision: 1, historyHiddenAt: "2000-01-01T00:00:00Z" }]) assert.equal((await call(body, data.adminId)).status, 400);
    assert.equal((await call({ revision: 0 }, data.adminId)).status, 409);
    const response = await call({ revision: data.saved.revision }, data.adminId);
    assert.equal(response.status, 200); assert.equal(response.headers.get("cache-control"), "no-store");
    const body = await response.json() as Awaited<ReturnType<typeof service.hideScheduleProfileApplicationHistory>>;
    assert.equal(body.hidden, true); assert.equal(body.applicationId, data.application.id); assert.equal(body.revision, data.saved.revision + 1); assert.ok(Number.isFinite(Date.parse(body.historyHiddenAt)));
    assert.deepEqual(await (await call({ revision: data.saved.revision }, data.adminId)).json(), body);
  } finally { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
});
test("overview summaries use committed dated snapshots and never write their metadata into the schedule", async () => {
  const data = await fixture();
  let noMeeting = datePlusDays(date, 1);
  while ([0, 6].includes(dateWeekday(noMeeting))) noMeeting = datePlusDays(noMeeting, 1);
  let later = datePlusDays(noMeeting, 1);
  while ([0, 6].includes(dateWeekday(later))) later = datePlusDays(later, 1);
  await pool.query("UPDATE groups SET schedule_rule=jsonb_set(schedule_rule,'{weekdays}',$2::jsonb) WHERE school_id=$1", [data.schoolId,
    JSON.stringify([1, 2, 3, 4, 5].filter((weekday) => weekday !== dateWeekday(noMeeting)))]);
  const definition: ScheduleProfileDefinition = { ...data.definition, classRules: [
    ...data.definition.classRules, { classId: data.nextClassId, action: "skip" },
  ] };
  const saved = await save(data, definition), input = { ...request(data, saved), dates: [date, noMeeting, later] };
  const preview = await scoped(data.schoolId, () => service.previewScheduleProfile(input));
  assert.deepEqual(preview.blockers, []);
  const applied = await scoped(data.schoolId, () => service.applyScheduleProfile({ ...input, previewToken: preview.previewToken }));
  const before = (await pool.query("SELECT config,revision,profile_activation_outcomes,updated_at FROM classpilot_school_schedules WHERE school_id=$1", [data.schoolId])).rows[0];
  const loaded = await scoped(data.schoolId, () => service.getScheduleProfiles(data.schoolId));
  assert.deepEqual(loaded.applications, [applied.application]);
  const summary = loaded.applicationSummaries[applied.application.id];
  assert.ok(summary);
  assert.deepEqual(summary.dates.map((row) => [row.date, row.phase, row.customTimeCount, row.skippedClassCount, row.testingBlockCount]), [
    [date, "future", 1, 1, 0], [noMeeting, "no_changes", 0, 0, 0], [later, "future", 1, 1, 0],
  ]);
  assert.equal(summary.nextFutureDate, date);
  assert.equal(summary.appliedToday, false);
  assert.deepEqual(summary.cancellation, { canRequest: true, cutoffAt: localDateTimeUtc(date, "09:00", "America/New_York").toISOString(), reason: null });
  assert.ok(Number.isFinite(Date.parse(loaded.summariesCheckedAt)));
  assert.equal(loaded.nextSchoolDateAt, localDateTimeUtc(datePlusDays(loaded.schoolLocalToday, 1), "00:00", loaded.schoolTimezone).toISOString());
  const after = (await pool.query("SELECT config,revision,profile_activation_outcomes,updated_at FROM classpilot_school_schedules WHERE school_id=$1", [data.schoolId])).rows[0];
  assert.deepEqual(after, before);

  const deleted = await scoped(data.schoolId, () => service.deleteScheduleProfile({ ...request(data, saved), revision: applied.revision }));
  const withoutSource = await scoped(data.schoolId, () => service.getScheduleProfiles(data.schoolId));
  assert.deepEqual(withoutSource.applications, loaded.applications);
  assert.deepEqual(withoutSource.applicationSummaries, { ...loaded.applicationSummaries, [applied.application.id]: {
    ...summary, historyRemoval: { ...summary.historyRemoval, checkedAt: withoutSource.summariesCheckedAt },
  } });
  const cancelled = await scoped(data.schoolId, () => service.cancelScheduleProfileApplication({ schoolId: data.schoolId, actorId: data.adminId, applicationId: applied.application.id, revision: deleted.revision }));
  const final = await scoped(data.schoolId, () => service.getScheduleProfiles(data.schoolId));
  assert.equal(final.revision, cancelled.revision);
  const finalSummary = final.applicationSummaries[applied.application.id];
  assert.ok(finalSummary);
  assert.equal(finalSummary.cancellation.reason, "cancelled");
  assert.equal(finalSummary.nextFutureDate, null);
  assert.ok(finalSummary.dates.every((row) => row.phase === "cancelled"));
});

test("overview and cancellation share the original-time cutoff and fail closed for unavailable class dependencies", async () => {
  const data = await fixture(), saved = await save(data), input = request(data, saved);
  const preview = await scoped(data.schoolId, () => service.previewScheduleProfile(input));
  const applied = await scoped(data.schoolId, () => service.applyScheduleProfile({ ...input, previewToken: preview.previewToken }));
  const cancel = { schoolId: data.schoolId, actorId: data.adminId, applicationId: applied.application.id, revision: applied.revision };
  const loaded = await scoped(data.schoolId, () => service.getScheduleProfiles(data.schoolId));
  const cutoffAt = loaded.applicationSummaries[applied.application.id]?.cancellation.cutoffAt;
  assert.ok(cutoffAt);
  await assert.rejects(scoped(data.schoolId, () => service.cancelScheduleProfileApplication({ ...cancel, now: new Date(cutoffAt) })), { code: "SCHEDULE_APPLICATION_STARTED", status: 409 });
  const before = await scoped(data.schoolId, () => scheduling.getSchoolSchedulingContext(data.schoolId));
  await pool.query("UPDATE groups SET status='archived' WHERE id=$1", [data.classId]);
  const unavailable = await scoped(data.schoolId, () => service.getScheduleProfiles(data.schoolId));
  assert.deepEqual(unavailable.applicationSummaries[applied.application.id]?.cancellation, { canRequest: false, cutoffAt: null, reason: "unavailable" });
  await assert.rejects(scoped(data.schoolId, () => service.cancelScheduleProfileApplication(cancel)), { code: "SCHEDULE_APPLICATION_TIMING_UNAVAILABLE", status: 409 });
  const after = await scoped(data.schoolId, () => scheduling.getSchoolSchedulingContext(data.schoolId));
  assert.deepEqual(after, before, "unavailable timing cannot cancel or increment the scheduling revision");
});

test("overview metadata remains administrator-only and school-scoped through the existing route", async () => {
  const data = await fixture(), other = await fixture(), saved = await save(data), input = request(data, saved);
  const preview = await scoped(data.schoolId, () => service.previewScheduleProfile(input));
  const applied = await scoped(data.schoolId, () => service.applyScheduleProfile({ ...input, previewToken: preview.previewToken }));
  const { default: router } = await import("../src/routes/classpilot/scheduleProfiles.js");
  const { signUserToken } = await import("../src/services/jwt.js");
  const app = express(); app.use(express.json()); app.use("/api/classpilot/admin/schedule-profiles", router);
  const server = createServer(app);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/classpilot/admin/schedule-profiles`;
  const call = (userId?: string, schoolId = data.schoolId) => fetch(url, { headers: userId ? {
    authorization: `Bearer ${signUserToken({ userId, email: `${userId}@example.test`, isSuperAdmin: false })}`, "x-school-id": schoolId,
  } : {} });
  try {
    assert.equal((await call()).status, 401);
    assert.equal((await call(data.teacherId)).status, 403);
    assert.equal((await call(data.adminId, other.schoolId)).status, 403);
    const response = await call(data.adminId);
    assert.equal(response.status, 200); assert.equal(response.headers.get("cache-control"), "no-store");
    const own = await response.json() as Awaited<ReturnType<typeof service.getScheduleProfiles>>;
    assert.deepEqual(Object.keys(own.applicationSummaries), [applied.application.id]);
    const foreign = await call(other.adminId, other.schoolId);
    assert.equal(foreign.status, 200);
    const foreignBody = await foreign.json() as Awaited<ReturnType<typeof service.getScheduleProfiles>>;
    assert.deepEqual(foreignBody.applicationSummaries, {});
  } finally {
    server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});

test("deleting an obsolete profile removes only its catalog entry and records its exact revision", async () => {
  const data = await fixture();
  const definition = { ...data.definition, testingBlocks: [{ id: "map", name: "MAP", coverageGroupId: data.scopeId,
    assignedStaffId: data.specialistId, startTime: "09:00", endTime: "09:45" }] };
  const saved = await save(data, definition), other = await save(data, { ...data.definition, name: "Keep this profile" }, saved.revision);
  // Deletion does not depend on the referenced setup still being usable.
  await pool.query("UPDATE groups SET status='archived',schedule_enabled=false WHERE id=$1", [data.classId]);
  await pool.query("UPDATE classpilot_coverage_scope_groups SET active=false WHERE id=$1", [data.scopeId]);
  await pool.query("UPDATE school_memberships SET status='disabled' WHERE school_id=$1 AND user_id=$2", [data.schoolId, data.specialistId]);
  const before = await scoped(data.schoolId, () => scheduling.getSchoolSchedulingContext(data.schoolId));
  const result = await scoped(data.schoolId, () => service.deleteScheduleProfile({ ...request(data, saved), revision: other.revision }));
  assert.deepEqual(result, { deleted: true, profileId: saved.profile.id, revision: other.revision + 1 });
  const after = await scoped(data.schoolId, () => scheduling.getSchoolSchedulingContext(data.schoolId));
  assert.deepEqual(after.config, { ...before.config, scheduleProfiles: [other.profile] });
  assert.equal(after.revision, result.revision);
  for (const [table, expected] of [["groups", 2], ["group_students", 2], ["classpilot_coverage_scope_groups", 1], ["classpilot_coverage_scope_group_members", 1], ["classpilot_coverage_assignments", 1]] as const) {
    const rows = table === "group_students"
      ? await pool.query("SELECT count(*)::int n FROM group_students WHERE student_id=$1", [data.studentId])
      : await pool.query(`SELECT count(*)::int n FROM ${table} WHERE school_id=$1`, [data.schoolId]);
    assert.equal(rows.rows[0].n, expected, `${table} is not deleted with the profile`);
  }
  const audit = await pool.query("SELECT user_id,entity_name,metadata FROM audit_logs WHERE school_id=$1 AND action='classpilot.schedule_profile.deleted'", [data.schoolId]);
  assert.deepEqual(audit.rows, [{ user_id: data.adminId, entity_name: saved.profile.definition.name,
    metadata: { profileRevision: saved.profile.revision, revision: result.revision, retainedApplications: 0 } }]);
  await assert.rejects(scoped(data.schoolId, () => service.deleteScheduleProfile({ ...request(data, saved), revision: result.revision })), { status: 404, code: "NOT_FOUND" });
  assert.equal((await scoped(data.schoolId, () => scheduling.getSchoolSchedulingContext(data.schoolId))).revision, result.revision);
});

test("profile deletion preserves dated snapshots and group dependencies; their existing cancellation still works", async () => {
  const data = await fixture();
  const saved = await save(data, { ...data.definition, testingBlocks: [{ id: "map", name: "MAP", coverageGroupId: data.scopeId,
    assignedStaffId: data.specialistId, startTime: "09:00", endTime: "09:45" }] });
  const input = request(data, saved), preview = await scoped(data.schoolId, () => service.previewScheduleProfile(input));
  assert.deepEqual(preview.blockers, []);
  const applied = await scoped(data.schoolId, () => service.applyScheduleProfile({ ...input, previewToken: preview.previewToken }));
  const result = await scoped(data.schoolId, () => service.deleteScheduleProfile({ ...input, revision: applied.revision }));
  const after = await scoped(data.schoolId, () => scheduling.getSchoolSchedulingContext(data.schoolId));
  assert.deepEqual(after.config.scheduleProfiles, []);
  assert.deepEqual(after.config.profileApplications, [applied.application]);
  assert.equal(resolveClassBaseWindow({ id: data.classId, scheduleEnabled: true, blockStartTime: "09:00", blockEndTime: "09:50",
    scheduleRule: defaultClassScheduleRule() }, date, after.config, after.calendar)?.startTime, "11:00");
  await assert.rejects(scoped(data.schoolId, () => service.applyScheduleProfile({ ...input, revision: result.revision, previewToken: preview.previewToken })), { code: "NOT_FOUND" });
  await assert.rejects(scoped(data.schoolId, () => service.saveScheduleProfile({ schoolId: data.schoolId, actorId: data.adminId,
    revision: result.revision, id: saved.profile.id, profileRevision: saved.profile.revision, definition: saved.profile.definition })), { code: "NOT_FOUND" });
  const deletion = await import("../src/services/classpilotCoverageDeletion.js");
  const { getCoverageScopeGroupByIdAndSchool } = await import("../src/services/storage.js");
  const stamp = (await scoped(data.schoolId, () => getCoverageScopeGroupByIdAndSchool(data.schoolId, data.scopeId)))!.updatedAt.toISOString();
  const deleteGroup = () => scoped(data.schoolId, () => deletion.deleteCoverageSupervisionGroup({ schoolId: data.schoolId,
    actorId: data.adminId, groupId: data.scopeId, body: { updatedAt: stamp } }));
  await assert.rejects(deleteGroup(), { code: "COVERAGE_DELETE_IN_USE" });
  const cancelled = await scoped(data.schoolId, () => service.cancelScheduleProfileApplication({ schoolId: data.schoolId,
    actorId: data.adminId, revision: result.revision, applicationId: applied.application.id }));
  assert.equal(cancelled.revision, result.revision + 1);
  const final = await scoped(data.schoolId, () => scheduling.getSchoolSchedulingContext(data.schoolId));
  assert.deepEqual(final.config.profileApplications, [{ ...applied.application, status: "cancelled" }]);
  await deleteGroup();
  assert.deepEqual((await scoped(data.schoolId, () => scheduling.getSchoolSchedulingContext(data.schoolId))).config.profileApplications, final.config.profileApplications);
});

test("deleting a profile retains past, cancelled and future applications and activation outcomes unchanged", async () => {
  const data = await fixture(), saved = await save(data);
  const context = await scoped(data.schoolId, () => scheduling.getSchoolSchedulingContext(data.schoolId));
  const applications: ScheduleProfileApplication[] = [
    { date: "2000-01-03", status: "scheduled" as const }, { date: "2000-01-04", status: "cancelled" as const }, { date, status: "scheduled" as const },
  ].map(item => ({ id: randomUUID(), profileId: saved.profile.id, profileRevision: saved.profile.revision,
    profileName: saved.profile.definition.name, definition: saved.profile.definition, dates: [item.date],
    classWindows: { [item.date]: { [data.classId]: { startTime: "11:00", endTime: "11:50" } } }, testingWindows: [],
    status: item.status, createdBy: data.adminId, createdAt: new Date().toISOString() })).sort((a, b) => a.id.localeCompare(b.id));
  const outcomes = { retained: { applicationId: applications[0]!.id, date: applications[0]!.dates[0], blockId: "old-block", status: "ended", code: "ENDED" } };
  await pool.query("UPDATE classpilot_school_schedules SET config=$2::jsonb,profile_activation_outcomes=$3::jsonb WHERE school_id=$1",
    [data.schoolId, JSON.stringify({ ...context.config, profileApplications: applications }), JSON.stringify(outcomes)]);
  const before = (await pool.query("SELECT config,profile_activation_outcomes FROM classpilot_school_schedules WHERE school_id=$1", [data.schoolId])).rows[0];
  await scoped(data.schoolId, () => service.deleteScheduleProfile(request(data, saved)));
  const after = (await pool.query("SELECT config,profile_activation_outcomes FROM classpilot_school_schedules WHERE school_id=$1", [data.schoolId])).rows[0];
  assert.deepEqual(after.config.profileApplications, before.config.profileApplications);
  assert.deepEqual(after.profile_activation_outcomes, before.profile_activation_outcomes);
  const audit = (await pool.query("SELECT metadata FROM audit_logs WHERE school_id=$1 AND action='classpilot.schedule_profile.deleted'", [data.schoolId])).rows[0];
  assert.equal(audit.metadata.retainedApplications, 3);
});

test("delete races serialize with edits, applications and repeated deletions; stale calendar writes cannot restore profiles", async () => {
  for (const contender of ["edit", "apply", "delete"] as const) {
    const data = await fixture(), saved = await save(data), input = request(data, saved);
    const context = await scoped(data.schoolId, () => scheduling.getSchoolSchedulingContext(data.schoolId));
    const calendarPreview = await scoped(data.schoolId, () => scheduling.previewSchoolScheduling({ schoolId: data.schoolId, config: context.config }));
    const preview = await scoped(data.schoolId, () => service.previewScheduleProfile(input));
    const remove = () => scoped(data.schoolId, () => service.deleteScheduleProfile(input));
    const competing = contender === "edit" ? () => scoped(data.schoolId, () => service.saveScheduleProfile({ schoolId: data.schoolId,
      actorId: data.adminId, revision: saved.revision, id: saved.profile.id, profileRevision: saved.profile.revision,
      definition: { ...data.definition, name: "Edited" } }))
      : contender === "apply" ? () => scoped(data.schoolId, () => service.applyScheduleProfile({ ...input, previewToken: preview.previewToken })) : remove;
    const results = await Promise.allSettled([remove(), competing()]);
    assert.equal(results.filter(result => result.status === "fulfilled").length, 1, contender);
    const loser = results.find(result => result.status === "rejected");
    assert.ok(loser?.status === "rejected");
    assert.ok(["SCHEDULE_PREVIEW_STALE", "NOT_FOUND"].includes(loser.reason.code));
    let after = await scoped(data.schoolId, () => scheduling.getSchoolSchedulingContext(data.schoolId));
    assert.equal(after.revision, saved.revision + 1);
    if (after.config.scheduleProfiles?.length) {
      await assert.rejects(remove(), { code: "SCHEDULE_PREVIEW_STALE" });
      const current = after.config.scheduleProfiles[0]!;
      await scoped(data.schoolId, () => service.deleteScheduleProfile({ ...input, revision: after.revision, profileRevision: current.revision }));
      after = await scoped(data.schoolId, () => scheduling.getSchoolSchedulingContext(data.schoolId));
    }
    await assert.rejects(scoped(data.schoolId, () => scheduling.saveSchoolScheduling({ schoolId: data.schoolId, actorId: data.adminId,
      config: context.config, expectedRevision: after.revision, previewToken: calendarPreview.previewToken })), { code: "SCHEDULE_PROFILE_WORKFLOW_REQUIRED" });
    assert.deepEqual((await scoped(data.schoolId, () => scheduling.getSchoolSchedulingContext(data.schoolId))).config.scheduleProfiles, []);
    assert.equal((await pool.query("SELECT count(*)::int n FROM audit_logs WHERE school_id=$1 AND action='classpilot.schedule_profile.deleted'", [data.schoolId])).rows[0].n, 1);
  }
});

test("delete rechecks each revision and active administrator authority without changing stored work", async () => {
  const data = await fixture(), other = await fixture(), saved = await save(data), input = request(data, saved);
  for (const override of [{ revision: saved.revision - 1 }, { profileRevision: saved.profile.revision + 1 }]) {
    await assert.rejects(scoped(data.schoolId, () => service.deleteScheduleProfile({ ...input, ...override })), { code: "SCHEDULE_PREVIEW_STALE", status: 409 });
  }
  await assert.rejects(scoped(data.schoolId, () => service.deleteScheduleProfile({ ...input, actorId: data.teacherId })), { code: "FORBIDDEN", status: 403 });
  await assert.rejects(scoped(other.schoolId, () => service.deleteScheduleProfile({ ...input, schoolId: other.schoolId, actorId: other.adminId })), { code: "NOT_FOUND", status: 404 });
  await pool.query("UPDATE school_memberships SET status='disabled' WHERE school_id=$1 AND user_id=$2", [data.schoolId, data.adminId]);
  await assert.rejects(scoped(data.schoolId, () => service.deleteScheduleProfile(input)), { code: "FORBIDDEN", status: 403 });
  const after = await scoped(data.schoolId, () => scheduling.getSchoolSchedulingContext(data.schoolId));
  assert.deepEqual(after.config.scheduleProfiles, [saved.profile]); assert.equal(after.revision, saved.revision);
  assert.equal((await pool.query("SELECT count(*)::int n FROM audit_logs WHERE school_id=$1 AND action='classpilot.schedule_profile.deleted'", [data.schoolId])).rows[0].n, 0);
});

test("a failed deletion audit rolls back the profile and scheduling revision", async () => {
  const data = await fixture(), saved = await save(data);
  const suffix = randomUUID().replaceAll("-", ""), functionName = `profile_delete_fail_${suffix}`, triggerName = functionName;
  await pool.query(`CREATE FUNCTION ${functionName}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture audit failure'; END $$`);
  await pool.query(`CREATE TRIGGER ${triggerName} BEFORE INSERT ON audit_logs FOR EACH ROW WHEN (NEW.school_id = '${data.schoolId}') EXECUTE FUNCTION ${functionName}()`);
  try {
    await assert.rejects(scoped(data.schoolId, () => service.deleteScheduleProfile(request(data, saved))), /Failed query|fixture audit failure/);
    const current = await scoped(data.schoolId, () => scheduling.getSchoolSchedulingContext(data.schoolId));
    assert.deepEqual(current.config.scheduleProfiles, [saved.profile]); assert.equal(current.revision, saved.revision);
  } finally { await pool.query(`DROP TRIGGER ${triggerName} ON audit_logs`); await pool.query(`DROP FUNCTION ${functionName}()`); }
  await scoped(data.schoolId, () => service.deleteScheduleProfile(request(data, saved)));
  assert.equal((await pool.query("SELECT count(*)::int n FROM audit_logs WHERE school_id=$1 AND action='classpilot.schedule_profile.deleted'", [data.schoolId])).rows[0].n, 1);
});

test("the delete route enforces authentication, school scope, revisions and a bounded request body", async () => {
  const data = await fixture("school_admin"), other = await fixture(), saved = await save(data);
  const { default: router } = await import("../src/routes/classpilot/scheduleProfiles.js");
  const { signUserToken } = await import("../src/services/jwt.js");
  const app = express(); app.use(express.json()); app.use("/api/classpilot/admin/schedule-profiles", router);
  app.use(((error, _req, res, _next) => {
    const known = error as Error & { status?: number; code?: string };
    res.status(known.status ?? 500).json({ error: known.message, code: known.code });
  }) satisfies express.ErrorRequestHandler);
  const server = createServer(app);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/classpilot/admin/schedule-profiles/${saved.profile.id}`;
  const call = (body: unknown, userId?: string, schoolId = data.schoolId) => fetch(url, { method: "DELETE",
    headers: { "content-type": "application/json", ...(userId ? { authorization: `Bearer ${signUserToken({ userId, email: `${userId}@example.test`, isSuperAdmin: false })}`, "x-school-id": schoolId } : {}) },
    body: JSON.stringify(body) });
  const body = { revision: saved.revision, profileRevision: saved.profile.revision };
  try {
    assert.equal((await call(body)).status, 401);
    assert.equal((await call(body, data.teacherId)).status, 403);
    assert.equal((await call(body, data.adminId, other.schoolId)).status, 403);
    assert.equal((await call(body, other.adminId, other.schoolId)).status, 404);
    for (const invalid of [{}, [], { ...body, schoolId: other.schoolId }, { ...body, revision: "1" }, { ...body, revision: -1 }, { ...body, profileRevision: 0 }, { ...body, profileRevision: null }]) {
      assert.equal((await call(invalid, data.adminId)).status, 400);
    }
    assert.equal((await call({ ...body, profileRevision: 2 }, data.adminId)).status, 409);
    const response = await call(body, data.adminId);
    assert.equal(response.status, 200); assert.equal(response.headers.get("cache-control"), "no-store");
    assert.deepEqual(await response.json(), { deleted: true, profileId: saved.profile.id, revision: saved.revision + 1 });
    assert.equal((await call(body, data.adminId)).status, 404);
    assert.equal((await pool.query("SELECT count(*)::int n FROM audit_logs WHERE school_id=$1 AND action='classpilot.schedule_profile.deleted'", [data.schoolId])).rows[0].n, 1);
  } finally {
    server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});

test("shared preview dates survive legacy edits and scheduling round trips without activating the profile", async () => {
  const data = await fixture();
  const legacy = await save(data);
  assert.equal(Object.hasOwn(legacy.profile, "previewDate"), false);
  const saved = await scoped(data.schoolId, () => service.saveScheduleProfile({ schoolId: data.schoolId, actorId: data.adminId,
    revision: legacy.revision, id: legacy.profile.id, profileRevision: legacy.profile.revision,
    definition: legacy.profile.definition, previewDate: "2000-01-01" }));
  assert.equal(saved.profile.previewDate, "2000-01-01");
  assert.equal(saved.profile.revision, legacy.profile.revision + 1);
  assert.equal(saved.revision, legacy.revision + 1);
  const editedByLegacyClient = await scoped(data.schoolId, () => service.saveScheduleProfile({ schoolId: data.schoolId, actorId: data.adminId,
    revision: saved.revision, id: saved.profile.id, profileRevision: saved.profile.revision,
    definition: { ...saved.profile.definition, name: "MAP review" } }));
  assert.equal(editedByLegacyClient.profile.previewDate, "2000-01-01");
  const otherLegacyProfile = await save(data, { ...data.definition, name: "Legacy create" }, editedByLegacyClient.revision);
  assert.equal(Object.hasOwn(otherLegacyProfile.profile, "previewDate"), false);

  const before = await scoped(data.schoolId, () => scheduling.getSchoolSchedulingContext(data.schoolId));
  const calendarPreview = await scoped(data.schoolId, () => scheduling.previewSchoolScheduling({ schoolId: data.schoolId, config: before.config }));
  assert.deepEqual(calendarPreview.blockers, []);
  await scoped(data.schoolId, () => scheduling.saveSchoolScheduling({ schoolId: data.schoolId, actorId: data.adminId,
    config: before.config, expectedRevision: before.revision, previewToken: calendarPreview.previewToken }));
  const after = await scoped(data.schoolId, () => scheduling.getSchoolSchedulingContext(data.schoolId));
  assert.deepEqual(after.config.scheduleProfiles, before.config.scheduleProfiles);
  assert.deepEqual(after.config.profileApplications, []);
  assert.deepEqual(resolveClassBaseWindow({ id: data.classId, scheduleEnabled: true, blockStartTime: "09:00", blockEndTime: "09:50",
    scheduleRule: defaultClassScheduleRule() }, date, after.config, after.calendar), { startTime: "09:00", endTime: "09:50" });
});

test("date-only saves serialize, invalidate old reviews, and leave existing application snapshots unchanged", async () => {
  const data = await fixture(), saved = await save(data);
  const input = request(data, saved);
  const preview = await scoped(data.schoolId, () => service.previewScheduleProfile(input));
  assert.deepEqual(preview.blockers, []);
  const attempts = await Promise.allSettled(["2026-09-14", "2035-12-31"].map(previewDate => scoped(data.schoolId,
    () => service.saveScheduleProfile({ schoolId: data.schoolId, actorId: data.adminId, revision: saved.revision,
      id: saved.profile.id, profileRevision: saved.profile.revision, definition: saved.profile.definition, previewDate }))));
  assert.equal(attempts.filter(result => result.status === "fulfilled").length, 1);
  for (const result of attempts) if (result.status === "rejected") assert.equal(result.reason.code, "SCHEDULE_PREVIEW_STALE");
  const winner = attempts.find(result => result.status === "fulfilled");
  assert.ok(winner?.status === "fulfilled");
  const current = winner.value;
  assert.equal(current.revision, saved.revision + 1);
  assert.equal(current.profile.revision, saved.profile.revision + 1);
  assert.deepEqual(current.profile.definition, saved.profile.definition);
  await assert.rejects(scoped(data.schoolId, () => service.saveScheduleProfile({ schoolId: data.schoolId, actorId: data.adminId,
    revision: current.revision, id: current.profile.id, profileRevision: saved.profile.revision,
    definition: current.profile.definition, previewDate: "2026-09-15" })), { code: "SCHEDULE_PREVIEW_STALE" });
  await assert.rejects(scoped(data.schoolId, () => service.applyScheduleProfile({ ...input, previewToken: preview.previewToken })),
    { code: "SCHEDULE_PREVIEW_STALE" });
  const freshInput = request(data, current);
  await assert.rejects(scoped(data.schoolId, () => service.applyScheduleProfile({ ...freshInput, previewToken: preview.previewToken })),
    { code: "SCHEDULE_PREVIEW_STALE" });
  const freshPreview = await scoped(data.schoolId, () => service.previewScheduleProfile(freshInput));
  assert.notEqual(freshPreview.previewToken, preview.previewToken);
  assert.deepEqual(freshPreview.changes, preview.changes);
  const applied = await scoped(data.schoolId, () => service.applyScheduleProfile({ ...freshInput, previewToken: freshPreview.previewToken }));
  assert.deepEqual(applied.application.dates, [date]);
  assert.equal(Object.hasOwn(applied.application, "previewDate"), false);
  assert.equal(Object.hasOwn(applied.application.definition, "previewDate"), false);
  await scoped(data.schoolId, () => service.saveScheduleProfile({ schoolId: data.schoolId, actorId: data.adminId,
    revision: applied.revision, id: current.profile.id, profileRevision: current.profile.revision,
    definition: current.profile.definition, previewDate: "2000-01-01" }));
  const after = await scoped(data.schoolId, () => scheduling.getSchoolSchedulingContext(data.schoolId));
  assert.deepEqual(after.config.profileApplications, [applied.application]);
  assert.equal(after.config.scheduleProfiles?.[0]?.previewDate, "2000-01-01");
});

test("the save route shares preview dates with another administrator, audits them and rejects invalid or unauthorized writes", async () => {
  const data = await fixture(), other = await fixture();
  await pool.query("UPDATE school_memberships SET role='school_admin' WHERE school_id=$1 AND user_id=$2", [data.schoolId, data.specialistId]);
  const { default: router } = await import("../src/routes/classpilot/scheduleProfiles.js");
  const { signUserToken } = await import("../src/services/jwt.js");
  const app = express(); app.use(express.json()); app.use("/api/classpilot/admin/schedule-profiles", router);
  app.use(((error, _req, res, _next) => {
    const known = error as Error & { status?: number; code?: string };
    res.status(known.status ?? 500).json({ error: known.message, code: known.code });
  }) satisfies express.ErrorRequestHandler);
  const server = createServer(app);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/classpilot/admin/schedule-profiles`;
  const call = (method: string, userId?: string, body?: unknown, schoolId = data.schoolId) => fetch(url, { method,
    headers: { "content-type": "application/json", ...(userId ? { authorization: `Bearer ${signUserToken({ userId, email: `${userId}@example.test`, isSuperAdmin: false })}`, "x-school-id": schoolId } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  try {
    const create = { revision: 0, definition: data.definition, previewDate: "2000-01-01" };
    assert.equal((await call("POST", undefined, create)).status, 401);
    assert.equal((await call("POST", data.teacherId, create)).status, 403);
    assert.equal((await call("POST", data.adminId, create, other.schoolId)).status, 403);
    const response = await call("POST", data.adminId, { ...create, schoolId: other.schoolId });
    assert.equal(response.status, 201);
    const saved = await response.json() as Awaited<ReturnType<typeof service.saveScheduleProfile>>;
    assert.equal(saved.profile.previewDate, create.previewDate);
    const read = await call("GET", data.specialistId);
    assert.equal(read.status, 200); assert.equal(read.headers.get("cache-control"), "no-store");
    const shared = await read.json() as Awaited<ReturnType<typeof service.getScheduleProfiles>>;
    assert.deepEqual(shared.profiles, [saved.profile]);
    assert.deepEqual(shared.applications, []);
    const foreignRead = await call("GET", other.adminId, undefined, other.schoolId);
    assert.equal(foreignRead.status, 200);
    assert.deepEqual((await foreignRead.json() as Awaited<ReturnType<typeof service.getScheduleProfiles>>).profiles, []);
    const edit = { revision: saved.revision, id: saved.profile.id, profileRevision: saved.profile.revision,
      definition: saved.profile.definition };
    for (const previewDate of [null, "", "2026-02-30", "2026-9-14", [date], 20260914]) {
      const invalid = await call("POST", data.specialistId, { ...edit, previewDate });
      assert.equal(invalid.status, 400);
      assert.deepEqual(await invalid.json(), { error: "Preview date must be a real date in YYYY-MM-DD format.", code: "INVALID_SCHEDULE_PROFILE" });
    }
    const unchanged = await scoped(data.schoolId, () => scheduling.getSchoolSchedulingContext(data.schoolId));
    assert.equal(unchanged.revision, saved.revision);
    assert.deepEqual(unchanged.config.scheduleProfiles, [saved.profile]);
    await pool.query("UPDATE settings SET instructional_calendar=$2::jsonb WHERE school_id=$1", [data.schoolId,
      JSON.stringify({ [date.slice(0, 7)]: { nonInstructionalDates: [date] } })]);
    const edited = await call("POST", data.specialistId, { ...edit, previewDate: date });
    assert.equal(edited.status, 200);
    const updated = await edited.json() as Awaited<ReturnType<typeof service.saveScheduleProfile>>;
    assert.equal(updated.profile.previewDate, date);
    const audit = await pool.query<{ user_id: string; metadata: { revision: number; previewDate: string } }>(
      "SELECT user_id,metadata FROM audit_logs WHERE school_id=$1 AND action='classpilot.schedule_profile.saved' AND entity_id=$2 ORDER BY created_at,id",
      [data.schoolId, saved.profile.id]);
    assert.equal(audit.rows.length, 2);
    assert.ok(audit.rows.some(row => row.user_id === data.specialistId && row.metadata.previewDate === date && row.metadata.revision === updated.profile.revision));
    const reopened = await call("GET", data.adminId);
    assert.deepEqual((await reopened.json() as Awaited<ReturnType<typeof service.getScheduleProfiles>>).profiles, [updated.profile]);
  } finally {
    server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
test("regular reference reads are school-scoped, preserve every stored schedule, and ignore applied/swap/frozen/skip-day state", async () => {
  const data = await fixture(), other = await fixture();
  const saved = await save(data), input = request(data, saved);
  const preview = await scoped(data.schoolId, () => service.previewScheduleProfile(input));
  const applied = await scoped(data.schoolId, () => service.applyScheduleProfile({ ...input, previewToken: preview.previewToken }));
  await pool.query("UPDATE groups SET schedule_skipped_date=$1 WHERE id=$2", [date, data.classId]);
  await pool.query("UPDATE groups SET status='archived' WHERE id=$1", [data.nextClassId]);
  await pool.query("INSERT INTO teaching_sessions(group_id,school_id,teacher_id,scheduled_date,scheduled_timezone,scheduled_start_at,scheduled_end_at,scheduled_state) VALUES($1,$2,$3,$4,'America/New_York',$5,$6,'active')", [data.classId, data.schoolId, data.teacherId, date, localDateTimeUtc(date, "12:00", "America/New_York").toISOString(), localDateTimeUtc(date, "12:50", "America/New_York").toISOString()]);
  const before = await scoped(data.schoolId, () => scheduling.getSchoolSchedulingContext(data.schoolId));
  const result = await scoped(data.schoolId, () => regularSchedule.getClasspilotRegularSchedule({ schoolId: data.schoolId, referenceDate: date }));
  assert.equal(result.revision, applied.revision);
  assert.deepEqual(result.classes, [{ classId: data.classId, status: "meets", window: { startTime: "09:00", endTime: "09:50" } }]);
  const reviewed = await scoped(data.schoolId, () => draftReview.getScheduleDraftReview({ schoolId: data.schoolId, referenceDate: date, definition: { ...data.definition, classRules: [] } }));
  assert.deepEqual(reviewed.classes.map((row) => ({ classId: row.classId, window: row.proposedWindow })), [{ classId: data.classId, window: { startTime: "09:00", endTime: "09:50" } }]);
  assert.deepEqual(await scoped(data.schoolId, () => scheduling.getSchoolSchedulingContext(data.schoolId)), before);
  assert.equal((await pool.query("SELECT schedule_skipped_date FROM groups WHERE id=$1", [data.classId])).rows[0].schedule_skipped_date, date);
  assert.equal((await pool.query("SELECT scheduled_start_at FROM teaching_sessions WHERE group_id=$1", [data.classId])).rows[0].scheduled_start_at.toISOString(), localDateTimeUtc(date, "12:00", "America/New_York").toISOString());
  // Give the other school a real approved swap, independently of the first
  // school's applied profile, so its effective schedule is demonstrably different.
  const pairId = randomUUID(), swapId = randomUUID();
  const [firstGroupId, secondGroupId] = [other.classId, other.nextClassId].sort();
  await fixtureTransaction(async (client) => {
    await client.query("INSERT INTO classpilot_schedule_change_pairs(id,school_id,first_group_id,second_group_id,created_by) VALUES($1,$2,$3,$4,$5)", [pairId, other.schoolId, firstGroupId, secondGroupId, other.adminId]);
    await client.query("INSERT INTO classpilot_schedule_changes(id,school_id,pair_id,scheduled_date,timezone_snapshot,status,reason,requested_by_user_id,requested_by_role,requires_admin_approval,reservation_active,approved_by_user_id,approved_at) VALUES($1,$2,$3,$4,'America/New_York','approved','Regular reference fixture',$5,'admin',false,true,$5,now())", [swapId, other.schoolId, pairId, date, other.adminId]);
    await client.query(`INSERT INTO classpilot_schedule_change_legs(school_id,schedule_change_id,scheduled_date,leg_order,group_id,primary_teacher_id_snapshot,class_name_snapshot,original_start_time,original_end_time,effective_start_time,effective_end_time,reservation_active)
      VALUES($1,$2,$3,1,$4,$6,'Grade 5 Math','09:00','09:50','10:00','10:50',true),
            ($1,$2,$3,2,$5,$6,'Grade 5 Reading','10:00','10:50','09:00','09:50',true)`, [other.schoolId, swapId, date, other.classId, other.nextClassId, other.teacherId]);
  });
  const effectiveWindow = () => scoped(other.schoolId, () => getEffectiveClasspilotScheduleWindow({
    schoolId: other.schoolId, scheduledDate: date, timeZone: "America/New_York",
    group: { id: other.classId, scheduleEnabled: true, blockStartTime: "09:00", blockEndTime: "09:50", scheduleRule: defaultClassScheduleRule() },
  }));
  const swapped = await effectiveWindow();
  assert.equal(swapped?.source, "swap");
  assert.equal(swapped?.swapId, swapId);
  assert.deepEqual([swapped?.blockStartTime, swapped?.blockEndTime], ["10:00", "10:50"]);
  const otherResult = await scoped(other.schoolId, () => regularSchedule.getClasspilotRegularSchedule({ schoolId: other.schoolId, referenceDate: date }));
  assert.deepEqual(otherResult.classes.map(row => row.classId).sort(), [other.classId, other.nextClassId].sort());
  assert.deepEqual(otherResult.classes.find(row => row.classId === other.classId)?.window, { startTime: "09:00", endTime: "09:50" });
  assert.deepEqual(otherResult.classes.find(row => row.classId === other.nextClassId)?.window, { startTime: "10:00", endTime: "10:50" });
  const swappedReview = await scoped(other.schoolId, () => draftReview.getScheduleDraftReview({ schoolId: other.schoolId, referenceDate: date, definition: { ...other.definition, classRules: [] } }));
  assert.deepEqual(swappedReview.classes.find(row => row.classId === other.classId)?.proposedWindow, { startTime: "09:00", endTime: "09:50" });
  assert.deepEqual(await effectiveWindow(), swapped);
});

test("regular reference excludes unrelated profile snapshots before validation and preserves stored JSON", async () => {
  const data = await fixture();
  const config = {
    ...emptySchoolSchedulingConfig(),
    scheduleProfiles: [{ name: "Malformed unused profile" }],
    profileApplications: [{ testingWindows: [{ studentIds: [data.studentId], coverageGroupId: data.scopeId }] }],
  };
  await pool.query("INSERT INTO classpilot_school_schedules(school_id,revision,config) VALUES($1,7,$2::jsonb)", [data.schoolId, JSON.stringify(config)]);
  const stored = async () => (await pool.query("SELECT revision,config,updated_at FROM classpilot_school_schedules WHERE school_id=$1", [data.schoolId])).rows[0];
  const before = await stored();
  const result = await scoped(data.schoolId, () => regularSchedule.getClasspilotRegularSchedule({ schoolId: data.schoolId, referenceDate: date }));
  assert.equal(result.revision, 7);
  assert.deepEqual(result.classes, [
    { classId: data.classId, status: "meets", window: { startTime: "09:00", endTime: "09:50" } },
    { classId: data.nextClassId, status: "meets", window: { startTime: "10:00", endTime: "10:50" } },
  ].sort((a, b) => a.classId.localeCompare(b.classId)));
  assert.equal(JSON.stringify(result).includes(data.studentId), false);
  assert.deepEqual(await stored(), before);
});

test("regular reference route enforces admin entitlement and active school selection without disclosing extra fields", async () => {
  const data = await fixture(), other = await fixture();
  const { default: router } = await import("../src/routes/classpilot/scheduleProfiles.js");
  const { signUserToken } = await import("../src/services/jwt.js");
  const app = express();
  app.use("/api/classpilot/admin/schedule-profiles", router);
  app.use(((error, _req, res, _next) => {
    const known = error as Error & { status?: number; code?: string };
    res.status(known.status ?? 500).json({ error: known.message, code: known.code });
  }) satisfies express.ErrorRequestHandler);
  const server = createServer(app);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/classpilot/admin/schedule-profiles/regular-schedule`;
  const headers = (userId: string, schoolId = data.schoolId) => ({ authorization: `Bearer ${signUserToken({ userId, email: `${userId}@example.test`, isSuperAdmin: false })}`, "x-school-id": schoolId });
  try {
    assert.equal((await fetch(`${base}?referenceDate=${date}`)).status, 401);
    assert.equal((await fetch(`${base}?referenceDate=${date}`, { headers: headers(data.teacherId) })).status, 403);
    assert.equal((await fetch(`${base}?referenceDate=${date}`, { headers: headers(data.adminId, other.schoolId) })).status, 403);
    const response = await fetch(`${base}?referenceDate=${date}&schoolId=${other.schoolId}`, { headers: headers(data.adminId) });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    const body = await response.json() as Awaited<ReturnType<typeof regularSchedule.getClasspilotRegularSchedule>>;
    assert.deepEqual(body.classes.map(row => row.classId).sort(), [data.classId, data.nextClassId].sort());
    assert.deepEqual(Object.keys(body).sort(), ["classes", "day", "referenceDate", "revision", "schoolTimezone"]);
    assert.ok(body.classes.every(row => Object.keys(row).sort().join(",") === "classId,status,window"));
    assert.doesNotMatch(JSON.stringify(body), /studentIds|deviceId|teacherId|scheduleProfiles|profileApplications|teachingSessionId/);
    for (const query of ["", "?referenceDate=2026-02-30", `?referenceDate=${date}&referenceDate=${date}`, `?referenceDate[value]=${date}`]) {
      const invalid = await fetch(base + query, { headers: headers(data.adminId) });
      assert.equal(invalid.status, 400);
      const failure = await invalid.json() as { code: string };
      assert.equal(failure.code, "INVALID_REFERENCE_DATE");
    }
    await pool.query("UPDATE schools SET is_active=false WHERE id=$1", [data.schoolId]);
    assert.equal((await fetch(`${base}?referenceDate=${date}`, { headers: headers(data.adminId) })).status, 403);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});

test("draft review resolves scoped roster counts without mutation and keeps valid feedback beside incomplete blocks", async () => {
  const data = await fixture(), other = await fixture();
  const definition = { ...data.definition, classRules: [], testingBlocks: [{ id: "map", name: "MAP", coverageGroupId: data.scopeId, assignedStaffId: data.specialistId, startTime: "09:00", endTime: "10:45" },
    { id: "unfinished", name: "", coverageGroupId: "", assignedStaffId: "", startTime: "", endTime: "" }] };
  const snapshot = async () => {
    const rows: Record<string, unknown> = {};
    for (const table of ["classpilot_school_schedules", "groups", "students", "settings", "classpilot_coverage_scope_groups", "classpilot_coverage_assignments", "classpilot_coverage_scope_group_members", "classpilot_supervision_contexts", "teaching_sessions", "audit_logs"]) {
      rows[table] = (await pool.query(`SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]'::jsonb) AS rows FROM ${table} t WHERE school_id=$1`, [data.schoolId])).rows[0].rows;
    }
    return rows;
  };
  const before = await snapshot();
  const first = await scoped(data.schoolId, () => draftReview.getScheduleDraftReview({ schoolId: data.schoolId, referenceDate: date, definition }));
  const second = await scoped(data.schoolId, () => draftReview.getScheduleDraftReview({ schoolId: data.schoolId, referenceDate: date, definition }));
  assert.deepEqual(first, second); assert.deepEqual(await snapshot(), before);
  assert.equal(first.revision, 0); assert.equal(first.complete, false); assert.equal(first.counts.incomplete, 1);
  assert.equal(first.counts.overlaps, 2);
  assert.deepEqual(first.testingBlocks.find((row) => row.blockId === "map")?.classParticipation.sort((a, b) => a.classId.localeCompare(b.classId)), [data.classId, data.nextClassId].sort().map(classId => ({ classId, count: 1, total: 1 })));
  assert.doesNotMatch(JSON.stringify(first), /studentIds|deviceId|teachingSessionId/);
  for (const id of [data.studentId, other.studentId, other.classId, other.scopeId]) assert.equal(JSON.stringify(first).includes(id), false);
  const foreign = await scoped(data.schoolId, () => draftReview.getScheduleDraftReview({ schoolId: data.schoolId, referenceDate: date, definition: { ...definition, testingBlocks: [{ ...definition.testingBlocks[0]!, coverageGroupId: other.scopeId, assignedStaffId: other.specialistId }] } }));
  assert.equal(foreign.complete, false); assert.equal(foreign.testingBlocks[0]?.groupName, null); assert.equal(foreign.testingBlocks[0]?.staffName, null); assert.equal(foreign.testingBlocks[0]?.studentCount, 0);
});

test("conflicting complete profiles save, while review and authoritative application retain their separate checks", async () => {
  const data = await fixture();
  const definition: ScheduleProfileDefinition = { ...data.definition, classRules: [{ classId: data.classId, action: "time", startTime: "09:30", endTime: "10:30" }] };
  const saved = await save(data, definition);
  const review = await scoped(data.schoolId, () => draftReview.getScheduleDraftReview({ schoolId: data.schoolId, referenceDate: date, definition: saved.profile.definition }));
  assert.equal(review.revision, saved.revision); assert.equal(review.complete, true);
  assert.ok(review.issues.some((issue) => issue.code === "CLASS_SCHEDULE_CONFLICT"));
  const preview = await scoped(data.schoolId, () => service.previewScheduleProfile(request(data, saved)));
  assert.ok(preview.blockers.some((issue) => issue.code === "CLASS_SCHEDULE_CONFLICT"));
  await assert.rejects(scoped(data.schoolId, () => service.applyScheduleProfile({ ...request(data, saved), previewToken: preview.previewToken })), { code: "CLASS_SCHEDULE_CONFLICT" });
  const fixed = { ...definition, classRules: [{ classId: data.classId, action: "time" as const, startTime: "09:00", endTime: "10:00" }] };
  const clean = await scoped(data.schoolId, () => draftReview.getScheduleDraftReview({ schoolId: data.schoolId, referenceDate: date, definition: fixed }));
  assert.equal(clean.counts.conflicts, 0);
  await assert.rejects(scoped(data.schoolId, () => service.saveScheduleProfile({ schoolId: data.schoolId, actorId: data.adminId, revision: saved.revision,
    definition: { ...fixed, testingBlocks: [{ id: "unfinished", name: "MAP", coverageGroupId: "", assignedStaffId: "", startTime: "", endTime: "" }] } })), { code: "INVALID_SCHEDULE_PROFILE" });
});

test("draft review route is administrator-only, school-bound and strict about request structure", async () => {
  const data = await fixture(), other = await fixture();
  const { default: router } = await import("../src/routes/classpilot/scheduleProfiles.js");
  const { signUserToken } = await import("../src/services/jwt.js");
  const app = express(); app.use(express.json()); app.use("/api/classpilot/admin/schedule-profiles", router);
  app.use(((error, _req, res, _next) => {
    const known = error as Error & { status?: number; code?: string };
    res.status(known.status ?? 500).json({ error: known.message, code: known.code });
  }) satisfies express.ErrorRequestHandler);
  const server = createServer(app);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/classpilot/admin/schedule-profiles/draft-review`;
  const requestBody = { referenceDate: date, definition: data.definition };
  const post = (body: unknown, userId?: string, schoolId = data.schoolId) => fetch(url, { method: "POST", headers: { "content-type": "application/json", ...(userId ? { authorization: `Bearer ${signUserToken({ userId, email: `${userId}@example.test`, isSuperAdmin: false })}`, "x-school-id": schoolId } : {}) }, body: JSON.stringify(body) });
  try {
    assert.equal((await post(requestBody)).status, 401);
    assert.equal((await post(requestBody, data.teacherId)).status, 403);
    assert.equal((await post(requestBody, data.adminId, other.schoolId)).status, 403);
    const response = await post({ ...requestBody, schoolId: other.schoolId }, data.adminId);
    assert.equal(response.status, 200); assert.equal(response.headers.get("cache-control"), "no-store");
    const body = await response.json() as Awaited<ReturnType<typeof draftReview.getScheduleDraftReview>>;
    assert.deepEqual(body.classes.map((row) => row.classId).sort(), [data.classId, data.nextClassId].sort());
    assert.match(body.requestFingerprint, /^[a-f0-9]{64}$/);
    for (const referenceDate of [null, [date], "2026-02-30", "2026-9-01"]) assert.equal((await post({ ...requestBody, referenceDate }, data.adminId)).status, 400);
    for (const definition of [null, { ...data.definition, schoolId: other.schoolId }, { ...data.definition, testingBlocks: "invalid" }, { ...data.definition, classIds: ["constructor"] }]) assert.equal((await post({ ...requestBody, definition }, data.adminId)).status, 400);
    await pool.query("UPDATE schools SET is_active=false WHERE id=$1", [data.schoolId]);
    assert.equal((await post(requestBody, data.adminId)).status, 403);
  } finally {
    server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});

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
test("a loaded profile preserves Keep as no rule so later regular edits apply while custom clocks stay fixed", async () => {
  const data = await fixture();
  const draft = await save(data, { ...data.definition, classRules: [] });
  const loaded = await scoped(data.schoolId, () => service.getScheduleProfiles(data.schoolId));
  const profile = loaded.profiles.find(row => row.id === draft.profile.id)!;
  assert.deepEqual(profile.definition.classRules, []);
  const custom = await scoped(data.schoolId, () => service.saveScheduleProfile({ schoolId: data.schoolId, actorId: data.adminId,
    revision: loaded.revision, id: profile.id, profileRevision: profile.revision,
    definition: { ...profile.definition, classRules: [{ classId: data.nextClassId, action: "time", startTime: "11:00", endTime: "11:50" }] } }));
  await pool.query("UPDATE groups SET block_start_time='08:30',block_end_time='09:20' WHERE id=$1", [data.classId]);
  await pool.query("UPDATE groups SET block_start_time='10:15',block_end_time='11:05' WHERE id=$1", [data.nextClassId]);
  const input = request(data, custom);
  const preview = await scoped(data.schoolId, () => service.previewScheduleProfile(input));
  assert.deepEqual(preview.blockers, []);
  assert.deepEqual(preview.changes, [{ date, classId: data.nextClassId, className: "Grade 5 Reading",
    before: { startTime: "10:15", endTime: "11:05" }, after: { startTime: "11:00", endTime: "11:50" } }]);
  const applied = await scoped(data.schoolId, () => service.applyScheduleProfile({ ...input, previewToken: preview.previewToken }));
  assert.deepEqual(Object.keys(applied.application.classWindows[date]!), [data.nextClassId]);
  const context = await scoped(data.schoolId, () => scheduling.getSchoolSchedulingContext(data.schoolId));
  const kept = { id: data.classId, scheduleEnabled: true, blockStartTime: "08:30", blockEndTime: "09:20", scheduleRule: defaultClassScheduleRule() };
  const changed = { ...kept, id: data.nextClassId, blockStartTime: "10:15", blockEndTime: "11:05" };
  assert.deepEqual(resolveClassBaseWindow(kept, date, context.config, context.calendar), { startTime: "08:30", endTime: "09:20" });
  assert.deepEqual(resolveClassBaseWindow(changed, date, context.config, context.calendar), { startTime: "11:00", endTime: "11:50" });
  assert.deepEqual(resolveClassBaseWindow(changed, datePlusDays(date, 7), context.config, context.calendar), { startTime: "10:15", endTime: "11:05" });
});

test("scheduler discovers fixed classes moved outside their original clocks and starts each applied occurrence once", async () => {
  for (const [startTime, endTime] of [["08:00", "08:45"], ["11:00", "11:50"]]) {
    assert.ok(startTime && endTime);
    const data = await fixture();
    const saved = await save(data, { ...data.definition, classRules: [{ classId: data.classId, action: "time", startTime, endTime }] });
    const input = request(data, saved);
    const preview = await scoped(data.schoolId, () => service.previewScheduleProfile(input));
    assert.deepEqual(preview.blockers, []);
    const applied = await scoped(data.schoolId, () => service.applyScheduleProfile({ ...input, previewToken: preview.previewToken }));
    const ready = (clock: string, scheduledDate = date) => scoped(data.schoolId, () => getClasspilotGroupsReadyAtEffectiveWindow({ schoolId: data.schoolId, scheduledDate, currentTimeHHMM: clock }));
    assert.equal((await ready("09:15")).some(group => group.id === data.classId), false, "the original window is suppressed");
    assert.equal((await ready(endTime)).some(group => group.id === data.classId), false, "the applied end is exclusive");
    assert.equal((await ready(startTime, datePlusDays(date, 7))).some(group => group.id === data.classId), false, "application clocks cannot leak onto another date");
    assert.equal((await ready("09:15", datePlusDays(date, 7))).some(group => group.id === data.classId), true);
    const candidates = await ready(startTime);
    const group = candidates.find(row => row.id === data.classId);
    assert.ok(group, "a shifted fixed-time class must be discovered even outside its original window");
    const now = localDateTimeUtc(date, startTime, "America/New_York");
    const started = await scoped(data.schoolId, () => processScheduledClassAutoStart({ group, scheduledDate: date, now, scheduledTeacherConnectedOverride: true }));
    assert.equal(started.status, "started");
    assert.ok(started.status === "started");
    assert.equal(started.session.scheduledStartAt?.toISOString(), now.toISOString());
    assert.equal(started.session.scheduledEndAt?.toISOString(), localDateTimeUtc(date, endTime, "America/New_York").toISOString());
    const repeated = await scoped(data.schoolId, () => processScheduledClassAutoStart({ group, scheduledDate: date, now, scheduledTeacherConnectedOverride: true }));
    assert.equal(repeated.status, "already_live");
    const count = await pool.query("SELECT count(*)::int n FROM teaching_sessions WHERE school_id=$1 AND group_id=$2 AND scheduled_date=$3", [data.schoolId, data.classId, date]);
    assert.equal(count.rows[0].n, 1);
    const context = await scoped(data.schoolId, () => scheduling.getSchoolSchedulingContext(data.schoolId));
    assert.deepEqual(context.config.profileApplications, [applied.application], "runtime discovery must not mutate applied snapshots");
    assert.equal(group.blockStartTime, "09:00", "the recurring class clocks remain unchanged");
  }
  await (await import("../src/services/classpilotLifecyclePushes.js")).classpilotLifecyclePushes.flush();
});

test("applied candidate discovery still requires current active, unskipped, instructional class eligibility", async () => {
  const data = await fixture();
  const saved = await save(data), input = request(data, saved);
  const preview = await scoped(data.schoolId, () => service.previewScheduleProfile(input));
  const applied = await scoped(data.schoolId, () => service.applyScheduleProfile({ ...input, previewToken: preview.previewToken }));
  const ready = () => scoped(data.schoolId, () => getClasspilotGroupsReadyAtEffectiveWindow({ schoolId: data.schoolId, scheduledDate: date, currentTimeHHMM: "11:15" }));
  const [candidate] = await ready();
  assert.equal(candidate?.id, data.classId);
  assert.ok(candidate);
  for (const [column, invalid, restored] of [["status", "archived", "active"], ["schedule_enabled", false, true], ["schedule_skipped_date", date, null]] as const) {
    await pool.query(`UPDATE groups SET ${column}=$1 WHERE id=$2`, [invalid, data.classId]);
    assert.deepEqual(await ready(), [], column);
    await pool.query(`UPDATE groups SET ${column}=$1 WHERE id=$2`, [restored, data.classId]);
  }
  for (const rule of [
    { ...defaultClassScheduleRule(), weekdays: [(dateWeekday(date) + 1) % 7] },
    { ...defaultClassScheduleRule(), startsOn: datePlusDays(date, 1) },
    { ...defaultClassScheduleRule(), endsOn: datePlusDays(date, -1) },
    { ...defaultClassScheduleRule(), cycleDay: "B" },
  ]) {
    await pool.query("UPDATE groups SET schedule_rule=$1::jsonb WHERE id=$2", [JSON.stringify(rule), data.classId]);
    assert.deepEqual(await ready(), [], "profile windows cannot bypass meeting rules");
  }
  await pool.query("UPDATE groups SET schedule_rule=$1::jsonb WHERE id=$2", [JSON.stringify(defaultClassScheduleRule()), data.classId]);
  await pool.query("UPDATE settings SET instructional_calendar=$1::jsonb WHERE school_id=$2", [JSON.stringify({ [date.slice(0, 7)]: { nonInstructionalDates: [date] } }), data.schoolId]);
  assert.deepEqual(await ready(), [], "profile windows cannot open a closed school date");
  await pool.query("UPDATE settings SET instructional_calendar='{}'::jsonb WHERE school_id=$1", [data.schoolId]);
  await scoped(data.schoolId, () => service.cancelScheduleProfileApplication({ schoolId: data.schoolId, actorId: data.adminId, revision: applied.revision, applicationId: applied.application.id }));
  assert.deepEqual(await ready(), [], "a cancelled time override is no longer a candidate");
  const stale = await scoped(data.schoolId, () => processScheduledClassAutoStart({ group: candidate, scheduledDate: date,
    now: localDateTimeUtc(date, "11:15", "America/New_York"), scheduledTeacherConnectedOverride: true }));
  assert.deepEqual(stale, { status: "skipped", reason: "outside_schedule_window" }, "a pre-cancellation candidate cannot authorize a stale start");
});

test("customize this use leaves its reusable profile unchanged and cancel restores future regular times", async () => {
  const data = await fixture(); const saved = await save(data); const input = { ...request(data, saved), definition: { ...data.definition, classRules: [{ classId: data.classId, action: "skip" as const }] } };
  const preview = await scoped(data.schoolId, () => service.previewScheduleProfile(input));
  assert.deepEqual(preview.blockers, []); assert.equal(preview.changes[0]?.after, null);
  const applied = await scoped(data.schoolId, () => service.applyScheduleProfile({ ...input, previewToken: preview.previewToken }));
  const ready = () => scoped(data.schoolId, () => getClasspilotGroupsReadyAtEffectiveWindow({ schoolId: data.schoolId, scheduledDate: date, currentTimeHHMM: "09:15" }));
  assert.equal((await ready()).some(group => group.id === data.classId), false, "an applied skip suppresses the regular occurrence");
  let context = await scoped(data.schoolId, () => scheduling.getSchoolSchedulingContext(data.schoolId));
  assert.equal(context.config.scheduleProfiles?.[0]?.definition.classRules[0]?.action, "time");
  const cancelled = await scoped(data.schoolId, () => service.cancelScheduleProfileApplication({ schoolId: data.schoolId, actorId: data.adminId, revision: applied.revision, applicationId: applied.application.id }));
  context = await scoped(data.schoolId, () => scheduling.getSchoolSchedulingContext(data.schoolId));
  assert.equal(context.config.profileApplications?.[0]?.status, "cancelled"); assert.equal(cancelled.revision, applied.revision + 1);
  assert.equal((await ready()).some(group => group.id === data.classId), true, "cancelling the application restores regular discovery");
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
