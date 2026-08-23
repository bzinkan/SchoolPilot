import crypto from "node:crypto";
import { Router } from "express";
import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import { requireCryptographicDeviceAuth } from "../../middleware/requireDeviceAuth.js";
import { requireClasspilotEntitlement } from "../../middleware/requireClasspilotEntitlement.js";
import { runWithTenantContext } from "../../middleware/tenantContext.js";
import { setClassPilotNoStore } from "../../services/classpilotStudentAuth.js";
import {
  classpilotLiveViewNegotiationAuthority,
  isClasspilotLiveViewNegotiationActive,
} from "../../services/classpilotLiveViewNegotiation.js";
import { isClasspilotCapabilityActive } from "../../services/classpilotProtocol.js";
import {
  classpilotRealtimeFresh,
  readClasspilotRealtimeStatusBatch,
} from "../../services/classpilotRealtimeStatus.js";
import {
  classpilotTurnTelemetrySchema,
  recordClasspilotTurnTelemetry,
} from "../../services/classpilotTurnTelemetry.js";
import {
  getClasspilotStudentControlState,
  isAuthorizedClasspilotSessionStaff,
} from "../../services/storage.js";

const router = Router();
const liveViewTelemetryRequestLimiter = rateLimit({
  windowMs: 60_000,
  max: 20,
  message: {
    error: "Live View telemetry rate limit reached",
    code: "LIVE_VIEW_TELEMETRY_RATE_LIMITED",
  },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    const authorization = req.get("authorization");
    if (authorization) {
      return `device-token:${crypto.createHash("sha256").update(authorization).digest("hex")}`;
    }
    return `ip:${ipKeyGenerator(req.ip ?? req.socket.remoteAddress ?? "unknown")}`;
  },
});

// Advisory, identifier-free telemetry for one exact Live View negotiation.
// Each attempt is accepted at most once across API tasks and local fallback
// state is strictly bounded. Telemetry never changes classroom authority.
router.post(
  "/device/live-view/telemetry",
  requireCryptographicDeviceAuth,
  liveViewTelemetryRequestLimiter,
  requireClasspilotEntitlement,
  async (req, res, next) => {
    setClassPilotNoStore(res);
    try {
      const parsed = classpilotTurnTelemetrySchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({
          error: "Invalid Live View telemetry",
          code: "LIVE_VIEW_TELEMETRY_INVALID",
        });
      }

      const exactBinding = {
        schoolId: res.locals.schoolId as string,
        studentId: res.locals.studentId as string,
        studentSessionId: res.locals.studentSessionId as string,
        deviceId: res.locals.deviceId as string,
      };
      if (!isClasspilotCapabilityActive("liveViewIceServersV1", exactBinding)) {
        return res.status(404).json({
          error: "Live View telemetry is not enabled",
          code: "LIVE_VIEW_TELEMETRY_DISABLED",
        });
      }

      const realtime = (await readClasspilotRealtimeStatusBatch(
        exactBinding.schoolId,
        [exactBinding]
      )).get(exactBinding.studentId);
      if (
        realtime?.status !== "hit"
        || !classpilotRealtimeFresh(realtime.snapshot)
        || !new Set(realtime.snapshot.acceptedCapabilities || []).has("liveViewIceServersV1")
      ) {
        return res.status(409).json({
          error: "A healthy capability-bound heartbeat is required",
          code: "LIVE_VIEW_TELEMETRY_CAPABILITY_NOT_READY",
        });
      }

      const authority = classpilotLiveViewNegotiationAuthority(
        parsed.data.negotiationId,
        exactBinding
      );
      if (!authority || !await isClasspilotLiveViewNegotiationActive(
        exactBinding,
        parsed.data.negotiationId
      )) {
        return res.status(403).json({
          error: "Live View negotiation is not active for this session",
          code: "LIVE_VIEW_NEGOTIATION_INVALID",
        });
      }

      const authorized = await runWithTenantContext(
        { schoolId: exactBinding.schoolId },
        async () => {
          const [controlState, staffAuthorized] = await Promise.all([
            getClasspilotStudentControlState(exactBinding.schoolId, exactBinding.studentId),
            isAuthorizedClasspilotSessionStaff(
              exactBinding.schoolId,
              authority.teachingSessionId,
              authority.requesterUserId
            ),
          ]);
          return controlState?.teachingSessionId === authority.teachingSessionId
            && staffAuthorized;
        }
      );
      if (!authorized) {
        return res.status(403).json({
          error: "Live View authority is no longer active",
          code: "LIVE_VIEW_AUTHORITY_REVOKED",
        });
      }

      // Close the await gap: a stop/replacement may have released the claim
      // while current staff/control authority was being checked.
      if (!await isClasspilotLiveViewNegotiationActive(
        exactBinding,
        parsed.data.negotiationId
      )) {
        return res.status(409).json({
          error: "Live View negotiation ended before telemetry was recorded",
          code: "LIVE_VIEW_NEGOTIATION_SUPERSEDED",
        });
      }

      const result = await recordClasspilotTurnTelemetry({
        binding: exactBinding,
        telemetry: parsed.data,
      });
      return res.status(202).json({
        accepted: result.accepted,
        duplicate: !result.accepted,
      });
    } catch (error) {
      return next(error);
    }
  }
);

export default router;
