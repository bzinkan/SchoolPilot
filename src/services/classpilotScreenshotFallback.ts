import type {
  ClassBoundScreenshotBinding,
  ScreenshotBinding,
  ScreenshotData,
} from "../realtime/ws-redis.js";
import {
  classBoundScreenshotBindingCacheKey,
  screenshotBindingCacheKey,
} from "../realtime/ws-redis.js";

export const CLASSPILOT_SCREENSHOT_FALLBACK_MAX_BYTES = 64 * 1024 * 1024;
export const CLASSPILOT_SCREENSHOT_FALLBACK_TTL_MS = 120_000;
const MAX_ENTRIES = 4_096;

type Entry = {
  value: ScreenshotData;
  bytes: number;
  expiresAt: number;
};

function estimateBytes(key: string, value: ScreenshotData): number {
  return Buffer.byteLength(key, "utf8")
    + Buffer.byteLength(value.screenshot, "utf8")
    + Buffer.byteLength(JSON.stringify({
      timestamp: value.timestamp,
      capturedAt: value.capturedAt,
      tabTitle: value.tabTitle,
      tabUrl: value.tabUrl,
      tabFavicon: value.tabFavicon,
      schoolId: value.schoolId,
      deviceId: value.deviceId,
      studentId: value.studentId,
      studentSessionId: value.studentSessionId,
      teachingSessionId: value.teachingSessionId,
      controlRevision: value.controlRevision,
      bindingVersion: value.bindingVersion,
    }), "utf8");
}

/**
 * Byte- and entry-bounded last-resort storage used only when Redis screenshot
 * persistence is unavailable. It is never consulted without an already
 * authorized exact binding and is not an authorization source.
 */
export class ClasspilotScreenshotFallbackStore {
  private readonly entries = new Map<string, Entry>();
  private totalBytes = 0;

  constructor(
    private readonly maxBytes = CLASSPILOT_SCREENSHOT_FALLBACK_MAX_BYTES,
    private readonly ttlMs = CLASSPILOT_SCREENSHOT_FALLBACK_TTL_MS,
    private readonly maxEntries = MAX_ENTRIES,
    private readonly now: () => number = Date.now
  ) {}

  set(binding: ScreenshotBinding, value: ScreenshotData): boolean {
    return this.setForKey(screenshotBindingCacheKey(binding), value);
  }

  setClassBound(binding: ClassBoundScreenshotBinding, value: ScreenshotData): boolean {
    return this.setForKey(classBoundScreenshotBindingCacheKey(binding), value);
  }

  private setForKey(key: string, value: ScreenshotData): boolean {
    const bytes = estimateBytes(key, value);
    const now = this.now();
    const capturedExpiresAt = Number.isFinite(value.timestamp)
      ? value.timestamp + this.ttlMs
      : Number.NEGATIVE_INFINITY;
    if (bytes > this.maxBytes || capturedExpiresAt <= now) return false;

    const previous = this.entries.get(key);
    if (previous) {
      this.entries.delete(key);
      this.totalBytes -= previous.bytes;
    }
    this.pruneExpired();
    while (
      this.entries.size >= this.maxEntries
      || this.totalBytes + bytes > this.maxBytes
    ) {
      const oldestKey = this.entries.keys().next().value as string | undefined;
      if (!oldestKey) break;
      this.delete(oldestKey);
    }
    this.entries.set(key, {
      value,
      bytes,
      // Never extend an artifact beyond its capture-time freshness window just
      // because Redis failed and the API stored it in the local fallback later.
      expiresAt: Math.min(now + this.ttlMs, capturedExpiresAt),
    });
    this.totalBytes += bytes;
    return true;
  }

  get(binding: ScreenshotBinding): ScreenshotData | null {
    return this.getForKey(screenshotBindingCacheKey(binding));
  }

  getClassBound(binding: ClassBoundScreenshotBinding): ScreenshotData | null {
    return this.getForKey(classBoundScreenshotBindingCacheKey(binding));
  }

  private getForKey(key: string): ScreenshotData | null {
    const entry = this.entries.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= this.now()) {
      this.delete(key);
      return null;
    }
    // Refresh insertion order for an inexpensive LRU policy without extending
    // the evidence freshness/TTL boundary.
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }

  stats(): { entries: number; bytes: number; maxBytes: number } {
    this.pruneExpired();
    return { entries: this.entries.size, bytes: this.totalBytes, maxBytes: this.maxBytes };
  }

  clear(): void {
    this.entries.clear();
    this.totalBytes = 0;
  }

  private pruneExpired(): void {
    const now = this.now();
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= now) this.delete(key);
    }
  }

  private delete(key: string): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    this.entries.delete(key);
    this.totalBytes = Math.max(0, this.totalBytes - entry.bytes);
  }
}

export const classpilotScreenshotFallback = new ClasspilotScreenshotFallbackStore();
