import crypto from "node:crypto";
import jwt from "jsonwebtoken";
import { and, eq } from "drizzle-orm";
import db from "../db.js";
import { productLicenses, schools, type School } from "../schema/core.js";
import { comparePassword } from "../util/password.js";
import {
  recordPasspilotKioskCounter,
  recordPasspilotKioskTiming,
} from "./passpilotKioskMetrics.js";

const KIOSK_TOKEN_TTL_SECONDS = 15 * 60;
const KIOSK_PIN_CACHE_TTL_MS = 5 * 60 * 1_000;
const KIOSK_PIN_CACHE_MAX_ENTRIES = 4_096;
const KIOSK_TOKEN_ISSUER = "schoolpilot-api";
const KIOSK_TOKEN_AUDIENCE = "passpilot-kiosk";

const isProduction = process.env.NODE_ENV === "production";
const configuredSecret = process.env.KIOSK_TOKEN_SECRET || process.env.JWT_SECRET;
if (isProduction && !configuredSecret) {
  throw new Error(
    "FATAL: KIOSK_TOKEN_SECRET or JWT_SECRET is required in production"
  );
}
const KIOSK_AUTH_SECRET = configuredSecret || crypto.randomBytes(32).toString("hex");

export type PasspilotKioskCredentialMethod = "pin" | "token";

type PasspilotLicense = typeof productLicenses.$inferSelect;

export type PasspilotKioskAuthorizationState = {
  school: School;
  license: PasspilotLicense;
  fingerprint: string;
};

export type PasspilotKioskAuthorizationResult =
  | {
      ok: true;
      method: PasspilotKioskCredentialMethod;
      state: PasspilotKioskAuthorizationState;
    }
  | {
      ok: false;
      status: number;
      error: string;
      code?: string;
    };

type PasspilotKioskAuthorizationFailure = Extract<
  PasspilotKioskAuthorizationResult,
  { ok: false }
>;

type KioskTokenPayload = jwt.JwtPayload & {
  kind: "passpilot_kiosk";
  schoolId: string;
  fingerprint: string;
};

/**
 * Success-only, insertion-bounded cache. Callers supply an HMAC digest; raw
 * PINs and concatenated raw secrets are never retained by this object.
 */
export class KioskPinSuccessCache {
  private readonly entries = new Map<string, number>();

  constructor(
    readonly maxEntries = KIOSK_PIN_CACHE_MAX_ENTRIES,
    readonly ttlMs = KIOSK_PIN_CACHE_TTL_MS
  ) {
    if (!Number.isInteger(maxEntries) || maxEntries <= 0) {
      throw new Error("kiosk_pin_cache_max_entries_invalid");
    }
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
      throw new Error("kiosk_pin_cache_ttl_invalid");
    }
  }

  has(digest: string, nowMs = Date.now()): boolean {
    const expiresAt = this.entries.get(digest);
    if (expiresAt === undefined) return false;
    if (expiresAt <= nowMs) {
      this.entries.delete(digest);
      return false;
    }
    return true;
  }

  remember(digest: string, nowMs = Date.now()): void {
    this.pruneExpired(nowMs);
    if (this.entries.has(digest)) this.entries.delete(digest);
    while (this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next().value as string | undefined;
      if (!oldest) break;
      this.entries.delete(oldest);
    }
    this.entries.set(digest, nowMs + this.ttlMs);
  }

  clear(): void {
    this.entries.clear();
  }

  get size(): number {
    return this.entries.size;
  }

  private pruneExpired(nowMs: number): void {
    for (const [digest, expiresAt] of this.entries) {
      if (expiresAt <= nowMs) this.entries.delete(digest);
    }
  }
}

const pinSuccessCache = new KioskPinSuccessCache();

function hmac(parts: readonly string[]): string {
  return crypto
    .createHmac("sha256", KIOSK_AUTH_SECRET)
    .update(JSON.stringify(parts))
    .digest("base64url");
}

