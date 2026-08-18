import db from "../db.js";
import type { Group } from "../schema/classpilot.js";
import {
  assertNoApprovedFutureScheduleChange,
  assertActiveClasspilotScheduleChangeEntitlement,
  expirePendingClasspilotScheduleChangesForSchool,
  getClasspilotScheduleChangeNotificationContext,
  listPendingClasspilotScheduleChangeDatesForSchool,
  lockAndLoadEffectiveClasspilotScheduleContext,
  loadApprovedScheduleChangeLegsForSchoolDate,
  supersedePendingScheduleChangesForGroup,
} from "./storage.js";
import { localDateTimeUtc } from "../util/schoolTime.js";
import { runWithTenantContext } from "../middleware/tenantContext.js";
import { broadcastToTeachersLocal } from "../realtime/ws-broadcast.js";
import { publishWS } from "../realtime/ws-redis.js";
import { sendEmail } from "./email.js";

export type EffectiveClasspilotScheduleWindow = {
  source: "recurring" | "swap";
  swapId: string | null;
  scheduledDate: string;
  timeZone: string;
  blockStartTime: string;
  blockEndTime: string;
  scheduledStartAt: Date;
  scheduledEndAt: Date;
};

export type ApprovedClasspilotScheduleChangeLeg = {
  swapId: string;
  groupId: string;
  effectiveStartTime: string;
  effectiveEndTime: string;
};

export async function getApprovedScheduleChangeLegsForSchoolDate(options: {
  schoolId: string;
  scheduledDate: string;
  dbInstance?: typeof db;
}): Promise<ApprovedClasspilotScheduleChangeLeg[]> {
  return loadApprovedScheduleChangeLegsForSchoolDate(options);
}

export async function getEffectiveClasspilotScheduleWindow(options: {
  schoolId: string;
  group: Pick<
    Group,
    "id" | "scheduleEnabled" | "blockStartTime" | "blockEndTime"
  >;
  scheduledDate: string;
  timeZone: string;
  dbInstance?: typeof db;
}): Promise<EffectiveClasspilotScheduleWindow | null> {
  if (
    !options.group.scheduleEnabled ||
    !options.group.blockStartTime ||
    !options.group.blockEndTime
  ) {
    return null;
  }
  const approved = await getApprovedScheduleChangeLegsForSchoolDate({
    schoolId: options.schoolId,
    scheduledDate: options.scheduledDate,
    dbInstance: options.dbInstance,
  });
  const leg = approved.find((candidate) => candidate.groupId === options.group.id);
  const blockStartTime = leg?.effectiveStartTime ?? options.group.blockStartTime;
  const blockEndTime = leg?.effectiveEndTime ?? options.group.blockEndTime;
  return {
    source: leg ? "swap" : "recurring",
    swapId: leg?.swapId ?? null,
    scheduledDate: options.scheduledDate,
    timeZone: options.timeZone,
    blockStartTime,
    blockEndTime,
    scheduledStartAt: localDateTimeUtc(
      options.scheduledDate,
      blockStartTime,
      options.timeZone
    ),
    scheduledEndAt: localDateTimeUtc(
      options.scheduledDate,
      blockEndTime,
      options.timeZone
    ),
  };
}

export {
  assertActiveClasspilotScheduleChangeEntitlement,
  assertNoApprovedFutureScheduleChange,
  expirePendingClasspilotScheduleChangesForSchool,
  listPendingClasspilotScheduleChangeDatesForSchool,
  lockAndLoadEffectiveClasspilotScheduleContext,
  supersedePendingScheduleChangesForGroup,
};

