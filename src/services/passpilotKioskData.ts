import { and, asc, eq, inArray, or, sql } from "drizzle-orm";
import db from "../db.js";
import { groups, groupStudents } from "../schema/classpilot.js";
import { schoolMemberships, users } from "../schema/core.js";
import {
  grades,
  passes,
  passpilotGradeStudents,
  type Pass,
} from "../schema/passpilot.js";
import { settings } from "../schema/shared.js";
import { students, type Student } from "../schema/students.js";
import { recordPasspilotKioskCounter } from "./passpilotKioskMetrics.js";

export type PasspilotKioskQueryOperation = "config" | "students" | "snapshot";
export type PasspilotKioskClassSource = "legacy_grades" | "classpilot_groups";

export type PasspilotKioskClassRecord = {
  id: string;
  name: string;
};

export type PasspilotKioskRosterState = {
  students: Student[];
  activePasses: Pass[];
};

export type PasspilotKioskTeacherIdentity = {
  kioskName: string | null;
};

const SQL_COUNTER_BY_OPERATION = {
  config: "configSqlStatements",
  students: "studentsSqlStatements",
  snapshot: "snapshotSqlStatements",
} as const;

export function recordPasspilotKioskQueryStatements(
  operation: PasspilotKioskQueryOperation,
  count = 1
): void {
  recordPasspilotKioskCounter(SQL_COUNTER_BY_OPERATION[operation], count);
}

export async function getPasspilotKioskClassSource(
  schoolId: string,
  operation: PasspilotKioskQueryOperation
): Promise<PasspilotKioskClassSource> {
  recordPasspilotKioskQueryStatements(operation);
  const [row] = await db
    .select({ source: settings.passpilotClassSource })
    .from(settings)
    .where(eq(settings.schoolId, schoolId))
    .limit(1);
  return row?.source ?? "legacy_grades";
}

export async function getPasspilotKioskClassRecord(
  schoolId: string,
  source: PasspilotKioskClassSource,
  classId: string,
  operation: PasspilotKioskQueryOperation
): Promise<PasspilotKioskClassRecord | null> {
  recordPasspilotKioskQueryStatements(operation);
  if (source === "classpilot_groups") {
    const [row] = await db
      .select({ id: groups.id, name: groups.name })
      .from(groups)
      .where(
        and(
          eq(groups.schoolId, schoolId),
          eq(groups.id, classId),
          eq(groups.groupType, "admin_class"),
          eq(groups.status, "active")
        )
      )
      .limit(1);
    return row ?? null;
  }

  const [row] = await db
    .select({ id: grades.id, name: grades.name })
    .from(grades)
    .where(and(eq(grades.schoolId, schoolId), eq(grades.id, classId)))
    .limit(1);
  return row ?? null;
}

export async function getPasspilotKioskTeacherIdentity(
  schoolId: string,
  teacherId: string,
  operation?: PasspilotKioskQueryOperation
): Promise<PasspilotKioskTeacherIdentity | null> {
  if (operation) recordPasspilotKioskQueryStatements(operation);
  const [row] = await db
    .select({
      kioskName: schoolMemberships.kioskName,
      displayName: users.displayName,
    })
    .from(schoolMemberships)
    .innerJoin(users, eq(users.id, schoolMemberships.userId))
    .where(
      and(
        eq(schoolMemberships.schoolId, schoolId),
        eq(schoolMemberships.userId, teacherId),
        eq(schoolMemberships.status, "active"),
        inArray(schoolMemberships.role, [
          "admin",
          "school_admin",
          "office_staff",
          "teacher",
        ])
      )
    )
    .limit(1);
  if (!row) return null;
  return { kioskName: row.kioskName || row.displayName || null };
}

