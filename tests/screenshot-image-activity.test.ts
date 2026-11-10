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
    referenceMisses: 1, metadataOnlyReads: 3, deltaUploads: 0, deltaUploadBytes: 0, deltaMaterializedBytes: 0,
    deltaBaseReadBytes: 0, deltaMisses: 0, deltaReads: 0, deltaReadBytes: 0 });
  assert.deepEqual(activity.flush(), { fullUploads: 0, fullUploadBytes: 0, referenceUploads: 0,
    referenceMisses: 0, metadataOnlyReads: 0, deltaUploads: 0, deltaUploadBytes: 0, deltaMaterializedBytes: 0,
    deltaBaseReadBytes: 0, deltaMisses: 0, deltaReads: 0, deltaReadBytes: 0 });
});
test('delta accounting keeps upload, materialized cache, base read and teacher patch bytes separate', () => {
  const activity = new ScreenshotImageActivity();
  activity.record('delta_upload', 1000, 20000);
  activity.record('delta_upload', 1500, 22000);
  activity.record('delta_base_read', 19000);
  activity.record('delta_base_read', 21000);
  activity.record('delta_miss');
  activity.record('delta_read', 1000);
  assert.deepEqual(activity.flush(), { fullUploads: 0, fullUploadBytes: 0, referenceUploads: 0, referenceMisses: 0,
    metadataOnlyReads: 0, deltaUploads: 2, deltaUploadBytes: 2500, deltaMaterializedBytes: 42000,
    deltaBaseReadBytes: 40000, deltaMisses: 1, deltaReads: 1, deltaReadBytes: 1000 });
});
