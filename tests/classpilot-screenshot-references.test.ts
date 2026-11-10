import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseKnownScreenshotImages, knownScreenshotImageForBinding, publicScreenshotImageData } from '../src/services/classpilotScreenshotReferences.js';

const imageId = '9cb6a642-e853-44cf-bf09-33fe960c0542';
test('known images are limited to requested students and exact current binding versions', () => {
  const parsed = parseKnownScreenshotImages({ s1: { imageId, bindingVersion: 'v2:class-a' } }, ['s1']);
  assert.ok(parsed);
  assert.equal(knownScreenshotImageForBinding(parsed, 's1', 'v2:class-a'), imageId);
  assert.equal(knownScreenshotImageForBinding(parsed, 's1', 'v2:class-b'), undefined);
  assert.equal(knownScreenshotImageForBinding(parsed, 's2', 'v2:class-a'), undefined);
});
test('malformed or foreign known-image entries are refused without widening the cohort', () => {
  for (const value of [[], null, { s2: { imageId, bindingVersion: 'v2:a' } },
    { s1: { imageId: 'raw-hash', bindingVersion: 'v2:a' } },
    { s1: { imageId, bindingVersion: 'v2:a', deviceId: 'forbidden' } }]) {
    assert.equal(parseKnownScreenshotImages(value, ['s1']), null);
  }
  assert.equal(parseKnownScreenshotImages(undefined, ['s1'])?.size, 0);
});
test('public image serialization excludes transport identity and internal hashes', () => {
  const result = publicScreenshotImageData({ screenshot: 'pixels', timestamp: 1234, imageId,
    bindingVersion: 'v2:class-a', studentId: 's1', deviceId: 'secret-device',
    studentSessionId: 'private-session', contentHash: 'private-hash' });
  assert.deepEqual(result, { screenshot: 'pixels', timestamp: 1234, imageId, bindingVersion: 'v2:class-a' });
});
test('metadata-only images require a valid opaque identity and real capture timestamp', () => {
  assert.deepEqual(publicScreenshotImageData({ timestamp: 2000, imageId, unchanged: true,
    bindingVersion: 'v3:supervision' }), { timestamp: 2000, imageId, unchanged: true, bindingVersion: 'v3:supervision' });
  assert.equal(publicScreenshotImageData({ timestamp: 2000, unchanged: true }), null);
  assert.equal(publicScreenshotImageData({ timestamp: NaN, imageId, unchanged: true }), null);
});
