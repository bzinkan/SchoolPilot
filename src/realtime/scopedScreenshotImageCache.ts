import { createHash, randomUUID } from "node:crypto";

export type ScreenshotImageAuthority = {
  schoolId: string; deviceId: string; studentId: string; studentSessionId: string;
  teachingSessionId?: string; supervisionContextId?: string; controlRevision: number;
};
export type ScreenshotImageScope = { binding: ScreenshotImageAuthority; bindingVersion: string; legacyKey: string };
export type ScreenshotImageMetadata = ScreenshotImageAuthority & {
  bindingVersion: string; capturedAt: string; timestamp: number;
  tabTitle?: string; tabUrl?: string; tabFavicon?: string;
};
export type ScreenshotImageReadData = ScreenshotImageMetadata & (
  | { screenshot: string; imageId?: string; unchanged?: never }
  | { imageId: string; unchanged: true; screenshot?: never }
);
export type ScreenshotImageWriteResult = { status: "stored"; imageId: string }
  | { status: "superseded" | "unavailable" | "invalid" | "need_full_frame" };
export type ScreenshotImageReadResult = { status: "ok"; screenshots: (ScreenshotImageReadData | null)[] }
  | { status: "unavailable" };
const TTL_SECONDS = 120;
const MAX_BATCH = 500;
const opaqueId = (value: unknown): value is string => typeof value === "string"
  && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);

export function scopedScreenshotImageKey(prefix: string, scope: ScreenshotImageScope): string {
  const b = scope.binding;
  const digest = createHash("sha256").update(JSON.stringify(["screenshot-image-v1", b.schoolId, b.deviceId,
    b.studentId, b.studentSessionId, b.teachingSessionId ?? null, b.supervisionContextId ?? null,
    b.controlRevision, scope.bindingVersion])).digest("hex");
  return `${prefix}image-v1:${digest}`;
}

// Preserve metadata JSON bytes: cjson re-encoding rounds 16-digit revisions.
const COMMON_LUA = `
local function legacyTimestamp(key)
  local raw = redis.call('GET', key)
  if not raw then return -1, false end
  local ok, value = pcall(cjson.decode, raw)
  if not ok or type(value) ~= 'table' then return -1, raw end
  return tonumber(value.timestamp) or -1, raw
end
local function withImageId(raw, id)
  return string.sub(raw, 1, -2) .. ',"imageId":"' .. id .. '"}'
end
`;
export const STORE_SCREENSHOT_IMAGE_SCRIPT = `${COMMON_LUA}
local timestamp = tonumber(ARGV[2])
local currentTimestamp = tonumber(redis.call('HGET', KEYS[1], 'timestamp')) or -1
local oldTimestamp = legacyTimestamp(KEYS[2])
if currentTimestamp > timestamp or oldTimestamp > timestamp then return {-1} end
local id = ARGV[5]
local currentId = redis.call('HGET', KEYS[1], 'imageId')
if currentId and redis.call('HGET', KEYS[1], 'contentHash') == ARGV[4] then id = currentId end
redis.call('HSET', KEYS[1], 'metadata', withImageId(ARGV[1], id), 'pixels', ARGV[3],
  'contentHash', ARGV[4], 'imageId', id, 'timestamp', ARGV[2])
redis.call('EXPIRE', KEYS[1], ARGV[6])
redis.call('DEL', KEYS[2])
return {1, id}
`;
export const REFRESH_SCREENSHOT_IMAGE_SCRIPT = `${COMMON_LUA}
local current = redis.call('HMGET', KEYS[1], 'imageId', 'metadata', 'timestamp')
if not current[1] or current[1] ~= ARGV[3] or not current[2] or redis.call('HSTRLEN', KEYS[1], 'pixels') == 0 then return {0} end
local ok, previous = pcall(cjson.decode, current[2])
local valid, incoming = pcall(cjson.decode, ARGV[1])
if not ok or not valid or type(previous) ~= 'table' or type(incoming) ~= 'table' then return {0} end
for _, field in ipairs({'schoolId','deviceId','studentId','studentSessionId','teachingSessionId','supervisionContextId','bindingVersion'}) do
  if previous[field] ~= incoming[field] then return {0} end
end
if previous.imageId ~= ARGV[3] then return {0} end
local timestamp = tonumber(ARGV[2])
local oldTimestamp = legacyTimestamp(KEYS[2])
if (tonumber(current[3]) or -1) > timestamp or oldTimestamp > timestamp then return {-1} end
redis.call('HSET', KEYS[1], 'metadata', withImageId(ARGV[1], ARGV[3]), 'timestamp', ARGV[2])
redis.call('EXPIRE', KEYS[1], ARGV[4])
redis.call('DEL', KEYS[2])
return {1, ARGV[3]}
`;
export const STORE_LEGACY_SCREENSHOT_SCRIPT = `${COMMON_LUA}
local timestamp = tonumber(ARGV[2])
local oldTimestamp = legacyTimestamp(KEYS[2])
local imageTimestamp = tonumber(redis.call('HGET', KEYS[1], 'timestamp')) or -1
if oldTimestamp > timestamp or imageTimestamp > timestamp then return 1 end
redis.call('SET', KEYS[2], ARGV[1], 'EX', ARGV[3])
redis.call('DEL', KEYS[1])
return 1
`;
export const READ_SCREENSHOT_IMAGES_SCRIPT = `${COMMON_LUA}
local count = #KEYS / 2
local result = {}
for index = 1, count do
  local current = redis.call('HMGET', KEYS[index], 'metadata', 'imageId', 'timestamp')
  local old = redis.call('GET', KEYS[count + index])
  local oldIsNewer = false
  if old and current[1] then
    local ok, value = pcall(cjson.decode, old)
    oldIsNewer = ok and type(value) == 'table' and (tonumber(value.timestamp) or -1) > (tonumber(current[3]) or -1)
  end
  if old and (not current[1] or oldIsNewer) then
    result[index] = {0, old}
  elseif current[1] and current[2] and redis.call('HSTRLEN', KEYS[index], 'pixels') > 0 then
    local pixels = false
    if ARGV[index] == '' or ARGV[index] ~= current[2] then pixels = redis.call('HGET', KEYS[index], 'pixels') end
    result[index] = {1, current[1], pixels}
  else result[index] = false end
end
return result
`;

