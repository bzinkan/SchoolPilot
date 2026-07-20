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

function usage(): string {
  return [
    "Usage: node dist/cli/checkClasspilotTileAuthorizationPlans.js --execute [options]",
    "",
    "Options:",
    "  --samples <20-100>  Measured warm-plan samples per scenario (default 20).",
    "  --help              Show help without connecting to PostgreSQL.",
    "",
    "Runs six read-only, tenant-scoped authorization EXPLAIN checks for fixed",
    "40-student cohorts. Output contains aggregate labels and timings only.",
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
  try {
    databaseModule = await import("../db.js");
    const storageModule = await import("../services/storage.js");
    client = await databaseModule.pool.connect();
    const report = await runClasspilotTileAuthorizationPlanCheck({
      client,
      buildQuery: storageModule.buildClassPilotTileAuthorizationQuery,
      samples: options.samples,
    });
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
