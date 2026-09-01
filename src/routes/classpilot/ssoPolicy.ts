import { Router } from "express";
import { z } from "zod";

import { authenticate } from "../../middleware/authenticate.js";
import { requireActiveSchool } from "../../middleware/requireActiveSchool.js";
import { requireClasspilotEntitlement } from "../../middleware/requireClasspilotEntitlement.js";
import { requireRole } from "../../middleware/requireRole.js";
import { requireSchoolContext } from "../../middleware/requireSchoolContext.js";
import {
  ClasspilotSsoPolicyRevisionConflictError,
  getActiveSessions,
  getClasspilotSsoPolicyForSchool,
  getClasspilotStudentControlStates,
  getSettingsForSchool,
  updateClasspilotSsoPolicy,
} from "../../services/storage.js";
import { classpilotControlStateHasAuthRelevantRestriction } from
  "../../services/classpilotClassroomState.js";
import { syncClasspilotControlStatesToActiveDevices } from
  "../../services/classpilotControlStateDelivery.js";
import { recordHeartbeatHotPathCounter } from
  "../../services/heartbeatHotPathMetrics.js";
import {
  ClasspilotSsoPolicyValidationError,
  builtInClasspilotSsoProfiles,
  findClasspilotSsoPolicyBlockConflicts,
  type ClasspilotSsoPolicyRecord,
} from "../../services/classpilotSsoPolicy.js";
import { isClasspilotCapabilityActive } from "../../services/classpilotProtocol.js";
import {
  CLASSPILOT_REALTIME_EXPIRED_AFTER_MS,
  readClasspilotRealtimeStatusBatch,
  readLocalClasspilotRealtimeStatusBatch,
  type ClasspilotRealtimeStatus,
} from "../../services/classpilotRealtimeStatus.js";
import { newestClasspilotSsoReadinessBindingsByDevice } from "../../services/classpilotSsoReadiness.js";

const router = Router();

const auth = [
  authenticate,
  requireSchoolContext,
  requireActiveSchool,
  requireClasspilotEntitlement,
  requireRole("admin", "school_admin"),
] as const;

const patchSchema = z.object({
  expectedRevision: z.number().int().min(0),
  policy: z.unknown(),
}).strict();

const REQUIRED_CAPABILITY = "restrictionAuthPassThroughV1" as const;

type ClasspilotSsoExtensionReadiness = {
  capability: typeof REQUIRED_CAPABILITY;
  observationWindowSeconds: number;
  recentlyActiveBindings: number;
  observedBindings: number;
  rawCapableBindings: number;
  acceptedCapableBindings: number;
  readyBindings: number;
  unknownBindings: number;
  status: "rollout_disabled" | "no_recent_bindings" | "partial" | "ready";
};

async function extensionReadinessForSchool(
  schoolId: string,
  operatorGateActive: boolean
): Promise<ClasspilotSsoExtensionReadiness> {
  const cutoff = Date.now() - CLASSPILOT_REALTIME_EXPIRED_AFTER_MS;
  const bindings = newestClasspilotSsoReadinessBindingsByDevice(
    await getActiveSessions(schoolId),
    cutoff
  );
  const shared = await readClasspilotRealtimeStatusBatch(schoolId, bindings);
  const local = readLocalClasspilotRealtimeStatusBatch(schoolId, bindings);
  let observedBindings = 0;
  let rawCapableBindings = 0;
  let acceptedCapableBindings = 0;
  let readyBindings = 0;
  for (const binding of bindings) {
    const sharedResult = shared.get(binding.studentId);
    const localResult = local.get(binding.studentId);
    const snapshot: ClasspilotRealtimeStatus | null = sharedResult?.status === "hit"
      ? sharedResult.snapshot
      : localResult?.status === "hit"
        ? localResult.snapshot
        : null;
    if (!snapshot || snapshot.observedAt < cutoff) continue;
    observedBindings += 1;
    const raw = snapshot.extensionCapabilities?.includes(REQUIRED_CAPABILITY) === true;
    const accepted = snapshot.acceptedCapabilities?.includes(REQUIRED_CAPABILITY) === true;
    if (raw) rawCapableBindings += 1;
    if (accepted) acceptedCapableBindings += 1;
    if (raw && accepted) readyBindings += 1;
  }
  const recentlyActiveBindings = bindings.length;
  return {
    capability: REQUIRED_CAPABILITY,
    observationWindowSeconds: Math.trunc(CLASSPILOT_REALTIME_EXPIRED_AFTER_MS / 1_000),
    recentlyActiveBindings,
    observedBindings,
    rawCapableBindings,
    acceptedCapableBindings,
    readyBindings,
    unknownBindings: Math.max(recentlyActiveBindings - observedBindings, 0),
    status: !operatorGateActive
      ? "rollout_disabled"
      : recentlyActiveBindings === 0
        ? "no_recent_bindings"
        : readyBindings === recentlyActiveBindings
          ? "ready"
          : "partial",
  };
}

