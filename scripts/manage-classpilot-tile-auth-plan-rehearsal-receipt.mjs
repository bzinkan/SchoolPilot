#!/usr/bin/env node

import { createHash, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  configuredLoadGatesRoot,
  preparePrivateOutputDirectory,
  writePrivateJson,
} from "./load/prepare-classpilot-load-test.mjs";
import {
  validateClasspilotTileAuthorizationPlanLifecycleEvidence,
  validateClasspilotTileAuthorizationPlanEvidence,
  validateSanitizedClasspilotTileAuthorizationPlanReport,
} from "./validate-classpilot-tile-auth-plan-evidence.mjs";
import {
  validateClasspilotTileAuthorizationPlanPreflightEvidence,
} from "./validate-classpilot-tile-auth-plan-preflight-evidence.mjs";

export const REHEARSAL_RECEIPT_FILENAME =
  "classpilot-tile-auth-plan-rehearsal.private.json";
export const REHEARSAL_CONSUMPTION_FILENAME =
  "classpilot-tile-auth-plan-rehearsal-consumed.private.json";
export const REHEARSAL_RECEIPT_VERSION =
  "classpilot-tile-auth-plan-rehearsal-v1";
export const REHEARSAL_PREFLIGHT_EVIDENCE_FILENAME =
  "base-preflight.evidence.private.json";
export const REHEARSAL_PLAN_REPORT_FILENAME =
  "plan-report.evidence.private.json";
export const REHEARSAL_LIFECYCLE_EVIDENCE_FILENAME =
  "transactional-scenarios.evidence.private.json";
export const REHEARSAL_ATTEMPT_FILENAME =
  "classpilot-tile-auth-plan-rehearsal-attempt.private.json";
export const REHEARSAL_ATTEMPT_VERSION =
  "classpilot-tile-auth-plan-rehearsal-attempt-v1";
export const REHEARSAL_TERMINAL_FILENAME =
  "classpilot-tile-auth-plan-rehearsal-terminal.private.json";
export const REHEARSAL_TERMINAL_VERSION =
  "classpilot-tile-auth-plan-rehearsal-terminal-v1";
export const REHEARSAL_EXECUTION_AUTHORITY_VERSION =
  "classpilot-tile-auth-plan-execution-authority-v1";

const SHA256 = /^[a-f0-9]{64}$/;
const APPLICATION_SHA = /^[a-f0-9]{40}$/;
const IMAGE_DIGEST = /^sha256:[a-f0-9]{64}$/;
const RECEIPT_KEYS = [
  "activeBaseline",
  "applicationGitSha",
  "candidateApiTaskDefinitionArn",
  "candidateApiTaskDefinitionSha256",
  "candidateWorkerTaskDefinitionArn",
  "candidateWorkerTaskDefinitionSha256",
  "createdAtUtc",
  "executionAuthoritySha256",
  "expiresAtUtc",
  "historyFallbackIdentitySha256",
  "imageDigest",
  "lifecycleEvidenceSha256",
  "lifecycleEvidenceFile",
  "networkConfigurationSha256",
  "planEventsSha256",
  "preflightEvidenceSha256",
  "preflightEvidenceFile",
  "queryIdentifierSha256",
  "sanitizedPlanReportSha256",
  "sanitizedPlanReportFile",
  "schemaVersion",
  "status",
  "type",
  "version",
];
const BASELINE_KEYS = [
  "apiTaskDefinitionArn",
  "workerTaskDefinitionArn",
];
const CONSUMPTION_KEYS = [
  "applicationGitSha",
  "consumedAtUtc",
  "executionAuthoritySha256",
  "receiptSha256",
  "rehearsalAdmissionSha256",
  "rehearsalTerminalSha256",
  "schemaVersion",
  "type",
  "version",
];
const ATTEMPT_KEYS = [
  "admittedAtUtc",
  "applicationGitSha",
  "executionAuthoritySha256",
  "schemaVersion",
  "status",
  "type",
  "version",
];
const TERMINAL_KEYS = [
  "admissionSha256",
  "applicationGitSha",
  "executionAuthoritySha256",
  "receiptSha256",
  "schemaVersion",
  "status",
  "terminalAtUtc",
  "type",
  "version",
];

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value, keys) {
  return (
    isRecord(value) &&
    JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort())
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
    throw new Error("classpilot_tile_auth_plan_rehearsal_receipt_invalid");
  }
  return value;
}

function requireTaskDefinitionArn(value, familyPattern) {
  const arn = requireString(value, null, 512);
  const match =
    /^arn:aws:ecs:([a-z0-9-]+):(\d{12}):task-definition\/([A-Za-z0-9_-]+):([1-9]\d*)$/.exec(
      arn
    );
  if (!match || !familyPattern.test(match[3])) {
    throw new Error("classpilot_tile_auth_plan_rehearsal_receipt_invalid");
  }
  return arn;
}

function requireUtc(value) {
  const timestamp = requireString(value, null, 64);
  const parsed = Date.parse(timestamp);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== timestamp) {
    throw new Error("classpilot_tile_auth_plan_rehearsal_receipt_invalid");
  }
  return timestamp;
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

function sha256(value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value, "utf8");
  return createHash("sha256").update(bytes).digest("hex");
}

function allowTestExecutionAuthorityOverride() {
  if (
    process.env.NODE_ENV !== "test" ||
    process.env.CLP_LOAD_FIXTURE_TEST_MODE !== "1" ||
    !process.env.CLP_LOAD_GATES_TEST_ROOT
  ) {
    return false;
  }
  try {
    const realTempRoot = fs.realpathSync(os.tmpdir());
    const realLoadGatesRoot = fs.realpathSync(configuredLoadGatesRoot());
    const relative = path.relative(realTempRoot, realLoadGatesRoot);
    return (
      relative.length > 0 &&
      !relative.startsWith("..") &&
      !path.isAbsolute(relative)
    );
  } catch {
    return false;
  }
}

function currentConsumptionUtc(expected) {
  const override = expected.consumedAtUtc ?? expected.nowUtc;
  if (override !== undefined) {
    if (!allowTestExecutionAuthorityOverride()) {
      throw new Error(
        "classpilot_tile_auth_plan_rehearsal_consumption_clock_invalid"
      );
    }
    return requireUtc(override);
  }
  return new Date().toISOString();
}

function runTestConsumptionHook(expected, phase) {
  const hook = expected.testConsumptionHook;
  if (hook === undefined) return;
  if (!allowTestExecutionAuthorityOverride() || typeof hook !== "function") {
    throw new Error(
      "classpilot_tile_auth_plan_rehearsal_consumption_hook_invalid"
    );
  }
  hook(phase);
}

