import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { CLASSPILOT_SCHEDULE_PROFILE_SUPERVISION_SQL } from "../src/db/classpilotScheduleProfileSupervisionMigration.js";
import { emptySchoolSchedulingConfig } from "../src/services/classpilotSchedulingRules.js";
import { localDateInTimeZone } from "../src/util/schoolTime.js";
import type { ScheduleProfileApplication } from "../src/services/classpilotScheduleProfileModel.js";
import { classpilotSchoolSchedules } from "../src/schema/classpilotScheduling.js";
import { classpilotSupervisionContexts, classpilotStudentControlStates } from "../src/schema/classpilot.js";

process.env.REDIS_URL = "";
const ids = { school: randomUUID(), otherSchool: randomUUID(), teacher: randomUUID(), otherTeacher: randomUUID(),
  group: randomUUID(), student: randomUUID(), secondStudent: randomUUID() };
const now = new Date();
// Keep real Coverage lease creation and the test clock in the same live hour,
// without depending on a developer's timezone or today's weekday.
const offset = 12 - now.getUTCHours();
const timezone = offset === 0 ? "UTC" : `Etc/GMT${offset > 0 ? "-" : "+"}${Math.abs(offset)}`;
const date = localDateInTimeZone(now, timezone);
let pool: import("pg").Pool;
let database: typeof import("../src/db.js").default;
let withTenant: typeof import("../src/middleware/tenantContext.js").runWithTenantContext;
let service: typeof import("../src/services/classpilotScheduleProfileSupervision.js");
let storage: typeof import("../src/services/storage.js");
let pushes: typeof import("../src/services/classpilotLifecyclePushes.js").classpilotLifecyclePushes;
const scoped = <T>(fn: () => Promise<T>) => withTenant({ schoolId: ids.school }, fn);
const scan = (at = now) => scoped(() => service.reconcileScheduledProfileSupervision(at, ids.school));
const statuses = (applicationId?: string) => scoped(() => service.getScheduledProfileSupervisionStatuses(ids.school, applicationId));
const contexts = () => scoped(() => database.select().from(classpilotSupervisionContexts).where(eq(classpilotSupervisionContexts.schoolId, ids.school)));
const controls = () => scoped(() => database.select().from(classpilotStudentControlStates).where(eq(classpilotStudentControlStates.schoolId, ids.school)));
const statement = (query: ReturnType<typeof sql>) => scoped(() => database.execute(query));
const pgError = (expectedCode: string) => (error: unknown): boolean => {
  if (!error || typeof error !== "object") return false;
  if ("code" in error && error.code === expectedCode) return true;
  return "cause" in error && pgError(expectedCode)(error.cause);
};

function application(startTime = "12:00", endTime = "13:00"): ScheduleProfileApplication {
  const block = { id: randomUUID(), name: "Testing room", coverageGroupId: ids.group, assignedStaffId: ids.teacher, startTime, endTime };
  const definition = { name: "Testing day", grades: [], classIds: [], classRules: [], testingBlocks: [block] };
  return { id: randomUUID(), profileId: randomUUID(), profileName: definition.name, profileRevision: 1,
    dates: [date], definition, classWindows: {}, testingWindows: [{ date, blockId: block.id, name: block.name,
      coverageGroupId: ids.group, assignedStaffId: ids.teacher, studentIds: [ids.student, ids.secondStudent].sort(), startTime, endTime }],
    status: "scheduled", createdBy: ids.teacher, createdAt: now.toISOString() };
}
async function save(applications: ScheduleProfileApplication[]) {
  const config = { ...emptySchoolSchedulingConfig(), dateOverrides: { [date]: { instructional: true, meetingWeekday: 1 } }, profileApplications: applications };
  await scoped(() => database.update(classpilotSchoolSchedules).set({ config }).where(eq(classpilotSchoolSchedules.schoolId, ids.school)));
}

