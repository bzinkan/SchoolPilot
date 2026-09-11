import { and, asc, eq, gt, inArray, isNull, lte, or, sql, type SQL } from "drizzle-orm";
import { db } from "../db.js";
import {
  classpilotSupervisionContexts as contexts, classpilotSupervisionStudents as assignments,
  classpilotSupervisionReportSegments as segments, classpilotSupervisionStudentReports as details,
  classpilotSupervisionSummaryDeliveries as deliveries, settings, schools, schoolMemberships, users, students,
  type ClasspilotSupervisionReportSegment, type ClasspilotSupervisionContext, type SupervisionParticipationInterval,
} from "../schema/index.js";
import { parseClasspilotRetentionDays } from "../util/classpilotRetention.js";
import { classpilotSessionReportVersionForNewRow } from "../config/classpilotSessionReportRollout.js";

const SETTLEMENT_MS = 30_000;
const STAFF_ROLES = ["admin", "school_admin", "teacher", "office_staff"];

/** Release supplies one immutable UTC cutoff to every API and worker task.
 * Removing/changing it after activation is unsupported; pause email transport
 * separately. No local process-start timestamp can manufacture staff history. */
export function supervisionActivityReportingEnabled(now = new Date()): boolean {
  const cutoff = captureCutoff();
  return cutoff !== null && cutoff <= now.getTime();
}

function captureCutoff(): number | null {
  const raw = process.env.CLASSPILOT_SUPERVISION_REPORTS_CAPTURE_FROM?.trim();
  if (!raw || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(raw)) return null;
  const parsed = Date.parse(raw);
  if (!Number.isFinite(parsed)) return null;
  // Date.parse accepts impossible dates such as February 30 by normalizing.
  return new Date(parsed).toISOString().replace(".000Z", "Z") === raw.replace(".000Z", "Z") ? parsed : null;
}

function displayName(user: { displayName?: string | null; firstName?: string | null; lastName?: string | null; email?: string | null } | undefined, fallback: string): string {
  return user?.displayName?.trim() || [user?.firstName, user?.lastName].filter(Boolean).join(" ").trim() || user?.email || fallback;
}

function contextEnd(context: ClasspilotSupervisionContext, now: Date): Date {
  return new Date(Math.min(now.getTime(), context.endsAt.getTime(), context.endedAt?.getTime() ?? Infinity));
}

/** Current policy may shorten the frozen expiry, but never extend it. This
 * correlated predicate is also used immediately before provider submission.
 * Nested CASE keeps malformed/oversized legacy strings away from integer casts
 * and matches parseClasspilotRetentionDays's default and whole-day validation. */
export function supervisionCurrentRetentionExpired(now: Date): SQL {
  return sql`${segments.windowEnd} <= ${now.toISOString()}::timestamptz - (
    COALESCE((SELECT CASE
      WHEN btrim(policy.retention_hours) ~ '^[0-9]+$'
        AND length(ltrim(btrim(policy.retention_hours),'0')) BETWEEN 1 AND 4
      THEN CASE
        WHEN ltrim(btrim(policy.retention_hours),'0')::integer BETWEEN 24 AND 8760
          AND ltrim(btrim(policy.retention_hours),'0')::integer % 24 = 0
        THEN ltrim(btrim(policy.retention_hours),'0')::integer ELSE 720 END
      ELSE 720 END FROM ${settings} AS policy WHERE policy.school_id=${segments.schoolId}),720)
    * interval '1 hour')`;
}

export function supervisionReportPastRetention(report: { windowEnd: Date | null; expiresAt: Date | null }, now: Date, cutoff?: Date): boolean {
  return Boolean(report.expiresAt && report.expiresAt <= now)
    || Boolean(cutoff && report.windowEnd && report.windowEnd <= cutoff);
}

/** A stale worker snapshot must never finalize a tenure created after its clock.
 * Future assignment/release timestamps likewise mean the caller cannot infer
 * that the context was empty, ended, or owned by its currently stored teacher. */
export function supervisionCaptureTimeIsCurrent(
  now: Date,
  context: Pick<ClasspilotSupervisionContext, "startsAt" | "createdAt" | "updatedAt" | "endedAt">,
  activeStart: Date | null,
  rows: Array<Pick<typeof assignments.$inferSelect, "assignedAt" | "releasedAt">>,
): boolean {
  return Number.isFinite(now.getTime())
    && context.startsAt <= now && context.createdAt <= now && context.updatedAt <= now
    && (!context.endedAt || context.endedAt <= now)
    && (!activeStart || activeStart <= now)
    && rows.every((row) => row.assignedAt <= now && (!row.releasedAt || row.releasedAt <= now));
}

