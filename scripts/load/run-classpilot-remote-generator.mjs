import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, renameSync, statSync } from 'node:fs';
import { tmpdir, cpus, totalmem } from 'node:os';
import { performance } from 'node:perf_hooks';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { REMOTE_GENERATOR_SCRIPTS, scriptManifest } from './remote-generator-manifest.mjs';
import { reliabilityProfile, measurementExpected, validateCapturePulse, validateRevisionBootstrap, BoundedControlReader, MEASUREMENT_LIMITS, validateMeasurementSignal, CapturePulseProducer, SerialHeartbeatWriter,
  MeasurementStartupGate, validateMeasurementWaiting, measurementPendingSignal, validateMeasurementPendingSignal,
  measurementReadySignal, validateMeasurementReadySignal } from './classpilot-reliability-profile.mjs';
import { validateStagingStartAt, validateStagingRunManifest } from './staging-start-barrier.mjs';

const ORIGIN = 'https://staging.school-pilot.net';
const INPUTS = Object.freeze({ devices: 'devices.json', auth: 'auth.json', commands: 'commands.json' });
const MAX_INPUT_BYTES = 32 * 1024 * 1024;
const MAX_RESULT_BYTES = 16 * 1024 * 1024;
const sha256 = value => createHash('sha256').update(value).digest('hex');
const isSha = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);



const MEASUREMENT_ROLE_KEYS = Object.freeze({
  controller: Object.freeze({ read: Object.freeze(['measurement-ready.json', 'measurement-started.json', 'measurement-drained.json']),
    publish: Object.freeze(['measurement-control.json', 'measurement-bootstrap.json']) }),
  producer: Object.freeze({ read: Object.freeze(['measurement-control.json', 'measurement-bootstrap.json']),
    publish: Object.freeze(['measurement-ready.json', 'measurement-started.json', 'measurement-drained.json']) }),
});
export function measurementChannelPreflightSignal(expected, kind, nonce) {
  if (!['measurement-channel-started-v1', 'measurement-channel-drained-v1'].includes(kind)
    || !/^[a-f0-9]{48}$/.test(nonce || '')) throw Error('Exact channel-only signal required');
  return { schemaVersion: 1, kind, runId: expected.runId, sourceArtifactSha256: expected.sourceArtifactSha256,
    candidateApiImage: expected.candidateApiImage, scriptBundleSha256: expected.scriptBundleSha256,
    planSha256: expected.planSha256, cohortSha256: expected.cohortSha256,
    nonceSha256: sha256(nonce), trafficStarted: false, applicationRequests: 0, preflightOnly: true };
}

function measurementChannelContext(value) {
  const profile = reliabilityProfile(value?.primaryDevices);
  if (Object.keys(value || {}).sort().join(',') !== 'account,bucket,campaign,candidateApiImage,cohortSha256,maximumNavigationRounds,maximumPulses,origin,planSha256,primaryDevices,runId,scriptBundleSha256,sourceArtifactSha256'
    || value.account !== '135775632425' || value.bucket !== 'schoolpilot-staging-load-135775632425'
    || value.origin !== ORIGIN || !/^classpilot-staging-\d{8}-[a-f0-9]{12}$/.test(value.campaign || '')
    || !new RegExp('^' + profile.primaryDevices + '-[a-f0-9]{16}$').test(value.runId || '')
    || !/^135775632425\.dkr\.ecr\.us-east-1\.amazonaws\.com\/schoolpilot-staging-api@sha256:[a-f0-9]{64}$/.test(value.candidateApiImage || '')
    || ['sourceArtifactSha256', 'scriptBundleSha256', 'cohortSha256', 'planSha256'].some(key => !isSha(value[key]))
    || value.maximumPulses !== profile.measurementPlan.maximumPulses
    || value.maximumNavigationRounds !== profile.measurementPlan.navigationRounds
    || value.planSha256 !== sha256(JSON.stringify(profile.measurementPlan))) throw Error('Exact immutable staging channel context required');
  return Object.freeze({ ...value });
}

