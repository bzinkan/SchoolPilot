import type db from "../db.js";
import { schedulerDb, schedulerPool } from "./schedulerDb.js";
import { runWithTenantContext } from "../middleware/tenantContext.js";
import {
  broadcastToStaffSessionLocal,
  sendToStaffUserLocal,
} from "../realtime/ws-broadcast.js";
import { removeDeviceStatus } from "../realtime/student-statuses.js";
import {
  publishOrderedWS,
  recordLocalOrderedDelivery,
  type WsRedisTarget,
} from "../realtime/ws-redis.js";
import {
  classpilotPublicRealtimeBinding,
  classpilotRealtimeOrderingKey,
  markClasspilotRealtimeSignedOut,
} from "./classpilotRealtimeStatus.js";
import { recordClasspilotStudentSessionMonitoringEvent } from "./classpilotMonitoringEvents.js";
import {
  deleteDeviceWithEndedSessions,
  getClasspilotStudentControlState,
  invalidateClasspilotPassiveAuthorization,
  withClasspilotSupervisionTelemetryAuthority,
  withClasspilotTeachingTelemetryAuthority,
} from "./storage.js";

export type EndedClasspilotStudentSession = {
  schoolId: string;
  studentId: string;
  studentSessionId: string;
  deviceId: string;
};

export async function removeClasspilotDeviceAndPublishSessionEnds(options: {
  schoolId: string;
  deviceId: string;
  publishEndedSession?: (row: EndedClasspilotStudentSession) => Promise<void>;
}): Promise<{
  deleted: boolean;
  endedSessions: EndedClasspilotStudentSession[];
  publicationFailures: number;
}> {
  const deleted = await deleteDeviceWithEndedSessions(options.schoolId, options.deviceId);
  const endedSessions = deleted.endedSessions.map((row) => ({
    schoolId: options.schoolId,
    studentId: row.studentId,
    studentSessionId: row.id,
    deviceId: row.deviceId,
  }));
  const publishEndedSession = options.publishEndedSession ?? ((row) =>
    publishClasspilotStudentSessionEnded({ ...row, reason: "device_removed" })
  );
  const settled = await Promise.allSettled(
    endedSessions.map((row) => publishEndedSession(row))
  );
  return {
    deleted: deleted.deleted,
    endedSessions,
    publicationFailures: settled.filter((result) => result.status === "rejected").length,
  };
}

export async function publishClasspilotStudentSessionEnded(
  options: EndedClasspilotStudentSession & {
    reason: string;
    dbInstance?: typeof db;
  }
): Promise<void> {
  const dbInstance = options.dbInstance;
  const inDatabaseScope = <T>(callback: () => Promise<T>): Promise<T> =>
    dbInstance
      ? callback()
      : runWithTenantContext({ schoolId: options.schoolId }, callback);
  const controlState = await inDatabaseScope(() =>
    getClasspilotStudentControlState(options.schoolId, options.studentId, dbInstance)
  ).catch(() => undefined);
  void inDatabaseScope(() =>
    recordClasspilotStudentSessionMonitoringEvent({
      ...options,
      type: "student_session_ended",
      dbInstance,
    })
  ).catch(() => { /* monitoring evidence must not block lifecycle cleanup */ });

  const mutation = await markClasspilotRealtimeSignedOut(options);
  if (mutation.status === "stale" || !mutation.snapshot) return;
  const snapshot = mutation.snapshot;
  removeDeviceStatus(options.schoolId, options.deviceId);
  const message = {
    type: "student-signed-out",
    schemaVersion: snapshot.schemaVersion,
    eventVersion: 2,
    schoolId: options.schoolId,
    studentId: options.studentId,
    status: "offline",
    reason: options.reason,
    timestamp: new Date().toISOString(),
    realtimeBinding: classpilotPublicRealtimeBinding(snapshot.studentSessionId),
    realtimeRevision: snapshot.revision,
    revision: snapshot.revision,
    realtimeObservedAt: new Date(snapshot.observedAt).toISOString(),
    observedAtMs: snapshot.observedAt,
    activityFresh: false,
    activityState: "signed_out",
    monitoringState: "not_logged_in",
  };

  const baseOrderingKey = classpilotRealtimeOrderingKey(
    options.schoolId,
    options.deviceId
  );
  const publishToAudience = async (
    target: WsRedisTarget,
    orderedKey: string,
    audienceMessage: Record<string, unknown>,
    deliverLocal: () => void
  ) => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 300);
    timeout.unref?.();
    let outcome: Awaited<ReturnType<typeof publishOrderedWS>>;
    try {
      outcome = await publishOrderedWS(target, audienceMessage, {
        orderedKey,
        revision: String(snapshot.revision),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }
    if (
      (outcome.status === "accepted" || outcome.status === "failed") &&
      recordLocalOrderedDelivery(orderedKey, String(snapshot.revision))
    ) {
      deliverLocal();
    }
  };

  if (controlState?.teachingSessionId) {
    await inDatabaseScope(() =>
      withClasspilotTeachingTelemetryAuthority({
        schoolId: options.schoolId,
        teachingSessionId: controlState.teachingSessionId!,
        studentId: options.studentId,
        studentSessionId: options.studentSessionId,
        deviceId: options.deviceId,
        controlRevision: controlState.revision,
        allowEndedBinding: true,
      }, async (target) => {
        const orderedKey = `${baseOrderingKey}:session:${target.teachingSessionId}`;
        const teachingMessage = {
          ...message,
          sessionId: target.teachingSessionId,
          teachingSessionId: target.teachingSessionId,
        };
        await publishToAudience({
          kind: "staff-session",
          schoolId: options.schoolId,
          sessionId: target.teachingSessionId,
        }, orderedKey, teachingMessage, () => {
          broadcastToStaffSessionLocal(options.schoolId, target.teachingSessionId, teachingMessage);
        });
      }, dbInstance)
    );
    return;
  }

  if (!controlState?.supervisionContextId) return;
  await inDatabaseScope(() =>
    withClasspilotSupervisionTelemetryAuthority({
      schoolId: options.schoolId,
      supervisionContextId: controlState.supervisionContextId!,
      studentId: options.studentId,
      studentSessionId: options.studentSessionId,
      deviceId: options.deviceId,
      controlRevision: controlState.revision,
      allowEndedBinding: true,
    }, async (target) => {
      const orderedKey = `${baseOrderingKey}:supervision:${target.supervisionContextId}`;
      const supervisionMessage = {
        ...message,
        supervisionContextId: target.supervisionContextId,
      };
      await publishToAudience({
        kind: "staff-user",
        schoolId: options.schoolId,
        userId: target.assignedStaffId,
      }, orderedKey, supervisionMessage, () => {
        sendToStaffUserLocal(options.schoolId, target.assignedStaffId, supervisionMessage);
      });
    }, dbInstance)
  );
}

