import crypto from "crypto";
import { Router, type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import type { ClasspilotStudentControlState, Heartbeat } from "../../schema/classpilot.js";
import { authenticate } from "../../middleware/authenticate.js";
import {
  requireSchoolContext,
  requireSchoolContextWithoutTenantBinding,
} from "../../middleware/requireSchoolContext.js";
import { requireActiveSchool } from "../../middleware/requireActiveSchool.js";
import { requireProductLicense } from "../../middleware/requireProductLicense.js";
import {
  requireDeviceAuth,
  requireDeviceAuthWithoutTenant,
  requireCryptographicDeviceAuth,
} from "../../middleware/requireDeviceAuth.js";
import {
  classPilotTileAdmission,
  releaseClassPilotTileAdmission,
} from "../../middleware/classpilotTileAdmission.js";
import { requireRole } from "../../middleware/requireRole.js";
import { requireClasspilotEntitlement } from "../../middleware/requireClasspilotEntitlement.js";
import {
  getDeviceById,
  getDevicesBySchool,
  createDevice,
  updateDevice,
  createHeartbeatAndRefreshPresence,
  refreshStudentSessionAuthorityWithoutTelemetry,
  getHeartbeatsByDevice,
  getHeartbeatsByDeviceInRange,
  getStudentById,
  getStudentsBySchool,
  createStudent,
  resolveSchoolForStudent,
  getSchoolById,
  getSchoolBySlug,
  getHeartbeatTrackingSettingsForSchool,
  getSettingsForSchool,
  withClasspilotSupervisionTelemetryAuthority,
  withClasspilotTeachingTelemetryAuthority,
  updateEnrollmentSettings,
  getStudentsForDevice,
  getActiveStudentForDevice,
  getStudentIdsHiddenFromClasspilotLoginRoster,
  getClasspilotLoginSessionAuthorities,
  getActiveSessionByDevice,
  getAdminEmailsBySchool,
  addCentralEmailRecipientForSchool,
  upsertSettings,
  getPendingMessagesForStudent,
  claimDueTeacherChatDeliveriesForBinding,
  getStudentByEmail,
  createEvidenceArtifact,
  createStudentTimelineEvent,
  endStudentSessionByRecoveryTokenHash,
  endStudentSessionExact,
  getReclaimableStudentSessionByManagedDevice,
  getReclaimableStudentSessionByRecoveryTokenHash,
  getBatchTileAccessForStaff,
  getClasspilotStudentControlState,
  getClasspilotScreenshotAuthorityProjection,
  withClasspilotScreenshotUploadAuthority,
  acknowledgeClasspilotStudentControlState,
  getHeartbeatTileHistoryBatch,
  getHeartbeatTileHistoryBatchSqlShapeIdentity,
  type ClassPilotHistoryTileAccess,
  revalidateClasspilotSafetyExactBinding,
  persistClasspilotCommandTargetAck,
  getProductLicenses,
  isAuthorizedClasspilotSessionStaff,
} from "../../services/storage.js";
import { sendSafetyAlertEmail } from "../../services/email.js";
import {
  InvalidTokenError,
  TokenExpiredError,
  verifyStudentToken,
} from "../../services/deviceJwt.js";
import { comparePassword } from "../../util/password.js";
import { updateDeviceStatus, updateDeviceClassification } from "../../realtime/student-statuses.js";
import {
  broadcastToStaffSessionLocal,
  sendToDeviceLocal,
  sendToStaffUserLocal,
} from "../../realtime/ws-broadcast.js";
import {
  publishWS,
  publishOrderedWS,
  recordLocalOrderedDelivery,
  setScreenshot,
  setClassBoundScreenshot,
  getScreenshot,
  getClassBoundScreenshot,
  setFlightPathStatus,
  recordScreenshotUpload,
  getScreenshots,
  getClassBoundScreenshots,
  screenshotBindingVersion,
  classBoundScreenshotBindingVersion,
  screenshotMatchesBinding,
  classBoundScreenshotMatchesBinding,
  type ClassBoundScreenshotBinding,
  type ScreenshotBinding,
  type ScreenshotData,
  type WsRedisTarget,
} from "../../realtime/ws-redis.js";
import { classifyUrl } from "../../services/aiClassification.js";
import { recordBrowserSafetyTimeline } from "./competitive.js";
import { runWithTenantContext } from "../../middleware/tenantContext.js";
import { scopedDeviceTargets } from "../../services/classpilotDeviceScope.js";
import { classPilotStudentDto, classPilotStudentDtos } from "../../util/safeStudent.js";
import {
  CLASSPILOT_ENROLLMENT_KEY_HEADER,
  enrollmentKeyFromRequest,
  finalizeStudentDeviceSessionIssuance,
  issueStudentDeviceSessionToken,
  setClassPilotNoStore,
  studentAuthenticationServiceError,
  validateEnrollmentKeyForSettings,
  verifyActiveStudentTokenSession,
} from "../../services/classpilotStudentAuth.js";
import {
  classpilotManualSharedSessionIssuanceEnabled,
  canShortCircuitAcceptedHeartbeat,
  type ClasspilotAcceptedHeartbeatThrottle,
  hashStudentSessionRecoveryToken,
  studentSessionRecoveryTokenFromAuthorization,
} from "../../services/classpilotStudentSessionAuthority.js";
import {
  effectiveSharedChromebookLoginMethod,
} from "../../services/classpilotSharedChromebook.js";
import { buildStudentFabState } from "../../services/classpilotFab.js";
import {
  classpilotCommandDeliveryPolicy,
  classpilotCommandExpiresAt,
} from "../../services/classpilotCommandDelivery.js";
import {
  extensionRuntimeTelemetrySchema,
  trackExtensionRuntimeTelemetry,
} from "../../services/runtimeTelemetry.js";
import {
  classpilotAckControlRevision,
  classpilotAckEnvelopeMatchesBinding,
} from "../../services/classpilotAckBinding.js";
import {
  classpilotCommandAckReceipt,
  terminalClasspilotCommandAckReceipt,
} from "../../services/classpilotAckReceipt.js";
import { classpilotControlStateExactBinding } from "../../services/classpilotControlStateFrame.js";
import { selectClasspilotSafetyEvidence } from "../../services/classpilotSafetyEvidence.js";
import { redisCommand, redisStore } from "../../middleware/rateLimiter.js";
import { getCoalescedTileAuthorization } from "../../services/classpilotTileAuthorization.js";
import {
  invalidateHeartbeatTileCaches,
  patchHeartbeatTileCacheClassifications,
  readHeartbeatTileCache,
  readHeartbeatTileCacheBatch,
  writeHeartbeatTileCache,
} from "../../services/heartbeatTileCache.js";
import {
  persistHeartbeatClassification,
  trackHeartbeatClassificationProducer,
} from "../../services/heartbeatClassificationBatcher.js";
import { selectRequestSchoolRole } from "../../services/schoolAuthorization.js";
import {
  bindHeartbeatHotPathHistoryFallbackSqlIdentity,
  recordHeartbeatHotPathCounter,
  recordHeartbeatTileHistoryFallbackDatabaseRead,
  recordHeartbeatHotPathTiming,
} from "../../services/heartbeatHotPathMetrics.js";
import {
  CLASSPILOT_REALTIME_STALE_AFTER_MS,
  classpilotPublicRealtimeBinding,
  classpilotRealtimeFresh,
  classpilotRealtimeOrderingKey,
  normalizeClasspilotPublicCapabilities,
  normalizeClasspilotPublicClassroomControls,
  patchClasspilotRealtimeClassification,
  readClasspilotRealtimeStatusBatch,
  writeClasspilotRealtimeStatus,
  type ClasspilotRealtimeStatus,
} from "../../services/classpilotRealtimeStatus.js";
import {
  effectiveClasspilotControlEnforcementHealth,
  serializeClasspilotStudentControlState,
} from "../../services/classpilotClassroomState.js";
import { recordClasspilotStudentSessionMonitoringEvent } from "../../services/classpilotMonitoringEvents.js";
import {
  publishClasspilotStudentSessionEnded,
  removeClasspilotDeviceAndPublishSessionEnds,
} from "../../services/classpilotStudentSessionLifecycle.js";
import { resolveCurrentClasspilotSafetyAction } from "../../services/classpilotSafetyAction.js";
import { resolveClasspilotEntitlement } from "../../services/classpilotEntitlement.js";
import { scheduleClasspilotCommandUpdate } from "../../services/classpilotCommandUpdateScheduler.js";
import { classpilotSchoolPolicyAuthorityEnvelope } from "../../services/classpilotCommandAuthority.js";
import {
  isClasspilotCapabilityActive,
  negotiateClasspilotProtocol,
  negotiateClasspilotSurfaceProtocol,
} from "../../services/classpilotProtocol.js";
import {
  readClasspilotStudentAuthGatePresence,
  readClasspilotStudentAuthGatePresenceBatch,
  renewClasspilotStudentAuthGatePresence,
} from "../../services/classpilotStudentAuthGatePresence.js";
import {
  classpilotStudentRosterTransferDecision,
  classpilotStudentSessionTransferDecision,
} from "../../services/classpilotStudentSessionTransfer.js";
import {
  classpilotKioskLaunchTicketPreflightSchema,
  classpilotKioskLaunchTicketRequestSchema,
  issueClasspilotKioskLaunchTicket,
} from "../../services/classpilotKioskLaunchTicket.js";
import {
  CLASSPILOT_MANAGED_DEVICE_CONTINUITY_CAPABILITY,
  CLASSPILOT_MANAGED_DEVICE_CONTINUITY_IP_REQUESTS_PER_MINUTE,
  CLASSPILOT_MANAGED_DEVICE_CONTINUITY_REQUESTS_PER_MINUTE,
  classpilotManagedDeviceAuthorizationPresented,
  classpilotManagedDeviceIssuanceRequestSchema,
  classpilotManagedDevicePreflightRequestSchema,
  classpilotManagedDevicePreflightTokenFromAuthorization,
  classpilotManagedDeviceProofFromAuthorization,
  issueClasspilotManagedDeviceContinuityProof,
  issueClasspilotManagedDevicePreflight,
  verifyClasspilotManagedDeviceContinuityProof,
  verifyClasspilotManagedDevicePreflight,
  type ClasspilotManagedDeviceContinuityProof,
} from "../../services/classpilotManagedDeviceContinuity.js";
import {
  parseClasspilotScreenshotAuthority,
  resolveClasspilotScreenshotPolicy,
  validateClasspilotScreenshotCapturedAt,
} from "../../services/classpilotScreenshotPolicy.js";
import {
  CLASSPILOT_SCREENSHOT_AVAILABLE_ORDERING_NAMESPACE,
  classpilotScreenshotAvailableEvent,
} from "../../services/classpilotScreenshotAvailability.js";
import { classpilotScreenshotFallback } from "../../services/classpilotScreenshotFallback.js";
import { claimClasspilotSafetyAlert } from "../../services/classpilotSafetyCooldown.js";
import {
  classpilotLiveViewNegotiationAuthority,
  isClasspilotLiveViewNegotiationActive,
} from "../../services/classpilotLiveViewNegotiation.js";
import { createClasspilotIceConfiguration } from "../../services/classpilotIceServers.js";
import {
  completeClasspilotEvidenceCaptureRequest,
  createClasspilotEvidenceCaptureRequest,
} from "../../services/classpilotEvidenceCapture.js";

bindHeartbeatHotPathHistoryFallbackSqlIdentity(
  getHeartbeatTileHistoryBatchSqlShapeIdentity()
);

const router = Router();

const STUDENT_AUTH_GATE_INGRESS_AT = "classpilotStudentAuthGateIngressAt";

function captureClasspilotStudentAuthGateIngress(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  // requestId captured this before the global Redis-backed limiter. Copy it
  // before the route-specific limiters so every async wait preserves the same
  // immutable causal boundary.
  res.locals[STUDENT_AUTH_GATE_INGRESS_AT] = req.requestReceivedAtMs;
  next();
}

const classpilotStudentAuthGatePresenceRequestSchema = z
  .object({
    schoolId: z.string().trim().regex(/^[A-Za-z0-9._:-]{1,128}$/),
    // A syntactically valid but unsupported protocol is negotiated below and
    // receives 426. Malformed or missing protocol input remains a 400.
    clientProtocolVersion: z.number().int().min(1).max(1_000),
    capabilities: z.array(z.string().trim().min(1).max(64)).max(32),
  })
  .strict();

const EXTENSION_SIGN_OUT_REASONS = new Set([
  "explicit_sign_out",
  "auto_locked_timeout",
  "auto_stale_wake",
]);

function normalizeExtensionSignOutReason(value: unknown): string {
  if (typeof value !== "string") return "explicit_sign_out";
  const normalized = value.trim().replace(/-/g, "_");
  return EXTENSION_SIGN_OUT_REASONS.has(normalized) ? normalized : "explicit_sign_out";
}

// The legacy pending-message table has no durable delivery marker. Keep a
// bounded, identity-bound process cache so reconnect recovery can advance
// through the inbox. The extension also receives stable ids and must retain
// its own dedupe history across API restarts.
type DeliveredMessageState = {
  studentId: string;
  messageIds: Set<string>;
  hasUnacknowledgedCommandMessages: boolean;
  lastHeartbeatAt: number;
  lastInboxCheckAt: number;
};
const deliveredMessages = new Map<string, DeliveredMessageState>();
const teacherReplyLastCheck = new Map<string, number>();
const PENDING_MESSAGE_RECONNECT_GAP_MS = 60_000;
const PENDING_MESSAGE_PERIODIC_CHECK_MS = 5 * 60_000;
const DELIVERED_MESSAGE_CACHE_TTL_MS = 24 * 60 * 60_000;
const DELIVERED_MESSAGE_CACHE_MAX_IDS = 500;
const PIN_LOGIN_MAX_FAILURES = 5;
const PIN_LOGIN_LOCKOUT_MS = 10 * 60 * 1000;
const PIN_LOGIN_LOCKOUT_SECONDS = PIN_LOGIN_LOCKOUT_MS / 1000;
const PIN_LOGIN_FAILURE_WINDOW_SECONDS = 10 * 60;
const fallbackPinLoginFailures = new Map<string, { count: number; lockedUntil: number; windowStart: number }>();
const REDIS_KEY_PREFIX = process.env.REDIS_PREFIX ?? "schoolpilot";

async function hasCurrentClassPilotLicense(schoolId: string): Promise<boolean> {
  return (await resolveClasspilotEntitlement(schoolId)).entitled;
}

async function requireUncachedClasspilotEntitlementForIssuance(
  res: Response,
  schoolId: string
): Promise<boolean> {
  const entitlement = await resolveClasspilotEntitlement(schoolId);
  if (entitlement.entitled) return true;
  res.status(403).json({
    error: "school_not_entitled",
    code: "CLASSPILOT_NOT_ENTITLED",
    reason: entitlement.reason,
    schoolActive: false,
    planStatus: "inactive",
  });
  return false;
}

function param(req: any, key: string): string {
  return String(req.params[key] ?? "");
}

// Per-IP rate limit for extension endpoints to prevent DB connection exhaustion
import rateLimit, { ipKeyGenerator } from "express-rate-limit";
function extensionIp(req: Request): string {
  return ipKeyGenerator(req.ip || req.socket.remoteAddress || "0.0.0.0");
}

function enrollmentKeyLimiterKey(req: Request): string {
  const provided =
    req.get(CLASSPILOT_ENROLLMENT_KEY_HEADER) ||
    (typeof (req as Request & { body?: { enrollmentKey?: unknown } }).body?.enrollmentKey === "string"
      ? String((req as Request & { body?: { enrollmentKey?: string } }).body?.enrollmentKey)
      : "");
  if (!provided) return `ip:${extensionIp(req)}`;
  return `enrollment-key:${crypto.createHash("sha256").update(provided).digest("hex").slice(0, 24)}`;
}

const extensionConfigLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 180,
  message: { error: "Too many setup/config requests, please wait" },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: extensionIp,
  store: redisStore("rl:classpilot:extension:config:"),
  passOnStoreError: true,
});

const classpilotKioskLaunchTicketLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  message: { error: "Too many kiosk launch requests, please wait" },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    const schoolSelector = String(req.get("x-school-id") || "");
    const selectorDigest = crypto
      .createHash("sha256")
      .update(schoolSelector)
      .digest("hex")
      .slice(0, 24);
    return `${enrollmentKeyLimiterKey(req)}:${selectorDigest}`;
  },
  store: redisStore("rl:classpilot:kiosk-launch-ticket:"),
  passOnStoreError: true,
});

const classpilotManagedDeviceContinuityLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: CLASSPILOT_MANAGED_DEVICE_CONTINUITY_REQUESTS_PER_MINUTE,
  message: {
    error: "Managed-device continuity is temporarily rate limited",
    code: "CLASSPILOT_MANAGED_DEVICE_CONTINUITY_RATE_LIMITED",
  },
  standardHeaders: true,
  legacyHeaders: false,
  // Never include the raw directory identifier in a rate-limit key. The
  // enrollment capability and school selector are reduced before Redis.
  keyGenerator: (req) => {
    const schoolSelector = String(req.get("x-school-id") || "");
    const selectorDigest = crypto
      .createHash("sha256")
      .update(schoolSelector)
      .digest("hex")
      .slice(0, 24);
    return `${enrollmentKeyLimiterKey(req)}:${selectorDigest}`;
  },
  store: redisStore("rl:classpilot:managed-device-continuity:"),
  passOnStoreError: true,
});

// A separate IP ceiling is intentionally stacked before the enrollment-key
// bucket. Otherwise an unauthenticated caller could rotate bogus keys and force
// unbounded school/settings reads through fresh key buckets. The ceiling still
// admits 800 managed devices performing preflight, issuance, and one retry
// behind a single school NAT in the same minute.
const classpilotManagedDeviceContinuityIpLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: CLASSPILOT_MANAGED_DEVICE_CONTINUITY_IP_REQUESTS_PER_MINUTE,
  message: {
    error: "Managed-device continuity is temporarily rate limited",
    code: "CLASSPILOT_MANAGED_DEVICE_CONTINUITY_RATE_LIMITED",
  },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: extensionIp,
  store: redisStore("rl:classpilot:managed-device-continuity-ip:"),
  passOnStoreError: true,
});

const extensionRosterLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 600,
  message: { error: "Too many roster requests, please wait" },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => [
    enrollmentKeyLimiterKey(req),
    String(req.query.schoolId || req.query.schoolSlug || ""),
    normalizeGradeLevel(req.query.gradeLevel) || "",
  ].join(":"),
  store: redisStore("rl:classpilot:extension:roster:"),
  passOnStoreError: true,
  handler: (_req, res, _next, options) => {
    recordHeartbeatHotPathCounter("manualSessionRosterRateLimited");
    res.status(options.statusCode).send(options.message);
  },
});

const extensionLoginLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  message: { error: "Too many login attempts, please wait" },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => [
    extensionIp(req),
    String(req.body?.schoolId || req.body?.schoolSlug || ""),
    String(req.body?.deviceId || ""),
    String(req.body?.studentId || req.body?.studentEmail || "").toLowerCase(),
  ].join(":"),
  store: redisStore("rl:classpilot:extension:login:"),
  passOnStoreError: true,
});

function recoveryCapabilityLimiterKey(req: Request): string {
  const rawAuthorization = Array.isArray(req.headers.authorization)
    ? req.headers.authorization[0] || ""
    : req.headers.authorization || "";
  if (!rawAuthorization) return `missing:${extensionIp(req)}`;
  return `recovery:${crypto.createHash("sha256").update(rawAuthorization).digest("hex").slice(0, 32)}`;
}

const extensionSessionReleaseCapabilityLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  message: { error: "Too many session release requests, please wait" },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: recoveryCapabilityLimiterKey,
  store: redisStore("rl:classpilot:extension:session-release-capability:"),
  passOnStoreError: true,
});

const extensionSessionReleaseIpLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 2_000,
  message: { error: "Too many session release requests, please wait" },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: extensionIp,
  store: redisStore("rl:classpilot:extension:session-release-ip:"),
  passOnStoreError: true,
});

const extensionSessionGatePresenceCapabilityLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  message: {
    error: "Student sign-in presence is temporarily rate limited",
    code: "SESSION_GATE_PRESENCE_RATE_LIMITED",
  },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: recoveryCapabilityLimiterKey,
  store: redisStore("rl:classpilot:extension:session-gate-presence-capability:"),
  passOnStoreError: true,
});

const extensionSessionGatePresenceIpLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10_000,
  message: {
    error: "Student sign-in presence is temporarily rate limited",
    code: "SESSION_GATE_PRESENCE_RATE_LIMITED",
  },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: extensionIp,
  store: redisStore("rl:classpilot:extension:session-gate-presence-ip:"),
  passOnStoreError: true,
});

const extensionRegisterLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  message: { error: "Too many registration attempts, please wait" },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => [
    extensionIp(req),
    String(req.body?.schoolId || req.body?.schoolSlug || ""),
    String(req.body?.deviceId || ""),
  ].join(":"),
  store: redisStore("rl:classpilot:extension:register:"),
  passOnStoreError: true,
});

function authenticatedDeviceKey(req: Request, res: Response): string {
  const schoolId = String(res?.locals?.schoolId || "unknown-school");
  const deviceId = String(res?.locals?.deviceId || req.params?.deviceId || "unknown-device");
  return `device:${schoolId}:${deviceId}`;
}

const deviceHeartbeatLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  message: { error: "Too many heartbeat requests, please wait" },
  standardHeaders: true,
  legacyHeaders: false,
  store: redisStore("rl:device:heartbeat:"),
  passOnStoreError: true,
  keyGenerator: authenticatedDeviceKey,
});

const deviceScreenshotLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  message: { error: "Too many screenshot uploads, please wait" },
  standardHeaders: true,
  legacyHeaders: false,
  store: redisStore("rl:device:screenshot:"),
  passOnStoreError: true,
  keyGenerator: authenticatedDeviceKey,
});

const extensionTelemetryLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  message: { error: "Too many telemetry events, please wait" },
  standardHeaders: true,
  legacyHeaders: false,
  store: redisStore("rl:device:telemetry:"),
  passOnStoreError: true,
  keyGenerator: authenticatedDeviceKey,
});

const deviceActionLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  message: { error: "Too many device requests, please wait" },
  standardHeaders: true,
  legacyHeaders: false,
  store: redisStore("rl:device:action:"),
  passOnStoreError: true,
  keyGenerator: authenticatedDeviceKey,
});

const staffAuth = [
  authenticate,
  requireSchoolContext,
  requireClasspilotEntitlement,
  requireRole("admin", "school_admin", "teacher", "office_staff"),
  requireActiveSchool,
  requireProductLicense("CLASSPILOT"),
] as const;

// Raw extension identifiers are device-management data, not teacher classroom
// targets. Teachers use the student-scoped command and batch tile contracts.
const deviceAdminAuth = [
  authenticate,
  requireSchoolContext,
  requireClasspilotEntitlement,
  requireRole("admin", "school_admin"),
  requireActiveSchool,
  requireProductLicense("CLASSPILOT"),
] as const;

// Tile reads arrive in aligned 40-device browser cohorts. Resolve all global
// authorization first, then hold an RLS client only around the indexed tenant
// query inside the handler. Never use this chain without a narrow tenant scope.
const tileReadAuth = [
  classPilotTileAdmission,
  authenticate,
  requireSchoolContextWithoutTenantBinding,
  requireClasspilotEntitlement,
  requireRole("admin", "school_admin", "teacher", "office_staff"),
  requireActiveSchool,
  requireProductLicense("CLASSPILOT"),
] as const;

