import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const scriptsRoot = fileURLToPath(new URL("../scripts/", import.meta.url));

const deploySource = readFileSync(
  new URL("../scripts/deploy.sh", import.meta.url),
  "utf8"
).replace(/\r\n/g, "\n");
const libraryBoundary = deploySource.indexOf("# --- Preflight checks ---");
assert.ok(libraryBoundary > 0);
const deployLibrarySource = deploySource.slice(0, libraryBoundary);
const configurationBoundary = deploySource.indexOf("# --- Configuration ---");
assert.ok(configurationBoundary > 0);
const argumentParserSource = deploySource.slice(0, configurationBoundary);

function bashExecutable(): string {
  if (process.platform !== "win32") return "bash";
  const candidates = [
    "C:\\Program Files\\Git\\bin\\bash.exe",
    "C:\\Program Files\\Git\\usr\\bin\\bash.exe",
    "C:\\Program Files (x86)\\Git\\bin\\bash.exe",
  ];
  return candidates.find(existsSync) ?? "bash";
}

function runDeployHelper(body: string) {
  return spawnSync(bashExecutable(), ["-s"], {
    cwd: scriptsRoot,
    encoding: "utf8",
    input: `
${deployLibrarySource}
info() { :; }
success() { :; }
warn() { :; }
error() { printf '%s\\n' "$*" >&2; }
${body}
`,
  });
}

function runArgumentParser(args: string[]) {
  return spawnSync(bashExecutable(), ["-s", "--", ...args], {
    cwd: scriptsRoot,
    encoding: "utf8",
    input: `${argumentParserSource}
printf '%s\\t%s\\t%s\\t%s\\t%s\\t%s\\n' \\
  "$CAPACITY_ACCEPTANCE_RELEASE" \\
  "$RUN_CLASSPILOT_TILE_AUTH_PLAN_GATE" \\
  "$RUN_CLASSPILOT_TILE_AUTH_PLAN_REHEARSAL" \\
  "$RUN_CLASSPILOT_TILE_AUTH_PLAN_OBSERVATION" \\
  "$DEPLOY_BACKEND" \\
  "$DEPLOY_FRONTEND"
`,
  });
}

function runDeployScript(args: string[]) {
  return spawnSync(bashExecutable(), ["deploy.sh", ...args], {
    cwd: scriptsRoot,
    encoding: "utf8",
  });
}

function validCapacityMode(overrides = "") {
  return `
CAPACITY_ACCEPTANCE_RELEASE=true
RUN_CLASSPILOT_TILE_AUTH_PLAN_GATE=true
RUN_CLASSPILOT_TILE_AUTH_PLAN_REHEARSAL=false
RUN_CLASSPILOT_TILE_AUTH_PLAN_OBSERVATION=false
REUSE_CLASSPILOT_TILE_AUTH_PLAN_REHEARSAL=""
EXPECTED_CLASSPILOT_TILE_AUTH_PLAN_REHEARSAL_SHA256=""
ENV=production
DEPLOY_BACKEND=true
DEPLOY_FRONTEND=false
ACTIVATE_EMERGENCY=true
SAME_IMAGE_NETWORKING_STAGE=""
SKIP_WAIT=false
IMAGE_TAG=""
${overrides}
validate_classpilot_tile_auth_plan_gate_mode
`;
}

