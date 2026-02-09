import type { RequestHandler } from "express";
import { verifyUserToken } from "../services/jwt.js";
import { eq } from "drizzle-orm";
import { users } from "../schema/core.js";
import db from "../db.js";

/**
 * Dual authentication middleware.
 * Checks session cookie first (PassPilot/ClassPilot web),
 * then Bearer JWT (GoPilot/mobile).
 */
export const authenticate: RequestHandler = async (req, res, next) => {
  // Strategy 1: Session cookie (PassPilot, ClassPilot web)
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
    } catch {
      // Session user not found, fall through to JWT
    }
  }

  // Strategy 2: Bearer JWT (GoPilot)
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
      } catch {
        // Token invalid, fall through
      }
    }
  }

  return res.status(401).json({ error: "Authentication required" });
};

/**
 * Optional auth - sets user if available but doesn't reject
 */
export const optionalAuth: RequestHandler = async (req, _res, next) => {
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
    } catch {
      // ignore
    }
  } else {
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
          }
        } catch {
          // ignore
        }
      }
    }
  }
  return next();
};
