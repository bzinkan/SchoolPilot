#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const SAFE_AWSLOGS_VALUE = /^[A-Za-z0-9_.\-/#]+$/;
const ECS_TASK_ID = /^[0-9a-f]{32}$/;

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireSafeAwslogsValue(value) {
  return typeof value === "string" && value.length > 0 && SAFE_AWSLOGS_VALUE.test(value);
}

export function resolveClasspilotTileAuthorizationPlanLogBinding({
  taskResult,
  logConfiguration,
  expectedTaskArn,
  expectedTaskDefinitionArn,
  expectedRegion,
  expectedAccountId,
}) {
  const tasks = Array.isArray(taskResult?.tasks) ? taskResult.tasks : [];
  const failures = Array.isArray(taskResult?.failures) ? taskResult.failures : [];
  const task = tasks[0];
  const expectedTaskPrefix = `arn:aws:ecs:${expectedRegion}:${expectedAccountId}:task/`;
  const expectedTaskDefinitionPrefix =
    `arn:aws:ecs:${expectedRegion}:${expectedAccountId}:task-definition/`;

  if (failures.length !== 0 || tasks.length !== 1 ||
      typeof expectedRegion !== "string" || !/^[a-z]{2}-[a-z]+-\d$/.test(expectedRegion) ||
      typeof expectedAccountId !== "string" || !/^\d{12}$/.test(expectedAccountId) ||
      typeof expectedTaskArn !== "string" || !expectedTaskArn.startsWith(expectedTaskPrefix) ||
      typeof expectedTaskDefinitionArn !== "string" ||
      !expectedTaskDefinitionArn.startsWith(expectedTaskDefinitionPrefix) ||
      task?.taskArn !== expectedTaskArn ||
      task?.taskDefinitionArn !== expectedTaskDefinitionArn || task?.lastStatus !== "STOPPED") {
    throw new Error("task_binding_invalid");
  }

  const taskId = expectedTaskArn.slice(expectedTaskArn.lastIndexOf("/") + 1);
  if (!ECS_TASK_ID.test(taskId)) throw new Error("task_id_invalid");

  const containers = Array.isArray(task.containers) ? task.containers : [];
  const apiContainers = containers.filter((container) => container?.name === "api");
  const api = apiContainers[0];
  if (apiContainers.length !== 1 || api?.lastStatus !== "STOPPED" || api?.exitCode !== 0) {
    throw new Error("container_result_invalid");
  }

  const options = isRecord(logConfiguration?.options) ? logConfiguration.options : {};
  const logGroup = options["awslogs-group"];
  const logRegion = options["awslogs-region"];
  const logPrefix = options["awslogs-stream-prefix"];
  if (logConfiguration?.logDriver !== "awslogs" ||
      !requireSafeAwslogsValue(logGroup) || !requireSafeAwslogsValue(logPrefix) ||
      logRegion !== expectedRegion) {
    throw new Error("log_configuration_invalid");
  }

  // With awslogs-stream-prefix configured, ECS deterministically names the
  // stream prefix/container-name/task-id. Some terminal DescribeTasks responses
  // omit the optional logStreamName field, so derive the exact same value from
  // already-bound task metadata instead of discovering or guessing a stream.
  const logStream = `${logPrefix}/api/${taskId}`;
  if (Object.hasOwn(api, "logStreamName") && api.logStreamName != null &&
      api.logStreamName !== logStream) {
    throw new Error("reported_log_stream_mismatch");
  }
  if (Object.hasOwn(api, "logStreamName") && api.logStreamName != null &&
      typeof api.logStreamName !== "string") {
    throw new Error("reported_log_stream_invalid");
  }

  return { logGroup, logRegion, logPrefix, logStream };
}

const invokedPath = process.argv[1];
if (invokedPath && import.meta.url === pathToFileURL(invokedPath).href) {
  try {
    const taskResultPath = process.env.TILE_AUTH_PLAN_RESULT_PATH;
    if (!taskResultPath) throw new Error("task_result_path_missing");
    const binding = resolveClasspilotTileAuthorizationPlanLogBinding({
      taskResult: JSON.parse(readFileSync(taskResultPath, "utf8")),
      logConfiguration: JSON.parse(
        process.env.TILE_AUTH_PLAN_LOG_CONFIGURATION_JSON || "null"
      ),
      expectedTaskArn: process.env.EXPECTED_TASK_ARN,
      expectedTaskDefinitionArn: process.env.EXPECTED_TASK_DEFINITION,
      expectedRegion: process.env.EXPECTED_REGION,
      expectedAccountId: process.env.EXPECTED_ACCOUNT_ID,
    });
    process.stdout.write(
      `${binding.logGroup}\t${binding.logRegion}\t${binding.logPrefix}\t${binding.logStream}`
    );
  } catch {
    process.stderr.write("classpilot_tile_authorization_plan_log_binding_invalid\n");
    process.exitCode = 1;
  }
}
