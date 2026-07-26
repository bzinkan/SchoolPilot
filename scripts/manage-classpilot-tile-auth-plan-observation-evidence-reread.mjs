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

function atomicDirectory(parent, finalName, writer) {
  const preparedParent = preparePrivateOutputDirectory(path.resolve(parent));
  const finalDirectory = path.join(preparedParent, finalName);
  if (fs.existsSync(finalDirectory)) {
    throw new Error("classpilot_tile_auth_plan_observation_reread_already_exists");
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

const invokedPath = process.argv[1];
if (
  invokedPath &&
  import.meta.url === pathToFileURL(path.resolve(invokedPath)).href
) {
  process.stderr.write(
    "classpilot_tile_auth_plan_observation_reread_manager_library_only\n"
  );
  process.exitCode = 1;
}
