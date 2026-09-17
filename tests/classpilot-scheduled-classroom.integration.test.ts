import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { CLASSPILOT_SCHEDULED_CLASSROOM_SQL } from "../src/db/classpilotScheduledClassroomMigration.js";
import { assertScheduledClassroomEnvironment, isScheduledClassroomEnabled } from "../src/config/classpilotScheduledClassroom.js";

process.env.REDIS_URL = "";
process.env.CLASSPILOT_SCHEDULED_CLASSROOM_MODE = "on";
delete process.env.CLASSPILOT_SCHEDULED_CLASSROOM_SCHOOL_IDS;
delete process.env.CLASSPILOT_SCHEDULED_CLASSROOM_EXCLUDED_SCHOOL_IDS;
const ids = { school: randomUUID(), otherSchool: randomUUID(), teacher: randomUUID(), nextTeacher: randomUUID(), student: randomUUID(), device: randomUUID() };
let database: typeof import("../src/db.js").default;
let pool: typeof import("../src/db.js").pool;
let storage: typeof import("../src/services/storage.js");
let tools: typeof import("../src/services/classpilotScheduledClassroomTools.js");
let authority: typeof import("../src/services/classpilotActivityAuthority.js");
let tenant: typeof import("../src/middleware/tenantContext.js").runWithTenantContext;
let context: import("../src/schema/classpilot.js").ClasspilotSupervisionContext;
let bindingId: string;
let timerCommandId: string;
const inSchool = <T>(fn: () => Promise<T>) => tenant({ schoolId: ids.school }, fn);
const statement = (query: ReturnType<typeof sql>) => inSchool(() => database.execute(query));
const control = () => inSchool(() => storage.getClasspilotStudentControlState(ids.school, ids.student));
const action = async () => ({ schoolId: ids.school, supervisionContextId: context.id, studentId: ids.student,
  studentSessionId: bindingId, deviceId: ids.device, studentControlRevision: (await control())!.revision });
const rejection = (code: string) => (error: unknown): boolean => {
  if (!error || typeof error !== "object") return false;
  return ("code" in error && error.code === code) || ("cause" in error && rejection(code)(error.cause));
};

