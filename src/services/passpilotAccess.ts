import type { Request, RequestHandler, Response } from "express";
import { and, eq, inArray, or } from "drizzle-orm";
import db from "../db.js";
import {
  schoolMemberships,
  type SchoolMembership,
  type User,
} from "../schema/core.js";
import {
  grades,
  passes,
  teacherGrades,
  type Pass,
} from "../schema/passpilot.js";
import { students } from "../schema/students.js";
import { groups, groupStudents, groupTeachers } from "../schema/classpilot.js";
import { settings } from "../schema/shared.js";

export type PassPilotRole =
  | "super_admin"
  | "admin"
  | "school_admin"
  | "office_staff"
  | "teacher";

const PASSPILOT_ROLES: PassPilotRole[] = [
  "super_admin",
  "admin",
  "school_admin",
  "office_staff",
  "teacher",
];

export const PASSPILOT_CANONICAL_CLASS_MODEL = "classpilot-groups-v1";

export function hasPasspilotCanonicalClassCapability(req: Request): boolean {
  return req.get("x-passpilot-class-model") === PASSPILOT_CANONICAL_CLASS_MODEL;
}

export const requirePasspilotClassModel: RequestHandler = async (req, res, next) => {
  try {
    const schoolId = res.locals.schoolId as string | undefined;
    if (!schoolId) return res.status(400).json({ error: "School context required" });
    const source = await getPasspilotClassSourceForSchool(schoolId);
    if (source === "classpilot_groups" && !hasPasspilotCanonicalClassCapability(req)) {
      return res.status(426).json({
        error: "This school uses the ClassPilot class model. Refresh or update PassPilot before continuing.",
        code: "PASSPILOT_CLASS_MODEL_UPGRADE_REQUIRED",
        requiredClassModel: PASSPILOT_CANONICAL_CLASS_MODEL,
      });
    }
    return next();
  } catch (err) {
    return next(err);
  }
};

export const requireLegacyPasspilotClassSource: RequestHandler = async (_req, res, next) => {
  try {
    const schoolId = res.locals.schoolId as string | undefined;
    if (!schoolId) return res.status(400).json({ error: "School context required" });
    if ((await getPasspilotClassSourceForSchool(schoolId)) === "classpilot_groups") {
      return res.status(409).json({
        error: "PassPilot classes are managed in ClassPilot after migration.",
        code: "CLASSES_MANAGED_IN_CLASSPILOT",
        classEndpoint: "/api/passpilot/classes",
        managementUrl: "/classpilot/admin/classes?returnTo=%2Fpasspilot%2Fclasses",
      });
    }
    return next();
  } catch (err) {
    return next(err);
  }
};

function normalizeRole(role: unknown): PassPilotRole | null {
  return typeof role === "string" && PASSPILOT_ROLES.includes(role as PassPilotRole)
    ? (role as PassPilotRole)
    : null;
}

export function isPassPilotManager(role: PassPilotRole | null | undefined): boolean {
  return role === "super_admin" || role === "admin" || role === "school_admin" || role === "office_staff";
}

export async function getPasspilotClassSourceForSchool(
  schoolId: string
): Promise<"legacy_grades" | "classpilot_groups"> {
  const [row] = await db
    .select({ source: settings.passpilotClassSource })
    .from(settings)
    .where(eq(settings.schoolId, schoolId))
    .limit(1);
  return row?.source ?? "legacy_grades";
}

export async function getCanonicalClassForSchool(classId: string, schoolId: string) {
  const [group] = await db
    .select()
    .from(groups)
    .where(
      and(
        eq(groups.id, classId),
        eq(groups.schoolId, schoolId),
        eq(groups.groupType, "admin_class"),
        eq(groups.status, "active")
      )
    )
    .limit(1);
  return group;
}

export async function getCanonicalClassForSchoolIncludingArchived(
  classId: string,
  schoolId: string
) {
  const [group] = await db
    .select()
    .from(groups)
    .where(
      and(
        eq(groups.id, classId),
        eq(groups.schoolId, schoolId),
        eq(groups.groupType, "admin_class")
      )
    )
    .limit(1);
  return group;
}

