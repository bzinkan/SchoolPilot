import { createHmac } from "node:crypto";
import { redisCommand } from "../middleware/rateLimiter.js";

export const CLASSPILOT_STUDENT_AUTH_GATE_PRESENCE_TTL_SECONDS = 30;
export const CLASSPILOT_STUDENT_AUTH_GATE_PRESENCE_RENEW_SECONDS = 10;
export const CLASSPILOT_STUDENT_AUTH_GATE_STALE_AFTER_MS = 60_000;
export const CLASSPILOT_STUDENT_AUTH_GATE_MAX_BATCH_SIZE = 500;

const REDIS_READY_TIMEOUT_MS = 200;
const MAX_LOCAL_PRESENCES = 10_000;

export type ClasspilotStudentAuthGateBinding = {
  schoolId: string;
  studentId: string;
  studentSessionId: string;
  deviceId: string;
};

export type ClasspilotStudentAuthGatePresence = {
  observedAt: number;
  expiresAt: number;
};

export type ClasspilotStudentAuthGatePresenceReadResult =
  | { status: "present"; presence: ClasspilotStudentAuthGatePresence }
  | { status: "absent" | "unavailable" | "rejected" };

type StoredPresence = {
  v: 1;
  observedAt: number;
};

type RedisCommand = typeof redisCommand;

const localPresences = new Map<string, ClasspilotStudentAuthGatePresence>();

function productionRuntime(): boolean {
  return process.env.NODE_ENV === "production" || process.env.APP_ENV === "production";
}

function sharedStoreRequired(): boolean {
  return Boolean(process.env.REDIS_URL || productionRuntime());
}

function gatePresenceSecret(): string {
  const configured = process.env.CLASSPILOT_KIOSK_TICKET_HMAC_SECRET
    || process.env.SESSION_SECRET
    || process.env.JWT_SECRET;
  if (!configured && productionRuntime()) {
    throw new Error("ClassPilot student auth-gate presence HMAC secret is unavailable");
  }
  return configured || "classpilot-student-auth-gate-development-only";
}

function bindingDigest(binding: ClasspilotStudentAuthGateBinding): string {
  return createHmac("sha256", gatePresenceSecret())
    .update("classpilot:student-auth-gate-presence:v1")
    .update("\u0000")
    .update(binding.schoolId)
    .update("\u0000")
    .update(binding.studentId)
    .update("\u0000")
    .update(binding.studentSessionId)
    .update("\u0000")
    .update(binding.deviceId)
    .digest("base64url");
}

export function classpilotStudentAuthGatePresenceKey(
  binding: ClasspilotStudentAuthGateBinding
): string {
  const prefix = process.env.REDIS_PREFIX ?? "schoolpilot";
  return `${prefix}:classpilot:student-auth-gate:v1:${bindingDigest(binding)}`;
}

function pruneLocal(now: number): void {
  for (const [key, presence] of localPresences) {
    if (presence.expiresAt <= now) localPresences.delete(key);
  }
  while (localPresences.size >= MAX_LOCAL_PRESENCES) {
    const oldest = localPresences.keys().next().value as string | undefined;
    if (!oldest) break;
    localPresences.delete(oldest);
  }
}

function decodePresence(raw: unknown, now: number): ClasspilotStudentAuthGatePresenceReadResult {
  if (raw === null) return { status: "absent" };
  if (typeof raw !== "string" || raw.length > 256) return { status: "rejected" };
  try {
    const parsed = JSON.parse(raw) as Partial<StoredPresence>;
    if (
      parsed.v !== 1
      || !Number.isSafeInteger(parsed.observedAt)
      || (parsed.observedAt ?? 0) <= 0
      || (parsed.observedAt ?? 0) > now + 5_000
    ) {
      return { status: "rejected" };
    }
    const observedAt = parsed.observedAt!;
    const expiresAt = observedAt
      + CLASSPILOT_STUDENT_AUTH_GATE_PRESENCE_TTL_SECONDS * 1_000;
    return expiresAt > now
      ? { status: "present", presence: { observedAt, expiresAt } }
      : { status: "absent" };
  } catch {
    return { status: "rejected" };
  }
}

