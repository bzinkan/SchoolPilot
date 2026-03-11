import type { RequestHandler } from "express";
import { verifyUserToken } from "../services/jwt.js";
import { eq } from "drizzle-orm";
import { users } from "../schema/core.js";
import db from "../db.js";

/**
 * Dual authentication middleware.
 * Checks Bearer JWT first (explicit auth takes priority),
 * then falls back to session cookie.
 */
export const authenticate: RequestHandler = async (req, res, next) => {
  // Strategy 1: Bearer JWT (takes priority when present)
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith("Bearer ")) {
    const token = authHeader.split(" ")[1];
    if (token) {
      try {
        const payload = verifyUserToken(token);
        const [user] = await db
          .select()
          .from(users)
          .where(eq(users.id, payload.userId))
          .limit(1);

        if (user) {
          req.authUser = user;
          req.authMethod = "jwt";
          req.jwtPayload = payload;
          return next();
        }
      } catch (err) {
        console.error("[auth] JWT verification failed, falling through to session:", err);
      }
    }
  }

  // Strategy 2: Session cookie (PassPilot/ClassPilot web)
  if (req.session?.userId) {
    try {
      const [user] = await db
        .select()
        .from(users)
        .where(eq(users.id, req.session.userId))
        .limit(1);

      if (user) {
        req.authUser = user;
        req.authMethod = "session";
        return next();
      }
    } catch (err) {
      console.error("[auth] Session lookup failed:", err);
    }
  }

  return res.status(401).json({ error: "Authentication required" });
};

/**
 * Optional auth - sets user if available but doesn't reject
 */
export const optionalAuth: RequestHandler = async (req, _res, next) => {
  // JWT takes priority over session
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith("Bearer ")) {
    const token = authHeader.split(" ")[1];
    if (token) {
      try {
        const payload = verifyUserToken(token);
        const [user] = await db
          .select()
          .from(users)
          .where(eq(users.id, payload.userId))
          .limit(1);
        if (user) {
          req.authUser = user;
          req.authMethod = "jwt";
          req.jwtPayload = payload;
          return next();
        }
      } catch (err) {
        console.error("[auth] Optional JWT verification failed:", err);
      }
    }
  }

  if (req.session?.userId) {
    try {
      const [user] = await db
        .select()
        .from(users)
        .where(eq(users.id, req.session.userId))
        .limit(1);
      if (user) {
        req.authUser = user;
        req.authMethod = "session";
      }
    } catch (err) {
      console.error("[auth] Optional session lookup failed:", err);
    }
  }
  return next();
};