export async function getTeacherCanonicalClassIds(
  teacherId: string,
  schoolId: string
): Promise<Set<string>> {
  const rows = await db
    .select({ id: groups.id })
    .from(groups)
    .leftJoin(groupTeachers, eq(groupTeachers.groupId, groups.id))
    .where(
      and(
        eq(groups.schoolId, schoolId),
        eq(groups.groupType, "admin_class"),
        eq(groups.status, "active"),
        or(eq(groups.teacherId, teacherId), eq(groupTeachers.teacherId, teacherId))
      )
    );
  return new Set(rows.map((row) => row.id));
}

async function getTeacherCanonicalHistoryClassIds(
  teacherId: string,
  schoolId: string
): Promise<Set<string>> {
  const rows = await db
    .select({ id: groups.id })
    .from(groups)
    .leftJoin(groupTeachers, eq(groupTeachers.groupId, groups.id))
    .where(
      and(
        eq(groups.schoolId, schoolId),
        eq(groups.groupType, "admin_class"),
        or(eq(groups.teacherId, teacherId), eq(groupTeachers.teacherId, teacherId))
      )
    );
  return new Set(rows.map((row) => row.id));
}

export async function canAccessPasspilotClass(
  user: User,
  schoolId: string,
  classId: string,
  role: PassPilotRole | null
): Promise<boolean> {
  const source = await getPasspilotClassSourceForSchool(schoolId);
  if (source === "legacy_grades") return canAccessGrade(user, schoolId, classId, role);
  if (isPassPilotManager(role)) {
    return !!(await getCanonicalClassForSchoolIncludingArchived(classId, schoolId));
  }
  if (!(await getCanonicalClassForSchool(classId, schoolId))) return false;
  if (role !== "teacher") return false;
  return (await getTeacherCanonicalClassIds(user.id, schoolId)).has(classId);
}

export async function canAccessCanonicalPassHistory(
  user: User,
  schoolId: string,
  classId: string,
  role: PassPilotRole | null
): Promise<boolean> {
  const group = await getCanonicalClassForSchoolIncludingArchived(classId, schoolId);
  if (!group) return false;
  if (isPassPilotManager(role)) return true;
  if (role !== "teacher") return false;
  if (group.teacherId === user.id) return true;
  const [relationship] = await db
    .select({ id: groupTeachers.id })
    .from(groupTeachers)
    .where(
      and(eq(groupTeachers.groupId, classId), eq(groupTeachers.teacherId, user.id))
    )
    .limit(1);
  if (relationship) return true;

  const mappedGrades = await db
    .select({ id: grades.id })
    .from(grades)
    .where(and(eq(grades.schoolId, schoolId), eq(grades.classpilotGroupId, classId)));
  const passClassCondition = mappedGrades.length > 0
    ? or(
        eq(passes.classpilotGroupId, classId),
        inArray(passes.gradeId, mappedGrades.map((grade) => grade.id))
      )!
    : eq(passes.classpilotGroupId, classId);
  const [issued] = await db
    .select({ id: passes.id })
    .from(passes)
    .where(
      and(
        eq(passes.schoolId, schoolId),
        eq(passes.teacherId, user.id),
        passClassCondition
      )
    )
    .limit(1);
  return !!issued;
}

export async function isStudentInCanonicalClass(
  studentId: string,
  classId: string,
  schoolId: string
): Promise<boolean> {
  const [row] = await db
    .select({ id: groupStudents.id })
    .from(groupStudents)
    .innerJoin(groups, eq(groups.id, groupStudents.groupId))
    .innerJoin(students, eq(students.id, groupStudents.studentId))
    .where(
      and(
        eq(groupStudents.groupId, classId),
        eq(groupStudents.studentId, studentId),
        eq(groups.schoolId, schoolId),
        eq(groups.groupType, "admin_class"),
        eq(groups.status, "active"),
        eq(students.schoolId, schoolId),
        eq(students.status, "active")
      )
    )
    .limit(1);
  return !!row;
}

export async function getPassPilotMembership(
  userId: string,
  schoolId: string
): Promise<SchoolMembership | undefined> {
  const [membership] = await db
    .select()
    .from(schoolMemberships)
    .where(
      and(
        eq(schoolMemberships.userId, userId),
        eq(schoolMemberships.schoolId, schoolId),
        eq(schoolMemberships.status, "active")
      )
    )
    .limit(1);
  return membership;
}

