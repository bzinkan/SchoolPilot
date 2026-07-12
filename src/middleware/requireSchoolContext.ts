import type { RequestHandler } from "express";
import { eq, and } from "drizzle-orm";
import { schoolMemberships, schools } from "../schema/core.js";
import db from "../db.js";
import { bindTenantContext } from "./tenantContext.js";

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
      const [requestedMembership] = await db
        .select({
          membership: schoolMemberships,
          school: schools,
        })
        .from(schoolMemberships)
        .innerJoin(schools, eq(schoolMemberships.schoolId, schools.id))
        .where(
          and(
            eq(schoolMemberships.userId, req.authUser.id),
            eq(schoolMemberships.schoolId, requestedSchoolId),
            eq(schoolMemberships.status, "active")
          )
        )
        .limit(1);

      if (!requestedMembership) {
        return res.status(404).json({ error: "School not found" });
      }

      req.session.schoolId = requestedMembership.membership.schoolId;
      req.session.role = requestedMembership.membership.role;
      req.session.schoolSessionVersion =
        requestedMembership.school.schoolSessionVersion ?? 1;
    }

    res.locals.schoolId = req.session.schoolId;
    // Look up role for session users too
    const [membership] = await db
      .select()
      .from(schoolMemberships)
      .where(
        and(
          eq(schoolMemberships.userId, req.authUser.id),
          eq(schoolMemberships.schoolId, req.session.schoolId),
          eq(schoolMemberships.status, "active")
        )
      )
      .limit(1);
    res.locals.membershipRole = membership?.role || null;
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
    const [membership] = await db
      .select()
      .from(schoolMemberships)
      .where(
        and(
          eq(schoolMemberships.userId, req.authUser.id),
          eq(schoolMemberships.schoolId, schoolId),
          eq(schoolMemberships.status, "active")
        )
      )
      .limit(1);

    if (!membership) {
      return res
        .status(403)
        .json({ error: "No access to this school" });
    }

    res.locals.schoolId = schoolId;
    res.locals.membershipRole = membership.role;
    return next();
  }

  // Fallback: use first active membership
  const [membership] = await db
    .select()
    .from(schoolMemberships)
    .where(
      and(
        eq(schoolMemberships.userId, req.authUser.id),
        eq(schoolMemberships.status, "active")
      )
    )
    .limit(1);

  if (!membership) {
    return res.status(400).json({ error: "No school context available" });
  }

  res.locals.schoolId = membership.schoolId;
  res.locals.membershipRole = membership.role;
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
