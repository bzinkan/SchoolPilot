import type { RequestHandler } from "express";

/**
 * Enforce a tighter idle timeout for privileged roles.
 *
 * The base session cookie is 7 days (rolling), which is appropriate for
 * teachers and parents who log in throughout the day. But school admin and
 * super admin accounts hold the keys to student data — district IT expects
 * shorter idle timeouts for these accounts.
 *
 * This middleware reads lastActivityAt from the session on every authenticated
 * request. If the role is admin-level and the session has been idle beyond
 * the configured window, the session is destroyed and a 401 is returned.
 */

const ADMIN_IDLE_TIMEOUT_MS = 60 * 60 * 1000; // 1 hour for admin/super_admin
const ELEVATED_ROLES = new Set(["admin", "school_admin", "super_admin"]);

export const sessionIdleTimeout: RequestHandler = (req, res, next) => {
  const role = req.session?.role;
  if (!role || !ELEVATED_ROLES.has(role)) {
    // Not elevated — keep default 7-day rolling window
    if (req.session) {
      (req.session as any).lastActivityAt = Date.now();
    }
    return next();
  }

  const lastActivityAt = (req.session as any).lastActivityAt as number | undefined;
  const now = Date.now();

  if (lastActivityAt && now - lastActivityAt > ADMIN_IDLE_TIMEOUT_MS) {
    // Session idle too long — destroy and force re-auth
    return req.session.destroy((err) => {
      if (err) {
        console.warn("[SessionIdle] destroy failed:", err);
      }
      res.clearCookie("schoolpilot.sid");
      return res.status(401).json({ error: "Session expired due to inactivity. Please log in again." });
    });
  }

  (req.session as any).lastActivityAt = now;
  next();
};
