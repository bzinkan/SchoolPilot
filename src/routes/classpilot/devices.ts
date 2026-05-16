import crypto from "crypto";
import { Router } from "express";
import { eq, and, sql } from "drizzle-orm";
import { productLicenses } from "../../schema/core.js";
import db from "../../db.js";
import { authenticate } from "../../middleware/authenticate.js";
import { requireSchoolContext } from "../../middleware/requireSchoolContext.js";
import { requireActiveSchool } from "../../middleware/requireActiveSchool.js";
import { requireProductLicense } from "../../middleware/requireProductLicense.js";
import { requireDeviceAuth } from "../../middleware/requireDeviceAuth.js";
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
  linkStudentDevice,
  createStudent,
  startStudentSession,
  searchStudents,
  getSchoolByDomain,
  resolveSchoolForStudent,
  getSchoolById,
  getSettingsForSchool,
  getStudentsForDevice,
  getActiveStudentForDevice,
  setActiveStudentForDevice,
  getAdminEmailsBySchool,
  upsertSettings,
  getRecentMessagesForStudent,
  getStudentByEmail,
} from "../../services/storage.js";
import { sendSafetyAlertEmail } from "../../services/email.js";
import { createStudentToken } from "../../services/deviceJwt.js";
import { updateDeviceStatus, updateDeviceClassification } from "../../realtime/student-statuses.js";
import {
  broadcastToTeachersLocal,
  broadcastToStudentsLocal,
  sendToDeviceLocal,
} from "../../realtime/ws-broadcast.js";
import {
  publishWS,
  setScreenshot,
  getScreenshot,
  setFlightPathStatus,
} from "../../realtime/ws-redis.js";
import { classifyUrl, isAiAvailable } from "../../services/aiClassification.js";

const router = Router();

// Cooldown for safety alerts: deviceId:domain → timestamp. Prevents duplicate alerts/emails.
const safetyAlertCooldown = new Map<string, number>();
// Track delivered message IDs per device to avoid re-sending
const deliveredMessages = new Map<string, Set<string>>();
const SAFETY_COOLDOWN_MS = 10 * 60 * 1000; // 10 minutes

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
import rateLimit from "express-rate-limit";
const extensionLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10, // 10 requests per minute per IP for registration
  message: { error: "Too many registration attempts, please wait" },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.ip || req.headers['x-forwarded-for'] as string || 'unknown',
});

