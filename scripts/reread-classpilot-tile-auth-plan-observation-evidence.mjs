#!/usr/bin/env node

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  collectBoundClasspilotTileAuthorizationPlanObservationEvidence,
} from "./collect-classpilot-tile-auth-plan-observation-evidence.mjs";
import {
  buildClasspilotTileAuthorizationPlanObservationReread,
  buildClasspilotTileAuthorizationPlanObservationRereadAttempt,
  deriveClasspilotTileAuthorizationPlanObservationRereadRoot,
  inspectClasspilotTileAuthorizationPlanObservationReread,
  writeClasspilotTileAuthorizationPlanObservationReread,
  writeClasspilotTileAuthorizationPlanObservationRereadAttempt,
} from "./manage-classpilot-tile-auth-plan-observation-evidence-reread.mjs";
import {
  extractClasspilotTileAuthorizationPlanBaseSelectionEvidence,
} from "./validate-classpilot-tile-auth-plan-base-selection-evidence.mjs";
import {
  validateClasspilotTileAuthorizationPlanPreflightEvidence,
} from "./validate-classpilot-tile-auth-plan-preflight-evidence.mjs";

const SAFE_REGION = /^[a-z]{2}-[a-z]+-\d$/;
const SAFE_ACCOUNT = /^\d{12}$/;
const SAFE_CLUSTER = /^[A-Za-z0-9_-]{1,255}$/;
const SAFE_ID = /^[a-z0-9][a-z0-9-]{7,127}$/;
const GIT_SHA = /^[a-f0-9]{40}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const IMAGE_DIGEST = /^sha256:[a-f0-9]{64}$/;
const TASK_ARN =
  /^arn:aws:ecs:[a-z0-9-]+:\d{12}:task\/(?:[A-Za-z0-9_-]+\/)?[a-f0-9]{32}$/;
const TASK_DEFINITION_ARN =
  /^arn:aws:ecs:[a-z0-9-]+:\d{12}:task-definition\/[A-Za-z0-9_-]+:[1-9]\d*$/;
const REPOSITORY_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);
const CONTROLLER_REPOSITORY_KEYS = [
  "branch",
  "clean",
  "headSha",
  "originMainSha",
];
const MAX_EVIDENCE_DEADLINE_MS = 300_000;

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, stableValue(value[key])])
  );
}

function stableSha256(value) {
  return createHash("sha256")
    .update(JSON.stringify(stableValue(value)), "utf8")
    .digest("hex");
}

export function resolveObservationRereadGitExecutable(
  environment = process.env,
  temporaryRoot = os.tmpdir()
) {
  const overriddenGitExecutable = environment.GIT_EXECUTABLE;
  if (!overriddenGitExecutable) return "git";
  const configuredTestRoot =
    environment.CLP_LOAD_GATES_TEST_ROOT;
  let relativeTestRoot = null;
  try {
    if (
      typeof configuredTestRoot === "string" &&
      configuredTestRoot.length > 0
    ) {
      relativeTestRoot = path.relative(
        fs.realpathSync(path.resolve(temporaryRoot)),
        fs.realpathSync(path.resolve(configuredTestRoot))
      );
    }
  } catch {
    relativeTestRoot = null;
  }
  if (
    environment.NODE_ENV !== "test" ||
    environment.CLP_LOAD_FIXTURE_TEST_MODE !== "1" ||
    relativeTestRoot === null ||
    relativeTestRoot.length === 0 ||
    relativeTestRoot === ".." ||
    relativeTestRoot.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativeTestRoot)
  ) {
    throw new Error("observation_reread_controller_repository_invalid");
  }
  return overriddenGitExecutable;
}

function defaultGitText(args) {
  const result = spawnSync(
    resolveObservationRereadGitExecutable(),
    args,
    {
    cwd: REPOSITORY_ROOT,
    encoding: "utf8",
    windowsHide: true,
    timeout: 30_000,
    maxBuffer: 4 * 1024 * 1024,
    }
  );
  if (result.error || result.status !== 0 || result.signal) {
    throw new Error("observation_reread_controller_repository_invalid");
  }
  return String(result.stdout ?? "").trim();
}

function defaultControllerRepositoryInspection() {
  return {
    headSha: defaultGitText(["rev-parse", "HEAD"]),
    originMainSha: defaultGitText(["rev-parse", "origin/main"]),
    branch: defaultGitText(["rev-parse", "--abbrev-ref", "HEAD"]),
    clean: defaultGitText(["status", "--porcelain=v1"]) === "",
  };
}

