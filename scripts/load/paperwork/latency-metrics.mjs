export const CAPACITY_READ_PATHS = Object.freeze([
  '/api/mydesk/capabilities', '/api/classpilot/groups', '/api/classpilot/teacher/settings',
]);

export const CAPACITY_MEASUREMENT_PLAN = Object.freeze({
  warmupMinimumMs: 30000, warmupSamplesPerEndpoint: 10,
  baselineMinimumMs: 180000, baselineSamplesPerEndpoint: 100,
  loadedSamplesPerEndpoint: 100, sampleCadenceMs: 500,
  p95Multiplier: 1.2, stopWindowSamples: 20, stopConsecutiveWindows: 3, postWorkPadding: false,
});

export function samplingPhaseComplete(phase, elapsedMs, countsByEndpoint) {
  const minimumMs = phase === 'warmup' ? CAPACITY_MEASUREMENT_PLAN.warmupMinimumMs
    : phase === 'baseline' ? CAPACITY_MEASUREMENT_PLAN.baselineMinimumMs : 0;
  const minimumCount = phase === 'warmup' ? CAPACITY_MEASUREMENT_PLAN.warmupSamplesPerEndpoint
    : phase === 'baseline' ? CAPACITY_MEASUREMENT_PLAN.baselineSamplesPerEndpoint
      : CAPACITY_MEASUREMENT_PLAN.loadedSamplesPerEndpoint;
  return ['warmup', 'baseline', 'loaded'].includes(phase) && Number.isFinite(elapsedMs) && elapsedMs >= minimumMs &&
    CAPACITY_READ_PATHS.every(path => Number.isSafeInteger(countsByEndpoint[path]) && countsByEndpoint[path] >= minimumCount);
}

export function loadedProbesWithinWork(samples, startedAtMs, completedAtMs) {
  return Number.isFinite(startedAtMs) && Number.isFinite(completedAtMs) && completedAtMs >= startedAtMs &&
    samples.filter(sample => sample.phase !== 'warmup' && sample.phase !== 'baseline')
      .every(sample => sample.startedAtMs >= startedAtMs && sample.startedAtMs <= completedAtMs);
}

export function nearestRankPercentile(values, quantile) {
  if (!Number.isFinite(quantile) || quantile <= 0 || quantile > 1 ||
      values.some(value => !Number.isFinite(value) || value < 0)) throw new Error('INVALID_LATENCY_SAMPLE');
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.ceil(quantile * sorted.length) - 1];
}

export function createReadProbeEvidence() {
  return { version: 1, measurement: 'full_request_including_body_parse', percentileMethod: 'nearest_rank',
    maxSamples: 4096, samples: [] };
}

export function recordReadProbe(evidence, sample) {
  if (evidence.samples.length >= evidence.maxSamples) throw new Error('LATENCY_SAMPLE_LIMIT');
  if (!CAPACITY_READ_PATHS.includes(sample.path) ||
      !['warmup', 'baseline', 'uploading', 'preparing', 'continuations', 'cleanup'].includes(sample.phase) ||
      !Number.isFinite(sample.startedAtMs) || sample.startedAtMs < 0 ||
      !Number.isFinite(sample.durationMs) || sample.durationMs < 0 ||
      (sample.status !== null && (!Number.isInteger(sample.status) || sample.status < 100 || sample.status > 599))) {
    throw new Error('INVALID_LATENCY_SAMPLE');
  }
  // Only fixed paths and measurement metadata enter the evidence, never request/response content.
  evidence.samples.push({ path: sample.path, phase: sample.phase, startedAtMs: sample.startedAtMs,
    durationMs: sample.durationMs, status: sample.status });
}

export async function measureReadProbe(evidence, { path, phase }, operation,
  { now = () => performance.now(), originMs = 0 } = {}) {
  const started = now();
  let status = null, durationMs;
  try {
    // The operation resolves only after the response body has been read and parsed.
    const response = await operation();
    status = response.status;
    durationMs = now() - started;
    return { response, durationMs };
  } finally {
    recordReadProbe(evidence, { path, phase, startedAtMs: started - originMs,
      durationMs: durationMs ?? now() - started, status });
  }
}
