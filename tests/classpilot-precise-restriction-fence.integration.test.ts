import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { sql } from "drizzle-orm";
import { CLASSPILOT_SCHEDULED_CLASSROOM_SQL } from "../src/db/classpilotScheduledClassroomMigration.js";
import { CLASSPILOT_TOOLS_SQL } from "../src/db/classpilotToolsMigration.js";
import { classpilotCommandAuthorityEnvelope } from "../src/services/classpilotCommandAuthority.js";
import {
  CLASSPILOT_PRECISE_RESTRICTION_TARGET_UNAVAILABLE_REASON,
  effectiveClasspilotControlEnforcementHealth,
  serializeClasspilotStudentControlStateForDelivery,
} from "../src/services/classpilotClassroomState.js";

// Roadmap PR 2-pre forward-compatibility fence, exercised through the real
// command frame builder and dispatcher against a scheduled classroom (the
// scheduled classroom tools path). PR-2-shaped rows are written directly, as a
// newer server image would have left them before an image rollback.

process.env.REDIS_URL = "";
process.env.CLASSPILOT_SCHEDULED_CLASSROOM_MODE = "on";
delete process.env.CLASSPILOT_SCHEDULED_CLASSROOM_SCHOOL_IDS;
delete process.env.CLASSPILOT_SCHEDULED_CLASSROOM_EXCLUDED_SCHOOL_IDS;

const ids = { school: randomUUID(), teacher: randomUUID(), student: randomUUID(), device: randomUUID(), flightPath: randomUUID() };
let database: typeof import("../src/db.js").default;
let pool: typeof import("../src/db.js").pool;
let storage: typeof import("../src/services/storage.js");
let dispatcher: typeof import("../src/services/classpilotCommandDispatcher.js");
let tenant: typeof import("../src/middleware/tenantContext.js").runWithTenantContext;
let context: import("../src/schema/classpilot.js").ClasspilotSupervisionContext;
let bindingId: string;
const inSchool = <T>(fn: () => Promise<T>) => tenant({ schoolId: ids.school }, fn);
const statement = (query: ReturnType<typeof sql>) => inSchool(() => database.execute(query));
const control = async () => {
  const row = await inSchool(() => storage.getClasspilotStudentControlState(ids.school, ids.student));
  assert.ok(row, "the scheduled classroom owns a control state for the student");
  return row;
};
const staffScope = () => ({
  schoolId: ids.school,
  actorId: ids.teacher,
  authority: { supervisionContextId: context.id },
  contextAuthorityRevision: String(context.classroomAuthorityRevision),
});
const liveTarget = () => ({
  studentId: ids.student,
  studentName: "Precise Student",
  studentSessionId: bindingId,
  deviceId: ids.device,
  available: true,
  stateAuthorized: true,
});
const commandTargets = async (commandId: string) => {
  const rows: any = await statement(sql`SELECT status, error_message FROM classpilot_command_targets
    WHERE school_id=${ids.school} AND command_id=${commandId}`);
  return (rows.rows as Array<{ status: string; error_message: string | null }>);
};

const DOCS_ID = "1a2B3c4D5e6F7g8H9i0JkLmNoPqRsTuVwXyZ";
const DOCS_RESOURCE = {
  type: "resource",
  hostname: "docs.google.com",
  includeSubdomains: false,
  provider: "google_docs",
  resourceId: DOCS_ID,
  canonicalUrl: `https://docs.google.com/document/d/${DOCS_ID}/edit`,
};
const CLASSROOM_SECTION = {
  type: "section",
  hostname: "classroom.google.com",
  includeSubdomains: false,
  pathPrefix: "/c/NjE2MzQ1Njc4",
};
const KHAN_WEBSITE = { type: "website", hostname: "khanacademy.org", includeSubdomains: true };

