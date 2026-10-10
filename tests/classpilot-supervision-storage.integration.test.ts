import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { sql } from "drizzle-orm";

let pool: typeof import("../src/db.js").pool;
let database: typeof import("../src/db.js").default;
let tenant: typeof import("../src/middleware/tenantContext.js").runWithTenantContext;
let storage: typeof import("../src/services/storage.js");
let buildCoverage: typeof import("../src/services/classpilotScheduledStart.js").buildScheduledCoveragePayload;
const schoolIds: string[] = [], userIds: string[] = [], pupilIds: string[] = [];
const scoped = <T>(schoolId: string, fn: () => Promise<T>) => tenant({ schoolId }, fn);
const statement = (schoolId: string, query: ReturnType<typeof sql>) => scoped(schoolId, () => database.execute(query));
const matchesCode = (code: string) => (error: unknown): boolean => !!error && typeof error === "object"
  && (("code" in error && error.code === code) || ("cause" in error && matchesCode(code)(error.cause)));

before(async () => {
  assert.ok(["localhost", "127.0.0.1", "::1"].includes(new URL(process.env.DATABASE_URL || "").hostname),
    "Supervision storage regressions require a local fixture database");
  process.env.REDIS_URL = "";
  delete process.env.CLASSPILOT_SUPERVISION_REPORTS_CAPTURE_FROM;
  ({ pool, default: database } = await import("../src/db.js"));
  ({ runWithTenantContext: tenant } = await import("../src/middleware/tenantContext.js"));
  storage = await import("../src/services/storage.js");
  ({ buildScheduledCoveragePayload: buildCoverage } = await import("../src/services/classpilotScheduledStart.js"));
});

after(async () => {
  if (!pool) return;
  try {
    if (schoolIds.length) await tenant({ isSuper: true }, async () => {
      const schoolList = sql.join(schoolIds.map(schoolId => sql`${schoolId}`), sql`, `);
      for (const table of ["classpilot_lesson_progress", "classpilot_tool_history", "classpilot_timers", "classpilot_lesson_activities",
        "classpilot_questions", "classpilot_picker_rounds", "classpilot_routine_runs", "poll_responses", "polls",
        "classpilot_chat_deliveries", "chat_messages", "classpilot_active_hands", "session_settings", "classpilot_classroom_states",
        "classpilot_command_targets", "classpilot_commands", "classpilot_student_control_states", "classpilot_supervision_students",
        "classpilot_supervision_contexts", "classpilot_session_staff", "classpilot_session_students", "teaching_sessions",
        "classpilot_scheduled_conflicts", "devices", "students", "settings"]) {
        if (table === "devices" && pupilIds.length) await database.execute(sql`DELETE FROM student_sessions WHERE student_id IN (${sql.join(pupilIds.map(studentId => sql`${studentId}`), sql`, `)})`);
        await database.execute(sql`DELETE FROM ${sql.identifier(table)} WHERE school_id IN (${schoolList})`);
      }
      await database.execute(sql`DELETE FROM group_students WHERE group_id IN (SELECT id FROM groups WHERE school_id IN (${schoolList}))`);
      await database.execute(sql`DELETE FROM groups WHERE school_id IN (${schoolList})`);
    });
    await pool.query("DELETE FROM product_licenses WHERE school_id=ANY($1::text[])", [schoolIds]);
    await pool.query("DELETE FROM school_memberships WHERE school_id=ANY($1::text[])", [schoolIds]);
    await pool.query("DELETE FROM schools WHERE id=ANY($1::text[])", [schoolIds]);
    await pool.query("DELETE FROM users WHERE id=ANY($1::text[])", [userIds]);
  } finally {
    await (await import("../src/services/errorMonitor.js")).default.disposeAndWait();
    const dbModule = await import("../src/db.js"), scheduler = await import("../src/services/schedulerDb.js");
    await Promise.all([pool.end(), dbModule.sessionPool.end(), scheduler.schedulerPool.end(), scheduler.schedulerLockPool.end()]);
  }
});

