import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  REVIEWED_RLS_TABLE_ENABLEMENTS,
  addReviewedRlsTable,
  verifyEnabledRlsCandidates,
  verifyLiveRlsEnablementSources,
} from "../scripts/enforce-deploy-rls-allowlist.mjs";

const targetTable = "classpilot_session_summary_deliveries";
const deploySource = readFileSync(new URL("../scripts/deploy.sh", import.meta.url), "utf8");
const migrationSource = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
const claudeSource = readFileSync(new URL("../CLAUDE.md", import.meta.url), "utf8");

function taskDefinition(
  containerName: "api" | "scheduler-worker",
  tables = ["students", "teaching_sessions"],
  gucEnabled = "true"
) {
  return {
    family: `test-${containerName}`,
    containerDefinitions: [
      {
        name: containerName,
        image: "example.invalid/app@sha256:test",
        environment: [
          { name: "UNCHANGED", value: "preserved" },
          { name: "RLS_GUC_ENABLED", value: gucEnabled },
          { name: "RLS_ENABLED_TABLES", value: tables.join(",") },
        ],
        secrets: [{ name: "DATABASE_URL", valueFrom: "parameter/database" }],
      },
    ],
  };
}

function environmentValue(definition: ReturnType<typeof taskDefinition>, name: string) {
  return definition.containerDefinitions[0].environment.find((entry) => entry.name === name)
    ?.value;
}

