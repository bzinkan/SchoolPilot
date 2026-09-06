import { randomUUID } from "node:crypto";
import { eq, inArray, sql } from "drizzle-orm";
import db from "../db.js";
import { schedulerDb } from "./schedulerDb.js";
import { schools } from "../schema/core.js";
import { settings } from "../schema/shared.js";
import { classpilotSchoolSchedules } from "../schema/classpilotScheduling.js";
import { classpilotMonitoringExpectations as expectations, classpilotMonitoringInterruptionSettings as preferences } from "../schema/classpilotMonitoringInterruptions.js";
import { assertClasspilotEntitled, resolveClasspilotEntitlement } from "./classpilotEntitlement.js";
import { resolveClasspilotMonitoringPolicy } from "./classpilotMonitoringPolicy.js";
import { readClasspilotRealtimeStatusBatch } from "./classpilotRealtimeStatus.js";
import { decideMonitoringInterruption } from "./classpilotMonitoringInterruptionRules.js";
export { decideMonitoringInterruption, MONITORING_INTERRUPTION_TOLERANCE_MS } from "./classpilotMonitoringInterruptionRules.js";
import { localDateInTimeZone } from "../util/schoolTime.js";
import { classpilotRetentionExpiresAt } from "../util/classpilotRetention.js";

type Expectation = Omit<typeof expectations.$inferSelect, "teachingSessionId" | "supervisionContextId">;
type Scope = { student_id: string; student_session_id: string; device_id: string; scope_type: string; scope_id: string; scope_name: string; scope_started_at: Date; scope_ends_at: Date | null };