type AssignmentRow = {
  assignment: typeof assignments.$inferSelect;
  firstName: string | null;
  lastName: string | null;
};

/** Retain every actual assignment interval, including a release/rejoin. Source
 * assignment ids are internal dedupe keys and never enter email output. */
export function supervisionParticipationIntervals(
  reportStart: Date,
  context: Pick<ClasspilotSupervisionContext, "startsAt" | "endsAt" | "endedAt">,
  rows: Array<typeof assignments.$inferSelect>,
  closeAt?: Date,
): SupervisionParticipationInterval[] {
  return rows.flatMap((row) => {
    const start = Math.max(reportStart.getTime(), context.startsAt.getTime(), row.assignedAt.getTime());
    const terminal = closeAt?.getTime() ?? context.endedAt?.getTime();
    const end = Math.min(row.releasedAt?.getTime() ?? Infinity, terminal ?? Infinity, context.endsAt.getTime());
    if (end <= start) return [];
    // Scheduled expiry is only frozen once reached. An extension before then
    // must retain the open interval rather than its former scheduled endpoint.
    const closed = row.releasedAt !== null || terminal !== undefined;
    return [{ assignmentId: row.id, start: new Date(start).toISOString(), end: closed ? new Date(end).toISOString() : null }];
  }).sort((left, right) => left.start.localeCompare(right.start) || left.assignmentId.localeCompare(right.assignmentId));
}

async function captureStudents(report: ClasspilotSupervisionReportSegment, context: ClasspilotSupervisionContext, rows: AssignmentRow[], now: Date, conn: typeof db, closeAt?: Date) {
  const existing = await conn.select().from(details).where(and(eq(details.schoolId, report.schoolId), eq(details.reportId, report.id)));
  const byStudent = new Map<string, AssignmentRow[]>();
  for (const row of rows) {
    if (row.assignment.assignedAt > now) continue;
    const values = byStudent.get(row.assignment.studentId) || [];
    values.push(row); byStudent.set(row.assignment.studentId, values);
  }
  for (const studentId of new Set([...byStudent.keys(), ...existing.map((row) => row.studentId)])) {
    const prior = existing.find((row) => row.studentId === studentId);
    const source = byStudent.get(studentId) || [];
    const observed = supervisionParticipationIntervals(report.windowStart, context, source.map((row) => row.assignment), closeAt);
    const merged = new Map((prior?.participationIntervals || []).map((interval) => [interval.assignmentId, interval]));
    for (const interval of observed) merged.set(interval.assignmentId, interval);
    const intervals = [...merged.values()].flatMap((interval) => {
      const start = Math.max(Date.parse(interval.start), report.windowStart.getTime());
      const end = Math.min(interval.end ? Date.parse(interval.end) : Infinity, closeAt?.getTime() ?? Infinity);
      if (end <= start) return [];
      return [{ ...interval, start: new Date(start).toISOString(), end: Number.isFinite(end) ? new Date(end).toISOString() : null }];
    }).sort((left, right) => left.start.localeCompare(right.start) || left.assignmentId.localeCompare(right.assignmentId));
    if (!intervals.length) {
      if (prior) await conn.delete(details).where(and(eq(details.schoolId, report.schoolId), eq(details.id, prior.id)));
      continue;
    }
    if (prior) {
      if (JSON.stringify(intervals) !== JSON.stringify(prior.participationIntervals)) {
        await conn.update(details).set({ participationIntervals: intervals, updatedAt: now }).where(and(eq(details.schoolId, report.schoolId), eq(details.id, prior.id)));
      }
    } else {
      const sourceName = source[0];
      const name = [sourceName?.firstName, sourceName?.lastName].filter(Boolean).join(" ").trim() || "Unavailable student";
      await conn.insert(details).values({ schoolId: report.schoolId, reportId: report.id, studentId, studentNameSnapshot: name, participationIntervals: intervals, createdAt: now, updatedAt: now }).onConflictDoNothing();
    }
  }
}

