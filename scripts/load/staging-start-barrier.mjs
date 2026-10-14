import { setTimeout as delay } from 'node:timers/promises';

export const STAGING_START_MAX_FUTURE_MS = 300_000;
export const STAGING_START_MAX_SKEW_MS = 1_000;
const STAGING_ORIGIN = 'https://staging.school-pilot.net';
const canonicalUtc = value => typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value)
  && Number.isFinite(Date.parse(value)) && new Date(Date.parse(value)).toISOString() === value;

export function validateStagingInputFreshness(createdAt, now = Date.now()) {
  const created = Date.parse(createdAt);
  if (!canonicalUtc(createdAt) || !Number.isFinite(now) || now < created || now - created > 900_000) {
    throw new Error('Staging inputs must remain fresh within fifteen minutes at fetch and traffic start');
  }
  return created;
}

export function validateStagingStartAt(startAt, origin, now = Date.now()) {
  const url = new URL(origin);
  const loopback = ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(url.hostname);
  if (!startAt && loopback) return null;
  if (url.origin !== STAGING_ORIGIN || !canonicalUtc(startAt)) throw new Error('A canonical UTC start barrier is required for isolated staging');
  const start = Date.parse(startAt);
  if (!Number.isFinite(now) || start <= now || start - now > STAGING_START_MAX_FUTURE_MS) {
    throw new Error('Staging start must be in the future and within five minutes');
  }
  return start;
}

export function validateStagingRunManifest(value, { startAt, primaryDevices, authSha256 } = {}, now = Date.now()) {
  if (value?.version !== 1 || ![40, 500, 800].includes(value.primaryDevices)
      || Object.keys(value).sort().join(',') !== 'campaign,candidateApiImage,createdAt,files,primaryDevices,runId,scriptBundleSha256,startAt,version'
      || value.primaryDevices !== primaryDevices || (startAt !== undefined && value.startAt !== startAt)
      || !/^classpilot-staging-\d{8}-[a-f0-9]{12}$/.test(value.campaign || '')
      || !new RegExp(`^${primaryDevices}-[a-f0-9]{12,32}$`).test(value.runId || '')
      || !/^135775632425\.dkr\.ecr\.us-east-1\.amazonaws\.com\/schoolpilot-staging-api@sha256:[a-f0-9]{64}$/.test(value.candidateApiImage || '')
      || !/^[a-f0-9]{64}$/.test(value.scriptBundleSha256 || '')
      || !/^[a-f0-9]{64}$/.test(authSha256 || '') || value.files?.auth?.sha256 !== authSha256) {
    throw new Error('Rendered and fleet actors must bind the same exact staging run manifest');
  }
  if (Object.keys(value.files || {}).sort().join(',') !== 'auth,commands,devices'
      || Object.values(value.files).some(file => !/^[a-f0-9]{64}$/.test(file?.sha256 || '')
        || !Number.isSafeInteger(file.bytes) || file.bytes < 1 || file.bytes > 32 * 1024 * 1024)) throw new Error('Exact bounded staging input files required');
  validateStagingStartAt(value.startAt, STAGING_ORIGIN, now);
  validateStagingInputFreshness(value.createdAt, now);
  return value;
}

/** Wall UTC selects the shared instant; all waiting and execution use monotonic time. */
export async function waitForStagingStart({ startAt, origin, inputCreatedAt, onReady = () => {}, signal,
  wallNow = Date.now, monotonicNow = () => performance.now(),
  sleep = milliseconds => delay(milliseconds, undefined, { signal }) } = {}) {
  const readyWall = wallNow(), readyMono = monotonicNow();
  const start = validateStagingStartAt(startAt, origin, readyWall);
  if (start === null) return null;
  validateStagingInputFreshness(inputCreatedAt, readyWall);
  if (start - readyWall < 1_000) throw new Error('Staging preparation missed the required start readiness margin');
  const targetMono = readyMono + start - readyWall;
  const ready = { plannedStartAt: startAt, readyAt: new Date(readyWall).toISOString(), millisecondsUntilStart: start - readyWall };
  await onReady(ready);
  if (monotonicNow() >= targetMono) throw new Error('Staging readiness completed after its start deadline');
  while (true) {
    if (signal?.aborted) throw new Error('Staging start was cancelled');
    const mono = monotonicNow(), wall = wallNow();
    if (!Number.isFinite(mono) || !Number.isFinite(wall) || mono < readyMono || Math.abs(wall - (readyWall + mono - readyMono)) > STAGING_START_MAX_SKEW_MS) {
      throw new Error('Staging wall clock changed during the start barrier');
    }
    if (mono >= targetMono) {
      const skew = wall - start;
      if (Math.abs(skew) > STAGING_START_MAX_SKEW_MS || mono - targetMono > STAGING_START_MAX_SKEW_MS) {
        throw new Error('Staging start callback missed the bounded deadline');
      }
      validateStagingInputFreshness(inputCreatedAt, wall);
      return { ...ready, actualStartedAt: new Date(wall).toISOString(), startSkewMs: skew, monotonicStartedAt: mono };
    }
    await sleep(Math.min(250, targetMono - mono));
  }
}
