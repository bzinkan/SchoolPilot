import { and, eq, gte, or } from "drizzle-orm";
import { db } from "../db.js";
import { schools } from "../schema/core.js";
import { groups, groupTeachers, teachingSessions, classpilotSessionStaff } from "../schema/classpilot.js";
import { classpilotSchoolSchedules } from "../schema/classpilotScheduling.js";
import { localDateInTimeZone, localDateTimeUtc, addLocalDays } from "../util/schoolTime.js";
import { getSchoolSchedulingContext } from "./classpilotScheduling.js";
import { resolveClassBaseWindow } from "./classpilotSchedulingRules.js";
import { getApprovedScheduleChangeLegsForSchoolDate } from "./classpilotScheduleChanges.js";
import { profileSupervisionOutcomeKey } from "./classpilotScheduleProfileSupervision.js";
import { isScheduleProfileBlockCancelled } from "./classpilotScheduleProfileModel.js";
import type { ClasspilotDashboardActivity } from "./classpilotDashboardActivity.js";

export type PlannedActivity = { id: string; source: "scheduled_class" | "scheduled_testing" | "scheduled_coverage"; name: string;
  startsAt: string; endsAt: string; status: "pending" | "waiting" };
const limit = 500;

/** Display-only schedule projection. It cannot issue authority or create sessions. */
export async function getDashboardSchedule(schoolId: string, viewerId: string,
  current: ClasspilotDashboardActivity | null, now: Date, database: typeof db = db, scheduledContexts: PlannedActivity[] = []) {
  const [schoolRows, scheduling, personalRows, scheduleRows] = await Promise.all([
    database.select({ timezone: schools.schoolTimezone }).from(schools).where(eq(schools.id, schoolId)).limit(1),
    getSchoolSchedulingContext(schoolId, database),
    database.selectDistinct({ group: groups }).from(groups).leftJoin(groupTeachers, eq(groupTeachers.groupId, groups.id))
      .where(and(eq(groups.schoolId, schoolId), eq(groups.status, "active"), eq(groups.scheduleEnabled, true),
        or(eq(groups.teacherId, viewerId), eq(groupTeachers.teacherId, viewerId)))).limit(limit + 1),
    database.select({ outcomes: classpilotSchoolSchedules.profileActivationOutcomes }).from(classpilotSchoolSchedules)
      .where(eq(classpilotSchoolSchedules.schoolId, schoolId)).limit(1),
  ]);
  if (!schoolRows[0] || personalRows.length > limit) throw new Error("DASHBOARD_SCHEDULE_INCOMPLETE");
  const timezone = schoolRows[0].timezone;
  const today = localDateInTimeZone(now, timezone);
  const recorded = await database.select({ session: teachingSessions }).from(teachingSessions)
    .innerJoin(classpilotSessionStaff, and(eq(classpilotSessionStaff.schoolId, schoolId),
      eq(classpilotSessionStaff.teachingSessionId, teachingSessions.id), eq(classpilotSessionStaff.staffId, viewerId)))
    .where(and(eq(teachingSessions.schoolId, schoolId), gte(teachingSessions.scheduledDate, today))).limit(limit + 1);
  if (recorded.length > limit) throw new Error("DASHBOARD_SCHEDULE_INCOMPLETE");
  const candidates: PlannedActivity[] = [...scheduledContexts];
  const frozen = new Set(recorded.map(({ session }) => `${session.scheduledDate}:${session.groupId}`));
  for (const { session } of recorded) {
    if (session.endTime || session.scheduledState !== "active" || !session.scheduledStartAt || !session.scheduledEndAt || session.scheduledEndAt <= now) continue;
    candidates.push({ id: session.id, source: "scheduled_class", name: session.classNameSnapshot || "Scheduled class",
      startsAt: session.scheduledStartAt.toISOString(), endsAt: session.scheduledEndAt.toISOString(),
      status: session.sessionMode === "scheduled_report" ? "waiting" : "pending" });
  }
  // A bounded week finds the next normal meeting across weekends. Future applied
  // testing remains visible even when its date lies beyond this normal-class horizon.
  for (let offset = 0; offset < 8; offset++) {
    const date = addLocalDays(today, offset);
    const legs = await getApprovedScheduleChangeLegsForSchoolDate({ schoolId, scheduledDate: date, dbInstance: database });
    const pairs = new Map<string, number>();
    for (const leg of legs) pairs.set(leg.swapId, (pairs.get(leg.swapId) ?? 0) + 1);
    if ([...pairs.values()].some((count) => count !== 2)) throw new Error("DASHBOARD_SCHEDULE_INCOMPLETE");
    const byClass = new Map(legs.map((leg) => [leg.groupId, leg]));
    for (const { group } of personalRows) {
      if (frozen.has(`${date}:${group.id}`) || group.scheduleSkippedDate === date) continue;
      const window = resolveClassBaseWindow(group, date, scheduling.config, scheduling.calendar);
      if (!window) continue;
      const leg = byClass.get(group.id);
      const start = localDateTimeUtc(date, leg?.effectiveStartTime ?? window.startTime, timezone);
      const end = localDateTimeUtc(date, leg?.effectiveEndTime ?? window.endTime, timezone);
      if (end <= now) continue;
      candidates.push({ id: `${date}:${group.id}`, source: "scheduled_class", name: group.name,
        startsAt: start.toISOString(), endsAt: end.toISOString(), status: start <= now ? "waiting" : "pending" });
    }
  }
  for (const application of scheduling.config.profileApplications ?? []) {
    if (application.status !== "scheduled") continue;
    for (const window of application.testingWindows) {
      if (window.assignedStaffId !== viewerId || !window.studentIds.length) continue;
      // A withdrawn block is not a pending assignment and owns no boundary.
      if (isScheduleProfileBlockCancelled(application, window.date, window.blockId)) continue;
      const receipt = scheduleRows[0]?.outcomes[profileSupervisionOutcomeKey(application.id, window.date, window.blockId)];
      // A recorded start, early release or failure must not become a new pending start.
      if (receipt) continue;
      const start = localDateTimeUtc(window.date, window.startTime, timezone);
      const end = localDateTimeUtc(window.date, window.endTime, timezone);
      if (end <= now) continue;
      candidates.push({ id: `${application.id}:${window.date}:${window.blockId}`, source: "scheduled_testing", name: window.name,
        startsAt: start.toISOString(), endsAt: end.toISOString(), status: start <= now ? "waiting" : "pending" });
    }
  }
  return selectDashboardSchedule(candidates, current, now, localDateTimeUtc(addLocalDays(today, 1), "00:00", timezone));
}

