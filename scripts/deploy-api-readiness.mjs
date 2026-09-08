#!/usr/bin/env node
// Separate, exact-release activation of ALB readiness. Never updates ECS or Terraform.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

export const CONTRACT = Object.freeze({ account: '135775632425', region: 'us-east-1',
  cluster: 'schoolpilot-production-cluster', api: 'schoolpilot-production-api',
  worker: 'schoolpilot-production-scheduler-worker', sourcePath: '/livez', path: '/readyz',
  contractVersion: 1, sampleIntervalMs: 1000, stallThresholdMs: 60000, confirmationIntervalMs: 10000 });
const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const canonical = (v) => Array.isArray(v) ? v.map(canonical) : v && typeof v === 'object'
  ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canonical(v[k])])) : v;
export const hash = (v) => createHash('sha256').update(typeof v === 'string' ? v : JSON.stringify(canonical(v))).digest('hex');
function requireThat(condition, message) { if (!condition) throw new Error(message); }
const same = (a, b) => hash(a) === hash(b);
export function externalPath(path) {
  requireThat(typeof path === 'string' && isAbsolute(path), 'Evidence path must be absolute and outside the checkout.');
  const result = resolve(path);
  const local = relative(repository, result);
  requireThat(local !== '' && (local === '..' || local.startsWith(`..${sep}`) || isAbsolute(local)),
    'Evidence must remain outside the checkout.');
  return result;
}
function writeEvidence(path, value) {
  externalPath(path);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
}
export async function aws(args) {
  try {
    const result = execFileSync('aws', [...args, '--region', CONTRACT.region, '--output', 'json',
      '--no-cli-pager', '--cli-connect-timeout', '5', '--cli-read-timeout', '10'],
    { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
    return JSON.parse(result);
  } catch { throw new Error(`AWS ${args[0]} ${args[1]} failed; no response or credentials were recorded.`); }
}
export function validateExpected(expected) {
  const prefix = `arn:aws:ecs:${CONTRACT.region}:${CONTRACT.account}:task-definition/`;
  requireThat(/^[a-f0-9]{40}$/.test(expected.sha || ''), 'Expected SHA must be a full lowercase Git SHA.');
  requireThat(/^sha256:[a-f0-9]{64}$/.test(expected.digest || ''), 'Expected image digest is invalid.');
  requireThat(new RegExp(`^${prefix}schoolpilot-production-api(?:-emergency)?:[1-9][0-9]*$`).test(expected.api || ''), 'Expected API task definition is invalid.');
  requireThat(new RegExp(`^${prefix}schoolpilot-production-scheduler-worker:[1-9][0-9]*$`).test(expected.worker || ''), 'Expected worker task definition is invalid.');
}
function serviceIdentity(service, expectedArn, role, allowTaskChurn = false) {
  const deployments = service.deployments || [];
  const clusterArn = `arn:aws:ecs:${CONTRACT.region}:${CONTRACT.account}:cluster/${CONTRACT.cluster}`;
  const serviceArn = `arn:aws:ecs:${CONTRACT.region}:${CONTRACT.account}:service/${CONTRACT.cluster}/${CONTRACT[role]}`;
  requireThat(service.clusterArn === clusterArn && service.serviceArn === serviceArn &&
    service.status === 'ACTIVE' && service.deploymentController?.type === 'ECS' &&
    service.taskDefinition === expectedArn && service.desiredCount >= 1 &&
    service.desiredCount <= (role === 'api' ? 3 : 1) && deployments.length >= 1 &&
    deployments.every((d) => d.taskDefinition === expectedArn), 'Service ownership or exact source changed.');
  requireThat(allowTaskChurn || (service.runningCount === service.desiredCount &&
    service.pendingCount === 0 && deployments.length === 1 && deployments[0].status === 'PRIMARY' &&
    deployments[0].rolloutState === 'COMPLETED' && deployments[0].taskDefinition === expectedArn &&
    deployments[0].failedTasks === 0 && deployments[0].runningCount === service.desiredCount &&
    deployments[0].desiredCount === service.desiredCount && deployments[0].pendingCount === 0),
  `${role} must be exactly converged on the expected task definition.`);
  return { serviceArn, clusterArn, taskDefinition: expectedArn, desiredCount: service.desiredCount,
    configurationHash: hash({ deploymentConfiguration: service.deploymentConfiguration,
      networkConfiguration: service.networkConfiguration, loadBalancers: service.loadBalancers,
      capacityProviderStrategy: service.capacityProviderStrategy, launchType: service.launchType }) };
}
function targetShape(group) {
  const { HealthCheckPath, ...other } = group;
  return { path: HealthCheckPath, configurationHash: hash(other) };
}
function assertHealthy(health, expectedTargets) {
  const rows = health.TargetHealthDescriptions || [];
  requireThat(rows.length === expectedTargets.length && rows.every((r) => r.TargetHealth?.State === 'healthy') &&
    same(rows.map((r) => `${r.Target?.Id}:${r.Target?.Port}`).sort(), expectedTargets),
  'All and only the exact running API task targets must be healthy.');
}
export async function inspect(expected, invoke = aws, { requireHealthy = true, markers = true, allowTaskChurn = false } = {}) {
  validateExpected(expected);
  requireThat((await invoke(['sts', 'get-caller-identity'])).Account === CONTRACT.account, 'Wrong AWS account.');
  const response = await invoke(['ecs', 'describe-services', '--cluster', CONTRACT.cluster, '--services', CONTRACT.api, CONTRACT.worker]);
  requireThat(response.failures?.length === 0 && response.services?.length === 2, 'Both exact production services are required.');
  const result = { expected, services: {}, tasks: [], markers: [] };
  let apiService;
  for (const role of ['api', 'worker']) {
    const name = CONTRACT[role];
    const matches = response.services.filter((s) => s.serviceName === name);
    requireThat(matches.length === 1, 'Service identity is ambiguous.');
    const service = matches[0];
    result.services[role] = serviceIdentity(service, expected[role], role, allowTaskChurn);
    if (role === 'api') apiService = service;
    const definition = (await invoke(['ecs', 'describe-task-definition', '--task-definition', expected[role]])).taskDefinition;
    requireThat(definition?.taskDefinitionArn === expected[role], 'Task definition identity mismatch.');
    const containerName = role === 'api' ? 'api' : 'scheduler-worker';
    const containers = (definition.containerDefinitions || []).filter((c) => c.name === containerName);
    requireThat(containers.length === 1, 'Required container identity is ambiguous.');
    const container = containers[0];
    const image = `${CONTRACT.account}.dkr.ecr.${CONTRACT.region}.amazonaws.com/schoolpilot-production-api@${expected.digest}`;
    const env = Object.fromEntries((container.environment || []).map((e) => [e.name, e.value]));
    requireThat(container.image === image && env.GIT_SHA === expected.sha && env.SERVICE_NAME === containerName,
      'Image digest, Git SHA, or service-role metadata mismatch.');
    if (role === 'api') requireThat(container.healthCheck?.command?.some((s) => typeof s === 'string' && s.includes('/livez')),
      'ECS container liveness must remain /livez.');
    // Fingerprint the full definition without persisting environment/secrets values.
    result.services[role].definitionHash = hash(definition);
    // Path-only restoration remains possible while ECS replaces tasks on the
    // same immutable release. Service/source/configuration fences still apply.
    if (allowTaskChurn) continue;
    const listed = await invoke(['ecs', 'list-tasks', '--cluster', CONTRACT.cluster, '--service-name', name, '--desired-status', 'RUNNING']);
    requireThat(listed.taskArns?.length === service.desiredCount && new Set(listed.taskArns).size === service.desiredCount,
      'Running task inventory does not match stable service capacity.');
    const described = await invoke(['ecs', 'describe-tasks', '--cluster', CONTRACT.cluster, '--tasks', ...listed.taskArns]);
    requireThat(described.failures?.length === 0 && described.tasks?.length === listed.taskArns.length, 'Task inventory is incomplete.');
    requireThat(same(described.tasks.map((t) => t.taskArn).sort(), [...listed.taskArns].sort()), 'Task inventory identities changed.');
    for (const task of described.tasks) {
      const taskPrefix = `arn:aws:ecs:${CONTRACT.region}:${CONTRACT.account}:task/${CONTRACT.cluster}/`;
      requireThat(task.taskArn?.startsWith(taskPrefix) && /^[a-f0-9]{32}$/.test(task.taskArn.slice(taskPrefix.length)) &&
        task.lastStatus === 'RUNNING' && task.taskDefinitionArn === expected[role] && task.group === `service:${name}`,
      'Running task identity or definition mismatch.');
      const runtime = (task.containers || []).filter((c) => c.name === containerName);
      requireThat(runtime.length === 1 && runtime[0].imageDigest === expected.digest && runtime[0].lastStatus === 'RUNNING',
        'Running container digest or status mismatch.');
      const addresses = (task.attachments || []).filter((a) => a.type === 'ElasticNetworkInterface')
        .flatMap((a) => (a.details || []).filter((d) => d.name === 'privateIPv4Address').map((d) => d.value));
      requireThat(addresses.length === 1 && /^10\.1\.\d{1,3}\.\d{1,3}$/.test(addresses[0]), 'Task target address is ambiguous.');
      result.tasks.push({ arn: task.taskArn, role, address: addresses[0], startedAt: task.startedAt });
      if (role === 'api' && markers) {
        const options = container.logConfiguration?.options;
        requireThat(container.logConfiguration?.logDriver === 'awslogs' && options?.['awslogs-region'] === CONTRACT.region &&
          options?.['awslogs-group'] && options?.['awslogs-stream-prefix'], 'Task log identity is incomplete.');
        const stream = `${options['awslogs-stream-prefix']}/${containerName}/${task.taskArn.split('/').at(-1)}`;
        const logs = await invoke(['logs', 'filter-log-events', '--log-group-name', options['awslogs-group'],
          '--log-stream-names', stream, '--filter-pattern', '{ $.event = "api_pool_readiness_started" }']);
        requireThat(!logs.nextToken, 'Readiness startup log query was incomplete.');
        const events = (logs.events || []).filter((event) => event.logStreamName === stream).flatMap((event) => {
          try { return [{ ...JSON.parse(event.message), timestamp: event.timestamp }]; } catch { return []; }
        });
        requireThat(events.length === 1, 'Exactly one readiness startup marker is required per running API task.');
        const marker = events[0];
        requireThat(marker.event === 'api_pool_readiness_started' && marker.contractVersion === CONTRACT.contractVersion &&
          marker.path === CONTRACT.path && marker.sampleIntervalMs === CONTRACT.sampleIntervalMs &&
          marker.stallThresholdMs === CONTRACT.stallThresholdMs && marker.confirmationIntervalMs === CONTRACT.confirmationIntervalMs &&
          marker.service === 'api' && marker.environment === 'production' && marker.release === expected.sha &&
          typeof marker.instanceId === 'string' && marker.instanceId.length > 0 &&
          Number.isFinite(Date.parse(task.startedAt)) && marker.timestamp >= Date.parse(task.startedAt) - 30000,
        'Readiness startup contract, source, or task timestamp mismatch.');
        result.markers.push({ task: task.taskArn, instanceId: marker.instanceId, timestamp: marker.timestamp });
      }
    }
  }
  requireThat(apiService.loadBalancers?.length === 1 && apiService.loadBalancers[0].containerName === 'api' &&
    apiService.loadBalancers[0].containerPort === 4000, 'API target-group binding is ambiguous.');
  const arn = apiService.loadBalancers[0].targetGroupArn;
  requireThat(new RegExp(`^arn:aws:elasticloadbalancing:${CONTRACT.region}:${CONTRACT.account}:targetgroup/[A-Za-z0-9-]+/[a-f0-9]+$`).test(arn),
    'Target group is outside the exact account/region.');
  const groups = (await invoke(['elbv2', 'describe-target-groups', '--target-group-arns', arn])).TargetGroups;
  requireThat(groups?.length === 1 && groups[0].TargetGroupArn === arn, 'Target-group identity mismatch.');
  const group = groups[0];
  requireThat(group.TargetType === 'ip' && group.Port === 4000 && group.Protocol === 'HTTP' && group.HealthCheckEnabled === true &&
    group.HealthCheckProtocol === 'HTTP' && group.HealthCheckPort === 'traffic-port' && group.HealthCheckIntervalSeconds === 30 &&
    group.HealthCheckTimeoutSeconds === 5 && group.HealthyThresholdCount === 2 && group.UnhealthyThresholdCount === 3 &&
    group.Matcher?.HttpCode === '200', 'Target-group health timing/protocol differs from the reviewed baseline.');
  const attributes = (await invoke(['elbv2', 'describe-target-group-attributes', '--target-group-arn', arn])).Attributes;
  requireThat(Array.isArray(attributes) && attributes.length > 0, 'Target-group attributes are unavailable.');
  result.targetGroup = { arn, ...targetShape(group), attributesHash: hash([...attributes].sort((a, b) => a.Key.localeCompare(b.Key))) };
  result.targets = result.tasks.filter((t) => t.role === 'api').map((t) => `${t.address}:4000`).sort();
  requireThat(new Set(result.targets).size === result.targets.length, 'API targets are duplicated.');
  if (requireHealthy) assertHealthy(await invoke(['elbv2', 'describe-target-health', '--target-group-arn', arn]), result.targets);
  result.tasks.sort((a, b) => a.arn.localeCompare(b.arn));
  result.markers.sort((a, b) => a.task.localeCompare(b.task));
  return result;
}

export async function createPlan(expected, invoke = aws, now = Date.now()) {
  assertOutsideScalingBoundary(now);
  const snapshot = await inspect(expected, invoke);
  requireThat(snapshot.targetGroup.path === CONTRACT.sourcePath, 'Activation requires the current /livez baseline.');
  return { schemaVersion: 1, operation: 'api-alb-readiness', createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 15 * 60 * 1000).toISOString(), snapshot };
}
export function validatePlan(plan, now, rollback = false) {
  requireThat(plan.schemaVersion === 1 && plan.operation === 'api-alb-readiness' &&
    Number.isFinite(Date.parse(plan.createdAt)) && Number.isFinite(Date.parse(plan.expiresAt)) &&
    Date.parse(plan.createdAt) <= now + 30000 && Date.parse(plan.expiresAt) - Date.parse(plan.createdAt) === 15 * 60 * 1000,
  'Plan format or timestamps are invalid.');
  if (!rollback) {
    requireThat(now <= Date.parse(plan.expiresAt), 'Plan expired; collect fresh release and target evidence.');
    assertOutsideScalingBoundary(now);
  }
  requireThat(plan.snapshot?.targetGroup?.path === CONTRACT.sourcePath, 'Plan does not capture the /livez baseline.');
  validateExpected(plan.snapshot.expected);
}
export function assertOutsideScalingBoundary(now) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York',
    weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now).map((p) => [p.type, p.value]));
  const minutes = Number(parts.hour) * 60 + Number(parts.minute);
  requireThat(!['Mon', 'Tue', 'Wed', 'Thu', 'Fri'].includes(parts.weekday) ||
    ![345, 960].some((boundary) => Math.abs(minutes - boundary) <= 5),
  'Readiness activation is fenced within five minutes of weekday 05:45/16:00 scaling boundaries.');
}
function assertUnchanged(before, after, path) {
  const expected = structuredClone(before);
  expected.targetGroup.path = path;
  requireThat(same(expected, after), 'Release, task inventory, metadata, capacity, or target-group configuration changed.');
}
function assertRestorationIdentity(before, after, path) {
  const identity = (snapshot) => ({ expected: snapshot.expected, services: snapshot.services, targetGroup: snapshot.targetGroup });
  const expected = structuredClone(identity(before));
  expected.targetGroup.path = path;
  requireThat(same(expected, identity(after)), 'Restoration refused: service, immutable release, desired capacity or target configuration changed.');
}
export async function changePath(plan, { rollback = false, invoke = aws, now = Date.now,
  wait = sleep, record = () => {} } = {}) {
  validatePlan(plan, now(), rollback);
  const from = rollback ? CONTRACT.path : CONTRACT.sourcePath;
  const to = rollback ? CONTRACT.sourcePath : CONTRACT.path;
  const before = await inspect(plan.snapshot.expected, invoke, { requireHealthy: !rollback, allowTaskChurn: rollback });
  (rollback ? assertRestorationIdentity : assertUnchanged)(plan.snapshot, before, from);
  validatePlan(plan, now(), rollback);
  record('before', { operation: rollback ? 'rollback' : 'apply', at: new Date(now()).toISOString(), snapshot: before });
  let mutationAttempted = false;
  try {
    mutationAttempted = true;
    await invoke(['elbv2', 'modify-target-group', '--target-group-arn', before.targetGroup.arn, '--health-check-path', to]);
    if (rollback) {
      const current = await inspect(plan.snapshot.expected, invoke, { requireHealthy: false, allowTaskChurn: true });
      assertRestorationIdentity(plan.snapshot, current, to);
      record('success', { operation: 'rollback', at: new Date(now()).toISOString(), path: to, planHash: hash(plan),
        expected: plan.snapshot.expected, targetGroupArn: before.targetGroup.arn, observationSeconds: 0,
        serviceConvergencePending: true });
      return { path: to, observationSeconds: 0, serviceConvergencePending: true };
    }
    // Observe multiple full health-check intervals. Existing health can stay green briefly after a path change.
    for (let round = 0; round < 13; round++) {
      if (round > 0) await wait(10000);
      assertHealthy(await invoke(['elbv2', 'describe-target-health', '--target-group-arn', before.targetGroup.arn]), before.targets);
    }
    const current = await inspect(plan.snapshot.expected, invoke);
    assertUnchanged(plan.snapshot, current, to);
    record('success', { operation: rollback ? 'rollback' : 'apply', at: new Date(now()).toISOString(), path: to,
      planHash: hash(plan), expected: plan.snapshot.expected, targetGroupArn: before.targetGroup.arn, observationSeconds: 120 });
    return { path: to, observationSeconds: 120 };
  } catch (error) {
    let restored = false;
    if (!rollback && mutationAttempted) {
      try {
        const current = await inspect(plan.snapshot.expected, invoke, { requireHealthy: false, allowTaskChurn: true });
        assertRestorationIdentity(plan.snapshot, current, CONTRACT.path);
        await invoke(['elbv2', 'modify-target-group', '--target-group-arn', before.targetGroup.arn, '--health-check-path', CONTRACT.sourcePath]);
        const restoredSnapshot = await inspect(plan.snapshot.expected, invoke, { requireHealthy: false, allowTaskChurn: true });
        assertRestorationIdentity(plan.snapshot, restoredSnapshot, CONTRACT.sourcePath);
        restored = true;
      } catch { /* Preserve uncertainty; never overwrite unrelated concurrent changes. */ }
    }
    record('failure', { operation: rollback ? 'rollback' : 'apply', at: new Date(now()).toISOString(),
      originalPathRestored: restored, mutationAttempted, expected: plan.snapshot.expected });
    throw new Error(`Readiness ${rollback ? 'rollback' : 'activation'} failed; original path restored=${restored}. ${error.message}`);
  }
}
async function main() {
  const values = {};
  for (let i = 2; i < process.argv.length; i += 2) {
    const key = process.argv[i];
    requireThat(['--operation', '--sha', '--digest', '--api', '--worker', '--evidence', '--plan', '--plan-hash'].includes(key) &&
      process.argv[i + 1] && !Object.hasOwn(values, key), 'Unknown, duplicate, or missing CLI argument.');
    values[key] = process.argv[i + 1];
  }
  const operation = values['--operation'] || 'plan';
  requireThat(['plan', 'apply', 'rollback'].includes(operation), 'Operation must be plan, apply, or rollback.');
  const evidence = externalPath(values['--evidence']);
  if (operation === 'plan') {
    const plan = await createPlan({ sha: values['--sha'], digest: values['--digest'], api: values['--api'], worker: values['--worker'] });
    const path = resolve(evidence, 'plan.json');
    writeEvidence(path, plan);
    process.stdout.write(`${JSON.stringify({ plan: path, planHash: hash(plan), expiresAt: plan.expiresAt })}\n`);
    return;
  }
  const plan = JSON.parse(readFileSync(externalPath(values['--plan']), 'utf8'));
  requireThat(/^[a-f0-9]{64}$/.test(values['--plan-hash'] || '') && hash(plan) === values['--plan-hash'], 'Plan hash mismatch.');
  const result = await changePath(plan, { rollback: operation === 'rollback',
    record: (phase, receipt) => writeEvidence(resolve(evidence, `${operation}-${phase}.json`), receipt) });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
}
