import type { RequestHandler } from "express";
import { eq, and } from "drizzle-orm";
import { schoolMemberships } from "../schema/core.js";
import db from "../db.js";
import { createSingleFlight } from "../util/singleFlight.js";

type Role = "admin" | "school_admin" | "teacher" | "office_staff" | "parent";

type VerifiedSchoolMembership = {
  userId: string;
  schoolId: string;
  role: string;
};

const loadRoleMembershipSingleFlight = createSingleFlight<
  string,
  typeof schoolMemberships.$inferSelect | undefined
>({ maxPendingKeys: 4_096 });

function loadActiveMembership(userId: string, schoolId: string) {
  return loadRoleMembershipSingleFlight(`${userId}\u0000${schoolId}`, async () => {
    const [membership] = await db
      .select()
      .from(schoolMemberships)
      .where(
        and(
          eq(schoolMemberships.userId, userId),
          eq(schoolMemberships.schoolId, schoolId),
          eq(schoolMemberships.status, "active")
        )
      )
      .limit(1);
    return membership;
  });
}

/**
 * Role-based access control.
 * Checks the user's role in the current school context.
 * Super admins bypass all role checks.
 */
export function requireRole(...roles: Role[]): RequestHandler {
  const checkRole: RequestHandler = async (req, res, next) => {
    if (!req.authUser) {
      return res.status(401).json({ error: "Authentication required" });
    }

    // Super admins bypass role checks
    if (req.authUser.isSuperAdmin) {
      return next();
    }

    // Always verify role from DB when school context is available
    const schoolId = res.locals.schoolId;
    if (!schoolId) {
      return res.status(400).json({ error: "School context required" });
    }

    const verified = res.locals
      .verifiedSchoolMembership as VerifiedSchoolMembership | undefined;
    if (
      verified?.userId === req.authUser.id &&
      verified.schoolId === schoolId
    ) {
      return roles.includes(verified.role as Role)
        ? next()
        : res.status(403).json({ error: "Insufficient permissions" });
    }

    // Compatibility fallback for routes that establish school context without
    // requireSchoolContext. The normal chain supplies provenance above and
    // never repeats this database lookup.
    const membership = await loadActiveMembership(req.authUser.id, schoolId);

    if (!membership || !roles.includes(membership.role as Role)) {
      return res.status(403).json({ error: "Insufficient permissions" });
    }

    return next();
  };
  return (req, res, next) => {
    void Promise.resolve(checkRole(req, res, next)).catch(next);
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
