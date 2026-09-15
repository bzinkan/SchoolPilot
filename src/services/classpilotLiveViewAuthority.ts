import { requireScheduledClassroomContext, scheduledClassroomRoster } from "./classpilotActivityAuthority.js";
import type { ClasspilotLiveViewBinding } from "./classpilotLiveViewNegotiation.js";
import { isClasspilotCapabilityActive } from "./classpilotProtocol.js";
import { classpilotRealtimeFresh, readClasspilotRealtimeStatusBatch } from "./classpilotRealtimeStatus.js";
import { getClasspilotStudentControlState, isAuthorizedClasspilotSessionStaff } from "./storage.js";

/** A signed negotiation identifies an old attempt; it never replaces current authority. */
export async function isClasspilotLiveViewAuthorityCurrent(binding: ClasspilotLiveViewBinding): Promise<boolean> {
  const control = await getClasspilotStudentControlState(binding.schoolId, binding.studentId);
  if (binding.supervisionContextId) {
    if (binding.teachingSessionId || control?.teachingSessionId
      || control?.supervisionContextId !== binding.supervisionContextId
      || control.revision !== binding.controlRevision
      || !isClasspilotCapabilityActive("scheduledClassroomV1", binding)) return false;
    const realtime = (await readClasspilotRealtimeStatusBatch(binding.schoolId, [binding])).get(binding.studentId);
    if (realtime?.status !== "hit" || !classpilotRealtimeFresh(realtime.snapshot)
      || !realtime.snapshot.acceptedCapabilities?.includes("scheduledClassroomV1")
      || !realtime.snapshot.acceptedCapabilities?.includes("scopedAuthorityChecksV1")) return false;
    try {
      await requireScheduledClassroomContext({ ...binding, supervisionContextId: binding.supervisionContextId,
        actorId: binding.requesterUserId });
      const roster = await scheduledClassroomRoster(binding.schoolId, binding.supervisionContextId);
      return roster.some(({ student }) => student.id === binding.studentId);
    } catch (error) {
      if ((error as { code?: string }).code === "CLASSROOM_ACTIVITY_UNAVAILABLE") return false;
      throw error;
    }
  }
  return !!binding.teachingSessionId && !control?.supervisionContextId
    && control?.teachingSessionId === binding.teachingSessionId
    && await isAuthorizedClasspilotSessionStaff(binding.schoolId, binding.teachingSessionId, binding.requesterUserId);
}
