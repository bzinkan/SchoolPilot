import { asc, isNull, sql } from "drizzle-orm";

import { schools } from "../schema/core.js";
import errorMonitor, {
  type ErrorCategory,
  type MonitorEventOptions,
} from "./errorMonitor.js";
import { schedulerDb } from "./schedulerDb.js";
import {
  getStaffAssignmentIntegrityIssues,
  getUnscopedStaffAssignmentIntegrityIssues,
  type StaffAssignmentIntegrityIssues,
} from "./staffAssignmentLifecycle.js";

export const DEFAULT_STAFF_IDENTITY_INTEGRITY_SCAN_INTERVAL_MINUTES = 60;
export const MIN_STAFF_IDENTITY_INTEGRITY_SCAN_INTERVAL_MINUTES = 5;
export const MAX_STAFF_IDENTITY_INTEGRITY_SCAN_INTERVAL_MINUTES = 24 * 60;
export const STAFF_IDENTITY_INTEGRITY_SCAN_JOB = "staffIdentityIntegrityScan";

const INTEGRITY_COUNT_KEYS = [
  "invalidPrimaryAssignments",
  "invalidCoTeacherAssignments",
  "invalidClassRelationships",
  "primaryMirrorMismatches",
  "invalidLiveAssignments",
  "invalidLiveBlockers",
  "homeroomPrimaryMirrorMismatches",
  "invalidHomeroomRelationships",
  "invalidTenantScopes",
] as const satisfies readonly (keyof StaffAssignmentIntegrityIssues["counts"])[];

type IntegrityCountKey = (typeof INTEGRITY_COUNT_KEYS)[number];
type IntegrityCounts = Record<IntegrityCountKey, number>;

export type StaffIdentityIntegrityScanSummary = {
  status: "completed" | "skipped_overlap";
  schoolsInScope: number;
  schoolsScanned: number;
  schoolsWithIssues: number;
  normalizedEmailCollisionGroups: number;
  unscopedIssues: number;
  scanFailures: number;
  totalIssues: number;
  counts: IntegrityCounts;
};

type IntegrityResult = Pick<StaffAssignmentIntegrityIssues, "counts" | "total">;

export type StaffIdentityOperationalMonitor = {
  trackError(
    category: ErrorCategory,
    error: Error | string | unknown,
    context?: Record<string, unknown>,
    options?: MonitorEventOptions
  ): void;
};

export type StaffIdentityIntegrityScanDependencies = {
  listSchoolIds: () => Promise<readonly string[]>;
  countNormalizedEmailCollisionGroups: () => Promise<number>;
  inspectUnscoped: () => Promise<{ total: number }>;
  inspectSchool: (schoolId: string) => Promise<IntegrityResult>;
  monitor: StaffIdentityOperationalMonitor;
  log: (line: string) => void;
  now: () => number;
  environment: string;
  service: string;
};

function emptyIntegrityCounts(): IntegrityCounts {
  return {
    invalidPrimaryAssignments: 0,
    invalidCoTeacherAssignments: 0,
    invalidClassRelationships: 0,
    primaryMirrorMismatches: 0,
    invalidLiveAssignments: 0,
    invalidLiveBlockers: 0,
    homeroomPrimaryMirrorMismatches: 0,
    invalidHomeroomRelationships: 0,
    invalidTenantScopes: 0,
  };
}

function emptySummary(
  status: StaffIdentityIntegrityScanSummary["status"]
): StaffIdentityIntegrityScanSummary {
  return {
    status,
    schoolsInScope: 0,
    schoolsScanned: 0,
    schoolsWithIssues: 0,
    normalizedEmailCollisionGroups: 0,
    unscopedIssues: 0,
    scanFailures: 0,
    totalIssues: 0,
    counts: emptyIntegrityCounts(),
  };
}

export function getStaffIdentityIntegrityScanIntervalMinutes(
  env: NodeJS.ProcessEnv = process.env
): number {
  const raw = env.STAFF_IDENTITY_INTEGRITY_SCAN_INTERVAL_MINUTES;
  if (!raw || !/^\d+$/.test(raw.trim())) {
    return DEFAULT_STAFF_IDENTITY_INTEGRITY_SCAN_INTERVAL_MINUTES;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(parsed)) {
    return DEFAULT_STAFF_IDENTITY_INTEGRITY_SCAN_INTERVAL_MINUTES;
  }
  return Math.min(
    MAX_STAFF_IDENTITY_INTEGRITY_SCAN_INTERVAL_MINUTES,
    Math.max(MIN_STAFF_IDENTITY_INTEGRITY_SCAN_INTERVAL_MINUTES, parsed)
  );
}

