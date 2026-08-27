import { createHmac } from "node:crypto";
import { redisCommand } from "../middleware/rateLimiter.js";

export const CLASSPILOT_OBSERVATION_RENEW_SECONDS = 30;
export const CLASSPILOT_OBSERVATION_LEASE_SECONDS = 90;
export const CLASSPILOT_OBSERVATION_MAX_VIEWERS_PER_SESSION = 128;
const MAX_OBSERVATION_STUDENTS = 500;
const MAX_LOCAL_LEASES = 4_096;

export type ClasspilotObservationScope =
  | { kind: "class" }
  | { kind: "students"; studentIds: string[] };

export function classpilotObservationSessionIsLive(session: {
  sessionMode?: string | null;
  endTime?: Date | string | null;
  rosterSnapshotCompletedAt?: Date | string | null;
} | null | undefined): boolean {
  return Boolean(
    session
    && session.sessionMode === "live"
    && !session.endTime
    && session.rosterSnapshotCompletedAt
  );
}

type StoredObservationLease = {
  scope: ClasspilotObservationScope;
  expiresAt: number;
};

const localLeases = new Map<string, StoredObservationLease>();

function observationLeaseProduction(): boolean {
  return process.env.NODE_ENV === "production" || process.env.APP_ENV === "production";
}

function observationLeaseStoreRequired(): boolean {
  return Boolean(process.env.REDIS_URL || observationLeaseProduction());
}

function keySecret(): string {
  const configured = process.env.CLASSPILOT_OBSERVATION_HMAC_SECRET
    || process.env.SESSION_SECRET
    || process.env.JWT_SECRET;
  if (!configured && observationLeaseProduction()) {
    throw new Error("CLASSPILOT_OBSERVATION_HMAC_SECRET is required in production");
  }
  return configured || "classpilot-observation-development-only";
}

function digest(parts: string[]): string {
  return createHmac("sha256", keySecret()).update(parts.join("\u001f")).digest("base64url");
}

function sessionIndexKey(schoolId: string, teachingSessionId: string): string {
  return `classpilot:observation:v1:${digest([schoolId, teachingSessionId])}`;
}

function viewerDigest(options: {
  schoolId: string;
  teachingSessionId: string;
  viewerUserId: string;
  viewerInstanceId: string;
}): string {
  return digest([
    options.schoolId,
    options.teachingSessionId,
    options.viewerUserId,
    options.viewerInstanceId,
  ]);
}

function viewerDataKey(indexKey: string, viewer: string): string {
  return `${indexKey}:viewer:${viewer}`;
}

function normalizeScope(scope: ClasspilotObservationScope): ClasspilotObservationScope {
  if (scope.kind === "class") return { kind: "class" };
  const studentIds = [...new Set(scope.studentIds.map((value) => value.trim()).filter(Boolean))].sort();
  if (studentIds.length < 1 || studentIds.length > MAX_OBSERVATION_STUDENTS) {
    throw new Error("Observation student scope must contain 1 through 500 students");
  }
  return { kind: "students", studentIds };
}

function pruneLocal(now: number): void {
  for (const [key, lease] of localLeases) {
    if (lease.expiresAt <= now) localLeases.delete(key);
  }
  while (localLeases.size >= MAX_LOCAL_LEASES) {
    const oldest = localLeases.keys().next().value as string | undefined;
    if (!oldest) break;
    localLeases.delete(oldest);
  }
}

function makeRoomForLocalViewer(indexKey: string, viewerKey: string): void {
  localLeases.delete(viewerKey);
  const sessionPrefix = `${indexKey}:`;
  const sessionKeys = [...localLeases.keys()].filter((key) => key.startsWith(sessionPrefix));
  const overflow = sessionKeys.length - CLASSPILOT_OBSERVATION_MAX_VIEWERS_PER_SESSION + 1;
  for (let index = 0; index < overflow; index += 1) {
    localLeases.delete(sessionKeys[index]!);
  }
}

export async function renewClasspilotObservationLease(options: {
  schoolId: string;
  teachingSessionId: string;
  viewerUserId: string;
  viewerInstanceId: string;
  scope: ClasspilotObservationScope;
  now?: number;
}): Promise<{ expiresAt: number; scope: ClasspilotObservationScope }> {
  const now = options.now ?? Date.now();
  const scope = normalizeScope(options.scope);
  const expiresAt = now + CLASSPILOT_OBSERVATION_LEASE_SECONDS * 1000;
  if (observationLeaseStoreRequired() && !process.env.REDIS_URL) {
    throw new Error("Observation lease storage unavailable");
  }
  const indexKey = sessionIndexKey(options.schoolId, options.teachingSessionId);
  const viewer = viewerDigest(options);
  const dataKey = viewerDataKey(indexKey, viewer);
  const payload = JSON.stringify({ scope, expiresAt } satisfies StoredObservationLease);
  try {
    const result = await redisCommand([
      "EVAL",
      "local expired = redis.call('ZRANGEBYSCORE', KEYS[1], '-inf', ARGV[1]); for _, member in ipairs(expired) do redis.call('DEL', ARGV[8] .. member); end; redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', ARGV[1]); redis.call('ZREM', KEYS[1], ARGV[3]); local count = redis.call('ZCARD', KEYS[1]); local max_viewers = tonumber(ARGV[7]); if count >= max_viewers then local victims = redis.call('ZPOPMIN', KEYS[1], count - max_viewers + 1); for index = 1, #victims, 2 do redis.call('DEL', ARGV[8] .. victims[index]); end; end; redis.call('ZADD', KEYS[1], ARGV[2], ARGV[3]); redis.call('EXPIRE', KEYS[1], ARGV[4]); redis.call('SET', KEYS[2], ARGV[5], 'EX', ARGV[6]); return redis.call('ZCARD', KEYS[1])",
      "2",
      indexKey,
      dataKey,
      String(now),
      String(expiresAt),
      viewer,
      String(CLASSPILOT_OBSERVATION_LEASE_SECONDS * 2),
      payload,
      String(CLASSPILOT_OBSERVATION_LEASE_SECONDS),
      String(CLASSPILOT_OBSERVATION_MAX_VIEWERS_PER_SESSION),
      `${indexKey}:viewer:`,
    ], { readyTimeoutMs: 250 });
    if (
      typeof result === "number"
      && result >= 1
      && result <= CLASSPILOT_OBSERVATION_MAX_VIEWERS_PER_SESSION
    ) return { expiresAt, scope };
    if (result !== undefined) throw new Error("Observation lease storage unavailable");
  } catch {
    if (observationLeaseStoreRequired()) throw new Error("Observation lease storage unavailable");
  }
  if (observationLeaseStoreRequired()) throw new Error("Observation lease storage unavailable");
  pruneLocal(now);
  const localViewerKey = `${indexKey}:${viewer}`;
  makeRoomForLocalViewer(indexKey, localViewerKey);
  localLeases.set(localViewerKey, { scope, expiresAt });
  return { expiresAt, scope };
}

