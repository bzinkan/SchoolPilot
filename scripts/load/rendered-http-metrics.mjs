import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { FINE_LATENCY_ENDPOINTS, FineEndpointLatencies, fineLatencyEndpoint } from './fine-endpoint-latency.mjs';

export const RENDERED_HTTP_DEADLINE_MS = 8000;
const MAX_TRACKED = 2048;
const ROLLING_BUCKETS = 301;
export const RENDERED_SIZE_DIAGNOSTIC_DEADLINE_MS = 1000;
const MAX_SIZE_DIAGNOSTICS = 64;
const classifiedEndpoints = new Set(FINE_LATENCY_ENDPOINTS);
const sizeTicket = Symbol('rendered-size-ticket');
const encodingCategories = ['none', 'gzip', 'br', 'deflate', 'other', 'unavailable'];
const byteBounds = [0, 512, 1024, 4096, 16384, 65536, 262144, 1048576, 2097152, 4194304, 8388608, 16777216, 67108864, 268435456];

function emptyEncodings() { return Object.fromEntries(encodingCategories.map(category => [category, 0])); }
function encodingCategory(value, available) {
  if (!available) return 'unavailable';
  if (value === undefined || value === '') return 'none';
  if (typeof value !== 'string') return 'other';
  const normalized = value.trim().toLowerCase();
  return ['gzip', 'br', 'deflate'].includes(normalized) ? normalized : normalized === '' ? 'none' : 'other';
}

class EncodedBodyBytes {
  constructor() { this.count = 0; this.total = 0; this.maximum = 0; this.counts = new Float64Array(byteBounds.length); }
  observe(bytes) {
    if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > byteBounds.at(-1)
      || !Number.isSafeInteger(this.total + bytes)) return false;
    this.count += 1; this.total += bytes; this.maximum = Math.max(this.maximum, bytes);
    this.counts[byteBounds.findIndex(bound => bytes <= bound)] += 1;
    return true;
  }
  summary() { return { count: this.count, totalBytes: this.total, maxBytes: this.maximum,
    bucketUpperBoundsBytes: [...byteBounds], counts: Array.from(this.counts) }; }
}

/** Passive census: never retries, aborts or changes an application's request. */
export class RenderedHttpMetrics {
  constructor({ origin, now = () => performance.now(), setTimer = setTimeout, clearTimer = clearTimeout,
    maxTracked = MAX_TRACKED } = {}) {
    this.origin = new URL(origin).origin;
    assert.ok(Number.isSafeInteger(maxTracked) && maxTracked > 0 && maxTracked <= MAX_TRACKED);
    this.now = now; this.setTimer = setTimer; this.clearTimer = clearTimer; this.maxTracked = maxTracked;
    this.start = null; this.end = null; this.records = new Map(); this.untracked = new WeakSet(); this.untrackedInFlight = 0;
    this.latencies = new FineEndpointLatencies(); this.actorCounts = new Map();
    this.headerLatencies = new FineEndpointLatencies();
    this.networkResponseStarts = new FineEndpointLatencies(); this.networkResponseEnds = new FineEndpointLatencies();
    this.networkRequestToHeaders = new FineEndpointLatencies(); this.networkBodyTransfers = new FineEndpointLatencies();
    this.observerMinusNetworkMagnitude = new FineEndpointLatencies();
    this.endpointDiagnostics = new Map(); this.encodedBodyBytes = new EncodedBodyBytes();
    this.encodings = emptyEncodings(); this.sizeDiagnostics = new Set();
    this.diagnosticCounters = { headerSamples: 0, networkTimingSamples: 0, networkTimingUnavailable: 0,
      networkTimingInvalid: 0, observerFullBodyShorterThanNetwork: 0, observerFullBodyAtLeastNetwork: 0,
      bodySizeAttempted: 0, bodySizeCaptured: 0, bodySizeInvalid: 0, bodySizeFailed: 0,
      bodySizeTimedOut: 0, bodySizeLateSettlements: 0, bodySizeSkippedCapacity: 0, maxSizeDiagnosticsInFlight: 0 };
    this.rollingEpochs = new Float64Array(ROLLING_BUCKETS).fill(-Infinity);
    this.rollingCounts = new Float64Array(ROLLING_BUCKETS); this.rollingTotal = 0; this.rollingPeak = 0;
    this.counters = { requestsStarted: 0, measurementsSettled: 0, failedMeasurements: 0, bodiesCompleted: 0, http403: 0, http429: 0,
      http5xx: 0, otherHttpErrors: 0, networkFailures: 0, deadlines: 0, lateSettlementsAfterDeadline: 0,
      unclassifiedRequests: 0, trackingOverflows: 0, maxInFlight: 0 };
    this.inFlightAtWindowEnd = null;
    this.closed = false;
  }

