#!/usr/bin/env node

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

import {
  extractClasspilotTileAuthorizationPlanFailure,
} from "./extract-classpilot-tile-auth-plan-failure.mjs";
import {
  collectClasspilotTileAuthorizationPlanLogEvents,
} from "./read-classpilot-tile-auth-plan-log-events.mjs";
import {
  extractClasspilotTileAuthorizationPlanBaseFunnelEvidence,
} from "./validate-classpilot-tile-auth-plan-base-funnel-evidence.mjs";
import {
  extractClasspilotTileAuthorizationPlanBaseSelectionEvidence,
} from "./validate-classpilot-tile-auth-plan-base-selection-evidence.mjs";
import {
  validateClasspilotTileAuthorizationPlanPreflightEvidence,
} from "./validate-classpilot-tile-auth-plan-preflight-evidence.mjs";
export const OBSERVATION_COLLECTION_VERSION =
  "classpilot-tile-auth-plan-observation-collection-v1";

const SAFE_LOG_GROUP = /^[A-Za-z0-9_.\-/#]+$/;
const SAFE_LOG_STREAM = /^[A-Za-z0-9_.\-/#]+$/;
const SAFE_REGION = /^[a-z]{2}-[a-z]+-\d$/;
const SAFE_ACCOUNT_ID = /^\d{12}$/;
const SAFE_TASK_ARN =
  /^arn:aws:ecs:[a-z]{2}-[a-z]+-\d:\d{12}:task\/(?:[A-Za-z0-9_-]+\/)?[a-f0-9]{32}$/;
const SAFE_TASK_DEFINITION_ARN =
  /^arn:aws:ecs:[a-z]{2}-[a-z]+-\d:\d{12}:task-definition\/[A-Za-z0-9_-]+:[1-9]\d*$/;
const MAX_PAGES = 100;
const MAX_EVENTS = 10_000;
const DEFAULT_DEADLINE_MS = 300_000;
const MAX_PAGE_TIMEOUT_MS = 30_000;
const RETRY_DELAYS_MS = [0, 1_000, 2_000, 4_000];
const STEADY_RETRY_DELAY_MS = 5_000;

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
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

export function hashClasspilotTileAuthorizationPlanObservationEvents(
  eventsDocument
) {
  return createHash("sha256")
    .update(JSON.stringify(stableValue(eventsDocument)), "utf8")
    .digest("hex");
}

function completedAtUtc() {
  return new Date().toISOString();
}

function completedCollection(attemptCount, eventsDocument) {
  return {
    collection: {
      status: "completed",
      attemptCount,
      completedAtUtc: completedAtUtc(),
      failureCode: null,
      canonicalEventSha256:
        hashClasspilotTileAuthorizationPlanObservationEvents(eventsDocument),
      logStreamSha256: null,
      rawErrorPersisted: false,
    },
    eventsDocument,
  };
}

export function failedClasspilotTileAuthorizationPlanObservationCollection(
  attemptCount,
  failureCode
) {
  return {
    collection: {
      status: "failed",
      attemptCount,
      completedAtUtc: completedAtUtc(),
      failureCode,
      canonicalEventSha256: null,
      logStreamSha256: null,
      rawErrorPersisted: false,
    },
    eventsDocument: null,
  };
}

function validateCompletedSnapshot(eventsDocument, taskExitCode) {
  if (taskExitCode === 0) {
    validateClasspilotTileAuthorizationPlanPreflightEvidence(eventsDocument);
    extractClasspilotTileAuthorizationPlanBaseSelectionEvidence(eventsDocument);
    return;
  }

  const failureCode =
    extractClasspilotTileAuthorizationPlanFailure(eventsDocument);
  if (taskExitCode === 1) {
    if (failureCode !== "representative_scenario_missing") {
      throw new Error("observation_failure_event_invalid");
    }
    extractClasspilotTileAuthorizationPlanBaseFunnelEvidence(eventsDocument);
  }
}

function defaultSleep(delayMs) {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

function nextRetryDelay(attemptCount) {
  return (
    RETRY_DELAYS_MS[attemptCount] ??
    STEADY_RETRY_DELAY_MS
  );
}

export async function collectClasspilotTileAuthorizationPlanObservationEvidence({
  taskExitCode,
  fetchFreshSnapshot,
  deadlineMs = DEFAULT_DEADLINE_MS,
  nowNanoseconds = () => process.hrtime.bigint(),
  sleep = defaultSleep,
}) {
  if (
    !Number.isInteger(taskExitCode) ||
    taskExitCode < 0 ||
    taskExitCode > 255 ||
    typeof fetchFreshSnapshot !== "function" ||
    !Number.isSafeInteger(deadlineMs) ||
    deadlineMs < 1 ||
    typeof nowNanoseconds !== "function" ||
    typeof sleep !== "function"
  ) {
    throw new Error("observation_collection_configuration_invalid");
  }

  const deadline = nowNanoseconds() + BigInt(deadlineMs) * 1_000_000n;
  return collectUntilDeadline({
    taskExitCode,
    fetchFreshSnapshot,
    deadlineNanoseconds: deadline,
    nowNanoseconds,
    sleep,
  });
}

async function collectUntilDeadline({
  taskExitCode,
  fetchFreshSnapshot,
  deadlineNanoseconds,
  nowNanoseconds,
  sleep,
}) {
  let attemptCount = 0;

  while (nowNanoseconds() < deadlineNanoseconds) {
    const delayMs = nextRetryDelay(attemptCount);
    if (delayMs > 0) {
      const remainingBeforeDelay = Number(
        (deadlineNanoseconds - nowNanoseconds()) / 1_000_000n
      );
      if (remainingBeforeDelay <= delayMs) break;
      await sleep(delayMs);
      if (nowNanoseconds() >= deadlineNanoseconds) break;
    }

    const remainingMs = Number(
      (deadlineNanoseconds - nowNanoseconds()) / 1_000_000n
    );
    if (remainingMs < 1) break;

    // Count an attempt only once the fresh snapshot reader is about to be
    // invoked. A deadline crossing between the loop guard and the remaining
    // time check must remain a zero-read collector-start failure.
    attemptCount += 1;
    try {
      const eventsDocument = await fetchFreshSnapshot({
        remainingMs,
        attemptCount,
      });
      validateCompletedSnapshot(eventsDocument, taskExitCode);
      return completedCollection(attemptCount, eventsDocument);
    } catch {
      // Collection failures are intentionally reduced to one allowlisted
      // terminal code. Raw provider, payload, and validation errors are never
      // retained in the observation packet.
    }
  }

  return failedClasspilotTileAuthorizationPlanObservationCollection(
    attemptCount,
    "log_evidence_unavailable"
  );
}

function parseArguments(argv) {
  const options = {};
  const allowed = new Set([
    "--task-result-file",
    "--log-configuration-file",
    "--expected-task-arn",
    "--expected-task-definition-arn",
    "--expected-region",
    "--expected-account-id",
    "--deadline-ms",
  ]);
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (
      !allowed.has(name) ||
      value === undefined ||
      Object.hasOwn(options, name)
    ) {
      throw new Error("observation_collection_arguments_invalid");
    }
    options[name] = value;
  }
  if (
    typeof options["--task-result-file"] !== "string" ||
    options["--task-result-file"].length === 0 ||
    options["--task-result-file"].length > 4096 ||
    typeof options["--log-configuration-file"] !== "string" ||
    options["--log-configuration-file"].length === 0 ||
    options["--log-configuration-file"].length > 4096 ||
    !SAFE_TASK_ARN.test(options["--expected-task-arn"] || "") ||
    !SAFE_TASK_DEFINITION_ARN.test(
      options["--expected-task-definition-arn"] || ""
    ) ||
    !SAFE_REGION.test(options["--expected-region"] || "") ||
    !SAFE_ACCOUNT_ID.test(options["--expected-account-id"] || "")
  ) {
    throw new Error("observation_collection_arguments_invalid");
  }
  if (
    options["--deadline-ms"] !== undefined &&
    !/^[1-9][0-9]{0,8}$/.test(options["--deadline-ms"])
  ) {
    throw new Error("observation_collection_arguments_invalid");
  }
  return {
    taskResultFile: options["--task-result-file"],
    logConfigurationFile: options["--log-configuration-file"],
    expectedTaskArn: options["--expected-task-arn"],
    expectedTaskDefinitionArn:
      options["--expected-task-definition-arn"],
    expectedRegion: options["--expected-region"],
    expectedAccountId: options["--expected-account-id"],
    deadlineMs:
      options["--deadline-ms"] === undefined
        ? DEFAULT_DEADLINE_MS
        : Number(options["--deadline-ms"]),
  };
}

function fetchAwsPage(
  { logGroupName, logStreamName, region },
  nextToken,
  remainingMilliseconds
) {
  if (
    !Number.isSafeInteger(remainingMilliseconds) ||
    remainingMilliseconds < 1
  ) {
    throw new Error("aws_log_page_deadline_elapsed");
  }
  const processTimeoutMs = Math.max(
    1,
    Math.min(MAX_PAGE_TIMEOUT_MS, remainingMilliseconds)
  );
  const cliTimeoutSeconds = Math.max(
    1,
    Math.floor(processTimeoutMs / 1_000)
  );
  const args = [
    "logs",
    "get-log-events",
    "--log-group-name",
    logGroupName,
    "--log-stream-name",
    logStreamName,
    "--start-from-head",
    "--limit",
    "1000",
    "--output",
    "json",
    "--region",
    region,
    "--no-paginate",
    "--no-cli-pager",
    "--cli-connect-timeout",
    String(cliTimeoutSeconds),
    "--cli-read-timeout",
    String(cliTimeoutSeconds),
  ];
  if (nextToken !== undefined) args.push("--next-token", nextToken);

  const result = spawnSync(process.env.AWS_CLI_EXECUTABLE || "aws", args, {
    encoding: "utf8",
    env: {
      ...process.env,
      MSYS_NO_PATHCONV: "1",
      MSYS2_ARG_CONV_EXCL: "*",
    },
    windowsHide: true,
    timeout: processTimeoutMs,
    maxBuffer: 4 * 1024 * 1024,
  });
  if (result.error || result.status !== 0 || result.signal || !result.stdout) {
    throw new Error("aws_log_page_unavailable");
  }
  return JSON.parse(result.stdout);
}

function awsFreshSnapshotFetcher(binding, deadlineNanoseconds) {
  return async () =>
    collectClasspilotTileAuthorizationPlanLogEvents({
      maxPages: MAX_PAGES,
      maxEvents: MAX_EVENTS,
      fetchPage: (nextToken) => {
        const remainingMs = Number(
          (deadlineNanoseconds - process.hrtime.bigint()) / 1_000_000n
        );
        return fetchAwsPage(binding, nextToken, remainingMs);
      },
    });
}

export async function collectBoundClasspilotTileAuthorizationPlanObservationEvidence({
  taskResult,
  logConfiguration,
  expectedTaskArn,
  expectedTaskDefinitionArn,
  expectedRegion,
  expectedAccountId,
  deadlineMs = DEFAULT_DEADLINE_MS,
  nowNanoseconds = () => process.hrtime.bigint(),
  sleep = defaultSleep,
  freshSnapshotFetcherFactory = awsFreshSnapshotFetcher,
}) {
  if (
    !Number.isSafeInteger(deadlineMs) ||
    deadlineMs < 1 ||
    typeof nowNanoseconds !== "function" ||
    typeof sleep !== "function" ||
    typeof freshSnapshotFetcherFactory !== "function"
  ) {
    throw new Error("observation_collection_configuration_invalid");
  }

  const deadlineNanoseconds =
    nowNanoseconds() + BigInt(deadlineMs) * 1_000_000n;
  return collectBoundUntilDeadline({
    taskResult,
    logConfiguration,
    expectedTaskArn,
    expectedTaskDefinitionArn,
    expectedRegion,
    expectedAccountId,
    deadlineNanoseconds,
    nowNanoseconds,
    sleep,
    freshSnapshotFetcherFactory,
  });
}

async function collectBoundUntilDeadline({
  taskResult,
  logConfiguration,
  expectedTaskArn,
  expectedTaskDefinitionArn,
  expectedRegion,
  expectedAccountId,
  deadlineNanoseconds,
  nowNanoseconds,
  sleep,
  freshSnapshotFetcherFactory,
}) {
  let resolveClasspilotTileAuthorizationPlanLogBinding;
  try {
    ({
      resolveClasspilotTileAuthorizationPlanLogBinding,
    } = await import(
      "./resolve-classpilot-tile-auth-plan-log-binding.mjs"
    ));
  } catch {
    return {
      ...failedClasspilotTileAuthorizationPlanObservationCollection(
        0,
        "collector_start_unavailable"
      ),
      binding: null,
    };
  }

  let binding;
  try {
    binding = resolveClasspilotTileAuthorizationPlanLogBinding({
      taskResult,
      logConfiguration,
      expectedTaskArn,
      expectedTaskDefinitionArn,
      expectedRegion,
      expectedAccountId,
    });
  } catch {
    return {
      ...failedClasspilotTileAuthorizationPlanObservationCollection(
        0,
        "log_binding_unavailable"
      ),
      binding: null,
    };
  }

  let result = await collectUntilDeadline({
    taskExitCode: binding.exitCode,
    deadlineNanoseconds,
    nowNanoseconds,
    sleep,
    fetchFreshSnapshot: freshSnapshotFetcherFactory(
      {
        logGroupName: binding.logGroup,
        logStreamName: binding.logStream,
        region: binding.logRegion,
      },
      deadlineNanoseconds
    ),
  });
  if (
    result.collection.status === "failed" &&
    result.collection.attemptCount === 0
  ) {
    result =
      failedClasspilotTileAuthorizationPlanObservationCollection(
        0,
        "collector_start_unavailable"
      );
  }
  if (result.collection.status === "completed") {
    result.collection.logStreamSha256 = createHash("sha256")
      .update(binding.logStream, "utf8")
      .digest("hex");
  }
  return { ...result, binding };
}

export async function runCli(
  argv,
  {
    nowNanoseconds = () => process.hrtime.bigint(),
    sleep = defaultSleep,
    readFile = readFileSync,
    freshSnapshotFetcherFactory = awsFreshSnapshotFetcher,
  } = {}
) {
  // Latch before argument parsing or file I/O. This absolute monotonic value
  // never crosses a process or CLI boundary; it only bounds work performed by
  // this collector process.
  const startedAtNanoseconds = nowNanoseconds();
  const options = parseArguments(argv);
  const deadlineNanoseconds =
    startedAtNanoseconds + BigInt(options.deadlineMs) * 1_000_000n;
  let taskResult;
  let logConfiguration;
  try {
    taskResult = JSON.parse(
      readFile(options.taskResultFile, "utf8")
    );
    logConfiguration = JSON.parse(
      readFile(options.logConfigurationFile, "utf8")
    );
  } catch {
    return failedClasspilotTileAuthorizationPlanObservationCollection(
      0,
      "log_binding_unavailable"
    );
  }
  const { binding: _binding, ...result } =
    await collectBoundUntilDeadline({
      taskResult,
      logConfiguration,
      expectedTaskArn: options.expectedTaskArn,
      expectedTaskDefinitionArn: options.expectedTaskDefinitionArn,
      expectedRegion: options.expectedRegion,
      expectedAccountId: options.expectedAccountId,
      deadlineNanoseconds,
      nowNanoseconds,
      sleep,
      freshSnapshotFetcherFactory,
    });
  return result;
}

const invokedPath = process.argv[1];
if (invokedPath && import.meta.url === pathToFileURL(invokedPath).href) {
  try {
    process.stdout.write(JSON.stringify(await runCli(process.argv.slice(2))));
  } catch {
    process.stderr.write(
      "classpilot_tile_auth_plan_observation_collection_unavailable\n"
    );
    process.exitCode = 1;
  }
}
