import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  collectClasspilotTileAuthorizationPlanLogEvents,
} from "../scripts/read-classpilot-tile-auth-plan-log-events.mjs";
import {
  extractClasspilotTileAuthorizationPlanFailure,
} from "../scripts/extract-classpilot-tile-auth-plan-failure.mjs";

const deploySource = readFileSync(new URL("../scripts/deploy.sh", import.meta.url), "utf8")
  .replace(/\r\n/g, "\n");
const rehearsalReceiptManagerSource = readFileSync(
  new URL(
    "../scripts/manage-classpilot-tile-auth-plan-rehearsal-receipt.mjs",
    import.meta.url
  ),
  "utf8"
).replace(/\r\n/g, "\n");
const libraryBoundary = deploySource.indexOf("# --- Preflight checks ---");
assert.ok(libraryBoundary > 0);
const deployLibrarySource = deploySource.slice(0, libraryBoundary);
const validatorPath = new URL(
  "../scripts/validate-classpilot-tile-auth-plan-evidence.mjs",
  import.meta.url
);
const logBindingResolverPath = new URL(
  "../scripts/resolve-classpilot-tile-auth-plan-log-binding.mjs",
  import.meta.url
);

function bashExecutable(): string {
  if (process.platform !== "win32") return "bash";
  const candidates = [
    "C:\\Program Files\\Git\\bin\\bash.exe",
    "C:\\Program Files\\Git\\usr\\bin\\bash.exe",
    "C:\\Program Files (x86)\\Git\\bin\\bash.exe",
  ];
  return candidates.find(existsSync) ?? "bash";
}

function runDeployHelper(
  body: string,
  easternClock = "1 1200",
  extraEnv: NodeJS.ProcessEnv = {}
) {
  return spawnSync(bashExecutable(), ["-s"], {
    encoding: "utf8",
    input: `
${deployLibrarySource}
RUN_CLASSPILOT_TILE_AUTH_PLAN_GATE=true
RUN_CLASSPILOT_TILE_AUTH_PLAN_REHEARSAL=true
REUSE_CLASSPILOT_TILE_AUTH_PLAN_REHEARSAL=""
EXPECTED_CLASSPILOT_TILE_AUTH_PLAN_REHEARSAL_SHA256=""
production_eastern_weekday_hhmm() { printf '%s\\n' "$TEST_EASTERN_CLOCK"; }
info() { :; }
success() { :; }
warn() { :; }
error() { printf '%s\\n' "$*" >&2; }
${body}
`,
    env: {
      ...process.env,
      TEST_EASTERN_CLOCK: easternClock,
      ...extraEnv,
    },
  });
}

function validReport() {
  const labels = [
    "teacher.live",
    "teacher.history",
    "co_teacher.live",
    "co_teacher.history",
    "office_staff.live",
    "office_staff.history",
  ];
  const queryIdentifier = "-9223372036854775808";
  return {
    status: "passed",
    precheck: { invalidTeachingSessionSchools: 0 },
    samples: 20,
    warmups: 2,
    cohortSize: 40,
    thresholds: {
      p95Ms: 50,
      maxMs: 100,
      tempReadBlocks: 0,
      tempWrittenBlocks: 0,
      subPlanNodes: 0,
      windowAggNodes: 0,
      heartbeatSequentialScanNodes: 0,
      maxHeartbeatRows: 400,
      perPairIndexLimit: true,
    },
    scenarios: labels.map((label, index) => ({
      label,
      cohortSize: 40,
      samples: 20,
      p95Ms: 10 + index,
      maxMs: 20 + index,
      tempReadBlocks: 0,
      tempWrittenBlocks: 0,
      subPlanNodes: 0,
      passed: true,
    })),
    historyFallback: {
      label: "history_fallback",
      cohortSize: 40,
      historyLimit: 10,
      samples: 20,
      p95Ms: 18,
      maxMs: 24,
      tempReadBlocks: 0,
      tempWrittenBlocks: 0,
      subPlanNodes: 0,
      windowAggNodes: 0,
      heartbeatSequentialScanNodes: 0,
      maxReturnedRows: 400,
      perPairIndexLimit: true,
      passed: true,
    },
    historyFallbackSqlIdentity: {
      version: "history-fallback-queryid-v1",
      queryIdentifier,
      queryIdentifierSha256: createHash("sha256")
        .update(queryIdentifier, "utf8")
        .digest("hex"),
      compiledSqlSha256: "a".repeat(64),
      parameterTypeSignatureSha256: "b".repeat(64),
      engineVersion: "16.4",
      schemaIdentitySha256: "c".repeat(64),
      trackIoTiming: true,
    },
  };
}

function validLifecycle() {
  return {
    version: "transactional-plan-scenarios-v2",
    requiredSessionPairs: 80,
    reusedActiveSessionPairs: 0,
    insertedSessionPairs: 80,
    seededRows: {
      groupTeachers: 1,
      teachingSessions: 1,
      supervisionContexts: 1,
      supervisionStudents: 40,
      studentSessions: 80,
      total: 123,
    },
    rollback: {
      attempted: true,
      completed: true,
    },
    residue: {
      checked: true,
      count: 0,
      passed: true,
    },
  };
}

function runValidator(
  report: Record<string, unknown>,
  lifecycle: Record<string, unknown> | null = validLifecycle()
) {
  const input = JSON.stringify({
    events: [
      { message: "non-json startup noise" },
      ...(lifecycle ? [{ message: JSON.stringify(lifecycle) }] : []),
      { message: JSON.stringify(report) },
    ],
  });
  return spawnSync(process.execPath, [fileURLToPath(validatorPath)], {
    encoding: "utf8",
    input,
  });
}

const taskId = "b05a4c81fc274ee98b3f2aa2dc751e05";
const taskArn =
  `arn:aws:ecs:us-east-1:135775632425:task/schoolpilot-production-cluster/${taskId}`;
const taskDefinitionArn =
  "arn:aws:ecs:us-east-1:135775632425:task-definition/schoolpilot-production-api-emergency:19";

function validTaskResult(logStreamName?: unknown) {
  const api: Record<string, unknown> = {
    name: "api",
    lastStatus: "STOPPED",
    exitCode: 0,
  };
  if (arguments.length > 0) api.logStreamName = logStreamName;
  return {
    failures: [],
    tasks: [{
      taskArn,
      taskDefinitionArn,
      lastStatus: "STOPPED",
      containers: [api],
    }],
  };
}

function taskResultWithExitCode(exitCode: number, logStreamName?: unknown) {
  const result = validTaskResult(logStreamName);
  result.tasks[0].containers[0].exitCode = exitCode;
  return result;
}

function runLogBindingResolver(
  taskResult: Record<string, unknown>,
  logConfiguration: Record<string, unknown> = {
    logDriver: "awslogs",
    options: {
      "awslogs-group": "/ecs/schoolpilot-production-api",
      "awslogs-region": "us-east-1",
      "awslogs-stream-prefix": "api",
    },
  },
  expectedTaskArn = taskArn
) {
  const script = `
    import { resolveClasspilotTileAuthorizationPlanLogBinding as resolve } from ${JSON.stringify(
      logBindingResolverPath.href
    )};
    try {
      const result = resolve(JSON.parse(process.env.TEST_BINDING_INPUT));
      process.stdout.write(JSON.stringify(result));
    } catch {
      process.stderr.write("binding_invalid\\n");
      process.exitCode = 1;
    }
  `;
  return spawnSync(process.execPath, ["--input-type=module", "--eval", script], {
    encoding: "utf8",
    env: {
      ...process.env,
      TEST_BINDING_INPUT: JSON.stringify({
        taskResult,
        logConfiguration,
        expectedTaskArn,
        expectedTaskDefinitionArn: taskDefinitionArn,
        expectedRegion: "us-east-1",
        expectedAccountId: "135775632425",
      }),
    },
  });
}