// These exact adapters serve both actual measurement peers and the separate
// native channel-only probe. They never create an application HTTP client.
// One caller budget spans SDK headers AND body consumption. Abort-insensitive
// operations retain their guard until real settlement, preventing SDK backlog.
export function createMeasurementArtifactChannel({ role, expected, devices, mode = 'workload', startAt, startup,
  s3 = new S3Client({ region: 'us-east-1', maxAttempts: 1 }) } = {}) {
  if (!Object.hasOwn(MEASUREMENT_ROLE_KEYS, role) || !['workload', 'channel-preflight'].includes(mode)) throw Error('Exact measurement peer role and mode required');
  const context = measurementChannelContext(expected), prefix = 'runs/' + context.campaign + '/' + context.runId;
  let waiting = startup ? Object.freeze({ ...validateMeasurementWaiting(startup, context, { startAt, mode }) }) : null;
  const counters = { readAttempts: 0, publishAttempts: 0, actualNetworkAttempts: 0, bytesRead: 0, bytesWritten: 0, invalidRequests: 0 };
  let closed = false;
  const startupPublications = new Set();
  const acceptedPending = new Set();
  let startupAccepted = false, startupFailed = false, waitingPublicationAttempted = false;
  const client = s3, keys = MEASUREMENT_ROLE_KEYS[role];
  if (typeof client?.send !== 'function' || typeof client?.destroy !== 'function'
    || typeof client?.middlewareStack?.add !== 'function') throw Error('Prepared single-attempt measurement SDK required');
  client.middlewareStack.add(next => async args => {
    const request = args.request;
    if (!request || request.protocol !== 'https:' || ![context.bucket + '.s3.us-east-1.amazonaws.com', context.bucket + '.s3.amazonaws.com'].includes(request.hostname)
      || request.headers?.['x-amz-expected-bucket-owner'] !== context.account
      || request.port !== undefined && request.port !== 443
      || !['GET', 'PUT'].includes(request.method)
      || !(request.method === 'GET' ? keys.read.map(name => '/' + prefix + '/' + (role === 'controller' ? 'results' : 'inputs') + '/' + name)
        : keys.publish.map(name => '/' + prefix + '/' + (role === 'controller' ? 'inputs' : 'results') + '/' + name)).includes(request.path)) throw Error('Unexpected measurement SDK destination');
    counters.actualNetworkAttempts += 1;
    return next(args);
  }, { step: 'finalizeRequest', name: 'classpilotMeasurementChannel', priority: 'low' });
  const fileLimit = name => name === 'measurement-bootstrap.json' ? MEASUREMENT_LIMITS.bootstrapBytes : MEASUREMENT_LIMITS.controlBytes;
  const admit = (operation, name) => {
    if (closed || !keys[operation].includes(name)) { counters.invalidRequests += 1; throw Error('Measurement role/key refused'); }
    if (mode === 'channel-preflight' && name === 'measurement-bootstrap.json') { counters.invalidRequests += 1; throw Error('Channel-only mode has no authenticated revision bootstrap'); }
    if (name === 'measurement-bootstrap.json' && !Array.isArray(devices)) { counters.invalidRequests += 1; throw Error('Exact private cohort needed for bootstrap validation'); }
  };
  const signalKind = name => mode === 'channel-preflight'
    ? (name === 'measurement-started.json' ? 'measurement-channel-started-v1' : 'measurement-channel-drained-v1')
    : (name === 'measurement-started.json' ? 'measurement-started-v3' : 'measurement-drained-v3');
  const validate = (name, value, options = {}) => {
    if (name === 'measurement-control.json') {
      if (value?.kind === 'classpilot-measurement-waiting-v1') {
        validateMeasurementWaiting(value, context, { startAt, mode });
        if (waiting && JSON.stringify(waiting) !== JSON.stringify(value)) throw Error('Startup waiting replay refused');
        waiting = waiting || Object.freeze({ ...value });
        return value;
      }
      return validateCapturePulse(value, context);
    }
    if (name === 'measurement-bootstrap.json') return validateRevisionBootstrap(value, context, devices);
    if (name === 'measurement-ready.json') {
      if (!waiting) throw Error('Exact waiting control required before positive readiness');
      return validateMeasurementReadySignal(value, context, waiting);
    }
    if (value?.kind === 'classpilot-measurement-pending-v1') {
      if (!waiting) throw Error('Exact waiting control required before pending signal');
      return validateMeasurementPendingSignal(value, context, waiting, name === 'measurement-started.json' ? 'started' : 'drained');
    }
    const kind = signalKind(name);
    if (options.kind !== undefined && options.kind !== kind) throw Error('Unexpected measurement signal kind');
    if (!/^[a-f0-9]{48}$/.test(options.nonce || '')) throw Error('Expected signal nonce required');
    if (mode === 'channel-preflight') {
      if (JSON.stringify(value) !== JSON.stringify(measurementChannelPreflightSignal(context, kind, options.nonce))) throw Error('Exact channel-only signal required');
      return value;
    }
    return validateMeasurementSignal(value, context, kind, options.nonce);
  };
  const checkedSend = async (command, signal) => {
    const attempts = typeof client.config?.maxAttempts === 'function' ? await client.config.maxAttempts() : client.config?.maxAttempts;
    const region = typeof client.config?.region === 'function' ? await client.config.region() : client.config?.region;
    if (attempts !== 1 || region !== 'us-east-1') throw Error('Measurement SDK must use one attempt in the exact region');
    return client.send(command, { abortSignal: signal });
  };
  const reader = new BoundedControlReader(async ({ name }, { signal }) => {
    counters.readAttempts += 1;
    const side = role === 'controller' ? 'results' : 'inputs';
    const response = await checkedSend(new GetObjectCommand({ Bucket: context.bucket, ExpectedBucketOwner: context.account,
      Key: prefix + '/' + side + '/' + name }), signal);
    const body = response.Body, chunks = []; let length = 0;
    if (!body || typeof body[Symbol.asyncIterator] !== 'function') throw Error('Complete streaming measurement body required');
    const abortBody = () => { try { body.destroy?.(); } catch { /* The caller deadline remains authoritative. */ } };
    signal.addEventListener('abort', abortBody, { once: true });
    if (signal.aborted) abortBody();
    try {
      for await (const chunk of body) {
        if (signal.aborted) throw Error('Measurement body deadline fenced');
        length += chunk.length;
        if (length > fileLimit(name)) { abortBody(); throw Error('Oversized measurement body'); }
        chunks.push(chunk);
      }
      if (signal.aborted) throw Error('Measurement body deadline fenced');
      counters.bytesRead += length;
      return Buffer.concat(chunks);
    } finally { signal.removeEventListener('abort', abortBody); }
  }, { timeoutMs: MEASUREMENT_LIMITS.readMs, maximumBytes: MEASUREMENT_LIMITS.bootstrapBytes });
  const writer = new BoundedControlReader(async ({ name, bytes, initial }, { signal }) => {
    counters.publishAttempts += 1;
    const side = role === 'controller' ? 'inputs' : 'results';
    await checkedSend(new PutObjectCommand({ Bucket: context.bucket, ExpectedBucketOwner: context.account,
      Key: prefix + '/' + side + '/' + name, Body: bytes, ContentType: 'application/json', ServerSideEncryption: 'AES256',
      ...(initial ? { IfNoneMatch: '*' } : {}) }), signal);
    if (signal.aborted) throw Error('Measurement publication deadline fenced');
    counters.bytesWritten += bytes.length;
    return Buffer.from('{"accepted":true}');
  }, { timeoutMs: 500 });
  return Object.freeze({
    async read(name, options) {
      admit('read', name);
      // Signal expectation is checked before sending; malformed expected
      // nonces cannot cause a lookup or falsely accept an old result.
      if (name === 'measurement-started.json' || name === 'measurement-drained.json') {
        const kind = signalKind(name);
        if (!/^[a-f0-9]{48}$/.test(options?.nonce || '') || options?.kind !== undefined && options.kind !== kind) {
          counters.invalidRequests += 1; throw Error('Expected exact signal required');
        }
      }
      return validate(name, await reader.read({ name }), options);
    },
    async publish(name, value, options) {
      admit('publish', name);
      validate(name, value, options);
      const initial = ['classpilot-measurement-waiting-v1', 'classpilot-measurement-pending-v1', 'classpilot-measurement-ready-v1'].includes(value?.kind);
      if (value?.kind === 'classpilot-measurement-waiting-v1') {
        if (waitingPublicationAttempted) throw Error('Unknown waiting seed is never resent');
        waitingPublicationAttempted = true;
      }
      if (startAt && role === 'producer') {
        const pending = value?.kind === 'classpilot-measurement-pending-v1';
        if (startupFailed) throw Error('Unknown or failed startup is permanently fenced');
        if (pending || name === 'measurement-ready.json') {
          if (name === 'measurement-ready.json' && acceptedPending.size !== 2) throw Error('Both producer pending outputs must be accepted before Ready');
          if (startupPublications.has(name) || pending && startupPublications.has('measurement-ready.json')) throw Error('Startup publication replay refused');
          startupPublications.add(name); // Unknown writes are never resent.
        } else if (!startupAccepted) throw Error('Startup must be accepted before producer causal publications');
      }
      const bytes = Buffer.from(JSON.stringify(value));
      if (bytes.length > fileLimit(name)) { counters.invalidRequests += 1; throw Error('Oversized measurement publication'); }
      let result;
      try { result = await writer.read({ name, bytes, initial }); }
      catch (error) {
        if (value?.kind === 'classpilot-measurement-pending-v1' || name === 'measurement-ready.json') startupFailed = true;
        throw error;
      }
      if (value?.kind === 'classpilot-measurement-pending-v1') acceptedPending.add(name);
      if (name === 'measurement-ready.json') startupAccepted = true;
      return result;
    },
    summary: () => ({ role, mode, ...counters, startupAccepted, startupFailed, acceptedPending: acceptedPending.size,
      reader: { ...reader.counters }, publisher: { ...writer.counters },
      readInFlight: Boolean(reader.active), publicationInFlight: Boolean(writer.active) }),
    close() { closed = true; client.destroy(); },
  });
}

