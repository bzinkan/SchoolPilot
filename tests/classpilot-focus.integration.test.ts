import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, beforeEach, describe, test } from "node:test";
import { setTimeout as pause } from "node:timers/promises";
import pg from "pg";
import { sql } from "drizzle-orm";
import { focusRecord, readFocusAssignment, readFocusOpenIntent, readFocusRestriction } from "../src/services/classpilotFocus.js";

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
  heartbeatId: randomUUID(), observedAt: Date.now(), acceptedCapabilities, tabSnapshotRevision: 9,
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

describe("Focus authority and continuation under restricted RLS", { skip: process.env.RLS_GUC_ENABLED !== "true" }, () => {
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

test("exact multi-student Focus persists distinct immutable targets and no other tenant can read them", async () => {
  const result = await issue("focus-tab", { tabTargets: [row(0), row(1)] }, [0, 1]);
  assert.deepEqual(result.tabOutcomes?.map(outcome => outcome.status), ["accepted", "accepted"]);
  const assignments = [];
  for (let index = 0; index < 2; index++) {
    const state = await control(index);
    const restriction = readFocusRestriction(focusRecord(state.desiredState).restrictions);
    assert.equal(restriction?.active && restriction.tabRef, refs[index]);
    const assignment = readFocusAssignment(state.desiredState);
    assert.ok(assignment);
    assert.equal(assignment.studentSessionId, sessions[index]);
    assignments.push(assignment.assignmentId);
  }
  assert.notEqual(assignments[0], assignments[1]);
  assert.equal(await tenant({ schoolId: ids.otherSchool }, () => storage.getClasspilotStudentControlState(ids.school, ids.students[0]!)), undefined);
});

test("stale public refs and advertised-only clients get bounded unavailability and never create Focus", async () => {
  const stale = await issue("activate-tab", { tabTargets: [row(0, 8)] });
  assert.equal(stale.tabOutcomes?.[0]?.status, "stale_tab_ref");
  assert.equal(await focus(), null);
  await refresh(0, ["scopedAuthorityChecksV1"]);
  const unsupported = await issue("focus-tab", { tabTargets: [row(0)] });
  assert.equal(unsupported.tabOutcomes?.[0]?.status, "unsupported");
  assert.equal(await focus(), null);
});

test("successful open consumes the private 21st-tab receipt once without public snapshot lookup", async () => {
  const source = await issue("open-tab", { url: "https://example.org/lesson", focusAfterOpen: true });
  const intent = readFocusOpenIntent(source.command.targets[0]?.result);
  assert.ok(intent);
  assert.equal(await focus(), null);
  const ack = await openAck(source.command.id, intent.binding.revisionAtAssignment);
  assert.equal(ack.disposition, "applied");
  const committed = readFocusOpenIntent((await sourceTarget(source.command.id)).result);
  assert.equal(committed?.state, "committed");
  const active = await focus();
  assert.ok(active?.active);
  assert.equal(active.tabRef, "private-twenty-first-tab");
  assert.equal(active.targetKind, "open_receipt");
  assert.equal(active.assignmentId, intent.assignmentId);
  const revision = (await control()).revision;
  const retry = await openAck(source.command.id, intent.binding.revisionAtAssignment);
  assert.equal(retry.disposition, "idempotent");
  assert.equal((await control()).revision, revision);
  const children = await admin.query<{ count: string }>("SELECT count(*) FROM classpilot_commands WHERE id=$1", [intent.childCommandId]);
  assert.equal(Number(children.rows[0]?.count), 1);
});

test("received or failed opens and forged receipt metadata cannot create a follow-up", async () => {
  const source = await issue("open-tab", { url: "https://example.org/lesson", focusAfterOpen: true });
  const intent = readFocusOpenIntent(source.command.targets[0]?.result); assert.ok(intent);
  const received = await openAck(source.command.id, intent.binding.revisionAtAssignment, { ackState: "received",
    result: { followUp: { kind: "focus", state: "committed", commandId: "forged-child" } } });
  assert.equal(received.disposition, "applied");
  assert.equal(Object.hasOwn(focusRecord((await sourceTarget(source.command.id)).result), "followUp"), false);
  assert.equal(await focus(), null);
  await openAck(source.command.id, intent.binding.revisionAtAssignment, { result: { tabReceiptVersion: 1,
    tabRef: "forged", tabSnapshotRevision: 10, focusOpenIntentV1: { state: "committed" },
    followUp: { kind: "focus", state: "committed", commandId: "forged-child" } } });
  assert.equal(readFocusOpenIntent((await sourceTarget(source.command.id)).result)?.state, "refused");
  assert.equal(Object.hasOwn(focusRecord((await sourceTarget(source.command.id)).result), "followUp"), false);
  assert.equal(await focus(), null);
  const failedSource = await issue("open-tab", { url: "https://example.org/lesson", focusAfterOpen: true });
  const failedIntent = readFocusOpenIntent(failedSource.command.targets[0]?.result); assert.ok(failedIntent);
  await openAck(failedSource.command.id, failedIntent.binding.revisionAtAssignment, { ackState: "failed" });
  assert.equal(readFocusOpenIntent((await sourceTarget(failedSource.command.id)).result)?.state, "refused");
  assert.equal(await focus(), null);
});

test("received open does not extend the continuation deadline", async () => {
  const source = await issue("open-tab", { url: "https://example.org/lesson", focusAfterOpen: true });
  const intent = readFocusOpenIntent(source.command.targets[0]?.result); assert.ok(intent);
  await openAck(source.command.id, intent.binding.revisionAtAssignment, { ackState: "received" });
  const afterDeadline = new Date(Date.parse(intent.deadline) + 1);
  assert.equal(source.command.expiresAt?.getTime(), Date.parse(intent.deadline));
  const due = await admin.query<{ due: boolean }>("SELECT expires_at <= $2::timestamp AS due FROM classpilot_commands WHERE id=$1", [source.command.id, afterDeadline.toISOString()]);
  assert.equal(due.rows[0]?.due, true);
  await inSchool(() => storage.expireClasspilotTransientCommandTargets({ schoolId: ids.school, commandId: source.command.id, now: afterDeadline }));
  assert.equal(readFocusOpenIntent((await sourceTarget(source.command.id)).result)?.state, "expired");
  await openAck(source.command.id, intent.binding.revisionAtAssignment, { now: afterDeadline });
  assert.equal(await focus(), null);
});

test("queued continuation rechecks a valid context-end and actor-deactivation mutation under the canonical school lock", async () => {
  const source = await issue("open-tab", { url: "https://example.org/lesson", focusAfterOpen: true });
  const intent = readFocusOpenIntent(source.command.targets[0]?.result); assert.ok(intent);
  const mutation = await admin.connect();
  try {
    await mutation.query("BEGIN");
    await mutation.query("SELECT id FROM schools WHERE id=$1 FOR UPDATE", [ids.school]);
    // Ending the live assignment is required before deactivating its staff.
    // The integrity trigger deliberately forbids the inconsistent shortcut.
    await mutation.query("UPDATE classpilot_supervision_contexts SET status='ended', ended_at=now() WHERE school_id=$1 AND id=$2", [ids.school, context.id]);
    await mutation.query("UPDATE school_memberships SET status='inactive' WHERE school_id=$1 AND user_id=$2", [ids.school, ids.teacher]);
    const receipt = openAck(source.command.id, intent.binding.revisionAtAssignment);
    await pause(100);
    await mutation.query("COMMIT");
    await receipt;
    assert.equal(readFocusOpenIntent((await sourceTarget(source.command.id)).result)?.state, "refused");
    assert.equal(await focus(), null);
  } finally {
    await mutation.query("ROLLBACK"); mutation.release();
    await admin.query("UPDATE school_memberships SET status='active' WHERE school_id=$1 AND user_id=$2", [ids.school, ids.teacher]);
    await admin.query("UPDATE classpilot_supervision_contexts SET status='active', ended_at=NULL WHERE school_id=$1 AND id=$2", [ids.school, context.id]);
  }
});

test("license wall-clock expiry during a control lock wait prevents child creation", async () => {
  const source = await issue("open-tab", { url: "https://example.org/lesson", focusAfterOpen: true });
  const intent = readFocusOpenIntent(source.command.targets[0]?.result); assert.ok(intent);
  const blocker = await admin.connect();
  try {
    await admin.query("UPDATE product_licenses SET expires_at=clock_timestamp()+interval '350 milliseconds' WHERE school_id=$1 AND product='CLASSPILOT'", [ids.school]);
    await blocker.query("BEGIN");
    await blocker.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0::bigint))", [`classpilot:student-control:${ids.school}:${ids.students[0]}`]);
    const receipt = openAck(source.command.id, intent.binding.revisionAtAssignment);
    await pause(450);
    await blocker.query("COMMIT");
    await receipt;
    assert.equal(readFocusOpenIntent((await sourceTarget(source.command.id)).result)?.state, "refused");
    assert.equal(await focus(), null);
  } finally {
    await blocker.query("ROLLBACK"); blocker.release();
    await admin.query("UPDATE product_licenses SET expires_at=NULL WHERE school_id=$1 AND product='CLASSPILOT'", [ids.school]);
  }
});

