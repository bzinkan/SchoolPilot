import {
  listActiveClasspilotLiveViewNegotiations,
  releaseClasspilotLiveViewNegotiation,
} from "./classpilotLiveViewNegotiation.js";
import { sendToDeviceLocal } from "../realtime/ws-broadcast.js";
import { publishWS } from "../realtime/ws-redis.js";

/**
 * Stop only negotiations claimed by this API process. Session lifecycle events
 * are also relayed through Redis, so every API task runs the same local cleanup
 * for the claims it originated without putting device identifiers in a public
 * event or maintaining an unbounded cross-tenant index.
 */
export async function stopActiveClasspilotLiveViewNegotiations(options: {
  schoolId: string;
  teachingSessionId?: string;
  requesterUserId?: string;
  negotiationIds?: readonly string[];
  reason: string;
}): Promise<number> {
  const claims = listActiveClasspilotLiveViewNegotiations(options);
  await Promise.all(claims.map(async ({ negotiationId, binding }) => {
    const payload = {
      type: "stop-share",
      from: "server",
      negotiationId,
      studentId: binding.studentId,
      studentSessionId: binding.studentSessionId,
      reason: String(options.reason || "authority-ended").slice(0, 64),
    };
    sendToDeviceLocal(binding.schoolId, binding.deviceId, payload);
    await Promise.allSettled([
      publishWS(
        { kind: "device", schoolId: binding.schoolId, deviceId: binding.deviceId },
        payload
      ),
      releaseClasspilotLiveViewNegotiation(
        { schoolId: binding.schoolId, studentId: binding.studentId },
        negotiationId
      ),
    ]);
  }));
  return claims.length;
}