export function hashClasspilotTileAuthorizationPlanExecutionAuthority({
  machineGuid,
  userSid,
}) {
  const normalizedMachineGuid = requireString(
    machineGuid,
    /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i,
    36
  );
  const normalizedUserSid = requireString(
    userSid,
    /^S-\d-(?:\d+-)+\d+$/i,
    184
  );
  return sha256(stableJson({
    machineGuid: normalizedMachineGuid.toLowerCase(),
    userSid: normalizedUserSid.toUpperCase(),
    version: REHEARSAL_EXECUTION_AUTHORITY_VERSION,
  }));
}

export function resolveClasspilotTileAuthorizationPlanExecutionAuthority() {
  const testOverride =
    process.env.CLP_TILE_AUTH_PLAN_REHEARSAL_TEST_EXECUTION_AUTHORITY_SHA256;
  if (testOverride !== undefined) {
    if (!allowTestExecutionAuthorityOverride()) {
      throw new Error(
        "classpilot_tile_auth_plan_rehearsal_execution_authority_invalid"
      );
    }
    return requireString(testOverride, SHA256, 64);
  }
  if (process.platform !== "win32") {
    throw new Error(
      "classpilot_tile_auth_plan_rehearsal_execution_authority_unavailable"
    );
  }
  try {
    const systemRoot = requireString(
      process.env.SystemRoot,
      /^[A-Za-z]:\\[^\u0000-\u001f\u007f]+$/,
      260
    );
    const regOutput = execFileSync(
      path.join(systemRoot, "System32", "reg.exe"),
      [
        "query",
        "HKLM\\SOFTWARE\\Microsoft\\Cryptography",
        "/v",
        "MachineGuid",
      ],
      {
        encoding: "utf8",
        windowsHide: true,
        timeout: 10_000,
        maxBuffer: 64 * 1024,
      }
    );
    const whoamiOutput = execFileSync(
      path.join(systemRoot, "System32", "whoami.exe"),
      ["/user", "/fo", "csv", "/nh"],
      {
        encoding: "utf8",
        windowsHide: true,
        timeout: 10_000,
        maxBuffer: 64 * 1024,
      }
    );
    const machineGuidMatches = [
      ...regOutput.matchAll(
        /^\s*MachineGuid\s+REG_SZ\s+([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})\s*$/gim
      ),
    ];
    const userSidMatches = [
      ...whoamiOutput.matchAll(/"?(S-\d-(?:\d+-)+\d+)"?/gi),
    ];
    if (machineGuidMatches.length !== 1 || userSidMatches.length !== 1) {
      throw new Error("authority_not_unique");
    }
    return hashClasspilotTileAuthorizationPlanExecutionAuthority({
      machineGuid: machineGuidMatches[0][1],
      userSid: userSidMatches[0][1],
    });
  } catch {
    throw new Error(
      "classpilot_tile_auth_plan_rehearsal_execution_authority_unavailable"
    );
  }
}

