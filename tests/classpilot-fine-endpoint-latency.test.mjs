import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FineEndpointLatencies, FineEndpointLatencyHistogram, FINE_LATENCY_ENDPOINTS,
  FINE_LATENCY_MAX_MS, FINE_LATENCY_OVERFLOW_INDEX, conservativeP95Comparison,
  fineLatencyEndpoint } from '../scripts/load/fine-endpoint-latency.mjs';

test('fixed one-millisecond buckets preserve zero, exact edges and deadline overflow without clamping', () => {
  const histogram = new FineEndpointLatencyHistogram();
  for (const value of [0, 0.001, 1, 1.00001, 7_999, 7_999.1, 8_000, 8_000.0001, 16_000]) histogram.observe(value, value === 8_000.0001);
  for (const value of [NaN, Infinity, -Infinity, -1, '8000']) histogram.observe(value);
  const summary = histogram.summary();
  assert.equal(summary.counts.length, 8_002);
  assert.equal(summary.count, 9); assert.equal(summary.failedCount, 1); assert.equal(summary.invalidCount, 5);
  assert.equal(summary.counts[0], 1); assert.equal(summary.counts[1], 2); assert.equal(summary.counts[2], 1);
  assert.equal(summary.counts[7_999], 1); assert.equal(summary.counts[8_000], 2);
  assert.equal(summary.overflowCount, 2); assert.equal(summary.counts[FINE_LATENCY_OVERFLOW_INDEX], 2);
  assert.equal(summary.p95Bounds.finite, false); assert.equal(summary.p95Bounds.upperMs, null);
  assert.equal(summary.p95Bounds.complete, false);
  assert.equal(summary.counts.reduce((sum, value) => sum + value, 0), summary.count);
});

test('pooled counts preserve nearest-rank fleet p95 rather than averaging host percentiles', () => {
  const slowHost = new FineEndpointLatencyHistogram(), busyHost = new FineEndpointLatencyHistogram();
  slowHost.observe(4_000.1);
  for (let index = 0; index < 99; index += 1) busyHost.observe(10.1);
  const pooled = new FineEndpointLatencyHistogram().merge(slowHost).merge(busyHost).summary();
  assert.equal(pooled.count, 100); assert.equal(pooled.p95Bounds.rank, 95);
  assert.deepEqual([pooled.p95Bounds.lowerMs, pooled.p95Bounds.upperMs], [10, 11]);
  assert.notEqual(pooled.p95Bounds.upperMs, (slowHost.summary().p95Bounds.upperMs + busyHost.summary().p95Bounds.upperMs) / 2);
  assert.equal(slowHost.summary().count, 1, 'pooling does not mutate the input host');
});

test('nearest-rank p95 remains finite with five-percent overflow and unknown when the rank enters overflow', () => {
  const histogram = new FineEndpointLatencyHistogram();
  for (let index = 0; index < 19; index += 1) histogram.observe(100.1);
  histogram.observe(8_001);
  assert.deepEqual([histogram.summary().p95Bounds.lowerMs, histogram.summary().p95Bounds.upperMs], [100, 101]);
  histogram.observe(8_002);
  assert.equal(histogram.summary().p95Bounds.finite, false);
  assert.equal(histogram.summary().p95Bounds.upperMs, null);
});

test('twenty-percent comparison passes only when the worst candidate bound fits the best reference bound', () => {
  const sample = value => { const histogram = new FineEndpointLatencyHistogram(); histogram.observe(value); return histogram.summary(); };
  const reference = sample(100.3);
  assert.equal(conservativeP95Comparison(sample(119.5), reference).status, 'pass');
  assert.equal(conservativeP95Comparison(sample(120.1), reference).status, 'inconclusive', 'quantization overlap cannot become a false pass');
  assert.equal(conservativeP95Comparison(sample(8_001), reference).status, 'inconclusive');
  assert.equal(conservativeP95Comparison(new FineEndpointLatencyHistogram().summary(), reference).status, 'inconclusive');
  const invalid = new FineEndpointLatencyHistogram(); invalid.observe(100); invalid.observe(NaN);
  assert.equal(conservativeP95Comparison(invalid.summary(), reference).status, 'inconclusive');
});

