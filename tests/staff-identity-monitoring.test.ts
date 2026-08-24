import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  ErrorMonitor,
  type DeliveryResult,
  type MonitorAggregationAdapter,
  type MonitorAggregationStatus,
  type NormalizedMonitorEvent,
} from "../dist/services/errorMonitor.js";
import {
  DEFAULT_STAFF_IDENTITY_INTEGRITY_SCAN_INTERVAL_MINUTES,
  getStaffIdentityIntegrityScanIntervalMinutes,
  runStaffIdentityIntegrityScan,
  type StaffIdentityOperationalMonitor,
} from "../dist/services/staffIdentityMonitoring.js";
import {
  resolveStaffLifecycleGuardCode,
} from "../dist/services/staffLifecycleGuardSignal.js";

type ScanAlert = {
  category: Parameters<StaffIdentityOperationalMonitor["trackError"]>[0];
  message: string;
  context?: Record<string, unknown>;
  options?: Parameters<StaffIdentityOperationalMonitor["trackError"]>[3];
};

function scanMonitor(alerts: ScanAlert[]): StaffIdentityOperationalMonitor {
  return {
    trackError(category, error, context, options) {
      alerts.push({
        category,
        message: error instanceof Error ? error.message : String(error),
        context,
        options,
      });
    },
  };
}

function integrityResult(
  total: number,
  overrides: Partial<{
    invalidPrimaryAssignments: number;
    invalidCoTeacherAssignments: number;
    invalidClassRelationships: number;
    primaryMirrorMismatches: number;
    invalidLiveAssignments: number;
    invalidLiveBlockers: number;
    homeroomPrimaryMirrorMismatches: number;
    invalidHomeroomRelationships: number;
    invalidTenantScopes: number;
  }> = {}
) {
  return {
    total,
    counts: {
      invalidPrimaryAssignments: 0,
      invalidCoTeacherAssignments: 0,
      invalidClassRelationships: 0,
      primaryMirrorMismatches: 0,
      invalidLiveAssignments: 0,
      invalidLiveBlockers: 0,
      homeroomPrimaryMirrorMismatches: 0,
      invalidHomeroomRelationships: 0,
      invalidTenantScopes: 0,
      ...overrides,
    },
  };
}

class LocalOnlyAggregation implements MonitorAggregationAdapter {
  async recordEvent(
    _event: NormalizedMonitorEvent,
    _bucketMs: number,
    _windowMs: number
  ): Promise<null> {
    return null;
  }

  async tryAcquireAlert(
    _fingerprint: string,
    _ttlMs: number
  ): Promise<null> {
    return null;
  }

  async setCooldown(_fingerprint: string, _ttlMs: number): Promise<void> {}

  getStatus(): MonitorAggregationStatus {
    return { mode: "local", ok: true };
  }

  async checkStatus(): Promise<MonitorAggregationStatus> {
    return this.getStatus();
  }
}

