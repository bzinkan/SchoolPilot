#!/usr/bin/env node

import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";

const EXPECTED_LABELS = [
  "teacher.live",
  "teacher.history",
  "co_teacher.live",
  "co_teacher.history",
  "office_staff.live",
  "office_staff.history",
];

const TOP_LEVEL_KEYS = [
  "cohortSize",
  "historyFallback",
  "historyFallbackSqlIdentity",
  "precheck",
  "samples",
  "scenarios",
  "status",
  "thresholds",
  "warmups",
];
const PRECHECK_KEYS = ["invalidTeachingSessionSchools"];
const THRESHOLD_KEYS = [
  "heartbeatSequentialScanNodes",
  "maxMs",
  "maxHeartbeatRows",
  "p95Ms",
  "perPairIndexLimit",
  "subPlanNodes",
  "tempReadBlocks",
  "tempWrittenBlocks",
  "windowAggNodes",
];
const SCENARIO_KEYS = [
  "cohortSize",
  "label",
  "maxMs",
  "p95Ms",
  "passed",
  "samples",
  "subPlanNodes",
  "tempReadBlocks",
  "tempWrittenBlocks",
];
const HISTORY_FALLBACK_KEYS = [
  "cohortSize",
  "heartbeatSequentialScanNodes",
  "historyLimit",
  "label",
  "maxMs",
  "maxReturnedRows",
  "p95Ms",
  "passed",
  "perPairIndexLimit",
  "samples",
  "subPlanNodes",
  "tempReadBlocks",
  "tempWrittenBlocks",
  "windowAggNodes",
];
const HISTORY_FALLBACK_SQL_IDENTITY_KEYS = [
  "compiledSqlSha256",
  "engineVersion",
  "parameterTypeSignatureSha256",
  "queryIdentifier",
  "queryIdentifierSha256",
  "schemaIdentitySha256",
  "trackIoTiming",
  "version",
];
const HISTORY_FALLBACK_QUERY_IDENTITY_VERSION = "history-fallback-queryid-v1";
const TRANSACTIONAL_PLAN_SCENARIOS_VERSION =
  "transactional-plan-scenarios-v1";
const TRANSACTIONAL_PLAN_SCENARIOS_KEYS = [
  "residue",
  "rollback",
  "seededRows",
  "version",
];
const TRANSACTIONAL_PLAN_SEEDED_ROWS_KEYS = [
  "groupTeachers",
  "supervisionContexts",
  "supervisionStudents",
  "teachingSessions",
  "total",
];
const TRANSACTIONAL_PLAN_ROLLBACK_KEYS = ["attempted", "completed"];
const TRANSACTIONAL_PLAN_RESIDUE_KEYS = ["checked", "count", "passed"];
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const SIGNED_BIGINT_PATTERN = /^-?(?:0|[1-9]\d*)$/;
const SIGNED_BIGINT_MIN = -(1n << 63n);
const SIGNED_BIGINT_MAX = (1n << 63n) - 1n;

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value, expectedKeys) {
  return isRecord(value) &&
    JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expectedKeys].sort());
}