test('endpoint evidence uses fixed classes, redacts bindings and counts every classified request once', () => {
  const collection = new FineEndpointLatencies();
  const privateId = 'private-student-session-identity';
  const lease = fineLatencyEndpoint('PUT', `/api/classpilot/teaching-sessions/${privateId}/observation-lease?ignored=private`);
  assert.equal(lease, 'PUT /api/classpilot/teaching-sessions/{teachingSessionId}/observation-lease');
  collection.observe(lease, 20.1); collection.observe(lease, 20.2, true);
  const heartbeat = fineLatencyEndpoint('POST', '/api/classpilot/device/heartbeat');
  assert.equal(fineLatencyEndpoint('POST', '/api/commands'), 'POST /api/classpilot/commands');
  assert.equal(fineLatencyEndpoint('GET', '/api/commands/active-state?teachingSessionId=private'), 'GET /api/classpilot/commands/active-state');
  assert.equal(fineLatencyEndpoint('GET', '/api/teacher/raised-hands'), 'GET /api/classpilot/teacher/raised-hands');
  collection.observe(heartbeat, 5);
  collection.observe(fineLatencyEndpoint('GET', `/api/unknown/${privateId}`), 1);
  const summary = collection.summary();
  assert.equal(summary.unclassifiedCount, 1);
  assert.equal(summary.endpoints[lease].count, 2); assert.equal(summary.endpoints[lease].failedCount, 1);
  assert.equal(summary.endpoints[heartbeat].count, 1);
  assert.doesNotMatch(JSON.stringify(summary), /private-student|ignored=|unknown/);
});

test('all endpoint histograms remain bounded and their serialized final evidence leaves ample sixteen-MiB headroom', () => {
  const collection = new FineEndpointLatencies();
  const bucketCount = FINE_LATENCY_OVERFLOW_INDEX + 1;
  const perBucket = Math.floor(Number.MAX_SAFE_INTEGER / bucketCount);
  for (const endpoint of FINE_LATENCY_ENDPOINTS) {
    collection.observe(endpoint, 1);
    const histogram = collection.endpoints.get(endpoint);
    histogram.counts.fill(perBucket);
    histogram.count = perBucket * bucketCount;
  }
  const summary = collection.summary();
  const serialized = JSON.stringify(summary);
  assert.ok(Buffer.byteLength(serialized) < 4 * 1024 * 1024, 'twenty-seven fixed categories with worst-case safe counters retain bounded aggregate headroom');
  assert.ok(Buffer.byteLength(JSON.stringify(summary, null, 2)) < 16 * 1024 * 1024, 'the actual formatted evidence encoding also stays bounded');
  assert.equal(summary.bucketUpperBoundsMs.length, bucketCount);
  assert.equal(summary.bucketUpperBoundsMs[FINE_LATENCY_MAX_MS], 8_000);
  assert.equal(summary.bucketUpperBoundsMs[FINE_LATENCY_OVERFLOW_INDEX], null);
  assert.ok(Object.values(summary.endpoints).every(value => value.counts.every(Number.isSafeInteger)));
  assert.equal(JSON.parse(serialized).resolutionMs, 1);
});

const teacherDashboardRoutes = [
  ['GET', '/api/sessions/active', 'GET /api/sessions/active'],
  ['GET', '/api/classpilot/dashboard-activity', 'GET /api/classpilot/dashboard-activity'],
  ['GET', '/api/coverage/summary', 'GET /api/coverage/summary'],
  ['GET', '/api/teacher/messages', 'GET /api/teacher/messages'],
  ['GET', '/api/classpilot/schedule-changes/today', 'GET /api/classpilot/schedule-changes/today'],
  ['POST', '/api/classpilot/monitoring/client-health', 'POST /api/classpilot/monitoring/client-health'],
  ['GET', '/api/classpilot/commands/private-command/status', 'GET /api/classpilot/commands/{commandId}/status'],
  ['GET', '/api/settings', 'GET /api/settings'],
  ['GET', '/api/flight-paths', 'GET /api/flight-paths'],
  ['GET', '/api/block-lists', 'GET /api/block-lists'],
  ['GET', '/api/teacher/groups', 'GET /api/teacher/groups'],
  ['GET', '/api/coverage/capabilities', 'GET /api/coverage/capabilities'],
  ['GET', '/api/groups/private-group/subgroups', 'GET /api/groups/{groupId}/subgroups'],
  ['GET', '/api/classpilot/teacher/preferences', 'GET /api/classpilot/teacher/preferences'],
  ['GET', '/api/admin/attendance', 'GET /api/admin/attendance'],
];

test('actual teacher polling and mount route shapes have fixed method-scoped labels without query or identifier evidence', () => {
  const collection = new FineEndpointLatencies();
  for (const [method, pathname, expected] of teacherDashboardRoutes) {
    for (const query of ['', '?scope=mine&sessionId=private-query&date=private-date']) {
      const label = fineLatencyEndpoint(method, pathname + query);
      assert.equal(label, expected);
      collection.observe(label, 100.1);
    }
  }
  const summary = collection.summary();
  assert.equal(summary.unclassifiedCount, 0);
  assert.equal(Object.keys(summary.endpoints).length, teacherDashboardRoutes.length);
  assert.ok(Object.values(summary.endpoints).every(value => value.count === 2 && value.p95Bounds.upperMs === 101));
  assert.doesNotMatch(JSON.stringify(summary), /private-command|private-group|private-query|private-date|scope=|sessionId=|https?:/);
});