function schoolIsActive(school: School, now: Date): boolean {
  return (
    school.status === "active" &&
    school.isActive !== false &&
    !school.disabledAt &&
    !school.deletedAt &&
    school.planStatus !== "canceled" &&
    (!school.activeUntil || school.activeUntil.getTime() > now.getTime())
  );
}

function licenseIsActive(license: PasspilotLicense | null, now: Date): license is PasspilotLicense {
  return Boolean(
    license &&
      license.status === "active" &&
      (!license.expiresAt || license.expiresAt.getTime() > now.getTime())
  );
}

function authorizationFingerprint(school: School, license: PasspilotLicense): string {
  return hmac([
    "passpilot-kiosk-fingerprint-v1",
    school.id,
    school.status,
    school.isActive ? "1" : "0",
    school.disabledAt?.toISOString() ?? "",
    school.deletedAt?.toISOString() ?? "",
    school.planStatus,
    school.activeUntil?.toISOString() ?? "",
    school.kioskEnabled ? "1" : "0",
    school.kioskPinHash ?? "",
    license.id,
    license.status,
    license.expiresAt?.toISOString() ?? "",
  ]);
}

async function loadAuthorizationState(
  schoolId: string,
  now: Date
): Promise<PasspilotKioskAuthorizationFailure | PasspilotKioskAuthorizationState> {
  recordPasspilotKioskCounter("authorizationSqlStatements");
  const [row] = await db
    .select({ school: schools, license: productLicenses })
    .from(schools)
    .leftJoin(
      productLicenses,
      and(
        eq(productLicenses.schoolId, schools.id),
        eq(productLicenses.product, "PASSPILOT")
      )
    )
    .where(eq(schools.id, schoolId))
    .limit(1);

  if (!row?.school) {
    return { ok: false, error: "School not found", status: 400 };
  }
  if (!schoolIsActive(row.school, now)) {
    return {
      ok: false,
      error: "School subscription inactive",
      status: 403,
      code: "PASSPILOT_KIOSK_SCHOOL_INACTIVE",
    };
  }
  if (!licenseIsActive(row.license, now)) {
    return {
      ok: false,
      error: "PassPilot license required",
      status: 403,
      code: "PASSPILOT_KIOSK_LICENSE_REQUIRED",
    };
  }
  if (row.school.kioskEnabled === false) {
    return { ok: false, error: "Kiosk is not enabled", status: 403 };
  }
  if (!row.school.kioskPinHash) {
    return {
      ok: false,
      error:
        "Kiosk PIN not configured. An administrator must set a kiosk PIN in PassPilot Setup → Settings.",
      status: 403,
    };
  }
  return {
    school: row.school,
    license: row.license,
    fingerprint: authorizationFingerprint(row.school, row.license),
  };
}

function isFailure(
  result: PasspilotKioskAuthorizationFailure | PasspilotKioskAuthorizationState
): result is PasspilotKioskAuthorizationFailure {
  return "ok" in result && result.ok === false;
}

function pinCacheDigest(schoolId: string, currentPinHash: string, pin: string): string {
  return hmac(["passpilot-kiosk-pin-success-v1", schoolId, currentPinHash, pin]);
}

async function authorizePin(
  state: PasspilotKioskAuthorizationState,
  pin: string | undefined,
  nowMs: number
): Promise<boolean> {
  if (!pin || pin.length > 256) return false;
  const digest = pinCacheDigest(state.school.id, state.school.kioskPinHash!, pin);
  if (pinSuccessCache.has(digest, nowMs)) {
    recordPasspilotKioskCounter("authorizationPinCacheHit");
    return true;
  }
  recordPasspilotKioskCounter("authorizationBcrypt");
  const accepted = await comparePassword(pin, state.school.kioskPinHash!);
  if (accepted) pinSuccessCache.remember(digest, nowMs);
  return accepted;
}

