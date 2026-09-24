type ObservationDate = Date | string | null | undefined;

export type ClasspilotObservationSession = {
  sessionMode?: string | null;
  endTime?: ObservationDate;
  startTime?: ObservationDate;
  rosterSnapshotCompletedAt?: ObservationDate;
  scheduledDate?: string | null;
  scheduledState?: string | null;
  scheduledStartAt?: ObservationDate;
  scheduledEndAt?: ObservationDate;
};

function timestamp(value: ObservationDate): number {
  return value instanceof Date ? value.getTime() : typeof value === "string" && value.trim()
    ? Date.parse(value) : Number.NaN;
}

/**
 * A frozen occurrence is observable during its real bell window even before
 * any assigned teacher connects. This is read authority only: never promote
 * the occurrence or use it as command/control ownership.
 */
export function classpilotReportingObservationSessionIsCurrent(
  session: ClasspilotObservationSession | null | undefined,
  now = new Date(),
): boolean {
  if (!session || session.sessionMode !== "scheduled_report" || session.endTime
    || session.scheduledState !== "active" || !session.scheduledDate
    || !Number.isFinite(timestamp(session.rosterSnapshotCompletedAt))) return false;
  const start = timestamp(session.scheduledStartAt);
  const end = timestamp(session.scheduledEndAt);
  const current = now.getTime();
  return Number.isFinite(current) && Number.isFinite(start) && Number.isFinite(end)
    && start <= current && current < end;
}

/** Current screenshot/read lifetime; caller must separately authorize staff. */
export function classpilotObservationSessionIsCurrent(
  session: ClasspilotObservationSession | null | undefined,
  now = new Date(),
): boolean {
  if (classpilotReportingObservationSessionIsCurrent(session, now)) return true;
  if (!session || session.sessionMode !== "live" || session.endTime
    || !Number.isFinite(timestamp(session.rosterSnapshotCompletedAt))) return false;
  const current = now.getTime();
  const start = timestamp(session.startTime);
  return Number.isFinite(current) && Number.isFinite(start) && start <= current
    && (session.scheduledEndAt == null || timestamp(session.scheduledEndAt) > current);
}

/** Reporting occurrences are exclusively administrator read-only surfaces. */
export function canObserveClasspilotSession(options: {
  session: ClasspilotObservationSession | null | undefined;
  administrator: boolean;
  assignedStaff: boolean;
  now?: Date;
}): boolean {
  if (!classpilotObservationSessionIsCurrent(options.session, options.now)) return false;
  return options.administrator || (options.session?.sessionMode === "live" && options.assignedStaff);
}