describe("staff identity aggregate monitoring", () => {
  it("emits a zero aggregate without an operational alert", async () => {
    const privateSchoolId = "school-private-zero";
    const logs: string[] = [];
    const alerts: ScanAlert[] = [];

    const summary = await runStaffIdentityIntegrityScan({
      listSchoolIds: async () => [privateSchoolId],
      countNormalizedEmailCollisionGroups: async () => 0,
      inspectUnscoped: async () => ({ total: 0 }),
      inspectSchool: async () => integrityResult(0),
      monitor: scanMonitor(alerts),
      log: (line) => logs.push(line),
      now: () => 123_456,
      environment: "test",
      service: "scheduler-worker",
    });

    assert.equal(summary.status, "completed");
    assert.equal(summary.schoolsScanned, 1);
    assert.equal(summary.totalIssues, 0);
    assert.equal(alerts.length, 0);
    assert.equal(logs.length, 1);
    assert.doesNotMatch(logs[0] ?? "", new RegExp(privateSchoolId));
    const payload = JSON.parse(logs[0] ?? "{}");
    assert.equal(payload._aws.CloudWatchMetrics[0].Namespace, "SchoolPilot/StaffIdentity");
    assert.equal(payload.SchoolsWithIssues, 0);
    assert.equal(payload.NormalizedEmailCollisionGroups, 0);
    assert.equal(payload.TotalIntegrityIssues, 0);
  });

  it("alerts on a nonzero result with aggregate counts and no PII or tenant IDs", async () => {
    const privateSchoolIds = ["school-private-a", "school-private-b"];
    const forbidden = [
      ...privateSchoolIds,
      "user-private-1",
      "membership-private-1",
      "kenzie.vatter@example.edu",
    ];
    const logs: string[] = [];
    const alerts: ScanAlert[] = [];
    let cursor = 0;

    const summary = await runStaffIdentityIntegrityScan({
      listSchoolIds: async () => privateSchoolIds,
      countNormalizedEmailCollisionGroups: async () => 2,
      inspectUnscoped: async () => ({ total: 2 }),
      inspectSchool: async () => {
        cursor += 1;
        return cursor === 1
          ? integrityResult(3, {
              invalidPrimaryAssignments: 1,
              invalidLiveAssignments: 1,
              invalidTenantScopes: 1,
            })
          : integrityResult(0);
      },
      monitor: scanMonitor(alerts),
      log: (line) => logs.push(line),
      now: () => 789_000,
      environment: "test",
      service: "scheduler-worker",
    });

    assert.equal(summary.schoolsScanned, 2);
    assert.equal(summary.schoolsWithIssues, 1);
    assert.equal(summary.totalIssues, 5);
    assert.equal(summary.unscopedIssues, 2);
    assert.equal(summary.normalizedEmailCollisionGroups, 2);
    assert.equal(alerts.length, 1);
    assert.equal(alerts[0]?.category, "staff_identity_integrity");
    assert.equal(alerts[0]?.options?.persist, false);
    assert.match(alerts[0]?.message ?? "", /schoolsWithIssues=1/);
    assert.match(alerts[0]?.message ?? "", /totalIssues=5/);
    assert.match(alerts[0]?.message ?? "", /unscopedIssues=2/);
    assert.match(
      alerts[0]?.message ?? "",
      /normalizedEmailCollisionGroups=2/
    );

    const emitted = `${logs.join("\n")}\n${JSON.stringify(alerts)}`;
    for (const value of forbidden) {
      assert.doesNotMatch(emitted, new RegExp(value.replaceAll(".", "\\.")));
    }
  });

  it("alerts when normalized-email collisions are the only stage-five blocker", async () => {
    const logs: string[] = [];
    const alerts: ScanAlert[] = [];
    const summary = await runStaffIdentityIntegrityScan({
      listSchoolIds: async () => ["inactive-but-not-deleted-school"],
      countNormalizedEmailCollisionGroups: async () => 1,
      inspectUnscoped: async () => ({ total: 0 }),
      inspectSchool: async () => integrityResult(0),
      monitor: scanMonitor(alerts),
      log: (line) => logs.push(line),
      environment: "test",
      service: "scheduler-worker",
    });

    assert.equal(summary.schoolsInScope, 1);
    assert.equal(summary.totalIssues, 0);
    assert.equal(summary.normalizedEmailCollisionGroups, 1);
    assert.equal(alerts.length, 1);
    assert.equal(alerts[0]?.category, "staff_identity_integrity");
    assert.match(
      alerts[0]?.message ?? "",
      /normalizedEmailCollisionGroups=1/
    );
    const payload = JSON.parse(logs[0] ?? "{}");
    assert.equal(payload.TotalIntegrityFindings, 1);
    assert.doesNotMatch(logs[0] ?? "", /inactive-but-not-deleted-school/);
  });

  it("reduces scan failures to an identifier-free aggregate signal", async () => {
    const privateDetails = [
      "school-private-failure",
      "user-private-failure",
      "teacher.private@example.edu",
    ];
    const logs: string[] = [];
    const alerts: ScanAlert[] = [];

    const summary = await runStaffIdentityIntegrityScan({
      listSchoolIds: async () => {
        throw new Error(
          `query failed for ${privateDetails[0]} ${privateDetails[1]} ${privateDetails[2]}`
        );
      },
      countNormalizedEmailCollisionGroups: async () => 0,
      inspectUnscoped: async () => ({ total: 0 }),
      inspectSchool: async () => integrityResult(0),
      monitor: scanMonitor(alerts),
      log: (line) => logs.push(line),
      environment: "test",
      service: "scheduler-worker",
    });

    assert.equal(summary.scanFailures, 1);
    assert.equal(alerts.length, 1);
    assert.equal(alerts[0]?.category, "scheduler_failure");
    const emitted = `${logs.join("\n")}\n${JSON.stringify(alerts)}`;
    for (const value of privateDetails) {
      assert.doesNotMatch(emitted, new RegExp(value.replaceAll(".", "\\.")));
    }
  });

  it("prevents in-process overlap and keeps cadence bounded", async () => {
    let releaseList: ((ids: readonly string[]) => void) | undefined;
    const waitingForList = new Promise<readonly string[]>((resolve) => {
      releaseList = resolve;
    });
    const logs: string[] = [];
    const alerts: ScanAlert[] = [];
    const common = {
      monitor: scanMonitor(alerts),
      log: (line: string) => logs.push(line),
      environment: "test",
      service: "scheduler-worker",
    };

    const first = runStaffIdentityIntegrityScan({
      ...common,
      listSchoolIds: async () => waitingForList,
      countNormalizedEmailCollisionGroups: async () => 0,
      inspectUnscoped: async () => ({ total: 0 }),
      inspectSchool: async () => integrityResult(0),
      now: () => 1,
    });
    await Promise.resolve();
    const second = await runStaffIdentityIntegrityScan({
      ...common,
      listSchoolIds: async () => ["must-not-run"],
      countNormalizedEmailCollisionGroups: async () => 0,
      inspectUnscoped: async () => ({ total: 0 }),
      inspectSchool: async () => integrityResult(0),
      now: () => 2,
    });
    releaseList?.([]);
    await first;

    assert.equal(second.status, "skipped_overlap");
    assert.equal(getStaffIdentityIntegrityScanIntervalMinutes({}), DEFAULT_STAFF_IDENTITY_INTEGRITY_SCAN_INTERVAL_MINUTES);
    assert.equal(getStaffIdentityIntegrityScanIntervalMinutes({ STAFF_IDENTITY_INTEGRITY_SCAN_INTERVAL_MINUTES: "1" }), 5);
    assert.equal(getStaffIdentityIntegrityScanIntervalMinutes({ STAFF_IDENTITY_INTEGRITY_SCAN_INTERVAL_MINUTES: "99999" }), 1440);
    assert.equal(getStaffIdentityIntegrityScanIntervalMinutes({ STAFF_IDENTITY_INTEGRITY_SCAN_INTERVAL_MINUTES: "disabled" }), 60);
  });

  it("alerts only after three matching lifecycle guard outcomes without tenant details", async () => {
    const dispatched: Array<{ subject: string; text: string }> = [];
    const delivered: DeliveryResult = {
      channel: "email",
      attempted: true,
      delivered: true,
    };
    const monitor = new ErrorMonitor({
      now: () => 10_000,
      persist: async () => "persisted",
      capture: () => undefined,
      flushExternal: async () => undefined,
      dispatchAlert: async (subject, text) => {
        dispatched.push({ subject, text });
        return [delivered];
      },
      startHousekeeping: false,
      startMetrics: false,
      aggregation: new LocalOnlyAggregation(),
    });
    const privateValues = [
      "school-private-guard",
      "user-private-guard",
      "kenzie.vatter@example.edu",
    ];

    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const cause = Object.assign(
        new Error(`Blocked ${privateValues[2]} for ${privateValues[0]}`),
        {
          code: "23514",
          constraint: "classpilot_active_staff_assignment_membership",
        }
      );
      monitor.trackError(
        "client_error",
        new Error("wrapped staff mutation", { cause }),
        {
          schoolId: privateValues[0],
          userId: privateValues[1],
          path: "/api/users/staff/private-membership/transition",
        },
        { persist: false }
      );
      await monitor.flush();
      assert.equal(dispatched.length, 0, `attempt ${attempt} must remain below threshold`);
    }

    const thirdCause = Object.assign(new Error("third blocked mutation"), {
      code: "23514",
      constraint: "classpilot_active_staff_assignment_membership",
    });
    monitor.trackError(
      "client_error",
      new Error("wrapped staff mutation", { cause: thirdCause }),
      {
        schoolId: privateValues[0],
        userId: privateValues[1],
      },
      { persist: false }
    );
    await monitor.flush();

    assert.equal(dispatched.length, 1);
    assert.match(dispatched[0]?.subject ?? "", /staff_lifecycle_guard_violation/);
    assert.match(
      dispatched[0]?.text ?? "",
      /STAFF_ASSIGNMENTS_REQUIRE_REASSIGNMENT/
    );
    const outbound = JSON.stringify(dispatched);
    for (const value of privateValues) {
      assert.doesNotMatch(outbound, new RegExp(value.replaceAll(".", "\\.")));
    }
    assert.equal(
      resolveStaffLifecycleGuardCode({
        code: "STAFF_CLASS_ASSIGNMENT_INELIGIBLE",
      }),
      "STAFF_CLASS_ASSIGNMENT_INELIGIBLE"
    );
    assert.equal(resolveStaffLifecycleGuardCode({ code: "SOME_OTHER_CONFLICT" }), undefined);
    monitor.dispose();
  });

  it("wires the aggregate scan through the scheduler advisory lock", () => {
    const schedulerSource = readFileSync(
      new URL("../src/services/scheduler.ts", import.meta.url),
      "utf8"
    );
    assert.match(schedulerSource, /STAFF_IDENTITY_INTEGRITY_SCAN_JOB/);
    assert.match(
      schedulerSource,
      /scheduleLockedJob\([\s\S]*?STAFF_IDENTITY_INTEGRITY_SCAN_JOB[\s\S]*?runStaffIdentityIntegrityScan/
    );
    const monitorSource = readFileSync(
      new URL("../src/services/staffIdentityMonitoring.ts", import.meta.url),
      "utf8"
    );
    assert.match(monitorSource, /\.where\(isNull\(schools\.deletedAt\)\)/);
    assert.match(monitorSource, /GROUP BY lower\(btrim\(email\)\)/);
    assert.match(monitorSource, /HAVING count\(\*\) > 1/);
  });
});
