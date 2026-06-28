import type db from "../db.js";
import {
  getActiveClassOwnersForStudents,
  getGroupStudents,
  getUserById,
} from "./storage.js";

function displayName(user: any): string {
  return user?.displayName || [user?.firstName, user?.lastName].filter(Boolean).join(" ").trim() || user?.email || "Unknown teacher";
}

function studentName(student: any): string {
  return [student?.firstName, student?.lastName].filter(Boolean).join(" ").trim() || student?.email || student?.id || "Unknown student";
}

export type ClassStartOverlapGroup = {
  sessionId: string;
  classId: string;
  className: string;
  teacherId: string;
  teacherName: string;
  affectedCount: number;
  affectedStudents: Array<{ studentId: string; studentName: string }>;
};

export type ClassStartOverlapPayload = {
  code: "CLASS_ROSTER_ACTIVE_OVERLAP";
  severity: "warning";
  requiresAcknowledgement: true;
  canStartAnyway: true;
  selectedClass: {
    id: string;
    name: string;
  };
  totalOverlapCount: number;
  groups: ClassStartOverlapGroup[];
};

export async function buildClassStartOverlapPayload(options: {
  schoolId: string;
  teacherId: string;
  group: { id: string; name: string };
  dbInstance?: typeof db;
}): Promise<ClassStartOverlapPayload | null> {
  const rosterRows = await getGroupStudents(options.group.id, options.dbInstance);
  const studentIds = rosterRows.map((row) => row.studentId);
  if (studentIds.length === 0) return null;

  const owners = await getActiveClassOwnersForStudents(options.schoolId, studentIds, options.dbInstance);
  const conflicts = owners.filter((owner) => owner.session.teacherId !== options.teacherId);
  if (conflicts.length === 0) return null;

  const studentsById = new Map(rosterRows.map((row) => [row.studentId, row.student]));
  const bySession = new Map<string, ClassStartOverlapGroup>();
  const teacherIds = [...new Set(conflicts.map((owner) => owner.session.teacherId))];
  const teacherEntries = await Promise.all(teacherIds.map(async (id) => [id, await getUserById(id)] as const));
  const teachersById = new Map(teacherEntries);

  for (const owner of conflicts) {
    const row = bySession.get(owner.session.id) || {
      sessionId: owner.session.id,
      classId: owner.groupId,
      className: owner.groupName,
      teacherId: owner.session.teacherId,
      teacherName: displayName(teachersById.get(owner.session.teacherId)),
      affectedCount: 0,
      affectedStudents: [],
    };
    row.affectedCount += 1;
    if (row.affectedStudents.length < 5) {
      row.affectedStudents.push({
        studentId: owner.studentId,
        studentName: studentName(studentsById.get(owner.studentId)),
      });
    }
    bySession.set(owner.session.id, row);
  }

  const groups = Array.from(bySession.values()).sort((a, b) => b.affectedCount - a.affectedCount || a.className.localeCompare(b.className));
  const totalOverlapCount = groups.reduce((sum, group) => sum + group.affectedCount, 0);
  return {
    code: "CLASS_ROSTER_ACTIVE_OVERLAP",
    severity: "warning",
    requiresAcknowledgement: true,
    canStartAnyway: true,
    selectedClass: {
      id: options.group.id,
      name: options.group.name,
    },
    totalOverlapCount,
    groups,
  };
}