export function createClasspilotStudentAuthGatePresenceStore(
  command: RedisCommand = redisCommand
) {
  async function renew(
    binding: ClasspilotStudentAuthGateBinding,
    now = Date.now()
  ): Promise<ClasspilotStudentAuthGatePresenceReadResult> {
    if (!Number.isSafeInteger(now) || now <= 0) {
      throw new TypeError("Invalid ClassPilot auth-gate presence timestamp");
    }
    const key = classpilotStudentAuthGatePresenceKey(binding);
    const payload = JSON.stringify({ v: 1, observedAt: now } satisfies StoredPresence);
    if (sharedStoreRequired() && !process.env.REDIS_URL) {
      return { status: "unavailable" };
    }
    try {
      const result = await command([
        "SET",
        key,
        payload,
        "EX",
        String(CLASSPILOT_STUDENT_AUTH_GATE_PRESENCE_TTL_SECONDS),
      ], { readyTimeoutMs: REDIS_READY_TIMEOUT_MS });
      if (result === "OK") {
        return {
          status: "present",
          presence: {
            observedAt: now,
            expiresAt: now + CLASSPILOT_STUDENT_AUTH_GATE_PRESENCE_TTL_SECONDS * 1_000,
          },
        };
      }
      if (result !== undefined || sharedStoreRequired()) return { status: "unavailable" };
    } catch {
      if (sharedStoreRequired()) return { status: "unavailable" };
    }
    pruneLocal(now);
    const presence = {
      observedAt: now,
      expiresAt: now + CLASSPILOT_STUDENT_AUTH_GATE_PRESENCE_TTL_SECONDS * 1_000,
    };
    localPresences.delete(key);
    localPresences.set(key, presence);
    return { status: "present", presence };
  }

  async function readBatch(
    bindings: readonly ClasspilotStudentAuthGateBinding[],
    now = Date.now()
  ): Promise<Map<string, ClasspilotStudentAuthGatePresenceReadResult>> {
    const unique = [...new Map(bindings.map((binding) => [binding.studentSessionId, binding])).values()];
    const results = new Map<string, ClasspilotStudentAuthGatePresenceReadResult>();
    if (unique.length === 0) return results;
    if (sharedStoreRequired() && !process.env.REDIS_URL) {
      for (const binding of unique) results.set(binding.studentSessionId, { status: "unavailable" });
      return results;
    }
    if (process.env.REDIS_URL) {
      for (let offset = 0; offset < unique.length; offset += CLASSPILOT_STUDENT_AUTH_GATE_MAX_BATCH_SIZE) {
        const chunk = unique.slice(offset, offset + CLASSPILOT_STUDENT_AUTH_GATE_MAX_BATCH_SIZE);
        let raw: unknown;
        try {
          raw = await command([
            "MGET",
            ...chunk.map((binding) => classpilotStudentAuthGatePresenceKey(binding)),
          ], { readyTimeoutMs: REDIS_READY_TIMEOUT_MS });
        } catch {
          raw = undefined;
        }
        if (!Array.isArray(raw) || raw.length !== chunk.length) {
          for (const binding of chunk) {
            results.set(binding.studentSessionId, { status: "unavailable" });
          }
          continue;
        }
        chunk.forEach((binding, index) => {
          results.set(binding.studentSessionId, decodePresence(raw[index], now));
        });
      }
      return results;
    }
    pruneLocal(now);
    for (const binding of unique) {
      const presence = localPresences.get(classpilotStudentAuthGatePresenceKey(binding));
      results.set(binding.studentSessionId, presence && presence.expiresAt > now
        ? { status: "present", presence: { ...presence } }
        : { status: "absent" });
    }
    return results;
  }

  async function read(
    binding: ClasspilotStudentAuthGateBinding,
    now = Date.now()
  ): Promise<ClasspilotStudentAuthGatePresenceReadResult> {
    return (await readBatch([binding], now)).get(binding.studentSessionId)
      ?? { status: "unavailable" };
  }

  function resetLocal(): void {
    localPresences.clear();
  }

  return { renew, read, readBatch, resetLocal };
}

const store = createClasspilotStudentAuthGatePresenceStore();

export const renewClasspilotStudentAuthGatePresence = store.renew;
export const readClasspilotStudentAuthGatePresence = store.read;
export const readClasspilotStudentAuthGatePresenceBatch = store.readBatch;

export function resetClasspilotStudentAuthGatePresenceForTests(): void {
  store.resetLocal();
}
