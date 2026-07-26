#!/usr/bin/env node

import { pathToFileURL } from "node:url";

const VERSION = "classpilot-tile-auth-plan-base-selection-v1";
const INVALID =
  "classpilot_tile_authorization_plan_base_selection_invalid";
const EXACT_KEYS = [
  "canonicalPrimaryOnlyGroups",
  "cohortSize",
  "eligibleSchools",
  "exactCohortGroups",
  "finalBases",
  "version",
];

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value, expectedKeys) {
  return (
    isRecord(value) &&
    JSON.stringify(Object.keys(value).sort()) ===
      JSON.stringify([...expectedKeys].sort())
  );
}

function reject() {
  throw new Error(INVALID);
}

export function validateClasspilotTileAuthorizationPlanBaseSelectionEvidence(
  value
) {
  if (
    !hasExactKeys(value, EXACT_KEYS) ||
    value.version !== VERSION ||
    value.cohortSize !== 40 ||
    value.canonicalPrimaryOnlyGroups !== 19 ||
    value.exactCohortGroups !== 19 ||
    value.eligibleSchools !== 1 ||
    value.finalBases !== 1
  ) {
    reject();
  }
  return Object.fromEntries(EXACT_KEYS.map((key) => [key, value[key]]));
}

export function extractClasspilotTileAuthorizationPlanBaseSelectionEvidence(
  eventsDocument
) {
  const events = Array.isArray(eventsDocument?.events)
    ? eventsDocument.events
    : [];
  const matches = [];
  for (const event of events) {
    if (!isRecord(event) || typeof event.message !== "string") continue;
    let message;
    try {
      message = JSON.parse(event.message);
    } catch {
      continue;
    }
    if (isRecord(message) && message.version === VERSION) {
      matches.push(message);
    }
  }
  if (matches.length !== 1) reject();
  return validateClasspilotTileAuthorizationPlanBaseSelectionEvidence(
    matches[0]
  );
}

async function readStdin() {
  let input = "";
  for await (const chunk of process.stdin) input += chunk;
  return input;
}

const invokedPath = process.argv[1];
if (invokedPath && import.meta.url === pathToFileURL(invokedPath).href) {
  try {
    const evidence =
      extractClasspilotTileAuthorizationPlanBaseSelectionEvidence(
        JSON.parse(await readStdin())
      );
    process.stdout.write(`${JSON.stringify(evidence)}\n`);
  } catch {
    process.stderr.write(`${INVALID}\n`);
    process.exitCode = 1;
  }
}