before(async () => {
  assert.ok(["localhost", "127.0.0.1", "::1"].includes(new URL(process.env.DATABASE_URL || "").hostname), "Scheduled testing integration requires a local fixture database.");
  process.env.DATABASE_URL_PRIVILEGED = process.env.DATABASE_URL;
  ({ default: database, pool } = await import("../src/db.js"));
  ({ runWithTenantContext: withTenant } = await import("../src/middleware/tenantContext.js"));
  service = await import("../src/services/classpilotScheduleProfileSupervision.js");
  storage = await import("../src/services/storage.js");
  ({ classpilotLifecyclePushes: pushes } = await import("../src/services/classpilotLifecyclePushes.js"));
  await pool.query(CLASSPILOT_SCHEDULE_PROFILE_SUPERVISION_SQL);
  await pool.query(CLASSPILOT_SCHEDULE_PROFILE_SUPERVISION_SQL);
  const domain = `${ids.school}.example.edu`;
  await pool.query("INSERT INTO schools(id,name,domain,school_timezone) VALUES($1,'Profile testing',$3,$4),($2,'Other profile testing',$3,$4)", [ids.school, ids.otherSchool, domain, timezone]);
  for (const teacher of [ids.teacher, ids.otherTeacher]) {
    await pool.query("INSERT INTO users(id,email,first_name,last_name) VALUES($1,$2,'Testing','Staff')", [teacher, `${teacher}@${domain}`]);
    await pool.query("INSERT INTO school_memberships(school_id,user_id,role,status) VALUES($1,$2,'teacher','active')", [ids.school, teacher]);
  }
  await pool.query("INSERT INTO product_licenses(school_id,product,status) VALUES($1,'CLASSPILOT','active')", [ids.school]);
  await statement(sql`INSERT INTO settings(school_id,school_name,ws_shared_key,enable_tracking_hours,after_hours_mode) VALUES(${ids.school},'Profile testing','test-only',false,'off')`);
  await statement(sql`INSERT INTO students(id,school_id,first_name,last_name,status) VALUES(${ids.student},${ids.school},'First','Student','active'),(${ids.secondStudent},${ids.school},'Second','Student','active')`);
  await statement(sql`INSERT INTO classpilot_coverage_scope_groups(id,school_id,name,created_by) VALUES(${ids.group},${ids.school},'Testing room',${ids.teacher})`);
  await statement(sql`INSERT INTO classpilot_coverage_assignments(school_id,staff_id,scope_type,scope_value,permissions,created_by) VALUES(${ids.school},${ids.teacher},'coverage_group',${ids.group},'{"claim":true}'::jsonb,${ids.teacher})`);
  await scoped(() => database.insert(classpilotSchoolSchedules).values({ schoolId: ids.school, revision: 7, config: emptySchoolSchedulingConfig() }));
});

beforeEach(async () => {
  await pushes.flush();
  for (const context of await contexts()) if (context.status === "active") await scoped(() => storage.releaseSupervisionStudents({ schoolId: ids.school, contextId: context.id }));
  await statement(sql`DELETE FROM classpilot_student_control_states WHERE school_id=${ids.school}`);
  await statement(sql`DELETE FROM classpilot_supervision_students WHERE school_id=${ids.school}`);
  await statement(sql`DELETE FROM classpilot_supervision_contexts WHERE school_id=${ids.school}`);
  await statement(sql`UPDATE classpilot_school_schedules SET profile_activation_outcomes='{}'::jsonb WHERE school_id=${ids.school}`);
  await statement(sql`UPDATE classpilot_coverage_scope_groups SET active=true WHERE id=${ids.group}`);
  await statement(sql`UPDATE classpilot_coverage_assignments SET active=true WHERE school_id=${ids.school}`);
  await statement(sql`UPDATE students SET status='active' WHERE school_id=${ids.school}`);
  await statement(sql`UPDATE settings SET enable_tracking_hours=false,after_hours_mode='off',instructional_calendar='{}'::jsonb WHERE school_id=${ids.school}`);
  await pool.query("UPDATE school_memberships SET status='active' WHERE school_id=$1", [ids.school]);
  await pool.query("UPDATE product_licenses SET status='active' WHERE school_id=$1", [ids.school]);
  await scoped(() => storage.replaceCoverageScopeGroupMembers({ schoolId: ids.school, groupId: ids.group, studentIds: [ids.student, ids.secondStudent] }));
  await save([]);
});

after(async () => {
  if (!pool) return;
  await pushes?.flush();
  await withTenant({ isSuper: true }, async () => {
    for (const table of ["classpilot_student_control_states", "classpilot_supervision_students", "classpilot_supervision_contexts", "classpilot_coverage_scope_group_members", "classpilot_coverage_assignments", "classpilot_coverage_scope_groups", "classpilot_school_schedules", "students", "settings"])
      await database.execute(sql`DELETE FROM ${sql.identifier(table)} WHERE school_id=${ids.school}`);
  });
  await pool.query("DELETE FROM product_licenses WHERE school_id=$1", [ids.school]);
  await pool.query("DELETE FROM school_memberships WHERE school_id=$1", [ids.school]);
  await pool.query("DELETE FROM schools WHERE id IN($1,$2)", [ids.school, ids.otherSchool]);
  await pool.query("DELETE FROM users WHERE id IN($1,$2)", [ids.teacher, ids.otherTeacher]);
  await (await import("../src/services/errorMonitor.js")).default.disposeAndWait();
  const { sessionPool } = await import("../src/db.js");
  const { schedulerPool, schedulerLockPool } = await import("../src/services/schedulerDb.js");
  await Promise.all([pool.end(), sessionPool.end(), schedulerPool.end(), schedulerLockPool.end()]);
});

