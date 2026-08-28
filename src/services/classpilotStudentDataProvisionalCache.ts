import { createHash, randomUUID } from "node:crypto";
import { redisCommand } from "../middleware/rateLimiter.js";

export const CLASSPILOT_STUDENT_DATA_CACHE_BUCKET_MS = 30_000;
export const CLASSPILOT_STUDENT_DATA_CACHE_MAX_TTL_SECONDS = 90;
const LOCAL_CACHE_MAX_ENTRIES = 256;
const LOCAL_CACHE_MAX_BYTES = 16 * 1024 * 1024;
const CACHE_MAX_ROWS = 5_000;
const CACHE_MAX_BYTES = 2 * 1024 * 1024;
const REDIS_READY_TIMEOUT_MS = 100;
const REDIS_COMMAND_TIMEOUT_MS = 250;

export type ClasspilotStudentDataCachedRow = {
  teachingSessionId: string;
  studentId: string;
  localDate: string;
  totalSeconds: number;
  heartbeatCount: number;
  topDomains: unknown;
  computedAt: Date;
};

export type ClasspilotStudentDataCacheBinding = {
  schemaVersion: 1;
  schoolId: string;
  teachingSessionId: string;
  groupId: string;
  state: "live" | "finalizing";
  reportId: string | null;
  reportState: string | null;
  reportVersion: number;
  windowStart: string;
  windowEnd: string;
  snapshotBucket: string;
  timezone: string;
  trackingPolicyHash: string;
  contextHash: string;
};

export type ClasspilotStudentDataCachedComputation = {
  rows: ClasspilotStudentDataCachedRow[];
  asOf: Date;
};

type RedisCommand = (args: string[]) => Promise<unknown | undefined>;

type EncodedCacheValue = {
  schemaVersion: 1;
  bindingDigest: string;
  schoolId: string;
  teachingSessionId: string;
  groupId: string;
  asOf: string;
  rows: Array<Omit<ClasspilotStudentDataCachedRow, "computedAt"> & { computedAt: string }>;
};

function cacheDigest(binding: ClasspilotStudentDataCacheBinding): string {
  return createHash("sha256").update(JSON.stringify(binding)).digest("base64url");
}

function redisKey(digest: string): string {
  const prefix = process.env.REDIS_PREFIX ?? "schoolpilot";
  return `${prefix}:classpilot:student-data-provisional:v1:${digest}`;
}

function finiteNonnegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function decodedDomains(value: unknown, totalSeconds: number): unknown[] | undefined {
  if (!Array.isArray(value) || value.length > 10) return undefined;
  let sum = 0;
  const domains: unknown[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return undefined;
    const record = item as Record<string, unknown>;
    if (
      typeof record.domain !== "string"
      || record.domain.length === 0
      || record.domain.length > 253
      || record.domain !== record.domain.trim().toLowerCase()
      || record.domain.includes("/")
      || record.domain.includes(":")
      || !finiteNonnegativeInteger(record.seconds)
      || record.seconds > totalSeconds
      || (record.visits !== undefined && !finiteNonnegativeInteger(record.visits))
    ) return undefined;
    try {
      const parsed = new URL(`https://${record.domain}`);
      if (parsed.hostname !== record.domain) return undefined;
    } catch {
      return undefined;
    }
    sum += record.seconds;
    if (sum > totalSeconds) return undefined;
    domains.push({
      domain: record.domain,
      seconds: record.seconds,
      ...(record.visits === undefined ? {} : { visits: record.visits }),
    });
  }
  return domains;
}

