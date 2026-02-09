import type { RequestHandler } from "express";
import { eq, and, inArray } from "drizzle-orm";
import { schoolMemberships } from "../schema/core.js";
import db from "../db.js";

type Role = "admin" | "teacher" | "office_staff" | "parent";

/**
 * Role-based access control.
 * Checks the user's role in the current school context.
 * Super admins bypass all role checks.
 */
export function requireRole(...roles: Role[]): RequestHandler {
  return async (req, res, next) => {
    if (!req.authUser) {
      return res.status(401).json({ error: "Authentication required" });
    }

    // Super admins bypass role checks
    if (req.authUser.isSuperAdmin) {
      return next();
    }

    // Session-based: role is in session
    if (req.authMethod === "session" && req.session?.role) {
      const sessionRole = req.session.role === "school_admin" ? "admin" : req.session.role;
      if (roles.includes(sessionRole as Role)) {
        return next();
      }
      return res.status(403).json({ error: "Insufficient permissions" });
    }

    // JWT-based: check school_memberships
    const schoolId = res.locals.schoolId;
    if (!schoolId) {
      return res.status(400).json({ error: "School context required" });
    }

    const [membership] = await db
      .select()
      .from(schoolMemberships)
      .where(
        and(
          eq(schoolMemberships.userId, req.authUser.id),
          eq(schoolMemberships.schoolId, schoolId),
          inArray(schoolMemberships.role, roles),
          eq(schoolMemberships.status, "active")
        )
      )
      .limit(1);

    if (!membership) {
      return res.status(403).json({ error: "Insufficient permissions" });
    }

    return next();
  };
}

/**
 * Requires the user to be a super admin.
 */
export const requireSuperAdmin: RequestHandler = (req, res, next) => {
  if (!req.authUser) {
    return res.status(401).json({ error: "Authentication required" });
  }
  if (!req.authUser.isSuperAdmin) {
    return res.status(403).json({ error: "Super admin access required" });
  }
  return next();
};
