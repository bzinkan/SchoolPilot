import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { REMOTE_GENERATOR_SCRIPTS, scriptManifest } from '../scripts/load/remote-generator-manifest.mjs';
import { assertAggregateEvidence, boundedArtifactBody, generatorChildEnvironment, generatorStats,
  preflightGeneratorMetadata, remoteGeneratorConfig, runRemoteGenerator, validateGeneratorTask, validateInputManifest,
  validateSuccessfulFleetSummary } from '../scripts/load/run-classpilot-remote-generator.mjs';
import { prepareRemoteInputs } from '../scripts/load/prepare-classpilot-remote-inputs.mjs';
import { FILES } from '../scripts/load/prepare-classpilot-load-test.mjs';
import { observeStaging, stagingMetricQueries, stagingObservationConfig, summarizeMetric } from '../scripts/load/observe-classpilot-staging.mjs';

import {measurementPlan,measurementPlanDigest,measurementExpected,measurementWaiting} from '../scripts/load/classpilot-reliability-profile.mjs';
const account = '135775632425';
const digest = `sha256:${'a'.repeat(64)}`;
const apiImage = `${account}.dkr.ecr.us-east-1.amazonaws.com/schoolpilot-staging-api@${digest}`;
const scripts = fileURLToPath(new URL('../scripts/load', import.meta.url));
const manifest = scriptManifest(scripts, apiImage, REMOTE_GENERATOR_SCRIPTS);
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const baseEnv = { AWS_REGION: 'us-east-1', CLP_GENERATOR_ACCOUNT_ID: account,
  CLP_GENERATOR_BUCKET: `schoolpilot-staging-load-${account}`, CLP_GENERATOR_CAMPAIGN: 'classpilot-staging-20261013-0d1060d261d5',
  CLP_GENERATOR_RUN_ID: '40-0123456789abcdef', CLP_GENERATOR_DEVICES: '40',
  CLP_GENERATOR_ORIGIN: 'https://staging.school-pilot.net', CLP_GENERATOR_INPUT_SHA256: 'b'.repeat(64),
  CLP_GENERATOR_START_AT: new Date(Date.now() + 240_000).toISOString(),
  CLP_GENERATOR_SCRIPT_SHA256: manifest.scriptBundleSha256, CLP_GENERATOR_CANDIDATE_IMAGE: apiImage,
  CLP_GENERATOR_IMAGE_DIGEST: digest };
const config = remoteGeneratorConfig(baseEnv, manifest);
const task = { LaunchType: 'FARGATE', Family: 'schoolpilot-staging-load-generator', Revision: '1',
  Cluster: `arn:aws:ecs:us-east-1:${account}:cluster/schoolpilot-staging-cluster`,
  TaskARN: `arn:aws:ecs:us-east-1:${account}:task/schoolpilot-staging-cluster/${'a'.repeat(32)}`,
  Limits: { CPU: 2, Memory: 4096 }, Containers: [{ Type: 'NORMAL', ImageID: digest,
    Image: `${account}.dkr.ecr.us-east-1.amazonaws.com/schoolpilot-staging-load-generator@${digest}` }] };
const statistics = { container: { cpu_stats: { cpu_usage: { total_usage: 10_000_000 },
  throttling_data: { throttled_periods: 0, throttled_time: 0 } }, memory_stats: { usage: 10_000_000, limit: 4096 * 1024 * 1024 },
  networks: { eth0: { rx_bytes: 100, tx_bytes: 200 } } } };
const goodSummary = () => ({ runId: config.runId, targetOrigin: baseEnv.CLP_GENERATOR_ORIGIN, devices: 50,
  stagingStart: { plannedStartAt: config.startAt, actualStartedAt: config.startAt,
    readyAt: new Date(Date.parse(config.startAt) - 5000).toISOString(), startSkewMs: 0 },
  workloadSchemaVersion: config.profile.version, reliabilityWorkload: { ...config.profile, productionAccepted: false, managedDevicesValidated: false },
  browserPaintValidated: false, certificationEligible: false, thresholds: { enforced: true, passed: true, failures: [] },
  run: { completedConfiguredDuration: true, shutdownReason: 'duration', acceleratedLoopbackTest: false,
    testOnlyLatencyThresholdMultiplier: 1, plannedTrafficSeconds: 600, actualTrafficSeconds: 600 },
  artifacts: { externalProgressFinalized: true, externalSummaryWritten: true } });

