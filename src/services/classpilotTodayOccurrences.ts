import { and, eq, inArray, sql } from "drizzle-orm";
import { createHash, randomUUID } from "node:crypto";
import { db } from "../db.js";
import { classpilotTodayChanges, classpilotTodayOccurrences } from "../schema/classpilot.js";

export type TodayOccurrence = typeof classpilotTodayOccurrences.$inferSelect;

export function canonicalTodayOccurrenceId(row: TodayOccurrence): string | null {
  if (typeof row.source.preservedLegacySessionId === "string" && row.source.preservedLegacySessionId) return null;
  return typeof row.source.preservedOccurrenceId === "string" && row.source.preservedOccurrenceId
    ? row.source.preservedOccurrenceId : row.id;
}

/** Committed plans remain authoritative even while new requests are disabled. */
export async function loadClasspilotTodayOccurrences(options: {
  schoolId: string; scheduledDate: string; groupIds?: string[]; dbInstance?: typeof db;
}): Promise<Map<string, TodayOccurrence[]>> {
  if (options.groupIds?.length === 0) return new Map();
  const database = options.dbInstance ?? db;
  const rows = await database.select({ occurrence: classpilotTodayOccurrences }).from(classpilotTodayOccurrences)
    .innerJoin(classpilotTodayChanges, and(eq(classpilotTodayChanges.schoolId, classpilotTodayOccurrences.schoolId),
      eq(classpilotTodayChanges.id, classpilotTodayOccurrences.changeId), eq(classpilotTodayChanges.status, "applied")))
    .where(and(eq(classpilotTodayOccurrences.schoolId, options.schoolId),
      eq(classpilotTodayOccurrences.scheduledDate, options.scheduledDate),
      options.groupIds ? inArray(classpilotTodayOccurrences.groupId, options.groupIds) : undefined))
    .limit(20_001);
  if (rows.length > 20_000) throw Object.assign(new Error("Today's schedule is too large to resolve safely."), {
    status: 409, code: "TODAY_SCHEDULE_ANALYSIS_LIMIT",
  });
  return latestTodayOccurrenceGenerations(rows.map(row => row.occurrence));
}

export function latestTodayOccurrenceGenerations(rows: TodayOccurrence[]): Map<string, TodayOccurrence[]> {
  const result = new Map<string, TodayOccurrence[]>();
  for (const row of rows) {
    const existing = result.get(row.groupId);
    if (!existing || existing[0]!.generation < row.generation) result.set(row.groupId, [row]);
    else if (existing[0]!.generation === row.generation) existing.push(row);
  }
  for (const rows of result.values()) rows.sort((a, b) =>
    (a.scheduledStartAt?.getTime() ?? 0) - (b.scheduledStartAt?.getTime() ?? 0) || a.id.localeCompare(b.id));
  return result;
}

export function todayOccurrenceWindow(row: TodayOccurrence) {
  if (row.kind !== "meeting" || !row.scheduledStartAt || !row.scheduledEndAt) return null;
  const localTime = (date: Date) => date.toLocaleString("en-GB", {
    timeZone: row.timezoneSnapshot, hour: "2-digit", minute: "2-digit", hour12: false,
  }).replace(/^24:/, "00:");
  return {
    source: "today" as const, swapId: null, scheduledOccurrenceId: canonicalTodayOccurrenceId(row),
    preservedLegacySessionId: typeof row.source.preservedLegacySessionId === "string" ? row.source.preservedLegacySessionId : null,
    scheduledDate: row.scheduledDate, timeZone: row.timezoneSnapshot,
    blockStartTime: localTime(row.scheduledStartAt), blockEndTime: localTime(row.scheduledEndAt),
    scheduledStartAt: row.scheduledStartAt, scheduledEndAt: row.scheduledEndAt,
  };
}