export function emitClasspilotScheduleChangeMetric(
  metricName:
    | "ScheduleChangeMutation"
    | "ScheduleChangeConflict"
    | "ScheduleChangeCutoffDenied"
    | "ScheduleChangeRevisionConflict"
    | "ScheduleChangeExpired",
  dimensions: {
    Action?: string;
    Outcome?: string;
    Status?: string;
    Role?: string;
  } = {}
): void {
  const safeDimensions = Object.fromEntries(
    Object.entries(dimensions)
      .filter(([, value]) => typeof value === "string" && /^[a-z_]{1,40}$/.test(value))
  );
  const dimensionNames = ["Environment", ...Object.keys(safeDimensions)];
  console.log(JSON.stringify({
    _aws: {
      Timestamp: Date.now(),
      CloudWatchMetrics: [{
        Namespace: "SchoolPilot/ClassPilot",
        Dimensions: [dimensionNames],
        Metrics: [{ Name: metricName, Unit: "Count" }],
      }],
    },
    Environment: process.env.APP_ENV || process.env.NODE_ENV || "development",
    ...safeDimensions,
    [metricName]: 1,
  }));
}

export async function broadcastClasspilotScheduleChangeUpdate(options: {
  schoolId: string;
  changeId?: string;
  status?: string;
  scheduledDate?: string;
  revision?: number;
}): Promise<void> {
  const update = {
    type: "schedule-change-updated" as const,
    ...(options.changeId ? { changeId: options.changeId } : {}),
    ...(options.status ? { status: options.status } : {}),
    ...(options.scheduledDate ? { scheduledDate: options.scheduledDate } : {}),
    ...(options.revision !== undefined ? { revision: options.revision } : {}),
  };
  broadcastToTeachersLocal(options.schoolId, update);
  await publishWS({ kind: "staff", schoolId: options.schoolId }, update);
}

export function sendClasspilotScheduleChangeEmails(options: {
  scheduledDate: string;
  status: string;
  classNames: string[];
  recipientEmails: string[];
}): void {
  const classLabel = options.classNames.slice(0, 2).join(" and ") || "two classes";
  const subject = `ClassPilot schedule change: ${options.scheduledDate}`;
  const text = [
    `A ClassPilot schedule change for ${classLabel} is now ${options.status.replaceAll("_", " ")}.`,
    `Date: ${options.scheduledDate}`,
    "Open ClassPilot Schedule Changes to review the authoritative times and available actions.",
  ].join("\n");
  void Promise.allSettled(
    options.recipientEmails.map((to) =>
      sendEmail({ to, subject, text, customArgs: { messageType: "classpilot_schedule_change" } })
    )
  );
}

/**
 * Best-effort post-commit refresh and email delivery for automatic workflow
 * transitions caused by class, roster, calendar, membership, or entitlement
 * changes. Detached lookups establish a fresh tenant context so forced RLS
 * cannot turn a successful mutation into either a data leak or a silent miss.
 */
export async function announceClasspilotScheduleChangeIds(options: {
  schoolId: string;
  changeIds: string[];
  dbInstance?: typeof db;
}): Promise<void> {
  const changeIds = Array.from(new Set(options.changeIds.filter(Boolean))).sort();
  if (changeIds.length === 0) return;

  await broadcastClasspilotScheduleChangeUpdate({ schoolId: options.schoolId }).catch(
    (error) => {
      console.warn(
        "[ClassPilot schedule changes] Automatic realtime update failed:",
        (error as Error).message
      );
    }
  );

  const contexts = await Promise.allSettled(
    changeIds.map((changeId) => {
      const load = () =>
        getClasspilotScheduleChangeNotificationContext({
          schoolId: options.schoolId,
          changeId,
          ...(options.dbInstance ? { dbInstance: options.dbInstance } : {}),
        });
      return options.dbInstance
        ? load()
        : runWithTenantContext({ schoolId: options.schoolId }, load);
    })
  );
  for (const result of contexts) {
    if (result.status === "fulfilled" && result.value) {
      sendClasspilotScheduleChangeEmails(result.value);
    } else if (result.status === "rejected") {
      console.warn(
        "[ClassPilot schedule changes] Automatic notification lookup failed:",
        (result.reason as Error)?.message || "unknown error"
      );
    }
  }
}
