/**
 * Security Monitor — deterministic rule-based breach detection.
 *
 * Philosophy:
 * - Read-only + alerting. Never takes destructive action autonomously.
 * - Rule-based, not LLM-based. Security decisions must be predictable and auditable.
 * - Uses schedulerDb (isolated pool) so it never starves API requests.
 * - Every detection is written to security_events for human review.
 *
 * Alerts flow: detection -> security_events row -> minimal email to
 * security@school-pilot.net -> safe security_event summary in errorMonitor.
 */
import { sql } from "drizzle-orm";
import { schedulerDb } from "./schedulerDb.js";
import { securityEvents } from "../schema/shared.js";
import { sendEmail } from "./email.js";
import errorMonitor from "./errorMonitor.js";

type Severity = "low" | "medium" | "high" | "critical";

interface Detection {
  eventType: string;
  severity: Severity;
  summary: string;
  details: Record<string, unknown>;
  schoolId?: string;
  userId?: string;
  userEmail?: string;
}

// Thresholds — tuned conservatively to minimize false positives in v1.
// Adjust after a few weeks of production data.
const THRESHOLDS = {
  FAILED_AUTH_PER_EMAIL_5MIN: 10,           // credential stuffing / brute force
  FAILED_AUTH_PER_IP_5MIN: 30,              // broader attack
  BULK_STUDENT_WRITE_5MIN: 500,              // suspicious bulk import/delete
  OFF_HOURS_ADMIN_ACTIONS_5MIN: 20,          // admin burst at 3am
  PII_KEYWORDS: /\b(ssn|social security|date of birth|dob)\b/i,
};

async function checkFailedAuthSpike(since: Date): Promise<Detection[]> {
  // Brute-force / credential stuffing: many failed auths from same email or IP
  const rows = await schedulerDb.execute(sql`
    SELECT user_email, metadata->>'ip' as ip, COUNT(*)::int AS count
    FROM audit_logs
    WHERE action = 'auth.login.failed'
      AND created_at >= ${since}
    GROUP BY user_email, metadata->>'ip'
    HAVING COUNT(*) >= ${THRESHOLDS.FAILED_AUTH_PER_EMAIL_5MIN}
  `);
  return (rows.rows as Array<{ user_email: string; ip: string | null; count: number }>).map((r) => ({
    eventType: "failed_auth_spike",
    severity: r.count >= 25 ? "high" : "medium",
    summary: `${r.count} failed logins for ${r.user_email} in 5 min${r.ip ? ` from ${r.ip}` : ""}`,
    details: { failedCount: r.count, ip: r.ip, targetEmail: r.user_email },
    userEmail: r.user_email,
  }));
}

async function checkBulkStudentOps(since: Date): Promise<Detection[]> {
  // One user writing/deleting many student records in a short window
  const rows = await schedulerDb.execute(sql`
    SELECT user_id, user_email, school_id, COUNT(*)::int AS count
    FROM audit_logs
    WHERE action IN ('student.create', 'student.delete', 'student.bulk_delete', 'student.update')
      AND created_at >= ${since}
    GROUP BY user_id, user_email, school_id
    HAVING COUNT(*) >= ${THRESHOLDS.BULK_STUDENT_WRITE_5MIN}
  `);
  return (rows.rows as Array<{ user_id: string; user_email: string; school_id: string; count: number }>).map((r) => ({
    eventType: "bulk_student_write",
    severity: r.count >= 2000 ? "critical" : r.count >= 1000 ? "high" : "medium",
    summary: `${r.count} student-record writes by ${r.user_email || r.user_id} in 5 min`,
    details: { operationCount: r.count },
    schoolId: r.school_id,
    userId: r.user_id,
    userEmail: r.user_email,
  }));
}

async function checkOffHoursAdminBurst(since: Date): Promise<Detection[]> {
  // Admin-level actions at unusual hours (UTC 03:00–09:00 covers most US overnight)
  const hour = new Date().getUTCHours();
  if (hour < 3 || hour > 9) return [];

  const rows = await schedulerDb.execute(sql`
    SELECT user_id, user_email, school_id, COUNT(*)::int AS count
    FROM audit_logs
    WHERE user_role IN ('admin', 'school_admin', 'super_admin')
      AND created_at >= ${since}
    GROUP BY user_id, user_email, school_id
    HAVING COUNT(*) >= ${THRESHOLDS.OFF_HOURS_ADMIN_ACTIONS_5MIN}
  `);
  return (rows.rows as Array<{ user_id: string; user_email: string; school_id: string; count: number }>).map((r) => ({
    eventType: "off_hours_admin_burst",
    severity: "medium",
    summary: `${r.count} admin actions by ${r.user_email || r.user_id} during overnight hours`,
    details: { actionCount: r.count, hourUtc: hour },
    schoolId: r.school_id,
    userId: r.user_id,
    userEmail: r.user_email,
  }));
}

