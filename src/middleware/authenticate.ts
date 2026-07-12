import type { RequestHandler } from "express";
import { verifyUserToken } from "../services/jwt.js";
import { eq } from "drizzle-orm";
import { users } from "../schema/core.js";
import db from "../db.js";
import { createSingleFlight } from "../util/singleFlight.js";

const loadUserSingleFlight = createSingleFlight<
  string,
  typeof users.$inferSelect | undefined
>({ maxPendingKeys: 2_048 });

function loadUserById(userId: string): Promise<typeof users.$inferSelect | undefined> {
  return loadUserSingleFlight(userId, async () => {
    const [user] = await db
      .select()
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    return user;
  });
}

/**
 * Dual authentication middleware.
 * Checks Bearer JWT first (explicit auth takes priority), then falls back to
 * session cookie. Active impersonation sessions are the exception: the session
 * must win so stale client JWTs cannot mask or bypass impersonation state.
 */
export const authenticate: RequestHandler = async (req, res, next) => {
  if ((req.session as any)?.impersonating && req.session?.userId) {
    try {
      const user = await loadUserById(req.session.userId);

      if (user) {
        req.authUser = user;
        req.authMethod = "session";
        return next();
      }
      return res.status(401).json({ error: "Authentication required" });
    } catch (err) {
      console.error("[auth] Impersonation session lookup failed:", err);
      return next(err);
    }
  }

  // Strategy 1: Bearer JWT (takes priority when present)
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith("Bearer ")) {
    const token = authHeader.split(" ")[1];
    if (token) {
      try {
        const payload = verifyUserToken(token);
        const user = await loadUserById(payload.userId);

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
      const user = await loadUserById(req.session.userId);

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
  if ((req.session as any)?.impersonating && req.session?.userId) {
    try {
      const user = await loadUserById(req.session.userId);
      if (user) {
        req.authUser = user;
        req.authMethod = "session";
        return next();
      }
      return next();
    } catch (err) {
      console.error("[auth] Optional impersonation session lookup failed:", err);
      return next(err);
    }
  }

  // JWT takes priority over session
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith("Bearer ")) {
    const token = authHeader.split(" ")[1];
    if (token) {
      try {
        const payload = verifyUserToken(token);
        const user = await loadUserById(payload.userId);
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
      const user = await loadUserById(req.session.userId);
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
