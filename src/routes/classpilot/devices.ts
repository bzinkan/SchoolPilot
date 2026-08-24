import crypto from "crypto";
import { Router, type Request, type Response } from "express";
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
  deleteDevice,
  createHeartbeatAndRefreshPresence,
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
  getActiveSessions,
  getActiveSessionByDevice,
  setActiveStudentForDevice,
  getAdminEmailsBySchool,
  addCentralEmailRecipientForSchool,
  upsertSettings,
  getPendingMessagesForStudent,
  claimDueTeacherChatDeliveriesForBinding,
  getStudentByEmail,
  createEvidenceArtifact,
  createStudentTimelineEvent,
  endStudentSession,
  getBatchTileAccessForStaff,
  getClasspilotStudentControlState,
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
import { updateDeviceStatus, updateDeviceClassification, removeDeviceStatus } from "../../realtime/student-statuses.js";
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
  getScreenshot,
  setFlightPathStatus,
  recordScreenshotUpload,
  getScreenshots,
  screenshotBindingVersion,
  screenshotMatchesBinding,
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
  issueStudentDeviceSessionToken,
  setClassPilotNoStore,
  studentAuthenticationServiceError,
  validateEnrollmentKeyForSettings,
  verifyActiveStudentTokenSession,
} from "../../services/classpilotStudentAuth.js";
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
  markClasspilotRealtimeSignedOut,
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
  classpilotKioskLaunchTicketPreflightSchema,
  classpilotKioskLaunchTicketRequestSchema,
  issueClasspilotKioskLaunchTicket,
} from "../../services/classpilotKioskLaunchTicket.js";
import { classpilotObservationStatus } from "../../services/classpilotObservationLease.js";
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

function tileStaffScope(req: Request, res: Response) {
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
  };
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
  options: { allowEndedBinding?: boolean } = {}
): Promise<void> {
  const orderedKey = classpilotRealtimeOrderingKey(snapshot.schoolId, snapshot.deviceId);
  const revision = String(snapshot.revision);
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
  const controlState = await runWithTenantContext({ schoolId: options.schoolId }, () =>
    getClasspilotStudentControlState(options.schoolId, options.studentId)
  ).catch(() => undefined);
  void runWithTenantContext({ schoolId: options.schoolId }, () =>
    recordClasspilotStudentSessionMonitoringEvent({
      ...options,
      type: "student_session_ended",
      reason: options.reason,
    })
  ).catch(() => { /* lifecycle telemetry must not block sign-out */ });
  const mutation = await markClasspilotRealtimeSignedOut(options);
  if (mutation.status === "stale" || !mutation.snapshot) return;
  removeDeviceStatus(options.schoolId, options.deviceId);
  const signOutUpdate = {
    type: "student-signed-out",
    studentId: options.studentId,
    schoolId: options.schoolId,
    status: "offline",
    reason: options.reason,
    timestamp: new Date().toISOString(),
    ...publicRealtimeFields(mutation.snapshot),
  };
  await publishRevisionedRealtimeUpdate(
    mutation.snapshot,
    signOutUpdate,
    realtimeControlAuthority(controlState),
    { allowEndedBinding: true }
  );
}