before(async () => {
  assert.ok(["localhost", "127.0.0.1", "::1"].includes(new URL(process.env.DATABASE_URL || "").hostname), "Scheduled tools require the local fixture");
  process.env.DATABASE_URL_PRIVILEGED = process.env.DATABASE_URL;
  ({ default: database, pool } = await import("../src/db.js"));
  ({ runWithTenantContext: tenant } = await import("../src/middleware/tenantContext.js"));
  storage = await import("../src/services/storage.js");
  tools = await import("../src/services/classpilotScheduledClassroomTools.js");
  authority = await import("../src/services/classpilotActivityAuthority.js");
  await pool.query(CLASSPILOT_SCHEDULED_CLASSROOM_SQL);
  await pool.query("INSERT INTO schools(id,name,domain,status,plan_status) VALUES($1,'Scheduled tools',$3,'active','active'),($2,'Other tools',$3,'active','active')", [ids.school, ids.otherSchool, `${ids.school}.example.edu`]);
  for (const id of [ids.teacher, ids.nextTeacher]) {
    await pool.query("INSERT INTO users(id,email,first_name,last_name) VALUES($1,$2,'Scheduled','Teacher')", [id, `${id}@${ids.school}.example.edu`]);
    await pool.query("INSERT INTO school_memberships(school_id,user_id,role,status) VALUES($1,$2,'teacher','active')", [ids.school, id]);
  }
  await pool.query("INSERT INTO product_licenses(school_id,product,status) VALUES($1,'CLASSPILOT','active')", [ids.school]);
  await statement(sql`INSERT INTO settings(school_id,school_name,ws_shared_key,enable_tracking_hours,after_hours_mode) VALUES(${ids.school},'Scheduled tools','test-only',false,'off')`);
  await statement(sql`INSERT INTO students(id,school_id,first_name,last_name,status) VALUES(${ids.student},${ids.school},'Test','Student','active')`);
  await inSchool(async () => {
    await storage.createDevice({ schoolId: ids.school, deviceId: ids.device, classId: "default", deviceName: "Test Chromebook" });
    bindingId = (await storage.startStudentSessionWithReplacements(ids.school, ids.student, ids.device,
      { authKind: "manual_shared", sessionRecoveryTokenHash: "b".repeat(64) })).session.id;
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
    for (const table of ["poll_responses", "polls", "classpilot_chat_deliveries", "chat_messages", "classpilot_active_hands", "session_settings",
      "classpilot_classroom_states", "classpilot_command_targets", "classpilot_commands", "classpilot_student_control_states",
      "classpilot_supervision_students", "classpilot_supervision_contexts", "student_sessions", "devices", "students", "settings"]) {
      if (table === "student_sessions") await database.execute(sql`DELETE FROM student_sessions WHERE student_id=${ids.student}`);
      else await database.execute(sql`DELETE FROM ${sql.identifier(table)} WHERE school_id=${ids.school}`);
    }
  });
  await pool.query("DELETE FROM product_licenses WHERE school_id=$1", [ids.school]);
  await pool.query("DELETE FROM school_memberships WHERE school_id=$1", [ids.school]);
  await pool.query("DELETE FROM schools WHERE id IN($1,$2)", [ids.school, ids.otherSchool]);
  await pool.query("DELETE FROM users WHERE id IN($1,$2)", [ids.teacher, ids.nextTeacher]);
  await (await import("../src/services/errorMonitor.js")).default.disposeAndWait();
  (await import("../src/services/classpilotRealtimeStatus.js")).setClasspilotRealtimeStatusCommandForTests(undefined);
  const scheduler = await import("../src/services/schedulerDb.js");
  await Promise.all([pool.end(), (await import("../src/db.js")).sessionPool.end(), scheduler.schedulerPool.end(), scheduler.schedulerLockPool.end()]);
});

test("the rollout reaches every school and authority parsing fails closed", () => {
  // The resting state is on. A school onboarded tomorrow is covered by this
  // assertion, which is the whole point of the default: nothing has to be
  // remembered for it to work.
  assert.equal(isScheduledClassroomEnabled(ids.school, {}), true);
  assert.equal(isScheduledClassroomEnabled(ids.otherSchool, {}), true);
  // A school with no id is still refused: an empty tenant is never a rollout.
  assert.equal(isScheduledClassroomEnabled("", {}), false);
  // The global kill switch and the per-school carve-out both still work.
  assert.equal(isScheduledClassroomEnabled(ids.school, { CLASSPILOT_SCHEDULED_CLASSROOM_MODE: "off" }), false);
  assert.equal(isScheduledClassroomEnabled(ids.school,
    { CLASSPILOT_SCHEDULED_CLASSROOM_EXCLUDED_SCHOOL_IDS: ids.school }), false);
  assert.equal(isScheduledClassroomEnabled(ids.school,
    { CLASSPILOT_SCHEDULED_CLASSROOM_EXCLUDED_SCHOOL_IDS: ids.otherSchool }), true);
  // A malformed carve-out list refuses every school rather than guessing. A
  // typo must never silently enable the one school it was written to exclude.
  assert.equal(isScheduledClassroomEnabled(ids.school,
    { CLASSPILOT_SCHEDULED_CLASSROOM_EXCLUDED_SCHOOL_IDS: `${ids.otherSchool},` }), false);
  // The retired allowlist must stop a boot rather than silently narrowing the
  // rollout back to the schools it names.
  assert.throws(() => assertScheduledClassroomEnvironment(
    { CLASSPILOT_SCHEDULED_CLASSROOM_SCHOOL_IDS: ids.school } as NodeJS.ProcessEnv),
    /CLASSPILOT_SCHEDULED_CLASSROOM_SCHOOL_IDS is retired/);
  assert.equal(authority.parseClasspilotActivityAuthority({ teachingSessionId: "one", supervisionContextId: "two" }), null);
  assert.equal(authority.parseClasspilotActivityAuthority({ teachingSessionId: {}, supervisionContextId: "two" }), null);
  assert.deepEqual(authority.parseClasspilotActivityAuthority({ supervisionContextId: context.id }), { supervisionContextId: context.id });
  for (const value of [undefined, null, "", "00", " 0", "-1", 0]) {
    assert.throws(() => authority.requireScheduledClassroomRequestRevision(value), rejection("CLASSROOM_AUTHORITY_CHANGED"));
  }
  assert.equal(authority.requireScheduledClassroomRequestRevision("0"), "0");
});