test("stop remains available gate-off and fences a concurrently queued successful open ACK", { timeout: 30_000 }, async () => {
  const source = await issue("open-tab", { url: "https://example.org/lesson", focusAfterOpen: true });
  const intent = readFocusOpenIntent(source.command.targets[0]?.result); assert.ok(intent);
  const blocker = await admin.connect();
  let stop: ReturnType<typeof issue> | undefined;
  let ack: ReturnType<typeof openAck> | undefined;
  try {
    await blocker.query("BEGIN");
    await blocker.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0::bigint))", [`classpilot:student-control:${ids.school}:${ids.students[0]}`]);
    process.env.CLASSPILOT_CAP_FOCUS_TAB_V1 = "false";
    stop = issue("stop-focus", {});
    await pause(100);
    ack = openAck(source.command.id, intent.binding.revisionAtAssignment);
    await pause(100);
    await blocker.query("COMMIT");
    await Promise.all([stop, ack]);
  } finally { await blocker.query("ROLLBACK"); blocker.release(); }
  assert.equal(readFocusOpenIntent((await sourceTarget(source.command.id)).result)?.state, "refused");
  assert.equal(await focus(), null);
  const child = await admin.query<{ count: string }>("SELECT count(*) FROM classpilot_commands WHERE id=$1", [intent.childCommandId]);
  assert.equal(Number(child.rows[0]?.count), 0);
});