test('remote campaign refuses production, mutable images, provider credentials and mismatched task identity', () => {
  assert.equal(config.profile.durationSeconds, 600);
  for (const override of [{ CLP_GENERATOR_ORIGIN: 'https://school-pilot.net' }, { CLP_GENERATOR_BUCKET: 'production' },
    { CLP_GENERATOR_RUN_ID: '500-0123456789abcdef' }, { CLP_GENERATOR_SCRIPT_SHA256: 'c'.repeat(64) },
    { CLP_GENERATOR_CANDIDATE_IMAGE: apiImage.replace('@sha256:', ':') }, { SESSION_SECRET: 'private' },
    { AWS_ACCESS_KEY_ID: 'private' }, { AWS_REGION: 'us-west-2' }]) {
    assert.throws(() => remoteGeneratorConfig({ ...baseEnv, ...override }, manifest));
  }
  assert.equal(validateGeneratorTask(task, config).taskCpuVcpus, 2);
  for (const override of [{ Family: 'schoolpilot-production-api' }, { Limits: { CPU: 4, Memory: 4096 } },
    { Cluster: task.Cluster.replace(account, '000000000000') },
    { Containers: [{ ...task.Containers[0], ImageID: `sha256:${'b'.repeat(64)}` }] },
    { Containers: [...task.Containers, task.Containers[0]] }]) {
    assert.throws(() => validateGeneratorTask({ ...task, ...override }, config));
  }
});