async function withAuthorizedTileDevice<T>(
  req: Request,
  res: Response,
  deviceId: string,
  accessMode: "live" | "history",
  operation: (
    device: { schoolId: string },
    authorizedStudentIds: string[] | null,
    access: ClassPilotHistoryTileAccess
  ) => Promise<T> | T
): Promise<{ status: "not-found" } | { status: "ok"; value: T }> {
  const schoolId = res.locals.schoolId as string | undefined;
  // Preserve the previous selected-school boundary for super admins too. A
  // missing school context must never turn a device id into a cross-tenant
  // lookup capability.
  if (!schoolId) {
    return { status: "not-found" };
  }
  const role = selectRequestSchoolRole(req, res, [
    "admin",
    "school_admin",
    "teacher",
    "office_staff",
  ]) as
    | "admin"
    | "school_admin"
    | "teacher"
    | "office_staff";

  const rawSessionScope =
    req.sessionID || req.get("authorization") || "no-session";
  const sessionScope = crypto
    .createHash("sha256")
    .update(rawSessionScope)
    .digest("hex")
    .slice(0, 24);
  const access = await getCoalescedTileAuthorization(
    {
      schoolId,
      staffId: req.authUser!.id,
      role,
      isSuperAdmin: req.authUser!.isSuperAdmin,
      sessionScope,
    },
    deviceId,
    accessMode
  );
  if (!access) return { status: "not-found" as const };
  return {
    status: "ok" as const,
    value: await operation(access.device, access.authorizedStudentIds, access),
  };
}

function parseTileStudentIds(body: unknown):
  | { ok: true; studentIds: string[] }
  | { ok: false } {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false };
  }
  const raw = (body as { studentIds?: unknown }).studentIds;
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > 50) {
    return { ok: false };
  }
  const studentIds: string[] = [];
  const seen = new Set<string>();
  for (const value of raw) {
    if (typeof value !== "string") return { ok: false };
    const studentId = value.trim();
    if (!studentId || studentId.length > 200) return { ok: false };
    if (!seen.has(studentId)) {
      seen.add(studentId);
      studentIds.push(studentId);
    }
  }
  return studentIds.length > 0 ? { ok: true, studentIds } : { ok: false };
}

function parseTileTeachingSessionId(body: unknown):
  | { ok: true; teachingSessionId?: string }
  | { ok: false } {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false };
  }
  const value = (body as { teachingSessionId?: unknown }).teachingSessionId;
  if (value === undefined) return { ok: true };
  if (typeof value !== "string") return { ok: false };
  const teachingSessionId = value.trim();
  if (!teachingSessionId || teachingSessionId.length > 200) return { ok: false };
  return { ok: true, teachingSessionId };
}

function tileStaffScope(
  req: Request,
  res: Response,
  teachingSessionId?: string
) {
  return {
    schoolId: res.locals.schoolId as string,
    staffId: req.authUser!.id,
    role: selectRequestSchoolRole(req, res, [
      "admin",
      "school_admin",
      "teacher",
      "office_staff",
    ]) as
      | "admin"
      | "school_admin"
      | "teacher"
      | "office_staff",
    isSuperAdmin: req.authUser!.isSuperAdmin,
    ...(teachingSessionId ? { teachingSessionId } : {}),
  };
}

function safeTileHeartbeat(heartbeat: Heartbeat) {
  return {
    id: heartbeat.id,
    studentId: heartbeat.studentId,
    activeTabTitle: heartbeat.activeTabTitle,
    activeTabUrl: heartbeat.activeTabUrl,
    favicon: heartbeat.favicon,
    screenLocked: heartbeat.screenLocked,
    flightPathActive: heartbeat.flightPathActive,
    activeFlightPathName: heartbeat.activeFlightPathName,
    isSharing: heartbeat.isSharing,
    cameraActive: heartbeat.cameraActive,
    aiCategory: heartbeat.aiCategory,
    safetyAlert: heartbeat.safetyAlert,
    extensionVersion: heartbeat.extensionVersion,
    chromeVersion: heartbeat.chromeVersion,
    screenshotHealth: heartbeat.screenshotHealth,
    timestamp: heartbeat.timestamp,
  };
}

function publicScreenshotData(data: ScreenshotData) {
  return {
    screenshot: data.screenshot,
    timestamp: data.timestamp,
    ...(data.tabTitle !== undefined ? { tabTitle: data.tabTitle } : {}),
    ...(data.tabUrl !== undefined ? { tabUrl: data.tabUrl } : {}),
    ...(data.tabFavicon !== undefined ? { tabFavicon: data.tabFavicon } : {}),
    ...(data.bindingVersion?.startsWith("v2:")
      ? { bindingVersion: data.bindingVersion }
      : {}),
  };
}

function classpilotScreenshotStoreRequired(): boolean {
  return Boolean(
    process.env.REDIS_URL
    || process.env.NODE_ENV === "production"
    || process.env.APP_ENV === "production"
  );
}

function screenshotForAuthorizedStudent(
  data: ScreenshotData | null,
  access: {
    schoolId: string;
    deviceId: string;
    studentId: string;
    studentSessionId: string | null;
  }
) {
  if (!access.studentSessionId) return null;
  const binding: ScreenshotBinding = {
    schoolId: access.schoolId,
    deviceId: access.deviceId,
    studentId: access.studentId,
    studentSessionId: access.studentSessionId,
  };
  if (!data || !screenshotMatchesBinding(data, binding, { allowLegacy: true })) return null;
  return publicScreenshotData(data);
}

function classBoundScreenshotForAuthorizedStudent(
  data: ScreenshotData | null,
  binding: ClassBoundScreenshotBinding
) {
  if (!data || !classBoundScreenshotMatchesBinding(data, binding)) return null;
  return publicScreenshotData(data);
}

function normalizeGradeLevel(value: unknown): string | null {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  const normalized = raw
    .replace(/^grade\s+/i, "")
    .replace(/\s+grade$/i, "")
    .replace(/(\d+)(st|nd|rd|th)$/i, "$1");
  const lower = normalized.toLowerCase();
  if (lower === "k" || lower === "kg" || lower === "kindergarten") return "K";
  return normalized;
}

function gradeSortValue(grade: string): number {
  if (grade === "K") return 0;
  const numeric = Number(grade);
  return Number.isFinite(numeric) ? numeric : Number.POSITIVE_INFINITY;
}

function gradeLabel(grade: string): string {
  if (grade === "K") return "Kindergarten";
  const lower = grade.toLowerCase();
  if (lower === "pk" || lower === "pre-k" || lower === "prek") return "Pre-K";
  return /^(\d+)$/.test(grade) ? `Grade ${grade}` : grade;
}

function rosterGradesForStudents(students: Awaited<ReturnType<typeof getStudentsBySchool>>) {
  const counts = new Map<string, { studentCount: number; pinReadyCount: number }>();
  for (const student of students) {
    if (student.status !== "active") continue;
    const grade = normalizeGradeLevel(student.gradeLevel);
    if (!grade) continue;
    const current = counts.get(grade) || { studentCount: 0, pinReadyCount: 0 };
    current.studentCount += 1;
    if (student.classpilotPinHash) current.pinReadyCount += 1;
    counts.set(grade, current);
  }

  return Array.from(counts.entries())
    .sort(([a], [b]) => {
      const aSort = gradeSortValue(a);
      const bSort = gradeSortValue(b);
      if (aSort !== bSort) return aSort - bSort;
      return a.localeCompare(b);
    })
    .map(([value, countsForGrade]) => ({
      value,
      label: gradeLabel(value),
      ...countsForGrade,
    }));
}

function getPinFailureKey(schoolId: string, studentId: string): string {
  return `${schoolId}:${studentId}`;
}

async function tryRedisNumber(args: string[], label: string): Promise<number | undefined> {
  try {
    const value = await redisCommand(args);
    if (value === undefined || value === null) return undefined;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  } catch (error) {
    console.warn(`[ClassPilot] Redis ${label} failed; using local fallback.`);
    return undefined;
  }
}

async function tryRedisVoid(args: string[], label: string): Promise<boolean> {
  try {
    const value = await redisCommand(args);
    return value !== undefined;
  } catch (error) {
    console.warn(`[ClassPilot] Redis ${label} failed; using local fallback.`);
    return false;
  }
}

async function getPinLockout(schoolId: string, studentId: string): Promise<{ ok: true } | { ok: false; retryAfterSeconds: number }> {
  const key = getPinFailureKey(schoolId, studentId);
  const redisLockKey = `${REDIS_KEY_PREFIX}:classpilot:pin-lockout:${key}`;
  const redisLockTtlMs = await tryRedisNumber(["PTTL", redisLockKey], "pin lockout TTL");
  if (redisLockTtlMs !== undefined) {
    if (redisLockTtlMs > 0) {
      return { ok: false, retryAfterSeconds: Math.ceil(redisLockTtlMs / 1000) };
    }
    return { ok: true };
  }

  const failure = fallbackPinLoginFailures.get(key);
  if (!failure) {
    return { ok: true };
  }
  if (Date.now() - failure.windowStart > PIN_LOGIN_FAILURE_WINDOW_SECONDS * 1000) {
    fallbackPinLoginFailures.delete(key);
    return { ok: true };
  }
  if (failure.lockedUntil > 0 && failure.lockedUntil <= Date.now()) {
    fallbackPinLoginFailures.delete(key);
    return { ok: true };
  }
  if (failure.lockedUntil === 0) {
    return { ok: true };
  }
  return {
    ok: false,
    retryAfterSeconds: Math.ceil((failure.lockedUntil - Date.now()) / 1000),
  };
}

async function recordPinFailure(schoolId: string, studentId: string) {
  const key = getPinFailureKey(schoolId, studentId);
  const redisCountKey = `${REDIS_KEY_PREFIX}:classpilot:pin-failures:${key}`;
  const redisLockKey = `${REDIS_KEY_PREFIX}:classpilot:pin-lockout:${key}`;
  const count = await tryRedisNumber(["INCR", redisCountKey], "pin failure increment");
  if (count !== undefined) {
    if (count === 1) {
      await tryRedisVoid(["EXPIRE", redisCountKey, String(PIN_LOGIN_FAILURE_WINDOW_SECONDS)], "pin failure expiry");
    }
    if (count >= PIN_LOGIN_MAX_FAILURES) {
      await tryRedisVoid(["SET", redisLockKey, "1", "EX", String(PIN_LOGIN_LOCKOUT_SECONDS)], "pin lockout set");
      await tryRedisVoid(["DEL", redisCountKey], "pin failure clear");
    }
    return;
  }

  const current = fallbackPinLoginFailures.get(key);
  const now = Date.now();
  if (current?.lockedUntil && current.lockedUntil > now) return;
  const withinWindow = current && now - current.windowStart <= PIN_LOGIN_FAILURE_WINDOW_SECONDS * 1000;
  const localCount = (withinWindow ? current.count : 0) + 1;
  fallbackPinLoginFailures.set(key, {
    count: localCount,
    lockedUntil: localCount >= PIN_LOGIN_MAX_FAILURES ? now + PIN_LOGIN_LOCKOUT_MS : 0,
    windowStart: withinWindow ? current.windowStart : now,
  });
}

async function clearPinFailures(schoolId: string, studentId: string) {
  const key = getPinFailureKey(schoolId, studentId);
  await tryRedisVoid(
    ["DEL", `${REDIS_KEY_PREFIX}:classpilot:pin-failures:${key}`, `${REDIS_KEY_PREFIX}:classpilot:pin-lockout:${key}`],
    "pin failure clear"
  );
  fallbackPinLoginFailures.delete(key);
}

function publicRealtimeFields(snapshot: ClasspilotRealtimeStatus) {
  const age = Math.max(0, Date.now() - snapshot.observedAt);
  const activityFresh = snapshot.state === "active" && age < CLASSPILOT_REALTIME_STALE_AFTER_MS;
  const extensionCapabilities = new Set(
    normalizeClasspilotPublicCapabilities(snapshot.extensionCapabilities)
  );
  const acceptedCapabilities = new Set(
    normalizeClasspilotPublicCapabilities(snapshot.acceptedCapabilities)
  );
  const classroomControls = normalizeClasspilotPublicClassroomControls(
    snapshot.classroomControls
  );
  return {
    schemaVersion: snapshot.schemaVersion,
    eventVersion: 2,
    realtimeBinding: classpilotPublicRealtimeBinding(snapshot.studentSessionId),
    realtimeRevision: snapshot.revision,
    realtimeObservedAt: new Date(snapshot.observedAt).toISOString(),
    tabSnapshot: { schemaVersion: 1, revision: snapshot.tabSnapshotRevision ?? snapshot.revision },
    tabSnapshotRevision: snapshot.tabSnapshotRevision ?? snapshot.revision,
    extensionVersion: snapshot.extensionVersion ?? null,
    clientProtocolVersion: snapshot.clientProtocolVersion ?? null,
    capabilities: {
      exactTabCloseV1: extensionCapabilities.has("exactTabCloseV1"),
      exactTabCloseV2: acceptedCapabilities.has("exactTabCloseV2"),
      screenOnlyUnlockV1: extensionCapabilities.has("screenOnlyUnlockV1"),
      fabStateRevisionV1: extensionCapabilities.has("fabStateRevisionV1"),
      durableChatAckV1: extensionCapabilities.has("durableChatAckV1"),
      commandAckReceiptV1: extensionCapabilities.has("commandAckReceiptV1"),
      classroomOverlayRestoreV1: extensionCapabilities.has("classroomOverlayRestoreV1"),
      liveViewNegotiationV1: extensionCapabilities.has("liveViewNegotiationV1"),
      domainPreservingRestrictionsV1: extensionCapabilities.has("domainPreservingRestrictionsV1"),
      minExtensionVersion: "2.6.0",
    },
    activityFresh,
    activityState: snapshot.activityState,
    monitoringState: snapshot.state === "signed_out"
      ? "not_logged_in"
      : activityFresh
        ? "healthy"
        : "signal_lost",
    monitoringLostAt: snapshot.state === "active" && !activityFresh
      ? new Date(snapshot.observedAt + CLASSPILOT_REALTIME_STALE_AFTER_MS).toISOString()
      : null,
    classificationPending: snapshot.classificationPending,
    openTabCount: snapshot.openTabCount,
    tabsTruncated: snapshot.tabsTruncated,
    activeTabUrl: snapshot.activeTabUrl,
    activeTabTitle: snapshot.activeTabTitle,
    favicon: snapshot.favicon,
    allOpenTabs: snapshot.allOpenTabs,
    screenLocked: classroomControls.screenLocked,
    flightPathActive: classroomControls.flightPathActive,
    activeFlightPathName: classroomControls.activeFlightPathName,
    isSharing: classroomControls.isSharing,
    isScreenSharing: classroomControls.isSharing,
    cameraActive: classroomControls.cameraActive,
    aiClassification: snapshot.aiClassification ?? null,
    screenshotHealth: snapshot.screenshotHealth,
    classroomState: snapshot.classroomState,
    enforcementHealth: snapshot.enforcementHealth,
  };
}

type ClasspilotRealtimeControlAuthority = {
  teachingSessionId: string | null;
  supervisionContextId: string | null;
  revision: number;
};

function realtimeControlAuthority(
  state: Pick<ClasspilotStudentControlState, "teachingSessionId" | "supervisionContextId" | "revision"> | null | undefined
): ClasspilotRealtimeControlAuthority | undefined {
  if (!state) return undefined;
  return {
    teachingSessionId: state.teachingSessionId,
    supervisionContextId: state.supervisionContextId,
    revision: state.revision,
  };
}

async function publishRevisionedRealtimeUpdate(
  snapshot: ClasspilotRealtimeStatus,
  message: Record<string, unknown>,
  authority: ClasspilotRealtimeControlAuthority | undefined,
  options: {
    allowEndedBinding?: boolean;
    orderingNamespace?: string;
    orderingRevision?: string;
  } = {}
): Promise<void> {
  const realtimeOrderingKey = classpilotRealtimeOrderingKey(
    snapshot.schoolId,
    snapshot.deviceId
  );
  const orderedKey = options.orderingNamespace
    ? `${realtimeOrderingKey}:${options.orderingNamespace}`
    : realtimeOrderingKey;
  const revision = options.orderingRevision ?? String(snapshot.revision);
  const publishToAudience = async (options: {
    target: WsRedisTarget;
    scopedOrderedKey: string;
    deliverLocal: () => void;
  }) => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 300);
    timeout.unref?.();
    let outcome: Awaited<ReturnType<typeof publishOrderedWS>>;
    try {
      outcome = await publishOrderedWS(
        options.target,
        message,
        { orderedKey: options.scopedOrderedKey, revision, signal: controller.signal }
      );
    } finally {
      clearTimeout(timeout);
    }

    if (
      (outcome.status === "accepted" || outcome.status === "failed")
      && recordLocalOrderedDelivery(options.scopedOrderedKey, revision)
    ) {
      options.deliverLocal();
    }
  };

  if (authority?.teachingSessionId) {
    await runWithTenantContext({ schoolId: snapshot.schoolId }, () =>
      withClasspilotTeachingTelemetryAuthority({
        schoolId: snapshot.schoolId,
        teachingSessionId: authority.teachingSessionId!,
        studentId: snapshot.studentId,
        studentSessionId: snapshot.studentSessionId,
        deviceId: snapshot.deviceId,
        controlRevision: authority.revision,
        allowEndedBinding: options.allowEndedBinding,
      }, async (target) => {
        const scopedOrderedKey = `${orderedKey}:session:${target.teachingSessionId}`;
        await publishToAudience({
          target: {
            kind: "staff-session",
            schoolId: snapshot.schoolId,
            sessionId: target.teachingSessionId,
          },
          scopedOrderedKey,
          // Redis outages still permit local delivery, but only after current
          // control ownership and exact device binding were revalidated.
          deliverLocal: () => {
            broadcastToStaffSessionLocal(snapshot.schoolId, target.teachingSessionId, message);
          },
        });
      })
    );
    return;
  }

  const supervisionContextId = authority?.supervisionContextId;
  const controlRevision = authority?.revision;
  if (!supervisionContextId || !Number.isSafeInteger(controlRevision)) return;
  await runWithTenantContext({ schoolId: snapshot.schoolId }, () =>
    withClasspilotSupervisionTelemetryAuthority({
      schoolId: snapshot.schoolId,
      supervisionContextId,
      studentId: snapshot.studentId,
      studentSessionId: snapshot.studentSessionId,
      deviceId: snapshot.deviceId,
      controlRevision: controlRevision!,
      allowEndedBinding: options.allowEndedBinding,
    }, async (target) => {
      const scopedOrderedKey = `${orderedKey}:supervision:${target.supervisionContextId}`;
      await publishToAudience({
        target: {
          kind: "staff-user",
          schoolId: snapshot.schoolId,
          userId: target.assignedStaffId,
        },
        scopedOrderedKey,
        // Assigned office staff and teachers receive only the exact claimed
        // student's public DTO; raw device IDs remain server-internal.
        deliverLocal: () => {
          sendToStaffUserLocal(snapshot.schoolId, target.assignedStaffId, message);
        },
      });
    })
  );
}

async function broadcastStudentSignedOut(options: {
  schoolId: string;
  studentId: string;
  studentSessionId: string;
  deviceId: string;
  reason: string;
}) {
  await publishClasspilotStudentSessionEnded(options);
}

export async function publishCommittedStudentSessionReplacements(options: {
  schoolId: string;
  replacementDeviceId: string;
  replacedSessions: Array<{
    id: string;
    studentId: string;
    deviceId: string;
  }>;
}, dependencies: {
  broadcastEnded?: typeof broadcastStudentSignedOut;
  sendLocal?: typeof sendToDeviceLocal;
  publishRemote?: typeof publishWS;
} = {}): Promise<void> {
  const broadcastEnded = dependencies.broadcastEnded ?? broadcastStudentSignedOut;
  const sendLocal = dependencies.sendLocal ?? sendToDeviceLocal;
  const publishRemote = dependencies.publishRemote ?? publishWS;
  await Promise.allSettled(options.replacedSessions.flatMap((replacedSession) => {
    const tasks: Promise<unknown>[] = [broadcastEnded({
      schoolId: options.schoolId,
      studentId: replacedSession.studentId,
      studentSessionId: replacedSession.id,
      deviceId: replacedSession.deviceId,
      reason: "session_replaced",
    })];
    if (replacedSession.deviceId !== options.replacementDeviceId) {
      const replacedMessage = {
        type: "student-session-replaced",
        studentId: replacedSession.studentId,
        studentSessionId: replacedSession.id,
        deviceId: replacedSession.deviceId,
        replacementDeviceId: options.replacementDeviceId,
        timestamp: new Date().toISOString(),
      };
      sendLocal(options.schoolId, replacedSession.deviceId, replacedMessage);
      tasks.push(publishRemote({
        kind: "device",
        schoolId: options.schoolId,
        deviceId: replacedSession.deviceId,
      }, replacedMessage));
    }
    return tasks;
  }));
}

type ClasspilotStudentTransferAuthority = {
  studentSessionId: string;
  source: "gate_presence" | "stale_heartbeat";
  gatePresenceObservedAt?: number;
  gatePresenceExpiresAt?: number;
};

async function resolveClasspilotStudentTransferAuthority(options: {
  schoolId: string;
  studentId: string;
  targetDeviceId: string;
}): Promise<ClasspilotStudentTransferAuthority | null> {
  if (!isClasspilotCapabilityActive("studentAuthGatePresenceV1", {
    schoolId: options.schoolId,
  })) {
    return null;
  }
  const authorities = await getClasspilotLoginSessionAuthorities(options.schoolId, {
    studentId: options.studentId,
  });
  if (authorities.length > 1) {
    recordHeartbeatHotPathCounter("studentAuthGateTransferBlockedFresh");
    return null;
  }
  const [authority] = authorities;
  if (!authority || authority.deviceId === options.targetDeviceId) return null;
  if (authority.authKind !== "manual_shared") return null;
  const gatePresence = await readClasspilotStudentAuthGatePresence({
    schoolId: options.schoolId,
    studentId: authority.studentId,
    studentSessionId: authority.id,
    deviceId: authority.deviceId,
  });
  const decision = classpilotStudentSessionTransferDecision({
    authKind: authority.authKind,
    sessionStartedAt: authority.startedAt,
    latestHeartbeatAt: authority.latestHeartbeatAt,
    gatePresence,
  });
  if (decision.status === "unavailable") {
    recordHeartbeatHotPathCounter("studentAuthGateTransferStoreUnavailable");
    throw Object.assign(new Error("Student session transfer service is unavailable"), {
      status: 503,
      code: "STUDENT_SESSION_TRANSFER_UNAVAILABLE",
      expose: true,
    });
  }
  if (decision.status !== "allowed") {
    recordHeartbeatHotPathCounter("studentAuthGateTransferBlockedFresh");
    return null;
  }
  return {
    studentSessionId: authority.id,
    source: decision.source,
    ...(decision.source === "gate_presence" && gatePresence.status === "present"
      ? {
          gatePresenceObservedAt: gatePresence.presence.observedAt,
          gatePresenceExpiresAt: gatePresence.presence.expiresAt,
        }
      : {}),
  };
}

