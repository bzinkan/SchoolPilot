import { and, eq } from "drizzle-orm";
import { z } from "zod";
import db from "../db.js";
import { schools, users, schoolMemberships, productLicenses, type User } from "../schema/core.js";
import { auditLogs } from "../schema/shared.js";
import { classpilotSchoolSchedules } from "../schema/classpilotScheduling.js";
import { activeEntitledProducts } from "./productEntitlement.js";
import { lockStaffAssignmentLifecycleSchool } from "./staffAssignmentLifecycleLock.js";
import { takePasspilotClassLock, withClasspilotSchedulePostCommitTransaction, type PasspilotClassTransaction } from "./storage.js";
import { getSchoolSchedulingContext, previewSchoolScheduling, saveSchoolSchedulingInTransaction } from "./classpilotScheduling.js";
import { normalizeSchoolSchedulingConfig, schedulingError, type SchoolSchedulingConfig } from "./classpilotSchedulingRules.js";
import { localDateInTimeZone } from "../util/schoolTime.js";

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
export const passpilotSchoolYearSchema = z.object({ yearStart: day, yearEnd: day }).strict();
export const savePasspilotSchoolYearSchema = passpilotSchoolYearSchema.extend({
  expectedRevision: z.number().int().min(0), previewToken: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
type Boundaries = z.infer<typeof passpilotSchoolYearSchema>;
type Actor = Pick<User, "id" | "authVersion">;

async function authority(tx: PasspilotClassTransaction, schoolId: string, actor: Actor, write: boolean) {
  if (write) {
    if (!await lockStaffAssignmentLifecycleSchool(tx, schoolId)) throw schedulingError("School not found.", "SCHOOL_NOT_FOUND", 404);
    await takePasspilotClassLock(tx, schoolId);
  }
  const [school] = await tx.select().from(schools).where(eq(schools.id, schoolId)).limit(1).for("share");
  const licenses = await tx.select().from(productLicenses).where(eq(productLicenses.schoolId, schoolId)).for("share");
  if (!activeEntitledProducts({ school, licenses }).includes("PASSPILOT")) throw schedulingError("An active school and PassPilot license are required.", "PASSPILOT_SCHOOL_YEAR_NOT_ENTITLED", 403);
  const [user] = await tx.select().from(users).where(eq(users.id, actor.id)).limit(1).for("share");
  if (!user || user.authVersion !== actor.authVersion) throw schedulingError("Staff access changed. Sign in again.", "PASSPILOT_SCHOOL_YEAR_AUTHORITY_CHANGED", 403);
  let role: "super_admin" | "admin" | "school_admin" = "super_admin";
  if (!user.isSuperAdmin) {
    const memberships = await tx.select().from(schoolMemberships).where(and(eq(schoolMemberships.schoolId, schoolId), eq(schoolMemberships.userId, actor.id), eq(schoolMemberships.status, "active"))).for("share");
    const administrator = memberships.find(row => row.role === "admin" || row.role === "school_admin");
    if (!administrator) throw schedulingError("Only a school administrator can configure the school year.", "PASSPILOT_SCHOOL_YEAR_ADMIN_REQUIRED", 403);
    role = administrator.role as "admin" | "school_admin";
  }
  // The same row is read by appointment creation and the existing ClassPilot
  // calendar. Never accept timezone or the remaining config over this API.
  await tx.select({ id: classpilotSchoolSchedules.schoolId }).from(classpilotSchoolSchedules).where(eq(classpilotSchoolSchedules.schoolId, schoolId)).for("share");
  const schoolTimezone = school!.schoolTimezone || "America/New_York";
  return { role, schoolTimezone, schoolLocalToday: localDateInTimeZone(new Date(), schoolTimezone) };
}

function snapshot(config: SchoolSchedulingConfig, revision: number, scope: Awaited<ReturnType<typeof authority>>) {
  return { yearStart: config.yearStart, yearEnd: config.yearEnd, revision,
    schoolTimezone: scope.schoolTimezone, schoolLocalToday: scope.schoolLocalToday };
}

export async function getPasspilotSchoolYear(schoolId: string, actor: Actor) {
  return db.transaction(async tx => {
    const scope = await authority(tx, schoolId, actor, false);
    const current = await getSchoolSchedulingContext(schoolId, tx as unknown as typeof db);
    return snapshot(current.config, current.revision, scope);
  });
}

export async function previewPasspilotSchoolYear(schoolId: string, actor: Actor, boundaries: Boundaries) {
  return db.transaction(async tx => {
    const scope = await authority(tx, schoolId, actor, false), database = tx as unknown as typeof db;
    const current = await getSchoolSchedulingContext(schoolId, database);
    const config = normalizeSchoolSchedulingConfig({ ...current.config, ...boundaries });
    const preview = await previewSchoolScheduling({ schoolId, config, dbInstance: database });
    return { ...snapshot(config, preview.revision, scope), previewToken: preview.previewToken,
      changedOccurrences: preview.changedOccurrences, blockers: preview.blockers };
  });
}

export async function savePasspilotSchoolYear(schoolId: string, actor: Actor, input: z.infer<typeof savePasspilotSchoolYearSchema>) {
  return withClasspilotSchedulePostCommitTransaction(async tx => {
    const scope = await authority(tx, schoolId, actor, true), database = tx as unknown as typeof db;
    const current = await getSchoolSchedulingContext(schoolId, database);
    const config = normalizeSchoolSchedulingConfig({ ...current.config, yearStart: input.yearStart, yearEnd: input.yearEnd });
    const result = await saveSchoolSchedulingInTransaction({ schoolId, config, expectedRevision: input.expectedRevision,
      previewToken: input.previewToken, actorId: actor.id, dbInstance: database });
    await tx.insert(auditLogs).values({ schoolId, userId: actor.id, userRole: scope.role, action: "passpilot.school_year.updated",
      entityType: "school_schedule", entityId: schoolId, metadata: { revision: result.revision, yearStart: input.yearStart, yearEnd: input.yearEnd, changedOccurrences: result.changedOccurrences } });
    return { ...snapshot(result.config, result.revision, scope), changedOccurrences: result.changedOccurrences };
  });
}
