#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const SAFE_LOG_GROUP = /^[A-Za-z0-9_.\-/#]+$/;
const SAFE_LOG_STREAM = /^[A-Za-z0-9_.\-/#]+$/;
const SAFE_REGION = /^[a-z]{2}-[a-z]+-\d$/;
const MAX_PAGES = 100;
const MAX_EVENTS = 10_000;

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validatePage(page) {
  if (
    !isRecord(page) ||
    !Array.isArray(page.events) ||
    typeof page.nextForwardToken !== "string" ||
    page.nextForwardToken.length === 0
  ) {
    throw new Error("log_page_invalid");
  }
  for (const event of page.events) {
    if (
      !isRecord(event) ||
      typeof event.message !== "string" ||
      !Number.isSafeInteger(event.timestamp) ||
      event.timestamp < 0 ||
      !Number.isSafeInteger(event.ingestionTime) ||
      event.ingestionTime < 0
    ) {
      throw new Error("log_event_invalid");
    }
  }
}

export async function collectClasspilotTileAuthorizationPlanLogEvents({
  fetchPage,
  maxPages = MAX_PAGES,
  maxEvents = MAX_EVENTS,
}) {
  if (
    typeof fetchPage !== "function" ||
    !Number.isSafeInteger(maxPages) ||
    maxPages < 1 ||
    !Number.isSafeInteger(maxEvents) ||
    maxEvents < 1
  ) {
    throw new Error("log_collection_configuration_invalid");
  }

  const events = [];
  const seenForwardTokens = new Set();
  let requestToken;
  for (let pageNumber = 0; pageNumber < maxPages; pageNumber += 1) {
    const page = await fetchPage(requestToken);
    validatePage(page);
    events.push(...page.events);
    if (events.length > maxEvents) {
      throw new Error("log_event_limit_exceeded");
    }

    const nextToken = page.nextForwardToken;
    if (requestToken !== undefined && nextToken === requestToken) {
      return { events };
    }
    if (seenForwardTokens.has(nextToken)) {
      throw new Error("log_pagination_cycle");
    }
    seenForwardTokens.add(nextToken);
    requestToken = nextToken;
  }
  throw new Error("log_page_limit_exceeded");
}

function parseArguments(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!name?.startsWith("--") || value === undefined) {
      throw new Error("invalid_arguments");
    }
    const key = name.slice(2);
    if (Object.hasOwn(result, key)) throw new Error("duplicate_argument");
    result[key] = value;
  }
  if (
    !SAFE_LOG_GROUP.test(result["log-group-name"] || "") ||
    !SAFE_LOG_STREAM.test(result["log-stream-name"] || "") ||
    !SAFE_REGION.test(result.region || "")
  ) {
    throw new Error("invalid_arguments");
  }
  return result;
}

function fetchAwsPage({ logGroupName, logStreamName, region }, nextToken) {
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
    "--no-cli-pager",
    "--cli-connect-timeout",
    "10",
    "--cli-read-timeout",
    "20",
  ];
  if (nextToken !== undefined) args.push("--next-token", nextToken);

  const result = spawnSync(process.env.AWS_CLI_EXECUTABLE || "aws", args, {
    encoding: "utf8",
    // The deploy wrapper also disables conversion on this Node invocation so
    // `/ecs/...` survives the Git-Bash-to-node.exe boundary. Keep both knobs
    // on the nested AWS process as defense in depth for direct invocations.
    env: {
      ...process.env,
      MSYS_NO_PATHCONV: "1",
      MSYS2_ARG_CONV_EXCL: "*",
    },
    windowsHide: true,
    timeout: 30_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  if (result.error || result.status !== 0 || result.signal || !result.stdout) {
    throw new Error("aws_log_page_unavailable");
  }
  return JSON.parse(result.stdout);
}

const invokedPath = process.argv[1];
if (invokedPath && import.meta.url === pathToFileURL(invokedPath).href) {
  try {
    const args = parseArguments(process.argv.slice(2));
    const logGroupName = args["log-group-name"];
    const logStreamName = args["log-stream-name"];
    const region = args.region;
    const document = await collectClasspilotTileAuthorizationPlanLogEvents({
      fetchPage: (nextToken) =>
        fetchAwsPage({ logGroupName, logStreamName, region }, nextToken),
    });
    process.stdout.write(JSON.stringify(document));
  } catch {
    process.stderr.write("classpilot_tile_authorization_plan_log_events_unavailable\n");
    process.exitCode = 1;
  }
}
