import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);

test("startup migration and Drizzle schema include all monitoring tenant tables", async () => {
  const [schema, migration, workflow, deploy, registrySource] = await Promise.all([
    readFile(new URL("src/schema/classpilot.ts", root), "utf8"),
    readFile(new URL("src/index.ts", root), "utf8"),
    readFile(new URL(".github/workflows/ci-build.yml", root), "utf8"),
    readFile(new URL("scripts/deploy.sh", root), "utf8"),
    readFile(new URL("src/config/rlsRegistry.json", root), "utf8"),
  ]);
  const tables = [
    "classpilot_monitoring_events",
    "classpilot_session_reports",
    "classpilot_session_staff",
    "classpilot_session_student_reports",
    "classpilot_student_control_states",
  ];
  for (const table of tables) {
    assert.match(schema, new RegExp(`"${table}"`));
    assert.match(migration, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}`));
    assert.match(workflow, new RegExp(table));
  }
  const registry = JSON.parse(registrySource) as {
    reviewedEnablementRequests: { classpilotMonitoringAndReports: string[] };
  };
  assert.deepEqual(
    registry.reviewedEnablementRequests.classpilotMonitoringAndReports,
    tables
  );
  assert.match(deploy, /enforce-deploy-rls-allowlist\.mjs/);
  assert.match(schema, /trackingPolicy: jsonb\("tracking_policy"\)/);
  assert.match(schema, /authorizationMarker: jsonb\("authorization_marker"\)/);
  assert.match(
    migration,
    /ALTER TABLE classpilot_session_reports ADD COLUMN IF NOT EXISTS tracking_policy JSONB/
  );
  assert.match(
    migration,
    /ALTER TABLE classpilot_session_reports ADD COLUMN IF NOT EXISTS authorization_marker JSONB/
  );
  assert.match(migration, /classpilot_set_report_authorization_marker/);
  assert.match(migration, /ALTER COLUMN authorization_marker SET NOT NULL/);
  const staffSnapshotTable = migration.indexOf(
    "CREATE TABLE IF NOT EXISTS classpilot_session_staff"
  );
  const reportAuthorizationFunction = migration.indexOf(
    "CREATE OR REPLACE FUNCTION classpilot_set_report_authorization_marker()"
  );
  assert.ok(staffSnapshotTable >= 0, "staff snapshot table migration must exist");
  assert.ok(reportAuthorizationFunction >= 0, "report authorization function migration must exist");
  assert.ok(
    staffSnapshotTable < reportAuthorizationFunction,
    "staff snapshot table must exist before the report authorization function reads it"
  );
});

test("Student Data app attribution is additive, privacy-safe storage outside immutable report detail", async () => {
  const [schema, migration, storage] = await Promise.all([
    readFile(new URL("src/schema/classpilot.ts", root), "utf8"),
    readFile(new URL("src/index.ts", root), "utf8"),
    readFile(new URL("src/services/storage.ts", root), "utf8"),
  ]);
  assert.match(schema, /topActivities: jsonb\("top_activities"\)/);
  assert.match(
    migration,
    /ALTER TABLE classpilot_session_usage ADD COLUMN IF NOT EXISTS top_activities JSONB/
  );

  const completion = storage.slice(
    storage.indexOf("export async function completeClasspilotSessionReport"),
    storage.indexOf("export async function failClasspilotSessionReport")
  );
  const immutableDetail = completion.slice(
    completion.indexOf("await tx.insert(classpilotSessionStudentReports)"),
    completion.indexOf("const gapEvents")
  );
  const studentDataUsage = completion.slice(
    completion.indexOf(".insert(classpilotSessionUsage)"),
    completion.indexOf("const counts")
  );
  assert.doesNotMatch(immutableDetail, /topActivities/);
  assert.match(studentDataUsage, /topActivities: student\.topActivities/);
});

test("monitoring event scope, idempotency, retention, and privacy constraints are database-enforced", async () => {
  const migration = await readFile(new URL("src/index.ts", root), "utf8");
  assert.match(migration, /num_nonnulls\(teaching_session_id, supervision_context_id\) = 1/);
  assert.match(migration, /cp_monitoring_events_source_unique/);
  assert.match(migration, /cp_monitoring_events_retention_idx/);
  assert.match(migration, /CHECK \(schema_version = 1\)/);
  assert.doesNotMatch(migration, /keystroke|clipboard_content|form_content|dom_content/i);
});

test("report lifecycle has settlement, lease, immutable delivery wait, and expiration states", async () => {
  const [storage, lifecycle] = await Promise.all([
    readFile(new URL("src/services/storage.ts", root), "utf8"),
    readFile(new URL("src/services/classpilotSessionLifecycle.ts", root), "utf8"),
  ]);
  assert.match(storage, /new Date\(now\.getTime\(\) \+ 30_000\)/);
  assert.match(storage, /\.for\("update", \{ skipLocked: true \}\)/);
  assert.match(storage, /state: "waiting_report"/);
  assert.match(storage, /classpilotSessionReportVersionForNewRow\(\)/);
  assert.match(storage, /reportVersion,/);
  assert.match(storage, /reportVersion === 2[\s\S]{0,100}"heartbeat-coverage-v2"[\s\S]{0,100}"heartbeat-coverage-v1"/);
  assert.match(storage, /trackingPolicy:/);
  assert.match(storage, /createClasspilotReportAuthorizationMarker/);
  assert.match(storage, /getHeartbeatsForStudentsInRange\([\s\S]*report\.windowStart,[\s\S]*report\.windowEnd/);
  assert.match(storage, /capturedAt: classpilotSessionStudents\.capturedAt/);
  assert.match(storage, /gt\(classpilotSessionReports\.expiresAt, now\)/);
  const completion = storage.slice(
    storage.indexOf("export async function completeClasspilotSessionReport"),
    storage.indexOf("export async function failClasspilotSessionReport")
  );
  assert.match(completion, /\.for\("update"\)/);
  assert.match(completion, /eq\(classpilotSessionReports\.leaseOwner, options\.leaseOwner\)/);
  assert.match(completion, /gt\(classpilotSessionReports\.leaseExpiresAt, completedAt\)/);
  assert.match(completion, /ClassPilot report lease was lost before commit/);
  assert.match(lifecycle, /Immutable ClassPilot session report is not ready/);
  assert.doesNotMatch(lifecycle, /getHeartbeatsForStudentsInRange/);
  assert.doesNotMatch(lifecycle, /aggregateClasspilotSessionUsage/);
});

test("event ingestion binds identities from auth and scope is transactionally server resolved", async () => {
  const [route, storage, serverEvents] = await Promise.all([
    readFile(new URL("src/routes/classpilot/monitoringEvents.ts", root), "utf8"),
    readFile(new URL("src/services/storage.ts", root), "utf8"),
    readFile(new URL("src/services/classpilotMonitoringEvents.ts", root), "utf8"),
  ]);
  assert.match(route, /router\.post\("\/device\/events", requireDeviceAuth/);
  for (const identity of ["schoolId", "studentId", "deviceId", "studentSessionId"]) {
    assert.match(route, new RegExp(`const ${identity} = res\\.locals\\.${identity}`));
    assert.doesNotMatch(route, new RegExp(`const ${identity} = req\\.body`));
  }
  assert.match(route, /insertClasspilotMonitoringEventForResolvedScope/);
  assert.match(route, /activeStudentSession\?\.id !== studentSessionId/);
  assert.match(route, /sanitized\.occurredAt\.getTime\(\) < authenticatedStartedAt\.getTime\(\) - 5 \* 60_000/);
  assert.match(route, /sanitized\.occurredAt >= authenticatedEndedAt/);
  assert.match(storage, /classpilotSupervisionContexts\.endsAt\}\) > \$\{options\.occurredAt\}/);
  assert.match(storage, /teachingSessions\.scheduledEndAt\}, now\(\)\) > \$\{options\.occurredAt\}/);
  const atomicInsert = storage.slice(
    storage.indexOf("export async function insertClasspilotMonitoringEventForResolvedScope"),
    storage.indexOf("export type ClasspilotMonitoringEventView")
  );
  assert.match(atomicInsert, /dbInstance\.transaction\(async \(tx\)/);
  assert.match(atomicInsert, /lockClasspilotStudentControlAuthorities/);
  assert.match(atomicInsert, /resolveClasspilotMonitoringScope/);
  assert.match(atomicInsert, /insertClasspilotMonitoringEvent/);
  assert.match(serverEvents, /insertClasspilotMonitoringEventForResolvedScope/);
  assert.doesNotMatch(serverEvents, /resolveClasspilotMonitoringScope/);
});

test("batch ingestion does not store events whose tenant retention already elapsed", async () => {
  const route = await readFile(new URL("src/routes/classpilot/monitoringEvents.ts", root), "utf8");
  const retentionGuard = route.indexOf("retentionExpiresAt.getTime() <= now.getTime()");
  const eventInsert = route.indexOf("insertClasspilotMonitoringEventForResolvedScope({", retentionGuard);

  assert.ok(retentionGuard >= 0, "expired monitoring events must have an explicit retention guard");
  assert.ok(eventInsert > retentionGuard, "the retention guard must run before event insertion");
  assert.match(
    route.slice(retentionGuard, eventInsert),
    /status: "not_retained"[\s\S]*continue;/
  );
});

test("retention covers every school, removes report identity, and defaults only legacy orphans to 30 days", async () => {
  const scheduler = await readFile(new URL("src/services/scheduler.ts", root), "utf8");
  const retention = scheduler.slice(
    scheduler.indexOf("async function purgeExpiredHeartbeats"),
    scheduler.indexOf("ClassPilot - Automatic class block scheduling")
  );
  assert.match(retention, /\.from\(schools\)/);
  assert.doesNotMatch(retention, /productLicenses/);
  assert.match(retention, /for \(const school of allSchools\) \{\s+try \{/);
  assert.match(retention, /localDateInTimeZone\(cutoff, "UTC"\)/);
  assert.match(retention, /DELETE FROM classpilot_session_students/);
  assert.match(retention, /DELETE FROM classpilot_session_staff/);
  assert.match(retention, /report\.detail_expired_at IS NULL/);
  assert.match(retention, /classpilot_session_student_reports AS detail/);
  assert.match(retention, /FOR UPDATE OF report SKIP LOCKED/);
  assert.match(retention, /report\.authorization_marker IS NOT NULL/);
  assert.doesNotMatch(retention, /state <> 'expired'/);
  assert.match(retention, /DELETE FROM classpilot_session_usage WHERE school_id = \$1 AND local_date < \$2/);
  assert.match(retention, /DELETE FROM daily_usage WHERE school_id = \$1 AND date < \$2/);
  assert.match(retention, /USING devices AS device/);
  assert.match(retention, /Pre-report delivery rows can exist from an older release/);
  assert.match(retention, /NOT EXISTS \(\s+SELECT 1 FROM classpilot_session_reports AS report/);
  assert.match(retention, /NOT EXISTS[\s\S]+NOW\(\) - INTERVAL '30 days'|NOW\(\) - INTERVAL '30 days'[\s\S]+NOT EXISTS/);
});

test("report reads authorize and load detail under the retention row lock", async () => {
  const [storage, route, scheduler] = await Promise.all([
    readFile(new URL("src/services/storage.ts", root), "utf8"),
    readFile(new URL("src/routes/classpilot/monitoringEvents.ts", root), "utf8"),
    readFile(new URL("src/services/scheduler.ts", root), "utf8"),
  ]);
  const read = storage.slice(
    storage.indexOf("export async function readAuthorizedClasspilotSessionReport"),
    storage.indexOf("export async function isAuthorizedClasspilotSessionStaff")
  );
  assert.match(read, /dbInstance\.transaction\(async \(tx\)/);
  assert.match(read, /\.for\("share"\)/);
  assert.match(read, /classpilotSessionStaff\.staffId/);
  assert.match(read, /isClasspilotReportAuthorizedStaff/);
  assert.match(read, /classpilotSessionStudentReports/);
  assert.match(route, /readAuthorizedClasspilotSessionReport/);
  assert.match(scheduler, /FOR UPDATE OF report SKIP LOCKED/);
});

test("control snapshots and legacy classroom states share one transaction boundary", async () => {
  const storage = await readFile(new URL("src/services/storage.ts", root), "utf8");
  assert.match(storage, /export async function persistClasspilotControlCommandState/);
  assert.match(storage, /dbInstance\.transaction\(async \(tx\)/);
  assert.match(storage, /const acceptedSet = new Set\(acceptedStudentIds\)/);
  assert.match(
    storage,
    /for \(const clear of options\.classroomStateClears \|\| \[\]\) \{[\s\S]*?studentIds: \(clear\.studentIds \|\| \[\]\)\.filter\(\(studentId\) => acceptedSet\.has\(studentId\)\)[\s\S]*?\}, transactionDb\);/
  );
  assert.match(storage, /upsertClasspilotClassroomStates\([\s\S]*transactionDb/);
  assert.match(storage, /replaceClasspilotStudentControlSnapshots\([\s\S]*transactionDb/);
  assert.match(storage, /\.from\(teachingSessions\)[\s\S]*\.for\("update"\)/);
  assert.match(storage, /currentByStudent\.get\(studentId\) \|\| null/);
  assert.match(storage, /activeClassroomStates\.filter\(\(state\) => state\.studentId === studentId\)/);
  assert.match(storage, /12 \* 60 \* 60 \* 1000/);
  assert.match(storage, /clearedControlStates: ClasspilotStudentControlState\[\]/);
});

test("delegated supervision owns a revisioned snapshot and restores class authority on every end path", async () => {
  const [schema, migration, storage, dispatcher, coverage, scheduler, delivery] = await Promise.all([
    readFile(new URL("src/schema/classpilot.ts", root), "utf8"),
    readFile(new URL("src/index.ts", root), "utf8"),
    readFile(new URL("src/services/storage.ts", root), "utf8"),
    readFile(new URL("src/services/classpilotCommandDispatcher.ts", root), "utf8"),
    readFile(new URL("src/routes/classpilot/coverage.ts", root), "utf8"),
    readFile(new URL("src/services/scheduler.ts", root), "utf8"),
    readFile(new URL("src/services/classpilotControlStateDelivery.ts", root), "utf8"),
  ]);
  assert.match(schema, /supervisionContextId: varchar\("supervision_context_id"\)/);
  assert.match(migration, /classpilot_student_control_states ADD COLUMN IF NOT EXISTS supervision_context_id/);
  assert.match(migration, /num_nonnulls\(teaching_session_id, supervision_context_id\) = 1/);
  assert.match(storage, /export async function replaceClasspilotSupervisionControlSnapshots/);
  assert.match(storage, /authorizedActorId[\s\S]*context\.assignedStaffId !== options\.authorizedActorId/);
  assert.match(storage, /finalize:\$\{session\.id\}:restriction-clear:\$\{studentId\}[\s\S]*eventType: "restriction_state_cleared"/);
  assert.match(storage, /export async function initializeClasspilotSupervisionControlStates/);
  assert.match(storage, /export async function restoreClasspilotStudentControlStatesAfterSupervision/);
  assert.match(storage, /export async function releaseExpiredClasspilotSupervisionContexts/);
  assert.match(storage, /export async function extendSupervisionContext[\s\S]*replaceClasspilotSupervisionControlSnapshots/);
  assert.match(storage, /const contextWasExtended[\s\S]*activeContextAssignments[\s\S]*replaceClasspilotSupervisionControlSnapshots/);
  assert.match(storage, /revision: sql`\$\{classpilotStudentControlStates\.revision\} \+ 1`/);
  assert.match(dispatcher, /persistActiveSupervisionState/);
  assert.match(dispatcher, /stateAuthorizedTargets = committedTargets\.filter/);
  assert.match(dispatcher, /supervisionContextId: options\.supervisionContextId/);
  assert.match(coverage, /syncClasspilotControlStatesToActiveDevices/);
  assert.ok(
    (coverage.match(/getClasspilotSessionStudentRoster\(schoolId, session\.id\)/g) || []).length >= 3,
    "active coverage send/return/reroute authorization must use the frozen session roster"
  );
  assert.match(scheduler, /expireClasspilotSupervisionContexts/);
  assert.match(delivery, /type: "classroom-state-sync"/);
  assert.doesNotMatch(delivery, /deviceId["']?\s*:\s*req\./);
});
