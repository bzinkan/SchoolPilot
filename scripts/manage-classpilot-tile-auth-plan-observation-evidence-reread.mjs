#!/usr/bin/env node

import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  configuredLoadGatesRoot,
  preparePrivateOutputDirectory,
  writePrivateJson,
} from "./load/prepare-classpilot-load-test.mjs";
import {
  inspectClasspilotTileAuthorizationPlanObservation,
  OBSERVATION_ATTEMPT_FILENAME,
  OBSERVATION_PACKET_FILENAME,
} from "./manage-classpilot-tile-auth-plan-observation.mjs";
import {
  validateClasspilotTileAuthorizationPlanBaseSelectionEvidence,
} from "./validate-classpilot-tile-auth-plan-base-selection-evidence.mjs";
import {
  validateClasspilotTileAuthorizationPlanPreflightEvidence,
} from "./validate-classpilot-tile-auth-plan-preflight-evidence.mjs";

export const OBSERVATION_REREAD_VERSION =
  "classpilot-tile-auth-plan-observation-evidence-reread-v1";
export const OBSERVATION_REREAD_ATTEMPT_VERSION =
  "classpilot-tile-auth-plan-observation-evidence-reread-attempt-v1";
export const OBSERVATION_REREAD_PACKET_FILENAME =
  "classpilot-tile-auth-plan-observation-evidence-reread.private.json";
export const OBSERVATION_REREAD_ATTEMPT_FILENAME =
  "classpilot-tile-auth-plan-observation-evidence-reread-attempt.private.json";
export const OBSERVATION_REREAD_PREFLIGHT_FILENAME =
  "base-preflight.evidence.private.json";
export const OBSERVATION_REREAD_SELECTION_FILENAME =
  "base-selection.evidence.private.json";
export const OBSERVATION_REREAD_SUPERSESSION_VERSION =
  "classpilot-tile-auth-plan-observation-reread-supersession-v1";
export const OBSERVATION_REREAD_SUPERSESSION_FILENAME =
  "classpilot-tile-auth-plan-observation-reread-supersession.private.json";
export const APPROVED_OBSERVATION_REREAD_SUPERSESSION_SOURCE =
  Object.freeze({
    sourceApplicationGitSha:
      "cf9b70420b71668d4f06c9376b5274d27a259d0f",
    sourceObservationId:
      "tile-plan-observe-20260726t035926z-cf9b70420b71",
    canonicalRereadPacketRelativePath:
      "tile-auth-observations/cf9b70420b71668d4f06c9376b5274d27a259d0f/tile-plan-observe-20260726t035926z-cf9b70420b71/evidence-reread/terminal/classpilot-tile-auth-plan-observation-evidence-reread.private.json",
    rereadPacketSha256:
      "9c8c092756264fc0686f0aeab8a540526a3b7a60f5c861f122aad69f9f039087",
    rereadAttemptSha256:
      "3f0ff5a217e04635deefa1d07ee61030732675c83ba43ed3d38f5d4c96fd2b44",
    rereadControllerGitSha:
      "4fc219114899c37544ce5017b5e41b7842516e4c",
    originalObservationPacketSha256:
      "5427ff0e5af5f2245479646d1b1dd621213782e01c28a971399295274a8a16fd",
    originalObservationAttemptSha256:
      "01fb533aa87befbba1dba760566afe66c3536e5437726f0d76b1fae0de86c6aa",
    taskDescriptionSha256:
      "75e94f99f136d5d484be97b8a073a22072645cdd6794980114250455f8578756",
  });

const SHA256 = /^[a-f0-9]{64}$/;
const GIT_SHA = /^[a-f0-9]{40}$/;
const IMAGE_DIGEST = /^sha256:[a-f0-9]{64}$/;
const SAFE_ID = /^[a-z0-9][a-z0-9-]{7,127}$/;
const FAILURE_CODES = new Set([
  "historical_task_missing",
  "terminal_task_description_unavailable",
  "log_configuration_unavailable",
  "log_binding_unavailable",
  "collector_start_unavailable",
  "log_evidence_unavailable",
  "recovered_evidence_invalid",
]);

const SOURCE_KEYS = [
  "activeBaseline",
  "applicationGitSha",
  "candidateApiTaskDefinitionArn",
  "candidateWorkerTaskDefinitionArn",
  "imageDigest",
  "initialNetworkConfigurationSha256",
  "initialProductionPostureSha256",
  "observationId",
  "observationPacketPath",
  "observationPacketSha256",
  "observationAttemptPath",
  "observationAttemptSha256",
  "terminalTaskArn",
  "terminalTaskExitCode",
];
const BASELINE_KEYS = [
  "apiTaskDefinitionArn",
  "workerTaskDefinitionArn",
];
const ATTEMPT_KEYS = [
  "controllerGitSha",
  "createdAtUtc",
  "eligibleForCertification",
  "eligibleForDeployment",
  "eligibleForDiagnostic",
  "rawErrorPersisted",
  "rereadId",
  "schemaVersion",
  "sourceObservation",
  "status",
  "taskLaunchCount",
  "type",
  "version",
];
const PACKET_KEYS = [
  "canonicalEventSha256",
  "collectionAttemptCount",
  "collectionCompletedAtUtc",
  "controllerGitSha",
  "createdAtUtc",
  "eligibleForCertification",
  "eligibleForDeployment",
  "eligibleForDiagnostic",
  "failureCode",
  "logBindingSha256",
  "logConfigurationSha256",
  "logStreamSha256",
  "observationRereadAttemptFile",
  "observationRereadAttemptSha256",
  "preflightEvidenceFile",
  "preflightEvidenceSha256",
  "rawErrorPersisted",
  "rereadId",
  "rereadOutcome",
  "schemaVersion",
  "selectionEvidenceFile",
  "selectionEvidenceSha256",
  "sourceObservation",
  "status",
  "taskDescriptionSha256",
  "taskLaunchCount",
  "type",
  "version",
];
const SUPERSESSION_SOURCE_KEYS = [
  "attemptPath",
  "attemptSha256",
  "controllerGitSha",
  "failureCode",
  "packetPath",
  "packetSha256",
  "rereadId",
  "taskDescriptionSha256",
];
const SUPERSESSION_TARGET_KEYS = [
  "activeBaseline",
  "applicationGitSha",
  "candidateApiTaskDefinitionArn",
  "candidateWorkerTaskDefinitionArn",
  "imageDigest",
  "initialNetworkConfigurationSha256",
  "initialProductionPostureSha256",
  "observationId",
];
const SUPERSESSION_KEYS = [
  "createdAtUtc",
  "disposition",
  "eligibleForCertification",
  "eligibleForDeployment",
  "eligibleForDiagnostic",
  "eligibleForFreshObservationAdmission",
  "expiresAtUtc",
  "rawErrorPersisted",
  "schemaVersion",
  "scope",
  "sourceReread",
  "status",
  "supersessionId",
  "targetFreshObservation",
  "taskLaunchCount",
  "type",
  "version",
];
const SUPERSESSION_APPROVAL_KEYS = [
  "canonicalRereadPacketRelativePath",
  "originalObservationAttemptSha256",
  "originalObservationPacketSha256",
  "rereadAttemptSha256",
  "rereadControllerGitSha",
  "rereadPacketSha256",
  "sourceApplicationGitSha",
  "sourceObservationId",
  "taskDescriptionSha256",
];
const TEST_SUPERSESSION_APPROVAL_POLICIES = new WeakSet();

