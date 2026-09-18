import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { CLASSPILOT_CHAT_CHANNEL_CONTROL_SQL } from "../src/db/classpilotChatChannelControlMigration.js";

process.env.REDIS_URL = "";
process.env.CLASSPILOT_SCHEDULED_CLASSROOM_MODE = "on";
delete process.env.CLASSPILOT_SCHEDULED_CLASSROOM_SCHOOL_IDS;
delete process.env.CLASSPILOT_SCHEDULED_CLASSROOM_EXCLUDED_SCHOOL_IDS;

const ids = { school: randomUUID(), teacher: randomUUID(), student: randomUUID(), device: randomUUID(), group: randomUUID(), session: randomUUID() };
let database: typeof import("../src/db.js").default;
let pool: typeof import("../src/db.js").pool;
let storage: typeof import("../src/services/storage.js");
let tools: typeof import("../src/services/classpilotScheduledClassroomTools.js");
let fab: typeof import("../src/services/classpilotFab.js");
let tenant: typeof import("../src/middleware/tenantContext.js").runWithTenantContext;
let context: import("../src/schema/classpilot.js").ClasspilotSupervisionContext;
let bindingId: string;
const inSchool = <T>(fn: () => Promise<T>) => tenant({ schoolId: ids.school }, fn);
const statement = (query: ReturnType<typeof sql>) => inSchool(() => database.execute(query));
const control = () => inSchool(() => storage.getClasspilotStudentControlState(ids.school, ids.student));
const action = async () => ({ schoolId: ids.school, supervisionContextId: context.id, studentId: ids.student,
  studentSessionId: bindingId, deviceId: ids.device, studentControlRevision: (await control())!.revision });
const rejection = (code: string, pauseReason?: string) => (error: unknown): boolean => {
  if (!error || typeof error !== "object") return false;
  if ("code" in error && error.code === code) {
    return pauseReason === undefined || ("pauseReason" in error && error.pauseReason === pauseReason);
  }
  return "cause" in error && rejection(code, pauseReason)(error.cause);
};
const send = async (content: string) => inSchool(async () => tools.createScheduledStudentMessage({ ...(await action()), content, clientMessageId: randomUUID() }));
const studentFab = () => inSchool(() => fab.buildStudentFabState(ids.school, ids.student, { acceptedCapabilities: ["scheduledClassroomV1"] }));

before(async () => {
  assert.ok(["localhost", "127.0.0.1", "::1"].includes(new URL(process.env.DATABASE_URL || "").hostname), "Chat channel control requires the local fixture");
  process.env.DATABASE_URL_PRIVILEGED = process.env.DATABASE_URL;
  ({ default: database, pool } = await import("../src/db.js"));
  ({ runWithTenantContext: tenant } = await import("../src/middleware/tenantContext.js"));
  storage = await import("../src/services/storage.js");
  tools = await import("../src/services/classpilotScheduledClassroomTools.js");
  fab = await import("../src/services/classpilotFab.js");
  await pool.query(CLASSPILOT_CHAT_CHANNEL_CONTROL_SQL);
  await pool.query("INSERT INTO schools(id,name,domain,status,plan_status) VALUES($1,'Chat control',$2,'active','active')", [ids.school, `${ids.school}.example.edu`]);
  await pool.query("INSERT INTO users(id,email,first_name,last_name) VALUES($1,$2,'Chat','Teacher')", [ids.teacher, `${ids.teacher}@${ids.school}.example.edu`]);
  await pool.query("INSERT INTO school_memberships(school_id,user_id,role,status) VALUES($1,$2,'teacher','active')", [ids.school, ids.teacher]);
  await pool.query("INSERT INTO product_licenses(school_id,product,status) VALUES($1,'CLASSPILOT','active')", [ids.school]);
  await statement(sql`INSERT INTO settings(school_id,school_name,ws_shared_key,enable_tracking_hours,after_hours_mode) VALUES(${ids.school},'Chat control','test-only',false,'off')`);
  await statement(sql`INSERT INTO students(id,school_id,first_name,last_name,status) VALUES(${ids.student},${ids.school},'Test','Student','active')`);
  await inSchool(async () => {
    await storage.createDevice({ schoolId: ids.school, deviceId: ids.device, classId: "default", deviceName: "Test Chromebook" });
    bindingId = (await storage.startStudentSessionWithReplacements(ids.school, ids.student, ids.device,
      { authKind: "manual_shared", sessionRecoveryTokenHash: "c".repeat(64) })).session.id;
    context = await storage.createSupervisionContextWithStudents({ context: { schoolId: ids.school, name: "Scheduled testing",
      contextType: "coverage_group", assignedStaffId: ids.teacher, createdBy: ids.teacher, startsAt: new Date(Date.now() - 60_000),
      endsAt: new Date(Date.now() + 3_600_000), scheduleProfileApplicationId: randomUUID(), scheduleProfileBlockId: randomUUID(),
      scheduleProfileDate: new Date().toISOString().slice(0, 10) }, studentIds: [ids.student], assignedBy: ids.teacher });
  });
  const { writeClasspilotRealtimeStatus, setClasspilotRealtimeStatusCommandForTests } = await import("../src/services/classpilotRealtimeStatus.js");
  const shared = new Map<string, string>();
  setClasspilotRealtimeStatusCommandForTests(async (args) => {
    if (args[0] === "MGET") return args.slice(1).map((key) => shared.get(key) ?? null);
    if (args[0] === "EVAL" && args[3] && args[5]?.startsWith("{")) { shared.set(args[3], args[5]); return args[5]; }
    return undefined;
  });
  await writeClasspilotRealtimeStatus({ schoolId: ids.school, studentId: ids.student, studentSessionId: bindingId, deviceId: ids.device,
    heartbeatId: randomUUID(), observedAt: Date.now(), acceptedCapabilities: ["scopedAuthorityChecksV1", "scheduledClassroomV1"] });
});

