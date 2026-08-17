import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { evaluateGoPilotAutoStartClock } from "../src/services/scheduler.js";

const source = (relativePath: string) =>
  readFileSync(new URL(`../${relativePath}`, import.meta.url), "utf8");

describe("GoPilot scheduler clock policy", () => {
  it("uses the school IANA timezone across DST and fails malformed values closed", () => {
    assert.deepEqual(
      evaluateGoPilotAutoStartClock(
        new Date("2026-03-09T19:01:00.000Z"),
        "America/New_York",
        "15:00"
      ),
      { ready: true, localDate: "2026-03-09", localTime: "15:01" }
    );
    assert.deepEqual(
      evaluateGoPilotAutoStartClock(
        new Date("2026-11-02T19:59:00.000Z"),
        "America/New_York",
        "15:00"
      ),
      { ready: false, reason: "before_dismissal_time" }
    );
    assert.deepEqual(
      evaluateGoPilotAutoStartClock(new Date(), "Not/A_Real_Zone", "15:00"),
      { ready: false, reason: "invalid_timezone" }
    );
    assert.deepEqual(
      evaluateGoPilotAutoStartClock(new Date(), "America/New_York", "3 PM"),
      { ready: false, reason: "invalid_dismissal_time" }
    );
  });

  it("rechecks licensing, explicit enablement, and instructional day under the calendar lock", () => {
    const scheduler = source("src/services/scheduler.ts");
    const autoStart = scheduler.slice(
      scheduler.indexOf("async function autoStartDismissal"),
      scheduler.indexOf("async function autoCompleteStaleGoPilotSessions")
    );
    assert.match(autoStart, /withInstructionalCalendarDateLock/);
    assert.match(autoStart, /eq\(schools\.gopilotAutoStartEnabled, true\)/);
    assert.match(autoStart, /eq\(productLicenses\.product, "GOPILOT"\)/);
    assert.match(autoStart, /gt\(productLicenses\.expiresAt, sql`NOW\(\)`\)/);
    assert.match(autoStart, /getInstructionalDateStatus\([\s\S]*?schoolId,[\s\S]*?currentClock\.localDate,[\s\S]*?transactionDb/);
    assert.match(autoStart, /\.for\("update", \{ of: schools \}\)/);
    assert.match(autoStart, /evaluateGoPilotAutoStartClock/);
  });

  it("never derives scheduled parent digest recipients from historical GoPilot links", () => {
    const scheduler = source("src/services/scheduler.ts");
    assert.doesNotMatch(scheduler, /sendParentTransparencyDigests/);
    assert.doesNotMatch(scheduler, /parentStudent/);
    assert.doesNotMatch(scheduler, /parent_student/);
  });
});

describe("GoPilot dismissal concurrency and data contracts", () => {
  it("serializes all intake paths and prevents duplicate queue rows", () => {
    const storage = source("src/services/storage.ts");
    const staffArrival = storage.slice(
      storage.indexOf("export async function createStaffDismissalArrivals"),
      storage.indexOf("function studentNameForStorage")
    );
    const operational = storage.slice(
      storage.indexOf("export async function createStaffOperationalQueueEntries"),
      storage.indexOf("export class GoPilotArrivalError")
    );
    for (const block of [staffArrival, operational]) {
      assert.match(block, /\.for\("update"\)/);
      assert.match(block, /onConflictDoNothing/);
      assert.match(block, /dismissalQueue\.sessionId, dismissalQueue\.studentId/);
    }
  });

  it("uses skip-locked atomic batches and monotonic queue state predicates", () => {
    const storage = source("src/services/storage.ts");
    const queueOps = storage.slice(
      storage.indexOf("export async function callQueueEntry"),
      storage.indexOf("export async function getSessionStats")
    );
    assert.match(
      queueOps,
      /\.for\("update", \{[^}]*skipLocked: true[^}]*\}\)/
    );
    assert.match(queueOps, /withActiveDismissalSessionQueueMutation/);
    const sessionGuard = storage.slice(
      storage.indexOf("async function withActiveDismissalSessionQueueMutation"),
      storage.indexOf("export async function callQueueEntry")
    );
    assert.match(sessionGuard, /eq\(dismissalSessions\.schoolId, schoolId\)/);
    assert.match(sessionGuard, /\.for\("update"\)/);
    assert.match(sessionGuard, /session\.status !== "active"/);
    assert.match(queueOps, /eq\(dismissalQueue\.status, "called"\)/);
    assert.match(queueOps, /eq\(dismissalQueue\.status, "released"\)/);
    assert.match(queueOps, /delayedUntil} <= NOW\(\)/);
    assert.doesNotMatch(
      queueOps.slice(queueOps.indexOf("export async function holdQueueEntry")),
      /\.where\(eq\(dismissalQueue\.id, id\)\)/
    );
  });

  it("serializes custody checks with pickup completion and alert creation", () => {
    const storage = source("src/services/storage.ts");
    const queueOps = storage.slice(
      storage.indexOf("export async function dismissQueueEntry"),
      storage.indexOf("export async function batchRelease")
    );
    const custodyCreate = storage.slice(
      storage.indexOf("export async function createCustodyAlert"),
      storage.indexOf("// ============================================================================\n// GoPilot - Bus Routes")
    );
    assert.match(queueOps, /gopilot:custody:/);
    assert.match(queueOps, /eq\(custodyAlerts\.active, true\)/);
    assert.match(queueOps, /custodyAcknowledged/);
    assert.match(custodyCreate, /gopilot:custody:/);
    assert.match(custodyCreate, /db\.transaction/);
  });

  it("exposes only the narrow role-scoped GoPilot student and queue DTOs", () => {
    const studentRoute = source("src/routes/gopilot/students.ts");
    const dismissalRoute = source("src/routes/gopilot/dismissal.ts");
    assert.match(studentRoute, /getTeacherHomeroomIds/);
    assert.match(studentRoute, /requireGoPilotRole\("admin", "school_admin", "office_staff", "teacher"\)/);
    assert.match(dismissalRoute, /function serializeStaffQueueEntry/);
    assert.match(studentRoute, /router\.post\("\/"/);
    assert.match(studentRoute, /router\.patch\("\/bulk"/);
    assert.match(studentRoute, /router\.delete\("\/:studentId"/);
    assert.doesNotMatch(
      dismissalRoute.slice(
        dismissalRoute.indexOf("function serializeStaffQueueEntry"),
        dismissalRoute.indexOf("type WalkerFilter")
      ),
      /guardianId/
    );
  });

  it("serializes change review and override queue cleanup", () => {
    const overrides = source("src/services/gopilotOverrides.ts");
    assert.match(overrides, /gopilot:change:/);
    assert.match(overrides, /eq\(dismissalChanges\.status, "pending"\)/);
    assert.match(overrides, /eq\(dismissalQueue\.status, "waiting"\)/);
    assert.match(overrides, /\.for\("update"\)/);
    assert.match(overrides, /GOPILOT_CHANGE_ALREADY_RESOLVED/);
    const revert = overrides.slice(
      overrides.indexOf("export async function revertSessionDismissalOverride"),
      overrides.indexOf("export async function reviewDismissalChangeRequest")
    );
    assert.match(revert, /\.for\("update"\)/);
    assert.match(revert, /queued students can only be reverted/i);
    assert.match(revert, /eq\(dismissalQueue\.status, "waiting"\)/);
    assert.match(revert, /dismissal\.override_reverted/);
  });

  it("exposes GoPilot instructional calendar without a ClassPilot license", () => {
    const calendar = source("src/routes/gopilot/instructionalCalendar.ts");
    assert.match(calendar, /requireProductLicense\("GOPILOT"\)/);
    assert.match(calendar, /requireGoPilotRole\("admin", "school_admin"\)/);
    assert.doesNotMatch(calendar, /requireProductLicense\("CLASSPILOT"\)/);
  });

  it("keeps GoPilot attendance scoping opt-in and homeroom-scopes teachers", () => {
    const attendance = source("src/routes/admin/attendance.ts");
    const scope = attendance.slice(
      attendance.indexOf("async function getAttendanceScope"),
      attendance.indexOf("function studentInAttendanceScope")
    );
    assert.ok(
      scope.indexOf("!isGoPilotAttendanceContext(req)") <
        scope.indexOf("getRequestGoPilotRole(req, res)")
    );
    assert.match(scope, /role === "teacher"/);
    assert.match(scope, /getTeacherHomeroomIds/);
    assert.match(scope, /kind: "homerooms"/);
  });

  it("keeps session creation and arrival intake manager-only", () => {
    const dismissal = source("src/routes/gopilot/dismissal.ts");
    assert.match(dismissal, /router\.post\("\/sessions", \.\.\.managerAuth/);
    assert.match(dismissal, /arrival-candidates", \.\.\.managerAuth/);
    assert.match(dismissal, /\/arrivals", \.\.\.managerAuth/);
    assert.match(dismissal, /\/sessions\/:id\/activity", \.\.\.managerAuth/);
  });

  it("installs fail-closed status constraints and effective-role staff checks", () => {
    const schema = source("src/schema/gopilot.ts");
    const startup = source("src/index.ts");
    assert.match(schema, /dismissal_sessions_status_check/);
    assert.match(schema, /dismissal_queue_status_check/);
    assert.match(startup, /GoPilot state integrity migration blocked/);
    assert.match(
      startup,
      /COALESCE\(NULLIF\(membership\.gopilot_role, ''\), membership\.role\)[\s\S]*?IN \('admin', 'school_admin', 'office_staff'\)/
    );
    assert.match(startup, /GoPilot homeroom assignment inventory/);
  });

  it("creates optional legacy child tables before tenant hardening touches them", () => {
    const startup = source("src/index.ts");
    const roleColumn = startup.indexOf("ALTER TABLE school_memberships ADD COLUMN IF NOT EXISTS gopilot_role");
    const firstRoleReference = startup.indexOf("membership.gopilot_role");
    assert.ok(
      roleColumn >= 0 && firstRoleReference >= 0 && roleColumn < firstRoleReference,
      "legacy role override column must exist before containment SQL references it"
    );
    for (const table of ["homeroom_teachers", "dismissal_overrides"]) {
      const create = startup.indexOf(`CREATE TABLE IF NOT EXISTS ${table}`);
      const alter = startup.indexOf(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS school_id`);
      assert.ok(create >= 0, `expected a ${table} fallback CREATE`);
      assert.ok(alter > create, `expected ${table} to exist before tenant hardening`);
    }
    assert.match(startup, /gopilot_valid_pickup_zones/);
    assert.match(startup, /WHERE NOT public\.gopilot_valid_pickup_zones\(gopilot_pickup_zones\)/);
    assert.match(startup, /CHECK \(public\.gopilot_valid_pickup_zones\(gopilot_pickup_zones\)\)/);
  });
});

describe("GoPilot realtime containment", () => {
  it("denies parent effective roles before license/resource checks and contains Redis subscription failure", () => {
    const socket = source("src/realtime/socketio.ts");
    const redis = source("src/realtime/socketio-redis.ts");
    const join = socket.slice(
      socket.indexOf('socket.on("join:school"'),
      socket.indexOf('socket.on("disconnect"')
    );
    assert.ok(join.indexOf('role === "parent"') < join.indexOf("hasActiveGoPilotLicense"));
    assert.match(socket, /GOPILOT_PARENT_PORTAL_DISABLED/);
    assert.match(redis, /subscriber\.subscribe/);
    assert.match(redis, /await disposeClients\(\)/);
    assert.match(redis, /withTimeout\(ensureReady\(\), CONNECT_TIMEOUT_MS/);
    assert.doesNotMatch(redis, /console\.warn\([^\n]*, error\)/);
    const scheduler = source("src/services/scheduler.ts");
    const autoStart = scheduler.slice(
      scheduler.indexOf("async function autoStartDismissal"),
      scheduler.indexOf("async function autoCompleteStaleGoPilotSessions")
    );
    assert.equal(
      [...autoStart.matchAll(/publishGoPilotEvent\(`school:\$\{schoolId\}`, "dismissal:started"/g)].length,
      1
    );
    assert.doesNotMatch(autoStart, /school:\$\{schoolId\}:office`, "dismissal:started"/);
  });
});
