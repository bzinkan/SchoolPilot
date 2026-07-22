#!/usr/bin/env node

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  extractClasspilotTileAuthorizationPlanIdentity,
} from "./validate-classpilot-tile-auth-plan-evidence.mjs";
import {
  preparePrivateOutputDirectory,
  writePrivateJson,
} from "./load/prepare-classpilot-load-test.mjs";

export const HISTORY_FALLBACK_IDENTITY_RECEIPT_FILENAME =
  "history-fallback-query-identity.private.json";

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const APPLICATION_SHA_PATTERN = /^[a-f0-9]{40}$/;
const IMAGE_DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;
const DATABASE_RESOURCE_ID_PATTERN = /^db-[A-Z0-9]{8,64}$/;

function requireString(value, pattern, maximumLength = 512) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maximumLength ||
    /[\u0000-\u001f\u007f]/.test(value) ||
    (pattern && !pattern.test(value))
  ) {
    throw new Error("history_fallback_identity_receipt_invalid");
  }
  return value;
}

function requireTaskDefinitionArn(value, expectedContainer) {
  const arn = requireString(value, null, 512);
  const match = /^arn:aws:ecs:[a-z0-9-]+:\d{12}:task-definition\/([A-Za-z0-9_-]+):([1-9]\d*)$/.exec(
    arn
  );
  if (!match || !match[1]?.includes(expectedContainer)) {
    throw new Error("history_fallback_identity_receipt_invalid");
  }
  return arn;
}

function requireUtcTimestamp(value) {
  const timestamp = requireString(value, null, 64);
  const parsed = Date.parse(timestamp);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== timestamp) {
    throw new Error("history_fallback_identity_receipt_invalid");
  }
  return timestamp;
}

export function buildClasspilotHistoryFallbackIdentityReceipt({
  eventsDocument,
  applicationGitSha,
  deployedImageDigest,
  activeApiTaskDefinitionArn,
  activeWorkerTaskDefinitionArn,
  databaseResourceId,
  engineVersion,
  expectedQueryIdentifierSha256,
  createdAtUtc = new Date().toISOString(),
}) {
  const identity = extractClasspilotTileAuthorizationPlanIdentity(eventsDocument);
  const expectedHash = requireString(
    expectedQueryIdentifierSha256,
    SHA256_PATTERN,
    64
  );
  if (
    identity.queryIdentifierSha256 !== expectedHash ||
    identity.engineVersion !== engineVersion ||
    identity.trackIoTiming !== true
  ) {
    throw new Error("history_fallback_identity_receipt_mismatch");
  }

  return {
    schemaVersion: 1,
    type: "history_fallback_query_identity_receipt",
    identityVersion: identity.version,
    queryIdentifier: identity.queryIdentifier,
    queryIdentifierSha256: identity.queryIdentifierSha256,
    compiledSqlSha256: identity.compiledSqlSha256,
    parameterTypeSignatureSha256: identity.parameterTypeSignatureSha256,
    engineVersion: requireString(engineVersion, null, 128),
    schemaIdentitySha256: identity.schemaIdentitySha256,
    trackIoTiming: true,
    databaseResourceId: requireString(
      databaseResourceId,
      DATABASE_RESOURCE_ID_PATTERN,
      128
    ),
    applicationGitSha: requireString(applicationGitSha, APPLICATION_SHA_PATTERN, 40),
    deployedImageDigest: requireString(deployedImageDigest, IMAGE_DIGEST_PATTERN, 71),
    activeApiTaskDefinitionArn: requireTaskDefinitionArn(
      activeApiTaskDefinitionArn,
      "api"
    ),
    activeWorkerTaskDefinitionArn: requireTaskDefinitionArn(
      activeWorkerTaskDefinitionArn,
      "scheduler-worker"
    ),
    createdAtUtc: requireUtcTimestamp(createdAtUtc),
  };
}

export function writeClasspilotHistoryFallbackIdentityReceipt(
  outputDirectory,
  receipt
) {
  const privateDirectory = preparePrivateOutputDirectory(outputDirectory);
  const target = path.join(
    privateDirectory,
    HISTORY_FALLBACK_IDENTITY_RECEIPT_FILENAME
  );
  if (fs.existsSync(target)) {
    throw new Error("history_fallback_identity_receipt_already_exists");
  }
  const writtenPath = writePrivateJson(
    privateDirectory,
    HISTORY_FALLBACK_IDENTITY_RECEIPT_FILENAME,
    receipt
  );
  const sha256 = createHash("sha256")
    .update(fs.readFileSync(writtenPath))
    .digest("hex");
  return { path: writtenPath, sha256 };
}

function parseArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index];
    if (!name?.startsWith("--") || index + 1 >= argv.length) {
      throw new Error("history_fallback_identity_receipt_arguments_invalid");
    }
    const value = argv[index + 1];
    index += 1;
    const key = {
      "--output": "output",
      "--application-sha": "applicationGitSha",
      "--image-digest": "deployedImageDigest",
      "--api-task-definition-arn": "activeApiTaskDefinitionArn",
      "--worker-task-definition-arn": "activeWorkerTaskDefinitionArn",
      "--database-resource-id": "databaseResourceId",
      "--engine-version": "engineVersion",
      "--expected-query-identifier-sha256": "expectedQueryIdentifierSha256",
    }[name];
    if (!key || Object.hasOwn(options, key)) {
      throw new Error("history_fallback_identity_receipt_arguments_invalid");
    }
    options[key] = value;
  }
  const required = [
    "output",
    "applicationGitSha",
    "deployedImageDigest",
    "activeApiTaskDefinitionArn",
    "activeWorkerTaskDefinitionArn",
    "databaseResourceId",
    "engineVersion",
    "expectedQueryIdentifierSha256",
  ];
  if (required.some((key) => !Object.hasOwn(options, key))) {
    throw new Error("history_fallback_identity_receipt_arguments_invalid");
  }
  return options;
}

async function readStdin() {
  let input = "";
  for await (const chunk of process.stdin) input += chunk;
  return input;
}

export async function runCli(argv) {
  const options = parseArguments(argv);
  const eventsDocument = JSON.parse(await readStdin());
  const receipt = buildClasspilotHistoryFallbackIdentityReceipt({
    ...options,
    eventsDocument,
  });
  const reference = writeClasspilotHistoryFallbackIdentityReceipt(
    path.resolve(options.output),
    receipt
  );
  return {
    schemaVersion: 1,
    identityVersion: receipt.identityVersion,
    path: reference.path,
    sha256: reference.sha256,
    queryIdentifierSha256: receipt.queryIdentifierSha256,
    compiledSqlSha256: receipt.compiledSqlSha256,
    parameterTypeSignatureSha256: receipt.parameterTypeSignatureSha256,
    schemaIdentitySha256: receipt.schemaIdentitySha256,
    trackIoTiming: receipt.trackIoTiming,
    databaseResourceIdSha256: createHash("sha256")
      .update(receipt.databaseResourceId, "utf8")
      .digest("hex"),
    engineVersion: receipt.engineVersion,
  };
}

const invokedDirectly =
  process.argv[1] &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (invokedDirectly) {
  runCli(process.argv.slice(2))
    .then((summary) => process.stdout.write(`${JSON.stringify(summary)}\n`))
    .catch(() => {
      process.stderr.write("history_fallback_identity_receipt_failed\n");
      process.exitCode = 1;
    });
}