async function listSchoolIds(): Promise<string[]> {
  // schedulerDb sets app.is_super=on for every checkout. This is the deliberate
  // cross-school read path; no request-scoped or bare database connection is used.
  const rows = await schedulerDb
    .select({ id: schools.id })
    .from(schools)
    .where(isNull(schools.deletedAt))
    .orderBy(asc(schools.id));
  return rows.map((row) => row.id);
}

async function countNormalizedEmailCollisionGroups(): Promise<number> {
  const result = await schedulerDb.execute<{
    collision_group_count: string | number;
  }>(sql`
    SELECT count(*) AS collision_group_count
    FROM (
      SELECT lower(btrim(email))
      FROM users
      GROUP BY lower(btrim(email))
      HAVING count(*) > 1
    ) AS normalized_email_collision
  `);
  const value = Number(result.rows[0]?.collision_group_count ?? 0);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error("Invalid normalized email collision aggregate");
  }
  return value;
}

async function inspectSchool(schoolId: string): Promise<IntegrityResult> {
  const lifecycleDb = schedulerDb as unknown as NonNullable<
    Parameters<typeof getStaffAssignmentIntegrityIssues>[1]
  >;
  return getStaffAssignmentIntegrityIssues(schoolId, lifecycleDb);
}

async function inspectUnscoped(): Promise<{ total: number }> {
  const lifecycleDb = schedulerDb as unknown as NonNullable<
    Parameters<typeof getUnscopedStaffAssignmentIntegrityIssues>[0]
  >;
  return getUnscopedStaffAssignmentIntegrityIssues(lifecycleDb);
}

function defaultDependencies(): StaffIdentityIntegrityScanDependencies {
  return {
    listSchoolIds,
    countNormalizedEmailCollisionGroups,
    inspectUnscoped,
    inspectSchool,
    monitor: errorMonitor,
    log: (line) => console.log(line),
    now: Date.now,
    environment: process.env.APP_ENV || process.env.NODE_ENV || "development",
    service: "scheduler-worker",
  };
}

function scanMetricPayload(
  summary: StaffIdentityIntegrityScanSummary,
  dependencies: StaffIdentityIntegrityScanDependencies
): string {
  const metricValues: Record<string, number> = {
    SchoolsInScope: summary.schoolsInScope,
    SchoolsScanned: summary.schoolsScanned,
    SchoolsWithIssues: summary.schoolsWithIssues,
    NormalizedEmailCollisionGroups: summary.normalizedEmailCollisionGroups,
    UnscopedIssues: summary.unscopedIssues,
    ScanFailures: summary.scanFailures,
    TotalIntegrityIssues: summary.totalIssues,
    TotalIntegrityFindings:
      summary.totalIssues + summary.normalizedEmailCollisionGroups,
    ScanSkippedOverlap: summary.status === "skipped_overlap" ? 1 : 0,
  };
  for (const key of INTEGRITY_COUNT_KEYS) {
    metricValues[`${key[0]?.toUpperCase() ?? ""}${key.slice(1)}`] =
      summary.counts[key];
  }
  return JSON.stringify({
    _aws: {
      Timestamp: dependencies.now(),
      CloudWatchMetrics: [{
        Namespace: "SchoolPilot/StaffIdentity",
        Dimensions: [["Environment", "Service"]],
        Metrics: Object.keys(metricValues).map((Name) => ({ Name, Unit: "Count" })),
      }],
    },
    Environment: dependencies.environment,
    Service: dependencies.service,
    ...metricValues,
  });
}

function aggregateAlertMessage(summary: StaffIdentityIntegrityScanSummary): string {
  const countText = INTEGRITY_COUNT_KEYS
    .map((key) => `${key}=${summary.counts[key]}`)
    .join(" ");
  return [
    "Staff identity integrity scan found live ownership issues.",
    `schoolsInScope=${summary.schoolsInScope}`,
    `schoolsScanned=${summary.schoolsScanned}`,
    `schoolsWithIssues=${summary.schoolsWithIssues}`,
    `normalizedEmailCollisionGroups=${summary.normalizedEmailCollisionGroups}`,
    `unscopedIssues=${summary.unscopedIssues}`,
    `scanFailures=${summary.scanFailures}`,
    `totalIssues=${summary.totalIssues}`,
    countText,
  ].join(" ");
}

