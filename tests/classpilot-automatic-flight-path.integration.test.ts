import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, test } from "node:test";
import pg from "pg";
import { sql } from "drizzle-orm";
import { z } from "zod";
import type { FlightPath, Group, TeachingSession } from "../src/schema/classpilot.js";
import { focusRecord } from "../src/services/classpilotFocus.js";
import { normalizePreciseWaypointResource } from "../src/services/restrictionResources.js";
import { serializeClasspilotStudentControlState, serializeClasspilotStudentControlStateForDelivery } from "../src/services/classpilotClassroomState.js";

process.env.REDIS_URL = "";
process.env.CLASSPILOT_PROTOCOL_V3_ENABLED = "true";
process.env.CLASSPILOT_CAP_SCOPED_AUTHORITY_CHECKS_V1 = "true";
process.env.CLASSPILOT_CAP_PRECISE_RESTRICTION_RESOURCES_V1 = "true";
process.env.CLASSPILOT_CAP_LATE_SIGNIN_RESTRICTION_SSO_V1 = "true";
process.env.CLASSPILOT_CAP_FOCUS_TAB_V1 = "true";
process.env.CLASSPILOT_SCHEDULED_CLASSROOM_MODE = "on";
process.env.CLASSPILOT_SHARED_TEACHING_RESOURCES_MODE = "on";
delete process.env.CLASSPILOT_SHARED_TEACHING_RESOURCES_SCHOOL_IDS;
delete process.env.CLASSPILOT_CAPABILITY_ROLLOUTS_JSON;
delete process.env.CLASSPILOT_SCHEDULED_CLASSROOM_SCHOOL_IDS;
delete process.env.CLASSPILOT_SCHEDULED_CLASSROOM_EXCLUDED_SCHOOL_IDS;

const ids = { school: randomUUID(), otherSchool: randomUUID(), teacher: randomUUID(), coTeacher: randomUUID(), outsider: randomUUID(), observerAdmin: randomUUID(), dualRoleStaff: randomUUID() };
const capabilities = ["classroomStateV1", "scopedAuthorityChecksV1", "scheduledClassroomV1", "lateSignInRestrictionSsoV1", "preciseRestrictionResourcesV1", "focusTabV1", "screenOnlyUnlockV1"];
const automaticStateSchema = z.object({ revision: z.number().int().nonnegative(), status: z.enum(["inactive", "active", "off", "unavailable"]) });
let admin: pg.Pool;
let database: typeof import("../src/db.js").default;
let storage: typeof import("../src/services/storage.js");
let dispatcher: typeof import("../src/services/classpilotCommandDispatcher.js");
let realtime: typeof import("../src/services/classpilotRealtimeStatus.js");
let tenant: typeof import("../src/middleware/tenantContext.js").runWithTenantContext;
const fixtures: Fixture[] = [];
const cache = new Map<string, string>();
const inSchool = <T>(fn: () => Promise<T>) => tenant({ schoolId: ids.school }, fn);

type Binding = { studentId: string; deviceId: string; studentSessionId: string };
type Fixture = { group: Group; path: FlightPath; bindings: Binding[]; session?: TeachingSession };

async function refresh(binding: Binding, acceptedCapabilities = capabilities) {
  await realtime.writeClasspilotRealtimeStatus({ schoolId: ids.school, ...binding, heartbeatId: randomUUID(), observedAt: Date.now(),
    extensionVersion: "2.9.7", acceptedCapabilities, tabSnapshotRevision: 9,
    allOpenTabs: [{ tabRef: "automatic-path-exact-tab", url: "https://example.org/lesson", title: "Synthetic lesson" }] });
}

async function fixture(options: { students?: number; precise?: boolean; online?: boolean } = {}): Promise<Fixture> {
  return inSchool(async () => {
    const group = await storage.createGroup({ schoolId: ids.school, teacherId: ids.teacher,
      name: `Automatic Flight Path ${randomUUID()}`, groupType: "admin_class", status: "active", scheduleEnabled: false });
    // Independent cases deliberately share a bell window. Seed its recurring
    // definition directly so the ordinary schedule-overlap writer is not the
    // subject of these tests; each case has a separate frozen student roster.
    await storage.addGroupTeacher(group.id, ids.coTeacher, "co-teacher");
    await database.execute(sql`UPDATE groups SET schedule_enabled=true,block_start_time='09:00',block_end_time='10:00' WHERE id=${group.id}`);
    group.scheduleEnabled = true;
    group.blockStartTime = "09:00";
    group.blockEndTime = "10:00";
    const path = await storage.createFlightPath({ schoolId: ids.school, teacherId: ids.teacher, flightPathName: "Prepared lesson",
      allowedDomains: options.precise ? [] : ["example.org"], blockedDomains: [],
      ...(options.precise ? { resources: [normalizePreciseWaypointResource("https://docs.google.com/document/d/1a2B3c4D5e6F7g8H9i0JkLmNoPqRsTuVwXyZ/edit")] } : {}) });
    const bindings: Binding[] = [];
    const result: Fixture = { group, path, bindings };
    fixtures.push(result);
    for (let index = 0; index < (options.students ?? 2); index++) {
      const studentId = randomUUID();
      const deviceId = randomUUID();
      await database.execute(sql`INSERT INTO students(id,school_id,first_name,last_name,status) VALUES(${studentId},${ids.school},'Automatic',${String(index)},'active')`);
      await storage.createDevice({ schoolId: ids.school, deviceId, classId: "default", deviceName: "Synthetic Chromebook" });
      const studentSession = await storage.startStudentSessionWithReplacements(ids.school, studentId, deviceId,
        { authKind: "manual_shared", sessionRecoveryTokenHash: randomUUID().replaceAll("-", "").repeat(2) });
      const binding = { studentId, deviceId, studentSessionId: studentSession.session.id };
      bindings.push(binding);
      if (options.online !== false) await refresh(binding);
    }
    await storage.addGroupStudentsDetailed(group.id, bindings.map(binding => binding.studentId));
    return result;
  });
}

