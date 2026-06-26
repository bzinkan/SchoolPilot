import { createClient, type RedisClientType } from "redis";
import type { NormalizedMonitorEvent } from "./errorMonitor.js";

const MONITOR_BUCKET_TTL_SECONDS = 7 * 60;

export type MonitorAggregationStatus = {
  mode: "redis" | "local";
  ok: boolean;
  degradedReason?: string;
};

export type MonitorAggregationAdapter = {
  recordEvent(
    event: NormalizedMonitorEvent,
    bucketMs: number,
    windowMs: number
  ): Promise<number | null>;
  tryAcquireAlert(fingerprint: string, ttlMs: number): Promise<boolean | null>;
  setCooldown(fingerprint: string, ttlMs: number): Promise<void>;
  getStatus(): MonitorAggregationStatus;
  checkStatus(timeoutMs?: number): Promise<MonitorAggregationStatus>;
  resetForTests?(): void;
  dispose?(): Promise<void>;
};

function safeRedisPart(value: string): string {
  return value.replace(/[^a-zA-Z0-9:_-]/g, "_");
}

function safeRedisError(value: unknown): string {
  const raw = value instanceof Error ? value.message : String(value);
  const sanitized = raw
    .replace(/\brediss?:\/\/[^\s]+/gi, "[redis-url]")
    .replace(/\/\/[^/\s@]+@/g, "//[redacted]@")
    .replace(/([?&](?:token|password|passwd|pwd|secret|api[_-]?key)=)[^&\s]+/gi, "$1[redacted]");
  return sanitized.length > 180 ? `${sanitized.slice(0, 177)}...` : sanitized;
}

export class RedisMonitorAggregationAdapter implements MonitorAggregationAdapter {
  private client: RedisClientType | null = null;
  private connectPromise: Promise<void> | null = null;
  private lastError: string | undefined;

  constructor(
    private readonly redisUrl: string,
    private readonly redisPrefix = process.env.REDIS_PREFIX ?? "schoolpilot"
  ) {}

  async recordEvent(
    event: NormalizedMonitorEvent,
    bucketMs: number,
    windowMs: number
  ): Promise<number | null> {
    const client = await this.getClient();
    if (!client) return null;

    try {
      const bucket = Math.floor(event.timestamp / bucketMs) * bucketMs;
      const bucketKey = this.bucketKey(event.fingerprint, bucket);
      await client.multi().incr(bucketKey).expire(bucketKey, MONITOR_BUCKET_TTL_SECONDS).exec();

      const firstBucket = Math.floor((event.timestamp - windowMs) / bucketMs) * bucketMs;
      const keys: string[] = [];
      for (let ts = firstBucket; ts <= bucket; ts += bucketMs) {
        keys.push(this.bucketKey(event.fingerprint, ts));
      }
      const values = keys.length > 0 ? await client.mGet(keys) : [];
      this.lastError = undefined;
      return values.reduce((sum, raw) => sum + (raw ? Number.parseInt(raw, 10) || 0 : 0), 0);
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      return null;
    }
  }

  async tryAcquireAlert(fingerprint: string, ttlMs: number): Promise<boolean | null> {
    const client = await this.getClient();
    if (!client) return null;

    try {
      const result = await client.set(this.cooldownKey(fingerprint), String(Date.now()), {
        NX: true,
        PX: ttlMs,
      });
      this.lastError = undefined;
      return result === "OK";
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      return null;
    }
  }

  async setCooldown(fingerprint: string, ttlMs: number): Promise<void> {
    const client = await this.getClient();
    if (!client) return;

    try {
      await client.set(this.cooldownKey(fingerprint), String(Date.now()), { PX: ttlMs });
      this.lastError = undefined;
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
    }
  }

  getStatus(): MonitorAggregationStatus {
    if (this.client?.isReady && !this.lastError) {
      return { mode: "redis", ok: true };
    }
    return {
      mode: "local",
      ok: false,
      degradedReason: this.lastError ?? "Redis aggregation is not connected",
    };
  }

  async checkStatus(timeoutMs = 1000): Promise<MonitorAggregationStatus> {
    const client = await this.getClient(timeoutMs);
    if (client?.isReady && !this.lastError) {
      return { mode: "redis", ok: true };
    }
    return this.getStatus();
  }

  resetForTests(): void {
    this.lastError = undefined;
    void this.dispose();
  }

  async dispose(): Promise<void> {
    const client = this.client;
    this.client = null;
    this.connectPromise = null;
    if (!client) return;
    try {
      if (client.isOpen) await client.quit();
    } catch {
      try {
        await client.disconnect();
      } catch {
        // Ignore cleanup failures; this is best-effort handle cleanup.
      }
    }
  }

  private async getClient(timeoutMs = 2500): Promise<RedisClientType | null> {
    if (this.client?.isReady) return this.client;
    if (this.connectPromise) {
      try {
        await this.withTimeout(this.connectPromise, timeoutMs);
      } catch (err) {
        this.lastError = safeRedisError(err);
        return null;
      }
      return this.client?.isReady ? this.client : null;
    }

    this.connectPromise = (async () => {
      try {
        this.client = createClient({
          url: this.redisUrl,
          socket: { connectTimeout: timeoutMs, reconnectStrategy: false },
        });
        this.client.on("error", (err) => {
          this.lastError = safeRedisError(err);
        });
        await this.withTimeout(this.client.connect(), timeoutMs);
        this.lastError = undefined;
      } catch (err) {
        this.lastError = safeRedisError(err);
        const client = this.client;
        this.client = null;
        if (client?.isOpen) {
          try {
            await client.disconnect();
          } catch {
            // Ignore failed cleanup after a failed connection attempt.
          }
        }
      } finally {
        this.connectPromise = null;
      }
    })();

    await this.connectPromise;
    return this.client?.isReady ? this.client : null;
  }

  private async withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<T>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error("redis aggregation connect timeout")), timeoutMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private bucketKey(fingerprint: string, bucket: number): string {
    return `${this.redisPrefix}:monitor:fp:${safeRedisPart(fingerprint)}:bucket:${bucket}`;
  }

  private cooldownKey(fingerprint: string): string {
    return `${this.redisPrefix}:monitor:cooldown:${safeRedisPart(fingerprint)}`;
  }
}

export function createDefaultMonitorAggregation(): MonitorAggregationAdapter | undefined {
  if (!process.env.REDIS_URL) return undefined;
  return new RedisMonitorAggregationAdapter(process.env.REDIS_URL);
}
