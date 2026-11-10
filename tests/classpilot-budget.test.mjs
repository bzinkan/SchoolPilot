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
