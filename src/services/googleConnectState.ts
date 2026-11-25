/**
 * One-time `state` for the consent flow that connects a staff member's Google
 * account (GET /api/google/auth-url, then GET /api/google/callback).
 *
 * The callback has no bearer token because Google's redirect is a plain browser
 * navigation, so everything it acts on must come from here: the state is an
 * opaque random value and the user, school, purpose and return URL stay on the
 * server. A record is bound to the web session that started the flow, expires
 * after ten minutes and is removed by the first attempt to use it.
 *
 * Records live in Redis rather than in the session. Dashboard polls can save a
 * session they loaded earlier, which could drop a new state or restore a used
 * one; GETDEL makes consumption atomic across API tasks. The binding uses the
 * existing session cookie because staging's CloudFront forwards only that
 * cookie and the load balancer's, so a new cookie would not reach the API.
 *
 * As with authCodeExchange, development and tests may use a bounded in-process
 * store when Redis is not configured. Production fails closed.
 */
import crypto from "crypto";
import { redisCommand } from "../middleware/rateLimiter.js";
import { safeCompare } from "../util/safeCompare.js";
import { hmacSecret } from "./authCodeExchange.js";

export type GoogleConnectPurpose = "workspace_import" | "classroom_resources";

export interface GoogleConnectGrant {
  userId: string;
  schoolId: string;
  purpose: GoogleConnectPurpose;
  returnTo: string | null;
}

interface StoredGrant extends GoogleConnectGrant {
  sessionBinding: string;
  expiresAt: number;
}

export const GOOGLE_CONNECT_STATE_TTL_SECONDS = 10 * 60;
const STATE_TTL_MS = GOOGLE_CONNECT_STATE_TTL_SECONDS * 1_000;
const STATE_FORMAT = /^[A-Za-z0-9_-]{43}$/;
const MAX_LOCAL_STATES = 1_024;
const UNAVAILABLE = "Google connection state service unavailable";
const localStates = new Map<string, StoredGrant>();

function productionMode(): boolean {
  return process.env.NODE_ENV === "production";
}

function redisConfigured(): boolean {
  return Boolean(process.env.REDIS_URL);
}

function keyedDigest(purpose: string, value: string): string {
  return crypto
    .createHmac("sha256", hmacSecret())
    .update(`google-connect-${purpose}:${value}`)
    .digest("base64url");
}

function redisKey(state: string): string {
  const prefix = process.env.REDIS_PREFIX ?? "schoolpilot";
  return `${prefix}:google-connect-state:${keyedDigest("state", state)}`;
}

function pruneLocalStates(now = Date.now()): void {
  for (const [key, record] of localStates) {
    if (record.expiresAt <= now) localStates.delete(key);
  }
  while (localStates.size >= MAX_LOCAL_STATES) {
    const oldest = localStates.keys().next().value;
    if (oldest === undefined) break;
    localStates.delete(oldest);
  }
}

function parseStoredGrant(raw: string): StoredGrant | null {
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== "object" || value === null) return null;
    const { userId, schoolId, purpose, returnTo, sessionBinding, expiresAt } =
      value as Record<string, unknown>;
    if (
      typeof userId !== "string" || !userId ||
      typeof schoolId !== "string" || !schoolId ||
      (purpose !== "workspace_import" && purpose !== "classroom_resources") ||
      (returnTo !== null && typeof returnTo !== "string") ||
      typeof sessionBinding !== "string" ||
      typeof expiresAt !== "number"
    ) {
      return null;
    }
    return { userId, schoolId, purpose, returnTo, sessionBinding, expiresAt };
  } catch {
    return null;
  }
}

async function takeFromRedis(state: string): Promise<StoredGrant | null> {
  let result: unknown;
  try {
    result = await redisCommand(["GETDEL", redisKey(state)], {
      readyTimeoutMs: 1_000,
    });
  } catch {
    throw new Error(UNAVAILABLE);
  }
  if (result === null) return null;
  if (typeof result !== "string") throw new Error(UNAVAILABLE);
  return parseStoredGrant(result);
}

/** Stores a grant for this session and returns its opaque state value. */
export async function issueGoogleConnectState(
  sessionId: string,
  grant: GoogleConnectGrant
): Promise<string> {
  if (!sessionId) throw new TypeError("A web session is required");
  const record: StoredGrant = {
    ...grant,
    sessionBinding: keyedDigest("session", sessionId),
    expiresAt: Date.now() + STATE_TTL_MS,
  };

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const state = crypto.randomBytes(32).toString("base64url");
    if (redisConfigured()) {
      let result: unknown;
      try {
        result = await redisCommand(
          [
            "SET",
            redisKey(state),
            JSON.stringify(record),
            "EX",
            String(GOOGLE_CONNECT_STATE_TTL_SECONDS),
            "NX",
          ],
          { readyTimeoutMs: 1_000 }
        );
      } catch {
        throw new Error(UNAVAILABLE);
      }
      if (result === "OK") return state;
      if (result === null) continue;
      throw new Error(UNAVAILABLE);
    }

    if (productionMode()) throw new Error(UNAVAILABLE);
    pruneLocalStates();
    localStates.set(keyedDigest("state", state), record);
    return state;
  }

  throw new Error("Unable to allocate a Google connection state");
}

/**
 * Removes the record and returns its grant only if it is unexpired and belongs
 * to this session. Any failed attempt also burns the record.
 */
export async function consumeGoogleConnectState(
  state: string,
  sessionId: string
): Promise<GoogleConnectGrant | null> {
  if (!STATE_FORMAT.test(state) || !sessionId) return null;

  let record: StoredGrant | null;
  if (redisConfigured()) {
    record = await takeFromRedis(state);
  } else {
    if (productionMode()) throw new Error(UNAVAILABLE);
    const key = keyedDigest("state", state);
    record = localStates.get(key) ?? null;
    localStates.delete(key);
  }

  if (!record || record.expiresAt <= Date.now()) return null;
  if (!safeCompare(record.sessionBinding, keyedDigest("session", sessionId))) {
    return null;
  }
  return {
    userId: record.userId,
    schoolId: record.schoolId,
    purpose: record.purpose,
    returnTo: record.returnTo,
  };
}

export function resetGoogleConnectStateForTests(): void {
  if (productionMode()) return;
  localStates.clear();
}