async function fixture() {
  const schoolId = randomUUID(), teacherId = randomUUID(), receiverId = randomUUID(), adminId = randomUUID();
  const studentIds = [randomUUID(), randomUUID(), randomUUID()];
  schoolIds.push(schoolId); userIds.push(teacherId, receiverId, adminId); pupilIds.push(...studentIds);
  await pool.query("INSERT INTO schools(id,name,status,is_active,plan_status) VALUES($1,'Supervision lifecycle','active',true,'active')", [schoolId]);
  await pool.query("INSERT INTO product_licenses(school_id,product,status) VALUES($1,'CLASSPILOT','active')", [schoolId]);
  for (const [id, role] of [[teacherId, "teacher"], [receiverId, "teacher"], [adminId, "admin"]]) {
    await pool.query("INSERT INTO users(id,email,first_name,last_name) VALUES($1,$2,'Lifecycle','Staff')", [id, `${id}@example.test`]);
    await pool.query("INSERT INTO school_memberships(school_id,user_id,role,status) VALUES($1,$2,$3,'active')", [schoolId, id, role]);
  }
  for (const [index, studentId] of studentIds.entries()) {
    await statement(schoolId, sql`INSERT INTO students(id,school_id,first_name,last_name,status,grade_level)
      VALUES(${studentId},${schoolId},'Lifecycle','Student','active',${String(index + 3)})`);
    await statement(schoolId, sql`INSERT INTO devices(device_id,school_id,class_id) VALUES(${studentId},${schoolId},'default')`);
    await statement(schoolId, sql`INSERT INTO student_sessions(student_id,device_id,auth_kind) VALUES(${studentId},${studentId},'managed_profile')`);
  }
  return { schoolId, teacherId, receiverId, adminId, studentIds };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

async function teaching(data: Fixture, options: { studentIds?: string[]; report?: boolean; start?: Date; end?: Date } = {}) {
  const groupId = randomUUID(), sessionId = randomUUID(), conflictId = randomUUID();
  const start = options.start ?? new Date(Date.now() - 60_000), end = options.end ?? new Date(Date.now() + 30 * 60_000);
  const date = start.toISOString().slice(0, 10), roster = options.studentIds ?? data.studentIds;
  await statement(data.schoolId, sql`INSERT INTO groups(id,school_id,teacher_id,name,status)
    VALUES(${groupId},${data.schoolId},${options.report ? data.receiverId : data.teacherId},'Frozen class','active')`);
  await statement(data.schoolId, sql`INSERT INTO teaching_sessions(id,school_id,group_id,teacher_id,start_time,session_mode,
    scheduled_conflict_id,scheduled_date,scheduled_timezone,scheduled_start_at,scheduled_end_at,scheduled_state,roster_snapshot_completed_at)
    VALUES(${sessionId},${data.schoolId},${groupId},${options.report ? data.receiverId : data.teacherId},${start.toISOString()},
      ${options.report ? "scheduled_report" : "live"},${options.report ? conflictId : null},${date},'UTC',${start.toISOString()},${end.toISOString()},'active',${start.toISOString()})`);
  for (const studentId of roster) {
    await statement(data.schoolId, sql`INSERT INTO classpilot_session_students(school_id,teaching_session_id,group_id,student_id)
      VALUES(${data.schoolId},${sessionId},${groupId},${studentId})`);
  }
  if (options.report) await statement(data.schoolId, sql`INSERT INTO classpilot_scheduled_conflicts(id,school_id,group_id,teacher_id,scheduled_date,block_start_time,status)
    VALUES(${conflictId},${data.schoolId},${groupId},${data.receiverId},${date},'08:00','coverage_needed')`);
  const group = await scoped(data.schoolId, () => storage.getGroupByIdAndSchool(groupId, data.schoolId));
  assert.ok(group);
  return { group, sessionId, conflictId, date, start, end };
}

const createContext = (data: Fixture, studentIds: string[], options: { type?: string; staffId?: string; end?: Date; conflictId?: string } = {}) => scoped(data.schoolId,
  () => storage.createSupervisionContextWithStudents({ context: { schoolId: data.schoolId, contextType: options.type ?? "other",
    name: "Temporary supervision", assignedStaffId: options.staffId ?? data.teacherId, createdBy: data.teacherId,
    startsAt: new Date(Date.now() - 60_000), endsAt: options.end ?? new Date(Date.now() + 60 * 60_000),
    scheduledConflictId: options.conflictId }, studentIds, assignedBy: data.teacherId }));

test("disconnected current class owners stay unavailable while ended scheduled owners become claimable", async () => {
  const data = await fixture();
  const owner = await teaching(data, { studentIds: [data.studentIds[0]!] });
  const target = await teaching(data, { report: true });
  const payload = () => scoped(data.schoolId, () => buildCoverage({ group: target.group,
    scheduledDate: target.date, scheduledConflictId: target.conflictId, connectedTeacherIdsOverride: new Set(), now: new Date() }));
  const before = await payload();
  assert.equal(before.monitoredCount, 1);
  assert.equal(before.monitoredGroups[0]?.sessionId, owner.sessionId);
  assert.equal(before.claimableStudents.some(row => row.studentId === data.studentIds[0]), false);
  await assert.rejects(scoped(data.schoolId, () => storage.claimScheduledCoverageStudents({ schoolId: data.schoolId,
    scheduledConflictId: target.conflictId, className: target.group.name, actorId: data.adminId, assignedStaffId: data.adminId,
    studentIds: [data.studentIds[0]!], endsAt: new Date(Date.now() + 4 * 60 * 60_000) })), matchesCode("SCHEDULED_COVERAGE_STUDENT_UNAVAILABLE"));
  await statement(data.schoolId, sql`UPDATE teaching_sessions SET scheduled_end_at=${new Date(Date.now() - 1_000).toISOString()} WHERE id=${owner.sessionId}`);
  assert.equal((await payload()).claimableCount, 3);
  const claimed = await scoped(data.schoolId, () => storage.claimScheduledCoverageStudents({ schoolId: data.schoolId,
    scheduledConflictId: target.conflictId, className: target.group.name, actorId: data.adminId, assignedStaffId: data.adminId,
    studentIds: [data.studentIds[0]!], endsAt: new Date(Date.now() + 4 * 60 * 60_000) }));
  assert.equal(claimed.context.endsAt.getTime(), target.end.getTime());
});

test("scheduled claims reuse the frozen deadline and reject a still-active row after its bell", async () => {
  const data = await fixture(), target = await teaching(data, { report: true });
  const claim = (studentId: string, endsAt: Date) => scoped(data.schoolId, () => storage.claimScheduledCoverageStudents({
    schoolId: data.schoolId, scheduledConflictId: target.conflictId, className: target.group.name, actorId: data.adminId,
    assignedStaffId: data.adminId, studentIds: [studentId], endsAt }));
  const first = await claim(data.studentIds[0]!, new Date(Date.now() + 8 * 60 * 60_000));
  const added = await claim(data.studentIds[1]!, new Date(Date.now() + 10 * 60 * 60_000));
  assert.equal(added.context.id, first.context.id);
  assert.equal(added.context.endsAt.getTime(), target.end.getTime());
  await statement(data.schoolId, sql`UPDATE teaching_sessions SET scheduled_end_at=${new Date(Date.now() - 1_000).toISOString()} WHERE id=${target.sessionId}`);
  await assert.rejects(claim(data.studentIds[2]!, new Date(Date.now() + 10 * 60 * 60_000)), matchesCode("SCHEDULED_CONFLICT_EXPIRED"));
  assert.equal(await scoped(data.schoolId, () => storage.getActiveSupervisionForStudent(data.schoolId, data.studentIds[2]!)), undefined);
});

test("a legacy expired scheduled context is ended before a fresh claim within the same open block", async () => {
  const data = await fixture(), target = await teaching(data, { report: true });
  const previous = await createContext(data, [data.studentIds[0]!], { staffId: data.adminId, conflictId: target.conflictId });
  await statement(data.schoolId, sql`UPDATE classpilot_supervision_contexts SET ends_at=${new Date(Date.now() - 1_000).toISOString()} WHERE id=${previous.id}`);
  const fresh = await scoped(data.schoolId, () => storage.claimScheduledCoverageStudents({ schoolId: data.schoolId,
    scheduledConflictId: target.conflictId, className: target.group.name, actorId: data.adminId, assignedStaffId: data.adminId,
    studentIds: [data.studentIds[0]!], endsAt: target.end }));
  assert.notEqual(fresh.context.id, previous.id);
  assert.equal((await scoped(data.schoolId, () => storage.getSupervisionContextByIdAndSchool(data.schoolId, previous.id)))?.status, "ended");
  assert.equal((await scoped(data.schoolId, () => storage.getClasspilotStudentControlState(data.schoolId, data.studentIds[0]!)))?.supervisionContextId, fresh.context.id);
});

test("reassignment ends only emptied source contexts, retains history, and never restores transferred controls", async () => {
  const data = await fixture();
  const source = await createContext(data, data.studentIds.slice(0, 2));
  const destination = await createContext(data, [], { staffId: data.receiverId });
  const questionId = randomUUID();
  await statement(data.schoolId, sql`INSERT INTO classpilot_questions(id,school_id,supervision_context_id,student_id,client_request_id,question)
    VALUES(${questionId},${data.schoolId},${source.id},${data.studentIds[0]!},${randomUUID()},'Help with this work')`);
  await scoped(data.schoolId, () => storage.assignStudentsToSupervisionContext({ schoolId: data.schoolId, contextId: destination.id,
    studentIds: [data.studentIds[0]!], assignedBy: data.teacherId }));
  assert.equal((await scoped(data.schoolId, () => storage.getSupervisionContextByIdAndSchool(data.schoolId, source.id)))?.status, "active");
  await scoped(data.schoolId, () => storage.assignStudentsToSupervisionContext({ schoolId: data.schoolId, contextId: destination.id,
    studentIds: [data.studentIds[1]!], assignedBy: data.teacherId }));
  const ended = await scoped(data.schoolId, () => storage.getSupervisionContextByIdAndSchool(data.schoolId, source.id));
  assert.equal(ended?.status, "ended"); assert.ok(ended?.endedAt);
  const history = await scoped(data.schoolId, () => storage.listSupervisionStudentsForContexts(data.schoolId, [source.id], { activeOnly: false }));
  assert.equal(history.length, 2); assert.ok(history.every(row => row.releasedAt && row.releaseReason === "reassigned"));
  assert.ok((await statement(data.schoolId, sql`SELECT ended_at FROM classpilot_questions WHERE id=${questionId}`)).rows[0]?.ended_at);
  for (const studentId of data.studentIds.slice(0, 2)) {
    assert.equal((await scoped(data.schoolId, () => storage.getClasspilotStudentControlState(data.schoolId, studentId)))?.supervisionContextId, destination.id);
  }
  await scoped(data.schoolId, () => storage.releaseSupervisionStudents({ schoolId: data.schoolId, contextId: source.id }));
  assert.equal((await scoped(data.schoolId, () => storage.getClasspilotStudentControlState(data.schoolId, data.studentIds[0]!)))?.supervisionContextId, destination.id);
  const replacement = await createContext(data, data.studentIds.slice(0, 2));
  assert.equal((await scoped(data.schoolId, () => storage.getSupervisionContextByIdAndSchool(data.schoolId, destination.id)))?.status, "ended");
  await scoped(data.schoolId, () => storage.releaseSupervisionStudents({ schoolId: data.schoolId, contextId: destination.id }));
  assert.equal((await scoped(data.schoolId, () => storage.getClasspilotStudentControlState(data.schoolId, data.studentIds[0]!)))?.supervisionContextId, replacement.id);
});

test("release never restores a finalized-by-clock class or a future class", async () => {
  const data = await fixture(), now = Date.now();
  await teaching(data, { studentIds: [data.studentIds[0]!], start: new Date(now - 10 * 60_000), end: new Date(now - 5 * 60_000) });
  await teaching(data, { studentIds: [data.studentIds[1]!], start: new Date(now + 10 * 60_000), end: new Date(now + 20 * 60_000) });
  const context = await createContext(data, data.studentIds.slice(0, 2));
  await scoped(data.schoolId, () => storage.releaseSupervisionStudents({ schoolId: data.schoolId, contextId: context.id }));
  for (const studentId of data.studentIds.slice(0, 2)) {
    const control = await scoped(data.schoolId, () => storage.getClasspilotStudentControlState(data.schoolId, studentId));
    assert.equal(control?.teachingSessionId, null); assert.equal(control?.supervisionContextId, null);
  }
});

test("room release and legacy reroute deny a foreign holder even for an administrator", async () => {
  const data = await fixture();
  const room = await createContext(data, [data.studentIds[0]!], { type: "temporary_room" });
  const destination = await createContext(data, [], { staffId: data.receiverId });
  await assert.rejects(scoped(data.schoolId, () => storage.releaseSupervisionStudents({ schoolId: data.schoolId, contextId: room.id,
    roomOwnershipAuthority: { actorId: data.adminId } })), matchesCode("TEMPORARY_ROOM_OWNER_REQUIRED"));
  await assert.rejects(scoped(data.schoolId, () => storage.assignStudentsToSupervisionContext({ schoolId: data.schoolId,
    contextId: destination.id, studentIds: [data.studentIds[0]!], assignedBy: data.adminId,
    roomOwnershipAuthority: { actorId: data.adminId } })), matchesCode("TEMPORARY_ROOM_OWNER_REQUIRED"));
  await assert.rejects(scoped(data.schoolId, () => storage.extendSupervisionContext({ schoolId: data.schoolId,
    contextId: room.id, endsAt: new Date(Date.now() + 2 * 60 * 60_000), roomOwnershipAuthority: { actorId: data.adminId } })), matchesCode("TEMPORARY_ROOM_OWNER_REQUIRED"));
  await assert.rejects(scoped(data.schoolId, () => storage.extendSupervisionContext({ schoolId: data.schoolId,
    contextId: room.id, assignedStaffId: data.receiverId, roomOwnershipAuthority: { actorId: data.teacherId } })), matchesCode("TEMPORARY_ROOM_OWNER_REQUIRED"));
  assert.equal((await scoped(data.schoolId, () => storage.getActiveSupervisionForStudent(data.schoolId, data.studentIds[0]!)))?.context.id, room.id);
  const receipt = await scoped(data.schoolId, () => storage.releaseSupervisionStudents({ schoolId: data.schoolId, contextId: room.id,
    roomOwnershipAuthority: { actorId: data.teacherId } }));
  assert.equal(receipt.length, 1);
});

test("reviewed room sends permit the recipient destination and never mutate a foreign school's context", async () => {
  const data = await fixture(), foreign = await fixture();
  const room = await createContext(data, [data.studentIds[0]!], { type: "temporary_room" });
  const recipient = await createContext(data, [], { type: "temporary_room", staffId: data.receiverId });
  const foreignRoom = await createContext(foreign, [foreign.studentIds[0]!], { type: "temporary_room" });
  await scoped(data.schoolId, () => storage.assignStudentsToSupervisionContext({ schoolId: data.schoolId, contextId: recipient.id,
    studentIds: [data.studentIds[0]!], assignedBy: data.teacherId,
    roomOwnershipAuthority: { actorId: data.teacherId, allowDestinationRoom: true } }));
  assert.equal((await scoped(data.schoolId, () => storage.getSupervisionContextByIdAndSchool(data.schoolId, room.id)))?.status, "ended");
  await assert.rejects(scoped(data.schoolId, () => storage.assignStudentsToSupervisionContext({ schoolId: data.schoolId, contextId: foreignRoom.id,
    studentIds: [data.studentIds[0]!], assignedBy: data.teacherId,
    roomOwnershipAuthority: { actorId: data.teacherId, allowDestinationRoom: true } })));
  assert.equal((await scoped(foreign.schoolId, () => storage.getActiveSupervisionForStudent(foreign.schoolId, foreign.studentIds[0]!)))?.context.id, foreignRoom.id);
  assert.equal((await scoped(data.schoolId, () => storage.getActiveSupervisionForStudent(data.schoolId, data.studentIds[0]!)))?.context.id, recipient.id);
});

test("expired room history cannot block a fresh authorized room before the cleanup worker runs", async () => {
  const data = await fixture();
  const previous = await createContext(data, [data.studentIds[0]!], { type: "temporary_room" });
  await statement(data.schoolId, sql`UPDATE classpilot_supervision_contexts SET ends_at=${new Date(Date.now() - 1_000).toISOString()} WHERE id=${previous.id}`);
  const current = await scoped(data.schoolId, () => storage.createSupervisionContextWithStudents({ context: {
    schoolId: data.schoolId, contextType: "temporary_room", name: "New authorized room", assignedStaffId: data.adminId,
    createdBy: data.adminId, endsAt: new Date(Date.now() + 30 * 60_000) }, studentIds: [data.studentIds[0]!], assignedBy: data.adminId,
    roomOwnershipAuthority: { actorId: data.adminId } }));
  assert.equal((await scoped(data.schoolId, () => storage.getSupervisionContextByIdAndSchool(data.schoolId, previous.id)))?.status, "ended");
  assert.equal((await scoped(data.schoolId, () => storage.getClasspilotStudentControlState(data.schoolId, data.studentIds[0]!)))?.supervisionContextId, current.id);
});
