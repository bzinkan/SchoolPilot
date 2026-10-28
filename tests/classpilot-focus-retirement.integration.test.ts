import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { after, before, beforeEach, describe, test } from "node:test";
import pg from "pg";
import { sql } from "drizzle-orm";
import { WebSocket, WebSocketServer } from "ws";
import { focusRecord, focusServerOrigin, readFocusAssignment, readFocusOpenIntent, readFocusRestriction, withoutClasspilotFocus } from "../src/services/classpilotFocus.js";

process.env.REDIS_URL = "";
process.env.CLASSPILOT_SCHEDULED_CLASSROOM_MODE = "on";
process.env.CLASSPILOT_PROTOCOL_V3_ENABLED = "true";
process.env.CLASSPILOT_CAP_SCOPED_AUTHORITY_CHECKS_V1 = "true";
process.env.CLASSPILOT_CAP_FOCUS_TAB_V1 = "true";
delete process.env.CLASSPILOT_CAPABILITY_ROLLOUTS_JSON;
delete process.env.CLASSPILOT_SCHEDULED_CLASSROOM_SCHOOL_IDS;
delete process.env.CLASSPILOT_SCHEDULED_CLASSROOM_EXCLUDED_SCHOOL_IDS;

const ids = { school: randomUUID(), otherSchool: randomUUID(), teacher: randomUUID(), students: [randomUUID(), randomUUID()], devices: [randomUUID(), randomUUID()] };
const capabilities = ["scopedAuthorityChecksV1", "scheduledClassroomV1", "focusTabV1"];
const refs = ["student-one-exact-tab", "student-two-exact-tab"];
let admin: pg.Pool;
let controlWasForced = false;
let database: typeof import("../src/db.js").default;
let storage: typeof import("../src/services/storage.js");
let dispatcher: typeof import("../src/services/classpilotCommandDispatcher.js");
let realtime: typeof import("../src/services/classpilotRealtimeStatus.js");
let tenant: typeof import("../src/middleware/tenantContext.js").runWithTenantContext;
let context: import("../src/schema/classpilot.js").ClasspilotSupervisionContext;
const sessions: string[] = [];
const inSchool = <T>(fn: () => Promise<T>) => tenant({ schoolId: ids.school }, fn);
const target = (index: number) => ({ studentId: ids.students[index]!, studentName: `Focus Student ${index}`,
  studentSessionId: sessions[index]!, deviceId: ids.devices[index]!, available: true, stateAuthorized: true });
const row = (index: number, observedRevision = 9) => ({ studentId: ids.students[index]!, tabRef: refs[index]!, observedRevision });
const control = async (index = 0) => {
  const result = await inSchool(() => storage.getClasspilotStudentControlState(ids.school, ids.students[index]!));
  assert.ok(result); return result;
};
const focus = async (index = 0) => readFocusRestriction(focusRecord((await control(index)).desiredState).restrictions);
const issue = (commandType: string, rawCommandPayload: Record<string, unknown>, indexes = [0]) => inSchool(() => dispatcher.executeClasspilotCommand({
  schoolId: ids.school, actorId: ids.teacher, supervisionContextId: context.id,
  contextAuthorityRevision: String(context.classroomAuthorityRevision), targetScope: "students",
  commandType, rawCommandPayload, targets: indexes.map(target),
}));
const refresh = async (index: number, acceptedCapabilities: string[] = capabilities) => realtime.writeClasspilotRealtimeStatus({
  schoolId: ids.school, studentId: ids.students[index]!, studentSessionId: sessions[index]!, deviceId: ids.devices[index]!,
  heartbeatId: randomUUID(), observedAt: Date.now(), acceptedCapabilities, extensionCapabilities: acceptedCapabilities, tabSnapshotRevision: 9,
  activeTabUrl: "https://example.org/current?private=not-durable",
  allOpenTabs: [{ tabRef: refs[index]!, url: "https://example.org/lesson", title: "Exact tab" }],
});
const sourceTarget = async (commandId: string) => {
  const result = await inSchool(() => storage.getClasspilotCommandByIdAndSchool(commandId, ids.school));
  assert.ok(result?.targets[0]); return result.targets[0];
};
const openAck = (commandId: string, controlRevision: number, overrides: Partial<import("../src/services/storage.js").ClasspilotCommandAckOptions> = {}) => inSchool(() => storage.persistClasspilotCommandTargetAck({
  commandId, schoolId: ids.school, studentId: ids.students[0]!, deviceId: ids.devices[0]!, studentSessionId: sessions[0]!,
  ackState: "completed", controlRevision, acceptedCapabilities: capabilities,
  result: { tabReceiptVersion: 1, tabRef: "private-twenty-first-tab", tabSnapshotRevision: 10 }, ...overrides,
}));

