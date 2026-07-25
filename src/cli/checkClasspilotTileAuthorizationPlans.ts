import { pathToFileURL } from "node:url";
import type { PoolClient } from "pg";
import {
  CLASSPILOT_TILE_AUTHORIZATION_PLAN_SAMPLES,
  ClasspilotTileAuthorizationPlanCheckError,
  runClasspilotTileAuthorizationPlanBasePreflight,
  runClasspilotTileAuthorizationPlanCheck,
  validateClasspilotTileAuthorizationPlanBaseFunnelEvidence,
} from "../services/classpilotTileAuthorizationPlanCheck.js";

type CliOptions = {
  execute: boolean;
  preflightBase: boolean;
  help: boolean;
  samples: number;
};

const TRANSACTIONAL_PLAN_SCENARIOS_VERSION =
  "transactional-plan-scenarios-v2";
const TRANSACTIONAL_PLAN_SCENARIOS_KEYS = [
  "insertedSessionPairs",
  "requiredSessionPairs",
  "residue",
  "reusedActiveSessionPairs",
  "rollback",
  "seededRows",
  "version",
] as const;
const TRANSACTIONAL_PLAN_SEEDED_ROWS_KEYS = [
  "groupTeachers",
  "supervisionContexts",
  "supervisionStudents",
  "studentSessions",
  "teachingSessions",
  "total",
] as const;
const TRANSACTIONAL_PLAN_ROLLBACK_KEYS = ["attempted", "completed"] as const;
const TRANSACTIONAL_PLAN_RESIDUE_KEYS = ["checked", "count", "passed"] as const;
const BASE_PREFLIGHT_VERSION =
  "classpilot-tile-auth-plan-base-preflight-v1";
