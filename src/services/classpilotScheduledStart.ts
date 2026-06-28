import type db from "../db.js";
import { broadcastToTeachersLocal, isStaffUserConnectedLocal } from "../realtime/ws-broadcast.js";
import type { ClasspilotScheduledConflict, Group, TeachingSession } from "../schema/classpilot.js";
import type { Student } from "../schema/students.js";
import { localDateInTimeZone } from "../util/schoolTime.js";
import {
  clearClasspilotActiveHandsForSession,
  createTeachingSession,
  endTeachingSession,
  getActiveClassOwnersForStudents,
  getActiveSessionByStudent,
  getActiveSupervisionForStudents,
  getActiveTeachingSessionForSchool,
  getGroupByIdAndSchool,
  getGroupStudents,
  getScheduledClassConflictForSlot,
  getSchoolById,
  getUserById,
  listActiveScheduledClassConflictsForTeacher,
  listActiveSupervisionContextsForScheduledConflict,
  releaseScheduledConflictSupervision,
  resolveScheduledClassConflict,
  upsertScheduledClassConflict,
} from "./storage.js";

export type ScheduledClassAutoStartResult =
  | { status: "started"; session: TeachingSession }
  | { status: "coverage_needed"; conflictId: string }
  | { status: "claimed"; conflictId: string }
  | { status: "skipped"; reason: string };

export type ScheduledCoverageStudentPayload = {
  studentId: string;
  studentName: string;
  studentEmail?: string;
  gradeLevel?: string;
};

export type ScheduledCoveragePayload = {
  code: "SCHEDULED_COVERAGE_NEEDED";
  selectedClass: {
    id: string;
    name: string;
  };
  scheduledTeacher: {
    id: string;
    displayName: string;
  };
  scheduledDate: string;
  blockStartTime: string | null;
  blockEndTime: string | null;
  totalRosterCount: number;
  claimableCount: number;
  monitoredCount: number;
  claimedCount: number;
  offlineOrUnmonitoredCount: number;
  claimableStudents: ScheduledCoverageStudentPayload[];
  monitoredGroups: {
    teacherId: string;
    teacherName: string;
    classId: string;
    className: string;
    sessionId: string;
    affectedCount: number;
    affectedStudents: ScheduledCoverageStudentPayload[];
  }[];
};

function displayName(user: any): string {
  return user?.displayName || [user?.firstName, user?.lastName].filter(Boolean).join(" ").trim() || user?.email || "Unknown teacher";
}

function studentName(student: Student): string {
  return [student.firstName, student.lastName].filter(Boolean).join(" ").trim() || student.email || student.id;
}

function safeStudent(student: Student): ScheduledCoverageStudentPayload {
  return {
    studentId: student.id,
    studentName: studentName(student),
    studentEmail: student.email || undefined,
    gradeLevel: student.gradeLevel || undefined,
  };
}

function conflictBroadcast(conflictId: string) {
  return {
    type: "scheduled-class-conflict-updated",
    conflictId,
  };
}

function currentLocalTimeHHMM(timeZone: string): string {
  return new Date().toLocaleString("en-US", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).replace(/^24:/, "00:");
}

function isWithinScheduleWindow(group: Group, currentTimeHHMM: string): boolean {
  if (!group.blockStartTime || !group.blockEndTime) return false;
  return group.blockStartTime <= currentTimeHHMM && group.blockEndTime > currentTimeHHMM;
}

function teacherConnected(
  schoolId: string,
  teacherId: string,
  options: { connectedTeacherIdsOverride?: Set<string>; scheduledTeacherConnectedOverride?: boolean } = {}
): boolean {
  if (options.scheduledTeacherConnectedOverride !== undefined) {
    return options.scheduledTeacherConnectedOverride;
  }
  if (options.connectedTeacherIdsOverride) {
    return options.connectedTeacherIdsOverride.has(teacherId);
  }
  return isStaffUserConnectedLocal(schoolId, teacherId);
}

