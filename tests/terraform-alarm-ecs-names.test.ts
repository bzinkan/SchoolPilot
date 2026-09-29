import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const source = (path: string) => readFileSync(resolve(root, path), "utf8");

describe("CloudWatch alarm ECS names", () => {
  const alarms = source("infra/alarms.tf");
  const rootModule = source("infra/main.tf");
  const ecs = source("infra/modules/ecs/main.tf");

  it("keeps alarms off the ECS service and task-definition dependency chain", () => {
    // module.ecs outputs resolve through aws_ecs_service to the seed task
    // definitions that deploy.sh supersedes, so a targeted alarm plan would
    // also replace those task definitions.
    assert.doesNotMatch(alarms, /module\.ecs\.(?:cluster_name|service_name|worker_service_name)\b/);
    assert.match(alarms, /ClusterName = local\.ecs_alarm_cluster_name/);
    assert.match(alarms, /ServiceName = local\.ecs_alarm_api_service_name/);
    assert.match(alarms, /ServiceName = local\.ecs_alarm_worker_service_name/);
    assert.match(alarms, /service\/\$\{local\.ecs_alarm_cluster_name\}\//);
  });

  it("uses the names the ECS module gives its cluster and services", () => {
    const sharedName = /^\s*name\s*=\s*"\$\{var\.project\}-\$\{var\.environment\}"/m;
    assert.match(rootModule, sharedName);
    assert.match(ecs, sharedName);
    assert.match(rootModule, /module "ecs" \{[^}]*?\bproject\s*=\s*var\.project\b[^}]*?\benvironment\s*=\s*var\.environment\b/);

    assert.match(ecs, /resource "aws_ecs_cluster" "main" \{\s*name\s*=\s*"\$\{local\.name\}-cluster"/);
    assert.match(ecs, /resource "aws_ecs_service" "api" \{\s*name\s*=\s*"\$\{local\.name\}-api"/);
    assert.match(ecs, /resource "aws_ecs_service" "worker" \{\s*name\s*=\s*"\$\{local\.name\}-scheduler-worker"/);

    assert.match(alarms, /ecs_alarm_cluster_name\s*=\s*"\$\{local\.name\}-cluster"/);
    assert.match(alarms, /ecs_alarm_api_service_name\s*=\s*"\$\{local\.name\}-api"/);
    assert.match(alarms, /ecs_alarm_worker_service_name\s*=\s*"\$\{local\.name\}-scheduler-worker"/);
  });
});