export type ExpiredManualStudentSessionReapResult = {
  ended: number;
  publicationFailures: number;
  backlog: boolean;
};

export async function reapExpiredManualStudentSessions(options: {
  batchSize?: number;
  maxBatches?: number;
  publicationConcurrency?: number;
  /** Test seam for deterministic publication-failure coverage. Production
   * callers omit this and always publish through the scheduler DB path. */
  publishEndedSession?: (row: EndedClasspilotStudentSession) => Promise<void>;
  /** Test seam for proving that a later batch failure cannot suppress already
   * committed tombstones. Production callers omit this. */
  beforeBatch?: (batchIndex: number) => Promise<void> | void;
} = {}): Promise<ExpiredManualStudentSessionReapResult> {
  const batchSize = Math.min(500, Math.max(1, options.batchSize ?? 250));
  const maxBatches = Math.min(20, Math.max(1, options.maxBatches ?? 4));
  const publicationConcurrency = Math.min(
    16,
    Math.max(1, options.publicationConcurrency ?? 8)
  );
  const publishEndedSession = options.publishEndedSession ?? ((row) =>
    publishClasspilotStudentSessionEnded({
      ...row,
      reason: "manual_lease_expired",
      dbInstance: schedulerDb as unknown as typeof db,
    })
  );
  let ended = 0;
  let publicationFailures = 0;

  for (let batch = 0; batch < maxBatches; batch += 1) {
    await options.beforeBatch?.(batch);
    const result = await schedulerPool.query<{
      school_id: string;
      student_id: string;
      student_session_id: string;
      device_id: string;
    }>(`
      WITH due AS (
        SELECT
          session.id,
          session.student_id,
          session.device_id,
          student.school_id
        FROM student_sessions AS session
        INNER JOIN students AS student ON student.id = session.student_id
        WHERE session.auth_kind = 'manual_shared'
          AND session.is_active = true
          AND session.ended_at IS NULL
          AND session.manual_lease_expires_at <= now()
        ORDER BY session.manual_lease_expires_at, session.id
        LIMIT $1
        FOR UPDATE OF session SKIP LOCKED
      ), ended AS (
        UPDATE student_sessions AS session
        SET
          is_active = false,
          ended_at = now(),
          session_recovery_token_hash = NULL
        FROM due
        WHERE session.id = due.id
          AND session.is_active = true
          AND session.ended_at IS NULL
          AND session.manual_lease_expires_at <= now()
        RETURNING session.id, session.student_id, session.device_id
      )
      SELECT
        due.school_id,
        ended.student_id,
        ended.id AS student_session_id,
        ended.device_id
      FROM ended
      INNER JOIN due ON due.id = ended.id
    `, [batchSize]);
    const endedRows = result.rows.map((row) => ({
      schoolId: row.school_id,
      studentId: row.student_id,
      studentSessionId: row.student_session_id,
      deviceId: row.device_id,
    }));
    ended += endedRows.length;

    // Process each committed batch before asking PostgreSQL for another one.
    // If a later batch query fails, these exact rows have already had their
    // cache invalidation and tombstone publication attempted.
    const distinctSchools = [...new Set(endedRows.map((row) => row.schoolId))];
    await Promise.allSettled(
      distinctSchools.map((schoolId) => invalidateClasspilotPassiveAuthorization(schoolId))
    );
    for (let offset = 0; offset < endedRows.length; offset += publicationConcurrency) {
      const settled = await Promise.allSettled(
        endedRows.slice(offset, offset + publicationConcurrency).map((row) =>
          publishEndedSession(row)
        )
      );
      publicationFailures += settled.filter((outcome) => outcome.status === "rejected").length;
    }
    if (result.rows.length < batchSize) break;
  }

  const backlogResult = await schedulerPool.query<{ backlog: boolean }>(`
    SELECT EXISTS (
      SELECT 1
      FROM student_sessions
      WHERE auth_kind = 'manual_shared'
        AND is_active = true
        AND ended_at IS NULL
        AND manual_lease_expires_at <= now()
    ) AS backlog
  `);
  return {
    ended,
    publicationFailures,
    backlog: backlogResult.rows[0]?.backlog === true,
  };
}
