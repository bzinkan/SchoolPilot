import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { eq } from "drizzle-orm";
import { users } from "../src/schema/core.js";
import { canAccessPass, filterPassesForRole, getPassHistoryQueryAccessScope } from "../src/services/passpilotAccess.js";
import { getPasspilotClasses, normalizePasspilotPass } from "../src/services/passpilotClasses.js";
import db, { pool, sessionPool } from "../src/db.js";
import { runWithTenantContext } from "../src/middleware/tenantContext.js";
import { PASSPILOT_KIOSK_SCHEDULE_SQL } from "../src/db/passpilotKioskScheduleMigration.js";
import { passpilotKioskSessions } from "../src/schema/passpilot.js";
import { emptySchoolSchedulingConfig, defaultClassScheduleRule } from "../src/services/classpilotSchedulingRules.js";
import { emptyKioskSchedule, type KioskMode } from "../src/services/passpilotKioskSchedule.js";
import * as service from "../src/services/passpilotKioskAssignments.js";
import { createSelfClaimedKioskSession, createResumedKioskSession, retargetKioskSessionsForTeacher, getPassHistoryPage } from "../src/services/storage.js";
import { hashPassword } from "../src/util/password.js";
import { signUserToken } from "../src/services/jwt.js";
import kioskRouter from "../src/routes/passpilot/kiosk.js";
import { errorHandler } from "../src/middleware/errorHandler.js";
import type { ScheduleProfileApplication } from "../src/services/classpilotScheduleProfileModel.js";