const BASE_PREFLIGHT_KEYS = [
  "conflictingSessionPairs",
  "eligibleBases",
  "missingSessionPairs",
  "requiredSessionPairs",
  "reusedActiveSessionPairs",
  "status",
  "version",
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(
  value: unknown,
  expectedKeys: readonly string[]
): value is Record<string, unknown> {
  return isRecord(value) &&
    JSON.stringify(Object.keys(value).sort()) ===
      JSON.stringify([...expectedKeys].sort());
}

export function sanitizeTransactionalPlanScenariosLifecycleEvent(
  event: unknown
): Record<string, unknown> {
  if (
    !hasExactKeys(event, TRANSACTIONAL_PLAN_SCENARIOS_KEYS) ||
    event.version !== TRANSACTIONAL_PLAN_SCENARIOS_VERSION
  ) {
    throw new Error("transactional_plan_scenarios_lifecycle_invalid");
  }

  const seededRows = event.seededRows;
  const rollback = event.rollback;
  const residue = event.residue;
  if (
    !hasExactKeys(seededRows, TRANSACTIONAL_PLAN_SEEDED_ROWS_KEYS) ||
    !Number.isInteger(seededRows.groupTeachers) ||
    !Number.isInteger(seededRows.teachingSessions) ||
    !Number.isInteger(seededRows.supervisionContexts) ||
    !Number.isInteger(seededRows.supervisionStudents) ||
    !Number.isInteger(seededRows.studentSessions) ||
    !Number.isInteger(seededRows.total) ||
    !Number.isInteger(event.requiredSessionPairs) ||
    !Number.isInteger(event.reusedActiveSessionPairs) ||
    !Number.isInteger(event.insertedSessionPairs) ||
    !hasExactKeys(rollback, TRANSACTIONAL_PLAN_ROLLBACK_KEYS) ||
    typeof rollback.attempted !== "boolean" ||
    typeof rollback.completed !== "boolean" ||
    !hasExactKeys(residue, TRANSACTIONAL_PLAN_RESIDUE_KEYS) ||
    typeof residue.checked !== "boolean" ||
    typeof residue.passed !== "boolean"
  ) {
    throw new Error("transactional_plan_scenarios_lifecycle_invalid");
  }

  const rollbackAttempted = rollback.attempted;
  const rollbackCompleted = rollback.completed;
  const groupTeachers = seededRows.groupTeachers as number;
  const teachingSessions = seededRows.teachingSessions as number;
  const supervisionContexts = seededRows.supervisionContexts as number;
  const supervisionStudents = seededRows.supervisionStudents as number;
  const studentSessions = seededRows.studentSessions as number;
  const total = seededRows.total as number;
  const requiredSessionPairs = event.requiredSessionPairs as number;
  const reusedActiveSessionPairs = event.reusedActiveSessionPairs as number;
  const insertedSessionPairs = event.insertedSessionPairs as number;
  const residueChecked = residue.checked;
  const residueCount = residue.count;
  const residuePassed = residue.passed;
  const validResidueCount =
    residueCount === null ||
    (Number.isInteger(residueCount) &&
      (residueCount as number) >= 0 &&
      (residueCount as number) <= 123);
  if (
    !validResidueCount ||
    groupTeachers < 0 ||
    groupTeachers > 1 ||
    teachingSessions < 0 ||
    teachingSessions > 1 ||
    supervisionContexts < 0 ||
    supervisionContexts > 1 ||
    supervisionStudents < 0 ||
    supervisionStudents > 40 ||
    studentSessions < 0 ||
    studentSessions > 80 ||
    requiredSessionPairs !== 80 ||
    reusedActiveSessionPairs < 0 ||
    reusedActiveSessionPairs > requiredSessionPairs ||
    insertedSessionPairs < 0 ||
    insertedSessionPairs > requiredSessionPairs ||
    reusedActiveSessionPairs + insertedSessionPairs > requiredSessionPairs ||
    studentSessions !== insertedSessionPairs ||
    total !==
      groupTeachers +
        teachingSessions +
        supervisionContexts +
        supervisionStudents +
        studentSessions ||
    (rollbackCompleted && !rollbackAttempted) ||
    (residueChecked &&
      (residueCount === null || residuePassed !== (residueCount === 0))) ||
    (!residueChecked && (residueCount !== null || residuePassed))
  ) {
    throw new Error("transactional_plan_scenarios_lifecycle_invalid");
  }

  return {
    version: TRANSACTIONAL_PLAN_SCENARIOS_VERSION,
    requiredSessionPairs,
    reusedActiveSessionPairs,
    insertedSessionPairs,
    seededRows: {
      groupTeachers,
      teachingSessions,
      supervisionContexts,
      supervisionStudents,
      studentSessions,
      total,
    },
    rollback: {
      attempted: rollbackAttempted,
      completed: rollbackCompleted,
    },
    residue: {
      checked: residueChecked,
      count: residueCount,
      passed: residuePassed,
    },
  };
}

export function sanitizeClasspilotTileAuthorizationPlanBasePreflight(
  event: unknown
): Record<string, unknown> {
  if (
    !hasExactKeys(event, BASE_PREFLIGHT_KEYS) ||
    event.version !== BASE_PREFLIGHT_VERSION ||
    event.status !== "passed" ||
    event.eligibleBases !== 1 ||
    event.requiredSessionPairs !== 80 ||
    !Number.isInteger(event.reusedActiveSessionPairs) ||
    !Number.isInteger(event.missingSessionPairs) ||
    event.conflictingSessionPairs !== 0
  ) {
    throw new Error("classpilot_tile_auth_plan_base_preflight_invalid");
  }
  const reusedActiveSessionPairs = event.reusedActiveSessionPairs as number;
  const missingSessionPairs = event.missingSessionPairs as number;
  if (
    reusedActiveSessionPairs < 0 ||
    reusedActiveSessionPairs > 80 ||
    missingSessionPairs < 0 ||
    missingSessionPairs > 80 ||
    reusedActiveSessionPairs + missingSessionPairs !== 80
  ) {
    throw new Error("classpilot_tile_auth_plan_base_preflight_invalid");
  }
  return {
    version: BASE_PREFLIGHT_VERSION,
    status: "passed",
    eligibleBases: 1,
    requiredSessionPairs: 80,
    reusedActiveSessionPairs,
    missingSessionPairs,
    conflictingSessionPairs: 0,
  };
}

export function createClasspilotTilePlanWriteClientReleaseError(
  lifecycleEvent: unknown
): Error | undefined {
  if (!isRecord(lifecycleEvent) || !isRecord(lifecycleEvent.rollback)) {
    return undefined;
  }
  return lifecycleEvent.rollback.attempted === true &&
    lifecycleEvent.rollback.completed !== true
    ? new Error("classpilot_tile_auth_plan_write_connection_discarded")
    : undefined;
}

export function createClasspilotTilePlanResidueClientReleaseError(
  lifecycleEvent: unknown
): Error | undefined {
  if (!isRecord(lifecycleEvent) || !isRecord(lifecycleEvent.residue)) {
    return undefined;
  }
  return lifecycleEvent.residue.checked !== true
    ? new Error("classpilot_tile_auth_plan_residue_connection_discarded")
    : undefined;
}

export function sanitizeClasspilotTileAuthorizationPlanCheckFailure(
  error: ClasspilotTileAuthorizationPlanCheckError
): Record<string, unknown> {
  const failure: Record<string, unknown> = {
    status: "failed",
    failureCode: error.failureCode,
    labels: error.labels,
    invalidTeachingSessionSchools: error.invalidCount,
  };
  if (
    error.failureCode === "representative_scenario_missing" &&
    error.funnelEvidence !== undefined
  ) {
    failure.funnelEvidence =
      validateClasspilotTileAuthorizationPlanBaseFunnelEvidence(
        error.funnelEvidence
      );
  }
  return failure;
}

function usage(): string {
  return [
    "Usage: node dist/cli/checkClasspilotTileAuthorizationPlans.js (--execute | --preflight-base) [options]",
    "",
    "Options:",
    "  --samples <20-100>  Measured warm-plan samples per scenario (default 20).",
    "  --preflight-base     Read-only validation of the stable 80-pair base.",
    "  --help                Show help without connecting to PostgreSQL.",
    "",
    "Provisions rollback-only plan scenarios, runs six tenant-scoped",
    "authorization EXPLAIN checks plus the exact 40-student history fallback,",
    "and verifies zero residue. Output is aggregate-only evidence.",
  ].join("\n");
}

export function parseClasspilotTilePlanCliArgs(args: string[]): CliOptions {
  const options: CliOptions = {
    execute: false,
    preflightBase: false,
    help: false,
    samples: CLASSPILOT_TILE_AUTHORIZATION_PLAN_SAMPLES,
  };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--execute") {
      options.execute = true;
      continue;
    }
    if (argument === "--preflight-base") {
      options.preflightBase = true;
      continue;
    }
    if (argument === "--help" || argument === "-h") {
      options.help = true;
      continue;
    }
    if (argument === "--samples") {
      const value = args[index + 1];
      if (!value) throw new Error("invalid_arguments");
      options.samples = Number(value);
      index += 1;
      continue;
    }
    throw new Error("invalid_arguments");
  }
  if (
    !Number.isInteger(options.samples) ||
    options.samples < CLASSPILOT_TILE_AUTHORIZATION_PLAN_SAMPLES ||
    options.samples > 100
  ) {
    throw new Error("invalid_arguments");
  }
  if (options.execute && options.preflightBase) {
    throw new Error("invalid_arguments");
  }
  return options;
}