let scanRunning = false;
/** No writes or history scans on the heartbeat path. All work uses the isolated worker pool. */
export async function runClasspilotMonitoringInterruptionScan(now = new Date(), options: { schoolIds?: readonly string[] } = {}) {
  if (scanRunning) return { scannedSchools: 0, uncertainSchools: 0 };
  scanRunning = true;
  let scannedSchools = 0, uncertainSchools = 0;
  try {
    const candidates = await schedulerDb.select({ schoolId: schools.id, config: settings, schedulingConfig: classpilotSchoolSchedules.config }).from(schools).innerJoin(settings, eq(settings.schoolId, schools.id))
      .leftJoin(classpilotSchoolSchedules, eq(classpilotSchoolSchedules.schoolId, schools.id))
      .where(options.schoolIds ? inArray(schools.id, [...options.schoolIds]) : undefined);
    for (const { schoolId, config, schedulingConfig } of candidates) {
      try {
        const entitled = (await resolveClasspilotEntitlement(schoolId, schedulerDb as unknown as typeof db)).entitled;
        const full = entitled && resolveClasspilotMonitoringPolicy({ ...config, schedulingDateOverrides: schedulingConfig?.dateOverrides ?? {} }, { now }).policyMode === "full";
        await schedulerDb.transaction(async (tx) => {
          const lock = await tx.execute(sql`SELECT pg_try_advisory_xact_lock(hashtext(${`classpilot-monitoring-interruptions:${schoolId}`})) AS locked`);
          if (!(lock.rows[0] as { locked?: boolean })?.locked) return;
          const previous = await tx.select().from(expectations).where(eq(expectations.schoolId, schoolId));
          const date = localDateInTimeZone(now, config.schoolTimezone);
          // Coverage takes precedence over a frozen classroom roster. Presence
          // alone is insufficient: a matching full telemetry snapshot is required.
          const scopes = full ? (await tx.execute(sql`
            WITH scope_candidates AS (
              SELECT r.student_id,'supervision_context'::text AS scope_type,c.id AS scope_id,c.name AS scope_name,
                GREATEST(c.starts_at,r.assigned_at) AS scope_started_at,c.ends_at AS scope_ends_at,0 AS priority
              FROM classpilot_supervision_students r JOIN classpilot_supervision_contexts c ON c.school_id=r.school_id AND c.id=r.context_id
              WHERE r.school_id=${schoolId} AND r.released_at IS NULL AND c.status='active' AND c.ended_at IS NULL AND c.starts_at<=${now.toISOString()}::timestamptz AND c.ends_at>${now.toISOString()}::timestamptz
              UNION ALL
              SELECT r.student_id,'teaching_session',c.id,COALESCE(c.class_name_snapshot,g.name,'Class'),
                GREATEST(c.start_time,r.captured_at),c.scheduled_end_at,1
              FROM classpilot_session_students r JOIN teaching_sessions c ON c.school_id=r.school_id AND c.id=r.teaching_session_id
              JOIN groups g ON g.school_id=c.school_id AND g.id=c.group_id
              WHERE r.school_id=${schoolId} AND c.end_time IS NULL AND c.roster_snapshot_completed_at IS NOT NULL
                AND c.start_time<=${now.toISOString()}::timestamptz AND (c.scheduled_end_at IS NULL OR c.scheduled_end_at>${now.toISOString()}::timestamptz)
                AND (c.scheduled_state IS NULL OR c.scheduled_state='active')
            )
            SELECT DISTINCT ON (c.student_id) c.*,a.id AS student_session_id,a.device_id
            FROM scope_candidates c JOIN students s ON s.school_id=${schoolId} AND s.id=c.student_id AND s.status='active'
            JOIN student_sessions a ON a.student_id=s.id AND a.is_active=true AND a.ended_at IS NULL
              AND (a.auth_kind<>'manual_shared' OR a.manual_lease_expires_at>${now.toISOString()}::timestamptz)
            WHERE NOT EXISTS(SELECT 1 FROM student_attendance x WHERE x.school_id=${schoolId} AND x.student_id=s.id AND x.date=${date} AND x.status IN ('absent','early_dismissal'))
            ORDER BY c.student_id,c.priority,c.scope_started_at DESC,c.scope_id LIMIT 10001
          `)).rows as Scope[] : [];
          if (scopes.length > 10_000) throw new Error("MONITORING_SCOPE_BATCH_LIMIT");
          const readings = await readClasspilotRealtimeStatusBatch(schoolId, scopes.map((scope) => ({ studentId: scope.student_id, studentSessionId: scope.student_session_id, deviceId: scope.device_id })));
          const previousByStudent = new Map(previous.map((row) => [row.studentId, row]));
          const next: Expectation[] = [], gaps: string[] = [], recovered: Array<{ id: string; at: string }> = [];
          const ended: Array<{ id: string; reason: string }> = [];
          let uncertain = false;
          for (const scope of scopes) {
            const old = previousByStudent.get(scope.student_id);
            previousByStudent.delete(scope.student_id);
            const same = old && old.studentSessionId === scope.student_session_id && old.deviceId === scope.device_id && old.scopeType === scope.scope_type && old.scopeId === scope.scope_id;
            if (old && !same) ended.push({ id: old.id, reason: "binding_or_scope_changed" });
            const result = decideMonitoringInterruption({ now: now.getTime(), scopeStartedAt: new Date(scope.scope_started_at).getTime(), previousLastObservedAt: same ? old.lastObservedAt.getTime() : undefined,
              reading: readings.get(scope.student_id) ?? { status: "unavailable" }, fullMonitoring: full });
            if (result.state === "uncertain") uncertain = true;
            if (result.state === "excluded" || result.state === "unseen" || (result.state === "uncertain" && !same)) {
              if (same) ended.push({ id: old.id, reason: result.reason ?? "observation_unavailable" });
              continue;
            }
            const row: Expectation = { id: same ? old.id : randomUUID(), schoolId, studentId: scope.student_id, studentSessionId: scope.student_session_id, deviceId: scope.device_id,
              scopeType: scope.scope_type, scopeId: scope.scope_id, scopeName: scope.scope_name, scopeStartedAt: new Date(scope.scope_started_at), scopeEndsAt: scope.scope_ends_at ? new Date(scope.scope_ends_at) : null,
              lastObservedAt: new Date(result.lastObservedAt ?? old!.lastObservedAt), lastCheckedAt: now,
              uncertainSince: result.state === "uncertain" ? old?.uncertainSince ?? now : null, retentionExpiresAt: classpilotRetentionExpiresAt(now, config.retentionHours) };
            next.push(row);
            if (result.state === "gap") gaps.push(row.id);
            if (result.state === "observed") recovered.push({ id: row.id, at: row.lastObservedAt.toISOString() });
          }
          for (const old of previousByStudent.values()) ended.push({ id: old.id, reason: full ? "scope_or_binding_ended" : "monitoring_off" });
          if (ended.length) {
            await tx.execute(sql`UPDATE classpilot_monitoring_interruptions i SET ended_at=${now.toISOString()}::timestamptz,end_reason=x.reason
              FROM jsonb_to_recordset(${JSON.stringify(ended)}::jsonb) AS x(id text,reason text) WHERE i.school_id=${schoolId} AND i.expectation_id=x.id AND i.ended_at IS NULL`);
            await tx.execute(sql`DELETE FROM classpilot_monitoring_expectations e USING jsonb_to_recordset(${JSON.stringify(ended)}::jsonb) AS x(id text) WHERE e.school_id=${schoolId} AND e.id=x.id`);
          }
          if (next.length) await tx.insert(expectations).values(next).onConflictDoUpdate({ target: [expectations.schoolId, expectations.studentId], set: {
            lastObservedAt: sql`excluded.last_observed_at`, lastCheckedAt: now, uncertainSince: sql`excluded.uncertain_since`, scopeEndsAt: sql`excluded.scope_ends_at`, retentionExpiresAt: sql`excluded.retention_expires_at`,
          } });
          if (recovered.length) await tx.execute(sql`UPDATE classpilot_monitoring_interruptions i SET ended_at=GREATEST(i.detected_at,x.at),recovered_at=GREATEST(i.detected_at,x.at),end_reason='telemetry_resumed',uncertain_since=NULL
            FROM jsonb_to_recordset(${JSON.stringify(recovered)}::jsonb) AS x(id text,at timestamptz) WHERE i.school_id=${schoolId} AND i.expectation_id=x.id AND i.ended_at IS NULL`);
          await tx.execute(sql`UPDATE classpilot_monitoring_interruptions i SET uncertain_since=e.uncertain_since FROM classpilot_monitoring_expectations e WHERE i.school_id=${schoolId} AND e.id=i.expectation_id AND i.ended_at IS NULL`);
          if (gaps.length) await tx.execute(sql`INSERT INTO classpilot_monitoring_interruptions (expectation_id,school_id,student_id,student_session_id,device_id,scope_type,scope_id,scope_name,last_observed_at,detected_at,retention_expires_at)
            SELECT e.id,e.school_id,e.student_id,e.student_session_id,e.device_id,e.scope_type,e.scope_id,e.scope_name,e.last_observed_at,${now.toISOString()}::timestamptz,e.retention_expires_at
            FROM classpilot_monitoring_expectations e WHERE e.school_id=${schoolId} AND e.id IN (SELECT jsonb_array_elements_text(${JSON.stringify(gaps)}::jsonb))
            ON CONFLICT (expectation_id) WHERE ended_at IS NULL DO NOTHING`);
          await tx.insert(preferences).values({ schoolId, lastScannedAt: now, lastHealthyAt: uncertain ? null : now, scanStatus: full ? uncertain ? "uncertain" : "healthy" : "not_expected" })
            .onConflictDoUpdate({ target: preferences.schoolId, set: { lastScannedAt: now, ...(uncertain ? {} : { lastHealthyAt: now }), scanStatus: full ? uncertain ? "uncertain" : "healthy" : "not_expected" } });
          if (uncertain) uncertainSchools++;
          scannedSchools++;
        });
      } catch {
        uncertainSchools++;
        await schedulerDb.insert(preferences).values({ schoolId, lastScannedAt: now, scanStatus: "uncertain" }).onConflictDoUpdate({ target: preferences.schoolId, set: { lastScannedAt: now, scanStatus: "uncertain" } }).catch(() => {});
      }
    }
    for (const table of ["classpilot_monitoring_interruptions", "classpilot_monitoring_expectations", "classpilot_monitoring_interruption_digests"]) await schedulerDb.execute(sql`DELETE FROM ${sql.identifier(table)} WHERE retention_expires_at<=${now.toISOString()}::timestamptz`);
    return { scannedSchools, uncertainSchools };
  } finally { scanRunning = false; }
}

