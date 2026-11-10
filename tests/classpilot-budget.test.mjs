import assert from 'node:assert/strict';
import { test } from 'node:test';
import { estimateClasspilotBudget } from '../scripts/cost/classpilot-budget.mjs';

const base = {
  students: 2000, hoursPerDay: 6, schoolDays: 22, observedFraction: 0,
  unchangedFraction: 0, screenshotBytes: 40960, teacherCopies: 1,
  heartbeatRequestBytes: 1024, heartbeatResponseBytes: 2048,
  teacherMetadataBytesPerStudent: 256, redisCrossAzFraction: 0,
};

test('models every connected student, independently of teacher observation', () => {
  const ordinary = estimateClasspilotBudget(base);
  const observed = estimateClasspilotBudget({ ...base, observedFraction: 1 });
  assert.equal(ordinary.counts.heartbeats, 95040000);
  assert.equal(observed.counts.heartbeats, 95040000);
  assert.equal(ordinary.counts.screenshots, 31680000);
  assert.equal(observed.counts.screenshots, 190080000);
  assert.equal(ordinary.counts.deviceOperations, 126720000);
});

test('preserves captures while reducing pixel transfers for exact-image references', () => {
  const full = estimateClasspilotBudget({ ...base, observedFraction: 1 });
  const refs = estimateClasspilotBudget({ ...base, observedFraction: 1, unchangedFraction: 0.75 });
  assert.equal(refs.counts.screenshots, 190080000);
  assert.equal(refs.counts.fullImageUploads, 47520000);
  assert.equal(refs.counts.referenceUploads, 142560000);
  assert.equal(refs.counts.heartbeats, full.counts.heartbeats);
  assert.equal(refs.bytes.imageUpload, full.bytes.imageUpload / 4);
});

test('WebSocket transport removes per-operation HTTP charges but retains upload bytes', () => {
  const result = estimateClasspilotBudget({ ...base, transport: 'websocket', fallbackFraction: 0 });
  assert.equal(result.counts.deviceHttpRequests, 0);
  assert.equal(result.counts.teacherHttpRequests, 6367680);
  assert.ok(result.costs.cloudfrontOriginTransfer > 0);
  assert.equal(result.counts.edgeRequests, 6411680);
  assert.equal(result.costs.cloudfrontRequests, 0);
});

test('HTTP recovery remains in the request and cost budget', () => {
  const result = estimateClasspilotBudget({ ...base, transport: 'websocket', fallbackFraction: 0.1 });
  assert.equal(result.counts.deviceHttpRequests, 12672000);
  assert.equal(result.counts.edgeRequests, 19083680);
  assert.equal(result.costs.cloudfrontRequests, 9.08368);
});

test('Pro is hypothetical until compatibility and allowance headroom are established', () => {
  const hypothetical = estimateClasspilotBudget({ ...base, edgePlan: 'pro', transport: 'websocket' });
  assert.equal(hypothetical.costs.cloudfrontPlan, 15);
  assert.equal(hypothetical.costs.cloudfrontOriginTransfer, 0);
  assert.equal(hypothetical.budgetStatus, 'unverified');
  assert.ok(hypothetical.unknowns.some(x => /compatibility/i.test(x)));
  const excessive = estimateClasspilotBudget({ ...base, edgePlan: 'pro', transport: 'http', proCompatibilityConfirmed: true });
  assert.ok(excessive.unknowns.some(x => /10 million/i.test(x)));
  assert.equal(excessive.budgetStatus, 'unverified');
});

test('does not claim an all-in budget when required overheads are unknown', () => {
  const result = estimateClasspilotBudget({ students: 1, transport: 'websocket' });
  assert.equal(result.budgetStatus, 'unverified');
  assert.ok(result.unknowns.some(x => /heartbeat bytes/i.test(x)));
  assert.ok(result.unknowns.some(x => /storage/i.test(x)));
});

