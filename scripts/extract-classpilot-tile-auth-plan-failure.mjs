#!/usr/bin/env node

import { pathToFileURL } from "node:url";

const ALLOWED_FAILURE_CODES = new Set([
  "base_funnel_evidence_invalid",
  "database_operation_failed",
  "execute_required",
  "history_fallback_query_identity_invalid",
  "invalid_arguments",
  "invalid_configuration",
  "invalid_explain_document",
  "plan_threshold_failed",
  "representative_scenario_missing",
  "teaching_session_school_integrity_failed",
  "transactional_scenario_lifecycle_failed",
]);

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function extractClasspilotTileAuthorizationPlanFailure(eventsDocument) {
  const events = Array.isArray(eventsDocument?.events) ? eventsDocument.events : [];
  const failures = [];
  for (const event of events) {
    if (!isRecord(event) || typeof event.message !== "string") continue;
    let message;
    try {
      message = JSON.parse(event.message);
    } catch {
      continue;
    }
    if (
      !isRecord(message) ||
      message.status !== "failed" ||
      typeof message.failureCode !== "string" ||
      !ALLOWED_FAILURE_CODES.has(message.failureCode)
    ) {
      continue;
    }
    failures.push(message.failureCode);
  }
  if (failures.length !== 1) {
    throw new Error("classpilot_tile_authorization_plan_failure_invalid");
  }
  return failures[0];
}

async function readStdin() {
  let input = "";
  for await (const chunk of process.stdin) input += chunk;
  return input;
}

const invokedPath = process.argv[1];
if (invokedPath && import.meta.url === pathToFileURL(invokedPath).href) {
  try {
    const failureCode = extractClasspilotTileAuthorizationPlanFailure(
      JSON.parse(await readStdin())
    );
    process.stdout.write(`${failureCode}\n`);
  } catch {
    process.stderr.write("classpilot_tile_authorization_plan_failure_invalid\n");
    process.exitCode = 1;
  }
}