export async function buildScheduledCoveragePayload(options: {
  group: Group;
  scheduledDate: string;
  scheduledConflictId?: string | null;
  dbInstance?: typeof db;
  connectedTeacherIdsOverride?: Set<string>;
}): Promise<ScheduledCoveragePayload> {
  const group = options.group;
  const schoolId = group.schoolId;
  const rows = await getGroupStudents(group.id, options.dbInstance);
  const studentIds = rows.map((row) => row.studentId);
  const [teacher, owners, activeSupervision] = await Promise.all([
    getUserById(group.teacherId),
    getActiveClassOwnersForStudents(schoolId, studentIds, options.dbInstance),
    getActiveSupervisionForStudents(schoolId, studentIds),
  ]);
  const ownerByStudent = new Map(owners.map((owner) => [owner.studentId, owner]));
  const supervisionByStudent = new Map(activeSupervision.map((entry) => [entry.studentId, entry.context]));
  const scheduledContexts = options.scheduledConflictId
    ? await listActiveSupervisionContextsForScheduledConflict(schoolId, options.scheduledConflictId, options.dbInstance)
    : [];
  const scheduledContextIds = new Set(scheduledContexts.map((context) => context.id));
  const monitoredByKey = new Map<string, {
    teacherId: string;
    teacherName: string;
    classId: string;
    className: string;
    sessionId: string;
    count: number;
    students: ScheduledCoverageStudentPayload[];
  }>();

  const claimableStudents: ScheduledCoverageStudentPayload[] = [];
  let claimedCount = 0;
  let monitoredCount = 0;
  let offlineOrUnmonitoredCount = 0;

  for (const row of rows) {
    const activeSession = await getActiveSessionByStudent(row.studentId);
    const lastSeenAt = activeSession?.lastSeenAt?.getTime?.() || 0;
    const isOnline = !!activeSession && lastSeenAt > 0 && Date.now() - lastSeenAt <= 5 * 60 * 1000;
    const activeCoverage = supervisionByStudent.get(row.studentId);
    if (activeCoverage) {
      if (scheduledContextIds.has(activeCoverage.id)) {
        claimedCount++;
      } else {
        monitoredCount++;
      }
      continue;
    }

    const owner = ownerByStudent.get(row.studentId);
    if (owner && teacherConnected(schoolId, owner.session.teacherId, {
      connectedTeacherIdsOverride: options.connectedTeacherIdsOverride,
    })) {
      monitoredCount++;
      const key = `${owner.session.teacherId}:${owner.groupId}:${owner.session.id}`;
      let entry = monitoredByKey.get(key);
      if (!entry) {
        const ownerTeacher = await getUserById(owner.session.teacherId);
        entry = {
          teacherId: owner.session.teacherId,
          teacherName: displayName(ownerTeacher),
          classId: owner.groupId,
          className: owner.groupName,
          sessionId: owner.session.id,
          count: 0,
          students: [],
        };
        monitoredByKey.set(key, entry);
      }
      entry.count++;
      if (entry.students.length < 5) entry.students.push(safeStudent(row.student));
      continue;
    }

    if (isOnline) {
      claimableStudents.push(safeStudent(row.student));
    } else {
      offlineOrUnmonitoredCount++;
    }
  }

  return {
    code: "SCHEDULED_COVERAGE_NEEDED",
    selectedClass: {
      id: group.id,
      name: group.name,
    },
    scheduledTeacher: {
      id: group.teacherId,
      displayName: displayName(teacher),
    },
    scheduledDate: options.scheduledDate,
    blockStartTime: group.blockStartTime || null,
    blockEndTime: group.blockEndTime || null,
    totalRosterCount: rows.length,
    claimableCount: claimableStudents.length,
    monitoredCount,
    claimedCount,
    offlineOrUnmonitoredCount,
    claimableStudents,
    monitoredGroups: Array.from(monitoredByKey.values()).map((entry) => ({
      teacherId: entry.teacherId,
      teacherName: entry.teacherName,
      classId: entry.classId,
      className: entry.className,
      sessionId: entry.sessionId,
      affectedCount: entry.count,
      affectedStudents: entry.students,
    })),
  };
}

async function startScheduledClass(options: {
  group: Group;
  scheduledConflict?: ClasspilotScheduledConflict | null;
  actorId?: string | null;
  dbInstance?: typeof db;
}): Promise<TeachingSession> {
  const dbInstance = options.dbInstance;
  if (options.scheduledConflict) {
    await releaseScheduledConflictSupervision({
      schoolId: options.group.schoolId,
      scheduledConflictId: options.scheduledConflict.id,
      releaseReason: "scheduled_teacher_started",
    }, dbInstance);
  }

  const existingSession = await getActiveTeachingSessionForSchool(options.group.teacherId, options.group.schoolId, dbInstance);
  if (existingSession) {
    await endTeachingSession(existingSession.id, dbInstance);
    await clearClasspilotActiveHandsForSession(options.group.schoolId, existingSession.id, dbInstance);
  }

  const session = await createTeachingSession({ groupId: options.group.id, teacherId: options.group.teacherId }, dbInstance);
  if (options.scheduledConflict) {
    await resolveScheduledClassConflict(
      options.scheduledConflict.id,
      options.group.schoolId,
      "started",
      options.actorId || null,
      dbInstance
    );
    broadcastToTeachersLocal(options.group.schoolId, conflictBroadcast(options.scheduledConflict.id));
  }
  return session;
}