  startWindow(start, durationMs) {
    assert.equal(this.start, null);
    assert.ok(Number.isFinite(start) && Number.isFinite(durationMs) && durationMs > 0);
    this.start = start; this.end = start + durationMs;
  }

  begin(request, actorIndex = 0) {
    const now = this.now();
    if (this.closed || this.start === null || now < this.start || now >= this.end) return;
    const url = new URL(request.url());
    if (url.origin !== this.origin || !(url.pathname === '/api' || url.pathname.startsWith('/api/'))) return;
    assert.ok(Number.isSafeInteger(actorIndex) && actorIndex >= 0 && actorIndex < 20);
    this.counters.requestsStarted += 1;
    const second = Math.floor((now - this.start) / 1000);
    // Retain the complete intersecting oldest second: the peak can overcount
    // by less than one second, and never understates a five-minute window.
    for (let index = 0; index < ROLLING_BUCKETS; index += 1) {
      if (this.rollingEpochs[index] < second - 300) {
        this.rollingTotal -= this.rollingCounts[index]; this.rollingCounts[index] = 0;
      }
    }
    const slot = second % ROLLING_BUCKETS;
    if (this.rollingEpochs[slot] !== second) {
      this.rollingTotal -= this.rollingCounts[slot]; this.rollingCounts[slot] = 0; this.rollingEpochs[slot] = second;
    }
    this.rollingCounts[slot] += 1; this.rollingTotal += 1; this.rollingPeak = Math.max(this.rollingPeak, this.rollingTotal);
    const endpoint = fineLatencyEndpoint(request.method(), url.pathname);
    if (endpoint) {
      let counts = this.actorCounts.get(endpoint);
      if (!counts) { counts = new Float64Array(20); this.actorCounts.set(endpoint, counts); }
      counts[actorIndex] += 1;
    } else this.counters.unclassifiedRequests += 1;
    if (this.records.size >= this.maxTracked) {
      this.counters.trackingOverflows += 1; this.untracked.add(request); this.untrackedInFlight += 1;
      this.counters.maxInFlight = Math.max(this.counters.maxInFlight, this.records.size + this.untrackedInFlight);
      return;
    }
    const record = { startedAt: now, endpoint, status: null, measured: false, timedOut: false, timer: null };
    this.records.set(request, record);
    record.timer = this.setTimer(() => this.expire(record), RENDERED_HTTP_DEADLINE_MS);
    record.timer?.unref?.();
    this.counters.maxInFlight = Math.max(this.counters.maxInFlight, this.records.size + this.untrackedInFlight);
  }

  endpointDiagnostic(endpoint) {
    if (!classifiedEndpoints.has(endpoint)) return null;
    let current = this.endpointDiagnostics.get(endpoint);
    if (!current) {
      current = { encodings: emptyEncodings(), statusCounts: new Float64Array(500), encodedBodyBytes: new EncodedBodyBytes() };
      this.endpointDiagnostics.set(endpoint, current);
    }
    return current;
  }

  response(request, status, { contentEncoding, headersAvailable = false } = {}) {
    const record = this.records.get(request);
    if (!record && !this.untracked.has(request)) return;
    if (record?.status !== undefined && record.status !== null) return;
    if (record) {
      record.status = status;
      this.diagnosticCounters.headerSamples += 1;
      this.headerLatencies.observe(record.endpoint, this.now() - record.startedAt, status >= 400);
      const category = encodingCategory(contentEncoding, headersAvailable);
      this.encodings[category] += 1;
      const diagnostic = this.endpointDiagnostic(record.endpoint);
      if (diagnostic) {
        diagnostic.encodings[category] += 1;
        if (Number.isInteger(status) && status >= 100 && status <= 599) diagnostic.statusCounts[status - 100] += 1;
      }
    }
    if (status === 403) this.counters.http403 += 1;
    else if (status === 429) this.counters.http429 += 1;
    else if (status >= 500) this.counters.http5xx += 1;
    else if (status >= 400) this.counters.otherHttpErrors += 1;
  }

  settle(record, milliseconds, failed) {
    if (record.measured) return;
    record.measured = true; this.counters.measurementsSettled += 1;
    if (failed) this.counters.failedMeasurements += 1;
    this.latencies.observe(record.endpoint, milliseconds, failed);
  }

  expire(record) {
    if (record.measured) return;
    record.timedOut = true; this.counters.deadlines += 1;
    // A body not complete by the deadline has no known finite latency. Keep
    // it in the histogram's overflow bucket instead of claiming an8s finish.
    this.settle(record, Math.max(RENDERED_HTTP_DEADLINE_MS + 0.001, this.now() - record.startedAt), true);
  }

