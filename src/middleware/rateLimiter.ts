import rateLimit, { ipKeyGenerator, type Store } from "express-rate-limit";
import { RedisStore } from "rate-limit-redis";
import { createClient } from "redis";
import type { Request } from "express";

// Shared Redis backing for all limiters so counts survive deploys and are
// shared across ECS tasks. Dedicated client (not the ws-redis publisher) to
// avoid a boot-order dependency on the realtime subsystem. If REDIS_URL is
// unset or Redis is down, limiters fall back to per-task MemoryStore behavior
// via passOnStoreError — brute-force protection is still backed by the
// DB-persisted account lockouts in services/accountLockout.ts.
const redisUrl = process.env.REDIS_URL;
let redisClient: ReturnType<typeof createClient> | null = null;
if (redisUrl) {
  redisClient = createClient({ url: redisUrl });
  redisClient.on("error", (err) =>
    console.warn("[RateLimit] Redis error:", (err as Error).message)
  );
  redisClient
    .connect()
    .catch((err) => console.warn("[RateLimit] Redis connect failed:", err.message));
}

function redisStore(prefix: string): Store | undefined {
  if (!redisClient) return undefined; // express-rate-limit defaults to MemoryStore
  return new RedisStore({
    prefix,
    sendCommand: async (...args: string[]) => {
      if (!redisClient!.isReady) throw new Error("redis not ready");
      return redisClient!.sendCommand(args);
    },
  });
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
  max: 1000,
  message: { error: "Too many requests, please try again later" },
  standardHeaders: true,
  legacyHeaders: false,
  store: redisStore("rl:api:"),
  passOnStoreError: true,
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