async function configure(item: Fixture, options: { actorId?: string; enabled?: boolean; flightPathId?: string | null; expectedRevision?: number } = {}) {
  return inSchool(async () => {
    const actorId = options.actorId ?? ids.teacher;
    const current = await storage.getClasspilotAutomaticFlightPathPolicy({ schoolId: ids.school, groupId: item.group.id, actorId });
    return storage.updateClasspilotAutomaticFlightPathPolicy({ schoolId: ids.school, groupId: item.group.id, actorId,
      expectedRevision: options.expectedRevision ?? current.policy.revision, enabled: options.enabled ?? true,
      flightPathId: options.flightPathId === undefined ? item.path.id : options.flightPathId,
      expectedFlightPathUpdatedAt: item.path.updatedAt.toISOString() });
  });
}

async function start(item: Fixture, options: { actorId?: string; mode?: "live" | "scheduled_report" } = {}) {
  item.session = await inSchool(() => storage.createTeachingSession({ groupId: item.group.id, teacherId: options.actorId ?? ids.teacher,
    sessionMode: options.mode ?? "live", startTime: new Date(Date.now() - 60_000), scheduledDate: new Date().toISOString().slice(0, 10),
    scheduledTimezone: "UTC", scheduledStartAt: new Date(Date.now() - 60_000), scheduledEndAt: new Date(Date.now() + 3_600_000), scheduledState: "active" }));
  return item.session;
}

async function reload(item: Fixture) {
  assert.ok(item.session);
  const session = await inSchool(() => storage.getTeachingSessionByIdAndSchool(item.session!.id, ids.school));
  assert.ok(session);
  return session;
}

async function control(item: Fixture, index = 0) {
  const state = await inSchool(() => storage.getClasspilotStudentControlState(ids.school, item.bindings[index]!.studentId));
  assert.ok(state);
  return state;
}

async function restrictions(item: Fixture, index = 0) {
  return serializeClasspilotStudentControlState(await control(item, index)).restrictions;
}

async function issue(item: Fixture, commandType: string, rawCommandPayload: Record<string, unknown>, options: {
  actorId?: string; indexes?: number[]; stopRevision?: number; unavailable?: boolean;
} = {}) {
  assert.ok(item.session);
  return inSchool(() => dispatcher.executeClasspilotCommand({ schoolId: ids.school, actorId: options.actorId ?? ids.teacher,
    teachingSessionId: item.session!.id, targetScope: options.stopRevision === undefined ? "students" : "class", commandType, rawCommandPayload,
    targets: (options.indexes ?? item.bindings.map((_, index) => index)).map(index => ({ ...item.bindings[index]!, studentName: "Synthetic student",
      available: options.unavailable !== true, stateAuthorized: options.unavailable !== true,
      ...(options.unavailable ? { unavailableReason: "Student is temporarily supervised elsewhere" } : {}) })),
    ...(options.stopRevision === undefined ? {} : { stopAutomaticFlightPath: { expectedRevision: options.stopRevision } }),
  }));
}

async function turnOff(item: Fixture, options: { actorId?: string; unavailable?: boolean } = {}) {
  const current = automaticStateSchema.parse((await reload(item)).automaticFlightPathState);
  return issue(item, "remove-flight-path", {}, { ...options, stopRevision: current.revision });
}

async function outsideSchoolHours(mode: "off" | "limited") {
  const nextDay = new Intl.DateTimeFormat("en-US", { weekday: "long", timeZone: "UTC" })
    .format(new Date(Date.now() + 86_400_000));
  await admin.query("UPDATE settings SET enable_tracking_hours=true,tracking_start_time='00:00',tracking_end_time='23:59',tracking_days=$1::text[],school_timezone='UTC',after_hours_mode=$2 WHERE school_id=$3",
    [[nextDay], mode, ids.school]);
}

async function restoreSchoolHours() {
  await admin.query("UPDATE settings SET enable_tracking_hours=false,after_hours_mode='off' WHERE school_id=$1", [ids.school]);
}

