import { and, eq, sql } from "drizzle-orm";
import db from "../db.js";
import { runWithTenantContext } from "../middleware/tenantContext.js";
import { productLicenses, schoolMemberships, schools, users } from "../schema/core.js";
import { groups, groupTeachers } from "../schema/classpilot.js";
import { grades, passes, teacherGrades } from "../schema/passpilot.js";
import { settings } from "../schema/shared.js";
import { students } from "../schema/students.js";
import { logAuditStrict } from "./audit.js";
import { createPasspilotIndicatorService, type IndicatorAuthority } from "./passpilotIndicators.js";
import { PasspilotIndicatorStore, type IndicatorPairing } from "./passpilotIndicatorsStore.js";

/** One aggregate row; no pass or student records are projected to the gateway. */
export function indicatorPassMaskQuery(pairing: IndicatorPairing) {
  const water = pairing.waterCustomDestination === undefined
    ? sql`false`
    : and(eq(passes.destination, "custom"), eq(passes.customDestination, pairing.waterCustomDestination))!;
  return db.select({
    mask: sql<number>`coalesce(bit_or(case
      when ${passes.destination} = 'bathroom' or (${water}) then 1
      when ${passes.destination} = 'office' then 2
      when ${passes.destination} = 'nurse' then 4
      else 0 end), 0)::int`,
  }).from(passes).innerJoin(students, and(
    eq(students.id, passes.studentId),
    eq(students.schoolId, passes.schoolId),
    eq(students.status, "active"),
  )).where(and(
    eq(passes.schoolId, pairing.schoolId),
    eq(passes.teacherId, pairing.userId),
    eq(passes.status, "active"),
    pairing.classSource === "legacy_grades" ? eq(passes.gradeId, pairing.classId) : eq(passes.classpilotGroupId, pairing.classId),
  ));
}

async function loadAuthority(scope: { schoolId: string; userId: string; classId: string }): Promise<IndicatorAuthority> {
  const [schoolState] = await db.select({ school: schools, license: productLicenses, classSource: settings.passpilotClassSource })
    .from(schools)
    .leftJoin(productLicenses, and(eq(productLicenses.schoolId, schools.id), eq(productLicenses.product, "PASSPILOT")))
    .leftJoin(settings, eq(settings.schoolId, schools.id))
    .where(eq(schools.id, scope.schoolId)).limit(1);
  const memberships = await db.select({ role: schoolMemberships.role }).from(schoolMemberships)
    .innerJoin(users, eq(users.id, schoolMemberships.userId))
    .where(and(eq(schoolMemberships.schoolId, scope.schoolId), eq(schoolMemberships.userId, scope.userId), eq(schoolMemberships.status, "active")));
  const staffActive = memberships.some(({ role }) => ["admin", "school_admin", "office_staff", "teacher"].includes(role));
  const manager = memberships.some(({ role }) => ["admin", "school_admin", "office_staff"].includes(role));
  const classSource = schoolState?.classSource ?? "legacy_grades";
  let classActive = false;
  let classAuthorized = false;
  if (classSource === "legacy_grades") {
    const [row] = await db.select({ migrationState: grades.migrationState, assignedTeacherId: teacherGrades.teacherId }).from(grades)
      .leftJoin(teacherGrades, and(eq(teacherGrades.gradeId, grades.id), eq(teacherGrades.teacherId, scope.userId)))
      .where(and(eq(grades.schoolId, scope.schoolId), eq(grades.id, scope.classId))).limit(1);
    classActive = Boolean(row && row.migrationState !== "history_only");
    classAuthorized = classActive && (manager || row?.assignedTeacherId === scope.userId);
  } else if (classSource === "classpilot_groups") {
    const [row] = await db.select({ status: groups.status, groupType: groups.groupType, teacherId: groups.teacherId, assignedTeacherId: groupTeachers.teacherId }).from(groups)
      .leftJoin(groupTeachers, and(eq(groupTeachers.groupId, groups.id), eq(groupTeachers.teacherId, scope.userId)))
      .where(and(eq(groups.schoolId, scope.schoolId), eq(groups.id, scope.classId))).limit(1);
    classActive = row?.status === "active" && row.groupType === "admin_class";
    classAuthorized = classActive && (manager || row?.teacherId === scope.userId || row?.assignedTeacherId === scope.userId);
  }
  const now = Date.now();
  const school = schoolState?.school;
  const license = schoolState?.license;
  return {
    classSource,
    schoolActive: Boolean(school && school.status === "active" && school.isActive !== false && !school.disabledAt && !school.deletedAt && school.planStatus !== "canceled" && (!school.activeUntil || school.activeUntil.getTime() > now)),
    licensed: Boolean(license && license.status === "active" && (!license.expiresAt || license.expiresAt.getTime() > now)),
    staffActive, classActive, classAuthorized,
  };
}

export const passpilotIndicatorService = createPasspilotIndicatorService({
  store: new PasspilotIndicatorStore(),
  loadAuthority,
  withSchoolContext: (schoolId, fn) => runWithTenantContext({ schoolId }, fn),
  loadMask: async (pairing) => (await indicatorPassMaskQuery(pairing))[0]?.mask ?? 0,
  audit: logAuditStrict,
});
