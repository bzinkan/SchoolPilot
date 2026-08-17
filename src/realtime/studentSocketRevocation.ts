import { closeStudentSocketsLocal } from "./ws-broadcast.js";
import { publishWS } from "./ws-redis.js";

export type StudentSocketRevocationResult = {
  closedLocal: number;
  relayed: boolean;
};

/**
 * Post-commit ClassPilot socket revocation for roster removal. Local authority
 * is removed synchronously first; Redis then instructs every other API task to
 * do the same. A false relay result is intentionally non-fatal because the
 * persisted-session checks on every student message and WebSocket pong remain
 * the fail-closed fallback during Redis degradation.
 */
export async function revokeClasspilotStudentSocketsAfterRosterRemoval(
  schoolId: string,
  studentIds: readonly string[]
): Promise<StudentSocketRevocationResult> {
  const uniqueStudentIds = [...new Set(studentIds.map(String).filter(Boolean))].sort();
  if (!schoolId || uniqueStudentIds.length === 0) {
    return { closedLocal: 0, relayed: false };
  }

  const closedLocal = closeStudentSocketsLocal(schoolId, uniqueStudentIds);
  let relayed = false;
  try {
    relayed = await publishWS(
      { kind: "student-disconnect", schoolId, studentIds: uniqueStudentIds },
      { type: "student-roster-removed" }
    );
  } catch {
    // Best effort only. Database-backed revalidation still fails closed.
  }
  return { closedLocal, relayed };
}
