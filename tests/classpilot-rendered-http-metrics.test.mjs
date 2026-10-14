import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RenderedHttpMetrics, RENDERED_HTTP_DEADLINE_MS, RENDERED_SIZE_DIAGNOSTIC_DEADLINE_MS } from '../scripts/load/rendered-http-metrics.mjs';

function fixture(maxTracked) {
  let now = 0;
  const timers = new Set();
  const metrics = new RenderedHttpMetrics({ origin: 'https://staging.school-pilot.net', now: () => now,
    setTimer: callback => { const timer = { callback }; timers.add(timer); return timer; },
    clearTimer: timer => timers.delete(timer), ...(maxTracked ? { maxTracked } : {}) });
  const request = (path, method = 'GET') => ({ url: () => 'https://staging.school-pilot.net' + path, method: () => method });
  return { metrics, request, timers, advance: value => { now = value; } };
}

test('browser census excludes setup/outside traffic and times the complete body rather than headers', () => {
  const { metrics, request, advance } = fixture();
  const state = request('/api/commands/active-state?teachingSessionId=private-identity');
  metrics.begin(state); assert.equal(metrics.summary().counters.requestsStarted, 0);
  metrics.startWindow(10, 600_000); advance(10); metrics.begin(state, 19); advance(20); metrics.response(state, 200);
  assert.equal(metrics.summary().fineEndpointLatency.endpoints['GET /api/classpilot/commands/active-state'], undefined);
  advance(130); metrics.finish(state);
  const summary = metrics.summary();
  assert.equal(summary.counters.requestsStarted, 1); assert.equal(summary.counters.measurementsSettled, 1);
  assert.equal(summary.fineEndpointLatency.endpoints['GET /api/classpilot/commands/active-state'].p95Bounds.upperMs, 120);
  assert.equal(summary.endpointRequestsPerActor['GET /api/classpilot/commands/active-state'][19], 1);
  assert.doesNotMatch(JSON.stringify(summary), /private-identity|teachingSessionId=/);
  metrics.begin(request('/assets/private.js')); metrics.begin({ url: () => 'https://school-pilot.net/api/auth/me', method: () => 'GET' });
  advance(600_010); metrics.begin(request('/api/teacher/raised-hands')); assert.equal(metrics.summary().counters.requestsStarted, 1);
});

test('header and body stalls hit the8s measurement deadline once while late raw transport remains tracked', () => {
  const { metrics, request, advance, timers } = fixture();
  assert.equal(RENDERED_HTTP_DEADLINE_MS, 8000);
  metrics.startWindow(0, 10_000);
  const headersStall = request('/api/teacher/raised-hands'), bodyStall = request('/api/classpilot/tiles/screenshots', 'POST');
  metrics.begin(headersStall); metrics.begin(bodyStall); metrics.response(bodyStall, 200);
  advance(8000); for (const timer of timers) timer.callback();
  let summary = metrics.summary();
  assert.equal(summary.counters.deadlines, 2); assert.equal(summary.counters.measurementsSettled, 2);
  assert.equal(summary.rawInFlightAfterDrain, 2);
  assert.equal(summary.fineEndpointLatency.endpoints['POST /api/classpilot/tiles/screenshots'].overflowCount, 1);
  advance(8500); metrics.response(headersStall, 503); metrics.finish(headersStall); metrics.finish(bodyStall, true);
  summary = metrics.summary();
  assert.equal(summary.counters.http5xx, 1); assert.equal(summary.counters.networkFailures, 1);
  assert.equal(summary.counters.lateSettlementsAfterDeadline, 2); assert.equal(summary.counters.measurementsSettled, 2);
  assert.equal(summary.rawInFlightAfterDrain, 0);
});

test('browser census keeps fixed status/error counters and accounts every retry/control without URL output', () => {
  const { metrics, request, advance } = fixture(); metrics.startWindow(0, 600_000);
  for (const [index, status] of [403, 429, 500, 404, 200].entries()) {
    const current = request('/api/private/' + index + '?secret=private', 'POST');
    metrics.begin(current); metrics.response(current, status); advance(index + 1); metrics.finish(current, index === 4);
  }
  const summary = metrics.summary();
  assert.equal(summary.counters.requestsStarted, 5); assert.equal(summary.counters.http403, 1); assert.equal(summary.counters.http429, 1);
  assert.equal(summary.counters.http5xx, 1); assert.equal(summary.counters.otherHttpErrors, 1); assert.equal(summary.counters.networkFailures, 1);
  assert.equal(summary.counters.unclassifiedRequests, 5); assert.equal(summary.allStartedRequestsMeasured, true);
  assert.equal(summary.wafAttributionEstablished, false);
  assert.doesNotMatch(JSON.stringify(summary), /secret=|\/api\/private/);
});

