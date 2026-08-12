import path from "node:path";
import { pathToFileURL } from "node:url";

export const PASSPILOT_CLEAN_CUTOVER_CLASS_MODEL_ACKNOWLEDGEMENT =
  "classpilot-groups-v1";

export type PasspilotCleanCutoverCliOptions = {
  execute: boolean;
  explicitDryRun: boolean;
  help: boolean;
  schoolId?: string;
  allCleanSchools: boolean;
  superAdminActorId?: string;
  classModelAcknowledgement?: string;
};

type SchoolReport = {
  schoolId: string;
  eligible: boolean;
  reasons: string[];
  counts: Record<string, number>;
  outcome: "dry_run" | "ineligible" | "executed" | "skipped_after_recheck" | "failed";
  failureCode?: string;
};

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const REPORT_VERSION = "passpilot-clean-school-cutover-v1";

function usage(): string {
  return [
    "Usage:",
    "  npm run migrate:passpilot-clean-schools -- --school-id <uuid>",
    "  npm run migrate:passpilot-clean-schools -- --all-clean-schools",
    "",
    "Dry-run is the default. Dry-run never changes the persisted class source.",
    "",
    "Execution additionally requires all three flags:",
    "  --execute",
    "  --super-admin-actor-id <uuid>",
    `  --acknowledge-class-model ${PASSPILOT_CLEAN_CUTOVER_CLASS_MODEL_ACKNOWLEDGEMENT}`,
    "",
    "Options:",
    "  --school-id <uuid>             Inspect one exact school.",
    "  --all-clean-schools            Inspect every legacy-source candidate.",
    "  --dry-run                      Explicitly select the default read-only mode.",
    "  --execute                      Execute eligible cutovers after a locked recheck.",
    "  --super-admin-actor-id <uuid>  Audited super-admin actor (execution only).",
    "  --acknowledge-class-model <v>  Exact installed-client compatibility acknowledgement.",
    "  --help                         Show this help without connecting to the database.",
    "",
    "Reports contain school IDs, eligibility reasons, and counts only; no school, staff,",
    "student, or class names are emitted.",
  ].join("\n");
}

