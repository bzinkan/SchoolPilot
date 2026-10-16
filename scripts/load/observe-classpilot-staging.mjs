import { spawnSync } from 'node:child_process';
import { readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REGION = 'us-east-1';
const CLUSTER = 'schoolpilot-staging-cluster';
const SERVICES = ['schoolpilot-staging-api', 'schoolpilot-staging-scheduler-worker'];
const READ_OPERATIONS = new Set(['cloudwatch/get-metric-data', 'ecs/describe-services', 'ecs/list-tasks', 'ecs/describe-tasks', 'elbv2/describe-target-health']);

export function stagingObservationConfig(value) {
  if (value.version !== 1 || !/^\d{12}$/.test(value.accountId || '') || value.region !== REGION
      || value.origin !== 'https://staging.school-pilot.net'
      || !/^classpilot-staging-\d{8}-[a-f0-9]{12}$/.test(value.campaign || '')
      || !/^app\/schoolpilot-staging-alb\/[a-f0-9]{16}$/.test(value.loadBalancerFullName || '')
      || !/^targetgroup\/schoolpilot-staging-api-tg\/[a-f0-9]{16}$/.test(value.targetGroupFullName || '')
      || !Array.isArray(value.redisCacheClusterIds) || value.redisCacheClusterIds.length !== 1
      || value.redisCacheClusterIds.some(id => !/^schoolpilot-staging-redis-00[1-9]$/.test(id))) {
    throw new Error('Observation must bind the exact isolated staging resources');
  }
  return value;
}

export function stagingMetricQueries(config) {
  stagingObservationConfig(config);
  const queries = [];
  const metric = (id, namespace, name, dimensions, stat, period = 60) => queries.push({ Id: id,
    MetricStat: { Metric: { Namespace: namespace, MetricName: name,
      Dimensions: Object.entries(dimensions).map(([Name, Value]) => ({ Name, Value })) }, Period: period, Stat: stat }, ReturnData: true });
  for (const [index, service] of SERVICES.entries()) {
    const dimensions = { ClusterName: CLUSTER, ServiceName: service };
    metric(`ecs_${index}_cpu`, 'AWS/ECS', 'CPUUtilization', dimensions, 'Average');
    metric(`ecs_${index}_cpu_maximum`, 'AWS/ECS', 'CPUUtilization', dimensions, 'Maximum');
    metric(`ecs_${index}_memory`, 'AWS/ECS', 'MemoryUtilization', dimensions, 'Maximum');
  }
  const rds = { DBInstanceIdentifier: 'schoolpilot-staging-db' };
  for (const [id, name, stat] of [['cpu', 'CPUUtilization', 'Maximum'], ['connections', 'DatabaseConnections', 'Maximum'],
    ['storage_free', 'FreeStorageSpace', 'Minimum'], ['memory_free', 'FreeableMemory', 'Minimum'],
    ['disk_queue', 'DiskQueueDepth', 'Maximum'], ['read_latency', 'ReadLatency', 'Maximum'], ['write_latency', 'WriteLatency', 'Maximum']]) {
    metric(`rds_${id}`, 'AWS/RDS', name, rds, stat);
  }
  metric('rds_cpu_credit', 'AWS/RDS', 'CPUCreditBalance', rds, 'Minimum', 300);
  metric('rds_surplus_charged', 'AWS/RDS', 'CPUSurplusCreditsCharged', rds, 'Sum', 300);
  for (const [index, cache] of config.redisCacheClusterIds.entries()) {
    for (const [id, name, stat] of [['cpu', 'EngineCPUUtilization', 'Maximum'], ['memory', 'DatabaseMemoryUsagePercentage', 'Maximum'],
      ['free', 'FreeableMemory', 'Minimum'], ['evictions', 'Evictions', 'Sum'], ['rejected', 'RejectedConnections', 'Sum'],
      ['connections', 'CurrConnections', 'Maximum'], ['hits', 'CacheHits', 'Sum'], ['misses', 'CacheMisses', 'Sum']]) {
      metric(`redis_${index}_${id}`, 'AWS/ElastiCache', name, { CacheClusterId: cache }, stat);
    }
  }
  const alb = { LoadBalancer: config.loadBalancerFullName, TargetGroup: config.targetGroupFullName };
  metric('alb_target_latency_p95_seconds', 'AWS/ApplicationELB', 'TargetResponseTime', alb, 'p95');
  metric('alb_target_5xx', 'AWS/ApplicationELB', 'HTTPCode_Target_5XX_Count', alb, 'Sum');
  metric('alb_unhealthy', 'AWS/ApplicationELB', 'UnHealthyHostCount', alb, 'Maximum');
  metric('alb_5xx', 'AWS/ApplicationELB', 'HTTPCode_ELB_5XX_Count', { LoadBalancer: config.loadBalancerFullName }, 'Sum');
  for (const [id, rule] of [['device', 'device-ingest-rate-limit'], ['api', 'api-rate-limit']]) {
    metric(`waf_${id}_blocked`, 'AWS/WAFV2', 'BlockedRequests',
      { WebACL: 'schoolpilot-staging-cloudfront-waf', Rule: `schoolpilot-staging-${rule}` }, 'Sum');
  }
  metric('waf_all_blocked', 'AWS/WAFV2', 'BlockedRequests', { WebACL: 'schoolpilot-staging-cloudfront-waf', Rule: 'ALL' }, 'Sum');
  metric('waf_all_allowed', 'AWS/WAFV2', 'AllowedRequests', { WebACL: 'schoolpilot-staging-cloudfront-waf', Rule: 'ALL' }, 'Sum');
  const app = { Environment: 'staging', Service: 'api' };
  for (const [index, name] of ['ClientPreviewAge0To5Seconds', 'ClientPreviewAge5To10Seconds', 'ClientPreviewAge10To15Seconds',
    'ClientPreviewAge15To30Seconds', 'ClientPreviewAgeOver30Seconds', 'ClientPreviewUnavailable',
    'ClientSnapshotReadTimeouts', 'ClientReconnects', 'ClientRecoveries', 'ClientScreenshotEventGapRecoveries'].entries()) {
    metric(`client_${index}`, 'SchoolPilot/ClassPilot', name, app, 'Sum');
  }
  for (const [index, name] of ['HeartbeatGapOver60Seconds', 'TileBatchScreenshotMissItems', 'TileBatchScreenshotStoreUnavailable',
    'ScreenshotAvailableBroadcastFailures', 'ScreenshotCadenceObservationUnavailable', 'DeviceHeartbeatRateLimited', 'DeviceScreenshotRateLimited'].entries()) {
    metric(`hot_path_${index}`, 'SchoolPilot/ClassPilot', name, app, 'Sum');
  }
  for (const [index, name] of ['RuntimePoolAcquisitionFailure', 'RuntimeApiPoolReadinessStalled',
    'RuntimeRequestBodyParserCancelled', 'RuntimeStudentWebSocketAuthServiceFailure', 'RuntimeStudentWebSocketRevalidationFailure'].entries()) {
    metric(`runtime_${index}`, 'SchoolPilot/RuntimePerformance', name, app, 'Sum');
  }
  return queries;
}

export function summarizeMetric(result, endMs) {
  const values = Array.isArray(result?.Values) ? result.Values : [];
  const timestamps = Array.isArray(result?.Timestamps) ? result.Timestamps : [];
  const valid = values.length > 0 && values.length === timestamps.length && values.every(Number.isFinite)
    && timestamps.every(value => Number.isFinite(Date.parse(value))) && result.StatusCode === 'Complete';
  if (!valid) return { available: false, count: values.length, status: result?.StatusCode || 'Missing', minimum: null, maximum: null, p95: null, sum: null, latestAt: null, lagSeconds: null };
  const sorted = [...values].sort((a, b) => a - b);
  const latest = Math.max(...timestamps.map(value => Date.parse(value)));
  return { available: true, count: values.length, status: result.StatusCode, minimum: sorted[0], maximum: sorted.at(-1),
    p95: sorted[Math.max(0, Math.ceil(values.length * 0.95) - 1)], sum: values.reduce((a, b) => a + b, 0),
    latestAt: new Date(latest).toISOString(), lagSeconds: Math.max(0, (endMs - latest) / 1000) };
}

function awsRead(service, operation, args) {
  if (!READ_OPERATIONS.has(`${service}/${operation}`)) throw new Error('Only reviewed staging observation operations are allowed');
  const result = spawnSync('aws', [service, operation, '--region', REGION, '--output', 'json', '--no-cli-pager', ...args],
    { encoding: 'utf8', timeout: 30_000, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, AWS_PAGER: '' } });
  if (result.error || result.status !== 0) throw new Error('Read-only staging AWS observation failed');
  return JSON.parse(result.stdout);
}

