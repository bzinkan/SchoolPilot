#!/usr/bin/env node

import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export const REVIEWED_RLS_TABLE_ENABLEMENTS = Object.freeze([
  "classpilot_session_summary_deliveries",
  "classpilot_monitoring_events",
  "classpilot_session_reports",
  "classpilot_session_staff",
  "classpilot_session_student_reports",
  "classpilot_student_control_states",
  "classpilot_chat_deliveries",
  "poll_responses",
  "polls",
  "session_settings",
  "passpilot_grade_students",
  "authorized_pickups",
  "custody_alerts",
  "dismissal_changes",
  "dismissal_overrides",
  "dismissal_queue",
  "family_group_students",
  "homeroom_teachers",
  "classpilot_schedule_change_pairs",
  "classpilot_schedule_changes",
  "classpilot_schedule_change_legs",
  "passpilot_kiosk_sessions",
]);

export const GOPILOT_CHILD_RLS_TABLES = Object.freeze([
  "authorized_pickups",
  "custody_alerts",
  "dismissal_changes",
  "dismissal_overrides",
  "dismissal_queue",
  "family_group_students",
  "homeroom_teachers",
]);

export const CLASSPILOT_SCHEDULE_CHANGE_RLS_TABLES = Object.freeze([
  "classpilot_schedule_change_pairs",
  "classpilot_schedule_changes",
  "classpilot_schedule_change_legs",
]);

export const CLASSPILOT_FAB_RLS_TABLES = Object.freeze([
  "classpilot_chat_deliveries",
  "poll_responses",
  "polls",
  "session_settings",
]);

const REVIEWED_RLS_ENABLEMENT_REQUESTS = Object.freeze([
  Object.freeze(["classpilot_session_summary_deliveries"]),
  Object.freeze(["passpilot_grade_students"]),
  Object.freeze([
    "classpilot_monitoring_events",
    "classpilot_session_reports",
    "classpilot_session_staff",
    "classpilot_session_student_reports",
    "classpilot_student_control_states",
  ]),
  CLASSPILOT_FAB_RLS_TABLES,
  GOPILOT_CHILD_RLS_TABLES,
  CLASSPILOT_SCHEDULE_CHANGE_RLS_TABLES,
  Object.freeze(["passpilot_kiosk_sessions"]),
]);

function parseAllowlist(raw) {
  if (typeof raw !== "string" || raw.trim() === "") {
    throw new Error("RLS_ENABLED_TABLES must be a non-empty comma-separated allowlist");
  }
  const tables = raw.split(",").map((value) => value.trim());
  if (tables.some((value) => !/^[a-z][a-z0-9_]*$/.test(value))) {
    throw new Error("RLS_ENABLED_TABLES contains an empty or malformed table name");
  }
  if (new Set(tables).size !== tables.length) {
    throw new Error("RLS_ENABLED_TABLES contains duplicate table names");
  }
  return tables;
}

function singleEnvironmentEntry(container, name) {
  const environment = Array.isArray(container.environment)
    ? container.environment
    : [];
  const matches = environment.filter((entry) => entry?.name === name);
  if (matches.length !== 1) {
    throw new Error(
      `${container.name} environment must contain exactly one ${name} entry; found ${matches.length}`
    );
  }
  if ((container.secrets || []).some((entry) => entry?.name === name)) {
    throw new Error(`${name} must be inspectable and must not also be a secret`);
  }
  return matches[0];
}

function inspectedRlsEnvironment(taskDefinition, containerName) {
  const containers = (taskDefinition?.containerDefinitions || []).filter(
    (container) => container?.name === containerName
  );
  if (containers.length !== 1) {
    throw new Error(
      `Task definition must contain exactly one ${containerName} container; found ${containers.length}`
    );
  }
  const container = containers[0];
  const gucEntry = singleEnvironmentEntry(container, "RLS_GUC_ENABLED");
  if (gucEntry.value !== "true" && gucEntry.value !== "false") {
    throw new Error("RLS_GUC_ENABLED must be exactly true or false");
  }
  const allowlistEntry = singleEnvironmentEntry(container, "RLS_ENABLED_TABLES");
  return {
    container,
    gucEnabled: gucEntry.value,
    allowlistEntry,
    tables: parseAllowlist(allowlistEntry.value),
  };
}

function requestedTables(table) {
  const tables = Array.isArray(table)
    ? table
    : String(table ?? "").split(",").map((value) => value.trim()).filter(Boolean);
  if (tables.length === 0 || new Set(tables).size !== tables.length) {
    throw new Error("RLS table enablement must contain a non-empty, unique reviewed table list");
  }
  for (const requested of tables) {
    if (!REVIEWED_RLS_TABLE_ENABLEMENTS.includes(requested)) {
      throw new Error(`RLS table enablement is not reviewed for: ${requested}`);
    }
  }
  const serialized = JSON.stringify(tables);
  if (!REVIEWED_RLS_ENABLEMENT_REQUESTS.some((request) => JSON.stringify(request) === serialized)) {
    throw new Error(
      `RLS table enablement must match one exact reviewed singleton or ordered bundle: ${tables.join(",")}`
    );
  }
  return tables;
}

