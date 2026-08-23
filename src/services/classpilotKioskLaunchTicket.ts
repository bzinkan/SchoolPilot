/**
 * One-use ClassPilot -> PassPilot kiosk continuity tickets.
 *
 * The Chrome directory device identifier is reduced immediately to a
 * school-scoped HMAC-derived UUID. The raw enterprise identifier is never
 * written to Redis, process state, logs, URLs, or responses. Production uses
 * Redis GETDEL so a ticket can be redeemed exactly once across API tasks;
 * tests and local development use the same bounded semantics in process.
 */
import crypto from "node:crypto";
import { z } from "zod";
import { redisCommand } from "../middleware/rateLimiter.js";

export const CLASSPILOT_KIOSK_LAUNCH_TICKET_V1_TTL_SECONDS = 60;
export const CLASSPILOT_KIOSK_LAUNCH_TICKET_V2_TTL_SECONDS = 600;
// Retained for callers/tests that exercise the legacy V1 contract.
export const CLASSPILOT_KIOSK_LAUNCH_TICKET_TTL_SECONDS =
  CLASSPILOT_KIOSK_LAUNCH_TICKET_V1_TTL_SECONDS;
const TICKET_TTL_MS = CLASSPILOT_KIOSK_LAUNCH_TICKET_TTL_SECONDS * 1_000;
const MAX_LOCAL_TICKETS = 4_096;
const TICKET_PATTERN = /^[A-Za-z0-9_-]{43}$/;

const configuredSecret =
  process.env.CLASSPILOT_KIOSK_TICKET_HMAC_SECRET ||
  process.env.KIOSK_TOKEN_SECRET ||
  process.env.JWT_SECRET;
if (process.env.NODE_ENV === "production" && !configuredSecret) {
  throw new Error(
    "FATAL: CLASSPILOT_KIOSK_TICKET_HMAC_SECRET, KIOSK_TOKEN_SECRET, or JWT_SECRET is required in production"
  );
}
const ticketSecret = Buffer.from(
  configuredSecret || "schoolpilot-development-classpilot-kiosk-ticket-secret"
);

export const classpilotKioskLaunchTicketRequestSchema = z
  .object({
    directoryDeviceId: z.string().trim().min(1).max(512),
    clientProtocolVersion: z.number().int().min(1).max(100),
    capabilities: z.array(z.string().trim().min(1).max(64)).max(32),
  })
  .strict();

export const classpilotKioskLaunchTicketPreflightSchema = z
  .object({
    clientProtocolVersion: z.number().int().min(1).max(100),
    capabilities: z.array(z.string().trim().min(1).max(64)).max(32),
  })
  .strict();

export const passpilotKioskLaunchTicketRedemptionSchema = z
  .object({
    ticket: z.string().trim().regex(TICKET_PATTERN),
  })
  .strict();

type LaunchTicketRecordV1 = {
  version: 1;
  schoolId: string;
  deviceId: string;
  issuedAt: number;
  expiresAt: number;
};

type LaunchTicketRecordV2 = {
  version: 2;
  schoolId: string;
  deviceId: string;
  legacyDeviceId: string;
  issuedAt: number;
  expiresAt: number;
};

type LaunchTicketRecord = LaunchTicketRecordV1 | LaunchTicketRecordV2;

type LocalTicketRecord = {
  value: string;
  expiresAt: number;
};

/** Bounded insertion-order store used only when Redis is not configured. */
export class BoundedClasspilotKioskLaunchTicketStore {
  private readonly entries = new Map<string, LocalTicketRecord>();