function privateJsonPayload(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function rehearsalAttemptRoot(applicationGitSha) {
  const sha = requireString(applicationGitSha, APPLICATION_SHA, 40);
  return path.join(
    configuredLoadGatesRoot(),
    "tile-auth-rehearsals",
    sha
  );
}

function rehearsalConsumptionPath(applicationGitSha) {
  return path.join(
    rehearsalAttemptRoot(applicationGitSha),
    REHEARSAL_CONSUMPTION_FILENAME
  );
}

function writeExclusivePrivateJson(directory, filename, value, failureCode) {
  const target = path.join(directory, filename);
  const candidateName =
    `.${filename}.${process.pid}.${randomBytes(16).toString("hex")}.json`;
  const candidate = writePrivateJson(directory, candidateName, value);
  try {
    fs.linkSync(candidate, target);
  } catch {
    throw new Error(failureCode);
  } finally {
    fs.rmSync(candidate, { force: true });
  }
  return target;
}

function validateRehearsalAttempt(value, expectedApplicationGitSha) {
  const authorityHash =
    resolveClasspilotTileAuthorizationPlanExecutionAuthority();
  if (
    !hasExactKeys(value, ATTEMPT_KEYS) ||
    value.schemaVersion !== 1 ||
    value.type !== "classpilot_tile_auth_plan_rehearsal_attempt" ||
    value.version !== REHEARSAL_ATTEMPT_VERSION ||
    value.status !== "admitted" ||
    value.executionAuthoritySha256 !== authorityHash ||
    value.applicationGitSha !==
      requireString(expectedApplicationGitSha, APPLICATION_SHA, 40)
  ) {
    throw new Error("classpilot_tile_auth_plan_rehearsal_attempt_invalid");
  }
  requireUtc(value.admittedAtUtc);
  return value;
}

function validateRehearsalTerminal(
  value,
  {
    expectedApplicationGitSha,
    expectedAdmissionSha256,
    expectedReceiptSha256,
    requirePassed = false,
  }
) {
  const sha = requireString(expectedApplicationGitSha, APPLICATION_SHA, 40);
  const admissionHash = requireString(
    expectedAdmissionSha256,
    SHA256,
    64
  );
  const authorityHash =
    resolveClasspilotTileAuthorizationPlanExecutionAuthority();
  if (
    !hasExactKeys(value, TERMINAL_KEYS) ||
    value.schemaVersion !== 1 ||
    value.type !== "classpilot_tile_auth_plan_rehearsal_terminal" ||
    value.version !== REHEARSAL_TERMINAL_VERSION ||
    !["passed", "failed"].includes(value.status) ||
    value.applicationGitSha !== sha ||
    value.executionAuthoritySha256 !== authorityHash ||
    value.admissionSha256 !== admissionHash ||
    (value.status === "passed" &&
      !SHA256.test(value.receiptSha256 || "")) ||
    (value.status === "failed" && value.receiptSha256 !== null) ||
    (requirePassed && value.status !== "passed") ||
    (expectedReceiptSha256 !== undefined &&
      value.receiptSha256 !==
        requireString(expectedReceiptSha256, SHA256, 64))
  ) {
    throw new Error("classpilot_tile_auth_plan_rehearsal_terminal_invalid");
  }
  requireUtc(value.terminalAtUtc);
  return value;
}

function inspectOptionalRehearsalTerminal(receipt, receiptSha256) {
  const directory = rehearsalAttemptRoot(receipt.applicationGitSha);
  const admissionPath = path.join(directory, REHEARSAL_ATTEMPT_FILENAME);
  const terminalPath = path.join(directory, REHEARSAL_TERMINAL_FILENAME);
  const admissionExists = fs.existsSync(admissionPath);
  const terminalExists = fs.existsSync(terminalPath);
  if (!admissionExists && !terminalExists) {
    return null;
  }
  if (!admissionExists) {
    throw new Error("classpilot_tile_auth_plan_rehearsal_terminal_invalid");
  }
  const admissionBytes = fs.readFileSync(admissionPath);
  const admissionHash = sha256(admissionBytes);
  const admission = validateRehearsalAttempt(
    JSON.parse(admissionBytes.toString("utf8")),
    receipt.applicationGitSha
  );
  if (!terminalExists) {
    throw new Error("classpilot_tile_auth_plan_rehearsal_terminal_invalid");
  }
  const terminalBytes = fs.readFileSync(terminalPath);
  const terminal = validateRehearsalTerminal(
    JSON.parse(terminalBytes.toString("utf8")),
    {
      expectedApplicationGitSha: receipt.applicationGitSha,
      expectedAdmissionSha256: admissionHash,
      expectedReceiptSha256: receiptSha256,
      requirePassed: true,
    }
  );
  if (
    Date.parse(terminal.terminalAtUtc) <
      Date.parse(admission.admittedAtUtc) ||
    Date.parse(terminal.terminalAtUtc) <
      Date.parse(receipt.createdAtUtc) ||
    Date.parse(terminal.terminalAtUtc) >=
      Date.parse(receipt.expiresAtUtc)
  ) {
    throw new Error("classpilot_tile_auth_plan_rehearsal_terminal_invalid");
  }
  return {
    admissionSha256: admissionHash,
    terminal,
    terminalSha256: sha256(terminalBytes),
  };
}

function requirePassedRehearsalTerminal(receipt, receiptSha256) {
  const binding = inspectOptionalRehearsalTerminal(receipt, receiptSha256);
  if (binding?.terminal?.status !== "passed") {
    throw new Error("classpilot_tile_auth_plan_rehearsal_terminal_invalid");
  }
  return binding;
}

function buildConsumptionRecords(
  receipt,
  receiptSha256,
  consumedAtUtc
) {
  const authorityHash =
    resolveClasspilotTileAuthorizationPlanExecutionAuthority();
  const consumedAt = requireUtc(consumedAtUtc);
  const admission = {
    schemaVersion: 1,
    type: "classpilot_tile_auth_plan_rehearsal_attempt",
    version: REHEARSAL_ATTEMPT_VERSION,
    status: "admitted",
    applicationGitSha: receipt.applicationGitSha,
    executionAuthoritySha256: authorityHash,
    admittedAtUtc: consumedAt,
  };
  validateRehearsalAttempt(admission, receipt.applicationGitSha);
  const admissionSha256 = sha256(privateJsonPayload(admission));
  const terminal = {
    schemaVersion: 1,
    type: "classpilot_tile_auth_plan_rehearsal_terminal",
    version: REHEARSAL_TERMINAL_VERSION,
    status: "passed",
    applicationGitSha: receipt.applicationGitSha,
    executionAuthoritySha256: authorityHash,
    admissionSha256,
    receiptSha256,
    terminalAtUtc: consumedAt,
  };
  validateRehearsalTerminal(terminal, {
    expectedApplicationGitSha: receipt.applicationGitSha,
    expectedAdmissionSha256: admissionSha256,
    expectedReceiptSha256: receiptSha256,
    requirePassed: true,
  });
  const terminalSha256 = sha256(privateJsonPayload(terminal));
  const marker = {
    schemaVersion: 1,
    type: "classpilot_tile_auth_plan_rehearsal_consumption",
    version: REHEARSAL_RECEIPT_VERSION,
    applicationGitSha: receipt.applicationGitSha,
    executionAuthoritySha256: authorityHash,
    receiptSha256,
    rehearsalAdmissionSha256: admissionSha256,
    rehearsalTerminalSha256: terminalSha256,
    consumedAtUtc: consumedAt,
  };
  if (!hasExactKeys(marker, CONSUMPTION_KEYS)) {
    throw new Error("classpilot_tile_auth_plan_rehearsal_receipt_invalid");
  }
  return {
    admission,
    admissionSha256,
    marker,
    terminal,
    terminalSha256,
  };
}

export function admitClasspilotTileAuthorizationPlanRehearsalAttempt({
  applicationGitSha,
  admittedAtUtc = new Date().toISOString(),
}) {
  const sha = requireString(applicationGitSha, APPLICATION_SHA, 40);
  const authorityHash =
    resolveClasspilotTileAuthorizationPlanExecutionAuthority();
  const directory = preparePrivateOutputDirectory(rehearsalAttemptRoot(sha));
  const terminalPath = path.join(directory, REHEARSAL_TERMINAL_FILENAME);
  if (fs.existsSync(terminalPath)) {
    throw new Error("classpilot_tile_auth_plan_rehearsal_attempt_already_used");
  }
  const attempt = {
    schemaVersion: 1,
    type: "classpilot_tile_auth_plan_rehearsal_attempt",
    version: REHEARSAL_ATTEMPT_VERSION,
    status: "admitted",
    applicationGitSha: sha,
    executionAuthoritySha256: authorityHash,
    admittedAtUtc: requireUtc(admittedAtUtc),
  };
  const attemptPath = writeExclusivePrivateJson(
    directory,
    REHEARSAL_ATTEMPT_FILENAME,
    attempt,
    "classpilot_tile_auth_plan_rehearsal_attempt_already_used"
  );
  return {
    schemaVersion: 1,
    version: REHEARSAL_ATTEMPT_VERSION,
    path: attemptPath,
    sha256: sha256(fs.readFileSync(attemptPath)),
    applicationGitSha: sha,
    admittedAtUtc: attempt.admittedAtUtc,
  };
}

export function terminalClasspilotTileAuthorizationPlanRehearsalAttempt({
  applicationGitSha,
  expectedAdmissionSha256,
  outcome,
  receiptPath = null,
  receiptSha256 = null,
  terminalAtUtc = new Date().toISOString(),
}) {
  const sha = requireString(applicationGitSha, APPLICATION_SHA, 40);
  const authorityHash =
    resolveClasspilotTileAuthorizationPlanExecutionAuthority();
  const expectedHash = requireString(expectedAdmissionSha256, SHA256, 64);
  if (
    !["passed", "failed"].includes(outcome) ||
    (outcome === "passed" &&
      (typeof receiptPath !== "string" ||
        receiptPath.length === 0 ||
        typeof receiptSha256 !== "string" ||
        !SHA256.test(receiptSha256))) ||
    (outcome === "failed" &&
      (receiptPath !== null || receiptSha256 !== null))
  ) {
    throw new Error("classpilot_tile_auth_plan_rehearsal_terminal_invalid");
  }
  const directory = preparePrivateOutputDirectory(rehearsalAttemptRoot(sha));
  const admissionPath = path.join(directory, REHEARSAL_ATTEMPT_FILENAME);
  const admissionBytes = fs.readFileSync(admissionPath);
  if (sha256(admissionBytes) !== expectedHash) {
    throw new Error("classpilot_tile_auth_plan_rehearsal_attempt_mismatch");
  }
  const admission = validateRehearsalAttempt(
    JSON.parse(admissionBytes.toString("utf8")),
    sha
  );
  const terminalAt = requireUtc(terminalAtUtc);
  if (Date.parse(terminalAt) < Date.parse(admission.admittedAtUtc)) {
    throw new Error("classpilot_tile_auth_plan_rehearsal_terminal_invalid");
  }
  if (outcome === "passed") {
    const realReceiptPath = requirePrivateReceiptPath(receiptPath);
    const receiptBytes = fs.readFileSync(realReceiptPath);
    if (sha256(receiptBytes) !== receiptSha256) {
      throw new Error("classpilot_tile_auth_plan_rehearsal_receipt_mismatch");
    }
    const receipt = JSON.parse(receiptBytes.toString("utf8"));
    validateClasspilotTileAuthorizationPlanRehearsalReceipt(receipt, {
      expectedApplicationGitSha: sha,
      expectedActiveApiTaskDefinitionArn:
        receipt.activeBaseline?.apiTaskDefinitionArn,
      expectedActiveWorkerTaskDefinitionArn:
        receipt.activeBaseline?.workerTaskDefinitionArn,
      expectedNetworkConfigurationSha256:
        receipt.networkConfigurationSha256,
      nowUtc: terminalAt,
    });
    validateCompanionEvidence(realReceiptPath, receipt);
    if (fs.existsSync(rehearsalConsumptionPath(receipt.applicationGitSha))) {
      throw new Error("classpilot_tile_auth_plan_rehearsal_receipt_already_used");
    }
  }
  const terminal = {
    schemaVersion: 1,
    type: "classpilot_tile_auth_plan_rehearsal_terminal",
    version: REHEARSAL_TERMINAL_VERSION,
    applicationGitSha: sha,
    executionAuthoritySha256: authorityHash,
    admissionSha256: expectedHash,
    status: outcome,
    receiptSha256,
    terminalAtUtc: terminalAt,
  };
  if (!hasExactKeys(terminal, TERMINAL_KEYS)) {
    throw new Error("classpilot_tile_auth_plan_rehearsal_terminal_invalid");
  }
  const terminalPath = writeExclusivePrivateJson(
    directory,
    REHEARSAL_TERMINAL_FILENAME,
    terminal,
    "classpilot_tile_auth_plan_rehearsal_terminal_already_exists"
  );
  return {
    schemaVersion: 1,
    version: REHEARSAL_TERMINAL_VERSION,
    path: terminalPath,
    sha256: sha256(fs.readFileSync(terminalPath)),
    applicationGitSha: sha,
    admissionSha256: expectedHash,
    status: outcome,
    receiptSha256,
    terminalAtUtc: terminalAt,
  };
}

function extractLifecycle(eventsDocument) {
  const events = Array.isArray(eventsDocument?.events) ? eventsDocument.events : [];
  const matches = [];
  for (const event of events) {
    if (!isRecord(event) || typeof event.message !== "string") continue;
    try {
      const message = JSON.parse(event.message);
      if (message?.version === "transactional-plan-scenarios-v2") {
        matches.push(message);
      }
    } catch {
      // CloudWatch can contain non-JSON startup noise.
    }
  }
  if (matches.length !== 1) {
    throw new Error("classpilot_tile_auth_plan_rehearsal_receipt_invalid");
  }
  return validateClasspilotTileAuthorizationPlanLifecycleEvidence(matches[0]);
}

function historyFallbackIdentityBinding(report) {
  const identity = report?.historyFallbackSqlIdentity;
  const keys = [
    "compiledSqlSha256",
    "engineVersion",
    "parameterTypeSignatureSha256",
    "queryIdentifierSha256",
    "schemaIdentitySha256",
    "trackIoTiming",
    "version",
  ];
  if (
    !hasExactKeys(identity, keys) ||
    identity.trackIoTiming !== true ||
    !SHA256.test(identity.compiledSqlSha256 || "") ||
    !SHA256.test(identity.parameterTypeSignatureSha256 || "") ||
    !SHA256.test(identity.queryIdentifierSha256 || "") ||
    !SHA256.test(identity.schemaIdentitySha256 || "")
  ) {
    throw new Error("classpilot_tile_auth_plan_rehearsal_receipt_invalid");
  }
  return {
    identitySha256: sha256(stableJson(identity)),
    queryIdentifierSha256: identity.queryIdentifierSha256,
  };
}

export function buildClasspilotTileAuthorizationPlanRehearsalReceipt({
  applicationGitSha,
  imageDigest,
  candidateApiTaskDefinitionArn,
  candidateApiTaskDefinitionSha256,
  candidateWorkerTaskDefinitionArn,
  candidateWorkerTaskDefinitionSha256,
  activeApiTaskDefinitionArn,
  activeWorkerTaskDefinitionArn,
  networkConfigurationSha256,
  preflightEventsDocument,
  planEventsDocument,
  createdAtUtc = new Date().toISOString(),
}) {
  const preflight =
    validateClasspilotTileAuthorizationPlanPreflightEvidence(
      preflightEventsDocument
    );
  const report = validateClasspilotTileAuthorizationPlanEvidence(planEventsDocument);
  const lifecycle = extractLifecycle(planEventsDocument);
  const identity = historyFallbackIdentityBinding(report);
  const createdAt = requireUtc(createdAtUtc);
  const authorityHash =
    resolveClasspilotTileAuthorizationPlanExecutionAuthority();
  const expiresAt = new Date(Date.parse(createdAt) + 60 * 60 * 1000).toISOString();

  return {
    schemaVersion: 1,
    type: "classpilot_tile_auth_plan_rehearsal_receipt",
    version: REHEARSAL_RECEIPT_VERSION,
    status: "passed",
    applicationGitSha: requireString(applicationGitSha, APPLICATION_SHA, 40),
    executionAuthoritySha256: authorityHash,
    imageDigest: requireString(imageDigest, IMAGE_DIGEST, 71),
    candidateApiTaskDefinitionArn: requireTaskDefinitionArn(
      candidateApiTaskDefinitionArn,
      /-api-emergency$/
    ),
    candidateApiTaskDefinitionSha256: requireString(
      candidateApiTaskDefinitionSha256,
      SHA256,
      64
    ),
    candidateWorkerTaskDefinitionArn: requireTaskDefinitionArn(
      candidateWorkerTaskDefinitionArn,
      /-scheduler-worker$/
    ),
    candidateWorkerTaskDefinitionSha256: requireString(
      candidateWorkerTaskDefinitionSha256,
      SHA256,
      64
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
    preflightEvidenceSha256: sha256(privateJsonPayload(preflight)),
    preflightEvidenceFile: REHEARSAL_PREFLIGHT_EVIDENCE_FILENAME,
    planEventsSha256: sha256(stableJson(planEventsDocument)),
    sanitizedPlanReportSha256: sha256(privateJsonPayload(report)),
    sanitizedPlanReportFile: REHEARSAL_PLAN_REPORT_FILENAME,
    lifecycleEvidenceSha256: sha256(privateJsonPayload(lifecycle)),
    lifecycleEvidenceFile: REHEARSAL_LIFECYCLE_EVIDENCE_FILENAME,
    historyFallbackIdentitySha256: identity.identitySha256,
    queryIdentifierSha256: identity.queryIdentifierSha256,
    createdAtUtc: createdAt,
    expiresAtUtc: expiresAt,
  };
}

export function validateClasspilotTileAuthorizationPlanRehearsalReceipt(
  receipt,
  {
    expectedApplicationGitSha,
    expectedActiveApiTaskDefinitionArn,
    expectedActiveWorkerTaskDefinitionArn,
    expectedNetworkConfigurationSha256,
    nowUtc = new Date().toISOString(),
  }
) {
  if (
    !hasExactKeys(receipt, RECEIPT_KEYS) ||
    receipt.schemaVersion !== 1 ||
    receipt.type !== "classpilot_tile_auth_plan_rehearsal_receipt" ||
    receipt.version !== REHEARSAL_RECEIPT_VERSION ||
    receipt.status !== "passed" ||
    !hasExactKeys(receipt.activeBaseline, BASELINE_KEYS)
  ) {
    throw new Error("classpilot_tile_auth_plan_rehearsal_receipt_invalid");
  }
  const createdAt = requireUtc(receipt.createdAtUtc);
  const expiresAt = requireUtc(receipt.expiresAtUtc);
  const now = requireUtc(nowUtc);
  const authorityHash =
    resolveClasspilotTileAuthorizationPlanExecutionAuthority();
  if (
    Date.parse(expiresAt) - Date.parse(createdAt) !== 60 * 60 * 1000 ||
    Date.parse(now) < Date.parse(createdAt) ||
    Date.parse(now) >= Date.parse(expiresAt) ||
    receipt.executionAuthoritySha256 !== authorityHash ||
    receipt.applicationGitSha !==
      requireString(expectedApplicationGitSha, APPLICATION_SHA, 40) ||
    receipt.activeBaseline.apiTaskDefinitionArn !==
      requireTaskDefinitionArn(
        expectedActiveApiTaskDefinitionArn,
        /-api(?:-emergency)?$/
      ) ||
    receipt.activeBaseline.workerTaskDefinitionArn !==
      requireTaskDefinitionArn(
        expectedActiveWorkerTaskDefinitionArn,
        /-scheduler-worker$/
      ) ||
    receipt.networkConfigurationSha256 !==
      requireString(expectedNetworkConfigurationSha256, SHA256, 64)
  ) {
    throw new Error("classpilot_tile_auth_plan_rehearsal_receipt_mismatch");
  }
  requireString(receipt.imageDigest, IMAGE_DIGEST, 71);
  requireTaskDefinitionArn(
    receipt.candidateApiTaskDefinitionArn,
    /-api-emergency$/
  );
  requireString(receipt.candidateApiTaskDefinitionSha256, SHA256, 64);
  requireTaskDefinitionArn(
    receipt.candidateWorkerTaskDefinitionArn,
    /-scheduler-worker$/
  );
  requireString(receipt.candidateWorkerTaskDefinitionSha256, SHA256, 64);
  if (
    receipt.preflightEvidenceFile !== REHEARSAL_PREFLIGHT_EVIDENCE_FILENAME ||
    receipt.sanitizedPlanReportFile !== REHEARSAL_PLAN_REPORT_FILENAME ||
    receipt.lifecycleEvidenceFile !== REHEARSAL_LIFECYCLE_EVIDENCE_FILENAME
  ) {
    throw new Error("classpilot_tile_auth_plan_rehearsal_receipt_invalid");
  }
  for (const key of [
    "preflightEvidenceSha256",
    "planEventsSha256",
    "sanitizedPlanReportSha256",
    "lifecycleEvidenceSha256",
    "historyFallbackIdentitySha256",
    "queryIdentifierSha256",
  ]) {
    requireString(receipt[key], SHA256, 64);
  }
  return receipt;
}

function requirePrivateReceiptPath(receiptPath) {
  const resolved = path.resolve(receiptPath);
  const root = fs.realpathSync(configuredLoadGatesRoot());
  const real = fs.realpathSync(resolved);
  const relative = path.relative(root, real);
  if (
    path.basename(real) !== REHEARSAL_RECEIPT_FILENAME ||
    relative.startsWith("..") ||
    path.isAbsolute(relative)
  ) {
    throw new Error("classpilot_tile_auth_plan_rehearsal_receipt_path_invalid");
  }
  return real;
}

function commitConsumptionMarker(
  directory,
  receipt,
  markerBinding,
  expected
) {
  const target = path.join(directory, REHEARSAL_CONSUMPTION_FILENAME);
  if (fs.existsSync(target)) {
    throw new Error("classpilot_tile_auth_plan_rehearsal_receipt_already_used");
  }
  const consumedAtUtc = requireReceiptFreshAtConsumption(
    receipt,
    currentConsumptionUtc(expected)
  );
  const marker = {
    schemaVersion: 1,
    type: "classpilot_tile_auth_plan_rehearsal_consumption",
    version: REHEARSAL_RECEIPT_VERSION,
    ...markerBinding,
    consumedAtUtc,
  };
  if (!hasExactKeys(marker, CONSUMPTION_KEYS)) {
    throw new Error("classpilot_tile_auth_plan_rehearsal_receipt_invalid");
  }
  const candidateName =
    `.${REHEARSAL_CONSUMPTION_FILENAME}.${process.pid}.` +
    `${randomBytes(16).toString("hex")}.json`;
  const candidate = path.join(directory, candidateName);
  try {
    writePrivateJson(directory, candidateName, marker);
    runTestConsumptionHook(expected, "before-marker-write");
    runTestConsumptionHook(
      expected,
      "before-final-post-reservation-timestamp"
    );
    requireReceiptFreshAtConsumption(
      receipt,
      currentConsumptionUtc(expected)
    );
    fs.linkSync(candidate, target);
  } catch (error) {
    if (
      error instanceof Error &&
      [
        "classpilot_tile_auth_plan_rehearsal_receipt_invalid",
        "classpilot_tile_auth_plan_rehearsal_receipt_mismatch",
      ].includes(error.message)
    ) {
      throw error;
    }
    throw new Error(
      "classpilot_tile_auth_plan_rehearsal_consumption_commit_failed"
    );
  } finally {
    fs.rmSync(candidate, { force: true });
  }
  return marker;
}

function publishFreshConsumptionGroup(
  receipt,
  receiptSha256,
  expected
) {
  const target = rehearsalAttemptRoot(receipt.applicationGitSha);
  if (fs.existsSync(target)) {
    throw new Error("classpilot_tile_auth_plan_rehearsal_terminal_invalid");
  }
  const parent = preparePrivateOutputDirectory(path.dirname(target));
  const staging = fs.mkdtempSync(
    path.join(parent, `.${receipt.applicationGitSha}.consume-`)
  );
  preparePrivateOutputDirectory(staging);
  let published = false;
  try {
    const records = buildConsumptionRecords(
      receipt,
      receiptSha256,
      requireReceiptFreshAtConsumption(
        receipt,
        currentConsumptionUtc(expected)
      )
    );
    writePrivateJson(staging, REHEARSAL_ATTEMPT_FILENAME, records.admission);
    writePrivateJson(staging, REHEARSAL_TERMINAL_FILENAME, records.terminal);
    runTestConsumptionHook(expected, "before-marker-write");
    writePrivateJson(
      staging,
      REHEARSAL_CONSUMPTION_FILENAME,
      records.marker
    );
    runTestConsumptionHook(
      expected,
      "before-final-post-reservation-timestamp"
    );
    requireReceiptFreshAtConsumption(
      receipt,
      currentConsumptionUtc(expected)
    );
    try {
      fs.renameSync(staging, target);
    } catch {
      throw new Error(
        "classpilot_tile_auth_plan_rehearsal_receipt_already_used"
      );
    }
    published = true;
    return {
      marker: records.marker,
      terminalBinding: {
        admissionSha256: records.admissionSha256,
        terminal: records.terminal,
        terminalSha256: records.terminalSha256,
      },
    };
  } catch (error) {
    if (
      error instanceof Error &&
      [
        "classpilot_tile_auth_plan_rehearsal_receipt_already_used",
        "classpilot_tile_auth_plan_rehearsal_receipt_invalid",
        "classpilot_tile_auth_plan_rehearsal_receipt_mismatch",
        "classpilot_tile_auth_plan_rehearsal_terminal_invalid",
      ].includes(error.message)
    ) {
      throw error;
    }
    throw new Error(
      "classpilot_tile_auth_plan_rehearsal_consumption_commit_failed"
    );
  } finally {
    if (!published) {
      fs.rmSync(staging, { force: true, recursive: true });
    }
  }
}

function requireReceiptFreshAtConsumption(receipt, consumedAtUtc) {
  const consumedAt = requireUtc(consumedAtUtc);
  if (
    Date.parse(consumedAt) < Date.parse(receipt.createdAtUtc) ||
    Date.parse(consumedAt) >= Date.parse(receipt.expiresAtUtc)
  ) {
    throw new Error("classpilot_tile_auth_plan_rehearsal_receipt_mismatch");
  }
  return consumedAt;
}

function validateEvidenceArtifacts(receipt, evidenceArtifacts) {
  if (
    !hasExactKeys(evidenceArtifacts, ["lifecycle", "preflight", "report"])
  ) {
    throw new Error("classpilot_tile_auth_plan_rehearsal_receipt_invalid");
  }
  const preflight =
    validateClasspilotTileAuthorizationPlanPreflightEvidence({
      events: [{ message: JSON.stringify(evidenceArtifacts.preflight) }],
    });
  const report = validateSanitizedClasspilotTileAuthorizationPlanReport(
    evidenceArtifacts.report
  );
  const lifecycle =
    validateClasspilotTileAuthorizationPlanLifecycleEvidence(
      evidenceArtifacts.lifecycle
    );
  if (
    stableJson(preflight) !== stableJson(evidenceArtifacts.preflight) ||
    stableJson(report) !== stableJson(evidenceArtifacts.report) ||
    stableJson(lifecycle) !== stableJson(evidenceArtifacts.lifecycle)
  ) {
    throw new Error("classpilot_tile_auth_plan_rehearsal_receipt_invalid");
  }
  const identity = historyFallbackIdentityBinding(report);
  if (
    receipt.preflightEvidenceSha256 !==
      sha256(privateJsonPayload(preflight)) ||
    receipt.sanitizedPlanReportSha256 !==
      sha256(privateJsonPayload(report)) ||
    receipt.lifecycleEvidenceSha256 !==
      sha256(privateJsonPayload(lifecycle)) ||
    receipt.historyFallbackIdentitySha256 !== identity.identitySha256 ||
    receipt.queryIdentifierSha256 !== identity.queryIdentifierSha256
  ) {
    throw new Error("classpilot_tile_auth_plan_rehearsal_receipt_mismatch");
  }
  return { preflight, report, lifecycle };
}

export function writeClasspilotTileAuthorizationPlanRehearsalReceipt(
  outputDirectory,
  receipt,
  evidenceArtifacts
) {
  validateClasspilotTileAuthorizationPlanRehearsalReceipt(receipt, {
    expectedApplicationGitSha: receipt.applicationGitSha,
    expectedActiveApiTaskDefinitionArn:
      receipt.activeBaseline?.apiTaskDefinitionArn,
    expectedActiveWorkerTaskDefinitionArn:
      receipt.activeBaseline?.workerTaskDefinitionArn,
    expectedNetworkConfigurationSha256: receipt.networkConfigurationSha256,
    nowUtc: receipt.createdAtUtc,
  });
  const validatedArtifacts = validateEvidenceArtifacts(
    receipt,
    evidenceArtifacts
  );
  const directory = preparePrivateOutputDirectory(outputDirectory);
  const target = path.join(directory, REHEARSAL_RECEIPT_FILENAME);
  if (fs.existsSync(target) || fs.existsSync(
    rehearsalConsumptionPath(receipt.applicationGitSha)
  )) {
    throw new Error("classpilot_tile_auth_plan_rehearsal_receipt_already_exists");
  }
  const preflightPath = writePrivateJson(
    directory,
    REHEARSAL_PREFLIGHT_EVIDENCE_FILENAME,
    validatedArtifacts.preflight
  );
  const reportPath = writePrivateJson(
    directory,
    REHEARSAL_PLAN_REPORT_FILENAME,
    validatedArtifacts.report
  );
  const lifecyclePath = writePrivateJson(
    directory,
    REHEARSAL_LIFECYCLE_EVIDENCE_FILENAME,
    validatedArtifacts.lifecycle
  );
  if (
    sha256(fs.readFileSync(preflightPath)) !==
      receipt.preflightEvidenceSha256 ||
    sha256(fs.readFileSync(reportPath)) !==
      receipt.sanitizedPlanReportSha256 ||
    sha256(fs.readFileSync(lifecyclePath)) !==
      receipt.lifecycleEvidenceSha256
  ) {
    throw new Error("classpilot_tile_auth_plan_rehearsal_receipt_mismatch");
  }
  const writtenPath = writePrivateJson(
    directory,
    REHEARSAL_RECEIPT_FILENAME,
    receipt
  );
  return {
    path: writtenPath,
    sha256: sha256(fs.readFileSync(writtenPath)),
    receipt,
  };
}

function validateCompanionEvidence(realReceiptPath, receipt) {
  const directory = path.dirname(realReceiptPath);
  const preflightPath = path.join(directory, receipt.preflightEvidenceFile);
  const reportPath = path.join(directory, receipt.sanitizedPlanReportFile);
  const lifecyclePath = path.join(directory, receipt.lifecycleEvidenceFile);
  const preflightBytes = fs.readFileSync(preflightPath);
  const reportBytes = fs.readFileSync(reportPath);
  const lifecycleBytes = fs.readFileSync(lifecyclePath);
  if (
    sha256(preflightBytes) !== receipt.preflightEvidenceSha256 ||
    sha256(reportBytes) !== receipt.sanitizedPlanReportSha256 ||
    sha256(lifecycleBytes) !== receipt.lifecycleEvidenceSha256
  ) {
    throw new Error("classpilot_tile_auth_plan_rehearsal_receipt_mismatch");
  }
  validateEvidenceArtifacts(receipt, {
    preflight: JSON.parse(preflightBytes.toString("utf8")),
    report: JSON.parse(reportBytes.toString("utf8")),
    lifecycle: JSON.parse(lifecycleBytes.toString("utf8")),
  });
}

export function consumeClasspilotTileAuthorizationPlanRehearsalReceipt(
  receiptPath,
  expected
) {
  const realReceiptPath = requirePrivateReceiptPath(receiptPath);
  const bytes = fs.readFileSync(realReceiptPath);
  if (
    sha256(bytes) !==
    requireString(expected.expectedReceiptSha256, SHA256, 64)
  ) {
    throw new Error("classpilot_tile_auth_plan_rehearsal_receipt_mismatch");
  }
  const receipt = validateClasspilotTileAuthorizationPlanRehearsalReceipt(
    JSON.parse(bytes.toString("utf8")),
    expected
  );
  validateCompanionEvidence(realReceiptPath, receipt);
  runTestConsumptionHook(expected, "before-preliminary-timestamp");
  requireReceiptFreshAtConsumption(
    receipt,
    currentConsumptionUtc(expected)
  );
  const receiptSha256 = sha256(bytes);
  const existingTerminal = inspectOptionalRehearsalTerminal(
    receipt,
    receiptSha256
  );
  const authorityHash =
    resolveClasspilotTileAuthorizationPlanExecutionAuthority();
  let marker;
  if (existingTerminal === null) {
    const published = publishFreshConsumptionGroup(
      receipt,
      receiptSha256,
      expected
    );
    marker = published.marker;
  } else {
    marker = commitConsumptionMarker(
      rehearsalAttemptRoot(receipt.applicationGitSha),
      receipt,
      {
        applicationGitSha: receipt.applicationGitSha,
        executionAuthoritySha256: authorityHash,
        receiptSha256,
        rehearsalAdmissionSha256: existingTerminal.admissionSha256,
        rehearsalTerminalSha256: existingTerminal.terminalSha256,
      },
      expected
    );
  }
  return {
    schemaVersion: 1,
    version: REHEARSAL_RECEIPT_VERSION,
    receiptSha256: marker.receiptSha256,
    imageDigest: receipt.imageDigest,
    candidateApiTaskDefinitionArn: receipt.candidateApiTaskDefinitionArn,
    candidateApiTaskDefinitionSha256:
      receipt.candidateApiTaskDefinitionSha256,
    candidateWorkerTaskDefinitionArn: receipt.candidateWorkerTaskDefinitionArn,
    candidateWorkerTaskDefinitionSha256:
      receipt.candidateWorkerTaskDefinitionSha256,
    historyFallbackIdentitySha256: receipt.historyFallbackIdentitySha256,
    queryIdentifierSha256: receipt.queryIdentifierSha256,
    preflightEvidenceSha256: receipt.preflightEvidenceSha256,
    planEventsSha256: receipt.planEventsSha256,
    sanitizedPlanReportSha256: receipt.sanitizedPlanReportSha256,
    lifecycleEvidenceSha256: receipt.lifecycleEvidenceSha256,
  };
}

export function inspectClasspilotTileAuthorizationPlanRehearsalReceipt(
  receiptPath,
  expected
) {
  const realReceiptPath = requirePrivateReceiptPath(receiptPath);
  const bytes = fs.readFileSync(realReceiptPath);
  if (
    sha256(bytes) !==
    requireString(expected.expectedReceiptSha256, SHA256, 64)
  ) {
    throw new Error("classpilot_tile_auth_plan_rehearsal_receipt_mismatch");
  }
  const receipt = validateClasspilotTileAuthorizationPlanRehearsalReceipt(
    JSON.parse(bytes.toString("utf8")),
    expected
  );
  validateCompanionEvidence(realReceiptPath, receipt);
  inspectOptionalRehearsalTerminal(receipt, sha256(bytes));
  const consumedPath = rehearsalConsumptionPath(
    receipt.applicationGitSha
  );
  if (fs.existsSync(consumedPath)) {
    throw new Error("classpilot_tile_auth_plan_rehearsal_receipt_already_used");
  }
  return {
    schemaVersion: 1,
    version: REHEARSAL_RECEIPT_VERSION,
    receiptSha256: sha256(bytes),
    imageDigest: receipt.imageDigest,
    candidateApiTaskDefinitionArn: receipt.candidateApiTaskDefinitionArn,
    candidateApiTaskDefinitionSha256:
      receipt.candidateApiTaskDefinitionSha256,
    candidateWorkerTaskDefinitionArn: receipt.candidateWorkerTaskDefinitionArn,
    candidateWorkerTaskDefinitionSha256:
      receipt.candidateWorkerTaskDefinitionSha256,
    historyFallbackIdentitySha256: receipt.historyFallbackIdentitySha256,
    queryIdentifierSha256: receipt.queryIdentifierSha256,
    preflightEvidenceSha256: receipt.preflightEvidenceSha256,
    planEventsSha256: receipt.planEventsSha256,
    sanitizedPlanReportSha256: receipt.sanitizedPlanReportSha256,
    lifecycleEvidenceSha256: receipt.lifecycleEvidenceSha256,
  };
}

function parseArguments(argv) {
  const mode = argv[0];
  if (!["admit", "terminal", "write", "inspect", "consume"].includes(mode)) {
    throw new Error("classpilot_tile_auth_plan_rehearsal_arguments_invalid");
  }
  const options = {};
  for (let index = 1; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!name?.startsWith("--") || value === undefined) {
      throw new Error("classpilot_tile_auth_plan_rehearsal_arguments_invalid");
    }
    const key = {
      "--output": "output",
      "--receipt": "receipt",
      "--receipt-sha256": "receiptSha256",
      "--expected-receipt-sha256": "expectedReceiptSha256",
      "--expected-admission-sha256": "expectedAdmissionSha256",
      "--outcome": "outcome",
      "--application-sha": "applicationGitSha",
      "--image-digest": "imageDigest",
      "--candidate-api-task-definition-arn": "candidateApiTaskDefinitionArn",
      "--candidate-api-task-definition-sha256":
        "candidateApiTaskDefinitionSha256",
      "--candidate-worker-task-definition-arn":
        "candidateWorkerTaskDefinitionArn",
      "--candidate-worker-task-definition-sha256":
        "candidateWorkerTaskDefinitionSha256",
      "--active-api-task-definition-arn": "activeApiTaskDefinitionArn",
      "--active-worker-task-definition-arn": "activeWorkerTaskDefinitionArn",
      "--network-configuration-sha256": "networkConfigurationSha256",
    }[name];
    if (!key || Object.hasOwn(options, key)) {
      throw new Error("classpilot_tile_auth_plan_rehearsal_arguments_invalid");
    }
    options[key] = value;
  }
  const common = [
    "applicationGitSha",
    "activeApiTaskDefinitionArn",
    "activeWorkerTaskDefinitionArn",
    "networkConfigurationSha256",
  ];
  let required;
  if (mode === "admit") {
    required = ["applicationGitSha"];
  } else if (mode === "terminal") {
    required = [
      "applicationGitSha",
      "expectedAdmissionSha256",
      "outcome",
    ];
  } else if (mode === "write") {
    required = [
        "output",
        "imageDigest",
        "candidateApiTaskDefinitionArn",
        "candidateApiTaskDefinitionSha256",
        "candidateWorkerTaskDefinitionArn",
        "candidateWorkerTaskDefinitionSha256",
        ...common,
      ];
  } else {
    required = ["receipt", "expectedReceiptSha256", ...common];
  }
  if (required.some((key) => !Object.hasOwn(options, key))) {
    throw new Error("classpilot_tile_auth_plan_rehearsal_arguments_invalid");
  }
  return { mode, options };
}

async function readStdinDocuments() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const input = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
  const separator = input.indexOf(0);
  if (separator < 1 || separator >= input.length - 1) {
    throw new Error("classpilot_tile_auth_plan_rehearsal_arguments_invalid");
  }
  return {
    preflightEventsDocument: JSON.parse(
      input.subarray(0, separator).toString("utf8")
    ),
    planEventsDocument: JSON.parse(
      input.subarray(separator + 1).toString("utf8")
    ),
  };
}

