import type { RequestHandler, Response } from "express";
import { eq, and } from "drizzle-orm";
import { schoolMemberships, schools } from "../schema/core.js";
import db from "../db.js";
import { bindTenantContext } from "./tenantContext.js";
import { createSingleFlight } from "../util/singleFlight.js";

type ActiveMembershipContext = {
  membership: typeof schoolMemberships.$inferSelect;
  school: typeof schools.$inferSelect;
};

const loadMembershipSingleFlight = createSingleFlight<
  string,
  ActiveMembershipContext | undefined
>({ maxPendingKeys: 4_096 });

function loadActiveMembershipContext(
  userId: string,
  schoolId?: string
): Promise<ActiveMembershipContext | undefined> {
  const key = `${userId}\u0000${schoolId ?? "*"}`;
  return loadMembershipSingleFlight(key, async () => {
    const conditions = [
      eq(schoolMemberships.userId, userId),
      eq(schoolMemberships.status, "active"),
    ];
    if (schoolId) conditions.push(eq(schoolMemberships.schoolId, schoolId));
    const [context] = await db
      .select({ membership: schoolMemberships, school: schools })
      .from(schoolMemberships)
      .innerJoin(schools, eq(schoolMemberships.schoolId, schools.id))
      .where(and(...conditions))
      .limit(1);
    return context;
  });
}

function applyVerifiedMembershipContext(
  res: Response,
  context: ActiveMembershipContext
): void {
  res.locals.schoolId = context.membership.schoolId;
  res.locals.membershipRole = context.membership.role;
  res.locals.school = context.school;
  res.locals.verifiedSchoolMembership = {
    userId: context.membership.userId,
    schoolId: context.membership.schoolId,
    role: context.membership.role,
  };
}

/**
 * Ensures a school context is available.
 * For session auth: uses req.session.schoolId
 * For JWT auth: looks up first active membership or uses schoolId from params/body
 * Super admins can specify any school via query/params.
 *
 * Also stores the user's membership role in res.locals.membershipRole
 * so downstream handlers can check role without extra DB queries.
 */
const resolveSchoolContext: RequestHandler = async (req, res, next) => {
  if (!req.authUser) {
    return res.status(401).json({ error: "Authentication required" });
  }

  // Super admins can operate on any school
  if (req.authUser.isSuperAdmin) {
    const schoolId =
      String(req.params.schoolId || "") ||
      (req.headers["x-school-id"] as string) ||
      (req.query.schoolId as string) ||
      req.session?.schoolId;
    if (schoolId) {
      res.locals.schoolId = schoolId as string;
    }
    res.locals.membershipRole = "super_admin";
    return next();
  }

  // Session-based: schoolId already in session
  if (req.authMethod === "session" && req.session?.schoolId) {
    const requestedSchoolId =
      String(req.params.schoolId || "") ||
      (req.headers["x-school-id"] as string) ||
      (req.query.schoolId as string) ||
      "";

    if (requestedSchoolId && requestedSchoolId !== req.session.schoolId) {
      const requestedMembership = await loadActiveMembershipContext(
        req.authUser.id,
        requestedSchoolId
      );

      if (!requestedMembership) {
        return res.status(404).json({ error: "School not found" });
      }

      req.session.schoolId = requestedMembership.membership.schoolId;
      req.session.role = requestedMembership.membership.role;
      req.session.schoolSessionVersion =
        requestedMembership.school.schoolSessionVersion ?? 1;
      applyVerifiedMembershipContext(res, requestedMembership);
      return next();
    }

    const membership = await loadActiveMembershipContext(
      req.authUser.id,
      req.session.schoolId
    );
    if (!membership) {
      // A stale session-selected school must not establish an RLS tenant after
      // membership revocation. The user may select another active membership,
      // but this request fails closed immediately.
      return res.status(403).json({ error: "No access to this school" });
    }
    applyVerifiedMembershipContext(res, membership);
    return next();
  }

  // JWT-based or session without schoolId: look up from params, query, header, or first membership
  // NOTE: We intentionally skip req.body?.schoolId here. The school context should come
  // from trusted sources (session, header, params), not from the request body which
  // frontends may set incorrectly. The backend always overrides schoolId from res.locals.
  const schoolId =
    String(req.params.schoolId || "") ||
    (req.headers["x-school-id"] as string) ||
    (req.query.schoolId as string) ||
    "";

  if (schoolId) {
    // Verify user has membership in this school
    const membership = await loadActiveMembershipContext(
      req.authUser.id,
      schoolId
    );

    if (!membership) {
      return res
        .status(403)
        .json({ error: "No access to this school" });
    }

    applyVerifiedMembershipContext(res, membership);
    return next();
  }

  // Fallback: use first active membership
  const membership = await loadActiveMembershipContext(req.authUser.id);

  if (!membership) {
    return res.status(400).json({ error: "No school context available" });
  }

  applyVerifiedMembershipContext(res, membership);
  return next();
};

/**
 * Resolves and authorizes the school without checking out a response-lifetime
 * RLS client. Callers must establish a narrow `runWithTenantContext` scope (or
 * invoke `bindTenantContext`) before touching any tenant table.
 */
export const requireSchoolContextWithoutTenantBinding: RequestHandler = (
  req,
  res,
  next
) => {
  void Promise.resolve(resolveSchoolContext(req, res, next)).catch(next);
};

export const requireSchoolContext: RequestHandler = (req, res, next) => {
  void Promise.resolve(
    resolveSchoolContext(req, res, (error?: unknown) => {
      if (error) return next(error);
      return bindTenantContext(req, res, next);
    })
  ).catch(next);
};
