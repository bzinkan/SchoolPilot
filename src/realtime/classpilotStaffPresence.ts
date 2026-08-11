import { createHash } from "crypto";
import { isStaffUserConnectedLocal } from "./ws-broadcast.js";
import { executeRealtimeRedisCommand } from "./ws-redis.js";

export const CLASSPILOT_STAFF_PRESENCE_TTL_MS = 90_000;
export const CLASSPILOT_STAFF_PRESENCE_OPERATION_TIMEOUT_MS = 500;
const CLASSPILOT_STAFF_PRESENCE_KEY_TTL_SECONDS = Math.ceil(
  (CLASSPILOT_STAFF_PRESENCE_TTL_MS * 2) / 1_000
);

export interface ClasspilotStaffPresenceStore {
  touch(
    schoolId: string,
    userId: string,
    connectionId: string,
    observedAt?: Date
  ): Promise<boolean>;
  remove(schoolId: string, userId: string, connectionId: string): Promise<boolean>;
  /** `undefined` means the shared store is unavailable; callers fail closed. */
  isFresh(schoolId: string, userId: string, now?: Date): Promise<boolean | undefined>;
}

type RedisCommand = <T = unknown>(command: string[]) => Promise<T | undefined>;

const TOUCH_PRESENCE_SCRIPT = `
local now = tonumber(ARGV[1])
local expires_at = tonumber(ARGV[2])
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now)
redis.call('ZADD', KEYS[1], expires_at, ARGV[3])
redis.call('EXPIRE', KEYS[1], tonumber(ARGV[4]))
return 1
`;

const REMOVE_PRESENCE_SCRIPT = `
redis.call('ZREM', KEYS[1], ARGV[1])
local remaining = redis.call('ZCARD', KEYS[1])
if remaining == 0 then
  redis.call('DEL', KEYS[1])
end
return remaining
`;

const READ_PRESENCE_SCRIPT = `
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', tonumber(ARGV[1]))
local remaining = redis.call('ZCARD', KEYS[1])
if remaining == 0 then
  redis.call('DEL', KEYS[1])
end
return remaining
`;

function presenceKey(schoolId: string, userId: string): string {
  // Hash the compound authority boundary so keys neither expose identities nor
  // permit delimiter collisions across tenants.
  const scope = createHash("sha256")
    .update(schoolId)
    .update("\0")
    .update(userId)
    .digest("hex");
  const prefix = process.env.REDIS_PREFIX ?? "schoolpilot";
  return `${prefix}:classpilot:staff-presence:${scope}`;
}

function validInstant(value: Date): number | undefined {
  const timestamp = value.getTime();
  return Number.isFinite(timestamp) ? timestamp : undefined;
}

export function createClasspilotStaffPresenceStore(
  redisCommand: RedisCommand = executeRealtimeRedisCommand
): ClasspilotStaffPresenceStore {
  return {
    async touch(schoolId, userId, connectionId, observedAt = new Date()) {
      const timestamp = validInstant(observedAt);
      if (!schoolId || !userId || !connectionId || timestamp === undefined) return false;
      const result = await redisCommand<number>([
        "EVAL",
        TOUCH_PRESENCE_SCRIPT,
        "1",
        presenceKey(schoolId, userId),
        String(timestamp),
        String(timestamp + CLASSPILOT_STAFF_PRESENCE_TTL_MS),
        connectionId,
        String(CLASSPILOT_STAFF_PRESENCE_KEY_TTL_SECONDS),
      ]);
      return result !== undefined;
    },

    async remove(schoolId, userId, connectionId) {
      if (!schoolId || !userId || !connectionId) return false;
      const result = await redisCommand<number>([
        "EVAL",
        REMOVE_PRESENCE_SCRIPT,
        "1",
        presenceKey(schoolId, userId),
        connectionId,
      ]);
      return result !== undefined;
    },

    async isFresh(schoolId, userId, now = new Date()) {
      const timestamp = validInstant(now);
      if (!schoolId || !userId || timestamp === undefined) return false;
      const result = await redisCommand<number>([
        "EVAL",
        READ_PRESENCE_SCRIPT,
        "1",
        presenceKey(schoolId, userId),
        String(timestamp),
      ]);
      return result === undefined ? undefined : Number(result) > 0;
    },
  };
}

export const classpilotStaffPresenceStore = createClasspilotStaffPresenceStore();

async function boundedPresenceOperation<T>(
  operation: () => Promise<T>,
  fallback: T
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(operation).catch(() => fallback),
      new Promise<T>((resolve) => {
        timer = setTimeout(
          () => resolve(fallback),
          CLASSPILOT_STAFF_PRESENCE_OPERATION_TIMEOUT_MS
        );
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function touchClasspilotStaffPresence(
  store: ClasspilotStaffPresenceStore,
  schoolId: string,
  userId: string,
  connectionId: string,
  observedAt?: Date
): Promise<boolean> {
  if (store === classpilotStaffPresenceStore) {
    // The Redis implementation owns an AbortSignal-backed timeout. Avoid an
    // outer Promise.race that could let a timed-out touch finish after a later
    // disconnect removal.
    return store.touch(schoolId, userId, connectionId, observedAt).catch(() => false);
  }
  return boundedPresenceOperation(
    () => store.touch(schoolId, userId, connectionId, observedAt),
    false
  );
}

export function removeClasspilotStaffPresence(
  store: ClasspilotStaffPresenceStore,
  schoolId: string,
  userId: string,
  connectionId: string
): Promise<boolean> {
  if (store === classpilotStaffPresenceStore) {
    return store.remove(schoolId, userId, connectionId).catch(() => false);
  }
  return boundedPresenceOperation(
    () => store.remove(schoolId, userId, connectionId),
    false
  );
}

export function readClasspilotStaffPresence(
  store: Pick<ClasspilotStaffPresenceStore, "isFresh">,
  schoolId: string,
  userId: string,
  now?: Date
): Promise<boolean | undefined> {
  if (store === classpilotStaffPresenceStore) {
    return store.isFresh(schoolId, userId, now).catch(() => undefined);
  }
  return boundedPresenceOperation(
    () => store.isFresh(schoolId, userId, now),
    undefined
  );
}

/**
 * Resolve staff presence across API processes. Local presence is authoritative
 * when using the production store; an injected store intentionally represents
 * a separate process and therefore bypasses this process's socket registry.
 */
export async function isClasspilotStaffUserConnected(
  schoolId: string,
  userId: string,
  options: {
    presenceStore?: Pick<ClasspilotStaffPresenceStore, "isFresh">;
    now?: Date;
  } = {}
): Promise<boolean> {
  if (!options.presenceStore && isStaffUserConnectedLocal(schoolId, userId)) {
    return true;
  }
  const store = options.presenceStore ?? classpilotStaffPresenceStore;
  return (await readClasspilotStaffPresence(store, schoolId, userId, options.now)) === true;
}
