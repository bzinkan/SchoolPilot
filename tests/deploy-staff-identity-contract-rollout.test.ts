import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const deploySource = readFileSync(
  new URL("../scripts/deploy.sh", import.meta.url),
  "utf8",
).replace(/\r\n/g, "\n");
const runbookSource = readFileSync(
  new URL("../docs/STAFF_IDENTITY_LIFECYCLE_RUNBOOK.md", import.meta.url),
  "utf8",
);

const validationStart = deploySource.indexOf(
  "validate_staff_identity_contract_rollout_mode()",
);
const validationEnd = deploySource.indexOf(
  "validate_classpilot_tile_auth_plan_gate_mode()",
  validationStart,
);
assert.ok(validationStart >= 0 && validationEnd > validationStart);
const validationSource = deploySource.slice(validationStart, validationEnd);
const helperStart = deploySource.indexOf("run_staff_identity_contract_migration_task()");
const helperEnd = deploySource.indexOf("# --- Preflight checks ---", helperStart);
assert.ok(helperStart >= 0 && helperEnd > helperStart);
const helperSource = deploySource.slice(helperStart, helperEnd);

function bashExecutable(): string {
  if (process.platform !== "win32") return "bash";
  return [
    "C:\\Program Files\\Git\\bin\\bash.exe",
    "C:\\Program Files\\Git\\usr\\bin\\bash.exe",
    "C:\\Program Files (x86)\\Git\\bin\\bash.exe",
  ].find(existsSync) ?? "bash";
}

type Mode = {
  apply?: boolean;
  environment?: string;
  backend?: boolean;
  frontend?: boolean;
  activateEmergency?: boolean;
  rls?: string;
  sameImage?: string;
  protectedWindow?: boolean;
  planGate?: boolean;
  planRehearsal?: boolean;
  planObservation?: boolean;
  receipt?: string;
  capacity?: boolean;
  capacityFrontendSha?: string;
};

function validateMode(mode: Mode = {}) {
  const script = `
set -euo pipefail
APPLY_STAFF_IDENTITY_CONTRACTS="$TEST_APPLY"
ENV="$TEST_ENVIRONMENT"
DEPLOY_BACKEND="$TEST_BACKEND"
DEPLOY_FRONTEND="$TEST_FRONTEND"
ACTIVATE_EMERGENCY="$TEST_ACTIVATE_EMERGENCY"
ENABLE_RLS_TABLE="$TEST_RLS"
SAME_IMAGE_NETWORKING_STAGE="$TEST_SAME_IMAGE"
CONFIRM_PROTECTED_WINDOW_PRODUCTION_MUTATION="$TEST_PROTECTED"
RUN_CLASSPILOT_TILE_AUTH_PLAN_GATE="$TEST_PLAN_GATE"
RUN_CLASSPILOT_TILE_AUTH_PLAN_REHEARSAL="$TEST_PLAN_REHEARSAL"
RUN_CLASSPILOT_TILE_AUTH_PLAN_OBSERVATION="$TEST_PLAN_OBSERVATION"
REUSE_CLASSPILOT_TILE_AUTH_PLAN_REHEARSAL="$TEST_RECEIPT"
CAPACITY_ACCEPTANCE_RELEASE="$TEST_CAPACITY"
CAPACITY_ACCEPTANCE_FRONTEND_SHA="$TEST_CAPACITY_FRONTEND_SHA"
error() { printf 'ERROR %s\\n' "$*" >&2; }
${validationSource}
validate_staff_identity_contract_rollout_mode
`;
  return spawnSync(bashExecutable(), ["-s"], {
    encoding: "utf8",
    input: script,
    env: {
      ...process.env,
      TEST_APPLY: String(mode.apply ?? true),
      TEST_ENVIRONMENT: mode.environment ?? "production",
      TEST_BACKEND: String(mode.backend ?? true),
      TEST_FRONTEND: String(mode.frontend ?? false),
      TEST_ACTIVATE_EMERGENCY: String(mode.activateEmergency ?? false),
      TEST_RLS: mode.rls ?? "",
      TEST_SAME_IMAGE: mode.sameImage ?? "",
      TEST_PROTECTED: String(mode.protectedWindow ?? false),
      TEST_PLAN_GATE: String(mode.planGate ?? false),
      TEST_PLAN_REHEARSAL: String(mode.planRehearsal ?? false),
      TEST_PLAN_OBSERVATION: String(mode.planObservation ?? false),
      TEST_RECEIPT: mode.receipt ?? "",
      TEST_CAPACITY: String(mode.capacity ?? false),
      TEST_CAPACITY_FRONTEND_SHA: mode.capacityFrontendSha ?? "",
    },
  });
}

