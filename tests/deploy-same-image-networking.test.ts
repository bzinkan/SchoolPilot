import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const deploySource = readFileSync(new URL("../scripts/deploy.sh", import.meta.url), "utf8")
  .replace(/\r\n/g, "\n");
const libraryBoundary = deploySource.indexOf("# --- Preflight checks ---");
assert.ok(libraryBoundary > 0);
const deployLibrary = deploySource.slice(0, libraryBoundary);

const account = "135775632425";
const region = "us-east-1";
const digest = `sha256:${"5".repeat(64)}`;
const otherDigest = `sha256:${"6".repeat(64)}`;
const appSha = "805a0f73" + "a".repeat(32);
const apiSourceArn = `arn:aws:ecs:${region}:${account}:task-definition/schoolpilot-production-api-emergency:17`;
const workerSourceArn = `arn:aws:ecs:${region}:${account}:task-definition/schoolpilot-production-scheduler-worker:37`;
const apiCloneArn = `arn:aws:ecs:${region}:${account}:task-definition/schoolpilot-production-api-emergency:18`;
const workerCloneArn = `arn:aws:ecs:${region}:${account}:task-definition/schoolpilot-production-scheduler-worker:38`;
const image = `${account}.dkr.ecr.${region}.amazonaws.com/schoolpilot-production-api@${digest}`;
const canonicalNetwork = JSON.stringify({
  awsvpcConfiguration: {
    subnets: ["subnet-public-a", "subnet-public-b"],
    securityGroups: ["sg-ecs"],
    assignPublicIp: "ENABLED",
  },
});
const canonicalNetworkHash = createHash("sha256").update(canonicalNetwork).digest("hex");

function bashExecutable(): string {
  if (process.platform !== "win32") return "bash";
  return [
    "C:\\Program Files\\Git\\bin\\bash.exe",
    "C:\\Program Files\\Git\\usr\\bin\\bash.exe",
    "C:\\Program Files (x86)\\Git\\bin\\bash.exe",
  ].find(existsSync) ?? "bash";
}

function taskDefinition(arn: string, containerName: string, imageRef = image) {
  const familyRevision = arn.split("/").at(-1)!;
  const revision = Number(familyRevision.split(":").at(-1));
  const family = familyRevision.replace(/:[0-9]+$/, "");
  return {
    taskDefinition: {
      taskDefinitionArn: arn,
      containerDefinitions: [{
        name: containerName,
        image: imageRef,
        essential: true,
        environment: [{ name: "RUN_MIGRATIONS_ON_STARTUP", value: "false" }],
        secrets: [{ name: "JWT_SECRET", valueFrom: "arn:aws:ssm:us-east-1:135775632425:parameter/test" }],
      }],
      family,
      taskRoleArn: "arn:aws:iam::135775632425:role/task",
      executionRoleArn: "arn:aws:iam::135775632425:role/execution",
      networkMode: "awsvpc",
      revision,
      volumes: [],
      status: "ACTIVE",
      requiresAttributes: [],
      placementConstraints: [],
      compatibilities: ["EC2", "FARGATE"],
      requiresCompatibilities: ["FARGATE"],
      cpu: containerName === "api" ? "512" : "256",
      memory: containerName === "api" ? "2048" : "512",
      runtimePlatform: { cpuArchitecture: "ARM64", operatingSystemFamily: "LINUX" },
      registeredAt: "2026-07-17T00:00:00Z",
      registeredBy: "arn:aws:iam::135775632425:user/test",
      enableFaultInjection: false,
    },
    tags: [{ key: "Application", value: "SchoolPilot" }],
  };
}

function serviceResponse(
  apiTask = apiSourceArn,
  workerTask = workerSourceArn,
  subnets = ["subnet-public-b", "subnet-public-a"],
) {
  const network = {
    awsvpcConfiguration: {
      subnets,
      securityGroups: ["sg-ecs"],
      assignPublicIp: "ENABLED",
    },
  };
  const service = (name: string, task: string, worker: boolean) => ({
    serviceName: name,
    status: "ACTIVE",
    desiredCount: 1,
    runningCount: 1,
    pendingCount: 0,
    taskDefinition: task,
    deployments: [{
      status: "PRIMARY",
      rolloutState: "COMPLETED",
      failedTasks: 0,
      taskDefinition: task,
    }],
    deploymentConfiguration: {
      minimumHealthyPercent: 100,
      maximumPercent: 200,
      deploymentCircuitBreaker: { enable: true, rollback: true },
      strategy: "ROLLING",
    },
    loadBalancers: worker ? [] : [{ targetGroupArn: "arn:aws:elasticloadbalancing:targetgroup/test" }],
    networkConfiguration: network,
  });
  return {
    services: [
      service("schoolpilot-production-api", apiTask, false),
      service("schoolpilot-production-scheduler-worker", workerTask, true),
    ],
    failures: [],
  };
}

