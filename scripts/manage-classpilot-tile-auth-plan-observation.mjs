#!/usr/bin/env node

import { createHash } from "node:crypto";
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
  validateClasspilotTileAuthorizationPlanPreflightEvidence,
} from "./validate-classpilot-tile-auth-plan-preflight-evidence.mjs";

export const OBSERVATION_VERSION =
  "classpilot-tile-auth-plan-observation-v1";
export const OBSERVATION_PACKET_FILENAME =
  "classpilot-tile-auth-plan-observation.private.json";
export const OBSERVATION_PREFLIGHT_FILENAME =
  "base-preflight.evidence.private.json";
export const OBSERVATION_FUNNEL_FILENAME =
  "base-funnel.evidence.private.json";

const SHA256 = /^[a-f0-9]{64}$/;
const APPLICATION_SHA = /^[a-f0-9]{40}$/;
const IMAGE_DIGEST = /^sha256:[a-f0-9]{64}$/;
const OBSERVATION_ID = /^[a-z0-9][a-z0-9-]{7,127}$/;
const PACKET_KEYS = [
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
const TERMINAL_TASK_KEYS = [
  "exitCode",
  "logStreamSha256",
  "taskArn",
];

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
    throw new Error("classpilot_tile_auth_plan_observation_invalid");
  }
  return value;
}

function requireUtc(value) {
  const timestamp = requireString(value, null, 64);
  const parsed = Date.parse(timestamp);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== timestamp) {
    throw new Error("classpilot_tile_auth_plan_observation_invalid");
  }
  return timestamp;
}

function requireTaskDefinitionArn(value, familyPattern) {
  const arn = requireString(value, null, 512);
  const match =
    /^arn:aws:ecs:([a-z0-9-]+):(\d{12}):task-definition\/([A-Za-z0-9_-]+):([1-9]\d*)$/.exec(
      arn
    );
  if (!match || !familyPattern.test(match[3])) {
    throw new Error("classpilot_tile_auth_plan_observation_invalid");
  }
  return arn;
}

function requireTaskArn(value) {
  const arn = requireString(value, null, 512);
  if (
    !/^arn:aws:ecs:[a-z0-9-]+:\d{12}:task\/(?:[A-Za-z0-9_-]+\/)?[a-f0-9]{32}$/.test(
      arn
    )
  ) {
    throw new Error("classpilot_tile_auth_plan_observation_invalid");
  }
  return arn;
}