describe("Automatic per-class Flight Path under restricted RLS", { skip: process.env.RLS_GUC_ENABLED !== "true", concurrency: false }, () => {
  before(async () => {
    assert.ok(["localhost", "127.0.0.1", "::1"].includes(new URL(process.env.DATABASE_URL || "").hostname));
    assert.ok(process.env.ADMIN_DATABASE_URL, "An independent local bootstrap role is required");
    admin = new pg.Pool({ connectionString: process.env.ADMIN_DATABASE_URL });
    const migration = await import("../src/db/migrations27.js");
    const sharedResources = await import("../src/db/sharedTeachingResourcesMigration.js");
    const preciseResources = await import("../src/db/flightPathResourcesMigration.js");
    const contentRevision = await import("../src/db/flightPathContentRevisionMigration.js");
    const staffSignIn = await import("../src/db/microsoftSignInMigration.js");
    // The isolated workspace template predates the existing Flight Path
    // library/precise-resource migrations and staff sign-in columns needed by
    // the HTTP auth middleware. Apply their real additive SQL rather than
    // inventing a weaker test-only table shape.
    await admin.query(`BEGIN; ${sharedResources.SHARED_TEACHING_RESOURCES_EXPAND_SQL}
      ${preciseResources.FLIGHT_PATH_RESOURCES_EXPAND_SQL} ${contentRevision.FLIGHT_PATH_CONTENT_REVISION_SQL}
      ${staffSignIn.MICROSOFT_SIGN_IN_EXPAND_SQL} ${migration.CLASSPILOT_AUTOMATIC_FLIGHT_PATH_SQL} COMMIT;`);
    const { policySqlFor } = await import("../src/db/rlsPolicies.js");
    const tenantTables = ["groups", "flight_paths", "teaching_sessions", "classpilot_session_staff", "classpilot_session_students",
      "classpilot_student_control_states", "classpilot_classroom_states", "classpilot_commands", "classpilot_command_targets"];
    for (const table of tenantTables) {
      for (const statement of policySqlFor(table)) await admin.query(statement);
      await admin.query(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`);
    }
    const policies = await admin.query<{ relrowsecurity: boolean; relforcerowsecurity: boolean; read_policy: boolean; write_policy: boolean }>(
      "SELECT c.relrowsecurity,c.relforcerowsecurity,p.polqual IS NOT NULL AS read_policy,p.polwithcheck IS NOT NULL AS write_policy FROM pg_class c JOIN pg_policy p ON p.polrelid=c.oid WHERE c.relname=ANY($1::text[]) AND p.polname='tenant_isolation'", [tenantTables]);
    assert.equal(policies.rowCount, tenantTables.length);
    assert.ok(policies.rows.every(row => row.relrowsecurity && row.relforcerowsecurity && row.read_policy && row.write_policy));
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
    await admin.query("INSERT INTO schools(id,name,domain,status,plan_status) VALUES($1,'Automatic path fixture',$2,'active','active'),($3,'Automatic other tenant',$4,'active','active')",
      [ids.school, `${ids.school}.example.edu`, ids.otherSchool, `${ids.otherSchool}.example.edu`]);
    for (const actorId of [ids.teacher, ids.coTeacher, ids.outsider, ids.observerAdmin, ids.dualRoleStaff]) {
      await admin.query("INSERT INTO users(id,email,first_name,last_name) VALUES($1,$2,'Automatic','Staff')", [actorId, `${actorId}@example.edu`]);
      await admin.query("INSERT INTO school_memberships(school_id,user_id,role,status) VALUES($1,$2,$3,'active')",
        [ids.school, actorId, actorId === ids.observerAdmin ? "admin" : "teacher"]);
    }
    // Insert teacher first: selecting one arbitrary membership row used to
    // hide this user's equally active administrator role.
    await admin.query("INSERT INTO school_memberships(school_id,user_id,role,status) VALUES($1,$2,'admin','active')", [ids.school, ids.dualRoleStaff]);
    await admin.query("INSERT INTO product_licenses(school_id,product,status) VALUES($1,'CLASSPILOT','active'),($2,'CLASSPILOT','active')", [ids.school, ids.otherSchool]);
    process.env.CLASSPILOT_CLASS_TOOLS_SCHOOLS_JSON = JSON.stringify({ [ids.school]: 5 });
    await inSchool(() => database.execute(sql`INSERT INTO settings(school_id,school_name,ws_shared_key,enable_tracking_hours,after_hours_mode)
      VALUES(${ids.school},'Automatic path fixture','synthetic-only',false,'off')`));
    realtime.setClasspilotRealtimeStatusCommandForTests(async args => {
      if (args[0] === "MGET") return args.slice(1).map(key => cache.get(key) ?? null);
      if (args[0] === "EVAL" && args[3] && args[5]?.startsWith("{")) { cache.set(args[3], args[5]); return args[5]; }
      return undefined;
    });
  });

  after(async () => {
    if (!admin) return;
    realtime?.setClasspilotRealtimeStatusCommandForTests(undefined);
    // Synthetic roots are intentionally retained in this disposable database,
    // as required by the real staff/school integrity migration. Retire their
    // schedules and sessions so a later local suite cannot pick them up.
    await admin.query("UPDATE groups SET schedule_enabled=false,status='archived' WHERE school_id=$1", [ids.school]);
    await admin.query("UPDATE teaching_sessions SET end_time=COALESCE(end_time,now()),scheduled_state=CASE WHEN scheduled_date IS NOT NULL THEN 'finalized' ELSE scheduled_state END WHERE school_id=$1", [ids.school]);
    await admin.query("UPDATE classpilot_supervision_contexts SET status='ended',ended_at=COALESCE(ended_at,now()) WHERE school_id=$1", [ids.school]);
    await (await import("../src/services/errorMonitor.js")).default.disposeAndWait();
    const pools = await import("../src/db.js");
    const scheduler = await import("../src/services/schedulerDb.js");
    await Promise.all([admin.end(), pools.pool.end(), pools.sessionPool.end(), scheduler.schedulerPool.end(), scheduler.schedulerLockPool.end()]);
  });

  test("new classes are off by default and a report-only occurrence never applies a configured path", async () => {
    const ordinary = await fixture();
    const initial = await inSchool(() => storage.getClasspilotAutomaticFlightPathPolicy({ schoolId: ids.school, groupId: ordinary.group.id, actorId: ids.teacher }));
    assert.equal(initial.policy.enabled, false);
    await start(ordinary);
    assert.equal((await restrictions(ordinary)).flightPath.active, false);
    const report = await fixture();
    await configure(report);
    await start(report, { mode: "scheduled_report" });
    const state = await inSchool(() => storage.getClasspilotStudentControlState(ids.school, report.bindings[0]!.studentId));
    assert.notEqual(state && serializeClasspilotStudentControlState(state).restrictions.flightPath.active, true);
    assert.notEqual(focusRecord((await reload(report)).automaticFlightPathState).status, "active");
    const promoted = await inSchool(() => storage.promoteScheduledReportSessionToLive({ schoolId: ids.school, sessionId: report.session!.id }));
    assert.ok(promoted);
    assert.equal(focusRecord(promoted.automaticFlightPathState).status, "active", "the promotion response includes the frozen preset");
    report.session = promoted;
    assert.equal((await restrictions(report)).flightPath.active, true, "a real live promotion is the application boundary");
  });

  test("a live co-teacher start uses the class's configured path and freezes later preference/resource changes", async () => {
    const item = await fixture();
    await configure(item);
    const started = await start(item, { actorId: ids.coTeacher });
    assert.equal(focusRecord(started.automaticFlightPathState).status, "active", "the create response includes the frozen preset");
    assert.deepEqual((await restrictions(item)).flightPath.allowedDomains, ["example.org"]);
    assert.equal(focusRecord((await reload(item)).automaticFlightPathState).status, "active");
    await configure(item, { enabled: false, flightPathId: null });
    await admin.query("UPDATE flight_paths SET allowed_domains=ARRAY['changed.example.org'],updated_at=now() WHERE id=$1", [item.path.id]);
    await inSchool(() => storage.resyncClasspilotSessionStudents(item.session!));
    assert.deepEqual((await restrictions(item)).flightPath.allowedDomains, ["example.org"]);
    assert.equal(focusRecord((await reload(item)).automaticFlightPathState).status, "active");
  });

  test("configuration rejects unrelated staff, cross-tenant access, and stale revisions", async () => {
    const item = await fixture();
    await assert.rejects(configure(item, { actorId: ids.outsider }));
    await assert.rejects(configure(item, { actorId: ids.coTeacher }), "co-teachers may use the frozen preset, but only the primary teacher/admin changes future defaults");
    await assert.rejects(tenant({ schoolId: ids.otherSchool }, () => storage.updateClasspilotAutomaticFlightPathPolicy({
      schoolId: ids.school, groupId: item.group.id, actorId: ids.teacher, expectedRevision: 0, enabled: true, flightPathId: item.path.id,
    })));
    await configure(item);
    await assert.rejects(configure(item, { expectedRevision: 0 }));
    const current = await inSchool(() => storage.getClasspilotAutomaticFlightPathPolicy({ schoolId: ids.school, groupId: item.group.id, actorId: ids.teacher }));
    assert.equal(current.policy.enabled, true);
    assert.equal(current.policy.flightPathId, item.path.id);
  });

  test("oversized presets are rejected at save and a later oversized edit leaves the next class live and unrestricted", async () => {
    const oversizedDomains = Array.from({ length: 800 }, (_, index) => `lesson${index}.${"a".repeat(48)}.example.org`);
    const oversized = await fixture({ students: 1 });
    oversized.path = await inSchool(() => storage.createFlightPath({ schoolId: ids.school, teacherId: ids.teacher,
      flightPathName: "Large saved lesson", allowedDomains: oversizedDomains, blockedDomains: [] }));
    const { classpilotFlightPathApplyPayload } = await import("../src/services/classpilotPreciseRestrictions.js");
    const size = Buffer.byteLength(JSON.stringify(classpilotFlightPathApplyPayload({ schoolId: ids.school, flightPath: oversized.path })), "utf8");
    assert.ok(size > 48 * 1024 && size < 64 * 1024, "exercise automatic headroom below the ordinary 64-KiB ceiling");
    await assert.rejects(configure(oversized), { code: "AUTOMATIC_FLIGHT_PATH_TOO_LARGE" });
    const unchanged = await inSchool(() => storage.getClasspilotAutomaticFlightPathPolicy({ schoolId: ids.school,
      groupId: oversized.group.id, actorId: ids.teacher }));
    assert.equal(unchanged.policy.enabled, false);
    assert.equal(unchanged.policy.revision, 0);

    const edited = await fixture({ students: 1 });
    await configure(edited);
    await admin.query("UPDATE flight_paths SET allowed_domains=$1::text[],updated_at=now() WHERE id=$2", [oversizedDomains, edited.path.id]);
    const started = await start(edited);
    assert.equal(started.sessionMode, "live");
    assert.equal(started.endTime, null);
    assert.equal(focusRecord(started.automaticFlightPathState).status, "unavailable");
    assert.equal(focusRecord(started.automaticFlightPathState).reasonCode, "AUTOMATIC_FLIGHT_PATH_TOO_LARGE");
    assert.equal((await restrictions(edited)).flightPath.active, false);
  });

  test("off and limited school monitoring prevent automatic application without blocking the live class", async () => {
    for (const mode of ["off", "limited"] as const) {
      const item = await fixture({ students: 1 });
      await configure(item);
      try {
        await outsideSchoolHours(mode);
        const started = await start(item);
        assert.equal(started.sessionMode, "live");
        assert.equal(started.endTime, null);
        assert.equal(focusRecord(started.automaticFlightPathState).status, "unavailable");
        assert.equal(focusRecord(started.automaticFlightPathState).reasonCode, "AUTOMATIC_FLIGHT_PATH_MONITORING_UNAVAILABLE");
        assert.equal((await restrictions(item)).flightPath.active, false);
        await restoreSchoolHours();
        await inSchool(() => storage.initializeClasspilotStudentControlStatesForSession(started));
        assert.equal((await restrictions(item)).flightPath.active, false, "resuming monitoring must not change this occurrence's frozen result");
      } finally { await restoreSchoolHours(); }
    }
  });

  test("after-hours HTTP cleanup permits only an exact automatic stop by immutable session staff", async () => {
    const item = await fixture({ students: 1 });
    await configure(item);
    await start(item);
    const revision = automaticStateSchema.parse(item.session!.automaticFlightPathState).revision;
    const { createApp } = await import("../src/app.js");
    const { signUserToken } = await import("../src/services/jwt.js");
    const server = createServer(createApp());
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
    const request = (method: string, endpoint: string, actorId: string, body?: Record<string, unknown>) => fetch(`${baseUrl}${endpoint}`, {
      method,
      headers: { authorization: `Bearer ${signUserToken({ userId: actorId, email: `${actorId}@example.edu`, isSuperAdmin: false })}`,
        "x-school-id": ids.school, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const stop = { teachingSessionId: item.session!.id, targetScope: "class", commandType: "remove-flight-path", commandPayload: {},
      stopAutomaticFlightPath: { expectedRevision: revision } };
    try {
      await outsideSchoolHours("off");
      const status = await request("GET", `/classpilot/teaching-sessions/${item.session!.id}/automatic-flight-path`, ids.coTeacher);
      assert.equal(status.status, 200, await status.text());
      const ordinary = await request("POST", "/classpilot/commands", ids.teacher, {
        teachingSessionId: item.session!.id, targetScope: "class", commandType: "remove-flight-path", commandPayload: {},
      });
      assert.equal(ordinary.status, 403, await ordinary.text());
      const malformed = await request("POST", "/classpilot/commands", ids.teacher, { ...stop, targetStudentIds: [] });
      assert.equal(malformed.status, 400, await malformed.text());
      const observer = await request("POST", "/classpilot/commands", ids.observerAdmin, stop);
      assert.equal(observer.status, 404, await observer.text());
      assert.equal(focusRecord((await reload(item)).automaticFlightPathState).status, "active");
      const stopped = await request("POST", "/classpilot/commands", ids.coTeacher, stop);
      assert.equal(stopped.status, 201, await stopped.text());
      assert.equal(focusRecord((await reload(item)).automaticFlightPathState).status, "off");
      assert.equal((await restrictions(item)).flightPath.active, false);
    } finally {
      await restoreSchoolHours();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  });

  test("saving a future default cannot activate a preexisting live occurrence with a legacy null snapshot", async () => {
    const item = await fixture();
    await start(item);
    await admin.query("UPDATE teaching_sessions SET automatic_flight_path_state=NULL WHERE id=$1", [item.session!.id]);
    const legacyLive = await reload(item);
    await configure(item);
    await inSchool(() => storage.resyncClasspilotSessionStudents(legacyLive));
    await inSchool(() => storage.initializeClasspilotStudentControlStatesForSession(legacyLive));
    assert.equal((await restrictions(item)).flightPath.active, false);
    assert.notEqual(focusRecord((await reload(item)).automaticFlightPathState).status, "active");
  });

  test("all active staff roles grant preset management without granting Observe-only command authority", async () => {
    const item = await fixture();
    const shared = await inSchool(() => storage.createFlightPath({ schoolId: ids.school, teacherId: ids.dualRoleStaff,
      flightPathName: "Shared administrator lesson", allowedDomains: ["shared.example.org"], blockedDomains: [], visibility: "school" }));
    item.path = shared;
    const configured = await configure(item, { actorId: ids.dualRoleStaff });
    assert.equal(configured.canManage, true);
    assert.equal(configured.policy.flightPathId, shared.id);
    await start(item);
    assert.deepEqual((await restrictions(item)).flightPath.allowedDomains, ["shared.example.org"]);
    await assert.rejects(turnOff(item, { actorId: ids.dualRoleStaff }));
    assert.equal(focusRecord((await reload(item)).automaticFlightPathState).status, "active");
  });

  test("replaying live initialization preserves manual command provenance and its acknowledged revision", async () => {
    const item = await fixture({ students: 1 });
    await configure(item);
    await start(item);
    const manual = await issue(item, "limit-tabs", { maxTabs: 4 });
    const pending = await control(item);
    assert.equal(pending.sourceCommandId, manual.command.id);
    const acknowledged = await inSchool(() => storage.acknowledgeClasspilotStudentControlState({ schoolId: ids.school,
      ...item.bindings[0]!, appliedRevision: pending.revision, acceptedCapabilities: capabilities, outcome: "applied" }));
    assert.ok(acknowledged);
    assert.equal(acknowledged.enforcementHealth, "synced");
    assert.equal(acknowledged.appliedRevision, pending.revision);
    await inSchool(() => storage.initializeClasspilotStudentControlStatesForSession(item.session!));
    const replayed = await control(item);
    assert.equal(replayed.sourceCommandId, manual.command.id);
    assert.equal(replayed.revision, acknowledged.revision);
    assert.equal(replayed.appliedRevision, acknowledged.appliedRevision);
    assert.equal(replayed.enforcementHealth, "synced");
    assert.equal(replayed.lastAcknowledgedAt?.toISOString(), acknowledged.lastAcknowledgedAt?.toISOString());
    assert.deepEqual(replayed.desiredState, acknowledged.desiredState);
  });

  test("Turn off survives reload, reconciliation, a new student binding, and another start attempt", async () => {
    const item = await fixture();
    await configure(item);
    await start(item);
    const staleStartedSession = item.session!;
    await turnOff(item);
    assert.equal(focusRecord((await reload(item)).automaticFlightPathState).status, "off");
    for (const binding of item.bindings) await refresh(binding);
    await inSchool(() => storage.initializeClasspilotStudentControlStatesForSession(staleStartedSession));
    assert.equal((await restrictions(item)).flightPath.active, false);
    const original = item.bindings[0]!;
    await inSchool(() => storage.endStudentSessionExact({ schoolId: ids.school, ...original }));
    const replacement = await inSchool(() => storage.startStudentSessionWithReplacements(ids.school, original.studentId, original.deviceId,
      { authKind: "manual_shared", sessionRecoveryTokenHash: randomUUID().replaceAll("-", "").repeat(2) }));
    original.studentSessionId = replacement.session.id;
    await refresh(original);
    await inSchool(() => storage.resyncClasspilotSessionStudents(staleStartedSession));
    await inSchool(() => storage.initializeClasspilotStudentControlStatesForSession(staleStartedSession));
    assert.equal((await restrictions(item)).flightPath.active, false);
    assert.equal(focusRecord((await reload(item)).automaticFlightPathState).status, "off");
    const configured = await inSchool(() => storage.getClasspilotAutomaticFlightPathPolicy({ schoolId: ids.school, groupId: item.group.id, actorId: ids.teacher }));
    assert.equal(configured.policy.enabled, true, "this occurrence's off button must not disable future classes");
  });

  test("concurrent Turn off and repeated live initialization leave the occurrence disabled", async () => {
    const item = await fixture();
    await configure(item);
    await start(item);
    await Promise.all([
      turnOff(item),
      inSchool(() => storage.initializeClasspilotStudentControlStatesForSession(item.session!)),
    ]);
    assert.equal(focusRecord((await reload(item)).automaticFlightPathState).status, "off");
    assert.equal((await restrictions(item)).flightPath.active, false);
    assert.equal((await restrictions(item, 1)).flightPath.active, false);
  });

  test("Turn off while students are temporarily claimed cannot resurrect the old path on their return", async () => {
    const item = await fixture();
    await configure(item);
    await start(item);
    const context = await inSchool(() => storage.createSupervisionContextWithStudents({ context: {
      schoolId: ids.school, name: "Temporary supervision", contextType: "coverage_group", assignedStaffId: ids.coTeacher,
      createdBy: ids.coTeacher, startsAt: new Date(Date.now() - 1000), endsAt: new Date(Date.now() + 30 * 60_000),
    }, studentIds: item.bindings.map(binding => binding.studentId), assignedBy: ids.coTeacher }));
    assert.equal((await control(item)).supervisionContextId, context.id);
    await turnOff(item, { unavailable: true });
    assert.equal(focusRecord((await reload(item)).automaticFlightPathState).status, "off");
    await inSchool(() => storage.releaseSupervisionStudents({ schoolId: ids.school, contextId: context.id,
      studentIds: item.bindings.map(binding => binding.studentId), releaseReason: "returned" }));
    assert.equal((await control(item)).teachingSessionId, item.session!.id);
    assert.equal((await restrictions(item)).flightPath.active, false);
    assert.equal((await restrictions(item, 1)).flightPath.active, false);
  });

  test("a manual path supersedes automatic provenance and remains after the class automatic path is turned off", async () => {
    const item = await fixture();
    await configure(item);
    await start(item);
    const manual = await inSchool(() => storage.createFlightPath({ schoolId: ids.school, teacherId: ids.teacher,
      flightPathName: "Teacher's explicit choice", allowedDomains: ["manual.example.org"], blockedDomains: [] }));
    await issue(item, "apply-flight-path", { flightPathId: manual.id }, { indexes: [0] });
    const stopped = await turnOff(item);
    assert.deepEqual((await restrictions(item)).flightPath.allowedDomains, ["manual.example.org"]);
    assert.equal((await restrictions(item)).flightPath.active, true);
    assert.equal((await restrictions(item, 1)).flightPath.active, false);
    const command = await inSchool(() => storage.getClasspilotCommandByIdAndSchool(stopped.command.id, ids.school));
    const manualTarget = command?.targets.find(target => target.studentId === item.bindings[0]!.studentId);
    assert.equal(manualTarget?.status, "unavailable", "the manual override must never receive generic remove-flight-path transport");
    assert.equal(manualTarget?.sentAt, null);
    assert.match(manualTarget?.errorMessage ?? "", /Automatic Flight Path already inactive|manual choice|manual.*preserv/i);
    assert.doesNotMatch(manualTarget?.errorMessage ?? "", /binding changed/i);
    await inSchool(() => storage.initializeClasspilotStudentControlStatesForSession(item.session!));
    assert.deepEqual((await restrictions(item)).flightPath.allowedDomains, ["manual.example.org"]);
  });

  test("Turn off preserves website Focus and tab limits for each student", async () => {
    const item = await fixture();
    await configure(item);
    await start(item);
    await issue(item, "limit-tabs", { maxTabs: 5 });
    await issue(item, "lock-screen", { url: "https://example.org/focus" }, { indexes: [0] });
    await issue(item, "lock-screen", { url: "https://example.org/waypoint" }, { indexes: [1] });
    const beforeFocus = (await restrictions(item)).screenLock;
    const beforeWaypoint = (await restrictions(item, 1)).screenLock;
    assert.equal(beforeFocus.active, true);
    assert.equal(beforeWaypoint.active, true);
    await turnOff(item);
    assert.equal((await restrictions(item)).flightPath.active, false);
    assert.equal((await restrictions(item, 1)).flightPath.active, false);
    assert.deepEqual((await restrictions(item)).screenLock, beforeFocus);
    assert.deepEqual((await restrictions(item, 1)).screenLock, beforeWaypoint);
    assert.equal((await restrictions(item)).tabLimit, 5);
    assert.equal((await restrictions(item, 1)).tabLimit, 5);
  });

  test("frozen class deadlines clear an offline snapshot and old finalization cannot clear a newer owner's state", async () => {
    const item = await fixture();
    await configure(item);
    await start(item);
    const original = await control(item);
    assert.equal(original.scheduledEndAt?.toISOString(), item.session!.scheduledEndAt?.toISOString());
    assert.equal(serializeClasspilotStudentControlState(original, new Date(item.session!.scheduledEndAt!.getTime() - 1)).restrictions.flightPath.active, true);
    assert.equal(serializeClasspilotStudentControlState(original, item.session!.scheduledEndAt!).restrictions.flightPath.active, false);
    const next = await fixture({ students: 0 });
    next.bindings.push(...item.bindings);
    await inSchool(() => storage.addGroupStudentsDetailed(next.group.id, next.bindings.map(binding => binding.studentId)));
    await configure(next);
    await start(next);
    await issue(next, "lock-screen", { url: "https://next.example.org/" });
    const before = await control(next);
    await inSchool(() => storage.finalizeTeachingSession({ schoolId: ids.school, sessionId: item.session!.id, reason: "manual_end", recipients: [] }));
    const after = await control(next);
    assert.equal(after.teachingSessionId, next.session!.id);
    assert.equal(after.revision, before.revision);
    assert.deepEqual(after.desiredState, before.desiredState);
  });

  test("precise paths seed only freshly accepted exact bindings, never offline or unsupported students", async () => {
    const item = await fixture({ precise: true, students: 3, online: false });
    await refresh(item.bindings[0]!);
    await refresh(item.bindings[1]!, capabilities.filter(capability => capability !== "preciseRestrictionResourcesV1"));
    await configure(item);
    await start(item);
    const first = await restrictions(item);
    assert.equal(first.flightPath.active, true);
    assert.deepEqual(first.flightPath.allowedDomains, []);
    assert.deepEqual(first.flightPath.resources, item.path.resources);
    assert.equal((await restrictions(item, 1)).flightPath.active, false);
    assert.equal((await restrictions(item, 2)).flightPath.active, false);
    const deliverable = serializeClasspilotStudentControlStateForDelivery({ state: await control(item), gateActive: true,
      acceptedCapabilities: capabilities.filter(capability => capability !== "preciseRestrictionResourcesV1"),
      exactBinding: { schoolId: ids.school, ...item.bindings[0]! } });
    assert.equal(deliverable.classroomState, null, "a later downgrade must not turn one document into a whole-domain allowance");
  });

  test("stopping requires exact class scope, current session staff, and the current automatic revision", async () => {
    const item = await fixture();
    await configure(item);
    await start(item);
    const current = automaticStateSchema.parse((await reload(item)).automaticFlightPathState);
    for (const targetScope of ["students", "subgroup", "context"] as const) {
      await assert.rejects(inSchool(() => dispatcher.executeClasspilotCommand({ schoolId: ids.school, actorId: ids.teacher,
        teachingSessionId: item.session!.id, targetScope, commandType: "remove-flight-path", rawCommandPayload: {}, targets: [],
        stopAutomaticFlightPath: { expectedRevision: current.revision } })), /exact class session/);
    }
    await assert.rejects(turnOff(item, { actorId: ids.outsider }));
    await assert.rejects(turnOff(item, { actorId: ids.observerAdmin }), "Observe-only administrator authority must not become command authority");
    await assert.rejects(issue(item, "remove-flight-path", {}, { stopRevision: current.revision + 1 }));
    assert.equal(focusRecord((await reload(item)).automaticFlightPathState).status, "active");
    assert.equal((await restrictions(item)).flightPath.active, true);
    await turnOff(item, { actorId: ids.coTeacher });
    assert.equal(focusRecord((await reload(item)).automaticFlightPathState).status, "off");
  });

  test("a missing configured path does not block class startup or manufacture an empty allow list", async () => {
    const item = await fixture();
    await configure(item);
    await admin.query("DELETE FROM flight_paths WHERE id=$1", [item.path.id]);
    await start(item);
    assert.equal(focusRecord((await reload(item)).automaticFlightPathState).status, "unavailable");
    assert.equal((await restrictions(item)).flightPath.active, false);
    assert.equal((await reload(item)).endTime, null);
  });

  test("a website-only path may defer to a signed-out student only under the late-sign-in capability gate", async () => {
    const item = await fixture({ students: 1 });
    const binding = item.bindings[0]!;
    await inSchool(() => storage.endStudentSessionExact({ schoolId: ids.school, ...binding }));
    await configure(item);
    await start(item);
    const deferred = await control(item);
    assert.equal((await restrictions(item)).flightPath.active, true);
    const unsupported = serializeClasspilotStudentControlStateForDelivery({ state: deferred, gateActive: true,
      acceptedCapabilities: capabilities.filter(capability => capability !== "lateSignInRestrictionSsoV1"),
      exactBinding: { schoolId: ids.school, ...binding } });
    assert.equal(unsupported.classroomState, null);
    await turnOff(item, { unavailable: true });
    const signedIn = await inSchool(() => storage.startStudentSessionWithReplacements(ids.school, binding.studentId, binding.deviceId,
      { authKind: "manual_shared", sessionRecoveryTokenHash: randomUUID().replaceAll("-", "").repeat(2) }));
    binding.studentSessionId = signedIn.session.id;
    await refresh(binding);
    assert.equal((await restrictions(item)).flightPath.active, false);
    const gated = await fixture({ students: 1 });
    await inSchool(() => storage.endStudentSessionExact({ schoolId: ids.school, ...gated.bindings[0]! }));
    await configure(gated);
    process.env.CLASSPILOT_CAP_LATE_SIGNIN_RESTRICTION_SSO_V1 = "false";
    try {
      await start(gated);
      assert.equal((await restrictions(gated)).flightPath.active, false);
    } finally { process.env.CLASSPILOT_CAP_LATE_SIGNIN_RESTRICTION_SSO_V1 = "true"; }
  });
});
