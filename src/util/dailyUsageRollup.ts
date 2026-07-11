import { createClient } from "redis";

const DEFAULT_TIMEZONE = "America/New_York";
const ROLLUP_MINIMUM_LOCAL_HOUR = 2;
export const DAILY_USAGE_ROLLUP_MARKER_TTL_SECONDS = 72 * 60 * 60;

type ZonedDateTimeParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
};

export type DailyUsageRollupWindow = {
  date: string;
  dayStartUtc: Date;
  dayEndUtc: Date;
};

function zonedParts(date: Date, timeZone: string): ZonedDateTimeParts {
  const parts = new Intl.DateTimeFormat("en-US-u-ca-iso8601", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return {
    year: Number(values.year),
    month: Number(values.month),
    day: Number(values.day),
    hour: Number(values.hour),
    minute: Number(values.minute),
    second: Number(values.second),
  };
}

function isoDate(year: number, month: number, day: number): string {
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function previousIsoDate(value: string): string {
  const [year, month, day] = value.split("-").map(Number);
  if (!year || !month || !day) throw new Error(`Invalid ISO date: ${value}`);
  const previous = new Date(Date.UTC(year, month - 1, day - 1));
  return isoDate(previous.getUTCFullYear(), previous.getUTCMonth() + 1, previous.getUTCDate());
}

/**
 * Convert a local calendar midnight to its UTC instant without relying on the
 * host timezone. The short fixed-point iteration handles DST offset changes
 * because each pass measures how the candidate instant renders in the target
 * IANA timezone.
 */
export function zonedDayStartUtc(value: string, timeZone: string): Date {
  const [year, month, day] = value.split("-").map(Number);
  if (!year || !month || !day) throw new Error(`Invalid ISO date: ${value}`);

  const desiredWallClockMs = Date.UTC(year, month - 1, day);
  let candidateMs = desiredWallClockMs;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const actual = zonedParts(new Date(candidateMs), timeZone);
    const actualWallClockMs = Date.UTC(
      actual.year,
      actual.month - 1,
      actual.day,
      actual.hour,
      actual.minute,
      actual.second
    );
    const adjustmentMs = desiredWallClockMs - actualWallClockMs;
    candidateMs += adjustmentMs;
    if (adjustmentMs === 0) break;
  }
  return new Date(candidateMs);
}

/**
 * Return the completed local day that is eligible for rollup. Schools do not
 * scan yesterday's raw heartbeats until 02:00 local time, leaving room for
 * delayed device writes. The returned half-open UTC bounds are index-friendly.
 */
export function dailyUsageRollupWindow(
  now: Date,
  timeZone = DEFAULT_TIMEZONE,
  minimumLocalHour = ROLLUP_MINIMUM_LOCAL_HOUR
): DailyUsageRollupWindow | null {
  const localNow = zonedParts(now, timeZone);
  if (localNow.hour < minimumLocalHour) return null;

  const today = isoDate(localNow.year, localNow.month, localNow.day);
  const date = previousIsoDate(today);
  return {
    date,
    dayStartUtc: zonedDayStartUtc(date, timeZone),
    dayEndUtc: zonedDayStartUtc(today, timeZone),
  };
}

function safeMarkerPart(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 128);
}

/**
 * Shared completion markers keep multiple scheduler workers from rescanning a
 * school's completed day. Postgres advisory locks still serialize execution;
 * the marker is a cheap cross-process once-per-day fast path. A bounded local
 * fallback preserves idempotent behavior while Redis is temporarily unavailable.
 */
export class DailyUsageRollupMarkers {
  private readonly redisUrl: string | undefined;
  private readonly keyPrefix: string;
  private client: ReturnType<typeof createClient> | null = null;
  private connectPromise: Promise<ReturnType<typeof createClient> | null> | null = null;
  private retryAfter = 0;
  private warned = false;
  private readonly localExpiry = new Map<string, number>();

  constructor(
    redisUrl = process.env.REDIS_URL,
    redisPrefix = process.env.REDIS_PREFIX ?? "schoolpilot"
  ) {
    this.redisUrl = redisUrl;
    this.keyPrefix = `${redisPrefix}:scheduler:daily-usage`;
  }

  key(schoolId: string, date: string): string {
    return `${this.keyPrefix}:${safeMarkerPart(schoolId)}:${safeMarkerPart(date)}`;
  }

  private rememberLocally(key: string, nowMs: number): void {
    this.localExpiry.set(key, nowMs + DAILY_USAGE_ROLLUP_MARKER_TTL_SECONDS * 1000);
    if (this.localExpiry.size <= 10_000) return;
    for (const [candidate, expiresAt] of this.localExpiry) {
      if (expiresAt <= nowMs) this.localExpiry.delete(candidate);
    }
    while (this.localExpiry.size > 10_000) {
      const oldest = this.localExpiry.keys().next().value;
      if (typeof oldest !== "string") break;
      this.localExpiry.delete(oldest);
    }
  }

  private isLocallyComplete(key: string, nowMs: number): boolean {
    const expiresAt = this.localExpiry.get(key) ?? 0;
    if (expiresAt > nowMs) return true;
    if (expiresAt) this.localExpiry.delete(key);
    return false;
  }

  private warn(error: unknown): void {
    if (this.warned) return;
    this.warned = true;
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[ClassPilot] Redis rollup markers unavailable; using local fallback: ${message}`);
  }

  private async redis(): Promise<ReturnType<typeof createClient> | null> {
    if (!this.redisUrl) return null;
    if (this.client?.isReady) return this.client;
    if (this.client) {
      const staleClient = this.client;
      this.client = null;
      if (staleClient.isOpen) await staleClient.disconnect().catch(() => undefined);
    }
    if (Date.now() < this.retryAfter) return null;
    if (this.connectPromise) return this.connectPromise;

    this.connectPromise = (async () => {
      const client = createClient({
        url: this.redisUrl,
        socket: {
          connectTimeout: 2_500,
          reconnectStrategy: false,
        },
      });
      client.on("error", (error: unknown) => this.warn(error));
      try {
        await client.connect();
        this.client = client;
        this.warned = false;
        return client;
      } catch (error) {
        this.retryAfter = Date.now() + 60_000;
        this.warn(error);
        if (client.isOpen) await client.disconnect().catch(() => undefined);
        return null;
      } finally {
        this.connectPromise = null;
      }
    })();
    return this.connectPromise;
  }

  async isComplete(schoolId: string, date: string, nowMs = Date.now()): Promise<boolean> {
    const key = this.key(schoolId, date);
    if (this.isLocallyComplete(key, nowMs)) return true;
    const client = await this.redis();
    if (!client) return false;
    try {
      const exists = await client.exists(key);
      if (exists > 0) this.rememberLocally(key, nowMs);
      return exists > 0;
    } catch (error) {
      this.warn(error);
      return false;
    }
  }

  async markComplete(schoolId: string, date: string, nowMs = Date.now()): Promise<void> {
    const key = this.key(schoolId, date);
    this.rememberLocally(key, nowMs);
    const client = await this.redis();
    if (!client) return;
    try {
      await client.set(key, "complete", { EX: DAILY_USAGE_ROLLUP_MARKER_TTL_SECONDS });
    } catch (error) {
      this.warn(error);
    }
  }

  async close(): Promise<void> {
    const client = this.client;
    this.client = null;
    if (client?.isOpen) await client.quit().catch(() => undefined);
  }
}
