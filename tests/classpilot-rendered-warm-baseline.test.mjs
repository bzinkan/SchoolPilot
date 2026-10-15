import test from 'node:test';
import assert from 'node:assert/strict';
import { RENDERED_VIEWPORT, warmActualRenderedCaptureBaseline, updateActualRenderedCaptureBinding,
  scoreRenderedCaptureAge } from '../scripts/load/run-classpilot-rendered-dashboards.mjs';

const rgba = [40, 100, 180, 255];
const frame = ordinal => ({ ordinal, capturedAt: 1, pulseSequence: 1, pulseMarker: 'a'.repeat(24), jpegSha256: ordinal.toString(16).padStart(64, '0') });
const card = (studentId, ordinal = 1) => ({ studentId, displayed: true, decoded: true, opacity: 1,
  frame: frame(ordinal), previousFrame: null, previousRgba: null, contributors: [frame(ordinal)], rgba: rgba.slice(),
  points: [{ x: 10, y: 10 }, { x: 11, y: 10 }, { x: 12, y: 10 }],
  geometry: { left: 0, top: 0, width: 20, height: 20, naturalWidth: 1, naturalHeight: 1, objectFit: 'contain' } });
const origin = () => ({ width: RENDERED_VIEWPORT.width, height: RENDERED_VIEWPORT.height, scrollX: 0, scrollY: 0,
  devicePixelRatio: 1, visualViewport: { pageLeft: 0, pageTop: 0, offsetLeft: 0, offsetTop: 0,
    width: RENDERED_VIEWPORT.width, height: RENDERED_VIEWPORT.height, scale: 1 } });

function fixture({ before, after, pixel = rgba, durations = {}, atStage = () => {}, decodeError, originAt = (_stage, value) => value } = {}) {
  const ids = ['synthetic-a', 'synthetic-b'], expiresAt = '2099-01-01T00:00:00.000Z';
  const runtime = { actor: { teacherId: 'synthetic-teacher', role: 'teacher', schoolId: 'synthetic-school',
    teachingSessionId: 'synthetic-class', studentIds: ids, expiresAt }, subscribed: true, socketGeneration: 1, scopeEpoch: 0,
    allowed: new Set(ids), bindings: new Map(ids.map(id => [id, 'private-' + id])),
    frames: new Map(ids.map(id => [id, [frame(1)]])), lastPaints: new Map(), priorStripAbsent: true };
  const auth = { schoolId: runtime.actor.schoolId, expiresAt, deviceManifestExpiresAt: expiresAt };
  const png = Buffer.alloc(32, 7), budgets = [], calls = [];
  let clock = 0, current = true, samples = 0, origins = 0;
  const step = stage => { calls.push(stage); clock += durations[stage] ?? 100; atStage(stage, runtime, auth, value => { clock = value; }, value => { current = value; }); };
  const scope = { isCurrent: () => current,
    page: { async evaluate(fn, argument) {
      if (fn.name === 'nativeViewportOriginProof') { const stage = ++origins === 1 ? 'origin-before' : 'origin-after'; step(stage); return originAt(stage, origin()); }
      assert.equal(fn.name, 'collectRenderedDashboardSample');
      const stage = ++samples === 1 ? 'dom-before' : 'dom-after'; step(stage);
      if (stage === 'dom-after') assert.deepEqual(argument, { skipAnimationFrames: true });
      return structuredClone((stage === 'dom-before' ? before : after ?? before) ?? { visible: true, cards: ids.map(id => card(id)) });
    } },
    capture: { async capture(page, viewport, clip, budget) {
      assert.equal(page, scope.page); assert.deepEqual(viewport, RENDERED_VIEWPORT); assert.equal(clip, null);
      budgets.push({ stage: 'capture', budget }); step('capture'); return png;
    } },
    decoder: { async run(bytes, viewport, sample, budget) {
      assert.equal(bytes, png); assert.deepEqual(viewport, RENDERED_VIEWPORT);
      budgets.push({ stage: 'decode', budget }); step('decode'); if (decodeError) throw decodeError;
      return sample(() => pixel.slice());
    } },
  };
  return { runtime, auth, png, calls, budgets, setClock: value => { clock = value; },
    run: () => warmActualRenderedCaptureBaseline(runtime, scope, { auth, runId: 'synthetic-run', now: () => clock, nowWall: () => Date.parse('2026-10-15T00:00:00.000Z') }) };
}
const unknown = f => assert.ok([...f.runtime.lastPaints.values()].every(value => value.frame === null && value.rgba === null && value.nativeAbsence === undefined));
const zeroed = f => { assert.equal(f.calls.filter(stage => stage === 'capture').length, 1); assert.ok(f.png.every(byte => byte === 0)); };

