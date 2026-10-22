import { localDateInTimeZone, localDateTimeUtc } from "../util/schoolTime.js";
import { isScheduleProfileBlockCancelled, type ScheduleProfileApplication } from "./classpilotScheduleProfileModel.js";
import type { ProfileSupervisionOutcome } from "./classpilotScheduleProfileSupervision.js";

export type ActiveTestingGroup = {
  groupId: string;
  name: string;
  applicationId: string;
  blockId: string;
  date: string;
  startsAt: string;
  endsAt: string;
};

export type AvailableTestingContext = {
  applicationId: string;
  blockId: string;
  date: string;
  status: "active" | "ended";
  inWindow: boolean;
  studentIds: string[];
};

export type AvailableTestingProjection = {
  activeTestingGroups: Map<string, ActiveTestingGroup>;
  testingNextBoundaryAt: string | null;
  serverTime: string;
};

/** Display metadata only. Saved memberships and claim authority remain independent. */
export function projectAvailableTestingGroups(options: {
  applications: ScheduleProfileApplication[];
  outcomes: Record<string, Pick<ProfileSupervisionOutcome, "status">>;
  contexts: AvailableTestingContext[];
  visibleStudentGroups: ReadonlyMap<string, ReadonlySet<string>>;
  timeZone?: string | null;
  now: Date;
}): AvailableTestingProjection {
  const { now } = options;
  const today = localDateInTimeZone(now, options.timeZone);
  const contexts = new Map(options.contexts.map(context => [
    `${context.applicationId}:${context.date}:${context.blockId}`, context,
  ]));
  const matches = new Map<string, ActiveTestingGroup[]>();
  let nextBoundary = Number.POSITIVE_INFINITY;
  for (const application of options.applications) {
    for (const window of application.testingWindows) {
      if (window.date < today || isScheduleProfileBlockCancelled(application, window.date, window.blockId)) continue;
      const key = `${application.id}:${window.date}:${window.blockId}`;
      const receipt = options.outcomes[key];
      const context = contexts.get(key);
      // A started receipt without its active context is terminal, including early release.
      if (receipt && receipt.status !== "started") continue;
      if (context ? context.status !== "active" || !context.inWindow : receipt?.status === "started") continue;
      const studentIds = window.studentIds.filter(studentId =>
        options.visibleStudentGroups.get(studentId)?.has(window.coverageGroupId)
        && (!context || context.studentIds.includes(studentId))
      );
      if (!studentIds.length) continue;
      const startsAt = localDateTimeUtc(window.date, window.startTime, options.timeZone || "America/New_York");
      const endsAt = localDateTimeUtc(window.date, window.endTime, options.timeZone || "America/New_York");
      if (startsAt > now) nextBoundary = Math.min(nextBoundary, startsAt.getTime());
      if (endsAt > now) nextBoundary = Math.min(nextBoundary, endsAt.getTime());
      if (window.date !== today || now < startsAt || now >= endsAt) continue;
      const label: ActiveTestingGroup = { groupId: window.coverageGroupId, name: window.name,
        applicationId: application.id, blockId: window.blockId, date: window.date,
        startsAt: startsAt.toISOString(), endsAt: endsAt.toISOString() };
      for (const studentId of studentIds) {
        const existing = matches.get(studentId) ?? [];
        existing.push(label);
        matches.set(studentId, existing);
      }
    }
  }
  return {
    // Conflicting snapshots must not make the display guess which test is current.
    activeTestingGroups: new Map([...matches].flatMap(([studentId, labels]) =>
      labels.length === 1 ? [[studentId, labels[0]!] as const] : [])),
    testingNextBoundaryAt: Number.isFinite(nextBoundary) ? new Date(nextBoundary).toISOString() : null,
    serverTime: now.toISOString(),
  };
}
