import type { Student } from "../schema/students.js";
import type { Pass } from "../schema/passpilot.js";
import {
  getActivePassesByStudentIds,
  getAdminClassSummariesBySchool,
  getGradeById,
  getGradesBySchool,
  getGroupByIdAndSchool,
  getGroupStudentIdsForGroups,
  getGroupStudents,
  getGroupTeacherIdsForGroups,
  getGroupTeacherSummaries,
  getGroupsByTeacherAndSchool,
  getLegacyPasspilotStudentIdsForGrades,
  getPasspilotClassHistoryReferences,
  getStudentsByGrade,
  getSettingsForSchool,
  getTeacherGrades,
  getUserById,
  isTeacherAssignedToLegacyPasspilotGrade,
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
  activePassCount: number;
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

async function getActiveRosterStudentIds(
  schoolId: string,
  studentIdsByClass: Map<string, Set<string>>
): Promise<Set<string>> {
  const studentIds = new Set<string>();
  for (const rosterIds of studentIdsByClass.values()) {
    for (const studentId of rosterIds) studentIds.add(studentId);
  }
  const activePasses = await getActivePassesByStudentIds(
    schoolId,
    Array.from(studentIds)
  );
  return new Set(activePasses.map((pass) => pass.studentId));
}

function countActiveRosterStudents(
  rosterStudentIds: Set<string> | undefined,
  activePassStudentIds: Set<string>
): number {
  if (!rosterStudentIds || rosterStudentIds.size === 0) return 0;
  let count = 0;
  for (const studentId of rosterStudentIds) {
    if (activePassStudentIds.has(studentId)) count += 1;
  }
  return count;
}

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
    const rosterStudentIdsByGrade = await getLegacyPasspilotStudentIdsForGrades(
      schoolId,
      uniqueGrades.map((grade) => grade.id)
    );
    const activePassStudentIds = historyScope
      ? new Set<string>()
      : await getActiveRosterStudentIds(schoolId, rosterStudentIdsByGrade);
    const classes = uniqueGrades.map((grade) => {
      const rosterStudentIds = rosterStudentIdsByGrade.get(grade.id) ?? new Set<string>();
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
        studentCount: rosterStudentIds.size,
        activePassCount: countActiveRosterStudents(rosterStudentIds, activePassStudentIds),
        primaryTeacher: null,
        coTeachers: [],
        historyOnly: grade.migrationState === "history_only",
        filterKey: { type: "gradeId", value: grade.id },
      } satisfies NormalizedPasspilotClass;
    });
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
  const rosterStudentIdsByClass = await getGroupStudentIdsForGroups(
    schoolId,
    visible.map((group) => group.id)
  );
  const activePassStudentIds = historyScope
    ? new Set<string>()
    : await getActiveRosterStudentIds(schoolId, rosterStudentIdsByClass);
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
        activePassCount: countActiveRosterStudents(
          rosterStudentIdsByClass.get(group.id),
          activePassStudentIds
        ),
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
    const legacyRosterStudentIdsByGrade = await getLegacyPasspilotStudentIdsForGrades(
      schoolId,
      legacyHistory.map((grade) => grade.id)
    );
    // History access may outlive a teacher's current class assignment. Never
    // expose live out-of-class counts through the history inventory.
    const legacyActivePassStudentIds = new Set<string>();
    for (const grade of legacyHistory) {
      const rosterStudentIds = legacyRosterStudentIdsByGrade.get(grade.id) ?? new Set<string>();
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
        studentCount: rosterStudentIds.size,
        activePassCount: countActiveRosterStudents(
          rosterStudentIds,
          legacyActivePassStudentIds
        ),
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

export async function getPasspilotClassActivePasses(
  schoolId: string,
  classId: string,
  options: { userId: string; manager: boolean }
): Promise<{
  source: PasspilotClassSource;
  classId: string;
  passes: Pass[];
} | null> {
  const source = (await getSettingsForSchool(schoolId))?.passpilotClassSource ?? "legacy_grades";
  let rosterStudentIds: string[];

  if (source === "legacy_grades") {
    const grade = await getGradeById(classId);
    if (
      !grade ||
      grade.schoolId !== schoolId ||
      grade.migrationState === "history_only"
    ) {
      return null;
    }
    if (
      !options.manager &&
      !(await isTeacherAssignedToLegacyPasspilotGrade(
        schoolId,
        classId,
        options.userId
      ))
    ) {
      return null;
    }
    rosterStudentIds = (await getStudentsByGrade(schoolId, classId)).map(
      (student) => student.id
    );
  } else {
    const group = await getGroupByIdAndSchool(classId, schoolId);
    if (
      !group ||
      group.groupType !== "admin_class" ||
      group.status !== "active"
    ) {
      return null;
    }
    if (!options.manager && group.teacherId !== options.userId) {
      const assignedTeacherIds = await getGroupTeacherIdsForGroups(schoolId, [classId]);
      if (!assignedTeacherIds.get(classId)?.has(options.userId)) return null;
    }
    rosterStudentIds = (await getGroupStudents(classId))
      .map((row) => row.student)
      .filter(
        (student) => student.schoolId === schoolId && student.status === "active"
      )
      .map((student) => student.id);
  }

  return {
    source,
    classId,
    passes: await getActivePassesByStudentIds(
      schoolId,
      rosterStudentIds
    ),
  };
}
