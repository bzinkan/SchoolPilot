import rateLimit, { ipKeyGenerator, type Store } from "express-rate-limit";
import { RedisStore } from "rate-limit-redis";
import { createClient } from "redis";
import type { Request } from "express";
import {
  createCachedBearerUserIdVerifier,
  resolveApiRateLimitIdentity,
  type ApiRateLimitIdentity,
} from "../util/apiRateLimitIdentity.js";
import { usesDeviceScopedApiLimit } from "../util/apiRateLimitRoutes.js";
import { createRedisReadyWaiter } from "../util/redisReadyWaiter.js";
import { verifyUserToken } from "../services/jwt.js";

// Shared Redis backing for all limiters so counts survive deploys and are
// shared across ECS tasks. Dedicated client (not the ws-redis publisher) to
// avoid a boot-order dependency on the realtime subsystem. If REDIS_URL is
// unset or Redis is down, limiters fall back to per-task MemoryStore behavior
// via passOnStoreError — brute-force protection is still backed by the
// DB-persisted account lockouts in services/accountLockout.ts.
const redisUrl = process.env.REDIS_URL;
let redisClient: ReturnType<typeof createClient> | null = null;
let waitForReady: ((timeoutMs?: number) => Promise<void>) | null = null;
if (redisUrl) {
  redisClient = createClient({ url: redisUrl });
  // Every RedisStore preloads two scripts during module initialization. Share
  // one bounded readiness cycle so those concurrent commands do not each add
  // a listener; timeout rejection still flows to passOnStoreError.
  waitForReady = createRedisReadyWaiter(redisClient);
  redisClient.on("error", (err) =>
    console.warn("[RateLimit] Redis error:", (err as Error).message)
  );
  redisClient
    .connect()
    .catch((err) => console.warn("[RateLimit] Redis connect failed:", err.message));
}

export function redisStore(prefix: string): Store | undefined {
  if (!redisClient || !waitForReady) {
    return undefined; // express-rate-limit defaults to MemoryStore
  }
  const store = new RedisStore({
    prefix,
    sendCommand: async (...args: string[]) => {
      await waitForReady();
      return redisClient!.sendCommand(args);
    },
  });
  // The constructor preloads its Lua scripts and keeps the promises without a
  // rejection handler; if Redis is down at boot they'd log as unhandled
  // rejections. Mark them handled — awaiting the same promise later (the
  // increment/get paths) still rejects there and triggers the store's retry.
  for (const p of [
    (store as unknown as Record<string, unknown>).incrementScriptSha,
    (store as unknown as Record<string, unknown>).getScriptSha,
  ]) {
    if (p instanceof Promise) p.catch(() => {});
  }
  return store;
}

export async function redisCommand(args: string[]): Promise<unknown | undefined> {
  if (!redisClient || !waitForReady) return undefined;
  await waitForReady();
  return redisClient.sendCommand(args);
}

const API_RATE_LIMIT_IDENTITY = Symbol("apiRateLimitIdentity");
type RateLimitRequest = Request & {
  [API_RATE_LIMIT_IDENTITY]?: ApiRateLimitIdentity;
};

const cachedStaffBearerUserId =
  createCachedBearerUserIdVerifier(verifyUserToken);

function verifiedStaffBearerUserId(req: Request): string | null {
  // Device tokens use a separate secret and a token-hash key. Avoid attempting
  // staff verification on every high-frequency device ingest request.
  if (usesDeviceScopedApiLimit(req)) return null;
  const authorization = req.get("authorization");
  // Mirror authenticate.ts's exact bearer extraction so the limiter cannot
  // select a different identity when a browser also has a valid session.
  if (!authorization?.startsWith("Bearer ")) return null;
  const token = authorization.split(" ")[1];
  if (!token) return null;
  // Invalid/unresolved traffic stays on the shared IP limit. Never key an
  // unverified token directly or allow token rotation to bypass the limiter.
  return cachedStaffBearerUserId(`Bearer ${token}`);
}

function apiRateLimitIdentity(req: RateLimitRequest) {
  const cached = req[API_RATE_LIMIT_IDENTITY];
  if (cached) return cached;
  const identity = resolveApiRateLimitIdentity({
    request: req,
    authorization: req.get("authorization"),
    sessionUserId: req.session?.userId,
    sessionImpersonating: Boolean((req.session as any)?.impersonating),
    verifiedBearerUserId: verifiedStaffBearerUserId(req),
    normalizedIp: ipKeyGenerator(req.ip ?? req.socket?.remoteAddress ?? "unknown"),
  });
  req[API_RATE_LIMIT_IDENTITY] = identity;
  return identity;
}

export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 15,
  message: { error: "Too many login attempts, please try again later" },
  standardHeaders: true,
  legacyHeaders: false,
  store: redisStore("rl:auth:"),
  passOnStoreError: true,
});

export const apiLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: (req: Request) => apiRateLimitIdentity(req).limit,
  message: { error: "Too many requests, please try again later" },
  standardHeaders: true,
  legacyHeaders: false,
  store: redisStore("rl:api:"),
  passOnStoreError: true,
  keyGenerator: (req: Request) => apiRateLimitIdentity(req).key,
});

// Workspace Security Audit — expensive: each call fans out to ~10 Google APIs
// and consumes the customer's Chrome Policy quota. Audit is meant to be run
// occasionally (setup + re-check after each policy fix), so 10/hr/user is generous.
// Keyed by user id (falls back to IP for unauthenticated misuse).
export const auditLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 10,
  message: {
    error: "Audit rate limit reached. Try again in an hour.",
    code: "RATE_LIMITED",
  },
  standardHeaders: true,
  legacyHeaders: false,
  store: redisStore("rl:audit:"),
  passOnStoreError: true,
  keyGenerator: (req: Request) => {
    const userId = (req as Request & { authUser?: { id?: string } }).authUser?.id;
    if (userId) return `user:${userId}`;
    // ipKeyGenerator normalizes IPv6 (collapses to a /64) so a caller can't
    // bypass the limit by rotating addresses within their prefix.
    return `ip:${ipKeyGenerator(req.ip ?? req.socket?.remoteAddress ?? "unknown")}`;
  },
});