function decodeValue(
  raw: unknown,
  binding: ClasspilotStudentDataCacheBinding,
  digest: string
): ClasspilotStudentDataCachedComputation | undefined {
  if (
    typeof raw !== "string"
    || raw.length === 0
    || Buffer.byteLength(raw, "utf8") > CACHE_MAX_BYTES
  ) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Partial<EncodedCacheValue>;
  if (
    record.schemaVersion !== 1
    || record.bindingDigest !== digest
    || record.schoolId !== binding.schoolId
    || record.teachingSessionId !== binding.teachingSessionId
    || record.groupId !== binding.groupId
    || typeof record.asOf !== "string"
    || !Array.isArray(record.rows)
    || record.rows.length > CACHE_MAX_ROWS
  ) return undefined;
  const asOf = new Date(record.asOf);
  if (Number.isNaN(asOf.getTime()) || asOf.toISOString() !== binding.windowEnd) return undefined;
  const rows: ClasspilotStudentDataCachedRow[] = [];
  const keys = new Set<string>();
  for (const row of record.rows) {
    if (
      !row || typeof row !== "object"
      || row.teachingSessionId !== binding.teachingSessionId
      || typeof row.studentId !== "string" || !row.studentId
      || typeof row.localDate !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(row.localDate)
      || !finiteNonnegativeInteger(row.totalSeconds)
      || !finiteNonnegativeInteger(row.heartbeatCount)
      || typeof row.computedAt !== "string"
    ) return undefined;
    const computedAt = new Date(row.computedAt);
    const topDomains = decodedDomains(row.topDomains, row.totalSeconds);
    const rowKey = `${row.teachingSessionId}\u0000${row.studentId}\u0000${row.localDate}`;
    if (
      Number.isNaN(computedAt.getTime())
      || computedAt.toISOString() !== binding.windowEnd
      || !topDomains
      || keys.has(rowKey)
    ) return undefined;
    keys.add(rowKey);
    rows.push({ ...row, topDomains, computedAt });
  }
  return { rows, asOf };
}

function encodeValue(
  binding: ClasspilotStudentDataCacheBinding,
  digest: string,
  value: ClasspilotStudentDataCachedComputation
): string | undefined {
  if (value.rows.length > CACHE_MAX_ROWS) return undefined;
  const encoded: EncodedCacheValue = {
    schemaVersion: 1,
    bindingDigest: digest,
    schoolId: binding.schoolId,
    teachingSessionId: binding.teachingSessionId,
    groupId: binding.groupId,
    asOf: value.asOf.toISOString(),
    rows: value.rows.map((row) => ({ ...row, computedAt: row.computedAt.toISOString() })),
  };
  const serialized = JSON.stringify(encoded);
  return Buffer.byteLength(serialized, "utf8") <= CACHE_MAX_BYTES ? serialized : undefined;
}

async function boundedRedisCommand(args: string[]): Promise<unknown | undefined> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REDIS_COMMAND_TIMEOUT_MS);
  timeout.unref?.();
  try {
    return await redisCommand(args, {
      readyTimeoutMs: REDIS_READY_TIMEOUT_MS,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    const timeout = setTimeout(resolve, milliseconds);
    timeout.unref?.();
  });
}

