import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { sql } from "drizzle-orm";
import { CLASSPILOT_SCHEDULED_CLASSROOM_SQL } from "../src/db/classpilotScheduledClassroomMigration.js";
import { CLASSPILOT_TOOLS_SQL } from "../src/db/classpilotToolsMigration.js";
import { classpilotCommandAuthorityEnvelope } from "../src/services/classpilotCommandAuthority.js";
import {
  CLASSPILOT_PRECISE_RESTRICTION_TARGET_UNAVAILABLE_REASON,
  effectiveClasspilotControlEnforcementHealth,
  emptyClasspilotRestrictions,
  serializeClasspilotStudentControlStateForDelivery,
} from "../src/services/classpilotClassroomState.js";
import { normalizeAllowedResource, type AllowedResource } from "../src/services/restrictionResources.js";

// Roadmap PR 2 dispatch gate, through the real dispatcher against a scheduled
// classroom: precise Waypoints and Flight Paths reach only live targets whose
// fresh snapshot ACCEPTED preciseRestrictionResourcesV1. A 2.9.6-shaped target
// becomes unavailable with the exact reason and gets no desired state, an
// offline student is never deferred, and website-only commands are unchanged.
// The last tests run the rollback clear (runbook step 2) against that state.

process.env.REDIS_URL = "";
process.env.CLASSPILOT_SCHEDULED_CLASSROOM_MODE = "on";
delete process.env.CLASSPILOT_SCHEDULED_CLASSROOM_SCHOOL_IDS;
delete process.env.CLASSPILOT_SCHEDULED_CLASSROOM_EXCLUDED_SCHOOL_IDS;
delete process.env.CLASSPILOT_CAPABILITY_ROLLOUTS_JSON;
process.env.CLASSPILOT_PROTOCOL_V3_ENABLED = "true";
process.env.CLASSPILOT_CAP_SCOPED_AUTHORITY_CHECKS_V1 = "true";
process.env.CLASSPILOT_CAP_PRECISE_RESTRICTION_RESOURCES_V1 = "true";
// The late-sign-in gate is on so the test proves precise commands never defer.
process.env.CLASSPILOT_CAP_LATE_SIGNIN_RESTRICTION_SSO_V1 = "true";

const ids = {
  school: randomUUID(),
  teacher: randomUUID(),
  capable: randomUUID(),
  legacy: randomUUID(),
  offline: randomUUID(),
  capableDevice: randomUUID(),
  legacyDevice: randomUUID(),
  offlineDevice: randomUUID(),
  mixedPath: randomUUID(),
  websitePath: randomUUID(),
};
let database: typeof import("../src/db.js").default;
let pool: typeof import("../src/db.js").pool;
let storage: typeof import("../src/services/storage.js");
let dispatcher: typeof import("../src/services/classpilotCommandDispatcher.js");
let tenant: typeof import("../src/middleware/tenantContext.js").runWithTenantContext;
let context: import("../src/schema/classpilot.js").ClasspilotSupervisionContext;
const bindings = new Map<string, string>();
const inSchool = <T>(fn: () => Promise<T>) => tenant({ schoolId: ids.school }, fn);
const statement = (query: ReturnType<typeof sql>) => inSchool(() => database.execute(query));

const DOC = normalizeAllowedResource({ url: "https://docs.google.com/document/d/1a2B3c4D5e6F7g8H9i0JkLmNoPqRsTuVwXyZ/edit" });
const VIDEO = normalizeAllowedResource({ url: "https://youtu.be/dQw4w9WgXcQ" });
const SECTION = normalizeAllowedResource({ url: "https://www.nasa.gov/solar-system" });
const LEGACY_CAPABILITIES = ["scopedAuthorityChecksV1", "scheduledClassroomV1", "lateSignInRestrictionSsoV1", "restrictionAuthPassThroughV1"];
const CAPABLE_CAPABILITIES = [...LEGACY_CAPABILITIES, "preciseRestrictionResourcesV1"];

function liveTarget(studentId: string, deviceId: string) {
  return {
    studentId,
    studentName: "Precise Student",
    studentSessionId: bindings.get(studentId)!,
    deviceId,
    available: true,
    stateAuthorized: true,
  };
}

