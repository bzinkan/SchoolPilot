import crypto from "crypto";
import { redisCommand } from "../middleware/rateLimiter.js";

export const CLASSPILOT_WS_FRAME_BUCKET_CAPACITY = 30;
export const CLASSPILOT_WS_FRAME_REFILL_PER_SECOND = 10;
export const CLASSPILOT_WS_MAX_PENDING_FRAMES = 8;
// The signed authority remains valid for the Dashboard's maximum live-view
// duration so an established peer can always be stopped/revoked. Setup has a
// separate 90-second client deadline; it must not truncate a healthy stream.
export const CLASSPILOT_LIVE_VIEW_SETUP_TTL_MS = 90_000;
export const CLASSPILOT_LIVE_VIEW_NEGOTIATION_TTL_MS = 15 * 60_000;
export const CLASSPILOT_LIVE_VIEW_MAX_LOCAL_CLAIMS = 4_096;

export type ClasspilotWsFrameBucket = {
  tokens: number;
  refilledAt: number;
};

export function createClasspilotWsFrameBucket(now = Date.now()): ClasspilotWsFrameBucket {
  return { tokens: CLASSPILOT_WS_FRAME_BUCKET_CAPACITY, refilledAt: now };
}

export function consumeClasspilotWsFrame(
  bucket: ClasspilotWsFrameBucket,
  now = Date.now()
): boolean {
  const elapsedMs = Math.max(0, now - bucket.refilledAt);
  bucket.tokens = Math.min(
    CLASSPILOT_WS_FRAME_BUCKET_CAPACITY,
    bucket.tokens + (elapsedMs / 1_000) * CLASSPILOT_WS_FRAME_REFILL_PER_SECOND
  );
  bucket.refilledAt = now;
  if (bucket.tokens < 1) return false;
  bucket.tokens -= 1;
  return true;
}

type LiveViewClaims = {
  v: 1;
  requestId: string;
  schoolId: string;
  studentId: string;
  teachingSessionId: string;
  requesterUserId: string;
  binding: string;
  expiresAt: number;
};

export type ClasspilotLiveViewBinding = {
  schoolId: string;
  studentId: string;
  studentSessionId: string;
  deviceId: string;
  teachingSessionId: string;
  requesterUserId: string;
};

const configuredSecret = process.env.JWT_SECRET;
if (process.env.NODE_ENV === "production" && !configuredSecret) {
  throw new Error("FATAL: JWT_SECRET is required for ClassPilot live-view negotiation");
}
const signingSecret = crypto
  .createHash("sha256")
  .update(`classpilot-live-view:${configuredSecret || "schoolpilot-dev-live-view-secret"}`)
  .digest();
const localClaims = new Map<string, { negotiationId: string; expiresAt: number }>();
const activeClaims = new Map<string, {
  binding: ClasspilotLiveViewBinding;
  expiresAt: number;
}>();

function pruneLocalClaims(now: number): void {
  for (const [key, claim] of localClaims) {
    if (claim.expiresAt <= now) localClaims.delete(key);
  }
  for (const [negotiationId, claim] of activeClaims) {
    if (claim.expiresAt <= now) activeClaims.delete(negotiationId);
  }
  while (localClaims.size >= CLASSPILOT_LIVE_VIEW_MAX_LOCAL_CLAIMS) {
    const oldest = localClaims.keys().next().value as string | undefined;
    if (!oldest) break;
    localClaims.delete(oldest);
  }
  while (activeClaims.size >= CLASSPILOT_LIVE_VIEW_MAX_LOCAL_CLAIMS) {
    const oldest = activeClaims.keys().next().value as string | undefined;
    if (!oldest) break;
    activeClaims.delete(oldest);
  }
}

function rememberActiveClaim(
  binding: ClasspilotLiveViewBinding,
  claim: { negotiationId: string; expiresAt: number },
  now = Date.now()
): void {
  pruneLocalClaims(now);
  activeClaims.delete(claim.negotiationId);
  activeClaims.set(claim.negotiationId, { binding: { ...binding }, expiresAt: claim.expiresAt });
}

