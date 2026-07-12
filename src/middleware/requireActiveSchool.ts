import type { RequestHandler } from "express";
import { eq } from "drizzle-orm";
import { schools } from "../schema/core.js";
import db from "../db.js";
import { createSingleFlight } from "../util/singleFlight.js";

const loadSchoolSingleFlight = createSingleFlight<
  string,
  typeof schools.$inferSelect | undefined
>({ maxPendingKeys: 2_048 });

function loadSchoolById(schoolId: string) {
  return loadSchoolSingleFlight(schoolId, async () => {
    const [school] = await db
      .select()
      .from(schools)
      .where(eq(schools.id, schoolId))
      .limit(1);
    return school;
  });
}

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
const resolveActiveSchool: RequestHandler = async (req, res, next) => {
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

  const verifiedSchool = res.locals.school as
    | typeof schools.$inferSelect
    | undefined;
  const school =
    verifiedSchool?.id === schoolId
      ? verifiedSchool
      : await loadSchoolById(schoolId);

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

export const requireActiveSchool: RequestHandler = (req, res, next) => {
  void Promise.resolve(resolveActiveSchool(req, res, next)).catch(next);
};
