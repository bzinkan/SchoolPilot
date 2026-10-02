import { after, before, test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { and, eq, sql } from "drizzle-orm";
import { Client } from "pg";
import { chatMessages, classpilotChatDeliveries } from "../src/schema/classpilot.js";
import { CLASSPILOT_CHAT_CHANNEL_CONTROL_SQL } from "../src/db/classpilotChatChannelControlMigration.js";

process.env.REDIS_URL = "";
process.env.CLASSPILOT_SCHEDULED_CLASSROOM_MODE = "on";
delete process.env.CLASSPILOT_SCHEDULED_CLASSROOM_SCHOOL_IDS;
delete process.env.CLASSPILOT_SCHEDULED_CLASSROOM_EXCLUDED_SCHOOL_IDS;

const ids = { school: randomUUID(), teacher: randomUUID(), student: randomUUID(), device: randomUUID(), group: randomUUID(), session: randomUUID(),
  classStudent: randomUUID(), classGroup: randomUUID() };
let database: typeof import("../src/db.js").default;
let pool: typeof import("../src/db.js").pool;
let storage: typeof import("../src/services/storage.js");
let tools: typeof import("../src/services/classpilotScheduledClassroomTools.js");
let fab: typeof import("../src/services/classpilotFab.js");
let tenant: typeof import("../src/middleware/tenantContext.js").runWithTenantContext;
let context: import("../src/schema/classpilot.js").ClasspilotSupervisionContext;
let liveSession: import("../src/schema/classpilot.js").TeachingSession;
let server: Server | undefined;
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
  const listening = server;
  if (listening) await new Promise<void>((resolve, reject) => listening.close((error) => error ? reject(error) : resolve()));
  if (!pool) return;
  await tenant({ isSuper: true }, async () => {
    for (const table of ["classpilot_chat_deliveries", "chat_messages", "classpilot_active_hands", "session_settings",
      "classpilot_session_students", "classpilot_session_staff", "teaching_sessions", "group_students", "groups",
      "classpilot_classroom_states", "classpilot_command_targets", "classpilot_commands", "classpilot_student_control_states",
      "classpilot_supervision_students", "classpilot_supervision_contexts", "student_sessions", "devices", "students", "settings"]) {
      if (table === "student_sessions") await database.execute(sql`DELETE FROM student_sessions WHERE student_id=${ids.student}`);
      else if (table === "group_students") await database.execute(sql`DELETE FROM group_students WHERE group_id IN (${ids.group}, ${ids.classGroup})`);
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

// Teacher replies: a pause never blocks them, either hard switch always does.
const teacherRows = (parent: { sessionId: string } | { supervisionContextId: string }) => inSchool(async () => {
  const [messages] = await database.select({ count: sql<number>`count(*)::int` }).from(chatMessages).where(and(
    eq(chatMessages.schoolId, ids.school), eq(chatMessages.senderType, "teacher"),
    "sessionId" in parent ? eq(chatMessages.sessionId, parent.sessionId) : eq(chatMessages.supervisionContextId, parent.supervisionContextId)));
  const [deliveries] = await database.select({ count: sql<number>`count(*)::int` }).from(classpilotChatDeliveries).where(and(
    eq(classpilotChatDeliveries.schoolId, ids.school),
    "sessionId" in parent ? eq(classpilotChatDeliveries.teachingSessionId, parent.sessionId)
      : eq(classpilotChatDeliveries.supervisionContextId, parent.supervisionContextId)));
  return { messages: messages!.count, deliveries: deliveries!.count };
});
const liveReply = (content: string) => inSchool(() => storage.createTeacherChatReplyWithDelivery({ schoolId: ids.school,
  teachingSessionId: liveSession.id, studentId: ids.classStudent, teacherId: ids.teacher, content }));
const setClassSwitches = async (patch: { chatEnabled?: boolean; chatPaused?: boolean }) => {
  const { lifecycleRevision } = await inSchool(() => fab.getEffectiveFabToggles(ids.school, liveSession.id));
  return inSchool(() => fab.updateAndFanoutSessionFabSettings({ schoolId: ids.school, teachingSessionId: liveSession.id,
    actorId: ids.teacher, expectedRevision: lifecycleRevision, ...patch }));
};
const setSchoolMessaging = (enabled: boolean) => statement(sql`UPDATE settings SET student_messaging_enabled=${enabled} WHERE school_id=${ids.school}`);
// An integer status, a code and expose: what the shared error handler and the
// chat routes' FAB contract pass-through both read off the error itself.
const refusedWith = (message: string) => (error: unknown): boolean => {
  assert.ok(error instanceof Error, "the refusal is an Error the route forwards unchanged");
  const { status, code, expose } = error as Error & { status?: unknown; code?: unknown; expose?: unknown };
  assert.deepEqual({ status, code, message: error.message, expose }, { status: 403, code: "FAB_FEATURE_DISABLED", message, expose: true });
  return true;
};
const routeRefusesReply = async (t: TestContext, content: string) => {
  if (!server) {
    const { createApp } = await import("../src/app.js");
    const listening = createServer(createApp());
    await new Promise<void>((resolve) => listening.listen(0, "127.0.0.1", resolve));
    server = listening;
  }
  const monitor = (await import("../src/services/errorMonitor.js")).default;
  const tracked: unknown[] = [];
  t.mock.method(monitor, "trackError", (category: unknown) => { tracked.push(category); });
  const { signUserToken } = await import("../src/services/jwt.js");
  const token = signUserToken({ userId: ids.teacher, email: `${ids.teacher}@${ids.school}.example.edu`, isSuperAdmin: false });
  const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/classpilot/teacher/reply`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "x-school-id": ids.school, "content-type": "application/json" },
    body: JSON.stringify({ sessionId: liveSession.id, studentId: ids.classStudent, message: content }),
  });
  const body: { error?: unknown; code?: unknown; requestId?: unknown } = JSON.parse(await response.text());
  assert.equal(response.status, 403, JSON.stringify(body));
  assert.deepEqual([body.code, body.error], ["FAB_FEATURE_DISABLED", "Messaging is turned off"]);
  assert.equal(typeof body.requestId, "string", "the shared error handler shaped the refusal");
  assert.ok(tracked.includes("client_error") && !tracked.includes("api_error"), "a refusal is a client error, never an API failure");
};

test("a paused live class still hears its teacher: the reply is stored with a queued delivery", async () => {
  await statement(sql`INSERT INTO students(id,school_id,first_name,last_name,status) VALUES(${ids.classStudent},${ids.school},'Class','Student','active')`);
  await statement(sql`INSERT INTO groups(id,school_id,teacher_id,name,group_type,status)
    VALUES(${ids.classGroup},${ids.school},${ids.teacher},'Second period','admin_class','active')`);
  await statement(sql`INSERT INTO group_students(group_id,student_id) VALUES(${ids.classGroup},${ids.classStudent})`);
  liveSession = await inSchool(() => storage.createTeachingSession({ groupId: ids.classGroup, teacherId: ids.teacher, sessionMode: "live" }));

  const paused = await setClassSwitches({ chatPaused: true });
  assert.deepEqual([paused.settings.chatEnabled, paused.state.messagesPaused, paused.state.pauseReason], [true, true, "teacher"]);
  const reply = await liveReply("Paused, but you can still hear me");
  assert.deepEqual([reply.message.senderType, reply.message.sessionId, reply.message.deliveryStatus], ["teacher", liveSession.id, "sent"]);
  assert.deepEqual([reply.delivery.chatMessageId, reply.delivery.teachingSessionId, reply.delivery.studentId, reply.delivery.state],
    [reply.message.id, liveSession.id, ids.classStudent, "queued"]);
  assert.deepEqual(await teacherRows({ sessionId: liveSession.id }), { messages: 1, deliveries: 1 });
});

test("the class switch refuses a live reply with nothing stored, at the route too", async (t) => {
  const before = await teacherRows({ sessionId: liveSession.id });
  const disabled = await setClassSwitches({ chatEnabled: false });
  try {
    assert.deepEqual([disabled.settings.chatEnabled, disabled.settings.chatPaused], [false, true], "the class is off and still paused");
    await assert.rejects(liveReply("The class switch is off"), refusedWith("Messaging is turned off"));
    await routeRefusesReply(t, "The class switch is off, via the route");
    assert.deepEqual(await teacherRows({ sessionId: liveSession.id }), before, "no chat_messages row and no delivery row");
  } finally {
    await setClassSwitches({ chatEnabled: true });
  }
});

test("the school-wide switch refuses a live reply with nothing stored, at the route too", async (t) => {
  const before = await teacherRows({ sessionId: liveSession.id });
  await setSchoolMessaging(false);
  try {
    const toggles = await inSchool(() => fab.getEffectiveFabToggles(ids.school, liveSession.id));
    assert.deepEqual([toggles.schoolMessagingEnabled, toggles.sessionMessagingEnabled], [false, true], "only the school switch is off");
    await routeRefusesReply(t, "The school switch is off, via the route");
    await assert.rejects(liveReply("The school switch is off"), refusedWith("Messaging is turned off"));
    assert.deepEqual(await teacherRows({ sessionId: liveSession.id }), before, "no chat_messages row and no delivery row");
  } finally {
    await setSchoolMessaging(true);
  }
  assert.equal((await liveReply("Messaging is back on")).delivery.state, "queued", "replies go through again once the switch is back on");
});

// The statements other connections are waiting on behind `pid`, polled until
// one shows up or the racing call has already settled.
const blockedBehind = async (probe: Client, pid: number, settled: () => boolean): Promise<string[]> => {
  for (const deadline = Date.now() + 5_000; !settled() && Date.now() < deadline;) {
    const { rows } = await probe.query<{ query: string }>("SELECT query FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))", [pid]);
    if (rows.length > 0) return rows.map((row) => row.query);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return [];
};

test("a reply racing the class switch-off waits for it and is then refused, without deadlocking", async () => {
  const before = await teacherRows({ sessionId: liveSession.id });
  const writer = new Client({ connectionString: process.env.DATABASE_URL });
  const probe = new Client({ connectionString: process.env.DATABASE_URL });
  await Promise.all([writer.connect(), probe.connect()]);
  let open = false;
  let racing: Promise<unknown> | undefined;
  try {
    // The class switch writer's order (the next test drives the real writer):
    // the teaching session row, then its settings row.
    await writer.query("BEGIN");
    open = true;
    await writer.query("SET LOCAL lock_timeout = '3s'");
    const writerPid = (await writer.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]!.pid;
    await writer.query("SELECT id FROM teaching_sessions WHERE id=$1 FOR UPDATE", [liveSession.id]);
    let outcome = "pending";
    racing = liveReply("Sent while the class switch was turning off");
    racing.then(() => { outcome = "stored"; }, () => { outcome = "refused"; });
    const blocked = await blockedBehind(probe, writerPid, () => outcome !== "pending");
    assert.deepEqual([outcome, blocked.length], ["pending", 1], "the reply is blocked behind the writer's teaching-session lock");
    assert.match(blocked[0]!, /^select "id" from "teaching_sessions" .+ for key share$/,
      "it waits at its own key-share read of the session, before it reads either switch");
    // Had the reply share-locked the settings row before the session row, this update would deadlock with it.
    await writer.query("UPDATE session_settings SET chat_enabled=false, lifecycle_revision=lifecycle_revision+1, updated_at=now() WHERE school_id=$1 AND session_id=$2",
      [ids.school, liveSession.id]);
    await writer.query("COMMIT");
    open = false;
    await assert.rejects(racing, refusedWith("Messaging is turned off"));
    assert.deepEqual(await teacherRows({ sessionId: liveSession.id }), before, "no chat_messages row and no delivery row");
  } finally {
    if (open) await writer.query("ROLLBACK").catch(() => {});
    await racing?.catch(() => {});
    await Promise.all([writer.end(), probe.end()]);
    await setClassSwitches({ chatEnabled: true });
  }
});

test("the real class switch writer locks the session before its settings row, so it queues behind a reply instead of deadlocking", async () => {
  const reply = new Client({ connectionString: process.env.DATABASE_URL });
  const probe = new Client({ connectionString: process.env.DATABASE_URL });
  await Promise.all([reply.connect(), probe.connect()]);
  let open = false;
  let switching: ReturnType<typeof setClassSwitches> | undefined;
  try {
    // A live reply's locks once it is past its classroom checks: the session's key-share lock first...
    await reply.query("BEGIN");
    open = true;
    await reply.query("SET LOCAL lock_timeout = '3s'");
    const replyPid = (await reply.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]!.pid;
    await reply.query("SELECT id FROM teaching_sessions WHERE school_id=$1 AND id=$2 FOR KEY SHARE", [ids.school, liveSession.id]);
    let outcome = "pending";
    switching = setClassSwitches({ chatEnabled: false });
    switching.then(() => { outcome = "switched"; }, () => { outcome = "failed"; });
    const blocked = await blockedBehind(probe, replyPid, () => outcome !== "pending");
    assert.deepEqual([outcome, blocked.length], ["pending", 1], "the switch-off waits behind the in-flight reply");
    assert.match(blocked[0]!, /^select "id" from "teaching_sessions" .+ for update$/, "it waits for its update lock on the session row");
    // ...then both switches, share-locked. Had the writer locked its settings row first, this would deadlock with it.
    const school = await reply.query<{ enabled: boolean }>("SELECT student_messaging_enabled AS enabled FROM settings WHERE school_id=$1 FOR SHARE",
      [ids.school]);
    const session = await reply.query<{ enabled: boolean }>("SELECT chat_enabled AS enabled FROM session_settings WHERE school_id=$1 AND session_id=$2 FOR SHARE",
      [ids.school, liveSession.id]);
    assert.deepEqual([...school.rows, ...session.rows].map((row) => row.enabled), [true, true], "the in-flight reply still reads both switches as on");
    await reply.query("COMMIT");
    open = false;
    const switched = await switching;
    assert.deepEqual([switched.settings.chatEnabled, switched.settings.chatPaused], [false, true], "the switch-off lands once the reply commits");
    await assert.rejects(liveReply("Sent after the class switch went off"), refusedWith("Messaging is turned off"));
  } finally {
    if (open) await reply.query("ROLLBACK").catch(() => {});
    await switching?.catch(() => {});
    await Promise.all([reply.end(), probe.end()]);
    await setClassSwitches({ chatEnabled: true });
  }
});

test("a reply racing the school switch-off waits at its share-locked read of the switch and is then refused", async () => {
  const before = await teacherRows({ sessionId: liveSession.id });
  const writer = new Client({ connectionString: process.env.DATABASE_URL });
  const probe = new Client({ connectionString: process.env.DATABASE_URL });
  await Promise.all([writer.connect(), probe.connect()]);
  let open = false;
  let racing: Promise<unknown> | undefined;
  try {
    // The session lock does not order a reply against the school switch; only the reply's
    // share lock on the settings row keeps a reply that read "on" from committing after a switch-off.
    await writer.query("BEGIN");
    open = true;
    await writer.query("SET LOCAL lock_timeout = '3s'");
    const writerPid = (await writer.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]!.pid;
    await writer.query("UPDATE settings SET student_messaging_enabled=false WHERE school_id=$1", [ids.school]);
    let outcome = "pending";
    racing = liveReply("Sent while the school switch was turning off");
    racing.then(() => { outcome = "stored"; }, () => { outcome = "refused"; });
    const blocked = await blockedBehind(probe, writerPid, () => outcome !== "pending");
    assert.deepEqual([outcome, blocked.length], ["pending", 1], "the reply is blocked behind the uncommitted switch-off");
    assert.match(blocked[0]!, /^select "student_messaging_enabled" from "settings" .+ for share$/,
      "it waits at its share-locked read of the school switch");
    await writer.query("COMMIT");
    open = false;
    await assert.rejects(racing, refusedWith("Messaging is turned off"));
    assert.deepEqual(await teacherRows({ sessionId: liveSession.id }), before, "no chat_messages row and no delivery row");
  } finally {
    if (open) await writer.query("ROLLBACK").catch(() => {});
    await racing?.catch(() => {});
    await Promise.all([writer.end(), probe.end()]);
    await setSchoolMessaging(true);
  }
});

test("a scheduled reply keeps its own gate: a pause never blocks it, either hard switch does", async () => {
  const reply = (content: string) => inSchool(() => tools.createScheduledTeacherReply({ schoolId: ids.school, contextId: context.id,
    actorId: ids.teacher, studentId: ids.student, content }));
  const setActivity = async (patch: { chatEnabled?: boolean; chatPaused?: boolean }) => {
    const { lifecycleRevision } = await inSchool(() => tools.scheduledClassroomToggles(ids.school, context));
    return inSchool(() => tools.updateScheduledClassroomSettings({ schoolId: ids.school, contextId: context.id, actorId: ids.teacher,
      expectedRevision: lifecycleRevision, ...patch }));
  };
  await setActivity({ chatPaused: true });
  assert.equal((await reply("Paused, still reachable")).delivery.state, "queued");
  const before = await teacherRows({ supervisionContextId: context.id });
  await setActivity({ chatEnabled: false });
  await assert.rejects(reply("The activity switch is off"), refusedWith("Messaging is disabled"));
  await setActivity({ chatEnabled: true, chatPaused: false });
  await setSchoolMessaging(false);
  try {
    await assert.rejects(reply("The school switch is off"), refusedWith("Messaging is disabled"));
  } finally {
    await setSchoolMessaging(true);
  }
  assert.deepEqual(await teacherRows({ supervisionContextId: context.id }), before, "a refused scheduled reply stores nothing");
});
