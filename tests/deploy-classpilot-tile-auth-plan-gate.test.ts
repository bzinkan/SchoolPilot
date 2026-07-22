import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const deploySource = readFileSync(new URL("../scripts/deploy.sh", import.meta.url), "utf8")
  .replace(/\r\n/g, "\n");
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

function runDeployHelper(body: string, easternClock = "1 1200") {
  return spawnSync(bashExecutable(), ["-s"], {
    encoding: "utf8",
    input: `
${deployLibrarySource}
RUN_CLASSPILOT_TILE_AUTH_PLAN_GATE=true
production_eastern_weekday_hhmm() { printf '%s\\n' "$TEST_EASTERN_CLOCK"; }
info() { :; }
success() { :; }
warn() { :; }
error() { printf '%s\\n' "$*" >&2; }
${body}
`,
    env: { ...process.env, TEST_EASTERN_CLOCK: easternClock },
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

function runValidator(report: Record<string, unknown>) {
  const input = JSON.stringify({
    events: [
      { message: "non-json startup noise" },
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
    const rolloutStart = deploySource.indexOf('API_ROLLOUT_TASK_DEF="${NAME}-api:${NEW_REV}"');
    const network = deploySource.indexOf("NETWORK_CONFIG=$(node -e", rolloutStart);
    const gate = deploySource.indexOf("run_classpilot_tile_auth_plan_gate", network);
    const hold = deploySource.indexOf("acquire_production_scaling_hold", gate);
    const migration = deploySource.indexOf('info "Running startup migrations', hold);
    const update = deploySource.indexOf("aws ecs update-service", migration);
    assert.ok(rolloutStart > 0 && rolloutStart < network);
    assert.ok(network < gate && gate < hold && hold < migration && migration < update);

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
      /events_json=\$\(MSYS_NO_PATHCONV=1 aws logs get-log-events[\s\S]*printf '%s' "\$events_json" \|/
    );
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
      });
    }
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
});
