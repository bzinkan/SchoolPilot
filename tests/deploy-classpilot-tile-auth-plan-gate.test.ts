import { describe, it } from "node:test";
import assert from "node:assert/strict";
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
    assert.doesNotMatch(implementation, /tile-auth-plan-events|cat .*log/);
    assert.match(
      implementation,
      /events_json=\$\(aws logs get-log-events[\s\S]*printf '%s' "\$events_json" \|/
    );
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