function requiredValue(args: string[], index: number, flag: string): string {
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value.`);
  return value;
}

export function parsePasspilotCleanCutoverCliArgs(
  args: string[]
): PasspilotCleanCutoverCliOptions {
  const options: PasspilotCleanCutoverCliOptions = {
    execute: false,
    explicitDryRun: false,
    help: false,
    allCleanSchools: false,
  };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--execute") {
      options.execute = true;
    } else if (argument === "--dry-run") {
      options.explicitDryRun = true;
    } else if (argument === "--help" || argument === "-h") {
      options.help = true;
    } else if (argument === "--all-clean-schools") {
      options.allCleanSchools = true;
    } else if (argument === "--school-id") {
      options.schoolId = requiredValue(args, index, argument);
      index += 1;
    } else if (argument === "--super-admin-actor-id") {
      options.superAdminActorId = requiredValue(args, index, argument);
      index += 1;
    } else if (argument === "--acknowledge-class-model") {
      options.classModelAcknowledgement = requiredValue(args, index, argument);
      index += 1;
    } else {
      throw new Error("Unknown clean-cutover CLI argument.");
    }
  }
  return options;
}

export function validatePasspilotCleanCutoverCliOptions(
  options: PasspilotCleanCutoverCliOptions
): void {
  if (options.help) return;
  if (!!options.schoolId === options.allCleanSchools) {
    throw new Error("Select exactly one of --school-id or --all-clean-schools.");
  }
  if (options.schoolId && !UUID_PATTERN.test(options.schoolId)) {
    throw new Error("--school-id must be a UUID.");
  }
  if (options.execute && options.explicitDryRun) {
    throw new Error("--execute and --dry-run are mutually exclusive.");
  }
  if (
    options.classModelAcknowledgement !== undefined &&
    options.classModelAcknowledgement !==
      PASSPILOT_CLEAN_CUTOVER_CLASS_MODEL_ACKNOWLEDGEMENT
  ) {
    throw new Error("The class-model acknowledgement is not exact.");
  }
  if (options.superAdminActorId && !UUID_PATTERN.test(options.superAdminActorId)) {
    throw new Error("--super-admin-actor-id must be a UUID.");
  }
  if (options.execute) {
    if (!options.superAdminActorId) {
      throw new Error("Execution requires --super-admin-actor-id.");
    }
    if (
      options.classModelAcknowledgement !==
      PASSPILOT_CLEAN_CUTOVER_CLASS_MODEL_ACKNOWLEDGEMENT
    ) {
      throw new Error("Execution requires the exact class-model acknowledgement.");
    }
  }
}

class CliFailure extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

function safeFailureCode(error: unknown): string {
  const code =
    error && typeof error === "object" && "code" in error
      ? (error as { code?: unknown }).code
      : undefined;
  return typeof code === "string" && /^[A-Z0-9_]{3,80}$/.test(code)
    ? code
    : "operation_failed";
}

function emit(value: unknown, error = false): void {
  const serialized = `${JSON.stringify(value)}\n`;
  if (error) process.stderr.write(serialized);
  else process.stdout.write(serialized);
}

export async function runPasspilotCleanCutoverCli(args: string[]): Promise<number> {
  let options: PasspilotCleanCutoverCliOptions;
  try {
    options = parsePasspilotCleanCutoverCliArgs(args);
    validatePasspilotCleanCutoverCliOptions(options);
  } catch {
    emit({ version: REPORT_VERSION, status: "failed", failureCode: "invalid_arguments" }, true);
    return 2;
  }

  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return 0;
  }

  let databaseModule: typeof import("../db.js") | undefined;
  try {
    const [storage, tenantContext, dbModule] = await Promise.all([
      import("../services/storage.js"),
      import("../middleware/tenantContext.js"),
      import("../db.js"),
    ]);
    databaseModule = dbModule;
    const report = await tenantContext.runWithTenantContext(
      { isSuper: true },
      async () => {
        if (options.execute) {
          const actor = await storage.getUserById(options.superAdminActorId!);
          if (!actor?.isSuperAdmin) {
            throw new CliFailure("super_admin_actor_required");
          }
        }

        const candidateIds = options.schoolId
          ? [options.schoolId]
          : await storage.listPasspilotLegacyClassSourceSchoolIds();
        const schools: SchoolReport[] = [];
        for (const schoolId of candidateIds) {
          const eligibility =
            await storage.getPasspilotCleanSchoolCutoverEligibility(schoolId);
          const schoolReport: SchoolReport = {
            schoolId,
            eligible: eligibility.eligible,
            reasons: eligibility.reasons,
            counts: eligibility.counts,
            outcome: options.execute
              ? eligibility.eligible
                ? "failed"
                : "ineligible"
              : "dry_run",
          };
          if (options.execute && eligibility.eligible) {
            try {
              await storage.completePasspilotClassMigration(
                schoolId,
                options.superAdminActorId!,
                eligibility.revision!,
                true,
                true
              );
              schoolReport.outcome = "executed";
            } catch (error) {
              const failureCode = safeFailureCode(error);
              schoolReport.failureCode = failureCode;
              schoolReport.outcome =
                failureCode === "PASSPILOT_CLEAN_CUTOVER_INELIGIBLE" ||
                failureCode === "PASSPILOT_CLASS_MIGRATION_CONFLICT"
                  ? "skipped_after_recheck"
                  : "failed";
            }
          }
          schools.push(schoolReport);
        }

        const summary = {
          candidates: schools.length,
          eligible: schools.filter((school) => school.eligible).length,
          executed: schools.filter((school) => school.outcome === "executed").length,
          ineligible: schools.filter((school) => school.outcome === "ineligible").length,
          skippedAfterRecheck: schools.filter(
            (school) => school.outcome === "skipped_after_recheck"
          ).length,
          failed: schools.filter((school) => school.outcome === "failed").length,
        };
        return {
          version: REPORT_VERSION,
          status:
            summary.failed > 0 || summary.skippedAfterRecheck > 0
              ? "failed"
              : options.execute && !!options.schoolId && summary.executed === 0
                ? "blocked"
                : "passed",
          mode: options.execute ? "execute" : "dry_run",
          scope: options.schoolId ? "school" : "all_clean_schools",
          summary,
          schools,
        };
      }
    );
    emit(report, report.status === "failed");
    if (report.status === "failed") return 1;
    if (report.status === "blocked") return 3;
    return 0;
  } catch (error) {
    emit(
      {
        version: REPORT_VERSION,
        status: "failed",
        failureCode:
          error instanceof CliFailure ? error.code : safeFailureCode(error),
      },
      true
    );
    return 1;
  } finally {
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
  void runPasspilotCleanCutoverCli(process.argv.slice(2)).then((exitCode) => {
    process.exitCode = exitCode;
  });
}