async function getLegacyRoster(
  schoolId: string,
  classId: string,
  operation: PasspilotKioskQueryOperation
): Promise<Student[]> {
  recordPasspilotKioskQueryStatements(operation);
  return db
    .select()
    .from(students)
    .where(
      and(
        eq(students.schoolId, schoolId),
        eq(students.status, "active"),
        sql`(
          EXISTS (
            SELECT 1
            FROM ${passpilotGradeStudents} AS kiosk_membership
            WHERE kiosk_membership.school_id = ${schoolId}
              AND kiosk_membership.student_id = ${students.id}
              AND kiosk_membership.grade_id = ${classId}
          )
          OR ${students.gradeId} = ${classId}
        )`
      )
    )
    .orderBy(asc(students.lastName), asc(students.firstName), asc(students.id));
}

async function getCanonicalRoster(
  schoolId: string,
  classId: string,
  operation: PasspilotKioskQueryOperation
): Promise<Student[]> {
  recordPasspilotKioskQueryStatements(operation);
  const rows = await db
    .select({ student: students })
    .from(groupStudents)
    .innerJoin(
      groups,
      and(
        eq(groups.id, groupStudents.groupId),
        eq(groups.schoolId, schoolId),
        eq(groups.groupType, "admin_class"),
        eq(groups.status, "active")
      )
    )
    .innerJoin(
      students,
      and(
        eq(students.id, groupStudents.studentId),
        eq(students.schoolId, schoolId),
        eq(students.status, "active")
      )
    )
    .where(eq(groupStudents.groupId, classId))
    .orderBy(asc(students.lastName), asc(students.firstName), asc(students.id));
  return rows.map((row) => row.student);
}

async function getLegacyActivePasses(
  schoolId: string,
  classId: string,
  operation: PasspilotKioskQueryOperation
): Promise<Pass[]> {
  recordPasspilotKioskQueryStatements(operation);
  const rows = await db
    .select({ pass: passes })
    .from(passes)
    .innerJoin(
      students,
      and(
        eq(students.id, passes.studentId),
        eq(students.schoolId, passes.schoolId),
        eq(students.status, "active")
      )
    )
    .where(
      and(
        eq(passes.schoolId, schoolId),
        eq(passes.gradeId, classId),
        eq(passes.status, "active")
      )
    )
    .orderBy(asc(passes.studentId), asc(passes.id));
  return rows.map((row) => row.pass);
}

async function getCanonicalActivePasses(
  schoolId: string,
  classId: string,
  operation: PasspilotKioskQueryOperation
): Promise<Pass[]> {
  // Compatibility: passes created before canonical cutover may still carry a
  // mapped legacy grade. Resolve all mappings in one bounded statement, then
  // fetch the pass set in one statement regardless of roster size.
  recordPasspilotKioskQueryStatements(operation);
  const mappedGrades = await db
    .select({ id: grades.id })
    .from(grades)
    .where(and(eq(grades.schoolId, schoolId), eq(grades.classpilotGroupId, classId)));

  const classCondition = mappedGrades.length
    ? or(
        eq(passes.classpilotGroupId, classId),
        inArray(passes.gradeId, mappedGrades.map((grade) => grade.id))
      )!
    : eq(passes.classpilotGroupId, classId);

  recordPasspilotKioskQueryStatements(operation);
  const rows = await db
    .select({ pass: passes })
    .from(passes)
    .innerJoin(
      students,
      and(
        eq(students.id, passes.studentId),
        eq(students.schoolId, passes.schoolId),
        eq(students.status, "active")
      )
    )
    .where(
      and(
        eq(passes.schoolId, schoolId),
        classCondition,
        eq(passes.status, "active")
      )
    )
    .orderBy(asc(passes.studentId), asc(passes.id));
  return rows.map((row) => row.pass);
}

export async function getPasspilotKioskRosterState(
  schoolId: string,
  source: PasspilotKioskClassSource,
  classId: string,
  operation: PasspilotKioskQueryOperation
): Promise<PasspilotKioskRosterState> {
  const [studentRows, activePasses] = await Promise.all([
    source === "classpilot_groups"
      ? getCanonicalRoster(schoolId, classId, operation)
      : getLegacyRoster(schoolId, classId, operation),
    source === "classpilot_groups"
      ? getCanonicalActivePasses(schoolId, classId, operation)
      : getLegacyActivePasses(schoolId, classId, operation),
  ]);
  return { students: studentRows, activePasses };
}
