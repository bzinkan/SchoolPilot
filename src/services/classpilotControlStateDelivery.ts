import { randomUUID } from "crypto";
import { sendToStudentBindingLocal } from "../realtime/ws-broadcast.js";
import { publishWSBatch, type PublishWSBatchItem } from "../realtime/ws-redis.js";
import { runWithTenantContext } from "../middleware/tenantContext.js";
import {
  getActiveSessionsForStudents,
  getClasspilotSsoPolicyForSchool,
  getClasspilotStudentControlState,
  lockClasspilotSsoPolicyDeliveryAuthority,
  withClasspilotStudentControlDeliveryAuthority,
} from "./storage.js";
import {
  classpilotControlStateHasLateSignInOrigin,
  serializeClasspilotStudentControlStateForDelivery,
} from "./classpilotClassroomState.js";
import { isClasspilotCapabilityActive } from "./classpilotProtocol.js";
import {
  classpilotRealtimeFresh,
  readClasspilotRealtimeStatusBatch,
} from "./classpilotRealtimeStatus.js";
import { buildStudentFabState } from "./classpilotFab.js";
import {
  classpilotClassroomStatePushFrame,
  classpilotFabStatePushFrame,
} from "./classpilotControlStateFrame.js";
import { nudgeClasspilotScreenshotPolicyRefresh } from "./classpilotScreenshotPolicyRefresh.js";

/** Push the authoritative classroom + FAB snapshots after any class/coverage
 * ownership transition.
 * Delivery is best-effort; auth and heartbeat reconciliation remain the
 * durable fallback for offline students and cross-instance outages. */
export async function syncClasspilotControlStatesToActiveDevices(
  schoolId: string,
  studentIds: string[],
  signal?: AbortSignal
): Promise<number> {
  const uniqueStudentIds = [...new Set(studentIds.map(String).filter(Boolean))];
  if (uniqueStudentIds.length === 0 || signal?.aborted) return 0;
  const { authorizedTargets, teachingSessionIds } = await runWithTenantContext({ schoolId }, async () => {
    const sessions = await getActiveSessionsForStudents(schoolId, uniqueStudentIds);
    const latestSessionByStudent = new Map<string, typeof sessions[number]>();
    for (const session of sessions) {
      const current = latestSessionByStudent.get(session.studentId);
      if (!current || session.lastSeenAt > current.lastSeenAt) {
        latestSessionByStudent.set(session.studentId, session);
      }
    }
    const realtimeByStudent = await readClasspilotRealtimeStatusBatch(
      schoolId,
      [...latestSessionByStudent.values()].map((session) => ({
        studentId: session.studentId,
        studentSessionId: session.id,
        deviceId: session.deviceId,
      }))
    );

    const publications: PublishWSBatchItem[] = [];
    let authorizedTargets = 0;
    for (const studentId of uniqueStudentIds) {
      if (signal?.aborted) break;
      const session = latestSessionByStudent.get(studentId);
      if (!session?.deviceId) continue;
      const exactTarget = {
        kind: "student-binding" as const,
        schoolId,
        studentId,
        studentSessionId: session.id,
        deviceId: session.deviceId,
      };
      const realtimeRead = realtimeByStudent.get(studentId);
      const realtime = realtimeRead?.status === "hit"
        && classpilotRealtimeFresh(realtimeRead.snapshot)
        ? realtimeRead.snapshot
        : null;
      const delivery = await withClasspilotStudentControlDeliveryAuthority(
        exactTarget,
        async (transactionDb) => {
          await lockClasspilotSsoPolicyDeliveryAuthority(schoolId, transactionDb);
          const [state, ssoPolicy] = await Promise.all([
            getClasspilotStudentControlState(
              schoolId,
              studentId,
              transactionDb
            ),
            getClasspilotSsoPolicyForSchool(schoolId, transactionDb),
          ]);
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
              ssoPolicy,
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
            ssoPolicy,
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

          if (prepared.state) {
            const deliveredState = serializeClasspilotStudentControlStateForDelivery({
              state: prepared.state,
              gateActive,
              acceptedCapabilities: realtime?.acceptedCapabilities ?? [],
              exactBinding: exactTarget,
              authPassThrough: {
                gateActive: isClasspilotCapabilityActive(
                  "restrictionAuthPassThroughV1",
                  { schoolId }
                ),
                policyRevision: prepared.ssoPolicy.revision,
                policy: prepared.ssoPolicy.policy,
              },
            });
            // Withhold only the restriction snapshot when this binding lacks
            // sign-in-safe restriction support. FAB ownership is a separate
            // exact-bound authority surface and must still converge/clear on a
            // class or Coverage transition. Immutable deferred-origin state is
            // handled by the whole-transition guard above.
            if (deliveredState.classroomState && !deliveredState.withheld) {
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
              const classroomRequiredCapabilities = [
                ...(requiredCapability ? [requiredCapability] : []),
                ...(deliveredState.classroomState.authPassThrough
                  ? ["restrictionAuthPassThroughV1" as const]
                  : []),
              ];
              const classroomRequiredCapability = classroomRequiredCapabilities.at(-1);
              const classroomTarget = classroomRequiredCapability
                ? {
                    ...exactTarget,
                    requiredCapability: classroomRequiredCapability,
                    requiredCapabilities: classroomRequiredCapabilities,
                  }
                : exactTarget;
              authorizedPublications.push({ target: classroomTarget, message: classroomMessage });
            }
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
          const fabTarget = requiredCapability
            ? { ...exactTarget, requiredCapability }
            : exactTarget;
          authorizedPublications.push({ target: fabTarget, message: fabMessage });
          return { publications: authorizedPublications };
        }
      );
      if (!delivery.authorized) continue;
      if (signal?.aborted) break;
      authorizedTargets += 1;
      for (const publication of delivery.value.publications) {
        if (publication.target.kind !== "student-binding") continue;
        sendToStudentBindingLocal(publication.target, publication.message, {
          requiredCapability: publication.target.requiredCapability,
          requiredCapabilities: publication.target.requiredCapabilities,
        });
      }
      publications.push(...delivery.value.publications);
    }
    if (publications.length > 0 && !signal?.aborted) {
      const accepted = await publishWSBatch(publications);
      if (process.env.REDIS_URL && accepted.some((published) => !published)) {
        throw new Error("Classroom/FAB publication unavailable");
      }
    }
    const teachingSessionIds = [...new Set(publications.flatMap((publication) => {
      const classroomState = (publication.message as {
        classroomState?: { teachingSessionId?: unknown };
      }).classroomState;
      return typeof classroomState?.teachingSessionId === "string"
        && classroomState.teachingSessionId
        ? [classroomState.teachingSessionId]
        : [];
    }))];
    return { authorizedTargets, teachingSessionIds };
  });
  // Refresh performs its own scoped active-session read. Never await it while
  // retaining this delivery's tenant lease (the worker pool has two clients).
  if (!signal?.aborted) {
    const refreshFailures: unknown[] = [];
    await Promise.all(teachingSessionIds.map((teachingSessionId) =>
      nudgeClasspilotScreenshotPolicyRefresh({
        schoolId,
        teachingSessionId,
        studentIds: uniqueStudentIds,
        reason: "scope_changed",
        onFailure: (error) => refreshFailures.push(error),
      }).catch((error) => { refreshFailures.push(error); return 0; })
    ));
    if (refreshFailures.length) throw new AggregateError(refreshFailures, "Screenshot policy refresh failed");
  }
  return authorizedTargets;
}