export async function getRequestPassPilotRole(
  req: Request,
  res: Response
): Promise<PassPilotRole | null> {
  if (req.authUser?.isSuperAdmin) {
    res.locals.passpilotRole = "super_admin";
    return "super_admin";
  }

  if (res.locals.passpilotRole) {
    return normalizeRole(res.locals.passpilotRole);
  }

  const schoolId = res.locals.schoolId as string | undefined;
  const userId = req.authUser?.id;
  if (!schoolId || !userId) return null;

  const roleFromContext = normalizeRole(res.locals.membershipRole);
  if (roleFromContext) {
    res.locals.passpilotRole = roleFromContext;
    return roleFromContext;
  }

  const membership = await getPassPilotMembership(userId, schoolId);
  const role = normalizeRole(membership?.role);
  if (role) res.locals.passpilotRole = role;
  return role;
}

export function requirePassPilotRole(...roles: PassPilotRole[]): RequestHandler {
  return async (req, res, next) => {
    const role = await getRequestPassPilotRole(req, res);
    if (!role) {
      return res.status(403).json({ error: "No PassPilot access for this school" });
    }
    if (role === "super_admin" || roles.includes(role)) {
      return next();
    }
    return res.status(403).json({ error: "Insufficient permissions" });
  };
}

export async function getGradeForSchool(gradeId: string, schoolId: string) {
  const [grade] = await db
    .select()
    .from(grades)
    .where(and(eq(grades.id, gradeId), eq(grades.schoolId, schoolId)))
    .limit(1);
  return grade;
}

export async function getPassForSchool(passId: string, schoolId: string) {
  const [pass] = await db
    .select()
    .from(passes)
    .where(and(eq(passes.id, passId), eq(passes.schoolId, schoolId)))
    .limit(1);
  return pass;
}

export async function getTeacherGradeIds(
  teacherId: string,
  schoolId: string
): Promise<Set<string>> {
  const rows = await db
    .select({ gradeId: grades.id })
    .from(teacherGrades)
    .innerJoin(grades, eq(teacherGrades.gradeId, grades.id))
    .where(
      and(
        eq(teacherGrades.teacherId, teacherId),
        eq(grades.schoolId, schoolId)
      )
    );
  return new Set(rows.map((row) => row.gradeId));
}

export async function getTeacherGradeAssignments(
  teacherId: string,
  schoolId: string
) {
  return db
    .select({
      teacherGrade: teacherGrades,
      grade: grades,
    })
    .from(teacherGrades)
    .innerJoin(grades, eq(teacherGrades.gradeId, grades.id))
    .where(
      and(
        eq(teacherGrades.teacherId, teacherId),
        eq(grades.schoolId, schoolId)
      )
    );
}

export async function canAccessGrade(
  user: User,
  schoolId: string,
  gradeId: string,
  role: PassPilotRole | null
): Promise<boolean> {
  const grade = await getGradeForSchool(gradeId, schoolId);
  if (!grade) return false;
  if (isPassPilotManager(role)) return true;
  if (role !== "teacher") return false;
  const teacherGradeIds = await getTeacherGradeIds(user.id, schoolId);
  return teacherGradeIds.has(gradeId);
}

export async function canAccessLegacyPassHistory(
  user: User,
  schoolId: string,
  gradeId: string,
  role: PassPilotRole | null
): Promise<boolean> {
  const grade = await getGradeForSchool(gradeId, schoolId);
  if (!grade) return false;
  if (isPassPilotManager(role)) return true;
  if (role !== "teacher") return false;
  if ((await getTeacherGradeIds(user.id, schoolId)).has(gradeId)) return true;
  const [issued] = await db
    .select({ id: passes.id })
    .from(passes)
    .where(
      and(
        eq(passes.schoolId, schoolId),
        eq(passes.gradeId, gradeId),
        eq(passes.teacherId, user.id)
      )
    )
    .limit(1);
  return !!issued;
}