const measurementStages = new Set(['configuration', 'metadata', 'waiting-read', 'pending-publish', 'ready-publish',
  'control-read', 'bootstrap-read', 'start-publish', 'drain-publish', 'cleanup', 'harness', 'unknown']);
export function measurementOperationRetryable(error) {
  if ([403, 404].includes(error?.$metadata?.httpStatusCode) || ['NoSuchKey', 'AccessDenied'].includes(error?.name)) return false;
  return error?.name === 'AbortError' || ['deadline', 'busy'].includes(error?.measurementReadCode);
}
export function measurementFailureDiagnostic(error, fallbackStage = 'unknown') {
  const stage = measurementStages.has(error?.measurementStage) ? error.measurementStage
    : measurementStages.has(fallbackStage) ? fallbackStage : 'unknown';
  const status = error?.$metadata?.httpStatusCode;
  const code = status === 403 ? 'access-denied' : status === 404 ? 'missing-required-object'
    : status === 429 ? 'rate-limited' : status >= 500 && status <= 599 ? 'storage-unavailable'
    : error?.name === 'AbortError' || error?.name === 'TimeoutError' || /deadline|settling/.test(error?.message || '')
      ? 'deadline-or-unsettled' : 'refused';
  return { schemaVersion: 1, kind: 'measurement-stage-failure-v1', stage, code };
}
async function atMeasurementStage(stage, operation) {
  try { return await operation(); }
  catch (error) { const wrapped = error instanceof Error ? error : Error('Refused'); wrapped.measurementStage = stage; throw wrapped; }
}

export async function establishMeasurementStartup({ channel, expected, startAt, mode = 'workload',
  now = Date.now, notify = () => {} }) {
  const gate = new MeasurementStartupGate(expected, { startAt, mode, now });
  const waiting = gate.acceptWaiting(await atMeasurementStage('waiting-read', () => channel.read('measurement-control.json')));
  for (const name of ['started', 'drained']) {
    await atMeasurementStage('pending-publish', () => channel.publish('measurement-' + name + '.json',
      measurementPendingSignal(expected, waiting, name)));
  }
  const ready = measurementReadySignal(expected, waiting, new Date(now()).toISOString());
  await atMeasurementStage('ready-publish', () => channel.publish('measurement-ready.json', ready));
  gate.markReady();
  // Only accepted writes of both pending outputs and Ready permit this log.
  // The launcher observes it before the controller reads any result key.
  notify(ready);
  return gate;
}


