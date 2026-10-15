export const FINE_LATENCY_VERSION = 'classpilot-endpoint-latency-1ms-v1';
export const FINE_LATENCY_MAX_MS = 8_000;
export const FINE_LATENCY_OVERFLOW_INDEX = FINE_LATENCY_MAX_MS + 1;
export const FINE_LATENCY_ENDPOINTS = Object.freeze([
  'POST /api/classpilot/device/heartbeat', 'POST /api/classpilot/device/screenshot',
  'GET /api/students-aggregated', 'POST /api/classpilot/tiles/history',
  'POST /api/classpilot/tiles/screenshots', 'POST /api/classpilot/commands',
  'GET /api/classpilot/commands/active-state', 'GET /api/classpilot/teacher/raised-hands',
  'PUT /api/classpilot/teaching-sessions/{teachingSessionId}/observation-lease',
  'DELETE /api/classpilot/teaching-sessions/{teachingSessionId}/observation-lease',
  'GET /api/classpilot/heartbeats/{deviceId}', 'GET /api/classpilot/device/screenshot/{deviceId}',
  'GET /api/sessions/active', 'GET /api/classpilot/dashboard-activity',
  'GET /api/coverage/summary', 'GET /api/teacher/messages',
  'GET /api/classpilot/schedule-changes/today', 'POST /api/classpilot/monitoring/client-health',
  'GET /api/classpilot/commands/{commandId}/status',
  'GET /api/settings', 'GET /api/flight-paths', 'GET /api/block-lists',
  'GET /api/teacher/groups', 'GET /api/coverage/capabilities',
  'GET /api/groups/{groupId}/subgroups', 'GET /api/classpilot/teacher/preferences',
  'GET /api/admin/attendance',
]);
const allowed = new Set(FINE_LATENCY_ENDPOINTS);
const aliases = Object.freeze({
  'POST /api/commands': 'POST /api/classpilot/commands',
  'GET /api/commands/active-state': 'GET /api/classpilot/commands/active-state',
  'GET /api/teacher/raised-hands': 'GET /api/classpilot/teacher/raised-hands',
});

/** Fixed labels only; neither URL queries nor target identifiers enter evidence. */
export function fineLatencyEndpoint(method, path) {
  if (typeof method !== 'string' || typeof path !== 'string') return null;
  const pathname = path.split('?', 1)[0];
  const alias = aliases[`${method} ${pathname}`];
  if (alias) return alias;
  const exact = `${method} ${pathname}`;
  if (allowed.has(exact) && !pathname.includes('{')) return exact;
  if (method === 'GET' && /^\/api\/classpilot\/heartbeats\/[^/]+$/.test(pathname)) return 'GET /api/classpilot/heartbeats/{deviceId}';
  if (method === 'GET' && /^\/api\/classpilot\/device\/screenshot\/[^/]+$/.test(pathname)) return 'GET /api/classpilot/device/screenshot/{deviceId}';
  if (['PUT', 'DELETE'].includes(method) && /^\/api\/classpilot\/teaching-sessions\/[^/]+\/observation-lease$/.test(pathname)) {
    return `${method} /api/classpilot/teaching-sessions/{teachingSessionId}/observation-lease`;
  }
  if (method === 'GET') {
    const command = /^\/api\/classpilot\/commands\/[A-Za-z0-9_-]{1,256}\/status$/.exec(pathname);
    if (command?.[0] === pathname) return 'GET /api/classpilot/commands/{commandId}/status';
    const group = /^\/api\/groups\/[A-Za-z0-9_-]{1,256}\/subgroups$/.exec(pathname);
    if (group?.[0] === pathname) return 'GET /api/groups/{groupId}/subgroups';
  }
  return null;
}

export class FineEndpointLatencyHistogram {
  constructor() {
    // Float64 counts avoid Uint32 wrapping during aggregation. Memory remains fixed.
    this.counts = new Float64Array(FINE_LATENCY_OVERFLOW_INDEX + 1);
    this.count = 0;
    this.failedCount = 0;
    this.invalidCount = 0;
  }

