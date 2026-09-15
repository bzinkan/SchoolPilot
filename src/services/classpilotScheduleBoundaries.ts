import { randomUUID } from "node:crypto";
import { and, eq, gt, isNull, lte } from "drizzle-orm";
import { isScheduledClassroomEnabled } from "../config/classpilotScheduledClassroom.js";
import { classpilotSchoolSchedules } from "../schema/classpilotScheduling.js";
import { groups, teachingSessions, classpilotSupervisionContexts } from "../schema/classpilot.js";
import { schools } from "../schema/core.js";
import { localDateInTimeZone, localDateTimeUtc, addLocalDays } from "../util/schoolTime.js";
import { schedulerDb, schedulerPool } from "./schedulerDb.js";
import { getSchoolSchedulingContext } from "./classpilotScheduling.js";
import { resolveClassBaseWindow } from "./classpilotSchedulingRules.js";
import { getApprovedScheduleChangeLegsForSchoolDate } from "./classpilotScheduleChanges.js";
import { getClasspilotGroupsReadyAtEffectiveWindow, processScheduledClassAutoStart, expireScheduledClassConflictsForSchool } from "./classpilotScheduledStart.js";
import { reconcileScheduledProfileSupervision, profileSupervisionOutcomeKey } from "./classpilotScheduleProfileSupervision.js";
import { releaseExpiredClasspilotSupervisionContexts } from "./storage.js";
import { finalizeClasspilotSession } from "./classpilotSessionLifecycle.js";
import { syncClasspilotControlStatesToActiveDevices } from "./classpilotControlStateDelivery.js";
import { publishClasspilotCoverageSummaryUpdated } from "./classpilotCoverageSummary.js";
import { flushClasspilotLifecyclePushes } from "./classpilotLifecyclePushes.js";
import errorMonitor from "./errorMonitor.js";

export const SCHEDULE_BOUNDARY_POLL_MS = 1_000;
const RETRY_MS = 2_000;
const LEASE_MS = 30_000;
const MAX_SCHOOLS = 4;
const MAX_DAY_CLASSES = 2_000;
const MAX_TRANSITIONS = 100;
let occupiedBoundarySlots = 0;

export type ScheduleBoundaryLease = { schoolId: string; generation: number; dueAt: Date; owner: string };

/** Pure deadline policy; an overdue item stays due rather than waiting for tomorrow. */
export function nextScheduleBoundary(now: Date, candidates: Date[], midnight: Date, incomplete = false): Date {
  if (incomplete) return new Date(now.getTime() + RETRY_MS);
  return new Date(Math.min(midnight.getTime(), ...candidates.map((value) => value.getTime())
    .filter((value) => Number.isFinite(value) && value > now.getTime())));
}

export async function claimDueScheduleBoundaries(now: Date, capacity = MAX_SCHOOLS): Promise<ScheduleBoundaryLease[]> {
  const owner = randomUUID();
  const result = await schedulerPool.query<{ school_id: string; boundary_generation: number; next_boundary_at: Date }>(`
    WITH due AS (
      SELECT school_id FROM classpilot_school_schedules
      WHERE next_boundary_at <= $1 AND (boundary_lease_until IS NULL OR boundary_lease_until <= $1)
      ORDER BY next_boundary_at, school_id LIMIT $2 FOR UPDATE SKIP LOCKED
    )
    UPDATE classpilot_school_schedules AS s
      SET boundary_lease_owner=$3, boundary_lease_until=$1::timestamptz + $4::integer * interval '1 millisecond'
      FROM due WHERE s.school_id=due.school_id
      RETURNING s.school_id, s.boundary_generation, s.next_boundary_at`, [now, Math.max(0, Math.min(MAX_SCHOOLS, capacity)), owner, LEASE_MS]);
  return result.rows.map((row) => ({ schoolId: row.school_id, generation: row.boundary_generation, dueAt: row.next_boundary_at, owner }));
}

