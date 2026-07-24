import { pathToFileURL } from "node:url";
import type { PoolClient } from "pg";
import {
  CLASSPILOT_TILE_AUTHORIZATION_PLAN_SAMPLES,
  ClasspilotTileAuthorizationPlanCheckError,
  runClasspilotTileAuthorizationPlanCheck,
} from "../services/classpilotTileAuthorizationPlanCheck.js";

type CliOptions = {
  execute: boolean;
  help: boolean;
  samples: number;
};

const TRANSACTIONAL_PLAN_SCENARIOS_VERSION =
  "transactional-plan-scenarios-v1";
const TRANSACTIONAL_PLAN_SCENARIOS_KEYS = [
  "residue",
  "rollback",
  "seededRows",
  "version",
] as const;
const TRANSACTIONAL_PLAN_SEEDED_ROWS_KEYS = [
  "groupTeachers",
  "supervisionContexts",
  "supervisionStudents",
  "teachingSessions",
  "total",
] as const;
const TRANSACTIONAL_PLAN_ROLLBACK_KEYS = ["attempted", "completed"] as const;
const TRANSACTIONAL_PLAN_RESIDUE_KEYS = ["checked", "count", "passed"] as const;

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
    !Number.isInteger(seededRows.total) ||
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
  const total = seededRows.total as number;
  const residueChecked = residue.checked;
  const residueCount = residue.count;
  const residuePassed = residue.passed;
  const validResidueCount =
    residueCount === null ||
    (Number.isInteger(residueCount) &&
      (residueCount as number) >= 0 &&
      (residueCount as number) <= 43);
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
    total !==
      groupTeachers +
        teachingSessions +
        supervisionContexts +
        supervisionStudents ||
    (rollbackCompleted && !rollbackAttempted) ||
    (residueChecked &&
      (residueCount === null || residuePassed !== (residueCount === 0))) ||
    (!residueChecked && (residueCount !== null || residuePassed))
  ) {
    throw new Error("transactional_plan_scenarios_lifecycle_invalid");
  }

  return {
    version: TRANSACTIONAL_PLAN_SCENARIOS_VERSION,
    seededRows: {
      groupTeachers,
      teachingSessions,
      supervisionContexts,
      supervisionStudents,
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

function usage(): string {
  return [
    "Usage: node dist/cli/checkClasspilotTileAuthorizationPlans.js --execute [options]",
    "",
    "Options:",
    "  --samples <20-100>  Measured warm-plan samples per scenario (default 20).",
    "  --help              Show help without connecting to PostgreSQL.",
    "",
    "Provisions rollback-only plan scenarios, runs six tenant-scoped",
    "authorization EXPLAIN checks plus the exact 40-student history fallback,",
    "and verifies zero residue. Output is aggregate-only evidence.",
  ].join("\n");
}

export function parseClasspilotTilePlanCliArgs(args: string[]): CliOptions {
  const options: CliOptions = {
    execute: false,
    help: false,
    samples: CLASSPILOT_TILE_AUTHORIZATION_PLAN_SAMPLES,
  };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--execute") {
      options.execute = true;
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
  if (!options.execute) {
    emit({ status: "failed", failureCode: "execute_required" }, true);
    return 2;
  }

  let databaseModule: typeof import("../db.js") | undefined;
  let client: PoolClient | undefined;
  let lifecycleEventCount = 0;
  let lifecycleCleanupPassed = false;
  try {
    databaseModule = await import("../db.js");
    const storageModule = await import("../services/storage.js");
    client = await databaseModule.pool.connect();
    const report = await runClasspilotTileAuthorizationPlanCheck({
      client,
      buildQuery: storageModule.buildClassPilotTileAuthorizationQuery,
      buildHistoryQuery: storageModule.buildHeartbeatTileHistoryBatchQuery,
      samples: options.samples,
      onLifecycleEvent: (event: unknown) => {
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
          seededRows.total === 43 &&
          rollback.completed === true &&
          residue.checked === true &&
          residue.count === 0 &&
          residue.passed === true;
      },
    });
    if (lifecycleEventCount !== 1 || !lifecycleCleanupPassed) {
      throw new Error("transactional_plan_scenarios_lifecycle_missing");
    }
    emit(report as unknown as Record<string, unknown>, report.status !== "passed");
    return report.status === "passed" ? 0 : 1;
  } catch (error) {
    if (error instanceof ClasspilotTileAuthorizationPlanCheckError) {
      emit(
        {
          status: "failed",
          failureCode: error.failureCode,
          labels: error.labels,
          invalidTeachingSessionSchools: error.invalidCount,
        },
        true
      );
    } else {
      emit({ status: "failed", failureCode: "database_operation_failed" }, true);
    }
    return 1;
  } finally {
    client?.release();
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