describe("ClassPilot tile authorization deployment gate", () => {
  it("is an explicit production emergency-backend opt-in", () => {
    assert.match(
      deploySource,
      /--classpilot-tile-auth-plan-gate\) RUN_CLASSPILOT_TILE_AUTH_PLAN_GATE=true/
    );
    assert.match(
      deploySource,
      /--classpilot-tile-auth-plan-gate is allowed only with production --backend --activate-emergency/
    );

    const accepted = runDeployHelper(`
ENV=production
DEPLOY_BACKEND=true
DEPLOY_FRONTEND=false
ACTIVATE_EMERGENCY=true
SAME_IMAGE_NETWORKING_STAGE=""
SKIP_WAIT=false
validate_classpilot_tile_auth_plan_gate_mode
`);
    assert.equal(accepted.status, 0, accepted.stderr);

    for (const invalid of [
      "ENV=staging",
      "DEPLOY_FRONTEND=true",
      "ACTIVATE_EMERGENCY=false",
      "SAME_IMAGE_NETWORKING_STAGE=PublicEcs",
      "SKIP_WAIT=true",
    ]) {
      const rejected = runDeployHelper(`
ENV=production
DEPLOY_BACKEND=true
DEPLOY_FRONTEND=false
ACTIVATE_EMERGENCY=true
SAME_IMAGE_NETWORKING_STAGE=""
SKIP_WAIT=false
${invalid}
validate_classpilot_tile_auth_plan_gate_mode
`);
      assert.notEqual(rejected.status, 0, invalid);
      assert.match(rejected.stderr, /allowed only with production --backend --activate-emergency/);
    }
  });

  it("keeps the read-only observation standalone from rehearsal and deployment admission", () => {
    assert.match(
      deploySource,
      /--classpilot-tile-auth-plan-observation\)\s+RUN_CLASSPILOT_TILE_AUTH_PLAN_OBSERVATION=true/
    );
    const accepted = runDeployHelper(`
ENV=production
DEPLOY_BACKEND=true
DEPLOY_FRONTEND=false
ACTIVATE_EMERGENCY=true
SAME_IMAGE_NETWORKING_STAGE=""
SKIP_WAIT=false
RUN_CLASSPILOT_TILE_AUTH_PLAN_GATE=false
RUN_CLASSPILOT_TILE_AUTH_PLAN_REHEARSAL=false
RUN_CLASSPILOT_TILE_AUTH_PLAN_OBSERVATION=true
REUSE_CLASSPILOT_TILE_AUTH_PLAN_REHEARSAL=""
EXPECTED_CLASSPILOT_TILE_AUTH_PLAN_REHEARSAL_SHA256=""
validate_classpilot_tile_auth_plan_gate_mode
`);
    assert.equal(accepted.status, 0, accepted.stderr);

    for (const invalid of [
      "RUN_CLASSPILOT_TILE_AUTH_PLAN_GATE=true",
      "RUN_CLASSPILOT_TILE_AUTH_PLAN_REHEARSAL=true",
      "ENV=staging",
      "DEPLOY_FRONTEND=true",
      "ACTIVATE_EMERGENCY=false",
      "SAME_IMAGE_NETWORKING_STAGE=PublicEcs",
      "SKIP_WAIT=true",
    ]) {
      const rejected = runDeployHelper(`
ENV=production
DEPLOY_BACKEND=true
DEPLOY_FRONTEND=false
ACTIVATE_EMERGENCY=true
SAME_IMAGE_NETWORKING_STAGE=""
SKIP_WAIT=false
RUN_CLASSPILOT_TILE_AUTH_PLAN_GATE=false
RUN_CLASSPILOT_TILE_AUTH_PLAN_REHEARSAL=false
RUN_CLASSPILOT_TILE_AUTH_PLAN_OBSERVATION=true
REUSE_CLASSPILOT_TILE_AUTH_PLAN_REHEARSAL=""
EXPECTED_CLASSPILOT_TILE_AUTH_PLAN_REHEARSAL_SHA256=""
${invalid}
validate_classpilot_tile_auth_plan_gate_mode
`);
      assert.notEqual(rejected.status, 0, invalid);
    }

    const noAdmission = runDeployHelper(`
RUN_CLASSPILOT_TILE_AUTH_PLAN_GATE=false
RUN_CLASSPILOT_TILE_AUTH_PLAN_REHEARSAL=false
RUN_CLASSPILOT_TILE_AUTH_PLAN_OBSERVATION=true
TILE_AUTH_PLAN_REHEARSAL_ATTEMPT_ADMITTED=false
admit_classpilot_tile_auth_plan_rehearsal_attempt
[[ "$TILE_AUTH_PLAN_REHEARSAL_ATTEMPT_ADMITTED" == false ]]
`);
    assert.equal(noAdmission.status, 0, noAdmission.stderr);
  });

  it("stops a base observation before the full gate and every deployment mutation", () => {
    const backendStart = deploySource.indexOf("# BACKEND DEPLOY");
    const candidateRegistration = deploySource.indexOf(
      "register_classpilot_candidate_worker_task_definition",
      backendStart
    );
    const initialize = deploySource.indexOf(
      "initialize_classpilot_tile_auth_plan_observation",
      candidateRegistration
    );
    const observationTask = deploySource.indexOf(
      "run_classpilot_tile_auth_plan_observation_task",
      initialize
    );
    const packet = deploySource.indexOf(
      "write_classpilot_tile_auth_plan_observation_packet_v2",
      observationTask
    );
    const observationStop = deploySource.indexOf(
      'success "Candidate base observation complete;',
      packet
    );
    const observationExit = deploySource.indexOf("exit 0", observationStop);
    const fullGate = deploySource.indexOf(
      "run_classpilot_tile_auth_plan_gate predeploy",
      observationExit
    );
    const hold = deploySource.indexOf(
      "acquire_production_scaling_hold",
      observationExit
    );
    assert.ok(
      backendStart > 0 &&
      candidateRegistration > backendStart &&
      initialize > candidateRegistration &&
      observationTask > initialize &&
      packet > observationTask &&
      observationStop > packet &&
      observationExit > observationStop &&
      fullGate > observationExit &&
      hold > fullGate
    );

    const observationPath = deploySource.slice(backendStart, observationExit);
    assert.doesNotMatch(observationPath, /run_classpilot_tile_auth_plan_gate predeploy/);
    assert.doesNotMatch(observationPath, /write_classpilot_rehearsal_receipt/);
    assert.doesNotMatch(observationPath, /acquire_production_scaling_hold/);
    assert.doesNotMatch(observationPath, /RUN_MIGRATIONS_ONLY","value":"true"/);
    assert.doesNotMatch(observationPath, /^\s*aws ecs update-service/m);
    assert.doesNotMatch(
      observationPath,
      /^\s*(?:aws s3 sync|aws cloudfront create-invalidation)/m
    );
    assert.doesNotMatch(
      observationPath,
      /prepare-classpilot-load-test|refresh-and-snapshot-fixtures|database-insights-lease|load:classpilot/
    );
    assert.match(
      observationPath,
      /initialize_classpilot_tile_auth_plan_observation[\s\S]*run_classpilot_tile_auth_plan_observation_task[\s\S]*capture_classpilot_tile_auth_observation_final_network[\s\S]*capture_classpilot_tile_auth_observation_final_posture[\s\S]*write_classpilot_tile_auth_plan_observation_packet_v2/
    );
    assert.match(
      observationPath,
      /write_classpilot_tile_auth_plan_observation_packet_v2[\s\S]*observation_finalization_result=\$\?[\s\S]*if \[\[ "\$observation_finalization_result" -eq 0 \]\]; then[\s\S]*cleanup_classpilot_tile_auth_plan_observation_controller_workspace[\s\S]*else[\s\S]*Retaining the ACL-private ClassPilot observation controller workspace/
    );
    assert.match(
      deploySource,
      /eligibleForDeployment=false, eligibleForDiagnostic=false, eligibleForCertification=false/
    );
    const preflightImplementation = deploySource.slice(
      deploySource.indexOf("run_classpilot_tile_auth_plan_observation_task() {"),
      deploySource.indexOf(
        "\nrun_classpilot_tile_auth_plan_base_preflight()",
        deploySource.indexOf("run_classpilot_tile_auth_plan_observation_task() {")
      )
    );
    assert.match(
      preflightImplementation,
      /"--preflight-base","--observation-selection"/
    );
    assert.match(
      preflightImplementation,
      /collect-classpilot-tile-auth-plan-observation-evidence\.mjs[\s\S]*--task-result-file "\$TILE_AUTH_PLAN_OBSERVATION_RESULT_PATH"[\s\S]*--log-configuration-file "\$TILE_AUTH_PLAN_OBSERVATION_LOG_CONFIGURATION_PATH"[\s\S]*--expected-task-arn "\$task_arn"[\s\S]*--expected-task-definition-arn "\$API_ROLLOUT_TASK_DEF"[\s\S]*--expected-region "\$REGION"[\s\S]*--expected-account-id "\$ACCOUNT_ID"[\s\S]*--deadline-ms "\$TILE_AUTH_PLAN_OBSERVATION_EVIDENCE_DEADLINE_MS"/
    );
    assert.doesNotMatch(
      preflightImplementation,
      /deadline-monotonic-nanoseconds|evidence_deadline_monotonic_ns/
    );
    assert.doesNotMatch(
      preflightImplementation,
      /resolve-classpilot-tile-auth-plan-log-binding\.mjs/
    );
    assert.equal(
      [...preflightImplementation.matchAll(/aws ecs run-task/g)].length,
      1
    );
    assert.match(
      deploySource,
      /classpilot-tile-auth-plan-observation-v2/
    );
    assert.match(
      deploySource,
      /manage-classpilot-tile-auth-plan-observation\.mjs" write[\s\S]*manage-classpilot-tile-auth-plan-observation\.mjs" inspect/
    );
  });

  it("revalidates the exact candidate network after the observation task", () => {
    const implementation = deploySource.slice(
      deploySource.indexOf(
        "capture_classpilot_tile_auth_observation_final_network() {"
      ),
      deploySource.indexOf(
        "\nassert_classpilot_rehearsal_network_unchanged()",
        deploySource.indexOf(
          "capture_classpilot_tile_auth_observation_final_network() {"
        )
      )
    );
    assert.match(
      implementation,
      /expected_network_sha="\$TILE_AUTH_PLAN_OBSERVATION_INITIAL_NETWORK_SHA256"/
    );
    assert.match(
      implementation,
      /resolve_classpilot_tile_auth_candidate_network/
    );
    assert.match(
      implementation,
      /"network_unavailable"[\s\S]*TILE_AUTH_PLAN_REHEARSAL_NETWORK_SHA256" != "\$expected_network_sha"[\s\S]*"network_drift"[\s\S]*"verified"/
    );
  });

  it("turns a task-start failure into terminal evidence without escaping set -e", () => {
    const result = runDeployHelper(`
RUN_CLASSPILOT_TILE_AUTH_PLAN_GATE=false
RUN_CLASSPILOT_TILE_AUTH_PLAN_REHEARSAL=false
RUN_CLASSPILOT_TILE_AUTH_PLAN_OBSERVATION=true
API_ROLLOUT_TASK_DEF='arn:aws:ecs:us-east-1:135775632425:task-definition/schoolpilot-production-api-emergency:35'
OBSERVATION_TIME_COMPONENT='20260725t220000z'
OBSERVATION_SHA_COMPONENT='abf820cc02b6'
TILE_AUTH_PLAN_OBSERVATION_ID="tile-plan-observe-\${OBSERVATION_TIME_COMPONENT}-\${OBSERVATION_SHA_COMPONENT}"
TILE_AUTH_PLAN_OBSERVATION_ATTEMPT_PATH='observation-attempt.private.json'
TILE_AUTH_PLAN_OBSERVATION_ATTEMPT_SHA256='eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'
LOCAL_SHA='abf820cc02b69599857739afe42f86baacd2351d'
IMAGE_TAG='abf820cc02b6'
NETWORK_CONFIG='awsvpcConfiguration={subnets=[subnet-a],securityGroups=[sg-a],assignPublicIp=DISABLED}'
TILE_AUTH_PLAN_OBSERVATION_TASK_PATH="$(mktemp)"
TILE_AUTH_PLAN_OBSERVATION_RESULT_PATH="$(mktemp)"
TILE_AUTH_PLAN_OBSERVATION_LOG_CONFIGURATION_PATH="$(mktemp)"
production_backend_deploy_window_preflight() { return 0; }
classpilot_tile_auth_plan_window_preflight() { return 0; }
AWS_RUN_TASK_COUNT_FILE="$(mktemp)"
printf '0\\n' > "$AWS_RUN_TASK_COUNT_FILE"
aws() {
  if [[ "$1 $2" == 'ecs run-task' ]]; then
    call_count="$(<"$AWS_RUN_TASK_COUNT_FILE")"
    printf '%s\\n' "$((call_count + 1))" > "$AWS_RUN_TASK_COUNT_FILE"
    return 1
  fi
  return 99
}
run_classpilot_tile_auth_plan_observation_task
[[ "$(<"$AWS_RUN_TASK_COUNT_FILE")" -eq 1 ]]
COLLECTION="$TILE_AUTH_PLAN_OBSERVATION_COLLECTION_JSON" node -e '
  const value = JSON.parse(process.env.COLLECTION);
  if (value.collection.status !== "failed" ||
      value.collection.failureCode !== "terminal_task_unavailable" ||
      value.collection.attemptCount !== 0 ||
      value.collection.rawErrorPersisted !== false ||
      value.eventsDocument !== null) process.exit(1);
'
rm -f "$TILE_AUTH_PLAN_OBSERVATION_TASK_PATH" \
  "$TILE_AUTH_PLAN_OBSERVATION_RESULT_PATH" \
  "$TILE_AUTH_PLAN_OBSERVATION_LOG_CONFIGURATION_PATH" \
  "$AWS_RUN_TASK_COUNT_FILE"
`);
    assert.equal(result.status, 0, result.stderr);
  });

  it("retains the launched task identity when bounded stop cannot recover an exit", () => {
    const result = runDeployHelper(`
RUN_CLASSPILOT_TILE_AUTH_PLAN_GATE=false
RUN_CLASSPILOT_TILE_AUTH_PLAN_REHEARSAL=false
RUN_CLASSPILOT_TILE_AUTH_PLAN_OBSERVATION=true
API_ROLLOUT_TASK_DEF='arn:aws:ecs:us-east-1:135775632425:task-definition/schoolpilot-production-api-emergency:35'
OBSERVATION_TIME_COMPONENT='20260725t220000z'
OBSERVATION_SHA_COMPONENT='abf820cc02b6'
TILE_AUTH_PLAN_OBSERVATION_ID="tile-plan-observe-\${OBSERVATION_TIME_COMPONENT}-\${OBSERVATION_SHA_COMPONENT}"
TILE_AUTH_PLAN_OBSERVATION_ATTEMPT_PATH='observation-attempt.private.json'
TILE_AUTH_PLAN_OBSERVATION_ATTEMPT_SHA256='eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'
LOCAL_SHA='abf820cc02b69599857739afe42f86baacd2351d'
NETWORK_CONFIG='awsvpcConfiguration={subnets=[subnet-a],securityGroups=[sg-a],assignPublicIp=DISABLED}'
TILE_AUTH_PLAN_OBSERVATION_TASK_PATH="$(mktemp)"
TILE_AUTH_PLAN_OBSERVATION_RESULT_PATH="$(mktemp)"
TILE_AUTH_PLAN_OBSERVATION_LOG_CONFIGURATION_PATH="$(mktemp)"
TASK_ARN='arn:aws:ecs:us-east-1:135775632425:task/schoolpilot-production-cluster/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
AWS_RUN_TASK_CALLS=0
wait_for_classpilot_tile_auth_plan_task_stopped() { return 125; }
aws() {
  if [[ "$1 $2" == 'ecs run-task' ]]; then
    AWS_RUN_TASK_CALLS=$((AWS_RUN_TASK_CALLS + 1))
    printf '{"failures":[],"tasks":[{"taskArn":"%s","taskDefinitionArn":"%s"}]}\\n' \
      "$TASK_ARN" "$API_ROLLOUT_TASK_DEF"
    return 0
  fi
  if [[ "$1 $2" == 'ecs describe-tasks' ]]; then
    printf '{"failures":[],"tasks":[{"taskArn":"%s","taskDefinitionArn":"%s","lastStatus":"RUNNING","containers":[{"name":"api","lastStatus":"RUNNING","logStreamName":null}]}]}\\n' \
      "$TASK_ARN" "$API_ROLLOUT_TASK_DEF"
    return 0
  fi
  return 99
}
run_classpilot_tile_auth_plan_observation_task
[[ "$AWS_RUN_TASK_CALLS" -eq 1 ]]
[[ "$TILE_AUTH_PLAN_OBSERVATION_TASK_ARN" == "$TASK_ARN" ]]
[[ "$TILE_AUTH_PLAN_OBSERVATION_TASK_STATE" == 'exit_unavailable' ]]
[[ -z "$TILE_AUTH_PLAN_OBSERVATION_TASK_EXIT_CODE" ]]
COLLECTION="$TILE_AUTH_PLAN_OBSERVATION_COLLECTION_JSON" node -e '
  const value = JSON.parse(process.env.COLLECTION);
  if (value.collection.status !== "failed" ||
      value.collection.failureCode !== "terminal_task_timeout" ||
      value.collection.attemptCount !== 0 ||
      value.eventsDocument !== null) process.exit(1);
'
rm -f "$TILE_AUTH_PLAN_OBSERVATION_TASK_PATH" \
  "$TILE_AUTH_PLAN_OBSERVATION_RESULT_PATH" \
  "$TILE_AUTH_PLAN_OBSERVATION_LOG_CONFIGURATION_PATH"
`);
    assert.equal(result.status, 0, result.stderr);
  });

  it("seals and independently inspects a task-start failure through the observation manager", () => {
    const localAppData = mkdtempSync(
      join(tmpdir(), "schoolpilot-observation-shell-")
    );
    const loadGatesRoot = join(localAppData, "SchoolPilot", "load-gates");
    const scriptDirectory = fileURLToPath(
      new URL("../scripts", import.meta.url)
    );
    try {
      const result = runDeployHelper(`
RUN_CLASSPILOT_TILE_AUTH_PLAN_GATE=false
RUN_CLASSPILOT_TILE_AUTH_PLAN_REHEARSAL=false
RUN_CLASSPILOT_TILE_AUTH_PLAN_OBSERVATION=true
SCRIPT_DIR="$TEST_SCRIPT_DIRECTORY"
cd "$TEST_WORK_DIRECTORY"
LOCAL_SHA='abf820cc02b69599857739afe42f86baacd2351d'
DIGEST='sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
IMAGE_TAG="\${LOCAL_SHA:0:12}"
API_ROLLOUT_TASK_DEF='arn:aws:ecs:us-east-1:135775632425:task-definition/schoolpilot-production-api-emergency:36'
WORKER_CANDIDATE_TASK_DEF='arn:aws:ecs:us-east-1:135775632425:task-definition/schoolpilot-production-scheduler-worker:51'
PRODUCTION_ROLLBACK_API_TASK_DEFINITION='schoolpilot-production-api-emergency:31'
PRODUCTION_ROLLBACK_WORKER_TASK_DEFINITION='schoolpilot-production-scheduler-worker:48'
PRODUCTION_ROLLBACK_API_TASK_DEFINITION_ARN='arn:aws:ecs:us-east-1:135775632425:task-definition/schoolpilot-production-api-emergency:31'
PRODUCTION_ROLLBACK_WORKER_TASK_DEFINITION_ARN='arn:aws:ecs:us-east-1:135775632425:task-definition/schoolpilot-production-scheduler-worker:48'
TILE_AUTH_PLAN_REHEARSAL_NETWORK_SHA256='dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd'
NETWORK_CONFIG='awsvpcConfiguration={subnets=[subnet-a],securityGroups=[sg-a],assignPublicIp=DISABLED}'
production_service_snapshot() {
  printf '%s\\tACTIVE\\t1\\t1\\t0\\t1\\t%s\\t%s\\tCOMPLETED\\n' \
    "$SERVICE" \
    "$PRODUCTION_ROLLBACK_API_TASK_DEFINITION_ARN" \
    "$PRODUCTION_ROLLBACK_API_TASK_DEFINITION_ARN"
  printf '%s\\tACTIVE\\t1\\t1\\t0\\t1\\t%s\\t%s\\tCOMPLETED\\n' \
    "$WORKER_SERVICE" \
    "$PRODUCTION_ROLLBACK_WORKER_TASK_DEFINITION_ARN" \
    "$PRODUCTION_ROLLBACK_WORKER_TASK_DEFINITION_ARN"
}
initialize_classpilot_tile_auth_plan_observation
[[ "$TILE_AUTH_PLAN_OBSERVATION_ATTEMPT_ADMITTED" == true ]]
[[ "$TILE_AUTH_PLAN_OBSERVATION_ATTEMPT_SHA256" =~ ^[a-f0-9]{64}$ ]]
[[ -f "$TILE_AUTH_PLAN_OBSERVATION_ATTEMPT_PATH" ]]
AWS_RUN_TASK_CALLS=0
aws() {
  if [[ "$1 $2" == 'ecs run-task' ]]; then
    AWS_RUN_TASK_CALLS=$((AWS_RUN_TASK_CALLS + 1))
    return 1
  fi
  return 99
}
run_classpilot_tile_auth_plan_observation_task
[[ "$AWS_RUN_TASK_CALLS" -eq 1 ]]
set_classpilot_tile_auth_observation_final_evidence \
  TILE_AUTH_PLAN_OBSERVATION_FINAL_NETWORK_JSON \
  verified "$TILE_AUTH_PLAN_OBSERVATION_INITIAL_NETWORK_SHA256" "" \
  network_unavailable
set_classpilot_tile_auth_observation_final_evidence \
  TILE_AUTH_PLAN_OBSERVATION_FINAL_POSTURE_JSON \
  verified "$TILE_AUTH_PLAN_OBSERVATION_INITIAL_POSTURE_SHA256" "" \
  production_posture_unavailable
set +e
write_classpilot_tile_auth_plan_observation_packet_v2
write_result=$?
set -e
[[ "$write_result" -ne 0 ]]
[[ -f "$TILE_AUTH_PLAN_OBSERVATION_PACKET_PATH" ]]
OBSERVATION_PACKET_PATH="$TILE_AUTH_PLAN_OBSERVATION_PACKET_PATH" \
EXPECTED_ATTEMPT_SHA256="$TILE_AUTH_PLAN_OBSERVATION_ATTEMPT_SHA256" \
node <<'NODE'
const fs = require("fs");
const packet = JSON.parse(
  fs.readFileSync(process.env.OBSERVATION_PACKET_PATH, "utf8")
);
if (packet?.schemaVersion !== 2 ||
    packet?.version !== "classpilot-tile-auth-plan-observation-v2" ||
    packet?.observationOutcome !== "evidence_unavailable" ||
    packet?.terminalTask !== null ||
    packet?.collection?.status !== "failed" ||
    packet?.collection?.failureCode !== "terminal_task_unavailable" ||
    packet?.collection?.attemptCount !== 0 ||
    packet?.collection?.rawErrorPersisted !== false ||
    packet?.attemptRecordSha256 !== process.env.EXPECTED_ATTEMPT_SHA256 ||
    packet?.eligibleForDeployment !== false ||
    packet?.eligibleForDiagnostic !== false ||
    packet?.eligibleForCertification !== false) {
  process.exit(1);
}
NODE
cleanup_classpilot_tile_auth_plan_observation_controller_workspace
`, "1 1200", {
        LOCALAPPDATA: localAppData,
        NODE_ENV: "test",
        CLP_LOAD_FIXTURE_TEST_MODE: "1",
        CLP_LOAD_GATES_TEST_ROOT: loadGatesRoot,
        TEST_SCRIPT_DIRECTORY: scriptDirectory,
        TEST_WORK_DIRECTORY: localAppData,
      });
      assert.equal(result.status, 0, result.stderr);
    } finally {
      rmSync(localAppData, { recursive: true, force: true });
    }
  });

  it("retains the attempt hash and seals when the admit summary fails independent inspection", () => {
    const localAppData = mkdtempSync(
      join(tmpdir(), "schoolpilot-observation-attempt-inspect-")
    );
    const loadGatesRoot = join(localAppData, "SchoolPilot", "load-gates");
    const scriptDirectory = fileURLToPath(
      new URL("../scripts", import.meta.url)
    );
    try {
      const result = runDeployHelper(`
RUN_CLASSPILOT_TILE_AUTH_PLAN_GATE=false
RUN_CLASSPILOT_TILE_AUTH_PLAN_REHEARSAL=false
RUN_CLASSPILOT_TILE_AUTH_PLAN_OBSERVATION=true
SCRIPT_DIR="$TEST_SCRIPT_DIRECTORY"
cd "$TEST_WORK_DIRECTORY"
LOCAL_SHA='abf820cc02b69599857739afe42f86baacd2351d'
DIGEST='sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
API_ROLLOUT_TASK_DEF='arn:aws:ecs:us-east-1:135775632425:task-definition/schoolpilot-production-api-emergency:36'
WORKER_CANDIDATE_TASK_DEF='arn:aws:ecs:us-east-1:135775632425:task-definition/schoolpilot-production-scheduler-worker:51'
PRODUCTION_ROLLBACK_API_TASK_DEFINITION='schoolpilot-production-api-emergency:31'
PRODUCTION_ROLLBACK_WORKER_TASK_DEFINITION='schoolpilot-production-scheduler-worker:48'
PRODUCTION_ROLLBACK_API_TASK_DEFINITION_ARN='arn:aws:ecs:us-east-1:135775632425:task-definition/schoolpilot-production-api-emergency:31'
PRODUCTION_ROLLBACK_WORKER_TASK_DEFINITION_ARN='arn:aws:ecs:us-east-1:135775632425:task-definition/schoolpilot-production-scheduler-worker:48'
TILE_AUTH_PLAN_REHEARSAL_NETWORK_SHA256='dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd'
production_service_snapshot() {
  printf '%s\\tACTIVE\\t1\\t1\\t0\\t1\\t%s\\t%s\\tCOMPLETED\\n' \
    "$SERVICE" \
    "$PRODUCTION_ROLLBACK_API_TASK_DEFINITION_ARN" \
    "$PRODUCTION_ROLLBACK_API_TASK_DEFINITION_ARN"
  printf '%s\\tACTIVE\\t1\\t1\\t0\\t1\\t%s\\t%s\\tCOMPLETED\\n' \
    "$WORKER_SERVICE" \
    "$PRODUCTION_ROLLBACK_WORKER_TASK_DEFINITION_ARN" \
    "$PRODUCTION_ROLLBACK_WORKER_TASK_DEFINITION_ARN"
}
node() {
  if [[ "$*" == *'manage-classpilot-tile-auth-plan-observation.mjs admit'* ]]; then
    command node "$@" | command node -e '
      let input = "";
      process.stdin.setEncoding("utf8");
      process.stdin.on("data", chunk => { input += chunk; });
      process.stdin.on("end", () => {
        const value = JSON.parse(input);
        value.path += ".mismatch";
        process.stdout.write(JSON.stringify(value));
      });
    '
  else
    command node "$@"
  fi
}
initialize_classpilot_tile_auth_plan_observation
[[ "$TILE_AUTH_PLAN_OBSERVATION_ATTEMPT_ADMITTED" == true ]]
[[ "$TILE_AUTH_PLAN_OBSERVATION_INITIALIZATION_FAILED" == true ]]
[[ "$TILE_AUTH_PLAN_OBSERVATION_ATTEMPT_SHA256" =~ ^[a-f0-9]{64}$ ]]
[[ -f "$TILE_AUTH_PLAN_OBSERVATION_ATTEMPT_PATH" ]]
set_classpilot_tile_auth_observation_final_evidence \
  TILE_AUTH_PLAN_OBSERVATION_FINAL_NETWORK_JSON \
  verified "$TILE_AUTH_PLAN_OBSERVATION_INITIAL_NETWORK_SHA256" "" \
  network_unavailable
set_classpilot_tile_auth_observation_final_evidence \
  TILE_AUTH_PLAN_OBSERVATION_FINAL_POSTURE_JSON \
  verified "$TILE_AUTH_PLAN_OBSERVATION_INITIAL_POSTURE_SHA256" "" \
  production_posture_unavailable
set +e
write_classpilot_tile_auth_plan_observation_packet_v2
write_result=$?
set -e
[[ "$write_result" -ne 0 ]]
[[ -f "$TILE_AUTH_PLAN_OBSERVATION_PACKET_PATH" ]]
PACKET="$TILE_AUTH_PLAN_OBSERVATION_PACKET_PATH" node -e '
  const fs = require("fs");
  const packet = JSON.parse(fs.readFileSync(process.env.PACKET, "utf8"));
  if (packet.observationOutcome !== "evidence_unavailable" ||
      packet.collection.failureCode !== "terminal_task_unavailable" ||
      packet.collection.attemptCount !== 0 ||
      packet.terminalTask !== null) process.exit(1);
'
`, "1 1200", {
        LOCALAPPDATA: localAppData,
        NODE_ENV: "test",
        CLP_LOAD_FIXTURE_TEST_MODE: "1",
        CLP_LOAD_GATES_TEST_ROOT: loadGatesRoot,
        TEST_SCRIPT_DIRECTORY: scriptDirectory,
        TEST_WORK_DIRECTORY: localAppData,
      });
      assert.equal(result.status, 0, result.stderr);
    } finally {
      rmSync(localAppData, { recursive: true, force: true });
    }
  });

  it("hashes only a stable exact serving posture into observation evidence", () => {
    const apiArn =
      "arn:aws:ecs:us-east-1:135775632425:task-definition/schoolpilot-production-api-emergency:31";
    const workerArn =
      "arn:aws:ecs:us-east-1:135775632425:task-definition/schoolpilot-production-scheduler-worker:48";
    const accepted = runDeployHelper(`
RUN_CLASSPILOT_TILE_AUTH_PLAN_GATE=false
RUN_CLASSPILOT_TILE_AUTH_PLAN_REHEARSAL=false
RUN_CLASSPILOT_TILE_AUTH_PLAN_OBSERVATION=true
snapshot="$(printf '%s\\tACTIVE\\t1\\t1\\t0\\t1\\t%s\\t%s\\tCOMPLETED\\n' "$SERVICE" '${apiArn}' '${apiArn}'; printf '%s\\tACTIVE\\t1\\t1\\t0\\t1\\t%s\\t%s\\tCOMPLETED\\n' "$WORKER_SERVICE" '${workerArn}' '${workerArn}')"
posture_sha="$(classpilot_tile_auth_observation_posture_sha256 "$snapshot")"
[[ "$posture_sha" =~ ^[a-f0-9]{64}$ ]]
`);
    assert.equal(accepted.status, 0, accepted.stderr);

    const drifted = runDeployHelper(`
RUN_CLASSPILOT_TILE_AUTH_PLAN_GATE=false
RUN_CLASSPILOT_TILE_AUTH_PLAN_REHEARSAL=false
RUN_CLASSPILOT_TILE_AUTH_PLAN_OBSERVATION=true
PRODUCTION_ROLLBACK_API_TASK_DEFINITION='schoolpilot-production-api-emergency:31'
PRODUCTION_ROLLBACK_WORKER_TASK_DEFINITION='schoolpilot-production-scheduler-worker:48'
production_service_snapshot() {
  printf '%s\\tACTIVE\\t1\\t1\\t0\\t1\\t%s\\t%s\\tCOMPLETED\\n' "$SERVICE" '${apiArn.replace(":31", ":32")}' '${apiArn.replace(":31", ":32")}'
  printf '%s\\tACTIVE\\t1\\t1\\t0\\t1\\t%s\\t%s\\tCOMPLETED\\n' "$WORKER_SERVICE" '${workerArn}' '${workerArn}'
}
capture_classpilot_tile_auth_observation_final_posture
[[ "$TILE_AUTH_PLAN_OBSERVATION_FINAL_POSTURE_JSON" == *'"status":"failed"'* ]]
[[ "$TILE_AUTH_PLAN_OBSERVATION_FINAL_POSTURE_JSON" == *'"failureCode":"production_posture_drift"'* ]]
`);
    assert.equal(drifted.status, 0, drifted.stderr);
  });

  it("blocks only the actual 01:15-02:15 Eastern maintenance window", () => {
    for (const clock of ["1 0115", "7 0130", "3 0200", "5 0214"]) {
      const result = runDeployHelper("classpilot_tile_auth_plan_window_preflight", clock);
      assert.notEqual(result.status, 0, clock);
      assert.match(result.stderr, /01:15-02:15 America\/New_York/);
    }
    for (const clock of ["1 0114", "1 0215", "6 1230", "7 2359"]) {
      const result = runDeployHelper("classpilot_tile_auth_plan_window_preflight", clock);
      assert.equal(result.status, 0, `${clock}: ${result.stderr}`);
    }
  });

  it("runs the exact new revision before hold, migration, and service mutation", () => {
    const backendStart = deploySource.indexOf("# BACKEND DEPLOY");
    const network = deploySource.indexOf(
      "resolve_classpilot_tile_auth_candidate_network",
      backendStart
    );
    const rolloutStart = deploySource.indexOf('API_ROLLOUT_TASK_DEF="${NAME}-api:${NEW_REV}"');
    const candidateRegistration = deploySource.indexOf(
      "register_classpilot_candidate_worker_task_definition",
      rolloutStart
    );
    const finalDeployWindow = deploySource.indexOf(
      'production_backend_deploy_window_preflight "before ClassPilot plan-gate execution"',
      candidateRegistration
    );
    const basePreflight = deploySource.indexOf(
      "run_classpilot_tile_auth_plan_base_preflight",
      finalDeployWindow
    );
    const gate = deploySource.indexOf(
      "run_classpilot_tile_auth_plan_gate predeploy",
      rolloutStart
    );
    const hold = deploySource.indexOf("acquire_production_scaling_hold", gate);
    const migration = deploySource.indexOf('info "Running startup migrations', hold);
    const update = deploySource.indexOf("aws ecs update-service", migration);
    assert.ok(network > backendStart && network < rolloutStart);
    assert.ok(
      rolloutStart < candidateRegistration &&
      candidateRegistration < finalDeployWindow &&
      finalDeployWindow < basePreflight &&
      basePreflight < gate
    );
    assert.ok(rolloutStart < gate && gate < hold && hold < migration && migration < update);

    const implementationStart = deploySource.indexOf("run_classpilot_tile_auth_plan_gate() {");
    const implementationEnd = deploySource.indexOf("\nlaunch_safe_active_api_preflight()", implementationStart);
    const implementation = deploySource.slice(implementationStart, implementationEnd);
    assert.match(implementation, /--task-definition "\$API_ROLLOUT_TASK_DEF"/);
    assert.match(implementation, /--count 1/);
    assert.match(
      implementation,
      /"command":\["node","dist\/cli\/checkClasspilotTileAuthorizationPlans\.js","--execute"\]/
    );
    assert.match(implementation, /"name":"RUN_MIGRATIONS_ON_STARTUP","value":"false"/);
    assert.match(implementation, /"name":"RUN_MIGRATIONS_ONLY","value":"false"/);
    assert.match(implementation, /"name":"SCHEDULER_ENABLED","value":"false"/);
    assert.doesNotMatch(implementation, /--samples/);
    assert.match(implementation, /TILE_AUTH_PLAN_TASK_WAIT_SECONDS=|900-second controller deadline/);
    assert.match(implementation, /validate-classpilot-tile-auth-plan-evidence\.mjs/);
    assert.match(implementation, /resolve-classpilot-tile-auth-plan-log-binding\.mjs/);
    assert.doesNotMatch(implementation, /tile-auth-plan-events|cat .*log/);
    assert.doesNotMatch(implementation, /describe-log-streams|filter-log-events/);
    assert.match(
      implementation,
      /read-classpilot-tile-auth-plan-log-events\.mjs[\s\S]*printf '%s' "\$events_json" \|/
    );
    assert.doesNotMatch(implementation, /get-log-events[\s\S]*--limit 100(?:\s|\\)/);
  });

  it("rechecks the exact active revision after convergence and rolls back on drift", () => {
    const postGate = deploySource.indexOf(
      "run_classpilot_tile_auth_plan_gate postdeploy"
    );
    const strict = deploySource.lastIndexOf(
      "wait_for_production_backend_strict_stability",
      postGate
    );
    const restore = deploySource.indexOf(
      "restore_production_scaling_hold",
      postGate
    );
    assert.ok(strict > 0 && strict < postGate && postGate < restore);
    assert.match(
      deploySource,
      /if ! run_classpilot_tile_auth_plan_gate postdeploy; then[\s\S]*rollback_classpilot_tile_auth_deployment/
    );
    assert.match(
      deploySource,
      /rollback_classpilot_tile_auth_deployment\(\)[\s\S]*--task-definition "\$PRODUCTION_ROLLBACK_API_TASK_DEFINITION"[\s\S]*--task-definition "\$PRODUCTION_ROLLBACK_WORKER_TASK_DEFINITION"[\s\S]*wait_for_production_backend_strict_stability/
    );
  });

  it("keeps rollback identities immutable when strict convergence refreshes preflight state", () => {
    const result = runDeployHelper(`
ENV=production
DEPLOY_BACKEND=true
PRODUCTION_SCALING_HOLD_ACTIVE=false
CLUSTER=schoolpilot-production-cluster
SERVICE=schoolpilot-production-api
WORKER_SERVICE=schoolpilot-production-scheduler-worker
REGION=us-east-1
PRODUCTION_ROLLBACK_API_TASK_DEFINITION=schoolpilot-production-api-emergency:18
PRODUCTION_ROLLBACK_WORKER_TASK_DEFINITION=schoolpilot-production-scheduler-worker:27
# Reproduce the mutation performed by validate_production_service_snapshot
# after the new revisions reach strict convergence.
PRODUCTION_PREFLIGHT_API_TASK_DEFINITION=schoolpilot-production-api-emergency:19
PRODUCTION_PREFLIGHT_WORKER_TASK_DEFINITION=schoolpilot-production-scheduler-worker:28
capture_path="$(mktemp)"
aws() { printf '%s\\n' "$*" >> "$capture_path"; }
wait_for_production_backend_strict_stability() {
  printf 'strict %s %s\\n' "$1" "$2" >> "$capture_path"
  return 0
}
rollback_classpilot_tile_auth_deployment
cat "$capture_path"
rm -f "$capture_path"
`);
    assert.equal(result.status, 0, result.stderr);
    assert.match(
      result.stdout,
      /update-service --cluster schoolpilot-production-cluster --service schoolpilot-production-api --task-definition schoolpilot-production-api-emergency:18/
    );
    assert.match(
      result.stdout,
      /update-service --cluster schoolpilot-production-cluster --service schoolpilot-production-scheduler-worker --task-definition schoolpilot-production-scheduler-worker:27/
    );
    assert.match(
      result.stdout,
      /strict schoolpilot-production-api-emergency:18 schoolpilot-production-scheduler-worker:27/
    );
    assert.doesNotMatch(result.stdout, /task-definition schoolpilot-production-scheduler-worker:28/);
  });

  it("seals the raw query identifier only through the private receipt writer", () => {
    assert.match(
      deploySource,
      /write-classpilot-history-fallback-identity-receipt\.mjs/
    );
    assert.match(
      deploySource,
      /TILE_AUTH_PLAN_PRE_IDENTITY_SHA256[\s\S]*TILE_AUTH_PLAN_PRE_QUERY_IDENTIFIER_SHA256/
    );
    assert.match(
      deploySource,
      /historyFallbackIdentityReceiptPathSha256=\$\{TILE_AUTH_PLAN_IDENTITY_RECEIPT_PATH_SHA256\}/
    );
    assert.match(
      deploySource,
      /const pathSha = require\("crypto"\)\.createHash\("sha256"\)[\s\S]*\.update\(summary\.path, "utf8"\)/
    );
    assert.doesNotMatch(
      deploySource,
      /historyFallbackIdentityReceipt=\$\{TILE_AUTH_PLAN_IDENTITY_RECEIPT_PATH\}/
    );
    assert.doesNotMatch(
      deploySource,
      /success .*TILE_AUTH_PLAN_IDENTITY_RECEIPT_PATH\}/
    );
    assert.doesNotMatch(
      deploySource,
      /success .*queryIdentifier=\$\{?/
    );
  });

  it("derives the exact awslogs stream when ECS omits logStreamName", () => {
    for (const taskResult of [validTaskResult(), validTaskResult(null)]) {
      const result = runLogBindingResolver(taskResult);
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(JSON.parse(result.stdout), {
        logGroup: "/ecs/schoolpilot-production-api",
        logRegion: "us-east-1",
        logPrefix: "api",
        logStream: `api/api/${taskId}`,
        exitCode: 0,
      });
    }
  });

  it("returns before starting a plan task when the window preflight rejects", () => {
    const result = runDeployHelper(`
REGION=us-east-1
ACCOUNT_ID=123456789012
NAME=schoolpilot-production
CLUSTER=schoolpilot-production-cluster
API_ROLLOUT_TASK_DEF=arn:aws:ecs:us-east-1:123456789012:task-definition/schoolpilot-production-api-emergency:41
IMAGE_TAG=abcdef123456
NETWORK_CONFIG='awsvpcConfiguration={subnets=[subnet-a],securityGroups=[sg-a],assignPublicIp=DISABLED}'
attempt_path="$(mktemp)"
rm -f "$attempt_path"
classpilot_tile_auth_plan_window_preflight() { return 1; }
aws() {
  printf 'aws_was_called\\n' > "$attempt_path"
  return 1
}
if run_classpilot_tile_auth_plan_gate predeploy; then
  printf 'window_rejection_was_accepted\\n' >&2
  exit 99
fi
if [[ -e "$attempt_path" ]]; then
  printf 'plan_task_started_after_window_rejection\\n' >&2
  exit 98
fi
`);
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(
      result.stderr,
      /window_rejection_was_accepted|plan_task_started_after_window_rejection/
    );
  });

  it("rechecks the weekday deploy window inside both production gate tasks", () => {
    const result = runDeployHelper(`
REGION=us-east-1
ACCOUNT_ID=123456789012
NAME=schoolpilot-production
CLUSTER=schoolpilot-production-cluster
API_ROLLOUT_TASK_DEF=arn:aws:ecs:us-east-1:123456789012:task-definition/schoolpilot-production-api-emergency:41
IMAGE_TAG=abcdef123456
NETWORK_CONFIG='awsvpcConfiguration={subnets=[subnet-a],securityGroups=[sg-a],assignPublicIp=DISABLED}'
attempt_path="$(mktemp)"
rm -f "$attempt_path"
production_backend_deploy_window_preflight() { return 1; }
classpilot_tile_auth_plan_window_preflight() { return 0; }
aws() {
  printf 'aws_was_called\\n' > "$attempt_path"
  return 1
}
if run_classpilot_tile_auth_plan_base_preflight; then
  printf 'base_preflight_window_rejection_was_accepted\\n' >&2
  exit 99
fi
if run_classpilot_tile_auth_plan_gate predeploy; then
  printf 'plan_gate_window_rejection_was_accepted\\n' >&2
  exit 98
fi
if [[ -e "$attempt_path" ]]; then
  printf 'gate_task_started_after_deploy_window_rejection\\n' >&2
  exit 97
fi
`);
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(
      result.stderr,
      /window_rejection_was_accepted|gate_task_started_after_deploy_window_rejection/
    );
  });

  it("leaves ordinary non-gated backend mode eligible for the standard API family", () => {
    const accepted = runDeployHelper(`
RUN_CLASSPILOT_TILE_AUTH_PLAN_GATE=false
RUN_CLASSPILOT_TILE_AUTH_PLAN_REHEARSAL=false
RUN_CLASSPILOT_TILE_AUTH_PLAN_OBSERVATION=false
REUSE_CLASSPILOT_TILE_AUTH_PLAN_REHEARSAL=""
EXPECTED_CLASSPILOT_TILE_AUTH_PLAN_REHEARSAL_SHA256=""
ENV=production
DEPLOY_BACKEND=true
DEPLOY_FRONTEND=false
ACTIVATE_EMERGENCY=false
SAME_IMAGE_NETWORKING_STAGE=""
SKIP_WAIT=false
validate_classpilot_tile_auth_plan_gate_mode
`);
    assert.equal(accepted.status, 0, accepted.stderr);
    assert.match(
      deploySource,
      /register_classpilot_candidate_worker_task_definition[\s\S]*if \[\[ "\$RUN_CLASSPILOT_TILE_AUTH_PLAN_GATE" == true \|\|[\s\S]*"\$RUN_CLASSPILOT_TILE_AUTH_PLAN_OBSERVATION" == true \]\]; then\s+verify_classpilot_rehearsed_candidates/
    );
  });

  it("renders candidates only from exact serving revisions when higher inactive revisions exist", () => {
    const servingApi =
      "arn:aws:ecs:us-east-1:135775632425:task-definition/schoolpilot-production-api-emergency:29";
    const servingWorker =
      "arn:aws:ecs:us-east-1:135775632425:task-definition/schoolpilot-production-scheduler-worker:46";
    const result = runDeployHelper(`
ENV=production
DEPLOY_BACKEND=true
REGION=us-east-1
ACCOUNT_ID=135775632425
SERVICE=schoolpilot-production-api
WORKER_SERVICE=schoolpilot-production-scheduler-worker
PRODUCTION_ROLLBACK_API_TASK_DEFINITION=schoolpilot-production-api-emergency:29
PRODUCTION_ROLLBACK_WORKER_TASK_DEFINITION=schoolpilot-production-scheduler-worker:46
PRODUCTION_PREFLIGHT_API_TASK_DEFINITION=schoolpilot-production-api-emergency:29
PRODUCTION_PREFLIGHT_WORKER_TASK_DEFINITION=schoolpilot-production-scheduler-worker:46
PRODUCTION_ROLLBACK_API_TASK_DEFINITION_ARN=${servingApi}
PRODUCTION_ROLLBACK_WORKER_TASK_DEFINITION_ARN=${servingWorker}
PRODUCTION_PREFLIGHT_API_TASK_DEFINITION_ARN=${servingApi}
PRODUCTION_PREFLIGHT_WORKER_TASK_DEFINITION_ARN=${servingWorker}
capture_path="$(mktemp)"
aws() {
  printf '%s\\n' "$*" >> "$capture_path"
  local ref=""
  while [[ $# -gt 0 ]]; do
    if [[ "$1" == "--task-definition" ]]; then
      ref="$2"
      break
    fi
    shift
  done
  case "$ref" in
    ${servingApi})
      printf '%s\\n' '{"taskDefinitionArn":"${servingApi}","revision":29,"status":"ACTIVE"}'
      ;;
    ${servingWorker})
      printf '%s\\n' '{"taskDefinitionArn":"${servingWorker}","revision":46,"status":"ACTIVE"}'
      ;;
    schoolpilot-production-api|schoolpilot-production-api-emergency)
      printf '%s\\n' '{"taskDefinitionArn":"arn:aws:ecs:us-east-1:135775632425:task-definition/schoolpilot-production-api:999","revision":999,"status":"ACTIVE"}'
      ;;
    schoolpilot-production-scheduler-worker)
      printf '%s\\n' '{"taskDefinitionArn":"arn:aws:ecs:us-east-1:135775632425:task-definition/schoolpilot-production-scheduler-worker:999","revision":999,"status":"ACTIVE"}'
      ;;
    *)
      return 1
      ;;
  esac
}
resolve_classpilot_candidate_source_task_definitions
describe_exact_classpilot_candidate_task_definition \
  "$API_CANDIDATE_SOURCE_TASK_DEFINITION_ARN" .candidate-api-source.json
describe_exact_classpilot_candidate_task_definition \
  "$WORKER_CANDIDATE_SOURCE_TASK_DEFINITION_ARN" .candidate-worker-source.json
printf 'api=%s\\nworker=%s\\n' \
  "$API_CANDIDATE_SOURCE_TASK_DEFINITION_ARN" \
  "$WORKER_CANDIDATE_SOURCE_TASK_DEFINITION_ARN"
cat "$capture_path"
rm -f "$capture_path" .candidate-api-source.json .candidate-worker-source.json
`);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, new RegExp(`api=${servingApi}`));
    assert.match(result.stdout, new RegExp(`worker=${servingWorker}`));
    assert.match(result.stdout, new RegExp(`--task-definition ${servingApi}`));
    assert.match(result.stdout, new RegExp(`--task-definition ${servingWorker}`));
    assert.doesNotMatch(result.stdout, /:999/);

    const candidateRenderStart = deploySource.indexOf(
      "resolve_classpilot_candidate_source_task_definitions()"
    );
    const candidateRenderEnd = deploySource.indexOf(
      "if [[ \"$RUN_CLASSPILOT_TILE_AUTH_PLAN_REHEARSAL\" == true ]]",
      deploySource.indexOf("# BACKEND DEPLOY")
    );
    const candidateRender = deploySource.slice(candidateRenderStart, candidateRenderEnd);
    assert.doesNotMatch(
      candidateRender,
      /describe-task-definition[\s\S]{0,200}--task-definition "\$WORKER_SERVICE"/
    );
    assert.doesNotMatch(
      candidateRender,
      /describe-task-definition[\s\S]{0,200}--task-definition "\$\{NAME\}-api"/
    );
    assert.match(
      candidateRender,
      /API_FAMILY="\$\{NAME\}-api"[\s\S]*td\.family = process\.env\.API_FAMILY/
    );
  });

  it("stops a gate-only rehearsal before every prohibited deployment mutation", () => {
    const backendStart = deploySource.indexOf("# BACKEND DEPLOY");
    const rehearsalStop = deploySource.indexOf(
      'success "Candidate gate-only rehearsal complete;',
      backendStart
    );
    const rehearsalExit = deploySource.indexOf("exit 0", rehearsalStop);
    const hold = deploySource.indexOf("acquire_production_scaling_hold", rehearsalExit);
    const migration = deploySource.indexOf(
      'info "Running startup migrations',
      rehearsalExit
    );
    const serviceUpdate = deploySource.indexOf(
      "aws ecs update-service",
      rehearsalExit
    );
    assert.ok(
      backendStart > 0 &&
      rehearsalStop > backendStart &&
      rehearsalExit > rehearsalStop &&
      hold > rehearsalExit &&
      migration > hold &&
      serviceUpdate > migration
    );

    const admittedGateOnlyPath = deploySource.slice(backendStart, rehearsalExit);
    assert.doesNotMatch(admittedGateOnlyPath, /acquire_production_scaling_hold/);
    assert.doesNotMatch(admittedGateOnlyPath, /RUN_MIGRATIONS_ONLY/);
    assert.doesNotMatch(admittedGateOnlyPath, /^\s*aws ecs update-service/m);
    assert.doesNotMatch(
      admittedGateOnlyPath,
      /^\s*(?:aws s3 sync|aws cloudfront create-invalidation)/m
    );
    assert.doesNotMatch(
      admittedGateOnlyPath,
      /prepare-classpilot-load-test|refresh-and-snapshot-fixtures|start-waf800-batch-diagnostic/
    );
    assert.doesNotMatch(
      admittedGateOnlyPath,
      /database-insights-lease|aws ssm start-automation-execution|load:classpilot/
    );
    assert.doesNotMatch(
      admittedGateOnlyPath,
      /(?:^|\s)terraform\s+(?:apply|import|state)|aws rds modify-db-instance/
    );
    assert.doesNotMatch(
      admittedGateOnlyPath,
      /aws elasticache modify|aws wafv2 (?:update|delete|create)/
    );
    assert.match(
      admittedGateOnlyPath,
      /run_classpilot_tile_auth_plan_base_preflight[\s\S]*run_classpilot_tile_auth_plan_gate predeploy[\s\S]*write_classpilot_rehearsal_receipt/
    );
  });

  it("durably admits exactly one rehearsal attempt and seals every terminal path", () => {
    const backendStart = deploySource.indexOf("# BACKEND DEPLOY");
    const admission = deploySource.indexOf(
      "admit_classpilot_tile_auth_plan_rehearsal_attempt",
      backendStart
    );
    const candidateNetwork = deploySource.indexOf(
      "resolve_classpilot_tile_auth_candidate_network",
      admission
    );
    const build = deploySource.indexOf('info "Building Docker image', admission);
    const receipt = deploySource.indexOf(
      "write_classpilot_rehearsal_receipt",
      build
    );
    const passedTerminal = deploySource.indexOf(
      "seal_classpilot_tile_auth_plan_rehearsal_terminal passed",
      receipt
    );
    const rehearsalExit = deploySource.indexOf("exit 0", passedTerminal);
    assert.ok(
      admission > backendStart &&
      candidateNetwork > admission &&
      build > candidateNetwork &&
      receipt > build &&
      passedTerminal > receipt &&
      rehearsalExit > passedTerminal
    );
    assert.match(
      deploySource,
      /deploy_exit_cleanup\(\)[\s\S]*TILE_AUTH_PLAN_REHEARSAL_ATTEMPT_ADMITTED[\s\S]*seal_classpilot_tile_auth_plan_rehearsal_terminal failed/
    );
    assert.match(
      deploySource,
      /manage-classpilot-tile-auth-plan-rehearsal-receipt\.mjs" admit/
    );
    assert.match(
      deploySource,
      /manage-classpilot-tile-auth-plan-rehearsal-receipt\.mjs"[\s\S]*terminal[\s\S]*--expected-admission-sha256/
    );
  });

  it("binds guarded reuse to one Windows execution authority and last-moment expiry", () => {
    assert.match(
      rehearsalReceiptManagerSource,
      /classpilot-tile-auth-plan-execution-authority-v1/
    );
    assert.match(
      rehearsalReceiptManagerSource,
      /MachineGuid[\s\S]*whoami\.exe[\s\S]*userSid/
    );
    assert.match(
      rehearsalReceiptManagerSource,
      /executionAuthoritySha256/
    );
    const consumeStart = rehearsalReceiptManagerSource.indexOf(
      "export function consumeClasspilotTileAuthorizationPlanRehearsalReceipt"
    );
    const finalAuthority = rehearsalReceiptManagerSource.indexOf(
      "resolveClasspilotTileAuthorizationPlanExecutionAuthority()",
      consumeStart
    );
    const preparedDirectory = rehearsalReceiptManagerSource.indexOf(
      "const consumptionDirectory = preparePrivateOutputDirectory(",
      finalAuthority
    );
    const preliminaryFreshness = rehearsalReceiptManagerSource.indexOf(
      'runTestConsumptionHook(expected, "before-preliminary-timestamp")',
      preparedDirectory
    );
    const atomicReservation = rehearsalReceiptManagerSource.indexOf(
      "const reservation = reserveConsumptionMarker(consumptionDirectory)",
      preliminaryFreshness
    );
    const commitCall = rehearsalReceiptManagerSource.indexOf(
      "const marker = commitConsumptionMarker(",
      atomicReservation
    );
    const commitStart = rehearsalReceiptManagerSource.indexOf(
      "function commitConsumptionMarker("
    );
    const finalPostReservationHook = rehearsalReceiptManagerSource.indexOf(
      '"before-final-post-reservation-timestamp"',
      commitStart
    );
    const finalConsumedAt = rehearsalReceiptManagerSource.indexOf(
      "const consumedAtUtc = requireReceiptFreshAtConsumption(",
      finalPostReservationHook
    );
    const privateAcl = rehearsalReceiptManagerSource.indexOf(
      "restrictPrivateOutputArtifact(reservation.target)",
      finalConsumedAt
    );
    assert.ok(
      consumeStart > 0 &&
      finalAuthority > consumeStart &&
      preparedDirectory > finalAuthority &&
      preliminaryFreshness > preparedDirectory &&
      atomicReservation > preliminaryFreshness &&
      commitCall > atomicReservation &&
      commitStart > 0 &&
      finalPostReservationHook > commitStart &&
      finalConsumedAt > finalPostReservationHook &&
      privateAcl > finalConsumedAt
    );
    const preReservationWindow = rehearsalReceiptManagerSource.slice(
      preliminaryFreshness,
      atomicReservation
    );
    const postReservationWindow = rehearsalReceiptManagerSource.slice(
      finalConsumedAt,
      privateAcl
    );
    assert.doesNotMatch(
      preReservationWindow,
      /resolveClasspilotTileAuthorizationPlanExecutionAuthority|preparePrivateOutputDirectory/
    );
    assert.doesNotMatch(postReservationWindow, /restrictPrivateOutputArtifact/);
    assert.doesNotMatch(
      rehearsalReceiptManagerSource,
      /executionAuthority(?:Host|Hostname|MachineGuid|UserSid)/
    );
  });

  it("revalidates exact rehearsed candidates and rejects immutable definition drift", () => {
    const result = runDeployHelper(`
REGION=us-east-1
ACCOUNT_ID=135775632425
NAME=schoolpilot-production
ECR_REPO=135775632425.dkr.ecr.us-east-1.amazonaws.com/schoolpilot-production-api
IMAGE_TAG=test-sha
DIGEST=sha256:${"d".repeat(64)}
API_ROLLOUT_TASK_DEF=arn:aws:ecs:us-east-1:135775632425:task-definition/schoolpilot-production-api-emergency:34
WORKER_CANDIDATE_TASK_DEF=arn:aws:ecs:us-east-1:135775632425:task-definition/schoolpilot-production-scheduler-worker:49
DRIFT_CANDIDATE=false
aws() {
  if [[ "$1 $2" == "ecr describe-images" ]]; then
    printf '%s\\n' "$DIGEST"
    return 0
  fi
  if [[ "$1 $2" != "ecs describe-task-definition" ]]; then
    return 1
  fi
  local ref=""
  while [[ $# -gt 0 ]]; do
    if [[ "$1" == "--task-definition" ]]; then
      ref="$2"
      break
    fi
    shift
  done
  if [[ "$ref" == "$API_ROLLOUT_TASK_DEF" ]]; then
    local drift='[]'
    if [[ "$DRIFT_CANDIDATE" == true ]]; then
      drift='[{"name":"IMMUTABLE_DRIFT","value":"true"}]'
    fi
    printf '{"taskDefinitionArn":"%s","status":"ACTIVE","family":"schoolpilot-production-api-emergency","cpu":"512","memory":"2048","containerDefinitions":[{"name":"api","image":"%s@%s","environment":%s}]}\\n' \
      "$ref" "$ECR_REPO" "$DIGEST" "$drift"
    return 0
  fi
  if [[ "$ref" == "$WORKER_CANDIDATE_TASK_DEF" ]]; then
    printf '{"taskDefinitionArn":"%s","status":"ACTIVE","family":"schoolpilot-production-scheduler-worker","containerDefinitions":[{"name":"scheduler-worker","image":"%s@%s"}]}\\n' \
      "$ref" "$ECR_REPO" "$DIGEST"
    return 0
  fi
  return 1
}
verify_classpilot_rehearsed_candidates
first_api_sha="$TILE_AUTH_PLAN_REHEARSAL_API_TASK_DEFINITION_SHA256"
first_worker_sha="$TILE_AUTH_PLAN_REHEARSAL_WORKER_TASK_DEFINITION_SHA256"
DRIFT_CANDIDATE=true
if verify_classpilot_rehearsed_candidates; then
  printf 'candidate_drift_was_accepted\\n' >&2
  exit 99
fi
printf 'apiSha=%s\\nworkerSha=%s\\n' "$first_api_sha" "$first_worker_sha"
rm -f .tile-auth-plan-rehearsed-api.json .tile-auth-plan-rehearsed-worker.json
`);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /apiSha=[a-f0-9]{64}/);
    assert.match(result.stdout, /workerSha=[a-f0-9]{64}/);
    assert.match(
      result.stderr,
      /exact candidate task definitions drifted from their rehearsal receipt/i
    );
    assert.doesNotMatch(result.stderr, /IMMUTABLE_DRIFT/);
  });

  it("validates rehearsal task ARNs against runtime region, account, and families", () => {
    const hash = "a".repeat(64);
    const summary = JSON.stringify({
      schemaVersion: 1,
      version: "classpilot-tile-auth-plan-rehearsal-v1",
      receiptSha256: hash,
      imageDigest: `sha256:${"b".repeat(64)}`,
      candidateApiTaskDefinitionArn:
        "arn:aws:ecs:us-west-2:123456789012:task-definition/schoolpilot-staging-api-emergency:41",
      candidateApiTaskDefinitionSha256: hash,
      candidateWorkerTaskDefinitionArn:
        "arn:aws:ecs:us-west-2:123456789012:task-definition/schoolpilot-staging-scheduler-worker:42",
      candidateWorkerTaskDefinitionSha256: hash,
      historyFallbackIdentitySha256: hash,
      queryIdentifierSha256: hash,
      preflightEvidenceSha256: hash,
      planEventsSha256: hash,
      sanitizedPlanReportSha256: hash,
      lifecycleEvidenceSha256: hash,
    });
    const wrongRegion = summary.replaceAll("us-west-2", "us-east-1");
    const result = runDeployHelper(`
REGION=us-west-2
ACCOUNT_ID=123456789012
NAME=schoolpilot-staging
WORKER_SERVICE=schoolpilot-staging-scheduler-worker
parse_classpilot_rehearsal_binding '${summary}'
if parse_classpilot_rehearsal_binding '${wrongRegion}' >/dev/null 2>&1; then
  printf 'wrong_region_was_accepted\\n' >&2
  exit 99
fi
`);
    assert.equal(result.status, 0, result.stderr);
    assert.match(
      result.stdout,
      /arn:aws:ecs:us-west-2:123456789012:task-definition\/schoolpilot-staging-api-emergency:41/
    );
    assert.doesNotMatch(result.stderr, /wrong_region_was_accepted/);
    assert.doesNotMatch(
      deploySource,
      /const api = \/\^arn:aws:ecs:us-east-1:135775632425/
    );
  });

  it("rechecks the receipt-bound API network before migration and service mutation", () => {
    const result = runDeployHelper(`
REUSE_CLASSPILOT_TILE_AUTH_PLAN_REHEARSAL=C:/private/rehearsal.json
REGION=us-east-1
CLUSTER=schoolpilot-production-cluster
SERVICE=schoolpilot-production-api
DRIFT_NETWORK=false
aws() {
  if [[ "$1 $2" != "ecs describe-services" ]]; then
    return 1
  fi
  if [[ "$DRIFT_NETWORK" == true ]]; then
    printf '%s\\n' '{"subnets":["subnet-b"],"securityGroups":["sg-a"],"assignPublicIp":"ENABLED"}'
  else
    printf '%s\\n' '{"subnets":["subnet-a"],"securityGroups":["sg-a"],"assignPublicIp":"DISABLED"}'
  fi
}
resolve_classpilot_tile_auth_candidate_network
TILE_AUTH_PLAN_REHEARSAL_CONSUMED_NETWORK_SHA256="$TILE_AUTH_PLAN_REHEARSAL_NETWORK_SHA256"
assert_classpilot_rehearsal_network_unchanged
DRIFT_NETWORK=true
if assert_classpilot_rehearsal_network_unchanged; then
  printf 'network_drift_was_accepted\\n' >&2
  exit 99
fi
rm -f .ecs-network.json
`);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /network configuration drifted/i);
    assert.doesNotMatch(result.stderr, /network_drift_was_accepted/);
    const rechecks = [
      ...deploySource.matchAll(/assert_classpilot_rehearsal_network_unchanged/g),
    ];
    assert.ok(rechecks.length >= 3);
    const preMigrationRecheck = deploySource.indexOf(
      "if ! assert_classpilot_rehearsal_network_unchanged",
      deploySource.indexOf("run_classpilot_tile_auth_plan_gate predeploy")
    );
    const hold = deploySource.indexOf(
      "acquire_production_scaling_hold",
      preMigrationRecheck
    );
    const preMutationRecheck = deploySource.indexOf(
      "if ! assert_classpilot_rehearsal_network_unchanged",
      hold
    );
    const mutation = deploySource.indexOf(
      "CLASSPILOT_TILE_AUTH_SERVICE_MUTATION_STARTED=true",
      preMutationRecheck
    );
    assert.ok(
      preMigrationRecheck > 0 &&
      hold > preMigrationRecheck &&
      preMutationRecheck > hold &&
      mutation > preMutationRecheck
    );
  });

  it("fails closed and clears stale network state when revalidation errors", () => {
    const result = runDeployHelper(`
REUSE_CLASSPILOT_TILE_AUTH_PLAN_REHEARSAL=C:/private/rehearsal.json
TILE_AUTH_PLAN_REHEARSAL_CONSUMED_NETWORK_SHA256="${"a".repeat(64)}"
TILE_AUTH_PLAN_REHEARSAL_NETWORK_SHA256="${"a".repeat(64)}"
NETWORK_CONFIG="stale-network"
resolve_classpilot_tile_auth_candidate_network() { return 1; }
if assert_classpilot_rehearsal_network_unchanged; then
  printf 'network_lookup_failure_was_accepted\\n' >&2
  exit 99
fi
if [[ -n "$NETWORK_CONFIG" || -n "$TILE_AUTH_PLAN_REHEARSAL_NETWORK_SHA256" ]]; then
  printf 'stale_network_binding_survived\\n' >&2
  exit 98
fi
`);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /could not be revalidated/i);
    assert.doesNotMatch(
      result.stderr,
      /network_lookup_failure_was_accepted|stale_network_binding_survived/
    );
  });

  it("trap-recovers both services after any guarded service mutation", () => {
    const mutation = deploySource.indexOf(
      "CLASSPILOT_TILE_AUTH_SERVICE_MUTATION_STARTED=true"
    );
    const apiUpdate = deploySource.indexOf("aws ecs update-service", mutation);
    assert.ok(mutation > 0 && mutation < apiUpdate);
    assert.match(
      deploySource,
      /deploy_exit_cleanup\(\)[\s\S]*CLASSPILOT_TILE_AUTH_SERVICE_MUTATION_STARTED[\s\S]*rollback_classpilot_tile_auth_deployment/
    );
    assert.match(
      deploySource,
      /CLASSPILOT_TILE_AUTH_SERVICE_MUTATION_STARTED=false[\s\S]*CLASSPILOT_TILE_AUTH_SAFE_TERMINAL_REACHED=true/
    );
  });

  it("binds exact logs for nonzero terminal exits before interpreting failure", () => {
    for (const exitCode of [1, 2, 137, 255]) {
      for (const reportedStream of [
        undefined,
        null,
        `api/api/${taskId}`,
        "api/api/00000000000000000000000000000000",
        123,
        "",
      ]) {
        const taskResult =
          reportedStream === undefined
            ? taskResultWithExitCode(exitCode)
            : taskResultWithExitCode(exitCode, reportedStream);
        const result = runLogBindingResolver(taskResult);
        assert.equal(result.status, 0, result.stderr);
        assert.deepEqual(JSON.parse(result.stdout), {
          logGroup: "/ecs/schoolpilot-production-api",
          logRegion: "us-east-1",
          logPrefix: "api",
          logStream: `api/api/${taskId}`,
          exitCode,
        });
      }
    }
    for (const exitCode of [-1, 1.5, 256]) {
      const result = runLogBindingResolver(taskResultWithExitCode(exitCode));
      assert.notEqual(result.status, 0);
    }
    const conflictingResult = runLogBindingResolver(
      taskResultWithExitCode(
        2,
        "api/api/00000000000000000000000000000000"
      )
    );
    assert.equal(conflictingResult.status, 0, conflictingResult.stderr);
    const binding = JSON.parse(conflictingResult.stdout);
    assert.equal(binding.logStream, `api/api/${taskId}`);
    assert.equal(
      extractClasspilotTileAuthorizationPlanFailure({
        events: [{
          timestamp: 1,
          ingestionTime: 2,
          message: JSON.stringify({
            status: "failed",
            failureCode: "representative_scenario_missing",
          }),
        }],
      }),
      "representative_scenario_missing"
    );
    assert.match(
      deploySource,
      /extract-classpilot-tile-auth-plan-failure\.mjs/
    );
    assert.match(
      deploySource,
      /failed \(failureCode=\$\{sanitized_failure_code\}\)/
    );
  });

  it("disables Git Bash path conversion at both CloudWatch reader boundaries", () => {
    const outerCalls = [
      ...deploySource.matchAll(
        /MSYS_NO_PATHCONV=1 node \\\n\s+"\$SCRIPT_DIR\/read-classpilot-tile-auth-plan-log-events\.mjs"/g
      ),
    ];
    assert.equal(outerCalls.length, 2);

    const result = spawnSync(
      bashExecutable(),
      [
        "-lc",
        "MSYS_NO_PATHCONV=1 node -e 'process.stdout.write(process.argv[1])' /ecs/schoolpilot-production-api",
      ],
      { encoding: "utf8" }
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "/ecs/schoolpilot-production-api");
  });

  it("paginates the exact bound stream so terminal failures after event 100 survive", async () => {
    const noise = Array.from({ length: 100 }, (_, index) => ({
      timestamp: index,
      ingestionTime: index + 1,
      message: `startup-${index}`,
    }));
    const terminalFailure = {
      timestamp: 100,
      ingestionTime: 101,
      message: JSON.stringify({
        status: "failed",
        failureCode: "representative_scenario_missing",
      }),
    };
    const requestedTokens: Array<string | undefined> = [];
    const document = await collectClasspilotTileAuthorizationPlanLogEvents({
      fetchPage: async (token) => {
        requestedTokens.push(token);
        if (token === undefined) {
          return { events: noise, nextForwardToken: "forward-1" };
        }
        if (token === "forward-1") {
          return { events: [terminalFailure], nextForwardToken: "forward-2" };
        }
        return { events: [], nextForwardToken: "forward-2" };
      },
    });
    assert.deepEqual(requestedTokens, [undefined, "forward-1", "forward-2"]);
    assert.equal(document.events.length, 101);
    assert.equal(
      extractClasspilotTileAuthorizationPlanFailure(document),
      "representative_scenario_missing"
    );
  });

  it("fails closed on CloudWatch token cycles and bounded event overflow", async () => {
    await assert.rejects(() =>
      collectClasspilotTileAuthorizationPlanLogEvents({
        fetchPage: async (token) => {
          if (token === undefined) {
            return { events: [], nextForwardToken: "forward-1" };
          }
          if (token === "forward-1") {
            return { events: [], nextForwardToken: "forward-2" };
          }
          return { events: [], nextForwardToken: "forward-1" };
        },
      })
    );
    await assert.rejects(() =>
      collectClasspilotTileAuthorizationPlanLogEvents({
        maxEvents: 1,
        fetchPage: async () => ({
          events: [
            { timestamp: 1, ingestionTime: 1, message: "one" },
            { timestamp: 2, ingestionTime: 2, message: "two" },
          ],
          nextForwardToken: "forward-1",
        }),
      })
    );
  });

  it("accepts only an exact reported stream and rejects unsafe task bindings", () => {
    const exact = runLogBindingResolver(validTaskResult(`api/api/${taskId}`));
    assert.equal(exact.status, 0, exact.stderr);

    const cases = [
      validTaskResult("api/api/00000000000000000000000000000000"),
      validTaskResult(123),
      validTaskResult(""),
      { ...validTaskResult(), failures: [{ arn: taskArn, reason: "test" }] },
      {
        ...validTaskResult(),
        tasks: [{
          ...validTaskResult().tasks[0],
          taskDefinitionArn: `${taskDefinitionArn}-wrong`,
        }],
      },
      {
        ...validTaskResult(),
        tasks: [{
          ...validTaskResult().tasks[0],
          containers: [
            { name: "api", lastStatus: "STOPPED", exitCode: 0 },
            { name: "api", lastStatus: "STOPPED", exitCode: 0 },
          ],
        }],
      },
    ];
    for (const taskResult of cases) {
      const result = runLogBindingResolver(taskResult);
      assert.notEqual(result.status, 0);
      assert.equal(result.stdout, "");
      assert.equal(result.stderr.trim(), "binding_invalid");
    }

    const invalidTaskArn = taskArn.replace(taskId, "not-a-task-id");
    const invalidTaskResult = validTaskResult();
    invalidTaskResult.tasks[0].taskArn = invalidTaskArn;
    const invalidTaskId = runLogBindingResolver(invalidTaskResult, undefined, invalidTaskArn);
    assert.notEqual(invalidTaskId.status, 0);

    for (const options of [
      {
        "awslogs-group": "/ecs/schoolpilot-production-api",
        "awslogs-region": "us-west-2",
        "awslogs-stream-prefix": "api",
      },
      {
        "awslogs-group": "/ecs/schoolpilot-production-api",
        "awslogs-region": "us-east-1",
        "awslogs-stream-prefix": "api\tforged",
      },
    ]) {
      const unsafeConfig = runLogBindingResolver(validTaskResult(), {
        logDriver: "awslogs",
        options,
      });
      assert.notEqual(unsafeConfig.status, 0);
    }
  });

  it("accepts and canonicalizes only fixed aggregate evidence", () => {
    const result = runValidator(validReport());
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.status, "passed");
    assert.deepEqual(output.scenarios.map((scenario: { label: string }) => scenario.label), [
      "teacher.live",
      "teacher.history",
      "co_teacher.live",
      "co_teacher.history",
      "office_staff.live",
      "office_staff.history",
    ]);
    assert.equal(output.precheck.invalidTeachingSessionSchools, 0);
    assert.equal(output.historyFallback.label, "history_fallback");
    assert.equal(output.historyFallback.perPairIndexLimit, true);
    assert.equal(output.historyFallback.maxReturnedRows, 400);
    assert.deepEqual(output.historyFallbackSqlIdentity, {
      version: "history-fallback-queryid-v1",
      queryIdentifierSha256:
        validReport().historyFallbackSqlIdentity.queryIdentifierSha256,
      compiledSqlSha256: "a".repeat(64),
      parameterTypeSignatureSha256: "b".repeat(64),
      engineVersion: "16.4",
      schemaIdentitySha256: "c".repeat(64),
      trackIoTiming: true,
    });
    assert.equal(
      result.stdout.includes(validReport().historyFallbackSqlIdentity.queryIdentifier),
      false
    );
    assert.equal(
      Object.hasOwn(output, "transactionalPlanScenarios"),
      false
    );
  });

  it("rejects relaxed, failed, or identifier-bearing evidence without echoing it", () => {
    const cases = [
      { ...validReport(), samples: 21 },
      { ...validReport(), status: "failed" },
      { ...validReport(), studentId: "student-secret-123" },
      {
        ...validReport(),
        scenarios: validReport().scenarios.map((scenario, index) =>
          index === 0 ? { ...scenario, p95Ms: 50.01 } : scenario
        ),
      },
      {
        ...validReport(),
        historyFallback: {
          ...validReport().historyFallback,
          perPairIndexLimit: false,
        },
      },
      {
        ...validReport(),
        historyFallback: {
          ...validReport().historyFallback,
          maxReturnedRows: 401,
        },
      },
    ];
    for (const report of cases) {
      const result = runValidator(report);
      assert.notEqual(result.status, 0);
      assert.equal(result.stdout, "");
      assert.equal(result.stderr.trim(), "classpilot_tile_authorization_plan_evidence_invalid");
      assert.doesNotMatch(result.stderr, /student-secret-123/);
    }
  });

  it("requires one sanitized rollback-complete, zero-residue lifecycle event", () => {
    const cases: Array<Record<string, unknown> | null> = [
      null,
      { ...validLifecycle(), version: "transactional-plan-scenarios-v0" },
      { ...validLifecycle(), rawSql: "SELECT secret" },
      {
        ...validLifecycle(),
        seededRows: { ...validLifecycle().seededRows, total: 44 },
      },
      {
        ...validLifecycle(),
        rollback: { attempted: true, completed: false },
      },
      {
        ...validLifecycle(),
        residue: { checked: true, count: 1, passed: false },
      },
    ];
    for (const lifecycle of cases) {
      const result = runValidator(validReport(), lifecycle);
      assert.notEqual(result.status, 0);
      assert.equal(result.stdout, "");
      assert.equal(
        result.stderr.trim(),
        "classpilot_tile_authorization_plan_evidence_invalid"
      );
      assert.doesNotMatch(result.stderr, /SELECT secret/);
    }
  });
});