export async function getMonitoringInterruptionSettings(schoolId: string) {
  const [row] = await db.select().from(preferences).where(eq(preferences.schoolId, schoolId)).limit(1);
  return { digestEnabled: row?.digestEnabled ?? false, revision: row?.revision ?? 0 };
}
export async function setMonitoringInterruptionSettings(schoolId: string, actorId: string, digestEnabled: boolean, expectedRevision: number) {
  return db.transaction(async (tx) => {
    await assertClasspilotEntitled(schoolId, tx as unknown as typeof db, { lock: true });
    const actor = (await tx.execute(sql`SELECT u.id FROM users u WHERE u.id=${actorId} AND (u.is_super_admin=true OR EXISTS(SELECT 1 FROM school_memberships m WHERE m.user_id=u.id AND m.school_id=${schoolId} AND m.status='active' AND m.role IN ('admin','school_admin'))) LIMIT 1`)).rows[0];
    if (!actor) throw Object.assign(new Error("School administrator access required."), { status: 403 });
    if (digestEnabled) {
      const [policy] = await tx.select({ start: settings.trackingStartTime, end: settings.trackingEndTime }).from(settings).where(eq(settings.schoolId, schoolId)).limit(1);
      if (!policy?.start || !policy.end || !/^([01]\d|2[0-3]):[0-5]\d$/.test(policy.start) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(policy.end) || policy.start === policy.end) throw Object.assign(new Error("Configure valid tracking start and end times before enabling the daily digest."), { status: 409 });
    }
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`classpilot-monitoring-interruptions:${schoolId}`}))`);
    const [current] = await tx.select().from(preferences).where(eq(preferences.schoolId, schoolId)).limit(1);
    if ((current?.revision ?? 0) !== expectedRevision) throw Object.assign(new Error("Digest settings changed. Reload and try again."), { status: 409, code: "MONITORING_DIGEST_REVISION_CONFLICT" });
    const [saved] = await tx.insert(preferences).values({ schoolId, digestEnabled, revision: expectedRevision + 1, updatedBy: actorId }).onConflictDoUpdate({ target: preferences.schoolId, set: { digestEnabled, revision: expectedRevision + 1, updatedBy: actorId, updatedAt: new Date() } }).returning();
    if (!digestEnabled) await tx.execute(sql`UPDATE classpilot_monitoring_interruption_digests SET status='cancelled',completed_at=now(),error_code='DIGEST_DISABLED' WHERE school_id=${schoolId} AND status='pending'`);
    return { digestEnabled: saved!.digestEnabled, revision: saved!.revision };
  });
}

export async function listMonitoringInterruptions(options: { schoolId: string; actorId: string; isAdmin: boolean; now?: Date }) {
  const now = options.now ?? new Date();
  const [health] = await db.select({ status: preferences.scanStatus, lastScannedAt: preferences.lastScannedAt }).from(preferences).where(eq(preferences.schoolId, options.schoolId)).limit(1);
  const authorization = options.isAdmin ? sql`true` : sql`(
    (i.scope_type='teaching_session' AND EXISTS(SELECT 1 FROM classpilot_session_staff staff WHERE staff.school_id=i.school_id AND staff.teaching_session_id=i.scope_id AND staff.staff_id=${options.actorId}))
    OR (i.scope_type='supervision_context' AND EXISTS(SELECT 1 FROM classpilot_supervision_contexts c WHERE c.school_id=i.school_id AND c.id=i.scope_id AND c.assigned_staff_id=${options.actorId})))`;
  const rows = (await db.execute(sql`SELECT i.id,i.student_id,i.scope_type,i.scope_id,i.scope_name,i.last_observed_at,i.detected_at,i.recovered_at,i.ended_at,i.end_reason,i.uncertain_since,
    concat_ws(' ',s.first_name,s.last_name) AS student_name
    FROM classpilot_monitoring_interruptions i JOIN students s ON s.school_id=i.school_id AND s.id=i.student_id
    WHERE i.school_id=${options.schoolId} AND i.retention_expires_at>${now.toISOString()}::timestamptz AND ${authorization}
    AND (i.ended_at IS NULL OR i.detected_at>=${new Date(now.getTime() - 86400_000).toISOString()}::timestamptz)
    ORDER BY (i.ended_at IS NULL) DESC,i.detected_at DESC,i.id LIMIT 501`)).rows as Array<Record<string, unknown>>;
  const stale = !health?.lastScannedAt || now.getTime() - health.lastScannedAt.getTime() > 180_000;
  return { scanStatus: stale ? "uncertain" : health.status, lastScannedAt: health?.lastScannedAt ?? null, truncated: rows.length > 500,
    incidents: rows.slice(0, 500).map((row) => ({ id: row.id, studentId: row.student_id, studentName: row.student_name, scopeType: row.scope_type, scopeId: row.scope_id, scopeName: row.scope_name,
      lastObservedAt: row.last_observed_at, detectedAt: row.detected_at, recoveredAt: row.recovered_at, endedAt: row.ended_at, endReason: row.end_reason,
      status: row.ended_at ? row.recovered_at ? "recovered" : "ended" : row.uncertain_since || stale || health?.status === "uncertain" ? "uncertain" : "open" })) };
}