export async function canAccessStudent(
  user: User,
  schoolId: string,
  studentId: string,
  role: PassPilotRole | null
): Promise<boolean> {
  const [student] = await db
    .select({ id: students.id, gradeId: students.gradeId })
    .from(students)
    .where(and(eq(students.id, studentId), eq(students.schoolId, schoolId)))
    .limit(1);
  if (!student) return false;
  if (isPassPilotManager(role)) return true;
  if (role !== "teacher") return false;
  if ((await getPasspilotClassSourceForSchool(schoolId)) === "classpilot_groups") {
    const allowedClassIds = await getTeacherCanonicalClassIds(user.id, schoolId);
    if (allowedClassIds.size === 0) return false;
    const [membership] = await db
      .select({ id: groupStudents.id })
      .from(groupStudents)
      .where(
        and(
          eq(groupStudents.studentId, studentId),
          inArray(groupStudents.groupId, Array.from(allowedClassIds))
        )
      )
      .limit(1);
    return !!membership;
  }
  if (!student.gradeId) return false;
  const teacherGradeIds = await getTeacherGradeIds(user.id, schoolId);
  return teacherGradeIds.has(student.gradeId);
}

export async function canAccessPass(
  user: User,
  schoolId: string,
  pass: Pass,
  role: PassPilotRole | null
): Promise<boolean> {
  if (pass.schoolId !== schoolId) return false;
  if (isPassPilotManager(role)) return true;
  if (role !== "teacher") return false;
  if (pass.teacherId === user.id) return true;

  const source = await getPasspilotClassSourceForSchool(schoolId);
  const canonicalClassIds = source === "classpilot_groups"
    ? await getTeacherCanonicalClassIds(user.id, schoolId)
    : new Set<string>();
  if (pass.classpilotGroupId) return canonicalClassIds.has(pass.classpilotGroupId);

  if (source === "classpilot_groups" && pass.gradeId) {
    const [legacyGrade] = await db
      .select({ classpilotGroupId: grades.classpilotGroupId })
      .from(grades)
      .where(and(eq(grades.id, pass.gradeId), eq(grades.schoolId, schoolId)))
      .limit(1);
    if (legacyGrade?.classpilotGroupId) {
      return canonicalClassIds.has(legacyGrade.classpilotGroupId);
    }
  }

  const teacherGradeIds = await getTeacherGradeIds(user.id, schoolId);
  if (pass.gradeId && teacherGradeIds.has(pass.gradeId)) return true;

  const [student] = await db
    .select({ gradeId: students.gradeId })
    .from(students)
    .where(and(eq(students.id, pass.studentId), eq(students.schoolId, schoolId)))
    .limit(1);
  return !!student?.gradeId && teacherGradeIds.has(student.gradeId);
}

export type PassHistoryQueryAccessScope = {
  issuerTeacherId: string;
  classIds: string[];
  gradeIds: string[];
  studentIds: string[];
};

export async function getPassHistoryQueryAccessScope(
  user: User,
  schoolId: string,
  role: PassPilotRole | null
): Promise<PassHistoryQueryAccessScope | null> {
  if (isPassPilotManager(role)) return null;
  const empty = {
    issuerTeacherId: user.id,
    classIds: [] as string[],
    gradeIds: [] as string[],
    studentIds: [] as string[],
  };
  if (role !== "teacher") return empty;

  const source = await getPasspilotClassSourceForSchool(schoolId);
  const teacherGradeIds = await getTeacherGradeIds(user.id, schoolId);
  const canonicalClassIds = source === "classpilot_groups"
    ? await getTeacherCanonicalHistoryClassIds(user.id, schoolId)
    : new Set<string>();
  const mappedGrades = canonicalClassIds.size > 0
    ? await db
        .select({ id: grades.id })
        .from(grades)
        .where(
          and(
            eq(grades.schoolId, schoolId),
            inArray(grades.classpilotGroupId, Array.from(canonicalClassIds))
          )
        )
    : [];
  const allowedGradeIds = new Set([
    ...teacherGradeIds,
    ...mappedGrades.map((grade) => grade.id),
  ]);

  const canonicalStudentRows = canonicalClassIds.size > 0
    ? await db
        .select({ studentId: groupStudents.studentId })
        .from(groupStudents)
        .innerJoin(groups, eq(groups.id, groupStudents.groupId))
        .innerJoin(students, eq(students.id, groupStudents.studentId))
        .where(
          and(
            inArray(groupStudents.groupId, Array.from(canonicalClassIds)),
            eq(groups.schoolId, schoolId),
            eq(groups.groupType, "admin_class"),
            eq(groups.status, "active"),
            eq(students.schoolId, schoolId),
            eq(students.status, "active")
          )
        )
    : [];
  const legacyStudentRows = allowedGradeIds.size > 0
    ? await db
        .select({ studentId: students.id })
        .from(students)
        .where(
          and(
            eq(students.schoolId, schoolId),
            inArray(students.gradeId, Array.from(allowedGradeIds))
          )
        )
    : [];

  return {
    issuerTeacherId: user.id,
    classIds: Array.from(canonicalClassIds),
    gradeIds: Array.from(allowedGradeIds),
    studentIds: Array.from(
      new Set([
        ...canonicalStudentRows.map((row) => row.studentId),
        ...legacyStudentRows.map((row) => row.studentId),
      ])
    ),
  };
}