test("concurrent workers activate exactly once, freeze targets, and keep the scheduling revision unchanged", async () => {
  const app = application(); await save([app]);
  const results = await Promise.all([scan(), scan()]);
  assert.equal(results.reduce((sum, result) => sum + result.started, 0), 1);
  const [context] = await contexts(); assert.ok(context); assert.equal((await contexts()).length, 1);
  assert.equal(context.scheduleProfileApplicationId, app.id);
  const states = await controls(); assert.equal(states.length, 2);
  assert.ok(states.every((state) => state.supervisionContextId === context.id && state.revision > 0));
  assert.equal((await statuses())[0]?.status, "active");
  const [schedule] = await scoped(() => database.select().from(classpilotSchoolSchedules).where(eq(classpilotSchoolSchedules.schoolId, ids.school)));
  assert.equal(schedule?.revision, 7); assert.equal(Object.keys(schedule!.profileActivationOutcomes).length, 1);
  assert.deepEqual(await withTenant({ schoolId: ids.otherSchool }, () => service.getScheduledProfileSupervisionStatuses(ids.otherSchool)), []);
  await assert.rejects(scoped(() => database.insert(classpilotSupervisionContexts).values({ ...context, id: randomUUID() })), pgError("23505"));
});

test("early and partial release never reclaim students or reopen an ended testing block", async () => {
  await save([application()]); await scan();
  const [context] = await contexts(); assert.ok(context);
  await scoped(() => storage.releaseSupervisionStudents({ schoolId: ids.school, contextId: context.id, studentIds: [ids.student] }));
  await scan();
  assert.equal((await controls()).find((row) => row.studentId === ids.student)?.supervisionContextId, null);
  assert.equal((await statuses())[0]?.status, "active");
  await scoped(() => storage.releaseSupervisionStudents({ schoolId: ids.school, contextId: context.id }));
  await scan();
  assert.equal((await contexts()).length, 1); assert.equal((await statuses())[0]?.status, "ended");
  assert.ok((await controls()).every((row) => row.supervisionContextId === null));
});

test("expiry cannot restart a testing block and retains its durable receipt", async () => {
  await save([application()]); await scan();
  const afterWindow = new Date(now.getTime() + 2 * 60 * 60_000);
  await scoped(() => storage.releaseExpiredClasspilotSupervisionContexts({ schoolId: ids.school, now: afterWindow }));
  await scan(afterWindow);
  assert.equal((await contexts()).length, 1); assert.equal((await statuses())[0]?.status, "ended");
});

test("changed exact roster and staff pairing fail visibly, without a later automatic retry", async () => {
  const app = application(); await save([app]);
  await scoped(() => storage.replaceCoverageScopeGroupMembers({ schoolId: ids.school, groupId: ids.group, studentIds: [ids.student] }));
  await scan(); assert.equal((await statuses())[0]?.code, "COVERAGE_ROSTER_CHANGED");
  await scoped(() => storage.replaceCoverageScopeGroupMembers({ schoolId: ids.school, groupId: ids.group, studentIds: [ids.student, ids.secondStudent] }));
  await scan(); assert.equal((await contexts()).length, 0);
  const reviewed = application(); await save([app, reviewed]);
  await statement(sql`UPDATE classpilot_coverage_assignments SET active=false WHERE school_id=${ids.school}`);
  await scan(); assert.equal((await statuses(reviewed.id))[0]?.code, "STAFF_GROUP_PAIRING_CHANGED");
});