const staffAuth = [
  authenticate,
  requireSchoolContext,
  requireActiveSchool,
  requireProductLicense("CLASSPILOT"),
] as const;

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
router.post("/school/status", extensionLimiter, async (req, res, next) => {
  try {
    const { studentEmail, studentToken } = req.body;

    // Token-based lookup (authenticated): return full status
    if (studentToken) {
      try {
        const { verifyStudentToken } = await import("../../services/deviceJwt.js");
        const payload = verifyStudentToken(studentToken);
        const school = await getSchoolById(payload.schoolId);
        if (school) {
          return res.json({
            schoolId: school.id,
            schoolActive: school.status === "active" || school.status === "trial",
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
    const isActive = result.school.status === "active" || result.school.status === "trial";

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

// ============================================================================
// Non-school account detection (Tier 2 personal-email defense)
// ============================================================================
// Cooldown: don't email the school more than once per device per 24h.
const nonSchoolAlertCooldown = new Map<string, number>();
const NON_SCHOOL_ALERT_COOLDOWN_MS = 24 * 60 * 60 * 1000;

// POST /api/classpilot/non-school-account-alert
// Unauthenticated. Called by the extension when it detects a non-school email
// signed into a managed device. The extension may also include a
// chrome.enterprise.deviceAttributes directoryDeviceId — if present, we resolve
// the school via device_enrollment instead of email domain.
router.post("/non-school-account-alert", extensionLimiter, async (req, res, next) => {
  try {
    const { deviceId, directoryDeviceId, accountDomain } = req.body || {};
    if (!deviceId && !directoryDeviceId) {
      return res.status(400).json({ error: "deviceId or directoryDeviceId required" });
    }

    // Resolve school for this device, in order of preference
    let schoolId: string | null = null;

    if (directoryDeviceId) {
      const result = await db.execute(sql`
        SELECT school_id FROM device_enrollment
        WHERE directory_device_id = ${directoryDeviceId}
        LIMIT 1
      `);
      schoolId = (result.rows[0] as any)?.school_id ?? null;

      // Update last-seen on the device enrollment
      if (schoolId) {
        await db.execute(sql`
          UPDATE device_enrollment
          SET last_seen_at = NOW(), last_seen_account_domain = ${accountDomain ?? null}
          WHERE directory_device_id = ${directoryDeviceId}
        `);
      }
    }

    if (!schoolId && deviceId) {
      const device = await getDeviceById(deviceId);
      if (device) schoolId = device.schoolId;
    }

    if (!schoolId) {
      // Device unknown — log to security events for review but don't email anyone
      try {
        await db.execute(sql`
          INSERT INTO security_events (event_type, severity, summary, details, status)
          VALUES (
            'non_school_account_unknown_device',
            'low',
            'Non-school account detected on unrecognized device',
            ${JSON.stringify({ deviceId, directoryDeviceId, accountDomain })}::jsonb,
            'open'
          )
        `);
      } catch { /* non-blocking */ }
      return res.json({ ok: true, recognized: false });
    }

    // Cooldown check
    const cooldownKey = `${schoolId}:${deviceId || directoryDeviceId}`;
    const now = Date.now();
    const last = nonSchoolAlertCooldown.get(cooldownKey) || 0;
    if (now - last < NON_SCHOOL_ALERT_COOLDOWN_MS) {
      return res.json({ ok: true, recognized: true, alertSuppressed: true });
    }
    nonSchoolAlertCooldown.set(cooldownKey, now);

    // Persist a security event for the admin to review
    try {
      await db.execute(sql`
        INSERT INTO security_events (event_type, severity, school_id, summary, details, status)
        VALUES (
          'non_school_account_on_managed_device',
          'medium',
          ${schoolId},
          ${`Non-school account (${accountDomain || 'unknown'}) on device ${deviceId || directoryDeviceId}`},
          ${JSON.stringify({ deviceId, directoryDeviceId, accountDomain })}::jsonb,
          'open'
        )
      `);
    } catch { /* non-blocking */ }

    // Notify school admins
    try {
      const adminEmails = await getAdminEmailsBySchool(schoolId);
      if (adminEmails.length > 0) {
        const { sendEmail } = await import("../../services/email.js");
        await sendEmail({
          to: adminEmails.join(","),
          subject: "ClassPilot: Non-school account detected on a managed device",
          html: `<h3>Non-school account detected</h3>
            <p>A student signed into a school Chromebook with a non-school Google account.</p>
            <p><strong>Account domain:</strong> ${accountDomain || "unknown"}</p>
            <p><strong>Device ID:</strong> ${deviceId || "(none)"}</p>
            <p><strong>Directory Device ID:</strong> ${directoryDeviceId || "(none — extension reports device not enrolled in Google Admin Console)"}</p>
            <p><strong>What this means:</strong> The Chromebook is not being monitored while this account is signed in. The student may be browsing without ClassPilot oversight.</p>
            <p><strong>Recommended action:</strong> Verify Google Workspace Admin policies are restricting sign-in to school accounts only (Devices → Chrome → Settings → User & browser → Sign-in restriction). See your security setup guide for details.</p>
            <p><em>Alert cooldown: you will not receive another email about this device for 24 hours.</em></p>`,
        });
      }
    } catch (err) {
      console.error("[non-school-account] admin email failed:", err);
    }

    return res.json({ ok: true, recognized: true });
  } catch (err) {
    next(err);
  }
});

// POST /api/classpilot/device-enrollment-register
// Called by the extension on managed Chromebooks to register the device's
// chrome.enterprise.deviceAttributes directoryDeviceId with its school.
// Requires an active student token to establish school context (Tier 3).
router.post("/device-enrollment-register", requireDeviceAuth, async (req, res, next) => {
  try {
    const { directoryDeviceId, accountDomain } = req.body || {};
    if (!directoryDeviceId || typeof directoryDeviceId !== "string") {
      return res.status(400).json({ error: "directoryDeviceId required" });
    }
    const schoolId = res.locals.schoolId as string;
    await db.execute(sql`
      INSERT INTO device_enrollment (directory_device_id, school_id, last_seen_account_domain)
      VALUES (${directoryDeviceId}, ${schoolId}, ${accountDomain ?? null})
      ON CONFLICT (directory_device_id) DO UPDATE SET
        last_seen_at = NOW(),
        last_seen_account_domain = EXCLUDED.last_seen_account_domain
    `);
    return res.json({ ok: true });
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
    const schoolSettings = await getSettingsForSchool(schoolId);
    const school = await getSchoolById(schoolId);
    if (!school) {
      return res.status(404).json({ error: "School not found" });
    }

    return res.json({
      enableTrackingHours: schoolSettings?.enableTrackingHours ?? false,
      trackingStartTime: schoolSettings?.trackingStartTime ?? null,
      trackingEndTime: schoolSettings?.trackingEndTime ?? null,
      trackingDays: schoolSettings?.trackingDays ?? null,
      schoolTimezone: schoolSettings?.schoolTimezone || school.schoolTimezone || null,
      afterHoursMode: schoolSettings?.afterHoursMode ?? "off",
      maxTabsPerStudent: schoolSettings?.maxTabsPerStudent
        ? parseInt(schoolSettings.maxTabsPerStudent, 10)
        : null,
      // Tier 2 personal-email defense (defense-in-depth on top of Chrome OS policy).
      // When true, the extension shows a lockdown overlay on non-school accounts
      // and sends an alert to school admins.
      enforcePersonalEmailBlock: schoolSettings?.enforcePersonalEmailBlock ?? true,
      // The school's domain — extension uses this to decide if the signed-in
      // Google account is a school account or a personal one.
      schoolDomain: school.domain ?? null,
    });
  } catch (err) {
    next(err);
  }
});

// ============================================================================
// Device & Student Registration
// ============================================================================

// POST /api/classpilot/register - Generic device registration (no student) (legacy)
// Kept for backwards compatibility with older extension builds. New extensions use
// /extension/register exclusively. Rate-limited to prevent abuse.
router.post("/register", extensionLimiter, async (req, res, next) => {
  try {
    const { deviceId, deviceName, classId, schoolId: explicitSchoolId } = req.body;
    if (!deviceId) {
      return res.status(400).json({ error: "deviceId required" });
    }

    let resolvedSchoolId = explicitSchoolId;
    if (!resolvedSchoolId) {
      return res.status(400).json({ error: "schoolId required" });
    }

    const school = await getSchoolById(resolvedSchoolId);
    if (!school || (school.status !== "active" && school.status !== "trial")) {
      return res.status(403).json({ error: "School is not active" });
    }

    let device = await getDeviceById(deviceId);
    if (!device) {
      device = await createDevice({
        deviceId,
        deviceName: deviceName || null,
        schoolId: resolvedSchoolId,
        classId: classId || resolvedSchoolId,
      });
    }

    return res.json({ data: device });
  } catch (err) {
    next(err);
  }
});

// POST /api/classpilot/extension/register - Register a device from the Chrome extension
// Supports both email-based (ClassPilot extension) and schoolId-based registration
router.post("/extension/register", extensionLimiter, async (req, res, next) => {
  try {
    const { deviceId, deviceName, studentEmail, studentName, schoolId: explicitSchoolId, classId } = req.body;
    if (!deviceId) {
      return res.status(400).json({ error: "deviceId required" });
    }

    // Resolve school: either explicit schoolId or from email domain
    let resolvedSchoolId = explicitSchoolId;
    let school;

    if (!resolvedSchoolId && studentEmail) {
      const result = await resolveSchoolForStudent(studentEmail);
      if (result) {
        school = result.school;
        resolvedSchoolId = school.id;
      }
    }

    if (resolvedSchoolId && !school) {
      school = await getSchoolById(resolvedSchoolId);
    }

    if (!resolvedSchoolId || !school) {
      return res.status(401).json({ error: "No school found for this email domain" });
    }

    // Check school is active
    if (school.status !== "active" && school.status !== "trial") {
      return res.status(403).json({ error: "School is not active" });
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
      // Exact email match first (precise), then fall back to fuzzy search
      let student = await getStudentByEmail(resolvedSchoolId, studentEmail.toLowerCase());
      if (!student) {
        const existing = await searchStudents(resolvedSchoolId, { search: studentEmail });
        student = existing[0];
      }

      if (!student) {
        // Anti-spam: cap auto-creations per school per hour
        if (!recordAutoCreation(resolvedSchoolId)) {
          console.warn(`[Security] Auto-creation rate limit hit for school ${resolvedSchoolId}; rejecting ${studentEmail}`);
          return res.status(429).json({
            error: "Auto-enrollment temporarily disabled — please ask your administrator to import students first.",
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

      // Link student to device
      await linkStudentDevice({ studentId: student.id, deviceId });

      // Start session
      await startStudentSession(student.id, deviceId);

      // Generate device JWT
      const studentToken = createStudentToken({
        studentId: student.id,
        deviceId,
        schoolId: resolvedSchoolId,
        studentEmail,
      });

      // Broadcast to teachers
      broadcastToTeachersLocal(resolvedSchoolId, {
        type: "student-registered",
        studentId: student.id,
        deviceId,
        studentEmail,
        studentName: studentName || student.firstName,
      });
      await publishWS({ kind: "staff", schoolId: resolvedSchoolId }, {
        type: "student-registered",
        studentId: student.id,
        deviceId,
      });

      return res.json({
        success: true,
        device,
        student,
        studentToken,
      });
    }

    return res.json({ device });
  } catch (err) {
    next(err);
  }
});

// POST /api/classpilot/register-student - Register student and get device token (legacy)
// Kept for backwards compatibility. New extensions use /extension/register.
router.post("/register-student", extensionLimiter, async (req, res, next) => {
  try {
    const { deviceId, studentEmail, gradeLevel, firstName, lastName, schoolId } = req.body;
    if (!deviceId || !studentEmail || !schoolId) {
      return res.status(400).json({ error: "deviceId, studentEmail, and schoolId required" });
    }

    // Find or create student
    const existing = await searchStudents(schoolId, { search: studentEmail });
    let student = existing[0];

    if (!student) {
      // Anti-spam: cap auto-creations per school per hour
      if (!recordAutoCreation(schoolId)) {
        console.warn(`[Security] Auto-creation rate limit hit on /register-student for school ${schoolId}`);
        return res.status(429).json({
          error: "Auto-enrollment temporarily disabled — please ask your administrator to import students first.",
        });
      }
      student = await createStudent({
        schoolId,
        firstName: firstName || studentEmail.split("@")[0],
        lastName: lastName || "",
        email: studentEmail,
        emailLc: studentEmail.toLowerCase(),
        gradeLevel: gradeLevel || null,
        status: "active",
      });
    }

    // Link student to device
    await linkStudentDevice({ studentId: student.id, deviceId });

    // Start session
    await startStudentSession(student.id, deviceId);

    // Generate device JWT
    const studentToken = createStudentToken({
      studentId: student.id,
      deviceId,
      schoolId,
      studentEmail,
    });

    return res.json({ studentToken, student });
  } catch (err) {
    next(err);
  }
});

// ============================================================================
// Popup Endpoints (items #5, #6)
// ============================================================================

// GET /api/classpilot/device/:deviceId/students - List students on a device
router.get("/device/:deviceId/students", async (req, res, next) => {
  try {
    const deviceId = param(req, "deviceId");
    const students = await getStudentsForDevice(deviceId);
    const active = await getActiveStudentForDevice(deviceId);
    return res.json({
      students,
      activeStudentId: active?.student.id || null,
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/classpilot/device/:deviceId/active-student - Set active student on device
router.post("/device/:deviceId/active-student", async (req, res, next) => {
  try {
    const deviceId = param(req, "deviceId");
    const { studentId } = req.body;
    if (!studentId) {
      return res.status(400).json({ error: "studentId required" });
    }

    const student = await getStudentById(studentId);
    if (!student) {
      return res.status(404).json({ error: "Student not found" });
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
    } = req.body;
    const schoolId = res.locals.schoolId as string;
    const studentId = res.locals.studentId as string;
    const deviceId = res.locals.deviceId as string;
    const studentEmail = res.locals.studentEmail as string;

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
    if (!school || (school.status !== "active" && school.status !== "trial")) {
      return res.status(402).json({ planStatus: "inactive" });
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
    });

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
    if (isAiAvailable() && activeTabUrl && !activeTabUrl.startsWith("chrome")) {
      classifyUrl(activeTabUrl, activeTabTitle).then((classification) => {
        if (!classification) return;

        // Store classification in realtime status so students-aggregated includes it
        updateDeviceClassification(schoolId, deviceId, {
          category: classification.category,
          safetyAlert: classification.safetyAlert,
        });

        // Persist classification to the heartbeat record
        updateHeartbeatClassification(heartbeat.id, classification.category, classification.safetyAlert).catch(() => {});

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
            getAdminEmailsBySchool(schoolId).then((adminEmails) => {
              if (adminEmails.length > 0) {
                void sendSafetyAlertEmail({
                  recipients: adminEmails,
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
router.post("/device/screenshot", requireDeviceAuth, async (req, res, next) => {
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
    if (!school || (school.status !== "active" && school.status !== "trial")) {
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
    await deleteDevice(param(req, "deviceId"));
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
    const limit = parseInt(req.query.limit as string) || 50;
    const startTime = req.query.startTime as string | undefined;
    const endTime = req.query.endTime as string | undefined;

    let heartbeats;
    if (startTime) {
      // Filter by time range (for session-scoped views)
      const start = new Date(startTime);
      const end = endTime ? new Date(endTime) : new Date();
      heartbeats = await getHeartbeatsByDeviceInRange(param(req, "deviceId"), start, end);
    } else {
      heartbeats = await getHeartbeatsByDevice(param(req, "deviceId"), limit);
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
        return res.json({ success: true, sent: resolvedDeviceIds.length });
      } else {
        // Broadcast to all connected students
        const sentCount = broadcastToStudentsLocal(schoolId, message);
        await publishWS({ kind: "students", schoolId }, message);
        return res.json({ success: true, sent: sentCount });
      }
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
    const resolvedDeviceIds: string[] | undefined = deviceIds || targetDeviceIds || undefined;

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
      return res.json({ success: true, sent: resolvedDeviceIds.length });
    } else {
      // Broadcast to all connected students
      const sentCount = broadcastToStudentsLocal(schoolId, message);
      await publishWS({ kind: "students", schoolId }, message);
      return res.json({ success: true, sent: sentCount, message: `Applied flight path to all connected devices` });
    }
  } catch (err) {
    next(err);
  }
});

// POST /api/classpilot/remote/remove-flight-path - Remove flight path
router.post("/remote/remove-flight-path", ...staffAuth, async (req, res, next) => {
  try {
    const schoolId = res.locals.schoolId!;
    const { deviceIds, targetDeviceIds } = req.body;
    const resolvedDeviceIds: string[] | undefined = deviceIds || targetDeviceIds || undefined;

    const message = { type: "remote-control", _msgId: crypto.randomUUID(), command: { type: "remove-flight-path", data: {} } };

    if (Array.isArray(resolvedDeviceIds) && resolvedDeviceIds.length > 0) {
      for (const deviceId of resolvedDeviceIds) {
        sendToDeviceLocal(schoolId, deviceId, message);
        await setFlightPathStatus(deviceId, { active: false, appliedAt: Date.now() });
      }
      await publishWS({ kind: "students", schoolId, targetDeviceIds: resolvedDeviceIds }, message);
      return res.json({ success: true, sent: resolvedDeviceIds.length });
    } else {
      const sentCount = broadcastToStudentsLocal(schoolId, message);
      await publishWS({ kind: "students", schoolId }, message);
      return res.json({ success: true, sent: sentCount });
    }
  } catch (err) {
    next(err);
  }
});

export default router;
