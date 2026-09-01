import type { ClasspilotRealtimeBinding } from "./classpilotRealtimeStatus.js";

export type ClasspilotSsoReadinessSession = {
  id: string;
  studentId: string;
  deviceId: string;
  startedAt: Date;
  lastSeenAt: Date;
};

function compareReadinessSessions(
  left: ClasspilotSsoReadinessSession,
  right: ClasspilotSsoReadinessSession
): number {
  const lastSeenDifference = left.lastSeenAt.getTime() - right.lastSeenAt.getTime();
  if (lastSeenDifference !== 0) return lastSeenDifference;

  const startedDifference = left.startedAt.getTime() - right.startedAt.getTime();
  if (startedDifference !== 0) return startedDifference;

  return left.id.localeCompare(right.id);
}

/**
 * Select the newest recent exact session for each device without depending on
 * database row order. Device reuse and session transfer can briefly leave more
 * than one current/recent candidate visible to readiness reporting.
 */
export function newestClasspilotSsoReadinessBindingsByDevice(
  sessions: readonly ClasspilotSsoReadinessSession[],
  cutoffEpochMs: number
): ClasspilotRealtimeBinding[] {
  const newestByDevice = new Map<string, ClasspilotSsoReadinessSession>();

  for (const session of sessions) {
    if (session.lastSeenAt.getTime() < cutoffEpochMs) continue;
    const current = newestByDevice.get(session.deviceId);
    if (!current || compareReadinessSessions(session, current) > 0) {
      newestByDevice.set(session.deviceId, session);
    }
  }

  return [...newestByDevice.values()]
    .sort((left, right) => left.deviceId.localeCompare(right.deviceId))
    .map((session) => ({
      studentId: session.studentId,
      studentSessionId: session.id,
      deviceId: session.deviceId,
    }));
}