test("replacement assignment B survives the concurrently queued invalidation ACK for assignment A", { timeout: 30_000 }, async () => {
  await issue("focus-tab", { tabTargets: [row(0)] });
  const a = await control();
  const assignmentA = readFocusAssignment(a.desiredState); assert.ok(assignmentA);
  const blocker = await admin.connect();
  try {
    await blocker.query("BEGIN");
    await blocker.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0::bigint))", [`classpilot:student-control:${ids.school}:${ids.students[0]}`]);
    const replacement = issue("focus-tab", { tabTargets: [row(0)] });
    await pause(100);
    const invalidation = inSchool(() => storage.acknowledgeClasspilotStudentControlState({ schoolId: ids.school,
      studentId: ids.students[0]!, studentSessionId: sessions[0]!, deviceId: ids.devices[0]!, appliedRevision: a.revision,
      outcome: "applied", acceptedCapabilities: capabilities,
      focusStatus: { assignmentId: assignmentA.assignmentId, state: "invalidated", reason: "focus_tab_closed" } }));
    await pause(100);
    await blocker.query("COMMIT");
    const [, stale] = await Promise.all([replacement, invalidation]);
    assert.equal(stale, undefined);
  } finally { await blocker.query("ROLLBACK"); blocker.release(); }
  const assignmentB = readFocusAssignment((await control()).desiredState); assert.ok(assignmentB);
  assert.notEqual(assignmentB.assignmentId, assignmentA.assignmentId);
  assert.equal((await focus())?.active, true);
});

test("Focus invalidation clears only its own layer and retirement ACK cannot replay", async () => {
  await issue("focus-tab", { tabTargets: [row(0)] });
  const current = await control();
  const assignment = readFocusAssignment(current.desiredState); assert.ok(assignment);
  const ack = { schoolId: ids.school, studentId: ids.students[0]!, studentSessionId: sessions[0]!, deviceId: ids.devices[0]!,
    appliedRevision: current.revision, outcome: "applied" as const, acceptedCapabilities: capabilities,
    focusStatus: { assignmentId: assignment.assignmentId, state: "invalidated", reason: "focus_tab_missing" } };
  const retired = await inSchool(() => storage.acknowledgeClasspilotStudentControlState(ack));
  assert.equal(retired?.revision, current.revision + 1);
  assert.equal(await focus(), null);
  assert.deepEqual(focusRecord((await control()).desiredState).restrictions, focusRecord(current.desiredState).restrictions &&
    Object.fromEntries(Object.entries(focusRecord(focusRecord(current.desiredState).restrictions)).filter(([key]) => key !== "focus")));
  assert.equal(await inSchool(() => storage.acknowledgeClasspilotStudentControlState(ack)), undefined);
});

