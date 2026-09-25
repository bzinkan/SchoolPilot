import { validateMyDeskAttachment } from './myDeskModel.js';

export const IMPORT_LIMITS = { files: 5, bytes: 10 * 1024 * 1024, pages: 20, forms: 50, regions: 20 };
export function validateImportFiles(files) {
  if (!files.length) return 'Choose at least one photo or PDF.';
  if (files.length > IMPORT_LIMITS.files) return 'Choose up to 5 source files.';
  return files.map(validateMyDeskAttachment).find(Boolean) || '';
}

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
export function clipRegion(region) {
  const number = (value, fallback) => Number.isFinite(Number(value)) ? Number(value) : fallback;
  const x = clamp(number(region.x, 0), 0, .99), y = clamp(number(region.y, 0), 0, .99);
  return { ...region, x, y, width: clamp(number(region.width, .5), .01, 1 - x), height: clamp(number(region.height, .25), .01, 1 - y), rotation: [0, 90, 180, 270].includes(region.rotation) ? region.rotation : 0 };
}
// Crop coordinates belong to the rotated page. Overlays always use the original
// page coordinates so rotating a form does not move its physical selection.
export function regionOnPage(region) {
  const { x, y, width: w, height: h, rotation } = clipRegion(region);
  if (rotation === 90) return { x: y, y: 1 - x - w, width: h, height: w };
  if (rotation === 180) return { x: 1 - x - w, y: 1 - y - h, width: w, height: h };
  if (rotation === 270) return { x: 1 - y - h, y: x, width: h, height: w };
  return { x, y, width: w, height: h };
}
export function regionFromPage(box, rotation = 0, assetId) {
  const { x, y, width: w, height: h } = clipRegion(box);
  let values = { x, y, width: w, height: h };
  if (rotation === 90) values = { x: 1 - y - h, y: x, width: h, height: w };
  if (rotation === 180) values = { x: 1 - x - w, y: 1 - y - h, width: w, height: h };
  if (rotation === 270) values = { x: y, y: 1 - x - w, width: h, height: w };
  return clipRegion({ ...values, rotation, assetId });
}
export function rotateRegion(region) { return regionFromPage(regionOnPage(region), (region.rotation + 90) % 360, region.assetId); }
export function importPages(batch) {
  const assets = batch.assets || [];
  const sourceOrder = new Map(assets.filter(asset => asset.kind === 'source').map((asset, index) => [asset.id, index]));
  return assets.filter(asset => asset.kind === 'page' && asset.status === 'ready').sort((a, b) => (sourceOrder.get(a.parentAssetId) || 0) - (sourceOrder.get(b.parentAssetId) || 0) || (a.pageNumber || 0) - (b.pageNumber || 0));
}
export function importProgress(batch) {
  const items = batch.items || [], included = items.filter(item => !item.excluded), pages = importPages(batch);
  const accounted = pages.filter(page => (batch.pageDecisions || []).some(decision => decision.assetId === page.id && (decision.excluded ? !included.some(item => item.regions.some(region => region.assetId === page.id)) : included.some(item => item.regions.some(region => region.assetId === page.id))))).length;
  const reviewed = included.filter(item => item.reviewed && item.extractionStatus === 'ready' && item.approvedAssetId && item.groupId && item.studentId && item.entryDate).length;
  return { included: included.length, excluded: items.length - included.length, reviewed, pages: pages.length, accounted, ready: batch.status === 'review' && included.length > 0 && reviewed === included.length && accounted === pages.length && pages.length > 0 };
}
export function formDraft(item) { return { groupId: item.groupId || '', studentId: item.studentId || '', category: item.category || 'note', title: item.title || '', body: item.body || '', entryDate: item.entryDate || '' }; }
export function formPatch(draft, rosterRevision) { return { ...draft, groupId: draft.groupId || null, studentId: draft.studentId || null, entryDate: draft.entryDate || null, ...(rosterRevision ? { rosterRevision } : {}) }; }
export function reviewProblem(item, draft, students, rosterRevision) {
  if (item.extractionStatus !== 'ready' || !item.approvedAssetId) return 'Wait for the corrected form image before reviewing.';
  if (!draft.groupId || !draft.studentId || !rosterRevision || !students.some(student => student.id === draft.studentId)) return 'Choose the exact subject student and their current class.';
  if (!draft.entryDate) return 'Enter the form date, or explicitly choose Use today.';
  if (!draft.category) return 'Choose a category.';
  return '';
}

export function importExpiry(value) { return value ? new Date(value).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : 'after 7 days'; }