export async function filterPassesForRole(
  rawPasses: Pass[],
  user: User,
  schoolId: string,
  role: PassPilotRole | null
): Promise<Pass[]> {
  if (isPassPilotManager(role)) return rawPasses;
  if (role !== "teacher") return [];
  const teacherGradeIds = await getTeacherGradeIds(user.id, schoolId);
  const source = await getPasspilotClassSourceForSchool(schoolId);
  const canonicalClassIds = source === "classpilot_groups"
    ? await getTeacherCanonicalClassIds(user.id, schoolId)
    : new Set<string>();

  const legacyGradeIds = Array.from(
    new Set(rawPasses.map((pass) => pass.gradeId).filter(Boolean) as string[])
  );
  const mappedGradeRows = legacyGradeIds.length > 0
    ? await db
        .select({ id: grades.id, classpilotGroupId: grades.classpilotGroupId })
        .from(grades)
        .where(and(eq(grades.schoolId, schoolId), inArray(grades.id, legacyGradeIds)))
    : [];
  const mappedClassByGrade = new Map(
    mappedGradeRows.map((grade) => [grade.id, grade.classpilotGroupId])
  );

  const allowedPassIds = new Set<string>();
  const missingGradeStudentIds = new Set<string>();

  for (const pass of rawPasses) {
    if (pass.teacherId === user.id) {
      allowedPassIds.add(pass.id);
      continue;
    }
    if (pass.classpilotGroupId) {
      if (canonicalClassIds.has(pass.classpilotGroupId)) allowedPassIds.add(pass.id);
    } else if (pass.gradeId) {
      const mappedClassId = mappedClassByGrade.get(pass.gradeId);
      if (mappedClassId) {
        if (canonicalClassIds.has(mappedClassId)) allowedPassIds.add(pass.id);
      } else if (teacherGradeIds.has(pass.gradeId)) {
        allowedPassIds.add(pass.id);
      }
    } else {
      missingGradeStudentIds.add(pass.studentId);
    }
  }

  if (missingGradeStudentIds.size > 0) {
    if (source === "classpilot_groups" && canonicalClassIds.size > 0) {
      const membershipRows = await db
        .select({ studentId: groupStudents.studentId })
        .from(groupStudents)
        .where(
          and(
            inArray(groupStudents.groupId, Array.from(canonicalClassIds)),
            inArray(groupStudents.studentId, Array.from(missingGradeStudentIds))
          )
        );
      const allowedStudentIds = new Set(membershipRows.map((row) => row.studentId));
      for (const pass of rawPasses) {
        if (!pass.gradeId && !pass.classpilotGroupId && allowedStudentIds.has(pass.studentId)) {
          allowedPassIds.add(pass.id);
        }
      }
      return rawPasses.filter((pass) => allowedPassIds.has(pass.id));
    }
    const studentRows = await db
      .select({ id: students.id, gradeId: students.gradeId })
      .from(students)
      .where(
        and(
          eq(students.schoolId, schoolId),
          inArray(students.id, Array.from(missingGradeStudentIds))
        )
      );

    const allowedStudentIds = new Set(
      studentRows
        .filter((student) => !!student.gradeId && teacherGradeIds.has(student.gradeId))
        .map((student) => student.id)
    );

    for (const pass of rawPasses) {
      if (!pass.gradeId && allowedStudentIds.has(pass.studentId)) {
        allowedPassIds.add(pass.id);
      }
    }
  }

  return rawPasses.filter((pass) => allowedPassIds.has(pass.id));
}

export async function userBelongsToSchool(userId: string, schoolId: string): Promise<boolean> {
  const membership = await getPassPilotMembership(userId, schoolId);
  return !!membership;
}
