import path from "path";
import { fileURLToPath, pathToFileURL } from "url";
import {
  createSecretCipher,
  ENCRYPTION_KEY_ENV,
  PREVIOUS_ENCRYPTION_KEY_ENV,
} from "../services/crypto.js";
import {
  assertPrivateMigrationReportPath,
  writePrivateMigrationReport,
  type CountsOnlyMigrationReport,
} from "../util/privateMigrationReport.js";
import type { ClasspilotPinMigrationCounts } from "../services/classpilotPinEncryptionMigration.js";

const REPOSITORY_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../.."
);

type CliOptions = {
  execute: boolean;
  help: boolean;
  batchSize?: number;
  reportPath?: string;
};

function usage(): string {
  return [
    "Usage: node dist/cli/migrateClasspilotPinEncryption.js --execute [options]",
    "",
    "Options:",
    "  --batch-size <1-1000>  Number of encrypted PIN rows read per tenant batch.",
    "  --report-path <path>   Optional ACL-restricted counts-only JSON report.",
    "  --help                 Show this help without connecting to the database.",
    "",
    `Requires ${ENCRYPTION_KEY_ENV} (current) and ${PREVIOUS_ENCRYPTION_KEY_ENV} (previous).`,
    "The current and previous keys must be distinct. No plaintext, ciphertext, tenant,",
    "student, or secret values are written to output.",
  ].join("\n");
}

export function parseClasspilotPinMigrationCliArgs(args: string[]): CliOptions {
  const options: CliOptions = { execute: false, help: false };
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
    if (argument === "--batch-size") {
      const value = args[index + 1];
      if (!value) throw new Error("--batch-size requires a value.");
      options.batchSize = Number(value);
      index += 1;
      continue;
    }
    if (argument === "--report-path") {
      const value = args[index + 1];
      if (!value) throw new Error("--report-path requires a value.");
      options.reportPath = value;
      index += 1;
      continue;
    }
    throw new Error("Unknown migration CLI argument.");
  }
  return options;
}

function zeroCounts(): ClasspilotPinMigrationCounts {
  return {
    schoolsTotal: 0,
    schoolsVisited: 0,
    batches: 0,
    examined: 0,
    migrated: 0,
    alreadyCurrent: 0,
    failed: 1,
    conflicted: 0,
  };
}

function emit(report: CountsOnlyMigrationReport, error = false): void {
  const serialized = `${JSON.stringify(report)}\n`;
  if (error) process.stderr.write(serialized);
  else process.stdout.write(serialized);
}

function persistReport(
  reportPath: string | undefined,
  report: CountsOnlyMigrationReport
): void {
  if (!reportPath) return;
  writePrivateMigrationReport({
    reportPath,
    repositoryRoot: REPOSITORY_ROOT,
    report,
  });
}

export async function runClasspilotPinMigrationCli(args: string[]): Promise<number> {
  let options: CliOptions;
  try {
    options = parseClasspilotPinMigrationCliArgs(args);
  } catch {
    emit({ status: "failed", counts: zeroCounts(), failureCode: "invalid_arguments" }, true);
    return 2;
  }

  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return 0;
  }
  if (!options.execute) {
    emit({ status: "failed", counts: zeroCounts(), failureCode: "execute_required" }, true);
    return 2;
  }

  if (options.reportPath) {
    try {
      assertPrivateMigrationReportPath({
        reportPath: options.reportPath,
        repositoryRoot: REPOSITORY_ROOT,
      });
    } catch {
      emit({ status: "failed", counts: zeroCounts(), failureCode: "invalid_report_path" }, true);
      return 2;
    }
  }

  let databaseModule: typeof import("../db.js") | undefined;
  try {
    const migrationModule = await import(
      "../services/classpilotPinEncryptionMigration.js"
    );
    const storeModule = await import(
      "../services/classpilotPinEncryptionMigrationStore.js"
    );
    databaseModule = await import("../db.js");
    const cipher = createSecretCipher({
      currentKey: process.env[ENCRYPTION_KEY_ENV],
      previousKey: process.env[PREVIOUS_ENCRYPTION_KEY_ENV],
      production: true,
    });
    const counts = await migrationModule.migrateClasspilotPinEncryption({
      cipher,
      store: storeModule.createDatabaseClasspilotPinMigrationStore(),
      batchSize: options.batchSize,
    });
    const report: CountsOnlyMigrationReport = { status: "passed", counts };

    try {
      persistReport(options.reportPath, report);
    } catch {
      const failedReport: CountsOnlyMigrationReport = {
        status: "failed",
        counts: { ...counts, failed: counts.failed + 1 },
        failureCode: "report_write_failed",
      };
      emit(failedReport, true);
      return 1;
    }

    emit(report);
    return 0;
  } catch (error) {
    const migrationModule = await import(
      "../services/classpilotPinEncryptionMigration.js"
    ).catch(() => undefined);
    const isMigrationFailure =
      migrationModule &&
      error instanceof migrationModule.ClasspilotPinMigrationFailure;
    const report: CountsOnlyMigrationReport = {
      status: "failed",
      counts: isMigrationFailure ? error.counts : zeroCounts(),
      failureCode: isMigrationFailure ? error.code : "operation_failed",
    };
    try {
      persistReport(options.reportPath, report);
    } catch {
      // The stderr record remains counts-only even if the private report fails.
    }
    emit(report, true);
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
  void runClasspilotPinMigrationCli(process.argv.slice(2)).then((exitCode) => {
    process.exitCode = exitCode;
  });
}
