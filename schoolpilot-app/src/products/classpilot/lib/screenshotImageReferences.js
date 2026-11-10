// Pixel reuse is scoped by the existing query cache and exact server authority.
// There is deliberately no additional global/persistent image cache here.
const IMAGE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const BINDING = /^v\d+:/;

function reusableTile(tile) {
  const image = tile?.screenshot;
  return typeof tile?.studentId === 'string'
    && typeof image?.screenshot === 'string' && image.screenshot.length > 0
    && IMAGE_ID.test(image.imageId || '')
    && typeof tile.bindingVersion === 'string' && BINDING.test(tile.bindingVersion)
    && image.bindingVersion === tile.bindingVersion;
}

export function knownScreenshotImageIds(data, studentIds) {
  const allowed = new Set((studentIds || []).slice(0, 50));
  return Object.fromEntries((data?.tiles || []).filter(tile => allowed.has(tile?.studentId) && reusableTile(tile))
    .map(tile => [tile.studentId, { imageId: tile.screenshot.imageId, bindingVersion: tile.bindingVersion }]));
}

export function resolveScreenshotImageReferences(data, previous) {
  if (!Array.isArray(data?.tiles)) return { data, missingStudentIds: [] };
  const cached = new Map((previous?.tiles || []).filter(reusableTile).map(tile => [tile.studentId, tile]));
  const missingStudentIds = [];
  let changed = false;
  const tiles = data.tiles.map(tile => {
    const image = tile?.screenshot;
    if (image?.unchanged !== true) return tile;
    changed = true;
    const prior = cached.get(tile.studentId);
    if (!prior || !IMAGE_ID.test(image.imageId || '') || prior.screenshot.imageId !== image.imageId
      || tile.bindingVersion !== prior.bindingVersion || image.bindingVersion !== tile.bindingVersion
      || !Number.isFinite(image.timestamp) || image.timestamp <= 0) {
      missingStudentIds.push(tile.studentId);
      return { ...tile, screenshot: null };
    }
    if (prior.screenshot.timestamp > image.timestamp) return prior;
    const { unchanged: _unchanged, ...metadata } = image;
    return { ...tile, screenshot: { ...metadata, screenshot: prior.screenshot.screenshot } };
  });
  return { data: changed ? { ...data, tiles } : data, missingStudentIds };
}