test("inactive staff, inactive students and a foreign school group cannot receive testing authority", async () => {
  const app = application(); await save([app]);
  await pool.query("UPDATE school_memberships SET status='inactive' WHERE school_id=$1 AND user_id=$2", [ids.school, ids.teacher]);
  await scan(); assert.equal((await statuses(app.id))[0]?.code, "STAFF_MEMBERSHIP_UNAVAILABLE");
  await pool.query("UPDATE school_memberships SET status='active' WHERE school_id=$1", [ids.school]);
  const next = application(); await save([app, next]);
  await statement(sql`UPDATE students SET status='inactive' WHERE id=${ids.student}`);
  await scan(); assert.equal((await statuses(next.id))[0]?.code, "STUDENT_SCOPE_CHANGED");
  await statement(sql`UPDATE students SET status='active' WHERE id=${ids.student}`);
  const foreign = application(); const missingGroup = randomUUID();
  foreign.definition.testingBlocks[0]!.coverageGroupId = missingGroup; foreign.testingWindows[0]!.coverageGroupId = missingGroup;
  await withTenant({ schoolId: ids.otherSchool }, () => database.execute(sql`INSERT INTO classpilot_coverage_scope_groups(id,school_id,name,created_by) VALUES(${missingGroup},${ids.otherSchool},'Other school room',${ids.teacher})`));
  try {
    await save([foreign]); await scan(); assert.equal((await statuses())[0]?.code, "COVERAGE_GROUP_UNAVAILABLE");
  } finally {
    await withTenant({ schoolId: ids.otherSchool }, () => database.execute(sql`DELETE FROM classpilot_coverage_scope_groups WHERE id=${missingGroup}`));
  }
  assert.equal((await contexts()).length, 0);
});

test("entitlement and instructional/full-monitoring eligibility are rechecked at activation", async () => {
  const app = application(); await save([app]);
  await pool.query("UPDATE product_licenses SET status='suspended' WHERE school_id=$1", [ids.school]);
  await scan(); assert.equal((await statuses())[0]?.code, "CLASSPILOT_NOT_ENTITLED");
  await pool.query("UPDATE product_licenses SET status='active' WHERE school_id=$1", [ids.school]);
  const closed = application(); await save([closed]);
  await statement(sql`UPDATE classpilot_school_schedules SET config=jsonb_set(config,'{dateOverrides}',${JSON.stringify({ [date]: { instructional: false } })}::jsonb) WHERE school_id=${ids.school}`);
  await scan(); assert.equal((await statuses())[0]?.code, "NON_INSTRUCTIONAL_DATE");
  const off = application(); await save([off]);
  await statement(sql`UPDATE settings SET enable_tracking_hours=true,tracking_days=ARRAY['Monday'],tracking_start_time='01:00',tracking_end_time='02:00',after_hours_mode='off' WHERE school_id=${ids.school}`);
  await scan(); assert.equal((await statuses())[0]?.code, "MONITORING_NOT_FULL");
  assert.equal((await contexts()).length, 0);
});

test("a newly opened class with pupils outside the testing snapshot blocks its assigned proctor", async () => {
  const app = application(); app.testingWindows[0]!.studentIds = [ids.student];
  await scoped(() => storage.replaceCoverageScopeGroupMembers({ schoolId: ids.school, groupId: ids.group, studentIds: [ids.student] }));
  await save([app]);
  const group = randomUUID(), session = randomUUID();
  await statement(sql`INSERT INTO groups(id,school_id,teacher_id,name,group_type,status) VALUES(${group},${ids.school},${ids.teacher},'Other pupils','admin_class','active')`);
  try {
    await statement(sql`INSERT INTO teaching_sessions(id,school_id,group_id,teacher_id,start_time,end_time,roster_snapshot_completed_at,class_name_snapshot) VALUES(${session},${ids.school},${group},${ids.teacher},${new Date(now.getTime() - 60_000).toISOString()}::timestamptz,${new Date(now.getTime() + 30 * 60_000).toISOString()}::timestamptz,now(),'Other pupils')`);
    await statement(sql`INSERT INTO classpilot_session_students(school_id,teaching_session_id,group_id,student_id) VALUES(${ids.school},${session},${group},${ids.secondStudent})`);
    await statement(sql`INSERT INTO classpilot_session_staff(school_id,teaching_session_id,staff_id,role) VALUES(${ids.school},${session},${ids.teacher},'primary')`);
    await scan();
    assert.equal((await statuses())[0]?.code, "SCHEDULE_PROFILE_PROCTOR_CLASS_CONFLICT");
    assert.equal((await contexts()).length, 0);
  } finally {
    await statement(sql`DELETE FROM classpilot_session_staff WHERE teaching_session_id=${session}`);
    await statement(sql`DELETE FROM classpilot_session_students WHERE teaching_session_id=${session}`);
    await statement(sql`DELETE FROM teaching_sessions WHERE id=${session}`);
    await statement(sql`DELETE FROM groups WHERE id=${group}`);
  }
});

