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
  extractClasspilotTileAuthorizationPlanBaseFunnelEvidence,
  validateClasspilotTileAuthorizationPlanBaseFunnelEvidence,
} from "./validate-classpilot-tile-auth-plan-base-funnel-evidence.mjs";
import {
  extractClasspilotTileAuthorizationPlanBaseSelectionEvidence,
  validateClasspilotTileAuthorizationPlanBaseSelectionEvidence,
} from "./validate-classpilot-tile-auth-plan-base-selection-evidence.mjs";
import {
  validateClasspilotTileAuthorizationPlanPreflightEvidence,
} from "./validate-classpilot-tile-auth-plan-preflight-evidence.mjs";

export const OBSERVATION_VERSION =
  "classpilot-tile-auth-plan-observation-v2";
export const LEGACY_OBSERVATION_VERSION =
  "classpilot-tile-auth-plan-observation-v1";
export const OBSERVATION_PACKET_FILENAME =
  "classpilot-tile-auth-plan-observation.private.json";
export const OBSERVATION_ATTEMPT_VERSION =
  "classpilot-tile-auth-plan-observation-attempt-v1";
export const OBSERVATION_ATTEMPT_FILENAME =
  "classpilot-tile-auth-plan-observation-attempt.private.json";
export const OBSERVATION_ATTEMPT_RELATIVE_FILE =
  `attempt/${OBSERVATION_ATTEMPT_FILENAME}`;
export const OBSERVATION_PREFLIGHT_FILENAME =
  "base-preflight.evidence.private.json";
export const OBSERVATION_SELECTION_FILENAME =
  "base-selection.evidence.private.json";
export const OBSERVATION_FUNNEL_FILENAME =
  "base-funnel.evidence.private.json";

const SHA256 = /^[a-f0-9]{64}$/;
const APPLICATION_SHA = /^[a-f0-9]{40}$/;
const IMAGE_DIGEST = /^sha256:[a-f0-9]{64}$/;
const OBSERVATION_ID = /^[a-z0-9][a-z0-9-]{7,127}$/;
const OBSERVATION_OUTCOMES = new Set([
  "base_eligible",
  "base_ineligible",
  "task_failed",
  "evidence_unavailable",
]);
const COLLECTION_FAILURE_CODES = new Set([
  "terminal_task_unavailable",
  "terminal_task_timeout",
  "terminal_task_description_unavailable",
  "log_binding_unavailable",
  "collector_start_unavailable",
  "log_evidence_unavailable",
]);
const EXIT_UNAVAILABLE_FAILURE_CODES = new Set([
  "terminal_task_timeout",
  "terminal_task_description_unavailable",
]);
const FINAL_NETWORK_FAILURE_CODES = new Set([
  "network_unavailable",
  "network_drift",
]);
const FINAL_POSTURE_FAILURE_CODES = new Set([
  "production_posture_unavailable",
  "production_posture_drift",
]);

const PACKET_KEYS_V2 = [
  "activeBaseline",
  "applicationGitSha",
  "attemptRecordFile",
  "attemptRecordSha256",
  "candidateApiTaskDefinitionArn",
  "candidateWorkerTaskDefinitionArn",
  "collection",
  "createdAtUtc",
  "eligibleForCertification",
  "eligibleForDeployment",
  "eligibleForDiagnostic",
  "finalNetwork",
  "finalProductionPosture",
  "funnelEvidenceFile",
  "funnelEvidenceSha256",
  "imageDigest",
  "initialNetworkConfigurationSha256",
  "initialProductionPostureSha256",
  "observationId",
  "observationOutcome",
  "preflightEvidenceFile",
  "preflightEvidenceSha256",
  "schemaVersion",
  "selectionEvidenceFile",
  "selectionEvidenceSha256",
  "status",
  "terminalTask",
  "type",
  "version",
];
const PACKET_KEYS_V1 = [
  "activeBaseline",
  "applicationGitSha",
  "candidateApiTaskDefinitionArn",
  "candidateWorkerTaskDefinitionArn",
  "createdAtUtc",
  "eligibleForCertification",
  "eligibleForDeployment",
  "eligibleForDiagnostic",
  "funnelEvidenceFile",
  "funnelEvidenceSha256",
  "imageDigest",
  "networkConfigurationSha256",
  "observationId",
  "observationOutcome",
  "preflightEvidenceFile",
  "preflightEvidenceSha256",
  "productionPostureSha256",
  "schemaVersion",
  "status",
  "terminalTask",
  "type",
  "version",
];
const BASELINE_KEYS = [
  "apiTaskDefinitionArn",
  "workerTaskDefinitionArn",
];
const TERMINAL_TASK_KEYS_V2 = ["exitCode", "state", "taskArn"];
const TERMINAL_TASK_KEYS_V1 = [
  "exitCode",
  "logStreamSha256",
  "taskArn",
];
const COLLECTION_KEYS = [
  "attemptCount",
  "canonicalEventSha256",
  "completedAtUtc",
  "failureCode",
  "logStreamSha256",
  "rawErrorPersisted",
  "status",
];
const FINAL_EVIDENCE_KEYS = ["failureCode", "sha256", "status"];
const STDIN_KEYS = [
  "collection",
  "createdAtUtc",
  "eventsDocument",
  "finalNetwork",
  "finalProductionPosture",
  "terminalTask",
];
const ATTEMPT_KEYS = [
  "activeBaseline",
  "applicationGitSha",
  "candidateApiTaskDefinitionArn",
  "candidateWorkerTaskDefinitionArn",
  "createdAtUtc",
  "eligibleForCertification",
  "eligibleForDeployment",
  "eligibleForDiagnostic",
  "imageDigest",
  "initialNetworkConfigurationSha256",
  "initialProductionPostureSha256",
  "observationId",
  "rawErrorPersisted",
  "schemaVersion",
  "status",
  "type",
  "version",
];

function invalid() {
  throw new Error("classpilot_tile_auth_plan_observation_invalid");
}

function mismatch() {
  throw new Error("classpilot_tile_auth_plan_observation_mismatch");
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value, keys) {
  return (
    isRecord(value) &&
    JSON.stringify(Object.keys(value).sort()) ===
      JSON.stringify([...keys].sort())
  );
}

