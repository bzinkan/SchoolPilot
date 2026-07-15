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

const POSTGRES_SQLSTATE = /^[0-9A-Z]{5}$/;
const SAFE_NODE_OPERATIONAL_ERROR_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EPIPE",
  "ETIMEDOUT",
]);

function safeOperationalErrorCode(error: unknown): string | undefined {
  for (const candidate of [error, (error as { cause?: unknown } | null)?.cause]) {
    const code = (candidate as { code?: unknown } | null)?.code;
    if (
      typeof code === "string" &&
      (POSTGRES_SQLSTATE.test(code) || SAFE_NODE_OPERATIONAL_ERROR_CODES.has(code))
    ) {
      return code;
    }
  }
  return undefined;
}

export function authenticationServiceError(error: unknown): Error {
  const safe = new Error("Authentication service unavailable") as Error & {
    code?: string;
    expose?: boolean;
    status?: number;
  };
  safe.name = "AuthenticationServiceError";
  safe.code = safeOperationalErrorCode(error);
  safe.expose = true;
  safe.status = 503;
  return safe;
}

function logCredentialFailure(
  message: string,
  error: unknown,
  requestId?: string
): void {
  console.warn(`[auth] ${message}`, {
    requestId: requestId ?? "n/a",
    name: error instanceof Error ? error.name : "UnknownError",
  });
}

function logAuthenticationServiceFailure(
  message: string,
  error: unknown,
  requestId?: string
): Error {
  const safe = authenticationServiceError(error) as Error & { code?: string };
  console.error(`[auth] ${message}`, {
    requestId: requestId ?? "n/a",
    name: safe.name,
    code: safe.code,
  });
  return safe;
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
      return next(logAuthenticationServiceFailure(
        "Impersonation session lookup failed",
        err,
        req.requestId
      ));
    }
  }

  // Strategy 1: Bearer JWT (takes priority when present)
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith("Bearer ")) {
    const token = authHeader.split(" ")[1];
    if (token) {
      let payload;
      try {
        payload = verifyUserToken(token);
      } catch (err) {
        logCredentialFailure(
          "JWT verification failed; falling through to session",
          err,
          req.requestId
        );
      }

      if (payload) {
        try {
          const user = await loadUserById(payload.userId);

          if (user) {
            req.authUser = user;
            req.authMethod = "jwt";
            req.jwtPayload = payload;
            return next();
          }
        } catch (err) {
          return next(logAuthenticationServiceFailure(
            "JWT user lookup failed",
            err,
            req.requestId
          ));
        }
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
      return next(logAuthenticationServiceFailure(
        "Session lookup failed",
        err,
        req.requestId
      ));
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
      return next(logAuthenticationServiceFailure(
        "Optional impersonation session lookup failed",
        err,
        req.requestId
      ));
    }
  }

  // JWT takes priority over session
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith("Bearer ")) {
    const token = authHeader.split(" ")[1];
    if (token) {
      let payload;
      try {
        payload = verifyUserToken(token);
      } catch (err) {
        logCredentialFailure(
          "Optional JWT verification failed",
          err,
          req.requestId
        );
      }

      if (payload) {
        try {
          const user = await loadUserById(payload.userId);
          if (user) {
            req.authUser = user;
            req.authMethod = "jwt";
            req.jwtPayload = payload;
            return next();
          }
        } catch (err) {
          return next(logAuthenticationServiceFailure(
            "Optional JWT user lookup failed",
            err,
            req.requestId
          ));
        }
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
      return next(logAuthenticationServiceFailure(
        "Optional session lookup failed",
        err,
        req.requestId
      ));
    }
  }
  return next();
};