after(async () => {
  if (!pool) return;
  await tenant({ isSuper: true }, async () => {
    for (const table of ["classpilot_chat_deliveries", "chat_messages", "classpilot_active_hands", "session_settings",
      "classpilot_session_students", "classpilot_session_staff", "teaching_sessions", "group_students", "groups",
      "classpilot_classroom_states", "classpilot_command_targets", "classpilot_commands", "classpilot_student_control_states",
      "classpilot_supervision_students", "classpilot_supervision_contexts", "student_sessions", "devices", "students", "settings"]) {
      if (table === "student_sessions") await database.execute(sql`DELETE FROM student_sessions WHERE student_id=${ids.student}`);
      else if (table === "group_students") await database.execute(sql`DELETE FROM group_students WHERE group_id=${ids.group}`);
      else await database.execute(sql`DELETE FROM ${sql.identifier(table)} WHERE school_id=${ids.school}`);
    }
  });
  await pool.query("DELETE FROM product_licenses WHERE school_id=$1", [ids.school]);
  await pool.query("DELETE FROM school_memberships WHERE school_id=$1", [ids.school]);
  await pool.query("DELETE FROM schools WHERE id=$1", [ids.school]);
  await pool.query("DELETE FROM users WHERE id=$1", [ids.teacher]);
  await (await import("../src/services/errorMonitor.js")).default.disposeAndWait();
  (await import("../src/services/classpilotRealtimeStatus.js")).setClasspilotRealtimeStatusCommandForTests(undefined);
  const scheduler = await import("../src/services/schedulerDb.js");
  await Promise.all([pool.end(), (await import("../src/db.js")).sessionPool.end(), scheduler.schedulerPool.end(), scheduler.schedulerLockPool.end()]);
});

test("a scheduled testing block pauses student chat by default, keeps the teacher's voice, and the school can opt out", async () => {
  await assert.rejects(send("can we go gym still?"), rejection("CHAT_PAUSED", "testing"));
  let state = await studentFab();
  assert.equal(state.supervisionContextId, context.id);
  assert.equal(state.messagingEnabled, false);
  assert.equal(state.messagesPaused, true);
  assert.equal(state.pauseReason, "testing");
  const reply = await inSchool(() => tools.createScheduledTeacherReply({ schoolId: ids.school, contextId: context.id,
    actorId: ids.teacher, studentId: ids.student, content: "Eyes on your own test" }));
  assert.equal(reply.message.senderType, "teacher", "a paused class can still hear its teacher");
  assert.deepEqual(await inSchool(() => tools.activeScheduledTestingStudentIds(ids.school)), [ids.student]);

  await statement(sql`UPDATE settings SET pause_chat_during_testing=false WHERE school_id=${ids.school}`);
  const sent = await send("done with section one");
  assert.equal(sent.created, true);
  assert.equal(sent.message.supervisionContextId, context.id);
  state = await studentFab();
  assert.equal(state.messagingEnabled, true);
  assert.equal(state.messagesPaused, false);
  assert.equal(state.pauseReason, null);
});