test("bare stop survives gate/capability withdrawal and wholly withheld precise state, but never crosses assignment B", async () => {
  await issue("focus-tab", { tabTargets: [row(0)] });
  const active = await control();
  const original = focusRecord(active.desiredState);
  const precise = { ...original, restrictions: { ...focusRecord(original.restrictions), flightPath: { active: true,
    resources: [{ type: "resource", hostname: "docs.google.com", includeSubdomains: false, provider: "google_docs",
      resourceId: "1a2B3c4D5e6F7g8H9i0JkLmNoPqRsTuVwXyZ", canonicalUrl: "https://docs.google.com/document/d/1a2B3c4D5e6F7g8H9i0JkLmNoPqRsTuVwXyZ/edit" }],
    allowedDomains: [], name: "Precise remaining policy" } } };
  await admin.query("UPDATE classpilot_student_control_states SET desired_state=$2::jsonb WHERE id=$1", [active.id, JSON.stringify(precise)]);
  process.env.CLASSPILOT_CAP_FOCUS_TAB_V1 = "false";
  await refresh(0, ["scopedAuthorityChecksV1"]);
  const stopped = await issue("stop-focus", {});
  assert.equal(stopped.command.targets[0]?.status, "sent", "cleanup dispatch stays deliverable while the remaining snapshot is withheld");
  const current = await control();
  assert.equal(await focus(), null);
  assert.deepEqual(focusRecord(focusRecord(current.desiredState).restrictions).flightPath, precise.restrictions.flightPath);
  assert.ok(focusRecord(current.desiredState).focusCleanupV1);
  const { prepareClasspilotFocusCleanupFrame } = await import("../src/services/classpilotFocusCleanup.js");
  const recovered = await inSchool(() => storage.withClasspilotStudentControlDeliveryAuthority({ schoolId: ids.school,
    studentId: ids.students[0]!, studentSessionId: sessions[0]!, deviceId: ids.devices[0]! },
    database => prepareClasspilotFocusCleanupFrame(database, current, { schoolId: ids.school,
      studentId: ids.students[0]!, studentSessionId: sessions[0]!, deviceId: ids.devices[0]! }, ["scopedAuthorityChecksV1"]),
    (_claimed, frame) => frame));
  assert.ok(recovered.authorized && recovered.value);
  const frame = recovered.value;
  assert.deepEqual(frame.command.data, {});
  assert.equal(Object.hasOwn(frame, "classroomState"), false);
  assert.equal(frame.exactBinding.controlRevision, current.revision);
  assert.equal(frame.command.expiresAt, current.scheduledEndAt?.toISOString());
  const ack = { commandId: stopped.command.id, schoolId: ids.school, studentId: ids.students[0]!, studentSessionId: sessions[0]!,
    deviceId: ids.devices[0]!, controlRevision: current.revision, ackState: "completed" as const, acceptedCapabilities: ["scopedAuthorityChecksV1"] };
  assert.equal((await inSchool(() => storage.persistClasspilotCommandTargetAck(ack))).disposition, "applied");
  assert.deepEqual(focusRecord((await control()).desiredState).focusStatusV1, { state: "inactive" });
  assert.equal((await control()).enforcementHealth, current.enforcementHealth);
  assert.equal((await inSchool(() => storage.persistClasspilotCommandTargetAck(ack))).disposition, "idempotent");
  await admin.query("UPDATE classpilot_student_control_states SET desired_state=jsonb_set(desired_state,'{restrictions,flightPath}','{\"active\":false}'::jsonb) WHERE id=$1", [active.id]);
  process.env.CLASSPILOT_CAP_FOCUS_TAB_V1 = "true"; await refresh(0);
  await issue("focus-tab", { tabTargets: [row(0)] });
  const b = await control();
  assert.equal(Object.hasOwn(focusRecord(b.desiredState), "focusCleanupV1"), false);
  assert.ok(frame.exactBinding.controlRevision < b.revision);
  assert.equal((await inSchool(() => storage.persistClasspilotCommandTargetAck(ack))).disposition, "terminal_rejected");
  assert.equal((await focus())?.active, true);
});

test("recovery-token sign-out retires exact assignment and pending open continuation", async () => {
  await issue("focus-tab", { tabTargets: [row(0)] });
  const source = await issue("open-tab", { url: "https://example.org/lesson", focusAfterOpen: true });
  const intent = readFocusOpenIntent(source.command.targets[0]?.result); assert.ok(intent);
  const ended = await inSchool(() => storage.endStudentSessionByRecoveryTokenHash({ schoolId: ids.school, tokenHash: "1".repeat(64) }));
  assert.equal(ended?.id, sessions[0]);
  assert.equal(await focus(), null);
  assert.equal(readFocusOpenIntent((await sourceTarget(source.command.id)).result)?.state, "refused");
  assert.equal((await openAck(source.command.id, intent.binding.revisionAtAssignment)).disposition, "terminal_rejected");
});
});