function invalid() {
  throw new Error("classpilot_tile_auth_plan_observation_reread_invalid");
}

function mismatch() {
  throw new Error("classpilot_tile_auth_plan_observation_reread_mismatch");
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value, keys) {
  return (
    isRecord(value) &&
    JSON.stringify(Object.keys(value).sort()) ===
      JSON.stringify([...keys].sort())
  );
}

function string(value, pattern, maximumLength = 4096) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maximumLength ||
    /[\u0000-\u001f\u007f]/.test(value) ||
    (pattern && !pattern.test(value))
  ) {
    invalid();
  }
  return value;
}

function nullableHash(value) {
  return value === null ? null : string(value, SHA256, 64);
}

function utc(value) {
  const result = string(value, null, 64);
  const milliseconds = Date.parse(result);
  if (
    !Number.isFinite(milliseconds) ||
    new Date(milliseconds).toISOString() !== result
  ) {
    invalid();
  }
  return result;
}

function taskDefinitionArn(value, familyPattern) {
  const result = string(value, null, 512);
  const match =
    /^arn:aws:ecs:([a-z0-9-]+):(\d{12}):task-definition\/([A-Za-z0-9_-]+):([1-9]\d*)$/.exec(
      result
    );
  if (!match || !familyPattern.test(match[3])) invalid();
  return result;
}

function taskArn(value) {
  return string(
    value,
    /^arn:aws:ecs:[a-z0-9-]+:\d{12}:task\/(?:[A-Za-z0-9_-]+\/)?[a-f0-9]{32}$/,
    512
  );
}

function normalizeSupersessionApprovalPolicy(policy) {
  if (!exactKeys(policy, SUPERSESSION_APPROVAL_KEYS)) invalid();
  const normalized = {
    sourceApplicationGitSha: string(
      policy.sourceApplicationGitSha,
      GIT_SHA,
      40
    ),
    sourceObservationId: string(
      policy.sourceObservationId,
      SAFE_ID,
      128
    ),
    canonicalRereadPacketRelativePath: string(
      policy.canonicalRereadPacketRelativePath,
      null,
      1024
    ),
    rereadPacketSha256: string(policy.rereadPacketSha256, SHA256, 64),
    rereadAttemptSha256: string(policy.rereadAttemptSha256, SHA256, 64),
    rereadControllerGitSha: string(
      policy.rereadControllerGitSha,
      GIT_SHA,
      40
    ),
    originalObservationPacketSha256: string(
      policy.originalObservationPacketSha256,
      SHA256,
      64
    ),
    originalObservationAttemptSha256: string(
      policy.originalObservationAttemptSha256,
      SHA256,
      64
    ),
    taskDescriptionSha256: string(
      policy.taskDescriptionSha256,
      SHA256,
      64
    ),
  };
  const expectedRelativePath = path.posix.join(
    "tile-auth-observations",
    normalized.sourceApplicationGitSha,
    normalized.sourceObservationId,
    "evidence-reread",
    "terminal",
    OBSERVATION_REREAD_PACKET_FILENAME
  );
  if (
    normalized.canonicalRereadPacketRelativePath !==
    expectedRelativePath
  ) {
    invalid();
  }
  return normalized;
}

export function createClasspilotTileAuthorizationPlanObservationRereadSupersessionApprovalPolicyForTest(
  policy
) {
  if (
    process.env.NODE_ENV !== "test" ||
    process.env.CLP_LOAD_FIXTURE_TEST_MODE !== "1" ||
    typeof process.env.CLP_LOAD_GATES_TEST_ROOT !== "string" ||
    process.env.CLP_LOAD_GATES_TEST_ROOT.length === 0
  ) {
    throw new Error(
      "classpilot_tile_auth_plan_observation_reread_supersession_test_policy_prohibited"
    );
  }
  const immutable = Object.freeze(
    normalizeSupersessionApprovalPolicy(policy)
  );
  TEST_SUPERSESSION_APPROVAL_POLICIES.add(immutable);
  return immutable;
}

function resolveSupersessionApprovalPolicy(policy) {
  if (policy === undefined) {
    return normalizeSupersessionApprovalPolicy(
      APPROVED_OBSERVATION_REREAD_SUPERSESSION_SOURCE
    );
  }
  if (
    !isRecord(policy) ||
    !Object.isFrozen(policy) ||
    !TEST_SUPERSESSION_APPROVAL_POLICIES.has(policy)
  ) {
    throw new Error(
      "classpilot_tile_auth_plan_observation_reread_not_approved"
    );
  }
  return normalizeSupersessionApprovalPolicy(policy);
}

function sha256(value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value, "utf8");
  return createHash("sha256").update(bytes).digest("hex");
}

function privateJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function sourcePath(value, expectedFilename) {
  const root = fs.realpathSync(configuredLoadGatesRoot());
  const real = fs.realpathSync(path.resolve(string(value, null, 4096)));
  const relative = path.relative(root, real);
  if (
    path.basename(real) !== expectedFilename ||
    relative.startsWith("..") ||
    path.isAbsolute(relative)
  ) {
    invalid();
  }
  return real;
}