test('installed script identity changes with source bytes and refuses API tag references', () => {
  const root = mkdtempSync(join(tmpdir(), 'classpilot-manifest-test-'));
  try {
    writeFileSync(join(root, 'a.mjs'), 'export const value = 1;');
    const first = scriptManifest(root, apiImage);
    assert.deepEqual(scriptManifest(root, apiImage), first);
    writeFileSync(join(root, 'a.mjs'), 'export const value = 2;');
    assert.notEqual(scriptManifest(root, apiImage).scriptBundleSha256, first.scriptBundleSha256);
    assert.throws(() => scriptManifest(root, apiImage.replace(/@.*/, ':latest')));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('child environment discards test acceleration, arbitrary load knobs and application credentials', () => {
  const child = generatorChildEnvironment({ PATH: '/usr/bin', LOAD_DURATION_SECONDS: '1', LOAD_TEST_RUNTIME_MS: '1',
    LOAD_BASE_URL: 'https://school-pilot.net', DATABASE_URL: 'private', HTTP_PROXY: 'private', NODE_OPTIONS: '--inspect' }, config, '/tmp/owned');
  assert.equal(child.LOAD_BASE_URL, 'https://staging.school-pilot.net');
  assert.equal(child.LOAD_SESSION_COOKIE_NAME, 'schoolpilot.staging.sid');
  for (const key of ['LOAD_DURATION_SECONDS', 'LOAD_TEST_RUNTIME_MS', 'DATABASE_URL', 'HTTP_PROXY', 'NODE_OPTIONS']) assert.equal(child[key], undefined);
});

test('input manifest requires exact fresh campaign, cardinality and bounded byte identities', () => {
  const now = Date.now();
  const value = { version: 2, campaign: config.campaign, runId: config.runId, primaryDevices: 40,
    startAt: config.startAt,renderedControllerSha256:'d'.repeat(64),measurementPlan:measurementPlan(40),measurementPlanSha256:measurementPlanDigest(40),
    candidateApiImage: apiImage, scriptBundleSha256: manifest.scriptBundleSha256, createdAt: new Date(now).toISOString(),
    files: Object.fromEntries(['devices', 'auth', 'commands'].map(key => [key, { bytes: 2, sha256: 'b'.repeat(64) }])) };
  assert.equal(validateInputManifest(value, config, now), value);
  for (const override of [{ primaryDevices: 800 }, { createdAt: new Date(now - 900_001).toISOString() },
    { createdAt: new Date(now + 1).toISOString() }, { files: { ...value.files, extra: value.files.auth } },
    { files: { ...value.files, auth: { bytes: 32 * 1024 * 1024 + 1, sha256: 'b'.repeat(64) } } }]) {
    assert.throws(() => validateInputManifest({ ...value, ...override }, config, now));
  }
});

test('artifact bodies abort both stalled and oversized streams', async () => {
  assert.equal((await boundedArtifactBody(Readable.from([Buffer.from('ok')]), 2, 100)).toString(), 'ok');
  await assert.rejects(boundedArtifactBody(Readable.from([Buffer.from('large')]), 2, 100), /bounded size/);
  const stalled = new Readable({ read() {} });
  await assert.rejects(boundedArtifactBody(stalled, 2, 20), /deadline/);
  assert.equal(stalled.destroyed, true);
});

test('aggregate upload refuses fixture secrets, JWTs and oversized output', () => {
  assert.equal(assertAggregateEvidence('{"count":40}', new Set(['fixture-secret'])), '{"count":40}');
  assert.throws(() => assertAggregateEvidence('{"id":"fixture-secret"}', new Set(['fixture-secret'])));
  assert.throws(() => assertAggregateEvidence('eyJhbGciOiJIUzI1NiJ9.eyJleHAiOjF9.signature', new Set()));
  assert.throws(() => assertAggregateEvidence('x'.repeat(16 * 1024 * 1024 + 1), new Set()));
});

test('a zero exit cannot certify interrupted, accelerated, incomplete or mismatched fleet evidence', () => {
  assert.equal(validateSuccessfulFleetSummary(goodSummary(), config).devices, 50);
  for (const mutate of [value => { value.run.actualTrafficSeconds = 599; }, value => { value.run.acceleratedLoopbackTest = true; },
    value => { value.thresholds.passed = false; }, value => { value.browserPaintValidated = true; },
    value => { value.artifacts.externalProgressFinalized = false; }, value => { value.devices = 810; }]) {
    const value = goodSummary(); mutate(value); assert.throws(() => validateSuccessfulFleetSummary(value, config));
  }
});

test('native metadata preflight binds the installed bundle and performs no input download or application traffic', async () => {
  const root = mkdtempSync(join(tmpdir(), 'classpilot-metadata-test-'));
  try {
    const path = join(root, 'manifest.json');
    writeFileSync(path, JSON.stringify(manifest));
    const calls = [];
    const result = await preflightGeneratorMetadata({ env: baseEnv, manifestPath: path,
      metadata: async (_env, suffix) => { calls.push(suffix || '/task'); return suffix ? statistics : task; } });
    assert.deepEqual(calls, ['/task', '/task/stats']);
    assert.equal(result.trafficStarted, false); assert.equal(result.inputsDownloaded, false);
    writeFileSync(path, JSON.stringify({ ...manifest, scriptBundleSha256: '0'.repeat(64) }));
    await assert.rejects(preflightGeneratorMetadata({ env: baseEnv, manifestPath: path, metadata: async () => assert.fail('metadata must not run') }), /Installed generator/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('remote input copies retain exact bytes and refuse overwrite or source outside protected custody', () => {
  const root = mkdtempSync(join(tmpdir(), 'classpilot-input-custody-test-'));
  const prior = { NODE_ENV: process.env.NODE_ENV, CLP_LOAD_GATES_TEST_ROOT: process.env.CLP_LOAD_GATES_TEST_ROOT,
    CLP_LOAD_FIXTURE_TEST_MODE: process.env.CLP_LOAD_FIXTURE_TEST_MODE };
  try {
    process.env.NODE_ENV = 'test'; process.env.CLP_LOAD_FIXTURE_TEST_MODE = '1'; process.env.CLP_LOAD_GATES_TEST_ROOT = root;
    const source = join(root, 'source'); mkdirSync(source);
    for (const name of [FILES.devices, FILES.auth, FILES.commands]) writeFileSync(join(source, name), JSON.stringify({ count: 40 }));
    const output = join(root, 'remote');
    const options = { source, output, account, campaign: config.campaign, runId: config.runId, devices: '40',
      candidateImage: apiImage, scriptSha: manifest.scriptBundleSha256, generatorDigest: digest, startAt: config.startAt };
    const receipt = prepareRemoteInputs(options);
    assert.equal(receipt.inputManifestSha256, sha256(readFileSync(join(output, 'manifest.json'))));
    assert.equal(JSON.parse(readFileSync(join(output, 'devices.json'), 'utf8')).count, 40);
    assert.throws(() => prepareRemoteInputs(options), /new directory/);
    process.env.CLP_LOAD_GATES_TEST_ROOT = join(root, 'different-protected-root');
    mkdirSync(process.env.CLP_LOAD_GATES_TEST_ROOT);
    assert.throws(() => prepareRemoteInputs({ ...options, output: join(root, 'different-protected-root', 'remote') }), /protected load custody/);
  } finally {
    for (const [key, value] of Object.entries(prior)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
    rmSync(root, { recursive: true, force: true });
  }
});

for (const defect of ['none', 'input-bytes', 'preflight', 'evidence-sink', 'missing-summary', 'private-result']) {
  test(`remote supervisor preserves exact S3 custody and fails closed: ${defect}`, async () => {
    const root = mkdtempSync(join(tmpdir(), 'classpilot-supervisor-test-'));
    const priorMask = process.umask();
    const files = { devices: Buffer.from('[{"studentId":"private-student-identity"}]'),
      auth: Buffer.from('{"teacherCookie":"schoolpilot.staging.sid=private-cookie"}'), commands: Buffer.from('[]') };
    const input = { version: 2, campaign: config.campaign, runId: config.runId, primaryDevices: 40, candidateApiImage: apiImage,
      startAt: config.startAt,renderedControllerSha256:'d'.repeat(64),measurementPlan:measurementPlan(40),measurementPlanSha256:measurementPlanDigest(40),
      scriptBundleSha256: manifest.scriptBundleSha256, createdAt: new Date().toISOString(),
      files: Object.fromEntries(Object.entries(files).map(([key, bytes]) => [key, { bytes: bytes.length, sha256: sha256(bytes) }])) };
    const inputBytes = Buffer.from(JSON.stringify(input));
    const startup = measurementWaiting(measurementExpected(input, sha256(inputBytes)), { startAt: config.startAt });
    const objects = new Map([['manifest.json', inputBytes], ...Object.entries(files).map(([key, bytes]) => [`${key}.json`, bytes])]);
    const reads = [], puts = [], executions = [];
    writeFileSync(join(root, 'manifest.json'), JSON.stringify(manifest));
    const s3 = { async send(command) {
      const { Bucket, Key, Body } = command.input;
      assert.equal(Bucket, config.bucket);
      assert.ok(Key.startsWith(`${config.prefix}/`));
      if (Body === undefined) {
        reads.push(Key);
        const bytes = objects.get(Key.split('/').at(-1));
        return { Body: Readable.from([defect === 'input-bytes' && Key.endsWith('/devices.json') ? Buffer.from('tampered') : bytes]) };
      }
      if (defect === 'evidence-sink') throw new Error('unavailable');
      puts.push({ key: Key, value: JSON.parse(Body) }); return {};
    } };
    const execute = async (env, devices, dryRun) => {
      executions.push(dryRun); assert.equal(devices, 40);
      assert.equal(JSON.parse(readFileSync(env.LOAD_DEVICE_MANIFEST, 'utf8'))[0].studentId, 'private-student-identity');
      if (dryRun) return defect === 'preflight' ? 2 : 0;
      if (defect !== 'missing-summary') {
        const summary = goodSummary();
        if (defect === 'private-result') summary.private = 'private-student-identity';
        writeFileSync(env.LOAD_EXTERNAL_SUMMARY_PATH, JSON.stringify(summary));
      }
      return 0;
    };
    try {
      const operation = runRemoteGenerator({ env: { ...baseEnv, CLP_GENERATOR_INPUT_SHA256: sha256(inputBytes) },
        manifestPath: join(root, 'manifest.json'), s3, execute,
        measurementS3:{config:{maxAttempts:1,region:'us-east-1'},middlewareStack:{add(){}},destroy(){},async send(command){
          assert.ok(command.input.Key.startsWith(config.prefix+'/'));
          if(command.constructor.name==='GetObjectCommand') {
            assert.equal(command.input.Key,config.prefix+'/inputs/measurement-control.json');
            return {Body:Readable.from([Buffer.from(JSON.stringify(startup))])};
          }
          assert.ok(command.input.Key.includes('/results/')); assert.equal(command.input.IfNoneMatch,'*');
          return {};
        }},
        metadata: async (_env, suffix) => suffix ? statistics : task });
      if (defect === 'none') {
        assert.equal(await operation, 0); assert.deepEqual(executions, [true, false]);
        const receipt = puts.filter(entry => entry.key.endsWith('/generator.json')).at(-1).value;
        assert.equal(receipt.phase, 'completed'); assert.equal(receipt.productionAccepted, false);
        assert.equal(receipt.task.generatorImageDigest, digest);
      } else {
        await assert.rejects(operation);
        if (defect === 'input-bytes' || defect === 'evidence-sink') assert.equal(executions.length, 0);
        if (defect === 'preflight') assert.deepEqual(executions, [true]);
      }
      assert.ok(reads.every(key => key.includes('/inputs/')));
      assert.ok(puts.every(entry => entry.key.includes('/results/')));
      assert.doesNotMatch(JSON.stringify(puts), /private-cookie|private-student-identity/);
    } finally { process.umask(priorMask); rmSync(root, { recursive: true, force: true }); }
  });
}

const observation = { version: 1, accountId: account, region: 'us-east-1', origin: baseEnv.CLP_GENERATOR_ORIGIN,
  campaign: config.campaign, loadBalancerFullName: `app/schoolpilot-staging-alb/${'a'.repeat(16)}`,
  targetGroupFullName: `targetgroup/schoolpilot-staging-api-tg/${'b'.repeat(16)}`, redisCacheClusterIds: ['schoolpilot-staging-redis-001'] };

test('observer keeps missing or partial CloudWatch results unknown, without averaging fleet percentiles', () => {
  assert.equal(summarizeMetric({ Values: [], Timestamps: [], StatusCode: 'Complete' }, Date.now()).available, false);
  assert.equal(summarizeMetric({ Values: [1], Timestamps: [new Date().toISOString()], StatusCode: 'PartialData' }, Date.now()).available, false);
  const queries = stagingMetricQueries(observation);
  assert.ok(queries.every(query => !JSON.stringify(query).includes('production')));
  assert.equal(queries.find(query => query.Id === 'alb_target_latency_p95_seconds').MetricStat.Stat, 'p95');
  assert.deepEqual(queries.find(query => query.Id === 'waf_device_blocked').MetricStat.Metric.Dimensions,
    [{ Name: 'WebACL', Value: 'schoolpilot-staging-cloudfront-waf' }, { Name: 'Rule', Value: 'schoolpilot-staging-device-ingest-rate-limit' }]);
  assert.throws(() => stagingObservationConfig({ ...observation, origin: 'https://school-pilot.net' }));
  assert.throws(() => generatorStats({}));
});

test('observer only uses bound read operations, isolates stopped tasks to the campaign and rejects cross-account services', async () => {
  const now = Date.now(), start = new Date(now - 600_000).toISOString(), end = new Date(now).toISOString();
  const clusterArn = task.Cluster;
  const services = ['schoolpilot-staging-api', 'schoolpilot-staging-scheduler-worker'];
  const stopped = [0, 1].map(index => `arn:aws:ecs:us-east-1:${account}:task/schoolpilot-staging-cluster/${String(index).repeat(32)}`);
  const operations = [];
  let wrongAccount = false;
  const read = async (service, operation, args) => {
    operations.push(`${service}/${operation}`);
    if (operation === 'get-metric-data') return { MetricDataResults: [] };
    if (operation === 'describe-services') return { services: services.map(serviceName => ({ serviceName, clusterArn,
      serviceArn: `arn:aws:ecs:us-east-1:${wrongAccount ? '000000000000' : account}:service/schoolpilot-staging-cluster/${serviceName}` })) };
    if (operation === 'describe-target-health') return { TargetHealthDescriptions: [{ TargetHealth: { State: 'healthy' } }] };
    if (operation === 'list-tasks') return { taskArns: args.includes('STOPPED') && args.includes(services[0]) ? stopped : [] };
    if (operation === 'describe-tasks') return { tasks: stopped.map((taskArn, index) => ({ taskArn, clusterArn,
      stoppedAt: new Date(now - (index ? 1_000_000 : 100_000)).toISOString(), stoppedReason: 'OutOfMemoryError', containers: [{ exitCode: 137 }] })) };
    throw new Error('Unexpected operation');
  };
  const result = await observeStaging(observation, start, end, read);
  assert.equal(result.tasks.stopped, 1); assert.equal(result.tasks.historicalStopped, 1); assert.equal(result.tasks.oom, 1);
  assert.equal(result.productionAccepted, false); assert.ok(result.missingMetrics.length > 10);
  assert.ok(operations.every(value => /^(cloudwatch\/get-metric-data|ecs\/(describe-services|list-tasks|describe-tasks)|elbv2\/describe-target-health)$/.test(value)));
  wrongAccount = true;
  await assert.rejects(observeStaging(observation, start, end, read), /staging services/);
});
