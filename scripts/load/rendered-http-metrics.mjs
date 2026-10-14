import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { FineEndpointLatencies, fineLatencyEndpoint } from './fine-endpoint-latency.mjs';

export const RENDERED_HTTP_DEADLINE_MS = 8000;
const MAX_TRACKED = 2048;
const ROLLING_BUCKETS = 301;

/** Passive census: never retries, aborts or changes an application's request. */
export class RenderedHttpMetrics {
  constructor({ origin, now = () => performance.now(), setTimer = setTimeout, clearTimer = clearTimeout,
    maxTracked = MAX_TRACKED } = {}) {
    this.origin = new URL(origin).origin;
    assert.ok(Number.isSafeInteger(maxTracked) && maxTracked > 0 && maxTracked <= MAX_TRACKED);
    this.now = now; this.setTimer = setTimer; this.clearTimer = clearTimer; this.maxTracked = maxTracked;
    this.start = null; this.end = null; this.records = new Map(); this.untracked = new WeakSet(); this.untrackedInFlight = 0;
    this.latencies = new FineEndpointLatencies(); this.actorCounts = new Map();
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

  response(request, status) {
    const record = this.records.get(request);
    if (!record && !this.untracked.has(request)) return;
    if (record?.status !== undefined && record.status !== null) return;
    if (record) record.status = status;
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

  finish(request, failed = false) {
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
  }

  closeWindow() {
    this.inFlightAtWindowEnd ??= this.records.size + this.untrackedInFlight;
    this.closed = true;
  }

  async drain(sleep = delay) {
    this.closeWindow();
    const until = Math.min(this.end + RENDERED_HTTP_DEADLINE_MS, this.now() + RENDERED_HTTP_DEADLINE_MS);
    while (this.records.size + this.untrackedInFlight > 0 && this.now() < until) await sleep(Math.min(100, until - this.now()));
    for (const record of this.records.values()) {
      this.clearTimer(record.timer);
      if (!record.measured) this.expire(record);
    }
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
      wafAttributionEstablished: false };
  }

  progress() {
    return { counters: { ...this.counters }, rawInFlight: this.records.size + this.untrackedInFlight,
      rollingFiveMinuteUpperBoundPeakRequests: this.rollingPeak };
  }
}

export function attachRenderedHttpMetrics(page, metrics, actorIndex = 0) {
  page.on('request', request => metrics.begin(request, actorIndex));
  page.on('response', response => metrics.response(response.request(), response.status()));
  page.on('requestfinished', request => metrics.finish(request));
  page.on('requestfailed', request => metrics.finish(request, true));
}