export async function startScheduledClassFromConflict(options: {
  conflict: ClasspilotScheduledConflict;
  actorId?: string | null;
  dbInstance?: typeof db;
}): Promise<TeachingSession> {
  const group = await getGroupByIdAndSchool(options.conflict.groupId, options.conflict.schoolId);
  if (!group) throw Object.assign(new Error("Class not found"), { status: 404 });
  return startScheduledClass({
    group,
    scheduledConflict: options.conflict,
    actorId: options.actorId || null,
    dbInstance: options.dbInstance,
  });
}

export async function processScheduledClassAutoStart(options: {
  group: Group;
  scheduledDate: string;
  dbInstance?: typeof db;
  scheduledTeacherConnectedOverride?: boolean;
  connectedTeacherIdsOverride?: Set<string>;
}): Promise<ScheduledClassAutoStartResult> {
  const dbInstance = options.dbInstance;
  const group = options.group;
  const blockStartTime = group.blockStartTime || "";
  if (!blockStartTime) return { status: "skipped", reason: "missing_start_time" };

  const existingConflict = await getScheduledClassConflictForSlot({
    schoolId: group.schoolId,
    groupId: group.id,
    scheduledDate: options.scheduledDate,
    blockStartTime,
  }, dbInstance);

  if (existingConflict?.status === "skipped" || existingConflict?.status === "started") {
    return { status: "skipped", reason: existingConflict.status };
  }

  const scheduledTeacherConnected = teacherConnected(group.schoolId, group.teacherId, {
    scheduledTeacherConnectedOverride: options.scheduledTeacherConnectedOverride,
    connectedTeacherIdsOverride: options.connectedTeacherIdsOverride,
  });

  if (scheduledTeacherConnected) {
    const session = await startScheduledClass({ group, scheduledConflict: existingConflict, dbInstance });
    return { status: "started", session };
  }

  const payload = await buildScheduledCoveragePayload({
    group,
    scheduledDate: options.scheduledDate,
    scheduledConflictId: existingConflict?.id || null,
    dbInstance,
    connectedTeacherIdsOverride: options.connectedTeacherIdsOverride,
  });
  const status = payload.claimedCount > 0 ? "claimed" : "coverage_needed";
  const conflict = await upsertScheduledClassConflict({
    schoolId: group.schoolId,
    groupId: group.id,
    teacherId: group.teacherId,
    scheduledDate: options.scheduledDate,
    blockStartTime,
    blockEndTime: group.blockEndTime || null,
    status,
    conflictPayload: payload,
    scheduledTeacherConnected: false,
  }, dbInstance);
  broadcastToTeachersLocal(group.schoolId, conflictBroadcast(conflict.id));
  return { status: status === "claimed" ? "claimed" : "coverage_needed", conflictId: conflict.id };
}

export async function startActiveScheduledClassesForTeacher(options: {
  schoolId: string;
  teacherId: string;
  now?: Date;
}): Promise<TeachingSession[]> {
  const now = options.now || new Date();
  const school = await getSchoolById(options.schoolId);
  const timeZone = school?.schoolTimezone || "America/New_York";
  const scheduledDate = localDateInTimeZone(now, timeZone);
  const currentTimeHHMM = currentLocalTimeHHMM(timeZone);
  const conflicts = await listActiveScheduledClassConflictsForTeacher(
    options.schoolId,
    options.teacherId,
    scheduledDate
  );
  const started: TeachingSession[] = [];
  for (const conflict of conflicts) {
    const group = await getGroupByIdAndSchool(conflict.groupId, options.schoolId);
    if (!group || !isWithinScheduleWindow(group, currentTimeHHMM)) continue;
    const session = await startScheduledClass({
      group,
      scheduledConflict: conflict,
      actorId: options.teacherId,
    });
    started.push(session);
  }
  return started;
}