test("a teacher pause on the testing block is a revisioned soft state and the hard switch still wins", async () => {
  const current = (await inSchool(() => tools.scheduledClassroomToggles(ids.school, context))).lifecycleRevision;
  const paused = await inSchool(() => tools.updateScheduledClassroomSettings({ schoolId: ids.school, contextId: context.id,
    actorId: ids.teacher, expectedRevision: current, chatPaused: true }));
  assert.equal(paused.chatPaused, true);
  assert.equal(paused.chatEnabled, true);
  assert.equal(paused.lifecycleRevision, current + 1);
  await assert.rejects(send("hello?"), rejection("CHAT_PAUSED", "teacher"));
  const toggles = await inSchool(() => tools.scheduledClassroomToggles(ids.school, context));
  assert.equal(toggles.messagingChannelEnabled, true);
  assert.equal(toggles.messagingEnabled, false);
  assert.deepEqual([toggles.messagesPaused, toggles.pauseReason], [true, "teacher"]);
  assert.deepEqual([(await studentFab()).messagesPaused, (await studentFab()).pauseReason], [true, "teacher"]);
  await assert.rejects(inSchool(() => tools.updateScheduledClassroomSettings({ schoolId: ids.school, contextId: context.id,
    actorId: ids.teacher, expectedRevision: current, chatPaused: false })), rejection("SETTINGS_REVISION_CONFLICT"));

  const disabled = await inSchool(() => tools.updateScheduledClassroomSettings({ schoolId: ids.school, contextId: context.id,
    actorId: ids.teacher, expectedRevision: current + 1, chatEnabled: false }));
  assert.equal(disabled.lifecycleRevision, current + 2);
  await assert.rejects(send("hello??"), rejection("FAB_FEATURE_DISABLED"), "disabled hides the channel; paused is never reported over it");
  const resumed = await inSchool(() => tools.updateScheduledClassroomSettings({ schoolId: ids.school, contextId: context.id,
    actorId: ids.teacher, expectedRevision: current + 2, chatEnabled: true, chatPaused: false }));
  assert.equal(resumed.lifecycleRevision, current + 3);
  assert.equal((await send("back")).created, true);
});

test("a class session pause is distinct from disabling messaging and rides the settings revision", async () => {
  await statement(sql`INSERT INTO groups(id,school_id,teacher_id,name,group_type,status)
    VALUES(${ids.group},${ids.school},${ids.teacher},'Homeroom','admin_class','active')`);
  await statement(sql`INSERT INTO group_students(group_id,student_id) VALUES(${ids.group},${ids.student})`);
  await statement(sql`INSERT INTO teaching_sessions(id,school_id,group_id,teacher_id,session_mode,start_time,roster_snapshot_completed_at,class_name_snapshot)
    VALUES(${ids.session},${ids.school},${ids.group},${ids.teacher},'live',now()-interval '1 minute',now(),'Homeroom')`);
  await statement(sql`INSERT INTO classpilot_session_students(school_id,teaching_session_id,group_id,student_id)
    VALUES(${ids.school},${ids.session},${ids.group},${ids.student})`);
  await statement(sql`INSERT INTO classpilot_session_staff(school_id,teaching_session_id,staff_id,role) VALUES(${ids.school},${ids.session},${ids.teacher},'primary')`);

  const before = await inSchool(() => fab.getEffectiveFabToggles(ids.school, ids.session));
  assert.deepEqual([before.messagingEnabled, before.messagesPaused, before.pauseReason, before.sessionChatPaused, before.lifecycleRevision],
    [true, false, null, false, 0]);

  const paused = await inSchool(() => fab.updateAndFanoutSessionFabSettings({ schoolId: ids.school, teachingSessionId: ids.session,
    actorId: ids.teacher, chatPaused: true, expectedRevision: 0 }));
  assert.equal(paused.settings.chatPaused, true);
  assert.equal(paused.settings.chatEnabled, true);
  assert.equal(paused.settings.lifecycleRevision, 1);
  assert.deepEqual([paused.state.messagingEnabled, paused.state.messagesPaused, paused.state.pauseReason, paused.state.revision],
    [false, true, "teacher", 1]);
  const during = await inSchool(() => fab.getEffectiveFabToggles(ids.school, ids.session));
  assert.deepEqual([during.messagingEnabled, during.sessionMessagingEnabled, during.messagesPaused, during.pauseReason, during.sessionChatPaused],
    [false, true, true, "teacher", true], "the hard channel flag is untouched by a pause");

  await assert.rejects(inSchool(() => fab.updateAndFanoutSessionFabSettings({ schoolId: ids.school, teachingSessionId: ids.session,
    actorId: ids.teacher, chatPaused: false, expectedRevision: 0 })), (error: unknown) => {
    assert.ok(error && typeof error === "object" && "code" in error && error.code === "FAB_REVISION_STALE");
    const current = (error as { current?: { messagesPaused?: boolean; pauseReason?: string | null } }).current;
    assert.deepEqual([current?.messagesPaused, current?.pauseReason], [true, "teacher"], "a stale writer is told the live pause");
    return true;
  });

  const resumed = await inSchool(() => fab.updateAndFanoutSessionFabSettings({ schoolId: ids.school, teachingSessionId: ids.session,
    actorId: ids.teacher, chatPaused: false, expectedRevision: 1 }));
  assert.equal(resumed.settings.lifecycleRevision, 2);
  assert.deepEqual([resumed.state.messagingEnabled, resumed.state.messagesPaused, resumed.state.pauseReason], [true, false, null]);
});
