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
import { passes, passpilotKioskSessions } from "../src/schema/passpilot.js";
import { emptySchoolSchedulingConfig, defaultClassScheduleRule } from "../src/services/classpilotSchedulingRules.js";
import { emptyKioskSchedule, type KioskMode } from "../src/services/passpilotKioskSchedule.js";
import * as service from "../src/services/passpilotKioskAssignments.js";
import { createGroup, createSelfClaimedKioskSession, createResumedKioskSession, retargetKioskSessionsForTeacher, getPassHistoryPage } from "../src/services/storage.js";
import { hashPassword } from "../src/util/password.js";
import { signUserToken } from "../src/services/jwt.js";
import kioskRouter from "../src/routes/passpilot/kiosk.js";
import passesRouter from "../src/routes/passpilot/passes.js";
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
  const app = express(); app.use(express.json()); app.use("/api/passpilot/kiosk", kioskRouter); app.use("/api/passpilot/passes", passesRouter); app.use(errorHandler);
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
    // Retain the uniquely owned synthetic school/staff lifecycle roots.
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
  const classFixtures: [string, string, string][] = [[classId, studentId, "Math"], [nextClassId, nextStudentId, "Reading"]];
  for (const [id, student, name] of classFixtures) {
    if (source === "legacy_grades") {
      await pool.query("INSERT INTO grades(id,school_id,name) VALUES($1,$2,$3)", [id, schoolId, name]);
      await pool.query("INSERT INTO teacher_grades(teacher_id,grade_id) VALUES($1,$2)", [teacherId, id]);
      await pool.query("INSERT INTO passpilot_grade_students(school_id,grade_id,student_id) VALUES($1,$2,$3)", [schoolId, id, student]);
    } else {
      await scoped(schoolId, () => createGroup({ id, schoolId, teacherId, name, groupType: "admin_class", status: "active",
        scheduleEnabled: true, blockStartTime: id === classId ? "13:00" : "14:00",
        blockEndTime: id === classId ? "14:00" : "15:00", scheduleRule: defaultClassScheduleRule() }));
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

const staffHeaders = (f: Fixture, teacherId = f.otherTeacherId) => ({
  "x-school-id": f.schoolId,
  "x-passpilot-class-model": "classpilot-groups-v1",
  "content-type": "application/json",
  authorization: `Bearer ${signUserToken({ userId: teacherId, email: `${teacherId}@example.test`, isSuperAdmin: false })}`,
});
async function seedReturnPass(f: Fixture, options: { studentId?: string; teacherId?: string; issuedVia?: "teacher" | "kiosk"; gradeId?: string | null; classId?: string | null } = {}) {
  const id = randomUUID();
  await pool.query(`INSERT INTO passes(id,school_id,student_id,teacher_id,grade_id,classpilot_group_id,destination,custom_destination,status,duration,expires_at,issued_via,notes)
    VALUES($1,$2,$3,$4,$5,$6,'custom','Private destination','active',5,now()-interval '1 minute',$7,'Private pass note')`,
  [id, f.schoolId, options.studentId ?? f.studentId, options.teacherId ?? f.teacherId,
    options.gradeId === undefined ? (f.source === "legacy_grades" ? f.classId : null) : options.gradeId,
    options.classId === undefined ? (f.source === "classpilot_groups" ? f.classId : null) : options.classId,
    options.issuedVia ?? "teacher"]);
  return id;
}
type ReturnMatch = { passId: string; studentId: string; firstName: string; lastName: string; studentIdNumber: string | null };
type ReturnLookup = { matches: ReturnMatch[]; hasMore: boolean };
const kioskPost = (path: string, headers: Record<string, string>, body: unknown) => fetch(baseUrl + path, { method: "POST", headers, body: JSON.stringify(body) });

async function teacherTimetable(actual = false) {
  const f = await fixture();
  const names = ["6th grade math", "5th grade math", "5th grade science", "6th grade science"];
  const classIds: string[] = [];
  for (const [index, name] of names.entries()) {
    const id = randomUUID(); classIds.push(id);
    await scoped(f.schoolId, () => createGroup({ id, schoolId: f.schoolId, teacherId: f.teacherId, name,
      groupType: "admin_class", status: "active", scheduleEnabled: !actual || index === 0,
      blockStartTime: actual ? "00:00" : `${13 + index}:00`, blockEndTime: actual ? "23:59" : `${14 + index}:00`,
      scheduleRule: { ...defaultClassScheduleRule(), weekdays: [0, 1, 2, 3, 4, 5, 6] } }));
    await pool.query("INSERT INTO group_students(group_id,student_id) VALUES($1,$2)", [id, index === 0 || index === 3 ? f.studentId : f.nextStudentId]);
  }
  // Another teacher teaches the same children in the same period. That class is not this kiosk's assignment.
  await scoped(f.schoolId, () => createGroup({ schoolId: f.schoolId, teacherId: f.otherTeacherId, name: "Other teacher ELA",
    groupType: "admin_class", status: "active", scheduleEnabled: true, blockStartTime: "13:00", blockEndTime: "14:00",
    scheduleRule: defaultClassScheduleRule() }));
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
  await pool.query("INSERT INTO group_teachers(group_id,teacher_id,role) VALUES($1,$2,'co-teacher')", [f.classIds[0], f.otherTeacherId]);
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
  assert.equal(body.students.some(s => s.id === f.studentId), false, "a kiosk retargeted to another class must not list the previous class's pass");
  assert.equal(await scoped(f.schoolId, () => service.returnTeacherKioskPass(f.schoolId, f.session.id, f.studentId, pinHash)), null,
    "the old assignment must not return a pass after the kiosk changes classes");
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

test("claimed kiosks keep independent class scopes for roster, lookup, and check-in; teachers can still return across classes", async () => {
  const f = await fixture();
  const secondSession = await scoped(f.schoolId, () => createSelfClaimedKioskSession(f.schoolId, null,
    { actorUserId: f.teacherId, manager: false }));
  const teacherHeaders = staffHeaders(f, f.teacherId);
  const firstAssignment = await fetch(baseUrl + `/sessions/${f.session.id}`, {
    method: "PUT", headers: teacherHeaders, body: JSON.stringify({ classId: f.classId }),
  });
  const secondAssignment = await fetch(baseUrl + `/sessions/${secondSession.id}`, {
    method: "PUT", headers: teacherHeaders, body: JSON.stringify({ classId: f.nextClassId }),
  });
  assert.equal(firstAssignment.status, 200);
  assert.equal(secondAssignment.status, 200);
  const assignedRows = (await pool.query(
    "SELECT id,grade_id FROM passpilot_kiosk_sessions WHERE id=ANY($1::text[]) ORDER BY id",
    [[f.session.id, secondSession.id]],
  )).rows;
  assert.equal(assignedRows.find((row: { id: string }) => row.id === f.session.id)?.grade_id, f.classId);
  assert.equal(assignedRows.find((row: { id: string }) => row.id === secondSession.id)?.grade_id, f.nextClassId);

  const firstPassId = await seedReturnPass(f, { studentId: f.studentId, issuedVia: "kiosk", gradeId: f.classId, classId: null });
  const secondPassId = await seedReturnPass(f, { studentId: f.nextStudentId, issuedVia: "kiosk", gradeId: f.nextClassId, classId: null });
  const firstHeaders = kioskHeaders({ ...f, session: f.session });
  const secondHeaders = kioskHeaders({ ...f, session: secondSession });
  const firstSnapshot = await (await fetch(baseUrl + "/snapshot", { headers: firstHeaders })).json() as {
    students: { id: string }[]; activePasses: { id: string }[];
  };
  const secondSnapshot = await (await fetch(baseUrl + "/snapshot", { headers: secondHeaders })).json() as {
    students: { id: string }[]; activePasses: { id: string }[];
  };
  assert.deepEqual(firstSnapshot.students.map(student => student.id), [f.studentId]);
  assert.deepEqual(secondSnapshot.students.map(student => student.id), [f.nextStudentId]);
  assert.deepEqual(firstSnapshot.activePasses.map(pass => pass.id), [firstPassId]);
  assert.deepEqual(secondSnapshot.activePasses.map(pass => pass.id), [secondPassId]);

  const firstReturnSearch = await kioskPost("/returns/lookup", firstHeaders, { search: "Second" });
  assert.deepEqual((await firstReturnSearch.json() as ReturnLookup).matches, []);
  const secondReturnSearch = await kioskPost("/returns/lookup", secondHeaders, { search: "Second" });
  assert.deepEqual((await secondReturnSearch.json() as ReturnLookup).matches.map(match => match.passId), [secondPassId]);
  const crossClassLookup = await kioskPost("/lookup", firstHeaders, { studentIdNumber: f.nextStudentId });
  assert.equal((await crossClassLookup.json() as { student: unknown }).student, null);
  const legacyClientHeaders: Record<string, string> = { ...firstHeaders };
  delete legacyClientHeaders["x-passpilot-kiosk-activity"];
  const legacyCrossClassLookup = await kioskPost("/lookup", legacyClientHeaders, { studentIdNumber: f.nextStudentId });
  assert.equal(legacyCrossClassLookup.status, 200);
  assert.equal((await legacyCrossClassLookup.json() as { student: unknown }).student, null,
    "legacy badge lookup must check class membership before exposing an active pass");

  const deniedCheckin = await kioskPost("/checkin", firstHeaders, { studentId: f.nextStudentId, passId: secondPassId });
  assert.equal(deniedCheckin.status, 400);
  assert.equal((await pool.query("SELECT status FROM passes WHERE id=$1", [secondPassId])).rows[0].status, "active");
  const allowedCheckin = await kioskPost("/checkin", firstHeaders, { studentId: f.studentId, passId: firstPassId });
  assert.equal(allowedCheckin.status, 200);

  const staffBase = baseUrl.replace(/\/kiosk$/, "/passes");
  const dashboardReturn = await fetch(staffBase + `/${secondPassId}/return`, { method: "PATCH", headers: teacherHeaders });
  assert.equal(dashboardReturn.status, 200, "teacher returns continue to work across kiosk class scopes");
});

test("snapshot/lookup/checkout contract fails closed for old clients and stale assignments; kiosk returns stay class-scoped", async () => {
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
  assert.equal(transitioned.students.some(s => s.id === f.studentId), false);
  const lookup = await fetch(baseUrl + "/lookup", { method: "POST", headers, body: JSON.stringify({ studentIdNumber: f.studentId }) });
  assert.equal(lookup.status, 200);
  assert.equal((await lookup.json() as { student: unknown }).student, null);
  const [{ id: crossClassPassId }] = (await pool.query("SELECT id FROM passes WHERE school_id=$1 AND student_id=$2 AND status='active'", [f.schoolId, f.studentId])).rows;
  const dashboardReturn = await fetch(baseUrl.replace(/\/kiosk$/, `/passes/${crossClassPassId}/return`), {
    method: "PATCH", headers: staffHeaders(f, f.teacherId),
  });
  assert.equal(dashboardReturn.status, 200, "the teacher dashboard retains cross-class return authority");
  assert.equal(await scoped(f.schoolId, () => service.returnTeacherKioskPass(f.schoolId, f.session.id, f.studentId, pinHash)), null);
  assert.equal((await pool.query("SELECT count(*)::int AS count FROM student_timeline_events WHERE school_id=$1", [f.schoolId])).rows[0].count, 2);
});

for (const source of ["legacy_grades", "classpilot_groups"] as const) test(`${source}: another teacher's unassigned kiosk can return an overdue custom pass issued by staff`, async () => {
  const f = await fixture(source);
  const passId = await seedReturnPass(f);
  const other = await scoped(f.schoolId, () => createSelfClaimedKioskSession(f.schoolId, null, { actorUserId: f.otherTeacherId, manager: false }));
  const headers: Record<string, string> = kioskHeaders({ ...f, session: other });
  delete headers["x-passpilot-class-model"];
  delete headers["x-passpilot-kiosk-activity"];
  const found = await kioskPost("/returns/lookup", headers, { search: f.studentId });
  assert.equal(found.status, 200);
  const result = await found.json() as ReturnLookup;
  assert.equal(result.hasMore, false);
  assert.deepEqual(result.matches, [{ passId, studentId: f.studentId, firstName: "First", lastName: "Student", studentIdNumber: f.studentId }]);
  assert.deepEqual(Object.keys(result.matches[0]!).sort(), ["firstName", "lastName", "passId", "studentId", "studentIdNumber"].sort());

  const badge = await kioskPost("/lookup", headers, { studentIdNumber: f.studentId });
  assert.equal(badge.status, 200);
  const badgeBody = await badge.json() as { student: { id: string; returnOnly: boolean }; activePass: { id: string } };
  assert.equal(badgeBody.student.id, f.studentId);
  assert.equal(badgeBody.student.returnOnly, true);
  assert.equal(badgeBody.activePass.id, passId);
  assert.deepEqual(Object.keys(badgeBody.activePass).sort(), ["expiresAt", "id", "issuedAt", "status", "studentId"].sort(), "universal return lookup does not reveal destination, notes, issuer or activity metadata");
  const checkoutResponse = await kioskPost("/checkout", headers, { studentId: f.nextStudentId, destination: "bathroom" });
  assert.ok(checkoutResponse.status >= 400, "a return lookup must not grant checkout authority to an unassigned kiosk");

  const returned = await kioskPost("/checkin", headers, { studentId: f.studentId, passId });
  assert.equal(returned.status, 200);
  const receipt = await returned.json() as { pass: { id: string; status: string } };
  assert.deepEqual(Object.keys(receipt.pass).sort(), ["id", "returnedAt", "status", "studentId"].sort(), "the return receipt contains no private pass details");
  const stored = (await pool.query("SELECT status,teacher_id,issued_via,grade_id,classpilot_group_id,custom_destination FROM passes WHERE id=$1", [passId])).rows[0];
  assert.equal(stored.status, "returned");
  assert.equal(stored.teacher_id, f.teacherId);
  assert.equal(stored.issued_via, "teacher");
  assert.equal(stored.grade_id, source === "legacy_grades" ? f.classId : null);
  assert.equal(stored.classpilot_group_id, source === "classpilot_groups" ? f.classId : null);
  assert.equal(stored.custom_destination, "Private destination");
  const timeline = (await pool.query("SELECT actor_user_id,metadata FROM student_timeline_events WHERE school_id=$1 AND source_id=$2", [f.schoolId, passId])).rows[0];
  assert.equal(timeline.actor_user_id, f.otherTeacherId, "the return event identifies the returning kiosk's teacher");
  assert.equal(timeline.metadata.issuedVia, "teacher", "returning at a kiosk does not rewrite how the pass was issued");
});

test("current kiosk rosters can return any issuer's pass without listing the school's other outstanding students", async () => {
  const f = await fixture();
  const [targeted] = await scoped(f.schoolId, () => retargetKioskSessionsForTeacher(f.schoolId, f.teacherId, { source: f.source, classId: f.classId }, { actorUserId: f.teacherId, manager: false }));
  assert.ok(targeted);
  const passId = await seedReturnPass(f, { teacherId: f.otherTeacherId, gradeId: f.classId });
  await seedReturnPass(f, { studentId: f.nextStudentId, teacherId: f.otherTeacherId, gradeId: f.nextClassId });
  const response = await fetch(baseUrl + "/snapshot", { headers: kioskHeaders({ ...f, session: targeted }) });
  assert.equal(response.status, 200);
  const snapshot = await response.json() as { students: { id: string; canReturn: boolean; activePass: { id: string } | null }[] };
  assert.deepEqual(snapshot.students.map(student => student.id), [f.studentId]);
  assert.equal(snapshot.students[0]?.canReturn, true);
  assert.equal(snapshot.students[0]?.activePass?.id, passId);
  const returned = await kioskPost("/checkin", kioskHeaders(f), { studentId: f.studentId, passId });
  assert.equal(returned.status, 200);
});

for (const source of ["legacy_grades", "classpilot_groups"] as const) test(`${source}: four custom sign-outs can all check in with their receiving teacher`, async () => {
  const f = await fixture(source);
  const studentIds = [f.studentId];
  for (let index = 1; index < 4; index++) {
    const studentId = randomUUID(); studentIds.push(studentId);
    await pool.query("INSERT INTO students(id,school_id,first_name,last_name,status,student_id_number) VALUES($1::text,$2,'Returning',$3,'active',$1::text)", [studentId, f.schoolId, `Student ${index}`]);
    if (source === "legacy_grades") await pool.query("INSERT INTO passpilot_grade_students(school_id,grade_id,student_id) VALUES($1,$2,$3)", [f.schoolId, f.classId, studentId]);
    else await pool.query("INSERT INTO group_students(group_id,student_id) VALUES($1,$2)", [f.classId, studentId]);
  }
  let receivingClassId: string = f.nextClassId;
  if (source === "legacy_grades") {
    await pool.query("DELETE FROM teacher_grades WHERE grade_id=$1 AND teacher_id=$2", [f.nextClassId, f.teacherId]);
    await pool.query("INSERT INTO teacher_grades(teacher_id,grade_id) VALUES($1,$2)", [f.otherTeacherId, f.nextClassId]);
    for (const studentId of studentIds) await pool.query("INSERT INTO passpilot_grade_students(school_id,grade_id,student_id) VALUES($1,$2,$3)", [f.schoolId, f.nextClassId, studentId]);
  } else {
    const receivingClass = await scoped(f.schoolId, () => createGroup({ schoolId: f.schoolId, teacherId: f.otherTeacherId, name: "Receiving teacher's class", groupType: "admin_class", status: "active" }));
    receivingClassId = receivingClass.id;
    for (const studentId of studentIds) await pool.query("INSERT INTO group_students(group_id,student_id) VALUES($1,$2)", [receivingClassId, studentId]);
  }
  const issued = [];
  for (const studentId of studentIds) {
    const passId = await seedReturnPass(f, source === "legacy_grades"
      ? { studentId, gradeId: receivingClassId }
      : { studentId, classId: receivingClassId });
    const original = (await pool.query("SELECT issued_at,custom_destination FROM passes WHERE id=$1", [passId])).rows[0];
    issued.push({ studentId, passId, issuedAt: original.issued_at.getTime(), customDestination: original.custom_destination });
  }
  const receivingSession = await scoped(f.schoolId, () => createSelfClaimedKioskSession(f.schoolId, null, { actorUserId: f.otherTeacherId, manager: false }));
  const [targeted] = await scoped(f.schoolId, () => retargetKioskSessionsForTeacher(f.schoolId, f.otherTeacherId, { source, classId: receivingClassId }, { actorUserId: f.otherTeacherId, manager: false }));
  assert.equal(targeted?.id, receivingSession.id);
  const headers = kioskHeaders({ ...f, session: receivingSession });
  const response = await fetch(baseUrl + "/snapshot", { headers });
  assert.equal(response.status, 200);
  const snapshot = await response.json() as { students: { id: string; canReturn: boolean; activePass: { id: string } | null }[] };
  for (const expected of issued) {
    const student = snapshot.students.find(row => row.id === expected.studentId);
    assert.equal(student?.canReturn, true);
    assert.equal(student?.activePass?.id, expected.passId);
    const returned = await kioskPost("/checkin", headers, { studentId: expected.studentId, passId: expected.passId });
    assert.equal(returned.status, 200, "the receiving teacher must not need the issuing teacher to return the student");
    const stored = (await pool.query("SELECT status,teacher_id,issued_at,returned_at,issued_via,grade_id,classpilot_group_id,custom_destination FROM passes WHERE id=$1", [expected.passId])).rows[0];
    assert.equal(stored.status, "returned");
    assert.equal(stored.teacher_id, f.teacherId);
    assert.equal(stored.issued_via, "teacher");
    assert.equal(stored.issued_at.getTime(), expected.issuedAt);
    assert.ok(stored.returned_at instanceof Date);
    assert.equal(stored.custom_destination, expected.customDestination);
    assert.equal(stored.grade_id, source === "legacy_grades" ? receivingClassId : null);
    assert.equal(stored.classpilot_group_id, source === "classpilot_groups" ? receivingClassId : null);
  }
});

test("return lookup is bounded, literal, active-pass-only, and isolated to its school", async () => {
  const f = await fixture(), foreign = await fixture();
  const inactivePassId = await seedReturnPass(f);
  await pool.query("UPDATE passes SET status='returned',returned_at=now() WHERE id=$1", [inactivePassId]);
  const foreignPassId = await seedReturnPass(foreign);
  const headers = kioskHeaders(f);
  assert.equal((await kioskPost("/returns/lookup", headers, { search: "F" })).status, 400);
  const noActive = await (await kioskPost("/returns/lookup", headers, { search: f.studentId })).json() as ReturnLookup;
  assert.deepEqual(noActive.matches, []);
  const foreignLookup = await (await kioskPost("/returns/lookup", headers, { search: foreign.studentId })).json() as ReturnLookup;
  assert.deepEqual(foreignLookup.matches, []);
  const foreignReturn = await kioskPost("/checkin", headers, { studentId: foreign.studentId, passId: foreignPassId });
  assert.ok(foreignReturn.status >= 400);
  assert.equal((await pool.query("SELECT status FROM passes WHERE id=$1", [foreignPassId])).rows[0].status, "active");

  for (let index = 0; index < 21; index++) {
    const studentId = randomUUID();
    await pool.query("INSERT INTO students(id,school_id,first_name,last_name,status,student_id_number) VALUES($1::text,$2,'ReturnLookup',$3,'active',$1::text)", [studentId, f.schoolId, `Student ${String(index).padStart(2, "0")}`]);
    await seedReturnPass(f, { studentId, gradeId: null });
  }
  const many = await (await kioskPost("/returns/lookup", headers, { search: "ReturnLookup" })).json() as ReturnLookup;
  assert.equal(many.matches.length, 20);
  assert.equal(many.hasMore, true);
  for (const match of many.matches) assert.deepEqual(Object.keys(match).sort(), ["firstName", "lastName", "passId", "studentId", "studentIdNumber"].sort());
  const wildcard = await (await kioskPost("/returns/lookup", headers, { search: "%%" })).json() as ReturnLookup;
  assert.deepEqual(wildcard.matches, [], "wildcards are literal student-search text, not a whole-school browse");
});

test("an explicit return selection cannot close a newly issued pass and concurrent returns write one outcome", async () => {
  const f = await fixture();
  const headers = kioskHeaders(f);
  const originalId = await seedReturnPass(f);
  assert.equal((await kioskPost("/checkin", headers, { studentId: f.studentId, passId: originalId })).status, 200);
  const replacementId = await seedReturnPass(f);
  const stale = await kioskPost("/checkin", headers, { studentId: f.studentId, passId: originalId });
  assert.ok(stale.status >= 400);
  assert.equal((await pool.query("SELECT status FROM passes WHERE id=$1", [replacementId])).rows[0].status, "active");
  const concurrent = await Promise.all([
    kioskPost("/checkin", headers, { studentId: f.studentId, passId: replacementId }),
    kioskPost("/checkin", headers, { studentId: f.studentId, passId: replacementId }),
  ]);
  assert.equal(concurrent.filter(response => response.status === 200).length, 1);
  assert.equal((await pool.query("SELECT count(*)::int AS count FROM student_timeline_events WHERE school_id=$1 AND source_id=$2", [f.schoolId, replacementId])).rows[0].count, 1);
});

test("return access still requires current kiosk credentials, a live same-school session and school entitlement", async () => {
  const f = await fixture();
  const passId = await seedReturnPass(f);
  const body = { studentId: f.studentId, passId };
  const headers = kioskHeaders(f);
  assert.ok((await kioskPost("/checkin", { ...headers, "x-kiosk-pin": "0000" }, body)).status >= 400);
  assert.ok((await kioskPost("/returns/lookup", { ...headers, "x-kiosk-pin": "0000" }, { search: "First" })).status >= 400);
  await pool.query("UPDATE schools SET kiosk_pin_hash='rotated' WHERE id=$1", [f.schoolId]);
  assert.ok((await kioskPost("/checkin", headers, body)).status >= 400);
  await pool.query("UPDATE schools SET kiosk_pin_hash=$2 WHERE id=$1", [f.schoolId, pinHash]);
  await pool.query("UPDATE passpilot_kiosk_sessions SET last_seen_at=now()-interval '21 hours' WHERE id=$1", [f.session.id]);
  assert.ok((await kioskPost("/checkin", headers, body)).status >= 400);
  await pool.query("UPDATE passpilot_kiosk_sessions SET last_seen_at=now() WHERE id=$1", [f.session.id]);
  await pool.query("UPDATE schools SET kiosk_enabled=false WHERE id=$1", [f.schoolId]);
  assert.ok((await kioskPost("/checkin", headers, body)).status >= 400);
  await pool.query("UPDATE schools SET kiosk_enabled=true WHERE id=$1", [f.schoolId]);
  await pool.query("UPDATE product_licenses SET status='inactive' WHERE school_id=$1 AND product='PASSPILOT'", [f.schoolId]);
  assert.ok((await kioskPost("/checkin", headers, body)).status >= 400);
  assert.equal((await pool.query("SELECT status,returned_at FROM passes WHERE id=$1", [passId])).rows[0].status, "active");
  assert.equal((await pool.query("SELECT returned_at FROM passes WHERE id=$1", [passId])).rows[0].returned_at, null);
});

test("teachers can locate and return another teacher's active pass without acquiring pass history or cancel authority", async () => {
  const f = await fixture();
  const passId = await seedReturnPass(f);
  const headers = staffHeaders(f);
  const staffBase = baseUrl.replace(/\/kiosk$/, "/passes");
  const lookup = await fetch(staffBase + "/returns/lookup", { method: "POST", headers, body: JSON.stringify({ search: "First" }) });
  assert.equal(lookup.status, 200);
  const found = await lookup.json() as ReturnLookup;
  assert.deepEqual(found.matches.map(match => match.passId), [passId]);
  assert.deepEqual(Object.keys(found.matches[0]!).sort(), ["firstName", "lastName", "passId", "studentId", "studentIdNumber"].sort());
  assert.equal((await fetch(staffBase + `/${passId}/cancel`, { method: "PATCH", headers })).status, 404);
  const [otherTeacher] = await db.select().from(users).where(eq(users.id, f.otherTeacherId));
  const [pass] = await scoped(f.schoolId, () => db.select().from(passes).where(eq(passes.id, passId)));
  assert.ok(pass);
  assert.equal(await scoped(f.schoolId, () => canAccessPass(otherTeacher!, f.schoolId, pass, "teacher")), false);
  assert.deepEqual(await scoped(f.schoolId, () => filterPassesForRole([pass], otherTeacher!, f.schoolId, "teacher")), []);
  const response = await fetch(staffBase + `/${passId}/return`, { method: "PATCH", headers });
  assert.equal(response.status, 200);
  const returned = await response.json() as { pass: { id: string; status: string } };
  assert.equal(returned.pass.id, passId);
  assert.equal(returned.pass.status, "returned");
  assert.deepEqual(Object.keys(returned.pass).sort(), ["id", "returnedAt", "status", "studentId"].sort(), "return permission does not reveal private pass details");
  const secondId = await seedReturnPass(f);
  const alias = await fetch(staffBase + `/${secondId}/return`, { method: "PUT", headers });
  assert.equal(alias.status, 200);
  const foreign = await fixture();
  const protectedId = await seedReturnPass(f);
  assert.equal((await fetch(staffBase + `/${protectedId}/return`, { method: "PATCH", headers: staffHeaders(foreign) })).status, 404);
  assert.equal((await pool.query("SELECT status FROM passes WHERE id=$1", [protectedId])).rows[0].status, "active");
});

test("ClassPilot classes resolve without sessions or devices, follow co-teachers, calendar and skipped occurrences", async () => {
  const f = await fixture("classpilot_groups"); await save(f);
  assert.equal((await resolve(f)).current?.classId, f.classId);
  assert.deepEqual((await resolve(f)).roster.map(s => s.id), [f.studentId]);
  assert.equal((await pool.query("SELECT count(*)::int AS count FROM teaching_sessions WHERE school_id=$1", [f.schoolId])).rows[0].count, 0);
  await pool.query("INSERT INTO group_teachers(group_id,teacher_id,role) VALUES($1,$2,'co-teacher')", [f.classId, f.otherTeacherId]);
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

for (const source of ["legacy_grades", "classpilot_groups"] as const) test(`${source}: testing passes retain activity snapshots, restrict history, and return during schedule failure`, async (context) => {
  // Issuance needs an active window; 23:59 is the exclusive end of this fixture.
  const now = new Date(); now.setUTCHours(13, 30, 0, 0);
  context.mock.timers.enable({ apis: ["Date"], now });
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
  const otherSession = await scoped(f.schoolId, () => createSelfClaimedKioskSession(f.schoolId, null, { actorUserId: f.otherTeacherId, manager: false }));
  const returningHeaders = kioskHeaders({ ...f, session: otherSession });
  const lookup = await kioskPost("/returns/lookup", returningHeaders, { search: f.studentId });
  assert.equal(lookup.status, 200);
  assert.deepEqual((await lookup.json() as ReturnLookup).matches.map(match => match.passId), [pass.id]);
  const returned = await kioskPost("/checkin", returningHeaders, { studentId: f.studentId, passId: pass.id });
  assert.equal(returned.status, 200);
  const originalAttribution = (await pool.query("SELECT supervision_context_id,activity_kind,activity_name_snapshot,issuing_kiosk_session_id,teacher_id FROM passes WHERE id=$1", [pass.id])).rows[0];
  assert.equal(originalAttribution.supervision_context_id, t.contextId);
  assert.equal(originalAttribution.activity_kind, "testing");
  assert.equal(originalAttribution.activity_name_snapshot, "MAP testing");
  assert.equal(originalAttribution.issuing_kiosk_session_id, f.session.id);
  assert.equal(originalAttribution.teacher_id, f.teacherId);
  assert.equal(await scoped(f.schoolId, () => canAccessPass(otherTeacher!, f.schoolId, pass, "teacher")), false, "return authority does not grant testing pass history");
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
  // Use the unassigned actor for office-only authority; the original teacher
  // still owns grades and active kiosks and cannot lose that role implicitly.
  await pool.query("UPDATE school_memberships SET role='office_staff' WHERE school_id=$1 AND user_id=$2", [f.schoolId, f.otherTeacherId]);
  const officeHeaders = { ...headers, authorization: `Bearer ${signUserToken({ userId: f.otherTeacherId, email: `${f.otherTeacherId}@example.test`, isSuperAdmin: false })}` };
  assert.equal((await fetch(baseUrl + "/preferences", { headers: officeHeaders })).status, 403);
});

test("a checkout waiting for a supervision release or roster edit cannot issue from its displayed revision", async (context) => {
  const now = new Date(); now.setUTCHours(13, 30, 0, 0);
  context.mock.timers.enable({ apis: ["Date"], now });
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
  await pool.query("INSERT INTO group_teachers(group_id,teacher_id,role) VALUES($1,$2,'co-teacher')", [f.classId, f.otherTeacherId]);
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