function runtimeNetworkEvidence(): Record<string, any> {
  const apiTaskArn = `arn:aws:ecs:${region}:${account}:task/schoolpilot-production-cluster/api-1`;
  const workerTaskArn = `arn:aws:ecs:${region}:${account}:task/schoolpilot-production-cluster/worker-1`;
  return {
    services: serviceResponse(),
    apiList: { taskArns: [apiTaskArn] },
    workerList: { taskArns: [workerTaskArn] },
    tasks: {
      tasks: [
        {
          taskArn: apiTaskArn,
          taskDefinitionArn: apiSourceArn,
          lastStatus: "RUNNING",
          group: "service:schoolpilot-production-api",
          attachments: [{ type: "ElasticNetworkInterface", details: [{ name: "networkInterfaceId", value: "eni-api1" }] }],
        },
        {
          taskArn: workerTaskArn,
          taskDefinitionArn: workerSourceArn,
          lastStatus: "RUNNING",
          group: "service:schoolpilot-production-scheduler-worker",
          attachments: [{ type: "ElasticNetworkInterface", details: [{ name: "networkInterfaceId", value: "eni-worker1" }] }],
        },
      ],
      failures: [],
    },
    enis: {
      NetworkInterfaces: [
        { NetworkInterfaceId: "eni-api1", Status: "in-use", SubnetId: "subnet-public-a", Groups: [{ GroupId: "sg-ecs" }], Association: { PublicIp: "198.51.100.10" }, PrivateIpAddress: "10.0.1.10" },
        { NetworkInterfaceId: "eni-worker1", Status: "in-use", SubnetId: "subnet-public-b", Groups: [{ GroupId: "sg-ecs" }], Association: { PublicIp: "198.51.100.11" }, PrivateIpAddress: "10.0.2.11" },
      ],
    },
    targetGroups: { TargetGroups: [{ TargetGroupArn: "arn:aws:elasticloadbalancing:targetgroup/test", Port: 3000, TargetType: "ip" }] },
    targetHealth: { TargetHealthDescriptions: [{ Target: { Id: "10.0.1.10", Port: 3000 }, TargetHealth: { State: "healthy" } }] },
  };
}

function runLibrary(body: string, files: Record<string, string> = {}) {
  const root = mkdtempSync(join(tmpdir(), "schoolpilot-same-image-deploy-"));
  for (const [name, value] of Object.entries(files)) writeFileSync(join(root, name), value);
  const shellRoot = root.replaceAll("\\", "/");
  const script = `
${deployLibrary}
cd "$TEST_ROOT"
ENV=production
DEPLOY_BACKEND=true
DEPLOY_FRONTEND=false
REGION=${region}
ACCOUNT_ID=${account}
PROJECT=schoolpilot
NAME=schoolpilot-production
ECR_REPO=${account}.dkr.ecr.${region}.amazonaws.com/schoolpilot-production-api
CLUSTER=schoolpilot-production-cluster
SERVICE=schoolpilot-production-api
WORKER_SERVICE=schoolpilot-production-scheduler-worker
AUTOSCALING_RESOURCE_ID=service/schoolpilot-production-cluster/schoolpilot-production-api
AUTOSCALING_DIMENSION=ecs:service:DesiredCount
SAME_IMAGE_NETWORKING_STAGE=PublicEcs
EXPECTED_APP_SHA=${appSha}
EXPECTED_IMAGE_DIGEST=${digest}
EXPECTED_API_TASK_DEFINITION=${apiSourceArn}
EXPECTED_WORKER_TASK_DEFINITION=${workerSourceArn}
EXPECTED_NETWORK_CONFIG_SHA256=${canonicalNetworkHash}
SKIP_WAIT=false
ACTIVATE_EMERGENCY=false
IMAGE_TAG=""
info() { printf 'INFO %s\\n' "$*"; }
success() { printf 'SUCCESS %s\\n' "$*"; }
warn() { printf 'WARN %s\\n' "$*" >&2; }
error() { printf 'ERROR %s\\n' "$*" >&2; }
sleep() { :; }
${body}
`;
  const result = spawnSync(bashExecutable(), ["-s"], {
    input: script,
    encoding: "utf8",
    env: { ...process.env, TEST_ROOT: shellRoot },
  });
  const outputs: Record<string, string> = {};
  for (const name of ["commands.log", "captured-api.json", ".same-image-network.json"]) {
    const path = join(root, name);
    if (existsSync(path)) outputs[name] = readFileSync(path, "utf8");
  }
  rmSync(root, { recursive: true, force: true });
  return { ...result, outputs };
}