export function validateObservationRereadControllerRepository(
  value,
  expectedControllerGitSha
) {
  if (
    !isRecord(value) ||
    JSON.stringify(Object.keys(value).sort()) !==
      JSON.stringify([...CONTROLLER_REPOSITORY_KEYS].sort()) ||
    !GIT_SHA.test(value.headSha || "") ||
    !GIT_SHA.test(value.originMainSha || "") ||
    value.branch !== "main" ||
    value.clean !== true ||
    value.headSha !== expectedControllerGitSha ||
    value.originMainSha !== expectedControllerGitSha
  ) {
    throw new Error("observation_reread_controller_repository_invalid");
  }
  return value;
}

function bindingSha256(binding) {
  return stableSha256({
    exitCode: binding.exitCode,
    logGroup: binding.logGroup,
    logPrefix: binding.logPrefix,
    logRegion: binding.logRegion,
    logStream: binding.logStream,
  });
}

function parseArguments(argv) {
  const names = {
    "--source-packet": "sourcePacketPath",
    "--expected-source-packet-sha256": "expectedSourcePacketSha256",
    "--expected-source-attempt-sha256": "expectedSourceAttemptSha256",
    "--reread-id": "rereadId",
    "--controller-sha": "controllerGitSha",
    "--expected-observation-id": "expectedObservationId",
    "--expected-application-sha": "expectedApplicationGitSha",
    "--expected-image-digest": "expectedImageDigest",
    "--expected-candidate-api-task-definition-arn":
      "expectedCandidateApiTaskDefinitionArn",
    "--expected-candidate-worker-task-definition-arn":
      "expectedCandidateWorkerTaskDefinitionArn",
    "--expected-task-arn": "expectedTaskArn",
    "--cluster": "cluster",
    "--region": "region",
    "--account-id": "accountId",
    "--deadline-ms": "deadlineMs",
  };
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = names[argv[index]];
    const value = argv[index + 1];
    if (!key || value === undefined || Object.hasOwn(options, key)) {
      throw new Error("observation_reread_arguments_invalid");
    }
    options[key] = value;
  }
  const required = [
    "sourcePacketPath",
    "expectedSourcePacketSha256",
    "expectedSourceAttemptSha256",
    "rereadId",
    "controllerGitSha",
    "expectedObservationId",
    "expectedApplicationGitSha",
    "expectedImageDigest",
    "expectedCandidateApiTaskDefinitionArn",
    "expectedCandidateWorkerTaskDefinitionArn",
    "expectedTaskArn",
    "cluster",
    "region",
    "accountId",
  ];
  if (
    required.some((key) => !Object.hasOwn(options, key)) ||
    typeof options.sourcePacketPath !== "string" ||
    options.sourcePacketPath.length === 0 ||
    options.sourcePacketPath.length > 4096 ||
    !SHA256.test(options.expectedSourcePacketSha256) ||
    !SHA256.test(options.expectedSourceAttemptSha256) ||
    !SAFE_ID.test(options.rereadId) ||
    !GIT_SHA.test(options.controllerGitSha) ||
    !SAFE_ID.test(options.expectedObservationId) ||
    !GIT_SHA.test(options.expectedApplicationGitSha) ||
    !IMAGE_DIGEST.test(options.expectedImageDigest) ||
    !TASK_DEFINITION_ARN.test(
      options.expectedCandidateApiTaskDefinitionArn
    ) ||
    !TASK_DEFINITION_ARN.test(
      options.expectedCandidateWorkerTaskDefinitionArn
    ) ||
    !TASK_ARN.test(options.expectedTaskArn) ||
    !SAFE_CLUSTER.test(options.cluster) ||
    !SAFE_REGION.test(options.region) ||
    !SAFE_ACCOUNT.test(options.accountId) ||
    (options.deadlineMs !== undefined &&
      (!/^[1-9][0-9]{0,8}$/.test(options.deadlineMs) ||
        Number(options.deadlineMs) > MAX_EVIDENCE_DEADLINE_MS))
  ) {
    throw new Error("observation_reread_arguments_invalid");
  }
  options.deadlineMs =
    options.deadlineMs === undefined
      ? MAX_EVIDENCE_DEADLINE_MS
      : Number(options.deadlineMs);
  return options;
}