// Seed historical rows through the independent local fixture role. Production
// authoring stays permanently retired: cleanup tests must not enable a bypass.
async function seedLegacyOpen() {
  const source = await issue("open-tab", { url: "https://example.org/lesson" });
  const state = await control(), originalTarget = await sourceTarget(source.command.id);
  const binding = { version: 1 as const, assignmentId: randomUUID(), schoolId: ids.school, studentId: ids.students[0]!,
    studentSessionId: sessions[0]!, deviceId: ids.devices[0]!, serverOrigin: focusServerOrigin(),
    teachingSessionId: null, supervisionContextId: context.id, ownerId: ids.teacher,
    contextAuthorityRevision: String(context.classroomAuthorityRevision), sourceCommandId: source.command.id,
    sourceTargetId: originalTarget.id, revisionAtAssignment: state.revision };
  const intent = { version: 1, assignmentId: binding.assignmentId, childCommandId: randomUUID(),
    deadline: source.command.expiresAt!.toISOString(), state: "pending", binding };
  await admin.query("UPDATE classpilot_commands SET command_payload=$2::jsonb WHERE id=$1", [source.command.id,
    JSON.stringify({ url: "https://example.org/lesson", focusAfterOpen: true })]);
  await admin.query("UPDATE classpilot_command_targets SET result=$2::jsonb WHERE id=$1", [originalTarget.id,
    JSON.stringify({ ...focusRecord(originalTarget.result), frozenControlRevision: state.revision, focusOpenIntentV1: intent })]);
  const command = await inSchool(() => storage.getClasspilotCommandByIdAndSchool(source.command.id, ids.school));
  assert.ok(command); return { command };
}

async function seedLegacyFocus(indexes = [0]) {
  const source = await issue("open-tab", { url: "https://example.org/lesson" }, indexes);
  await admin.query("UPDATE classpilot_commands SET command_type='focus-tab',command_payload=$2::jsonb,expires_at=NULL WHERE id=$1",
    [source.command.id, JSON.stringify({ tabTargets: indexes.map(index => row(index)) })]);
  for (const index of indexes) {
    const state = await control(index);
    const sourceTargetRow = source.command.targets.find(value => value.studentId === ids.students[index]);
    assert.ok(sourceTargetRow);
    const assignment = { version: 1, assignmentId: randomUUID(), schoolId: ids.school, studentId: ids.students[index]!,
      studentSessionId: sessions[index]!, deviceId: ids.devices[index]!, serverOrigin: focusServerOrigin(),
      teachingSessionId: null, supervisionContextId: context.id, ownerId: ids.teacher,
      contextAuthorityRevision: String(context.classroomAuthorityRevision), sourceCommandId: source.command.id,
      sourceTargetId: sourceTargetRow.id, revisionAtAssignment: state.revision + 1 };
    const base = withoutClasspilotFocus(state.desiredState);
    const desired = { ...base, restrictions: { ...focusRecord(base.restrictions),
      focus: { active: true, assignmentId: assignment.assignmentId, tabRef: refs[index], observedRevision: 9,
        targetKind: "snapshot", source: "teacher", setAt: new Date().toISOString() } }, focusAssignmentV1: assignment };
    await admin.query("UPDATE classpilot_student_control_states SET desired_state=$2::jsonb,revision=revision+1,source_command_id=$3 WHERE id=$1",
      [state.id, JSON.stringify(desired), source.command.id]);
    await admin.query("UPDATE classpilot_command_targets SET result=$2::jsonb WHERE id=$1", [sourceTargetRow.id,
      JSON.stringify({ ...focusRecord(sourceTargetRow.result), focusExactAuthorityV1: assignment, frozenControlRevision: state.revision + 1 })]);
  }
  return source;
}