export async function completeScheduleBoundary(lease: ScheduleBoundaryLease, next: Date): Promise<void> {
  // A schedule mutation during reconciliation increments generation. Its wake-up wins.
  await schedulerPool.query(`UPDATE classpilot_school_schedules
    SET next_boundary_at=CASE WHEN boundary_generation=$3 THEN $4 ELSE LEAST(next_boundary_at, now()) END,
        boundary_lease_owner=NULL, boundary_lease_until=NULL
    WHERE school_id=$1 AND boundary_lease_owner=$2`, [lease.schoolId, lease.owner, lease.generation, next]);
}

/** Recovery discovery is deliberately minute-paced, not part of the one-second lane. */
export async function discoverScheduleBoundarySchools(): Promise<void> {
  if (process.env.CLASSPILOT_SCHEDULED_CLASSROOM_MODE !== "on") return;
  await schedulerPool.query(`INSERT INTO classpilot_school_schedules(school_id,config,next_boundary_at)
    SELECT s.id,'{}'::jsonb,now() FROM schools s WHERE s.deleted_at IS NULL
    AND NOT EXISTS (SELECT 1 FROM classpilot_school_schedules q WHERE q.school_id=s.id)
    ORDER BY s.id LIMIT 100 ON CONFLICT(school_id) DO NOTHING`);
  // Recover abandoned leases and configuration flag changes without changing schedule revisions.
  await schedulerPool.query(`UPDATE classpilot_school_schedules SET next_boundary_at=now()
    WHERE next_boundary_at IS NULL OR (boundary_lease_until < now() AND boundary_lease_owner IS NOT NULL)`);
}

export async function computeNextSchoolScheduleBoundary(schoolId: string, now: Date): Promise<Date> {
  const [schoolRows, context, classRows, sessionRows, supervisionRows, scheduleRows] = await Promise.all([
    schedulerDb.select({ timezone: schools.schoolTimezone }).from(schools).where(eq(schools.id, schoolId)).limit(1),
    getSchoolSchedulingContext(schoolId, schedulerDb),
    schedulerDb.select().from(groups).where(and(eq(groups.schoolId, schoolId), eq(groups.status, "active"), eq(groups.scheduleEnabled, true))).limit(MAX_DAY_CLASSES + 1),
    schedulerDb.select().from(teachingSessions).where(and(eq(teachingSessions.schoolId, schoolId), isNull(teachingSessions.endTime), eq(teachingSessions.scheduledState, "active"))).limit(MAX_DAY_CLASSES + 1),
    schedulerDb.select({ endsAt: classpilotSupervisionContexts.endsAt }).from(classpilotSupervisionContexts)
      .where(and(eq(classpilotSupervisionContexts.schoolId, schoolId), eq(classpilotSupervisionContexts.status, "active"))).limit(MAX_DAY_CLASSES + 1),
    schedulerDb.select({ outcomes: classpilotSchoolSchedules.profileActivationOutcomes }).from(classpilotSchoolSchedules)
      .where(eq(classpilotSchoolSchedules.schoolId, schoolId)).limit(1),
  ]);
  if (!schoolRows[0]) throw new Error("SCHEDULE_BOUNDARY_SCHOOL_UNAVAILABLE");
  if ([classRows, sessionRows, supervisionRows].some((rows) => rows.length > MAX_DAY_CLASSES)) throw new Error("SCHEDULE_BOUNDARY_ANALYSIS_LIMIT");
  const timezone = schoolRows[0].timezone;
  const date = localDateInTimeZone(now, timezone);
  const midnight = localDateTimeUtc(addLocalDays(date, 1), "00:00", timezone);
  const windows: Date[] = [];
  let incomplete = false;
  const approved = await getApprovedScheduleChangeLegsForSchoolDate({ schoolId, scheduledDate: date, dbInstance: schedulerDb });
  const pairCounts = new Map<string, number>();
  for (const leg of approved) pairCounts.set(leg.swapId, (pairCounts.get(leg.swapId) ?? 0) + 1);
  if ([...pairCounts.values()].some((count) => count !== 2)) throw new Error("SCHEDULE_BOUNDARY_CHANGE_INCOMPLETE");
  const approvedByGroup = new Map(approved.map((leg) => [leg.groupId, leg]));
  const frozen = new Set(sessionRows.filter((row) => row.scheduledDate === date).map((row) => row.groupId));
  for (const session of sessionRows) {
    if (session.scheduledEndAt) {
      windows.push(session.scheduledEndAt);
      if (session.scheduledEndAt <= now) incomplete = true;
    }
    if (session.scheduledStartAt) windows.push(session.scheduledStartAt);
    // A teacher may reconnect during a reporting-only occurrence.
    if (session.sessionMode === "scheduled_report" && session.scheduledStartAt && session.scheduledStartAt <= now && session.scheduledEndAt && session.scheduledEndAt > now) incomplete = true;
  }
  for (const group of classRows) {
    if (frozen.has(group.id) || group.scheduleSkippedDate === date) continue;
    const base = resolveClassBaseWindow(group, date, context.config, context.calendar);
    if (!base) continue;
    const leg = approvedByGroup.get(group.id);
    windows.push(localDateTimeUtc(date, leg?.effectiveStartTime ?? base.startTime, timezone));
    windows.push(localDateTimeUtc(date, leg?.effectiveEndTime ?? base.endTime, timezone));
  }
  for (const supervision of supervisionRows) {
    windows.push(supervision.endsAt);
    if (supervision.endsAt <= now) incomplete = true;
  }
  for (const application of context.config.profileApplications ?? []) {
    if (application.status !== "scheduled") continue;
    for (const window of application.testingWindows) {
      const start = localDateTimeUtc(window.date, window.startTime, timezone);
      const key = profileSupervisionOutcomeKey(application.id, window.date, window.blockId);
      if (!scheduleRows[0]?.outcomes[key]) {
        windows.push(start);
        if (start <= now) incomplete = true;
      }
    }
  }
  return nextScheduleBoundary(now, windows, midnight, incomplete);
}