function scopeValid(scope: ScreenshotImageScope): boolean {
  const b = scope.binding;
  return [b.schoolId, b.deviceId, b.studentId, b.studentSessionId, scope.bindingVersion, scope.legacyKey]
    .every(value => typeof value === "string" && value.length > 0)
    && Number.isSafeInteger(b.controlRevision) && b.controlRevision >= 0
    && ((typeof b.teachingSessionId === "string" && b.teachingSessionId.length > 0 && b.supervisionContextId === undefined)
      || (typeof b.supervisionContextId === "string" && b.supervisionContextId.length > 0 && b.teachingSessionId === undefined));
}

function metadata(scope: ScreenshotImageScope, value: object, now: number): ScreenshotImageMetadata | undefined {
  if (!scopeValid(scope)) return undefined;
  const data = value as Record<string, unknown>;
  const b = scope.binding;
  if (["schoolId", "deviceId", "studentId", "studentSessionId", "teachingSessionId", "supervisionContextId", "controlRevision"]
    .some(field => data[field] !== b[field as keyof ScreenshotImageAuthority])) return undefined;
  const timestamp = data.timestamp;
  const capturedAt = data.capturedAt;
  if (data.bindingVersion !== scope.bindingVersion || typeof timestamp !== "number" || !Number.isFinite(timestamp)
    || typeof capturedAt !== "string" || !Number.isFinite(Date.parse(capturedAt))
    || Math.abs(Date.parse(capturedAt) - timestamp) > 1_000 || now - timestamp > TTL_SECONDS * 1_000
    || timestamp - now > 30_000) return undefined;
  return { ...b, bindingVersion: scope.bindingVersion, timestamp, capturedAt,
    ...(typeof data.tabTitle === "string" ? { tabTitle: data.tabTitle } : {}),
    ...(typeof data.tabUrl === "string" ? { tabUrl: data.tabUrl } : {}),
    ...(typeof data.tabFavicon === "string" ? { tabFavicon: data.tabFavicon } : {}) };
}

function writeResult(value: unknown): ScreenshotImageWriteResult {
  if (!Array.isArray(value)) return { status: "unavailable" };
  if (value[0] === -1) return { status: "superseded" };
  if (value[0] === 0) return { status: "need_full_frame" };
  return value[0] === 1 && opaqueId(value[1]) ? { status: "stored", imageId: value[1] } : { status: "unavailable" };
}