async function completeStudentDeviceLogin(options: {
  schoolId: string;
  deviceId: string;
  deviceName?: string | null;
  classId?: string | null;
  student: Awaited<ReturnType<typeof getStudentByEmail>>;
  authKind: "managed_profile" | "manual_shared";
  reclaimRecoveryToken?: string | null;
  managedDeviceContinuity?: ClasspilotManagedDeviceContinuityProof | null;
}) {
  if (!options.student) {
    throw new Error("Student required");
  }
  const student = options.student;
  if (student.schoolId !== options.schoolId || student.status !== "active") {
    throw Object.assign(new Error("Student is not enrolled"), {
      status: 403,
      code: "STUDENT_INACTIVE",
      expose: true,
    });
  }

  // Keep token/session issuance fail-closed even if a caller forgets its route
  // gate or the school is revoked between credential validation and issuance.
  const entitlement = await resolveClasspilotEntitlement(options.schoolId);
  if (!entitlement.entitled) {
    throw Object.assign(new Error("school_not_entitled"), {
      status: 403,
      code: "CLASSPILOT_NOT_ENTITLED",
      reason: entitlement.reason,
      expose: true,
    });
  }

  const targetDeviceId = options.managedDeviceContinuity?.deviceId ?? options.deviceId;
  const studentTransferAuthority = options.authKind === "manual_shared"
    ? await resolveClasspilotStudentTransferAuthority({
        schoolId: options.schoolId,
        studentId: student.id,
        targetDeviceId,
      })
    : null;

  const {
    device,
    session,
    replacedSessions,
    crossStudentHandoff,
    managedDeviceRecoveryTransition,
    effectiveDeviceId,
    studentToken,
    sessionRecoveryToken,
    studentTransferSource,
  } = await issueStudentDeviceSessionToken({
    schoolId: options.schoolId,
    deviceId: options.deviceId,
    deviceName: options.deviceName,
    classId: options.classId,
    student,
    authKind: options.authKind,
    reclaimRecoveryToken: options.reclaimRecoveryToken,
    managedDeviceContinuity: options.managedDeviceContinuity,
    studentTransferAuthority,
  });
  return finalizeStudentDeviceSessionIssuance({
    schoolId: options.schoolId,
    issuedSession: session,
    onCompensated: (endedSession) => broadcastStudentSignedOut({
      schoolId: options.schoolId,
      studentId: endedSession.studentId,
      studentSessionId: endedSession.id,
      deviceId: endedSession.deviceId,
      reason: "login_completion_failed",
    }),
    finalize: async () => {
  const studentEmail = student.email || undefined;
  if (options.authKind === "manual_shared") {
    recordHeartbeatHotPathCounter("manualSessionLoginIssued");
  }
  if (crossStudentHandoff) {
    recordHeartbeatHotPathCounter("manualSessionCrossStudentHandoff");
  }
  if (options.managedDeviceContinuity) {
    recordHeartbeatHotPathCounter("managedDeviceContinuityLoginIssued");
  }
  if (managedDeviceRecoveryTransition) {
    recordHeartbeatHotPathCounter("managedDeviceContinuityRecoveryTransitioned");
  }
  if (studentTransferSource === "gate_presence") {
    recordHeartbeatHotPathCounter("studentAuthGateTransferSucceededGate");
  } else if (studentTransferSource === "stale_heartbeat") {
    recordHeartbeatHotPathCounter("studentAuthGateTransferSucceededStale");
  }
  const replacedLegacyCount = replacedSessions.filter(
    (row) => row.authKind === "legacy"
  ).length;
  const replacedManualCount = replacedSessions.filter(
    (row) => row.authKind === "manual_shared"
  ).length;
  if (replacedLegacyCount > 0) {
    recordHeartbeatHotPathCounter("manualSessionLegacyReplaced", replacedLegacyCount);
  }
  if (replacedManualCount > 0) {
    recordHeartbeatHotPathCounter("manualSessionManualReplaced", replacedManualCount);
  }

  const tokenPayload = verifyStudentToken(studentToken);
  if (!(await verifyActiveStudentTokenSession(tokenPayload))) {
    throw Object.assign(new Error("Student session was replaced before login completed"), {
      status: 409,
      code: "STUDENT_SESSION_REPLACED",
    });
  }
  void runWithTenantContext({ schoolId: options.schoolId }, () =>
    recordClasspilotStudentSessionMonitoringEvent({
      schoolId: options.schoolId,
      studentId: student.id,
      studentSessionId: session.id,
      deviceId: effectiveDeviceId,
      type: "student_session_started",
    })
  ).catch(() => { /* lifecycle telemetry must not block login */ });

  // The transaction returns the exact rows it replaced. Publish from that
  // result instead of pre-reading mutable "current" sessions, and attempt every
  // tombstone without allowing a transport failure to invalidate the durable
  // login that already committed.
  await publishCommittedStudentSessionReplacements({
    schoolId: options.schoolId,
    replacementDeviceId: effectiveDeviceId,
    replacedSessions,
  });

  const controlState = await getClasspilotStudentControlState(
    options.schoolId,
    student.id
  );
  // The control state is student-scoped, but the login response is authorized
  // by this exact newly-issued student/session/device binding. Re-check as the
  // final awaited operation so a concurrent replacement cannot receive a
  // stale token together with an apparently authoritative snapshot.
  if (!(await verifyActiveStudentTokenSession(tokenPayload))) {
    throw Object.assign(new Error("Student session was replaced before login completed"), {
      status: 409,
      code: "STUDENT_SESSION_REPLACED",
    });
  }
  const classroomState = controlState
    ? serializeClasspilotStudentControlState(controlState)
    : null;

  return {
    success: true,
    schoolId: options.schoolId,
    studentId: student.id,
    studentSessionId: session.id,
    exactBinding: classpilotControlStateExactBinding({
      schoolId: options.schoolId,
      deviceId: effectiveDeviceId,
      studentId: student.id,
      studentSessionId: session.id,
      controlRevision: classroomState?.revision ?? 0,
    }),
    device,
    student: classPilotStudentDto(student),
    studentToken,
    manualExpiresInSeconds: 300,
    ...(options.managedDeviceContinuity
      ? {
          managedDeviceContinuityAccepted: true,
          effectiveDeviceId,
        }
      : {}),
    ...(sessionRecoveryToken
      ? { sessionRecovery: { token: sessionRecoveryToken } }
      : {}),
    classroomState,
  };
    },
  });
}

async function recordRemoteActionTimeline(options: {
  schoolId: string;
  deviceIds: string[];
  action: string;
  actorUserId: string;
  metadata?: Record<string, unknown>;
}) {
  await Promise.all(options.deviceIds.slice(0, 100).map(async (deviceId) => {
    const active = await getActiveStudentForDevice(deviceId);
    const studentId = active?.student.id;
    if (!studentId) return;
    await createStudentTimelineEvent({
      schoolId: options.schoolId,
      studentId,
      eventType: "remote_action",
      sourceType: "classpilot",
      sourceId: deviceId,
      title: `Remote action: ${options.action}`,
      summary: null,
      actorUserId: options.actorUserId,
      metadata: {
        deviceId,
        action: options.action,
        ...options.metadata,
      },
    });
  }));
}

// ============================================================================
// Per-device heartbeat rate limiting (item #9)
// ============================================================================
const deviceLastHeartbeat = new Map<string, ClasspilotAcceptedHeartbeatThrottle>();
const HEARTBEAT_MIN_INTERVAL_MS = 5_000; // 5 seconds minimum between heartbeats
const RATE_LIMIT_CLEANUP_INTERVAL_MS = 60_000; // clean stale entries every 60s
const MAX_DEVICE_HEARTBEAT_ENTRIES = 20_000;
const MAX_DELIVERED_MESSAGE_DEVICES = 20_000;
const MAX_TEACHER_REPLY_CHECKS = 20_000;
const MAX_FALLBACK_SCHOOLS = 4_096;
const MAX_FALLBACK_ROSTER_KEYS = 20_000;

