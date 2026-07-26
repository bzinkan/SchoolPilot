import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildClasspilotTileAuthorizationPlanObservationAttempt,
  OBSERVATION_ATTEMPT_RELATIVE_FILE,
  writeClasspilotTileAuthorizationPlanObservationAttempt,
} from "../scripts/manage-classpilot-tile-auth-plan-observation.mjs";
import {
  inspectClasspilotTileAuthorizationPlanObservationReread,
  OBSERVATION_REREAD_ATTEMPT_FILENAME,
  OBSERVATION_REREAD_PACKET_FILENAME,
  OBSERVATION_REREAD_PREFLIGHT_FILENAME,
  OBSERVATION_REREAD_SELECTION_FILENAME,
  OBSERVATION_REREAD_VERSION,
} from "../scripts/manage-classpilot-tile-auth-plan-observation-evidence-reread.mjs";
import {
  resolveObservationRereadGitExecutable,
  runClasspilotTileAuthorizationPlanObservationReread,
} from "../scripts/reread-classpilot-tile-auth-plan-observation-evidence.mjs";

const previousEnvironment = {
  NODE_ENV: process.env.NODE_ENV,
  CLP_LOAD_FIXTURE_TEST_MODE: process.env.CLP_LOAD_FIXTURE_TEST_MODE,
  CLP_LOAD_GATES_TEST_ROOT: process.env.CLP_LOAD_GATES_TEST_ROOT,
};
const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
  for (const [key, value] of Object.entries(previousEnvironment)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function hash(value: Buffer | string) {
  return createHash("sha256").update(value).digest("hex");
}

function privateJson(value: unknown) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function validPreflight() {
  return {
    version: "classpilot-tile-auth-plan-base-preflight-v1",
    status: "passed",
    eligibleBases: 1,
    requiredSessionPairs: 80,
    reusedActiveSessionPairs: 80,
    missingSessionPairs: 0,
    conflictingSessionPairs: 0,
  };
}

function validSelection() {
  return {
    version: "classpilot-tile-auth-plan-base-selection-v1",
    cohortSize: 40,
    canonicalPrimaryOnlyGroups: 19,
    exactCohortGroups: 19,
    eligibleSchools: 1,
    finalBases: 1,
  };
}

function sourceFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sp-observation-reread-"));
  temporaryRoots.push(root);
  process.env.NODE_ENV = "test";
  process.env.CLP_LOAD_FIXTURE_TEST_MODE = "1";
  process.env.CLP_LOAD_GATES_TEST_ROOT = root;

  const applicationGitSha = "c".repeat(40);
  const observationId = "tile-plan-observe-20260726t035926z-cf9b70420b71";
  const runRoot = path.join(
    root,
    "tile-auth-observations",
    applicationGitSha,
    observationId
  );
  const identity = {
    observationId,
    applicationGitSha,
    imageDigest: `sha256:${"2".repeat(64)}`,
    candidateApiTaskDefinitionArn:
      "arn:aws:ecs:us-east-1:135775632425:task-definition/schoolpilot-production-api-emergency:36",
    candidateWorkerTaskDefinitionArn:
      "arn:aws:ecs:us-east-1:135775632425:task-definition/schoolpilot-production-scheduler-worker:51",
    activeApiTaskDefinitionArn:
      "arn:aws:ecs:us-east-1:135775632425:task-definition/schoolpilot-production-api-emergency:31",
    activeWorkerTaskDefinitionArn:
      "arn:aws:ecs:us-east-1:135775632425:task-definition/schoolpilot-production-scheduler-worker:48",
    initialNetworkConfigurationSha256: "4".repeat(64),
    initialProductionPostureSha256: "5".repeat(64),
  };
  const taskArn =
    `arn:aws:ecs:us-east-1:135775632425:task/schoolpilot-production-cluster/${"a".repeat(32)}`;
  const attempt =
    buildClasspilotTileAuthorizationPlanObservationAttempt({
      ...identity,
      createdAtUtc: "2026-07-26T03:59:28.318Z",
    });
  const admitted =
    writeClasspilotTileAuthorizationPlanObservationAttempt(runRoot, attempt);
  const packet = {
    schemaVersion: 2,
    type: "classpilot_tile_auth_plan_observation",
    version: "classpilot-tile-auth-plan-observation-v2",
    status: "observed",
    observationId,
    attemptRecordFile: OBSERVATION_ATTEMPT_RELATIVE_FILE,
    attemptRecordSha256: admitted.sha256,
    observationOutcome: "evidence_unavailable",
    applicationGitSha,
    imageDigest: identity.imageDigest,
    candidateApiTaskDefinitionArn:
      identity.candidateApiTaskDefinitionArn,
    candidateWorkerTaskDefinitionArn:
      identity.candidateWorkerTaskDefinitionArn,
    activeBaseline: {
      apiTaskDefinitionArn: identity.activeApiTaskDefinitionArn,
      workerTaskDefinitionArn: identity.activeWorkerTaskDefinitionArn,
    },
    initialNetworkConfigurationSha256:
      identity.initialNetworkConfigurationSha256,
    initialProductionPostureSha256:
      identity.initialProductionPostureSha256,
    terminalTask: { state: "exited", taskArn, exitCode: 0 },
    collection: {
      status: "failed",
      attemptCount: 0,
      completedAtUtc: "2026-07-26T04:00:27.333Z",
      failureCode: "log_evidence_unavailable",
      canonicalEventSha256: null,
      logStreamSha256: null,
      rawErrorPersisted: false,
    },
    finalNetwork: {
      status: "verified",
      sha256: identity.initialNetworkConfigurationSha256,
      failureCode: null,
    },
    finalProductionPosture: {
      status: "verified",
      sha256: identity.initialProductionPostureSha256,
      failureCode: null,
    },
    preflightEvidenceFile: null,
    preflightEvidenceSha256: null,
    selectionEvidenceFile: null,
    selectionEvidenceSha256: null,
    funnelEvidenceFile: null,
    funnelEvidenceSha256: null,
    eligibleForDeployment: false,
    eligibleForDiagnostic: false,
    eligibleForCertification: false,
    createdAtUtc: "2026-07-26T04:00:30.561Z",
  };
  const terminal = path.join(runRoot, "terminal");
  fs.mkdirSync(terminal);
  const packetPath = path.join(
    terminal,
    "classpilot-tile-auth-plan-observation.private.json"
  );
  fs.writeFileSync(packetPath, privateJson(packet), { mode: 0o600 });
  const packetSha256 = hash(fs.readFileSync(packetPath));
  const options = {
    sourcePacketPath: packetPath,
    expectedSourcePacketSha256: packetSha256,
    expectedSourceAttemptSha256: admitted.sha256,
    rereadId: "tile-plan-reread-20260726t120000z-controller",
    controllerGitSha: "d".repeat(40),
    expectedObservationId: observationId,
    expectedApplicationGitSha: applicationGitSha,
    expectedImageDigest: identity.imageDigest,
    expectedCandidateApiTaskDefinitionArn:
      identity.candidateApiTaskDefinitionArn,
    expectedCandidateWorkerTaskDefinitionArn:
      identity.candidateWorkerTaskDefinitionArn,
    expectedTaskArn: taskArn,
    cluster: "schoolpilot-production-cluster",
    region: "us-east-1",
    accountId: "135775632425",
    deadlineMs: 300_000,
  };
  return {
    root,
    runRoot,
    packetPath,
    packetSha256,
    admitted,
    options,
  };
}

