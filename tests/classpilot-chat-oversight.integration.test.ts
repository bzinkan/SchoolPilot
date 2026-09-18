import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { chatMessages, classpilotChatDeliveries } from "../src/schema/classpilot.js";
import { CLASSPILOT_CHAT_CHANNEL_CONTROL_SQL } from "../src/db/classpilotChatChannelControlMigration.js";
import { CLASSPILOT_CHAT_SEEN_STATE_SQL } from "../src/db/classpilotChatSeenStateMigration.js";

process.env.REDIS_URL = "";
process.env.CLASSPILOT_SCHEDULED_CLASSROOM_MODE = "on";
delete process.env.CLASSPILOT_SCHEDULED_CLASSROOM_SCHOOL_IDS;
delete process.env.CLASSPILOT_SCHEDULED_CLASSROOM_EXCLUDED_SCHOOL_IDS;

const ids = { school: randomUUID(), teacher: randomUUID(), otherTeacher: randomUUID(), student: randomUUID(), device: randomUUID(),
  group: randomUUID(), session: randomUUID() };
let database: typeof import("../src/db.js").default;
let pool: typeof import("../src/db.js").pool;
let storage: typeof import("../src/services/storage.js");
let tools: typeof import("../src/services/classpilotScheduledClassroomTools.js");
let tenant: typeof import("../src/middleware/tenantContext.js").runWithTenantContext;
let context: import("../src/schema/classpilot.js").ClasspilotSupervisionContext;
let bindingId: string;
const inSchool = <T>(fn: () => Promise<T>) => tenant({ schoolId: ids.school }, fn);
const statement = (query: ReturnType<typeof sql>) => inSchool(() => database.execute(query));
const control = () => inSchool(() => storage.getClasspilotStudentControlState(ids.school, ids.student));
const ts = (value: unknown) => (value === null || value === undefined ? null : new Date(String(value)).getTime());
const binding = () => ({ schoolId: ids.school, studentId: ids.student, studentSessionId: bindingId, deviceId: ids.device });
const ack = async (chatMessageId: string, status: "delivered" | "failed" | "seen", errorMessage?: string) => inSchool(async () =>
  storage.acknowledgeTeacherChatDelivery({ ...binding(), chatMessageId, status, errorMessage, studentControlRevision: (await control())!.revision }));
const reply = (content: string) => inSchool(() => tools.createScheduledTeacherReply({ schoolId: ids.school, contextId: context.id,
  actorId: ids.teacher, studentId: ids.student, content }));
const studentMessage = async (content: string) => inSchool(async () => tools.createScheduledStudentMessage({ schoolId: ids.school,
  supervisionContextId: context.id, studentId: ids.student, studentSessionId: bindingId, deviceId: ids.device,
  studentControlRevision: (await control())!.revision, content, clientMessageId: randomUUID() }));
// Read through Drizzle so tz-less and tz columns both come back as consistent Dates (raw execute returns local-time strings).
const messageRow = (id: string) => inSchool(async () => (await database.select({ delivery_status: chatMessages.deliveryStatus,
  delivered_at: chatMessages.deliveredAt, seen_at: chatMessages.seenAt, read_at: chatMessages.readAt, read_by: chatMessages.readBy,
  error_message: chatMessages.errorMessage }).from(chatMessages).where(eq(chatMessages.id, id)))[0]!);
const outboxRow = (chatMessageId: string) => inSchool(async () => (await database.select({ state: classpilotChatDeliveries.state,
  delivered_at: classpilotChatDeliveries.deliveredAt, last_error: classpilotChatDeliveries.lastError })
  .from(classpilotChatDeliveries).where(eq(classpilotChatDeliveries.chatMessageId, chatMessageId)))[0]!);