export function verifyLiveRlsEnablementSources({
  apiTaskDefinition,
  workerTaskDefinition,
  table,
}) {
  const additions = requestedTables(table);
  const api = inspectedRlsEnvironment(apiTaskDefinition, "api");
  const worker = inspectedRlsEnvironment(workerTaskDefinition, "scheduler-worker");
  if (api.gucEnabled !== "true" || worker.gucEnabled !== "true") {
    throw new Error(
      "Explicit table enablement requires RLS_GUC_ENABLED=true on both live services"
    );
  }
  const apiSet = [...api.tables].sort();
  const workerSet = [...worker.tables].sort();
  if (JSON.stringify(apiSet) !== JSON.stringify(workerSet)) {
    throw new Error("Live API and scheduler-worker RLS allowlists must match exactly");
  }
  const alreadyEnabled = additions.filter((requested) => api.tables.includes(requested));
  if (alreadyEnabled.length > 0) {
    throw new Error(
      `${alreadyEnabled.join(",")} is already enabled; omit the one-time --enable-rls-table flag`
    );
  }
  return additions.length === 1
    ? { previousTables: api.tables, addedTable: additions[0] }
    : { previousTables: api.tables, addedTables: additions };
}

export function addReviewedRlsTable(taskDefinition, { containerName, table }) {
  const additions = requestedTables(table);
  const inspected = inspectedRlsEnvironment(taskDefinition, containerName);
  if (inspected.gucEnabled !== "true") {
    throw new Error("Explicit table enablement requires RLS_GUC_ENABLED=true");
  }
  const alreadyEnabled = additions.filter((requested) => inspected.tables.includes(requested));
  if (alreadyEnabled.length > 0) {
    throw new Error(`${alreadyEnabled.join(",")} is already present in ${containerName} RLS_ENABLED_TABLES`);
  }
  inspected.allowlistEntry.value = [...inspected.tables, ...additions].join(",");
  return taskDefinition;
}

export function verifyEnabledRlsCandidates({
  taskDefinitions,
  table,
  expectedPreviousTables,
}) {
  const additions = requestedTables(table);
  const inspected = taskDefinitions.map(({ taskDefinition, containerName }) => ({
    containerName,
    ...inspectedRlsEnvironment(taskDefinition, containerName),
  }));
  for (const candidate of inspected) {
    if (
      candidate.gucEnabled !== "true" ||
      additions.some((requested) => !candidate.tables.includes(requested))
    ) {
      throw new Error(
        `${candidate.containerName} does not enforce every explicitly enabled RLS table: ${additions.join(",")}`
      );
    }
  }
  const expectedTables = expectedPreviousTables
    ? [...expectedPreviousTables, ...additions]
    : inspected[0].tables;
  const expected = JSON.stringify([...expectedTables].sort());
  if (inspected.some((candidate) => JSON.stringify([...candidate.tables].sort()) !== expected)) {
    throw new Error("Rendered RLS allowlists drifted between deployment candidates");
  }
}

function argumentValue(args, name) {
  const index = args.indexOf(name);
  if (index < 0 || index + 1 >= args.length) {
    throw new Error(`${name} is required`);
  }
  return args[index + 1];
}

function main() {
  const [mode, ...args] = process.argv.slice(2);
  const table = argumentValue(args, "--table");
  if (mode === "add") {
    const path = argumentValue(args, "--task-definition");
    const containerName = argumentValue(args, "--container");
    const taskDefinition = JSON.parse(readFileSync(path, "utf8"));
    addReviewedRlsTable(taskDefinition, { containerName, table });
    writeFileSync(path, JSON.stringify(taskDefinition));
    return;
  }
  if (mode === "preflight") {
    const apiTaskDefinition = JSON.parse(
      readFileSync(argumentValue(args, "--api-task-definition"), "utf8")
    );
    const workerTaskDefinition = JSON.parse(
      readFileSync(argumentValue(args, "--worker-task-definition"), "utf8")
    );
    const result = verifyLiveRlsEnablementSources({
      apiTaskDefinition,
      workerTaskDefinition,
      table,
    });
    process.stdout.write(
      JSON.stringify({
        addedTable: result.addedTable,
        addedTables: result.addedTables,
        previousCount: result.previousTables.length,
      })
    );
    return;
  }
  if (mode === "verify-candidates") {
    const source = verifyLiveRlsEnablementSources({
      apiTaskDefinition: JSON.parse(
        readFileSync(argumentValue(args, "--api-source-task-definition"), "utf8")
      ),
      workerTaskDefinition: JSON.parse(
        readFileSync(argumentValue(args, "--worker-source-task-definition"), "utf8")
      ),
      table,
    });
    verifyEnabledRlsCandidates({
      taskDefinitions: [
        {
          taskDefinition: JSON.parse(
            readFileSync(argumentValue(args, "--api-task-definition"), "utf8")
          ),
          containerName: "api",
        },
        {
          taskDefinition: JSON.parse(
            readFileSync(argumentValue(args, "--emergency-task-definition"), "utf8")
          ),
          containerName: "api",
        },
        {
          taskDefinition: JSON.parse(
            readFileSync(argumentValue(args, "--worker-task-definition"), "utf8")
          ),
          containerName: "scheduler-worker",
        },
      ],
      table,
      expectedPreviousTables: source.previousTables,
    });
    return;
  }
  throw new Error("Expected add, preflight, or verify-candidates mode");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