export function createClasspilotStudentDataProvisionalCache(
  command: RedisCommand = boundedRedisCommand
) {
  const local = new Map<string, {
    expiresAt: number;
    bytes: number;
    value: ClasspilotStudentDataCachedComputation;
  }>();
  const inFlight = new Map<string, Promise<ClasspilotStudentDataCachedComputation>>();
  let localBytes = 0;

  function remember(
    digest: string,
    value: ClasspilotStudentDataCachedComputation,
    ttlSeconds: number,
    bytes: number,
    now = Date.now()
  ) {
    const prior = local.get(digest);
    if (prior) localBytes -= prior.bytes;
    local.delete(digest);
    local.set(digest, { expiresAt: now + ttlSeconds * 1_000, bytes, value });
    localBytes += bytes;
    while (local.size > LOCAL_CACHE_MAX_ENTRIES || localBytes > LOCAL_CACHE_MAX_BYTES) {
      const oldest = local.keys().next().value as string | undefined;
      if (!oldest) break;
      localBytes -= local.get(oldest)?.bytes ?? 0;
      local.delete(oldest);
    }
  }

  function localHit(digest: string, now = Date.now()) {
    const entry = local.get(digest);
    if (!entry) return undefined;
    if (entry.expiresAt <= now) {
      localBytes -= entry.bytes;
      local.delete(digest);
      return undefined;
    }
    local.delete(digest);
    local.set(digest, entry);
    return entry.value;
  }

  async function readRedis(
    binding: ClasspilotStudentDataCacheBinding,
    digest: string
  ): Promise<{ value: ClasspilotStudentDataCachedComputation; bytes: number } | undefined> {
    try {
      const raw = await command(["GET", redisKey(digest)]);
      const value = decodeValue(raw, binding, digest);
      return value && typeof raw === "string"
        ? { value, bytes: Buffer.byteLength(raw, "utf8") }
        : undefined;
    } catch {
      return undefined;
    }
  }

  async function getOrCompute(options: {
    binding: ClasspilotStudentDataCacheBinding;
    ttlSeconds: number;
    compute: () => Promise<ClasspilotStudentDataCachedComputation>;
  }): Promise<ClasspilotStudentDataCachedComputation> {
    const ttlSeconds = Math.max(1, Math.min(
      CLASSPILOT_STUDENT_DATA_CACHE_MAX_TTL_SECONDS,
      Math.floor(options.ttlSeconds)
    ));
    const digest = cacheDigest(options.binding);
    const cached = localHit(digest);
    if (cached) return cached;
    const existing = inFlight.get(digest);
    if (existing) return existing;

    const pending = (async () => {
      const shared = await readRedis(options.binding, digest);
      if (shared) {
        remember(digest, shared.value, ttlSeconds, shared.bytes);
        return shared.value;
      }

      const key = redisKey(digest);
      const lockKey = `${key}:lock`;
      const lockToken = randomUUID();
      let ownsLock = false;
      let lockServiceAvailable = false;
      try {
        const lockResult = await command(["SET", lockKey, lockToken, "PX", "10000", "NX"]);
        lockServiceAvailable = lockResult !== undefined;
        ownsLock = lockResult === "OK";
      } catch {
        ownsLock = false;
      }
      if (!ownsLock && lockServiceAvailable) {
        const waitDeadline = Date.now() + 1_000;
        while (Date.now() < waitDeadline) {
          await wait(50);
          const raced = await readRedis(options.binding, digest);
          if (raced) {
            remember(digest, raced.value, ttlSeconds, raced.bytes);
            return raced.value;
          }
        }
      }

      try {
        const computed = await options.compute();
        const serialized = encodeValue(options.binding, digest, computed);
        const normalized = serialized
          ? decodeValue(serialized, options.binding, digest)
          : undefined;
        if (serialized && normalized) {
          remember(digest, normalized, ttlSeconds, Buffer.byteLength(serialized, "utf8"));
          try {
            await command(["SET", key, serialized, "EX", String(ttlSeconds)]);
          } catch {
            // The bounded process-local cache remains available when Redis is down.
          }
        }
        return computed;
      } catch (error) {
        throw error;
      } finally {
        if (ownsLock) {
          try {
            await command([
              "EVAL",
              "if redis.call('GET',KEYS[1]) == ARGV[1] then return redis.call('DEL',KEYS[1]) else return 0 end",
              "1",
              lockKey,
              lockToken,
            ]);
          } catch {
            // The ten-second lock expires automatically.
          }
        }
      }
    })();
    inFlight.set(digest, pending);
    try {
      return await pending;
    } finally {
      inFlight.delete(digest);
    }
  }

  return {
    getOrCompute,
    clearLocalForTests() {
      local.clear();
      inFlight.clear();
      localBytes = 0;
    },
  };
}

export const classpilotStudentDataProvisionalCache =
  createClasspilotStudentDataProvisionalCache();