function defaultAwsJson(service, operation, args, timeoutMs = 30_000) {
  const allowed = new Set([
    "ecs describe-tasks",
    "ecs describe-task-definition",
  ]);
  if (!allowed.has(`${service} ${operation}`)) {
    throw new Error("observation_reread_aws_operation_not_allowed");
  }
  const result = spawnSync(
    process.env.AWS_CLI_EXECUTABLE || "aws",
    [service, operation, ...args],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        MSYS_NO_PATHCONV: "1",
        MSYS2_ARG_CONV_EXCL: "*",
      },
      windowsHide: true,
      timeout: timeoutMs,
      maxBuffer: 4 * 1024 * 1024,
    }
  );
  if (result.error || result.status !== 0 || result.signal || !result.stdout) {
    throw new Error("observation_reread_aws_read_unavailable");
  }
  return JSON.parse(result.stdout);
}

function exactMissingTask(taskResult, expectedTaskArn) {
  const tasks = Array.isArray(taskResult?.tasks) ? taskResult.tasks : [];
  const failures = Array.isArray(taskResult?.failures)
    ? taskResult.failures
    : [];
  return (
    tasks.length === 0 &&
    failures.length === 1 &&
    failures[0]?.arn === expectedTaskArn &&
    failures[0]?.reason === "MISSING"
  );
}

function exactStoppedTask(
  taskResult,
  expectedTaskArn,
  expectedTaskDefinitionArn
) {
  const tasks = Array.isArray(taskResult?.tasks) ? taskResult.tasks : [];
  const failures = Array.isArray(taskResult?.failures)
    ? taskResult.failures
    : [];
  const task = tasks[0];
  const containers = Array.isArray(task?.containers)
    ? task.containers.filter((container) => container?.name === "api")
    : [];
  return (
    failures.length === 0 &&
    tasks.length === 1 &&
    task?.taskArn === expectedTaskArn &&
    task?.taskDefinitionArn === expectedTaskDefinitionArn &&
    task?.lastStatus === "STOPPED" &&
    containers.length === 1 &&
    containers[0]?.lastStatus === "STOPPED" &&
    containers[0]?.exitCode === 0
  );
}

function taskDescriptionArgs(options) {
  return [
    "--cluster",
    options.cluster,
    "--tasks",
    options.expectedTaskArn,
    "--query",
    "{failures:failures,tasks:tasks[].{taskArn:taskArn,taskDefinitionArn:taskDefinitionArn,lastStatus:lastStatus,containers:containers[].{name:name,lastStatus:lastStatus,exitCode:exitCode,logStreamName:logStreamName}}}",
    "--output",
    "json",
    "--region",
    options.region,
    "--no-paginate",
    "--no-cli-pager",
    "--cli-connect-timeout",
    "10",
    "--cli-read-timeout",
    "30",
  ];
}

function taskDefinitionArgs(options) {
  return [
    "--task-definition",
    options.expectedCandidateApiTaskDefinitionArn,
    "--query",
    "taskDefinition.containerDefinitions[?name==`api`] | [0].logConfiguration",
    "--output",
    "json",
    "--region",
    options.region,
    "--no-paginate",
    "--no-cli-pager",
    "--cli-connect-timeout",
    "10",
    "--cli-read-timeout",
    "30",
  ];
}

function exactCompanions(eventsDocument) {
  const preflight =
    validateClasspilotTileAuthorizationPlanPreflightEvidence(eventsDocument);
  const selection =
    extractClasspilotTileAuthorizationPlanBaseSelectionEvidence(eventsDocument);
  if (
    preflight.status !== "passed" ||
    preflight.eligibleBases !== 1 ||
    preflight.requiredSessionPairs !== 80 ||
    preflight.reusedActiveSessionPairs !== 80 ||
    preflight.missingSessionPairs !== 0 ||
    preflight.conflictingSessionPairs !== 0 ||
    selection.cohortSize !== 40 ||
    selection.canonicalPrimaryOnlyGroups !== 19 ||
    selection.exactCohortGroups !== 19 ||
    selection.eligibleSchools !== 1 ||
    selection.finalBases !== 1
  ) {
    throw new Error("observation_reread_recovered_evidence_invalid");
  }
  return { preflight, selection };
}

function failedTerminalEvidence(
  failureCode,
  {
    taskDescriptionSha256 = null,
    logConfigurationSha256 = null,
    logBindingSha256 = null,
    logStreamSha256 = null,
    canonicalEventSha256 = null,
    collectionAttemptCount = 0,
    collectionCompletedAtUtc = new Date().toISOString(),
  } = {}
) {
  return {
    status: "failed",
    failureCode,
    taskDescriptionSha256,
    logConfigurationSha256,
    logBindingSha256,
    logStreamSha256,
    canonicalEventSha256,
    collectionAttemptCount,
    collectionCompletedAtUtc,
    preflight: null,
    selection: null,
    createdAtUtc: new Date().toISOString(),
  };
}

