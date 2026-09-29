import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// Reviewed production Fargate sizes. The My Desk paperwork capacity tests
// passed at API 1 vCPU / 2 GiB and scheduler worker 0.5 vCPU / 1 GiB
// (adopted 2026-09-27). Every place that renders, validates, or rolls back a
// production task must use these sizes, and none may accept anything smaller.
// Lowering one needs new capacity evidence and a reviewed change to this file.
const API = { cpu: 1024, memory: 2048 };
const WORKER = { cpu: 512, memory: 1024 };

const read = (path: string) =>
  readFileSync(new URL(`../${path}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");

function onlyNumber(matches: RegExpMatchArray[], label: string): number {
  const [match] = matches;
  assert.equal(matches.length, 1, `${label} must be set exactly once`);
  assert.ok(match);
  return Number(match[1]);
}

function tfvarsNumber(source: string, name: string): number {
  return onlyNumber([...source.matchAll(new RegExp(`^${name}\\s*=\\s*(\\d+)\\s*$`, "gm"))], name);
}

function quotedAssignment(source: string, pattern: string): number {
  return onlyNumber(
    [...source.matchAll(new RegExp(`^\\s*${pattern}\\s*=\\s*"(\\d+)"\\s*$`, "gm"))],
    pattern
  );
}

function count(source: string, pattern: RegExp): number {
  return source.match(new RegExp(pattern.source, "g"))?.length ?? 0;
}

describe("reviewed production task sizing", () => {
  it("keeps the production Terraform template at exactly the reviewed sizes", () => {
    const tfvars = read("infra/production.tfvars");
    assert.deepEqual(
      {
        api: { cpu: tfvarsNumber(tfvars, "ecs_cpu"), memory: tfvarsNumber(tfvars, "ecs_memory") },
        worker: { cpu: tfvarsNumber(tfvars, "worker_cpu"), memory: tfvarsNumber(tfvars, "worker_memory") },
      },
      { api: API, worker: WORKER }
    );
  });

  it("never lets the scale-up profile go below the reviewed sizes", () => {
    const profile = read("infra/production-ha-2000.tfvars");
    assert.ok(tfvarsNumber(profile, "ecs_cpu") >= API.cpu);
    assert.ok(tfvarsNumber(profile, "ecs_memory") >= API.memory);
    assert.ok(tfvarsNumber(profile, "worker_cpu") >= WORKER.cpu);
    assert.ok(tfvarsNumber(profile, "worker_memory") >= WORKER.memory);
  });

  it("gives the ECS module's production floor the same sizes", () => {
    const module = read("infra/modules/ecs/main.tf");
    for (const [name, value] of [
      ["reviewed_production_api_cpu", API.cpu],
      ["reviewed_production_api_memory", API.memory],
      ["reviewed_production_worker_cpu", WORKER.cpu],
      ["reviewed_production_worker_memory", WORKER.memory],
    ] as const) {
      assert.match(module, new RegExp(`^\\s*${name}\\s*=\\s*${value}\\s*$`, "m"));
      assert.match(module, new RegExp(`>= local\\.${name}\\b`), `${name} must guard a task definition`);
    }
  });

  it("renders, validates, and guards the same sizes in scripts/deploy.sh", () => {
    const deploy = read("scripts/deploy.sh");
    assert.deepEqual(
      {
        api: {
          cpu: quotedAssignment(deploy, "REVIEWED_API_TASK_CPU"),
          memory: quotedAssignment(deploy, "REVIEWED_API_TASK_MEMORY"),
        },
        worker: {
          cpu: quotedAssignment(deploy, "REVIEWED_WORKER_TASK_CPU"),
          memory: quotedAssignment(deploy, "REVIEWED_WORKER_TASK_MEMORY"),
        },
      },
      { api: API, worker: WORKER }
    );

    // Outside the reviewed constants, no Fargate size is hard-coded, so a
    // resize cannot leave a stale literal behind in rendering or validation.
    const withoutConstants = deploy.replace(/^REVIEWED_\w+="\d+"$/gm, "");
    assert.doesNotMatch(withoutConstants, /"(?:256|512|1024|2048|4096)"/);
    assert.doesNotMatch(withoutConstants, /\b(?:256|512|1024)\s*CPU\b|\b(?:512|256)\/(?:2048|1024|512)\b/);

    // The OOM emergency family is what production serves, so it is rendered
    // at the reviewed API size, never at a fixed older one.
    assert.match(
      deploy,
      /EMERGENCY_CPU="\$REVIEWED_API_TASK_CPU" EMERGENCY_MEMORY="\$REVIEWED_API_TASK_MEMORY" node -e '\n\s+const fs = require\("fs"\);\n\s+const source = JSON\.parse\(fs\.readFileSync\("\.taskdef-new\.json"/
    );
    assert.match(deploy, /emergency\.cpu = process\.env\.EMERGENCY_CPU;\n\s+emergency\.memory = process\.env\.EMERGENCY_MEMORY;/);

    // Every rendered API, emergency, and worker revision passes the
    // downsizing guard immediately before it is registered.
    for (const [guard, registration] of [
      [
        "assert_rendered_task_size_not_reduced .taskdef-new.json .taskdef-current.json \\\n      api \"standard API candidate\"",
        "STANDARD_API_CANDIDATE_TASK_DEFINITION_ARN=$(aws ecs register-task-definition",
      ],
      [
        "assert_rendered_task_size_not_reduced .taskdef-emergency.json .taskdef-current.json \\\n      api \"API OOM emergency revision\"",
        "EMERGENCY_TASK_DEF_ARN=$(aws ecs register-task-definition",
      ],
      [
        "assert_rendered_task_size_not_reduced .worker-taskdef-new.json \\\n      .worker-taskdef-current.json scheduler-worker \"scheduler-worker candidate\"",
        "worker_arn=$(aws ecs register-task-definition",
      ],
    ] as const) {
      const guardIndex = deploy.indexOf(guard);
      const registrationIndex = deploy.indexOf(registration);
      assert.ok(guardIndex > 0, `missing guard: ${guard}`);
      assert.ok(registrationIndex > guardIndex, `guard must precede: ${registration}`);
      assert.equal(
        count(deploy.slice(guardIndex, registrationIndex), /aws ecs register-task-definition/),
        0,
        `nothing may be registered between the guard and ${registration}`
      );
    }
  });

  it("requires the same sizes in the runtime-config tools", () => {
    const runtime = read("scripts/deploy-classpilot-runtime-config.ps1");
    assert.deepEqual(
      {
        api: {
          cpu: quotedAssignment(runtime, "\\$script:ApiTaskCpu"),
          memory: quotedAssignment(runtime, "\\$script:ApiTaskMemory"),
        },
        worker: {
          cpu: quotedAssignment(runtime, "\\$script:WorkerTaskCpu"),
          memory: quotedAssignment(runtime, "\\$script:WorkerTaskMemory"),
        },
      },
      { api: API, worker: WORKER }
    );
    // Source, candidate, and rollback checks all use the reviewed constants.
    assert.doesNotMatch(runtime, /-Expected(?:Cpu|Memory) "\d+"|\b(?:Cpu|Memory) = "\d+"/);
    assert.equal(count(runtime, /-ExpectedCpu \$script:ApiTaskCpu -ExpectedMemory \$script:ApiTaskMemory/), 3);
    assert.equal(count(runtime, /-ExpectedCpu \$script:WorkerTaskCpu -ExpectedMemory \$script:WorkerTaskMemory/), 3);
    assert.equal(count(runtime, /Cpu = \$script:ApiTaskCpu; Memory = \$script:ApiTaskMemory/), 2);
    assert.equal(count(runtime, /Cpu = \$script:WorkerTaskCpu; Memory = \$script:WorkerTaskMemory/), 2);

    const mydesk = read("scripts/deploy-mydesk-runtime-config.ps1");
    assert.match(mydesk, /'api', \$script:ApiTaskCpu, \$script:ApiTaskMemory\)/);
    assert.match(mydesk, /'scheduler-worker', \$script:WorkerTaskCpu, \$script:WorkerTaskMemory\)/);
    assert.match(mydesk, /-ExpectedCpu \$entry\[3\] -ExpectedMemory \$entry\[4\]/);

    const product = read("scripts/deploy-product-runtime-config.ps1");
    assert.match(product, /'api', \$script:ApiTaskCpu, \$script:ApiTaskMemory\)/);
    assert.match(product, /'scheduler-worker', \$script:WorkerTaskCpu, \$script:WorkerTaskMemory\)/);
    assert.match(product, /-ExpectedCpu \$entry\[3\] -ExpectedMemory \$entry\[4\]/);
    // Candidate and recovery revisions are exact-size clones of those sources.
    assert.equal(count(product, /-ExpectedCpu \$task\.cpu -ExpectedMemory \$task\.memory/), 4);
    assert.doesNotMatch(product, /-Expected(?:Cpu|Memory) "\d+"/);
  });

  it("requires the same sizes in the rollback and load-test tools", () => {
    const rollback = read("scripts/load/aws-rollout-rollback.ps1");
    assert.match(
      rollback,
      /\[int\]\$emergency\.cpu -ne 1024 -or \[int\]\$emergency\.memory -ne 2048 -or\n\s+\[int\]\$emergency\.cpu -lt \[int\]\$current\.cpu -or \[int\]\$emergency\.memory -lt \[int\]\$current\.memory/
    );

    const capacity = read("scripts/load/start-classpilot-capacity-acceptance.ps1");
    assert.match(capacity, /Container = "api"\n\s+Cpu = "1024"\n\s+Memory = "2048"/);
    assert.match(capacity, /Container = "scheduler-worker"\n\s+Cpu = "512"\n\s+Memory = "1024"/);
    assert.match(capacity, /\$Config\.ApiTaskDefinitionArn "api" "1024" "2048"/);
    assert.match(capacity, /\$Config\.WorkerTaskDefinitionArn "scheduler-worker" "512" "1024"/);

    const diagnostic = read("scripts/load/start-waf800-batch-diagnostic.ps1");
    assert.match(diagnostic, /"api" \$Config\.ImageDigest "1024" "2048"/);
    assert.match(diagnostic, /"scheduler-worker" \$Config\.ImageDigest "512" "1024"/);

    const supervisor = read("scripts/load/start-aws-rollout-supervisor.ps1");
    assert.equal(count(supervisor, /"api",(?:\$Contract\.\w+,)?1024,2048\b/), 4);
    assert.equal(count(supervisor, /"scheduler-worker",(?:\$Contract\.\w+,)?512,1024\b/), 4);

    for (const [path, source] of [
      ["scripts/load/aws-rollout-rollback.ps1", rollback],
      ["scripts/load/start-classpilot-capacity-acceptance.ps1", capacity],
      ["scripts/load/start-waf800-batch-diagnostic.ps1", diagnostic],
      ["scripts/load/start-aws-rollout-supervisor.ps1", supervisor],
    ] as const) {
      assert.doesNotMatch(source, /"api"[^\n]*(?:"512" "2048"|,512,2048\b)|-ne 512 -or \[int\]\$emergency/, path);
      assert.doesNotMatch(source, /"scheduler-worker"[^\n]*(?:"256" "512"|,256,512\b)/, path);
    }
  });
});
