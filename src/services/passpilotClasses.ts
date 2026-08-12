import type { Student } from "../schema/students.js";
import type { Pass } from "../schema/passpilot.js";
import {
  getAdminClassSummariesBySchool,
  getGradeById,
  getGradesBySchool,
  getGroupByIdAndSchool,
  getGroupStudents,
  getGroupTeacherSummaries,
  getGroupsByTeacherAndSchool,
  getPasspilotClassHistoryReferences,
  getStudentsByGrade,
  getSettingsForSchool,
  getTeacherGrades,
  getUserById,
  type PasspilotClassSource,
} from "./storage.js";

export type NormalizedPasspilotClass = {
  id: string;
  classId: string;
  legacyGradeId: string | null;
  source: PasspilotClassSource;
  name: string;
  description: string | null;
  periodLabel: string | null;
  gradeLevel: string | null;
  status: string;
  studentCount: number;
  primaryTeacher: {
    id: string;
    name: string;
  } | null;
  coTeachers: Array<{
    id: string;
    name: string;
  }>;
  historyOnly: boolean;
  filterKey: { type: "classId" | "gradeId"; value: string };
};

function teacherName(user: {
  displayName: string | null;
  firstName: string | null;
  lastName: string | null;
  email: string;
}): string {
  return (
    user.displayName ||
    [user.firstName, user.lastName].filter(Boolean).join(" ") ||
    user.email
  );
}

export async function normalizePasspilotPass(
  pass: Pass,
  schoolId: string
) {
  const grade = pass.gradeId
    ? (await getGradesBySchool(schoolId)).find((entry) => entry.id === pass.gradeId)
    : null;
  const classId = pass.classpilotGroupId || grade?.classpilotGroupId || pass.gradeId || null;
  const className = pass.classNameSnapshot || grade?.name || null;
  const source: PasspilotClassSource = pass.classpilotGroupId
    ? "classpilot_groups"
    : "legacy_grades";
  return {
    ...pass,
    classId,
    className,
    class: classId
      ? {
          id: classId,
          name: className,
          source,
        }
      : null,
  };
}