test("same-school exactly-one guards protect retained context parents and migration replay", async () => {
  await assert.rejects(statement(sql`INSERT INTO session_settings(school_id,session_id,supervision_context_id) VALUES(${ids.school},'not-a-session',${context.id})`), rejection("23514"));
  await assert.rejects(pool.query("INSERT INTO session_settings(school_id,supervision_context_id) VALUES($1,$2)", [ids.otherSchool, context.id]), rejection("23514"));
  const row = await inSchool(() => tools.updateScheduledClassroomSettings({ schoolId: ids.school, contextId: context.id,
    actorId: ids.teacher, expectedRevision: 0, chatEnabled: true, raiseHandEnabled: true }));
  await assert.rejects(statement(sql`DELETE FROM classpilot_supervision_contexts WHERE id=${context.id}`), rejection("23503"));
  await pool.query(CLASSPILOT_SCHEDULED_CLASSROOM_SQL);
  assert.equal((await inSchool(() => tools.getScheduledClassroomSettings(ids.school, context.id)))?.id, row.id);
  await assert.rejects(inSchool(() => tools.updateScheduledClassroomSettings({ schoolId: ids.school, contextId: context.id,
    actorId: ids.teacher, expectedRevision: 0, chatEnabled: false })), rejection("SETTINGS_REVISION_CONFLICT"));
  await assert.rejects(inSchool(() => tools.updateScheduledClassroomSettings({ schoolId: ids.school, contextId: context.id,
    actorId: ids.nextTeacher, expectedRevision: row.lifecycleRevision, chatEnabled: false })), rejection("CLASSROOM_ACTIVITY_UNAVAILABLE"));
});

test("student tools bind to context and revision, and same-context restriction updates preserve hands", async () => {
  const original = await action();
  await inSchool(() => tools.mutateScheduledStudentHand({ ...original, raised: true }));
  assert.equal((await inSchool(() => tools.getScheduledClassroomHands(ids.school, context.id))).length, 1);
  const message = await inSchool(() => tools.createScheduledStudentMessage({ ...original, content: "Please help", clientMessageId: randomUUID() }));
  assert.equal(message.message.sessionId, null);
  assert.equal(message.message.supervisionContextId, context.id);
  await inSchool(() => storage.replaceClasspilotSupervisionControlSnapshots({ schoolId: ids.school, supervisionContextId: context.id,
    studentIds: [ids.student], forceRevision: true,
    desiredState: (_studentId: string, current: import("../src/schema/classpilot.js").ClasspilotStudentControlState | null) => current!.desiredState }));
  assert.equal((await inSchool(() => tools.getScheduledClassroomHands(ids.school, context.id))).length, 1);
  await assert.rejects(inSchool(() => tools.createScheduledStudentMessage({ ...original, content: "Stale", clientMessageId: randomUUID() })), rejection("CLASSROOM_ACTIVITY_STALE"));
  const { buildStudentFabState } = await import("../src/services/classpilotFab.js");
  const fab = await inSchool(() => buildStudentFabState(ids.school, ids.student, { acceptedCapabilities: ["scheduledClassroomV1"] }));
  assert.equal(fab.supervisionContextId, context.id);
  assert.equal(fab.messagingEnabled, true);
  assert.deepEqual(fab.activeContexts, [{ supervisionContextId: context.id }]);
  assert.equal(fab.contextAuthorityRevision, "0");
});