function stoppedTask(options: ReturnType<typeof sourceFixture>["options"]) {
  return {
    failures: [],
    tasks: [
      {
        taskArn: options.expectedTaskArn,
        taskDefinitionArn:
          options.expectedCandidateApiTaskDefinitionArn,
        lastStatus: "STOPPED",
        containers: [
          {
            name: "api",
            lastStatus: "STOPPED",
            exitCode: 0,
            logStreamName: null,
          },
        ],
      },
    ],
  };
}

function logConfiguration() {
  return {
    logDriver: "awslogs",
    options: {
      "awslogs-group": "/ecs/schoolpilot-production-api",
      "awslogs-region": "us-east-1",
      "awslogs-stream-prefix": "api",
    },
  };
}

function recoveredCollection() {
  const eventsDocument = {
    events: [
      {
        timestamp: 1,
        ingestionTime: 2,
        message: JSON.stringify(validSelection()),
      },
      {
        timestamp: 3,
        ingestionTime: 4,
        message: JSON.stringify(validPreflight()),
      },
    ],
  };
  return {
    binding: {
      logGroup: "/ecs/schoolpilot-production-api",
      logRegion: "us-east-1",
      logPrefix: "api",
      logStream: `api/api/${"a".repeat(32)}`,
      exitCode: 0,
    },
    collection: {
      status: "completed",
      attemptCount: 1,
      completedAtUtc: "2026-07-26T12:00:05.000Z",
      failureCode: null,
      canonicalEventSha256: hash(
        JSON.stringify({
          events: eventsDocument.events.map((event) => ({
            ingestionTime: event.ingestionTime,
            message: event.message,
            timestamp: event.timestamp,
          })),
        })
      ),
      logStreamSha256: hash(`api/api/${"a".repeat(32)}`),
      rawErrorPersisted: false,
    },
    eventsDocument,
  };
}