async function checkCrossSchoolAccess(since: Date): Promise<Detection[]> {
  // User with memberships at School A making audit-logged actions against School B
  // This catches staff account compromise or misconfigured RBAC
  const rows = await schedulerDb.execute(sql`
    SELECT DISTINCT al.user_id, al.user_email, al.school_id AS acted_school_id,
           COUNT(*)::int AS count
    FROM audit_logs al
    WHERE al.created_at >= ${since}
      AND al.user_role NOT IN ('super_admin')
      AND NOT EXISTS (
        SELECT 1 FROM school_memberships sm
        WHERE sm.user_id = al.user_id AND sm.school_id = al.school_id
      )
    GROUP BY al.user_id, al.user_email, al.school_id
  `);
  return (rows.rows as Array<{ user_id: string; user_email: string; acted_school_id: string; count: number }>).map((r) => ({
    eventType: "cross_school_access",
    severity: "critical",
    summary: `Cross-school access: ${r.user_email || r.user_id} acted on school ${r.acted_school_id} without membership (${r.count} actions)`,
    details: { actionCount: r.count, targetSchoolId: r.acted_school_id },
    schoolId: r.acted_school_id,
    userId: r.user_id,
    userEmail: r.user_email,
  }));
}

async function persistDetection(d: Detection): Promise<string | null> {
  // Dedupe: if identical eventType + user + school was detected in last 30 min and still "open",
  // don't create a new row. This prevents alert spam while a human investigates.
  const existing = await schedulerDb.execute(sql`
    SELECT id FROM security_events
    WHERE event_type = ${d.eventType}
      AND COALESCE(user_id, '') = COALESCE(${d.userId ?? null}, '')
      AND COALESCE(school_id, '') = COALESCE(${d.schoolId ?? null}, '')
      AND status = 'open'
      AND detected_at >= NOW() - INTERVAL '30 minutes'
    LIMIT 1
  `);
  if (existing.rows.length > 0) return null;

  const result = await schedulerDb.insert(securityEvents).values({
    eventType: d.eventType,
    severity: d.severity,
    schoolId: d.schoolId ?? null,
    userId: d.userId ?? null,
    userEmail: d.userEmail ?? null,
    summary: d.summary,
    details: d.details,
  }).returning({ id: securityEvents.id });
  return result[0]?.id ?? null;
}

async function alertOn(d: Detection, eventId: string): Promise<void> {
  try {
    const delivered = Boolean(process.env.SENDGRID_API_KEY) && await sendEmail({
      to: "security@school-pilot.net",
      subject: `[${d.severity.toUpperCase()}] Security event: ${d.eventType}`,
      text: [
        "Security detection recorded.",
        `Severity: ${d.severity}`,
        `Type: ${d.eventType}`,
        `Event ID: ${eventId}`,
        d.schoolId ? `School ID: ${d.schoolId}` : null,
        d.userId ? `User ID: ${d.userId}` : null,
        "",
        "Review the security_events record before taking action.",
      ].filter(Boolean).join("\n"),
    });
    if (delivered) {
      await schedulerDb.update(securityEvents)
        .set({ alertSent: true })
        .where(sql`id = ${eventId}`);
    }
  } catch (err) {
    console.error("[SecurityMonitor] Alert email failed:", err);
  }

  // Also log to the existing error monitor so it shows up in Telegram/existing channels
  errorMonitor.trackError("security_event", new Error(`Security event ${d.severity}: ${d.eventType} (${eventId})`), {
    eventType: d.eventType,
    eventId,
    errorCode: d.severity,
  });
}

/**
 * Main entry point — called from the scheduler every ~5 minutes.
 * Runs all checks, persists detections, and dispatches alerts.
 */
export async function runSecurityChecks(): Promise<void> {
  try {
    // Look back a bit further than the run interval to ensure no events fall through the cracks
    const since = new Date(Date.now() - 7 * 60 * 1000); // 7 min window for 5 min cadence

    const checks = await Promise.all([
      checkFailedAuthSpike(since).catch(err => { console.error("[SecurityMonitor] failedAuth check failed:", err); return []; }),
      checkBulkStudentOps(since).catch(err => { console.error("[SecurityMonitor] bulkStudent check failed:", err); return []; }),
      checkOffHoursAdminBurst(since).catch(err => { console.error("[SecurityMonitor] offHours check failed:", err); return []; }),
      checkCrossSchoolAccess(since).catch(err => { console.error("[SecurityMonitor] crossSchool check failed:", err); return []; }),
    ]);

    const detections = checks.flat();
    if (detections.length === 0) return;

    console.log(`[SecurityMonitor] ${detections.length} detection(s) this cycle`);

    for (const d of detections) {
      const eventId = await persistDetection(d);
      if (eventId) {
        await alertOn(d, eventId);
      }
    }
  } catch (err) {
    console.error("[SecurityMonitor] Top-level failure:", err);
    errorMonitor.trackError("scheduler_failure", err as Error, { job: "securityMonitor" });
  }
}