export function remoteGeneratorConfig(env, manifest) {
  const account = env.CLP_GENERATOR_ACCOUNT_ID || '';
  const campaign = env.CLP_GENERATOR_CAMPAIGN || '';
  const runId = env.CLP_GENERATOR_RUN_ID || '';
  const profile = reliabilityProfile(Number(env.CLP_GENERATOR_DEVICES));
  validateStagingStartAt(env.CLP_GENERATOR_START_AT, ORIGIN);
  if (!/^\d{12}$/.test(account) || env.CLP_GENERATOR_BUCKET !== `schoolpilot-staging-load-${account}`
      || !/^classpilot-staging-\d{8}-[a-f0-9]{12}$/.test(campaign)
      || !new RegExp(`^${profile.primaryDevices}-[a-f0-9]{12,32}$`).test(runId)
      || env.CLP_GENERATOR_ORIGIN !== ORIGIN || env.AWS_REGION !== 'us-east-1'
      || !isSha(env.CLP_GENERATOR_INPUT_SHA256) || !isSha(env.CLP_GENERATOR_SCRIPT_SHA256)
      || !/^sha256:[a-f0-9]{64}$/.test(env.CLP_GENERATOR_IMAGE_DIGEST || '')
      || manifest.version !== 1 || manifest.scriptBundleSha256 !== env.CLP_GENERATOR_SCRIPT_SHA256
      || manifest.candidateApiImage !== env.CLP_GENERATOR_CANDIDATE_IMAGE
      || !manifest.candidateApiImage.startsWith(`${account}.dkr.ecr.us-east-1.amazonaws.com/schoolpilot-staging-api@sha256:`)) {
    throw new Error('Remote generator requires exact staging, campaign, input and candidate bindings');
  }
  if (['DATABASE_URL', 'REDIS_URL', 'SESSION_SECRET', 'JWT_SECRET', 'STUDENT_TOKEN_SECRET', 'SENDGRID_API_KEY',
    'STRIPE_SECRET_KEY', 'GOOGLE_CLIENT_SECRET', 'ANTHROPIC_API_KEY', 'GEMINI_API_KEY', 'OPENAI_API_KEY',
    'TELEGRAM_BOT_TOKEN', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN'].some(key => Boolean(env[key]))) {
    throw new Error('Generator must use only its artifact task role, without app or provider credentials');
  }
  return { account, campaign, runId, profile, bucket: env.CLP_GENERATOR_BUCKET,
    prefix: `runs/${campaign}/${runId}`, inputSha256: env.CLP_GENERATOR_INPUT_SHA256,
    scriptBundleSha256: manifest.scriptBundleSha256, candidateApiImage: manifest.candidateApiImage,
    generatorImageDigest: env.CLP_GENERATOR_IMAGE_DIGEST, startAt: env.CLP_GENERATOR_START_AT };
}

export function validateGeneratorTask(value, config) {
  const taskPrefix = `arn:aws:ecs:us-east-1:${config.account}:task/schoolpilot-staging-cluster/`;
  const containers = (value.Containers || []).filter(container => container.Type === 'NORMAL');
  if (value.LaunchType !== 'FARGATE' || value.Family !== 'schoolpilot-staging-load-generator'
      || value.Cluster !== `arn:aws:ecs:us-east-1:${config.account}:cluster/schoolpilot-staging-cluster`
      || typeof value.TaskARN !== 'string' || !value.TaskARN.startsWith(taskPrefix)
      || !/^[a-f0-9]{32}$/.test(value.TaskARN.slice(taskPrefix.length))
      || value.Limits?.CPU !== 2 || value.Limits?.Memory !== 4096 || containers.length !== 1
      || containers[0].ImageID !== config.generatorImageDigest
      || !new RegExp(`^${config.account}\\.dkr\\.ecr\\.us-east-1\\.amazonaws\\.com/schoolpilot-staging-(?:api|load-generator)@${config.generatorImageDigest}$`).test(containers[0].Image || '')) {
    throw new Error('Generator must be the bound single-container staging Fargate task with reviewed limits');
  }
  return { taskArn: value.TaskARN, family: value.Family, revision: value.Revision,
    generatorImage: containers[0].Image, generatorImageDigest: containers[0].ImageID,
    taskCpuVcpus: value.Limits.CPU, taskMemoryMiB: value.Limits.Memory };
}

async function readTaskMetadata(env, suffix = '/task') {
  let url;
  try { url = new URL(env.ECS_CONTAINER_METADATA_URI_V4); } catch { throw new Error('Fargate metadata endpoint required'); }
  if (url.protocol !== 'http:' || url.hostname !== '169.254.170.2' || url.port || url.username || url.password
      || url.search || url.hash || !/^\/v4\/[A-Za-z0-9_-]{1,200}$/.test(url.pathname)) throw new Error('Only the Fargate metadata endpoint is allowed');
  const response = await fetch(`${url.href}${suffix}`, { signal: AbortSignal.timeout(5_000), redirect: 'error' });
  if (!response.ok) throw new Error('Fargate metadata unavailable');
  return response.json();
}

export function generatorStats(value) {
  const stats = Object.values(value);
  if (stats.length !== 1) throw new Error('One generator container statistics stream required');
  const sample = stats[0];
  const networks = Object.values(sample.networks || {});
  if (!networks.length || networks.some(network => !Number.isFinite(network.rx_bytes) || network.rx_bytes < 0
      || !Number.isFinite(network.tx_bytes) || network.tx_bytes < 0)) throw new Error('Complete explicit generator network statistics required');
  const result = { cpuTotalUsageNs: sample.cpu_stats?.cpu_usage?.total_usage,
    throttledPeriods: sample.cpu_stats?.throttling_data?.throttled_periods,
    throttledTimeNs: sample.cpu_stats?.throttling_data?.throttled_time,
    memoryUsageBytes: sample.memory_stats?.usage, memoryLimitBytes: sample.memory_stats?.limit,
    networkRxBytes: networks.reduce((total, network) => total + network.rx_bytes, 0),
    networkTxBytes: networks.reduce((total, network) => total + network.tx_bytes, 0) };
  if (Object.values(result).some(number => !Number.isFinite(number) || number < 0) || result.memoryLimitBytes <= 0) throw new Error('Incomplete generator resource statistics');
  return result;
}

export function validateInputManifest(value, config, now = Date.now()) {
  validateStagingRunManifest(value, { startAt: config.startAt, primaryDevices: config.profile.primaryDevices,
    authSha256: value.files?.auth?.sha256 }, now);
  const created = Date.parse(value.createdAt);
  if (value.version !== 2 || value.campaign !== config.campaign || value.runId !== config.runId
      || value.startAt !== config.startAt
      || value.primaryDevices !== config.profile.primaryDevices || value.candidateApiImage !== config.candidateApiImage
      || value.scriptBundleSha256 !== config.scriptBundleSha256 || !Number.isFinite(created)
      || now - created < 0 || now - created > 15 * 60_000
      || Object.keys(value.files || {}).sort().join(',') !== Object.keys(INPUTS).sort().join(',')) {
    throw new Error('Input manifest is stale or does not match this exact staging run');
  }
  for (const key of Object.keys(INPUTS)) {
    const file = value.files[key];
    if (!isSha(file?.sha256) || !Number.isSafeInteger(file.bytes) || file.bytes < 1 || file.bytes > MAX_INPUT_BYTES) {
      throw new Error('Input manifest must bind bounded exact file bytes');
    }
  }
  return value;
}

export function generatorChildEnvironment(parent, config, directory) {
  // Never inherit arbitrary LOAD_* knobs, credentials, proxy settings or test bypasses.
  const env = {};
  for (const key of ['PATH', 'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'SSL_CERT_DIR']) {
    if (parent[key]) env[key] = parent[key];
  }
  return { ...env, NODE_ENV: 'production', APP_ENV: 'staging', LOCALAPPDATA: directory,
    LOAD_BASE_URL: ORIGIN, LOAD_RELIABILITY_STAGING_ORIGIN: ORIGIN,
    LOAD_SESSION_COOKIE_NAME: 'schoolpilot.staging.sid', LOAD_RUN_ID: config.runId,
    LOAD_TRAFFIC_START_AT: config.startAt, LOAD_TRAFFIC_READY_PATH: join(directory, 'ready.json'),
    LOAD_STAGE: `isolated-staging-${config.profile.primaryDevices}`, LOAD_SHARED_IP_LABEL: 'one-fargate-task-egress',
    LOAD_DEVICE_MANIFEST: join(directory, 'SchoolPilot', 'load-gates', INPUTS.devices),
    LOAD_TEACHER_AUTH_FILE: join(directory, 'SchoolPilot', 'load-gates', INPUTS.auth),
    LOAD_COMMAND_BODIES_FILE: join(directory, 'SchoolPilot', 'load-gates', INPUTS.commands),
    LOAD_EXTERNAL_PROGRESS_PATH: join(directory, 'progress.jsonl'), LOAD_EXTERNAL_SUMMARY_PATH: join(directory, 'summary.json') };
}

function privateValues(value, result = new Set(), sensitive = false) {
  if (Array.isArray(value)) for (const item of value) privateValues(item, result, sensitive);
  else if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) privateValues(item, result, sensitive || /(?:ids?$|token|cookie|csrf|password|email)/i.test(key));
  } else if (sensitive && typeof value === 'string' && value.length >= 6) result.add(value);
  return result;
}

export function assertAggregateEvidence(text, secrets) {
  if (typeof text !== 'string' || Buffer.byteLength(text) > MAX_RESULT_BYTES
      || /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/.test(text)) {
    throw new Error('Only bounded aggregate evidence may leave the generator');
  }
  for (const secret of secrets) if (text.includes(secret)) throw new Error('Private fixture values cannot enter evidence');
  return text;
}