  constructor(
    readonly maxEntries = MAX_LOCAL_TICKETS,
    readonly ttlMs = TICKET_TTL_MS
  ) {
    if (!Number.isInteger(maxEntries) || maxEntries <= 0) {
      throw new Error("classpilot_kiosk_ticket_max_entries_invalid");
    }
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
      throw new Error("classpilot_kiosk_ticket_ttl_invalid");
    }
  }

  set(key: string, value: string, now = Date.now(), ttlMs = this.ttlMs): void {
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
      throw new Error("classpilot_kiosk_ticket_ttl_invalid");
    }
    this.prune(now);
    if (this.entries.has(key)) this.entries.delete(key);
    while (this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next().value as string | undefined;
      if (!oldest) break;
      this.entries.delete(oldest);
    }
    this.entries.set(key, { value, expiresAt: now + ttlMs });
  }

  getdel(key: string, now = Date.now()): string | null {
    const record = this.entries.get(key);
    if (!record) return null;
    this.entries.delete(key);
    return record.expiresAt > now ? record.value : null;
  }

  clear(): void {
    this.entries.clear();
  }

  get size(): number {
    return this.entries.size;
  }

  private prune(now: number): void {
    for (const [key, record] of this.entries) {
      if (record.expiresAt <= now) this.entries.delete(key);
    }
  }
}

const localTickets = new BoundedClasspilotKioskLaunchTicketStore();

function hmac(domain: string, values: readonly string[]): Buffer {
  return crypto
    .createHmac("sha256", ticketSecret)
    .update(JSON.stringify([domain, ...values]))
    .digest();
}

function ticketStorageKey(ticket: string): string {
  const digest = hmac("classpilot-kiosk-launch-ticket-key-v1", [ticket]).toString(
    "base64url"
  );
  const prefix = process.env.REDIS_PREFIX ?? "schoolpilot";
  return `${prefix}:classpilot:kiosk-launch-ticket:${digest}`;
}

/**
 * Stable only inside one school. Version-8/variant-1 bits make the opaque
 * 128-bit HMAC projection compatible with the existing strict kiosk UUID
 * header without pretending it is the raw enterprise identifier.
 */
