import type db from "../db.js";
import {
  getSettingsForSchool,
  insertClasspilotMonitoringEventForResolvedScope,
} from "./storage.js";
import { classpilotRetentionExpiresAt } from "../util/classpilotRetention.js";

/**
 * Retain only server-derived student-session boundaries that can be assigned
 * unambiguously to the active class or delegated supervision context. All
 * identity and scope fields come from authenticated server state.
 */
export async function recordClasspilotStudentSessionMonitoringEvent(options: {
  schoolId: string;
  studentId: string;
  deviceId: string;
  studentSessionId: string;
  type: "student_session_started" | "student_session_ended";
  occurredAt?: Date;
  reason?: string;
  dbInstance?: typeof db;
}): Promise<"stored" | "duplicate" | "not_retained"> {
  const occurredAt = options.occurredAt || new Date();
  const dbInstance = options.dbInstance;
  const settings = await getSettingsForSchool(options.schoolId, dbInstance);
  const receivedAt = new Date();
  const retentionExpiresAt = classpilotRetentionExpiresAt(occurredAt, settings?.retentionHours);
  if (retentionExpiresAt <= receivedAt) return "not_retained";
  return insertClasspilotMonitoringEventForResolvedScope({
    schoolId: options.schoolId,
    studentId: options.studentId,
    deviceId: options.deviceId,
    studentSessionId: options.studentSessionId,
    sourceEventId: `server:${options.type}:${options.studentSessionId}`,
    schemaVersion: 1,
    origin: "server",
    eventType: options.type,
    occurredAt,
    receivedAt,
    normalizedDomain: null,
    sanitizedPath: null,
    title: null,
    metadata: options.reason ? { reason: options.reason.slice(0, 80) } : {},
    retentionExpiresAt,
  }, dbInstance);
}
