import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  CLASSPILOT_FAB_RLS_TABLES,
  CLASSPILOT_SCHEDULE_CHANGE_RLS_TABLES,
  GOPILOT_CHILD_RLS_TABLES,
  REVIEWED_RLS_TABLE_ENABLEMENTS,
  addReviewedRlsTable,
  verifyEnabledRlsCandidates,
  verifyLiveRlsEnablementSources,
} from "../scripts/enforce-deploy-rls-allowlist.mjs";

const targetTable = "passpilot_grade_students";
const deploySource = readFileSync(new URL("../scripts/deploy.sh", import.meta.url), "utf8");
const migrationSource = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
const claudeSource = readFileSync(new URL("../CLAUDE.md", import.meta.url), "utf8");
const terraformVariables = readFileSync(new URL("../infra/variables.tf", import.meta.url), "utf8");
const productionTfvars = readFileSync(new URL("../infra/production.tfvars", import.meta.url), "utf8");

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
    assert.deepEqual(REVIEWED_RLS_TABLE_ENABLEMENTS, [
      "classpilot_session_summary_deliveries",
      "classpilot_monitoring_events",
      "classpilot_session_reports",
      "classpilot_session_staff",
      "classpilot_session_student_reports",
      "classpilot_student_control_states",
      ...CLASSPILOT_FAB_RLS_TABLES,
      targetTable,
      ...GOPILOT_CHILD_RLS_TABLES,
      ...CLASSPILOT_SCHEDULE_CHANGE_RLS_TABLES,
    ]);
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

  it("adds the exact reviewed GoPilot child-table bundle atomically", () => {
    const api = taskDefinition("api");
    const worker = taskDefinition("scheduler-worker");
    const bundle = GOPILOT_CHILD_RLS_TABLES.join(",");
    assert.deepEqual(
      verifyLiveRlsEnablementSources({
        apiTaskDefinition: api,
        workerTaskDefinition: worker,
        table: bundle,
      }),
      { previousTables: ["students", "teaching_sessions"], addedTables: GOPILOT_CHILD_RLS_TABLES }
    );
    for (const definition of [api, worker]) {
      addReviewedRlsTable(definition, {
        containerName: definition.containerDefinitions[0].name as "api" | "scheduler-worker",
        table: bundle,
      });
      assert.equal(
        environmentValue(definition, "RLS_ENABLED_TABLES"),
        `students,teaching_sessions,${bundle}`
      );
    }
    verifyEnabledRlsCandidates({
      taskDefinitions: [
        { taskDefinition: api, containerName: "api" },
        { taskDefinition: worker, containerName: "scheduler-worker" },
      ],
      table: bundle,
      expectedPreviousTables: ["students", "teaching_sessions"],
    });
  });

  it("adds the exact reviewed ClassPilot schedule-change bundle atomically", () => {
    const api = taskDefinition("api");
    const worker = taskDefinition("scheduler-worker");
    const bundle = CLASSPILOT_SCHEDULE_CHANGE_RLS_TABLES.join(",");
    assert.deepEqual(
      verifyLiveRlsEnablementSources({
        apiTaskDefinition: api,
        workerTaskDefinition: worker,
        table: bundle,
      }),
      {
        previousTables: ["students", "teaching_sessions"],
        addedTables: CLASSPILOT_SCHEDULE_CHANGE_RLS_TABLES,
      }
    );
    for (const definition of [api, worker]) {
      addReviewedRlsTable(definition, {
        containerName: definition.containerDefinitions[0].name as "api" | "scheduler-worker",
        table: bundle,
      });
      assert.equal(
        environmentValue(definition, "RLS_ENABLED_TABLES"),
        `students,teaching_sessions,${bundle}`
      );
    }
    verifyEnabledRlsCandidates({
      taskDefinitions: [
        { taskDefinition: api, containerName: "api" },
        { taskDefinition: worker, containerName: "scheduler-worker" },
      ],
      table: bundle,
      expectedPreviousTables: ["students", "teaching_sessions"],
    });
    for (const invalid of [
      CLASSPILOT_SCHEDULE_CHANGE_RLS_TABLES[0],
      CLASSPILOT_SCHEDULE_CHANGE_RLS_TABLES.slice(0, 2).join(","),
      [...CLASSPILOT_SCHEDULE_CHANGE_RLS_TABLES].reverse().join(","),
    ]) {
      assert.throws(
        () =>
          verifyLiveRlsEnablementSources({
            apiTaskDefinition: taskDefinition("api"),
            workerTaskDefinition: taskDefinition("scheduler-worker"),
            table: invalid,
          }),
        /must match one exact reviewed singleton or ordered bundle/
      );
    }
  });

  it("adds the exact reviewed ClassPilot FAB state bundle atomically", () => {
    const api = taskDefinition("api");
    const worker = taskDefinition("scheduler-worker");
    const bundle = CLASSPILOT_FAB_RLS_TABLES.join(",");
    assert.deepEqual(
      verifyLiveRlsEnablementSources({
        apiTaskDefinition: api,
        workerTaskDefinition: worker,
        table: bundle,
      }),
      {
        previousTables: ["students", "teaching_sessions"],
        addedTables: CLASSPILOT_FAB_RLS_TABLES,
      }
    );
    for (const definition of [api, worker]) {
      addReviewedRlsTable(definition, {
        containerName: definition.containerDefinitions[0].name as "api" | "scheduler-worker",
        table: bundle,
      });
      assert.equal(
        environmentValue(definition, "RLS_ENABLED_TABLES"),
        `students,teaching_sessions,${bundle}`
      );
    }
    verifyEnabledRlsCandidates({
      taskDefinitions: [
        { taskDefinition: api, containerName: "api" },
        { taskDefinition: worker, containerName: "scheduler-worker" },
      ],
      table: bundle,
      expectedPreviousTables: ["students", "teaching_sessions"],
    });
    for (const invalid of [
      CLASSPILOT_FAB_RLS_TABLES[0],
      CLASSPILOT_FAB_RLS_TABLES.slice(0, 3).join(","),
      [...CLASSPILOT_FAB_RLS_TABLES].reverse().join(","),
    ]) {
      assert.throws(
        () => verifyLiveRlsEnablementSources({
          apiTaskDefinition: taskDefinition("api"),
          workerTaskDefinition: taskDefinition("scheduler-worker"),
          table: invalid,
        }),
        /must match one exact reviewed singleton or ordered bundle/
      );
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
    assert.match(validation, /passpilot_grade_students/);
    assert.match(validation, /authorized_pickups,custody_alerts,dismissal_changes,dismissal_overrides,dismissal_queue,family_group_students,homeroom_teachers/);
    assert.match(validation, /classpilot_schedule_change_pairs,classpilot_schedule_changes,classpilot_schedule_change_legs/);
    assert.match(validation, /classpilot_chat_deliveries,poll_responses,polls,session_settings/);
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
      "const requiredRlsTables = (process.env.REQUIRE_RLS_TABLE_ENFORCEMENT"
    );
    const assertionEnd = migrationSource.indexOf(
      "// Drop legacy substitute_assignments table",
      assertionStart
    );
    assert.ok(assertionStart >= 0 && assertionEnd > assertionStart);
    const assertion = migrationSource.slice(assertionStart, assertionEnd);
    assert.match(assertion, /classpilot_session_summary_deliveries/);
    assert.match(assertion, /passpilot_grade_students/);
    for (const table of GOPILOT_CHILD_RLS_TABLES) assert.match(assertion, new RegExp(table));
    for (const table of CLASSPILOT_SCHEDULE_CHANGE_RLS_TABLES) {
      assert.match(assertion, new RegExp(table));
    }
    for (const table of CLASSPILOT_FAB_RLS_TABLES) assert.match(assertion, new RegExp(table));
    assert.match(assertion, /RLS_GUC_ENABLED !== "true"/);
    assert.match(assertion, /enabledRlsTables\.has\(table\)/);
    assert.match(assertion, /relation\.relrowsecurity/);
    assert.match(assertion, /relation\.relforcerowsecurity/);
    assert.match(assertion, /policy\.polname = 'tenant_isolation'/);
    assert.match(assertion, /throw new Error/);
  });

  it("documents the one-shot command and later kill-switch preservation", () => {
    assert.match(
      claudeSource,
      /--enable-rls-table passpilot_grade_students/
    );
    assert.match(
      claudeSource,
      /--enable-rls-table authorized_pickups,custody_alerts,dismissal_changes,dismissal_overrides,dismissal_queue,family_group_students,homeroom_teachers/
    );
    assert.match(
      claudeSource,
      /--enable-rls-table classpilot_schedule_change_pairs,classpilot_schedule_changes,classpilot_schedule_change_legs/
    );
    assert.match(
      claudeSource,
      /--enable-rls-table classpilot_chat_deliveries,poll_responses,polls,session_settings/
    );
    assert.match(claudeSource, /Omit the flag on later deploys/);
    assert.match(claudeSource, /per-table kill-switch removal then remains removed/);
    const defaultAllowlist = terraformVariables.match(
      /variable "rls_enabled_tables"[\s\S]*?default\s*=\s*"([^"]+)"/
    )?.[1] ?? "";
    for (const table of GOPILOT_CHILD_RLS_TABLES) {
      assert.equal(
        defaultAllowlist.split(",").includes(table),
        false,
        `${table} must enter production only through the reviewed one-shot rollout`
      );
    }
    for (const table of CLASSPILOT_SCHEDULE_CHANGE_RLS_TABLES) {
      assert.equal(
        defaultAllowlist.split(",").includes(table),
        false,
        `${table} must enter production only through the reviewed one-shot rollout`
      );
    }
    const productionAllowlist = productionTfvars.match(
      /^rls_enabled_tables\s*=\s*"([^"]+)"/m
    )?.[1] ?? "";
    for (const table of CLASSPILOT_SCHEDULE_CHANGE_RLS_TABLES) {
      assert.equal(
        productionAllowlist.split(",").includes(table),
        true,
        `${table} must remain in production.tfvars after verified live baseline adoption`
      );
    }
    for (const table of CLASSPILOT_FAB_RLS_TABLES) {
      assert.equal(defaultAllowlist.split(",").includes(table), false);
      assert.equal(productionAllowlist.split(",").includes(table), false);
    }
    assert.match(claudeSource, /separate baseline-adoption change/);
  });
});
