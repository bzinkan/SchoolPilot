import { randomUUID } from "crypto";
import { sendToDeviceLocal } from "../realtime/ws-broadcast.js";
import { publishWSBatch, type PublishWSBatchItem } from "../realtime/ws-redis.js";
import { runWithTenantContext } from "../middleware/tenantContext.js";
import {
  getActiveSessionsForStudents,
  getClasspilotStudentControlStates,
} from "./storage.js";
import { serializeClasspilotStudentControlState } from "./classpilotClassroomState.js";

/** Push the authoritative full snapshot after a class/coverage transition.
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
    for (const studentId of uniqueStudentIds) {
      const state = stateByStudent.get(studentId);
      const session = latestSessionByStudent.get(studentId);
      if (!state || !session?.deviceId) continue;
      const message = {
        type: "classroom-state-sync",
        _msgId: randomUUID(),
        classroomState: serializeClasspilotStudentControlState(state),
      };
      sendToDeviceLocal(schoolId, session.deviceId, message);
      publications.push({
        target: { kind: "device", schoolId, deviceId: session.deviceId },
        message,
      });
    }
    if (publications.length > 0) await publishWSBatch(publications);
    return publications.length;
  });
}
