import { sql } from "drizzle-orm";
import type db from "../db.js";
import {
  studentSessions, classpilotStudentControlStates, teachingSessions,
  STUDENT_SESSION_AUTH_KINDS, type StudentSessionAuthKind,
} from "../schema/index.js";
import type { HeartbeatReadBinding } from "./classpilotHeartbeatReadQueries.js";

type Session = {
  id: string; startedAt: Date; authKind: StudentSessionAuthKind; manualLeaseExpiresAt: Date | null;
};
type Control = {
  teachingSessionId: string | null; supervisionContextId: string | null; revision: number;
  scheduledEndAt: Date | null; hardExpiresAt: Date | null; updatedAt: Date;
};
type Candidate = {
  teachingSessionId: string; startTime: Date; rosterSnapshotCompletedAt: Date;
  teachingScheduledEndAt: Date | null; controlRevision: number; controlUpdatedAt: Date;
  controlScheduledEndAt: Date | null; controlHardExpiresAt: Date;
};
export type HeartbeatScreenshotOwnerRow = {
  hasActiveSupervision: boolean; id: string | null;
  controlUpdatedAt: string | null; startTime: string | null; createdAt: string | null;
};
export type HeartbeatScreenshotEvidence =
  | { stage: "session_missing" }
  | { stage: "control"; session: Session; control: Control | null }
  | { stage: "candidate_missing"; session: Session; control: Control }
  | { stage: "owner"; session: Session; control: Control; candidate: Candidate; owners: HeartbeatScreenshotOwnerRow[] };

/** One unnamed prepared definition per owned client; only fresh tuple values
 * are bound at execution. The installed function keeps four internal statements. */
export function heartbeatScreenshotEvidenceQuery(database: Pick<typeof db, "select">, binding: HeartbeatReadBinding) {
  return database.select({ evidence: sql<unknown>`evidence.value` }).from(sql`
    public.classpilot_heartbeat_screenshot_evidence_v1(
      ${binding.schoolId}::text, ${binding.studentId}::text,
      ${binding.studentSessionId}::text, ${binding.deviceId}::text
    ) AS evidence(value)
  `);
}