function authorizeToken(
  state: PasspilotKioskAuthorizationState,
  token: string
): boolean {
  if (!token || token.length > 4_096) return false;
  try {
    const payload = jwt.verify(token, KIOSK_AUTH_SECRET, {
      algorithms: ["HS256"],
      issuer: KIOSK_TOKEN_ISSUER,
      audience: KIOSK_TOKEN_AUDIENCE,
    }) as KioskTokenPayload;
    return (
      payload.kind === "passpilot_kiosk" &&
      payload.schoolId === state.school.id &&
      typeof payload.fingerprint === "string" &&
      payload.fingerprint.length === state.fingerprint.length &&
      crypto.timingSafeEqual(
        Buffer.from(payload.fingerprint),
        Buffer.from(state.fingerprint)
      )
    );
  } catch {
    return false;
  }
}

export async function authorizePasspilotKiosk(options: {
  schoolId: string;
  token?: string;
  pin?: string;
  now?: Date;
}): Promise<PasspilotKioskAuthorizationResult> {
  const startedAt = performance.now();
  recordPasspilotKioskCounter("authorizationRequests");
  try {
    const now = options.now ?? new Date();
    const loaded = await loadAuthorizationState(options.schoolId, now);
    if (isFailure(loaded)) return loaded;

    // A presented token is authoritative. Never silently downgrade a bad or
    // revoked token to a concurrently supplied legacy PIN.
    if (options.token !== undefined) {
      const accepted = authorizeToken(loaded, options.token);
      recordPasspilotKioskCounter(
        accepted ? "authorizationTokenSuccess" : "authorizationTokenFailure"
      );
      return accepted
        ? { ok: true, method: "token", state: loaded }
        : {
            ok: false,
            status: 401,
            error: "Invalid kiosk token",
            code: "PASSPILOT_KIOSK_TOKEN_INVALID",
          };
    }

    const accepted = await authorizePin(loaded, options.pin, now.getTime());
    recordPasspilotKioskCounter(
      accepted ? "authorizationPinSuccess" : "authorizationPinFailure"
    );
    return accepted
      ? { ok: true, method: "pin", state: loaded }
      : { ok: false, status: 401, error: "Invalid kiosk PIN" };
  } finally {
    recordPasspilotKioskTiming("authorizationMs", performance.now() - startedAt);
  }
}

export function issuePasspilotKioskToken(
  state: PasspilotKioskAuthorizationState,
  now = new Date()
): { token: string; expiresAt: Date; expiresInSeconds: number } {
  const expiresAt = new Date(now.getTime() + KIOSK_TOKEN_TTL_SECONDS * 1_000);
  const token = jwt.sign(
    {
      kind: "passpilot_kiosk",
      schoolId: state.school.id,
      fingerprint: state.fingerprint,
    } satisfies Omit<KioskTokenPayload, keyof jwt.JwtPayload>,
    KIOSK_AUTH_SECRET,
    {
      algorithm: "HS256",
      issuer: KIOSK_TOKEN_ISSUER,
      audience: KIOSK_TOKEN_AUDIENCE,
      expiresIn: KIOSK_TOKEN_TTL_SECONDS,
      noTimestamp: false,
    }
  );
  return { token, expiresAt, expiresInSeconds: KIOSK_TOKEN_TTL_SECONDS };
}

export function resetPasspilotKioskAuthStateForTests(): void {
  pinSuccessCache.clear();
}

export function snapshotPasspilotKioskAuthStateForTests(): {
  pinSuccessCacheSize: number;
  pinSuccessCacheMaxEntries: number;
  pinSuccessCacheTtlMs: number;
} {
  return {
    pinSuccessCacheSize: pinSuccessCache.size,
    pinSuccessCacheMaxEntries: pinSuccessCache.maxEntries,
    pinSuccessCacheTtlMs: pinSuccessCache.ttlMs,
  };
}