function offlineTarget() {
  return {
    studentId: ids.offline,
    studentName: "Offline Student",
    studentSessionId: null,
    deviceId: null,
    available: false,
    stateAuthorized: true,
    lateSignInEligible: true,
    unavailableReason: "Student is not signed in",
  };
}

const allTargets = () => [
  liveTarget(ids.capable, ids.capableDevice),
  liveTarget(ids.legacy, ids.legacyDevice),
  offlineTarget(),
];

async function commandTargets(commandId: string) {
  const rows: any = await statement(sql`SELECT student_id, status, error_message FROM classpilot_command_targets
    WHERE school_id=${ids.school} AND command_id=${commandId}`);
  return new Map((rows.rows as Array<{ student_id: string; status: string; error_message: string | null }>)
    .map((row) => [row.student_id, row]));
}

async function control(studentId: string) {
  return inSchool(() => storage.getClasspilotStudentControlState(ids.school, studentId));
}

async function classroomStateRows(studentId: string) {
  const rows: any = await statement(sql`SELECT state_type, payload FROM classpilot_classroom_states
    WHERE school_id=${ids.school} AND supervision_context_id=${context.id} AND student_id=${studentId} AND cleared_at IS NULL
    ORDER BY state_type`);
  return rows.rows as Array<{ state_type: string; payload: Record<string, unknown> }>;
}

function execute(commandType: string, rawCommandPayload: Record<string, unknown>, targets = allTargets()) {
  return inSchool(() => dispatcher.executeClasspilotCommand({
    schoolId: ids.school,
    actorId: ids.teacher,
    supervisionContextId: context.id,
    contextAuthorityRevision: String(context.classroomAuthorityRevision),
    commandType,
    targetScope: "students",
    rawCommandPayload,
    targets,
  }));
}

before(async () => {
  assert.ok(["localhost", "127.0.0.1", "::1"].includes(new URL(process.env.DATABASE_URL || "").hostname), "The dispatch test requires the local fixture");
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
  await pool.query("INSERT INTO schools(id,name,domain,status,plan_status) VALUES($1,'Precise dispatch',$2,'active','active')", [ids.school, `${ids.school}.example.edu`]);
  await pool.query("INSERT INTO users(id,email,first_name,last_name) VALUES($1,$2,'Precise','Teacher')", [ids.teacher, `${ids.teacher}@${ids.school}.example.edu`]);
  await pool.query("INSERT INTO school_memberships(school_id,user_id,role,status) VALUES($1,$2,'teacher','active')", [ids.school, ids.teacher]);
  await pool.query("INSERT INTO product_licenses(school_id,product,status) VALUES($1,'CLASSPILOT','active')", [ids.school]);
  await statement(sql`INSERT INTO settings(school_id,school_name,ws_shared_key,enable_tracking_hours,after_hours_mode,pause_chat_during_testing) VALUES(${ids.school},'Precise dispatch','test-only',false,'off',false)`);
  for (const [studentId, first] of [[ids.capable, "Capable"], [ids.legacy, "Legacy"], [ids.offline, "Offline"]] as const) {
    await statement(sql`INSERT INTO students(id,school_id,first_name,last_name,status) VALUES(${studentId},${ids.school},${first},'Student','active')`);
  }
  await statement(sql`INSERT INTO flight_paths(id,school_id,teacher_id,flight_path_name,allowed_domains,resources)
    VALUES(${ids.mixedPath},${ids.school},${ids.teacher},'Moon phases',ARRAY['khanacademy.org']::text[],${JSON.stringify([SECTION, DOC, VIDEO])}::jsonb)`);
  await statement(sql`INSERT INTO flight_paths(id,school_id,teacher_id,flight_path_name,allowed_domains)
    VALUES(${ids.websitePath},${ids.school},${ids.teacher},'Websites',ARRAY['khanacademy.org','ixl.com']::text[])`);
  await inSchool(async () => {
    for (const [studentId, deviceId] of [[ids.capable, ids.capableDevice], [ids.legacy, ids.legacyDevice]] as const) {
      await storage.createDevice({ schoolId: ids.school, deviceId, classId: "default", deviceName: "Test Chromebook" });
      bindings.set(studentId, (await storage.startStudentSessionWithReplacements(ids.school, studentId, deviceId,
        { authKind: "manual_shared", sessionRecoveryTokenHash: randomUUID().replace(/-/g, "").padEnd(64, "c").slice(0, 64) })).session.id);
    }
    context = await storage.createSupervisionContextWithStudents({ context: { schoolId: ids.school, name: "Scheduled research",
      contextType: "coverage_group", assignedStaffId: ids.teacher, createdBy: ids.teacher, startsAt: new Date(Date.now() - 60_000),
      endsAt: new Date(Date.now() + 3_600_000), scheduleProfileApplicationId: randomUUID(), scheduleProfileBlockId: randomUUID(),
      scheduleProfileDate: new Date().toISOString().slice(0, 10) }, studentIds: [ids.capable, ids.legacy, ids.offline], assignedBy: ids.teacher });
  });
  const { writeClasspilotRealtimeStatus, setClasspilotRealtimeStatusCommandForTests } = await import("../src/services/classpilotRealtimeStatus.js");
  const shared = new Map<string, string>();
  setClasspilotRealtimeStatusCommandForTests(async (args) => {
    if (args[0] === "MGET") return args.slice(1).map((key) => shared.get(key) ?? null);
    if (args[0] === "EVAL" && args[3] && args[5]?.startsWith("{")) { shared.set(args[3], args[5]); return args[5]; }
    return undefined;
  });
  for (const [studentId, deviceId, acceptedCapabilities] of [
    [ids.capable, ids.capableDevice, CAPABLE_CAPABILITIES],
    [ids.legacy, ids.legacyDevice, LEGACY_CAPABILITIES],
  ] as const) {
    await writeClasspilotRealtimeStatus({ schoolId: ids.school, studentId, studentSessionId: bindings.get(studentId)!, deviceId,
      heartbeatId: randomUUID(), observedAt: Date.now(), acceptedCapabilities: [...acceptedCapabilities] });
  }
});

