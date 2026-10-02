import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { once } from "node:events";
import { after, before, beforeEach, test } from "node:test";
import { setTimeout as pause } from "node:timers/promises";
import { sql } from "drizzle-orm";
import pg from "pg";
import { WebSocket, WebSocketServer } from "ws";
import { CLASSPILOT_PRIVATE_CHAT_LIFECYCLE_SQL } from "../src/db/classpilotPrivateChatLifecycleMigration.js";
import type { PrivateChatLifecycle, PrivateChatScope } from "../src/services/classpilotPrivateChatLifecycle.js";

process.env.REDIS_URL = "";
process.env.CLASSPILOT_PROTOCOL_V3_ENABLED = "true";
process.env.CLASSPILOT_CAP_SCOPED_AUTHORITY_CHECKS_V1 = "true";
process.env.CLASSPILOT_CAP_STUDENT_CHAT_IDEMPOTENCY_V1 = "true";
process.env.CLASSPILOT_CAP_PRIVATE_CHAT_LIFECYCLE_V1 = "true";
process.env.CLASSPILOT_SCHEDULED_CLASSROOM_MODE = "on";
process.env.RLS_GUC_ENABLED = "true";
const registry = JSON.parse(readFileSync(new URL("../src/config/rlsRegistry.json", import.meta.url), "utf8"));
process.env.RLS_ENABLED_TABLES = registry.inventories.classpilotPrivateChatLifecyclePostExpand.tables.join(",");
delete process.env.CLASSPILOT_CAPABILITY_ROLLOUTS_JSON;
delete process.env.CLASSPILOT_SCHEDULED_CLASSROOM_SCHOOL_IDS;
delete process.env.CLASSPILOT_SCHEDULED_CLASSROOM_EXCLUDED_SCHOOL_IDS;

const ids = { school: randomUUID(), teacher: randomUUID(), group: randomUUID(),
  students: [randomUUID(), randomUUID(), randomUUID()], devices: [randomUUID(), randomUUID(), randomUUID()] };
const capabilities = ["scopedAuthorityChecksV1", "studentChatIdempotencyV1", "privateChatLifecycleV1", "scheduledClassroomV1"];
let admin: pg.Pool;
let database: typeof import("../src/db.js").default;
let storage: typeof import("../src/services/storage.js");
let lifecycle: typeof import("../src/services/classpilotPrivateChatLifecycle.js");
let realtime: typeof import("../src/services/classpilotRealtimeStatus.js");
let fab: typeof import("../src/services/classpilotFab.js");
let tools: typeof import("../src/services/classpilotScheduledClassroomTools.js");
let websocket: typeof import("../src/realtime/websocket.js");
let websocketBroadcast: typeof import("../src/realtime/ws-broadcast.js");
let tenant: typeof import("../src/middleware/tenantContext.js").runWithTenantContext;
let live: import("../src/schema/classpilot.js").TeachingSession;
let context: import("../src/schema/classpilot.js").ClasspilotSupervisionContext;
const bindings: string[] = [];
const recoveryHashes = [0, 1, 2].map(() => randomBytes(32).toString("hex"));
const inSchool = <T>(fn: () => Promise<T>) => tenant({ schoolId: ids.school }, fn);
const scope = (index = 0): PrivateChatScope => ({ schoolId: ids.school, studentId: ids.students[index]!,
  ...(index === 0 ? { teachingSessionId: live.id } : { supervisionContextId: context.id }) });
const token = async (index = 0): Promise<PrivateChatLifecycle> => {
  const data = await inSchool(() => lifecycle.teacherPrivateChatLifecycles(scope(index)));
  const row = data.privateChatLifecycles.find(item => item.studentId === ids.students[index]);
  assert.ok(row); return row.privateChatLifecycle;
};
const reply = async (content = "Synthetic private reply", expected?: PrivateChatLifecycle, index = 0) => {
  const expectedPrivateChatLifecycle = expected ?? await token(index);
  return index === 0
    ? inSchool(() => storage.createTeacherChatReplyWithDelivery({ ...scope(), teachingSessionId: live.id,
      teacherId: ids.teacher, content, expectedPrivateChatLifecycle }))
    : inSchool(() => tools.createScheduledTeacherReply({ schoolId: ids.school, contextId: context.id,
      actorId: ids.teacher, studentId: ids.students[index]!, contextAuthorityRevision: String(context.classroomAuthorityRevision),
      content, expectedPrivateChatLifecycle }));
};
const close = async (expectedPrivateChatLifecycle: PrivateChatLifecycle, index = 0) => {
  const response = await (index === 0
  ? inSchool(() => storage.authorizeClasspilotTeacherCloseChat({ ...scope(), teachingSessionId: live.id,
    actorId: ids.teacher, expectedPrivateChatLifecycle }))
  : inSchool(() => tools.authorizeScheduledTeacherStudentAction({ schoolId: ids.school, contextId: context.id,
    studentId: ids.students[index]!, actorId: ids.teacher, contextAuthorityRevision: String(context.classroomAuthorityRevision),
    closeChat: true, expectedPrivateChatLifecycle })));
  assert.ok(response.privateChatLifecycle);
  return { ...response, privateChatLifecycle: response.privateChatLifecycle };
};
const binding = (index = 0) => ({ schoolId: ids.school, studentId: ids.students[index]!,
  studentSessionId: bindings[index]!, deviceId: ids.devices[index]! });
const claim = (index = 0) => inSchool(() => storage.withClasspilotStudentControlDeliveryAuthority(
  { ...binding(index), claimTeacherChatDeliveries: true }, async () => undefined,
  rows => ({ messages: rows.map(row => row.message.id) })));
const refresh = (index: number, acceptedCapabilities = capabilities) => realtime.writeClasspilotRealtimeStatus({
  ...binding(index), heartbeatId: randomUUID(), observedAt: Date.now(), acceptedCapabilities });
const hasCode = (code: string) => (error: unknown): boolean => {
  if (!error || typeof error !== "object") return false;
  return "code" in error && error.code === code || "cause" in error && hasCode(code)(error.cause);
};
const expired = (messageId: string) => inSchool(() => lifecycle.isPrivateChatMessageExpired(messageId, ids.school));
const ack = (messageId: string, privateChatLifecycle: PrivateChatLifecycle, index = 0) => inSchool(() => storage.acknowledgeTeacherChatDelivery({
  ...binding(index), chatMessageId: messageId, status: "delivered", privateChatLifecycle }));
const blockedBehind = async (pid: number, settled: () => boolean): Promise<{ pid: number; query: string }[]> => {
  for (const deadline = Date.now() + 5_000; !settled() && Date.now() < deadline;) {
    const result = await admin.query<{ pid: number; query: string }>(
      "SELECT pid,query FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))", [pid]);
    if (result.rows.length) return result.rows;
    await pause(10);
  }
  return [];
};

