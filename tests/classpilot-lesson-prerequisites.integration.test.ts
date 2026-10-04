import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, beforeEach, describe, test } from "node:test";
import { setTimeout as pause } from "node:timers/promises";
import pg from "pg";
import { z } from "zod";
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
const capabilities = ["scopedAuthorityChecksV1", "scheduledClassroomV1", "focusTabV1", "classroomStateV1", "preciseRestrictionResourcesV1"];
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

describe("Classroom lesson prerequisites under restricted RLS", { skip: process.env.RLS_GUC_ENABLED !== "true" }, () => {
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
    "classpilot_classroom_states", "classpilot_command_targets", "classpilot_commands", "classpilot_student_control_states", "classpilot_supervision_students", "classpilot_supervision_contexts", "flight_paths", "devices", "students", "settings"])
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

const createPath = () => inSchool(() => storage.createFlightPath({ schoolId: ids.school, teacherId: ids.teacher,
  flightPathName: "Reviewed synthetic lesson", allowedDomains: ["example.org"], blockedDomains: [],
  sourceType: "google_classroom", sourceCourseId: "course", sourceResourceIds: ["item"] }));
const applyPath = async (indexes = [0]) => {
  const path = await createPath();
  const applied = await issue("apply-flight-path", { flightPathId: path.id, expectedFlightPathUpdatedAt: path.updatedAt.toISOString() }, indexes);
  return { path, command: applied.command };
};
const confirm = async (commandId: string, index = 0) => {
  const state = await control(index);
  await inSchool(() => storage.acknowledgeClasspilotStudentControlState({ schoolId: ids.school, studentId: ids.students[index]!,
    studentSessionId: sessions[index]!, deviceId: ids.devices[index]!, appliedRevision: state.revision, outcome: "applied", acceptedCapabilities: capabilities }));
  const ack = await inSchool(() => storage.persistClasspilotCommandTargetAck({ commandId, schoolId: ids.school,
    studentId: ids.students[index]!, studentSessionId: sessions[index]!, deviceId: ids.devices[index]!, ackState: "completed",
    controlRevision: state.revision, acceptedCapabilities: capabilities, result: { outcome: "applied", appliedRevision: state.revision } }));
  assert.equal(ack.disposition, "idempotent", "canonical state ACK already completed this source target");
};

test("database-owned content timestamp fences older direct writers and same-millisecond edits", async () => {
  const path = await createPath();
  const edit = await admin.query<{ updated_at: Date }>("UPDATE flight_paths SET allowed_domains=ARRAY['example.org','other.example.org'] WHERE id=$1 RETURNING updated_at", [path.id]);
  assert.ok(edit.rows[0]!.updated_at.getTime() > path.updatedAt.getTime());
  const next = await admin.query<{ updated_at: Date }>("UPDATE flight_paths SET description='changed',updated_at='2000-01-01' WHERE id=$1 RETURNING updated_at", [path.id]);
  assert.ok(next.rows[0]!.updated_at.getTime() >= edit.rows[0]!.updated_at.getTime() + 1);
  const unchanged = await admin.query<{ updated_at: Date }>("UPDATE flight_paths SET allowed_domains=allowed_domains,updated_at=clock_timestamp() WHERE id=$1 RETURNING updated_at", [path.id]);
  assert.equal(unchanged.rows[0]!.updated_at.getTime(), next.rows[0]!.updated_at.getTime());
});

test("pinned apply rejects an intervening Flight Path edit before any command commits", async () => {
  const path = await createPath();
  await inSchool(() => storage.updateFlightPath(path.id, ids.school, { allowedDomains: ["example.org", "broader.example.org"] }));
  await assert.rejects(issue("apply-flight-path", { flightPathId: path.id, expectedFlightPathUpdatedAt: path.updatedAt.toISOString() }),
    (error: unknown) => !!error && typeof error === "object" && "code" in error && error.code === "FLIGHT_PATH_REVIEW_STALE");
  const count = await admin.query<{ count: string }>("SELECT count(*) FROM classpilot_commands WHERE school_id=$1 AND command_payload->>'flightPathId'=$2", [ids.school, path.id]);
  assert.equal(count.rows[0]!.count, "0");
});