/** Cache identity is not authorization. Callers derive these scopes on the
 * server and retain the existing database authority/capture locks while writing.
 * Metadata-only refreshes represent a newly captured frame, never a heartbeat. */
export function createScopedScreenshotImageCache(command: (args: string[]) => Promise<unknown>, options: { prefix: string; now?: () => number }) {
  const now = options.now ?? Date.now;
  async function storeFull(scope: ScreenshotImageScope, value: object): Promise<ScreenshotImageWriteResult> {
    const prepared = metadata(scope, value, now());
    const pixels = (value as { screenshot?: unknown }).screenshot;
    if (!prepared || typeof pixels !== "string" || !pixels.length) return { status: "invalid" };
    const hash = createHash("sha256").update(pixels).digest("hex");
    try { return writeResult(await command(["EVAL", STORE_SCREENSHOT_IMAGE_SCRIPT, "2", scopedScreenshotImageKey(options.prefix, scope),
      scope.legacyKey, JSON.stringify(prepared), String(prepared.timestamp), pixels, hash, randomUUID(), String(TTL_SECONDS)])); }
    catch { return { status: "unavailable" }; }
  }
  async function refresh(scope: ScreenshotImageScope, value: object): Promise<ScreenshotImageWriteResult> {
    const prepared = metadata(scope, value, now());
    const id = (value as { imageId?: unknown }).imageId;
    if (!prepared || !opaqueId(id) || (value as { screenshot?: unknown }).screenshot !== undefined) return { status: "invalid" };
    try { return writeResult(await command(["EVAL", REFRESH_SCREENSHOT_IMAGE_SCRIPT, "2", scopedScreenshotImageKey(options.prefix, scope),
      scope.legacyKey, JSON.stringify(prepared), String(prepared.timestamp), id, String(TTL_SECONDS)])); }
    catch { return { status: "unavailable" }; }
  }
  async function storeLegacy(scope: ScreenshotImageScope, value: object): Promise<boolean> {
    const prepared = metadata(scope, value, now());
    if (!prepared || typeof (value as { screenshot?: unknown }).screenshot !== "string") return false;
    try { return await command(["EVAL", STORE_LEGACY_SCREENSHOT_SCRIPT, "2", scopedScreenshotImageKey(options.prefix, scope),
      scope.legacyKey, JSON.stringify(value), String(prepared.timestamp), String(TTL_SECONDS)]) === 1; }
    catch { return false; }
  }
  async function read(scopes: readonly ScreenshotImageScope[], knownIds: readonly (string | null | undefined)[] = []): Promise<ScreenshotImageReadResult> {
    if (!scopes.length) return { status: "ok", screenshots: [] };
    if (scopes.length > MAX_BATCH || scopes.some(scope => !scopeValid(scope))) return { status: "unavailable" };
    const aligned = scopes.map((_, index) => opaqueId(knownIds[index]) ? knownIds[index]! : "");
    try {
      const result = await command(["EVAL", READ_SCREENSHOT_IMAGES_SCRIPT, String(scopes.length * 2),
        ...scopes.map(scope => scopedScreenshotImageKey(options.prefix, scope)), ...scopes.map(scope => scope.legacyKey), ...aligned]);
      if (!Array.isArray(result) || result.length !== scopes.length) return { status: "unavailable" };
      const screenshots = scopes.map((scope, index): ScreenshotImageReadData | null => {
        const row: unknown = result[index];
        if (!Array.isArray(row) || typeof row[1] !== "string") return null;
        let parsed: unknown;
        try { parsed = JSON.parse(row[1]); } catch { return null; }
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
        const prepared = metadata(scope, parsed, now());
        if (!prepared) return null;
        const data = parsed as { screenshot?: unknown; imageId?: unknown };
        if (row[0] === 0) return typeof data.screenshot === "string" ? { ...prepared, screenshot: data.screenshot } : null;
        if (row[0] !== 1 || !opaqueId(data.imageId)) return null;
        if (typeof row[2] === "string") return { ...prepared, imageId: data.imageId, screenshot: row[2] };
        return data.imageId === aligned[index] ? { ...prepared, imageId: data.imageId, unchanged: true } : null;
      });
      return { status: "ok", screenshots };
    } catch { return { status: "unavailable" }; }
  }
  return { storeFull, refresh, storeLegacy, read };
}