describe("staff identity stage-five deploy admission", () => {
  it("admits only the explicit production backend-only shape", () => {
    assert.equal(validateMode().status, 0);
    assert.equal(validateMode({ apply: false, environment: "staging", frontend: true }).status, 0);

    for (const invalid of [
      { environment: "staging" },
      { backend: false },
      { frontend: true },
      { activateEmergency: true },
      { rls: "students" },
      { sameImage: "PublicEcs" },
      { protectedWindow: true },
      { planGate: true },
      { planRehearsal: true },
      { planObservation: true },
      { receipt: "/private/receipt.json" },
      { capacity: true },
      { capacityFrontendSha: "a".repeat(40) },
    ] satisfies Mode[]) {
      const result = validateMode(invalid);
      assert.notEqual(result.status, 0, JSON.stringify(invalid));
      assert.match(result.stderr, /stage-five production --backend migration-only flag/);
    }
  });

  it("sets the rollout environment only on the migration-task override", () => {
    assert.match(deploySource, /--apply-staff-identity-contracts\)\s*\n\s*APPLY_STAFF_IDENTITY_CONTRACTS=true/);
    assert.match(
      deploySource,
      /run_staff_identity_contract_migration_task\(\)[\s\S]*?APPLY_STAFF_IDENTITY_CONTRACT_MIGRATIONS", value: "true"/,
    );
    assert.match(
      deploySource,
      /MIGRATION_OVERRIDES=\$\(ENABLE_RLS_TABLE="\$ENABLE_RLS_TABLE" APPLY_STAFF_IDENTITY_CONTRACTS="\$APPLY_STAFF_IDENTITY_CONTRACTS"[\s\S]*?process\.env\.APPLY_STAFF_IDENTITY_CONTRACTS === "true" \? "true" : "false"/,
    );
    assert.match(
      deploySource,
      /--overrides "\$MIGRATION_OVERRIDES"/,
    );
    assert.match(
      deploySource,
      /run_same_image_migration_task\(\)[\s\S]*?APPLY_STAFF_IDENTITY_CONTRACT_MIGRATIONS[^\n]*false/,
    );
  });

  it("reuses the exact serving main image and exits before build or service rollout", () => {
    const backendStart = deploySource.indexOf("# BACKEND DEPLOY");
    const contractCall = deploySource.indexOf(
      "run_staff_identity_contract_migration_task",
      backendStart,
    );
    const dockerBuild = deploySource.indexOf('info "Building Docker image..."', backendStart);
    assert.ok(backendStart >= 0 && contractCall > backendStart && contractCall < dockerBuild);

    assert.match(helperSource, /imageTag="\$\{IMAGE_TAG\}"/);
    assert.match(helperSource, /EXPECTED_IMAGE="\$expected_image"/);
    assert.match(helperSource, /--task-definition "\$PRODUCTION_ROLLBACK_API_TASK_DEFINITION_ARN"/);
    assert.match(helperSource, /rolloutFlag\?\.value === "true"/);
    assert.match(helperSource, /API and worker services were not mutated/);
    assert.doesNotMatch(helperSource, /ecs update-service|ecs register-task-definition|docker build|docker push/);
  });

  it("executes the same-image migration-only happy path without a service mutation", () => {
    const fixture = mkdtempSync(join(tmpdir(), "staff-contract-deploy-"));
    const expectedDigest = `sha256:${"b".repeat(64)}`;
    const apiArn = "arn:aws:ecs:us-east-1:135775632425:task-definition/schoolpilot-production-api-emergency:70";
    const workerArn = "arn:aws:ecs:us-east-1:135775632425:task-definition/schoolpilot-production-scheduler-worker:85";
    const taskArn = "arn:aws:ecs:us-east-1:135775632425:task/staff-contract";
    const script = `
set -euo pipefail
APPLY_STAFF_IDENTITY_CONTRACTS=true
NAME=schoolpilot-production
ECR_REPO=135775632425.dkr.ecr.us-east-1.amazonaws.com/schoolpilot-production-api
IMAGE_TAG=123456789abc
LOCAL_SHA=123456789abcdef0123456789abcdef012345678
REGION=us-east-1
CLUSTER=schoolpilot-production-cluster
NETWORK_CONFIG='awsvpcConfiguration={subnets=[subnet-abc],securityGroups=[sg-abc],assignPublicIp=DISABLED}'
PRODUCTION_ROLLBACK_API_TASK_DEFINITION_ARN='${apiArn}'
PRODUCTION_ROLLBACK_WORKER_TASK_DEFINITION_ARN='${workerArn}'
PRODUCTION_PREFLIGHT_API_TASK_DEFINITION_ARN='${apiArn}'
PRODUCTION_PREFLIGHT_WORKER_TASK_DEFINITION_ARN='${workerArn}'
MIGRATION_TASK_WAIT_SECONDS=10
MIGRATION_TASK_POLL_SECONDS=0
MIGRATION_TASK_STOP_WAIT_SECONDS=1
info() { :; }
success() { printf 'SUCCESS %s\\n' "$*"; }
error() { printf 'ERROR %s\\n' "$*" >&2; }
production_backend_capacity_preflight() {
  PRODUCTION_PREFLIGHT_API_TASK_DEFINITION_ARN='${apiArn}'
  PRODUCTION_PREFLIGHT_WORKER_TASK_DEFINITION_ARN='${workerArn}'
}
acquire_production_scaling_hold() { printf 'HOLD\\n' >> commands.log; }
launch_safe_active_api_preflight() { printf 'LAUNCH-SAFE\\n' >> commands.log; }
wait_for_migration_task_stopped() { printf 'WAIT %s\\n' "$1" >> commands.log; return 0; }
restore_production_scaling_hold() { printf 'RESTORE\\n' >> commands.log; return 0; }
aws() {
  printf 'AWS %s\\n' "$*" >> commands.log
  if [[ "$1 $2" == 'ecr describe-images' ]]; then
    printf '${expectedDigest}\\n'
    return 0
  fi
  if [[ "$1 $2" == 'ecs describe-task-definition' ]]; then
    local task_definition=''
    while [[ $# -gt 0 ]]; do
      if [[ "$1" == '--task-definition' ]]; then task_definition="$2"; break; fi
      shift
    done
    if [[ "$task_definition" == '${apiArn}' ]]; then
      printf '%s\\n' '{"taskDefinitionArn":"${apiArn}","status":"ACTIVE","containerDefinitions":[{"name":"api","image":"135775632425.dkr.ecr.us-east-1.amazonaws.com/schoolpilot-production-api@${expectedDigest}","environment":[]}]}'
    else
      printf '%s\\n' '{"taskDefinitionArn":"${workerArn}","status":"ACTIVE","containerDefinitions":[{"name":"scheduler-worker","image":"135775632425.dkr.ecr.us-east-1.amazonaws.com/schoolpilot-production-api@${expectedDigest}","environment":[]}]}'
    fi
    return 0
  fi
  if [[ "$1 $2" == 'ecs run-task' ]]; then
    printf '%s\\n' '{"failures":[],"tasks":[{"taskArn":"${taskArn}"}]}'
    return 0
  fi
  if [[ "$1 $2" == 'ecs describe-tasks' ]]; then
    printf '%s\\n' '{"failures":[],"tasks":[{"taskArn":"${taskArn}","lastStatus":"STOPPED","taskDefinitionArn":"${apiArn}","containers":[{"name":"api","exitCode":0}]}]}'
    return 0
  fi
  return 91
}
${helperSource}
run_staff_identity_contract_migration_task
`;
    try {
      const result = spawnSync(bashExecutable(), ["-s"], {
        cwd: fixture,
        encoding: "utf8",
        input: script,
      });
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /API and worker services were not mutated/);
      const commands = readFileSync(join(fixture, "commands.log"), "utf8");
      assert.match(commands, /ecr describe-images/);
      assert.match(commands, /ecs run-task/);
      assert.match(commands, /APPLY_STAFF_IDENTITY_CONTRACT_MIGRATIONS[^\n]*true/);
      assert.doesNotMatch(commands, /ecs update-service|ecs register-task-definition|docker/);
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });

  it("documents the exact guarded stage-five invocation and atomic rollback", () => {
    assert.match(
      runbookSource,
      /deploy\.sh production --backend --apply-staff-identity-contracts/,
    );
    assert.match(runbookSource, /one aggregate preflight/i);
    assert.match(runbookSource, /rolls back the entire contract/i);
    assert.match(runbookSource, /single durable migration-ledger marker/i);
  });
});
