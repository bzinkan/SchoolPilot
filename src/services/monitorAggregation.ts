import { createClient } from "redis";
import type { NormalizedMonitorEvent } from "./errorMonitor.js";

const MONITOR_BUCKET_TTL_SECONDS = 7 * 60;
const MONITOR_REDIS_INITIALIZATION_SHUTDOWN_GRACE_MS = 500;
const MONITOR_REDIS_DISCONNECT_GRACE_MS = 250;
type MonitorRedisClient = ReturnType<typeof createClient>;

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

async function settlesWithin(
  operation: Promise<unknown>,
  timeoutMs: number
): Promise<boolean> {
  if (timeoutMs <= 0) return false;
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation.then(() => true, () => false),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function closeMonitorRedisClient(
  client: MonitorRedisClient | null
): Promise<void> {
  if (!client) return;
  // Terminal one-off teardown must destroy the socket directly. node-redis
  // marks a client closed before QUIT receives a response, so a timed-out
  // QUIT can leave a live socket that disconnect() then refuses to destroy.
  await settlesWithin(
    Promise.resolve().then(() => client.disconnect()),
    MONITOR_REDIS_DISCONNECT_GRACE_MS
  );
}

export class RedisMonitorAggregationAdapter implements MonitorAggregationAdapter {
  private client: MonitorRedisClient | null = null;
  private connectPromise: Promise<void> | null = null;
  private lastError: string | undefined;
  private generation = 0;
  private disposed = false;
  private disposePromise: Promise<void> | null = null;

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
    if (this.disposed) {
      return {
        mode: "local",
        ok: false,
        degradedReason: "Redis aggregation is disposed",
      };
    }
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
    this.generation += 1;
    const client = this.client;
    this.client = null;
    this.connectPromise = null;
    void closeMonitorRedisClient(client);
  }

  dispose(): Promise<void> {
    if (this.disposePromise) return this.disposePromise;
    this.disposed = true;
    this.generation += 1;
    const initialization = this.connectPromise;
    this.disposePromise = (async () => {
      if (initialization) {
        await settlesWithin(
          initialization,
          MONITOR_REDIS_INITIALIZATION_SHUTDOWN_GRACE_MS
        );
      }
      const client = this.client;
      if (this.client === client) this.client = null;
      this.connectPromise = null;
      await closeMonitorRedisClient(client);
    })();
    return this.disposePromise;
  }

  private async getClient(timeoutMs = 2500): Promise<MonitorRedisClient | null> {
    if (this.disposed) return null;
    if (this.client?.isReady) return this.client;
    if (this.connectPromise) {
      try {
        await this.withTimeout(this.connectPromise, timeoutMs);
      } catch (err) {
        this.lastError = safeRedisError(err);
        return null;
      }
      return !this.disposed && this.client?.isReady ? this.client : null;
    }

    const generation = this.generation;
    const client = createClient({
      url: this.redisUrl,
      socket: { connectTimeout: timeoutMs, reconnectStrategy: false },
    });
    this.client = client;
    client.on("error", (err) => {
      if (!this.disposed && generation === this.generation) {
        this.lastError = safeRedisError(err);
      }
    });
    let connection!: Promise<void>;
    connection = (async () => {
      try {
        await this.withTimeout(client.connect(), timeoutMs);
        if (this.disposed || generation !== this.generation) {
          await closeMonitorRedisClient(client);
          if (this.client === client) this.client = null;
          return;
        }
        this.lastError = undefined;
      } catch (err) {
        if (!this.disposed && generation === this.generation) {
          this.lastError = safeRedisError(err);
        }
        await closeMonitorRedisClient(client);
        if (this.client === client) this.client = null;
      } finally {
        if (this.connectPromise === connection) this.connectPromise = null;
      }
    })();
    this.connectPromise = connection;

    await connection;
    return !this.disposed && this.client === client && client.isReady
      ? client
      : null;
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
