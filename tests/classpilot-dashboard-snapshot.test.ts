import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

process.env.NODE_ENV = "test";
process.env.SCHEDULER_ENABLED = "false";
process.env.REDIS_URL = "";
process.env.DATABASE_URL ||= "postgresql://test:test@127.0.0.1:5432/test";

const dashboardModule = await import(
  "../src/services/classpilotDashboardSnapshot.ts"
);
const {
  createClasspilotDashboardSchoolTimezoneCache,
  mapClasspilotDashboardSnapshotRows,
} = dashboardModule;

function rawSnapshotRow(studentId: string) {
  return {
    student_id: studentId,
    mapped_device_id: null,
    session_device_id: null,
    session_last_seen_at: null,
    attendance_status: null,
    pass_id: null,
    pass_destination: null,
    pass_issued_at: null,
    pass_expires_at: null,
    pass_status: null,
    dismissal_id: null,
    dismissal_status: null,
    dismissal_check_in_method: null,
    dismissal_check_in_time: null,
    coverage_id: null,
    coverage_context_type: null,
    coverage_name: null,
    coverage_staff_id: null,
    coverage_staff_display_name: null,
    coverage_ends_at: null,
    class_session_id: null,
    class_group_id: null,
    class_group_name: null,
    class_teacher_id: null,
    class_start_time: null,
  };
}