test("a Flight Path edit committed after apply materialization wins the row-lock review fence", async () => {
  const path = await createPath();
  let releaseEdit!: () => void; let readyEdit!: () => void;
  const editGate = new Promise<void>(resolve => { releaseEdit = resolve; });
  const ready = new Promise<void>(resolve => { readyEdit = resolve; });
  const edit = inSchool(() => database.transaction(async tx => {
    await tx.execute(sql`SELECT id FROM flight_paths WHERE school_id=${ids.school} AND id=${path.id} FOR UPDATE`);
    readyEdit(); await editGate;
    await tx.execute(sql`UPDATE flight_paths SET allowed_domains=ARRAY['example.org','broader.example.org'] WHERE school_id=${ids.school} AND id=${path.id}`);
  }));
  await ready;
  const pending = issue("apply-flight-path", { flightPathId: path.id, expectedFlightPathUpdatedAt: path.updatedAt.toISOString() })
    .then(() => null, (error: unknown) => error);
  try {
    let waiting = false;
    for (let attempt = 0; attempt < 100 && !waiting; attempt++) {
      const observed = await admin.query<{ waiting: boolean }>("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%flight_paths%' AND cardinality(pg_blocking_pids(pid))>0) AS waiting");
      waiting = observed.rows[0]!.waiting; if (!waiting) await pause(25);
    }
    assert.equal(waiting, true, "canonical apply must wait at the actual locked Flight Path row");
  } finally { releaseEdit(); await edit; }
  const result = await pending;
  assert.ok(result && typeof result === "object" && "code" in result && result.code === "FLIGHT_PATH_REVIEW_STALE");
});

test("concurrent reviewed imports reuse one exact personal source while ordinary imports still create", async () => {
  const data = { schoolId: ids.school, teacherId: ids.teacher, flightPathName: "Concurrent reviewed import", allowedDomains: ["reuse.example.org"],
    blockedDomains: [], sourceType: "google_classroom", sourceCourseId: "concurrent-course", sourceResourceIds: ["b", "a"] };
  const imports = await Promise.all([0, 1, 2].map(() => inSchool(() => storage.createOrReuseReviewedClassroomFlightPath(data))));
  assert.equal(new Set(imports.map(result => result.flightPath.id)).size, 1);
  assert.equal(imports.filter(result => result.reused).length, 2);
  const reordered = await inSchool(() => storage.createOrReuseReviewedClassroomFlightPath({ ...data, sourceResourceIds: ["a", "b"] }));
  assert.equal(reordered.flightPath.id, imports[0]!.flightPath.id);
  const otherPolicy = await inSchool(() => storage.createOrReuseReviewedClassroomFlightPath({ ...data, allowedDomains: ["different.example.org"] }));
  assert.notEqual(otherPolicy.flightPath.id, imports[0]!.flightPath.id);
  const ordinary = await inSchool(() => storage.createFlightPath(data));
  assert.notEqual(ordinary.id, imports[0]!.flightPath.id);
  await assert.rejects(inSchool(() => storage.createOrReuseReviewedClassroomFlightPath({ ...data, blockedDomains: ["blocked.example.org"] })));
});

test("dependent opens select only the recipient whose exact restriction application was acknowledged", async () => {
  const source = await applyPath([0, 1]);
  await confirm(source.command.id, 0);
  const open = await issue("open-tab", { url: "https://example.org/lesson", afterRestrictionCommandId: source.command.id }, [0, 1]);
  assert.notEqual(open.command.targets[0]!.status, "unavailable");
  assert.equal(open.command.targets[1]!.status, "unavailable");
  assert.equal(open.command.targets[1]!.errorMessage, "LESSON_RESTRICTION_PREREQUISITE_STALE");
  await assert.rejects(inSchool(() => dispatcher.executeClasspilotCommand({ schoolId: ids.school, actorId: ids.teacher,
    supervisionContextId: context.id, contextAuthorityRevision: String(context.classroomAuthorityRevision), targetScope: "class",
    commandType: "open-tab", rawCommandPayload: { url: "https://example.org/lesson", afterRestrictionCommandId: source.command.id }, targets: [target(0)] })));
});