export function schoolScopedManagedKioskDeviceId(
  schoolId: string,
  directoryDeviceId: string
): string {
  const bytes = Buffer.from(
    hmac("classpilot-managed-kiosk-device-v1", [schoolId, directoryDeviceId]).subarray(0, 16)
  );
  bytes[6] = (bytes[6]! & 0x0f) | 0x80;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Exact ClassPilot 2.6.9 projection used only to migrate existing bindings. */
export function legacyManagedKioskDeviceId(directoryDeviceId: string): string {
  const hex = crypto
    .createHash("sha256")
    .update(`classpilot-kiosk-device:${directoryDeviceId}`)
    .digest("hex")
    .slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function serviceUnavailable(): Error {
  return Object.assign(new Error("Kiosk launch ticket service unavailable"), {
    status: 503,
    code: "CLASSPILOT_KIOSK_LAUNCH_TICKET_UNAVAILABLE",
    expose: true,
  });
}

function parseTicketRecord(value: unknown): LaunchTicketRecord | null {
  if (typeof value !== "string" || value.length > 2_048) return null;
  try {
    const record = JSON.parse(value) as Partial<LaunchTicketRecord>;
    if (
      (record.version !== 1 && record.version !== 2) ||
      typeof record.schoolId !== "string" ||
      record.schoolId.length < 1 ||
      record.schoolId.length > 128 ||
      typeof record.deviceId !== "string" ||
      !/^[0-9a-f-]{36}$/.test(record.deviceId) ||
      !Number.isSafeInteger(record.issuedAt) ||
      !Number.isSafeInteger(record.expiresAt)
    ) {
      return null;
    }
    if (
      record.version === 2
      && (
        typeof (record as Partial<LaunchTicketRecordV2>).legacyDeviceId !== "string"
        || !/^[0-9a-f-]{36}$/.test(
          (record as Partial<LaunchTicketRecordV2>).legacyDeviceId || ""
        )
      )
    ) {
      return null;
    }
    return record as LaunchTicketRecord;
  } catch {
    return null;
  }
}

export async function issueClasspilotKioskLaunchTicket(options: {
  schoolId: string;
  directoryDeviceId: string;
  version?: 1 | 2;
  now?: number;
}): Promise<{
  ticket: string;
  expiresAt: Date;
  expiresInSeconds: number;
}> {
  const now = options.now ?? Date.now();
  const version = options.version ?? 1;
  const ttlSeconds = version === 2
    ? CLASSPILOT_KIOSK_LAUNCH_TICKET_V2_TTL_SECONDS
    : CLASSPILOT_KIOSK_LAUNCH_TICKET_V1_TTL_SECONDS;
  const ttlMs = ttlSeconds * 1_000;
  const common = {
    schoolId: options.schoolId,
    deviceId: schoolScopedManagedKioskDeviceId(
      options.schoolId,
      options.directoryDeviceId
    ),
    issuedAt: now,
    expiresAt: now + ttlMs,
  };
  const record: LaunchTicketRecord = version === 2
    ? {
        version: 2,
        ...common,
        legacyDeviceId: legacyManagedKioskDeviceId(options.directoryDeviceId),
      }
    : { version: 1, ...common };
  const value = JSON.stringify(record);

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const ticket = crypto.randomBytes(32).toString("base64url");
    const key = ticketStorageKey(ticket);
    if (process.env.REDIS_URL) {
      let result: unknown;
      try {
        result = await redisCommand(
          [
            "SET",
            key,
            value,
            "NX",
            "EX",
            String(ttlSeconds),
          ],
          { readyTimeoutMs: 500 }
        );
      } catch {
        throw serviceUnavailable();
      }
      if (result === "OK") {
        return {
          ticket,
          expiresAt: new Date(record.expiresAt),
          expiresInSeconds: ttlSeconds,
        };
      }
      if (result === null) continue;
      throw serviceUnavailable();
    }

    if (process.env.NODE_ENV === "production") throw serviceUnavailable();
    localTickets.set(key, value, now, ttlMs);
    return {
      ticket,
      expiresAt: new Date(record.expiresAt),
      expiresInSeconds: ttlSeconds,
    };
  }

  throw serviceUnavailable();
}

/**
 * Atomically consumes the ticket. A wrong-school presentation is deliberately
 * indistinguishable from a missing/expired ticket and still burns the ticket.
 */
export async function consumeClasspilotKioskLaunchTicket(options: {
  ticket: string;
  schoolId: string;
  now?: number;
}): Promise<{
  deviceId: string;
  legacyDeviceId: string | null;
  ticketVersion: 1 | 2;
} | null> {
  if (!TICKET_PATTERN.test(options.ticket)) return null;
  const now = options.now ?? Date.now();
  const key = ticketStorageKey(options.ticket);
  let raw: unknown;

  if (process.env.REDIS_URL) {
    try {
      raw = await redisCommand(["GETDEL", key], { readyTimeoutMs: 500 });
    } catch {
      throw serviceUnavailable();
    }
    if (raw === undefined) throw serviceUnavailable();
  } else {
    if (process.env.NODE_ENV === "production") throw serviceUnavailable();
    raw = localTickets.getdel(key, now);
  }

  const record = parseTicketRecord(raw);
  if (
    !record ||
    record.expiresAt <= now ||
    record.issuedAt > now + 5_000 ||
    record.schoolId !== options.schoolId
  ) {
    return null;
  }
  return {
    deviceId: record.deviceId,
    legacyDeviceId: record.version === 2 ? record.legacyDeviceId : null,
    ticketVersion: record.version,
  };
}

export function resetClasspilotKioskLaunchTicketStateForTests(): void {
  if (process.env.NODE_ENV !== "production") localTickets.clear();
}

export function snapshotClasspilotKioskLaunchTicketStateForTests(): {
  size: number;
  maxEntries: number;
  ttlMs: number;
} {
  return {
    size: localTickets.size,
    maxEntries: localTickets.maxEntries,
    ttlMs: localTickets.ttlMs,
  };
}
