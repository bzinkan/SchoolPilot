import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { parseClasspilotPinMigrationCliArgs } from "../src/cli/migrateClasspilotPinEncryption.ts";
import {
  assertPrivateMigrationReportPath,
  writePrivateMigrationReport,
  type CountsOnlyMigrationReport,
} from "../src/util/privateMigrationReport.ts";

const temporaryDirectories: string[] = [];

function temporaryRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "schoolpilot-pin-rotation-"));
  temporaryDirectories.push(root);
  return root;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("ClassPilot PIN migration CLI safety", () => {
  it("parses only explicit execute, bounded batch, and report options", () => {
    const reportPath = path.join(temporaryRoot(), "report.json");
    assert.deepEqual(
      parseClasspilotPinMigrationCliArgs([
        "--execute",
        "--batch-size",
        "250",
        "--report-path",
        reportPath,
      ]),
      { execute: true, help: false, batchSize: 250, reportPath }
    );
    assert.throws(
      () => parseClasspilotPinMigrationCliArgs(["--unknown", "secret-sentinel"]),
      /^Error: Unknown migration CLI argument\.$/
    );
  });

  it("rejects report paths inside the repository or outside the private root", () => {
    const root = temporaryRoot();
    const reportRoot = path.join(root, "private");
    assert.throws(
      () =>
        assertPrivateMigrationReportPath({
          reportPath: path.join(process.cwd(), "migration-report.json"),
          repositoryRoot: process.cwd(),
          reportRoot,
        }),
      /outside the repository/
    );
    assert.throws(
      () =>
        assertPrivateMigrationReportPath({
          reportPath: path.join(root, "elsewhere", "migration-report.json"),
          repositoryRoot: process.cwd(),
          reportRoot,
        }),
      /private report root/
    );
  });

  it("atomically writes an ACL-restricted counts-only report and strips extra fields", () => {
    const root = temporaryRoot();
    const reportRoot = path.join(root, "private");
    const reportPath = path.join(reportRoot, "pin-migration.json");
    const report = {
      status: "passed",
      counts: { examined: 4, migrated: 4, failed: 0 },
      secretSentinel: "must-not-be-written",
    } as CountsOnlyMigrationReport & { secretSentinel: string };

    writePrivateMigrationReport({
      reportPath,
      repositoryRoot: process.cwd(),
      reportRoot,
      report,
    });
    writePrivateMigrationReport({
      reportPath,
      repositoryRoot: process.cwd(),
      reportRoot,
      report: { status: "passed", counts: { examined: 4, migrated: 0, failed: 0 } },
    });

    const serialized = fs.readFileSync(reportPath, "utf8");
    assert.doesNotMatch(serialized, /must-not-be-written|secretSentinel/);
    assert.deepEqual(JSON.parse(serialized), {
      status: "passed",
      counts: { examined: 4, migrated: 0, failed: 0 },
    });
    if (process.platform !== "win32") {
      assert.equal(fs.statSync(reportPath).mode & 0o777, 0o600);
    }
  });

  it("refuses non-count report fields before creating an artifact", () => {
    const root = temporaryRoot();
    const reportRoot = path.join(root, "private");
    const reportPath = path.join(reportRoot, "invalid.json");
    assert.throws(
      () =>
        writePrivateMigrationReport({
          reportPath,
          repositoryRoot: process.cwd(),
          reportRoot,
          report: {
            status: "failed",
            counts: { examined: 1.5 },
            failureCode: "operation_failed",
          },
        }),
      /invalid count/
    );
    assert.equal(fs.existsSync(reportPath), false);
  });
});