test('teacher endpoint categories refuse other methods, sibling routes and malformed dynamic segments', () => {
  for (const [method, pathname] of teacherDashboardRoutes) {
    assert.equal(fineLatencyEndpoint(method === 'GET' ? 'POST' : 'GET', pathname), null);
    assert.equal(fineLatencyEndpoint(method.toLowerCase(), pathname), null);
    assert.equal(fineLatencyEndpoint(method + ' ', pathname), null);
    assert.equal(fineLatencyEndpoint(method, pathname + '/extra'), null);
    assert.equal(fineLatencyEndpoint(method, pathname + '#private'), null);
    assert.equal(fineLatencyEndpoint(method, pathname + '\n'), null);
    assert.equal(fineLatencyEndpoint(method, 'https://foreign.invalid' + pathname), null);
  }
  for (const prefix of ['/api/classpilot/commands/', '/api/groups/']) {
    const suffix = prefix.includes('commands') ? '/status' : '/subgroups';
    for (const id of ['', '.', '..', '{commandId}', '{groupId}', '%2fprivate', '%2Fprivate', 'part/part', 'private space', 'private\\part', 'private;part', 'x'.repeat(257)]) {
      assert.equal(fineLatencyEndpoint('GET', prefix + id + suffix), null);
    }
    assert.notEqual(fineLatencyEndpoint('GET', prefix + 'x'.repeat(256) + suffix + '?ignored=private'), null);
  }
  for (const method of [null, undefined, 1, { toString: () => 'GET' }]) {
    assert.equal(fineLatencyEndpoint(method, '/api/sessions/active'), null);
  }
  for (const pathname of [null, undefined, 1, {}, '/api/unknown/private', '/api/unknown?path=/api/settings', '/api/sessions/active-extra']) {
    assert.equal(fineLatencyEndpoint('GET', pathname), null);
  }
});

test('teacher categories preserve the original twelve producer and capture metric families exactly', () => {
  const original = [
    'POST /api/classpilot/device/heartbeat', 'POST /api/classpilot/device/screenshot',
    'GET /api/students-aggregated', 'POST /api/classpilot/tiles/history',
    'POST /api/classpilot/tiles/screenshots', 'POST /api/classpilot/commands',
    'GET /api/classpilot/commands/active-state', 'GET /api/classpilot/teacher/raised-hands',
    'PUT /api/classpilot/teaching-sessions/{teachingSessionId}/observation-lease',
    'DELETE /api/classpilot/teaching-sessions/{teachingSessionId}/observation-lease',
    'GET /api/classpilot/heartbeats/{deviceId}', 'GET /api/classpilot/device/screenshot/{deviceId}',
  ];
  assert.deepEqual(FINE_LATENCY_ENDPOINTS.slice(0, original.length), original);
  assert.equal(new Set(FINE_LATENCY_ENDPOINTS).size, FINE_LATENCY_ENDPOINTS.length);
  for (const label of original) {
    const space = label.indexOf(' '), method = label.slice(0, space);
    const pathname = label.slice(space + 1).replace(/\{[^}]+\}/g, 'private-binding');
    assert.equal(fineLatencyEndpoint(method, pathname + '?ignored=private'), label);
  }
});

const rolloutLabel = 'GET /api/classpilot/class-tools/rollout';
test('dashboard rollout poll has one fixed content-free label', () => {
  assert.equal(fineLatencyEndpoint('GET', '/api/classpilot/class-tools/rollout'), rolloutLabel);
  assert.equal(fineLatencyEndpoint('GET', '/api/classpilot/class-tools/rollout?schoolId=synthetic-only'), rolloutLabel);
});
test('rollout classification rejects other methods', () => {
  for (const method of ['POST', 'PUT', 'DELETE', 'HEAD']) assert.equal(fineLatencyEndpoint(method, '/api/classpilot/class-tools/rollout'), null);
});
test('rollout classification rejects non-exact routes', () => {
  for (const route of ['/api/classpilot/class-tools/rollout/', '/api/classpilot/class-tools/rollout/extra', '/api/classpilot/class-tools/rollout-suffix', '/api/classpilot/class-tools/state', '/api/another-product/class-tools/rollout']) assert.equal(fineLatencyEndpoint('GET', route), null);
});
test('real rollout poll enters the bounded latency histogram without a query label', () => {
  const latencies = new FineEndpointLatencies();
  latencies.observe(fineLatencyEndpoint('GET', '/api/classpilot/class-tools/rollout?schoolId=synthetic-only'), 111.2);
  const summary = latencies.summary();
  assert.equal(summary.unclassifiedCount, 0);
  assert.deepEqual(Object.keys(summary.endpoints), [rolloutLabel]);
  assert.equal(summary.endpoints[rolloutLabel].count, 1);
  assert.equal(summary.endpoints[rolloutLabel].p95Bounds.upperMs, 112);
});
