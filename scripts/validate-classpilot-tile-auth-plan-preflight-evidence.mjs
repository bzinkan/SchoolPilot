#!/usr/bin/env node

import { pathToFileURL } from "node:url";

const VERSION = "classpilot-tile-auth-plan-base-preflight-v1";
const EXACT_KEYS = [
  "conflictingSessionPairs",
  "eligibleBases",
  "missingSessionPairs",
  "requiredSessionPairs",
  "reusedActiveSessionPairs",
  "status",
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

export function validateClasspilotTileAuthorizationPlanPreflightEvidence(
  eventsDocument
) {
  const events = Array.isArray(eventsDocument?.events) ? eventsDocument.events : [];
  const matches = [];
  for (const event of events) {
    if (!isRecord(event) || typeof event.message !== "string") continue;
    let message;
    try {
      message = JSON.parse(event.message);
    } catch {
      continue;
    }
    if (isRecord(message) && message.version === VERSION) matches.push(message);
  }
  if (matches.length !== 1 || !hasExactKeys(matches[0], EXACT_KEYS)) {
    throw new Error("classpilot_tile_authorization_plan_preflight_invalid");
  }
  const evidence = matches[0];
  for (const key of [
    "eligibleBases",
    "requiredSessionPairs",
    "reusedActiveSessionPairs",
    "missingSessionPairs",
    "conflictingSessionPairs",
  ]) {
    if (!Number.isInteger(evidence[key]) || evidence[key] < 0) {
      throw new Error("classpilot_tile_authorization_plan_preflight_invalid");
    }
  }
  if (
    evidence.status !== "passed" ||
    evidence.eligibleBases !== 1 ||
    evidence.requiredSessionPairs !== 80 ||
    evidence.reusedActiveSessionPairs > 80 ||
    evidence.missingSessionPairs > 80 ||
    evidence.reusedActiveSessionPairs + evidence.missingSessionPairs !== 80 ||
    evidence.conflictingSessionPairs !== 0
  ) {
    throw new Error("classpilot_tile_authorization_plan_preflight_invalid");
  }
  return Object.fromEntries(EXACT_KEYS.map((key) => [key, evidence[key]]));
}

async function readStdin() {
  let input = "";
  for await (const chunk of process.stdin) input += chunk;
  return input;
}

const invokedPath = process.argv[1];
if (invokedPath && import.meta.url === pathToFileURL(invokedPath).href) {
  try {
    const evidence = validateClasspilotTileAuthorizationPlanPreflightEvidence(
      JSON.parse(await readStdin())
    );
    process.stdout.write(`${JSON.stringify(evidence)}\n`);
  } catch {
    process.stderr.write(
      "classpilot_tile_authorization_plan_preflight_invalid\n"
    );
    process.exitCode = 1;
  }
}