describe("capacity-acceptance guarded release", () => {
  it("parses one explicit flag that enables the strict SQL plan gate", () => {
    assert.match(
      deploySource,
      /--capacity-acceptance-release\)\s+CAPACITY_ACCEPTANCE_RELEASE=true\s+RUN_CLASSPILOT_TILE_AUTH_PLAN_GATE=true/
    );
    assert.match(
      deploySource,
      /historical --capacity-acceptance-release shape requires production --backend --activate-emergency/
    );

    const parsed = runArgumentParser([
      "production",
      "--backend",
      "--activate-emergency",
      "--capacity-acceptance-release",
    ]);
    assert.equal(parsed.status, 0, parsed.stderr);
    assert.equal(parsed.stdout.trim(), "true\ttrue\tfalse\tfalse\ttrue\tfalse");
  });

  it("blocks both capacity deployment flags while paused and leaves ordinary deployment admission unchanged", () => {
    const backend = runDeployScript([
      "production",
      "--backend",
      "--activate-emergency",
      "--capacity-acceptance-release",
    ]);
    assert.notEqual(backend.status, 0);
    assert.match(`${backend.stdout}${backend.stderr}`, /Capacity acceptance is paused/);

    const frontend = runDeployScript([
      "production",
      "--frontend",
      "--capacity-acceptance-frontend-sha",
      "a".repeat(40),
    ]);
    assert.notEqual(frontend.status, 0);
    assert.match(`${frontend.stdout}${frontend.stderr}`, /Capacity acceptance is paused/);

    const ordinary = runDeployHelper(`
CAPACITY_ACCEPTANCE_RELEASE=false
CAPACITY_ACCEPTANCE_FRONTEND_SHA=""
RUN_CLASSPILOT_TILE_AUTH_PLAN_GATE=false
RUN_CLASSPILOT_TILE_AUTH_PLAN_REHEARSAL=false
RUN_CLASSPILOT_TILE_AUTH_PLAN_OBSERVATION=false
REUSE_CLASSPILOT_TILE_AUTH_PLAN_REHEARSAL=""
EXPECTED_CLASSPILOT_TILE_AUTH_PLAN_REHEARSAL_SHA256=""
CLASSPILOT_TILE_AUTH_PLAN_OBSERVATION_REREAD=""
ENV=production
DEPLOY_BACKEND=true
DEPLOY_FRONTEND=true
ACTIVATE_EMERGENCY=false
SAME_IMAGE_NETWORKING_STAGE=""
SKIP_WAIT=false
IMAGE_TAG=""
validate_capacity_acceptance_authorization_mode
validate_capacity_acceptance_frontend_mode
validate_retired_certification_admission_mode
validate_classpilot_tile_auth_plan_gate_mode
`);
    assert.equal(ordinary.status, 0, ordinary.stderr);

    const pauseIndex = deploySource.indexOf(
      "if ! validate_capacity_acceptance_authorization_mode"
    );
    const credentialIndex = deploySource.indexOf(
      "aws sts get-caller-identity",
      pauseIndex
    );
    assert.ok(pauseIndex >= 0 && credentialIndex > pauseIndex);
  });

  it("retains the historical backend shape behind the committed pause", () => {
    const accepted = runDeployHelper(validCapacityMode());
    assert.equal(accepted.status, 0, accepted.stderr);

    for (const invalid of [
      "RUN_CLASSPILOT_TILE_AUTH_PLAN_GATE=false",
      "RUN_CLASSPILOT_TILE_AUTH_PLAN_REHEARSAL=true",
      "RUN_CLASSPILOT_TILE_AUTH_PLAN_OBSERVATION=true",
      'REUSE_CLASSPILOT_TILE_AUTH_PLAN_REHEARSAL="C:/private/receipt.json"',
      `EXPECTED_CLASSPILOT_TILE_AUTH_PLAN_REHEARSAL_SHA256="${"a".repeat(64)}"`,
      "ENV=staging",
      "DEPLOY_BACKEND=false",
      "DEPLOY_FRONTEND=true",
      "ACTIVATE_EMERGENCY=false",
      "SAME_IMAGE_NETWORKING_STAGE=PublicEcs",
      "SKIP_WAIT=true",
      "IMAGE_TAG=latest",
    ]) {
      const rejected = runDeployHelper(validCapacityMode(invalid));
      assert.notEqual(rejected.status, 0, invalid);
    }
  });

  it("retires legacy production observation and rehearsal admission", () => {
    for (const legacyMode of [
      "RUN_CLASSPILOT_TILE_AUTH_PLAN_GATE=true",
      "RUN_CLASSPILOT_TILE_AUTH_PLAN_REHEARSAL=true",
      "RUN_CLASSPILOT_TILE_AUTH_PLAN_OBSERVATION=true",
      'CLASSPILOT_TILE_AUTH_PLAN_OBSERVATION_REREAD="C:/private/reread.json"',
      'REUSE_CLASSPILOT_TILE_AUTH_PLAN_REHEARSAL="C:/private/receipt.json"',
    ]) {
      const rejected = runDeployHelper(`
ENV=production
CAPACITY_ACCEPTANCE_RELEASE=false
RUN_CLASSPILOT_TILE_AUTH_PLAN_GATE=false
RUN_CLASSPILOT_TILE_AUTH_PLAN_REHEARSAL=false
RUN_CLASSPILOT_TILE_AUTH_PLAN_OBSERVATION=false
CLASSPILOT_TILE_AUTH_PLAN_OBSERVATION_REREAD=""
REUSE_CLASSPILOT_TILE_AUTH_PLAN_REHEARSAL=""
${legacyMode}
validate_retired_certification_admission_mode
`);
      assert.notEqual(rejected.status, 0, legacyMode);
      assert.match(rejected.stderr, /historical evidence remains inspectable only/);
    }

    const capacity = runDeployHelper(`
ENV=production
CAPACITY_ACCEPTANCE_RELEASE=true
RUN_CLASSPILOT_TILE_AUTH_PLAN_GATE=true
RUN_CLASSPILOT_TILE_AUTH_PLAN_REHEARSAL=false
RUN_CLASSPILOT_TILE_AUTH_PLAN_OBSERVATION=false
CLASSPILOT_TILE_AUTH_PLAN_OBSERVATION_REREAD=""
REUSE_CLASSPILOT_TILE_AUTH_PLAN_REHEARSAL=""
validate_retired_certification_admission_mode
`);
    assert.equal(capacity.status, 0, capacity.stderr);
  });

  it("retires legacy production supervisor traffic while keeping history testable", () => {
    const supervisorSource = readFileSync(
      new URL("../scripts/load/start-aws-rollout-supervisor.ps1", import.meta.url),
      "utf8"
    );
    assert.match(
      supervisorSource,
      /-not \$testMode -and \$Mode -eq "Run" -and \$SupervisionKind -eq "Load"[\s\S]*legacy production certification load supervisor is retired/
    );
  });

  it("revalidates one exact network binding before each production mutation boundary", () => {
    const accepted = runDeployHelper(`
CAPACITY_ACCEPTANCE_RELEASE=true
CAPACITY_ACCEPTANCE_NETWORK_SHA256="${"a".repeat(64)}"
NETWORK_CONFIG=""
TILE_AUTH_PLAN_REHEARSAL_NETWORK_SHA256=""
resolve_classpilot_tile_auth_candidate_network() {
  NETWORK_CONFIG='{"awsvpcConfiguration":{}}'
  TILE_AUTH_PLAN_REHEARSAL_NETWORK_SHA256="${"a".repeat(64)}"
}
assert_capacity_acceptance_network_unchanged
`);
    assert.equal(accepted.status, 0, accepted.stderr);

    const drifted = runDeployHelper(`
CAPACITY_ACCEPTANCE_RELEASE=true
CAPACITY_ACCEPTANCE_NETWORK_SHA256="${"a".repeat(64)}"
NETWORK_CONFIG=""
TILE_AUTH_PLAN_REHEARSAL_NETWORK_SHA256=""
resolve_classpilot_tile_auth_candidate_network() {
  NETWORK_CONFIG='{"awsvpcConfiguration":{}}'
  TILE_AUTH_PLAN_REHEARSAL_NETWORK_SHA256="${"b".repeat(64)}"
}
assert_capacity_acceptance_network_unchanged
`);
    assert.notEqual(drifted.status, 0);
    assert.match(drifted.stderr, /network configuration drifted/);
  });

  it("retains the historical frontend binding behind the committed pause", () => {
    const sha = "a".repeat(40);
    const accepted = runDeployHelper(`
CAPACITY_ACCEPTANCE_FRONTEND_SHA="${sha}"
ENV=production
DEPLOY_BACKEND=false
DEPLOY_FRONTEND=true
CAPACITY_ACCEPTANCE_RELEASE=false
SAME_IMAGE_NETWORKING_STAGE=""
IMAGE_TAG=""
SKIP_WAIT=false
validate_capacity_acceptance_frontend_mode
`);
    assert.equal(accepted.status, 0, accepted.stderr);

    for (const invalid of [
      'CAPACITY_ACCEPTANCE_FRONTEND_SHA="short"',
      "DEPLOY_BACKEND=true",
      "DEPLOY_FRONTEND=false",
      "ENV=staging",
      "CAPACITY_ACCEPTANCE_RELEASE=true",
      "IMAGE_TAG=latest",
      "SKIP_WAIT=true",
    ]) {
      const rejected = runDeployHelper(`
CAPACITY_ACCEPTANCE_FRONTEND_SHA="${sha}"
ENV=production
DEPLOY_BACKEND=false
DEPLOY_FRONTEND=true
CAPACITY_ACCEPTANCE_RELEASE=false
SAME_IMAGE_NETWORKING_STAGE=""
IMAGE_TAG=""
SKIP_WAIT=false
${invalid}
validate_capacity_acceptance_frontend_mode
`);
      assert.notEqual(rejected.status, 0, invalid);
    }

    assert.match(
      deploySource,
      /CAPACITY_ACCEPTANCE_FRONTEND_SHA[\s\S]*LOCAL_SHA[\s\S]*capacity-acceptance frontend SHA does not match/
    );
    const createIndex = deploySource.indexOf("aws cloudfront create-invalidation");
    const waitIndex = deploySource.indexOf("aws cloudfront wait invalidation-completed", createIndex);
    const statusIndex = deploySource.indexOf("aws cloudfront get-invalidation", waitIndex);
    const successIndex = deploySource.indexOf("CloudFront invalidation completed", statusIndex);
    assert.ok(createIndex >= 0 && waitIndex > createIndex && statusIndex > waitIndex && successIndex > statusIndex);
  });

  it("runs the strict gate before migration and again after exact convergence", () => {
    const backend = deploySource.slice(
      deploySource.indexOf("# BACKEND DEPLOY"),
      deploySource.indexOf("# FRONTEND DEPLOY")
    );
    const preGate = backend.indexOf(
      "run_classpilot_tile_auth_plan_predeploy_with_retry"
    );
    const hold = backend.indexOf("acquire_production_scaling_hold", preGate);
    const migration = backend.indexOf(
      'info "Running startup migrations',
      hold
    );
    const apiUpdate = backend.indexOf("aws ecs update-service", migration);
    const convergence = backend.indexOf(
      "wait_for_production_backend_strict_stability",
      apiUpdate
    );
    const postGate = backend.indexOf(
      "run_classpilot_tile_auth_plan_gate postdeploy",
      convergence
    );

    assert.ok(preGate >= 0);
    assert.ok(preGate < hold);
    assert.ok(hold < migration);
    assert.ok(migration < apiUpdate);
    assert.ok(apiUpdate < convergence);
    assert.ok(convergence < postGate);
  });

  it("bypasses only rehearsal bookkeeping while retaining rollback and scaling recovery", () => {
    assert.match(
      deploySource,
      /if \[\[ "\$CAPACITY_ACCEPTANCE_RELEASE" == true \]\]; then[\s\S]*?no observation, rehearsal admission, or rehearsal receipt was required or consumed\.[\s\S]*?else[\s\S]*?inspect_or_consume_classpilot_rehearsal_receipt consume/
    );
    assert.match(
      deploySource,
      /if \[\[ "\$RUN_CLASSPILOT_TILE_AUTH_PLAN_GATE" == true &&\s+"\$CLASSPILOT_TILE_AUTH_SERVICE_MUTATION_STARTED" == true[\s\S]*?rollback_classpilot_tile_auth_deployment/
    );
    assert.match(
      deploySource,
      /rollback_classpilot_tile_auth_deployment\(\)[\s\S]*?restore_production_scaling_hold/
    );
  });

  it("does not add observation, preparation rehearsal, host smoke, fixture, lease, or traffic work to the release branch", () => {
    const successText =
      "Capacity-acceptance predeploy gate passed; no observation, rehearsal admission, or rehearsal receipt was required or consumed.";
    const successIndex = deploySource.indexOf(successText);
    const branchStart = deploySource.lastIndexOf(
      'if [[ "$CAPACITY_ACCEPTANCE_RELEASE" == true ]]; then',
      successIndex
    );
    const branchEnd = deploySource.indexOf("\n  else", successIndex);
    assert.ok(branchStart >= 0 && branchEnd > branchStart);
    const capacityBranch = deploySource.slice(branchStart, branchEnd);

    assert.doesNotMatch(
      capacityBranch,
      /run_classpilot_tile_auth_plan_observation_task|write_classpilot_rehearsal_receipt|inspect_or_consume_classpilot_rehearsal_receipt|OfflineRehearsal|HostSmoke|fixture|lease|traffic/
    );
  });
});