  recordNetworkTiming(record, timing, elapsed, failed) {
    if (!timing) { this.diagnosticCounters.networkTimingUnavailable += 1; return; }
    // These are Chromium's relative offsets, not wall timestamps. Negative
    // unavailable/reused-connection phase fields are never treated as zero.
    const { requestStart, responseStart, responseEnd } = timing;
    if (![requestStart, responseStart, responseEnd].every(value => Number.isFinite(value) && value >= 0)
      || requestStart > responseStart || responseStart > responseEnd) {
      this.diagnosticCounters.networkTimingInvalid += 1; return;
    }
    this.diagnosticCounters.networkTimingSamples += 1;
    const error = failed || record.status === null || record.status >= 400;
    this.networkResponseStarts.observe(record.endpoint, responseStart, error);
    this.networkResponseEnds.observe(record.endpoint, responseEnd, error);
    this.networkRequestToHeaders.observe(record.endpoint, responseStart - requestStart, error);
    this.networkBodyTransfers.observe(record.endpoint, responseEnd - responseStart, error);
    if (elapsed < responseEnd) this.diagnosticCounters.observerFullBodyShorterThanNetwork += 1;
    else this.diagnosticCounters.observerFullBodyAtLeastNetwork += 1;
    // Different event-start definitions can produce either sign. The signed
    // counts and magnitude diagnose this; they do not correct the full-body gate.
    this.observerMinusNetworkMagnitude.observe(record.endpoint, Math.abs(elapsed - responseEnd), error);
  }

  finish(request, failed = false, timing = null) {
    if (this.untracked.has(request)) {
      this.untracked.delete(request); this.untrackedInFlight -= 1;
      if (failed) this.counters.networkFailures += 1;
      else this.counters.bodiesCompleted += 1;
      return;
    }
    const record = this.records.get(request);
    if (!record) return;
    this.records.delete(request); this.clearTimer(record.timer);
    if (failed) this.counters.networkFailures += 1;
    else this.counters.bodiesCompleted += 1;
    const elapsed = this.now() - record.startedAt;
    if (!record.measured && elapsed >= RENDERED_HTTP_DEADLINE_MS) this.expire(record);
    if (record.timedOut) this.counters.lateSettlementsAfterDeadline += 1;
    else this.settle(record, elapsed, failed || record.status === null || record.status >= 400);
    this.recordNetworkTiming(record, timing, elapsed, failed);
    return failed ? null : { [sizeTicket]: true, endpoint: record.endpoint };
  }

  expireSizeDiagnostic(operation) {
    if (operation.timedOut) return;
    operation.timedOut = true;
    this.diagnosticCounters.bodySizeTimedOut += 1;
    this.clearTimer(operation.timer);
    // Keep the underlying RPC admitted until it settles. A wedged browser
    // cannot create an unbounded series of abandoned metadata operations.
  }

  collectBodySize(ticket, loadSizes) {
    if (!ticket?.[sizeTicket]) return;
    if (this.sizeDiagnostics.size >= MAX_SIZE_DIAGNOSTICS) {
      this.diagnosticCounters.bodySizeSkippedCapacity += 1; return;
    }
    this.diagnosticCounters.bodySizeAttempted += 1;
    const operation = { endpoint: ticket.endpoint, timer: null, timedOut: false };
    this.sizeDiagnostics.add(operation);
    this.diagnosticCounters.maxSizeDiagnosticsInFlight = Math.max(this.diagnosticCounters.maxSizeDiagnosticsInFlight, this.sizeDiagnostics.size);
    operation.timer = this.setTimer(() => this.expireSizeDiagnostic(operation), RENDERED_SIZE_DIAGNOSTIC_DEADLINE_MS);
    operation.timer?.unref?.();
    void Promise.resolve().then(loadSizes).then(sizes => {
      if (operation.timedOut) { this.diagnosticCounters.bodySizeLateSettlements += 1; return; }
      const bytes = sizes?.responseBodySize;
      if (!this.encodedBodyBytes.observe(bytes)) { this.diagnosticCounters.bodySizeInvalid += 1; return; }
      this.endpointDiagnostic(operation.endpoint)?.encodedBodyBytes.observe(bytes);
      this.diagnosticCounters.bodySizeCaptured += 1;
    }, () => {
      if (operation.timedOut) this.diagnosticCounters.bodySizeLateSettlements += 1;
      else this.diagnosticCounters.bodySizeFailed += 1;
    }).finally(() => { this.clearTimer(operation.timer); this.sizeDiagnostics.delete(operation); })
      .catch(() => { this.diagnosticCounters.bodySizeFailed += 1; });
  }

