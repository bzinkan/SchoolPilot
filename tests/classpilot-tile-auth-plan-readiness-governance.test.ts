import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const readRepositoryFile = (path: string) =>
  readFileSync(new URL(`../${path}`, import.meta.url), "utf8").replace(
    /\r\n/g,
    "\n"
  );

const runbook = readRepositoryFile("docs/AWS_COST_ROLLOUT_OPERATIONS.md");
const planCheck = readRepositoryFile(
  "docs/CLASSPILOT_TILE_AUTHORIZATION_PLAN_CHECK.md"
);
const ciWorkflow = readRepositoryFile(".github/workflows/ci-build.yml");
const deployScript = readRepositoryFile("scripts/deploy.sh");
const certificationSupervisor = readRepositoryFile(
  "scripts/load/start-aws-rollout-supervisor.ps1"
);

const finalStopLossAllowedFiles = [
  "scripts/deploy.sh",
  "scripts/manage-classpilot-tile-auth-plan-rehearsal-receipt.mjs",
  "scripts/load/start-aws-rollout-supervisor.ps1",
  "tests/deploy-classpilot-tile-auth-plan-gate.test.ts",
  "tests/classpilot-tile-auth-plan-rehearsal-receipt.test.ts",
  "tests/aws-rollout-certification-chain.test.ps1",
  "tests/classpilot-tile-auth-plan-readiness-governance.test.ts",
  "docs/AWS_COST_ROLLOUT_OPERATIONS.md",
  "docs/CLASSPILOT_TILE_AUTHORIZATION_PLAN_CHECK.md",
] as const;

const runtimeFiles = finalStopLossAllowedFiles.slice(0, 3);
const finalStopLossCommit =
  "f5759465b5a2ae43d4808c9aa53acc43c3c375b0";
const finalStopLossBaseCommit =
  "5b076d1f5e77a3a239d0b02d6ba99d484352533f";