describe("Legacy tab Focus retirement under restricted RLS", { skip: process.env.RLS_GUC_ENABLED !== "true" }, () => {
before(async () => {
  assert.ok(["localhost", "127.0.0.1", "::1"].includes(new URL(process.env.DATABASE_URL || "").hostname));
  assert.ok(process.env.ADMIN_DATABASE_URL, "The fixture requires an independent local bootstrap role");
  admin = new pg.Pool({ connectionString: process.env.ADMIN_DATABASE_URL });
  ({ default: database } = await import("../src/db.js"));
  ({ runWithTenantContext: tenant } = await import("../src/middleware/tenantContext.js"));
  storage = await import("../src/services/storage.js");
  dispatcher = await import("../src/services/classpilotCommandDispatcher.js");
  realtime = await import("../src/services/classpilotRealtimeStatus.js");
  const role = await (await import("../src/db.js")).pool.query<{ rolsuper: boolean; rolbypassrls: boolean; owned: string }>(
    "SELECT rolsuper,rolbypassrls,(SELECT count(*) FROM pg_tables WHERE schemaname='public' AND tableowner=current_user) AS owned FROM pg_roles WHERE rolname=current_user");
  assert.equal(role.rows[0]?.rolsuper, false);
  assert.equal(role.rows[0]?.rolbypassrls, false);
  assert.equal(Number(role.rows[0]?.owned), 0);
  const forced = await admin.query<{ enabled: boolean; forced: boolean }>(
    "SELECT relrowsecurity AS enabled,relforcerowsecurity AS forced FROM pg_class WHERE oid='classpilot_student_control_states'::regclass");
  assert.equal(forced.rows[0]?.enabled, true);
  controlWasForced = forced.rows[0]!.forced;
  await admin.query("ALTER TABLE classpilot_student_control_states FORCE ROW LEVEL SECURITY");
  await admin.query("INSERT INTO schools(id,name,domain,status,plan_status) VALUES($1,'Focus fixture',$2,'active','active'),($3,'Focus other tenant',$4,'active','active')",
    [ids.school, `${ids.school}.example.edu`, ids.otherSchool, `${ids.otherSchool}.example.edu`]);
  await admin.query("INSERT INTO users(id,email,first_name,last_name) VALUES($1,$2,'Focus','Teacher')", [ids.teacher, `${ids.teacher}@example.edu`]);
  await admin.query("INSERT INTO school_memberships(school_id,user_id,role,status) VALUES($1,$2,'teacher','active')", [ids.school, ids.teacher]);
  await admin.query("INSERT INTO product_licenses(school_id,product,status) VALUES($1,'CLASSPILOT','active')", [ids.school]);
  process.env.CLASSPILOT_CLASS_TOOLS_SCHOOLS_JSON = JSON.stringify({ [ids.school]: 5 });
  await inSchool(async () => {
    await database.execute(sql`INSERT INTO settings(school_id,school_name,ws_shared_key,enable_tracking_hours,after_hours_mode,pause_chat_during_testing)
      VALUES(${ids.school},'Focus fixture','synthetic-only',false,'off',false)`);
    for (let index = 0; index < ids.students.length; index++) {
      await database.execute(sql`INSERT INTO students(id,school_id,first_name,last_name,status) VALUES(${ids.students[index]!},${ids.school},'Focus',${String(index)},'active')`);
      await storage.createDevice({ schoolId: ids.school, deviceId: ids.devices[index]!, classId: "default", deviceName: "Synthetic Chromebook" });
      sessions[index] = (await storage.startStudentSessionWithReplacements(ids.school, ids.students[index]!, ids.devices[index]!,
        { authKind: "manual_shared", sessionRecoveryTokenHash: String(index + 1).repeat(64) })).session.id;
    }
    context = await storage.createSupervisionContextWithStudents({ context: { schoolId: ids.school, name: "Focus scheduled fixture",
      contextType: "coverage_group", assignedStaffId: ids.teacher, createdBy: ids.teacher,
      startsAt: new Date(Date.now() - 60_000), endsAt: new Date(Date.now() + 3_600_000),
      scheduleProfileApplicationId: randomUUID(), scheduleProfileBlockId: randomUUID(), scheduleProfileDate: new Date().toISOString().slice(0, 10) },
      studentIds: ids.students, assignedBy: ids.teacher });
  });
  const cache = new Map<string, string>();
  realtime.setClasspilotRealtimeStatusCommandForTests(async args => {
    if (args[0] === "MGET") return args.slice(1).map(key => cache.get(key) ?? null);
    if (args[0] === "EVAL" && args[3] && args[5]?.startsWith("{")) { cache.set(args[3], args[5]); return args[5]; }
    return undefined;
  });
});

beforeEach(async () => {
  process.env.CLASSPILOT_CAP_FOCUS_TAB_V1 = "true";
  await Promise.all(ids.students.map((_, index) => refresh(index)));
  await issue("stop-focus", {}, [0, 1]);
});

after(async () => {
  if (!admin) return;
  realtime?.setClasspilotRealtimeStatusCommandForTests(undefined);
  for (const table of ["audit_logs", "classpilot_tool_history", "classpilot_routine_runs", "classpilot_tool_templates", "classpilot_chat_deliveries", "chat_messages", "classpilot_active_hands", "session_settings",
    "classpilot_classroom_states", "classpilot_command_targets", "classpilot_commands", "classpilot_student_control_states", "classpilot_supervision_students", "classpilot_supervision_contexts", "devices", "students", "settings"])
    await admin.query(`DELETE FROM ${table} WHERE school_id=$1`, [ids.school]);
  await admin.query("DELETE FROM student_sessions WHERE student_id=ANY($1::varchar[])", [ids.students]);
  await admin.query("DELETE FROM product_licenses WHERE school_id=$1", [ids.school]);
  await admin.query("DELETE FROM school_memberships WHERE school_id=$1", [ids.school]);
  // Staff identities and school lifecycle roots are retained by the real
  // integrity migration. This disposable DB keeps those synthetic roots.
  if (!controlWasForced) await admin.query("ALTER TABLE classpilot_student_control_states NO FORCE ROW LEVEL SECURITY");
  await (await import("../src/services/errorMonitor.js")).default.disposeAndWait();
  const pools = await import("../src/db.js");
  const scheduler = await import("../src/services/schedulerDb.js");
  await Promise.all([admin.end(), pools.pool.end(), pools.sessionPool.end(), scheduler.schedulerPool.end(), scheduler.schedulerLockPool.end()]);
});

async function retire(index = 0) {
  const result = await inSchool(() => storage.withClasspilotStudentControlDeliveryAuthority(
    { schoolId: ids.school, studentId: ids.students[index]!, studentSessionId: sessions[index]!, deviceId: ids.devices[index]! },
    async scoped => (await import("../src/services/classpilotFocusRetirement.js")).retireLegacyTabFocusForStudentLocked(scoped,
      { schoolId: ids.school, studentId: ids.students[index]!, reason: "reconnect" }),
    (_claimed, state) => state));
  assert.equal(result.authorized, true);
  return result.authorized ? result.value : undefined;
}

async function relayAllowed(frame: unknown) {
  const binding = { schoolId: ids.school, studentId: ids.students[0]!, studentSessionId: sessions[0]!, deviceId: ids.devices[0]! };
  const result = await inSchool(() => storage.withClasspilotStudentControlDeliveryAuthority(binding,
    scoped => storage.classpilotStudentRelayMessageAllowed(binding, frame, scoped),
    (_claimed, decision) => decision));
  assert.equal(result.authorized, true);
  return result.authorized ? result.value : null;
}

test("offline retirement preserves every independent control and records an exact durable cleanup", async () => {
  await seedLegacyFocus();
  const original = await control();
  const restrictions: Record<string, unknown> = { ...focusRecord(focusRecord(original.desiredState).restrictions),
    flightPath: { active: true, allowedDomains: ["example.org"], name: "Saved path" },
    screenLock: { active: true, url: "https://example.org/lesson" },
    blockList: { active: true, blockedDomains: ["blocked.example"] }, tabLimit: 3 };
  await admin.query("UPDATE classpilot_student_control_states SET desired_state=$2::jsonb WHERE id=$1",
    [original.id, JSON.stringify({ ...focusRecord(original.desiredState), restrictions })]);
  process.env.CLASSPILOT_CAP_FOCUS_TAB_V1 = "false";
  await refresh(0, ["scopedAuthorityChecksV1"]);
  const retired = await retire(); assert.ok(retired);
  const { focus: _removed, ...preserved } = restrictions;
  assert.deepEqual(focusRecord(retired.desiredState).restrictions, preserved);
  const cleanup = (await import("../src/services/classpilotFocus.js")).readFocusCleanup(retired.desiredState);
  assert.ok(cleanup);
  assert.equal(cleanup.studentSessionId, sessions[0]);
  assert.equal(cleanup.revisionAtAssignment, retired.revision);
  const command = await inSchool(() => storage.getClasspilotCommandByIdAndSchool(cleanup.sourceCommandId, ids.school));
  assert.equal(command?.commandType, "stop-focus");
  assert.deepEqual(command?.commandPayload, {});
  const frame = (await import("../src/services/classpilotFocusCleanup.js")).classpilotFocusCleanupFrame({ state: retired,
    binding: { schoolId: ids.school, studentId: ids.students[0]!, studentSessionId: sessions[0]!, deviceId: ids.devices[0]! },
    acceptedCapabilities: ["scopedAuthorityChecksV1"], authorityCurrent: true });
  assert.deepEqual(frame?.command.data, {});
  assert.equal(frame?.expiresAt, original.scheduledEndAt?.toISOString());
  const again = await retire();
  assert.equal(again?.revision, retired.revision);
  assert.deepEqual(again?.desiredState, retired.desiredState);
});

test("retirement removes saved legacy Focus without altering current destination controls", async () => {
  await seedLegacyFocus();
  const original = await control();
  const desired = { restrictions: { screenLock: { active: true, url: "https://example.org/current" }, tabLimit: 4 },
    restorableClassState: { teachingSessionId: randomUUID(), desiredState: original.desiredState } };
  await admin.query("UPDATE classpilot_student_control_states SET desired_state=$2::jsonb WHERE id=$1", [original.id, JSON.stringify(desired)]);
  const retired = await retire(); assert.ok(retired);
  assert.deepEqual(focusRecord(retired.desiredState).restrictions, desired.restrictions);
  assert.equal((await import("../src/services/classpilotFocusRetirement.js")).hasRetirableClasspilotFocus(retired.desiredState), false);
  assert.equal((await import("../src/services/classpilotFocus.js")).readFocusCleanup(retired.desiredState), null);
});

test("bounded retirement cancels historical opens and late ACK cannot create a child", async () => {
  const opened = await seedLegacyOpen();
  const before = await control();
  const targetBefore = await sourceTarget(opened.command.id);
  const intent = readFocusOpenIntent(targetBefore.result); assert.ok(intent);
  const result = await inSchool(() => (async () => {
    const { retireLegacyTabFocusBatch } = await import("../src/services/classpilotFocusRetirement.js");
    return retireLegacyTabFocusBatch(database, { limit: 1 });
  })());
  assert.equal(result.inspected, 1);
  const targetAfter = await sourceTarget(opened.command.id);
  assert.equal(readFocusOpenIntent(targetAfter.result)?.state, "refused");
  assert.equal(readFocusOpenIntent(targetAfter.result)?.errorCode, "TAB_FOCUS_RETIRED");
  await openAck(opened.command.id, before.revision);
  assert.equal(await inSchool(() => storage.getClasspilotCommandByIdAndSchool(intent.childCommandId, ids.school)), undefined);
  assert.equal((await focus())?.active, undefined);
});

test("successful late Open receipt is terminally refused even before a retirement sweep", async () => {
  const opened = await seedLegacyOpen();
  const before = await control();
  await openAck(opened.command.id, before.revision);
  const intent = readFocusOpenIntent((await sourceTarget(opened.command.id)).result);
  assert.equal(intent?.state, "refused");
  assert.equal(intent?.errorCode, "TAB_FOCUS_RETIRED");
  assert.equal((await control()).revision, before.revision);
});

test("queued old-server frames are refused by stored command authority while Bring Forward remains allowed", async () => {
  const authority = { teachingSessionId: null, supervisionContextId: context.id };
  for (const commandType of ["focus-tab", "open-tab"]) {
    const source = await issue("open-tab", { url: "https://example.org/lesson" });
    const frame = { commandId: source.command.id, authority };
    assert.ok(await relayAllowed(frame), "plain Open remains deliverable before the historical fixture conversion");
    await admin.query("UPDATE classpilot_commands SET command_type=$2,command_payload=$3::jsonb WHERE id=$1",
      [source.command.id, commandType, JSON.stringify(commandType === "open-tab"
        ? { url: "https://example.org/lesson", focusAfterOpen: true } : { tabTargets: [row(0)] })]);
    assert.equal(await relayAllowed(frame), null, "the stored retired command blocks a delayed frame without trusting frame type");
  }
  await seedLegacyFocus();
  const oldState = await control();
  assert.equal(await relayAllowed({ type: "classroom-state-sync", classroomState: {
    revision: oldState.revision, restrictions: focusRecord(oldState.desiredState).restrictions,
  } }), null, "a state-only frame cannot reapply retired Focus even at the current revision");
  const activate = await issue("activate-tab", { tabTargets: [row(0)] });
  const newState = await control();
  assert.equal(readFocusRestriction(focusRecord(newState.desiredState).restrictions), null);
  assert.equal(focusRecord(activate.command.targets[0]?.result).frozenControlRevision, newState.revision);
  assert.ok(await relayAllowed({ commandId: activate.command.id, authority }));
});

test("Set and Stop website Focus retire old tab holding in the same persistence operation", async () => {
  for (const [commandType, payload] of [
    ["lock-screen", { url: "https://example.org/new-focus" }],
    ["unlock-screen", { screenOnly: true }],
  ] as const) {
    await refresh(0, [...capabilities, "classroomStateV1", "screenOnlyUnlockV1"]);
    await seedLegacyFocus();
    const result = await issue(commandType, payload);
    assert.notEqual(result.command.targets[0]?.status, "unavailable", JSON.stringify(result.command.targets[0]));
    const state = await control();
    const restrictions = focusRecord(focusRecord(state.desiredState).restrictions);
    assert.equal(restrictions.focus, undefined);
    assert.equal(focusRecord(restrictions.screenLock).active, commandType === "lock-screen");
    if ("url" in payload) assert.equal(focusRecord(restrictions.screenLock).url, payload.url);
    assert.equal(state.sourceCommandId, result.command.id, "new website command remains the delivery authority");
    const cleanup = (await import("../src/services/classpilotFocus.js")).readFocusCleanup(state.desiredState);
    assert.ok(cleanup);
    assert.ok(await relayAllowed({ commandId: cleanup.sourceCommandId,
      authority: { teachingSessionId: null, supervisionContextId: context.id } }),
    "the exact cleanup remains deliverable while the new website command owns the main source");
  }
});

test("current-page Focus retires legacy tab holding before exact target revision freezes without saving the observed URL", { timeout: 30_000 }, async () => {
  await seedLegacyFocus();
  const before = await control();
  const broadcast = await import("../src/realtime/ws-broadcast.js");
  const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(wss, "listening");
  const address = wss.address(); assert.ok(address && typeof address !== "string");
  const connection = once(wss, "connection");
  const client = new WebSocket(`ws://127.0.0.1:${address.port}`);
  await once(client, "open");
  const [server] = await connection; assert.ok(server instanceof WebSocket);
  broadcast.registerWsClient(server);
  broadcast.authenticateWsClient(server, { schoolId: ids.school, role: "student", ...target(0), acceptedCapabilities: capabilities });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const receivedControlFrames: Record<string, unknown>[] = [];
  try {
    const received = new Promise<Record<string, unknown>>((resolve, reject) => {
      timer = setTimeout(() => reject(new Error("Current-page Focus frame was not delivered")), 5_000);
      client.on("message", data => {
        const frame = focusRecord(JSON.parse(data.toString()));
        if (["stop-focus", "lock-screen"].includes(String(focusRecord(frame.command).type))) receivedControlFrames.push(frame);
        if (focusRecord(frame.command).type === "lock-screen") { clearTimeout(timer); resolve(frame); }
      });
    });
    void received.catch(() => undefined);
    const result = await issue("lock-screen", { url: "CURRENT_URL" });
    const commandTarget = result.command.targets[0]; assert.ok(commandTarget);
    assert.notEqual(commandTarget.status, "unavailable", commandTarget.errorMessage ?? undefined);
    const frame = await received;
    const state = await control();
    assert.equal(state.revision, before.revision + 1);
    assert.equal(readFocusRestriction(focusRecord(state.desiredState).restrictions), null);
    assert.deepEqual(result.command.commandPayload, { currentPage: true });
    assert.equal(focusRecord(commandTarget.result).frozenControlRevision, state.revision);
    assert.equal(JSON.stringify(state.desiredState).includes("private=not-durable"), false);
    assert.equal(focusRecord(frame.exactBinding).controlRevision, state.revision);
    assert.equal(frame.classroomState, undefined, "current-page action does not invent a persisted website snapshot");
    assert.equal(focusRecord(focusRecord(frame.command).data).url, "https://example.org/current?private=not-durable");
    assert.deepEqual(receivedControlFrames.map(value => focusRecord(value.command).type), ["stop-focus", "lock-screen"],
      "exact bare cleanup must precede the transient current-page Focus");
    const stop = receivedControlFrames[0]!;
    assert.deepEqual(focusRecord(stop.command).data, {});
    assert.equal(focusRecord(stop.exactBinding).controlRevision, state.revision);
    assert.equal(stop.classroomState, undefined);
    assert.equal(JSON.stringify(stop).includes("private=not-durable"), false);
    assert.ok(await relayAllowed(frame), "the actual new frame remains exact-bound and deliverable");
  } finally {
    clearTimeout(timer); client.removeAllListeners("message");
    broadcast.removeWsClient(server); client.terminate(); server.terminate();
    await new Promise<void>(resolve => wss.close(() => resolve()));
  }
});

test("revoked owner cannot obtain a new cleanup command or retain saved tab holding", async () => {
  await seedLegacyFocus();
  const before = await control();
  const formerOwner = randomUUID();
  await admin.query("INSERT INTO users(id,email,first_name,last_name) VALUES($1,$2,'Former','Teacher')", [formerOwner, `${formerOwner}@example.edu`]);
  await admin.query("INSERT INTO school_memberships(school_id,user_id,role,status) VALUES($1,$2,'teacher','inactive')", [ids.school, formerOwner]);
  await admin.query("UPDATE classpilot_student_control_states SET desired_state=jsonb_set(desired_state,'{focusAssignmentV1,ownerId}',to_jsonb($2::text)) WHERE id=$1", [before.id, formerOwner]);
    const retired = await retire(); assert.ok(retired);
    assert.equal((await import("../src/services/classpilotFocusRetirement.js")).hasRetirableClasspilotFocus(retired.desiredState), false);
    assert.equal((await import("../src/services/classpilotFocus.js")).readFocusCleanup(retired.desiredState), null);
    assert.equal(retired.sourceCommandId, before.sourceCommandId);
});

test("retirement rejects a row supplied from another tenant before mutation", async () => {
  await seedLegacyFocus();
  const before = await control();
  await assert.rejects(inSchool(() => storage.withClasspilotStudentControlDeliveryAuthority(
    { schoolId: ids.school, studentId: ids.students[0]!, studentSessionId: sessions[0]!, deviceId: ids.devices[0]! },
    async scoped => (await import("../src/services/classpilotFocusRetirement.js")).retireLegacyTabFocusForStudentLocked(scoped,
      { schoolId: ids.otherSchool, studentId: ids.students[0]!, state: before, reason: "reconnect" }),
    (_claimed, state) => state)), /does not match/);
  assert.equal((await control()).revision, before.revision);
});
});
