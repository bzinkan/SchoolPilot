import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  resolveEcsApiRuntimeIdentity,
  type EcsApiRuntimeIdentity,
} from "../services/ecsRuntimeIdentity.js";

/**
 * Roadmap PR 2 rollback step: end every stored precise Waypoint and Flight
 * Path of one school with a control-revision bump before an image older than
 * preciseRestrictionResourcesV1 is restored. Dry-run first; the runbook is
 * docs/CLASSPILOT_ROADMAP_RUNTIME_ROLLOUT.md.
 */

export const PRECISE_RESTRICTION_CLEAR_ACKNOWLEDGEMENT = "precise-restriction-clear-v1";
export const PRECISE_RESTRICTION_CLEAR_PRODUCTION_ADMISSION = "controlled-ecs-one-off-v1";

const REPORT_VERSION = "classpilot-precise-restriction-clear-v1";
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PROOF_PATTERN = /^precise-clear-proof-v1:[0-9a-f]{64}$/;

export type PreciseRestrictionClearCliOptions = {
  help: boolean;
  execute: boolean;
  explicitDryRun: boolean;
  allSchools: boolean;
  schoolId?: string;
  expectedProof?: string;
  acknowledgement?: string;
};

type ClearExecutionEnvironment = {
  PRECISE_RESTRICTION_CLEAR_EXECUTION_ADMISSION?: string;
};

export async function assertPreciseRestrictionClearExecutionAdmission(options: {
  execute: boolean;
  environment?: ClearExecutionEnvironment;
  resolveRuntimeIdentity?: () => Promise<EcsApiRuntimeIdentity | null>;
}): Promise<void> {
  if (!options.execute) return;
  const environment = options.environment ?? process.env;
  const refused = (message: string) => Object.assign(new Error(message), {
    code: "PRECISE_RESTRICTION_CLEAR_ECS_ONE_OFF_REQUIRED",
  });
  if (
    environment.PRECISE_RESTRICTION_CLEAR_EXECUTION_ADMISSION
    !== PRECISE_RESTRICTION_CLEAR_PRODUCTION_ADMISSION
  ) {
    throw refused("Precise restriction clearing is not admitted.");
  }
  let identity: EcsApiRuntimeIdentity | null;
  try {
    identity = await (options.resolveRuntimeIdentity ?? resolveEcsApiRuntimeIdentity)();
  } catch {
    throw refused("ECS runtime identity could not be verified.");
  }
  if (!identity) throw refused("Precise restriction clearing requires ECS task identity.");
}

function usage(): string {
  return [
    "Usage:",
    "  npm run clear:classpilot-precise-restrictions -- --all-schools",
    "  npm run clear:classpilot-precise-restrictions -- --school-id <uuid>",
    "",
    "Dry-run is the default and is read-only. All-school mode is always inventory-only.",
    "",
    "Execution (one school) additionally requires:",
    "  --execute",
    "  --proof <precise-clear-proof-v1:...>   copied from that school's dry run",
    `  --acknowledge ${PRECISE_RESTRICTION_CLEAR_ACKNOWLEDGEMENT}`,
    `  ECS task env: PRECISE_RESTRICTION_CLEAR_EXECUTION_ADMISSION=${PRECISE_RESTRICTION_CLEAR_PRODUCTION_ADMISSION}`,
    "  preciseRestrictionResourcesV1 inactive for the school (apply precise-restriction-resources-off first)",
    "",
    "Output contains school IDs, counts and the proof only. It never emits student,",
    "staff or school names, URLs, or restriction contents.",
  ].join("\n");
}