function requireString(value, pattern, maximumLength = 1024) {
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

function requireNullableHash(value) {
  if (value === null) return null;
  return requireString(value, SHA256, 64);
}

function requireUtc(value) {
  const timestamp = requireString(value, null, 64);
  const parsed = Date.parse(timestamp);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== timestamp) {
    invalid();
  }
  return timestamp;
}

function requireTaskDefinitionArn(value, familyPattern) {
  const arn = requireString(value, null, 512);
  const match =
    /^arn:aws:ecs:([a-z0-9-]+):(\d{12}):task-definition\/([A-Za-z0-9_-]+):([1-9]\d*)$/.exec(
      arn
    );
  if (!match || !familyPattern.test(match[3])) invalid();
  return arn;
}

function requireTaskArn(value) {
  const arn = requireString(value, null, 512);
  if (
    !/^arn:aws:ecs:[a-z0-9-]+:\d{12}:task\/(?:[A-Za-z0-9_-]+\/)?[a-f0-9]{32}$/.test(
      arn
    )
  ) {
    invalid();
  }
  return arn;
}

function requireExitCode(value) {
  const exitCode =
    typeof value === "string" && /^[0-9]{1,3}$/.test(value)
      ? Number(value)
      : value;
  if (!Number.isInteger(exitCode) || exitCode < 0 || exitCode > 255) invalid();
  return exitCode;
}