export async function observeStaging(config, start, end, read = awsRead) {
  stagingObservationConfig(config);
  const startMs = Date.parse(start); const endMs = Date.parse(end);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs || endMs - startMs > 6 * 60 * 60_000
      || endMs > Date.now() + 60_000) throw new Error('A bounded explicit UTC observation window is required');
  const queries = stagingMetricQueries(config);
  const metrics = await read('cloudwatch', 'get-metric-data', ['--start-time', new Date(startMs).toISOString(), '--end-time', new Date(endMs).toISOString(),
    '--metric-data-queries', JSON.stringify(queries), '--scan-by', 'TimestampAscending', '--max-datapoints', '100800']);
  if (metrics.NextToken) throw new Error('Incomplete staging metric pagination');
  const source = new Map((metrics.MetricDataResults || []).map(value => [value.Id, value]));
  const summaries = Object.fromEntries(queries.map(query => [query.Id, summarizeMetric(source.get(query.Id), endMs)]));
  const services = await read('ecs', 'describe-services', ['--cluster', CLUSTER, '--services', ...SERVICES]);
  const clusterArn = `arn:aws:ecs:${REGION}:${config.accountId}:cluster/${CLUSTER}`;
  if (services.failures?.length || services.services?.length !== 2
      || new Set(services.services.map(service => service.serviceName)).size !== 2
      || services.services.some(service => !SERVICES.includes(service.serviceName) || service.clusterArn !== clusterArn
        || service.serviceArn !== `arn:aws:ecs:${REGION}:${config.accountId}:service/${CLUSTER}/${service.serviceName}`)) throw new Error('Exact staging services unavailable');
  const targetArn = `arn:aws:elasticloadbalancing:${REGION}:${config.accountId}:${config.targetGroupFullName}`;
  const targets = await read('elbv2', 'describe-target-health', ['--target-group-arn', targetArn]);
  const states = {};
  for (const target of targets.TargetHealthDescriptions || []) {
    const state = target.TargetHealth?.State;
    if (!['healthy', 'unhealthy', 'initial', 'draining', 'unused', 'unavailable'].includes(state)) throw new Error('Unknown target health state');
    states[state] = (states[state] || 0) + 1;
  }
  const taskCounts = { running: 0, stopped: 0, historicalStopped: 0, unknownStopTime: 0, oom: 0, nonzeroExit: 0, failedDescribe: 0, runningImages: [] };
  for (const service of SERVICES) {
    for (const status of ['RUNNING', 'STOPPED']) {
      const listed = await read('ecs', 'list-tasks', ['--cluster', CLUSTER, '--service-name', service, '--desired-status', status]);
      const arns = listed.taskArns || [];
      if (arns.length > 1000 || new Set(arns).size !== arns.length
          || arns.some(arn => !new RegExp(`^arn:aws:ecs:${REGION}:${config.accountId}:task/${CLUSTER}/[a-f0-9]{32}$`).test(arn))) throw new Error('Unexpected staging task inventory');
      if (!arns.length) continue;
      for (let offset = 0; offset < arns.length; offset += 100) {
        const selected = arns.slice(offset, offset + 100);
        const described = await read('ecs', 'describe-tasks', ['--cluster', CLUSTER, '--tasks', ...selected]);
        taskCounts.failedDescribe += described.failures?.length || 0;
        for (const task of described.tasks || []) {
          if (!selected.includes(task.taskArn) || task.clusterArn !== clusterArn) throw new Error('Task observation left the bound staging cluster');
          if (status === 'RUNNING') {
            taskCounts.running += 1;
            for (const container of task.containers || []) taskCounts.runningImages.push({ service, image: container.image, imageDigest: container.imageDigest || null });
          } else {
            const stoppedAt = Date.parse(task.stoppedAt);
            if (!Number.isFinite(stoppedAt)) { taskCounts.unknownStopTime += 1; continue; }
            if (stoppedAt < startMs || stoppedAt > endMs) { taskCounts.historicalStopped += 1; continue; }
            taskCounts.stopped += 1;
            const reasons = [task.stoppedReason, ...(task.containers || []).map(container => container.reason)].filter(Boolean).join(' ');
            if (/out.?of.?memory|oom/i.test(reasons)) taskCounts.oom += 1;
            if ((task.containers || []).some(container => typeof container.exitCode === 'number' && container.exitCode !== 0)) taskCounts.nonzeroExit += 1;
          }
        }
      }
    }
  }
  return { version: 1, campaign: config.campaign, environment: 'staging', collectedAt: new Date().toISOString(),
    start: new Date(startMs).toISOString(), end: new Date(endMs).toISOString(),
    metrics: summaries, metricSeries: queries.map(query => ({ id: query.Id, statistic: query.MetricStat.Stat,
      periodSeconds: query.MetricStat.Period, timestamps: source.get(query.Id)?.Timestamps || [], values: source.get(query.Id)?.Values || [] })),
    missingMetrics: Object.entries(summaries).filter(([, value]) => !value.available).map(([id]) => id),
    services: services.services.map(service => ({ name: service.serviceName, desired: service.desiredCount, running: service.runningCount,
      pending: service.pendingCount, deployments: service.deployments?.length || 0, taskDefinition: service.taskDefinition })),
    targets: states, tasks: taskCounts, productionAccepted: false,
    acceptance: 'observation-only; missing/sparse metrics remain unknown and require separate review; one-minute p95-series p95 is not pooled request p95' };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const { values } = parseArgs({ options: { config: { type: 'string' }, start: { type: 'string' }, end: { type: 'string' }, output: { type: 'string' }, help: { type: 'boolean' } } });
    if (values.help) console.log('Read-only isolated staging AWS observation. --config <externalJSON> --start <UTC> --end <UTC> --output <fresh-externalJSON>. Fixed staging cluster/services/DB/WAF; exact staging ALB/Redis identifiers required. No mutation, rollback, notifications or automatic acceptance.');
    else {
      const root = realpathSync(fileURLToPath(new URL('../..', import.meta.url)));
      for (const path of [values.config, values.output]) {
        if (!path || !isAbsolute(path)) throw new Error('External absolute observation paths required');
        const parent = realpathSync(dirname(path)); const rel = relative(root, parent);
        if (!(rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) || !statSync(parent).isDirectory()) throw new Error('Observation artifacts must stay outside the repository');
      }
      const config = stagingObservationConfig(JSON.parse(readFileSync(values.config, 'utf8')));
      const result = await observeStaging(config, values.start, values.end);
      writeFileSync(values.output, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
      console.log(JSON.stringify({ environment: 'staging', collected: true, missingMetrics: result.missingMetrics,
        unhealthyTargets: result.targets.unhealthy || 0, stoppedTasks: result.tasks.stopped, oomTasks: result.tasks.oom, productionAccepted: false }));
    }
  } catch { console.error('[staging-observer] Read-only observation failed or configuration refused'); process.exitCode = 1; }
}