test("a newer desired revision and a replacement login each refuse an old successful source ACK", async () => {
  const source = await applyPath(); await confirm(source.command.id);
  await issue("remove-flight-path", {});
  const stale = await issue("open-tab", { url: "https://example.org/lesson", afterRestrictionCommandId: source.command.id });
  assert.equal(stale.command.targets[0]!.status, "unavailable");
  const second = await applyPath(); await confirm(second.command.id);
  await inSchool(() => storage.endStudentSessionExact({ schoolId: ids.school, studentId: ids.students[0]!, deviceId: ids.devices[0]!, studentSessionId: sessions[0]! }));
  sessions[0] = (await inSchool(() => storage.startStudentSessionWithReplacements(ids.school, ids.students[0]!, ids.devices[0]!,
    { authKind: "manual_shared", sessionRecoveryTokenHash: "9".repeat(64) }))).session.id;
  await refresh(0);
  const rebound = await issue("open-tab", { url: "https://example.org/lesson", afterRestrictionCommandId: second.command.id });
  assert.equal(rebound.command.targets[0]!.status, "unavailable");
});

test("a queued dependent open cannot outlive a policy mutation holding the canonical student lock", async () => {
  const source = await applyPath(); await confirm(source.command.id);
  let releaseMutation!: () => void; let readyMutation!: () => void;
  const gate = new Promise<void>(resolve => { releaseMutation = resolve; });
  const ready = new Promise<void>(resolve => { readyMutation = resolve; });
  const mutation = inSchool(() => database.transaction(async tx => {
    await storage.lockClasspilotStudentControlAuthorities(ids.school, [ids.students[0]!], tx);
    readyMutation(); await gate;
    await tx.execute(sql`UPDATE classpilot_student_control_states SET revision=revision+1,applied_revision=NULL,enforcement_health='pending',last_outcome=NULL
      WHERE school_id=${ids.school} AND student_id=${ids.students[0]!}`);
  }));
  await ready;
  const pending = issue("open-tab", { url: "https://example.org/lesson", afterRestrictionCommandId: source.command.id });
  try {
    let waiting = false;
    for (let attempt = 0; attempt < 100 && !waiting; attempt++) {
      const observed = await admin.query<{ waiting: boolean }>("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%pg_advisory_xact_lock%' AND cardinality(pg_blocking_pids(pid))>0) AS waiting");
      waiting = observed.rows[0]!.waiting; if (!waiting) await pause(25);
    }
    assert.equal(waiting, true, "dependent open must wait at the actual canonical student authority lock");
  } finally { releaseMutation(); await mutation; }
  const opened = await pending;
  assert.equal(opened.command.targets[0]!.status, "unavailable");
  assert.equal(opened.command.targets[0]!.errorMessage, "LESSON_RESTRICTION_PREREQUISITE_STALE");
});