function requireAttemptCount(value) {
  if (!Number.isInteger(value) || value < 0 || value > 1000) invalid();
  return value;
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

function stableJson(value) {
  return JSON.stringify(stableValue(value));
}

function privateJsonPayload(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function sha256(value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value, "utf8");
  return createHash("sha256").update(bytes).digest("hex");
}

export function canonicalObservationEventsSha256(eventsDocument) {
  if (!isRecord(eventsDocument) || !Array.isArray(eventsDocument.events)) {
    invalid();
  }
  return sha256(stableJson(eventsDocument));
}

function validateCollection(
  value,
  eventsDocument,
  verifyEventHash = true,
  allowHistoricalZeroAttemptLogEvidence = false
) {
  if (!hasExactKeys(value, COLLECTION_KEYS)) invalid();
  const normalized = {
    status: value.status,
    attemptCount: requireAttemptCount(value.attemptCount),
    completedAtUtc: requireUtc(value.completedAtUtc),
    failureCode: value.failureCode,
    canonicalEventSha256: requireNullableHash(value.canonicalEventSha256),
    logStreamSha256: requireNullableHash(value.logStreamSha256),
    rawErrorPersisted: value.rawErrorPersisted,
  };
  if (normalized.rawErrorPersisted !== false) invalid();
  if (normalized.status === "completed") {
    if (
      normalized.attemptCount < 1 ||
      normalized.failureCode !== null ||
      normalized.canonicalEventSha256 === null ||
      normalized.logStreamSha256 === null ||
      (verifyEventHash &&
        (eventsDocument === null ||
          canonicalObservationEventsSha256(eventsDocument) !==
            normalized.canonicalEventSha256))
    ) {
      invalid();
    }
  } else if (normalized.status === "failed") {
    if (
      !COLLECTION_FAILURE_CODES.has(normalized.failureCode) ||
      eventsDocument !== null ||
      normalized.canonicalEventSha256 !== null ||
      normalized.logStreamSha256 !== null ||
      (normalized.failureCode === "log_evidence_unavailable"
        ? normalized.attemptCount < 1 &&
          !allowHistoricalZeroAttemptLogEvidence
        : normalized.attemptCount !== 0)
    ) {
      invalid();
    }
  } else {
    invalid();
  }
  return normalized;
}

function validateFinalEvidence(value, failureCodes) {
  if (!hasExactKeys(value, FINAL_EVIDENCE_KEYS)) invalid();
  if (value.status === "verified") {
    if (
      value.failureCode !== null ||
      requireString(value.sha256, SHA256, 64) !== value.sha256
    ) {
      invalid();
    }
  } else if (value.status === "failed") {
    if (value.sha256 !== null || !failureCodes.has(value.failureCode)) invalid();
  } else {
    invalid();
  }
  return {
    status: value.status,
    sha256: value.sha256,
    failureCode: value.failureCode,
  };
}

function validateTerminalTask(value) {
  if (value === null) return null;
  if (!hasExactKeys(value, TERMINAL_TASK_KEYS_V2)) invalid();
  const taskArn = requireTaskArn(value.taskArn);
  if (value.state === "exited") {
    return {
      state: "exited",
      taskArn,
      exitCode: requireExitCode(value.exitCode),
    };
  }
  if (value.state === "exit_unavailable" && value.exitCode === null) {
    return { state: "exit_unavailable", taskArn, exitCode: null };
  }
  invalid();
}

function validateTerminalCollectionBinding(collection, terminalTask) {
  if (collection.status === "completed") {
    if (terminalTask?.state !== "exited") invalid();
    return;
  }
  if (collection.failureCode === "terminal_task_unavailable") {
    if (terminalTask !== null) invalid();
    return;
  }
  if (EXIT_UNAVAILABLE_FAILURE_CODES.has(collection.failureCode)) {
    if (
      terminalTask?.state !== "exit_unavailable" &&
      terminalTask?.state !== "exited"
    ) {
      invalid();
    }
    return;
  }
  if (terminalTask?.state !== "exited") invalid();
}

function companionDescriptor(file, hash, value) {
  if (value === null) return { file: null, hash: null, value: null };
  return {
    file,
    hash: sha256(privateJsonPayload(value)),
    value,
  };
}

function canonicalizeTerminalInput(
  input,
  initialNetworkConfigurationSha256,
  initialProductionPostureSha256
) {
  if (!hasExactKeys(input, STDIN_KEYS)) invalid();
  const createdAtUtc = requireUtc(input.createdAtUtc);
  const terminalTask = validateTerminalTask(input.terminalTask);
  const collection = validateCollection(input.collection, input.eventsDocument);
  let finalNetwork = validateFinalEvidence(
    input.finalNetwork,
    FINAL_NETWORK_FAILURE_CODES
  );
  let finalProductionPosture = validateFinalEvidence(
    input.finalProductionPosture,
    FINAL_POSTURE_FAILURE_CODES
  );
  if (
    finalNetwork.status === "verified" &&
    finalNetwork.sha256 !== initialNetworkConfigurationSha256
  ) {
    finalNetwork = {
      status: "failed",
      sha256: null,
      failureCode: "network_drift",
    };
  }
  if (
    finalProductionPosture.status === "verified" &&
    finalProductionPosture.sha256 !== initialProductionPostureSha256
  ) {
    finalProductionPosture = {
      status: "failed",
      sha256: null,
      failureCode: "production_posture_drift",
    };
  }
  validateTerminalCollectionBinding(collection, terminalTask);

  let outcome = "evidence_unavailable";
  let preflight = null;
  let selection = null;
  let funnel = null;
  if (collection.status === "completed") {
    const exitCode = terminalTask.exitCode;
    const finalEvidenceVerified =
      finalNetwork.status === "verified" &&
      finalProductionPosture.status === "verified";
    if (exitCode === 0) {
      try {
        preflight =
          validateClasspilotTileAuthorizationPlanPreflightEvidence(
            input.eventsDocument
          );
        selection =
          extractClasspilotTileAuthorizationPlanBaseSelectionEvidence(
            input.eventsDocument
          );
      } catch {
        preflight = null;
        selection = null;
      }
      outcome =
        preflight !== null && selection !== null && finalEvidenceVerified
          ? "base_eligible"
          : "evidence_unavailable";
    } else if (exitCode === 1) {
      try {
        funnel =
          extractClasspilotTileAuthorizationPlanBaseFunnelEvidence(
            input.eventsDocument
          );
      } catch {
        funnel = null;
      }
      if (funnel !== null) {
        outcome = finalEvidenceVerified
          ? "base_ineligible"
          : "evidence_unavailable";
      } else {
        outcome = "task_failed";
      }
    } else {
      outcome = "task_failed";
    }
  }

  return {
    createdAtUtc,
    terminalTask,
    collection,
    finalNetwork,
    finalProductionPosture,
    observationOutcome: outcome,
    preflight: companionDescriptor(
      OBSERVATION_PREFLIGHT_FILENAME,
      null,
      preflight
    ),
    selection: companionDescriptor(
      OBSERVATION_SELECTION_FILENAME,
      null,
      selection
    ),
    funnel: companionDescriptor(OBSERVATION_FUNNEL_FILENAME, null, funnel),
  };
}

export function buildClasspilotTileAuthorizationPlanObservation({
  observationId,
  applicationGitSha,
  imageDigest,
  candidateApiTaskDefinitionArn,
  candidateWorkerTaskDefinitionArn,
  activeApiTaskDefinitionArn,
  activeWorkerTaskDefinitionArn,
  initialNetworkConfigurationSha256,
  initialProductionPostureSha256,
  attemptRecordSha256,
  terminalEvidence,
}) {
  const initialNetworkSha = requireString(
    initialNetworkConfigurationSha256,
    SHA256,
    64
  );
  const initialPostureSha = requireString(
    initialProductionPostureSha256,
    SHA256,
    64
  );
  const evidence = canonicalizeTerminalInput(
    terminalEvidence,
    initialNetworkSha,
    initialPostureSha
  );
  return {
    schemaVersion: 2,
    type: "classpilot_tile_auth_plan_observation",
    version: OBSERVATION_VERSION,
    status: "observed",
    observationId: requireString(observationId, OBSERVATION_ID, 128),
    attemptRecordFile: OBSERVATION_ATTEMPT_RELATIVE_FILE,
    attemptRecordSha256: requireString(attemptRecordSha256, SHA256, 64),
    observationOutcome: evidence.observationOutcome,
    applicationGitSha: requireString(applicationGitSha, APPLICATION_SHA, 40),
    imageDigest: requireString(imageDigest, IMAGE_DIGEST, 71),
    candidateApiTaskDefinitionArn: requireTaskDefinitionArn(
      candidateApiTaskDefinitionArn,
      /-api-emergency$/
    ),
    candidateWorkerTaskDefinitionArn: requireTaskDefinitionArn(
      candidateWorkerTaskDefinitionArn,
      /-scheduler-worker$/
    ),
    activeBaseline: {
      apiTaskDefinitionArn: requireTaskDefinitionArn(
        activeApiTaskDefinitionArn,
        /-api(?:-emergency)?$/
      ),
      workerTaskDefinitionArn: requireTaskDefinitionArn(
        activeWorkerTaskDefinitionArn,
        /-scheduler-worker$/
      ),
    },
    initialNetworkConfigurationSha256: initialNetworkSha,
    initialProductionPostureSha256: initialPostureSha,
    terminalTask: evidence.terminalTask,
    collection: evidence.collection,
    finalNetwork: evidence.finalNetwork,
    finalProductionPosture: evidence.finalProductionPosture,
    preflightEvidenceFile: evidence.preflight.file,
    preflightEvidenceSha256: evidence.preflight.hash,
    selectionEvidenceFile: evidence.selection.file,
    selectionEvidenceSha256: evidence.selection.hash,
    funnelEvidenceFile: evidence.funnel.file,
    funnelEvidenceSha256: evidence.funnel.hash,
    eligibleForDeployment: false,
    eligibleForDiagnostic: false,
    eligibleForCertification: false,
    createdAtUtc: evidence.createdAtUtc,
  };
}

function validateCompanionBinding(file, hash, expectedFile) {
  if (file === null || hash === null) {
    if (file !== null || hash !== null) invalid();
    return false;
  }
  if (file !== expectedFile || !SHA256.test(hash)) invalid();
  return true;
}

function validateIdentity(packet, expected) {
  const comparisons = [
    ["observationId", OBSERVATION_ID, 128],
    ["applicationGitSha", APPLICATION_SHA, 40],
    ["imageDigest", IMAGE_DIGEST, 71],
    ["initialNetworkConfigurationSha256", SHA256, 64],
    ["initialProductionPostureSha256", SHA256, 64],
  ];
  for (const [key, pattern, maximumLength] of comparisons) {
    if (
      expected[key] !== undefined &&
      packet[key] !== requireString(expected[key], pattern, maximumLength)
    ) {
      mismatch();
    }
  }
  const arnComparisons = [
    [
      packet.candidateApiTaskDefinitionArn,
      expected.candidateApiTaskDefinitionArn,
      /-api-emergency$/,
    ],
    [
      packet.candidateWorkerTaskDefinitionArn,
      expected.candidateWorkerTaskDefinitionArn,
      /-scheduler-worker$/,
    ],
    [
      packet.activeBaseline.apiTaskDefinitionArn,
      expected.activeApiTaskDefinitionArn,
      /-api(?:-emergency)?$/,
    ],
    [
      packet.activeBaseline.workerTaskDefinitionArn,
      expected.activeWorkerTaskDefinitionArn,
      /-scheduler-worker$/,
    ],
  ];
  for (const [actual, expectedValue, familyPattern] of arnComparisons) {
    if (
      expectedValue !== undefined &&
      actual !== requireTaskDefinitionArn(expectedValue, familyPattern)
    ) {
      mismatch();
    }
  }
}

export function buildClasspilotTileAuthorizationPlanObservationAttempt({
  observationId,
  applicationGitSha,
  imageDigest,
  candidateApiTaskDefinitionArn,
  candidateWorkerTaskDefinitionArn,
  activeApiTaskDefinitionArn,
  activeWorkerTaskDefinitionArn,
  initialNetworkConfigurationSha256,
  initialProductionPostureSha256,
  createdAtUtc = new Date().toISOString(),
}) {
  return {
    schemaVersion: 1,
    type: "classpilot_tile_auth_plan_observation_attempt",
    version: OBSERVATION_ATTEMPT_VERSION,
    status: "admitted",
    observationId: requireString(observationId, OBSERVATION_ID, 128),
    applicationGitSha: requireString(applicationGitSha, APPLICATION_SHA, 40),
    imageDigest: requireString(imageDigest, IMAGE_DIGEST, 71),
    candidateApiTaskDefinitionArn: requireTaskDefinitionArn(
      candidateApiTaskDefinitionArn,
      /-api-emergency$/
    ),
    candidateWorkerTaskDefinitionArn: requireTaskDefinitionArn(
      candidateWorkerTaskDefinitionArn,
      /-scheduler-worker$/
    ),
    activeBaseline: {
      apiTaskDefinitionArn: requireTaskDefinitionArn(
        activeApiTaskDefinitionArn,
        /-api(?:-emergency)?$/
      ),
      workerTaskDefinitionArn: requireTaskDefinitionArn(
        activeWorkerTaskDefinitionArn,
        /-scheduler-worker$/
      ),
    },
    initialNetworkConfigurationSha256: requireString(
      initialNetworkConfigurationSha256,
      SHA256,
      64
    ),
    initialProductionPostureSha256: requireString(
      initialProductionPostureSha256,
      SHA256,
      64
    ),
    eligibleForDeployment: false,
    eligibleForDiagnostic: false,
    eligibleForCertification: false,
    rawErrorPersisted: false,
    createdAtUtc: requireUtc(createdAtUtc),
  };
}

export function validateClasspilotTileAuthorizationPlanObservationAttempt(
  attempt,
  expected = {}
) {
  if (
    !hasExactKeys(attempt, ATTEMPT_KEYS) ||
    attempt.schemaVersion !== 1 ||
    attempt.type !== "classpilot_tile_auth_plan_observation_attempt" ||
    attempt.version !== OBSERVATION_ATTEMPT_VERSION ||
    attempt.status !== "admitted" ||
    attempt.eligibleForDeployment !== false ||
    attempt.eligibleForDiagnostic !== false ||
    attempt.eligibleForCertification !== false ||
    attempt.rawErrorPersisted !== false ||
    !hasExactKeys(attempt.activeBaseline, BASELINE_KEYS)
  ) {
    invalid();
  }
  requireString(attempt.observationId, OBSERVATION_ID, 128);
  requireString(attempt.applicationGitSha, APPLICATION_SHA, 40);
  requireString(attempt.imageDigest, IMAGE_DIGEST, 71);
  requireTaskDefinitionArn(
    attempt.candidateApiTaskDefinitionArn,
    /-api-emergency$/
  );
  requireTaskDefinitionArn(
    attempt.candidateWorkerTaskDefinitionArn,
    /-scheduler-worker$/
  );
  requireTaskDefinitionArn(
    attempt.activeBaseline.apiTaskDefinitionArn,
    /-api(?:-emergency)?$/
  );
  requireTaskDefinitionArn(
    attempt.activeBaseline.workerTaskDefinitionArn,
    /-scheduler-worker$/
  );
  requireString(attempt.initialNetworkConfigurationSha256, SHA256, 64);
  requireString(attempt.initialProductionPostureSha256, SHA256, 64);
  requireUtc(attempt.createdAtUtc);
  validateIdentity(attempt, expected);
  return attempt;
}

export function validateClasspilotTileAuthorizationPlanObservation(
  packet,
  expected = {}
) {
  if (
    !hasExactKeys(packet, PACKET_KEYS_V2) ||
    packet.schemaVersion !== 2 ||
    packet.type !== "classpilot_tile_auth_plan_observation" ||
    packet.version !== OBSERVATION_VERSION ||
    packet.status !== "observed" ||
    !OBSERVATION_OUTCOMES.has(packet.observationOutcome) ||
    packet.eligibleForDeployment !== false ||
    packet.eligibleForDiagnostic !== false ||
    packet.eligibleForCertification !== false ||
    packet.attemptRecordFile !== OBSERVATION_ATTEMPT_RELATIVE_FILE ||
    !SHA256.test(packet.attemptRecordSha256 || "") ||
    !hasExactKeys(packet.activeBaseline, BASELINE_KEYS)
  ) {
    invalid();
  }
  requireString(packet.observationId, OBSERVATION_ID, 128);
  requireString(packet.applicationGitSha, APPLICATION_SHA, 40);
  requireString(packet.imageDigest, IMAGE_DIGEST, 71);
  requireTaskDefinitionArn(
    packet.candidateApiTaskDefinitionArn,
    /-api-emergency$/
  );
  requireTaskDefinitionArn(
    packet.candidateWorkerTaskDefinitionArn,
    /-scheduler-worker$/
  );
  requireTaskDefinitionArn(
    packet.activeBaseline.apiTaskDefinitionArn,
    /-api(?:-emergency)?$/
  );
  requireTaskDefinitionArn(
    packet.activeBaseline.workerTaskDefinitionArn,
    /-scheduler-worker$/
  );
  requireString(packet.initialNetworkConfigurationSha256, SHA256, 64);
  requireString(packet.initialProductionPostureSha256, SHA256, 64);
  requireUtc(packet.createdAtUtc);
  const terminalTask = validateTerminalTask(packet.terminalTask);
  const collection = validateCollection(
    packet.collection,
    null,
    false,
    true
  );
  const finalNetwork = validateFinalEvidence(
    packet.finalNetwork,
    FINAL_NETWORK_FAILURE_CODES
  );
  const finalProductionPosture = validateFinalEvidence(
    packet.finalProductionPosture,
    FINAL_POSTURE_FAILURE_CODES
  );
  if (
    (finalNetwork.status === "verified" &&
      finalNetwork.sha256 !== packet.initialNetworkConfigurationSha256) ||
    (finalProductionPosture.status === "verified" &&
      finalProductionPosture.sha256 !==
        packet.initialProductionPostureSha256)
  ) {
    invalid();
  }

  // The packet stores the canonical event hash, but the raw event snapshot is
  // deliberately not persisted. Recheck completed collection invariants here
  // without attempting to reconstruct the discarded source document.
  if (collection.status === "completed") {
    collection.canonicalEventSha256 = requireString(
      packet.collection.canonicalEventSha256,
      SHA256,
      64
    );
    collection.logStreamSha256 = requireString(
      packet.collection.logStreamSha256,
      SHA256,
      64
    );
  }
  validateTerminalCollectionBinding(collection, terminalTask);

  const hasPreflight = validateCompanionBinding(
    packet.preflightEvidenceFile,
    packet.preflightEvidenceSha256,
    OBSERVATION_PREFLIGHT_FILENAME
  );
  const hasSelection = validateCompanionBinding(
    packet.selectionEvidenceFile,
    packet.selectionEvidenceSha256,
    OBSERVATION_SELECTION_FILENAME
  );
  const hasFunnel = validateCompanionBinding(
    packet.funnelEvidenceFile,
    packet.funnelEvidenceSha256,
    OBSERVATION_FUNNEL_FILENAME
  );
  if (hasPreflight !== hasSelection || (hasFunnel && hasPreflight)) invalid();

  const finalVerified =
    finalNetwork.status === "verified" &&
    finalProductionPosture.status === "verified";
  const eligible =
    packet.observationOutcome === "base_eligible" &&
    collection.status === "completed" &&
    terminalTask?.state === "exited" &&
    terminalTask.exitCode === 0 &&
    finalVerified &&
    hasPreflight &&
    hasSelection &&
    !hasFunnel;
  const ineligible =
    packet.observationOutcome === "base_ineligible" &&
    collection.status === "completed" &&
    terminalTask?.state === "exited" &&
    terminalTask.exitCode === 1 &&
    finalVerified &&
    !hasPreflight &&
    hasFunnel;
  const taskFailed =
    packet.observationOutcome === "task_failed" &&
    collection.status === "completed" &&
    terminalTask?.state === "exited" &&
    terminalTask.exitCode !== 0 &&
    !hasPreflight &&
    !hasFunnel;
  const evidenceUnavailable =
    packet.observationOutcome === "evidence_unavailable" &&
    !(
      collection.status === "completed" &&
      terminalTask?.state === "exited" &&
      terminalTask.exitCode === 0 &&
      finalVerified &&
      hasPreflight &&
      hasSelection
    ) &&
    !(
      collection.status === "completed" &&
      terminalTask?.state === "exited" &&
      terminalTask.exitCode === 1 &&
      finalVerified &&
      hasFunnel
    );
  if (!eligible && !ineligible && !taskFailed && !evidenceUnavailable) invalid();
  validateIdentity(packet, expected);
  return packet;
}

function validateLegacyObservation(packet, expected = {}) {
  if (
    !hasExactKeys(packet, PACKET_KEYS_V1) ||
    packet.schemaVersion !== 1 ||
    packet.type !== "classpilot_tile_auth_plan_observation" ||
    packet.version !== LEGACY_OBSERVATION_VERSION ||
    packet.status !== "observed" ||
    packet.eligibleForDeployment !== false ||
    packet.eligibleForDiagnostic !== false ||
    packet.eligibleForCertification !== false ||
    !hasExactKeys(packet.activeBaseline, BASELINE_KEYS) ||
    !hasExactKeys(packet.terminalTask, TERMINAL_TASK_KEYS_V1)
  ) {
    invalid();
  }
  requireString(packet.observationId, OBSERVATION_ID, 128);
  requireString(packet.applicationGitSha, APPLICATION_SHA, 40);
  requireString(packet.imageDigest, IMAGE_DIGEST, 71);
  requireTaskDefinitionArn(
    packet.candidateApiTaskDefinitionArn,
    /-api-emergency$/
  );
  requireTaskDefinitionArn(
    packet.candidateWorkerTaskDefinitionArn,
    /-scheduler-worker$/
  );
  requireTaskDefinitionArn(
    packet.activeBaseline.apiTaskDefinitionArn,
    /-api(?:-emergency)?$/
  );
  requireTaskDefinitionArn(
    packet.activeBaseline.workerTaskDefinitionArn,
    /-scheduler-worker$/
  );
  requireString(packet.networkConfigurationSha256, SHA256, 64);
  requireString(packet.productionPostureSha256, SHA256, 64);
  requireTaskArn(packet.terminalTask.taskArn);
  const exitCode = requireExitCode(packet.terminalTask.exitCode);
  requireString(packet.terminalTask.logStreamSha256, SHA256, 64);
  requireUtc(packet.createdAtUtc);
  const hasPreflight = validateCompanionBinding(
    packet.preflightEvidenceFile,
    packet.preflightEvidenceSha256,
    OBSERVATION_PREFLIGHT_FILENAME
  );
  const hasFunnel = validateCompanionBinding(
    packet.funnelEvidenceFile,
    packet.funnelEvidenceSha256,
    OBSERVATION_FUNNEL_FILENAME
  );
  if (
    !(
      packet.observationOutcome === "base_eligible" &&
      exitCode === 0 &&
      hasPreflight &&
      !hasFunnel
    ) &&
    !(
      packet.observationOutcome === "base_ineligible" &&
      exitCode === 1 &&
      !hasPreflight &&
      hasFunnel
    )
  ) {
    invalid();
  }
  validateIdentity(
    {
      ...packet,
      initialNetworkConfigurationSha256: packet.networkConfigurationSha256,
      initialProductionPostureSha256: packet.productionPostureSha256,
    },
    expected
  );
  return packet;
}

function requirePrivatePacketPath(packetPath) {
  const root = fs.realpathSync(configuredLoadGatesRoot());
  const real = fs.realpathSync(path.resolve(packetPath));
  const relative = path.relative(root, real);
  if (
    path.basename(real) !== OBSERVATION_PACKET_FILENAME ||
    relative.startsWith("..") ||
    path.isAbsolute(relative)
  ) {
    throw new Error("classpilot_tile_auth_plan_observation_path_invalid");
  }
  return real;
}

function requirePrivateAttemptPath(attemptPath) {
  const root = fs.realpathSync(configuredLoadGatesRoot());
  const real = fs.realpathSync(path.resolve(attemptPath));
  const relative = path.relative(root, real);
  if (
    path.basename(real) !== OBSERVATION_ATTEMPT_FILENAME ||
    relative.startsWith("..") ||
    path.isAbsolute(relative)
  ) {
    throw new Error(
      "classpilot_tile_auth_plan_observation_attempt_path_invalid"
    );
  }
  return real;
}

function attemptPathForTerminalDirectory(terminalDirectory) {
  const resolved = path.resolve(terminalDirectory);
  if (path.basename(resolved) !== "terminal") {
    throw new Error(
      "classpilot_tile_auth_plan_observation_attempt_path_invalid"
    );
  }
  return path.join(
    path.dirname(resolved),
    "attempt",
    OBSERVATION_ATTEMPT_FILENAME
  );
}

function attemptPathForPacket(packetPath) {
  return attemptPathForTerminalDirectory(path.dirname(packetPath));
}

export function inspectClasspilotTileAuthorizationPlanObservationAttempt(
  attemptPath,
  expected
) {
  const realAttemptPath = requirePrivateAttemptPath(attemptPath);
  const bytes = fs.readFileSync(realAttemptPath);
  if (
    sha256(bytes) !==
    requireString(expected.expectedAttemptRecordSha256, SHA256, 64)
  ) {
    mismatch();
  }
  const attempt =
    validateClasspilotTileAuthorizationPlanObservationAttempt(
      JSON.parse(bytes.toString("utf8")),
      expected
    );
  const entries = fs.readdirSync(path.dirname(realAttemptPath), {
    withFileTypes: true,
  });
  if (entries.some((entry) => !entry.isFile())) invalid();
  const actualFiles = entries.map((entry) => entry.name);
  if (
    actualFiles.length !== 1 ||
    actualFiles[0] !== OBSERVATION_ATTEMPT_FILENAME
  ) {
    invalid();
  }
  return {
    schemaVersion: 1,
    version: OBSERVATION_ATTEMPT_VERSION,
    path: realAttemptPath,
    sha256: sha256(bytes),
    observationId: attempt.observationId,
    eligibleForDeployment: false,
    eligibleForDiagnostic: false,
    eligibleForCertification: false,
  };
}

function parseCompanion(companionPath, expectedHash, validator) {
  const bytes = fs.readFileSync(companionPath);
  if (sha256(bytes) !== expectedHash) mismatch();
  const parsed = JSON.parse(bytes.toString("utf8"));
  const validated = validator(parsed);
  if (stableJson(validated) !== stableJson(parsed)) invalid();
  return validated;
}

function validateCompanions(packetPath, packet) {
  const directory = path.dirname(packetPath);
  const expectedFiles = [OBSERVATION_PACKET_FILENAME];
  if (packet.preflightEvidenceFile !== null) {
    expectedFiles.push(packet.preflightEvidenceFile);
    parseCompanion(
      path.join(directory, packet.preflightEvidenceFile),
      packet.preflightEvidenceSha256,
      (parsed) =>
        validateClasspilotTileAuthorizationPlanPreflightEvidence({
          events: [{ message: JSON.stringify(parsed) }],
        })
    );
  }
  if (packet.selectionEvidenceFile !== undefined &&
      packet.selectionEvidenceFile !== null) {
    expectedFiles.push(packet.selectionEvidenceFile);
    parseCompanion(
      path.join(directory, packet.selectionEvidenceFile),
      packet.selectionEvidenceSha256,
      validateClasspilotTileAuthorizationPlanBaseSelectionEvidence
    );
  }
  if (packet.funnelEvidenceFile !== null) {
    expectedFiles.push(packet.funnelEvidenceFile);
    parseCompanion(
      path.join(directory, packet.funnelEvidenceFile),
      packet.funnelEvidenceSha256,
      validateClasspilotTileAuthorizationPlanBaseFunnelEvidence
    );
  }
  const entries = fs.readdirSync(directory, { withFileTypes: true });
  if (entries.some((entry) => !entry.isFile())) invalid();
  const actualFiles = entries.map((entry) => entry.name).sort();
  if (
    JSON.stringify(actualFiles) !== JSON.stringify(expectedFiles.sort())
  ) {
    invalid();
  }
}

function validateCompanionInput(packet, evidence) {
  if (!isRecord(evidence)) invalid();
  const expectedKeys = [];
  if (packet.preflightEvidenceFile !== null) expectedKeys.push("preflight");
  if (packet.selectionEvidenceFile !== null) expectedKeys.push("selection");
  if (packet.funnelEvidenceFile !== null) expectedKeys.push("funnel");
  if (!hasExactKeys(evidence, expectedKeys)) invalid();
  const companions = [];
  if (packet.preflightEvidenceFile !== null) {
    const value = validateClasspilotTileAuthorizationPlanPreflightEvidence({
      events: [{ message: JSON.stringify(evidence.preflight) }],
    });
    companions.push([
      packet.preflightEvidenceFile,
      packet.preflightEvidenceSha256,
      value,
    ]);
  }
  if (packet.selectionEvidenceFile !== null) {
    const value =
      validateClasspilotTileAuthorizationPlanBaseSelectionEvidence(
        evidence.selection
      );
    companions.push([
      packet.selectionEvidenceFile,
      packet.selectionEvidenceSha256,
      value,
    ]);
  }
  if (packet.funnelEvidenceFile !== null) {
    const value =
      validateClasspilotTileAuthorizationPlanBaseFunnelEvidence(
        evidence.funnel
      );
    companions.push([
      packet.funnelEvidenceFile,
      packet.funnelEvidenceSha256,
      value,
    ]);
  }
  for (const [, expectedHash, value] of companions) {
    if (sha256(privateJsonPayload(value)) !== expectedHash) mismatch();
  }
  return companions;
}

export function writeClasspilotTileAuthorizationPlanObservationAttempt(
  outputRoot,
  attempt
) {
  validateClasspilotTileAuthorizationPlanObservationAttempt(attempt);
  const runRoot = preparePrivateOutputDirectory(path.resolve(outputRoot));
  const attemptDirectory = path.join(runRoot, "attempt");
  if (fs.existsSync(attemptDirectory)) {
    throw new Error(
      "classpilot_tile_auth_plan_observation_attempt_already_exists"
    );
  }
  const stagingDirectory = path.join(
    runRoot,
    `.attempt.staging-${process.pid}-${randomBytes(8).toString("hex")}`
  );
  let renamed = false;
  try {
    const preparedStaging =
      preparePrivateOutputDirectory(stagingDirectory);
    writePrivateJson(
      preparedStaging,
      OBSERVATION_ATTEMPT_FILENAME,
      attempt
    );
    fs.renameSync(preparedStaging, attemptDirectory);
    renamed = true;
    const attemptPath = path.join(
      attemptDirectory,
      OBSERVATION_ATTEMPT_FILENAME
    );
    const bytes = fs.readFileSync(attemptPath);
    return {
      path: attemptPath,
      sha256: sha256(bytes),
      attempt,
    };
  } catch (error) {
    if (!renamed) {
      try {
        fs.rmSync(stagingDirectory, { recursive: true, force: true });
      } catch {
        // Best effort: an unrenamed private staging directory is not admitted.
      }
    }
    throw error;
  }
}

export function writeClasspilotTileAuthorizationPlanObservation(
  outputDirectory,
  packet,
  evidence
) {
  validateClasspilotTileAuthorizationPlanObservation(packet);
  if (
    packet.collection.status === "failed" &&
    packet.collection.failureCode === "log_evidence_unavailable" &&
    packet.collection.attemptCount < 1
  ) {
    invalid();
  }
  inspectClasspilotTileAuthorizationPlanObservationAttempt(
    attemptPathForTerminalDirectory(outputDirectory),
    {
      expectedAttemptRecordSha256: packet.attemptRecordSha256,
      observationId: packet.observationId,
      applicationGitSha: packet.applicationGitSha,
      imageDigest: packet.imageDigest,
      candidateApiTaskDefinitionArn:
        packet.candidateApiTaskDefinitionArn,
      candidateWorkerTaskDefinitionArn:
        packet.candidateWorkerTaskDefinitionArn,
      activeApiTaskDefinitionArn:
        packet.activeBaseline.apiTaskDefinitionArn,
      activeWorkerTaskDefinitionArn:
        packet.activeBaseline.workerTaskDefinitionArn,
      initialNetworkConfigurationSha256:
        packet.initialNetworkConfigurationSha256,
      initialProductionPostureSha256:
        packet.initialProductionPostureSha256,
    }
  );
  const companions = validateCompanionInput(packet, evidence);
  const finalDirectory = path.resolve(outputDirectory);
  const parentDirectory = preparePrivateOutputDirectory(
    path.dirname(finalDirectory)
  );
  if (fs.existsSync(finalDirectory)) {
    throw new Error("classpilot_tile_auth_plan_observation_already_exists");
  }
  const stagingDirectory = path.join(
    parentDirectory,
    `.${path.basename(finalDirectory)}.staging-${process.pid}-${randomBytes(8).toString("hex")}`
  );
  let renamed = false;
  try {
    const preparedStaging =
      preparePrivateOutputDirectory(stagingDirectory);
    for (const [filename, , value] of companions) {
      writePrivateJson(preparedStaging, filename, value);
    }
    writePrivateJson(
      preparedStaging,
      OBSERVATION_PACKET_FILENAME,
      packet
    );
    fs.renameSync(preparedStaging, finalDirectory);
    renamed = true;
    const packetPath = path.join(
      finalDirectory,
      OBSERVATION_PACKET_FILENAME
    );
    validateCompanions(packetPath, packet);
    return {
      path: packetPath,
      sha256: sha256(fs.readFileSync(packetPath)),
      packet,
    };
  } catch (error) {
    if (!renamed) {
      try {
        fs.rmSync(stagingDirectory, { recursive: true, force: true });
      } catch {
        // Best effort: an unrenamed private staging directory is never admitted.
      }
    }
    throw error;
  }
}

export function inspectClasspilotTileAuthorizationPlanObservation(
  packetPath,
  expected
) {
  const realPacketPath = requirePrivatePacketPath(packetPath);
  const bytes = fs.readFileSync(realPacketPath);
  if (
    sha256(bytes) !==
    requireString(expected.expectedPacketSha256, SHA256, 64)
  ) {
    mismatch();
  }
  const parsed = JSON.parse(bytes.toString("utf8"));
  const packet =
    parsed.version === LEGACY_OBSERVATION_VERSION
      ? validateLegacyObservation(parsed, expected)
      : validateClasspilotTileAuthorizationPlanObservation(parsed, expected);
  if (packet.version === OBSERVATION_VERSION) {
    if (
      packet.attemptRecordFile !== OBSERVATION_ATTEMPT_RELATIVE_FILE ||
      packet.attemptRecordSha256 !==
        requireString(
          expected.expectedAttemptRecordSha256,
          SHA256,
          64
        )
    ) {
      mismatch();
    }
    inspectClasspilotTileAuthorizationPlanObservationAttempt(
      attemptPathForPacket(realPacketPath),
      {
        ...expected,
        expectedAttemptRecordSha256: packet.attemptRecordSha256,
      }
    );
  }
  validateCompanions(realPacketPath, packet);
  return {
    schemaVersion: packet.schemaVersion,
    version: packet.version,
    path: realPacketPath,
    sha256: sha256(bytes),
    observationId: packet.observationId,
    observationOutcome: packet.observationOutcome,
    eligibleForDeployment: false,
    eligibleForDiagnostic: false,
    eligibleForCertification: false,
  };
}

function parseArguments(argv) {
  const mode = argv[0];
  if (!["admit", "write", "inspect"].includes(mode)) {
    throw new Error("classpilot_tile_auth_plan_observation_arguments_invalid");
  }
  const options = {};
  const names = {
    "--output": "output",
    "--packet": "packet",
    "--expected-packet-sha256": "expectedPacketSha256",
    "--expected-attempt-sha256": "expectedAttemptRecordSha256",
    "--observation-id": "observationId",
    "--application-sha": "applicationGitSha",
    "--image-digest": "imageDigest",
    "--candidate-api-task-definition-arn": "candidateApiTaskDefinitionArn",
    "--candidate-worker-task-definition-arn":
      "candidateWorkerTaskDefinitionArn",
    "--active-api-task-definition-arn": "activeApiTaskDefinitionArn",
    "--active-worker-task-definition-arn": "activeWorkerTaskDefinitionArn",
    "--initial-network-configuration-sha256":
      "initialNetworkConfigurationSha256",
    "--initial-production-posture-sha256":
      "initialProductionPostureSha256",
  };
  for (let index = 1; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    const key = names[name];
    if (!key || value === undefined || Object.hasOwn(options, key)) {
      throw new Error(
        "classpilot_tile_auth_plan_observation_arguments_invalid"
      );
    }
    options[key] = value;
  }
  const identity = [
    "observationId",
    "applicationGitSha",
    "imageDigest",
    "candidateApiTaskDefinitionArn",
    "candidateWorkerTaskDefinitionArn",
    "activeApiTaskDefinitionArn",
    "activeWorkerTaskDefinitionArn",
    "initialNetworkConfigurationSha256",
    "initialProductionPostureSha256",
  ];
  const required =
    mode === "admit"
      ? ["output", ...identity]
      : mode === "write"
        ? ["output", "expectedAttemptRecordSha256", ...identity]
        : [
            "packet",
            "expectedPacketSha256",
            ...identity,
          ];
  if (required.some((key) => !Object.hasOwn(options, key))) {
    throw new Error("classpilot_tile_auth_plan_observation_arguments_invalid");
  }
  return { mode, options };
}

async function readStdinJson() {
  let input = "";
  for await (const chunk of process.stdin) input += chunk;
  if (!input.trim()) {
    throw new Error("classpilot_tile_auth_plan_observation_arguments_invalid");
  }
  return JSON.parse(input);
}

function packetCompanionValues(packet, terminalEvidence) {
  if (packet.preflightEvidenceFile !== null) {
    return {
      preflight:
        validateClasspilotTileAuthorizationPlanPreflightEvidence(
          terminalEvidence.eventsDocument
        ),
      selection:
        extractClasspilotTileAuthorizationPlanBaseSelectionEvidence(
          terminalEvidence.eventsDocument
        ),
    };
  }
  if (packet.funnelEvidenceFile !== null) {
    return {
      funnel:
        extractClasspilotTileAuthorizationPlanBaseFunnelEvidence(
          terminalEvidence.eventsDocument
        ),
    };
  }
  return {};
}

export async function runCli(argv) {
  const { mode, options } = parseArguments(argv);
  if (mode === "admit") {
    const attempt =
      buildClasspilotTileAuthorizationPlanObservationAttempt(options);
    const written =
      writeClasspilotTileAuthorizationPlanObservationAttempt(
        path.resolve(options.output),
        attempt
      );
    return {
      schemaVersion: 1,
      version: OBSERVATION_ATTEMPT_VERSION,
      path: written.path,
      sha256: written.sha256,
      observationId: attempt.observationId,
      eligibleForDeployment: false,
      eligibleForDiagnostic: false,
      eligibleForCertification: false,
    };
  }
  if (mode === "inspect") {
    return inspectClasspilotTileAuthorizationPlanObservation(
      options.packet,
      options
    );
  }
  const terminalEvidence = await readStdinJson();
  const packet = buildClasspilotTileAuthorizationPlanObservation({
    ...options,
    attemptRecordSha256: options.expectedAttemptRecordSha256,
    terminalEvidence,
  });
  const written = writeClasspilotTileAuthorizationPlanObservation(
    path.resolve(options.output),
    packet,
    packetCompanionValues(packet, terminalEvidence)
  );
  return {
    schemaVersion: 2,
    version: OBSERVATION_VERSION,
    path: written.path,
    sha256: written.sha256,
    observationId: packet.observationId,
    observationOutcome: packet.observationOutcome,
    eligibleForDeployment: false,
    eligibleForDiagnostic: false,
    eligibleForCertification: false,
  };
}

const invokedPath = process.argv[1];
if (
  invokedPath &&
  import.meta.url === pathToFileURL(path.resolve(invokedPath)).href
) {
  try {
    process.stdout.write(
      `${JSON.stringify(await runCli(process.argv.slice(2)))}\n`
    );
  } catch {
    process.stderr.write("classpilot_tile_auth_plan_observation_failed\n");
    process.exitCode = 1;
  }
}
