import { runWithTenantContext } from "../middleware/tenantContext.js";
import { publishWS } from "../realtime/ws-redis.js";
import { getActiveSessionsForStudents, getClasspilotStudentControlStates, getSupervisionContextByIdAndSchool } from "./storage.js";
import { scheduledContextHasClassroomTools } from "./classpilotActivityAuthority.js";
import { listActiveClasspilotLiveViewNegotiations, type ClasspilotLiveViewBinding } from "./classpilotLiveViewNegotiation.js";
import { stopActiveClasspilotLiveViewNegotiations } from "./classpilotLiveViewStop.js";

type AuthoritySnapshot = {
  teachingSessionId: string | null; supervisionContextId: string | null; revision: number;
  hardExpiresAt: Date | null; scheduledEndAt: Date | null;
};

export function classpilotLiveViewBindingMatchesSnapshot(binding: ClasspilotLiveViewBinding,
  state: AuthoritySnapshot | undefined, session: { id: string; deviceId: string } | undefined, now = Date.now()): boolean {
  return !!state && !!session && session.id === binding.studentSessionId && session.deviceId === binding.deviceId
    && (state.teachingSessionId ?? null) === (binding.teachingSessionId ?? null)
    && (state.supervisionContextId ?? null) === (binding.supervisionContextId ?? null)
    && (binding.controlRevision === undefined || binding.controlRevision === state.revision)
    && !!state.hardExpiresAt && state.hardExpiresAt.getTime() > now
    && (!state.scheduledEndAt || state.scheduledEndAt.getTime() > now);
}

/** Re-read only local active negotiations for the affected students. An old
 * invalidation is a hint, not an old authority snapshot that could kill a new stream. */
export async function stopStaleClasspilotLiveViewsForStudents(schoolId: string, studentIds: readonly string[]): Promise<number> {
  const affected = new Set(studentIds);
  const claims = listActiveClasspilotLiveViewNegotiations({ schoolId })
    .filter(({ binding }) => affected.has(binding.studentId));
  if (!claims.length) return 0;
  const ids = [...new Set(claims.map(({ binding }) => binding.studentId))];
  let stale: string[];
  try {
    stale = await runWithTenantContext({ schoolId }, async () => {
      const states = await getClasspilotStudentControlStates(schoolId, ids);
      const sessions = await getActiveSessionsForStudents(schoolId, ids);
      const stateByStudent = new Map(states.map((state) => [state.studentId, state]));
      const contextIds = [...new Set(claims.flatMap(({ binding }) => binding.supervisionContextId ? [binding.supervisionContextId] : []))];
      const contexts = new Map<string, Awaited<ReturnType<typeof getSupervisionContextByIdAndSchool>>>();
      // The scoped database owns one pg client; do not interleave queries.
      for (const contextId of contextIds) contexts.set(contextId, await getSupervisionContextByIdAndSchool(schoolId, contextId));
      return claims.filter(({ binding }) => {
        const session = sessions.find((entry) => entry.studentId === binding.studentId && entry.id === binding.studentSessionId);
        if (!classpilotLiveViewBindingMatchesSnapshot(binding, stateByStudent.get(binding.studentId), session)) return true;
        if (!binding.supervisionContextId) return false;
        const context = contexts.get(binding.supervisionContextId);
        return !scheduledContextHasClassroomTools(context) || context.assignedStaffId !== binding.requesterUserId;
      }).map(({ negotiationId }) => negotiationId);
    });
  } catch {
    // A failed authority read cannot prolong affected capture. IDs came from
    // the local claim inventory, so unrelated students remain untouched.
    stale = claims.map(({ negotiationId }) => negotiationId);
  }
  if (!stale.length) return 0;
  return stopActiveClasspilotLiveViewNegotiations({ schoolId, negotiationIds: stale, reason: "classroom-authority-changed" });
}

export async function invalidateClasspilotLiveViewsForStudents(schoolId: string, studentIds: readonly string[]): Promise<void> {
  const ids = [...new Set(studentIds.filter(Boolean))];
  for (let offset = 0; offset < ids.length; offset += 100) {
    const batch = ids.slice(offset, offset + 100);
    const [published] = await Promise.all([
      publishWS({ kind: "live-view-authority", schoolId, studentIds: batch }, { type: "live-view-authority-changed" }),
      stopStaleClasspilotLiveViewsForStudents(schoolId, batch),
    ]);
    if (process.env.REDIS_URL && !published) throw new Error("Live View authority invalidation unavailable");
  }
}
