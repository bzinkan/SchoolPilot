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
  assert.ok(Buffer.byteLength(serialized) < 2 * 1024 * 1024, 'even worst-case safe counters leave room for the remaining aggregate run summary');
  assert.ok(Buffer.byteLength(JSON.stringify(summary, null, 2)) < 16 * 1024 * 1024, 'the actual formatted evidence encoding also stays bounded');
  assert.equal(summary.bucketUpperBoundsMs.length, bucketCount);
  assert.equal(summary.bucketUpperBoundsMs[FINE_LATENCY_MAX_MS], 8_000);
  assert.equal(summary.bucketUpperBoundsMs[FINE_LATENCY_OVERFLOW_INDEX], null);
  assert.ok(Object.values(summary.endpoints).every(value => value.counts.every(Number.isSafeInteger)));
  assert.equal(JSON.parse(serialized).resolutionMs, 1);
});