test('bounded five-minute rolling counts conservatively include the intersecting oldest second', () => {
  const { metrics, request, advance } = fixture(); metrics.startWindow(0, 600_000);
  const send = time => { advance(time); const current = request('/api/teacher/raised-hands'); metrics.begin(current); metrics.response(current, 200); metrics.finish(current); };
  send(0); send(299_999); send(300_999); send(301_000);
  const rolling = metrics.summary().rollingFiveMinute;
  assert.equal(rolling.upperBoundPeakRequests, 3); assert.equal(rolling.maximumOvercountSeconds, 1);
  assert.equal(metrics.rollingCounts.length, 301); assert.equal(metrics.rollingTotal, 3);
});

test('tracking overflow fails completeness and never silently drops raw in-flight accounting', async () => {
  const { metrics, request, advance } = fixture(1); metrics.startWindow(0, 10_000);
  const first = request('/api/teacher/raised-hands'), second = request('/api/commands/active-state');
  metrics.begin(first); metrics.begin(second); metrics.response(second, 429); metrics.finish(second, true);
  advance(10_000); metrics.closeWindow(); metrics.begin(request('/api/auth/me'));
  await metrics.drain(async milliseconds => { advance(18_000); });
  const summary = metrics.summary();
  assert.equal(summary.counters.trackingOverflows, 1); assert.equal(summary.allStartedRequestsMeasured, false);
  assert.equal(summary.counters.http429, 1); assert.equal(summary.counters.networkFailures, 1);
  assert.equal(summary.inFlightAtWindowEnd, 1); assert.equal(summary.timedOutRawInFlightAfterDrain, 1);
  assert.equal(summary.counters.requestsStarted, 2);
});

test('header, browser-network, encoded-byte and status diagnostics retain no content and do not correct the full-body gate', async () => {
  const { metrics, request, advance } = fixture(); metrics.startWindow(0, 600_000);
  const current = request('/api/commands?secret=private-identity', 'POST');
  metrics.begin(current); advance(50); metrics.response(current, 201, { contentEncoding: 'gzip', headersAvailable: true });
  advance(220);
  const ticket = metrics.finish(current, false, { requestStart: 10, responseStart: 45, responseEnd: 200,
    startTime: 1791940000000, url: 'https://private.invalid/private-identity' });
  metrics.collectBodySize(ticket, async () => ({ responseBodySize: 2_185_440, responseHeadersSize: 400,
    body: 'never-retain-private-content', url: 'https://private.invalid/private-identity' }));
  await new Promise(resolve => setImmediate(resolve));
  const summary = metrics.summary(), endpoint = 'POST /api/classpilot/commands', diagnostics = summary.diagnostics;
  assert.equal(summary.fineEndpointLatency.endpoints[endpoint].p95Bounds.upperMs, 220);
  assert.equal(diagnostics.responseHeaderLatency.endpoints[endpoint].p95Bounds.upperMs, 50);
  assert.equal(diagnostics.browserNetworkTiming.responseStartOffset.endpoints[endpoint].p95Bounds.upperMs, 45);
  assert.equal(diagnostics.browserNetworkTiming.responseEndOffset.endpoints[endpoint].p95Bounds.upperMs, 200);
  assert.equal(diagnostics.browserNetworkTiming.requestToResponseHeaders.endpoints[endpoint].p95Bounds.upperMs, 35);
  assert.equal(diagnostics.browserNetworkTiming.responseHeadersToBodyEnd.endpoints[endpoint].p95Bounds.upperMs, 155);
  assert.equal(diagnostics.browserNetworkTiming.observerFullBodyMinusNetworkEndMagnitude.endpoints[endpoint].p95Bounds.upperMs, 20);
  assert.equal(diagnostics.counters.observerFullBodyAtLeastNetwork, 1);
  assert.equal(diagnostics.endpoints[endpoint].statusCounts['201'], 1);
  assert.equal(diagnostics.endpoints[endpoint].contentEncoding.gzip, 1);
  assert.equal(diagnostics.endpoints[endpoint].encodedBodyBytes.totalBytes, 2_185_440);
  assert.equal(diagnostics.encodedBodyBytes.count, 1); assert.equal(diagnostics.counters.bodySizeCaptured, 1);
  assert.equal(diagnostics.bodySizeRawInFlightAfterDrain, 0);
  assert.doesNotMatch(JSON.stringify(summary), /private-identity|private-content|private\.invalid|1791940000000|secret=/);
});

