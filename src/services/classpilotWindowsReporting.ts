import { and, eq, gt, inArray, isNull, lt, or, sql } from "drizzle-orm";
import type db from "../db.js";
import { classpilotWindowsBrowserEvents as events } from "../schema/classpilotWindowsHistory.js";
import { classpilotWindowsBrowsers as browsers, classpilotWindowsGuards as guards } from "../schema/classpilotWindows.js";

export type WindowsReportContext = { teachingSessionId?: string; supervisionContextId?: string };
const classificationText = (value: unknown): string | null => typeof value === "string" ? value : null;

/** Retained metadata remains reportable after the runtime feature is disabled. */
export async function getWindowsReportObservations(
  database: Pick<typeof db, "select">, schoolId: string, studentIds: string[], start: Date, end: Date,
  context: WindowsReportContext = {},
) {
  if (!studentIds.length) return [];
  // Clip each observation to its own immutable browser/guard lifetime before
  // report coverage unions sessions. A successor must not revive an old tail.
  const usageEnd = sql<Date>`least(${events.usageEndsAt}, ${events.observedAt} + interval '10 seconds',
    ${browsers.endedAt}, ${guards.endedAt}, ${guards.expiresAt}, ${guards.absoluteExpiresAt},
    ${end.toISOString()}::timestamptz)`.mapWith(events.usageEndsAt);
  const rows = await database.select({ id: events.id, studentId: events.studentId, authenticatedSessionId: events.browserId,
    timestamp: events.observedAt, usageEndsAt: usageEnd, activeTabUrl: events.activeTabUrl, classification: events.classification,
  }).from(events).innerJoin(browsers, and(eq(browsers.id, events.browserId),
    eq(browsers.schoolId, events.schoolId), eq(browsers.studentId, events.studentId)))
    .innerJoin(guards, and(eq(guards.id, browsers.guardId), eq(guards.schoolId, browsers.schoolId),
      eq(guards.studentId, browsers.studentId))).where(and(
    eq(events.schoolId, schoolId), inArray(events.studentId, studentIds), eq(events.browserFocused, true),
    sql`${events.observedAt} >= ${start.toISOString()}::timestamptz`, lt(events.observedAt, end),
    sql`${events.observedAt} >= greatest(${browsers.createdAt}, ${guards.createdAt})`,
    gt(usageEnd, events.observedAt),
    // A frozen scheduled report has roster/time authority before live classroom
    // control starts. Unscoped full-mode observations belong to that reporting
    // window; explicit ownership by another class or supervision never does.
    context.teachingSessionId ? or(eq(events.teachingSessionId, context.teachingSessionId),
      and(isNull(events.teachingSessionId), isNull(events.supervisionContextId))) : undefined,
    context.supervisionContextId ? eq(events.supervisionContextId, context.supervisionContextId) : undefined,
  )).orderBy(events.studentId, events.observedAt, events.id);
  // Existing URL/title classification is metadata; never synthesize an AI
  // decision, evidence identity or a device record for browser observations.
  return rows.map(({ classification, ...row }) => ({ ...row, aiCategory: classificationText(classification?.category),
    contentCategory: classificationText(classification?.contentCategory), teacherIntentSource: classificationText(classification?.teacherIntentSource),
    safetyAlert: classificationText(classification?.safetyAlert), observationSource: "windows_browser" as const }));
}

/** A guard can only renew before expiry; every retained lifetime is continuous.
 * Pairing starts browser eligibility, and either browser or guard termination ends it. */
export async function getWindowsReportSessions(
  database: Pick<typeof db, "select">, schoolId: string, studentIds: string[], start: Date, end: Date,
) {
  if (!studentIds.length) return [];
  const rows = await database.select({ id: browsers.id, studentId: browsers.studentId,
    startedAt: browsers.createdAt, guardStartedAt: guards.createdAt,
    browserEndedAt: browsers.endedAt, guardEndedAt: guards.endedAt,
    expiresAt: guards.expiresAt, absoluteExpiresAt: guards.absoluteExpiresAt,
    lastSeenAt: browsers.lastSeenAt,
  }).from(browsers).innerJoin(guards, and(eq(guards.schoolId, browsers.schoolId),
    eq(guards.id, browsers.guardId), eq(guards.studentId, browsers.studentId)))
    .where(and(eq(browsers.schoolId, schoolId), inArray(browsers.studentId, studentIds),
      lt(browsers.createdAt, end), gt(guards.expiresAt, start),
      sql`coalesce(${browsers.endedAt}, ${end.toISOString()}::timestamptz) > ${start.toISOString()}::timestamptz`,
      sql`coalesce(${guards.endedAt}, ${end.toISOString()}::timestamptz) > ${start.toISOString()}::timestamptz`))
    .orderBy(browsers.studentId, browsers.createdAt, browsers.id);
  return rows.flatMap(row => {
    const startedAt = new Date(Math.max(row.startedAt.getTime(), row.guardStartedAt.getTime(), start.getTime()));
    const endedAt = new Date(Math.min(end.getTime(), row.expiresAt.getTime(), row.absoluteExpiresAt.getTime(),
      row.browserEndedAt?.getTime() ?? Infinity, row.guardEndedAt?.getTime() ?? Infinity));
    return endedAt > startedAt ? [{ id: row.id, studentId: row.studentId,
      startedAt, endedAt, lastSeenAt: row.lastSeenAt }] : [];
  });
}
