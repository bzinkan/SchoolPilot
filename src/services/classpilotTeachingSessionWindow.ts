import type { TeachingSession } from "../schema/classpilot.js";

type SessionWindow = Pick<TeachingSession, "startTime" | "scheduledEndAt"> & { manualExpiresAt?: Date | null };

export function classpilotTeachingSessionDeadline(session: SessionWindow): Date {
  return new Date(Math.min(session.startTime.getTime() + 12 * 3600_000,
    session.scheduledEndAt?.getTime() ?? Infinity, session.manualExpiresAt?.getTime() ?? Infinity));
}

/** Match the extension's class lifetime even before delayed finalization runs. */
export function classpilotTeachingSessionIsCurrent(
  session: Pick<TeachingSession, "sessionMode" | "startTime" | "endTime" | "scheduledEndAt"> & { manualExpiresAt?: Date | null },
  now: Date = new Date(),
): boolean {
  const currentAt = now.getTime();
  const startAt = session.startTime.getTime();
  return session.sessionMode === "live" && !session.endTime
    && startAt <= currentAt && classpilotTeachingSessionDeadline(session).getTime() > currentAt;
}