export async function runCli(argv) {
  const { mode, options } = parseArguments(argv);
  if (mode === "admit") {
    return admitClasspilotTileAuthorizationPlanRehearsalAttempt({
      applicationGitSha: options.applicationGitSha,
    });
  }
  if (mode === "terminal") {
    return terminalClasspilotTileAuthorizationPlanRehearsalAttempt({
      applicationGitSha: options.applicationGitSha,
      expectedAdmissionSha256: options.expectedAdmissionSha256,
      outcome: options.outcome,
      receiptPath: options.receipt ?? null,
      receiptSha256: options.receiptSha256 ?? null,
    });
  }
  if (mode === "write") {
    const documents = await readStdinDocuments();
    const receipt = buildClasspilotTileAuthorizationPlanRehearsalReceipt({
      ...options,
      ...documents,
    });
    const preflight =
      validateClasspilotTileAuthorizationPlanPreflightEvidence(
        documents.preflightEventsDocument
      );
    const report = validateClasspilotTileAuthorizationPlanEvidence(
      documents.planEventsDocument
    );
    const lifecycle = extractLifecycle(documents.planEventsDocument);
    const reference = writeClasspilotTileAuthorizationPlanRehearsalReceipt(
      path.resolve(options.output),
      receipt,
      { preflight, report, lifecycle }
    );
    const sealedReceipt = reference.receipt;
    return {
      schemaVersion: 1,
      version: REHEARSAL_RECEIPT_VERSION,
      path: reference.path,
      sha256: reference.sha256,
      expiresAtUtc: sealedReceipt.expiresAtUtc,
      imageDigest: sealedReceipt.imageDigest,
      candidateApiTaskDefinitionArn:
        sealedReceipt.candidateApiTaskDefinitionArn,
      candidateWorkerTaskDefinitionArn:
        sealedReceipt.candidateWorkerTaskDefinitionArn,
      queryIdentifierSha256: sealedReceipt.queryIdentifierSha256,
    };
  }
  const expected = {
    expectedReceiptSha256: options.expectedReceiptSha256,
    expectedApplicationGitSha: options.applicationGitSha,
    expectedActiveApiTaskDefinitionArn: options.activeApiTaskDefinitionArn,
    expectedActiveWorkerTaskDefinitionArn:
      options.activeWorkerTaskDefinitionArn,
    expectedNetworkConfigurationSha256:
      options.networkConfigurationSha256,
  };
  return mode === "inspect"
    ? inspectClasspilotTileAuthorizationPlanRehearsalReceipt(
        options.receipt,
        expected
      )
    : consumeClasspilotTileAuthorizationPlanRehearsalReceipt(
        options.receipt,
        expected
      );
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
    process.stderr.write("classpilot_tile_auth_plan_rehearsal_receipt_failed\n");
    process.exitCode = 1;
  }
}