  observe(milliseconds, failed = false) {
    if (!Number.isFinite(milliseconds) || milliseconds < 0 || this.count >= Number.MAX_SAFE_INTEGER) {
      this.invalidCount += 1;
      return;
    }
    const index = milliseconds > FINE_LATENCY_MAX_MS ? FINE_LATENCY_OVERFLOW_INDEX : Math.ceil(milliseconds);
    this.counts[index] += 1;
    this.count += 1;
    if (failed) this.failedCount += 1;
  }

  merge(other) {
    if (!(other instanceof FineEndpointLatencyHistogram) || this.count + other.count > Number.MAX_SAFE_INTEGER
        || this.invalidCount + other.invalidCount > Number.MAX_SAFE_INTEGER) throw new Error('Compatible bounded latency histograms required');
    for (let index = 0; index < this.counts.length; index += 1) this.counts[index] += other.counts[index];
    this.count += other.count;
    this.failedCount += other.failedCount;
    this.invalidCount += other.invalidCount;
    return this;
  }

  summary() {
    const rank = Math.floor(this.count / 100) * 95 + Math.ceil((this.count % 100) * 95 / 100);
    let cumulative = 0, index = 0;
    for (; index < this.counts.length; index += 1) {
      cumulative += this.counts[index];
      if (rank > 0 && cumulative >= rank) break;
    }
    const finite = this.count > 0 && index <= FINE_LATENCY_MAX_MS;
    return { count: this.count, failedCount: this.failedCount, invalidCount: this.invalidCount,
      overflowCount: this.counts[FINE_LATENCY_OVERFLOW_INDEX], counts: Array.from(this.counts),
      p95Bounds: { method: 'pooled-nearest-rank', rank, finite,
        complete: this.invalidCount === 0 && this.count > 0,
        lowerMs: finite ? Math.max(0, index - 1) : null,
        upperMs: finite ? index : null, quantizationBoundMs: 1 } };
  }
}

export class FineEndpointLatencies {
  constructor() { this.endpoints = new Map(); this.unclassifiedCount = 0; }
  observe(endpoint, milliseconds, failed = false) {
    if (!allowed.has(endpoint)) { this.unclassifiedCount += 1; return; }
    let histogram = this.endpoints.get(endpoint);
    if (!histogram) { histogram = new FineEndpointLatencyHistogram(); this.endpoints.set(endpoint, histogram); }
    histogram.observe(milliseconds, failed);
  }
  summary() {
    return { version: FINE_LATENCY_VERSION, unit: 'milliseconds', resolutionMs: 1,
      maxFiniteUpperBoundMs: FINE_LATENCY_MAX_MS, overflowBucketIndex: FINE_LATENCY_OVERFLOW_INDEX,
      bucketUpperBoundsMs: [...Array.from({ length: FINE_LATENCY_MAX_MS + 1 }, (_, index) => index), null],
      quantization: 'For a finite p95, true p95 is in [max(0, upperMs - 1), upperMs]. Overflow has no finite upper bound.',
      unclassifiedCount: this.unclassifiedCount,
      endpoints: Object.fromEntries([...this.endpoints].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([endpoint, histogram]) => [endpoint, histogram.summary()])) };
  }
}

/** This mathematical comparison does not establish workload or release validity. */
export function conservativeP95Comparison(candidate, reference) {
  const valid = value => value?.count > 0 && value.p95Bounds?.complete === true && value.p95Bounds.finite === true
    && value.p95Bounds.quantizationBoundMs === 1 && Number.isFinite(value.p95Bounds.lowerMs)
    && Number.isFinite(value.p95Bounds.upperMs) && value.p95Bounds.lowerMs >= 0
    && value.p95Bounds.upperMs >= value.p95Bounds.lowerMs && value.p95Bounds.upperMs - value.p95Bounds.lowerMs <= 1;
  if (!valid(candidate) || !valid(reference)) return { status: 'inconclusive', reason: 'Missing, invalid or unbounded p95 evidence' };
  return { status: candidate.p95Bounds.upperMs <= 1.20 * reference.p95Bounds.lowerMs ? 'pass' : 'inconclusive',
    candidateUpperMs: candidate.p95Bounds.upperMs, referenceLowerMs: reference.p95Bounds.lowerMs,
    maximumRelativeIncrease: 0.20 };
}