function systemLimits() {
  const read = path => { try { return readFileSync(path, 'utf8').trim(); } catch { return null; } };
  return { nodeVersion: process.version, hostLogicalCpus: cpus().length, hostMemoryBytes: totalmem(),
    cgroupCpuMax: read('/sys/fs/cgroup/cpu.max'), cgroupMemoryMax: read('/sys/fs/cgroup/memory.max'),
    cgroupV1CpuQuota: read('/sys/fs/cgroup/cpu/cpu.cfs_quota_us'),
    cgroupV1CpuPeriod: read('/sys/fs/cgroup/cpu/cpu.cfs_period_us'),
    cgroupV1MemoryLimit: read('/sys/fs/cgroup/memory/memory.limit_in_bytes'),
    openFilesLimit: read('/proc/self/limits')?.split('\n').find(line => line.startsWith('Max open files')) || null };
}

export async function boundedArtifactBody(body, limit, timeoutMs = 30_000) {
  let timer;
  const stalled = new Promise((_, reject) => {
    timer = setTimeout(() => {
      try { body.destroy?.(); } catch { /* The consumer deadline remains authoritative. */ }
      reject(new Error('Artifact body deadline exceeded'));
    }, timeoutMs);
  });
  const consume = async () => {
    const chunks = []; let length = 0;
    for await (const chunk of body) {
      length += chunk.length;
      if (length > limit) { body.destroy?.(); throw new Error('Artifact exceeds its bounded size'); }
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  };
  try { return await Promise.race([consume(), stalled]); }
  finally { clearTimeout(timer); }
}

async function executeHarness(env, devices, dryRun = false, signal) {
  const boundedStartWaitMs = Math.max(0, validateStagingStartAt(env.LOAD_TRAFFIC_START_AT, ORIGIN) - Date.now());
  const grouped = process.platform !== 'win32';
  const child = spawn(process.execPath, [fileURLToPath(new URL('./run-classpilot-reliability.mjs', import.meta.url)),
    '--devices', String(devices), ...(dryRun ? ['--dry-run'] : [])], { env, detached: grouped, stdio: ['ignore', 'ignore', 'ignore'] });
  const forward = signal => {
    try { if (grouped && child.pid) process.kill(-child.pid, signal); else child.kill(signal); }
    catch (error) { if (error.code !== 'ESRCH') throw error; }
  };
  const term = () => forward('SIGTERM'); const interrupt = () => forward('SIGINT');
  signal?.addEventListener('abort', term, { once: true });
  if (signal?.aborted) term();
  process.on('SIGTERM', term); process.on('SIGINT', interrupt);
  const deadline = setTimeout(() => forward('SIGTERM'), boundedStartWaitMs + (reliabilityProfile(devices).durationSeconds + 180) * 1_000);
  const hardDeadline = setTimeout(() => forward('SIGKILL'), boundedStartWaitMs + (reliabilityProfile(devices).durationSeconds + 210) * 1_000);
  deadline.unref();
  hardDeadline.unref();
  try {
    return await new Promise((resolve_, reject) => {
      child.once('error', () => reject(new Error('Harness process could not start')));
      child.once('exit', code => resolve_(code ?? 1));
    });
  } finally { clearTimeout(deadline); clearTimeout(hardDeadline); signal?.removeEventListener('abort', term); process.off('SIGTERM', term); process.off('SIGINT', interrupt); }
}

export function validateSuccessfulFleetSummary(value, config) {
  const profile = config.profile;
  if (value.runId !== config.runId || value.targetOrigin !== ORIGIN || value.devices !== profile.primaryDevices + 10
      || value.stagingStart?.plannedStartAt !== config.startAt || !Number.isFinite(value.stagingStart?.startSkewMs)
      || Math.abs(value.stagingStart.startSkewMs) > 1000
      || Date.parse(value.stagingStart.actualStartedAt) - Date.parse(config.startAt) !== value.stagingStart.startSkewMs
      || !Number.isFinite(Date.parse(value.stagingStart.readyAt)) || Date.parse(value.stagingStart.readyAt) >= Date.parse(config.startAt)
      || value.workloadSchemaVersion !== profile.version || value.reliabilityWorkload?.primaryDevices !== profile.primaryDevices
      || value.reliabilityWorkload?.durationSeconds !== profile.durationSeconds
      || value.reliabilityWorkload?.productionAccepted !== false || value.reliabilityWorkload?.managedDevicesValidated !== false
      || value.browserPaintValidated !== false || value.certificationEligible !== false
      || value.thresholds?.enforced !== true || value.thresholds?.passed !== true || value.thresholds?.failures?.length !== 0
      || value.run?.completedConfiguredDuration !== true || value.run?.shutdownReason !== 'duration'
      || value.run?.acceleratedLoopbackTest !== false || value.run?.testOnlyLatencyThresholdMultiplier !== 1
      || value.run?.plannedTrafficSeconds !== profile.durationSeconds || value.run?.actualTrafficSeconds < profile.durationSeconds
      || !Number.isFinite(value.run?.actualTrafficSeconds) || value.artifacts?.externalProgressFinalized !== true
      || value.artifacts?.externalSummaryWritten !== true) {
    throw new Error('Successful generator exit requires complete enforced evidence for its exact fixed fleet profile');
  }
  return value;
}

function installedGeneratorConfig(env, manifestPath) {
  const savedManifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const actualManifest = scriptManifest(dirname(fileURLToPath(import.meta.url)), savedManifest.candidateApiImage, REMOTE_GENERATOR_SCRIPTS);
  if (JSON.stringify(savedManifest) !== JSON.stringify(actualManifest)) throw new Error('Installed generator scripts differ from the image manifest');
  return remoteGeneratorConfig(env, actualManifest);
}

export async function preflightGeneratorMetadata({ env = process.env, manifestPath = '/app/load-generator-manifest.json', metadata = readTaskMetadata } = {}) {
  const config = installedGeneratorConfig(env, manifestPath);
  const task = validateGeneratorTask(await metadata(env), config);
  const stats = generatorStats(await metadata(env, '/task/stats'));
  return { version: 1, phase: 'metadata-preflight', campaign: config.campaign, runId: config.runId,
    candidateApiImage: config.candidateApiImage, scriptBundleSha256: config.scriptBundleSha256,
    task, limits: systemLimits(), stats, trafficStarted: false, inputsDownloaded: false,
    productionAccepted: false, browserPaintValidated: false, managedDevicesValidated: false };
}


export async function runMeasurementChannelPreflight({ env = process.env,
  manifestPath = '/app/load-generator-manifest.json', metadata = readTaskMetadata, measurementS3,
  notify = value => console.log(JSON.stringify(value)) } = {}) {
  // This branch executes before any input download, application client or
  // harness spawn. The CLI supplies no alternate oracle/injected callbacks.
  if (process.platform !== 'linux' || process.getuid?.() !== 1000 || tmpdir() !== '/tmp') throw Error('Native Linux UID1000 scratch required');
  const meta = await atMeasurementStage('metadata', () => preflightGeneratorMetadata({ env, manifestPath, metadata }));
  const raw = env.CLP_MEASUREMENT_CHANNEL_CONTEXT || '';
  if (!raw || Buffer.byteLength(raw) > 4096 || sha256(Buffer.from(raw)) !== env.CLP_GENERATOR_INPUT_SHA256) throw Error('Exact bounded channel-only context required');
  const expected = measurementChannelContext(JSON.parse(raw));
  if (expected.campaign !== meta.campaign || expected.runId !== meta.runId
    || expected.candidateApiImage !== meta.candidateApiImage || expected.scriptBundleSha256 !== meta.scriptBundleSha256) throw Error('Native channel context identity mismatch');
  const expiresAt = env.CLP_MEASUREMENT_CHANNEL_EXPIRES_AT || '', expiry = Date.parse(expiresAt);
  const now = Date.now();
  if (!Number.isFinite(expiry) || new Date(expiry).toISOString() !== expiresAt || expiry <= now
    || expiry - now > 300000 || expiry !== Date.parse(env.CLP_GENERATOR_START_AT) + 60000) throw Error('Finite native channel expiry required');
  process.umask(0o077);
  const directory = mkdtempSync(join(tmpdir(), 'classpilot-channel-'));
  if (dirname(directory) !== '/tmp' || !/^classpilot-channel-[A-Za-z0-9]+$/.test(directory.slice('/tmp/'.length))) throw Error('Owned native scratch path required');
  const owner = statSync(directory);
  if (owner.uid !== 1000 || (owner.mode & 0o077) !== 0) throw Error('Owned private UID1000 scratch required');
  const probe = join(directory, 'native-scratch-probe');
  writeFileSync(probe, 'classpilot-native-channel', { mode: 0o600, flag: 'wx' });
  if (readFileSync(probe, 'utf8') !== 'classpilot-native-channel' || statSync(probe).uid !== 1000) throw Error('Native scratch write/read failed');
  rmSync(probe);
  const channel = createMeasurementArtifactChannel({ role: 'producer', expected, mode: 'channel-preflight',
    startAt: env.CLP_GENERATOR_START_AT, s3: measurementS3 });
  const producer = new CapturePulseProducer(expected, () => performance.now());
  const localWriter = new SerialHeartbeatWriter({ now: () => performance.now(),
    schedule: (callback, ms) => setTimeout(callback, ms), clear: clearTimeout,
    snapshot: () => Object.freeze({ syntheticChannelOnly: true }),
    send: async () => { await new Promise(resolve_ => setTimeout(resolve_, 20)); return { ok: true }; } });
  const stopAt = performance.now() + expiry - now;
  let ready = false, firstNonce = null, drained = false, channelStarted = false;
  const receipt = { schemaVersion: 1, kind: 'native-measurement-channel-preflight-v1',
    campaign: expected.campaign, runId: expected.runId, sourceArtifactSha256: expected.sourceArtifactSha256,
    candidateApiImage: expected.candidateApiImage, scriptBundleSha256: expected.scriptBundleSha256,
    planSha256: expected.planSha256, cohortSha256: expected.cohortSha256,
    task: meta.task, limits: meta.limits, stats: meta.stats, platform: process.platform, uid: process.getuid(),
    scratchOwnerUid: owner.uid, scratchPrivate: true, scratchReadWriteDeletePassed: true,
    applicationRequests: 0, inputsDownloaded: false, trafficStarted: false, channelStarted: false,
    simulatedLocalWriterOnly: true, capacityAcceptance: false, productionAccepted: false };
  try {
    const startupGate = await establishMeasurementStartup({ channel, expected, startAt: env.CLP_GENERATOR_START_AT,
      mode: 'channel-preflight', notify: startupReady => notify({ ...receipt, phase: 'channel-ready',
        startupReady, adapter: channel.summary() }) });
    ready = true;
    while (performance.now() < stopAt && Date.now() < expiry) {
      let pulse;
      try {
        pulse = startupGate.control(await atMeasurementStage('control-read', () => channel.read('measurement-control.json')));
        if (!pulse) { await new Promise(resolve_ => setTimeout(resolve_, MEASUREMENT_LIMITS.pollMs)); continue; }
      }
      catch (error) {
        if (!measurementOperationRetryable(error)) throw error;
        await new Promise(resolve_ => setTimeout(resolve_, MEASUREMENT_LIMITS.pollMs)); continue;
      }
      if (Date.now() >= expiry || performance.now() >= stopAt) throw Error('Channel challenge expired');
      if (!ready) throw Error('First pulse arrived before native channel readiness');
      if (!producer.latest || pulse.pulseSequence > producer.latest.pulseSequence) producer.adopt(pulse);
      if (!firstNonce) {
        if (pulse.pulseSequence !== 1) throw Error('Native channel must start from the first unpredictable challenge');
        firstNonce = pulse.nonce;
        await atMeasurementStage('start-publish', () => channel.publish('measurement-started.json',
          measurementChannelPreflightSignal(expected, 'measurement-channel-started-v1', firstNonce), { nonce: firstNonce }));
        channelStarted = true;
      }
      if (pulse.revisionDrainNonce) {
        localWriter.regular(); localWriter.hold();
        const drainDeadline = Math.min(stopAt, performance.now() + 500);
        while (localWriter.active && performance.now() < drainDeadline) await new Promise(resolve_ => setTimeout(resolve_, 5));
        if (localWriter.active) throw Error('Synthetic writer failed to drain');
        await atMeasurementStage('drain-publish', () => channel.publish('measurement-drained.json',
          measurementChannelPreflightSignal(expected, 'measurement-channel-drained-v1', pulse.revisionDrainNonce), { nonce: pulse.revisionDrainNonce }));
        drained = true; break;
      }
      await new Promise(resolve_ => setTimeout(resolve_, MEASUREMENT_LIMITS.pollMs));
    }
    if (!channelStarted || !drained) throw Error('Native channel start/drain incomplete');
    const result = { ...receipt, phase: 'completed', channelStarted, channelDrained: drained,
      adapter: channel.summary(), simulatedWriter: { ...localWriter.counters }, passed: true };
    notify(result); return result;
  } finally {
    channel.close();
    if (localWriter.timer !== null) clearTimeout(localWriter.timer);
    // Exact new owned directory, never a caller-selected or input path.
    if (dirname(directory) !== '/tmp' || statSync(directory).uid !== 1000) throw Error('Native scratch cleanup fence failed');
    rmSync(directory, { recursive: true, force: true });
  }
}


export async function runRemoteGenerator({ env = process.env, manifestPath = '/app/load-generator-manifest.json',
  s3 = new S3Client({ region: 'us-east-1', maxAttempts: 2 }), measurementS3, execute = executeHarness, metadata = readTaskMetadata } = {}) {
  const config = installedGeneratorConfig(env, manifestPath);
  const task = validateGeneratorTask(await metadata(env), config);
  process.umask(0o077);
  const directory = mkdtempSync(join(tmpdir(), 'classpilot-remote-'));
  const artifactRoot = join(directory, 'SchoolPilot', 'load-gates');
  mkdirSync(artifactRoot, { recursive: true, mode: 0o700 });
  const childEnv = generatorChildEnvironment(env, config, directory);
  const secrets = new Set();
  const startedAt = new Date().toISOString();
  const receipt = { version: 1, campaign: config.campaign, runId: config.runId, primaryDevices: config.profile.primaryDevices,
    candidateApiImage: config.candidateApiImage, scriptBundleSha256: config.scriptBundleSha256,
    inputManifestSha256: config.inputSha256, startedAt, limits: systemLimits(), phase: 'fetching', samples: [],
    plannedTrafficStartAt: config.startAt,
    task,
    productionAccepted: false, browserPaintValidated: false, managedDevicesValidated: false };
  let uploadFailure = false; let syncing = false; let interval; let finished = false; let previousStats;
  let controlLoop = null, controlStopped = false, ownedMeasurementChannel = null;
  const controlCounters = { networkAttempts: 0, absent: 0, accepted: 0, invalid: 0, bootstrapReads: 0, bytes: 0 };
  receipt.measurementControl = controlCounters;
  const controller = new AbortController();
  const get = async name => {
    const result = await s3.send(new GetObjectCommand({ Bucket: config.bucket, Key: `${config.prefix}/inputs/${name}` }), { abortSignal: AbortSignal.timeout(30_000) });
    return boundedArtifactBody(result.Body, MAX_INPUT_BYTES);
  };
  const put = async (name, body) => {
    assertAggregateEvidence(body, secrets);
    await s3.send(new PutObjectCommand({ Bucket: config.bucket, Key: `${config.prefix}/results/${name}`,
      Body: body, ContentType: name.endsWith('.jsonl') ? 'application/x-ndjson' : 'application/json', ServerSideEncryption: 'AES256' }),
    { abortSignal: AbortSignal.timeout(30_000) });
  };
  const sync = async () => {
    if (syncing) return; syncing = true;
    try {
      const stats = generatorStats(await metadata(env, '/task/stats'));
      const monotonicNs = process.hrtime.bigint();
      const cpuPercent = previousStats ? Math.max(0, (stats.cpuTotalUsageNs - previousStats.cpuTotalUsageNs)
        / Number(monotonicNs - previousStats.monotonicNs) / task.taskCpuVcpus * 100) : null;
      previousStats = { ...stats, monotonicNs };
      receipt.samples.push({ timestamp: new Date().toISOString(), ...stats,
        cpuPercentOfTaskAllocation: cpuPercent, memoryPercentOfTaskAllocation: stats.memoryUsageBytes / (task.taskMemoryMiB * 1024 * 1024) * 100,
        supervisorRssBytes: process.memoryUsage().rss, supervisorCpuUsage: process.cpuUsage() });
      for (const name of ['ready.json', 'progress.jsonl', 'summary.json']) {
        const path = join(directory, name);
        if (!existsSync(path)) continue;
        const text = readFileSync(path, 'utf8');
        const values = name.endsWith('.jsonl') ? text.trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [JSON.parse(text)];
        if (values.some(value => value.runId !== config.runId)) throw new Error('Evidence belongs to another run');
        if (name === 'summary.json' && values[0].targetOrigin !== ORIGIN) throw new Error('Summary origin must be isolated staging');
        if (name === 'ready.json' && (values[0].plannedStartAt !== config.startAt || values[0].trafficStarted !== false)) throw new Error('Ready receipt does not match shared staging start');
        if (name === 'progress.jsonl' && receipt.phase === 'waiting-for-start' && values.some(value => value.event === 'start')) receipt.phase = 'running';
        await put(name, text);
      }
      await put('generator.json', JSON.stringify(receipt));
    } catch { uploadFailure = true; controller.abort(); } finally { syncing = false; }
  };
  try {
    const rawManifest = await get('manifest.json');
    if (sha256(rawManifest) !== config.inputSha256) throw new Error('Input manifest checksum does not match');
    const inputManifest = validateInputManifest(JSON.parse(rawManifest), config);
    childEnv.LOAD_INPUT_MANIFEST_CREATED_AT = inputManifest.createdAt;
    childEnv.LOAD_MEASUREMENT_MANIFEST = join(directory, 'measurement-manifest.json');
    childEnv.LOAD_MEASUREMENT_CONTROL = join(directory, 'measurement-control.json');
    childEnv.LOAD_MEASUREMENT_BOOTSTRAP = join(directory, 'measurement-bootstrap.json');
    childEnv.LOAD_MEASUREMENT_STARTED = join(directory, 'measurement-started.json');
    childEnv.LOAD_MEASUREMENT_DRAINED = join(directory, 'measurement-drained.json');
    writeFileSync(childEnv.LOAD_MEASUREMENT_MANIFEST, rawManifest, { flag: 'wx', mode: 0o600 });
    for (const [key, name] of Object.entries(INPUTS)) {
      const bytes = await get(name);
      if (bytes.length !== inputManifest.files[key].bytes || sha256(bytes) !== inputManifest.files[key].sha256) throw new Error('Private input checksum does not match');
      privateValues(JSON.parse(bytes), secrets);
      writeFileSync(join(artifactRoot, name), bytes, { flag: 'wx', mode: 0o600 });
    }
    receipt.phase = 'preflight'; await sync();
    if (uploadFailure || await execute(childEnv, config.profile.primaryDevices, true, controller.signal) !== 0) throw new Error('Remote harness preflight refused');
    // The same role-scoped adapters serve the native channel proof and the
    // actual producer. No alternate S3 transport oracle is used.
    const expected = measurementExpected(inputManifest, config.inputSha256);
    const measurementChannel = createMeasurementArtifactChannel({ role: 'producer', expected, startAt: config.startAt, s3: measurementS3,
      devices: JSON.parse(readFileSync(join(artifactRoot, INPUTS.devices))) });
    ownedMeasurementChannel = measurementChannel;
    const startupGate = await establishMeasurementStartup({ channel: measurementChannel, expected, startAt: config.startAt,
      notify: startupReady => console.log(JSON.stringify({ schemaVersion: 1, kind: 'measurement-producer-ready-v1',
        phase: 'measurement-ready', task, startupReady, applicationRequests: 0, trafficStarted: false })) });
    let latestSequence = 0, bootstrapSha = null, firstNonce = null, drainNonce = null, startUploaded = false, drainUploaded = false;
    const atomic = (filename, bytes) => { const temporary = filename + '.next'; writeFileSync(temporary, bytes, { mode: 0o600 }); renameSync(temporary, filename); };
    const syncChannelCounters = () => {
      const value = measurementChannel.summary();
      controlCounters.networkAttempts = value.readAttempts;
      controlCounters.actualNetworkAttempts = value.actualNetworkAttempts;
      controlCounters.bytes = value.bytesRead;
      controlCounters.reader = value.reader;
      controlCounters.publisher = value.publisher;
      controlCounters.channel = value;
    };
    controlLoop = (async () => {
      while (!controlStopped && !controller.signal.aborted) {
        try {
          const value = await atMeasurementStage('control-read', () => measurementChannel.read('measurement-control.json'));
          const pulse = startupGate.control(value);
          if (!pulse) { syncChannelCounters(); await new Promise(resolve_ => setTimeout(resolve_, MEASUREMENT_LIMITS.pollMs)); continue; }
          if (pulse.pulseSequence === 1) firstNonce = pulse.nonce;
          if (pulse.revisionDrainNonce) drainNonce = pulse.revisionDrainNonce;
          if (pulse.pulseSequence > latestSequence) {
            if (pulse.revisionBaselinesSha256 && bootstrapSha !== pulse.revisionBaselinesSha256) {
              controlCounters.bootstrapReads += 1;
              const bootstrap = await measurementChannel.read('measurement-bootstrap.json');
              validateRevisionBootstrap(bootstrap, expected, JSON.parse(readFileSync(join(artifactRoot, INPUTS.devices))));
              const bytes = Buffer.from(JSON.stringify(bootstrap));
              if (sha256(bytes) !== pulse.revisionBaselinesSha256) throw Error('Revision bootstrap digest mismatch');
              atomic(childEnv.LOAD_MEASUREMENT_BOOTSTRAP, bytes); bootstrapSha = pulse.revisionBaselinesSha256;
            }
            if (pulse.navigationRound && bootstrapSha !== pulse.revisionBaselinesSha256) throw Error('Navigation bootstrap missing');
            atomic(childEnv.LOAD_MEASUREMENT_CONTROL, Buffer.from(JSON.stringify(pulse)));
            latestSequence = pulse.pulseSequence; controlCounters.accepted += 1;
          }
        } catch (error) {
          if (measurementOperationRetryable(error)) { /* Honest bounded misses remain counted by the reader. */ }
          else { controlCounters.invalid += 1; console.error(JSON.stringify(measurementFailureDiagnostic(error))); controller.abort(); }
        }
        for (const [kind, filename, nonce, uploaded] of [
          ['measurement-started-v3', childEnv.LOAD_MEASUREMENT_STARTED, firstNonce, startUploaded],
          ['measurement-drained-v3', childEnv.LOAD_MEASUREMENT_DRAINED, drainNonce, drainUploaded]]) {
          if (nonce && !uploaded && existsSync(filename)) {
            try {
              const value = validateMeasurementSignal(JSON.parse(readFileSync(filename)), expected, kind, nonce);
              await measurementChannel.publish(kind === 'measurement-started-v3' ? 'measurement-started.json' : 'measurement-drained.json', value, { kind, nonce });
              if (kind === 'measurement-started-v3') startUploaded = true; else drainUploaded = true;
            } catch { controller.abort(); }
          }
        }
        syncChannelCounters();
        await new Promise(resolve_ => setTimeout(resolve_, MEASUREMENT_LIMITS.pollMs));
      }
      measurementChannel.close(); syncChannelCounters();
    })();
    receipt.measurementReaderReady = true;
    receipt.phase = 'waiting-for-start'; await sync();
    if (uploadFailure) throw new Error('Remote evidence sink is unavailable');
    interval = setInterval(() => void sync(), 30_000);
    const code = await execute(childEnv, config.profile.primaryDevices, false, controller.signal);
    clearInterval(interval); controlStopped = true; await controlLoop;
    while (syncing) await new Promise(resolve_ => setTimeout(resolve_, 25));
    if (code === 0) validateSuccessfulFleetSummary(JSON.parse(readFileSync(childEnv.LOAD_EXTERNAL_SUMMARY_PATH, 'utf8')), config);
    receipt.phase = code === 0 ? 'completed' : 'failed'; receipt.exitCode = code; receipt.endedAt = new Date().toISOString();
    await sync(); finished = true;
    if (uploadFailure || !existsSync(childEnv.LOAD_EXTERNAL_SUMMARY_PATH)) throw new Error('Final aggregate evidence was not durably uploaded');
    return code;
  } finally {
    controlStopped = true; if (controlLoop) await controlLoop;
    ownedMeasurementChannel?.close();
    clearInterval(interval);
    if (!finished) { receipt.phase = 'failed'; receipt.endedAt = new Date().toISOString(); await sync(); }
    rmSync(directory, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.length === 3 && process.argv[2] === '--help') console.log('Remote isolated staging reliability generator. Task-role S3 inputs/results only. Requires CLP_GENERATOR_ACCOUNT_ID, BUCKET, CAMPAIGN, RUN_ID, DEVICES, ORIGIN, INPUT_SHA256, SCRIPT_SHA256, IMAGE_DIGEST, CANDIDATE_IMAGE and START_AT; AWS_REGION=us-east-1. START_AT is canonical UTC within five minutes and must match the input manifest. --preflight-metadata validates image/task/resource identity without S3 or application traffic. No fixture credentials in image, arguments or logs.');
  else if (process.argv.length === 3 && process.argv[2] === '--preflight-metadata') preflightGeneratorMetadata().then(value => console.log(JSON.stringify(value)), () => { console.error('[remote-generator] Metadata preflight refused'); process.exitCode = 1; });
  else if (process.argv.length === 3 && process.argv[2] === '--preflight-measurement-channel') runMeasurementChannelPreflight().catch(error => { console.error(JSON.stringify(measurementFailureDiagnostic(error))); process.exitCode = 1; });
  else if (process.argv.length !== 2) { console.error('[remote-generator] Unexpected arguments'); process.exitCode = 1; }
  else runRemoteGenerator().then(code => { process.exitCode = code; }, error => { console.error(JSON.stringify(measurementFailureDiagnostic(error))); process.exitCode = 1; });
}
