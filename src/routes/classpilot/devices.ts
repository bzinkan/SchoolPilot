import crypto from "crypto";
import { Router, type Request } from "express";
import { eq, and } from "drizzle-orm";
import { productLicenses } from "../../schema/core.js";
import db from "../../db.js";
import { authenticate } from "../../middleware/authenticate.js";
import { requireSchoolContext } from "../../middleware/requireSchoolContext.js";
import { requireActiveSchool } from "../../middleware/requireActiveSchool.js";
import { requireProductLicense } from "../../middleware/requireProductLicense.js";
import {
  requireDeviceAuth,
  requireDeviceAuthWithoutTenant,
} from "../../middleware/requireDeviceAuth.js";
import { requireRole } from "../../middleware/requireRole.js";
import {
  getDeviceById,
  getDevicesBySchool,
  createDevice,
  updateDevice,
  deleteDevice,
  createHeartbeat,
  updateHeartbeatClassification,
  getHeartbeatsByDevice,
  getHeartbeatsByDeviceInRange,
  createEvent,
  getStudentById,
  getStudentsBySchool,
  createStudent,
  touchStudentSession,
  getActiveSessionByDevice,
  resolveSchoolForStudent,
  getSchoolById,
  getSchoolBySlug,
  getSettingsForSchool,
  updateEnrollmentSettings,
  getStudentsForDevice,
  getActiveStudentForDevice,
  getActiveSessions,
  setActiveStudentForDevice,
  getAdminEmailsBySchool,
  addCentralEmailRecipientForSchool,
  upsertSettings,
  getRecentMessagesForStudent,
  getStudentByEmail,
  createEvidenceArtifact,
  createStudentTimelineEvent,
  endStudentSession,
} from "../../services/storage.js";
import { sendSafetyAlertEmail } from "../../services/email.js";
import { verifyStudentToken } from "../../services/deviceJwt.js";
import { comparePassword } from "../../util/password.js";
import { updateDeviceStatus, updateDeviceClassification, removeDeviceStatus } from "../../realtime/student-statuses.js";
import {
  broadcastToTeachersLocal,
  sendToDeviceLocal,
} from "../../realtime/ws-broadcast.js";
import {
  publishWS,
  setScreenshot,
  getScreenshot,
  setFlightPathStatus,
} from "../../realtime/ws-redis.js";
import { classifyUrl } from "../../services/aiClassification.js";
import { recordBrowserSafetyTimeline } from "./competitive.js";
import { runWithTenantContext } from "../../middleware/tenantContext.js";
import { scopedDeviceTargets } from "../../services/classpilotDeviceScope.js";
import { safeStudent, safeStudents } from "../../util/safeStudent.js";
import {
  enrollmentKeyFromRequest,
  issueStudentDeviceSessionToken,
  setClassPilotNoStore,
  validateEnrollmentKeyForSettings,
  verifyActiveStudentTokenSession,
} from "../../services/classpilotStudentAuth.js";
import {
  effectiveSharedChromebookLoginMethod,
} from "../../services/classpilotSharedChromebook.js";
import { buildStudentFabState } from "../../services/classpilotFab.js";

const router = Router();

// Cooldown for safety alerts: deviceId:domain → timestamp. Prevents duplicate alerts/emails.
const safetyAlertCooldown = new Map<string, number>();
// Track delivered message IDs per device to avoid re-sending
const deliveredMessages = new Map<string, Set<string>>();
const SAFETY_COOLDOWN_MS = 10 * 60 * 1000; // 10 minutes
const PIN_LOGIN_MAX_FAILURES = 5;
const PIN_LOGIN_LOCKOUT_MS = 10 * 60 * 1000;
const pinLoginFailures = new Map<string, { count: number; lockedUntil: number }>();

// In-memory cache for school lookups (reduces DB queries on heartbeats)
const schoolCache = new Map<string, { school: any; expires: number }>();
const SCHOOL_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

async function getCachedSchool(schoolId: string) {
  const cached = schoolCache.get(schoolId);
  if (cached && cached.expires > Date.now()) return cached.school;
  const school = await getSchoolById(schoolId);
  if (school) schoolCache.set(schoolId, { school, expires: Date.now() + SCHOOL_CACHE_TTL });
  return school;
}

// In-memory cache for product license checks (saves 1 DB query per heartbeat)
const licenseCache = new Map<string, { hasLicense: boolean; expires: number }>();
const LICENSE_CACHE_TTL = 30 * 60 * 1000; // 30 minutes — licenses don't change often

async function hasCachedClassPilotLicense(schoolId: string): Promise<boolean> {
  const cached = licenseCache.get(schoolId);
  if (cached && cached.expires > Date.now()) return cached.hasLicense;
  const [row] = await db.select().from(productLicenses).where(and(eq(productLicenses.schoolId, schoolId), eq(productLicenses.product, "CLASSPILOT"), eq(productLicenses.status, "active"))).limit(1);
  const hasLicense = !!row;
  licenseCache.set(schoolId, { hasLicense, expires: Date.now() + LICENSE_CACHE_TTL });
  return hasLicense;
}

function param(req: any, key: string): string {
  return String(req.params[key] ?? "");
}

// Per-IP rate limit for extension endpoints to prevent DB connection exhaustion
import rateLimit, { ipKeyGenerator } from "express-rate-limit";
function extensionIp(req: Request): string {
  return ipKeyGenerator(req.ip || req.socket.remoteAddress || "0.0.0.0");
}

const extensionConfigLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 180,
  message: { error: "Too many setup/config requests, please wait" },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: extensionIp,
});

const extensionRosterLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 90,
  message: { error: "Too many roster requests, please wait" },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => [
    extensionIp(req),
    String(req.query.schoolId || req.query.schoolSlug || ""),
    normalizeGradeLevel(req.query.gradeLevel) || "",
  ].join(":"),
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
});

const deviceActionLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  message: { error: "Too many device requests, please wait" },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => ipKeyGenerator(req.ip || req.socket.remoteAddress || "0.0.0.0"),
});

const staffAuth = [
  authenticate,
  requireSchoolContext,
  requireActiveSchool,
  requireProductLicense("CLASSPILOT"),
] as const;

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

function getPinLockout(schoolId: string, studentId: string): { ok: true } | { ok: false; retryAfterSeconds: number } {
  const key = getPinFailureKey(schoolId, studentId);
  const failure = pinLoginFailures.get(key);
  if (!failure) {
    return { ok: true };
  }
  if (failure.lockedUntil > 0 && failure.lockedUntil <= Date.now()) {
    pinLoginFailures.delete(key);
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

function recordPinFailure(schoolId: string, studentId: string) {
  const key = getPinFailureKey(schoolId, studentId);
  const current = pinLoginFailures.get(key);
  const now = Date.now();
  if (current?.lockedUntil && current.lockedUntil > now) return;
  const count = (current?.count || 0) + 1;
  pinLoginFailures.set(key, {
    count,
    lockedUntil: count >= PIN_LOGIN_MAX_FAILURES ? now + PIN_LOGIN_LOCKOUT_MS : 0,
  });
}

function clearPinFailures(schoolId: string, studentId: string) {
  pinLoginFailures.delete(getPinFailureKey(schoolId, studentId));
}

async function broadcastStudentSignedOut(options: {
  schoolId: string;
  studentId: string;
  deviceId: string;
  reason: string;
}) {
  removeDeviceStatus(options.schoolId, options.deviceId);
  const signOutUpdate = {
    type: "student-signed-out",
    studentId: options.studentId,
    deviceId: options.deviceId,
    schoolId: options.schoolId,
    status: "offline",
    reason: options.reason,
    timestamp: new Date().toISOString(),
  };
  broadcastToTeachersLocal(options.schoolId, signOutUpdate);
  await publishWS({ kind: "staff", schoolId: options.schoolId }, signOutUpdate);
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

  const {
    device,
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

  if (previousDeviceSession && previousDeviceSession.studentId !== options.student.id) {
    await broadcastStudentSignedOut({
      schoolId: options.schoolId,
      studentId: previousDeviceSession.studentId,
      deviceId: options.deviceId,
      reason: "session_replaced",
    });
  }

  if (previousStudentSession && previousStudentSession.deviceId !== options.deviceId) {
    const replacedMessage = {
      type: "student-session-replaced",
      studentId: options.student.id,
      deviceId: previousStudentSession.deviceId,
      replacementDeviceId: options.deviceId,
      timestamp: new Date().toISOString(),
    };
    sendToDeviceLocal(options.schoolId, previousStudentSession.deviceId, replacedMessage);
    await publishWS({ kind: "device", schoolId: options.schoolId, deviceId: previousStudentSession.deviceId }, replacedMessage);
    await broadcastStudentSignedOut({
      schoolId: options.schoolId,
      studentId: options.student.id,
      deviceId: previousStudentSession.deviceId,
      reason: "session_replaced",
    });
  }

  broadcastToTeachersLocal(options.schoolId, {
    type: "student-registered",
    studentId: options.student.id,
    deviceId: options.deviceId,
    studentEmail,
    studentName: `${options.student.firstName || ""} ${options.student.lastName || ""}`.trim() || options.student.email || "Student",
  });
  await publishWS({ kind: "staff", schoolId: options.schoolId }, {
    type: "student-registered",
    studentId: options.student.id,
    deviceId: options.deviceId,
  });

  return {
    success: true,
    device,
    student: safeStudent(options.student),
    studentToken,
    manualExpiresInSeconds: 300,
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

// Periodic cleanup of stale rate-limit entries
setInterval(() => {
  const cutoff = Date.now() - 120_000; // remove entries older than 2 min
  for (const [key, ts] of deviceLastHeartbeat) {
    if (ts < cutoff) deviceLastHeartbeat.delete(key);
  }
}, RATE_LIMIT_CLEANUP_INTERVAL_MS);

// ============================================================================
// Per-school auto-creation throttle — anti-spam guard
// /extension/register can auto-create a student record when a Chromebook signs in
// with an unrecognized email at a known school domain. To prevent abuse (someone
// creating thousands of fake students at a school's domain), we cap auto-creations
// at MAX_AUTO_CREATIONS per school per hour. Caps don't block real first-day-of-
// school enrollment unless a single school enrolls >100 students in an hour, which
// is rare and would surface as a legitimate signal worth investigating anyway.
// ============================================================================
const schoolAutoCreations = new Map<string, { count: number; windowStart: number }>();
const AUTO_CREATE_WINDOW_MS = 60 * 60 * 1000; // 1 hour
const MAX_AUTO_CREATIONS = 100;

function recordAutoCreation(schoolId: string): boolean {
  const now = Date.now();
  const entry = schoolAutoCreations.get(schoolId);
  if (!entry || now - entry.windowStart > AUTO_CREATE_WINDOW_MS) {
    schoolAutoCreations.set(schoolId, { count: 1, windowStart: now });
    return true;
  }
  if (entry.count >= MAX_AUTO_CREATIONS) return false;
  entry.count++;
  return true;
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
      try {
        const payload = verifyStudentToken(studentToken);
        const hasActiveSession = await runWithTenantContext(
          { schoolId: payload.schoolId },
          () => verifyActiveStudentTokenSession(payload)
        );
        if (!hasActiveSession) {
          return res.status(401).json({ error: "Student session is no longer active" });
        }
        const school = await getSchoolById(payload.schoolId);
        if (school) {
          return res.json({
            schoolId: school.id,
            schoolActive: school.status === "active",
            planStatus: school.planStatus || "active",
            status: school.status,
            schoolSessionVersion: 1,
          });
        }
      } catch { /* fall through to email lookup */ }
    }

    if (!studentEmail) {
      return res.status(400).json({ error: "studentEmail required" });
    }

    // Email-based lookup (unauthenticated): return minimal info to avoid enumeration
    const result = await resolveSchoolForStudent(studentEmail);
    if (!result) {
      return res.status(401).json({ error: "Not eligible" });
    }
    const isActive = result.school.status === "active";

    // Minimal response — schoolId, planStatus, and status omitted intentionally.
    // The extension calls /extension/register next which returns the full JWT with schoolId.
    return res.json({
      schoolActive: isActive,
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
      if (!(await hasCachedClassPilotLicense(school.id))) {
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

      return res.json({
        sharedSignInEnabled: true,
        loginMethod,
        pinLoginEnabled: loginMethod === "name_pin",
        schoolName: regSettings.schoolName || school.name,
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
      if (!(await hasCachedClassPilotLicense(school.id))) {
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
router.get("/extension/settings", requireDeviceAuth, async (_req, res, next) => {
  try {
    const schoolId = res.locals.schoolId as string;
    const studentId = res.locals.studentId as string;
    const schoolSettings = await getSettingsForSchool(schoolId);
    const school = await getSchoolById(schoolId);
    if (!school) {
      return res.status(404).json({ error: "School not found" });
    }
    const fab = await buildStudentFabState(schoolId, studentId);

    return res.json({
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
      if (!resolved || resolved.school.status !== "active") {
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

      await runWithTenantContext({ schoolId: resolved.school.id }, async () => {
        if (!(await hasCachedClassPilotLicense(resolved.school.id))) {
          return res.status(403).json({ error: "ClassPilot license is not active" });
        }

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

    if (!school || school.status !== "active" || !selectedStudentId || !/^\d{4}$/.test(enteredPin)) {
      return res.status(401).json({ error: "Invalid student credentials" });
    }

    await runWithTenantContext({ schoolId: school.id }, async () => {
      if (!(await hasCachedClassPilotLicense(school.id))) {
        return res.status(403).json({ error: "ClassPilot license is not active" });
      }

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
      const lockout = getPinLockout(school.id, selectedStudentId);
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
        recordPinFailure(school.id, selectedStudentId);
        return res.status(401).json({ error: "Invalid student credentials" });
      }
      clearPinFailures(school.id, selectedStudentId);

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
router.post("/extension/sign-out", requireDeviceAuth, async (_req, res, next) => {
  try {
    setClassPilotNoStore(res);
    const deviceId = res.locals.deviceId as string;
    const studentId = res.locals.studentId as string;
    const schoolId = res.locals.schoolId as string;
    const active = await getActiveStudentForDevice(deviceId);
    if (active?.student.id === studentId) {
      await endStudentSession(active.session.id);
    }
    removeDeviceStatus(schoolId, deviceId);
    const update = {
      type: "student-signed-out",
      studentId,
      deviceId,
      schoolId,
      status: "offline",
      reason: "explicit_sign_out",
      timestamp: new Date().toISOString(),
    };
    broadcastToTeachersLocal(schoolId, update);
    await publishWS({ kind: "staff", schoolId }, update);
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
    if (!school || school.status !== "active") {
      return res.status(403).json({ error: "School is not active" });
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
    const { deviceId, deviceName, studentEmail, studentName, schoolId: explicitSchoolId, classId } = req.body;
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

    // Check school is active
    if (school.status !== "active") {
      return res.status(403).json({ error: "School is not active" });
    }

    // Unauthenticated route: bind the resolved+validated school's tenant context
    // for the rest of the handler so RLS is satisfied AND the enrollment-key gate
    // (getSettingsForSchool below) reads real settings instead of failing open.
    await runWithTenantContext({ schoolId: resolvedSchoolId }, async () => {
    if (studentEmail && !(await hasCachedClassPilotLicense(resolvedSchoolId))) {
      return res.status(403).json({ error: "ClassPilot license is not active" });
    }

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
        if (!recordAutoCreation(resolvedSchoolId)) {
          console.warn(`[Security] Auto-creation rate limit hit for school ${resolvedSchoolId}; rejecting ${studentEmail}`);
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

      return res.json({
        ...login,
        studentName: studentName || `${student.firstName || ""} ${student.lastName || ""}`.trim() || student.email,
      });
    }

    return res.json({ device });
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
    if (resolved.school.status !== "active") {
      return res.status(403).json({ error: "School is not active" });
    }
    if (!(await hasCachedClassPilotLicense(resolvedSchoolId))) {
      return res.status(403).json({ error: "ClassPilot license required" });
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

      if (!student) {
        if (!regSettings?.autoEnrollStudents) {
          return res.status(403).json({
            error: "Student not enrolled. Ask your administrator to import this student before connecting a device.",
          });
        }
        // Anti-spam: cap auto-creations per school per hour
        if (!recordAutoCreation(resolvedSchoolId)) {
          console.warn(`[Security] Auto-creation rate limit hit on /register-student for school ${resolvedSchoolId}`);
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
        student: login.student,
        manualExpiresInSeconds: login.manualExpiresInSeconds,
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
router.get("/device/:deviceId/students", deviceActionLimiter, requireDeviceAuth, async (req, res, next) => {
  try {
    const deviceId = param(req, "deviceId");
    if (deviceId !== res.locals.deviceId) {
      return res.status(403).json({ error: "Device token does not match requested device" });
    }
    if (!(await hasCachedClassPilotLicense(res.locals.schoolId as string))) {
      return res.status(402).json({ planStatus: "inactive" });
    }

    const students = await getStudentsForDevice(deviceId);
    const active = await getActiveStudentForDevice(deviceId);
    return res.json({
      students: safeStudents(students),
      activeStudentId: active?.student.id || null,
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/classpilot/device/:deviceId/active-student - Set active student on device
router.post("/device/:deviceId/active-student", deviceActionLimiter, requireDeviceAuth, async (req, res, next) => {
  try {
    const deviceId = param(req, "deviceId");
    if (deviceId !== res.locals.deviceId) {
      return res.status(403).json({ error: "Device token does not match requested device" });
    }
    const schoolId = res.locals.schoolId as string;
    if (!(await hasCachedClassPilotLicense(schoolId))) {
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

// ============================================================================
// Heartbeat (items #1, #2, #3, #5, #8, #9)
// ============================================================================

// POST /api/classpilot/device/heartbeat - Device sends heartbeat (device JWT auth)
router.post("/device/heartbeat", requireDeviceAuth, async (req, res, next) => {
  try {
    const {
      activeTabUrl, activeTabTitle, visibilityState, screenLocked,
      allOpenTabs, favicon, isScreenRecording, isScreenSharing,
      cameraActive, status: trackingStatus, activeStudentId,
      flightPathActive, activeFlightPathName, screenshotHealth,
      extensionVersion, chromeVersion,
    } = req.body;
    const schoolId = res.locals.schoolId as string;
    const studentId = res.locals.studentId as string;
    const deviceId = res.locals.deviceId as string;
    const tokenStudentEmail = res.locals.studentEmail as string | undefined;

    // --- Per-device rate limiting (item #9) ---
    const lastHb = deviceLastHeartbeat.get(deviceId);
    const now = Date.now();
    if (lastHb && now - lastHb < HEARTBEAT_MIN_INTERVAL_MS) {
      return res.status(204).send();
    }
    deviceLastHeartbeat.set(deviceId, now);

    // --- ClassPilot license check (cached — saves 1 DB query per heartbeat) ---
    if (!(await hasCachedClassPilotLicense(schoolId))) {
      return res.status(403).json({ error: "school_not_entitled", planStatus: "inactive" });
    }

    // --- Student existence check ---
    // If the student was deleted (e.g., duplicate cleanup migration), return 401
    // to force the extension to re-register and get a JWT pointing to the surviving record.
    const student = await getStudentById(studentId);
    if (!student) {
      return res.status(401).json({ error: "Student not found — re-register required" });
    }
    const studentEmail = tokenStudentEmail || student.email || "";

    // --- Tracking window enforcement (item #2) ---
    const schoolSettings = await getSettingsForSchool(schoolId);
    if (schoolSettings && !isWithinTrackingWindow(schoolSettings)) {
      const afterMode = schoolSettings.afterHoursMode || "off";
      if (afterMode === "off") {
        return res.status(204).send();
      }
      // "limited" or "full" mode: continue processing
    }

    // --- Get school for planStatus (item #3) — cached to reduce DB queries ---
    const school = await getCachedSchool(schoolId);
    if (!school || school.status !== "active") {
      return res.status(402).json({ planStatus: "inactive" });
    }

    const activeSession = await getActiveSessionByDevice(deviceId);
    if (!activeSession || activeSession.studentId !== studentId) {
      removeDeviceStatus(schoolId, deviceId);
      const signOutUpdate = {
        type: "student-signed-out",
        studentId,
        deviceId,
        schoolId,
        status: "offline",
        reason: "session_replaced",
        timestamp: new Date().toISOString(),
      };
      broadcastToTeachersLocal(schoolId, signOutUpdate);
      await publishWS({ kind: "staff", schoolId }, signOutUpdate);
      return res.status(409).json({
        error: "student_session_replaced",
        message: "This student is signed in on another Chromebook.",
      });
    }

    // --- Save heartbeat to DB (item #1 — capture all fields) ---
    const heartbeat = await createHeartbeat({
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
      extensionVersion: extensionVersion || null,
      chromeVersion: chromeVersion || null,
      screenshotHealth: screenshotHealth || null,
    });

    const deviceUpdate: Record<string, unknown> = { lastSeenAt: new Date() };
    if (extensionVersion !== undefined) deviceUpdate.extensionVersion = extensionVersion || null;
    if (chromeVersion !== undefined) deviceUpdate.chromeVersion = chromeVersion || null;
    if (screenshotHealth !== undefined) deviceUpdate.lastScreenshotHealth = screenshotHealth || null;
    void updateDevice(deviceId, deviceUpdate).catch(() => {});
    void touchStudentSession(studentId, deviceId).catch(() => {});

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
      deviceId,
      schoolId,
      activeTabUrl,
      activeTabTitle,
      visibilityState,
      screenLocked,
      isScreenRecording,
      isScreenSharing,
      cameraActive,
      status: trackingStatus,
      flightPathActive,
      activeFlightPathName,
      allOpenTabs: allOpenTabs || [],
      favicon,
      timestamp: new Date().toISOString(),
    };

    broadcastToTeachersLocal(schoolId, update);
    await publishWS({ kind: "staff", schoolId }, update);

    // --- AI content classification (item #8) — async, non-blocking ---
    if (activeTabUrl && !activeTabUrl.startsWith("chrome")) {
      classifyUrl(activeTabUrl, activeTabTitle, { schoolDomain: school.domain }).then(async (classification) => {
        if (!classification) return;

        // Store classification in realtime status so students-aggregated includes it
        updateDeviceClassification(schoolId, deviceId, {
          category: classification.category,
          safetyAlert: classification.safetyAlert,
        });

        // Persist classification to the heartbeat record
        // Detached callback (request connection already released) → re-establish
        // this school's context so classification persists under heartbeats RLS.
        void runWithTenantContext({ schoolId }, async () => {
          await updateHeartbeatClassification(heartbeat.id, classification.category, classification.safetyAlert);
        }).catch(() => {});

        // Broadcast classification to teachers
        const classificationUpdate = {
          type: "ai-classification",
          studentId,
          deviceId,
          classification,
        };
        broadcastToTeachersLocal(schoolId, classificationUpdate);
        void publishWS({ kind: "staff", schoolId }, classificationUpdate);

        // Safety alert — broadcast urgently + email admins + force close tab
        if (classification.safetyAlert) {
          // Always close the tab immediately regardless of cooldown
          const closeCmd = {
            type: "remote-control",
            _msgId: crypto.randomUUID(),
            command: { type: "close-tab", data: { pattern: classification.domain } },
          };
          sendToDeviceLocal(schoolId, deviceId, closeCmd);
          void publishWS({ kind: "device", schoolId, deviceId }, closeCmd);

          // Cooldown: only send alerts/emails once per device per domain per 10 min
          const cooldownKey = `${deviceId}:${classification.domain}`;
          const lastAlert = safetyAlertCooldown.get(cooldownKey) || 0;
          if (Date.now() - lastAlert < SAFETY_COOLDOWN_MS) {
            return; // Skip duplicate alert — tab close already sent above
          }
          safetyAlertCooldown.set(cooldownKey, Date.now());

          // Detached callback: the request's tenant connection is already
          // released, so re-establish this school's context for the safety-case
          // / AI-decision / timeline / evidence writes (classpilot_ai_decisions,
          // student_safety_cases, student_timeline_events, evidence_artifacts).
          await runWithTenantContext({ schoolId }, async () => {
          const timelineRecord = await recordBrowserSafetyTimeline({
            schoolId,
            studentId,
            deviceId,
            heartbeatId: heartbeat.id,
            url: activeTabUrl,
            title: activeTabTitle,
            classification,
          }).catch((err) => {
            console.warn("[Safety] Failed to record AI decision timeline:", err);
            return null;
          });

          if (timelineRecord?.caseId) {
            try {
              const screenshotData = await getScreenshot(deviceId);
              await createEvidenceArtifact({
                schoolId,
                studentId,
                caseId: timelineRecord.caseId,
                sourceType: "classpilot_screenshot",
                sourceId: heartbeat.id,
                artifactType: "screenshot",
                status: screenshotData?.screenshot ? "available" : "unavailable",
                label: screenshotData?.screenshot ? "Screenshot at safety alert" : "Screenshot unavailable at safety alert",
                contentType: screenshotData?.screenshot ? "image/jpeg" : null,
                content: screenshotData?.screenshot || null,
                metadata: {
                  deviceId,
                  tabTitle: screenshotData?.tabTitle || activeTabTitle,
                  tabUrl: screenshotData?.tabUrl || activeTabUrl,
                  capturedFromRedis: !!screenshotData?.screenshot,
                },
              });
            } catch (err) {
              console.warn("[Safety] Failed to snapshot evidence artifact:", err);
            }
          }
          });

          const alert = {
            type: "safety-alert",
            studentId,
            deviceId,
            studentEmail,
            alert: classification.safetyAlert,
            url: activeTabUrl,
            title: activeTabTitle,
            domain: classification.domain,
            timestamp: new Date().toISOString(),
          };
          broadcastToTeachersLocal(schoolId, alert);
          void publishWS({ kind: "staff", schoolId }, alert);

          // Send email to school admins if enabled
          if (schoolSettings?.aiSafetyEmailsEnabled !== false) {
            runWithTenantContext({ schoolId }, async () =>
              addCentralEmailRecipientForSchool(schoolId, await getAdminEmailsBySchool(schoolId))
            ).then((recipients) => {
              if (recipients.length > 0) {
                void sendSafetyAlertEmail({
                  recipients,
                  studentEmail,
                  alertType: classification.safetyAlert!,
                  url: activeTabUrl,
                  title: activeTabTitle || "Unknown",
                  schoolName: school?.name || "Your School",
                });
              }
            }).catch((err) => {
              console.error("[Safety] Failed to send alert emails:", err);
            });
          }

          // AI handles unsafe content in real-time (tab close + safety alert above).
          // Domains are NOT auto-added to the school blocklist — only admin-entered domains go there.
        }
      }).catch(() => { /* non-blocking */ });
    }

    // --- Deliver any missed messages (item #3b) ---
    // Only check DB for pending messages on the FIRST heartbeat from a device
    // (when deliveredMessages has no entry). After that, WebSocket handles delivery.
    // This saves 1 DB query on every subsequent heartbeat (~99% of traffic).
    let pendingMessages: Array<{ id: string; message: string }> = [];
    const isFirstHeartbeat = !deliveredMessages.has(deviceId);
    if (isFirstHeartbeat) {
      try {
        const recent = await getRecentMessagesForStudent(studentId, 5);
        if (recent.length > 0) {
          const delivered = new Set<string>();
          deliveredMessages.set(deviceId, delivered);
          pendingMessages = recent.map(m => ({ id: m.id, message: m.message }));
          for (const m of pendingMessages) delivered.add(m.id);
        } else {
          deliveredMessages.set(deviceId, new Set());
        }
      } catch { /* non-blocking */ }
    }

    // --- Return planStatus (item #3) ---
    return res.json({
      ok: true,
      planStatus: school.planStatus || "active",
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
router.post("/device/screenshot", requireDeviceAuthWithoutTenant, async (req, res, next) => {
  try {
    const { screenshot, tabTitle, tabUrl, tabFavicon } = req.body;
    const deviceId = res.locals.deviceId as string;
    const schoolId = res.locals.schoolId as string;

    console.log(`[Screenshot] Upload from device=${deviceId} school=${schoolId} size=${screenshot ? Math.round(screenshot.length / 1024) + 'KB' : 'empty'}`);

    if (!screenshot) {
      return res.status(400).json({ error: "screenshot data required" });
    }

    const data = {
      screenshot,
      timestamp: Date.now(),
      tabTitle,
      tabUrl,
      tabFavicon,
    };

    // Try Redis first, fall back to in-memory
    const stored = await setScreenshot(deviceId, data);
    if (!stored) {
      (globalThis as any).__screenshots = (globalThis as any).__screenshots || new Map();
      (globalThis as any).__screenshots.set(deviceId, data);
    }

    // Notify teachers
    broadcastToTeachersLocal(schoolId, {
      type: "screenshot-available",
      deviceId,
      timestamp: data.timestamp,
    });

    return res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// GET /api/classpilot/device/screenshot/:deviceId - Get screenshot
router.get("/device/screenshot/:deviceId", ...staffAuth, async (req, res, next) => {
  try {
    const deviceId = param(req, "deviceId");
    const device = await getDeviceById(deviceId);
    if (!device || device.schoolId !== res.locals.schoolId) {
      return res.status(404).json({ error: "Device not found" });
    }

    let data = await getScreenshot(deviceId);
    if (!data) {
      data = (globalThis as any).__screenshots?.get(deviceId) || null;
    }

    if (!data) {
      return res.status(404).json({ error: "No screenshot available" });
    }

    return res.json(data);
  } catch (err) {
    next(err);
  }
});

// ============================================================================
// Events (item #3 — return planStatus)
// ============================================================================

// POST /api/classpilot/device/event - Log device event
router.post("/device/event", requireDeviceAuth, async (req, res, next) => {
  try {
    const { eventType, metadata } = req.body;
    const deviceId = res.locals.deviceId as string;
    const studentId = res.locals.studentId as string;
    const schoolId = res.locals.schoolId as string;

    // Check school active for planStatus
    const school = await getSchoolById(schoolId);
    if (!school || school.status !== "active") {
      return res.status(402).json({ planStatus: "inactive" });
    }

    await createEvent({
      deviceId,
      studentId,
      eventType: eventType || "unknown",
      metadata: metadata || null,
    });

    // Broadcast relevant event types to teachers
    const broadcastTypes = new Set([
      "consent_granted", "consent_revoked", "blocked_domain",
      "navigation", "url_change", "student_switched",
    ]);
    if (broadcastTypes.has(eventType)) {
      const eventMsg = {
        type: "student-event",
        studentId,
        deviceId,
        eventType,
        metadata,
        timestamp: new Date().toISOString(),
      };
      broadcastToTeachersLocal(schoolId, eventMsg);
      void publishWS({ kind: "staff", schoolId }, eventMsg);
    }

    return res.json({ ok: true, planStatus: school.planStatus || "active" });
  } catch (err) {
    // Bulletproof: never return 500 for events
    return res.status(204).send();
  }
});

// ============================================================================
// Device Management (staff-only)
// ============================================================================

// GET /api/classpilot/devices - List all devices for school
router.get("/devices", ...staffAuth, async (req, res, next) => {
  try {
    const devices = await getDevicesBySchool(res.locals.schoolId!);
    return res.json({ devices });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/classpilot/devices/:deviceId - Update device
router.patch("/devices/:deviceId", ...staffAuth, async (req, res, next) => {
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
router.delete("/devices/:deviceId", ...staffAuth, requireRole("admin"), async (req, res, next) => {
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
router.get("/heartbeats", ...staffAuth, async (req, res, next) => {
  try {
    const devices = await getDevicesBySchool(res.locals.schoolId!);
    const heartbeats: unknown[] = [];
    for (const device of devices.slice(0, 50)) {
      const hb = await getHeartbeatsByDevice(device.deviceId, 1);
      if (hb.length > 0) heartbeats.push({ deviceId: device.deviceId, ...hb[0] });
    }
    return res.json({ heartbeats });
  } catch (err) {
    next(err);
  }
});

// GET /api/classpilot/heartbeats/:deviceId - Device heartbeat history
router.get("/heartbeats/:deviceId", ...staffAuth, async (req, res, next) => {
  try {
    const deviceId = param(req, "deviceId");
    const device = await getDeviceById(deviceId);
    if (!device || device.schoolId !== res.locals.schoolId) {
      return res.status(404).json({ error: "Device not found" });
    }
    const limit = parseInt(req.query.limit as string) || 50;
    const startTime = req.query.startTime as string | undefined;
    const endTime = req.query.endTime as string | undefined;

    let heartbeats;
    if (startTime) {
      // Filter by time range (for session-scoped views)
      const start = new Date(startTime);
      const end = endTime ? new Date(endTime) : new Date();
      heartbeats = await getHeartbeatsByDeviceInRange(deviceId, start, end);
    } else {
      heartbeats = await getHeartbeatsByDevice(deviceId, limit);
    }
    return res.json({ heartbeats });
  } catch (err) {
    next(err);
  }
});

// ============================================================================
// Remote Control Commands
// ============================================================================

function remoteCommand(type: string) {
  return async (req: any, res: any, next: any) => {
    try {
      const schoolId = res.locals.schoolId!;
      const { deviceIds, targetDeviceIds, tabsToClose, ...payload } = req.body;

      // Accept deviceIds, targetDeviceIds, or extract from tabsToClose
      let resolvedDeviceIds: string[] | undefined = deviceIds || targetDeviceIds || undefined;
      if (
        (!Array.isArray(resolvedDeviceIds) || resolvedDeviceIds.length === 0) &&
        Array.isArray(tabsToClose) &&
        tabsToClose.length > 0
      ) {
        resolvedDeviceIds = [
          ...new Set(tabsToClose.map((t: any) => t.deviceId).filter(Boolean)),
        ] as string[];
      }
      if (!Array.isArray(resolvedDeviceIds) || resolvedDeviceIds.length === 0) {
        return res.status(400).json({
          error: "Explicit targetDeviceIds are required. Use /classpilot/commands for class-scoped teacher commands.",
        });
      }

      let rejectedDeviceCount = 0;
      // Reject device ids that don't belong to this school.
      if (Array.isArray(resolvedDeviceIds) && resolvedDeviceIds.length > 0) {
        const scoped = await scopedDeviceTargets(resolvedDeviceIds, schoolId);
        if (scoped.deviceIds.length === 0) {
          return res.status(404).json({ error: "No accessible devices", rejectedDeviceCount: scoped.rejectedDeviceCount });
        }
        rejectedDeviceCount = scoped.rejectedDeviceCount;
        resolvedDeviceIds = scoped.deviceIds;
      }

      // Build command in the format the extension expects:
      // { type: "remote-control", command: { type: "...", data: { ... } } }
      const commandData: Record<string, unknown> = { ...payload };

      // Transform close-tabs: extension expects "close-tab" with data.specificUrls
      if (type === "close-tabs" && Array.isArray(tabsToClose)) {
        commandData.specificUrls = tabsToClose.map((t: any) => t.url);
      }
      if (type === "close-tabs" && payload.closeAll) {
        commandData.closeAll = true;
      }

      // Extension uses singular "close-tab", not "close-tabs"
      const extensionType = type === "close-tabs" ? "close-tab" : type;

      const message = {
        type: "remote-control",
        _msgId: crypto.randomUUID(),
        command: {
          type: extensionType,
          data: commandData,
        },
      };

      if (Array.isArray(resolvedDeviceIds) && resolvedDeviceIds.length > 0) {
        // Send to specific devices
        for (const deviceId of resolvedDeviceIds) {
          sendToDeviceLocal(schoolId, deviceId, message);
        }
        await publishWS(
          { kind: "students", schoolId, targetDeviceIds: resolvedDeviceIds },
          message
        );
        await recordRemoteActionTimeline({
          schoolId,
          deviceIds: resolvedDeviceIds,
          action: extensionType,
          actorUserId: req.authUser!.id,
          metadata: commandData,
        });
        return res.json({ success: true, sent: resolvedDeviceIds.length, rejectedDeviceCount });
      }
      return res.status(400).json({ error: "No target devices resolved" });
    } catch (err) {
      next(err);
    }
  };
}

router.post("/remote/open-tab", ...staffAuth, remoteCommand("open-tab"));
router.post("/remote/close-tabs", ...staffAuth, remoteCommand("close-tabs"));
router.post("/remote/lock-screen", ...staffAuth, remoteCommand("lock-screen"));
router.post("/remote/unlock-screen", ...staffAuth, remoteCommand("unlock-screen"));
router.post("/remote/temp-unblock", ...staffAuth, remoteCommand("temp-unblock"));
router.post("/remote/limit-tabs", ...staffAuth, remoteCommand("limit-tabs"));
router.post("/remote/attention-mode", ...staffAuth, remoteCommand("attention-mode"));
router.post("/remote/timer", ...staffAuth, remoteCommand("timer"));

// POST /api/classpilot/remote/apply-flight-path - Apply flight path to devices
router.post("/remote/apply-flight-path", ...staffAuth, async (req, res, next) => {
  try {
    const schoolId = res.locals.schoolId!;
    const { deviceIds, targetDeviceIds, flightPathId, flightPathName, allowedDomains } = req.body;
    let resolvedDeviceIds: string[] | undefined = deviceIds || targetDeviceIds || undefined;
    if (!Array.isArray(resolvedDeviceIds) || resolvedDeviceIds.length === 0) {
      return res.status(400).json({
        error: "Explicit targetDeviceIds are required. Use /classpilot/commands for class-scoped teacher commands.",
      });
    }

    let rejectedDeviceCount = 0;
    // Reject device ids that don't belong to this school.
    if (Array.isArray(resolvedDeviceIds) && resolvedDeviceIds.length > 0) {
      const scoped = await scopedDeviceTargets(resolvedDeviceIds, schoolId);
      if (scoped.deviceIds.length === 0) {
        return res.status(404).json({ error: "No accessible devices", rejectedDeviceCount: scoped.rejectedDeviceCount });
      }
      rejectedDeviceCount = scoped.rejectedDeviceCount;
      resolvedDeviceIds = scoped.deviceIds;
    }

    const message = {
      type: "remote-control",
      _msgId: crypto.randomUUID(),
      command: { type: "apply-flight-path", data: { flightPathId, flightPathName, allowedDomains } },
    };

    if (Array.isArray(resolvedDeviceIds) && resolvedDeviceIds.length > 0) {
      // Send to specific devices
      for (const deviceId of resolvedDeviceIds) {
        sendToDeviceLocal(schoolId, deviceId, message);
        await setFlightPathStatus(deviceId, {
          active: true,
          flightPathId,
          flightPathName,
          appliedAt: Date.now(),
        });
      }
      await publishWS({ kind: "students", schoolId, targetDeviceIds: resolvedDeviceIds }, message);
      await recordRemoteActionTimeline({
        schoolId,
        deviceIds: resolvedDeviceIds,
        action: "apply-flight-path",
        actorUserId: req.authUser!.id,
        metadata: { flightPathId, flightPathName },
      });
      return res.json({ success: true, sent: resolvedDeviceIds.length, rejectedDeviceCount });
    }
    return res.status(400).json({ error: "No target devices resolved" });
  } catch (err) {
    next(err);
  }
});

// POST /api/classpilot/remote/remove-flight-path - Remove flight path
router.post("/remote/remove-flight-path", ...staffAuth, async (req, res, next) => {
  try {
    const schoolId = res.locals.schoolId!;
    const { deviceIds, targetDeviceIds } = req.body;
    let resolvedDeviceIds: string[] | undefined = deviceIds || targetDeviceIds || undefined;
    if (!Array.isArray(resolvedDeviceIds) || resolvedDeviceIds.length === 0) {
      return res.status(400).json({
        error: "Explicit targetDeviceIds are required. Use /classpilot/commands for class-scoped teacher commands.",
      });
    }

    let rejectedDeviceCount = 0;
    // Reject device ids that don't belong to this school.
    if (Array.isArray(resolvedDeviceIds) && resolvedDeviceIds.length > 0) {
      const scoped = await scopedDeviceTargets(resolvedDeviceIds, schoolId);
      if (scoped.deviceIds.length === 0) {
        return res.status(404).json({ error: "No accessible devices", rejectedDeviceCount: scoped.rejectedDeviceCount });
      }
      rejectedDeviceCount = scoped.rejectedDeviceCount;
      resolvedDeviceIds = scoped.deviceIds;
    }

    const message = { type: "remote-control", _msgId: crypto.randomUUID(), command: { type: "remove-flight-path", data: {} } };

    if (Array.isArray(resolvedDeviceIds) && resolvedDeviceIds.length > 0) {
      for (const deviceId of resolvedDeviceIds) {
        sendToDeviceLocal(schoolId, deviceId, message);
        await setFlightPathStatus(deviceId, { active: false, appliedAt: Date.now() });
      }
      await publishWS({ kind: "students", schoolId, targetDeviceIds: resolvedDeviceIds }, message);
      await recordRemoteActionTimeline({
        schoolId,
        deviceIds: resolvedDeviceIds,
        action: "remove-flight-path",
        actorUserId: req.authUser!.id,
      });
      return res.json({ success: true, sent: resolvedDeviceIds.length, rejectedDeviceCount });
    }
    return res.status(400).json({ error: "No target devices resolved" });
  } catch (err) {
    next(err);
  }
});

// ============================================================================
// Device enrollment secret (admin) — see docs/SECURITY-device-enrollment-secret-spec.md
// ============================================================================

const enrollAdminAuth = [
  authenticate,
  requireSchoolContext,
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
