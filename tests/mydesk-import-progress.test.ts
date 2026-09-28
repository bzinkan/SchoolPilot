import { test } from "node:test";
import assert from "node:assert/strict";
import { importProgress, emptyImportProgressCounts, type ProgressRun } from "../src/services/mydeskImportProgress.js";

const now = new Date("2026-09-28T12:00:00Z");
const run: ProgressRun = { status: "processing", pageCount: 15, attempts: 0, nextAttemptAt: null, lastErrorCode: null,
  expiresAt: new Date("2026-10-05T12:00:00Z"), processingVersion: 2 };
test("paperwork progress uses saved counts, allows fields early, and never enables early publication", () => {
  const progress = importProgress(run, { pagesPrepared: 15, pagesChecked: 12, formsFound: 14, formsReady: 8, formsReviewed: 3 }, now);
  assert.equal(progress.phase, "checking_forms"); assert.equal(progress.formsFound, 14); assert.equal(progress.detectionComplete, false);
  assert.deepEqual(progress.actions, { reviewFields: true, editGeometry: false, publish: false });
  assert.equal(importProgress({ ...run, processingVersion: 1 }, { ...emptyImportProgressCounts, formsReady: 1 }, now).actions.reviewFields, false);
});
test("queued retries, permanent failures, empty pages and expiry are not reported as ready", () => {
  const retry = importProgress({ ...run, status: "queued", nextAttemptAt: new Date(now.getTime() + 60_000) }, emptyImportProgressCounts, now);
  assert.equal(retry.phase, "retrying"); assert.ok(retry.retryAt); assert.equal(retry.actions.publish, false);
  const failed = importProgress({ ...run, status: "failed", attempts: 3 }, emptyImportProgressCounts, now);
  assert.equal(failed.phase, "needs_attention"); assert.equal(failed.canRetry, false);
  assert.equal(importProgress({ ...run, expiresAt: now }, emptyImportProgressCounts, now).phase, "expired");
  assert.equal(importProgress({ ...run, status: "review", pageCount: 0 }, emptyImportProgressCounts, now).actions.publish, false);
});