function controllerRepository(
  options: ReturnType<typeof sourceFixture>["options"],
  overrides: Partial<{
    branch: string;
    clean: boolean;
    headSha: string;
    originMainSha: string;
  }> = {}
) {
  return {
    branch: "main",
    clean: true,
    headSha: options.controllerGitSha,
    originMainSha: options.controllerGitSha,
    ...overrides,
  };
}

function testDependencies(
  fixture: ReturnType<typeof sourceFixture>,
  dependencies: Record<string, unknown> = {}
) {
  return {
    inspectControllerRepository: async () =>
      controllerRepository(fixture.options),
    ...dependencies,
  };
}

function rereadCliArguments(
  options: ReturnType<typeof sourceFixture>["options"],
  deadlineMs = options.deadlineMs
) {
  return [
    "--source-packet",
    options.sourcePacketPath,
    "--expected-source-packet-sha256",
    options.expectedSourcePacketSha256,
    "--expected-source-attempt-sha256",
    options.expectedSourceAttemptSha256,
    "--reread-id",
    options.rereadId,
    "--controller-sha",
    options.controllerGitSha,
    "--expected-observation-id",
    options.expectedObservationId,
    "--expected-application-sha",
    options.expectedApplicationGitSha,
    "--expected-image-digest",
    options.expectedImageDigest,
    "--expected-candidate-api-task-definition-arn",
    options.expectedCandidateApiTaskDefinitionArn,
    "--expected-candidate-worker-task-definition-arn",
    options.expectedCandidateWorkerTaskDefinitionArn,
    "--expected-task-arn",
    options.expectedTaskArn,
    "--cluster",
    options.cluster,
    "--region",
    options.region,
    "--account-id",
    options.accountId,
    "--deadline-ms",
    String(deadlineMs),
  ];
}

