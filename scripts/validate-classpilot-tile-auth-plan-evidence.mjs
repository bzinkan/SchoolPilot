#!/usr/bin/env node

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
  "precheck",
  "samples",
  "scenarios",
  "status",
  "thresholds",
  "warmups",
];
const PRECHECK_KEYS = ["invalidTeachingSessionSchools"];
const THRESHOLD_KEYS = [
  "maxMs",
  "p95Ms",
  "subPlanNodes",
  "tempReadBlocks",
  "tempWrittenBlocks",
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

function parseReportCandidates(eventsDocument) {
  if (!isRecord(eventsDocument) || !Array.isArray(eventsDocument.events)) {
    throw new Error("invalid_events_document");
  }

  const candidates = [];
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
      candidates.push(parsed);
    }
  }
  if (candidates.length !== 1) throw new Error("report_count_invalid");
  return candidates[0];
}

export function validateClasspilotTileAuthorizationPlanEvidence(eventsDocument) {
  const report = parseReportCandidates(eventsDocument);
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
      !requireZero(report.thresholds.subPlanNodes)) {
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
