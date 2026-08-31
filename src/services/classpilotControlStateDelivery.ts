import { randomUUID } from "crypto";
import { sendToStudentBindingLocal } from "../realtime/ws-broadcast.js";
import { publishWSBatch, type PublishWSBatchItem } from "../realtime/ws-redis.js";
import { runWithTenantContext } from "../middleware/tenantContext.js";
import {
  getActiveSessionsForStudents,
  getClasspilotStudentControlState,
  withClasspilotStudentControlDeliveryAuthority,
} from "./storage.js";
import {
  classpilotControlStateHasLateSignInOrigin,
  serializeClasspilotStudentControlStateForDelivery,
} from "./classpilotClassroomState.js";
import { isClasspilotCapabilityActive } from "./classpilotProtocol.js";
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
    const sessions = await getActiveSessionsForStudents(schoolId, uniqueStudentIds);
    const latestSessionByStudent = new Map<string, typeof sessions[number]>();
    for (const session of sessions) {
      const current = latestSessionByStudent.get(session.studentId);
      if (!current || session.lastSeenAt > current.lastSeenAt) {
        latestSessionByStudent.set(session.studentId, session);
      }
    }

    const publications: PublishWSBatchItem[] = [];
    let authorizedTargets = 0;
    for (const studentId of uniqueStudentIds) {
      const session = latestSessionByStudent.get(studentId);
      if (!session?.deviceId) continue;
      const exactTarget = {
        kind: "student-binding" as const,
        schoolId,
        studentId,
        studentSessionId: session.id,
        deviceId: session.deviceId,
      };
      const delivery = await withClasspilotStudentControlDeliveryAuthority(
        exactTarget,
        async (transactionDb) => {
          const state = await getClasspilotStudentControlState(
            schoolId,
            studentId,
            transactionDb
          );
          const lateSignInRequired = !!state
            && classpilotControlStateHasLateSignInOrigin(state.desiredState);
          // Provenance is immutable, including after expiry or a clear. Gate-off
          // must therefore withhold the entire revision-bearing transition, while
          // gate-on may send it only through capability-filtered exact bindings.
          if (lateSignInRequired && !isClasspilotCapabilityActive(
            "lateSignInRestrictionSsoV1",
            { schoolId }
          )) {
            return {
              state,
              fabState: null,
              lateSignInRequired,
              deferredOriginWithheld: true as const,
            };
          }

          let fabState: Record<string, unknown>;
          try {
            fabState = await buildStudentFabState(schoolId, studentId, {
              studentSessionId: session.id,
              dbInstance: transactionDb,
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
          return {
            state,
            fabState,
            lateSignInRequired,
            deferredOriginWithheld: false as const,
          };
        },
        (_claimed, prepared) => {
          const authorizedPublications: PublishWSBatchItem[] = [];
          if (prepared.deferredOriginWithheld) {
            return { publications: authorizedPublications };
          }
          const gateActive = !prepared.lateSignInRequired || isClasspilotCapabilityActive(
            "lateSignInRestrictionSsoV1",
            { schoolId }
          );
          if (!gateActive) return { publications: authorizedPublications };
          const fabState = prepared.fabState;
          const requiredCapability = prepared.lateSignInRequired
            ? "lateSignInRestrictionSsoV1" as const
            : undefined;
          const deliveryTarget = requiredCapability
            ? { ...exactTarget, requiredCapability }
            : exactTarget;

          if (prepared.state) {
            const deliveredState = serializeClasspilotStudentControlStateForDelivery({
              state: prepared.state,
              gateActive,
              acceptedCapabilities: requiredCapability ? [requiredCapability] : [],
              exactBinding: exactTarget,
            });
            if (!deliveredState.classroomState || deliveredState.withheld) {
              return { publications: authorizedPublications };
            }
            const classroomMessage = classpilotClassroomStatePushFrame({
              type: "classroom-state-sync",
              messageId: randomUUID(),
              binding: {
                schoolId,
                deviceId: session.deviceId,
                studentId,
                studentSessionId: session.id,
                controlRevision: prepared.state.revision,
              },
              classroomState: deliveredState.classroomState,
            });
            sendToStudentBindingLocal(deliveryTarget, classroomMessage, { requiredCapability });
            authorizedPublications.push({ target: deliveryTarget, message: classroomMessage });
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
                : prepared.state?.revision ?? 0,
            },
            data: {
              ...fabState,
              reason: "control_ownership_transition",
            },
          });
          sendToStudentBindingLocal(deliveryTarget, fabMessage, { requiredCapability });
          authorizedPublications.push({ target: deliveryTarget, message: fabMessage });
          return { publications: authorizedPublications };
        }
      );
      if (!delivery.authorized) continue;
      authorizedTargets += 1;
      publications.push(...delivery.value.publications);
    }
    if (publications.length > 0) await publishWSBatch(publications);
    return authorizedTargets;
  });
}