describe("one-release RLS table enablement", () => {
  it("adds only the reviewed table after matching live API/worker admission", () => {
    assert.deepEqual(REVIEWED_RLS_TABLE_ENABLEMENTS, [targetTable]);
    const api = taskDefinition("api");
    const worker = taskDefinition("scheduler-worker");
    assert.deepEqual(
      verifyLiveRlsEnablementSources({
        apiTaskDefinition: api,
        workerTaskDefinition: worker,
        table: targetTable,
      }),
      { previousTables: ["students", "teaching_sessions"], addedTable: targetTable }
    );

    const standardApi = structuredClone(api);
    const emergencyApi = structuredClone(api);
    const candidateWorker = structuredClone(worker);
    addReviewedRlsTable(standardApi, { containerName: "api", table: targetTable });
    addReviewedRlsTable(emergencyApi, { containerName: "api", table: targetTable });
    addReviewedRlsTable(candidateWorker, {
      containerName: "scheduler-worker",
      table: targetTable,
    });
    verifyEnabledRlsCandidates({
      taskDefinitions: [
        { taskDefinition: standardApi, containerName: "api" },
        { taskDefinition: emergencyApi, containerName: "api" },
        { taskDefinition: candidateWorker, containerName: "scheduler-worker" },
      ],
      table: targetTable,
      expectedPreviousTables: ["students", "teaching_sessions"],
    });

    for (const candidate of [standardApi, emergencyApi, candidateWorker]) {
      assert.equal(environmentValue(candidate, "RLS_GUC_ENABLED"), "true");
      assert.equal(environmentValue(candidate, "UNCHANGED"), "preserved");
      assert.equal(
        environmentValue(candidate, "RLS_ENABLED_TABLES"),
        `students,teaching_sessions,${targetTable}`
      );
      assert.deepEqual(candidate.containerDefinitions[0].secrets, [
        { name: "DATABASE_URL", valueFrom: "parameter/database" },
      ]);
    }
  });

  it("preserves both kill switches by rejecting unsafe or redundant activation", () => {
    assert.throws(
      () =>
        verifyLiveRlsEnablementSources({
          apiTaskDefinition: taskDefinition("api", undefined, "false"),
          workerTaskDefinition: taskDefinition("scheduler-worker"),
          table: targetTable,
        }),
      /requires RLS_GUC_ENABLED=true on both live services/
    );
    assert.throws(
      () =>
        verifyLiveRlsEnablementSources({
          apiTaskDefinition: taskDefinition("api"),
          workerTaskDefinition: taskDefinition("scheduler-worker", ["students"]),
          table: targetTable,
        }),
      /allowlists must match exactly/
    );
    assert.throws(
      () =>
        verifyLiveRlsEnablementSources({
          apiTaskDefinition: taskDefinition("api", ["students", targetTable]),
          workerTaskDefinition: taskDefinition("scheduler-worker", ["students", targetTable]),
          table: targetTable,
        }),
      /already enabled; omit the one-time/
    );
    assert.throws(
      () =>
        addReviewedRlsTable(taskDefinition("api"), {
          containerName: "api",
          table: "students",
        }),
      /not reviewed/
    );
    const unexpectedCandidate = taskDefinition("api", [
      "students",
      "teaching_sessions",
      "unexpected_table",
      targetTable,
    ]);
    assert.throws(
      () =>
        verifyEnabledRlsCandidates({
          taskDefinitions: [{ taskDefinition: unexpectedCandidate, containerName: "api" }],
          table: targetTable,
          expectedPreviousTables: ["students", "teaching_sessions"],
        }),
      /allowlists drifted/
    );
  });

  it("keeps ordinary deploys unchanged and gates the explicit flag before mutation", () => {
    assert.match(
      deploySource,
      /--enable-rls-table\)[\s\S]*ENABLE_RLS_TABLE="\$2"/
    );
    const validationStart = deploySource.indexOf("validate_rls_table_enablement_mode() {");
    const validationEnd = deploySource.indexOf(
      "validate_classpilot_tile_auth_plan_gate_mode()",
      validationStart
    );
    assert.ok(validationStart >= 0 && validationEnd > validationStart);
    const validation = deploySource.slice(validationStart, validationEnd);
    assert.match(validation, /classpilot_session_summary_deliveries/);
    assert.match(validation, /"\$ENV" != "production"/);
    assert.match(validation, /"\$DEPLOY_BACKEND" != true/);
    assert.match(validation, /"\$DEPLOY_FRONTEND" != false/);
    assert.match(
      deploySource,
      /resolve_classpilot_candidate_source_task_definitions[\s\S]*preflight_rls_table_enablement_sources[\s\S]*Building Docker image/
    );
    assert.match(
      deploySource,
      /if \[\[ -n "\$ENABLE_RLS_TABLE" \]\]; then[\s\S]*enforce-deploy-rls-allowlist\.mjs" add[\s\S]*\.taskdef-new\.json/
    );
    assert.match(
      deploySource,
      /register_classpilot_candidate_worker_task_definition[\s\S]*verify_registered_rls_table_enablement_candidates/
    );
    assert.match(
      deploySource,
      /REQUIRE_RLS_TABLE_ENFORCEMENT[\s\S]*--overrides "\$MIGRATION_OVERRIDES"/
    );
    assert.doesNotMatch(deploySource, /RLS_ALLOWLIST_MIGRATION_VERSION/);
  });

  it("makes the migration task prove the table, FORCE RLS, and tenant policy", () => {
    const assertionStart = migrationSource.indexOf(
      "const requiredRlsTable = process.env.REQUIRE_RLS_TABLE_ENFORCEMENT"
    );
    const assertionEnd = migrationSource.indexOf(
      "// Add gopilot_role column",
      assertionStart
    );
    assert.ok(assertionStart >= 0 && assertionEnd > assertionStart);
    const assertion = migrationSource.slice(assertionStart, assertionEnd);
    assert.match(assertion, /classpilot_session_summary_deliveries/);
    assert.match(assertion, /RLS_GUC_ENABLED !== "true"/);
    assert.match(assertion, /parseRlsEnabledTables\(\)\.has\(requiredRlsTable\)/);
    assert.match(assertion, /relation\.relrowsecurity/);
    assert.match(assertion, /relation\.relforcerowsecurity/);
    assert.match(assertion, /policy\.polname = 'tenant_isolation'/);
    assert.match(assertion, /throw new Error/);
  });

  it("documents the one-shot command and later kill-switch preservation", () => {
    assert.match(
      claudeSource,
      /--enable-rls-table classpilot_session_summary_deliveries/
    );
    assert.match(claudeSource, /Omit the flag on later deploys/);
    assert.match(claudeSource, /per-table kill-switch removal then remains removed/);
  });
});
