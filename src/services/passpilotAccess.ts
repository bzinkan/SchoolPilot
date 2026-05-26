import type { Request, RequestHandler, Response } from "express";
import { and, eq, inArray } from "drizzle-orm";
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

function normalizeRole(role: unknown): PassPilotRole | null {
  return typeof role === "string" && PASSPILOT_ROLES.includes(role as PassPilotRole)
    ? (role as PassPilotRole)
    : null;
}

export function isPassPilotManager(role: PassPilotRole | null | undefined): boolean {
  return role === "super_admin" || role === "admin" || role === "school_admin" || role === "office_staff";
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
  if (role !== "teacher" || !student.gradeId) return false;
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

  const teacherGradeIds = await getTeacherGradeIds(user.id, schoolId);
  if (pass.gradeId && teacherGradeIds.has(pass.gradeId)) return true;

  const [student] = await db
    .select({ gradeId: students.gradeId })
    .from(students)
    .where(and(eq(students.id, pass.studentId), eq(students.schoolId, schoolId)))
    .limit(1);
  return !!student?.gradeId && teacherGradeIds.has(student.gradeId);
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

  const allowedPassIds = new Set<string>();
  const missingGradeStudentIds = new Set<string>();

  for (const pass of rawPasses) {
    if (pass.gradeId) {
      if (teacherGradeIds.has(pass.gradeId)) allowedPassIds.add(pass.id);
    } else {
      missingGradeStudentIds.add(pass.studentId);
    }
  }

  if (missingGradeStudentIds.size > 0) {
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