async function frozenPolicy(schoolId: string, conn: typeof db) {
  const [schoolSettings] = await conn.select().from(settings).where(eq(settings.schoolId, schoolId)).limit(1);
  const [school] = await conn.select({ timezone: schools.schoolTimezone }).from(schools).where(eq(schools.id, schoolId)).limit(1);
  const timezone = school?.timezone || schoolSettings?.schoolTimezone || "America/New_York";
  return { schoolSettings, timezone, retentionHours: parseClasspilotRetentionDays(schoolSettings?.retentionHours) * 24,
    trackingPolicy: {
      enableTrackingHours: schoolSettings?.enableTrackingHours === true,
      trackingStartTime: schoolSettings?.trackingStartTime || null,
      trackingEndTime: schoolSettings?.trackingEndTime || null,
      trackingDays: schoolSettings?.trackingDays || [], schoolTimezone: timezone,
      afterHoursMode: schoolSettings?.afterHoursMode === "limited" ? "off" as const : schoolSettings?.afterHoursMode || "off" as const,
    },
  };
}

async function closeSegment(report: ClasspilotSupervisionReportSegment, context: ClasspilotSupervisionContext, rows: AssignmentRow[], end: Date, reason: string, now: Date, conn: typeof db) {
  const closeAt = new Date(Math.max(report.windowStart.getTime(), end.getTime()));
  await captureStudents(report, context, rows, now, conn, closeAt);
  const policy = await frozenPolicy(report.schoolId, conn);
  const settleAt = new Date(now.getTime() + SETTLEMENT_MS);
  const expiresAt = new Date(closeAt.getTime() + policy.retentionHours * 3_600_000);
  await conn.update(segments).set({ state: "pending", windowEnd: closeAt, closureReason: reason,
    timezone: policy.timezone, trackingPolicy: policy.trackingPolicy, retentionHours: policy.retentionHours,
    settleAt, nextAttemptAt: settleAt, expiresAt, updatedAt: now,
  }).where(and(eq(segments.schoolId, report.schoolId), eq(segments.id, report.id), eq(segments.state, "active")));
  const participants = await conn.select({ id: details.id }).from(details).where(and(eq(details.schoolId, report.schoolId), eq(details.reportId, report.id))).limit(1);
  if (!participants.length || closeAt <= report.windowStart) return;

  const recipientIds = [...new Set([report.staffId, policy.schoolSettings?.centralEmailRecipientUserId].filter((id): id is string => !!id))];
  const recipientRows = recipientIds.length ? await conn.select({ user: users, membership: schoolMemberships }).from(schoolMemberships)
    .innerJoin(users, eq(users.id, schoolMemberships.userId))
    .where(and(eq(schoolMemberships.schoolId, report.schoolId), inArray(schoolMemberships.userId, recipientIds),
      eq(schoolMemberships.status, "active"), inArray(schoolMemberships.role, STAFF_ROLES))) : [];
  const supervisor = recipientRows.find((row) => row.user.id === report.staffId)?.user;
  const central = recipientRows.find((row) => row.user.id === policy.schoolSettings?.centralEmailRecipientUserId)?.user;
  const supervisorEmail = supervisor?.email?.trim().toLowerCase() || null;
  const recipients = [{ kind: "supervisor", staffId: report.staffId, name: report.staffNameSnapshot || "Teacher", email: supervisorEmail,
    error: !supervisor ? "recipient_membership_unavailable" : !supervisorEmail ? "recipient_email_unavailable" : null }];
  const centralId = policy.schoolSettings?.centralEmailRecipientUserId;
  const centralEmail = central?.email?.trim().toLowerCase() || null;
  if (centralId && centralId !== report.staffId && (!centralEmail || centralEmail !== supervisorEmail)) {
    recipients.push({ kind: "central", staffId: centralId, name: displayName(central, "School Team"), email: centralEmail,
      error: !central ? "recipient_membership_unavailable" : !centralEmail ? "recipient_email_unavailable" : null });
  }
  for (const recipient of recipients) {
    await conn.insert(deliveries).values({ schoolId: report.schoolId, reportId: report.id,
      recipientStaffId: recipient.staffId, recipientKind: recipient.kind, recipientName: recipient.name,
      recipientEmail: recipient.email, state: recipient.error ? "failed" : "waiting_report", lastError: recipient.error,
      nextAttemptAt: settleAt, createdAt: now, updatedAt: now,
    }).onConflictDoNothing();
  }
}

/** Must run in the same transaction, before AND after changing contexts or
 * membership. Context row locks serialize capture with transfers and the worker. */
