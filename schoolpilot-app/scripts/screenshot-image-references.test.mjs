import assert from 'node:assert/strict';
import { test } from 'node:test';
import { knownScreenshotImageIds, resolveScreenshotImageReferences } from '../src/products/classpilot/lib/screenshotImageReferences.js';
import { fetchTileBatch } from '../src/products/classpilot/lib/tileBatchPolling.js';

const id = '9cb6a642-e853-44cf-bf09-33fe960c0542';
const previous = { tiles: [{ studentId: 's1', bindingVersion: 'v2:class-a', screenshot: {
  screenshot: 'data:image/jpeg;base64,real-cached-pixels', imageId: id,
  bindingVersion: 'v2:class-a', timestamp: 1000, tabTitle: 'Old title',
} }] };
const reference = { tiles: [{ studentId: 's1', bindingVersion: 'v2:class-a', screenshot: {
  imageId: id, unchanged: true, bindingVersion: 'v2:class-a', timestamp: 2000, tabTitle: 'New title',
} }] };

test('advertises only existing pixels for the requested exact-binding students', () => {
  assert.deepEqual(knownScreenshotImageIds(previous, ['s1', 's2']), {
    s1: { imageId: id, bindingVersion: 'v2:class-a' },
  });
  assert.deepEqual(knownScreenshotImageIds(previous, ['s2']), {});
  assert.deepEqual(knownScreenshotImageIds({ tiles: [{ ...previous.tiles[0], bindingVersion: 'v2:other' }] }, ['s1']), {});
});

test('reuses identical pixels only with matching opaque image and authority while applying fresh metadata', () => {
  const result = resolveScreenshotImageReferences(reference, previous);
  assert.deepEqual(result.missingStudentIds, []);
  assert.equal(result.data.tiles[0].screenshot.screenshot, 'data:image/jpeg;base64,real-cached-pixels');
  assert.equal(result.data.tiles[0].screenshot.timestamp, 2000);
  assert.equal(result.data.tiles[0].screenshot.tabTitle, 'New title');
  assert.equal(Object.hasOwn(result.data.tiles[0].screenshot, 'unchanged'), false);
});

test('cannot borrow pixels from a former binding, a different image or an absent cache', () => {
  for (const cached of [undefined, { tiles: [] }, { tiles: [{ ...previous.tiles[0], bindingVersion: 'v2:other' }] },
    { tiles: [{ ...previous.tiles[0], screenshot: { ...previous.tiles[0].screenshot, imageId: 'wrong' } }] }]) {
    const result = resolveScreenshotImageReferences(reference, cached);
    assert.deepEqual(result.missingStudentIds, ['s1']);
    assert.equal(result.data.tiles[0].screenshot, null);
  }
});

test('a delayed reference cannot move capture metadata backwards or invent freshness', () => {
  const newer = { tiles: [{ ...previous.tiles[0], screenshot: { ...previous.tiles[0].screenshot, timestamp: 3000 } }] };
  assert.equal(resolveScreenshotImageReferences(reference, newer).data.tiles[0].screenshot.timestamp, 3000);
  const invalid = { tiles: [{ ...reference.tiles[0], screenshot: { ...reference.tiles[0].screenshot, timestamp: undefined } }] };
  assert.deepEqual(resolveScreenshotImageReferences(invalid, previous).missingStudentIds, ['s1']);
});

test('genuine nulls and full screenshots retain their ordinary behavior', () => {
  assert.equal(resolveScreenshotImageReferences(previous, undefined).data, previous);
  const cleared = { tiles: [{ studentId: 's1', screenshot: null }] };
  assert.equal(resolveScreenshotImageReferences(cleared, previous).data, cleared);
});

const request = { kind: 'screenshots', endpoint: '/classpilot/tiles/screenshots', body: { studentIds: ['s1'] } };
test('tile reads advertise cached identities and reconstruct ordinary screenshot results', async () => {
  const calls = [];
  const result = await fetchTileBatch(request, async (_method, _path, body) => {
    calls.push(body);
    return reference;
  }, undefined, { getCachedData: () => previous });
  assert.deepEqual(calls[0].knownImageIds, { s1: { imageId: id, bindingVersion: 'v2:class-a' } });
  assert.equal(result.tiles[0].screenshot.screenshot, previous.tiles[0].screenshot.screenshot);
  assert.equal(result.tiles[0].screenshot.timestamp, 2000);
});

test('cache loss during a read recovers full pixels once without offering stale identities', async () => {
  let cache = previous;
  const calls = [];
  const result = await fetchTileBatch(request, async (_method, _path, body) => {
    calls.push(body);
    if (calls.length === 1) { cache = undefined; return reference; }
    return previous;
  }, undefined, { getCachedData: () => cache });
  assert.equal(calls.length, 2);
  assert.equal(Object.hasOwn(calls[1], 'knownImageIds'), false);
  assert.equal(result.tiles[0].screenshot.screenshot, previous.tiles[0].screenshot.screenshot);
});

test('authority loss cancels reference recovery instead of issuing another private read', async () => {
  let current = true;
  let count = 0;
  await assert.rejects(fetchTileBatch(request, async () => {
    count++; current = false; return reference;
  }, undefined, { getCachedData: () => undefined, isCurrent: () => current }), { name: 'AbortError' });
  assert.equal(count, 1);
});

test('a broken full-image recovery is bounded and retains outage semantics', async () => {
  let count = 0;
  await assert.rejects(fetchTileBatch(request, async () => { count++; return reference; }, undefined,
    { getCachedData: () => undefined }), { code: 'SCREENSHOT_IMAGE_UNAVAILABLE' });
  assert.equal(count, 2);
});
