import { randomUUID } from "crypto";
import { sendToDeviceLocal } from "../realtime/ws-broadcast.js";
import { publishWSBatch, type PublishWSBatchItem } from "../realtime/ws-redis.js";
import { runWithTenantContext } from "../middleware/tenantContext.js";
import {
  getActiveSessionsForStudents,
  getClasspilotStudentControlStates,
} from "./storage.js";
import { serializeClasspilotStudentControlState } from "./classpilotClassroomState.js";
import { buildStudentFabState } from "./classpilotFab.js";
import {
  classpilotClassroomStatePushFrame,
  classpilotFabStatePushFrame,
} from "./classpilotControlStateFrame.js";

/** Push the authoritative classroom + FAB snapshots after any class/coverage
 * ownership transition.
 * Delivery is best-effort; auth and heartbeat reconciliation remain the
 * durable fallback for offline students and cross-instance outages. */
export async function syncClasspilotControlStatesToActiveDevices(
  schoolId: string,
  studentIds: string[]
): Promise<number> {
  const uniqueStudentIds = [...new Set(studentIds.map(String).filter(Boolean))];
  if (uniqueStudentIds.length === 0) return 0;
  return runWithTenantContext({ schoolId }, async () => {
    const [states, sessions] = await Promise.all([
      getClasspilotStudentControlStates(schoolId, uniqueStudentIds),
      getActiveSessionsForStudents(schoolId, uniqueStudentIds),
    ]);
    const stateByStudent = new Map(states.map((state) => [state.studentId, state]));
    const latestSessionByStudent = new Map<string, typeof sessions[number]>();
    for (const session of sessions) {
      const current = latestSessionByStudent.get(session.studentId);
      if (!current || session.lastSeenAt > current.lastSeenAt) {
        latestSessionByStudent.set(session.studentId, session);
      }
    }

    const publications: PublishWSBatchItem[] = [];
    let targetedDevices = 0;
    for (const studentId of uniqueStudentIds) {
      const state = stateByStudent.get(studentId);
      const session = latestSessionByStudent.get(studentId);
      if (!session?.deviceId) continue;
      targetedDevices += 1;
      if (state) {
        const classroomMessage = classpilotClassroomStatePushFrame({
          type: "classroom-state-sync",
          messageId: randomUUID(),
          binding: {
            schoolId,
            deviceId: session.deviceId,
            studentId,
            studentSessionId: session.id,
            controlRevision: state.revision,
          },
          classroomState: serializeClasspilotStudentControlState(state),
        });
        sendToDeviceLocal(schoolId, session.deviceId, classroomMessage);
        publications.push({
          target: { kind: "device", schoolId, deviceId: session.deviceId },
          message: classroomMessage,
        });
      }
      let fabState: Record<string, unknown>;
      try {
        fabState = await buildStudentFabState(schoolId, studentId, {
          studentSessionId: session.id,
        });
      } catch {
        // Revocation and incomplete legacy data both fail closed. The explicit
        // disabled snapshot clears a formerly visible FAB immediately; auth
        // remains the durable recovery/revocation boundary.
        fabState = {
          schemaVersion: 1,
          studentId,
          studentSessionId: session.id,
          teachingSessionId: null,
          activeSessionIds: [],
          messagingEnabled: false,
          handRaisingEnabled: false,
          handRaised: false,
          lifecycleRevision: 0,
          revision: 0,
        };
      }
      const fabMessage = classpilotFabStatePushFrame({
        messageId: randomUUID(),
        binding: {
          schoolId,
          deviceId: session.deviceId,
          studentId,
          studentSessionId: session.id,
          controlRevision: Number.isSafeInteger(fabState.ownershipRevision)
            ? Number(fabState.ownershipRevision)
            : state?.revision ?? 0,
        },
        data: {
          ...fabState,
          reason: "control_ownership_transition",
        },
      });
      sendToDeviceLocal(schoolId, session.deviceId, fabMessage);
      publications.push({
        target: { kind: "device", schoolId, deviceId: session.deviceId },
        message: fabMessage,
      });
    }
    if (publications.length > 0) await publishWSBatch(publications);
    return targetedDevices;
  });
}
