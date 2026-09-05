#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const options = new Map();
for (let i = 0; i < args.length; i += 2) {
  if (!args[i]?.startsWith("--") || !args[i + 1] || options.has(args[i])) {
    throw new Error("Invalid release identity arguments");
  }
  options.set(args[i], args[i + 1]);
}
const expectedOptions = ["--task-definition", "--service", "--git-sha", "--image-ref"];
if (options.size !== expectedOptions.length || expectedOptions.some((key) => !options.has(key))) {
  throw new Error("Release identity requires task definition, service, Git SHA and image reference");
}
const service = options.get("--service");
const gitSha = options.get("--git-sha");
const image = options.get("--image-ref");
if (!["api", "scheduler-worker"].includes(service) || !/^[a-f0-9]{40}$/.test(gitSha)
    || !/^\S+@sha256:[a-f0-9]{64}$/.test(image)) {
  throw new Error("Invalid release identity");
}
const file = options.get("--task-definition");
const definition = JSON.parse(readFileSync(file, "utf8"));
const matches = definition.containerDefinitions?.filter((container) => container.name === service);
if (matches?.length !== 1 || matches[0].image !== image) {
  throw new Error("Release identity must match the rendered container and immutable image");
}
const container = matches[0];
const identityNames = new Set(["SERVICE_NAME", "GIT_SHA"]);
if ((container.secrets ?? []).some((secret) => identityNames.has(secret.name))) {
  throw new Error("Runtime identity cannot be overridden by a secret reference");
}
// Run after all live/template environment merges. In particular, the worker's
// old environment must not overwrite the newly rendered image's Git SHA.
container.environment = [
  ...(container.environment ?? []).filter((item) => !identityNames.has(item.name)),
  { name: "SERVICE_NAME", value: service },
  { name: "GIT_SHA", value: gitSha },
];
writeFileSync(file, JSON.stringify(definition));
console.log(`Stamped release runtime identity for ${service}`);
