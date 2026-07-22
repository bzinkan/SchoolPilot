import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const deploySource = readFileSync(new URL("../scripts/deploy.sh", import.meta.url), "utf8")
  .replace(/\r\n/g, "\n");
const libraryBoundary = deploySource.indexOf("# --- Preflight checks ---");
assert.ok(libraryBoundary > 0, "deploy script should expose its helpers before preflight execution");
const deployLibrarySource = deploySource.slice(0, libraryBoundary);

function bashExecutable(): string {
  if (process.platform !== "win32") return "bash";

  const candidates = [
    "C:\\Program Files\\Git\\bin\\bash.exe",
    "C:\\Program Files\\Git\\usr\\bin\\bash.exe",
    "C:\\Program Files (x86)\\Git\\bin\\bash.exe",
  ];
  return candidates.find(existsSync) ?? "bash";
}

function stableServices(options: {
  apiStatus?: string;
  apiDesired?: string;
  apiRunning?: string;
  apiPending?: string;
  apiDeployments?: string;
  apiTaskDefinition?: string;
  apiPrimaryTaskDefinition?: string;
  apiRollout?: string;
  workerStatus?: string;
  workerDesired?: string;
  workerRunning?: string;
  workerPending?: string;
  workerDeployments?: string;
  workerTaskDefinition?: string;
  workerPrimaryTaskDefinition?: string;
  workerRollout?: string;
  omitApi?: boolean;
  omitWorker?: boolean;
} = {}): string {
  const apiDesired = options.apiDesired ?? "1";
  const workerDesired = options.workerDesired ?? "1";
  const apiTaskDefinition = options.apiTaskDefinition
    ?? "arn:aws:ecs:us-east-1:135775632425:task-definition/schoolpilot-production-api:101";
  const workerTaskDefinition = options.workerTaskDefinition
    ?? "arn:aws:ecs:us-east-1:135775632425:task-definition/schoolpilot-production-scheduler-worker:21";
  const rows: string[] = [];
  if (!options.omitApi) {
    rows.push([
      "schoolpilot-production-api",
      options.apiStatus ?? "ACTIVE",
      apiDesired,
      options.apiRunning ?? apiDesired,
      options.apiPending ?? "0",
      options.apiDeployments ?? "1",
      apiTaskDefinition,
      options.apiPrimaryTaskDefinition ?? apiTaskDefinition,
      options.apiRollout ?? "COMPLETED",
    ].join("\t"));
  }
  if (!options.omitWorker) {
    rows.push([
      "schoolpilot-production-scheduler-worker",
      options.workerStatus ?? "ACTIVE",
      workerDesired,
      options.workerRunning ?? workerDesired,
      options.workerPending ?? "0",
      options.workerDeployments ?? "1",
      workerTaskDefinition,
      options.workerPrimaryTaskDefinition ?? workerTaskDefinition,
      options.workerRollout ?? "COMPLETED",
    ].join("\t"));
  }
  return rows.join("\n");
}

type LibraryRunOptions = {
  environment?: string;
  deployBackend?: boolean;
  deployFrontend?: boolean;
  activateEmergency?: boolean;
  skipWait?: boolean;
  easternClock?: string;
  serviceSnapshots?: string[];
  scalingSnapshots?: string[];
  taskDefinitionSnapshots?: string[];
  registerFailCalls?: number[];
};

