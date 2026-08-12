import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  PASSPILOT_CLEAN_CUTOVER_CLASS_MODEL_ACKNOWLEDGEMENT,
  parsePasspilotCleanCutoverCliArgs,
  validatePasspilotCleanCutoverCliOptions,
} from "../src/cli/cutoverPasspilotCleanSchools.js";

const SCHOOL_ID = "10000000-0000-4000-8000-000000000001";
const ACTOR_ID = "20000000-0000-4000-8000-000000000002";

describe("PassPilot guarded clean-school cutover CLI", () => {
  it("is dry-run by default and requires one explicit target scope", () => {
    const options = parsePasspilotCleanCutoverCliArgs([
      "--school-id",
      SCHOOL_ID,
    ]);
    validatePasspilotCleanCutoverCliOptions(options);
    assert.equal(options.execute, false);
    assert.equal(options.schoolId, SCHOOL_ID);
    assert.equal(options.allCleanSchools, false);

    assert.throws(() =>
      validatePasspilotCleanCutoverCliOptions(
        parsePasspilotCleanCutoverCliArgs([])
      )
    );
    assert.throws(() =>
      validatePasspilotCleanCutoverCliOptions(
        parsePasspilotCleanCutoverCliArgs([
          "--school-id",
          SCHOOL_ID,
          "--all-clean-schools",
        ])
      )
    );
  });

  it("requires an exact class-model acknowledgement and super-admin actor for execution", () => {
    const valid = parsePasspilotCleanCutoverCliArgs([
      "--all-clean-schools",
      "--execute",
      "--super-admin-actor-id",
      ACTOR_ID,
      "--acknowledge-class-model",
      PASSPILOT_CLEAN_CUTOVER_CLASS_MODEL_ACKNOWLEDGEMENT,
    ]);
    validatePasspilotCleanCutoverCliOptions(valid);

    for (const args of [
      ["--all-clean-schools", "--execute"],
      [
        "--all-clean-schools",
        "--execute",
        "--super-admin-actor-id",
        ACTOR_ID,
      ],
      [
        "--all-clean-schools",
        "--execute",
        "--super-admin-actor-id",
        ACTOR_ID,
        "--acknowledge-class-model",
        "legacy-grades-v1",
      ],
      [
        "--all-clean-schools",
        "--execute",
        "--dry-run",
        "--super-admin-actor-id",
        ACTOR_ID,
        "--acknowledge-class-model",
        PASSPILOT_CLEAN_CUTOVER_CLASS_MODEL_ACKNOWLEDGEMENT,
      ],
    ]) {
      assert.throws(() =>
        validatePasspilotCleanCutoverCliOptions(
          parsePasspilotCleanCutoverCliArgs(args)
        )
      );
    }
  });

  it("keeps one locked clean predicate and no automatic invocation path", () => {
    const storage = readFileSync("src/services/storage.ts", "utf8");
    const cli = readFileSync(
      "src/cli/cutoverPasspilotCleanSchools.ts",
      "utf8"
    );
    const packageJson = readFileSync("package.json", "utf8");
    const runbook = readFileSync("CLAUDE.md", "utf8");
    const startupAndReads = [
      "src/index.ts",
      "src/routes/passpilot/classes.ts",
      "src/services/passpilotClasses.ts",
    ]
      .map((file) => readFileSync(file, "utf8"))
      .join("\n");

    assert.match(storage, /loadPasspilotCleanSchoolCutoverEligibility/);
    assert.match(
      storage,
      /completePasspilotClassMigration\([\s\S]*requireClean = false[\s\S]*if \(requireClean\)[\s\S]*loadPasspilotCleanSchoolCutoverEligibility/
    );
    assert.match(
      storage,
      /\.from\(passes\)[\s\S]*\.where\(eq\(passes\.schoolId, schoolId\)\)[\s\S]*passes: passRows\.length/
    );
    assert.match(storage, /active_official_class_required/);
    assert.match(storage, /prior_canonical_write_present/);
    assert.match(cli, /--all-clean-schools/);
    assert.match(cli, /super_admin_actor_required/);
    assert.match(cli, /completePasspilotClassMigration\([\s\S]*true,\s*true/);
    assert.match(packageJson, /"migrate:passpilot-clean-schools"/);
    assert.match(runbook, /#### Guarded clean-school cutover runbook/);
    assert.match(runbook, /dry-run is always the default/i);
    assert.doesNotMatch(
      startupAndReads,
      /getPasspilotCleanSchoolCutoverEligibility|listPasspilotLegacyClassSourceSchoolIds/
    );
  });
});