async function responseForPolicy(
  schoolId: string,
  record: ClasspilotSsoPolicyRecord,
  blockedDomains: readonly unknown[] | null | undefined
) {
  const operatorGateActive = isClasspilotCapabilityActive(
    REQUIRED_CAPABILITY,
    { schoolId }
  );
  return {
    policy: record.policy,
    revision: record.revision,
    policyValid: record.valid,
    requiredCapability: REQUIRED_CAPABILITY,
    // Keep rolloutActive during this additive API transition, but make the
    // explicit gate field and observed fleet evidence authoritative in new UI.
    rolloutActive: operatorGateActive,
    operatorGateActive,
    extensionReadiness: await extensionReadinessForSchool(
      schoolId,
      operatorGateActive
    ),
    builtInProfiles: builtInClasspilotSsoProfiles(),
    conflicts: findClasspilotSsoPolicyBlockConflicts(
      record.policy,
      blockedDomains
    ),
  };
}

// GET /api/classpilot/admin/sso-policy
router.get("/", ...auth, async (_req, res, next) => {
  try {
    const schoolId = res.locals.schoolId!;
    const [record, schoolSettings] = await Promise.all([
      getClasspilotSsoPolicyForSchool(schoolId),
      getSettingsForSchool(schoolId),
    ]);
    return res.json(await responseForPolicy(
      schoolId,
      record,
      schoolSettings?.blockedDomains
    ));
  } catch (error) {
    return next(error);
  }
});

// PATCH /api/classpilot/admin/sso-policy
router.patch("/", ...auth, async (req, res, next) => {
  const parsed = patchSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      error: "Student sign-in policy request is invalid.",
      code: "CLASSPILOT_SSO_POLICY_REQUEST_INVALID",
      issues: parsed.error.issues.map((issue) => ({
        path: issue.path.join("."),
        code: issue.code,
        message: issue.message,
      })),
    });
  }
  try {
    const schoolId = res.locals.schoolId!;
    const record = await updateClasspilotSsoPolicy({
      schoolId,
      expectedRevision: parsed.data.expectedRevision,
      policy: parsed.data.policy,
      actorUserId: req.authUser!.id,
      actorRole: req.authUser!.isSuperAdmin
        ? "super_admin"
        : String(res.locals.membershipRole || "admin"),
    });
    // The policy commit is authoritative before any network work begins.
    // Immediately converge every active exact-bound Waypoint/Flight Path;
    // monotonic authPassThroughPolicyRevision fences make either cross-channel
    // arrival order safe, while heartbeat/WS recovery remains the fallback.
    try {
      const activeSessions = await getActiveSessions(schoolId);
      const activeStudentIds = [...new Set(activeSessions.map((session) => session.studentId))];
      const controlStates = await getClasspilotStudentControlStates(
        schoolId,
        activeStudentIds
      );
      const restrictedStudentIds = controlStates
        .filter((state) =>
          classpilotControlStateHasAuthRelevantRestriction(state.desiredState)
        )
        .map((state) => state.studentId);
      recordHeartbeatHotPathCounter(
        "restrictionAuthPolicyRefreshTargets",
        restrictedStudentIds.length
      );
      await syncClasspilotControlStatesToActiveDevices(
        schoolId,
        restrictedStudentIds
      );
    } catch {
      // The policy update remains committed and fail-closed. Exact heartbeat,
      // login, WS recovery, and explicit state requests re-deliver the fence.
      recordHeartbeatHotPathCounter("restrictionAuthPolicyRefreshFailure");
    }
    const schoolSettings = await getSettingsForSchool(schoolId);
    return res.json(await responseForPolicy(
      schoolId,
      record,
      schoolSettings?.blockedDomains
    ));
  } catch (error) {
    if (error instanceof ClasspilotSsoPolicyValidationError) {
      return res.status(error.status).json({
        error: error.message,
        code: error.code,
        issues: error.issues,
      });
    }
    if (error instanceof ClasspilotSsoPolicyRevisionConflictError) {
      const schoolId = res.locals.schoolId!;
      const schoolSettings = await getSettingsForSchool(schoolId);
      return res.status(error.status).json({
        error: error.message,
        code: error.code,
        current: await responseForPolicy(
          schoolId,
          error.current,
          schoolSettings?.blockedDomains
        ),
      });
    }
    return next(error);
  }
});

export default router;