function sealTerminal(outputRoot, attemptWritten, terminalEvidence, companions) {
  const packet =
    buildClasspilotTileAuthorizationPlanObservationReread({
      attempt: attemptWritten.attempt,
      attemptSha256: attemptWritten.sha256,
      terminalEvidence,
    });
  const written =
    writeClasspilotTileAuthorizationPlanObservationReread(
      outputRoot,
      packet,
      companions
    );
  const inspected =
    inspectClasspilotTileAuthorizationPlanObservationReread(
      written.path,
      written.sha256
    );
  if (
    inspected.path !== written.path ||
    inspected.sha256 !== written.sha256 ||
    inspected.rereadId !== packet.rereadId ||
    inspected.rereadOutcome !== packet.rereadOutcome ||
    inspected.taskLaunchCount !== 0 ||
    inspected.eligibleForDeployment !== false ||
    inspected.eligibleForDiagnostic !== false ||
    inspected.eligibleForCertification !== false
  ) {
    throw new Error("observation_reread_inspection_mismatch");
  }
  return inspected;
}

export async function runClasspilotTileAuthorizationPlanObservationReread(
  options,
  dependencies = {}
) {
  if (
    !isRecord(options) ||
    !Number.isSafeInteger(options.deadlineMs) ||
    options.deadlineMs < 1 ||
    options.deadlineMs > MAX_EVIDENCE_DEADLINE_MS
  ) {
    throw new Error("observation_reread_arguments_invalid");
  }
  const runAwsJson = dependencies.runAwsJson || defaultAwsJson;
  const collectBound =
    dependencies.collectBound ||
    collectBoundClasspilotTileAuthorizationPlanObservationEvidence;
  if (
    dependencies.inspectControllerRepository &&
    (process.env.NODE_ENV !== "test" ||
      process.env.CLP_LOAD_FIXTURE_TEST_MODE !== "1")
  ) {
    throw new Error("observation_reread_controller_repository_invalid");
  }
  const inspectControllerRepository =
    dependencies.inspectControllerRepository ||
    defaultControllerRepositoryInspection;
  const outputRoot =
    deriveClasspilotTileAuthorizationPlanObservationRereadRoot(
      options.sourcePacketPath
    );
  const attempt =
    buildClasspilotTileAuthorizationPlanObservationRereadAttempt({
      rereadId: options.rereadId,
      controllerGitSha: options.controllerGitSha,
      sourcePacketPath: options.sourcePacketPath,
      expectedSourcePacketSha256: options.expectedSourcePacketSha256,
      expectedSourceAttemptSha256: options.expectedSourceAttemptSha256,
      expectedObservationId: options.expectedObservationId,
      expectedApplicationGitSha: options.expectedApplicationGitSha,
      expectedImageDigest: options.expectedImageDigest,
      expectedCandidateApiTaskDefinitionArn:
        options.expectedCandidateApiTaskDefinitionArn,
      expectedCandidateWorkerTaskDefinitionArn:
        options.expectedCandidateWorkerTaskDefinitionArn,
      expectedTaskArn: options.expectedTaskArn,
    });
  let controllerRepository;
  try {
    controllerRepository = await inspectControllerRepository();
  } catch {
    throw new Error("observation_reread_controller_repository_invalid");
  }
  validateObservationRereadControllerRepository(
    controllerRepository,
    options.controllerGitSha
  );
  const attemptWritten =
    writeClasspilotTileAuthorizationPlanObservationRereadAttempt(
      outputRoot,
      attempt
    );

  let taskResult;
  try {
    taskResult = await runAwsJson(
      "ecs",
      "describe-tasks",
      taskDescriptionArgs(options)
    );
  } catch {
    const inspected = sealTerminal(
      outputRoot,
      attemptWritten,
      failedTerminalEvidence("terminal_task_description_unavailable"),
      {}
    );
    return { ...inspected, recovered: false };
  }
  const taskDescriptionSha256 = stableSha256(taskResult);
  if (exactMissingTask(taskResult, options.expectedTaskArn)) {
    const inspected = sealTerminal(
      outputRoot,
      attemptWritten,
      failedTerminalEvidence("historical_task_missing", {
        taskDescriptionSha256,
      }),
      {}
    );
    return { ...inspected, recovered: false };
  }
  if (
    !exactStoppedTask(
      taskResult,
      options.expectedTaskArn,
      options.expectedCandidateApiTaskDefinitionArn
    )
  ) {
    const inspected = sealTerminal(
      outputRoot,
      attemptWritten,
      failedTerminalEvidence("terminal_task_description_unavailable", {
        taskDescriptionSha256,
      }),
      {}
    );
    return { ...inspected, recovered: false };
  }

  let logConfiguration;
  try {
    logConfiguration = await runAwsJson(
      "ecs",
      "describe-task-definition",
      taskDefinitionArgs(options)
    );
  } catch {
    const inspected = sealTerminal(
      outputRoot,
      attemptWritten,
      failedTerminalEvidence("log_configuration_unavailable", {
        taskDescriptionSha256,
      }),
      {}
    );
    return { ...inspected, recovered: false };
  }
  const logConfigurationSha256 = stableSha256(logConfiguration);

  let collected;
  try {
    collected = await collectBound({
      taskResult,
      logConfiguration,
      expectedTaskArn: options.expectedTaskArn,
      expectedTaskDefinitionArn:
        options.expectedCandidateApiTaskDefinitionArn,
      expectedRegion: options.region,
      expectedAccountId: options.accountId,
      deadlineMs: options.deadlineMs,
    });
  } catch {
    const inspected = sealTerminal(
      outputRoot,
      attemptWritten,
      failedTerminalEvidence("collector_start_unavailable", {
        taskDescriptionSha256,
        logConfigurationSha256,
      }),
      {}
    );
    return { ...inspected, recovered: false };
  }

  if (collected.collection?.status !== "completed") {
    const collectedFailureCode = collected.collection?.failureCode;
    const failureCode = [
      "log_binding_unavailable",
      "collector_start_unavailable",
      "log_evidence_unavailable",
    ].includes(collectedFailureCode)
      ? collectedFailureCode
      : "collector_start_unavailable";
    const inspected = sealTerminal(
      outputRoot,
      attemptWritten,
      failedTerminalEvidence(failureCode, {
        taskDescriptionSha256,
        logConfigurationSha256,
        logBindingSha256: collected.binding
          ? bindingSha256(collected.binding)
          : null,
        collectionAttemptCount:
          collected.collection?.attemptCount ?? 0,
        collectionCompletedAtUtc:
          collected.collection?.completedAtUtc ?? new Date().toISOString(),
      }),
      {}
    );
    return { ...inspected, recovered: false };
  }

  try {
    const companions = exactCompanions(collected.eventsDocument);
    const terminalEvidence = {
      status: "recovered",
      failureCode: null,
      taskDescriptionSha256,
      logConfigurationSha256,
      logBindingSha256: bindingSha256(collected.binding),
      logStreamSha256: collected.collection.logStreamSha256,
      canonicalEventSha256:
        collected.collection.canonicalEventSha256,
      collectionAttemptCount: collected.collection.attemptCount,
      collectionCompletedAtUtc:
        collected.collection.completedAtUtc,
      preflight: companions.preflight,
      selection: companions.selection,
      createdAtUtc: new Date().toISOString(),
    };
    const inspected = sealTerminal(
      outputRoot,
      attemptWritten,
      terminalEvidence,
      companions
    );
    return { ...inspected, recovered: true };
  } catch {
    const inspected = sealTerminal(
      outputRoot,
      attemptWritten,
      failedTerminalEvidence("recovered_evidence_invalid", {
        taskDescriptionSha256,
        logConfigurationSha256,
        logBindingSha256: collected.binding
          ? bindingSha256(collected.binding)
          : null,
        logStreamSha256:
          collected.collection?.logStreamSha256 ?? null,
        canonicalEventSha256:
          collected.collection?.canonicalEventSha256 ?? null,
        collectionAttemptCount:
          collected.collection?.attemptCount ?? 0,
        collectionCompletedAtUtc:
          collected.collection?.completedAtUtc ?? new Date().toISOString(),
      }),
      {}
    );
    return { ...inspected, recovered: false };
  }
}

export async function runCli(argv, dependencies = {}) {
  return runClasspilotTileAuthorizationPlanObservationReread(
    parseArguments(argv),
    dependencies
  );
}

const invokedPath = process.argv[1];
if (
  invokedPath &&
  import.meta.url === pathToFileURL(path.resolve(invokedPath)).href
) {
  try {
    const result = await runCli(process.argv.slice(2));
    process.stdout.write(`${JSON.stringify(result)}\n`);
    if (!result.recovered) process.exitCode = 1;
  } catch {
    process.stderr.write(
      "classpilot_tile_auth_plan_observation_reread_failed\n"
    );
    process.exitCode = 1;
  }
}