function setBoundedMap<K, V>(map: Map<K, V>, key: K, value: V, maximum: number): void {
  map.delete(key);
  while (map.size >= maximum) {
    const oldest = map.keys().next().value as K | undefined;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
  map.set(key, value);
}

// Periodic cleanup of stale rate-limit entries. The API listener owns process
// lifetime; this maintenance timer should not strand migration/test workers.
const heartbeatRateLimitCleanupTimer = setInterval(() => {
  const cutoff = Date.now() - 120_000; // remove entries older than 2 min
  for (const [key, state] of deviceLastHeartbeat) {
    if (state.acceptedAt < cutoff) deviceLastHeartbeat.delete(key);
  }
  const deliveredCutoff = Date.now() - DELIVERED_MESSAGE_CACHE_TTL_MS;
  for (const [key, state] of deliveredMessages) {
    if (state.lastHeartbeatAt < deliveredCutoff) deliveredMessages.delete(key);
  }
  for (const [key, ts] of teacherReplyLastCheck) {
    if (ts < cutoff) teacherReplyLastCheck.delete(key);
  }
  for (const [key, entry] of fallbackSchoolAutoCreations) {
    if (entry.windowStart < Date.now() - AUTO_CREATE_WINDOW_MS) fallbackSchoolAutoCreations.delete(key);
  }
  for (const [key, entry] of fallbackRosterFetches) {
    if (entry.windowStart < Date.now() - ROSTER_FETCH_WINDOW_SECONDS * 1_000) fallbackRosterFetches.delete(key);
  }
}, RATE_LIMIT_CLEANUP_INTERVAL_MS);
heartbeatRateLimitCleanupTimer.unref?.();

// ============================================================================
// Per-school auto-creation throttle — anti-spam guard
// /extension/register can auto-create a student record when a Chromebook signs in
// with an unrecognized email at a known school domain. To prevent abuse (someone
// creating thousands of fake students at a school's domain), we cap auto-creations
// at MAX_AUTO_CREATIONS per school per hour. Caps don't block real first-day-of-
// school enrollment unless a single school enrolls >100 students in an hour, which
// is rare and would surface as a legitimate signal worth investigating anyway.
// ============================================================================
const fallbackSchoolAutoCreations = new Map<string, { count: number; windowStart: number }>();
const AUTO_CREATE_WINDOW_MS = 60 * 60 * 1000; // 1 hour
const AUTO_CREATE_WINDOW_SECONDS = AUTO_CREATE_WINDOW_MS / 1000;
const MAX_AUTO_CREATIONS = 100;
const ROSTER_FETCH_WINDOW_SECONDS = 60;
const MAX_ROSTER_FETCHES_PER_WINDOW = 300;
const fallbackRosterFetches = new Map<string, { count: number; windowStart: number }>();

async function recordAutoCreation(schoolId: string): Promise<boolean> {
  const redisKey = `${REDIS_KEY_PREFIX}:classpilot:auto-creations:${schoolId}`;
  const redisCount = await tryRedisNumber(["INCR", redisKey], "auto-creation increment");
  if (redisCount !== undefined) {
    if (redisCount === 1) {
      await tryRedisVoid(["EXPIRE", redisKey, String(AUTO_CREATE_WINDOW_SECONDS)], "auto-creation expiry");
    }
    return redisCount <= MAX_AUTO_CREATIONS;
  }

  const now = Date.now();
  const entry = fallbackSchoolAutoCreations.get(schoolId);
  if (!entry || now - entry.windowStart > AUTO_CREATE_WINDOW_MS) {
    setBoundedMap(
      fallbackSchoolAutoCreations,
      schoolId,
      { count: 1, windowStart: now },
      MAX_FALLBACK_SCHOOLS
    );
    return true;
  }
  if (entry.count >= MAX_AUTO_CREATIONS) return false;
  entry.count++;
  return true;
}

async function enforceSharedRosterFetchThrottle(
  schoolId: string,
  gradeLevel: string | null
): Promise<{ ok: true } | { ok: false; retryAfterSeconds: number }> {
  const gradeKey = gradeLevel || "grades";
  const key = `${schoolId}:${gradeKey}`;
  const redisKey = `${REDIS_KEY_PREFIX}:classpilot:roster-fetches:${key}`;
  const redisCount = await tryRedisNumber(["INCR", redisKey], "roster fetch increment");
  if (redisCount !== undefined) {
    if (redisCount === 1) {
      await tryRedisVoid(["EXPIRE", redisKey, String(ROSTER_FETCH_WINDOW_SECONDS)], "roster fetch expiry");
    }
    if (redisCount <= MAX_ROSTER_FETCHES_PER_WINDOW) return { ok: true };
    const ttl = await tryRedisNumber(["TTL", redisKey], "roster fetch TTL");
    return { ok: false, retryAfterSeconds: ttl && ttl > 0 ? ttl : ROSTER_FETCH_WINDOW_SECONDS };
  }

  const now = Date.now();
  const current = fallbackRosterFetches.get(key);
  if (!current || now - current.windowStart > ROSTER_FETCH_WINDOW_SECONDS * 1000) {
    setBoundedMap(
      fallbackRosterFetches,
      key,
      { count: 1, windowStart: now },
      MAX_FALLBACK_ROSTER_KEYS
    );
    return { ok: true };
  }
  if (current.count >= MAX_ROSTER_FETCHES_PER_WINDOW) {
    return {
      ok: false,
      retryAfterSeconds: Math.max(1, Math.ceil((ROSTER_FETCH_WINDOW_SECONDS * 1000 - (now - current.windowStart)) / 1000)),
    };
  }
  current.count++;
  return { ok: true };
}

// ============================================================================
// Tracking window enforcement (shared utility)
// ============================================================================
import { isWithinTrackingWindow } from "../../services/schoolHours.js";

// ============================================================================
// School Status Endpoints
// ============================================================================

// POST /api/classpilot/school/status - Check school status from email domain or token
//
// Information disclosure note: when called WITHOUT a valid studentToken, this endpoint
// is unauthenticated and reachable from any extension instance. We deliberately return
// only the minimum fields needed for the extension to decide whether to keep heartbeating.
// We do NOT leak schoolId, planStatus, or human-readable status strings to unauthenticated
// callers — those would help an attacker enumerate schools and licensing tiers.
router.post("/school/status", extensionConfigLimiter, async (req, res, next) => {
  try {
    const { studentEmail, studentToken } = req.body;

    // Token-based lookup (authenticated): return full status
    if (studentToken) {
      let payload;
      try {
        payload = verifyStudentToken(studentToken);
      } catch (error) {
        if (
          !(error instanceof InvalidTokenError) &&
          !(error instanceof TokenExpiredError)
        ) {
          return next(studentAuthenticationServiceError(error));
        }
        // Invalid or expired tokens may use the deliberately minimal email
        // lookup below when the extension supplies studentEmail.
      }

      if (payload) {
        try {
          const hasActiveSession = await runWithTenantContext(
            { schoolId: payload.schoolId },
            () => verifyActiveStudentTokenSession(payload)
          );
          if (!hasActiveSession) {
            return res.status(401).json({ error: "Student session is no longer active" });
          }
          const entitlement = await resolveClasspilotEntitlement(payload.schoolId);
          if (!entitlement.entitled) {
            return res.status(403).json({
              error: "school_not_entitled",
              code: "CLASSPILOT_NOT_ENTITLED",
              reason: entitlement.reason,
              schoolActive: false,
              planStatus: "inactive",
              schoolSessionVersion: 1,
            });
          }
          const school = await getSchoolById(payload.schoolId);
          if (school) {
            return res.json({
              schoolId: school.id,
              schoolActive: true,
              planStatus: school.planStatus || "active",
              status: school.status,
              schoolSessionVersion: 1,
            });
          }
        } catch (error) {
          // A verified token followed by a database/pool failure is a service
          // outage, never an invalid credential or unauthenticated fallback.
          return next(studentAuthenticationServiceError(error));
        }
      }
    }

    if (!studentEmail) {
      return res.status(400).json({ error: "studentEmail required" });
    }

    // Email-based lookup (unauthenticated): return minimal info to avoid enumeration
    const result = await resolveSchoolForStudent(studentEmail);
    if (!result) {
      return res.status(401).json({ error: "Not eligible" });
    }
    const entitlement = await resolveClasspilotEntitlement(result.school.id);

    // Minimal response — schoolId, planStatus, and status omitted intentionally.
    // The extension calls /extension/register next which returns the full JWT with schoolId.
    return res.json({
      schoolActive: entitlement.entitled,
      schoolSessionVersion: 1,
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/classpilot/school/status - Also support GET
router.get("/school/status", async (_req, res) => {
  return res.json({ status: "ok", message: "Use POST with studentEmail" });
});

async function authorizeClasspilotKioskLaunch(
  res: Response,
  schoolId: string,
  enrollmentKey: string | undefined
) {
  const school = await getSchoolById(schoolId);
  const settings = school ? await getSettingsForSchool(schoolId) : undefined;
  if (!school) {
    res.status(404).json({ error: "Kiosk launch is not configured" });
    return null;
  }
  const keyCheck = validateEnrollmentKeyForSettings(settings, enrollmentKey, {
    requireConfiguredKey: true,
  });
  if (!keyCheck.ok) {
    res.status(keyCheck.status).json({ error: keyCheck.error });
    return null;
  }
  if (!(await requireUncachedClasspilotEntitlementForIssuance(res, schoolId))) {
    return null;
  }

  const now = new Date();
  const licenses = await getProductLicenses(schoolId);
  const passpilotActive = licenses.some(
    (license) =>
      license.product === "PASSPILOT" &&
      license.status === "active" &&
      (!license.expiresAt || license.expiresAt.getTime() > now.getTime())
  );
  if (
    !passpilotActive ||
    school.kioskEnabled === false ||
    !school.kioskPinHash
  ) {
    res.status(403).json({
      error: "PassPilot kiosk is not available",
      code: "PASSPILOT_KIOSK_UNAVAILABLE",
    });
    return null;
  }
  return school;
}

async function authorizeClasspilotManagedDeviceContinuity(
  res: Response,
  schoolId: string,
  enrollmentKey: string | undefined
) {
  const school = await getSchoolById(schoolId);
  const settings = school ? await getSettingsForSchool(schoolId) : undefined;
  if (!school) {
    res.status(404).json({
      error: "Managed-device continuity is not configured",
      code: "CLASSPILOT_MANAGED_DEVICE_CONTINUITY_UNAVAILABLE",
    });
    return null;
  }
  const keyCheck = validateEnrollmentKeyForSettings(settings, enrollmentKey, {
    requireConfiguredKey: true,
  });
  if (!keyCheck.ok) {
    res.status(keyCheck.status).json({
      error: "Managed-device continuity authorization failed",
      code: "CLASSPILOT_MANAGED_DEVICE_CONTINUITY_UNAUTHORIZED",
    });
    return null;
  }
  if (!(await requireUncachedClasspilotEntitlementForIssuance(res, schoolId))) {
    return null;
  }
  if (!settings?.sharedChromebookSignInEnabled) {
    res.status(403).json({
      error: "Managed-device continuity is not available",
      code: "CLASSPILOT_MANAGED_DEVICE_CONTINUITY_UNAVAILABLE",
    });
    return null;
  }
  return school;
}

// POST /api/classpilot/kiosk/launch-ticket/preflight - Authenticate the
// exact school/capability envelope before the extension reads the enterprise
// directory id. This request never accepts an identifier in its body.
router.post(
  "/kiosk/launch-ticket/preflight",
  classpilotKioskLaunchTicketLimiter,
  async (req, res, next) => {
    try {
      setClassPilotNoStore(res);
      const parsed = classpilotKioskLaunchTicketPreflightSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({
          error: "Invalid kiosk launch preflight request",
          code: "CLASSPILOT_KIOSK_LAUNCH_PREFLIGHT_INVALID_REQUEST",
        });
      }
      const schoolId = String(req.get("x-school-id") || "").trim();
      if (!schoolId || schoolId.length > 128) {
        return res.status(400).json({
          error: "School authentication is required",
          code: "CLASSPILOT_KIOSK_LAUNCH_SCHOOL_REQUIRED",
        });
      }
      const protocol = negotiateClasspilotProtocol({
        clientProtocolVersion: parsed.data.clientProtocolVersion,
        advertisedCapabilities: parsed.data.capabilities,
        scope: { serverOrigin: process.env.PUBLIC_BASE_URL, schoolId },
      });
      const v2Accepted =
        protocol.acceptedCapabilities.includes("scopedAuthorityChecksV1") &&
        protocol.acceptedCapabilities.includes("kioskLaunchTicketV2");
      const enrollmentKey = enrollmentKeyFromRequest(req);

      return await runWithTenantContext({ schoolId }, async () => {
        if (!(await authorizeClasspilotKioskLaunch(res, schoolId, enrollmentKey))) {
          return;
        }
        return res.json({
          serverProtocolVersion: protocol.serverProtocolVersion,
          acceptedCapabilities: v2Accepted
            ? ["scopedAuthorityChecksV1", "kioskLaunchTicketV2"]
            : [],
        });
      });
    } catch (err) {
      next(err);
    }
  }
);

// POST /api/classpilot/kiosk/launch-ticket - Enrollment-key-authenticated,
// one-use continuity handoff to PassPilot. The school is selected only by the
// X-School-Id authentication envelope and verified against that exact school's
// enrollment key; school identity is intentionally forbidden in the body.
router.post(
  "/kiosk/launch-ticket",
  classpilotKioskLaunchTicketLimiter,
  async (req, res, next) => {
    try {
      setClassPilotNoStore(res);
      const parsed = classpilotKioskLaunchTicketRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({
          error: "Invalid kiosk launch ticket request",
          code: "CLASSPILOT_KIOSK_LAUNCH_TICKET_INVALID_REQUEST",
        });
      }

      const schoolId = String(req.get("x-school-id") || "").trim();
      if (!schoolId || schoolId.length > 128) {
        return res.status(400).json({
          error: "School authentication is required",
          code: "CLASSPILOT_KIOSK_LAUNCH_SCHOOL_REQUIRED",
        });
      }
      const protocol = negotiateClasspilotProtocol({
        clientProtocolVersion: parsed.data.clientProtocolVersion,
        advertisedCapabilities: parsed.data.capabilities,
        scope: {
          serverOrigin: process.env.PUBLIC_BASE_URL,
          schoolId,
        },
      });
      const enrollmentKey = enrollmentKeyFromRequest(req);

      return await runWithTenantContext({ schoolId }, async () => {
        if (!(await authorizeClasspilotKioskLaunch(res, schoolId, enrollmentKey))) return;

        const v2Accepted =
          protocol.acceptedCapabilities.includes("scopedAuthorityChecksV1") &&
          protocol.acceptedCapabilities.includes("kioskLaunchTicketV2");
        const v1Accepted = protocol.acceptedCapabilities.includes("kioskLaunchTicketV1");
        if (!v2Accepted && !v1Accepted) {
          return res.status(426).json({
            error: "Kiosk launch tickets are not available for this client",
            code: "CLASSPILOT_KIOSK_LAUNCH_TICKET_CAPABILITY_REQUIRED",
            ...protocol,
          });
        }

        const issued = await issueClasspilotKioskLaunchTicket({
          schoolId,
          directoryDeviceId: parsed.data.directoryDeviceId,
          version: v2Accepted ? 2 : 1,
        });
        return res.status(201).json({
          ticket: issued.ticket,
          expiresInSeconds: issued.expiresInSeconds,
          expiresAt: issued.expiresAt.toISOString(),
          ...protocol,
        });
      });
    } catch (err) {
      next(err);
    }
  }
);

// POST /api/classpilot/extension/device-continuity/preflight - Authenticate
// the exact school and repaired-client authority before enterprise APIs are
// allowed to read a directory identifier. This strict request cannot carry a
// device identifier.
router.post(
  "/extension/device-continuity/preflight",
  classpilotManagedDeviceContinuityIpLimiter,
  classpilotManagedDeviceContinuityLimiter,
  async (req, res, next) => {
    try {
      setClassPilotNoStore(res);
      const parsed = classpilotManagedDevicePreflightRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({
          error: "Invalid managed-device continuity preflight request",
          code: "CLASSPILOT_MANAGED_DEVICE_CONTINUITY_PREFLIGHT_INVALID",
        });
      }
      const schoolId = String(req.get("x-school-id") || "").trim();
      if (!/^[A-Za-z0-9._:-]{1,128}$/.test(schoolId)) {
        return res.status(400).json({
          error: "School authentication is required",
          code: "CLASSPILOT_MANAGED_DEVICE_CONTINUITY_SCHOOL_REQUIRED",
        });
      }
      const enrollmentKey = enrollmentKeyFromRequest(req);
      const protocol = negotiateClasspilotProtocol({
        clientProtocolVersion: parsed.data.clientProtocolVersion,
        advertisedCapabilities: parsed.data.capabilities,
        scope: { serverOrigin: process.env.PUBLIC_BASE_URL, schoolId },
      });
      return await runWithTenantContext({ schoolId }, async () => {
        if (!(await authorizeClasspilotManagedDeviceContinuity(
          res,
          schoolId,
          enrollmentKey
        ))) {
          return;
        }
        if (
          !protocol.acceptedCapabilities.includes("scopedAuthorityChecksV1")
          || !protocol.acceptedCapabilities.includes("kioskLaunchTicketV2")
        ) {
          return res.status(426).json({
            error: "Managed-device continuity is not available for this client",
            code: "CLASSPILOT_MANAGED_DEVICE_CONTINUITY_CAPABILITY_REQUIRED",
            serverProtocolVersion: protocol.serverProtocolVersion,
            acceptedCapabilities: protocol.acceptedCapabilities,
          });
        }
        const issued = issueClasspilotManagedDevicePreflight({ schoolId });
        recordHeartbeatHotPathCounter("managedDeviceContinuityPreflightAccepted");
        return res.json({
          serverProtocolVersion: 3,
          acceptedCapabilities: [
            "scopedAuthorityChecksV1",
            "kioskLaunchTicketV2",
            CLASSPILOT_MANAGED_DEVICE_CONTINUITY_CAPABILITY,
          ],
          preflightToken: issued.preflightToken,
          expiresInSeconds: issued.expiresInSeconds,
          expiresAt: issued.expiresAt.toISOString(),
        });
      });
    } catch (err) {
      next(err);
    }
  }
);

// POST /api/classpilot/extension/device-continuity - Accept the raw managed
// directory identifier only after a signed preflight and the enrollment-key
// authority are both revalidated. The identifier is immediately reduced to a
// school-scoped opaque binding and is never stored, logged, or returned.
router.post(
  "/extension/device-continuity",
  classpilotManagedDeviceContinuityIpLimiter,
  classpilotManagedDeviceContinuityLimiter,
  async (req, res, next) => {
    try {
      setClassPilotNoStore(res);
      const parsed = classpilotManagedDeviceIssuanceRequestSchema.safeParse(req.body);
      const schoolId = String(req.get("x-school-id") || "").trim();
      const preflightToken = classpilotManagedDevicePreflightTokenFromAuthorization(
        req.headers.authorization
      );
      if (
        !parsed.success
        || !/^[A-Za-z0-9._:-]{1,128}$/.test(schoolId)
        || !preflightToken
      ) {
        return res.status(400).json({
          error: "Invalid managed-device continuity request",
          code: "CLASSPILOT_MANAGED_DEVICE_CONTINUITY_INVALID",
        });
      }
      const enrollmentKey = enrollmentKeyFromRequest(req);
      return await runWithTenantContext({ schoolId }, async () => {
        if (!(await authorizeClasspilotManagedDeviceContinuity(
          res,
          schoolId,
          enrollmentKey
        ))) {
          return;
        }
        if (!verifyClasspilotManagedDevicePreflight({
          token: preflightToken,
          schoolId,
        })) {
          return res.status(401).json({
            error: "Managed-device continuity authorization failed",
            code: "CLASSPILOT_MANAGED_DEVICE_CONTINUITY_UNAUTHORIZED",
          });
        }
        const issued = issueClasspilotManagedDeviceContinuityProof({
          schoolId,
          directoryDeviceId: parsed.data.directoryDeviceId,
          recoveryToken: parsed.data.recoveryToken,
        });
        recordHeartbeatHotPathCounter("managedDeviceContinuityProofIssued");
        return res.status(201).json({
          continuityProof: issued.continuityProof,
          expiresInSeconds: issued.expiresInSeconds,
          expiresAt: issued.expiresAt.toISOString(),
        });
      });
    } catch (err) {
      next(err);
    }
  }
);

// GET /api/classpilot/extension/login-config - Shared Chromebook login capabilities
router.get("/extension/login-config", extensionConfigLimiter, async (req, res, next) => {
  try {
    setClassPilotNoStore(res);
    const schoolIdParam = String(req.query.schoolId || "").trim();
    const schoolSlug = String(req.query.schoolSlug || "").trim();
    const enrollmentKey = enrollmentKeyFromRequest(req);

    const school = schoolIdParam
      ? await getSchoolById(schoolIdParam)
      : schoolSlug
        ? await getSchoolBySlug(schoolSlug)
        : undefined;
    if (!school || school.status !== "active") {
      return res.status(404).json({ error: "Shared sign-in is not configured", setupRequired: true });
    }

    await runWithTenantContext({ schoolId: school.id }, async () => {
      if (!(await hasCurrentClassPilotLicense(school.id))) {
        return res.status(403).json({ error: "ClassPilot license is not active" });
      }

      const regSettings = await getSettingsForSchool(school.id);
      const keyCheck = validateEnrollmentKeyForSettings(regSettings, enrollmentKey, {
        requireConfiguredKey: true,
      });
      if (!keyCheck.ok) {
        return res.status(keyCheck.status).json({ error: keyCheck.error, setupRequired: true });
      }
      if (!regSettings?.sharedChromebookSignInEnabled) {
        return res.status(403).json({
          error: "Shared Chromebook sign-in is not enabled for this school",
          sharedSignInEnabled: false,
          loginMethod: "name_pin",
          pinLoginEnabled: false,
        });
      }
      const loginMethod = effectiveSharedChromebookLoginMethod(regSettings);

      // PassPilot kiosk launch support: the extension's auth gate offers a
      // "PassPilot Kiosk" button only when the kiosk would actually work.
      // Mirrors validateKiosk in routes/passpilot/kiosk.ts (active license +
      // kiosk enabled + PIN configured). schoolId lets the gate build the
      // kiosk URL — safe to return here: the caller already presented the
      // school's enrollment key, and the UUID appears in kiosk URLs/QR codes.
      const licenses = await getProductLicenses(school.id);
      const passpilotActive = licenses.some(
        (l) => l.product === "PASSPILOT" && l.status === "active"
      );
      const passpilotKioskAvailable =
        passpilotActive && school.kioskEnabled !== false && Boolean(school.kioskPinHash);

      return res.json({
        sharedSignInEnabled: true,
        loginMethod,
        pinLoginEnabled: loginMethod === "name_pin",
        schoolName: regSettings.schoolName || school.name,
        schoolId: school.id,
        passpilotKioskAvailable,
      });
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/classpilot/extension/login-roster - Minimal roster for optional Name + PIN login
router.get("/extension/login-roster", extensionRosterLimiter, async (req, res, next) => {
  try {
    setClassPilotNoStore(res);
    const recoveryToken = studentSessionRecoveryTokenFromAuthorization(
      req.headers.authorization
    );
    const managedDeviceAuthorizationPresented =
      classpilotManagedDeviceAuthorizationPresented(req.headers.authorization);
    const managedDeviceProofToken = classpilotManagedDeviceProofFromAuthorization(
      req.headers.authorization
    );
    const schoolIdParam = String(req.query.schoolId || "").trim();
    const schoolSlug = String(req.query.schoolSlug || "").trim();
    const gradeLevel = normalizeGradeLevel(req.query.gradeLevel);
    const enrollmentKey = enrollmentKeyFromRequest(req);

    const school = schoolIdParam
      ? await getSchoolById(schoolIdParam)
      : schoolSlug
        ? await getSchoolBySlug(schoolSlug)
        : undefined;
    if (!school || school.status !== "active") {
      return res.status(404).json({ error: "Shared sign-in is not configured" });
    }

    await runWithTenantContext({ schoolId: school.id }, async () => {
      if (!(await hasCurrentClassPilotLicense(school.id))) {
        return res.status(403).json({ error: "ClassPilot license is not active" });
      }

      const regSettings = await getSettingsForSchool(school.id);
      if (!regSettings?.sharedChromebookSignInEnabled) {
        return res.status(403).json({ error: "Shared Chromebook sign-in is not enabled for this school", sharedSignInEnabled: false });
      }
      const loginMethod = effectiveSharedChromebookLoginMethod(regSettings);
      if (loginMethod !== "name_pin") {
        return res.status(403).json({ error: "PIN login is not enabled for this school", pinLoginEnabled: false });
      }

      const keyCheck = validateEnrollmentKeyForSettings(regSettings, enrollmentKey, {
        requireConfiguredKey: true,
      });
      if (!keyCheck.ok) {
        return res.status(keyCheck.status).json({ error: keyCheck.error });
      }
      const managedDeviceContinuity = managedDeviceProofToken
        ? verifyClasspilotManagedDeviceContinuityProof({
            token: managedDeviceProofToken,
            schoolId: school.id,
          })
        : null;
      if (managedDeviceAuthorizationPresented && !managedDeviceContinuity) {
        return res.status(401).json({
          error: "Managed-device continuity authorization failed",
          code: "CLASSPILOT_MANAGED_DEVICE_CONTINUITY_UNAUTHORIZED",
        });
      }
      if (managedDeviceContinuity) {
        res.locals.managedDeviceContinuityAccepted = true;
      }
      const rosterThrottle = await enforceSharedRosterFetchThrottle(school.id, gradeLevel);
      if (!rosterThrottle.ok) {
        recordHeartbeatHotPathCounter("manualSessionRosterRateLimited");
        return res.status(429).json({
          error: "Too many roster requests, please wait",
          retryAfterSeconds: rosterThrottle.retryAfterSeconds,
          ...(managedDeviceContinuity
            ? { managedDeviceContinuityAccepted: true }
            : {}),
        });
      }
      let students = await getStudentsBySchool(school.id);
      const grades = rosterGradesForStudents(students);
      const reclaimableSession = managedDeviceContinuity
        ? await getReclaimableStudentSessionByManagedDevice({
            schoolId: school.id,
            deviceId: managedDeviceContinuity.deviceId,
            recoveryTokenHash: managedDeviceContinuity.recoveryTokenHash,
          })
        : recoveryToken
          ? await getReclaimableStudentSessionByRecoveryTokenHash({
            schoolId: school.id,
            tokenHash: hashStudentSessionRecoveryToken(recoveryToken),
          })
          : undefined;
      const transferSources = new Map<string, "gate_presence" | "stale_heartbeat">();
      let activeStudentIds: Set<string>;
      if (isClasspilotCapabilityActive("studentAuthGatePresenceV1", {
        schoolId: school.id,
      })) {
        const authorities = await getClasspilotLoginSessionAuthorities(school.id);
        const manualBindings = authorities
          .filter((authority) => authority.authKind === "manual_shared")
          .map((authority) => ({
            schoolId: school.id,
            studentId: authority.studentId,
            studentSessionId: authority.id,
            deviceId: authority.deviceId,
          }));
        const gatePresenceBySession = await readClasspilotStudentAuthGatePresenceBatch(
          manualBindings
        );
        activeStudentIds = new Set<string>();
        const authoritiesByStudent = new Map<string, typeof authorities>();
        for (const authority of authorities) {
          const rows = authoritiesByStudent.get(authority.studentId) ?? [];
          rows.push(authority);
          authoritiesByStudent.set(authority.studentId, rows);
        }
        for (const [studentId, studentAuthorities] of authoritiesByStudent) {
          // A visible row must map to exactly one transferable authority. This
          // avoids a false offer if legacy/corrupt data contains an additional
          // current session that the issuance transaction will correctly
          // reject. The same rule protects exact-device resume.
          if (studentAuthorities.length !== 1) {
            activeStudentIds.add(studentId);
            continue;
          }
          const decision = classpilotStudentRosterTransferDecision({
            authorities: studentAuthorities,
            reclaimableSessionId: reclaimableSession?.studentId === studentId
              ? reclaimableSession.id
              : undefined,
            gatePresenceBySession,
          });
          if (decision.status === "allowed") {
            transferSources.set(studentId, decision.source);
          } else if (decision.status === "hidden") {
            activeStudentIds.add(studentId);
          }
        }
      } else {
        activeStudentIds = new Set(
          (await getStudentIdsHiddenFromClasspilotLoginRoster(school.id))
            .filter((studentId) => studentId !== reclaimableSession?.studentId)
        );
      }

      if (!gradeLevel) {
        return res.json({
          students: [],
          grades,
          loginMethod,
          pinLoginEnabled: true,
          ...(managedDeviceContinuity
            ? { managedDeviceContinuityAccepted: true }
            : {}),
        });
      }

      const roster = students
        .filter((student) => student.status === "active")
        .filter((student) => normalizeGradeLevel(student.gradeLevel) === gradeLevel)
        .filter((student) => !activeStudentIds.has(student.id))
        .map((student) => ({
          id: student.id,
          name: `${student.firstName || ""} ${student.lastName || ""}`.trim() || student.email || "Student",
          gradeLevel: student.gradeLevel,
          hasPin: !!student.classpilotPinHash,
          ...(student.id === reclaimableSession?.studentId
            ? { reclaimable: true }
            : {}),
        }))
        .sort((a, b) => a.name.localeCompare(b.name));
      if (roster.some((student) => student.reclaimable === true)) {
        recordHeartbeatHotPathCounter("manualSessionReclaimOffered");
        if (managedDeviceContinuity) {
          recordHeartbeatHotPathCounter("managedDeviceContinuityReclaimOffered");
        }
      }
      const gateOffers = roster.filter(
        (student) => transferSources.get(student.id) === "gate_presence"
      ).length;
      const staleOffers = roster.filter(
        (student) => transferSources.get(student.id) === "stale_heartbeat"
      ).length;
      if (gateOffers > 0) {
        recordHeartbeatHotPathCounter("studentAuthGateRosterOfferedGate", gateOffers);
      }
      if (staleOffers > 0) {
        recordHeartbeatHotPathCounter("studentAuthGateRosterOfferedStale", staleOffers);
      }

      return res.json({
        students: roster,
        grades,
        loginMethod,
        pinLoginEnabled: true,
        ...(managedDeviceContinuity
          ? { managedDeviceContinuityAccepted: true }
          : {}),
      });
    });
  } catch (err) {
    recordHeartbeatHotPathCounter("manualSessionRosterFailure");
    next(err);
  }
});

// ============================================================================
// Extension Settings
// ============================================================================

// GET /api/classpilot/extension/settings - Extension settings (requires device JWT)
router.get("/extension/settings", requireDeviceAuth, requireClasspilotEntitlement, async (_req, res, next) => {
  try {
    const schoolId = res.locals.schoolId as string;
    const studentId = res.locals.studentId as string;
    const deviceId = res.locals.deviceId as string;
    const studentSessionId = res.locals.studentSessionId as string;
    const schoolSettings = await getSettingsForSchool(schoolId);
    const school = await getSchoolById(schoolId);
    if (!school) {
      return res.status(404).json({ error: "School not found" });
    }
    const fab = await buildStudentFabState(schoolId, studentId, {
      studentSessionId,
    });
    const controlState = await getClasspilotStudentControlState(schoolId, studentId);

    return res.json({
      schoolId,
      studentId,
      studentSessionId,
      exactBinding: classpilotControlStateExactBinding({
        schoolId,
        deviceId,
        studentId,
        studentSessionId,
        controlRevision: controlState?.revision ?? 0,
      }),
      enableTrackingHours: schoolSettings?.enableTrackingHours ?? false,
      trackingStartTime: schoolSettings?.trackingStartTime ?? null,
      trackingEndTime: schoolSettings?.trackingEndTime ?? null,
      trackingDays: schoolSettings?.trackingDays ?? null,
      schoolTimezone: schoolSettings?.schoolTimezone || school.schoolTimezone || null,
      afterHoursMode: schoolSettings?.afterHoursMode ?? "off",
      sharedChromebookSignInEnabled: !!schoolSettings?.sharedChromebookSignInEnabled,
      sharedChromebookLoginMethod: effectiveSharedChromebookLoginMethod(schoolSettings),
      sharedChromebookPinLoginEnabled: effectiveSharedChromebookLoginMethod(schoolSettings) === "name_pin",
      maxTabsPerStudent: schoolSettings?.maxTabsPerStudent
        ? parseInt(schoolSettings.maxTabsPerStudent, 10)
        : null,
      fab,
      messagingEnabled: fab.messagingEnabled,
      handRaisingEnabled: fab.handRaisingEnabled,
      handRaised: fab.handRaised,
    });
  } catch (err) {
    next(err);
  }
});

// ============================================================================
// Device & Student Registration
// ============================================================================

// POST /api/classpilot/extension/student-login - Shared Chromebook fallback login
router.post("/extension/student-login", extensionLoginLimiter, async (req, res, next) => {
  try {
    setClassPilotNoStore(res);
    if (!classpilotManualSharedSessionIssuanceEnabled()) {
      return res.status(503).json({
        error: "Manual student sign-in is temporarily unavailable",
        code: "CLASSPILOT_MANUAL_SESSION_ISSUANCE_UNAVAILABLE",
        retryable: true,
      });
    }
    const recoveryToken = studentSessionRecoveryTokenFromAuthorization(
      req.headers.authorization
    );
    const managedDeviceAuthorizationPresented =
      classpilotManagedDeviceAuthorizationPresented(req.headers.authorization);
    const managedDeviceProofToken = classpilotManagedDeviceProofFromAuthorization(
      req.headers.authorization
    );
    const {
      deviceId,
      deviceName,
      classId,
      studentEmail,
      studentIdNumber,
      studentId,
      pin,
      schoolId: explicitSchoolId,
      schoolSlug,
    } = req.body;
    const enrollmentKey = enrollmentKeyFromRequest(req, { allowBody: true });

    if (!deviceId && !managedDeviceAuthorizationPresented) {
      return res.status(400).json({ error: "deviceId required" });
    }

    // Upper-grade fallback: email + Student ID Number.
    if (studentEmail || studentIdNumber) {
      const emailLc = String(studentEmail || "").trim().toLowerCase();
      const idNumber = String(studentIdNumber || "").trim();
      if (!emailLc || !idNumber) {
        return res.status(400).json({ error: "Email and Student ID are required" });
      }

      const resolved = await resolveSchoolForStudent(emailLc);
      if (!resolved) {
        return res.status(401).json({ error: "Invalid student credentials" });
      }
      if (explicitSchoolId && String(explicitSchoolId) !== resolved.school.id) {
        return res.status(403).json({ error: "School context does not match student email" });
      }
      if (schoolSlug) {
        const explicitSchool = await getSchoolBySlug(String(schoolSlug));
        if (!explicitSchool || explicitSchool.id !== resolved.school.id) {
          return res.status(403).json({ error: "School context does not match student email" });
        }
      }

      if (!(await requireUncachedClasspilotEntitlementForIssuance(res, resolved.school.id))) {
        return;
      }

      await runWithTenantContext({ schoolId: resolved.school.id }, async () => {
        const regSettings = await getSettingsForSchool(resolved.school.id);
        if (!regSettings?.sharedChromebookSignInEnabled) {
          return res.status(403).json({ error: "Shared Chromebook sign-in is not enabled for this school" });
        }
        if (effectiveSharedChromebookLoginMethod(regSettings) !== "email_id") {
          return res.status(403).json({ error: "Email + Student ID login is not enabled for this school" });
        }

        const keyCheck = validateEnrollmentKeyForSettings(regSettings, enrollmentKey, {
          requireConfiguredKey: true,
        });
        if (!keyCheck.ok) {
          return res.status(keyCheck.status).json({ error: keyCheck.error });
        }
        const managedDeviceContinuity = managedDeviceProofToken
          ? verifyClasspilotManagedDeviceContinuityProof({
              token: managedDeviceProofToken,
              schoolId: resolved.school.id,
            })
          : null;
        if (managedDeviceAuthorizationPresented && !managedDeviceContinuity) {
          return res.status(401).json({
            error: "Managed-device continuity authorization failed",
            code: "CLASSPILOT_MANAGED_DEVICE_CONTINUITY_UNAUTHORIZED",
          });
        }
        if (managedDeviceContinuity) {
          res.locals.managedDeviceContinuityAccepted = true;
        }

        const student = await getStudentByEmail(resolved.school.id, emailLc);
        if (
          !student ||
          student.status !== "active" ||
          String(student.studentIdNumber || "").trim() !== idNumber
        ) {
          return res.status(401).json({
            error: "Invalid student credentials",
            ...(managedDeviceContinuity
              ? { managedDeviceContinuityAccepted: true }
              : {}),
          });
        }

        const login = await completeStudentDeviceLogin({
          schoolId: resolved.school.id,
          deviceId,
          deviceName,
          classId,
          student,
          authKind: "manual_shared",
          reclaimRecoveryToken: recoveryToken,
          managedDeviceContinuity,
        });
        return res.json(login);
      });
      return;
    }

    // Optional fallback: roster-selected student + 4-digit PIN.
    const selectedStudentId = String(studentId || "").trim();
    const enteredPin = String(pin || "").trim();
    const school = explicitSchoolId
      ? await getSchoolById(String(explicitSchoolId))
      : schoolSlug
        ? await getSchoolBySlug(String(schoolSlug))
        : undefined;

    if (!school || !selectedStudentId || !/^\d{4}$/.test(enteredPin)) {
      return res.status(401).json({ error: "Invalid student credentials" });
    }

    if (!(await requireUncachedClasspilotEntitlementForIssuance(res, school.id))) {
      return;
    }

    await runWithTenantContext({ schoolId: school.id }, async () => {
      const regSettings = await getSettingsForSchool(school.id);
      if (!regSettings?.sharedChromebookSignInEnabled) {
        return res.status(403).json({ error: "Shared Chromebook sign-in is not enabled for this school" });
      }
      if (effectiveSharedChromebookLoginMethod(regSettings) !== "name_pin") {
        return res.status(403).json({ error: "PIN login is not enabled for this school" });
      }

      const keyCheck = validateEnrollmentKeyForSettings(regSettings, enrollmentKey, {
        requireConfiguredKey: true,
      });
      if (!keyCheck.ok) {
        return res.status(keyCheck.status).json({ error: keyCheck.error });
      }
      const managedDeviceContinuity = managedDeviceProofToken
        ? verifyClasspilotManagedDeviceContinuityProof({
            token: managedDeviceProofToken,
            schoolId: school.id,
          })
        : null;
      if (managedDeviceAuthorizationPresented && !managedDeviceContinuity) {
        return res.status(401).json({
          error: "Managed-device continuity authorization failed",
          code: "CLASSPILOT_MANAGED_DEVICE_CONTINUITY_UNAUTHORIZED",
        });
      }
      if (managedDeviceContinuity) {
        res.locals.managedDeviceContinuityAccepted = true;
      }

      const student = await getStudentById(selectedStudentId);
      const lockout = await getPinLockout(school.id, selectedStudentId);
      if (!lockout.ok) {
        return res.status(429).json({
          error: "Too many PIN attempts. Try again later.",
          retryAfterSeconds: lockout.retryAfterSeconds,
          ...(managedDeviceContinuity
            ? { managedDeviceContinuityAccepted: true }
            : {}),
        });
      }
      if (
        !student ||
        student.schoolId !== school.id ||
        student.status !== "active" ||
        !student.classpilotPinHash ||
        !(await comparePassword(enteredPin, student.classpilotPinHash))
      ) {
        await recordPinFailure(school.id, selectedStudentId);
        return res.status(401).json({
          error: "Invalid student credentials",
          ...(managedDeviceContinuity
            ? { managedDeviceContinuityAccepted: true }
            : {}),
        });
      }
      await clearPinFailures(school.id, selectedStudentId);

      const login = await completeStudentDeviceLogin({
        schoolId: school.id,
        deviceId,
        deviceName,
        classId,
        student,
        authKind: "manual_shared",
        reclaimRecoveryToken: recoveryToken,
        managedDeviceContinuity,
      });
      return res.json(login);
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/classpilot/extension/session-gate-presence - A short exact-bound
// signal emitted only while the ClassPilot student authentication gate is
// visibly ready. It makes the represented manual session transferable without
// exposing any binding identifier and never ends the session by itself.
router.post(
  "/extension/session-gate-presence",
  captureClasspilotStudentAuthGateIngress,
  extensionSessionGatePresenceIpLimiter,
  extensionSessionGatePresenceCapabilityLimiter,
  async (req, res) => {
    setClassPilotNoStore(res);
    const parsed = classpilotStudentAuthGatePresenceRequestSchema.safeParse(req.body);
    const recoveryToken = studentSessionRecoveryTokenFromAuthorization(
      req.headers.authorization
    );
    const managedAuthorizationPresented =
      classpilotManagedDeviceAuthorizationPresented(req.headers.authorization);
    if (!parsed.success || (!recoveryToken && !managedAuthorizationPresented)) {
      return res.status(400).json({
        error: "Student sign-in presence request is invalid",
        code: "SESSION_GATE_PRESENCE_INVALID",
      });
    }
    const requestObservedAt = Number(
      res.locals[STUDENT_AUTH_GATE_INGRESS_AT]
    );
    if (!Number.isSafeInteger(requestObservedAt) || requestObservedAt <= 0) {
      return res.status(503).json({
        error: "Student sign-in presence service is unavailable",
        code: "SESSION_GATE_PRESENCE_UNAVAILABLE",
      });
    }
    const { schoolId, clientProtocolVersion, capabilities } = parsed.data;
    try {
      const school = await getSchoolById(schoolId);
      if (!school || school.status !== "active") {
        recordHeartbeatHotPathCounter("studentAuthGatePresenceNoop");
        return res.status(204).end();
      }
      return await runWithTenantContext({ schoolId }, async () => {
        const settings = await getSettingsForSchool(schoolId);
        const enrollmentKey = enrollmentKeyFromRequest(req);
        const keyCheck = validateEnrollmentKeyForSettings(settings, enrollmentKey, {
          requireConfiguredKey: true,
        });
        if (!keyCheck.ok || !settings?.sharedChromebookSignInEnabled) {
          return res.status(400).json({
            error: "Student sign-in presence request is invalid",
            code: "SESSION_GATE_PRESENCE_INVALID",
          });
        }
        // Negotiate only after the caller proves the school's enrollment
        // authority. Otherwise a public request could probe school-scoped
        // rollout state through the 426 response.
        const protocol = negotiateClasspilotProtocol({
          clientProtocolVersion,
          advertisedCapabilities: capabilities,
          scope: { schoolId },
        });
        if (!protocol.acceptedCapabilities.includes("studentAuthGatePresenceV1")) {
          return res.status(426).json({
            error: "Student sign-in presence requires a compatible ClassPilot protocol",
            code: "CLASSPILOT_PROTOCOL_UPGRADE_REQUIRED",
            serverProtocolVersion: protocol.serverProtocolVersion,
            acceptedCapabilities: protocol.acceptedCapabilities,
          });
        }
        if (!(await hasCurrentClassPilotLicense(schoolId))) {
          recordHeartbeatHotPathCounter("studentAuthGatePresenceNoop");
          return res.status(204).end();
        }

        const managedProofToken = classpilotManagedDeviceProofFromAuthorization(
          req.headers.authorization
        );
        const managedContinuity = managedProofToken
          ? verifyClasspilotManagedDeviceContinuityProof({
              token: managedProofToken,
              schoolId,
            })
          : null;
        const session = managedContinuity
          ? await getReclaimableStudentSessionByManagedDevice({
              schoolId,
              deviceId: managedContinuity.deviceId,
              recoveryTokenHash: managedContinuity.recoveryTokenHash,
            })
          : recoveryToken
            ? await getReclaimableStudentSessionByRecoveryTokenHash({
                schoolId,
                tokenHash: hashStudentSessionRecoveryToken(recoveryToken),
              })
            : undefined;
        if (!session || session.authKind !== "manual_shared") {
          recordHeartbeatHotPathCounter("studentAuthGatePresenceNoop");
          return res.status(204).end();
        }
        const renewed = await renewClasspilotStudentAuthGatePresence({
          schoolId,
          studentId: session.studentId,
          studentSessionId: session.id,
          deviceId: session.deviceId,
        }, requestObservedAt);
        if (renewed.status !== "present") {
          recordHeartbeatHotPathCounter("studentAuthGatePresenceFailure");
          return res.status(503).json({
            error: "Student sign-in presence service is unavailable",
            code: "SESSION_GATE_PRESENCE_UNAVAILABLE",
          });
        }
        recordHeartbeatHotPathCounter("studentAuthGatePresenceRenewed");
        return res.status(204).end();
      });
    } catch {
      recordHeartbeatHotPathCounter("studentAuthGatePresenceFailure");
      return res.status(503).json({
        error: "Student sign-in presence service is unavailable",
        code: "SESSION_GATE_PRESENCE_UNAVAILABLE",
      });
    }
  }
);

// POST /api/classpilot/extension/session-release - Idempotently release the
// exact manual session represented by an opaque recovery capability. Cleanup
// remains available after entitlement or school lifecycle changes.
router.post(
  "/extension/session-release",
  extensionSessionReleaseIpLimiter,
  extensionSessionReleaseCapabilityLimiter,
  async (req, res) => {
    setClassPilotNoStore(res);
    const recoveryToken = studentSessionRecoveryTokenFromAuthorization(
      req.headers.authorization
    );
    const schoolId = typeof req.body?.schoolId === "string"
      ? req.body.schoolId.trim()
      : "";
    if (!recoveryToken || !/^[A-Za-z0-9_-]{1,128}$/.test(schoolId)) {
      return res.status(400).json({
        error: "Session release request is invalid",
        code: "SESSION_RELEASE_INVALID",
      });
    }

    try {
      const school = await getSchoolById(schoolId);
      if (!school) {
        recordHeartbeatHotPathCounter("manualSessionReleaseNoop");
        return res.status(204).end();
      }
      const ended = await runWithTenantContext({ schoolId }, () =>
        endStudentSessionByRecoveryTokenHash({
          schoolId,
          tokenHash: hashStudentSessionRecoveryToken(recoveryToken),
        })
      );
      if (ended) {
        recordHeartbeatHotPathCounter("manualSessionReleaseTransitioned");
        await broadcastStudentSignedOut({
          schoolId,
          studentId: ended.studentId,
          studentSessionId: ended.id,
          deviceId: ended.deviceId,
          reason: normalizeExtensionSignOutReason(req.body?.reason),
        }).catch(() => { /* durable release must not be undone by publication failure */ });
      } else {
        recordHeartbeatHotPathCounter("manualSessionReleaseNoop");
      }
      return res.status(204).end();
    } catch {
      recordHeartbeatHotPathCounter("manualSessionReleaseFailure");
      return res.status(503).json({
        error: "Session release service is unavailable",
        code: "SESSION_RELEASE_UNAVAILABLE",
      });
    }
  }
);

// POST /api/classpilot/extension/sign-out - Compatibility cleanup for 2.7.2.
// Authenticate the signed claims without requiring the represented row to
// remain active, then end only that exact tuple. A delayed request cannot end a
// replacement session and repeated requests remain successful.
router.post("/extension/sign-out", requireCryptographicDeviceAuth, async (req, res, next) => {
  try {
    setClassPilotNoStore(res);
    const deviceId = res.locals.deviceId as string;
    const studentId = res.locals.studentId as string;
    const schoolId = res.locals.schoolId as string;
    const studentSessionId = res.locals.studentSessionId as string;
    const reason = normalizeExtensionSignOutReason(req.body?.reason);
    const ended = await runWithTenantContext({ schoolId }, () =>
      endStudentSessionExact({
        schoolId,
        studentId,
        deviceId,
        studentSessionId,
      })
    );
    if (ended) {
      await broadcastStudentSignedOut({
        schoolId,
        studentId,
        studentSessionId,
        deviceId,
        reason,
      }).catch(() => { /* durable exact cleanup remains a successful no-op contract */ });
    }
    return res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// POST /api/classpilot/register - Generic device registration (no student) (legacy)
// Kept for backwards compatibility with older extension builds. New extensions use
// /extension/register exclusively. Rate-limited to prevent abuse.
router.post("/register", extensionRegisterLimiter, async (req, res, next) => {
  try {
    setClassPilotNoStore(res);
    const { deviceId, deviceName, classId, schoolId: explicitSchoolId } = req.body;
    if (!deviceId) {
      return res.status(400).json({ error: "deviceId required" });
    }

    let resolvedSchoolId = explicitSchoolId;
    if (!resolvedSchoolId) {
      return res.status(400).json({ error: "schoolId required" });
    }

    const school = await getSchoolById(resolvedSchoolId);
    if (!school) {
      return res.status(403).json({ error: "School is not active" });
    }
    if (!(await requireUncachedClasspilotEntitlementForIssuance(res, resolvedSchoolId))) {
      return;
    }

    // Unauthenticated route, but the school is validated above — scope the
    // device read+write to it so RLS is satisfied (no request GUC otherwise).
    let device;
    await runWithTenantContext({ schoolId: resolvedSchoolId }, async () => {
      device = await getDeviceById(deviceId);
      if (!device) {
        device = await createDevice({
          deviceId,
          deviceName: deviceName || null,
          schoolId: resolvedSchoolId,
          classId: classId || resolvedSchoolId,
        });
      }
    });

    return res.json({ data: device });
  } catch (err) {
    next(err);
  }
});

// POST /api/classpilot/extension/register - Register a device from the Chrome extension
// Supports both email-based (ClassPilot extension) and schoolId-based registration
router.post("/extension/register", extensionRegisterLimiter, async (req, res, next) => {
  try {
    setClassPilotNoStore(res);
    const {
      deviceId,
      deviceName,
      studentEmail,
      studentName,
      schoolId: explicitSchoolId,
      classId,
      clientProtocolVersion,
      capabilities,
      extensionCapabilities,
    } = req.body;
    const enrollmentKey = enrollmentKeyFromRequest(req, { allowBody: true });
    if (!deviceId) {
      return res.status(400).json({ error: "deviceId required" });
    }

    // Resolve school. SECURITY: this endpoint is unauthenticated, so the school
    // MUST be anchored to something the caller can't freely choose. When a
    // studentEmail is present, the email domain is the trust anchor — the school
    // is derived from it, and any client-supplied schoolId is only honored if it
    // matches. A bare schoolId with no email can create a device shell but never
    // mints a student token (see the studentEmail block below).
    let resolvedSchoolId;
    let school;

    if (studentEmail) {
      const result = await resolveSchoolForStudent(studentEmail);
      if (!result) {
        return res.status(401).json({ error: "No school found for this email domain" });
      }
      if (explicitSchoolId && explicitSchoolId !== result.school.id) {
        // A caller cannot enroll an email into a school other than the one its
        // domain maps to (prevents cross-school device/student injection).
        return res.status(403).json({ error: "schoolId does not match email domain" });
      }
      school = result.school;
      resolvedSchoolId = school.id;
    } else {
      resolvedSchoolId = explicitSchoolId;
      if (resolvedSchoolId) {
        school = await getSchoolById(resolvedSchoolId);
      }
    }

    if (!resolvedSchoolId || !school) {
      return res.status(401).json({ error: "No school found for this email domain" });
    }

    if (!(await requireUncachedClasspilotEntitlementForIssuance(res, resolvedSchoolId))) {
      return;
    }

    // Unauthenticated route: bind the resolved+validated school's tenant context
    // for the rest of the handler so RLS is satisfied AND the enrollment-key gate
    // (getSettingsForSchool below) reads real settings instead of failing open.
    await runWithTenantContext({ schoolId: resolvedSchoolId }, async () => {
    // Per-school managed setup key. Any route that mints a student monitoring
    // token must prove it came from the managed extension deployment.
    const regSettings = await getSettingsForSchool(resolvedSchoolId);
    const keyCheck = validateEnrollmentKeyForSettings(regSettings, enrollmentKey, {
      requireConfiguredKey: !!studentEmail,
    });
    if (!keyCheck.ok) {
      return res.status(keyCheck.status).json({ error: keyCheck.error });
    }

    // Create or update device
    let device = await getDeviceById(deviceId);
    if (!device) {
      device = await createDevice({
        deviceId,
        deviceName: deviceName || null,
        schoolId: resolvedSchoolId,
        classId: classId || resolvedSchoolId,
      });
    }

    // If studentEmail provided, also register the student and return a token
    if (studentEmail) {
      // Device enrollment must only link to an exact roster email. A fuzzy
      // partial match can bind a Chromebook to the wrong student.
      let student = await getStudentByEmail(resolvedSchoolId, studentEmail.toLowerCase());

      if (student && student.status !== "active") {
        return res.status(403).json({
          error: "Student not enrolled. Ask your administrator to add this student back before connecting a device.",
          code: "STUDENT_INACTIVE",
        });
      }

      if (!student) {
        // POLICY: by default a student must be pre-imported by an IT admin — an
        // unknown email is REJECTED, never auto-created. This is what stops a
        // valid-domain-but-uninvited email (e.g. a student IT never added) from
        // self-enrolling. A school can opt into zero-touch auto-enrollment by
        // setting settings.autoEnrollStudents = true.
        if (!regSettings?.autoEnrollStudents) {
          return res.status(403).json({
            error: "Student not enrolled. Ask your administrator to import this student before connecting a device.",
          });
        }
        // Auto-enroll path (opt-in): cap auto-creations per school per hour.
        if (!(await recordAutoCreation(resolvedSchoolId))) {
          console.warn("[Security] Student auto-creation rate limit reached");
          return res.status(429).json({
            error: "Auto-enrollment rate limit reached — please ask your administrator to import students first.",
          });
        }
        const nameParts = (studentName || studentEmail.split("@")[0]).split(/\s+/);
        student = await createStudent({
          schoolId: resolvedSchoolId,
          firstName: nameParts[0] || studentEmail.split("@")[0],
          lastName: nameParts.slice(1).join(" ") || "",
          email: studentEmail,
          emailLc: studentEmail.toLowerCase(),
          gradeLevel: null,
          status: "active",
        });
      }

      const login = await completeStudentDeviceLogin({
        schoolId: resolvedSchoolId,
        deviceId,
        deviceName,
        classId,
        student,
        authKind: "managed_profile",
      });
      const protocol = negotiateClasspilotSurfaceProtocol({
        surface: "registration",
        payload: req.body,
        scope: {
          serverOrigin: process.env.PUBLIC_BASE_URL,
          schoolId: resolvedSchoolId,
          deviceId,
          studentId: login.studentId,
          studentSessionId: login.studentSessionId,
        },
      });

      return res.json({
        ...login,
        ...protocol,
        studentName: studentName || `${student.firstName || ""} ${student.lastName || ""}`.trim() || student.email,
      });
    }

    return res.json({
      device,
      ...negotiateClasspilotSurfaceProtocol({
        surface: "registration",
        payload: req.body,
        scope: {
          serverOrigin: process.env.PUBLIC_BASE_URL,
          schoolId: resolvedSchoolId,
          deviceId,
        },
      }),
    });
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/classpilot/register-student - Register student and get device token (legacy)
// Kept for backwards compatibility. New extensions use /extension/register.
router.post("/register-student", extensionRegisterLimiter, async (req, res, next) => {
  try {
    setClassPilotNoStore(res);
    const { deviceId, studentEmail, gradeLevel, firstName, lastName, schoolId } = req.body;
    const enrollmentKey = enrollmentKeyFromRequest(req, { allowBody: true });
    if (!deviceId || !studentEmail || !schoolId) {
      return res.status(400).json({ error: "deviceId, studentEmail, and schoolId required" });
    }

    const emailLc = String(studentEmail).trim().toLowerCase();
    const resolved = await resolveSchoolForStudent(emailLc);
    if (!resolved) {
      return res.status(401).json({ error: "No school found for this email domain" });
    }
    const resolvedSchoolId = resolved.school.id;
    if (String(schoolId) !== resolvedSchoolId) {
      return res.status(403).json({ error: "schoolId does not match email domain" });
    }
    if (!(await requireUncachedClasspilotEntitlementForIssuance(res, resolvedSchoolId))) {
      return;
    }

    // Unauthenticated legacy route: the email domain above is the trust anchor.
    // Bind the resolved school for RLS, settings, exact roster lookup, and writes.
    await runWithTenantContext({ schoolId: resolvedSchoolId }, async () => {
      const regSettings = await getSettingsForSchool(resolvedSchoolId);
      const keyCheck = validateEnrollmentKeyForSettings(regSettings, enrollmentKey, {
        requireConfiguredKey: true,
      });
      if (!keyCheck.ok) {
        return res.status(keyCheck.status).json({ error: keyCheck.error });
      }

      // Find or create student by exact roster email only. Fuzzy matches can bind
      // a Chromebook to the wrong student.
      let student = await getStudentByEmail(resolvedSchoolId, emailLc);

      if (student && student.status !== "active") {
        return res.status(403).json({
          error: "Student not enrolled. Ask your administrator to add this student back before connecting a device.",
          code: "STUDENT_INACTIVE",
        });
      }

      if (!student) {
        if (!regSettings?.autoEnrollStudents) {
          return res.status(403).json({
            error: "Student not enrolled. Ask your administrator to import this student before connecting a device.",
          });
        }
        // Anti-spam: cap auto-creations per school per hour
        if (!(await recordAutoCreation(resolvedSchoolId))) {
        console.warn("[Security] Student registration auto-creation rate limit reached");
          return res.status(429).json({
            error: "Auto-enrollment temporarily disabled — please ask your administrator to import students first.",
          });
        }
        student = await createStudent({
          schoolId: resolvedSchoolId,
          firstName: firstName || emailLc.split("@")[0],
          lastName: lastName || "",
          email: emailLc,
          emailLc,
          gradeLevel: gradeLevel || null,
          status: "active",
        });
      }

      const login = await completeStudentDeviceLogin({
        schoolId: resolvedSchoolId,
        deviceId,
        student,
        authKind: "managed_profile",
      });

      return res.json({
        studentToken: login.studentToken,
        schoolId: login.schoolId,
        studentId: login.studentId,
        studentSessionId: login.studentSessionId,
        exactBinding: login.exactBinding,
        student: login.student,
        manualExpiresInSeconds: login.manualExpiresInSeconds,
        classroomState: login.classroomState,
      });
    });
  } catch (err) {
    next(err);
  }
});

// ============================================================================
// Popup Endpoints (items #5, #6)
// ============================================================================

// GET /api/classpilot/device/:deviceId/students - List students on a device
router.get("/device/:deviceId/students", requireDeviceAuth, requireClasspilotEntitlement, deviceActionLimiter, async (req, res, next) => {
  try {
    const deviceId = param(req, "deviceId");
    if (deviceId !== res.locals.deviceId) {
      return res.status(403).json({ error: "Device token does not match requested device" });
    }
    if (!(await hasCurrentClassPilotLicense(res.locals.schoolId as string))) {
      return res.status(402).json({ planStatus: "inactive" });
    }

    const students = await getStudentsForDevice(deviceId);
    const active = await getActiveStudentForDevice(deviceId);
    return res.json({
      students: classPilotStudentDtos(students),
      activeStudentId: active?.student.id || null,
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/classpilot/device/:deviceId/active-student - Set active student on device
router.post("/device/:deviceId/active-student", requireDeviceAuth, requireClasspilotEntitlement, deviceActionLimiter, async (req, res, next) => {
  try {
    const deviceId = param(req, "deviceId");
    if (deviceId !== res.locals.deviceId) {
      return res.status(403).json({ error: "Device token does not match requested device" });
    }
    const schoolId = res.locals.schoolId as string;
    if (!(await hasCurrentClassPilotLicense(schoolId))) {
      return res.status(402).json({ planStatus: "inactive" });
    }

    const { studentId } = req.body;
    if (!studentId) {
      return res.status(400).json({ error: "studentId required" });
    }
    if (studentId !== res.locals.studentId) {
      return res.status(403).json({
        error: "Switching students requires a fresh student login",
        code: "STUDENT_LOGIN_REQUIRED",
      });
    }

    const student = await getStudentById(studentId);
    if (!student) {
      return res.status(404).json({ error: "Student not found" });
    }
    if (student.schoolId !== schoolId) {
      return res.status(403).json({ error: "Student is not in this school" });
    }
    if (student.status !== "active") {
      return res.status(404).json({ error: "Student not found", code: "STUDENT_INACTIVE" });
    }

    const linkedStudents = await getStudentsForDevice(deviceId);
    if (!linkedStudents.some((s) => s.id === studentId)) {
      return res.status(403).json({ error: "Student is not linked to this device" });
    }

    // Compatibility no-op for older popup clients. The authenticated exact
    // session is already authoritative; this endpoint must never mint or
    // replace a session for a historically linked student without that
    // student's credentials.
    return res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// POST /api/classpilot/extension/runtime-error - Safe extension runtime telemetry
router.post("/extension/runtime-error", requireDeviceAuth, requireClasspilotEntitlement, extensionTelemetryLimiter, (req, res) => {
  const parsed = extensionRuntimeTelemetrySchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid telemetry payload" });
  }

  trackExtensionRuntimeTelemetry(parsed.data, {
    requestId: req.requestId,
    schoolId: res.locals.schoolId,
  });

  return res.status(204).send();
});

// ============================================================================
// Heartbeat (items #1, #2, #3, #5, #8, #9)
// ============================================================================

router.post("/device/command-acks", requireDeviceAuth, requireClasspilotEntitlement, async (req, res, next) => {
  try {
    const schoolId = res.locals.schoolId as string;
    const studentId = res.locals.studentId as string;
    const studentSessionId = res.locals.studentSessionId as string;
    const deviceId = res.locals.deviceId as string;
    if (!(await resolveClasspilotEntitlement(schoolId)).entitled) {
      return res.status(403).json({ error: "School is not entitled to ClassPilot", code: "CLASSPILOT_NOT_ENTITLED" });
    }
    const acks = Array.isArray(req.body?.acks) ? req.body.acks : null;
    if (!acks || acks.length < 1 || acks.length > 50) {
      return res.status(400).json({ error: "acks must contain between 1 and 50 items", code: "INVALID_COMMAND_ACK_BATCH" });
    }
    const receipts = [];
    for (const raw of acks) {
      const ackId = typeof raw?.ackId === "string" ? raw.ackId.trim().slice(0, 128) : "";
      const commandId = typeof raw?.commandId === "string" ? raw.commandId.trim().slice(0, 128) : "";
      if (!classpilotAckEnvelopeMatchesBinding(raw, {
        schoolId,
        studentId,
        studentSessionId,
        deviceId,
      })) {
        receipts.push(terminalClasspilotCommandAckReceipt(
          ackId,
          commandId,
          "COMMAND_ACK_BINDING_MISMATCH"
        ));
        continue;
      }
      const state = String(raw?.ackState || raw?.status || "").trim();
      const ackState = state === "received" || state === "completed" || state === "failed" || state === "expired"
        ? state
        : null;
      const result = raw?.result ?? null;
      const serialized = result === null ? "" : JSON.stringify(result);
      if (!ackId || !commandId || !ackState || Buffer.byteLength(serialized, "utf8") > 16 * 1024) {
        receipts.push(terminalClasspilotCommandAckReceipt(
          ackId,
          commandId,
          "COMMAND_ACK_MALFORMED"
        ));
        continue;
      }
      const outcome = await persistClasspilotCommandTargetAck({
        schoolId,
        commandId,
        studentId,
        studentSessionId,
        deviceId,
        ackState,
        controlRevision: classpilotAckControlRevision(raw),
        result,
        errorMessage: typeof (raw?.errorMessage ?? raw?.error) === "string"
          ? String(raw.errorMessage ?? raw.error).slice(0, 500)
          : null,
      });
      if (outcome.target) scheduleClasspilotCommandUpdate(schoolId, commandId);
      receipts.push(classpilotCommandAckReceipt(ackId, commandId, outcome));
    }
    return res.json({ receipts });
  } catch (err) {
    next(err);
  }
});

// POST /api/classpilot/device/live-view/ice-servers - exact-bound short-lived TURN credentials
router.post(
  "/device/live-view/ice-servers",
  // TURN credentials are an active capability, not compatibility cleanup.
  // Revalidate the exact persisted student/session/device binding (including
  // the database-time manual lease) before minting any credentials.
  requireDeviceAuthWithoutTenant,
  requireClasspilotEntitlement,
  deviceActionLimiter,
  async (req, res, next) => {
    setClassPilotNoStore(res);
    try {
      const exactBinding = {
        schoolId: res.locals.schoolId as string,
        studentId: res.locals.studentId as string,
        studentSessionId: res.locals.studentSessionId as string,
        deviceId: res.locals.deviceId as string,
      };
      if (!isClasspilotCapabilityActive("liveViewIceServersV1", exactBinding)) {
        return res.status(404).json({
          error: "Live View ICE configuration is not enabled",
          code: "LIVE_VIEW_ICE_SERVERS_DISABLED",
        });
      }
      const negotiationId = typeof req.body?.negotiationId === "string"
        ? req.body.negotiationId.trim()
        : "";
      if (!negotiationId || negotiationId.length > 2_048) {
        return res.status(400).json({
          error: "A valid negotiation is required",
          code: "LIVE_VIEW_NEGOTIATION_INVALID",
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
          code: "LIVE_VIEW_ICE_SERVERS_CAPABILITY_NOT_READY",
        });
      }
      const authority = classpilotLiveViewNegotiationAuthority(
        negotiationId,
        exactBinding
      );
      if (!authority) {
        return res.status(403).json({
          error: "Live View negotiation is not valid for this session",
          code: "LIVE_VIEW_NEGOTIATION_INVALID",
        });
      }
      if (!await isClasspilotLiveViewNegotiationActive(exactBinding, negotiationId)) {
        return res.status(409).json({
          error: "Live View negotiation is no longer active",
          code: "LIVE_VIEW_NEGOTIATION_SUPERSEDED",
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
      if (!await isClasspilotLiveViewNegotiationActive(exactBinding, negotiationId)) {
        return res.status(409).json({
          error: "Live View negotiation ended before credentials were issued",
          code: "LIVE_VIEW_NEGOTIATION_SUPERSEDED",
        });
      }
      const configuration = createClasspilotIceConfiguration({
        negotiationId,
        negotiationExpiresAt: authority.expiresAt,
      });
      if (!configuration) {
        return res.status(503).json({
          error: "Live View relay configuration is unavailable",
          code: "LIVE_VIEW_ICE_SERVERS_UNAVAILABLE",
        });
      }
      return res.json({ negotiationId, ...configuration });
    } catch (error) {
      return next(error);
    }
  }
);

// POST /api/classpilot/device/heartbeat - Device sends heartbeat (device JWT auth)
router.post("/device/heartbeat", requireCryptographicDeviceAuth, requireClasspilotEntitlement, deviceHeartbeatLimiter, async (req, res, next) => {
  try {
    const {
      activeTabUrl, activeTabTitle, visibilityState, screenLocked,
      allOpenTabs, favicon, isScreenRecording, isScreenSharing,
      cameraActive, status: trackingStatus, activeStudentId,
      flightPathActive, activeFlightPathName, screenshotHealth,
      extensionVersion, chromeVersion, appliedClassroomStateRevision,
      capabilities, extensionCapabilities, tabSnapshotRevision,
      activeTabRef,
      classroomStateOutcome,
      clientProtocolVersion,
    } = req.body;
    const schoolId = res.locals.schoolId as string;
    const studentId = res.locals.studentId as string;
    const deviceId = res.locals.deviceId as string;
    const studentSessionId = res.locals.studentSessionId as string;
    const protocol = negotiateClasspilotSurfaceProtocol({
      surface: "heartbeat",
      payload: req.body,
      scope: {
        serverOrigin: process.env.PUBLIC_BASE_URL,
        schoolId,
        deviceId,
        studentId,
        studentSessionId,
      },
    });
    const trackingWindowScreenshotLeaseNegotiated = protocol.acceptedCapabilities.includes(
      "screenshotTrackingWindowLeaseV1"
    );

    // --- Per-device rate limiting (item #9) ---
    const lastHb = deviceLastHeartbeat.get(deviceId);
    const now = Date.now();
    const lastAcceptedBindingMatches = lastHb?.studentId === studentId
      && lastHb.studentSessionId === studentSessionId;
    const refreshExactSessionAuthority = () => runWithTenantContext(
      { schoolId },
      () => refreshStudentSessionAuthorityWithoutTelemetry({
        schoolId,
        studentId,
        deviceId,
        studentSessionId,
      })
    );
    if (canShortCircuitAcceptedHeartbeat({
      previous: lastHb,
      studentId,
      studentSessionId,
      nowMs: now,
      minimumIntervalMs: HEARTBEAT_MIN_INTERVAL_MS,
      acceptedCapabilities: protocol.acceptedCapabilities,
    })) {
      const authority = await refreshExactSessionAuthority();
      if (authority.outcome === "replaced_session") {
        recordHeartbeatHotPathCounter("heartbeatReplacedSession");
        await broadcastStudentSignedOut({
          schoolId,
          studentId,
          studentSessionId,
          deviceId,
          reason: "session_replaced",
        });
        return res.status(409).json({
          error: "student_session_replaced",
          message: "This student is signed in on another Chromebook.",
        });
      }
      if (authority.outcome === "inactive_session") {
        recordHeartbeatHotPathCounter("heartbeatInactiveSession");
        return res.status(401).json({ error: "Student session is no longer active" });
      }
      if (authority.leaseRenewed) {
        recordHeartbeatHotPathCounter("manualSessionLeaseRenewed");
      }
      setBoundedMap(deviceLastHeartbeat, deviceId, {
        acceptedAt: Date.now(),
        studentId,
        studentSessionId,
        authorityExpiresAtMs: authority.authorityExpiresAt?.getTime() ?? null,
      }, MAX_DEVICE_HEARTBEAT_ENTRIES);
      return res.status(204).send();
    }
    const pendingMessageRecoveryHeartbeat = !lastHb
      || !lastAcceptedBindingMatches
      || now - lastHb.acceptedAt >= PENDING_MESSAGE_RECONNECT_GAP_MS;

    // Keep the RLS connection only around the short database section. Redis,
    // WebSocket fan-out, classification, and response serialization must not
    // occupy one of the task's 18 PostgreSQL pool slots.
    const heartbeatDatabaseStartedAt = Date.now();
    const heartbeatDbResult = await runWithTenantContext({ schoolId }, async () => {
      // Cache only the non-secret tracking projection. Enrollment and other
      // security settings are always read through the uncached full-row helper.
      const trackingSettings = await getHeartbeatTrackingSettingsForSchool(schoolId);
      if (trackingSettings && !isWithinTrackingWindow(trackingSettings)) {
        const afterMode = trackingSettings.afterHoursMode || "off";
        if (afterMode === "off") {
          const authority = await refreshStudentSessionAuthorityWithoutTelemetry({
            schoolId,
            studentId,
            deviceId,
            studentSessionId,
          });
          if (authority.outcome !== "accepted") return authority;
          return { outcome: "outside_tracking_window", authority } as const;
        }
        // "limited" or "full" mode: continue processing.
      }

      // The route middleware already performed the canonical uncached
      // lifecycle/license check. Load the school projection directly for the
      // classification domain and response without using it as cached
      // authorization state.
      const school = await getSchoolById(schoolId);
      if (!school || school.status !== "active") {
        return { outcome: "inactive_school" } as const;
      }

      // --- Save heartbeat and throttled presence in one DB round trip ---
      const [heartbeat, controlState] = await Promise.all([
        createHeartbeatAndRefreshPresence({
        deviceId,
        studentId,
        schoolId,
        activeTabTitle: activeTabTitle || "Unknown",
        activeTabUrl: activeTabUrl || null,
        favicon: favicon || null,
        screenLocked: screenLocked || false,
        flightPathActive: flightPathActive || false,
        activeFlightPathName: activeFlightPathName || null,
        isSharing: isScreenSharing || isScreenRecording || false,
        cameraActive: cameraActive || false,
        extensionVersion,
        chromeVersion,
        screenshotHealth,
        }, res.locals.studentSessionId as string),
        getClasspilotStudentControlState(schoolId, studentId),
      ]);
      if (heartbeat.outcome === "replaced_session") {
        return { outcome: "replaced_session" } as const;
      }
      if (heartbeat.outcome === "inactive_session") {
        return { outcome: "inactive_session" } as const;
      }
      if (
        controlState
        && Number.isSafeInteger(Number(appliedClassroomStateRevision))
        && Number(appliedClassroomStateRevision) === controlState.revision
      ) {
        const outcome = String(classroomStateOutcome || "").toLowerCase();
        const ackOutcome = outcome === "applied" || outcome === "success"
          ? "applied"
          : outcome === "failed"
            ? "failed"
            : outcome === "unsupported"
              ? "unsupported"
              : outcome === "expired"
                ? "expired"
                : null;
        const expectedHealth = ackOutcome === "applied" ? "synced" : ackOutcome;
        if (
          ackOutcome
          && (controlState.appliedRevision !== Number(appliedClassroomStateRevision)
            || controlState.enforcementHealth !== expectedHealth)
        ) {
          const acknowledgedState = await acknowledgeClasspilotStudentControlState({
            schoolId,
            studentId,
            studentSessionId,
            deviceId,
            appliedRevision: Number(appliedClassroomStateRevision),
            outcome: ackOutcome,
          });
          if (acknowledgedState?.sourceCommandId) {
            scheduleClasspilotCommandUpdate(schoolId, acknowledgedState.sourceCommandId);
          }
        }
      }

      const screenshotTrackingAuthority = trackingWindowScreenshotLeaseNegotiated
        ? await getClasspilotScreenshotAuthorityProjection({
            schoolId,
            studentId,
            studentSessionId,
            deviceId,
          })
        : undefined;

      return {
        outcome: "recorded",
        heartbeat,
        school,
        controlState,
        trackingSettings,
        screenshotTrackingAuthority,
      } as const;
    });
    recordHeartbeatHotPathTiming(
      "heartbeatDatabaseMs",
      Date.now() - heartbeatDatabaseStartedAt
    );

    if (heartbeatDbResult.outcome === "outside_tracking_window") {
      if (heartbeatDbResult.authority.leaseRenewed) {
        recordHeartbeatHotPathCounter("manualSessionLeaseRenewed");
      }
      setBoundedMap(deviceLastHeartbeat, deviceId, {
        acceptedAt: Date.now(),
        studentId,
        studentSessionId,
        authorityExpiresAtMs:
          heartbeatDbResult.authority.authorityExpiresAt?.getTime() ?? null,
      }, MAX_DEVICE_HEARTBEAT_ENTRIES);
      return res.status(204).send();
    }
    if (heartbeatDbResult.outcome === "inactive_school") {
      return res.status(402).json({ planStatus: "inactive" });
    }
    if (heartbeatDbResult.outcome === "replaced_session") {
      recordHeartbeatHotPathCounter("heartbeatReplacedSession");
      await broadcastStudentSignedOut({
        schoolId,
        studentId,
        studentSessionId,
        deviceId,
        reason: "session_replaced",
      });
      return res.status(409).json({
        error: "student_session_replaced",
        message: "This student is signed in on another Chromebook.",
      });
    }
    if (heartbeatDbResult.outcome === "inactive_session") {
      recordHeartbeatHotPathCounter("heartbeatInactiveSession");
      // Preserve requireDeviceAuthWithoutTenant's established response while
      // letting the insert CTE remain the sole database authority.
      return res.status(401).json({ error: "Student session is no longer active" });
    }
    const {
      heartbeat,
      school,
      controlState,
      trackingSettings,
      screenshotTrackingAuthority,
    } = heartbeatDbResult;
    if (heartbeat.leaseRenewed) {
      recordHeartbeatHotPathCounter("manualSessionLeaseRenewed");
    }
    setBoundedMap(deviceLastHeartbeat, deviceId, {
      acceptedAt: Date.now(),
      studentId,
      studentSessionId,
      authorityExpiresAtMs: heartbeat.authorityExpiresAt?.getTime() ?? null,
    }, MAX_DEVICE_HEARTBEAT_ENTRIES);
    const classroomState = controlState
      ? serializeClasspilotStudentControlState(controlState)
      : null;
    const enforcementHealth = controlState
      ? effectiveClasspilotControlEnforcementHealth(controlState, extensionVersion)
      : undefined;
    const screenshotPolicyPromise = resolveClasspilotScreenshotPolicy({
      schoolId,
      teachingSessionId: controlState?.teachingSessionId,
      studentId,
      acceptedCapabilities: protocol.acceptedCapabilities,
      trackingSettings,
      trackingAuthority: screenshotTrackingAuthority,
    });
    const studentEmail = heartbeat.studentEmail;
    recordHeartbeatHotPathCounter("heartbeatRecorded");

    const classificationPending = typeof activeTabUrl === "string" &&
      activeTabUrl.length > 0 &&
      !activeTabUrl.startsWith("chrome");

    // Write the latest history and authoritative realtime snapshot concurrently
    // after releasing PostgreSQL. Neither Redis path can make the accepted
    // heartbeat fail; authorized reads retain their documented fallback chain.
    const heartbeatTileCacheWrite = writeHeartbeatTileCache({
      id: heartbeat.id,
      deviceId,
      studentId,
      studentEmail,
      schoolId,
      activeTabTitle: activeTabTitle || "Unknown",
      activeTabUrl: activeTabUrl || null,
      favicon: favicon || null,
      screenLocked: screenLocked || false,
      flightPathActive: flightPathActive || false,
      activeFlightPathName: activeFlightPathName || null,
      isSharing: isScreenSharing || isScreenRecording || false,
      cameraActive: cameraActive || false,
      aiCategory: null,
      safetyAlert: null,
      extensionVersion: extensionVersion ?? null,
      chromeVersion: chromeVersion ?? null,
      screenshotHealth: screenshotHealth ?? null,
      timestamp: heartbeat.timestamp,
      classificationPending,
    });
    const realtimeStatusWrite = writeClasspilotRealtimeStatus({
      schoolId,
      studentId,
      studentSessionId,
      deviceId,
      heartbeatId: heartbeat.id,
      observedAt: heartbeat.timestamp.getTime(),
      activeTabUrl,
      activeTabTitle,
      activeTabRef,
      favicon,
      allOpenTabs,
      tabSnapshotRevision,
      trackingStatus,
      screenLocked,
      flightPathActive,
      activeFlightPathName,
      isSharing: isScreenSharing || isScreenRecording || false,
      cameraActive,
      screenshotHealth,
      classificationPending,
      extensionVersion,
      clientProtocolVersion,
      acceptedCapabilities: protocol.acceptedCapabilities,
      extensionCapabilities: extensionCapabilities ?? capabilities,
      chromeVersion,
      classroomState: classroomState || undefined,
      enforcementHealth,
    });
    // A write-through cache must never keep serving an older complete list when
    // this heartbeat could not be inserted into Redis. Finish the single Redis
    // round trip after releasing PostgreSQL, then fail closed by deleting (or
    // locally suppressing) the affected cache key before the HTTP response.
    const [heartbeatTileCacheWritten, realtimeStatusMutation, screenshotPolicy] = await Promise.all([
      heartbeatTileCacheWrite,
      realtimeStatusWrite,
      screenshotPolicyPromise,
    ]);
    if (!heartbeatTileCacheWritten) {
      // invalidate() marks this process fail-closed before its first await.
      // Do not stack a second bounded Redis readiness wait onto heartbeat
      // latency during an outage; the detached DEL provides cross-task cleanup.
      void invalidateHeartbeatTileCaches([{ schoolId, deviceId }]);
    }
    const completedHeartbeatTileCacheWrite = Promise.resolve(
      heartbeatTileCacheWritten
    );
    const realtimeSnapshot = realtimeStatusMutation.snapshot;
    if (!realtimeSnapshot) {
      if (realtimeStatusMutation.status === "stale") {
        // A newer heartbeat or a sign-out tombstone already owns the latest
        // status. Preserve the accepted historical row but never broadcast or
        // classify this delayed request as current activity.
        return res.json({
          ok: true,
          planStatus: school.planStatus || "active",
          classroomState,
          ...protocol,
          screenshotPolicy,
        });
      }
      throw new Error("Realtime heartbeat snapshot was not created");
    }

    // --- Update in-memory real-time status ---
    updateDeviceStatus({
      deviceId,
      studentId,
      studentEmail,
      schoolId,
      activeTabUrl: activeTabUrl || "",
      activeTabTitle: activeTabTitle || "",
      favicon: favicon || undefined,
      screenLocked: screenLocked || false,
      flightPathActive: flightPathActive || false,
      activeFlightPathName: activeFlightPathName || undefined,
      isSharing: isScreenSharing || isScreenRecording || false,
      cameraActive: cameraActive || false,
      lastSeenAt: Date.now(),
      allOpenTabs: allOpenTabs || undefined,
      screenshotHealth: screenshotHealth || undefined,
      extensionVersion: extensionVersion || undefined,
      chromeVersion: chromeVersion || undefined,
    });

    // --- Broadcast full student state to teachers (item #1) ---
    const update: Record<string, unknown> = {
      type: "student-update",
      studentId,
      schoolId,
      visibilityState,
      isScreenRecording,
      status: trackingStatus,
      timestamp: new Date().toISOString(),
      ...publicRealtimeFields(realtimeSnapshot),
    };

    const telemetryAuthority = realtimeControlAuthority(controlState);
    await publishRevisionedRealtimeUpdate(realtimeSnapshot, update, telemetryAuthority);

    // --- AI content classification (item #8) — async, non-blocking ---
    if (activeTabUrl && !activeTabUrl.startsWith("chrome")) {
      const classificationProducer = classifyUrl(
        activeTabUrl,
        activeTabTitle,
        { schoolDomain: school.domain }
      ).then(async (classification) => {
        if (!classification) {
          await completedHeartbeatTileCacheWrite;
          const completion = {
            schoolId,
            deviceId,
            heartbeatId: heartbeat.id,
            aiCategory: null,
            safetyAlert: null,
          };
          if (!(await patchHeartbeatTileCacheClassifications([completion]))) {
            await invalidateHeartbeatTileCaches([completion]);
          }
          const realtimeCompletion = await patchClasspilotRealtimeClassification({
            schoolId,
            studentId,
            studentSessionId,
            deviceId,
            heartbeatId: heartbeat.id,
            classification: null,
          });
          if (realtimeCompletion.snapshot) {
            await publishRevisionedRealtimeUpdate(realtimeCompletion.snapshot, {
              type: "ai-classification",
              studentId,
              schoolId,
              classification: null,
              classifiedUrl: realtimeCompletion.snapshot.activeTabUrl,
              ...publicRealtimeFields(realtimeCompletion.snapshot),
            }, telemetryAuthority);
          }
          return;
        }

        // Critical classifications persist immediately. Educational/unknown
        // results retain the same historical fields but share one school-bound
        // transaction in batches of at most 100 rows / 250 ms.
        void persistHeartbeatClassification({
          schoolId,
          deviceId,
          heartbeatId: heartbeat.id,
          aiCategory: classification.category,
          safetyAlert: classification.safetyAlert,
          cacheWrite: completedHeartbeatTileCacheWrite,
        }).catch(() => {});

        // Only the classification for the currently stored heartbeat may
        // mutate or broadcast the latest page. Historical persistence above
        // remains valid even when this result loses that race.
        const realtimeClassification = await patchClasspilotRealtimeClassification({
          schoolId,
          studentId,
          studentSessionId,
          deviceId,
          heartbeatId: heartbeat.id,
          classification: {
            category: classification.category,
            safetyAlert: classification.safetyAlert,
          },
        });
        if (realtimeClassification.snapshot) {
          updateDeviceClassification(schoolId, deviceId, {
            category: classification.category,
            safetyAlert: classification.safetyAlert,
          });
          await publishRevisionedRealtimeUpdate(realtimeClassification.snapshot, {
            type: "ai-classification",
            studentId,
            schoolId,
            classification,
            classifiedUrl: realtimeClassification.snapshot.activeTabUrl,
            ...publicRealtimeFields(realtimeClassification.snapshot),
          }, telemetryAuthority);
        }

        const safetyAction = resolveCurrentClasspilotSafetyAction({
          classification,
          realtimeMutation: realtimeClassification,
          schoolId,
          studentId,
          studentSessionId,
          deviceId,
          heartbeatId: heartbeat.id,
          activeTabUrl,
          activeTabTitle,
        });

        // Historical classification persistence above remains valid for a
        // stale result, but no live close, evidence, staff alert, or email may
        // escape unless this exact heartbeat still owns the active binding.
        if (safetyAction) {
          const sendSafetyClose = async (safetyEvidenceRequest?: {
            requestId: string;
            tabRef: string;
            snapshotRevision: number;
            expiresAt: string;
          }) => {
            if (!safetyAction.closeTabData) return;
            const exactBindingEnvelope = safetyAction.exactTabCloseVersion === 2
              ? await runWithTenantContext({ schoolId }, () =>
                  revalidateClasspilotSafetyExactBinding({
                    schoolId,
                    studentId,
                    studentSessionId,
                    deviceId,
                    expectedControlRevision: controlState?.revision ?? 0,
                  })
                ).then((binding) => binding ? ({
                  exactBinding: classpilotControlStateExactBinding({
                    schoolId,
                    deviceId,
                    studentId,
                    studentSessionId,
                    controlRevision: binding.controlRevision,
                  }),
                }) : null)
              : {};
            if (exactBindingEnvelope === null) return;
            const safetyCommandIssuedAt = new Date();
            const safetyCommandExpiresAt = classpilotCommandExpiresAt(
              "close-tab",
              safetyCommandIssuedAt
            )!;
            const closeCmd = {
              type: "remote-control",
              _msgId: crypto.randomUUID(),
              studentId,
              studentSessionId,
              ...exactBindingEnvelope,
              deliveryPolicy: classpilotCommandDeliveryPolicy("close-tab"),
              expiresAt: safetyCommandExpiresAt.toISOString(),
              command: {
                type: "close-tab",
                studentId,
                studentSessionId,
                ...exactBindingEnvelope,
                deliveryPolicy: classpilotCommandDeliveryPolicy("close-tab"),
                expiresAt: safetyCommandExpiresAt.toISOString(),
                ...classpilotSchoolPolicyAuthorityEnvelope(schoolId, "ai_safety"),
                data: {
                  ...safetyAction.closeTabData,
                  studentId,
                  studentSessionId,
                  ...(safetyEvidenceRequest ? { safetyEvidenceRequest } : {}),
                },
              },
            };
            sendToDeviceLocal(schoolId, deviceId, closeCmd);
            void publishWS({ kind: "device", schoolId, deviceId }, closeCmd);
          };

          // One HMAC-keyed Redis SET NX EX elects the task that emits alerts.
          // Exact-bound tab closure never depends on a successful alert claim.
          if (!(await claimClasspilotSafetyAlert({
            schoolId,
            deviceId,
            domain: classification.domain,
          }))) {
            await sendSafetyClose();
            return;
          }

          // The request's original RLS checkout is already released. Rebind
          // the exact school for the timeline and evidence-request transaction.
          const safetyRecord = await runWithTenantContext({ schoolId }, async () => {
            const timelineRecord = await recordBrowserSafetyTimeline({
              schoolId,
              studentId,
              deviceId,
              heartbeatId: heartbeat.id,
              url: safetyAction.classifiedUrl,
              title: safetyAction.classifiedTitle,
              classification,
            }).catch(() => null);
            let captureRequest: {
              requestId: string;
              tabRef: string;
              snapshotRevision: number;
              expiresAt: string;
            } | undefined;
            if (
              timelineRecord?.caseId
              && safetyAction.evidenceTarget
              && protocol.acceptedCapabilities.includes("safetyEvidenceCaptureV1")
            ) {
              try {
                const created = await createClasspilotEvidenceCaptureRequest({
                  schoolId,
                  deviceId,
                  studentId,
                  studentSessionId,
                  teachingSessionId: safetyAction.teachingSessionId,
                  caseId: timelineRecord.caseId,
                  heartbeatId: heartbeat.id,
                  tabRef: safetyAction.evidenceTarget.tabRef,
                  tabSnapshotRevision: safetyAction.evidenceTarget.snapshotRevision,
                  expectedUrl: safetyAction.classifiedUrl,
                });
                captureRequest = {
                  ...created,
                  tabRef: safetyAction.evidenceTarget.tabRef,
                  snapshotRevision: safetyAction.evidenceTarget.snapshotRevision,
                };
              } catch {
                // Fall through to the exact-validated ambient evidence path.
              }
            }

            // Legacy/capture-unavailable compatibility: attach an ambient
            // image only after exact tuple, URL and freshness validation.
            if (timelineRecord?.caseId && !captureRequest) {
              try {
                const evidenceBinding: ScreenshotBinding = {
                  schoolId,
                  deviceId,
                  studentId,
                  studentSessionId,
                };
                const screenshotRead = await getScreenshot(evidenceBinding);
                const screenshotStoreUnavailable = screenshotRead.status === "unavailable";
                const screenshotData = screenshotRead.status === "ok"
                  ? screenshotRead.screenshot
                  : null;
                const evidenceSelection = selectClasspilotSafetyEvidence({
                  screenshot: screenshotData,
                  binding: evidenceBinding,
                  classifiedUrl: safetyAction.classifiedUrl,
                  observedAt: safetyAction.snapshot.observedAt,
                });
                const evidenceScreenshot = evidenceSelection.screenshot;
                await createEvidenceArtifact({
                  schoolId,
                  deviceId,
                  studentId,
                  studentSessionId,
                  bindingVersion: evidenceScreenshot?.bindingVersion
                    ?? screenshotBindingVersion(evidenceBinding),
                  caseId: timelineRecord.caseId,
                  sourceType: "classpilot_screenshot",
                  sourceId: heartbeat.id,
                  artifactType: "screenshot",
                  status: evidenceSelection.available ? "available" : "unavailable",
                  label: evidenceSelection.available
                    ? "Recent exact-tab screenshot near safety alert"
                    : screenshotStoreUnavailable
                      ? "Screenshot service unavailable at safety alert"
                      : "Screenshot unavailable at safety alert",
                  contentType: evidenceSelection.available ? "image/jpeg" : null,
                  content: evidenceScreenshot?.screenshot ?? null,
                  capturedAt: evidenceSelection.available
                    ? new Date(evidenceScreenshot!.timestamp)
                    : new Date(),
                  metadata: {
                    capturedFromExactBinding: evidenceSelection.available,
                    unavailableReason: screenshotStoreUnavailable
                      ? "screenshot_store_unavailable"
                      : evidenceSelection.unavailableReason,
                  },
                });
              } catch {
                // The safety record remains valid with explicitly unavailable
                // evidence; failures never substitute another student's image.
              }
            }
            return { timelineRecord, captureRequest };
          });
          await sendSafetyClose(safetyRecord.captureRequest);

          const alert = {
            type: "safety-alert",
            studentId,
            studentEmail,
            alert: classification.safetyAlert,
            title: safetyAction.classifiedTitle,
            domain: classification.domain,
            timestamp: new Date().toISOString(),
          };
          const alertSessionId = safetyAction.teachingSessionId;
          if (alertSessionId) {
            broadcastToStaffSessionLocal(schoolId, alertSessionId, alert);
            void publishWS({ kind: "staff-session", schoolId, sessionId: alertSessionId }, alert);
          }

          // Send email to school admins if enabled
          runWithTenantContext({ schoolId }, async () => {
            const freshSettings = await getSettingsForSchool(schoolId);
            if (freshSettings?.aiSafetyEmailsEnabled === false) return [];
            return addCentralEmailRecipientForSchool(
              schoolId,
              await getAdminEmailsBySchool(schoolId)
            );
          }).then((recipients) => {
              if (recipients.length > 0) {
                void sendSafetyAlertEmail({
                  recipients,
                  studentEmail,
                  alertType: classification.safetyAlert!,
                  url: safetyAction.classifiedUrl,
                  title: safetyAction.classifiedTitle || "Unknown",
                  schoolName: school?.name || "Your School",
                });
              }
          }).catch((err) => {
            console.error("[Safety] Failed to send alert emails");
          });

          // AI handles unsafe content in real-time (tab close + safety alert above).
          // Domains are NOT auto-added to the school blocklist — only admin-entered domains go there.
        }
      });
      void trackHeartbeatClassificationProducer(classificationProducer)
        .catch(() => { /* non-blocking */ });
    }

    // --- Deliver any missed messages (item #3b) ---
    // Check on the first heartbeat, immediately after a monitoring-sized gap,
    // or periodically as a fallback for a WebSocket-only interruption. Normal
    // heartbeats retain the no-query hot path.
    let pendingMessages: Array<{
      id: string;
      message: string;
      commandId: string | null;
      studentId: string;
      studentSessionId: string;
      teachingSessionId: string | null;
      supervisionContextId: string | null;
      authority: { teachingSessionId: string | null; supervisionContextId: string | null } | null;
    }> = [];
    let deliveryState = deliveredMessages.get(deviceId);
    if (deliveryState && deliveryState.studentId !== studentId) {
      // Shared Chromebook privacy boundary: never carry one student's inbox
      // delivery history into another authenticated student session.
      deliveredMessages.delete(deviceId);
      deliveryState = undefined;
    }
    if (deliveryState) deliveryState.lastHeartbeatAt = now;
    const shouldCheckPendingMessages = !deliveryState
      || pendingMessageRecoveryHeartbeat
      || deliveryState.hasUnacknowledgedCommandMessages
      || now - deliveryState.lastInboxCheckAt >= PENDING_MESSAGE_PERIODIC_CHECK_MS;
    if (shouldCheckPendingMessages) {
      try {
        const recent = await runWithTenantContext(
          { schoolId },
          () => getPendingMessagesForStudent({
            schoolId,
            studentId,
            studentSessionId,
            deviceId,
            excludeMessageIds: deliveryState ? [...deliveryState.messageIds] : [],
          })
        );
        const checkedState = deliveryState || {
          studentId,
          messageIds: new Set<string>(),
          hasUnacknowledgedCommandMessages: false,
          lastHeartbeatAt: now,
          lastInboxCheckAt: now,
        };
        checkedState.lastHeartbeatAt = now;
        checkedState.lastInboxCheckAt = now;
        checkedState.hasUnacknowledgedCommandMessages = recent.some(
          (message) => !!message.commandId
        );
        setBoundedMap(
          deliveredMessages,
          deviceId,
          checkedState,
          MAX_DELIVERED_MESSAGE_DEVICES
        );
        pendingMessages = recent.map((message) => ({
          id: message.id,
          message: message.message,
          commandId: message.commandId,
          studentId,
          studentSessionId,
          teachingSessionId: message.teachingSessionId,
          supervisionContextId: message.supervisionContextId,
          authority: message.commandId ? {
            teachingSessionId: message.teachingSessionId,
            supervisionContextId: message.supervisionContextId,
          } : null,
        }));
        if (pendingMessages.length > 0) {
          // Legacy rows have no durable ACK relation, so response `finish`
          // remains their bounded process-local handoff marker. Command-linked
          // rows are deliberately never put in this cache: the next heartbeat
          // queries/retries them until their exact target ACK is completed.
          const legacyDeliveredIds = pendingMessages
            .filter((message) => !message.commandId)
            .map((message) => message.id);
          let responseFinished = false;
          // Do not suppress even a legacy retry merely because the response
          // was assembled. `finish` is only the legacy row handoff marker;
          // command-linked rows remain ACK-driven regardless of this event.
          res.once("finish", () => {
            responseFinished = true;
            const current = deliveredMessages.get(deviceId);
            if (!current || current.studentId !== studentId) return;
            for (const messageId of legacyDeliveredIds) current.messageIds.add(messageId);
            while (current.messageIds.size > DELIVERED_MESSAGE_CACHE_MAX_IDS) {
              const oldest = current.messageIds.values().next().value as string | undefined;
              if (!oldest) break;
              current.messageIds.delete(oldest);
            }
          });
          res.once("close", () => {
            if (responseFinished) return;
            const current = deliveredMessages.get(deviceId);
            if (!current || current.studentId !== studentId) return;
            // The response closed before `finish`; leave ids unmarked and make
            // the next authenticated heartbeat retry the inbox immediately.
            current.lastInboxCheckAt = 0;
          });
        }
      } catch { /* non-blocking */ }
    }

    const teacherReplyCheckKey = `${studentSessionId}:${deviceId}`;
    const shouldCheckTeacherReplies = pendingMessageRecoveryHeartbeat
      || now - (teacherReplyLastCheck.get(teacherReplyCheckKey) || 0) >= 30_000;
    if (shouldCheckTeacherReplies) {
      setBoundedMap(
        teacherReplyLastCheck,
        teacherReplyCheckKey,
        now,
        MAX_TEACHER_REPLY_CHECKS
      );
      try {
        const teacherReplies = await runWithTenantContext(
          { schoolId },
          () => claimDueTeacherChatDeliveriesForBinding({
            schoolId,
            studentId,
            studentSessionId,
            deviceId,
          })
        );
        for (const { message } of teacherReplies) {
          const replyPayload = {
            type: "teacher-message",
            _msgId: message.id,
            chatMessageId: message.id,
            messageId: message.id,
            sessionId: message.sessionId,
            studentId,
            studentSessionId,
            message: message.content,
            fromName: "Teacher",
          };
          sendToDeviceLocal(schoolId, deviceId, replyPayload);
          await publishWS({ kind: "device", schoolId, deviceId }, replyPayload);
        }
      } catch {
        // The outbox remains due; a later heartbeat retries the stable id.
      }
    }

    // Explicit, throttled recovery hook for clients whose WebSocket FAB sync
    // was interrupted. Normal heartbeats keep the existing no-FAB-query path.
    const fab = req.body?.requestFabState === true
      ? await runWithTenantContext(
          { schoolId },
          () => buildStudentFabState(schoolId, studentId, { studentSessionId })
        )
      : undefined;

    // --- Return planStatus (item #3) ---
    return res.json({
      ok: true,
      schoolId,
      studentId,
      studentSessionId,
      exactBinding: classpilotControlStateExactBinding({
        schoolId,
        deviceId,
        studentId,
        studentSessionId,
        controlRevision: classroomState?.revision ?? 0,
      }),
      planStatus: school.planStatus || "active",
      classroomState,
      ...protocol,
      screenshotPolicy,
      ...(fab ? { fab } : {}),
      ...(pendingMessages.length > 0 ? { pendingMessages } : {}),
    });
  } catch (err) {
    next(err);
  }
});

// ============================================================================
// Screenshots
// ============================================================================

// POST /api/classpilot/device/screenshot - Upload screenshot
router.post("/device/screenshot", requireDeviceAuthWithoutTenant, requireClasspilotEntitlement, deviceScreenshotLimiter, async (req, res, next) => {
  setClassPilotNoStore(res);
  try {
    const {
      screenshot,
      tabTitle,
      tabUrl,
      tabFavicon,
      captureKind,
      evidenceRequestId,
      tabRef,
      tabSnapshotRevision,
      capturedAt,
      screenshotAuthority,
    } = req.body;
    const deviceId = res.locals.deviceId as string;
    const schoolId = res.locals.schoolId as string;
    const studentId = res.locals.studentId as string;
    const studentSessionId = res.locals.studentSessionId as string;
    const binding: ScreenshotBinding = {
      schoolId,
      deviceId,
      studentId,
      studentSessionId,
    };
    const leaseRolloutActive = isClasspilotCapabilityActive(
      "screenshotObservationLeaseV1",
      binding
    );
    const trackingLeaseRolloutActive = isClasspilotCapabilityActive(
      "screenshotTrackingWindowLeaseV1",
      binding
    );
    const safetyCaptureRolloutActive = isClasspilotCapabilityActive(
      "safetyEvidenceCaptureV1",
      binding
    );
    let acceptedHeartbeatCapabilities = new Set<string>();
    let screenshotRealtimeSnapshot: ClasspilotRealtimeStatus | null = null;
    let screenshotControlAuthority: ClasspilotRealtimeControlAuthority | undefined;
    if (leaseRolloutActive || trackingLeaseRolloutActive || safetyCaptureRolloutActive) {
      const realtime = (await readClasspilotRealtimeStatusBatch(schoolId, [binding]))
        .get(studentId);
      if (
        realtime?.status !== "hit"
        || !classpilotRealtimeFresh(realtime.snapshot)
      ) {
        return res.status(409).json({
          ok: false,
          code: "SCREENSHOT_CAPABILITY_HEARTBEAT_REQUIRED",
        });
      }
      screenshotRealtimeSnapshot = realtime.snapshot;
      acceptedHeartbeatCapabilities = new Set(
        realtime.snapshot.acceptedCapabilities || []
      );
    }
    const leaseNegotiated = leaseRolloutActive
      && acceptedHeartbeatCapabilities.has("screenshotObservationLeaseV1");
    const trackingLeaseNegotiated = trackingLeaseRolloutActive
      && acceptedHeartbeatCapabilities.has("screenshotTrackingWindowLeaseV1");
    const safetyCaptureNegotiated = safetyCaptureRolloutActive
      && acceptedHeartbeatCapabilities.has("safetyEvidenceCaptureV1");

    if (typeof screenshot !== "string" || screenshot.length === 0) {
      return res.status(400).json({ error: "screenshot data required" });
    }

    if (captureKind === "safety_evidence") {
      const capturedAtDate = typeof capturedAt === "string" ? new Date(capturedAt) : null;
      if (
        !safetyCaptureNegotiated
        || typeof evidenceRequestId !== "string"
        || evidenceRequestId.length < 1
        || evidenceRequestId.length > 128
        || typeof tabRef !== "string"
        || tabRef.length < 1
        || tabRef.length > 128
        || !Number.isSafeInteger(Number(tabSnapshotRevision))
        || Number(tabSnapshotRevision) < 1
        || typeof tabUrl !== "string"
        || tabUrl.length < 1
        || tabUrl.length > 4_096
        || !capturedAtDate
        || !Number.isFinite(capturedAtDate.getTime())
      ) {
        return res.status(400).json({
          error: "Invalid safety evidence capture",
          code: "SAFETY_EVIDENCE_CAPTURE_INVALID",
        });
      }
      const completion = await runWithTenantContext(
        { schoolId },
        () => completeClasspilotEvidenceCaptureRequest({
          schoolId,
          deviceId,
          studentId,
          studentSessionId,
          requestId: evidenceRequestId,
          tabRef,
          tabSnapshotRevision: Number(tabSnapshotRevision),
          tabUrl,
          tabTitle,
          screenshot,
          capturedAt: capturedAtDate,
        })
      );
      if (completion.status === "unavailable") {
        return res.status(completion.reason === "not_found" ? 404 : 409).json({
          ok: false,
          evidenceAvailable: false,
          code: `SAFETY_EVIDENCE_${completion.reason.toUpperCase()}`,
        });
      }
      return res.json({
        ok: true,
        evidenceAvailable: true,
        evidenceRequestId,
        duplicate: completion.duplicate,
      });
    }

    if (trackingLeaseNegotiated) {
      const parsedScreenshotAuthority = parseClasspilotScreenshotAuthority(screenshotAuthority);
      const capturedAtDate = typeof capturedAt === "string" ? new Date(capturedAt) : null;
      if (
        !parsedScreenshotAuthority
        || !capturedAtDate
        || !Number.isFinite(capturedAtDate.getTime())
        || capturedAtDate.toISOString() !== capturedAt
      ) {
        return res.status(400).json({
          ok: false,
          code: "SCREENSHOT_AUTHORITY_INVALID",
        });
      }

      const strictResult = await runWithTenantContext(
        { schoolId },
        () => withClasspilotScreenshotUploadAuthority({
          schoolId,
          deviceId,
          studentId,
          studentSessionId,
          expectedAuthority: parsedScreenshotAuthority,
        }, async ({ current, trackingSettings }) => {
          const checkedAt = Date.now();
          const screenshotPolicy = await resolveClasspilotScreenshotPolicy({
            schoolId,
            teachingSessionId: current.authority.kind === "teaching_session"
              ? current.authority.teachingSessionId
              : null,
            studentId,
            acceptedCapabilities: ["screenshotTrackingWindowLeaseV1"],
            trackingSettings,
            trackingAuthority: current,
            now: checkedAt,
          });
          if (
            screenshotPolicy.mode !== "tracking_window_lease"
            || !screenshotPolicy.captureAllowed
          ) {
            return { outcome: "tracking_window_closed" as const, screenshotPolicy };
          }

          const capturedAtValidation = validateClasspilotScreenshotCapturedAt({
            capturedAt: capturedAtDate,
            now: checkedAt,
            trackingSettings,
            trackingAuthority: current,
          });
          if (capturedAtValidation !== "ok") {
            return {
              outcome: "capture_rejected" as const,
              capturedAtValidation,
              screenshotPolicy,
            };
          }

          if (current.authority.kind === "student_session") {
            return { outcome: "discarded" as const, screenshotPolicy };
          }

          const classBinding: ClassBoundScreenshotBinding = {
            ...binding,
            teachingSessionId: current.authority.teachingSessionId,
            controlRevision: current.authority.controlRevision,
          };
          const data = {
            screenshot,
            timestamp: capturedAtDate.getTime(),
            capturedAt: capturedAtDate.toISOString(),
            tabTitle,
            tabUrl,
            tabFavicon,
            ...classBinding,
            bindingVersion: classBoundScreenshotBindingVersion(classBinding),
          };
          const stored = await setClassBoundScreenshot(classBinding, data);
          const screenshotStoreRequired = classpilotScreenshotStoreRequired();
          if (!stored && !screenshotStoreRequired) {
            classpilotScreenshotFallback.setClassBound(classBinding, data);
          }
          return {
            outcome: stored
              ? "redis" as const
              : screenshotStoreRequired
                ? "unavailable" as const
                : "local_fallback" as const,
            screenshotPolicy,
            classBinding,
            data,
          };
        })
      );

      if (strictResult.status !== "accepted") {
        const screenshotPolicy = await resolveClasspilotScreenshotPolicy({
          schoolId,
          teachingSessionId: strictResult.current?.authority.kind === "teaching_session"
            ? strictResult.current.authority.teachingSessionId
            : null,
          studentId,
          acceptedCapabilities: ["screenshotTrackingWindowLeaseV1"],
          trackingSettings: strictResult.trackingSettings,
          trackingAuthority: strictResult.current,
        });
        return res.status(409).json({
          ok: false,
          code: strictResult.status === "superseded"
            ? "SCREENSHOT_AUTHORITY_SUPERSEDED"
            : "SCREENSHOT_CAPTURE_PAUSED",
          screenshotPolicy,
        });
      }

      const strictValue = strictResult.value;
      if (strictValue.outcome === "tracking_window_closed") {
        return res.status(409).json({
          ok: false,
          code: "SCREENSHOT_CAPTURE_PAUSED",
          screenshotPolicy: strictValue.screenshotPolicy,
        });
      }
      if (strictValue.outcome === "capture_rejected") {
        const superseded = strictValue.capturedAtValidation === "before_authority"
          || strictValue.capturedAtValidation === "after_authority";
        return res.status(409).json({
          ok: false,
          code: superseded
            ? "SCREENSHOT_AUTHORITY_SUPERSEDED"
            : strictValue.capturedAtValidation === "outside_tracking_window"
              ? "SCREENSHOT_CAPTURE_PAUSED"
              : strictValue.capturedAtValidation === "expired"
                ? "SCREENSHOT_CAPTURE_EXPIRED"
                : "SCREENSHOT_CAPTURE_TIME_INVALID",
          screenshotPolicy: strictValue.screenshotPolicy,
        });
      }
      if (strictValue.outcome === "discarded") {
        recordScreenshotUpload(Buffer.byteLength(screenshot, "utf8"), "discarded");
        return res.json({
          ok: true,
          retained: false,
          screenshotPolicy: strictValue.screenshotPolicy,
        });
      }

      recordScreenshotUpload(Buffer.byteLength(screenshot, "utf8"), strictValue.outcome);
      if (strictValue.outcome === "unavailable") {
        return res.status(503).json({
          ok: false,
          error: "Screenshot service unavailable",
          code: "SCREENSHOT_STORE_UNAVAILABLE",
        });
      }

      screenshotControlAuthority = {
        teachingSessionId: strictValue.classBinding.teachingSessionId,
        supervisionContextId: null,
        revision: strictValue.classBinding.controlRevision,
      };
      if (screenshotRealtimeSnapshot && screenshotControlAuthority) {
        const screenshotAvailable = classpilotScreenshotAvailableEvent({
          studentId,
          capturedAt: strictValue.data.capturedAt,
          timestamp: strictValue.data.timestamp,
        });
        void publishRevisionedRealtimeUpdate(
          screenshotRealtimeSnapshot,
          screenshotAvailable,
          screenshotControlAuthority,
          {
            orderingNamespace: CLASSPILOT_SCREENSHOT_AVAILABLE_ORDERING_NAMESPACE,
            orderingRevision: String(strictValue.data.timestamp),
          }
        ).catch(() => {
          recordHeartbeatHotPathCounter("screenshotAvailableBroadcastFailures");
        });
      }
      return res.json({
        ok: true,
        retained: true,
        screenshotPolicy: strictValue.screenshotPolicy,
      });
    }

    if (leaseNegotiated) {
      const resolvedPolicy = await runWithTenantContext(
        { schoolId },
        async () => {
          const controlState = await getClasspilotStudentControlState(schoolId, studentId);
          return {
            controlState,
            screenshotPolicy: await resolveClasspilotScreenshotPolicy({
              schoolId,
              teachingSessionId: controlState?.teachingSessionId,
              studentId,
              acceptedCapabilities: ["screenshotObservationLeaseV1"],
            }),
          };
        }
      );
      const screenshotPolicy = resolvedPolicy.screenshotPolicy;
      screenshotControlAuthority = realtimeControlAuthority(resolvedPolicy.controlState);
      if (screenshotPolicy.mode !== "lease") {
        return res.status(409).json({
          ok: false,
          code: "OBSERVATION_LEASE_UNAVAILABLE",
        });
      }
      if ("diagnostic" in screenshotPolicy && screenshotPolicy.diagnostic === "unavailable") {
        return res.status(503).json({
          ok: false,
          code: "OBSERVATION_LEASE_UNAVAILABLE",
        });
      }
      if (!screenshotPolicy.observed) {
        return res.status(409).json({
          ok: false,
          code: "SCREENSHOT_PAUSED_UNOBSERVED",
          screenshotPolicy,
        });
      }
    }

    const timestamp = Date.now();
    const data = {
      screenshot,
      timestamp,
      capturedAt: new Date(timestamp).toISOString(),
      tabTitle,
      tabUrl,
      tabFavicon,
      ...binding,
      bindingVersion: screenshotBindingVersion(binding),
    };

    // The primary cache key contains the complete authority binding. Redis
    // also receives a one-TTL legacy device key for mixed API deployments.
    const stored = await setScreenshot(binding, data);
    const screenshotStoreRequired = classpilotScreenshotStoreRequired();
    recordScreenshotUpload(
      typeof screenshot === "string" ? Buffer.byteLength(screenshot, "utf8") : 0,
      stored ? "redis" : screenshotStoreRequired ? "unavailable" : "local_fallback"
    );
    if (!stored && screenshotStoreRequired) {
      return res.status(503).json({
        ok: false,
        error: "Screenshot service unavailable",
        code: "SCREENSHOT_STORE_UNAVAILABLE",
      });
    }
    if (!stored) {
      classpilotScreenshotFallback.set(binding, data);
    }

    if (screenshotRealtimeSnapshot && screenshotControlAuthority) {
      const screenshotAvailable = classpilotScreenshotAvailableEvent({
        studentId,
        capturedAt: data.capturedAt,
        timestamp: data.timestamp,
      });
      // The aggregate poll remains authoritative. This best-effort fast path
      // revalidates the exact session/supervision binding before delivery and
      // never delays the extension upload response or exposes device IDs.
      void publishRevisionedRealtimeUpdate(
        screenshotRealtimeSnapshot,
        screenshotAvailable,
        screenshotControlAuthority,
        {
          orderingNamespace: CLASSPILOT_SCREENSHOT_AVAILABLE_ORDERING_NAMESPACE,
          orderingRevision: String(data.timestamp),
        }
      ).catch(() => {
        recordHeartbeatHotPathCounter("screenshotAvailableBroadcastFailures");
      });
    }

    return res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// POST /api/classpilot/tiles/screenshots - Get one authorized screenshot cohort
router.post("/tiles/screenshots", ...tileReadAuth, async (req, res, next) => {
  setClassPilotNoStore(res);
  try {
    const parsed = parseTileStudentIds(req.body);
    const sessionScope = parseTileTeachingSessionId(req.body);
    if (!parsed.ok || !sessionScope.ok) {
      releaseClassPilotTileAdmission(res);
      return res.status(400).json({
        error: "studentIds must contain 1 to 50 non-empty strings and teachingSessionId must be a non-empty string when provided",
      });
    }
    recordHeartbeatHotPathCounter("tileBatchScreenshotRequests");
    recordHeartbeatHotPathCounter("tileBatchScreenshotItems", parsed.studentIds.length);

    const scope = tileStaffScope(req, res, sessionScope.teachingSessionId);
    const authorizationStartedAt = Date.now();
    const accessByStudent = await runWithTenantContext(
      { schoolId: scope.schoolId },
      () => getBatchTileAccessForStaff(scope, parsed.studentIds, "live")
    );
    recordHeartbeatHotPathTiming(
      "tileBatchAuthorizationMs",
      Date.now() - authorizationStartedAt
    );
    // The only database operation is complete. Release before Redis, fallback,
    // or JSON work so one cohort occupies one admission permit briefly.
    releaseClassPilotTileAdmission(res);

    const accesses = parsed.studentIds
      .map((studentId) => accessByStudent.get(studentId))
      .filter((access): access is NonNullable<typeof access> => Boolean(access));
    if (accesses.length === 0) {
      return res.status(404).json({ error: "No accessible tiles" });
    }
    recordHeartbeatHotPathCounter("tileBatchAuthorizedItems", accesses.length);

    const redisStartedAt = Date.now();
    const exactBindings = accesses.flatMap((access) =>
      access.studentSessionId
        ? [{
            schoolId: access.schoolId,
            deviceId: access.deviceId,
            studentId: access.studentId,
            studentSessionId: access.studentSessionId,
          }]
        : []
    );
    const realtimeByStudent = await readClasspilotRealtimeStatusBatch(
      scope.schoolId,
      exactBindings
    );
    const classBindings: ClassBoundScreenshotBinding[] = [];
    const legacyBindings: ScreenshotBinding[] = [];
    const classBindingByStudent = new Map<string, ClassBoundScreenshotBinding>();
    const legacyBindingByStudent = new Map<string, ScreenshotBinding>();
    for (const access of accesses) {
      if (!access.studentSessionId) continue;
      const exactBinding: ScreenshotBinding = {
        schoolId: access.schoolId,
        deviceId: access.deviceId,
        studentId: access.studentId,
        studentSessionId: access.studentSessionId,
      };
      const classBinding = (
        access.teachingSessionId
        && Number.isSafeInteger(access.controlRevision)
        && access.controlRevision! >= 0
      )
        ? {
          ...exactBinding,
          teachingSessionId: access.teachingSessionId,
          controlRevision: access.controlRevision!,
        } satisfies ClassBoundScreenshotBinding
        : null;
      const realtime = realtimeByStudent.get(access.studentId);
      const freshCapabilities = (
        realtime?.status !== "hit"
        || !classpilotRealtimeFresh(realtime.snapshot)
        || !Array.isArray(realtime.snapshot.acceptedCapabilities)
      ) ? null : realtime.snapshot.acceptedCapabilities;
      if (freshCapabilities === null) {
        if (classBinding) {
          classBindings.push(classBinding);
          classBindingByStudent.set(access.studentId, classBinding);
        }
        continue;
      }
      if (freshCapabilities.includes("screenshotTrackingWindowLeaseV1")) {
        if (classBinding) {
          classBindings.push(classBinding);
          classBindingByStudent.set(access.studentId, classBinding);
        }
      } else {
        // V1 compatibility is exclusive and allowed only when a fresh exact
        // heartbeat proves the current binding did not negotiate V2.
        legacyBindings.push(exactBinding);
        legacyBindingByStudent.set(access.studentId, exactBinding);
      }
    }
    const [classScreenshotRead, legacyScreenshotRead] = await Promise.all([
      getClassBoundScreenshots(classBindings),
      getScreenshots(legacyBindings),
    ]);
    recordHeartbeatHotPathTiming(
      "tileBatchScreenshotRedisMs",
      Date.now() - redisStartedAt
    );
    if (
      classScreenshotRead.status === "unavailable"
      || legacyScreenshotRead.status === "unavailable"
    ) {
      recordHeartbeatHotPathCounter("tileBatchScreenshotStoreUnavailable");
      return res.status(503).json({
        error: "Screenshot service unavailable",
        code: "SCREENSHOT_STORE_UNAVAILABLE",
      });
    }
    const localFallbackAllowed = !classpilotScreenshotStoreRequired();
    const classScreenshotByStudent = new Map(
      classBindings.map((binding, index) => [
        binding.studentId,
        classScreenshotRead.screenshots[index] ?? null,
      ])
    );
    const legacyScreenshotByStudent = new Map(
      legacyBindings.map((binding, index) => [
        binding.studentId,
        legacyScreenshotRead.screenshots[index] ?? null,
      ])
    );
    const tiles = accesses.map((access) => {
      const classBinding = classBindingByStudent.get(access.studentId);
      if (classBinding) {
        const screenshot = classScreenshotByStudent.get(access.studentId)
          ?? (localFallbackAllowed
            ? classpilotScreenshotFallback.getClassBound(classBinding)
            : null);
        const authorizedClassScreenshot = classBoundScreenshotForAuthorizedStudent(
          screenshot,
          classBinding
        );
        if (authorizedClassScreenshot) return {
          studentId: access.studentId,
          bindingVersion: classBoundScreenshotBindingVersion(classBinding),
          screenshot: authorizedClassScreenshot,
        };
      }
      const legacyBinding = legacyBindingByStudent.get(access.studentId);
      if (legacyBinding) {
        const screenshot = legacyScreenshotByStudent.get(access.studentId)
          ?? (localFallbackAllowed
            ? classpilotScreenshotFallback.get(legacyBinding)
            : null);
        return {
          studentId: access.studentId,
          screenshot: screenshotForAuthorizedStudent(screenshot, access),
        };
      }
      return classBinding
        ? {
            studentId: access.studentId,
            bindingVersion: classBoundScreenshotBindingVersion(classBinding),
            screenshot: null,
          }
        : { studentId: access.studentId, screenshot: null };
    });
    const screenshotFallbackItems = tiles.filter((tile) => tile.screenshot === null).length;
    if (screenshotFallbackItems > 0) {
      recordHeartbeatHotPathCounter(
        "tileBatchScreenshotMissItems",
        screenshotFallbackItems
      );
      recordHeartbeatHotPathCounter(
        "tileBatchScreenshotFallbackItems",
        screenshotFallbackItems
      );
    }
    return res.json({ tiles });
  } catch (err) {
    next(err);
  }
});

// POST /api/classpilot/tiles/history - Get one authorized history cohort
router.post("/tiles/history", ...tileReadAuth, async (req, res, next) => {
  setClassPilotNoStore(res);
  try {
    const parsed = parseTileStudentIds(req.body);
    const sessionScope = parseTileTeachingSessionId(req.body);
    const rawLimit = (req.body as { limit?: unknown } | undefined)?.limit;
    const limit = rawLimit === undefined ? 10 : rawLimit;
    if (
      !parsed.ok ||
      !sessionScope.ok ||
      typeof limit !== "number" ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 10
    ) {
      releaseClassPilotTileAdmission(res);
      return res.status(400).json({
        error: "studentIds must contain 1 to 50 non-empty strings, teachingSessionId must be a non-empty string when provided, and limit must be an integer from 1 to 10",
      });
    }
    recordHeartbeatHotPathCounter("tileBatchHistoryRequests");
    recordHeartbeatHotPathCounter("tileBatchHistoryItems", parsed.studentIds.length);

    const scope = tileStaffScope(req, res, sessionScope.teachingSessionId);
    const authorizationStartedAt = Date.now();
    const accessByStudent = await runWithTenantContext(
      { schoolId: scope.schoolId },
      () => getBatchTileAccessForStaff(scope, parsed.studentIds, "history")
    );
    recordHeartbeatHotPathTiming(
      "tileBatchAuthorizationMs",
      Date.now() - authorizationStartedAt
    );

    const accesses = parsed.studentIds
      .map((studentId) => accessByStudent.get(studentId))
      .filter((access): access is NonNullable<typeof access> => Boolean(access));
    if (accesses.length === 0) {
      releaseClassPilotTileAdmission(res);
      return res.status(404).json({ error: "No accessible tiles" });
    }
    recordHeartbeatHotPathCounter("tileBatchAuthorizedItems", accesses.length);

    const redisStartedAt = Date.now();
    const cachedByStudent = await readHeartbeatTileCacheBatch(
      scope.schoolId,
      accesses,
      limit
    );
    recordHeartbeatHotPathTiming(
      "tileBatchHistoryRedisMs",
      Date.now() - redisStartedAt
    );

    const fallbackAccesses = accesses.filter(
      (access) => cachedByStudent.get(access.studentId)?.status !== "hit"
    );
    let fallbackByStudent = new Map<string, Heartbeat[]>();
    if (fallbackAccesses.length > 0) {
      const databaseStartedAt = Date.now();
      fallbackByStudent = await runWithTenantContext(
        { schoolId: scope.schoolId },
        () => getHeartbeatTileHistoryBatch(
          scope.schoolId,
          fallbackAccesses,
          limit
        )
      );
      recordHeartbeatTileHistoryFallbackDatabaseRead(
        fallbackAccesses.length,
        Date.now() - databaseStartedAt
      );
    }

    // Cache misses may execute one batched SQL fallback, so retain the permit
    // through that query and release it before response shaping/serialization.
    releaseClassPilotTileAdmission(res);

    return res.json({
      tiles: accesses.map((access) => {
        const cached = cachedByStudent.get(access.studentId);
        const heartbeats = cached?.status === "hit"
          ? cached.heartbeats
          : fallbackByStudent.get(access.studentId) ?? [];
        return {
          studentId: access.studentId,
          heartbeats: heartbeats.map(safeTileHeartbeat),
        };
      }),
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/classpilot/device/screenshot/:deviceId - Get screenshot
router.get("/device/screenshot/:deviceId", ...deviceAdminAuth, async (req, res, next) => {
  try {
    const deviceId = param(req, "deviceId");
    const authorization = await withAuthorizedTileDevice(
      req,
      res,
      deviceId,
      "live",
      async (device, _authorizedStudentIds, access) => {
        const activeSession = access.liveStudentId && access.liveStudentSessionId
          ? {
              studentId: access.liveStudentId,
              id: access.liveStudentSessionId,
            }
          : access.schoolWide
            ? await getActiveSessionByDevice(deviceId)
            : undefined;
        const screenshotTrackingAuthority = activeSession
          ? await getClasspilotScreenshotAuthorityProjection({
              schoolId: device.schoolId,
              deviceId,
              studentId: activeSession.studentId,
              studentSessionId: activeSession.id,
            })
          : undefined;
        return {
          schoolId: device.schoolId,
          deviceId,
          studentId: activeSession?.studentId ?? null,
          studentSessionId: activeSession?.id ?? null,
          screenshotTrackingAuthority,
        };
      }
    );
    // The admission permit protects authentication and the bounded database
    // scope only; Redis retrieval and JSON serialization do not consume it.
    releaseClassPilotTileAdmission(res);
    if (authorization.status === "not-found") {
      return res.status(404).json({ error: "Device not found" });
    }

    const binding = authorization.value.studentId && authorization.value.studentSessionId
      ? {
          schoolId: authorization.value.schoolId,
          deviceId: authorization.value.deviceId,
          studentId: authorization.value.studentId,
          studentSessionId: authorization.value.studentSessionId,
        }
      : null;
    let authorizedScreenshot: ReturnType<typeof publicScreenshotData> | null = null;
    let screenshotReadStatus: "ok" | "unavailable" = "ok";
    if (binding) {
      const realtime = (await readClasspilotRealtimeStatusBatch(
        binding.schoolId,
        [binding]
      )).get(binding.studentId);
      const freshCapabilities = (
        realtime?.status === "hit"
        && classpilotRealtimeFresh(realtime.snapshot)
        && Array.isArray(realtime.snapshot.acceptedCapabilities)
      ) ? realtime.snapshot.acceptedCapabilities : null;
      const useLegacy = freshCapabilities !== null
        && !freshCapabilities.includes("screenshotTrackingWindowLeaseV1");
      if (useLegacy) {
        const screenshotRead = await getScreenshot(binding);
        screenshotReadStatus = screenshotRead.status;
        let data = screenshotRead.status === "ok" ? screenshotRead.screenshot : null;
        if (!data && !classpilotScreenshotStoreRequired()) {
          data = classpilotScreenshotFallback.get(binding);
        }
        authorizedScreenshot = screenshotForAuthorizedStudent(data, binding);
      } else {
        // Missing/stale capability telemetry is V2-only. It never authorizes a
        // downgrade to the observation-gated V1 compatibility store.
        const trackingAuthority = authorization.value.screenshotTrackingAuthority;
        if (trackingAuthority?.authority.kind === "teaching_session") {
          const classBinding: ClassBoundScreenshotBinding = {
            ...binding,
            teachingSessionId: trackingAuthority.authority.teachingSessionId,
            controlRevision: trackingAuthority.authority.controlRevision,
          };
          const screenshotRead = await getClassBoundScreenshot(classBinding);
          screenshotReadStatus = screenshotRead.status;
          let data = screenshotRead.status === "ok" ? screenshotRead.screenshot : null;
          if (!data && !classpilotScreenshotStoreRequired()) {
            data = classpilotScreenshotFallback.getClassBound(classBinding);
          }
          authorizedScreenshot = classBoundScreenshotForAuthorizedStudent(data, classBinding);
        }
      }
    }
    if (screenshotReadStatus === "unavailable") {
      return res.status(503).json({
        error: "Screenshot service unavailable",
        code: "SCREENSHOT_STORE_UNAVAILABLE",
      });
    }
    if (!authorizedScreenshot) {
      return res.status(404).json({ error: "No screenshot available" });
    }

    return res.json(authorizedScreenshot);
  } catch (err) {
    next(err);
  }
});

// ============================================================================
// Events (item #3 — return planStatus)
// ============================================================================

// Legacy unscoped event ingestion is intentionally retired. Older extensions
// receive a successful no-op during the mixed rollout; new builds use the
// tenant/session-bound /device/events outbox endpoint.
router.post("/device/event", requireDeviceAuth, requireClasspilotEntitlement, deviceActionLimiter, async (_req, res) => {
  try {
    const schoolId = res.locals.schoolId as string;
    const school = await getSchoolById(schoolId);
    if (!school || school.status !== "active") {
      return res.status(402).json({ planStatus: "inactive" });
    }
    return res.json({
      ok: true,
      retained: false,
      migration: "use_device_events_v1",
      planStatus: school.planStatus || "active",
    });
  } catch {
    return res.status(204).send();
  }
});

// ============================================================================
// Device Management (staff-only)
// ============================================================================

// GET /api/classpilot/devices - List all devices for school
router.get("/devices", ...deviceAdminAuth, async (req, res, next) => {
  try {
    const devices = await getDevicesBySchool(res.locals.schoolId!);
    return res.json({ devices });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/classpilot/devices/:deviceId - Update device
router.patch("/devices/:deviceId", ...deviceAdminAuth, async (req, res, next) => {
  try {
    const deviceId = param(req, "deviceId");
    const device = await getDeviceById(deviceId);
    if (!device || device.schoolId !== res.locals.schoolId) {
      return res.status(404).json({ error: "Device not found" });
    }
    const { deviceName, classId } = req.body;
    const data: Record<string, unknown> = {};
    if (deviceName !== undefined) data.deviceName = deviceName;
    if (classId !== undefined) data.classId = classId;

    const updated = await updateDevice(deviceId, data);
    if (!updated) {
      return res.status(404).json({ error: "Device not found" });
    }
    return res.json({ device: updated });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/classpilot/devices/:deviceId - Delete device
router.delete("/devices/:deviceId", ...deviceAdminAuth, requireRole("admin"), async (req, res, next) => {
  try {
    const deviceId = param(req, "deviceId");
    const device = await getDeviceById(deviceId);
    if (!device || device.schoolId !== res.locals.schoolId) {
      return res.status(404).json({ error: "Device not found" });
    }
    await removeClasspilotDeviceAndPublishSessionEnds({
      schoolId: res.locals.schoolId!,
      deviceId,
    });
    return res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// GET /api/classpilot/heartbeats - Recent heartbeats for all devices
router.get("/heartbeats", ...deviceAdminAuth, async (req, res, next) => {
  try {
    const devices = await getDevicesBySchool(res.locals.schoolId!);
    const heartbeats: unknown[] = [];
    for (const device of devices.slice(0, 50)) {
      const hb = await getHeartbeatsByDevice(res.locals.schoolId!, device.deviceId, 1);
      if (hb.length > 0) heartbeats.push({ deviceId: device.deviceId, ...hb[0] });
    }
    return res.json({ heartbeats });
  } catch (err) {
    next(err);
  }
});

// GET /api/classpilot/heartbeats/:deviceId - Device heartbeat history
router.get("/heartbeats/:deviceId", ...deviceAdminAuth, async (req, res, next) => {
  try {
    const deviceId = param(req, "deviceId");
    // Live tiles render only the ten most recent samples. Keep explicit limits
    // available for callers that need them without making every 30-second tile
    // poll materialize fifty full heartbeat rows from an aged table.
    const limit = Math.min(
      Math.max(parseInt(req.query.limit as string) || 10, 1),
      100
    );
    const startTime = req.query.startTime as string | undefined;
    const endTime = req.query.endTime as string | undefined;
    const authorization = await withAuthorizedTileDevice(
      req,
      res,
      deviceId,
      "history",
      async (device, authorizedStudentIds) => {
        const schoolId = device.schoolId;
        if (startTime) {
          // Filter by time range (for session-scoped views)
          const start = new Date(startTime);
          const end = endTime ? new Date(endTime) : new Date();
          if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
            return { status: "invalid-range" as const };
          }
          const databaseStartedAt = Date.now();
          const heartbeats = await runWithTenantContext({ schoolId }, () =>
            getHeartbeatsByDeviceInRange(
              schoolId,
              deviceId,
              start,
              end,
              authorizedStudentIds
            )
          );
          recordHeartbeatHotPathCounter("tileHistoryDatabaseReads");
          recordHeartbeatHotPathTiming(
            "tileHistoryDatabaseMs",
            Date.now() - databaseStartedAt
          );
          return {
            status: "ok" as const,
            heartbeats,
          };
        }

        if (!endTime && limit === 10) {
          const cached = await readHeartbeatTileCache(
            schoolId,
            deviceId,
            authorizedStudentIds
          );
          if (cached.status === "hit") {
            return { status: "ok" as const, heartbeats: cached.heartbeats };
          }
        }

        const databaseStartedAt = Date.now();
        const heartbeats = await runWithTenantContext({ schoolId }, () =>
          getHeartbeatsByDevice(
            schoolId,
            deviceId,
            limit,
            authorizedStudentIds
          )
        );
        recordHeartbeatHotPathCounter("tileHistoryDatabaseReads");
        recordHeartbeatHotPathTiming(
          "tileHistoryDatabaseMs",
          Date.now() - databaseStartedAt
        );
        return {
          status: "ok" as const,
          heartbeats: heartbeats.slice(0, limit),
        };
      }
    );
    releaseClassPilotTileAdmission(res);
    if (authorization.status === "not-found") {
      return res.status(404).json({ error: "Device not found" });
    }
    const result = authorization.value;
    if (result.status === "invalid-range") {
      return res
        .status(400)
        .json({ error: "Invalid startTime or endTime format" });
    }
    return res.json({ heartbeats: result.heartbeats });
  } catch (err) {
    next(err);
  }
});

// ============================================================================
// Remote Control Commands
// ============================================================================

function retiredDirectDeviceCommand(_req: any, res: any) {
  return res.status(410).json({
    error: "Direct device-ID command endpoints are retired",
    code: "LEGACY_DEVICE_TARGETING_RETIRED",
    replacement: "/api/classpilot/commands",
  });
}

// Fail closed before any legacy per-action handler can resolve or publish a
// device-ID target. Classroom control must use the student/session contract.
router.use("/remote", ...deviceAdminAuth, retiredDirectDeviceCommand);

router.post("/remote/open-tab", ...deviceAdminAuth, retiredDirectDeviceCommand);
router.post("/remote/close-tabs", ...deviceAdminAuth, retiredDirectDeviceCommand);
router.post("/remote/lock-screen", ...deviceAdminAuth, retiredDirectDeviceCommand);
router.post("/remote/unlock-screen", ...deviceAdminAuth, retiredDirectDeviceCommand);
router.post("/remote/temp-unblock", ...deviceAdminAuth, retiredDirectDeviceCommand);
router.post("/remote/limit-tabs", ...deviceAdminAuth, retiredDirectDeviceCommand);
router.post("/remote/attention-mode", ...deviceAdminAuth, retiredDirectDeviceCommand);
router.post("/remote/timer", ...deviceAdminAuth, retiredDirectDeviceCommand);

// POST /api/classpilot/remote/apply-flight-path - Apply flight path to devices
router.post("/remote/apply-flight-path", ...deviceAdminAuth, retiredDirectDeviceCommand);

// POST /api/classpilot/remote/remove-flight-path - Remove flight path
router.post("/remote/remove-flight-path", ...deviceAdminAuth, retiredDirectDeviceCommand);

// ============================================================================
// Device enrollment secret (admin) — see docs/SECURITY-device-enrollment-secret-spec.md
// ============================================================================

const enrollAdminAuth = [
  authenticate,
  requireSchoolContext,
  requireClasspilotEntitlement,
  requireActiveSchool,
  requireRole("admin", "school_admin"),
] as const;

// GET /api/classpilot/enrollment-key — current key + enforcement + auto-enroll state
router.get("/enrollment-key", ...enrollAdminAuth, async (_req, res, next) => {
  try {
    const school = await getSchoolById(res.locals.schoolId!);
    const s = await getSettingsForSchool(res.locals.schoolId!);
    return res.json({
      key: s?.enrollmentKey ?? null,
      required: !!s?.enrollmentKeyRequired,
      autoEnrollStudents: !!s?.autoEnrollStudents,
      schoolId: school?.id ?? res.locals.schoolId!,
      schoolSlug: school?.slug ?? null,
      schoolName: s?.schoolName || school?.name || "",
      sharedChromebookSignInEnabled: !!s?.sharedChromebookSignInEnabled,
      sharedChromebookLoginMethod: effectiveSharedChromebookLoginMethod(s),
      sharedChromebookPinLoginEnabled: effectiveSharedChromebookLoginMethod(s) === "name_pin",
    });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/classpilot/auto-enroll — toggle zero-touch auto-enrollment (default OFF;
// when OFF, students must be imported by IT before a device can register).
router.patch("/auto-enroll", ...enrollAdminAuth, async (req, res, next) => {
  try {
    const enabled = !!req.body.enabled;
    const updated = await updateEnrollmentSettings(res.locals.schoolId!, { autoEnrollStudents: enabled });
    if (!updated) {
      return res.status(409).json({ error: "Configure school settings first" });
    }
    return res.json({ autoEnrollStudents: enabled });
  } catch (err) {
    next(err);
  }
});

// POST /api/classpilot/enrollment-key/rotate — generate a new key
router.post("/enrollment-key/rotate", ...enrollAdminAuth, async (_req, res, next) => {
  try {
    const key = crypto.randomBytes(24).toString("base64url");
    const updated = await updateEnrollmentSettings(res.locals.schoolId!, { enrollmentKey: key });
    if (!updated) {
      return res.status(409).json({ error: "Configure school settings before enabling enrollment keys" });
    }
    return res.json({ key });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/classpilot/enrollment-key — toggle enforcement
router.patch("/enrollment-key", ...enrollAdminAuth, async (req, res, next) => {
  try {
    const required = !!req.body.required;
    const s = await getSettingsForSchool(res.locals.schoolId!);
    if (required && !s?.enrollmentKey) {
      return res.status(400).json({ error: "Generate an enrollment key before requiring it" });
    }
    const updated = await updateEnrollmentSettings(res.locals.schoolId!, { enrollmentKeyRequired: required });
    if (!updated) {
      return res.status(409).json({ error: "Configure school settings first" });
    }
    return res.json({ required });
  } catch (err) {
    next(err);
  }
});

export default router;