export function listActiveClasspilotLiveViewNegotiations(options: {
  schoolId?: string;
  teachingSessionId?: string;
  requesterUserId?: string;
  negotiationIds?: readonly string[];
  now?: number;
} = {}): Array<{
  negotiationId: string;
  binding: ClasspilotLiveViewBinding;
  expiresAt: number;
}> {
  const now = options.now ?? Date.now();
  const negotiationIds = options.negotiationIds
    ? new Set(options.negotiationIds)
    : null;
  const matches = [];
  for (const [negotiationId, claim] of activeClaims) {
    if (claim.expiresAt <= now) {
      activeClaims.delete(negotiationId);
      continue;
    }
    if (negotiationIds && !negotiationIds.has(negotiationId)) continue;
    if (options.schoolId && claim.binding.schoolId !== options.schoolId) continue;
    if (
      options.teachingSessionId
      && claim.binding.teachingSessionId !== options.teachingSessionId
    ) continue;
    if (
      options.requesterUserId
      && claim.binding.requesterUserId !== options.requesterUserId
    ) continue;
    matches.push({ negotiationId, binding: { ...claim.binding }, expiresAt: claim.expiresAt });
  }
  return matches;
}

function encoded(value: Buffer | string): string {
  return Buffer.from(value).toString("base64url");
}

function bindingDigest(binding: Pick<
  ClasspilotLiveViewBinding,
  "studentSessionId" | "deviceId"
>): string {
  return crypto
    .createHmac("sha256", signingSecret)
    .update(`${binding.studentSessionId}\u0000${binding.deviceId}`)
    .digest("base64url");
}

function signature(payload: string): string {
  return crypto.createHmac("sha256", signingSecret).update(payload).digest("base64url");
}

function claimKey(binding: Pick<ClasspilotLiveViewBinding, "schoolId" | "studentId">): string {
  const scoped = crypto
    .createHmac("sha256", signingSecret)
    .update(`${binding.schoolId}\u0000${binding.studentId}`)
    .digest("base64url");
  return `classpilot:live-view:${scoped}`;
}

function exactNegotiationIdMatch(left: unknown, right: string): boolean {
  if (typeof left !== "string") return false;
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length
    && crypto.timingSafeEqual(leftBytes, rightBytes);
}

export function createClasspilotLiveViewNegotiationId(
  binding: ClasspilotLiveViewBinding,
  now = Date.now()
): { negotiationId: string; expiresAt: number } {
  const claims: LiveViewClaims = {
    v: 1,
    requestId: crypto.randomUUID(),
    schoolId: binding.schoolId,
    studentId: binding.studentId,
    teachingSessionId: binding.teachingSessionId,
    requesterUserId: binding.requesterUserId,
    binding: bindingDigest(binding),
    expiresAt: now + CLASSPILOT_LIVE_VIEW_NEGOTIATION_TTL_MS,
  };
  const payload = encoded(JSON.stringify(claims));
  return { negotiationId: `${payload}.${signature(payload)}`, expiresAt: claims.expiresAt };
}

export function verifyClasspilotLiveViewNegotiation(
  negotiationId: unknown,
  expected: ClasspilotLiveViewBinding,
  now = Date.now()
): boolean {
  if (typeof negotiationId !== "string" || negotiationId.length < 32 || negotiationId.length > 2_048) {
    return false;
  }
  const [payload, suppliedSignature, extra] = negotiationId.split(".");
  if (!payload || !suppliedSignature || extra) return false;
  const expectedSignature = signature(payload);
  const suppliedBytes = Buffer.from(suppliedSignature);
  const expectedBytes = Buffer.from(expectedSignature);
  if (
    suppliedBytes.length !== expectedBytes.length
    || !crypto.timingSafeEqual(suppliedBytes, expectedBytes)
  ) return false;
  let claims: LiveViewClaims;
  try {
    claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return false;
  }
  return claims.v === 1
    && typeof claims.requestId === "string"
    && claims.schoolId === expected.schoolId
    && claims.studentId === expected.studentId
    && claims.teachingSessionId === expected.teachingSessionId
    && claims.requesterUserId === expected.requesterUserId
    && claims.binding === bindingDigest(expected)
    && Number.isSafeInteger(claims.expiresAt)
    && claims.expiresAt > now;
}

export function classpilotLiveViewRequester(
  negotiationId: unknown,
  expected: Omit<ClasspilotLiveViewBinding, "requesterUserId">,
  now = Date.now()
): string | null {
  const authority = classpilotLiveViewNegotiationAuthority(
    negotiationId,
    expected,
    now
  );
  return authority?.teachingSessionId === expected.teachingSessionId
    ? authority.requesterUserId
    : null;
}

