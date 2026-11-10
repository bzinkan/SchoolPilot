import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ScreenshotImageActivity } from '../src/realtime/screenshotImageActivity.js';
test('image accounting measures real full/reference outcomes without identities or unbounded samples', () => {
  const activity = new ScreenshotImageActivity();
  activity.record('full', 10000);
  activity.record('full', 20000);
  activity.record('reference');
  activity.record('reference');
  activity.record('miss');
  activity.record('metadata_read', 3);
  assert.deepEqual(activity.flush(), { fullUploads: 2, fullUploadBytes: 30000, referenceUploads: 2,
    referenceMisses: 1, metadataOnlyReads: 3 });
  assert.deepEqual(activity.flush(), { fullUploads: 0, fullUploadBytes: 0, referenceUploads: 0,
    referenceMisses: 0, metadataOnlyReads: 0 });
});