before(async () => {
  assert.ok(["localhost", "127.0.0.1", "::1"].includes(new URL(process.env.DATABASE_URL || "").hostname), "Chat oversight requires the local fixture");
  process.env.DATABASE_URL_PRIVILEGED = process.env.DATABASE_URL;
  ({ default: database, pool } = await import("../src/db.js"));
  ({ runWithTenantContext: tenant } = await import("../src/middleware/tenantContext.js"));
  storage = await import("../src/services/storage.js");
  tools = await import("../src/services/classpilotScheduledClassroomTools.js");
  await pool.query(CLASSPILOT_CHAT_CHANNEL_CONTROL_SQL);
  await pool.query(CLASSPILOT_CHAT_SEEN_STATE_SQL);
  await pool.query("INSERT INTO schools(id,name,domain,status,plan_status) VALUES($1,'Chat oversight',$2,'active','active')", [ids.school, `${ids.school}.example.edu`]);
  for (const id of [ids.teacher, ids.otherTeacher]) {
    await pool.query("INSERT INTO users(id,email,first_name,last_name) VALUES($1,$2,'Oversight','Teacher')", [id, `${id}@${ids.school}.example.edu`]);
    await pool.query("INSERT INTO school_memberships(school_id,user_id,role,status) VALUES($1,$2,'teacher','active')", [ids.school, id]);
  }
  await pool.query("INSERT INTO product_licenses(school_id,product,status) VALUES($1,'CLASSPILOT','active')", [ids.school]);
  await statement(sql`INSERT INTO settings(school_id,school_name,ws_shared_key,enable_tracking_hours,after_hours_mode,pause_chat_during_testing)
    VALUES(${ids.school},'Chat oversight','test-only',false,'off',false)`);
  await statement(sql`INSERT INTO students(id,school_id,first_name,last_name,status) VALUES(${ids.student},${ids.school},'Test','Student','active')`);
  await inSchool(async () => {
    await storage.createDevice({ schoolId: ids.school, deviceId: ids.device, classId: "default", deviceName: "Test Chromebook" });
    bindingId = (await storage.startStudentSessionWithReplacements(ids.school, ids.student, ids.device,
      { authKind: "manual_shared", sessionRecoveryTokenHash: "d".repeat(64) })).session.id;
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
  await pool.query("DELETE FROM users WHERE id IN($1,$2)", [ids.teacher, ids.otherTeacher]);
  await (await import("../src/services/errorMonitor.js")).default.disposeAndWait();
  (await import("../src/services/classpilotRealtimeStatus.js")).setClasspilotRealtimeStatusCommandForTests(undefined);
  const scheduler = await import("../src/services/schedulerDb.js");
  await Promise.all([pool.end(), (await import("../src/db.js")).sessionPool.end(), scheduler.schedulerPool.end(), scheduler.schedulerLockPool.end()]);
});

test("seen is terminal on the message while the outbox settles at delivered, and a seen ack proves delivery", async () => {
  const first = await reply("Eyes on your own test");
  assert.equal((await inSchool(() => storage.claimDueTeacherChatDeliveriesForBinding(binding()))).length, 1, "the reply is claimed for this binding");
  assert.ok(await ack(first.message.id, "delivered"));
  let row = await messageRow(first.message.id);
  assert.equal(row.delivery_status, "delivered");
  assert.ok(row.delivered_at);
  const deliveredAt = row.delivered_at;
  assert.ok(await ack(first.message.id, "seen"));
  row = await messageRow(first.message.id);
  assert.equal(row.delivery_status, "seen");
  assert.ok(row.seen_at);
  assert.equal(ts(row.delivered_at), ts(deliveredAt), "seen keeps the original delivery time");
  const seenAt = row.seen_at;
  assert.equal((await outboxRow(first.message.id)).state, "delivered");

  assert.ok(await ack(first.message.id, "delivered"), "a repeat delivered ack is accepted as a no-op");
  assert.ok(await ack(first.message.id, "failed", "late failure"), "a late failure is accepted as a no-op");
  row = await messageRow(first.message.id);
  assert.deepEqual([row.delivery_status, ts(row.seen_at), row.error_message], ["seen", ts(seenAt), null], "nothing regresses seen");
  assert.deepEqual([(await outboxRow(first.message.id)).state, (await outboxRow(first.message.id)).last_error], ["delivered", null]);

  const second = await reply("Still there?");
  await inSchool(() => storage.claimDueTeacherChatDeliveriesForBinding(binding()));
  assert.ok(await ack(second.message.id, "seen"));
  row = await messageRow(second.message.id);
  assert.equal(row.delivery_status, "seen");
  assert.ok(row.delivered_at, "a seen ack without a prior delivered ack backfills deliveredAt");
  assert.equal(ts(row.delivered_at), ts(row.seen_at));
  assert.equal((await outboxRow(second.message.id)).state, "delivered");
});

test("a refused ack says whether it can ever succeed", async () => {
  const third = await reply("Refused ack probe");
  await inSchool(() => storage.claimDueTeacherChatDeliveriesForBinding(binding()));
  assert.equal(await inSchool(() => storage.acknowledgeTeacherChatDelivery({ ...binding(), chatMessageId: third.message.id, status: "seen", studentControlRevision: -1 })), undefined);
  assert.equal(await inSchool(() => storage.classpilotTeacherChatAckRejection({ schoolId: ids.school, chatMessageId: third.message.id, studentId: ids.student })), "CHAT_ACK_STALE");
  assert.equal(await inSchool(() => storage.classpilotTeacherChatAckRejection({ schoolId: ids.school, chatMessageId: randomUUID(), studentId: ids.student })), "CHAT_MESSAGE_NOT_FOUND");
  assert.equal((await messageRow(third.message.id)).delivery_status, "sent", "a refused ack changes nothing");
});

test("read marking is idempotent, teacher-only, and scoped to the caller's classroom authority", async () => {
  const asked = await studentMessage("can we go gym still?");
  const askedAgain = await studentMessage("MR.ZZZZ!!!!!!!");
  const teacherLine = await reply("Not today");
  const mark = (messageIds: string[], authority: { sessionId: string } | { supervisionContextId: string }, actorId = ids.teacher) =>
    inSchool(() => storage.markAuthorizedClasspilotStudentMessagesRead({ schoolId: ids.school, actorId, messageIds, authority }));

  const first = await mark([asked.message.id, teacherLine.message.id, randomUUID()], { supervisionContextId: context.id });
  assert.deepEqual(first.updatedIds, [asked.message.id], "teacher rows and unknown ids are ignored");
  let row = await messageRow(asked.message.id);
  assert.equal(row.read_by, ids.teacher);
  assert.ok(Math.abs((ts(row.read_at) ?? 0) - first.readAt.getTime()) < 1000, "read_at is the returned readAt (column precision aside)");
  assert.equal((await messageRow(teacherLine.message.id)).read_at, null);

  const second = await mark([asked.message.id, askedAgain.message.id], { supervisionContextId: context.id }, ids.otherTeacher);
  assert.deepEqual(second.updatedIds, [askedAgain.message.id], "already-read rows are not rewritten");
  row = await messageRow(asked.message.id);
  assert.equal(row.read_by, ids.teacher, "the first reader stays on record");

  const wrongAuthority = await mark([askedAgain.message.id], { sessionId: ids.session });
  assert.deepEqual(wrongAuthority.updatedIds, [], "a class-session authority cannot read a scheduled classroom's messages");
  assert.deepEqual((await mark([], { supervisionContextId: context.id })).updatedIds, []);
});