function comparablePath(value) {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function requireCanonicalObservationPacketPath(
  packetPath,
  applicationGitSha,
  observationId
) {
  const root = fs.realpathSync(configuredLoadGatesRoot());
  const expected = path.join(
    root,
    "tile-auth-observations",
    string(applicationGitSha, GIT_SHA, 40),
    string(observationId, SAFE_ID, 128),
    "terminal",
    OBSERVATION_PACKET_FILENAME
  );
  if (comparablePath(packetPath) !== comparablePath(expected)) {
    invalid();
  }
  return packetPath;
}

function sourceIdentityFromPacket(packetPath, packetSha256, attemptSha256) {
  const realPacketPath = sourcePath(packetPath, OBSERVATION_PACKET_FILENAME);
  const packetBytes = fs.readFileSync(realPacketPath);
  if (sha256(packetBytes) !== string(packetSha256, SHA256, 64)) mismatch();
  const packet = JSON.parse(packetBytes.toString("utf8"));
  requireCanonicalObservationPacketPath(
    realPacketPath,
    packet.applicationGitSha,
    packet.observationId
  );
  const attemptPath = path.join(
    path.dirname(path.dirname(realPacketPath)),
    "attempt",
    OBSERVATION_ATTEMPT_FILENAME
  );
  const realAttemptPath = sourcePath(
    attemptPath,
    OBSERVATION_ATTEMPT_FILENAME
  );
  const attemptBytes = fs.readFileSync(realAttemptPath);
  if (sha256(attemptBytes) !== string(attemptSha256, SHA256, 64)) mismatch();

  const expected = {
    expectedPacketSha256: packetSha256,
    expectedAttemptRecordSha256: attemptSha256,
    observationId: packet.observationId,
    applicationGitSha: packet.applicationGitSha,
    imageDigest: packet.imageDigest,
    candidateApiTaskDefinitionArn: packet.candidateApiTaskDefinitionArn,
    candidateWorkerTaskDefinitionArn:
      packet.candidateWorkerTaskDefinitionArn,
    activeApiTaskDefinitionArn: packet.activeBaseline?.apiTaskDefinitionArn,
    activeWorkerTaskDefinitionArn:
      packet.activeBaseline?.workerTaskDefinitionArn,
    initialNetworkConfigurationSha256:
      packet.initialNetworkConfigurationSha256,
    initialProductionPostureSha256:
      packet.initialProductionPostureSha256,
  };
  inspectClasspilotTileAuthorizationPlanObservation(realPacketPath, expected);
  if (
    packet.schemaVersion !== 2 ||
    packet.version !== "classpilot-tile-auth-plan-observation-v2" ||
    packet.observationOutcome !== "evidence_unavailable" ||
    packet.attemptRecordSha256 !== attemptSha256 ||
    packet.collection?.status !== "failed" ||
    packet.collection?.failureCode !== "log_evidence_unavailable" ||
    packet.collection?.attemptCount !== 0 ||
    packet.collection?.rawErrorPersisted !== false ||
    packet.terminalTask?.state !== "exited" ||
    packet.terminalTask?.exitCode !== 0 ||
    packet.finalNetwork?.status !== "verified" ||
    packet.finalNetwork?.sha256 !==
      packet.initialNetworkConfigurationSha256 ||
    packet.finalProductionPosture?.status !== "verified" ||
    packet.finalProductionPosture?.sha256 !==
      packet.initialProductionPostureSha256 ||
    packet.preflightEvidenceFile !== null ||
    packet.selectionEvidenceFile !== null ||
    packet.funnelEvidenceFile !== null
  ) {
    invalid();
  }
  return {
    observationId: string(packet.observationId, SAFE_ID, 128),
    applicationGitSha: string(packet.applicationGitSha, GIT_SHA, 40),
    imageDigest: string(packet.imageDigest, IMAGE_DIGEST, 71),
    candidateApiTaskDefinitionArn: taskDefinitionArn(
      packet.candidateApiTaskDefinitionArn,
      /-api-emergency$/
    ),
    candidateWorkerTaskDefinitionArn: taskDefinitionArn(
      packet.candidateWorkerTaskDefinitionArn,
      /-scheduler-worker$/
    ),
    activeBaseline: {
      apiTaskDefinitionArn: taskDefinitionArn(
        packet.activeBaseline.apiTaskDefinitionArn,
        /-api(?:-emergency)?$/
      ),
      workerTaskDefinitionArn: taskDefinitionArn(
        packet.activeBaseline.workerTaskDefinitionArn,
        /-scheduler-worker$/
      ),
    },
    initialNetworkConfigurationSha256: string(
      packet.initialNetworkConfigurationSha256,
      SHA256,
      64
    ),
    initialProductionPostureSha256: string(
      packet.initialProductionPostureSha256,
      SHA256,
      64
    ),
    observationPacketPath: realPacketPath,
    observationPacketSha256: packetSha256,
    observationAttemptPath: realAttemptPath,
    observationAttemptSha256: attemptSha256,
    terminalTaskArn: taskArn(packet.terminalTask.taskArn),
    terminalTaskExitCode: 0,
  };
}

function validateSource(value) {
  if (!exactKeys(value, SOURCE_KEYS) || !exactKeys(value.activeBaseline, BASELINE_KEYS)) {
    invalid();
  }
  const normalized = {
    observationId: string(value.observationId, SAFE_ID, 128),
    applicationGitSha: string(value.applicationGitSha, GIT_SHA, 40),
    imageDigest: string(value.imageDigest, IMAGE_DIGEST, 71),
    candidateApiTaskDefinitionArn: taskDefinitionArn(
      value.candidateApiTaskDefinitionArn,
      /-api-emergency$/
    ),
    candidateWorkerTaskDefinitionArn: taskDefinitionArn(
      value.candidateWorkerTaskDefinitionArn,
      /-scheduler-worker$/
    ),
    activeBaseline: {
      apiTaskDefinitionArn: taskDefinitionArn(
        value.activeBaseline.apiTaskDefinitionArn,
        /-api(?:-emergency)?$/
      ),
      workerTaskDefinitionArn: taskDefinitionArn(
        value.activeBaseline.workerTaskDefinitionArn,
        /-scheduler-worker$/
      ),
    },
    initialNetworkConfigurationSha256: string(
      value.initialNetworkConfigurationSha256,
      SHA256,
      64
    ),
    initialProductionPostureSha256: string(
      value.initialProductionPostureSha256,
      SHA256,
      64
    ),
    observationPacketPath: sourcePath(
      value.observationPacketPath,
      OBSERVATION_PACKET_FILENAME
    ),
    observationPacketSha256: string(
      value.observationPacketSha256,
      SHA256,
      64
    ),
    observationAttemptPath: sourcePath(
      value.observationAttemptPath,
      OBSERVATION_ATTEMPT_FILENAME
    ),
    observationAttemptSha256: string(
      value.observationAttemptSha256,
      SHA256,
      64
    ),
    terminalTaskArn: taskArn(value.terminalTaskArn),
    terminalTaskExitCode: value.terminalTaskExitCode,
  };
  if (normalized.terminalTaskExitCode !== 0) invalid();
  const source = sourceIdentityFromPacket(
    normalized.observationPacketPath,
    normalized.observationPacketSha256,
    normalized.observationAttemptSha256
  );
  if (JSON.stringify(source) !== JSON.stringify(normalized)) mismatch();
  return normalized;
}

function compareExpectedSource(source, expected) {
  const comparisons = {
    observationId: expected.expectedObservationId,
    applicationGitSha: expected.expectedApplicationGitSha,
    imageDigest: expected.expectedImageDigest,
    candidateApiTaskDefinitionArn:
      expected.expectedCandidateApiTaskDefinitionArn,
    candidateWorkerTaskDefinitionArn:
      expected.expectedCandidateWorkerTaskDefinitionArn,
    terminalTaskArn: expected.expectedTaskArn,
  };
  for (const [key, expectedValue] of Object.entries(comparisons)) {
    if (expectedValue !== undefined && source[key] !== expectedValue) mismatch();
  }
}

export function buildClasspilotTileAuthorizationPlanObservationRereadAttempt({
  rereadId,
  controllerGitSha,
  sourcePacketPath,
  expectedSourcePacketSha256,
  expectedSourceAttemptSha256,
  createdAtUtc = new Date().toISOString(),
  ...expected
}) {
  const sourceObservation = sourceIdentityFromPacket(
    sourcePacketPath,
    expectedSourcePacketSha256,
    expectedSourceAttemptSha256
  );
  compareExpectedSource(sourceObservation, expected);
  return {
    schemaVersion: 1,
    type: "classpilot_tile_auth_plan_observation_evidence_reread_attempt",
    version: OBSERVATION_REREAD_ATTEMPT_VERSION,
    status: "admitted",
    rereadId: string(rereadId, SAFE_ID, 128),
    controllerGitSha: string(controllerGitSha, GIT_SHA, 40),
    sourceObservation,
    taskLaunchCount: 0,
    rawErrorPersisted: false,
    eligibleForDeployment: false,
    eligibleForDiagnostic: false,
    eligibleForCertification: false,
    createdAtUtc: utc(createdAtUtc),
  };
}

export function validateClasspilotTileAuthorizationPlanObservationRereadAttempt(
  attempt
) {
  if (
    !exactKeys(attempt, ATTEMPT_KEYS) ||
    attempt.schemaVersion !== 1 ||
    attempt.type !==
      "classpilot_tile_auth_plan_observation_evidence_reread_attempt" ||
    attempt.version !== OBSERVATION_REREAD_ATTEMPT_VERSION ||
    attempt.status !== "admitted" ||
    attempt.taskLaunchCount !== 0 ||
    attempt.rawErrorPersisted !== false ||
    attempt.eligibleForDeployment !== false ||
    attempt.eligibleForDiagnostic !== false ||
    attempt.eligibleForCertification !== false
  ) {
    invalid();
  }
  string(attempt.rereadId, SAFE_ID, 128);
  string(attempt.controllerGitSha, GIT_SHA, 40);
  validateSource(attempt.sourceObservation);
  utc(attempt.createdAtUtc);
  return attempt;
}

function atomicDirectory(
  parent,
  finalName,
  writer,
  alreadyExistsCode =
    "classpilot_tile_auth_plan_observation_reread_already_exists"
) {
  const preparedParent = preparePrivateOutputDirectory(path.resolve(parent));
  const finalDirectory = path.join(preparedParent, finalName);
  if (fs.existsSync(finalDirectory)) {
    throw new Error(alreadyExistsCode);
  }
  const stagingDirectory = path.join(
    preparedParent,
    `.${finalName}.staging-${process.pid}-${randomBytes(8).toString("hex")}`
  );
  let renamed = false;
  try {
    const prepared = preparePrivateOutputDirectory(stagingDirectory);
    writer(prepared);
    fs.renameSync(prepared, finalDirectory);
    renamed = true;
    return finalDirectory;
  } finally {
    if (!renamed) {
      try {
        fs.rmSync(stagingDirectory, { recursive: true, force: true });
      } catch {
        // An unrenamed private staging directory is never admitted.
      }
    }
  }
}

export function writeClasspilotTileAuthorizationPlanObservationRereadAttempt(
  outputRoot,
  attempt
) {
  validateClasspilotTileAuthorizationPlanObservationRereadAttempt(attempt);
  const runRoot = preparePrivateOutputDirectory(path.resolve(outputRoot));
  const directory = atomicDirectory(runRoot, "attempt", (staging) => {
    writePrivateJson(staging, OBSERVATION_REREAD_ATTEMPT_FILENAME, attempt);
  });
  const attemptPath = path.join(
    directory,
    OBSERVATION_REREAD_ATTEMPT_FILENAME
  );
  return {
    path: attemptPath,
    sha256: sha256(fs.readFileSync(attemptPath)),
    attempt,
  };
}

function exactRecoveredPreflight(value) {
  const normalized =
    validateClasspilotTileAuthorizationPlanPreflightEvidence({
      events: [{ message: JSON.stringify(value) }],
    });
  if (
    normalized.status !== "passed" ||
    normalized.eligibleBases !== 1 ||
    normalized.requiredSessionPairs !== 80 ||
    normalized.reusedActiveSessionPairs !== 80 ||
    normalized.missingSessionPairs !== 0 ||
    normalized.conflictingSessionPairs !== 0
  ) {
    invalid();
  }
  return normalized;
}

function exactRecoveredSelection(value) {
  const normalized =
    validateClasspilotTileAuthorizationPlanBaseSelectionEvidence(value);
  if (
    normalized.cohortSize !== 40 ||
    normalized.canonicalPrimaryOnlyGroups !== 19 ||
    normalized.exactCohortGroups !== 19 ||
    normalized.eligibleSchools !== 1 ||
    normalized.finalBases !== 1
  ) {
    invalid();
  }
  return normalized;
}

function exactFailureEvidence({
  failureCode,
  taskDescriptionSha256,
  logConfigurationSha256,
  logBindingSha256,
  logStreamSha256,
  canonicalEventSha256,
  collectionAttemptCount,
}) {
  const none = (value) => value === null;
  const present = (value) => typeof value === "string" && SHA256.test(value);
  const zeroReads = collectionAttemptCount === 0;
  const attemptedReads = collectionAttemptCount >= 1;

  switch (failureCode) {
    case "historical_task_missing":
      return (
        present(taskDescriptionSha256) &&
        [
          logConfigurationSha256,
          logBindingSha256,
          logStreamSha256,
          canonicalEventSha256,
        ].every(none) &&
        zeroReads
      );
    case "terminal_task_description_unavailable":
      return (
        (taskDescriptionSha256 === null ||
          present(taskDescriptionSha256)) &&
        [
          logConfigurationSha256,
          logBindingSha256,
          logStreamSha256,
          canonicalEventSha256,
        ].every(none) &&
        zeroReads
      );
    case "log_configuration_unavailable":
      return (
        present(taskDescriptionSha256) &&
        [
          logConfigurationSha256,
          logBindingSha256,
          logStreamSha256,
          canonicalEventSha256,
        ].every(none) &&
        zeroReads
      );
    case "log_binding_unavailable":
      return (
        present(taskDescriptionSha256) &&
        present(logConfigurationSha256) &&
        [logBindingSha256, logStreamSha256, canonicalEventSha256].every(
          none
        ) &&
        zeroReads
      );
    case "collector_start_unavailable":
      return (
        present(taskDescriptionSha256) &&
        present(logConfigurationSha256) &&
        (logBindingSha256 === null || present(logBindingSha256)) &&
        [logStreamSha256, canonicalEventSha256].every(none) &&
        zeroReads
      );
    case "log_evidence_unavailable":
      return (
        [
          taskDescriptionSha256,
          logConfigurationSha256,
          logBindingSha256,
        ].every(present) &&
        [logStreamSha256, canonicalEventSha256].every(none) &&
        attemptedReads
      );
    case "recovered_evidence_invalid":
      return (
        [
          taskDescriptionSha256,
          logConfigurationSha256,
          logBindingSha256,
          logStreamSha256,
          canonicalEventSha256,
        ].every(present) && attemptedReads
      );
    default:
      return false;
  }
}

export function buildClasspilotTileAuthorizationPlanObservationReread({
  attempt,
  attemptSha256,
  terminalEvidence,
}) {
  validateClasspilotTileAuthorizationPlanObservationRereadAttempt(attempt);
  const recovered = terminalEvidence?.status === "recovered";
  const failureCode = recovered ? null : terminalEvidence?.failureCode;
  if (!recovered && !FAILURE_CODES.has(failureCode)) invalid();
  const taskDescriptionSha256 = nullableHash(
    terminalEvidence?.taskDescriptionSha256 ?? null
  );
  const logConfigurationSha256 = nullableHash(
    terminalEvidence?.logConfigurationSha256 ?? null
  );
  const logBindingSha256 = nullableHash(
    terminalEvidence?.logBindingSha256 ?? null
  );
  const logStreamSha256 = nullableHash(
    terminalEvidence?.logStreamSha256 ?? null
  );
  const canonicalEventSha256 = nullableHash(
    terminalEvidence?.canonicalEventSha256 ?? null
  );
  const collectionAttemptCount = terminalEvidence?.collectionAttemptCount;
  if (
    !Number.isInteger(collectionAttemptCount) ||
    collectionAttemptCount < 0 ||
    collectionAttemptCount > 1000
  ) {
    invalid();
  }
  const completedAt = utc(terminalEvidence?.collectionCompletedAtUtc);
  let preflight = null;
  let selection = null;
  if (recovered) {
    if (
      [
        taskDescriptionSha256,
        logConfigurationSha256,
        logBindingSha256,
        logStreamSha256,
        canonicalEventSha256,
      ].some((value) => value === null) ||
      collectionAttemptCount < 1
    ) {
      invalid();
    }
    preflight = exactRecoveredPreflight(terminalEvidence.preflight);
    selection = exactRecoveredSelection(terminalEvidence.selection);
  } else if (
    terminalEvidence?.preflight !== null ||
    terminalEvidence?.selection !== null ||
    !exactFailureEvidence({
      failureCode,
      taskDescriptionSha256,
      logConfigurationSha256,
      logBindingSha256,
      logStreamSha256,
      canonicalEventSha256,
      collectionAttemptCount,
    })
  ) {
    invalid();
  }
  return {
    schemaVersion: 1,
    type: "classpilot_tile_auth_plan_observation_evidence_reread",
    version: OBSERVATION_REREAD_VERSION,
    status: recovered ? "recovered" : "failed",
    rereadOutcome: recovered ? "evidence_recovered" : "evidence_unavailable",
    rereadId: attempt.rereadId,
    controllerGitSha: attempt.controllerGitSha,
    observationRereadAttemptFile:
      `attempt/${OBSERVATION_REREAD_ATTEMPT_FILENAME}`,
    observationRereadAttemptSha256: string(attemptSha256, SHA256, 64),
    sourceObservation: attempt.sourceObservation,
    taskDescriptionSha256,
    logConfigurationSha256,
    logBindingSha256,
    logStreamSha256,
    canonicalEventSha256,
    collectionAttemptCount,
    collectionCompletedAtUtc: completedAt,
    failureCode,
    preflightEvidenceFile: recovered
      ? OBSERVATION_REREAD_PREFLIGHT_FILENAME
      : null,
    preflightEvidenceSha256: recovered
      ? sha256(privateJson(preflight))
      : null,
    selectionEvidenceFile: recovered
      ? OBSERVATION_REREAD_SELECTION_FILENAME
      : null,
    selectionEvidenceSha256: recovered
      ? sha256(privateJson(selection))
      : null,
    taskLaunchCount: 0,
    rawErrorPersisted: false,
    eligibleForDeployment: false,
    eligibleForDiagnostic: false,
    eligibleForCertification: false,
    createdAtUtc: utc(terminalEvidence?.createdAtUtc),
  };
}

export function validateClasspilotTileAuthorizationPlanObservationReread(
  packet
) {
  if (
    !exactKeys(packet, PACKET_KEYS) ||
    packet.schemaVersion !== 1 ||
    packet.type !==
      "classpilot_tile_auth_plan_observation_evidence_reread" ||
    packet.version !== OBSERVATION_REREAD_VERSION ||
    !["recovered", "failed"].includes(packet.status) ||
    packet.taskLaunchCount !== 0 ||
    packet.rawErrorPersisted !== false ||
    packet.eligibleForDeployment !== false ||
    packet.eligibleForDiagnostic !== false ||
    packet.eligibleForCertification !== false ||
    packet.observationRereadAttemptFile !==
      `attempt/${OBSERVATION_REREAD_ATTEMPT_FILENAME}`
  ) {
    invalid();
  }
  string(packet.rereadId, SAFE_ID, 128);
  string(packet.controllerGitSha, GIT_SHA, 40);
  string(packet.observationRereadAttemptSha256, SHA256, 64);
  validateSource(packet.sourceObservation);
  nullableHash(packet.taskDescriptionSha256);
  nullableHash(packet.logConfigurationSha256);
  nullableHash(packet.logBindingSha256);
  nullableHash(packet.logStreamSha256);
  nullableHash(packet.canonicalEventSha256);
  utc(packet.collectionCompletedAtUtc);
  utc(packet.createdAtUtc);
  if (
    !Number.isInteger(packet.collectionAttemptCount) ||
    packet.collectionAttemptCount < 0 ||
    packet.collectionAttemptCount > 1000
  ) {
    invalid();
  }
  const recovered =
    packet.status === "recovered" &&
    packet.rereadOutcome === "evidence_recovered" &&
    packet.failureCode === null &&
    packet.collectionAttemptCount >= 1 &&
    packet.taskDescriptionSha256 !== null &&
    packet.logConfigurationSha256 !== null &&
    packet.logBindingSha256 !== null &&
    packet.logStreamSha256 !== null &&
    packet.canonicalEventSha256 !== null &&
    packet.preflightEvidenceFile === OBSERVATION_REREAD_PREFLIGHT_FILENAME &&
    SHA256.test(packet.preflightEvidenceSha256 || "") &&
    packet.selectionEvidenceFile === OBSERVATION_REREAD_SELECTION_FILENAME &&
    SHA256.test(packet.selectionEvidenceSha256 || "");
  const failed =
    packet.status === "failed" &&
    packet.rereadOutcome === "evidence_unavailable" &&
    FAILURE_CODES.has(packet.failureCode) &&
    packet.preflightEvidenceFile === null &&
    packet.preflightEvidenceSha256 === null &&
    packet.selectionEvidenceFile === null &&
    packet.selectionEvidenceSha256 === null &&
    exactFailureEvidence({
      failureCode: packet.failureCode,
      taskDescriptionSha256: packet.taskDescriptionSha256,
      logConfigurationSha256: packet.logConfigurationSha256,
      logBindingSha256: packet.logBindingSha256,
      logStreamSha256: packet.logStreamSha256,
      canonicalEventSha256: packet.canonicalEventSha256,
      collectionAttemptCount: packet.collectionAttemptCount,
    });
  if (!recovered && !failed) invalid();
  return packet;
}

function attemptForTerminal(outputRoot, packet) {
  const attemptPath = path.join(
    path.resolve(outputRoot),
    packet.observationRereadAttemptFile
  );
  const bytes = fs.readFileSync(attemptPath);
  if (sha256(bytes) !== packet.observationRereadAttemptSha256) mismatch();
  const attempt = JSON.parse(bytes.toString("utf8"));
  validateClasspilotTileAuthorizationPlanObservationRereadAttempt(attempt);
  if (
    attempt.rereadId !== packet.rereadId ||
    attempt.controllerGitSha !== packet.controllerGitSha ||
    JSON.stringify(attempt.sourceObservation) !==
      JSON.stringify(packet.sourceObservation)
  ) {
    mismatch();
  }
  return attempt;
}

export function writeClasspilotTileAuthorizationPlanObservationReread(
  outputRoot,
  packet,
  companions
) {
  validateClasspilotTileAuthorizationPlanObservationReread(packet);
  attemptForTerminal(outputRoot, packet);
  const expectedCompanionKeys =
    packet.status === "recovered" ? ["preflight", "selection"] : [];
  if (!exactKeys(companions, expectedCompanionKeys)) invalid();
  let preflight = null;
  let selection = null;
  if (packet.status === "recovered") {
    preflight = exactRecoveredPreflight(companions.preflight);
    selection = exactRecoveredSelection(companions.selection);
    if (
      sha256(privateJson(preflight)) !== packet.preflightEvidenceSha256 ||
      sha256(privateJson(selection)) !== packet.selectionEvidenceSha256
    ) {
      mismatch();
    }
  }
  const terminalDirectory = atomicDirectory(
    path.resolve(outputRoot),
    "terminal",
    (staging) => {
      if (preflight) {
        writePrivateJson(
          staging,
          OBSERVATION_REREAD_PREFLIGHT_FILENAME,
          preflight
        );
        writePrivateJson(
          staging,
          OBSERVATION_REREAD_SELECTION_FILENAME,
          selection
        );
      }
      writePrivateJson(
        staging,
        OBSERVATION_REREAD_PACKET_FILENAME,
        packet
      );
    }
  );
  const packetPath = path.join(
    terminalDirectory,
    OBSERVATION_REREAD_PACKET_FILENAME
  );
  return {
    path: packetPath,
    sha256: sha256(fs.readFileSync(packetPath)),
    packet,
  };
}

export function inspectClasspilotTileAuthorizationPlanObservationReread(
  packetPath,
  expectedPacketSha256
) {
  const real = sourcePath(
    packetPath,
    OBSERVATION_REREAD_PACKET_FILENAME
  );
  const bytes = fs.readFileSync(real);
  if (sha256(bytes) !== string(expectedPacketSha256, SHA256, 64)) mismatch();
  const packet = JSON.parse(bytes.toString("utf8"));
  validateClasspilotTileAuthorizationPlanObservationReread(packet);
  const outputRoot = path.dirname(path.dirname(real));
  attemptForTerminal(outputRoot, packet);
  const expectedFiles = [OBSERVATION_REREAD_PACKET_FILENAME];
  if (packet.status === "recovered") {
    expectedFiles.push(
      OBSERVATION_REREAD_PREFLIGHT_FILENAME,
      OBSERVATION_REREAD_SELECTION_FILENAME
    );
    const preflightBytes = fs.readFileSync(
      path.join(path.dirname(real), OBSERVATION_REREAD_PREFLIGHT_FILENAME)
    );
    const selectionBytes = fs.readFileSync(
      path.join(path.dirname(real), OBSERVATION_REREAD_SELECTION_FILENAME)
    );
    if (
      sha256(preflightBytes) !== packet.preflightEvidenceSha256 ||
      sha256(selectionBytes) !== packet.selectionEvidenceSha256
    ) {
      mismatch();
    }
    exactRecoveredPreflight(JSON.parse(preflightBytes.toString("utf8")));
    exactRecoveredSelection(JSON.parse(selectionBytes.toString("utf8")));
  }
  const actualFiles = fs
    .readdirSync(path.dirname(real), { withFileTypes: true })
    .map((entry) => {
      if (!entry.isFile()) invalid();
      return entry.name;
    })
    .sort();
  if (
    JSON.stringify(actualFiles) !== JSON.stringify(expectedFiles.sort())
  ) {
    invalid();
  }
  return {
    schemaVersion: 1,
    version: OBSERVATION_REREAD_VERSION,
    path: real,
    sha256: sha256(bytes),
    rereadId: packet.rereadId,
    rereadOutcome: packet.rereadOutcome,
    taskLaunchCount: 0,
    eligibleForDeployment: false,
    eligibleForDiagnostic: false,
    eligibleForCertification: false,
  };
}

export function deriveClasspilotTileAuthorizationPlanObservationRereadRoot(
  sourcePacketPath
) {
  const real = sourcePath(sourcePacketPath, OBSERVATION_PACKET_FILENAME);
  const packet = JSON.parse(fs.readFileSync(real, "utf8"));
  requireCanonicalObservationPacketPath(
    real,
    packet.applicationGitSha,
    packet.observationId
  );
  return path.join(path.dirname(path.dirname(real)), "evidence-reread");
}

function canonicalRereadPacketPath(realPacketPath, packet) {
  const root = fs.realpathSync(configuredLoadGatesRoot());
  const expected = path.join(
    root,
    "tile-auth-observations",
    string(packet.sourceObservation?.applicationGitSha, GIT_SHA, 40),
    string(packet.sourceObservation?.observationId, SAFE_ID, 128),
    "evidence-reread",
    "terminal",
    OBSERVATION_REREAD_PACKET_FILENAME
  );
  if (comparablePath(realPacketPath) !== comparablePath(expected)) {
    invalid();
  }
  return realPacketPath;
}

function readSupersedableReread(
  packetPath,
  expectedPacketSha256,
  approvalPolicy
) {
  const approval = resolveSupersessionApprovalPolicy(approvalPolicy);
  if (expectedPacketSha256 !== approval.rereadPacketSha256) {
    throw new Error(
      "classpilot_tile_auth_plan_observation_reread_not_approved"
    );
  }
  const inspected =
    inspectClasspilotTileAuthorizationPlanObservationReread(
      packetPath,
      expectedPacketSha256
    );
  const realPacketPath = canonicalRereadPacketPath(
    inspected.path,
    JSON.parse(fs.readFileSync(inspected.path, "utf8"))
  );
  const approvedPacketPath = path.join(
    fs.realpathSync(configuredLoadGatesRoot()),
    ...approval.canonicalRereadPacketRelativePath.split("/")
  );
  if (comparablePath(realPacketPath) !== comparablePath(approvedPacketPath)) {
    throw new Error(
      "classpilot_tile_auth_plan_observation_reread_not_approved"
    );
  }
  const bytes = fs.readFileSync(realPacketPath);
  const packet = JSON.parse(bytes.toString("utf8"));
  if (
    packet.status !== "failed" ||
    packet.rereadOutcome !== "evidence_unavailable" ||
    packet.failureCode !== "historical_task_missing" ||
    packet.collectionAttemptCount !== 0 ||
    packet.taskDescriptionSha256 === null ||
    packet.logConfigurationSha256 !== null ||
    packet.logBindingSha256 !== null ||
    packet.logStreamSha256 !== null ||
    packet.canonicalEventSha256 !== null ||
    packet.preflightEvidenceFile !== null ||
    packet.preflightEvidenceSha256 !== null ||
    packet.selectionEvidenceFile !== null ||
    packet.selectionEvidenceSha256 !== null ||
    packet.sourceObservation.applicationGitSha !==
      approval.sourceApplicationGitSha ||
    packet.sourceObservation.observationId !==
      approval.sourceObservationId ||
    packet.sourceObservation.observationPacketSha256 !==
      approval.originalObservationPacketSha256 ||
    packet.sourceObservation.observationAttemptSha256 !==
      approval.originalObservationAttemptSha256 ||
    packet.observationRereadAttemptSha256 !==
      approval.rereadAttemptSha256 ||
    packet.controllerGitSha !== approval.rereadControllerGitSha ||
    packet.taskDescriptionSha256 !== approval.taskDescriptionSha256 ||
    !exactFailureEvidence({
      failureCode: packet.failureCode,
      taskDescriptionSha256: packet.taskDescriptionSha256,
      logConfigurationSha256: packet.logConfigurationSha256,
      logBindingSha256: packet.logBindingSha256,
      logStreamSha256: packet.logStreamSha256,
      canonicalEventSha256: packet.canonicalEventSha256,
      collectionAttemptCount: packet.collectionAttemptCount,
    })
  ) {
    throw new Error(
      "classpilot_tile_auth_plan_observation_reread_not_supersedable"
    );
  }
  const rereadRoot = path.dirname(path.dirname(realPacketPath));
  const attemptPath = path.join(
    rereadRoot,
    packet.observationRereadAttemptFile
  );
  const realAttemptPath = sourcePath(
    attemptPath,
    OBSERVATION_REREAD_ATTEMPT_FILENAME
  );
  const attemptBytes = fs.readFileSync(realAttemptPath);
  if (sha256(attemptBytes) !== packet.observationRereadAttemptSha256) {
    mismatch();
  }
  return {
    packetPath: realPacketPath,
    packetSha256: string(expectedPacketSha256, SHA256, 64),
    attemptPath: realAttemptPath,
    attemptSha256: string(
      packet.observationRereadAttemptSha256,
      SHA256,
      64
    ),
    rereadId: string(packet.rereadId, SAFE_ID, 128),
    controllerGitSha: string(packet.controllerGitSha, GIT_SHA, 40),
    failureCode: "historical_task_missing",
    taskDescriptionSha256: string(
      packet.taskDescriptionSha256,
      SHA256,
      64
    ),
  };
}

function validateSupersessionSource(sourceReread, approvalPolicy) {
  if (!exactKeys(sourceReread, SUPERSESSION_SOURCE_KEYS)) invalid();
  const normalized = {
    packetPath: sourcePath(
      sourceReread.packetPath,
      OBSERVATION_REREAD_PACKET_FILENAME
    ),
    packetSha256: string(sourceReread.packetSha256, SHA256, 64),
    attemptPath: sourcePath(
      sourceReread.attemptPath,
      OBSERVATION_REREAD_ATTEMPT_FILENAME
    ),
    attemptSha256: string(sourceReread.attemptSha256, SHA256, 64),
    rereadId: string(sourceReread.rereadId, SAFE_ID, 128),
    controllerGitSha: string(sourceReread.controllerGitSha, GIT_SHA, 40),
    failureCode: sourceReread.failureCode,
    taskDescriptionSha256: string(
      sourceReread.taskDescriptionSha256,
      SHA256,
      64
    ),
  };
  if (normalized.failureCode !== "historical_task_missing") invalid();
  const actual = readSupersedableReread(
    normalized.packetPath,
    normalized.packetSha256,
    approvalPolicy
  );
  if (JSON.stringify(actual) !== JSON.stringify(normalized)) mismatch();
  return normalized;
}

function validateSupersessionTarget(target) {
  if (
    !exactKeys(target, SUPERSESSION_TARGET_KEYS) ||
    !exactKeys(target.activeBaseline, BASELINE_KEYS)
  ) {
    invalid();
  }
  return {
    observationId: string(target.observationId, SAFE_ID, 128),
    applicationGitSha: string(target.applicationGitSha, GIT_SHA, 40),
    imageDigest: string(target.imageDigest, IMAGE_DIGEST, 71),
    candidateApiTaskDefinitionArn: taskDefinitionArn(
      target.candidateApiTaskDefinitionArn,
      /-api-emergency$/
    ),
    candidateWorkerTaskDefinitionArn: taskDefinitionArn(
      target.candidateWorkerTaskDefinitionArn,
      /-scheduler-worker$/
    ),
    activeBaseline: {
      apiTaskDefinitionArn: taskDefinitionArn(
        target.activeBaseline.apiTaskDefinitionArn,
        /-api(?:-emergency)?$/
      ),
      workerTaskDefinitionArn: taskDefinitionArn(
        target.activeBaseline.workerTaskDefinitionArn,
        /-scheduler-worker$/
      ),
    },
    initialNetworkConfigurationSha256: string(
      target.initialNetworkConfigurationSha256,
      SHA256,
      64
    ),
    initialProductionPostureSha256: string(
      target.initialProductionPostureSha256,
      SHA256,
      64
    ),
  };
}

export function buildClasspilotTileAuthorizationPlanObservationRereadSupersession(
  {
    supersessionId,
    sourceRereadPacketPath,
    expectedSourceRereadPacketSha256,
    targetFreshObservation,
    createdAtUtc = new Date().toISOString(),
    approvalPolicy,
  }
) {
  const created = utc(createdAtUtc);
  const expiresAtUtc = new Date(
    Date.parse(created) + 60 * 60 * 1000
  ).toISOString();
  return {
    schemaVersion: 1,
    type: "classpilot_tile_auth_plan_observation_reread_supersession",
    version: OBSERVATION_REREAD_SUPERSESSION_VERSION,
    status: "sealed",
    supersessionId: string(supersessionId, SAFE_ID, 128),
    disposition:
      "historical_task_missing_nonblocking_for_fresh_observation",
    sourceReread: readSupersedableReread(
      sourceRereadPacketPath,
      expectedSourceRereadPacketSha256,
      approvalPolicy
    ),
    targetFreshObservation: validateSupersessionTarget(
      targetFreshObservation
    ),
    scope: "fresh_observation_admission_only",
    createdAtUtc: created,
    expiresAtUtc,
    taskLaunchCount: 0,
    rawErrorPersisted: false,
    eligibleForFreshObservationAdmission: true,
    eligibleForDeployment: false,
    eligibleForDiagnostic: false,
    eligibleForCertification: false,
  };
}

export function validateClasspilotTileAuthorizationPlanObservationRereadSupersession(
  packet,
  approvalPolicy
) {
  if (
    !exactKeys(packet, SUPERSESSION_KEYS) ||
    packet.schemaVersion !== 1 ||
    packet.type !==
      "classpilot_tile_auth_plan_observation_reread_supersession" ||
    packet.version !== OBSERVATION_REREAD_SUPERSESSION_VERSION ||
    packet.status !== "sealed" ||
    packet.disposition !==
      "historical_task_missing_nonblocking_for_fresh_observation" ||
    packet.scope !== "fresh_observation_admission_only" ||
    packet.taskLaunchCount !== 0 ||
    packet.rawErrorPersisted !== false ||
    packet.eligibleForFreshObservationAdmission !== true ||
    packet.eligibleForDeployment !== false ||
    packet.eligibleForDiagnostic !== false ||
    packet.eligibleForCertification !== false
  ) {
    invalid();
  }
  string(packet.supersessionId, SAFE_ID, 128);
  validateSupersessionSource(packet.sourceReread, approvalPolicy);
  validateSupersessionTarget(packet.targetFreshObservation);
  const createdAtUtc = utc(packet.createdAtUtc);
  const expiresAtUtc = utc(packet.expiresAtUtc);
  if (
    Date.parse(expiresAtUtc) - Date.parse(createdAtUtc) !==
    60 * 60 * 1000
  ) {
    invalid();
  }
  return packet;
}

export function writeClasspilotTileAuthorizationPlanObservationRereadSupersession(
  packet,
  approvalPolicy
) {
  validateClasspilotTileAuthorizationPlanObservationRereadSupersession(
    packet,
    approvalPolicy
  );
  const rereadRoot = path.dirname(
    path.dirname(packet.sourceReread.packetPath)
  );
  const directory = atomicDirectory(
    rereadRoot,
    "supersession",
    (staging) => {
      writePrivateJson(
        staging,
        OBSERVATION_REREAD_SUPERSESSION_FILENAME,
        packet
      );
    },
    "classpilot_tile_auth_plan_observation_reread_supersession_already_exists"
  );
  const packetPath = path.join(
    directory,
    OBSERVATION_REREAD_SUPERSESSION_FILENAME
  );
  return {
    path: packetPath,
    sha256: sha256(fs.readFileSync(packetPath)),
    packet,
  };
}

function compareSupersessionTarget(actual, expected) {
  if (expected === undefined) return;
  const normalized = validateSupersessionTarget(expected);
  if (JSON.stringify(actual) !== JSON.stringify(normalized)) mismatch();
}

export function inspectClasspilotTileAuthorizationPlanObservationRereadSupersession(
  packetPath,
  expectedPacketSha256,
  expectedTargetFreshObservation,
  nowUtc = new Date().toISOString(),
  approvalPolicy
) {
  const real = sourcePath(
    packetPath,
    OBSERVATION_REREAD_SUPERSESSION_FILENAME
  );
  const bytes = fs.readFileSync(real);
  if (sha256(bytes) !== string(expectedPacketSha256, SHA256, 64)) {
    mismatch();
  }
  const packet = JSON.parse(bytes.toString("utf8"));
  validateClasspilotTileAuthorizationPlanObservationRereadSupersession(
    packet,
    approvalPolicy
  );
  const expectedPath = path.join(
    path.dirname(path.dirname(packet.sourceReread.packetPath)),
    "supersession",
    OBSERVATION_REREAD_SUPERSESSION_FILENAME
  );
  if (comparablePath(real) !== comparablePath(expectedPath)) invalid();
  const actualFiles = fs
    .readdirSync(path.dirname(real), { withFileTypes: true })
    .map((entry) => {
      if (!entry.isFile()) invalid();
      return entry.name;
    });
  if (
    actualFiles.length !== 1 ||
    actualFiles[0] !== OBSERVATION_REREAD_SUPERSESSION_FILENAME
  ) {
    invalid();
  }
  compareSupersessionTarget(
    packet.targetFreshObservation,
    expectedTargetFreshObservation
  );
  const inspectedAt = Date.parse(utc(nowUtc));
  const createdAt = Date.parse(packet.createdAtUtc);
  const expiresAt = Date.parse(packet.expiresAtUtc);
  if (inspectedAt < createdAt || inspectedAt >= expiresAt) {
    throw new Error(
      "classpilot_tile_auth_plan_observation_reread_supersession_expired"
    );
  }
  return {
    schemaVersion: 1,
    version: OBSERVATION_REREAD_SUPERSESSION_VERSION,
    path: real,
    sha256: sha256(bytes),
    supersessionId: packet.supersessionId,
    sourceRereadId: packet.sourceReread.rereadId,
    targetObservationId: packet.targetFreshObservation.observationId,
    scope: packet.scope,
    createdAtUtc: packet.createdAtUtc,
    expiresAtUtc: packet.expiresAtUtc,
    taskLaunchCount: 0,
    eligibleForFreshObservationAdmission: true,
    eligibleForDeployment: false,
    eligibleForDiagnostic: false,
    eligibleForCertification: false,
  };
}

function parseCliArguments(argv) {
  const [mode, ...rest] = argv;
  if (!["supersede", "inspect-supersession"].includes(mode)) invalid();
  if (rest.length % 2 !== 0) invalid();
  const values = {};
  for (let index = 0; index < rest.length; index += 2) {
    const key = rest[index];
    const value = rest[index + 1];
    if (
      typeof key !== "string" ||
      !key.startsWith("--") ||
      typeof value !== "string" ||
      value.length === 0 ||
      Object.hasOwn(values, key)
    ) {
      invalid();
    }
    values[key] = value;
  }
  return { mode, values };
}

function cliTarget(values) {
  return {
    observationId: values["--target-observation-id"],
    applicationGitSha: values["--target-application-git-sha"],
    imageDigest: values["--target-image-digest"],
    candidateApiTaskDefinitionArn:
      values["--target-api-task-definition-arn"],
    candidateWorkerTaskDefinitionArn:
      values["--target-worker-task-definition-arn"],
    activeBaseline: {
      apiTaskDefinitionArn:
        values["--target-active-api-task-definition-arn"],
      workerTaskDefinitionArn:
        values["--target-active-worker-task-definition-arn"],
    },
    initialNetworkConfigurationSha256:
      values["--target-network-configuration-sha256"],
    initialProductionPostureSha256:
      values["--target-production-posture-sha256"],
  };
}

function exactCliKeys(values, expectedKeys) {
  if (
    JSON.stringify(Object.keys(values).sort()) !==
    JSON.stringify([...expectedKeys].sort())
  ) {
    invalid();
  }
}

function runCli(argv) {
  const { mode, values } = parseCliArguments(argv);
  const targetKeys = [
    "--target-observation-id",
    "--target-application-git-sha",
    "--target-image-digest",
    "--target-api-task-definition-arn",
    "--target-worker-task-definition-arn",
    "--target-active-api-task-definition-arn",
    "--target-active-worker-task-definition-arn",
    "--target-network-configuration-sha256",
    "--target-production-posture-sha256",
  ];
  const target = cliTarget(values);
  if (mode === "supersede") {
    exactCliKeys(values, [
      "--reread-packet-path",
      "--expected-reread-packet-sha256",
      "--supersession-id",
      ...targetKeys,
    ]);
    const packet =
      buildClasspilotTileAuthorizationPlanObservationRereadSupersession({
        supersessionId: values["--supersession-id"],
        sourceRereadPacketPath: values["--reread-packet-path"],
        expectedSourceRereadPacketSha256:
          values["--expected-reread-packet-sha256"],
        targetFreshObservation: target,
      });
    const written =
      writeClasspilotTileAuthorizationPlanObservationRereadSupersession(
        packet
      );
    return inspectClasspilotTileAuthorizationPlanObservationRereadSupersession(
      written.path,
      written.sha256,
      target
    );
  }
  exactCliKeys(values, [
    "--packet-path",
    "--expected-packet-sha256",
    ...targetKeys,
  ]);
  return inspectClasspilotTileAuthorizationPlanObservationRereadSupersession(
    values["--packet-path"],
    values["--expected-packet-sha256"],
    target
  );
}

const invokedPath = process.argv[1];
if (
  invokedPath &&
  import.meta.url === pathToFileURL(path.resolve(invokedPath)).href
) {
  try {
    process.stdout.write(
      `${JSON.stringify(runCli(process.argv.slice(2)))}\n`
    );
  } catch {
    process.stderr.write(
      "classpilot_tile_auth_plan_observation_reread_supersession_failed\n"
    );
    process.exitCode = 1;
  }
}