/** Decode only after verifying the signature and exact authenticated device
 * binding. This lets a student release its own negotiation after control scope
 * changed, when the current classroom state no longer contains the original
 * teaching session ID. */
export function classpilotLiveViewNegotiationAuthority(
  negotiationId: unknown,
  expected: Pick<
    ClasspilotLiveViewBinding,
    "schoolId" | "studentId" | "studentSessionId" | "deviceId"
  >,
  now = Date.now()
): { teachingSessionId: string; requesterUserId: string; expiresAt: number } | null {
  if (typeof negotiationId !== "string" || negotiationId.length > 2_048) return null;
  const payload = negotiationId.split(".")[0];
  if (!payload) return null;
  try {
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as LiveViewClaims;
    if (
      typeof claims.requesterUserId !== "string"
      || claims.requesterUserId.length > 128
      || typeof claims.teachingSessionId !== "string"
      || claims.teachingSessionId.length > 128
    ) return null;
    return verifyClasspilotLiveViewNegotiation(
      negotiationId,
      {
        ...expected,
        teachingSessionId: claims.teachingSessionId,
        requesterUserId: claims.requesterUserId,
      },
      now
    ) ? {
      teachingSessionId: claims.teachingSessionId,
      requesterUserId: claims.requesterUserId,
      expiresAt: claims.expiresAt,
    } : null;
  } catch {
    return null;
  }
}

export async function claimClasspilotLiveViewNegotiation(
  binding: ClasspilotLiveViewBinding,
  now = Date.now()
): Promise<
  | { status: "claimed"; negotiationId: string; expiresAt: number }
  | { status: "busy" | "unavailable" }
> {
  const claim = createClasspilotLiveViewNegotiationId(binding, now);
  const key = claimKey(binding);
  pruneLocalClaims(now);
  try {
    const result = await redisCommand(
      ["SET", key, claim.negotiationId, "NX", "PX", String(CLASSPILOT_LIVE_VIEW_NEGOTIATION_TTL_MS)],
      { readyTimeoutMs: 200 }
    );
    if (result === "OK") {
      rememberActiveClaim(binding, claim, now);
      return { status: "claimed", ...claim };
    }
    if (result !== undefined) return { status: "busy" };
  } catch {
    if (process.env.REDIS_URL) return { status: "unavailable" };
  }
  if (process.env.REDIS_URL) return { status: "unavailable" };
  const current = localClaims.get(key);
  if (current && current.expiresAt > now) return { status: "busy" };
  localClaims.delete(key);
  localClaims.set(key, claim);
  rememberActiveClaim(binding, claim, now);
  return { status: "claimed", ...claim };
}

/**
 * Confirms that the signed, exact-bound negotiation is also the currently
 * claimed negotiation for this student. Redis is authoritative when it is
 * configured; production coordination failures fail closed.
 */
export async function isClasspilotLiveViewNegotiationActive(
  binding: Pick<
    ClasspilotLiveViewBinding,
    "schoolId" | "studentId" | "studentSessionId" | "deviceId"
  >,
  negotiationId: string,
  now = Date.now()
): Promise<boolean> {
  if (!classpilotLiveViewNegotiationAuthority(negotiationId, binding, now)) {
    return false;
  }
  const key = claimKey(binding);
  try {
    const result = await redisCommand(["GET", key], { readyTimeoutMs: 200 });
    if (result !== undefined) return exactNegotiationIdMatch(result, negotiationId);
  } catch {
    if (process.env.REDIS_URL) return false;
  }
  if (process.env.REDIS_URL) return false;
  const current = localClaims.get(key);
  return Boolean(
    current
    && current.expiresAt > now
    && exactNegotiationIdMatch(current.negotiationId, negotiationId)
  );
}

export async function releaseClasspilotLiveViewNegotiation(
  binding: Pick<ClasspilotLiveViewBinding, "schoolId" | "studentId">,
  negotiationId: string
): Promise<void> {
  activeClaims.delete(negotiationId);
  const key = claimKey(binding);
  try {
    const result = await redisCommand([
      "EVAL",
      "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end",
      "1",
      key,
      negotiationId,
    ], { readyTimeoutMs: 200 });
    if (result !== undefined || process.env.REDIS_URL) return;
  } catch {
    if (process.env.REDIS_URL) return;
  }
  if (localClaims.get(key)?.negotiationId === negotiationId) localClaims.delete(key);
}