describe("ClassPilot dashboard relational snapshot", () => {
  it("keeps authorization live and replaces the dashboard fan-out with one bounded snapshot", () => {
    const route = readFileSync(new URL("../src/routes/compat.ts", import.meta.url), "utf8");
    const service = readFileSync(
      new URL("../src/services/classpilotDashboardSnapshot.ts", import.meta.url),
      "utf8"
    );
    const start = route.indexOf('router.get("/students-aggregated"');
    const end = route.indexOf("// Export (ClassPilot)", start);
    const handler = route.slice(start, end);

    assert.ok(start >= 0 && end > start);
    assert.match(handler, /getActiveTeachingSessionForSchool\(userId, schoolId\)/);
    assert.match(handler, /getGroupByIdAndSchool\(activeSession\.groupId, schoolId\)/);
    assert.match(handler, /getClasspilotSessionStudentRoster\(\s*schoolId,\s*activeSession!\.id\s*\)/);
    assert.doesNotMatch(handler, /getGroupStudents\(activeGroup\.id\)/);
    assert.match(handler, /getClasspilotDashboardSnapshot\(schoolId, studentIds, today\)/);
    assert.match(
      handler,
      /Promise\.all\(\[\s*getClasspilotDashboardSnapshot[\s\S]*getClasspilotStudentControlStates/
    );
    assert.doesNotMatch(handler, /getAttendanceBySchool|getActivePassesBySchool/);

    assert.match(service, /CLASSPILOT_DASHBOARD_SNAPSHOT_CHUNK_SIZE\s*=\s*2_500/);
    assert.match(service, /WITH requested\(student_id\) AS \(VALUES/);
    assert.match(service, /INNER JOIN requested ON requested\.student_id = student\.id/);
    assert.match(service, /WHERE student\.school_id = \$\{schoolId\}/);
    assert.match(service, /latest_devices AS MATERIALIZED/);
    assert.match(service, /active_student_sessions AS MATERIALIZED/);
    assert.match(service, /today_attendance AS MATERIALIZED/);
    assert.match(service, /current_coverages AS MATERIALIZED/);
    assert.doesNotMatch(service, /LEFT JOIN LATERAL/);
  });

  it("caches only the school timezone for five seconds and bypasses without healthy Redis invalidation", () => {
    const service = readFileSync(
      new URL("../src/services/classpilotDashboardSnapshot.ts", import.meta.url),
      "utf8"
    );
    const storage = readFileSync(new URL("../src/services/storage.ts", import.meta.url), "utf8");

    assert.match(service, /CLASSPILOT_DASHBOARD_SCHOOL_CACHE_TTL_MS\s*=\s*5_000/);
    assert.match(service, /select\(\{ schoolTimezone: schools\.schoolTimezone \}\)/);
    assert.doesNotMatch(service, /select\(\)\s*\.from\(schools\)/);
    assert.match(service, /!isRedisPublisherReady\(\) \|\| !isRedisBroadcastReady\(\)/);
    assert.match(service, /createClasspilotDashboardSchoolTimezoneCache/);
    assert.match(service, /const loads = new Map/);
    assert.match(service, /const generations = new Map/);
    assert.match(service, /target\.cache === "classpilot-dashboard-school"/);
    assert.match(storage, /dispatchCacheInvalidation\(target\);[\s\S]*?publishCacheInvalidation\(target\)/);
  });

  it("filters a mixed-school result defensively to the live authorized roster", () => {
    const rows = mapClasspilotDashboardSnapshotRows(
      [rawSnapshotRow("student-a"), rawSnapshotRow("foreign-student")],
      ["student-a"]
    );
    assert.deepEqual(rows.map((row) => row.studentId), ["student-a"]);
  });

  it("normalizes every raw snapshot timestamp before exposing the typed row", () => {
    const timestamp = "2026-08-25 13:15:00.123456";
    const expectedTimestamp = "2026-08-25T13:15:00.123Z";
    const [row] = mapClasspilotDashboardSnapshotRows([{
      ...rawSnapshotRow("student-a"),
      student_session_id: "session-a",
      session_device_id: "device-a",
      session_started_at: timestamp,
      session_last_seen_at: timestamp,
      pass_id: "pass-a",
      pass_destination: "Library",
      pass_issued_at: timestamp,
      pass_expires_at: timestamp,
      pass_status: "active",
      dismissal_id: "dismissal-a",
      dismissal_status: "queued",
      dismissal_check_in_time: timestamp,
      coverage_id: "coverage-a",
      coverage_context_type: "temporary",
      coverage_name: "Coverage",
      coverage_staff_id: "staff-a",
      coverage_ends_at: timestamp,
      class_session_id: "class-session-a",
      class_group_id: "group-a",
      class_group_name: "Math",
      class_teacher_id: "teacher-a",
      class_start_time: timestamp,
    }], ["student-a"]);

    assert.ok(row);
    for (const value of [
      row.sessionStartedAt,
      row.sessionLastSeenAt,
      row.activePass?.issuedAt,
      row.activePass?.expiresAt,
      row.dismissal?.checkInTime,
      row.coverage?.endsAt,
      row.activeClass?.startTime,
    ]) {
      assert.ok(value instanceof Date);
      assert.equal(value.toISOString(), expectedTimestamp);
    }
  });

  it("degrades invalid raw timestamps without failing the roster", () => {
    const [row] = mapClasspilotDashboardSnapshotRows([{
      ...rawSnapshotRow("student-a"),
      session_started_at: "0",
      session_last_seen_at: "1700000000000",
      pass_id: "pass-a",
      pass_destination: "Library",
      pass_issued_at: "2026-02-31T13:15:00.000Z",
      pass_expires_at: "not-a-date",
      pass_status: "active",
      dismissal_id: "dismissal-a",
      dismissal_status: "queued",
      dismissal_check_in_time: "2026-13-01T13:15:00.000Z",
      coverage_id: "coverage-a",
      coverage_context_type: "temporary",
      coverage_name: "Coverage",
      coverage_staff_id: "staff-a",
      coverage_ends_at: "2026-08-25",
      class_session_id: "class-session-a",
      class_group_id: "group-a",
      class_group_name: "Math",
      class_teacher_id: "teacher-a",
      class_start_time: "2026-08-25T25:15:00.000Z",
    }], ["student-a"]);

    assert.ok(row);
    assert.equal(row.sessionStartedAt, null);
    assert.equal(row.sessionLastSeenAt, null);
    assert.equal(row.activePass, null);
    assert.equal(row.dismissal?.checkInTime, null);
    assert.equal(row.coverage, null);
    assert.equal(row.activeClass, null);
  });

  it("single-flights timezone loads and does not repopulate after invalidation during load", async () => {
    const pending: Array<(value: string | null) => void> = [];
    let loads = 0;
    const cache = createClasspilotDashboardSchoolTimezoneCache({
      canUse: () => true,
      load: async () => {
        loads += 1;
        return new Promise<string | null>((resolve) => pending.push(resolve));
      },
    });

    const first = cache.get("school-a");
    const shared = cache.get("school-a");
    assert.equal(loads, 1);
    cache.invalidate("school-a");
    pending.shift()!("America/New_York");
    assert.deepEqual(await Promise.all([first, shared]), [
      "America/New_York",
      "America/New_York",
    ]);

    const afterInvalidation = cache.get("school-a");
    assert.equal(loads, 2);
    pending.shift()!("America/Chicago");
    assert.equal(await afterInvalidation, "America/Chicago");
    assert.equal(await cache.get("school-a"), "America/Chicago");
    assert.equal(loads, 2);
  });

  it("bounds timezone cache state and safely bypasses when all load slots are occupied", async () => {
    const pending: Array<(value: string | null) => void> = [];
    let loads = 0;
    const events: string[] = [];
    const cache = createClasspilotDashboardSchoolTimezoneCache({
      maxEntries: 2,
      canUse: () => true,
      onEvent: (event) => events.push(event),
      load: async () => {
        loads += 1;
        return new Promise<string | null>((resolve) => pending.push(resolve));
      },
    });

    const first = cache.get("school-a");
    const second = cache.get("school-b");
    const bypassed = cache.get("school-c");
    assert.equal(loads, 3);
    assert.equal(events.at(-1), "bypass");
    pending[0]!("A");
    pending[1]!("B");
    pending[2]!("C");
    assert.deepEqual(await Promise.all([first, second, bypassed]), ["A", "B", "C"]);
  });

  it("emits only aggregate PII-free dashboard hot-path metrics", () => {
    const service = readFileSync(
      new URL("../src/services/classpilotDashboardSnapshot.ts", import.meta.url),
      "utf8"
    );
    const metricStart = service.indexOf('event: "classpilot_dashboard_hot_path"');
    const metricEnd = service.indexOf("function canUseSchoolCache", metricStart);
    const metricBlock = service.slice(metricStart, metricEnd);

    assert.ok(metricStart >= 0 && metricEnd > metricStart);
    assert.doesNotMatch(metricBlock, /schoolId|studentId|email|deviceId|activeTab/);
  });
});