// Exercise the actual receiving adapter and socket fan-out. A ping/pong
// barrier drains earlier frames on the same connection before inspecting the
// inbox; a negative assertion never relies on sleeping for absent traffic.
const withStudentSocket = async (index: number, acceptedCapabilities: string[],
  action: (probe: { inbox: string[]; drain: () => Promise<void> }) => Promise<void>) => {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const connected = once(server, "connection");
  const client = new WebSocket(`ws://127.0.0.1:${address.port}`);
  const inbox: string[] = [];
  client.on("message", data => inbox.push(data.toString()));
  await once(client, "open");
  const [socket] = await connected;
  assert.ok(socket instanceof WebSocket);
  websocketBroadcast.registerWsClient(socket);
  websocketBroadcast.authenticateWsClient(socket, { role: "student", ...binding(index), acceptedCapabilities });
  try {
    await action({ inbox, drain: async () => {
      const pong = once(socket, "pong"); socket.ping(randomUUID()); await pong;
    } });
  } finally {
    websocketBroadcast.removeWsClient(socket);
    client.terminate(); socket.terminate();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
};
const relayFrame = async (content: string, index = 0) => {
  const sent = await reply(content, undefined, index);
  const attempted = await inSchool(() => storage.markTeacherChatDeliveryAttempt({ ...binding(index), chatMessageId: sent.message.id }));
  assert.ok(attempted, "The real durable outbox must bind an attempted delivery to the exact current session");
  const control = index === 0 ? undefined : await inSchool(() => storage.getClasspilotStudentControlState(ids.school, ids.students[index]!));
  if (index !== 0) assert.ok(control, "The scheduled frame must carry its actual captured control revision");
  return { sent, frame: { type: "teacher-message", messageKind: "private", _msgId: sent.message.id,
    chatMessageId: sent.message.id, messageId: sent.message.id, studentId: ids.students[index]!,
    studentSessionId: bindings[index]!, message: sent.message.content, fromName: "Teacher",
    ...(index === 0 ? { sessionId: live.id } : { supervisionContextId: context.id, studentControlRevision: control!.revision }),
    privateChatLifecycle: lifecycle.privateChatMessageLifecycle(sent.message) } };
};
const relay = (frame: unknown, index = 0) => websocket.deliverClasspilotStudentBindingRedisMessage({
  kind: "student-binding", ...binding(index), requiredCapabilities: [],
}, frame);

const legacySchoolFixture = async () => {
  const own = { school: randomUUID(), teacher: randomUUID(), student: randomUUID(), device: randomUUID() };
  const under = <T>(fn: () => Promise<T>) => tenant({ schoolId: own.school }, fn);
  await admin.query("INSERT INTO schools(id,name,domain,status,plan_status) VALUES($1,'Legacy adoption race',$2,'active','active')", [own.school, `${own.school}.example.edu`]);
  await admin.query("INSERT INTO users(id,email,first_name,last_name) VALUES($1,$2,'Legacy','Teacher')", [own.teacher, `${own.teacher}@example.edu`]);
  await admin.query("INSERT INTO school_memberships(school_id,user_id,role,status) VALUES($1,$2,'teacher','active')", [own.school, own.teacher]);
  await admin.query("INSERT INTO product_licenses(school_id,product,status) VALUES($1,'CLASSPILOT','active')", [own.school]);
  await admin.query("INSERT INTO students(id,school_id,first_name,last_name,status) VALUES($1,$2,'Legacy','Student','active')", [own.student, own.school]);
  await admin.query("INSERT INTO settings(school_id,school_name,ws_shared_key,enable_tracking_hours,after_hours_mode,pause_chat_during_testing) VALUES($1,'Legacy adoption race','synthetic',false,'off',false)", [own.school]);
  await under(() => storage.createDevice({ schoolId: own.school, deviceId: own.device, classId: "default" }));
  const session = await under(() => storage.startStudentSessionWithReplacements(own.school, own.student, own.device,
    { authKind: "manual_shared", sessionRecoveryTokenHash: randomBytes(32).toString("hex") }));
  const group = await under(() => storage.createGroup({ schoolId: own.school, teacherId: own.teacher,
    name: "Legacy adoption class", groupType: "admin_class", status: "active" }));
  await under(() => database.execute(sql`INSERT INTO group_students(group_id,student_id) VALUES(${group.id},${own.student})`));
  const activity = await under(() => storage.createTeachingSession({ groupId: group.id, teacherId: own.teacher, sessionMode: "live" }));
  const activityScope = { schoolId: own.school, studentId: own.student, teachingSessionId: activity.id };
  const exactBinding = { schoolId: own.school, studentId: own.student, studentSessionId: session.session.id, deviceId: own.device };
  await realtime.writeClasspilotRealtimeStatus({ ...exactBinding, heartbeatId: randomUUID(), observedAt: Date.now(), acceptedCapabilities: capabilities });
  return { own, under, activityScope, exactBinding };
};

before(async () => {
  assert.ok(["127.0.0.1", "localhost", "::1"].includes(new URL(process.env.DATABASE_URL || "").hostname));
  assert.ok(process.env.ADMIN_DATABASE_URL, "A separate local bootstrap connection is required");
  admin = new pg.Pool({ connectionString: process.env.ADMIN_DATABASE_URL, max: 4 });
  await admin.query(CLASSPILOT_PRIVATE_CHAT_LIFECYCLE_SQL);
  ({ default: database } = await import("../src/db.js"));
  ({ runWithTenantContext: tenant } = await import("../src/middleware/tenantContext.js"));
  storage = await import("../src/services/storage.js");
  lifecycle = await import("../src/services/classpilotPrivateChatLifecycle.js");
  realtime = await import("../src/services/classpilotRealtimeStatus.js");
  fab = await import("../src/services/classpilotFab.js");
  tools = await import("../src/services/classpilotScheduledClassroomTools.js");
  websocket = await import("../src/realtime/websocket.js");
  websocketBroadcast = await import("../src/realtime/ws-broadcast.js");
  const role = await (await import("../src/db.js")).pool.query("SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user");
  if (process.env.RLS_TEST_ROLE) {
    assert.deepEqual(role.rows, [{ rolsuper: false, rolbypassrls: false }]);
  }
  console.log(`Private lifecycle application posture: ${process.env.RLS_TEST_ROLE ? "restricted" : "ordinary privileged fixture"}`);
  await admin.query("INSERT INTO schools(id,name,domain,status,plan_status) VALUES($1,'Private lifecycle fixture',$2,'active','active')", [ids.school, `${ids.school}.example.edu`]);
  await admin.query("INSERT INTO users(id,email,first_name,last_name) VALUES($1,$2,'Private','Teacher')", [ids.teacher, `${ids.teacher}@example.edu`]);
  await admin.query("INSERT INTO school_memberships(school_id,user_id,role,status) VALUES($1,$2,'teacher','active')", [ids.school, ids.teacher]);
  await admin.query("INSERT INTO product_licenses(school_id,product,status) VALUES($1,'CLASSPILOT','active')", [ids.school]);
  await inSchool(async () => {
    await database.execute(sql`INSERT INTO settings(school_id,school_name,ws_shared_key,enable_tracking_hours,after_hours_mode,pause_chat_during_testing)
      VALUES(${ids.school},'Private fixture','synthetic-only',false,'off',false)`);
    for (let index = 0; index < 3; index++) {
      await database.execute(sql`INSERT INTO students(id,school_id,first_name,last_name,status) VALUES(${ids.students[index]!},${ids.school},'Private',${String(index)},'active')`);
      await storage.createDevice({ schoolId: ids.school, deviceId: ids.devices[index]!, classId: "default" });
      bindings[index] = (await storage.startStudentSessionWithReplacements(ids.school, ids.students[index]!, ids.devices[index]!,
        { authKind: "manual_shared", sessionRecoveryTokenHash: recoveryHashes[index]! })).session.id;
    }
    await storage.createGroup({ id: ids.group, schoolId: ids.school, teacherId: ids.teacher,
      name: "Private class", groupType: "admin_class", status: "active" });
    await database.execute(sql`INSERT INTO group_students(group_id,student_id) VALUES(${ids.group},${ids.students[0]!})`);
    live = await storage.createTeachingSession({ groupId: ids.group, teacherId: ids.teacher, sessionMode: "live" });
    context = await storage.createSupervisionContextWithStudents({ context: { schoolId: ids.school, name: "Private scheduled class",
      contextType: "coverage_group", assignedStaffId: ids.teacher, createdBy: ids.teacher,
      startsAt: new Date(Date.now() - 60_000), endsAt: new Date(Date.now() + 3_600_000),
      scheduleProfileApplicationId: randomUUID(), scheduleProfileBlockId: randomUUID(), scheduleProfileDate: new Date().toISOString().slice(0, 10) },
      studentIds: ids.students.slice(1), assignedBy: ids.teacher });
  });
  const cache = new Map<string, string>();
  realtime.setClasspilotRealtimeStatusCommandForTests(async args => {
    if (args[0] === "MGET") return args.slice(1).map(key => cache.get(key) ?? null);
    if (args[0] === "EVAL" && args[3] && args[5]?.startsWith("{")) { cache.set(args[3], args[5]); return args[5]; }
    return undefined;
  });
});

beforeEach(async () => {
  process.env.CLASSPILOT_CAP_PRIVATE_CHAT_LIFECYCLE_V1 = "true";
  await admin.query("UPDATE settings SET student_messaging_enabled=true WHERE school_id=$1", [ids.school]);
  await admin.query("UPDATE session_settings SET chat_enabled=true,chat_paused=false WHERE school_id=$1", [ids.school]);
  await Promise.all([0, 1, 2].map(index => refresh(index)));
});

after(async () => {
  websocket?.stopWebSocketWork();
  await websocket?.drainWebSocketWork();
  if (websocket) await (await import("../src/realtime/ws-redis.js")).disposeWSRedis();
  realtime?.setClasspilotRealtimeStatusCommandForTests(undefined);
  if (storage) await inSchool(() => storage.softDeleteSchool(ids.school));
  if (database) {
    await (await import("../src/services/errorMonitor.js")).default.disposeAndWait();
    const pools = await import("../src/db.js"), scheduler = await import("../src/services/schedulerDb.js");
    await Promise.all([pools.pool.end(), pools.sessionPool.end(), scheduler.schedulerPool.end(), scheduler.schedulerLockPool.end()]);
  }
  await admin?.end();
});

test("the dark-deployment bridge remains legacy until first adoption, which permanently expires old unstamped replies", async () => {
  process.env.CLASSPILOT_CAP_PRIVATE_CHAT_LIFECYCLE_V1 = "false";
  try {
    const school = (await admin.query("SELECT private_chat_lifecycle_required FROM settings WHERE school_id=$1", [ids.school])).rows[0]!;
    assert.equal(school.private_chat_lifecycle_required, false);
    const teacherReply = await inSchool(() => storage.createTeacherChatReplyWithDelivery({ ...scope(), teachingSessionId: live.id,
      teacherId: ids.teacher, content: "Legacy dark-deployment reply" }));
    const studentMessage = await inSchool(() => storage.createAuthorizedClasspilotStudentMessage({ ...binding(), teachingSessionId: live.id,
      clientMessageId: randomUUID(), content: "Legacy dark-deployment question" }));
    for (const message of [teacherReply.message, studentMessage.message]) {
      assert.deepEqual([message.privateChatThreadId, message.privateChatSchoolEpoch, message.privateChatActivityEpoch, message.privateChatGeneration],
        [null, null, null, null]);
    }
    const ended = await inSchool(() => storage.authorizeClasspilotTeacherCloseChat({ ...scope(), teachingSessionId: live.id, actorId: ids.teacher }));
    assert.equal(ended.privateChatLifecycle, undefined);
    const bridge = await inSchool(() => lifecycle.teacherPrivateChatLifecycles(scope()));
    assert.deepEqual(bridge, { privateChatLifecycleRequired: false, privateChatLifecycles: [] });
    assert.equal((await admin.query("SELECT count(*)::int AS count FROM classpilot_private_chat_threads WHERE school_id=$1", [ids.school])).rows[0]!.count, 0);
    await inSchool(() => storage.markTeacherChatDeliveryAttempt({ ...binding(), chatMessageId: teacherReply.message.id }));
    await admin.query("UPDATE classpilot_chat_deliveries SET next_attempt_at=now() WHERE id=$1", [teacherReply.delivery.id]);
    await admin.query("UPDATE settings SET student_messaging_enabled=false WHERE school_id=$1", [ids.school]);
    assert.deepEqual(await claim(), { authorized: true, value: { messages: [] } });
    assert.equal(await inSchool(() => storage.acknowledgeTeacherChatDelivery({ ...binding(), chatMessageId: teacherReply.message.id,
      status: "delivered" })), undefined);
    const legacyFrame = { type: "teacher-message", messageKind: "private", privateChatLifecycle: null,
      _msgId: teacherReply.message.id, chatMessageId: teacherReply.message.id, messageId: teacherReply.message.id,
      sessionId: live.id, studentId: ids.students[0]!, studentSessionId: bindings[0]!,
      message: teacherReply.message.content, fromName: "Teacher" };
    const legacyCapabilities = capabilities.filter(capability => capability !== "privateChatLifecycleV1");
    await withStudentSocket(0, legacyCapabilities, async ({ inbox, drain }) => {
      assert.equal(await relay(legacyFrame), false); await drain(); assert.deepEqual(inbox, []);
    });
    await admin.query("UPDATE settings SET student_messaging_enabled=true WHERE school_id=$1", [ids.school]);
    await withStudentSocket(0, legacyCapabilities, async ({ inbox, drain }) => {
      assert.equal(await relay(legacyFrame), true); await drain();
      assert.deepEqual(inbox.map(raw => JSON.parse(raw)), [legacyFrame]);
    });
    assert.equal(await expired(teacherReply.message.id), false);
    const claimed = await claim(); assert.equal(claimed.authorized, true);
    if (claimed.authorized) assert.ok(claimed.value.messages.includes(teacherReply.message.id));
    await inSchool(() => storage.markTeacherChatDeliveryAttempt({ ...binding(), chatMessageId: teacherReply.message.id }));
    await admin.query("UPDATE classpilot_chat_deliveries SET next_attempt_at=now() WHERE id=$1", [teacherReply.delivery.id]);
    const blocker = await admin.connect(); let adopting: Promise<void> | undefined, legacyClaim: ReturnType<typeof claim> | undefined;
    try {
      await blocker.query("BEGIN"); await blocker.query("SELECT school_id FROM settings WHERE school_id=$1 FOR SHARE", [ids.school]);
      const pid = (await blocker.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]!.pid;
      process.env.CLASSPILOT_CAP_PRIVATE_CHAT_LIFECYCLE_V1 = "true";
      let adoptionSettled = false;
      adopting = inSchool(() => lifecycle.latchPrivateChatLifecycle(ids.school));
      adopting.then(() => { adoptionSettled = true; }, () => { adoptionSettled = true; });
      const writer = await blockedBehind(pid, () => adoptionSettled);
      assert.equal(writer.length, 1); assert.match(writer[0]!.query, /settings/);
      // Model a compatible preactivation writer while the adopting image owns
      // its exclusive school fence but has not committed the sticky row yet.
      process.env.CLASSPILOT_CAP_PRIVATE_CHAT_LIFECYCLE_V1 = "false";
      let claimSettled = false;
      legacyClaim = claim(); legacyClaim.then(() => { claimSettled = true; }, () => { claimSettled = true; });
      const waiting = await blockedBehind(writer[0]!.pid, () => claimSettled);
      assert.equal(waiting.length, 1); assert.match(waiting[0]!.query, /pg_advisory_xact_lock_shared/);
      await blocker.query("COMMIT"); await adopting;
      assert.deepEqual(await legacyClaim, { authorized: true, value: { messages: [] } });
      assert.equal((await admin.query("SELECT state FROM classpilot_chat_deliveries WHERE id=$1", [teacherReply.delivery.id])).rows[0]!.state, "expired");
    } finally { await blocker.query("ROLLBACK").catch(() => {}); await Promise.allSettled([adopting, legacyClaim]); blocker.release(); }
    const adopted = await token(); assert.equal(adopted.threadGeneration, 1);
    assert.equal(await expired(teacherReply.message.id), true);
    assert.equal(await expired(studentMessage.message.id), true);
    process.env.CLASSPILOT_CAP_PRIVATE_CHAT_LIFECYCLE_V1 = "false";
    assert.equal(await expired(teacherReply.message.id), true);
    assert.equal(await inSchool(() => storage.acknowledgeTeacherChatDelivery({ ...binding(), chatMessageId: teacherReply.message.id,
      status: "delivered" })), undefined);
    assert.deepEqual(await claim(), { authorized: true, value: { messages: [] } });
    await assert.rejects(reply("Capability-off after adoption", adopted), hasCode("PRIVATE_CHAT_DISABLED"));
  } finally { process.env.CLASSPILOT_CAP_PRIVATE_CHAT_LIFECYCLE_V1 = "true"; }
});

for (const operation of ["send", "claim", "ack"] as const) test(`first adoption serializes a legacy ${operation} with existing settings without a lock-order cycle`, async () => {
  process.env.CLASSPILOT_CAP_PRIVATE_CHAT_LIFECYCLE_V1 = "false";
  const fixture = await legacySchoolFixture(), { own, under, activityScope, exactBinding } = fixture;
  const blocker = await admin.connect(); let adopting: Promise<void> | undefined, racing: Promise<unknown> | undefined;
  try {
    const pending = await under(() => storage.createTeacherChatReplyWithDelivery({ ...activityScope, teacherId: own.teacher, content: "Pending legacy adoption race" }));
    await under(() => storage.markTeacherChatDeliveryAttempt({ ...exactBinding, chatMessageId: pending.message.id }));
    await admin.query("UPDATE classpilot_chat_deliveries SET next_attempt_at=now() WHERE id=$1", [pending.delivery.id]);
    await blocker.query("BEGIN"); await blocker.query("SELECT school_id FROM settings WHERE school_id=$1 FOR SHARE", [own.school]);
    const pid = (await blocker.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]!.pid;
    process.env.CLASSPILOT_CAP_PRIVATE_CHAT_LIFECYCLE_V1 = "true";
    let adoptionSettled = false;
    adopting = under(() => lifecycle.latchPrivateChatLifecycle(own.school));
    adopting.then(() => { adoptionSettled = true; }, () => { adoptionSettled = true; });
    const writer = await blockedBehind(pid, () => adoptionSettled);
    assert.equal(writer.length, 1); assert.match(writer[0]!.query, /settings/);
    process.env.CLASSPILOT_CAP_PRIVATE_CHAT_LIFECYCLE_V1 = "false";
    let operationSettled = false;
    racing = operation === "send"
      ? under(() => storage.createTeacherChatReplyWithDelivery({ ...activityScope, teacherId: own.teacher, content: "Old-image send after adoption" }))
      : operation === "ack"
        ? under(() => storage.acknowledgeTeacherChatDelivery({ ...exactBinding, chatMessageId: pending.message.id, status: "delivered" }))
        : under(() => storage.withClasspilotStudentControlDeliveryAuthority({ ...exactBinding, claimTeacherChatDeliveries: true },
          async () => undefined, rows => ({ messages: rows.map(row => row.message.id) })));
    racing.then(() => { operationSettled = true; }, () => { operationSettled = true; });
    const waiting = await blockedBehind(writer[0]!.pid, () => operationSettled);
    assert.equal(waiting.length, 1); assert.match(waiting[0]!.query, /pg_advisory_xact_lock_shared/);
    await blocker.query("COMMIT"); await adopting;
    if (operation === "send") await assert.rejects(racing, hasCode("PRIVATE_CHAT_DISABLED"));
    else if (operation === "ack") assert.equal(await racing, undefined);
    else assert.deepEqual(await racing, { authorized: true, value: { messages: [] } });
    assert.equal(await under(() => lifecycle.isPrivateChatMessageExpired(pending.message.id, own.school)), true);
    assert.equal((await admin.query("SELECT count(*)::int AS count FROM chat_messages WHERE school_id=$1", [own.school])).rows[0]!.count, 1);
  } finally {
    await blocker.query("ROLLBACK").catch(() => {}); await Promise.allSettled([adopting, racing]); blocker.release();
    process.env.CLASSPILOT_CAP_PRIVATE_CHAT_LIFECYCLE_V1 = "true";
    await under(() => storage.softDeleteSchool(own.school));
  }
});

test("the authorized empty roster exposes tokens and activation rejects old writers and mutable message ownership", async () => {
  const initial = await token();
  assert.equal(initial.threadGeneration, 1);
  assert.equal((await admin.query("SELECT private_chat_lifecycle_required FROM settings WHERE school_id=$1", [ids.school])).rows[0]?.private_chat_lifecycle_required, true);
  await assert.rejects(admin.query("INSERT INTO chat_messages(school_id,session_id,student_id,sender_id,sender_type,content) VALUES($1,$2,$3,$4,'teacher','Old image write')",
    [ids.school, live.id, ids.students[0], ids.teacher]), hasCode("23514"));
  await assert.rejects(admin.query("UPDATE settings SET private_chat_lifecycle_required=false WHERE school_id=$1", [ids.school]), hasCode("23514"));
  const sent = await reply("Immutable private ownership", initial);
  await assert.rejects(admin.query("UPDATE chat_messages SET private_chat_generation=private_chat_generation+1 WHERE id=$1", [sent.message.id]), hasCode("23514"));
  await assert.rejects(admin.query("UPDATE classpilot_private_chat_threads SET student_id=$1 WHERE id=$2", [ids.students[1], initial.threadId]), hasCode("23514"));
});

test("a school without legacy settings stays unstamped in the dark bridge and receives the sticky default row on first adoption", async () => {
  const own = { school: randomUUID(), teacher: randomUUID(), student: randomUUID(), device: randomUUID() };
  const under = <T>(fn: () => Promise<T>) => tenant({ schoolId: own.school }, fn);
  process.env.CLASSPILOT_CAP_PRIVATE_CHAT_LIFECYCLE_V1 = "false";
  try {
    await admin.query("INSERT INTO schools(id,name,domain,status,plan_status) VALUES($1,'Missing settings bridge',$2,'active','active')", [own.school, `${own.school}.example.edu`]);
    await admin.query("INSERT INTO users(id,email,first_name,last_name) VALUES($1,$2,'Missing','Teacher')", [own.teacher, `${own.teacher}@example.edu`]);
    await admin.query("INSERT INTO school_memberships(school_id,user_id,role,status) VALUES($1,$2,'teacher','active')", [own.school, own.teacher]);
    await admin.query("INSERT INTO product_licenses(school_id,product,status) VALUES($1,'CLASSPILOT','active')", [own.school]);
    await admin.query("INSERT INTO students(id,school_id,first_name,last_name,status) VALUES($1,$2,'Missing','Student','active')", [own.student, own.school]);
    await under(() => storage.createDevice({ schoolId: own.school, deviceId: own.device, classId: "default" }));
    const session = await under(() => storage.startStudentSessionWithReplacements(own.school, own.student, own.device,
      { authKind: "manual_shared", sessionRecoveryTokenHash: randomBytes(32).toString("hex") }));
    const group = await under(() => storage.createGroup({ schoolId: own.school, teacherId: own.teacher,
      name: "Missing settings class", groupType: "admin_class", status: "active" }));
    await under(() => database.execute(sql`INSERT INTO group_students(group_id,student_id) VALUES(${group.id},${own.student})`));
    const activity = await under(() => storage.createTeachingSession({ groupId: group.id, teacherId: own.teacher, sessionMode: "live" }));
    const activityScope = { schoolId: own.school, studentId: own.student, teachingSessionId: activity.id };
    const exactBinding = { schoolId: own.school, studentId: own.student, studentSessionId: session.session.id, deviceId: own.device };
    await realtime.writeClasspilotRealtimeStatus({ ...exactBinding, heartbeatId: randomUUID(), observedAt: Date.now(), acceptedCapabilities: capabilities });
    assert.equal((await admin.query("SELECT count(*)::int AS count FROM settings WHERE school_id=$1", [own.school])).rows[0]!.count, 0);
    const sent = await under(() => storage.createTeacherChatReplyWithDelivery({ ...activityScope, teacherId: own.teacher, content: "Missing settings legacy" }));
    assert.equal(sent.message.privateChatThreadId, null);
    assert.equal((await under(() => storage.authorizeClasspilotTeacherCloseChat({ ...activityScope, actorId: own.teacher }))).privateChatLifecycle, undefined);
    assert.equal((await admin.query("SELECT count(*)::int AS count FROM classpilot_private_chat_threads WHERE school_id=$1", [own.school])).rows[0]!.count, 0);
    let release!: () => void, prepared!: (pid: number) => void;
    const held = new Promise<void>(resolve => { release = resolve; }), ready = new Promise<number>(resolve => { prepared = resolve; });
    let adoptionSettled = false, adopting: ReturnType<typeof lifecycle.teacherPrivateChatLifecycles> | undefined;
    const claiming = under(() => storage.withClasspilotStudentControlDeliveryAuthority({ ...exactBinding, claimTeacherChatDeliveries: true }, async connection => {
      const result = await connection.execute<{ pid: number }>(sql`SELECT pg_backend_pid() AS pid`);
      prepared(result.rows[0]!.pid); await held;
    }, claimed => { assert.equal(adoptionSettled, false, "Legacy delivery must finish before adoption commits"); return { messages: claimed.map(row => row.message.id) }; }));
    let adopted: Awaited<ReturnType<typeof lifecycle.teacherPrivateChatLifecycles>>;
    try {
      const pid = await ready;
      process.env.CLASSPILOT_CAP_PRIVATE_CHAT_LIFECYCLE_V1 = "true";
      adopting = under(() => lifecycle.teacherPrivateChatLifecycles(activityScope));
      adopting.then(() => { adoptionSettled = true; }, () => { adoptionSettled = true; });
      const waiting = await blockedBehind(pid, () => adoptionSettled);
      assert.equal(waiting.length, 1, "First adoption must wait for the native legacy delivery transaction even without a settings row");
      assert.match(waiting[0]!.query, /pg_advisory_xact_lock/);
      release(); const legacy = await claiming;
      assert.equal(legacy.authorized, true); if (legacy.authorized) assert.ok(legacy.value.messages.includes(sent.message.id));
      adopted = await adopting;
    } finally { release(); await Promise.allSettled([claiming, adopting]); }
    assert.equal(adopted.privateChatLifecycleRequired, true);
    assert.equal(adopted.privateChatLifecycles[0]!.privateChatLifecycle.threadGeneration, 1);
    const settingsRow = (await admin.query("SELECT private_chat_lifecycle_required,private_chat_epoch FROM settings WHERE school_id=$1", [own.school])).rows[0]!;
    assert.deepEqual(settingsRow, { private_chat_lifecycle_required: true, private_chat_epoch: 1 });
    assert.equal(await under(() => lifecycle.isPrivateChatMessageExpired(sent.message.id, own.school)), true);
  } finally {
    process.env.CLASSPILOT_CAP_PRIVATE_CHAT_LIFECYCLE_V1 = "true";
    await under(() => storage.softDeleteSchool(own.school));
  }
});

test("End permanently expires pending replies, retains history and allows a new explicit generation", async () => {
  const initial = await token(), sent = await reply("Pending before End", initial);
  const ended = await close(initial);
  assert.equal(ended.privateChatLifecycle.threadGeneration, initial.threadGeneration + 1);
  assert.equal(await expired(sent.message.id), true);
  await assert.rejects(reply("Stale delayed Send", initial), hasCode("PRIVATE_CHAT_LIFECYCLE_STALE"));
  const claimed = await claim(); assert.deepEqual(claimed, { authorized: true, value: { messages: [] } });
  const history = await inSchool(() => storage.getChatMessages(live.id, ids.school));
  assert.ok(history.some(row => row.id === sent.message.id));
  const projected = await inSchool(() => lifecycle.projectPrivateChatMessages(history));
  assert.equal(projected.find(row => row.id === sent.message.id)?.deliveryStatus, "expired");
  assert.equal((await reply("Fresh explicit Send", ended.privateChatLifecycle)).message.privateChatGeneration, initial.threadGeneration + 1);
});

test("school hard-off/on advances its epoch once and never revives queued or attempted private replies", async () => {
  const initial = await token(), sent = await reply("Before school off", initial);
  await inSchool(() => storage.markTeacherChatDeliveryAttempt({ ...binding(), chatMessageId: sent.message.id }));
  await admin.query("UPDATE settings SET student_messaging_enabled=false WHERE school_id=$1", [ids.school]);
  await admin.query("UPDATE settings SET student_messaging_enabled=false WHERE school_id=$1", [ids.school]);
  const off = await token(); assert.equal(off.schoolEpoch, initial.schoolEpoch + 1);
  assert.equal(await expired(sent.message.id), true);
  assert.equal(await ack(sent.message.id, initial), undefined);
  assert.equal(await inSchool(() => storage.classpilotTeacherChatAckRejection({ schoolId: ids.school, studentId: ids.students[0]!, chatMessageId: sent.message.id })), "PRIVATE_CHAT_EXPIRED");
  await admin.query("UPDATE settings SET student_messaging_enabled=true WHERE school_id=$1", [ids.school]);
  assert.equal((await token()).schoolEpoch, off.schoolEpoch); assert.equal(await expired(sent.message.id), true);
  await assert.rejects(reply("Old queued retry after on", initial), hasCode("PRIVATE_CHAT_LIFECYCLE_STALE"));
  assert.deepEqual(await claim(), { authorized: true, value: { messages: [] } });
  assert.ok((await reply("Fresh after on")).message.id);
});

test("activity hard-off/on has an independent permanent epoch while testing and teacher pauses remain soft", async () => {
  const initial = await token(1), sent = await reply("Before activity off", initial, 1);
  await admin.query("UPDATE session_settings SET chat_paused=true WHERE school_id=$1 AND supervision_context_id=$2", [ids.school, context.id]);
  assert.deepEqual(await token(1), initial); assert.equal(await expired(sent.message.id), false);
  await admin.query("UPDATE session_settings SET chat_enabled=false WHERE school_id=$1 AND supervision_context_id=$2", [ids.school, context.id]);
  await admin.query("UPDATE session_settings SET chat_enabled=true WHERE school_id=$1 AND supervision_context_id=$2", [ids.school, context.id]);
  const fresh = await token(1); assert.equal(fresh.schoolEpoch, initial.schoolEpoch); assert.equal(fresh.activityEpoch, initial.activityEpoch + 1);
  assert.equal(await expired(sent.message.id), true);
  await assert.rejects(reply("Old scheduled retry", initial, 1), hasCode("PRIVATE_CHAT_LIFECYCLE_STALE"));
});

test("the sticky fence survives capability off while cleanup remains available to unsupported recipients", async () => {
  const initial = await token();
  process.env.CLASSPILOT_CAP_PRIVATE_CHAT_LIFECYCLE_V1 = "false";
  try {
    await assert.rejects(reply("Disabled issuance", initial), hasCode("PRIVATE_CHAT_DISABLED"));
    await assert.rejects(admin.query("INSERT INTO chat_messages(school_id,session_id,student_id,sender_id,sender_type,content) VALUES($1,$2,$3,$4,'teacher','Old rollback writer')",
      [ids.school, live.id, ids.students[0], ids.teacher]), hasCode("23514"));
    assert.equal((await close(initial)).privateChatLifecycle.threadGeneration, initial.threadGeneration + 1);
  } finally { process.env.CLASSPILOT_CAP_PRIVATE_CHAT_LIFECYCLE_V1 = "true"; }
  await refresh(0, ["scopedAuthorityChecksV1", "studentChatIdempotencyV1"]);
  const unsupported = await token(); await assert.rejects(reply("Advertised is not negotiated", unsupported), hasCode("PRIVATE_CHAT_UPDATE_REQUIRED"));
  assert.equal((await close(unsupported)).privateChatLifecycle.threadGeneration, unsupported.threadGeneration + 1);
});

test("an authorized signed-out recipient can still be ended using its exact token", async () => {
  const initial = await token();
  await inSchool(() => storage.endStudentSessionExact(binding()));
  try {
    const state = await inSchool(() => lifecycle.teacherPrivateChatLifecycles(scope()));
    assert.equal(state.privateChatLifecycles.find(row => row.studentId === ids.students[0])?.supported, false);
    assert.equal((await close(initial)).privateChatLifecycle.threadGeneration, initial.threadGeneration + 1);
  } finally {
    recoveryHashes[0] = randomBytes(32).toString("hex");
    bindings[0] = (await inSchool(() => storage.startStudentSessionWithReplacements(ids.school, ids.students[0]!, ids.devices[0]!,
      { authKind: "manual_shared", sessionRecoveryTokenHash: recoveryHashes[0]! }))).session.id;
    await refresh(0);
  }
});

test("End preserves already delivered history while expiring another queued reply", async () => {
  const initial = await token(), delivered = await reply("Already delivered", initial), pending = await reply("Still queued", initial);
  await inSchool(() => storage.markTeacherChatDeliveryAttempt({ ...binding(), chatMessageId: delivered.message.id }));
  assert.ok(await ack(delivered.message.id, initial));
  await close(initial);
  const history = await inSchool(() => storage.getChatMessages(live.id, ids.school));
  const projected = await inSchool(() => lifecycle.projectPrivateChatMessages(history));
  assert.equal(projected.find(row => row.id === delivered.message.id)?.deliveryStatus, "delivered");
  assert.equal(projected.find(row => row.id === pending.message.id)?.deliveryStatus, "expired");
});

test("student retries echo the current token and an old retry cannot reopen a closed conversation", async () => {
  const initial = await token(), clientMessageId = randomUUID();
  const send = (expectedPrivateChatLifecycle: PrivateChatLifecycle) => inSchool(() => storage.createAuthorizedClasspilotStudentMessage({
    ...binding(), teachingSessionId: live.id, clientMessageId, content: "Synthetic student question", expectedPrivateChatLifecycle }));
  const first = await send(initial), duplicate = await send(initial);
  assert.equal(first.created, true); assert.equal(duplicate.created, false); assert.equal(duplicate.message.id, first.message.id);
  await close(initial); await assert.rejects(send(initial), hasCode("PRIVATE_CHAT_LIFECYCLE_STALE"));
});

test("reconnect snapshots carry the current school/activity/thread generation without replaying expired private deliveries", async () => {
  const initial = await token(), sent = await reply("Offline pending", initial);
  const ended = await close(initial);
  const state = await inSchool(() => fab.buildStudentFabState(ids.school, ids.students[0]!, { acceptedCapabilities: capabilities }));
  assert.deepEqual(state.privateChatLifecycleState?.threads[0], { ...ended.privateChatLifecycle, teachingSessionId: live.id, supervisionContextId: null });
  assert.deepEqual(await claim(), { authorized: true, value: { messages: [] } });
  assert.equal(await expired(sent.message.id), true);
});

for (const operation of ["send", "ack"] as const) for (const first of ["close", operation] as const) test(`real PG ${first}-first race serializes End and ${operation} at the same student/thread fence`, async () => {
  const initial = await token(); const blocker = await admin.connect();
  const sent = operation === "ack" ? await reply("Native ACK race", initial) : undefined;
  if (sent) await inSchool(() => storage.markTeacherChatDeliveryAttempt({ ...binding(), chatMessageId: sent.message.id }));
  const issue = () => operation === "send" ? reply("Racing native Send", initial) : ack(sent!.message.id, initial);
  let firstCall: Promise<unknown> | undefined, secondCall: Promise<unknown> | undefined;
  try {
    await blocker.query("BEGIN"); await blocker.query("SELECT id FROM classpilot_private_chat_threads WHERE id=$1 FOR UPDATE", [initial.threadId]);
    const pid = (await blocker.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]!.pid;
    let firstSettled = false;
    firstCall = first === "close" ? close(initial) : issue();
    firstCall.then(() => { firstSettled = true; }, () => { firstSettled = true; });
    const waiting = await blockedBehind(pid, () => firstSettled);
    assert.equal(waiting.length, 1); assert.match(waiting[0]!.query, /classpilot_private_chat_threads/);
    let secondSettled = false;
    secondCall = first === "close" ? issue() : close(initial);
    secondCall.then(() => { secondSettled = true; }, () => { secondSettled = true; });
    const serialized = await blockedBehind(waiting[0]!.pid, () => secondSettled);
    assert.equal(serialized.length, 1); assert.match(serialized[0]!.query, /pg_advisory_xact_lock/);
    await blocker.query("COMMIT"); const firstResult = await firstCall;
    if (first === "close" && operation === "send") await assert.rejects(secondCall, hasCode("PRIVATE_CHAT_LIFECYCLE_STALE"));
    else if (first === "close") assert.equal(await secondCall, undefined);
    else { if (operation === "ack") assert.ok(firstResult); await secondCall; }
    assert.equal((await token()).threadGeneration, initial.threadGeneration + 1);
    assert.deepEqual(await claim(), { authorized: true, value: { messages: [] } });
  } finally { await blocker.query("ROLLBACK").catch(() => {}); await Promise.allSettled([firstCall, secondCall]); blocker.release(); }
});

test("changing the signed-in student on the same device cannot receive or ACK the previous student's private reply", async () => {
  const initial = await token(), sent = await reply("Private before student switch", initial), oldBinding = binding();
  await inSchool(() => storage.markTeacherChatDeliveryAttempt({ ...oldBinding, chatMessageId: sent.message.id }));
  await inSchool(() => storage.endStudentSessionExact(oldBinding));
  await inSchool(() => storage.endStudentSessionExact(binding(2)));
  const ownDevice = ids.devices[2]!;
  try {
    ids.devices[2] = ids.devices[0]!;
    recoveryHashes[2] = randomBytes(32).toString("hex");
    bindings[2] = (await inSchool(() => storage.startStudentSessionWithReplacements(ids.school, ids.students[2]!, ids.devices[2]!,
      { authKind: "manual_shared", sessionRecoveryTokenHash: recoveryHashes[2]! }))).session.id;
    await refresh(2);
    assert.equal(await inSchool(() => storage.acknowledgeTeacherChatDelivery({ ...oldBinding, chatMessageId: sent.message.id,
      status: "delivered", privateChatLifecycle: initial })), undefined);
    assert.equal(await ack(sent.message.id, initial, 2), undefined);
    const claimed = await claim(2); assert.equal(claimed.authorized, true);
    if (claimed.authorized) assert.ok(!claimed.value.messages.includes(sent.message.id));
    const state = (await admin.query("SELECT delivery_status FROM chat_messages WHERE id=$1", [sent.message.id])).rows[0]!;
    assert.equal(state.delivery_status, "sent");
  } finally {
    await inSchool(() => storage.endStudentSessionExact(binding(2)));
    ids.devices[2] = ownDevice;
    for (const index of [0, 2]) {
      recoveryHashes[index] = randomBytes(32).toString("hex");
      bindings[index] = (await inSchool(() => storage.startStudentSessionWithReplacements(ids.school, ids.students[index]!, ids.devices[index]!,
        { authKind: "manual_shared", sessionRecoveryTokenHash: recoveryHashes[index]! }))).session.id;
      await refresh(index);
    }
  }
});

test("a claim already in its native transaction finishes before End commits; its late ACK is permanently refused", async () => {
  const initial = await token(), sent = await reply("Claim before End", initial);
  let release!: () => void, prepared!: (pid: number) => void;
  const held = new Promise<void>(resolve => { release = resolve; }), ready = new Promise<number>(resolve => { prepared = resolve; });
  let closed = false, ending: ReturnType<typeof close> | undefined;
  const claiming = inSchool(() => storage.withClasspilotStudentControlDeliveryAuthority({ ...binding(), claimTeacherChatDeliveries: true }, async connection => {
    const result = await connection.execute<{ pid: number }>(sql`SELECT pg_backend_pid() AS pid`);
    prepared(result.rows[0]!.pid); await held;
  }, rows => { assert.equal(closed, false); return { messages: rows.map(row => row.message.id) }; }));
  try {
    const pid = await ready; let settled = false;
    ending = close(initial); ending.then(() => { settled = true; }, () => { settled = true; });
    assert.equal((await blockedBehind(pid, () => settled)).length, 1);
    release(); const claimed = await claiming; assert.equal(claimed.authorized, true);
    if (claimed.authorized) assert.ok(claimed.value.messages.includes(sent.message.id));
    await ending; closed = true;
    assert.equal(await ack(sent.message.id, initial), undefined);
  } finally { release(); await Promise.allSettled([claiming, ending]); }
});

for (const operation of ["send", "claim", "ack"] as const) test(`school hard-off racing ${operation} is observed after the actual settings-row lock wait`, async () => {
  const initial = await token(), sent = await reply(`Before native ${operation}`, initial);
  await inSchool(() => storage.markTeacherChatDeliveryAttempt({ ...binding(), chatMessageId: sent.message.id }));
  const writer = await admin.connect(); let racing: Promise<unknown> | undefined;
  try {
    await writer.query("BEGIN"); await writer.query("UPDATE settings SET student_messaging_enabled=false WHERE school_id=$1", [ids.school]);
    const pid = (await writer.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]!.pid;
    let settled = false;
    racing = operation === "send" ? reply("Send behind off", initial) : operation === "claim" ? claim() : ack(sent.message.id, initial);
    racing.then(() => { settled = true; }, () => { settled = true; });
    const waiting = await blockedBehind(pid, () => settled);
    assert.equal(waiting.length, 1); assert.match(waiting[0]!.query, /settings|private_chat_lifecycle_required/);
    await writer.query("COMMIT");
    if (operation === "send") await assert.rejects(racing, hasCode("FAB_FEATURE_DISABLED"));
    else if (operation === "claim") assert.deepEqual(await racing, { authorized: true, value: { messages: [] } });
    else assert.equal(await racing, undefined);
    assert.equal(await expired(sent.message.id), true);
  } finally { await writer.query("ROLLBACK").catch(() => {}); await racing?.catch(() => {}); writer.release(); }
});

test("ANNOUNCEMENTS retain their independent exact-student inbox while the private channel is hard-off", async () => {
  const initial = await token(); await reply("Private before announcement", initial);
  await admin.query("UPDATE settings SET student_messaging_enabled=false WHERE school_id=$1", [ids.school]);
  const dispatcher = await import("../src/services/classpilotCommandDispatcher.js");
  const issued = await inSchool(() => dispatcher.executeClasspilotCommand({ schoolId: ids.school, actorId: ids.teacher,
    teachingSessionId: live.id, targetScope: "students", commandType: "teacher-message", rawCommandPayload: { message: "Separate ANNOUNCEMENT" },
    targets: [{ ...binding(), studentName: "Private Student", available: true, stateAuthorized: true }] }));
  const inbox = await inSchool(() => storage.getPendingMessagesForStudent(binding()));
  assert.ok(inbox.some(message => message.commandId === issued.command.id && message.message === "Separate ANNOUNCEMENT"));
  assert.deepEqual(await claim(), { authorized: true, value: { messages: [] } });
});

test("a released and reclaimed scheduled assignment gets a new protected thread and cannot revive its old queued reply", async () => {
  const initial = await token(1), sent = await reply("Before assignment release", initial, 1);
  await inSchool(() => storage.markTeacherChatDeliveryAttempt({ ...binding(1), chatMessageId: sent.message.id }));
  await inSchool(() => storage.releaseSupervisionStudents({ schoolId: ids.school, contextId: context.id, studentIds: [ids.students[1]!],
    scheduledClassroomAuthority: { actorId: ids.teacher, contextAuthorityRevision: String(context.classroomAuthorityRevision) } }));
  assert.equal(await expired(sent.message.id), true);
  assert.equal(await ack(sent.message.id, initial, 1), undefined);
  await inSchool(() => storage.assignStudentsToSupervisionContext({ schoolId: ids.school, contextId: context.id,
    studentIds: [ids.students[1]!], assignedBy: ids.teacher }));
  const fresh = await token(1); assert.notEqual(fresh.threadId, initial.threadId);
  assert.equal(await expired(sent.message.id), true);
  assert.equal(await ack(sent.message.id, initial, 1), undefined);
  await assert.rejects(reply("Old assignment Send", initial, 1), hasCode("PRIVATE_CHAT_LIFECYCLE_STALE"));
  assert.ok((await reply("Fresh assignment Send", fresh, 1)).message.id);
});

test("a student binding transfer refuses the old device's ACK and reconnects the current generation to the new exact binding", async () => {
  const initial = await token(), sent = await reply("Before binding transfer", initial);
  const oldBinding = binding(); await inSchool(() => storage.markTeacherChatDeliveryAttempt({ ...oldBinding, chatMessageId: sent.message.id }));
  bindings[0] = (await inSchool(() => storage.startStudentSessionWithReplacements(ids.school, ids.students[0]!, ids.devices[0]!,
    { authKind: "manual_shared", sessionRecoveryTokenHash: randomBytes(32).toString("hex"),
      reclaimRecoveryTokenHash: recoveryHashes[0]! }))).session.id;
  assert.notEqual(bindings[0], oldBinding.studentSessionId); await refresh(0);
  assert.equal(await inSchool(() => storage.acknowledgeTeacherChatDelivery({ ...oldBinding, chatMessageId: sent.message.id, status: "delivered", privateChatLifecycle: initial })), undefined);
  await admin.query("UPDATE classpilot_chat_deliveries SET next_attempt_at=now() WHERE id=$1", [sent.delivery.id]);
  const claimed = await claim(); assert.equal(claimed.authorized, true);
  if (claimed.authorized) assert.ok(claimed.value.messages.includes(sent.message.id));
  assert.ok(await ack(sent.message.id, initial));
});

test("Redis private relay delivers a current durable attempt, but End rejects its delayed predecessor on the same live binding", async () => {
  const old = await relayFrame("Delayed Redis reply before End");
  const exactBinding = binding();
  const ended = await close(old.frame.privateChatLifecycle!);
  assert.deepEqual(binding(), exactBinding);
  assert.equal(await expired(old.sent.message.id), true);
  await withStudentSocket(0, capabilities, async ({ inbox, drain }) => {
    const allowed = await relay(old.frame); await drain();
    assert.deepEqual({ allowed, inbox }, { allowed: false, inbox: [] }, "Committed End must fence a delayed Redis frame even while its student session remains current");
    const fresh = await relayFrame("Fresh Redis reply after End");
    assert.equal(fresh.frame.privateChatLifecycle?.threadGeneration, ended.privateChatLifecycle.threadGeneration);
    assert.equal(await relay(fresh.frame), true); await drain();
    assert.deepEqual(inbox.map(raw => JSON.parse(raw)), [fresh.frame]);
  });
});

for (const index of [0, 1]) test(`Redis private relay positively delivers a current ${index === 0 ? "live" : "scheduled"} durable attempt`, async () => {
  const current = await relayFrame(`Current relay control for activity ${index}`, index);
  await withStudentSocket(index, capabilities, async ({ inbox, drain }) => {
    assert.equal(await relay(current.frame, index), true); await drain();
    assert.deepEqual(inbox.map(raw => JSON.parse(raw)), [current.frame]);
  });
});

for (const channel of ["school", "activity"] as const) test(`Redis private relay refuses delayed ${channel} hard-off/on frames while ANNOUNCEMENTS remain independent`, async () => {
  const index = channel === "school" ? 0 : 1;
  const old = await relayFrame(`Delayed Redis reply before ${channel} off`, index);
  const toggle = (enabled: boolean) => channel === "school"
    ? admin.query("UPDATE settings SET student_messaging_enabled=$2 WHERE school_id=$1", [ids.school, enabled])
    : admin.query("UPDATE session_settings SET chat_enabled=$3 WHERE school_id=$1 AND supervision_context_id=$2", [ids.school, context.id, enabled]);
  await toggle(false);
  try {
    await withStudentSocket(index, capabilities, async ({ inbox, drain }) => {
      assert.equal(await relay(old.frame, index), false); await drain(); assert.deepEqual(inbox, []);
      const announcement = { type: "teacher-message", commandId: randomUUID(), message: "Separate ANNOUNCEMENT while private off",
        studentId: ids.students[index]!, studentSessionId: bindings[index]! };
      assert.equal(await relay(announcement, index), true); await drain();
      assert.deepEqual(inbox.map(raw => JSON.parse(raw)), [announcement]);
      await toggle(true);
      assert.equal(await relay(old.frame, index), false); await drain(); assert.equal(inbox.length, 1);
      const current = await relayFrame(`Current ${channel} reply after on`, index);
      assert.equal(await relay(current.frame, index), true); await drain();
      assert.deepEqual(inbox.map(raw => JSON.parse(raw)), [announcement, current.frame]);
    });
  } finally { await toggle(true); }
});

test("Redis private relay verifies durable message IDs, content, scope, lifecycle and attempted binding rather than trusting its envelope", async t => {
  const variants = ["missing lifecycle", "forged generation", "wrong lifecycle thread", "private announcement disguise", "unknown message", "conflicting message IDs", "conflicting dedup ID", "wrong student",
    "wrong session", "wrong activity", "extra activity", "changed content", "missing message ID", "wrong attempted binding", "expired attempt"] as const;
  for (const variant of variants) await t.test(variant, async () => {
    const candidate = await relayFrame(`Synthetic relay integrity: ${variant}`);
    const frame: Record<string, unknown> = { ...candidate.frame };
    if (variant === "missing lifecycle") delete frame.privateChatLifecycle;
    if (variant === "forged generation") {
      const ended = await close(candidate.frame.privateChatLifecycle!);
      frame.privateChatLifecycle = ended.privateChatLifecycle;
    }
    if (variant === "wrong lifecycle thread") frame.privateChatLifecycle = { ...candidate.frame.privateChatLifecycle!, threadId: randomUUID() };
    if (variant === "private announcement disguise") {
      await close(candidate.frame.privateChatLifecycle!);
      frame.commandId = randomUUID(); frame.messageKind = "announcement";
    }
    if (variant === "unknown message") frame.chatMessageId = frame.messageId = randomUUID();
    if (variant === "conflicting message IDs") frame.messageId = randomUUID();
    if (variant === "conflicting dedup ID") frame._msgId = randomUUID();
    if (variant === "wrong student") frame.studentId = ids.students[1]!;
    if (variant === "wrong session") frame.studentSessionId = randomUUID();
    if (variant === "wrong activity") frame.sessionId = randomUUID();
    if (variant === "extra activity") frame.supervisionContextId = context.id;
    if (variant === "changed content") frame.message = "Envelope content was substituted";
    if (variant === "missing message ID") { delete frame.chatMessageId; delete frame.messageId; }
    if (variant === "wrong attempted binding") await admin.query("UPDATE classpilot_chat_deliveries SET last_attempt_student_session_id=$2 WHERE id=$1", [candidate.sent.delivery.id, randomUUID()]);
    if (variant === "expired attempt") await admin.query("UPDATE classpilot_chat_deliveries SET expires_at=now()-interval '1 second' WHERE id=$1", [candidate.sent.delivery.id]);
    await withStudentSocket(0, capabilities, async ({ inbox, drain }) => {
      const allowed = await relay(frame); await drain();
      assert.deepEqual({ allowed, inbox }, { allowed: false, inbox: [] }, `A ${variant} frame must not override the durable private reply`);
    });
  });
});

test("Redis private relay cannot waive local socket lifecycle capability with an empty envelope requirement", async () => {
  const current = await relayFrame("Private reply for capability-fenced socket");
  const olderCapabilities = capabilities.filter(capability => capability !== "privateChatLifecycleV1");
  await withStudentSocket(0, olderCapabilities, async ({ inbox, drain }) => {
    const allowed = await relay(current.frame); await drain();
    assert.deepEqual({ allowed, inbox }, { allowed: false, inbox: [] });
    const announcement = { type: "teacher-message", commandId: randomUUID(), message: "ANNOUNCEMENT supports older client",
      studentId: ids.students[0]!, studentSessionId: bindings[0]! };
    assert.equal(await relay(announcement), true); await drain();
    assert.deepEqual(inbox.map(raw => JSON.parse(raw)), [announcement]);
  });
  await withStudentSocket(0, capabilities, async ({ inbox, drain }) => {
    assert.equal(await relay(current.frame), true); await drain();
    assert.deepEqual(inbox.map(raw => JSON.parse(raw)), [current.frame]);
  });
});

test("Redis private relay waits for a racing school hard-off commit before local delivery", async () => {
  const current = await relayFrame("Redis frame blocked behind school hard-off");
  const writer = await admin.connect(); let receiving: Promise<boolean> | undefined;
  try {
    await withStudentSocket(0, capabilities, async ({ inbox, drain }) => {
      await writer.query("BEGIN"); await writer.query("UPDATE settings SET student_messaging_enabled=false WHERE school_id=$1", [ids.school]);
      const pid = (await writer.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]!.pid;
      let settled = false;
      receiving = relay(current.frame); receiving.then(() => { settled = true; }, () => { settled = true; });
      const waiting = await blockedBehind(pid, () => settled);
      assert.equal(waiting.length, 1, "The receiver must actually wait behind the uncommitted hard-off authority");
      await writer.query("COMMIT");
      assert.equal(await receiving, false); await drain(); assert.deepEqual(inbox, []);
    });
  } finally {
    await writer.query("ROLLBACK").catch(() => {}); await receiving?.catch(() => {}); writer.release();
    await admin.query("UPDATE settings SET student_messaging_enabled=true WHERE school_id=$1", [ids.school]);
  }
});

test("Redis private relay rechecks the real expiry after a held final exact-binding SELECT", async t => {
  const current = await relayFrame("Private reply expiring across the final binding read");
  await admin.query("UPDATE classpilot_chat_deliveries SET expires_at=clock_timestamp()+interval '3 seconds' WHERE id=$1", [current.sent.delivery.id]);
  const query = pg.Client.prototype.query;
  let bindingReads = 0, announceHeld: () => void = () => {}, release: () => void = () => {};
  const reached = new Promise<void>(resolve => { announceHeld = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  // Delay transport of one query, not its result: the real query executes
  // afterward against PostgreSQL with every previously acquired lock held.
  const mock = t.mock.method(pg.Client.prototype, "query", function(this: pg.Client, ...args: unknown[]) {
    const request = args[0];
    const statement = typeof request === "string" ? request
      : request && typeof request === "object" && "text" in request ? String(request.text) : "";
    if (/select "student_sessions"\."id" from "student_sessions" inner join "students"/.test(statement)
      && /inner join "devices"/.test(statement) && /for share/i.test(statement) && ++bindingReads === 2) {
      announceHeld(); return held.then(() => Reflect.apply(query, this, args));
    }
    return Reflect.apply(query, this, args);
  });
  let receiving: Promise<boolean> | undefined;
  try {
    await withStudentSocket(0, capabilities, async ({ inbox, drain }) => {
      receiving = relay(current.frame);
      await Promise.race([reached, pause(5_000, undefined, { ref: false }).then(() => assert.fail("The final native binding query must reach the controlled hold"))]);
      assert.equal(bindingReads, 2);
      const before = await admin.query<{ live: boolean }>("SELECT expires_at>clock_timestamp() AS live FROM classpilot_chat_deliveries WHERE id=$1", [current.sent.delivery.id]);
      assert.equal(before.rows[0]!.live, true, "The prepared attempt must still be live when its final binding read is held");
      let expiredAtDatabase = false;
      for (const deadline = Date.now()+5_000; Date.now()<deadline && !expiredAtDatabase;) {
        expiredAtDatabase = !(await admin.query<{ live: boolean }>("SELECT expires_at>clock_timestamp() AS live FROM classpilot_chat_deliveries WHERE id=$1", [current.sent.delivery.id])).rows[0]!.live;
        if (!expiredAtDatabase) await pause(10);
      }
      assert.equal(expiredAtDatabase, true);
      release();
      const allowed = await receiving; await drain();
      assert.deepEqual({ allowed, inbox }, { allowed: false, inbox: [] });
    });
  } finally { release(); await receiving?.catch(() => {}); mock.mock.restore(); }
});