function writeRereadProcessPreload(
  root: string,
  controllerGitSha: string,
  options: ReturnType<typeof sourceFixture>["options"]
) {
  const preloadPath = path.join(root, "fake-process-preload.cjs");
  const callsPath = path.join(root, "process-calls.jsonl");
  fs.writeFileSync(callsPath, "", { mode: 0o600 });
  fs.writeFileSync(
    preloadPath,
    String.raw`
const fs = require("node:fs");
const path = require("node:path");
const command = path.basename(process.argv[1] || "");
const args = process.argv.slice(2);
const handled = new Set(["rev-parse", "status", "ecs", "logs"]);
if (handled.has(command)) {
  fs.appendFileSync(
    process.env.FAKE_PROCESS_CALLS_FILE,
    JSON.stringify({ command, args }) + "\n",
    "utf8"
  );
}
if (command === "rev-parse") {
  process.stdout.write(
    args[0] === "--abbrev-ref"
      ? "main\n"
      : process.env.FAKE_CONTROLLER_SHA + "\n"
  );
  process.exit(0);
}
if (command === "status") {
  process.exit(0);
}
if (command === "ecs" && args[0] === "describe-tasks") {
  process.stdout.write(
    JSON.stringify({
      failures: [],
      tasks: [{
        taskArn: process.env.FAKE_TASK_ARN,
        taskDefinitionArn: process.env.FAKE_TASK_DEFINITION_ARN,
        lastStatus: "STOPPED",
        containers: [{
          name: "api",
          lastStatus: "STOPPED",
          exitCode: 0,
          logStreamName: null,
        }],
      }],
    })
  );
  process.exit(0);
}
if (
  command === "ecs" &&
  args[0] === "describe-task-definition"
) {
  process.stdout.write(
    JSON.stringify({
      logDriver: "awslogs",
      options: {
        "awslogs-group": "/ecs/schoolpilot-production-api",
        "awslogs-region": "us-east-1",
        "awslogs-stream-prefix": "api",
      },
    })
  );
  process.exit(0);
}
if (command === "logs") {
  const tokenIndex = args.indexOf("--next-token");
  if (tokenIndex >= 0) {
    process.stdout.write(
      JSON.stringify({
        events: [],
        nextForwardToken: args[tokenIndex + 1],
      })
    );
  } else {
    process.stdout.write(
      JSON.stringify({
        events: JSON.parse(
          Buffer.from(
            process.env.FAKE_LOG_EVENTS_BASE64,
            "base64"
          ).toString("utf8")
        ),
        nextForwardToken: "stable-token",
      })
    );
  }
  process.exit(0);
}
`,
    { mode: 0o600 }
  );
  return {
    callsPath,
    environment: {
      ...process.env,
      NODE_ENV: "test",
      CLP_LOAD_FIXTURE_TEST_MODE: "1",
      GIT_EXECUTABLE: process.execPath,
      AWS_CLI_EXECUTABLE: process.execPath,
      NODE_OPTIONS:
        `--require=${preloadPath.replaceAll("\\", "/")}`,
      FAKE_PROCESS_CALLS_FILE: callsPath,
      FAKE_CONTROLLER_SHA: controllerGitSha,
      FAKE_TASK_ARN: options.expectedTaskArn,
      FAKE_TASK_DEFINITION_ARN:
        options.expectedCandidateApiTaskDefinitionArn,
      FAKE_LOG_EVENTS_BASE64: Buffer.from(
        JSON.stringify([
          {
            timestamp: 1,
            ingestionTime: 2,
            message: JSON.stringify(validSelection()),
          },
          {
            timestamp: 3,
            ingestionTime: 4,
            message: JSON.stringify(validPreflight()),
          },
        ]),
        "utf8"
      ).toString("base64"),
    },
  };
}

