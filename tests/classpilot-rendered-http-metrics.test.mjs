import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RenderedHttpMetrics, RENDERED_HTTP_DEADLINE_MS } from '../scripts/load/rendered-http-metrics.mjs';

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