function invalid(): never { throw new TypeError("Invalid heartbeat screenshot evidence"); }
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!isRecord(value)) return invalid();
  const actual = Object.keys(value);
  if (actual.length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) return invalid();
  return value;
}
function text(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) return invalid();
  return value;
}
function nullableText(value: unknown): string | null { return value === null ? null : text(value); }
function revision(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 2147483647) return invalid();
  return value;
}
type TimestampColumn = { mapFromDriverValue(value: string): unknown };
const PG_TIMESTAMP = /^(\d{4,6})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.\d{1,6})?(?:Z|[+-]\d{2}(?::\d{2})?)?$/;
const MONTH_DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
function date(value: unknown, column: TimestampColumn): Date {
  const timestamp = text(value);
  // Date's permissive parser accepts some arbitrary strings once Drizzle adds
  // a UTC suffix. Require the PostgreSQL timestamp wire syntax first.
  const parts = PG_TIMESTAMP.exec(timestamp);
  if (!parts) return invalid();
  const year = Number(parts[1]), month = Number(parts[2]), day = Number(parts[3]);
  const days = month === 2 && year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : MONTH_DAYS[month - 1] ?? 0;
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > days
    || Number(parts[4]) > 23 || Number(parts[5]) > 59 || Number(parts[6]) > 59) return invalid();
  const decoded = column.mapFromDriverValue(timestamp);
  if (!(decoded instanceof Date) || !Number.isFinite(decoded.getTime())) return invalid();
  return decoded;
}
function nullableDate(value: unknown, column: TimestampColumn): Date | null {
  return value === null ? null : date(value, column);
}
function session(value: unknown): Session {
  const row = record(value, ["id", "startedAt", "authKind", "manualLeaseExpiresAt"]);
  const authKind = STUDENT_SESSION_AUTH_KINDS.find(kind => kind === row.authKind);
  if (authKind === undefined) return invalid();
  const result = {
    id: text(row.id), startedAt: date(row.startedAt, studentSessions.startedAt), authKind,
    manualLeaseExpiresAt: nullableDate(row.manualLeaseExpiresAt, studentSessions.manualLeaseExpiresAt),
  };
  if (authKind === "manual_shared" && result.manualLeaseExpiresAt === null) return invalid();
  return result;
}
function control(value: unknown): Control {
  const row = record(value, ["teachingSessionId", "supervisionContextId", "revision", "scheduledEndAt", "hardExpiresAt", "updatedAt"]);
  return {
    teachingSessionId: nullableText(row.teachingSessionId), supervisionContextId: nullableText(row.supervisionContextId),
    revision: revision(row.revision), scheduledEndAt: nullableDate(row.scheduledEndAt, classpilotStudentControlStates.scheduledEndAt),
    hardExpiresAt: nullableDate(row.hardExpiresAt, classpilotStudentControlStates.hardExpiresAt),
    updatedAt: date(row.updatedAt, classpilotStudentControlStates.updatedAt),
  };
}
function candidate(value: unknown): Candidate {
  const row = record(value, ["teachingSessionId", "startTime", "rosterSnapshotCompletedAt", "teachingScheduledEndAt", "controlRevision", "controlUpdatedAt", "controlScheduledEndAt", "controlHardExpiresAt"]);
  return {
    teachingSessionId: text(row.teachingSessionId), startTime: date(row.startTime, teachingSessions.startTime),
    rosterSnapshotCompletedAt: date(row.rosterSnapshotCompletedAt, teachingSessions.rosterSnapshotCompletedAt),
    teachingScheduledEndAt: nullableDate(row.teachingScheduledEndAt, teachingSessions.scheduledEndAt),
    controlRevision: revision(row.controlRevision), controlUpdatedAt: date(row.controlUpdatedAt, classpilotStudentControlStates.updatedAt),
    controlScheduledEndAt: nullableDate(row.controlScheduledEndAt, classpilotStudentControlStates.scheduledEndAt),
    controlHardExpiresAt: date(row.controlHardExpiresAt, classpilotStudentControlStates.hardExpiresAt),
  };
}
function owner(value: unknown): HeartbeatScreenshotOwnerRow {
  const row = record(value, ["hasActiveSupervision", "id", "controlUpdatedAt", "startTime", "createdAt"]);
  if (typeof row.hasActiveSupervision !== "boolean") return invalid();
  const result = { hasActiveSupervision: row.hasActiveSupervision, id: nullableText(row.id),
    controlUpdatedAt: nullableText(row.controlUpdatedAt), startTime: nullableText(row.startTime), createdAt: nullableText(row.createdAt) };
  if (result.id === null) {
    if (result.controlUpdatedAt !== null || result.startTime !== null || result.createdAt !== null) return invalid();
  } else {
    // Preserve raw strings for the canonical owner ranker, but validate them
    // with its exact schema decoders before the guarded read can succeed.
    nullableDate(result.controlUpdatedAt, teachingSessions.controlUpdatedAt);
    date(result.startTime, teachingSessions.startTime);
    date(result.createdAt, teachingSessions.createdAt);
  }
  return result;
}
function eligible(value: Control | null): value is Control {
  return value !== null && value.teachingSessionId !== null
    && value.supervisionContextId === null && value.hardExpiresAt !== null;
}

/** Closed wire contract: an absent field never acquires nullable semantics.
 * Called inside the tracked owned read, so decode failures remain mandatory. */
export function decodeHeartbeatScreenshotEvidence(value: unknown): HeartbeatScreenshotEvidence {
  if (value === null || typeof value !== "object" || !("stage" in value)) return invalid();
  const stage = value.stage;
  if (stage === "session_missing") {
    record(value, ["stage"]);
    return { stage };
  }
  if (stage !== "control" && stage !== "candidate_missing" && stage !== "owner") return invalid();
  const row = record(value, stage === "owner" ? ["stage", "session", "control", "candidate", "owners"] : ["stage", "session", "control"]);
  const sessionRow = session(row.session), controlRow = row.control === null ? null : control(row.control);
  if (stage === "control") {
    if (eligible(controlRow)) return invalid();
    return { stage, session: sessionRow, control: controlRow };
  }
  if (!eligible(controlRow)) return invalid();
  if (stage === "candidate_missing") return { stage, session: sessionRow, control: controlRow };
  const candidateRow = candidate(row.candidate);
  if (candidateRow.teachingSessionId !== controlRow.teachingSessionId
    || candidateRow.controlRevision !== controlRow.revision
    || candidateRow.controlUpdatedAt.getTime() !== controlRow.updatedAt.getTime()
    || candidateRow.controlScheduledEndAt?.getTime() !== controlRow.scheduledEndAt?.getTime()
    || candidateRow.controlHardExpiresAt.getTime() !== controlRow.hardExpiresAt?.getTime()) return invalid();
  if (!Array.isArray(row.owners) || row.owners.length === 0) return invalid();
  const owners = row.owners.map(owner);
  if (owners.some(item => item.hasActiveSupervision !== owners[0]?.hasActiveSupervision)
    || (owners.length > 1 && owners.some(item => item.id === null))) return invalid();
  return { stage, session: sessionRow, control: controlRow, candidate: candidateRow, owners };
}