const schoolIds: string[] = [], userIds: string[] = [];
const scoped = <T>(schoolId: string, fn: () => Promise<T>) => runWithTenantContext({ schoolId }, fn);
const at = new Date("2026-09-24T13:30:00Z");
let pinHash: string, server: Server, baseUrl: string;
before(async () => {
  assert.ok(["localhost", "127.0.0.1", "::1"].includes(new URL(process.env.DATABASE_URL || "").hostname), "Only a local fixture database is permitted");
  await pool.query(PASSPILOT_KIOSK_SCHEDULE_SQL);
  pinHash = await hashPassword("4321");
  const app = express(); app.use(express.json()); app.use("/api/passpilot/kiosk", kioskRouter); app.use(errorHandler);
  server = createServer(app); await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/passpilot/kiosk`;
});
after(async () => {
  await new Promise<void>(resolve => server?.close(() => resolve()));
  const client = await pool.connect();
  try {
    await client.query("BEGIN"); await client.query("SET LOCAL app.is_super='on'");
    for (const table of ["student_timeline_events", "passes", "passpilot_teacher_kiosk_settings", "passpilot_kiosk_devices", "passpilot_kiosk_sessions", "classpilot_student_control_states", "classpilot_supervision_students", "classpilot_supervision_contexts", "classpilot_session_students", "classpilot_session_staff", "teaching_sessions", "classpilot_scheduled_conflicts", "classpilot_schedule_change_legs", "classpilot_schedule_changes", "classpilot_schedule_change_pairs", "classpilot_school_schedules", "audit_logs"]) await client.query(`DELETE FROM ${table} WHERE school_id=ANY($1::text[])`, [schoolIds]);
    for (const table of ["group_students", "group_teachers"]) await client.query(`DELETE FROM ${table} WHERE group_id IN (SELECT id FROM groups WHERE school_id=ANY($1::text[]))`, [schoolIds]);
    await client.query("DELETE FROM teacher_grades WHERE teacher_id=ANY($1::text[])", [userIds]);
    for (const table of ["passpilot_grade_students", "groups", "students", "grades", "settings", "school_memberships", "product_licenses"]) await client.query(`DELETE FROM ${table} WHERE school_id=ANY($1::text[])`, [schoolIds]);
    await client.query("DELETE FROM users WHERE id=ANY($1::text[])", [userIds]);
    await client.query("DELETE FROM schools WHERE id=ANY($1::text[])", [schoolIds]);
    await client.query("COMMIT");
  } catch (error) { await client.query("ROLLBACK"); throw error; }
  finally {
    client.release();
    const { schedulerPool, schedulerLockPool } = await import("../src/services/schedulerDb.js");
    await Promise.all([pool.end(), sessionPool.end(), schedulerPool.end(), schedulerLockPool.end()]);
  }
});

async function fixture(source: "legacy_grades" | "classpilot_groups" = "legacy_grades") {
  const schoolId = randomUUID(), teacherId = randomUUID(), otherTeacherId = randomUUID(), adminId = randomUUID(), classId = randomUUID(), nextClassId = randomUUID(), studentId = randomUUID(), nextStudentId = randomUUID();
  schoolIds.push(schoolId); userIds.push(teacherId, otherTeacherId, adminId);
  await pool.query("INSERT INTO schools(id,name,status,is_active,plan_status,school_timezone,kiosk_enabled,kiosk_pin_hash) VALUES($1,'Kiosk fixture','active',true,'active','UTC',true,$2)", [schoolId, pinHash]);
  for (const product of ["PASSPILOT", "CLASSPILOT"]) await pool.query("INSERT INTO product_licenses(school_id,product,status) VALUES($1,$2,'active')", [schoolId, product]);
  await pool.query("INSERT INTO settings(school_id,school_name,ws_shared_key,passpilot_class_source,enable_tracking_hours,instructional_calendar) VALUES($1,'Kiosk fixture','fixture',$2,false,'{}')", [schoolId, source]);
  for (const [id, role] of [[teacherId, "teacher"], [otherTeacherId, "teacher"], [adminId, "school_admin"]]) {
    await pool.query("INSERT INTO users(id,email,first_name,last_name) VALUES($1,$2,'Kiosk','Teacher')", [id, `${id}@example.test`]);
    await pool.query("INSERT INTO school_memberships(school_id,user_id,role,status) VALUES($1,$2,$3,'active')", [schoolId, id, role]);
  }
  for (const [id, name] of [[studentId, "First"], [nextStudentId, "Second"]]) await pool.query("INSERT INTO students(id,school_id,first_name,last_name,status,student_id_number) VALUES($1,$2,$3,'Student','active',$4)", [id, schoolId, name, id]);
  for (const [id, student, name] of [[classId, studentId, "Math"], [nextClassId, nextStudentId, "Reading"]]) {
    if (source === "legacy_grades") {
      await pool.query("INSERT INTO grades(id,school_id,name) VALUES($1,$2,$3)", [id, schoolId, name]);
      await pool.query("INSERT INTO teacher_grades(teacher_id,grade_id) VALUES($1,$2)", [teacherId, id]);
      await pool.query("INSERT INTO passpilot_grade_students(school_id,grade_id,student_id) VALUES($1,$2,$3)", [schoolId, id, student]);
    } else {
      await pool.query("INSERT INTO groups(id,school_id,teacher_id,name,group_type,status,schedule_enabled,block_start_time,block_end_time,schedule_rule) VALUES($1,$2,$3,$4,'admin_class','active',true,$5,$6,$7::jsonb)", [id, schoolId, teacherId, name, id === classId ? "13:00" : "14:00", id === classId ? "14:00" : "15:00", JSON.stringify(defaultClassScheduleRule())]);
      await pool.query("INSERT INTO group_students(group_id,student_id) VALUES($1,$2)", [id, student]);
    }
  }
  const session = await scoped(schoolId, () => createSelfClaimedKioskSession(schoolId, null, { actorUserId: teacherId, manager: false }));
  return { schoolId, teacherId, otherTeacherId, adminId, classId, nextClassId, studentId, nextStudentId, session, source };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
const allDay = (f: Fixture, classId = f.classId) => ({ blocks: [{ id: "day", classId, weekdays: [0, 1, 2, 3, 4, 5, 6], startTime: "00:00", endTime: "23:59", startsOn: null, endsOn: null }], exceptions: [] });
const save = (f: Fixture, revision = 0, mode: KioskMode = f.source === "legacy_grades" ? "passpilot" : "classpilot", schedule = mode === "passpilot" ? allDay(f) : emptyKioskSchedule()) => scoped(f.schoolId, () => service.saveKioskPreferences({ schoolId: f.schoolId, teacherId: f.teacherId, actorId: f.teacherId, expectedRevision: revision, mode, schedule }));
const resolve = (f: Fixture, now = at) => scoped(f.schoolId, () => service.resolveKioskAssignment(f.schoolId, f.session, db, now));
async function checkout(f: Fixture, revision: string, studentId = f.studentId) {
  return scoped(f.schoolId, () => service.createActivityKioskPass({ schoolId: f.schoolId, sessionId: f.session.id, studentId, expectedRevision: revision, expectedPinHash: pinHash, destination: "bathroom" }));
}
const kioskHeaders = (f: Fixture) => ({ "x-school-id": f.schoolId, "x-kiosk-session": f.session.id, "x-kiosk-pin": "4321", "x-passpilot-class-model": "classpilot-groups-v1", "x-passpilot-kiosk-activity": "scheduled-activities-v1", "content-type": "application/json" });

async function teacherTimetable(actual = false) {
  const f = await fixture();
  const names = ["6th grade math", "5th grade math", "5th grade science", "6th grade science"];
  const classIds: string[] = [];
  for (const [index, name] of names.entries()) {
    const id = randomUUID(); classIds.push(id);
    await pool.query("INSERT INTO groups(id,school_id,teacher_id,name,group_type,status,schedule_enabled,block_start_time,block_end_time,schedule_rule) VALUES($1,$2,$3,$4,'admin_class','active',$5,$6,$7,$8::jsonb)",
      [id, f.schoolId, f.teacherId, name, !actual || index === 0, actual ? "00:00" : `${13 + index}:00`, actual ? "23:59" : `${14 + index}:00`, JSON.stringify({ ...defaultClassScheduleRule(), weekdays: [0, 1, 2, 3, 4, 5, 6] })]);
    await pool.query("INSERT INTO group_students(group_id,student_id) VALUES($1,$2)", [id, index === 0 || index === 3 ? f.studentId : f.nextStudentId]);
  }
  // Another teacher teaches the same children in the same period. That class is not this kiosk's assignment.
  await pool.query("INSERT INTO groups(school_id,teacher_id,name,group_type,status,schedule_enabled,block_start_time,block_end_time,schedule_rule) VALUES($1,$2,'Other teacher ELA','admin_class','active',true,'13:00','14:00',$3::jsonb)", [f.schoolId, f.otherTeacherId, JSON.stringify(defaultClassScheduleRule())]);
  return { ...f, classIds, names };
}

test("standalone schools opt each teacher into their own ClassPilot timetable without migrating grades", async () => {
  const f = await teacherTimetable();
  await save(f);
  const adminHeaders = { "x-school-id": f.schoolId, "content-type": "application/json", authorization: `Bearer ${signUserToken({ userId: f.adminId, email: `${f.adminId}@example.test`, isSuperAdmin: false })}` };
  const saved = await fetch(baseUrl + `/preferences?teacherId=${f.teacherId}`, { method: "PUT", headers: adminHeaders,
    body: JSON.stringify({ mode: "classpilot", schedule: allDay(f), expectedRevision: 1 }) });
  assert.equal(saved.status, 200);
  assert.deepEqual((await scoped(f.schoolId, () => service.getKioskPreferences(f.schoolId, f.teacherId))).schedule, allDay(f), "switching sources preserves the saved standalone timetable");
  for (let index = 0; index < 4; index++) {
    const assignment = await resolve(f, new Date(`2026-09-24T${13 + index}:00:00Z`));
    assert.equal(assignment.source, "classpilot_groups");
    assert.equal(assignment.current?.name, f.names[index]);
    assert.equal(assignment.current?.classId, f.classIds[index]);
    assert.deepEqual(assignment.roster.map(s => s.id), [index === 0 || index === 3 ? f.studentId : f.nextStudentId]);
  }
  const second = await scoped(f.schoolId, () => createSelfClaimedKioskSession(f.schoolId, null, { actorUserId: f.teacherId, manager: false }));
  assert.equal((await resolve({ ...f, session: second })).current?.classId, f.classIds[0]);
  assert.equal((await resolve(f, new Date("2026-09-24T17:00:00Z"))).status, "idle");
  assert.equal((await scoped(f.schoolId, () => service.getKioskPreferences(f.schoolId, f.otherTeacherId))).mode, "manual");
  const headers = { "x-school-id": f.schoolId, authorization: `Bearer ${signUserToken({ userId: f.teacherId, email: `${f.teacherId}@example.test`, isSuperAdmin: false })}` };
  const teachersResponse = await fetch(baseUrl + "/preferences/teachers", { headers });
  assert.equal(teachersResponse.status, 200);
  const teachers = await teachersResponse.json() as { teachers: { id: string }[] };
  assert.deepEqual(teachers.teachers.map(t => t.id), [f.teacherId]);
  const response = await fetch(baseUrl + "/preferences", { headers });
  assert.equal(response.status, 200);
  const data = await response.json() as { canFollowClasspilot: boolean; source: string; classpilotClasses: { id: string }[]; activeKioskCount: number };
  assert.equal(data.canFollowClasspilot, true);
  assert.equal(data.source, "legacy_grades");
  assert.equal(data.activeKioskCount, 2);
  assert.deepEqual(data.classpilotClasses.map(c => c.id).sort(), [...f.classIds].sort());
  assert.equal((await pool.query("SELECT count(*)::int AS count FROM teaching_sessions WHERE school_id=$1", [f.schoolId])).rows[0].count, 0);
  assert.equal((await pool.query("SELECT count(*)::int AS count FROM grades WHERE school_id=$1 AND classpilot_group_id IS NULL", [f.schoolId])).rows[0].count, 2);
});

test("teacher ClassPilot kiosk passes coexist with legacy overrides, report accurately, and return across sources", async (t) => {
  // Stay near the database clock for session expiry checks, away from midnight,
  // and explicitly make this fixture's date instructional even on weekends.
  const now = new Date();
  now.setUTCHours(13, 30, 0, 0);
  t.mock.timers.enable({ apis: ["Date"], now });
  const f = await teacherTimetable(true);
  await pool.query("INSERT INTO classpilot_school_schedules(school_id,config) VALUES($1,$2::jsonb)", [f.schoolId, JSON.stringify({
    ...emptySchoolSchedulingConfig(),
    dateOverrides: { [now.toISOString().slice(0, 10)]: { instructional: true } },
  })]);
  await save(f, 0, "classpilot");
  const headers = kioskHeaders(f);
  assert.equal((await fetch(baseUrl + "/snapshot", { headers: { ...headers, "x-passpilot-class-model": "" } })).status, 426);
  assert.equal((await fetch(baseUrl + "/snapshot", { headers: { ...headers, "x-passpilot-kiosk-activity": "" } })).status, 426);
  const snapshot = await fetch(baseUrl + "/snapshot", { headers }); assert.equal(snapshot.status, 200);
  const displayed = await snapshot.json() as { source: string; assignmentRevision: string };
  assert.equal(displayed.source, "classpilot_groups");
  const issued = await checkout(f, displayed.assignmentRevision);
  assert.equal(issued.classpilotGroupId, f.classIds[0]); assert.equal(issued.gradeId, null);
  assert.equal(issued.classNameSnapshot, f.names[0]);
  const settings = (await pool.query("SELECT passpilot_class_source,passpilot_canonical_writes_at FROM settings WHERE school_id=$1", [f.schoolId])).rows[0];
  assert.equal(settings.passpilot_class_source, "legacy_grades"); assert.equal(settings.passpilot_canonical_writes_at, null);
  assert.equal((await scoped(f.schoolId, () => normalizePasspilotPass(issued, f.schoolId))).className, f.names[0]);
  const activeClasses = await scoped(f.schoolId, () => getPasspilotClasses(f.schoolId, { userId: f.teacherId, manager: false }));
  assert.deepEqual(activeClasses.classes.map(c => c.id).sort(), [f.classId, f.nextClassId].sort(), "manual class tabs remain standalone");
  const historyClasses = await scoped(f.schoolId, () => getPasspilotClasses(f.schoolId, { userId: f.teacherId, manager: false, scope: "history" }));
  assert.equal(historyClasses.classes.find(c => c.id === f.classIds[0])?.source, "classpilot_groups");
  const [other] = await db.select().from(users).where(eq(users.id, f.otherTeacherId));
  assert.equal(await scoped(f.schoolId, () => canAccessPass(other!, f.schoolId, issued, "teacher")), false);
  await pool.query("INSERT INTO group_teachers(group_id,teacher_id) VALUES($1,$2)", [f.classIds[0], f.otherTeacherId]);
  assert.equal(await scoped(f.schoolId, () => canAccessPass(other!, f.schoolId, issued, "teacher")), true);
  const scope = await scoped(f.schoolId, () => getPassHistoryQueryAccessScope(other!, f.schoolId, "teacher"));
  assert.deepEqual(scope?.studentIds, [], "ClassPilot membership does not grant legacy student history");
  const history = await scoped(f.schoolId, () => getPassHistoryPage(f.schoolId, { access: scope! }));
  assert.deepEqual(history.passes.map(p => p.id), [issued.id]);

  const targeted = await scoped(f.schoolId, () => retargetKioskSessionsForTeacher(f.schoolId, f.teacherId, { source: "legacy_grades", classId: f.nextClassId }, { actorUserId: f.teacherId, manager: false }));
  const override = await resolve({ ...f, session: targeted[0]! }, new Date());
  assert.equal(override.mode, "classpilot"); assert.equal(override.source, "legacy_grades"); assert.equal(override.overridden, true);
  assert.equal(override.current?.classId, f.nextClassId); assert.deepEqual(override.roster.map(s => s.id), [f.nextStudentId]);
  await assert.rejects(checkout(f, displayed.assignmentRevision), /assignment changed/);
  const legacyPass = await checkout(f, override.revision, f.nextStudentId);
  assert.equal(legacyPass.gradeId, f.nextClassId); assert.equal(legacyPass.classpilotGroupId, null);
  const changed = await fetch(baseUrl + "/snapshot", { headers });
  const body = await changed.json() as { students: { id: string; returnOnly: boolean; canReturn: boolean }[] };
  assert.ok(body.students.some(s => s.id === f.studentId && s.returnOnly && s.canReturn));
  assert.equal((await scoped(f.schoolId, () => service.returnTeacherKioskPass(f.schoolId, f.session.id, f.studentId, pinHash)))?.id, issued.id);
  const resumed = await resolve({ ...f, session: { ...targeted[0]!, overrideExpiresAt: new Date(0) } }, new Date());
  assert.equal(resumed.source, "classpilot_groups"); assert.equal(resumed.current?.classId, f.classIds[0]);
  await save(f, 1, "manual");
  assert.equal((await scoped(f.schoolId, () => service.returnTeacherKioskPass(f.schoolId, f.session.id, f.nextStudentId, pinHash)))?.id, legacyPass.id);
});

test("opt-in defaults, persistence, isolated teachers, revision conflicts, and resumed/new kiosks", async () => {
  const f = await fixture();
  assert.equal((await resolve(f)).mode, "manual");
  await save(f);
  assert.equal((await resolve(f)).current?.classId, f.classId);
  await assert.rejects(save(f), /Reload/);
  await assert.rejects(scoped(f.schoolId, () => service.saveKioskPreferences({ schoolId: f.schoolId, teacherId: f.teacherId, actorId: f.otherTeacherId, expectedRevision: 1, mode: "manual", schedule: emptyKioskSchedule() })), /administrators/);
  const second = await scoped(f.schoolId, () => createSelfClaimedKioskSession(f.schoolId, null, { actorUserId: f.teacherId, manager: false }));
  assert.equal((await resolve({ ...f, session: second })).current?.classId, f.classId);
  const deviceId = randomUUID();
  await pool.query("INSERT INTO passpilot_kiosk_devices(id,school_id,teacher_id) VALUES($1,$2,$3)", [deviceId, f.schoolId, f.teacherId]);
  const resumed = await scoped(f.schoolId, () => createResumedKioskSession(f.schoolId, deviceId));
  assert.equal((await resolve({ ...f, session: resumed })).current?.classId, f.classId);
  assert.equal((await scoped(f.schoolId, () => service.getKioskPreferences(f.schoolId, f.otherTeacherId))).mode, "manual");
  const edits = await Promise.allSettled([save(f, 1), save(f, 1)]);
  assert.equal(edits.filter(edit => edit.status === "fulfilled").length, 1);
});

test("bulk manual override is temporary, schedule edits shorten its deadline, and manual mode persists explicitly", async () => {
  const f = await fixture(); await save(f);
  const targeted = await scoped(f.schoolId, () => retargetKioskSessionsForTeacher(f.schoolId, f.teacherId, { source: f.source, classId: f.nextClassId }, { actorUserId: f.teacherId, manager: false }));
  const session = targeted[0]!;
  const now = new Date();
  assert.equal((await resolve({ ...f, session }, now)).overridden, true);
  assert.equal((await resolve({ ...f, session }, now)).current?.classId, f.nextClassId);
  const ended = { ...session, overrideExpiresAt: new Date(now.getTime() - 1) };
  assert.equal((await resolve({ ...f, session: ended }, now)).current?.classId, f.classId);
  const edited = allDay(f);
  edited.blocks[0]!.endTime = "13:45";
  await save(f, 1, "passpilot", edited);
  const fixedSession = { ...session, overrideStartedAt: at, overrideExpiresAt: new Date("2026-09-24T23:59:00Z") };
  assert.equal((await resolve({ ...f, session: fixedSession })).overrideExpiresAt, "2026-09-24T13:45:00.000Z");
  assert.equal((await resolve({ ...f, session: fixedSession }, new Date("2026-09-24T13:46:00Z"))).overridden, false);
  await save(f, 2, "manual", allDay(f));
  assert.equal((await resolve({ ...f, session: ended }, now)).current?.classId, f.nextClassId);
});

test("snapshot/lookup/checkout contract fails closed for old clients and stale assignments; returns survive transitions", async () => {
  const f = await fixture(); await save(f);
  const headers = kioskHeaders(f);
  const oldHeaders = { ...headers }; delete (oldHeaders as Partial<typeof headers>)["x-passpilot-kiosk-activity"];
  assert.equal((await fetch(baseUrl + "/snapshot", { headers: oldHeaders })).status, 426);
  const response = await fetch(baseUrl + "/snapshot", { headers });
  assert.equal(response.status, 200);
  const body = await response.json() as { assignmentRevision: string; students: { id: string }[] };
  assert.deepEqual(body.students.map(s => s.id), [f.studentId]);
  const list = await (await fetch(baseUrl + "/students", { headers })).json() as { assignmentRevision: string; students: { id: string }[] };
  assert.equal(list.assignmentRevision, body.assignmentRevision);
  assert.deepEqual(list.students.map(s => s.id), [f.studentId]);
  assert.equal((await fetch(baseUrl + "/snapshot", { headers: { ...headers, "If-None-Match": response.headers.get("etag")! } })).status, 304);
  const results = await Promise.allSettled([checkout(f, body.assignmentRevision), checkout(f, body.assignmentRevision)]);
  assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
  await save(f, 1, "passpilot", allDay(f, f.nextClassId));
  await assert.rejects(checkout(f, body.assignmentRevision), /assignment changed/);
  const transitioned = await (await fetch(baseUrl + "/snapshot", { headers })).json() as { students: { id: string; returnOnly: boolean; canReturn: boolean }[] };
  assert.equal(transitioned.students.find(s => s.id === f.studentId)?.returnOnly, true);
  const lookup = await fetch(baseUrl + "/lookup", { method: "POST", headers, body: JSON.stringify({ studentIdNumber: f.studentId }) });
  assert.equal(lookup.status, 200);
  const other = await scoped(f.schoolId, () => createSelfClaimedKioskSession(f.schoolId, null, { actorUserId: f.otherTeacherId, manager: false }));
  assert.equal(await scoped(f.schoolId, () => service.returnTeacherKioskPass(f.schoolId, other.id, f.studentId, pinHash)), null);
  const returned = await scoped(f.schoolId, () => service.returnTeacherKioskPass(f.schoolId, f.session.id, f.studentId, pinHash));
  assert.equal(returned?.status, "returned"); assert.equal(returned?.gradeId, f.classId);
  assert.equal((await pool.query("SELECT count(*)::int AS count FROM student_timeline_events WHERE school_id=$1", [f.schoolId])).rows[0].count, 2);
});

test("ClassPilot classes resolve without sessions or devices, follow co-teachers, calendar and skipped occurrences", async () => {
  const f = await fixture("classpilot_groups"); await save(f);
  assert.equal((await resolve(f)).current?.classId, f.classId);
  assert.deepEqual((await resolve(f)).roster.map(s => s.id), [f.studentId]);
  assert.equal((await pool.query("SELECT count(*)::int AS count FROM teaching_sessions WHERE school_id=$1", [f.schoolId])).rows[0].count, 0);
  await pool.query("INSERT INTO group_teachers(group_id,teacher_id) VALUES($1,$2)", [f.classId, f.otherTeacherId]);
  await scoped(f.schoolId, () => service.saveKioskPreferences({ schoolId: f.schoolId, teacherId: f.otherTeacherId, actorId: f.adminId, mode: "classpilot", schedule: emptyKioskSchedule(), expectedRevision: 0 }));
  assert.equal((await resolve({ ...f, session: { ...f.session, teacherId: f.otherTeacherId } })).current?.classId, f.classId);
  await pool.query("UPDATE groups SET schedule_skipped_date='2026-09-24' WHERE id=$1", [f.classId]);
  assert.equal((await resolve(f)).status, "idle");
  await pool.query("UPDATE settings SET instructional_calendar=$2::jsonb WHERE school_id=$1", [f.schoolId, JSON.stringify({ "2026-09": { nonInstructionalDates: ["2026-09-24"] } })]);
  assert.equal((await resolve(f, new Date("2026-09-24T14:30:00Z"))).status, "idle");
});

async function testingContext(f: Fixture, actual = false) {
  const contextId = randomUUID(), applicationId = randomUUID(), blockId = randomUUID(), scopeId = randomUUID();
  const date = actual ? new Date().toISOString().slice(0, 10) : "2026-09-24";
  const window = { date, blockId, name: "MAP testing", coverageGroupId: scopeId, assignedStaffId: f.teacherId, studentIds: [f.studentId, f.nextStudentId], startTime: "00:00", endTime: "23:59" };
  const application: ScheduleProfileApplication = { id: applicationId, profileId: randomUUID(), profileName: "Testing", profileRevision: 1,
    dates: [date], definition: { name: "Testing", grades: [], classIds: [], classRules: [], testingBlocks: [{ id: blockId, name: window.name, coverageGroupId: scopeId, assignedStaffId: f.teacherId, startTime: window.startTime, endTime: window.endTime }] },
    classWindows: {}, testingWindows: [window], status: "scheduled", createdBy: f.adminId, createdAt: new Date().toISOString() };
  const config = { ...emptySchoolSchedulingConfig(), profileApplications: [application] };
  await pool.query("INSERT INTO classpilot_school_schedules(school_id,config) VALUES($1,$2::jsonb)", [f.schoolId, JSON.stringify(config)]);
  const activate = async () => {
    await pool.query("INSERT INTO classpilot_supervision_contexts(id,school_id,context_type,name,assigned_staff_id,created_by,starts_at,ends_at,schedule_profile_application_id,schedule_profile_date,schedule_profile_block_id) VALUES($1,$2,'coverage_group','MAP testing',$3,$4,$5,$6,$7,$8,$9)", [contextId, f.schoolId, f.teacherId, f.adminId, `${date}T00:00:00Z`, `${date}T23:59:00Z`, applicationId, date, blockId]);
    for (const student of [f.studentId, f.nextStudentId]) await pool.query("INSERT INTO classpilot_supervision_students(school_id,context_id,student_id,assigned_by) VALUES($1,$2,$3,$4)", [f.schoolId, contextId, student, f.adminId]);
  };
  return { contextId, applicationId, blockId, date, config, activate };
}

test("scheduled testing waits for activation, uses mixed offline roster, follows partial release/extensions/reassignment and early end", async () => {
  const f = await fixture("classpilot_groups"); await save(f);
  const t = await testingContext(f);
  assert.equal((await resolve(f)).status, "pending");
  await pool.query("UPDATE classpilot_school_schedules SET profile_activation_outcomes=$2::jsonb WHERE school_id=$1", [f.schoolId, JSON.stringify({ [`${t.applicationId}:${t.date}:${t.blockId}`]: { status: "failed", reason: "fixture" } })]);
  assert.equal((await resolve(f)).status, "failed");
  await t.activate();
  const initial = await resolve(f);
  assert.equal(initial.current?.kind, "testing"); assert.equal(initial.roster.length, 2);
  await pool.query("UPDATE classpilot_supervision_students SET released_at=now() WHERE context_id=$1 AND student_id=$2", [t.contextId, f.nextStudentId]);
  const released = await resolve(f); assert.equal(released.roster.length, 1); assert.notEqual(released.revision, initial.revision);
  await pool.query("UPDATE classpilot_supervision_contexts SET ends_at='2026-09-25T00:00:00Z',classroom_authority_revision=classroom_authority_revision+1 WHERE id=$1", [t.contextId]);
  assert.notEqual((await resolve(f)).revision, released.revision);
  await pool.query("UPDATE classpilot_supervision_contexts SET assigned_staff_id=$2,classroom_authority_revision=classroom_authority_revision+1 WHERE id=$1", [t.contextId, f.otherTeacherId]);
  assert.equal((await resolve(f)).current?.kind, "class"); assert.equal((await resolve(f)).roster.length, 0);
  await pool.query("UPDATE classpilot_supervision_contexts SET status='ended',ended_at=now() WHERE id=$1", [t.contextId]);
  assert.equal((await resolve(f)).current?.classId, f.classId); assert.equal((await resolve(f)).roster.length, 1);
});

for (const source of ["legacy_grades", "classpilot_groups"] as const) test(`${source}: testing passes retain activity snapshots, restrict history, and return during schedule failure`, async () => {
  const f = await fixture(source); await save(f, 0, "classpilot"); const t = await testingContext(f, true); await t.activate();
  const assignment = await resolve(f, new Date()); const pass = await checkout(f, assignment.revision);
  assert.equal(pass.gradeId, null); assert.equal(pass.classpilotGroupId, null); assert.equal(pass.activityNameSnapshot, "MAP testing"); assert.equal(pass.issuingKioskSessionId, f.session.id);
  const history = await scoped(f.schoolId, () => getPassHistoryPage(f.schoolId, { access: { issuerTeacherId: f.otherTeacherId, studentIds: [f.studentId], classIds: [], gradeIds: [] } }));
  assert.equal(history.passes.length, 0);
  // Historical legacy membership must not grant a student's regular teacher access to testing passes.
  const legacyGradeId = randomUUID();
  await pool.query("INSERT INTO grades(id,school_id,name) VALUES($1,$2,'Historical class')", [legacyGradeId, f.schoolId]);
  await pool.query("INSERT INTO teacher_grades(teacher_id,grade_id) VALUES($1,$2)", [f.otherTeacherId, legacyGradeId]);
  await pool.query("INSERT INTO passpilot_grade_students(school_id,grade_id,student_id) VALUES($1,$2,$3)", [f.schoolId, legacyGradeId, f.studentId]);
  const [otherTeacher] = await db.select().from(users).where(eq(users.id, f.otherTeacherId));
  assert.equal(await scoped(f.schoolId, () => canAccessPass(otherTeacher!, f.schoolId, pass, "teacher")), false);
  assert.deepEqual(await scoped(f.schoolId, () => filterPassesForRole([pass], otherTeacher!, f.schoolId, "teacher")), []);
  const unattributed = { ...pass, id: randomUUID(), supervisionContextId: null, activityKind: null, activityNameSnapshot: null };
  assert.deepEqual((await scoped(f.schoolId, () => filterPassesForRole([pass, unattributed], otherTeacher!, f.schoolId, "teacher"))).map(p => p.id), [unattributed.id],
    "a legacy student fallback must never re-add an unrelated testing pass");
  await pool.query("UPDATE product_licenses SET status='inactive' WHERE school_id=$1 AND product='CLASSPILOT'", [f.schoolId]);
  assert.equal((await scoped(f.schoolId, () => service.resolveKioskDisplayAssignment(f.schoolId, f.session))).status, "unavailable");
  assert.equal((await scoped(f.schoolId, () => service.returnTeacherKioskPass(f.schoolId, f.session.id, f.studentId, pinHash)))?.id, pass.id);
});

test("checkout waiting for the school lock revalidates a schedule change; PIN rotation and reassignment revoke writes", async () => {
  const f = await fixture(); await save(f); const old = await resolve(f, new Date());
  const blocker = await pool.connect();
  try {
    await blocker.query("BEGIN"); await blocker.query("SELECT id FROM schools WHERE id=$1 FOR UPDATE", [f.schoolId]);
    const pending = checkout(f, old.revision);
    await blocker.query("UPDATE passpilot_teacher_kiosk_settings SET revision=revision+1,schedule=$2::jsonb WHERE school_id=$1", [f.schoolId, JSON.stringify(allDay(f, f.nextClassId))]);
    await blocker.query("COMMIT");
    await assert.rejects(pending, /assignment changed/);
  } finally { blocker.release(); }
  await pool.query("UPDATE schools SET kiosk_pin_hash='rotated' WHERE id=$1", [f.schoolId]);
  await assert.rejects(checkout(f, (await resolve(f, new Date())).revision, f.nextStudentId), /no longer active/);
  await pool.query("UPDATE schools SET kiosk_pin_hash=$2 WHERE id=$1", [f.schoolId, pinHash]);
  await pool.query("UPDATE passpilot_kiosk_sessions SET teacher_id=$2,revision=revision+1 WHERE id=$1", [f.session.id, f.otherTeacherId]);
  await assert.rejects(checkout(f, old.revision), /assignment changed/);
});

test("school isolation and preference roles are enforced by API and database parent checks", async () => {
  const f = await fixture(), other = await fixture();
  const response = await fetch(baseUrl + `/preferences?teacherId=${f.otherTeacherId}`, { headers: { "x-school-id": f.schoolId, authorization: `Bearer ${signUserToken({ userId: f.teacherId, email: `${f.teacherId}@example.test`, isSuperAdmin: false })}` } });
  assert.equal(response.status, 403);
  await assert.rejects(pool.query("INSERT INTO passpilot_teacher_kiosk_settings(school_id,teacher_id) VALUES($1,$2)", [other.schoolId, f.teacherId]), /same school/);
  await assert.rejects(scoped(other.schoolId, () => service.resolveKioskAssignment(other.schoolId, f.session)), /session expired/);
  await assert.rejects(scoped(other.schoolId, () => service.createActivityKioskPass({ schoolId: other.schoolId, sessionId: f.session.id, studentId: f.studentId, expectedRevision: "invalid", expectedPinHash: pinHash, destination: "bathroom" })), /session expired/);
  assert.equal((await scoped(f.schoolId, () => db.select().from(passpilotKioskSessions).where(eq(passpilotKioskSessions.id, f.session.id)))).length, 1);
});

test("a teacher with an additional office role can edit their schedule; office-only staff cannot", async () => {
  const f = await fixture();
  await pool.query("INSERT INTO school_memberships(school_id,user_id,role,status) VALUES($1,$2,'office_staff','active')", [f.schoolId, f.teacherId]);
  await pool.query("DELETE FROM teacher_grades WHERE teacher_id=$1 AND grade_id=$2", [f.teacherId, f.nextClassId]);
  const manualSession = await scoped(f.schoolId, () => createSelfClaimedKioskSession(f.schoolId,
    { source: f.source, classId: f.nextClassId }, { actorUserId: f.teacherId, manager: true }));
  assert.equal((await resolve({ ...f, session: manualSession })).current?.classId, f.nextClassId,
    "an additional office role retains school-wide manual pass authority");
  const headers = { "x-school-id": f.schoolId, "content-type": "application/json", authorization: `Bearer ${signUserToken({ userId: f.teacherId, email: `${f.teacherId}@example.test`, isSuperAdmin: false })}` };
  assert.equal((await fetch(baseUrl + "/preferences", { headers })).status, 200);
  assert.equal((await fetch(baseUrl + "/preferences", { method: "PUT", headers, body: JSON.stringify({ mode: "passpilot", schedule: allDay(f), expectedRevision: 0 }) })).status, 200);
  await pool.query("UPDATE school_memberships SET status='inactive' WHERE school_id=$1 AND user_id=$2 AND role='teacher'", [f.schoolId, f.teacherId]);
  assert.equal((await fetch(baseUrl + "/preferences", { headers })).status, 403);
});

test("a checkout waiting for a supervision release or roster edit cannot issue from its displayed revision", async () => {
  const f = await fixture("classpilot_groups"); await save(f); const t = await testingContext(f, true); await t.activate();
  const old = await resolve(f, new Date());
  const blocker = await pool.connect();
  try {
    await blocker.query("BEGIN"); await blocker.query("SELECT id FROM schools WHERE id=$1 FOR UPDATE", [f.schoolId]);
    const pending = checkout(f, old.revision);
    await blocker.query("UPDATE classpilot_supervision_students SET released_at=now() WHERE context_id=$1 AND student_id=$2", [t.contextId, f.studentId]);
    await blocker.query("COMMIT");
    await assert.rejects(pending, /assignment changed/);
    assert.equal((await pool.query("SELECT count(*)::int AS count FROM passes WHERE school_id=$1", [f.schoolId])).rows[0].count, 0);
  } finally { blocker.release(); }
  const regular = await fixture(); await save(regular); const displayed = await resolve(regular, new Date());
  await pool.query("DELETE FROM passpilot_grade_students WHERE school_id=$1 AND student_id=$2", [regular.schoolId, regular.studentId]);
  await assert.rejects(checkout(regular, displayed.revision), /assignment changed/);
  await pool.query("UPDATE product_licenses SET status='inactive' WHERE school_id=$1 AND product='PASSPILOT'", [regular.schoolId]);
  await assert.rejects(save(regular, 1), /no longer active/);
});

test("frozen occurrences retain their captured roster and staff even after the official roster changes", async () => {
  const f = await fixture("classpilot_groups"); await save(f); const sessionId = randomUUID();
  await pool.query("INSERT INTO teaching_sessions(id,school_id,group_id,teacher_id,scheduled_date,scheduled_timezone,scheduled_start_at,scheduled_end_at,scheduled_state,roster_snapshot_completed_at,class_name_snapshot) VALUES($1,$2,$3,$4,'2026-09-24','UTC','2026-09-24T13:00Z','2026-09-24T14:00Z','active',now(),'Frozen Math')", [sessionId, f.schoolId, f.classId, f.teacherId]);
  await pool.query("INSERT INTO classpilot_session_staff(school_id,teaching_session_id,staff_id,role) VALUES($1,$2,$3,'primary')", [f.schoolId, sessionId, f.teacherId]);
  await pool.query("INSERT INTO classpilot_session_students(school_id,teaching_session_id,group_id,student_id) VALUES($1,$2,$3,$4)", [f.schoolId, sessionId, f.classId, f.nextStudentId]);
  const frozen = await resolve(f); assert.equal(frozen.current?.name, "Frozen Math"); assert.deepEqual(frozen.roster.map(s => s.id), [f.nextStudentId]);
  await pool.query("INSERT INTO group_teachers(group_id,teacher_id) VALUES($1,$2)", [f.classId, f.otherTeacherId]);
  await scoped(f.schoolId, () => service.saveKioskPreferences({ schoolId: f.schoolId, teacherId: f.otherTeacherId, actorId: f.adminId, mode: "classpilot", schedule: emptyKioskSchedule(), expectedRevision: 0 }));
  assert.equal((await resolve({ ...f, session: { ...f.session, teacherId: f.otherTeacherId } })).status, "idle", "newly assigned teachers must not acquire a frozen occurrence");
  await pool.query("UPDATE teaching_sessions SET scheduled_state='skipped' WHERE id=$1", [sessionId]);
  assert.equal((await resolve(f)).status, "idle");
  await pool.query("UPDATE teaching_sessions SET scheduled_state='finalized',end_time='2026-09-24T13:15Z' WHERE id=$1", [sessionId]);
  assert.equal((await resolve(f)).status, "idle", "an early End Class cannot resurrect a frozen occurrence");
  await pool.query("UPDATE teaching_sessions SET scheduled_state='active',end_time=NULL WHERE id=$1", [sessionId]);
  await pool.query("UPDATE groups SET schedule_skipped_date='2026-09-24' WHERE id=$1", [f.classId]);
  assert.equal((await resolve(f)).status, "idle", "class skip state applies to frozen occurrences too");
  await pool.query("UPDATE groups SET schedule_skipped_date=NULL,status='archived' WHERE id=$1", [f.classId]);
  assert.equal((await resolve(f)).status, "idle", "archived classes cannot authorize kiosk checkout");
});

test("applied schedule profiles move ordinary classes and cancelled testing falls back to that effective schedule", async () => {
  const f = await fixture("classpilot_groups"); await save(f); const t = await testingContext(f);
  const application = t.config.profileApplications[0]!;
  application.definition.classRules = [{ classId: f.nextClassId, action: "time", startTime: "13:00", endTime: "14:00" }, { classId: f.classId, action: "skip" }];
  application.classWindows = { "2026-09-24": { [f.classId]: null, [f.nextClassId]: { startTime: "13:00", endTime: "14:00" } } };
  application.cancelledBlocks = [{ date: t.date, blockId: t.blockId, cancelledAt: new Date().toISOString(), cancelledBy: f.adminId }];
  await pool.query("UPDATE classpilot_school_schedules SET config=$2::jsonb WHERE school_id=$1", [f.schoolId, JSON.stringify(t.config)]);
  assert.equal((await resolve(f)).current?.classId, f.nextClassId);
  assert.equal((await resolve(f)).roster[0]?.id, f.nextStudentId);
  application.status = "cancelled";
  await pool.query("UPDATE classpilot_school_schedules SET config=$2::jsonb WHERE school_id=$1", [f.schoolId, JSON.stringify(t.config)]);
  assert.equal((await resolve(f)).current?.classId, f.classId);
});

test("approved swaps change the assignment without a live session", async () => {
  const f = await fixture("classpilot_groups"); await save(f); const pairId = randomUUID(), changeId = randomUUID();
  const client = await pool.connect();
  try {
    await client.query("BEGIN"); const sorted = [f.classId, f.nextClassId].sort();
    await client.query("INSERT INTO classpilot_schedule_change_pairs(id,school_id,first_group_id,second_group_id,created_by) VALUES($1,$2,$3,$4,$5)", [pairId, f.schoolId, ...sorted, f.adminId]);
    await client.query("INSERT INTO classpilot_schedule_changes(id,school_id,pair_id,scheduled_date,timezone_snapshot,status,reason,requested_by_user_id,requested_by_role,requires_admin_approval) VALUES($1,$2,$3,'2026-09-24','UTC','approved','Fixture',$4,'admin',false)", [changeId, f.schoolId, pairId, f.adminId]);
    for (const [index, id, original, effective] of [[1, f.classId, "13", "14"], [2, f.nextClassId, "14", "13"]]) {
      await client.query("INSERT INTO classpilot_schedule_change_legs(school_id,schedule_change_id,scheduled_date,leg_order,group_id,primary_teacher_id_snapshot,class_name_snapshot,original_start_time,original_end_time,effective_start_time,effective_end_time) VALUES($1,$2,'2026-09-24',$3,$4,$5,'Class',$6,$7,$8,$9)", [f.schoolId, changeId, index, id, f.teacherId, `${original}:00`, `${Number(original) + 1}:00`, `${effective}:00`, `${Number(effective) + 1}:00`]);
    }
    await client.query("COMMIT");
  } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
  assert.equal((await resolve(f)).current?.classId, f.nextClassId);
  assert.equal((await resolve(f)).next?.classId, f.classId);
});

test("ordinary ad hoc claims never activate testing; assigned scheduled coverage uses its actual roster", async () => {
  const f = await fixture("classpilot_groups"); await save(f); const contextId = randomUUID(), conflictId = randomUUID();
  await pool.query("INSERT INTO classpilot_supervision_contexts(id,school_id,context_type,name,assigned_staff_id,created_by,starts_at,ends_at) VALUES($1,$2,'manual','Coverage',$3,$3,'2026-09-24T13:00Z','2026-09-24T14:00Z')", [contextId, f.schoolId, f.teacherId]);
  assert.equal((await resolve(f)).current?.kind, "class");
  await pool.query("INSERT INTO classpilot_scheduled_conflicts(id,school_id,group_id,teacher_id,scheduled_date,block_start_time,block_end_time,status) VALUES($1,$2,$3,$4,'2026-09-24','13:00','14:00','claimed')", [conflictId, f.schoolId, f.classId, f.otherTeacherId]);
  await pool.query("UPDATE classpilot_supervision_contexts SET scheduled_conflict_id=$2 WHERE id=$1", [contextId, conflictId]);
  await pool.query("INSERT INTO classpilot_supervision_students(school_id,context_id,student_id,assigned_by) VALUES($1,$2,$3,$4)", [f.schoolId, contextId, f.nextStudentId, f.teacherId]);
  const covered = await resolve(f); assert.equal(covered.current?.kind, "coverage"); assert.deepEqual(covered.roster.map(s => s.id), [f.nextStudentId]);
});

test("RLS settings deny unscoped and cross-school rows for a non-owner database role", async () => {
  const f = await fixture(), other = await fixture(); await save(f); await save(other);
  const client = await pool.connect(); const role = `pp_kiosk_fixture_${process.pid}`;
  try {
    await client.query("BEGIN"); await client.query(`CREATE ROLE ${role} NOLOGIN`);
    await client.query(`GRANT SELECT,INSERT,UPDATE ON passpilot_teacher_kiosk_settings TO ${role}`);
    await client.query(`GRANT SELECT ON school_memberships TO ${role}`);
    await client.query(`SET LOCAL ROLE ${role}`);
    await client.query("SET LOCAL app.is_super='off'"); await client.query("SET LOCAL app.school_id=''");
    assert.equal((await client.query("SELECT * FROM passpilot_teacher_kiosk_settings")).rowCount, 0);
    await client.query("SELECT set_config('app.school_id',$1,true)", [f.schoolId]);
    assert.equal((await client.query("SELECT * FROM passpilot_teacher_kiosk_settings")).rowCount, 1);
    assert.equal((await client.query("UPDATE passpilot_teacher_kiosk_settings SET mode='manual' WHERE school_id=$1", [other.schoolId])).rowCount, 0);
    await assert.rejects(client.query("INSERT INTO passpilot_teacher_kiosk_settings(school_id,teacher_id) VALUES($1,$2)", [other.schoolId, other.otherTeacherId]), /row-level security/);
  } finally { await client.query("ROLLBACK"); client.release(); }
});

test("repeated snapshots remain bounded and do not create monitoring or supervision state", async () => {
  const f = await fixture("classpilot_groups"); await save(f); const headers = kioskHeaders(f);
  const started = performance.now();
  const responses = await Promise.all(Array.from({ length: 12 }, () => fetch(baseUrl + "/snapshot", { headers })));
  assert.ok(responses.every(response => response.status === 200));
  assert.ok(performance.now() - started < 5000, "a burst must complete within the healthy polling interval");
  for (const table of ["teaching_sessions", "classpilot_supervision_contexts", "classpilot_student_control_states"]) {
    assert.equal((await pool.query(`SELECT count(*)::int AS count FROM ${table} WHERE school_id=$1`, [f.schoolId])).rows[0].count, 0);
  }
});