function isFiniteNonNegativeNumber(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function requireZero(value) {
  return value === 0;
}

function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function isValidSignedNonzeroBigint(value) {
  if (typeof value !== "string" || !SIGNED_BIGINT_PATTERN.test(value)) return false;
  try {
    const parsed = BigInt(value);
    return parsed !== 0n && parsed >= SIGNED_BIGINT_MIN &&
      parsed <= SIGNED_BIGINT_MAX && parsed.toString(10) === value;
  } catch {
    return false;
  }
}

function isSafeEngineVersion(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 128 &&
    !/[\u0000-\u001f\u007f]/.test(value);
}

function parseEvidenceCandidates(eventsDocument) {
  if (!isRecord(eventsDocument) || !Array.isArray(eventsDocument.events)) {
    throw new Error("invalid_events_document");
  }

  const reportCandidates = [];
  const lifecycleCandidates = [];
  for (const event of eventsDocument.events) {
    if (!isRecord(event) || typeof event.message !== "string") continue;
    let parsed;
    try {
      parsed = JSON.parse(event.message.trim());
    } catch {
      continue;
    }
    if (isRecord(parsed) && Object.hasOwn(parsed, "status") &&
        Object.hasOwn(parsed, "thresholds") && Object.hasOwn(parsed, "scenarios")) {
      reportCandidates.push(parsed);
    }
    if (isRecord(parsed) &&
        (parsed.version === TRANSACTIONAL_PLAN_SCENARIOS_VERSION ||
          (Object.hasOwn(parsed, "seededRows") &&
            Object.hasOwn(parsed, "rollback") &&
            Object.hasOwn(parsed, "residue")))) {
      lifecycleCandidates.push(parsed);
    }
  }
  if (reportCandidates.length !== 1) throw new Error("report_count_invalid");
  if (lifecycleCandidates.length !== 1) {
    throw new Error("transactional_plan_scenarios_count_invalid");
  }
  return {
    report: reportCandidates[0],
    lifecycle: lifecycleCandidates[0],
  };
}

function validateTransactionalPlanScenariosLifecycle(lifecycle) {
  if (!hasExactKeys(lifecycle, TRANSACTIONAL_PLAN_SCENARIOS_KEYS) ||
      lifecycle.version !== TRANSACTIONAL_PLAN_SCENARIOS_VERSION ||
      !hasExactKeys(
        lifecycle.seededRows,
        TRANSACTIONAL_PLAN_SEEDED_ROWS_KEYS
      ) ||
      lifecycle.seededRows.groupTeachers !== 1 ||
      lifecycle.seededRows.teachingSessions !== 1 ||
      lifecycle.seededRows.supervisionContexts !== 1 ||
      lifecycle.seededRows.supervisionStudents !== 40 ||
      lifecycle.seededRows.total !== 43 ||
      !hasExactKeys(lifecycle.rollback, TRANSACTIONAL_PLAN_ROLLBACK_KEYS) ||
      lifecycle.rollback.attempted !== true ||
      lifecycle.rollback.completed !== true ||
      !hasExactKeys(lifecycle.residue, TRANSACTIONAL_PLAN_RESIDUE_KEYS) ||
      lifecycle.residue.checked !== true ||
      lifecycle.residue.count !== 0 ||
      lifecycle.residue.passed !== true) {
    throw new Error("transactional_plan_scenarios_contract_invalid");
  }
}

export function validateClasspilotTileAuthorizationPlanEvidence(eventsDocument) {
  const { report, lifecycle } = parseEvidenceCandidates(eventsDocument);
  validateTransactionalPlanScenariosLifecycle(lifecycle);
  if (!hasExactKeys(report, TOP_LEVEL_KEYS) || report.status !== "passed" ||
      report.samples !== 20 || report.warmups !== 2 || report.cohortSize !== 40) {
    throw new Error("report_contract_invalid");
  }
  if (!hasExactKeys(report.precheck, PRECHECK_KEYS) ||
      report.precheck.invalidTeachingSessionSchools !== 0) {
    throw new Error("precheck_invalid");
  }
  if (!hasExactKeys(report.thresholds, THRESHOLD_KEYS) ||
      report.thresholds.p95Ms !== 50 || report.thresholds.maxMs !== 100 ||
      !requireZero(report.thresholds.tempReadBlocks) ||
      !requireZero(report.thresholds.tempWrittenBlocks) ||
      !requireZero(report.thresholds.subPlanNodes) ||
      !requireZero(report.thresholds.windowAggNodes) ||
      !requireZero(report.thresholds.heartbeatSequentialScanNodes) ||
      report.thresholds.maxHeartbeatRows !== 400 ||
      report.thresholds.perPairIndexLimit !== true) {
    throw new Error("threshold_contract_invalid");
  }
  if (!Array.isArray(report.scenarios) || report.scenarios.length !== EXPECTED_LABELS.length) {
    throw new Error("scenario_count_invalid");
  }

  const labels = new Set();
  for (const scenario of report.scenarios) {
    if (!hasExactKeys(scenario, SCENARIO_KEYS) ||
        !EXPECTED_LABELS.includes(scenario.label) || labels.has(scenario.label) ||
        scenario.cohortSize !== 40 || scenario.samples !== 20 || scenario.passed !== true ||
        !isFiniteNonNegativeNumber(scenario.p95Ms) || scenario.p95Ms > 50 ||
        !isFiniteNonNegativeNumber(scenario.maxMs) || scenario.maxMs > 100 ||
        scenario.maxMs < scenario.p95Ms ||
        !requireZero(scenario.tempReadBlocks) ||
        !requireZero(scenario.tempWrittenBlocks) ||
        !requireZero(scenario.subPlanNodes)) {
      throw new Error("scenario_contract_invalid");
    }
    labels.add(scenario.label);
  }
  if (EXPECTED_LABELS.some((label) => !labels.has(label))) {
    throw new Error("scenario_labels_invalid");
  }

  const historyFallback = report.historyFallback;
  if (!hasExactKeys(historyFallback, HISTORY_FALLBACK_KEYS) ||
      historyFallback.label !== "history_fallback" ||
      historyFallback.cohortSize !== 40 || historyFallback.historyLimit !== 10 ||
      historyFallback.samples !== 20 || historyFallback.passed !== true ||
      !isFiniteNonNegativeNumber(historyFallback.p95Ms) || historyFallback.p95Ms > 50 ||
      !isFiniteNonNegativeNumber(historyFallback.maxMs) || historyFallback.maxMs > 100 ||
      historyFallback.maxMs < historyFallback.p95Ms ||
      !requireZero(historyFallback.tempReadBlocks) ||
      !requireZero(historyFallback.tempWrittenBlocks) ||
      !requireZero(historyFallback.subPlanNodes) ||
      !requireZero(historyFallback.windowAggNodes) ||
      !requireZero(historyFallback.heartbeatSequentialScanNodes) ||
      !isFiniteNonNegativeNumber(historyFallback.maxReturnedRows) ||
      !Number.isInteger(historyFallback.maxReturnedRows) ||
      historyFallback.maxReturnedRows > 400 ||
      historyFallback.perPairIndexLimit !== true) {
    throw new Error("history_fallback_contract_invalid");
  }

  const historyFallbackSqlIdentity = report.historyFallbackSqlIdentity;
  if (!hasExactKeys(
        historyFallbackSqlIdentity,
        HISTORY_FALLBACK_SQL_IDENTITY_KEYS
      ) ||
      historyFallbackSqlIdentity.version !== HISTORY_FALLBACK_QUERY_IDENTITY_VERSION ||
      !isValidSignedNonzeroBigint(historyFallbackSqlIdentity.queryIdentifier) ||
      !SHA256_PATTERN.test(historyFallbackSqlIdentity.queryIdentifierSha256) ||
      historyFallbackSqlIdentity.queryIdentifierSha256 !==
        sha256(historyFallbackSqlIdentity.queryIdentifier) ||
      !SHA256_PATTERN.test(historyFallbackSqlIdentity.compiledSqlSha256) ||
      !SHA256_PATTERN.test(
        historyFallbackSqlIdentity.parameterTypeSignatureSha256
      ) ||
      !isSafeEngineVersion(historyFallbackSqlIdentity.engineVersion) ||
      !SHA256_PATTERN.test(historyFallbackSqlIdentity.schemaIdentitySha256) ||
      historyFallbackSqlIdentity.trackIoTiming !== true) {
    throw new Error("history_fallback_sql_identity_invalid");
  }

  // Rebuild the record from the reviewed aggregate-only schema. This keeps
  // task/log metadata and any unexpected fields out of deploy output.
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
      windowAggNodes: 0,
      heartbeatSequentialScanNodes: 0,
      maxHeartbeatRows: 400,
      perPairIndexLimit: true,
    },
    scenarios: EXPECTED_LABELS.map((label) => {
      const scenario = report.scenarios.find((candidate) => candidate.label === label);
      return {
        label,
        cohortSize: 40,
        samples: 20,
        p95Ms: scenario.p95Ms,
        maxMs: scenario.maxMs,
        tempReadBlocks: 0,
        tempWrittenBlocks: 0,
        subPlanNodes: 0,
        passed: true,
      };
    }),
    historyFallback: {
      label: "history_fallback",
      cohortSize: 40,
      historyLimit: 10,
      samples: 20,
      p95Ms: historyFallback.p95Ms,
      maxMs: historyFallback.maxMs,
      tempReadBlocks: 0,
      tempWrittenBlocks: 0,
      subPlanNodes: 0,
      windowAggNodes: 0,
      heartbeatSequentialScanNodes: 0,
      maxReturnedRows: historyFallback.maxReturnedRows,
      perPairIndexLimit: true,
      passed: true,
    },
    historyFallbackSqlIdentity: {
      version: HISTORY_FALLBACK_QUERY_IDENTITY_VERSION,
      queryIdentifierSha256:
        historyFallbackSqlIdentity.queryIdentifierSha256,
      compiledSqlSha256: historyFallbackSqlIdentity.compiledSqlSha256,
      parameterTypeSignatureSha256:
        historyFallbackSqlIdentity.parameterTypeSignatureSha256,
      engineVersion: historyFallbackSqlIdentity.engineVersion,
      schemaIdentitySha256: historyFallbackSqlIdentity.schemaIdentitySha256,
      trackIoTiming: true,
    },
  };
}

