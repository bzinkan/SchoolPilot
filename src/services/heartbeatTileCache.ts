import type { Heartbeat } from "../schema/classpilot.js";
import { redisCommand } from "../middleware/rateLimiter.js";
import { recordHeartbeatHotPathCounter } from "./heartbeatHotPathMetrics.js";

export const HEARTBEAT_TILE_CACHE_MAX_RECORDS = 20;
export const HEARTBEAT_TILE_CACHE_DEFAULT_RECORDS = 10;
export const HEARTBEAT_TILE_CACHE_TTL_SECONDS = 15 * 60;

type RedisCommand = (args: string[]) => Promise<unknown | undefined>;
const locallyInvalidatedUntil = new Map<string, number>();
const HEARTBEAT_TILE_REDIS_TIMEOUT_MS = 250;
const HEARTBEAT_TILE_REDIS_READY_TIMEOUT_MS = 100;

async function heartbeatTileRedisCommand(
  args: string[]
): Promise<unknown | undefined> {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    HEARTBEAT_TILE_REDIS_TIMEOUT_MS
  );
  timeout.unref?.();
  try {
    return await redisCommand(args, {
      readyTimeoutMs: HEARTBEAT_TILE_REDIS_READY_TIMEOUT_MS,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}

export type HeartbeatTileCacheReadResult =
  | { status: "hit"; heartbeats: Heartbeat[] }
  | {
      status: "miss" | "unavailable" | "incomplete" | "authorization-filtered";
    };

export type HeartbeatTileCacheBatchEntry = {
  studentId: string;
  deviceId: string;
};

export type HeartbeatClassificationCachePatch = {
  schoolId: string;
  deviceId: string;
  heartbeatId: string;
  aiCategory: string | null;
  safetyAlert: string | null;
};

export type HeartbeatTileCacheWrite = Heartbeat & {
  classificationPending: boolean;
};

const WRITE_SCRIPT = `
redis.call('LPUSH', KEYS[1], ARGV[1])
redis.call('LTRIM', KEYS[1], 0, tonumber(ARGV[2]) - 1)
redis.call('EXPIRE', KEYS[1], tonumber(ARGV[3]))
return redis.call('LLEN', KEYS[1])
`;

const REPLACE_SCRIPT = `
redis.call('DEL', KEYS[1])
local rows = cjson.decode(ARGV[1])
for i = 1, #rows do
  redis.call('RPUSH', KEYS[1], cjson.encode(rows[i]))
end
if #rows > 0 then
  redis.call('EXPIRE', KEYS[1], tonumber(ARGV[2]))
end
return #rows
`;

const PATCH_SCRIPT = `
local matched = 0
for keyIndex = 1, #KEYS do
  local patches = cjson.decode(ARGV[keyIndex])
  local rows = redis.call('LRANGE', KEYS[keyIndex], 0, -1)
  for rowIndex = 1, #rows do
    local ok, row = pcall(cjson.decode, rows[rowIndex])
    if ok and row and row.id and patches[row.id] then
      local patch = patches[row.id]
      row.aiCategory = patch.aiCategory
      row.safetyAlert = patch.safetyAlert
      row.classificationPending = false
      redis.call('LSET', KEYS[keyIndex], rowIndex - 1, cjson.encode(row))
      matched = matched + 1
    end
  end
end
return matched
`;

const BATCH_READ_SCRIPT = `
local results = {}
for keyIndex = 1, #KEYS do
  results[keyIndex] = redis.call('LRANGE', KEYS[keyIndex], 0, tonumber(ARGV[1]) - 1)
end
return results
`;

function cacheComponent(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

export function heartbeatTileCacheKey(schoolId: string, deviceId: string): string {
  const prefix = process.env.REDIS_PREFIX ?? "schoolpilot";
  return `${prefix}:classpilot:heartbeat-history:${cacheComponent(schoolId)}:${cacheComponent(deviceId)}`;
}

function nullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function nullableBoolean(value: unknown): value is boolean | null {
  return value === null || typeof value === "boolean";
}

function decodeHeartbeat(
  raw: unknown,
  schoolId: string,
  deviceId: string
): HeartbeatTileCacheWrite | undefined {
  if (typeof raw !== "string") return undefined;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const row = value as Record<string, unknown>;
  const timestamp = new Date(String(row.timestamp ?? ""));
  if (
    typeof row.id !== "string" ||
    row.id.length === 0 ||
    row.schoolId !== schoolId ||
    row.deviceId !== deviceId ||
    !nullableString(row.studentId) ||
    !nullableString(row.studentEmail) ||
    typeof row.activeTabTitle !== "string" ||
    !nullableString(row.activeTabUrl) ||
    !nullableString(row.favicon) ||
    !nullableBoolean(row.screenLocked) ||
    !nullableBoolean(row.flightPathActive) ||
    !nullableString(row.activeFlightPathName) ||
    !nullableBoolean(row.isSharing) ||
    !nullableBoolean(row.cameraActive) ||
    !nullableString(row.aiCategory) ||
    !nullableString(row.safetyAlert) ||
    !nullableString(row.extensionVersion) ||
    !nullableString(row.chromeVersion) ||
    typeof row.classificationPending !== "boolean" ||
    Number.isNaN(timestamp.getTime())
  ) {
    return undefined;
  }

  return {
    id: row.id,
    schoolId,
    deviceId,
    studentId: row.studentId,
    studentEmail: row.studentEmail,
    activeTabTitle: row.activeTabTitle,
    activeTabUrl: row.activeTabUrl,
    favicon: row.favicon,
    screenLocked: row.screenLocked,
    flightPathActive: row.flightPathActive,
    activeFlightPathName: row.activeFlightPathName,
    isSharing: row.isSharing,
    cameraActive: row.cameraActive,
    aiCategory: row.aiCategory,
    safetyAlert: row.safetyAlert,
    extensionVersion: row.extensionVersion,
    chromeVersion: row.chromeVersion,
    screenshotHealth: row.screenshotHealth ?? null,
    timestamp,
    classificationPending: row.classificationPending,
  };
}

export function createHeartbeatTileCache(
  command: RedisCommand = heartbeatTileRedisCommand
) {
  async function invalidate(
    patches: Pick<HeartbeatClassificationCachePatch, "schoolId" | "deviceId">[]
  ): Promise<boolean> {
    const keys = [...new Set(
      patches.map((patch) => heartbeatTileCacheKey(patch.schoolId, patch.deviceId))
    )];
    if (keys.length === 0) return true;
    const invalidUntil = Date.now() + HEARTBEAT_TILE_CACHE_TTL_SECONDS * 1_000;
    for (const key of keys) locallyInvalidatedUntil.set(key, invalidUntil);
    try {
      const result = await command(["DEL", ...keys]);
      if (result === undefined) return false;
      for (const key of keys) locallyInvalidatedUntil.delete(key);
      return true;
    } catch {
      recordHeartbeatHotPathCounter("tileCacheErrors");
      return false;
    }
  }

  async function write(heartbeat: HeartbeatTileCacheWrite): Promise<boolean> {
    try {
      const result = await command([
        "EVAL",
        WRITE_SCRIPT,
        "1",
        heartbeatTileCacheKey(heartbeat.schoolId ?? "", heartbeat.deviceId),
        JSON.stringify(heartbeat),
        String(HEARTBEAT_TILE_CACHE_MAX_RECORDS),
        String(HEARTBEAT_TILE_CACHE_TTL_SECONDS),
      ]);
      if (result === undefined) {
        recordHeartbeatHotPathCounter("tileCacheErrors");
        return false;
      }
      recordHeartbeatHotPathCounter("tileCacheWrites");
      return true;
    } catch {
      recordHeartbeatHotPathCounter("tileCacheErrors");
      return false;
    }
  }

  async function replace(
    schoolId: string,
    deviceId: string,
    heartbeats: Heartbeat[]
  ): Promise<boolean> {
    const bounded = heartbeats
      .filter((heartbeat) => heartbeat.schoolId === schoolId && heartbeat.deviceId === deviceId)
      .slice(0, HEARTBEAT_TILE_CACHE_MAX_RECORDS);
    try {
      const result = await command([
        "EVAL",
        REPLACE_SCRIPT,
        "1",
        heartbeatTileCacheKey(schoolId, deviceId),
        JSON.stringify(
          bounded.map((heartbeat) => ({
            ...heartbeat,
            // Read-through rows came from PostgreSQL and are authoritative.
            classificationPending: false,
          }))
        ),
        String(HEARTBEAT_TILE_CACHE_TTL_SECONDS),
      ]);
      if (result === undefined) return false;
      recordHeartbeatHotPathCounter("tileCacheWrites", bounded.length || 1);
      return true;
    } catch {
      recordHeartbeatHotPathCounter("tileCacheErrors");
      return false;
    }
  }

  async function read(
    schoolId: string,
    deviceId: string,
    authorizedStudentIds: string[] | null
  ): Promise<HeartbeatTileCacheReadResult> {
    const key = heartbeatTileCacheKey(schoolId, deviceId);
    const invalidUntil = locallyInvalidatedUntil.get(key) ?? 0;
    if (invalidUntil > Date.now()) {
      recordHeartbeatHotPathCounter("tileCacheFallbacks");
      return { status: "unavailable" };
    }
    if (invalidUntil > 0) locallyInvalidatedUntil.delete(key);
    let result: unknown;
    try {
      result = await command([
        "LRANGE",
        key,
        "0",
        String(HEARTBEAT_TILE_CACHE_MAX_RECORDS - 1),
      ]);
    } catch {
      recordHeartbeatHotPathCounter("tileCacheErrors");
      recordHeartbeatHotPathCounter("tileCacheFallbacks");
      return { status: "unavailable" };
    }
    if (result === undefined) {
      recordHeartbeatHotPathCounter("tileCacheFallbacks");
      return { status: "unavailable" };
    }
    if (!Array.isArray(result) || result.length === 0) {
      recordHeartbeatHotPathCounter("tileCacheMisses");
      return { status: "miss" };
    }
    if (result.length < HEARTBEAT_TILE_CACHE_DEFAULT_RECORDS) {
      recordHeartbeatHotPathCounter("tileCacheFallbacks");
      return { status: "incomplete" };
    }

    const decoded = result.map((row) => decodeHeartbeat(row, schoolId, deviceId));
    if (decoded.some((row) => row === undefined)) {
      recordHeartbeatHotPathCounter("tileCacheErrors");
      recordHeartbeatHotPathCounter("tileCacheFallbacks");
      return { status: "incomplete" };
    }
    const rows = decoded as HeartbeatTileCacheWrite[];
    if (rows.some((row) => row.classificationPending)) {
      recordHeartbeatHotPathCounter("tileCacheFallbacks");
      return { status: "incomplete" };
    }
    const allowed = authorizedStudentIds
      ? new Set(authorizedStudentIds)
      : undefined;
    const filtered = allowed
      ? rows.filter((row) => row.studentId !== null && allowed.has(row.studentId))
      : rows;
    if (filtered.length < HEARTBEAT_TILE_CACHE_DEFAULT_RECORDS) {
      recordHeartbeatHotPathCounter("tileCacheFallbacks");
      return { status: "authorization-filtered" };
    }

    recordHeartbeatHotPathCounter("tileCacheHits");
    return {
      status: "hit",
      heartbeats: filtered
        .slice(0, HEARTBEAT_TILE_CACHE_DEFAULT_RECORDS)
        .map(({ classificationPending: _classificationPending, ...heartbeat }) => heartbeat),
    };
  }

  async function readBatch(
    schoolId: string,
    entries: readonly HeartbeatTileCacheBatchEntry[],
    limit: number
  ): Promise<Map<string, HeartbeatTileCacheReadResult>> {
    const results = new Map<string, HeartbeatTileCacheReadResult>();
    if (entries.length === 0) return results;
    const boundedLimit = Math.min(
      Math.max(Math.trunc(limit), 1),
      HEARTBEAT_TILE_CACHE_DEFAULT_RECORDS
    );
    const redisEntries: HeartbeatTileCacheBatchEntry[] = [];
    const keys: string[] = [];
    for (const entry of entries) {
      const key = heartbeatTileCacheKey(schoolId, entry.deviceId);
      const invalidUntil = locallyInvalidatedUntil.get(key) ?? 0;
      if (invalidUntil > Date.now()) {
        results.set(entry.studentId, { status: "unavailable" });
        recordHeartbeatHotPathCounter("tileCacheFallbacks");
        continue;
      }
      if (invalidUntil > 0) locallyInvalidatedUntil.delete(key);
      redisEntries.push(entry);
      keys.push(key);
    }
    if (redisEntries.length === 0) return results;

    let batch: unknown;
    try {
      batch = await command([
        "EVAL",
        BATCH_READ_SCRIPT,
        String(keys.length),
        ...keys,
        String(HEARTBEAT_TILE_CACHE_MAX_RECORDS),
      ]);
    } catch {
      recordHeartbeatHotPathCounter("tileCacheErrors");
      recordHeartbeatHotPathCounter("tileCacheFallbacks", redisEntries.length);
      for (const entry of redisEntries) {
        results.set(entry.studentId, { status: "unavailable" });
      }
      return results;
    }
    if (!Array.isArray(batch) || batch.length !== redisEntries.length) {
      recordHeartbeatHotPathCounter("tileCacheFallbacks", redisEntries.length);
      for (const entry of redisEntries) {
        results.set(entry.studentId, { status: "unavailable" });
      }
      return results;
    }

    for (let index = 0; index < redisEntries.length; index += 1) {
      const entry = redisEntries[index]!;
      const rawRows = batch[index];
      if (!Array.isArray(rawRows) || rawRows.length === 0) {
        results.set(entry.studentId, { status: "miss" });
        recordHeartbeatHotPathCounter("tileCacheMisses");
        continue;
      }
      const decoded = rawRows.map((raw) =>
        decodeHeartbeat(raw, schoolId, entry.deviceId)
      );
      if (decoded.some((row) => row === undefined)) {
        results.set(entry.studentId, { status: "incomplete" });
        recordHeartbeatHotPathCounter("tileCacheErrors");
        recordHeartbeatHotPathCounter("tileCacheFallbacks");
        continue;
      }
      const allowed = (decoded as HeartbeatTileCacheWrite[])
        .filter((row) => row.studentId === entry.studentId);
      const selected = allowed.slice(0, boundedLimit);
      if (selected.length < boundedLimit) {
        results.set(entry.studentId, { status: "authorization-filtered" });
        recordHeartbeatHotPathCounter("tileCacheFallbacks");
        continue;
      }
      if (selected.some((row) => row.classificationPending)) {
        results.set(entry.studentId, { status: "incomplete" });
        recordHeartbeatHotPathCounter("tileCacheErrors");
        recordHeartbeatHotPathCounter("tileCacheFallbacks");
        continue;
      }
      results.set(entry.studentId, {
        status: "hit",
        heartbeats: selected
          .map(({ classificationPending: _classificationPending, ...heartbeat }) => heartbeat),
      });
      recordHeartbeatHotPathCounter("tileCacheHits");
    }
    return results;
  }

  async function patchClassifications(
    patches: HeartbeatClassificationCachePatch[]
  ): Promise<boolean> {
    if (patches.length === 0) return true;
    const byKey = new Map<string, Record<string, {
      aiCategory: string | null;
      safetyAlert: string | null;
    }>>();
    for (const patch of patches) {
      const key = heartbeatTileCacheKey(patch.schoolId, patch.deviceId);
      const entries = byKey.get(key) ?? {};
      entries[patch.heartbeatId] = {
        aiCategory: patch.aiCategory,
        safetyAlert: patch.safetyAlert,
      };
      byKey.set(key, entries);
    }
    try {
      const keys = [...byKey.keys()];
      const expectedMatches = [...byKey.values()].reduce(
        (total, entries) => total + Object.keys(entries).length,
        0
      );
      const result = await command([
        "EVAL",
        PATCH_SCRIPT,
        String(keys.length),
        ...keys,
        ...keys.map((key) => JSON.stringify(byKey.get(key))),
      ]);
      if (Number(result) === expectedMatches) return true;
      recordHeartbeatHotPathCounter("tileCacheErrors");
    } catch {
      recordHeartbeatHotPathCounter("tileCacheErrors");
    }
    return false;
  }

  return { write, replace, read, readBatch, patchClassifications, invalidate };
}

const heartbeatTileCache = createHeartbeatTileCache();

export const writeHeartbeatTileCache = heartbeatTileCache.write;
export const replaceHeartbeatTileCache = heartbeatTileCache.replace;
export const readHeartbeatTileCache = heartbeatTileCache.read;
export const readHeartbeatTileCacheBatch = heartbeatTileCache.readBatch;
export const patchHeartbeatTileCacheClassifications =
  heartbeatTileCache.patchClassifications;
export const invalidateHeartbeatTileCaches = heartbeatTileCache.invalidate;