test("monitoring must cover the whole testing window even when collection is currently full", async () => {
  await save([application("12:00", "14:00")]);
  await statement(sql`UPDATE settings SET enable_tracking_hours=true,tracking_days=ARRAY['Monday'],tracking_start_time='12:00',tracking_end_time='13:00',after_hours_mode='off' WHERE school_id=${ids.school}`);
  await scan();
  assert.equal((await statuses())[0]?.code, "SCHEDULE_PROFILE_MONITORING_NOT_FULL");
  assert.equal((await contexts()).length, 0);
});

test("setup-only grants cannot supervise; legacy observe grants retain existing Coverage claim semantics", async () => {
  const setupOnly = application(); await save([setupOnly]);
  await statement(sql`UPDATE classpilot_coverage_assignments SET permissions='{"setup":true}'::jsonb WHERE school_id=${ids.school}`);
  await scan(); assert.equal((await statuses())[0]?.code, "STAFF_GROUP_PAIRING_CHANGED");
  const reviewed = application(); await save([reviewed]);
  await statement(sql`UPDATE classpilot_coverage_assignments SET permissions='{"observe":true}'::jsonb WHERE school_id=${ids.school}`);
  await scan(); assert.equal((await statuses())[0]?.status, "active");
});

test("future windows remain pending, missed windows never claim students, and pre-start cancellation is terminal", async () => {
  const future = application("14:00", "15:00"), missed = application("10:00", "11:00"), cancelled = application();
  cancelled.status = "cancelled"; await save([future, missed, cancelled]);
  await scan();
  assert.equal((await statuses(future.id))[0]?.status, "pending");
  assert.equal((await statuses(missed.id))[0]?.status, "missed");
  assert.equal((await statuses(cancelled.id))[0]?.status, "cancelled");
  assert.equal((await contexts()).length, 0);
});

test("a stale worker tick cannot grant authority after validation has crossed the window deadline", async () => {
  await save([application("10:00", "11:00")]);
  await scan(new Date(now.getTime() - 2 * 60 * 60_000));
  assert.equal((await statuses())[0]?.status, "missed");
  assert.equal((await statuses())[0]?.code, "WINDOW_ELAPSED");
  assert.equal((await contexts()).length, 0);
});

test("a committed cancellation exposes releasing until safe control release completes, and cannot restart", async () => {
  const app = application(); await save([app]); await scan();
  app.status = "cancelled"; await save([app]);
  assert.equal((await statuses())[0]?.status, "releasing");
  await scoped(() => service.cancelProfileSupervision(ids.school, app.id));
  assert.equal((await statuses())[0]?.status, "cancelled");
  assert.ok((await controls()).every((state) => state.supervisionContextId === null && state.revision > 1));
  await scan(); assert.equal((await contexts()).length, 1);
});

test("release does not overwrite a newer control owner after a student handoff", async () => {
  const app = application(); await save([app]); await scan();
  const first = (await contexts())[0]!;
  const newer = await scoped(() => storage.createSupervisionContextWithStudents({ context: { schoolId: ids.school,
    contextType: "supervision_group", name: "New owner", assignedStaffId: ids.otherTeacher, createdBy: ids.otherTeacher,
    startsAt: now, endsAt: new Date(now.getTime() + 60 * 60_000) }, studentIds: [ids.student], assignedBy: ids.otherTeacher }));
  const beforeState = (await controls()).find((state) => state.studentId === ids.student)!;
  await scoped(() => storage.releaseSupervisionStudents({ schoolId: ids.school, contextId: first.id }));
  const afterState = (await controls()).find((state) => state.studentId === ids.student)!;
  assert.equal(afterState.supervisionContextId, newer.id); assert.equal(afterState.revision, beforeState.revision);
  await scan(); assert.equal((await contexts()).length, 2);
});

test("the additive metadata migration rejects partial identity and invalid outcome JSON", async () => {
  await assert.rejects(statement(sql`INSERT INTO classpilot_supervision_contexts(school_id,context_type,name,assigned_staff_id,created_by,ends_at,schedule_profile_application_id) VALUES(${ids.school},'supervision_group','Invalid',${ids.teacher},${ids.teacher},now()+interval '1 hour','partial')`), pgError("23514"));
  await assert.rejects(statement(sql`UPDATE classpilot_school_schedules SET profile_activation_outcomes='[]'::jsonb WHERE school_id=${ids.school}`), pgError("23514"));
  assert.equal((await contexts()).length, 0);
});