describe("ClassPilot observation evidence reread", () => {
  it("caps both programmatic and CLI rereads at five minutes", async () => {
    const fixture = sourceFixture();
    let awsCalls = 0;
    await assert.rejects(
      () =>
        runClasspilotTileAuthorizationPlanObservationReread(
          { ...fixture.options, deadlineMs: 300_001 },
          testDependencies(fixture, {
            runAwsJson: async () => {
              awsCalls += 1;
              return {};
            },
          })
        ),
      /observation_reread_arguments_invalid/
    );
    assert.equal(awsCalls, 0);
    assert.equal(
      fs.existsSync(path.join(fixture.runRoot, "evidence-reread")),
      false
    );

    const rereadScript = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "../scripts/reread-classpilot-tile-auth-plan-observation-evidence.mjs"
    );
    const child = spawnSync(
      process.execPath,
      [
        rereadScript,
        ...rereadCliArguments(fixture.options, 300_001),
      ],
      {
        cwd: path.resolve(
          path.dirname(fileURLToPath(import.meta.url)),
          ".."
        ),
        encoding: "utf8",
        env: {
          ...process.env,
          NODE_ENV: "test",
          CLP_LOAD_FIXTURE_TEST_MODE: "1",
        },
        timeout: 30_000,
      }
    );
    assert.equal(child.status, 1);
    assert.equal(
      child.stderr,
      "classpilot_tile_auth_plan_observation_reread_failed\n"
    );
    assert.equal(
      fs.existsSync(path.join(fixture.runRoot, "evidence-reread")),
      false
    );
  });

  it("confines the subprocess Git override to a disposable test evidence root", () => {
    const fixture = sourceFixture();
    assert.equal(
      resolveObservationRereadGitExecutable(
        {
          NODE_ENV: "test",
          CLP_LOAD_FIXTURE_TEST_MODE: "1",
          CLP_LOAD_GATES_TEST_ROOT: fixture.root,
          GIT_EXECUTABLE: process.execPath,
        } as NodeJS.ProcessEnv,
        os.tmpdir()
      ),
      process.execPath
    );
    for (const environment of [
      {
        NODE_ENV: "test",
        CLP_LOAD_FIXTURE_TEST_MODE: "1",
        GIT_EXECUTABLE: process.execPath,
      },
      {
        NODE_ENV: "test",
        CLP_LOAD_FIXTURE_TEST_MODE: "1",
        CLP_LOAD_GATES_TEST_ROOT: path.resolve(
          os.tmpdir(),
          "..",
          "not-disposable"
        ),
        GIT_EXECUTABLE: process.execPath,
      },
    ]) {
      assert.throws(
        () =>
          resolveObservationRereadGitExecutable(
            environment as NodeJS.ProcessEnv,
            os.tmpdir()
          ),
        /observation_reread_controller_repository_invalid/
      );
    }

    const processStub = writeRereadProcessPreload(
      fixture.root,
      fixture.options.controllerGitSha,
      fixture.options
    );
    delete processStub.environment.CLP_LOAD_GATES_TEST_ROOT;
    const rereadScript = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "../scripts/reread-classpilot-tile-auth-plan-observation-evidence.mjs"
    );
    const child = spawnSync(
      process.execPath,
      [rereadScript, ...rereadCliArguments(fixture.options, 5_000)],
      {
        cwd: path.resolve(
          path.dirname(fileURLToPath(import.meta.url)),
          ".."
        ),
        encoding: "utf8",
        env: processStub.environment,
        timeout: 30_000,
      }
    );
    assert.equal(child.status, 1);
    assert.equal(
      child.stderr,
      "classpilot_tile_auth_plan_observation_reread_failed\n"
    );
    assert.equal(
      fs.existsSync(path.join(fixture.runRoot, "evidence-reread")),
      false
    );
    assert.equal(
      fs.readFileSync(processStub.callsPath, "utf8"),
      ""
    );
  });

  it("executes the real CLI, Git inspection, AWS reads, resolver, and packet writer", () => {
    const fixture = sourceFixture();
    const processStub = writeRereadProcessPreload(
      fixture.root,
      fixture.options.controllerGitSha,
      fixture.options
    );
    const rereadScript = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "../scripts/reread-classpilot-tile-auth-plan-observation-evidence.mjs"
    );
    const child = spawnSync(
      process.execPath,
      [rereadScript, ...rereadCliArguments(fixture.options, 5_000)],
      {
        cwd: path.resolve(
          path.dirname(fileURLToPath(import.meta.url)),
          ".."
        ),
        encoding: "utf8",
        env: processStub.environment,
        timeout: 60_000,
      }
    );
    assert.equal(child.status, 0, child.stderr);
    const result = JSON.parse(child.stdout);
    assert.equal(result.recovered, true);
    assert.equal(result.rereadOutcome, "evidence_recovered");
    assert.equal(result.taskLaunchCount, 0);
    assert.equal(result.eligibleForDeployment, false);
    assert.equal(result.eligibleForDiagnostic, false);
    assert.equal(result.eligibleForCertification, false);

    const calls = fs
      .readFileSync(processStub.callsPath, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    assert.ok(
      calls.some(
        (call) =>
          call.command === "ecs" &&
          call.args[0] === "describe-tasks"
      )
    );
    assert.ok(
      calls.some(
        (call) =>
          call.command === "ecs" &&
          call.args[0] === "describe-task-definition"
      )
    );
    assert.ok(
      calls.filter((call) => call.command === "logs").length >= 2
    );
    assert.equal(
      calls.some(
        (call) =>
          call.command === "ecs" &&
          call.args[0] === "run-task"
      ),
      false
    );

    const packet = JSON.parse(fs.readFileSync(result.path, "utf8"));
    assert.equal(packet.status, "recovered");
    assert.equal(packet.collectionAttemptCount, 1);
    assert.match(packet.logBindingSha256, /^[a-f0-9]{64}$/);
    assert.match(packet.canonicalEventSha256, /^[a-f0-9]{64}$/);
    const inspected =
      inspectClasspilotTileAuthorizationPlanObservationReread(
        result.path,
        result.sha256
      );
    assert.equal(inspected.rereadOutcome, "evidence_recovered");
  });

  it("admits once, performs only read operations, and seals recovered companions atomically", async () => {
    const fixture = sourceFixture();
    const calls: string[] = [];
    let collectorCalls = 0;
    const result =
      await runClasspilotTileAuthorizationPlanObservationReread(
        fixture.options,
        testDependencies(fixture, {
          runAwsJson: async (
            service: string,
            operation: string
          ) => {
            calls.push(`${service} ${operation}`);
            if (operation === "describe-tasks") {
              return stoppedTask(fixture.options);
            }
            if (operation === "describe-task-definition") {
              return logConfiguration();
            }
            throw new Error("unexpected_operation");
          },
          collectBound: async () => {
            collectorCalls += 1;
            return recoveredCollection();
          },
        })
      );

    assert.equal(result.recovered, true);
    assert.deepEqual(calls, [
      "ecs describe-tasks",
      "ecs describe-task-definition",
    ]);
    assert.equal(collectorCalls, 1);
    assert.equal(result.version, OBSERVATION_REREAD_VERSION);
    assert.equal(result.rereadOutcome, "evidence_recovered");
    assert.equal(result.taskLaunchCount, 0);
    assert.equal(result.eligibleForDeployment, false);
    assert.equal(result.eligibleForDiagnostic, false);
    assert.equal(result.eligibleForCertification, false);

    const outputRoot = path.join(fixture.runRoot, "evidence-reread");
    assert.deepEqual(
      fs.readdirSync(path.join(outputRoot, "attempt")),
      [OBSERVATION_REREAD_ATTEMPT_FILENAME]
    );
    assert.deepEqual(
      fs.readdirSync(path.join(outputRoot, "terminal")).sort(),
      [
        OBSERVATION_REREAD_PACKET_FILENAME,
        OBSERVATION_REREAD_PREFLIGHT_FILENAME,
        OBSERVATION_REREAD_SELECTION_FILENAME,
      ].sort()
    );
    const packet = JSON.parse(fs.readFileSync(result.path, "utf8"));
    assert.equal(packet.taskLaunchCount, 0);
    assert.equal(packet.sourceObservation.observationPacketSha256, fixture.packetSha256);
    assert.equal(
      packet.sourceObservation.observationAttemptSha256,
      fixture.admitted.sha256
    );
    assert.equal(packet.sourceObservation.terminalTaskArn, fixture.options.expectedTaskArn);
    assert.equal(packet.collectionAttemptCount, 1);
    assert.match(packet.taskDescriptionSha256, /^[a-f0-9]{64}$/);
    assert.match(packet.logConfigurationSha256, /^[a-f0-9]{64}$/);
    assert.match(packet.logBindingSha256, /^[a-f0-9]{64}$/);
    assert.match(packet.logStreamSha256, /^[a-f0-9]{64}$/);
    assert.match(packet.canonicalEventSha256, /^[a-f0-9]{64}$/);

    await assert.rejects(
      () =>
        runClasspilotTileAuthorizationPlanObservationReread(
          fixture.options,
          testDependencies(fixture, {
            runAwsJson: async () => {
              throw new Error("must_not_be_called");
            },
          })
        ),
      /classpilot_tile_auth_plan_observation_reread_already_exists/
    );
    assert.equal(calls.length, 2);
  });

  it("seals one sanitized failed terminal when ECS reports the historical task missing", async () => {
    const fixture = sourceFixture();
    const calls: string[] = [];
    let collectorCalls = 0;
    const result =
      await runClasspilotTileAuthorizationPlanObservationReread(
        fixture.options,
        testDependencies(fixture, {
          runAwsJson: async (
            service: string,
            operation: string
          ) => {
            calls.push(`${service} ${operation}`);
            return {
              tasks: [],
              failures: [
                {
                  arn: fixture.options.expectedTaskArn,
                  reason: "MISSING",
                  detail: "provider detail is intentionally discarded",
                },
              ],
            };
          },
          collectBound: async () => {
            collectorCalls += 1;
            throw new Error("must_not_collect");
          },
        })
      );

    assert.equal(result.recovered, false);
    assert.deepEqual(calls, ["ecs describe-tasks"]);
    assert.equal(collectorCalls, 0);
    const packet = JSON.parse(fs.readFileSync(result.path, "utf8"));
    assert.equal(packet.status, "failed");
    assert.equal(packet.rereadOutcome, "evidence_unavailable");
    assert.equal(packet.failureCode, "historical_task_missing");
    assert.equal(packet.collectionAttemptCount, 0);
    assert.equal(packet.taskLaunchCount, 0);
    assert.equal(packet.rawErrorPersisted, false);
    assert.equal(packet.preflightEvidenceFile, null);
    assert.equal(packet.selectionEvidenceFile, null);
    assert.doesNotMatch(JSON.stringify(packet), /provider detail/);
    assert.deepEqual(
      fs.readdirSync(path.dirname(result.path)),
      [OBSERVATION_REREAD_PACKET_FILENAME]
    );
    const inspected =
      inspectClasspilotTileAuthorizationPlanObservationReread(
        result.path,
        result.sha256
      );
    assert.equal(inspected.rereadOutcome, "evidence_unavailable");
    await assert.rejects(() =>
      runClasspilotTileAuthorizationPlanObservationReread(
        fixture.options,
        testDependencies(fixture, {
          runAwsJson: async () => stoppedTask(fixture.options),
        })
      )
    );
  });

  it("rejects source drift before durable admission or any AWS call", async () => {
    const fixture = sourceFixture();
    let calls = 0;
    fixture.options.expectedSourcePacketSha256 = "f".repeat(64);
    await assert.rejects(() =>
      runClasspilotTileAuthorizationPlanObservationReread(
        fixture.options,
          testDependencies(fixture, {
            runAwsJson: async () => {
              calls += 1;
              return {};
            },
          })
        )
    );
    assert.equal(calls, 0);
    assert.equal(
      fs.existsSync(path.join(fixture.runRoot, "evidence-reread")),
      false
    );
  });

  it("rejects terminal tampering, extra files, and downstream eligibility", async () => {
    const fixture = sourceFixture();
    const result =
      await runClasspilotTileAuthorizationPlanObservationReread(
        fixture.options,
        testDependencies(fixture, {
          runAwsJson: async (
            _service: string,
            operation: string
          ) =>
            operation === "describe-tasks"
              ? stoppedTask(fixture.options)
              : logConfiguration(),
          collectBound: async () => recoveredCollection(),
        })
      );
    const packet = JSON.parse(fs.readFileSync(result.path, "utf8"));
    for (const field of [
      "eligibleForDeployment",
      "eligibleForDiagnostic",
      "eligibleForCertification",
    ]) {
      const changed = structuredClone(packet);
      changed[field] = true;
      fs.writeFileSync(result.path, privateJson(changed));
      assert.throws(() =>
        inspectClasspilotTileAuthorizationPlanObservationReread(
          result.path,
          hash(fs.readFileSync(result.path))
        )
      );
      fs.writeFileSync(result.path, privateJson(packet));
    }
    fs.writeFileSync(path.join(path.dirname(result.path), "unexpected.json"), "{}");
    assert.throws(() =>
      inspectClasspilotTileAuthorizationPlanObservationReread(
        result.path,
        hash(fs.readFileSync(result.path))
      )
    );
  });

  it("contains no task-launch or mutation operation in the standalone reread CLI", () => {
    const source = fs.readFileSync(
      new URL(
        "../scripts/reread-classpilot-tile-auth-plan-observation-evidence.mjs",
        import.meta.url
      ),
      "utf8"
    );
    assert.doesNotMatch(
      source,
      /\b(?:run-task|update-service|register-task-definition|execute-statement|s3 sync|cloudfront create-invalidation)\b/
    );
    assert.match(source, /"ecs describe-tasks"/);
    assert.match(source, /"ecs describe-task-definition"/);
  });

  it("rejects a hash-identical copied source before admission or AWS reads", async () => {
    const fixture = sourceFixture();
    const copiedRoot = path.join(fixture.root, "copied-observation");
    fs.cpSync(fixture.runRoot, copiedRoot, { recursive: true });
    const copiedPacketPath = path.join(
      copiedRoot,
      "terminal",
      "classpilot-tile-auth-plan-observation.private.json"
    );
    const copiedOptions = {
      ...fixture.options,
      sourcePacketPath: copiedPacketPath,
    };
    let calls = 0;
    await assert.rejects(
      () =>
        runClasspilotTileAuthorizationPlanObservationReread(
          copiedOptions,
          testDependencies(fixture, {
            runAwsJson: async () => {
              calls += 1;
              return {};
            },
          })
        ),
      /classpilot_tile_auth_plan_observation_reread_invalid/
    );
    assert.equal(calls, 0);
    assert.equal(fs.existsSync(path.join(copiedRoot, "evidence-reread")), false);
  });

  it("rejects controller SHA mismatch, dirty state, and non-main state before durable admission", async () => {
    const cases = [
      {
        label: "sha mismatch",
        override: {
          headSha: "e".repeat(40),
          originMainSha: "e".repeat(40),
        },
      },
      { label: "dirty", override: { clean: false } },
      { label: "not main", override: { branch: "feature/test" } },
    ];
    for (const entry of cases) {
      const fixture = sourceFixture();
      let calls = 0;
      await assert.rejects(
        () =>
          runClasspilotTileAuthorizationPlanObservationReread(
            fixture.options,
            {
              inspectControllerRepository: async () =>
                controllerRepository(fixture.options, entry.override),
              runAwsJson: async () => {
                calls += 1;
                return {};
              },
            }
          ),
        /observation_reread_controller_repository_invalid/,
        entry.label
      );
      assert.equal(calls, 0, entry.label);
      assert.equal(
        fs.existsSync(path.join(fixture.runRoot, "evidence-reread")),
        false,
        entry.label
      );
    }
  });

  it("preserves completed collection hashes and attempt count when recovered companions are invalid", async () => {
    const fixture = sourceFixture();
    const collected = recoveredCollection();
    collected.eventsDocument.events[0].message = JSON.stringify({
      ...validSelection(),
      finalBases: 0,
    });
    const result =
      await runClasspilotTileAuthorizationPlanObservationReread(
        fixture.options,
        testDependencies(fixture, {
          runAwsJson: async (
            _service: string,
            operation: string
          ) =>
            operation === "describe-tasks"
              ? stoppedTask(fixture.options)
              : logConfiguration(),
          collectBound: async () => collected,
        })
      );

    assert.equal(result.recovered, false);
    const packet = JSON.parse(fs.readFileSync(result.path, "utf8"));
    assert.equal(packet.failureCode, "recovered_evidence_invalid");
    assert.equal(packet.collectionAttemptCount, 1);
    assert.equal(
      packet.logStreamSha256,
      collected.collection.logStreamSha256
    );
    assert.equal(
      packet.canonicalEventSha256,
      collected.collection.canonicalEventSha256
    );
    assert.equal(packet.preflightEvidenceFile, null);
    assert.equal(packet.selectionEvidenceFile, null);
  });
});