function runLibrary(body: string, options: LibraryRunOptions = {}) {
  const fixtureDir = mkdtempSync(join(tmpdir(), "schoolpilot-deploy-guard-"));
  const shellFixtureDir = fixtureDir.replaceAll("\\", "/");
  for (const [index, snapshot] of (options.serviceSnapshots ?? []).entries()) {
    writeFileSync(join(fixtureDir, `service-${index + 1}.txt`), snapshot, "utf8");
  }
  for (const [index, snapshot] of (options.scalingSnapshots ?? []).entries()) {
    writeFileSync(join(fixtureDir, `scaling-${index + 1}.txt`), snapshot, "utf8");
  }
  for (const [index, snapshot] of (options.taskDefinitionSnapshots ?? []).entries()) {
    writeFileSync(join(fixtureDir, `taskdef-${index + 1}.txt`), snapshot, "utf8");
  }

  const script = `
${deployLibrarySource}
ENV="$TEST_ENVIRONMENT"
DEPLOY_BACKEND="$TEST_DEPLOY_BACKEND"
DEPLOY_FRONTEND="$TEST_DEPLOY_FRONTEND"
ACTIVATE_EMERGENCY="$TEST_ACTIVATE_EMERGENCY"
SKIP_WAIT="$TEST_SKIP_WAIT"
production_eastern_weekday_hhmm() {
  if [[ "$TEST_EASTERN_CLOCK" == "__FAIL__" ]]; then
    return 42
  fi
  printf '%s\n' "$TEST_EASTERN_CLOCK"
}
cleanup_temp_files() { :; }
sleep() { :; }
info() { printf 'INFO %s\\n' "$*"; }
success() { printf 'SUCCESS %s\\n' "$*"; }
warn() { printf 'WARN %s\\n' "$*" >&2; }
error() { printf 'ERROR %s\\n' "$*" >&2; }
next_counter() {
  local kind="$1"
  local counter_file="$TEST_FIXTURE_DIR/$kind.count"
  local count=0
  if [[ -f "$counter_file" ]]; then
    count=$(cat "$counter_file")
  fi
  count=$((count + 1))
  printf '%s' "$count" > "$counter_file"
  printf '%s\\n' "$count"
}
next_fixture() {
  local kind="$1"
  local count fixture output
  count=$(next_counter "$kind")
  fixture="$TEST_FIXTURE_DIR/$kind-$count.txt"
  if [[ ! -f "$fixture" ]]; then
    return 97
  fi
  output=$(cat "$fixture")
  if [[ "$output" == __FAIL__:* ]]; then
    return "\${output#__FAIL__:}"
  fi
  printf '%s\\n' "$output"
}
aws() {
  printf 'AWS %s\\n' "$*" >> "$TEST_FIXTURE_DIR/commands.log"
  if [[ "$1" == "ecs" && "$2" == "describe-services" ]]; then
    next_fixture service
    return $?
  fi
  if [[ "$1" == "application-autoscaling" && "$2" == "describe-scalable-targets" ]]; then
    next_fixture scaling
    return $?
  fi
  if [[ "$1" == "ecs" && "$2" == "describe-task-definition" ]]; then
    next_fixture taskdef
    return $?
  fi
  if [[ "$1" == "application-autoscaling" && "$2" == "register-scalable-target" ]]; then
    local register_call
    register_call=$(next_counter register)
    if [[ ",\${TEST_REGISTER_FAIL_CALLS}," == *",\${register_call},"* ]]; then
      return 42
    fi
    printf '{}\\n'
    return 0
  fi
  return 91
}
${body}
`;

  const result = spawnSync(bashExecutable(), ["-s"], {
    encoding: "utf8",
    input: script,
    env: {
      ...process.env,
      TEST_ENVIRONMENT: options.environment ?? "production",
      TEST_DEPLOY_BACKEND: String(options.deployBackend ?? true),
      TEST_DEPLOY_FRONTEND: String(options.deployFrontend ?? false),
      TEST_ACTIVATE_EMERGENCY: String(options.activateEmergency ?? false),
      TEST_SKIP_WAIT: String(options.skipWait ?? false),
      TEST_EASTERN_CLOCK: options.easternClock ?? "1 1200",
      TEST_FIXTURE_DIR: shellFixtureDir,
      TEST_REGISTER_FAIL_CALLS: (options.registerFailCalls ?? []).join(","),
    },
  });
  const commandLog = join(fixtureDir, "commands.log");
  const commands = existsSync(commandLog)
    ? readFileSync(commandLog, "utf8").trim().split(/\r?\n/).filter(Boolean)
    : [];
  rmSync(fixtureDir, { recursive: true, force: true });
  return { ...result, commands };
}

function registerCommands(commands: string[]): string[] {
  return commands.filter((line) => line.includes("application-autoscaling register-scalable-target"));
}

const captureDefaultRollbackRevisions = `
PRODUCTION_ROLLBACK_API_TASK_DEFINITION="schoolpilot-production-api:101"
PRODUCTION_ROLLBACK_WORKER_TASK_DEFINITION="schoolpilot-production-scheduler-worker:21"
`;

const captureObservedRollbackRevisions = `
PRODUCTION_ROLLBACK_API_TASK_DEFINITION="$PRODUCTION_PREFLIGHT_API_TASK_DEFINITION"
PRODUCTION_ROLLBACK_WORKER_TASK_DEFINITION="$PRODUCTION_PREFLIGHT_WORKER_TASK_DEFINITION"
`;

