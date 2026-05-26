import rateLimit from "express-rate-limit";
import type { Request } from "express";

export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 15,
  message: { error: "Too many login attempts, please try again later" },
  standardHeaders: true,
  legacyHeaders: false,
});

export const apiLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: 1000,
  message: { error: "Too many requests, please try again later" },
  standardHeaders: true,
  legacyHeaders: false,
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
  keyGenerator: (req: Request) => {
    const userId = (req as Request & { authUser?: { id?: string } }).authUser?.id;
    return userId ? `user:${userId}` : `ip:${req.ip ?? "unknown"}`;
  },
});
