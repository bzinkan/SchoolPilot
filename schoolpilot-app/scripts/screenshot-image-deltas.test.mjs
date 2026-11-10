import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { encodeScreenshotDelta } from '../src/products/classpilot/lib/screenshotDeltaCodec.js';
import { resolveScreenshotImageDeltas } from '../src/products/classpilot/lib/screenshotImageDeltas.js';
import { fetchTileBatch } from '../src/products/classpilot/lib/tileBatchPolling.js';

const baseId = '11111111-1111-4111-8111-111111111111';
const imageId = '22222222-2222-4222-8222-222222222222';
const binding = 'v2:synthetic-current-scope';
const dataUrl = bytes => `data:image/jpeg;base64,${Buffer.from(bytes).toString('base64')}`;
function fixture() {
  const base = Uint8Array.from({ length: 4096 }, (_, i) => (i * 31) & 255);
  base.set([255, 216, 255, 224]);
  const target = base.slice(); target.fill(201, 1800, 1812);
  const encoded = encodeScreenshotDelta(base, target, { now: () => 0 });
  assert.equal(encoded.kind, 'delta');
  const previous = { tiles: [{ studentId: 'student', bindingVersion: binding, screenshot: {
    imageId: baseId, bindingVersion: binding, timestamp: 1000, screenshot: dataUrl(base),
  } }] };
  const integrityTag = createHash('sha256').update(`classpilot:screenshot-delta-display:v1\0${imageId}\0`).update(target).digest('hex');
  const incoming = { tiles: [{ studentId: 'student', bindingVersion: binding, screenshot: {
    imageId, bindingVersion: binding, timestamp: 2000, tabTitle: 'Fresh lesson',
    delta: { codec: 'cp-bit-copy-v1', baseImageId: baseId, data: Buffer.from(encoded.bytes).toString('base64'), targetBytes: target.length, integrityTag },
  } }] };
  return { base, target, previous, incoming };
}

test('teacher deltas reconstruct exact JPEG bytes from only the current scoped query cache', async () => {
  const f = fixture();
  const result = await resolveScreenshotImageDeltas(f.incoming, f.previous);
  assert.deepEqual(result.missingStudentIds, []);
  const image = result.data.tiles[0].screenshot;
  assert.equal(image.screenshot, dataUrl(f.target));
  assert.equal(image.imageId, imageId);
  assert.equal(image.timestamp, 2000);
  assert.equal(image.tabTitle, 'Fresh lesson');
  assert.equal(image.delta, undefined);
});

test('bad bases, bindings, codecs, lengths, integrity and malformed patch bytes need a full read', async () => {
  const edits = [
    f => { f.previous.tiles[0].screenshot.imageId = imageId; },
    f => { f.incoming.tiles[0].bindingVersion = 'v2:other'; },
    f => { f.incoming.tiles[0].screenshot.delta.codec = 'unsupported'; },
    f => { f.incoming.tiles[0].screenshot.delta.targetBytes++; },
    f => { f.incoming.tiles[0].screenshot.delta.targetBytes = 262145; },
    f => { f.incoming.tiles[0].screenshot.delta.integrityTag = '0'.repeat(64); },
    f => { f.incoming.tiles[0].screenshot.delta.data = '***'; },
    f => { f.incoming.tiles[0].screenshot.delta.data = Buffer.from('bad').toString('base64'); },
    f => { f.incoming.tiles[0].screenshot.timestamp = 0; },
  ];
  for (const edit of edits) {
    const f = fixture(); edit(f);
    const result = await resolveScreenshotImageDeltas(f.incoming, f.previous);
    assert.deepEqual(result.missingStudentIds, ['student']);
    assert.equal(result.data.tiles[0].screenshot, null);
  }
});

test('full images and exact-reference responses pass through unchanged', async () => {
  const f = fixture();
  assert.equal((await resolveScreenshotImageDeltas(f.previous, null)).data, f.previous);
  const unchanged = { tiles: [{ studentId: 'student', screenshot: { unchanged: true } }] };
  assert.equal((await resolveScreenshotImageDeltas(unchanged, f.previous)).data, unchanged);
});

test('a newer existing image wins before any decoding work', async () => {
  const f = fixture(); f.previous.tiles[0].screenshot.timestamp = 3000;
  const result = await resolveScreenshotImageDeltas(f.incoming, f.previous, { digest() { throw new Error('must not decode old data'); } });
  assert.equal(result.data.tiles[0], f.previous.tiles[0]);
  assert.deepEqual(result.missingStudentIds, []);
});

test('authority cancellation during asynchronous integrity verification cannot revive pixels', async () => {
  const f = fixture(); let current = true, release;
  const pending = resolveScreenshotImageDeltas(f.incoming, f.previous, {
    isCurrent: () => current,
    digest: bytes => new Promise(resolve => { release = () => resolve(Uint8Array.from(createHash('sha256').update(bytes).digest()).buffer); }),
  });
  await Promise.resolve(); assert.equal(typeof release, 'function'); current = false; release();
  await assert.rejects(pending, error => error?.name === 'AbortError');
});

test('query cache eviction during verification requires a fresh full read', async () => {
  const f = fixture(); let cached = f.previous;
  const result = await resolveScreenshotImageDeltas(f.incoming, f.previous, {
    getCachedData: () => cached,
    digest: async bytes => { cached = undefined; return Uint8Array.from(createHash('sha256').update(bytes).digest()).buffer; },
  });
  assert.deepEqual(result.missingStudentIds, ['student']);
  assert.equal(result.data.tiles[0].screenshot, null);
});

test('batch reads opt in through the forwarded JSON body and return decoded pixels', async () => {
  const f = fixture(), calls = [];
  const request = { kind: 'screenshots', endpoint: '/classpilot/tiles/screenshots', body: { studentIds: ['student'] } };
  const result = await fetchTileBatch(request, async (_method, _path, body) => { calls.push(body); return f.incoming; }, undefined,
    { getCachedData: () => f.previous });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].imageDeltaProtocolVersion, 1);
  assert.equal(calls[0].knownImageIds.student.imageId, baseId);
  assert.equal(result.tiles[0].screenshot.screenshot, dataUrl(f.target));
});

test('a failed delta recovers once without known IDs or another delta offer', async () => {
  const f = fixture(), calls = [];
  f.incoming.tiles[0].screenshot.delta.integrityTag = '0'.repeat(64);
  const request = { kind: 'screenshots', endpoint: '/classpilot/tiles/screenshots', body: { studentIds: ['student'] } };
  const full = { tiles: [{ ...f.incoming.tiles[0], screenshot: { imageId, bindingVersion: binding, timestamp: 2000, screenshot: dataUrl(f.target) } }] };
  const result = await fetchTileBatch(request, async (_method, _path, body) => {
    calls.push(body); return calls.length === 1 ? f.incoming : full;
  }, undefined, { getCachedData: () => f.previous });
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1], request.body);
  assert.equal(result.tiles[0].screenshot.screenshot, dataUrl(f.target));
});

test('a broken full recovery stays bounded instead of looping or painting unknown pixels', async () => {
  const f = fixture(); let calls = 0;
  f.incoming.tiles[0].screenshot.delta.data = 'invalid';
  const request = { kind: 'screenshots', endpoint: '/classpilot/tiles/screenshots', body: { studentIds: ['student'] } };
  await assert.rejects(fetchTileBatch(request, async () => { calls++; return f.incoming; }, undefined,
    { getCachedData: () => f.previous }), error => error?.response?.status === 503);
  assert.equal(calls, 2);
});