test('costs scale with student-hours, including the eight-hour sensitivity case', () => {
  const six = estimateClasspilotBudget(base);
  const eight = estimateClasspilotBudget({ ...base, hoursPerDay: 8 });
  assert.equal(eight.counts.heartbeats, 126720000);
  assert.equal(eight.counts.screenshots, 42240000);
  assert.equal(eight.bytes.imageUpload / six.bytes.imageUpload, 4 / 3);
});

test('rejects invalid assumptions rather than silently producing a cheap estimate', () => {
  for (const invalid of [{ students: -1 }, { observedFraction: 1.01 }, { unchangedFraction: -1 },
    { hoursPerDay: 25 }, { screenshotBytes: NaN }, { transport: 'magic' }, { edgePlan: 'free-unlimited' }]) {
    assert.throws(() => estimateClasspilotBudget({ ...base, ...invalid }), /invalid/i);
  }
});

test('separates delta ingress, teacher base hits, origin encoding and cache work', () => {
  const options = { ...base, students: 1, hoursPerDay: 1, schoolDays: 1, observedFraction: 1,
    screenshotBytes: 1000, changedDeltaFraction: 0.5, deltaPatchRatio: 0.1,
    deltaMetadataBytes: 10, teacherDeltaHitFraction: 0.5, viewerImageWireRatio: 0.75,
    redisCrossAzFraction: 1 };
  const result = estimateClasspilotBudget(options);
  assert.equal(result.counts.screenshots, 720);
  assert.equal(result.counts.changedImageUploads, 720);
  assert.equal(result.counts.fullImageUploads, 360);
  assert.equal(result.counts.deltaUploads, 360);
  assert.equal(result.bytes.imageUpload, 399600);
  assert.equal(result.bytes.imageDownloadBeforeEncoding, 559800);
  assert.equal(result.bytes.imageDownload, 419850);
  // Every changed image is still stored in full. Delta uploads read a full base
  // and store one patch; viewer compression does not shrink Redis traffic.
  assert.equal(result.bytes.redisImageWrites, 759600);
  assert.equal(result.bytes.redisDeltaBaseReads, 360000);
  assert.equal(result.bytes.redisImageCrossAz, 1679400);
  const misses = estimateClasspilotBudget({ ...options, teacherDeltaHitFraction: 0 });
  assert.equal(misses.bytes.imageDownloadBeforeEncoding, 720000);
  assert.equal(misses.bytes.imageUpload, result.bytes.imageUpload);
  assert.equal(result.capacityAccepted, false);
});

test('delta eligibility is among changed captures; static references remain independent', () => {
  const result = estimateClasspilotBudget({ ...base, observedFraction: 1, unchangedFraction: 0.75,
    changedDeltaFraction: 0.5, deltaPatchRatio: 0.1, teacherDeltaHitFraction: 1 });
  assert.equal(result.counts.referenceUploads, 142560000);
  assert.equal(result.counts.deltaUploads, 23760000);
  assert.equal(result.counts.fullImageUploads, 23760000);
  assert.equal(result.counts.heartbeats, 95040000);
});

test('all-moving fallback gets no delta credit and still includes honest unknowns', () => {
  const result = estimateClasspilotBudget({ ...base, observedFraction: 1, changedDeltaFraction: 0,
    deltaPatchRatio: 0.1, viewerImageWireRatio: 0.75 });
  assert.equal(result.counts.deltaUploads, 0);
  assert.equal(result.bytes.imageUpload, 190080000 * 40960);
  assert.ok(result.unknowns.some(x => /encoding savings/i.test(x)));
  for (const invalid of [{ changedDeltaFraction: 1.01 }, { deltaPatchRatio: -1 },
    { teacherDeltaHitFraction: 2 }, { viewerImageWireRatio: 0 }, { deltaMetadataBytes: -1 }]) {
    assert.throws(() => estimateClasspilotBudget({ ...base, ...invalid }), /invalid/i);
  }
});
