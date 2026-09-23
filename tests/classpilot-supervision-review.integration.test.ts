import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { pool, sessionPool } from "../src/db.js";
import { runWithTenantContext } from "../src/middleware/tenantContext.js";
import { commitSupervisionReview, previewSupervision, supervisionSessionOptions } from "../src/services/classpilotSupervisionReview.js";
import { assignAdHocSupervisionStudents, releaseSupervisionStudents } from "../src/services/storage.js";

const schools: string[] = [], staff: string[] = [], pupils: string[] = [];
const scoped = <T>(schoolId: string, operation: () => Promise<T>) => runWithTenantContext({ schoolId }, operation);
before(() => assert.ok(["localhost", "127.0.0.1", "::1"].includes(new URL(process.env.DATABASE_URL || "").hostname)));
after(async () => {
  try {
    for (const table of ["classpilot_student_control_states", "classpilot_supervision_students", "classpilot_supervision_contexts", "classpilot_session_staff", "classpilot_session_students", "teaching_sessions", "groups", "classpilot_coverage_scope_group_members", "classpilot_coverage_assignments", "classpilot_coverage_scope_groups", "audit_logs", "devices", "settings", "school_memberships", "product_licenses"]) {
      await pool.query(`DELETE FROM ${table} WHERE school_id=ANY($1::text[])`, [schools]);
    }
    await pool.query("DELETE FROM student_sessions WHERE student_id=ANY($1::text[])", [pupils]);
    await pool.query("DELETE FROM students WHERE school_id=ANY($1::text[])", [schools]);
    await pool.query("DELETE FROM users WHERE id=ANY($1::text[])", [staff]);
    await pool.query("DELETE FROM schools WHERE id=ANY($1::text[])", [schools]);
  } finally {
    const { schedulerPool, schedulerLockPool } = await import("../src/services/schedulerDb.js");
    await Promise.all([pool.end(), sessionPool.end(), schedulerPool.end(), schedulerLockPool.end()]);
  }
});
async function fixture() {
  const schoolId = randomUUID(), adminId = randomUUID(), teacherId = randomUUID(), receiverId = randomUUID(), groupId = randomUUID();
  const studentIds = [randomUUID(), randomUUID(), randomUUID()];
  schools.push(schoolId); staff.push(adminId, teacherId, receiverId); pupils.push(...studentIds);
  await pool.query("INSERT INTO schools(id,name,status,is_active,plan_status) VALUES($1,'Supervision review','active',true,'active')", [schoolId]);
  await pool.query("INSERT INTO product_licenses(school_id,product,status) VALUES($1,'CLASSPILOT','active')", [schoolId]);
  for (const [id, role] of [[adminId, "admin"], [teacherId, "teacher"], [receiverId, "teacher"]]) {
    await pool.query("INSERT INTO users(id,email,first_name,last_name,display_name) VALUES($1,$2,'Review','Teacher','Review Teacher')", [id, `${id}@example.test`]);
    await pool.query("INSERT INTO school_memberships(school_id,user_id,role,status) VALUES($1,$2,$3,'active')", [schoolId, id, role]);
  }
  for (const studentId of studentIds) {
    await pool.query("INSERT INTO students(id,school_id,first_name,last_name,status) VALUES($1,$2,'Review','Student','active')", [studentId, schoolId]);
    await pool.query("INSERT INTO devices(device_id,school_id,class_id) VALUES($1,$2,'default')", [studentId, schoolId]);
    await pool.query("INSERT INTO student_sessions(student_id,device_id,auth_kind) VALUES($1,$1,'managed_profile')", [studentId]);
  }
  await pool.query("INSERT INTO classpilot_coverage_scope_groups(id,school_id,name,created_by) VALUES($1,$2,'Saved MAP Testing',$3)", [groupId, schoolId, adminId]);
  for (const studentId of studentIds) await pool.query("INSERT INTO classpilot_coverage_scope_group_members(school_id,coverage_group_id,student_id) VALUES($1,$2,$3)", [schoolId, groupId, studentId]);
  for (const staffId of [teacherId, receiverId]) await pool.query("INSERT INTO classpilot_coverage_assignments(school_id,staff_id,scope_type,scope_value,permissions,created_by) VALUES($1,$2,'coverage_group',$3,'{\"claim\":true}',$4)", [schoolId, staffId, groupId, adminId]);
  return { schoolId, adminId, teacherId, receiverId, groupId, studentIds };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
const startInput = (data: Fixture, overrides: Record<string, unknown> = {}) => ({ action: "start", studentIds: [data.studentIds[0]], supervisionGroupId: data.groupId,
  assignedStaffId: data.teacherId, contextType: "other", endsAt: new Date(Date.now() + 60 * 60_000).toISOString(), ...overrides });
const preview = (data: Fixture, input: unknown, actorId = data.adminId) => scoped(data.schoolId, () => previewSupervision({ schoolId: data.schoolId, actorId, input }));
const commit = (data: Fixture, review: Awaited<ReturnType<typeof preview>>, actorId = data.adminId) => scoped(data.schoolId, () => commitSupervisionReview({ schoolId: data.schoolId, actorId, input: review.request, reviewToken: review.reviewToken, action: review.request.action }));

test("saved group selection starts exactly reviewed students with explicit purpose and no implicit testing", async () => {
  const data = await fixture();
  const options = await scoped(data.schoolId, () => supervisionSessionOptions({ schoolId: data.schoolId, actorId: data.teacherId, supervisionGroupId: data.groupId }));
  assert.equal(options.students.length, 3); assert.deepEqual(options.staff.map(row => row.id), [data.teacherId]);
  const review = await preview(data, startInput(data), data.teacherId);
  assert.equal(review.destination.purpose, "supervision"); assert.equal(review.students.length, 1);
  const started = await commit(data, review, data.teacherId);
  assert.equal(started.context.purpose, "supervision"); assert.equal(started.context.activeStudentCount, 1);
  assert.deepEqual(started.assignments.map(row => row.studentId), [data.studentIds[0]]);
  assert.equal((await pool.query("SELECT count(*) FROM classpilot_coverage_scope_group_members WHERE coverage_group_id=$1", [data.groupId])).rows[0].count, "3");
  await assert.rejects(commit(data, review, data.teacherId), { code: "SUPERVISION_REVIEW_STALE", status: 409 });
});

test("explicit send preserves destination deadline and same-destination sends preserve assignment identity", async () => {
  const data = await fixture();
  const started = await commit(data, await preview(data, startInput(data)));
  const review = await preview(data, { action: "send", destinationContextId: started.context.id, studentIds: data.studentIds.slice(0, 2) });
  assert.equal(review.students.find(row => row.studentId === data.studentIds[0])?.status, "already_assigned");
  const sent = await commit(data, review);
  assert.equal(sent.context.endsAt.getTime(), started.context.endsAt.getTime());
  assert.equal(sent.assignments.find(row => row.studentId === data.studentIds[0])?.id, started.assignments[0]?.id);
  const same = await preview(data, { action: "send", destinationContextId: started.context.id, studentIds: data.studentIds.slice(0, 2) });
  const repeated = await commit(data, same);
  assert.deepEqual(repeated.outcomes.map(row => row.status), ["already_assigned", "already_assigned"]);
  assert.deepEqual(repeated.changedStudentIds, []);
  assert.deepEqual(repeated.assignments.map(row => row.id).sort(), sent.assignments.map(row => row.id).sort());
});

test("preview token is bound to actor, exact selection and request; heartbeat refresh alone does not invalidate", async () => {
  const data = await fixture(), review = await preview(data, startInput(data));
  await assert.rejects(commit(data, { ...review, request: { ...review.request, studentIds: data.studentIds.slice(0, 2) } }), { code: "SUPERVISION_REVIEW_STALE" });
  await assert.rejects(commit(data, review, data.teacherId), { code: "SUPERVISION_REVIEW_STALE" });
  await assert.rejects(commit(data, { ...review, reviewToken: review.reviewToken + "x" }), { code: "SUPERVISION_REVIEW_STALE" });
  await pool.query("UPDATE student_sessions SET last_seen_at=now() WHERE student_id=ANY($1::text[])", [data.studentIds]);
  assert.equal((await commit(data, review)).assignments.length, 1);
});

test("changed permission, membership, source ownership and destination revisions return 409 without mutation", async () => {
  for (const change of ["permission", "membership", "ownership", "revision"] as const) {
    const data = await fixture();
    let input = startInput(data);
    if (change === "revision") {
      const started = await commit(data, await preview(data, input));
      input = startInput(data, { action: "send", destinationContextId: started.context.id, studentIds: [data.studentIds[1]] });
    }
    const actorId = change === "revision" ? data.adminId : data.teacherId;
    const review = await preview(data, input, actorId);
    if (change === "permission") await pool.query("UPDATE classpilot_coverage_assignments SET active=false WHERE school_id=$1 AND staff_id=$2", [data.schoolId, data.teacherId]);
    if (change === "membership") await pool.query("DELETE FROM classpilot_coverage_scope_group_members WHERE coverage_group_id=$1 AND student_id=$2", [data.groupId, data.studentIds[0]]);
    if (change === "ownership") await scoped(data.schoolId, () => assignAdHocSupervisionStudents({ schoolId: data.schoolId, actorId: data.adminId, assignedStaffId: data.receiverId, studentIds: [data.studentIds[0]!], source: "admin_assign", endsAt: new Date(Date.now() + 30 * 60_000) }));
    if (change === "revision") await pool.query("UPDATE classpilot_supervision_contexts SET assigned_staff_id=$2 WHERE id=$1", [review.destination.contextId, data.receiverId]);
    await assert.rejects(commit(data, review, actorId), { code: "SUPERVISION_REVIEW_STALE", status: 409 }, change);
    const active = await pool.query("SELECT context_id FROM classpilot_supervision_students WHERE school_id=$1 AND student_id=$2 AND released_at IS NULL", [data.schoolId, input.studentIds[0]]);
    if (change !== "ownership") assert.equal(active.rowCount, 0, change);
  }
});

test("unavailable selections require explicit removal and a new preview", async () => {
  const data = await fixture();
  await pool.query("UPDATE student_sessions SET last_seen_at=now()-interval '10 minutes' WHERE student_id=$1", [data.studentIds[1]]);
  const review = await preview(data, startInput(data, { studentIds: data.studentIds.slice(0, 2) }));
  assert.equal(review.students.filter(row => row.eligible).length, 1);
  assert.equal(review.students.find(row => row.studentId === data.studentIds[1])?.reason, "Student is not currently connected.");
  await assert.rejects(commit(data, review), { code: "SUPERVISION_STUDENTS_UNAVAILABLE" });
  assert.equal((await commit(data, await preview(data, startInput(data)))).assignments.length, 1);
});

test("teachers send only from frozen class authority and cannot reclaim a student moved since review", async () => {
  const data = await fixture(), classId = randomUUID(), sessionId = randomUUID();
  await pool.query("INSERT INTO groups(id,school_id,teacher_id,name) VALUES($1,$2,$3,'Current class')", [classId, data.schoolId, data.teacherId]);
  await pool.query("INSERT INTO teaching_sessions(id,school_id,group_id,teacher_id,roster_snapshot_completed_at) VALUES($1,$2,$3,$4,now())", [sessionId, data.schoolId, classId, data.teacherId]);
  await pool.query("INSERT INTO classpilot_session_staff(school_id,teaching_session_id,staff_id,role) VALUES($1,$2,$3,'primary')", [data.schoolId, sessionId, data.teacherId]);
  for (const pupil of data.studentIds) await pool.query("INSERT INTO classpilot_session_students(school_id,teaching_session_id,group_id,student_id) VALUES($1,$2,$3,$4)", [data.schoolId, sessionId, classId, pupil]);
  const input = startInput(data, { action: "send", assignedStaffId: data.receiverId, studentIds: [data.studentIds[0]] });
  const review = await preview(data, input, data.teacherId);
  assert.equal(review.students[0]?.eligible, true); assert.equal(review.students[0]?.currentOwner?.id, sessionId);
  const first = await commit(data, review, data.teacherId);
  const repeat = await preview(data, { action: "send", destinationContextId: first.context.id, studentIds: [data.studentIds[0]] }, data.teacherId);
  assert.equal((await commit(data, repeat, data.teacherId)).outcomes[0]?.status, "already_assigned");
  const second = await preview(data, { ...input, studentIds: [data.studentIds[1]] }, data.teacherId);
  await scoped(data.schoolId, () => assignAdHocSupervisionStudents({ schoolId: data.schoolId, actorId: data.adminId, assignedStaffId: data.adminId,
    studentIds: [data.studentIds[1]!], source: "admin_assign", endsAt: new Date(Date.now() + 30 * 60_000) }));
  await assert.rejects(commit(data, second, data.teacherId), { code: "SUPERVISION_REVIEW_STALE" });
  const unauthorized = await preview(data, { ...input, studentIds: [data.studentIds[2]] }, data.receiverId);
  assert.equal(unauthorized.students[0]?.eligible, false); assert.equal(unauthorized.students[0]?.name, "Unavailable student");
});

test("future, expired and scheduled destinations cannot be borrowed by Send or end-time changes", async () => {
  for (const change of ["future", "expired", "scheduled"] as const) {
    const data = await fixture(), started = await commit(data, await preview(data, startInput(data)));
    if (change === "future") await pool.query("UPDATE classpilot_supervision_contexts SET starts_at=now()+interval '10 minutes' WHERE id=$1", [started.context.id]);
    if (change === "expired") await pool.query("UPDATE classpilot_supervision_contexts SET ends_at=now()-interval '1 minute' WHERE id=$1", [started.context.id]);
    if (change === "scheduled") await pool.query("UPDATE classpilot_supervision_contexts SET schedule_profile_application_id='application',schedule_profile_date='2026-09-22',schedule_profile_block_id='testing' WHERE id=$1", [started.context.id]);
    for (const action of ["send", "end_time"]) await assert.rejects(preview(data, { action, destinationContextId: started.context.id,
      studentIds: [data.studentIds[1]], endsAt: new Date(Date.now() + 90 * 60_000).toISOString() }), { code: "SUPERVISION_DESTINATION_UNAVAILABLE" });
  }
});

test("end-time review includes everyone affected; roster changes invalidate it", async () => {
  const data = await fixture(), started = await commit(data, await preview(data, startInput(data)));
  const input = { action: "end_time", destinationContextId: started.context.id, endsAt: new Date(Date.now() + 90 * 60_000).toISOString() };
  const review = await preview(data, input, data.teacherId);
  assert.deepEqual(review.request.studentIds, [data.studentIds[0]]);
  await commit(data, await preview(data, { action: "send", destinationContextId: started.context.id, studentIds: [data.studentIds[1]] }));
  await assert.rejects(commit(data, review, data.teacherId), { code: "SUPERVISION_REVIEW_STALE" });
  const updated = await commit(data, await preview(data, input, data.teacherId), data.teacherId);
  assert.equal(updated.context.endsAt.toISOString(), input.endsAt); assert.equal(updated.outcomes.length, 2);
});

test("ordinary claims never extend the existing context or change saved group membership", async () => {
  const data = await fixture(), endsAt = new Date(Date.now() + 30 * 60_000);
  const claim = (studentId: string, deadline: Date) => scoped(data.schoolId, () => assignAdHocSupervisionStudents({ schoolId: data.schoolId,
    actorId: data.teacherId, assignedStaffId: data.teacherId, studentIds: [studentId], source: "staff_claim", requireAvailable: true, endsAt: deadline }));
  const first = await claim(data.studentIds[0]!, endsAt), second = await claim(data.studentIds[1]!, new Date(Date.now() + 4 * 60 * 60_000));
  assert.equal(second.context.id, first.context.id); assert.equal(second.context.endsAt.getTime(), first.context.endsAt.getTime());
  assert.equal(second.context.name, "Claimed students"); assert.equal(second.context.coverageGroupId, null);
  await scoped(data.schoolId, () => releaseSupervisionStudents({ schoolId: data.schoolId, contextId: first.context.id }));
  assert.equal((await pool.query("SELECT count(*) FROM classpilot_coverage_scope_group_members WHERE coverage_group_id=$1", [data.groupId])).rows[0].count, "3");
});

test("concurrent reviewed starts have one winner; tenant and scope reads do not expose other students", async () => {
  const data = await fixture(), other = await fixture();
  const first = await preview(data, startInput(data)), second = await preview(data, startInput(data, { assignedStaffId: data.receiverId }));
  const results = await Promise.allSettled([commit(data, first), commit(data, second)]);
  assert.equal(results.filter(row => row.status === "fulfilled").length, 1);
  await assert.rejects(preview(data, startInput(data, { studentIds: [other.studentIds[0]] })), { code: "NOT_FOUND" });
  await pool.query("UPDATE classpilot_coverage_assignments SET active=false WHERE school_id=$1 AND staff_id=$2", [data.schoolId, data.teacherId]);
  const denied = await preview(data, startInput(data, { studentIds: [data.studentIds[2]] }), data.teacherId);
  assert.equal(denied.students[0]?.name, "Unavailable student"); assert.equal(denied.students[0]?.currentOwner, null);
  assert.equal(denied.students[0]?.eligible, false);
  const publicDenied = denied.students[0];
  assert.equal(publicDenied?.reason, "Student is outside your authorized classroom or supervision scope.");
  await pool.query("UPDATE students SET status='inactive' WHERE id=$1", [data.studentIds[2]]);
  assert.deepEqual((await preview(data, startInput(data, { studentIds: [data.studentIds[2]] }), data.teacherId)).students[0], publicDenied,
    "an unauthorized viewer cannot discover inactive status through the reason");
  await pool.query("UPDATE students SET status='active' WHERE id=$1", [data.studentIds[2]]);
  await pool.query("DELETE FROM classpilot_coverage_scope_group_members WHERE coverage_group_id=$1 AND student_id=$2", [data.groupId, data.studentIds[2]]);
  assert.deepEqual((await preview(data, startInput(data, { studentIds: [data.studentIds[2]] }), data.teacherId)).students[0], publicDenied,
    "an unauthorized viewer cannot discover saved membership through the reason");
});