describe("guarded same-image networking deployment", () => {
  it("requires the saved-plan validator canonical network hash", () => {
    const result = runLibrary(`
EXPECTED_NETWORK_CONFIG_SHA256=""
if validate_same_image_networking_mode; then exit 42; fi
`);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /requires --expected-network-config-sha256/);
  });

  it("has a backend-only branch that exits before every image publication path", () => {
    const functionStart = deploySource.indexOf("same_image_networking_redeploy() {");
    const functionEnd = deploySource.indexOf("# --- Preflight checks ---", functionStart);
    const sameImageFunction = deploySource.slice(functionStart, functionEnd);
    assert.doesNotMatch(sameImageFunction, /\bdocker\s+(?:build|tag|push|login)\b/);
    assert.doesNotMatch(sameImageFunction, /\b(?:put-image|batch-delete-image|create-repository)\b/);

    const execution = deploySource.slice(libraryBoundary);
    const dispatch = execution.indexOf("same_image_networking_redeploy");
    const exit = execution.indexOf("exit 0", dispatch);
    const build = execution.indexOf("docker build", dispatch);
    assert.ok(dispatch > 0 && dispatch < exit && exit < build);
    assert.doesNotMatch(execution.slice(0, dispatch), /\bdocker\s+(?:build|tag|push|login)\b/);
  });

  it("rejects mutable references and a digest mismatch before registration", () => {
    for (const [name, imageRef] of [
      ["mutable", `${account}.dkr.ecr.${region}.amazonaws.com/schoolpilot-production-api:latest`],
      ["wrong-digest", `${account}.dkr.ecr.${region}.amazonaws.com/schoolpilot-production-api@${otherDigest}`],
    ]) {
      const result = runLibrary(`
aws() {
  if [[ "$1 $2" == "ecs describe-task-definition" ]]; then cat "$TEST_ROOT/source.json"; return 0; fi
  printf 'mutation %s\\n' "$*" >> "$TEST_ROOT/commands.log"
  return 91
}
if render_same_image_clone_request api "$EXPECTED_API_TASK_DEFINITION" api; then
  echo "unexpected acceptance" >&2
  exit 42
fi
`, { "source.json": JSON.stringify(taskDefinition(apiSourceArn, "api", imageRef)) });
      assert.equal(result.status, 0, `${name}: ${result.stderr}`);
      assert.match(result.stderr, /mutable, mismatched, or cannot be cloned exactly/);
      assert.equal(result.outputs["commands.log"], undefined, `${name} must fail before registration`);
    }
  });

  it("rejects an ECR SHA-to-digest mismatch", () => {
    const result = runLibrary(`
git() { printf '%s\\n' "$EXPECTED_APP_SHA"; }
aws() {
  printf '%s\\n' '${otherDigest}'
}
if same_image_application_identity_preflight; then exit 42; fi
`);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /SHA tag and deployed image digest do not match/);
  });

  it("registers and verifies a field-for-field digest-preserving clone", () => {
    const result = runLibrary(`
aws() {
  if [[ "$1 $2" == "ecs describe-task-definition" ]]; then
    local ref="" index
    for ((index=1; index<=$#; index++)); do
      if [[ "\${!index}" == "--task-definition" ]]; then index=$((index+1)); ref="\${!index}"; break; fi
    done
    if [[ "$ref" == "$EXPECTED_API_TASK_DEFINITION" ]]; then
      cat "$TEST_ROOT/source-api.json"
    elif [[ "$ref" == "$EXPECTED_WORKER_TASK_DEFINITION" ]]; then
      cat "$TEST_ROOT/source-worker.json"
    else
      local label=api registered='${apiCloneArn}'
      [[ "$ref" == '${workerCloneArn}' ]] && label=worker && registered='${workerCloneArn}'
      REQUEST_PATH="$TEST_ROOT/captured-$label.json" REGISTERED_ARN="$registered" node -e '
        const fs=require("fs"); const request=JSON.parse(fs.readFileSync(process.env.REQUEST_PATH,"utf8"));
        const tags=request.tags || []; delete request.tags;
        const revision=Number(process.env.REGISTERED_ARN.split(":").at(-1));
        process.stdout.write(JSON.stringify({taskDefinition:{...request,taskDefinitionArn:process.env.REGISTERED_ARN,revision,status:"ACTIVE",requiresAttributes:[],compatibilities:["EC2","FARGATE"],registeredAt:"now",registeredBy:"test"},tags}));
      '
    fi
    return 0
  fi
  if [[ "$1 $2" == "ecs register-task-definition" ]]; then
    local ref="" index
    for ((index=1; index<=$#; index++)); do
      if [[ "\${!index}" == "--cli-input-json" ]]; then index=$((index+1)); ref="\${!index}"; break; fi
    done
    local label=api registered='${apiCloneArn}'
    [[ "$ref" == *worker* ]] && label=worker && registered='${workerCloneArn}'
    cp "\${ref#file://}" "$TEST_ROOT/captured-$label.json"
    printf '{"taskDefinition":{"taskDefinitionArn":"%s"}}\\n' "$registered"
    return 0
  fi
  return 91
}
render_same_image_clone_request api "$EXPECTED_API_TASK_DEFINITION" api
render_same_image_clone_request worker "$EXPECTED_WORKER_TASK_DEFINITION" scheduler-worker
register_same_image_clone_request api "$EXPECTED_API_TASK_DEFINITION" api
register_same_image_clone_request worker "$EXPECTED_WORKER_TASK_DEFINITION" scheduler-worker
[[ "$SAME_IMAGE_API_TASK_DEFINITION" == '${apiCloneArn}' ]]
[[ "$SAME_IMAGE_WORKER_TASK_DEFINITION" == '${workerCloneArn}' ]]
node -e '
  const fs=require("fs");
  for (const label of ["api","worker"]) {
    const source=JSON.parse(fs.readFileSync(process.env.TEST_ROOT+"/source-"+label+".json","utf8"));
    const clone=JSON.parse(fs.readFileSync(process.env.TEST_ROOT+"/captured-"+label+".json","utf8"));
    if (clone.containerDefinitions[0].image !== source.taskDefinition.containerDefinitions[0].image ||
        clone.cpu !== source.taskDefinition.cpu || clone.memory !== source.taskDefinition.memory ||
        clone.taskRoleArn !== source.taskDefinition.taskRoleArn || clone.tags[0].value !== source.tags[0].value) process.exit(1);
  }
'
`, {
      "source-api.json": JSON.stringify(taskDefinition(apiSourceArn, "api")),
      "source-worker.json": JSON.stringify(taskDefinition(workerSourceArn, "scheduler-worker")),
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Registered exact same-image api clone/);
    assert.match(result.stdout, /Registered exact same-image worker clone/);
  });

  it("enforces PublicEcs two-NAT and NatRemoved zero-NAT live posture", () => {
    const cases = [
      { stage: "PublicEcs", states: ["available", "available"], accepted: true },
      { stage: "PublicEcs", states: ["available"], accepted: false },
      { stage: "NatRemoved", states: [], accepted: true },
      { stage: "NatRemoved", states: ["deleting"], accepted: false },
    ];
    for (const testCase of cases) {
      const nats = testCase.states.map((State, index) => ({ NatGatewayId: `nat-${index}`, State }));
      const result = runLibrary(`
SAME_IMAGE_NETWORKING_STAGE=${testCase.stage}
aws() {
  if [[ "$1 $2" == "ecs describe-services" ]]; then cat "$TEST_ROOT/services.json"; return 0; fi
  if [[ "$1 $2" == "ec2 describe-subnets" ]]; then cat "$TEST_ROOT/subnets.json"; return 0; fi
  if [[ "$1 $2" == "ec2 describe-nat-gateways" ]]; then cat "$TEST_ROOT/nats.json"; return 0; fi
  if [[ "$1 $2" == "ec2 describe-route-tables" ]]; then cat "$TEST_ROOT/routes.json"; return 0; fi
  if [[ "$1 $2" == "ec2 describe-internet-gateways" ]]; then cat "$TEST_ROOT/igws.json"; return 0; fi
  return 91
}
same_image_service_contract_preflight "$EXPECTED_API_TASK_DEFINITION" "$EXPECTED_WORKER_TASK_DEFINITION" test
same_image_nat_posture_preflight
`, {
        "services.json": JSON.stringify(serviceResponse()),
        "subnets.json": JSON.stringify({ Subnets: [
          { SubnetId: "subnet-public-a", VpcId: "vpc-1", State: "available" },
          { SubnetId: "subnet-public-b", VpcId: "vpc-1", State: "available" },
        ] }),
        "nats.json": JSON.stringify({ NatGateways: nats }),
        "routes.json": JSON.stringify({ RouteTables: [{
          RouteTableId: "rtb-public",
          Associations: [{ Main: true }],
          Routes: [{ DestinationCidrBlock: "0.0.0.0/0", GatewayId: "igw-123", State: "active" }],
        }] }),
        "igws.json": JSON.stringify({ InternetGateways: [{
          InternetGatewayId: "igw-123",
          Attachments: [{ VpcId: "vpc-1", State: "available" }],
        }] }),
      });
      assert.equal(result.status === 0, testCase.accepted, `${testCase.stage}/${testCase.states}: ${result.stderr}`);
      if (!testCase.accepted) assert.match(result.stderr, /Live NAT posture does not match/);
    }
  });

  it("fails closed on mixed revisions, failed tasks, or unsafe deployment policy", () => {
    const cases = [
      (() => {
        const value = serviceResponse();
        value.services[0].deployments[0].failedTasks = 1;
        return value;
      })(),
      serviceResponse(apiCloneArn, workerSourceArn),
      (() => {
        const value = serviceResponse();
        value.services[1].deploymentConfiguration.minimumHealthyPercent = 50;
        return value;
      })(),
    ];
    for (const services of cases) {
      const result = runLibrary(`
aws() { cat "$TEST_ROOT/services.json"; }
same_image_service_contract_preflight "$EXPECTED_API_TASK_DEFINITION" "$EXPECTED_WORKER_TASK_DEFINITION" test
`, { "services.json": JSON.stringify(services) });
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /violated exact identity, public-network, deployment-policy, or stability/);
    }
  });

  it("binds the first canonical network hash and rejects later configuration drift", () => {
    const result = runLibrary(`
aws() {
  local count=0
  [[ -f "$TEST_ROOT/service-count" ]] && count=$(cat "$TEST_ROOT/service-count")
  count=$((count+1)); printf '%s' "$count" > "$TEST_ROOT/service-count"
  if [[ "$count" == 1 ]]; then cat "$TEST_ROOT/services-1.json"; else cat "$TEST_ROOT/services-2.json"; fi
}
same_image_service_contract_preflight "$EXPECTED_API_TASK_DEFINITION" "$EXPECTED_WORKER_TASK_DEFINITION" initial
initial_hash="$SAME_IMAGE_BOUND_NETWORK_HASH"
if same_image_service_contract_preflight "$EXPECTED_API_TASK_DEFINITION" "$EXPECTED_WORKER_TASK_DEFINITION" later; then
  exit 42
fi
[[ -n "$initial_hash" && "$SAME_IMAGE_BOUND_NETWORK_HASH" == "$initial_hash" && "$SAME_IMAGE_NETWORK_HASH" == "$initial_hash" ]]
node -e '
  const fs=require("fs"); const network=JSON.parse(fs.readFileSync(".same-image-network.json","utf8"));
  if (network.awsvpcConfiguration.subnets.join(",") !== "subnet-public-a,subnet-public-b") process.exit(1);
'
`, {
      "services-1.json": JSON.stringify(serviceResponse()),
      "services-2.json": JSON.stringify(serviceResponse(apiSourceArn, workerSourceArn, ["subnet-public-a", "subnet-public-c"])),
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /network configuration drifted after its initial same-image binding/);
  });

  it("rejects a first observation that differs from an attested network hash", () => {
    const canonical = JSON.stringify({
      awsvpcConfiguration: {
        subnets: ["subnet-public-a", "subnet-public-b"],
        securityGroups: ["sg-ecs"],
        assignPublicIp: "ENABLED",
      },
    });
    const actualHash = createHash("sha256").update(canonical).digest("hex");
    assert.notEqual(actualHash, "0".repeat(64));
    const result = runLibrary(`
EXPECTED_NETWORK_CONFIG_SHA256='${"0".repeat(64)}'
aws() { cat "$TEST_ROOT/services.json"; }
if same_image_service_contract_preflight "$EXPECTED_API_TASK_DEFINITION" "$EXPECTED_WORKER_TASK_DEFINITION" attested; then exit 42; fi
`, { "services.json": JSON.stringify(serviceResponse()) });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /does not match the attested expected SHA-256/);
  });

  it("proves every running task, ENI public address, subnet, security group, and API target", () => {
    const evidence = runtimeNetworkEvidence();
    const result = runLibrary(`
aws() {
  if [[ "$1 $2" == "ecs describe-services" ]]; then cat "$TEST_ROOT/services.json"; return 0; fi
  if [[ "$1 $2" == "ecs list-tasks" ]]; then
    if [[ " $* " == *" --service-name $WORKER_SERVICE "* ]]; then cat "$TEST_ROOT/worker-list.json"; else cat "$TEST_ROOT/api-list.json"; fi
    return 0
  fi
  if [[ "$1 $2" == "ecs describe-tasks" ]]; then cat "$TEST_ROOT/tasks.json"; return 0; fi
  if [[ "$1 $2" == "ec2 describe-network-interfaces" ]]; then cat "$TEST_ROOT/enis.json"; return 0; fi
  if [[ "$1 $2" == "elbv2 describe-target-groups" ]]; then cat "$TEST_ROOT/target-groups.json"; return 0; fi
  if [[ "$1 $2" == "elbv2 describe-target-health" ]]; then cat "$TEST_ROOT/target-health.json"; return 0; fi
  return 91
}
same_image_runtime_task_network_preflight "$EXPECTED_API_TASK_DEFINITION" "$EXPECTED_WORKER_TASK_DEFINITION" runtime-test
`, {
      ".same-image-network.json": canonicalNetwork,
      "services.json": JSON.stringify(evidence.services),
      "api-list.json": JSON.stringify(evidence.apiList),
      "worker-list.json": JSON.stringify(evidence.workerList),
      "tasks.json": JSON.stringify(evidence.tasks),
      "enis.json": JSON.stringify(evidence.enis),
      "target-groups.json": JSON.stringify(evidence.targetGroups),
      "target-health.json": JSON.stringify(evidence.targetHealth),
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Every running API\/worker task, ENI, public IPv4, and healthy API target was verified/);
  });

  it("rejects missing/extra runtime identity and ENI/ALB posture", () => {
    const cases = [
      {
        name: "extra task",
        mutate(value: Record<string, any>) { value.tasks.tasks.push({ ...value.tasks.tasks[0], taskArn: `${value.tasks.tasks[0].taskArn}-extra` }); },
      },
      {
        name: "missing public IPv4",
        mutate(value: Record<string, any>) { value.enis.NetworkInterfaces[0].Association = null; },
      },
      {
        name: "wrong security group",
        mutate(value: Record<string, any>) { value.enis.NetworkInterfaces[1].Groups = [{ GroupId: "sg-other" }]; },
      },
      {
        name: "unreviewed subnet",
        mutate(value: Record<string, any>) { value.enis.NetworkInterfaces[1].SubnetId = "subnet-private-c"; },
      },
      {
        name: "unhealthy target",
        mutate(value: Record<string, any>) { value.targetHealth.TargetHealthDescriptions[0].TargetHealth.State = "draining"; },
      },
    ];
    for (const testCase of cases) {
      const evidence = runtimeNetworkEvidence();
      testCase.mutate(evidence);
      const result = runLibrary(`
aws() {
  if [[ "$1 $2" == "ecs describe-services" ]]; then cat "$TEST_ROOT/services.json"; return 0; fi
  if [[ "$1 $2" == "ecs list-tasks" ]]; then
    if [[ " $* " == *" --service-name $WORKER_SERVICE "* ]]; then cat "$TEST_ROOT/worker-list.json"; else cat "$TEST_ROOT/api-list.json"; fi
    return 0
  fi
  if [[ "$1 $2" == "ecs describe-tasks" ]]; then cat "$TEST_ROOT/tasks.json"; return 0; fi
  if [[ "$1 $2" == "ec2 describe-network-interfaces" ]]; then cat "$TEST_ROOT/enis.json"; return 0; fi
  if [[ "$1 $2" == "elbv2 describe-target-groups" ]]; then cat "$TEST_ROOT/target-groups.json"; return 0; fi
  if [[ "$1 $2" == "elbv2 describe-target-health" ]]; then cat "$TEST_ROOT/target-health.json"; return 0; fi
  return 91
}
same_image_runtime_task_network_preflight "$EXPECTED_API_TASK_DEFINITION" "$EXPECTED_WORKER_TASK_DEFINITION" runtime-test
`, {
        ".same-image-network.json": canonicalNetwork,
        "services.json": JSON.stringify(evidence.services),
        "api-list.json": JSON.stringify(evidence.apiList),
        "worker-list.json": JSON.stringify(evidence.workerList),
        "tasks.json": JSON.stringify(evidence.tasks),
        "enis.json": JSON.stringify(evidence.enis),
        "target-groups.json": JSON.stringify(evidence.targetGroups),
        "target-health.json": JSON.stringify(evidence.targetHealth),
      });
      assert.notEqual(result.status, 0, `${testCase.name} unexpectedly passed`);
      assert.match(result.stderr, /mixed or incomplete|failed exact verification/, testCase.name);
    }
  });

  it("rejects public subnets whose effective default route is not the attached IGW", () => {
    const result = runLibrary(`
aws() {
  if [[ "$1 $2" == "ecs describe-services" ]]; then cat "$TEST_ROOT/services.json"; return 0; fi
  if [[ "$1 $2" == "ec2 describe-subnets" ]]; then cat "$TEST_ROOT/subnets.json"; return 0; fi
  if [[ "$1 $2" == "ec2 describe-nat-gateways" ]]; then cat "$TEST_ROOT/nats.json"; return 0; fi
  if [[ "$1 $2" == "ec2 describe-route-tables" ]]; then cat "$TEST_ROOT/routes.json"; return 0; fi
  if [[ "$1 $2" == "ec2 describe-internet-gateways" ]]; then cat "$TEST_ROOT/igws.json"; return 0; fi
  return 91
}
same_image_service_contract_preflight "$EXPECTED_API_TASK_DEFINITION" "$EXPECTED_WORKER_TASK_DEFINITION" route-test
same_image_nat_posture_preflight
`, {
      "services.json": JSON.stringify(serviceResponse()),
      "subnets.json": JSON.stringify({ Subnets: [
        { SubnetId: "subnet-public-a", VpcId: "vpc-1", State: "available" },
        { SubnetId: "subnet-public-b", VpcId: "vpc-1", State: "available" },
      ] }),
      "nats.json": JSON.stringify({ NatGateways: [{ State: "available" }, { State: "available" }] }),
      "routes.json": JSON.stringify({ RouteTables: [{
        Associations: [{ Main: true }],
        Routes: [{ DestinationCidrBlock: "0.0.0.0/0", NatGatewayId: "nat-1", State: "active" }],
      }] }),
      "igws.json": JSON.stringify({ InternetGateways: [{
        InternetGatewayId: "igw-123",
        Attachments: [{ VpcId: "vpc-1", State: "available" }],
      }] }),
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /active IPv4 default route to the VPC's attached internet gateway/);
  });

  it("runs the cloned API migration with migrations-only overrides before service work", () => {
    const result = runLibrary(`
SAME_IMAGE_API_TASK_DEFINITION='${apiCloneArn}'
printf '{"awsvpcConfiguration":{"subnets":["a","b"],"securityGroups":["sg"],"assignPublicIp":"ENABLED"}}' > .same-image-network.json
wait_for_migration_task_stopped() { printf 'WAIT-MIGRATION %s\\n' "$*" >> "$TEST_ROOT/commands.log"; return 0; }
aws() {
  printf 'AWS %s\\n' "$*" >> "$TEST_ROOT/commands.log"
  if [[ "$1 $2" == "ecs run-task" ]]; then
    printf '{"tasks":[{"taskArn":"arn:aws:ecs:us-east-1:135775632425:task/test"}],"failures":[]}\\n'
    return 0
  fi
  if [[ "$1 $2" == "ecs describe-tasks" ]]; then
    printf '{"tasks":[{"taskArn":"arn:aws:ecs:us-east-1:135775632425:task/test","lastStatus":"STOPPED","containers":[{"name":"api","exitCode":0}]}],"failures":[]}\\n'
    return 0
  fi
  return 91
}
run_same_image_migration_task
`);
    assert.equal(result.status, 0, result.stderr);
    const log = result.outputs["commands.log"]!;
    assert.match(log, new RegExp(`ecs run-task .*--task-definition ${apiCloneArn.replaceAll("/", "\\/")}`));
    assert.match(log, /RUN_MIGRATIONS_ONLY.*true.*SCHEDULER_ENABLED.*false/);
    assert.match(log, /WAIT-MIGRATION arn:aws:ecs:us-east-1:135775632425:task\/test/);
    assert.match(log, /ecs describe-tasks/);
    assert.match(result.stdout, /startup migrations completed/);
  });

  it("bounds migration stop observation after the one-hour controller deadline", () => {
    const result = runLibrary(`
MIGRATION_TASK_WAIT_SECONDS=0
MIGRATION_TASK_STOP_WAIT_SECONDS=0
MIGRATION_TASK_POLL_SECONDS=0
aws() {
  printf 'AWS %s\\n' "$*" >> "$TEST_ROOT/commands.log"
  if [[ "$1 $2" == "ecs describe-tasks" ]]; then printf 'RUNNING\\n'; return 0; fi
  if [[ "$1 $2" == "ecs stop-task" ]]; then printf '{}\\n'; return 0; fi
  return 91
}
set +e
wait_for_migration_task_stopped arn:aws:ecs:us-east-1:135775632425:task/stuck
code=$?
set -e
[[ "$code" == 125 ]]
`);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /did not report STOPPED within 0s after the stop deadline/);
    const log = result.outputs["commands.log"]!;
    assert.equal((log.match(/ecs describe-tasks/g) || []).length, 1);
    assert.equal((log.match(/ecs stop-task/g) || []).length, 1);
    assert.match(deploySource, /MIGRATION_TASK_STOP_WAIT_SECONDS=300/);
  });

  it("orchestrates API-first rollout, waiter, strict convergence, and exact scaling restore", () => {
    const result = runLibrary(`
log_step() { printf '%s\\n' "$1" >> "$TEST_ROOT/commands.log"; }
same_image_application_identity_preflight() { log_step identity; }
same_image_service_contract_preflight() { log_step "service:$1:$2:$3"; SAME_IMAGE_NETWORK_HASH=abc; }
same_image_runtime_task_network_preflight() { log_step "runtime:$1:$2:$3"; }
same_image_nat_posture_preflight() { log_step nat; }
same_image_autoscaling_contract_preflight() { log_step autoscaling; }
render_same_image_clone_request() { log_step "render:$1"; }
register_same_image_clone_request() {
  log_step "register:$1"
  if [[ "$1" == api ]]; then SAME_IMAGE_API_TASK_DEFINITION='${apiCloneArn}'; else SAME_IMAGE_WORKER_TASK_DEFINITION='${workerCloneArn}'; fi
}
acquire_production_scaling_hold() { log_step hold; PRODUCTION_SCALING_HOLD_ACTIVE=true; }
run_same_image_migration_task() { log_step migration; }
production_backend_deploy_window_preflight() { log_step window; }
production_backend_capacity_preflight() { log_step capacity; }
wait_for_production_backend_strict_stability() { log_step "strict:$1:$2"; }
restore_production_scaling_hold() { log_step restore; PRODUCTION_SCALING_HOLD_ACTIVE=false; }
aws() { log_step "aws:$*"; }
same_image_networking_redeploy
`);
    assert.equal(result.status, 0, result.stderr);
    const lines = result.outputs["commands.log"]!.trim().split(/\r?\n/);
    const index = (prefix: string) => lines.findIndex((line) => line.startsWith(prefix));
    assert.ok(index("identity") < index("render:api"));
    assert.ok(index("render:worker") < index("register:api"));
    assert.ok(index("register:worker") < index("hold"));
    assert.ok(index("hold") < index("migration"));
    assert.ok(index("migration") < index("aws:ecs update-service --cluster schoolpilot-production-cluster --service schoolpilot-production-api"));
    assert.ok(index("aws:ecs update-service --cluster schoolpilot-production-cluster --service schoolpilot-production-api") <
      index("aws:ecs update-service --cluster schoolpilot-production-cluster --service schoolpilot-production-scheduler-worker"));
    assert.ok(index("aws:ecs wait services-stable") < index("strict:"));
    assert.match(lines[index("strict:")], new RegExp(`${apiCloneArn.replaceAll("/", "\\/")}.*${workerCloneArn.replaceAll("/", "\\/")}`));
    assert.ok(index("strict:") < index("restore"));
    assert.match(result.stdout, /PublicEcs same-image deployment complete/);
  });

  it("keeps the hold through bounded recovery after API or worker update failure", () => {
    for (const failureCall of [1, 2, 0]) {
      const result = runLibrary(`
log_step() { printf '%s\\n' "$1" >> "$TEST_ROOT/commands.log"; }
cleanup_temp_files() { log_step cleanup; }
same_image_application_identity_preflight() { :; }
same_image_service_contract_preflight() { SAME_IMAGE_BOUND_NETWORK_HASH=abc; SAME_IMAGE_NETWORK_HASH=abc; }
same_image_runtime_task_network_preflight() { :; }
same_image_nat_posture_preflight() { :; }
same_image_autoscaling_contract_preflight() { :; }
render_same_image_clone_request() { :; }
register_same_image_clone_request() {
  if [[ "$1" == api ]]; then SAME_IMAGE_API_TASK_DEFINITION='${apiCloneArn}'; else SAME_IMAGE_WORKER_TASK_DEFINITION='${workerCloneArn}'; fi
}
acquire_production_scaling_hold() { log_step hold; PRODUCTION_SCALING_HOLD_ACTIVE=true; }
run_same_image_migration_task() { log_step migration; }
production_backend_deploy_window_preflight() { :; }
production_backend_capacity_preflight() { :; }
observe_same_image_safe_terminal() {
  local count=0
  [[ -f "$TEST_ROOT/observe-count" ]] && count=$(cat "$TEST_ROOT/observe-count")
  count=$((count+1)); printf '%s' "$count" > "$TEST_ROOT/observe-count"
  log_step "observe:$count"
  if [[ "$count" -ge 2 ]]; then SAME_IMAGE_RECOVERY_TERMINAL=candidate; return 0; fi
  return 1
}
restore_production_scaling_hold() { log_step restore; PRODUCTION_SCALING_HOLD_ACTIVE=false; }
aws() {
  if [[ "$1 $2" == "ecs update-service" ]]; then
    local count=0
    [[ -f "$TEST_ROOT/update-count" ]] && count=$(cat "$TEST_ROOT/update-count")
    count=$((count+1)); printf '%s' "$count" > "$TEST_ROOT/update-count"
    log_step "update:$count:$*"
    [[ "$count" == '${failureCall}' ]] && return 42
    return 0
  fi
  if [[ "$1 $2 $3" == "ecs wait services-stable" ]]; then
    log_step wait-failed
    [[ '${failureCall}' == 0 ]] && return 42
    return 0
  fi
  log_step "unexpected-aws:$*"
  return 91
}
trap deploy_exit_cleanup EXIT
same_image_networking_redeploy
`);
      assert.notEqual(result.status, 0);
      const lines = result.outputs["commands.log"]!.trim().split(/\r?\n/);
      const updates = lines.filter((line) => line.startsWith("update:"));
      assert.equal(updates.length, failureCall === 1 ? 3 : 4, result.stderr);
      assert.ok(updates.every((line) =>
        (line.includes("--service schoolpilot-production-api") && line.includes(apiCloneArn)) ||
        (line.includes("--service schoolpilot-production-scheduler-worker") && line.includes(workerCloneArn))
      ));
      const restore = lines.indexOf("restore");
      assert.ok(restore > lines.lastIndexOf("observe:2"));
      assert.ok(restore > lines.lastIndexOf(updates.at(-1)!));
      if (failureCall === 0) assert.ok(lines.indexOf("wait-failed") < lines.indexOf("observe:1"));
      assert.match(result.stderr, /retaining the autoscaling hold during bounded terminal-state recovery/);
      assert.match(result.stdout, /reached exact candidate revisions while the autoscaling hold remained active/);
    }
  });

  it("emits a bounded hard-stop record and intentionally retains the hold when recovery cannot converge", () => {
    const result = runLibrary(`
log_step() { printf '%s\\n' "$1" >> "$TEST_ROOT/commands.log"; }
cleanup_temp_files() { log_step cleanup; }
observe_same_image_safe_terminal() { log_step observe; return 1; }
restore_production_scaling_hold() { log_step restore-unsafe; PRODUCTION_SCALING_HOLD_ACTIVE=false; }
aws() { log_step "reassert:$*"; return 0; }
SAME_IMAGE_API_TASK_DEFINITION='${apiCloneArn}'
SAME_IMAGE_WORKER_TASK_DEFINITION='${workerCloneArn}'
SAME_IMAGE_BOUND_NETWORK_HASH='${"a".repeat(64)}'
SAME_IMAGE_RECOVERY_MAX_ATTEMPTS=2
SAME_IMAGE_RECOVERY_POLL_SECONDS=0
SAME_IMAGE_SERVICE_MUTATION_STARTED=true
PRODUCTION_SCALING_HOLD_ACTIVE=true
trap deploy_exit_cleanup EXIT
false
`);
    assert.notEqual(result.status, 0);
    const lines = result.outputs["commands.log"]!.trim().split(/\r?\n/);
    assert.equal(lines.includes("restore-unsafe"), false);
    assert.equal(lines.filter((line) => line === "observe").length, 3);
    assert.equal(lines.filter((line) => line.startsWith("reassert:ecs update-service")).length, 2);
    assert.equal(lines.at(-1), "cleanup");
    assert.match(result.stderr, /SAME_IMAGE_HARD_STOP_RECORD \{"schemaVersion":1/);
    assert.match(result.stderr, /"dynamicAutoscalingHoldRetained":true/);
    assert.match(result.stderr, /Dynamic autoscaling remains suspended/);
  });

  it("restores the scaling hold from the EXIT trap and never updates a service after migration failure", () => {
    const result = runLibrary(`
log_step() { printf '%s\\n' "$1" >> "$TEST_ROOT/commands.log"; }
cleanup_temp_files() { log_step cleanup; }
same_image_application_identity_preflight() { :; }
same_image_service_contract_preflight() { SAME_IMAGE_NETWORK_HASH=abc; }
same_image_runtime_task_network_preflight() { :; }
same_image_nat_posture_preflight() { :; }
same_image_autoscaling_contract_preflight() { :; }
render_same_image_clone_request() { :; }
register_same_image_clone_request() {
  if [[ "$1" == api ]]; then SAME_IMAGE_API_TASK_DEFINITION='${apiCloneArn}'; else SAME_IMAGE_WORKER_TASK_DEFINITION='${workerCloneArn}'; fi
}
acquire_production_scaling_hold() { log_step hold; PRODUCTION_SCALING_HOLD_ACTIVE=true; }
run_same_image_migration_task() { log_step migration-failed; return 1; }
restore_production_scaling_hold() { log_step restore; PRODUCTION_SCALING_HOLD_ACTIVE=false; }
aws() { log_step "aws:$*"; }
trap deploy_exit_cleanup EXIT
same_image_networking_redeploy
`);
    assert.notEqual(result.status, 0);
    const lines = result.outputs["commands.log"]!.trim().split(/\r?\n/);
    assert.deepEqual(lines, ["hold", "migration-failed", "restore", "cleanup"]);
    assert.equal(lines.some((line) => line.includes("update-service")), false);
    assert.match(result.stderr, /autoscaling hold was active; attempting recovery/);
  });
});
