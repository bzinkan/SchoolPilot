import test from 'node:test';
import assert from 'node:assert/strict';
import { retainActualRenderedCaptureEvidence, scoreRenderedCaptureAge } from './run-classpilot-rendered-dashboards.mjs';

const frame = ordinal => ({ ordinal, capturedAt: ordinal * 1000, pulseSequence: ordinal,
  pulseMarker: 'a'.repeat(24), jpegSha256: ordinal.toString(16).padStart(64, '0') });
const colours = [[220, 20, 20, 255], [20, 220, 20, 255], [20, 20, 220, 255]];
const runtime = () => ({ lastPaints: new Map() });
const result = (ordinal, rgba, options = {}) => ({ studentId: 'synthetic', authorized: true, age: Infinity,
  card: { frame: frame(ordinal), displayed: true, decoded: true, opacity: .5 }, after: { opacity: .75 },
  composed: { matched: true, transitioned: false, rgba, contributors: [frame(ordinal)] }, ...options });

test('a validated native fade seeds only anonymous physical evidence and does not score its first paint as fresh', () => {
  const state = runtime(), sample = result(1, colours[0]);
  const previous = retainActualRenderedCaptureEvidence(state, sample, true);
  assert.equal(previous.frame, null);
  assert.deepEqual(previous.rgba, colours[0]);
  assert.equal(scoreRenderedCaptureAge({ frame: frame(2), composed: { ...sample.composed, contributors: [frame(2)] },
    previous, publicBinding: 'synthetic', observedAt: 100, pulseController: { ageUpper: () => 1000 } }), Infinity);
});

test('finite native fades retire the old semantic frame before a three-colour fixture cycles back', () => {
  const state = runtime();
  state.lastPaints.set('synthetic', { frame: frame(1), rgba: colours[0] });
  retainActualRenderedCaptureEvidence(state, result(2, colours[1], { age: 10000 }), true);
  const previous = state.lastPaints.get('synthetic');
  assert.equal(previous.frame, null);
  assert.deepEqual(previous.rgba, colours[1]);
  const oldContributor = frame(3), current = frame(4);
  const age = scoreRenderedCaptureAge({ frame: current, composed: { rgba: colours[0], contributors: [oldContributor, current] },
    previous, publicBinding: 'synthetic', observedAt: 50000,
    pulseController: { ageUpper: value => { assert.notEqual(value.ordinal, 1); return value.ordinal === 3 ? 12000 : 1000; } } });
  assert.equal(age, 12000, 'The oldest contributing fade frame still bounds freshness');
});

test('a finite fade cannot leave a frame credit that upgrades unchanged pixels or small jitter with newer metadata', () => {
  const state = runtime();
  state.lastPaints.set('synthetic', { frame: frame(1), rgba: colours[0] });
  retainActualRenderedCaptureEvidence(state, result(2, colours[0], { age: 1000 }), true);
  const previous = state.lastPaints.get('synthetic');
  assert.equal(previous.frame, null);
  for (const rgba of [colours[0], [232, 32, 32, 255]]) {
    assert.equal(scoreRenderedCaptureAge({ frame: frame(3), composed: { rgba, contributors: [frame(3)] }, previous,
      publicBinding: 'synthetic', observedAt: 100, pulseController: { ageUpper: () => { throw Error('No causal upgrade permitted'); } } }), Infinity);
  }
});

test('rejected authority, visibility, decoding, display and native matching cannot seed a fade baseline', () => {
  for (const mutate of [sample => { sample.authorized = false; }, sample => { sample.card.displayed = false; },
    sample => { sample.card.decoded = false; }, sample => { sample.composed.matched = false; }]) {
    const state = runtime(), sample = result(1, colours[0]); mutate(sample);
    assert.equal(retainActualRenderedCaptureEvidence(state, sample, true), undefined);
    assert.equal(state.lastPaints.size, 0);
  }
  const state = runtime();
  assert.equal(retainActualRenderedCaptureEvidence(state, result(1, colours[0]), false), undefined);
  assert.equal(state.lastPaints.size, 0);
});

test('missing or malformed native RGBA cannot seed or replace any opaque or fade baseline', () => {
  const malformed = [undefined, null, [], [1, 2, 3], [1, 2, 3, 4, 5], [0, 0, 0, NaN],
    [0, 0, 0, -1], [0, 0, 0, 256], [0, 0, 0, 1.5], ['0', 0, 0, 255], new Uint8Array([0, 0, 0, 255])];
  for (const opacity of [.5, 1]) for (const hasPrevious of [false, true]) for (const rgba of malformed) {
    const state = runtime(), previous = { frame: frame(1), rgba: colours[0], absent: false };
    if (hasPrevious) state.lastPaints.set('synthetic', previous);
    const sample = result(2, rgba, { age: 1000 });
    sample.card.opacity = opacity; sample.after.opacity = opacity;
    assert.equal(retainActualRenderedCaptureEvidence(state, sample, true), undefined);
    assert.equal(state.lastPaints.size, hasPrevious ? 1 : 0);
    if (hasPrevious) assert.equal(state.lastPaints.get('synthetic'), previous);
  }
});