before(async () => {
  assert.ok(["localhost", "127.0.0.1", "::1"].includes(new URL(process.env.DATABASE_URL || "").hostname), "The fence integration test requires the local fixture");
  process.env.DATABASE_URL_PRIVILEGED = process.env.DATABASE_URL;
  ({ default: database, pool } = await import("../src/db.js"));
  ({ runWithTenantContext: tenant } = await import("../src/middleware/tenantContext.js"));
  storage = await import("../src/services/storage.js");
  dispatcher = await import("../src/services/classpilotCommandDispatcher.js");
  await pool.query(CLASSPILOT_SCHEDULED_CLASSROOM_SQL);
  await pool.query(CLASSPILOT_TOOLS_SQL);
  const bootstrap = await readFile(new URL("../src/index.ts", import.meta.url), "utf8");
  const responseGuard = bootstrap.match(/await pool\.query\(`\s*(CREATE OR REPLACE FUNCTION classpilot_bind_poll_response_school\(\)[\s\S]*?)`\);/);
  assert.ok(responseGuard?.[1], "canonical poll-response parent guard must be available");
  await pool.query(responseGuard[1]);
  process.env.CLASSPILOT_CLASS_TOOLS_SCHOOLS_JSON = JSON.stringify({ [ids.school]: 5 });
  await pool.query("INSERT INTO schools(id,name,domain,status,plan_status) VALUES($1,'Precise fence',$2,'active','active')", [ids.school, `${ids.school}.example.edu`]);
  await pool.query("INSERT INTO users(id,email,first_name,last_name) VALUES($1,$2,'Precise','Teacher')", [ids.teacher, `${ids.teacher}@${ids.school}.example.edu`]);
  await pool.query("INSERT INTO school_memberships(school_id,user_id,role,status) VALUES($1,$2,'teacher','active')", [ids.school, ids.teacher]);
  await pool.query("INSERT INTO product_licenses(school_id,product,status) VALUES($1,'CLASSPILOT','active')", [ids.school]);
  await statement(sql`INSERT INTO settings(school_id,school_name,ws_shared_key,enable_tracking_hours,after_hours_mode,pause_chat_during_testing) VALUES(${ids.school},'Precise fence','test-only',false,'off',false)`);
  await statement(sql`INSERT INTO students(id,school_id,first_name,last_name,status) VALUES(${ids.student},${ids.school},'Precise','Student','active')`);
  await statement(sql`INSERT INTO flight_paths(id,school_id,teacher_id,flight_path_name,allowed_domains) VALUES(${ids.flightPath},${ids.school},${ids.teacher},'Mixed research',ARRAY['khanacademy.org']::text[])`);
  await inSchool(async () => {
    await storage.createDevice({ schoolId: ids.school, deviceId: ids.device, classId: "default", deviceName: "Test Chromebook" });
    bindingId = (await storage.startStudentSessionWithReplacements(ids.school, ids.student, ids.device,
      { authKind: "manual_shared", sessionRecoveryTokenHash: "c".repeat(64) })).session.id;
    context = await storage.createSupervisionContextWithStudents({ context: { schoolId: ids.school, name: "Scheduled research",
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
  // The live binding reports the capability set a 2.9.6 device negotiates.
  await writeClasspilotRealtimeStatus({ schoolId: ids.school, studentId: ids.student, studentSessionId: bindingId, deviceId: ids.device,
    heartbeatId: randomUUID(), observedAt: Date.now(), acceptedCapabilities: ["scopedAuthorityChecksV1", "scheduledClassroomV1",
      "lateSignInRestrictionSsoV1", "restrictionAuthPassThroughV1"] });
});

after(async () => {
  if (!pool) return;
  await tenant({ isSuper: true }, async () => {
    for (const table of ["audit_logs", "classpilot_tool_history", "classpilot_routine_runs", "classpilot_tool_templates", "classpilot_chat_deliveries", "chat_messages", "classpilot_active_hands", "session_settings",
      "classpilot_classroom_states", "classpilot_command_targets", "classpilot_commands", "classpilot_student_control_states",
      "classpilot_supervision_students", "classpilot_supervision_contexts", "flight_paths", "student_sessions", "devices", "students", "settings"]) {
      if (table === "student_sessions") await database.execute(sql`DELETE FROM student_sessions WHERE student_id=${ids.student}`);
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

type LegacyFrameFixture = {
  fixtureSchemaVersion: number;
  schoolId: string;
  target: { studentId: string; studentName: string; studentSessionId: string; deviceId: string; available: boolean };
  commandAuthority: { teachingSessionId: string };
  classroomState: ReturnType<typeof import("../src/services/classpilotClassroomState.js").serializeClasspilotStudentControlState>;
  cases: Array<{
    name: string;
    commandType: string;
    extensionType: string;
    payload: Record<string, unknown>;
    requiredCapabilities: Array<"lateSignInRestrictionSsoV1" | "restrictionAuthPassThroughV1">;
    attachClassroomState: boolean;
    frame: Record<string, unknown>;
  }>;
};

function legacyFrames(): LegacyFrameFixture {
  return JSON.parse(readFileSync(new URL(
    "./fixtures/classpilot-compatibility/schoolpilot-legacy-restriction-frames.json",
    import.meta.url
  ), "utf8")) as LegacyFrameFixture;
}

function frameFor(fixture: LegacyFrameFixture, testCase: LegacyFrameFixture["cases"][number], overrides: {
  payload?: Record<string, unknown>;
  classroomState?: LegacyFrameFixture["classroomState"];
} = {}) {
  const requiredCapability = testCase.requiredCapabilities.at(-1);
  return dispatcher.classpilotCommandFrameForTarget(
    fixture.schoolId,
    testCase.commandType,
    testCase.extensionType,
    overrides.payload ?? testCase.payload,
    fixture.target,
    {
      policy: "persistent_control",
      expiresAt: null,
      ...(requiredCapability ? { requiredCapability, requiredCapabilities: testCase.requiredCapabilities } : {}),
    },
    overrides.classroomState ?? (testCase.attachClassroomState ? fixture.classroomState : undefined),
    classpilotCommandAuthorityEnvelope(fixture.commandAuthority),
  );
}

test("today's Waypoint, Flight Path, Block List, attention and temporary-allow frames stay byte-identical", () => {
  const fixture = legacyFrames();
  assert.equal(fixture.fixtureSchemaVersion, 1);
  assert.equal(fixture.cases.length, 11);
  for (const testCase of fixture.cases) {
    const frame = frameFor(fixture, testCase);
    assert.ok(frame, testCase.name);
    assert.equal(
      JSON.stringify({ ...frame, _msgId: "<opaque-message-id>" }),
      JSON.stringify(testCase.frame),
      testCase.name
    );
  }
});

test("the frame builder never frames precise restriction resources, bare or with a snapshot", () => {
  const fixture = legacyFrames();
  const byName = new Map(fixture.cases.map((testCase) => [testCase.name, testCase]));
  const waypoint = byName.get("lock-screen:bare")!;
  const flightPath = byName.get("apply-flight-path:bare")!;
  const blockList = byName.get("apply-block-list:state")!;
  const preciseWaypoints = [
    { url: DOCS_RESOURCE.canonicalUrl, resource: DOCS_RESOURCE },
    { url: DOCS_RESOURCE.canonicalUrl, resource: null },
    { url: DOCS_RESOURCE.canonicalUrl, resource: "https://docs.google.com/" },
  ];
  for (const payload of preciseWaypoints) {
    for (const variant of [waypoint, byName.get("lock-screen:state")!, byName.get("lock-screen:deferred")!]) {
      assert.equal(frameFor(fixture, variant, { payload: { ...payload, commandId: "command-precise" } }), null, variant.name);
    }
  }
  const preciseFlightPaths = [
    { allowedDomains: [], resources: [DOCS_RESOURCE] },
    { allowedDomains: ["khanacademy.org"], resources: [KHAN_WEBSITE, CLASSROOM_SECTION, DOCS_RESOURCE] },
    { allowedDomains: ["khanacademy.org"], resources: [KHAN_WEBSITE] },
    { allowedDomains: ["khanacademy.org"], resources: "malformed" },
  ];
  for (const payload of preciseFlightPaths) {
    assert.equal(frameFor(fixture, flightPath, {
      payload: { flightPathId: "flight-path-precise", flightPathName: "Reading", ...payload, commandId: "command-precise" },
    }), null);
  }
  const preciseSnapshot = {
    ...fixture.classroomState,
    restrictions: {
      ...fixture.classroomState.restrictions,
      screenLock: { active: true, url: DOCS_RESOURCE.canonicalUrl, resource: DOCS_RESOURCE },
    },
  };
  // A legacy command carrying a precise snapshot is refused as well.
  assert.equal(frameFor(fixture, blockList, { classroomState: preciseSnapshot }), null);
  // Lesson Activity resources are not restriction resources.
  assert.ok(dispatcher.classpilotCommandFrameForTarget(
    fixture.schoolId,
    "lesson-activity",
    "lesson-activity",
    { action: "start", title: "Read", resources: [{ url: DOCS_RESOURCE.canonicalUrl }], commandId: "command-lesson" },
    fixture.target,
    { policy: "transient_action", expiresAt: null },
    undefined,
    classpilotCommandAuthorityEnvelope(fixture.commandAuthority),
  ));
});

test("a command over a stored precise Waypoint marks its live target unavailable with the real reason", async () => {
  // A newer image left a Docs resource Waypoint in the scheduled classroom.
  await statement(sql`UPDATE classpilot_student_control_states
    SET desired_state = ${JSON.stringify({
      restrictions: {
        screenLock: { active: true, url: DOCS_RESOURCE.canonicalUrl, resource: DOCS_RESOURCE },
        flightPath: { active: false, allowedDomains: [] },
        blockList: { active: false, blockedDomains: [] },
        attentionMode: { active: false },
        tabLimit: null,
        temporaryAllows: [],
      },
    })}::jsonb
    WHERE school_id=${ids.school} AND student_id=${ids.student}`);
  const before = await control();

  const result = await inSchool(() => dispatcher.executeClasspilotCommand({
    schoolId: ids.school,
    actorId: ids.teacher,
    supervisionContextId: context.id,
    contextAuthorityRevision: String(context.classroomAuthorityRevision),
    commandType: "limit-tabs",
    targetScope: "students",
    rawCommandPayload: { maxTabs: 3 },
    targets: [liveTarget()],
  }));
  assert.deepEqual(await commandTargets(result.command.id), [{
    status: "unavailable",
    error_message: CLASSPILOT_PRECISE_RESTRICTION_TARGET_UNAVAILABLE_REASON,
  }], "the withheld target is never left requested or given the binding-race default");

  const afterCommand = await control();
  assert.ok(afterCommand.revision > before.revision);
  const restrictions = (afterCommand.desiredState as { restrictions: Record<string, Record<string, unknown>> }).restrictions;
  assert.deepEqual(restrictions.screenLock, {
    active: true,
    url: DOCS_RESOURCE.canonicalUrl,
    resource: DOCS_RESOURCE,
  }, "the resource survives the rewrite instead of degrading to a domain lock");
  assert.equal(restrictions.tabLimit, 3);
  assert.deepEqual(serializeClasspilotStudentControlStateForDelivery({
    state: afterCommand,
    gateActive: true,
    acceptedCapabilities: ["scopedAuthorityChecksV1", "lateSignInRestrictionSsoV1", "restrictionAuthPassThroughV1"],
    exactBinding: { schoolId: ids.school, studentId: ids.student, studentSessionId: bindingId, deviceId: ids.device },
  }), { classroomState: null, withheld: true, withheldReason: "precise_restriction_capability_required" });
  assert.equal(effectiveClasspilotControlEnforcementHealth(afterCommand, "2.9.6"), "unsupported");
});

test("a teacher on this image can replace the precise Waypoint with a deliverable one", async () => {
  const result = await inSchool(() => dispatcher.executeClasspilotCommand({
    schoolId: ids.school,
    actorId: ids.teacher,
    supervisionContextId: context.id,
    contextAuthorityRevision: String(context.classroomAuthorityRevision),
    commandType: "lock-screen",
    targetScope: "students",
    rawCommandPayload: { url: "https://www.ixl.com/math" },
    targets: [liveTarget()],
  }));
  const [target] = await commandTargets(result.command.id);
  assert.ok(target);
  assert.notEqual(target.status, "unavailable");
  assert.equal(target.error_message, null);
  const replaced = await control();
  const restrictions = (replaced.desiredState as { restrictions: Record<string, Record<string, unknown>> }).restrictions;
  assert.deepEqual(restrictions.screenLock, { active: true, url: "https://www.ixl.com/math" });
  const delivered = serializeClasspilotStudentControlStateForDelivery({
    state: replaced,
    gateActive: true,
    acceptedCapabilities: ["scopedAuthorityChecksV1"],
    exactBinding: { schoolId: ids.school, studentId: ids.student, studentSessionId: bindingId, deviceId: ids.device },
  });
  assert.equal(delivered.withheld, false);
  assert.equal(delivered.classroomState?.restrictions.tabLimit, 3, "unrelated controls survive the replacement");
});

test("a routine retry replaying a newer server's precise Flight Path is refused before anything persists", async () => {
  const planning = await import("../src/services/classpilotToolsPlanning.js");
  const routines = await import("../src/services/classpilotToolsRoutines.js");
  const template = await inSchool(() => planning.saveToolTemplate(staffScope(), {
    name: "Research routine",
    kind: "routine",
    content: { title: "Research", steps: [{ kind: "flight_path", title: "Research", payload: { flightPathId: ids.flightPath } }] },
  }));
  const run = await inSchool(() => routines.startRoutine(staffScope(), template.id, [ids.student]));
  // The step's original command as a newer image would have stored it.
  const precisePayload = {
    flightPathId: ids.flightPath,
    flightPathName: "Mixed research",
    allowedDomains: ["khanacademy.org"],
    resources: [KHAN_WEBSITE, CLASSROOM_SECTION, DOCS_RESOURCE],
  };
  const original = await inSchool(() => storage.createClasspilotCommandWithTargets(
    { schoolId: ids.school, teacherId: ids.teacher, teachingSessionId: null, supervisionContextId: context.id,
      targetScope: "students", commandType: "apply-flight-path", commandPayload: precisePayload },
    [{ commandId: "reserved", schoolId: ids.school, studentId: ids.student, supervisionContextId: context.id,
      studentSessionId: bindingId, deviceId: ids.device }],
    { authority: { schoolId: ids.school, actorId: ids.teacher, supervisionContextId: context.id,
      contextAuthorityRevision: String(context.classroomAuthorityRevision) },
      routineReservation: { runId: run.id, expectedRevision: 1, step: 0 } }
  ));
  await statement(sql`UPDATE classpilot_command_targets SET status='failed' WHERE school_id=${ids.school} AND command_id=${original.id}`);
  const before = await control();

  const retried = await inSchool(() => routines.advanceRoutine(staffScope(), run.id, { action: "retry", step: 0, expectedRevision: 2 }));
  assert.ok("command" in retried && retried.command);
  const commandId = String(retried.command.id);
  assert.notEqual(commandId, original.id);
  assert.deepEqual(await commandTargets(commandId), [{
    status: "unavailable",
    error_message: CLASSPILOT_PRECISE_RESTRICTION_TARGET_UNAVAILABLE_REASON,
  }]);
  const stored: any = await statement(sql`SELECT command_payload FROM classpilot_commands WHERE school_id=${ids.school} AND id=${commandId}`);
  assert.deepEqual(stored.rows[0].command_payload.resources, precisePayload.resources, "the replay keeps the payload for audit");
  const afterRetry = await control();
  assert.equal(afterRetry.revision, before.revision, "no desired state was written from the precise payload");
  assert.deepEqual(afterRetry.desiredState, before.desiredState);
  const flightPathRows: any = await statement(sql`SELECT count(*)::int AS count FROM classpilot_classroom_states
    WHERE school_id=${ids.school} AND supervision_context_id=${context.id} AND state_type='flight-path' AND cleared_at IS NULL`);
  assert.equal(flightPathRows.rows[0].count, 0, "no legacy projection of the precise Flight Path was persisted");
  await inSchool(() => routines.advanceRoutine(staffScope(), run.id, { action: "end", expectedRevision: 3 }));
});
