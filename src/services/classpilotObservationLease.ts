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
  scopeKey?: string;
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

// A lease is held against a subject. The teaching-session subject is the
// original one and its derived keys are frozen: changing either the literal
// prefix or the digest inputs below orphans every in-flight lease across a
// rolling deploy. Any new subject gets its own literal prefix AND a domain tag
// as the first digest part, so an identifier reused across subject kinds can
// never collide into the same namespace.
type ObservationSubject =
  | { kind: "teaching_session"; teachingSessionId: string }
  | { kind: "supervision_context"; supervisionContextId: string };

const SUPERVISION_SUBJECT_DOMAIN = "supervision_context";

function subjectIndexKey(schoolId: string, subject: ObservationSubject): string {
  if (subject.kind === "teaching_session") {
    return `classpilot:observation:v1:${digest([schoolId, subject.teachingSessionId])}`;
  }
  return `classpilot:observation:supervision:v1:${digest([
    SUPERVISION_SUBJECT_DOMAIN,
    schoolId,
    subject.supervisionContextId,
  ])}`;
}

function subjectViewerDigest(options: {
  schoolId: string;
  subject: ObservationSubject;
  viewerUserId: string;
  viewerInstanceId: string;
}): string {
  if (options.subject.kind === "teaching_session") {
    return digest([
      options.schoolId,
      options.subject.teachingSessionId,
      options.viewerUserId,
      options.viewerInstanceId,
    ]);
  }
  return digest([
    SUPERVISION_SUBJECT_DOMAIN,
    options.schoolId,
    options.subject.supervisionContextId,
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

function observationScopeKey(scope: ClasspilotObservationScope): string {
  return JSON.stringify(scope);
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

export type ClasspilotObservationLeaseRenewal = {
  expiresAt: number;
  scope: ClasspilotObservationScope;
  created: boolean;
  changed: boolean;
  activated: boolean;
};

async function renewObservationLeaseForSubject(options: {
  schoolId: string;
  subject: ObservationSubject;
  viewerUserId: string;
  viewerInstanceId: string;
  scope: ClasspilotObservationScope;
  now?: number;
}): Promise<ClasspilotObservationLeaseRenewal> {
  const now = options.now ?? Date.now();
  const scope = normalizeScope(options.scope);
  const expiresAt = now + CLASSPILOT_OBSERVATION_LEASE_SECONDS * 1000;
  if (observationLeaseStoreRequired() && !process.env.REDIS_URL) {
    throw new Error("Observation lease storage unavailable");
  }
  const indexKey = subjectIndexKey(options.schoolId, options.subject);
  const viewer = subjectViewerDigest(options);
  const dataKey = viewerDataKey(indexKey, viewer);
  const scopeKey = observationScopeKey(scope);
  const payload = JSON.stringify({ scope, expiresAt, scopeKey } satisfies StoredObservationLease);
  try {
    const result = await redisCommand([
      "EVAL",
      "local old = redis.call('GET', KEYS[2]); local existed = 0; local changed = 1; if old then local ok, decoded = pcall(cjson.decode, old); local old_expiry = ok and tonumber(decoded.expiresAt) or nil; if ok and old_expiry and old_expiry > tonumber(ARGV[1]) then existed = 1; if decoded.scopeKey == ARGV[9] then changed = 0; end; end; end; local expired = redis.call('ZRANGEBYSCORE', KEYS[1], '-inf', ARGV[1]); for _, member in ipairs(expired) do redis.call('DEL', ARGV[8] .. member); end; redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', ARGV[1]); redis.call('ZREM', KEYS[1], ARGV[3]); local count = redis.call('ZCARD', KEYS[1]); local max_viewers = tonumber(ARGV[7]); if count >= max_viewers then local victims = redis.call('ZPOPMIN', KEYS[1], count - max_viewers + 1); for index = 1, #victims, 2 do redis.call('DEL', ARGV[8] .. victims[index]); end; end; redis.call('ZADD', KEYS[1], ARGV[2], ARGV[3]); redis.call('EXPIRE', KEYS[1], ARGV[4]); redis.call('SET', KEYS[2], ARGV[5], 'EX', ARGV[6]); return { redis.call('ZCARD', KEYS[1]), existed, changed }",
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
      scopeKey,
    ], { readyTimeoutMs: 250 });
    if (
      Array.isArray(result)
      && typeof result[0] === "number"
      && result[0] >= 1
      && result[0] <= CLASSPILOT_OBSERVATION_MAX_VIEWERS_PER_SESSION
      && (result[1] === 0 || result[1] === 1)
      && (result[2] === 0 || result[2] === 1)
    ) return {
      expiresAt,
      scope,
      created: result[1] === 0,
      changed: result[2] === 1,
      activated: result[0] === 1 && result[1] === 0,
    };
    if (result !== undefined) throw new Error("Observation lease storage unavailable");
  } catch {
    if (observationLeaseStoreRequired()) throw new Error("Observation lease storage unavailable");
  }
  if (observationLeaseStoreRequired()) throw new Error("Observation lease storage unavailable");
  pruneLocal(now);
  const localViewerKey = `${indexKey}:${viewer}`;
  const previous = localLeases.get(localViewerKey);
  const created = !previous;
  const changed = !previous
    || previous.expiresAt <= now
    || observationScopeKey(previous.scope) !== scopeKey;
  makeRoomForLocalViewer(indexKey, localViewerKey);
  localLeases.set(localViewerKey, { scope, expiresAt, scopeKey });
  const activeViewerCount = [...localLeases.keys()].filter((key) => (
    key.startsWith(`${indexKey}:`)
  )).length;
  return { expiresAt, scope, created, changed, activated: created && activeViewerCount === 1 };
}

export async function renewClasspilotObservationLease(options: {
  schoolId: string;
  teachingSessionId: string;
  viewerUserId: string;
  viewerInstanceId: string;
  scope: ClasspilotObservationScope;
  now?: number;
}): Promise<ClasspilotObservationLeaseRenewal> {
  return renewObservationLeaseForSubject({
    schoolId: options.schoolId,
    subject: { kind: "teaching_session", teachingSessionId: options.teachingSessionId },
    viewerUserId: options.viewerUserId,
    viewerInstanceId: options.viewerInstanceId,
    scope: options.scope,
    now: options.now,
  });
}

export async function renewClasspilotSupervisionObservationLease(options: {
  schoolId: string;
  supervisionContextId: string;
  viewerUserId: string;
  viewerInstanceId: string;
  scope: ClasspilotObservationScope;
  now?: number;
}): Promise<ClasspilotObservationLeaseRenewal> {
  return renewObservationLeaseForSubject({
    schoolId: options.schoolId,
    subject: { kind: "supervision_context", supervisionContextId: options.supervisionContextId },
    viewerUserId: options.viewerUserId,
    viewerInstanceId: options.viewerInstanceId,
    scope: options.scope,
    now: options.now,
  });
}

async function releaseObservationLeaseForSubject(options: {
  schoolId: string;
  subject: ObservationSubject;
  viewerUserId: string;
  viewerInstanceId: string;
  now?: number;
}): Promise<{ released: boolean; deactivated: boolean }> {
  if (observationLeaseStoreRequired() && !process.env.REDIS_URL) {
    return { released: false, deactivated: false };
  }
  const now = options.now ?? Date.now();
  const indexKey = subjectIndexKey(options.schoolId, options.subject);
  const viewer = subjectViewerDigest(options);
  const dataKey = viewerDataKey(indexKey, viewer);
  try {
    const result = await redisCommand([
      "EVAL",
      "redis.call('ZREM', KEYS[1], ARGV[1]); local removed = redis.call('DEL', KEYS[2]); local expired = redis.call('ZRANGEBYSCORE', KEYS[1], '-inf', ARGV[2]); for _, member in ipairs(expired) do redis.call('DEL', ARGV[3] .. member); end; redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', ARGV[2]); return {removed, redis.call('ZCARD', KEYS[1])}",
      "2",
      indexKey,
      dataKey,
      viewer,
      String(now),
      `${indexKey}:viewer:`,
    ], { readyTimeoutMs: 250 });
    if (
      Array.isArray(result)
      && (result[0] === 0 || result[0] === 1)
      && typeof result[1] === "number"
      && result[1] >= 0
      && result[1] <= CLASSPILOT_OBSERVATION_MAX_VIEWERS_PER_SESSION
    ) {
      return {
        released: result[0] === 1,
        deactivated: result[0] === 1 && result[1] === 0,
      };
    }
    if (result !== undefined || observationLeaseStoreRequired()) {
      return { released: false, deactivated: false };
    }
  } catch {
    if (observationLeaseStoreRequired()) return { released: false, deactivated: false };
  }
  pruneLocal(now);
  const released = localLeases.delete(`${indexKey}:${viewer}`);
  const hasActiveViewer = [...localLeases.keys()].some((key) => key.startsWith(`${indexKey}:`));
  return { released, deactivated: released && !hasActiveViewer };
}

export async function releaseClasspilotObservationLeaseWithState(options: {
  schoolId: string;
  teachingSessionId: string;
  viewerUserId: string;
  viewerInstanceId: string;
  now?: number;
}): Promise<{ released: boolean; deactivated: boolean }> {
  return releaseObservationLeaseForSubject({
    schoolId: options.schoolId,
    subject: { kind: "teaching_session", teachingSessionId: options.teachingSessionId },
    viewerUserId: options.viewerUserId,
    viewerInstanceId: options.viewerInstanceId,
    now: options.now,
  });
}

export async function releaseClasspilotSupervisionObservationLeaseWithState(options: {
  schoolId: string;
  supervisionContextId: string;
  viewerUserId: string;
  viewerInstanceId: string;
  now?: number;
}): Promise<{ released: boolean; deactivated: boolean }> {
  return releaseObservationLeaseForSubject({
    schoolId: options.schoolId,
    subject: { kind: "supervision_context", supervisionContextId: options.supervisionContextId },
    viewerUserId: options.viewerUserId,
    viewerInstanceId: options.viewerInstanceId,
    now: options.now,
  });
}

export async function releaseClasspilotObservationLease(options: {
  schoolId: string;
  teachingSessionId: string;
  viewerUserId: string;
  viewerInstanceId: string;
  now?: number;
}): Promise<boolean> {
  return (await releaseClasspilotObservationLeaseWithState(options)).released;
}

export type ClasspilotObservationStatus =
  | { status: "observed" | "unobserved"; expiresInSeconds: number }
  | { status: "unavailable"; expiresInSeconds: 0 };

async function observationStatusForSubject(options: {
  schoolId: string;
  subject: ObservationSubject;
  studentId: string;
  now?: number;
}): Promise<ClasspilotObservationStatus> {
  const now = options.now ?? Date.now();
  if (observationLeaseStoreRequired() && !process.env.REDIS_URL) {
    return { status: "unavailable", expiresInSeconds: 0 };
  }
  const indexKey = subjectIndexKey(options.schoolId, options.subject);
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

export async function classpilotObservationStatus(options: {
  schoolId: string;
  teachingSessionId: string | null | undefined;
  studentId: string;
  now?: number;
}): Promise<ClasspilotObservationStatus> {
  if (!options.teachingSessionId) return { status: "unobserved", expiresInSeconds: 0 };
  return observationStatusForSubject({
    schoolId: options.schoolId,
    subject: { kind: "teaching_session", teachingSessionId: options.teachingSessionId },
    studentId: options.studentId,
    now: options.now,
  });
}

export async function classpilotSupervisionObservationStatus(options: {
  schoolId: string;
  supervisionContextId: string | null | undefined;
  studentId: string;
  now?: number;
}): Promise<ClasspilotObservationStatus> {
  // Mirrors the teaching-session polarity exactly: a missing subject is a
  // positive "nobody is watching", never the diagnostic "unavailable" that
  // devices.ts turns into a 503.
  if (!options.supervisionContextId) return { status: "unobserved", expiresInSeconds: 0 };
  return observationStatusForSubject({
    schoolId: options.schoolId,
    subject: { kind: "supervision_context", supervisionContextId: options.supervisionContextId },
    studentId: options.studentId,
    now: options.now,
  });
}

// Test-only accessor: lets the derivation pinning test observe the exact keys
// without exporting the derivation itself.
export function classpilotObservationSubjectKeysForTests(options: {
  schoolId: string;
  subjectKind: "teaching_session" | "supervision_context";
  subjectId: string;
  viewerUserId: string;
  viewerInstanceId: string;
}): { indexKey: string; viewerKey: string; viewerDataKey: string } {
  const subject: ObservationSubject = options.subjectKind === "teaching_session"
    ? { kind: "teaching_session", teachingSessionId: options.subjectId }
    : { kind: "supervision_context", supervisionContextId: options.subjectId };
  const indexKey = subjectIndexKey(options.schoolId, subject);
  const viewerKey = subjectViewerDigest({
    schoolId: options.schoolId,
    subject,
    viewerUserId: options.viewerUserId,
    viewerInstanceId: options.viewerInstanceId,
  });
  return { indexKey, viewerKey, viewerDataKey: viewerDataKey(indexKey, viewerKey) };
}

export function resetClasspilotObservationLeasesForTests(): void {
  localLeases.clear();
}