test("capability withdrawal refuses dependent open when the full precise snapshot would be withheld", async () => {
  process.env.CLASSPILOT_CAP_PRECISE_RESTRICTION_RESOURCES_V1 = "true";
  try {
    const path = await inSchool(() => storage.createFlightPath({ schoolId: ids.school, teacherId: ids.teacher,
      flightPathName: "Precise reviewed lesson", allowedDomains: [], blockedDomains: [], resources: [{ type: "resource",
        provider: "youtube", hostname: "youtube.com", includeSubdomains: false, resourceId: "dQw4w9WgXcQ",
        canonicalUrl: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" }] }));
    const applied = await issue("apply-flight-path", { flightPathId: path.id, expectedFlightPathUpdatedAt: path.updatedAt.toISOString() });
    await confirm(applied.command.id);
    await refresh(0, capabilities.filter(cap => cap !== "preciseRestrictionResourcesV1"));
    const opened = await issue("open-tab", { url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ", afterRestrictionCommandId: applied.command.id });
    assert.equal(opened.command.targets[0]!.status, "unavailable");
    assert.equal(opened.command.targets[0]!.errorMessage, "LESSON_RESTRICTION_SNAPSHOT_UNSUPPORTED");
  } finally { delete process.env.CLASSPILOT_CAP_PRECISE_RESTRICTION_RESOURCES_V1; }
});

test("exact status and reviewed reuse HTTP enforce current actor/context and public projection", async () => {
  const express = (await import("express")).default;
  const commandsRouter = (await import("../src/routes/classpilot/commands.js")).default;
  const flightPathsRouter = (await import("../src/routes/classpilot/flightPaths.js")).default;
  const { signUserToken } = await import("../src/services/jwt.js");
  const { createServer } = await import("node:http");
  const app = express(); app.use(express.json()); app.use("/api/classpilot", commandsRouter); app.use("/api/classpilot/flight-paths", flightPathsRouter);
  app.use((error: { status?: number; code?: string; message?: string }, _req: import("express").Request, res: import("express").Response, _next: import("express").NextFunction) =>
    res.status(error.status || 500).json({ error: error.message, code: error.code }));
  const server = createServer(app); await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert.ok(address && typeof address === "object");
  const origin = `http://127.0.0.1:${address.port}/api/classpilot`;
  const headers = { authorization: `Bearer ${signUserToken({ userId: ids.teacher, email: `${ids.teacher}@example.edu` })}`,
    "x-school-id": ids.school, "X-ClassPilot-Context-Authority-Revision": String(context.classroomAuthorityRevision), "content-type": "application/json" };
  try {
    const source = await applyPath(); await confirm(source.command.id);
    const exact = await fetch(`${origin}/commands/${source.command.id}/status?supervisionContextId=${context.id}`, { headers });
    assert.equal(exact.status, 200); const rawBody = await exact.json();
    const body = z.object({ command: z.object({ id: z.string(), targets: z.array(z.object({ result: z.object({ outcome: z.string() }) })).min(1) }) }).parse(rawBody);
    assert.equal(body.command.id, source.command.id); assert.equal(body.command.targets[0]!.result.outcome, "applied");
    const text = JSON.stringify(rawBody); assert.ok(!text.includes(ids.devices[0]!) && !text.includes(sessions[0]!) && !text.includes("frozenControlRevision"));
    const changedRevision = await fetch(`${origin}/commands/${source.command.id}/status?supervisionContextId=${context.id}`, {
      headers: { ...headers, "X-ClassPilot-Context-Authority-Revision": "999" } });
    assert.equal(changedRevision.status, 404);
    const unrelated = await fetch(`${origin}/commands/${source.command.id}/status?supervisionContextId=${randomUUID()}`, { headers });
    assert.equal(unrelated.status, 404);
    const importBody = { courseId: "http-course", selectedResourceIds: ["http-item"], resources: [{ id: "http-item", links: [{ url: "https://example.org/resource" }] }], reuseReviewedSource: true };
    const results = await Promise.all([0, 1].map(async () => {
      const response = await fetch(`${origin}/flight-paths/from-classroom`, { method: "POST", headers, body: JSON.stringify(importBody) });
      assert.equal(response.status, 201); return z.object({ flightPath: z.object({ id: z.string(), updatedAt: z.string().datetime() }), reused: z.boolean() }).parse(await response.json());
    }));
    assert.equal(results[0]!.flightPath.id, results[1]!.flightPath.id);
    assert.ok(results[0]!.flightPath.updatedAt); assert.deepEqual(results.map(result => result.reused).sort(), [false, true]);
  } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
});

test("the real Classroom UI lesson orchestrator follows canonical HTTP receipts under restricted RLS", async () => {
  const frontendUrl = new URL("../schoolpilot-app/src/products/classpilot/lib/classroomActions.js", import.meta.url).href;
  const frontend = z.object({
    runClassroomAction: z.function().args(z.unknown()).returns(z.promise(z.unknown())),
    reviewedFlightPathMatches: z.function().args(z.unknown(), z.unknown()).returns(z.boolean()),
  }).parse(await import(frontendUrl));
  const express = (await import("express")).default;
  const commandsRouter = (await import("../src/routes/classpilot/commands.js")).default;
  const flightPathsRouter = (await import("../src/routes/classpilot/flightPaths.js")).default;
  const { signUserToken } = await import("../src/services/jwt.js");
  const { createServer } = await import("node:http");
  const app = express(); app.use(express.json()); app.use("/api/classpilot", commandsRouter); app.use("/api/classpilot/flight-paths", flightPathsRouter);
  app.use((error: { status?: number; code?: string; message?: string }, _req: import("express").Request, res: import("express").Response, _next: import("express").NextFunction) =>
    res.status(error.status || 500).json({ error: error.message, code: error.code }));
  const server = createServer(app); await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert.ok(address && typeof address === "object");
  const origin = `http://127.0.0.1:${address.port}/api/classpilot`;
  const headers = { authorization: `Bearer ${signUserToken({ userId: ids.teacher, email: `${ids.teacher}@example.edu` })}`,
    "x-school-id": ids.school, "X-ClassPilot-Context-Authority-Revision": String(context.classroomAuthorityRevision), "content-type": "application/json" };
  const request = async (path: string, body?: unknown) => {
    const response = await fetch(`${origin}${path}`, { headers, ...(body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }) });
    const data: unknown = await response.json();
    assert.ok(response.ok, `Canonical HTTP ${response.status}: ${JSON.stringify(data)}`); return data;
  };
  const commandShape = z.object({ command: z.object({ id: z.string(), commandType: z.string(),
    targets: z.array(z.object({ studentId: z.string(), status: z.string() }).passthrough()) }).passthrough() });
  const issued: Array<{ type: string; payload: Record<string, unknown>; recipients: string[] }> = [];
  const polled: string[] = [];
  process.env.CLASSPILOT_CAP_PRECISE_RESTRICTION_RESOURCES_V1 = "true";
  try {
    const preview = z.object({ authoring: z.object({ allowedDomains: z.array(z.string()), resources: z.array(z.unknown()),
      resourceLinks: z.array(z.string()) }).passthrough() }).parse(await request("/flight-paths/preview-resources", {
      purpose: "classroom", boundary: "website", selectedResourceIds: ["combined-item"], resources: [{ id: "combined-item", links: [{ url: "https://example.org/lesson" }] }],
    }));
    const saved = z.object({ flightPath: z.object({ id: z.string(), updatedAt: z.string().datetime() }).passthrough(), reused: z.boolean() }).parse(
      await request("/flight-paths/from-classroom", { courseId: "combined-course", selectedResourceIds: ["combined-item"],
        resources: [{ id: "combined-item" }], resourceLinks: preview.authoring.resourceLinks, boundary: "website", reuseReviewedSource: true }));
    assert.equal(frontend.reviewedFlightPathMatches(saved.flightPath, preview.authoring), true);
    const outcomes = z.array(z.object({ studentId: z.string(), restriction: z.string(), open: z.string(), focus: z.string() })).parse(
      await frontend.runClassroomAction({ action: "lesson", url: "https://example.org/lesson", studentIds: ids.students,
        flightPath: saved.flightPath, waitOptions: { timeoutMs: 5000 },
        postCommand: async (type: string, payload: Record<string, unknown>, recipients: string[]) => {
          issued.push({ type, payload, recipients });
          const value = commandShape.parse(await request("/commands", { supervisionContextId: context.id, targetScope: "students",
            targetStudentIds: recipients, commandType: type, commandPayload: payload }));
          assert.ok(value.command.targets.every(target => target.status !== "unavailable"), JSON.stringify(value));
          if (type === "apply-flight-path") {
            await confirm(value.command.id, 0);
            const state = await control(1);
            await inSchool(() => storage.persistClasspilotCommandTargetAck({ commandId: value.command.id, schoolId: ids.school,
              studentId: ids.students[1]!, studentSessionId: sessions[1]!, deviceId: ids.devices[1]!, ackState: "failed",
              controlRevision: state.revision, acceptedCapabilities: capabilities, result: { outcome: "failed", appliedRevision: state.revision } }));
          } else {
            assert.equal(type, "open-tab");
            await openAck(value.command.id, (await control()).revision);
          }
          return value;
        },
        readCommand: async (command: { id: string }) => {
          polled.push(command.id);
          const data = await request(`/commands/${command.id}/status?supervisionContextId=${context.id}`);
          const publicJson = JSON.stringify(data);
          assert.ok(ids.devices.every(id => !publicJson.includes(id)) && sessions.every(id => !publicJson.includes(id)));
          return data;
        },
      }));
    assert.equal(issued.length, 2); assert.equal(issued[0]!.payload.expectedFlightPathUpdatedAt, saved.flightPath.updatedAt);
    assert.deepEqual(issued[1]!.recipients, [ids.students[0]!]); assert.ok(issued[1]!.payload.afterRestrictionCommandId);
    assert.equal(outcomes.find(row => row.studentId === ids.students[0])!.open, "completed");
    assert.equal(outcomes.find(row => row.studentId === ids.students[1])!.open, "not opened");
    assert.ok(outcomes.every(row => row.focus === "not requested")); assert.equal(new Set(polled).size, 2);
  } finally {
    delete process.env.CLASSPILOT_CAP_PRECISE_RESTRICTION_RESOURCES_V1;
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
});


