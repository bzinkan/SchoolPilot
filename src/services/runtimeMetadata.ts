import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { schedulerEnabled } from "../config/runtime.js";

const INSTANCE_ID = process.env.INSTANCE_ID || randomUUID();
const STARTED_AT = new Date().toISOString();
const RELEASE_SHA = /^[a-f0-9]{40}$/i;

function packageVersion(): string {
  try {
    return (JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as {
      version?: string;
    }).version || "unknown";
  } catch {
    return process.env.npm_package_version || "unknown";
  }
}

/** Shared, identifier-free process identity; release/instance are log fields, not fleet dimensions. */
export function getRuntimeMetadata(env: NodeJS.ProcessEnv = process.env) {
  const service = env.SERVICE_NAME === "api" || env.SERVICE_NAME === "scheduler-worker"
    ? env.SERVICE_NAME
    : schedulerEnabled(env) ? "scheduler-worker" : "api";
  return {
    environment: env.APP_ENV || env.NODE_ENV || "development",
    service,
    instanceId: INSTANCE_ID,
    release: env.GIT_SHA && RELEASE_SHA.test(env.GIT_SHA)
      ? env.GIT_SHA.toLowerCase()
      : env.APP_VERSION || packageVersion(),
    startedAt: STARTED_AT,
  };
}