test("durable context replies claim only the original binding and reject stale acknowledgements", async () => {
  const reply = await inSchool(() => tools.createScheduledTeacherReply({ schoolId: ids.school, contextId: context.id,
    actorId: ids.teacher, studentId: ids.student, content: "On my way" }));
  const binding = { schoolId: ids.school, studentId: ids.student, studentSessionId: bindingId, deviceId: ids.device };
  const deliveries = await inSchool(() => storage.claimDueTeacherChatDeliveriesForBinding(binding));
  assert.equal(deliveries.length, 1);
  assert.equal(deliveries[0]!.delivery.supervisionContextId, context.id);
  assert.equal(deliveries[0]!.delivery.teachingSessionId, null);
  assert.equal(await inSchool(() => storage.acknowledgeTeacherChatDelivery({ ...binding, chatMessageId: reply.message.id,
    status: "delivered", studentControlRevision: -1 })), undefined);
  const revision = (await control())!.revision;
  assert.ok(await inSchool(() => storage.acknowledgeTeacherChatDelivery({ ...binding, chatMessageId: reply.message.id,
    status: "delivered", studentControlRevision: revision })));
});

test("poll targets, replies and restored tools keep exact scheduled authority", async () => {
  const pollId = randomUUID();
  const start = { action: "start" as const, pollId, question: "Ready?", options: ["Yes", "Help"] };
  const command = await inSchool(() => storage.createClasspilotCommandWithTargets({ schoolId: ids.school, teacherId: ids.teacher,
    teachingSessionId: null, supervisionContextId: context.id, targetScope: "context", commandType: "poll", commandPayload: start },
    [{ commandId: "replaced-in-transaction", schoolId: ids.school, studentId: ids.student, teachingSessionId: null,
      supervisionContextId: context.id, studentSessionId: bindingId, deviceId: ids.device }],
    { authority: { schoolId: ids.school, actorId: ids.teacher, supervisionContextId: context.id }, pollMutation: start }));
  assert.equal(command.targets[0]!.supervisionContextId, context.id);
  const poll = await inSchool(() => storage.getPollById(pollId, ids.school));
  assert.equal(poll?.sessionId, null);
  assert.equal(poll?.expiresAt?.getTime(), context.endsAt.getTime());
  const bound = await action();
  await assert.rejects(inSchool(() => storage.createPollResponseFirstWrite({ ...bound, pollId, selectedOption: 0,
    studentControlRevision: -1 })), rejection("POLL_AUTHORITY_STALE"));
  assert.equal((await inSchool(() => storage.createPollResponseFirstWrite({ ...bound, pollId, selectedOption: 0 }))).disposition, "created");
  assert.equal((await inSchool(() => storage.createPollResponseFirstWrite({ ...bound, pollId, selectedOption: 0 }))).disposition, "replayed");
  assert.equal((await inSchool(() => tools.getScheduledClassroomTransientState(context))).poll?.id, pollId);
  const timer = await inSchool(() => storage.createClasspilotCommandWithTargets({ schoolId: ids.school, teacherId: ids.teacher,
    teachingSessionId: null, supervisionContextId: context.id, targetScope: "context", commandType: "timer",
    commandPayload: { action: "start", seconds: 120, message: "Work" } },
    [{ commandId: "replaced-in-transaction", schoolId: ids.school, studentId: ids.student, teachingSessionId: null,
      supervisionContextId: context.id, studentSessionId: bindingId, deviceId: ids.device }],
    { authority: { schoolId: ids.school, actorId: ids.teacher, supervisionContextId: context.id } }));
  timerCommandId = timer.id;
  assert.equal((await inSchool(() => tools.getScheduledClassroomTransientState(context))).timer, null, "dispatch alone is not active delivery");
  await statement(sql`UPDATE classpilot_command_targets SET status='completed',completed_at=now() WHERE command_id=${timer.id}`);
  const restored = (await inSchool(() => tools.getScheduledClassroomTransientState(context))).timer;
  assert.equal(restored?.completedTargetCount, 1);
  assert.ok(Date.parse(restored!.endsAt) <= context.endsAt.getTime());
  await inSchool(() => storage.createClasspilotCommandWithTargets({ schoolId: ids.school, teacherId: ids.teacher,
    teachingSessionId: null, supervisionContextId: context.id, targetScope: "context", commandType: "timer", commandPayload: { action: "stop" } },
    [{ commandId: "replaced-in-transaction", schoolId: ids.school, studentId: ids.student, teachingSessionId: null,
      supervisionContextId: context.id, studentSessionId: bindingId, deviceId: ids.device }],
    { authority: { schoolId: ids.school, actorId: ids.teacher, supervisionContextId: context.id } }));
  assert.ok((await inSchool(() => tools.getScheduledClassroomTransientState(context))).timer, "an unacknowledged stop preserves the actual completed timer");
});