function requireExitCode(value) {
  const exitCode =
    typeof value === "string" && /^[0-9]{1,3}$/.test(value)
      ? Number(value)
      : value;
  if (!Number.isInteger(exitCode) || exitCode < 0 || exitCode > 255) {
    throw new Error("classpilot_tile_auth_plan_observation_invalid");
  }
  return exitCode;
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

function canonicalizeObservationEvidence(eventsDocument, exitCode) {
  if (exitCode === 0) {
    const preflight =
      validateClasspilotTileAuthorizationPlanPreflightEvidence(eventsDocument);
    return {
      observationOutcome: "base_eligible",
      preflight,
      funnel: null,
    };
  }
  if (exitCode !== 1) {
    throw new Error("classpilot_tile_auth_plan_observation_invalid");
  }
  const funnel =
    extractClasspilotTileAuthorizationPlanBaseFunnelEvidence(eventsDocument);
  return {
    observationOutcome: "base_ineligible",
    preflight: null,
    funnel,
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
  networkConfigurationSha256,
  productionPostureSha256,
  terminalTaskArn,
  terminalTaskExitCode,
  terminalLogStreamSha256,
  eventsDocument,
  createdAtUtc = new Date().toISOString(),
}) {
  const exitCode = requireExitCode(terminalTaskExitCode);
  const evidence = canonicalizeObservationEvidence(eventsDocument, exitCode);
  const preflightEvidenceSha256 =
    evidence.preflight === null
      ? null
      : sha256(privateJsonPayload(evidence.preflight));
  const funnelEvidenceSha256 =
    evidence.funnel === null
      ? null
      : sha256(privateJsonPayload(evidence.funnel));
  return {
    schemaVersion: 1,
    type: "classpilot_tile_auth_plan_observation",
    version: OBSERVATION_VERSION,
    status: "observed",
    observationId: requireString(observationId, OBSERVATION_ID, 128),
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
    networkConfigurationSha256: requireString(
      networkConfigurationSha256,
      SHA256,
      64
    ),
    productionPostureSha256: requireString(
      productionPostureSha256,
      SHA256,
      64
    ),
    terminalTask: {
      taskArn: requireTaskArn(terminalTaskArn),
      exitCode,
      logStreamSha256: requireString(
        terminalLogStreamSha256,
        SHA256,
        64
      ),
    },
    preflightEvidenceFile:
      evidence.preflight === null ? null : OBSERVATION_PREFLIGHT_FILENAME,
    preflightEvidenceSha256,
    funnelEvidenceFile:
      evidence.funnel === null ? null : OBSERVATION_FUNNEL_FILENAME,
    funnelEvidenceSha256,
    eligibleForDeployment: false,
    eligibleForDiagnostic: false,
    eligibleForCertification: false,
    createdAtUtc: requireUtc(createdAtUtc),
  };
}

export function validateClasspilotTileAuthorizationPlanObservation(
  packet,
  expected = {}
) {
  if (
    !hasExactKeys(packet, PACKET_KEYS) ||
    packet.schemaVersion !== 1 ||
    packet.type !== "classpilot_tile_auth_plan_observation" ||
    packet.version !== OBSERVATION_VERSION ||
    packet.status !== "observed" ||
    packet.eligibleForDeployment !== false ||
    packet.eligibleForDiagnostic !== false ||
    packet.eligibleForCertification !== false ||
    !hasExactKeys(packet.activeBaseline, BASELINE_KEYS) ||
    !hasExactKeys(packet.terminalTask, TERMINAL_TASK_KEYS)
  ) {
    throw new Error("classpilot_tile_auth_plan_observation_invalid");
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

  const eligibleEvidence =
    packet.observationOutcome === "base_eligible" &&
    exitCode === 0 &&
    packet.preflightEvidenceFile === OBSERVATION_PREFLIGHT_FILENAME &&
    SHA256.test(packet.preflightEvidenceSha256 || "") &&
    packet.funnelEvidenceFile === null &&
    packet.funnelEvidenceSha256 === null;
  const ineligibleEvidence =
    packet.observationOutcome === "base_ineligible" &&
    exitCode === 1 &&
    packet.preflightEvidenceFile === null &&
    packet.preflightEvidenceSha256 === null &&
    packet.funnelEvidenceFile === OBSERVATION_FUNNEL_FILENAME &&
    SHA256.test(packet.funnelEvidenceSha256 || "");
  if (!eligibleEvidence && !ineligibleEvidence) {
    throw new Error("classpilot_tile_auth_plan_observation_invalid");
  }

  const comparisons = [
    ["observationId", OBSERVATION_ID, 128],
    ["applicationGitSha", APPLICATION_SHA, 40],
    ["imageDigest", IMAGE_DIGEST, 71],
    ["networkConfigurationSha256", SHA256, 64],
    ["productionPostureSha256", SHA256, 64],
  ];
  for (const [key, pattern, maximumLength] of comparisons) {
    if (
      expected[key] !== undefined &&
      packet[key] !== requireString(expected[key], pattern, maximumLength)
    ) {
      throw new Error("classpilot_tile_auth_plan_observation_mismatch");
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
      throw new Error("classpilot_tile_auth_plan_observation_mismatch");
    }
  }
  if (
    (expected.terminalTaskArn !== undefined &&
      packet.terminalTask.taskArn !== requireTaskArn(expected.terminalTaskArn)) ||
    (expected.terminalTaskExitCode !== undefined &&
      exitCode !== requireExitCode(expected.terminalTaskExitCode)) ||
    (expected.terminalLogStreamSha256 !== undefined &&
      packet.terminalTask.logStreamSha256 !==
        requireString(expected.terminalLogStreamSha256, SHA256, 64))
  ) {
    throw new Error("classpilot_tile_auth_plan_observation_mismatch");
  }
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

function validateCompanion(packetPath, packet) {
  const directory = path.dirname(packetPath);
  if (packet.observationOutcome === "base_eligible") {
    const companionPath = path.join(directory, packet.preflightEvidenceFile);
    const bytes = fs.readFileSync(companionPath);
    if (sha256(bytes) !== packet.preflightEvidenceSha256) {
      throw new Error("classpilot_tile_auth_plan_observation_mismatch");
    }
    const evidence =
      validateClasspilotTileAuthorizationPlanPreflightEvidence({
        events: [{ message: JSON.stringify(JSON.parse(bytes.toString("utf8"))) }],
      });
    if (stableJson(evidence) !== stableJson(JSON.parse(bytes.toString("utf8")))) {
      throw new Error("classpilot_tile_auth_plan_observation_invalid");
    }
    return evidence;
  }
  const companionPath = path.join(directory, packet.funnelEvidenceFile);
  const bytes = fs.readFileSync(companionPath);
  if (sha256(bytes) !== packet.funnelEvidenceSha256) {
    throw new Error("classpilot_tile_auth_plan_observation_mismatch");
  }
  const parsed = JSON.parse(bytes.toString("utf8"));
  const evidence =
    validateClasspilotTileAuthorizationPlanBaseFunnelEvidence(parsed);
  if (stableJson(evidence) !== stableJson(parsed)) {
    throw new Error("classpilot_tile_auth_plan_observation_invalid");
  }
  return evidence;
}

export function writeClasspilotTileAuthorizationPlanObservation(
  outputDirectory,
  packet,
  evidence
) {
  validateClasspilotTileAuthorizationPlanObservation(packet);
  const expectedEvidence =
    packet.observationOutcome === "base_eligible"
      ? validateClasspilotTileAuthorizationPlanPreflightEvidence({
          events: [{ message: JSON.stringify(evidence) }],
        })
      : validateClasspilotTileAuthorizationPlanBaseFunnelEvidence(evidence);
  const evidencePayload = privateJsonPayload(expectedEvidence);
  const expectedHash =
    packet.observationOutcome === "base_eligible"
      ? packet.preflightEvidenceSha256
      : packet.funnelEvidenceSha256;
  if (sha256(evidencePayload) !== expectedHash) {
    throw new Error("classpilot_tile_auth_plan_observation_mismatch");
  }
  const directory = preparePrivateOutputDirectory(outputDirectory);
  const companionFilename =
    packet.observationOutcome === "base_eligible"
      ? OBSERVATION_PREFLIGHT_FILENAME
      : OBSERVATION_FUNNEL_FILENAME;
  const companionPath = path.join(directory, companionFilename);
  const packetPath = path.join(directory, OBSERVATION_PACKET_FILENAME);
  if (fs.existsSync(companionPath) || fs.existsSync(packetPath)) {
    throw new Error("classpilot_tile_auth_plan_observation_already_exists");
  }
  writePrivateJson(directory, companionFilename, expectedEvidence);
  const writtenPacketPath = writePrivateJson(
    directory,
    OBSERVATION_PACKET_FILENAME,
    packet
  );
  return {
    path: writtenPacketPath,
    sha256: sha256(fs.readFileSync(writtenPacketPath)),
    packet,
  };
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
    throw new Error("classpilot_tile_auth_plan_observation_mismatch");
  }
  const packet = validateClasspilotTileAuthorizationPlanObservation(
    JSON.parse(bytes.toString("utf8")),
    expected
  );
  validateCompanion(realPacketPath, packet);
  return {
    schemaVersion: 1,
    version: OBSERVATION_VERSION,
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
  if (!["write", "inspect"].includes(mode)) {
    throw new Error("classpilot_tile_auth_plan_observation_arguments_invalid");
  }
  const options = {};
  const names = {
    "--output": "output",
    "--packet": "packet",
    "--expected-packet-sha256": "expectedPacketSha256",
    "--observation-id": "observationId",
    "--application-sha": "applicationGitSha",
    "--image-digest": "imageDigest",
    "--candidate-api-task-definition-arn": "candidateApiTaskDefinitionArn",
    "--candidate-worker-task-definition-arn":
      "candidateWorkerTaskDefinitionArn",
    "--active-api-task-definition-arn": "activeApiTaskDefinitionArn",
    "--active-worker-task-definition-arn": "activeWorkerTaskDefinitionArn",
    "--network-configuration-sha256": "networkConfigurationSha256",
    "--production-posture-sha256": "productionPostureSha256",
    "--terminal-task-arn": "terminalTaskArn",
    "--terminal-task-exit-code": "terminalTaskExitCode",
    "--terminal-log-stream-sha256": "terminalLogStreamSha256",
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
    "networkConfigurationSha256",
    "productionPostureSha256",
    "terminalTaskArn",
    "terminalTaskExitCode",
    "terminalLogStreamSha256",
  ];
  const required =
    mode === "write"
      ? ["output", ...identity]
      : ["packet", "expectedPacketSha256", ...identity];
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

export async function runCli(argv) {
  const { mode, options } = parseArguments(argv);
  if (mode === "inspect") {
    return inspectClasspilotTileAuthorizationPlanObservation(
      options.packet,
      options
    );
  }
  const eventsDocument = await readStdinJson();
  const packet = buildClasspilotTileAuthorizationPlanObservation({
    ...options,
    eventsDocument,
  });
  const evidence =
    packet.observationOutcome === "base_eligible"
      ? validateClasspilotTileAuthorizationPlanPreflightEvidence(eventsDocument)
      : extractClasspilotTileAuthorizationPlanBaseFunnelEvidence(eventsDocument);
  const written = writeClasspilotTileAuthorizationPlanObservation(
    path.resolve(options.output),
    packet,
    evidence
  );
  return {
    schemaVersion: 1,
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