function emit(value: Record<string, unknown>, error = false): void {
  const serialized = `${JSON.stringify(value)}\n`;
  if (error) process.stderr.write(serialized);
  else process.stdout.write(serialized);
}

export async function runClasspilotTilePlanCli(args: string[]): Promise<number> {
  let options: CliOptions;
  try {
    options = parseClasspilotTilePlanCliArgs(args);
  } catch {
    emit({ status: "failed", failureCode: "invalid_arguments" }, true);
    return 2;
  }
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return 0;
  }
  if (!options.execute && !options.preflightBase) {
    emit({ status: "failed", failureCode: "execute_required" }, true);
    return 2;
  }

  let databaseModule: typeof import("../db.js") | undefined;
  let client: PoolClient | undefined;
  let residueClient: PoolClient | undefined;
  let writeClientReleaseError: Error | undefined;
  let residueClientReleaseError: Error | undefined;
  let lifecycleEventCount = 0;
  let lifecycleCleanupPassed = false;
  try {
    databaseModule = await import("../db.js");
    client = await databaseModule.pool.connect();
    if (options.preflightBase) {
      const preflight =
        await runClasspilotTileAuthorizationPlanBasePreflight({ client });
      emit(sanitizeClasspilotTileAuthorizationPlanBasePreflight(preflight));
      return 0;
    }
    const storageModule = await import("../services/storage.js");
    residueClient = await databaseModule.pool.connect();
    const report = await runClasspilotTileAuthorizationPlanCheck({
      client,
      residueClient,
      buildQuery: storageModule.buildClassPilotTileAuthorizationQuery,
      buildHistoryQuery: storageModule.buildHeartbeatTileHistoryBatchQuery,
      samples: options.samples,
      onLifecycleEvent: (event: unknown) => {
        writeClientReleaseError =
          createClasspilotTilePlanWriteClientReleaseError(event);
        residueClientReleaseError =
          createClasspilotTilePlanResidueClientReleaseError(event);
        if (lifecycleEventCount !== 0) {
          throw new Error("transactional_plan_scenarios_lifecycle_duplicate");
        }
        const sanitized =
          sanitizeTransactionalPlanScenariosLifecycleEvent(event);
        emit(sanitized);
        lifecycleEventCount += 1;
        const rollback = sanitized.rollback as Record<string, unknown>;
        const residue = sanitized.residue as Record<string, unknown>;
        const seededRows = sanitized.seededRows as Record<string, unknown>;
        lifecycleCleanupPassed =
          seededRows.groupTeachers === 1 &&
          seededRows.teachingSessions === 1 &&
          seededRows.supervisionContexts === 1 &&
          seededRows.supervisionStudents === 40 &&
          Number.isInteger(seededRows.studentSessions) &&
          sanitized.requiredSessionPairs === 80 &&
          (sanitized.reusedActiveSessionPairs as number) +
              (sanitized.insertedSessionPairs as number) ===
            80 &&
          seededRows.studentSessions === sanitized.insertedSessionPairs &&
          seededRows.total ===
            43 + (sanitized.insertedSessionPairs as number) &&
          rollback.completed === true &&
          residue.checked === true &&
          residue.count === 0 &&
          residue.passed === true;
      },
    });
    if (lifecycleEventCount !== 1 || !lifecycleCleanupPassed) {
      throw new Error("transactional_plan_scenarios_lifecycle_missing");
    }
    if (report.status !== "passed") {
      emit(report as unknown as Record<string, unknown>, true);
      emit(
        {
          status: "failed",
          failureCode: "plan_threshold_failed",
        },
        true
      );
      return 1;
    }
    emit(report as unknown as Record<string, unknown>);
    return 0;
  } catch (error) {
    if (options.preflightBase) {
      writeClientReleaseError = new Error(
        "classpilot_tile_auth_plan_preflight_connection_discarded"
      );
    }
    if (error instanceof ClasspilotTileAuthorizationPlanCheckError) {
      emit(sanitizeClasspilotTileAuthorizationPlanCheckFailure(error), true);
    } else {
      emit({ status: "failed", failureCode: "database_operation_failed" }, true);
    }
    return 1;
  } finally {
    if (client) {
      client.release(writeClientReleaseError);
    }
    residueClient?.release(residueClientReleaseError);
    if (databaseModule) {
      await Promise.allSettled([
        databaseModule.pool.end(),
        databaseModule.sessionPool.end(),
      ]);
    }
  }
}

const invokedPath = process.argv[1];
if (invokedPath && import.meta.url === pathToFileURL(invokedPath).href) {
  process.exitCode = await runClasspilotTilePlanCli(process.argv.slice(2));
}
