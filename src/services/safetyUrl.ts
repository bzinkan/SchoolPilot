import { createHash } from "node:crypto";

export const SAFETY_URL_VERSION = 1;
/** WHATWG serialization only. Queries, ordering, duplicates and fragments are evidence. */
export function canonicalSafetyUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 16384 || !/^https?:\/\//i.test(value)) return null;
  try {
    const parsed = new URL(value);
    if (!["http:", "https:"].includes(parsed.protocol) || !parsed.hostname || parsed.username || parsed.password) return null;
    return parsed.href;
  } catch { return null; }
}
export function safetyUrlFingerprint(schoolId: string, canonicalUrl: string): string {
  return createHash("sha256").update(JSON.stringify(["safety-url", SAFETY_URL_VERSION, schoolId, canonicalUrl])).digest("hex");
}
export function safetyAlertFingerprint(schoolId: string, source: string, concern: string, canonicalUrl: string | null, sourceId: string): string {
  return createHash("sha256").update(JSON.stringify(["safety-alert-v1", schoolId, source, concern, canonicalUrl ?? sourceId])).digest("hex");
}
export function websiteFromSafetyUrl(value: unknown): string | null {
  const url = canonicalSafetyUrl(value);
  return url ? new URL(url).hostname.toLowerCase() : null;
}
