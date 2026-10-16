// Client-side preparation of a teacher's own dashboard background. The browser
// downsizes before upload so a phone photo never hits the server cap; the
// server re-encodes again and strips metadata regardless.

export const BACKGROUND_MAX_EDGE = 2560;
export const BACKGROUND_UPLOAD_MAX_BYTES = 6 * 1024 * 1024;
export const BACKGROUND_INPUT_TYPES = ['image/png', 'image/jpeg', 'image/webp'];

export async function sha256Hex(arrayBuffer) {
  const digest = await crypto.subtle.digest('SHA-256', arrayBuffer);
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

function canvasToBlob(canvas, type, quality) {
  if (typeof canvas.convertToBlob === 'function') return canvas.convertToBlob({ type, quality });
  return new Promise((resolve, reject) => canvas.toBlob(blob => (blob ? resolve(blob) : reject(new Error('encode_failed'))), type, quality));
}

// Returns { blob, contentType, width, height }. Prefers WebP, falls back to JPEG.
export async function prepareBackgroundImage(file, { maxEdge = BACKGROUND_MAX_EDGE, quality = 0.85 } = {}) {
  if (!BACKGROUND_INPUT_TYPES.includes(file.type)) throw new Error('unsupported_type');
  const bitmap = await createImageBitmap(file);
  try {
    const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = typeof OffscreenCanvas === 'function' ? new OffscreenCanvas(width, height) : Object.assign(document.createElement('canvas'), { width, height });
    const context = canvas.getContext('2d');
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, width, height);
    context.drawImage(bitmap, 0, 0, width, height);
    let blob = await canvasToBlob(canvas, 'image/webp', quality);
    if (blob.type !== 'image/webp') blob = await canvasToBlob(canvas, 'image/jpeg', quality);
    if (blob.size > BACKGROUND_UPLOAD_MAX_BYTES) throw new Error('too_large');
    return { blob, contentType: blob.type, width, height };
  } finally {
    bitmap.close?.();
  }
}