export function extractClasspilotTileAuthorizationPlanIdentity(eventsDocument) {
  const { report } = parseEvidenceCandidates(eventsDocument);
  // Full validation is intentionally mandatory before releasing the raw query
  // identifier to the access-controlled receipt writer.
  validateClasspilotTileAuthorizationPlanEvidence(eventsDocument);
  const identity = report.historyFallbackSqlIdentity;
  return {
    version: identity.version,
    queryIdentifier: identity.queryIdentifier,
    queryIdentifierSha256: identity.queryIdentifierSha256,
    compiledSqlSha256: identity.compiledSqlSha256,
    parameterTypeSignatureSha256: identity.parameterTypeSignatureSha256,
    engineVersion: identity.engineVersion,
    schemaIdentitySha256: identity.schemaIdentitySha256,
    trackIoTiming: identity.trackIoTiming,
  };
}

async function readStdin() {
  let input = "";
  for await (const chunk of process.stdin) input += chunk;
  return input;
}

const invokedPath = process.argv[1];
if (invokedPath && import.meta.url === pathToFileURL(invokedPath).href) {
  try {
    const input = await readStdin();
    const evidence = validateClasspilotTileAuthorizationPlanEvidence(JSON.parse(input));
    process.stdout.write(`${JSON.stringify(evidence)}\n`);
  } catch {
    process.stderr.write("classpilot_tile_authorization_plan_evidence_invalid\n");
    process.exitCode = 1;
  }
}
