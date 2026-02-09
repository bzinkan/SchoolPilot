import type { RequestHandler } from "express";
import { eq, and } from "drizzle-orm";
import { schoolMemberships } from "../schema/core.js";
import db from "../db.js";

/**
 * Ensures a school context is available.
 * For session auth: uses req.session.schoolId
 * For JWT auth: looks up first active membership or uses schoolId from params/body
 * Super admins can specify any school via query/params.
 */
export const requireSchoolContext: RequestHandler = async (req, res, next) => {
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
    return next();
  }

  // Session-based: schoolId already in session
  if (req.authMethod === "session" && req.session?.schoolId) {
    res.locals.schoolId = req.session.schoolId;
    return next();
  }

  // JWT-based or session without schoolId: look up from params, query, header, body, or first membership
  const schoolId =
    req.params.schoolId ||
    (req.headers["x-school-id"] as string) ||
    (req.query.schoolId as string) ||
    req.body?.schoolId;

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
  return next();
};