test("ordinary restrictions and end extensions preserve the classroom tenure and completed timer", async () => {
  const before = (await inSchool(() => tools.getScheduledClassroomTransientState(context))).timer;
  assert.ok(before);
  await inSchool(() => storage.replaceClasspilotSupervisionControlSnapshots({ schoolId: ids.school, supervisionContextId: context.id,
    studentIds: [ids.student], forceRevision: true,
    desiredState: (_studentId: string, current: import("../src/schema/classpilot.js").ClasspilotStudentControlState | null) => current!.desiredState }));
  assert.equal((await inSchool(() => tools.getScheduledClassroomTransientState(context))).timer?.endsAt, before.endsAt);
  context = (await inSchool(() => storage.extendSupervisionContext({ schoolId: ids.school, contextId: context.id,
    assignedStaffId: ids.teacher, endsAt: new Date(context.endsAt.getTime() + 60_000) })))!;
  assert.equal(context.classroomAuthorityRevision, 0);
  assert.equal((await inSchool(() => tools.getScheduledClassroomTransientState(context))).timer?.endsAt, before.endsAt);
  const fab = await inSchool(async () => (await import("../src/services/classpilotFab.js")).buildStudentFabState(ids.school, ids.student,
    { acceptedCapabilities: ["scheduledClassroomV1"] }));
  assert.equal(fab.contextAuthorityRevision, "0");
});

test("staff reassignment revokes original tools and increments control authority", async () => {
  const before = (await control())!.revision;
  context = (await inSchool(() => storage.extendSupervisionContext({ schoolId: ids.school, contextId: context.id, assignedStaffId: ids.nextTeacher })))!;
  assert.equal(context.classroomAuthorityRevision, 1);
  assert.ok((await control())!.revision > before);
  assert.equal((await inSchool(() => tools.getScheduledClassroomHands(ids.school, context.id))).length, 0);
  assert.equal((await pool.query("SELECT count(*)::integer AS count FROM polls WHERE school_id=$1 AND is_active", [ids.school])).rows[0].count, 0);
  assert.equal((await inSchool(() => tools.getScheduledClassroomTransientState({ ...context, assignedStaffId: ids.nextTeacher }))).timer, null);
  const staleAck = await inSchool(() => storage.persistClasspilotCommandTargetAck({ schoolId: ids.school, commandId: timerCommandId,
    studentId: ids.student, studentSessionId: bindingId, deviceId: ids.device, ackState: "completed", controlRevision: before }));
  assert.equal(staleAck.disposition, "terminal_rejected");
  await assert.rejects(inSchool(() => storage.endStudentSessionExact({ schoolId: ids.school, studentId: ids.student,
    studentSessionId: bindingId, deviceId: ids.device, scheduledClassroom: { contextId: context.id, actorId: ids.teacher, controlRevision: before } })),
    rejection("CLASSROOM_ACTIVITY_UNAVAILABLE"));
  await assert.rejects(inSchool(() => tools.createScheduledTeacherReply({ schoolId: ids.school, contextId: context.id,
    actorId: ids.teacher, studentId: ids.student, content: "No longer assigned" })), rejection("CLASSROOM_ACTIVITY_UNAVAILABLE"));
});

