#!/usr/bin/env node

// One-release deploy delta: emergency and worker revisions inherit it from the
// rendered API revision, and later deploys carry it forward by cloning.
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export const MICROSOFT_CLIENT_ID_NAME = "MICROSOFT_CLIENT_ID";
export const MICROSOFT_CLIENT_SECRET_NAME = "MICROSOFT_CLIENT_SECRET";
const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function validateClientId(clientId) {
  if (typeof clientId !== "string" || !GUID_RE.test(clientId)) {
    throw new Error("The Microsoft client ID must be the lowercase Application (client) ID GUID");
  }
  return clientId;
}

export function microsoftClientSecretArn({ region, accountId, project, environment }) {
  if (!/^[a-z]{2}-[a-z]+-\d$/.test(region || "") || !/^\d{12}$/.test(accountId || "") ||
      !/^[a-z0-9][a-z0-9-]{0,62}$/.test(project || "") ||
      !/^[a-z0-9][a-z0-9-]{0,62}$/.test(environment || "")) {
    throw new Error("Invalid region, account, project, or environment for the Microsoft client secret");
  }
  return `arn:aws:ssm:${region}:${accountId}:parameter/${project}/${environment}/${MICROSOFT_CLIENT_SECRET_NAME}`;
}

function onlyContainer(taskDefinition, containerName) {
  const matches = (taskDefinition?.containerDefinitions || []).filter((c) => c?.name === containerName);
  if (matches.length !== 1) {
    throw new Error(`Task definition must contain exactly one ${containerName} container; found ${matches.length}`);
  }
  return matches[0];
}

function assertNoInlineSecret(container) {
  const environmentNames = (container.environment || []).map((entry) => entry?.name);
  const secretNames = (container.secrets || []).map((entry) => entry?.name);
  if (environmentNames.includes(MICROSOFT_CLIENT_SECRET_NAME)) {
    throw new Error(`${container.name} must never carry ${MICROSOFT_CLIENT_SECRET_NAME} as inline environment data`);
  }
  if (secretNames.includes(MICROSOFT_CLIENT_ID_NAME)) {
    throw new Error(`${container.name} must carry ${MICROSOFT_CLIENT_ID_NAME} as plain environment data`);
  }
}

export function addMicrosoftSignIn(taskDefinition, { containerName, clientId, secretArn }) {
  validateClientId(clientId);
  const container = onlyContainer(taskDefinition, containerName);
  assertNoInlineSecret(container);
  container.environment = [
    ...(container.environment || []).filter((entry) => entry?.name !== MICROSOFT_CLIENT_ID_NAME),
    { name: MICROSOFT_CLIENT_ID_NAME, value: clientId },
  ];
  container.secrets = [
    ...(container.secrets || []).filter((entry) => entry?.name !== MICROSOFT_CLIENT_SECRET_NAME),
    { name: MICROSOFT_CLIENT_SECRET_NAME, valueFrom: secretArn },
  ];
  return taskDefinition;
}

export function assertMicrosoftSignIn(taskDefinition, { containerName, clientId, secretArn }) {
  const container = onlyContainer(taskDefinition, containerName);
  assertNoInlineSecret(container);
  const ids = (container.environment || []).filter((entry) => entry?.name === MICROSOFT_CLIENT_ID_NAME);
  const secrets = (container.secrets || []).filter((entry) => entry?.name === MICROSOFT_CLIENT_SECRET_NAME);
  if (ids.length !== 1 || ids[0].value !== clientId) {
    throw new Error(`${containerName} must carry exactly the reviewed ${MICROSOFT_CLIENT_ID_NAME}`);
  }
  if (secrets.length !== 1 || secrets[0].valueFrom !== secretArn) {
    throw new Error(`${containerName} must reference exactly the reviewed ${MICROSOFT_CLIENT_SECRET_NAME} parameter`);
  }
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const options = {};
  for (let index = 0; index < rest.length; index += 2) {
    const key = rest[index];
    const value = rest[index + 1];
    if (!key?.startsWith("--") || value === undefined || Object.hasOwn(options, key.slice(2))) {
      throw new Error(`Invalid or repeated argument: ${key}`);
    }
    options[key.slice(2)] = value;
  }
  return { command, options };
}

function main(argv) {
  const { command, options } = parseArgs(argv);
  if (command === "validate-request") {
    validateClientId(options["client-id"]);
    return;
  }
  const secretArn = microsoftClientSecretArn({
    region: options.region,
    accountId: options["account-id"],
    project: options.project,
    environment: options.environment,
  });
  const request = {
    containerName: options.container,
    clientId: validateClientId(options["client-id"]),
    secretArn,
  };
  const path = options["task-definition"];
  const taskDefinition = JSON.parse(readFileSync(path, "utf8"));
  if (command === "add") {
    writeFileSync(path, JSON.stringify(addMicrosoftSignIn(taskDefinition, request)));
  } else if (command === "verify") {
    assertMicrosoftSignIn(taskDefinition, request);
  } else {
    throw new Error("Usage: enable-microsoft-sign-in-runtime.mjs validate-request|add|verify --client-id <guid> ...");
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}
