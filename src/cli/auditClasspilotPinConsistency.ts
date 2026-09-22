import path from "path";
import { fileURLToPath, pathToFileURL } from "url";
import {
  assertPrivateMigrationReportPath,
  writePrivateMigrationReport,
  type CountsOnlyMigrationReport,
} from "../util/privateMigrationReport.js";
import {
  zeroClasspilotPinAuditCounts,
  type ClasspilotPinAuditCounts,
} from "../services/classpilotPinConsistencyAudit.js";

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
    "Usage: node dist/cli/auditClasspilotPinConsistency.js [options]",
    "",
    "Reports, per tenant batch, how many active students hold a bcrypt PIN hash,",
    "an encrypted PIN, both, or both in disagreement. Report mode changes nothing.",
    "",
    "Options:",
    "  --execute              Re-derive the bcrypt hash from the encrypted PIN for",
    "                         disagreeing rows (the admin-visible PIN wins).",
    "  --batch-size <1-1000>  Number of student rows read per tenant batch.",
    "  --report-path <path>   Optional ACL-restricted counts-only JSON report.",
    "  --help                 Show this help without connecting to the database.",
    "",
    "No plaintext, ciphertext, hash, tenant, or student values are written to output.",
  ].join("\n");
}

export function parseClasspilotPinAuditCliArgs(args: string[]): CliOptions {
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
    throw new Error("Unknown audit CLI argument.");
  }
  return options;
}

function failedCounts(): ClasspilotPinAuditCounts {
  return { ...zeroClasspilotPinAuditCounts(), failed: 1 };
}

function emit(report: CountsOnlyMigrationReport, error = false): void {
  const serialized = `${JSON.stringify(report)}\n`;
  if (error) process.stderr.write(serialized);
  else process.stdout.write(serialized);
}

function persistReport(reportPath: string | undefined, report: CountsOnlyMigrationReport): void {
  if (!reportPath) return;
  writePrivateMigrationReport({ reportPath, repositoryRoot: REPOSITORY_ROOT, report });
}

export async function runClasspilotPinAuditCli(args: string[]): Promise<number> {
  let options: CliOptions;
  try {
    options = parseClasspilotPinAuditCliArgs(args);
  } catch {
    emit({ status: "failed", counts: failedCounts(), failureCode: "invalid_arguments" }, true);
    return 2;
  }

  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return 0;
  }

  if (options.reportPath) {
    try {
      assertPrivateMigrationReportPath({ reportPath: options.reportPath, repositoryRoot: REPOSITORY_ROOT });
    } catch {
      emit({ status: "failed", counts: failedCounts(), failureCode: "invalid_report_path" }, true);
      return 2;
    }
  }

  let databaseModule: typeof import("../db.js") | undefined;
  try {
    const auditModule = await import("../services/classpilotPinConsistencyAudit.js");
    const storeModule = await import("../services/classpilotPinConsistencyAuditStore.js");
    const pinsModule = await import("../services/classpilotPins.js");
    const passwordModule = await import("../util/password.js");
    databaseModule = await import("../db.js");
    const counts = await auditModule.auditClasspilotPinConsistency({
      store: storeModule.createDatabaseClasspilotPinAuditStore(),
      decryptPin: pinsModule.decryptClassPilotPin,
      hashPin: pinsModule.hashClassPilotPin,
      comparePin: passwordModule.comparePassword,
      execute: options.execute,
      batchSize: options.batchSize,
    });
    const report: CountsOnlyMigrationReport = { status: "passed", counts };
    try {
      persistReport(options.reportPath, report);
    } catch {
      emit({
        status: "failed",
        counts: { ...counts, failed: counts.failed + 1 },
        failureCode: "report_write_failed",
      }, true);
      return 1;
    }
    emit(report);
    return 0;
  } catch (error) {
    const auditModule = await import("../services/classpilotPinConsistencyAudit.js").catch(() => undefined);
    const isAuditFailure = auditModule && error instanceof auditModule.ClasspilotPinAuditFailure;
    const report: CountsOnlyMigrationReport = {
      status: "failed",
      counts: isAuditFailure ? error.counts : failedCounts(),
      failureCode: isAuditFailure ? error.code : "operation_failed",
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
      await Promise.allSettled([databaseModule.pool.end(), databaseModule.sessionPool.end()]);
    }
  }
}

const invokedPath = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href
  : "";
if (invokedPath === import.meta.url) {
  runClasspilotPinAuditCli(process.argv.slice(2)).then(
    (code) => { process.exitCode = code; },
    () => { process.exitCode = 1; }
  );
}
