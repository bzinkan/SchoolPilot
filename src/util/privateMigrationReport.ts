import fs from "fs";
import os from "os";
import path from "path";
import { randomBytes } from "crypto";
import { spawnSync } from "child_process";

export type CountsOnlyMigrationReport = {
  status: "passed" | "failed";
  counts: Record<string, number>;
  failureCode?: string;
};

function normalizeComparablePath(value: string): string {
  const normalized = path.resolve(value);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function isPathInside(candidate: string, parent: string): boolean {
  const relative = path.relative(
    normalizeComparablePath(parent),
    normalizeComparablePath(candidate)
  );
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function prospectiveRealPath(value: string): string {
  let cursor = path.resolve(value);
  const suffix: string[] = [];
  while (!fs.existsSync(cursor)) {
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    suffix.unshift(path.basename(cursor));
    cursor = parent;
  }
  return path.join(fs.realpathSync(cursor), ...suffix);
}

export function configuredCredentialRotationReportRoot(): string {
  const configured = process.env.SCHOOLPILOT_ROTATION_REPORT_ROOT?.trim();
  if (configured) return path.resolve(configured);
  if (process.platform === "win32") {
    const localAppData = process.env.LOCALAPPDATA?.trim();
    if (!localAppData) {
      throw new Error("LOCALAPPDATA is required for private migration reports.");
    }
    return path.join(localAppData, "SchoolPilot", "credential-rotation");
  }
  return path.join(os.tmpdir(), "schoolpilot-credential-rotation");
}

export function assertPrivateMigrationReportPath(options: {
  reportPath: string;
  repositoryRoot: string;
  reportRoot?: string;
}): { reportPath: string; reportRoot: string } {
  if (!path.isAbsolute(options.reportPath) || path.extname(options.reportPath) !== ".json") {
    throw new Error("Migration report path must be an absolute JSON path.");
  }

  const repositoryRoot = fs.realpathSync(options.repositoryRoot);
  const reportRoot = prospectiveRealPath(
    options.reportRoot ?? configuredCredentialRotationReportRoot()
  );
  const reportPath = prospectiveRealPath(options.reportPath);

  if (isPathInside(reportRoot, repositoryRoot) || isPathInside(reportPath, repositoryRoot)) {
    throw new Error("Migration reports must stay outside the repository.");
  }
  if (!isPathInside(reportPath, reportRoot)) {
    throw new Error("Migration report path must stay under the private report root.");
  }

  return { reportPath, reportRoot };
}

function currentWindowsIdentity(): string {
  const result = spawnSync("whoami", [], { encoding: "utf8", windowsHide: true });
  if (result.status !== 0 || !result.stdout.trim()) {
    throw new Error("Could not determine the Windows identity for report ACLs.");
  }
  return result.stdout.trim();
}

function restrictAcl(target: string, directory: boolean): void {
  if (process.platform === "win32") {
    const grant = `${currentWindowsIdentity()}:${directory ? "(OI)(CI)F" : "F"}`;
    const result = spawnSync(
      "icacls",
      [target, "/inheritance:r", "/grant:r", grant],
      { encoding: "utf8", windowsHide: true }
    );
    if (result.status !== 0) {
      throw new Error("Could not apply a private Windows ACL to the migration report.");
    }
    return;
  }
  fs.chmodSync(target, directory ? 0o700 : 0o600);
}

function countsOnly(report: CountsOnlyMigrationReport): CountsOnlyMigrationReport {
  const counts = Object.fromEntries(
    Object.entries(report.counts).map(([name, value]) => {
      if (!/^[a-z][A-Za-z0-9]*$/.test(name) || !Number.isSafeInteger(value) || value < 0) {
        throw new Error("Migration report contains an invalid count.");
      }
      return [name, value];
    })
  );
  const sanitized: CountsOnlyMigrationReport = { status: report.status, counts };
  if (report.failureCode) {
    if (!/^[a-z_]{1,64}$/.test(report.failureCode)) {
      throw new Error("Migration report contains an invalid failure code.");
    }
    sanitized.failureCode = report.failureCode;
  }
  return sanitized;
}

export function writePrivateMigrationReport(options: {
  reportPath: string;
  repositoryRoot: string;
  report: CountsOnlyMigrationReport;
  reportRoot?: string;
}): string {
  const resolved = assertPrivateMigrationReportPath(options);
  const parent = path.dirname(resolved.reportPath);
  fs.mkdirSync(resolved.reportRoot, { recursive: true, mode: 0o700 });
  restrictAcl(fs.realpathSync(resolved.reportRoot), true);
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  restrictAcl(fs.realpathSync(parent), true);

  const temporary = path.join(
    parent,
    `.${path.basename(resolved.reportPath)}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`
  );
  const payload = `${JSON.stringify(countsOnly(options.report), null, 2)}\n`;
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(temporary, "wx", 0o600);
    fs.writeFileSync(descriptor, payload, "utf8");
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    restrictAcl(temporary, false);
    fs.renameSync(temporary, resolved.reportPath);
    restrictAcl(resolved.reportPath, false);
    return resolved.reportPath;
  } catch {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    try {
      fs.rmSync(temporary, { force: true });
    } catch {
      // Best-effort cleanup; never include filesystem details in the error.
    }
    throw new Error("Could not atomically write the private migration report.");
  }
}