export async function syncSupervisionActivityReports(options: { schoolId: string; contextIds: string[]; now?: Date; clock?: () => Date; newContextIds?: string[] }, conn: typeof db = db): Promise<void> {
  const clock = options.clock || (() => new Date());
  const entryTime = options.now || clock();
  const cutoff = captureCutoff();
  // Keep pre-release instances and fixtures independent of additive tables.
  if (cutoff === null || cutoff > entryTime.getTime()) return;
  const ids = [...new Set(options.contextIds)].sort();
  if (!ids.length) return;
  const lockedContexts = await conn.select().from(contexts).where(and(eq(contexts.schoolId, options.schoolId), inArray(contexts.id, ids))).orderBy(asc(contexts.id)).for("update");
  for (const context of lockedContexts) {
    // In production this is sampled after acquiring the context lock. Explicit
    // now is reserved for mutation timestamps and deterministic as-of tests.
    const now = options.now || clock();
    const allReports = await conn.select().from(segments).where(and(eq(segments.schoolId, options.schoolId), eq(segments.contextId, context.id))).orderBy(asc(segments.windowStart));
    let active = allReports.find((report) => report.state === "active");
    const rows = await conn.select({ assignment: assignments, firstName: students.firstName, lastName: students.lastName }).from(assignments)
      .leftJoin(students, and(eq(students.id, assignments.studentId), eq(students.schoolId, options.schoolId)))
      .where(and(eq(assignments.schoolId, options.schoolId), eq(assignments.contextId, context.id)));
    if (!supervisionCaptureTimeIsCurrent(now, context, active?.windowStart || null, rows.map((row) => row.assignment))) continue;
    const currentRows = rows.filter(({ assignment }) => assignment.releasedAt === null && assignment.assignedAt <= now);
    const stillRunning = context.status === "active" && context.endsAt > now && (!context.endedAt || context.endedAt > now) && context.startsAt <= now;
    if (active) {
      const handoff = active.staffId !== context.assignedStaffId;
      if (!stillRunning || handoff || !currentRows.length) {
        let end = contextEnd(context, now);
        const reason = handoff ? "staff_handoff" : !stillRunning ? context.endedAt ? "context_ended" : "scheduled_expiry" : "last_student_departed";
        if (!currentRows.length && stillRunning && !handoff) {
          const departures = rows.map(({ assignment }) => assignment.releasedAt?.getTime() || 0).filter((value) => value >= active!.windowStart.getTime() && value <= now.getTime());
          if (departures.length) end = new Date(Math.min(end.getTime(), Math.max(...departures)));
        }
        await closeSegment(active, context, rows, end, reason, now, conn);
        active = undefined;
      } else {
        await captureStudents(active, context, rows, now, conn);
      }
    }
    if (active || !stillRunning || !currentRows.length) continue;
    const newContext = options.newContextIds?.includes(context.id) === true;
    const latestEnd = allReports.reduce((value, report) => Math.max(value, report.windowEnd?.getTime() || 0), 0);
    // Database created_at can be the transaction's start, before activation.
    // Mutation callers pass the same actual clock as the new assignment rows.
    const start = new Date(Math.max(cutoff, context.startsAt.getTime(), latestEnd, now.getTime()));
    if (start > now || start >= context.endsAt) continue;
    const [staff] = await conn.select().from(users).where(eq(users.id, context.assignedStaffId)).limit(1);
    const policy = await frozenPolicy(options.schoolId, conn);
    const [created] = await conn.insert(segments).values({ schoolId: options.schoolId, contextId: context.id,
      staffId: context.assignedStaffId, staffNameSnapshot: displayName(staff, "Unavailable staff member"),
      contextNameSnapshot: context.name, contextType: context.contextType, windowStart: start,
      timezone: policy.timezone, partialAdoption: !newContext && !allReports.length,
      reportVersion: Math.max(2, classpilotSessionReportVersionForNewRow()),
      retentionHours: policy.retentionHours, createdAt: now, updatedAt: now,
    }).returning();
    if (created) await captureStudents(created, context, rows, now, conn);
  }
}

type BatchOptions = { schoolId?: string; limit?: number; now?: Date; cutoff?: Date; clock?: () => Date };

