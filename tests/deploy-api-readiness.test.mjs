import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { CONTRACT, assertOutsideScalingBoundary, changePath, createPlan, hash, inspect, validatePlan } from '../scripts/deploy-api-readiness.mjs';

const time = Date.parse('2026-09-09T01:00:00Z');
const expected = { sha: 'a'.repeat(40), digest: `sha256:${'b'.repeat(64)}`,
  api: 'arn:aws:ecs:us-east-1:135775632425:task-definition/schoolpilot-production-api-emergency:114',
  worker: 'arn:aws:ecs:us-east-1:135775632425:task-definition/schoolpilot-production-scheduler-worker:130' };
const arn = 'arn:aws:elasticloadbalancing:us-east-1:135775632425:targetgroup/schoolpilot-production-api/aabbccdd';
const taskArn = (role) => `arn:aws:ecs:us-east-1:135775632425:task/schoolpilot-production-cluster/${(role === 'api' ? 'c' : 'd').repeat(32)}`;
function fixture() {
  const state = { path: '/livez', mutations: [], calls: [], unhealthy: false, rewrite: (value) => value };
  function reply(value, args) { return structuredClone(state.rewrite(value, args)); }
  const invoke = async (args) => {
    state.calls.push(args);
    const command = args.slice(0, 2).join(' ');
    const value = (flag) => args[args.indexOf(flag) + 1];
    switch (command) {
      case 'sts get-caller-identity': return reply({ Account: CONTRACT.account }, args);
      case 'ecs describe-services': return reply({ failures: [], services: ['api', 'worker'].map((role) => ({
        serviceName: CONTRACT[role], serviceArn: `arn:aws:ecs:us-east-1:135775632425:service/${CONTRACT.cluster}/${CONTRACT[role]}`,
        clusterArn: `arn:aws:ecs:us-east-1:135775632425:cluster/${CONTRACT.cluster}`,
        status: 'ACTIVE', deploymentController: { type: 'ECS' }, taskDefinition: expected[role],
        desiredCount: 1, runningCount: 1, pendingCount: 0, deploymentConfiguration: { minimumHealthyPercent: 100, maximumPercent: 200 },
        networkConfiguration: { awsvpcConfiguration: { subnets: ['subnet-a', 'subnet-b'], securityGroups: ['sg-a'], assignPublicIp: 'DISABLED' } },
        loadBalancers: role === 'api' ? [{ targetGroupArn: arn, containerName: 'api', containerPort: 4000 }] : [],
        deployments: [{ status: 'PRIMARY', rolloutState: 'COMPLETED', taskDefinition: expected[role], failedTasks: 0,
          desiredCount: 1, runningCount: 1, pendingCount: 0 }] })) }, args);
      case 'ecs describe-task-definition': {
        const role = value('--task-definition') === expected.api ? 'api' : 'worker';
        const name = role === 'api' ? 'api' : 'scheduler-worker';
        return reply({ taskDefinition: { taskDefinitionArn: expected[role], cpu: role === 'api' ? '512' : '256', memory: role === 'api' ? '2048' : '512',
          containerDefinitions: [{ name, image: `${CONTRACT.account}.dkr.ecr.${CONTRACT.region}.amazonaws.com/schoolpilot-production-api@${expected.digest}`,
            environment: [{ name: 'GIT_SHA', value: expected.sha }, { name: 'SERVICE_NAME', value: name },
              { name: 'RLS_GUC_ENABLED', value: 'true' }, { name: 'DB_POOL_MAX', value: '16' }],
            healthCheck: { command: ['CMD-SHELL', 'wget -qO- http://localhost:4000/livez || exit 1'] },
            logConfiguration: { logDriver: 'awslogs', options: { 'awslogs-region': 'us-east-1', 'awslogs-group': '/ecs/api', 'awslogs-stream-prefix': name } } }] } }, args);
      }
      case 'ecs list-tasks': return reply({ taskArns: [taskArn(value('--service-name') === CONTRACT.api ? 'api' : 'worker')] }, args);
      case 'ecs describe-tasks': {
        const role = value('--tasks') === taskArn('api') ? 'api' : 'worker';
        return reply({ failures: [], tasks: [{ taskArn: taskArn(role), taskDefinitionArn: expected[role], lastStatus: 'RUNNING',
          group: `service:${CONTRACT[role]}`, startedAt: new Date(time - 60000).toISOString(),
          containers: [{ name: role === 'api' ? 'api' : 'scheduler-worker', imageDigest: expected.digest, lastStatus: 'RUNNING' }],
          attachments: [{ type: 'ElasticNetworkInterface', details: [{ name: 'privateIPv4Address', value: role === 'api' ? '10.1.1.1' : '10.1.1.2' }] }] }] }, args);
      }
      case 'logs filter-log-events': return reply({ events: [{ logStreamName: value('--log-stream-names'), timestamp: time - 50000,
        message: JSON.stringify({ event: 'api_pool_readiness_started', contractVersion: 1, path: '/readyz', sampleIntervalMs: 1000,
          stallThresholdMs: 60000, confirmationIntervalMs: 10000, service: 'api', environment: 'production', release: expected.sha, instanceId: 'instance-api' }) }] }, args);
      case 'elbv2 describe-target-groups': return reply({ TargetGroups: [{ TargetGroupArn: arn, Port: 4000, Protocol: 'HTTP', TargetType: 'ip',
        HealthCheckEnabled: true, HealthCheckProtocol: 'HTTP', HealthCheckPort: 'traffic-port', HealthCheckPath: state.path,
        HealthCheckIntervalSeconds: 30, HealthCheckTimeoutSeconds: 5, HealthyThresholdCount: 2, UnhealthyThresholdCount: 3, Matcher: { HttpCode: '200' } }] }, args);
      case 'elbv2 describe-target-group-attributes': return reply({ Attributes: [
        { Key: 'stickiness.enabled', Value: 'true' }, { Key: 'stickiness.lb_cookie.duration_seconds', Value: '86400' },
        { Key: 'deregistration_delay.timeout_seconds', Value: '300' }] }, args);
      case 'elbv2 describe-target-health': return reply({ TargetHealthDescriptions: [{ Target: { Id: '10.1.1.1', Port: 4000 },
        TargetHealth: { State: state.unhealthy ? 'unhealthy' : 'healthy' } }] }, args);
      case 'elbv2 modify-target-group':
        state.mutations.push(args);
        state.path = value('--health-check-path');
        return {};
      default: throw new Error(`Unexpected fixture command: ${command}`);
    }
  };
  return { state, invoke };
}
describe('guarded API readiness activation', () => {
  it('plans read-only with exact live tasks, source, markers, health configuration, and no raw environment', async () => {
    const f = fixture();
    const plan = await createPlan(expected, f.invoke, time);
    assert.equal(plan.snapshot.targetGroup.path, '/livez');
    assert.equal(f.state.mutations.length, 0);
    assert.equal(plan.snapshot.markers.length, 1);
    assert.doesNotMatch(JSON.stringify(plan), /RLS_GUC_ENABLED|DB_POOL_MAX|containerDefinitions/);
    validatePlan(plan, time);
  });
  for (const [label, mutate] of [
    ['wrong account', (r, a) => { if (a[0] === 'sts') r.Account = '000000000000'; }],
    ['mixed service revision', (r, a) => { if (a[1] === 'describe-services') r.services[0].taskDefinition = expected.worker; }],
    ['mixed runtime image', (r, a) => { if (a[1] === 'describe-tasks') r.tasks[0].containers[0].imageDigest = `sha256:${'e'.repeat(64)}`; }],
    ['wrong service role', (r, a) => { if (a[1] === 'describe-task-definition') r.taskDefinition.containerDefinitions[0].environment[1].value = 'worker'; }],
    ['wrong target account', (r, a) => { if (a[1] === 'describe-services') r.services[0].loadBalancers[0].targetGroupArn = arn.replace(CONTRACT.account, '000000000000'); }],
    ['extra old registered target', (r, a) => { if (a[1] === 'describe-target-health') r.TargetHealthDescriptions.push({ Target: { Id: '10.1.1.3', Port: 4000 }, TargetHealth: { State: 'draining' } }); }],
    ['wrong health thresholds', (r, a) => { if (a[1] === 'describe-target-groups') r.TargetGroups[0].UnhealthyThresholdCount = 2; }],
    ['startup marker from another stream', (r, a) => { if (a[1] === 'filter-log-events') r.events[0].logStreamName = 'other'; }],
    ['stale task startup marker', (r, a) => { if (a[1] === 'filter-log-events') r.events[0].timestamp = time - 3600000; }],
    ['wrong startup contract', (r, a) => { if (a[1] === 'filter-log-events') r.events[0].message = r.events[0].message.replace('60000', '1000'); }],
    ['incomplete log query', (r, a) => { if (a[1] === 'filter-log-events') r.nextToken = 'unfinished'; }],
  ]) it(`rejects ${label} before any write`, async () => {
    const f = fixture();
    f.state.rewrite = (r, a) => { mutate(r, a); return r; };
    await assert.rejects(createPlan(expected, f.invoke, time));
    assert.equal(f.state.mutations.length, 0);
  });
  it('rejects stale plans and snapshot drift before mutation', async () => {
    const f = fixture();
    const plan = await createPlan(expected, f.invoke, time);
    await assert.rejects(changePath(plan, { invoke: f.invoke, now: () => time + 900001 }), /expired/);
    f.state.rewrite = (r, a) => {
      if (a[1] === 'describe-target-group-attributes') r.Attributes[0].Value = 'false';
      return r;
    };
    await assert.rejects(changePath(plan, { invoke: f.invoke, now: () => time }), /configuration changed/);
    assert.equal(f.state.mutations.length, 0);
  });
  it('changes only the health path and observes it for 120 seconds without altering ECS', async () => {
    const f = fixture();
    const plan = await createPlan(expected, f.invoke, time);
    const waits = [];
    const records = [];
    await changePath(plan, { invoke: f.invoke, now: () => time, wait: async (ms) => { waits.push(ms); }, record: (phase, data) => records.push([phase, data]) });
    assert.deepEqual(f.state.mutations, [['elbv2', 'modify-target-group', '--target-group-arn', arn, '--health-check-path', '/readyz']]);
    assert.equal(waits.reduce((a, b) => a + b, 0), 120000);
    assert.deepEqual(records.map(([phase]) => phase), ['before', 'success']);
    assert.equal(records[1][1].planHash, hash(plan));
  });
  it('restores /livez automatically if candidate health fails', async () => {
    const f = fixture();
    const plan = await createPlan(expected, f.invoke, time);
    const records = [];
    await assert.rejects(changePath(plan, { invoke: f.invoke, now: () => time,
      wait: async () => { f.state.unhealthy = true; }, record: (phase, data) => records.push([phase, data]) }), /restored=true/);
    assert.deepEqual(f.state.mutations.map((a) => a.at(-1)), ['/readyz', '/livez']);
    assert.equal(records.at(-1)[1].originalPathRestored, true);
  });
  it('does not overwrite concurrent release/configuration changes during automatic restoration', async () => {
    const f = fixture();
    const plan = await createPlan(expected, f.invoke, time);
    await assert.rejects(changePath(plan, { invoke: f.invoke, now: () => time, wait: async () => {
      f.state.unhealthy = true;
      f.state.rewrite = (r, a) => { if (a[1] === 'describe-services') r.services[0].taskDefinition = expected.worker; return r; };
    } }), /restored=false/);
    assert.deepEqual(f.state.mutations.map((a) => a.at(-1)), ['/readyz']);
  });
  it('restores the path while ECS replacement is pending on the same release', async () => {
    const f = fixture();
    const plan = await createPlan(expected, f.invoke, time);
    await assert.rejects(changePath(plan, { invoke: f.invoke, now: () => time, wait: async () => {
      f.state.unhealthy = true;
      f.state.rewrite = (r, a) => {
        if (a[1] === 'describe-services') {
          r.services[0].runningCount = 0;
          r.services[0].pendingCount = 1;
          r.services[0].deployments[0].runningCount = 0;
          r.services[0].deployments[0].pendingCount = 1;
          r.services[0].deployments[0].failedTasks = 1;
        }
        return r;
      };
    } }), /restored=true/);
    assert.deepEqual(f.state.mutations.map((a) => a.at(-1)), ['/readyz', '/livez']);
  });
  it('allows explicit rollback after receipt expiry only on the exact unchanged release', async () => {
    const f = fixture();
    const plan = await createPlan(expected, f.invoke, time);
    f.state.path = '/readyz';
    await changePath(plan, { rollback: true, invoke: f.invoke, now: () => time + 86400000, wait: async () => {} });
    assert.deepEqual(f.state.mutations.map((a) => a.at(-1)), ['/livez']);
    assert.equal(f.state.path, '/livez');
  });
  it('rejects a missing startup marker even on a healthy exact-source task', async () => {
    const f = fixture();
    f.state.rewrite = (r, a) => { if (a[1] === 'filter-log-events') r.events = []; return r; };
    await assert.rejects(inspect(expected, f.invoke), /startup marker/);
  });
  it('fences activation around both weekday capacity changes but allows rollback', async () => {
    for (const timestamp of ['2026-09-09T09:40:00Z', '2026-09-09T09:50:00Z', '2026-09-09T19:55:00Z', '2026-09-09T20:05:00Z']) {
      assert.throws(() => assertOutsideScalingBoundary(Date.parse(timestamp)), /scaling boundaries/);
    }
    assertOutsideScalingBoundary(Date.parse('2026-09-09T20:06:00Z'));
    assertOutsideScalingBoundary(Date.parse('2026-09-12T20:00:00Z'));
  });
});
