import { and, eq, gt, isNull, isNotNull, or, sql, type SQLWrapper } from "drizzle-orm";
import type db from "../db.js";
import { schools, productLicenses, studentSessions, students, devices, classpilotStudentControlStates, teachingSessions, classpilotSessionStudents } from "../schema/index.js";
import { currentStudentSessionAuthorityPredicate } from "./classpilotStudentSessionAuthority.js";

type SelectDatabase = Pick<typeof db, "select">;
type Scalar = string | SQLWrapper;
export type HeartbeatReadBinding = { schoolId: Scalar; studentId: Scalar; studentSessionId: Scalar; deviceId: Scalar };
export const LIVE_TEACHING_SESSION_MODE = "live";

// Canonical builders shared by fresh reference reads and unnamed prepared metadata.
// No authority result, request value or transaction is retained here.
export function heartbeatSchoolQuery(dbInstance: SelectDatabase, options: { schoolId: Scalar }) {
  return dbInstance
    .select({
      id: schools.id,
      status: schools.status,
      isActive: schools.isActive,
      planStatus: schools.planStatus,
      activeUntil: schools.activeUntil,
      disabledAt: schools.disabledAt,
      deletedAt: schools.deletedAt,
    })
    .from(schools)
    .where(eq(schools.id, options.schoolId))
    .limit(1).for("share");
}

export function heartbeatLicenseQuery(dbInstance: SelectDatabase, options: { schoolId: Scalar }) {
  return dbInstance
    .select({ id: productLicenses.id })
    .from(productLicenses)
    .where(and(
      eq(productLicenses.schoolId, options.schoolId),
      eq(productLicenses.product, "CLASSPILOT"),
      eq(productLicenses.status, "active"),
      or(
        isNull(productLicenses.expiresAt),
        gt(productLicenses.expiresAt, sql`clock_timestamp()`)
      )
    ))
    .limit(1).for("share");
}

export function heartbeatSessionQuery(dbInstance: SelectDatabase, options: HeartbeatReadBinding) {
  return dbInstance
    .select({
      id: studentSessions.id,
      startedAt: studentSessions.startedAt,
      authKind: studentSessions.authKind,
      manualLeaseExpiresAt: studentSessions.manualLeaseExpiresAt,
    })
    .from(studentSessions)
    .innerJoin(students, and(
      eq(students.id, studentSessions.studentId),
      eq(students.schoolId, options.schoolId),
      eq(students.status, "active")
    ))
    .innerJoin(devices, and(
      eq(devices.deviceId, studentSessions.deviceId),
      eq(devices.schoolId, options.schoolId)
    ))
    .where(and(
      eq(studentSessions.id, options.studentSessionId),
      eq(studentSessions.studentId, options.studentId),
      eq(studentSessions.deviceId, options.deviceId),
      currentStudentSessionAuthorityPredicate()
    ))
    .limit(1)
    .for("share");
}

export function heartbeatControlQuery(dbInstance: SelectDatabase, options: Pick<HeartbeatReadBinding, "schoolId" | "studentId">) {
  return dbInstance
    .select({
      teachingSessionId: classpilotStudentControlStates.teachingSessionId,
      supervisionContextId: classpilotStudentControlStates.supervisionContextId,
      revision: classpilotStudentControlStates.revision,
      scheduledEndAt: classpilotStudentControlStates.scheduledEndAt,
      hardExpiresAt: classpilotStudentControlStates.hardExpiresAt,
      updatedAt: classpilotStudentControlStates.updatedAt,
    })
    .from(classpilotStudentControlStates)
    .where(and(
      eq(classpilotStudentControlStates.schoolId, options.schoolId),
      eq(classpilotStudentControlStates.studentId, options.studentId)
    ))
    .limit(1)
    .for("share");
}

export function heartbeatCandidateQuery(dbInstance: SelectDatabase, options: Pick<HeartbeatReadBinding, "schoolId" | "studentId"> & { teachingSessionId: Scalar }) {
  return dbInstance
    .select({
      teachingSessionId: teachingSessions.id,
      startTime: teachingSessions.startTime,
      rosterSnapshotCompletedAt: teachingSessions.rosterSnapshotCompletedAt,
      teachingScheduledEndAt: teachingSessions.scheduledEndAt,
      controlRevision: classpilotStudentControlStates.revision,
      controlUpdatedAt: classpilotStudentControlStates.updatedAt,
      controlScheduledEndAt: classpilotStudentControlStates.scheduledEndAt,
      controlHardExpiresAt: classpilotStudentControlStates.hardExpiresAt,
    })
    .from(classpilotStudentControlStates)
    .innerJoin(teachingSessions, and(
      eq(teachingSessions.id, classpilotStudentControlStates.teachingSessionId),
      eq(teachingSessions.schoolId, options.schoolId),
      eq(teachingSessions.sessionMode, LIVE_TEACHING_SESSION_MODE),
      isNull(teachingSessions.endTime),
      isNotNull(teachingSessions.rosterSnapshotCompletedAt)
    ))
    .innerJoin(classpilotSessionStudents, and(
      eq(classpilotSessionStudents.schoolId, options.schoolId),
      eq(classpilotSessionStudents.teachingSessionId, teachingSessions.id),
      eq(classpilotSessionStudents.studentId, options.studentId)
    ))
    .where(and(
      eq(classpilotStudentControlStates.schoolId, options.schoolId),
      eq(classpilotStudentControlStates.studentId, options.studentId),
      eq(classpilotStudentControlStates.teachingSessionId, options.teachingSessionId),
      isNull(classpilotStudentControlStates.supervisionContextId),
      isNotNull(classpilotStudentControlStates.hardExpiresAt),
      sql`${classpilotStudentControlStates.hardExpiresAt} > now()`,
      or(
        isNull(classpilotStudentControlStates.scheduledEndAt),
        sql`${classpilotStudentControlStates.scheduledEndAt} > now()`
      ),
      or(
        isNull(teachingSessions.scheduledEndAt),
        sql`${teachingSessions.scheduledEndAt} > now()`
      )
    ))
    .limit(1)
    .for("share");
}