/** Fast lifecycle pass: no historical roster backfills, report materialization or email delivery. */
export async function reconcileSchoolScheduleBoundary(schoolId: string, now: Date): Promise<void> {
  const due = await schedulerDb.select().from(teachingSessions).where(and(eq(teachingSessions.schoolId, schoolId),
    eq(teachingSessions.scheduledState, "active"), isNull(teachingSessions.endTime), lte(teachingSessions.scheduledEndAt, now)))
    .orderBy(teachingSessions.scheduledEndAt, teachingSessions.id).limit(MAX_TRANSITIONS + 1);
  for (const session of due.slice(0, MAX_TRANSITIONS)) {
    await finalizeClasspilotSession({ schoolId, sessionId: session.id, reason: "scheduled_end", finalizedAt: session.scheduledEndAt ?? now, dbInstance: schedulerDb });
  }
  const released = await releaseExpiredClasspilotSupervisionContexts({ schoolId, now, limit: MAX_TRANSITIONS }, schedulerDb);
  if (released.length) await syncClasspilotControlStatesToActiveDevices(schoolId, [...new Set(released.map((row) => row.studentId))]);
  await reconcileScheduledProfileSupervision(now, schoolId, schedulerDb);
  const [school] = await schedulerDb.select({ timezone: schools.schoolTimezone }).from(schools).where(eq(schools.id, schoolId)).limit(1);
  if (!school) throw new Error("SCHEDULE_BOUNDARY_SCHOOL_UNAVAILABLE");
  const date = localDateInTimeZone(now, school.timezone);
  const time = now.toLocaleTimeString("en-GB", { timeZone: school.timezone, hour12: false, hour: "2-digit", minute: "2-digit" });
  await expireScheduledClassConflictsForSchool({ schoolId, scheduledDate: date, currentTimeHHMM: time, dbInstance: schedulerDb });
  const ready = await getClasspilotGroupsReadyAtEffectiveWindow({ schoolId, scheduledDate: date, currentTimeHHMM: time, dbInstance: schedulerDb });
  const frozenReports = await schedulerDb.select({ group: groups, scheduledDate: teachingSessions.scheduledDate })
    .from(teachingSessions).innerJoin(groups, and(eq(groups.id, teachingSessions.groupId), eq(groups.schoolId, schoolId)))
    .where(and(eq(teachingSessions.schoolId, schoolId), eq(teachingSessions.scheduledState, "active"),
      eq(teachingSessions.sessionMode, "scheduled_report"), isNull(teachingSessions.endTime),
      lte(teachingSessions.scheduledStartAt, now), gt(teachingSessions.scheduledEndAt, now))).limit(MAX_DAY_CLASSES + 1);
  const readyById = new Map(ready.map((group) => [group.id, { group, scheduledDate: date }]));
  for (const frozen of frozenReports) {
    if (frozen.scheduledDate) readyById.set(frozen.group.id, { group: frozen.group, scheduledDate: frozen.scheduledDate });
  }
  if (readyById.size > MAX_DAY_CLASSES || frozenReports.length > MAX_DAY_CLASSES) throw new Error("SCHEDULE_BOUNDARY_ANALYSIS_LIMIT");
  const candidates = [...readyById.values()];
  // Existing occurrences still get the locked presence/eligibility check; no synthetic sessions.
  for (let offset = 0; offset < candidates.length; offset += 4) {
    const settled = await Promise.allSettled(candidates.slice(offset, offset + 4).map((candidate) => processScheduledClassAutoStart({ ...candidate, now, dbInstance: schedulerDb })));
    const failure = settled.find((result): result is PromiseRejectedResult => result.status === "rejected");
    if (failure) throw failure.reason;
  }
  await flushClasspilotLifecyclePushes();
  publishClasspilotCoverageSummaryUpdated(schoolId);
  if (due.length > MAX_TRANSITIONS) throw new Error("SCHEDULE_BOUNDARY_WORK_REMAINING");
}

