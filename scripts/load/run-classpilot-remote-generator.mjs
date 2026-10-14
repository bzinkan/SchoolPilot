import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, cpus, totalmem } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { REMOTE_GENERATOR_SCRIPTS, scriptManifest } from './remote-generator-manifest.mjs';
import { reliabilityProfile } from './classpilot-reliability-profile.mjs';
import { validateStagingStartAt, validateStagingRunManifest } from './staging-start-barrier.mjs';

const ORIGIN = 'https://staging.school-pilot.net';
const INPUTS = Object.freeze({ devices: 'devices.json', auth: 'auth.json', commands: 'commands.json' });
const MAX_INPUT_BYTES = 32 * 1024 * 1024;
const MAX_RESULT_BYTES = 16 * 1024 * 1024;
const sha256 = value => createHash('sha256').update(value).digest('hex');
const isSha = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

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
  if (value.version !== 1 || value.campaign !== config.campaign || value.runId !== config.runId
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

export async function runRemoteGenerator({ env = process.env, manifestPath = '/app/load-generator-manifest.json',
  s3 = new S3Client({ region: 'us-east-1', maxAttempts: 2 }), execute = executeHarness, metadata = readTaskMetadata } = {}) {
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
    for (const [key, name] of Object.entries(INPUTS)) {
      const bytes = await get(name);
      if (bytes.length !== inputManifest.files[key].bytes || sha256(bytes) !== inputManifest.files[key].sha256) throw new Error('Private input checksum does not match');
      privateValues(JSON.parse(bytes), secrets);
      writeFileSync(join(artifactRoot, name), bytes, { flag: 'wx', mode: 0o600 });
    }
    receipt.phase = 'preflight'; await sync();
    if (uploadFailure || await execute(childEnv, config.profile.primaryDevices, true, controller.signal) !== 0) throw new Error('Remote harness preflight refused');
    receipt.phase = 'waiting-for-start'; await sync();
    if (uploadFailure) throw new Error('Remote evidence sink is unavailable');
    interval = setInterval(() => void sync(), 30_000);
    const code = await execute(childEnv, config.profile.primaryDevices, false, controller.signal);
    clearInterval(interval);
    while (syncing) await new Promise(resolve_ => setTimeout(resolve_, 25));
    if (code === 0) validateSuccessfulFleetSummary(JSON.parse(readFileSync(childEnv.LOAD_EXTERNAL_SUMMARY_PATH, 'utf8')), config);
    receipt.phase = code === 0 ? 'completed' : 'failed'; receipt.exitCode = code; receipt.endedAt = new Date().toISOString();
    await sync(); finished = true;
    if (uploadFailure || !existsSync(childEnv.LOAD_EXTERNAL_SUMMARY_PATH)) throw new Error('Final aggregate evidence was not durably uploaded');
    return code;
  } finally {
    clearInterval(interval);
    if (!finished) { receipt.phase = 'failed'; receipt.endedAt = new Date().toISOString(); await sync(); }
    rmSync(directory, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.length === 3 && process.argv[2] === '--help') console.log('Remote isolated staging reliability generator. Task-role S3 inputs/results only. Requires CLP_GENERATOR_ACCOUNT_ID, BUCKET, CAMPAIGN, RUN_ID, DEVICES, ORIGIN, INPUT_SHA256, SCRIPT_SHA256, IMAGE_DIGEST, CANDIDATE_IMAGE and START_AT; AWS_REGION=us-east-1. START_AT is canonical UTC within five minutes and must match the input manifest. --preflight-metadata validates image/task/resource identity without S3 or application traffic. No fixture credentials in image, arguments or logs.');
  else if (process.argv.length === 3 && process.argv[2] === '--preflight-metadata') preflightGeneratorMetadata().then(value => console.log(JSON.stringify(value)), () => { console.error('[remote-generator] Metadata preflight refused'); process.exitCode = 1; });
  else if (process.argv.length !== 2) { console.error('[remote-generator] Unexpected arguments'); process.exitCode = 1; }
  else runRemoteGenerator().then(code => { process.exitCode = code; }, () => { console.error('[remote-generator] Failed closed; inspect aggregate generator evidence'); process.exitCode = 1; });
}