export function selectDashboardSchedule(candidates: PlannedActivity[], current: Pick<ClasspilotDashboardActivity, "id" | "endsAt" | "source"> | null,
  now: Date, midnight: Date) {
  const relevant = candidates.filter((item) => item.id !== current?.id && Date.parse(item.endsAt) > now.getTime());
  const currentEnd = current?.endsAt ? Date.parse(current.endsAt) : now.getTime();
  const next = relevant.filter((item) => Date.parse(item.startsAt) > now.getTime() || Date.parse(item.endsAt) > currentEnd)
    .map((item) => ({ ...item, startsAt: Date.parse(item.startsAt) > now.getTime() ? item.startsAt
      : new Date(Math.max(Date.parse(item.startsAt), currentEnd)).toISOString() }))
    .sort((a, b) => a.startsAt.localeCompare(b.startsAt)
      || Number(b.source === "scheduled_testing") - Number(a.source === "scheduled_testing") || a.id.localeCompare(b.id))[0] ?? null;
  const boundaries = [midnight.getTime(), ...(current?.endsAt ? [Date.parse(current.endsAt)] : []),
    ...relevant.flatMap((item) => [Date.parse(item.startsAt), Date.parse(item.endsAt)])].filter((value) => value > now.getTime());
  // An unactivated current window is explicit pending work, never active control.
  if (relevant.some((item) => Date.parse(item.startsAt) <= now.getTime()
    && (!current || (item.source === "scheduled_testing" && current.source !== "scheduled_testing")))) boundaries.push(now.getTime() + 2_000);
  return { next, nextBoundaryAt: new Date(Math.min(...boundaries)).toISOString() };
}
