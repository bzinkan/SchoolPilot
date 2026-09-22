import { markClasspilotFabSyncPending, clearClasspilotFabSyncPending } from "./classpilotFabSyncPending.js";
import { randomUUID } from "node:crypto";
import { getActiveSessionsForStudents, withClasspilotStudentControlDeliveryAuthority } from "./storage.js";
import { buildStudentFabState } from "./classpilotFab.js";
import { classpilotFabStatePushFrame } from "./classpilotControlStateFrame.js";
import { sendToStudentBindingLocal, broadcastToStaffContextLocal, broadcastToStaffSessionLocal } from "../realtime/ws-broadcast.js";
import { publishWS } from "../realtime/ws-redis.js";
import { requireScheduledClassroomContext } from "./classpilotActivityAuthority.js";
import type { ToolsScope } from "./classpilotToolsAuthority.js";

export async function publishClassToolsChanged(scope: ToolsScope, studentIds: string[]) {
  const data = { type: "class-tools-updated", schoolId: scope.schoolId, ...scope.authority };
  if (scope.authority.teachingSessionId) {
    broadcastToStaffSessionLocal(scope.schoolId, scope.authority.teachingSessionId, data);
    await publishWS({ kind: "staff-session", schoolId: scope.schoolId, sessionId: scope.authority.teachingSessionId }, data);
  } else {
    const context = await requireScheduledClassroomContext({ schoolId: scope.schoolId, supervisionContextId: scope.authority.supervisionContextId! });
    const revision = String(context.classroomAuthorityRevision);
    const event = { ...data, contextAuthorityRevision: revision };
    broadcastToStaffContextLocal(scope.schoolId, context.id, event, context.assignedStaffId, revision);
    await publishWS({ kind: "staff-context", schoolId: scope.schoolId, supervisionContextId: context.id, assignedStaffId: context.assignedStaffId, contextAuthorityRevision: revision }, event);
  }
  const bindings = await getActiveSessionsForStudents(scope.schoolId, [...new Set(studentIds)]);
  // Bound concurrency: a full class update must not consume one pool slot per student.
  for (let start = 0; start < bindings.length; start += 8) {
    await Promise.all(bindings.slice(start, start + 8).map(async binding => {
      const exact = { kind: "student-binding" as const, schoolId: scope.schoolId, studentId: binding.studentId, studentSessionId: binding.id, deviceId: binding.deviceId };
      const result = await withClasspilotStudentControlDeliveryAuthority(exact,
        database => buildStudentFabState(scope.schoolId, binding.studentId, { studentSessionId: binding.id, dbInstance: database }),
        (_claimed, snapshot) => {
          const payload = classpilotFabStatePushFrame({ messageId: randomUUID(), binding: { ...exact, controlRevision: snapshot.ownershipRevision }, data: snapshot });
          const delivered = sendToStudentBindingLocal(exact, payload);
          return { delivered, publication: publishWS(exact, payload) };
        });
      if (result.authorized) {
        if (result.value.delivered) await clearClasspilotFabSyncPending(exact);
        else await markClasspilotFabSyncPending(exact);
        await result.value.publication;
      }
    }));
  }
}
