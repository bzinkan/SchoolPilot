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

const deploySource = readFileSync(new URL("../scripts/deploy.sh", import.meta.url), "utf8");
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
  apiRollout?: string;
  workerStatus?: string;
  workerDesired?: string;
  workerRunning?: string;
  workerPending?: string;
  workerDeployments?: string;
  workerRollout?: string;
  omitApi?: boolean;
  omitWorker?: boolean;
} = {}): string {
  const apiDesired = options.apiDesired ?? "1";
  const workerDesired = options.workerDesired ?? "1";
  const rows: string[] = [];
  if (!options.omitApi) {
    rows.push([
      "schoolpilot-production-api",
      options.apiStatus ?? "ACTIVE",
      apiDesired,
      options.apiRunning ?? apiDesired,
      options.apiPending ?? "0",
      options.apiDeployments ?? "1",
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
      options.workerRollout ?? "COMPLETED",
    ].join("\t"));
  }
  return rows.join("\n");
}

type LibraryRunOptions = {
  environment?: string;
  deployBackend?: boolean;
  skipWait?: boolean;
  serviceSnapshots?: string[];
  scalingSnapshots?: string[];
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

  const script = `
${deployLibrarySource}
ENV="$TEST_ENVIRONMENT"
DEPLOY_BACKEND="$TEST_DEPLOY_BACKEND"
SKIP_WAIT="$TEST_SKIP_WAIT"
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
      TEST_SKIP_WAIT: String(options.skipWait ?? false),
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

describe("production backend deployment capacity guard", () => {
  it("runs the initial preflight before every Docker, ECR, migration, and ECS mutation", () => {
    const execution = deploySource.slice(libraryBoundary);
    const invocation = execution.indexOf("\nproduction_backend_capacity_preflight\n");
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

    assert.ok(invocation >= 0, "capacity preflight should be invoked");
    assert.ok(invocation < Math.min(...mutationIndexes));
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
    const workerUpdate = execution.indexOf("aws ecs update-service", apiUpdate + 1);
    const restore = execution.indexOf("\n  if ! restore_production_scaling_hold; then", workerUpdate);
    const lastServiceWait = execution.lastIndexOf("aws ecs wait services-stable", restore);
    const finalCapacityCheck = execution.lastIndexOf(
      'production_backend_capacity_preflight "after ECS stabilization"',
      restore
    );

    assert.ok(hold >= 0 && hold < migration);
    assert.ok(migration < preUpdateCapacityCheck && preUpdateCapacityCheck < apiUpdate);
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
    ];

    for (const snapshot of cases) {
      const result = runLibrary("production_backend_capacity_preflight", {
        serviceSnapshots: [snapshot],
      });
      assert.notEqual(result.status, 0, `unexpectedly accepted ${JSON.stringify(snapshot)}`);
      assert.match(result.stderr, /is not stable/);
    }
  });

  it("fails closed on missing, malformed, duplicate, or failed service snapshots", () => {
    const cases = [
      stableServices({ omitWorker: true }),
      `${stableServices()}\n${stableServices({ omitWorker: true })}`,
      stableServices({ apiDesired: "02" }),
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
restore_production_scaling_hold
`;
    const staging = runLibrary(body, { environment: "staging", skipWait: true });
    const frontend = runLibrary(body, { deployBackend: false, skipWait: true });

    assert.equal(staging.status, 0, staging.stderr);
    assert.equal(frontend.status, 0, frontend.stderr);
    assert.deepEqual(staging.commands, []);
    assert.deepEqual(frontend.commands, []);
  });

  it("dynamically acquires the hold before recheck and restores the exact prior state afterward", () => {
    const result = runLibrary(`
trap deploy_exit_cleanup EXIT
production_backend_capacity_preflight
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
