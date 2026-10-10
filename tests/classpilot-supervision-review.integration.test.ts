import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { pool, sessionPool } from "../src/db.js";
import { runWithTenantContext } from "../src/middleware/tenantContext.js";
import { commitSupervisionReview, previewSupervision, releaseTemporaryRoomStudents, returnSupervisionStudentsToOwnClass, supervisionSessionOptions } from "../src/services/classpilotSupervisionReview.js";
import { assignAdHocSupervisionStudents, createSupervisionContextWithStudents, releaseSupervisionStudents } from "../src/services/storage.js";
import { getClasspilotDashboardActivity } from "../src/services/classpilotDashboardActivity.js";
import { signUserToken } from "../src/services/jwt.js";

const schools: string[] = [], staff: string[] = [], pupils: string[] = [];
const scoped = <T>(schoolId: string, operation: () => Promise<T>) => runWithTenantContext({ schoolId }, operation);
let server: Server | undefined, baseUrl: string;
before(async () => {
  assert.ok(["localhost", "127.0.0.1", "::1"].includes(new URL(process.env.DATABASE_URL || "").hostname));
  const { default: coverageRouter } = await import("../src/routes/classpilot/coverage.js");
  const app = express();
  app.use(express.json());
  app.use("/api", coverageRouter);
  server = createServer(app);
  await new Promise<void>(resolve => server!.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
});
after(async () => {
  try {
    if (server) {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server!.close(error => error ? reject(error) : resolve()));
    }
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
  await pool.query("INSERT INTO settings(school_id,school_name,ws_shared_key,enable_tracking_hours,after_hours_mode) VALUES($1,'Supervision review','test-only',false,'off')", [schoolId]);
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
async function requestJson(data: Fixture, actorId: string, method: string, path: string, body: unknown) {
  const token = signUserToken({ userId: actorId, email: `${actorId}@example.test` });
  const response = await fetch(`${baseUrl}${path}`, { method, body: JSON.stringify(body),
    headers: { authorization: `Bearer ${token}`, "x-school-id": data.schoolId, "content-type": "application/json" } });
  return { status: response.status, body: await response.json() as { code?: string; context?: { endsAt: string } } };
}
const startInput = (data: Fixture, overrides: Record<string, unknown> = {}) => ({ action: "start", studentIds: [data.studentIds[0]], supervisionGroupId: data.groupId,
  assignedStaffId: data.teacherId, contextType: "other", endsAt: new Date(Date.now() + 60 * 60_000).toISOString(), ...overrides });
const preview = (data: Fixture, input: unknown, actorId = data.adminId) => scoped(data.schoolId, () => previewSupervision({ schoolId: data.schoolId, actorId, input }));
const commit = (data: Fixture, review: Awaited<ReturnType<typeof preview>>, actorId = data.adminId) => scoped(data.schoolId, () => commitSupervisionReview({ schoolId: data.schoolId, actorId, input: review.request, reviewToken: review.reviewToken, action: review.request.action }));
const roomInput = (data: Fixture, overrides: Record<string, unknown> = {}) => ({ action: "claim_room", studentIds: [data.studentIds[0]],
  contextType: "temporary_room", endsAt: new Date(Date.now() + 60 * 60_000).toISOString(), ...overrides });

async function currentClass(data: Fixture, teacherId: string, studentIds = data.studentIds) {
  const classId = randomUUID(), sessionId = randomUUID();
  await pool.query("INSERT INTO groups(id,school_id,teacher_id,name) VALUES($1,$2,$3,'Current class')", [classId, data.schoolId, teacherId]);
  await pool.query("INSERT INTO teaching_sessions(id,school_id,group_id,teacher_id,roster_snapshot_completed_at) VALUES($1,$2,$3,$4,now())", [sessionId, data.schoolId, classId, teacherId]);
  await pool.query("INSERT INTO classpilot_session_staff(school_id,teaching_session_id,staff_id,role) VALUES($1,$2,$3,'primary')", [data.schoolId, sessionId, teacherId]);
  for (const pupil of studentIds) await pool.query("INSERT INTO classpilot_session_students(school_id,teaching_session_id,group_id,student_id) VALUES($1,$2,$3,$4)", [data.schoolId, sessionId, classId, pupil]);
  return { classId, sessionId };
}

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

test("three grades join one temporary room with an unchanged deadline and independent dashboard authority", async () => {
  const data = await fixture();
  for (const [index, studentId] of data.studentIds.entries()) await pool.query("UPDATE students SET grade_level=$2 WHERE id=$1", [studentId, String(index + 3)]);
  const endsAt = new Date(Date.now() + 45 * 60_000).toISOString();
  const first = await commit(data, await preview(data, roomInput(data, { endsAt }), data.teacherId), data.teacherId);
  for (const studentId of data.studentIds.slice(1)) {
    const review = await preview(data, roomInput(data, { studentIds: [studentId], endsAt: undefined }), data.teacherId);
    assert.equal(review.destination.contextId, first.context.id);
    assert.equal(review.destination.endsAt, endsAt);
    const joined = await commit(data, review, data.teacherId);
    assert.equal(joined.context.id, first.context.id);
    assert.equal(joined.context.endsAt.toISOString(), endsAt);
  }
  assert.equal(first.context.purpose, "claim"); assert.equal(first.context.name, "My room");
  for (const field of ["scheduledConflictId", "scheduleProfileApplicationId", "scheduleProfileDate", "scheduleProfileBlockId"] as const) assert.equal(first.context[field], null);
  const activity = await scoped(data.schoolId, () => getClasspilotDashboardActivity(data.schoolId, data.teacherId));
  assert.equal(activity.current, null); assert.equal(activity.room?.id, first.context.id); assert.equal(activity.room?.studentCount, 3);
  const repeated = await commit(data, await preview(data, roomInput(data, { studentIds: data.studentIds, endsAt: undefined }), data.teacherId), data.teacherId);
  assert.deepEqual(repeated.outcomes.map(row => row.status), ["already_assigned", "already_assigned", "already_assigned"]);
  assert.equal(repeated.context.activeStudentCount, 3);
});

test("teachers consolidate their own scheduled supervision and class students without additional claim grants", async () => {
  const data = await fixture();
  const source = await scoped(data.schoolId, () => createSupervisionContextWithStudents({ context: {
    schoolId: data.schoolId, contextType: "supervision_group", name: "Grade 3 coverage", assignedStaffId: data.teacherId,
    createdBy: data.adminId, endsAt: new Date(Date.now() + 30 * 60_000), scheduleProfileApplicationId: randomUUID(),
    scheduleProfileDate: new Date().toISOString().slice(0, 10), scheduleProfileBlockId: randomUUID(),
  }, studentIds: [data.studentIds[0]!], assignedBy: data.adminId }));
  await currentClass(data, data.teacherId, [data.studentIds[1]!]);
  await pool.query("UPDATE classpilot_coverage_assignments SET active=false WHERE school_id=$1 AND staff_id=$2", [data.schoolId, data.teacherId]);
  await pool.query("UPDATE student_sessions SET last_seen_at=now()-interval '10 minutes' WHERE student_id=ANY($1::text[])", [data.studentIds.slice(0, 2)]);
  const options = await scoped(data.schoolId, () => supervisionSessionOptions({ schoolId: data.schoolId, actorId: data.teacherId }));
  assert.deepEqual(options.students.map(row => row.studentId).sort(), data.studentIds.slice(0, 2).sort());
  const review = await preview(data, roomInput(data, { studentIds: data.studentIds.slice(0, 2) }), data.teacherId);
  assert.ok(review.students.every(row => row.eligible));
  const combined = await commit(data, review, data.teacherId);
  assert.equal(combined.context.activeStudentCount, 2);
  assert.equal((await pool.query("SELECT status FROM classpilot_supervision_contexts WHERE id=$1", [source.id])).rows[0].status, "ended");
  const activity = await scoped(data.schoolId, () => getClasspilotDashboardActivity(data.schoolId, data.teacherId));
  assert.equal(activity.current?.purpose, "class"); assert.equal(activity.room?.id, combined.context.id);
});

test("room claims never pull another supervisor's student, including administrator claims", async () => {
  const data = await fixture();
  const owned = await commit(data, await preview(data, roomInput(data), data.teacherId), data.teacherId);
  for (const actorId of [data.adminId, data.receiverId]) {
    const review = await preview(data, roomInput(data), actorId);
    assert.equal(review.students[0]?.eligible, false);
    assert.match(review.students[0]?.reason || "", /another staff member/);
    await assert.rejects(commit(data, review, actorId), { code: "SUPERVISION_STUDENTS_UNAVAILABLE" });
  }
  const row = await pool.query("SELECT context_id FROM classpilot_supervision_students WHERE student_id=$1 AND released_at IS NULL", [data.studentIds[0]]);
  assert.equal(row.rows[0].context_id, owned.context.id);
  const adminSend = await preview(data, { action: "send", contextType: "temporary_room", assignedStaffId: data.receiverId,
    studentIds: [data.studentIds[0]], endsAt: new Date(Date.now() + 30 * 60_000).toISOString() });
  assert.equal(adminSend.students[0]?.eligible, false);
});

test("legacy HTTP reroute cannot pull another supervisor's students into a room even for its owner or an administrator", async () => {
  const data = await fixture();
  const source = await commit(data, await preview(data, startInput(data, {
    assignedStaffId: data.receiverId, studentIds: [data.studentIds[1]],
  })));
  const ownRoom = await commit(data, await preview(data, roomInput(data), data.teacherId), data.teacherId);
  const adminRoom = await commit(data, await preview(data, roomInput(data, { studentIds: [data.studentIds[2]] })), data.adminId);
  await currentClass(data, data.teacherId, [data.studentIds[1]!]);
  for (const [actorId, contextId] of [[data.teacherId, ownRoom.context.id], [data.adminId, adminRoom.context.id]]) {
    const result = await requestJson(data, actorId!, "POST", "/coverage/reroute", {
      contextId, studentIds: [data.studentIds[1]],
    });
    assert.equal(result.status, 409);
    assert.equal(result.body.code, "TEMPORARY_ROOM_REVIEW_REQUIRED");
  }
  const active = await pool.query("SELECT id,context_id FROM classpilot_supervision_students WHERE school_id=$1 AND student_id=$2 AND released_at IS NULL", [data.schoolId, data.studentIds[1]]);
  assert.deepEqual(active.rows, [{ id: source.assignments[0]!.id, context_id: source.context.id }]);
});

test("legacy HTTP reroute cannot bypass the 500-student room cap", async () => {
  const data = await fixture();
  const room = await commit(data, await preview(data, roomInput(data), data.teacherId), data.teacherId);
  const additionalIds = Array.from({ length: 499 }, () => randomUUID());
  pupils.push(...additionalIds);
  await pool.query("INSERT INTO students(id,school_id,first_name,last_name,status) SELECT unnest($1::text[]),$2,'Room','Student','active'", [additionalIds, data.schoolId]);
  await pool.query("INSERT INTO classpilot_supervision_students(school_id,context_id,student_id,assigned_by,source) SELECT $1,$2,unnest($3::text[]),$4,'staff_claim'", [data.schoolId, room.context.id, additionalIds, data.teacherId]);
  await currentClass(data, data.teacherId, [data.studentIds[1]!]);
  await assert.rejects(preview(data, roomInput(data, { studentIds: [data.studentIds[1]], endsAt: undefined }), data.teacherId), {
    code: "CLASSROOM_ROSTER_LIMIT", status: 422,
  });
  const result = await requestJson(data, data.teacherId, "POST", "/coverage/reroute", {
    contextId: room.context.id, studentIds: [data.studentIds[1]],
  });
  assert.equal(result.status, 409);
  assert.equal(result.body.code, "TEMPORARY_ROOM_REVIEW_REQUIRED");
  assert.equal((await pool.query("SELECT count(*) FROM classpilot_supervision_students WHERE context_id=$1 AND released_at IS NULL", [room.context.id])).rows[0].count, "500");
  assert.equal((await pool.query("SELECT count(*) FROM classpilot_supervision_students WHERE school_id=$1 AND student_id=$2 AND released_at IS NULL", [data.schoolId, data.studentIds[1]])).rows[0].count, "0");
});

test("room HTTP deadline updates require signed review while non-room legacy PATCH and reroute remain supported", async () => {
  const data = await fixture();
  const room = await commit(data, await preview(data, roomInput(data), data.teacherId), data.teacherId);
  for (const endsAt of [new Date(Date.now() + 90 * 60_000).toISOString(), new Date(room.context.startsAt.getTime() + 13 * 60 * 60_000).toISOString()]) {
    const denied = await requestJson(data, data.teacherId, "PATCH", `/coverage/contexts/${room.context.id}`, { endsAt });
    assert.equal(denied.status, 409);
    assert.equal(denied.body.code, "TEMPORARY_ROOM_REVIEW_REQUIRED");
  }
  assert.equal((await pool.query("SELECT ends_at=$2::timestamp AS unchanged FROM classpilot_supervision_contexts WHERE id=$1", [room.context.id, room.context.endsAt.toISOString()])).rows[0].unchanged, true);
  const endsAt = new Date(Date.now() + 90 * 60_000).toISOString();
  const review = await preview(data, { action: "end_time", destinationContextId: room.context.id, endsAt }, data.teacherId);
  const updated = await requestJson(data, data.teacherId, "PATCH", `/coverage/contexts/${room.context.id}`, { ...review.request, reviewToken: review.reviewToken });
  assert.equal(updated.status, 200);
  assert.equal(updated.body.context?.endsAt, endsAt);

  const normal = await commit(data, await preview(data, startInput(data, { studentIds: [data.studentIds[2]] })));
  const legacyUpdated = await requestJson(data, data.teacherId, "PATCH", `/coverage/contexts/${normal.context.id}`, { endsAt });
  assert.equal(legacyUpdated.status, 200);
  assert.equal(legacyUpdated.body.context?.endsAt, endsAt);
  await currentClass(data, data.teacherId, [data.studentIds[1]!]);
  const rerouted = await requestJson(data, data.teacherId, "POST", "/coverage/reroute", { contextId: normal.context.id, studentIds: [data.studentIds[1]] });
  assert.equal(rerouted.status, 201);
  assert.equal((await pool.query("SELECT context_id FROM classpilot_supervision_students WHERE school_id=$1 AND student_id=$2 AND released_at IS NULL", [data.schoolId, data.studentIds[1]])).rows[0].context_id, normal.context.id);
});

test("reviewed room handoffs require the sender and receiver authority and preserve receiving deadline", async () => {
  const data = await fixture();
  const source = await commit(data, await preview(data, roomInput(data), data.teacherId), data.teacherId);
  const destination = await commit(data, await preview(data, roomInput(data, { studentIds: [data.studentIds[1]], endsAt: new Date(Date.now() + 25 * 60_000).toISOString() }), data.receiverId), data.receiverId);
  const review = await preview(data, { action: "send", contextType: "temporary_room", assignedStaffId: data.receiverId, studentIds: [data.studentIds[0]] }, data.teacherId);
  assert.equal(review.destination.contextId, destination.context.id); assert.equal(review.destination.endsAt, destination.context.endsAt.toISOString());
  const sent = await commit(data, review, data.teacherId);
  assert.equal(sent.context.id, destination.context.id); assert.equal(sent.context.activeStudentCount, 2);
  assert.equal((await pool.query("SELECT status FROM classpilot_supervision_contexts WHERE id=$1", [source.context.id])).rows[0].status, "ended");
  const remaining = await commit(data, await preview(data, roomInput(data, { studentIds: [data.studentIds[2]] }), data.teacherId), data.teacherId);
  await pool.query("UPDATE classpilot_coverage_assignments SET active=false WHERE school_id=$1 AND staff_id=$2", [data.schoolId, data.receiverId]);
  const denied = await preview(data, { action: "send", destinationContextId: destination.context.id, studentIds: [data.studentIds[2]] }, data.teacherId);
  assert.equal(denied.students[0]?.eligible, false); assert.match(denied.students[0]?.reason || "", /receiving supervisor/);
  assert.equal(remaining.context.activeStudentCount, 1);
});

test("legacy return rejects a foreign room atomically even with underlying classroom authority", async () => {
  const data = await fixture();
  const ownRoom = await commit(data, await preview(data, roomInput(data), data.teacherId), data.teacherId);
  const otherRoom = await commit(data, await preview(data, roomInput(data, { studentIds: [data.studentIds[1]] }), data.receiverId), data.receiverId);
  await currentClass(data, data.teacherId, data.studentIds.slice(0, 2));
  await assert.rejects(scoped(data.schoolId, () => returnSupervisionStudentsToOwnClass({
    schoolId: data.schoolId, actorId: data.teacherId, studentIds: data.studentIds.slice(0, 2),
  })), { code: "TEMPORARY_ROOM_OWNER_REQUIRED", status: 409 });
  const remaining = await pool.query("SELECT context_id FROM classpilot_supervision_students WHERE school_id=$1 AND released_at IS NULL", [data.schoolId]);
  assert.deepEqual(remaining.rows.map(row => row.context_id).sort(), [ownRoom.context.id, otherRoom.context.id].sort());
  const returned = await scoped(data.schoolId, () => returnSupervisionStudentsToOwnClass({
    schoolId: data.schoolId, actorId: data.teacherId, studentIds: [data.studentIds[0]!],
  }));
  assert.deepEqual(returned.released.map(row => row.studentId), [data.studentIds[0]]);
  await assert.rejects(preview(data, { action: "end_time", destinationContextId: otherRoom.context.id,
    endsAt: new Date(Date.now() + 40 * 60_000).toISOString() }), { code: "TEMPORARY_ROOM_OWNER_REQUIRED" });
});

test("ending a room requires a nonempty exact roster review while explicit subsets remain supported", async () => {
  const data = await fixture();
  const first = await commit(data, await preview(data, roomInput(data), data.teacherId), data.teacherId);
  const release = (studentIds: unknown, expectedStudentIds?: unknown, actorId = data.teacherId) => scoped(data.schoolId, () => releaseTemporaryRoomStudents({
    schoolId: data.schoolId, actorId, contextId: first.context.id, studentIds, expectedStudentIds, releaseReason: "returned_to_class",
  }));
  await assert.rejects(release([]), { code: "TEMPORARY_ROOM_RELEASE_REVIEW_REQUIRED", status: 400 });
  await assert.rejects(release([], []), { code: "TEMPORARY_ROOM_RELEASE_INVALID", status: 400 });
  await assert.rejects(release(undefined, [data.studentIds[0]]), { code: "TEMPORARY_ROOM_RELEASE_INVALID", status: 400 });
  await commit(data, await preview(data, roomInput(data, { studentIds: [data.studentIds[1]], endsAt: undefined }), data.teacherId), data.teacherId);
  await assert.rejects(release([], [data.studentIds[0]]), { code: "SUPERVISION_ROSTER_CHANGED", status: 409 });
  await assert.rejects(release([], data.studentIds.slice(0, 2), data.adminId), { code: "TEMPORARY_ROOM_OWNER_REQUIRED", status: 409 });
  assert.equal((await pool.query("SELECT count(*) FROM classpilot_supervision_students WHERE context_id=$1 AND released_at IS NULL", [first.context.id])).rows[0].count, "2");
  assert.deepEqual((await release([data.studentIds[0]])).map(row => row.studentId), [data.studentIds[0]]);
  assert.deepEqual((await release([], [data.studentIds[1]])).map(row => row.studentId), [data.studentIds[1]]);
  assert.equal((await pool.query("SELECT status FROM classpilot_supervision_contexts WHERE id=$1", [first.context.id])).rows[0].status, "ended");
});

test("reviewed handoff creates a receiving room without a saved group using immutable recipient class authority", async () => {
  const data = await fixture();
  const sourceClass = await currentClass(data, data.teacherId, [data.studentIds[0]!]);
  await pool.query("INSERT INTO classpilot_session_staff(school_id,teaching_session_id,staff_id,role) VALUES($1,$2,$3,'co_teacher')", [data.schoolId, sourceClass.sessionId, data.receiverId]);
  await pool.query("UPDATE classpilot_coverage_assignments SET active=false WHERE school_id=$1 AND staff_id=$2", [data.schoolId, data.receiverId]);
  const review = await preview(data, { action: "send", contextType: "temporary_room", assignedStaffId: data.receiverId,
    studentIds: [data.studentIds[0]], endsAt: new Date(Date.now() + 30 * 60_000).toISOString() }, data.teacherId);
  assert.equal(review.destination.contextId, null); assert.equal(review.students[0]?.eligible, true);
  const sent = await commit(data, review, data.teacherId);
  assert.equal(sent.context.contextType, "temporary_room"); assert.equal(sent.context.assignedStaffId, data.receiverId); assert.equal(sent.context.coverageGroupId, null);
});

test("concurrent first room claims require a fresh review before joining the one committed room", async () => {
  const data = await fixture();
  const reviews = await Promise.all(data.studentIds.slice(0, 2).map(studentId => preview(data, roomInput(data, { studentIds: [studentId] }), data.teacherId)));
  const results = await Promise.allSettled(reviews.map(review => commit(data, review, data.teacherId)));
  assert.equal(results.filter(row => row.status === "fulfilled").length, 1);
  const rejected = results.find(row => row.status === "rejected") as PromiseRejectedResult;
  assert.equal(rejected.reason.code, "SUPERVISION_REVIEW_STALE");
  const joined = await commit(data, await preview(data, roomInput(data, { studentIds: data.studentIds.slice(0, 2), endsAt: undefined }), data.teacherId), data.teacherId);
  assert.equal(joined.context.activeStudentCount, 2);
  assert.equal((await pool.query("SELECT count(*) FROM classpilot_supervision_contexts WHERE school_id=$1 AND context_type='temporary_room' AND status='active'", [data.schoolId])).rows[0].count, "1");
});
