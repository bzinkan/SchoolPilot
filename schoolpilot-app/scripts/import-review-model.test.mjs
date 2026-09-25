import assert from 'node:assert/strict';
import test from 'node:test';
import { clipRegion, regionOnPage, regionFromPage, rotateRegion, importPages, importProgress, formDraft, formPatch, reviewProblem, validateImportFiles } from '../src/products/classpilot/lib/importReviewModel.js';
import { myDeskKeys, clearMyDeskQueries } from '../src/products/classpilot/lib/myDeskModel.js';
import { QueryClient } from '@tanstack/react-query';

test('rotated crops keep their physical paper bounds and clip invalid geometry', () => {
  const box = { x: .12, y: .21, width: .37, height: .22 };
  for (const rotation of [0, 90, 180, 270]) {
    const region = regionFromPage(box, rotation, 'page');
    for (const key of Object.keys(box)) assert.ok(Math.abs(regionOnPage(region)[key] - box[key]) < 1e-12);
    const rotated = rotateRegion(region);
    for (const key of Object.keys(box)) assert.ok(Math.abs(regionOnPage(rotated)[key] - box[key]) < 1e-12);
  }
  for (const input of [{ x: -4, y: 2, width: 8, height: -4 }, { x: NaN, y: Infinity, width: 'bad', height: 0 }]) {
    const result = clipRegion(input); assert.ok(result.x >= 0 && result.y >= 0 && result.width > 0 && result.height > 0); assert.ok(result.x + result.width <= 1 && result.y + result.height <= 1);
  }
});
test('every rendered page and included form must be explicitly checked', () => {
  const item = { id: 'a', groupId: 'class', studentId: 'subject', entryDate: '2026-09-25', reviewed: true, extractionStatus: 'ready', approvedAssetId: 'crop', regions: [{ assetId: 'p1' }] };
  const batch = { status: 'review', assets: ['p1', 'p2'].map(id => ({ id, kind: 'page', status: 'ready' })), items: [item], pageDecisions: [{ assetId: 'p1', excluded: false }] };
  assert.equal(importProgress(batch).ready, false);
  batch.pageDecisions.push({ assetId: 'p2', excluded: true }); assert.equal(importProgress(batch).ready, true);
  item.reviewed = false; assert.equal(importProgress(batch).ready, false);
  item.reviewed = true; item.regions.push({ assetId: 'p2' }); assert.equal(importProgress(batch).ready, false);
});
test('page numbering follows each source page order even when asset IDs arrive out of order', () => {
  const batch = { assets: [{ id: 's1', kind: 'source' }, { id: 's2', kind: 'source' }, { id: 'p2', kind: 'page', status: 'ready', parentAssetId: 's1', pageNumber: 2 }, { id: 'p3', kind: 'page', status: 'ready', parentAssetId: 's2', pageNumber: 1 }, { id: 'p1', kind: 'page', status: 'ready', parentAssetId: 's1', pageNumber: 1 }] };
  assert.deepEqual(importPages(batch).map(page => page.id), ['p1', 'p2', 'p3']);
});
test('unknown date and identity stay unresolved; only a current exact subject can be reviewed', () => {
  const item = { extractionStatus: 'ready', approvedAssetId: 'crop', subjectNames: ['Witness Student'] };
  const draft = formDraft(item); assert.equal(draft.entryDate, ''); assert.equal(draft.studentId, ''); assert.equal(formPatch(draft).entryDate, null);
  assert.match(reviewProblem(item, draft, [], 'hash'), /exact subject/);
  Object.assign(draft, { groupId: 'class', studentId: 'subject' }); assert.match(reviewProblem(item, draft, [{ id: 'subject' }], 'hash'), /date/);
  draft.entryDate = '2026-09-25'; assert.equal(reviewProblem(item, draft, [{ id: 'subject' }], 'hash'), '');
});
test('source limits and private import caches match existing identity cleanup', () => {
  assert.match(validateImportFiles(Array.from({ length: 6 }, () => ({ type: 'image/png', size: 10 }))), /5/);
  assert.match(validateImportFiles([{ type: 'application/pdf', size: 10485761 }]), /10 MiB/);
  assert.notDeepEqual(myDeskKeys.import('school', 'a', 'run'), myDeskKeys.import('school', 'b', 'run'));
  const client = new QueryClient(); client.setQueryData(myDeskKeys.importAsset('school', 'a', 'run', 'page'), new Blob(['private'])); clearMyDeskQueries(client); assert.equal(client.getQueryCache().getAll().length, 0);
});
