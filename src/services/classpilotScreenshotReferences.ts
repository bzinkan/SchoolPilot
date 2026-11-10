const IMAGE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
type KnownImage = { imageId: string; bindingVersion: string };
export type KnownScreenshotImages = ReadonlyMap<string, KnownImage>;

export function parseKnownScreenshotImages(value: unknown, studentIds: readonly string[]): KnownScreenshotImages | null {
  if (value === undefined) return new Map();
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const entries = Object.entries(value);
  if (entries.length > 50) return null;
  const allowed = new Set(studentIds);
  const result = new Map<string, KnownImage>();
  for (const [studentId, raw] of entries) {
    if (!allowed.has(studentId) || !raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const entry = raw as Record<string, unknown>;
    if (Object.keys(entry).some(key => key !== 'imageId' && key !== 'bindingVersion')
      || typeof entry.imageId !== 'string' || !IMAGE_ID.test(entry.imageId)
      || typeof entry.bindingVersion !== 'string' || entry.bindingVersion.length > 160
      || !/^v[23]:/.test(entry.bindingVersion)) return null;
    result.set(studentId, { imageId: entry.imageId, bindingVersion: entry.bindingVersion });
  }
  return result;
}

export function knownScreenshotImageForBinding(images: KnownScreenshotImages, studentId: string, bindingVersion: string): string | undefined {
  const known = images.get(studentId);
  return known?.bindingVersion === bindingVersion ? known.imageId : undefined;
}

export type ScreenshotPublicInput = {
  screenshot?: string; timestamp: number; bindingVersion?: string; imageId?: string; unchanged?: boolean;
  tabTitle?: string; tabUrl?: string; tabFavicon?: string;
};
/** Explicit allowlist: student/session/device identities and image hashes never leave storage. */
export function publicScreenshotImageData(data: ScreenshotPublicInput & Record<string, unknown>) {
  const imageId = typeof data.imageId === 'string' && IMAGE_ID.test(data.imageId) ? data.imageId : undefined;
  if (data.unchanged === true && (!imageId || !Number.isFinite(data.timestamp) || data.timestamp <= 0)) return null;
  return {
    ...(typeof data.screenshot === 'string' ? { screenshot: data.screenshot } : {}),
    timestamp: data.timestamp,
    ...(data.tabTitle !== undefined ? { tabTitle: data.tabTitle } : {}),
    ...(data.tabUrl !== undefined ? { tabUrl: data.tabUrl } : {}),
    ...(data.tabFavicon !== undefined ? { tabFavicon: data.tabFavicon } : {}),
    ...(/^v[23]:/.test(data.bindingVersion || '') ? { bindingVersion: data.bindingVersion } : {}),
    ...(imageId ? { imageId } : {}),
    ...(data.unchanged === true ? { unchanged: true } : {}),
  };
}
