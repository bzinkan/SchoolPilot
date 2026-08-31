import { randomUUID } from "node:crypto";
import { runWithTenantContext } from "../middleware/tenantContext.js";
import { sendToStudentBindingLocal } from "../realtime/ws-broadcast.js";
import { publishWSBatch, type PublishWSBatchItem } from "../realtime/ws-redis.js";
import { isClasspilotCapabilityActive } from "./classpilotProtocol.js";
import { recordHeartbeatHotPathCounter } from "./heartbeatHotPathMetrics.js";
import {
  getActiveSessionsForStudents,
  getClasspilotScreenshotAuthorityProjection,
  withClasspilotStudentControlDeliveryAuthority,
} from "./storage.js";

const SCREENSHOT_POLICY_REFRESH_CAPABILITY =
  "screenshotActiveObservationCadenceV1" as const;
const SCREENSHOT_POLICY_REFRESH_CONCURRENCY = 20;

/**
 * Prompt capable extensions on exact current bindings to refresh their policy
 * after an observation lease changes. The frame carries the exact student,
 * session, and teaching-session aliases the extension already authenticates,
 * but never a device ID or an authorization grant. Heartbeat reconciliation
 * remains authoritative.
 */
export async function nudgeClasspilotScreenshotPolicyRefresh(options: {
  schoolId: string;
  teachingSessionId: string;
  studentIds: string[];
}): Promise<number> {
  if (!isClasspilotCapabilityActive(SCREENSHOT_POLICY_REFRESH_CAPABILITY, {
    schoolId: options.schoolId,
  })) return 0;

  const studentIds = [...new Set(options.studentIds.map(String).filter(Boolean))];
  if (studentIds.length === 0) return 0;

  return runWithTenantContext({ schoolId: options.schoolId }, async () => {
    const sessions = await getActiveSessionsForStudents(options.schoolId, studentIds);
    const latestSessionByStudent = new Map<string, typeof sessions[number]>();
    for (const session of sessions) {
      const current = latestSessionByStudent.get(session.studentId);
      if (!current || session.lastSeenAt > current.lastSeenAt) {
        latestSessionByStudent.set(session.studentId, session);
      }
    }

    const deliveries: Array<{
      publication: PublishWSBatchItem;
      localDelivered: boolean;
    }> = [];
    for (let offset = 0; offset < studentIds.length; offset += SCREENSHOT_POLICY_REFRESH_CONCURRENCY) {
      const cohort = studentIds.slice(offset, offset + SCREENSHOT_POLICY_REFRESH_CONCURRENCY);
      const prepared = await Promise.all(cohort.map(async (studentId) => {
        const session = latestSessionByStudent.get(studentId);
        if (!session?.deviceId) return null;
        const exactTarget = {
          kind: "student-binding" as const,
          schoolId: options.schoolId,
          studentId,
          studentSessionId: session.id,
          deviceId: session.deviceId,
          requiredCapability: SCREENSHOT_POLICY_REFRESH_CAPABILITY,
        };
        try {
          const delivery = await withClasspilotStudentControlDeliveryAuthority(
            exactTarget,
            (transactionDb) => getClasspilotScreenshotAuthorityProjection({
              schoolId: options.schoolId,
              studentId,
              studentSessionId: session.id,
              deviceId: session.deviceId,
            }, transactionDb),
            (_claimed, authority) => {
              if (
                authority?.authority.kind !== "teaching_session"
                || authority.authority.teachingSessionId !== options.teachingSessionId
              ) return null;
              const message = {
                type: "screenshot-policy-refresh",
                _msgId: randomUUID(),
                reason: "observation_changed",
                studentId,
                studentSessionId: session.id,
                teachingSessionId: options.teachingSessionId,
              } as const;
              const localDelivered = sendToStudentBindingLocal(exactTarget, message, {
                requiredCapability: SCREENSHOT_POLICY_REFRESH_CAPABILITY,
              });
              return {
                publication: { target: exactTarget, message } satisfies PublishWSBatchItem,
                localDelivered,
              };
            }
          );
          return delivery.authorized ? delivery.value : null;
        } catch {
          recordHeartbeatHotPathCounter("screenshotPolicyRefreshFailures");
          return null;
        }
      }));
      for (const item of prepared) {
        if (item) deliveries.push(item);
      }
    }

    if (deliveries.length > 0) {
      let remoteDelivered: boolean[] = deliveries.map(() => false);
      try {
        remoteDelivered = await publishWSBatch(
          deliveries.map(({ publication }) => publication)
        );
      } catch {
        // The immediate heartbeat remains the durable fallback. The exact
        // target failures are counted below without logging identifiers.
      }
      const failedTargets = deliveries.reduce(
        (count, delivery, index) => count + (
          delivery.localDelivered || remoteDelivered[index] ? 0 : 1
        ),
        0
      );
      recordHeartbeatHotPathCounter("screenshotPolicyRefreshTargets", deliveries.length);
      recordHeartbeatHotPathCounter("screenshotPolicyRefreshFailures", failedTargets);
    }
    return deliveries.length;
  });
}