describe("production backend deployment capacity guard", () => {
  it("binds the reviewed 2048 MiB rollout to the freshly registered emergency revision", () => {
    assert.match(deploySource, /--activate-emergency\) ACTIVATE_EMERGENCY=true/);
    assert.match(
      deploySource,
      /--activate-emergency is allowed only with production --backend/
    );

    const selection = deploySource.indexOf('API_ROLLOUT_TASK_DEF="${NAME}-api:${NEW_REV}"');
    const emergencySelection = deploySource.indexOf('API_ROLLOUT_TASK_DEF="$EMERGENCY_TASK_DEF_ARN"', selection);
    const migration = deploySource.indexOf('aws ecs run-task', emergencySelection);
    const migrationTaskDefinition = deploySource.indexOf('--task-definition "$API_ROLLOUT_TASK_DEF"', migration);
    const apiUpdate = deploySource.indexOf('aws ecs update-service', migration);
    const apiUpdateTaskDefinition = deploySource.indexOf('--task-definition "$API_ROLLOUT_TASK_DEF"', apiUpdate);
    const workerUpdate = deploySource.indexOf('aws ecs update-service', apiUpdate + 1);
    const strictStability = deploySource.indexOf('wait_for_production_backend_strict_stability', workerUpdate);
    const strictApiReference = deploySource.indexOf('"$API_ROLLOUT_TASK_DEF"', strictStability);

    assert.ok(selection > 0, "default rollout should retain the standard API revision");
    assert.ok(emergencySelection > selection, "reviewed mode should select the fresh emergency ARN");
    assert.ok(migration > emergencySelection && migrationTaskDefinition > migration);
    assert.ok(apiUpdate > migrationTaskDefinition && apiUpdateTaskDefinition > apiUpdate);
    assert.ok(workerUpdate > apiUpdateTaskDefinition);
    assert.ok(strictStability > workerUpdate && strictApiReference > strictStability);

    const migrationBlock = deploySource.slice(migration, apiUpdate);
    const apiUpdateBlock = deploySource.slice(
      apiUpdate,
      deploySource.indexOf("  UPDATED_WORKER=false", apiUpdate)
    );
    assert.doesNotMatch(migrationBlock, /--task-definition "\$\{NAME\}-api:\$\{NEW_REV\}"/);
    assert.doesNotMatch(apiUpdateBlock, /--task-definition "\$\{NAME\}-api:\$\{NEW_REV\}"/);
  });

  it("allows 2048 MiB activation only for a production backend-only deploy", () => {
    const accepted = runLibrary("validate_emergency_activation_mode", {
      activateEmergency: true,
      deployFrontend: false,
    });
    assert.equal(accepted.status, 0, accepted.stderr);
    assert.deepEqual(accepted.commands, []);

    const rejectedCases: LibraryRunOptions[] = [
      { activateEmergency: true, environment: "staging", deployFrontend: false },
      { activateEmergency: true, deployBackend: false, deployFrontend: true },
      { activateEmergency: true, deployBackend: true, deployFrontend: true },
    ];
    for (const options of rejectedCases) {
      const rejected = runLibrary("validate_emergency_activation_mode", options);
      assert.notEqual(rejected.status, 0);
      assert.match(rejected.stderr, /allowed only with production --backend/);
      assert.deepEqual(rejected.commands, []);
    }
  });

  it("requires the currently serving API to retain the reviewed 512/2048 posture", () => {
    const taskDefinition = (memory: string, hardMemory?: number) => JSON.stringify({
      cpu: "512",
      memory,
      containers: [{
        name: "api",
        ...(hardMemory === undefined ? {} : { memory: hardMemory }),
      }],
    });
    const body = `
PRODUCTION_PREFLIGHT_API_TASK_DEFINITION="schoolpilot-production-api-emergency:10"
launch_safe_active_api_preflight
`;

    const accepted = runLibrary(body, {
      activateEmergency: true,
      taskDefinitionSnapshots: [taskDefinition("2048")],
    });
    assert.equal(accepted.status, 0, accepted.stderr);
    assert.match(accepted.stdout, /Active API launch-safe posture verified/);
    assert.equal(accepted.commands.length, 1);
    assert.match(accepted.commands[0], /ecs describe-task-definition/);

    for (const unsafe of [taskDefinition("1024"), taskDefinition("2048", 1024)]) {
      const rejected = runLibrary(body, {
        activateEmergency: true,
        taskDefinitionSnapshots: [unsafe],
      });
      assert.notEqual(rejected.status, 0);
      assert.match(rejected.stderr, /currently serving API.*512 CPU \/ 2048 MiB/);
      assert.equal(rejected.commands.length, 1);
    }

    const defaultMode = runLibrary(body, {
      activateEmergency: false,
    });
    assert.equal(defaultMode.status, 0, defaultMode.stderr);
    assert.deepEqual(defaultMode.commands, []);
  });

  it("runs the initial preflight before every Docker, ECR, migration, and ECS mutation", () => {
    const execution = deploySource.slice(libraryBoundary);
    const windowInvocation = execution.indexOf("\nproduction_backend_deploy_window_preflight\n");
    const invocation = execution.indexOf("\nproduction_backend_capacity_preflight\n");
    const launchSafeInvocation = execution.indexOf("\nlaunch_safe_active_api_preflight\n");
    const mutationIndexes = [
      "docker build ",
      "docker login ",
      "docker tag ",
      "docker push ",
      "aws ecs register-task-definition",
      "aws ecs run-task",
      "aws ecs update-service",
    ].map((needle) => {
      const index = execution.indexOf(needle);
      assert.ok(index >= 0, `expected deployment mutation ${needle}`);
      return index;
    });

    assert.ok(windowInvocation >= 0, "deployment-window preflight should be invoked");
    assert.ok(invocation >= 0, "capacity preflight should be invoked");
    assert.ok(launchSafeInvocation > invocation, "2048 MiB posture check should follow the stable-service snapshot");
    assert.ok(windowInvocation < Math.min(...mutationIndexes));
    assert.ok(invocation < Math.min(...mutationIndexes));
    assert.ok(launchSafeInvocation < Math.min(...mutationIndexes));
    assert.equal(
      execution.match(/\n\s*launch_safe_active_api_preflight\n/g)?.length,
      3,
      "launch-safe posture should be checked before build, under the scaling hold, and before API rollout"
    );
  });

  it("acquires the scaling hold before migration and restores only after both service wait paths", () => {
    const execution = deploySource.slice(libraryBoundary);
    const hold = execution.indexOf("\n  acquire_production_scaling_hold\n");
    const migration = execution.indexOf("aws ecs run-task", hold);
    const apiUpdate = execution.indexOf("aws ecs update-service", migration);
    const preUpdateCapacityCheck = execution.lastIndexOf(
      'production_backend_capacity_preflight "after migration under the autoscaling hold"',
      apiUpdate
    );
    const preUpdateWindowCheck = execution.lastIndexOf(
      'production_backend_deploy_window_preflight "before service rollout"',
      apiUpdate
    );
    const workerUpdate = execution.indexOf("aws ecs update-service", apiUpdate + 1);
    const restore = execution.indexOf("\n  if ! restore_production_scaling_hold; then", workerUpdate);
    const lastServiceWait = execution.lastIndexOf("aws ecs wait services-stable", restore);
    const finalCapacityCheck = execution.lastIndexOf(
      "wait_for_production_backend_strict_stability",
      restore
    );

    assert.ok(hold >= 0 && hold < migration);
    assert.ok(migration < preUpdateWindowCheck && preUpdateWindowCheck < apiUpdate);
    assert.ok(preUpdateWindowCheck < preUpdateCapacityCheck && preUpdateCapacityCheck < apiUpdate);
    assert.ok(apiUpdate < workerUpdate);
    assert.ok(workerUpdate < lastServiceWait && lastServiceWait < finalCapacityCheck);
    assert.ok(finalCapacityCheck < restore);
  });

  it("accepts only stable API counts one or two with exactly one stable worker", () => {
    for (const apiDesired of ["1", "2"]) {
      const result = runLibrary("production_backend_capacity_preflight", {
        serviceSnapshots: [stableServices({ apiDesired })],
      });
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, new RegExp(`API desiredCount=${apiDesired}`));
      assert.match(result.stdout, /worker desiredCount=1, both stable/);
    }
  });

  it("blocks the measured arrival window plus its rollout safety buffer", () => {
    for (const easternClock of ["1 0445", "1 0544", "1 0545", "3 1000", "5 1014"]) {
      const result = runLibrary('production_backend_deploy_window_preflight "test phase"', { easternClock });
      assert.notEqual(result.status, 0, `unexpectedly accepted ${easternClock}`);
      assert.match(result.stderr, /blocked weekdays 04:45-10:15 America\/New_York/);
      assert.match(result.stderr, /test phase/);
      assert.deepEqual(result.commands, []);
    }
  });

  it("allows safe weekday boundaries and weekends", () => {
    for (const easternClock of ["1 0444", "1 1015", "5 2359", "6 0600", "7 0600"]) {
      const result = runLibrary("production_backend_deploy_window_preflight", { easternClock });
      assert.equal(result.status, 0, `${easternClock}: ${result.stderr}`);
      assert.match(result.stdout, /deployment window preflight OK/);
      assert.deepEqual(result.commands, []);
    }
  });

  it("fails closed when the Eastern deployment clock is unavailable or malformed", () => {
    for (const easternClock of ["__FAIL__", "", "1", "0 1200", "1 2400", "1 1260", "1 1200 extra"]) {
      const result = runLibrary("production_backend_deploy_window_preflight", { easternClock });
      assert.notEqual(result.status, 0, `unexpectedly accepted ${JSON.stringify(easternClock)}`);
      assert.match(result.stderr, /Could not resolve.*clock|clock was malformed or ambiguous/);
      assert.deepEqual(result.commands, []);
    }
  });

  it("rejects worker drift that would invalidate the rolling connection proof", () => {
    const result = runLibrary("production_backend_capacity_preflight", {
      serviceSnapshots: [stableServices({ apiDesired: "2", workerDesired: "2" })],
    });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /worker desiredCount is 2/);
    assert.equal(result.commands.length, 1);
  });

  it("rejects unhealthy, pending, or incomplete API and worker service state", () => {
    const cases = [
      stableServices({ apiRunning: "0" }),
      stableServices({ apiStatus: "DRAINING" }),
      stableServices({ apiPending: "1" }),
      stableServices({ apiDeployments: "2" }),
      stableServices({ apiRollout: "IN_PROGRESS" }),
      stableServices({ workerRunning: "0" }),
      stableServices({ workerStatus: "DRAINING" }),
      stableServices({ workerRollout: "IN_PROGRESS" }),
      stableServices({
        apiPrimaryTaskDefinition: "arn:aws:ecs:us-east-1:135775632425:task-definition/schoolpilot-production-api:100",
      }),
    ];

    for (const snapshot of cases) {
      const result = runLibrary("production_backend_capacity_preflight", {
        serviceSnapshots: [snapshot],
      });
      assert.notEqual(result.status, 0, `unexpectedly accepted ${JSON.stringify(snapshot)}`);
      assert.match(result.stderr, /is not stable|disagree on task definition/);
    }
  });

  it("fails closed on missing, malformed, duplicate, or failed service snapshots", () => {
    const cases = [
      stableServices({ omitWorker: true }),
      `${stableServices()}\n${stableServices({ omitWorker: true })}`,
      stableServices({ apiDesired: "02" }),
      stableServices({ apiTaskDefinition: "schoolpilot-production-api:latest" }),
      "__FAIL__:42",
    ];
    for (const snapshot of cases) {
      const result = runLibrary("production_backend_capacity_preflight", {
        serviceSnapshots: [snapshot],
      });
      assert.notEqual(result.status, 0, `unexpectedly accepted ${JSON.stringify(snapshot)}`);
      assert.match(result.stderr, /refusing the backend deployment/);
    }
  });

  it("rejects production --skip-wait before querying or mutating AWS", () => {
    const result = runLibrary("production_backend_capacity_preflight", { skipWait: true });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /cannot use --skip-wait/);
    assert.deepEqual(result.commands, []);
  });

  it("never queries or changes ECS/autoscaling for staging or frontend-only deploys", () => {
    const body = `
production_backend_capacity_preflight
acquire_production_scaling_hold
wait_for_production_backend_strict_stability
restore_production_scaling_hold
`;
    const staging = runLibrary(body, { environment: "staging", skipWait: true });
    const frontend = runLibrary(body, { deployBackend: false, skipWait: true });

    assert.equal(staging.status, 0, staging.stderr);
    assert.equal(frontend.status, 0, frontend.stderr);
    assert.deepEqual(staging.commands, []);
    assert.deepEqual(frontend.commands, []);
  });

  it("dynamically tolerates transient rollout metadata lag until both services are strictly complete", () => {
    const result = runLibrary(`
trap deploy_exit_cleanup EXIT
${captureDefaultRollbackRevisions}
acquire_production_scaling_hold
wait_for_production_backend_strict_stability schoolpilot-production-api:101 schoolpilot-production-scheduler-worker:21 3 0
restore_production_scaling_hold
`, {
      serviceSnapshots: [
        stableServices(),
        stableServices({ workerRollout: "IN_PROGRESS" }),
        stableServices(),
      ],
      scalingSnapshots: ["False\tTrue\tTrue", "True\tTrue\tTrue", "False\tTrue\tTrue"],
    });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(
      result.commands.filter((line) => line.includes("ecs describe-services")).length,
      3
    );
    assert.match(result.stdout, /has not fully converged \(attempt 1\/3\)/);
    assert.match(result.stdout, /one COMPLETED deployment each/);
    assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /is not stable/);
    const describeCommands = result.commands.filter((line) => line.includes("ecs describe-services"));
    assert.ok(describeCommands.every((line) =>
      line.includes("--cli-connect-timeout 3 --cli-read-timeout 5")
    ));
    assert.match(deploySource, /AWS_MAX_ATTEMPTS=1 aws ecs describe-services/);
    const registrations = registerCommands(result.commands);
    assert.equal(registrations.length, 2);
    assert.match(
      registrations.at(-1)!,
      /DynamicScalingInSuspended=false,DynamicScalingOutSuspended=true,ScheduledScalingSuspended=true/
    );
  });

  it("fails closed on a permanent strict-stability timeout and restores the autoscaling hold", () => {
    const result = runLibrary(`
trap deploy_exit_cleanup EXIT
${captureDefaultRollbackRevisions}
acquire_production_scaling_hold
wait_for_production_backend_strict_stability schoolpilot-production-api:101 schoolpilot-production-scheduler-worker:21 3 0
`, {
      serviceSnapshots: [
        stableServices(),
        stableServices({ workerRollout: "IN_PROGRESS" }),
        stableServices({ workerRollout: "IN_PROGRESS" }),
        stableServices({ workerRollout: "IN_PROGRESS" }),
      ],
      scalingSnapshots: ["False\tFalse\tTrue", "True\tTrue\tTrue", "False\tFalse\tTrue"],
    });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /did not reach one COMPLETED deployment each before the bounded deadline/);
    assert.match(result.stderr, /requiring autoscaling recovery/);
    assert.match(result.stderr, /attempting recovery/);
    assert.equal(
      result.commands.filter((line) => line.includes("ecs describe-services")).length,
      4
    );
    const registrations = registerCommands(result.commands);
    assert.equal(registrations.length, 2);
    assert.match(
      registrations.at(-1)!,
      /DynamicScalingInSuspended=false,DynamicScalingOutSuspended=false,ScheduledScalingSuspended=true/
    );
  });

  it("rejects a circuit-breaker rollback to old stable revisions and restores autoscaling", () => {
    const result = runLibrary(`
trap deploy_exit_cleanup EXIT
${captureDefaultRollbackRevisions}
acquire_production_scaling_hold
wait_for_production_backend_strict_stability schoolpilot-production-api:102 schoolpilot-production-scheduler-worker:22 3 0
`, {
      serviceSnapshots: [
        stableServices(),
        stableServices(),
        stableServices(),
        stableServices(),
      ],
      scalingSnapshots: ["False\tTrue\tFalse", "True\tTrue\tFalse", "False\tTrue\tFalse"],
    });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /completed an unexpected task definition/);
    assert.match(result.stderr, /expected schoolpilot-production-api:102/);
    assert.match(result.stderr, /attempting recovery/);
    const registrations = registerCommands(result.commands);
    assert.equal(registrations.length, 2);
    assert.match(
      registrations.at(-1)!,
      /DynamicScalingInSuspended=false,DynamicScalingOutSuspended=true,ScheduledScalingSuspended=false/
    );
  });

  it("distinguishes repeated describe failures and restores autoscaling", () => {
    const result = runLibrary(`
trap deploy_exit_cleanup EXIT
${captureDefaultRollbackRevisions}
acquire_production_scaling_hold
wait_for_production_backend_strict_stability schoolpilot-production-api:101 schoolpilot-production-scheduler-worker:21 3 0
`, {
      serviceSnapshots: [stableServices(), "__FAIL__:42", "__FAIL__:42", "__FAIL__:42"],
      scalingSnapshots: ["True\tFalse\tFalse", "True\tTrue\tFalse", "True\tFalse\tFalse"],
    });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /final production ECS describe-services call failed/);
    assert.doesNotMatch(result.stderr, /malformed or ambiguous/);
    assert.match(result.stderr, /attempting recovery/);
    const registrations = registerCommands(result.commands);
    assert.equal(registrations.length, 2);
    assert.match(
      registrations.at(-1)!,
      /DynamicScalingInSuspended=true,DynamicScalingOutSuspended=false,ScheduledScalingSuspended=false/
    );
  });

  it("dynamically acquires the hold before recheck and restores the exact prior state afterward", () => {
    const result = runLibrary(`
trap deploy_exit_cleanup EXIT
production_backend_capacity_preflight
${captureObservedRollbackRevisions}
acquire_production_scaling_hold
restore_production_scaling_hold
`, {
      serviceSnapshots: [stableServices(), stableServices()],
      scalingSnapshots: ["True\tFalse\tTrue", "True\tTrue\tTrue", "True\tFalse\tTrue"],
    });

    assert.equal(result.status, 0, result.stderr);
    const registrations = registerCommands(result.commands);
    assert.equal(registrations.length, 2);
    assert.match(registrations[0], /DynamicScalingInSuspended=true,DynamicScalingOutSuspended=true,ScheduledScalingSuspended=true/);
    assert.match(registrations[1], /DynamicScalingInSuspended=true,DynamicScalingOutSuspended=false,ScheduledScalingSuspended=true/);
    const firstServiceCheck = result.commands.findIndex((line) => line.includes("ecs describe-services"));
    const holdRegistration = result.commands.indexOf(registrations[0]);
    const holdVerification = result.commands.findIndex((line, index) =>
      index > holdRegistration && line.includes("describe-scalable-targets")
    );
    const protectedServiceRecheck = result.commands.findIndex((line, index) =>
      index > holdVerification && line.includes("ecs describe-services")
    );
    const restoreRegistration = result.commands.indexOf(registrations[1]);
    const restoreVerification = result.commands.findIndex((line, index) =>
      index > restoreRegistration && line.includes("describe-scalable-targets")
    );
    assert.ok(firstServiceCheck < holdRegistration);
    assert.ok(holdRegistration < holdVerification);
    assert.ok(holdVerification < protectedServiceRecheck);
    assert.ok(protectedServiceRecheck < restoreRegistration);
    assert.ok(restoreRegistration < restoreVerification);
  });

  it("preserves both prior scheduled-scaling states while dynamic scaling is held", () => {
    for (const priorScheduled of [false, true]) {
      const scheduled = priorScheduled ? "True" : "False";
      const result = runLibrary(`
trap deploy_exit_cleanup EXIT
${captureDefaultRollbackRevisions}
acquire_production_scaling_hold
restore_production_scaling_hold
`, {
        serviceSnapshots: [stableServices()],
        scalingSnapshots: [
          `False\tFalse\t${scheduled}`,
          `True\tTrue\t${scheduled}`,
          `False\tFalse\t${scheduled}`,
        ],
      });

      assert.equal(result.status, 0, result.stderr);
      const registrations = registerCommands(result.commands);
      assert.equal(registrations.length, 2);
      assert.match(
        registrations[0],
        new RegExp(`DynamicScalingInSuspended=true,DynamicScalingOutSuspended=true,ScheduledScalingSuspended=${String(priorScheduled)}`)
      );
      assert.match(
        registrations[1],
        new RegExp(`DynamicScalingInSuspended=false,DynamicScalingOutSuspended=false,ScheduledScalingSuspended=${String(priorScheduled)}`)
      );
    }
  });

  it("fails a stale API change under the hold and restores prior scaling state", () => {
    const result = runLibrary(`
trap deploy_exit_cleanup EXIT
production_backend_capacity_preflight
${captureObservedRollbackRevisions}
acquire_production_scaling_hold
`, {
      serviceSnapshots: [stableServices({ apiDesired: "2" }), stableServices({ apiDesired: "3" })],
      scalingSnapshots: ["False\tFalse\tFalse", "True\tTrue\tFalse", "False\tFalse\tFalse"],
    });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /capacity changed after the initial preflight/);
    const registrations = registerCommands(result.commands);
    assert.equal(registrations.length, 2);
    assert.match(registrations.at(-1)!, /DynamicScalingInSuspended=false,DynamicScalingOutSuspended=false,ScheduledScalingSuspended=false/);
  });

  it("restores scaling from the EXIT trap when guarded rollout work fails", () => {
    const result = runLibrary(`
trap deploy_exit_cleanup EXIT
production_backend_capacity_preflight
${captureObservedRollbackRevisions}
acquire_production_scaling_hold
false
`, {
      serviceSnapshots: [stableServices(), stableServices()],
      scalingSnapshots: ["False\tTrue\tFalse", "True\tTrue\tFalse", "False\tTrue\tFalse"],
    });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /attempting recovery/);
    const registrations = registerCommands(result.commands);
    assert.equal(registrations.length, 2);
    assert.match(registrations.at(-1)!, /DynamicScalingInSuspended=false,DynamicScalingOutSuspended=true,ScheduledScalingSuspended=false/);
  });

  it("fails the deploy after explicit restore failure even when EXIT recovery succeeds", () => {
    const result = runLibrary(`
trap deploy_exit_cleanup EXIT
production_backend_capacity_preflight
${captureObservedRollbackRevisions}
acquire_production_scaling_hold
restore_production_scaling_hold
`, {
      serviceSnapshots: [stableServices(), stableServices()],
      scalingSnapshots: ["False\tFalse\tFalse", "True\tTrue\tFalse", "False\tFalse\tFalse"],
      registerFailCalls: [2],
    });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Could not restore the prior production API autoscaling suspended state/);
    assert.match(result.stderr, /attempting recovery/);
    const registrations = registerCommands(result.commands);
    assert.equal(registrations.length, 3);
    assert.match(registrations.at(-1)!, /DynamicScalingInSuspended=false,DynamicScalingOutSuspended=false,ScheduledScalingSuspended=false/);
  });

  it("surfaces immediate manual recovery when EXIT restoration also fails", () => {
    const result = runLibrary(`
trap deploy_exit_cleanup EXIT
production_backend_capacity_preflight
${captureObservedRollbackRevisions}
acquire_production_scaling_hold
false
`, {
      serviceSnapshots: [stableServices(), stableServices()],
      scalingSnapshots: ["False\tFalse\tFalse", "True\tTrue\tFalse"],
      registerFailCalls: [2],
    });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /EXIT recovery could not restore production API autoscaling/);
    assert.match(result.stderr, /Manual recovery is required immediately/);
    assert.equal(registerCommands(result.commands).length, 2);
  });

  it("rejects worker revision drift after immutable rollback capture and restores autoscaling", () => {
    const result = runLibrary(`
trap deploy_exit_cleanup EXIT
production_backend_capacity_preflight
${captureObservedRollbackRevisions}
acquire_production_scaling_hold
`, {
      serviceSnapshots: [
        stableServices(),
        stableServices({
          workerTaskDefinition: "arn:aws:ecs:us-east-1:135775632425:task-definition/schoolpilot-production-scheduler-worker:22",
        }),
      ],
      scalingSnapshots: ["False\tTrue\tFalse", "True\tTrue\tFalse", "False\tTrue\tFalse"],
    });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /task revisions changed after the immutable rollback identities were captured/);
    assert.match(result.stderr, /attempting recovery/);
    const registrations = registerCommands(result.commands);
    assert.equal(registrations.length, 2);
    assert.match(
      registrations.at(-1)!,
      /DynamicScalingInSuspended=false,DynamicScalingOutSuspended=true,ScheduledScalingSuspended=false/
    );
  });

  it("fails closed when the autoscaling target state is absent or ambiguous", () => {
    for (const snapshot of ["", "None\tNone\tNone", "False\tFalse\tFalse\nTrue\tTrue\tTrue"]) {
      const result = runLibrary("acquire_production_scaling_hold", {
        scalingSnapshots: [snapshot],
      });
      assert.notEqual(result.status, 0, `unexpectedly accepted ${JSON.stringify(snapshot)}`);
      assert.match(result.stderr, /suspended state was missing or ambiguous|Could not read/);
      assert.equal(registerCommands(result.commands).length, 0);
    }
  });
});