  closeWindow() {
    this.inFlightAtWindowEnd ??= this.records.size + this.untrackedInFlight;
    this.closed = true;
  }

  async drain(sleep = delay) {
    this.closeWindow();
    const until = Math.min(this.end + RENDERED_HTTP_DEADLINE_MS, this.now() + RENDERED_HTTP_DEADLINE_MS);
    const pending = () => this.records.size + this.untrackedInFlight > 0 || [...this.sizeDiagnostics].some(operation => !operation.timedOut);
    while (pending() && this.now() < until) await sleep(Math.min(100, until - this.now()));
    for (const record of this.records.values()) {
      this.clearTimer(record.timer);
      if (!record.measured) this.expire(record);
    }
    for (const operation of this.sizeDiagnostics) this.expireSizeDiagnostic(operation);
  }

  summary() {
    return { schemaVersion: 1, accounting: 'All same-origin API requests started in the timed window, including retries and controls; full body settlement or deadline.',
      measurementDeadlineMs: RENDERED_HTTP_DEADLINE_MS, trackedRequestLimit: MAX_TRACKED,
      counters: { ...this.counters }, inFlightAtWindowEnd: this.inFlightAtWindowEnd,
      rawInFlightAfterDrain: this.records.size + this.untrackedInFlight,
      timedOutRawInFlightAfterDrain: [...this.records.values()].filter(record => record.timedOut).length,
      allStartedRequestsMeasured: this.counters.measurementsSettled === this.counters.requestsStarted && this.counters.trackingOverflows === 0,
      rollingFiveMinute: { upperBoundPeakRequests: this.rollingPeak, windowSeconds: 300, bucketSeconds: 1, maximumOvercountSeconds: 1 },
      endpointRequestsPerActor: Object.fromEntries([...this.actorCounts].map(([endpoint, counts]) => [endpoint, Array.from(counts)])),
      fineEndpointLatency: this.latencies.summary(),
      diagnostics: { schemaVersion: 1,
        interpretation: 'Full-body gate is unchanged. Observer response-header/full-body times include event delivery. Chromium relative offsets exclude observer event delivery; neither is server route time. Encoded bytes come from Chromium request.sizes(). No content or wall timestamps are retained.',
        counters: { ...this.diagnosticCounters }, bodySizeDeadlineMs: RENDERED_SIZE_DIAGNOSTIC_DEADLINE_MS,
        bodySizeTrackingLimit: MAX_SIZE_DIAGNOSTICS, bodySizeRawInFlightAfterDrain: this.sizeDiagnostics.size,
        contentEncoding: { ...this.encodings }, encodedBodyBytes: this.encodedBodyBytes.summary(),
        responseHeaderLatency: this.headerLatencies.summary(),
        browserNetworkTiming: { responseStartOffset: this.networkResponseStarts.summary(), responseEndOffset: this.networkResponseEnds.summary(),
          requestToResponseHeaders: this.networkRequestToHeaders.summary(), responseHeadersToBodyEnd: this.networkBodyTransfers.summary(),
          observerFullBodyMinusNetworkEndMagnitude: this.observerMinusNetworkMagnitude.summary() },
        endpoints: Object.fromEntries([...this.endpointDiagnostics].sort(([left], [right]) => left.localeCompare(right)).map(([endpoint, value]) => [endpoint,
          { contentEncoding: { ...value.encodings }, statusCounts: Object.fromEntries(Array.from(value.statusCounts, (count, index) => [String(index + 100), count]).filter(([, count]) => count > 0)),
            encodedBodyBytes: value.encodedBodyBytes.summary() }])) },
      wafAttributionEstablished: false };
  }

  progress() {
    return { counters: { ...this.counters }, rawInFlight: this.records.size + this.untrackedInFlight,
      rollingFiveMinuteUpperBoundPeakRequests: this.rollingPeak };
  }
}

export function attachRenderedHttpMetrics(page, metrics, actorIndex = 0) {
  page.on('request', request => metrics.begin(request, actorIndex));
  page.on('response', response => {
    let contentEncoding, headersAvailable = false;
    try { contentEncoding = response.headers()['content-encoding']; headersAvailable = true; } catch { /* Fixed unavailable category. */ }
    metrics.response(response.request(), response.status(), { contentEncoding, headersAvailable });
  });
  const finished = (request, failed) => {
    let timing = null;
    try { timing = request.timing(); } catch { /* Count unavailable browser metadata. */ }
    const ticket = metrics.finish(request, failed, timing);
    if (ticket) metrics.collectBodySize(ticket, () => request.sizes());
  };
  page.on('requestfinished', request => finished(request, false));
  page.on('requestfailed', request => finished(request, true));
}
