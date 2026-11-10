import { applyScreenshotDelta, MAX_SCREENSHOT_DELTA_BYTES, SCREENSHOT_DELTA_CODEC } from './screenshotDeltaCodec.js';
import { knownScreenshotImageIds } from './screenshotImageReferences.js';

const JPEG = 'data:image/jpeg;base64,';
const IMAGE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HASH = /^[0-9a-f]{64}$/;
const DISPLAY_DOMAIN = 'classpilot:screenshot-delta-display:v1\0';
const DELTA_FIELDS = ['codec', 'baseImageId', 'data', 'targetBytes', 'integrityTag'];

export function canDecodeScreenshotDeltas() {
  return typeof globalThis.crypto?.subtle?.digest === 'function' && typeof TextEncoder === 'function';
}
function fromBase64(value) {
  if (typeof value !== 'string' || !value || value.length > Math.ceil(MAX_SCREENSHOT_DELTA_BYTES / 3) * 4
    || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) throw new TypeError('Invalid image encoding');
  const raw = atob(value);
  if (raw.length > MAX_SCREENSHOT_DELTA_BYTES || btoa(raw) !== value) throw new TypeError('Invalid image encoding');
  const bytes = new Uint8Array(raw.length);
  for (let index = 0; index < raw.length; index++) bytes[index] = raw.charCodeAt(index);
  return bytes;
}
function toDataUrl(bytes) {
  let raw = '';
  for (let start = 0; start < bytes.length; start += 16_384) raw += String.fromCharCode(...bytes.subarray(start, start + 16_384));
  return JPEG + btoa(raw);
}
function reusable(data, studentIds) {
  const known = knownScreenshotImageIds(data, studentIds);
  return new Map((data?.tiles || []).filter(tile => Object.hasOwn(known, tile.studentId)).map(tile => [tile.studentId, tile]));
}

/** Only stack-local buffers and the current exact query cache hold pixel bases. */
export async function resolveScreenshotImageDeltas(data, previous, { isCurrent, signal, getCachedData,
  digest = bytes => globalThis.crypto.subtle.digest('SHA-256', bytes) } = {}) {
  if (!Array.isArray(data?.tiles) || !data.tiles.some(tile => tile?.screenshot?.delta !== undefined)) return { data, missingStudentIds: [] };
  const check = () => { if (signal?.aborted || isCurrent?.() === false) throw new DOMException('Preview context changed', 'AbortError'); };
  const studentIds = data.tiles.map(tile => tile?.studentId);
  const currentCache = () => reusable(getCachedData ? getCachedData() : previous, studentIds);
  const missing = new Set();
  const tiles = [];
  for (const tile of data.tiles) {
    const image = tile?.screenshot;
    if (image?.delta === undefined) { tiles.push(tile); continue; }
    try {
      check();
      const prior = currentCache().get(tile.studentId);
      const delta = image.delta;
      if (!prior || tile.bindingVersion !== prior.bindingVersion || image.bindingVersion !== tile.bindingVersion
        || !IMAGE_ID.test(image.imageId || '') || !Number.isFinite(image.timestamp) || image.timestamp <= 0
        || !delta || typeof delta !== 'object' || Array.isArray(delta)
        || Object.keys(delta).some(key => !DELTA_FIELDS.includes(key))
        || delta.codec !== SCREENSHOT_DELTA_CODEC || !HASH.test(delta.integrityTag || '')
        || !Number.isInteger(delta.targetBytes) || delta.targetBytes < 1 || delta.targetBytes > MAX_SCREENSHOT_DELTA_BYTES
        || image.unchanged === true || typeof image.screenshot === 'string') throw new TypeError('Invalid image delta');
      if (prior.screenshot.timestamp > image.timestamp) { tiles.push(prior); continue; }
      if (delta.baseImageId !== prior.screenshot.imageId || !prior.screenshot.screenshot.startsWith(JPEG)) throw new TypeError('Missing image base');
      const base = fromBase64(prior.screenshot.screenshot.slice(JPEG.length));
      const target = applyScreenshotDelta(base, fromBase64(delta.data));
      if (target.length !== delta.targetBytes || target[0] !== 255 || target[1] !== 216 || target[2] !== 255) throw new TypeError('Invalid target image');
      const prefix = new TextEncoder().encode(DISPLAY_DOMAIN + image.imageId + '\0');
      const verified = new Uint8Array(prefix.length + target.length); verified.set(prefix); verified.set(target, prefix.length);
      const hash = new Uint8Array(await digest(verified));
      check();
      const hex = [...hash].map(byte => byte.toString(16).padStart(2, '0')).join('');
      if (hex !== delta.integrityTag) throw new TypeError('Image integrity mismatch');
      const latest = currentCache().get(tile.studentId);
      if (!latest || latest.bindingVersion !== tile.bindingVersion) throw new TypeError('Image base expired');
      if (latest.screenshot.timestamp > image.timestamp) { tiles.push(latest); continue; }
      if (latest.screenshot.imageId !== delta.baseImageId) throw new TypeError('Image base replaced');
      const { delta: _delta, ...metadata } = image;
      tiles.push({ ...tile, screenshot: { ...metadata, screenshot: toDataUrl(target) } });
    } catch (error) {
      check();
      if (error?.name === 'AbortError') throw error;
      missing.add(tile.studentId); tiles.push({ ...tile, screenshot: null });
    }
  }
  return { data: { ...data, tiles }, missingStudentIds: [...missing] };
}