function git(args: string[]): string {
  return execFileSync("git", args, {
    cwd: repositoryRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function ensureCommitAvailable(sha: string): void {
  try {
    git(["cat-file", "-e", `${sha}^{commit}`]);
    return;
  } catch {
    try {
      git(["fetch", "--no-tags", "--depth=1", "origin", sha]);
      git(["cat-file", "-e", `${sha}^{commit}`]);
      return;
    } catch {
      assert.fail(
        `the frozen final stop-loss history ${sha} is unavailable; CI may not skip historical boundary enforcement`
      );
    }
  }
}

function contractLiterals(source: string): Set<string> {
  const values = new Set<string>();
  const patterns = [
    /["'`]([a-z0-9][a-z0-9_.-]*-v\d+)["'`]/gi,
    /["'`]([a-z0-9][a-z0-9_.-]*(?:schema|controller|marker)[a-z0-9_.-]*)["'`]/gi,
    /["'`]([a-z0-9][a-z0-9_.-]*(?:failed|failure|unavailable|invalid|timeout|rejected|drift|missing)[a-z0-9_.-]*)["'`]/gi,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) values.add(match[1]);
  }
  return values;
}

describe("ClassPilot final stop-loss governance", () => {
  it("keeps the v2 evidence and database regressions in CI", () => {
    const laneListing = execFileSync(
      process.execPath,
      ["scripts/run-test-lane.mjs", "list"],
      { cwd: repositoryRoot, encoding: "utf8" }
    );
    const laneByPath = new Map(laneListing.trim().split(/\r?\n/).map((line) => {
      const [lane, path] = line.split("\t");
      return [path, lane];
    }));
    const backendTests = [
      "tests/classpilot-tile-auth-plan-base-funnel-evidence.test.ts",
      "tests/classpilot-tile-auth-plan-evidence-validator.test.ts",
      "tests/classpilot-tile-auth-plan-lifecycle-cli.test.ts",
      "tests/deploy-classpilot-tile-auth-plan-gate.test.ts",
      "tests/classpilot-tile-auth-plan-base-selection-evidence.test.ts",
      "tests/classpilot-tile-auth-plan-observation.test.ts",
      "tests/classpilot-tile-auth-plan-observation-collector.test.ts",
      "tests/classpilot-tile-auth-plan-observation-reread.test.ts",
      "tests/classpilot-tile-auth-plan-rehearsal-receipt.test.ts",
      "tests/classpilot-tile-auth-plan-readiness-governance.test.ts",
    ];
    for (const testPath of backendTests) {
      assert.equal(
        laneByPath.get(testPath),
        "infrastructure",
        `CI infrastructure lane is missing the release-gate regression: ${testPath}`
      );
    }
    assert.equal(
      laneByPath.get("tests/classpilot-tile-authorization-plan-self-provisioning.integration.test.ts"),
      "rls",
      "CI is missing the RLS-enabled transactional scenario integration suite"
    );
    assert.match(ciWorkflow, /npm run test:infrastructure/);
    assert.match(ciWorkflow, /npm run test:rls-serial/);
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
    assert.match(
      runbook,
      /The gate\s+never updates, deactivates, or deletes an existing session\./
    );
    assert.match(
      runbook,
      /Version 1 and 43-only evidence are historical and ineligible for new\s+deployments\./
    );
  });

  it("preserves the frozen final PR as the nine approved existing files", () => {
    for (const path of finalStopLossAllowedFiles) {
      assert.ok(
        runbook.includes(`\`${path}\``),
        `runbook is missing the exact final-PR allowlist entry: ${path}`
      );
    }
    assert.match(runbook, /may add no file/);
    assert.match(
      runbook,
      /no runtime schema\/version, controller, marker, or\s+failure-code literal/
    );
    assert.match(runbook, /No later campaign\s+commit or remediation PR is allowed/);

    ensureCommitAvailable(finalStopLossBaseCommit);
    ensureCommitAvailable(finalStopLossCommit);

    const nameStatus = git([
      "diff",
      "--name-status",
      finalStopLossBaseCommit,
      finalStopLossCommit,
      "--",
    ]);
    const changed = nameStatus
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => {
        const [status, ...pathParts] = line.split("\t");
        return { status, path: pathParts.at(-1) ?? "" };
      });
    assert.ok(changed.length > 0, "the final stop-loss PR diff is empty");
    assert.deepEqual(
      [...new Set(changed.map(({ path }) => path))].sort(),
      [...finalStopLossAllowedFiles].sort(),
      "the final stop-loss PR changed something outside its exact allowlist"
    );
    assert.ok(
      changed.every(({ status }) => status !== "A"),
      "the final stop-loss PR may not add files"
    );

    const priorLiterals = new Set<string>();
    const currentLiterals = new Set<string>();
    for (const path of runtimeFiles) {
      const prior = git(["show", `${finalStopLossBaseCommit}:${path}`]);
      const frozen = git(["show", `${finalStopLossCommit}:${path}`]);
      for (const value of contractLiterals(prior)) priorLiterals.add(value);
      for (const value of contractLiterals(frozen)) {
        currentLiterals.add(value);
      }
    }
    const additions = [...currentLiterals].filter(
      (value) => !priorLiterals.has(value)
    );
    assert.deepEqual(
      additions,
      [],
      `the final PR introduced runtime contract literals: ${additions.join(", ")}`
    );
  });

  it("keeps observation optional and historical evidence out of admission", () => {
    for (const document of [runbook, planCheck]) {
      assert.match(
        document,
        /Historical observation reread and supersession artifacts remain immutable/
      );
      assert.match(
        document,
        /not active observation, rehearsal, readiness,\s+deployment, diagnostic, or\s+certification prerequisites/
      );
      assert.match(document, /Standalone observation is optional audit evidence/);
      assert.match(
        document,
        /production-connected gate-only\s+rehearsal[\s\S]{0,140}(?:the stronger|stronger and required)/
      );
    }
    assert.doesNotMatch(
      deployScript,
      /^\s+(?:if\s+!\s+)?create_and_inspect_classpilot_tile_auth_plan_observation_supersession(?:\s|;)/m
    );
    assert.doesNotMatch(
      deployScript,
      /^\s+(?:if\s+!\s+)?reinspect_classpilot_tile_auth_plan_observation_supersession_before_launch(?:\s|;)/m
    );
  });

  it("keeps CloudWatch strict and moves the scarce attempt to mutation", () => {
    for (const document of [runbook, planCheck]) {
      assert.match(
        document,
        /CloudWatch-backed\s+(?:preflight, )?lifecycle, plan-report, and\s+query-identity evidence is mandatory/
      );
      assert.match(
        document,
        /[Ee]xit zero without that complete\s+sanitized evidence never passes/
      );
      assert.match(
        document,
        /non-authoritative provider or evidence-transport failure before production\s+mutation creates no SHA-wide attempt/
      );
      assert.match(document, /permits one same-SHA gate-only retry/);
      assert.match(
        document,
        /authoritative SQL,\s+query-identity, RLS, rollback, residue, or plan-threshold failure/
      );
      assert.match(
        document,
        /(?:Consumption occurs immediately before the scaling hold and first production\s+mutation|immediately before\s+the scaling hold and first production mutation)/
      );
    }

    const predeployGate = deployScript.lastIndexOf(
      "run_classpilot_tile_auth_plan_gate predeploy"
    );
    const consume = deployScript.lastIndexOf(
      "inspect_or_consume_classpilot_rehearsal_receipt consume"
    );
    const scalingHold = deployScript.indexOf(
      "acquire_production_scaling_hold",
      consume
    );
    assert.ok(
      predeployGate >= 0 && predeployGate < consume && consume < scalingHold,
      "the strict predeploy gate must precede receipt consumption and mutation"
    );
    assert.doesNotMatch(
      deployScript,
      /Candidate rehearsal exited without a terminal attempt record/
    );
  });

  it("consumes certification authority only at the traffic start gate", () => {
    const inspect = certificationSupervisor.lastIndexOf(
      "$validationReceiptInspection = Inspect-CertificationValidationReceipt"
    );
    const harness = certificationSupervisor.indexOf(
      "$harness = Start-Process",
      inspect
    );
    const monitor = certificationSupervisor.indexOf(
      "$monitor = Start-Process",
      harness
    );
    const recheck = certificationSupervisor.indexOf(
      "$preTrafficRollbackBinding = Assert-CertificationRollbackConfigBinding",
      monitor
    );
    const consume = certificationSupervisor.indexOf(
      "Use-CertificationValidationReceipt",
      recheck
    );
    const startGate = certificationSupervisor.indexOf(
      "Write-AtomicJson -Path $harnessStartGatePath",
      consume
    );
    assert.ok(
      inspect >= 0 &&
        inspect < harness &&
        harness < monitor &&
        monitor < recheck &&
        recheck < consume &&
        consume < startGate,
      "inspection, startup, recheck, consumption, and start-gate order drifted"
    );
    for (const document of [runbook, planCheck]) {
      assert.match(
        document,
        /(?:That )?[Ll]ate (?:receipt )?consumption prevents a\s+(?:pretraffic )?startup failure from falsely burning\s+traffic authority/
      );
      assert.match(
        document,
        /failure before the start gate is (?:released is )?a\s+decisive\s+terminal no-traffic/
      );
      assert.match(
        document,
        /Do\s+not create a second binding, repeat fixture\s+preparation, or run/
      );
      assert.doesNotMatch(
        document,
        /one fresh immutable\s+pretraffic binding|no-traffic pre-start binding may continue/
      );
    }
    assert.match(runbook, /traffic is one-shot/);
  });

  it("binds fresh continuity, diagnostic, and the medium-only terminal chain", () => {
    for (const required of [
      "`launch-safe-20260711`",
      "`fixture-state.private.json` and `fixture-ownership.private.json`",
      "zero pending intents",
      "one fresh Waf/500 -> Waf/800 certification chain",
      "`expectedRdsInstanceClass=db.t4g.medium`",
      "not certified - evidence unavailable",
      "`db.t4g.medium` uncertified",
    ]) {
      assert.ok(
        runbook.includes(required),
        `runbook is missing the final campaign invariant: ${required}`
      );
    }
    assert.match(runbook, /two owned schools,\s+20\s+teachers, one office user/);
    assert.match(runbook, /one strict 30-minute Waf\/800\s+diagnostic traffic start/);
    assert.match(
      runbook,
      /Start Waf\/800 around 01:15 ET so its\s+90-minute interval contains the existing 01:30 purge and 02:00 rollup/
    );
    assert.match(
      runbook,
      /Do not copy any historical device, auth, command, verification, snapshot, or\s+diagnostic artifact/
    );
    assert.match(
      runbook,
      /Reuse the mutable continuity root sequentially for the diagnostic,\s+Waf\/500, and Waf\/800/
    );
    assert.match(
      runbook,
      /supervisor-sealed Waf\/800 terminal result binding the frozen\s+release and observed `db\.t4g\.medium`/
    );
    assert.match(
      runbook,
      /No (?:RDS resize or xlarge fallback|xlarge path, RDS resize)/
    );
  });

  it("retains failed candidates as historical-only", () => {
    for (const required of [
      "`3c82f540cccfaf0badd70312e76e69770b6cfaed`",
      "`sha256:776bd7e55a64c9da26d5eb1f38887f0402b0f1d143d3a1ca20a47246d459c1d6`",
      "`f3265563ac2efb673a2974a1adafefe32dcedb42`",
      "`sha256:56e973299479638e02f496b0641a21945440367cbe0a3d782c3fc75e6442673a`",
      "`representative_scenario_missing`",
      "`cf9b70420b71668d4f06c9376b5274d27a259d0f`",
      "`sha256:293e31c70c779da9d20af62957af70d2f6fb4c8ed327c0f9d7d4730053e8e570`",
    ]) {
      assert.ok(
        planCheck.includes(required),
        `plan-check history is missing: ${required}`
      );
    }
    assert.doesNotMatch(
      runbook,
      /--classpilot-tile-auth-plan-gate\s+\\\s*\n\s*--classpilot-tile-auth-plan-observation/,
      "observation mode must remain standalone"
    );
  });
});
