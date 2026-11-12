import { eq } from "drizzle-orm";
import db from "../db.js";
import { schools } from "../schema/core.js";
import { classpilotSchoolSchedules } from "../schema/classpilotScheduling.js";
import { addLocalDays, localDateStartUtc, resolveSchoolLocalPeriod } from "../util/schoolTime.js";
import { getInstructionalCalendarMonth } from "./storage.js";
import { readStoredSchoolSchedulingConfig } from "./classpilotSchedulingRules.js";

export type SchoolDayStatusProduct = "classpilot" | "passpilot" | "gopilot";
export type SchoolDayStatus = {
  schoolLocalDate: string;
  schoolTimezone: string;
  evaluatedAt: string;
  validUntil: string;
  calendarClosed: boolean;
  classpilotInstructionalOverride: boolean | null;
};

/**
 * Informational, current-day projection only. A shared explicit closure is not
 * the same as a weekend, a class not meeting, or a product-specific override.
 * Call within the authenticated request's tenant context; never creates settings.
 */
export async function getSchoolDayStatus(
  schoolId: string,
  product: SchoolDayStatusProduct,
  now = new Date(),
): Promise<SchoolDayStatus> {
  const [school] = await db.select({ timezone: schools.schoolTimezone })
    .from(schools).where(eq(schools.id, schoolId)).limit(1);
  if (!school) throw Object.assign(new Error("School not found."), { status: 404, code: "SCHOOL_NOT_FOUND", expose: true });

  const { todayLocalDate, timeZone } = resolveSchoolLocalPeriod("today", school.timezone, now);
  const month = await getInstructionalCalendarMonth(schoolId, todayLocalDate.slice(0, 7));
  let classpilotInstructionalOverride: boolean | null = null;
  if (product === "classpilot") {
    const [schedule] = await db.select({ config: classpilotSchoolSchedules.config })
      .from(classpilotSchoolSchedules).where(eq(classpilotSchoolSchedules.schoolId, schoolId)).limit(1);
    // Match the scheduling engine's validation and default for absent/{ } rows.
    // Return only this date's flag, never the stored schedule or month calendar.
    classpilotInstructionalOverride = readStoredSchoolSchedulingConfig(schedule?.config)
      .dateOverrides[todayLocalDate]?.instructional ?? null;
  }

  return {
    schoolLocalDate: todayLocalDate,
    schoolTimezone: timeZone,
    evaluatedAt: now.toISOString(),
    validUntil: localDateStartUtc(addLocalDays(todayLocalDate, 1), timeZone).toISOString(),
    calendarClosed: month.nonInstructionalDates.includes(todayLocalDate),
    classpilotInstructionalOverride,
  };
}