test('missing or inconsistent browser timing, metadata failures and arbitrary encodings stay explicit and bounded', async () => {
  const { metrics, request, advance } = fixture(); metrics.startWindow(0, 600_000);
  const first = request('/api/teacher/raised-hands'); metrics.begin(first);
  metrics.response(first, 200, { contentEncoding: 'private-encoding-secret', headersAvailable: true }); advance(10);
  const ticket = metrics.finish(first, false, { requestStart: -1, responseStart: 8, responseEnd: 9 });
  metrics.collectBodySize(ticket, async () => { throw new Error('private metadata failure'); });
  const second = request('/api/commands/active-state'); metrics.begin(second); metrics.response(second, 503); advance(20);
  metrics.finish(second, true);
  const third = request('/api/classpilot/tiles/screenshots', 'POST'); metrics.begin(third); metrics.response(third, 200); advance(30);
  const invalid = metrics.finish(third, false, { requestStart: 2, responseStart: 8, responseEnd: 6 });
  metrics.collectBodySize(invalid, async () => ({ responseBodySize: -1 }));
  metrics.collectBodySize({ endpoint: '/api/private/identity' }, async () => ({ responseBodySize: 10 }));
  await new Promise(resolve => setImmediate(resolve));
  const summary = metrics.summary(), diagnostics = summary.diagnostics;
  assert.equal(diagnostics.counters.networkTimingInvalid, 2); assert.equal(diagnostics.counters.networkTimingUnavailable, 1);
  assert.equal(diagnostics.counters.bodySizeFailed, 1); assert.equal(diagnostics.counters.bodySizeInvalid, 1);
  assert.equal(diagnostics.counters.bodySizeAttempted, 2); assert.equal(diagnostics.contentEncoding.other, 1);
  assert.equal(diagnostics.contentEncoding.unavailable, 2);
  assert.equal(diagnostics.endpoints['GET /api/classpilot/commands/active-state'].statusCounts['503'], 1);
  assert.equal(summary.allStartedRequestsMeasured, true); assert.equal(summary.counters.failedMeasurements, 1);
  assert.doesNotMatch(JSON.stringify(summary), /private-encoding|private metadata|\/api\/private/);
});

test('wedged size RPCs retain bounded admission after their metadata deadline while HTTP accounting continues', async () => {
  const { metrics, request, advance, timers } = fixture(); metrics.startWindow(0, 600_000);
  assert.equal(RENDERED_SIZE_DIAGNOSTIC_DEADLINE_MS, 1000);
  let release;
  const stalled = new Promise(resolve => { release = resolve; });
  let started = 0;
  const send = () => { const current = request('/api/teacher/raised-hands'); metrics.begin(current); metrics.response(current, 200);
    const ticket = metrics.finish(current, false, { requestStart: 0, responseStart: 0, responseEnd: 0 });
    metrics.collectBodySize(ticket, () => { started += 1; return stalled; }); };
  for (let index = 0; index < 65; index += 1) send();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(started, 64);
  advance(1000); for (const timer of timers) timer.callback();
  send(); await metrics.drain(async () => { throw new Error('Expired metadata must not extend drain'); });
  let summary = metrics.summary();
  assert.equal(summary.counters.requestsStarted, 66); assert.equal(summary.allStartedRequestsMeasured, true);
  assert.equal(summary.diagnostics.bodySizeRawInFlightAfterDrain, 64);
  assert.equal(summary.diagnostics.counters.bodySizeTimedOut, 64);
  assert.equal(summary.diagnostics.counters.bodySizeSkippedCapacity, 2);
  assert.equal(summary.diagnostics.counters.maxSizeDiagnosticsInFlight, 64);
  release({ responseBodySize: 50 }); await new Promise(resolve => setImmediate(resolve));
  summary = metrics.summary();
  assert.equal(summary.diagnostics.bodySizeRawInFlightAfterDrain, 0);
  assert.equal(summary.diagnostics.counters.bodySizeLateSettlements, 64);
  assert.equal(summary.diagnostics.counters.bodySizeCaptured, 0);
});
