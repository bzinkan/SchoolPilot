import test from 'node:test';
import assert from 'node:assert/strict';
import { createRenderedNavigationDiagnostics } from './run-classpilot-rendered-dashboards.mjs';
import { navigationGate } from './classpilot-reliability-profile.mjs';

test('navigation diagnostics separate on-time delivery from late native proof without passing the navigation gate', () => {
  const diagnostics = createRenderedNavigationDiagnostics();
  const samples = [];
  for (let index = 0; index < 40; index++) {
    assert.equal(diagnostics.observe({ triggerAt: 100, socketAt: 2700, ownerAt: 2750, domAt: 2850, proofAt: 3350 }), true);
    samples.push(3250);
  }
  const summary = diagnostics.summary();
  assert.equal(summary.provenPaintTargets, 40);
  const bucket = bound => summary.boundsMs.indexOf(bound);
  assert.equal(summary.counts['trigger-to-socket'][bucket(3000)], 40);
  assert.equal(summary.counts['dom-to-native-proof'][bucket(500)], 40);
  assert.equal(summary.counts['trigger-to-native-proof'][bucket(4000)], 40);
  assert.equal(navigationGate(samples, { planned: 40, primaryDevices: 40, observedDevices: 40 }).passed, false);
  assert.equal(JSON.stringify(summary).includes('student'), false);
});

test('invalid or reversed phase clocks are counted without becoming timing samples', () => {
  const diagnostics = createRenderedNavigationDiagnostics();
  for (const phase of [
    { triggerAt: 100, socketAt: 99, ownerAt: 120, domAt: 130, proofAt: 140 },
    { triggerAt: 100, socketAt: 110, ownerAt: 109, domAt: 130, proofAt: 140 },
    { triggerAt: 100, socketAt: 110, ownerAt: 120, domAt: 130, proofAt: Infinity },
    { triggerAt: 100, socketAt: 110, ownerAt: 120, domAt: 130 },
  ]) assert.equal(diagnostics.observe(phase), false);
  const summary = diagnostics.summary();
  assert.equal(summary.invalidCount, 4);
  assert.equal(summary.provenPaintTargets, 0);
  assert.ok(Object.values(summary.counts).every(counts => counts.every(value => value === 0)));
});

test('histogram snapshots are detached and large durations retain an overflow bucket', () => {
  const diagnostics = createRenderedNavigationDiagnostics();
  assert.equal(diagnostics.observe({ triggerAt: 0, socketAt: 9000, ownerAt: 9000, domAt: 9000, proofAt: 9001 }), true);
  const first = diagnostics.summary();
  assert.equal(first.counts['trigger-to-socket'].at(-1), 1);
  first.counts['trigger-to-socket'].fill(99);
  assert.equal(diagnostics.summary().counts['trigger-to-socket'].at(-1), 1);
});