export async function assertClasspilotTodayOccurrence(options: {
  schoolId: string; groupId: string; scheduledDate: string; scheduledOccurrenceId: string;
  scheduledStartAt?: Date; scheduledEndAt?: Date;
}, database: typeof db = db): Promise<TodayOccurrence> {
  const plan = await loadClasspilotTodayOccurrences({ ...options, groupIds: [options.groupId], dbInstance: database });
  const row = plan.get(options.groupId)?.find(row => canonicalTodayOccurrenceId(row) === options.scheduledOccurrenceId && row.kind === "meeting");
  if (!row || !row.scheduledStartAt || !row.scheduledEndAt
    || options.scheduledStartAt && row.scheduledStartAt.getTime() !== options.scheduledStartAt.getTime()
    || options.scheduledEndAt && row.scheduledEndAt.getTime() !== options.scheduledEndAt.getTime()) {
    throw Object.assign(new Error("Today's class schedule changed. Review it again in Teaching tools."), {
      status: 409, code: "TODAY_SCHEDULE_REVIEW_STALE",
    });
  }
  return row;
}

/** Admin recovery is a new ordered operation, even when its legacy date marker already matches. */
export async function recordClasspilotTodayManualRecovery(options: {
  schoolId: string; groupId: string; teacherId: string; className: string; actorId: string;
  scheduledDate: string; timezone: string; now: Date; cutoffAt: Date; expectedTodayRevision?: number;
}, database: typeof db): Promise<void> {
  const current = (await loadClasspilotTodayOccurrences({ ...options, groupIds: [options.groupId], dbInstance: database })).get(options.groupId);
  const revision = current?.[0]?.generation ?? 0;
  if (revision && options.expectedTodayRevision !== revision) throw Object.assign(
    new Error("Today's schedule changed. Review this administrator recovery again."), { status: 409, code: "TODAY_SCHEDULE_REVIEW_STALE" });
  const [maximum] = await database.select({ generation: sql<number>`coalesce(max(${classpilotTodayOccurrences.generation}), 0)` })
    .from(classpilotTodayOccurrences).where(and(eq(classpilotTodayOccurrences.schoolId, options.schoolId),
      eq(classpilotTodayOccurrences.scheduledDate, options.scheduledDate)));
  const generation = Number(maximum?.generation ?? 0) + 1;
  const operation = { kind: "admin_manual_today", groupId: options.groupId, priorGeneration: revision, at: options.now.toISOString() };
  const [change] = await database.insert(classpilotTodayChanges).values({ schoolId: options.schoolId,
    scheduledDate: options.scheduledDate, timezoneSnapshot: options.timezone, status: "applied", revision: 1, generation,
    requestedByUserId: options.actorId, appliedByUserId: options.actorId, appliedAt: options.now,
    idempotencyKey: `admin-recovery:${randomUUID()}`, requestHash: createHash("sha256").update(JSON.stringify(operation)).digest("hex"),
    reviewSnapshot: operation, planSnapshot: operation, affectedGroupIds: [options.groupId], cutoffAt: options.cutoffAt }).returning();
  if (!change) throw new Error("TODAY_SCHEDULE_RECOVERY_NOT_SAVED");
  await database.insert(classpilotTodayOccurrences).values({ schoolId: options.schoolId, changeId: change.id,
    scheduledDate: options.scheduledDate, groupId: options.groupId, generation, kind: "suppression", source: operation,
    primaryTeacherIdSnapshot: options.teacherId, classNameSnapshot: options.className, timezoneSnapshot: options.timezone });
  await database.execute(sql`INSERT INTO classpilot_school_schedules(school_id,config,revision,boundary_generation,next_boundary_at,updated_by)
    VALUES(${options.schoolId},'{}'::jsonb,1,1,${options.now},${options.actorId}) ON CONFLICT(school_id) DO UPDATE
    SET revision=classpilot_school_schedules.revision+1, boundary_generation=classpilot_school_schedules.boundary_generation+1,
      next_boundary_at=LEAST(coalesce(classpilot_school_schedules.next_boundary_at,${options.now}),${options.now}),
      updated_at=${options.now},updated_by=${options.actorId}`);
}
