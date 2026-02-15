import rateLimit from "express-rate-limit";

/**
 * IMPORTANT: Both limiters below use the default in-memory store, which does
 * NOT share state across multiple server instances. In a horizontally-scaled
 * production deployment, replace the default store with a Redis-backed store
 * (e.g. rate-limit-redis) so that rate limits are enforced globally.
 *
 * Example:
 *   import { RedisStore } from "rate-limit-redis";
 *   import { createClient } from "redis";
 *   const redisClient = createClient({ url: process.env.REDIS_URL });
 *   // then pass  store: new RedisStore({ sendCommand: (...args) => redisClient.sendCommand(args) })
 */

export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 15,
  message: { error: "Too many login attempts, please try again later" },
  standardHeaders: true,
  legacyHeaders: false,
});

export const apiLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: 200,
  message: { error: "Too many requests, please try again later" },
  standardHeaders: true,
  legacyHeaders: false,
});
