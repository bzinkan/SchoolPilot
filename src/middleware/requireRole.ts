import type { RequestHandler } from "express";
import { createSingleFlight } from "../util/singleFlight.js";
import {
  identityHasAnyRole,
  loadVerifiedSchoolIdentities,
  type SchoolRole as Role,
  type VerifiedSchoolIdentity,
} from "../services/schoolIdentity.js";

const loadRoleIdentitySingleFlight = createSingleFlight<
  string,
  VerifiedSchoolIdentity | undefined
>({ maxPendingKeys: 4_096 });

function loadActiveIdentity(userId: string, schoolId: string) {
  return loadRoleIdentitySingleFlight(`${userId}\u0000${schoolId}`, async () => {
    const [identity] = await loadVerifiedSchoolIdentities(userId, schoolId);
    return identity;
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

    const verifiedIdentity = (
      res.locals.schoolIdentity ?? res.locals.verifiedSchoolIdentity
    ) as VerifiedSchoolIdentity | undefined;
    if (
      verifiedIdentity?.userId === req.authUser.id &&
      verifiedIdentity.schoolId === schoolId
    ) {
      return identityHasAnyRole(verifiedIdentity, roles)
        ? next()
        : res.status(403).json({ error: "Insufficient permissions" });
    }

    // Compatibility fallback for routes that establish school context without
    // requireSchoolContext. The normal chain supplies provenance above and
    // never repeats this database lookup.
    const identity = await loadActiveIdentity(req.authUser.id, schoolId);

    if (!identity || !identityHasAnyRole(identity, roles)) {
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