let scanInFlight = false;

/**
 * Read-only, counts-only staff ownership scan for the singleton worker.
 *
 * The scheduler also wraps this job in its cross-process advisory lock. The
 * local gate protects direct or accidentally duplicated calls in one process.
 */
export async function runStaffIdentityIntegrityScan(
  overrides: Partial<StaffIdentityIntegrityScanDependencies> = {}
): Promise<StaffIdentityIntegrityScanSummary> {
  const dependencies = { ...defaultDependencies(), ...overrides };
  if (scanInFlight) {
    const skipped = emptySummary("skipped_overlap");
    dependencies.log(scanMetricPayload(skipped, dependencies));
    return skipped;
  }

  scanInFlight = true;
  try {
    const summary = emptySummary("completed");
    let schoolIds: readonly string[];
    try {
      schoolIds = await dependencies.listSchoolIds();
    } catch {
      // Treat enumeration as one aggregate scan failure. The raw database
      // error is deliberately not forwarded because it is unnecessary for the
      // operational signal and could contain query details.
      summary.scanFailures = 1;
      dependencies.log(scanMetricPayload(summary, dependencies));
      dependencies.monitor.trackError(
        "scheduler_failure",
        new Error(
          "Staff identity integrity scan incomplete: schoolsInScope=0 " +
          "schoolsScanned=0 scanFailures=1"
        ),
        {
          job: STAFF_IDENTITY_INTEGRITY_SCAN_JOB,
          eventType: "staff_identity_integrity_scan_incomplete",
          errorCode: "STAFF_IDENTITY_INTEGRITY_SCAN_INCOMPLETE",
          source: "scheduler_worker",
        },
        { persist: false, priority: "high" }
      );
      return summary;
    }
    summary.schoolsInScope = schoolIds.length;

    try {
      summary.normalizedEmailCollisionGroups =
        await dependencies.countNormalizedEmailCollisionGroups();
    } catch {
      summary.scanFailures += 1;
    }

    try {
      const unscoped = await dependencies.inspectUnscoped();
      summary.unscopedIssues = unscoped.total;
      summary.totalIssues += unscoped.total;
    } catch {
      summary.scanFailures += 1;
    }

    // Sequential inspection keeps the singleton worker inside its small,
    // isolated scheduler connection budget.
    for (const schoolId of schoolIds) {
      try {
        const result = await dependencies.inspectSchool(schoolId);
        summary.schoolsScanned += 1;
        summary.totalIssues += result.total;
        if (result.total > 0) summary.schoolsWithIssues += 1;
        for (const key of INTEGRITY_COUNT_KEYS) {
          summary.counts[key] += result.counts[key];
        }
      } catch {
        // Never log the school ID or the underlying query/error. The aggregate
        // incomplete-scan signal below is the operational boundary.
        summary.scanFailures += 1;
      }
    }

    dependencies.log(scanMetricPayload(summary, dependencies));

    if (
      summary.totalIssues > 0 ||
      summary.normalizedEmailCollisionGroups > 0
    ) {
      dependencies.monitor.trackError(
        "staff_identity_integrity",
        new Error(aggregateAlertMessage(summary)),
        {
          job: STAFF_IDENTITY_INTEGRITY_SCAN_JOB,
          eventType: "staff_identity_integrity_nonzero",
          errorCode: "STAFF_IDENTITY_INTEGRITY_NONZERO",
          source: "scheduler_worker",
        },
        { persist: false, priority: "high" }
      );
    }

    if (summary.scanFailures > 0) {
      dependencies.monitor.trackError(
        "scheduler_failure",
        new Error(
          `Staff identity integrity scan incomplete: schoolsInScope=${summary.schoolsInScope} ` +
          `schoolsScanned=${summary.schoolsScanned} scanFailures=${summary.scanFailures}`
        ),
        {
          job: STAFF_IDENTITY_INTEGRITY_SCAN_JOB,
          eventType: "staff_identity_integrity_scan_incomplete",
          errorCode: "STAFF_IDENTITY_INTEGRITY_SCAN_INCOMPLETE",
          source: "scheduler_worker",
        },
        { persist: false, priority: "high" }
      );
    }

    return summary;
  } finally {
    scanInFlight = false;
  }
}
