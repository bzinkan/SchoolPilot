import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const runbook = readFileSync(
  new URL("../docs/AWS_COST_ROLLOUT_OPERATIONS.md", import.meta.url),
  "utf8"
).replace(/\r\n/g, "\n");
const ciWorkflow = readFileSync(
  new URL("../.github/workflows/ci-build.yml", import.meta.url),
  "utf8"
).replace(/\r\n/g, "\n");

describe("ClassPilot tile authorization readiness governance", () => {
  it("keeps the v2 evidence, one-attempt receipt, and database regressions in CI", () => {
    const backendTests = [
      "tests/classpilot-tile-auth-plan-base-funnel-evidence.test.ts",
      "tests/classpilot-tile-auth-plan-evidence-validator.test.ts",
      "tests/classpilot-tile-auth-plan-lifecycle-cli.test.ts",
      "tests/deploy-classpilot-tile-auth-plan-gate.test.ts",
      "tests/classpilot-tile-auth-plan-observation.test.ts",
      "tests/classpilot-tile-auth-plan-rehearsal-receipt.test.ts",
      "tests/classpilot-tile-auth-plan-readiness-governance.test.ts",
    ];
    for (const testPath of backendTests) {
      assert.ok(
        ciWorkflow.includes(testPath),
        `CI is missing the release-gate regression: ${testPath}`
      );
    }
    assert.ok(
      ciWorkflow.includes(
        "tests/classpilot-tile-authorization-plan-self-provisioning.integration.test.ts"
      ),
      "CI is missing the RLS-enabled transactional scenario integration suite"
    );
    assert.ok(
      ciWorkflow.indexOf(
        "tests/classpilot-tile-auth-plan-evidence-validator.test.ts"
      ) <
        ciWorkflow.indexOf(
          "tests/deploy-classpilot-tile-auth-plan-gate.test.ts"
        ),
      "CI must validate the v2 evidence contract before deploy orchestration"
    );
  });

  it("requires freshness-independent v2 transactional evidence", () => {
    for (const required of [
      "`transactional-plan-scenarios-v2`",
      "`requiredSessionPairs` is 80",
      "reused plus inserted is 80",
      "`studentSessions` equals the inserted count",
      "`total` equals 43 plus that count",
      "`classpilot-tile-auth-plan-base-preflight-v1`",
      "reused plus missing equal to 80",
      "Do not run a\nproduction fixture refresh before this gate.",
    ]) {
      assert.ok(
        runbook.includes(required),
        `runbook is missing the readiness invariant: ${required}`
      );
    }

    assert.match(
      runbook,
      /The gate must not depend on an ambient open teaching, supervision, or student\s+device session\./
    );
    assert.ok(
      /The gate\s+never updates, deactivates, or deletes an existing session\./.test(
        runbook
      ),
      "the gate must not alter existing sessions"
    );
    assert.match(
      runbook,
      /Version 1 and 43-only evidence are historical and ineligible for new\s+deployments\./
    );
  });

  it("requires an exact single-use candidate rehearsal before deployment", () => {
    for (const required of [
      "--classpilot-tile-auth-plan-rehearsal",
      "--reuse-classpilot-tile-auth-plan-rehearsal <absolute-private-receipt-path>",
      "`classpilot-tile-auth-plan-rehearsal-v1`",
      "`$LOCALAPPDATA/SchoolPilot/load-gates/tile-auth-rehearsals/<SHA>`",
      "`classpilot-tile-auth-plan-rehearsal-attempt.private.json`",
      "`classpilot-tile-auth-plan-rehearsal-terminal.private.json`",
      "`status` equal to `passed` or `failed`",
      "permanently makes that SHA ineligible",
      "`inspect` and `consume` require the passed terminal marker",
      "bind one protected execution-authority\nSHA-256",
      "stable machine\nidentity plus the current user SID",
      "neither raw value is written or logged",
      "copying the\ncomplete private tree to another host or user does not transfer deployment\nauthority",
      "exact\nexpiry instant and every later instant (`now >= expiresAtUtc`) are rejected",
      "repeats that half-open\ncheck immediately before attempting the atomic consumption marker",
      "expires after 60\nminutes",
      "consumed once through its immutable sidecar",
      "byte-identical copies and\nconcurrent consumers on the authorized execution authority share the same\nsingle-use marker",
      "performs no migration,\nscaling hold, serving-service update, frontend publication, fixture mutation",
      "Building, pushing, and registering the\ninactive candidate are the only candidate control-plane writes",
      "do not\nchange the serving release or committed production data",
      "Fetch\nthat exact stream even when exit is nonzero",
    ]) {
      assert.ok(
        runbook.includes(required),
        `runbook is missing the rehearsal invariant: ${required}`
      );
    }

    assert.match(
      runbook,
      /A direct\s+unrehearsed plan-gated deployment is ineligible\./
    );
    assert.match(
      runbook,
      /Exit zero plus complete valid evidence remains\s+mandatory for acceptance/
    );
  });

  it("keeps observation evidence non-consuming and ineligible", () => {
    for (const required of [
      "--classpilot-tile-auth-plan-observation",
      "`classpilot-tile-auth-plan-base-funnel-v1`",
      "`classpilot-tile-auth-plan-observation-v1`",
      "creates no\nrehearsal admission or receipt",
      "`base_eligible`",
      "`base_ineligible`",
      "`eligibleForDeployment`, `eligibleForDiagnostic`, and\n`eligibleForCertification` are exactly `false`",
      "current authorization permits exactly one and no\nautomatic retry",
      "is never an alternate deployment path",
      "report-only exception",
    ]) {
      assert.ok(
        runbook.includes(required),
        `runbook is missing the observation invariant: ${required}`
      );
    }

    assert.match(
      runbook,
      /This failure evidence cannot satisfy the unchanged passing preflight or either\s+complete release gate\./
    );
    assert.match(
      runbook,
      /Rehearsal inspection and\s+consumption, deployment admission, diagnostic binding, and certification\s+validation must reject an observation packet/
    );
  });

  it("records the failed candidate and enforces the readiness-only boundary", () => {
    for (const required of [
      "`3c82f540cccfaf0badd70312e76e69770b6cfaed`",
      "`sha256:776bd7e55a64c9da26d5eb1f38887f0402b0f1d143d3a1ca20a47246d459c1d6`",
      "`schoolpilot-production-api:133`",
      "`schoolpilot-production-api-emergency:33`",
      "is historical-only",
      "The current observation-only remediation stops after one independently\ninspected observation packet.",
      "It authorizes no rehearsal, serving deployment",
      "production fixture refresh or provisioning",
      "diagnostic binding",
      "failure is\nterminal for that SHA",
      "the per-SHA atomic admission marker, immutable passed terminal marker",
      "their common protected execution-authority\n  SHA-256",
      "an explicit record that no apply occurred",
    ]) {
      assert.ok(
        runbook.includes(required),
        `runbook is missing the stop-boundary invariant: ${required}`
      );
    }
    assert.doesNotMatch(
      runbook,
      /--classpilot-tile-auth-plan-gate\s+\\\s*\n\s*--classpilot-tile-auth-plan-observation/,
      "observation mode must remain standalone from the deployment gate"
    );
  });

  it("records the f326 observation predecessor as historical-only", () => {
    for (const required of [
      "`f3265563ac2efb673a2974a1adafefe32dcedb42`",
      "`sha256:56e973299479638e02f496b0641a21945440367cbe0a3d782c3fc75e6442673a`",
      "`schoolpilot-production-api-emergency:34`",
      "`schoolpilot-production-scheduler-worker:49`",
      "`representative_scenario_missing`",
      "ineligible for deployment, diagnostics, and\ncertification",
      "must not be promoted or reused",
    ]) {
      assert.ok(
        runbook.includes(required),
        `runbook is missing the historical observation predecessor: ${required}`
      );
    }
  });
});
