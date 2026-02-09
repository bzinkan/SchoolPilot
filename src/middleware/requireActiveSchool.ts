import type { RequestHandler } from "express";
import { eq } from "drizzle-orm";
import { schools } from "../schema/core.js";
import db from "../db.js";

function isSchoolEntitled(school: typeof schools.$inferSelect): boolean {
  if (school.status === "suspended") return false;
  if (school.deletedAt) return false;
  if (school.planStatus === "canceled") return false;

  // Check if activeUntil has passed
  if (school.activeUntil && new Date(school.activeUntil) < new Date()) {
    return false;
  }

  return true;
}

/**
 * Ensures the current school is active and entitled.
 * Super admins bypass this check.
 * Also validates schoolSessionVersion for session-based auth.
 */
export const requireActiveSchool: RequestHandler = async (req, res, next) => {
  if (!req.authUser) {
    return res.status(401).json({ error: "Authentication required" });
  }

  // Super admins bypass
  if (req.authUser.isSuperAdmin) {
    return next();
  }

  const schoolId = res.locals.schoolId;
  if (!schoolId) {
    return res.status(400).json({ error: "School context required" });
  }

  const [school] = await db
    .select()
    .from(schools)
    .where(eq(schools.id, schoolId))
    .limit(1);

  if (!school || school.deletedAt) {
    return res.status(401).json({ error: "School not found" });
  }

  // Validate session version (session-based auth only)
  if (
    req.authMethod === "session" &&
    req.session?.schoolSessionVersion !== undefined &&
    school.schoolSessionVersion !== undefined &&
    req.session.schoolSessionVersion !== school.schoolSessionVersion
  ) {
    req.session.destroy(() => {});
    return res.status(401).json({ error: "Session invalidated" });
  }

  if (!isSchoolEntitled(school)) {
    return res.status(403).json({ error: "School subscription inactive" });
  }

  res.locals.school = school;
  res.locals.schoolActive = true;
  return next();
};
