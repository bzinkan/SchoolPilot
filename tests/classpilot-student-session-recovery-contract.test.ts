import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

function source(path: string): string {
  return readFileSync(new URL(path, import.meta.url), "utf8").replace(/\r\n/g, "\n");
}

test("manual student sessions use database-time leases and exact recovery capabilities", () => {
  const schema = source("../src/schema/classpilot.ts");
  const migrations = source("../src/db/migrations27.ts");
  const storage = source("../src/services/storage.ts");
  const authority = source("../src/services/classpilotStudentSessionAuthority.ts");
  const routes = source("../src/routes/classpilot/devices.ts");

  assert.match(schema, /authKind: text\("auth_kind"\).*default\("legacy"\)/);
  assert.match(schema, /manualLeaseExpiresAt: timestamp\("manual_lease_expires_at"/);
  assert.match(schema, /sessionRecoveryTokenHash: varchar\("session_recovery_token_hash"/);
  assert.match(schema, /student_sessions_recovery_token_hash_check/);
  assert.match(migrations, /20260827_classpilot_student_session_recovery_expand/);
  assert.match(migrations, /session_recovery_token_hash ~ '\^\[0-9a-f\]\{64\}\$'/);
  assert.match(storage, /now\(\) \+ interval '300 seconds'/);
  assert.match(storage, /session\.deviceId === deviceId/);
  assert.match(storage, /session\.sessionRecoveryTokenHash === options\.reclaimRecoveryTokenHash/);
  assert.match(storage, /authoritative && session\.id !== recoveredSession\?\.session\.id/);
  assert.match(storage, /recoveredSession\.session\.studentId !== studentId/);
  assert.match(storage, /code: "STUDENT_SESSION_ACTIVE"/);
  assert.match(storage, /endStudentSessionExact[\s\S]*studentSessionId[\s\S]*deviceId/);
  const issuance = source("../src/services/classpilotStudentAuth.ts");
  assert.doesNotMatch(issuance, /linkStudentDevice/);
  const issueStart = issuance.indexOf("export async function issueStudentDeviceSessionToken");
  const issueEnd = issuance.indexOf("export async function finalizeStudentDeviceSessionIssuance", issueStart);
  const issue = issuance.slice(issueStart, issueEnd);
  assert.match(issue, /const sessionId = crypto\.randomUUID\(\)/);
  assert.ok(
    issue.indexOf("signStudentToken ?? createStudentToken")
      < issue.indexOf("ensureClassPilotDeviceForSchool"),
    "JWT signing must precede even device creation"
  );
  assert.ok(
    issue.indexOf("signStudentToken ?? createStudentToken")
      < issue.indexOf("startStudentSessionWithReplacements"),
    "JWT signing must precede the canonical replacement transaction"
  );
  const sessionStart = storage.slice(
    storage.indexOf("export async function startStudentSessionWithReplacements"),
    storage.indexOf("export async function endStudentSessionExact(")
  );
  assert.match(authority, /CLASSPILOT_MANUAL_SHARED_ISSUANCE_DEFAULT = true/);
  assert.ok(
    sessionStart.indexOf("assertClasspilotManualSharedSessionIssuanceEnabled()")
      < sessionStart.indexOf("db.transaction"),
    "the canonical writer must fail dark before any durable transaction"
  );
  assert.match(sessionStart, /Invalid preallocated student session id/);
  assert.match(sessionStart, /\.values\(\{[\s\S]*options\.sessionId[\s\S]*id: options\.sessionId/);
  const manualLogin = routes.slice(
    routes.indexOf('router.post("/extension/student-login"'),
    routes.indexOf('router.post(\n  "/extension/session-release"')
  );
  assert.match(manualLogin, /status\(503\)[\s\S]*CLASSPILOT_MANUAL_SESSION_ISSUANCE_UNAVAILABLE/);
  assert.ok(
    manualLogin.indexOf("classpilotManualSharedSessionIssuanceEnabled()")
      < manualLogin.indexOf("const recoveryToken"),
    "the public manual-login route must fail dark before credential or DB work"
  );
  assert.match(
    sessionStart,
    /takePasspilotClassLock\(tx, schoolId\)[\s\S]*assertClasspilotEntitled\(schoolId, transactionDb, \{ lock: true \}\)/
  );
  assert.ok(
    sessionStart.indexOf("assertClasspilotEntitled(schoolId, transactionDb, { lock: true })")
      < sessionStart.indexOf(".insert(studentSessions)"),
    "locked entitlement must be checked before credential-bearing session issuance"
  );
  assert.ok(
    sessionStart.indexOf('code: "STUDENT_SESSION_ACTIVE"')
      < sessionStart.indexOf(".insert(studentDevices)"),
    "student/device association must follow the authoritative conflict guard"
  );
  assert.doesNotMatch(
    sessionStart,
    /session\.studentId === studentId[\s\S]{0,200}sessionRecoveryTokenHash/,
    "same-device recovery must not be limited to resuming the previous student"
  );
  assert.match(routes, /manualSessionCrossStudentHandoff/);
  assert.doesNotMatch(storage, /export async function startStudentSession\(/);
});

test("heartbeat authority expires atomically and renews only an accepted manual session", () => {
  const storage = source("../src/services/storage.ts");
  const routes = source("../src/routes/classpilot/devices.ts");
  const heartbeat = storage.slice(
    storage.indexOf("export async function createHeartbeatAndRefreshPresence"),
    storage.indexOf("export async function updateHeartbeatClassification")
  );
  assert.ok(
    heartbeat.indexOf("WITH locked_device AS MATERIALIZED")
      < heartbeat.indexOf("represented_session AS MATERIALIZED"),
    "heartbeat authority must lock the device before the represented session"
  );
  assert.match(heartbeat, /locked_device[\s\S]*FOR UPDATE/);
  assert.match(heartbeat, /auth_kind <> 'manual_shared'[\s\S]*manual_lease_expires_at > now\(\)/);
  assert.match(heartbeat, /WHEN auth_kind = 'manual_shared' THEN now\(\) \+ interval '300 seconds'/);
  assert.match(heartbeat, /FOR UPDATE OF represented/);
  const route = routes.slice(
    routes.indexOf('router.post("/device/heartbeat"'),
    routes.indexOf('router.get("/device/screenshot/:deviceId"')
  );
  const heartbeatDbResult = route.indexOf("const heartbeatDbResult = await");
  const recordedBindingCacheWrite = route.indexOf(
    "setBoundedMap(deviceLastHeartbeat",
    heartbeatDbResult
  );
  assert.ok(
    heartbeatDbResult !== -1 && heartbeatDbResult < recordedBindingCacheWrite,
    "only a database-accepted heartbeat may populate the short-circuit cache"
  );
  assert.match(route, /authorityExpiresAtMs: heartbeat\.authorityExpiresAt\?\.getTime\(\) \?\? null/);
  assert.match(route, /refreshExactSessionAuthority/);
  assert.match(
    route,
    /canShortCircuitAcceptedHeartbeat[\s\S]*?refreshExactSessionAuthority\(\)[\s\S]*?res\.status\(204\)\.send\(\)/
  );
  assert.match(
    route,
    /afterMode === "off"[\s\S]*?refreshStudentSessionAuthorityWithoutTelemetry[\s\S]*?outside_tracking_window/
  );
});

test("recovery release and legacy sign-out are exact, generic, and do not enumerate bindings", () => {
  const routes = source("../src/routes/classpilot/devices.ts");
  const releaseStart = routes.search(/router\.post\(\r?\n  "\/extension\/session-release"/);
  const signOutStart = routes.indexOf('router.post("/extension/sign-out"');
  const signOutEnd = routes.indexOf("// POST /api/classpilot/register", signOutStart);
  assert.notEqual(releaseStart, -1);
  assert.notEqual(signOutStart, -1);
  const release = routes.slice(releaseStart, signOutStart);
  const signOut = routes.slice(signOutStart, signOutEnd);
  assert.match(release, /SESSION_RELEASE_INVALID/);
  assert.match(release, /SESSION_RELEASE_UNAVAILABLE/);
  assert.match(release, /res\.status\(204\)\.end\(\)/);
  assert.match(signOut, /requireCryptographicDeviceAuth/);
  assert.match(signOut, /endStudentSessionExact/);
  assert.doesNotMatch(signOut, /getActiveStudentForDevice/);
  assert.match(signOut, /durable exact cleanup remains a successful no-op contract/);
});

test("manual roster authority uses the database lease without an app-clock freshness override", () => {
  const routes = source("../src/routes/classpilot/devices.ts");
  const storage = source("../src/services/storage.ts");
  const start = routes.indexOf('router.get("/extension/login-roster"');
  const end = routes.indexOf('router.get("/extension/settings"', start);
  const roster = routes.slice(start, end);
  assert.match(roster, /getStudentIdsHiddenFromClasspilotLoginRoster/);
  assert.match(roster, /studentId !== reclaimableSession\?\.studentId/);
  const hidden = storage.slice(
    storage.indexOf("export async function getStudentIdsHiddenFromClasspilotLoginRoster"),
    storage.indexOf("// ============================================================================\n// ClassPilot - Teaching Session operations")
  );
  assert.match(hidden, /manualLeaseExpiresAt} > now\(\)/);
  assert.match(hidden, /authKind, "managed_profile"/);
  assert.match(hidden, /authKind, "legacy"/);
  assert.doesNotMatch(hidden, /lastSeenAt} > now\(\) - interval '300 seconds'/);
});

test("the worker reaps expired leases in bounded locked batches", () => {
  const lifecycle = source("../src/services/classpilotStudentSessionLifecycle.ts");
  const scheduler = source("../src/services/scheduler.ts");
  assert.match(lifecycle, /FOR UPDATE OF session SKIP LOCKED/);
  assert.match(lifecycle, /session\.manual_lease_expires_at <= now\(\)/);
  assert.match(lifecycle, /session_recovery_token_hash = NULL/);
  assert.match(lifecycle, /publicationConcurrency/);
  assert.match(lifecycle, /dbInstance: schedulerDb/);
  assert.match(scheduler, /expireClasspilotManualStudentSessions/);
  assert.match(scheduler, /ManualStudentSessionExpiryBacklog/);
});

test("dashboard and authorization projections exclude expired manual sessions", () => {
  const snapshot = source("../src/services/classpilotDashboardSnapshot.ts");
  const authority = source("../src/services/classpilotStudentSessionAuthority.ts");
  const auth = source("../src/services/classpilotStudentAuth.ts");
  assert.match(snapshot, /session\.auth_kind <> 'manual_shared'[\s\S]*session\.manual_lease_expires_at > now\(\)/);
  assert.match(authority, /manualLeaseExpiresAt} > now\(\)/);
  assert.match(auth, /currentStudentSessionAuthorityPredicate\(\)/);
});

test("staff session responses never serialize recovery capability fields", () => {
  const monitoring = source("../src/routes/classpilot/monitoring.ts");
  const start = monitoring.indexOf('router.get("/sessions/active/:deviceId"');
  const end = monitoring.indexOf('router.get("/sessions/all"', start);
  const activeSessionRoute = monitoring.slice(start, end);
  assert.doesNotMatch(activeSessionRoute, /session: session \|\| null/);
  assert.doesNotMatch(
    activeSessionRoute,
    /sessionRecoveryTokenHash|manualLeaseExpiresAt|authKind/
  );
  assert.match(activeSessionRoute, /isActive: session\.isActive/);
});

test("device removal atomically ends every exact session and publishes returned tombstones", () => {
  const storage = source("../src/services/storage.ts");
  const routes = source("../src/routes/classpilot/devices.ts");
  const lifecycle = source("../src/services/classpilotStudentSessionLifecycle.ts");
  const deletion = storage.slice(
    storage.indexOf("export async function deleteDeviceWithEndedSessions"),
    storage.indexOf("export async function deleteDevice(deviceId")
  );
  assert.match(deletion, /\.update\(studentSessions\)[\s\S]*sessionRecoveryTokenHash: null/);
  assert.match(deletion, /\.delete\(devices\)/);
  assert.match(deletion, /endedSessions/);
  const route = routes.slice(
    routes.indexOf('router.delete("/devices/:deviceId"'),
    routes.indexOf('router.get("/heartbeats"')
  );
  assert.match(route, /removeClasspilotDeviceAndPublishSessionEnds/);
  assert.match(lifecycle, /deleteDeviceWithEndedSessions/);
  assert.match(lifecycle, /reason: "device_removed"/);
  assert.match(lifecycle, /Promise\.allSettled/);
});

test("legacy active-student mutation cannot switch authenticated students", () => {
  const routes = source("../src/routes/classpilot/devices.ts");
  const start = routes.indexOf('router.post("/device/:deviceId/active-student"');
  const end = routes.indexOf("// POST /api/classpilot/extension/runtime-error", start);
  const route = routes.slice(start, end);
  assert.match(route, /studentId !== res\.locals\.studentId/);
  assert.match(route, /STUDENT_LOGIN_REQUIRED/);
  assert.doesNotMatch(route, /setActiveStudentForDevice/);
});

test("staff bulk sign-out completes durable ends despite per-row publication failure", () => {
  const dispatcher = source("../src/services/classpilotCommandDispatcher.ts");
  const start = dispatcher.indexOf("async function endStudentSessionsForSignOut");
  const end = dispatcher.indexOf("async function persistActiveState", start);
  const signOut = dispatcher.slice(start, end);
  assert.match(signOut, /endStudentSessionExact/);
  assert.match(signOut, /publicationFailures \+= 1/);
  assert.ok(
    signOut.indexOf("completedStudentIds.add")
      < signOut.indexOf("await publishClasspilotStudentSessionEnded"),
    "the durable transition must be marked complete before optional publication"
  );
  assert.match(signOut, /markClasspilotCommandTargetsServerCompleted/);
  assert.doesNotMatch(signOut, /studentId:.*console|deviceId:.*console/);
});

test("startup duplicate-session cleanup preserves current authority before freshness", () => {
  const index = source("../src/index.ts");
  const start = index.indexOf("WITH ranked AS (", index.indexOf("duplicate identities together"));
  const end = index.indexOf("// Reassign student_sessions", start);
  const duplicateSessionCleanup = index.slice(start, end);
  const authorityRank = duplicateSessionCleanup.indexOf("session.auth_kind IN ('legacy', 'managed_profile')");
  const manualLeaseRank = duplicateSessionCleanup.indexOf("session.manual_lease_expires_at > now()");
  const freshnessRank = duplicateSessionCleanup.indexOf("session.last_seen_at DESC");
  assert.match(duplicateSessionCleanup, /session\.ended_at IS NULL/);
  assert.ok(authorityRank >= 0, "legacy and managed sessions must rank as authoritative");
  assert.ok(manualLeaseRank >= 0, "only an unexpired manual lease may rank as authoritative");
  assert.ok(
    authorityRank < freshnessRank && manualLeaseRank < freshnessRank,
    "current authority must be ranked before heartbeat freshness"
  );
  assert.match(duplicateSessionCleanup, /WHERE session\.is_active = true/);
  assert.match(duplicateSessionCleanup, /SET is_active = false/);
  assert.match(duplicateSessionCleanup, /session_recovery_token_hash = NULL/);
});

test("post-commit login failure compensates only the exact issued session", () => {
  const auth = source("../src/services/classpilotStudentAuth.ts");
  const routes = source("../src/routes/classpilot/devices.ts");
  const compensation = auth.slice(
    auth.indexOf("export async function finalizeStudentDeviceSessionIssuance"),
    auth.indexOf("async function lookupActiveStudentTokenSession")
  );
  assert.match(compensation, /endStudentSessionExact/);
  assert.match(compensation, /issuedSession\.studentId/);
  assert.match(compensation, /issuedSession\.deviceId/);
  assert.match(compensation, /issuedSession\.id/);
  assert.match(compensation, /throw error/);
  const login = routes.slice(
    routes.indexOf("async function completeStudentDeviceLogin"),
    routes.indexOf("async function recordRemoteActionTimeline")
  );
  assert.match(login, /finalizeStudentDeviceSessionIssuance/);
  assert.match(login, /onCompensated/);
  assert.match(login, /reason: "login_completion_failed"/);
});

test("the reaper publishes every committed batch before loading the next", () => {
  const lifecycle = source("../src/services/classpilotStudentSessionLifecycle.ts");
  const start = lifecycle.indexOf("export async function reapExpiredManualStudentSessions");
  const reaper = lifecycle.slice(start);
  const loop = reaper.indexOf("for (let batch = 0;");
  const query = reaper.indexOf("schedulerPool.query", loop);
  const publish = reaper.indexOf("publishEndedSession(row)", query);
  const loopExit = reaper.indexOf("if (result.rows.length < batchSize) break", publish);
  assert.ok(loop !== -1 && query < publish && publish < loopExit);
  assert.match(reaper, /await options\.beforeBatch\?\.\(batch\)/);
});