test('one existing warm native PNG seeds only anonymous RGBA, including an old source without inventing fresh age', async () => {
  const f = fixture(), result = await f.run();
  assert.equal(result.seeded, 2); assert.match(result.compositorSha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(Object.keys(result).sort(), ['compositorSha256', 'seeded']); zeroed(f);
  for (const previous of f.runtime.lastPaints.values()) {
    assert.deepEqual(previous, { frame: null, rgba, absent: false });
    assert.equal(scoreRenderedCaptureAge({ frame: frame(99), composed: { rgba: rgba.slice(), contributors: [frame(99)] },
      previous, publicBinding: 'synthetic', observedAt: 1e6,
      pulseController: { ageUpper() { assert.fail('unchanged pixels cannot use newer metadata or the expired warm pulse'); } } }), Infinity);
  }
});

test('warm capture and decoder consume the decreasing remainder of one 8s budget', async () => {
  const f = fixture({ durations: { 'dom-before': 500, 'origin-before': 500, capture: 1000, 'dom-after': 500, 'origin-after': 500, decode: 500 } });
  await f.run(); zeroed(f);
  assert.deepEqual(f.budgets, [{ stage: 'capture', budget: 7000 }, { stage: 'decode', budget: 5000 }]);
  assert.ok(f.budgets.every(value => value.budget > 0 && value.budget < 8000));
});

test('a genuine authorized native fade supplies anonymous physical pixels only while every contributor remains known', async () => {
  const cards = ['synthetic-a', 'synthetic-b'].map(id => ({ ...card(id, 2), opacity: .5,
    previousFrame: frame(1), previousRgba: [220, 20, 20, 255], contributors: [frame(1), frame(2)] }));
  for (const retireFrames of [false, true]) {
    const f = fixture({ before: { visible: true, cards }, pixel: [130, 60, 100, 255],
      atStage(stage, runtime) { if (stage === 'decode' && retireFrames) runtime.frames.clear(); } });
    for (const id of f.runtime.actor.studentIds) f.runtime.frames.set(id, [frame(1), frame(2)]);
    assert.equal((await f.run()).seeded, retireFrames ? 0 : 2); zeroed(f);
    for (const previous of f.runtime.lastPaints.values()) {
      assert.equal(previous.frame, null); assert.equal(previous.nativeAbsence, undefined);
      assert.deepEqual(previous.rgba, retireFrames ? null : [130, 60, 100, 255]);
    }
  }
});

for (const stage of ['dom-before', 'dom-after']) test(`hidden ${stage} cannot seed a warm baseline`, async () => {
  const value = { visible: false, cards: [card('synthetic-a'), card('synthetic-b')] };
  const f = fixture(stage === 'dom-before' ? { before: value } : { after: value });
  assert.equal((await f.run()).seeded, 0); unknown(f); zeroed(f);
});

test('blank rows, missing bindings and unlinked contributors remain UNKNOWN without a new all-row readiness gate', async () => {
  for (const condition of ['blank', 'missing-binding', 'unlinked']) {
    const cards = [card('synthetic-a'), card('synthetic-b')];
    if (condition === 'blank') Object.assign(cards[1], { frame: null, contributors: [null], rgba: null, decoded: false, displayed: false, points: [] });
    if (condition === 'unlinked') cards[1].contributors = [frame(2)];
    const f = fixture({ before: { visible: true, cards } });
    if (condition === 'missing-binding') f.runtime.bindings.delete('synthetic-b');
    assert.equal((await f.run()).seeded, 1, condition); zeroed(f);
    assert.deepEqual(f.runtime.lastPaints.get('synthetic-a'), { frame: null, rgba, absent: false });
    assert.deepEqual(f.runtime.lastPaints.get('synthetic-b'), { frame: null, rgba: null, absent: false });
  }
  const blank = { visible: true, cards: ['synthetic-a', 'synthetic-b'].map(id => ({ ...card(id), frame: null, contributors: [null], rgba: null, decoded: false, displayed: false, points: [] })) };
  const f = fixture({ before: blank }); assert.equal((await f.run()).seeded, 0); unknown(f); zeroed(f);
});

test('native mismatch, foreign/duplicate cards and source swaps cannot seed a warm baseline', async () => {
  for (const condition of ['mismatch', 'malformed-pixel', 'foreign', 'duplicate', 'swap']) {
    const before = { visible: true, cards: [card('synthetic-a'), card('synthetic-b')] }, after = structuredClone(before);
    if (condition === 'foreign') after.cards[1].studentId = 'foreign';
    if (condition === 'duplicate') after.cards[1].studentId = 'synthetic-a';
    if (condition === 'swap') for (const row of after.cards) { row.previousFrame = row.frame; row.previousRgba = row.rgba; row.frame = frame(2); row.contributors = [frame(1), frame(2)]; }
    const f = fixture({ before, after, pixel: condition === 'mismatch' ? [255, 0, 0, 255] : condition === 'malformed-pixel' ? [40, 100, 180, 256] : rgba });
    if (condition === 'swap') for (const id of f.runtime.actor.studentIds) f.runtime.frames.set(id, [frame(1), frame(2)]);
    assert.equal((await f.run()).seeded, 0, condition); unknown(f); zeroed(f);
  }
});

test('authority, scope and binding fences remain valid through actual decode completion', async () => {
  const changes = [runtime => { runtime.scopeEpoch++; }, runtime => { runtime.socketGeneration++; },
    runtime => { runtime.actor.schoolId = 'foreign'; }, runtime => { runtime.actor.teachingSessionId = 'foreign'; },
    runtime => { runtime.bindings.set('synthetic-a', 'replacement'); }, runtime => { runtime.subscribed = false; },
    (_runtime, auth) => { auth.expiresAt = '2000-01-01T00:00:00.000Z'; }];
  for (const change of changes) {
    const f = fixture({ atStage(stage, runtime, auth) { if (stage === 'decode') change(runtime, auth); } });
    await assert.rejects(f.run()); unknown(f); zeroed(f);
  }
});

test('late capture/DOM/decode and clock regression cannot receive a new phase budget or seed evidence', async () => {
  for (const stage of ['capture', 'dom-after', 'decode']) {
    const f = fixture({ atStage(at, _runtime, _auth, setClock) { if (at === stage) setClock(8001); } });
    await assert.rejects(f.run(), /Whole native warm deadline/); unknown(f); zeroed(f);
    if (stage !== 'decode') assert.equal(f.calls.includes('decode'), false);
  }
  const f = fixture({ atStage(stage, _runtime, _auth, setClock) { if (stage === 'capture') setClock(1); } });
  await assert.rejects(f.run(), /Whole native warm deadline/); unknown(f); zeroed(f);
});

test('a changed origin or rejected decode still zeroes the one owned native PNG', async () => {
  for (const options of [{ decodeError: new Error('synthetic decode failure') },
    { originAt: (stage, value) => stage === 'origin-after' ? { ...value, scrollY: 1 } : value }]) {
    const f = fixture(options); await assert.rejects(f.run()); unknown(f); zeroed(f);
  }
});

test('retired owner cannot seed even when its native operation returns successfully', async () => {
  const f = fixture({ atStage(stage, _runtime, _auth, _setClock, setCurrent) { if (stage === 'decode') setCurrent(false); } });
  await assert.rejects(f.run(), /Native warm authority changed/); unknown(f); zeroed(f);
});

test('actual tile binding replacement clears physical and semantic prior evidence for only that student', () => {
  const f = fixture(); let invalidations = 0;
  for (const id of f.runtime.actor.studentIds) f.runtime.lastPaints.set(id, { frame: frame(1), rgba: rgba.slice(), absent: false });
  const prior = f.runtime.lastPaints.get('synthetic-a');
  updateActualRenderedCaptureBinding(f.runtime, 'synthetic-a', 'private-synthetic-a', () => invalidations++);
  assert.equal(invalidations, 0); assert.equal(f.runtime.lastPaints.get('synthetic-a'), prior);
  updateActualRenderedCaptureBinding(f.runtime, 'synthetic-a', 'new-private-binding', () => invalidations++);
  assert.equal(invalidations, 1); assert.equal(f.runtime.frames.has('synthetic-a'), false);
  assert.equal(f.runtime.lastPaints.has('synthetic-a'), false); assert.equal(f.runtime.priorStripAbsent, false);
  assert.ok(f.runtime.frames.has('synthetic-b')); assert.ok(f.runtime.lastPaints.has('synthetic-b'));
});