after(async () => {
  if (!pool) return;
  await tenant({ isSuper: true }, async () => {
    for (const table of ["audit_logs", "classpilot_tool_history", "classpilot_routine_runs", "classpilot_tool_templates", "classpilot_chat_deliveries", "chat_messages", "classpilot_active_hands", "session_settings",
      "classpilot_classroom_states", "classpilot_command_targets", "classpilot_commands", "classpilot_student_control_states",
      "classpilot_supervision_students", "classpilot_supervision_contexts", "flight_paths", "student_sessions", "devices", "students", "settings"]) {
      if (table === "student_sessions") {
        await database.execute(sql`DELETE FROM student_sessions WHERE student_id IN (${ids.capable}, ${ids.legacy}, ${ids.offline})`);
      } else {
        await database.execute(sql`DELETE FROM ${sql.identifier(table)} WHERE school_id=${ids.school}`);
      }
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

test("a precise Waypoint reaches only the capable target; the 2.9.6 and offline targets get no desired state", async () => {
  const legacyBefore = await control(ids.legacy);
  const offlineBefore = await control(ids.offline);
  const result = await execute("lock-screen", { url: "https://youtu.be/dQw4w9WgXcQ?t=5", boundary: "resource" });
  const targets = await commandTargets(result.command.id);
  assert.equal(targets.get(ids.capable)?.error_message, null);
  assert.notEqual(targets.get(ids.capable)?.status, "unavailable");
  assert.deepEqual(targets.get(ids.legacy), {
    student_id: ids.legacy,
    status: "unavailable",
    error_message: CLASSPILOT_PRECISE_RESTRICTION_TARGET_UNAVAILABLE_REASON,
  });
  assert.equal(targets.get(ids.offline)?.status, "unavailable");
  assert.notEqual(targets.get(ids.offline)?.error_message, CLASSPILOT_PRECISE_RESTRICTION_TARGET_UNAVAILABLE_REASON,
    "an offline student is reported as offline, not as needing an update");

  const capable = await control(ids.capable);
  assert.ok(capable);
  const screenLock = (capable.desiredState as { restrictions: { screenLock: Record<string, unknown> } }).restrictions.screenLock;
  assert.deepEqual(screenLock, { active: true, url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ", resource: VIDEO });
  const delivered = serializeClasspilotStudentControlStateForDelivery({
    state: capable,
    gateActive: true,
    acceptedCapabilities: CAPABLE_CAPABILITIES,
    exactBinding: { schoolId: ids.school, studentId: ids.capable, studentSessionId: bindings.get(ids.capable)!, deviceId: ids.capableDevice },
  });
  assert.deepEqual(delivered.classroomState?.restrictions.screenLock, screenLock);
  assert.deepEqual((await classroomStateRows(ids.capable)).map((row) => row.state_type), ["screen-lock"]);

  // No desired state, no classroom-state row, so no legacy projection exists
  // for the targets that could not receive it.
  assert.deepEqual(await control(ids.legacy), legacyBefore);
  assert.deepEqual(await control(ids.offline), offlineBefore);
  assert.deepEqual(await classroomStateRows(ids.legacy), []);
  assert.deepEqual(await classroomStateRows(ids.offline), []);
  const stored: any = await statement(sql`SELECT command_payload FROM classpilot_commands WHERE school_id=${ids.school} AND id=${result.command.id}`);
  assert.deepEqual(stored.rows[0].command_payload, { url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ", resource: VIDEO });
});

test("the offline student that signs in later on 2.9.6 still receives no precise restriction", async () => {
  // Signing in later cannot resurrect the refused Waypoint: nothing was
  // deferred, so the student's snapshot holds no precise entry to withhold or
  // to widen, and the command target stays unavailable.
  const offline = await control(ids.offline);
  const precise = JSON.stringify(offline?.desiredState ?? {});
  assert.equal(precise.includes("resource"), false);
  const [latest]: any = (await statement(sql`SELECT id FROM classpilot_commands WHERE school_id=${ids.school}
    AND command_type='lock-screen' ORDER BY created_at DESC LIMIT 1`)).rows;
  assert.equal((await commandTargets(latest.id)).get(ids.offline)?.status, "unavailable");
});

test("a precise Flight Path carries its sections and resources only to the capable target", async () => {
  const legacyBefore = await control(ids.legacy);
  const result = await execute("apply-flight-path", { flightPathId: ids.mixedPath });
  const stored: any = await statement(sql`SELECT command_payload FROM classpilot_commands WHERE school_id=${ids.school} AND id=${result.command.id}`);
  assert.deepEqual(stored.rows[0].command_payload, {
    flightPathId: ids.mixedPath,
    flightPathName: "Moon phases",
    allowedDomains: ["khanacademy.org"],
    resources: [SECTION, DOC, VIDEO],
  });
  const targets = await commandTargets(result.command.id);
  assert.equal(targets.get(ids.legacy)?.error_message, CLASSPILOT_PRECISE_RESTRICTION_TARGET_UNAVAILABLE_REASON);
  assert.notEqual(targets.get(ids.capable)?.status, "unavailable");
  const capable = await control(ids.capable);
  const flightPath = (capable!.desiredState as { restrictions: { flightPath: Record<string, unknown> } }).restrictions.flightPath;
  assert.deepEqual(flightPath.resources, [SECTION, DOC, VIDEO]);
  assert.deepEqual(flightPath.allowedDomains, ["khanacademy.org"], "section and resource hosts are never widened into allowedDomains");
  assert.deepEqual(await control(ids.legacy), legacyBefore);
  // The legacy student's control state never carries the precise path, so its
  // health stays as it was rather than reporting a delivery it cannot take.
  assert.equal(effectiveClasspilotControlEnforcementHealth(capable!, "2.9.6", new Date(), {
    gateActive: true, acceptedCapabilities: LEGACY_CAPABILITIES, exactBinding: null,
  }), "unsupported", "a 2.9.6 client reading the capable student's snapshot would be unsupported");
});

test("website-only commands are unchanged for every target", async () => {
  const result = await execute("apply-flight-path", { flightPathId: ids.websitePath }, [
    liveTarget(ids.capable, ids.capableDevice),
    liveTarget(ids.legacy, ids.legacyDevice),
  ]);
  const stored: any = await statement(sql`SELECT command_payload FROM classpilot_commands WHERE school_id=${ids.school} AND id=${result.command.id}`);
  assert.deepEqual(stored.rows[0].command_payload, {
    flightPathId: ids.websitePath,
    flightPathName: "Websites",
    allowedDomains: ["khanacademy.org", "ixl.com"],
  }, "no resources key on a website-only payload");
  const targets = await commandTargets(result.command.id);
  for (const studentId of [ids.capable, ids.legacy]) {
    assert.notEqual(targets.get(studentId)?.status, "unavailable", studentId);
    assert.equal(targets.get(studentId)?.error_message, null, studentId);
  }
  const legacy = await control(ids.legacy);
  const restrictions = (legacy!.desiredState as { restrictions: { flightPath: Record<string, unknown>; screenLock: Record<string, unknown> } }).restrictions;
  assert.deepEqual(restrictions.flightPath, { active: true, allowedDomains: ["khanacademy.org", "ixl.com"], name: "Websites" });
  assert.equal("resource" in restrictions.screenLock, false);
});

test("precise commands refuse with 409 while the school's rollout is off", async () => {
  process.env.CLASSPILOT_CAP_PRECISE_RESTRICTION_RESOURCES_V1 = "false";
  try {
    for (const [commandType, payload] of [
      ["lock-screen", { url: "https://youtu.be/dQw4w9WgXcQ", boundary: "resource" }],
      ["apply-flight-path", { flightPathId: ids.mixedPath }],
    ] as const) {
      await assert.rejects(() => execute(commandType, payload), (error: unknown) => {
        const failure = error as { status?: number; code?: string };
        return failure.status === 409 && failure.code === "PRECISE_RESTRICTION_RESOURCES_DISABLED";
      }, commandType);
    }
    // Website Waypoints and website-only paths are unaffected by the rollout.
    const website = await execute("lock-screen", { url: "https://www.ixl.com/math" }, [liveTarget(ids.legacy, ids.legacyDevice)]);
    assert.equal((await commandTargets(website.command.id)).get(ids.legacy)?.error_message, null);
  } finally {
    process.env.CLASSPILOT_CAP_PRECISE_RESTRICTION_RESOURCES_V1 = "true";
  }
});

test("the frame builder frames a precise payload only with its precise snapshot and declared capability", async () => {
  const capable = await control(ids.capable);
  assert.ok(capable);
  const target = liveTarget(ids.capable, ids.capableDevice);
  const authority = classpilotCommandAuthorityEnvelope({ supervisionContextId: context.id });
  const payload = { url: DOC.type === "resource" ? DOC.canonicalUrl : "", resource: DOC, commandId: "command-precise-frame" };
  const preciseState = {
    ...(await import("../src/services/classpilotClassroomState.js")).serializeClasspilotStudentControlState(capable),
    restrictions: {
      ...(await import("../src/services/classpilotClassroomState.js")).emptyClasspilotRestrictions(),
      screenLock: { active: true, url: payload.url, resource: DOC as AllowedResource },
    },
  };
  const frame = (classroomState: typeof preciseState | undefined, requiredCapabilities?: Array<"preciseRestrictionResourcesV1" | "restrictionAuthPassThroughV1">) =>
    dispatcher.classpilotCommandFrameForTarget(ids.school, "lock-screen", "lock-screen", payload, target, {
      policy: "persistent_control",
      expiresAt: null,
      ...(requiredCapabilities ? { requiredCapability: requiredCapabilities.at(-1), requiredCapabilities } : {}),
    }, classroomState, authority);
  assert.equal(frame(undefined, ["preciseRestrictionResourcesV1"]), null, "a bare precise frame is never built");
  assert.equal(frame(preciseState), null, "the capability must be declared on the frame");
  assert.equal(frame(preciseState, ["restrictionAuthPassThroughV1"]), null);
  const built = frame(preciseState, ["preciseRestrictionResourcesV1"]) as Record<string, any> | null;
  assert.ok(built);
  assert.deepEqual(built.classroomState.restrictions.screenLock.resource, DOC);
  assert.equal(built.exactBinding?.bindingVersion, 2, "precise frames are exact-bound");
});

test("the reviewed rollback precheck and the clear transform agree on every stored shape", async () => {
  const rollback = await import("../src/services/classpilotPreciseRestrictionRollback.js");
  const predicate = sql.raw(rollback.PRECISE_CONTROL_STATE_PREDICATE_SQL.replaceAll("desired_state", "candidate.value"));
  for (const shape of [
    {},
    { restrictions: emptyClasspilotRestrictions() },
    { restrictions: { ...emptyClasspilotRestrictions(), screenLock: { active: true, url: "https://docs.google.com/document/d/x/edit", resource: DOC } } },
    { restrictions: { ...emptyClasspilotRestrictions(), screenLock: { active: false, resource: null } } },
    { restrictions: { ...emptyClasspilotRestrictions(), flightPath: { active: true, allowedDomains: ["a.example"], resources: [] } } },
    { restrictions: { ...emptyClasspilotRestrictions(), flightPath: { active: true, allowedDomains: ["a.example"] } } },
    { restrictions: [{ screenLock: { resource: DOC } }] },
    { restrictions: { screenLock: ["resource"] } },
    { screenLock: "resource" },
    { screenLock: { active: true, resource: DOC } },
    { flightPath: { active: true, allowedDomains: [], resources: [DOC] } },
    { lateSignInDelivery: { screenLock: { resource: DOC } } },
    { restorableClassState: { desiredState: { restrictions: { flightPath: { active: true, resources: [SECTION] } } } } },
    { restorableClassState: { desiredState: { screenLock: { resource: DOC } } } },
    { restorableClassState: [{ desiredState: { screenLock: { resource: DOC } } }] },
    { restorableClassState: { desiredState: { restrictions: { flightPath: { active: true, allowedDomains: ["a.example"] } } } } },
  ]) {
    const rows: any = await statement(sql`SELECT coalesce(${predicate}, false) AS precise
      FROM (SELECT ${JSON.stringify(shape)}::jsonb AS value) AS candidate`);
    assert.equal(rows.rows[0].precise, rollback.clearPreciseRestrictionsFromDesiredState(shape).changed, JSON.stringify(shape));
  }
});

test("the rollback clear ends every stored precise restriction with one revision bump and keeps everything else", async () => {
  const clear = await import("../src/services/classpilotPreciseRestrictionClear.js");
  const rollback = await import("../src/services/classpilotPreciseRestrictionRollback.js");
  // A live "This resource only" Waypoint over the capable student's retained
  // website Flight Path from the earlier test.
  const { writeClasspilotRealtimeStatus } = await import("../src/services/classpilotRealtimeStatus.js");
  await writeClasspilotRealtimeStatus({ schoolId: ids.school, studentId: ids.capable, studentSessionId: bindings.get(ids.capable)!,
    deviceId: ids.capableDevice, heartbeatId: randomUUID(), observedAt: Date.now(), acceptedCapabilities: [...CAPABLE_CAPABILITIES] });
  await execute("lock-screen", { url: "https://docs.google.com/document/d/1a2B3c4D5e6F7g8H9i0JkLmNoPqRsTuVwXyZ/edit", boundary: "resource" },
    [liveTarget(ids.capable, ids.capableDevice)]);
  const capableBefore = (await control(ids.capable))!;
  const legacyBefore = await control(ids.legacy);
  const beforeRestrictions = (capableBefore.desiredState as { restrictions: Record<string, unknown> }).restrictions;
  assert.deepEqual((beforeRestrictions.screenLock as Record<string, unknown>).resource, DOC);
  const capableRows = await classroomStateRows(ids.capable);
  assert.deepEqual(capableRows.map((row) => row.state_type), ["flight-path", "screen-lock"]);
  assert.equal("resources" in capableRows[0]!.payload, false);
  assert.deepEqual(capableRows[1]!.payload.resource, DOC);

  // A Coverage restoration snapshot carrying a precise Flight Path, an expired
  // legacy flat snapshot, and a class-wide precise classroom-state row.
  const flatStudent = randomUUID();
  await statement(sql`INSERT INTO students(id,school_id,first_name,last_name,status) VALUES(${flatStudent},${ids.school},'Flat','Student','active')`);
  await statement(sql`INSERT INTO classpilot_student_control_states(school_id,student_id,supervision_context_id,revision,desired_state,hard_expires_at)
    VALUES(${ids.school},${flatStudent},${context.id},4,${JSON.stringify({ screenLock: { active: true, url: "https://docs.google.com/document/d/x/edit", resource: DOC } })}::jsonb,
      now() - interval '1 hour')`);
  const restorable = {
    teachingSessionId: randomUUID(),
    sourceCommandId: randomUUID(),
    desiredState: {
      restrictions: { ...emptyClasspilotRestrictions(), flightPath: { active: true, allowedDomains: ["khanacademy.org"], name: "Moon phases", resources: [SECTION] } },
    },
  };
  await statement(sql`INSERT INTO classpilot_student_control_states(school_id,student_id,revision,desired_state)
    VALUES(${ids.school},${ids.offline},2,${JSON.stringify({ restrictions: emptyClasspilotRestrictions(), restorableClassState: restorable })}::jsonb)
    ON CONFLICT (school_id,student_id) DO UPDATE SET desired_state=EXCLUDED.desired_state,
      revision=classpilot_student_control_states.revision+1, teaching_session_id=NULL, supervision_context_id=NULL,
      scheduled_end_at=NULL, hard_expires_at=NULL`);
  const offlineBefore = (await control(ids.offline))!;
  const classWide: any = await statement(sql`INSERT INTO classpilot_classroom_states(school_id,supervision_context_id,student_id,state_type,state_key,payload,applied_by)
    VALUES(${ids.school},${context.id},NULL,'flight-path','class-wide',${JSON.stringify({ flightPathId: ids.mixedPath, allowedDomains: ["khanacademy.org"], resources: [SECTION, DOC, VIDEO] })}::jsonb,${ids.teacher})
    RETURNING id`);
  const classWideId = classWide.rows[0].id as string;

  const plan = await inSchool(() => clear.planClasspilotPreciseRestrictionClear(ids.school));
  assert.equal(plan.controlStateCount, 3);
  assert.equal(plan.classroomStateCount, 2);
  assert.deepEqual(
    (await inSchool(() => clear.inventoryClasspilotPreciseRestrictions())).filter((entry) => entry.schoolId === ids.school),
    [{ schoolId: ids.school, controlStateCount: 3, classroomStateCount: 2 }]
  );

  const failedWith = (code: string) => (error: unknown) => (error as { code?: string }).code === code;
  await assert.rejects(
    () => inSchool(() => clear.clearClasspilotPreciseRestrictionsForSchool({ schoolId: ids.school, expectedProof: plan.proof })),
    failedWith("PRECISE_RESTRICTION_CAPABILITY_ACTIVE"),
    "the off profile must be applied first"
  );
  process.env.CLASSPILOT_CAP_PRECISE_RESTRICTION_RESOURCES_V1 = "false";
  try {
    await assert.rejects(
      () => inSchool(() => clear.clearClasspilotPreciseRestrictionsForSchool({
        schoolId: ids.school,
        expectedProof: `${rollback.PRECISE_RESTRICTION_CLEAR_PROOF_PREFIX}${"0".repeat(64)}`,
      })),
      failedWith("PRECISE_RESTRICTION_CLEAR_PROOF_MISMATCH")
    );
    assert.deepEqual(await control(ids.capable), capableBefore, "a refused clear changes nothing");

    const result = await inSchool(() => clear.clearClasspilotPreciseRestrictionsForSchool({ schoolId: ids.school, expectedProof: plan.proof }));
    assert.deepEqual(result, {
      schoolId: ids.school,
      controlStatesCleared: 3,
      screenLocksCleared: 2,
      flightPathsCleared: 1,
      restorableSnapshotsCleared: 1,
      classroomStatesCleared: 2,
    });

    const capableAfter = (await control(ids.capable))!;
    assert.equal(capableAfter.revision, capableBefore.revision + 1);
    assert.deepEqual(capableAfter.desiredState, {
      ...(capableBefore.desiredState as Record<string, unknown>),
      restrictions: { ...beforeRestrictions, screenLock: { active: false } },
    }, "only the precise Waypoint ends; the website Flight Path stays");
    assert.equal(capableAfter.enforcementHealth, "pending");
    assert.equal(capableAfter.appliedRevision, null);
    assert.equal(capableAfter.sourceCommandId, null);
    assert.equal(capableAfter.lastOutcome, rollback.PRECISE_RESTRICTION_CLEAR_OUTCOME);
    assert.equal(capableAfter.teachingSessionId, capableBefore.teachingSessionId);
    assert.equal(capableAfter.supervisionContextId, capableBefore.supervisionContextId);

    const offlineAfter = (await control(ids.offline))!;
    assert.equal(offlineAfter.revision, offlineBefore.revision + 1);
    assert.deepEqual(offlineAfter.desiredState, {
      restrictions: emptyClasspilotRestrictions(),
      restorableClassState: {
        ...restorable,
        sourceCommandId: null,
        desiredState: { restrictions: { ...restorable.desiredState.restrictions, flightPath: { active: false, allowedDomains: [] } } },
      },
    });
    const flatAfter = (await control(flatStudent))!;
    assert.equal(flatAfter.revision, 5);
    assert.deepEqual(flatAfter.desiredState, { screenLock: { active: false } });
    assert.deepEqual(await control(ids.legacy), legacyBefore, "a website Waypoint is untouched");

    assert.deepEqual((await classroomStateRows(ids.capable)).map((row) => row.state_type), ["flight-path"]);
    const classWideAfter: any = await statement(sql`SELECT cleared_at FROM classpilot_classroom_states WHERE school_id=${ids.school} AND id=${classWideId}`);
    assert.ok(classWideAfter.rows[0].cleared_at, "the class-wide precise row is cleared");

    // Nothing precise remains, the next dry run proves it, and a 2.9.6 binding
    // receives the cleared revision instead of a withheld state.
    const again = await inSchool(() => clear.planClasspilotPreciseRestrictionClear(ids.school));
    assert.equal(again.controlStateCount + again.classroomStateCount, 0);
    assert.deepEqual(
      (await inSchool(() => clear.inventoryClasspilotPreciseRestrictions())).filter((entry) => entry.schoolId === ids.school),
      []
    );
    const delivered = serializeClasspilotStudentControlStateForDelivery({
      state: capableAfter,
      gateActive: true,
      acceptedCapabilities: LEGACY_CAPABILITIES,
      exactBinding: { schoolId: ids.school, studentId: ids.capable, studentSessionId: bindings.get(ids.capable)!, deviceId: ids.capableDevice },
    });
    assert.equal(delivered.withheld, false);
    assert.deepEqual(delivered.classroomState?.restrictions.screenLock, { active: false });
    assert.deepEqual(delivered.classroomState?.restrictions.flightPath, { active: true, allowedDomains: ["khanacademy.org", "ixl.com"], name: "Websites" });
    const repeated = await inSchool(() => clear.clearClasspilotPreciseRestrictionsForSchool({ schoolId: ids.school, expectedProof: again.proof }));
    assert.equal(repeated.controlStatesCleared + repeated.classroomStatesCleared, 0, "a repeated clear is a no-op");
    assert.equal((await control(ids.capable))!.revision, capableAfter.revision);
  } finally {
    process.env.CLASSPILOT_CAP_PRECISE_RESTRICTION_RESOURCES_V1 = "true";
  }
});

test("teacher intent attributes a URL allowed by a delivered precise Flight Path entry to the Flight Path", async () => {
  const { classpilotTeacherIntentForUrl } = await import("../src/services/classpilotTeacherIntent.js");
  const video = normalizeAllowedResource({ url: "https://youtu.be/dQw4w9WgXcQ" });
  const flightPath = { active: true, allowedDomains: ["khanacademy.org"], resources: [video] };
  assert.equal(classpilotTeacherIntentForUrl("https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=5", { allowedDomains: [], flightPath }), "flight_path");
  assert.equal(classpilotTeacherIntentForUrl("https://www.youtube.com/watch?v=aaaaaaaaaaa", { allowedDomains: [], flightPath }), null,
    "another video on the same host is not the teacher's choice");
  assert.equal(classpilotTeacherIntentForUrl("https://www.youtube.com/watch?v=dQw4w9WgXcQ", {
    allowedDomains: [], flightPath: { ...flightPath, active: false },
  }), null);
  assert.equal(classpilotTeacherIntentForUrl("https://www.youtube.com/watch?v=dQw4w9WgXcQ", {
    allowedDomains: [], flightPath: { ...flightPath, resources: "garbage" },
  }), null);
  assert.equal(classpilotTeacherIntentForUrl("https://www.khanacademy.org/math", { allowedDomains: [], flightPath }), "flight_path");
});