function valueAfter(args: string[], index: number, flag: string): string {
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value.`);
  return value;
}

export function parsePreciseRestrictionClearCliArgs(
  args: string[]
): PreciseRestrictionClearCliOptions {
  const options: PreciseRestrictionClearCliOptions = {
    help: false,
    execute: false,
    explicitDryRun: false,
    allSchools: false,
  };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--help" || argument === "-h") options.help = true;
    else if (argument === "--execute") options.execute = true;
    else if (argument === "--dry-run") options.explicitDryRun = true;
    else if (argument === "--all-schools") options.allSchools = true;
    else if (argument === "--school-id") {
      options.schoolId = valueAfter(args, index, argument);
      index += 1;
    } else if (argument === "--proof") {
      options.expectedProof = valueAfter(args, index, argument);
      index += 1;
    } else if (argument === "--acknowledge") {
      options.acknowledgement = valueAfter(args, index, argument);
      index += 1;
    } else {
      throw new Error("Unknown precise restriction clear argument.");
    }
  }
  return options;
}

export function validatePreciseRestrictionClearCliOptions(
  options: PreciseRestrictionClearCliOptions
): void {
  if (options.help) return;
  if (!!options.schoolId === options.allSchools) {
    throw new Error("Select exactly one of --school-id or --all-schools.");
  }
  if (options.execute && options.explicitDryRun) {
    throw new Error("--execute and --dry-run are mutually exclusive.");
  }
  if (options.allSchools && options.execute) {
    throw new Error("All-school mode is inventory-only.");
  }
  if (options.schoolId !== undefined && !UUID_PATTERN.test(options.schoolId)) {
    throw new Error("--school-id must be a UUID.");
  }
  if (options.execute) {
    if (!options.expectedProof || !PROOF_PATTERN.test(options.expectedProof)) {
      throw new Error("Execution requires the exact dry-run proof.");
    }
    if (options.acknowledgement !== PRECISE_RESTRICTION_CLEAR_ACKNOWLEDGEMENT) {
      throw new Error("Execution requires the exact acknowledgement.");
    }
  } else if (options.expectedProof !== undefined || options.acknowledgement !== undefined) {
    throw new Error("Execution-only arguments require --execute.");
  }
}

function emit(value: unknown, error = false): void {
  const serialized = `${JSON.stringify(value)}\n`;
  if (error) process.stderr.write(serialized);
  else process.stdout.write(serialized);
}

function safeFailureCode(error: unknown): string {
  const code = error && typeof error === "object" && "code" in error
    ? (error as { code?: unknown }).code
    : undefined;
  return typeof code === "string" && /^[A-Z0-9_]{3,100}$/.test(code)
    ? code
    : "operation_failed";
}

export async function runPreciseRestrictionClearCli(args: string[]): Promise<number> {
  let options: PreciseRestrictionClearCliOptions;
  try {
    options = parsePreciseRestrictionClearCliArgs(args);
    validatePreciseRestrictionClearCliOptions(options);
  } catch {
    emit({ version: REPORT_VERSION, status: "failed", failureCode: "invalid_arguments" }, true);
    return 2;
  }
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return 0;
  }

  try {
    await assertPreciseRestrictionClearExecutionAdmission({ execute: options.execute });
  } catch (error) {
    emit({ version: REPORT_VERSION, status: "failed", failureCode: safeFailureCode(error) }, true);
    return 1;
  }

  let databaseModule: typeof import("../db.js") | undefined;
  let errorMonitorModule: typeof import("../services/errorMonitor.js") | undefined;
  try {
    const [clearModule, preciseModule, tenantContext, dbModule, loadedErrorMonitor] = await Promise.all([
      import("../services/classpilotPreciseRestrictionClear.js"),
      import("../services/classpilotPreciseRestrictions.js"),
      import("../middleware/tenantContext.js"),
      import("../db.js"),
      import("../services/errorMonitor.js"),
    ]);
    databaseModule = dbModule;
    errorMonitorModule = loadedErrorMonitor;

    if (options.allSchools) {
      const inventory = await tenantContext.runWithTenantContext(
        { isSuper: true },
        () => clearModule.inventoryClasspilotPreciseRestrictions()
      );
      const blocked = inventory.length > 0;
      emit({
        version: REPORT_VERSION,
        status: blocked ? "blocked" : "passed",
        mode: "inventory",
        affectedSchoolCount: inventory.length,
        schools: inventory.map((entry) => ({
          ...entry,
          capabilityActive: preciseModule.preciseRestrictionResourcesActive(entry.schoolId),
        })),
      }, blocked);
      return blocked ? 3 : 0;
    }

    const schoolId = options.schoolId!;
    const capabilityActive = preciseModule.preciseRestrictionResourcesActive(schoolId);
    if (!options.execute) {
      const plan = await tenantContext.runWithTenantContext(
        { schoolId },
        () => clearModule.planClasspilotPreciseRestrictionClear(schoolId)
      );
      const blocked = plan.controlStateCount + plan.classroomStateCount > 0;
      emit({
        version: REPORT_VERSION,
        status: blocked ? "blocked" : "passed",
        mode: "dry_run",
        capabilityActive,
        ...plan,
      }, blocked);
      return blocked ? 3 : 0;
    }

    const result = await tenantContext.runWithTenantContext(
      { schoolId },
      () => clearModule.clearClasspilotPreciseRestrictionsForSchool({
        schoolId,
        expectedProof: options.expectedProof!,
      })
    );
    emit({ version: REPORT_VERSION, status: "passed", mode: "execute", ...result });
    return 0;
  } catch (error) {
    emit({ version: REPORT_VERSION, status: "failed", failureCode: safeFailureCode(error) }, true);
    return 1;
  } finally {
    // Monitoring persistence uses the application pool. Drain it before
    // ending the pools so cleanup cannot race a closing connection.
    if (errorMonitorModule) {
      await Promise.allSettled([errorMonitorModule.default.disposeAndWait()]);
    }
    if (databaseModule) {
      await Promise.allSettled([
        databaseModule.pool.end(),
        databaseModule.sessionPool.end(),
      ]);
    }
  }
}

const invokedPath = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href
  : "";
if (invokedPath === import.meta.url) {
  void runPreciseRestrictionClearCli(process.argv.slice(2)).then((exitCode) => {
    process.exitCode = exitCode;
  });
}