export async function releaseClasspilotObservationLease(options: {
  schoolId: string;
  teachingSessionId: string;
  viewerUserId: string;
  viewerInstanceId: string;
}): Promise<void> {
  if (observationLeaseStoreRequired() && !process.env.REDIS_URL) return;
  const indexKey = sessionIndexKey(options.schoolId, options.teachingSessionId);
  const viewer = viewerDigest(options);
  const dataKey = viewerDataKey(indexKey, viewer);
  try {
    const result = await redisCommand([
      "EVAL",
      "redis.call('ZREM', KEYS[1], ARGV[1]); return redis.call('DEL', KEYS[2])",
      "2",
      indexKey,
      dataKey,
      viewer,
    ], { readyTimeoutMs: 250 });
    if (result !== undefined || observationLeaseStoreRequired()) return;
  } catch {
    if (observationLeaseStoreRequired()) return;
  }
  localLeases.delete(`${indexKey}:${viewer}`);
}

export type ClasspilotObservationStatus =
  | { status: "observed" | "unobserved"; expiresInSeconds: number }
  | { status: "unavailable"; expiresInSeconds: 0 };

export async function classpilotObservationStatus(options: {
  schoolId: string;
  teachingSessionId: string | null | undefined;
  studentId: string;
  now?: number;
}): Promise<ClasspilotObservationStatus> {
  if (!options.teachingSessionId) return { status: "unobserved", expiresInSeconds: 0 };
  const now = options.now ?? Date.now();
  if (observationLeaseStoreRequired() && !process.env.REDIS_URL) {
    return { status: "unavailable", expiresInSeconds: 0 };
  }
  const indexKey = sessionIndexKey(options.schoolId, options.teachingSessionId);
  try {
    const viewers = await redisCommand([
      "ZRANGEBYSCORE",
      indexKey,
      String(now + 1),
      "+inf",
      "LIMIT",
      "0",
      String(CLASSPILOT_OBSERVATION_MAX_VIEWERS_PER_SESSION + 1),
    ], { readyTimeoutMs: 200 });
    if (Array.isArray(viewers)) {
      if (viewers.length > CLASSPILOT_OBSERVATION_MAX_VIEWERS_PER_SESSION) {
        return { status: "unavailable", expiresInSeconds: 0 };
      }
      if (viewers.length === 0) return { status: "unobserved", expiresInSeconds: 0 };
      const values = await redisCommand([
        "MGET",
        ...viewers.map((viewer) => viewerDataKey(indexKey, String(viewer))),
      ], { readyTimeoutMs: 200 });
      if (!Array.isArray(values)) return { status: "unavailable", expiresInSeconds: 0 };
      let latestExpiry = 0;
      for (const value of values) {
        if (typeof value !== "string") continue;
        try {
          const lease = JSON.parse(value) as StoredObservationLease;
          if (lease.expiresAt <= now) continue;
          if (lease.scope.kind === "class"
            || (lease.scope.kind === "students" && lease.scope.studentIds.includes(options.studentId))) {
            latestExpiry = Math.max(latestExpiry, lease.expiresAt);
          }
        } catch {
          // Invalid entries fail private and age out with the lease TTL.
        }
      }
      return latestExpiry > now
        ? { status: "observed", expiresInSeconds: Math.ceil((latestExpiry - now) / 1000) }
        : { status: "unobserved", expiresInSeconds: 0 };
    }
  } catch {
    if (observationLeaseStoreRequired()) return { status: "unavailable", expiresInSeconds: 0 };
  }
  if (observationLeaseStoreRequired()) return { status: "unavailable", expiresInSeconds: 0 };
  pruneLocal(now);
  let latestExpiry = 0;
  let viewerCount = 0;
  for (const [key, lease] of localLeases) {
    if (!key.startsWith(`${indexKey}:`)) continue;
    viewerCount += 1;
    if (viewerCount > CLASSPILOT_OBSERVATION_MAX_VIEWERS_PER_SESSION) {
      return { status: "unavailable", expiresInSeconds: 0 };
    }
    if (lease.scope.kind === "class"
      || (lease.scope.kind === "students" && lease.scope.studentIds.includes(options.studentId))) {
      latestExpiry = Math.max(latestExpiry, lease.expiresAt);
    }
  }
  return latestExpiry > now
    ? { status: "observed", expiresInSeconds: Math.ceil((latestExpiry - now) / 1000) }
    : { status: "unobserved", expiresInSeconds: 0 };
}

export function resetClasspilotObservationLeasesForTests(): void {
  localLeases.clear();
}