async function completeStudentDeviceLogin(options: {
  schoolId: string;
  deviceId: string;
  deviceName?: string | null;
  classId?: string | null;
  student: Awaited<ReturnType<typeof getStudentByEmail>>;
}) {
  if (!options.student) {
    throw new Error("Student required");
  }
  if (options.student.schoolId !== options.schoolId || options.student.status !== "active") {
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

  const {
    device,
    session,
    previousStudentSession,
    previousDeviceSession,
    studentToken,
  } = await issueStudentDeviceSessionToken({
    schoolId: options.schoolId,
    deviceId: options.deviceId,
    deviceName: options.deviceName,
    classId: options.classId,
    student: options.student,
  });
  const studentEmail = options.student.email || undefined;

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
      studentId: options.student!.id,
      studentSessionId: session.id,
      deviceId: options.deviceId,
      type: "student_session_started",
    })
  ).catch(() => { /* lifecycle telemetry must not block login */ });

  if (previousDeviceSession && previousDeviceSession.studentId !== options.student.id) {
    await broadcastStudentSignedOut({
      schoolId: options.schoolId,
      studentId: previousDeviceSession.studentId,
      studentSessionId: previousDeviceSession.id,
      deviceId: options.deviceId,
      reason: "session_replaced",
    });
  }

  if (previousStudentSession && previousStudentSession.deviceId !== options.deviceId) {
    const replacedMessage = {
      type: "student-session-replaced",
      studentId: options.student.id,
      studentSessionId: previousStudentSession.id,
      deviceId: previousStudentSession.deviceId,
      replacementDeviceId: options.deviceId,
      timestamp: new Date().toISOString(),
    };
    sendToDeviceLocal(options.schoolId, previousStudentSession.deviceId, replacedMessage);
    await publishWS({ kind: "device", schoolId: options.schoolId, deviceId: previousStudentSession.deviceId }, replacedMessage);
    await broadcastStudentSignedOut({
      schoolId: options.schoolId,
      studentId: options.student.id,
      studentSessionId: previousStudentSession.id,
      deviceId: previousStudentSession.deviceId,
      reason: "session_replaced",
    });
  }

  const controlState = await getClasspilotStudentControlState(
    options.schoolId,
    options.student.id
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
    studentId: options.student.id,
    studentSessionId: session.id,
    exactBinding: classpilotControlStateExactBinding({
      schoolId: options.schoolId,
      deviceId: options.deviceId,
      studentId: options.student.id,
      studentSessionId: session.id,
      controlRevision: classroomState?.revision ?? 0,
    }),
    device,
    student: classPilotStudentDto(options.student),
    studentToken,
    manualExpiresInSeconds: 300,
    classroomState,
  };
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
const deviceLastHeartbeat = new Map<string, number>();
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
  for (const [key, ts] of deviceLastHeartbeat) {
    if (ts < cutoff) deviceLastHeartbeat.delete(key);
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
      const rosterThrottle = await enforceSharedRosterFetchThrottle(school.id, gradeLevel);
      if (!rosterThrottle.ok) {
        return res.status(429).json({
          error: "Too many roster requests, please wait",
          retryAfterSeconds: rosterThrottle.retryAfterSeconds,
        });
      }
      let students = await getStudentsBySchool(school.id);
      const grades = rosterGradesForStudents(students);
      const activeStudentIds = new Set(
        (await getActiveSessions(school.id))
          .filter((session) => {
            const lastSeenAt = session.lastSeenAt?.getTime?.() ?? 0;
            return lastSeenAt > 0 && Date.now() - lastSeenAt <= 5 * 60 * 1000;
          })
          .map((session) => session.studentId)
      );

      if (!gradeLevel) {
        return res.json({
          students: [],
          grades,
          loginMethod,
          pinLoginEnabled: true,
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
        }))
        .sort((a, b) => a.name.localeCompare(b.name));

      return res.json({ students: roster, grades, loginMethod, pinLoginEnabled: true });
    });
  } catch (err) {
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

    if (!deviceId) {
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

        const student = await getStudentByEmail(resolved.school.id, emailLc);
        if (
          !student ||
          student.status !== "active" ||
          String(student.studentIdNumber || "").trim() !== idNumber
        ) {
          return res.status(401).json({ error: "Invalid student credentials" });
        }

        const login = await completeStudentDeviceLogin({
          schoolId: resolved.school.id,
          deviceId,
          deviceName,
          classId,
          student,
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

      const student = await getStudentById(selectedStudentId);
      const lockout = await getPinLockout(school.id, selectedStudentId);
      if (!lockout.ok) {
        return res.status(429).json({
          error: "Too many PIN attempts. Try again later.",
          retryAfterSeconds: lockout.retryAfterSeconds,
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
        return res.status(401).json({ error: "Invalid student credentials" });
      }
      await clearPinFailures(school.id, selectedStudentId);

      const login = await completeStudentDeviceLogin({
        schoolId: school.id,
        deviceId,
        deviceName,
        classId,
        student,
      });
      return res.json(login);
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/classpilot/extension/sign-out - End the active student session for this token/device
router.post("/extension/sign-out", requireDeviceAuth, async (req, res, next) => {
  try {
    setClassPilotNoStore(res);
    const deviceId = res.locals.deviceId as string;
    const studentId = res.locals.studentId as string;
    const schoolId = res.locals.schoolId as string;
    const reason = normalizeExtensionSignOutReason(req.body?.reason);
    const active = await getActiveStudentForDevice(deviceId);
    if (active?.student.id === studentId) {
      await endStudentSession(active.session.id);
    }
    await broadcastStudentSignedOut({
      schoolId,
      studentId,
      studentSessionId: active?.session.id || (res.locals.studentSessionId as string),
      deviceId,
      reason,
    });
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

    await setActiveStudentForDevice(deviceId, studentId);
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
  requireCryptographicDeviceAuth,
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

    // --- Per-device rate limiting (item #9) ---
    const lastHb = deviceLastHeartbeat.get(deviceId);
    const now = Date.now();
    if (lastHb && now - lastHb < HEARTBEAT_MIN_INTERVAL_MS) {
      return res.status(204).send();
    }
    const pendingMessageRecoveryHeartbeat = !lastHb
      || now - lastHb >= PENDING_MESSAGE_RECONNECT_GAP_MS;
    setBoundedMap(deviceLastHeartbeat, deviceId, now, MAX_DEVICE_HEARTBEAT_ENTRIES);

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
          return { outcome: "outside_tracking_window" } as const;
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

      return { outcome: "recorded", heartbeat, school, controlState } as const;
    });
    recordHeartbeatHotPathTiming(
      "heartbeatDatabaseMs",
      Date.now() - heartbeatDatabaseStartedAt
    );

    if (heartbeatDbResult.outcome === "outside_tracking_window") {
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
    const { heartbeat, school, controlState } = heartbeatDbResult;
    const classroomState = controlState
      ? serializeClasspilotStudentControlState(controlState)
      : null;
    const enforcementHealth = controlState
      ? effectiveClasspilotControlEnforcementHealth(controlState, extensionVersion)
      : undefined;
    const screenshotPolicyPromise = protocol.acceptedCapabilities.includes("screenshotObservationLeaseV1")
      ? classpilotObservationStatus({
          schoolId,
          teachingSessionId: controlState?.teachingSessionId,
          studentId,
        }).then((status) => ({
          mode: "lease" as const,
          observed: status.status === "observed",
          expiresInSeconds: status.expiresInSeconds,
          serverTime: new Date().toISOString(),
          ...(status.status === "unavailable" ? { diagnostic: "unavailable" as const } : {}),
        }))
      : Promise.resolve({
          mode: "legacy" as const,
          observed: true,
          expiresInSeconds: 0,
          serverTime: new Date().toISOString(),
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
                const screenshotData = await getScreenshot(evidenceBinding);
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
                    : "Screenshot unavailable at safety alert",
                  contentType: evidenceSelection.available ? "image/jpeg" : null,
                  content: evidenceScreenshot?.screenshot ?? null,
                  capturedAt: evidenceSelection.available
                    ? new Date(evidenceScreenshot!.timestamp)
                    : new Date(),
                  metadata: {
                    capturedFromExactBinding: evidenceSelection.available,
                    unavailableReason: evidenceSelection.unavailableReason,
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
    const safetyCaptureRolloutActive = isClasspilotCapabilityActive(
      "safetyEvidenceCaptureV1",
      binding
    );
    let acceptedHeartbeatCapabilities = new Set<string>();
    if (leaseRolloutActive || safetyCaptureRolloutActive) {
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
      acceptedHeartbeatCapabilities = new Set(
        realtime.snapshot.acceptedCapabilities || []
      );
    }
    const leaseNegotiated = leaseRolloutActive
      && acceptedHeartbeatCapabilities.has("screenshotObservationLeaseV1");
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

    if (leaseNegotiated) {
      const observation = await runWithTenantContext(
        { schoolId },
        async () => {
          const controlState = await getClasspilotStudentControlState(schoolId, studentId);
          return classpilotObservationStatus({
            schoolId,
            teachingSessionId: controlState?.teachingSessionId,
            studentId,
          });
        }
      );
      if (observation.status !== "observed") {
        return res.status(409).json({
          ok: false,
          code: "SCREENSHOT_PAUSED_UNOBSERVED",
          screenshotPolicy: { mode: "lease", observed: false },
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
    if (!stored) {
      classpilotScreenshotFallback.set(binding, data);
    }
    recordScreenshotUpload(
      typeof screenshot === "string" ? Buffer.byteLength(screenshot, "utf8") : 0,
      stored
    );

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
    if (!parsed.ok) {
      releaseClassPilotTileAdmission(res);
      return res.status(400).json({ error: "studentIds must contain 1 to 50 non-empty strings" });
    }
    recordHeartbeatHotPathCounter("tileBatchScreenshotRequests");
    recordHeartbeatHotPathCounter("tileBatchScreenshotItems", parsed.studentIds.length);

    const scope = tileStaffScope(req, res);
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
    const screenshotBindings = accesses.flatMap((access) =>
      access.studentSessionId
        ? [{
            schoolId: access.schoolId,
            deviceId: access.deviceId,
            studentId: access.studentId,
            studentSessionId: access.studentSessionId,
          }]
        : []
    );
    const screenshots = await getScreenshots(screenshotBindings);
    const screenshotByStudent = new Map(
      screenshotBindings.map((binding, index) => [binding.studentId, screenshots[index] ?? null])
    );
    recordHeartbeatHotPathTiming(
      "tileBatchScreenshotRedisMs",
      Date.now() - redisStartedAt
    );
    const screenshotFallbackItems = screenshots.filter(
      (screenshot) => screenshot === null
    ).length;
    if (screenshotFallbackItems > 0) {
      recordHeartbeatHotPathCounter(
        "tileBatchScreenshotFallbackItems",
        screenshotFallbackItems
      );
    }
    return res.json({
      tiles: accesses.map((access) => ({
        studentId: access.studentId,
        screenshot: screenshotForAuthorizedStudent(
          screenshotByStudent.get(access.studentId) ??
            (access.studentSessionId
              ? classpilotScreenshotFallback.get({
                  schoolId: access.schoolId,
                  deviceId: access.deviceId,
                  studentId: access.studentId,
                  studentSessionId: access.studentSessionId,
                })
              : null),
          access
        ),
      })),
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/classpilot/tiles/history - Get one authorized history cohort
router.post("/tiles/history", ...tileReadAuth, async (req, res, next) => {
  setClassPilotNoStore(res);
  try {
    const parsed = parseTileStudentIds(req.body);
    const rawLimit = (req.body as { limit?: unknown } | undefined)?.limit;
    const limit = rawLimit === undefined ? 10 : rawLimit;
    if (
      !parsed.ok ||
      typeof limit !== "number" ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 10
    ) {
      releaseClassPilotTileAdmission(res);
      return res.status(400).json({
        error: "studentIds must contain 1 to 50 non-empty strings and limit must be an integer from 1 to 10",
      });
    }
    recordHeartbeatHotPathCounter("tileBatchHistoryRequests");
    recordHeartbeatHotPathCounter("tileBatchHistoryItems", parsed.studentIds.length);

    const scope = tileStaffScope(req, res);
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
        return {
          schoolId: device.schoolId,
          deviceId,
          studentId: activeSession?.studentId ?? null,
          studentSessionId: activeSession?.id ?? null,
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
    let data = binding ? await getScreenshot(binding) : null;
    if (!data && binding) {
      data = classpilotScreenshotFallback.get(binding);
    }

    const authorizedScreenshot = binding
      ? screenshotForAuthorizedStudent(data, binding)
      : null;
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
    await deleteDevice(deviceId);
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