export async function getPasspilotClasses(
  schoolId: string,
  options: { userId: string; manager: boolean; scope?: "active" | "history" }
): Promise<{ source: PasspilotClassSource; classes: NormalizedPasspilotClass[] }> {
  const source = (await getSettingsForSchool(schoolId))?.passpilotClassSource ?? "legacy_grades";
  const historyScope = options.scope === "history";
  if (source === "legacy_grades") {
    const assignedGrades = options.manager ? [] : await getTeacherGrades(options.userId);
    const references = historyScope
      ? await getPasspilotClassHistoryReferences(schoolId, options.manager ? undefined : options.userId)
      : null;
    const allGrades = await getGradesBySchool(schoolId);
    const allowedGradeIds = options.manager
      ? null
      : new Set([
          ...assignedGrades
          .map((row) => row.grade)
          .filter((grade) => grade.schoolId === schoolId)
          .map((grade) => grade.id),
          ...(references?.legacyGradeIds ?? []),
        ]);
    const visibleLegacyGrades = historyScope
      ? allGrades
      : allGrades.filter((grade) => grade.migrationState !== "history_only");
    const legacyGrades = allowedGradeIds
      ? visibleLegacyGrades.filter((grade) => allowedGradeIds.has(grade.id))
      : visibleLegacyGrades;
    const uniqueGrades = Array.from(new Map(legacyGrades.map((grade) => [grade.id, grade])).values());
    const classes = await Promise.all(
      uniqueGrades.map(async (grade) => {
        const roster = await getStudentsByGrade(schoolId, grade.id);
        return {
          id: grade.id,
          classId: grade.id,
          legacyGradeId: grade.id,
          source,
          name: grade.name,
          description: null,
          periodLabel: null,
          gradeLevel: null,
          status: grade.migrationState === "history_only" ? "history_only" : "active",
          studentCount: roster.length,
          primaryTeacher: null,
          coTeachers: [],
          historyOnly: grade.migrationState === "history_only",
          filterKey: { type: "gradeId", value: grade.id },
        } satisfies NormalizedPasspilotClass;
      })
    );
    return { source, classes };
  }

  const references = historyScope
    ? await getPasspilotClassHistoryReferences(schoolId, options.manager ? undefined : options.userId)
    : null;
  const allClasses = await getAdminClassSummariesBySchool(schoolId, {
    status: historyScope ? "all" : "active",
  });
  const assignedIds = options.manager
    ? null
    : new Set(
        (await getGroupsByTeacherAndSchool(options.userId, schoolId))
          .filter((group) => group.groupType === "admin_class" && (historyScope || group.status === "active"))
          .map((group) => group.id)
      );
  const referencedIds = new Set(references?.canonicalClassIds ?? []);
  const visible = allClasses.filter((group) => {
    if (!historyScope) return options.manager || assignedIds?.has(group.id);
    if (group.status === "active") return options.manager || assignedIds?.has(group.id) || referencedIds.has(group.id);
    return options.manager
      ? referencedIds.has(group.id)
      : !!assignedIds?.has(group.id) || referencedIds.has(group.id);
  });
  const classes: NormalizedPasspilotClass[] = await Promise.all(
    visible.map(async (group) => {
      const [primary, relationships] = await Promise.all([
        getUserById(group.teacherId),
        getGroupTeacherSummaries(group.id, schoolId),
      ]);
      const coTeachers = relationships
        .filter(
          (relationship) =>
            relationship.teacherId !== group.teacherId &&
            relationship.relationshipRole !== "primary"
        )
        .map((relationship) => ({
          id: relationship.teacher.id,
          name: teacherName(relationship.teacher),
        }));
      return {
        id: group.id,
        classId: group.id,
        legacyGradeId: null,
        source,
        name: group.name,
        description: group.description,
        periodLabel: group.periodLabel,
        gradeLevel: group.gradeLevel,
        status: group.status,
        studentCount: group.studentCount,
        primaryTeacher: primary
          ? { id: primary.id, name: teacherName(primary) }
          : null,
        coTeachers,
        historyOnly: false,
        filterKey: { type: "classId", value: group.id },
      } satisfies NormalizedPasspilotClass;
    })
  );

  if (historyScope) {
    const allLegacyGrades = await getGradesBySchool(schoolId);
    const assignedLegacyIds = options.manager
      ? null
      : new Set(
          (await getTeacherGrades(options.userId))
            .filter((row) => row.grade.schoolId === schoolId)
            .map((row) => row.grade.id)
        );
    const ownLegacyHistoryIds = new Set(references?.legacyGradeIds ?? []);
    const legacyHistory = allLegacyGrades.filter((grade) => {
      const linkedCanonicalHistory =
        !!grade.classpilotGroupId &&
        (grade.migrationState === "confirmed" || grade.migrationState === "auto_linked");
      if (linkedCanonicalHistory) return false;
      const historyCount = references?.passCountByLegacyGrade.get(grade.id) ?? 0;
      const hasMigrationRecord = grade.migrationState !== "pending";
      if (historyCount === 0 && !hasMigrationRecord) return false;
      return options.manager || assignedLegacyIds?.has(grade.id) || ownLegacyHistoryIds.has(grade.id);
    });
    for (const grade of legacyHistory) {
      classes.push({
        id: grade.id,
        classId: grade.id,
        legacyGradeId: grade.id,
        source: "legacy_grades",
        name: grade.name,
        description: null,
        periodLabel: null,
        gradeLevel: null,
        status: grade.migrationState === "history_only" ? "history_only" : "legacy_history",
        studentCount: (await getStudentsByGrade(schoolId, grade.id)).length,
        primaryTeacher: null,
        coTeachers: [],
        historyOnly: grade.migrationState === "history_only",
        filterKey: { type: "gradeId", value: grade.id },
      });
    }
  }

  return { source, classes };
}

export async function getPasspilotClassRoster(
  schoolId: string,
  classId: string,
  options: { userId: string; manager: boolean }
): Promise<{
  source: PasspilotClassSource;
  classRecord: NormalizedPasspilotClass;
  students: Student[];
} | null> {
  const inventory = await getPasspilotClasses(schoolId, options);
  const classRecord = inventory.classes.find((entry) => entry.classId === classId);
  if (!classRecord) return null;

  if (inventory.source === "legacy_grades") {
    const grade = await getGradeById(classId);
    if (!grade || grade.schoolId !== schoolId) return null;
    return {
      source: inventory.source,
      classRecord,
      students: await getStudentsByGrade(schoolId, classId),
    };
  }

  const group = await getGroupByIdAndSchool(classId, schoolId);
  if (!group || group.groupType !== "admin_class" || group.status !== "active") return null;
  return {
    source: inventory.source,
    classRecord,
    students: (await getGroupStudents(classId))
      .map((row) => row.student)
      .filter((student) => student.schoolId === schoolId && student.status === "active"),
  };
}