/** Scheduler passes schedulerDb; request callers already carry school context. */
export async function reconcileSupervisionActivityReports(options: BatchOptions = {}, conn: typeof db = db): Promise<number> {
  const clock = options.clock || (options.now ? () => options.now! : () => new Date());
  const now = clock();
  if (!supervisionActivityReportingEnabled(now)) return 0;
  const limit = Math.max(1, Math.min(500, options.limit || 100));
  // Unfinished reports are first so a busy school cannot starve ended work.
  const pending = await conn.select({ contextId: segments.contextId, schoolId: segments.schoolId }).from(segments)
    .where(and(eq(segments.state, "active"), options.schoolId ? eq(segments.schoolId, options.schoolId) : undefined))
    .orderBy(asc(segments.updatedAt), asc(segments.id)).limit(limit);
  const untracked = await conn.select({ contextId: contexts.id, schoolId: contexts.schoolId }).from(contexts)
    .where(and(eq(contexts.status, "active"), gt(contexts.endsAt, now), lte(contexts.startsAt, now),
      options.schoolId ? eq(contexts.schoolId, options.schoolId) : undefined,
      sql`EXISTS (SELECT 1 FROM ${assignments} WHERE ${assignments.schoolId}=${contexts.schoolId} AND ${assignments.contextId}=${contexts.id} AND ${assignments.releasedAt} IS NULL AND ${assignments.assignedAt}<=${now.toISOString()})`,
      sql`NOT EXISTS (SELECT 1 FROM ${segments} WHERE ${segments.schoolId}=${contexts.schoolId} AND ${segments.contextId}=${contexts.id})`))
    .orderBy(asc(contexts.createdAt), asc(contexts.id)).limit(limit);
  const candidates = [...new Map([...pending, ...untracked].map((row) => [`${row.schoolId}:${row.contextId}`, row])).values()];
  for (const row of candidates) {
    await conn.transaction(async (tx) => {
      await syncSupervisionActivityReports({ schoolId: row.schoolId, contextIds: [row.contextId], clock }, tx as unknown as typeof db);
      // Fair reconciliation ordering for contexts whose details did not change.
      const reconciledAt = clock();
      await tx.update(segments).set({ updatedAt: reconciledAt }).where(and(eq(segments.schoolId, row.schoolId),
        eq(segments.contextId, row.contextId), eq(segments.state, "active"), lte(segments.windowStart, reconciledAt)));
    });
  }
  return candidates.length;
}

/** Retain only a non-PII context/window tombstone to prevent reconstruction. */
export async function purgeExpiredSupervisionActivityReports(options: BatchOptions = {}, conn: typeof db = db): Promise<number> {
  const now = options.now || new Date();
  if (!supervisionActivityReportingEnabled(now)) return 0;
  let cutoff = options.cutoff;
  if (!cutoff && options.schoolId) {
    const [policy] = await conn.select({ retentionHours: settings.retentionHours }).from(settings).where(eq(settings.schoolId, options.schoolId)).limit(1);
    cutoff = new Date(now.getTime() - parseClasspilotRetentionDays(policy?.retentionHours) * 86_400_000);
  }
  const candidates = await conn.select({ id: segments.id, schoolId: segments.schoolId }).from(segments)
    .where(and(or(lte(segments.expiresAt, now), cutoff ? lte(segments.windowEnd, cutoff) : supervisionCurrentRetentionExpired(now)),
      isNull(segments.detailExpiredAt), options.schoolId ? eq(segments.schoolId, options.schoolId) : undefined))
    .orderBy(asc(segments.expiresAt), asc(segments.id)).limit(Math.max(1, Math.min(500, options.limit || 100)));
  for (const row of candidates) {
    await conn.transaction(async (tx) => {
      const [report] = await tx.select().from(segments).where(and(eq(segments.schoolId, row.schoolId), eq(segments.id, row.id))).for("update");
      if (!report || report.detailExpiredAt) return;
      let schoolCutoff = cutoff;
      if (!schoolCutoff) {
        const [policy] = await tx.select({ retentionHours: settings.retentionHours }).from(settings).where(eq(settings.schoolId, row.schoolId)).limit(1);
        schoolCutoff = new Date(now.getTime() - parseClasspilotRetentionDays(policy?.retentionHours) * 86_400_000);
      }
      if (!supervisionReportPastRetention(report, now, schoolCutoff)) return;
      await tx.delete(details).where(and(eq(details.schoolId, row.schoolId), eq(details.reportId, row.id)));
      await tx.update(deliveries).set({ state: "expired", recipientStaffId: null, recipientEmail: null, recipientName: null,
        leaseOwner: null, leaseExpiresAt: null, submissionStartedAt: null, providerMessageId: null, lastError: "report_expired", updatedAt: now,
      }).where(and(eq(deliveries.schoolId, row.schoolId), eq(deliveries.reportId, row.id)));
      await tx.update(segments).set({ state: "expired", staffId: null, staffNameSnapshot: null, contextNameSnapshot: null,
        trackingPolicy: null, summary: null, lastError: null, leaseOwner: null, leaseExpiresAt: null,
        detailExpiredAt: now, updatedAt: now,
      }).where(and(eq(segments.schoolId, row.schoolId), eq(segments.id, row.id)));
    });
  }
  return candidates.length;
}