test("A to B to A never revives requests from an earlier classroom tenure", async () => {
  context = (await inSchool(() => storage.extendSupervisionContext({ schoolId: ids.school, contextId: context.id, assignedStaffId: ids.teacher })))!;
  assert.equal(context.classroomAuthorityRevision, 2);
  const stale = { schoolId: ids.school, contextId: context.id, actorId: ids.teacher, contextAuthorityRevision: "0" };
  await assert.rejects(inSchool(() => tools.createScheduledTeacherReply({ ...stale, studentId: ids.student, content: "Old tenure" })), rejection("CLASSROOM_AUTHORITY_CHANGED"));
  await assert.rejects(inSchool(() => tools.authorizeScheduledTeacherStudentAction({ ...stale, studentId: ids.student, dismissHand: true })), rejection("CLASSROOM_AUTHORITY_CHANGED"));
  await assert.rejects(inSchool(() => tools.updateScheduledClassroomSettings({ ...stale, expectedRevision: 1, chatEnabled: false })), rejection("CLASSROOM_AUTHORITY_CHANGED"));
  await assert.rejects(inSchool(() => storage.releaseSupervisionStudents({ schoolId: ids.school, contextId: context.id,
    scheduledClassroomAuthority: { actorId: ids.teacher, contextAuthorityRevision: "0" } })), rejection("CLASSROOM_AUTHORITY_CHANGED"));
  await assert.rejects(inSchool(() => storage.createClasspilotCommandWithTargets({ schoolId: ids.school, teacherId: ids.teacher,
    teachingSessionId: null, supervisionContextId: context.id, targetScope: "context", commandType: "timer", commandPayload: { action: "stop" } }, [],
    { authority: { schoolId: ids.school, actorId: ids.teacher, supervisionContextId: context.id, contextAuthorityRevision: "0" } })), rejection("CLASSROOM_AUTHORITY_CHANGED"));
  assert.equal((await inSchool(() => tools.getScheduledClassroomTransientState(context))).timer, null, "an old completed timer cannot revive for the returning teacher");
  const fab = await inSchool(async () => (await import("../src/services/classpilotFab.js")).buildStudentFabState(ids.school, ids.student,
    { acceptedCapabilities: ["scheduledClassroomV1"] }));
  assert.equal(fab.contextAuthorityRevision, "2");
  context = (await inSchool(() => storage.extendSupervisionContext({ schoolId: ids.school, contextId: context.id, assignedStaffId: ids.nextTeacher })))!;
});

test("release expires queued tools, preserves history, and never fabricates a class session", async () => {
  const reply = await inSchool(() => tools.createScheduledTeacherReply({ schoolId: ids.school, contextId: context.id,
    actorId: ids.nextTeacher, studentId: ids.student, content: "Retained message" }));
  const lastAction = await action();
  await inSchool(() => storage.releaseSupervisionStudents({ schoolId: ids.school, contextId: context.id, releaseReason: "returned_to_class" }));
  await assert.rejects(inSchool(() => tools.mutateScheduledStudentHand({ ...lastAction, raised: true })), rejection("CLASSROOM_ACTIVITY_UNAVAILABLE"));
  const rows = await pool.query("SELECT state FROM classpilot_chat_deliveries WHERE chat_message_id=$1", [reply.message.id]);
  assert.equal(rows.rows[0].state, "expired");
  assert.equal((await pool.query("SELECT count(*)::integer AS count FROM chat_messages WHERE school_id=$1", [ids.school])).rows[0].count, 3);
  assert.equal((await pool.query("SELECT count(*)::integer AS count FROM teaching_sessions WHERE school_id=$1", [ids.school])).rows[0].count, 0);
});
