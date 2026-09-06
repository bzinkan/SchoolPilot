import { sql } from "drizzle-orm";
import { schedulerDb } from "./schedulerDb.js";
import type db from "../db.js";
import { resolveClasspilotEntitlement } from "./classpilotEntitlement.js";
import { sendEmailWithResult, type EmailSendOptions, type EmailSendResult } from "./email.js";
import { monitoringDigestWindow, monitoringDigestWindowForDate } from "./classpilotMonitoringInterruptionRules.js";
export { monitoringDigestWindow } from "./classpilotMonitoringInterruptionRules.js";
import { classpilotRetentionExpiresAt } from "../util/classpilotRetention.js";

type Row = Record<string, any>;
const digestPolicy = (row: Row) => ({ schoolTimezone: row.school_timezone, trackingStartTime: row.tracking_start_time, trackingEndTime: row.tracking_end_time,
  trackingDays: row.tracking_days, instructionalCalendar: row.instructional_calendar, schedulingDateOverrides: row.scheduling_date_overrides });
/** Separate, opt-in operational digest. Unknown deliveries never retry blindly. */
export async function dispatchClasspilotMonitoringDigests(now = new Date(), options: { schoolIds?: readonly string[]; send?: (message: EmailSendOptions) => Promise<EmailSendResult>; providerConfigured?: boolean } = {}) {
  const schoolsFilter = options.schoolIds ? sql`p.school_id IN (SELECT jsonb_array_elements_text(${JSON.stringify(options.schoolIds)}::jsonb))` : sql`true`;
  const candidates = (await schedulerDb.execute(sql`SELECT p.school_id,school.school_timezone,s.tracking_start_time,s.tracking_end_time,s.tracking_days,s.retention_hours,
    s.instructional_calendar,COALESCE(schedule.config->'dateOverrides','{}'::jsonb) AS scheduling_date_overrides
    FROM classpilot_monitoring_interruption_settings p JOIN settings s ON s.school_id=p.school_id JOIN schools school ON school.id=p.school_id
    LEFT JOIN classpilot_school_schedules schedule ON schedule.school_id=p.school_id WHERE p.digest_enabled=true AND ${schoolsFilter}`)).rows as Row[];
  for (const row of candidates) {
    const window = monitoringDigestWindow(now, digestPolicy(row));
    if (!window || !(await resolveClasspilotEntitlement(row.school_id, schedulerDb as unknown as typeof db)).entitled) continue;
    await schedulerDb.execute(sql`INSERT INTO classpilot_monitoring_interruption_digests(school_id,local_date,recipient_user_id,due_at,retention_expires_at)
      SELECT ${row.school_id},${window.localDate},m.user_id,${window.dueAt.toISOString()}::timestamptz,${classpilotRetentionExpiresAt(now, row.retention_hours).toISOString()}::timestamptz
      FROM school_memberships m JOIN users u ON u.id=m.user_id
      WHERE m.school_id=${row.school_id} AND m.status='active' AND m.role IN ('admin','school_admin') AND u.email IS NOT NULL
        AND EXISTS(SELECT 1 FROM classpilot_monitoring_interruptions i WHERE i.school_id=m.school_id AND i.detected_at>=${window.startAt.toISOString()}::timestamptz AND i.detected_at<=${window.endAt.toISOString()}::timestamptz AND i.retention_expires_at>${now.toISOString()}::timestamptz)
      ON CONFLICT(school_id,local_date,recipient_user_id) DO NOTHING`);
  }
  await schedulerDb.execute(sql`UPDATE classpilot_monitoring_interruption_digests SET status='unknown',completed_at=${now.toISOString()}::timestamptz,error_code='WORKER_INTERRUPTED_AFTER_CLAIM'
    WHERE status='sending' AND claimed_at<${new Date(now.getTime() - 10 * 60_000).toISOString()}::timestamptz`);
  const claimed = await schedulerDb.transaction(async (tx) => {
    const scopeFilter = options.schoolIds ? sql`school_id IN (SELECT jsonb_array_elements_text(${JSON.stringify(options.schoolIds)}::jsonb))` : sql`true`;
    const rows = (await tx.execute(sql`SELECT id FROM classpilot_monitoring_interruption_digests WHERE status='pending' AND due_at<=${now.toISOString()}::timestamptz AND ${scopeFilter} ORDER BY due_at,id LIMIT 100 FOR UPDATE SKIP LOCKED`)).rows as Row[];
    if (!rows.length) return [];
    return (await tx.execute(sql`UPDATE classpilot_monitoring_interruption_digests SET status='sending',claimed_at=${now.toISOString()}::timestamptz,attempts=attempts+1
      WHERE id IN (${sql.join(rows.map((row) => sql`${row.id}`), sql`,`)}) RETURNING *`)).rows as Row[];
  });
  for (const entry of claimed) {
    const recipients = (await schedulerDb.execute(sql`SELECT u.email,school.school_timezone,s.tracking_start_time,s.tracking_end_time,s.tracking_days,
      s.instructional_calendar,COALESCE(schedule.config->'dateOverrides','{}'::jsonb) AS scheduling_date_overrides
      FROM classpilot_monitoring_interruption_settings p JOIN school_memberships m ON m.school_id=p.school_id
      JOIN users u ON u.id=m.user_id JOIN settings s ON s.school_id=p.school_id JOIN schools school ON school.id=p.school_id
      LEFT JOIN classpilot_school_schedules schedule ON schedule.school_id=p.school_id
      WHERE p.school_id=${entry.school_id} AND p.digest_enabled=true AND m.user_id=${entry.recipient_user_id} AND m.status='active' AND m.role IN ('admin','school_admin') LIMIT 1`)).rows as Row[];
    const recipient = recipients[0];
    const window = recipient ? monitoringDigestWindowForDate(entry.local_date, digestPolicy(recipient)) : null;
    if (!recipient || !window || !(await resolveClasspilotEntitlement(entry.school_id, schedulerDb as unknown as typeof db)).entitled) {
      await schedulerDb.execute(sql`UPDATE classpilot_monitoring_interruption_digests SET status='cancelled',completed_at=${now.toISOString()}::timestamptz,error_code='RECIPIENT_OR_POLICY_CHANGED' WHERE id=${entry.id} AND status='sending'`);
      continue;
    }
    if (now < window.dueAt) {
      await schedulerDb.execute(sql`UPDATE classpilot_monitoring_interruption_digests SET status='pending',claimed_at=NULL,due_at=${window.dueAt.toISOString()}::timestamptz WHERE id=${entry.id} AND status='sending'`);
      continue;
    }
    const zone = recipient.school_timezone || "America/New_York";
    const { startAt, endAt } = window;
    const groups = (await schedulerDb.execute(sql`SELECT scope_name,count(*)::int AS incidents,count(DISTINCT student_id)::int AS students,count(*) FILTER(WHERE ended_at IS NULL)::int AS unresolved
      FROM classpilot_monitoring_interruptions WHERE school_id=${entry.school_id} AND detected_at>=${startAt.toISOString()}::timestamptz AND detected_at<=${endAt.toISOString()}::timestamptz
        AND retention_expires_at>${now.toISOString()}::timestamptz GROUP BY scope_type,scope_id,scope_name ORDER BY scope_name LIMIT 100`)).rows as Row[];
    const origin = process.env.PUBLIC_APP_URL || process.env.APP_URL || "https://school-pilot.net";
    const message = `Monitoring interruptions for ${entry.local_date} (${zone})\n\n${groups.map((group) => `${group.scope_name}: ${group.students} students, ${group.incidents} interruptions, ${group.unresolved} still open.`).join("\n")}\n\nA monitoring interruption means expected telemetry was not observed for more than 60 seconds. Its cause is unknown.\nReview current status: ${origin}/classpilot/coverage\n\nThis operational digest is separate from student safety notifications.`;
    const result = (options.providerConfigured ?? Boolean(process.env.SENDGRID_API_KEY)) ? await (options.send ?? sendEmailWithResult)({ to: recipient.email, subject: "ClassPilot: daily monitoring interruptions", text: message, customArgs: { workflow: "monitoring-interruptions-v1" } }) : { status: "transient_failure" as const, error: "EMAIL_PROVIDER_UNCONFIGURED" };
    const status = result.status === "sent" ? "sent" : result.status === "unknown" ? "unknown" : result.status === "permanent_failure" || entry.attempts >= 5 ? "failed" : "pending";
    await schedulerDb.execute(sql`UPDATE classpilot_monitoring_interruption_digests SET status=${status},completed_at=${status === "pending" ? null : now.toISOString()}::timestamptz,
      due_at=${new Date(now.getTime() + Math.min(3600, 30 * 2 ** entry.attempts) * 1000).toISOString()}::timestamptz,error_code=${result.status === "sent" ? null : result.error.slice(0, 120)} WHERE id=${entry.id} AND status='sending'`);
  }
  return { attempted: claimed.length };
}
