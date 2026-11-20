import { and, desc, eq, exists, getTableColumns, sql } from "drizzle-orm";
import db from "../db.js";
import { runWithTenantContext } from "../middleware/tenantContext.js";
import { productLicenses, schoolMemberships, schools, users } from "../schema/core.js";
import { groups, groupTeachers } from "../schema/classpilot.js";
import { grades, passes, passpilotKioskDevices, passpilotKioskSessions, teacherGrades } from "../schema/passpilot.js";
import { settings } from "../schema/shared.js";
import { students } from "../schema/students.js";
import { logAuditStrict } from "./audit.js";
import { createPasspilotIndicatorService, type IndicatorAuthority, type IndicatorKioskOption, type IndicatorKioskTarget } from "./passpilotIndicators.js";
import { PasspilotIndicatorStore, type IndicatorPairing } from "./passpilotIndicatorsStore.js";
import { resolveKioskDisplayAssignment } from "./passpilotKioskAssignments.js";
import { kioskDeviceBindingLiveCondition, kioskSessionLiveCondition } from "./storage.js";

type Owner = { schoolId: string; userId: string };

const kioskDeviceJoin = and(
  eq(passpilotKioskDevices.id, passpilotKioskSessions.deviceId),
  eq(passpilotKioskDevices.schoolId, passpilotKioskSessions.schoolId),
  eq(passpilotKioskDevices.teacherId, passpilotKioskSessions.teacherId),
);
// PostgreSQL retains more timestamp precision than a JavaScript Date.
const kioskBindingGeneration = sql<string>`extract(epoch from ${passpilotKioskDevices.createdAt})::text`;

function liveKioskScope(owner: Owner) {
  return and(
    eq(passpilotKioskDevices.schoolId, owner.schoolId),
    eq(passpilotKioskDevices.teacherId, owner.userId),
    eq(passpilotKioskSessions.status, "active"),
    kioskSessionLiveCondition(),
    kioskDeviceBindingLiveCondition(),
  );
}

async function resolveKioskTarget(owner: Owner, kioskSessionId: string): Promise<IndicatorKioskTarget | null> {
  const [row] = await db.select({ kioskDeviceId: passpilotKioskDevices.id, kioskBindingGeneration })
    .from(passpilotKioskSessions)
    .innerJoin(passpilotKioskDevices, kioskDeviceJoin)
    .where(and(liveKioskScope(owner), eq(passpilotKioskSessions.id, kioskSessionId)))
    .limit(1);
  return row ?? null;
}

async function listKiosks(owner: Owner): Promise<IndicatorKioskOption[]> {
  const sessions = await db
    .select(getTableColumns(passpilotKioskSessions))
    .from(passpilotKioskSessions)
    .innerJoin(passpilotKioskDevices, kioskDeviceJoin)
    .where(liveKioskScope(owner))
    .orderBy(desc(passpilotKioskSessions.lastSeenAt), desc(passpilotKioskSessions.createdAt), passpilotKioskSessions.id);
  return Promise.all(sessions.map(async (session) => {
    const assignment = await resolveKioskDisplayAssignment(owner.schoolId, session);
    return { kioskSessionId: session.id, className: assignment.current?.name ?? null, lastSeenAt: session.lastSeenAt.toISOString() };
  }));
}

/** One aggregate row; no pass or student records are projected to the gateway. */
export function indicatorPassMaskQuery(pairing: IndicatorPairing) {
  const water = pairing.waterCustomDestination === undefined
    ? sql`false`
    : and(eq(passes.destination, "custom"), eq(passes.customDestination, pairing.waterCustomDestination))!;
  const kioskPairing = "kioskDeviceId" in pairing;
  const passScope = kioskPairing
    ? and(eq(passes.issuedVia, "kiosk"), exists(
      db.select({ id: passpilotKioskSessions.id }).from(passpilotKioskSessions).where(and(
        eq(passpilotKioskSessions.id, passes.issuingKioskSessionId),
        eq(passpilotKioskSessions.schoolId, passes.schoolId),
        eq(passpilotKioskSessions.teacherId, passes.teacherId),
        eq(passpilotKioskSessions.deviceId, pairing.kioskDeviceId),
      )),
    ))
    : pairing.classSource === "legacy_grades"
      ? eq(passes.gradeId, pairing.classId)
      : eq(passes.classpilotGroupId, pairing.classId);
  const maskQuery = db.select({
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
    passScope,
  ));
  if (!kioskPairing) return maskQuery;
  // An empty result means the device no longer has authority. Its current
  // session and historical passes must be checked in the same SQL snapshot.
  return maskQuery.having(exists(
    db.select({ id: passpilotKioskSessions.id })
      .from(passpilotKioskSessions)
      .innerJoin(passpilotKioskDevices, kioskDeviceJoin)
      .where(and(
        liveKioskScope(pairing),
        eq(passpilotKioskDevices.id, pairing.kioskDeviceId),
        eq(kioskBindingGeneration, pairing.kioskBindingGeneration),
      )),
  ));
}

async function loadAuthority(scope: Owner & { classId?: string }): Promise<IndicatorAuthority> {
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
  if (scope.classId !== undefined && classSource === "legacy_grades") {
    const [row] = await db.select({ migrationState: grades.migrationState, assignedTeacherId: teacherGrades.teacherId }).from(grades)
      .leftJoin(teacherGrades, and(eq(teacherGrades.gradeId, grades.id), eq(teacherGrades.teacherId, scope.userId)))
      .where(and(eq(grades.schoolId, scope.schoolId), eq(grades.id, scope.classId))).limit(1);
    classActive = Boolean(row && row.migrationState !== "history_only");
    classAuthorized = classActive && (manager || row?.assignedTeacherId === scope.userId);
  } else if (scope.classId !== undefined && classSource === "classpilot_groups") {
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
    schoolActive: Boolean(school && school.status === "active" && school.isActive !== false && !school.disabledAt && !school.deletedAt && school.planStatus !== "canceled" && (!school.activeUntil || school.activeUntil.getTime() > now) && (scope.classId !== undefined || school.kioskEnabled)),
    licensed: Boolean(license && license.status === "active" && (!license.expiresAt || license.expiresAt.getTime() > now)),
    staffActive, classActive, classAuthorized,
  };
}

export const passpilotIndicatorService = createPasspilotIndicatorService({
  store: new PasspilotIndicatorStore(),
  loadAuthority,
  resolveKioskTarget,
  listKiosks,
  withSchoolContext: (schoolId, fn) => runWithTenantContext({ schoolId }, fn),
  loadMask: async (pairing) => (await indicatorPassMaskQuery(pairing))[0]?.mask ?? null,
  audit: logAuditStrict,
});
