#!/usr/bin/env node

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
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

function failedCollection(attemptCount, failureCode) {
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
  deadlineNanoseconds = null,
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
    (deadlineNanoseconds !== null &&
      (typeof deadlineNanoseconds !== "bigint" ||
        deadlineNanoseconds < 1n)) ||
    typeof nowNanoseconds !== "function" ||
    typeof sleep !== "function"
  ) {
    throw new Error("observation_collection_configuration_invalid");
  }

  const deadline =
    deadlineNanoseconds ??
    nowNanoseconds() + BigInt(deadlineMs) * 1_000_000n;
  let attemptCount = 0;

  while (nowNanoseconds() < deadline) {
    const delayMs = nextRetryDelay(attemptCount);
    if (delayMs > 0) {
      const remainingBeforeDelay = Number(
        (deadline - nowNanoseconds()) / 1_000_000n
      );
      if (remainingBeforeDelay <= delayMs) break;
      await sleep(delayMs);
      if (nowNanoseconds() >= deadline) break;
    }

    attemptCount += 1;
    const remainingMs = Number(
      (deadline - nowNanoseconds()) / 1_000_000n
    );
    if (remainingMs < 1) break;

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

  return failedCollection(attemptCount, "log_evidence_unavailable");
}

function parseArguments(argv) {
  const options = {};
  const allowed = new Set([
    "--log-group-name",
    "--log-stream-name",
    "--region",
    "--task-exit-code",
    "--deadline-ms",
    "--deadline-monotonic-nanoseconds",
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
    !SAFE_LOG_GROUP.test(options["--log-group-name"] || "") ||
    !SAFE_LOG_STREAM.test(options["--log-stream-name"] || "") ||
    !SAFE_REGION.test(options["--region"] || "") ||
    !/^(?:[0-9]|[1-9][0-9]|1[0-9]{2}|2[0-4][0-9]|25[0-5])$/.test(
      options["--task-exit-code"] || ""
    )
  ) {
    throw new Error("observation_collection_arguments_invalid");
  }
  if (
    options["--deadline-ms"] !== undefined &&
    !/^[1-9][0-9]{0,8}$/.test(options["--deadline-ms"])
  ) {
    throw new Error("observation_collection_arguments_invalid");
  }
  if (
    options["--deadline-monotonic-nanoseconds"] !== undefined &&
    !/^[1-9][0-9]{0,20}$/.test(
      options["--deadline-monotonic-nanoseconds"]
    )
  ) {
    throw new Error("observation_collection_arguments_invalid");
  }
  return {
    logGroupName: options["--log-group-name"],
    logStreamName: options["--log-stream-name"],
    region: options["--region"],
    taskExitCode: Number(options["--task-exit-code"]),
    deadlineMs:
      options["--deadline-ms"] === undefined
        ? DEFAULT_DEADLINE_MS
        : Number(options["--deadline-ms"]),
    deadlineNanoseconds:
      options["--deadline-monotonic-nanoseconds"] === undefined
        ? null
        : BigInt(options["--deadline-monotonic-nanoseconds"]),
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

export async function runCli(argv) {
  const options = parseArguments(argv);
  const deadlineNanoseconds =
    options.deadlineNanoseconds ??
    process.hrtime.bigint() + BigInt(options.deadlineMs) * 1_000_000n;
  const result =
    await collectClasspilotTileAuthorizationPlanObservationEvidence({
      taskExitCode: options.taskExitCode,
      deadlineMs: options.deadlineMs,
      deadlineNanoseconds,
      fetchFreshSnapshot: awsFreshSnapshotFetcher(
        options,
        deadlineNanoseconds
      ),
    });
  if (result.collection.status === "completed") {
    result.collection.logStreamSha256 = createHash("sha256")
      .update(options.logStreamName, "utf8")
      .digest("hex");
  }
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