export async function runDueClasspilotScheduleBoundaries(now = new Date()): Promise<void> {
  if (process.env.CLASSPILOT_SCHEDULED_CLASSROOM_MODE !== "on") return;
  const capacity = MAX_SCHOOLS - occupiedBoundarySlots;
  if (capacity <= 0) return;
  // Reserve before the asynchronous claim. A slow school holds only its own
  // slot; subsequent ticks refill slots completed by other schools.
  occupiedBoundarySlots += capacity;
  let leases: ScheduleBoundaryLease[];
  try { leases = await claimDueScheduleBoundaries(now, capacity); }
  catch (error) { occupiedBoundarySlots -= capacity; throw error; }
  occupiedBoundarySlots -= capacity - leases.length;
  const settled = await Promise.allSettled(leases.map(async (lease) => {
    try {
    let next = new Date(now.getTime() + RETRY_MS);
    if (!isScheduledClassroomEnabled(lease.schoolId)) {
      await completeScheduleBoundary(lease, new Date(now.getTime() + 60_000));
      return;
    }
    // Renew while a slow but live worker owns the school; a crashed worker loses this lease.
    let renewalPending: Promise<void> | null = null;
    const renewal = setInterval(() => {
      if (renewalPending) return;
      renewalPending = schedulerPool.query(`UPDATE classpilot_school_schedules SET boundary_lease_until=now()+interval '30 seconds'
        WHERE school_id=$1 AND boundary_lease_owner=$2`, [lease.schoolId, lease.owner]).then(() => undefined, () => undefined)
        .finally(() => { renewalPending = null; });
    }, LEASE_MS / 3);
    try {
      await reconcileSchoolScheduleBoundary(lease.schoolId, new Date());
      next = await computeNextSchoolScheduleBoundary(lease.schoolId, new Date());
      console.log(JSON.stringify({ event: "classpilot_schedule_boundary", outcome: "reconciled", latenessMs: Math.max(0, Date.now() - lease.dueAt.getTime()) }));
    } catch (error) {
      errorMonitor.trackError("scheduler_failure", error instanceof Error ? error : new Error("SCHEDULE_BOUNDARY_FAILED"), { job: "classpilotScheduleBoundary" });
    } finally {
      clearInterval(renewal);
      await renewalPending;
      await completeScheduleBoundary(lease, next);
    }
    } finally { occupiedBoundarySlots -= 1; }
  }));
  const failure = settled.find((result): result is PromiseRejectedResult => result.status === "rejected");
  if (failure) throw failure.reason;
}
